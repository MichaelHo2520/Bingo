"use strict";

/* ============================================================================
   台灣 16 張麻將 — 一局的狀態機(MJT)。★ 純函式,零 DOM、零 Firebase。
   相依:同目錄的 rules.js(MJ16)。

   ── 為什麼輪次引擎要獨立成一支純函式 ──────────────────────────────────────
     「摸打吃碰槓胡」的順序與優先權是整個遊戲最容易出錯的地方,而它**在瀏覽器裡
     只能靠四台裝置手動玩來找 bug**。抽成純函式之後,node 可以跑幾千局隨機對局,
     每一步都檢查不變量(牌張守恆、手牌張數、輪次合法)。
     規矩同 js/gomoku/ai.js 與 js/mahjong/gen.js。

   ── state 是「一整局的完整真相」 ──────────────────────────────────────────
     adapter 把它整包寫進 Firebase 的 game 節點(手牌與牌山都是明碼 —— 親友聚會、
     刻意不防作弊,理由見 notes/plan/PLAN-台灣麻將16張.md 第二節)。
     好處是**斷線復原模型原封不動沿用**:任何人重連都能從 game 重建整局。

   ── ★ 每一支「動作」都回傳新 state 或 null ────────────────────────────────
     null = 這個動作不合法。呼叫端(adapter)一律用交易把 state 寫回去,
     交易內再驗一次 —— 兩個人同時動作時,晚到的那個會看到已經變過的 state 而失敗。
   ========================================================================== */

const MJT = (function(){

  const R = (typeof MJ16 !== "undefined") ? MJ16 : require("./rules.js");

  const WINDS = [27,28,29,30];              // 東 南 西 北 = 各座位的門風

  /* 座位的門風:莊家是東,逆著座位順序往下排(下家是南) */
  function seatWind(seat, dealer, seats){
    return WINDS[((seat - dealer) % seats + seats) % seats];
  }
  function leftOf(seat, seats){ return (seat - 1 + seats) % seats; }   // 上家
  function nextOf(seat, seats){ return (seat + 1) % seats; }           // 下家

  function sortHand(h){ return h.slice().sort((a,b)=>a-b); }
  function removeOne(arr, t){
    const i = arr.indexOf(t);
    if(i<0) return null;
    const a = arr.slice(); a.splice(i,1); return a;
  }
  /* 手上還要湊幾組(攤出去的每一組都少一組要湊;槓也只算一組) */
  function needOf(st, seat){ return R.RULESETS[st.rs].melds - st.melds[seat].length; }

  /* ★ 「這家現在是不是該打一張牌」——**唯一的判準是持牌數**,不是 drawn 有沒有值。
     這裡踩過一個會直接死鎖的坑:**吃 / 碰之後 drawn 是 -1,但手上多了一張要打**
     (吃走 2 張、進來 1 組 → 手牌比基準多 1)。原本寫成「drawn<0 就不能打」,
     一吃牌整局就卡住,而且四台裝置手動玩才會遇到 —— 正是純函式 + node 隨機對局要抓的東西。
     基準:手牌 + (摸到的算 1) 應該等於「該有的張數 − 3×攤出的組數 + 1」。 */
  function holding(st, seat){ return st.hands[seat].length + (st.drawn>=0 ? 1 : 0); }
  function toPlay(st, seat){
    const rs = R.RULESETS[st.rs];
    return holding(st, seat) === rs.hand - 3*st.melds[seat].length + 1;
  }
  /* 這家「手上全部的牌」(含剛摸到那張) */
  function allTiles(st, seat){
    return st.drawn>=0 ? st.hands[seat].concat([st.drawn]) : st.hands[seat].slice();
  }

  /* ==========================================================================
     開局
     ========================================================================== */
  function newRound(o){
    const rs = R.RULESETS[o.rs] || R.RULESETS.p4;
    const seats = rs.seats;
    const wall = o.wall ? o.wall.slice() : R.buildWall(rs, o.rng);
    const st = {
      rs: o.rs || "p4",
      seats: seats,
      wall: wall,
      pos: 0,
      hands: [], melds: [], flowers: [],
      discards: [],
      turn: (typeof o.dealer==="number") ? o.dealer : 0,
      drawn: -1,
      dealer: (typeof o.dealer==="number") ? o.dealer : 0,
      roundWind: (typeof o.roundWind==="number") ? o.roundWind : 27,
      handNo: o.handNo || 1,
      dealerStreak: o.dealerStreak || 0,
      /* 底幾台(v1.75.15,使用者:「底幾台要能被設定,預設為 2 台」)。
         ★ 這一層**不給預設值**,沿用 settleWin 的 fallback 1 —— 預設值是「一場的設定」,
           歸 solo.js / adapter.js 的 BASE_DEF 管(同 handsGoal / claimSec 的分工)。
           在這裡塞 2 會讓 node 那幾支純函式測試的台數整組位移,而它們驗的是規則不是設定。
         ⚠ 一定要進 enc/dec:底台是**開局就定的**,少了它別台裝置與重連的那台會用 1 台
           算收付 —— 而收付相加仍然是 0,零和斷言抓不到,只有「他算出來跟我不一樣」。 */
      base: (typeof o.base === "number" && o.base > 0) ? (o.base | 0) : 1,
      claim: null,
      over: null,
      firstGo: true,          // 還在第一巡(天 / 地 / 人胡)
      kongDraw: false,        // 這一摸是槓上補的
      robbable: null,         // 正在加槓、可被搶槓的那張
      /* ★ 牌河最後那張是不是**剛被拿走**(吃 / 碰 / 明槓 / 食胡)(v1.73.2)。
         為什麼要記:被拿走時那張會從 discards 裡 pop 掉,盤面的「最新那張」
         (放大 + 紅框)就自動退回到**上一張** —— 而上一張早就過了宣告視窗,
         看起來卻像現在可以吃 / 碰的那張。使用者回報:「很容易會以為又可以再碰或吃」。
         ⚠ 這件事**推不出來**:吃 / 碰之後的狀態(turn=宣告者、drawn=-1)要和暗槓、
           搶槓退回那幾條路徑分辨開來,得跨四支函式反推;照 robbable / kongDraw /
           over.rob 的同一條慣例留明確記號(不留記號就再也問不到)。
         打出下一張時由 discard() 歸回 false。 */
      taken: false,
      /* ★ 宣告聽牌(v1.67.0):ting[seat] = null | "normal" | "di" | "tian"。
         **公開資訊** —— 宣告是喊出來的動作,全桌都該看得到(與「誰在考慮吃碰」相反)。
         宣告之後那一家只能摸切,而且不能吃 / 碰(見 discard 與 eligibleFor)。 */
      ting: new Array(seats).fill(null)
    };
    for(let s=0;s<seats;s++){ st.hands.push([]); st.melds.push([]); st.flowers.push([]); }

    // 發牌:每家 16 張,摸到花就攤出來再補一張(補花)
    for(let s=0;s<seats;s++){
      while(st.hands[s].length < rs.hand){
        if(st.pos>=wall.length) return null;             // 牌不夠 —— 佈局設定有問題
        const t = wall[st.pos++];
        if(R.isFlower(t)) st.flowers[s].push(t);
        else st.hands[s].push(t);
      }
      st.hands[s] = sortHand(st.hands[s]);
    }
    return autoDraw(st);                                  // 莊家先摸一張
  }

  /* ==========================================================================
     摸牌(含補花)—— 一律由這支進入「某家該打牌」的狀態
     ========================================================================== */
  function autoDraw(st){
    const rs = R.RULESETS[st.rs];
    if(st.over) return st;
    const s = { ...st, hands:st.hands.map(h=>h.slice()), flowers:st.flowers.map(f=>f.slice()) };
    while(true){
      if(R.isExhausted(s.wall, s.pos, rs)){ s.over = { type:"draw" }; s.drawn=-1; return s; }
      const t = s.wall[s.pos++];
      if(R.isFlower(t)){ s.flowers[s.turn].push(t); continue; }   // 補花:再摸一張
      s.drawn = t;
      return s;
    }
  }

  /* ==========================================================================
     打牌
     ========================================================================== */
  function discard(st, seat, tile){
    if(st.over || st.claim) return null;
    if(st.turn!==seat) return null;
    if(!toPlay(st, seat)) return null;                 // 不是該打牌的狀態(見 toPlay 的註解)
    /* ★ 宣告聽牌之後**只能摸切**(v1.67.0):摸什麼打什麼,不可以動手牌 ——
       那就是「宣告」換來一台的代價(明星三缺一的規則:只有補花 / 槓 / 自摸能把牌留著)。
       ⚠ 這一條也是 declareTing() 能重用 discard() 的原因:宣告的那一刻 ting 還是 null,
         寫入 ting 是在 discard 回來之後。 */
    if(tingOf(st, seat) && !(st.drawn>=0 && st.drawn===tile)) return null;
    const s = { ...st, hands:st.hands.map(h=>h.slice()), discards:st.discards.slice() };

    /* 打的可以是剛摸進來那張,也可以是手裡原有的(打手裡的 → 摸進來那張補進手牌)。
       吃 / 碰之後 drawn 是 -1,這時直接從手牌拿掉一張就好。 */
    if(s.drawn>=0 && s.drawn===tile){
      s.drawn = -1;
    }else{
      const h = removeOne(s.hands[seat], tile);
      if(!h) return null;
      if(s.drawn>=0){ h.push(s.drawn); s.drawn=-1; }
      s.hands[seat] = sortHand(h);
    }
    s.discards.push({ seat:seat, t:tile });
    s.kongDraw = false;
    s.robbable = null;
    s.taken = false;                                   // 牌河又有「最新那張」了(見 newRound 的 taken)

    // 誰有資格宣告?**每台裝置都算得出同一個答案**(手牌明碼),所以不需要房主裁決
    const elig = eligibleFor(s, seat, tile);
    if(Object.keys(elig).length){
      s.claim = { t:tile, from:seat, elig:elig, bids:{} };
      return s;
    }
    return passTurn(s, seat);
  }

  /* 打出 tile 之後,其他家各自有資格宣告什麼 */
  function eligibleFor(st, from, tile){
    const rs = R.RULESETS[st.rs];
    const out = {};
    for(let s=0;s<st.seats;s++){
      if(s===from) continue;
      const c = R.toCounts(st.hands[s]);
      const cl = R.claimsFor(c, tile, {
        need: needOf(st, s),
        chow: rs.chow,
        fromLeft: leftOf(s, st.seats)===from
      });
      const types = [];
      if(cl.win)  types.push("win");
      /* ★ 宣告聽牌之後不能吃 / 碰(那會動到手牌),但**槓與胡照給** ——
         明星三缺一的規則:「只有補花、槓牌(明、暗都可以)或者自摸可以把牌留著」。
         ⚠ 槓完聽的牌有可能變,那是規則允許的(不另外檢查「槓完聽牌形有沒有變」——
           那是日麻立直的講究,這副牌沒有振聽也沒有那套判定)。 */
      if(cl.kong) types.push("kong");
      if(!tingOf(st, s)){
        if(cl.pong) types.push("pong");
        if(cl.chow.length) types.push("chow");
      }
      if(types.length) out[s] = types;
    }
    return out;
  }

  /* 沒有人要宣告 → 下一家摸牌 */
  function passTurn(st, from){
    const s = { ...st };
    s.turn = nextOf(from, st.seats);
    s.claim = null;
    if(s.turn===s.dealer) s.firstGo = false;      // 轉回莊家 = 第一巡結束
    return autoDraw(s);
  }

  /* ==========================================================================
     宣告:先投標,再由「任何一台」結算(交易搶)
     ★ 不指定房主 —— 房主一斷線就整局卡死(同消消樂全房重洗的理由)。
     ========================================================================== */
  function bid(st, seat, type, tiles){
    if(!st.claim || st.over) return null;
    const allow = st.claim.elig[seat];
    if(type!=="pass" && (!allow || allow.indexOf(type)<0)) return null;
    if(st.claim.bids[seat]) return null;                    // 一人只表態一次
    const s = { ...st, claim:{ ...st.claim, bids:{ ...st.claim.bids } } };
    s.claim.bids[seat] = { type:type, tiles:tiles||null };
    return s;
  }
  /* 全部有資格的人都表態了嗎(視窗可以提早結束) */
  function allBidsIn(st){
    if(!st.claim) return false;
    return Object.keys(st.claim.elig).every(s=>!!st.claim.bids[s]);
  }
  /* 結算宣告視窗。優先權:胡 > 槓 > 碰 > 吃;同級由下家起算(離出牌者近的先) */
  const PRI = { win:4, kong:3, pong:2, chow:1 };
  function resolveClaim(st){
    if(!st.claim || st.over) return null;
    const cl = st.claim;
    let best = null;
    Object.keys(cl.bids).forEach(k=>{
      const seat = +k, b = cl.bids[k];
      if(b.type==="pass") return;
      const p = PRI[b.type] || 0;
      // 同級比「離出牌者多近」(下家最近)
      const dist = ((seat - cl.from) % st.seats + st.seats) % st.seats;
      if(!best || p>best.p || (p===best.p && dist<best.dist)) best = { seat, b, p, dist };
    });
    if(!best){
      /* ★ 搶槓視窗沒人胡 → 那個槓成立,**槓的人補一張繼續打**,不是輪到下一家。
         寫成 passTurn 的話,加槓完會被憑空跳過一輪(規則錯,但畫面上很難看出來)。 */
      if(cl.rob){
        const k = autoDraw({ ...st, claim:null, robbable:null, turn:cl.from });
        k.kongDraw = true; return k;
      }
      return passTurn({ ...st, claim:null }, cl.from);
    }

    if(best.b.type==="win") return settleWin(st, best.seat, { from:cl.from, tile:cl.t, rob:!!cl.rob });
    return takeMeld(st, best.seat, best.b.type, cl.t, cl.from, best.b.tiles);
  }

  /* 吃 / 碰 / 明槓:把牌收進明牌區,輪次跳到宣告者 */
  function takeMeld(st, seat, type, tile, from, tiles){
    const s = { ...st, hands:st.hands.map(h=>h.slice()), melds:st.melds.map(m=>m.slice()),
                discards:st.discards.slice() };
    /* 牌河最後那張被拿走了。★ 一定要同時掛 taken —— pop 之後 discards 的最後一張
       變成**上一張**,盤面若照舊把它畫成「最新那張」(放大 + 紅框)就等於在說
       「這張現在可以吃 / 碰」(見 newRound 的 taken)。 */
    if(s.discards.length && s.discards[s.discards.length-1].t===tile){ s.discards.pop(); s.taken = true; }

    let h = s.hands[seat];
    let need;
    if(type==="chow"){
      if(!tiles || tiles.length!==2) return null;
      need = tiles;
    }else{
      need = (type==="kong") ? [tile,tile,tile] : [tile,tile];
    }
    for(const t of need){ h = removeOne(h, t); if(!h) return null; }
    s.hands[seat] = sortHand(h);
    s.melds[seat] = s.melds[seat].concat([{
      k: type==="chow" ? "chow" : (type==="kong" ? "kong" : "pung"),
      // 吃的那組要記「最小的那張」當 t,才對得上 rules/scoring 的順子表示法
      t: type==="chow" ? Math.min(tile, tiles[0], tiles[1]) : tile,
      /* g = 跟人要來的**那一張**。碰 / 槓 時 g 就等於 t(三張同款,記了也無妨),
         吃的時候才有資訊量 —— 盤面要把它排在中間當「這組是吃來的」的記號
         (v1.58.2 改掉原本把它橫放的畫法:小尺寸下橫放的牌面糊成一塊,看起來像壞掉)。 */
      g: tile,
      c: false, from: from
    }]);
    s.claim = null;
    s.turn = seat;
    s.firstGo = false;
    s.kongDraw = false;

    if(type==="kong"){ const k = autoDraw(s); k.kongDraw = true; return k; }   // 槓完補一張
    s.drawn = -1;                                    // 吃碰之後直接打一張(不摸牌)
    return s;
  }

  /* ==========================================================================
     宣告聽牌(v1.67.0)—— 規則照明星三缺一
     ──────────────────────────────────────────────────────────────────────────
     使用者:「聽牌不是主動告知的,是可以讓我選擇要不要按聽牌,如果按了聽牌,就不能在
     換牌了,然後在結算時,會多台數」。

     ★ 一個動作做兩件事:**宣告 + 打出那一張**。分成兩步(先宣告、再打)會產生一個
       「已宣告但還沒打牌」的中間狀態,而那個狀態下所有規則都要多一組判斷
       (能不能改主意?這時被人碰走怎麼算?)—— 併成一步就沒有這個狀態。
     ★ 打出去那一張**必須真的讓我聽牌**,否則不合法:按了鎖死手牌卻胡不了,
       那是 bug 不是玩法。手牌明碼 → 每台裝置都驗得出來,不必指定房主。
     ★ 不要求門清(碰過照樣可以宣告)—— 查明星三缺一的規則就是這樣,只是拿不到天 / 地聽。
     ========================================================================== */
  /* 這一家宣告了什麼(舊 state 沒有 ting 欄位時一律當成沒宣告) */
  function tingOf(st, seat){
    return (st.ting && st.ting[seat]) ? st.ting[seat] : null;
  }
  /* 「打掉哪些牌之後我會聽牌」= 宣告時可以打的那些。回傳牌種(去重、升冪)。
     空陣列 = 現在不能宣告。 */
  function tingTiles(st, seat){
    if(st.over || st.claim || st.turn!==seat || !toPlay(st, seat)) return [];
    if(tingOf(st, seat)) return [];                      // 已經宣告過,不能再宣告
    const seen = {}, out = [];
    allTiles(st, seat).forEach(t=>{
      if(seen[t]) return;
      seen[t] = 1;
      if(tenpaiAfter(st, seat, t).length) out.push(t);
    });
    return out.sort((a,b)=>a-b);
  }
  function canDeclareTing(st, seat){ return tingTiles(st, seat).length>0; }

  /* 天聽 / 地聽 / 一般。★ 兩個特殊台的共同前提是**全桌還沒有人吃碰槓**
     (明星三缺一:「無發生吃、碰、槓的情況下宣告聽牌」)。
       天聽 = 莊家取完牌後的**第一打**(牌河還是空的)
       地聽 = 閒家在**前 8 張打出之內**宣告
     ⚠ 門檻用「牌河張數」而不是 firstGo:firstGo 是一巡(4 家各一張),
       而查到的規則寫的是 8 張 —— 照規則走,不要自己收緊。 */
  const DI_TING_MAX = 8;
  function tingTypeOf(st, seat){
    const anyMeld = st.melds.some(m=>m.length>0);
    if(anyMeld) return "normal";
    if(seat===st.dealer && st.discards.length===0) return "tian";
    return st.discards.length < DI_TING_MAX ? "di" : "normal";
  }

  /* 宣告聽牌並打出 tile。回傳新 state 或 null(不合法)。 */
  function declareTing(st, seat, tile){
    if(!canDeclareTing(st, seat)) return null;
    if(!tenpaiAfter(st, seat, tile).length) return null;  // 打了它並不會聽牌
    const type = tingTypeOf(st, seat);
    const s = discard(st, seat, tile);                    // 這時 ting 還是 null → 不受摸切限制
    if(!s) return null;
    s.ting = (st.ting || new Array(st.seats).fill(null)).slice();
    s.ting[seat] = type;
    return s;
  }

  /* ==========================================================================
     自己回合的動作:暗槓 / 加槓 / 自摸
     ========================================================================== */
  /* 暗槓:手上自己就有 4 張。⚠ 條件用 toPlay() 不是 drawn>=0 —— 吃 / 碰之後手上
     也可能剛好有四張同款,那時 drawn 是 -1 但仍然輪到你動作。 */
  function concealedKong(st, seat, tile){
    if(st.over || st.claim || st.turn!==seat || !toPlay(st,seat)) return null;
    const all = allTiles(st, seat);
    if(all.filter(t=>t===tile).length !== 4) return null;
    const s = { ...st, hands:st.hands.map(h=>h.slice()), melds:st.melds.map(m=>m.slice()) };
    s.hands[seat] = sortHand(all.filter(t=>t!==tile));
    s.melds[seat] = s.melds[seat].concat([{ k:"kong", t:tile, c:true, from:seat }]);
    s.drawn = -1; s.firstGo = false;
    const k = autoDraw(s); k.kongDraw = true; return k;
  }
  /* 加槓:已經碰出去的那組又摸到第 4 張。★ 這一步可以被別人搶槓 —— 先掛 robbable */
  function addKong(st, seat, tile){
    if(st.over || st.claim || st.turn!==seat || !toPlay(st,seat)) return null;
    const mi = st.melds[seat].findIndex(m=>m.k==="pung" && m.t===tile);
    if(mi<0) return null;
    const all = allTiles(st, seat);
    if(all.indexOf(tile)<0) return null;

    const s = { ...st, hands:st.hands.map(h=>h.slice()), melds:st.melds.map(m=>m.slice()) };
    s.hands[seat] = sortHand(removeOne(all, tile));
    s.melds[seat] = s.melds[seat].slice();
    s.melds[seat][mi] = { ...s.melds[seat][mi], k:"kong" };
    s.drawn = -1; s.firstGo = false;

    // 搶槓:別人剛好胡這張 → 開一個只收「胡」的宣告視窗
    const elig = {};
    for(let o=0;o<s.seats;o++){
      if(o===seat) continue;
      const c = R.toCounts(s.hands[o]);
      if(R.claimsFor(c, tile, { need:needOf(s,o), chow:false, fromLeft:false }).win) elig[o]=["win"];
    }
    if(Object.keys(elig).length){
      s.claim = { t:tile, from:seat, elig:elig, bids:{}, rob:true };
      s.robbable = tile;
      return s;
    }
    const k = autoDraw(s); k.kongDraw = true; return k;
  }
  function selfDrawWin(st, seat){
    if(st.over || st.claim || st.turn!==seat || st.drawn<0) return null;
    const c = R.toCounts(st.hands[seat].concat([st.drawn]));
    if(!R.canWin(c, needOf(st,seat))) return null;
    return settleWin(st, seat, { from:null, tile:st.drawn });
  }

  /* ==========================================================================
     結算:算台 + 收付表
     ========================================================================== */
  function settleWin(st, seat, o){
    const S = (typeof MJ16S !== "undefined") ? MJ16S : require("./scoring.js");
    const rs = R.RULESETS[st.rs];
    const selfDraw = (o.from===null);
    const conc = selfDraw ? st.hands[seat].concat([st.drawn]) : st.hands[seat].concat([o.tile]);

    const res = S.score({
      concealed: conc,
      melds: st.melds[seat].map(m=>({ kind:m.k, t:m.t, concealed:!!m.c })),
      winTile: o.tile,
      selfDraw: selfDraw,
      seatWind: seatWind(seat, st.dealer, st.seats),
      roundWind: st.roundWind,
      isDealer: seat===st.dealer,
      dealerStreak: st.dealerStreak,
      flowers: st.flowers[seat],
      kongDraw: !!st.kongDraw,
      // 海底 / 河底:這一張之後牌山就到底了
      lastTile: R.isExhausted(st.wall, st.pos, rs),
      robKong: !!(st.claim && st.claim.rob),
      firstTurn: !!st.firstGo,
      ting: tingOf(st, seat),                 // 宣告聽牌:"normal" / "di" / "tian"(v1.67.0)
      base: (typeof st.base==="number") ? st.base : 1
    });
    if(!res.ok) return null;

    const deltas = S.settle({
      seats: st.seats, winnerSeat: seat,
      loserSeat: selfDraw ? null : o.from,
      total: res.total
    });

    /* ★ 胡牌的那張要**真的收進贏家手裡**,不能只把 drawn 設成 -1 就算了。
       ⚠ 這裡踩過一個 node 隨機對局才抓得到的坑:原本寫 `drawn:-1`,自摸的那張牌
          就這樣憑空消失 —— 畫面上看不出來(結果卡已經蓋住盤面了),但牌張守恆
          斷言立刻紅燈。同一個疏忽也會讓「重連後看結果」少一張牌。 */
    const s = { ...st, hands:st.hands.map(h=>h.slice()),
                melds:st.melds.map(m=>m.slice()), discards:st.discards.slice() };
    if(selfDraw){
      s.hands[seat] = sortHand(s.hands[seat].concat([s.drawn]));
    }else if(o.rob){
      /* 搶槓:那個槓**不算成立**,退回成碰,牌歸胡牌的人(這才是真規則,
         也順便讓牌張守恆 —— 不退的話那張會同時算在槓裡與贏家手裡)。 */
      const mi = s.melds[o.from].findIndex(m=>m.k==="kong" && m.t===o.tile);
      if(mi>=0) s.melds[o.from][mi] = { ...s.melds[o.from][mi], k:"pung" };
      s.hands[seat] = sortHand(s.hands[seat].concat([o.tile]));
    }else{
      // 食胡:那張從牌河拿走(taken 同 takeMeld —— 結果卡可以被「偷看牌面」收起來,
      // 那時盤面照樣要正確,不能把上一張畫成最新那張)
      if(s.discards.length && s.discards[s.discards.length-1].t===o.tile){ s.discards.pop(); s.taken = true; }
      s.hands[seat] = sortHand(s.hands[seat].concat([o.tile]));
    }
    s.claim = null; s.drawn = -1; s.robbable = null;
    /* rob:這一胡是不是搶槓來的(v1.70.0 加)。台數表本來就認得搶槓,但那是**贏家**的
       台種;結果卡要對**被搶的那家**講「槓被搶了」,得從 over 認得出來 ——
       st.claim 到這裡已經清掉了,不留記號就再也問不到。
       ⚠ over 是整包 JSON.stringify 進 Firebase(見 enc),加欄位不必動序列化。 */
    s.over = { type:"win", seat:seat, from:o.from, tile:o.tile, rob:!!o.rob,
               tai:res.tai, base:res.base, total:res.total,
               list:res.list, deltas:deltas };
    return s;
  }

  /* ==========================================================================
     查詢(給 UI 用)
     ========================================================================== */
  /* 現在這家可以做什麼(自己的回合) */
  function ownActions(st, seat){
    const out = { discard:false, win:false, ckong:[], akong:[] };
    if(st.over || st.claim || st.turn!==seat || !toPlay(st,seat)) return out;
    out.discard = true;
    const all = allTiles(st, seat);
    const c = R.toCounts(all);
    // 自摸只有「真的摸到一張」才算 —— 吃 / 碰之後不可能自摸
    out.win = (st.drawn>=0) && R.canWin(c, needOf(st,seat));
    out.ckong = R.concealedKongs(c);
    out.akong = st.melds[seat].filter(m=>m.k==="pung" && all.indexOf(m.t)>=0).map(m=>m.t);
    return out;
  }
  /* 打掉某張之後會聽什麼(給「聽牌提示」用) */
  function tenpaiAfter(st, seat, tile){
    if(!toPlay(st, seat)) return [];
    const rest = removeOne(allTiles(st, seat), tile);
    if(!rest) return [];
    return R.winningTiles(R.toCounts(rest), needOf(st,seat));
  }
  /* ★ 「我現在聽哪幾張」(v1.66.0)—— 打完牌之後的那個狀態。
     ★ 基準刻意是 st.hands[seat] 而**不含剛摸到那張**:16 張(need*3+1)才是「聽牌」的
       張數。摸到牌之後手上 17 張,那時要問的是「打掉哪張之後聽什麼」= tenpaiAfter();
       而摸切(打掉剛摸的那張)聽的就還是這一份 —— 所以摸牌途中拿它當「我現在聽什麼」
       是正確且穩定的(不會因為摸進來一張沒用的牌就閃一下說我沒聽牌了)。
     ⚠ 吃 / 碰之後手上也多一張(hands 比基準多 1),winningTiles() 的張數守衛會回空陣列
       —— 那是對的:那一刻還沒打出去,還不算聽牌。 */
  function tenpaiNow(st, seat){
    if(!st || !st.hands || !st.hands[seat]) return [];
    return R.winningTiles(R.toCounts(st.hands[seat]), needOf(st, seat));
  }
  function wallLeft(st){ return st.wall.length - st.pos; }
  /* ★ 牌山「還剩幾張**可以摸**」(v1.104.0)—— 給畫面看的那個數字。
     ⚠ 不是 wallLeft():最後那 rs.wallEnd 張(海底那一墩)是留著不摸的,
       摸到只剩 wallEnd 張就流局(R.isExhausted)。所以拿 wallLeft() 去顯示,
       畫面會在「還剩 16 張」的時候突然說流局 —— 正是使用者回報的那個「有點奇怪」。
     ★ 這一支歸零的那一刻**就是**流局,所以盤面敢把它當「還剩幾張」直接顯示。
     ⚠ 一摸不一定只減 1:補花與槓上補牌走同一條 draw(),pos 一樣往前走。
       那不是 bug,而正是「怎麼會突然沒牌」的真正原因,顯示出來才看得懂。 */
  function drawsLeft(st){
    if(!st || !st.wall) return 0;
    const rs = R.RULESETS[st.rs] || R.RULESETS.p4;
    return Math.max(0, st.wall.length - st.pos - rs.wallEnd);
  }

  /* ★ 下一局誰坐莊、連了幾拉幾(連莊,v1.102.0)——「一局結束」到「開新局」之間唯一的一條規則。
     本桌採用的是最常見的那一套:
       莊家胡牌(自摸或食胡)→ 莊不變,連莊 +1
       流局                 → 莊不變,連莊 +1(俗稱「拉莊」)
       別家胡牌             → 換莊給**莊家的下家**,連莊歸零
     ⚠ 刻意做成「吃一份結束的 state、回傳純資料」而不是寫回 st:開新局的地方有兩份
       (solo.js 的 newHand / adapter.js 的 newGame),規則只能有一份。
     ⚠ 回傳的 dealer 是**這一局的座位編號**。連線每局會輪換座位,所以 adapter 必須把它
       換算成玩家 id 再放回新座位表(見 adapter.js 的 lastDeal)—— 直接沿用座位編號會變成
       「莊留在原位、但原位換人坐了」。 */
  function nextDealerOf(st){
    if(!st || !st.over) return null;
    const keep = (st.over.type==="draw") || (st.over.seat===st.dealer);
    return keep ? { dealer: st.dealer, streak: (st.dealerStreak||0) + 1 }
                : { dealer: nextOf(st.dealer, st.seats), streak: 0 };
  }

  /* ★ 圈數與圈風(v1.122.0)——「莊家真的換過幾次人」才是圈數的量尺,連莊 / 流局都不算換人
     (那正是 nextDealerOf 回傳 streak>0 的那一種)。呼叫端只要在每次看到 streak 歸零那一刻
     把自己的累計換人次數 +1,就能拿這裡的兩支純函式換算「打完幾圈」與「現在第幾圈的風」。
     ⚠ 累計次數本身**不歸這裡管**:單機座位固定,直接用 nextOf() 走過的次數就對;連線的桌次每局
       輪換(newGame 的 ord 會轉一位),座位編號對不上「圈裡第幾位」,只能由呼叫端自己存一個
       跨局的計數(solo.js 的 dealerPass / adapter.js 的 dealerPass),跟 lastDeal 存法同一個道理
       (見 nextDealerOf 上面那條註解)。 */
  function roundsOf(seats, passes){ return Math.floor((passes||0) / (seats||1)); }
  function windOfRounds(rounds){ return WINDS[((rounds||0) % 4 + 4) % 4]; }

  /* ---------- 序列化:整包寫進 Firebase 的 game 節點 ----------
     ★ 陣列一律轉成字串:RTDB 的稀疏陣列很難纏(中間有 null 就變成物件),
       而且整局的 wall 有 144 個數字,字串短很多。 */
  function enc(st){
    return {
      rs:st.rs, seats:st.seats,
      wall:st.wall.join(","), pos:st.pos,
      hands:st.hands.map(h=>h.join(",")).join("|"),
      melds:JSON.stringify(st.melds),
      flowers:st.flowers.map(f=>f.join(",")).join("|"),
      discards:st.discards.map(d=>d.seat+":"+d.t).join(","),
      turn:st.turn, drawn:st.drawn, dealer:st.dealer, roundWind:st.roundWind,
      handNo:st.handNo, dealerStreak:st.dealerStreak, base:st.base,
      claim:st.claim?JSON.stringify(st.claim):null,
      over:st.over?JSON.stringify(st.over):null,
      firstGo:!!st.firstGo, kongDraw:!!st.kongDraw, robbable:st.robbable,
      /* 牌河最後那張剛被拿走(v1.73.2)。⚠ 一定要進序列化:少了它,吃 / 碰之後
         **別人那幾台**(與斷線重連的那台)會把上一張畫成「最新那張」——
         盤面真相在 state,不在本地記憶。舊房間沒這個欄位 → dec 解成 false,
         那一手退回舊行為(不會壞,下一次打牌就回到正軌)。 */
      taken:!!st.taken,
      /* 宣告聽牌:每家一格,空字串 = 沒宣告(例 "normal,,di," )。
         ⚠ 一定要用逗號串而不是 JSON:RTDB 的稀疏陣列很難纏(同 wall / hands 那幾個)。 */
      ting:(st.ting||[]).map(x=>x||"").join(",")
    };
  }
  const nums = s => (s==="" || s==null) ? [] : String(s).split(",").map(Number);
  /* 宣告聽牌那一格。⚠ 一定要補齊到 seats 長度:v1.67.0 之前的房間沒有這個欄位,
     解出來會是空陣列 → `st.ting[seat]` 讀到 undefined 還好,但 `.slice()` 之後
     長度不對就會在 declareTing 時把別家的格子吃掉。 */
  function tings(s, seats){
    const a = (s==null || s==="") ? [] : String(s).split(",").map(x=>x||null);
    while(a.length < seats) a.push(null);
    return a.slice(0, seats);
  }
  function dec(g){
    if(!g || !g.wall) return null;
    const seats = g.seats||4;
    return {
      rs:g.rs||"p4", seats:seats,
      ting:tings(g.ting, seats),
      wall:nums(g.wall), pos:g.pos||0,
      hands:String(g.hands||"").split("|").map(nums),
      melds:g.melds?JSON.parse(g.melds):[],
      flowers:String(g.flowers||"").split("|").map(nums),
      discards:(g.discards?String(g.discards).split(","):[]).filter(Boolean)
               .map(x=>{ const p=x.split(":"); return { seat:+p[0], t:+p[1] }; }),
      turn:g.turn||0, drawn:(typeof g.drawn==="number")?g.drawn:-1,
      dealer:g.dealer||0, roundWind:g.roundWind||27,
      handNo:g.handNo||1, dealerStreak:g.dealerStreak||0,
      // 舊房間沒有 base → 解成 1(= v1.75.14 以前的行為),不會壞
      base:(typeof g.base==="number" && g.base>0)?g.base:1,
      claim:g.claim?JSON.parse(g.claim):null,
      over:g.over?JSON.parse(g.over):null,
      firstGo:!!g.firstGo, kongDraw:!!g.kongDraw,
      robbable:(typeof g.robbable==="number")?g.robbable:null,
      taken:!!g.taken
    };
  }

  return {
    newRound, autoDraw, discard, bid, allBidsIn, resolveClaim,
    concealedKong, addKong, selfDrawWin, settleWin,
    // 宣告聽牌(v1.67.0)
    declareTing, canDeclareTing, tingTiles, tingTypeOf, tingOf, DI_TING_MAX,
    ownActions, tenpaiAfter, tenpaiNow, eligibleFor, wallLeft, drawsLeft, nextDealerOf,
    roundsOf, windOfRounds, WINDS,
    seatWind, leftOf, nextOf, needOf, toPlay, holding, allTiles, enc, dec
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MJT;

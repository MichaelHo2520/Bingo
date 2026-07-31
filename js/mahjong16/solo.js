"use strict";

/* ============================================================================
   台灣 16 張麻將 — 單機(本地)對戰。人 1 家 + 電腦 1~3 家。

   ── 與連線的關係 ──────────────────────────────────────────────────────────
     一整局的真相**同樣是 MJT 那包 state**,盤面**同樣是 M16B**,規則 / 台數 / 收付
     一行都不另寫 —— 這一支只負責「輪到電腦時,問 MJ16AI 要做什麼,然後照做」。
     ⚠ 完全不碰 Firebase、不碰 MP:單機一場的真相只有這裡的 st / tai。
       比照 js/gomoku/solo.js 與 js/sudoku/solo.js 的分工。

   ── ★ 電腦下手一定要「慢一點」 ────────────────────────────────────────────
     AI 一次決策 0.4ms,直接跑完的話三家電腦會在同一個畫格內把牌打完 ——
     玩家看到的是「我打完牌,盤面瞬間變了三次」,根本看不出發生什麼事。
     所以每個動作都排一段 think 延遲(難度不同、還帶亂數),吃碰另外再排一段。
     ⚠ 所有 setTimeout 都要走 later():它帶一個 gen 記號,離開牌桌 / 換局時
       gen++ 就讓還在飛的回呼全部失效。少了這個,退出後電腦還會繼續打牌,
       而且會打進**下一場**的 state 裡。

   ── ★ 電腦「在想什麼」不可以洩漏給玩家 ────────────────────────────────────
     同 v1.59.0 那條(連線版):玩家打出一張牌之後,如果電腦正在決定要不要吃碰,
     動作列不可以透露這件事。寫成「等電腦決定要不要吃碰」等於告訴玩家
     「有人手上有這張」—— 單機一樣是牌情,而且單機更明顯(就那幾家)。
     ★★ v1.65.0:中性的「等其他人…」**還是不夠** —— 沒有宣告視窗時那一格寫的是
       「輪到 ○○…」,兩句話不一樣就照樣看得出來。現在兩種情況顯示**同一句**
       (turnText(dispTurn())),對手列的高亮也一起走 board.js 的 shownTurn()。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;                                   // 玩家固定坐 0 號位(莊家逐局輪)
  const OWN_KEY = "mahjong16.solo.v1";
  /* 電腦的名字。刻意取得像牌搭子而不是「電腦 1」——
     結果卡與收付表上一排「電腦 1 / 電腦 2」讀起來像除錯畫面。 */
  const AI_NAMES = ["小碰", "阿槓", "老胡"];
  const SEATS_OK = [2,3,4];
  const GOALS = [1,4,8,16];

  let level = "normal", seats = 4, goal = 4;
  let rec = {};                                   // 各難度戰績 { easy:{g,w,best}, … }

  let st = null;                                  // 這一局的 MJT state
  let tai = [];                                   // 這一場的累計台數(依座位)
  let handNo = 0;                                 // 打完幾局了
  let active = false, settled = false;
  let claimDone = "";                             // 這個宣告視窗的電腦表態排過了沒
  let sfxPrev = null;                             // 上一次餵給音效的 state(見 sfxTick)
  let gen = 0, timers = [];

  /* ---------- 計時器:全部帶 gen 記號(見檔頭) ---------- */
  function later(fn, ms){
    const g = gen;
    const id = setTimeout(function(){
      if(g !== gen || !active) return;
      fn();
    }, ms);
    timers.push(id);
    return id;
  }
  function killTimers(){
    gen++;
    timers.forEach(clearTimeout);
    timers = [];
  }

  /* ---------- 偏好與戰績 ----------
     ★ 與連線的 handsGoal 刻意分開存:那是房主替全房選的,和自己想單練幾局是兩回事
       (比照 gomoku.solo.v1 / sudoku.solo.v1)。 */
  function blank(){ return { g:0, w:0, best:0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(MJ16AI.LEVELS[o.level]) level = o.level;
      if(SEATS_OK.indexOf(+o.seats) >= 0) seats = +o.seats;
      if(GOALS.indexOf(+o.goal) >= 0) goal = +o.goal;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    MJ16AI.LEVEL_KEYS.forEach(function(k){ if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level:level, seats:seats, goal:goal, rec:rec })); }catch(e){}
  }
  function recOf(k){ return rec[k] || blank(); }
  function recText(k){
    const r = recOf(k);
    if(!r.g) return "還沒跟這個難度打過";
    return r.g + " 場 " + r.w + " 勝 · 最佳 " + (r.best>0?"+":"") + r.best + " 台";
  }

  /* ---------- 名字 / 座位 ---------- */
  function seatName(s){ return s === ME ? "你" : (AI_NAMES[(s-1) % AI_NAMES.length] || ("電腦"+s)); }
  /* 畫面上「輪到誰」——宣告視窗開著時 st.turn 還停在打牌的人身上,沒人能宣告時
     turn 早就跳到下一家了 → 直接顯示 st.turn 等於告訴玩家「電腦在考慮吃你這張」。
     ⚠ 與 adapter.js 的 dispTurn() / board.js 的 shownTurn() 同一條規則(grep dispTurn)。 */
  function dispTurn(){
    if(!st) return 0;
    if(st.claim && !st.claim.rob) return (st.claim.from + 1) % st.seats;
    return st.turn;
  }
  function turnText(s){ return s === ME ? "輪到你…" : ("輪到 " + seatName(s) + "…"); }
  function windGlyph(s){
    if(!st) return "";
    return MJFace.info(MJ16.codeOf(MJT.seatWind(s, st.dealer, st.seats))).glyph;
  }
  const face = function(t){ return MJFace.info(MJ16.codeOf(t)); };

  /* ==========================================================================
     一場的生命週期
     ========================================================================== */
  function start(){
    killTimers();
    active = true;
    tai = new Array(seats).fill(0);
    handNo = 0;
    saveOwn();
    showScreen("solo");
    closeWin();
    Sound.start();
    M16Sfx.preload();                             // 喊牌音檔先載好(見 sfx.js 的 preload)
    newHand();
  }
  function newHand(){
    killTimers();
    settled = false; claimDone = "";
    /* ⚠ 一定要清:換局是整包重發,拿上一局的 state 去 diff 會在開局瞬間響一串吃碰槓。
       sfx 自己也用 handNo 擋了一層,但「打 1 局」那個設定下新的一局 handNo 同樣是 1
       (再來一場會把 handNo 歸零),只靠那一層擋不住。 */
    sfxPrev = null;
    M16B.clearSel();
    closeWin();
    st = MJT.newRound({
      rs: "p" + seats,
      dealer: handNo % seats,                     // 每局換莊(同連線:局數才可預測)
      roundWind: MJ16.idxOf("fe"),
      handNo: handNo + 1
    });
    if(!st){ showToast("發牌失敗,回選單"); quit(); return; }
    step();
    // 盤面這一刻才拿到尺寸(同五子棋 initialView 那一手)
    requestAnimationFrame(function(){ M16B.render(st, ME); });
  }
  function quit(){
    killTimers();
    active = false; st = null; settled = false; sfxPrev = null;
    M16B.clearSel();
    closeWin();
    const box = $("m16Acts");
    if(box){ box.classList.add("hidden"); box.innerHTML = ""; }
    showScreen("home");
    showHomeLayer("solo");                        // 回到「單機」那一層,方便換難度再來
  }
  function again(){
    if(handNo >= goal) start();                   // 整場打完了 → 重開一場
    else newHand();
  }

  /* ==========================================================================
     推進:每次 state 變了就叫這一支
     ========================================================================== */
  function step(){
    if(!active || !st) return;
    render();
    if(st.over){ finishHand(); return; }
    if(st.claim){ scheduleClaims(); return; }
    if(st.turn === ME) return;                    // 等玩家動作
    scheduleAI();
  }

  function render(){
    if(!st) return;
    sfxTick();
    M16B.render(st, ME);
    paintBar();
    paintActs();
  }
  /* 摸打吃碰槓胡的音效。★ 刻意集中在這一處、用前後兩份 state 比對,而不是在每個動作點
     插一句 Sound.xxx():單機的 st 在 applyAI / onDiscard / ownAct / resolveClaim 四處都會
     換手,一個個插一定會漏(而且連線那邊還得再插一遍 —— 現在兩邊共用同一份判斷,
     見 js/mahjong16/sfx.js 的檔頭)。 */
  function sfxTick(){
    const prev = sfxPrev;
    sfxPrev = st;
    if(prev !== st) M16Sfx.play(prev, st, ME);
  }

  /* ==========================================================================
     電腦的回合
     ========================================================================== */
  function scheduleAI(){
    const seat = st.turn;
    const lv = MJ16AI.levelOf(level);
    later(function(){
      if(!st || st.over || st.claim || st.turn !== seat) return;
      const v = MJ16AI.viewOf(st, seat);
      let a;
      try{ a = MJ16AI.pickTurn(v, level); }catch(e){ a = null; }
      applyAI(seat, a || { act:"discard", t:v.hand[0] });
    }, MJ16AI.thinkMs(lv));
  }

  /* ⚠ 這一段的每一條退路都不能少:AI 只要出一次非法動作,單機就**永遠卡在那一家**
     (沒有別台裝置會來救,也沒有 timer 會補)。所以一律「試 → 不行就退回打牌 →
     再不行就打手上第一張」,而且真的全部失敗時直接把這局判流局,不要靜靜卡死。 */
  function applyAI(seat, a){
    let nx = null;
    if(a.act === "win")        nx = MJT.selfDrawWin(st, seat);
    else if(a.act === "ckong") nx = MJT.concealedKong(st, seat, a.t);
    else if(a.act === "akong") nx = MJT.addKong(st, seat, a.t);
    if(nx){
      if(a.act !== "win")
        showToast(seatName(seat) + (a.act === "ckong" ? " 暗槓 " : " 加槓 ") + face(a.t).name, 1300);
    }else{
      if(a.act === "discard") nx = MJT.discard(st, seat, a.t);
      if(!nx){
        const all = MJT.allTiles(st, seat);
        for(let i=0;i<all.length && !nx;i++) nx = MJT.discard(st, seat, all[i]);
      }
    }
    /* ⚠ 這裡刻意不播音效 —— 摸打吃碰槓胡一律由 sfxTick() 從 state diff 播(見那支的註解)。 */
    if(!nx){                                       // 真的沒救(不該發生)
      st = Object.assign({}, st, { over:{ type:"draw" }, claim:null });
      showToast("這一局出了狀況,當流局處理", 1800);
    }else st = nx;
    step();
  }

  /* ==========================================================================
     宣告視窗
     ★ 單機**不給玩家倒數計時**:連線那顆環是為了「不能讓全房等一個人」才存在的,
       單機沒有別人在等 —— 給時間壓力只會讓人手忙腳亂地按錯。
     ========================================================================== */
  function scheduleClaims(){
    const key = st.claim.t + "@" + st.claim.from;
    if(claimDone === key) return;                  // 電腦已經表態過了,現在在等玩家
    claimDone = key;
    const lv = MJ16AI.levelOf(level);
    later(function(){
      if(!st || !st.claim || st.over) return;
      const elig = st.claim.elig;
      Object.keys(elig).forEach(function(k){
        const seat = +k;
        if(seat === ME || st.claim.bids[seat]) return;
        const v = MJ16AI.viewOf(st, seat);
        let d = null;
        try{ d = MJ16AI.pickClaim(v, st.claim.t, elig[seat], level); }catch(e){ d = null; }
        const nx = (d ? MJT.bid(st, seat, d.type, d.tiles) : null) || MJT.bid(st, seat, "pass", null);
        if(nx) st = nx;
      });
      if(MJT.allBidsIn(st)) resolveClaim();
      else render();                               // 還在等玩家:只重畫,不要再排一次
    }, MJ16AI.thinkMs(lv, "claimThink"));
  }

  function resolveClaim(){
    const before = st;
    const nx = MJT.resolveClaim(st);
    if(!nx) return;
    st = nx;
    announceClaim(before, nx);
    claimDone = "";
    M16B.clearSel();
    step();
  }
  /* 誰吃碰槓了 → 報一下。★ 只報**已經成立**的動作(牌已經攤在桌上),
     所以不違反「不可以洩漏誰在考慮」那條。 */
  function announceClaim(before, after){
    if(after.over) return;
    for(let s=0;s<after.seats;s++){
      const b = before.melds[s].length, a = after.melds[s].length;
      if(a <= b) continue;
      const m = after.melds[s][a-1];
      const w = m.k === "chow" ? "吃" : (m.k === "kong" ? "槓" : "碰");
      showToast(seatName(s) + " " + w + "!", 1200);
      return;                                      // 聲音由 sfxTick() 出(吃 / 碰 / 槓 各有各的音)
    }
  }

  /* ==========================================================================
     玩家的動作
     ========================================================================== */
  function onDiscard(t){
    if(!active || !st || st.over) return;
    if(st.claim){ return; }                        // 宣告視窗中點牌 = 選要吃哪一組(board 自己處理)
    if(st.turn !== ME) return;
    const nx = MJT.discard(st, ME, t);
    if(!nx) return;
    st = nx;
    step();
  }
  function ownAct(kind, t){
    if(!active || !st || st.over || st.claim || st.turn !== ME) return;
    let nx = null;
    if(kind === "win")        nx = MJT.selfDrawWin(st, ME);
    else if(kind === "ckong") nx = MJT.concealedKong(st, ME, t);
    else if(kind === "akong") nx = MJT.addKong(st, ME, t);
    if(!nx){ showToast("這個動作現在不能做"); return; }
    st = nx;
    step();
  }
  function humanBid(type, tiles){
    if(!active || !st || !st.claim || st.claim.bids[ME]) return;
    const nx = MJT.bid(st, ME, type, tiles);
    if(!nx) return;
    st = nx;
    M16B.clearSel();
    if(MJT.allBidsIn(st)) resolveClaim();
    else render();                                 // 電腦還沒表態完,等它們的 timer
  }

  /* ==========================================================================
     一局結束
     ========================================================================== */
  function finishHand(){
    if(settled) return;
    settled = true;
    killTimers();
    const o = st.over;
    if(o.type === "win") o.deltas.forEach(function(d,s){ tai[s] += d; });
    handNo++;
    paintBar();

    const last = handNo >= goal;
    if(last){
      const r = recOf(level);
      r.g++;
      let best = -Infinity, top = [];
      tai.forEach(function(t,s){ if(t>best){ best=t; top=[s]; } else if(t===best) top.push(s); });
      if(top.indexOf(ME) >= 0) r.w++;
      if(tai[ME] > r.best) r.best = tai[ME];
      rec[level] = r;
      saveOwn();
    }
    paintResult(last);
  }

  /* ==========================================================================
     畫面
     ========================================================================== */
  /* 單機的玩家列。★ 沿用房間框那組 .mp-chip / .mj-room 的外觀 —— 連線與單機
     長得一樣才有一致感(v1.58.2 把台數搬進房間框就是這個理由)。 */
  function paintBar(){
    const box = $("m16SoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      let h = "";
      for(let s=0;s<seats;s++){
        const isTurn = !!(st && !st.over && st.turn === s);
        const t = tai[s] || 0;
        h += '<div class="mp-chip'+(isTurn?" turn":"")+(s===ME?" me":"")+'">'+
             '<span class="m16-seat p'+s+'"></span>'+
             (st?'<span class="m16-cw">'+windGlyph(s)+'</span>':"")+
             (st && s===st.dealer?'<span class="m16-dz">莊</span>':"")+
             '<span class="gmk-nm">'+esc(seatName(s))+'</span>'+
             (s===ME?'<span class="you-badge">你</span>':"")+
             '<span class="m16-pts'+(t<0?" neg":"")+'">'+(t>0?"+":"")+t+'<em>台</em></span>'+
             '</div>';
      }
      box.innerHTML = h;
    }
    const g = $("m16SoloGoal");
    if(g) g.textContent = "🀄 第 " + Math.min(goal, handNo+1) + "/" + goal + " 局";
    const lv = $("m16SoloLv");
    if(lv){
      const L = MJ16AI.levelOf(level);
      lv.textContent = L.emoji + L.name;
    }
  }

  /* 動作列。
     ⚠ 這一支與 js/mahjong16/adapter.js 的 renderActs() 是**兩份**(同 peekBoard /
       initUpdateCheck 那幾組的處理)。沒有合併是因為連線那份還要管倒數環、
       ctx.phase()、「我表態過了沒」的網路狀態,而單機這份一個都不需要;
       硬合起來會讓兩邊都變難讀。⚠ 改一邊記得看另一邊(grep m16Acts)。 */
  function actBtn(label, cls, fn){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "m16-act" + (cls ? " "+cls : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }
  /* 聽牌那一排(v1.66.0)。牌面與尺寸走 M16B.readyHTML(),與連線共用同一份 ——
     ⚠ 但「插在哪一格」的那幾行與 adapter.js 的 appendReady() 是**兩份**(grep m16-ready)。
     ⚠⚠ 它**不可以只在沒有宣告視窗時出現**:我打完一張牌,聽牌那排突然不見了 =
       電腦吃得下我剛打的那張(v1.59.0 那條紅線的第 6 條管道,單機更明顯 —— 就那兩三家)。 */
  function appendReady(box, seat){
    if(!M16Sfx.readyOn()) return;
    const h = M16B.readyHTML(st, seat);
    if(h) box.insertAdjacentHTML("beforeend", h);
  }
  function paintActs(){
    const box = $("m16Acts");
    if(!box) return;
    box.innerHTML = "";
    if(!active || !st || st.over){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const tag = function(txt){
      const el = document.createElement("span");
      el.className = "m16-timer";
      el.textContent = txt;
      box.appendChild(el);
    };

    /* ★ 聽牌那一排(v1.66.0):**一律先插**,只跳過「我自己正在決定要不要吃碰」那一格
       (那時已經有 ✔ / 胡 / 過 三顆鈕,再多一排會換行 → 動作列長高 → 整副牌縮一次)。
       ⚠ 條件刻意與 st.claim **無關**,見 appendReady 的註解那條第 6 管道。 */
    const iDecide = !!(st.claim && st.claim.elig[ME] && !st.claim.bids[ME]);
    if(!iDecide) appendReady(box, ME);

    /* --- 宣告視窗 --- */
    if(st.claim){
      const types = st.claim.elig[ME];
      /* ★ 沒我的事 / 我已經表態 → 一個字都不提吃碰(見檔頭那條)。
         ★★ v1.65.0:連「等其他人…」都不能寫 —— 沒有宣告視窗時這裡是「輪到 ○○…」,
           兩句話不一樣,玩家照樣看得出「電腦在考慮要不要吃我這張」。單機更致命:
           就那兩三家,等於直接報牌。改成走 turnText(dispTurn()),兩種情況的字一模一樣。
           ⚠ 與 adapter.js 的 renderActs() 是**兩份**,改一邊要看另一邊(grep dispTurn)。 */
      if(!types || st.claim.bids[ME]){
        tag(st.claim.bids[ME] ? "已表態,等其他人…" : turnText(dispTurn()));
        return;
      }
      tag("別人打「" + face(st.claim.t).name + "」");
      const co = M16B.claimOpts();
      const cur = M16B.claimCur();
      if(cur){
        const lbl = { chow:"吃", pong:"碰", kong:"槓" }[cur.type] || cur.type;
        box.appendChild(actBtn("✔ " + lbl + " " + cur.tiles.map(function(t){ return face(t).name; }).join(""),
          "take", function(){ humanBid(cur.type, cur.type === "chow" ? cur.tiles : null); }));
        if(co.length > 1){
          const n = document.createElement("span");
          n.className = "m16-timer m16-more";
          n.textContent = (co.indexOf(cur)+1) + " / " + co.length + " · 點手牌換一組";
          box.appendChild(n);
        }
      }
      if(types.indexOf("win") >= 0) box.appendChild(actBtn("胡!", "win", function(){ humanBid("win", null); }));
      box.appendChild(actBtn("過", "pass", function(){ humanBid("pass", null); }));
      return;
    }

    /* --- 不是我的回合 --- */
    if(st.turn !== ME){ tag(turnText(st.turn)); return; }     // ★ 與宣告視窗那句一模一樣

    /* --- 我的回合 --- */
    const a = MJT.ownActions(st, ME);
    if(a.win) box.appendChild(actBtn("自摸!", "win", function(){ ownAct("win"); }));
    a.ckong.forEach(function(t){
      box.appendChild(actBtn("暗槓 " + face(t).name, "", function(){ ownAct("ckong", t); }));
    });
    a.akong.forEach(function(t){
      box.appendChild(actBtn("加槓 " + face(t).name, "", function(){ ownAct("akong", t); }));
    });
    /* ⚠ 判準是「有沒有按鈕」而不是「這一列空不空」(v1.66.0 改)——
       聽牌那一排也是子元素,用 children.length 的話一聽牌操作提示就消失了。 */
    if(a.discard && !box.querySelector(".m16-act")) tag(M16B.discardHint());
  }

  /* ---------- 結果卡 ----------
     ⚠ 與 adapter 的 outcome() / paintTaiTable() / paintWinTiles() 同樣是兩份,
       理由同上(那邊要處理 ctx.dispName / 賽季 / 表情列)。攤牌本身走
       M16B.revealHTML(),牌面與明牌的排法只有一份。 */
  function paintResult(last){
    const o = st.over;
    const iWon = (o.type === "win" && o.seat === ME);
    const card = $("m16WinCard");
    if(card) card.classList.remove("win","lose","draw");

    // 攤出胡牌那家的牌
    const box = $("m16Win");
    if(box){
      if(o.type === "win"){
        const n = (st.hands[o.seat] || []).length;
        const tw = Math.max(17, Math.min(28, Math.floor(300 / Math.max(1,n))));
        box.classList.remove("hidden");
        box.innerHTML = '<div class="m16-showh">' + esc(seatName(o.seat)) +
          ' 的牌 · <em>紅框</em>是胡的那張</div>' + M16B.revealHTML(st, o.seat, tw, o.tile);
      }else{ box.classList.add("hidden"); box.innerHTML = ""; }
    }
    paintTai(last);

    let word, msg;
    if(o.type !== "win"){
      word = last ? "本場結束" : "流局";
      /* ⚠ 句尾不要放 Unicode 麻將字元(U+1F000 那一段)。原本是「…不收付 🀫」,
         而 U+1F02B(牌背)在**桌機與手機都畫成一個空心方框** —— 看起來就是缺字的豆腐,
         使用者的回報是「流局的時候變得好奇怪」。這條規矩專案早就寫過兩次
         (styles.css 的牌面段落、js/mahjong/board.js 檔頭):那 43 個字元只有 🀄 有
         emoji 呈現,其餘一律文字呈現、各家字型畫出來的東西都不一樣。
         ★ 這裡是**散文句尾的裝飾**,拿掉就好(要放圖一律用 MJFace 自繪的牌)。 */
      msg = "牌山見底,這一局不收付" + (last ? "<br>" + seasonMsg() : "");
    }else{
      const tags = o.list.map(function(x){ return esc(x.name)+" "+x.tai; }).join("、");
      const how = (o.from === null) ? "自摸" : ("胡 " + esc(seatName(o.from)) + " 打的牌");
      const line = "底 " + o.base + " + 台 " + o.tai + " = <b>" + o.total + "</b> 台(" + (tags||"無台") + ")";
      word = last ? "本場結束" : (iWon ? "你胡了!" : "你沒胡");
      msg = (iWon ? how : (esc(seatName(o.seat)) + " " + how)) + "<br>" + line +
            (last ? "<br>" + seasonMsg() : "");
    }
    $("winWord").textContent = word;
    $("winMsg").innerHTML = msg;

    const again = $("m16SoloAgain");
    if(again) again.textContent = last ? "🔄 再來一場" : "下一局 ▸";
    if(iWon){ Sound.win(); burst(); }
    else if(o.type === "win") Sound.lose();
    showResult();
  }
  function paintTai(last){
    const box = $("m16Tai");
    if(!box) return;
    box.classList.remove("hidden");
    const rows = [];
    for(let s=0;s<seats;s++) rows.push({ s:s, t:tai[s]||0 });
    rows.sort(function(a,b){ return b.t - a.t; });
    box.innerHTML = '<div class="m16-taih">' + (last ? "總結算" : "目前台數") +
      '(全桌相加必為 0)</div>' +
      rows.map(function(r){
        return '<div class="m16-tair"><span>' + esc(seatName(r.s)) +
          (r.s===ME?'<span class="you-badge">你</span>':"") + '</span><b class="' +
          (r.t<0?"neg":"") + '">' + (r.t>0?"+":"") + r.t + ' 台</b></div>';
      }).join("");
  }
  function seasonMsg(){
    let best = -Infinity, top = [];
    for(let s=0;s<seats;s++){
      const t = tai[s] || 0;
      if(t > best){ best = t; top = [s]; } else if(t === best) top.push(s);
    }
    const who = top.map(seatName).join("、");
    return (top.indexOf(ME) >= 0 ? "🏆 你以 " : "🏆 " + esc(who) + " 以 ") + best + " 台奪冠";
  }

  /* 點對手那一列:報一下他是誰、什麼難度、攤了幾組(連線版那裡是傳表情,單機沒有對象) */
  function onFoe(seat){
    if(!st || seat === ME) return;
    const L = MJ16AI.levelOf(level);
    const m = st.melds[seat].length;
    showToast(seatName(seat) + " · " + L.emoji + L.name + " · 攤了 " + m + " 組 · " +
              (tai[seat]>0?"+":"") + (tai[seat]||0) + " 台", 1600);
  }

  return {
    start, quit, again, newHand, loadOwn, saveOwn,
    onDiscard, onFoe, humanBid,
    refreshActs: paintActs,
    seatName, recText,
    active: function(){ return active; },
    playing: function(){ return active && !!st && !st.over; },
    /* 這一局的 state。給 e2e 與主控台看的(同 adapter 的 api.state)——
       ⚠ 是**同一個物件**不是複本,測試只准讀不准改。 */
    state: function(){ return st; },
    hands: function(){ return handNo; },
    level: function(){ return level; },
    seats: function(){ return seats; },
    goal:  function(){ return goal; },
    setLevel(v){ if(MJ16AI.LEVELS[v]){ level = v; saveOwn(); } },
    setSeats(v){ v=+v; if(SEATS_OK.indexOf(v)>=0){ seats = v; saveOwn(); } },
    setGoal(v){ v=+v; if(GOALS.indexOf(v)>=0){ goal = v; saveOwn(); } }
  };
})();

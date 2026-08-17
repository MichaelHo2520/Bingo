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
  /* 打幾局(v1.122.0 起改成「除了 1 局,其它都算圈數」—— 使用者:「一圈是要指每一個人都
     當完莊家,並且下莊後才算」。★ 負數 = 圈數,正數 = 局數,兩種目標刻意共用同一個欄位、
     用正負號分岔,不必另開一個「單位」欄位(button 的 data-goal 直接就是這個數字)。
     0 = 無限制(想玩到自己離開牌桌為止,見 seasonDone() 的檔頭)。 */
  const GOALS = [1,-1,-2,-4,0];
  /* 底幾台(v1.75.15,使用者:「底幾台要能被設定,預設為 2 台」)。
     ★ 預設值放在這裡而不是 MJT.newRound:那一層是規則,底台是**一場的設定**
       (同 goal / seats)。連線那份是房間設定,見 adapter.js 的 BASE_DEF。 */
  const BASES = [1,2,3,5];
  const BASE_DEF = 2;

  let level = "normal", seats = 4, goal = -1, base = BASE_DEF;
  let rec = {};                                   // 各難度戰績 { easy:{g,w,best}, … }

  let st = null;                                  // 這一局的 MJT state
  let tai = [];                                   // 這一場的累計台數(依座位)
  let handNo = 0;                                 // 打完幾局了
  /* 下一局的莊家與連莊數(v1.102.0)。★ 規則只有一份,在 MJT.nextDealerOf() ——
     這裡只是把它算出來的東西存到下一次 newHand()。單機座位固定,所以直接存座位編號
     (連線那份要換算成玩家 id,見 adapter.js 的 lastDeal)。 */
  let dealerSeat = 0, dealerStreak = 0;
  /* 這一場「莊家真的換過幾次人」(v1.122.0,圈數的量尺)。★ 只有 nextDealerOf() 回傳
     streak===0(換人,不是連莊/拉莊)才 +1 —— MJT.roundsOf(seats, dealerPass) 就是打完幾圈,
     MJT.windOfRounds(...) 就是下一局該用的圈風。單機座位固定,不必像 adapter.js 那樣
     另外換算「桌次輪換」的問題。 */
  let dealerPass = 0;
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
      if(BASES.indexOf(+o.base) >= 0) base = +o.base;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    MJ16AI.LEVEL_KEYS.forEach(function(k){ if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level:level, seats:seats, goal:goal, base:base, rec:rec })); }catch(e){}
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

  /* ---------- 打幾局 / 打幾圈的文案(v1.122.0) ----------
     ★ 只有這裡知道 goal 的正負號意思,呼叫端(paintBar / paintTai)只管拿字串來用。 */
  function goalLabel(g){
    if(g === 0) return "無限制";
    if(g > 0) return g + " 局";
    return (-g === 4) ? "一將(4圈)" : ((-g) + " 圈");
  }
  /* 對局中房間框那顆徽章。局數版沿用舊字;圈數版顯示目前圈風 + 第幾圈;無限制版只報第幾局。 */
  function goalBadgeText(){
    if(goal === 0) return "第 " + (handNo+1) + " 局";
    if(goal > 0) return "第 " + Math.min(goal, handNo+1) + "/" + goal + " 局";
    const rGoal = -goal;
    const idx = st ? MJT.WINDS.indexOf(st.roundWind) : 0;
    const w = st ? face(st.roundWind).name : "東";
    return w + "圈 · 第 " + (idx+1) + "/" + rGoal + " 圈";
  }
  /* 結果卡排名表表頭(見 M16B.rankHTML 的 progressText / finalText)。 */
  function goalProgressText(){
    if(goal === 0) return "已打 " + handNo + " 局(不限)";
    if(goal > 0) return "第 " + handNo + " / " + goal + " 局結束";
    const w = st ? face(st.roundWind).name : "東";
    return w + "圈 · 已完成 " + MJT.roundsOf(seats, dealerPass) + " / " + (-goal) + " 圈";
  }
  function goalFinalText(){ return goalLabel(goal) + "打完"; }

  /* ==========================================================================
     一場的生命週期
     ========================================================================== */
  function start(){
    killTimers();
    active = true;
    tai = new Array(seats).fill(0);
    handNo = 0;
    /* 新的一場:玩家先坐莊、連莊歸零。★ 一定要在這裡重設 —— 上一場打到誰連莊都不能
       帶進新的一場,而且家數可能改過(舊的 dealerSeat 會超出新的座位數)。 */
    dealerSeat = ME; dealerStreak = 0; dealerPass = 0;
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
    M16B.resetFit();                              // 換局才重新量牌寬(v1.70.1,見 board.js 檔頭⑤)
    M16B.resetOrder();                            // 換局才丟掉玩家拖出來的手牌順序(v1.82.0)
    // 還在飛的特效跟著換局收掉(v2.4.0):上一局的「胡!」不該疊在新局的牌桌上
    if(typeof M16Fx !== "undefined") M16Fx.clear();
    closeWin();
    st = MJT.newRound({
      rs: "p" + seats,
      dealer: dealerSeat,                         // 誰坐莊由上一局的結果決定(連莊,見 finishHand)
      dealerStreak: dealerStreak,
      // 圈風跟著「打完幾圈」走(v1.122.0),不再永遠是東(見 dealerPass 的檔頭註解)
      roundWind: MJT.windOfRounds(MJT.roundsOf(seats, dealerPass)),
      handNo: handNo + 1,
      base: base
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
    M16B.resetFit();                              // 離開牌桌:下次進來從頭量
    M16B.resetOrder();                            // 離開牌桌:下次進來回到照牌序(v1.82.0)
    if(typeof M16Fx !== "undefined") M16Fx.clear();   // 同上(v2.4.0)
    closeWin();
    /* ⚠ m16-hush 要跟著拿掉(v1.111.0):留著的話下次進來那顆倒數環(連線那邊)
       會用上一場的 --m16cb 飄在盤面中央 —— 兩種模式共用同一條動作列。 */
    const box = $("m16Acts");
    if(box){ box.classList.remove("m16-hush"); box.classList.add("hidden"); box.innerHTML = ""; }
    showScreen("home");
    showHomeLayer("solo");                        // 回到「單機」那一層,方便換難度再來
  }
  /* 這一場打完了沒(v1.122.0)。★ `goal>0` 是舊的「打幾局」,`goal<0` 是新的「打幾圈」,
     `goal===0` 是無限制(永遠沒打完,直到玩家自己按離開)——三者刻意共用同一個判斷,
     呼叫端不必先問清楚自己是哪一種。
     ⚠ goal===0 一定要提前擋掉:少了這條會落進圈數分支,`MJT.roundsOf(...) >= -0` 恆真,
       每打完一局都會被當成「整場打完」,again() 就會一直重開新的一場而不是接著打。 */
  function seasonDone(){
    if(goal === 0) return false;
    return goal > 0 ? (handNo >= goal) : (MJT.roundsOf(seats, dealerPass) >= -goal);
  }
  function again(){
    if(seasonDone()) start();                      // 整場打完了 → 重開一場
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
    if(st.turn === ME){ maybeAutoTing(); return; }  // 等玩家動作(或幫他自動摸切)
    scheduleAI();
  }

  /* ==========================================================================
     聽牌後自動摸切(v1.119.0,個人偏好 —— 開關與詳細理由見 board.js 檔頭)。
     使用者:「宣告聽牌後,可以設計一個選項自動出牌,但是如果有可以槓,也是需要停下來」。
     ★ 條件與 MJT.discard() 裡「宣告聽牌之後只能摸切」那條**完全對應**:已經宣告聽牌、
       而且自摸 / 暗槓 / 加槓一個都選不到 —— 這時唯一合法的動作就是把摸到的那張打出去,
       沒有第二種選法,自動幫他點掉不會改變任何決定。
     ⚠ 有得選(自摸 / 暗槓 / 加槓)就**不碰**:那是玩家自己要不要的決定,不是被鎖死的動作。 */
  function autoTingReady(){
    if(!M16B.autoTingOn() || !active || !st || st.over || st.claim || st.turn !== ME) return false;
    if(!MJT.tingOf(st, ME) || st.drawn < 0) return false;
    const a = MJT.ownActions(st, ME);
    return a.discard && !a.win && !a.ckong.length && !a.akong.length;
  }
  function maybeAutoTing(){
    if(!autoTingReady()) return;
    const tile = st.drawn;
    later(function(){
      // 保險:排隊等的這段時間狀態可能已經變了(例如玩家自己先點掉了),不要亂打
      if(!autoTingReady() || st.drawn !== tile) return;
      onDiscard(tile);
    }, 500);
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
    if(prev === st) return;
    const ev = M16Sfx.play(prev, st, ME) || [];
    /* 胡牌的慶祝光環(v2.2.4)—— 與連線共用同一份 diff(見 adapter.js 的同一段)。
       ⚠ 這裡刻意**不改判成 `st.over`**:那個條件在結束後每一次 render 都成立,
         而 diff 只在「剛剛才結束」那一次給 hu / zimo,正是我們要的一次。 */
    if(ev.indexOf("hu") >= 0 || ev.indexOf("zimo") >= 0) M16B.celebrate();
    /* ⚠ sfxTick() 本來就排在 render() 之前(見 render),旗標才接得上 —— 不要調換 */
    if(ev.indexOf("draw") >= 0) M16B.markDraw();
    /* ★ 出牌落桌的回彈(v2.4.0):同一套一次性旗標,同一個位置(render 之前)。 */
    if(ev.indexOf("discard") >= 0) M16B.markDrop();
    /* ★★ 動效層(v2.4.0,js/mahjong16/fx.js)—— 與連線共用同一份 diff、同一支 fx
       (adapter.js 的 applyGame 那一行是它的雙胞胎,改一邊一定要改另一邊)。
       ⚠⚠ `typeof` 守衛的理由見那邊:這一支從 render 的路上叫,ReferenceError
         會讓**整個盤面停止重畫**。 */
    if(typeof M16Fx !== "undefined") M16Fx.on(ev, prev, st, ME, seatName);
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
  /* ⚠⚠ pickTurn 新增動作時**每一個呼叫端都要跟著加一條**,漏了不會壞掉、只會變笨:
     這裡的 else 分支會退回「打 a.t 或手上第一張」,而 a.t 對別的動作而言不是要打的牌
     → 電腦變成亂打。v1.67.0 加 "ting" 時三個呼叫端(這裡 + test-mj16-ai 的 playHand
     + test-mj16-sfx 的對局迴圈)全都漏過一次,症狀就是 AI 測試的「高手比較會聽牌」紅掉。 */
  function applyAI(seat, a){
    let nx = null;
    if(a.act === "win")        nx = MJT.selfDrawWin(st, seat);
    else if(a.act === "ckong") nx = MJT.concealedKong(st, seat, a.t);
    else if(a.act === "akong") nx = MJT.addKong(st, seat, a.t);
    else if(a.act === "ting")  nx = MJT.declareTing(st, seat, a.t);
    if(nx){
      /* 宣告聽牌是**公開**的 → 一定要報出來(聲音由 sfxTick 的 diff 出)。
         ⚠ 不報的話玩家只會看到「電腦忽然不吃碰了」,而那一台是他要付的。 */
      if(a.act === "ting")
        showToast(seatName(seat) + " 聽牌!", 1500);
      else if(a.act !== "win")
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
      /* ★ v2.3.4:判準是「結果定了沒」不是「全員表態了沒」(MJT.claimDecided)——
         電腦按了碰 / 槓 / 胡,玩家手上那副吃就當場沒了,不必等他想完。
         ⚠ 玩家能胡的時候壓不掉,claimDecided 會回 false → 照樣等他(見那支的註解)。 */
      if(MJT.claimDecided(st)) resolveClaim();
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
    /* ⚠ diff 走 MJT.meldTakenAt()(v2.3.4 抽出去)—— 連線那份也報同一句,兩邊只能有一把尺。 */
    const tk = MJT.meldTakenAt(before, after);
    if(!tk) return;
    showToast(seatName(tk.seat) + " " + M16B.meldWord(tk.kind) + "!", 1200);
    // 聲音由 sfxTick() 出(吃 / 碰 / 槓 各有各的音)
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
  /* 宣告聽牌 + 打出那一張(v1.67.0)。★ 一個動作 —— 中間沒有「已宣告但還沒打」的狀態。 */
  function onTing(t){
    if(!active || !st || st.over || st.claim || st.turn !== ME) return;
    const nx = MJT.declareTing(st, ME, t);
    if(!nx){ showToast("這張打掉不會聽牌"); return; }
    M16B.setTingPick(false);
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
    if(MJT.claimDecided(st)) resolveClaim();
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
    /* 連莊(v1.102.0):下一局的莊與連莊數由這一局的結果決定。
       ⚠ 一定要在這裡算而不是 newHand():那時 st 已經被新的一局蓋掉了。 */
    const nx = MJT.nextDealerOf(st);
    if(nx){
      dealerSeat = nx.dealer; dealerStreak = nx.streak;
      if(nx.streak === 0) dealerPass++;             // 真的換人才算一次「過位」(v1.122.0)
    }
    paintBar();

    const last = seasonDone();
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
             // ★ 連莊記號跟著莊家記號走(v1.108.0),三個地方共用 M16B.lianHTML()
             (st && s===st.dealer?'<span class="m16-dz">莊</span>'+M16B.lianHTML(st.dealerStreak):"")+
             '<span class="gmk-nm">'+esc(seatName(s))+'</span>'+
             (s===ME?'<span class="you-badge">你</span>':"")+
             '<span class="m16-pts'+(t<0?" neg":"")+'">'+(t>0?"+":"")+t+'<em>台</em></span>'+
             '</div>';
      }
      box.innerHTML = h;
    }
    // 🎯 而不是 🀄(v1.133.0):這裡講的是「打幾局/打幾圈」的目標進度,理由與 adapter.js
    // 的 updateGoal() 同一條(grep 🎯 找另一份)。
    const g = $("m16SoloGoal");
    if(g) g.textContent = "🎯 " + goalBadgeText();
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
  /* 已宣告聽牌的那一排(v1.67.0 起只在宣告後出現)。牌面與尺寸走 M16B.readyHTML(),
     與連線共用同一份 —— ⚠ 但「插在哪一格」的那幾行與 adapter.js 的 appendReady()
     是**兩份**(grep m16-ready)。 */
  function appendReady(box, seat){
    const h = M16B.readyHTML(st, seat);
    if(h) box.insertAdjacentHTML("beforeend", h);
  }
  /* 正在選「要打哪一張來宣告聽牌」。⚠ 一定要同時問 canDeclareTing:模式開著但
     輪次已經走掉時,那顆取消鈕要跟著消失(board 那邊也自己失效)。 */
  function tingPicking(){
    return !!(st && M16B.tingPicking && M16B.tingPicking() && MJT.canDeclareTing(st, ME));
  }
  /* ★ v1.177.1:真正畫的那一支是 paintActsRow(),這裡多包一層只為了最後那一行 ——
     這一列畫完之後要叫 M16B.placeActs(),明牌帶才知道右邊要讓多寬(見 board.js 的
     actsReserve)。⚠ 包一層而不是逐個 return 前補一行(那一支有五條 return)。
     ⚠ adapter.js 的 renderActs() 是**另一份**,同樣包了一層(grep m16Acts)。 */
  function paintActs(){ paintActsRow(); M16B.placeActs(); }
  function paintActsRow(){
    const box = $("m16Acts");
    if(!box) return;
    /* ⚠ 清空但**留下宣告面板與倒數環**(v1.111.0):兩者都是持久節點 ——
       面板重建一次就重播一次進場動畫,而 paintActs() 在宣告視窗開著的那幾秒會被叫
       很多次(電腦表態、我切換吃法、ResizeObserver)。理由與呼叫規矩見 board.js 那一節。
       ★ 單機**不會有**倒數環(那是連線為了「不能讓全房等一個人」才有的),留它是為了
         與 adapter.js 的 clearActs() 語意一致 —— 而且 tools 的宣告面板截圖會塞一顆
         替身環進來(gen-mj16-solo-e2e.js 的 ?claim=…&cd=1),不留就每次都被清掉。
       ⚠ 這一支與 adapter.js 的 clearActs() 是**兩份**(grep m16Acts)。 */
    [].slice.call(box.children).forEach(function(el){
      if(!M16B.isClaim(el) && !el.classList.contains("m16-cd")) el.remove();
    });
    /* ★★ 「我自己正在決定要不要吃碰槓胡」—— 決定盤面中間那塊面板在不在。
       ⚠ 不可以無條件先 hideClaim() 再 claimPanel()(會每次重播動畫,board.js 紅線②)。 */
    const iDecide = !!(active && st && !st.over && st.claim &&
                       st.claim.elig[ME] && !st.claim.bids[ME]);
    if(!iDecide) M16B.hideClaim(box);
    if(!active || !st || st.over){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const tag = function(txt){
      const el = document.createElement("span");
      el.className = "m16-timer";
      el.textContent = txt;
      box.appendChild(el);
    };

    /* ★ 聽牌那一排(v1.66.0):**一律插**(v1.111.0 起連宣告那一格也插 ——
       當年跳過它是怕跟三顆鈕擠成兩行,而那三顆鈕已經搬到中間的面板了)。
       ⚠ 條件刻意與 st.claim **無關**,見 appendReady 的註解那條第 6 管道。 */
    appendReady(box, ME);

    /* --- 宣告視窗 --- */
    if(st.claim){
      const types = st.claim.elig[ME];
      /* ★ 沒我的事 / 我已經表態 → 一個字都不提吃碰(見檔頭那條)。
         ★★ v1.65.0:連「等其他人…」都不能寫 —— 沒有宣告視窗時這裡是「輪到 ○○…」,
           兩句話不一樣,玩家照樣看得出「電腦在考慮要不要吃我這張」。單機更致命:
           就那兩三家,等於直接報牌。改成走 turnText(dispTurn()),兩種情況的字一模一樣。
           ⚠ 與 adapter.js 的 renderActs() 是**兩份**,改一邊要看另一邊(grep dispTurn)。 */
      if(!iDecide){
        tag(st.claim.bids[ME] ? "已表態,等其他人…" : turnText(dispTurn()));
        return;
      }
      /* ★★ v1.111.0:吃 / 碰 / 槓 / 胡 / 過**跳在盤面中間**(M16B.claimPanel,與連線
         共用同一份面板)—— 使用者:「大家都反應在最下面很不明顯」。
         ⚠ 底下這一列因此與非當事人**逐字相同**(turnText),牌情那條又牢一分。 */
      tag(turnText(dispTurn()));
      const co = M16B.claimOpts();
      const cur = M16B.claimCur();
      M16B.claimPanel(box, {
        tile: st.claim.t,
        who: seatName(st.claim.from),          // 誰打的是公開資訊(牌河上就看得到)
        opts: co,
        cur: cur,
        canWin: types.indexOf("win") >= 0,
        /* ★ v1.118.1:每一組選項各一顆鈕 → 按哪一顆就送哪一組(不再是「目前那一組」)。
           ⚠ 一定要當場重新問 claimOpts():這顆鈕的 listener 活得比 co 這個閉包久
             (面板是持久節點,只有 body 會重建)。 */
        onTakeAt: function(i){
          var list = M16B.claimOpts(), o = list[i];
          if(o) humanBid(o.type, o.type === "chow" ? o.tiles : null);
        },
        onWin:  function(){ humanBid("win", null); },
        onPass: function(){ humanBid("pass", null); }
      });
      return;
    }

    /* --- 不是我的回合 --- */
    if(st.turn !== ME){ tag(turnText(st.turn)); return; }     // ★ 與宣告視窗那句一模一樣

    /* --- 我的回合 --- */
    /* ★ 宣告聽牌的選牌模式(v1.67.0):這一列只留提示與取消(理由同 adapter 那份)。 */
    if(tingPicking()){
      /* ★ 點一次先浮起來(兩段式的第一段)→ 同步顯示「打了它會聽哪張」(理由同 adapter 那份)。 */
      var pv = M16B.tingPreviewHTML ? M16B.tingPreviewHTML() : "";
      if(pv) box.insertAdjacentHTML("beforeend", pv);
      else tag("點一張亮起來的牌打出 → 宣告聽牌");
      box.appendChild(actBtn("取消", "pass", function(){ M16B.setTingPick(false); paintActs(); }));
      return;
    }
    const a = MJT.ownActions(st, ME);
    if(a.win) box.appendChild(actBtn("自摸!", "win", function(){ ownAct("win"); }));
    a.ckong.forEach(function(t){
      box.appendChild(actBtn("暗槓 " + face(t).name, "", function(){ ownAct("ckong", t); }));
    });
    a.akong.forEach(function(t){
      box.appendChild(actBtn("加槓 " + face(t).name, "", function(){ ownAct("akong", t); }));
    });
    if(MJT.canDeclareTing(st, ME))
      box.appendChild(actBtn("宣告聽牌", "ting", function(){ M16B.setTingPick(true); paintActs(); }));
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
    /* 大字與卡片配色都由 M16B.overWord() 決定(v1.70.0,與連線那份同一支)。
       ⚠ 這裡原本只 remove 不 add —— 單機的結果卡從來沒上過色,贏了輸了都是同一組
         金色漸層。連線那半是核心 mp-core 幫忙掛的,單機沒有核心,要自己掛。 */
    const ow = M16B.overWord(o, ME);
    const card = $("m16WinCard");
    if(card){ card.classList.remove("win","lose","draw"); card.classList.add(ow.tone); }

    // (v1.75.15:結果卡不再攤牌 —— 牌桌上每一家都攤開了,見 board.js 的 foeHTML)
    paintTai(last);

    let word, msg;
    if(o.type !== "win"){
      word = last ? "本場結束" : ow.word;
      /* ⚠ 句尾不要放 Unicode 麻將字元(U+1F000 那一段)。原本是「…不收付 🀫」,
         而 U+1F02B(牌背)在**桌機與手機都畫成一個空心方框** —— 看起來就是缺字的豆腐,
         使用者的回報是「流局的時候變得好奇怪」。這條規矩專案早就寫過兩次
         (styles.css 的牌面段落、js/mahjong/board.js 檔頭):那 43 個字元只有 🀄 有
         emoji 呈現,其餘一律文字呈現、各家字型畫出來的東西都不一樣。
         ★ 這裡是**散文句尾的裝飾**,拿掉就好(要放圖一律用 MJFace 自繪的牌)。 */
      // ★ 「誰奪冠」接在大字下面第一行(v1.75.15,理由與連線那份同一條)
      msg = (last ? seasonMsg() + "<br>" : "") + "牌山見底,這一局不收付";
    }else{
      const how = (o.from === null) ? "自摸" : ("胡 " + esc(seatName(o.from)) + " 打的牌");
      /* ★ v1.75.14 併成**一行**(原本「誰怎麼胡」與「底台算式」各一行)——
         誰胡誰放槍下面那張排名表已經逐列寫著,理由與連線那份同一條(adapter.js outcome)。 */
      const head = iWon ? how : (esc(seatName(o.seat)) + " " + how);
      /* ★★ 台數逐項展開 + 總台數滾動(v2.4.0)—— **與連線共用 M16Fx.taiHTML**
         (那邊是 adapter.js 的 outcome,兩份的算式措辭本來就一模一樣)。
         ⚠ fallback 留著舊的那一行:混合快取下拿不到 fx.js 的話,結果卡不可以少掉台數。 */
      const line = (typeof M16Fx !== "undefined")
        ? M16Fx.taiHTML(head, o)
        : head + " · 底 " + o.base + " + 台 " + o.tai + " = <b>" + o.total + "</b> 台(" +
          (o.list.map(function(x){ return esc(x.name)+" "+x.tai; }).join("、") || "無台") + ")";
      /* ★ 最後一局仍然是「本場結束」(單機 e2e 在斷言這句):那一張卡的主角是總結算。 */
      word = last ? "本場結束" : ow.word;
      msg = (last ? seasonMsg() + "<br>" : "") + line;
    }
    $("winWord").textContent = word;
    $("winMsg").innerHTML = msg;
    /* ★ 總台數從 0 滾上去(v2.4.0)。⚠ 一定要排在寫入 `#winMsg` **之後** ——
       它要抓的節點就在那段 HTML 裡(連線那一份是 hook,由共用層寫入,所以那邊
       靠 armTai 自己的 rAF 重試接上)。⚠ 它是冪等的:結果卡被重畫也不會從 0 再滾一次。 */
    if(typeof M16Fx !== "undefined") M16Fx.armTai();

    const again = $("m16SoloAgain");
    if(again) again.textContent = last ? "🔄 再來一場" : "下一局";
    if(iWon){ Sound.win(); burst(); }
    else if(o.type === "win") Sound.lose();
    showResult();
  }
  /* 排名表(v1.75.14 起與連線**共用** M16B.rankHTML —— 名次 / 這一局 / 累積合成一張)。
     ⚠ 單機沒有「累積勝場」那回事,wins 一律傳 null → 那一欄整個消失。
     ⚠ tai[] 在呼叫進來之前已經把這一局加好了(finish() 裡 `tai[s] += d`),
       所以這裡不必像連線那樣補「交易還沒回來」的那一份。 */
  function paintTai(last){
    const box = $("m16Tai");
    if(!box) return;
    box.classList.remove("hidden");
    const over = st && st.over;
    const dz = (over && over.type === "win" && over.deltas) || null;
    const names = [];
    for(let s=0;s<seats;s++) names.push(seatName(s));
    const rows = [];
    for(let s=0;s<seats;s++){
      rows.push({ name:names[s], me:s===ME, total:tai[s]||0,
                  delta: dz ? (dz[s]||0) : 0,
                  role: M16B.roleOf(over, s), wins:null });
    }
    box.innerHTML = M16B.rankHTML(rows, { progressText:goalProgressText(), finalText:goalFinalText(), final:last });
  }
  function seasonMsg(){
    let best = -Infinity, top = [];
    for(let s=0;s<seats;s++){
      const t = tai[s] || 0;
      if(t > best){ best = t; top = [s]; } else if(t === best) top.push(s);
    }
    const who = top.map(seatName).join("、");
    return '<span class="m16-champline">' +
           (top.indexOf(ME) >= 0 ? "🏆 你以 " : "🏆 " + esc(who) + " 以 ") +
           best + ' 台奪冠</span>';
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
    onDiscard, onTing, onFoe, humanBid,
    refreshActs: paintActs,
    // 設定面板剛把「聽牌後自動摸切」打開那一刻,順手踢一次(不必等下一手才生效)
    kickAutoTing: maybeAutoTing,
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
    base:  function(){ return base; },
    setLevel(v){ if(MJ16AI.LEVELS[v]){ level = v; saveOwn(); } },
    setSeats(v){ v=+v; if(SEATS_OK.indexOf(v)>=0){ seats = v; saveOwn(); } },
    setGoal(v){ v=+v; if(GOALS.indexOf(v)>=0){ goal = v; saveOwn(); } },
    setBase(v){ v=+v; if(BASES.indexOf(v)>=0){ base = v; saveOwn(); } }
  };
})();

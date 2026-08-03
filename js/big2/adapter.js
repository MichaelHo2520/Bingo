"use strict";

/* ============================================================================
   大老二 — 連線適配器(接上 js/shared/mp-core.js)

   ── DB 上只有兩個欄位就夠了 ──────────────────────────────────────────────
     `deal`(52 個字元的發牌)+ `moves`(一手一個字串:"-" = pass,否則 1/2/5 個字元)。
     與排七的 moves 同構(只是從整數升級成字串,因為一手可能 5 張),
     所以核心的 rev / 交易 / 斷線重建**原封不動**就能用 ——
     每台裝置各自 `B2.replay(deal, n, moves)` 算出完整局面,
     **重連歸位不必特別處理**(批次同步就是同一支 replay 多跑幾手)。

   ── ★ 手牌在 DB 是明碼,刻意不防作弊 ────────────────────────────────────
     受眾是親友聚會(見 CLAUDE.md)。同台灣麻將 / 排七,這**不是妥協而是架構優勢**:
     每台裝置都算得出「現在輪到誰、他能出什麼」,所以**到期自動出牌與結算都不必
     指定房主** —— 誰的 timer 先響誰用交易搶,房主剛好斷線也不會全桌卡死。

     代價是「算得出來」不等於「可以顯示」。這一頁只有**一條**牌情紅線:
         ★ 對手手上有什麼,結算前只能顯示張數。
     落地點在 chipTail()(晶片只給張數 / 出完給名次)與 board.js 的 resultHTML()
     (排名表,唯一翻開的地方)。已經打出去的牌是公開的,牌河照實畫。

   ── ★ 名次分:winner 要帶 pts 表 ─────────────────────────────────────────
     這一版的計分是「打到只剩一人,依名次給 5/3/1/0 並累積」。
     核心 v1.76.0 起支援 `winner.pts = {pid:分數}`(不帶就是舊的「贏家 +1」),
     所以這裡結算時要一起寫進去。
     ⚠ `winner.ids` 仍然只放**第一名** —— 大字 / 彩帶 / 卡片配色全部吃 winnerIds(),
       第三名拿了 1 分但沒有贏,不該放彩帶。

   ── ★ 決定勝負的交易一定要帶 { local:false } ─────────────────────────────
     notes/07 踩坑 #8:Firebase 交易會先在本地樂觀套用,搶最後一手時搶輸的那台會
     **先**看到「我贏」而往 scores/ 寫分數,game 回退時分數不會跟著回退。
   ========================================================================== */

const MP = MPCore.create((function(){

  const SECS = [0, 20, 40, 60];        // 出牌倒數的選項;預設值也寫在 big2.html 的 .on
  let turnSec = 40;                     // ★ 比排七長 —— 大老二一手要在 13 張裡湊組合
  let ctx = null;

  let deal = "", moves = [], st = null;
  let curRound = null;                 // ★ 新局判定一律用 roundId(不可以看 deal 變沒變)
  let lastLen = -1, turnAt = 0;        // 這一手的錨點(本地時鐘;各台差幾百毫秒無妨)
  let turnT = null;
  /* ★ 開局那一刻每個人的累積分快照(結果卡的「N 分」欄用)。
     為什麼不當場讀 scores:那個節點是**結算之後**每台各自寫自己的分,而結果卡是
     **結算當下**就要畫出來 —— 直接讀會少一筆,等分數同步回來也沒有人會重畫這張卡
     (核心的 scores 監聽只重畫它自己的 #winScores)。
     用「開局時的值 + 這局的加分」算就沒有時間差,而且重畫幾次都是同一個數(冪等)。 */
  let baseWins = {};

  const seatOf = id => ctx.order().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  const nPlayers = () => ctx.order().length;
  function nameOfSeat(s){
    const id = ctx.order()[s];
    return id ? ctx.dispName(id) : ("玩家" + (s + 1));
  }
  const secOn = () => turnSec > 0;
  const playing = () => ctx.phase() === "playing" && !ctx.winner() && !ctx.abandoned();

  /* ---------- 輪到誰 ----------
     ★ 一律問 replay 出來的 st.turn,不可以用 moves.length % n 取模 ——
       出完牌的人要跳過,而一輪結束時領出權要回到最後出牌的那個人(他若剛好出完
       就順延)。取模在有人出完之後整桌就錯位。 */
  function turnId(){
    if(!st || st.over) return null;
    return ctx.order()[st.turn] || null;
  }
  const isMyTurn = () => !!(st && !st.over && playing() && st.turn === mySeat());

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  function paint(){
    if(!st) return;
    const me = mySeat();
    if(me < 0) return;
    const mine = isMyTurn();
    const nms = [];
    for(let s = 0; s < nPlayers(); s++) nms.push(nameOfSeat(s));
    // ★ 手牌亮暗 / 有沒有牌可出:與單機那份逐字一樣(solo.js 的 paint 同一段)
    const po = mine ? B2.playable(st.hands[me], st, B2B.sel()) : null;
    B2B.render({
      hand: st.hands[me].slice(),
      slots: B2.dealCounts(nPlayers())[me],   // ★ 固定格位吃**開局張數**(見 board.js 第三節)
      trick: st.trick, names: nms, opened: st.opened,
      mine: mine,
      turnName: st.over ? "" : nameOfSeat(st.turn),
      over: !!ctx.winner() || st.over,
      hot: po ? po.cards : null,
      /* ★ 換局才變 → 盤面照它丟掉玩家自訂的手牌順序(見 board.js 第八節)。
         ⚠ 用 roundId 而不是 deal / moves.length:同消消樂那條「新局判定一律用
           roundId」,拿手牌或手數去推會把「出掉一手」誤判成新局。 */
      key: ctx.roundId()
    });
    B2B.renderActs({
      mine: mine,
      over: !!ctx.winner() || st.over,
      turnName: st.over ? "" : nameOfSeat(st.turn),
      lead: !st.cur,
      canPass: !!st.cur,
      noPlay: !!(po && !po.can),
      // ⚠ 手牌要一起傳(「還要再選幾張」靠它;與單機那份一樣)
      selInfo: mine ? B2B.selInfoOf(st, st.hands[me]) : null,
      // 環給全桌看(誰還剩幾秒是公開資訊,大家才知道為什麼卡著)
      cdMs: secOn() ? turnSec * 1000 : 0,
      cdEnd: secOn() ? turnAt + turnSec * 1000 : 0
    });
    ctx.renderPlayers();
    /* ★ 「拉」的公告(v1.81.0)—— 與單機那份**共用 board.js 的同一支**,
       所以這裡只有一行。⚠ 要放在 renderPlayers() **之後**:記號是它畫上去的,
       公告(音 + toast)排在畫面之後才不會出現「先聽到聲音、記號慢一拍」。
       ⚠ key 一律用 roundId(同 render 那個);批次同步 / 斷線重連不會亂響的理由
         在 board.js 四之二那段(laPrev === null 就只記不響)。 */
    B2B.announceLa({ st: st, names: nms, me: me, key: ctx.roundId() });
  }

  /* ==========================================================================
     二、出牌 / Pass
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對(同排七 send() / 消消樂 settleGrab 的守衛)。
     ========================================================================== */
  function send(mv){
    const step = moves.length, n = nPlayers(), me = mySeat();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
      if(list.length !== step) return false;            // 這一手已被別人推進 → 中止,等快照
      const chk = B2.replay(g.deal, n, list);
      if(!chk || chk.over || chk.turn !== me) return false;
      if(!B2.step(chk, mv)) return false;               // 伺服器真值上不合法 → 不寫
      g.moves = list.concat(mv);
    });
  }

  function tap(card){
    if(ctx.phase() !== "playing") return;
    if(ctx.winner() || ctx.abandoned()) return;
    if(!st || st.over) return;
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    // ★★ 沒亮的牌不給選,但一定說得出原因(與單機那支逐字一樣,見 solo.js 的 tap)
    const why = B2.whyNotPick(st.hands[mySeat()], st, B2B.sel(), card);
    if(why){ showToast(why, 2000); return; }
    B2B.toggleSel(card);
    paint();
  }

  function act(a){
    if(!st || st.over || !isMyTurn()){
      if(a === "clear"){ B2B.clearSel(); paint(); return; }
      if(a) showToast("還沒輪到你");
      return;
    }
    if(a === "clear"){ B2B.clearSel(); paint(); return; }
    if(a === "pass"){
      if(!st.cur){ showToast("這一輪由你開始,一定要出牌"); return; }
      send(B2.PASS);
      return;
    }
    if(a !== "play") return;
    const cs = B2B.sel();
    if(!cs.length){ showToast("先點要出的牌"); return; }
    const why = B2.whyNot(cs, st);
    if(why){ showToast(why, 2400); return; }
    send(B2.encMove(cs));
  }

  /* ⚠ v1.77.0 拿掉了「幫我挑」(單機那支也一起拿掉,見 solo.js 同一位置)。
     ★ B2.playsBeating() 留著 —— 到期代打 B2AI.autoMove() 與 AI 都靠它。 */

  /* ==========================================================================
     三、出牌倒數 —— 到期幫他出一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主:每一台都排 timer,誰先響誰用交易搶(房主剛好斷線也不會全桌卡死)。
         按座位錯開只是少幾次註定白跑的交易。
       ⚠ 下限 1200ms 兜底 —— 錨點是本地時鐘,慢半拍收到快照的那台會算出「已經過期」
         而一收到就結算(台灣麻將踩過)。
     ========================================================================== */
  function clearTurnT(){ if(turnT){ clearTimeout(turnT); turnT = null; } }

  function armTurnT(){
    clearTurnT();
    if(!secOn() || !st || st.over || !playing()) return;
    const seat = st.turn, me = mySeat();
    const wait = Math.max(1200, turnAt + turnSec * 1000 - Date.now()) + Math.max(0, me) * 150;
    turnT = setTimeout(() => { autoPlay(seat, moves.length); }, wait);
  }

  function autoPlay(seat, step){
    turnT = null;
    if(!st || st.over || st.turn !== seat || !playing()) return;
    const n = nPlayers();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
      if(list.length !== step) return false;            // 他自己出了 / 別人已經幫他出了
      const chk = B2.replay(g.deal, n, list);
      if(!chk || chk.over || chk.turn !== seat) return false;
      const mv = B2AI.autoMove(chk, seat);              // 替人代打一律用「普通」,不套難度
      if(!B2.step(chk, mv)) return false;
      g.moves = list.concat(mv);
    });
  }

  /* ==========================================================================
     四、結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數。
       ★ 一定要帶 { local:false } —— 見檔頭與 notes/07 踩坑 #8。
       ★ 交易裡拿**伺服器的 moves** 再確認一次真的結束了:本地畫面看起來結束不代表
         伺服器上結束,少了它會在還有人有牌的情況下寫下贏家、把整局提早結束。
       ★ 名次分寫進 winner.pts —— 核心會依每個人自己那一格加分(見檔頭)。
     ========================================================================== */
  function maybeSettle(){
    if(!st || !st.over || ctx.winner() || !playing()) return;
    const n = nPlayers(), ord = ctx.order();
    ctx.txGame(g => {
      if(g.winner) return false;
      const chk = B2.replay(g.deal, n, Array.isArray(g.moves) ? g.moves : []);
      if(!chk || !chk.over) return false;
      const sc = B2.score(chk);
      const pts = {};
      sc.rows.forEach(r => { const id = ord[r.seat]; if(id) pts[id] = r.pts; });
      g.winner = {
        ids: sc.winners.map(s => ord[s]).filter(Boolean),   // ★ 只放第一名
        pts: pts,                                            // ★ 名次分(核心 v1.76.0)
        by: "rank"
      };
    }, { local: false });
  }

  /* ==========================================================================
     五、mp-core 的 adapter 介面
     ========================================================================== */
  function ruleHint(){
    /* ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。
       ⚠ 「關掉就真的沒人催」那句不是贅字,是規則的後果 —— 沒有到期自動出牌,
          有人離開牌桌全桌就一直等。玩家要據此決定要不要設秒數。 */
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,時間到系統會幫他出一手")
                        : "<b>不限時</b>——沒人催,有人離開牌桌全桌會一直等";
    return "52 張全發完(除不盡時前面的座位多 1 張)。<b>每一局都由拿到 ♣︎3 的人先出,第一手一定要帶 ♣︎3</b>。<br>" +
           "可出 <b>1 張(單張)· 2 張(對子)· 5 張</b>;五張只有 <b>順子 · 葫蘆 · 鐵支 · 同花順</b>" +
           "(沒有三條單出、沒有同花、沒有兩對)。<br>" +
           "<b>同牌型才能互壓</b> —— 順子只壓順子、葫蘆只壓葫蘆;而<b>鐵支與同花順壓得過任何牌型</b>," +
           "同花順又比鐵支大。<br>" +
           "點數 <b>2 最大</b>(2>A>K>…>3),同點數比花色 ♠>♥>♦>♣。順子認 A-2-3-4-5 與 2-3-4-5-6(帶 2 的最大)。<br>" +
           "<b>出完的人退出、牌局繼續</b>,打到只剩一家有牌。名次分 <b>5 / 3 / 1</b>,最後一名 <b>0</b> 分。<br>" +
           "出牌倒數:" + sec + "。";
  }

  return {
    ns: { rooms: "big2_rooms", index: "big2_index" },
    minPlayers: 2, maxPlayers: 4,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    prefsKey: "big2.prefs.v1",
    emoteAnchor: "b2Stage",
    winCardId: "b2WinCard",
    hasResign: false,                      // 多人局「認輸」語意不清(同數獨 / 排七)
    /* ★ 名次分:一局最多發 5 分,所以單位是「分」、目標值要拉高
       (核心不帶這三個就是舊的 "勝" / 3 / 20,五個舊遊戲一個字都不受影響) */
    scoreUnit: "分", goalDefault: 15, goalMax: 60,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { turnSec: turnSec }; },
    onRoomField(k, v){
      if(k !== "turnSec") return;
      // ⚠ 守門用**範圍**而不是白名單 —— 舊房間 / 手改 DB 的值也要能用
      if(typeof v !== "number" || !(v === 0 || (v >= 10 && v <= 120)) || v === turnSec) return;
      turnSec = v;
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
      if(ctx.phase() === "playing"){ armTurnT(); paint(); }
    },
    readRoom(r){ if(typeof r.turnSec === "number") turnSec = r.turnSec; },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { deal: "", moves: [] }; },
    resetRound(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      B2B.clearSel(); B2B.stopCd();
    },
    newGame(ids, prev){
      // 座位每局重抽(先手由誰拿到 ♣3 決定,所以順序本身不影響公平,但換位置比較有感)
      const ord = ids.slice();
      for(let i = ord.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
      }
      return { order: ord, deal: B2.newDeal(), moves: [] };
    },
    applyGame(g, isPlaying){
      const next = Array.isArray(g.moves) ? g.moves : [];
      const prevLen = moves.length;
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);        // ★ 新局一律看 roundId,不可以看 deal 變沒變
      deal = g.deal || deal;
      moves = next.slice();
      if(!isPlaying){ st = null; return; }
      if(fresh){ curRound = rid; lastLen = -1; B2B.clearSel(); }

      st = B2.replay(deal, nPlayers(), moves);
      if(!st) return;                            // deal 壞掉(理論上不會)→ 等下一個快照

      /* 音效走「前後兩份的 diff」而不是在動作點插 Sound.xxx() ——
         單機與連線的動作路徑完全不同,但「有人 pass 了」在兩邊是同一個 diff。
         ⚠ 換局那一手一定要跳過(整包重來,diff 沒有意義);
         ⚠ 批次同步(重連歸位)也不連播,不然一口氣響幾十聲。 */
      if(!fresh && moves.length === prevLen + 1){
        const one = moves[moves.length - 1];
        // ★ 走 B2B.moveSfx(v1.81.1):動作聲 + pass 的「不要」語音,與單機那兩個點共用一份
        B2B.moveSfx(B2.isPass(one));
      }
      // 這一手的錨點:手數變了就重新起算(公開動作,全桌看得到)
      if(moves.length !== lastLen){
        lastLen = moves.length;
        turnAt = Date.now();
        if(isMyTurn() && !fresh) Sound.turn();
      }
      armTurnT();
      paint();
      maybeSettle();
    },

    /* ---------- 相位的專屬畫面 ----------
       各相位只說「要哪個畫面」,實際的 hidden 切換交給 main.js 的 showScreen() */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ clearTurnT(); showScreen("lobby"); },
    backToLobby(){
      clearTurnT();
      moves = []; st = null; curRound = null; lastLen = -1;
      B2B.clearSel(); B2B.stopCd();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      B2B.clearSel();
      // ★ 這一局開打前大家各幾分(結果卡的「N 分」欄要拿它加這局的分;見 outcome)
      baseWins = {};
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      paint();
    },
    onLeave(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      baseWins = {};
      B2B.clearSel(); B2B.stopCd();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const seg = $("b2SecSeg");
      if(seg){
        seg.classList.toggle("readonly", !isHost);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === turnSec));
      }
      const lbl = $("b2SecLabel");
      if(lbl) lbl.textContent = isHost ? "出牌倒數" : "出牌倒數(房主決定)";
      const hint = $("b2RuleHint");
      if(hint) hint.innerHTML = ruleHint();
    },
    updateGoal(){
      const g = $("mpBarGoal");
      if(!g) return;
      g.textContent = secOn() ? ("⏱ " + turnSec + " 秒") : "⏱ 不限時";
      g.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    turnId,
    /* 晶片尾巴:★★ 牌情紅線的落地點 —— 對手只給**張數**,牌值要等結算。
       出完的人改顯示名次(那是公開資訊:大家都看到他打完了)。 */
    chipTail(id){
      if(!st) return "";
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return "";
      const fin = st.finished.indexOf(s);
      if(!st.hands[s].length && fin >= 0)
        return '<span class="b2-chf" title="已經出完">第 ' + (fin + 1) + ' 名</span>';
      /* ★ 「拉」= 剩最後一手(v1.81.0)。判斷 B2.isLast、記號 B2B.laChipHTML ——
         單機的 paintBar() 吃的是**同兩支**(這一頁那組雙胞胎只差「去哪裡拿座位」)。
         ⚠ 這是牌情紅線唯一的第二個豁免點:只公開「他剩最後一手」**一個 bit**,
           牌型 / 牌值一律不准(理由與範圍寫在 board.js 四之二)。 */
      return B2B.laChipHTML(B2.isLast(st.hands[s]), s === mySeat()) +
             '<span class="b2-chn" title="手上剩幾張"><i class="b2-pip"></i>' + st.hands[s].length + '</span>';
    },
    lobbyStatusText(ids){ return ids.length < 2 ? "等待其他人加入…" : "等待大家準備…"; },
    readyHint(ids, ready){
      return ids.length < 2 ? "等別人加入…(房間可分享給朋友)"
                            : (ready ? "等其他人按準備…" : "按「準備好了」就開始");
    },
    refresh(){ if(st) paint(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, ids }){
      clearTurnT();
      B2B.stopCd();
      const me = mySeat();
      const sc = (st && st.over) ? B2.score(st) : null;
      const row = sc ? sc.rows[me] : null;
      const box = $("b2Result");
      if(box && st && st.over){
        const ord = ctx.order();
        const names = ord.map(id => ctx.dispName(id));
        /* ★ 累積分併進排名表 —— 連線的結果卡從此只有**一張表**
           (共用連線層的 #winScores 那些列由 CSS 收掉,只留「🎯 搶 N 分」)。
           ⚠ 這局各加幾分直接讀 winner.pts(核心就是照它加的),底數用開局快照,
             所以不必等 scores 節點同步回來。 */
        const pts = (w && w.pts) || {};
        const wins = ord.map(id => {
          const add = (typeof pts[id] === "number") ? pts[id] : ((ids || []).indexOf(id) >= 0 ? 1 : 0);
          const base = (typeof baseWins[id] === "number") ? baseWins[id] : ctx.scoreOf(id);
          return { n: base + add, plus: add };
        });
        box.innerHTML = B2B.resultHTML(st, names, me, "", wins);
        box.classList.remove("hidden");
      }
      paint();
      /* ★ 一句話(照排七 v1.75.3 的結論):底下的排名表已經逐列寫著
         「誰第幾名 / 剩幾張 / 幾分」,這一句只負責「這局誰第一、我幾分」。
         ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。
         ⚠ 措辭與單機那份(solo.js 的 finish())刻意寫成同一個格式。 */
      if(iWon){
        return { word: "你贏了!",
                 msg: row ? ("你第一個出完 · 名次分 <b>" + row.pts + "</b> 🎉") : "你第一個出完 🎉" };
      }
      const ws = (w && w.ids || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: row ? ("第 " + row.rank + " 名") : "這局結束",
               msg: (ws ? (ws + " 第一個出完") : "這局結束") +
                    (row ? (" · 你 <b>" + row.pts + "</b> 分" +
                            (row.left ? ("(手上還剩 " + row.left + " 張)") : "")) : "") };
    },

    /* ---------- 偏好 ---------- */
    ownPrefs(){ return { turnSec: turnSec }; },
    usePrefs(o){
      if(typeof o.turnSec === "number" && (o.turnSec === 0 || (o.turnSec >= 10 && o.turnSec <= 120))) turnSec = o.turnSec;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      tap, act, isMyTurn,
      turnSec: () => turnSec,
      setTurnSec(v){
        if(SECS.indexOf(v) < 0) return;
        if(!ctx.setRoomField("turnSec", v, { lobbyOnly: true, denyMsg: "只有房主能改倒數", busyMsg: "對戰中不能改倒數" })) return;
        turnSec = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      /* 給 e2e 用:把這一手的錨點往回撥,免得測「到期自動出牌」要真的等 40 秒。
         同排七的 MP._ageTurn / 消消樂的 MP.stallAge —— 那類機制只有時間會觸發。 */
      _ageTurn(ms){ turnAt -= (+ms || 0); armTurnT(); paint(); }
    }
  };
})());

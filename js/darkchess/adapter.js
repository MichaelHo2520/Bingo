"use strict";

/* ============================================================================
   象棋暗棋 — 連線適配器(接上 js/shared/mp-core.js)

   ── DB 上只有三個欄位 ────────────────────────────────────────────────────
     `deal`(32 字元 = 一格一個棋子)+ `moves`(一手一個字串)+ `rules`(開局凍結的房規)。
     與排七 / 大老二 / UNO 的 moves 同構,所以核心的 rev / 交易 / 斷線重建**原封不動** ——
     每台裝置各自 `DC.replay(deal, moves, rules)` 算出完整局面,
     **重連歸位不必特別處理**(批次同步就是同一支 replay 多跑幾手)。

   ── ★★ 連吃 = 回合停在同一個人身上 ──────────────────────────────────────
     一手一個 move,但「吃完還吃得到」時 `st.turn` **不換人**(見 rules.js 檔頭)。
     落到這一支只有一個要求:**turn 一律問 `st.turn`,絕不可以用 `moves.length % 2`**
     —— 連吃會讓步數與座位脫鉤,而症狀是「對手忽然多走一步」。

   ── ★ 暗棋在 DB 是明碼,刻意不防作弊 ────────────────────────────────────
     受眾是親友聚會(見 CLAUDE.md)。同大老二 / 排七 / UNO,這**不是妥協而是架構優勢**:
     每台裝置都算得出「現在輪到誰、他能走什麼」,所以**到期自動走一手與結算都不必
     指定房主** —— 誰的 timer 先響誰用交易搶,房主剛好斷線也不會全桌卡死。

     代價是「算得出來」不等於「可以顯示」。這一頁只有**一條**牌情紅線:
         ★ 暗棋底下是什麼,翻開之前畫面上一個字都不准出現。
     落地點在 js/darkchess/board.js 的 renderCell(暗格只畫牌背);
     這一支的 chipTail 只給**盤上還剩幾顆**,而那是公開資訊
     (= 16 − 被吃掉的顆數,被吃掉的一定都現過身)。

   ── ★ 決定勝負的交易一定要帶 { local:false } ─────────────────────────────
     notes/07 踩坑 #8:Firebase 交易會先在本地樂觀套用,搶最後一手時搶輸的那台會
     **先**看到「我贏」而往 scores/ 寫分數,game 回退時分數不會跟著回退。
   ========================================================================== */

const MP = MPCore.create((function(){

  const SECS = [0, 20, 40, 60];        // 走一手的倒數;預設值也寫在 darkchess.html 的 .on
  let turnSec = 40;                     // ★ 比 UNO 長 —— 暗棋一手要看整個盤面
  let ctx = null;

  /* ★★★ 房規 —— **兩份**,而它們刻意不一樣:
       rules   房間欄位 `dcRules`(房主現在設定的那一份 → **下一局**才生效)
       gRules  這一局**開局那一刻凍結**的那一份(`game.rules`,真相層要用的就是它)
     ⚠⚠ 理由與大老二 / 21點 / UNO 逐字相同:房規改了不可以讓**已經在打的這一局**
       重算出不同結果(症狀是「重連的人算出來的局面跟現場不一樣」)。
     ⚠⚠ 交易裡(send / autoPlay / maybeSettle)**一律用 `g.rules`,不是 gRules**。 */
  let rules = DC.defRules();
  let gRules = DC.defRules();

  let deal = "", moves = [], st = null;
  let curRound = null;                 // ★ 新局判定一律用 roundId(不可以看 deal 變沒變)
  let lastLen = -1, turnAt = 0;
  let turnT = null;
  let baseWins = {};                   // 開局那一刻兩個人的累積分(結果卡的「勝」欄用)

  const seatOf = id => ctx.order().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  function nameOfSeat(s){
    const id = ctx.order()[s];
    return id ? ctx.dispName(id) : ("玩家" + (s + 1));
  }
  const secOn = () => turnSec > 0;
  const playing = () => ctx.phase() === "playing" && !ctx.winner() && !ctx.abandoned();

  /* ---------- 輪到誰 ----------
     ★ 一律問 replay 出來的 st.turn —— 連吃會讓步數與座位脫鉤。 */
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
    DCB.setState({
      st: st,
      mySide: st.col[me],
      mine: isMyTurn(),
      over: !!ctx.winner() || st.over,
      key: moves.length,
      turnName: st.over ? "" : nameOfSeat(st.turn),
      // 倒數環給雙方都看得到(誰還剩幾秒是公開資訊,對手才知道為什麼卡著)
      cdEnd: (secOn() && !st.over) ? (turnAt + turnSec * 1000) : 0
    });
    ctx.renderPlayers();
  }

  /* ==========================================================================
     二、走一手
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對(同大老二 send() / UNO send() 的守衛)。
     ========================================================================== */
  function send(mv){
    const step = moves.length, me = mySeat();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
      if(list.length !== step) return false;             // 這一手已被推進 → 中止,等快照
      const chk = DC.replay(g.deal, list, g.rules);       // ⚠ 用**伺服器上凍結的**房規
      if(!chk || chk.over) return false;
      if(chk.turn !== me) return false;
      if(!DC.step(chk, mv)) return false;                 // 伺服器真值上不合法 → 不寫
      g.moves = list.concat(mv);
    });
  }

  // 由 DCB 的點擊流程送進來(合法性 DCB 已經先問過 rules 了,這裡只擋相位)
  function act(mv){
    if(ctx.phase() !== "playing") return;
    if(ctx.winner() || ctx.abandoned()) return;
    if(!st || st.over) return;
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    send(mv);
  }

  /* ==========================================================================
     三、走棋倒數 —— 到期幫他走一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主:兩台都排 timer,誰先響誰用交易搶(房主剛好斷線也不會卡死)。
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
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
      if(list.length !== step) return false;             // 他自己走了 / 對手已經幫他走了
      const chk = DC.replay(g.deal, list, g.rules);
      if(!chk || chk.over || chk.turn !== seat) return false;
      const mv = DCAI.autoMove(chk, seat);                // 替人代打一律用「普通」,不套難度
      if(mv === null || !DC.step(chk, mv)) return false;
      g.moves = list.concat(mv);
    });
  }

  /* ==========================================================================
     四、結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數。
       ★ 一定要帶 { local:false } —— 見檔頭與 notes/07 踩坑 #8。
       ★ 和局(兩邊階級總和一樣)→ ids 放**兩個人**:核心的 isDraw 看 by,
         而 winnerIds() 決定誰加分 → 兩個人各得 1 勝,與畫面講的話一致。
     ========================================================================== */
  function maybeSettle(){
    if(!st || !st.over || ctx.winner() || !playing()) return;
    const ord = ctx.order();
    ctx.txGame(g => {
      if(g.winner) return false;
      const chk = DC.replay(g.deal, Array.isArray(g.moves) ? g.moves : [], g.rules);
      if(!chk || !chk.over) return false;
      if(chk.winner < 0){
        g.winner = { ids: ord.slice(), by: "draw" };
        return;
      }
      const id = ord[chk.winner];
      g.winner = { ids: id ? [id] : [], by: chk.endBy || "win" };
    }, { local: false });
  }

  /* ==========================================================================
     五、mp-core 的 adapter 介面
     ========================================================================== */
  function ruleHint(){
    /* ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。 */
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,時間到系統會幫他走一手")
                        : "<b>不限時</b>——沒人催,有人離開棋盤會一直等";
    return "32 顆象棋<b>蓋著擺滿 4×8</b>。輪流<b>翻一顆</b>或<b>動一顆自己的明棋</b>(上下左右一格);" +
           "<b>先手第一次翻到的顏色就是他的</b>。<br>" +
           "大小 <b>將 &gt; 士 &gt; 象 &gt; 車 &gt; 馬 &gt; 包 &gt; 卒</b>,大吃小、同級可吃," +
           "而且<b>卒吃得了將、將吃不了卒</b>。<br>" +
           "<b>炮不能貼身吃</b> —— 要沿直線隔<b>恰好一顆</b>子跳過去,距離不限、不受階級限制," +
           "<b>連暗棋都打得到</b>(打到自己的算自己倒楣)。<br>" +
           "<b>" + esc(DC.rulesText(rules)) + "</b>(房主可改)。<br>" +
           "把對方吃光、或讓對方<b>無子可動也無暗棋可翻</b>就贏;" +
           "連續 <b>" + DC.IDLE_DRAW + " 步</b>沒吃沒翻就<b>比剩下棋子的階級總和</b>。<br>" +
           "走棋倒數:" + sec + "。";
  }

  return {
    ns: { rooms: "dc_rooms", index: "dc_index" },
    minPlayers: 2, maxPlayers: 2,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    prefsKey: "darkchess.prefs.v1",
    emoteAnchor: "dcStage",
    winCardId: "dcWinCard",
    /* 認輸刻意不做:暗棋一局本來就有「悶到 40 步比階級總和」當出口,
       而走棋倒數會幫掛機的人走完 —— 再加一顆認輸鈕只是多一個誤按的地方。 */
    hasResign: false,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { turnSec: turnSec, dcRules: DC.normRules(rules) }; },
    onRoomField(k, v){
      if(k === "dcRules"){
        const next = DC.normRules(v);
        /* ⚠⚠ 這個「有沒有真的變」的比對是**逐欄位**寫的,而房規有四項 ——
           加房規忘了補這裡的症狀是「房主按了那一項,對手的畫面完全不動」
           (寫進 DB 了,但這裡當成沒變就 return 掉)。同一份比對在下面 setRule 也有一份。 */
        if(next.chain === rules.chain && next.chainDark === rules.chainDark &&
           next.rush === rules.rush && next.rushBig === rules.rushBig) return;
        rules = next;
        ctx.unreadyOnFieldChange();
        ctx.syncSetup(); ctx.updateGoal();
        return;
      }
      if(k !== "turnSec") return;
      // ⚠ 守門用**範圍**而不是白名單 —— 舊房間 / 手改 DB 的值也要能用
      if(typeof v !== "number" || !(v === 0 || (v >= 10 && v <= 180)) || v === turnSec) return;
      turnSec = v;
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
      if(ctx.phase() === "playing"){ armTurnT(); paint(); }
    },
    readRoom(r){
      if(typeof r.turnSec === "number") turnSec = r.turnSec;
      if(r && r.dcRules) rules = DC.normRules(r.dcRules);   // ⚠ 舊房間沒有 → 維持預設
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { deal: "", moves: [], rules: DC.normRules(rules) }; },
    resetRound(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      DCB.reset();
    },
    newGame(ids){
      /* 座位每局重抽:先手是 0 號座位,而**先手決定自己要什麼顏色**(第一次翻到什麼就是什麼)
         —— 那是這個遊戲唯一的先手權,不換位置就永遠是同一個人拿。 */
      const ord = ids.slice();
      if(Math.random() < 0.5){ const t = ord[0]; ord[0] = ord[1]; ord[1] = t; }
      /* ★★★ 房規在**這一刻**凍進 game.rules —— 之後房間欄位怎麼改都不影響這一局。 */
      return { order: ord, deal: DC.newDeal(), moves: [], rules: DC.normRules(rules) };
    },
    applyGame(g, isPlaying){
      const next = Array.isArray(g.moves) ? g.moves : [];
      const prevLen = moves.length;
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);        // ★ 新局一律看 roundId
      deal = g.deal || deal;
      moves = next.slice();
      if(!isPlaying){ st = null; return; }
      if(fresh){ curRound = rid; lastLen = -1; DCB.reset(); }

      /* ★ 讀**這一局凍結的**那一份(不是房間欄位)。
         ⚠ 照 deal 那一行的模式用「有才蓋掉」:某一次快照少了這個欄位時,
           寧可沿用上一次讀到的,也不要靜靜地退回預設房規(那會讓整局重算)。 */
      if(g.rules) gRules = DC.normRules(g.rules);
      st = DC.replay(deal, moves, gRules);
      if(!st) return;                            // deal 壞掉(理論上不會)→ 等下一個快照

      /* 音效走「前後兩份的 diff」而不是在動作點插 sfx.xxx() ——
         單機與連線的動作路徑完全不同,但「有人吃了一顆」在兩邊是同一個 diff。
         ⚠ 換局那一手一定要跳過(整包重來,diff 沒有意義);
         ⚠ 批次同步(重連歸位)也不連播,不然一口氣響幾十聲。 */
      if(!fresh && moves.length === prevLen + 1) DCB.moveSfx(st);

      // 這一手的錨點:手數變了就重新起算(公開動作,雙方看得到)
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
      DCB.reset();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      // ★ 這一局開打前兩個人各幾勝(結果卡的「勝」欄要拿它加這局的分;見 outcome)
      baseWins = {};
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      paint();
    },
    onLeave(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1; baseWins = {};
      DCB.reset();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const seg = $("dcSecSeg");
      if(seg){
        seg.classList.toggle("readonly", !isHost);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === turnSec));
      }
      const lbl = $("dcSecLabel");
      if(lbl) lbl.textContent = isHost ? "走棋倒數" : "走棋倒數(房主決定)";
      const rl = $("dcRulesLabel");
      if(rl) rl.textContent = isHost ? "房規" : "房規(房主決定)";
      /* ⚠ 面板**開著**的時候也要跟著同步 —— 房主改了規則,對手那台是靠這裡刷新的
         (漏掉的症狀是「對手的面板停在舊規則,而大廳摘要已經換了」)。 */
      if(typeof syncRules === "function" && $("dcRulesVeil") &&
         $("dcRulesVeil").classList.contains("show")) syncRules(rules, isHost);
      const hint = $("dcRuleHint");
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
    /* 晶片尾巴:顏色 + 盤上還剩幾顆。
       ★ 剩幾顆是**公開資訊**(= 16 − 被吃掉的顆數,而被吃掉的一定都現過身),
         不違反「暗棋底下是什麼不准出現」那條紅線。 */
    chipTail(id){
      if(!st) return "";
      const s = seatOf(id);
      if(s < 0 || s > 1) return "";
      const side = st.col[s];
      return (side >= 0 ? ('<span class="dc-chip-side ' + (side === DC.RED ? "dc-red-t" : "dc-blk-t") + '">' +
                           DC.sideName(side) + "</span>") : "") +
             '<span class="dc-chip-n" title="盤上還剩幾顆">' +
             (side >= 0 ? DC.countSide(st, side) : 16) + "</span>";
    },
    lobbyStatusText(ids){ return ids.length < 2 ? "等待對手加入…" : "等待雙方準備…"; },
    readyHint(ids, ready){
      return ids.length < 2 ? "等對手加入…(房間可分享給朋友)"
                            : (ready ? "等對手按準備…" : "按「準備好了」就開始");
    },
    refresh(){ if(st) paint(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, isDraw, ids }){
      clearTurnT();
      DCB.stopCd();
      const me = mySeat();
      const box = $("dcResult");
      if(box && st && st.over){
        const ord = ctx.order();
        const names = ord.map(id => ctx.dispName(id));
        /* ⚠ 這局各加幾分直接讀 winnerIds(核心就是照它加的),底數用開局快照,
           所以不必等 scores 節點同步回來。 */
        const wins = ord.map(id => {
          const add = ((ids || []).indexOf(id) >= 0) ? 1 : 0;
          const base = (typeof baseWins[id] === "number") ? baseWins[id] : ctx.scoreOf(id);
          return { n: base + add, plus: add };
        });
        box.innerHTML = DCB.resultHTML(st, names, me, wins);
        box.classList.remove("hidden");
      }
      paint();
      /* ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。
         ⚠ 措辭與單機那份(solo.js 的 finish())刻意寫成同一個格式。 */
      const how = (st && st.over) ? DCB.endText(st) : "";
      if(isDraw) return { word: "平手!", msg: esc(how) + " —— 兩邊各得 1 勝 🤝" };
      if(iWon)   return { word: "你贏了!", msg: esc(how) + " 🎉" };
      const ws = (w && w.ids || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: "你輸了", msg: (ws ? (ws + " 贏了 —— ") : "") + esc(how) };
    },

    /* ---------- 偏好 ---------- */
    ownPrefs(){ return { turnSec: turnSec, dcRules: DC.normRules(rules) }; },
    usePrefs(o){
      if(typeof o.turnSec === "number" && (o.turnSec === 0 || (o.turnSec >= 10 && o.turnSec <= 180))) turnSec = o.turnSec;
      /* ★ 我上次當房主設的房規 → 下次建房自動帶回來(同 turnSec)。
         ⚠ 一律 normRules:那份 JSON 住在 localStorage,版本一換就可能有認不出的值。 */
      if(o.dcRules) rules = DC.normRules(o.dcRules);
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      act, isMyTurn,
      /* ---------- 房規:面板是單機連線共用的,分流點在 main.js ----------
         ⚠ `rules()` 回**房間欄位**那一份(下一局生效);這一局的真相在 `st.rules`。
         ⚠ 寫入走 ctx.setRoomField(整包一個欄位)—— lobbyOnly:對戰中不給改。 */
      rules: () => DC.normRules(rules),
      liveRules: () => DC.normRules(ctx.phase() === "playing" ? gRules : rules),
      setRule(key, val){
        const next = DC.normRules(Object.assign({}, rules, { [key]: val }));
        // ⚠ 四項都要比(見 onRoomField 那一份的說明)—— 漏一項 = 那一項按了沒反應
        if(next.chain === rules.chain && next.chainDark === rules.chainDark &&
           next.rush === rules.rush && next.rushBig === rules.rushBig) return;
        if(!ctx.setRoomField("dcRules", next, { lobbyOnly: true,
             denyMsg: "只有房主能改規則", busyMsg: "對戰中不能改規則 —— 這一局的規則已經定下來了" })) return;
        rules = next; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      /* ★ 關掉房規面板之後把大廳那行摘要重畫。走 adapter 自己開一支、**不動共用層**
         —— 核心的 API 沒有這一項,而為了一行摘要去改 js/shared/ 要付
         「九個遊戲全部回歸」的代價(CLAUDE.md 紅線 3)。 */
      refreshSetup(){ ctx.syncSetup(); },
      turnSec: () => turnSec,
      setTurnSec(v){
        if(SECS.indexOf(v) < 0) return;
        if(!ctx.setRoomField("turnSec", v, { lobbyOnly: true, denyMsg: "只有房主能改倒數", busyMsg: "對戰中不能改倒數" })) return;
        turnSec = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      // 給 e2e 用:把這一手的錨點往回撥,免得測「到期自動走棋」要真的等 40 秒
      _ageTurn(ms){ turnAt -= (+ms || 0); armTurnT(); paint(); }
    }
  };
})());

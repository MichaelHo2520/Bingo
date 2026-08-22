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

  /* ★★ 棋子樣式(v1.151.0 加,v1.152.0 改成**房主決定全房**)——
       使用者:「目前設計的是只有自己能看到選擇的樣子,我想要的是房主來設計選擇大家看到的樣子」。
     ⚠⚠⚠ 它走的是**房間欄位** `dcSkin`(與 `turnSec` 同構),**不是房規物件** `dcRules`:
       房規會在開局那一刻凍結進 `game.rules`(因為它影響判定),棋子樣式凍結了反而變成
       「對局中改了不生效」。所以它跟 turnSec 一樣是獨立欄位、不凍結。
     ⚠⚠ 兩件事刻意與 turnSec **不一樣**:
       ① **不帶 `lobbyOnly`** → 對局中也改得動(純視覺,而且現場最想換的時機正是玩到一半);
       ② **不叫 `unreadyOnFieldChange()`** → 不把大家的「準備好了」退回去
          (那是給「會改變開打條件」的設定用的,拿來管配色只會很煩)。
     ★ 兩份值,不是一份:
       skin      = **我自己的偏好** —— 單機用它、建房時把它帶進房間、離開房間回到它
       roomSkin  = **這間房現在的值** —— 連線時看的是這一份(房主寫、所有人讀)
       ⚠ 併成一份會有這個症狀:離開房間之後,我的偏好被房主設的那一套蓋掉了。
     ⚠ 這份陣列是**白名單**,usePrefs / readRoom / onRoomField 三處一律拿它擋:
       放行認不出的值,body 上就會掛一個沒有規則的 class → 棋子退回 fallback,
       症狀是「選了烏木卻還是原木」,而且不報錯。
     ⚠⚠ 值要與三件事一字不差:styles.css 的 .dcs-* 三條、darkchess.html 的 data-skin、
       以及 main.js 的 applySkin()。四處是同一組字串。 */
  const SKINS = ["plain", "carved", "ebony"];
  let skin = "carved";                  // 預設 = v1.150 那版(使用者現在看到的樣子)
  let roomSkin = "carved";              // 這間房現在的值(連線時才看它)

  /* ★★★ 房規 —— **兩份**,而它們刻意不一樣:
       rules   房間欄位 `dcRules`(房主現在設定的那一份 → **下一局**才生效)
       gRules  這一局**開局那一刻凍結**的那一份(`game.rules`,真相層要用的就是它)
     ⚠⚠ 理由與大老二 / 21點 / UNO 逐字相同:房規改了不可以讓**已經在打的這一局**
       重算出不同結果(症狀是「重連的人算出來的局面跟現場不一樣」)。
     ⚠⚠ 交易裡(send / autoPlay / maybeSettle)**一律用 `g.rules`,不是 gRules**。 */
  let rules = DC.defRules();
  let gRules = DC.defRules();

  /* 「這份房規跟現在這份一不一樣」。★ **照 defRules() 的欄位一路比過去**,不逐項手寫 ——
     v1.115.0 之前這個比對在 onRoomField 與 setRules 各手寫一份四個欄位,
     加一條房規忘了補的症狀是「房主按了那一項,對手的畫面完全不動」
     (值寫進 DB 了,但這裡當成沒變就 return 掉,而且**兩邊都不會報錯**)。 */
  function sameRules(a, b){
    const x = DC.normRules(a), y = DC.normRules(b);
    return Object.keys(DC.defRules()).every(k => x[k] === y[k]);
  }

  let deal = "", moves = [], st = null;
  let curRound = null;                 // ★ 新局判定一律用 roundId(不可以看 deal 變沒變)
  let lastLen = -1, turnAt = 0;
  let turnT = null;
  let baseWins = {};                   // 開局那一刻兩個人的累積分(結果卡的「勝」欄用)

  const seatOf = id => ctx.order().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  /* ⚠ v1.146.0 刪掉了 nameOfSeat():它只給「輪到 ○○○」那一行用,而那一行拿掉了
     (輪到誰由玩家晶片的 .turn 高亮講)。要顯示對手名字請走 ctx.dispName(id)。 */
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
  /* ⚠⚠⚠ **renderPlayers() 一定要在 DCB.setState() 之前** —— 理由與 solo.js 的 paint()
     逐字相同:setState 會量舞台高度算格子(fitBoard),而玩家晶片列會把上面那條列
     撐高一截;順序反過來就是「開局第一拍盤面溢出舞台」,再靠 ResizeObserver 補救,
     而那個補救是會漏的。**量尺寸的那一步一律放最後。** */
  function paint(){
    if(!st) return;
    const me = mySeat();
    if(me < 0) return;
    ctx.renderPlayers();
    DCB.setState({
      st: st,
      mySide: st.col[me],
      mine: isMyTurn(),
      over: !!ctx.winner() || st.over,
      key: moves.length,
      // ★ 吃子欄要知道「哪個座位是我」與兩個座位各叫什麼(見 board.js 的 setState)
      mySeat: me,
      names: ctx.order().map(id => ctx.dispName(id)),
      // 倒數環給雙方都看得到(誰還剩幾秒是公開資訊,對手才知道為什麼卡著)
      cdMs: secOn() ? turnSec * 1000 : 0,
      cdEnd: (secOn() && !st.over) ? (turnAt + turnSec * 1000) : 0,
      /* ★★ 棋譜回放(v2.7.1)要的整局真相 —— st 身上只有局面,沒有 deal / moves。
         ⚠ 一定要用**這一局凍結的** gRules(不是房間欄位 rules):回放要重跑的是
           這一局真正在用的那份規則,拿下一局的房規去 replay 會算出不一樣的局面。
         ⚠ 這一行與 solo.js 的 paint() 是**同一對雙胞胎**(紅線 12 那一組)—— 改一邊記得改另一邊。 */
      src: { deal: deal, moves: moves, rules: gRules }
    });
  }

  /* ==========================================================================
     二、走一手
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對。

     ⚠⚠⚠ v1.121.x 修 bug:**刻意不做 `list.length !== step` 那道「這一手已被推進」
       守衛**(大老二 / UNO 的 send() 有這一條,這裡拿掉了)。理由跟下面 resign() 的
       ②一樣:那道守衛防的是「世界已經變了,我這一手的前提不成立」,但連吃時同一個人
       會在**自己的回合裡**連續送出好幾手 —— 每一手都還沒等到上一手的快照回來、
       本地 `moves.length` 就已經跟伺服器脫鉤,守衛會把這些完全合法的連續攻擊**靜靜擋掉**
       (使用者回報:「連吃了好幾個然後停下來,結果對方那邊卻是我還沒吃之前,卡住了」——
       連最後那聲「結束連吃」都被同一道守衛擋下,回合永遠留在我這邊)。
       ⚠ 真正需要的保護一項都沒少:`chk.turn !== me` 擋得住「輪到誰」,
       `DC.step(chk, mv)` 用**伺服器上最新的真值**重驗一次合法性 —— 連吃的每一手都是
       座標式的(吃哪一格),不是索引式的,伺服器真值一驗就知道這一手還算不算數,
       不需要額外比對「手數對不對」。 */
  function send(mv){
    const me = mySeat();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
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

  /* 投降。★ 刻意**不走 send()**,兩處不一樣:
       ① 不檢查輪到誰 —— 投降不必等自己的回合(move 自己帶座位,見 DC.encResign)
       ② 不檢查 `list.length !== step` —— 那道守衛是為了「這一手已經被推進」而設的,
          但投降與別人走到第幾手無關;帶著它的話對手剛好同時落子就會把投降靜靜吃掉,
          使用者看到的是「按了沒反應」。
     ⚠ 這一筆**不必** { local:false }:它寫的是 moves 不是 winner,勝負仍然由
       maybeSettle() 從 replay 算出來(那一支才是帶 local:false 的那個)。 */
  function resign(){
    const me = mySeat();
    if(me < 0) return;
    if(ctx.phase() !== "playing" || ctx.winner() || ctx.abandoned()) return;
    if(!st || st.over) return;
    const mv = DC.encResign(me);
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
      const chk = DC.replay(g.deal, list, g.rules);
      if(!chk || chk.over) return false;
      if(!DC.step(chk, mv)) return false;
      g.moves = list.concat(mv);
    });
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
    /* ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。
       ★ 文案規格與進場說明一致:條列、標籤在前、一行一件事。 */
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,逾時由系統代走一手")
                        : "<b>不限時</b>,有人離開棋盤會一直等";
    return "<b>盤面</b>:象棋 32 顆蓋著擺滿 4×8。<br>" +
           "<b>回合</b>:翻開一顆暗棋,或移動一顆自己的明棋(上下左右一格)。<br>" +
           "<b>分邊</b>:先手翻出的第一顆是什麼顏色,先手就是那一方。<br>" +
           "<b>階級</b>:將 &gt; 士 &gt; 象 &gt; 車 &gt; 馬 &gt; 包 &gt; 卒,大吃小、同級可吃;" +
           "例外只有一組 —— 卒吃將,將不吃卒。<br>" +
           "<b>炮</b>:不能吃相鄰的子,沿直線隔恰好一顆子跳過去吃,不受階級限制,暗棋也打得到。<br>" +
           "<b>勝負</b>:吃光對方的子,或對方無子可動也無暗棋可翻;" +
           "連續 " + DC.IDLE_DRAW + " 步沒吃沒翻,改比剩餘棋子的階級總和。<br>" +
           "<b>房規</b>:" + esc(DC.rulesText(rules)) + "(房主設定)。<br>" +
           "<b>走棋倒數</b>:" + sec + "。";
  }

  return {
    ns: { rooms: "dc_rooms", index: "dc_index" },
    minPlayers: 2, maxPlayers: 2,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    /* ★★ 原班人馬可以回座(誤按離開 / 關分頁 / 斷線之後回到**還在打的那一場**)。
       ⚠⚠ 它**不是** joinMidGame:放行的只有 `game.order` 裡本來就有的那個 pid
         (全新的人照舊擋在外面)—— 完整的理由在 js/shared/mp-core.js 的 REJOIN_MID 那一段。
       ★ 2 人局(同五子棋),而且 turn 不取模 → 座位表凍結,回來直接接上。 */
    rejoinMidGame: true,
    prefsKey: "darkchess.prefs.v1",
    emoteAnchor: "dcStage",
    winCardId: "dcWinCard",
    /* 認輸刻意不做:暗棋一局本來就有「悶到 40 步比階級總和」當出口,
       而走棋倒數會幫掛機的人走完 —— 再加一顆認輸鈕只是多一個誤按的地方。 */
    hasResign: false,
    /* ★★ 誰先翻讓玩家選(v1.144.0;核心的第六個能力旗標)——
       暗棋的先手權很實在(先手第一次翻到什麼顏色就是他的),偷偷 50/50 抽掉太可惜。
       落地見 js/shared/mp-order.js(蓋板 + 猜拳判定)與 darkchess.html 的 #mpOrderRow;
       決定出來的順序從 newGame() 的第三個參數進來。 */
    orderPick: true,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    /* ⚠ 建房時把**我自己的偏好**帶進房間(同 turnSec 的做法)—— 房主上次選什麼,
       開新房就是那一套,不必每開一間都重選。 */
    roomFields(){ return { turnSec: turnSec, dcRules: DC.normRules(rules), dcSkin: skin }; },
    onRoomField(k, v){
      /* 棋子樣式:純視覺 → **不**叫 unreadyOnFieldChange()、也**不**碰 phase。
         ⚠ 要叫 applySkin()(main.js)把 body 的 class 換掉 —— 只改變數的話,
           房主改了以後訪客這邊「面板選中的那張卡跳了、但棋子沒變」。
         ⚠ 不必重畫盤面:樣式全在 CSS,換 class 當下所有棋子(含已經畫好的)一起變。 */
      if(k === "dcSkin"){
        if(SKINS.indexOf(v) < 0 || v === roomSkin) return;
        roomSkin = v;
        applySkin(); syncSkinUI();
        return;
      }
      if(k === "dcRules"){
        const next = DC.normRules(v);
        if(sameRules(next, rules)) return;
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
      /* ★ 加入房間時就看房主那一套。⚠ 舊房間沒有 dcSkin → 退回**我自己的偏好**
         (不是硬寫 "carved":那會讓「進了一間舊房」看起來像「我的選擇被吃掉了」)。
         ⚠⚠⚠ 這裡**只存值,不可以順手叫 applySkin()** —— 第一版叫了,而它**完全無效**:
           readRoom 跑的時候 `MP.isOnline()` 還是 false,`dcSkinNow()` 於是回**本機偏好**,
           等於用我自己的那一套蓋一次。真正把房主那一套套上去的是隨後的
           `showScreen("lobby")`(main.js 那一行 applySkin)。
           ⚠ 那一版「看起來對」而且測試全綠 —— 因為 showScreen 把它救回來了;
             是突變測試(把 showScreen 那行拿掉)才照出這一支是空的。 */
      roomSkin = (r && SKINS.indexOf(r.dcSkin) >= 0) ? r.dcSkin : skin;
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { deal: "", moves: [], rules: DC.normRules(rules) }; },
    resetRound(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      DCB.reset();
    },
    newGame(ids, prev, picked){
      /* 座位每局重抽:先手是 0 號座位,而**先手決定自己要什麼顏色**(第一次翻到什麼就是什麼)
         —— 那是這個遊戲唯一的先手權,不換位置就永遠是同一個人拿。
         ★★ v1.144.0:先手改成**玩家選**(房規「誰先翻」:隨機 / 猜拳 / 房主排),
           核心把決定好的順序從第三個參數送進來 —— 猜拳贏的人就是 picked[0] = 先翻的人。
           ⚠ 沒帶(舊房間、或核心那邊沒開旗標)一律退回原本的 50/50 重抽,
             不要讓「先手永遠是同一個人」偷偷回來。 */
      const ord = (picked && picked.length === ids.length) ? picked.slice() : ids.slice();
      if(!picked && Math.random() < 0.5){ const t = ord[0]; ord[0] = ord[1]; ord[1] = t; }
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
      /* ★ 第二個參數 = 這一手是不是我走的,**只影響震動**(聲音兩邊都要出)——
         比的是 `st.last.seat`(真相層記的走子方),不是「現在輪到誰」:連吃時回合
         留在同一個人身上,拿 turn 去反推會全部算反。 */
      if(!fresh && moves.length === prevLen + 1) DCB.moveSfx(st, !!(st.last && st.last.seat === mySeat()));

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
         ⚠ 措辭與單機那份(solo.js 的 finish())刻意寫成同一個格式:只講「怎麼結束的」,
            幾勝由下面那張表說。 */
      const how = (st && st.over) ? DCB.endText(st, me) : "";
      /* 硃砂大印:贏 / 平手才蓋,輸的那一份不蓋。
         ⚠ 第二個參數是去重用的 —— 這一支會被**反覆呼叫**(見 DCB.setSeal 的註解)。 */
      DCB.setSeal(isDraw ? "draw" : (iWon ? "win" : ""),
                  curRound + ":" + moves.length + ":" + (st ? st.winner : -1));
      if(isDraw) return { word: "平手!", msg: esc(how) + " —— 兩邊各得 1 勝 🤝" };
      if(iWon)   return { word: "你贏了!", msg: esc(how) + " 🎉" };
      const ws = (w && w.ids || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: "你輸了", msg: (ws ? (ws + " 贏了 —— ") : "") + esc(how) };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大棋盤(v1.178.4):存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){ return { turnSec: turnSec, dcRules: DC.normRules(rules), dcRulesV: DC.RULES_V,
                         skin: skin, big: BigMode.get() }; },
    usePrefs(o){
      // 大棋盤:舊偏好沒有這欄 → 預設關。這一刻畫面還在選單,BigMode 的守衛會壓著不生效。
      BigMode.set(!!o.big);
      if(typeof o.turnSec === "number" && (o.turnSec === 0 || (o.turnSec >= 10 && o.turnSec <= 180))) turnSec = o.turnSec;
      /* ★ 我上次當房主設的房規 → 下次建房自動帶回來(同 turnSec)。
         ⚠ 一律 normRules:那份 JSON 住在 localStorage,版本一換就可能有認不出的值。 */
      /* ⚠⚠ 走 migRules 不是 normRules:「對手吃子」的預設 v2.5.2 翻成開,而舊的偏好裡
         那一欄是明碼的 false → 少了這道水位線,老玩家更新後永遠看不到新預設
         (而且不會有任何測試會紅,因為規則層自己是對的)。理由寫在 rules.js 的 migRules。 */
      if(o.dcRules) rules = DC.migRules(o.dcRules, o.dcRulesV);
      /* ★ 棋子樣式:**純本機偏好**,不進房規也不進房間欄位(連線時雙方可以不一樣)。
         ⚠ 一律用白名單擋:那份 JSON 住在 localStorage,舊版 / 手改都可能塞進認不出的值,
           而認不出的值會變成「body 上掛了一個沒有規則的 class」= 棋子回到 fallback,
           看起來像「選了烏木卻還是原木」。 */
      if(SKINS.indexOf(o.skin) >= 0) skin = o.skin;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      act, isMyTurn, resign,
      /* ---------- 棋子樣式(v1.152.0:房主決定全房)----------
         ⚠⚠ 這裡**只給兩份原始值與兩支寫入**,「現在該用哪一份」的判斷**不在這裡** ——
           `ctx` 沒有 `isOnline`(只有 `isHost`),而這一頁的規矩是
           **分流點只准在 main.js**(見 main.js 的 dcEditable / dcRulesNow / dcSetRule
           那一段註解)。為了讓 adapter 自己判斷而去 mp-core 的 ctx 加一個 isOnline,
           會為了一顆按鈕動到十個遊戲共用的核心(CLAUDE.md 紅線 3)—— 不值得。 */
      skins: () => SKINS.slice(),
      skinPref: () => skin,          // 我自己的偏好(單機用 · 建房時帶進房間)
      skinRoom: () => roomSkin,      // 這間房現在的值(連線時用)
      setSkinPref(v){ if(SKINS.indexOf(v) >= 0){ skin = v; roomSkin = v; } return skin; },
      /* 連線那一路:寫房間欄位。回傳「有沒有真的改成」——
         訪客會被 setRoomField 擋下並**跳 toast**(⚠ CLAUDE.md 紅線:不可以用 disabled
         讓點擊靜默消失,按下去要看得到原因),然後回 false。
         ⚠ 刻意不帶 lobbyOnly:純視覺,對局中也改得動。 */
      setSkinRoom(v){
        if(SKINS.indexOf(v) < 0) return false;
        if(!ctx.setRoomField("dcSkin", v, { denyMsg: "只有房主能改棋子樣式" })) return false;
        roomSkin = v;
        return true;
      },
      // 投降鈕該不該出現 / 按得按不動(單機那份的條件在 main.js)
      canResign: () => !!(st && !st.over && playing() && mySeat() >= 0),
      /* ---------- 房規:面板是單機連線共用的,分流點在 main.js ----------
         ⚠ `rules()` 回**房間欄位**那一份(下一局生效);這一局的真相在 `st.rules`。
         ⚠ 寫入走 ctx.setRoomField(整包一個欄位)—— lobbyOnly:對戰中不給改。 */
      rules: () => DC.normRules(rules),
      liveRules: () => DC.normRules(ctx.phase() === "playing" ? gRules : rules),
      /* ⚠ 收的是**整份房規**:面板送的是「哪一組的第幾段」,翻成四個布林是
         DC.setRuleLevel 的事(一次一個 key 的寫法會讓「暗棋連吃」變成兩次 DB 寫入,
         中間那一拍對手會看到不存在的組合)。 */
      setRules(next0){
        const next = DC.normRules(next0);
        if(sameRules(next, rules)) return;
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

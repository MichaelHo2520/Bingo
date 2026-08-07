"use strict";

/* ============================================================================
   UNO — 連線適配器(接上 js/shared/mp-core.js)

   ── DB 上只有兩個欄位就夠了 ──────────────────────────────────────────────
     `deal`(216 字元 = 108 張 × 2)+ `moves`(一手一個字串)。
     與大老二 / 排七的 moves 同構,所以核心的 rev / 交易 / 斷線重建**原封不動** ——
     每台裝置各自 `UN.replay(deal, n, moves, rules)` 算出完整局面,
     **重連歸位不必特別處理**(批次同步就是同一支 replay 多跑幾手)。

   ── ★★★ UNO 比前八個遊戲多的那件事:**牌堆會抽乾** ────────────────────────
     6 人局發掉 42 張、牌堆只剩 65 張,而疊 +4 一輪就能吃掉十幾張 → 一定會洗到。
     重洗的隨機源是 **hash(deal) 與「這是第幾次重洗」**(見 rules.js 第二節)——
     兩者都算得出來,所以每台裝置洗出**完全相同**的順序。
     ⚠ 因此這一支**不必**為重洗寫任何東西:{ deal, moves } 仍然是唯一的真相,
       DB 一個欄位都不加、Firebase 規則不動。

   ── ★ 手牌在 DB 是明碼,刻意不防作弊 ────────────────────────────────────
     受眾是親友聚會(見 CLAUDE.md)。同大老二 / 排七,這**不是妥協而是架構優勢**:
     每台裝置都算得出「現在輪到誰、他能出什麼」,所以**到期自動出牌與結算都不必
     指定房主** —— 誰的 timer 先響誰用交易搶,房主剛好斷線也不會全桌卡死。

     代價是「算得出來」不等於「可以顯示」。這一頁只有**一條**牌情紅線:
         ★ 對手手上有什麼,結算前只能顯示張數。
     落地點在 chipTail()(晶片只給張數 + 「還剩一張」那一個 bit)與 board.js 的
     resultHTML()(排名表,唯一翻開的地方)。牌河是公開的,照實畫。

   ── ★ 名次分:winner 要帶 pts 表 ─────────────────────────────────────────
     計分是「第一個出完的拿 5 分,其餘照手牌點數排 3 / 1 / 0」。
     核心 v1.76.0 起支援 `winner.pts = {pid:分數}`(不帶就是舊的「贏家 +1」)。
     ⚠ `winner.ids` 仍然只放**第一名** —— 大字 / 彩帶 / 卡片配色全部吃 winnerIds()。

   ── ★ 決定勝負的交易一定要帶 { local:false } ─────────────────────────────
     notes/07 踩坑 #8:Firebase 交易會先在本地樂觀套用,搶最後一手時搶輸的那台會
     **先**看到「我贏」而往 scores/ 寫分數,game 回退時分數不會跟著回退。
   ========================================================================== */

const MP = MPCore.create((function(){

  const SECS = [0, 15, 30, 45];        // 出牌倒數的選項;預設值也寫在 uno.html 的 .on
  let turnSec = 30;                     // ★ 比大老二短 —— UNO 一手只挑一張牌,不必湊組合
  let ctx = null;

  /* ★★★ 房規 —— **兩份**,而它們刻意不一樣:
       rules   房間欄位 `unRules`(房主現在設定的那一份 → **下一局**才生效)
       gRules  這一局**開局那一刻凍結**的那一份(`game.rules`,真相層要用的就是它)
     ⚠⚠ 兩份的理由與大老二 / 21點逐字相同:房規改了不可以讓**已經在打的這一局**
       重算出不同結果(症狀是「重連的人算出來的牌局跟現場不一樣」)。
     ⚠⚠ 交易裡(send / autoPlay / maybeSettle)**一律用 `g.rules`,不是 gRules** ——
       伺服器上那一局凍的是什麼,只有 g 知道。
     ★ 出牌倒數 `turnSec` **刻意不併進這個物件**:它不影響任何判定(不是真相)。 */
  let rules = UN.defRules();
  let gRules = UN.defRules();

  let deal = "", moves = [], st = null;
  let curRound = null;                 // ★ 新局判定一律用 roundId(不可以看 deal 變沒變)
  let lastLen = -1, turnAt = 0;        // 這一手的錨點(本地時鐘;各台差幾百毫秒無妨)
  let turnT = null;
  let unoArmed = false;                // UNO! 這一手要不要喊(每出一手歸零)
  let pendWild = -1;                   // 正在等選色的那張牌
  let baseWins = {};                   // 開局那一刻每個人的累積分(結果卡的「N 分」欄用)

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
       跳過 / 迴轉 / 罰抽跳過 / 抽牌後留在同一個人的回合,四件事都會讓步數與座位脫鉤。 */
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
    /* ★ 「喊過 UNO」只在手上剛好 2 張的那一手有意義 —— ⚠ 與單機那份逐字一樣 */
    if(st.hands[me].length !== 2) unoArmed = false;
    const mine = isMyTurn() && pendWild < 0;
    const nms = [];
    for(let s = 0; s < nPlayers(); s++) nms.push(nameOfSeat(s));
    // ★ 手牌亮暗:與單機那份逐字一樣(solo.js 的 paint 同一段)
    const hot = mine ? UN.playable(st.hands[me], st) : [];
    UNB.render({
      hand: st.hands[me].slice(),
      top: st.top, col: st.col, dir: st.dir, pend: st.pend, stack: st.rules.stack,
      n: nPlayers(),                              // ★ 2 人局不畫方向
      pileLeft: st.pile.length, discLeft: st.disc.length,
      mine: mine, over: !!ctx.winner() || st.over,
      turnName: st.over ? "" : nameOfSeat(st.turn),
      hot: hot, drew: st.drew, drewCard: st.drewCard,
      /* ★ 換局才變。⚠ 用 roundId 而不是 deal / moves.length:同其他遊戲那條
         「新局判定一律用 roundId」,拿手牌或手數去推會把「出掉一手」誤判成新局。 */
      key: ctx.roundId()
    });
    UNB.renderActs({
      mine: mine, over: !!ctx.winner() || st.over,
      turnName: st.over ? "" : nameOfSeat(st.turn),
      drew: st.drew,
      noPlay: mine && !hot.length,
      handLen: st.hands[me].length,
      // ★ 房規 toLast 開著才有這一格 —— ⚠ 與單機那份逐字一樣
      iAmOut: !ctx.winner() && !st.over && st.hands[me].length === 0,
      unoOn: unoArmed, unoRule: st.rules.unoCall,
      // ★ 抓鈕不分回合(視窗是「下一家出手之前」)
      catchName: (st.rules.unoCall && st.catchSeat >= 0 && st.catchSeat !== me &&
                  !ctx.winner() && !st.over) ? nameOfSeat(st.catchSeat) : "",
      // 環給全桌看(誰還剩幾秒是公開資訊,大家才知道為什麼卡著)
      cdMs: secOn() ? turnSec * 1000 : 0,
      cdEnd: secOn() ? turnAt + turnSec * 1000 : 0
    });
    ctx.renderPlayers();
    /* ★ 「還剩一張」的公告 —— 與單機那份**共用 board.js 的同一支**,所以這裡只有一行。
       ⚠ 要放在 renderPlayers() **之後**:晶片上的記號是它畫上去的,
         公告排在畫面之後才不會出現「先聽到聲音、記號慢一拍」。
       ⚠ key 一律用 roundId;批次同步 / 斷線重連不會亂響的理由在 board.js 第七節。 */
    UNB.announce({ left: st.hands.map(h => h.length), names: nms, me: me, key: ctx.roundId() });
  }

  /* ==========================================================================
     二、出牌 / 抽牌 / 抓人
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對(同大老二 send() / 排七 send() 的守衛)。
     ========================================================================== */
  function send(mv, opts){
    const step = moves.length, n = nPlayers();
    /* ★ 「這一手是誰的」對出牌 / 抽牌是「當前玩家」,對**抓人**不是 ——
       抓不分回合,所以不可以一律檢查 chk.turn === me。 */
    const needTurn = !UN.isCatch(mv);
    const me = mySeat();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const list = Array.isArray(g.moves) ? g.moves : [];
      if(list.length !== step) return false;            // 這一手已被別人推進 → 中止,等快照
      const chk = UN.replay(g.deal, n, list, g.rules);   // ⚠ 用**伺服器上凍結的**房規
      if(!chk || chk.over) return false;
      if(needTurn && chk.turn !== me) return false;
      if(!UN.step(chk, mv)) return false;               // 伺服器真值上不合法 → 不寫
      g.moves = list.concat(mv);
    });
  }

  /* 點一張牌 = 出那一張。★ Wild 要先選顏色。
     ⚠ 與單機那支(solo.js 的 tap)**逐字一樣**,只差「去哪裡拿座位」。 */
  function tap(card){
    if(ctx.phase() !== "playing") return;
    if(ctx.winner() || ctx.abandoned()) return;
    if(!st || st.over) return;
    if(pendWild >= 0){ showToast("先選一個顏色"); return; }
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    const me = mySeat();
    if(!(card >= 0 && card < UN.NCARD)) return;
    if(st.hands[me].indexOf(card) < 0) return;
    /* ★★ 沒亮的牌不給出,但**一定要說得出原因** ——
       CLAUDE.md 的紅線是「不用 disabled 讓牌**靜默**吃掉點擊」。 */
    if(!UN.legalOn(st, card)){ showToast(whyNot(card), 1800); return; }
    if(UN.isWild(card)){
      pendWild = card;
      paint();
      UNB.askColor(col => {
        const c = pendWild;
        pendWild = -1;                        // ★ 一定要先清 —— 它是「手牌能不能點」的閘門
        if(c < 0 || !playing()){ paint(); return; }
        // ★ col < 0 = 取消(按了返回鍵 / 點了蓋板外框)→ 那一手 Wild 不算,牌回到手上
        if(col < 0){ showToast("取消了", 1200); paint(); return; }
        send(UN.encPlay(c, col, unoArmed && st.hands[mySeat()].length === 2));
        unoArmed = false;
        paint();
      });
      return;
    }
    send(UN.encPlay(card, 0, unoArmed && st.hands[me].length === 2));
    unoArmed = false;
  }

  /* 為什麼這張出不了 —— ⚠ 與單機那支(solo.js 的 whyNot)逐字一樣 */
  function whyNot(card){
    if(st.pend > 0){
      if(!st.rules.stack) return "被罰抽 " + st.pend + " 張 —— 只能抽";
      /* ★ 手上如果還有別的同種牌能疊,強制出牌就輪到那一條 —— 不能靠抽來吃掉罰抽。 */
      return UN.canPlay(st.hands[mySeat()], st)
        ? ("要用 " + (st.pendK === UN.K_W4 ? "+4" : "+2") + " 疊上去")
        : ("疊不上 —— 只能抽 " + st.pend + " 張");
    }
    if(st.drew) return "只能出剛抽到的那張";
    return "要出 " + (UN.COL_NAME[st.col] || "") + " 色、同數字,或 Wild";
  }

  function act(a){
    if(!st || st.over || !playing()) return;
    if(a === "catch"){ doCatch(); return; }
    if(pendWild >= 0){ showToast("先選一個顏色"); return; }
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    const me = mySeat();
    if(a === "uno"){
      /* ★★ 一按就定案,不是切換 —— ⚠ 與單機那支(solo.js 的 act)逐字一樣。 */
      if(st.hands[me].length !== 2){ showToast("剩兩張時才用得到", 1500); return; }
      if(unoArmed) return;
      unoArmed = true;
      UNB.sfx.uno();
      paint();
      return;
    }
    if(a === "draw"){
      /* ⚠ 與單機那支(solo.js 的 act)**逐字一樣**:手上有合法牌可出時不准抽。 */
      if(UN.canPlay(st.hands[me], st)){ showToast("有牌可以出,不能抽", 1600); return; }
      send(UN.DRAW);
      return;
    }
    if(a === "pass"){
      if(!st.drew){ showToast("先抽一張"); return; }
      send(UN.PASS);
      return;
    }
  }

  /* 抓漏喊 UNO 的人。★ 不分回合 —— 視窗由規則層管(st.catchSeat)。 */
  function doCatch(){
    if(!st || !st.rules.unoCall || !playing()) return;
    const me = mySeat(), t = st.catchSeat;
    if(t < 0 || t === me){ showToast("沒人可以抓"); return; }
    send(UN.encCatch(me, t));
  }

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
      const chk = UN.replay(g.deal, n, list, g.rules);   // ⚠ 同上:房規在 g 裡
      if(!chk || chk.over || chk.turn !== seat) return false;
      const mv = UNAI.autoMove(chk, seat);              // 替人代打一律用「普通」,不套難度
      if(!UN.step(chk, mv)) return false;
      g.moves = list.concat(mv);
    });
  }

  /* ==========================================================================
     四、結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數。
       ★ 一定要帶 { local:false } —— 見檔頭與 notes/07 踩坑 #8。
       ★ 交易裡拿**伺服器的 moves** 再確認一次真的結束了。
       ★ 名次分寫進 winner.pts —— 核心會依每個人自己那一格加分。
     ========================================================================== */
  function maybeSettle(){
    if(!st || !st.over || ctx.winner() || !playing()) return;
    const n = nPlayers(), ord = ctx.order();
    ctx.txGame(g => {
      if(g.winner) return false;
      const chk = UN.replay(g.deal, n, Array.isArray(g.moves) ? g.moves : [], g.rules);
      if(!chk || !chk.over) return false;
      const sc = UN.score(chk);
      const pts = {};
      sc.rows.forEach(r => { const id = ord[r.seat]; if(id) pts[id] = r.rp; });
      g.winner = {
        ids: (chk.winner >= 0 && ord[chk.winner]) ? [ord[chk.winner]] : [],   // ★ 只放第一名
        pts: pts,                                                              // ★ 名次分
        by: "rank"
      };
    }, { local: false });
  }

  /* ==========================================================================
     五、mp-core 的 adapter 介面
     ========================================================================== */
  function ruleHint(){
    /* ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。 */
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,時間到系統會幫他出一手")
                        : "<b>不限時</b>——沒人催,有人離開牌桌全桌會一直等";
    return "108 張牌,每人先發 <b>7 張</b>。出牌條件是<b>同色</b>或<b>同數字 / 同動作</b>;" +
           "<b>Wild 隨時可出</b>並指定顏色。<br>" +
           "出不了就<b>抽一張</b> —— <b>抽到的那張能出就可以馬上出</b>。" +
           "<b>⇄ 迴轉</b>反轉方向,<b>2 人局就是換對手出</b>。<br>" +
           "<b>" + esc(unRulesText(rules)) + "</b>(房主可改)。<br>" +
           (rules.toLast
             ? ("有人出完牌局<b>繼續</b>,打到<b>只剩一個人手上還有牌</b>才結束;" +
                "名次照<b>出完的先後</b>排,名次分<b>依人數</b>算" +
                "(第一名 <b>5</b> 分、最後一名 <b>0</b> 分,中間平分)。<br>")
             : ("有人打完最後一張,<b>這一局立刻結束</b>。名次照<b>手上剩牌的點數</b>排" +
                "(跳過/迴轉/+2 各 20 · Wild 各 50),名次分 <b>5 / 3 / 1</b>,最後一名 <b>0</b> 分。<br>")) +
           "出牌倒數:" + sec + "。";
  }

  return {
    ns: { rooms: "uno_rooms", index: "uno_index" },
    minPlayers: 2, maxPlayers: 6,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    prefsKey: "uno.prefs.v1",
    emoteAnchor: "unStage",
    winCardId: "unWinCard",
    hasResign: false,                      // 多人局「認輸」語意不清(同數獨 / 排七 / 大老二)
    /* ★ 名次分:一局最多發 5 分,所以單位是「分」、目標值要拉高
       (核心不帶這三個就是舊的 "勝" / 3 / 20,八個舊遊戲一個字都不受影響) */
    scoreUnit: "分", goalDefault: 15, goalMax: 60,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { turnSec: turnSec, unRules: UN.normRules(rules) }; },
    onRoomField(k, v){
      /* ★ 房規:整包一個欄位(面板一次只改一項,但寫進去的是整份)——
         ⚠ 守門一律走 normRules(白名單):手改 DB / 舊房間的值都要能用。 */
      if(k === "unRules"){
        const next = UN.normRules(v);
        /* ⚠⚠ 這個「有沒有真的變」的比對是**逐欄位**寫的,而房規有三項 ——
           加房規忘了補這裡的症狀是「房主按了那一項,別人的畫面完全不動」
           (寫進 DB 了,但這裡當成沒變就 return 掉)。同一份比對在下面 setRule 也有一份。 */
        if(next.stack === rules.stack && next.unoCall === rules.unoCall &&
           next.playDrawn === rules.playDrawn && next.toLast === rules.toLast) return;
        rules = next;
        ctx.unreadyOnFieldChange();
        ctx.syncSetup(); ctx.updateGoal();
        return;
      }
      if(k !== "turnSec") return;
      // ⚠ 守門用**範圍**而不是白名單 —— 舊房間 / 手改 DB 的值也要能用
      if(typeof v !== "number" || !(v === 0 || (v >= 10 && v <= 120)) || v === turnSec) return;
      turnSec = v;
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
      if(ctx.phase() === "playing"){ armTurnT(); paint(); }
    },
    readRoom(r){
      if(typeof r.turnSec === "number") turnSec = r.turnSec;
      if(r && r.unRules) rules = UN.normRules(r.unRules);   // ⚠ 舊房間沒有 → 維持預設
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { deal: "", moves: [], rules: UN.normRules(rules) }; },
    resetRound(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      unoArmed = false; pendWild = -1;
      UNB.stopCd(); UNB.closeColor(); UNB.resetAnnounce();
    },
    newGame(ids, prev){
      // 座位每局重抽(先手固定是 0 號座位,所以換位置才公平)
      const ord = ids.slice();
      for(let i = ord.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
      }
      /* ★★★ 房規在**這一刻**凍進 game.rules —— 之後房間欄位怎麼改都不影響這一局。 */
      return { order: ord, deal: UN.newDeal(), moves: [], rules: UN.normRules(rules) };
    },
    applyGame(g, isPlaying){
      const next = Array.isArray(g.moves) ? g.moves : [];
      const prevLen = moves.length;
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);        // ★ 新局一律看 roundId
      deal = g.deal || deal;
      moves = next.slice();
      if(!isPlaying){ st = null; return; }
      if(fresh){
        curRound = rid; lastLen = -1; unoArmed = false; pendWild = -1; UNB.closeColor();
        /* ★ 語音音檔先載好(v1.117.0)—— 語音槽沒有合成音後備,不預載的話「這一局第一次
           喊 UNO」永遠沒聲音(音檔那時才開始飛)。放在**開新局**這一格:
           走到這裡玩家早就點過「準備 / 開始」了(有手勢),而 Sound.prime 自己會去重。 */
        UNB.primeVoice();
      }

      /* ★ 讀**這一局凍結的**那一份(不是房間欄位)。
         ⚠ 照 deal 那一行的模式用「有才蓋掉」:某一次快照少了這個欄位時,
           寧可沿用上一次讀到的,也不要靜靜地退回預設房規(那會讓整局重算)。 */
      if(g.rules) gRules = UN.normRules(g.rules);
      st = UN.replay(deal, nPlayers(), moves, gRules);
      if(!st) return;                            // deal 壞掉(理論上不會)→ 等下一個快照

      /* 音效走「前後兩份的 diff」而不是在動作點插 sfx.xxx() ——
         單機與連線的動作路徑完全不同,但「有人出了 +2」在兩邊是同一個 diff。
         ⚠ 換局那一手一定要跳過(整包重來,diff 沒有意義);
         ⚠ 批次同步(重連歸位)也不連播,不然一口氣響幾十聲。 */
      if(!fresh && moves.length === prevLen + 1){
        UNB.moveSfx(moves[moves.length - 1], nPlayers());
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
      unoArmed = false; pendWild = -1;
      UNB.stopCd(); UNB.closeColor(); UNB.resetAnnounce();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      unoArmed = false; pendWild = -1;
      UNB.resetAnnounce();
      // ★ 這一局開打前大家各幾分(結果卡的「N 分」欄要拿它加這局的分;見 outcome)
      baseWins = {};
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      paint();
    },
    onLeave(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      unoArmed = false; pendWild = -1; baseWins = {};
      UNB.stopCd(); UNB.closeColor(); UNB.resetAnnounce();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const seg = $("unSecSeg");
      if(seg){
        seg.classList.toggle("readonly", !isHost);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === turnSec));
      }
      const lbl = $("unSecLabel");
      if(lbl) lbl.textContent = isHost ? "出牌倒數" : "出牌倒數(房主決定)";
      /* ★★ 房規那一列:標籤跟著身分換字,而摘要與規則清單同一份 ruleHint()。
         ⚠ 面板**開著**的時候也要跟著同步 —— 房主改了規則,訪客那台是靠這裡刷新的
           (漏掉的症狀是「訪客的面板停在舊規則,而大廳摘要已經換了」)。 */
      const rl = $("unRulesLabel");
      if(rl) rl.textContent = isHost ? "房規" : "房規(房主決定)";
      if(typeof syncRules === "function" && $("unRulesVeil") &&
         $("unRulesVeil").classList.contains("show")) syncRules(rules, isHost);
      const hint = $("unRuleHint");
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
       「還剩一張」是唯一的豁免(只有一個 bit;牌型 / 牌值一律不准,連 title 都不行)。 */
    chipTail(id){
      if(!st) return "";
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return "";
      const n = st.hands[s].length;
      return (n === 1 ? '<span class="un-chu" title="還剩一張">UNO</span>' : "") +
             '<span class="un-chn" title="手上剩幾張"><i class="un-pip"></i>' + n + '</span>';
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
      UNB.stopCd();
      UNB.closeColor();
      const me = mySeat();
      const sc = (st && st.over) ? UN.score(st) : null;
      const row = sc ? sc.rows[me] : null;
      const box = $("unResult");
      if(box && st && st.over){
        const ord = ctx.order();
        const names = ord.map(id => ctx.dispName(id));
        /* ★ 累積分併進排名表 —— 連線的結果卡從此只有**一張表**。
           ⚠ 這局各加幾分直接讀 winner.pts(核心就是照它加的),底數用開局快照,
             所以不必等 scores 節點同步回來。 */
        const pts = (w && w.pts) || {};
        const wins = ord.map(id => {
          const add = (typeof pts[id] === "number") ? pts[id] : ((ids || []).indexOf(id) >= 0 ? 1 : 0);
          const base = (typeof baseWins[id] === "number") ? baseWins[id] : ctx.scoreOf(id);
          return { n: base + add, plus: add };
        });
        box.innerHTML = UNB.resultHTML(st, names, me, wins);
        box.classList.remove("hidden");
      }
      paint();
      /* ★ 一句話:底下的排名表已經逐列寫著「誰第幾名 / 剩幾張 / 幾分」,
         這一句只負責「這局誰第一、我幾分」。
         ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。
         ⚠ 措辭與單機那份(solo.js 的 finish())刻意寫成同一個格式。 */
      if(iWon){
        return { word: "你贏了!",
                 msg: row ? ("你第一個出完 · 名次分 <b>" + row.rp + "</b> 🎉") : "你第一個出完 🎉" };
      }
      const ws = (w && w.ids || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: row ? ("第 " + row.rank + " 名") : "這局結束",
               msg: (ws ? (ws + " 第一個出完") : "這局結束") +
                    (row ? (" · 你 <b>" + row.rp + "</b> 分" +
                            (row.left ? ("(手上還剩 " + row.left + " 張 · " + row.pts + " 點)") : "")) : "") };
    },

    /* ---------- 偏好 ---------- */
    ownPrefs(){ return { turnSec: turnSec, unRules: UN.normRules(rules) }; },
    usePrefs(o){
      if(typeof o.turnSec === "number" && (o.turnSec === 0 || (o.turnSec >= 10 && o.turnSec <= 120))) turnSec = o.turnSec;
      /* ★ 我上次當房主設的房規 → 下次建房自動帶回來(同 turnSec)。
         ⚠ 一律 normRules:那份 JSON 住在 localStorage,版本一換就可能有認不出的值。 */
      if(o.unRules) rules = UN.normRules(o.unRules);
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      tap, act, isMyTurn,
      /* ---------- 房規:面板是單機連線共用的,分流點在 main.js ----------
         ⚠ `rules()` 回**房間欄位**那一份(下一局生效);這一局的真相在 `st.rules`。
         ⚠ 寫入走 ctx.setRoomField(整包一個欄位)—— lobbyOnly:對戰中不給改
           (與大老二 / 21點一樣:規則在開局那一刻就凍了)。 */
      rules: () => UN.normRules(rules),
      liveRules: () => UN.normRules(ctx.phase() === "playing" ? gRules : rules),
      setRule(key, val){
        const next = UN.normRules(Object.assign({}, rules, { [key]: val }));
        // ⚠ 四項都要比(見 onRoomField 那一份的說明)—— 漏一項 = 那一項按了沒反應
        if(next.stack === rules.stack && next.unoCall === rules.unoCall &&
           next.playDrawn === rules.playDrawn && next.toLast === rules.toLast) return;
        if(!ctx.setRoomField("unRules", next, { lobbyOnly: true,
             denyMsg: "只有房主能改規則", busyMsg: "對戰中不能改規則 —— 這一局的規則已經定下來了" })) return;
        rules = next; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      /* ★ 關掉房規面板之後把大廳那行摘要重畫。
         ⚠ 走 adapter 自己開一支、**不動共用層** —— 核心的 API 沒有這一項,
           而為了一行摘要去改 js/shared/ 要付「八個遊戲全部回歸」的代價(紅線 3)。
         ⚠ 大老二那邊是直接寫 b2RuleHint 那個節點的 textContent,那會把 ruleHint()
           那段比較完整的 HTML 換成一句話(輕微退化);走 syncSetup 就是重畫
           「原本那一份」,不會退化。
         ⚠⚠ 上面那句刻意**不寫成 dollar-括號-id 的形式** —— tools/test-pages.js 的
           C 節會掃「未加保護的取節點呼叫」,寫在註解裡也一樣被掃到,
           而那個 id 不在這一頁 → 開出一條假紅(第一版真的中了)。 */
      refreshSetup(){ ctx.syncSetup(); },
      turnSec: () => turnSec,
      setTurnSec(v){
        if(SECS.indexOf(v) < 0) return;
        if(!ctx.setRoomField("turnSec", v, { lobbyOnly: true, denyMsg: "只有房主能改倒數", busyMsg: "對戰中不能改倒數" })) return;
        turnSec = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      // 給 e2e 用:把這一手的錨點往回撥,免得測「到期自動出牌」要真的等 30 秒
      _ageTurn(ms){ turnAt -= (+ms || 0); armTurnT(); paint(); },
      // 給 e2e 用:直接把選色盤的答案送進去
      _pickColor(col){ UNB.pickColor(col); }
    }
  };
})());

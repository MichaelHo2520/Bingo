"use strict";

/* ============================================================================
   飛行棋 — 連線適配器(接上 js/shared/mp-core.js)

   ── DB 上只有兩個欄位就夠了 ──────────────────────────────────────────────
     `fc`(這一局凍結的房規)+ `moves`(一手一個整數),與排七 / 五子棋同構,
     所以核心的 rev / 交易 / 斷線重建原封不動就能用。
     每台裝置各自 FC.replay(fc, n, moves) 算出完整局面 → **重連歸位不必特別處理**。

   ── ★★ 房規必須在開局那一刻凍結(比照 21 點)─────────────────────────────
     replay 是拿「現在的房規」重跑整局的 —— 房規一變,同一份 moves 會 replay 出
     **完全不同的盤面**(這件事有測試守著,見 test-fc-rules 的 E 節)。
     所以 newGame() 把當下的房規整包寫進 `g.fc`,對局中改大廳設定完全影響不到這一局。

   ── ★★★ 批次同步絕對不可以連播動畫 ───────────────────────────────────────
     這是十三個遊戲裡第一個有棋子位移動畫的一頁。斷線重連時 moves 會一口氣多幾十筆,
     照著演就是**二十幾秒的慢動作**,而且那段期間畫面完全不能操作。
     → 只有「剛好多一筆」才演(animOf());其餘一律直接落到終局座標。

   ── ★ 骰子的點數是寫進 moves 的,不是算出來的 ────────────────────────────
     刻意不用決定性 PRNG(理由見 rules.js 檔頭②)。Math.random() 在這一支只出現在
     兩個地方:玩家自己按擲骰(sendRoll)、以及倒數到期替人代打(autoPlay)。

   ── ★ 決定勝負的交易一定要帶 { local:false } ─────────────────────────────
     notes/07 踩坑 #8:Firebase 交易會先在本地樂觀套用,搶最後一手時搶輸的那台會
     **先**看到「我贏」而往 scores/ 寫分數,game 回退時分數不會跟著回退。
   ========================================================================== */

const MP = MPCore.create((function(){

  const SECS = [0, 15, 30, 60];        // 出手倒數的選項;預設值也寫在 flychess.html 的 .on
  let turnSec = 30;
  let rules = { planes: 2, launch: "one6", goal: 0, exact: false };   // 大廳裡「下一局要用」的房規
  let ctx = null;

  let moves = [], st = null, gRules = null;   // gRules = 這一局凍結下來的房規
  let curRound = null;
  let lastLen = -1, turnAt = 0;
  let turnT = null, armedLen = -1;
  let busy = false;                    // 動畫演到一半:不要在中間再畫一次(會把飛機瞬移)

  /* ==========================================================================
     ★★★ busy 的看門狗(v1.179.6)—— 現場回報「兩台都說輪到對方」的最後一道保險
     ──────────────────────────────────────────────────────────────────────────
       **busy 只有一條路會被放掉:動畫的 onDone。** 而那個回呼前面站著一整排
       **純裝飾**的東西 —— 踩人的表情、罐頭語音、震動、提示條(applyOne)。
       只要其中一個丟例外,這一台就永遠停在 busy = true,而且症狀非常難認:

         · roll() / tapPlane() 開頭就 `if(busy) return`,而且是**靜默的**
           → 玩家一直按骰子,什麼事都沒發生、也沒有任何訊息
         · 那一手的 armTurnT() 排在**同一個回呼裡** → 連「幫別人代打」都不會武裝
         · 畫面停在上一手 → 他看到的是「輪到對方」,而對方看到的是「輪到他」
           → **兩台都說輪到對方**,而且只有對手那一顆倒數到期才救得回來
           (使用者:「這一次最後他有解決可以繼續玩下去」= 對手的倒數把局面推過去了)

     ⚠ 這一顆是**最後一道**保險,不是主要修正。三道刻意互為多餘,因為全桌卡死的代價太高:
         ① 裝飾一律 try/catch(applyOne / FCB.drama)—— 讓它根本不會卡
         ② 倒數在**動畫之前**就武裝(applyGame)—— 卡住了也還有代打
         ③ 這一顆 —— 前面兩道都失效時,五秒後自己把 busy 放掉並重畫
     ⚠ 上限要比最長的一手寬:走 6 格(6×105ms)+ 踩人回機場(120+420+420)量到約
       1.6 秒;再留給低階手機與被節流的背景分頁 → 5 秒。
     ========================================================================== */
  let busyT = null, busyMax = 5000;
  function setBusy(v){
    busy = !!v;
    if(busyT){ clearTimeout(busyT); busyT = null; }
    if(!busy) return;
    busyT = setTimeout(() => {
      busyT = null;
      if(!busy) return;
      busy = false;
      /* ⚠ 一定要順手把倒數重新武裝 + 重畫:單純放掉 busy 只是「按得動了」,
         畫面還停在上一手。paint() 走的是 anim:null → FCB 的 bump() 會把卡住的
         那條動畫鏈收掉,並且把它欠的 onDone 交出去(board.js 的 bump 註解)。 */
      armTurnT();
      paint();
    }, busyMax);
  }
  /* ★ 開局那一刻每個人的累積分數快照(結果卡的「累計」欄用)。
     為什麼不當場讀 scores:那個節點是**結算之後**每台各自寫自己的分,而結果卡是
     **結算當下**就要畫出來 —— 直接讀會少一次,而且沒有人會重畫這張卡。 */
  let baseWins = {};

  const seatOf = id => ctx.order().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  const nPlayers = () => ctx.order().length;
  const secOn = () => turnSec > 0;
  const playing = () => ctx.phase() === "playing" && !ctx.winner() && !ctx.abandoned();
  const rulesOf = g => FC.normRules((g && g.fc) || rules);
  function nameOfSeat(s){
    const id = ctx.order()[s];
    return id ? ctx.dispName(id) : ("玩家" + (s + 1));
  }

  /* ---------- 輪到誰 ----------
     ★ 一律問 replay 出來的 st.turn,不可以用 moves.length 取模 ——
       擲到 6 會再擲一次(回合停在同一個人身上),而且一手不一定是兩筆。 */
  function turnId(){
    if(!st || st.over) return null;
    return ctx.order()[st.turn] || null;
  }
  const isMyTurn = () => !!(st && !st.over && playing() && st.turn === mySeat());

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  /* ★ 連擲 6 的計數。**這是規則的一部分**(連續三次 6 這一輪作廢),而它以前在畫面上
     完全沒有:玩家只知道「又是 6」,不知道自己已經第幾次了 —— 第三次忽然作廢就像 bug。
     ⚠ 公開資訊(每台各自 replay 都算得出 st.sixes)→ 全桌都看得到,不只當事人。 */
  function sixTag(){
    return (st && st.sixes) ? ('<b class="fc-fire">🔥 連 ' + st.sixes + '/3</b> ') : "";
  }
  function hintText(){
    if(!st || st.over) return "";
    const who = esc(nameOfSeat(st.turn));
    if(!isMyTurn()) return sixTag() + who + (st.die ? " 擲出 " + st.die + ",正在選飛機…" : " 要擲骰了…");
    if(!st.die) return sixTag() + "輪到你了 —— 按骰子";
    const L = FC.legalMoves(st, mySeat());
    if(!L.length) return sixTag() + "這個點數沒得走";
    // 唯一的選項會自己出發(見二之二節)—— 一定要說出來,不然看起來像「我還沒按就動了」
    if(autoOne && L.length === 1) return sixTag() + "只有這一架動得了 —— 自動出發…";
    return sixTag() + "點一架要動的飛機" + (st.die === 6 ? "(擲到 6,走完可以再擲一次)" : "");
  }

  function paint(anim, done){
    if(!st) return;
    const me = mySeat();
    /* ★ 整包 legalMoves 傳下去(不只 plane index):盤面要靠它畫**落點預覽**與
       「這一架踩得到人」那顆紅光 —— 反正這裡本來就算了一次,不必算第二次。 */
    const L = (isMyTurn() && st.die && !busy) ? FC.legalMoves(st, me) : [];
    FCB.render({ st: st, mySeat: me, can: L.map(m => m.plane), cans: L,
                 anim: anim || null, onDone: done || null });
    FCB.renderActs({
      canRoll: isMyTurn() && !st.die && !busy,
      hint: hintText(),
      // 倒數給全桌看(誰還剩幾秒是公開資訊,大家才知道在等什麼)
      cdMs: secOn() ? turnSec * 1000 : 0,
      cdEnd: secOn() ? turnAt + turnSec * 1000 : 0
    });
    ctx.renderPlayers();
  }

  /* ==========================================================================
     二、送出一手
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對(同排七 send() 的守衛)。
     ========================================================================== */
  function push(step, mkMove, guard){
    const n = nPlayers();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const mv = Array.isArray(g.moves) ? g.moves : [];
      if(mv.length !== step) return false;                  // 這一手已被推進 → 中止,等快照
      const chk = FC.replay(rulesOf(g), n, mv);
      if(!chk || chk.over) return false;
      if(guard && !guard(chk)) return false;
      const one = mkMove(chk);
      if(one == null || one < 0) return false;
      if(!FC.step(chk, one)) return false;                  // 伺服器真值上不合法 → 不寫
      g.moves = mv.concat(one);
    });
  }

  function sendRoll(){
    const me = mySeat(), step = moves.length;
    // ★ 這是這一支唯二准用 Math.random() 的地方之一
    const d = 1 + Math.floor(Math.random() * 6);
    push(step, () => FC.encRoll(d), chk => chk.turn === me && !chk.die);
  }
  function sendMove(plane){
    const me = mySeat(), step = moves.length;
    push(step, () => FC.encMove(plane), chk =>
      chk.turn === me && !!chk.die && FC.legalMoves(chk, me).some(m => m.plane === plane));
  }

  /* ---------- 玩家操作 ---------- */
  function roll(){
    if(ctx.phase() !== "playing"){ return; }
    if(ctx.winner() || ctx.abandoned()){ return; }
    if(!st || st.over) return;
    if(busy) return;
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    if(st.die){ showToast("先選一架飛機"); return; }
    sendRoll();
  }
  function tapPlane(plane){
    if(ctx.phase() !== "playing"){ return; }
    if(ctx.winner() || ctx.abandoned()){ return; }
    if(!st || st.over || busy) return;
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    if(!st.die){ showToast("先按骰子"); return; }
    const L = FC.legalMoves(st, mySeat());
    if(!L.some(m => m.plane === plane)){ showToast(whyNot(plane)); return; }
    sendMove(plane);
  }
  // 「為什麼這一架動不了」。★ 不用 disabled 讓飛機靜默吃掉點擊
  function whyNot(plane){
    const q = st.planes[mySeat()][plane];
    if(q >= FC.GOAL) return "這一架已經到家了";
    if(q === 0) return st.rules.launch === "six" ? "要擲到 6 才能起飛" : "要擲到 1 或 6 才能起飛";
    if(st.rules.exact) return "點數太大,終點要剛好走到";
    return "這一架這個點數動不了";
  }

  /* ==========================================================================
     二之二、★ 唯一的選項不必再點一次
     ──────────────────────────────────────────────────────────────────────────
       擲完只有一架飛機動得了時,「再點一下」是**純粹的手續**(零決策)——
       單機那邊從第一版就自動走了(solo.js 的 doRoll()),連線這邊補上同一件事。
     ⚠ 只在 legalMoves **剛好一個**的時候才走。兩架都動得了(例如兩架都在機場又擲到 6)
       一定要讓人自己選 —— 那是真的有差別的。
     ⚠ 送出走的仍然是 sendMove() → push() 的交易守衛(step 對不上就中止),
       所以重複觸發是 no-op,不會多走一手。
     ⚠⚠ **e2e 一律先 `MP._autoOne(false)` 關掉它**:不關的話「輪到我、還沒選飛機」
       這個前提會被它自己吃掉,而症狀是**偶發**紅在「按了沒反應」
       (那正是這一頁 e2e 最容易長出來的假紅,見 notes/22 第五節)。
       ★ 它自己那一節在 gen-fc-e2e.js 的 D3(含「關掉就不該自動走」的反向對照)。
     ========================================================================== */
  const AUTO_ONE_MS = 420;             // 先讓人看清點數與盤面,再自己出發
  let autoOne = true, autoOneT = null;
  function clearAutoOne(){ if(autoOneT){ clearTimeout(autoOneT); autoOneT = null; } }
  function armAutoOne(){
    clearAutoOne();
    if(!autoOne || busy || !st || st.over || !playing()) return;
    if(!isMyTurn() || !st.die) return;
    const L = FC.legalMoves(st, mySeat());
    if(L.length !== 1) return;
    const step = moves.length, plane = L[0].plane;
    autoOneT = setTimeout(() => {
      autoOneT = null;
      // ⚠ 到期時要重新確認一次:這 420ms 之間可能被倒數代打搶走,或局面整個換了
      if(busy || !st || st.over || !playing()) return;
      if(!isMyTurn() || !st.die || moves.length !== step) return;
      const L2 = FC.legalMoves(st, mySeat());
      if(L2.length !== 1 || L2[0].plane !== plane) return;
      sendMove(plane);
    }, AUTO_ONE_MS);
  }

  /* ==========================================================================
     三、出手倒數 —— 到期幫他走一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主:每一台都排 timer,誰先響誰用交易搶(房主剛好斷線也不會全桌卡死)。
         按座位錯開只是少幾次註定白跑的交易。
       ⚠ 下限 1200ms 兜底 —— 錨點是本地時鐘,慢半拍收到快照的那台會算出「已經過期」
         而一收到就代打(台灣麻將踩過)。
       ⚠⚠ **不可以因為 busy 就不排 timer**(v1.179.2 修)。倒數代打是**全桌唯一的救援**:
         它走 txGame,與本地動畫演到哪裡完全無關。第一版寫成 `|| busy` 就 return,
         於是「動畫被取消 → busy 卡住」的那一台**連倒數都不會武裝** ——
         沒有人幫他走,全桌就永遠停在那裡(這正是「三個人玩、一個人卡死但沒斷線」的
         後半段:前半段是 busy 卡住,見 board.js 的 bump())。
         ★ 兩道修正刻意互為多餘:就算哪天 busy 又被卡住,倒數還是會把局面推下去。
     ========================================================================== */
  function clearTurnT(){ if(turnT){ clearTimeout(turnT); turnT = null; } }

  function armTurnT(){
    clearTurnT();
    if(!secOn() || !st || st.over || !playing()) return;
    const seat = st.turn, me = mySeat();
    const wait = Math.max(1200, turnAt + turnSec * 1000 - Date.now()) + Math.max(0, me) * 150;
    /* ★ 記下「這顆計時器是照第幾手排的」。只給 e2e 用,但它是唯一問得出
       **「倒數是照這一手武裝的、還是上一手留下來的」** 的方法 —— 只問「有沒有 timer」
       的話,把 armTurnT() 搬回動畫後面照樣是綠的(上一手那顆還在)。 */
    armedLen = moves.length;
    turnT = setTimeout(() => { autoPlay(seat, moves.length); }, wait);
  }

  function autoPlay(seat, step){
    turnT = null;
    if(!st || st.over || st.turn !== seat || !playing()) return;
    // ★ 替人代打一律用「普通」,不套任何人的難度 —— 幫人打不該幫他打得特別好
    push(step, chk => FCAI.autoMove(chk, seat), chk => chk.turn === seat);
    /* ★★ 沒寫成就自己補排一次(v1.179.6)。交易有可能整個沒寫成:被別人搶先、
       伺服器上的真值不合法、或 canWriteGame() 因為離線把它擋下來。
       **沒寫成 = 不會有新的快照,而 armTurnT() 只在 applyGame 裡叫**
       → 這顆計時器就此死掉,這一台從此不再參與代打(全桌少一份保險)。
       ⚠ 局面真的推進了的話,applyGame 會用新的錨點把它換掉,所以這一行只在
         「什麼都沒發生」時生效;turnAt 沒變 → 走 armTurnT() 的 1200ms 下限重試。 */
    if(!turnT) armTurnT();
  }

  /* ==========================================================================
     四、結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數。
       ★ 一定要帶 { local:false } —— 見檔頭與 notes/07 踩坑 #8。
       ★ winner.pts = 名次分(核心為大老二加的能力)—— 靠它「第一名出線就結算」,
         不必等最後一名慢慢爬回家。
     ========================================================================== */
  function maybeSettle(){
    if(!st || !st.over || ctx.winner() || !playing()) return;
    const n = nPlayers(), ord = ctx.order();
    ctx.txGame(g => {
      if(g.winner) return false;
      const chk = FC.replay(rulesOf(g), n, Array.isArray(g.moves) ? g.moves : []);
      if(!chk || !chk.over) return false;
      const sc = FC.score(chk);
      const pts = {};
      sc.rows.forEach(r => { const id = ord[r.seat]; if(id) pts[id] = r.pts; });
      g.winner = { ids: sc.winners.map(s => ord[s]).filter(Boolean), pts: pts, by: "rank" };
    }, { local: false });
  }

  /* ==========================================================================
     五、這一手要不要演
     ──────────────────────────────────────────────────────────────────────────
       ★★★ 只有「剛好多一筆」才演。多兩筆以上 = 批次同步(重連歸位 / 分頁被凍結過),
           照著演會變成幾十秒的慢動作,而且那段時間完全不能操作。
     ========================================================================== */
  function applyOne(one, after){
    if(FC.isRoll(one)){
      setBusy(true);
      FCB.rollDie(one, () => { setBusy(false); after(); });
      return;
    }
    // 走子:st.last 就是動畫要的那一包(rules.js 的 step() 填的)
    setBusy(true);
    const mv = st.last;
    /* ★★★ 踩人 / 到家的現場效果走 FCB.drama() —— **完全在本地做,一個 DB 寫入都沒有**。
       「誰踩了誰」在 moves 裡是公開的,每一台各自 replay 都算得出同一件事;
       走 sendEmote 的話會變成 N 台各送一次(飛出 N 顆一樣的表情 + N 次 Firebase 寫入)。
       ⚠ 不要因為「表情本來就走 sendEmote」就順手改過去,理由見 board.js 第七節。

       ⚠⚠⚠ **整段一定要包在 try/catch 裡(v1.179.6)。** 這裡每一樣都是**純裝飾**
         (表情 / 震動 / 提示條),可是它們站在 `paint(mv, …)` 前面 ——
         而那個回呼是**唯一**能把 busy 放掉、也是唯一會叫 armTurnT() 的地方。
         少了這個 try/catch,任何一個裝飾丟例外就等於整台棋局停擺
         (現場回報:踩人的那一手之後兩台都說輪到對方)。
         **裝飾壞掉最多就是少一個效果,絕對不可以連帶把棋局卡住。**
       ⚠ v1.179.7 之前這裡還會自動放一句罐頭語音,而那是最脆的一條(iOS 音訊解鎖)。
         現在**不自動播了**(使用者:「比較希望這是自己去按出來,才會覺得好笑」),
         但這個 try/catch 一個字都不能拿掉 —— 它擋的是「裝飾」這一整類,不是那一句語音。 */
    const me = mySeat();
    try{
      if(mv && mv.eaten && mv.eaten.length){
        mv.eaten.forEach(e => {
          FCB.drama({ kind: "eat", byName: nameOfSeat(mv.seat), toName: nameOfSeat(e.seat),
                      toId: ctx.order()[e.seat] || ("s" + e.seat),
                      victim: e.seat === me });
        });
      }else if(mv && mv.home){
        FCB.drama({ kind: "home", byName: nameOfSeat(mv.seat), byId: ctx.order()[mv.seat] });
      }else if(mv){
        const t = FC.moveText(st, mv);
        if(t) showToast(esc(nameOfSeat(mv.seat)) + " " + t, 1400);
      }
    }catch(e){ console.error("fc drama", e); }
    paint(mv, () => { setBusy(false); after(); });
  }

  /* ==========================================================================
     六、mp-core 的 adapter 介面
     ========================================================================== */
  /* 大廳的規則說明。
     ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。
     ★★ v1.179.3 寫詳細了(使用者:「飛行棋其實很多人都不太會玩,所以規則的說明很重要,
        例如什麼狀況可以吃掉別人的棋子,或是什麼狀況可以跳」)——
        進場頁那一份是通用教學(見 flychess.html 的 .fc-howto),
        **這一份的價值在於它反映房主真的設了什麼**,所以每一條都要把當下的房規帶進去。
     ⚠ 三件最多人卡住的事各自獨立一行,不可以壓成一句:
       「自己顏色」是什麼、踩人只算**停下來**那一格、回家跑道與機場**踩不到**。 */
  function ruleHint(){
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,時間到系統會幫他走一步")
                        : "<b>不限時</b>——沒人催,有人離開就全桌一直等";
    const goal = rules.goal ? ("先送 <b>" + rules.goal + " 架</b>回家") : "把 <b>全部</b>飛機送回家";
    const nP = rules.planes;
    return "<b>目標</b>:把角落機場裡的飛機送到中央終點 🏁。這一局每人 <b>" + nP + " 架</b>,"
             + goal + "的人贏。<br>" +
           "<b>起飛</b>:擲到 <b>" + (rules.launch === "six" ? "6" : "1 或 6") +
             "</b> 才能放一架出來(放在自己的起飛點 ⭕)。<br>" +
           "<b>跳 4 格</b>:外圈是<b>四色輪流排</b>的 —— 走完剛好停在<b>自己顏色</b>那一格,再往前 4 格。<br>" +
           "<b>飛 12 格</b>:停在自己的<b>航線格</b>(你的顏色 + ◆)→ 飛 12 格,落點又是自家色 → 再跳 4," +
             "合計 <b>16 格</b>。<br>" +
           "<b>踩人</b>:<b>停下來</b>那一格上有別人的飛機 → 他那幾架<b>全部回機場</b>。" +
             "⚠ 只算停下來那一格,<b>經過 / 飛越不算</b>;自己人可以疊;" +
             "<b>回家跑道與機場裡的踩不到</b>。<br>" +
           "<b>擲到 6</b>:可以再擲一次;但<b>連三次 6 這一輪作廢</b>。<br>" +
           "<b>終點</b>:" + (rules.exact ? "<b>要剛好</b>走到才算(點數太大就走不了)"
                                          : "<b>超過就算到</b>") + "。<br>" +
           "<b>名次分</b>:第一名 5 分、第二 3 分、第三 1 分(依到家架數排)。<br>" +
           "<b>出手倒數</b>:" + sec + "。";
  }

  /* 房間設定的通用套用。★ 守門用**範圍**而不是白名單 —— 舊房間 / 手改 DB 的值也要能用 */
  const FIELDS = {
    turnSec: { get: () => turnSec, ok: v => typeof v === "number" && (v === 0 || (v >= 10 && v <= 90)),
               set: v => { turnSec = v; } },
    planes:  { get: () => rules.planes, ok: v => typeof v === "number" && v >= FC.MIN_PLANES && v <= FC.MAX_PLANES,
               set: v => { rules.planes = v; } },
    launch:  { get: () => rules.launch, ok: v => v === "one6" || v === "six",
               set: v => { rules.launch = v; } },
    goal:    { get: () => rules.goal, ok: v => typeof v === "number" && v >= 0 && v <= FC.MAX_PLANES,
               set: v => { rules.goal = v; } },
    exact:   { get: () => rules.exact, ok: v => typeof v === "boolean", set: v => { rules.exact = v; } }
  };

  return {
    ns: { rooms: "fc_rooms", index: "fc_index" },
    minPlayers: 2, maxPlayers: 4,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    /* ★★ 原班人馬可以回座(誤按離開 / 關分頁 / 斷線之後回到**還在打的那一場**)。
       ⚠⚠ 它**不是** joinMidGame:放行的只有 `game.order` 裡本來就有的那個 pid
         (全新的人照舊擋在外面)—— 完整的理由在 js/shared/mp-core.js 的 REJOIN_MID 那一段。
       ★ 有到期代擲 → 缺席的那幾手被代打掉,回來接著擲。 */
    rejoinMidGame: true,
    prefsKey: "flychess.prefs.v1",
    emoteAnchor: "fcStage",
    winCardId: "fcWinCard",
    hasResign: false,                      // 多人局「認輸」語意不清(同數獨 / 排七)
    orderPick: true,                       // 誰先擲:猜拳 / 隨機 / 房主排(js/shared/mp-order.js)
    /* 名次分(核心為大老二加的能力):第一名 5 / 第二 3 / 第三 1 分。
       ⚠ 單位是「分」不是「勝」→ 搶勝的目標值也要跟著放大(3 勝 → 10 分)。 */
    scoreUnit: "分", goalDefault: 10, goalMax: 50,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){
      return { turnSec: turnSec, planes: rules.planes, launch: rules.launch,
               goal: rules.goal, exact: rules.exact };
    },
    onRoomField(k, v){
      const f = FIELDS[k];
      if(!f || !f.ok(v) || v === f.get()) return;
      f.set(v);
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
      if(ctx.phase() === "playing" && k === "turnSec"){ armTurnT(); paint(); }
    },
    readRoom(r){
      Object.keys(FIELDS).forEach(k => { if(FIELDS[k].ok(r[k])) FIELDS[k].set(r[k]); });
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { fc: null, moves: [] }; },
    resetRound(){
      clearTurnT(); clearAutoOne();
      moves = []; st = null; gRules = null; curRound = null; lastLen = -1; setBusy(false);
      FCB.reset();
    },
    /* ★ picked 是 orderPick 決定出來的順序(第三個參數)。
       ⚠ 不可以自己去寫 game.order —— 那一格在大廳裝的是**上一局**的順序(notes/07)。
       ⚠⚠ 房規在這裡整包凍結:對局中改大廳設定影響不到這一局。 */
    newGame(ids, prev, picked){
      let ord = (picked && picked.length === ids.length) ? picked.slice() : ids.slice();
      if(!picked || picked.length !== ids.length){
        for(let i = ord.length - 1; i > 0; i--){
          const j = Math.floor(Math.random() * (i + 1));
          const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
        }
      }
      return { order: ord, fc: FC.normRules(rules), moves: [] };
    },
    applyGame(g, isPlaying){
      const next = Array.isArray(g.moves) ? g.moves : [];
      const prevLen = moves.length;
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);        // ★ 新局一律看 roundId
      gRules = rulesOf(g);
      moves = next.slice();
      if(!isPlaying){ st = null; return; }
      if(fresh){ curRound = rid; lastLen = -1; setBusy(false); FCB.reset(); }

      st = FC.replay(gRules, nPlayers(), moves);
      if(!st){ return; }                        // 房規壞掉(理論上不會)→ 等下一個快照

      // 這一手的錨點:手數變了就重新起算(公開動作,全桌看得到)
      if(moves.length !== lastLen){
        lastLen = moves.length;
        turnAt = Date.now();
      }

      /* ★★★ 倒數**一定要在動畫之前**就武裝(v1.179.6)。
         它算的是**牆上時間**,與本地動畫演到哪裡完全無關 —— 排在 applyOne 的回呼裡
         等於「動畫演完才有代打」,而只要那一手卡住(踩人的裝飾丟例外、onDone 沒被
         交出去…),這一台就連代打都不會排:全桌只剩對手那一顆計時器撐著。
         ⚠ 這與 v1.179.2 那條紅線是**同一個道理**(倒數代打不可以被 busy 擋住)——
           那一次修的是「不要因為 busy 就 return」,這一次修的是「不要排在動畫後面」。
         ⚠ 底下的回呼裡**仍然**留著一次 armTurnT():那一次是用演完之後的局面重排
           (錨點沒變,所以只是覆寫同一顆,冪等)。 */
      armTurnT();

      /* ★★★ 只有「剛好多一筆」才演;換局與批次同步一律直接落定 */
      if(!fresh && moves.length === prevLen + 1){
        applyOne(moves[moves.length - 1], () => {
          armTurnT();
          paint();
          maybeSettle();
          armAutoOne();
          /* ★ 「輪到我了」的一聲 + 自家機場一圈金光,排在 paint() **之後** ——
             它是回饋不是狀態。4 人局輪轉很快,現場常常是「在看別人對決 → 沒注意到
             輪到自己」(Gemini 建議書的「回合焦點感」)。 */
          if(isMyTurn() && !st.die){ Sound.turn(); FCB.turnCue(); }
        });
        return;
      }
      /* ★ 第三道保險:走到這裡就代表「這一張快照不演動畫」——
         那麼**不管上一手演到哪裡,都不該再擋著操作**。
         (board.js 的 bump() 已經會把 onDone 交出去,這一行是刻意的多餘:
          全桌卡死的代價太高,寧可兩邊都寫。) */
      setBusy(false);
      armTurnT();
      paint();
      maybeSettle();
      armAutoOne();
    },

    /* ---------- 相位的專屬畫面 ----------
       各相位只說「要哪個畫面」,實際的 hidden 切換交給 main.js 的 showScreen() */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ clearTurnT(); clearAutoOne(); showScreen("lobby"); },
    backToLobby(){
      clearTurnT(); clearAutoOne();
      moves = []; st = null; curRound = null; lastLen = -1; setBusy(false);
      FCB.reset();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      setBusy(false);
      FCB.reset();
      // ★ 這一局開打前大家各幾分(結果卡的「累計」欄要拿它加上去;見宣告處)
      baseWins = {};
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      FCB.fitBoard();
      paint();
    },
    onLeave(){
      clearTurnT(); clearAutoOne();
      moves = []; st = null; gRules = null; curRound = null; lastLen = -1; setBusy(false);
      baseWins = {};
      FCB.reset();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const segs = [
        ["fcSecSeg", "sec", turnSec, "fcSecLabel", "出手倒數"],
        ["fcPlanesSeg", "planes", rules.planes, "fcPlanesLabel", "每人幾架"],
        ["fcLaunchSeg", "launch", rules.launch, "fcLaunchLabel", "怎麼起飛"],
        ["fcGoalSeg", "goal", rules.goal, "fcGoalLabel", "怎麼算贏"],
        ["fcExactSeg", "exact", rules.exact ? 1 : 0, "fcExactLabel", "終點"]
      ];
      segs.forEach(([segId, attr, val, lblId, base]) => {
        const seg = $(segId);
        if(seg){
          seg.classList.toggle("readonly", !isHost);
          [...seg.children].forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(val)));
        }
        const lbl = $(lblId);
        if(lbl) lbl.textContent = isHost ? base : (base + "(房主決定)");
      });
      const hint = $("fcRuleHint");
      if(hint) hint.innerHTML = ruleHint();
    },
    updateGoal(){
      const g = $("mpBarGoal");
      if(!g) return;
      g.textContent = "✈️" + rules.planes + " · " + (rules.goal ? ("回" + rules.goal) : "全回") +
                      " · " + (secOn() ? (turnSec + "秒") : "不限時");
      g.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    turnId,
    /* ★ 晶片前面掛顏色點 —— 這一頁「你是哪一色」是規則的一部分(要知道哪些格子可以跳),
       不是裝飾。⚠ 大廳裡 order 是空的 → 算不出顏色就不掛(掛一顆算錯的比不掛更誤導)。 */
    chipLead(id){
      if(!st) return null;
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return null;
      return '<span class="fc-dot" data-c="' + st.colors[s] + '"></span>';
    },
    // 晶片尾巴:到家幾架 / 目標幾架(措辭與單機那份 solo.js tailOf() 一樣)
    chipTail(id){
      if(!st) return "";
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return "";
      return '<span class="fc-ct" title="到家幾架">' +
             FC.homeCount(st, s) + "/" + st.rules.goal + "</span>";
    },
    lobbyStatusText(ids){ return ids.length < 2 ? "等待其他人加入…" : "等待大家準備…"; },
    readyHint(ids, ready){
      return ids.length < 2 ? "等別人加入…(房間可分享給朋友)"
                            : (ready ? "等其他人按準備…" : "按「準備好了」就開始");
    },
    refresh(){ if(st && !busy) paint(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, ids }){
      clearTurnT(); clearAutoOne();
      FCB.stopCd();
      const ord = ctx.order();
      const sc = (st && st.over) ? FC.score(st) : null;
      const box = $("fcResult");
      if(box && sc){
        const names = ord.map(id => ctx.dispName(id));
        /* ★ 累積分數併進排名表 —— 連線的結果卡從此只有**一張表**。
           底數用開局快照,所以不必等 scores 節點同步回來。 */
        const wins = ord.map((id, s) => {
          const plus = (w && w.pts && w.pts[id]) || 0;
          const base = (typeof baseWins[id] === "number") ? baseWins[id] : ctx.scoreOf(id);
          return { n: base + plus, plus: plus };
        });
        box.innerHTML = FCB.resultHTML(sc, names, mySeat(), "", wins);
        box.classList.remove("hidden");
      }
      if(st && !busy) paint();
      const me = mySeat();
      const row = sc ? sc.rows[me] : null;
      /* ★ 一句話就好:底下的排名表已經逐列寫著「誰第幾名 / 到家幾架 / 拿幾分」。
         ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。
         ⚠ 措辭與單機那份(solo.js 的 finish())刻意寫成同一個格式。 */
      if(iWon){
        return { word: "你贏了!",
                 msg: row ? ("你的 <b>" + row.home + "</b> 架先回到家 🎉") : "你先把飛機送回家了 🎉" };
      }
      const ws = ((w && w.ids) || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: row ? ("第 " + row.rank + " 名") : "這局結束",
               msg: (ws ? (ws + " 先回家") : "這局結束") +
                    (row ? (" · 你到家 <b>" + row.home + "</b> 架 · 這局 <b>+" + row.pts + "</b> 分") : "") };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大 / 小:存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){
      return { turnSec: turnSec, planes: rules.planes, launch: rules.launch,
               goal: rules.goal, exact: rules.exact, big: BigMode.get() };
    },
    usePrefs(o){
      BigMode.set(!!o.big);
      Object.keys(FIELDS).forEach(k => { if(FIELDS[k].ok(o[k])) FIELDS[k].set(o[k]); });
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      roll, tapPlane, isMyTurn,
      turnSec: () => turnSec,
      rules: () => JSON.parse(JSON.stringify(rules)),
      setTurnSec(v){ setField("turnSec", v, SECS.indexOf(v) >= 0, "倒數"); },
      setPlanes(v){ setField("planes", v, v >= FC.MIN_PLANES && v <= FC.MAX_PLANES, "架數"); },
      setLaunch(v){ setField("launch", v, v === "one6" || v === "six", "起飛條件"); },
      setGoal(v){ setField("goal", v, v >= 0 && v <= FC.MAX_PLANES, "勝利條件"); },
      setExact(v){ setField("exact", !!v, true, "終點規則"); },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      _moves: () => moves.slice(),
      /* 給 e2e 用:動畫演到一半時 roll() / tapPlane() 會被擋掉(那是對的 —— 兩件事
         疊在一起玩家看不懂)。測試少了這個入口就只能用固定秒數猜,而猜錯的症狀是
         **偶發**紅在「按了沒反應」。 */
      _busy: () => busy,
      /* 給 e2e 用:把這一手的錨點往回撥,免得測「到期自動走棋」要真的等 30 秒。
         同排七的 _ageTurn() —— 那類機制只有時間會觸發,e2e 等不了。 */
      _ageTurn(ms){ turnAt -= (+ms || 0); armTurnT(); paint(); },
      /* 給 e2e 用:把 busy 看門狗的上限調短(同 _ageTurn 的道理 —— 那顆只有時間會觸發,
         照 5 秒等會讓整份 e2e 慢一大截)。⚠ 只改上限,不改行為。 */
      _busyMax(ms){ busyMax = Math.max(20, +ms || 0); },
      /* 給 e2e 用:把「唯一的選項自動走」關掉 / 打開(見二之二節)。
         ⚠ 這不是偏好也不是房規 —— **正式玩一律是開的**,這個入口只給測試,
           因為它會把「輪到我、還沒選飛機」那個前提自己吃掉(偶發假紅的來源)。 */
      _autoOne(on){ autoOne = !!on; if(!autoOne) clearAutoOne(); else armAutoOne(); },
      /* 給 e2e 用:倒數代打的計時器現在是照**第幾手**武裝的(沒武裝 = -1)。
         ⚠ 不可以只回 true/false —— 上一手留下來的那顆也是 true,
           把 armTurnT() 搬回動畫後面照樣量得到「有武裝」(那條突變會存活)。 */
      _armed: () => turnT ? armedLen : -1
    }
  };

  function setField(key, val, valid, what){
    if(!valid) return;
    if(!ctx.setRoomField(key, val, { lobbyOnly: true, denyMsg: "只有房主能改" + what,
                                     busyMsg: "對戰中不能改" + what })) return;
    FIELDS[key].set(val);
    ctx.syncSetup(); ctx.updateGoal(); savePrefs();
  }
})());

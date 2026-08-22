"use strict";

/* ============================================================================
   跳棋 — 連線適配器(接上 js/shared/mp-core.js)

   ── DB 上只有兩個欄位就夠了 ──────────────────────────────────────────────
     `tq`(這一局凍結的房規)+ `moves`(一手一個整數 = from×121+to)。
     **零亂數、零隱藏資訊** → 每台各自 TQ.replay(tq, n, moves) 就是完整局面,
     連 `deal` 都不需要(這是十四個遊戲裡最簡單的一個真相模型)。

   ══════════════════════════════════════════════════════════════════════════
   ★★★ 這一支與另外十三個最大的差別:**同步正確性優先於反應速度**
   ══════════════════════════════════════════════════════════════════════════
     > 使用者(2026-08-16):「除非是有人斷線了,不然寧可要稍微延遲一點,
     >   也不要出現兩邊同步不完全的問題,這樣很辛苦的玩到最後結果就壞掉了,
     >   是一種很糟糕的體驗」

     三次現場事故(暗棋 v1.177.3、飛行棋 v1.179.2 / v1.179.6)**沒有一次是 DB 上的
     真相不一致** —— 單一 game 節點 + 單調遞增 rev + 交易那一層從 Bingo 一路修到現在
     已經很硬,兩台的 moves 不可能不同。壞掉的全部是**本地那一層**,而且共同結構是
     同一句話:

       **「能不能繼續玩」被掛在一條會斷的本地鏈上,而斷掉之後沒有一條回到真相的路。**

     所以這一頁從第一版就照五條寫。⚠ 它們大多是「**少做**」而不是「多做」:

       ① 【不搶跑】每一手都走 txGame(mut, { local:false }) —— 送出後本地一格都不動,
          等伺服器的快照回來才動。代價是一趟往返(約 100~300ms),
          換來「本地永遠不會出現一個之後會被推翻的狀態」。
          ★ 跳棋付得起:它**完全沒有搶快**(不搶格、不搶牌、不搶出牌),
            而且 30~45 手 × 0.3 秒 ≈ 10 秒,相對於一局 7~15 分鐘。
          ⚠⚠ 「不樂觀」不等於「按下去沒反應」——
            **可以樂觀的是「回饋」(那顆棋畫成送出中),不可以樂觀的是「狀態」**。

       ② 【動畫不是必經之路】board.js 的 render() 一進去就把每顆棋落到真相位置,
          動畫只是把飛行中那一顆暫時拉回路徑上(位置 = f(now))。
          → 動畫沒跑 / 被打斷 / 分頁凍結,畫面都是對的,而且**這一支不等任何回呼**。

       ③ 【不用旗標擋操作】沒有 busy。點擊一律受理,判斷只問**真相層**
          (現在真的輪到我嗎、這一手合法嗎),不行就講一句話。
          去重靠交易本身的冪等(moves.length 對不上就中止)——
          moves.length 是真相,不會卡住;busy 是本地旗標,會。
          ★ 這是 CLAUDE.md 踩坑 #6 的老規矩:不要讓格子靜默吃掉點擊。

       ④ 【無條件對帳】每 3 秒比一次「畫面畫到第幾手」與「真相是第幾手」,
          不同就無條件重畫。它不依賴任何回呼、任何本地旗標 ——
          這正是前三次事故都缺的那一條路。
          ⚠ 與飛行棋 v1.179.6 的 busy 看門狗的差別:看門狗守的是**症狀**(旗標卡住),
            對帳守的是**目標**(畫面 = 真相)。

       ⑤ 【裝飾隔離】表情 / 音效 / 震動一律各自 try/catch,而且
          **對局中途不自動碰音訊子系統**(不自動放罐頭語音,見 board.js 第七節)。

   ── ★★ 房規在開局那一刻凍結(比照 21 點 / 飛行棋)────────────────────────
     replay 吃的是 g.tq 而不是大廳現在的設定 —— 房規一變,同一份 moves 會 replay 出
     完全不同的盤面(棋子數不同 = 起始擺法不同)。
   ========================================================================== */

const MP = MPCore.create((function(){

  const SECS = [0, 20, 40, 90];        // 出手倒數;預設值也寫在 tiaoqi.html 的 .on
  let turnSec = 40;
  let rules = { pieces: 6 };           // 大廳裡「下一局要用」的房規
  let ctx = null;

  let moves = [], st = null, gRules = null;
  let curRound = null;
  let lastLen = -1, turnAt = 0;
  let turnT = null, armedLen = -1;

  /* ---------- 本地 UI 狀態(★ 這三個都**不是**遊戲狀態)----------
     sel     我選中的那一顆的洞 id
     spots   它能走到哪
     pending 送出中、還沒被伺服器確認的那一顆 —— **純視覺**,不擋任何操作 */
  let sel = -1, spots = [], pending = -1, pendingT = null;
  const PENDING_MS = 4000;             // 交易沒寫成時把「送出中」的樣子收掉(只是視覺)

  let syncT = null;                    // ★ 第四條:對帳心跳
  const SYNC_MS = 3000;

  /* ★ 開局那一刻每個人的累積分數快照(結果卡的「累計」欄用)。
     為什麼不當場讀 scores:那個節點是**結算之後**每台各自寫自己的分,
     而結果卡是結算當下就要畫出來。 */
  let baseWins = {};

  const seatOf = id => ctx.order().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  const nPlayers = () => ctx.order().length;
  const secOn = () => turnSec > 0;
  const playing = () => ctx.phase() === "playing" && !ctx.winner() && !ctx.abandoned();
  const rulesOf = g => TQ.normRules((g && g.tq) || rules);
  function nameOfSeat(s){
    const id = ctx.order()[s];
    return id ? ctx.dispName(id) : ("玩家" + (s + 1));
  }

  /* ---------- 輪到誰 ----------
     ★ 這一頁的 turn 與 moves.length 其實是一比一的(連跳是一手之內的多段),
       但仍然一律問 replay 出來的 st.turn —— 與另外十三頁同一個習慣,而且
       哪天加上「逾時跳過」就會當場破功。 */
  function turnId(){
    if(!st || st.over) return null;
    return ctx.order()[st.turn] || null;
  }
  const isMyTurn = () => !!(st && !st.over && playing() && st.turn === mySeat());

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  /* ★ 「這一顆最遠能飛幾段」——★ 段數標籤在洞上只有 5~6px 高(見 board.js 的
     data-j 註解),真正讀得到「⚡」這個字的地方是這一列。
     ⚠ 提示列是**固定高**的(紅線 18):這一句只能加短的,加長就把盤面推小一階。 */
  function longHint(){
    let m = 0;
    spots.forEach(s => { if(s.jumps > m) m = s.jumps; });
    return m >= 2 ? ' · <b class="tq-jn">⚡ 最長 ' + m + ' 段</b>' : "";
  }
  /* ★★★ 新手救星:「這一手最遠能飛幾段」——**刻意不說是哪一顆**(v2.7.1)。
     ──────────────────────────────────────────────────────────────────────────
       建議書要的是「透光神級路徑 + 搭橋雷達」:直接把 AI 算出的最佳步法標在盤面上。
       ⚠ 那條路在這一頁行不通,而且不是技術問題:
         ① 它自己也承認要限定在單機(連線會變成「比誰抄得快」);
         ② 而**跳棋新手真正卡住的不是「哪一顆」,是「有沒有」** ——
            他看不出盤面上存在一條 5 段的路,所以只走一格、玩得很無聊。
       ★ 所以只給**目標**不給答案:告訴他「這一手最遠能飛 N 段」,自己去找那一顆。
         這樣它在連線也成立(段數是公開資訊,每一台各自 replay 都算得出同一個數),
         而且**兩邊的措辭因此可以一模一樣** —— 不必再多一組會走鐘的雙胞胎。
     ⚠ 提示列是**固定高**的(紅線 18):這一句只能加短的。
     ⚠ 與另一份是雙胞胎(solo.js / adapter.js),改一邊要改另一邊。 */
  function reachHint(seat){
    if(!st || st.over) return "";
    let m = 0;
    TQ.allMoves(st, seat).forEach(a => { if(a.jumps > m) m = a.jumps; });
    return m >= 2 ? ' · <b class="tq-jn">⚡ 最遠 ' + m + ' 段</b>' : "";
  }

  function hintText(){
    if(!st || st.over) return "";
    const who = esc(nameOfSeat(st.turn));
    if(!isMyTurn()) return who + " 正在想…";
    if(pending >= 0) return "送出中…";
    if(sel >= 0) return spots.length ? ("點一個亮起來的洞" + longHint()) : "這一顆走不動 —— 換一顆";
    return "輪到你了 —— 點一顆自己的棋" + reachHint(mySeat());
  }

  function paint(anim){
    if(!st) return;
    TQB.render({
      st: st, mySeat: mySeat(), sel: sel, spots: spots,
      anim: anim || null, pending: pending
    });
    TQB.renderActs({
      hint: hintText(),
      // 倒數給全桌看(誰還剩幾秒是公開資訊,大家才知道在等什麼)
      cdMs: secOn() ? turnSec * 1000 : 0,
      cdEnd: secOn() ? turnAt + turnSec * 1000 : 0,
      /* ⚠ 但「剩 3 秒那一聲」只能響在自己的回合 —— 環給全桌看,聲音不行
         (六人局每家都嗶就是一局嗶上百次)。 */
      cdMine: isMyTurn()
    });
    ctx.renderPlayers();
  }

  /* ==========================================================================
     二、送出一手 —— ★★★ 第一條:不搶跑
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對(同排七 / 飛行棋 send() 的守衛)。
       ⚠⚠ **{ local:false } 是這一頁的核心**(見檔頭①):
         Firebase 的交易預設會先在本地樂觀套用並發出 value 事件,而那個「樂觀的我」
         之後可能被伺服器真值推翻 —— 那正是暗棋 v1.177.3「幻影盤面」的根,
         也是「兩台看到不一樣的畫面」唯一還剩下的入口。這一頁把它關掉。
     ========================================================================== */
  function push(step, mkMove, guard){
    const n = nPlayers();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const mv = Array.isArray(g.moves) ? g.moves : [];
      // ★ 第三條的去重:這一手已經被推進了 → 中止,等快照(冪等,而且不需要本地旗標)
      if(mv.length !== step) return false;
      const chk = TQ.replay(rulesOf(g), n, mv);
      if(!chk || chk.over) return false;
      if(guard && !guard(chk)) return false;
      const one = mkMove(chk);
      if(one == null || one < 0) return false;
      if(!TQ.step(chk, one)) return false;              // 伺服器真值上不合法 → 不寫
      g.moves = mv.concat(one);
    }, { local: false });
  }

  function sendMove(from, to){
    const me = mySeat(), step = moves.length;
    push(step, () => TQ.encMove(from, to),
         chk => chk.turn === me && !!TQ.moveOf(chk, me, from, to));
    // ★ 純視覺的「送出中」。⚠ 它不擋任何操作,只是讓玩家知道點到了
    markPending(from);
    /* ★★★ 加上「聽得到的」送出回饋(v2.3.4)。這一頁刻意不樂觀(檔頭①):送出之後
       本地一格都不動,要等 100~300ms 的往返 —— 在此之前那段空窗**完全沒有聲音**,
       而第 3.2 節那張表明明寫著「回饋可以樂觀、狀態不可以」。
       ⚠ 它是裝飾:自己包起來,絕不可以把例外丟進送出這條路(飛行棋 v1.179.6 的教訓)。 */
    try{ TQB.SFX.send(); }catch(e){ console.error("tq sfx:send", e); }
  }

  function markPending(id){
    pending = id;
    if(pendingT) clearTimeout(pendingT);
    /* ⚠ 交易有可能整個沒寫成(被搶先 / 伺服器真值不合法 / 離線被 canWriteGame 擋下)——
       沒寫成就不會有新快照,這個記號要自己收掉。**它只是視覺**,收晚了也不影響操作。 */
    pendingT = setTimeout(() => { pendingT = null; pending = -1; paint(); }, PENDING_MS);
  }
  function clearPending(){
    if(pendingT){ clearTimeout(pendingT); pendingT = null; }
    pending = -1;
  }

  /* ==========================================================================
     三、玩家操作 —— ★★★ 第三條:不用旗標擋,判斷只問真相層
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 一律受理點擊、一律講得出原因(CLAUDE.md 踩坑 #6:不要讓格子靜默吃掉點擊)。
         飛行棋的 `if(busy) return` 就是這條教訓的復發,而且是**靜默的** ——
         玩家一直按,什麼事都沒發生、也沒有任何訊息。
     ========================================================================== */
  function tapPiece(seat, i){
    if(!ok2play()) return;
    const me = mySeat();
    if(seat !== me){ showToast("那是 " + esc(nameOfSeat(seat)) + " 的棋"); return; }
    const id = st.pieces[seat][i];
    if(id === sel){ sel = -1; spots = []; paint(); return; }     // 再點一次 = 取消
    selectPiece(id);
  }
  function tapHole(id){
    if(!ok2play()) return;
    const hit = spots.filter(s => s.to === id)[0];
    if(hit){ doMove(sel, id, hit.path); return; }
    // 點到自己的另一顆棋(棋子壓在洞上面時 closest 會先命中棋子,這裡是保險)
    const O = TQ.occOf(st);
    if(O[id] === mySeat()){ selectPiece(id); return; }
    if(sel >= 0){ sel = -1; spots = []; paint(); }
  }
  function selectPiece(id){
    sel = id;
    spots = TQ.movesFrom(st, id);
    /* ⚠ 有路 / 死路要**不同的聲音**:在此之前兩者都是 pick(),
       等於聲音先說「選到了」、字才說「但走不了」。 */
    if(spots.length) TQB.SFX.pick();
    else { TQB.SFX.blocked(); showToast("這一顆四面都被擋住了 —— 換一顆"); }
    paint();
  }
  function doMove(from, to, path){
    sel = -1; spots = [];
    sendMove(from, to);
    paint();
    void path;
  }
  // 「現在能不能動」——★ 只問真相層,不看動畫、不看 pending
  function ok2play(){
    if(ctx.phase() !== "playing"){ return false; }
    if(ctx.winner() || ctx.abandoned()) return false;
    if(!st || st.over) return false;
    if(!isMyTurn()){ showToast("還沒輪到你"); return false; }
    return true;
  }

  /* ==========================================================================
     四、出手倒數 —— 到期幫他走一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主:每一台都排 timer,誰先響誰用交易搶(房主剛好斷線也不會全桌卡死)。
       ⚠ 下限 1200ms 兜底 —— 錨點是本地時鐘,慢半拍收到快照的那台會算出「已經過期」
         而一收到就代打(台灣麻將踩過)。
       ★★ 這一頁的 armTurnT() **結構上就不可能被動畫擋住**:它直接在 applyGame 裡叫,
         而 applyGame 裡沒有任何回呼鏈(飛行棋 v1.179.2 / v1.179.6 兩次都栽在
         「倒數排在動畫後面 / 被 busy 擋掉」)。
     ========================================================================== */
  function clearTurnT(){ if(turnT){ clearTimeout(turnT); turnT = null; } }

  function armTurnT(){
    clearTurnT();
    if(!secOn() || !st || st.over || !playing()) return;
    const seat = st.turn, me = mySeat();
    const wait = Math.max(1200, turnAt + turnSec * 1000 - Date.now()) + Math.max(0, me) * 150;
    /* ★ 記下「這顆計時器是照第幾手排的」。只給 e2e 用,但它是唯一問得出
       **「倒數是照這一手武裝的、還是上一手留下來的」** 的方法。 */
    armedLen = moves.length;
    turnT = setTimeout(() => { autoPlay(seat, moves.length); }, wait);
  }

  function autoPlay(seat, step){
    turnT = null;
    if(!st || st.over || st.turn !== seat || !playing()) return;
    /* ★ 逾時的那個人要知道「那一手不是我下的」—— 在此之前畫面與聲音都跟自己走的一模一樣。
       ⚠ 只響在自己這一台的自己那一座:armTurnT() 每台都替**當下那一家**排計時器,
         不加這道守衛就會替別人逾時而在自己這裡響。
       ⚠⚠ 語氣要中性(像時鐘),**不可以做成錯誤音** —— 代打是幫他。 */
    if(seat === mySeat()){ try{ TQB.SFX.auto(); }catch(e){ console.error("tq sfx:auto", e); } }
    // ★ 替人代打一律用「普通」,不套任何人的難度 —— 幫人打不該幫他打得特別好
    push(step, chk => TQAI.autoMove(chk, seat), chk => chk.turn === seat);
    /* ★★ 沒寫成就自己補排一次(飛行棋 v1.179.6 的教訓):交易有可能整個沒寫成,
       而**沒寫成 = 沒有新快照,而 armTurnT() 只在 applyGame 裡叫**
       → 這顆計時器就此死掉,這一台從此不再參與代打(全桌少一份保險)。 */
    if(!turnT) armTurnT();
  }

  /* ==========================================================================
     五、★★★ 第四條:對帳心跳 —— 一條無條件回到真相的路
     ──────────────────────────────────────────────────────────────────────────
       前三條都是「不要製造脫節」;這一條是「萬一還是脫節了,一定追得回來」。
       ⚠ 它**不依賴任何回呼、任何本地旗標**,只比兩個東西:
         畫面上畫到的局面(TQB._shown())vs 真相(st.pieces)。
       ★ 因為畫面是真相的純函式(board.js 的 render 一進去就 placeAll),
         這個比對只是比幾個整數,很便宜。
       ⚠ 動畫演到一半時不要插手(那時畫面本來就「不等於」真相)——
         但**最多只讓它跳過一次**:動畫最長 8 段 × 150ms = 1.2 秒 < 心跳 3 秒。
     ========================================================================== */
  function startSync(){
    stopSync();
    syncT = setInterval(reconcile, SYNC_MS);
  }
  function stopSync(){ if(syncT){ clearInterval(syncT); syncT = null; } }

  function reconcile(){
    if(!playing() || !st) return;
    if(TQB._flying()) return;                       // 演到一半 —— 下一拍再看
    const shown = TQB._shown();
    if(!shown || !samePieces(shown, st.pieces)){
      console.warn("tq reconcile: 畫面與真相不一致,重畫");
      paint();
    }
  }
  function samePieces(a, b){
    if(!a || !b || a.length !== b.length) return false;
    for(let s = 0; s < a.length; s++){
      if(!a[s] || !b[s] || a[s].length !== b[s].length) return false;
      for(let i = 0; i < a[s].length; i++) if(a[s][i] !== b[s][i]) return false;
    }
    return true;
  }

  /* ==========================================================================
     六、結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數。
       ★ 一定要帶 { local:false } —— notes/07 踩坑 #8(這一頁本來就每一筆都帶)。
       ★ winner.pts = 名次分(核心為大老二加的能力)—— 靠它「第一名出線就結算」,
         這在跳棋比在飛行棋更關鍵:最後一名要爬完全程可能還要好幾分鐘。
     ========================================================================== */
  function maybeSettle(){
    if(!st || !st.over || ctx.winner() || !playing()) return;
    const n = nPlayers(), ord = ctx.order();
    ctx.txGame(g => {
      if(g.winner) return false;
      const chk = TQ.replay(rulesOf(g), n, Array.isArray(g.moves) ? g.moves : []);
      if(!chk || !chk.over) return false;
      const sc = TQ.score(chk);
      const pts = {};
      sc.rows.forEach(r => { const id = ord[r.seat]; if(id) pts[id] = r.pts; });
      g.winner = { ids: sc.winners.map(s => ord[s]).filter(Boolean), pts: pts, by: "rank" };
    }, { local: false });
  }

  /* ==========================================================================
     七、★★ 第五條:現場效果 —— 裝飾一律隔離
     ──────────────────────────────────────────────────────────────────────────
       ⚠⚠⚠ 這裡每一樣都是**純裝飾**,一個都不准把例外丟出去。
         飛行棋 v1.179.6 的現場當機就是「踩人的罐頭語音丟例外」把整台棋局卡住 ——
         這一頁雖然沒有任何東西擋在它後面(第二 / 第三條已經把那條鏈拆掉了),
         **這個 try/catch 一樣要有**:裝飾壞掉最多少一個效果。
       ⚠ 借道 / 長鏈 / 到家都是 replay 算得出來的公開事實 →
         **完全在本地做,一個 DB 寫入都沒有**(走 sendEmote 會變成 N 台各送一次)。
     ========================================================================== */
  /* ★★ v2.3.4 起「哪一種效果 / 疊哪幾顆聲音」一律由 TQB.drama() 決定,這裡只把那一手
     交過去(單機那一份也是同一支)—— 在此之前門檻是雙胞胎而且已經走鐘了
     (這邊 `borrowed > 0`、solo 那邊 `borrowed > 0 && jumps >= 2`)。
     ⚠ 它回「有沒有做出表情」;沒有才補那句 toast。 */
  function drama(mv){
    if(!mv) return;
    try{
      const shown = TQB.drama({ mv: mv, byName: nameOfSeat(mv.seat), toName: "別人",
                                byId: ctx.order()[mv.seat], victim: false });
      if(!shown && mv.seat !== mySeat()){
        const t = TQ.moveText(mv);
        if(t) showToast(esc(nameOfSeat(mv.seat)) + " " + t, 1300);
      }
    }catch(e){ console.error("tq drama", e); }
  }

  /* ==========================================================================
     八、mp-core 的 adapter 介面
     ========================================================================== */
  /* 大廳的規則說明。
     ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。
     ★★ 跳棋與五子棋 / 大老二不同:**跳的規則沒玩過完全猜不到**,所以這一份要寫詳細,
        而且要把當下的房規帶進去(進場頁那一份是通用教學,這一份反映房主設了什麼)。 */
  function ruleHint(){
    const n = nPlayers();
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,時間到系統會幫他走一步")
                        : "<b>不限時</b>——沒人催,有人離開就全桌一直等";
    const mins = estMinutes(n || 2, rules.pieces);
    return "<b>目標</b>:把你角落的 <b>" + rules.pieces + " 顆</b>棋子,全部搬到<b>正對面</b>那個角。" +
             "先搬完的人贏,其餘依進度排名次。<br>" +
           "<b>怎麼走</b>:每一手只動<b>一顆</b>,兩種選一種 —— " +
             "①往旁邊<b>走一格</b>(六個方向的空洞) " +
             "②<b>跳過緊鄰的一顆棋</b>落到它正後方的空洞。<br>" +
           "<b>連跳</b>:跳完之後如果還跳得動,可以<b>一直跳下去</b>(同一手之內)。" +
             "⚠ 但<b>走一格就結束</b>,不能走完再跳。<br>" +
           "<b>★ 誰的棋都能當跳板</b>:對手的棋<b>不是障礙,是橋</b> —— " +
             "這是跳棋唯一會用到別人的地方,也是連跳鏈變長的關鍵。<br>" +
           "<b>不吃子</b>:跳過去<b>不會</b>把人打掉,棋子只會移動、不會消失。<br>" +
           "<b>卡住怎麼辦</b>:你的目標角就是<b>對面那家的老家</b> —— 他要是有一顆賴著不走," +
             "那個洞算你<b>已經填到</b>(不然會永遠玩不完)。<br>" +
           (TQ.lopsided(n) ? "<b>⚠ 5 人局</b>:六個角坐五個人,會有<b>一家的目標角是空的</b>(略佔便宜)。<br>" : "") +
           "<b>名次分</b>:第一名分數最高,依到家顆數與剩餘距離排。<br>" +
           "<b>出手倒數</b>:" + sec + "。<br>" +
           "<b>大約多久</b>:" + n + " 人 · 每人 " + rules.pieces + " 顆 ≈ <b>" + mins + " 分鐘</b>。";
  }
  /* 一局大概多久(node 自我對局量出來的中位手數 × 每手 5 秒;見 notes/23)。
     ⚠ 這是**量出來的**不是猜的 —— 而且它是房主唯一看得到的「這局會不會太長」提示。 */
  const EST = {
    2:  { 3: 5,  6: 7,  10: 10 },
    3:  { 3: 7,  6: 10, 10: 14 },
    4:  { 3: 9,  6: 12, 10: 15 },
    5:  { 3: 10, 6: 13, 10: 17 },
    6:  { 3: 12, 6: 15, 10: 20 }
  };
  function estMinutes(n, p){
    const row = EST[n] || EST[6];
    return row[p] || row[6];
  }

  /* 房間設定的通用套用。★ 守門用**範圍**而不是白名單 —— 舊房間 / 手改 DB 的值也要能用 */
  const FIELDS = {
    turnSec: { get: () => turnSec, ok: v => typeof v === "number" && (v === 0 || (v >= 10 && v <= 180)),
               set: v => { turnSec = v; } },
    pieces:  { get: () => rules.pieces, ok: v => TQ.PIECE_OPTS.indexOf(v) >= 0,
               set: v => { rules.pieces = v; } }
  };

  return {
    ns: { rooms: "tq_rooms", index: "tq_index" },
    minPlayers: 2, maxPlayers: 6,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    prefsKey: "tiaoqi.prefs.v1",
    emoteAnchor: "tqStage",
    winCardId: "tqWinCard",
    hasResign: false,                      // 多人局「認輸」語意不清(同數獨 / 排七 / 飛行棋)
    orderPick: true,                       // 誰先走:猜拳 / 隨機 / 房主排(js/shared/mp-order.js)
    /* 名次分(核心為大老二加的能力)。⚠ 單位是「分」不是「勝」→ 搶勝目標也要放大 */
    scoreUnit: "分", goalDefault: 10, goalMax: 50,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { turnSec: turnSec, pieces: rules.pieces }; },
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
    lobbyGame(){ return { tq: null, moves: [] }; },
    resetRound(){
      clearTurnT(); stopSync(); clearPending();
      moves = []; st = null; gRules = null; curRound = null; lastLen = -1;
      sel = -1; spots = [];
      TQB.reset();
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
      return { order: ord, tq: TQ.normRules(rules), moves: [] };
    },

    /* ★★★ 這一支是整個檔案的重點,而且它**刻意很短**:
         算真相 → 武裝倒數 → 畫一次(順便決定要不要演動畫)→ 結算。
       沒有旗標、沒有回呼鏈、沒有「演完再說」的分支 —— 每一條路徑都走到 paint()。 */
    applyGame(g, isPlaying){
      const next = Array.isArray(g.moves) ? g.moves : [];
      const prevLen = moves.length;
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);        // ★ 新局一律看 roundId
      gRules = rulesOf(g);
      moves = next.slice();
      if(!isPlaying){ st = null; return; }
      if(fresh){ curRound = rid; lastLen = -1; sel = -1; spots = []; clearPending(); TQB.reset(); }

      st = TQ.replay(gRules, nPlayers(), moves);
      if(!st) return;                          // 房規壞掉(理論上不會)→ 等下一個快照

      // 這一手的錨點:手數變了就重新起算(公開動作,全桌看得到)
      if(moves.length !== lastLen){
        lastLen = moves.length;
        turnAt = Date.now();
        clearPending();                        // 局面推進了 → 送出中的記號一定要收掉
        sel = -1; spots = [];                  // 選取是上一個局面的,一律清掉
      }

      armTurnT();                              // ★ 排在畫面之前:它算的是牆上時間

      /* ★★★ 只有「剛好多一筆」才演動畫;換局與批次同步一律直接落定。
         ⚠ 演不演**都不影響正確性**(board.js 的 render 一進去就把棋落到真相位置)——
           這裡只是不要讓斷線重連的人看著棋子把前面幾十手重走一遍。 */
      let anim = null;
      if(!fresh && moves.length === prevLen + 1 && st.last && st.last.path){
        const seat = st.last.seat;
        const idx = st.pieces[seat] ? st.pieces[seat].indexOf(st.last.to) : -1;
        if(idx >= 0) anim = { seat: seat, idx: idx, path: st.last.path };
        drama(st.last);                        // ⚠ 裝飾:自己包 try/catch,不擋下面
        if(isMyTurn()) Sound.turn();
      }
      paint(anim);
      maybeSettle();
    },

    /* ---------- 相位的專屬畫面 ----------
       各相位只說「要哪個畫面」,實際的 hidden 切換交給 main.js 的 showScreen() */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ clearTurnT(); stopSync(); showScreen("lobby"); },
    backToLobby(){
      clearTurnT(); stopSync(); clearPending();
      moves = []; st = null; curRound = null; lastLen = -1; sel = -1; spots = [];
      TQB.reset();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      clearPending();
      sel = -1; spots = [];
      TQB.reset();
      // ★ 這一局開打前大家各幾分(結果卡的「累計」欄要拿它加上去)
      baseWins = {};
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      TQB.fitBoard();
      startSync();                             // ★ 第四條:對帳心跳只在對局中跑
      paint();
    },
    onLeave(){
      clearTurnT(); stopSync(); clearPending();
      moves = []; st = null; gRules = null; curRound = null; lastLen = -1;
      sel = -1; spots = []; baseWins = {};
      TQB.reset();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const segs = [
        ["tqSecSeg", "sec", turnSec, "tqSecLabel", "出手倒數"],
        ["tqPieceSeg", "pieces", rules.pieces, "tqPieceLabel", "每人幾顆"]
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
      const hint = $("tqRuleHint");
      if(hint) hint.innerHTML = ruleHint();
    },
    updateGoal(){
      const g = $("mpBarGoal");
      if(!g) return;
      g.textContent = "⬢" + rules.pieces + " 顆 · " + (secOn() ? (turnSec + "秒") : "不限時");
      g.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    turnId,
    /* ★ 晶片前面掛顏色點 —— 這一頁「你是哪一色」是規則的一部分(要知道往哪個角走),
       不是裝飾。⚠ 大廳裡 order 是空的 → 算不出顏色就不掛。 */
    chipLead(id){
      if(!st) return null;
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return null;
      return '<span class="tq-dot" data-c="' + st.corners[s] + '"></span>';
    },
    // 晶片尾巴:到家幾顆 / 共幾顆
    chipTail(id){
      if(!st) return "";
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return "";
      const hc = TQ.homeCount(st, s), tot = st.goals[s].length;
      /* ★ 只剩 1 顆沒歸位 → 那個人的晶片轉金色(v2.4.3)。
         ⚠ 措辭與樣式與單機那一份是**雙胞胎**(solo.js 的 tailOf),改一邊要改另一邊。 */
      return '<span class="tq-ct' + (tot - hc === 1 ? " tq-last" : "") + '" title="到家幾顆">' +
             '<i class="tq-ct-ic"></i>' + hc + "/" + tot + "</span>";
    },
    lobbyStatusText(ids){ return ids.length < 2 ? "等待其他人加入…" : "等待大家準備…"; },
    readyHint(ids, ready){
      return ids.length < 2 ? "等別人加入…(房間可分享給朋友)"
                            : (ready ? "等其他人按準備…" : "按「準備好了」就開始");
    },
    refresh(){ if(st) paint(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon }){
      clearTurnT(); stopSync();
      TQB.stopCd();
      const ord = ctx.order();
      const sc = (st && st.over) ? TQ.score(st) : null;
      const box = $("tqResult");
      if(box && sc){
        const names = ord.map(id => ctx.dispName(id));
        /* ★ 累積分數併進排名表 —— 連線的結果卡從此只有**一張表**。
           底數用開局快照,所以不必等 scores 節點同步回來。 */
        const wins = ord.map(id => {
          const plus = (w && w.pts && w.pts[id]) || 0;
          const base = (typeof baseWins[id] === "number") ? baseWins[id] : ctx.scoreOf(id);
          return { n: base + plus, plus: plus };
        });
        /* ★ foot 這一格連線版本來是空的 → 拿來放「本局最遠一跳」(v2.7.1)。
           ⚠ 措辭在 TQB.bestLine(與單機同一支);n / rules 一律問 st 自己
             (nPlayers() 在結算後可能已經有人離開了)。 */
        box.innerHTML = TQB.resultHTML(sc, names, mySeat(),
                                       TQB.bestLine(st, moves, nameOfSeat), wins);
        box.classList.remove("hidden");
      }
      if(st) paint();
      const me = mySeat();
      const row = sc ? sc.rows[me] : null;
      /* ★ 一句話就好:底下的排名表已經逐列寫著誰第幾名。
         ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。 */
      if(iWon){
        return { word: "你贏了!", msg: "你的棋先全部搬到對面 🎉" };
      }
      const ws = ((w && w.ids) || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: row ? ("第 " + row.rank + " 名") : "這局結束",
               msg: (ws ? (ws + " 先搬完") : "這局結束") +
                    (row ? (" · 你到家 <b>" + row.home + "</b> 顆 · 這局 <b>+" + row.pts + "</b> 分") : "") };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大 / 小:存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){ return { turnSec: turnSec, pieces: rules.pieces, big: BigMode.get() }; },
    usePrefs(o){
      BigMode.set(!!o.big);
      Object.keys(FIELDS).forEach(k => { if(FIELDS[k].ok(o[k])) FIELDS[k].set(o[k]); });
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      tapPiece, tapHole, isMyTurn,
      turnSec: () => turnSec,
      rules: () => JSON.parse(JSON.stringify(rules)),
      setTurnSec(v){ setField("turnSec", v, SECS.indexOf(v) >= 0, "倒數"); },
      setPieces(v){ setField("pieces", v, TQ.PIECE_OPTS.indexOf(v) >= 0, "棋子數"); },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      _moves: () => moves.slice(),
      _sel: () => sel,
      /* ★ 給 e2e 用:「送出中」是**純視覺**的 —— 它必須擋不住任何操作。
         守門的斷言就是「pending 有值時照樣點得動」(見 gen-tq-e2e 的 G 節)。 */
      _pending: () => pending,
      /* 給 e2e 用:把這一手的錨點往回撥,免得測「到期自動走棋」要真的等 40 秒。 */
      _ageTurn(ms){ turnAt -= (+ms || 0); armTurnT(); paint(); },
      /* 給 e2e 用:倒數代打的計時器是照**第幾手**武裝的(沒武裝 = -1)。
         ⚠ 不可以只回 true/false —— 上一手留下來的那顆也是 true。 */
      _armed: () => turnT ? armedLen : -1,
      /* ★★ 給 e2e 用:手動觸發一次對帳(第四條)。
         那條路徑只有時間會觸發,測試等不了 3 秒 × 每一項。 */
      _reconcile: reconcile
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

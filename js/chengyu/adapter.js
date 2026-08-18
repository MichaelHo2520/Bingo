"use strict";

/* ============================================================================
   成語接龍 — 連線適配器(接上 js/shared/mp-core.js)。唯一模式:搶字(grab)——
   所有人看**同一張盤面**、同時都能填。填對 → 那格永久標上你的顏色並 +1 分;
   填錯 → 凍結 FREEZE_MS 並讓對手看到、不扣分。盤面填滿時分數最高者勝。

   資料模型照抄數獨 grab 模式的 fills 整數編碼精神(見 js/sudoku/adapter.js),
   只把「數字 1~9」換成「這盤字卡去重清單的第幾個字」——但**這個索引必須是
   跟畫面顯示順序脫鉤的「規範順序」**:依 puzzle/sol 字串本身的掃描順序算出來,
   不是 CYB 畫面上洗牌過的字卡順序,否則兩台裝置洗牌結果不同,同一個整數會
   解出不同字元,直接對不上。

   ⚠ 只用了一個能力旗標:一場一局、搶字模式、不扣分、對局中不可加入,
     跟數獨一樣不碰 js/shared/mp-core.js 一行 —— 唯一例外是 contRound(v1.136.0,
     局間續局,比照台灣麻將):結果卡按「繼續」不回大廳,湊齊直接接下一盤。

   ★★★ 「按不動」的三道保險(v1.181.1)——
     現場回報:「結束第一局之後,繼續下一局,其中有一個人就沒辦法按了」(兩個人玩)。
     這一頁能讓人按不動的狀態只有三種,而它們**以前都沒有第二次機會**:
       ① 盤面鎖著(CYB.setEnabled(false))—— 舊版只有「題目換了」那一拍會解鎖,
          那一拍沒跑到(漏收快照 / 重連歸位 / 上一行丟例外)就整局鎖死
       ② 結果卡那顆「繼續」停在 disabled —— clearNext() 只收腳註,沒把鈕收回來
       ③ 核心的 readyUp() 用**本地** ready 擋,而腳註畫的是 **DB** 的 ready:
          兩邊不一致時,鈕看起來能按、按下去什麼都不會發生
     現在 ①③ 一定救得回來(①另有每 3 秒的對帳心跳兜底,比照跳棋的第四條),
     ②在 clearNext() 收乾淨。⚠ 不要把解鎖搬回「題目換了」那個分支裡。
   ========================================================================== */

const MP = MPCore.create((function () {
  const FREEZE_MS = 3000;
  const SYNC_MS = 3000;           // 對帳心跳:每 3 秒無條件比一次畫面與真相(比照跳棋)
  const COLORS = ["p0", "p1", "p2", "p3", "p4", "p5"];
  const V_MAX = 32;               // 一盤最多用到的相異字數上限(hard 難度實測 ≤22,留餘裕)
  let diff = "std";
  let gDiff = "std";
  let ctx = null;
  let puzKey = null, holes = 0, fills = [], tally = [];
  let charList = [];               // 規範順序的字元清單,每個端算出來都一樣
  let nextKey = "";                 // 這一局要不要顯示續局腳註(outcome() 會被重複呼叫,見那裡)
  let lastG = null, syncT = null;   // 對帳心跳:最後一份快照 + 那顆計時器

  /* ---------- fills 的整數編碼 ---------- */
  function encFill(i, v, seat, ok) { return ((i * V_MAX + v) * 8 + seat) * 2 + (ok ? 1 : 0); }
  function decFill(c) {
    const ok = c % 2; c = (c - ok) / 2;
    const seat = c % 8; c = (c - seat) / 8;
    const v = c % V_MAX, i = (c - v) / V_MAX;
    return { i, v, seat, ok: !!ok };
  }
  function buildCharList(puzzle, sol) {
    const seen = new Set(), list = [];
    for (let i = 0; i < puzzle.length; i++) {
      if (puzzle[i] === "." && !seen.has(sol[i])) { seen.add(sol[i]); list.push(sol[i]); }
    }
    return list;
  }
  function charIdx(ch) { return charList.indexOf(ch); }
  function seatOf(id) { return ctx.order().indexOf(id); }
  function mySeat() { return seatOf(ctx.me()); }
  function colorOf(seat) { return COLORS[seat] || "p0"; }

  /* ---------- 計分:唯一的加分入口(v1 沒有候選提示,不需要扣分邏輯) ---------- */
  function bump(t, seat, ok) { if (ok) t[seat] = (t[seat] || 0) + 1; }

  /* ---------- 即時比分 HUD(盤面上方那一列) ---------- */
  function renderHud() {
    const box = $("cyHud"); if (!box) return;
    if (ctx.phase() !== "playing") { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const ord = ctx.order(), me = ctx.me();
    box.classList.remove("hidden");
    box.classList.toggle("cy-hud-two", ord.length > 4);
    box.innerHTML = ord.map((id, seat) => {
      const nm = esc(ctx.dispName(id));
      const val = tally[seat] || 0;
      const bar = '<span class="cy-bar"><i style="width:' + (holes ? Math.round((val / holes) * 100) : 0) + '%"></i></span>';
      return '<div class="cy-hcard ' + colorOf(seat) + (id === me ? " me" : "") + '" data-id="' + id + '" title="' +
        (id === me ? "點一下傳送互動表情給全部人" : "點一下傳送互動表情") + '">' +
        '<span class="cy-hname"><span class="cy-seat ' + colorOf(seat) + '"></span>' + nm + (id === me ? ' <b>你</b>' : '') + '</span>' +
        '<span class="cy-hval">' + val + '<em>分</em></span>' + bar +
        '</div>';
    }).join("");
  }
  function popScore(seat, delta) {
    const box = $("cyHud"); if (!box) return;
    const card = box.children[seat]; if (!card) return;
    const el = document.createElement("span");
    el.className = "cy-pop up";
    el.textContent = "+" + delta;
    card.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 900);
  }

  /* ---------- 填格 ----------
     ⚠ 這一支以前有四條**靜靜 return** 的路(結束了 / 沒座位 / 字不在這盤 / 凍結中)——
       使用者看到的就只是「點下去沒反應」,而回報上來也只有這一句話,完全無從查起。
       現在每一條都要講一句話:講錯話還有得修,不講話連哪一條都不知道。 */
  function play(i, ch) {
    if (ctx.phase() !== "playing") return;             // 不在對局裡(單機 / 大廳)—— 這條不必講話
    if (ctx.winner()) { showToast("這一盤結束了,等下一盤開始 👀", 1400); return; }
    if (CYB.frozen()) return;                          // press() 已經先講過「冷靜 N 秒」了
    if (CYB.isBlock(i) || CYB.isGiven(i)) { showToast("這格是題目給的,不能改"); return; }
    if (CYB.valueAt(i)) { showToast("這格已經被填走了"); return; }
    /* ★ 這一頁**最後一條完全無聲**的路(v2.3.6):畫面說這格是空的、真相說早就有人填走了。
       底下那支交易會在 for 迴圈裡 return false —— 一個字都不會寫出去,而且**連 toast 都沒有**
       (交易中止是靜的)。使用者的體驗就是「點格子、點字卡,什麼都沒發生」,而且重試幾次都一樣
       —— 正是回報上來的那句「沒辦法選字」。畫面與真相對不上有很多種進法(漏收快照 / 樂觀寫入
       被回退 / applyGame 丟過例外),這裡不問是哪一種,先講話再把畫面拉回真相。 */
    if (takenAt(lastG, i)) {
      showToast("這格剛剛被別人搶走了,畫面幫你更新一下 🔄", 1600);
      if (lastG && charList.length) repaintFrom(lastG);
      return;
    }
    const seat = mySeat(); if (seat < 0) { showToast("座位還在同步,等一下再試 ⏳", 1400); return; }
    const v = charIdx(ch); if (v < 0) { showToast("這個字不在這一盤裡", 1400); return; }
    const right = (CYB.solAt(i) === ch);
    if (!right) {
      CYB.flashWrong(i);
      CYB.freeze(FREEZE_MS, i);      // 第二個參數 = 這一格結霜,倒數歸零時碎冰(v2.4.1)
      showToast("填錯了,冷靜 3 秒 🥶", 1400);
      try { Sound.lose(); } catch (e) {}
      ctx.txGame(g => {
        if (g.status !== "playing" || g.winner) return false;
        g.fills = (Array.isArray(g.fills) ? g.fills : []).concat(encFill(i, v, seat, 0));
      });
      return;
    }
    ctx.txGame(g => {
      if (g.status !== "playing" || g.winner) return false;
      const arr = Array.isArray(g.fills) ? g.fills : [];
      // 交易內再驗一次:別人可能在這 100ms 內先搶到了(本地快照還沒收到)
      for (let k = 0; k < arr.length; k++) { const f = decFill(arr[k]); if (f.ok && f.i === i) return false; }
      g.fills = arr.concat(encFill(i, v, seat, 1));
    });
  }
  function erase() { showToast("搶到的格子不能清掉"); }

  /* ---------- 對帳心跳(v1.181.1,比照跳棋的第四條「無條件對帳」) ----------
     每 3 秒問兩件事,不同就修 —— **不問「為什麼會不同」**:
       ① 對局中而且還沒分出勝負 → 盤面一定要是解鎖的(這是「按不動」的唯一自癒管道)
       ② 畫面上填了幾格 = 真相裡填對了幾格,對不上就整盤重畫
     ⚠ 心跳只讀本地最後一份快照,不多打一次 Firebase(它修的是「快照收到了但沒套完」,
       不是「沒收到快照」—— 後者由 Firebase 自己的重連補送)。
     ⚠ 順手補一次結算:某一台漏了收尾的那一拍時,整局會停在填滿卻不結束的畫面上。 */
  function okCount(g) {
    let k = 0;
    (Array.isArray(g.fills) ? g.fills : []).forEach(c => { if (decFill(c).ok) k++; });
    return k;
  }
  function takenAt(g, i) {
    return (Array.isArray(g && g.fills) ? g.fills : []).some(c => { const f = decFill(c); return f.ok && f.i === i; });
  }
  /* 新的一局(或對帳發現這一台根本沒套用上)→ 重建盤面 + 重算規範字元清單。
     ⚠ puzKey 一定要**等 setPuzzle 真的做完**才寫進去:先寫的話,setPuzzle 丟例外的那一台
       從此 g.puzzle === puzKey,這一局再也進不來 —— 盤面停在上一盤、charList 也是舊的,
       而且沒有任何錯誤訊息。(v2.3.6 起心跳每 3 秒會發現並重試,不再是永久出局。) */
  function applyPuzzle(g) {
    CYB.setPuzzle({ rows: g.rows, cols: g.cols, puzzle: g.puzzle, sol: g.sol });
    puzKey = g.puzzle;
    charList = buildCharList(g.puzzle, g.sol);
    holes = CYB.remaining();
    fills = []; tally = [];
    CYB.setSel(CYB.firstEmpty());
  }
  /* ⚠ 一定要先 clearFills():CYB.fill() 只會加不會減,不清就沒有任何管道能把
     「被伺服器回退掉的樂觀寫入」從畫面上洗掉 —— 那一格會永遠停在我的顏色上,
     filledCount() 也就永遠對不上 okCount(),心跳每 3 秒重畫一次卻永遠修不好。 */
  function repaintFrom(g) {
    const next = Array.isArray(g.fills) ? g.fills : [];
    const keep = CYB.sel();
    tally = [];
    CYB.clearFills();
    next.forEach(c => { const f = decFill(c); if (f.ok) CYB.fill(f.i, charList[f.v], colorOf(f.seat)); bump(tally, f.seat, f.ok); });
    fills = next.slice();
    keepSel(keep);
    renderHud();
  }
  /* 重建盤面之後把選格放回去 —— 只有「原本就沒選 / 那一格已經不能填了」才跳到 firstEmpty。
     ★★ 舊寫法是**無條件** setSel(firstEmpty())(v2.3.6 修)。三人以上同時搶格時,我的樂觀
       寫入常被伺服器重排 → 本地 fills 不再是真相的前綴 → 每一次都走重建這一條:
       使用者剛點好的格子會在他點字卡**之前**被偷偷換掉 → 字填到別的格子 → 多半是錯的
       → 凍結 3 秒。連中幾次,那一台看起來就是「一直按不動」。 */
  function keepSel(keep) {
    /* ⚠ 換選格的條件一個字都不能放寬(紅線 12):只有「原本就沒選 / 那一格已經不能填了」
       才動它。v2.4.1 只換掉**退路的目的地** —— firstEmpty() 改成同一條成語的下一個空格。 */
    if (keep < 0 || CYB.isBlock(keep) || CYB.isGiven(keep) || CYB.valueAt(keep)) CYB.setSel(CYB.nextHole(keep));
    else CYB.setSel(keep);
  }
  function reconcile() {
    if (ctx.phase() !== "playing" || !lastG) return;
    /* ① 題目根本沒套用上(setPuzzle 丟過例外 / 漏收重建那一拍)—— 這一台會停在上一盤的盤面上,
       charList 也是舊的,而且**永遠鎖著**。舊版把 !puzKey 當成 early-out,等於這種進法
       連心跳都救不到。⚠ 包 try:它丟例外也不可以把後面的對帳一起帶走。 */
    if (lastG.puzzle && lastG.puzzle !== puzKey) {
      try { applyPuzzle(lastG); } catch (e) { console.error("cy applyPuzzle", e); }
    }
    if (!puzKey) return;
    if (!ctx.winner() && !CYB.isEnabled()) CYB.setEnabled(true);
    if (CYB.filledCount() !== okCount(lastG)) repaintFrom(lastG);
    if (holes > 0 && CYB.isComplete() && !ctx.winner()) settleGrab();
  }
  /* 盤面鎖著的時候 .cy-pad 是 pointer-events:none —— 使用者點下去**連事件都收不到**,
     於是回報上來永遠只有「沒辦法按」五個字。main.js 把冒到 #cyPlay 的那一下轉進這裡:
     把使用者的手指當成一次額外的對帳訊號,不必等下一次心跳,也一定要講一句話。 */
  function lockedTap() {
    if (ctx.phase() !== "playing") return;      // 大廳 / 單機 —— 不是這一支的事
    if (ctx.winner()) { showToast("這一盤結束了,等下一盤開始 👀", 1400); return; }
    const wasLocked = !CYB.isEnabled();
    reconcile();
    if (!CYB.isEnabled()) CYB.setEnabled(true);
    if (wasLocked) showToast("盤面剛剛卡住了,已經幫你解開 🔄", 1600);
  }
  function startSync() { stopSync(); syncT = setInterval(reconcile, SYNC_MS); }
  function stopSync() { if (syncT) { clearInterval(syncT); syncT = null; } }

  /* 盤面填滿就結算。誰看到誰寫,交易保證只有第一個成功(不指定「填最後一格的人」,
     免得那個人剛好斷線就沒人寫、整局卡住)——比照數獨的 settleGrab。
     ★★ { local:false }(v1.156.0 補):決定勝負的寫入不做本地樂觀套用,否則搶輸的那一台
       會先閃一次「你贏了!」+ 彩帶 + 勝利音效(分數收得回來,那三件事收不回來)。
       ⚠ 這個缺陷當年是**連著程式一起**從數獨複製過來的 —— 上面那句「比照數獨的 settleGrab」
         就是它的來源,完整理由寫在 js/sudoku/adapter.js 的結算段。
       ⚠ 上面搶格那支 txGame 刻意不帶 —— 它不決定勝負,樂觀套用才有即時手感。 */
  function settleGrab() {
    ctx.txGame(g => {
      if (g.winner) return false;
      const arr = Array.isArray(g.fills) ? g.fills : [];
      const t = [];
      arr.forEach(c => { const f = decFill(c); bump(t, f.seat, f.ok); });
      const ord = ctx.order();
      let best = -1;
      ord.forEach((id, s) => { if ((t[s] || 0) > best) best = (t[s] || 0); });
      const ids = ord.filter((id, s) => (t[s] || 0) === best);
      g.winner = ids.length === 1
        ? { id: ids[0], name: ctx.dispName(ids[0]), by: "score", pts: best }
        : { ids: ids, by: "draw", pts: best };
    }, { local: false });
  }

  /* ---------- 局間續局:結果卡按「繼續」直接接下一盤,不回大廳(比照台灣麻將)。
     使用者:「按繼續是直接接下一句,而不是調回選單然後還要再按一次準備好了」——
     成語接龍沒有台灣麻將「打幾局」那種季末結算,所以永遠續局,不必像那邊分兩種文案。 */
  function seenBy(id) { return !!(ctx.players()[id] || {}).ready; }
  function waitCount() { return Object.keys(ctx.players()).filter(id => !seenBy(id)).length; }
  function clearNext() {
    nextKey = "";
    const el = $("cyNext"); if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
    /* ★★ 鈕也要一起收回原狀(v1.181.1)。paintNext() 按過之後會把它改成「等待中」+ disabled,
       而 clearNext() 以前只收腳註 —— 那顆 disabled 就**跟著活到下一盤**:下一盤的結果卡
       只要 outcome() 因為任何理由沒重畫到,那顆鈕就永遠按不下去(而畫面上完全看不出來)。
       ⚠ 台灣麻將的同一支本來就有做這件事(最後一局把鈕改回「下一局」),這裡當初漏了。 */
    const b = $("mpAgain");
    if (b) { b.textContent = "繼續"; b.disabled = false; b.classList.add("primary"); b.classList.remove("ghost"); }
  }
  /* 腳註那一行。★ 兩種身分要講不同的事(而且是同一行,不要多長一列出來):
       還沒按 —— 提示「按了就會接著玩」
       按過了 —— 還在等幾個人(不然按完之後那顆鈕變灰、畫面沒有任何交代) */
  function paintNext() {
    const el = $("cyNext"); if (!el) return;
    if (!nextKey) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const mine = seenBy(ctx.me());
    const wait = waitCount();
    el.classList.remove("hidden");
    el.innerHTML = mine
      ? (wait > 0 ? "還在等 <b>" + wait + "</b> 人…" : "大家都按了,馬上換下一盤…")
      : "按「繼續」,大家都按了就接著玩下一盤";
    const b = $("mpAgain");
    if (b) {
      b.textContent = mine ? "等待中" : "繼續";
      b.classList.toggle("ghost", mine);
      b.classList.toggle("primary", !mine);
      b.disabled = mine;
    }
  }
  /* 結果卡上那顆鈕按下去。回 true = 這一次由續局接手(不要再走核心的「回大廳」)。 */
  function seeDone() {
    if (!nextKey) return false;
    ctx.readyUp();
    paintNext();
    return true;
  }

  /* ---------- 大廳設定 ---------- */
  function ruleHint() {
    const el = $("cyRuleHint"); if (!el) return;
    const L = CYGen.levelOf(diff);
    el.innerHTML = "<b>搶字</b>:大家看同一張填字盤,同時搶著填空格。填對這格就歸你 <b>+1 分</b>," +
      "盤面填滿時分數最高的人贏。填錯凍結 3 秒、不扣分。" +
      "<br>盤面 " + L.label + "(" + L.name + ")· " + L.desc;
  }

  return {
    ns: { rooms: "chengyu_rooms", index: "chengyu_index" },
    minPlayers: 2, maxPlayers: 6,
    prefsKey: "chengyu.prefs.v1",
    emoteAnchor: "cyStage",
    winCardId: "cyWinCard",
    hasResign: false,               // 限時解謎,中途認輸沒有意義
    extraNodes: [],
    /* ★ 局間續局(v1.136.0)—— 一盤結束不回大廳,結果卡按「繼續」就 MP.readyUp(),
       湊齊由房主開下一盤。沒有台灣麻將的「打幾局」季末結算,永遠續局。 */
    contRound: true,

    init(c) { ctx = c; },

    /* ---------- 房間層級設定(比數獨少 mode/assist 兩項) ---------- */
    roomFields() { return { diff: diff }; },
    onRoomField(k, v) {
      if (k === "diff") {
        if (!CYGen.LEVELS[v] || v === diff) return;
        diff = v; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }
    },
    readRoom(r) { if (CYGen.LEVELS[r.diff]) diff = r.diff; },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame() { return { fills: [], puzzle: null, sol: null }; },
    resetRound() { puzKey = null; fills = []; tally = []; charList = []; lastG = null; },
    newGame(ids, prev) {
      const q = CYGen.make(diff);
      let ord;
      if (prev && prev.length === ids.length) ord = prev.slice(1).concat(prev[0]);
      else { ord = ids.slice(); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ord[i]; ord[i] = ord[j]; ord[j] = t; } }
      return { order: ord, fills: [], puzzle: q.puzzle, sol: q.sol, rows: q.rows, cols: q.cols, diff: diff };
    },
    applyGame(g, playing) {
      if (!playing) return;
      gDiff = CYGen.LEVELS[g.diff] ? g.diff : "std";
      lastG = g;                                    // 對帳心跳要用(見 reconcile)
      // 題目換了(新的一局)→ 重建盤面 + 重算規範字元清單(對帳心跳也走同一支)
      if (g.puzzle && g.puzzle !== puzKey) applyPuzzle(g);
      /* ★★★ 解鎖**不綁在「題目換了」那個分支裡**(v1.181.1)。
         舊寫法只有重建盤面那一拍會 setEnabled(true) —— 那一拍沒跑到的話這一台就整局鎖著:
         盤面看得到、字卡淡掉、點下去完全沒反應,而且再也沒有第二次機會。
         現場回報的「第二局其中一個人沒辦法按」就是這個形狀 → 改成每一份快照都重申一次。 */
      if (!ctx.winner()) CYB.setEnabled(true);
      const next = Array.isArray(g.fills) ? g.fills : [];
      const pops = [];
      // 能延續就只補新的幾筆,否則整盤重建(重連 / 中途歸位)
      const extend = next.length >= fills.length && fills.every((v, k) => next[k] === v);
      /* ★★ 整盤重建走 repaintFrom():它會先 clearFills()(把回退掉的樂觀寫入洗乾淨)
         並且**保住選格**。這一條不是罕見路徑 —— 三人以上同時搶格時,自己的樂觀寫入
         幾乎每次都會被伺服器重排到別人後面,於是每填一格就走一次這裡。
         ⚠ 舊寫法在這裡無條件 setSel(firstEmpty()):使用者點好格子、還沒點字卡,選格就被
           換掉 → 字填到別的格子 → 填錯 → 凍結 3 秒。詳見 repaintFrom / keepSel 的註解。 */
      if (!extend) {
        repaintFrom(g);
      } else {
        const added = next.slice(fills.length);
        fills = next.slice();
        const me = mySeat();
        const quiet = added.length > 1;   // 一次補很多筆 = 重連歸位或剛開打的批次同步
        added.forEach(c => {
          const f = decFill(c);
          const before = tally[f.seat] || 0;
          bump(tally, f.seat, f.ok);
          if (!quiet) { const d = (tally[f.seat] || 0) - before; if (d) pops.push([f.seat, d]); }
          if (f.ok) {
            /* 第四個參數 = 播落字鈐印 + 判定貫通。⚠ quiet(一次補很多筆 = 重連歸位 / 剛開打的
               批次同步)一律不播 —— 連播十幾道流光會變成好幾秒的慢動作(飛行棋踩過)。 */
            CYB.fill(f.i, charList[f.v], colorOf(f.seat), !quiet);
            if (!quiet && f.seat !== me) {
              CYB.flashTaken(f.i);
              Sound.place();
              showToast("⚡ " + ctx.dispName(ctx.order()[f.seat] || "") + " 搶下 " + CYB.coordName(f.i), 1100);
            } else if (!quiet) Sound.place();
          } else if (!quiet && f.seat !== me) {
            showToast("😅 " + ctx.dispName(ctx.order()[f.seat] || "") + " 填錯了", 1100);
          }
        });
        /* ★ 自動跳格(v2.4.1)。連線這一邊以前**完全沒有**:填完之後選格還停在那一格上,
           下一次點字卡只會得到「這格已經被填走了」—— 每填一個字都得先手動點下一格。
           ⚠ 判準是「我選的那一格現在填掉了」(不管是我自己填的還是被別人搶走),所以它
             永遠不會把使用者剛點好的**空格**換掉 —— 紅線 12 那個 bug 進不來。 */
        const cur = CYB.sel();
        if (cur >= 0 && CYB.valueAt(cur)) CYB.setSel(CYB.nextHole(cur));
      }
      const done = holes > 0 && CYB.isComplete();
      renderHud();
      pops.forEach(p => popScore(p[0], p[1]));   // 一定要在 renderHud() 之後(它會重建 innerHTML)
      if (done && !ctx.winner()) settleGrab();
    },

    /* ---------- 相位的專屬畫面 ---------- */
    openConnect() { showScreen("connect"); },
    enterLobby() {
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      CYB.setEnabled(false);
      ruleHint();
    },
    backToLobby() {
      showScreen("lobby");
      paintSeal(null);
      $("mpBar").classList.remove("playing");
      puzKey = null; fills = []; tally = []; charList = []; lastG = null;
      stopSync();
      CYB.setEnabled(false); CYB.unfreeze();
      clearNext();
      const box = $("cyHud"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
      ruleHint();
    },
    enterPlaying() {
      showScreen("play");
      paintSeal(null);
      $("mpBar").classList.add("playing");
      CYB.unfreeze();
      /* ★ 續局時這支是上一盤的結果卡收掉、新的一盤開打的那一刻(核心已經 closeWin)——
         腳註一定要在這裡收乾淨,不然文案會活到下一盤的結果卡再多畫一次舊的。 */
      clearNext();
      startSync();      // 對帳心跳:一開打就起跳(見 reconcile)
      Sound.start();
    },
    onLeave() {
      paintSeal(null);
      puzKey = null; fills = []; tally = []; charList = []; lastG = null;
      stopSync();
      CYB.setEnabled(false); CYB.unfreeze();
      clearNext();
      const box = $("cyHud"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup() {
      const isHost = ctx.isHost();
      const dSeg = $("cyDiffSeg");
      if (dSeg) { dSeg.classList.toggle("readonly", !isHost); [...dSeg.children].forEach(b => b.classList.toggle("on", b.dataset.diff === diff)); }
      const dL = $("cyDiffLabel"); if (dL) dL.textContent = isHost ? "難度" : "難度(房主決定)";
      ruleHint();
    },
    updateGoal() {
      const g = $("mpBarGoal"); if (!g) return;
      const live = ctx.phase() === "playing";
      const L = CYGen.levelOf(live ? gDiff : diff);
      g.textContent = "🧩 搶字 · " + L.label;
      g.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    chipLead(id) {
      const seat = seatOf(id);
      if (seat < 0) return null;
      return '<span class="cy-seat ' + colorOf(seat) + '"></span>';
    },
    chipTail(id) {
      const seat = seatOf(id); if (seat < 0) return "";
      return '<span class="cy-pts">' + (tally[seat] || 0) + '</span>';
    },
    lobbyStatusText(ids) {
      return ids.length < ctx.minPlayers
        ? "等待其他人加入…(最多 " + ctx.maxPlayers + " 人)"
        : "等待大家準備…(" + ids.length + " 人)";
    },
    readyHint(ids, ready) {
      if (ids.length < ctx.minPlayers) return "至少要 " + ctx.minPlayers + " 個人才能開始(最多 " + ctx.maxPlayers + " 人)";
      return ready ? "等其他人按準備…" : "按「準備好了」就開始";
    },
    refresh() { renderHud(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, isDraw }) {
      CYB.setEnabled(false); CYB.unfreeze();
      CYB.markDone();                    // 盤面收工:整張紙鍍一層金光(偷看盤面時看得到)
      renderHud(); renderWinnerRow(w, isDraw);
      /* 朱紅大印:★ 只有贏家(含並列)蓋 —— 輸的那一份蓋「狀元及第」是嘲諷不是儀式,
         比照台灣麻將 fx.js 的印章。⚠ 鑰匙用 roundId:outcome() 會被反覆呼叫
         (核心的 players / scores 監聽一動就重畫),沒有鑰匙它每隔幾秒就重蓋一次。 */
      paintSeal((iWon || isDraw) ? "狀元及第" : null, ctx.roundId() || "-");
      const box = $("cyStats"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
      /* 局間續局的腳註。★ 每一次都要重畫 —— outcome() 會被反覆呼叫(核心的 players / scores
         監聽一動就 showOutcome()),而「還在等 N 人」正是靠那幾次重畫才會跟著別人按鈕動。
         ⚠ 鑰匙用 roundId:重連 / 重畫時腳註才認得出「這是同一盤」而不是重新歸零。 */
      nextKey = ctx.roundId() || "-";
      paintNext();
      if (isDraw) return { word: "平手!", msg: "盤面填滿,最高分同分 🤝 各得 1 勝" };
      if (iWon) return { word: "你贏了!", msg: "拿下最高分,漂亮 🎉(" + (w.pts || 0) + " 分)" };
      return { word: "你輸了", msg: esc(w.name || "對手") + " 拿下 " + (w.pts || 0) + " 分" };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大字盤(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs() { return { diff: diff, big: BigMode.get() }; },
    usePrefs(o) {
      BigMode.set(!!o.big);                       // 這一刻畫面還在選單,BigMode 的守衛會壓著不生效
      if (CYGen.LEVELS[o.diff]) diff = o.diff;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      play, erase, seeDone, lockedTap,
      diff: () => diff, gameDiff: () => gDiff,
      setDiff(v) {
        if (!CYGen.LEVELS[v]) return;
        if (!ctx.setRoomField("diff", v, { lobbyOnly: true, denyMsg: "只有房主能改難度", busyMsg: "對戰中不能改難度" })) return;
        diff = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      }
    }
  };

  /* 「這局是誰拿下」:大字是主觀的,這一列給客觀事實 —— 顏色 + 名字 +(你) */
  function renderWinnerRow(w, isDraw) {
    const el = $("cyWinner"); if (!el) return;
    const ids = Array.isArray(w.ids) ? w.ids : (w.id ? [w.id] : []);
    if (!ids.length) { el.innerHTML = ""; return; }
    const body = ids.map(id => {
      const seat = seatOf(id);
      const dot = seat >= 0 ? '<span class="cy-seat ' + colorOf(seat) + '"></span>' : '';
      return dot + '<span class="gw-name">' + esc(ctx.dispName(id)) + '</span>' + ctx.youTag(id);
    }).join('<span class="gw-tag">·</span>');
    el.innerHTML = body + '<span class="gw-tag">' + (isDraw ? "並列第一,各得 1 勝" : "拿下這局") + '</span>';
  }
})());

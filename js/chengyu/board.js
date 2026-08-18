"use strict";

/* ============================================================================
   成語接龍 — 盤面引擎(CYB):渲染 / 選格 / 字卡區 / 凍結。
   對外只暴露 CYB;不依賴 Firebase 也不依賴 adapter,單機與連線共用同一支。

   與數獨 board.js(SB)的關鍵差異(見 notes/plan 的設計理由):
   • 盤面不是齊次的列/行/宮互斥規則,而是「交叉填字」——每格不是給定字(given)
     就是待填空格(blank),另外還有不屬於任何成語的裝飾格(block)。
   • 沒有候選/peer 高亮層(數獨那套是給數字互斥推理用的,這裡沒有那種推理空間)。
   • 字卡區不是固定 1~9,是「這盤所有空格用到的字」去重後的清單,且**顯示順序
     必須跟掃描順序脫鉤(洗牌)**——否則字卡排列順序等於洩漏第一個空格的答案。

   ⚠ $ 定義在 js/shared/ui-kit.js,本檔不可再宣告。
   ========================================================================== */

const CYB = (function () {
  let rows = 0, cols = 0;
  let solStr = "", block = [], given = [], vals = [], owners = [];
  let cells = [], padBtns = [];
  let sel = -1, enabled = false;
  let frozenUntil = 0, freezeTick = null;
  let cbPick = null, cbNum = null, cbErase = null;
  let board, pad, wrap;
  /* ★ 成語光軌(v2.4.1)。這一頁沒有數獨那種推理空間,玩家的認知負擔幾乎全在
     「我點的這格,是哪一條成語的第幾個字」—— 以前只有選中格那一格反白,四個字要靠
     肉眼在盤上掃。現在整條 4 格一起亮(主方向亮、交叉方向淡),交叉點再點一下換方向。
     words[] 是從盤面本身推回來的(連續非 block 的橫/直字塊),**不依賴 gen.js 的版面資料**
     —— 那份資料不進 DB,連線那一邊只拿得到 puzzle/sol 兩條字串。 */
  let words = [], wAt = [], wDone = [];
  let selDir = "h";                 // 主方向:"h" 橫 / "v" 直
  let swept = null;                 // 已經播過貫通流光的成語(同一條只播一次)
  let frostAt = -1;                 // 這一次凍結是哪一格結的霜(解凍時在那一格碎冰)
  let fxLayer = null;               // 覆蓋層:貫通流光住在這裡,絕不進 grid 的版面流

  function shuffleArr(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 建立 ---------- */
  function init(o) {
    o = o || {};
    cbPick = o.onPick || null; cbNum = o.onNum || null; cbErase = o.onErase || null;
    wrap = $("cyStage"); board = $("cyBoard"); pad = $("cyPad");
    // 純粹尺寸變化只重算格子大小,不重畫 DOM(重畫會把選格/凍結狀態弄丟)
    if (typeof ResizeObserver !== "undefined" && wrap) new ResizeObserver(fitStage).observe(wrap);
  }

  // q = { rows, cols, puzzle, sol }(來自 CYGen.make())
  function setPuzzle(q) {
    rows = q.rows; cols = q.cols; solStr = q.sol;
    const total = rows * cols, puz = q.puzzle;
    block = new Array(total); given = new Array(total);
    vals = new Array(total).fill(""); owners = new Array(total).fill(null);
    for (let i = 0; i < total; i++) {
      block[i] = puz[i] === "#";
      given[i] = !block[i] && puz[i] !== ".";
      vals[i] = given[i] ? puz[i] : "";
    }
    sel = -1; selDir = "h"; frostAt = -1;
    buildWords();
    buildBoard(); buildPad(); repaint();
  }
  /* 從盤面推回「有哪些成語、各佔哪 4 格」:橫的掃每一列、直的掃每一行,連續的非 block
     字塊就是一條。⚠ 長度 1 的字塊不算(那格只屬於另一個方向的詞,不是 bug —— 見
     tools/verify-chengyu-gen.js 的第二項檢查)。 */
  function buildWords() {
    const total = rows * cols;
    words = []; wDone = []; swept = new Set();
    wAt = new Array(total);
    for (let i = 0; i < total; i++) wAt[i] = { h: -1, v: -1 };
    const flush = (run, dir) => {
      if (run.length < 2) return;
      const wi = words.length;
      words.push({ cells: run.slice(), dir: dir });
      run.forEach(x => { wAt[x][dir] = wi; });
    };
    for (let r = 0; r < rows; r++) {
      let run = [];
      for (let c = 0; c <= cols; c++) {
        const i = r * cols + c;
        if (c < cols && !block[i]) { run.push(i); continue; }
        flush(run, "h"); run = [];
      }
    }
    for (let c = 0; c < cols; c++) {
      let run = [];
      for (let r = 0; r <= rows; r++) {
        const i = r * cols + c;
        if (r < rows && !block[i]) { run.push(i); continue; }
        flush(run, "v"); run = [];
      }
    }
  }
  // 這一格現在的「主方向那一條」(主方向沒有就退回另一個方向);-1 = 不屬於任何成語
  function activeWi(i) {
    const at = wAt[i]; if (!at) return -1;
    return at[selDir] >= 0 ? at[selDir] : (at.h >= 0 ? at.h : at.v);
  }
  function buildBoard() {
    board.innerHTML = "";
    /* ⚠ 上一盤的金色光暈要跟著清掉 —— markDone() 只加不減,單機「再來一局」會把它帶進新盤。
       (在 v2.4.1 給 .cy-board.done 加上樣式之前這件事看不出來,所以一直沒人發現。) */
    board.classList.remove("done");
    board.style.setProperty("--cyr", String(rows));
    board.style.setProperty("--cyc", String(cols));
    cells = [];
    for (let i = 0; i < rows * cols; i++) {
      if (block[i]) {
        const el = document.createElement("div");
        el.className = "cy-cell block";
        el.setAttribute("aria-hidden", "true");
        board.appendChild(el);
        cells.push(el);
        continue;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cy-cell";
      el.dataset.i = i;
      el.innerHTML = '<span class="cy-v"></span>';
      el.addEventListener("click", () => pick(i));
      board.appendChild(el);
      cells.push(el);
    }
    /* 貫通流光的覆蓋層。⚠ 一定要 position:absolute —— .cy-board 是 grid,普通子元素會
       變成第 rows*cols+1 個格子把版面撐掉一列。 */
    fxLayer = document.createElement("div");
    fxLayer.className = "cy-fx";
    fxLayer.setAttribute("aria-hidden", "true");
    board.appendChild(fxLayer);
    fitStage();
  }
  /* ★ 盤面尺寸用 JS 算成整數 px,不靠 CSS 的 aspect-ratio(比照 js/darkchess/board.js
     的 fitBoard):字謎盤 rows/cols 不像數獨永遠是正方形,aspect-ratio 同時吃
     max-width 與 max-height 時,被夾住的那一邊不會把另一邊帶著縮,盤面比例會被壓歪。
     .cy-stage 本身是透明的置中容器,直接掛在 .cy-play(欄式排版)底下用 flex:1 1 0
     吃掉剩餘高度;.cy-board 才是看得到的那個矩形,顯式寫死 width/height,fr 才能
     照這個尺寸平分出等寬的格子。 */
  const GAP = 3, PAD = 4, MIN_CELL = 20;
  function fitStage() {
    if (!board || !wrap || !rows || !cols) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    const cw = (w - PAD * 2 - GAP * (cols - 1)) / cols;
    const ch = (h - PAD * 2 - GAP * (rows - 1)) / rows;
    const cell = Math.max(MIN_CELL, Math.floor(Math.min(cw, ch)));
    board.style.width = (cell * cols + GAP * (cols - 1) + PAD * 2) + "px";
    board.style.height = (cell * rows + GAP * (rows - 1) + PAD * 2) + "px";
    board.style.setProperty("--cy-cell", cell + "px");
    // 流光是照「當下的格寬」算出來的絕對座標 → 尺寸一變就對不上,直接收掉(它只活 0.9 秒)
    if (fxLayer) fxLayer.innerHTML = "";
  }
  // 字卡區:這盤所有空格用到的字去重後的清單,順序洗牌過(不能照掃描順序排,
  // 否則排列本身就洩漏了第一個空格的答案)
  function buildPad() {
    if (!pad) return;
    pad.innerHTML = "";
    const need = new Set();
    for (let i = 0; i < rows * cols; i++) if (!block[i] && !given[i]) need.add(solStr[i]);
    padBtns = [];
    shuffleArr([...need]).forEach(ch => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "cy-key"; b.dataset.ch = ch;
      b.innerHTML = '<span class="cy-kc">' + ch + '</span><span class="cy-kleft"></span>';
      b.addEventListener("click", () => press(ch));
      pad.appendChild(b); padBtns.push(b);
    });
  }

  /* ---------- 操作 ---------- */
  function frozen() { return Date.now() < frozenUntil; }
  function pick(i) {
    if (!enabled) return;
    if (block[i]) return;
    if (frozen()) { showToast("填錯了,冷靜 " + Math.ceil((frozenUntil - Date.now()) / 1000) + " 秒 🥶", 900); return; }
    /* ★ 主方向:同一格再點一下 = 在「橫的那條」與「直的那條」之間切換(只有交叉點做得到);
       換到別格時,主方向能留就留,留不住才換 —— 沿著一條成語一路點下去不會莫名其妙跳方向。 */
    const at = wAt[i] || { h: -1, v: -1 };
    if (i === sel && at.h >= 0 && at.v >= 0) selDir = (selDir === "h" ? "v" : "h");
    else if (at[selDir] < 0 && (at.h >= 0 || at.v >= 0)) selDir = (at.h >= 0 ? "h" : "v");
    sel = i; repaint();
    if (cbPick) cbPick(i);
  }
  function press(ch) {
    if (!enabled) return;
    if (frozen()) { showToast("填錯了,冷靜 " + Math.ceil((frozenUntil - Date.now()) / 1000) + " 秒 🥶", 900); return; }
    if (sel < 0) { showToast("先點一個空格 👆"); return; }
    if (block[sel] || given[sel]) { showToast("這格是題目給的,不能改"); return; }
    if (cbNum) cbNum(sel, ch);
  }
  // 桌機:方向鍵移動選格、Backspace/Delete 清除(沒有數字/注音鍵盤輸入 ——
  // 字是從字卡區點選,不是打字)
  function onKey(e) {
    if (!enabled) return;
    const k = e.key;
    if (k === "Backspace" || k === "Delete") { if (cbErase) cbErase(sel); e.preventDefault(); return; }
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[k];
    if (d != null && sel >= 0) {
      const r = Math.floor(sel / cols), c = sel % cols;
      let ni = sel + d;
      if ((k === "ArrowLeft" && c === 0) || (k === "ArrowRight" && c === cols - 1) ||
          (k === "ArrowUp" && r === 0) || (k === "ArrowDown" && r === rows - 1)) ni = sel;
      if (ni >= 0 && ni < rows * cols && !block[ni]) {
        sel = ni;
        // 往左右走就把主方向切成橫的、上下走切成直的(那一格有那個方向才切)
        const want = (d === -1 || d === 1) ? "h" : "v";
        if (wAt[ni] && wAt[ni][want] >= 0) selDir = want;
        repaint();
      }
      e.preventDefault();
    }
  }

  /* ---------- 資料寫入(由呼叫端決定對錯與同步) ---------- */
  // cls:填入者的顏色 class(連線搶字用 p0~p5;單機用 me)
  /* ★★ fx = 「這是**剛剛發生**的一手」(v2.4.1)。動效與音效只吃這個旗標,不看別的:
     整盤重建(repaintFrom)與重連批次同步一次會呼叫十幾次 fill(),連播的下場是
     十幾道流光排隊放完(飛行棋的批次同步踩過同一個坑,notes/22)。 */
  function fill(i, ch, cls, fx) {
    if (i < 0 || i >= rows * cols || block[i] || given[i]) return;
    const isNew = !vals[i];
    vals[i] = ch; owners[i] = cls || "me";
    repaint();
    if (fx && isNew) { stamp(i); sweepAt(i); }
  }
  function clear(i) {
    if (i < 0 || i >= rows * cols || block[i] || given[i]) return;
    vals[i] = ""; owners[i] = null; repaint();
  }
  /* ★ 把「填上去的」全部清掉,給定字與裝飾格不動(選格刻意保留)。
     連線搶字整盤重建時一定要先走這一支:fill() 只會**加**,不會減 ——
     漏了的話,被伺服器回退掉的樂觀寫入會在畫面上留成一格永遠洗不掉的幽靈,
     而那一格從此點下去只會得到「這格已經被填走了」,連 remaining() 都少算一格
     (isComplete() 因此可能提早為真 → 整局被提早結算)。 */
  function clearFills() {
    for (let i = 0; i < rows * cols; i++) {
      if (block[i] || given[i]) continue;
      vals[i] = ""; owners[i] = null;
    }
    if (swept) swept.clear();      // 這些字被洗掉了 → 那幾條成語之後重新填滿時要再播一次流光
    repaint();
  }

  /* ---------- 畫面 ---------- */
  /* ⚠ repaint() 是**整行覆寫 className**,所以正在播的動效 class 要自己接回來 ——
     漏了的話,任何一次重畫(別人填了一格、心跳對帳、選格移動)都會把畫到一半的
     鈐印 / 碎冰 / 搶格脈動靜靜抹掉,而那看起來只像是「動畫偶爾不播」。 */
  const FX_CLS = ["wrong", "taken", "ink", "frost", "shatter"];
  function repaint() {
    wDone = words.map(w => w.cells.every(i => !!vals[i]));
    const aw = sel >= 0 ? activeWi(sel) : -1;                       // 主方向那一條
    const at = sel >= 0 ? (wAt[sel] || { h: -1, v: -1 }) : null;    // 交叉方向那一條
    const xw = at ? (aw === at.h ? at.v : at.h) : -1;
    for (let i = 0; i < rows * cols; i++) {
      const el = cells[i]; if (!el || block[i]) continue;
      const v = vals[i], a = wAt[i] || { h: -1, v: -1 };
      let cls = "cy-cell";
      if (given[i]) cls += " given";
      else if (v) cls += " filled " + (owners[i] || "me");
      if (i === sel) cls += " sel";
      else if (aw >= 0 && (a.h === aw || a.v === aw)) cls += " track";
      else if (xw >= 0 && (a.h === xw || a.v === xw)) cls += " xtrack";
      if ((a.h >= 0 && wDone[a.h]) || (a.v >= 0 && wDone[a.v])) cls += " wdone";
      FX_CLS.forEach(f => { if (el.classList.contains(f)) cls += " " + f; });
      el.className = cls;
      const vs = el.querySelector(".cy-v");
      if (vs) vs.textContent = v || "";
    }
    paintPad();
  }
  // 字卡角標:這個字在剩下的空格裡還要用幾次(用光就整顆變淡,不代表可以拿去定位是哪一格)
  function paintPad() {
    padBtns.forEach(b => {
      const ch = b.dataset.ch;
      let left = 0;
      for (let i = 0; i < rows * cols; i++) if (!block[i] && !given[i] && !vals[i] && solStr[i] === ch) left++;
      const tag = b.querySelector(".cy-kleft");
      if (tag) tag.textContent = left > 0 ? String(left) : "";
      b.classList.toggle("done", left <= 0);
    });
  }
  /* 落字鈐印:格子輕輕下沉回彈 + 邊緣一圈自己顏色的水墨漣漪(CSS 那邊的 .ink)。 */
  function fx(i, cls, ms) {
    const el = cells[i]; if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(() => { const e2 = cells[i]; if (e2) e2.classList.remove(cls); }, ms);
  }
  function stamp(i) { fx(i, "ink", 520); }
  /* 這一格填完之後,它所屬的橫/直成語有沒有剛好湊滿 4 個字 → 有就劃一道金色流光過去。
     ⚠ 同一條只播一次(swept):心跳對帳、別人補填、重連歸位都可能讓同一條再走一次這裡。 */
  function sweepAt(i) {
    const a = wAt[i]; if (!a) return;
    [a.h, a.v].forEach(wi => {
      if (wi < 0 || !words[wi] || swept.has(wi)) return;
      if (!words[wi].cells.every(x => !!vals[x])) return;
      swept.add(wi);
      sweep(wi);
    });
  }
  /* 流光本體:一個絕對定位的矩形,座標照 fitStage() 那組常數換算(PAD / GAP / --cy-cell)。
     ⚠ 它是 .cy-fx 的子元素,不進 grid 版面流,也不會被 fitStage() 量到。 */
  function sweep(wi) {
    const w = words[wi]; if (!w || !fxLayer || !board) return;
    const cell = parseFloat(board.style.getPropertyValue("--cy-cell")) || 0;
    if (!cell) return;
    const i0 = w.cells[0], r = Math.floor(i0 / cols), c = i0 % cols, n = w.cells.length;
    const span = n * cell + (n - 1) * GAP;
    const el = document.createElement("div");
    el.className = "cy-sweep " + w.dir;
    el.style.left = (PAD + c * (cell + GAP)) + "px";
    el.style.top = (PAD + r * (cell + GAP)) + "px";
    el.style.width = (w.dir === "h" ? span : cell) + "px";
    el.style.height = (w.dir === "v" ? span : cell) + "px";
    fxLayer.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 950);
    try { Sound.line(); } catch (e) {}
  }
  /* 結霜 / 破冰:填錯凍結的那 3 秒,那一格蓋一層冰晶;倒數歸零時碎掉。
     ⚠ 只有「凍結」才結霜(單機填錯不凍結,就只有紅閃)—— 冰是倒數的視覺化,不是錯誤的。 */
  function frost(i) {
    thaw(true);
    if (i < 0 || i >= rows * cols) return;
    frostAt = i;
    const el = cells[i]; if (el) el.classList.add("frost");
  }
  function thaw(silent) {
    if (frostAt < 0) return;
    const i = frostAt; frostAt = -1;
    const el = cells[i]; if (!el) return;
    el.classList.remove("frost");
    if (silent) { el.classList.remove("shatter"); return; }
    fx(i, "shatter", 520);
    try { Sound.emote(); } catch (e) {}
  }
  function flashWrong(i) {
    const el = cells[i]; if (!el) return;
    el.classList.remove("wrong"); void el.offsetWidth; el.classList.add("wrong");
    setTimeout(() => el.classList.remove("wrong"), 600);
  }
  // 別人搶走這格:短暫脈動一下,讓對方的動作看得見
  function flashTaken(i) {
    const el = cells[i]; if (!el) return;
    el.classList.remove("taken"); void el.offsetWidth; el.classList.add("taken");
    setTimeout(() => el.classList.remove("taken"), 700);
  }
  function markDone() { if (board) board.classList.add("done"); }

  /* ---------- 凍結(填錯的懲罰) ---------- */
  function freeze(ms, at) {
    frozenUntil = Date.now() + ms;
    if (at != null) frost(at);
    if (wrap) wrap.classList.add("frozen");
    if (freezeTick) clearInterval(freezeTick);
    const paint = () => {
      const left = Math.ceil((frozenUntil - Date.now()) / 1000);
      const el = $("cyFreeze");
      if (left > 0) { if (el) { el.textContent = "🥶 " + left; el.classList.remove("hidden"); } }
      else {
        clearInterval(freezeTick); freezeTick = null;
        if (wrap) wrap.classList.remove("frozen");
        if (el) el.classList.add("hidden");
        thaw();                       // 倒數歸零 = 破冰(這是「可以再填了」唯一看得見的訊號)
      }
    };
    paint();
    freezeTick = setInterval(paint, 200);
  }
  // ⚠ unfreeze() 是「這一局不玩了 / 換局了」的路,不是倒數結束 —— 冰要靜靜收掉,不碎
  function unfreeze() {
    frozenUntil = 0;
    thaw(true);
    if (freezeTick) { clearInterval(freezeTick); freezeTick = null; }
    if (wrap) wrap.classList.remove("frozen");
    const el = $("cyFreeze"); if (el) el.classList.add("hidden");
  }

  /* ---------- 查詢 ---------- */
  function remaining() { let k = 0; for (let i = 0; i < rows * cols; i++) if (!block[i] && !vals[i]) k++; return k; }
  function filledCount() { let k = 0; for (let i = 0; i < rows * cols; i++) if (!block[i] && vals[i] && !given[i]) k++; return k; }
  function isComplete() { return remaining() === 0; }
  function firstEmpty() { for (let i = 0; i < rows * cols; i++) if (!block[i] && !vals[i]) return i; return -1; }
  /* ★ 智慧跳格(v2.4.1):填完一個字,焦點順著**同一條成語**跳到下一個空格 ——
     以前一律跳 firstEmpty(),那多半在盤面另一頭,思緒等於每填一個字就被打斷一次。
     整條填滿了才退回 firstEmpty()。 */
  function nextHole(i) {
    const wi = (i >= 0) ? activeWi(i) : -1;
    if (wi >= 0) {
      const cs = words[wi].cells, k = cs.indexOf(i);
      for (let n = 1; n <= cs.length; n++) {
        const j = cs[(k + n) % cs.length];
        if (!block[j] && !given[j] && !vals[j]) return j;
      }
    }
    return firstEmpty();
  }
  function coordName(i) {
    if (i < 0 || i >= rows * cols) return "";
    return String.fromCharCode(65 + (i % cols)) + (Math.floor(i / cols) + 1);
  }

  return {
    init, setPuzzle, fill, clear, clearFills, flashWrong, flashTaken, markDone,
    freeze, unfreeze, frozen, onKey, press,
    setEnabled(v) { enabled = !!v; if (wrap) wrap.classList.toggle("locked", !enabled); },
    /* ★ 連線的對帳心跳要問「現在到底能不能按」(v1.181.1)——「按不動」在畫面上只有
       一點點淡,量不出來;唯一問得到的就是這個旗標本身。 */
    isEnabled: () => enabled,
    setSel(i) { sel = i; repaint(); },
    sel: () => sel,
    valueAt: i => vals[i] || "",
    isGiven: i => !!given[i],
    isBlock: i => !!block[i],
    solAt: i => solStr[i] || "",
    rows: () => rows, cols: () => cols,
    remaining, filledCount, isComplete, firstEmpty, nextHole, coordName,
    dir: () => selDir,
    repaint
  };
})();

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
    sel = -1;
    buildBoard(); buildPad(); repaint();
  }
  function buildBoard() {
    board.innerHTML = "";
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
      if (ni >= 0 && ni < rows * cols && !block[ni]) { sel = ni; repaint(); }
      e.preventDefault();
    }
  }

  /* ---------- 資料寫入(由呼叫端決定對錯與同步) ---------- */
  // cls:填入者的顏色 class(連線搶字用 p0~p5;單機用 me)
  function fill(i, ch, cls) {
    if (i < 0 || i >= rows * cols || block[i] || given[i]) return;
    vals[i] = ch; owners[i] = cls || "me";
    repaint();
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
    repaint();
  }

  /* ---------- 畫面 ---------- */
  function repaint() {
    for (let i = 0; i < rows * cols; i++) {
      const el = cells[i]; if (!el || block[i]) continue;
      const v = vals[i];
      let cls = "cy-cell";
      if (given[i]) cls += " given";
      else if (v) cls += " filled " + (owners[i] || "me");
      if (i === sel) cls += " sel";
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
  function freeze(ms) {
    frozenUntil = Date.now() + ms;
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
      }
    };
    paint();
    freezeTick = setInterval(paint, 200);
  }
  function unfreeze() {
    frozenUntil = 0;
    if (freezeTick) { clearInterval(freezeTick); freezeTick = null; }
    if (wrap) wrap.classList.remove("frozen");
    const el = $("cyFreeze"); if (el) el.classList.add("hidden");
  }

  /* ---------- 查詢 ---------- */
  function remaining() { let k = 0; for (let i = 0; i < rows * cols; i++) if (!block[i] && !vals[i]) k++; return k; }
  function filledCount() { let k = 0; for (let i = 0; i < rows * cols; i++) if (!block[i] && vals[i] && !given[i]) k++; return k; }
  function isComplete() { return remaining() === 0; }
  function firstEmpty() { for (let i = 0; i < rows * cols; i++) if (!block[i] && !vals[i]) return i; return -1; }
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
    remaining, filledCount, isComplete, firstEmpty, coordName,
    repaint
  };
})();

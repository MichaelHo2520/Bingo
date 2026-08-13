"use strict";

/* ============================================================================
   成語接龍 — 單機練習(Solo)。完全不碰 Firebase,就是「對戰模式扣掉連線層」。
   共用 CYB(盤面 + 字卡區)與結果卡 DOM,周邊 HUD 換成計時 / 錯誤 / 提示。

   單機才有意義、連線刻意不做的:提示、暫停(比照數獨,但**不做筆記**——
   那是數獨數字互斥推理才有意義的功能,字謎盤沒有這種推理空間)。
   ========================================================================== */

const Solo = (function () {
  const MAX_HINT = 3;
  let q = null, level = "std";
  let t0 = 0, elapsed = 0, tick = null, paused = false;
  let mistakes = 0, hints = 0, running = false;

  function fmt(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return (m < 10 ? "0" : "") + m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
  }
  function paintHud() {
    const t = $("cyTime"); if (t) t.textContent = fmt(elapsed);
    const m = $("cyMiss"); if (m) m.textContent = "✗ " + mistakes;
    const h = $("cyHintBtn");
    if (h) {
      h.textContent = "💡 提示 " + (MAX_HINT - hints);
      h.disabled = hints >= MAX_HINT || !running || paused;
    }
    const lv = $("cyLevelTag");
    if (lv) { const L = CYGen.levelOf(level); lv.textContent = L.label + " · " + L.name; }
  }
  function startTick() {
    stopTick();
    t0 = Date.now() - elapsed;
    tick = setInterval(() => { if (!paused) { elapsed = Date.now() - t0; paintHud(); } }, 250);
  }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

  /* ---------- 偏好:單機難度獨立存 ----------
     刻意不跟連線的 diff 共用一個值(比照數獨的 sudoku.solo.v1)。 */
  const OWN_KEY = "chengyu.solo.v1";
  function loadOwn() {
    try {
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if (CYGen.LEVELS[o.level]) level = o.level;
    } catch (e) {}
  }
  function saveOwn() {
    try { localStorage.setItem(OWN_KEY, JSON.stringify({ level: level })); } catch (e) {}
  }

  /* ---------- 開始 / 結束 ---------- */
  function start(lv) {
    level = lv || level;
    q = CYGen.make(level);
    elapsed = 0; mistakes = 0; hints = 0; paused = false; running = true;
    CYB.setPuzzle(q);
    CYB.setEnabled(true);
    CYB.setSel(CYB.firstEmpty());
    showScreen("solo");
    startTick(); paintHud();
    Sound.start();
    saveOwn();
  }
  function quit() {
    running = false; stopTick(); CYB.setEnabled(false);
    /* ★ v1.156.0:暫停中離開要收掉蓋板與 ⏸/▶ 的字 —— 否則留下一張點了完全沒反應的
       全螢幕黑幕。⚠ 目前是**防禦性的、走不到**(蓋板會攔住返回鈕、finish 有 paused 守衛),
       真正生效的是 ui-kit.js 的 BACK_LAYERS —— 完整說明在 js/sudoku/solo.js 的 quit()。 */
    paused = false;
    const pv = $("cyPauseVeil"); if (pv) pv.classList.remove("show");
    const pb = $("cyPauseBtn"); if (pb) pb.textContent = "⏸";
    closeWin();
    showScreen("home");
  }
  function togglePause() {
    if (!running) return;
    paused = !paused;
    if (!paused) t0 = Date.now() - elapsed;
    CYB.setEnabled(!paused);
    const v = $("cyPauseVeil"); if (v) v.classList.toggle("show", paused);
    const b = $("cyPauseBtn"); if (b) b.textContent = paused ? "▶" : "⏸";
  }

  /* ---------- 操作 ---------- */
  function onNum(i, ch) {
    if (!running || paused) return;
    if (CYB.valueAt(i) === ch) { CYB.clear(i); return; }   // 再點同一個字 = 清掉
    if (CYB.solAt(i) === ch) {
      CYB.fill(i, ch, "me");
      Sound.place();
      if (CYB.isComplete()) finish();
      else {
        const nx = CYB.firstEmpty();
        if (nx >= 0 && CYB.valueAt(i)) CYB.setSel(nx);      // 自動跳到下一個空格,少點一次
      }
    } else {
      mistakes++;
      CYB.flashWrong(i);
      try { Sound.lose && Sound.lose(); } catch (e) {}
      paintHud();
    }
  }
  function onErase(i) { if (running && !paused && i >= 0) CYB.clear(i); }
  function hint() {
    if (!running || paused || hints >= MAX_HINT) return;
    let i = CYB.sel();
    if (i < 0 || CYB.valueAt(i)) i = CYB.firstEmpty();
    if (i < 0) return;
    hints++;
    CYB.fill(i, CYB.solAt(i), "hintfill");   // ★ 不可叫 hint:撞既有的 .hint 說明文字樣式
    CYB.setSel(i);
    Sound.place();
    paintHud();
    if (CYB.isComplete()) finish();
  }

  function finish() {
    running = false; stopTick(); CYB.setEnabled(false); CYB.markDone();
    const L = CYGen.levelOf(level);
    const card = $("cyWinCard");
    if (card) { card.classList.remove("win", "lose", "draw"); card.classList.add("win"); }
    $("winWord").textContent = "完成!";
    $("winMsg").textContent = L.label + " " + L.name + " · 用了 " + fmt(elapsed);
    const box = $("cyStats");
    if (box) {
      box.innerHTML =
        '<div class="cy-stat"><span class="ss-k">時間</span><span class="ss-v">' + fmt(elapsed) + '</span></div>' +
        '<div class="cy-stat"><span class="ss-k">填錯</span><span class="ss-v">' + mistakes + ' 次</span></div>' +
        '<div class="cy-stat"><span class="ss-k">提示</span><span class="ss-v">' + hints + ' 次</span></div>';
      box.classList.remove("hidden");
    }
    Sound.win(); burst();
    showResult();
  }

  return {
    start, quit, togglePause, hint, onNum, onErase, loadOwn,
    running: () => running, level: () => level,
    setLevel(v) { if (CYGen.LEVELS[v]) { level = v; saveOwn(); } },
    isPaused: () => paused,
    paintHud
  };
})();

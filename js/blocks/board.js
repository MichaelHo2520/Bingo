"use strict";

/* ============================================================================
   方塊對戰 — 盤面(BLKB):Canvas 繪圖 · 輸入 · 本機 game loop

   ★ 這一支**不知道自己在單機還是連線**(與另外十三頁的 board.js 同一個規矩)。
     它只做四件事:量尺寸、畫、收輸入、每幀推進規則,然後把規則吐出來的事件
     原樣交給 mount() 給的 onEvents —— 由 solo.js / adapter.js 決定那代表什麼。

   ── ★★★ 七條會直接做錯的事 ───────────────────────────────────────────────
     ① **舞台不可以有會佔版面的捲軸。** fitBoard() 量的就是它:捲軸一出現就縮一階、
        縮完又放得下、捲軸消失、又放大 → **自己震盪下去**。
        跳棋 / 飛行棋 / 麻將消消樂 v2.4.4 已經連三次,裝飾也算。
        → 這一頁的 .blk-stage 一律 overflow:hidden。
     ② **所有特效畫在 canvas 裡,不用 CSS @keyframes。**
        理由是紅線 17 的那條坑:`animationName` 指向一個**不存在的** @keyframes 時
        量起來一模一樣(大老二的倒數條這樣壞了十四個版本)。畫在 canvas 裡的東西
        「有沒有在動」是 t 的函式,測得到。
     ③ **消行動畫要的是「消之前」的盤面。** rules 的 lock() 當場就把整列拿掉了,
        所以要在 tick 之前先留一份 —— 但**只有貼地那幾幀才留**(每幀複製 22 個
        陣列是白工)。
     ④ **DAS/ARR 的累積器要在 loop 裡走,不可以靠 keydown 的自動重複。**
        作業系統的自動重複速率使用者可以自己改,而且手機按鈕根本沒有這件事。
     ⑤ **旋轉與硬降不連發。** 連發的旋轉會讓方塊在手指按住時瘋狂轉。
     ⑥ **canvas 的底色交給 CSS**(玻璃感靠 backdrop-filter)—— 這裡一律 clearRect,
        不要 fillRect 整片,不然主題就透不過來了。
     ⑦ **七種方塊的顏色固定,不隨主題變。** 辨識度就是公平性:主題把 S/Z 調成兩個
        相近的顏色,那個人就會一直放錯。主題只換外框、光暈與背景(--blk-glow)。
   ========================================================================== */

const BLKB = (function(){

  const R = BLK;                        // 規則引擎(唯一真相)

  /* ==========================================================================
     一、顏色與尺寸
     ========================================================================== */
  /* 七種方塊 + 垃圾。★ 固定不隨主題變(見紅線 ⑦) */
  const COL = ["#2fd6e4", "#4b7bec", "#ff9f43", "#ffd93d", "#3ddc7f", "#b06bff", "#ff5d6c"];
  const COL_GARB = "#6b7a8f";
  const MINC = 12, MAXC = 34;           // 一格的 px 上下限
  const PREV = 0.62;                    // 預覽格 = 主盤格的幾倍

  /* 手感參數。★ 這三個就是「好不好玩」的旋鈕,改之前先想清楚要調誰的體感 */
  const DAS_MS = [180, 133, 95];        // 慢 / 標準 / 快
  const ARR_MS = [55, 33, 18];
  let feel = 1;                         // 0..2,對應上面兩張表

  /* 手勢參數 */
  const G_STEP = 26;                    // 橫拖幾 px 走一格
  const G_SOFT = 30;                    // 下拖幾 px 開始軟降
  const G_FLICK = 480;                  // 下滑速度超過這個(px/s)算硬降
  const G_TAP = 12;                     // 位移小於這個才算點擊(旋轉)

  /* ==========================================================================
     二、狀態
     ========================================================================== */
  let cfg = { onEvents: function(){}, canPlay: function(){ return true; } };
  let st = null;                        // 目前在畫的規則狀態
  let mounted = false, running = false, raf = 0, lastT = 0;
  let cell = 24, prev = 15, dpr = 1;

  let elStage, elWrap, elGauge, elGaugeFill, elPad;
  let cvMain, ctxM, cvSide, ctxS;
  /* 網格線的顏色跟著主題走(定義在 styles.src.css 的 --blk-grid)。
     ⚠ 每幀都去 getComputedStyle 是白工,所以在 fitBoard() 讀一次存著。
     ⚠ 換主題不會自動觸發 fitBoard() → setTheme 之後要再叫一次(main.js 的 showScreen 會)。 */
  let gridCol = "rgba(255,255,255,.055)";

  /* 特效(全部畫在 canvas 裡,見紅線 ②) */
  const fx = {
    shake: 0,                           // 剩餘震動強度(px)
    clear: null,                        // { rows, pre, t, dur, n }
    parts: [],                          // 粒子
    trail: null,                        // { k, r, x, y0, y1, t }
    pops: [],                           // 浮字
    hit: 0                              // 收到攻擊的邊框閃光
  };

  /* 輸入 */
  const inp = { dir: 0, dasT: 0, arrT: 0, soft: false, keys: {} };
  let gest = null;                      // 手勢中的指標
  let ctrlMode = "btn";                 // "btn" | "swipe" | "both"

  /* ==========================================================================
     三、小工具
     ========================================================================== */
  function T(f, o){ if(typeof Sound !== "undefined" && Sound.tone) Sound.tone(f, o); }
  function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
  function ease(t){ return 1 - Math.pow(1 - t, 3); }             // easeOutCubic
  /* hex 明暗調整(不引入任何色彩函式庫) */
  function shade(hex, amt){
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if(amt >= 0){ r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
    return "rgb(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + ")";
  }
  function colOf(v){ return v === R.GARB ? COL_GARB : COL[v - 1] || "#888"; }
  function reduced(){
    try{ return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch(e){ return false; }
  }

  /* ==========================================================================
     四、量尺寸
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 紅線 ①:舞台是 overflow:hidden 的,所以這裡量到的永遠是「真的可用的空間」,
         不會因為自己畫太大而長出捲軸、再把自己縮小、再放大…(那個震盪已經三次了)。
       算式:可用寬 = 主盤(10 格) + 右側預覽(4 個預覽格) + 警示條 + 間距
     ========================================================================== */
  function fitBoard(){
    if(!mounted || !elStage) return;
    const rect = elStage.getBoundingClientRect();
    /* ⚠ 舞台裡**只有盤面** —— HUD 與控制列是它的兄弟(見 blocks.html 的註解),
       所以這裡不必再去減控制列的高度。減過頭的症狀是盤面永遠小一號。 */
    const availW = Math.max(120, rect.width - 4);
    const availH = Math.max(120, rect.height - 6);

    const byW = (availW - 26) / (R.COLS + 4 * PREV);    // 26 = 警示條 + 兩道間距
    const byH = availH / R.VIS;
    cell = Math.round(clamp(Math.min(byW, byH), MINC, MAXC));
    prev = Math.max(7, Math.round(cell * PREV));
    dpr = Math.min(3, window.devicePixelRatio || 1);

    const g = getComputedStyle(cvMain).getPropertyValue("--blk-grid").trim();
    if(g) gridCol = g;

    sizeCanvas(cvMain, ctxM, R.COLS * cell, R.VIS * cell);
    sizeCanvas(cvSide, ctxS, 4 * prev, R.VIS * cell);
    if(elGauge) elGauge.style.height = (R.VIS * cell) + "px";
    draw();
  }
  function sizeCanvas(cv, ctx, w, h){
    if(!cv) return;
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ==========================================================================
     五、畫一格
     ──────────────────────────────────────────────────────────────────────────
       圓角 + 上下漸層 + 頂緣高光 + 底緣暗邊。這四件事湊起來才有「立體但不俗氣」,
       少任何一件都會變成扁平色塊。
     ========================================================================== */
  function roundRect(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }
  function cellAt(ctx, px, py, s, col, o){
    o = o || {};
    const pad = Math.max(1, s * 0.06);
    const x = px + pad, y = py + pad, w = s - pad * 2, h = s - pad * 2;
    const r = Math.max(2, s * 0.16);
    if(o.alpha !== undefined) ctx.globalAlpha = o.alpha;

    if(o.glow){
      ctx.shadowColor = col;
      ctx.shadowBlur = Math.max(6, s * 0.45);
    }
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(col, 0.22));
    g.addColorStop(1, shade(col, -0.16));
    ctx.fillStyle = g;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 頂緣高光 + 底緣暗邊
    const lw = Math.max(1, s * 0.055);
    ctx.lineWidth = lw;
    ctx.strokeStyle = "rgba(255,255,255,.42)";
    ctx.beginPath();
    ctx.moveTo(x + r, y + lw / 2);
    ctx.lineTo(x + w - r, y + lw / 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,.30)";
    ctx.beginPath();
    ctx.moveTo(x + r, y + h - lw / 2);
    ctx.lineTo(x + w - r, y + h - lw / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  /* Ghost:只有描邊 + 很淡的填色。**不要畫成半透明實心** —— 會跟已鎖定的格子混淆 */
  function ghostAt(ctx, px, py, s, col){
    const pad = Math.max(1, s * 0.06);
    const r = Math.max(2, s * 0.16);
    roundRect(ctx, px + pad, py + pad, s - pad * 2, s - pad * 2, r);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.10;
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1.2, s * 0.07);
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* ==========================================================================
     六、畫整盤
     ========================================================================== */
  function draw(){
    if(!ctxM) return;
    const W = R.COLS * cell, H = R.VIS * cell;
    ctxM.clearRect(0, 0, W, H);         // ⚠ 紅線 ⑥:底色是 CSS 的,這裡不填滿
    ctxM.save();
    if(fx.shake > 0.3){
      const a = Math.random() * Math.PI * 2;
      ctxM.translate(Math.cos(a) * fx.shake, Math.sin(a) * fx.shake);
    }

    grid(W, H);
    if(st){
      const cl = fx.clear;
      const board = (cl && cl.pre) ? cl.pre : st.board;
      const slide = cl ? (1 - ease(Math.min(1, cl.t / cl.dur))) : 0;
      lockedCells(board, cl, slide);
      /* ⚠ 白閃那一段(cl.pre 還在)才藏起新的一顆 —— 整個動畫都藏的話,
         會看成「方塊消失了 0.25 秒」。滑下來那一段要看得到新的一顆。 */
      if(!cl || !cl.pre) activePiece();
      trail();
      if(cl) clearFx(cl);
    }
    particles();
    pops();
    ctxM.restore();
    edgeFlash(W, H);
    side();
    gauge();
  }

  function grid(W, H){
    ctxM.strokeStyle = gridCol;
    ctxM.lineWidth = 1;
    ctxM.beginPath();
    for(let x = 1; x < R.COLS; x++){ ctxM.moveTo(x * cell + .5, 0); ctxM.lineTo(x * cell + .5, H); }
    for(let y = 1; y < R.VIS; y++){ ctxM.moveTo(0, y * cell + .5); ctxM.lineTo(W, y * cell + .5); }
    ctxM.stroke();
  }

  /* 已鎖定的格子。消行動畫進行中時,「被消掉那幾列以上」的整塊要從舊位置滑下來 */
  function lockedCells(board, cl, slide){
    const maxRow = cl ? Math.max.apply(null, cl.rows) : -1;
    for(let y = R.TOP; y < R.ROWS; y++){
      const dy = (cl && !cl.pre && y <= maxRow) ? -cl.n * cell * slide : 0;
      for(let x = 0; x < R.COLS; x++){
        const v = board[y][x];
        if(!v) continue;
        if(cl && cl.pre && cl.rows.indexOf(y) >= 0) continue;   // 那幾列由 clearFx 畫
        cellAt(ctxM, x * cell, (y - R.TOP) * cell + dy, cell, colOf(v));
      }
    }
  }

  function activePiece(){
    const c = st.cur;
    if(!c) return;
    const col = COL[c.k];
    // Ghost
    const gy = R.ghostY(st);
    if(gy !== c.y){
      R.cellsOf(c.k, c.r, c.x, gy).forEach(p => {
        if(p[1] >= R.TOP) ghostAt(ctxM, p[0] * cell, (p[1] - R.TOP) * cell, cell, col);
      });
    }
    R.cellsOf(c.k, c.r, c.x, c.y).forEach(p => {
      if(p[1] >= R.TOP) cellAt(ctxM, p[0] * cell, (p[1] - R.TOP) * cell, cell, col, { glow: !reduced() });
    });
  }

  /* 硬降的殘影拖尾 */
  function trail(){
    const t = fx.trail;
    if(!t) return;
    const k = 1 - t.t / t.dur;
    if(k <= 0){ fx.trail = null; return; }
    const col = COL[t.k];
    for(let i = 1; i <= 4; i++){
      const y = t.y1 - i * Math.max(1, Math.round((t.y1 - t.y0) / 5));
      if(y < t.y0) break;
      R.cellsOf(t.k, t.r, t.x, y).forEach(p => {
        if(p[1] < R.TOP) return;
        cellAt(ctxM, p[0] * cell, (p[1] - R.TOP) * cell, cell, col, { alpha: k * 0.30 * (1 - i / 5) });
      });
    }
  }

  /* 消行:整列白閃 → 收合 */
  function clearFx(cl){
    const t = Math.min(1, cl.t / cl.dur);
    if(!cl.pre) return;                 // 已經進到「上面滑下來」那一段
    const k = 1 - t;
    cl.rows.forEach(y => {
      const py = (y - R.TOP) * cell;
      if(py < 0) return;
      ctxM.globalAlpha = 0.16 + 0.75 * k;
      ctxM.fillStyle = "#fff";
      const h = cell * (0.35 + 0.65 * k);
      ctxM.fillRect(0, py + (cell - h) / 2, R.COLS * cell, h);
      ctxM.globalAlpha = 1;
    });
  }

  function particles(){
    for(let i = 0; i < fx.parts.length; i++){
      const p = fx.parts[i];
      const k = 1 - p.t / p.dur;
      if(k <= 0) continue;
      ctxM.globalAlpha = k;
      ctxM.fillStyle = p.c;
      ctxM.fillRect(p.x, p.y, p.s, p.s);
    }
    ctxM.globalAlpha = 1;
  }

  function pops(){
    const W = R.COLS * cell;
    for(let i = 0; i < fx.pops.length; i++){
      const p = fx.pops[i];
      const t = p.t / p.dur;
      if(t >= 1) continue;
      // 前 18% 彈出、最後 30% 淡出上飄
      const s = t < 0.18 ? (0.6 + 0.4 * (t / 0.18)) : 1;
      const a = t > 0.70 ? (1 - (t - 0.70) / 0.30) : 1;
      const rise = t > 0.70 ? (t - 0.70) / 0.30 * cell * 1.2 : 0;
      ctxM.save();
      ctxM.globalAlpha = a;
      ctxM.translate(W / 2, p.y - rise);
      ctxM.scale(s, s);
      ctxM.textAlign = "center";
      ctxM.textBaseline = "middle";
      ctxM.font = "800 " + Math.round(cell * p.size) + "px Fredoka, Nunito, system-ui, sans-serif";
      ctxM.lineWidth = Math.max(3, cell * 0.22);
      ctxM.strokeStyle = "rgba(0,0,0,.55)";
      ctxM.strokeText(p.txt, 0, 0);
      ctxM.fillStyle = p.c;
      ctxM.fillText(p.txt, 0, 0);
      ctxM.restore();
    }
  }

  /* 收到攻擊時整盤外框閃一下(光束要等有對手才畫,見 P3) */
  function edgeFlash(W, H){
    if(fx.hit <= 0) return;
    ctxM.save();
    ctxM.globalAlpha = Math.min(1, fx.hit);
    ctxM.strokeStyle = "#ff5d6c";
    ctxM.lineWidth = Math.max(2, cell * 0.16);
    ctxM.strokeRect(1, 1, W - 2, H - 2);
    ctxM.restore();
  }

  /* ---------- 右側:Hold + Next ---------- */
  function side(){
    if(!ctxS) return;
    const W = 4 * prev, H = R.VIS * cell;
    ctxS.clearRect(0, 0, W, H);
    if(!st) return;
    ctxS.font = "700 " + Math.max(9, Math.round(prev * 0.72)) + "px Nunito, system-ui, sans-serif";
    ctxS.textAlign = "center";
    ctxS.textBaseline = "top";
    ctxS.fillStyle = "rgba(255,255,255,.55)";

    let y = 0;
    ctxS.fillText("HOLD", W / 2, y);
    y += prev * 1.0;
    if(st.hold >= 0) piecePreview(ctxS, st.hold, 0, y, W, prev * 2.2, st.canHold ? 1 : 0.35);
    y += prev * 2.4;

    ctxS.fillStyle = "rgba(255,255,255,.55)";
    ctxS.fillText("NEXT", W / 2, y);
    y += prev * 1.0;
    const nx = R.peek(st.seed, st.idx, 5);
    for(let i = 0; i < nx.length; i++){
      const h = (i === 0) ? prev * 2.4 : prev * 2.0;
      if(y + h > H) break;
      piecePreview(ctxS, nx[i], 0, y, W, h, i === 0 ? 1 : 0.78);
      y += h + prev * 0.2;
    }
  }
  /* 把一顆方塊置中畫進一個框裡 */
  function piecePreview(ctx, k, bx, by, bw, bh, alpha){
    const cs = R.CELLS[k][0];
    let minX = 9, maxX = -9, minY = 9, maxY = -9;
    cs.forEach(c => {
      if(c[0] < minX) minX = c[0]; if(c[0] > maxX) maxX = c[0];
      if(c[1] < minY) minY = c[1]; if(c[1] > maxY) maxY = c[1];
    });
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const s = Math.min(bw / (w + 0.6), bh / (h + 0.6));
    const ox = bx + (bw - w * s) / 2, oy = by + (bh - h * s) / 2;
    cs.forEach(c => {
      cellAt(ctx, ox + (c[0] - minX) * s, oy + (c[1] - minY) * s, s, COL[k], { alpha: alpha });
    });
  }

  /* ---------- 左側:待處理垃圾的警示條 ----------
     ⚠ 用 transform: scaleY 改高度,**不要改 height** —— 後者每幀觸發版面計算。 */
  function gauge(){
    if(!elGaugeFill || !st) return;
    const n = R.pendCount(st);
    const k = Math.min(1, n / 10);
    elGaugeFill.style.transform = "scaleY(" + k.toFixed(3) + ")";
    elGauge.classList.toggle("blk-gauge-hot", n >= 4);
    elGauge.classList.toggle("blk-gauge-on", n > 0);
  }

  /* ==========================================================================
     七、事件 → 特效
     ========================================================================== */
  function addParts(rows){
    if(reduced()) return;
    const pre = fx.clear && fx.clear.pre;
    if(!pre) return;
    let n = 0;
    rows.forEach(y => {
      for(let x = 0; x < R.COLS; x++){
        const v = pre[y][x];
        if(!v || n > 160) continue;
        for(let i = 0; i < 3; i++){
          n++;
          fx.parts.push({
            x: x * cell + Math.random() * cell,
            y: (y - R.TOP) * cell + Math.random() * cell,
            vx: (Math.random() - 0.5) * 0.18 * cell,
            vy: -(0.10 + Math.random() * 0.22) * cell,
            s: Math.max(2, cell * 0.16), c: colOf(v), t: 0, dur: 420 + Math.random() * 260
          });
        }
      }
    });
  }
  function pop(txt, col, size){
    fx.pops.push({ txt: txt, c: col, size: size || 0.92, y: R.VIS * cell * 0.34, t: 0, dur: 900 });
  }
  function shake(px){ if(!reduced()) fx.shake = Math.max(fx.shake, px); }

  function onLock(ev, pre){
    if(ev.drop > 2 && !reduced())
      fx.trail = { k: ev.k, r: ev.r, x: ev.x, y0: ev.y - ev.drop, y1: ev.y, t: 0, dur: 140 };
    if(ev.rows.length){
      fx.clear = { rows: ev.rows.slice(), pre: preWith(pre, ev), t: 0, dur: 170, n: ev.rows.length };
      addParts(ev.rows);
      T(560 + ev.rows.length * 90, { type: "triangle", dur: 0.12, vol: 0.18, slideTo: 900 + ev.rows.length * 150 });
      if(ev.rows.length === 4){ shake(6); pop("TETRIS!", "#ffd93d", 1.05); }
      else shake(2);
      if(ev.combo >= 2) pop("連擊 ×" + ev.combo, "#2fd6e4", 0.76);
      if(ev.pc){ pop("ALL CLEAR", "#3ddc7f", 0.96); shake(8); }
    }else{
      T(300, { type: "sine", dur: 0.05, vol: 0.10, slideTo: 210 });
      if(ev.drop > 4) shake(2);
    }
    if(ev.garb && ev.garb.length){
      let n = 0; ev.garb.forEach(g => { n += g.n; });
      shake(Math.min(7, 1.5 + n));
      fx.hit = 1;
      T(180, { type: "sawtooth", dur: 0.16, vol: 0.14, slideTo: 110 });
    }
  }

  /* 收到攻擊(還沒推上來,只是進佇列)—— 給一個看得到的回饋 */
  function incoming(n){
    fx.hit = Math.max(fx.hit, 0.8);
    T(740, { type: "square", dur: 0.07, vol: 0.10, slideTo: 420 });
    if(n >= 4) shake(3);
  }

  /* ==========================================================================
     八、輸入
     ──────────────────────────────────────────────────────────────────────────
       一個收斂點:act(name)。鍵盤、按鈕、手勢三條路全部走它,
       所以「這個動作現在能不能做」只有一個地方要判(紅線:不要散在各個 handler)。
     ========================================================================== */
  function act(name){
    if(!st || !running || st.dead || !cfg.canPlay()) return;
    if(name === "left" || name === "right"){
      if(R.move(st, name === "left" ? -1 : 1)) T(420, { type: "sine", dur: 0.03, vol: 0.06 });
    }else if(name === "cw" || name === "ccw"){
      if(R.rotate(st, name === "cw" ? 1 : -1)) T(620, { type: "sine", dur: 0.04, vol: 0.08, slideTo: 760 });
    }else if(name === "hold"){
      if(R.holdSwap(st)) T(500, { type: "triangle", dur: 0.06, vol: 0.10, slideTo: 380 });
    }else if(name === "hard"){
      if(!st.cur) return;
      const pre = snapPre();            // ★ 一定要在 hardDrop **之前**(紅線 ③)
      const ev = R.hardDrop(st);
      if(!ev) return;
      onLock(ev, pre);
      cfg.onEvents([ev], st);
      T(240, { type: "square", dur: 0.05, vol: 0.14, slideTo: 90 });
    }
  }

  /* 留一份盤面給消行動畫用(紅線 ③)。
     ⚠ 這一份是「方塊還沒寫進去」的,所以 onLock 會用 ev.cells 把那四格補上去 ——
       規則裡「寫進去之後、消掉之前」那一瞬間在外面拿不到。 */
  function snapPre(){ return st ? st.board.map(r => r.slice()) : null; }
  function preWith(pre, ev){
    if(!pre || !ev.cells) return pre;
    ev.cells.forEach(p => { if(pre[p[1]]) pre[p[1]][p[0]] = ev.k + 1; });
    return pre;
  }

  /* ---------- 鍵盤 ---------- */
  const KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right", ArrowDown: "soft", ArrowUp: "cw",
    " ": "hard", Spacebar: "hard", x: "cw", X: "cw", z: "ccw", Z: "ccw",
    c: "hold", C: "hold", Shift: "hold"
  };
  function onKeyDown(e){
    const a = KEYMAP[e.key];
    if(!a) return;
    e.preventDefault();
    if(inp.keys[e.key]) return;         // ⚠ 紅線 ④:不吃作業系統的自動重複
    inp.keys[e.key] = 1;
    press(a);
  }
  function onKeyUp(e){
    const a = KEYMAP[e.key];
    if(!a) return;
    delete inp.keys[e.key];
    release(a);
  }

  /* ---------- 按下 / 放開 的共用語意 ---------- */
  function press(a){
    if(a === "left" || a === "right"){
      const d = (a === "left") ? -1 : 1;
      inp.dir = d; inp.dasT = 0; inp.arrT = 0;
      act(a);
    }else if(a === "soft"){
      inp.soft = true; if(st) st.soft = true;
    }else{
      act(a);                           // 旋轉 / 硬降 / Hold 一律不連發(紅線 ⑤)
    }
  }
  function release(a){
    if(a === "left" && inp.dir < 0) inp.dir = 0;
    else if(a === "right" && inp.dir > 0) inp.dir = 0;
    else if(a === "soft"){ inp.soft = false; if(st) st.soft = false; }
  }

  /* ---------- 螢幕按鈕 ---------- */
  function bindPad(){
    if(!elPad) return;
    elPad.addEventListener("pointerdown", e => {
      const b = e.target.closest("button[data-act]");
      if(!b) return;
      e.preventDefault();
      /* ⚠ setPointerCapture 會丟例外(指標已經抬起來、或是合成出來的事件沒有真的 pointerId)——
         而它丟出來的是**未捕捉的錯誤**,會被 feedback.js 的環形緩衝當成一筆 JS 錯誤記下來。
         捕捉不到就退回「沒有 capture」,按鈕照樣能用(只是拖出按鈕外放開時收不到 up ——
         下面的 pointercancel / lostpointercapture 兩條就是為了這個)。 */
      try{ b.setPointerCapture && b.setPointerCapture(e.pointerId); }catch(_){}
      b.classList.add("blk-on");
      press(b.dataset.act);
    });
    const up = e => {
      const b = e.target.closest ? e.target.closest("button[data-act]") : null;
      if(!b) return;
      b.classList.remove("blk-on");
      release(b.dataset.act);
    };
    elPad.addEventListener("pointerup", up);
    elPad.addEventListener("pointercancel", up);
    elPad.addEventListener("lostpointercapture", up);
    // ⚠ 阻止長按選單與雙擊縮放(手機上這兩個會把操作吃掉)
    elPad.addEventListener("contextmenu", e => e.preventDefault());
  }

  /* ---------- 手勢(選配)---------- */
  function bindGesture(){
    if(!cvMain) return;
    cvMain.addEventListener("pointerdown", e => {
      if(ctrlMode === "btn") return;
      try{ cvMain.setPointerCapture && cvMain.setPointerCapture(e.pointerId); }catch(_){}
      gest = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
               t0: performance.now(), moved: 0, soft: false, done: false };
    });
    cvMain.addEventListener("pointermove", e => {
      if(!gest || gest.done) return;
      const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
      gest.moved += Math.abs(dx) + Math.abs(dy);
      while(Math.abs(e.clientX - gest.x) >= G_STEP){
        const d = (e.clientX > gest.x) ? 1 : -1;
        act(d > 0 ? "right" : "left");
        gest.x += d * G_STEP;
      }
      if(dy > 0 && (e.clientY - gest.y0) > G_SOFT && !gest.soft){
        gest.soft = true; inp.soft = true; if(st) st.soft = true;
      }
    });
    const end = e => {
      if(!gest) return;
      const dt = Math.max(1, performance.now() - gest.t0);
      const dy = e.clientY - gest.y0;
      const vy = dy / dt * 1000;
      if(gest.soft){ inp.soft = false; if(st) st.soft = false; }
      if(!gest.done){
        if(vy > G_FLICK && dy > G_SOFT) act("hard");
        else if(gest.moved < G_TAP) act("cw");
      }
      gest = null;
    };
    cvMain.addEventListener("pointerup", end);
    cvMain.addEventListener("pointercancel", () => { if(gest && gest.soft){ inp.soft = false; if(st) st.soft = false; } gest = null; });
  }

  /* ==========================================================================
     九、game loop
     ========================================================================== */
  /* 一幀 = 推特效 + 推 DAS + 推規則 + 畫。
     ★ 抽成獨立函式是為了**測得到**:headless 的虛擬時間下 rAF 在 1500ms 裡只醒兩次
       (實測 raf=2),e2e 靠 rAF 根本推不動遊戲時間 → 那不是程式壞,是環境。
       所以 e2e 改成直接呼叫 BLKB.step(dt),而「rAF 迴圈有沒有被啟動」另外用
       BLKB.frames() 的計數守(真機上它每秒會 +60)。 */
  let frameN = 0;
  function frame(dt){
    frameN++;
    dt = Math.min(100, Math.max(0, dt || 0));
    stepFx(dt);
    if(running && st && !st.dead && cfg.canPlay()){
      stepDas(dt);
      const pre = R.grounded(st) ? snapPre() : null;   // ⚠ 紅線 ③:只有貼地那幾幀才留
      const evs = R.tick(st, dt);
      if(evs.length){
        evs.forEach(ev => { if(ev.t === "lock") onLock(ev, pre); });
        cfg.onEvents(evs, st);
      }
    }
    draw();
  }
  function loop(now){
    raf = requestAnimationFrame(loop);
    const dt = now - lastT;
    lastT = now;
    frame(dt);
  }
  function stepDas(dt){
    if(!inp.dir) return;
    const das = DAS_MS[feel], arr = ARR_MS[feel];
    inp.dasT += dt;
    if(inp.dasT < das) return;
    inp.arrT += dt;
    let guard = R.COLS + 2;
    while(inp.arrT >= arr && guard-- > 0){
      inp.arrT -= arr;
      if(!R.move(st, inp.dir)) break;
    }
  }
  function stepFx(dt){
    if(fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt * 0.045);
    if(fx.hit > 0) fx.hit = Math.max(0, fx.hit - dt * 0.004);
    if(fx.trail){ fx.trail.t += dt; if(fx.trail.t >= fx.trail.dur) fx.trail = null; }
    if(fx.clear){
      fx.clear.t += dt;
      // 前半段畫「消之前」的樣子,後半段換成已經收合的盤面 + 上面滑下來
      if(fx.clear.pre && fx.clear.t >= fx.clear.dur * 0.55){ fx.clear.pre = null; fx.clear.t = 0; fx.clear.dur = 150; }
      else if(!fx.clear.pre && fx.clear.t >= fx.clear.dur) fx.clear = null;
    }
    for(let i = fx.parts.length - 1; i >= 0; i--){
      const p = fx.parts[i];
      p.t += dt;
      if(p.t >= p.dur){ fx.parts.splice(i, 1); continue; }
      p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.vy += 0.030 * cell * dt / 16;
    }
    for(let i = fx.pops.length - 1; i >= 0; i--){
      fx.pops[i].t += dt;
      if(fx.pops[i].t >= fx.pops[i].dur) fx.pops.splice(i, 1);
    }
  }

  /* ==========================================================================
     十、對外
     ========================================================================== */
  function mount(c){
    if(c) cfg = Object.assign(cfg, c);
    elStage = document.getElementById("blkStage");
    elWrap  = document.getElementById("blkWrap");
    elGauge = document.getElementById("blkGauge");
    elGaugeFill = document.getElementById("blkGaugeFill");
    elPad   = document.getElementById("blkPad");
    cvMain  = document.getElementById("blkMain");
    cvSide  = document.getElementById("blkSide");
    if(!cvMain || !cvSide) return;
    ctxM = cvMain.getContext("2d");
    ctxS = cvSide.getContext("2d");
    mounted = true;
    bindPad();
    bindGesture();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", () => fitBoard());
    /* ⚠ 切到背景一律放開所有鍵:不放的話回來會是「一直往左跑」 */
    document.addEventListener("visibilitychange", () => { if(document.hidden) allUp(); });
    window.addEventListener("blur", allUp);
    if(!raf){ lastT = performance.now(); raf = requestAnimationFrame(loop); }
  }
  function allUp(){
    inp.dir = 0; inp.soft = false; inp.keys = {};
    if(st) st.soft = false;
    if(elPad) elPad.querySelectorAll(".blk-on").forEach(b => b.classList.remove("blk-on"));
  }
  function setState(s){
    st = s;
    fx.clear = null; fx.parts.length = 0; fx.pops.length = 0; fx.trail = null;
    fx.shake = 0; fx.hit = 0;
    allUp();
    fitBoard();
  }
  function play(){ running = true; lastT = performance.now(); allUp(); }
  function pause(){ running = false; allUp(); }
  function stop(){ running = false; allUp(); }
  function setFeel(i){ feel = clamp(i | 0, 0, DAS_MS.length - 1); }
  function setCtrl(m){ ctrlMode = (m === "swipe" || m === "both") ? m : "btn";
    if(elPad) elPad.classList.toggle("hidden", ctrlMode === "swipe"); }

  return {
    mount, setState, play, pause, stop, fitBoard, draw,
    act, setFeel, setCtrl, incoming, pop, shake,
    /* ★ 測試用的兩個出口(產品程式不會呼叫它們):
       step(dt) 手動推一幀、frames() 是 rAF 迴圈至今推了幾幀。 */
    step: frame,
    frames: () => frameN,
    state: () => st,
    cell: () => cell,
    COL, COL_GARB, DAS_MS, ARR_MS,
    feel: () => feel, ctrl: () => ctrlMode
  };
})();

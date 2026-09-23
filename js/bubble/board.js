"use strict";

/* ============================================================================
   泡泡對戰 — 盤面(BUBB):Canvas 繪圖 · 輸入 · 本機 game loop

   ★ 這一支**不知道自己在單機還是連線**(與方塊對戰的 BLKB 同一個規矩,介面也一樣):
     量尺寸、畫、收輸入、每幀推進規則,然後把規則吐出來的事件原樣交給 mount() 給的
     onEvents —— 由 solo.js / adapter.js 決定那代表什麼。
     ⚠ 這一支裡**不可以出現 firebase / MPCore / MP.xxx**(本機操作不等網路的結構保證)。

   ── ★★★ 七條會直接做錯的事 ───────────────────────────────────────────────
     ① **舞台不可以有會佔版面的捲軸**(fitBoard() 量的就是它 → 自己震盪)。
        跳棋 / 飛行棋 / 麻將消消樂 / 方塊對戰同一條。.bub-stage 一律 overflow:hidden,
        HUD 是舞台的兄弟,裡面只能有盤面與對手小盤(絕對定位)。
     ② **所有特效畫在 canvas 裡,不用 CSS @keyframes**(紅線 17:指向不存在的
        @keyframes 時量起來一模一樣)。
     ③ **預瞄線一律走 BUB.trace()**,不在這裡自己算彈道(rules.js 紅線 ②)。
     ④ **瞄準的輸入區是整個對局區(#bubPlay),不只 canvas** —— 手指在盤面外面拖
        (尤其是下方)才看得到盤面;只綁 canvas 的話手指一定擋住自己要瞄的地方。
        ⚠ 但對手小盤要讓開(點它是「鎖定攻擊目標」),判斷在 onDown() 第一行。
     ⑤ **放手的位置在發射器下方 = 取消**,不發射。這是手機上唯一的「反悔」手段,
        沒有它的話拖到一半發現瞄錯,只能硬射出去。
     ⑥ **canvas 的底色交給 CSS**(玻璃感)—— 這裡一律 clearRect。
     ⑦ **六種泡泡的顏色固定,不隨主題變**,而且每一色另外畫一個形狀記號 ——
        辨識度就是公平性(同方塊對戰紅線 ⑰、UNO 的顏色紅線),色弱的人也要分得出來。
   ========================================================================== */

const BUBB = (function(){

  const R = BUB;

  /* ==========================================================================
     一、顏色與尺寸
     ========================================================================== */
  /* 1..6。★ 固定不隨主題變(紅線 ⑦)—— 刻意避開「紅 / 橘」「藍 / 紫」這種近色對 */
  const COL = ["#ff5d6c", "#ffd93d", "#3ddc7f", "#4b7bec", "#b06bff", "#2fd6e4"];
  const MIND = 16, MAXD = 58;           // 一顆泡泡直徑的 px 上下限
  const GAUGE_W = 10;                   // 左緣警示條的寬(與 CSS 的 .bub-gauge 同步)
  const FOE_MIN = 52, FOE_MAX = 104, FOE_OVER = 62;   // 對手小盤那一條(同方塊對戰)
  const FOE_SHRINK_MIN = 26;            // 為了讓出小盤,盤面最多縮到一顆這麼大(見 fitBoard)
  const TURN = 0.0024;                  // 鍵盤 ←→ 每毫秒轉幾弧度

  /* ==========================================================================
     二、狀態
     ========================================================================== */
  let cfg = { onEvents: function(){}, canPlay: function(){ return true; }, onFrame: null };
  let st = null;
  let mounted = false, running = false, raf = 0, lastT = 0;
  let D = 32, dpr = 1;
  let elStage, elWrap, elGauge, elGaugeFill, elGaugeNum, elHud, elCast, elPlay;
  let cvMain, ctxM;
  let inkCol = "rgba(255,255,255,.9)";
  let lineCol = "rgba(255,255,255,.14)";

  const fx = {
    shake: 0, hit: 0,
    pops: [],                           // 消掉的:{ x, y, c, t }(盤面座標,單位 = 直徑)
    drops: [],                          // 掉落的:{ x, y, c, vy, t }
    words: [],                          // 浮字
    push: null,                         // 插排的滑入:{ n, t, dur }
    beams: []
  };
  /* 輸入。★ aiming = 手指 / 滑鼠正壓著在瞄;keys = 鍵盤方向鍵 */
  const inp = { aiming: false, id: null, cancel: false, keys: {}, turn: 0 };

  /* ==========================================================================
     三、小工具
     ========================================================================== */
  function T(f, o){ if(typeof Sound !== "undefined" && Sound.tone) Sound.tone(f, o); }
  function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
  function ease(t){ return 1 - Math.pow(1 - t, 3); }
  function shade(hex, amt){
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if(amt >= 0){ r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
    return "rgb(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + ")";
  }
  function colOf(v){ return COL[v - 1] || "#888"; }
  function reduced(){
    try{ return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch(e){ return false; }
  }

  /* ==========================================================================
     四、量尺寸
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 紅線 ①:舞台是 overflow:hidden,這裡量到的永遠是「真的可用的空間」。
       ★ 對手小盤只吃盤面用不到的空間(同方塊對戰 v2.14.0 的做法):
         先照「沒有小盤」算出一顆多大,剩下的寬夠就貼右側,不夠就疊在右上角。
     ========================================================================== */
  let foes = [], foeEls = [], elFoes = null;
  function fitBoard(){
    if(!mounted || !elStage) return;
    const spec = document.body.classList.contains("bub-spec");
    const foesOn = !!elFoes && !elFoes.classList.contains("hidden") && !spec;
    const rect = elStage.getBoundingClientRect();
    const availW = Math.max(120, rect.width - 4);
    const availH = Math.max(120, rect.height - 6);
    D = Math.round(clamp(Math.min((availW - GAUGE_W - 8) / R.COLS, availH / R.H), MIND, MAXD));
    dpr = Math.min(3, window.devicePixelRatio || 1);

    /* ⚠⚠ 與方塊對戰**不一樣**的一點:剩下的寬放不下小盤時,**先把盤面縮一階讓出來**,
       只有縮到太小(< FOE_SHRINK_MIN)才退回「疊在右上角」。
       方塊對戰的盤面是被**高度**卡住的(右側本來就空),而泡泡的盤面在手機直向是被
       **寬度**卡住的 —— 疊上去就是蓋住盤面的右上角,而那裡正是要瞄準的地方
       (第一張截圖就是這樣:兩塊小盤蓋掉最右邊一整欄)。 */
    let foeW = 0, foeOver = false;
    if(foesOn){
      let restW = availW - (R.COLS * D + GAUGE_W + 8);
      if(restW < FOE_MIN){
        const d2 = Math.floor((availW - GAUGE_W - 8 - FOE_MIN) / R.COLS);
        if(d2 >= FOE_SHRINK_MIN){ D = Math.min(D, d2); restW = availW - (R.COLS * D + GAUGE_W + 8); }
      }
      foeOver = restW < FOE_MIN;
      foeW = foeOver ? FOE_OVER : Math.min(FOE_MAX, Math.floor(restW));
    }
    if(elFoes){
      elFoes.classList.toggle("bub-foes-over", foeOver);
      elFoes.style.width = foeW ? (foeW + "px") : "";
    }
    if(elWrap) elWrap.style.marginRight = (foeW && !foeOver) ? (foeW + "px") : "";
    if(elHud) inkCol = getComputedStyle(elHud).color || inkCol;
    const g = getComputedStyle(cvMain).getPropertyValue("--bub-grid").trim();
    if(g) lineCol = g;

    sizeCanvas(cvMain, ctxM, R.COLS * D, Math.round(R.H * D));
    if(elGauge) elGauge.style.height = Math.round(R.H * D) + "px";
    fitFoes();
    fitFx();
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
     五、畫一顆泡泡
     ──────────────────────────────────────────────────────────────────────────
       放射漸層 + 左上高光 + 形狀記號。記號是色弱也分得出來的保險(紅線 ⑦),
       ⚠ 透明度壓低、不搶顏色 —— 它是輔助,主角仍然是顏色。
     ========================================================================== */
  function bubble(ctx, px, py, d, c, o){
    o = o || {};
    const r = d * 0.47;
    const col = colOf(c);
    if(o.alpha !== undefined) ctx.globalAlpha = o.alpha;
    if(o.glow){ ctx.shadowColor = col; ctx.shadowBlur = Math.max(6, d * 0.45); }
    const g = ctx.createRadialGradient(px - r * 0.35, py - r * 0.4, r * 0.1, px, py, r);
    g.addColorStop(0, shade(col, 0.55));
    g.addColorStop(0.55, col);
    g.addColorStop(1, shade(col, -0.32));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // 高光
    ctx.fillStyle = "rgba(255,255,255,.42)";
    ctx.beginPath(); ctx.ellipse(px - r * 0.34, py - r * 0.42, r * 0.28, r * 0.17, -0.6, 0, Math.PI * 2); ctx.fill();
    if(d >= 14) mark(ctx, px, py, r * 0.36, c);
    ctx.globalAlpha = 1;
  }
  function mark(ctx, x, y, s, c){
    ctx.save();
    ctx.globalAlpha *= 0.55;
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.lineWidth = Math.max(1.2, s * 0.32);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    if(c === 1){ ctx.arc(x, y, s * 0.55, 0, Math.PI * 2); ctx.fill(); }
    else if(c === 2){ ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.9, y + s * 0.6); ctx.lineTo(x - s * 0.9, y + s * 0.6); ctx.closePath(); ctx.stroke(); }
    else if(c === 3){ ctx.rect(x - s * 0.7, y - s * 0.7, s * 1.4, s * 1.4); ctx.stroke(); }
    else if(c === 4){ ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.stroke(); }
    else if(c === 5){ ctx.moveTo(x - s * 0.8, y - s * 0.8); ctx.lineTo(x + s * 0.8, y + s * 0.8); ctx.moveTo(x + s * 0.8, y - s * 0.8); ctx.lineTo(x - s * 0.8, y + s * 0.8); ctx.stroke(); }
    else { ctx.arc(x, y, s * 0.8, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }

  /* ==========================================================================
     六、畫整盤
     ========================================================================== */
  function pushOff(){
    const p = fx.push;
    if(!p) return 0;
    return p.n * R.RH * (1 - ease(Math.min(1, p.t / p.dur)));
  }
  function draw(){
    if(!ctxM) return;
    const W = R.COLS * D, Hh = Math.round(R.H * D);
    ctxM.clearRect(0, 0, W, Hh);        // ⚠ 紅線 ⑥
    ctxM.save();
    if(fx.shake > 0.3){
      const a = Math.random() * Math.PI * 2;
      ctxM.translate(Math.cos(a) * fx.shake, Math.sin(a) * fx.shake);
    }
    deadLine(W);
    if(st){
      const off = pushOff();
      for(let y = 0; y < R.ROWS; y++)
        for(let x = 0; x < R.COLS; x++){
          const v = st.board[y][x];
          if(!v) continue;
          bubble(ctxM, R.cx(st.par, x, y) * D, (R.cy(y) - off) * D, D, v);
        }
      popsFx();
      aimGuide();
      shotFx();
      launcher();
    }
    words();
    ctxM.restore();
    edgeFlash(W, Hh);
    gauge();
    drawFoes();
    drawBeams();
  }
  /* 死亡線:第 DEAD 列的上緣。快碰到的時候變紅(那一列是唯一真的要看的東西) */
  function deadLine(W){
    const y = (R.cy(R.DEAD) - 0.5) * D;
    const danger = st && R.lowest(st.board) >= R.DEAD - 2;
    ctxM.save();
    ctxM.setLineDash([D * 0.25, D * 0.18]);
    ctxM.strokeStyle = danger ? "rgba(255,93,108,.9)" : lineCol;
    ctxM.lineWidth = danger ? 2.5 : 1.5;
    ctxM.beginPath(); ctxM.moveTo(0, y); ctxM.lineTo(W, y); ctxM.stroke();
    ctxM.restore();
  }
  function popsFx(){
    for(let i = 0; i < fx.pops.length; i++){
      const p = fx.pops[i], k = p.t / 220;
      if(k >= 1) continue;
      ctxM.save();
      ctxM.globalAlpha = 1 - k;
      ctxM.strokeStyle = colOf(p.c); ctxM.lineWidth = Math.max(1.5, D * 0.08);
      ctxM.beginPath(); ctxM.arc(p.x * D, p.y * D, D * (0.47 + k * 0.5), 0, Math.PI * 2); ctxM.stroke();
      ctxM.restore();
      if(k < 0.4) bubble(ctxM, p.x * D, p.y * D, D * (1 + k), p.c, { alpha: 1 - k / 0.4 });
    }
    for(let i = 0; i < fx.drops.length; i++){
      const p = fx.drops[i], k = p.t / 700;
      if(k >= 1) continue;
      bubble(ctxM, p.x * D, p.y * D, D, p.c, { alpha: 1 - k * k });
    }
  }
  /* 預瞄線。⚠ 紅線 ③:一律走 trace()。
     ★ 只畫到「第一次反彈之後再 3 顆」—— 整條畫到底就等於告訴你落點,
       而判斷反彈角度正是這個遊戲要練的東西。沒反彈的直球本來就看得到落點,無所謂。 */
  function aimGuide(){
    if(!st || st.dead || !running) return;
    if(inp.aiming && inp.cancel) return;
    const t = R.trace(st.board, st.par, st.aim);
    const pts = t.path;
    let budget = 999, bounced = false;
    ctxM.save();
    ctxM.strokeStyle = "rgba(255,255,255,.55)";
    ctxM.lineWidth = Math.max(1.5, D * 0.07);
    ctxM.setLineDash([D * 0.12, D * 0.22]);
    ctxM.lineCap = "round";
    ctxM.beginPath();
    ctxM.moveTo(pts[0][0] * D, pts[0][1] * D);
    for(let i = 1; i < pts.length && budget > 0; i++){
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if(bounced && len > budget){
        const k = budget / len;
        ctxM.lineTo((a[0] + (b[0] - a[0]) * k) * D, (a[1] + (b[1] - a[1]) * k) * D);
        budget = 0; break;
      }
      ctxM.lineTo(b[0] * D, b[1] * D);
      if(bounced) budget -= len;
      if(i < pts.length - 1 && !bounced){ bounced = true; budget = 3; }
    }
    ctxM.stroke();
    ctxM.restore();
  }
  function shotFx(){
    const s = st.shot;
    if(!s) return;
    bubble(ctxM, s.x * D, s.y * D, D, s.c, { glow: !reduced() });
  }
  /* 發射器:底座 + 箭頭 + 目前這顆 + 左下角的「下一顆」(點它 = 交換) */
  function launcher(){
    const x = R.LX * D, y = R.LY * D;
    ctxM.save();
    ctxM.translate(x, y);
    ctxM.rotate(st.aim);
    ctxM.fillStyle = "rgba(255,255,255,.22)";
    ctxM.strokeStyle = "rgba(255,255,255,.55)";
    ctxM.lineWidth = Math.max(1.5, D * 0.06);
    ctxM.beginPath();
    ctxM.moveTo(-D * 0.16, -D * 0.55); ctxM.lineTo(0, -D * 1.1); ctxM.lineTo(D * 0.16, -D * 0.55);
    ctxM.closePath(); ctxM.fill(); ctxM.stroke();
    ctxM.restore();
    ctxM.fillStyle = "rgba(255,255,255,.08)";
    ctxM.beginPath(); ctxM.arc(x, y, D * 0.62, 0, Math.PI * 2); ctxM.fill();
    if(!st.shot && !st.dead) bubble(ctxM, x, y, D, st.cur);
    else if(!st.dead) bubble(ctxM, x, y, D * 0.8, st.cur, { alpha: 0.35 });
    // 下一顆
    const n = nextPos();
    bubble(ctxM, n.x, n.y, D * 0.72, st.next);
    ctxM.save();
    ctxM.font = "800 " + Math.max(9, Math.round(D * 0.3)) + "px Nunito, system-ui, sans-serif";
    ctxM.textAlign = "center"; ctxM.textBaseline = "middle";
    ctxM.fillStyle = inkCol; ctxM.globalAlpha = 0.72;
    ctxM.fillText("⇄ 換", n.x + D * 0.95, n.y);
    ctxM.restore();
  }
  function nextPos(){ return { x: (R.LX - 2.2) * D, y: (R.LY + 0.1) * D }; }
  function words(){
    const W = R.COLS * D;
    for(let i = 0; i < fx.words.length; i++){
      const p = fx.words[i], t = p.t / p.dur;
      if(t >= 1) continue;
      const s = t < 0.18 ? (0.6 + 0.4 * (t / 0.18)) : 1;
      const a = t > 0.70 ? (1 - (t - 0.70) / 0.30) : 1;
      const rise = t > 0.70 ? (t - 0.70) / 0.30 * D * 1.2 : 0;
      ctxM.save();
      ctxM.globalAlpha = a;
      ctxM.translate(W / 2, p.y - rise);
      ctxM.scale(s, s);
      ctxM.textAlign = "center"; ctxM.textBaseline = "middle";
      ctxM.font = "800 " + Math.round(D * p.size) + "px Fredoka, Nunito, system-ui, sans-serif";
      ctxM.lineWidth = Math.max(3, D * 0.18);
      ctxM.strokeStyle = "rgba(0,0,0,.55)";
      ctxM.strokeText(p.txt, 0, 0);
      ctxM.fillStyle = p.c;
      ctxM.fillText(p.txt, 0, 0);
      ctxM.restore();
    }
  }
  function edgeFlash(W, H){
    if(fx.hit <= 0) return;
    ctxM.save();
    ctxM.globalAlpha = Math.min(1, fx.hit);
    ctxM.strokeStyle = "#ff5d6c";
    ctxM.lineWidth = Math.max(2, D * 0.12);
    ctxM.strokeRect(1, 1, W - 2, H - 2);
    ctxM.restore();
  }
  /* 待處理垃圾的警示條(⚠ transform:scaleY,不要改 height —— 每幀重排) */
  function gauge(){
    if(!elGaugeFill || !st) return;
    const n = R.pendCount(st);
    elGaugeFill.style.transform = "scaleY(" + Math.min(1, n / 6).toFixed(3) + ")";
    elGauge.classList.toggle("bub-gauge-hot", n >= 3);
    elGauge.classList.toggle("bub-gauge-on", n > 0);
    if(elGaugeNum) elGaugeNum.textContent = n > 0 ? String(n) : "";
  }

  /* ==========================================================================
     六之二、對手的小盤(單機電腦與連線走同一條路,同方塊對戰)
     ========================================================================== */
  function setFoes(list){
    foes = list || [];
    if(!elFoes) return;
    elFoes.classList.toggle("hidden", !foes.length);
    if(foeEls.length !== foes.length){
      foeDanger = [];
      elFoes.innerHTML = "";
      const spec = document.body.classList.contains("bub-spec");
      foeEls = foes.map(() => {
        const wrap = document.createElement("div");
        wrap.className = "bub-foe";
        if(!spec){ wrap.setAttribute("role", "button"); wrap.setAttribute("tabindex", "0"); }
        else wrap.setAttribute("tabindex", "-1");
        wrap.addEventListener("keydown", e => {
          if(e.key === "Enter" || e.key === " " || e.key === "Spacebar"){ e.preventDefault(); wrap.click(); }
        });
        const cv = document.createElement("canvas");
        cv.className = "bub-foe-cv";
        const nm = document.createElement("div");
        nm.className = "bub-foe-name";
        wrap.appendChild(cv); wrap.appendChild(nm);
        elFoes.appendChild(wrap);
        return { wrap: wrap, cv: cv, ctx: cv.getContext("2d"), name: nm };
      });
      fitBoard();
      return;
    }
    drawFoes();
  }
  /* ⚠ 高度量舞台,不量 .bub-foes 自己(疊在右上角時高度由內容決定 → 量自己 = 震盪) */
  function fitFoes(){
    if(!elFoes || !foeEls.length) return;
    const n = foeEls.length;
    const spec = document.body.classList.contains("bub-spec");
    const box = (elStage || elFoes).getBoundingClientRect();
    const w = spec ? (box.width / n - 18) : (elFoes.getBoundingClientRect().width - 8);
    const availH = Math.max(60, box.height) - (n - 1) * 8;
    const byH = (availH / (spec ? 1 : n) - 16) / R.H;
    const byW = w / R.COLS;
    const fd = Math.max(3, Math.floor(Math.min(byW, byH) * 2) / 2);
    foeEls.forEach(e => sizeCanvas(e.cv, e.ctx, Math.round(fd * R.COLS), Math.round(fd * R.H)));
  }
  function drawFoes(){
    for(let i = 0; i < foeEls.length && i < foes.length; i++){
      const f = foes[i], e = foeEls[i];
      const W = e.cv.width / dpr, H = e.cv.height / dpr;
      if(!W || !H) continue;
      const fd = W / R.COLS;
      e.ctx.clearRect(0, 0, W, H);
      /* 兩種來源:本機電腦直接給 st;連線來的給解碼過的 bd + par */
      const b = f.st ? f.st.board : (f.bd || null);
      const par = f.st ? f.st.par : (f.q | 0);
      const aimA = f.st ? f.st.aim : ((f.a | 0) / 100);
      const cur = f.st ? f.st.cur : (f.c | 0);
      const pend = f.st ? R.pendCount(f.st) : (f.pend || 0);
      const dead = f.st ? f.st.dead : !!f.dead;
      e.ctx.strokeStyle = "rgba(255,93,108,.55)";
      e.ctx.lineWidth = 1;
      const dl = (R.cy(R.DEAD) - 0.5) * fd;
      e.ctx.beginPath(); e.ctx.moveTo(0, dl); e.ctx.lineTo(W, dl); e.ctx.stroke();
      if(b){
        for(let y = 0; y < R.ROWS; y++)
          for(let x = 0; x < R.COLS; x++){
            const v = b[y][x];
            if(!v) continue;
            e.ctx.fillStyle = colOf(v);
            e.ctx.beginPath();
            e.ctx.arc(R.cx(par, x, y) * fd, R.cy(y) * fd, fd * 0.44, 0, Math.PI * 2);
            e.ctx.fill();
          }
      }
      /* 發射器的方向:「他在瞄哪裡」是看對手的樂趣(ai.js 紅線 ③ 慢慢轉的理由) */
      if(!dead){
        const lx = R.LX * fd, ly = R.LY * fd;
        e.ctx.strokeStyle = "rgba(255,255,255,.7)";
        e.ctx.lineWidth = Math.max(1, fd * 0.14);
        e.ctx.beginPath(); e.ctx.moveTo(lx, ly);
        e.ctx.lineTo(lx + Math.sin(aimA) * fd * 1.6, ly - Math.cos(aimA) * fd * 1.6); e.ctx.stroke();
        if(cur){ e.ctx.fillStyle = colOf(cur); e.ctx.beginPath(); e.ctx.arc(lx, ly, fd * 0.44, 0, Math.PI * 2); e.ctx.fill(); }
      }
      if(pend > 0){
        e.ctx.fillStyle = "#ff5d6c";
        const gh = Math.min(H, H * Math.min(1, pend / 6));
        e.ctx.fillRect(0, H - gh, Math.max(2, fd * 0.4), gh);
      }
      if(dead) overlay(e.ctx, W, H, "rgba(0,0,0,.55)", "#fff", "KO", 0.16);
      else if(f.connState === "away") overlay(e.ctx, W, H, "rgba(0,0,0,.60)", "#ffaa00", "中斷", 0.13);
      else if(f.connState === "lag") overlay(e.ctx, W, H, "rgba(0,0,0,.35)", "#ffd166", "延遲", 0.13);
      e.wrap.classList.toggle("bub-foe-target", !!f.target);
      e.wrap.classList.toggle("bub-foe-away", !!f.away);
      e.wrap.classList.toggle("bub-foe-lag", !!f.lag);
      e.wrap.classList.toggle("bub-foe-danger", checkDanger(i, b, f.name, dead));
      let tag = f.ko ? (" ×" + f.ko) : "";
      if(f.connState === "away") tag += " [離線]";
      else if(f.connState === "lag") tag += " [延遲]";
      if(e.name.textContent !== (f.name + tag)) e.name.textContent = f.name + tag;
      const spec = document.body.classList.contains("bub-spec");
      if(spec){
        e.wrap.removeAttribute("role"); e.wrap.setAttribute("tabindex", "-1");
        e.wrap.removeAttribute("aria-pressed"); e.wrap.removeAttribute("aria-label");
      }else{
        if(e.wrap.getAttribute("role") !== "button") e.wrap.setAttribute("role", "button");
        if(e.wrap.getAttribute("tabindex") !== "0") e.wrap.setAttribute("tabindex", "0");
        e.wrap.setAttribute("aria-pressed", f.target ? "true" : "false");
        const label = f.name + (f.target ? ",目前鎖定目標" : ",未鎖定");
        if(e.wrap.getAttribute("aria-label") !== label) e.wrap.setAttribute("aria-label", label);
      }
    }
  }
  function overlay(ctx, W, H, bg, fg, txt, k){
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = fg;
    ctx.font = "800 " + Math.max(10, Math.round(H * k)) + "px Fredoka, Nunito, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(txt, W / 2, H / 2);
  }
  function foeAt(el){
    for(let i = 0; i < foeEls.length; i++) if(foeEls[i].wrap.contains(el)) return i;
    return -1;
  }
  /* 「快爆了」:最低那一列離死亡線只剩 2 列。⚠ 要有遲滯(同方塊對戰 checkDanger) */
  const DANGER_IN = R.DEAD - 2, DANGER_OUT = R.DEAD - 4;
  let foeDanger = [];
  function checkDanger(i, b, name, dead){
    const was = !!foeDanger[i];
    if(!b || dead){ foeDanger[i] = false; return false; }
    const low = R.lowest(b);
    const now = was ? (low >= DANGER_OUT) : (low >= DANGER_IN);
    foeDanger[i] = now;
    if(now && !was && name) cast("⚠️ " + name + " 快爆了!", "warn");
    return now;
  }

  /* ==========================================================================
     六之三、攻擊光束 · 現場播報(照抄方塊對戰)
     ========================================================================== */
  let cvFx = null, ctxF = null;
  function fitFx(){
    if(!cvFx || !elPlay) return;
    const r = elPlay.getBoundingClientRect();
    sizeCanvas(cvFx, ctxF, Math.max(1, r.width), Math.max(1, r.height));
  }
  function beam(fromEl, toEl, col, txt){
    if(!elPlay || reduced()) return;
    const base = elPlay.getBoundingClientRect();
    const pt = el => {
      if(!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
    };
    const a = pt(fromEl), b = pt(toEl);
    if(!a || !b) return;
    fx.beams.push({ a: a, b: b, c: col || "#ff9f43", t: 0, dur: 420, txt: txt || "" });
  }
  function drawBeams(){
    if(!ctxF || !cvFx) return;
    const W = cvFx.width / dpr, H = cvFx.height / dpr;
    ctxF.clearRect(0, 0, W, H);
    for(let i = 0; i < fx.beams.length; i++){
      const m = fx.beams[i], k = m.t / m.dur;
      if(k >= 1) continue;
      const head = ease(Math.min(1, k * 1.6)), tail = ease(Math.max(0, (k - 0.28) * 1.6));
      const hx = m.a.x + (m.b.x - m.a.x) * head, hy = m.a.y + (m.b.y - m.a.y) * head;
      const tx = m.a.x + (m.b.x - m.a.x) * tail, ty = m.a.y + (m.b.y - m.a.y) * tail;
      ctxF.save();
      ctxF.globalAlpha = 1 - k * k;
      ctxF.strokeStyle = m.c; ctxF.shadowColor = m.c; ctxF.shadowBlur = 14;
      ctxF.lineWidth = 5; ctxF.lineCap = "round";
      ctxF.beginPath(); ctxF.moveTo(tx, ty); ctxF.lineTo(hx, hy); ctxF.stroke();
      if(m.txt){
        ctxF.shadowBlur = 0;
        ctxF.font = "800 15px Fredoka, Nunito, sans-serif";
        ctxF.textAlign = "center";
        ctxF.lineWidth = 4; ctxF.strokeStyle = "rgba(0,0,0,.6)";
        ctxF.strokeText(m.txt, hx, hy - 10);
        ctxF.fillStyle = m.c; ctxF.fillText(m.txt, hx, hy - 10);
      }
      ctxF.restore();
    }
  }
  function beamOut(i, n, revenge){
    const e = foeEls[i];
    if(e) beam(cvMain, e.cv, revenge ? "#ff5d6c" : "#ffd93d", (revenge ? "反擊 +" : "+") + n + " 排");
  }
  function beamIn(i, n, who){
    const e = foeEls[i];
    if(e) beam(e.cv, elGauge || cvMain, "#ff5d6c", (who ? who + " " : "") + "+" + n + " 排");
    incoming(n);
  }
  function beamShield(i, who){
    const e = foeEls[i];
    if(e) beam(e.cv, elGauge || cvMain, "#48dbfb", (who ? who + " " : "") + "🛡️ 抵擋");
    word("🛡️ 暖身保護抵擋", "#48dbfb", 0.62);
    T(600, { type: "sine", dur: 0.12, vol: 0.12, slideTo: 850 });
  }
  function beamFoe(i, j, n){
    const a = foeEls[i], b = foeEls[j];
    if(a && b) beam(a.cv, b.cv, "#8b8fa8", "+" + n);
  }
  /* ⚠⚠ 一律 textContent —— 印的是玩家自己取的暱稱 */
  function cast(txt, kind){
    if(!elCast || !txt) return;
    const li = document.createElement("div");
    li.className = "bub-cast-it" + (kind ? " bub-cast-" + kind : "");
    li.textContent = txt;
    elCast.appendChild(li);
    while(elCast.childElementCount > 3) elCast.removeChild(elCast.firstChild);
    setTimeout(() => { if(li.parentNode) li.parentNode.removeChild(li); }, kind === "ko" ? 2400 : 1700);
    if(kind === "ko")          T(320, { type: "square",   dur: 0.15, vol: 0.17, slideTo: 170 });
    else if(kind === "streak") T(520, { type: "triangle", dur: 0.20, vol: 0.18, slideTo: 1060 });
    else                       T(900, { type: "triangle", dur: 0.09, vol: 0.10, slideTo: 1240 });
  }
  function clearCast(){ if(elCast) elCast.innerHTML = ""; }

  /* ==========================================================================
     七、事件 → 特效
     ========================================================================== */
  function word(txt, col, size){
    if(fx.words.length >= 3) fx.words.shift();
    for(let i = 0; i < fx.words.length; i++) fx.words[i].y -= D * 0.8;
    fx.words.push({ txt: txt, c: col, size: size || 0.7, y: R.H * D * 0.42, t: 0, dur: 900 });
  }
  function pop(txt, col, size){ word(txt, col, (size || 0.9) * 0.78); }
  function shake(px){ if(!reduced()) fx.shake = Math.max(fx.shake, px); }
  function onLand(ev, parBefore){
    if(ev.pops.length){
      ev.pops.forEach(p => fx.pops.push({ x: R.cx(parBefore, p[0], p[1]), y: R.cy(p[1]), c: p[2], t: 0 }));
      ev.drops.forEach(p => fx.drops.push({ x: R.cx(parBefore, p[0], p[1]), y: R.cy(p[1]), c: p[2],
                                            vy: -0.002 - Math.random() * 0.004, vx: (Math.random() - 0.5) * 0.004, t: 0 }));
      const n = ev.pops.length + ev.drops.length;
      T(560 + Math.min(8, n) * 70, { type: "triangle", dur: 0.12, vol: 0.18, slideTo: 900 + Math.min(8, n) * 120 });
      if(ev.drops.length >= 4){ shake(5); word("掉了 " + ev.drops.length + " 顆!", "#ffd93d", 0.78); }
      else shake(1.5);
      if(ev.combo >= 3) word("連消 ×" + ev.combo, "#2fd6e4", 0.6);
      if(ev.pc){ word("全清!", "#3ddc7f", 0.9); shake(7); }
    }else{
      T(300, { type: "sine", dur: 0.05, vol: 0.10, slideTo: 210 });
    }
    if(ev.cancelled > 0) word("抵銷 " + ev.cancelled + " 排", "#1dd1a1", 0.62);
    const pushed = (ev.press || 0) + (ev.garb || 0);
    if(pushed){
      fx.push = { n: pushed, t: 0, dur: 260 };
      if(ev.garb){
        shake(Math.min(7, 2 + ev.garb * 1.5));
        fx.hit = 1;
        word("+" + ev.garb + " 排", "#ff5d6c", 0.66);
        T(180, { type: "sawtooth", dur: 0.16, vol: 0.14, slideTo: 110 });
      }else{
        T(220, { type: "sine", dur: 0.10, vol: 0.10, slideTo: 150 });
      }
    }
  }
  function incoming(n){
    fx.hit = Math.max(fx.hit, 0.8);
    T(740, { type: "square", dur: 0.07, vol: 0.10, slideTo: 420 });
    if(n >= 3) shake(3);
  }

  /* ==========================================================================
     八、輸入 —— 一個收斂點:act(name)
     ========================================================================== */
  function live(){ return !!(st && running && !st.dead && cfg.canPlay()); }
  function act(name){
    if(!live()) return;
    if(name === "fire"){
      const ev = R.fire(st);
      if(!ev) return;
      T(420, { type: "square", dur: 0.05, vol: 0.12, slideTo: 760 });
      cfg.onEvents([ev], st);
    }else if(name === "swap"){
      if(R.swap(st)) T(660, { type: "sine", dur: 0.05, vol: 0.10, slideTo: 880 });
    }
  }
  function setAim(a){ if(st && live()) R.aim(st, a); }

  /* 指標 → 瞄準角。回傳 { a, cancel }:cancel = 手指在發射器下方(紅線 ⑤) */
  function aimFromPoint(cx, cy){
    const r = cvMain.getBoundingClientRect();
    const k = r.width / (R.COLS * D) || 1;           // CSS 縮放(大 / 小切換的瞬間)
    const lx = r.left + R.LX * D * k, ly = r.top + R.LY * D * k;
    const dx = cx - lx, dy = ly - cy;
    return { a: Math.atan2(dx, Math.max(0.001, dy)), cancel: dy < D * 0.35 * k };
  }
  function onNext(cx, cy){
    const r = cvMain.getBoundingClientRect();
    const k = r.width / (R.COLS * D) || 1;
    const n = nextPos();
    const dx = cx - (r.left + n.x * k), dy = cy - (r.top + n.y * k);
    return Math.hypot(dx, dy) <= D * 0.95 * k;
  }
  function onDown(e){
    if(e.target && e.target.closest && (e.target.closest(".bub-foe") || e.target.closest("button"))) return;   // ⚠ 紅線 ④
    if(!live()) return;
    e.preventDefault();
    if(onNext(e.clientX, e.clientY)){ act("swap"); return; }
    inp.aiming = true; inp.id = e.pointerId;
    try{ elPlay.setPointerCapture && elPlay.setPointerCapture(e.pointerId); }catch(_){}
    const p = aimFromPoint(e.clientX, e.clientY);
    inp.cancel = p.cancel;
    if(!p.cancel) setAim(p.a);
  }
  function onMove(e){
    if(!inp.aiming || e.pointerId !== inp.id) return;
    const p = aimFromPoint(e.clientX, e.clientY);
    inp.cancel = p.cancel;
    if(!p.cancel) setAim(p.a);
  }
  function onUp(e){
    if(!inp.aiming || (e && e.pointerId !== inp.id)) return;
    inp.aiming = false; inp.id = null;
    if(e && e.type === "pointerup" && !inp.cancel) act("fire");
    inp.cancel = false;
  }
  /* 鍵盤。⚠ 正在打字就一個鍵都不要碰(方塊對戰實測過:注音用空白鍵選字) */
  const KEYMAP = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "fire", " ": "fire", Spacebar: "fire",
                   ArrowDown: "swap", x: "swap", X: "swap", c: "swap", C: "swap", Shift: "swap" };
  function typing(e){
    const t = e.target;
    return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.isContentEditable);
  }
  function onKeyDown(e){
    if(typing(e) || (e.target && e.target.closest && e.target.closest(".bub-foe"))) return;
    const a = KEYMAP[e.key];
    if(!a) return;
    e.preventDefault();
    if(inp.keys[e.key]) return;         // 不吃作業系統的自動重複
    inp.keys[e.key] = 1;
    if(a === "left") inp.turn = -1;
    else if(a === "right") inp.turn = 1;
    else act(a);
  }
  function onKeyUp(e){
    if(typing(e)) return;
    const a = KEYMAP[e.key];
    if(!a) return;
    delete inp.keys[e.key];
    if((a === "left" && inp.turn < 0) || (a === "right" && inp.turn > 0)) inp.turn = 0;
  }
  function bindInput(){
    const host = elPlay || cvMain;
    if(!host) return;
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", e => { inp.cancel = true; onUp(e); });
    host.addEventListener("lostpointercapture", e => { if(inp.aiming){ inp.cancel = true; onUp(e); } });
    host.addEventListener("contextmenu", e => e.preventDefault());
  }

  /* ==========================================================================
     九、game loop(frame 抽成獨立函式是為了測得到:headless 下 rAF 推不動時間)
     ========================================================================== */
  let frameN = 0;
  function frame(dt){
    frameN++;
    dt = Math.min(100, Math.max(0, dt || 0));
    stepFx(dt);
    if(running && cfg.onFrame) cfg.onFrame(dt);
    if(running && st && !st.dead && cfg.canPlay()){
      if(inp.turn) R.aim(st, st.aim + inp.turn * TURN * dt);
      const par = st.par;
      const evs = R.tick(st, dt);
      if(evs.length){
        evs.forEach(ev => {
          if(ev.t === "land") onLand(ev, par);
          else if(ev.t === "fire" && ev.auto){ word("自動發射", "#ff9f43", 0.55); T(420, { type: "square", dur: 0.05, vol: 0.12, slideTo: 760 }); }
          else if(ev.t === "bounce") T(880, { type: "sine", dur: 0.03, vol: 0.05 });
        });
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
  function stepFx(dt){
    if(fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt * 0.045);
    if(fx.hit > 0) fx.hit = Math.max(0, fx.hit - dt * 0.004);
    if(fx.push){ fx.push.t += dt; if(fx.push.t >= fx.push.dur) fx.push = null; }
    for(let i = fx.pops.length - 1; i >= 0; i--){ fx.pops[i].t += dt; if(fx.pops[i].t >= 220) fx.pops.splice(i, 1); }
    for(let i = fx.drops.length - 1; i >= 0; i--){
      const p = fx.drops[i];
      p.t += dt;
      if(p.t >= 700){ fx.drops.splice(i, 1); continue; }
      p.vy += 0.00004 * dt; p.y += p.vy * dt; p.x += p.vx * dt;
    }
    for(let i = fx.beams.length - 1; i >= 0; i--){ fx.beams[i].t += dt; if(fx.beams[i].t >= fx.beams[i].dur) fx.beams.splice(i, 1); }
    for(let i = fx.words.length - 1; i >= 0; i--){ fx.words[i].t += dt; if(fx.words[i].t >= fx.words[i].dur) fx.words.splice(i, 1); }
  }

  /* ==========================================================================
     十、對外
     ========================================================================== */
  function mount(c){
    if(c) cfg = Object.assign(cfg, c);
    elStage = document.getElementById("bubStage");
    elWrap  = document.getElementById("bubWrap");
    elGauge = document.getElementById("bubGauge");
    elGaugeFill = document.getElementById("bubGaugeFill");
    elGaugeNum  = document.getElementById("bubGaugeNum");
    elHud   = document.querySelector(".bub-hud");
    elFoes  = document.getElementById("bubFoes");
    elCast  = document.getElementById("bubCast");
    elPlay  = document.getElementById("bubPlay");
    cvFx    = document.getElementById("bubFx");
    if(cvFx) ctxF = cvFx.getContext("2d");
    cvMain  = document.getElementById("bubMain");
    if(!cvMain) return;
    ctxM = cvMain.getContext("2d");
    mounted = true;
    bindInput();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", () => fitBoard());
    /* ⚠ 一定要有 ResizeObserver(切 body class 不會發 resize)—— 觀察舞台,不觀察 canvas */
    if(window.ResizeObserver && elStage){
      try{ new ResizeObserver(() => fitBoard()).observe(elStage); }catch(e){}
    }
    window.addEventListener("orientationchange", () => setTimeout(fitBoard, 120));
    document.addEventListener("visibilitychange", () => { if(document.hidden) allUp(); });
    window.addEventListener("blur", allUp);
    wake();
  }
  /* rAF 只在對局畫面開著的時候跑(同方塊對戰:判斷用畫面,不用 running —— 觀戰者永遠不 play) */
  function wake(){
    if(!mounted || raf) return;
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function sleep(){
    if(!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }
  function allUp(){ inp.aiming = false; inp.id = null; inp.cancel = false; inp.keys = {}; inp.turn = 0; }
  function setState(s){
    st = s;
    fx.pops.length = 0; fx.drops.length = 0; fx.words.length = 0; fx.beams.length = 0;
    fx.push = null; fx.shake = 0; fx.hit = 0;
    allUp();
    fitBoard();
  }
  function play(){ running = true; lastT = performance.now(); allUp(); }
  function pause(){ running = false; allUp(); }
  function stop(){ running = false; allUp(); }

  return {
    mount, setState, play, pause, stop, wake, sleep, fitBoard, draw,
    act, setAim, incoming, pop, shake,
    setFoes, foeAt, beamOut, beamIn, beamShield, beamFoe, foes: () => foes,
    cast, clearCast,
    /* ★ 測試用的出口(產品程式不會呼叫):step(dt) 手動推一幀、frames()、awake()、
       aimPoint(x,y) = 螢幕座標換算成瞄準角(e2e 驗「瞄準 + 發射」那一整條路用) */
    step: frame,
    frames: () => frameN,
    awake: () => !!raf,
    state: () => st,
    cell: () => D,
    aimPoint: (cx, cy) => aimFromPoint(cx, cy),
    COL
  };
})();

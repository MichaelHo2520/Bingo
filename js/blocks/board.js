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
  /* ⚠ MINC 要夠小,不然**橫置手機放不下** —— 20 列 × 12px = 240px,而橫置時舞台
     只剩兩百出頭 → 盤面比舞台高,而舞台是 overflow:hidden,底部直接被切掉
     (而且是「看起來像盤面沒有底」的那種壞法)。橫置本來就不適合玩方塊,
     這裡只保證「不會破」,想玩得舒服請直立或按「大」。 */
  const MINC = 9, MAXC = 38;            // 一格的 px 上下限
  const GAUGE_W = 10;                   // 左緣警示條的寬(與 CSS 的 .blk-gauge 同步)
  /* 對手小盤那一條(v2.14.0)。★ 它只吃**盤面用不到的空間**,絕不回頭縮小盤面 ——
     理由見 fitBoard() 裡那一大段。 */
  const FOE_MIN = 52;                   // 右側要有這麼寬才放得下一條(不然改用疊的)
  const FOE_MAX = 104;                  // 再寬就只是在搶注意力
  const FOE_OVER = 62;                  // 疊在盤面右上角時的寬

  /* 手感參數。★ 這三個就是「好不好玩」的旋鈕,改之前先想清楚要調誰的體感 */
  const DAS_MS = [180, 133, 95];        // 慢 / 標準 / 快
  const ARR_MS = [55, 33, 18];
  let feel = 1;                         // 0..2,對應上面兩張表

  /* 手勢參數(v2.14.0 起這是**預設**的操作方式,不再是選配)。
     ⚠ 橫拖的步距**一定要跟著格子走**,不可以寫死 px —— 寫死的話「拖一公分走幾格」
       會隨盤面大小飄:按「大」之後格子變大、方塊卻跑得比手指快(實測差一倍)。 */
  const G_SOFT = 30;                    // 下拖幾 px 開始軟降
  const G_TAP = 12;                     // 位移小於這個才算點擊(旋轉)
  /* ⚠⚠ 往上滑 = **直接落地**(v2.14.0;在那之前上滑是換牌、而落地是「往下快甩」)。
     換過來的理由:落地是**不可逆**的,而「往下拖」與「往下快甩」同在一個方向、
     只差在速度 —— 拖到底抬手時速度一大就變成落地,那是整套手勢最容易誤觸的一處。
     一個方向一件事之後就沒有這個歧義了,而「不可逆的動作放在不可能誤觸的方向」
     這筆交換很划算。⚠ 門檻比原本的換牌高一點(48 > 40),同樣是因為它不可逆。 */
  const G_UP = 48;                      // 上滑幾 px 算直接落地
  const G_AXIS = 12;                    // 超過這個位移才決定主軸(見下面的軸鎖)
  const G_BREAK = 3;                    // 橫軸鎖定後,下拖要超過 G_SOFT 的幾倍才准轉去軟降
  const G_TWO = 420;                    // 第二根手指在這段時間內落下才算「兩指點」(逆轉)
  function gStep(){ return Math.max(16, cell); }

  /* ==========================================================================
     二、狀態
     ========================================================================== */
  let cfg = { onEvents: function(){}, canPlay: function(){ return true; }, onFrame: null };
  let st = null;                        // 目前在畫的規則狀態
  let mounted = false, running = false, raf = 0, lastT = 0;
  let cell = 24, prev = 15, dpr = 1;

  let elStage, elWrap, elGauge, elGaugeFill, elPad, elHud;
  let cvMain, ctxM, cvNext, ctxN;
  let nextN = 3;                        // Next 顯示幾顆(寬螢幕 5、手機 3)
  /* 網格線的顏色跟著主題走(定義在 styles.src.css 的 --blk-grid)。
     ⚠ 每幀都去 getComputedStyle 是白工,所以在 fitBoard() 讀一次存著。
     ⚠ 換主題不會自動觸發 fitBoard() → setTheme 之後要再叫一次(main.js 的 showScreen 會)。 */
  let gridCol = "rgba(255,255,255,.055)";
  /* HUD 的 NEXT 標籤色。⚠ 寫死白色的話淺色主題上直接看不見(同 gridCol 的理由) */
  let inkCol = "rgba(255,255,255,.9)";

  /* 特效(全部畫在 canvas 裡,見紅線 ②) */
  const fx = {
    shake: 0,                           // 剩餘震動強度(px)
    clear: null,                        // { rows, pre, t, dur, n }
    parts: [],                          // 粒子
    trail: null,                        // { k, r, x, y0, y1, t }
    pops: [],                           // 浮字
    hit: 0,                             // 收到攻擊的邊框閃光
    beams: []                           // 攻擊光束(跨畫布,畫在 .blk-fx 上)
  };

  /* 輸入 */
  const inp = { dir: 0, dasT: 0, arrT: 0, soft: false, keys: {} };
  let gest = null;                      // 手勢中的指標
  /* ⚠ 預設是**手勢**(v2.14.0)。在那之前是 "btn",而六顆浮動鈕正好蓋住盤面下緣 ——
     那裡是堆得最高、最需要看清楚的一塊(使用者實機回報)。
     ★ 想切回按鈕的人走設定裡的「操作方式」,solo.js 會把它存起來。 */
  let ctrlMode = "swipe";               // "btn" | "swipe" | "both"
  let padPos = "float";                 // "float"(浮在盤面上)| "dock"(固定在盤面下方)

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
  /* 寬螢幕 / 橫置:控制簇搬到盤面左右兩側(不再蓋住盤面)。
     ⚠ 這個條件**必須與 styles.src.css 的 @media 逐字相同** —— 對不起來的症狀是
       「鈕在旁邊、但盤面還是照蓋住的算法留了空位」(或反過來,盤面被鈕蓋掉一角)。 */
  const MQ_WIDE = "(min-width:700px),(orientation:landscape)";
  function isWide(){
    try{ return window.matchMedia(MQ_WIDE).matches; }catch(e){ return false; }
  }

  function fitBoard(){
    if(!mounted || !elStage) return;
    const rect = elStage.getBoundingClientRect();
    /* ⚠ 舞台裡只有盤面 —— HUD 是它的兄弟,控制鈕是**絕對定位**的浮層。
       兩者都不會改變這裡量到的尺寸(那正是紅線 ① 要的)。 */
    let reserve = 0;
    if(isWide() && elPad && !elPad.classList.contains("hidden")){
      /* 兩簇在左右兩側時要把寬度讓出來。量絕對定位的元素是安全的:
         它不參與版面,所以量它不會回頭改變舞台的尺寸。 */
      const l = elPad.querySelector(".blk-pad-l"), r = elPad.querySelector(".blk-pad-r");
      reserve = (l ? l.getBoundingClientRect().width : 0) +
                (r ? r.getBoundingClientRect().width : 0) + 20;
    }
    const availW = Math.max(120, rect.width - 4 - reserve);
    const availH = Math.max(120, rect.height - 6);

    const byW = (availW - GAUGE_W - 8) / R.COLS;       // 盤面吃滿寬度,只讓開警示條
    const byH = availH / R.VIS;
    cell = Math.round(clamp(Math.min(byW, byH), MINC, MAXC));
    dpr = Math.min(3, window.devicePixelRatio || 1);

    /* ★★★ 對手的小盤:**只吃盤面用不到的空間**(v2.14.0)。
       在那之前它是盤面上方一整條固定 88px 的橫列 —— 而 1 對 1 時那一條裡只有一塊
       36×60 的小盤,兩側全是空白(使用者:「那裡浪費太多空間了」)。
       ⚠⚠ 第一版改成「右側固定讓出 78px」是**錯的**,而且只有看圖才看得出來:
         這一頁的瓶頸會換邊 —— 周邊 UI 都在時是**高度**卡住(左右各空兩成多),
         收掉周邊(大畫面)之後換成**寬度**卡住(盤面吃滿寬、上下反而空一大片)。
         固定讓出寬度的話,後者會把一格從 33px 縮到 25px,整個「大畫面」白按了。
       ★ 正解是先照「沒有小盤」算出一格多大,再看**剩下多少寬**:
         · 剩得下(≥ FOE_MIN)→ 貼右側那一條(盤面往左推同樣的距離,不縮小);
         · 剩不下 → 疊在盤面**右上角**(那裡幾乎永遠是空的;堆到那個高度時這一局
           也快結束了)。兩條路盤面都維持最大,小盤一律只用免費的空間。
       ⚠ 沒有回饋迴圈:cell 在這一行之前就算完了,小盤的尺寸不參與(紅線 ①)。 */
    let foeW = 0, foeOver = false;
    if(elFoes && !elFoes.classList.contains("hidden") &&
       !document.body.classList.contains("blk-spec")){
      const restW = availW - (R.COLS * cell + GAUGE_W + 8);
      foeOver = (restW < FOE_MIN);
      foeW = foeOver ? FOE_OVER : Math.min(FOE_MAX, Math.floor(restW));
    }
    if(elFoes){
      elFoes.classList.toggle("blk-foes-over", foeOver);
      elFoes.style.width = foeW ? (foeW + "px") : "";
    }

    const g = getComputedStyle(cvMain).getPropertyValue("--blk-grid").trim();
    if(g) gridCol = g;

    sizeCanvas(cvMain, ctxM, R.COLS * cell, R.VIS * cell);
    if(elGauge) elGauge.style.height = (R.VIS * cell) + "px";
    /* 貼右側那一條時盤面要**自己往左讓開**(舞台是置中的)——
       疊在右上角那一條路刻意不推:那時候本來就沒有多的寬可以讓。 */
    if(elWrap) elWrap.style.marginRight = (foeW && !foeOver) ? (foeW + "px") : "";

    /* HUD 的兩塊小畫布。
       ⚠⚠ prev **不可以由 cell 推算** —— HUD 的高度會跟著變,而 HUD 的高度又決定
         舞台剩多少高度、舞台的高度又決定 cell…**那就是一個循環**(而且會震盪)。
         所以 prev 一律由 HUD 自己那條 CSS 固定高度推出來。 */
    if(elHud) inkCol = getComputedStyle(elHud).color || inkCol;
    const hudH = elHud ? elHud.getBoundingClientRect().height : 54;
    /* ⚠ 係數在 v2.14.0 跟著 HUD 高度(54 → 46)一起調 —— 照舊的算式 NEXT 會跟著縮水,
       而那一格是**唯一**還看得到未來的地方(Hold 拿掉之後)。46px 下要算得出 13。 */
    prev = Math.round(clamp((hudH - 14) / 2.5, 7, 15));
    const box = Math.round(prev * 2.6);
    nextN = isWide() ? 5 : 3;
    sizeCanvas(cvNext, ctxN, box * nextN, hudH - 8);
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
    hud();
    gauge();
    drawFoes();
    drawBeams();
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

  /* ---------- HUD 的小畫布:Next(右),橫排 ----------
     ⚠ v2.14.0 之前左邊還有一塊 HOLD —— 整個功能拿掉了(見 rules.js 的紅線 ③)。
     ⚠ 這裡畫的是**在 HUD 那一列裡**,不是盤面旁邊 —— 盤面的寬度要留給盤面。 */
  function mini(ctx, cv, label, kinds, dim){
    if(!ctx || !cv) return;
    const W = cv.width / dpr, H = cv.height / dpr;
    ctx.clearRect(0, 0, W, H);
    const lh = Math.max(9, Math.round(H * 0.26));
    ctx.font = "800 " + lh + "px Nunito, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = inkCol;
    ctx.fillText(label, 1, 0);
    ctx.globalAlpha = 1;
    const top = lh + 2, bh = H - top;
    if(!kinds.length) return;
    const bw = W / kinds.length;
    for(let i = 0; i < kinds.length; i++)
      piecePreview(ctx, kinds[i], i * bw, top, bw, bh, (dim && i === 0) ? 0.34 : (i === 0 ? 1 : 0.72));
  }
  function hud(){
    if(!st) return;
    mini(ctxN, cvNext, "NEXT", R.peek(st.seed, st.idx, nextN), false);
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
     六之二、對手的小盤
     ──────────────────────────────────────────────────────────────────────────
       ★ 單機對電腦與連線對戰**走同一條路** —— 呼叫端只要把 [{id,name,snap,…}]
         交給 setFoes(),這裡不在乎那份快照是本機算的還是從 Firebase 收來的。
       ⚠ 小盤的 DOM 由這裡自己建(數量會變:1 對 1 / 4 人 / 觀戰)。
       ⚠ setFoes() 會改變 .blk-foes 的高度 → **一定要跟著 fitBoard()**
         (它不是每幀呼叫的,所以不會變成震盪)。
     ========================================================================== */
  let foes = [];                        // [{ id, name, b, c, ko, dead, pend, away }]
  let foeEls = [];                      // [{ wrap, cv, ctx, name }]
  let elFoes = null;

  function setFoes(list){
    foes = list || [];
    if(!elFoes) return;
    elFoes.classList.toggle("hidden", !foes.length);
    if(foeEls.length !== foes.length){
      elFoes.innerHTML = "";
      foeEls = foes.map(() => {
        const wrap = document.createElement("div");
        wrap.className = "blk-foe";
        const cv = document.createElement("canvas");
        cv.className = "blk-foe-cv";
        const nm = document.createElement("div");
        nm.className = "blk-foe-name";
        wrap.appendChild(cv); wrap.appendChild(nm);
        elFoes.appendChild(wrap);
        return { wrap: wrap, cv: cv, ctx: cv.getContext("2d"), name: nm };
      });
      fitBoard();                       // 高度變了 → 盤面要重算
      return;
    }
    drawFoes();
  }
  /* 小盤的一格由「那一條有多寬」與「要塞幾個人」一起決定。
     ⚠ 兩邊都要看:只看寬 → 四個人時縱向排不下(被 overflow 切掉最後一個);
       只看高 → 一個對手時會長得比那一條還寬,直接壓到盤面上。
     ⚠⚠ **高度一律量舞台,不可以量 .blk-foes 自己** —— 疊在右上角那一條路是
       `bottom:auto`(高度由內容決定)→ 量它就是「量自己畫出來的結果」= 震盪。
       寬度量它是安全的:那是 fitBoard() 算完寫進 inline style 的確定值。
     ★ 觀戰是另一套版面(整個畫面讓給小盤,橫向排)→ 那時寬度改由舞台均分。 */
  function fitFoes(){
    if(!elFoes || !foeEls.length) return;
    const n = foeEls.length;
    const spec = document.body.classList.contains("blk-spec");
    const box = (elStage || elFoes).getBoundingClientRect();
    const w = spec ? (box.width / n - 18) : (elFoes.getBoundingClientRect().width - 8);
    const availH = Math.max(60, box.height) - (n - 1) * 8;
    const byH = Math.floor((availH / (spec ? 1 : n) - 16) / R.VIS);
    const byW = Math.floor(w / R.COLS);
    const fc = Math.max(2, Math.min(byW, byH));
    foeEls.forEach(e => sizeCanvas(e.cv, e.ctx, fc * R.COLS, fc * R.VIS));
  }
  function drawFoes(){
    for(let i = 0; i < foeEls.length && i < foes.length; i++){
      const f = foes[i], e = foeEls[i];
      const W = e.cv.width / dpr, H = e.cv.height / dpr;
      if(!W || !H) continue;
      const fc = W / R.COLS;
      e.ctx.clearRect(0, 0, W, H);
      /* 兩種來源:本機的電腦對手直接給 st(不必每幀編碼 220 個字元);
         連線來的給解碼過的 bd(收到快照時解一次就好)。 */
      const b = f.st ? f.st.board : (f.bd || null);
      const cur = f.st ? f.st.cur
                       : (f.c && f.c.length === 4 ? { k: f.c[0], r: f.c[1], x: f.c[2], y: f.c[3] } : null);
      const pend = f.st ? R.pendCount(f.st) : (f.pend || 0);
      const dead = f.st ? f.st.dead : !!f.dead;
      if(b){
        for(let y = R.TOP; y < R.ROWS; y++)
          for(let x = 0; x < R.COLS; x++){
            const v = b[y][x];
            if(!v) continue;
            e.ctx.fillStyle = colOf(v);
            e.ctx.fillRect(x * fc + 0.5, (y - R.TOP) * fc + 0.5, fc - 1, fc - 1);
          }
      }
      /* 落下中的那一顆:對手盤上這一塊是「他在想什麼」的唯一線索,不要省 */
      if(cur){
        e.ctx.fillStyle = COL[cur.k] || "#fff";
        R.cellsOf(cur.k, cur.r, cur.x, cur.y).forEach(p => {
          if(p[1] >= R.TOP) e.ctx.fillRect(p[0] * fc + 0.5, (p[1] - R.TOP) * fc + 0.5, fc - 1, fc - 1);
        });
      }
      // 待處理垃圾:左緣一條紅
      if(pend > 0){
        e.ctx.fillStyle = "#ff5d6c";
        const gh = Math.min(H, H * Math.min(1, pend / 10));
        e.ctx.fillRect(0, H - gh, Math.max(2, fc * 0.45), gh);
      }
      if(dead){
        e.ctx.fillStyle = "rgba(0,0,0,.55)";
        e.ctx.fillRect(0, 0, W, H);
        e.ctx.fillStyle = "#fff";
        e.ctx.font = "800 " + Math.round(H * 0.16) + "px Fredoka, Nunito, sans-serif";
        e.ctx.textAlign = "center"; e.ctx.textBaseline = "middle";
        e.ctx.fillText("KO", W / 2, H / 2);
      }
      e.wrap.classList.toggle("blk-foe-target", !!f.target);
      e.wrap.classList.toggle("blk-foe-away", !!f.away);
      const tag = (f.ko ? (" ×" + f.ko) : "");
      if(e.name.textContent !== (f.name + tag)) e.name.textContent = f.name + tag;
    }
  }
  /* 哪一個小盤被點到(目標鎖定用)。回傳 index 或 -1 */
  function foeAt(el){
    for(let i = 0; i < foeEls.length; i++) if(foeEls[i].wrap.contains(el)) return i;
    return -1;
  }

  /* ==========================================================================
     六之三、攻擊光束
     ──────────────────────────────────────────────────────────────────────────
       ★ 這是整個設計的靈魂:「垃圾行從誰那裡飛過來」如果只用一個數字表示,
         這個遊戲在聚會裡就少了一半的情緒。
       ⚠ 畫在一塊**蓋住整個對局區**的獨立 canvas 上(pointer-events:none)——
         光束要跨越「我的盤面」與「對手小盤」兩個不同的畫布,只能在上層畫。
     ========================================================================== */
  let cvFx = null, ctxF = null, elPlay = null;
  function fitFx(){
    if(!cvFx || !elPlay) return;
    const r = elPlay.getBoundingClientRect();
    sizeCanvas(cvFx, ctxF, Math.max(1, r.width), Math.max(1, r.height));
  }
  /* 兩個元素之間放一道光束。from / to 是 DOM 元素(或 {x,y} 的相對座標) */
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
      const m = fx.beams[i];
      const k = m.t / m.dur;
      if(k >= 1) continue;
      const head = ease(Math.min(1, k * 1.6));
      const tail = ease(Math.max(0, (k - 0.28) * 1.6));
      const hx = m.a.x + (m.b.x - m.a.x) * head, hy = m.a.y + (m.b.y - m.a.y) * head;
      const tx = m.a.x + (m.b.x - m.a.x) * tail, ty = m.a.y + (m.b.y - m.a.y) * tail;
      ctxF.save();
      ctxF.globalAlpha = 1 - k * k;
      ctxF.strokeStyle = m.c;
      ctxF.shadowColor = m.c;
      ctxF.shadowBlur = 14;
      ctxF.lineWidth = 5;
      ctxF.lineCap = "round";
      ctxF.beginPath();
      ctxF.moveTo(tx, ty);
      ctxF.lineTo(hx, hy);
      ctxF.stroke();
      if(m.txt){
        ctxF.shadowBlur = 0;
        ctxF.font = "800 15px Fredoka, Nunito, sans-serif";
        ctxF.textAlign = "center";
        ctxF.lineWidth = 4;
        ctxF.strokeStyle = "rgba(0,0,0,.6)";
        ctxF.strokeText(m.txt, hx, hy - 10);
        ctxF.fillStyle = m.c;
        ctxF.fillText(m.txt, hx, hy - 10);
      }
      ctxF.restore();
    }
  }
  /* 對外:我打了第 i 個對手 / 第 i 個對手打了我 */
  function beamOut(i, n){
    const e = foeEls[i];
    if(e) beam(cvMain, e.cv, "#ffd93d", "+" + n);
  }
  function beamIn(i, n){
    const e = foeEls[i];
    if(e) beam(e.cv, elGauge || cvMain, "#ff5d6c", "+" + n);
    incoming(n);
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
  /* ⚠ 沒有 Hold(v2.14.0 拿掉了整個功能)→ `C` 與 `Shift` 不再是遊戲鍵。
     ⚠ 這也是**唯一**還會吃到打字用鍵的地方變少的一次,但 typing() 那道守衛照樣不能省。 */
  const KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right", ArrowDown: "soft", ArrowUp: "cw",
    " ": "hard", Spacebar: "hard", x: "cw", X: "cw", z: "ccw", Z: "ccw"
  };
  /* ⚠⚠ **正在打字就一個鍵都不要碰。**
     這一頁是十五頁裡**唯一**在 window 上掛 keydown 的(其他頁要嘛綁在特定元素上、
     要嘛只認 Enter),而 KEYMAP 吃掉的正好是 `x z c` / 空白鍵 / 方向鍵 / Shift ——
     少了這一道,暱稱打「Max Zoe cat」會變成「Maoeat」、問題回報打
     「box crash zoom exit」會變成「borashoomeit」(兩個都是實測)。
     ⚠⚠⚠ 最要命的是空白鍵:**注音是用空白鍵選字的** → 這一頁的中文輸入整個是壞的。
       而受害名單裡就有**問題回報框本身** —— 玩家想告訴你哪裡怪,打出來的字是殘缺的,
       所以這個坑沒有任何人會來提醒你。
     ★ 做法照 js/chengyu/main.js(那一頁也有全域 keydown,它一直是對的)。 */
  function typing(e){
    const t = e.target;
    if(!t) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.isContentEditable;
  }
  function onKeyDown(e){
    if(typing(e)) return;               // ⚠ 一定要在 preventDefault **之前**
    const a = KEYMAP[e.key];
    if(!a) return;
    e.preventDefault();
    if(inp.keys[e.key]) return;         // ⚠ 紅線 ④:不吃作業系統的自動重複
    inp.keys[e.key] = 1;
    press(a);
  }
  function onKeyUp(e){
    if(typing(e)) return;
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
      act(a);                           // 旋轉 / 硬降一律不連發(紅線 ⑤)
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

  /* ---------- 手勢(v2.14.0 起是**預設**的操作方式)----------
     五個動作每一個都要有自己的一條路,而且**一個方向只做一件事**。

       左右拖 → 一格一格移動      往下拖 → 軟降(放開就停)
       往上滑 → 直接落地          點一下 → 順時針轉
       兩指點一下 → 逆時針轉

     ⚠⚠ 三件不知道就會做錯的事:
     ① **感應區是整個對局區,不是盤面那塊 canvas。** fitBoard() 是被**高度**卡住的
        → 盤面只用掉螢幕寬的一半,左右各留兩成多。手勢綁在 canvas 上的話手指非得
        壓在盤面上不可,等於自己擋住自己要看的東西(而那正是浮動鈕被換掉的原因)。
        → 綁在 #blkPlay 上,對手小盤 / 按鈕那幾塊**先讓開**(它們自己有事要做)。
     ② **一定要有軸鎖。** 沒有的話橫拖時手指難免往下偏 30px → 方塊自己掉下去,
        而使用者只會覺得「這遊戲很滑、很難控」。鎖定之後仍留一條退路(G_BREAK 倍)
        給「先橫移、再軟降」那個連續動作。
     ③ **不要再用「速度」去分辨兩個同方向的手勢。** v2.14.0 之前往下拖是軟降、
        往下快甩是硬降 —— 而使用者拖到底抬手時速度往往就超過門檻,等於隨機落地。
        現在落地改走「往上滑」,下方向專心做軟降,速度那一整套判定跟著刪掉了。 */
  /* 這幾塊自己有事要做:小盤是「鎖定攻擊目標」、按鈕是按鈕模式的本體。
     ⚠ HUD 列進來是為了「拖過 HUD」不會被當成新的一筆手勢。 */
  const G_SKIP = ".blk-foe,.blk-key,.blk-hud";
  function bindGesture(){
    const host = elPlay || cvMain;
    if(!host) return;
    host.addEventListener("pointerdown", e => {
      if(ctrlMode === "btn") return;
      if(e.target && e.target.closest && e.target.closest(G_SKIP)) return;
      const now = performance.now();
      /* 第二根手指 = 逆時針轉。
         ⚠ 只在「第一根還沒真的拖起來」時才算,不然橫移到一半換手扶手機就會莫名轉一下。 */
      if(gest && !gest.done){
        if(gest.moved < 24 && (now - gest.t0) < G_TWO){
          act("ccw");
          gest.done = true;                       // 這一輪不再判點擊 / 硬降
          if(gest.soft){ gest.soft = false; inp.soft = false; if(st) st.soft = false; }
        }
        return;
      }
      /* ⚠ setPointerCapture 會丟例外(合成事件沒有真的 pointerId)——
         而未捕捉的錯誤會被 feedback.js 的環形緩衝當成一筆 JS 錯誤記下來。 */
      try{ host.setPointerCapture && host.setPointerCapture(e.pointerId); }catch(_){}
      gest = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
               t0: now, moved: 0, axis: "", soft: false, done: false };
    });
    host.addEventListener("pointermove", e => {
      if(!gest || gest.done || e.pointerId !== gest.id) return;
      gest.moved += Math.abs(e.clientX - gest.x) + Math.abs(e.clientY - gest.y);
      /* 軸鎖(紅線 ②) */
      const adx = Math.abs(e.clientX - gest.x0), ady = Math.abs(e.clientY - gest.y0);
      if(!gest.axis && Math.max(adx, ady) >= G_AXIS) gest.axis = (adx > ady) ? "x" : "y";
      /* 左右:一格一格走,步距跟著格子(不可以寫死 px) */
      const step = gStep();
      while(gest.axis !== "y" && Math.abs(e.clientX - gest.x) >= step){
        const d = (e.clientX > gest.x) ? 1 : -1;
        act(d > 0 ? "right" : "left");
        gest.x += d * step;
      }
      gest.y = e.clientY;
      /* 往上滑 = 直接落地。⚠ 做完這一輪就結束(不然抬手還會補一個點擊 = 多轉一下)。
         ⚠ 軟降中不接受:那表示手指是先往下再往回拉,不是「往上滑」。 */
      if(gest.axis === "y" && !gest.soft && (e.clientY - gest.y0) < -G_UP){
        gest.done = true;
        act("hard");
        return;
      }
      /* 往下拖 = 軟降。⚠ 橫軸鎖定時要拖得更遠才准轉過來(紅線 ②的退路) */
      const need = (gest.axis === "x") ? G_SOFT * G_BREAK : G_SOFT;
      if(!gest.soft && (e.clientY - gest.y0) > need){
        gest.soft = true; gest.axis = "y";
        inp.soft = true; if(st) st.soft = true;
      }
    });
    const end = e => {
      if(!gest || (e.pointerId != null && e.pointerId !== gest.id)) return;
      if(gest.soft){ inp.soft = false; if(st) st.soft = false; }
      /* 抬手只判一件事:**幾乎沒動過就是點一下**(= 順時針轉)。
         ⚠ v2.14.0 之前這裡還要判「是不是往下甩」,那正是誤觸落地的來源(紅線 ③)。 */
      if(!gest.done && gest.moved < G_TAP && !gest.axis) act("cw");
      gest = null;
    };
    host.addEventListener("pointerup", end);
    host.addEventListener("pointercancel", () => {
      if(gest && gest.soft){ inp.soft = false; if(st) st.soft = false; }
      gest = null;
    });
    // ⚠ 長按選單與雙擊縮放在手機上會把操作整個吃掉
    host.addEventListener("contextmenu", e => { if(ctrlMode !== "btn") e.preventDefault(); });
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
    /* ★ 每幀的鉤子:單機對電腦在這裡推進電腦那一份狀態。
       ⚠ 放在自己的 tick **之前**,兩邊的時間軸才不會差一幀。 */
    if(running && cfg.onFrame) cfg.onFrame(dt);
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
    for(let i = fx.beams.length - 1; i >= 0; i--){
      fx.beams[i].t += dt;
      if(fx.beams[i].t >= fx.beams[i].dur) fx.beams.splice(i, 1);
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
    elHud   = document.querySelector(".blk-hud");
    elFoes  = document.getElementById("blkFoes");
    elPlay  = document.getElementById("blkPlay");
    cvFx    = document.getElementById("blkFx");
    if(cvFx) ctxF = cvFx.getContext("2d");
    cvMain  = document.getElementById("blkMain");
    cvNext  = document.getElementById("blkNext");
    if(!cvMain || !cvNext) return;
    ctxM = cvMain.getContext("2d");
    ctxN = cvNext.getContext("2d");
    mounted = true;
    bindPad();
    bindGesture();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", () => fitBoard());
    /* ⚠⚠ **一定要有 ResizeObserver,不能只靠 window 的 resize。**
       切 body class(大 / 小、鈕固定在下方、觀戰)會改變舞台的高度,
       而**切 class 不會發 resize 事件** → 盤面會被靜靜削掉一截
       (舞台是 overflow:hidden、內容置中 → 上下各削一半,DOM 與尺寸都還是合法的,
        所以沒有任何斷言會紅)。你畫我猜 v1.156.0 就是漏了這個。
       ⚠ 觀察的是**舞台**不是 canvas —— 觀察 canvas 就是「量的對象會被自己的
         量測結果改變」,那是紅線 ① 那個震盪的另一種寫法。 */
    if(window.ResizeObserver && elStage){
      try{ new ResizeObserver(() => fitBoard()).observe(elStage); }catch(e){}
    }
    /* ⚠ 橫置 / 直立切換時控制簇會搬家、Next 顯示的顆數也會變 → 一定要重量一次。
       有些瀏覽器只發 orientationchange 不發 resize,所以兩個都聽。 */
    window.addEventListener("orientationchange", () => setTimeout(fitBoard, 120));
    /* ⚠ 切到背景一律放開所有鍵:不放的話回來會是「一直往左跑」 */
    document.addEventListener("visibilitychange", () => { if(document.hidden) allUp(); });
    window.addEventListener("blur", allUp);
    wake();
  }
  /* rAF 從 mount() 起是無條件自遞迴的 —— 在進場選單 / 大廳也照樣每秒畫六十次
     一塊看不見的 canvas(手機上就是白燒電)。對局畫面收起來時就停掉它。
     ⚠⚠ 停的條件只能是「對局畫面收起來了」,**不可以用 running** ——
       觀戰者永遠不 play()(running 一直是 false),但他的對手小盤與攻擊光束要照畫。
     ⚠ 醒過來一定要重設 lastT:不然第一幀的 dt 會是「睡了多久」,雖然 frame() 夾在
       100ms,那還是憑空多掉的一格。 */
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
  function allUp(){
    inp.dir = 0; inp.soft = false; inp.keys = {};
    gest = null;                        // ⚠ 手勢也要清:切背景時手指還壓著的話回來就卡住了
    if(st) st.soft = false;
    if(elPad) elPad.querySelectorAll(".blk-on").forEach(b => b.classList.remove("blk-on"));
  }
  function setState(s){
    st = s;
    fx.clear = null; fx.parts.length = 0; fx.pops.length = 0; fx.trail = null;
    fx.shake = 0; fx.hit = 0; fx.beams.length = 0;
    allUp();
    fitBoard();
  }
  function play(){ running = true; lastT = performance.now(); allUp(); }
  function pause(){ running = false; allUp(); }
  function stop(){ running = false; allUp(); }
  function setFeel(i){ feel = clamp(i | 0, 0, DAS_MS.length - 1); }
  function setCtrl(m){
    ctrlMode = (m === "swipe" || m === "both") ? m : "btn";
    if(elPad) elPad.classList.toggle("hidden", ctrlMode === "swipe");
    document.body.classList.toggle("blk-dock", padPos === "dock" && ctrlMode !== "swipe");
    fitBoard();
  }
  /* 控制鈕浮在盤面上(預設,盤面比較大)還是固定在下方(不擋盤面)。
     ⚠ 切成 dock 之後鈕就**參與版面**了 → 盤面會自動縮一階,那是預期的。 */
  function setPad(m){
    padPos = (m === "dock") ? "dock" : "float";
    document.body.classList.toggle("blk-dock", padPos === "dock" && ctrlMode !== "swipe");
    fitBoard();
  }

  return {
    mount, setState, play, pause, stop, wake, sleep, fitBoard, draw,
    act, setFeel, setCtrl, setPad, incoming, pop, shake,
    setFoes, foeAt, beamOut, beamIn, foes: () => foes,
    /* ★ 測試用的三個出口(產品程式不會呼叫它們):
       step(dt) 手動推一幀、frames() 是至今推了幾幀、awake() 是 rAF 現在排著沒有。
       ⚠ frames() 不再適合拿來守「rAF 有沒有啟動」:rAF 現在只在對局畫面才跑
         (wake / sleep),而 step() 也會讓它 +1 → 推過幀之後那個數字就沒有意義了。
         要守「現在到底在不在跑」一律問 awake()(而且它不受 headless 虛擬時間影響,
         不必賭 rAF 在這段虛擬時間裡醒過沒有)。 */
    step: frame,
    frames: () => frameN,
    awake: () => !!raf,
    state: () => st,
    cell: () => cell,
    COL, COL_GARB, DAS_MS, ARR_MS,
    feel: () => feel, ctrl: () => ctrlMode, pad: () => padPos, wide: isWide
  };
})();

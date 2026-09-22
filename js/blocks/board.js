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

  /* ==========================================================================
     二、狀態
     ========================================================================== */
  let cfg = { onEvents: function(){}, canPlay: function(){ return true; }, onFrame: null };
  let st = null;                        // 目前在畫的規則狀態
  let mounted = false, running = false, raf = 0, lastT = 0;
  let cell = 24, prev = 15, dpr = 1;

  let elStage, elWrap, elGauge, elGaugeFill, elPad, elHud, elCast;
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
  /* ⚠⚠ v2.15.1 起**只有按鈕**。手勢那一套(手勢 / 兩者 / 按鈕 三選一)整個拿掉了 ——
     使用者:「我們現在正確來說應該是只剩按鍵,不要用手勢控制」。
     ★ 不要「順手」把它加回來(同換牌那一條,紅線 ⑨):它不是漏掉的東西,是砍掉的。 */
  /* 鈕現在擺哪一種(v2.15.0)。false = 盤面**正下方**一條真的橫列(預設)、
     true = 兩簇貼在盤面**左右兩側的底角**(body.blk-side)。
     ★ 這不是設定、也不是 @media 決定的 —— 是 pickPad() **量出來的**(誰讓盤面大誰贏)。
     使用者第六輪回報之後,「浮在盤面上 / 固定在下方」那一格設定整個拿掉了。 */
  let padSide = false;

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
  /* 寬螢幕 / 橫置。⚠⚠ v2.15.0 起它**不再決定控制鈕擺哪裡**(那件事改成量的,
     見下面的 pickPad())—— 所以「這一行要與 CSS 的 @media 逐字相同」那條紅線
     也跟著消失了。現在它只剩一個用途:NEXT 要預告幾顆(寬螢幕放得下五顆)。 */
  const MQ_WIDE = "(min-width:700px),(orientation:landscape)";
  function isWide(){
    try{ return window.matchMedia(MQ_WIDE).matches; }catch(e){ return false; }
  }

  /* ==========================================================================
     四之二、控制鈕擺哪裡 —— **量出來的,不是設定也不是 @media**(v2.15.0)
     ──────────────────────────────────────────────────────────────────────────
       使用者:「按鈕全部改到最下面,不要有那個浮在上面的選項」
                「比較寬大的螢幕比例時,按鈕的位置相當的不合理。而且也很小」

       兩種擺法,兩種都在**最下面**、都不蓋到盤面:
         · 橫列(預設)—— 盤面正下方一條真的列,它**參與版面** → 盤面縮一階。
         · 側邊(body.blk-side)—— 兩簇貼在盤面左右兩側的底角。寬螢幕 / 橫置時
           盤面是被**高度**卡住的(左右各空兩成多),那兩塊空白盤面本來就用不到
           → 鈕放進去**盤面一格都不用縮**,而且可以做得更大。
           (與紅線 ㉗ 讓對手小盤「只吃盤面用不到的空間」是同一個思路。)

       ★ 挑法:兩種都算一次「一格會有多大」,誰大誰贏;平手 → 橫列
         (使用者要的是「在最下面」,側邊那一種只在真的划算時才用)。

       ⚠⚠⚠ 兩個輸入都必須**與目前的擺法無關**,否則兩種擺法會自己翻來翻去
         (A 算出 B 比較好 → 換成 B 之後又算出 A 比較好…,而 ResizeObserver 會一直還魂):
         · fullH = 舞台現在的高 **+ 目前是橫列的話把那一條與 gap 加回去**
           → 不管現在是哪一種,算出來都是同一個數字。
         · 橫列的高一律讀 CSS 的 --blk-bar(單一真相在 styles.src.css),
           **不可以量 .blk-pad 自己** —— 側邊擺法時它是 inset:0 的浮層,
           量到的會是整個對局區。
     ========================================================================== */
  const PAD_GAP = 14;                   // 側邊擺法時,拇指簇與盤面之間至少要留的空隙

  /* 兩個拇指簇的尺寸。⚠ 量它們是安全的:鈕的大小只由 CSS 決定,不會反過來
     被盤面的尺寸影響(不像量 .blk-foes 自己 = 量自己畫出來的結果)。 */
  function padBox(){
    const l = elPad && elPad.querySelector(".blk-pad-l");
    const r = elPad && elPad.querySelector(".blk-pad-r");
    const lr = l ? l.getBoundingClientRect() : null;
    const rr = r ? r.getBoundingClientRect() : null;
    return { l: lr ? lr.width : 0, r: rr ? rr.width : 0,
             h: Math.max(lr ? lr.height : 0, rr ? rr.height : 0) };
  }
  /* 底部那條橫列的高:讀 CSS 的 --blk-bar。
     ⚠ 它在 CSS 裡是**寫死的 px**,不是 calc() —— 自訂屬性裡的 calc 不會先算完,
       讀回來會是 "calc(54px + 24px)" 這種字串(parseFloat 出來是 NaN)。 */
  function barH(){
    const el = elPlay || document.documentElement;
    const v = parseFloat(getComputedStyle(el).getPropertyValue("--blk-bar"));
    return (isFinite(v) && v > 0) ? v : 78;
  }
  /* 側邊擺法要讓出的左 / 右兩條帶子。
     ★ 右邊那一條是**右簇與對手小盤上下分層共用**的 → 寬度取兩者的**大者**,
       不是相加(相加的話盤面白白少掉一大塊)。 */
  function sideRes(foesOn){
    const pb = padBox();
    return { l: pb.l + PAD_GAP,
             r: Math.max(pb.r, foesOn ? FOE_MAX : 0) + PAD_GAP };
  }
  /* 給定可用寬高,一格會是幾 px(與 fitBoard() 裡那一行必須一致) */
  function cellFor(w, h){
    return Math.round(clamp(Math.min((w - GAUGE_W - 8) / R.COLS, h / R.VIS), MINC, MAXC));
  }
  function pickPad(foesOn){
    if(!elStage || !elPlay) return false;
    const rect = elStage.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(elPlay).rowGap) || 0;
    const bar = barH();
    const fullH = rect.height + (padSide ? 0 : bar + gap);
    const availW = Math.max(120, rect.width - 4);
    const res = sideRes(foesOn);
    const cDock = cellFor(availW, Math.max(120, fullH - bar - gap - 6));
    const cSide = cellFor(Math.max(120, availW - res.l - res.r), Math.max(120, fullH - 6));
    return cSide > cDock;
  }
  function applyPadMode(side){
    side = !!side;
    if(side === padSide) return;
    padSide = side;
    document.body.classList.toggle("blk-side", side);
  }

  function fitBoard(){
    if(!mounted || !elStage) return;
    const spec = document.body.classList.contains("blk-spec");
    const padOn = !!elPad && !elPad.classList.contains("hidden") && !spec;
    const foesOn = !!elFoes && !elFoes.classList.contains("hidden") && !spec;
    /* ★ 先決定鈕擺哪一種(它會切 body 的 class → 舞台的高度跟著變),再量最後的尺寸。
       ⚠ pickPad() 的兩個輸入都與目前的擺法無關 → 不會翻來翻去(見它的檔頭)。 */
    applyPadMode(padOn && pickPad(foesOn));

    const rect = elStage.getBoundingClientRect();
    /* ⚠ 舞台裡只有盤面 —— HUD 與控制列都是它的**兄弟**(v2.15.0 起控制列也搬出去了)。
       側邊擺法時控制列是絕對定位的浮層,同樣不會改變這裡量到的尺寸(紅線 ① / ⑬)。 */
    const useSide = padOn && padSide;
    const res = useSide ? sideRes(foesOn) : { l: 0, r: 0 };
    const availW = Math.max(120, rect.width - 4 - res.l - res.r);
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
    /* ⚠ v2.15.0:側邊擺法時右邊那一條帶子**已經在上面讓好了**(sideRes 取
       「右簇」與「小盤」的大者)—— 所以這裡直接給它 FOE_MAX,不必再看剩多少,
       也不會走「疊在右上角」那條路(那是給沒有帶子可用的情況)。 */
    let foeW = 0, foeOver = false;
    if(foesOn){
      if(useSide){
        foeW = FOE_MAX;
      }else{
        const restW = availW - (R.COLS * cell + GAUGE_W + 8);
        foeOver = (restW < FOE_MIN);
        foeW = foeOver ? FOE_OVER : Math.min(FOE_MAX, Math.floor(restW));
      }
    }
    if(elFoes){
      elFoes.classList.toggle("blk-foes-over", foeOver);
      elFoes.style.width = foeW ? (foeW + "px") : "";
      /* 側邊擺法:小盤要**讓開右簇的高度**(兩者上下分層共用右邊那一條帶子)。
         ⚠ 量的是拇指簇(CSS 定死的尺寸),不是 .blk-foes 自己 —— 量自己就是震盪(紅線 ㉗)。 */
      foeBottom = useSide ? Math.round(padBox().h + 12) : 0;
      elFoes.style.bottom = foeBottom ? (foeBottom + "px") : "";
    }

    const g = getComputedStyle(cvMain).getPropertyValue("--blk-grid").trim();
    if(g) gridCol = g;

    sizeCanvas(cvMain, ctxM, R.COLS * cell, R.VIS * cell);
    if(elGauge) elGauge.style.height = (R.VIS * cell) + "px";
    /* 盤面要**自己讓開**兩邊佔掉的東西(舞台是置中的,只縮小的話它照樣置中,
       右半仍然會壓在小盤底下)。
       · 橫列擺法:只有右邊的小盤要讓(疊在右上角那一條路刻意不讓 —— 那時候
         本來就沒有多的寬可以讓)。
       · 側邊擺法:左右兩條帶子各自讓開,盤面落在**兩條帶子之間**的正中央。
       ⚠ 兩邊相減之後只設一邊:同時設 marginLeft/Right 在 flex 置中下等於沒讓。 */
    const ml = useSide ? res.l : 0;
    const mr = useSide ? res.r : ((foeW && !foeOver) ? foeW : 0);
    if(elWrap){
      elWrap.style.marginLeft  = (ml > mr) ? ((ml - mr) + "px") : "";
      elWrap.style.marginRight = (mr > ml) ? ((mr - ml) + "px") : "";
    }

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
  /* 側邊擺法時小盤要往上讓開右簇的高度(fitBoard 算好寫進來,fitFoes 要跟著扣)。
     ⚠ 它是「舞台高度扣掉的一個量」,不是量 .blk-foes 自己 —— 後者就是震盪(紅線 ㉗)。 */
  let foeBottom = 0;

  function setFoes(list){
    foes = list || [];
    if(!elFoes) return;
    elFoes.classList.toggle("hidden", !foes.length);
    if(foeEls.length !== foes.length){
      foeDanger = [];                   // ⚠ 人數變了 → index 的意思跟著變,舊的遲滯狀態要丟掉
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
    /* ⚠ 側邊擺法時右簇就在這一條的正下方 → 要扣掉它讓出來的那一段(foeBottom),
       不然小盤會算得比看得見的空間還高,最底下那一塊被右簇蓋住。 */
    const availH = Math.max(60, box.height - (spec ? 0 : foeBottom)) - (n - 1) * 8;
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
      e.wrap.classList.toggle("blk-foe-danger", checkDanger(i, b, f.name, dead));
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
  /* 反擊那一道畫成紅的、字也不一樣 —— 「我打回去了」與「我剛好打到他」
     在聚會現場是兩件完全不同的事,長一樣就等於沒做。 */
  function beamOut(i, n, revenge){
    const e = foeEls[i];
    if(e) beam(cvMain, e.cv, revenge ? "#ff5d6c" : "#ffd93d", (revenge ? "反擊 +" : "+") + n);
  }
  /* ⚠ 進來的那一道要帶**攻擊者的名字**(v2.15.3)—— 出去那一道不必:
     它的箭頭尖端就落在對方的小盤上,名字就在正下方,寫了是重複;
     而進來這一道的尖端落在**我的警示條**上,「是誰打我」在畫面上本來完全沒有答案
     (三個人以上時光束太快,看不清楚是從哪一塊飛過來的)。 */
  function beamIn(i, n, who){
    const e = foeEls[i];
    if(e) beam(e.cv, elGauge || cvMain, "#ff5d6c", (who ? who + " " : "") + "+" + n);
    incoming(n);
  }
  /* 對手打對手(單機多台電腦才會用到,v2.15.4)。
     ★ 這一道是刻意要畫的 —— 沒有它,三台電腦看起來只是三個各玩各的沙包,
       而「場上正在互打」正是多台電腦要營造的東西。
     ⚠ 顏色刻意比進出那兩道淡、也不震動:場上的重點永遠是「跟我有關的那一道」。 */
  function beamFoe(i, j, n){
    const a = foeEls[i], b = foeEls[j];
    if(a && b) beam(a.cv, b.cv, "#8b8fa8", "+" + n);
  }

  /* ==========================================================================
     六之四、現場播報(v2.15.3)
     ──────────────────────────────────────────────────────────────────────────
       ★ 「誰快爆了」「誰打爆了誰」這兩件事**一直都在發生**,但在這之前畫面上
         只有一個 K.O. 數字在默默變 —— 聚會現場沒有人會注意到。
         這一段不改任何規則,純粹是把已經發生的事講出來。
       ⚠⚠ **一律 textContent,不可以用 innerHTML** —— 這裡印的是玩家自己取的暱稱。
       ⚠ 播報層是 .blk-play 的子元素、絕對定位、pointer-events:none:
         **放進 .blk-stage 就是讓盤面自己震盪**(紅線 ⑬)。
     ========================================================================== */
  function cast(txt, kind){
    if(!elCast || !txt) return;
    const li = document.createElement("div");
    li.className = "blk-cast-it" + (kind ? " blk-cast-" + kind : "");
    li.textContent = txt;                 /* ⚠ 暱稱是玩家輸入的,不進 innerHTML */
    elCast.appendChild(li);
    while(elCast.childElementCount > 3) elCast.removeChild(elCast.firstChild);
    setTimeout(() => { if(li.parentNode) li.parentNode.removeChild(li); },
               kind === "ko" ? 2400 : 1700);
    if(kind === "ko")          T(320, { type: "square",   dur: 0.15, vol: 0.17, slideTo: 170 });
    else if(kind === "streak") T(520, { type: "triangle", dur: 0.20, vol: 0.18, slideTo: 1060 });
    else                       T(900, { type: "triangle", dur: 0.09, vol: 0.10, slideTo: 1240 });
  }
  function clearCast(){ if(elCast) elCast.innerHTML = ""; }

  /* 「快爆了」的門檻:堆到只剩 4 排就算。
     ⚠ 用 `<=` 而且要有**遲滯**(降回 6 排才解除)—— 沒有遲滯的話堆在門檻上下抖動的人
       會被連續播報幾十次。這與跳棋那條「量到什麼就改什麼 → 自己震盪」是同一族的病,
       只是這裡震的是播報不是版面。 */
  const DANGER_IN = 4, DANGER_OUT = 6;
  let foeDanger = [];
  function checkDanger(i, b, name, dead){
    const was = !!foeDanger[i];
    if(!b || dead){ foeDanger[i] = false; return false; }
    const free = R.stackTop(b) - R.TOP;   // 可見區還空著幾排
    const now = was ? (free <= DANGER_OUT) : (free <= DANGER_IN);
    foeDanger[i] = now;
    if(now && !was && name) cast("⚠️ " + name + " 快爆了!", "warn");
    return now;
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
       一個收斂點:act(name)。鍵盤與螢幕按鈕兩條路全部走它,
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

  /* ==========================================================================
     螢幕按鈕:**按最近的那一顆,不必按準**(v2.14.0)
     ──────────────────────────────────────────────────────────────────────────
       使用者:「我現在還是很容易按了沒反應,因為在玩的時候,不可能有辦法按的很準」。
       ★★ 那不是熱區大小的問題,是**形式**的問題:固定位置的鈕要求你用餘光瞄準,
         而玩的時候眼睛在盤面上,手指是盲按的。把鈕再放大只是把同一個問題往後推。
       ★ 解法:**命中改成「離最近的那一顆」**(SNAP_R 以內就算)。
         按在兩顆中間 → 選比較近的那一顆;按在整簇外面一點 → 照樣按得到。
       ⚠ 因此**熱區矩形那一套整個拿掉了**(原本的 .blk-key::before):
         兩套規則會在重疊區給出不同答案(矩形是「DOM 後面那顆贏」、吸附是「最近的贏」),
         留著就是自己跟自己打架。現在只有一條規則:**最近的贏**。
       ⚠⚠ 入口在 **#blkPlay**(整個對局區)而不是 .blk-pad —— .blk-pad 整層是
         pointer-events:none,簇外面的按壓它根本收不到,而那正是要吸附的情況。
       ⚠ 半徑要有上限:按在盤面正中央不可以被吸到某顆鈕上去(不然「想看清楚點一下盤面」
         會變成方塊自己動了一下,而且那種誤觸完全看不出原因)。
     ========================================================================== */
  const SNAP_R = 46;                    // 從按鈕**邊緣**算起,幾 px 以內算按到它

  /* 直接命中:e.target 就在某顆鈕上(或它的 SVG 裡)。⚠ 按鈕 .hidden 時不算。 */
  function padBtn(t){
    if(!elPad || elPad.classList.contains("hidden")) return null;
    if(!t || !t.closest) return null;
    const b = t.closest("button[data-act]");
    return (b && elPad.contains(b)) ? b : null;
  }
  /* 離 (x,y) 最近的按鈕;超過 SNAP_R 回 null。⚠ 距離是點到**矩形**的距離,
     不是點到中心 —— 用中心的話大顆的鈕(落地)會吃虧。 */
  function nearestKey(x, y){
    if(!elPad || elPad.classList.contains("hidden")) return null;
    let best = null, bestD = SNAP_R;
    const list = elPad.querySelectorAll("button[data-act]");
    for(let i = 0; i < list.length; i++){
      const r = list[i].getBoundingClientRect();
      if(!r.width) continue;
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.sqrt(dx * dx + dy * dy);
      if(d < bestD){ bestD = d; best = list[i]; }
    }
    return best;
  }
  /* ★★ 「drop」是**一顆鈕兩種用法**:短按 = 直接落地、按住 = 慢慢降(軟降)。
     使用者:「我又不想要右手邊那個有落下又有下的按鈕,這樣會搞不太清楚是做什麼」。
     ⚠ 按下去**立刻**開始軟降 —— 不可以等 150ms 才決定要做什麼,那會讓短按有延遲感
       (而「按了沒反應」正是這一頁修了兩輪的東西)。放開得快的話再補一個落地,
       那時方塊只降了一兩格,看起來就是「加速墜落」,很自然。
     ⚠ 落地是唯一不可逆的動作 → 這一顆與旋轉之間刻意拉開(CSS 的 .blk-pad-r gap)。 */
  const DROP_MS = 150;                  // 按住超過這麼久就只是軟降,放開不補落地

  /* ⚠⚠⚠ **一根手指一筆,不可以只記「目前按著的那一顆」**(v2.15.1 的修正)。
     使用者:「如果長按左右按鈕時,這個時候去按旋轉,左、右就沒辦法繼續執行」。
     原本 padDown() 第一行是 `padUp()`(「保險:上一顆還按著的話先放掉」)——
     而在手機上**同時按兩顆是常態**(左手壓著 ◀ 連發、右手點 ↻),那一行等於
     「按旋轉就把左右鬆開」,而且手指還壓在螢幕上、放開時也不會再接回去。
     → 改成 Map:key 是 pointerId,每一根手指各自按下 / 放開,互不干擾。
     ⚠ 放開方向鍵時要 resumeDir():另一根手指還壓著反方向的話要接回去。 */
  const padHold = new Map();            // pointerId → { btn, act, t0 }

  function padDown(b, e, host){
    const id = (e && e.pointerId != null) ? e.pointerId : 0;
    if(padHold.has(id)) padUp(e);       // 同一根手指沒放開又按下:先收乾淨
    /* ⚠⚠ 「按多久」量的是**遊戲時間 `st.time`**,不是 wall clock、也不是 setTimeout。
       ① 語意上這才對:蓋板開著 / 暫停的時候按住不該算(同 HUD 計時那條紅線 ㉒);
       ② headless 的虛擬時間下 `performance.now()` **不跟著 setTimeout 推進**,
          兩者都試過都在 e2e 裡永遠判成「短按」(E11 實測:按住 360ms 還是落地了)——
          而 `st.time` 是規則層在 tick() 裡累積的,e2e 用 BLKB.step() 推得動。
       ★ 一個判定同時滿足「真機行為對」與「測得到」的時候,就選它。 */
    padHold.set(id, { btn: b, act: b.dataset.act, t0: st ? st.time : 0 });
    b.classList.add("blk-on");
    buzz(b.dataset.act);
    /* ⚠ setPointerCapture 會丟例外(合成事件沒有真的 pointerId),而未捕捉的錯誤
       會被 feedback.js 的環形緩衝當成一筆 JS 錯誤記下來 → 一律包起來。 */
    try{ host.setPointerCapture && host.setPointerCapture(id); }catch(_){}
    press(b.dataset.act === "drop" ? "soft" : b.dataset.act);
  }
  /* 放開:`e` 帶得出 pointerId 就只放那一根,不帶(allUp 那條路)就全部放掉。 */
  function padUp(e){
    if(!padHold.size) return;
    const id = (e && e.pointerId != null) ? e.pointerId : null;
    if(id == null){
      /* ⚠ 先整份取出來再清空:endHold() 可能走 act("hard") → onLock → 回頭叫 allUp(),
         邊迭代邊被別人清掉的話會漏放。 */
      const all = Array.from(padHold.values());
      padHold.clear();
      all.forEach(endHold);
      return;
    }
    const h = padHold.get(id);
    if(!h) return;
    padHold.delete(id);                 // ⚠ 同理:要在 endHold 之前就移掉
    endHold(h);
  }
  function endHold(h){
    h.btn.classList.remove("blk-on");
    if(h.act === "drop"){
      release("soft");
      if(((st ? st.time : 0) - h.t0) < DROP_MS) act("hard");
      return;
    }
    release(h.act);
    resumeDir();
  }
  /* 放開一邊的方向鍵之後,另一根手指還壓著另一邊的話要接回去 ——
     不然「左右一起按、放掉其中一顆」會兩邊都停,而手指還在螢幕上。
     ⚠ 這裡**刻意不補一次立即移動**(不走 press):手指沒有重新按下去,
     補一格會變成「放開反而動了一下」。 */
  function resumeDir(){
    if(inp.dir) return;
    let d = 0;
    padHold.forEach(h => {
      if(h.act === "left") d = -1;
      else if(h.act === "right") d = 1;
    });
    if(d){ inp.dir = d; inp.dasT = 0; inp.arrT = 0; }
  }

  /* ---------- 觸覺回饋 ----------
     ⚠⚠ **iOS Safari 一律沒有 navigator.vibrate** —— Apple 從來沒有實作過,
       而且沒有打算(不是「還沒支援」)。iOS 17.4+ 唯一的路是
       `<input type="checkbox" switch>` 切換時系統自己給的觸覺,這是社群挖出來的偏方:
       它**只在真的使用者手勢裡**有效,而且只有真機驗得了(headless 一定測不到)。
     ★ 所以震動一律當成**加分**,不可以當成「按到了」的唯一證據 ——
       那一半由看得見的回饋(.blk-on 的發光與縮放)負責,它每一台都有。 */
  let hapEl = null;
  function iosHaptic(){
    try{
      if(!hapEl){
        hapEl = document.createElement("input");
        hapEl.type = "checkbox";
        hapEl.setAttribute("switch", "");
        hapEl.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
        document.body.appendChild(hapEl);
      }
      hapEl.checked = !hapEl.checked;
    }catch(_){}
  }
  function buzz(act){
    const ms = (act === "hard") ? 16 : 7;     // 落地重一點,移動 / 旋轉只是輕輕一下
    try{
      if(navigator.vibrate){ navigator.vibrate(ms); return; }
    }catch(_){}
    iosHaptic();
  }

  function bindPad(){
    if(!elPad) return;
    // ⚠ 阻止長按選單與雙擊縮放(手機上這兩個會把操作吃掉)
    elPad.addEventListener("contextmenu", e => e.preventDefault());
  }

  /* ---------- 輸入層:**只有按鈕**(v2.15.1 起手勢整套拿掉了)----------
     使用者:「我們現在正確來說應該是只剩按鍵,不要用手勢控制」。
     ★ 跟著消失的:`ctrlMode`(手勢 / 兩者 / 按鈕那一格設定)、`gest` 與
       G_SOFT / G_TAP / G_UP / G_AXIS / G_BREAK / G_TWO / G_SKIP / `gStep()`。
     ⚠⚠ 剩下的這一小段看起來簡單,但三件事一件都不能少:
       ① 感應區仍然是整個對局區 **#blkPlay**,不是 `.blk-pad` ——
          後者整層 `pointer-events:none`,而吸附(nearestKey)要收的正是
          **按在簇外面**的那些壓。
       ② `padBtn(e.target) || nearestKey(x, y)` 兩條都要留(紅線 ㉖之二)。
       ③ `contextmenu` 要擋掉:手機上長按選單會把「按住連發」吃掉。 */
  function bindInput(){
    const host = elPlay || cvMain;
    if(!host) return;
    host.addEventListener("pointerdown", e => {
      const key = padBtn(e.target) || nearestKey(e.clientX, e.clientY);
      if(!key) return;
      e.preventDefault();
      padDown(key, e, host);
    });
    host.addEventListener("pointerup", padUp);
    host.addEventListener("lostpointercapture", padUp);
    host.addEventListener("pointercancel", padUp);
    host.addEventListener("contextmenu", e => e.preventDefault());
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
      /* ⚠⚠ **手指還按著就要一路撐過鎖定**(v2.15.2 的修正)。
         使用者實機回報:「長按慢速移動,蠻容易沒有成功觸發」。
         根因不在輸入層:`spawn()` 每生一顆就把 `st.soft` 跟 fall / lockT 一起歸零,
         而這裡只在**按下 / 放開那一瞬間**寫過它 → 按住不放時,方塊一鎖定,
         下一顆就靜靜退回正常重力。而軟降是 20 倍重力,幾乎每次按住都會撞到一次鎖定
         → 命中率低得就像「按住沒反應」(鍵盤的 ↓ 中的是同一條)。
         ★ 真相的歸屬:**按鍵狀態住在輸入層的 `inp.soft`**,規則層只是照它算重力
           → 所以修在這裡每幀同步回去,而不是去 spawn() 拿掉那一行
           (那會讓 revive / decode 接回來的狀態多一個沒有人管的欄位)。 */
      st.soft = inp.soft;
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
    elCast  = document.getElementById("blkCast");
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
    bindInput();
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
    /* ⚠ 按著的那幾顆也要清 —— 切背景時手指還壓著的話,回來就卡在「一直往左跑」。
       (release 由上下那兩行統一做,所以這裡只要把帳清掉。) */
    padHold.clear();
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

  return {
    mount, setState, play, pause, stop, wake, sleep, fitBoard, draw,
    act, setFeel, incoming, pop, shake,
    setFoes, foeAt, beamOut, beamIn, beamFoe, foes: () => foes,
    cast, clearCast,
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
    /* ★ pad() 回的是**量出來的擺法**("bar" = 盤面正下方那條橫列 / "side" = 左右底角),
       不是設定值 —— 那個設定 v2.15.0 已經整格拿掉了。e2e 靠它驗兩種擺法都真的會出現。 */
    feel: () => feel, pad: () => (padSide ? "side" : "bar"),
    bar: barH, wide: isWide
  };
})();

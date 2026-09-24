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
  /* ★ 天花板(2026-09-23 畫面改版):盤面最上面那一條,新插進來的一排從它**底下**滑出來,
     待處理的垃圾也畫在它上面(取代原本左緣那條警示條 → 盤面多出 18px 寬)。
     ⚠ 它**不是規則的一部分**:規則層的座標(cy / LY / H)一個字都沒動,
       只有畫面與輸入換算多一個 CEIL*D 的位移(draw 的 translate、aimFromPoint、onNext)。 */
  const CEIL = 0.36;
  const BH = R.H + CEIL;                // canvas 的總高(直徑為單位)
  const GAP = 8;                        // 盤面與小盤之間
  const FOE_MIN = 52, FOE_MAX = 170, FOE_OVER = 62;   // 右側那一欄:最窄 / 最寬 / 疊上去時的寬
  const STRIP_MIN = 84, STRIP_MAX = 150, STRIP_PAD = 22;   // 上方那一條:最矮 / 最高 / 名字 + 內距
  const TURN = 0.0024;                  // 鍵盤 ←→ 每毫秒轉幾弧度

  /* ==========================================================================
     二、狀態
     ========================================================================== */
  let cfg = { onEvents: function(){}, canPlay: function(){ return true; }, onFrame: null };
  let st = null;
  let mounted = false, running = false, raf = 0, lastT = 0;
  let D = 32, dpr = 1;
  let elStage, elWrap, elHud, elCast, elPlay;
  let cvMain, ctxM;
  let guideCache = null, gridCache = null;
  const bubbleSprites = new Map();
  const foeSprites = new Map();
  let foeSpriteFd = 0;
  let inkCol = "rgba(255,255,255,.9)";
  let lineCol = "rgba(255,255,255,.14)";
  let ceilCol = "rgba(255,255,255,.10)", ceilEdge = "rgba(255,255,255,.30)";
  let gunCol = "rgba(255,255,255,.46)", guideCol = "rgba(255,255,255,.55)";

  const fx = {
    shake: 0, hit: 0,
    pops: [],                           // 消掉的:{ x, y, c, t }(盤面座標,單位 = 直徑)
    drops: [],                          // 掉落的:{ x, y, c, vy, t }
    sparks: [],                         // 爆開的碎片:{ x, y, vx, vy, c, t, life }
    floats: [],                         // 落點冒出來的「+N」:{ txt, x, y, c, t, dur }
    words: [],                          // 浮字
    push: null,                         // 插排的滑入:{ n, t, dur }
    impact: null,
    beams: []
  };
  /* 輸入。★ aiming = 手指 / 滑鼠正壓著在瞄;keys = 鍵盤方向鍵 */
  const inp = { aiming: false, id: null, cancel: false, keys: {}, turn: 0 };

  /* ==========================================================================
     三、小工具
     ========================================================================== */
  function T(f, o){ if(typeof Sound !== "undefined" && Sound.tone) Sound.tone(f, o); }
  /* 動態配樂(js/shared/chip-bgm.js,v2.16.0+1)—— 選配的:沒載入就什麼都不做。
     ★ 訊號只從這一支送:單機與連線走同一條顯示路徑,接這裡兩邊一起生效。
       setState → round · countdown(fn) → cue · play → go · pause → hold · stop → end · 每幀 → feed · 大消除 → hit */
  function BG(name, a){ if(typeof ChipBGM !== "undefined" && ChipBGM[name]) ChipBGM[name](a); }
  function bgmFeed(){
    if(typeof ChipBGM === "undefined" || !st) return;
    /* 危險度:最低那一顆在第幾列。開局 5 排(lowest 4)≈ 0.1 · 離死亡線 2 列(DANGER_IN)≈ 0.78 */
    const lv = (R.lowest(st.board) - 3) / (R.DEAD - 3);
    ChipBGM.feed(lv, R.pendCount(st) > 0, !!st.rush, !!st.dead);
  }
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
       ★★ 對手小盤擺哪裡:**兩種擺法都算一次,誰讓主盤面的泡泡比較大就用誰**
         (2026-09-23 畫面改版,取代「先縮盤面讓位」那一版的紅線 ⑫):
           · right —— 小盤一欄貼在盤面右邊(寬螢幕 / 橫置:盤面被**高度**卡住,右邊本來就空)
           · top   —— 小盤一整條排在盤面上方(手機直向:盤面被**寬度**卡住,上下反而有空)
         舊版手機直向一律走 right → 盤面只剩螢幕寬的七成、上方空一大片(使用者:「畫面最重要」)。
       ⚠ 兩種擺法都**不可以疊在盤面上**(疊上去蓋住的正好是要瞄準的地方)——
         over 只剩「兩種都塞不下」的極端尺寸會走到。
       ⚠ 盤面與小盤是**一組置中**(以前小盤貼在舞台最右邊,桌機上跟盤面隔了一大段)。
     ========================================================================== */
  let foes = [], foeEls = [], elFoes = null;
  let foeLayout = "none", foeColW = 0, stripH = 0;
  function fitBoard(){
    if(!mounted || !elStage) return;
    const prevD = D, prevDpr = dpr;
    const spec = document.body.classList.contains("bub-spec");
    const foesOn = !!elFoes && !elFoes.classList.contains("hidden") && !spec && foes.length > 0;
    const rect = elStage.getBoundingClientRect();
    const availW = Math.max(120, rect.width - 4);
    const availH = Math.max(120, rect.height - 6);
    dpr = Math.min(3, window.devicePixelRatio || 1);
    const fit = d => Math.floor(clamp(d, MIND, MAXD));

    let layout = "none", d = Math.min(availW / R.COLS, availH / BH);
    foeColW = 0; stripH = 0;
    if(foesOn){
      const dR = Math.min((availW - GAP - FOE_MIN) / R.COLS, availH / BH);
      const dT = Math.min(availW / R.COLS, (availH - GAP - STRIP_MIN) / BH);
      if(dT > dR + 0.5){
        layout = "top"; d = dT;
        /* 盤面吃剩的高度全部給小盤(上限 STRIP_MAX)—— 小盤越大越看得出對手快不快爆 */
        stripH = Math.round(clamp(availH - GAP - BH * fit(d), STRIP_MIN, STRIP_MAX));
      }else{
        layout = "right"; d = dR;
        const restW = availW - R.COLS * fit(d) - GAP;
        if(restW < FOE_MIN){ layout = "over"; foeColW = FOE_OVER; }
        else{
          /* ⚠ 欄寬收到小盤實際要的寬:橫置手機時小盤是被**高度**卡住的,
             欄寬給滿的話小盤置中在一條寬欄裡,跟盤面中間空出一大段(截圖量到 50px) */
          const n = foes.length;
          const fdH = ((availH - (n - 1) * 8) / n - 16) / R.H;
          const need = Math.ceil(Math.max(3, fdH) * R.COLS + 8);
          foeColW = Math.floor(Math.max(FOE_MIN, Math.min(FOE_MAX, restW, need)));
        }
      }
    }
    D = fit(d);
    foeLayout = layout;
    if(D !== prevD || dpr !== prevDpr){ bubbleSprites.clear(); foeSprites.clear(); gridCache = null; }

    const wrapW = R.COLS * D, wrapH = Math.round(BH * D);
    if(elFoes){
      elFoes.classList.toggle("bub-foes-over", layout === "over");
      elFoes.classList.toggle("bub-foes-top", layout === "top");
      const s = elFoes.style;
      s.width = ""; s.height = ""; s.right = ""; s.top = "";
      if(layout === "right"){
        s.width = foeColW + "px";
        s.right = Math.max(0, Math.floor((rect.width - (wrapW + GAP + foeColW)) / 2)) + "px";
      }else if(layout === "top"){
        s.height = stripH + "px";
        s.top = Math.max(0, Math.floor((rect.height - (stripH + GAP + wrapH)) / 2)) + "px";
      }else if(layout === "over"){
        s.width = foeColW + "px";
      }
    }
    if(elWrap){
      elWrap.style.marginRight = (layout === "right") ? ((foeColW + GAP) + "px") : "";
      elWrap.style.marginTop = (layout === "top") ? ((stripH + GAP) + "px") : "";
    }
    if(elHud) inkCol = getComputedStyle(elHud).color || inkCol;
    const cs = getComputedStyle(cvMain);
    const g = cs.getPropertyValue("--bub-grid").trim();
    if(g) lineCol = g;
    const c1 = cs.getPropertyValue("--bub-ceil").trim(), c2 = cs.getPropertyValue("--bub-ceil-edge").trim();
    if(c1) ceilCol = c1;
    if(c2) ceilEdge = c2;
    const c3 = cs.getPropertyValue("--bub-gun").trim(), c4 = cs.getPropertyValue("--bub-guide").trim();
    if(c3) gunCol = c3;
    if(c4) guideCol = c4;

    sizeCanvas(cvMain, ctxM, wrapW, wrapH);
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
       細深邊 → 飽和本體(左上受光、右下收暗)→ 下緣有色回光 → 右下邊光 →
       邊緣銳利的窗光 + 小亮點 → 深色刻印的形狀記號(紅線 ⑦:色弱辨識的保險)。
       ★★ 2026-09-23 去霧(使用者:「珠子看起來霧霧的」)。上一版霧的三個來源,都不要再加回來:
         ① 本體左上三分之一混了 74% → 32% 的白 —— 混白 = 降彩度,整顆像蒙了一層粉
         ② 形狀記號是 55% 的半透明白,蓋在正中央 —— 乳白貼紙
         ③ 高光是一團柔焦的放射漸層(0.9 → 0.5 → 0)—— 亮面糊成一片就讀成「霧面」
         透明感改由「下緣回光」給:它用的是**亮一點的本色**,不是白。
       靜止球會預先快取成 sprite(見 blit())。
     ========================================================================== */
  function bubble(ctx, px, py, d, c, o){
    o = o || {};
    const r = d * 0.47, ri = r * 0.93;
    const col = colOf(c);
    ctx.save();
    if(o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
    if(o.glow){ ctx.shadowColor = col; ctx.shadowBlur = Math.max(6, d * 0.45); }
    // 細深邊:相鄰的同色球靠它分開
    ctx.fillStyle = shade(col, -0.64);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // 本體:白只佔受光點那一小塊,中段就是飽和的本色
    const body = ctx.createRadialGradient(px - r * 0.28, py - r * 0.34, 0, px - r * 0.08, py - r * 0.1, r * 1.1);
    body.addColorStop(0, shade(col, 0.30));
    body.addColorStop(0.3, shade(col, 0.06));
    body.addColorStop(0.58, col);
    body.addColorStop(0.84, shade(col, -0.28));
    body.addColorStop(1, shade(col, -0.55));
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(px, py, ri, 0, Math.PI * 2); ctx.fill();
    // 下緣回光:光穿過球從底下透出來(透明感從這裡來,不靠混白)
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, ri, 0, Math.PI * 2); ctx.clip();
    const bounce = ctx.createRadialGradient(px + r * 0.18, py + r * 0.9, 0, px + r * 0.18, py + r * 0.9, r * 0.62);
    bounce.addColorStop(0, shade(col, 0.5));
    bounce.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha *= 0.4;
    ctx.fillStyle = bounce;
    ctx.fillRect(px - r, py, r * 2, r);
    ctx.restore();
    // 右下邊光(亮一點的本色,不是白 —— 白的一圈會變成描邊)
    if(d >= 12){
      ctx.save();
      ctx.lineCap = "round";
      ctx.globalAlpha *= 0.7;
      ctx.strokeStyle = shade(col, 0.55);
      ctx.lineWidth = Math.max(0.8, d * 0.03);
      ctx.beginPath(); ctx.arc(px, py, r * 0.8, 0.35, 1.25); ctx.stroke();
      ctx.restore();
    }
    // 窗光:邊緣是銳利的(形狀本身不漸層,只有上下的亮度漸層)
    const hx = px - r * 0.33, hy = py - r * 0.46;
    const hl = ctx.createLinearGradient(hx, hy - r * 0.22, hx, hy + r * 0.24);
    hl.addColorStop(0, "rgba(255,255,255,.98)");
    hl.addColorStop(0.55, "rgba(255,255,255,.62)");
    hl.addColorStop(1, "rgba(255,255,255,.18)");
    ctx.fillStyle = hl;
    ctx.beginPath(); ctx.ellipse(hx, hy, r * 0.38, r * 0.21, -0.58, 0, Math.PI * 2); ctx.fill();
    if(d >= 16){
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.beginPath(); ctx.arc(px + r * 0.12, py - r * 0.66, r * 0.075, 0, Math.PI * 2); ctx.fill();
    }
    if(d >= 14) mark(ctx, px, py + r * 0.08, r * 0.34, c);
    ctx.restore();
  }
  /* 快取的 sprite 一律**對齊裝置像素、1:1 貼上**。
     ⚠ 以前是 drawImage(sprite, x, y, D, D):六角盤的列高是 0.866 顆、天花板又往下推 0.36 顆,
       落點幾乎都是小數像素 → 每一顆都被雙線性重新取樣一次,邊緣發軟(霧感的第四個來源)。
     ⚠ 只有「平移 + 等比 dpr」的矩陣才能 1:1;被縮放過的(目前沒有,將來加了也不會錯)退回舊的畫法。 */
  function blit(ctx, sprite, px, py, d){
    const m = ctx.getTransform ? ctx.getTransform() : null;
    if(m && !m.b && !m.c && Math.abs(m.a - dpr) < 1e-6 && Math.abs(m.d - dpr) < 1e-6){
      const dx = Math.round(m.a * px + m.e - sprite.width / 2);
      const dy = Math.round(m.d * py + m.f - sprite.height / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sprite, dx, dy);
      ctx.setTransform(m);
    }else{
      ctx.drawImage(sprite, px - d / 2, py - d / 2, d, d);
    }
  }
  /* 靜止珠子每幀最多數十顆；六色各畫一次後重用，避免重算球殼漸層。 */
  function boardBubble(px, py, c){
    let sprite = bubbleSprites.get(c);
    if(!sprite){
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = Math.ceil(D * dpr);
      const sc = sprite.getContext("2d");
      sc.setTransform(sprite.width / D, 0, 0, sprite.height / D, 0, 0);
      bubble(sc, D / 2, D / 2, D, c);
      bubbleSprites.set(c, sprite);
    }
    blit(ctxM, sprite, px, py, D);
  }
  function foeBubble(ctx, px, py, fd, c){
    const key = fd + ":" + dpr + ":" + c;
    let sprite = foeSprites.get(key);
    if(!sprite){
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = Math.ceil(fd * dpr);
      const sc = sprite.getContext("2d");
      sc.setTransform(sprite.width / fd, 0, 0, sprite.height / fd, 0, 0);
      bubble(sc, fd / 2, fd / 2, fd, c);
      foeSprites.set(key, sprite);
    }
    blit(ctx, sprite, px, py, fd);
    // 小盤尺寸不足以容納主盤的記號，放大記號保留色弱辨識。
    if(fd >= 6 && fd < 14) mark(ctx, px, py, Math.max(1.5, fd * 0.18), c, true);
  }
  /* 形狀記號:深色刻印(本色壓暗)+ 下方一道淡亮邊,看起來是壓進去的。
     ⚠ 不可以改回半透明白 —— 那正是「霧霧的」的來源之一(見上面 ②)。
     ★ strong = 對手小盤那種小尺寸:不畫亮邊(幾個像素的亮邊只會糊成一團),顏色再壓深一點。 */
  function markPath(ctx, x, y, s, c){
    ctx.beginPath();
    if(c === 1){ ctx.arc(x, y, s * 0.55, 0, Math.PI * 2); return true; }
    if(c === 2){ ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.9, y + s * 0.6); ctx.lineTo(x - s * 0.9, y + s * 0.6); ctx.closePath(); }
    else if(c === 3){ ctx.rect(x - s * 0.7, y - s * 0.7, s * 1.4, s * 1.4); }
    else if(c === 4){ ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); }
    else if(c === 5){ ctx.moveTo(x - s * 0.8, y - s * 0.8); ctx.lineTo(x + s * 0.8, y + s * 0.8); ctx.moveTo(x + s * 0.8, y - s * 0.8); ctx.lineTo(x - s * 0.8, y + s * 0.8); }
    else { ctx.arc(x, y, s * 0.8, 0, Math.PI * 2); }
    return false;
  }
  function mark(ctx, x, y, s, c, strong){
    ctx.save();
    ctx.lineWidth = Math.max(1.2, s * 0.34);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if(!strong){
      const off = Math.max(0.5, s * 0.1);
      ctx.strokeStyle = ctx.fillStyle = "rgba(255,255,255,.35)";
      if(markPath(ctx, x, y + off, s, c)) ctx.fill(); else ctx.stroke();
      y -= off * 0.6;
    }
    ctx.globalAlpha *= 0.9;
    ctx.strokeStyle = ctx.fillStyle = shade(colOf(c), strong ? -0.7 : -0.6);
    if(markPath(ctx, x, y, s, c)) ctx.fill(); else ctx.stroke();
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
    const W = R.COLS * D, Hh = Math.round(BH * D), OY = CEIL * D;
    const now = performance.now();
    ctxM.clearRect(0, 0, W, Hh);        // ⚠ 紅線 ⑥
    ctxM.save();
    if(fx.shake > 0.3){
      const a = Math.random() * Math.PI * 2;
      ctxM.translate(Math.cos(a) * fx.shake, Math.sin(a) * fx.shake);
    }
    /* ★ 天花板底下才是規則層的座標系(cy / LY 一個字都沒動)—— 整段往下推 CEIL 顆 */
    ctxM.save();
    ctxM.translate(0, OY);
    gridDots(W);
    if(st) dangerZone(W, now);
    deadLine(W);
    if(st){
      const off = pushOff();
      for(let y = 0; y < R.ROWS; y++)
        for(let x = 0; x < R.COLS; x++){
          const v = st.board[y][x];
          if(!v) continue;
           boardBubble(R.cx(st.par, x, y) * D, (R.cy(y) - off) * D, v);
        }
      popsFx();
      aimGuide();
      shotFx();
      launcher(now);
    }
    floatsFx();
    words();
    ctxM.restore();
    /* ⚠ 天花板畫在泡泡**之後**:插排滑入時,新的那一排看起來是從天花板底下被推出來的 */
    ceiling(W, OY, now);
    ctxM.restore();
    countdownFx(W, Hh);
    edgeFlash(W, Hh);
    drawFoes();
    drawBeams();
  }
  /* 空格的淡點:看得出「那裡可以黏」,盤面也不再是一片空白的深色。
     ⚠ 快取成一張圖(每一幀畫 100 個點不值得);par 一翻面、D 一變、主題一換就重畫。 */
  function gridDots(W){
    const key = D + ":" + dpr + ":" + (st ? st.par : 0) + ":" + lineCol;
    if(!gridCache || gridCache.key !== key){
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(R.cy(R.DEAD) * D * dpr);
      const c = cv.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = lineCol;
      c.globalAlpha = 0.55;
      const par = st ? st.par : 0, r = Math.max(1, D * 0.055);
      for(let y = 0; y < R.DEAD; y++){
        const w = R.isOdd(par, y) ? R.COLS - 1 : R.COLS;
        for(let x = 0; x < w; x++){
          c.beginPath(); c.arc(R.cx(par, x, y) * D, R.cy(y) * D, r, 0, Math.PI * 2); c.fill();
        }
      }
      gridCache = { key: key, cv: cv };
    }
    const cv = gridCache.cv;
    ctxM.drawImage(cv, 0, 0, cv.width / dpr, cv.height / dpr);
  }
  /* 危險區:最低那一列離死亡線 ≤ 3 列就從死亡線往上泛紅,越近越紅、會呼吸。
     ★ 「快爆了」以前只有一條虛線變紅 —— 在手機上根本沒人看得到那條線。 */
  function dangerZone(W, now){
    const low = R.lowest(st.board);
    if(low < R.DEAD - 3) return;
    const k = clamp((low - (R.DEAD - 4)) / 3, 0, 1);
    const pulse = reduced() ? 1 : (0.72 + 0.28 * Math.sin(now / 170));
    const y1 = (R.cy(R.DEAD) - 0.5) * D, y0 = y1 - D * 2.6;
    const g = ctxM.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "rgba(255,93,108,0)");
    g.addColorStop(1, "rgba(255,93,108," + ((0.10 + 0.22 * k) * pulse).toFixed(3) + ")");
    ctxM.fillStyle = g;
    ctxM.fillRect(0, y0, W, y1 - y0);
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
  /* 天花板 + 待處理垃圾。
     ★ 被塞的排數以前是左緣一條 10px 的細條(手機上幾乎看不到,而且吃掉盤面寬度)——
       現在直接畫在天花板上:一格 = 一排,紅色越多越危險;暖身保護中是藍色(擋著、還沒插)。
     ★ 下一發就會插排的時候,天花板下緣閃橘色 —— 那一發要先想好。 */
  function ceiling(W, OY, now){
    ctxM.save();
    const g = ctxM.createLinearGradient(0, 0, 0, OY);
    g.addColorStop(0, ceilEdge);
    g.addColorStop(1, ceilCol);
    ctxM.fillStyle = g;
    ctxM.fillRect(0, 0, W, OY);
    // 下緣的陰影壓在第一排泡泡上,天花板才有「蓋著」的厚度
    const sh = ctxM.createLinearGradient(0, OY, 0, OY + D * 0.22);
    sh.addColorStop(0, "rgba(0,0,0,.30)");
    sh.addColorStop(1, "rgba(0,0,0,0)");
    ctxM.fillStyle = sh;
    ctxM.fillRect(0, OY, W, D * 0.22);
    // 鉚釘:每一欄一顆,純裝飾(讓天花板看起來是一塊「板」而不是一條色帶)。
    // ⚠ 垃圾格與「+N 排」那一段不畫(疊在字上很髒)—— 那一段的右緣由下面算出來
    let busyTo = 0;
    const pend = st ? R.pendCount(st) : 0;
    if(pend > 0) busyTo = D * 0.22 + Math.min(pend, 6) * D * 0.76 + D * 1.9;
    ctxM.fillStyle = ceilEdge;
    for(let x = 0; x < R.COLS; x++){
      const rx = (x + 0.5) * D;
      if(rx < busyTo) continue;
      ctxM.beginPath(); ctxM.arc(rx, OY * 0.5, Math.max(1, D * 0.045), 0, Math.PI * 2); ctxM.fill();
    }
    if(st){
      const pressLeft = R.pressN(st) - st.since;
      let edge = ceilEdge, lw = Math.max(1, D * 0.04);
      if(pressLeft <= 1 && !st.dead){
        const p = reduced() ? 1 : (0.55 + 0.45 * Math.sin(now / 110));
        edge = "rgba(255,159,67," + (0.55 + 0.45 * p).toFixed(3) + ")";
        lw = Math.max(2, D * 0.08);
      }
      ctxM.strokeStyle = edge; ctxM.lineWidth = lw;
      ctxM.beginPath(); ctxM.moveTo(0, OY - lw / 2); ctxM.lineTo(W, OY - lw / 2); ctxM.stroke();
      const n = R.pendCount(st);
      if(n > 0){
        const held = st.shield > 0;
        const hot = n >= 3 && !held;
        const a = (hot && !reduced()) ? (0.7 + 0.3 * Math.sin(now / 90)) : 1;
        const show = Math.min(n, 6);
        const pw = D * 0.62, ph = OY * 0.52, gap = D * 0.14;
        const x0 = D * 0.22, y0 = (OY - ph) / 2;
        ctxM.globalAlpha = a;
        for(let i = 0; i < show; i++){
          const px = x0 + i * (pw + gap);
          const pg = ctxM.createLinearGradient(0, y0, 0, y0 + ph);
          pg.addColorStop(0, held ? "#9be7ff" : "#ff9aa4");
          pg.addColorStop(1, held ? "#2fb3e4" : "#ff2d55");
          ctxM.fillStyle = pg;
          roundRect(ctxM, px, y0, pw, ph, ph / 2);
          ctxM.fill();
        }
        ctxM.globalAlpha = 1;
        ctxM.font = "800 " + Math.max(10, Math.round(OY * 0.72)) + "px Fredoka, Nunito, system-ui, sans-serif";
        ctxM.textAlign = "left"; ctxM.textBaseline = "middle";
        ctxM.lineWidth = 3; ctxM.strokeStyle = "rgba(0,0,0,.55)";
        const txt = (held ? "🛡️ " : "") + "+" + n + " 排";
        const tx = x0 + show * (pw + gap) + D * 0.05;
        ctxM.strokeText(txt, tx, OY / 2 + 1);
        ctxM.fillStyle = held ? "#9be7ff" : (hot ? "#ff5d6c" : "#ffb3b9");
        ctxM.fillText(txt, tx, OY / 2 + 1);
      }
    }
    ctxM.restore();
  }
  function roundRect(c, x, y, w, h, r){
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y);
    c.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    c.lineTo(x + w, y + h - r);
    c.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    c.lineTo(x + r, y + h);
    c.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    c.lineTo(x, y + r);
    c.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    c.closePath();
  }
  function popsFx(){
    if(fx.impact && fx.impact.t < 170 && !reduced()){
      const q = fx.impact, k = q.t / 170;
      ctxM.save();
      ctxM.globalAlpha = 1 - k;
      ctxM.strokeStyle = colOf(q.c);
      ctxM.lineWidth = Math.max(1.5, D * 0.085);
      ctxM.beginPath();
      ctxM.arc(q.x * D, q.y * D, D * (0.3 + k * 0.55), 0, Math.PI * 2);
      ctxM.stroke();
      ctxM.restore();
    }
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
    /* 爆開的碎片(同色小光點,往外噴、受重力) */
    for(let i = 0; i < fx.sparks.length; i++){
      const p = fx.sparks[i], k = p.t / p.life;
      if(k >= 1) continue;
      ctxM.globalAlpha = 1 - k;
      ctxM.fillStyle = k < 0.25 ? "#fff" : colOf(p.c);
      ctxM.beginPath(); ctxM.arc(p.x * D, p.y * D, Math.max(1, D * 0.1 * (1 - k * 0.7)), 0, Math.PI * 2); ctxM.fill();
    }
    ctxM.globalAlpha = 1;
  }
  /* 落點冒出來的「+N」(打掉幾顆就是幾分) */
  function floatsFx(){
    for(let i = 0; i < fx.floats.length; i++){
      const p = fx.floats[i], k = p.t / p.dur;
      if(k >= 1) continue;
      const s = k < 0.15 ? (0.5 + 0.5 * k / 0.15) : 1;
      ctxM.save();
      ctxM.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
      ctxM.translate(p.x * D, (p.y - k * 0.9) * D);
      ctxM.scale(s, s);
      ctxM.font = "800 " + Math.round(D * p.size) + "px Fredoka, Nunito, system-ui, sans-serif";
      ctxM.textAlign = "center"; ctxM.textBaseline = "middle";
      ctxM.lineWidth = Math.max(3, D * 0.14); ctxM.strokeStyle = "rgba(0,0,0,.55)";
      ctxM.strokeText(p.txt, 0, 0);
      ctxM.fillStyle = p.c; ctxM.fillText(p.txt, 0, 0);
      ctxM.restore();
    }
  }
  /* 預瞄線。⚠ 紅線 ③:一律走 trace()。
     ★ 只畫到「第一次反彈之後再 3 顆」—— 整條畫到底就等於告訴你落點,
       而判斷反彈角度正是這個遊戲要練的東西。沒反彈的直球本來就看得到落點,無所謂。 */
  function aimGuide(){
    if(!st || st.dead || !running || st.shot) return;
    if(inp.aiming && inp.cancel) return;
    /* 倒數中不畫:單機倒數時 running 是 true(擋射擊的是 canPlay),虛線會直直穿過那個大數字 */
    if(cdFn){ const l = cdFn(); if(typeof l === "number" && l > 0) return; }
    /* 瞄準與盤面沒變時沿用軌跡，避免每幀重跑逐步碰撞檢查。 */
    if(!guideCache || guideCache.board !== st.board || guideCache.par !== st.par ||
       guideCache.shots !== st.shots || guideCache.aim !== st.aim)
      guideCache = { board: st.board, par: st.par, shots: st.shots, aim: st.aim,
                     trace: R.trace(st.board, st.par, st.aim) };
    const t = guideCache.trace;
    const pts = t.path;
    let budget = 999, bounced = false;
    ctxM.save();
    ctxM.strokeStyle = guideCol;
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
    if(!reduced()){
      for(let i = 3; i >= 1; i--)
        bubble(ctxM, (s.x - s.vx * i * 0.23) * D, (s.y - s.vy * i * 0.23) * D,
               D * (0.42 - i * 0.07), s.c, { alpha: 0.13 + (3 - i) * 0.08 });
    }
    bubble(ctxM, s.x * D, s.y * D, D, s.c, { glow: !reduced() });
  }
  /* 發射器:圓頂底座 + 會轉的砲管 + 目前這顆 + 左邊的「下一顆」(點它 = 交換)
     + 右邊的「插排倒數」小點(一點 = 一發;最後兩發變紅)。
     ★ 以前是一個空心三角形箭頭飄在一個淡圈上,看不出是「砲台」;插排倒數只在 HUD 上有個數字。 */
  function launcher(now){
    const x = R.LX * D, y = R.LY * D;
    const lw = Math.max(1.2, D * 0.05);
    ctxM.save();
    // 底座(圓頂)
    const by = y + D * 0.3, br = D * 1.0;
    ctxM.fillStyle = gunCol;
    ctxM.globalAlpha = 0.34;
    ctxM.beginPath(); ctxM.arc(x, by, br, Math.PI, 0); ctxM.closePath(); ctxM.fill();
    ctxM.globalAlpha = 0.8;
    ctxM.strokeStyle = gunCol; ctxM.lineWidth = lw;
    ctxM.beginPath(); ctxM.arc(x, by, br, Math.PI, 0); ctxM.stroke();
    // 砲管
    ctxM.translate(x, y);
    ctxM.rotate(st.aim);
    const tw = D * 0.34, tl = D * 1.22;
    ctxM.globalAlpha = 0.62;
    ctxM.fillStyle = gunCol;
    roundRect(ctxM, -tw / 2, -tl, tw, tl, tw * 0.3);
    ctxM.fill();
    // 砲管中央的一條亮面(不論主題都是白的:那是反光)
    ctxM.globalAlpha = 0.35;
    ctxM.fillStyle = "#fff";
    ctxM.fillRect(-tw * 0.12, -tl + D * 0.1, tw * 0.16, tl - D * 0.2);
    ctxM.globalAlpha = 1;
    ctxM.strokeStyle = gunCol; ctxM.lineWidth = lw;
    ctxM.stroke();
    // 砲口的一圈(顏色 = 目前這顆,打出去的就是它)
    ctxM.strokeStyle = colOf(st.cur); ctxM.lineWidth = Math.max(1.5, D * 0.08);
    ctxM.beginPath(); ctxM.moveTo(-tw / 2, -tl + D * 0.06); ctxM.lineTo(tw / 2, -tl + D * 0.06); ctxM.stroke();
    ctxM.restore();
    if(!st.shot && !st.dead) bubble(ctxM, x, y, D, st.cur);
    else if(!st.dead) bubble(ctxM, x, y, D * 0.8, st.cur, { alpha: 0.35 });
    // 下一顆
    const n = nextPos();
    ctxM.fillStyle = "rgba(255,255,255,.07)";
    ctxM.beginPath(); ctxM.arc(n.x, n.y, D * 0.5, 0, Math.PI * 2); ctxM.fill();
    bubble(ctxM, n.x, n.y, D * 0.72, st.next);
    ctxM.save();
    ctxM.font = "800 " + Math.max(9, Math.round(D * 0.28)) + "px Nunito, system-ui, sans-serif";
    ctxM.textAlign = "center"; ctxM.textBaseline = "middle";
    ctxM.fillStyle = inkCol; ctxM.globalAlpha = 0.72;
    ctxM.fillText("⇄ 換", n.x + D * 0.95, n.y);
    ctxM.restore();
    pressDots(x, y, now);
  }
  function pressDots(x, y, now){
    const N = R.pressN(st), left = Math.max(0, N - st.since);
    const x0 = x + D * 1.25, xMax = R.COLS * D - D * 0.25;
    const step = Math.min(D * 0.3, (xMax - x0) / Math.max(1, N - 1));
    const r = Math.max(1.5, Math.min(D * 0.09, step * 0.36));
    const hot = left <= 2 && !st.dead;
    const a = (hot && !reduced()) ? (0.65 + 0.35 * Math.sin(now / 120)) : 1;
    ctxM.save();
    ctxM.font = "800 " + Math.max(8, Math.round(D * 0.22)) + "px Nunito, system-ui, sans-serif";
    ctxM.textAlign = "left"; ctxM.textBaseline = "alphabetic";
    ctxM.fillStyle = hot ? "#ff5d6c" : inkCol; ctxM.globalAlpha = hot ? 1 : 0.62;
    ctxM.fillText(hot ? ("再 " + left + " 發插排") : "插排", x0 - r, y - D * 0.14);
    for(let i = 0; i < N; i++){
      const on = i < left;
      ctxM.globalAlpha = on ? a : 0.28;
      ctxM.fillStyle = on ? (hot ? "#ff5d6c" : inkCol) : inkCol;
      ctxM.beginPath(); ctxM.arc(x0 + i * step, y + D * 0.14, r, 0, Math.PI * 2); ctxM.fill();
    }
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
  /* ★ 待處理垃圾以前是左緣一條 DOM 警示條(.bub-gauge)—— 2026-09-23 改畫在天花板上(見 ceiling()) */

  /* ==========================================================================
     六之一、開局倒數(2026-09-23 重做)
     ──────────────────────────────────────────────────────────────────────────
       ★ 以前是把數字塞進「已暫停」那塊 26px 的字(使用者:「不夠明顯漂亮」)。
         現在畫在盤面上:暗幕 + 大數字彈出 + 一圈環在這一秒內耗完(3 紅 2 黃 1 綠),
         歸零時「開始!」+ 六色碎片 + 衝擊環,CD_GO_MS 內淡掉(不擋操作)。
       ★ 畫面**只由「還剩幾毫秒」決定** —— countdown(fn) 收的是一個函式,每一幀問一次:
         連線給 `startAt - 伺服器時間`(每台讀同一個 startAt → 畫面自然同步),
         單機給 Solo 自己扣的毫秒數(暫停 / 蓋板時不扣 → 倒數跟著停)。
         正數 = 還剩多久;負數 = 已經開始多久(「開始!」那一段靠它)。
       ⚠ 紅線 ②:不用 CSS @keyframes。
       ⚠ 數字最多是 3:連線的 LEAD_MS 是 3.2 秒,無條件進位的話房主那台會先閃一下「4」。
       ⚠ 字的光暈另外畫一層,本體不帶 shadow —— 帶著 shadow 填字,邊緣就是糊的(又是霧)。
     ========================================================================== */
  const CD_COL = { 3: "#ff5d6c", 2: "#ffd93d", 1: "#3ddc7f" };
  const CD_GO_MS = 650;
  const CD_GO_TXT = "開始!";
  let cdFn = null, cdLast = "";
  function countdown(fn){
    cdFn = (typeof fn === "function") ? fn : null; cdLast = "";
    if(cdFn) BG("cue", cdFn());         // 配樂的第一拍排在 GO 那一刻(fn 回的是「還剩幾毫秒」)
  }
  function cdLabel(left){
    if(typeof left !== "number" || !isFinite(left)) return "";
    if(left > 0) return String(Math.min(3, Math.ceil(left / 1000)));
    return (-left < CD_GO_MS) ? CD_GO_TXT : "";
  }
  function easeBack(t){ const k = 1.9; return 1 + (k + 1) * Math.pow(t - 1, 3) + k * Math.pow(t - 1, 2); }
  function bigText(txt, px, col, stops){
    ctxM.font = "700 " + Math.round(px) + "px Fredoka, Nunito, system-ui, sans-serif";
    if(!reduced()){
      ctxM.save();
      ctxM.globalAlpha *= 0.55;
      ctxM.fillStyle = col; ctxM.shadowColor = col; ctxM.shadowBlur = D * 0.9;
      ctxM.fillText(txt, 0, 0);
      ctxM.restore();
    }
    ctxM.lineWidth = px * 0.1;
    ctxM.strokeStyle = "rgba(10,6,24,.85)";
    ctxM.strokeText(txt, 0, 0);
    const g = ctxM.createLinearGradient(0, -px * 0.45, 0, px * 0.5);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctxM.fillStyle = g;
    ctxM.fillText(txt, 0, 0);
  }
  function countdownFx(W, H){
    if(!cdFn) return;
    const left = cdFn();
    const lbl = cdLabel(left);
    if(lbl !== cdLast){
      if(lbl === CD_GO_TXT) T(880, { type: "triangle", dur: 0.26, vol: 0.2, slideTo: 1320 });
      else if(lbl) T(lbl === "1" ? 660 : 520, { type: "sine", dur: 0.12, vol: 0.16 });
      cdLast = lbl;
    }
    if(!lbl){ cdFn = null; return; }
    const rm = reduced();
    const cx = W / 2, cy = H * 0.55;
    ctxM.save();
    ctxM.textAlign = "center"; ctxM.textBaseline = "middle"; ctxM.lineJoin = "round";
    if(left > 0){
      const n = +lbl, col = CD_COL[n];
      const f = clamp(1 - (left - (n - 1) * 1000) / 1000, 0, 1);    // 這一秒過了多少(0 → 1)
      // 暗幕:盤面退到背景;最後 0.15 秒淡掉,接「開始!」
      const veil = (n === 1 && f > 0.85) ? (1 - f) / 0.15 : 1;
      ctxM.globalAlpha = veil;
      ctxM.fillStyle = "rgba(8,5,20,.5)";
      ctxM.fillRect(0, 0, W, H);
      // 環:這一秒還剩多少
      const R0 = D * 2.35;
      ctxM.lineCap = "round";
      ctxM.lineWidth = Math.max(3, D * 0.16);
      ctxM.strokeStyle = "rgba(255,255,255,.12)";
      ctxM.beginPath(); ctxM.arc(cx, cy, R0, 0, Math.PI * 2); ctxM.stroke();
      ctxM.save();
      ctxM.strokeStyle = col;
      if(!rm){ ctxM.shadowColor = col; ctxM.shadowBlur = D * 0.5; }
      ctxM.beginPath(); ctxM.arc(cx, cy, R0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - f)); ctxM.stroke();
      ctxM.restore();
      // 字幕
      ctxM.font = "800 " + Math.max(11, Math.round(D * 0.46)) + "px Fredoka, Nunito, system-ui, sans-serif";
      ctxM.fillStyle = "rgba(255,255,255,.88)";
      ctxM.fillText("準備好了嗎?", cx, cy + R0 + D * 0.75);
      // 數字:彈出(回彈)→ 停住 → 最後 18% 縮小淡出
      const s = rm ? 1 : (f < 0.24 ? 0.45 + 0.55 * easeBack(f / 0.24) : (f > 0.82 ? 1 - 0.25 * (f - 0.82) / 0.18 : 1));
      const a = rm ? 1 : (f < 0.1 ? f / 0.1 : (f > 0.82 ? 1 - (f - 0.82) / 0.18 : 1));
      ctxM.globalAlpha = a * veil;
      ctxM.translate(cx, cy + D * 0.12);
      ctxM.scale(s, s);
      bigText(lbl, D * 3.3, col, [shade(col, 0.55), col, shade(col, -0.3)]);
    }else{
      const t = clamp(-left / CD_GO_MS, 0, 1);
      ctxM.globalAlpha = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      if(!rm){
        ctxM.strokeStyle = "rgba(255,255,255,.8)";
        ctxM.lineWidth = D * 0.12 * (1 - t) + 1;
        ctxM.beginPath(); ctxM.arc(cx, cy, D * (1.2 + 4.2 * t), 0, Math.PI * 2); ctxM.stroke();
        const k = 1 - Math.pow(1 - t, 2);
        for(let i = 0; i < 18; i++){
          const ang = i / 18 * Math.PI * 2, dist = D * (0.8 + 4.4 * k);
          ctxM.fillStyle = COL[i % 6];
          ctxM.beginPath();
          ctxM.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, D * 0.16 * (1 - t) + 1, 0, Math.PI * 2);
          ctxM.fill();
        }
      }
      const s = rm ? 1 : 0.6 + 0.5 * easeBack(Math.min(1, t / 0.35));
      ctxM.translate(cx, cy);
      ctxM.scale(s, s);
      bigText(lbl, D * 1.9, "#ffb020", ["#fffbe0", "#ffd93d", "#ff9f1a"]);
    }
    ctxM.restore();
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
    let byW, byH;
    if(spec){
      byW = (box.width / n - 18) / R.COLS;
      byH = (Math.max(60, box.height) - 16) / R.H;
    }else if(foeLayout === "top"){
      /* 上方那一條:高度由 fitBoard 給(stripH),寬度 n 塊平分 */
      byW = ((box.width - 4 - (n - 1) * 10) / n - 6) / R.COLS;
      byH = (stripH - STRIP_PAD) / R.H;
    }else{
      /* ⚠ 寬用 fitBoard 算好的欄寬,不量 .bub-foes 自己(量自己 = 震盪) */
      byW = ((foeColW || FOE_OVER) - 8) / R.COLS;
      byH = ((Math.max(60, box.height) - (n - 1) * 8) / n - 16) / R.H;
    }
    const fd = Math.max(3, Math.floor(Math.min(byW, byH) * 2) / 2);
    if(fd !== foeSpriteFd){ foeSprites.clear(); foeSpriteFd = fd; }
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
            foeBubble(e.ctx, R.cx(par, x, y) * fd, R.cy(y) * fd, fd, v);
          }
      }
      /* 單機直接讀本機飛行狀態；連線讀約 110ms 一次的飛行快照。 */
      const shot = f.st ? f.st.shot : f.shot;
      if(shot && !dead){
        const sx = shot.x * fd, sy = shot.y * fd;
        foeBubble(e.ctx, sx, sy, fd, shot.c);
        e.ctx.strokeStyle = "rgba(255,255,255,.85)";
        e.ctx.lineWidth = Math.max(1, fd * 0.13);
        e.ctx.beginPath(); e.ctx.arc(sx, sy, Math.max(2, fd * 0.47), 0, Math.PI * 2);
        e.ctx.stroke();
      }
      if(f.fx && f.fx.t < 230 && !reduced()){
        const k = f.fx.t / 230;
        e.ctx.save(); e.ctx.globalAlpha = 1 - k;
        e.ctx.strokeStyle = "#fff";
        e.ctx.lineWidth = Math.max(1, fd * 0.15);
        for(const p of f.fx.pops){
          e.ctx.beginPath();
          e.ctx.arc(R.cx(f.fx.par, p[0], p[1]) * fd, R.cy(p[1]) * fd,
                    fd * (0.48 + k * 0.45), 0, Math.PI * 2);
          e.ctx.stroke();
        }
        e.ctx.restore();
      }
      /* 發射器的方向:「他在瞄哪裡」是看對手的樂趣(ai.js 紅線 ③ 慢慢轉的理由) */
      if(!dead){
        const lx = R.LX * fd, ly = R.LY * fd;
        if(f.mem && f.lv && !shot){
          const progress = clamp(f.mem.t / (60000 / Math.max(6, f.lv.spm)), 0, 1);
          e.ctx.strokeStyle = "rgba(255,217,61,.9)";
          e.ctx.lineWidth = Math.max(1, fd * 0.14);
          e.ctx.beginPath();
          e.ctx.arc(lx, ly, fd * 0.68, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
          e.ctx.stroke();
        }
        e.ctx.strokeStyle = "rgba(255,255,255,.7)";
        e.ctx.lineWidth = Math.max(1, fd * 0.14);
        e.ctx.beginPath(); e.ctx.moveTo(lx, ly);
        e.ctx.lineTo(lx + Math.sin(aimA) * fd * 1.6, ly - Math.cos(aimA) * fd * 1.6); e.ctx.stroke();
        if(cur) foeBubble(e.ctx, lx, ly, fd, cur);
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
  /* 端點可以是元素(對手小盤的 canvas)或 "ceil" / "gun"(我自己盤面的天花板 / 砲口)。
     ⚠ txtAt = 文字貼在哪一端:**一律貼在對手那一端** —— 以前跟著光束頭走,
       進攻的那一道會把「+2 排」整行壓在我自己的盤面正中央。 */
  function beam(fromEl, toEl, col, txt, txtAt){
    if(!elPlay || reduced()) return;
    const base = elPlay.getBoundingClientRect();
    const pt = el => {
      if(!el) return null;
      if(el === "ceil" || el === "gun"){
        if(!cvMain) return null;
        const r = cvMain.getBoundingClientRect(), k = r.width / (R.COLS * D) || 1;
        const y = (el === "ceil") ? CEIL * D * 0.5 : (CEIL + R.LY - 0.6) * D;
        return { x: r.left - base.left + r.width / 2, y: r.top - base.top + y * k };
      }
      const r = el.getBoundingClientRect();
      return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
    };
    const a = pt(fromEl), b = pt(toEl);
    if(!a || !b) return;
    fx.beams.push({ a: a, b: b, c: col || "#ff9f43", t: 0, dur: 420, txt: txt || "", at: txtAt || "b" });
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
        const p = (m.at === "a") ? m.a : m.b;
        /* 貼在端點旁邊,但不可以超出對局區(右側小盤那一端的字會被切掉一半) */
        ctxF.shadowBlur = 0;
        ctxF.font = "800 14px Fredoka, Nunito, sans-serif";
        const half = ctxF.measureText(m.txt).width / 2 + 4;
        const x = clamp(p.x, half, W - half), y = Math.max(14, p.y - 14);
        ctxF.textAlign = "center";
        ctxF.lineWidth = 4; ctxF.strokeStyle = "rgba(0,0,0,.6)";
        ctxF.strokeText(m.txt, x, y);
        ctxF.fillStyle = m.c; ctxF.fillText(m.txt, x, y);
      }
      ctxF.restore();
    }
  }
  function beamOut(i, n, revenge){
    const e = foeEls[i];
    if(e) beam("gun", e.cv, revenge ? "#ff5d6c" : "#ffd93d", (revenge ? "反擊 +" : "+") + n + " 排", "b");
  }
  function beamIn(i, n, who){
    const e = foeEls[i];
    if(e) beam(e.cv, "ceil", "#ff5d6c", (who ? who + " " : "") + "+" + n + " 排", "a");
    incoming(n);
  }
  function beamShield(i, who){
    const e = foeEls[i];
    if(e) beam(e.cv, "ceil", "#48dbfb", (who ? who + " " : "") + "🛡️ 抵擋", "a");
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
    guideCache = null;
    if(ev.x >= 0) fx.impact = { x: R.cx(parBefore, ev.x, ev.y), y: R.cy(ev.y), c: ev.c, t: 0 };
    if(ev.pops.length){
      ev.pops.forEach(p => fx.pops.push({ x: R.cx(parBefore, p[0], p[1]), y: R.cy(p[1]), c: p[2], t: 0 }));
      ev.drops.forEach(p => fx.drops.push({ x: R.cx(parBefore, p[0], p[1]), y: R.cy(p[1]), c: p[2],
                                            vy: -0.002 - Math.random() * 0.004, vx: (Math.random() - 0.5) * 0.004, t: 0 }));
      const n = ev.pops.length + ev.drops.length;
      /* 碎片:每顆 5 片,整批上限 90(一次消一大串時不要把手機的幀數拖垮) */
      if(!reduced()){
        ev.pops.forEach(p => {
          const px = R.cx(parBefore, p[0], p[1]), py = R.cy(p[1]);
          for(let j = 0; j < 5 && fx.sparks.length < 90; j++){
            const a = Math.random() * Math.PI * 2, v = 0.0022 + Math.random() * 0.003;
            fx.sparks.push({ x: px, y: py, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.0012,
                             c: p[2], t: 0, life: 360 + Math.random() * 220 });
          }
        });
      }
      /* 落點冒一個「+N」—— 打掉幾顆一眼看得到(掉落的顆數也算在裡面) */
      if(ev.x >= 0){
        fx.floats.push({ txt: "+" + n, x: R.cx(parBefore, ev.x, ev.y), y: R.cy(ev.y) - 0.3,
                         c: ev.drops.length ? "#ffd93d" : "#fff", size: n >= 8 ? 0.62 : 0.46, t: 0, dur: 820 });
        if(fx.floats.length > 4) fx.floats.shift();
      }
      T(560 + Math.min(8, n) * 70, { type: "triangle", dur: 0.12, vol: 0.18, slideTo: 900 + Math.min(8, n) * 120 });
      if(ev.drops.length >= 4){ shake(5); word("掉了 " + ev.drops.length + " 顆!", "#ffd93d", 0.78); }
      else shake(1.5);
      if(ev.combo >= 3) word("連消 ×" + ev.combo, "#2fd6e4", 0.6);
      if(ev.pc){ word("全清!", "#3ddc7f", 0.9); shake(7); }
      if(ev.drops.length >= 4 || n >= 8 || ev.pc || ev.combo >= 3) BG("hit");   // 配樂在下一拍補一段過門
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
    /* ⚠ 天花板那 CEIL 顆要加回來(畫面往下推了,規則座標沒動) */
    const lx = r.left + R.LX * D * k, ly = r.top + (CEIL + R.LY) * D * k;
    const dx = cx - lx, dy = ly - cy;
    return { a: Math.atan2(dx, Math.max(0.001, dy)), cancel: dy < D * 0.35 * k };
  }
  function onNext(cx, cy){
    const r = cvMain.getBoundingClientRect();
    const k = r.width / (R.COLS * D) || 1;
    const n = nextPos();
    const dx = cx - (r.left + n.x * k), dy = cy - (r.top + (n.y + CEIL * D) * k);
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
    if(running) bgmFeed();              // ⚠ 死了也要餵(K.O. 賽復活要靠它看到 dead 由真轉假)
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
    if(fx.impact){ fx.impact.t += dt; if(fx.impact.t >= 170) fx.impact = null; }
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
    for(let i = fx.sparks.length - 1; i >= 0; i--){
      const p = fx.sparks[i];
      p.t += dt;
      if(p.t >= p.life){ fx.sparks.splice(i, 1); continue; }
      p.vy += 0.000012 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for(let i = fx.floats.length - 1; i >= 0; i--){ fx.floats[i].t += dt; if(fx.floats[i].t >= fx.floats[i].dur) fx.floats.splice(i, 1); }
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
    guideCache = null;
    fx.pops.length = 0; fx.drops.length = 0; fx.words.length = 0; fx.beams.length = 0;
    fx.sparks.length = 0; fx.floats.length = 0;
    fx.push = null; fx.shake = 0; fx.hit = 0;
    fx.impact = null;
    countdown(null);                    // ⚠ 新的一局不可以沿用上一局的倒數(要的話 setState 之後再給)
    allUp();
    fitBoard();
    BG("round");
  }
  function play(){ running = true; lastT = performance.now(); allUp(); BG("go"); }
  function pause(){ running = false; allUp(); BG("hold"); }
  function stop(){ running = false; countdown(null); allUp(); BG("end"); }

  return {
    mount, setState, play, pause, stop, wake, sleep, fitBoard, draw,
    act, setAim, incoming, pop, shake,
    setFoes, foeAt, beamOut, beamIn, beamShield, beamFoe, foes: () => foes,
    cast, clearCast, countdown,
    /* 倒數現在畫的是什麼("3" / "2" / "1" / "開始!" / "")—— 測試用,產品程式不讀它 */
    cdShown: () => cdLast,
    /* ★ 測試用的出口(產品程式不會呼叫):step(dt) 手動推一幀、frames()、awake()、
       aimPoint(x,y) = 螢幕座標換算成瞄準角(e2e 驗「瞄準 + 發射」那一整條路用) */
    step: frame,
    frames: () => frameN,
    awake: () => !!raf,
    state: () => st,
    cell: () => D,
    /* 天花板那一條佔幾顆高(畫面座標 = 規則座標往下推 CEIL*D)、小盤現在擺在哪裡 */
    ceil: () => CEIL,
    foeLayout: () => foeLayout,
    aimPoint: (cx, cy) => aimFromPoint(cx, cy),
    COL
  };
})();

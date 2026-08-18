"use strict";

/* ============================================================================
   五子棋 — 棋盤引擎(渲染 / 縮放平移手勢 / 勝負判定)
   對外只暴露 GB;不依賴 Firebase,也不依賴 net.js(可單獨在瀏覽器裡驗證)。

   設計要點:
   • 棋盤尺寸「固定 px」(n × CELL),所有縮放都靠 .gmk-canvas 的 transform:scale()
     → 不觸發 reflow,手機拖曳/縮放才順。
   • 格線用 CSS background-image 畫(見 styles.css 的 .gmk-board),零 DOM;
     棋子是 absolute 定位的 div,落子只 append 一顆,不整盤重畫。
   • index.html 的 viewport 設了 user-scalable=no(五子棋頁沿用),原生 pinch 不可用
     → 單指拖曳、雙指縮放、點擊落子全部自己用 Pointer Events 實作。

   ⚠ $ 定義在 js/shared/ui-kit.js(一律最先載入),本檔不可再宣告一次 —— 同一詞法作用域
     重複宣告 const 會整頁 SyntaxError。要單獨驗證棋盤時,測試頁記得也載入 ui-kit.js。
   ========================================================================== */

const GB = (function(){
  const CELL = 40;               // 每格固定 40px(視覺大小由 z 決定)
  const ZMAX = 3;                // 最大放大倍率
  const TAP_SLOP = 8;            // 位移小於這個距離才算「點擊」而非拖曳
  const TAP_MS = 600;            // 按住超過這個時間就不算點擊
  const DIRS = [[1,0],[0,1],[1,1],[1,-1]];   // 橫 / 豎 / 右下 / 右上

  let n = 15;                    // 盤面邊長
  let occ = [];                  // idx -> "b" | "w" | null
  let moves = [];                // 有序落子索引
  let stones = [];               // idx -> stone element | null
  let lastEl = null;             // 目前帶「最後一手」標記的棋子

  let z = 1, tx = 0, ty = 0, fitZ = 1;
  let stage, canvas, board, ghost, aim;
  let beamEl = null;             // 五連珠那道金色光柱(只有終局才有,reset 要清)
  let bulk = false;              // ★ 整盤重建中 —— 別在每一顆棋上都重掃一次「四」(見 syncThreats)
  let fours = [];                // 目前被標成「四」的棋子索引(給 e2e / 重畫用)
  let won = false;               // ★ 這一局已經分出勝負 —— 「四」的警示從此收掉(見 markWin)
  let tapCb = null;
  let canPlay = false, myColor = "b";   // 由 net.js 用 setInteractive() 告知

  /* ---------- 建立 / 重設 ---------- */
  function init(){
    stage = $("gmkStage"); canvas = $("gmkCanvas"); board = $("gmkBoard"); ghost = $("gmkGhost");
    aim = $("gmkAim");
    if(!stage || !board) return;
    bindGestures();
    // 舞台大小改變(轉向、鍵盤、房間橫幅高度變化)→ 重算 fit;原本就在 fit 狀態的話跟著貼合
    if(typeof ResizeObserver !== "undefined"){
      new ResizeObserver(()=>{ const wasFit = Math.abs(z - fitZ) < 0.001; computeFit(); if(wasFit) fit(); else { clampPan(); applyT(); } }).observe(stage);
    }
    setSize(n);
  }
  function setSize(nn){
    if(!(nn >= 9 && nn <= 29)) return;
    n = nn;
    board.style.setProperty("--n", String(n));
    board.style.setProperty("--gcell", CELL + "px");
    reset();
    buildStars();
    computeFit(); fit();
  }
  function reset(){
    occ = new Array(n*n).fill(null);
    moves = []; stones = new Array(n*n).fill(null);
    lastEl = null;
    // 只清棋子與勝利標記,保留星位與 ghost
    [...board.querySelectorAll(".gmk-stone")].forEach(el=>el.remove());
    /* ★ v2.4.4 新增的三樣裝飾也要在這裡收乾淨 —— 棋子是 remove 掉的所以 .gmk-four
       跟著不見,但光柱是**獨立節點**、準星是**常駐節點**,漏收的下場是
       「上一局的金色光柱留在新局的棋盤上」。 */
    fours = [];
    won = false;
    hideAim();
    if(beamEl){ beamEl.remove(); beamEl = null; }
  }
  // 星位:邊距 3 的四角 + 天元;大盤面(≥17)補成圍棋的九星,大棋盤才有得定位
  function buildStars(){
    [...board.querySelectorAll(".gmk-star")].forEach(el=>el.remove());
    const m = 3, c = (n-1)/2, far = n-1-m;
    const pts = [[m,m],[m,far],[far,m],[far,far]];
    if(Number.isInteger(c)){
      pts.push([c,c]);
      if(n >= 17) pts.push([m,c],[c,m],[c,far],[far,c]);   // 九星
    }
    pts.forEach(([r,cc])=>{
      const d = document.createElement("div");
      d.className = "gmk-star";
      d.style.left = ((cc+0.5)*CELL) + "px";
      d.style.top  = ((r +0.5)*CELL) + "px";
      board.appendChild(d);
    });
  }

  /* ---------- 落子 ---------- */
  function colorOfStep(step){ return step % 2 === 0 ? "b" : "w"; }   // step 由 0 起;偶數步 = 黑(先手)
  function colorAt(i){ return occ[i] || null; }
  function occupied(i){ return !!occ[i]; }
  function lastIndex(){ return moves.length ? moves[moves.length-1] : -1; }
  function stepCount(){ return moves.length; }
  function isFull(){ return moves.length >= n*n; }

  function paintStone(i, color){
    const el = document.createElement("div");
    el.className = "gmk-stone " + color;
    el.style.left = (((i % n) + 0.5) * CELL) + "px";
    el.style.top  = ((Math.floor(i / n) + 0.5) * CELL) + "px";
    board.appendChild(el);
    stones[i] = el;
    return el;
  }
  // 直接落一顆(不檢查輪次,由呼叫端負責);回傳 false = 該點已有子
  function play(i){
    if(!(i >= 0 && i < n*n) || occ[i]) return false;
    const color = colorOfStep(moves.length);
    occ[i] = color; moves.push(i);
    setLast(paintStone(i, color));
    if(!bulk) syncThreats();
    return true;
  }
  function setLast(el){
    if(lastEl) lastEl.classList.remove("last");
    lastEl = el || null;
    if(lastEl) lastEl.classList.add("last");
  }
  /* 收到遠端快照:能延續就只 append 新的幾顆(便宜、有落子動畫),
     否則整盤重建(重連 / 中途加入 / 對手悔棋等情況)。回傳新增的索引。 */
  function applyMoves(arr){
    arr = Array.isArray(arr) ? arr : [];
    const extends_ = arr.length >= moves.length && moves.every((v,k)=>arr[k]===v);
    /* ★★ bulk:重建 / 批次補子時把「四」的掃描關掉,收尾統一掃一次。
       ⚠ 不是效能潔癖 —— 一次重連可能補上幾十顆,每一顆都掃一遍整盤(225 個空點 × 4 向)
         等於白算幾十倍;而且**中間那幾拍算出來的「四」是過期的局面**,標了又立刻被蓋掉。
       ⚠⚠ try/finally 不可以省:play() 之中任何一顆丟例外,bulk 卡在 true 之後
         **從此再也不會標「四」**,而且畫面完全正常 → 看起來像這個功能根本沒做。 */
    bulk = true;
    try{
      if(!extends_){
        reset();
        arr.forEach(i=>play(i));
        return { added: arr.slice(), rebuilt: true };
      }
      const added = arr.slice(moves.length);
      added.forEach(i=>play(i));
      return { added, rebuilt: false };
    }finally{
      bulk = false;
      syncThreats();
    }
  }

  /* ---------- 勝負 ---------- */
  // 從最後一手往四個方向數同色連續棋子;≥5 連即勝(長連也算),回傳那條線的索引
  function checkWin(i){
    const color = colorAt(i);
    if(!color) return null;
    const r0 = Math.floor(i/n), c0 = i % n;
    for(const [dc,dr] of DIRS){
      const line = [i];
      for(const s of [1,-1]){
        let r = r0 + dr*s, c = c0 + dc*s;
        while(r>=0 && r<n && c>=0 && c<n && colorAt(r*n+c)===color){ line.push(r*n+c); r += dr*s; c += dc*s; }
      }
      if(line.length >= 5) return line.sort((a,b)=>a-b);
    }
    return null;
  }
  function markWin(line){
    line = line || [];
    /* ★★★ 分出勝負的第一件事:**把「四」的警示全部收掉**(v2.4.4 第二版)。
       ⚠⚠ 這一條是**放大截圖才發現的**:終局那一刻盤上通常有好幾組「四」
         (贏家的五連本身就滿足「再一子成五」,輸家常常也有一組)→ 十幾圈紅色虛線
         **把連五的金光與那道光柱整個蓋掉**,而斷言全綠(它們只數 class 在不在)。
       ★ 而且道理上也對:局結束了,「再一子就成五」對誰都不再是資訊。
       ⚠ 順手鎖住 won —— 重連進一局已經結束的房間時順序是
         applyMoves(→ syncThreats 標上)→ markWin(收掉),鎖了才不會被下一次
         整盤重建又標回來。 */
    won = true;
    fours.forEach(i => { if(stones[i]) stones[i].classList.remove("four"); });
    fours = [];
    /* ★ 依序點亮:延遲 = 「在這條線上排第幾顆」,由 CSS 的 --wi 讀走。
       ⚠ 寫的是自訂屬性不是 transform —— 棋子那一格 transform 是 translate(-50%,-50%)
         加 gmkDrop 在用的,勝利效果一律只動 box-shadow / filter。 */
    line.forEach((i, k) => {
      if(!stones[i]) return;
      stones[i].style.setProperty("--wi", String(k));
      stones[i].classList.add("win");
    });
    drawBeam(line);
  }
  /* ★★ 五連珠的金色光柱:沿著那條線畫一根長條再轉到線的角度。
     ⚠ 它一定要住在 #gmkBoard 裡面(跟著 .gmk-canvas 的 transform 一起縮放)——
       放在舞台上的話一放大就整根脫隊,而且 fit / pan 之後位置全錯。
     ⚠ 長度要多加約一顆棋的直徑:不加的話光柱的兩端剛好切在頭尾兩顆的**圓心**上,
       看起來像沒穿透出去。 */
  function drawBeam(line){
    if(beamEl){ beamEl.remove(); beamEl = null; }
    if(!board || !line || line.length < 2) return;
    const a = line[0], b = line[line.length - 1];
    const ax = ((a % n) + 0.5)*CELL, ay = (Math.floor(a/n) + 0.5)*CELL;
    const bx = ((b % n) + 0.5)*CELL, by = (Math.floor(b/n) + 0.5)*CELL;
    const len = Math.hypot(bx-ax, by-ay) + CELL*0.9;
    const deg = Math.atan2(by-ay, bx-ax) * 180 / Math.PI;
    beamEl = document.createElement("div");
    beamEl.className = "gmk-beam";
    beamEl.style.left = ((ax+bx)/2) + "px";
    beamEl.style.top  = ((ay+by)/2) + "px";
    beamEl.style.width = len + "px";
    beamEl.style.transform = "translate(-50%,-50%) rotate(" + deg.toFixed(2) + "deg)";
    board.appendChild(beamEl);
  }

  /* ==========================================================================
     ★★★ 掃「四」—— 哪一方再下一子就成五(v2.4.4)
     ──────────────────────────────────────────────────────────────────────────
       做法:對**每一個空點**假設落下該色,看會不會連成五。所以「XX_XX」這種
       中間留洞的衝四也抓得到 —— 那正是新手最常漏看的形狀。
     ⚠ 這一支是**純函式**(零 DOM),而且刻意**不去用 ai.js**:紅線 4 說 ai.js 要保持
       純函式,反過來也成立 —— 畫面要的東西不該讓 ai.js 多長一個對外介面
       (那一支是照棋力在調的,多一個介面就多一條會被牽動的線)。
     ⚠⚠ 回的是**那幾顆棋**,刻意**不回那個空點** —— 標空點等於把答案直接畫在盤上;
       建議書要的是「連線上泛起波紋」(警示),不是代替玩家算。
     ★ 成本:225 個空點 × 2 色 × 4 向 × 約 10 步,一手一次,量級上完全不必在意。
     ========================================================================== */
  function scanFour(){
    const out = {};
    for(let e = 0; e < n*n; e++){
      if(occ[e]) continue;
      const r0 = Math.floor(e/n), c0 = e % n;
      for(const color of ["b","w"]){
        for(const [dc,dr] of DIRS){
          const line = [];
          for(const sg of [1,-1]){
            let r = r0 + dr*sg, c = c0 + dc*sg;
            while(r>=0 && r<n && c>=0 && c<n && occ[r*n+c] === color){ line.push(r*n+c); r += dr*sg; c += dc*sg; }
          }
          if(line.length >= 4) line.forEach(i => { out[i] = 1; });
        }
      }
    }
    return Object.keys(out).map(Number);
  }
  /* ⚠ 差集更新,不是「整盤先清掉再重標」:這一頁的棋子是 **append 不重畫**的,
     class 一直留著 → 先移除再加回去會讓那圈警示的 CSS 動畫**每一手重播一次**
     (看起來是「別人下棋時我的警示圈自己抽一下」)。 */
  function syncThreats(){
    if(!board || won) return;
    const next = scanFour(), nset = {};
    next.forEach(i => { nset[i] = 1; });
    fours.forEach(i => { if(!nset[i] && stones[i]) stones[i].classList.remove("four"); });
    next.forEach(i => { if(stones[i]) stones[i].classList.add("four"); });
    fours = next;
  }
  // 座標名稱:欄用 A~,列用 1~(左上為 A1),給 toast 顯示「對手下在 H8」
  function coordName(i){
    if(!(i >= 0 && i < n*n)) return "";
    return String.fromCharCode(65 + (i % n)) + (Math.floor(i/n) + 1);
  }

  /* ---------- 縮放 / 平移 ---------- */
  function boardPx(){ return n * CELL; }
  function applyT(){ canvas.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + z + ")"; }
  function computeFit(){
    const w = stage.clientWidth, h = stage.clientHeight, bp = boardPx();
    if(!w || !h){ fitZ = 1; return; }          // 舞台還沒顯示(hidden)→ 等顯示後 ResizeObserver 會再算
    const pad = 8;                             // 留邊:棋盤木板外緣那圈 3px box-shadow 才不會被舞台 overflow:hidden 裁掉
    fitZ = Math.min((w-pad)/bp, (h-pad)/bp);
  }
  function clampPan(){
    const w = stage.clientWidth, h = stage.clientHeight, bs = boardPx()*z;   // bs:棋盤是正方形,寬高同值
    tx = bs <= w ? (w - bs)/2 : Math.min(0, Math.max(w - bs, tx));           // 塞得進去就居中,否則不讓它拖出視野
    ty = bs <= h ? (h - bs)/2 : Math.min(0, Math.max(h - bs, ty));
  }
  function fit(){ computeFit(); z = fitZ; clampPan(); applyT(); syncZoomBtns(); }
  /* 開局的初始視角。大盤面(19×19 / 25×25)整盤塞進手機時每格只有 18~24px,一開局就要玩家
     自己放大很煩;而開局本來都下在天元附近 → 格子太小就自動放大到 MIN_CELL 並把天元擺中間。
     全盤仍隨時可看(⤢ / 雙指縮小);對手下在視野外時 focusOn() 會自動追過去。 */
  const MIN_CELL = 30;                       // 開局時每格至少這麼大,否則改用放大視角
  const OPEN_CELL = 34;                      // 放大視角下每格的目標大小
  function initialView(){
    computeFit();
    if(CELL*fitZ >= MIN_CELL){ fit(); return; }
    z = Math.max(fitZ, Math.min(ZMAX, OPEN_CELL/CELL));
    const c = (n-1)/2;
    tx = stage.clientWidth/2  - (c+0.5)*CELL*z;
    ty = stage.clientHeight/2 - (c+0.5)*CELL*z;
    clampPan(); applyT(); syncZoomBtns();
  }
  // 以舞台座標 (ax,ay) 為錨縮放到 nz:錨點下的棋盤位置保持不動
  function zoomTo(nz, ax, ay){
    const w = stage.clientWidth, h = stage.clientHeight;
    if(ax == null){ ax = w/2; ay = h/2; }
    nz = Math.max(fitZ, Math.min(ZMAX, nz));
    const bx = (ax - tx)/z, by = (ay - ty)/z;
    z = nz; tx = ax - bx*z; ty = ay - by*z;
    clampPan(); applyT(); syncZoomBtns();
  }
  function zoomIn(){ zoomTo(z*1.45); }
  function zoomOut(){ zoomTo(z/1.45); }
  function syncZoomBtns(){
    const zi = $("gmkZoomIn"), zo = $("gmkZoomOut");
    if(zi) zi.disabled = z >= ZMAX - 0.001;
    if(zo) zo.disabled = z <= fitZ + 0.001;
  }
  // 把某個交叉點帶進畫面:已經看得到就不動視角(不亂搶使用者的視野),看不到才平移置中
  function focusOn(i){
    if(!(i >= 0 && i < n*n)) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    const sx = ((i % n) + 0.5)*CELL*z + tx, sy = (Math.floor(i/n) + 0.5)*CELL*z + ty;
    const pad = Math.max(28, CELL*z*0.8);
    if(sx >= pad && sx <= w-pad && sy >= pad && sy <= h-pad) return;
    tx += w/2 - sx; ty += h/2 - sy;
    clampPan(); applyT();
  }

  /* ---------- 手勢:單指拖曳平移 / 雙指縮放 / 點擊落子 ---------- */
  function idxAt(clientX, clientY){
    const rc = stage.getBoundingClientRect();
    const bx = (clientX - rc.left - tx)/z, by = (clientY - rc.top - ty)/z;
    const c = Math.round(bx/CELL - 0.5), r = Math.round(by/CELL - 0.5);
    if(r < 0 || r >= n || c < 0 || c >= n) return -1;
    return r*n + c;
  }
  function bindGestures(){
    const pts = new Map();          // pointerId -> {x,y}
    let drag = null, movedFar = false, pinch = null;
    const dist = (a,b)=>Math.hypot(a.x-b.x, a.y-b.y);
    const mid  = (a,b)=>({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });

    stage.addEventListener("pointerdown", e=>{
      // 放大/縮小/整盤鈕是 stage 的子元素(疊在右下角),按下時 pointerdown 會冒泡到這裡 →
      // 沒擋掉的話按鈕那個座標會被當成點擊落子。
      if(e.target.closest(".gmk-zoom")) return;
      pts.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if(pts.size === 1){
        drag = { x:e.clientX, y:e.clientY, tx, ty, t:Date.now() };
        movedFar = false;
        showAim(e.clientX, e.clientY);      // ★ 按住就把準星打開(見 showAim 的檔頭)
      }else if(pts.size === 2){
        const [a,b] = [...pts.values()], m = mid(a,b), rc = stage.getBoundingClientRect();
        pinch = { d:dist(a,b), z:z, ax:m.x-rc.left, ay:m.y-rc.top };
        movedFar = true;            // 進入雙指 → 這次手勢不再算點擊
        hideGhost(); hideAim();
      }
    });
    stage.addEventListener("pointermove", e=>{
      if(!pts.has(e.pointerId)){
        if(e.pointerType === "mouse") hoverGhost(e.clientX, e.clientY);   // 桌機:沒按著時顯示預覽子
        return;
      }
      pts.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if(pts.size >= 2 && pinch){
        const [a,b] = [...pts.values()], d = dist(a,b);
        if(pinch.d > 0) zoomTo(pinch.z * (d/pinch.d), pinch.ax, pinch.ay);
        return;
      }
      if(drag){
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if(!movedFar && Math.hypot(dx,dy) > TAP_SLOP){ movedFar = true; stage.classList.add("dragging"); hideGhost(); hideAim(); }
        /* ⚠ 還沒超過 8px 就跟著手指微調準星 —— 手指按在螢幕上本來就會抖一兩 px,
           不更新的話準星停在按下那一點、實際落子卻是放開那一點(兩者可以差一格)。 */
        if(!movedFar) showAim(e.clientX, e.clientY);
        if(movedFar){ tx = drag.tx + dx; ty = drag.ty + dy; clampPan(); applyT(); }
      }
    });
    function endPointer(e, cancelled){
      const was = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if(pts.size < 2) pinch = null;
      if(pts.size === 0){
        stage.classList.remove("dragging");
        hideAim();
        const quick = drag && (Date.now() - drag.t) <= TAP_MS;
        if(!cancelled && was && drag && !movedFar && quick && tapCb){
          const i = idxAt(was.x, was.y);
          if(i >= 0) tapCb(i);
        }
        drag = null; movedFar = false;
      }
    }
    stage.addEventListener("pointerup", e=>endPointer(e,false));
    stage.addEventListener("pointercancel", e=>endPointer(e,true));
    stage.addEventListener("pointerleave", e=>{ if(e.pointerType === "mouse") hideGhost(); });
    // 滑鼠滾輪 = 以指標為錨縮放(桌機)
    stage.addEventListener("wheel", e=>{
      e.preventDefault();
      const rc = stage.getBoundingClientRect();
      zoomTo(z * (e.deltaY < 0 ? 1.12 : 1/1.12), e.clientX-rc.left, e.clientY-rc.top);
    }, { passive:false });
    // 雙擊:放大到 1.5×(已放大則回整盤)
    stage.addEventListener("dblclick", e=>{
      const rc = stage.getBoundingClientRect();
      if(z > fitZ + 0.01) fit();
      else zoomTo(Math.max(1.5, fitZ*2), e.clientX-rc.left, e.clientY-rc.top);
    });
  }
  /* ---------- 桌機的半透明預覽子 ---------- */
  function hoverGhost(cx, cy){
    if(!ghost) return;
    if(!canPlay){ hideGhost(); return; }
    const i = idxAt(cx, cy);
    if(i < 0 || occ[i]){ hideGhost(); return; }
    ghostAt(i);
  }
  function ghostAt(i){
    if(!ghost) return;
    ghost.className = "gmk-ghost show " + myColor;
    ghost.style.background = myColor === "b" ? "#111" : "#fff";
    ghost.style.left = (((i % n) + 0.5)*CELL) + "px";
    ghost.style.top  = ((Math.floor(i/n) + 0.5)*CELL) + "px";
  }
  function hideGhost(){ if(ghost) ghost.classList.remove("show"); }

  /* ==========================================================================
     ★★★ 落子準星(v2.4.4)—— 建議書的「放大鏡」在這一頁換成**貫穿棋盤的十字線**
     ──────────────────────────────────────────────────────────────────────────
       建議書寫的是「手指按住棋盤**滑動**時浮現放大鏡」。那個做不到:
       **按住滑動已經被單指平移佔走了**(TAP_SLOP 8px 一過就進入平移,而那是這一頁
       在手機上唯一的移動方式)—— 要拿滑動來瞄準就得多一個模式開關。
     ★ 改成十字線之後三件事同時成立,而且**一個新手勢都不必加**:
       ① 「我瞄到哪一列哪一行」被畫到**盤外**,手指蓋住交叉點照樣讀得到;
       ② 按住看得到 → **放開才落子**,而放開落子**本來就是既有行為**(紅線 5:這一頁走 pointerup);
       ③ 瞄錯就把手指滑開 —— 超過 8px 就變成平移,那一下**不會落子**,等於天然的取消。
     ⚠ 只在「現在真的能下」而且那一點是空的時候顯示:不然它會在觀戰 / 對手回合
       給出「這裡可以下」的假訊號。
     ========================================================================== */
  function showAim(cx, cy){
    if(!aim || !canPlay){ hideAim(); return; }
    const i = idxAt(cx, cy);
    if(i < 0 || occ[i]){ hideAim(); return; }
    aim.style.setProperty("--ax", (((i % n) + 0.5)*CELL) + "px");
    aim.style.setProperty("--ay", ((Math.floor(i/n) + 0.5)*CELL) + "px");
    aim.classList.add("show");
    ghostAt(i);
    return i;
  }
  function hideAim(){ if(aim) aim.classList.remove("show"); }

  /* ---------- 對外 ---------- */
  function onTap(cb){ tapCb = cb; }
  // 由 net.js 告知「現在能不能下、我是什麼顏色」;只影響預覽子與游標,能不能下最終仍由 tap 回呼判定
  function setInteractive(ok, color){
    canPlay = !!ok;
    if(color === "b" || color === "w") myColor = color;
    if(!canPlay) hideGhost();
  }

  return {
    init, setSize, size:()=>n, reset, play, applyMoves,
    moves:()=>moves.slice(), stepCount, occupied, colorAt, colorOfStep, lastIndex, isFull,
    checkWin, markWin, coordName,
    fit, initialView, zoomIn, zoomOut, focusOn, onTap, setInteractive,
    setLastByIndex(i){ setLast(stones[i] || null); },
    /* 給 e2e / 診斷頁:目前被標成「四」的棋子(★ 純資料,不是 DOM 查詢)。
       ⚠ 回複本 —— 回本體的話呼叫端一改就把內部狀態改掉了(差集更新會從此對不上)。 */
    _fours: () => fours.slice(),
    /* 給 e2e:直接問「這個局面有哪幾顆在四上」(不必經過畫面) */
    _scanFour: scanFour,
    /* 給診斷頁:目前的縮放倍率(木紋 / 浮雕格線放大了才看得出來是不是條碼) */
    _z: () => z
  };
})();

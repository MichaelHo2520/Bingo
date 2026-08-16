"use strict";

/* ============================================================================
   跳棋 — 盤面(TQB)

   單機與連線**共用這一支**:盤面自己不知道現在是哪一種模式,兩個回呼由 main.js
   分流(同飛行棋 FCB / 排七 SVB 的做法)。

   ── ★ 盤面尺寸用 JS 算,不用 aspect-ratio ────────────────────────────────
     比照暗棋 / 成語接龍 / 飛行棋。⚠ 這一頁的外接框**不是正方形**:
     13 個間距寬 × 14.856 個間距高(見 rules.js 的 BOARD_W / BOARD_H)——
     所以 fitBoard() 要對寬高各除一次再取小的,不可以照抄飛行棋的 min(w,h)/14。
     ⚠⚠ v1.180.2 起**盤面框不再等於 rules.js 的 BOARD_W / BOARD_H**:外面多了一圈
       六邊形木框(見下一段的 TRAY_W / TRAY_H)。要洞的位置一律 posXY() **再加 OX / OY**,
       不可以直接拿 posXY() 當畫面座標(那會整個盤面往左上偏 0.3 / 0.6 格)。

   ── ★★ 木框為什麼是「六邊形」而且只多花 6% 寬 ────────────────────────────
     六角星的**凸包**就是一個正六邊形,而且那個六邊形的六個頂點正好一個對著一個星尖 ——
     所以「把星包起來」的最小六邊形不必比星胖,只要沿半徑往外推 RIM 格就好。
     ⚠ 這一點很反直覺,值得寫下來:直覺會挑「上下平、左右尖」的那一種擺法
       (參考圖乍看像那樣),但那一種要**多 33% 的寬**才包得住同一顆星 ——
       而這一頁在直向手機上正是被寬度卡住的(紅線 14)→ 等於棋子直接小四分之一。
       正確的是「上下尖、左右平」:寬高各只多 6~7%。

   ── ★★★ 動畫是「t 的函式」,不是一條回呼鏈 ────────────────────────────────
     **這一頁與飛行棋最大的結構差別,而且是刻意的。**

     飛行棋的走子動畫是 later(g, next, ms) 一節一節串起來的,而「能不能繼續操作」
     (busy)掛在最後一節的 onDone 上 —— 那條鏈斷在任何一節,整台棋局就停擺。
     線上實測連續兩次栽在這裡(v1.179.2 / v1.179.6),而跳棋的連跳鏈是 6~8 段
     (飛行棋最多 3 段)→ 同樣的結構在這裡只會更常斷。

     這一支改成:
       ① render() **先把每顆棋落到真相位置**(無 transition)——
          **動畫一步都沒跑,畫面也已經是對的**。
       ② 動畫只是「暫時把飛行中的那一顆拉回路徑上的插值位置」,位置 = f(now)。
       ③ 被打斷 / 分頁凍結 / rAF 一次都沒觸發 → 下一次 render 直接覆蓋,不留殘骸。
     ⚠⚠ **所以這一支不提供 onDone。** 呼叫端要「演完再做下一件事」就自己
       `setTimeout(…, TQB.animMs(path))` —— 讓「回呼被吞掉」這件事在結構上不存在。
       (adapter 完全不需要等動畫:能不能操作只問真相層,見 adapter.js 第三條。)

   ── ★ 六色是規則本體(同 UNO / 飛行棋)──────────────────────────────────
     六個角各一色,而「我要往哪走」就是看對面那一角的顏色 ——
     **任何主題都不准把它轉成黑白**,所以 --tq-c0..5 刻意不吃主題變數。
     色盲的第二訊號是棋子上的**座號數字**(.tq-pn),不要順手拿掉。
   ========================================================================== */

const TQB = (function(){

  const R = TQ;
  const CELL_MIN = 16;                 // 再小就點不到了(洞只有 0.72 格)
  const CELL_MAX = 54;

  /* ---------- 木托盤的幾何(v1.180.2)----------
     R_STAR = 星的外接圓半徑(格)。星的六個尖角都落在這個圓上 ——
     ⚠ 直接由 BOARD_H 反推(高 = 上下兩個尖角 + 各半個洞),不要另外寫一個常數:
       改了 rules.js 的 TIP 之後這裡要自己跟著對。 */
  const RIM = 1.05;                    // 星尖外面留幾格木頭
  const R_STAR = (R.BOARD_H - 1) / 2;  // 6.928
  const R_HEX = R_STAR + RIM;
  const TRAY_W = R_HEX * Math.sqrt(3); // 上下尖的正六邊形:寬 = √3 R、高 = 2R
  const TRAY_H = R_HEX * 2;
  const OX = TRAY_W / 2 - R.BOARD_W / 2;   // 洞座標要往右下平移多少(格)
  const OY = TRAY_H / 2 - R.BOARD_H / 2;

  const MS_HOP = 150;                  // 一段跳多久
  const MS_STEP = 210;                 // 單步多久(只有一段,慢一點才看得到)

  let board = null, stage = null, acts = null;
  let cb = { onHole: null, onPiece: null };
  let built = false, cell = 0;
  let fitW = 0, fitH = 0;              // 上一次「真的拿來算過」的舞台尺寸(死區用,見 fitBoard)
  let pieceEls = [];                   // pieceEls[seat][i]
  let holeEls = [];                    // holeEls[id]
  let shownKey = "";                   // 上一次畫的「幾家幾顆」(換局才重建棋子)
  let lastPaint = null;                // 上一次畫出來的 pieces(給 e2e 對帳用)

  /* 飛行中的那一顆。★ 它**只影響畫面**:真相位置已經在 render() 裡落定了。 */
  let flight = null;                   // { el, path, startAt, dur, seg }
  let rafId = 0;

  /* 這一頁的音效。★ 走 Sound.tone()(audio.js 開給各遊戲寫自己樂句的入口)。
     ⚠ 連跳一段一聲,而且**音高隨段數往上爬** —— 跳得越長越爽,那是這個遊戲的核心快感。 */
  const SFX = {
    hop(k){ T(520 + Math.min(k, 9) * 62, { type: "triangle", dur: 0.085, vol: 0.13 }); },
    step(){ T(430, { type: "sine", dur: 0.10, vol: 0.11 }); },
    pick(){ T(760, { type: "sine", dur: 0.05, vol: 0.09 }); },
    land(){ T(880, { type: "sine", dur: 0.14, vol: 0.13, slideTo: 1180 }); },
    home(){ [659, 880, 1175].forEach((f, i) => T(f, { type: "sine", dur: 0.18, vol: 0.20, delay: i * 0.07 })); }
  };
  function T(f, o){ if(typeof Sound !== "undefined" && Sound.tone) Sound.tone(f, o); }

  /* ==========================================================================
     一、建盤面(只做一次)
     ──────────────────────────────────────────────────────────────────────────
       121 個洞是絕對定位的 div,座標一律問 rules.js 的 posXY() —— 這一支不自己
       算任何洞的位置(規則與畫面脫鉤)。
       ⚠⚠ posXY() 回的是**洞的中心**(與飛行棋相反,那一頁回左上角並因此偏過半格)
         → 這裡一律減半個洞再當 left/top。
     ========================================================================== */
  const HOLE_R = 0.36;                 // 洞的半徑(單位:格)
  const PC_R = 0.40;                   // 棋子的半徑

  function at(cx, cy, rad){
    return 'style="left:calc(var(--tq-cell) * ' + (cx + OX - rad) + ');' +
                  'top:calc(var(--tq-cell) * ' + (cy + OY - rad) + ');' +
                  'width:calc(var(--tq-cell) * ' + (rad * 2) + ');' +
                  'height:calc(var(--tq-cell) * ' + (rad * 2) + ')"';
  }

  /* ==========================================================================
     一之一、★ 木托盤(v1.180.2)—— 一張 SVG,建盤面時畫一次就不再動
     ──────────────────────────────────────────────────────────────────────────
       四層由外而內:六邊形木板 → 金色內框 → 六角星凹槽 → 三角格線。

     ★★ **一個座標都不是手打的**,全部問 rules.js:
       ① 星的輪廓 = 12 個**真的洞**(六個角的尖端 + 中央六邊形的六個頂點),
          走 idAt()/posXY() 拿 —— 所以 rules.js 的幾何改了它自己會跟著對。
       ② 三角格線 = 對每個洞取 NB[id] 的 0(右)/ 1(右上)/ 5(右下) 三個方向各連一條,
          **每條邊剛好被畫一次**(從左端點畫出去),而且只畫得出「真的有洞」的地方
          → 星形是格線自己長出來的,不是裁出來的。
       ⚠ 這正是紅線「不要用 clip-path 去切一個星」的正解:那樣切會讓尖角的洞貼在裁切邊上。

     ★ 凹槽用「fill + stroke + stroke-linejoin:round」而不是再算一次外擴多邊形 ——
       同一條路徑加一圈 PAN_W/2 格的圓角描邊,等距外擴而且六個尖角自動變圓。
     ⚠ 顏色一律走 CSS(class + var),這裡只產生形狀:改配色不必動 JS。
     ========================================================================== */
  const PAN_W = 1.00;                  // 星形凹槽的外擴描邊(= 往外 0.5 格)
  /* 星的 12 個頂點(立方座標的 x,z),順時針,從最上面那個尖角開始。
     ⚠ 順序不可以亂:亂了就是自己穿過自己的星。 */
  const HULL_XZ = [[4,-8],[4,-4],[8,-4],[4,0],[4,4],[0,4],[-4,8],[-4,4],[-8,4],[-4,0],[-4,-4],[0,-4]];

  function f3(n){ return (Math.round(n * 1000) / 1000); }

  function hullPath(){
    let d = "";
    HULL_XZ.forEach((v, i) => {
      const p = R.posXY(R.idAt(v[0], v[1]));
      d += (i ? "L" : "M") + f3(p.x + OX) + " " + f3(p.y + OY);
    });
    return d + "Z";
  }
  function hexPoints(shrink){
    const cx = TRAY_W / 2, cy = TRAY_H / 2, r = R_HEX - shrink, s = r * Math.sqrt(3) / 2;
    return [[cx, cy - r], [cx + s, cy - r / 2], [cx + s, cy + r / 2],
            [cx, cy + r], [cx - s, cy + r / 2], [cx - s, cy - r / 2]]
           .map(p => f3(p[0]) + "," + f3(p[1])).join(" ");
  }
  function gridPath(){
    let d = "";
    for(let id = 0; id < R.N_HOLES; id++){
      const a = R.posXY(id);
      [0, 1, 5].forEach(k => {
        const j = R.NB[id][k];
        if(j < 0) return;
        const b = R.posXY(j);
        d += "M" + f3(a.x + OX) + " " + f3(a.y + OY) + "L" + f3(b.x + OX) + " " + f3(b.y + OY);
      });
    }
    return d;
  }
  /* ⚠ SVG 的 fill 吃不到 CSS 漸層 → 木紋與凹槽的漸層只能寫成 <defs>。
       色票仍然留在 CSS(stop-color 吃 var()),這裡只排「哪一段接哪一段」。
     ⚠⚠ id 是**整份文件共用的命名空間**,一律加 tq 前綴(同 CSS 前綴那條紅線的道理)。 */
  function defsHTML(){
    /* 木紋。★ 三件事一起才像木頭,少一件就像拉絲金屬(第一版)或斑馬(第二版):
         ① **不等距** —— 等距的條紋眼睛一眼認出是程式畫的
         ② **低對比** —— 亮暗差交給下面那層 shade,這一層只負責紋理
         ③ **偶爾一條深的** —— 木頭的年輪線,間隔比淺紋大得多
       ⚠ 漸層軸接近**垂直**(x2 小、y2 = 1)→ 紋路是接近水平的,那才是一塊桌板;
         接近水平的軸會畫出直條,看起來像柵欄。
       ⚠ 明暗另外疊一層 tq-tray-shade:混在同一條漸層裡就再也分不開調了。 */
    const GRAIN = [[0,2],[4,1],[8,2],[13,1],[17,2],[19,3],[21,2],[26,1],[31,2],[35,1],
                   [38,2],[41,3],[43,2],[48,1],[53,2],[57,1],[61,2],[65,3],[67,2],
                   [72,1],[77,2],[81,1],[85,2],[89,3],[91,2],[95,1],[100,2]];
    let wood = "";
    GRAIN.forEach(g => {
      wood += '<stop offset="' + g[0] + '%" stop-color="var(--tq-wood-' + g[1] + ')"/>';
    });
    return "<defs>" +
             '<linearGradient id="tqWoodG" x1="0.14" y1="0" x2="0" y2="1">' + wood + "</linearGradient>" +
             '<linearGradient id="tqShadeG" x1="0.2" y1="0" x2="0.8" y2="1">' +
               '<stop offset="0%" stop-color="rgba(255,255,255,.20)"/>' +
               '<stop offset="42%" stop-color="rgba(255,255,255,.02)"/>' +
               '<stop offset="100%" stop-color="rgba(0,0,0,.32)"/>' +
             "</linearGradient>" +
             '<radialGradient id="tqPanG" cx="50%" cy="44%" r="62%">' +
               '<stop offset="0%" stop-color="var(--tq-pan-1)"/>' +
               '<stop offset="100%" stop-color="var(--tq-pan-2)"/>' +
             "</radialGradient>" +
           "</defs>";
  }

  /* ★ 六個角的淡色三角面板 —— 「誰的家在哪」在六色局裡是最常被問的一件事,
     光靠 60 個洞的淺色底(--cs)在米色凹槽上讀不出來。
     ⚠ 三個頂點一律從 CORNER_HOLES 取:尖端 = [0],底邊 = 最後那一列(索引 6..9)的兩端 ——
       ⚠⚠ 取兩端要**自己比 x**,不可以假設那一列在陣列裡是由左到右排的。 */
  function homePanels(){
    let h = "";
    for(let c = 0; c < 6; c++){
      const list = R.CORNER_HOLES[c];
      if(!list || list.length < 10) continue;
      const row = list.slice(6, 10).map(id => R.posXY(id));
      let a = row[0], b = row[0];
      row.forEach(p => { if(p.x < a.x) a = p; if(p.x > b.x) b = p; });
      const t = R.posXY(list[0]);
      h += '<polygon class="tq-tray-home" data-c="' + c + '" points="' +
           [t, a, b].map(p => f3(p.x + OX) + "," + f3(p.y + OY)).join(" ") + '"/>';
    }
    return h;
  }

  function trayHTML(){
    const star = hullPath();
    return '<svg class="tq-tray" viewBox="0 0 ' + f3(TRAY_W) + " " + f3(TRAY_H) + '" aria-hidden="true">' +
             defsHTML() +
             '<polygon class="tq-tray-wood" points="' + hexPoints(0) + '"/>' +
             '<polygon class="tq-tray-shade" points="' + hexPoints(0) + '"/>' +
             '<polygon class="tq-tray-gold" points="' + hexPoints(0.30) + '"/>' +
             '<polygon class="tq-tray-gold2" points="' + hexPoints(0.50) + '"/>' +
             '<path class="tq-tray-lip" d="' + star + '" stroke-width="' + f3(PAN_W + 0.20) + '"/>' +
             '<path class="tq-tray-pan" d="' + star + '" stroke-width="' + PAN_W + '"/>' +
             homePanels() +
             '<path class="tq-tray-grid" d="' + gridPath() + '"/>' +
           "</svg>";
  }

  function build(){
    if(built || !board) return;
    /* ⚠ 托盤一定要排在最前面:洞與棋子都是 position:absolute,繪製順序按 DOM ——
       排到後面就會把 121 個洞整個蓋掉(而且它 pointer-events:none,看起來像點不到)。 */
    let h = trayHTML();
    for(let id = 0; id < R.N_HOLES; id++){
      const p = R.posXY(id), c = R.cornerOf(id);
      h += '<button type="button" class="tq-hole" data-id="' + id + '"' +
           (c >= 0 ? ' data-c="' + c + '"' : "") + " " + at(p.x, p.y, HOLE_R) + "></button>";
    }
    board.innerHTML = h;
    holeEls = [];
    for(let id = 0; id < R.N_HOLES; id++) holeEls.push(board.querySelector('.tq-hole[data-id="' + id + '"]'));
    built = true;
  }

  /* ==========================================================================
     二、尺寸
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 只在「真的要換尺寸」時才寫 DOM —— 每次 render 都寫一次會讓正在跑的
         動畫抖一下(而且是每一幀)。
     ========================================================================== */
  function fitBoard(){
    if(!board || !stage) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    if(w <= 0) return;
    /* ★★★ 死區(v1.180.2,使用者:「盤面的縮放一直跳來跳去」)。
       `render()` 每一次都會叫 fitBoard(),而 render 每一手、外加每 3 秒的對帳心跳都會跑 ——
       所以舞台只要抖一兩個 px,盤面就會**在對局中途自己跳一階**(一階 ≈ 14px 寬)。
       抖動的來源不只一個,而且都是「一行字」等級的小事:
         · 提示列的字數(已經在 CSS 那邊把 .tq-acts 改成固定高了,那是治本的一半)
         · ⚠ 舞台是 overflow:auto —— 盤面剛好差一點點放不下時會冒出捲軸,
           捲軸吃掉 15px 寬 → 盤面縮一階 → 放得下了 → 捲軸消失 → 又放大…
           **這一條會自己震盪下去**,而且只在桌機(有實體捲軸)看得到。
       ⚠ 判準是「量到的可用空間有沒有真的變」,不是「算出來的格子有沒有變」——
         後者在邊界上照樣會 ±1 跳個不停。
       ★ 真的 resize(轉向 / 摺疊機展開)一定遠大於 3px,擋不到。 */
    if(cell && Math.abs(w - fitW) < 3 && Math.abs(h - fitH) < 3) return;
    fitW = w; fitH = h;
    // 高度量不到(還沒排版完)就先只吃寬度,resize 會再叫一次
    // ⚠ 除的是**托盤**的外框(含木邊),不是 rules.js 的 BOARD_W / BOARD_H
    const byW = w / TRAY_W;
    const byH = h > 40 ? h / TRAY_H : Infinity;
    let c = Math.floor(Math.min(byW, byH));
    if(c < CELL_MIN) c = CELL_MIN;
    if(c > CELL_MAX) c = CELL_MAX;
    if(c === cell) return;
    cell = c;
    board.style.setProperty("--tq-cell", c + "px");
    /* ⚠ 托盤的寬高都不是整數格 —— 這裡刻意**兩個都不取整**:
       取整之後盤面框的中心會與 121 個洞的幾何中心差半個像素,
       而診斷頁的 ctrOff 就是拿這兩個比的(它該是 0,0)。
       ⚠⚠ v1.180 的寬是整數格(13)所以只有高要小心;v1.180.2 之後**寬也會歪**。
       ★ 一格的邊長仍然是整數(上面的 Math.floor)—— 那一條才是「洞不會糊掉」的關鍵。 */
    board.style.width = (c * TRAY_W).toFixed(2) + "px";
    board.style.height = (c * TRAY_H).toFixed(2) + "px";
    if(lastPaint) placeAll(lastPaint);
  }

  /* ==========================================================================
     三、棋子
     ========================================================================== */
  function ensurePieces(st){
    const key = st.n + ":" + st.pieces[0].length + ":" + st.corners.join("");
    if(shownKey === key) return;
    shownKey = key;
    pieceEls.forEach(row => row.forEach(el => el.remove()));
    pieceEls = [];
    for(let s = 0; s < st.n; s++){
      const row = [];
      for(let i = 0; i < st.pieces[s].length; i++){
        const el = document.createElement("div");
        el.className = "tq-pc";
        el.dataset.c = st.corners[s];
        el.dataset.seat = s;
        el.dataset.i = i;
        el.style.width = "calc(var(--tq-cell) * " + (PC_R * 2) + ")";
        el.style.height = "calc(var(--tq-cell) * " + (PC_R * 2) + ")";
        /* ★ 三層(v1.180.2):球體 → 頭飾 → 座號。
           ⚠ .tq-pc 自己**不再有背景** —— 它只剩「位置 + 那三圈狀態環」兩個職責,
             因為每一幀被寫 transform 的是它(紅線 15),層數越少越不會出事。
           ⚠ 頭飾疊在球**上面**(不是後面):棋子直徑只有 0.8 格,
             而相鄰的洞只差 1 格 → 往外突得出來的只有 0.1 格(約 3px),
             光靠那 3px 的剪影認不出是哪一種動物。 */
        el.innerHTML = '<i class="tq-ball"></i><i class="tq-cap"></i>' +
                       '<b class="tq-pn">' + (s + 1) + "</b>";
        board.appendChild(el);
        row.push(el);
      }
      pieceEls.push(row);
    }
  }

  // 把一顆棋放到某個座標(單位:格。中心點)
  function setPos(el, cx, cy){
    el.style.transform = "translate(calc(var(--tq-cell) * " + (cx + OX - PC_R) + "), " +
                                   "calc(var(--tq-cell) * " + (cy + OY - PC_R) + "))";
  }
  function setHole(el, id){
    const p = R.posXY(id);
    setPos(el, p.x, p.y);
  }

  /* ★★★ 把所有棋子落到**真相位置**。這一支是「畫面 = 真相」的那條路,
     它不看動畫、不看任何本地旗標 —— render() 每一次都先叫它。 */
  function placeAll(pieces){
    if(!pieceEls.length) return;
    for(let s = 0; s < pieces.length && s < pieceEls.length; s++)
      for(let i = 0; i < pieces[s].length && i < pieceEls[s].length; i++)
        setHole(pieceEls[s][i], pieces[s][i]);
    lastPaint = pieces.map(r => r.slice());
  }

  /* ==========================================================================
     四、★★★ 動畫 —— 位置是 now 的函式
     ──────────────────────────────────────────────────────────────────────────
       這一整節都是**裝飾**:它只把「已經在終點的那一顆」暫時拉回路徑上。
       所以 —— 動畫沒跑、跑到一半被打斷、分頁被凍結、rAF 整個不觸發,
       **畫面都是對的**,呼叫端也不需要等任何回呼。
     ========================================================================== */
  function animMs(path){
    if(!path || path.length < 2) return 0;
    const segs = path.length - 1;
    return segs === 1 ? MS_STEP : segs * MS_HOP;
  }

  function stopFlight(){
    if(flight && flight.el) flight.el.classList.remove("fly");
    flight = null;
    if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
  }

  /* ★★★ 動畫的**絕對過期**:牆上時間過了就當它演完,不管 rAF 有沒有真的跑過。
     ⚠⚠ 這不是保險,是必要的:`requestAnimationFrame` 在**分頁被凍結、視窗最小化、
       低階手機掉幀到 0、headless 沒有真的渲染**的情況下可以一次都不觸發 ——
       那時 frame() 永遠不會走到「演完」那一段,flight 就永遠掛著。
     ⚠ 後果不是畫面錯(畫面早就落定了,見 render 的第一件事),而是
       **adapter 的對帳心跳會被永久跳過**(它遇到 _flying() 就讓一拍)——
       等於第四條那條「無條件回到真相」的路被一個**裝飾**關掉了。
     ★ 這正是「不要把任何東西掛在會斷的鏈上」那條原則自己也要遵守的地方:
       連「動畫演完了沒」都不可以只問回呼,要問時間。 */
  const FLIGHT_SLACK = 250;
  function flying(){
    return !!flight && (now() - flight.startAt) < flight.dur + FLIGHT_SLACK;
  }
  function expireFlight(){
    if(flight && !flying()) stopFlight();
  }

  function startFlight(seat, idx, path){
    stopFlight();
    const el = pieceEls[seat] && pieceEls[seat][idx];
    if(!el || !path || path.length < 2) return;
    const dur = animMs(path);
    flight = { el: el, path: path.slice(), startAt: now(), dur: dur, seg: -1 };
    el.classList.add("fly");
    rafId = requestAnimationFrame(frame);
  }
  function now(){
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  function frame(){
    rafId = 0;
    const f = flight;
    if(!f) return;
    const t = now() - f.startAt;
    if(t >= f.dur){
      /* 演完:把它放回終點就好 —— 那本來就是 render() 已經寫進去的位置。
         ⚠ 這裡**不叫任何回呼**(見檔頭):呼叫端要接續就自己算 animMs()。 */
      f.el.classList.remove("fly");
      setHole(f.el, f.path[f.path.length - 1]);
      flight = null;
      return;
    }
    const segs = f.path.length - 1;
    const u = (t / f.dur) * segs;             // 走到第幾段的幾成
    const k = Math.min(segs - 1, Math.floor(u));
    const frac = u - k;
    const a = R.posXY(f.path[k]), b = R.posXY(f.path[k + 1]);
    /* 每一段拉一條小拋物線 —— 跳棋是「跳」過去的,直線平移看起來像滑行。
       ⚠ 幅度跟著段長走,單步(只有一段)幾乎不拱。 */
    const lift = (segs === 1 ? 0.12 : 0.30) * Math.sin(Math.PI * frac);
    setPos(f.el, a.x + (b.x - a.x) * frac, a.y + (b.y - a.y) * frac - lift);
    if(k !== f.seg){
      f.seg = k;
      if(segs === 1) SFX.step(); else SFX.hop(k);
    }
    rafId = requestAnimationFrame(frame);
  }

  /* ==========================================================================
     五、對外:畫一次
     ──────────────────────────────────────────────────────────────────────────
       view = {
         st,            replay 出來的局面(唯一真相)
         mySeat,        我坐哪(-1 = 觀看)
         sel,           我選中的那一顆的洞 id(-1 = 沒選)
         spots,         [{to, path}] 選中那顆能走到哪(空 = 不顯示)
         anim,          ★ 這一手要不要演 {seat, idx, path}|null。演不演都不影響正確性
         pending        送出中、還沒被伺服器確認的那一顆(畫成半透明;-1 = 無)
       }
     ========================================================================== */
  function render(view){
    if(!board) return;
    const st = view.st;
    if(!st) return;
    build();
    ensurePieces(st);
    fitBoard();
    expireFlight();      // ★ 上一段動畫的時間到了就收掉(不管 rAF 有沒有跑過,見它的註解)

    /* ★★★ 第一件事:把每顆棋落到真相位置。
       動畫、選取、提示全部是疊在這之上的裝飾 —— 它們壞掉都不會讓畫面失真。 */
    placeAll(st.pieces);

    const me = view.mySeat;
    const sel = (view.sel == null) ? -1 : view.sel;
    const spots = view.spots || [];
    const spotSet = {};
    spots.forEach(s => { spotSet[s.to] = s; });

    // 洞:目標區的環 + 可以走的落點
    const myGoal = (me >= 0 && me < st.n) ? st.goals[me] : [];
    for(let id = 0; id < holeEls.length; id++){
      const el = holeEls[id];
      if(!el) continue;
      const isGoal = myGoal.indexOf(id) >= 0;
      el.classList.toggle("goal", isGoal);
      if(isGoal) el.dataset.g = st.corners[me]; else el.removeAttribute("data-g");
      el.classList.toggle("spot", !!spotSet[id]);
      el.classList.toggle("far", !!(spotSet[id] && spotSet[id].jumps >= 2));
    }
    // 棋子:選中 / 我的 / 到家 / 送出中
    for(let s = 0; s < pieceEls.length; s++)
      for(let i = 0; i < pieceEls[s].length; i++){
        const el = pieceEls[s][i], id = st.pieces[s] ? st.pieces[s][i] : -1;
        el.classList.toggle("mine", s === me);
        el.classList.toggle("on", s === me && id === sel);
        el.classList.toggle("home", st.goals[s] && st.goals[s].indexOf(id) >= 0);
        el.classList.toggle("wait", s === me && id === view.pending);
      }
    // 輪到誰:那一家的角亮起來
    board.dataset.turn = st.over ? "" : String(st.corners[st.turn]);

    if(view.anim) startFlight(view.anim.seat, view.anim.idx, view.anim.path);
  }

  /* ==========================================================================
     六、動作列(提示 + 倒數環)
     ──────────────────────────────────────────────────────────────────────────
       ★ 倒數環與台灣麻將 / 21 點 / UNO / 暗棋 / 飛行棋**同一顆**(SVG 環 + 中間秒數,
         最後 3 秒轉紅脈動),關鍵影格直接沿用共用的 m16cd / m16beat / m16cdhot。
       ⚠ 兩個從那幾頁繼承的坑:
         ① 用**負的 animation-delay** 接續播放,duration 永遠是這一手的總長
            (這樣 e2e 才量得到設定值)。
         ② 去重的 key **不可以看 timer 還在不在** —— 數字走到 0 之後 interval 就停了,
            而那段空窗裡只要再叫一次 renderActs()(resize 就會)環就會彈回滿格。
     ========================================================================== */
  let cdT = null, cdKey = "", cdEnd = 0;
  const CD_HOT = 3000;

  function renderActs(o){
    if(!acts) return;
    if(!acts.dataset.built){
      acts.dataset.built = "1";
      acts.innerHTML = '<div class="tq-hint" id="tqHint"></div><div class="tq-cdwrap" id="tqCdWrap"></div>';
    }
    acts.classList.remove("hidden");
    const hint = $("tqHint");
    if(hint) hint.innerHTML = o.hint || "";
    syncCd(o.cdMs, o.cdEnd);
  }

  function syncCd(cdMs, endAt){
    const box = $("tqCdWrap");
    if(!box) return;
    if(!cdMs || !endAt){ stopCd(); return; }
    const left = endAt - Date.now();
    if(left <= 0){ stopCd(); return; }
    const key = cdMs + ":" + endAt;
    cdEnd = endAt;
    box.innerHTML =
      '<span class="tq-cd' + (left <= CD_HOT ? " tq-hot" : "") + '" id="tqCd" aria-hidden="true"' +
        ' style="--cd-dur:' + (cdMs / 1000) + 's;--cd-delay:' + (-(cdMs - left) / 1000) + 's">' +
        '<svg viewBox="0 0 40 40"><circle class="tq-cdbg" cx="20" cy="20" r="17"/>' +
        '<circle class="tq-cdfg" cx="20" cy="20" r="17"/></svg>' +
        '<b class="tq-cdn">' + Math.ceil(left / 1000) + "</b>" +
      "</span>";
    if(key === cdKey && cdT) return;
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(tickCd, 200);
  }
  function tickCd(){
    const el = $("tqCd");
    if(!el){ if(cdT){ clearInterval(cdT); cdT = null; } return; }
    const left = cdEnd - Date.now();
    const n = el.querySelector(".tq-cdn");
    const s = String(Math.max(0, Math.ceil(left / 1000)));
    if(n && n.textContent !== s){
      n.textContent = s;
      n.classList.remove("tq-beat"); void n.offsetWidth; n.classList.add("tq-beat");
    }
    el.classList.toggle("tq-hot", left <= CD_HOT);
    if(left <= 0){ clearInterval(cdT); cdT = null; }
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = ""; cdEnd = 0;
    const box = $("tqCdWrap");
    if(box) box.innerHTML = "";
  }

  /* ==========================================================================
     七、★ 現場效果 —— 借道與到家
     ──────────────────────────────────────────────────────────────────────────
       跳棋是十四個裡**互動性最低**的一個:不吃子、不打回,整局各走各的。
       唯一的人際瞬間是 **「我借了你的棋子當跳板」** —— 對手的棋不是障礙,是橋。
       這一段就是把那一瞬間講出來。

     ★★★ **完全在本地做,一個 DB 寫入都沒有。**
       「誰借了誰的道」在 moves 裡是公開的,每一台各自 replay 都算得出同一件事
       → 走 MP.sendEmote() 會變成 **N 台各送一次**(飛出 N 顆一樣的表情 + N 次寫入)。
       ⚠ 不要因為「表情本來就走 sendEmote」就順手改過去(飛行棋踩人那條的同一個道理)。

     ⚠⚠ **不自動播罐頭語音**(飛行棋 v1.179.7 的結論):
       「罐頭語音的笑點在是誰、在什麼時機按的」—— 系統自動放只是音效,而且它是
       整個專案裡唯一會在對局中途自己碰音訊子系統的地方(iOS 音訊解鎖最容易出事)。

     ⚠⚠⚠ **這裡每一樣都是裝飾,一個都不准把例外丟回呼叫端。**
       各自包而不是整段包 —— 震動壞掉不該連表情也一起不見。
       例外照樣 console.error 出來:吞掉不等於當作沒發生過。
     ========================================================================== */
  function safe(what, fn){ try{ fn(); }catch(e){ console.error("tq drama:" + what, e); } }

  function drama(o){
    if(!o) return;
    if(o.kind === "borrow"){
      safe("emote", () => showEmote("🪜", esc(o.byName) + " 借了 " + esc(o.toName) + " 的棋當跳板",
                                    o.byId || o.byName, "emoji"));
      if(o.victim) safe("buzz", buzz);
    }else if(o.kind === "chain"){
      safe("emote", () => showEmote("🔥", esc(o.byName) + " 一口氣跳了 " + o.jumps + " 段",
                                    o.byId || o.byName, "emoji"));
    }else if(o.kind === "home"){
      safe("emote", () => showEmote("🏁", esc(o.byName) + " 有一顆到家了", o.byId || o.byName, "emoji"));
      safe("sfx", SFX.home);
    }
  }
  function buzz(){
    try{ if(typeof vibrateOn !== "undefined" && vibrateOn && navigator.vibrate) navigator.vibrate([16, 34, 16]); }catch(e){}
  }

  /* ==========================================================================
     八、排名表
     ──────────────────────────────────────────────────────────────────────────
       ★ 單機與連線共用同一支 —— 兩邊各寫一份的話,欄位與措辭一定會慢慢走鐘。
       wins 有值 = 連線(顯示累計名次分);沒有 = 單機(顯示這一局拿幾分)。
     ========================================================================== */
  function resultHTML(sc, nameArr, meSeat, foot, wins){
    let h = '<table class="tq-rank"><thead><tr><th>名次</th><th>玩家</th><th>到家</th><th>還差</th>' +
            (wins ? "<th>累計</th>" : "<th>本局</th>") + "</tr></thead><tbody>";
    sc.sorted.forEach(r => {
      const nm = (nameArr && nameArr[r.seat] != null) ? nameArr[r.seat] : ("玩家" + (r.seat + 1));
      const w = wins && wins[r.seat];
      h += '<tr class="' + (r.seat === meSeat ? "me" : "") + (r.rank === 1 ? " top" : "") + '">' +
             "<td>" + (r.rank === 1 ? "🏆" : r.rank) + "</td>" +
             '<td><span class="tq-dot" data-c="' + r.corner + '"></span>' + esc(nm) + "</td>" +
             "<td>" + r.home + "</td>" +
             "<td>" + r.left + "</td>" +
             "<td>" + (w ? (w.n + (w.plus ? (' <b class="tq-plus">+' + w.plus + "</b>") : ""))
                         : ("+" + r.pts)) + "</td>" +
           "</tr>";
    });
    h += "</tbody></table>";
    if(foot) h += '<div class="tq-rank-foot">' + esc(foot) + "</div>";
    return h;
  }

  /* ==========================================================================
     九、掛載
     ========================================================================== */
  function mount(o){
    cb = o || {};
    board = $("tqBoard"); stage = $("tqStage"); acts = $("tqActs");
    if(!board) return;
    build();
    /* 點擊一律綁在盤面上(洞與棋子都是動態產生的)。
       ⚠ 棋子疊在洞上面 → 先問棋子,再問洞。 */
    board.addEventListener("click", e => {
      const pc = e.target.closest(".tq-pc");
      if(pc && cb.onPiece){ cb.onPiece(+pc.dataset.seat, +pc.dataset.i); return; }
      const hole = e.target.closest(".tq-hole");
      if(hole && cb.onHole) cb.onHole(+hole.dataset.id);
    });
    let rt = null;
    window.addEventListener("resize", () => {
      if(rt) clearTimeout(rt);
      rt = setTimeout(fitBoard, 90);
    });
    fitBoard();
  }

  function reset(){
    stopFlight();
    stopCd();
    shownKey = ""; lastPaint = null;
    if(board){
      pieceEls.forEach(r => r.forEach(el => el.remove()));
      pieceEls = [];
      board.dataset.turn = "";
      [...board.querySelectorAll(".tq-hole")].forEach(el => {
        el.classList.remove("goal", "spot", "far");
        el.removeAttribute("data-g");
      });
    }
  }

  return {
    mount, render, renderActs, fitBoard, reset, resultHTML, drama,
    animMs, stopCd, SFX,
    cell: () => cell,
    /* 給 e2e 用:畫面上「畫到哪一個局面」——★ 對帳心跳靠它(見 adapter 第四條)。
       ⚠ 回的是**畫面**的狀態,不是真相;兩者不同就是漏畫了。 */
    _shown: () => lastPaint ? lastPaint.map(r => r.slice()) : null,
    /* ⚠ 問的是**時間**不是「回呼跑過沒」——rAF 一次都不觸發時它照樣會過期(見 flying())。 */
    _flying: flying
  };
})();

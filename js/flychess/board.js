"use strict";

/* ============================================================================
   飛行棋 — 盤面(FCB)

   單機與連線**共用這一支**:盤面自己不知道現在是哪一種模式,兩個回呼由 main.js
   分流(同排七 SVB 的做法)。漏掉分流的症狀是「單機點了沒反應」或「連線走到單機那條路」。

   ── ★ 盤面尺寸用 JS 算,不用 aspect-ratio ────────────────────────────────
     比照暗棋 / 成語接龍:格子必須是整數像素的正方形,交給 CSS 去算會在
     14 格 × 小數的情況下累積出半格誤差(飛機就對不準格子中心)。
     fitBoard() 量 stage 的可用空間 → 算出 cell → 寫進 --fc-cell,其餘全部靠這個變數。

   ── ★★★ 批次同步絕對不可以連播動畫 ───────────────────────────────────────
     這是十三個遊戲裡**第一個有棋子位移動畫**的一頁,所以它是新的一條坑:
     其他遊戲的「批次同步就是同一支 replay 多跑幾手」在有動畫時會變成
     **二十幾秒的慢動作**(斷線重連的人看著飛機一格一格自己走完前面所有手)。
     → render() 只有在 opts.anim 明確為 true 時才走動畫,adapter 的 applyGame()
       負責判斷「這是新的一手」還是「一口氣補了很多手」。

   ── ★ 顏色是規則本體(同 UNO)─────────────────────────────────────────────
     四色決定「哪一格是自家色(可以跳)」「誰的飛機」「誰的跑道」——
     **任何主題都不准把它轉成黑白**,所以 --fc-c0..3 刻意不吃主題變數。
     色盲的第二訊號是飛機身上的**座號數字**(1~4),不是只有顏色。
   ========================================================================== */

const FCB = (function(){

  const R = FC;
  const CELL_MIN = 13;                 // 再小就點不到了(手指 + 邊框)
  const CELL_MAX = 46;

  /* 一格走多久。★ 走格是一格一段 —— 玩家會跟著數,一次滑過去就看不出走了幾格 */
  const MS_WALK = 105, MS_JUMP = 260, MS_FLY = 520, MS_LAUNCH = 300;

  /* 被踩掉的三段。使用者:「飛機被踩掉的動畫太差了,應該做的再誇張一點,
     時間長一點點沒關係」。
     ★ 一般 UI 的 300ms 上限管的是「常常看到的東西」,而踩人是這一局裡**唯一
       對某一個特定的人做壞事**的瞬間(見第七節)——一整局只發生幾次,預算給得起。
     ★ 三段各自對著畫面上的三件事,合起來才讀得出因果:
         ① MS_HIT   挨打(定格被打歪 + 撞擊特效 + 盤面一震)
         ② MS_EJECT 被彈回機場(一路翻滾)
         ③ MS_PLOP  落地彈一下
     ⚠ 總長 1260ms 必須留在 adapter 的 busy 看門狗(5000ms)底下:最長的一手
       (走 6 格 + 飛 + 跳 ≈ 1410ms)加上這一段也只有 2.7 秒,還有一倍的餘裕。
     ⚠ 拉長它就等於拉長 busy —— 不要拉到接近看門狗,那顆是最後一道保險不是預算。
     ⚠⚠ **這三個數字是雙胞胎**:`styles.src.css` 的 fcHit / fcEject / fcPlop 各有一份
       duration。對不上的症狀很難認 —— 這邊短了就是「動畫演到一半被收掉」,
       這邊長了就是「演完之後畫面乾等一段才換人」,兩種都不會報錯。 */
  const MS_HIT = 300, MS_EJECT = 700, MS_PLOP = 260;

  let board = null, stage = null, acts = null;
  let cb = { onDice: null, onPlane: null };
  let built = false, cell = 0;
  let planeEls = [];                   // planeEls[seat][i]
  let shown = null;                    // 上一次畫出來的進度快照(動畫的起點)
  let shownColors = null;
  let animGen = 0, animating = false;
  /* ★ 在飛的那一手的 onDone。bump() 取消動畫時**一定要把它交出去**(見 bump 的註解)。 */
  let pendingDone = null;
  let cdT = null, cdKey = "", cdEnd = 0;   // 倒數環:用 key 去重,**不看 timer**(見 syncCd)

  /* 這一頁的音效。★ 走 Sound.tone()(audio.js 開給各遊戲寫自己樂句的入口)——
     吃靜音開關與總音量,不必自己管。⚠ 走一格的 tick 要**很輕**:一手可能連走六格,
     用一般音量會變成連珠炮。

     ⚠⚠⚠ **基頻一律待在 600Hz 以上,要「厚」靠往下滑(slideTo)而不是把基頻壓低。**
       第一版的骰子 rattle 寫在 150~260Hz、踩人的低頻厚度寫在 95Hz —— 在耳機上很飽滿,
       **在手機喇叭上等於沒有**:小喇叭放不出那一段。使用者的回報就是這一條:
       「我沒有感覺到骰子音效」(而且那時聲音**確實有播**,是聽不到不是沒響)。
       量法:OfflineAudioContext 照 tone() 的包絡渲染一遍 → 過兩級 500Hz 高通(≈ 小喇叭
       的低頻滾降)→ 比總能量。以「輪到你」那顆(最明顯的一顆)當 1.00 量到:
         走格 tick 0.008 · 舊的整趟擲骰 **0.118** · 第一版的 plop **0.02**(等於靜音)
         → 現在:整趟擲骰 **1.876**、撞擊 1.02、彈飛 0.55、落地 0.34。
       數字與量法見 notes/22 第 12.1 節。**改任何一顆之前先照那個方法量,不要靠耳機聽。** */
  const SFX = {
    tick(){ T(1040, { type: "square", dur: 0.030, vol: 0.055 }); },
    jump(){ T(660, { type: "triangle", dur: 0.11, vol: 0.16, slideTo: 1180 }); },
    fly(){ T(300, { type: "sawtooth", dur: 0.38, vol: 0.10, slideTo: 1500 });
           T(760, { type: "sine", dur: 0.22, vol: 0.10, delay: 0.16, slideTo: 1320 }); },
    /* 踩人的三聲,與畫面的三段一一對上(由一聲擴成三聲)——
       只有一聲「咚」的話,後面 1 秒的翻滾與落地在聽覺上是靜音的。
       ★ 撞擊是全場最大的一聲(= 輪到你那顆的 1.02 倍):一局只有幾次,而且是這個遊戲
         唯一「對某一個人做壞事」的瞬間。 */
    eat(){ T(1200, { type: "square", dur: 0.06, vol: 0.30, slideTo: 300 });     // 撞上去的脆響
           T(520,  { type: "triangle", dur: 0.28, vol: 0.30, delay: 0.01, slideTo: 210 }); // 厚度(靠下滑,不靠低基頻)
           T(2200, { type: "sawtooth", dur: 0.14, vol: 0.13, slideTo: 700 }); },// 碎裂
    eject(){ T(2000, { type: "sine", dur: 0.45, vol: 0.15, slideTo: 520 });     // 被彈飛的呼嘯
             T(1200, { type: "triangle", dur: 0.38, vol: 0.10, delay: 0.05, slideTo: 420 }); },
    plop(){ T(900,  { type: "triangle", dur: 0.10, vol: 0.20, slideTo: 420 });  // 掉回機場
            T(1400, { type: "sine", dur: 0.14, vol: 0.16, delay: 0.04, slideTo: 700 }); },
    /* 骰子的**後備**合成音(v2.x 起正式的聲音是 mp3/fc/dice.mp3,見下面的音效槽)。
       ⚠⚠ 第一版加了 rattle,使用者**還是說沒聽到** —— 不是沒響,是放在 150~260Hz
         聽不到(見上面那條 600Hz 的規矩)。
       ⚠ rattle 一次擲會響八下 → 單響控在「輪到你」的 5~6%(約走格 tick 的七倍),
         夠清楚又不會變連珠炮;音高每下不同,一樣的話聽起來像卡帶而不像骰子在滾。
       ⚠ `at` 是**在 AudioContext 時間軸上的延遲**(秒),不是 setTimeout ——
         整趟是一次排完的(見 rollSynth),背景頁籤被節流時整句才不會散掉。 */
    rattle(k, at){ const f = 1500 + (k % 3) * 260;
                   T(f, { type: "square", dur: 0.042, vol: 0.15, delay: at || 0, slideTo: f * 0.5 }); },
    dice(at){ const t = at || 0;
              T(1050, { type: "square", dur: 0.075, vol: 0.30, delay: t, slideTo: 420 });          // 落桌那一記
              T(620,  { type: "triangle", dur: 0.16, vol: 0.22, delay: t + 0.01, slideTo: 380 });  // 木頭的厚度
              T(1900, { type: "triangle", dur: 0.11, vol: 0.22, delay: t + 0.03, slideTo: 2500 }); },
    // 擲到 6 = 「可以再擲一次」,給它一個聽得出來的向上兩音(規則本身的回饋)
    six(){ [988, 1319].forEach((f, i) => T(f, { type: "sine", dur: 0.13, vol: 0.20, delay: 0.09 + i * 0.08 })); },
    home(){ [659, 880, 1175].forEach((f, i) => T(f, { type: "sine", dur: 0.18, vol: 0.20, delay: i * 0.07 })); },
    launch(){ T(360, { type: "triangle", dur: 0.20, vol: 0.18, slideTo: 900 }); }
  };
  function T(f, o){ if(typeof Sound !== "undefined" && Sound.tone) Sound.tone(f, o); }

  /* ★ 圓胖版的機身(v1.179.5)。使用者:「希望可以稍微把風格做的可愛一些」。
     ⚠ 第一版是尖角戰鬥機的輪廓 —— 在 13~20px 的格子上,尖角只會變成鋸齒,
       圓角反而**更認得出是飛機**(而且順便可愛)。所以機身加寬(±2.1)、
       機翼加厚(3.7 個單位)、每一個轉折都用 Q 收成圓的。
     ⚠ 左右一定要對稱(以 x=12 為軸):不對稱的話飛機在格子裡看起來就是歪的,
       而那正好是這一版在修的毛病。 */
  const PLANE_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8 ' +
    'Q13.6 1.8 13.9 5 L14.1 9.6 L21.4 13.8 Q22.4 14.4 22.4 15.5 L22.4 17 ' +
    'Q22.4 17.8 21.6 17.5 L14.2 15 L13.8 19 L16.1 20.9 Q16.6 21.3 16.6 22 ' +
    'L16.6 22.6 Q16.6 23.1 16.1 22.9 L12 21.5 L7.9 22.9 Q7.4 23.1 7.4 22.6 ' +
    'L7.4 22 Q7.4 21.3 7.9 20.9 L10.2 19 L9.8 15 L2.4 17.5 Q1.6 17.8 1.6 17 ' +
    'L1.6 15.5 Q1.6 14.4 2.6 13.8 L9.9 9.6 L10.1 5 Q10.4 1.8 12 1.8 Z"/></svg>';

  /* ==========================================================================
     一、建盤面(只做一次)
     ──────────────────────────────────────────────────────────────────────────
       格子是絕對定位的 div,座標一律問 rules.js 的幾何表 —— 這一支不自己算任何
       格子位置(規則與畫面脫鉤,盤面重畫時 rules.js 一行都不必動)。
     ========================================================================== */
  function at(x, y, w, h){
    return 'style="left:calc(var(--fc-cell) * ' + x + ');top:calc(var(--fc-cell) * ' + y + ');' +
           'width:calc(var(--fc-cell) * ' + (w || 1) + ');height:calc(var(--fc-cell) * ' + (h || 1) + ')"';
  }

  function build(){
    if(built || !board) return;
    let h = "";

    // 四個機場區塊(5×5,擺在四個角)
    for(let c = 0; c < 4; c++){
      const b = R.hangarXY(c, 0);      // 左上那一格 → 往回推區塊原點
      const ox = b.x - 1, oy = b.y - 1;
      h += '<div class="fc-hangar" data-c="' + c + '" ' + at(ox, oy, 5, 5) + '></div>';
      for(let k = 0; k < 4; k++){
        const p = R.hangarXY(c, k);
        h += '<div class="fc-slot" data-c="' + c + '" ' + at(p.x, p.y) + '></div>';
      }
    }

    // 外圈 52 格。★ 自家色格畫上「跳」的記號,航線格畫上「飛」的記號
    for(let i = 0; i < R.RING; i++){
      const p = R.ringXY(i), col = R.colorAt(i);
      const cls = ["fc-cell"];
      let mark = "";
      // 這一格對「以它為自家色的那一家」而言是第幾格
      const q = ((i - R.START[col]) % R.RING + R.RING) % R.RING + 1;
      /* ⚠⚠ **「可以跳」的格子不畫記號,只靠底色。** 顏色是每格輪一次的
         → 52 格**每一格都是某一家的自家色格**,每格都畫記號的話整圈變成一片三角形,
           反而看不出起飛點與航線格在哪(v1.179.0 第一版截圖就是這樣糊成一片的)。
         真實的飛行棋盤也是這樣:底色就是規則,只有起飛點與航線另外做記號。 */
      if(q === 1){ cls.push("start"); mark = '<i class="fc-mk start"></i>'; }
      else if(q === R.FLY_Q){ cls.push("fly"); mark = '<i class="fc-mk fly"></i>'; }
      else if(R.isOwnColor(q)){ cls.push("jump"); }
      h += '<div class="' + cls.join(" ") + '" data-c="' + col + '" data-i="' + i + '" ' +
           at(p.x, p.y) + '>' + mark + '</div>';
    }

    // 四條回家跑道
    for(let c = 0; c < 4; c++)
      for(let k = 0; k < R.LANE; k++){
        const p = R.laneXY(c, k);
        h += '<div class="fc-lane" data-c="' + c + '" ' + at(p.x, p.y) + '></div>';
      }

    /* 終點(中央 2×2)。
       ⚠⚠ **是 −0.5 不是 −1**(v1.179.5 修,使用者回報「棋盤中間的賽車旗沒有置中」):
         `GOAL_XY` 回的是**一架飛機的左上角**(飛機一格見方,posXY 全部都是這個約定)
         → 它的視覺中心在 `GOAL_XY + 0.5` = (7,7) = 盤面正中心。
         一個 2×2 的區塊要以 (7,7) 為中心,左上角就得是 (6,6) = `GOAL_XY − 0.5`。
         寫 −1 等於整顆往左上偏了半格 —— 而盤面正中心就是四條跑道的交會點,
         偏了半格一眼就看得出來(四條跑道會有兩條對不上)。 */
    h += '<div class="fc-goal" ' + at(R.GOAL_XY.x - 0.5, R.GOAL_XY.y - 0.5, 2, 2) + '><span>🏁</span></div>';

    /* 撞擊特效的圖層。⚠⚠ **它存在的理由就是 overflow:hidden 那一行**:
       火花會噴出格子一格多,而踩人常常發生在**最外圈**(貼著盤子的邊)——
       噴出去的部分會把 `.fc-stage`(overflow:auto)的捲動範圍撐大 → 冒出捲軸,
       而 fitBoard() 量的正是 stage 的可用空間 → 縮一階、捲軸消失、又放大(跳棋踩過的同一個震盪)。
       把特效關在自己的盒子裡,盤面上其他東西(飛機的光暈 / 飛行時放大的機身)一個都不必動。
       ⚠ 圓角要跟著盤子(20px),不然四個角會切出直角的邊。 */
    h += '<div class="fc-fx" id="fcFx" aria-hidden="true"></div>';

    /* ★ 落點預覽的圖層。⚠⚠ 與 .fc-fx 是**兩層**,而且方向刻意相反:
         · .fc-fx  z-index 4 → 壓在飛機**底下**(爆炸是背景的光,不可以蓋住主角)
         · .fc-pv  z-index 10 → 壓在飛機**上面**(「這一格踩得到他」的準心一定要
           蓋在受害者身上,畫在他底下就等於沒畫)
       ⚠ overflow:hidden 的理由與 .fc-fx 完全一樣(紅線 17 / 19):預覽的圈與準心
         都比一格大,而落點常常在最外圈 —— 不裁就是捲軸 → fitBoard() 縮一階。
       ⚠ 它是**自己建的**(不佔 flychess.html 一行,照 qr.js 的先例)。 */
    h += '<div class="fc-pv" id="fcPv" aria-hidden="true"></div>';

    board.innerHTML = h;
    built = true;
  }

  /* ==========================================================================
     二、尺寸
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 只在「真的要換尺寸」時才寫 DOM —— 每次 render 都寫一次 style 會讓
         正在跑的 transition 重來(飛機會抖)。
     ========================================================================== */
  function fitBoard(){
    if(!board || !stage) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    if(w <= 0) return;
    // 高度量不到(還沒排版完)就先只吃寬度,resize 會再叫一次
    const side = h > 40 ? Math.min(w, h) : w;
    let c = Math.floor(side / R.GRID);
    if(c < CELL_MIN) c = CELL_MIN;
    if(c > CELL_MAX) c = CELL_MAX;
    if(c === cell) return;
    cell = c;
    board.style.setProperty("--fc-cell", c + "px");
    board.style.width = (c * R.GRID) + "px";
    board.style.height = (c * R.GRID) + "px";
    if(shown) placeAll(shown, shownColors, 0);
  }

  /* ==========================================================================
     三、飛機
     ========================================================================== */
  function ensurePlanes(st){
    const need = st.n + ":" + st.planes[0].length + ":" + st.colors.join("");
    if(board.dataset.pk === need) return;
    board.dataset.pk = need;
    // 舊的先收掉(換局 / 換人數)
    planeEls.forEach(row => row.forEach(el => el.remove()));
    planeEls = [];
    for(let s = 0; s < st.n; s++){
      const row = [];
      for(let i = 0; i < st.planes[s].length; i++){
        const el = document.createElement("button");
        el.type = "button";
        el.className = "fc-plane";
        el.dataset.c = st.colors[s];
        el.dataset.seat = s;
        el.dataset.plane = i;
        el.innerHTML = PLANE_SVG + '<b class="fc-pn">' + (s + 1) + "</b>";
        el.setAttribute("aria-label", "第 " + (s + 1) + " 家的飛機 " + (i + 1));
        board.appendChild(el);
        row.push(el);
      }
      planeEls.push(row);
    }
  }

  /* 把一架飛機放到某個進度。dur=0 = 不做動畫(批次同步 / 換尺寸走這條)。
     ⚠ 同一格上疊了好幾架時要錯開,不然只看得到最上面那一架。 */
  function place(el, color, q, plane, dur, stackIdx, stackN){
    const p = R.posXY(color, q, plane);
    let dx = 0, dy = 0;
    if(stackN > 1){
      // 疊機:小幅度扇形錯開(最多四架)
      const k = stackIdx - (stackN - 1) / 2;
      dx = k * 0.22; dy = (stackIdx % 2 ? 0.14 : -0.14);
    }
    /* ⚠ 錯開之後要**夾回盤面內**:外圈最外面那一圈就貼著邊(x 或 y = 13),
       往外錯開就是整架飛機掛在盤子外面(量得到:診斷的 outside 會變成 1)。
       ⚠ 夾的只有**畫**,命中判定與規則完全不看這個偏移(同表情飛出那條夾取的道理)。 */
    const MAXQ = R.GRID - 1;
    const x = Math.max(0, Math.min(MAXQ, p.x + dx));
    const y = Math.max(0, Math.min(MAXQ, p.y + dy));
    el.style.transitionDuration = dur ? (dur + "ms") : "0ms";
    el.style.transform = "translate(calc(var(--fc-cell) * " + x + "), " +
                                    "calc(var(--fc-cell) * " + y + "))";
  }

  /* 一次把所有飛機擺到 planes 的位置(不動畫) */
  function placeAll(planes, colors, dur){
    if(!planeEls.length) return;
    // 先算每個「落點」上有幾架,才錯得開
    const bucket = {};
    for(let s = 0; s < planes.length; s++)
      for(let i = 0; i < planes[s].length; i++){
        const q = planes[s][i];
        const key = (q <= 0) ? ("h" + s + "_" + i)
                  : (q >= R.GOAL) ? "goal"
                  : (q > R.RING) ? ("l" + colors[s] + "_" + q)
                  : ("r" + R.absOf(colors[s], q));
        (bucket[key] = bucket[key] || []).push({ s: s, i: i });
      }
    Object.keys(bucket).forEach(key => {
      const list = bucket[key];
      list.forEach((o, k) => {
        const el = planeEls[o.s] && planeEls[o.s][o.i];
        if(el) place(el, colors[o.s], planes[o.s][o.i], o.i, dur, k, list.length);
      });
    });
  }

  /* ==========================================================================
     四、動畫 —— 走一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 世代記號:換局 / 離場 / 下一手插隊時,舊的 timer 一律不執行
         (同 solo.js 的 later();台灣麻將踩過「離場後電腦繼續打牌」那個坑)。
     ========================================================================== */
  /* ★★★ bump() 取消在飛的動畫時,**一定要把那個 onDone 交出去**(v1.179.2 修)。
     ⚠⚠ 這是「三個人玩、一個人卡死但沒斷線」那個回報的病灶,而且是**必然**不是機率:
       adapter 演一手時會 `busy = true`,而 busy 只在 onDone 裡清掉;
       只要在動畫還沒演完時來了一張**不演動畫**的快照(批次同步 / 換局 / 重畫),
       render() 就會走 bump() → later() 那條鏈整條失效 → onDone 永遠不會叫
       → **busy 永遠停在 true**:那台從此擲不了骰、也走不了棋。
       他不會斷線、畫面也還在更新,所以看起來就是「他沒同步,全桌等他」。
     ★ 排到下一拍再叫:bump() 常常是在 render() 中途被叫的,當場回呼會重入 render()。
     ⚠ 一定要**先清掉 pendingDone 再叫**,不然重入時會叫第二次。 */
  function bump(){
    animGen++;
    animating = false;
    clearFx();
    const d = pendingDone; pendingDone = null;
    if(d) setTimeout(() => { try{ d(); }catch(e){} }, 0);
  }
  function later(g, fn, ms){ setTimeout(() => { if(g === animGen) fn(); }, ms); }

  /* ★★ 被踩的那三個 class 是**動畫中途的狀態**,一定要有人負責收。
     它們都帶 `both` 的填充模式(翻滾停在 720 度、落地停在壓扁)——
     動畫被 bump() 半路取消時沒收掉的話,那架飛機就**永遠**歪在那裡:
     不會報錯、位置還是對的,只有看起來不對(而斷言量不到「看起來」)。
     ⚠ 特效層也一起清:換局 / 離場時不可以留下半個爆炸。 */
  const FX_CLASS = ["eaten", "eject", "plop", "stomp"];
  function clearFx(){
    planeEls.forEach(row => row.forEach(el => el.classList.remove(...FX_CLASS)));
    const fx = $("fcFx");
    if(fx && fx.firstChild) fx.innerHTML = "";
    if(board) board.classList.remove("fc-quake");
    clearPv();      // ⚠ 落點預覽也是「中途狀態」:一手開始演了就不該再留著上一個落點
  }

  /* 撞擊特效:白光 + 擴散的圈 + 八道火花,擺在「踩到的那一格」的正中心。
     ⚠ 傳進來的 (x,y) 是**一架飛機的左上角**(posXY 全部都是這個約定)→ 中心要 +0.5。
     ⚠ 收尾用普通的 setTimeout **而不是** later():它只刪 DOM、不出聲也不推進局面,
       而 later() 會被 bump() 的世代記號擋掉 → 取消時反而變成刪不掉的殘骸
       (真正的取消路徑是 clearFx() 整層清掉)。 */
  function boom(x, y){
    const fx = $("fcFx");
    if(!fx) return;
    const el = document.createElement("div");
    el.className = "fc-boom";
    el.style.left = "calc(var(--fc-cell) * " + (x + 0.5) + ")";
    el.style.top  = "calc(var(--fc-cell) * " + (y + 0.5) + ")";
    let h = '<i class="fc-flash"></i><i class="fc-ring"></i>';
    for(let i = 0; i < 8; i++) h += '<i class="fc-spark" style="--a:' + (i * 45 + 12) + 'deg"></i>';
    el.innerHTML = h;
    fx.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /* ==========================================================================
     三之二、★ 一次性的小特效(起飛煙 / 落地塵 / 到家煙火 / 噴射尾跡)
     ──────────────────────────────────────────────────────────────────────────
       ⚠⚠ 全部丟進 .fc-fx(overflow:hidden),一個都不准直接掛在 .fc-board 上 ——
         起飛點與機場都貼著盤子的邊,噴出去就是把 .fc-stage(overflow:auto)的捲動
         範圍撐大 → 捲軸 → 下一次 fitBoard() 縮一階(紅線 19,與 boom 同一條)。
       ⚠ 尺寸一律 --fc-cell 的倍數,不可以寫死 px(格子從 13px 到 46px 差三倍半)。
       ⚠ 收尾用普通的 setTimeout **而不是** later():它們只刪 DOM、不出聲也不推進局面,
         而 later() 會被 bump() 的世代記號擋掉 → 取消時反而變成刪不掉的殘骸
         (真正的取消路徑是 clearFx() 整層清掉)。
     ========================================================================== */
  function mkFx(cls, x, y, inner, ms, color){
    const fx = $("fcFx");
    if(!fx) return null;
    const el = document.createElement("div");
    el.className = cls;
    if(color != null) el.dataset.c = color;
    el.style.left = "calc(var(--fc-cell) * " + (x + 0.5) + ")";
    el.style.top  = "calc(var(--fc-cell) * " + (y + 0.5) + ")";
    el.innerHTML = inner || "";
    fx.appendChild(el);
    setTimeout(() => el.remove(), ms);
    return el;
  }
  // 起飛出庫:尾端一陣煙(配 SFX.launch 的加速音)
  function puff(x, y, color){
    let h = "";
    for(let i = 0; i < 6; i++)
      h += '<i style="--a:' + (i * 60 + 20) + 'deg;--d:' + ((i % 3) * 45) + 'ms"></i>';
    mkFx("fc-puff", x, y, h, 760, color);
  }
  // 被彈回機場之後落地的塵環(第三段 plop 的那一下)
  function dust(x, y, color){ mkFx("fc-dust", x, y, "<i></i><i></i>", 640, color); }
  /* 到家:終點中央放一串四色小煙火。
     ★ 位置是盤面正中心 → 不會被 .fc-fx 裁到,可以噴得比撞擊還開。 */
  function cheer(x, y){
    let h = "";
    for(let i = 0; i < 14; i++)
      h += '<i data-c="' + (i % 4) + '" style="--a:' + (i * 26 + 9) + 'deg;--r:' +
           (1.2 + (i % 4) * 0.3).toFixed(2) + ';--d:' + ((i % 5) * 55) + 'ms"></i>';
    mkFx("fc-cheer", x, y, h, 1200);
  }
  /* ★★ 直飛 12 格的噴射尾跡。
     ★ 它不是憑空想像的一條線:飛機的位移是**一段線性的 transform**(place() 直接把
       translate 換成落點,由 transition 內插)—— 畫面上它真的是「破空穿過盤面」的
       一條直線,所以尾跡的角度與長度算的就是同一條線。
     ⚠ 外層只負責旋轉與長度,**會動的是裡面那個 `<i>`** —— 兩支動畫掛在同一個
       transform 上就是互相蓋掉(同 .fc-plane 那條紅線的道理)。 */
  function jet(from, to, color){
    const fx = $("fcFx");
    if(!fx || !from || !to) return;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if(!(len > 0.2)) return;
    const el = document.createElement("div");
    el.className = "fc-jet";
    el.dataset.c = color;
    el.style.left = "calc(var(--fc-cell) * " + (from.x + 0.5) + ")";
    el.style.top  = "calc(var(--fc-cell) * " + (from.y + 0.5) + ")";
    el.style.width = "calc(var(--fc-cell) * " + len.toFixed(3) + ")";
    el.style.transform = "rotate(" + (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2) + "deg)";
    el.innerHTML = "<i></i>";
    fx.appendChild(el);
    setTimeout(() => el.remove(), MS_FLY + 360);
  }

  /* ==========================================================================
     三之三、★★ 落點預覽 —— 這一架會停在哪、踩不踩得到人
     ──────────────────────────────────────────────────────────────────────────
       這一頁最大的決策負擔是「玩家得自己默數格子」:走完會不會踩到人、會不會剛好
       停在別人一擲就踩得到的格子上。而它同時是十四個裡**最多人不會玩**的一頁
       (見 notes/22 的「玩法說明」那一節)—— 看得到落點,規則就自己講完了一半。

     ★★★ 為什麼用 pointerover / pointerout 這一對:
       桌機是「滑過去看」,手機是「按住不放看」—— 而觸控上這一對事件正好在
       pointerdown / pointerup 時各發一次,**一份程式碼兩種裝置都成立**,
       而且不必發明新手勢:按住 → 看落點 → 手指移開就取消 → 在原地放開才真的走
       (click 只在「放開時還在同一架飛機上」才發得出來)。
       ⚠ 不要改成「第一下預覽、第二下確認」—— 那是把**每一手**都變成兩次點擊。
     ⚠ 同一架飛機的子元素之間移動(svg ↔ 座號)也會發 pointerout → 一定要看
       relatedTarget,不然預覽會在手指底下閃爍。
     ========================================================================== */
  let curCans = [], curSeat = -1, curColor = 0, pvOn = -1;

  function clearPv(){
    const pv = $("fcPv");
    if(pv && pv.firstChild) pv.innerHTML = "";
    pvOn = -1;
  }
  // 預覽層的零件:一個「格子中心」的座標點(同 boom:傳進來的是左上角 → 中心要 +0.5)
  function pvNode(tag, cls, x, y, color){
    const el = document.createElement(tag);
    el.className = cls;
    if(color != null) el.dataset.c = color;
    el.style.left = "calc(var(--fc-cell) * " + (x + 0.5) + ")";
    el.style.top  = "calc(var(--fc-cell) * " + (y + 0.5) + ")";
    return el;
  }
  function showPv(plane){
    if(animating || pvOn === plane) return;
    const pv = $("fcPv");
    let m = null;
    for(let i = 0; i < curCans.length; i++) if(curCans[i].plane === plane) m = curCans[i];
    if(!pv || !m || !shown || curSeat < 0) return;
    clearPv();
    pvOn = plane;
    const c = curColor;
    const fromQ = (shown[curSeat] || [])[plane] || 0;
    const steps = stepsOf(fromQ, m.hops);
    let prev = R.posXY(c, fromQ, plane);
    steps.forEach((s, k) => {
      const p = R.posXY(c, s.q, plane);
      /* 「飛」是一條**直線穿過盤面**(place 的 transition 就是線性內插)——
         不畫這條線的話玩家會以為是沿著外圈走過去的,而那是完全不同的 12 格。 */
      if(s.kind === "fly"){
        const dx = p.x - prev.x, dy = p.y - prev.y;
        const el = pvNode("div", "fc-pv-line", prev.x, prev.y, c);
        el.style.width = "calc(var(--fc-cell) * " + Math.sqrt(dx * dx + dy * dy).toFixed(3) + ")";
        el.style.transform = "rotate(" + (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2) + "deg)";
        pv.appendChild(el);
      }
      if(k < steps.length - 1) pv.appendChild(pvNode("i", "fc-pv-dot", p.x, p.y, c));
      prev = p;
    });
    /* 落點一個圈;**踩得到人就換成準心**(這是這個遊戲最爽的一件事,要用力講),
       走到終點換成金色(那一架就收工了)。 */
    const last = R.posXY(c, m.to, plane);
    pv.appendChild(pvNode("i", "fc-pv-t" + (m.eat ? " hit" : "") +
                               (m.to >= R.GOAL ? " goal" : ""), last.x, last.y, c));
  }

  /* 盤面挨一記。⚠⚠ **只准縮不准放、平移量必須小於縮掉的那一半**:
     盤子在舞台裡是量好的(fitBoard 讓它剛好放得下),往外長一個像素就會讓
     `.fc-stage` 冒出捲軸 → 再量一次就縮一階(同 .fc-fx 那一段的震盪)。
     scale ≤ 1 且 |translate| ≤ (1−scale)/2 的組合,外框永遠留在原本的框裡面。 */
  function quake(){
    if(!board) return;
    board.classList.remove("fc-quake");
    void board.offsetWidth;
    board.classList.add("fc-quake");
    setTimeout(() => { if(board) board.classList.remove("fc-quake"); }, 460);
  }

  // hops → 一步一步的清單(走格是一格一段,跳 / 飛各一段)
  function stepsOf(fromQ, hops){
    const out = [];
    let cur = fromQ;
    (hops || []).forEach(hp => {
      if(hp.kind === "walk"){
        for(let q = cur + 1; q <= hp.to; q++) out.push({ q: q, kind: "walk" });
      }else{
        out.push({ q: hp.to, kind: hp.kind });
      }
      cur = hp.to;
    });
    if(!out.length) out.push({ q: hops && hops.length ? hops[hops.length - 1].to : fromQ, kind: "walk" });
    return out;
  }
  const msOf = k => k === "fly" ? MS_FLY : k === "jump" ? MS_JUMP : k === "launch" ? MS_LAUNCH : MS_WALK;

  /* 走完一手要多久(adapter / solo 用它決定「下一步等多久」) */
  function animMs(fromQ, hops){
    return stepsOf(fromQ, hops).reduce((a, s) => a + msOf(s.kind), 0);
  }

  function runMove(st, mv, done){
    /* ⚠ 不可以走 bump():這裡是**接手**一段新動畫,舊的那個 onDone 要在這裡就交出去,
       但不能等到下一拍(下一拍時 pendingDone 已經是新的這一個了)。 */
    const prevDone = pendingDone; pendingDone = null;
    if(prevDone) setTimeout(() => { try{ prevDone(); }catch(e){} }, 0);
    const g = ++animGen;
    // ⚠ 這裡不走 bump(),所以上一手留下的特效 class 要自己收(見 clearFx 的註解)
    clearFx();
    animating = true;
    pendingDone = done || null;
    const seat = mv.seat, idx = mv.plane;
    const el = planeEls[seat] && planeEls[seat][idx];
    const fromQ = (shown && shown[seat]) ? shown[seat][idx] : 0;
    if(!el){ finish(); return; }        // finish() 自己會把 pendingDone 交出去

    // 先把「這一手沒有動到的飛機」擺到定位(被踩的那幾架先留在原地)
    const mid = st.planes.map(row => row.slice());
    mid[seat][idx] = fromQ;
    (mv.eaten || []).forEach(e => {
      const prev = (shown && shown[e.seat]) ? shown[e.seat][e.plane] : 0;
      mid[e.seat][e.plane] = prev;
    });
    placeAll(mid, st.colors, 0);

    const steps = stepsOf(fromQ, mv.hops);
    const myC = st.colors[seat];
    let k = 0, lastQ = fromQ;
    (function next(){
      if(g !== animGen) return;
      if(k >= steps.length){ land(); return; }
      const s = steps[k++];
      el.classList.toggle("hop", s.kind === "jump");
      el.classList.toggle("flying", s.kind === "fly");
      place(el, myC, s.q, idx, msOf(s.kind), 0, 1);
      const here = R.posXY(myC, s.q, idx);
      if(s.kind === "walk") SFX.tick();
      else if(s.kind === "fly"){
        SFX.fly();
        // ★ 尾跡畫的就是「這一段真的走的那條直線」(見 jet 的註解)
        jet(R.posXY(myC, lastQ, idx), here, myC);
      }
      else if(s.kind === "jump") SFX.jump();
      else if(s.kind === "launch"){ SFX.launch(); puff(here.x, here.y, myC); }
      lastQ = s.q;
      later(g, next, msOf(s.kind));
    })();

    /* ★★ 踩人的三段(重做)。原本只有「閃一下白 + 滑回機場」,
       使用者:「飛機被踩掉的動畫太差了…應該做的再誇張一點」。
       ① 挨打:被踩的那幾架**留在原地**被打歪 + 撞擊特效 + 盤面一震
          —— 同時飛回去的話看不出誰踩了誰(這一條從第一版就是對的,保留)
       ② 彈飛:一路翻滾兩圈回機場
       ③ 落地:壓扁再彈回來
       ⚠ 每一段的聲音都排在 later() 的世代守衛裡面(離場後不可以繼續響)。 */
    function land(){
      el.classList.remove("hop", "flying");
      if(mv.home){
        SFX.home();
        /* ★ 到家的小煙火。位置是**盤面正中心**(GOAL_XY + 0.5 = 7,7)—— 那裡離四個邊
           最遠,所以它是這一頁唯一可以放開噴、完全不會被 .fc-fx 裁到的特效。 */
        cheer(R.GOAL_XY.x, R.GOAL_XY.y);
      }
      if(mv.eaten && mv.eaten.length){
        const victims = mv.eaten.map(e => planeEls[e.seat] && planeEls[e.seat][e.plane]).filter(Boolean);
        // 撞擊點 = 踩人的那一架**停下來**的那一格(踩人只算停下來那一格,見規則)
        const hit = R.posXY(st.colors[seat], st.planes[seat][idx], idx);
        SFX.eat();
        boom(hit.x, hit.y);
        quake();
        el.classList.add("stomp");                       // 踩的人自己也踏一下(看得出是誰幹的)
        victims.forEach(ee => ee.classList.add("eaten"));
        later(g, () => {
          el.classList.remove("stomp");
          victims.forEach(ee => { ee.classList.remove("eaten"); ee.classList.add("eject"); });
          SFX.eject();
          placeAll(st.planes, st.colors, MS_EJECT);
          later(g, () => {
            victims.forEach(ee => { ee.classList.remove("eject"); ee.classList.add("plop"); });
            SFX.plop();
            // 摔進機場的那一下:每一架各噴一圈塵(位置 = 它自己那一格機場)
            (mv.eaten || []).forEach(e => {
              const hp = R.hangarXY(st.colors[e.seat], e.plane);
              dust(hp.x, hp.y, st.colors[e.seat]);
            });
            later(g, () => {
              victims.forEach(ee => ee.classList.remove("plop"));
              finish();
            }, MS_PLOP);
          }, MS_EJECT);
        }, MS_HIT);
        return;
      }
      placeAll(st.planes, st.colors, 0);
      finish();
    }
    function finish(){
      if(g !== animGen) return;
      animating = false;
      shown = st.planes.map(r => r.slice());
      shownColors = st.colors.slice();
      // ⚠ 先清掉再叫 —— 不清的話 bump() 之後會把同一個回呼再叫一次
      const d = pendingDone; pendingDone = null;
      if(d) d();
    }
  }

  /* ==========================================================================
     五、對外:畫一次
     ──────────────────────────────────────────────────────────────────────────
       view = {
         st,               replay 出來的局面(唯一真相)
         mySeat,           我坐哪(-1 = 觀看)
         can:[planeIdx],   現在我可以動哪幾架(空 = 不能動)
         cans:[legalMove], ★ 同一批的完整內容({plane,to,hops})—— 落點預覽與「踩得到」
                             那顆紅光要它;呼叫端本來就算了一次 legalMoves,整包傳過來
                             就不必在這裡再算一次。⚠ 沒傳也不會壞(只是沒有預覽)。
         anim:{...}|null,  ★ 這一手要不要演(批次同步一律 null)
         onDone            演完的回呼
       }
     ========================================================================== */
  function render(view){
    if(!board) return;
    const st = view.st;
    if(!st) return;
    build();
    ensurePlanes(st);
    fitBoard();
    /* ⚠ 手指還按在某一架飛機上時**不可以**把預覽弄掉 —— refresh / 改名字 / resize
       都會走到這裡。先記下來,畫完再原地重畫一次(那一手已經不合法就自然消失)。 */
    const keepPv = pvOn;

    // 可以動的那幾架加上提示;其餘一律拿掉(不用 disabled —— 點了要講得出原因)
    const can = view.can || [];
    curSeat = (view.mySeat == null) ? -1 : view.mySeat;
    curColor = (curSeat >= 0 && st.colors[curSeat] != null) ? st.colors[curSeat] : 0;
    /* 「這一手踩得到幾架」交給規則層算(eatCount 是純函式)—— 盤面不自己判命中。 */
    curCans = (curSeat >= 0 ? (view.cans || []) : []).map(m => ({
      plane: m.plane, to: m.to, hops: m.hops, eat: R.eatCount(st, curSeat, m) > 0
    }));
    const eats = {};
    curCans.forEach(m => { if(m.eat) eats[m.plane] = 1; });
    for(let s = 0; s < planeEls.length; s++)
      for(let i = 0; i < planeEls[s].length; i++){
        const el = planeEls[s][i];
        const mine = s === view.mySeat;
        el.classList.toggle("can", mine && can.indexOf(i) >= 0);
        el.classList.toggle("mine", mine);
        el.classList.toggle("home", st.planes[s][i] >= R.GOAL);
        /* ★ 這一架這個點數**踩得到人** → 呼吸光換成紅金色。
           踩人是這一局唯一「對某一個特定的人做壞事」的瞬間(notes/22 第一節),
           漏看它就等於這一手白擲了。 */
        el.classList.toggle("eat", mine && !!eats[i]);
      }
    // 誰的回合:那一家的機場亮起來
    [...board.querySelectorAll(".fc-hangar")].forEach(el => {
      el.classList.toggle("turn", !st.over && +el.dataset.c === st.colors[st.turn]);
    });

    const fresh = !shown || shown.length !== st.planes.length ||
                  (shown[0] && shown[0].length !== st.planes[0].length);
    if(view.anim && !fresh && shown){
      runMove(st, view.anim, view.onDone);
      return;
    }
    bump();
    placeAll(st.planes, st.colors, 0);
    shown = st.planes.map(r => r.slice());
    shownColors = st.colors.slice();
    if(keepPv >= 0) showPv(keepPv);      // ⚠ bump() 已經把它清掉了 → 重畫一次(見上面)
    if(view.onDone) view.onDone();
  }

  /* ★ 「輪到我了」的一次性提示(Gemini 建議的「回合焦點感」)。
     4 人局輪轉很快,現場常常是「大家在看別人對決 → 沒注意到已經輪到自己」。
     ⚠ 只做**一次性**的東西:常駐的呼吸光已經有兩處(骰子 .live + 自家機場 .turn),
       再加一個動不停的只是噪音。
     ⚠ 兩樣都走 box-shadow / filter —— 它們**不進捲動範圍**,所以不必關進 .fc-fx
       (紅線 19 管的是會撐大盒子的 transform)。 */
  function turnCue(){
    if(dieEl){
      dieEl.classList.remove("callme"); void dieEl.offsetWidth; dieEl.classList.add("callme");
      setTimeout(() => { if(dieEl) dieEl.classList.remove("callme"); }, 1100);
    }
    if(!board) return;
    const hg = board.querySelector('.fc-hangar[data-c="' + curColor + '"]');
    if(!hg) return;
    hg.classList.remove("cue"); void hg.offsetWidth; hg.classList.add("cue");
    setTimeout(() => hg.classList.remove("cue"), 1400);
  }

  /* ==========================================================================
     六、骰子與動作列
     ──────────────────────────────────────────────────────────────────────────
       ★ 骰子的點數是**別人給的**(住在 moves 裡),這裡只負責演。
         演完才顯示真值 —— 不可以自己 Math.random() 決定停在哪一面
         (那樣兩台會看到不一樣的點數)。
     ========================================================================== */
  const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
  function faceHTML(v){
    let h = "";
    for(let i = 0; i < 9; i++)
      h += '<i class="fc-pip' + (PIPS[v].indexOf(i) >= 0 ? " on" : "") + '"></i>';
    return h;
  }
  /* ==========================================================================
     ★★ 立體骰子:六個面一次建好,之後**只轉角度**,不再重畫點數
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 對面兩數和是 7(1-6 / 2-5 / 3-4)—— 真的骰子就是這樣排的,轉起來才不會
         露出馬腳(相鄰兩面同時看得到)。
       ⚠ 面的擺法寫在 CSS(`.fc-face[data-f]`),這裡只放它的**反矩陣**:
         面在 rotateY(90deg) → 骰子要 rotateY(-90deg) 才把那一面轉到正面。
         ★ 兩個角度刻意**不會同時非零** → 不必管旋轉順序(rotateX 與 rotateY 誰先都一樣)。
       ⚠⚠ 這一格是**視覺**,與規則無關:真值一律由呼叫端帶進來(點數住在 moves 裡)。
     ========================================================================== */
  const DIE_SHOW = { 1: [0, 0], 2: [90, 0], 3: [0, -90], 4: [0, 90], 5: [-90, 0], 6: [0, 180] };
  function cubeHTML(){
    let h = '<span class="fc-cube" id="fcCube">';
    for(let v = 1; v <= 6; v++)
      h += '<span class="fc-face" data-f="' + v + '">' + faceHTML(v) + "</span>";
    return h + "</span>";
  }

  let dieEl = null, cubeEl = null, rollT = null, rollGen = 0, rollDone = null;
  /* 累積的整圈數,**只增不減** → 骰子永遠往同一個方向翻:每換一面就多轉一整圈,
     看起來才是「連續在滾」而不是「跳」到下一面。 */
  let spinX = 0, spinY = 0;
  function setDie(v){
    if(!dieEl) return;
    const n = v || 0;
    dieEl.dataset.v = n;                 // ★ 真值仍然掛在 data-v(診斷 / e2e 讀這個)
    if(!cubeEl) return;
    const r = DIE_SHOW[n] || DIE_SHOW[1];
    /* ⚠⚠ 開頭那個 translateZ(−半個骰子) **一定要跟著寫**:perspective 的參考平面是
       z=0,正面若停在 +半個骰子 就會被放大 —— 量過是 **1.17 倍**(骰子看起來比它的
       盒子大一圈,`.live` 的光圈與版面全部對不上)。
       ⚠ CSS 的 `.fc-cube` 裡也有一份同樣的預設值,但**這一行會整個蓋掉它**(inline)
         → 漏寫的症狀只有量才看得出來(t-fc-look 的 dieBox=192/225)。
       ⚠ 順序是「先轉、再往後推」(transform 由右往左作用)→ 骰子仍然在原地翻。 */
    cubeEl.style.transform = "translateZ(calc(var(--fc-d) / -2)) " +
                             "rotateX(" + (r[0] + spinX * 360) + "deg) " +
                             "rotateY(" + (r[1] + spinY * 360) + "deg)";
  }
  /* ==========================================================================
     擲骰的聲音 —— 一次擲 = 一顆音效(v2.x 起是真的骰子錄音)
     ──────────────────────────────────────────────────────────────────────────
       ★ 使用者自己找了一個骰子音效丟進來。真實的骰子聲本來就是「一段滾動 + 落定」,
         所以**不再是「每亂跳一面配一聲」** —— 那是沒有音檔時才需要的湊法,
         疊在真的錄音上只會糊成一片。
       ⚠⚠ 抓來的音檔有兩個一定要修的毛病,兩個都在 def() 的 opts 修(不動原始檔,
         換一個檔進來程式照樣能用):
           gain 0.62   原檔峰值正規化到 1.0 → 量到是全遊戲最大聲那顆(輪到你)的
                       **5.94 倍**,直接放會蓋掉其他所有聲音。0.62² ≈ 0.38 → 收到 2.3 倍。
           offset 0.12 原檔開頭有 0.14 秒**靜音** → 不跳過的話「按下去 → 停半拍 → 才出聲」,
                       感覺像沒按到。留 20ms 不切,免得吃掉起音。
       ★ 沒有音檔時(檔案被刪 / 離線第一次還沒載到)退回 rollSynth,節奏與音檔對齊,
         聽起來是同一件事 —— 音效槽的設計本來就是「有檔就播檔」。
       ⚠ 動 mp3 的路徑要**兩處一起改**:這裡的 DICE_FILES 與 sw.js 的 CORE
         (CLAUDE.md 的紅線;這一頁沒有 sfx.js,也沒有會碰到音檔的產生器)。
     ========================================================================== */
  /* 亂跳幾面。★ 8 面 = 728ms,而音檔跳掉開頭靜音之後**剛好在 ~740ms 衰乾淨** ——
     骰子停下來的那一刻,聲音也正好收掉。改任何一邊都要重新對(量法見 notes/22 第 12.1)。 */
  const SPINS = 8;
  const DICE_FILES = ["mp3/fc/dice.mp3"];
  let diceDefed = false, dicePrimed = false;
  /* 後備:整趟自己排完(rattle × SPINS + 落定),時間點與上面那串亂跳一模一樣。
     ⚠ 用 tone() 的 delay 排在 AudioContext 的時間軸上,**不要用 setTimeout** ——
       背景頁籤被節流時整句會散掉(同大老二那條)。 */
  function rollSynth(){
    let t = 0;
    for(let k = 1; k <= SPINS; k++){ SFX.rattle(k, t); t += (55 + k * 8) / 1000; }
    SFX.dice(t);
  }
  function ensureDiceDef(){
    if(diceDefed || typeof Sound === "undefined" || !Sound.def) return;
    diceDefed = true;
    Sound.def("fcDice", DICE_FILES, rollSynth, { el: true, gain: 0.62, offset: 0.12 });
  }
  /* 先載好但不播。⚠ 不先載的話**這一局的第一次擲骰**一定是後備合成音(懶載入,
     音檔還在飛)—— 而那一顆聽起來與其他次不一樣,像是「有時候有音效有時候沒有」。
     ★ 掛在 renderActs():它只在對局中被叫,那時一定已經有過使用者手勢。 */
  function primeDice(){
    if(dicePrimed || typeof Sound === "undefined" || !Sound.prime) return;
    dicePrimed = true;
    ensureDiceDef();
    Sound.prime("fcDice");
  }

  /* 擲骰動畫:亂跳幾面之後停在真值。done 在停下來的那一刻叫。
     ⚠ 亂跳的那幾面只是**視覺**,與規則無關(真值是參數帶進來的)。
     ⚠⚠ 聲音是**一顆一次性的音效,在最前面就放掉**(不像動畫有世代記號可以攔)——
       擲到一半離開棋局的話,那 0.7 秒會自己播完。這與紅線 9 不衝突:紅線 9 擋的是
       「人都回到選單了,骰子還繼續轉、**轉完再叫一聲**」那種**計時器鏈**;
       這裡離場之後不會再有任何**新的**聲音發出來(t-fc-solo-e2e 的 F 節量的就是這個)。 */
  function rollDie(v, done){
    // ★ 同 runMove:接手新的一段之前,先把上一段沒交出去的回呼交出去
    const prevDone = rollDone; rollDone = null;
    if(prevDone) setTimeout(() => { try{ prevDone(); }catch(e){} }, 0);
    const g = ++rollGen;
    if(rollT){ clearTimeout(rollT); rollT = null; }
    if(!dieEl){ if(done) done(); return; }
    rollDone = done || null;
    dieEl.classList.add("rolling");
    ensureDiceDef();
    if(typeof Sound !== "undefined" && Sound.sfx) Sound.sfx("fcDice"); else rollSynth();
    let k = 0;
    (function spin(){
      if(g !== rollGen) return;
      if(k++ >= SPINS){
        dieEl.classList.remove("rolling");
        dieEl.classList.add("land");     // 落定那一下的轉場曲線彈一點(是 transition 不是動畫)
        setDie(v);
        dieEl.classList.remove("pop"); void dieEl.offsetWidth; dieEl.classList.add("pop");
        setTimeout(() => { if(dieEl) dieEl.classList.remove("land"); }, 480);
        // ★ 「擲到 6 可以再擲一次」是規則的回饋:金光 + 向上兩音(音域刻意差很遠)
        if(v === 6){
          SFX.six();
          dieEl.classList.remove("six"); void dieEl.offsetWidth; dieEl.classList.add("six");
          setTimeout(() => { if(dieEl) dieEl.classList.remove("six"); }, 1000);
        }
        const d = rollDone; rollDone = null;
        if(d) d();
        return;
      }
      // 翻滾:每一下多轉一整圈,兩軸交替 —— 只轉一軸看起來是「左右擺」而不是在滾
      if(k % 2) spinX++; else spinY++;
      setDie(1 + (k * 3 + 2) % 6);
      rollT = setTimeout(spin, 55 + k * 8);
    })();
  }

  /* 動作列:骰子鈕 + 一句話 + 倒數環 */
  function renderActs(o){
    if(!acts) return;
    primeDice();                     // ★ 對局中才會走到這裡 = 一定已經有過使用者手勢
    if(!acts.dataset.built){
      acts.dataset.built = "1";
      acts.innerHTML =
        '<button class="fc-die" id="fcDie" type="button" aria-label="擲骰子">' + cubeHTML() + "</button>" +
        '<div class="fc-hint" id="fcHint"></div>' +
        '<div class="fc-cdwrap" id="fcCdWrap"></div>';
      dieEl = $("fcDie");
      cubeEl = $("fcCube");
      dieEl.addEventListener("click", () => { if(cb.onDice) cb.onDice(); });
      setDie(0);
    }
    acts.classList.remove("hidden");
    const die = $("fcDie"), hint = $("fcHint");
    if(die){
      die.classList.toggle("live", !!o.canRoll);
      die.classList.toggle("idle", !o.canRoll);
      die.disabled = false;                       // ★ 不用 disabled:點了要講得出原因
    }
    if(hint) hint.innerHTML = o.hint || "";
    syncCd(o.cdMs, o.cdEnd);
  }

  /* ---------- 出手倒數的環 ----------
     ★★ 與台灣麻將 / 21 點 / UNO / 暗棋**同一顆**(SVG 環圈 + 中間秒數,最後 3 秒轉紅脈動)——
       關鍵影格直接沿用共用的 m16cd / m16beat / m16cdhot,**不再定義一份同名的環**
       (同一件事只有一種畫法)。
       ⚠ v1.179.1 之前這裡是一條橫的進度條,與另外幾頁長得不一樣,而且要在動作列上方
         多留一條的高度。使用者:「不要用這種方式…可以省掉那一條進度條的空間」。

     ★ 全桌都看得到,不是只有當事人 —— 「輪到誰、還剩幾秒」是公開資訊,
       大家才知道為什麼卡著(判準同台灣麻將 / 排七)。

     ⚠ 兩個從台灣麻將 / 21 點繼承的坑:
       ① 用**負的 animation-delay** 接續播放,duration 永遠是這一手的總長
          —— 這樣 e2e 才量得到設定值(量 --cd-dur)。
       ② 去重的 key **不可以看 cdT 還在不在**:數字走到 0 之後 tickCd() 就把 interval
          停了,而 timer 本身還有幾百毫秒沒響;那段空窗裡只要再叫一次 renderActs()
          (resize 就會)環就會彈回滿格,而那個彈跳本身就是雜訊。
     ⚠ 這裡的環是**每次 renderActs 都重建的節點**(同 21 點 / 暗棋,不是 m16 的持久節點)——
       重建照樣接得上,靠的就是①那個負延遲。 */
  const CD_HOT = 3000;
  function syncCd(cdMs, endAt){
    const box = $("fcCdWrap");
    if(!box) return;
    if(!cdMs || !endAt){ stopCd(); return; }
    const left = endAt - Date.now();
    if(left <= 0){ stopCd(); return; }
    const key = cdMs + ":" + endAt;
    cdEnd = endAt;
    box.innerHTML =
      '<span class="fc-cd' + (left <= CD_HOT ? " fc-hot" : "") + '" id="fcCd" aria-hidden="true"' +
        ' style="--cd-dur:' + (cdMs / 1000) + 's;--cd-delay:' + (-(cdMs - left) / 1000) + 's">' +
        '<svg viewBox="0 0 40 40"><circle class="fc-cdbg" cx="20" cy="20" r="17"/>' +
        '<circle class="fc-cdfg" cx="20" cy="20" r="17"/></svg>' +
        '<b class="fc-cdn">' + Math.ceil(left / 1000) + '</b>' +
      '</span>';
    if(key === cdKey && cdT) return;          // 同一段倒數:重畫畫面不重跑動畫
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(tickCd, 200);
  }
  /* 只換中間那個數字與 hot 狀態 —— 環圈本身完全交給 CSS 動畫(理由見上面①) */
  function tickCd(){
    const el = $("fcCd");
    if(!el){ if(cdT){ clearInterval(cdT); cdT = null; } return; }
    const left = cdEnd - Date.now();
    const n = el.querySelector(".fc-cdn");
    const s = String(Math.max(0, Math.ceil(left / 1000)));
    if(n && n.textContent !== s){
      n.textContent = s;
      n.classList.remove("fc-beat"); void n.offsetWidth; n.classList.add("fc-beat");
    }
    el.classList.toggle("fc-hot", left <= CD_HOT);
    if(left <= 0){ clearInterval(cdT); cdT = null; }
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = ""; cdEnd = 0;
    const box = $("fcCdWrap");
    if(box) box.innerHTML = "";
  }

  /* ==========================================================================
     七、★★ 踩人 / 到家的「現場效果」
     ──────────────────────────────────────────────────────────────────────────
       這是這個遊戲被做出來的理由之一(見 notes/22 第一節):飛行棋是十三個裡
       **唯一「對某一個特定的人做壞事」有明確瞬間**的遊戲 —— 其他遊戲的勝負是抽象的
       (誰先連成五子、誰先出完牌),這裡有一個具體的受害者。

     ★★★ **完全在本地做,一個 DB 寫入都沒有。**
       「誰踩了誰」在 `moves` 裡是公開的,每一台各自 replay 都算得出同一件事
       → 走 `MP.sendEmote()` 的話會變成**N 台各送一次**(畫面上飛出 N 顆一樣的表情),
         而且要多付 N 次 Firebase 寫入。這一點與「表情是使用者按出來的」正好相反,
         不要因為「表情本來就走 sendEmote」就順手改過去。

     ⚠⚠⚠ **這裡不可以自動播罐頭語音(v1.179.7 拿掉)。**
       v1.179.1~v1.179.6 曾經在「我踩到人 / 我被踩」時自動放一句罐頭
       (`enqueueClip(EAT_CLIPS[…])`),使用者的結論是:
         「我還是比較希望這是自己去按出來,才會覺得好笑」
       —— **罐頭語音的笑點在「是誰、在什麼時機按的」**,自動放出來只是音效,
       而且是系統替你嗆別人,反而把那個哏用掉了。
       ⚠ 它同時也是 v1.179.6 那個當機的病灶(自動語音是整個專案裡**唯一**會在對局
         中途自己碰音訊子系統的地方,而 iOS 的音訊解鎖 / 語音閘門最容易出事)——
         但**拿掉的理由是體驗,不是為了修 bug**:v1.179.6 的三道保險原封不動留著,
         別的裝飾哪天丟例外照樣擋得住。
       → 現場效果現在只剩**看得到的**那兩樣:表情飛出(全場)+ 震動(只有被踩的人)。
       ★ 罐頭語音仍然在,只是**一律由使用者自己按**(表情面板 / 快速語音鈕),
         與另外十一個遊戲同一套。

     ★★★ **完全在本地做,一個 DB 寫入都沒有。**
       「誰踩了誰」在 `moves` 裡是公開的,每一台各自 replay 都算得出同一件事
       → 走 `MP.sendEmote()` 的話會變成**N 台各送一次**(畫面上飛出 N 顆一樣的表情),
         而且要多付 N 次 Firebase 寫入。
     ⚠ 單機也吃這一段(showEmote 在 ui-kit,與連線同一份)。
     ========================================================================== */

  /* ⚠⚠ **這幾件事全是裝飾,一個都不准把例外丟回呼叫端(v1.179.6)。**
     呼叫端(adapter 的 applyOne)正站在「唯一能放掉 busy、也是唯一會武裝倒數代打的
     那個回呼」前面 —— 這裡丟一個例外就等於整台棋局停擺,而畫面上的症狀是
     **兩台都說輪到對方**(現場回報過)。
     ⚠ **各自**包而不是整段包:震動壞掉不該連表情也一起不見。
     ⚠ 例外照樣 console.error 出來:吞掉不等於當作沒發生過。 */
  function safe(what, fn){ try{ fn(); }catch(e){ console.error("fc drama:" + what, e); } }

  function drama(o){
    if(!o) return;
    if(o.kind === "eat"){
      /* who 傳被踩的那個人:表情飛出的發位是「同一個人 2.6 秒內沿用同一條」,
         傳受害者才會讓「連續被踩」在畫面上串成一條(efLane 的設計)。 */
      safe("emote", () => showEmote("💥", esc(o.byName) + " 踩掉 " + esc(o.toName),
                                    o.toId || o.toName, "emoji"));
      // 被踩的是我 → 手機震一下(單純的音效在吵的場合聽不到)
      if(o.victim) safe("buzz", buzz);
    }else if(o.kind === "home"){
      safe("emote", () => showEmote("🏁", esc(o.byName) + " 有一架到家了",
                                    o.byId || o.byName, "emoji"));
    }
  }
  /* ★ 震動的節奏刻意對著畫面的三段:短一下(挨打)→ 停 → 長一下(摔回機場)。
     ⚠ 原本是 [18,40,18](兩下一樣短),在手上只讀得到「抖了一下」,分不出被踩還是別的通知。 */
  function buzz(){
    try{ if(typeof vibrateOn !== "undefined" && vibrateOn && navigator.vibrate) navigator.vibrate([30, 45, 85]); }catch(e){}
  }

  /* ==========================================================================
     八、排名表
     ──────────────────────────────────────────────────────────────────────────
       ★ 單機與連線共用同一支 —— 兩邊各寫一份的話,欄位與措辭一定會慢慢走鐘
         (而且走鐘了兩邊各自都不會壞,沒有東西抓得到)。
       wins 有值 = 連線(顯示累計名次分);沒有 = 單機(顯示這一局拿幾分)。
     ========================================================================== */
  function resultHTML(sc, nameArr, meSeat, foot, wins){
    let h = '<table class="fc-rank"><thead><tr><th>名次</th><th>玩家</th><th>到家</th><th>進度</th>' +
            (wins ? "<th>累計</th>" : "<th>本局</th>") + "</tr></thead><tbody>";
    sc.sorted.forEach(r => {
      const nm = (nameArr && nameArr[r.seat] != null) ? nameArr[r.seat] : ("玩家" + (r.seat + 1));
      const w = wins && wins[r.seat];
      h += '<tr class="' + (r.seat === meSeat ? "me" : "") + (r.rank === 1 ? " top" : "") + '">' +
             "<td>" + (r.rank === 1 ? "🏆" : r.rank) + "</td>" +
             '<td><span class="fc-dot" data-c="' + r.color + '"></span>' + esc(nm) + "</td>" +
             "<td>" + r.home + "</td>" +
             "<td>" + r.prog + "</td>" +
             "<td>" + (w ? (w.n + (w.plus ? (' <b class="fc-plus">+' + w.plus + "</b>") : ""))
                         : ("+" + r.pts)) + "</td>" +
           "</tr>";
    });
    h += "</tbody></table>";
    if(foot) h += '<div class="fc-rank-foot">' + esc(foot) + "</div>";
    return h;
  }

  /* ==========================================================================
     九、掛載
     ========================================================================== */
  function mount(o){
    cb = o || {};
    board = $("fcBoard"); stage = $("fcStage"); acts = $("fcActs");
    if(!board) return;
    build();
    // 點飛機:一律綁在盤面上(飛機是動態產生的)
    board.addEventListener("click", e => {
      const el = e.target.closest(".fc-plane");
      if(!el || !cb.onPlane) return;
      cb.onPlane(+el.dataset.plane, +el.dataset.seat);
    });
    /* 落點預覽:桌機滑過去、手機按住不放 —— 同一對事件(見第三之三節的註解) */
    board.addEventListener("pointerover", e => {
      const el = (e.target && e.target.closest) ? e.target.closest(".fc-plane.can") : null;
      if(el) showPv(+el.dataset.plane);
    });
    board.addEventListener("pointerout", e => {
      const from = (e.target && e.target.closest) ? e.target.closest(".fc-plane") : null;
      if(!from) return;
      const rel = e.relatedTarget;
      const to = (rel && rel.closest) ? rel.closest(".fc-plane") : null;
      if(to === from) return;      // ⚠ 只是在同一架的子元素之間移動 → 不要清(會閃)
      clearPv();
    });
    board.addEventListener("pointercancel", clearPv);
    let rt = null;
    window.addEventListener("resize", () => {
      if(rt) clearTimeout(rt);
      rt = setTimeout(fitBoard, 90);
    });
    fitBoard();
  }

  function reset(){
    bump();
    /* ⚠⚠ 擲骰動畫有**自己的**世代記號(rollGen)與 timer —— bump() 只管棋子那一半。
       少了這兩行的症狀:骰子轉到一半時離開棋局,那顆骰子會**繼續轉完並且叫一聲**
       (人已經回到選單了)。這正是 t-fc-solo-e2e 的 F 節抓到的東西。 */
    rollGen++;
    if(rollT){ clearTimeout(rollT); rollT = null; }
    if(dieEl) dieEl.classList.remove("rolling");
    // 落定 / 幸運 6 / 輪到你 那三個一次性 class 也要收(它們各自帶自己的 setTimeout)
    if(dieEl) dieEl.classList.remove("pop", "land", "six", "callme");
    // ★ 與 bump() 同一條規矩:取消動畫也要把回呼交出去,否則呼叫端的 busy 永遠不會清
    const rd = rollDone; rollDone = null;
    if(rd) setTimeout(() => { try{ rd(); }catch(e){} }, 0);
    stopCd();
    curCans = []; curSeat = -1;
    shown = null; shownColors = null;
    if(board){ board.dataset.pk = ""; planeEls.forEach(r => r.forEach(el => el.remove())); planeEls = []; }
    setDie(0);
  }

  return {
    mount, render, renderActs, fitBoard, reset, resultHTML, drama,
    rollDie, setDie, animMs, stopCd, turnCue,
    busy: () => animating,
    cell: () => cell,
    // 給 e2e 用:落點預覽本來只有指標事件叫得動(headless 造不出「按住不放」)
    _pv: plane => (plane == null ? clearPv() : showPv(plane)),
    _pvOn: () => pvOn
  };
})();

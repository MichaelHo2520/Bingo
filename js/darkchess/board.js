"use strict";

/* ============================================================================
   象棋暗棋 — 盤面(DCB):自繪棋子 / 點擊流程 / 音效 / 結果卡
   對外只暴露 DCB;不依賴 Firebase,單機與連線**共用這一整支**。

   ── ★ 為什麼整盤重畫 ────────────────────────────────────────────────────
     只有 32 格。五子棋那套(絕對定位 + transform 縮放 + 只 append 新棋子)是為了
     15×15~29×29 的盤面與拖曳手勢;這裡照抄只會多一堆狀態要同步。
     一手一次 innerHTML,量起來 < 1ms。

   ── ★★ 轉向:直立 4 欄 × 8 列、橫置 8 欄 × 4 列 ─────────────────────────
     規則層的座標**永遠是 4 列 × 8 行**(見 rules.js 第一節),轉向只發生在這裡:
     直立時把盤面**旋轉 90°**(不是轉置 —— 轉置會左右鏡射,盤面看起來會「翻面」)。
     ⚠ ResizeObserver 只在**方向真的改變**時才重畫 ——
       每次 resize 都重畫會與「重畫改變了尺寸」形成迴圈(v1.111.1 的宣告面板踩過)。

   ── ★★★ 牌情紅線(這一頁唯一的一條)────────────────────────────────────
     ★ 暗棋底下是什麼,翻開之前畫面上**一個字都不准出現** —— 連 title / data-* 都不行。
       st.cells[i].p 對沒翻開的格也是真值(連線的 DB 是明碼),所以這條要靠
       renderCell() 自己守:!up 的格一律只畫牌背,連摸都不要摸 c.p。
     守門是 tools/test-pages.js 的 H 節(掃 #dcBoard 的 outerHTML 有沒有出現
     還沒翻開的棋子名稱)。

   ⚠ $ 定義在 js/shared/ui-kit.js(一律最先載入),本檔不可再宣告一次 ——
     同一詞法作用域重複宣告 const 會整頁 SyntaxError。
   ========================================================================== */

const DCB = (function(){

  let board = null, stage = null, acts = null;
  let actCb = null;
  let sel = -1;                       // 目前選中的格(-1 = 沒選)
  let cur = null;                     // 最近一次 setState 的參數
  let lastKey = -1;                   // 上一次畫的手數(決定要不要播翻牌動畫)
  let wide = true;                    // 目前是不是橫向排法(8 欄)
  let cdT = null, cdKey = "", cdEnd = 0;   // 走棋倒數的環:用 key 去重,不看 timer(見 syncCd)
  /* ★ 翻牌動畫的一次性開關:見 pieceHTML() 的註解 —— 由 paint() 在畫到「這一手剛翻開
     的那一格」之前設成 true,pieceHTML() 讀到就消費掉(改回 false),避免吃子欄 /
     結果卡之後再呼叫 pieceHTML() 時被誤套上翻牌動畫。 */
  let pendingFlip = false;

  /* ==========================================================================
     一、音效 —— 全部用合成音,不進 mp3/
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 刻意不加音檔:動 mp3/ 要四處一起改(sfx 的 ensureDefs、sw.js 的 CORE、
         兩支產生器),而暗棋這幾個聲音用合成音就夠了。
     ========================================================================== */
  const sfx = {
    flip(){ Sound.tone(880, { type: "triangle", dur: 0.07, vol: 0.16, slideTo: 1180 }); },
    move(){ Sound.tone(520, { type: "triangle", dur: 0.09, vol: 0.15, slideTo: 660 }); },
    eat(){  Sound.tone(300, { type: "sine", dur: 0.12, vol: 0.30, slideTo: 150 });
            Sound.tone(760, { type: "square", dur: 0.05, vol: 0.09, delay: 0.01 }); },
    // 連吃:第 n 顆比第 n-1 顆高一階(玩家聽得出「還在吃」)
    chain(n){ const f = 520 + Math.min(6, n) * 90;
              Sound.tone(f, { type: "triangle", dur: 0.10, vol: 0.24, slideTo: f * 1.5 }); },
    cannon(){ Sound.tone(180, { type: "sawtooth", dur: 0.16, vol: 0.26, slideTo: 70 });
              Sound.tone(1200, { type: "square", dur: 0.04, vol: 0.10 }); },
    stop(){ Sound.tone(440, { type: "sine", dur: 0.10, vol: 0.14, slideTo: 330 }); }
  };

  /* 走「前後兩份的 diff」而不是在動作點插 sfx.xxx() ——
     單機與連線的動作路徑完全不同,但「有人吃了一顆」在兩邊是同一個 diff。 */
  function moveSfx(st){
    const L = st && st.last;
    if(!L) return;
    if(L.kind === "flip"){ sfx.flip(); return; }
    if(L.kind === "move"){ sfx.move(); return; }
    if(L.kind === "stop"){ sfx.stop(); return; }
    if(L.kind === "darkSelf"){ sfx.flip(); return; }
    /* ★ 翻攻吃不動(v1.120.x 起兩顆都活,不再被反吃)—— 跟 darkSelf 一樣是
       「白花一手,沒有賠掉任何東西」,不是 oops。 */
    if(L.kind === "darkMiss"){ sfx.flip(); return; }
    /* ★ 炮打到自己人(v1.118.0 起兩顆都活)—— 開了一炮、只翻開一顆,所以是
       「炮聲 + 翻棋聲」而**不是** oops:沒有賠掉任何東西,只是白花一手。 */
    if(L.kind === "jumpSelf"){ sfx.cannon(); sfx.flip(); return; }
    if(L.kind === "jump"){ sfx.cannon(); return; }
    if(st.chainLen > 1) sfx.chain(st.chainLen);
    else sfx.eat();
  }

  /* ==========================================================================
     二、棋子自繪
     ──────────────────────────────────────────────────────────────────────────
       ★ 用的是「帥仕相俥傌炮兵 / 將士象車馬包卒」這些**常用漢字** ——
         不是 CLAUDE.md 紅線 8 禁的 U+1F000 那一段(那些多數字型沒有,會變豆腐)。
     ========================================================================== */
  /* ★ pendingFlip 是「這一格是不是這一手剛翻開的」的一次性開關(見上面宣告處的註解)。
     ⚠⚠⚠ 牌情紅線的守門(tools/test-pages.js H 節)逐字比對畫格子那一行是
       `c.up ? pieceHTML(c.p) : backHTML()`,所以**不能**改成 pieceHTML(p, flip) 這種
       多帶一個參數的寫法 —— 呼叫點的字要原封不動。改用模組變數讓 pieceHTML 自己讀,
       paint() 只在要畫「剛翻開那一格」的前一刻把它撥成 true,畫完立刻被這裡消費掉。 */
  function pieceHTML(p){
    const side = DC.sideOf(p);
    const face = '<span class="dc-p ' + (side === DC.RED ? "dc-red" : "dc-blk") + '">' +
                   '<i class="dc-ring"></i><b class="dc-ch">' + DC.nameOf(p) + '</b>' +
                 '</span>';
    if(!pendingFlip) return face;
    pendingFlip = false;                       // 消費一次:吃子欄 / 結果卡再畫同一顆子不會誤套
    /* 雙面卡片翻轉:背面那張臉**不掛 .dc-back**(它已經翻開了,不能被算進還蓋著幾顆),
       只掛 .dc-backface 拿視覺 —— 兩張臉共用同一份「木頭牌背」樣式,見 styles.css。 */
    return '<span class="dc-flip3d dc-flip-in">' +
             '<span class="dc-face dc-face-b dc-p dc-backface" aria-hidden="true">' +
               '<i class="dc-ring"></i><b class="dc-grain"></b></span>' +
             '<span class="dc-face dc-face-f" aria-hidden="true">' + face + '</span>' +
           '</span>';
  }
  // 牌背。★ 這裡**碰都不要碰** c.p —— 見檔頭的牌情紅線
  function backHTML(){
    return '<span class="dc-p dc-back dc-backface" aria-label="暗棋"><i class="dc-ring"></i><b class="dc-grain"></b></span>';
  }

  /* ==========================================================================
     三、畫盤面
     ========================================================================== */
  // 這一格在畫面上的 grid 位置。★ 直立時整盤旋轉 90°(不是轉置)
  function gridAt(i){
    const r = DC.rowOf(i), c = DC.colOf(i);
    return wide ? { row: r + 1, col: c + 1 }
                : { row: c + 1, col: DC.ROWS - r };
  }

  function pickOrient(){
    if(!stage) return wide;
    const w = stage.clientWidth, h = stage.clientHeight;
    if(!w || !h) return wide;                       // 還沒顯示(hidden)→ 維持原樣
    /* 盤面比例 2:1。哪一種排法能得到比較大的格子就用哪一種。
       ⚠ 用「算得出來的格子邊長」比大小,不要用 w > h —— 上下還有動作列與房間框,
         舞台本身常常是接近正方形的。 */
    const a = Math.min(w / DC.COLS, h / DC.ROWS);   // 橫排(8 欄 × 4 列)
    const b = Math.min(w / DC.ROWS, h / DC.COLS);   // 直排(4 欄 × 8 列)
    return a >= b;
  }

  /* ★★ 盤面尺寸**用 JS 算成整數 px**,不靠 CSS 的 aspect-ratio。
     理由:在 flex 置中容器裡,`aspect-ratio` 同時吃 max-width 與 max-height 時,
     被夾住的那一邊不會把另一邊帶著縮 → 盤面比例會被壓歪(而且只有截圖看得出來)。
     ⚠ 這不會與 ResizeObserver 形成迴圈:.dc-stage 是 `flex:1 1 0`,
       尺寸完全由父層分配,子元素多大都回頭撐不到它。 */
  const GAP = 4, PAD = 5, MIN_CELL = 20;
  function fitBoard(){
    if(!board || !stage) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    if(!w || !h) return;
    const cols = wide ? DC.COLS : DC.ROWS, rows = wide ? DC.ROWS : DC.COLS;
    const cw = (w - PAD * 2 - GAP * (cols - 1)) / cols;
    const ch = (h - PAD * 2 - GAP * (rows - 1)) / rows;
    const cell = Math.max(MIN_CELL, Math.floor(Math.min(cw, ch)));
    board.style.width  = (cell * cols + GAP * (cols - 1) + PAD * 2) + "px";
    board.style.height = (cell * rows + GAP * (rows - 1) + PAD * 2) + "px";
    board.style.setProperty("--dc-cell", cell + "px");
  }

  function paint(){
    if(!board || !cur || !cur.st) return;
    const st = cur.st;
    const mySide = (typeof cur.mySide === "number") ? cur.mySide : -1;
    const canAct = !!cur.mine && !cur.over && !st.over;

    // 這一手能點哪些格
    const tgtMap = {};
    let chainOn = st.chainFrom >= 0;
    if(canAct){
      if(chainOn){
        sel = st.chainFrom;
        DC.chainTargets(st).forEach(t => { tgtMap[t.to] = t.kind; });
      }else if(sel >= 0){
        DC.moveTargets(st, sel).forEach(t => { tgtMap[t.to] = t.kind; });
      }
    }else{
      sel = -1;
    }

    const fresh = (cur.key !== lastKey);
    const L = st.last;
    board.style.setProperty("--dc-cols", String(wide ? DC.COLS : DC.ROWS));
    fitBoard();

    const out = [];
    for(let i = 0; i < DC.NSQ; i++){
      const g = gridAt(i), c = st.cells[i];
      const cls = ["dc-sq"];
      if(!c) cls.push("dc-empty");
      if(i === sel) cls.push("dc-sel");
      if(tgtMap[i]) cls.push("dc-tgt", "dc-t-" + tgtMap[i]);
      if(L && fresh && (L.to === i)) cls.push("dc-hit");
      if(L && L.from === i && !c) cls.push("dc-from");
      // ★ 這一格是不是「這一手剛翻開」——pieceHTML() 讀這個模組變數決定要不要播翻牌動畫
      pendingFlip = !!(c && c.up && fresh && L && REVEAL_KINDS[L.kind] && L.to === i);
      out.push('<button type="button" class="' + cls.join(" ") + '" data-sq="' + i +
               '" style="grid-row:' + g.row + ';grid-column:' + g.col + '">' +
               (c ? (c.up ? pieceHTML(c.p) : backHTML()) : "") +
               "</button>");
    }
    pendingFlip = false;           // ⚠ 迴圈外的 pieceHTML() 呼叫(吃子欄、結果卡)一律不套
    board.innerHTML = out.join("");
    board.classList.toggle("dc-mine", canAct);
    lastKey = cur.key;
    renderActs(chainOn, canAct, mySide);
    /* ⚠⚠ 一定要**再算一次**:動作列的高度會隨內容變(連吃那一列比平常多一行),
       而它變高就把舞台壓矮 —— 上面那次 fitBoard() 是在 renderActs() **之前**算的,
       用的是舊高度 → 盤面溢出舞台,而 .dc-stage 是 overflow:hidden,
       溢出的那一截**被靜靜削掉**(截圖才看得出來,量 rect 也看得出來)。
       ⚠ 不能只靠 ResizeObserver 兜底:那要等下一個 frame,中間會閃一下。 */
    fitBoard();
    /* ★ 吃子 / 翻攻的動畫與明確圖示 —— 一定要放在 fitBoard() 之後(算 rect 要用最終尺寸),
       而且只在「這一手真的是新的」時播(fresh),不然每次 setState 都重播一次。 */
    if(fresh && L) playMoveFx(L);
  }

  /* ==========================================================================
     三之一、吃子 / 翻攻的動畫
     ──────────────────────────────────────────────────────────────────────────
       ★ 使用者原話:「吃的時候可以有動畫,類似把自己的移到別人身上吃掉」
         「連吃的時候,如果旁邊的還是蓋著,成功的吃掉每次都會不知道到底吃了什麼」
         「吃掉加棋子名字這個方法有點糟,效果很差,一點都不像是正式發行的遊戲,
          麻煩要以商業化考量」。
       ⚠⚠ v1.137.1 起**拿掉文字標籤**(浮出來寫「⚔️ 吃掉 X」那一版)——
         文字 + emoji 的浮動小標籤是「除錯用的標記」的手感,不是「正式遊戲」的手感。
         改成純視覺的三件事,「吃了誰」靠**被吃的子本身飛出去**回答,不必寫字:
         ① slidePiece():攻擊方那顆子從 from 格滑到 to 格(FLIP 技巧簡化版,見下)。
         ② burstFx():命中的瞬間炸開一圈金色震波 + 幾點火花(遊戲界通用的「打中了」語彙)。
         ③ knockAway():被吃的那顆子(pieceHTML(got),牌面本身就是答案)往攻擊方前進
            的方向被撞飛出去,邊轉邊縮邊淡出 —— 玩家看到的是「一顆看得清清楚楚的棋子
            飛出棋盤」,而不是一行字。
         「翻到自己人 / 打不穿」這兩種**沒有東西被吃掉**,不套震波/飛出,改用不同色系
         的一圈脈動(綠色系 = 安全、紅色系 = 被擋下)區分,打不穿那顆再讓攻擊方的子
         往前彈一下又彈回來(像撞到盾牌彈開)。
       ⚠ 這裡**不處理**「flip / darkSelf / darkMiss / jumpSelf」的翻牌本身
         (那是 pieceHTML() 的 pendingFlip 那條路),只處理「有沒有東西被吃掉 / 移動」。
       ⚠ knockAway() 會暫時多畫一顆 pieceHTML(got)(被吃的子一定都先翻開過,不違反
         牌情紅線),~500ms 後自動移除 —— 不影響 tools/gen-dc-solo-e2e.js 對 #dcBoard
         的計數斷言(那些斷言都不在「剛吃完子」的那個時間點量)。
     ========================================================================== */
  // 這一手的 kind → 要不要播位移動畫、有沒有東西被吃掉(見 rules.js 六節的 kind 表)
  const REVEAL_KINDS = { flip: 1, darkSelf: 1, darkMiss: 1, jumpSelf: 1 };
  const SLIDE_KINDS  = { move: 1, eat: 1, jump: 1, rush: 1, darkEat: 1 };
  const EAT_KINDS    = { eat: 1, jump: 1, rush: 1, darkEat: 1 };
  const SPARKS = 7;

  function sqEl(i){ return board.querySelector('.dc-sq[data-sq="' + i + '"]'); }

  // 兩格之間畫面上的方向(單位向量),量不到就給預設值 —— 給 slide / knockback / bounce 共用
  function dirBetween(fromIdx, toIdx, fallback){
    const fromSq = sqEl(fromIdx), toSq = sqEl(toIdx);
    if(!fromSq || !toSq) return fallback;
    const fr = fromSq.getBoundingClientRect(), tr = toSq.getBoundingClientRect();
    const dx = tr.left - fr.left, dy = tr.top - fr.top;
    const len = Math.hypot(dx, dy);
    return len ? { x: dx / len, y: dy / len, fr, tr } : fallback;
  }

  function slidePiece(fromIdx, toIdx){
    const toSq = sqEl(toIdx);
    const p = toSq && toSq.querySelector(".dc-p");
    const d = dirBetween(fromIdx, toIdx, null);
    if(!p || !d) return;
    const dx = d.fr.left - d.tr.left, dy = d.fr.top - d.tr.top;
    p.classList.add("dc-sliding");
    p.style.transition = "none";
    p.style.transform = "translate(" + dx + "px," + dy + "px)";
    void p.offsetWidth;                          // 強制 reflow,下面的 transition 才生效
    requestAnimationFrame(() => {
      p.style.transition = "transform .26s cubic-bezier(.22,.68,.32,1.08)";
      p.style.transform = "translate(0,0)";
    });
    setTimeout(() => {
      p.classList.remove("dc-sliding");
      p.style.transition = ""; p.style.transform = "";
    }, 300);
  }

  // 命中震波 + 火花 —— 純視覺的「打中了」回饋,不寫字。
  function burstFx(toIdx){
    const sq = sqEl(toIdx);
    if(!sq) return;
    const wrap = document.createElement("span");
    wrap.className = "dc-burst";
    sq.appendChild(wrap);
    for(let i = 0; i < SPARKS; i++){
      const ang = (Math.PI * 2 * i / SPARKS) + (Math.random() * 0.5 - 0.25);
      const dist = 20 + Math.random() * 16;
      const s = document.createElement("span");
      s.className = "dc-spark";
      s.style.setProperty("--sx", (Math.cos(ang) * dist).toFixed(1) + "px");
      s.style.setProperty("--sy", (Math.sin(ang) * dist).toFixed(1) + "px");
      s.style.animationDelay = Math.round(Math.random() * 30) + "ms";
      sq.appendChild(s);
    }
    // ⚠ 移除的時間要蓋過 CSS 動畫本身的長度(震波 .46s、火花 .5s)——
    //   曾經誤寫成 60ms,震波的圈只轉了一瞬間就被拔掉,只剩火花播得完整。
    setTimeout(() => { if(wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 500);
    setTimeout(() => { sq.querySelectorAll(".dc-spark").forEach(s => { if(s.parentNode) s.parentNode.removeChild(s); }); }, 560);
  }

  // 被吃的子往攻擊方前進的方向飛出去、邊轉邊淡出 —— 「吃了誰」靠牌面本身回答。
  function knockAway(fromIdx, toIdx, got){
    const sq = sqEl(toIdx);
    if(!sq || got == null) return;
    const d = dirBetween(fromIdx, toIdx, { x: 0, y: -1 });
    const el = document.createElement("span");
    el.className = "dc-knock";
    el.style.setProperty("--kx", (d.x * 50).toFixed(1) + "px");
    el.style.setProperty("--ky", (d.y * 50).toFixed(1) + "px");
    el.style.setProperty("--kr", Math.round(Math.random() * 70 - 35) + "deg");
    el.innerHTML = pieceHTML(got);
    sq.appendChild(el);
    setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, 520);
  }

  // 翻到自己人 / 打不穿:沒有東西被吃掉,用色系區分的一圈脈動(綠=安全、紅=被擋下)。
  function pulseFx(toIdx, kind){
    const sq = sqEl(toIdx);
    if(!sq) return;
    const el = document.createElement("span");
    el.className = "dc-pulse dc-pulse-" + kind;
    sq.appendChild(el);
    setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, 560);
  }

  // 打不穿:攻擊方那顆子朝目標方向輕彈一下又彈回來,像撞到盾牌。
  function bounceOff(fromIdx, toIdx){
    const fromSq = sqEl(fromIdx);
    const p = fromSq && fromSq.querySelector(".dc-p");
    const d = dirBetween(fromIdx, toIdx, null);
    if(!p || !d) return;
    p.style.setProperty("--bx", (d.x * 9).toFixed(1) + "px");
    p.style.setProperty("--by", (d.y * 9).toFixed(1) + "px");
    p.classList.add("dc-bounce");
    setTimeout(() => {
      p.classList.remove("dc-bounce");
      p.style.removeProperty("--bx"); p.style.removeProperty("--by");
    }, 320);
  }

  function playMoveFx(L){
    if(SLIDE_KINDS[L.kind]) slidePiece(L.from, L.to);
    if(EAT_KINDS[L.kind]){
      // 對齊滑入抵達的時間點:攻擊方的子先滑過去,「打中」那一刻才炸開 + 飛子
      setTimeout(() => { burstFx(L.to); knockAway(L.from, L.to, L.got); }, 190);
    }else if(L.kind === "darkSelf" || L.kind === "jumpSelf"){
      pulseFx(L.to, "safe");
    }else if(L.kind === "darkMiss"){
      pulseFx(L.to, "block");
      bounceOff(L.from, L.to);
    }
  }

  /* ==========================================================================
     四、動作列(吃子欄 + 輪到誰 + 這一手能做什麼)
     ──────────────────────────────────────────────────────────────────────────
       ★ 「停在這裡」只在**連吃進行中而且還吃得到**的時候出現 ——
         沒得吃時規則層已經自動幫他結束了(rules.js 的 afterCapture)。

       ⚠⚠⚠ 這一塊的高度**必須固定**,而那是規格不是美觀:
         舞台是 flex:1,動作列高一格舞台就矮一格 → fitBoard() 算出不同的格子大小
         → **每走一手棋盤就上下跳一下**(v1.113.x 的症狀:輪到自己時多一行提示,
         換對手時那一行消失)。所以:
           · 第二行一律存在(輪到對手時是**空的**,不塞填充語)—— .dc-actline 撐高度
           · 吃子欄的每一列不論有沒有子都佔位(空的畫一個「—」)
         高度由 CSS 的 min-height 給,這一支只負責「每一種狀態都畫出同樣多的列」。
         ★ 「固定」的意思是**一整局裡不變**,不是「永遠是同一個數字」——
           吃子欄有幾列由 st.rules.foeCaps 決定,而房規**開局就凍結**(見 rules.js
           的 RULE_LVS.caps),所以一局裡它不會變。
     ========================================================================== */
  /* ---------- 吃子欄 ----------
     ★★ 「自己吃掉的」**永遠顯示**(那是自己的戰果);
        「對手吃掉的」由房規 foeCaps 決定 —— 那是情報,兩邊看到的必須一樣,
        所以它是**房規不是各人偏好**(一邊看得到一邊看不到就不公平了)。
     ⚠ 因此這裡讀的是 st.rules(這一局凍結的那一份),不是任何 localStorage。

     吃子欄本身不違反牌情紅線:被吃掉的子一定都現過身(炮打暗子是**先翻開再吃**)。
     ⚠ 顆數多的時候改成互相疊一點,不然一列排不下 16 顆(class 由這裡掛,尺寸在 CSS)。
     ⚠⚠ v1.115.0 把子放大到 26px(原 20px)之後,**一段收緊不夠用了**:
       疊到 16 顆排得下的那個量,9 顆的時候會疊到只看得見最後一顆(截圖看出來的)。
       所以分兩段 —— 9~12 顆疊一點點、13 顆以上才真的疊很兇(那時本來就快分出勝負了)。
     ⚠ 兩個門檻與 CSS 的 margin 是**一組算出來的數字**(算式寫在 CSS 那邊),改尺寸要一起改。 */
  const TRAY_TIGHT = 9, TRAY_TIGHTER = 13;
  const byRank = (a, b) => DC.rankOf(b) - DC.rankOf(a);
  function trayRow(label, caps){
    const n = caps.length;
    const pcs = caps.slice().sort(byRank).map(pieceHTML).join("");
    return '<div class="dc-tray-row">' +
             '<span class="dc-tray-lbl">' + esc(label) + "</span>" +
             '<span class="dc-tray-pcs' + (n >= TRAY_TIGHTER ? " tighter" : (n >= TRAY_TIGHT ? " tight" : "")) + '">' +
             (n ? pcs : '<span class="dc-none">—</span>') + "</span></div>";
  }
  function trayHTML(st){
    const names = cur.names || [];
    const me = (typeof cur.mySeat === "number" && cur.mySeat >= 0) ? cur.mySeat : 0;
    const foe = 1 - me;
    const showFoe = !!(st.rules && st.rules.foeCaps);
    return '<div class="dc-tray">' +
             trayRow("你吃掉", st.caps[me]) +
             (showFoe ? trayRow((names[foe] || "對手") + "吃掉", st.caps[foe]) : "") +
           "</div>";
  }

  function renderActs(chainOn, canAct, mySide){
    if(!acts) return;
    const st = cur.st;
    const bits = [];
    if(st.over || cur.over){
      acts.classList.add("hidden");
      acts.innerHTML = "";
      stopCd();
      return;
    }
    bits.push(trayHTML(st));
    const who = cur.turnName || "";
    const meTxt = mySide < 0 ? "未定" : ('<b class="' + (mySide === DC.RED ? "dc-red-t" : "dc-blk-t") + '">' +
                                         DC.sideName(mySide) + "方</b>");
    bits.push('<div class="dc-turn">' +
              (canAct ? '<b class="dc-you">輪到你</b>' : (who ? ("輪到 " + esc(who)) : "…")) +
              '<span class="dc-side">你是 ' + meTxt + "</span></div>");

    /* ★ 第二行:連吃提示 + 走棋倒數環**合併成同一行**(v1.129.x 起)——
       兩個都是「有時候有內容、有時候空」的東西,各佔一份 min-height 太浪費,
       使用者回報「乾脆整合成一行,把空間留給棋盤」。
       ⚠⚠ 容器**同一局裡不可以**忽有忽無:連吃那一列比空的時候高一截,
         min-height 撐著,少了它「進入連吃」的那一手盤面會縮一下。
       ★★ 這一行**整個要不要畫**是房規決定的,而房規開局就凍結(rules.js 的
         normRules / adapter.js 的 setRoomField("turnSec",…,{lobbyOnly:true}))——
         連吃沒開、這局也沒有走棋倒數(單機永遠沒有),整行不畫,把空間讓給棋盤。
         ⚠ 只准用 st.rules.chain / cur.cdMs 這種**一整局不會變**的旗標當開關;
           絕對不可以用 chainOn(是不是正在連吃)去決定要不要畫這個容器 ——
           那會回到 v1.113.x「輪到自己多一行、換對手少一行」的老毛病。
       ★ 連吃中的文字**故意只寫「連吃中」**,不報「已吃幾顆 / 還可吃幾處」——
         那兩個數字棋盤上的高亮已經講完了(哪幾格還能繼續吃看得到),文字重複
         一次只是佔字數,使用者要的就是把這幾個字省下來。 */
    const hasChainUI = !!(st.rules && st.rules.chain);
    const hasTimer = !!cur.cdMs;
    if(hasChainUI || hasTimer){
      let inner = "";
      if(hasChainUI && chainOn && canAct){
        inner += '<span class="dc-chain-txt">連吃中</span>' +
                 '<button type="button" class="btn dc-stop" data-act="stop">結束連吃</button>';
      }
      if(hasTimer) inner += '<div class="dc-cdwrap" id="dcCdWrap"></div>';
      bits.push('<div class="dc-actline' + (hasTimer ? " has-cd" : "") + '">' + inner + "</div>");
    }
    acts.innerHTML = bits.join("");
    acts.classList.remove("hidden");
    syncCd(cur.cdMs, cur.cdEnd);
  }

  /* ---------- 走棋倒數的環 ----------
     使用者:「倒數秒數的方式,請參考台灣麻將的顯示方式」—— 與 .m16-cd 是同一份配方
     (SVG 環圈 + 中間秒數,最後 3 秒轉紅脈動),幾何與關鍵影格逐字沿用 m16,見 styles.css。
     ⚠ 兩個從台灣麻將 / 21 點繼承的坑:
       ① 用**負的 animation-delay** 接續播放,duration 永遠是這一手的總長
          (這樣 e2e 才量得到設定值)。
       ② 去重的 key **不可以看 cdT 還在不在**:數字走到 0 之後 tickCd() 就把 interval
          停了,而 timer 本身還有幾百毫秒沒響;那段空窗裡只要再叫一次 renderActs()
          環就會彈回滿格,而那個彈跳本身就是雜訊。
     ⚠ 與 m16 的持久節點不同,這裡的環是**每次 renderActs 都重建的節點**(同 21 點)——
       重建照樣接得上,靠的就是①那個負延遲。 */
  const CD_HOT = 3000;
  function syncCd(cdMs, endAt){
    const box = $("dcCdWrap");
    if(!box) return;
    if(!cdMs || !endAt){ stopCd(); return; }
    const left = endAt - Date.now();
    if(left <= 0){ stopCd(); return; }
    const key = cdMs + ":" + endAt;
    cdEnd = endAt;
    box.innerHTML =
      '<span class="dc-cd' + (left <= CD_HOT ? " dc-hot" : "") + '" id="dcCd" aria-hidden="true"' +
        ' style="--cd-dur:' + (cdMs / 1000) + 's;--cd-delay:' + (-(cdMs - left) / 1000) + 's">' +
        '<svg viewBox="0 0 40 40"><circle class="dc-cdbg" cx="20" cy="20" r="17"/>' +
        '<circle class="dc-cdfg" cx="20" cy="20" r="17"/></svg>' +
        '<b class="dc-cdn" id="dcCdN">' + Math.ceil(left / 1000) + '</b>' +
      '</span>';
    if(key === cdKey && cdT) return;          // 同一段倒數:重畫畫面不重跑動畫
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(tickCd, 200);
  }
  /* 只換中間那個數字與 hot 狀態 —— 環圈本身完全交給 CSS 動畫(理由見上面①)。 */
  function tickCd(){
    const el = $("dcCd");
    if(!el){ if(cdT){ clearInterval(cdT); cdT = null; } return; }
    const left = cdEnd - Date.now();
    const n = el.querySelector(".dc-cdn");
    const s = String(Math.max(0, Math.ceil(left / 1000)));
    if(n && n.textContent !== s){
      n.textContent = s;
      n.classList.remove("dc-beat"); void n.offsetWidth; n.classList.add("dc-beat");
    }
    el.classList.toggle("dc-hot", left <= CD_HOT);
    if(left <= 0){ clearInterval(cdT); cdT = null; }
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = ""; cdEnd = 0;
    const box = $("dcCdWrap");
    if(box) box.innerHTML = "";
  }

  /* ==========================================================================
     五、點擊流程
     ──────────────────────────────────────────────────────────────────────────
       ★ 點不了的格**不用 disabled 讓點擊靜默消失**(CLAUDE.md 的紅線)——
         一律 toast 說得出原因,原因由 rules.js 的 whyNot() 出(單機連線共用一份)。
     ========================================================================== */
  function tapSq(i){
    if(!cur || !cur.st) return;
    const st = cur.st;
    if(st.over || cur.over) return;
    if(!cur.mine){ showToast("還沒輪到你"); return; }

    // 連吃進行中:只認「續吃」與「停」
    if(st.chainFrom >= 0){
      const t = DC.chainTargets(st);
      for(let k = 0; k < t.length; k++) if(t[k].to === i){ fire(DC.encMove(st.chainFrom, i)); return; }
      showToast(i === st.chainFrom ? "點亮起的格子繼續吃,或按「結束連吃」"
                                   : DC.whyNot(st, st.chainFrom, i), 1800);
      return;
    }

    const c = st.cells[i];
    const mySide = cur.mySide;

    // 已經選了一顆:先看是不是落點
    if(sel >= 0){
      const t = DC.moveTargets(st, sel);
      for(let k = 0; k < t.length; k++) if(t[k].to === i){ fire(DC.encMove(sel, i)); return; }
      if(c && c.up && mySide >= 0 && DC.sideOf(c.p) === mySide){    // 換選另一顆自己的子
        sel = (sel === i) ? -1 : i;
        paint();
        return;
      }
      showToast(DC.whyNot(st, sel, i), 1800);
      return;
    }

    if(!c){ showToast("先點一顆自己的棋子"); return; }
    if(!c.up){ fire(DC.encFlip(i)); return; }                       // 翻開
    if(mySide < 0){ showToast("先翻一顆棋"); return; }
    if(DC.sideOf(c.p) !== mySide){ showToast("那是對方的子"); return; }
    if(!DC.moveTargets(st, i).length){ showToast(DC.nameOf(c.p) + "沒有可走的位置", 1600); return; }
    sel = i;
    paint();
  }

  function fire(mv){
    sel = -1;
    if(actCb) actCb(mv);
  }

  /* ==========================================================================
     六、結果卡
     ──────────────────────────────────────────────────────────────────────────
       ★★ v1.116.0 起這張卡只回答兩件事:**誰贏、各幾勝**。
         以前還列了剩子 / 階級和 / 吃掉哪幾顆,而那些是「這一局的過程」——
         局都結束了沒有人在看,只是把重點稀釋掉。
       ⚠ 「這一局是怎麼結束的」由 #winMsg 講(單機與連線各一份,措辭同一個格式),
         **不要**在表格上面再寫一次 —— 那就是同一句話出現兩遍。
     ========================================================================== */
  /* mySeat = 我坐哪(沒帶就是 -1);回傳「這一局是怎麼結束的」一句話。
     ⚠ 認輸那一種**要看是誰認的** —— 其它幾種對兩邊講起來都一樣,只有它不是。 */
  function endText(st, mySeat){
    if(st.endBy === "wipe")  return "吃光對方所有棋子";
    if(st.endBy === "stuck") return "對方無子可動,也無暗棋可翻";
    if(st.endBy === "count") return "連續 " + DC.IDLE_DRAW + " 步沒吃沒翻 · 比階級總和";
    if(st.endBy === "draw")  return "連續 " + DC.IDLE_DRAW + " 步沒吃沒翻 · 階級總和相同";
    if(st.endBy === "resign"){
      if(typeof mySeat !== "number" || mySeat < 0) return "有一方認輸";
      return st.winner === mySeat ? "對手認輸" : "你認輸了";
    }
    return "";
  }
  /* names = 兩個座位的名字;mySeat = 我坐哪;wins = [{n, plus}] 累積勝場(可省略)。
     ★ 只有兩欄:誰(+皇冠 + 紅黑)與幾勝。wins 沒帶就整張表不畫 —— 沒有勝場可講的
       場合(理論上不存在)硬畫一張只有名字的表沒有意義。 */
  function resultHTML(st, names, mySeat, wins){
    if(!wins) return "";
    const rows = DC.score(st).rows.map(r => {
      const win = (st.winner === r.seat);
      return '<tr class="' + (win ? "dc-w" : "") + (r.seat === mySeat ? " dc-me" : "") + '">' +
             '<td class="dc-r-nm">' + (win ? "👑 " : "") + esc(names[r.seat] || ("玩家" + (r.seat + 1))) +
             '<span class="dc-r-side ' + (r.side === DC.RED ? "dc-red-t" : "dc-blk-t") + '">' +
             (r.side < 0 ? "" : DC.sideName(r.side) + "方") + "</span></td>" +
             '<td class="dc-r-n"><b>' + wins[r.seat].n + "</b>" +
             (wins[r.seat].plus ? ('<i class="dc-plus">+' + wins[r.seat].plus + "</i>") : "") + "</td>" +
             "</tr>";
    }).join("");
    return '<table class="dc-table"><thead><tr>' +
           "<th>玩家</th><th>勝</th>" +
           "</tr></thead><tbody>" + rows + "</tbody></table>";
  }

  /* ==========================================================================
     七、對外
     ========================================================================== */
  function init(){
    stage = $("dcStage"); board = $("dcBoard"); acts = $("dcActs");
    if(!board) return;
    board.addEventListener("click", e => {
      const b = e.target.closest ? e.target.closest("[data-sq]") : null;
      if(!b) return;
      tapSq(+b.dataset.sq);
    });
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest ? e.target.closest("[data-act]") : null;
        if(b && b.dataset.act === "stop") fire(DC.STOP);
      });
    }
    /* ⚠ 只在**方向真的變了**才重畫 DOM;純粹尺寸變化只重算格子大小。
       整盤重畫會重跑翻牌動畫,而 resize 在手機上是連發的(鍵盤、網址列收合)——
       每次都重畫既閃又可能與「重畫改變了尺寸」形成迴圈(v1.111.1 的宣告面板踩過)。 */
    if(typeof ResizeObserver !== "undefined" && stage){
      new ResizeObserver(() => {
        const w = pickOrient();
        if(w === wide){ fitBoard(); return; }
        wide = w;
        if(cur){ const k = lastKey; lastKey = -1; paint(); lastKey = k; }
        else fitBoard();
      }).observe(stage);
    }
  }

  /* o = { st, mySide, mine, over, key, turnName, cdMs, cdEnd, mySeat, names }
     ★ mySeat / names 只給**吃子欄**用(誰吃掉了什麼);沒帶的話退回「你 / 對手」。
     ★ cdMs / cdEnd 只有連線(adapter.js)會帶 —— 單機沒有走棋倒數,環不會出現。 */
  function setState(o){
    cur = o || null;
    if(!cur || !cur.st) return;
    if(cur.key !== lastKey) sel = -1;         // 換了一手 → 之前選的那顆已經沒有意義
    const w = pickOrient();
    if(w !== wide) wide = w;
    paint();
  }

  function reset(){
    sel = -1; lastKey = -1; cur = null;
    stopCd();
    if(board) board.innerHTML = "";
    if(acts){ acts.innerHTML = ""; acts.classList.add("hidden"); }
  }

  return {
    init, setState, reset, paint,
    onAct(cb){ actCb = cb; },
    clearSel(){ sel = -1; },
    sel: () => sel,
    isWide: () => wide,
    pieceHTML, backHTML, resultHTML, endText,
    moveSfx, sfx, stopCd
  };
})();

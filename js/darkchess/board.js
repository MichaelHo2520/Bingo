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
  /* ★ 每一格「上一次畫面時」是不是已翻開(只存 boolean,不存 p —— 不違反牌情紅線)。
     ⚠⚠ 用來回答「這一步吃的子,在這一步之前玩家看不看得到」——同一個 kind("jump")
     炮既可能打明棋也可能(chain 開著時)打暗棋,不能只看 kind 決定要不要播「翻開讓你
     看清楚」那段動畫,見三之一節的 playMoveFx()。paint() 在畫下一手之前讀舊值決定
     這一手要不要播翻開動畫,畫完當下這一手才把它更新成新值。 */
  let prevUp = {};

  /* ==========================================================================
     一、音效 —— 全部用合成音,不進 mp3/
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 刻意不加音檔:動 mp3/ 要四處一起改(sfx 的 ensureDefs、sw.js 的 CORE、
         兩支產生器),而暗棋這幾個聲音用合成音就夠了。

     ── ★★★ 為什麼多一支 knock():木頭的辨識點不在音高 ──────────────────────
       舊版六個音全部是 `Sound.tone()`(純振盪器 + 滑音)—— 那是**電子 beep**,
       跟「木棋子扣在木盤上」差得很遠。實體那一下聽起來是兩件事疊起來的:
         ① 開頭 3~5ms 一段**寬頻雜訊**(「啪」)—— 兩塊硬物碰撞的瞬態,
            這一段才是耳朵用來判斷「這是木頭不是塑膠 / 不是電子音」的線索;
         ② 接著是**木腔共鳴**(「嗒」)—— 有音高,而且音高高低就是「這件東西多大」。
       `Sound.tone()` 只做得出②。所以①在這裡自己合(白雜訊 buffer → 濾波 → 極短包封),
       ②照舊交給 `Sound.tone()`。
       ⚠ 濾波中心頻率(o.f)就是「木料的硬度 / 件的大小」這一個旋鈕:
         高 = 清脆小件(翻牌)、低 = 厚重大件(吃子),不必為每個音各寫一套。

     ── ⚠ 為什麼 knock() 寫在這裡而不是加進 js/audio.js ─────────────────────
       `audio.js` 十四頁全部載入,動它要跑整輪回歸(CLAUDE.md 紅線 3),而目前只有
       暗棋要用。哪天第二頁也要,再往上搬成 `Sound.knock()`——
       自己拿 `Sound.ctx()` 建節點這件事本身有先例(`ui-kit.js` 的語音留言就是)。
       ⚠⚠ 代價要知道:它**繞過 masterNode**(那顆沒有對外暴露),所以靜音與總音量
         要自己吃 —— 開火前問 `Sound.isMuted()`、音量乘 `Sound.vol()`。
         唯一的差別是「拉音量滑桿的同一瞬間正在響的那 60ms 不會跟著變」,聽不出來。
       ⚠⚠⚠ `vol` 有可能是 0(使用者把音效音量拉到底)—— `exponentialRampToValueAtTime`
         的目標值不可以是 0(會丟例外),所以要早退。
     ========================================================================== */
  let nzBuf = null;
  function noiseBuf(c){
    if(nzBuf && nzBuf.sampleRate === c.sampleRate) return nzBuf;
    const n = Math.floor(c.sampleRate * 0.2);
    const b = c.createBuffer(1, n, c.sampleRate);
    const d = b.getChannelData(0);
    for(let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    nzBuf = b;
    return b;
  }
  /* 一記敲擊的瞬態:雜訊脈衝 → 濾波 → 4ms 上升 + 指數衰減。
     o.f/o.fTo = 濾波(掃頻的話就是「敲下去之後亮度迅速掉下來」)· o.type = 濾波器種類
     o.q = 共振尖銳度 · o.dur = 衰減長度 · o.vol = 音量 · o.delay = 延後幾秒 */
  function knock(o){
    if(Sound.isMuted && Sound.isMuted()) return;
    const c = (Sound.ctx && Sound.ctx()) || null;
    if(!c) return;
    o = o || {};
    const vol = (o.vol == null ? 0.2 : o.vol) * ((Sound.vol && Sound.vol()) || 0);
    if(!(vol > 0.0005)) return;
    const t = c.currentTime + (o.delay || 0);
    const dur = o.dur || 0.05;
    try{
      const s = c.createBufferSource();
      s.buffer = noiseBuf(c);
      const f = c.createBiquadFilter();
      f.type = o.type || "lowpass";
      f.frequency.setValueAtTime(o.f || 1600, t);
      if(o.fTo) f.frequency.exponentialRampToValueAtTime(o.fTo, t + dur);
      f.Q.value = (o.q == null ? 1 : o.q);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.004);      // 4ms 上升 = 那一下「啪」
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(c.destination);
      s.start(t);
      s.stop(t + dur + 0.02);
    }catch(e){}
  }
  const sfx = {
    /* 翻牌:指甲把木牌掀起來的那一下 —— 極短、偏高、幾乎沒有音高(帶通只留「嗒」的亮部) */
    flip(){ knock({ f: 2500, type: "bandpass", q: 1.1, dur: 0.045, vol: 0.20 });
            Sound.tone(1240, { type: "triangle", dur: 0.05, vol: 0.06, slideTo: 960 }); },
    /* 落子:木棋子扣在木盤上 = 雜訊「啪」+ 一顆低的木腔共鳴「咚」
       ⚠ 低頻那一顆在手機喇叭上多半聽不到 —— 那沒關係,它退化成只剩敲擊聲,
         而**桌機 / 耳機**上就是它把「電子 beep」變成「木頭」的那一半。 */
    move(){ knock({ f: 1800, fTo: 900, type: "lowpass", dur: 0.055, vol: 0.24 });
            Sound.tone(228, { type: "triangle", dur: 0.10, vol: 0.15, slideTo: 178 });
            Sound.tone(456, { type: "sine", dur: 0.06, vol: 0.06 }); },
    /* 吃子:同一記敲擊壓低一階(= 更大件)再加**厚一階的木腔**(~150→104Hz 快速衰減)
       —— 「重重扣下去」的扎實打擊感,而不是另換一種音色。 */
    eat(){  knock({ f: 1350, fTo: 620, type: "lowpass", dur: 0.08, vol: 0.30 });
            Sound.tone(150, { type: "triangle", dur: 0.16, vol: 0.26, slideTo: 104 });
            Sound.tone(300, { type: "sine", dur: 0.09, vol: 0.09 }); },
    /* 連吃:第 n 顆比第 n-1 顆高一階(玩家聽得出「還在吃」)——
       ★ 這條分級是舊版就定下來的,這一版只換音色:敲擊與木腔一起往上抬,
         而**每一下自己還是往下衰**(木頭被敲一下不會往上滑)。 */
    chain(n){ const k = Math.min(6, n), f = 150 + k * 26;
              knock({ f: 1300 + k * 140, fTo: 640, type: "lowpass", dur: 0.075, vol: 0.28 });
              Sound.tone(f, { type: "triangle", dur: 0.14, vol: 0.24, slideTo: f * 0.72 });
              Sound.tone(f * 3, { type: "sine", dur: 0.07, vol: 0.08 }); },
    /* 炮:高頻的**木裂聲** + 沉悶的低頻風暴 —— 「隔空發力」的厚重震撼。
       ⚠ 兩記 knock 疊在同一拍是刻意的:高通那一記負責「裂」、低通掃頻那一記負責「悶」。 */
    cannon(){ knock({ f: 3000, type: "highpass", dur: 0.055, vol: 0.20 });
              knock({ f: 460, fTo: 120, type: "lowpass", dur: 0.20, vol: 0.30 });
              Sound.tone(126, { type: "triangle", dur: 0.22, vol: 0.22, slideTo: 72 }); },
    /* 「結束連吃」是**操作**不是落子 —— 保持原本那顆柔和的下行二音,不做成敲擊,
       不然玩家會以為又吃了一顆。 */
    stop(){ Sound.tone(440, { type: "sine", dur: 0.10, vol: 0.14, slideTo: 330 }); }
  };

  /* ---------- 觸覺微震(手機)----------
     ★ 走全站共用的偏好 `vibrateOn`(設定頁那顆「震動」開關,宣告在 ui-kit.js)——
       這一頁**不另外做一顆開關**:嫌吵的人在設定頁關掉,連線的「輪到你」也是同一顆。
     ⚠ iOS Safari 沒有 `navigator.vibrate` → 自動略過(同 Bingo / 五子棋 / 飛行棋);
       引用一律 `typeof vibrateOn !== "undefined"`(它是別的檔宣告的,將來搬走就是 ReferenceError)。
     ⚠⚠ 節奏刻意與聲音**同一套分級**:翻牌最輕 → 落子輕 → 吃子扎實 → 連吃是雙擊脈衝。
       手上讀得出「剛剛那一下是吃到了」而不必看畫面,這才是它存在的理由
       (單純「每一手都震一下」等於沒有資訊)。
     ⚠⚠⚠ **只有自己這一手才震**(moveSfx 的第二個參數)—— 聲音兩邊都要出,
       但震動不是:單機對電腦時電腦一局要走幾十手,每一手都震一下就是整場在抖,
       而且那個震動完全不對應使用者的任何動作。 */
  const BZ = { flip: 12, move: 8, eat: 25, chain: [15, 40, 22], cannon: [12, 34, 30] };
  function buzz(pat){
    try{
      if(typeof vibrateOn !== "undefined" && vibrateOn && navigator.vibrate) navigator.vibrate(pat);
    }catch(e){}
  }

  /* 走「前後兩份的 diff」而不是在動作點插 sfx.xxx() ——
     單機與連線的動作路徑完全不同,但「有人吃了一顆」在兩邊是同一個 diff。
     ★ mine = 這一手是不是**這台裝置的人**走的(呼叫端拿 `st.last.seat` 比出來的)——
       只影響震動,不影響聲音:對手走了什麼一定要聽得到,但震動只回饋自己的動作
       (理由見上面 BZ 那一段的 ⚠⚠⚠)。 */
  function moveSfx(st, mine){
    const L = st && st.last;
    if(!L) return;
    const bz = mine ? buzz : function(){};
    if(L.kind === "flip"){ sfx.flip(); bz(BZ.flip); return; }
    if(L.kind === "move"){ sfx.move(); bz(BZ.move); return; }
    if(L.kind === "stop"){ sfx.stop(); return; }
    /* ★ 認輸這一手**不出聲**(v2.5.0+ 順手修的既有小 bug)—— 它沒有自己的分支,
       以前會一路掉到最下面那個 else 去播「吃子」的重擊聲,而下一拍 finish() 馬上
       就播勝 / 敗音了。以前只是多一聲悶響,加了震動之後會變成「按投降手機扎實震一下」。 */
    if(L.kind === "resign") return;
    if(L.kind === "darkSelf"){ sfx.flip(); bz(BZ.flip); return; }
    /* ★ 翻攻吃不動(v1.120.x 起兩顆都活,不再被反吃)—— 跟 darkSelf 一樣是
       「白花一手,沒有賠掉任何東西」,不是 oops。 */
    if(L.kind === "darkMiss"){ sfx.flip(); bz(BZ.flip); return; }
    /* ★ 炮打到自己人(v1.118.0 起兩顆都活)—— 開了一炮、只翻開一顆,所以是
       「炮聲 + 翻棋聲」而**不是** oops:沒有賠掉任何東西,只是白花一手。 */
    if(L.kind === "jumpSelf"){ sfx.cannon(); sfx.flip(); bz(BZ.cannon); return; }
    if(L.kind === "jump"){ sfx.cannon(); bz(BZ.cannon); return; }
    if(st.chainLen > 1){ sfx.chain(st.chainLen); bz(BZ.chain); }
    else { sfx.eat(); bz(BZ.eat); }
  }

  /* ==========================================================================
     二、棋子自繪
     ──────────────────────────────────────────────────────────────────────────
       ★ 用的是「帥仕相俥傌炮兵 / 將士象車馬包卒」這些**常用漢字** ——
         不是 CLAUDE.md 紅線 8 禁的 U+1F000 那一段(那些多數字型沒有,會變豆腐)。
     ========================================================================== */
  // 一顆棋子的正面(不含翻牌動畫判斷)——pieceHTML() 與 board.js 三之一節的動畫共用。
  function pieceFaceHTML(p){
    const side = DC.sideOf(p);
    return '<span class="dc-p ' + (side === DC.RED ? "dc-red" : "dc-blk") + '">' +
             '<i class="dc-ring"></i><b class="dc-ch">' + DC.nameOf(p) + '</b>' +
           '</span>';
  }
  /* 雙面卡片翻轉的殼:背面那張臉**不掛 .dc-back**(它已經翻開了,不能被算進還蓋著幾顆),
     只掛 .dc-backface 拿視覺 —— 兩張臉共用同一份「木頭牌背」樣式,見 styles.css。
     faceHTML 帶什麼進來就翻出什麼(pieceHTML() 的 pendingFlip 分支、以及三之一節
     「翻攻:先翻開看清楚再收走」的動畫,兩處共用這一支)。 */
  function flipWrapHTML(faceHTML){
    return '<span class="dc-flip3d dc-flip-in">' +
             '<span class="dc-face dc-face-b dc-p dc-backface" aria-hidden="true">' +
               '<i class="dc-ring"></i><b class="dc-grain"></b></span>' +
             '<span class="dc-face dc-face-f" aria-hidden="true">' + faceHTML + '</span>' +
           '</span>';
  }
  /* ★ pendingFlip 是「這一格是不是這一手剛翻開的」的一次性開關(見上面宣告處的註解)。
     ⚠⚠⚠ 牌情紅線的守門(tools/test-pages.js H 節)逐字比對畫格子那一行是
       `c.up ? pieceHTML(c.p) : backHTML()`,所以**不能**改成 pieceHTML(p, flip) 這種
       多帶一個參數的寫法 —— 呼叫點的字要原封不動。改用模組變數讓 pieceHTML 自己讀,
       paint() 只在要畫「剛翻開那一格」的前一刻把它撥成 true,畫完立刻被這裡消費掉。 */
  function pieceHTML(p){
    const face = pieceFaceHTML(p);
    if(!pendingFlip) return face;
    pendingFlip = false;                       // 消費一次:吃子欄 / 結果卡再畫同一顆子不會誤套
    return flipWrapHTML(face);
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
  /* ⚠⚠ PAD 與 styles.css 的 `.dc-board{padding}` **必須同一個數字**,而且它同時是
     那圈「外框帶」的寬度(`inset 0 0 0 16px` 那條 box-shadow)—— 只改一邊的症狀是
     木框壓到最外圈的格子上,而畫面不會壞、只有截圖看得出來。
     ★ v1.141.1 由 11 加到 16:木框帶正好蓋滿 padding,所以「最外圈的棋子到木框」
       就等於格子裡的那點留白(約 6px),而棋子之間有 16px —— 使用者回報
       「左右被卡掉了」講的就是這個落差。 */
  const GAP = 4, PAD = 16, MIN_CELL = 20;
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
    /* ★ 選中炮的時候順便把**跳板**(炮架)標出來 —— 這是炮唯一「看不出來」的一段:
       目標亮在三格外,而「為什麼打得到那一顆」全靠中間那顆子,盤面上完全沒有痕跡。
       ⚠ 標的是**位置**,不是內容(DC.screenIdx() 只讀 occupied)—— 牌情紅線沒事。
       ⚠⚠ 只有 kind === "jump" 才有跳板:車直衝(rush / rushDark)的定義正好相反
         (中間**必須全空**),標它等於把一條空路標成有東西。 */
    const screens = {};
    if(canAct && sel >= 0){
      for(const k in tgtMap){
        if(tgtMap[k] !== "jump") continue;
        const s = DC.screenIdx(st, sel, +k);
        if(s >= 0) screens[s] = 1;
      }
    }

    const fresh = (cur.key !== lastKey);
    const L = st.last;
    /* ★ 這一手吃 / 翻攻的目標,在這一手**之前**是不是還蓋著 —— 讀的是上一次畫面留下的
       舊值(這一格迴圈裡才會被覆寫成新值),決定 playMoveFx() 要不要播「翻開讓你看清楚」
       那段動畫。同一個 kind("jump")炮可能打明棋也可能打暗棋,只看 kind 分不出來。 */
    const wasHiddenAtTo = !!(fresh && L && typeof L.to === "number" && prevUp[L.to] === false);
    board.style.setProperty("--dc-cols", String(wide ? DC.COLS : DC.ROWS));
    fitBoard();

    const out = [];
    for(let i = 0; i < DC.NSQ; i++){
      const g = gridAt(i), c = st.cells[i];
      const cls = ["dc-sq"];
      if(!c) cls.push("dc-empty");
      if(i === sel) cls.push("dc-sel");
      if(tgtMap[i]) cls.push("dc-tgt", "dc-t-" + tgtMap[i]);
      if(screens[i]) cls.push("dc-screen");
      if(L && fresh && (L.to === i)) cls.push("dc-hit");
      // ★ 落點的常駐標記(不受 fresh 限制)—— dc-hit 只在剛落地那一瞬間亮一下,
      //   翻攻吃不動 / 打到自己人這幾種「兩顆都留在原地」的手,亮完就什麼痕跡都沒有,
      //   使用者反映看不出對手剛剛動了哪顆。語彙同五子棋 .gmk-stone.last / 台灣麻將 .m16-pt.last。
      if(L && typeof L.to === "number" && L.to === i) cls.push("dc-lastto");
      if(L && L.from === i && !c) cls.push("dc-from");
      // ★ 這一格是不是「這一手剛翻開」——pieceHTML() 讀這個模組變數決定要不要播翻牌動畫
      pendingFlip = !!(c && c.up && fresh && L && REVEAL_KINDS[L.kind] && L.to === i);
      out.push('<button type="button" class="' + cls.join(" ") + '" data-sq="' + i +
               '" style="grid-row:' + g.row + ';grid-column:' + g.col + '">' +
               (c ? (c.up ? pieceHTML(c.p) : backHTML()) : "") +
               "</button>");
      prevUp[i] = !!(c && c.up);      // ★ 更新成「現在」的翻開狀態,給下一手比較用
    }
    pendingFlip = false;           // ⚠ 迴圈外的 pieceHTML() 呼叫(吃子欄、結果卡)一律不套
    board.innerHTML = out.join("");
    board.classList.toggle("dc-mine", canAct);
    lastKey = cur.key;
    renderActs(chainOn, canAct);
    /* ⚠⚠ 一定要**再算一次**:動作列的高度會隨內容變(連吃那一列比平常多一行),
       而它變高就把舞台壓矮 —— 上面那次 fitBoard() 是在 renderActs() **之前**算的,
       用的是舊高度 → 盤面溢出舞台,而 .dc-stage 是 overflow:hidden,
       溢出的那一截**被靜靜削掉**(截圖才看得出來,量 rect 也看得出來)。
       ⚠ 不能只靠 ResizeObserver 兜底:那要等下一個 frame,中間會閃一下。 */
    fitBoard();
    /* ★ 吃子 / 翻攻的動畫與明確圖示 —— 一定要放在 fitBoard() 之後(算 rect 要用最終尺寸),
       而且只在「這一手真的是新的」時播(fresh),不然每次 setState 都重播一次。 */
    if(fresh && L) playMoveFx(L, wasHiddenAtTo);
    /* ★ 兩塊浮層(悶局倒數 / 記牌盤)—— 掛在 .dc-stage 上、absolute、不佔版面,
       所以**不影響 fitBoard()**(那正是它們不做成「動作列多一行」的原因,見四節的 ⚠⚠⚠)。 */
    syncIdle(st);
    syncTally();
  }

  /* ==========================================================================
     三之一、吃子 / 翻攻的動畫
     ──────────────────────────────────────────────────────────────────────────
       ★ 使用者原話與意見演進(施工紀錄留著,免得下次又走回頭路):
         ①「吃的時候可以有動畫,類似把自己的移到別人身上吃掉」
         ②「連吃的時候,如果旁邊的還是蓋著,成功的吃掉每次都會不知道到底吃了什麼」
         ③「吃掉加棋子名字這個方法有點糟,效果很差,一點都不像是正式發行的遊戲」
         ④「現在這樣也很糟,看起來太亂了,參考一下網路上比較流行的暗棋遊戲」——
           查了幾款主流暗棋 App 跟一般棋牌類手遊的共同語彙後定案:**移動一律用滑的**。
         ⑤「對於那種還沒有翻開來的,我想要再修改一下…我不希望吃了之後,結果是要去
           下面看才知道吃了什麼…真正下棋時我把自己的棋子放到那一顆還沒翻開的上面,
           然後會把它拿起來看,如果可以吃就收走」——只對『翻攻吃得動』(`darkEat`)
           補了「先翻開、停留讓人看清楚」這一段。
         ⑥「炮也要動啊,如果是沒翻開的都要動」+「我不喜歡吃完跑去下面的動畫,那個
           取消掉吧」——⑤漏掉一種情境、也多做了一件使用者不想要的事,這一版兩個
           一起修:
           - **炮(`jump`)房規「連吃」開著時可以隔子打暗棋**(rules.js 的
             `paoTargets()`,見規則層第 2 條)—— kind 一樣是 `"jump"`,但目標可能
             是明棋也可能是暗棋,**光看 kind 分不出來**,⑤那版只認 `kind==="darkEat"`
             漏了這一種。改成 `wasHiddenAtTo`(見 paint() 裡的 `prevUp` 比對):
             不管是哪個 kind,只要「這一步的目標在這一步之前還蓋著」就要播翻開動畫,
             結構上就把炮/車(理論上車不會打到暗子,但邏輯統一)/翻攻三種一次照顧到,
             不必每加一種新規則就重新想一次判準。
           - 拿掉整段「翻開之後飛去吃子欄」的收尾:改成翻開、停留讓人看清楚,
             就地淡出消失。
         ⑦「移動過去後,如果是可以吃的,那隻就變成用動畫翻到中正中央」——⑥的
           「就地淡出」看得清楚但不夠**顯眼**(棋盤格子本來就小)。改成:被吃的子
           一邊翻開一邊飛到棋盤正中央、放大,停留讓人看清楚,再淡出消失
           (revealAtCenter(),見下方 CSS 的 dcRevealLift)。
         ⑧「連吃如果是吃到還沒翻開的棋子並且有成功的吃掉,會有一個棋子跑到中間的
           動畫,那個動畫沒有很順」——⑦的**畫法**沒改,是把四個不順的地方一起修
           (細節見 revealAtCenter() 與 CSS 那一段,這裡只列結論):
           - 浮層原本是 `setTimeout(220)` 才掛上去,而 paint() 早就把落點畫成攻擊方
             的子了 → 那顆暗子**先消失 0.22 秒再冒出來**。改成一開始就掛,第一段
             停在原格當牌背(等的時間由 CSS 時間軸自己走)。
           - 「翻」與「飛」原本**同時**播 → 3D 子樹在會縮放的祖先底下每一幀重新
             光柵化(而 .dc-p 的底是六層漸層 + 九道 box-shadow)。改成錯開。
           - 原本 scale(1)→scale(1.6),貼圖照起點畫一次再撐大 → 飛的過程是糊的。
             改成盒子直接開成放大後的尺寸、從 scale(1/1.6) 縮回 1。
           - **連吃沒有去重**:上一顆還在飛下一顆就吃下去了,兩顆疊在棋盤正中央。
       「明棋吃明棋」(被吃的子在這一步之前就已經翻開,玩家早就知道是誰:`eat`、
       `rush`、以及打到明棋的 `jump`)不套翻開動畫 —— slidePiece() 滑過去、被吃的子
       瞬間被攻擊方蓋掉就講完了,不需要再翻一次給他看。
       「翻到自己人 / 打不穿」(`darkSelf`/`jumpSelf`/`darkMiss`)這三種都是**沒有
       東西被吃掉、而且那顆子留在原地**——pieceHTML() 的 pendingFlip 翻牌動畫已經是
       「翻開讓你看清楚,而且它一直留在畫面上」,不必再疊任何效果。
       ⚠ revealAtCenter() 會暫時多畫一顆 pieceHTML(got)(被吃的子一定都先翻開過,
         不違反牌情紅線),播完就移除 —— 不影響 tools/gen-dc-solo-e2e.js 對 #dcBoard
         的計數斷言(那些斷言都不在「剛吃完子」的那個時間點量)。
     ========================================================================== */
  // 這一手的 kind → 要不要播位移動畫(見 rules.js 六節的 kind 表)。
  // ⚠ 「要不要播翻開讓你看清楚」不是靠這張表 —— 見 paint() 算的 wasHiddenAtTo。
  const REVEAL_KINDS = { flip: 1, darkSelf: 1, darkMiss: 1, jumpSelf: 1 };
  const SLIDE_KINDS  = { move: 1, eat: 1, jump: 1, rush: 1, darkEat: 1 };
  const EAT_KINDS    = { eat: 1, jump: 1, rush: 1, darkEat: 1 };

  function sqEl(i){ return board.querySelector('.dc-sq[data-sq="' + i + '"]'); }

  function slidePiece(fromIdx, toIdx){
    const fromSq = sqEl(fromIdx), toSq = sqEl(toIdx);
    const p = toSq && toSq.querySelector(".dc-p");
    if(!fromSq || !toSq || !p) return;
    const fr = fromSq.getBoundingClientRect(), tr = toSq.getBoundingClientRect();
    const dx = fr.left - tr.left, dy = fr.top - tr.top;
    if(!dx && !dy) return;
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

  /* 「這一步吃 / 翻攻的目標,之前玩家看不看得到」→ 才需要播:牌背停在原格等攻擊方
     滑進來、就地翻開、飛到棋盤正中央放大、停留讓人看清楚,再淡出消失
     (使用者:「移動過去後,如果是可以吃的,那隻就變成用動畫翻到中正中央」)。
     ⚠ z-index 比攻擊方的子高(見 CSS 的 .dc-reveal),攻擊方雖然已經滑到位,
       但視覺上被這一層蓋著,直到淡出消失那一刻才「露出」攻擊方安穩落地的畫面。
     ⚠⚠ 明棋吃明棋(打之前就翻開過)不叫這一支 —— 玩家早就知道是誰,滑過去就講完了。
     ⚠⚠⚠ 掛的節點是 `.dc-board`(不是那一格的 `.dc-sq`)——要飛好幾格到棋盤中央,
       掛在原本那一格會被那一格的 stacking context 卡住,疊不到別格上面。用
       getBoundingClientRect() 量出「原本那一格」相對 `.dc-board` 的 left/top,
       先讓它疊在正確的起點(元素本身用 inline left/top/width/height 定住),
       再用 --fx/--fy(位移到板子中心的量)交給 CSS 的 dcRevealLift 動畫。

     ── ★★ 整段只有**一支** CSS 動畫(dcRevealLift),五段一次走完 ───────────────
       ⚠ 五段的**比例**寫在 CSS 的關鍵影格,**總長**寫在這裡(inline 的 --rv-dur)——
         JS 只需要這一個數字來排「播完把節點拿掉」那個 timer。
       ⚠⚠ 舊版是「dcRevealToCenter 播完 → 掛 .dc-reveal-gone 換成 dcRevealFade」,
         換動畫就是一個接縫:兩份關鍵影格的起點只要有一格對不上就是一次跳動,
         而且要多一個 timer 去撥那個 class。一支時間軸從頭走到尾沒有接縫。
       ⚠⚠⚠ 第②段(翻)與第③段(飛)**刻意不重疊**,這是「不順」的主因:
         翻是 .dc-flip3d 的 rotateY(preserve-3d 子樹)、飛是外層的 translate+scale,
         兩個 transform 同時動的時候瀏覽器沒辦法只合成一次 —— 3D 子樹在一個正在
         縮放的祖先底下每一幀都要重新光柵化,而 .dc-p 的底是**六層漸層 + 九道
         box-shadow**(見 styles.src.css 的 .dc-p),重畫一次不便宜。錯開之後
         任何一刻都只有一個 transform 在動。 */
  const RV_ALL = 1400;      // 整段總長(ms);五段的比例見 CSS 的 @keyframes dcRevealLift
  const RV_UP  = 1.6;       // 飛到中央之後放多大(= 一格的幾倍)
  function revealAtCenter(toIdx, got){
    const sq = sqEl(toIdx);
    if(!sq || got == null || !board || !stage) return;
    cutReveals();                       // ⚠ 連吃:上一顆還在飛就先收掉,見那一支
    /* ⚠⚠⚠ 掛在 **stage** 不是 board:`paint()` 每一手都會 `board.innerHTML = …`
       整段重建,掛在 board 裡的浮層會被**連根拔掉**。單機對電腦時這是必然發生的 ——
       玩家吃完暗子後 `aiTurn()` 最快 320ms(AI_MIN_MS)就走一手 → paint() →
       浮層在只播了一百多毫秒的時候就消失;而連吃(回合留在自己身上、沒有 AI 那一手)
       剛好躲過,所以症狀是**時有時無**(使用者:「不一定,有時會沒有,但有時候又會有」)。
       stage 是 paint() 不會動的節點,掛在這裡才活得完整。
       ⚠ 位移基準跟著換成 stage 的座標系,但「飛到哪裡」仍然是**棋盤的正中央**
         (bRect 算的還是 board)—— 棋盤在 stage 裡是置中的,兩者中心通常重合,
         但視窗比例讓棋盤沒有填滿 stage 時就會不一樣,一律以棋盤為準。 */
    const sRect = sq.getBoundingClientRect();
    const bRect = board.getBoundingClientRect();
    const gRect = stage.getBoundingClientRect();
    /* ★★ 盒子直接開成**放大後**的尺寸,再用 scale(1/RV_UP) 縮回一格大小當起點 ——
       **不是**開成一格大再放大到 1.6 倍。差別在光柵化:瀏覽器是照這段動畫會用到的
       比例把貼圖畫出來,起點小終點大的話那張貼圖在放大的過程中是**糊的**,直到停下來
       才重畫成清晰的(看起來就是「飛到中間才忽然變清楚」)。反過來排,全程都清晰。
       ⚠ 因此 --dc-cell 也要跟著開成放大後的值(棋子的字級 / 厚度都是它的百分比)。
       ⚠⚠⚠ 而且它一定要**自己補一份**:--dc-cell 是 fitBoard() 寫在 `.dc-board`
         身上的,這顆浮層掛在 stage(board 的父層)—— 繼承不到。拿不到就會退回
         `.dc-ch` / `--dc-th` 宣告裡的後備值 44px,症狀是**飛到中央那顆放大的子,
         裡面的字明顯小一號、比例整個怪掉**(使用者回報過),棋子的厚度也會變薄。
         守門是 tools/gen-dc-shot.js 的 mode=reveal(量「字 / 棋子」的比例)。 */
    const big = Math.round(sRect.width * RV_UP);
    const el = document.createElement("span");
    el.className = "dc-reveal";
    // 盒子比格子大,要往回退半圈才對得準原本那一格(縮放是繞著中心)
    el.style.left = (sRect.left - gRect.left - (big - sRect.width)  / 2).toFixed(1) + "px";
    el.style.top  = (sRect.top  - gRect.top  - (big - sRect.height) / 2).toFixed(1) + "px";
    el.style.width  = big + "px";
    el.style.height = big + "px";
    el.style.setProperty("--dc-cell", big + "px");
    el.style.setProperty("--rv-dur", RV_ALL + "ms");
    el.style.setProperty("--rv-s0", (sRect.width / big).toFixed(4));
    /* 位移量量的是「這一格的中心 → 棋盤的中心」。
       ⚠ transform 寫成 `translate(…) scale(…)`,translate 走的是**父層**的座標系
         (排在 scale 前面 → 不受自己的縮放影響),所以這裡不必再除以比例。 */
    el.style.setProperty("--fx", ((bRect.left - sRect.left) + (bRect.width  - sRect.width)  / 2).toFixed(1) + "px");
    el.style.setProperty("--fy", ((bRect.top  - sRect.top)  + (bRect.height - sRect.height) / 2).toFixed(1) + "px");
    el.innerHTML = flipWrapHTML(pieceFaceHTML(got));
    stage.appendChild(el);
    setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, RV_ALL + 60);
  }
  /* 連吃:上一顆還在飛,下一顆就吃下去了 —— 整段 1.4 秒,而連吃兩手之間常常不到一秒。
     不收掉的話兩顆會疊在棋盤正中央(一顆正在淡出、一顆正飛進來),那個「亂」比動畫
     本身順不順更明顯,而且那正是使用者回報的情境(連吃 + 吃到暗子)。
     ⚠ 收法不是直接 removeChild(畫面上會 pop 一下),是**凍結在當下再快速淡掉**;
       而「凍結」一定要先把 animation 拿掉 —— CSS 動畫的優先級高過 inline style,
       animation 還掛著的話寫進去的 transform / opacity 一個字都不會生效。
     ⚠⚠ 用 data-cut 標記已經在收的那些,重入時跳過(不然每來一顆就把它們的淡出重跑
       一次,反而永遠淡不完)。 */
  const RV_CUT = 140;
  function cutReveals(){
    if(!stage) return;
    stage.querySelectorAll(".dc-reveal:not([data-cut])").forEach(el => {
      const cs = getComputedStyle(el);
      const tf = cs.transform, op = cs.opacity;
      el.dataset.cut = "1";
      el.style.animation = "none";
      if(tf && tf !== "none") el.style.transform = tf;
      el.style.opacity = op;
      void el.offsetWidth;                       // 強制 reflow,下面的 transition 才生效
      el.style.transition = "opacity " + RV_CUT + "ms linear";
      el.style.opacity = "0";
      setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, RV_CUT + 40);
    });
  }
  // 離場 / 換局時把還在飛的浮層清掉(它掛在 stage 上,不會被 board.innerHTML 帶走)
  function clearReveals(){
    if(!stage) return;
    stage.querySelectorAll(".dc-reveal").forEach(el => { if(el.parentNode) el.parentNode.removeChild(el); });
  }

  /* 炮打出去的那一下,**跳板**輕輕震一下(v2.3.7)。
     ★ 要傳達的資訊只有一個:「這一炮是從哪一顆頭上飛過去的」——
       炮的目標可能在三格外,不標的話畫面上只看得到「一顆子忽然飛走」。
     ⚠⚠ 刻意**不做**砲彈 / 火花 / 爆炸 / 棋盤微震:那正是 v1.137.1 被否決掉的那一批
       (使用者:「看起來太亂了」),結論寫在三之一節。這裡只借「已經在用的語彙」——
       一個 0.42 秒的縮放脈動,跟落點光暈同一個量級。
     ⚠⚠⚠ 動的是 **transform**(合成器)而不是 box-shadow:.dc-p 的底是六層漸層 +
       九道陰影,動陰影要逐格重繪,而這一拍主執行緒正忙著攻擊方的滑動
       (見 v1.137.5「兩個貴的東西同時搶主執行緒」那條)。
     ⚠ 跳板那一格**不可能**同時是落點(dc-hit)或剛翻開那一格(.dc-flip3d)——
       它是「中間那一顆」,兩邊都不是它 → 不會與 dcHitGlow / dcFlipIn 疊在同一顆子上。 */
  const SCR_FX = 420;
  function pulseScreen(from, to){
    if(!cur || !cur.st || !board) return;
    const i = DC.screenIdx(cur.st, from, to);
    if(i < 0) return;
    const sq = sqEl(i), p = sq && sq.querySelector(".dc-p");
    if(!p) return;
    p.classList.remove("dc-screen-fx");
    void p.offsetWidth;                          // 強制 reflow:連兩炮打同一顆跳板時才會重播
    p.classList.add("dc-screen-fx");
    setTimeout(() => p.classList.remove("dc-screen-fx"), SCR_FX + 40);
  }

  function playMoveFx(L, wasHiddenAtTo){
    if(SLIDE_KINDS[L.kind]) slidePiece(L.from, L.to);
    /* ⚠ jumpSelf(炮打到自己人)也要 —— 那一手炮留在原地,畫面上**完全沒有東西在動**,
       只有目標格翻開;不標跳板的話看起來像「隔壁那顆自己翻開了」。 */
    if(L.kind === "jump" || L.kind === "jumpSelf") pulseScreen(L.from, L.to);
    /* ⚠⚠ 這一支要**立刻**掛,不可以再 setTimeout 等攻擊方滑到位(舊版等 220ms):
       paint() 已經把落點畫成攻擊方的子、被吃的那顆從 DOM 上消失了,晚 220ms 才掛的
       下場是「暗子瞬間不見 → 空了 0.22 秒 → 又冒出來 → 才翻開」,那個「不見又冒
       出來」就是使用者說的不順。改成一開始就掛,第一段停在原格當牌背(等攻擊方滑
       進來的那段時間由 CSS 時間軸自己走)—— 那顆暗子從頭到尾沒有離開過畫面。 */
    if(EAT_KINDS[L.kind] && wasHiddenAtTo) revealAtCenter(L.to, L.got);
    // 明棋吃明棋(wasHiddenAtTo 是 false):滑過去本身就講完了,不疊加任何效果。
    // darkSelf / jumpSelf / darkMiss:翻牌動畫本身已經講完了,不疊加任何效果。
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

     ★★★ v1.142.0:同一種子**併成一顆 + 一個小數字**,不再一顆一顆攤開。
       使用者回報「被吃了什麼的區域看起來不清楚」。攤開的版本在顆數多的時候只有一條路:
       互相疊(v1.115.0~v1.141.x 的 `.tight` / `.tighter`)—— 而疊掉的正好是**字**
       (字在正中央、疊掉的是右半邊),前面那幾顆只剩半個字,等於白畫。
       一方最多只有**七種**子(將士象車馬包卒)→ 併起來永遠 ≤ 7 顆:一列排得下、
       **一顆都不必疊**,每個字都是完整的。
       ⚠ 所以那兩段收緊的門檻(TRAY_TIGHT / TRAY_TIGHTER)連同 CSS 的 .tight / .tighter
         一起拿掉了 —— 留著會讓下次改的人以為還會疊。
       ⚠ 併的前提是「已經照階級排好」→ 同一種一定相鄰(caps 只裝敵方子,所以同階級
         就是同一顆),因此只比對前一顆就夠,不必用物件統計再排一次。 */
  const byRank = (a, b) => DC.rankOf(b) - DC.rankOf(a);
  function groupCaps(caps){
    const out = [];
    caps.slice().sort(byRank).forEach(p => {
      const last = out[out.length - 1];
      if(last && last.p === p) last.n++;
      else out.push({ p: p, n: 1 });
    });
    return out;
  }
  /* ⚠⚠⚠ 標籤是一顆 **<button>**(v2.3.7),不是 <span> —— 它是「記牌盤」的入口。
     ★ 為什麼把入口做在既有的標籤上,而不是加一顆新的鈕:
       · 加在吃子欄尾巴 → 那一列最寬的情況(七種 16 顆)在 390px 手機上只剩 47px 空隙、
         ≤360px 只剩 5px,而 .dc-tray-pcs 是 overflow:hidden → **多一顆鈕就把棋子切掉**,
         切掉的正是 v1.142.0 好不容易救回來的「每個字都看得完整」;
       · 做成浮在盤面上的角落鈕 → 蓋住的那一格就永遠點不到(跳棋紅線同構)。
       改成「標籤自己是鈕」= **一個像素都沒多佔**(同樣的字、同樣的字級),
       affordance 靠一條虛線底線(不佔寬,高度也還在 min-height 裡面)。
     ⚠ 樣式要把 button 的 appearance / border / padding / font 全部歸零,
       不然它會長出瀏覽器預設的框與字體,把那一列撐高(= 盤面跟著縮)。 */
  function trayRow(label, caps){
    const gs = groupCaps(caps);
    const pcs = gs.map(g => '<span class="dc-cp">' + pieceHTML(g.p) +
                            (g.n > 1 ? '<i class="dc-cn">' + g.n + "</i>" : "") +
                            "</span>").join("");
    return '<div class="dc-tray-row">' +
             '<button type="button" class="dc-tray-lbl" data-act="tally"' +
               ' title="看還沒翻開的暗子">' + esc(label) + "</button>" +
             '<span class="dc-tray-pcs">' +
             (gs.length ? pcs : '<span class="dc-none">—</span>') + "</span></div>";
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

  /* ⚠ v1.146.0 起**不收 mySide 了**(「你是紅方」那一行拿掉之後它就沒人用)——
     canAct 仍然要:連吃那一列只在「輪到我而且正在連吃」時才有內容。 */
  function renderActs(chainOn, canAct){
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
    /* ★★★ v1.146.0:「輪到你 / 你是紅方」那一行**整條拿掉了**。
       使用者:「最下面那邊的輪到誰,幫我考慮一下是不是可以不要有了,因為上方其實就只是了…
       我的目的是再空出一行的空間,目標就是為了讓棋盤能再大一點。」
       兩個資訊上方的玩家晶片本來就都有,而且是同一份真相:
         · **輪到誰** = 晶片的 `.turn` class(單機在 solo.js 的 chipHTML、
           連線在 mp-core.js 畫晶片那一段,兩邊都看 st.turn / turn===id)
         · **我是哪一方** = 晶片尾巴的 `.dc-chip-side`(adapter.js 的 chipTail 畫紅/黑;
           單機那份在 solo.js,分邊前是「?」)
       → 這一行只是把同一件事再寫一次,而它吃掉 22px + 5px 的 gap;拿掉 = 棋盤高 27px。
       ⚠ 拿掉它**不違反**「動作列高度必須固定」那條(見上面的 ⚠⚠⚠):
         那條要的是「一整局裡不變」,而這一行是**每一種狀態都不畫**,不是忽有忽無。
       ⚠⚠ 連帶要記住:styles.css 原本寫著「暗棋刻意沒有『可以翻』的高亮,
         『現在能不能動』由動作列那句『輪到你』講」—— 那句話從這一版起改成**晶片高亮**。
         所以晶片的 `.turn` 樣式從此是「能不能動」的唯一提示,不可以為了美觀弱化它。 */

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
     四之一、兩塊浮層:悶局倒數 · 記牌盤
     ──────────────────────────────────────────────────────────────────────────
       ★★★ 兩塊都掛在 **.dc-stage** 上、`position:absolute`,所以**一個像素都不佔版面**。
         這不是偷懶,是唯一做得對的地方:動作列的高度是規格(見四節的 ⚠⚠⚠),
         多一行 / 少一行就是「每走一手盤面上下跳一下」;而它們兩個一個是
         「只在快悶局時才出現」、一個是「開開關關」,**本質上就是會忽有忽無的東西**。
         → 忽有忽無的東西一律走浮層,不准進 #dcActs。
       ⚠ 浮層都掛在 stage(paint() 只重建 board.innerHTML,動不到它們)——
         與 .dc-reveal 同一個理由、同一個父層,但**各認各的 class**,
         clearReveals() 只掃 .dc-reveal,不會誤傷這兩塊。
     ========================================================================== */

  /* ---------- 悶局倒數(不受房規管)----------
     ★ 「連續 40 步沒吃沒翻 → 比階級總和」是這一頁最重要、也最容易被當成 bug 的規則:
       沒有任何預告的話,現場的體感是「棋還在下,忽然就跳結果卡了」。
     ⚠ 這個數字**不是隱藏資訊**(兩邊各自數手數就算得出來),所以它與下面的記牌盤不同,
       **不綁房規 foeCaps** —— 兩邊看到的本來就一樣。
     ⚠⚠ pointer-events:none 是規格不是美觀:它浮在盤面上,吃得到點擊的話被它蓋住的那一格
       就永遠點不到(跳棋那條紅線同構)。
     ★ 只在最後 10 步才出現 —— 一開局就掛一個「0/40」是雜訊,而且天天看得到就沒人看了。 */
  const IDLE_WARN = 10;             // 剩幾步以內才提醒
  const IDLE_HOT  = 5;              // 剩幾步以內轉紅
  function syncIdle(st){
    if(!stage || !board) return;
    let el = stage.querySelector(".dc-idle");
    const left = DC.IDLE_DRAW - (st.idle | 0);
    const show = !st.over && !cur.over && left <= IDLE_WARN && left > 0;
    if(!show){ if(el && el.parentNode) el.parentNode.removeChild(el); return; }
    if(!el){
      el = document.createElement("div");
      el.className = "dc-idle";
      stage.appendChild(el);
    }
    el.classList.toggle("dc-idle-hot", left <= IDLE_HOT);
    /* ⚠ 只有六個字,而那是**規格**:再長就會蓋到盤面上(見 styles 那條 ⚠⚠⚠)。
       用詞跟進場說明與規則卡一致(那兩處寫的就是「比子」),不要另造新詞;
       完整的一句話在記牌盤裡,結局那一句在 #winMsg。 */
    el.innerHTML = '<b>' + left + "</b> 步後比子";
    /* ★★★ 位置**用量的**,不是寫死的 CSS 角落。
       試過寫死 `top:5px;right:7px`,六種視窗裡有兩種會蓋到格子:盤面在舞台裡是置中的,
       而它有兩種擺法(4 欄 / 8 欄)—— 上方與側邊的空檔誰大誰小**每一種視窗都不一樣**,
       沒有一個固定的角落是兩種都安全的。
       ★ 規則只有一條:**讓浮標的下緣停在第一列格子的上緣**(= 盤面上緣 + PAD 那圈木框帶)、
         右緣對齊盤面右緣。它因此只會壓在木框帶與更上面的空檔上,**一顆棋子都遮不到**;
         而視覺上看起來就像貼在木框上的一張標籤。
       ⚠ 上面完全沒有空檔時(舞台正好被盤面填滿)會被 max(0,…) 夾住,
         最多壓進第一列 `高度 − PAD` ≈ 4px —— 那是一條細邊,不是遮住。
       ⚠⚠ PAD 這個數字有三份(board.js 的常數、CSS 的 .dc-board padding、木框帶那條
         box-shadow),這裡吃的就是本檔那一份,不要另外寫一個數字。
       ⚠ 讀 offsetHeight 會逼一次 layout —— 只在最後 10 步才會走到這裡,不是每一手都付。 */
    const br = board.getBoundingClientRect(), gr = stage.getBoundingClientRect();
    const ir = el.getBoundingClientRect();
    el.style.right = Math.max(0, Math.round(gr.right - br.right)) + "px";
    /* ⚠ 用 getBoundingClientRect().height 不用 offsetHeight(後者是整數,少算的
       那零點幾 px 就是壓在第一列格線上的毛邊),再往上讓 1px 保險。 */
    el.style.top = Math.max(0, Math.floor(br.top - gr.top + PAD - ir.height - 1)) + "px";
  }

  /* ---------- 記牌盤:還沒翻開的暗子裡,兩邊各還有哪幾種 ----------
     ★ 暗棋的博弈核心就是算牌(「將出來了沒」「他還有幾門炮」),而這件事目前只能硬記。
       這一塊把 DCAI.unseenTally() 那個集合畫出來 —— **與 AI 看的是同一份**,
       不多不少(32 顆 − 盤上已翻開的 − 已經被吃掉的),沒有任何位置資訊。

     ⚠⚠⚠ 它**綁房規 foeCaps**,而這條耦合不是保守,是算出來的:
       未現張數 = 總數 − 盤上明棋 − 雙方吃掉的。前兩項畫面上人人看得到、
       「我吃掉的」永遠顯示 → **把未現張數攤開,等於把「對手吃掉了什麼」直接算給你看**。
       而 foeCaps 預設關的時候,notes/19 那張房規表寫的就是「對手吃了什麼要自己記」。
       → 記牌盤與 foeCaps 是**同一種東西(記憶輔助)**,不能一個關著一個開著。
       ⚠ 順帶一提「階級總和」也一樣會漏(某方總和 = 52 − 他被吃掉那些子的階級和),
         所以它跟著放在這一塊裡面,不另外找地方顯示。
     ★ 房規沒開的時候**不是把入口藏起來**,是照樣打得開、裡面說清楚為什麼沒有 ——
       藏起來的話沒有人會知道有這個東西,也學不到那條房規在管什麼(同 whyNot() 的精神)。
     ⚠ 牌情紅線沒事:這裡一個 cells[i].p 都沒讀(unseenTally 走的是 knownAt()),
       而且它畫在 .dc-stage 底下、不在 #dcBoard 裡 —— 兩支守門掃的都是 #dcBoard。 */
  let tallyOpen = false;
  const RANKS = [7, 6, 5, 4, 3, 2, 1];

  function tallyCell(p, n){
    return '<span class="dc-tv' + (n > 0 ? "" : " dc-tv-0") + '">' +
             pieceHTML(p) + '<i class="dc-tn">' + n + "</i></span>";
  }
  function tallyBodyHTML(st){
    const showAll = !!(st.rules && st.rules.foeCaps) && (typeof DCAI !== "undefined");
    if(!showAll){
      return '<p class="dc-tally-off">這一局的房規是「對手吃子 · 不顯示」。<br>' +
             '未翻開的統計 <b>等於</b>把對手吃掉了什麼算出來(32 顆扣掉盤上看得到的、' +
             '再扣掉自己吃掉的,剩下的就是他吃掉的)——' +
             '所以這一局不提供,不然那條房規等於白開。<br>' +
             '<b>下一局</b>把房規的「對手吃子」改成「顯示」,這裡就會列出兩邊還剩哪幾種。</p>';
    }
    const tally = DCAI.unseenTally(st);
    let total = 0;
    for(let p = 0; p < 14; p++) total += Math.max(0, tally[p] | 0);
    const rows = RANKS.map(r =>
      tallyCell(DC.pieceOf(DC.RED, r),   tally[DC.pieceOf(DC.RED, r)]   | 0) +
      tallyCell(DC.pieceOf(DC.BLACK, r), tally[DC.pieceOf(DC.BLACK, r)] | 0)
    ).join("");
    return '<p class="dc-tally-sum">還沒翻開 <b>' + total + "</b> 顆</p>" +
           '<div class="dc-tally-grid">' +
             '<span class="dc-th dc-red-t">紅方</span><span class="dc-th dc-blk-t">黑方</span>' +
             rows +
           "</div>" +
           '<p class="dc-tally-ft">階級總和(悶局比這個)· 紅 <b>' + DC.sumSide(st, DC.RED) +
             "</b> · 黑 <b>" + DC.sumSide(st, DC.BLACK) + "</b></p>";
  }
  function tallyHTML(st){
    return '<div class="dc-tally-card" role="dialog" aria-label="還沒翻開的暗子">' +
             '<div class="dc-tally-hd"><b>未翻開的暗子</b>' +
               '<button type="button" class="dc-tally-x" aria-label="關閉">✕</button></div>' +
             tallyBodyHTML(st) +
             '<p class="dc-tally-idle">連續 <b>' + (st.idle | 0) + "</b> 步沒吃沒翻 · 滿 " +
               DC.IDLE_DRAW + " 步就比階級總和</p>" +
           "</div>";
  }
  /* 每次 paint() 都跟著更新內容(開著的時候對手走一手,數字要跟著動)。
     ⚠ 整段重建 innerHTML 就好 —— 這一塊沒有任何動畫,不會有「重建 = 重播」的問題。 */
  function syncTally(){
    if(!stage) return;
    let el = stage.querySelector(".dc-tally");
    const st = cur && cur.st;
    const show = tallyOpen && !!st && !st.over && !cur.over;
    if(!show){
      tallyOpen = false;
      if(el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if(!el){
      el = document.createElement("div");
      el.className = "dc-tally";
      // 蓋板本身吃掉點擊(不讓它穿到盤面),點哪裡都關掉 —— 含右上角那顆 ✕
      el.addEventListener("click", () => { tallyOpen = false; syncTally(); });
      stage.appendChild(el);
    }
    el.innerHTML = tallyHTML(st);
  }
  function toggleTally(){
    if(!cur || !cur.st) return;
    tallyOpen = !tallyOpen;
    syncTally();
  }
  // 離場 / 換局:兩塊浮層都要收掉(它們掛在 stage 上,board.innerHTML = "" 帶不走)
  function clearOverlays(){
    tallyOpen = false;
    if(!stage) return;
    stage.querySelectorAll(".dc-tally,.dc-idle").forEach(el => {
      if(el.parentNode) el.parentNode.removeChild(el);
    });
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
  /* ⚠ 悶局那兩種**要把數字講出來**(v2.3.7):「比階級總和」這五個字沒有回答
     「所以是幾比幾」,而那正是這一種結局唯一會被質疑的地方(現場的體感是
     「棋還在下,忽然就跳結果卡、還判我輸」)。局都結束了,兩邊看到的字也一樣 ——
     這裡把兩個數字攤開不涉及任何情報問題(對局中要看得綁房規,見四之一節)。
     ⚠⚠ 但**只在悶局那兩種**講:其它三種結局跟階級總和沒有關係,寫了只是雜訊,
       而且會把「這一局是怎麼結束的」這句話稀釋掉(六節開頭那條)。 */
  function sumTail(st){
    return "(紅 " + DC.sumSide(st, DC.RED) + " · 黑 " + DC.sumSide(st, DC.BLACK) + ")";
  }
  /* ---------- 結果卡的硃砂大印 ----------
     ★ 建議書:「終局蓋下一枚古樸方正的硃砂紅印章」。做法直接沿用**這個專案已經有的
       兩個先例**(台灣麻將 fx.js 的「大贏家」、成語接龍的 `.cy-seal`),不另發明一種:
       四個字照傳統印章的順序排(右上 → 右下 → 左上 → 左下)、住在卡片的**流內**、
       落下時下壓回彈 + 微微傾斜。暗棋是十四頁裡最東方的一頁,這一枚印放在這裡最不突兀。
     ⚠⚠⚠ 為什麼一定要在**流內**、不可以絕對定位到卡片角上(成語接龍量過的兩件事,
       這一頁同構,不要「順手」改成疊在角上):
       ① 疊上去會蓋掉 `.word`(這一頁是 clamp(28px,7.2vw,40px)),窄機一定撞 ——
          而這件事**只有截圖看得出來**(斷言問的是「印在不在、幾個字」,那時候全是綠的);
       ② 結果卡是 overflow-y:auto,絕對定位 + 放大的那一格會把角甩出卡片右緣 → 閃出捲軸。
     ⚠ **只有「贏 / 平手」才蓋,輸的那一份不蓋** —— 不必再對他強調一次。
       本機雙人沒有「我」的視角 → 用中性的那一句(同 endText(st, -1) 的處理)。
     ⚠⚠ `key` 是去重用的:連線的 `outcome()` 會被**反覆呼叫**,不去重的話印章一直重蓋
       (成語接龍踩過同一件事)。⚠ 換局時 `reset()` 會把它清掉,所以「連兩局的 key 剛好
       一樣」不會讓第二局漏掉那一下落款。
     ★ 刻意**不加**建議書的「金箔光點粒子」—— 贏的那一刻已經有 burst() 的彩帶,
       再灑一層金箔是同一件事做兩遍(而且結果卡上疊粒子動畫要重繪整張卡)。 */
  const SEAL_TXT = { win: "大獲全勝", side: "旗開得勝", draw: "勢均力敵" };
  let sealKey = "";
  function setSeal(kind, key){
    const el = $("dcSeal");
    if(!el) return;
    const txt = SEAL_TXT[kind] || "";
    if(!txt){
      el.classList.add("hidden"); el.classList.remove("dc-stamp");
      el.innerHTML = ""; sealKey = "";
      return;
    }
    const k = kind + "|" + (key == null ? "" : key);
    if(k === sealKey) return;                  // 同一局只蓋一次
    sealKey = k;
    el.innerHTML = [...txt].map(c => "<span>" + esc(c) + "</span>").join("");
    el.classList.remove("hidden");
    el.classList.remove("dc-stamp"); void el.offsetWidth; el.classList.add("dc-stamp");
  }
  function endText(st, mySeat){
    if(st.endBy === "wipe")  return "吃光對方所有棋子";
    if(st.endBy === "stuck") return "對方無子可動,也無暗棋可翻";
    if(st.endBy === "count") return "連續 " + DC.IDLE_DRAW + " 步沒吃沒翻 · 比階級總和 " + sumTail(st);
    if(st.endBy === "draw")  return "連續 " + DC.IDLE_DRAW + " 步沒吃沒翻 · 階級總和相同 " + sumTail(st);
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
        if(!b) return;
        if(b.dataset.act === "stop") fire(DC.STOP);
        // ★ 吃子欄的標籤自己就是「記牌盤」的入口(見 trayRow() 的註解)
        else if(b.dataset.act === "tally") toggleTally();
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

  /* o = { st, mySide, mine, over, key, cdMs, cdEnd, mySeat, names }
     ⚠ v1.146.0 拿掉了 turnName:「輪到誰」那一行沒有了(玩家晶片的 .turn 高亮在講),
       所以兩個 caller 都不必再算它。
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
    sel = -1; lastKey = -1; cur = null; prevUp = {};
    sealKey = "";                   // ⚠ 換局:不清的話「連兩局的 key 剛好一樣」會漏掉那一下落款
    stopCd();
    clearReveals();                 // ⚠ 它掛在 stage 上,不會被下面那行 board.innerHTML 帶走
    clearOverlays();                // ⚠ 同上:悶局倒數 / 記牌盤兩塊浮層也在 stage 上
    if(board) board.innerHTML = "";
    if(acts){ acts.innerHTML = ""; acts.classList.add("hidden"); }
  }

  return {
    init, setState, reset, paint,
    onAct(cb){ actCb = cb; },
    clearSel(){ sel = -1; },
    sel: () => sel,
    isWide: () => wide,
    pieceHTML, backHTML, resultHTML, endText, setSeal,
    moveSfx, sfx, stopCd
  };
})();

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
  let cdT = null;

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
    // 賠了一顆(炮打到自己人 / 翻攻被反吃)—— 往下掉的兩音
    oops(){ Sound.tone(420, { type: "sine", dur: 0.13, vol: 0.22, slideTo: 190 });
            Sound.tone(300, { type: "sine", dur: 0.18, vol: 0.18, slideTo: 130, delay: 0.10 }); },
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
    if(L.kind === "darkLose"){ sfx.flip(); sfx.oops(); return; }
    if(L.kind === "jump"){ sfx.cannon(); if(L.self) sfx.oops(); return; }
    if(st.chainLen > 1) sfx.chain(st.chainLen);
    else sfx.eat();
  }

  /* ==========================================================================
     二、棋子自繪
     ──────────────────────────────────────────────────────────────────────────
       ★ 用的是「帥仕相俥傌炮兵 / 將士象車馬包卒」這些**常用漢字** ——
         不是 CLAUDE.md 紅線 8 禁的 U+1F000 那一段(那些多數字型沒有,會變豆腐)。
     ========================================================================== */
  function pieceHTML(p){
    const side = DC.sideOf(p);
    return '<span class="dc-p ' + (side === DC.RED ? "dc-red" : "dc-blk") + '">' +
             '<i class="dc-ring"></i><b class="dc-ch">' + DC.nameOf(p) + '</b>' +
           '</span>';
  }
  // 牌背。★ 這裡**碰都不要碰** c.p —— 見檔頭的牌情紅線
  function backHTML(){
    return '<span class="dc-p dc-back" aria-label="暗棋"><i class="dc-ring"></i><b class="dc-grain"></b></span>';
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
      out.push('<button type="button" class="' + cls.join(" ") + '" data-sq="' + i +
               '" style="grid-row:' + g.row + ';grid-column:' + g.col + '">' +
               (c ? (c.up ? pieceHTML(c.p) : backHTML()) : "") +
               "</button>");
    }
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
  }

  /* ==========================================================================
     四、動作列
     ──────────────────────────────────────────────────────────────────────────
       ★ 「停在這裡」只在**連吃進行中而且還吃得到**的時候出現 ——
         沒得吃時規則層已經自動幫他結束了(rules.js 的 afterCapture)。
     ========================================================================== */
  function renderActs(chainOn, canAct, mySide){
    if(!acts) return;
    const st = cur.st;
    const bits = [];
    if(st.over || cur.over){
      acts.classList.add("hidden");
      acts.innerHTML = "";
      return;
    }
    const who = cur.turnName || "";
    const meTxt = mySide < 0 ? "還沒定" : ('<b class="' + (mySide === DC.RED ? "dc-red-t" : "dc-blk-t") + '">' +
                                           DC.sideName(mySide) + "方</b>");
    bits.push('<div class="dc-turn">' +
              (canAct ? '<b class="dc-you">輪到你</b>' : (who ? ("輪到 " + esc(who)) : "…")) +
              '<span class="dc-side">你是 ' + meTxt + "</span></div>");

    if(chainOn && canAct){
      const n = DC.chainTargets(st).length;
      bits.push('<div class="dc-chain-row">' +
                '<span class="dc-chain-txt">連吃中 · 已吃 <b>' + st.chainLen + '</b> 顆' +
                (n ? (' · 還可以吃 <b>' + n + "</b> 處") : "") + "</span>" +
                '<button type="button" class="btn dc-stop" data-act="stop">停在這裡</button></div>');
    }else if(canAct){
      bits.push('<div class="dc-tip">' +
                (sel >= 0 ? "點亮起來的格子走 / 吃,點自己別顆子可以換選"
                          : "點暗棋翻開,或點自己的子再選要去哪裡") + "</div>");
    }
    if(cur.cdEnd) bits.push('<div class="dc-cd" id="dcCd"></div>');
    acts.innerHTML = bits.join("");
    acts.classList.remove("hidden");
    if(cur.cdEnd) startCd(); else stopCd();
  }

  function startCd(){
    stopCd();
    const tick = () => {
      const el = $("dcCd");
      if(!el || !cur || !cur.cdEnd){ stopCd(); return; }
      const left = Math.max(0, Math.ceil((cur.cdEnd - Date.now()) / 1000));
      el.textContent = "⏱ " + left + " 秒";
      el.classList.toggle("hot", left <= 5);
    };
    tick();
    cdT = setInterval(tick, 250);
  }
  function stopCd(){ if(cdT){ clearInterval(cdT); cdT = null; } }

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
      showToast(i === st.chainFrom ? "點亮起來的格子繼續吃,或按「停在這裡」"
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

    if(!c){ showToast("那一格是空的,先點自己的子"); return; }
    if(!c.up){ fire(DC.encFlip(i)); return; }                       // 翻開
    if(mySide < 0){ showToast("先翻一顆棋"); return; }
    if(DC.sideOf(c.p) !== mySide){ showToast("那是對方的子"); return; }
    if(!DC.moveTargets(st, i).length){ showToast(DC.nameOf(c.p) + "這一步走不了,也沒得吃", 1600); return; }
    sel = i;
    paint();
  }

  function fire(mv){
    sel = -1;
    if(actCb) actCb(mv);
  }

  /* ==========================================================================
     六、結果卡
     ========================================================================== */
  function capsHTML(list){
    if(!list.length) return '<span class="dc-none">—</span>';
    return list.slice().sort((a, b) => DC.rankOf(b) - DC.rankOf(a)).map(pieceHTML).join("");
  }
  function endText(st){
    if(st.endBy === "wipe")  return "把對方的子吃光了";
    if(st.endBy === "stuck") return "對方走投無路(沒有子能動,也沒有暗棋能翻)";
    if(st.endBy === "count") return "悶到第 " + DC.IDLE_DRAW + " 步 —— 比剩下的棋子階級總和";
    if(st.endBy === "draw")  return "悶到第 " + DC.IDLE_DRAW + " 步,而且階級總和一模一樣";
    return "";
  }
  /* names = 兩個座位的名字;mySeat = 我坐哪;wins = [{n, plus}] 累積分(可省略) */
  function resultHTML(st, names, mySeat, wins){
    const sc = DC.score(st);
    const rows = sc.rows.map(r => {
      const win = (st.winner === r.seat);
      return '<tr class="' + (win ? "dc-w" : "") + (r.seat === mySeat ? " dc-me" : "") + '">' +
             '<td class="dc-r-nm">' + (win ? "👑 " : "") + esc(names[r.seat] || ("玩家" + (r.seat + 1))) +
             '<span class="dc-r-side ' + (r.side === DC.RED ? "dc-red-t" : "dc-blk-t") + '">' +
             (r.side < 0 ? "" : DC.sideName(r.side) + "方") + "</span></td>" +
             '<td class="dc-r-n">' + r.left + "</td>" +
             '<td class="dc-r-n">' + r.sum + "</td>" +
             '<td class="dc-r-caps">' + capsHTML(r.eaten) +
             (r.self.length ? ('<span class="dc-selfcap" title="自己打掉的">💥' + r.self.length + "</span>") : "") +
             "</td>" +
             (wins ? ('<td class="dc-r-n"><b>' + wins[r.seat].n + "</b>" +
                      (wins[r.seat].plus ? ('<i class="dc-plus">+' + wins[r.seat].plus + "</i>") : "") + "</td>") : "") +
             "</tr>";
    }).join("");
    return '<div class="dc-endby">' + endText(st) + "</div>" +
           '<table class="dc-table"><thead><tr>' +
           "<th>玩家</th><th>剩子</th><th>階級和</th><th>吃掉</th>" + (wins ? "<th>勝</th>" : "") +
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
    pieceHTML, backHTML, resultHTML, endText, capsHTML,
    moveSfx, sfx, stopCd
  };
})();

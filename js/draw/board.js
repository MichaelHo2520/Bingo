"use strict";

/* ============================================================================
   你畫我猜 — 畫布與對局畫面(DWB)。只管「畫面」與「本地互動」,
   什麼時候寫進 DB 一律由 js/draw/adapter.js 決定(比照其他十一個遊戲的 board/adapter 分工)。

   ★★★ 四件「不知道就會做錯」的事(完整版在 notes/21 的〇節):

   ① **座標一律正規化成 0~999 / 0~749 送出,畫布本身則是「有多少吃多少」(v1.155.2)。**
      也就是說:**每個人看到的畫按各自的畫布比例拉伸**,不是同一個形狀。
      ⚠⚠ 這是 v1.155.2 **刻意反轉**的決定,不是漏做 —— v1.154.0~v1.155.1 是把畫布
        鎖成 4:3(寧可留白也不變形),而使用者實測後說:
        「畫板一定要大一點,別人那邊的顯示可以依狀況進行大小的比例來縮放。」
        直向手機上那個鎖的代價是**畫布只有可用高度的 58%**(331×248,而舞台有 429)。
      ★ 取捨講白:直向手機之間長寬比很接近(0.7~0.8),差異看不太出來;
        真正會歪的是「手機畫的圖在桌機橫向視窗上看」。受眾是親友聚會、全部是手機
        → 換到大一倍的畫布划算得多。
      ★ 線上格式**一個字都不必改**:送出端本來就是拿自己的 rect 正規化
        (`(e.clientX-r.left)/r.width*LW`),接收端本來就是 `x*boxW/LW` ——
        拿掉 4:3 之後這兩行的語意自然從「固定邏輯空間」變成「各自比例縮放」。
        新舊版本同房也不會壞(只是看到的形狀不一樣)。

   ② **紙一律是淺色的,不吃主題變數。**
      墨水是深色的;紙如果跟著 midnight / arcade 變深,深墨水就整個看不見了 ——
      而那是「主題切到某一個才壞」的坑,平常測不到。畫板就是一張白紙,五個主題都一樣。

   ③ **筆劃一定要節流 + 量化才送出。**
      每個 pointermove 都送一次的話流量是二十倍起跳,而且畫面會延遲。
      這裡的參數(FLUSH_MS / MAX_PTS / MIN_D)是這個遊戲的效能紅線,
      不可以為了「畫得更順」把它們調掉 —— 順的是自己這台,炸的是別人那台。

   ④ **猜中的那一則絕對不可以進猜題列。**
      猜題列是廣播給全房看的(那是笑點來源),但把猜中的內容播出去 = 第一個猜中的人
      幫所有人報了答案。這裡的 addSay() **只收猜錯的**;猜中一律走 addHit()(只講「誰猜中了」)。
      → 這條與暗棋「不漏牌情」同一型,寫進 adapter 的 guess() 與這裡兩道。
   ========================================================================== */

const DWB = (function () {

  /* ---------- 邏輯座標系(見檔頭 ①) ---------- */
  const LW = 1000, LH = 750;

  /* ---------- 筆刷 ----------
     ★ v1 只用得到 c=0 / w=1(固定筆色、固定粗細)——但**編碼一開始就帶著這兩個欄位**,
       之後要加顏色 / 粗細只要放開 UI,線上格式一個字都不必改(舊版與新版也還能同房)。 */
  const COLORS = ["#20242c", "#e0413a", "#2f7de0", "#2fa14a", "#e8992b", "#8c4bd8"];
  const WIDTHS = [4, 8, 16];             // 邏輯單位(1000 寬的座標系裡)
  const DEF_C = 0, DEF_W = 1;

  /* ---------- 節流參數(見檔頭 ③) ---------- */
  const FLUSH_MS = 70;                   // 最多這麼久就送一批
  const MAX_PTS = 24;                    // 一批最多幾個點(超過就立刻送)
  const MIN_D = 4;                       // 與上一個取樣點的距離小於這麼多(邏輯單位)就丟掉

  let cb = {};                           // { onStroke, onClear, onGuess, onPick }
  let cv = null, ctx = null, dpr = 1;
  let boxW = 0, boxH = 0;                // 畫布的 CSS 尺寸(px)
  let strokes = [], byId = {};           // 這一回合畫了什麼(重畫 / 重連歸位的來源)
  let enabled = false;                   // 我現在能不能畫
  let drawing = null;                    // 正在畫的那一筆 { sid, c, w, p:[] }
  let pend = [], pendSid = -1, flushT = null;
  let nextSid = 1;
  let curC = DEF_C, curW = DEF_W;
  /* 畫布四周留這麼多(v1.155.2):`.dw-stage` 是 overflow:hidden,而紙有一圈 3px 的外框
     (`.dw-ink` 的第一段 box-shadow)—— 貼死就會被削掉,看起來像沒有邊。 */
  const INK_PAD = 4;

  /* ---------- 初始化 ---------- */
  function init(o) {
    cb = o || {};
    cv = $("dwInk");
    if (!cv) return;
    ctx = cv.getContext("2d");
    bindDraw();
    bindGuess();
    bindPick();
    addEventListener("resize", fit);
    fit();
  }

  /* ==========================================================================
     一、畫布尺寸與重畫
     ──────────────────────────────────────────────────────────────────────────
       ★ 用 JS 算成整數 px(比照暗棋 fitBoard / 成語接龍 fitStage)——
         CSS 的 aspect-ratio 同時吃 max-width / max-height 時,被夾住的那一邊
         不會把另一邊帶著縮,畫面比例會被壓歪(成語接龍 v1.135.0 踩過)。
       ⚠ dpr 夾在 2:手機常見 3,那是 2.25 倍的像素量,而畫的是純線條,看不出差別。

       ★★★ **畫布把舞台吃滿,不鎖長寬比**(v1.155.2,見檔頭 ①)。
          在此之前是鎖 4:3,代價在直向手機上很嚇人:實測舞台 429 高,而畫布只有 248 ——
          **58%**,剩下的 181px 是純空白(v1.155.1 那一版把它讓給猜題列,於是變成
          「畫板一樣小、下面多一塊很大的猜題板」,使用者兩件都不滿意)。
       ⚠ 只留 INK_PAD 的邊,其餘全吃 —— 這裡**不可以**再出現任何長寬比運算。
     ========================================================================== */
  function fit() {
    const stage = $("dwStage");
    if (!cv || !stage) return;
    const r = stage.getBoundingClientRect();
    const w = Math.max(80, Math.floor(r.width)  - INK_PAD * 2);
    const h = Math.max(60, Math.floor(r.height) - INK_PAD * 2);
    if (w === boxW && h === boxH && cv.width) return;   // 沒變就別重畫(重畫會閃)
    boxW = w; boxH = h;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    /* ★ 外框跟著同尺寸 —— 蓋板(選題 / 公布答案)是 inset:0 掛在它上面的。
       少了這兩行,蓋板會跟著 .dw-stage 的尺寸把畫布外面那一圈也蓋黑(見 draw.html 那段註解)。 */
    const wrap = $("dwWrap");
    if (wrap) { wrap.style.width = w + "px"; wrap.style.height = h + "px"; }
    repaint();
  }

  function sx(x) { return x * boxW / LW * dpr; }
  function sy(y) { return y * boxH / LH * dpr; }

  function clearCanvas() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
  }
  function strokePath(s) {
    if (!ctx || s.p.length < 2) return;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = COLORS[s.c] || COLORS[0];
    ctx.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[DEF_W]) * boxW / LW * dpr);
    ctx.beginPath();
    ctx.moveTo(sx(s.p[0]), sy(s.p[1]));
    for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(sx(s.p[i]), sy(s.p[i + 1]));
    // 只有一個點的筆劃(點一下)畫成一個圓點,否則什麼都看不到
    if (s.p.length === 2) ctx.lineTo(sx(s.p[0]) + 0.01, sy(s.p[1]));
    ctx.stroke();
  }
  function repaint() {
    clearCanvas();
    for (let i = 0; i < strokes.length; i++) strokePath(strokes[i]);
  }
  /* 增量畫「這一筆最後兩個點之間那一段」—— 整張重畫在筆劃多的時候會掉幀 */
  function drawTail(s) {
    if (!ctx || s.p.length < 4) { strokePath(s); return; }
    const n = s.p.length;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = COLORS[s.c] || COLORS[0];
    ctx.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[DEF_W]) * boxW / LW * dpr);
    ctx.beginPath();
    ctx.moveTo(sx(s.p[n - 4]), sy(s.p[n - 3]));
    ctx.lineTo(sx(s.p[n - 2]), sy(s.p[n - 1]));
    ctx.stroke();
  }

  /* ==========================================================================
     二、線上格式(見檔頭 ③)
     ──────────────────────────────────────────────────────────────────────────
       一筆推送就是一個字串:
         "s<sid>,<c>,<w>,<x>,<y>,<x>,<y>,…"   一段筆劃(可以是同一 sid 的續段)
         "x"                                   清空
       ★ 每一批都**自帶 c / w** → 每一筆推送是自足的,不依賴前面收到過什麼;
         重連只要照順序重放整包就一定畫得出一樣的圖。
       ★ 座標是 0~999 / 0~749 的整數 → 一個點約 7~8 個位元組。
       ⚠ 解析一律防呆:長度不對 / 不是數字的一律整筆丟掉(手改 DB、舊版本的殘留),
         **絕不可以讓一筆壞資料把整張圖弄掉**。
     ========================================================================== */
  function encode(sid, c, w, pts) { return "s" + sid + "," + c + "," + w + "," + pts.join(","); }
  function applyRec(rec) {
    if (typeof rec !== "string" || !rec) return;
    if (rec.charAt(0) === "x") { strokes = []; byId = {}; clearCanvas(); return; }
    if (rec.charAt(0) !== "s") return;
    const a = rec.slice(1).split(",");
    if (a.length < 5) return;                                   // sid,c,w + 至少一個點
    const sid = +a[0], c = +a[1], w = +a[2];
    if (!isFinite(sid) || !isFinite(c) || !isFinite(w)) return;
    const pts = [];
    for (let i = 3; i + 1 < a.length; i += 2) {
      const x = +a[i], y = +a[i + 1];
      if (!isFinite(x) || !isFinite(y)) return;                 // 壞了就整筆丟掉
      pts.push(x, y);
    }
    if (!pts.length) return;
    if (sid >= nextSid) nextSid = sid + 1;                      // 別人的 sid 也要讓過(重連當畫家時不撞號)
    let s = byId[sid];
    if (!s) { s = { sid: sid, c: c, w: w, p: [] }; byId[sid] = s; strokes.push(s); }
    const fresh = !s.p.length;
    s.p = s.p.concat(pts);
    if (fresh) strokePath(s);
    else {
      // 續段:從接點開始逐段補畫(不必整張重畫)
      const start = s.p.length - pts.length;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = COLORS[s.c] || COLORS[0];
      ctx.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[DEF_W]) * boxW / LW * dpr);
      ctx.beginPath();
      ctx.moveTo(sx(s.p[start - 2]), sy(s.p[start - 1]));
      for (let i = start; i < s.p.length; i += 2) ctx.lineTo(sx(s.p[i]), sy(s.p[i + 1]));
      ctx.stroke();
    }
  }
  function resetInk() {
    strokes = []; byId = {}; drawing = null;
    pend = []; pendSid = -1; nextSid = 1;
    if (flushT) { clearTimeout(flushT); flushT = null; }
    clearCanvas();
  }

  /* ==========================================================================
     三、本地作畫(只有畫家會走到)
     ========================================================================== */
  function pos(e) {
    const r = cv.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / r.width * LW);
    const y = Math.round((e.clientY - r.top) / r.height * LH);
    return [Math.max(0, Math.min(LW - 1, x)), Math.max(0, Math.min(LH - 1, y))];
  }
  function flush() {
    if (flushT) { clearTimeout(flushT); flushT = null; }
    if (!pend.length || pendSid < 0) { pend = []; return; }
    const rec = encode(pendSid, curC, curW, pend);
    pend = [];
    cb.onStroke && cb.onStroke(rec);
  }
  function armFlush() {
    if (flushT) return;
    flushT = setTimeout(() => { flushT = null; flush(); }, FLUSH_MS);
  }
  function onDown(e) {
    if (!enabled || e.button > 0) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    const p = pos(e);
    const sid = nextSid++;
    drawing = { sid: sid, c: curC, w: curW, p: [p[0], p[1]] };
    byId[sid] = drawing; strokes.push(drawing);
    strokePath(drawing);
    // 換一筆就把上一筆還沒送的先送掉(不然兩筆的點會混進同一個 sid)
    if (pendSid !== sid) { flush(); pendSid = sid; }
    pend.push(p[0], p[1]);
    armFlush();
  }
  function onMove(e) {
    if (!enabled || !drawing) return;
    e.preventDefault();
    const p = pos(e);
    const n = drawing.p.length;
    const dx = p[0] - drawing.p[n - 2], dy = p[1] - drawing.p[n - 1];
    if (dx * dx + dy * dy < MIN_D * MIN_D) return;             // 太近 → 丟掉(見檔頭 ③)
    drawing.p.push(p[0], p[1]);
    drawTail(drawing);
    pend.push(p[0], p[1]);
    if (pend.length >= MAX_PTS * 2) flush(); else armFlush();
  }
  function onUp(e) {
    if (!drawing) return;
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    drawing = null;
    flush();                                                    // 放手一定要立刻送(不然最後一段會慢 70ms)
  }
  function bindDraw() {
    /* ⚠ 一律用 Pointer Events + touch-action:none(CSS 那邊):
       用 touch 事件的話手指一動就會捲整頁,而畫布常常是滿版的 → 根本畫不出東西。 */
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("pointerleave", e => { if (drawing) onUp(e); });
  }
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled && drawing) { drawing = null; flush(); }
    if (cv) cv.classList.toggle("live", enabled);
  }
  // 清空:本地立刻生效,同時請 adapter 推一筆 "x"(讓別人也清)
  function clearInk() {
    if (!enabled) return;
    drawing = null; pend = []; pendSid = -1;
    if (flushT) { clearTimeout(flushT); flushT = null; }
    strokes = []; byId = {}; clearCanvas();
    cb.onClear && cb.onClear();
  }
  function setBrush(c, w) {
    if (COLORS[c]) curC = c;
    if (WIDTHS[w]) curW = w;
  }

  /* ==========================================================================
     四、回合資訊列 / 倒數環
     ──────────────────────────────────────────────────────────────────────────
       ★ 倒數的錨點是**相位開始的時間 + 這一段有多長**(不是「剩幾秒」)——
         每 200ms 用時間差重算,分頁被凍結過(手機切 App)也不會走鐘。
       ⚠ 用 key 去重:同一段倒數重畫畫面時不要重跑動畫(比照大老二 / 暗棋的 syncCd)。
     ========================================================================== */
  let cdKey = "", cdT = null, cdEnd = 0, cdTotal = 0;
  function stopCd() { if (cdT) { clearInterval(cdT); cdT = null; } cdKey = ""; }
  function tickCd() {
    const el = $("dwCd"); if (!el) return;
    const left = Math.max(0, cdEnd - Date.now());
    const sec = Math.ceil(left / 1000);
    const pct = cdTotal > 0 ? Math.max(0, Math.min(100, left / cdTotal * 100)) : 0;
    el.style.setProperty("--dw-p", pct.toFixed(1) + "%");
    el.textContent = sec;
    el.classList.toggle("hot", left <= 10000);
    if (left <= 0) stopCd();
  }
  function setCd(endAt, totalMs, key) {
    const el = $("dwCd"); if (!el) return;
    if (!endAt || !totalMs) { stopCd(); el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    if (key === cdKey && cdT) { cdEnd = endAt; cdTotal = totalMs; return; }
    cdKey = key || String(endAt);
    cdEnd = endAt; cdTotal = totalMs;
    if (cdT) clearInterval(cdT);
    tickCd();
    cdT = setInterval(tickCd, 200);
  }
  function setRoundInfo(txt, roleTxt, roleCls) {
    const r = $("dwRound"); if (r) r.textContent = txt || "";
    const o = $("dwRole");
    if (o) {
      o.textContent = roleTxt || "";
      o.className = "dw-role" + (roleCls ? " " + roleCls : "");
      o.classList.toggle("hidden", !roleTxt);
    }
  }

  /* ==========================================================================
     五、蓋板:選題目 / 公布答案
     ──────────────────────────────────────────────────────────────────────────
       ★ 這兩個蓋板住在 .dw-stage 裡面(不是 .veil 那種全螢幕強制回應層)——
         所以**不必列進 BACK_LAYERS**(那個陣列是雙胞胎,能不動就不動)。
       ⚠⚠ 三選一的按鈕**只有畫家畫得出來**。畫面上絕不可以先畫好再用 CSS 藏起來:
         那等於把答案放進每個人的 DOM 裡,而偷看 DOM 比偷看 DB 容易太多了。
     ========================================================================== */
  function showOver(html, cls) {
    const box = $("dwOver"); if (!box) return;
    box.className = "dw-over" + (cls ? " " + cls : "");
    box.innerHTML = html;
    box.classList.remove("hidden");
  }
  function hideOver() { const box = $("dwOver"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; } }

  /* 畫家的三選一。cands = 題目索引陣列;mine = 我是不是畫家。
     ⚠ mine 為 false 時**連題目文字都不產生**(見上面那條)。 */
  function paintPick(cands, mine, drawerName) {
    if (!mine) {
      showOver('<div class="dw-ov-card"><div class="dw-ov-t">' + esc(drawerName || "畫家") + ' 正在選題目…</div>' +
               '<div class="dw-ov-s">選好就開始畫,準備好猜了嗎 👀</div></div>', "wait");
      return;
    }
    const btns = (cands || []).map((idx, k) =>
      '<button class="dw-pickbtn" type="button" data-k="' + k + '">' +
        '<span class="dw-pk-ic">' + DWGen.iconAt(idx) + '</span>' +
        '<span class="dw-pk-w">' + esc(DWGen.textAt(idx)) + '</span>' +
      '</button>').join("");
    showOver('<div class="dw-ov-card"><div class="dw-ov-t">你是畫家 · 選一個來畫</div>' +
             '<div class="dw-picks">' + btns + '</div>' +
             '<div class="dw-ov-s">不選的話時間到會幫你選第一個</div></div>', "pick");
  }
  /* 三顆題目鈕的點擊。⚠ 用**事件委派、而且只綁一次** —— 綁在 paintPick 裡的話
     每重畫一次就多疊一個監聽(相位快照一動就重畫),按一下會送出好幾次。 */
  function bindPick() {
    const box = $("dwOver"); if (!box) return;
    box.addEventListener("click", e => {
      const b = e.target.closest(".dw-pickbtn"); if (!b) return;
      const k = +b.dataset.k;
      if (!isFinite(k)) return;
      box.querySelectorAll(".dw-pickbtn").forEach(x => x.classList.toggle("on", x === b));
      cb.onPick && cb.onPick(k);
    });
  }

  /* 公布答案。rows = [{name, pts, hit, seat}](含畫家,畫家那一列標 🎨) */
  function paintShow(word, rows) {
    const list = (rows || []).map(r =>
      '<div class="dw-sh-row' + (r.me ? " me" : "") + '">' +
        '<span class="dw-seat p' + (r.seat % 6) + '"></span>' +
        '<span class="dw-sh-n">' + esc(r.name) + (r.drawer ? ' <b>🎨</b>' : '') + '</span>' +
        '<span class="dw-sh-p">' + (r.pts > 0 ? "+" + r.pts : "—") + '</span>' +
      '</div>').join("");
    showOver('<div class="dw-ov-card"><div class="dw-ov-s">答案是</div>' +
             '<div class="dw-ov-w display">' + esc(word || "?") + '</div>' +
             '<div class="dw-sh-list">' + list + '</div></div>', "show");
  }

  /* ==========================================================================
     六、猜題列(見檔頭 ④:只收猜錯的)
     ========================================================================== */
  const SAY_MAX = 40;
  function sayBox() { return $("dwSay"); }
  function pushSay(html) {
    const box = sayBox(); if (!box) return;
    const el = document.createElement("div");
    el.className = "dw-say-row";
    el.innerHTML = html;
    box.appendChild(el);
    while (box.children.length > SAY_MAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  // 猜錯的:名字 + 內容(這是笑點來源,所以內容照實播)
  function addSay(name, text, seat, mine) {
    pushSay('<span class="dw-seat p' + ((seat | 0) % 6) + '"></span>' +
            '<span class="dw-say-n' + (mine ? " me" : "") + '">' + esc(name) + '</span>' +
            '<span class="dw-say-t">' + esc(text) + '</span>');
  }
  /* 猜中的:★★ **只講「誰猜中了」,不播內容**(檔頭 ④)。
     ⚠ 連「幾個字」都不要透露 —— 字數本身就是很強的提示。 */
  function addHit(name, seat, rank) {
    pushSay('<span class="dw-seat p' + ((seat | 0) % 6) + '"></span>' +
            '<span class="dw-say-hit">✅ ' + esc(name) + ' 猜中了' +
            (rank >= 0 ? '(第 ' + (rank + 1) + ' 個)' : '') + '</span>');
  }
  function sysSay(txt) { pushSay('<span class="dw-say-sys">' + esc(txt) + '</span>'); }
  function clearSay() { const box = sayBox(); if (box) box.innerHTML = ""; }

  /* ---------- 猜題輸入 ----------
     ⚠⚠ 中文輸入法(IME)選字時按 Enter 是「確定選字」,不是「送出」——
       不擋的話每選一次字就送出一次半成品(而且那些半成品會被算成猜錯、開始冷卻)。
       兩道一起看:composition 事件的旗標 + 標準的 e.isComposing。 */
  let composing = false;
  function bindGuess() {
    const inp = $("dwGuess"), btn = $("dwSend");
    if (!inp || !btn) return;
    inp.addEventListener("compositionstart", () => { composing = true; });
    inp.addEventListener("compositionend", () => { composing = false; });
    inp.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      if (composing || e.isComposing) return;
      e.preventDefault(); send();
    });
    btn.addEventListener("click", send);
  }
  function send() {
    const inp = $("dwGuess"); if (!inp) return;
    const t = (inp.value || "").trim();
    if (!t) return;
    inp.value = "";
    cb.onGuess && cb.onGuess(t);
  }
  /* 輸入列的狀態。st = { show, can, why, coolEnd }
       show   要不要顯示這一列(畫家 / 沒開打時整列收起來)
       can    現在能不能送
       why    不能送的原因(直接寫在 placeholder 上 —— 不用 disabled 靜默吃掉點擊,
              但欄位本身要鎖住,不然打了半天按下去沒反應更糟)
       coolEnd 冷卻到什麼時候(有值就自己倒數,到期自動解鎖) */
  let coolT = null;
  function setGuess(st) {
    const row = $("dwInputRow"), inp = $("dwGuess"), btn = $("dwSend");
    if (!row || !inp || !btn) return;
    row.classList.toggle("hidden", !st.show);
    if (coolT) { clearInterval(coolT); coolT = null; }
    const apply = () => {
      const left = st.coolEnd ? Math.max(0, st.coolEnd - Date.now()) : 0;
      const can = st.can && left <= 0;
      inp.disabled = !can; btn.disabled = !can;
      row.classList.toggle("cool", left > 0);
      inp.placeholder = left > 0 ? ("冷卻中… " + Math.ceil(left / 1000) + " 秒")
                                 : (can ? "打出你猜的答案" : (st.why || "現在不能猜"));
      if (left <= 0 && coolT) { clearInterval(coolT); coolT = null; }
    };
    apply();
    if (st.coolEnd && st.coolEnd > Date.now()) coolT = setInterval(apply, 200);
  }

  /* ==========================================================================
     七、放大模式(v1.155.0)
     ──────────────────────────────────────────────────────────────────────────
       使用者:「目前的畫板太小了…可以有一個放大的按鈕,按下去可以吃掉下面回答的
       一些空間。」→ 一顆 class 開關,收掉猜題列的大部分與頂列,全部讓給畫布。
       ★★ v1.155.2 起畫布**不鎖長寬比、把舞台吃滿**(見檔頭 ①)→ 省下來的每一個
         垂直像素都直接變成更高的畫布,**在任何視窗上都有用**,所以這顆鈕一律顯示。
       ⚠⚠ v1.155.1 曾經「限於寬時把它整顆藏起來」(那時 4:3 的鎖讓它在直向手機上
         按了不會有事)—— 鎖拿掉之後那個條件就不成立了,**不要再加回來**。
       ⚠ 真正的樣式在 styles.css 的 `body.dw-big` 那一段;這裡只負責
         **切 class 之後把畫布重新量一次**(`fit()` 讀的是即時的 getBoundingClientRect)。
       ⚠ 比分不在這裡收 —— 它現在住在房間框的玩家晶片列(見 draw.html 那段註解),
         放大模式刻意**不動它**:那是使用者要求「放進房間框」的東西。
     ========================================================================== */
  function setZoom(on) {
    document.body.classList.toggle("dw-big", !!on);
    const b = $("dwZoom");
    if (b) {
      b.classList.toggle("on", !!on);
      /* ⚠ 字面刻意用「大 / 小」而不是 ⤢ / ⤡:那兩個箭頭在手機上細得像雜訊
         (使用者:「好難看啊」),而中文字在哪一套字型都長一樣、也不必猜意思。 */
      b.textContent = on ? "小" : "大";
      b.title = on ? "縮小畫板" : "放大畫板";
      b.setAttribute("aria-label", b.title);
    }
    /* ⚠⚠ v1.155.2 起這一頁**刻意讓 `⛶`/`⚙️` 跟著頂列一起消失** ——
       showScreen("play") 呼叫的是 undockTools(),不是 dockTools("mpBar")。
       使用者:「如果放大畫板後,可以把全螢幕跟設定的按鈕給先隱藏,我不要把他們放進
       房間框,這樣 emoji 會很難按」(房間框那一列塞不下第五、六顆鈕,共用的
       .tools-docked 是 absolute 貼右緣 → 會直接壓在 😀 上面)。
       ⚠ 這一行留著是為了「縮小回來時把它們放回頂列」的那一半(toolsPanelId 是 null,
         syncTools() 會確保它們待在 toolsHome);拿掉不會壞,但留著語意完整。 */
    if (typeof syncTools === "function") syncTools();
    fit();
  }

  return {
    init, fit, resetInk, applyRec, setEnabled, clearInk, setBrush,
    setCd, stopCd, setRoundInfo, setZoom,
    paintPick, paintShow, hideOver, showOver,
    addSay, addHit, sysSay, clearSay, setGuess,
    LW, LH, COLORS, WIDTHS,
    // 診斷 / 測試用:目前畫了幾筆、共幾個點、畫布現在多大
    stats: () => ({ n: strokes.length, pts: strokes.reduce((a, s) => a + s.p.length / 2, 0), w: boxW, h: boxH })
  };
})();

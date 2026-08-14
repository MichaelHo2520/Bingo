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

   ⑤ **復原與直線(v1.163.0)——「手機上畫圖很辛苦」的兩個主因。**
      使用者:「目前畫畫這件事情其實是有一點辛苦的,因為大家都是用手機」。
      · **復原**是新的第三種線上記錄 `"u<sid>"`(把某一筆標成撤銷)。⚠ 它**不可以**
        真的把那一筆從 strokes 裡刪掉 —— 這一頁的真相是照順序 replay,而擦布是靠
        **疊在墨水上面**才有效果;抽掉中間一筆會讓後面每一筆擦布擦到不同的東西。
        所以撤銷只是掛一個 `un` 旗標,repaint() 跳過它。
      · **直線**是「只有兩個點的一筆」—— **線上格式一個字都不必改**(舊版也看得懂),
        這是它 CP 值最高的地方。手指在手機上畫不出直線,而房子 / 車窗 / 桌子全是直線。
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
  /* ★★★ 擦布(v1.157.0)。**它是一筆「記錄」,不是像素操作** ——
     這一頁的真相是 replay(照順序重放整包 ink),重連的人是靠重放把圖畫回來的。
     直接對 canvas 做像素刪除的話,擦掉的地方在別人那台、以及自己重連之後**會整片跑回來**。
     ★ 實作是 `globalCompositeOperation = "destination-out"`:
       畫布只有 clearRect(從不填色)、紙是 CSS 的 `.dw-ink{background:var(--dw-paper)}`
       → 擦成透明剛好露出紙,是真正的擦布,而且**主題換色也不會出錯**
       (用「白色筆」的話 midnight 主題的紙不是白的就會留下一道白痕)。
     ⚠ 擦布比筆粗才好用(筆最粗 16),而 w 欄位照樣寫進記錄 —— 保留給日後的「擦布大小」。 */
  const ER_W = 30;

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
  /* ⚠ pendEr 記的是**這一批屬於哪一種筆**,不可以在 flush 時才讀 curEr:
     使用者可能在 70ms 的批次還沒送出去之前就按了擦布 / 換色,那樣這一批會被貼上錯的種類。 */
  let pendEr = false;
  let nextSid = 1;
  /* ★★ 我自己送出去的 sid(v1.156.0)。存在的唯一理由是**把自己的回音擋掉**:
     畫家送出的每一批都會從 child_added 原封不動回到 applyRec,而那時本地早就畫過了。
     完整說明在 applyRec 裡那道 return 的註解。⚠ 每一回合要跟著 resetInk() 清掉。 */
  let mySids = new Set();
  let curC = DEF_C, curW = DEF_W;
  let curEr = false;                      // 現在拿的是擦布嗎(只影響自己這一端要送 s 還是 e)
  /* ★ 直線模式(v1.163.0):按下去記起點、放開才成一筆。中間那段只是**預覽**,
     不進 strokes、也不送出去 —— 一條直線最後只推送一次(兩個點)。
     ⚠ 直線走的是完全獨立的路徑,不碰 drawing / pend / flush(那三個是徒手畫的節流機制)。 */
  let curLine = false;
  let lineFrom = null, lineTo = null;
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
    bindTools();
    bindGuess();
    bindPick();
    addEventListener("resize", fit);
    /* ★★ 舞台自己變高變矮時也要重量(v1.156.0)。這一頁原本只掛 resize,而
       **切 body 的 class 不會發 resize** —— 於是「先看看畫板 👀」(共用的 peekBoard()
       只做 body.peeking,而 styles.css 給它 padding-bottom:66px)把舞台壓矮 66px 之後,
       畫布還維持舊高、`.dw-stage` 是 overflow:hidden、內容又置中 → 圖的上下**各被削掉 33px**
       (直向手機畫布 477 高 ⇒ 少掉 14%,而畫圖的人常把重點畫在中下方)。
       完全靜默:DOM 與 canvas 尺寸都合法,只有把它截下來才看得出來。
       ★ 十二頁裡只有這一頁沒掛 RO(另外八頁的 board 都有),補上之後連放大鈕、
         回結果卡、手機鍵盤與網址列收合全部一起涵蓋。
       ⚠ 不會形成迴圈:`.dw-stage` 是 `flex:1 1 0`,尺寸由父層分配、子元素撐不回去;
         而 fit() 第一行就有「尺寸沒變就直接 return」的守衛。
       ⚠ 仍然**不能只靠它**:RO 要等下一個 frame,中間會閃一下 —— 所以按下 👀 的那條路
         另外在 js/draw/main.js 同步再叫一次 fit()(比照 js/darkchess/board.js 那條註解)。 */
    const stage = $("dwStage");
    if (typeof ResizeObserver !== "undefined" && stage) new ResizeObserver(() => fit()).observe(stage);
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
  /* 一筆的畫筆設定 —— **筆與擦布唯一的差別就在這一支**(見上面 ER_W 那段)。
     ⚠⚠ `destination-out` 一定要在畫完之後**還原成 `source-over`**:
       它是 canvas 的全域狀態,漏還原的話下一筆真的墨水也會變成擦除
       (症狀是「擦一次之後就再也畫不出東西」,而且畫面上完全看不出原因)。
       所以四個畫的地方(strokePath / drawTail / applyRec 的續段 / repaint)一律走 penStyle + penEnd。 */
  function penStyle(s) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (s.er) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";                  // 擦除只看 alpha,顏色無關
      ctx.lineWidth = Math.max(1, ER_W * boxW / LW * dpr);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = COLORS[s.c] || COLORS[0];
      ctx.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[DEF_W]) * boxW / LW * dpr);
    }
  }
  function penEnd() { ctx.globalCompositeOperation = "source-over"; }
  function strokePath(s) {
    if (!ctx || s.p.length < 2) return;
    penStyle(s);
    ctx.beginPath();
    ctx.moveTo(sx(s.p[0]), sy(s.p[1]));
    for (let i = 2; i < s.p.length; i += 2) ctx.lineTo(sx(s.p[i]), sy(s.p[i + 1]));
    // 只有一個點的筆劃(點一下)畫成一個圓點,否則什麼都看不到
    if (s.p.length === 2) ctx.lineTo(sx(s.p[0]) + 0.01, sy(s.p[1]));
    ctx.stroke();
    penEnd();
  }
  function repaint() {
    clearCanvas();
    /* ⚠ 重畫一定要**照原本的順序**一筆一筆畫(含擦布那幾筆)——
       擦布是靠疊在墨水上面才有效果,順序換掉就會擦錯東西。
       ⚠ 被撤銷的那幾筆(un)只是跳過,**留在陣列裡不動**(見 applyRec 的 "u" 那段)。 */
    for (let i = 0; i < strokes.length; i++) if (!strokes[i].un) strokePath(strokes[i]);
  }
  /* 增量畫「這一筆最後兩個點之間那一段」—— 整張重畫在筆劃多的時候會掉幀 */
  function drawTail(s) {
    if (!ctx || s.p.length < 4) { strokePath(s); return; }
    const n = s.p.length;
    penStyle(s);
    ctx.beginPath();
    ctx.moveTo(sx(s.p[n - 4]), sy(s.p[n - 3]));
    ctx.lineTo(sx(s.p[n - 2]), sy(s.p[n - 1]));
    ctx.stroke();
    penEnd();
  }

  /* ==========================================================================
     二、線上格式(見檔頭 ③)
     ──────────────────────────────────────────────────────────────────────────
       一筆推送就是一個字串:
         "s<sid>,<c>,<w>,<x>,<y>,<x>,<y>,…"   一段筆劃(可以是同一 sid 的續段)
         "e<sid>,<c>,<w>,<x>,<y>,…"           一段**擦除**(v1.157.0;格式與 s 完全同形,c 不用)
         "u<sid>"                              **撤銷**那一筆(v1.163.0;見下面 applyRec 那段)
         "x"                                   清空
       ★ **直線不是新的一種記錄** —— 它就是「只有兩個點的 s」,所以線上格式一個字
         都不必改,舊版本收到照樣畫得出來(見檔頭 ⑤)。
       ★ 每一批都**自帶 c / w** → 每一筆推送是自足的,不依賴前面收到過什麼;
         重連只要照順序重放整包就一定畫得出一樣的圖。
       ★ 座標是 0~999 / 0~749 的整數 → 一個點約 7~8 個位元組。
       ⚠ 解析一律防呆:長度不對 / 不是數字的一律整筆丟掉(手改 DB、舊版本的殘留),
         **絕不可以讓一筆壞資料把整張圖弄掉**。
       ★★ 擦除**刻意用新的開頭字母 `e`,而不是新增一個顏色索引**:
         v1.156.x 以前的舊版 `applyRec` 第一件事就是 `if (charAt(0) !== "s") return` ——
         也就是舊版會**整筆忽略**擦除,最壞的下場是「他那台看到被擦掉的東西還在」。
         若改用顏色索引(例如 c=9),舊版會走 `COLORS[9] || COLORS[0]` →
         **在他那台畫出一道黑色塗鴉**,那比「沒擦到」難看也難解釋得多。
         這是與 v1.155.2「新舊版同房只是看到的形狀不一樣」同一種取捨。
     ========================================================================== */
  function encode(sid, c, w, pts, er) {
    return (er ? "e" : "s") + sid + "," + c + "," + w + "," + pts.join(",");
  }
  function applyRec(rec) {
    if (typeof rec !== "string" || !rec) return;
    /* ⚠ 清空也要同步復原鈕:本地按 🗑 走的是 clearInk()(那一支自己會叫 syncTool),
       但**收到別人 / 自己回音的 "x"** 走的是這一條 —— 少了它,清空之後畫布明明是空的、
       復原鈕卻還亮著,按下去會送出一筆撤銷一張根本不存在的圖。
       ★ 三個會改變「有沒有可撤的筆」的分支(x / u / 新筆)一律要叫它,一個都不能漏。 */
    if (rec.charAt(0) === "x") { strokes = []; byId = {}; mySids.clear(); clearCanvas(); syncTool(); return; }
    const kind = rec.charAt(0);
    /* ★★★ 撤銷一筆(v1.163.0)。**刻意用新的開頭字母,理由同擦布那一段**:
       v1.162.x 以前的舊版第一件事就是「不是 s 也不是 e 就整筆忽略」→ 舊版最壞的下場是
       「他那台看到被撤銷的那一筆還在」,而那是可以接受的;
       若改成塞進既有欄位(例如某個特殊的 c / w),舊版會照樣把它畫出來,更難解釋。
       ⚠⚠ **絕對不可以真的從 strokes 裡刪掉那一筆** —— 這一頁的真相是照順序 replay,
         而擦布是靠疊在墨水上面才有效;抽掉中間一筆會讓它後面每一筆擦布擦到不同的東西
         (症狀:撤銷一條線,結果畫面上另一個地方多了一塊沒擦乾淨的墨)。
         掛旗標 + repaint 跳過,順序與層次都保住。
       ⚠ 自己的回音照樣要擋(mySids)—— 本地在按下去的當下就已經撤銷了。 */
    if (kind === "u") {
      const usid = +rec.slice(1);
      if (!isFinite(usid) || mySids.has(usid)) return;
      const t = byId[usid];
      if (!t || t.un) return;
      t.un = true;
      repaint();
      syncTool();                      // 可撤的筆變少了 → 復原鈕可能要鎖起來
      return;
    }
    if (kind !== "s" && kind !== "e") return;
    const a = rec.slice(1).split(",");
    if (a.length < 5) return;                                   // sid,c,w + 至少一個點
    const sid = +a[0], c = +a[1], w = +a[2];
    if (!isFinite(sid) || !isFinite(c) || !isFinite(w)) return;
    /* ★★★ 自己送出的那一批一定要在這裡擋掉(v1.156.0 修)。
       adapter 的 child_added 是**掛給所有人的**(含畫家),而畫家在 onDown/onMove 就已經
       畫進 strokes/byId 了 —— 回音進來時 byId[sid] 存在 → fresh=false → 走下面那條
       「續段」分支,結果是:
         ① s.p 被 concat 第二次 → 本地點數是實際的兩倍(repaint / fit 的成本與記憶體跟著加倍)
         ② 續段分支從 s.p[start-2](= 這一批的最後一點)畫到這一批的第一點 =
            **多畫一條弦**。慢慢畫時只跨 3~4 個取樣點藏在筆畫底下,但畫快時 pend 會先撞到
            MAX_PTS 才送 → 那條弦橫跨 24 個取樣點,是看得見的切角。
         ③ 壞資料進了 strokes,之後任何一次重畫都會重現。
       ⚠ 只有畫家自己那台會中(別人的畫布一直是對的)→ 回報會是「我這邊畫的圖怪怪的」。
       ⚠⚠ **不可以改成「送出端不畫本地」**:flush 是 70ms / 24 點才送一批,不畫本地的話
         連按下去那一點都要等一趟批次 → 畫起來是一段一段跳的。即時回饋一定要留在本地。
       ⚠ mySids 只在 resetInk()(每一回合)與 "x" 時清 —— 重連重放時它是空的,
         整包記錄照樣會被畫出來(attachRound 是先 detach 再 resetInk,順序剛好對)。 */
    if (mySids.has(sid)) return;
    const pts = [];
    for (let i = 3; i + 1 < a.length; i += 2) {
      const x = +a[i], y = +a[i + 1];
      if (!isFinite(x) || !isFinite(y)) return;                 // 壞了就整筆丟掉
      pts.push(x, y);
    }
    if (!pts.length) return;
    if (sid >= nextSid) nextSid = sid + 1;                      // 別人的 sid 也要讓過(重連當畫家時不撞號)
    let s = byId[sid];
    /* ⚠ er 記在**這一筆**上(不是全域狀態):同一 sid 的續段一定是同一種筆,
       而不同 sid 之間筆與擦布會交錯 —— repaint() 靠這個旗標才畫得回原樣。 */
    /* ⚠ 這裡也要同步復原鈕:**畫家中途重連**時整包 ink 是靠這條路重放回來的
       (attachRound → resetInk → child_added 整批重放)—— 少了它,重連之後
       畫布上明明有東西,復原鈕卻一直灰著。 */
    if (!s) { s = { sid: sid, c: c, w: w, p: [], er: kind === "e" }; byId[sid] = s; strokes.push(s); syncTool(); }
    const fresh = !s.p.length;
    s.p = s.p.concat(pts);
    if (fresh) strokePath(s);
    else {
      // 續段:從接點開始逐段補畫(不必整張重畫)
      const start = s.p.length - pts.length;
      penStyle(s);                       // ⚠ 一定要走它:擦布的續段也要 destination-out
      ctx.beginPath();
      ctx.moveTo(sx(s.p[start - 2]), sy(s.p[start - 1]));
      for (let i = start; i < s.p.length; i += 2) ctx.lineTo(sx(s.p[i]), sy(s.p[i + 1]));
      ctx.stroke();
      penEnd();
    }
  }
  function resetInk() {
    strokes = []; byId = {}; drawing = null;
    pend = []; pendSid = -1; pendEr = false; nextSid = 1;
    /* ★ 每一回合把筆歸零:換人畫的時候不該繼承上一位畫家挑的顏色 / 還拿著擦布 / 還在直線模式。 */
    curC = DEF_C; curW = DEF_W; curEr = false;
    curLine = false; lineFrom = null; lineTo = null;
    syncTool();
    mySids.clear();                       // ⚠ 一定要跟著清:重連重放整包時它必須是空的
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
    const rec = encode(pendSid, curC, curW, pend, pendEr);
    pend = [];
    cb.onStroke && cb.onStroke(rec);
  }
  function armFlush() {
    if (flushT) return;
    flushT = setTimeout(() => { flushT = null; flush(); }, FLUSH_MS);
  }
  /* ---------- 直線模式的預覽(v1.163.0)----------
     ⚠⚠ `globalAlpha` 與 `globalCompositeOperation` 一樣是 canvas 的**全域狀態** ——
       漏還原的症狀是「之後畫的每一筆都是半透明的」,而且 DOM / 記錄全部正常。
       這裡用 try 之外的方式保證:設完立刻在同一支函式裡還原(不要跨函式)。
     ⚠ 預覽**不進 strokes、不送出去**:它每次 pointermove 都會被 repaint() 蓋掉重畫。 */
  function previewLine() {
    if (!ctx || !lineFrom || !lineTo) return;
    penStyle({ c: curC, w: curW, er: curEr });
    if (!curEr) ctx.globalAlpha = 0.55;                 // 擦布不透明化(destination-out 看不出深淺)
    ctx.beginPath();
    ctx.moveTo(sx(lineFrom[0]), sy(lineFrom[1]));
    ctx.lineTo(sx(lineTo[0]), sy(lineTo[1]));
    ctx.stroke();
    ctx.globalAlpha = 1;
    penEnd();
  }
  /* 直線放手 → 成一筆(兩個點)並**一次推送完畢**。
     ⚠ 不走 pend / flush:那套節流是給徒手畫的連續取樣用的,一條直線只有兩個點。
     ⚠ 但要先 flush() —— 上一筆徒手畫可能還有沒送出去的點,順序反了對方會看到接錯。 */
  function commitLine() {
    const a = lineFrom, b = lineTo || lineFrom;
    lineFrom = null; lineTo = null;
    if (!a) return;
    flush();
    const sid = nextSid++;
    const s = { sid: sid, c: curC, w: curW, p: [a[0], a[1], b[0], b[1]], er: curEr };
    byId[sid] = s; strokes.push(s);
    mySids.add(sid);                      // 這一筆的回音要擋掉(見 applyRec)
    repaint();                            // ⚠ 一定要整張重畫:預覽那條半透明的線還在畫布上
    cb.onStroke && cb.onStroke(encode(sid, curC, curW, s.p, curEr));
    syncTool();
  }
  function onDown(e) {
    if (!enabled || e.button > 0) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    const p = pos(e);
    // ★ 直線:按下去只記起點,放開才成筆(中間都是預覽)
    if (curLine) { lineFrom = p; lineTo = p; return; }
    const sid = nextSid++;
    drawing = { sid: sid, c: curC, w: curW, p: [p[0], p[1]], er: curEr };
    byId[sid] = drawing; strokes.push(drawing);
    mySids.add(sid);                      // 這一筆的回音要擋掉(見 applyRec)
    strokePath(drawing);
    // 換一筆就把上一筆還沒送的先送掉(不然兩筆的點會混進同一個 sid)
    if (pendSid !== sid) { flush(); pendSid = sid; pendEr = curEr; }
    pend.push(p[0], p[1]);
    armFlush();
    /* ⚠ 一定要在這裡叫一次:復原鈕的 disabled 是看「有沒有可撤的筆」(見 syncTool),
       而畫下第一筆之後沒有任何別的地方會再同步它 —— 漏掉的症狀是
       **畫了東西但復原鈕一直灰著**,而且畫布本身完全正常。
       ⚠ 放在 onDown(一筆一次)而不是 onMove(一秒幾十次)。 */
    syncTool();
  }
  function onMove(e) {
    if (!enabled) return;
    // ★ 直線:拖到哪就預覽到哪(⚠ 這一段一定要排在 drawing 那道守衛前面)
    if (lineFrom) {
      e.preventDefault();
      const q = pos(e);
      const ddx = q[0] - lineTo[0], ddy = q[1] - lineTo[1];
      if (ddx * ddx + ddy * ddy < MIN_D * MIN_D) return;        // 動太小就別重畫(整張 repaint 有成本)
      lineTo = q;
      repaint(); previewLine();
      return;
    }
    if (!drawing) return;
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
    // ★ 直線:放手才成一筆(⚠ 排在 drawing 那道守衛前面 —— 直線期間 drawing 一直是 null)
    if (lineFrom) {
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      commitLine();
      return;
    }
    if (!drawing) return;
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    drawing = null;
    flush();                                                    // 放手一定要立刻送(不然最後一段會慢 70ms)
  }
  /* 工具列:四顆色塊 + 擦布。⚠ 用事件委派掛在 #dwTools 上 —— 那一列會被 hidden/顯示,
     但元素不會重建,所以掛一次就夠(不必每回合重綁)。 */
  function bindTools() {
    const box = $("dwTools"); if (!box) return;
    /* ★★ 色塊的顏色**在這裡設**,CSS 裡刻意沒有色碼 —— COLORS 是唯一真相。
       兩邊各寫一份的症狀是「色塊看起來是藍的、畫出來是綠的」,而且沒有任何斷言會紅。 */
    for (let i = 0; i < SWATCHES; i++) {
      const b = $("dwSw" + i);
      if (b) b.style.background = COLORS[i];
    }
    box.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.id === "dwErase") { toggleEraser(); return; }
      if (b.id === "dwUndo") { undo(); return; }        // v1.163.0
      if (b.id === "dwLine") { toggleLine(); return; }  // v1.163.0
      const m = /^dwSw(\d)$/.exec(b.id || "");
      if (m) pickColor(+m[1]);
    });
    syncTool();
  }
  function bindDraw() {
    /* ⚠ 一律用 Pointer Events + touch-action:none(CSS 那邊):
       用 touch 事件的話手指一動就會捲整頁,而畫布常常是滿版的 → 根本畫不出東西。 */
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    // ⚠ 直線也要收(lineFrom):手指滑出畫布時那一筆得結掉,不然它會一直預覽著
    cv.addEventListener("pointerleave", e => { if (drawing || lineFrom) onUp(e); });
  }
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled && drawing) { drawing = null; flush(); }
    /* ⚠ 時間到的那一刻可能正拖著一條還沒放手的直線 —— 丟掉(不是 commit):
       相位已經換了,adapter 的 ink() 也寫不進去,留著只會在畫布上掛一條預覽線。 */
    if (!enabled && lineFrom) { lineFrom = null; lineTo = null; repaint(); }
    if (cv) cv.classList.toggle("live", enabled);
  }
  // 清空:本地立刻生效,同時請 adapter 推一筆 "x"(讓別人也清)
  function clearInk() {
    if (!enabled) return;
    drawing = null; pend = []; pendSid = -1;
    lineFrom = null; lineTo = null;   // 拖到一半的直線也一起丟掉
    if (flushT) { clearTimeout(flushT); flushT = null; }
    strokes = []; byId = {}; mySids.clear(); clearCanvas();
    curEr = false;                    // 清空之後回到筆(擦空白的紙沒有意義)
    syncTool();
    cb.onClear && cb.onClear();
  }

  /* ---------- 復原(v1.163.0)----------
     ★★ 使用者要的第一件事:「畫壞了只能整張清空」是手機上最大的挫折來源
       —— 手指粗、60 秒倒數,錯一筆等於整張重畫。
     ⚠ 撤銷的是「**還沒被撤銷的最後一筆**」,而且只掛旗標不刪除(見 applyRec 的 "u")。
     ⚠⚠ 一定要**先 flush()**:剛畫完的那一筆可能還有點卡在 pend 裡(70ms 的批次)。
       順序反了的話對方會先收到 "u<sid>" 再收到那一筆的後半段 →
       **那一筆在他那台會復活一半**,而自己這台看起來完全正常。
     ⚠ 沒有 redo(刻意):一顆鈕解決 95% 的情況,兩顆鈕在 360px 的工具列上放不下,
       而且「復原完又想還原」在 60 秒的回合裡幾乎不會發生。 */
  function lastLive() {
    for (let i = strokes.length - 1; i >= 0; i--) if (!strokes[i].un) return strokes[i];
    return null;
  }
  function undo() {
    if (!enabled) return;
    flush();                          // ⚠ 見上面那段(順序錯了那一筆會在別人那台復活一半)
    const s = lastLive();
    if (!s) return;
    s.un = true;
    if (drawing === s) drawing = null;
    repaint();
    syncTool();
    cb.onStroke && cb.onStroke("u" + s.sid);
  }
  function setBrush(c, w) {
    if (COLORS[c]) curC = c;
    if (WIDTHS[w]) curW = w;
  }
  /* ---------- 工具列的狀態(v1.157.0:四色 + 擦布) ----------
     ★ 只有這一支會碰畫面上的 on 狀態 —— 選色 / 選擦布 / 清空 / 換回合都走它,
       所以「畫面上亮的那一顆」與 curC / curEr 不可能不一致。
     ⚠ 色塊只放前四色(墨黑 / 紅 / 藍 / 綠)—— COLORS 有六個,橘與紫沒有 UI。
       那不是漏做:`#dwTools` 那一列在 360px 的手機上要同時放題目 + 色塊 + 擦布 + 清空,
       六顆會把題目擠到只剩省略號,而題目是畫家唯一要讀的字。
       線上格式照樣吃 0~5,所以日後要放開只要加兩顆色塊,協議一個字都不必改。 */
  const SWATCHES = 4;
  function syncTool() {
    for (let i = 0; i < SWATCHES; i++) {
      const b = $("dwSw" + i);
      if (b) b.classList.toggle("on", !curEr && curC === i);
    }
    const er = $("dwErase");
    if (er) { er.classList.toggle("on", curEr); er.setAttribute("aria-pressed", curEr ? "true" : "false"); }
    const ln = $("dwLine");
    if (ln) { ln.classList.toggle("on", curLine); ln.setAttribute("aria-pressed", curLine ? "true" : "false"); }
    /* ⚠ 復原鈕沒東西可撤時要**真的鎖住**(disabled),不是只調透明度 ——
       按了沒反應比灰著更讓人以為壞了。 */
    const un = $("dwUndo");
    if (un) un.disabled = !lastLive();
    // 只改鼠標樣式,不影響任何幾何(擦布優先 —— 兩個可以並用時鼠標講的是「會擦掉」)
    if (cv) { cv.classList.toggle("erasing", curEr); cv.classList.toggle("lining", curLine && !curEr); }
  }
  function pickColor(i) {
    if (!COLORS[i]) return;
    curC = i; curEr = false; syncTool();
  }
  function toggleEraser(on) {
    curEr = (on === undefined) ? !curEr : !!on;
    syncTool();
  }
  /* 直線模式。⚠ 與擦布**刻意可以並用**(擦一條直線是很自然的需求),
     所以這裡不去動 curEr —— 兩個旗標各自獨立。 */
  function toggleLine(on) {
    curLine = (on === undefined) ? !curLine : !!on;
    if (!curLine && lineFrom) { lineFrom = null; lineTo = null; repaint(); }
    syncTool();
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
  /* ★★ 猜題者的字數提示(v1.161.0)。n = 正解有幾個字;**0 = 整格收起來**。
     使用者:「我覺得要猜的人應該要知道有幾個字,這樣才不會太廣泛」——
     沒有這一格的話「畫了一隻四隻腳的動物」可以是貓 / 狗 / 牛 / 長頸鹿,範圍大到猜不動。
     ⚠⚠ 這一格**只准放數字**,絕對不可以放題目本身(連「遮起來的字」也不行)——
       偷看 DOM 比偷看 DB 容易太多,那正是 paintPick 對非畫家連文字都不產生的同一條理由。
     ⚠ 誰看得到、什麼時候顯示一律由 adapter 的 paintBar 決定(這一支只管畫),
       而**畫家不需要**:他看的是工具列那一格題目本身。
     ⚠ 這一格住在 .dw-bar(既有的一列)裡,不是新開一列 —— 這一頁多出來的垂直空間
       永遠是畫布的(見 notes/21 紅線 17)。 */
  function setLen(n) {
    const el = $("dwLen"); if (!el) return;
    const k = Math.max(0, n | 0);
    el.classList.toggle("hidden", !k);
    el.innerHTML = k ? '<span class="dw-len-l">答案</span><b>' + k + '</b> 字' : "";
    el.setAttribute("aria-label", k ? ("答案有 " + k + " 個字") : "");
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
      /* 分享鈕與題目鈕共用這一個委派(蓋板每換一次相位就整段重畫,綁在 paintShow 裡
         會每重畫一次多疊一個監聽 → 按一下送出好幾次)。 */
      if (e.target.closest(".dw-shbtn")) { shareShot(); return; }
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
    /* ★★ 分享鈕放在**這張蓋板上**(v1.164.0)—— 那是最自然的時刻:答案剛揭曉、圖還在、
       大家在笑。而且**零版面成本**:工具列與回合列都已經滿了,往那兩列塞就是從畫布身上
       拿高度(見紅線 17)。⚠ 作畫中刻意沒有這顆鈕:那時題目還沒公布,分享出去的圖
       連「答案幾個字」都寫不了,就只是一張沒有故事的塗鴉。
       ⚠⚠ 它是**卡片的兄弟、貼在蓋板右上角**,不是卡片裡的一列 —— 第一版放進卡片裡,
         矮視窗(舞台 213px)上把卡片撐高 39px 直接被 .dw-stage 裁掉;
         改成卡片自己捲之後又變成「要捲一下才找得到」,而這張卡只活 5 秒。
         貼在角落就與卡片多高完全無關,永遠在同一個位置。 */
    showOver('<button class="dw-shbtn" type="button" title="分享這張畫" aria-label="分享這張畫">📤</button>' +
             '<div class="dw-ov-card"><div class="dw-ov-s">答案是</div>' +
             '<div class="dw-ov-w display">' + esc(word || "?") + '</div>' +
             '<div class="dw-sh-list">' + list + '</div></div>', "show");
  }

  /* ==========================================================================
     六、猜題列(見檔頭 ④:只收猜錯的)
     ========================================================================== */
  const SAY_MAX = 40;
  /* ★★ 這一回合的猜測紀錄(v1.164.0,分享圖要用)。畫面上那幾列是 innerHTML,
     要重新解析回來太脆弱 —— 這裡另外留一份結構化的。
     ⚠⚠ **sayLog 只收猜錯的**(addSay 本來就只收猜錯的,見檔頭 ④),
       而 hitLog **一個字的內容都不存** —— 猜中的人打的就是正解,存了等於把答案留在手上。 */
  let sayLog = [], hitLog = [];
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
    sayLog.push({ n: String(name || ""), t: String(text || "") });   // 分享圖要用(只有猜錯的)
    pushSay('<span class="dw-seat p' + ((seat | 0) % 6) + '"></span>' +
            '<span class="dw-say-n' + (mine ? " me" : "") + '">' + esc(name) + '</span>' +
            '<span class="dw-say-t">' + esc(text) + '</span>');
  }
  /* 猜中的:★★ **只講「誰猜中了」,不播內容**(檔頭 ④)。
     ⚠ v1.161.0 起「正解幾個字」是**公開的提示**(見 setLen),但這裡照樣一個字都不播:
       猜中的人打的可能是**同義詞**(貓咪 / 小貓),長度與正解不一樣 → 播了等於多送一條
       正解之外的線索;而內容本身更是直接把答案報給全房。「字數公開」不等於「這一則可以播」。 */
  function addHit(name, seat, rank, secs) {
    /* ⚠ secs 只是給分享圖用的(v1.164.0)——**內容一個字都不進來**,同上面那條。 */
    hitLog.push({ n: String(name || ""), s: +secs > 0 ? +secs : 0 });
    pushSay('<span class="dw-seat p' + ((seat | 0) % 6) + '"></span>' +
            '<span class="dw-say-hit">✅ ' + esc(name) + ' 猜中了' +
            (rank >= 0 ? '(第 ' + (rank + 1) + ' 個)' : '') + '</span>');
  }
  function sysSay(txt) { pushSay('<span class="dw-say-sys">' + esc(txt) + '</span>'); }
  function clearSay() {
    const box = sayBox(); if (box) box.innerHTML = "";
    sayLog = []; hitLog = [];      // ⚠ 兩份一起清:換回合時分享圖不可以帶著上一題的猜測
  }

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
  /* 輸入列的狀態。st = { show, can, why, coolEnd, len }
       show   要不要顯示這一列(畫家 / 沒開打時整列收起來)
       can    現在能不能送
       why    不能送的原因(直接寫在 placeholder 上 —— 不用 disabled 靜默吃掉點擊,
              但欄位本身要鎖住,不然打了半天按下去沒反應更糟)
       coolEnd 冷卻到什麼時候(有值就自己倒數,到期自動解鎖)
       len    正解幾個字(v1.161.0;0 / 沒給就不提)—— ★ 手指在打字時眼睛就在這一格,
              頂列那一顆晶片容易被忽略,所以字數**兩個地方都講一次**。 */
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
                                 : (can ? ("打出你猜的答案" + (st.len > 0 ? " · " + st.len + " 個字" : ""))
                                        : (st.why || "現在不能猜"));
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
    /* ★★★ 放大**只在對局畫面生效**(v1.161.0 修的 bug)。
       `body.dw-big` 會把整條頂列收掉(styles.css),而頂列裡是**遊戲名稱 + ⛶ + ⚙️** ——
       在對局中那是要的(使用者自己按的放大),但在**連線畫面與大廳**就是災難:
       放大鈕住在 `#dwPlay` 裡面,那兩層它是 hidden → **沒有任何東西可以把它關回來**。
       ⚠⚠ 而且一定會發生:放大狀態記在偏好裡(`dwZoom`),`loadPrefs()` 在開頁那一刻就
         會套用 → 只要上一場結束時忘了縮小,**之後每次開這一頁都少了名稱與那兩顆鈕**,
         而且看起來就像「這一頁跟別的遊戲長得不一樣」(使用者回報的正是這句)。
       ⚠ 守衛擋在這裡而不是各個呼叫端:`body.dw-big` 只有這一行在掛,擋在源頭就不必
         要求每一個呼叫端記得判斷(偏好、放大鈕、截圖頁三條路都會經過)。
       ⚠ 連帶一條:**離開對局的那一刻要再呼叫一次** —— class 是掛在 body 上的,
         沒人來脫它就會留著。那一半在 js/draw/main.js 的 showScreen()(每次換畫面都叫)。 */
    const play = $("dwPlay");
    const live = !!play && !play.classList.contains("hidden");
    document.body.classList.toggle("dw-big", !!on && live);
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

  /* ==========================================================================
     八、分享這張畫(v1.164.0)
     ──────────────────────────────────────────────────────────────────────────
       使用者:「可以考慮做一個功能,把目前的畫面分享到 line 之類的」
       以及:「我覺得題目不要分享出來,其他的內容就可以,包含了誰猜了什麼」

       ★★★ **分享圖刻意不寫題目** —— 這讓它從「存檔」變成**給 LINE 群組玩的謎題**:
         收到的人看畫 + 看大家猜了什麼,自己猜。
       ⚠⚠ 所以「誰猜了什麼」**只能放猜錯的那幾則**:猜中的人打的就是正解(或同義詞),
         印上去等於把答案印上去,與「題目不要分享」直接矛盾。
         猜中的一律只寫「✅ 某某猜中了(3.2 秒)」——同檔頭 ④ 的理由,延伸到分享圖。
       ★ 但**「答案幾個字」要寫**:那本來就是遊戲裡公開給猜題者的提示,而且沒有它
         收到圖的人範圍太大、根本猜不動 —— 有它才成立為一道謎題。

       ★★ 匯出一律用**邏輯座標系 1000×750**(不是現在畫布的尺寸)——
         每一台裝置分享出來的圖才會一模一樣、也不會因為誰的手機小就糊掉。

       ⚠⚠⚠ **不可以「先填紙色再把筆劃畫上去」** —— 擦布是 `destination-out`,
         紙色已經在下面的話,擦布會**把紙也一起擦掉**,分享出去是一個透明的洞
         (在 LINE 深色模式下就是一塊黑斑)。一定要兩層:
           ① 透明的畫布上畫墨水 + 擦布(與線上那張畫的機制完全相同)
           ② 另一張填好紙色的畫布,再把 ① 貼上去
         這正是線上那張畫的做法(canvas 透明、紙是 CSS 背景),只是要自己補上紙。
     ========================================================================== */
  const SHOT_SAYS = 3;                 // 字幕最多放幾則猜錯的(取最早的幾則,每台裝置一致)
  const SHOT_PAD = 34, SHOT_LINE = 46;
  let shotInfo = {};                   // { drawer, len } —— 由 adapter 在公布答案時給

  function setShotInfo(o) { shotInfo = o || {}; }

  /* 紙的顏色**只有一份真相**(styles.css 的 --dw-paper)—— 這裡讀 computed 值,
     刻意不在 JS 裡再寫一份色碼(同色塊讀 COLORS[i] 那條的理由)。 */
  function paperColor() {
    const el = $("dwInk");
    const c = el ? getComputedStyle(el).backgroundColor : "";
    return (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") ? c : "#fffdf7";
  }
  /* 把 strokes 依邏輯座標畫進任意一個 context(給匯出用;畫面上那張走 repaint)。
     ⚠ 撤銷掉的跳過、順序不可以動 —— 與 repaint() 同一套規矩。 */
  function paintTo(g, W, H) {
    const kx = W / LW, ky = H / LH;
    g.lineCap = "round"; g.lineJoin = "round";
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      if (s.un || s.p.length < 2) continue;
      if (s.er) {
        g.globalCompositeOperation = "destination-out";
        g.strokeStyle = "rgba(0,0,0,1)";
        g.lineWidth = Math.max(1, ER_W * kx);
      } else {
        g.globalCompositeOperation = "source-over";
        g.strokeStyle = COLORS[s.c] || COLORS[0];
        g.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[DEF_W]) * kx);
      }
      g.beginPath();
      g.moveTo(s.p[0] * kx, s.p[1] * ky);
      for (let j = 2; j < s.p.length; j += 2) g.lineTo(s.p[j] * kx, s.p[j + 1] * ky);
      if (s.p.length === 2) g.lineTo(s.p[0] * kx + 0.01, s.p[1] * ky);
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";     // ⚠ 一定要還原(同 penEnd)
  }
  /* 字幕。★ 回傳的每一則都已經是最終文字 —— 這一支是「分享圖上會出現什麼」的唯一真相,
     要驗「題目沒有洩漏出去」只要驗它就夠了。 */
  function shotLines() {
    const out = [];
    const who = shotInfo.drawer ? (shotInfo.drawer + " 畫的") : "";
    const len = shotInfo.len > 0 ? ("答案 " + shotInfo.len + " 個字") : "";
    out.push({ t: (who && len) ? (who + " · " + len) : (who || len || "你畫我猜"), head: true });
    // ⚠⚠ 只有猜錯的(見上面那段)
    sayLog.slice(0, SHOT_SAYS).forEach(r => out.push({ t: r.n + " 猜:" + r.t }));
    if (hitLog.length) {
      const h = hitLog[0];
      out.push({ t: "✅ " + h.n + " 猜中了" + (h.s > 0 ? "(" + h.s.toFixed(1) + " 秒)" : ""), ok: true });
    } else {
      out.push({ t: "😅 這一題沒有人猜中", ok: true });
    }
    return out;
  }
  /* 合成整張圖 → dataURL。★★ 全程**同步**:iOS 要求 navigator.share() 在使用者手勢裡呼叫,
     中間 await 一下(例如用非同步的 toBlob)手勢授權就過期了,分享會靜靜失敗。 */
  function shotDataUrl() {
    const lines = shotLines();
    const capH = SHOT_PAD * 2 + lines.length * SHOT_LINE;
    // ① 透明層:墨水與擦布(見上面 ⚠⚠⚠)
    const ink = document.createElement("canvas");
    ink.width = LW; ink.height = LH;
    paintTo(ink.getContext("2d"), LW, LH);
    // ② 紙 + 貼上 ① + 字幕
    const out = document.createElement("canvas");
    out.width = LW; out.height = LH + capH;
    const g = out.getContext("2d");
    g.fillStyle = paperColor();
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(ink, 0, 0);
    g.strokeStyle = "rgba(0,0,0,.12)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(SHOT_PAD, LH); g.lineTo(LW - SHOT_PAD, LH); g.stroke();
    let y = LH + SHOT_PAD + 30;
    lines.forEach(l => {
      g.fillStyle = l.head ? "#20242c" : (l.ok ? "#2f7de0" : "rgba(32,36,44,.72)");
      g.font = (l.head ? "800 34px " : "700 30px ") + "'Nunito','Noto Sans TC',sans-serif";
      g.fillText(l.t, SHOT_PAD, y);
      y += SHOT_LINE;
    });
    g.fillStyle = "rgba(32,36,44,.34)";
    g.font = "700 24px 'Nunito','Noto Sans TC',sans-serif";
    const mark = "你畫我猜 🎨";
    g.fillText(mark, LW - SHOT_PAD - g.measureText(mark).width, LH + capH - SHOT_PAD + 6);
    return out.toDataURL("image/png");
  }
  // dataURL → File(同步;見 shotDataUrl 上面那段為什麼不可以用 toBlob)
  function dataUrlToFile(url, name) {
    try {
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type: "image/png" });
    } catch (e) { return null; }
  }
  /* 按下分享。回傳 "share" / "download" / "empty"(給 e2e 判斷走了哪一條)。
     ⚠⚠ 這一頁跑在 app.html 的滿版 iframe 裡,而 Web Share 受權限政策管 ——
       **`app.html` 的 iframe 一定要有 `allow="web-share"`**,否則 share() 直接
       NotAllowedError。那是「直接開 draw.html 測都正常、包進外殼就永遠失敗」的坑。
     ⚠ 桌機大多沒有「分享檔案」→ 退成下載 PNG(不要什麼都不做)。 */
  const SHOT_TXT = "猜猜這是什麼?🎨";
  function shareShot() {
    if (!strokes.some(s => !s.un)) { try { showToast("這一張還沒有畫東西 🙂"); } catch (e) {} return "empty"; }
    const url = shotDataUrl();
    const file = dataUrlToFile(url, "draw.png");
    const nv = navigator;
    if (file && nv.share && (!nv.canShare || nv.canShare({ files: [file] }))) {
      /* ⚠ 不 await:使用者按取消會 reject,那不是錯誤,吞掉就好。 */
      try { nv.share({ files: [file], text: SHOT_TXT }).catch(() => {}); return "share"; } catch (e) {}
    }
    const a = document.createElement("a");
    a.href = url; a.download = "你畫我猜.png";
    document.body.appendChild(a); a.click(); a.remove();
    try { showToast("已存成圖片 📥"); } catch (e) {}
    return "download";
  }

  return {
    init, fit, resetInk, applyRec, setEnabled, clearInk, setBrush,
    pickColor, toggleEraser, toggleLine, undo, syncTool,
    setShotInfo, shareShot, shotLines, shotDataUrl,
    setCd, stopCd, setRoundInfo, setLen, setZoom,
    paintPick, paintShow, hideOver, showOver,
    addSay, addHit, sysSay, clearSay, setGuess,
    LW, LH, COLORS, WIDTHS,
    /* 診斷 / 測試用:目前畫了幾筆、共幾個點、畫布現在多大。
       ⚠ n / pts 一律只算**看得見的**(跳過被撤銷的)—— 那才是「畫面上有什麼」;
         被撤銷了幾筆另外走 un(v1.163.0)。 */
    stats: () => {
      const live = strokes.filter(s => !s.un);
      return { n: live.length, pts: live.reduce((a, s) => a + s.p.length / 2, 0),
               er: live.filter(s => s.er).length,        // 幾筆是擦除(v1.157.0)
               un: strokes.length - live.length,         // 幾筆被撤銷了(v1.163.0)
               c: curC, tool: curEr ? "er" : (curLine ? "line" : "pen"),
               line: curLine, w: boxW, h: boxH };
    }
  };
})();

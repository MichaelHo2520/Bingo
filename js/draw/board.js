"use strict";

/* ============================================================================
   你畫我猜 — 畫布與對局畫面(DWB)。只管「畫面」與「本地互動」,
   什麼時候寫進 DB 一律由 js/draw/adapter.js 決定(比照其他十一個遊戲的 board/adapter 分工)。

   ★★★ 四件「不知道就會做錯」的事(完整版在 notes/21 的〇節):

   ① **座標一律正規化成 0~999 / 0~749 送出,而「這張圖是什麼形狀」由畫家那一台決定
      (v2.2.0)。**
      畫家的畫布照舊把舞台吃滿(只夾在 AR_MIN~AR_MAX 之間),並且把自己的長寬比當成
      **第五種記錄** `"a<w>,<h>"` 推上去;其他每一台把自己的畫布**縮成同一個形狀**
      (等比 contain,四周留白)→ 每個人看到的是**同一張圖**,不是各自拉伸的版本。
      ⚠⚠⚠ 這一條被反轉過**兩次**,而且**兩次都是使用者親自裁示的** ——
        看到「留白很浪費」或「不如各自吃滿」就順手改回去,等於把踩過的坑再踩一遍:
        · v1.154.0~v1.155.1:**鎖 4:3**(寧可留白也不變形)→ 直向手機上畫布只有
          可用高度的 58%(331×248,而舞台有 429)。使用者:「畫板一定要大一點,
          別人那邊的顯示可以依狀況進行大小的比例來縮放。」
        · v1.155.2~v2.1.0:**誰都不鎖、各自吃滿**(每個人照自己的畫布拉伸)→
          畫家在寬視窗(2.13)、猜的人在直向手機(0.58)時**縱向被拉長 3.7 倍**,
          蠟燭變成一根柱子。使用者(2026-08-17,附同一局的兩張截圖):
          「你有發現比例變了嗎?我不喜歡是這樣的縮放。」
        · v2.2.0(現在):**畫家那一台照樣吃滿**(v1.155.2 那條裁示一個字都沒退),
          只有**看的人**改成等比縮放 —— 使用者當初講的「別人那邊的顯示可以依狀況
          進行大小的比例來縮放」本來就是這個意思,v1.155.2 做成了「拉伸」才是誤讀。
      ★ 線上格式**向下相容**:`a` 與擦布 `e` / 撤銷 `u` 同一種手法 —— 舊版第一行就把
        不是 s/e 的整筆忽略 → 舊版看到的就是 v2.1.0 的樣子(各自拉伸),不會壞;
        而新版收不到 `a`(畫家是舊版)也自動退回「吃滿自己的舞台」= 舊行為。
      ⚠⚠ **幫畫的人(共同作畫)也要跟著畫家的形狀**,他不是形狀的來源 ——
        照自己的形狀畫的話,送出去的邏輯座標在畫家那台會落在**別的位置**。
      ⚠ 畫家那一台的長寬比要夾(AR_MIN~AR_MAX):不夾的話桌機那種 2.13 的寬視窗
        會逼得每支手機只用得到 27% 的紙(細細一條),對猜的人比拉伸還糟。

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

   ⑥ **兩指縮放(v2.1.0)—— 純粹是「看的人這一台的事」,一個位元組都不上線。**
      使用者:「畫板我希望能夠支援兩指的縮放,這樣可以畫的比較細一點」。
      ★★★ 做法是**畫布內部的檢視變換**(vk / vx / vy 走 sx() / sy()),
        **不是**對 `<canvas>` 下 CSS transform ——
        CSS 縮放放大的是既有的點陣,3 倍就是 3 倍的馬賽克;內部變換是**照新的比例重畫**,
        線條在任何倍率都是銳利的,而這一頁放大的唯一目的就是「畫得更細」。
      ★ 座標系一個字都沒動:送出去的照樣是 0~999 / 0~749(pos() 把檢視變換**反解**回去),
        所以別人那台看到的位置與縮放前完全一樣,新舊版本同房也不受影響。
      ⚠ 筆寬 / 擦布寬**一定要跟著 vk 放大**(penStyle 那兩行):不跟著放大的話,
        放大時畫出來的線在縮回去之後會變成細如髮絲的一條 —— 使用者以為自己畫粗了。
      ⚠ 每一回合要歸位(resetInk):換人畫的時候不該繼承上一位的縮放與位移。
      ⚠ 兩指下去的那一刻**一定要把第一根手指剛剛起的那一筆退掉**(abortStroke)——
        不然每次縮放都會在紙上留一個點。

   ⑦ **形狀工具(v2.4.1)—— 而「油漆桶」刻意不做,那不是漏做。**
      Gemini 建議書把「填色油漆桶(Flood Fill)」列在第一順位,理由是「倒數計時下手動
      塗滿大面積色塊非常耗時」。那個痛點是真的,但 **flood fill 與這一頁的架構相衝**,
      三條都是結構性的、不是實作難度:
        ★★★ **① 每一台的畫布解析度不同 → 填出來的結果會不一樣。**
          v2.2.0 之後每台的**長寬比**一致,但像素尺寸差好幾倍(手機 330 寬、桌機 760)。
          手畫的「封閉」圖形幾乎都有髮絲級的縫:低解析度那台被抗鋸齒補起來 → 填在圈內;
          高解析度那台縫還在 → **整張紙都變色**。同一個房間裡兩個人看到的圖完全不同,
          而且誰會漏色**事前算不出來**。這比「畫得慢」嚴重一個量級。
        ★★★ **② 真相是 replay,所以每次 repaint() 都要把每一次填色重跑一遍。**
          `repaint()` 在直線 / 形狀預覽時是**每個 pointermove 跑一次**(見 previewShape),
          兩指縮放同理。一次 flood fill = getImageData + BFS + putImageData ≈ 800×600 的
          48 萬像素;填個五次之後,拖一條直線就會變成幻燈片。
        ★★ **③ 紙是 CSS 背景、canvas 是透明的**(擦布靠 destination-out 露出紙,見 3-C)——
          於是「可以填的地方」與「被擦掉的地方」在像素上**完全一樣**,填色會直接跨過
          擦布的痕跡漫出去。要繞開就得改成「canvas 自己填紙色」,而那會讓擦布失效。
      → 改成把既有的「直線」升級成**三種形狀:直線 / 矩形 / 圓形**。
      ★★ 它們全部是「只有幾個點的一筆 `s`」—— **線上格式一個字都沒改**,舊版收到照樣
        畫得出來(同 v1.163.0 直線那條的 CP 值來源)。矩形是 5 個點、圓形是 49 個點。
      ⚠ 「填滿」這件事沒有被解決,那是已知的取捨:要填滿只能靠粗筆刷(WIDTHS 的 UI
        還沒做,而 #dwTools 在 360px 上塞不下第五顆鈕 —— 見 notes/21 第六節)。
   ========================================================================== */

const DWB = (function () {

  /* ---------- 邏輯座標系(見檔頭 ①) ---------- */
  const LW = 1000, LH = 750;

  /* ---------- 筆刷 ----------
     ★ v1 只用得到 c=0 / w=1(固定筆色、固定粗細)——但**編碼一開始就帶著這兩個欄位**,
       之後要加顏色 / 粗細只要放開 UI,線上格式一個字都不必改(舊版與新版也還能同房)。
     ★★ 黃色(v1.170.0)。使用者:「畫筆的顏色再幫我加上黃色」。
     ⚠⚠ **它刻意放在 index 4**(原本那一格是「橘」,橘往後挪到 6)——
       這是唯一不會在新舊版同房時出錯的位置,而理由是「**index 4 從來沒有任何 client
       送得出來**」:UI 只放前四顆(見 SWATCHES),而 setBrush() 除了 board 自己沒有人叫,
       所以 DB 裡不存在 c=4 的舊資料。
       · 放在 index 4 → 舊版收到 c=4 會畫成**橘**(相近色,看得出是同一張圖)
       · 若改成 append 到 index 6 → 舊版走 `COLORS[6] || COLORS[0]` → **畫成墨黑**(整條線變色)
       兩害相權取相近色。⚠ 而 0~3 那四格**絕對不可以動**(那是紅線 12 那一族的
       「靠索引同步」約定:動了就是「他畫紅色、我看到綠色」,而且只發生在版本不同的兩台之間)。
     ⚠ 黃色在淺色紙上本來就比較淡(紙是 #fffdf7)—— 所以取的是**金黃**而不是純黃,
       純黃(#ffe000 那一類)在紙上幾乎看不見。 */
  const COLORS = ["#20242c", "#e0413a", "#2f7de0", "#2fa14a", "#e9b400", "#8c4bd8", "#e8992b"];
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

  let cb = {};                           // { onStroke, onClear, onGuess, onPick, onPickOwn, onGiveUp, onFin, onReact, onTick }
  let cv = null, ctx = null, dpr = 1;
  let boxW = 0, boxH = 0;                // 畫布的 CSS 尺寸(px)
  /* ---------- 形狀的來源(v2.2.0,見檔頭 ①)----------
     iArtist:我是不是這一回合的畫家(= 形狀的來源)。adapter 每一份 game 快照設一次。
     srcAR  :畫家那台的長寬比。**0 = 還不知道**(畫家是舊版 / 那筆記錄還沒到)→
              退回「吃滿自己的舞台」,也就是 v2.1.0 的行為。
     arSent :我上次推出去的比例,只是為了不要每一次 fit() 都推一筆(見 maybeSendAR)。 */
  let iArtist = false, srcAR = 0, arSent = 0;
  let strokes = [], byId = {};           // 這一回合畫了什麼(重畫 / 重連歸位的來源)
  let enabled = false;                   // 我現在能不能畫
  let drawing = null;                    // 正在畫的那一筆 { sid, c, w, p:[] }
  let pend = [], pendSid = -1, flushT = null;
  /* ⚠ pendEr 記的是**這一批屬於哪一種筆**,不可以在 flush 時才讀 curEr:
     使用者可能在 70ms 的批次還沒送出去之前就按了擦布 / 換色,那樣這一批會被貼上錯的種類。 */
  let pendEr = false;
  let nextSid = 1;
  /* ★★★ sid 的**座位命名空間**(v1.170.0,共同作畫的地基)。
     ──────────────────────────────────────────────────────────────────────────
     在此之前每一台都從 1 開始編號,而那沒問題是因為「同一時間只有畫家在畫」。
     開了共同作畫之後兩個人會**同時**下筆,兩台都會鑄出 sid=5,於是:
       ① 我收到他的 "s5,…" 時 `mySids.has(5)` 成立 → **整筆被當成自己的回音丟掉**
          (我這台永遠看不到他畫的那條線)
       ② 第三個人先收到誰的就先建 byId[5],另一個人的那一批走「續段」分支被
          **接到同一條折線後面** → 畫面上多一條橫跨畫布的弦(症狀與紅線 3-A 一模一樣)
     → 做法:sid = 座位 × SID_SPAN + 本地流水號。六個座位各佔一段,永遠不會撞。
     ⚠ 線上格式**一個字都沒改**(sid 本來就是任意整數)—— 舊版收到照樣畫得出來。
     ⚠⚠ 連帶兩處**一定要跟著改**,漏一處就是靜靜地壞:
       ① applyRec 那句「別人的 sid 也要讓過」只能對**自己這一段**生效
          (照舊全域讓過的話,收到座位 5 的 sid 會把我的流水號推到他的段裡去)
       ② undo() 只能退**自己**的筆(見 lastLive)—— 不然一按就把畫家的線退掉了 */
  const SID_SPAN = 100000;               // 一回合幾百筆就很多了,10 萬綽綽有餘
  let sidBase = 0;
  function setSeat(n) { sidBase = Math.max(0, n | 0) * SID_SPAN; }
  function isMySid(sid) { return sid >= sidBase && sid < sidBase + SID_SPAN; }
  /* ★★ 我自己送出去的 sid(v1.156.0)。存在的唯一理由是**把自己的回音擋掉**:
     畫家送出的每一批都會從 child_added 原封不動回到 applyRec,而那時本地早就畫過了。
     完整說明在 applyRec 裡那道 return 的註解。⚠ 每一回合要跟著 resetInk() 清掉。 */
  let mySids = new Set();
  let curC = DEF_C, curW = DEF_W;
  let curEr = false;                      // 現在拿的是擦布嗎(只影響自己這一端要送 s 還是 e)
  /* ★ 直線模式(v1.163.0):按下去記起點、放開才成一筆。中間那段只是**預覽**,
     不進 strokes、也不送出去 —— 一條直線最後只推送一次(兩個點)。
     ⚠ 直線走的是完全獨立的路徑,不碰 drawing / pend / flush(那三個是徒手畫的節流機制)。
     ★★ v2.4.1 起這個模式底下有**三種形狀**(見檔頭 ⑦):直線 / 矩形 / 圓形。
     ⚠⚠ `curLine` 的語意刻意沒變 —— 它照舊是「三選一模式裡的那一格」(紅線 24),
       所以 `stats().tool` 照樣回 "line"、`#dwLine` 照樣是**切換鈕**(按一下回到一般筆)。
       形狀是它底下的第二層,住在浮在紙上的 `.dw-shapes`(不佔工具列的寬度)。
     ⚠ 形狀**不必每回合歸零**?—— 要。resetInk() 一起清:上一位畫家挑的形狀
       與顏色 / 擦布同一族,換人就該回到最單純的狀態。 */
  let curLine = false;
  const SHAPES = ["line", "rect", "oval"];
  const SHAPE_IDS = { line: "dwShpLine", rect: "dwShpRect", oval: "dwShpOval" };
  let curShape = "line";
  let lineFrom = null, lineTo = null;
  /* 畫布四周留這麼多(v1.155.2):`.dw-stage` 是 overflow:hidden,而紙有一圈 3px 的外框
     (`.dw-ink` 的第一段 box-shadow)—— 貼死就會被削掉,看起來像沒有邊。 */
  const INK_PAD = 4;
  /* ---------- 畫家那一台的形狀夾在這個區間(v2.2.0,見檔頭 ①)----------
     ★ 存在的理由只有一個:**別人要照這個形狀縮**。桌機橫向視窗量到的長寬比是 2.13,
       直向手機照著縮之後紙上只剩一條 353×166 的細帶(高度只用得到 27%)——
       對「猜的人」來說那比拉伸還糟,而猜的人永遠比畫的人多。
     ⚠ 下限刻意放到 0.45 而不是 0.5:直向手機在放大模式下量到 0.50~0.56,
       **一支手機都不可以被夾到**(夾到就是白白損失畫布,而那正是 v1.155.2 修掉的事)。
       這個區間夾的對象是桌機 / 橫向那種寬視窗,不是手機。 */
  const AR_MIN = 0.45, AR_MAX = 1.4;

  /* ---------- 兩指縮放的檢視狀態(v2.1.0,見檔頭 ⑥)----------
     ★ 這三個數字是**這一台自己看畫布的窗**,不上線、不進 strokes、不進分享圖:
         畫布 CSS px = 邏輯座標 × (boxW/LW) × vk + vx
       所以 vk=1 / vx=vy=0 時每一條算式都退化回 v2.0.0 的樣子(這是刻意的:
       沒有人縮放時,這個功能等於不存在)。
     ⚠ vx / vy 一律 ≤ 0 而且不小於 boxW*(1-vk) —— 紙永遠鋪滿畫布,不可以露出背景。
     ⚠ MAX_K 取 4:再大也沒有用(邏輯座標只有 1000×750,4 倍時一個邏輯單位已經 3~4 px),
       而倍率愈大、手指移動一點點就飛出畫面外,反而更難畫。 */
  const MIN_K = 1, MAX_K = 4;
  let vk = 1, vx = 0, vy = 0;
  function clampK(k) { return Math.max(MIN_K, Math.min(MAX_K, k || 1)); }
  function clampView() {
    vk = clampK(vk);
    vx = Math.max(boxW * (1 - vk), Math.min(0, vx));
    vy = Math.max(boxH * (1 - vk), Math.min(0, vy));
  }
  /* ⚠⚠ 縮放的重畫**刻意是同步的**,不可以「聰明地」合到 requestAnimationFrame 裡:
       ① 直線 / 形狀預覽(previewShape)本來就是每一個 pointermove 整張 repaint —— 這一頁的
          筆劃量(一回合幾十筆)重畫一次是微不足道的成本,兩指一幀畫兩遍也一樣
       ② ⚠ **rAF 在 headless e2e 一次都不派**(紅線 3-B 踩過:用它等會整支測試當場掛住)
          → 走 rAF 的話這個功能就變成「只能靠眼睛看」的那一類,守不住。
     ⚠ 以畫布上某一點為錨縮放(兩指的中心 / 滑鼠游標)——
     ⚠ 錨點的「邏輯位置」縮放前後必須不動,不然畫面會朝角落跑掉。 */
  function zoomAt(k, cx, cy) {
    k = clampK(k);
    const ux = (cx - vx) / vk, uy = (cy - vy) / vk;
    vk = k; vx = cx - k * ux; vy = cy - k * uy;
    clampView();
    repaint();
    syncZoomChip();
  }
  function resetView(toast) {
    if (vk === 1 && !vx && !vy) return;
    vk = 1; vx = 0; vy = 0;
    repaint();
    syncZoomChip();
    if (toast) modeToast("🔍 回到原本大小");
  }

  /* ---------- 初始化 ---------- */
  function init(o) {
    cb = o || {};
    cv = $("dwInk");
    if (!cv) return;
    ctx = cv.getContext("2d");
    bindDraw();
    bindTools();
    bindGuess();
    bindGiveUp();   // 放棄這一題(v1.168.0;兩段式在 bindGiveUp 裡)
    bindFin();      // 畫家的「畫完了」(v1.168.0)
    bindPick();
    /* 縮放倍率晶片:按一下回到原本大小(見 syncZoomChip)。 */
    const pz = $("dwPinch");
    if (pz) pz.addEventListener("click", () => resetView(true));
    addEventListener("resize", fit);
    /* ★★ 舞台自己變高變矮時也要重量(v1.156.0)。這一頁原本只掛 resize,而
       **切 body 的 class 不會發 resize** —— 於是「先看看畫板 👀」(共用的 peekBoard()
       只做 body.peeking,而 styles.css 給它 padding-bottom:66px)把舞台壓矮 66px 之後,
       畫布還維持舊高、`.dw-stage` 是 overflow:hidden、內容又置中 → 圖的上下**各被削掉 33px**
       (直向手機畫布 477 高 ⇒ 少掉 14%,而畫圖的人常把重點畫在中下方)。
       完全靜默:DOM 與 canvas 尺寸都合法,只有把它截下來才看得出來。
       ★ 十三頁裡只有這一頁沒掛 RO(另外八頁的 board 都有),補上之後連放大鈕、
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

       ★★★ **畫家把舞台吃滿(只夾長寬比區間),其他人縮成畫家的形狀**(v2.2.0,見檔頭 ①)。
          · 畫家:留 INK_PAD 的邊、其餘全吃 —— v1.155.2 那條裁示原封不動
            (鎖 4:3 的代價在直向手機上很嚇人:舞台 429 高而畫布只有 248 = **58%**)。
          · 其他人(含幫畫的):等比縮成 srcAR 那個形狀,放不下的那一邊留白。
       ⚠⚠ **這裡是唯一算形狀的地方** —— `.dw-stage` / `.dw-ink` 上都不可以再出現
         aspect-ratio 之類的東西,兩邊各算各的會打架(成語接龍 v1.135.0 踩過)。
     ========================================================================== */
  function fit() {
    const stage = $("dwStage");
    if (!cv || !stage) return;
    const r = stage.getBoundingClientRect();
    const availW = Math.max(80, Math.floor(r.width)  - INK_PAD * 2);
    const availH = Math.max(60, Math.floor(r.height) - INK_PAD * 2);
    /* ★★ 先把「應該多大」算出來,再拿它去比對(v2.2.0)。
       ⚠⚠ 這道守衛**不可以只比舞台尺寸**:收到 "a" 的那一刻舞台一個 px 都沒動,
         要變的是**形狀** —— 比舞台的話那筆記錄會被這道 return 靜靜吃掉,
         而畫面上看起來完全正常(圖照舊是拉伸的,沒有任何線索)。 */
    const ar = shapeAR(availW, availH);
    let w = availW, h = availH;
    if (w / h > ar) w = Math.max(40, Math.round(h * ar));
    else            h = Math.max(30, Math.round(w / ar));
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
    /* ⚠ 舞台變大變小之後位移的合法範圍跟著變(vx 的下限是 boxW*(1-vk))——
       不夾一次的話,轉向 / 按放大鈕 / 手機鍵盤收起來都可能讓紙的邊緣露出背景。 */
    clampView();
    repaint();
    maybeSendAR();     // ★ 我是畫家的話,形狀變了要讓每個人跟著變(v2.2.0)
  }

  /* ---------- 形狀:算 / 送 / 收(v2.2.0,見檔頭 ①)---------- */
  function clampAR(ar) { return Math.max(AR_MIN, Math.min(AR_MAX, ar || 1)); }
  /* 我這塊畫布要長成什麼形狀。
     ⚠ **幫畫的人走的是下面那條「其他人」**(iArtist 只有這一回合的畫家是 true)——
       形狀不一致的話,他畫的線送出去之後在畫家那台會落在別的位置。 */
  function shapeAR(availW, availH) {
    if (!iArtist && srcAR > 0) return srcAR;
    return clampAR(availW / availH);
  }
  /* ★★★ 畫家把自己的形狀推上去 —— 線上的第五種記錄。
     ⚠⚠ 一定要等 `enabled` 才送:adapter 的 ink() 只在 draw 相位寫得進去(DWR.mayInk),
       pick 相位送出去的會被靜靜丟掉 —— 而那正是最需要它的時候(別人要在畫家下第一筆
       之前就把畫布縮好)。所以 setEnabled() 那裡也叫一次,不能只靠 fit()。
     ⚠ 2% 的門檻是為了不要每一次 fit() 都推一筆:網址列收合、鍵盤、ResizeObserver
       都會叫 fit(),而每一筆都是一次 push。 */
  function maybeSendAR() {
    if (!iArtist || !enabled || !boxW || !boxH) return;
    const ar = boxW / boxH;
    if (arSent && Math.abs(ar / arSent - 1) < 0.02) return;
    arSent = ar;
    cb.onStroke && cb.onStroke("a" + boxW + "," + boxH);
  }
  /* 這一回合我是不是畫家(= 形狀的來源)。由 adapter 每一份 game 快照設一次。
     ⚠ 換角色就要把來源歸零:上一回合我是猜的人,srcAR 停在上一位畫家的形狀,
       留著的話輪到我畫時自己的畫布會被別人的形狀夾住。 */
  function setArtist(on) {
    const v = !!on;
    if (v === iArtist) return;
    iArtist = v; srcAR = 0; arSent = 0;
    fit();
  }

  /* 邏輯座標 → 畫布的裝置像素。★ 中間那兩個 vk / vx 就是兩指縮放(見檔頭 ⑥),
     沒縮放時 vk=1、vx=0 → 與 v2.0.0 逐字相同。
     ⚠ 畫的每一條路徑都只准走這兩支(strokePath / drawTail / applyRec 的續段 / previewShape),
       自己另外算一份的地方就是「縮放之後只有那一種筆畫錯位」的來源。 */
  function sx(x) { return (x * boxW / LW * vk + vx) * dpr; }
  function sy(y) { return (y * boxH / LH * vk + vy) * dpr; }

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
    /* ⚠⚠ 筆寬與擦布寬**一定要乘上 vk**(兩指縮放,見檔頭 ⑥):
       粗細的真相是邏輯單位,放大就是「同一條線看起來比較粗」。
       漏乘的症狀很陰:放大時看起來畫得剛剛好,縮回去卻細如髮絲(而別人那台一直是細的)。 */
    if (s.er) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";                  // 擦除只看 alpha,顏色無關
      ctx.lineWidth = Math.max(1, ER_W * boxW / LW * vk * dpr);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = COLORS[s.c] || COLORS[0];
      ctx.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[DEF_W]) * boxW / LW * vk * dpr);
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
         "a<w>,<h>"                            **畫家那台的畫布尺寸**(v2.2.0;只有比值有意義,
                                               見檔頭 ①)—— 別人照這個形狀縮自己的畫布
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
    /* ★★★ 畫家那台的畫布形狀(v2.2.0,見檔頭 ①)。**第五種記錄,理由同擦布 / 撤銷**:
       舊版第一行就把不是 s / e 的整筆忽略 → 舊版只是照舊各自拉伸,不會壞。
       ⚠⚠ 畫家自己一定要擋掉(這是自己的回音):套下去的話他的畫布會被自己的形狀
         再夾一次、夾完 fit() 又推一筆,兩者互相追著縮。
       ⚠ 壞資料一律整筆丟掉(同這一支的每一條路)—— 形狀是全域的,一筆爛資料
         會把整張圖擠成一條線,比少畫一筆嚴重得多。 */
    if (kind === "a") {
      if (iArtist) return;
      const b = rec.slice(1).split(",");
      const aw = +b[0], ah = +b[1];
      if (!isFinite(aw) || !isFinite(ah) || aw <= 0 || ah <= 0) return;
      const ar = clampAR(aw / ah);
      if (srcAR && Math.abs(ar / srcAR - 1) < 0.01) return;
      srcAR = ar;
      fit();                          // ⚠ 形狀變了 → 重新量(fit() 自己會 repaint)
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
    /* 重連時要接著自己上次的號碼編下去(不然重放完一畫就撞到自己的舊 sid)。
       ⚠⚠ 只讓過**自己那一段**(v1.170.0):共同作畫時別人的 sid 在別的段裡,
         照舊寫成 `if (sid >= nextSid)` 的話,收到座位 5 的 500123 會把我的流水號
         推成 500124 → **我接著鑄出來的筆就跑進他的命名空間**,撞號又回來了。 */
    if (isMySid(sid) && sid - sidBase >= nextSid) nextSid = sid - sidBase + 1;
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
    curLine = false; curShape = "line"; lineFrom = null; lineTo = null;
    /* ★ 縮放也要歸位(v2.1.0):上一位畫家放大到某個角落去畫細節,
       下一回合換人時畫面不該還停在那個角落 —— 而且新的一張是空的,停在那裡看起來像壞掉。
       ⚠ 手指狀態一起清:換回合時可能正按著(相位是別人推的,不會有 pointerup 收尾)。 */
    resetView();
    ptrs.clear(); pinch = null; pinchLock = false;
    syncTool();
    mySids.clear();                       // ⚠ 一定要跟著清:重連重放整包時它必須是空的
    /* ★★ 形狀的來源也要歸零(v2.2.0,見檔頭 ①):下一回合換人畫,形狀要重新收一次
       (那筆 "a" 會在畫家下第一筆之前送到,重連的人則靠 attachRound 的重放拿到)。
       ⚠⚠ arSent 一定要一起清 —— 每一回合是**新的 ink 節點**,上一回合推的那一筆
         不在裡面。不清的話「連續兩回合形狀沒變」的畫家就再也不會推,
         而症狀是**只有某些回合會歪**(第一回合正常,之後每一回合都退回舊行為)。 */
    srcAR = 0; arSent = 0;
    if (flushT) { clearTimeout(flushT); flushT = null; }
    clearCanvas();
    fit();                                // ⚠ 形狀的來源沒了 → 要縮回自己的舞台
  }

  /* ==========================================================================
     三、本地作畫(只有畫家會走到)
     ========================================================================== */
  /* 螢幕座標 → 邏輯座標(0~999 / 0~749)。
     ★★ 兩指縮放(檔頭 ⑥)唯一的另一半就在這裡:**把檢視變換反解回去** ——
       送出去的一律是邏輯座標,所以別人那台看到的位置與我有沒有放大完全無關。
     ⚠ 先把「畫布 CSS px」算出來(cvx / cvy)再反解,不可以拿 r.width 直接除 ——
       r.width 是**沒有**檢視變換的外框尺寸(縮放不改 DOM 幾何,只改畫布內容)。 */
  function pos(e) {
    const r = cv.getBoundingClientRect();
    const cvx = (e.clientX - r.left) * (boxW / (r.width  || boxW));
    const cvy = (e.clientY - r.top)  * (boxH / (r.height || boxH));
    const x = Math.round((cvx - vx) / vk / boxW * LW);
    const y = Math.round((cvy - vy) / vk / boxH * LH);
    return [Math.max(0, Math.min(LW - 1, x)), Math.max(0, Math.min(LH - 1, y))];
  }
  function flush() {
    if (flushT) { clearTimeout(flushT); flushT = null; }
    if (!pend.length || pendSid < 0) { pend = []; return; }
    const rec = encode(pendSid, curC, curW, pend, pendEr);
    pend = [];
    /* ★ 記下「這一筆已經送出去過」(v2.1.0):兩指縮放要把剛起頭的那一筆收掉,
       而**送過的只能撤銷、沒送過的才可以直接拿掉**(見 abortStroke)。 */
    if (byId[pendSid]) byId[pendSid].tx = true;
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
  /* ★★ 形狀 → 邏輯座標點陣(v2.4.1,見檔頭 ⑦)。**回傳的就是一筆 `s` 的 p 陣列** ——
     直線 2 個點、矩形 5 個點(收尾回到起點)、圓形 49 個點。
     ⚠ 一律 Math.round + 夾在座標系內:編碼直接 join(","),浮點數會讓每一筆胖三倍
       (而且 `applyRec` 那邊 isFinite 通過、畫出來一樣,沒有任何斷言會紅)。
     ⚠ 圓形取 48 段:再少會看得出是多邊形(在放大到 4 倍的畫布上尤其明顯),
       再多只是白白加位元組 —— 48 段 ≈ 400 bytes,與徒手畫一小段差不多。
     ⚠⚠ 圓形是**內接在拖曳出來的方框裡**(不是「以起點為圓心」):使用者拖的是一個框,
       而框的直覺就是外接矩形;以起點為圓心的話手指一定在圓的正中央 → 看不見自己在畫什麼。 */
  const OVAL_SEG = 48;
  function shapePts(a, b, shape) {
    const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(v)));
    if (shape === "rect") {
      const x0 = a[0], y0 = a[1], x1 = b[0], y1 = b[1];
      return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
    }
    if (shape === "oval") {
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      const out = [];
      for (let i = 0; i <= OVAL_SEG; i++) {
        const t = i / OVAL_SEG * Math.PI * 2;
        out.push(clamp(cx + rx * Math.cos(t), LW - 1), clamp(cy + ry * Math.sin(t), LH - 1));
      }
      return out;
    }
    return [a[0], a[1], b[0], b[1]];
  }
  /* 拖曳中的預覽。⚠ 這一支**每個 pointermove 都會跑一次整張 repaint()**(見 onMove)——
     檔頭 ⑦ 講的「油漆桶會讓這裡變幻燈片」指的就是它。 */
  function previewShape() {
    if (!ctx || !lineFrom || !lineTo) return;
    const pts = shapePts(lineFrom, lineTo, curShape);
    penStyle({ c: curC, w: curW, er: curEr });
    if (!curEr) ctx.globalAlpha = 0.55;                 // 擦布不透明化(destination-out 看不出深淺)
    ctx.beginPath();
    ctx.moveTo(sx(pts[0]), sy(pts[1]));
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(sx(pts[i]), sy(pts[i + 1]));
    ctx.stroke();
    ctx.globalAlpha = 1;
    penEnd();
  }
  /* 直線放手 → 成一筆(兩個點)並**一次推送完畢**。
     ⚠ 不走 pend / flush:那套節流是給徒手畫的連續取樣用的,一條直線只有兩個點。
     ⚠ 但要先 flush() —— 上一筆徒手畫可能還有沒送出去的點,順序反了對方會看到接錯。 */
  function commitShape() {
    const a = lineFrom, b = lineTo || lineFrom;
    lineFrom = null; lineTo = null;
    if (!a) return;
    flush();
    const sid = sidBase + nextSid++;       // ★ 帶座位命名空間(見 SID_SPAN 那段)
    const s = { sid: sid, c: curC, w: curW, p: shapePts(a, b, curShape), er: curEr };
    byId[sid] = s; strokes.push(s);
    mySids.add(sid);                      // 這一筆的回音要擋掉(見 applyRec)
    repaint();                            // ⚠ 一定要整張重畫:預覽那條半透明的線還在畫布上
    cb.onStroke && cb.onStroke(encode(sid, curC, curW, s.p, curEr));
    syncTool();
  }
  /* ==========================================================================
     ★★★ 兩指縮放 / 平移(v2.1.0,見檔頭 ⑥)
     ──────────────────────────────────────────────────────────────────────────
       使用者:「畫板我希望能夠支援兩指的縮放,這樣可以畫的比較細一點」。
       · 一根手指 = 畫(與 v2.0.0 完全相同)
       · 兩根手指 = 撐開縮放 + 一起拖曳平移(同一個手勢,錨在兩指中心)
       · 滑鼠滾輪 = 以游標為錨縮放(桌機與測試用;手機上不存在)
     ⚠⚠ **不能畫的人也要能縮放**:猜的人放大來看細節是自然的,而且它純粹是本地檢視 ——
       所以指標記錄 / 兩指判定一律排在 `enabled` 那道守衛**前面**。
     ⚠ `pinchLock`:兩指之後先放開一根,剩下那一根**不可以**接著畫
       (手一定會抖 → 每次縮放完都在紙上留一道)。要全部放開才解鎖。
     ⚠ 換手指(第三根加入 / 原本兩根之一離開)一律**重新取基準**,不然畫面會瞬間跳一大格。
     ========================================================================== */
  const ptrs = new Map();       // pointerId → 目前的 client 座標(順序 = 按下去的順序)
  let pinch = null;             // { d0, cx0, cy0, k0, x0, y0 } —— 這一次手勢的基準
  let pinchLock = false;        // 兩指結束後還有手指按著 → 那一根不准畫
  function ptrPair() {
    const a = [];
    ptrs.forEach(v => { if (a.length < 2) a.push(v); });
    return a.length === 2 ? a : null;
  }
  /* 兩指的距離與中心(中心換算成**畫布 CSS px**,與 vx / vy 同一個座標系) */
  function pinchGeo(a) {
    const r = cv.getBoundingClientRect();
    const kx = boxW / (r.width || boxW), ky = boxH / (r.height || boxH);
    const dx = a[1].x - a[0].x, dy = a[1].y - a[0].y;
    return { d: Math.max(1, Math.hypot(dx, dy)),
             cx: ((a[0].x + a[1].x) / 2 - r.left) * kx,
             cy: ((a[0].y + a[1].y) / 2 - r.top)  * ky };
  }
  function startPinch() {
    const a = ptrPair(); if (!a) return;
    abortStroke();                       // ⚠ 第一根手指剛起的那一筆要退掉(見檔頭 ⑥)
    const g = pinchGeo(a);
    pinch = { d0: g.d, cx0: g.cx, cy0: g.cy, k0: vk, x0: vx, y0: vy };
  }
  function movePinch() {
    const a = ptrPair(); if (!a || !pinch) return;
    const g = pinchGeo(a);
    const k = clampK(pinch.k0 * g.d / pinch.d0);
    /* 起手時中心底下的那一點(未縮放座標)要**跟著手指走**:
       撐開 = 縮放,兩指一起移動 = 平移,兩件事同一條算式就做完了。 */
    const ux = (pinch.cx0 - pinch.x0) / pinch.k0, uy = (pinch.cy0 - pinch.y0) / pinch.k0;
    vk = k; vx = g.cx - k * ux; vy = g.cy - k * uy;
    clampView();
    repaint();
    syncZoomChip();
  }
  /* 兩指下去時把剛起頭的那一筆收掉。
     ★ 分兩條路,差別在**它送出去了沒**:
       · 還沒送(pend 裡那幾個點都還在本地)→ 直接從 strokes 拿掉,一個位元組都不上線
       · 已經送過至少一批 → 只能走既有的撤銷記錄 "u<sid>"(絕不可以從 strokes 裡刪,
         那是紅線 19:這一頁的真相是照順序 replay,抽掉中間一筆會讓後面的擦布擦錯東西)
     ⚠ 沒送過的那一條**一定要把 pend 清掉**,不然下一次 flush 會把這幾個點接到別的筆上。 */
  function abortStroke() {
    if (lineFrom) { lineFrom = null; lineTo = null; repaint(); }
    const s = drawing;
    if (!s) return;
    drawing = null;
    if (flushT) { clearTimeout(flushT); flushT = null; }
    pend = []; pendSid = -1;
    if (s.tx) { s.un = true; cb.onStroke && cb.onStroke("u" + s.sid); }
    else {
      const i = strokes.indexOf(s);
      if (i >= 0) strokes.splice(i, 1);
      delete byId[s.sid];
    }
    repaint();
    syncTool();
  }
  /* 滑鼠滾輪縮放(桌機)。⚠ 一定要 preventDefault + { passive:false },
     不然瀏覽器會拿去捲頁面 —— 而畫布常常是滿版的。 */
  function onWheel(e) {
    if (!e.deltaY) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const cx = (e.clientX - r.left) * (boxW / (r.width  || boxW));
    const cy = (e.clientY - r.top)  * (boxH / (r.height || boxH));
    zoomAt(vk * Math.exp(-e.deltaY * 0.0015), cx, cy);
  }
  function onDown(e) {
    if (e.button > 0) return;
    /* ⚠ 這三行排在 enabled 前面:猜的人也要能兩指放大來看細節(見上面那段) */
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) { e.preventDefault(); startPinch(); return; }
    if (pinchLock || !enabled) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    const p = pos(e);
    // ★ 直線:按下去只記起點,放開才成筆(中間都是預覽)
    if (curLine) { lineFrom = p; lineTo = p; return; }
    const sid = sidBase + nextSid++;       // ★ 帶座位命名空間(見 SID_SPAN 那段)
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
    /* ⚠ 縮放這一段排在 enabled 前面(不能畫的人也要能放大來看) */
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { e.preventDefault(); movePinch(); return; }
    if (!enabled) return;
    // ★ 直線:拖到哪就預覽到哪(⚠ 這一段一定要排在 drawing 那道守衛前面)
    if (lineFrom) {
      e.preventDefault();
      const q = pos(e);
      const ddx = q[0] - lineTo[0], ddy = q[1] - lineTo[1];
      if (ddx * ddx + ddy * ddy < MIN_D * MIN_D) return;        // 動太小就別重畫(整張 repaint 有成本)
      lineTo = q;
      repaint(); previewShape();
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
    ptrs.delete(e.pointerId);
    /* ★ 縮放中放開手指:還有兩根就重新取基準(不然畫面會跳),
       不足兩根就結束手勢 —— 而**剩下那一根不准接著畫**(見 pinchLock)。 */
    if (pinch) {
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      if (ptrPair()) startPinch();
      else { pinch = null; pinchLock = ptrs.size > 0; }
      return;
    }
    if (!ptrs.size) pinchLock = false;
    // ★ 直線:放手才成一筆(⚠ 排在 drawing 那道守衛前面 —— 直線期間 drawing 一直是 null)
    if (lineFrom) {
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      commitShape();
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
    bindShapes();
    syncTool();
  }
  /* ★★ 形狀條(v2.4.1,見檔頭 ⑦)。它**不住在 #dwTools 裡**(浮在紙上),所以另外綁一次。
     ⚠ 按了形狀一律順手把直線模式打開 —— 這一條是「按了沒反應」的唯一防線:
       形狀條只在直線模式下看得見,理論上按不到它時模式一定是開的;
       但畫布鎖住 / 相位剛換的那一瞬間 class 可能還沒同步,補這一道零成本。 */
  function bindShapes() {
    const box = $("dwShapes"); if (!box) return;
    box.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      pickShape(b.dataset.s);
    });
  }
  function pickShape(s) {
    if (SHAPES.indexOf(s) < 0) return;
    curShape = s;
    if (!curLine) curLine = true;
    modeToast(s === "rect" ? "▭ 矩形:拖出一個框" : s === "oval" ? "◯ 圓形:拖出一個框" : "📐 直線:按住拉一條直的");
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
    /* 滾輪縮放(桌機)。⚠ passive:false 不可省 —— 少了它 preventDefault() 無效,
       捲的會是整頁,而不是縮放畫布。 */
    cv.addEventListener("wheel", onWheel, { passive: false });
  }
  /* ---------- 縮放倍率晶片(v2.1.0)----------
     ★ 它同時是**唯一的出口**:放大之後要回到原本大小,除了把兩指捏回去就只有它。
       (⚠ 刻意**不放進 `#dwTools`** —— 那一列在 360px 上已經是「題目 + 五色 + 四顆鈕」
        剛好塞滿,再加一顆就把題目擠成省略號,而題目是畫家唯一要讀的字,見紅線 3-D。)
     ⚠ 只在放大時出現(vk > 1)—— 沒縮放時它是純粹的雜訊,而且會擋住紙的一角。
     ⚠ 它住在 `.dw-wrap` 裡、**排在 `#dwOver` 前面**:選題 / 公布答案的蓋板要蓋得住它。 */
  function syncZoomChip() {
    const b = $("dwPinch"); if (!b) return;
    const on = vk > 1.005;
    b.classList.toggle("hidden", !on);
    if (on) b.textContent = "🔍 " + (Math.round(vk * 10) / 10).toFixed(1) + "× ✕";
  }
  /* 兩指縮放的提示只講**一次**(v2.1.0)。★ 新功能沒人講就等於沒做:
     手勢是看不見的,而這一頁的畫布上沒有任何地方寫得下這句話。
     ⚠ 一次是「一次載入一次」,不是每回合 —— 每次輪到自己畫都跳一則就是刷版。
     ⚠ 挑在「可以下筆的那一刻」講(蓋板剛關掉、手正要碰畫布),不在開頁時講。 */
  let saidPinch = false;
  function setEnabled(on) {
    const was = enabled;
    enabled = !!on;
    if (enabled && !was && !saidPinch) {
      saidPinch = true;
      try { showToast("🔍 兩指撐開可以放大畫板,細節更好畫", 2400); } catch (e) {}
    }
    if (!enabled && drawing) { drawing = null; flush(); }
    /* ⚠ 時間到的那一刻可能正拖著一條還沒放手的直線 —— 丟掉(不是 commit):
       相位已經換了,adapter 的 ink() 也寫不進去,留著只會在畫布上掛一條預覽線。 */
    if (!enabled && lineFrom) { lineFrom = null; lineTo = null; repaint(); }
    if (!enabled) clrDisarm();        // ⚠ 相位換掉時武裝要收:下一回合第一次按不該直接清光
    /* ⚠ 形狀條的顯示條件含 enabled(見 syncTool)→ 這裡改了它就一定要重畫一次,
       不然相位換掉之後那一條會留在紙上(而且只有「上一回合拿著直線」時才看得到)。 */
    if (enabled !== was) syncTool();
    if (cv) cv.classList.toggle("live", enabled);
    /* ★★ 可以下筆的那一刻就把自己的形狀推出去(v2.2.0)——
       ⚠ 不可以只靠 fit() 那條:畫家的畫布通常從 pick 相位到 draw 相位一個 px 都沒動,
         fit() 會在第一道守衛就 return,那筆 "a" 永遠不會送 → 每個人都退回舊行為
         (症狀:「偶爾會歪、偶爾不會」,而歪不歪其實只看畫家中途有沒有轉向)。 */
    if (enabled) maybeSendAR();
  }
  /* ---------- ★★ 清空的兩段式確認(v2.4.1)----------
     Gemini 建議書 2.1:「點擊清空時若手滑容易整張報廢」。60 秒畫完的一張圖,誤觸的代價
     是整場最高的一種 —— 而復原鈕只退得回**一筆**,清空之後那一張是真的回不來。
     ⚠⚠ 照抄「放棄這一題」那一套(紅線 28):第一次按只是**武裝 3 秒**(整顆變警告色 +
       換字「確定?」),3 秒內再按一次才真的清。**不可以**改成開一層確認蓋板 ——
       那要列進 ui-kit.js 的 BACK_LAYERS,而那個陣列是雙胞胎(CLAUDE.md 紅線 7)。
     ⚠ 武裝一定要會自己到期:停在武裝狀態的話,下一次隨手一按就直接清光了。
     ⚠⚠ 真正動手的那一支照舊叫 `clearInk()`,而且**維持公開** —— e2e / 診斷頁走的是它
       (那些地方要驗的是「清空之後畫布與復原鈕的狀態」,不是那顆鈕按幾下)。
       畫面上那顆 🗑 從 v2.4.1 起走的是 `clearAsk()`(js/draw/main.js 綁的那一行)。 */
  const CLR_ARM_MS = 3000;
  let clrArmT = null;
  function clrArmed() { const b = $("dwClear"); return !!b && b.classList.contains("armed"); }
  function clrDisarm() {
    if (clrArmT) { clearTimeout(clrArmT); clrArmT = null; }
    const b = $("dwClear"), t = $("dwClrT");
    if (b) { b.classList.remove("armed"); b.title = "整張清空(按兩次)"; }
    if (t) t.textContent = " 清空";
  }
  function clearAsk() {
    if (!enabled) return;
    const b = $("dwClear"); if (!b) return;
    if (clrArmed()) { clrDisarm(); clearInk(); return; }
    b.classList.add("armed");
    b.title = "再按一次就整張清空(退不回來)";
    const t = $("dwClrT"); if (t) t.textContent = " 確定?";
    try { showToast("再按一次就整張清空 🗑(想退一筆的話用 ↩️)", 2600); } catch (e) {}
    if (clrArmT) clearTimeout(clrArmT);
    clrArmT = setTimeout(clrDisarm, CLR_ARM_MS);
  }

  // 清空:本地立刻生效,同時請 adapter 推一筆 "x"(讓別人也清)
  function clearInk() {
    clrDisarm();                      // ⚠ 直接呼叫這一支的路徑(e2e / 診斷頁)也要把武裝收掉
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
  /* ⚠⚠ **只找自己畫的那一筆**(v1.170.0)—— 開了共同作畫之後 strokes 裡混著別人的線,
     照舊拿「最後一筆」的話,幫畫的人一按復原就把**畫家剛畫好的那條線**退掉了
     (而畫家那台完全正常,他只會看到自己的線莫名消失)。⚠ 同時它也是復原鈕
     disabled 的來源(syncTool)→ 沒東西可退時鈕會自己灰掉,不必另外判。 */
  function lastLive() {
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (!s.un && isMySid(s.sid)) return s;
    }
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
  /* ---------- 工具列的狀態(v1.157.0:四色 + 擦布;v1.170.0 加黃 = 五色) ----------
     ★ 只有這一支會碰畫面上的 on 狀態 —— 選色 / 選擦布 / 清空 / 換回合都走它,
       所以「畫面上亮的那一顆」與 curC / curEr 不可能不一致。
     ⚠ 色塊放**前五色**(墨黑 / 紅 / 藍 / 綠 / 黃)—— COLORS 有七個,紫與橘沒有 UI。
       那不是漏做:`#dwTools` 那一列在 360px 的手機上要同時放題目 + 色塊 + 四顆工具鈕,
       再多兩顆會把題目擠到只剩省略號,而題目是畫家唯一要讀的字。
     ⚠⚠ 加第五顆的時候色塊在窄畫面跟著縮成 18px、gap 收到 3px(styles.css 那條 media)——
       改這個數字之後**一定要用裝置模擬量一次** `#dwTools` 的 scrollWidth − clientWidth
       (必須是 0),Edge 的視窗寬度壓不到 360px(見 notes/21 第五節)。
     ⚠ 這個數字同時是「UI 有幾顆」與「掃哪幾個 COLORS 索引」——
       所以黃色只能放在 index 4(見 COLORS 那段),不能 append 到尾巴。 */
  const SWATCHES = 5;
  function syncTool() {
    for (let i = 0; i < SWATCHES; i++) {
      const b = $("dwSw" + i);
      if (b) b.classList.toggle("on", !curEr && curC === i);
    }
    const er = $("dwErase");
    if (er) { er.classList.toggle("on", curEr); er.setAttribute("aria-pressed", curEr ? "true" : "false"); }
    const ln = $("dwLine");
    if (ln) { ln.classList.toggle("on", curLine); ln.setAttribute("aria-pressed", curLine ? "true" : "false"); }
    /* ★★ 形狀條:直線模式 **而且畫得動**才出現(v2.4.1)。
       ⚠⚠ `enabled` 那一半不可省 —— 它住在 `.dw-wrap` 裡,**不在 `#dwTools` 那一列**,
         所以 `paintTools()` 把工具列收起來時它**不會跟著消失**:相位換到 pick / show
         之後,上一回合留下來的 `curLine` 會讓它繼續浮在選題卡與拍立得上面。
         (另一半是 CSS:它不可以有 z-index,不然連蓋板都蓋不住它。) */
    const shBox = $("dwShapes");
    if (shBox) shBox.classList.toggle("hidden", !(curLine && enabled));
    let curBtn = null;
    for (let i = 0; i < SHAPES.length; i++) {
      const b = $(SHAPE_IDS[SHAPES[i]]);
      if (!b) continue;
      const on = SHAPES[i] === curShape;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) curBtn = b;
    }
    /* ★★★ 工具列那顆鈕的圖示要跟著形狀換(紅線 24:「哪一顆亮著」是使用者判斷
       現在能做什麼的唯一線索 —— 亮著一顆斜線卻在畫矩形就是在騙人)。
       ⚠⚠ 圖示**從形狀條那三顆鈕身上抄過來**,不在 JS 裡另寫一份 SVG:
         兩份 SVG 漂移的症狀是「工具列的圖示與形狀條對不起來」,而那沒有任何斷言會紅
         (同色塊的顏色只准有 COLORS 一份的理由)。尺寸差異交給 CSS 的 .dw-ln svg。 */
    if (ln && curBtn && ln.dataset.shape !== curShape) {
      ln.dataset.shape = curShape;
      ln.innerHTML = curBtn.innerHTML;
      const nm = curShape === "rect" ? "矩形" : curShape === "oval" ? "圓形" : "直線";
      ln.setAttribute("aria-label", nm);
      ln.title = nm + "(按住拉一個" + (curShape === "line" ? "條" : "框") + ";再按一次回到一般筆)";
    }
    /* ⚠ 復原鈕沒東西可撤時要**真的鎖住**(disabled),不是只調透明度 ——
       按了沒反應比灰著更讓人以為壞了。 */
    const un = $("dwUndo");
    if (un) un.disabled = !lastLive();
    // 只改鼠標樣式,不影響任何幾何。⚠ 三種模式互斥,所以這兩個 class 不可能同時掛上
    if (cv) { cv.classList.toggle("erasing", curEr); cv.classList.toggle("lining", curLine); }
  }
  /* ==========================================================================
     ★★★ 筆 / 直線 / 擦布是**三選一的模式**(v1.165.0)
     ──────────────────────────────────────────────────────────────────────────
       使用者:「擦布跟直線工具不要同時用,現在工具有點不容易了解在幹嘛」。
       v1.163.0~v1.164.0 讓直線與擦布**各自獨立**(想法是「擦一條直線很自然」),
       代價是畫面上會出現「兩顆同時亮著」,而使用者根本推不出那代表什麼 ——
       兩個獨立的布林 = 四種狀態,但工具列只講得出「哪幾顆亮著」。
       → 現在是互斥的三種模式,**永遠只有一顆亮**(或都不亮 = 一般筆)。
       ⚠ 畫面上的分組與填色在 draw.html / styles.css,但**互斥的真相在這裡** ——
         只改 CSS 的話兩個旗標還是會同時成立,而 stats().tool 會說謊。
     ========================================================================== */
  function modeToast(txt) { try { showToast(txt, 1100); } catch (e) {} }
  /* 選色。⚠ 從**擦布**回到筆(擦布模式下顏色沒有意義),但**直線模式保留** ——
     在直線模式下換顏色是合理的需求,把人踢回一般筆很煩。 */
  function pickColor(i) {
    if (!COLORS[i]) return;
    curC = i;
    if (curEr) { curEr = false; modeToast("✏️ 換回筆"); }
    syncTool();
  }
  function toggleEraser(on) {
    curEr = (on === undefined) ? !curEr : !!on;
    if (curEr && curLine) { curLine = false; lineFrom = null; lineTo = null; }   // 互斥
    modeToast(curEr ? "🧽 擦布:擦掉一部分" : "✏️ 一般筆");
    syncTool();
  }
  function toggleLine(on) {
    curLine = (on === undefined) ? !curLine : !!on;
    if (curLine && curEr) curEr = false;                                          // 互斥
    if (!curLine && lineFrom) { lineFrom = null; lineTo = null; repaint(); }
    modeToast(!curLine ? "✏️ 一般筆"
              : curShape === "rect" ? "▭ 矩形:拖出一個框"
              : curShape === "oval" ? "◯ 圓形:拖出一個框" : "📐 直線:按住拉一條直的");
    syncTool();
  }

  /* ==========================================================================
     四、回合資訊列 / 倒數環
     ──────────────────────────────────────────────────────────────────────────
       ★ 倒數的錨點是**相位開始的時間 + 這一段有多長**(不是「剩幾秒」)——
         每 200ms 用時間差重算,分頁被凍結過(手機切 App)也不會走鐘。
       ⚠ 用 key 去重:同一段倒數重畫畫面時不要重跑動畫(比照大老二 / 暗棋的 syncCd)。
     ========================================================================== */
  /* ★★ 最後 10 秒的「引線炸彈」(v2.4.1,Gemini 建議書 4.1)。
     ⚠⚠ 它是**疊在既有的 `.hot` 上面的第二個 class(`.bomb`),不是把 `.hot` 換掉** ——
       `.hot` 從 v1.154.0 起在**每一個相位**的最後 10 秒都會亮(選題也會),
       改成只在作畫相位亮的話等於**默默拿掉選題那一段的緊張感**,而那是既有行為。
       → `.hot` 一個字都沒動,`.bomb` 另外只在 `draw` 相位掛。
     ⚠ 舞台邊緣的紅色呼吸光也掛在同一個判定上(`.dw-stage.dw-hot`)。
       class 名字要帶前綴:`.dw-stage.alert` 那種寫法,元素身上那個 `alert` 會被任何
       全域的 `.alert` 規則吃到(CLAUDE.md 紅線 6 的第一類撞名)。
     ⚠ 心跳只在剩 3 / 2 / 1 秒各響一聲(每秒一次要靠 cdLastSec 去重 —— tick 是 200ms 一次)。
       ★ 刻意**不做**每秒都響的「心跳加速」:六個人的手機一起滴滴叫是噪音不是氣氛。 */
  let cdKey = "", cdT = null, cdEnd = 0, cdTotal = 0, cdDraw = false, cdLastSec = -1;
  function cdAlert(on) {
    const stg = $("dwStage");
    if (stg) stg.classList.toggle("dw-hot", !!on);
  }
  function stopCd() {
    if (cdT) { clearInterval(cdT); cdT = null; }
    cdKey = ""; cdLastSec = -1;
    const el = $("dwCd"); if (el) el.classList.remove("bomb");
    cdAlert(false);
  }
  function tickCd(fromTimer) {
    const el = $("dwCd"); if (!el) return;
    const left = Math.max(0, cdEnd - Date.now());
    const sec = Math.ceil(left / 1000);
    const pct = cdTotal > 0 ? Math.max(0, Math.min(100, left / cdTotal * 100)) : 0;
    el.style.setProperty("--dw-p", pct.toFixed(1) + "%");
    el.textContent = sec;
    el.classList.toggle("hot", left <= 10000);
    const bomb = cdDraw && left <= 10000 && left > 0;
    el.classList.toggle("bomb", bomb);
    cdAlert(bomb);
    if (bomb && sec !== cdLastSec) {
      cdLastSec = sec;
      if (sec <= 3) { try { Sound.unmark(); } catch (e) {} }
    }
    /* ★★ 階梯式提示搭這一班車(v2.5.3):adapter 每次收到都自己去重,而這一支的錨點
       是「相位開始時間 + 這一段多長」→ 分頁被凍結過也不會走鐘,比另開一個 timer 穩。
       ⚠⚠ **只在 interval 那條路上派**(fromTimer)—— setCd() 開頭那一次同步 tick
         不可以派:回呼會走到 adapter 的 paintBar() → 再叫一次 setCd(),而那一刻
         `cdT` 還沒指派完 → 內層會**再開一個 interval** 而外層把它覆蓋掉
         (漏掉的那個 interval 永遠不會被 clear,一場下來累積十幾個)。
         開場的那一次由 adapter 的 applyGame 自己 force 同步,不缺。 */
    if (fromTimer && cb.onTick) cb.onTick(left, cdTotal, cdDraw);
    if (left <= 0) stopCd();
  }
  function setCd(endAt, totalMs, key) {
    const el = $("dwCd"); if (!el) return;
    if (!endAt || !totalMs) { stopCd(); el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    if (key === cdKey && cdT) { cdEnd = endAt; cdTotal = totalMs; return; }
    cdKey = key || String(endAt);
    /* ⚠ 相位是從 key 讀的(adapter 傳的是 `ph + "#" + seq`)—— 刻意不多開一個參數:
       這一支有三個呼叫端,多一個參數就多三處可以漏。 */
    cdDraw = cdKey.indexOf("draw#") === 0;
    cdLastSec = -1;
    cdEnd = endAt; cdTotal = totalMs;
    if (cdT) clearInterval(cdT);
    tickCd();
    cdT = setInterval(() => tickCd(true), 200);
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
  /* ★★★ 猜題者的提示格(v1.161.0 的「幾個字」+ v2.5.3 的階梯式提示)。
     使用者(v1.161.0):「我覺得要猜的人應該要知道有幾個字,這樣才不會太廣泛」——
     沒有這一格的話「畫了一隻四隻腳的動物」可以是貓 / 狗 / 牛 / 長頸鹿,範圍大到猜不動。
     ★★ v2.5.3 起同一格演化成三個樣子(階梯的演算法在 DWR.hintAt,這一支只管畫):
         st0  `答案 4 字`
         st1  `🐾 動物 4 字`         ← 過半:分類徽章
         st2+ `🐾 動物 ＿珠＿＿`      ← 剩四分之一起:隨機開字(字數由方格數看得出來)
     ⚠⚠⚠ **沒有揭露的字一個都不可以進 DOM** —— 那是紅線 6 / 25 的結構性保證
       (偷看 DOM 比偷看 DB 容易太多)。所以 adapter 傳進來的 `mask` 陣列裡
       **沒揭露的那幾格是 `null`**,底線方格是這一支自己補的空 `<b>`;
       絕對不可以改成「把整個題目寫進去再用 CSS 遮起來」。
     ⚠ 開了字之後**不再另外寫數字**:方格自己就是字數,兩份寫在同一顆晶片上是雜訊,
       而這一列在 360px 上塞不下(見紅線 37 那筆寬度預算)。
     ⚠ 誰看得到、什麼時候顯示一律由 adapter 的 paintBar 決定(這一支只管畫),
       而**畫家不需要**:他看的是工具列那一格題目本身。
     ⚠ 這一格住在 .dw-bar(既有的一列)裡,不是新開一列 —— 這一頁多出來的垂直空間
       永遠是畫布的(見 notes/21 紅線 17)。 */
  const MASK_CH = "＿";            // 全形底線:純文字版(placeholder / 猜題列)的空格
  /* 把 mask 陣列變成一行字。⚠ 全形的字寬剛好與漢字一樣 → 不必靠 letter-spacing 排版,
     而 placeholder 與猜題列都只吃字串。 */
  function maskText(mask) {
    if (!mask || !mask.length) return "";
    return mask.map(c => (c == null ? MASK_CH : c)).join("");
  }
  function setHint(o) {
    const el = $("dwLen"); if (!el) return;
    const len = o ? Math.max(0, o.len | 0) : 0;
    el.classList.toggle("hidden", !len);
    if (!len) { el.innerHTML = ""; el.setAttribute("aria-label", ""); return; }
    const cat = o.cat;
    const mask = (o.mask && o.mask.length) ? o.mask : null;
    let html = "";
    /* ⚠ 分類的**名字**要能單獨藏起來(.dw-hcat-t)—— 開字之後這一格最寬,而 360px 上
       .dw-role(畫家名字)是 flex:1、會先被壓成省略號。實測不收的話它只剩 33px
       (「🎨 麥克」變成「🎨 麥…」),而畫家是誰是猜題者唯一要知道的人。
       → 窄畫面 + 有遮罩時只留圖示(分類本身在猜題列已經播過一則)。 */
    if (cat) html += '<span class="dw-hcat">' + cat.i + '<span class="dw-hcat-t">' + cat.n + '</span></span>';
    el.classList.toggle("msk", !!mask);
    if (mask) {
      html += '<span class="dw-hmask">' +
        mask.map(c => '<b class="dw-hc' + (c == null ? '' : ' on') + '">' + (c == null ? '' : esc(c)) + '</b>').join("") +
        '</span>';
    } else {
      /* ⚠ 有分類徽章時就不寫「答案」兩個字了 —— 「🍜食物答案4 字」讀起來是壞的,
         而那兩個字在有徽章的時候本來就沒有資訊量(窄畫面也早就把它藏掉了)。 */
      if (!cat) html += '<span class="dw-len-l">答案</span>';
      html += '<b>' + len + '</b> 字';
    }
    el.innerHTML = html;
    el.setAttribute("aria-label",
      (cat ? ("分類 " + cat.n + "、") : "") +
      (mask ? ("已經開字 " + maskText(mask)) : ("答案有 " + len + " 個字")));
  }
  /* ★ 提示剛冒出來的那一下:整顆晶片彈一下 + 金色外發光(建議書六之2)。
     ⚠ 一定要先把 class 拔掉再強制 reflow —— 連續兩階提示(4 個字的題會開兩次)
       之間只隔幾秒,不重啟動畫的話第二次完全不會動。
     ⚠ 動畫本身純粹是 transform + box-shadow,**不進版面流**(紅線 36)。 */
  let popT = null;
  function hintPop() {
    const el = $("dwLen"); if (!el) return;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    if (popT) clearTimeout(popT);
    popT = setTimeout(() => { popT = null; el.classList.remove("pop"); }, 900);
  }

  /* ---------- 畫家的「畫完了」(v1.168.0)----------
     使用者:「顯示說我已經畫完了,但是畫完後還是可以再補充,只是可以提醒其他要猜的人說,
     我沒有打算繼續畫了你們可以猜了」。
     ⚠⚠ 這一顆**不鎖畫布、不結束相位** —— 宣告完照樣可以繼續畫(那是使用者明講的)。
       所以它是 toggle 而不是「送出一次就定案」:按錯了再按一次收回來,零代價。
     ⚠ show / on 由 adapter 的 paintBar 決定(這一支只管畫),而 on 的真相在 `game.dw.fin`
       —— **不可以**用本地旗標記它:那樣別人那台看不到,而它存在的唯一目的就是給別人看。 */
  function setFinBtn(show, on) {
    const b = $("dwFin"); if (!b) return;
    b.classList.toggle("hidden", !show);
    b.classList.toggle("on", !!on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const t = $("dwFinT");
    if (t) t.textContent = on ? " 已畫完" : " 畫完了";
    b.title = on ? "再按一次:我還要再畫" : "告訴大家「我沒打算繼續畫了,可以猜了」(還是可以再補畫)";
    b.setAttribute("aria-label", on ? "已宣告畫完,再按一次收回" : "宣告我畫完了");
  }
  function bindFin() {
    const b = $("dwFin"); if (!b) return;
    b.addEventListener("click", () => cb.onFin && cb.onFin(!b.classList.contains("on")));
  }

  /* ---------- 放大模式的迷你比分條(v1.169.0)----------
     rows = [{ name, pts, mark, me }],**已經排好序**(adapter 的 paintMini 依分數排)。
     使用者:「最上層現在只剩下兩個小圖案,這樣是不是有點浪費,想點東西放上去吧,
     但要注意到絕對不能影響到麥克風跟 emoji」。
     ⚠⚠ 「不影響那兩顆」是 CSS 的事(`flex:1 1 0` + `min-width:0` + `overflow:hidden`,
       見 styles.css 那一段)—— 這一支**不可以**改成「算得出塞不下就少畫幾格」:
       那會變成兩個真相,而且視窗一轉向就錯。畫滿、讓 CSS 去裁。
     ⚠ 平常整條被 CSS 收起來(只有 body.dw-big 顯示),所以這裡**無條件畫**就對了 ——
       不要在這裡問「現在放大了嗎」,那又是第二個真相。 */
  function setMini(rows) {
    const el = $("dwMini"); if (!el) return;
    const list = rows || [];
    el.innerHTML = list.map(r =>
      '<span class="dw-mi' + (r.me ? " me" : "") + '">' +
      (r.mark ? '<span class="dw-mi-k">' + esc(r.mark) + '</span>' : "") +
      '<span class="dw-mi-n">' + esc(r.name || "") + '</span><b>' + (r.pts | 0) + '</b></span>'
    ).join("");
  }

  /* ==========================================================================
     五、蓋板:選題目 / 公布答案
     ──────────────────────────────────────────────────────────────────────────
       ★ 這兩個蓋板住在 .dw-stage 裡面(不是 .veil 那種全螢幕強制回應層)——
         所以**不必列進 BACK_LAYERS**(那個陣列是雙胞胎,能不動就不動)。
       ⚠⚠ 三選一的按鈕**只有畫家畫得出來**。畫面上絕不可以先畫好再用 CSS 藏起來:
         那等於把答案放進每個人的 DOM 裡,而偷看 DOM 比偷看 DB 容易太多了。
     ========================================================================== */
  /* ⚠ 這一支順手清掉 `dataset.pk`(paintPick 的重畫守衛,見下面那一段)——
     清在這裡而不是各呼叫端:蓋板換過內容之後那個 key 一定不再成立,漏清一處的症狀是
     「選題卡整回合不更新」,而它只在極少數的相位序列下才看得出來。 */
  function showOver(html, cls) {
    const box = $("dwOver"); if (!box) return;
    box.className = "dw-over" + (cls ? " " + cls : "");
    box.innerHTML = html;
    box.dataset.pk = "";
    box.classList.remove("hidden");
  }
  function hideOver() { const box = $("dwOver"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; box.dataset.pk = ""; } }

  /* 畫家的三選一 + 「✏️ 自己出題」(v1.171.0)。cands = 題目索引陣列;mine = 我是不是畫家。
     ⚠ mine 為 false 時**連題目文字都不產生**(見上面那條)。
     ⚠⚠ **同一張卡不可以重畫**(dataset.pk 守衛)。蓋板是「每一份 game 快照都重畫一次」的,
       在自訂題目那一格出現之前這頂多是閃一下;現在那一格是 <input> ——
       別人送一個表情、有人重連、有人改暱稱,都會讓畫家**打到一半的字整個消失**,
       而畫面上沒有任何線索,他只會覺得這一頁壞掉了。
       key 包含 mine / 候選 / 畫家名字 = 這張卡會長得不一樣的全部理由;一樣就整段不動。
     ⚠ 相位換掉時 showOver / hideOver 會把 key 清空 —— 所以下一回合一定重畫得出來。 */
  function paintPick(cands, mine, drawerName, allowOwn) {
    const box = $("dwOver");
    const key = (mine ? "m|" : "o|") + (cands || []).join(",") + "|" + (drawerName || "")
              + "|" + (allowOwn ? 1 : 0);
    if (box && !box.classList.contains("hidden") && box.dataset.pk === key) return;
    if (!mine) {
      showOver('<div class="dw-ov-card"><div class="dw-ov-t">' + esc(drawerName || "畫家") + ' 正在選題目…</div>' +
               '<div class="dw-ov-s">選好就開始畫,準備好猜了嗎 👀</div></div>', "wait");
      if (box) box.dataset.pk = key;
      return;
    }
    const btns = (cands || []).map((idx, k) =>
      '<button class="dw-pickbtn" type="button" data-k="' + k + '">' +
        '<span class="dw-pk-ic">' + DWGen.iconAt(idx) + '</span>' +
        '<span class="dw-pk-w">' + esc(DWGen.textAt(idx)) + '</span>' +
      '</button>').join("");
    /* ✏️ 自己出題。⚠ 房規關掉時**整格不產生**(不是用 CSS 藏起來)——
         藏起來的話 DOM 上還是有一個送得出去的輸入框,而擋它的只剩 adapter 那兩道。
       ⚠ maxlength 只是第一道:貼上、注音選字、手改 DOM 都繞得過,
         真正的上限在 DWR.cleanCustom(送出端與每一台的讀取端各洗一次)。 */
    const own = !allowOwn ? "" : '<div class="dw-own">' +
      '<input id="dwOwnI" class="dw-own-i" type="text" maxlength="' + DWR.CUSTOM_MAX + '" ' +
        'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
        'placeholder="自己出題(最多 ' + DWR.CUSTOM_MAX + ' 個字)" aria-label="自己出題">' +
      '<button class="dw-own-b" type="button" aria-label="用自己出的題目">✏️ 就畫這個</button>' +
      '</div>';
    showOver('<div class="dw-ov-card"><div class="dw-ov-t">你是畫家 · 選一個來畫</div>' +
             '<div class="dw-picks">' + btns + '</div>' + own +
             '<div class="dw-ov-s">不選的話時間到會幫你選第一個</div></div>', "pick");
    if (box) box.dataset.pk = key;
  }
  /* 三顆題目鈕 + 自己出題的送出。⚠ 用**事件委派、而且只綁一次** —— 綁在 paintPick 裡的話
     每重畫一次就多疊一個監聽(相位快照一動就重畫),按一下會送出好幾次。 */
  function ownSubmit() {
    const el = $("dwOwnI"); if (!el) return;
    cb.onPickOwn && cb.onPickOwn(el.value);
  }
  function bindPick() {
    const box = $("dwOver"); if (!box) return;
    box.addEventListener("click", e => {
      /* 分享鈕與題目鈕共用這一個委派(蓋板每換一次相位就整段重畫,綁在 paintShow 裡
         會每重畫一次多疊一個監聽 → 按一下送出好幾次)。 */
      if (e.target.closest(".dw-shbtn")) { shareShot(); return; }
      const rb = e.target.closest(".dw-luv");
      if (rb) { cb.onReact && cb.onReact(rb.dataset.e); return; }
      if (e.target.closest(".dw-own-b")) { ownSubmit(); return; }
      const b = e.target.closest(".dw-pickbtn"); if (!b) return;
      const k = +b.dataset.k;
      if (!isFinite(k)) return;
      box.querySelectorAll(".dw-pickbtn").forEach(x => x.classList.toggle("on", x === b));
      cb.onPick && cb.onPick(k);
    });
    /* Enter 直接送出(v1.171.0)—— 選題只有 15 秒,打完還要伸手去按鈕太慢。
       ⚠ isComposing 要擋:注音 / 日文輸入法選字時按 Enter 是「確定這個字」,
         不擋的話一按就把還沒選完的字送出去了。 */
    box.addEventListener("keydown", e => {
      if (e.key !== "Enter" || e.isComposing) return;
      if (!e.target.closest(".dw-own-i")) return;
      e.preventDefault();
      ownSubmit();
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
    /* ★★ 拍立得(v2.4.1,Gemini 建議書 4.2)。⚠⚠ **一列都不可以多加** ——
       這張卡在矮視窗上本來就會溢出蓋板約 14px(紅線 23 那條「不可以讓它自己捲」),
       多一列署名就會把溢出加倍。→ 畫家的名字**併進既有的那一行**「🎨 阿華 畫的答案是」,
       高度一個 px 都沒動;拍立得的樣子純粹是 `.dw-over.show` 那一段 CSS 換的皮。
       ⚠ 名字從 rows 裡撈(那一列本來就標著 drawer),不另外多傳一個參數。 */
    const dr = (rows || []).filter(r => r.drawer)[0];
    const cap = dr ? ("🎨 " + esc(dr.name) + " 畫的答案是") : "答案是";
    /* ★★ 即時點讚(v2.4.1,Gemini 建議書 4.2 的「靈魂畫作即時點讚」)。
       ⚠ 它**不是新的同步通道** —— 三顆鈕送的就是既有的表情(核心的 sendEmote),
         飛出來的動畫、音效、誰送給誰全部沿用 ui-kit 那一套,一行新的 DB 邏輯都沒有。
       ★ 存在的理由是「這張卡只活 5 秒」:要在 5 秒內開表情面板 → 挑一個 → 送出,
         實際上沒有人來得及,所以那一刻的反應永遠是零。一鍵就補上了。
       ⚠⚠ 位置與分享鈕對稱(它在右上、這一排在左上)——
         **絕對不可以放進 .dw-ov-card 裡**:那張卡在矮視窗上本來就會溢出 14px,
         而讓它自己捲會把 fit() 卡在 80×60 的下限回不來(紅線 23)。 */
    const RE = [["🎨", "神作"], ["🤣", "靈魂畫手"], ["💖", "天才"]];
    /* ⚠ class 刻意叫 .dw-luv 而不是 .dw-react —— 這一頁已經有一整組 `.dw-react-row`
       (結果卡的賽後表情列)。同族名字混在一起遲早會改到彼此,同 .dw-shbtn 那條的理由。 */
    const reacts = '<span class="dw-luvs">' + RE.map(r =>
      '<button class="dw-luv" type="button" data-e="' + r[0] + '" title="' + r[1] + '" aria-label="' + r[1] + '">' + r[0] + '</button>'
    ).join("") + '</span>';
    showOver(reacts +
             '<button class="dw-shbtn" type="button" title="分享這張畫" aria-label="分享這張畫">📤</button>' +
             '<div class="dw-ov-card"><div class="dw-ov-s">' + cap + '</div>' +
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
     ⚠ v1.161.0 起「正解幾個字」是**公開的提示**(見 setHint),但這裡照樣一個字都不播:
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

  /* ==========================================================================
     ★★ 三支純畫面的特效(v2.4.1,Gemini 建議書 2.2 / 4.1 / 4.2)
     ──────────────────────────────────────────────────────────────────────────
       共同的規矩,三支都適用:
       ① **一個位元組都不上線** —— 全部由收到的狀態在本地推出來。
       ② **絕對定位、pointer-events:none** —— 這一頁的畫布尺寸是 fit() 量出來的,
          任何進得了版面流的新元素都會把畫布縮小(而那是紅線 17 翻過四次的那件事)。
       ③ 重播動畫一律「先拿掉 class → 讀一次 offsetWidth → 再加回去」:
          ⚠ 少了中間那一行,同一個 class 連著加兩次**不會重跑動畫**
          (症狀:第二個人猜中時橫幅不動,而第一個人那次完全正常)。
     ========================================================================== */
  /* ★ 猜中的彩色彈幕。⚠ 內容只有「誰 + 第幾個」——**猜的內容一個字都不進來**,
     同 addHit 的理由(紅線 5):它可能是同義詞,播出去等於多送一條線索。 */
  let banT = null;
  function hitBanner(name, rank) {
    const el = $("dwBanner"); if (!el) return;
    el.innerHTML = '<span class="dw-bn-i">🎉</span>' +
                   '<span class="dw-bn-n">' + esc(name || "") + '</span>' +
                   '<span class="dw-bn-r">' + (rank >= 0 ? "第 " + (rank + 1) + " 個猜中!" : "猜中了!") + '</span>';
    el.classList.remove("hidden", "go");
    void el.offsetWidth;                              // ⚠ 見上面 ③
    el.classList.add("go");
    if (banT) clearTimeout(banT);
    banT = setTimeout(() => {
      const b = $("dwBanner");
      if (b) { b.classList.add("hidden"); b.classList.remove("go"); b.innerHTML = ""; }
      banT = null;
    }, 2400);
  }
  /* ★ 拍立得的快門閃光(公布答案那一刻)。⚠ 它蓋在 #dwOver **上面** —— 先閃白再露出
     那張卡,才像「咔嚓一聲把這張畫拍下來」;蓋在下面的話只會被蓋板的半透明黑吃掉。 */
  let snapT = null;
  function snapFlash() {
    const el = $("dwFlash"); if (!el) return;
    el.classList.remove("hidden", "go");
    void el.offsetWidth;                              // ⚠ 見上面 ③
    el.classList.add("go");
    try { Sound.mark(); } catch (e) {}
    if (snapT) clearTimeout(snapT);
    snapT = setTimeout(() => {
      const f = $("dwFlash");
      if (f) { f.classList.add("hidden"); f.classList.remove("go"); }
      snapT = null;
    }, 760);
  }
  /* ★★★ 「🔥 好接近了」。ms = 亮多久(adapter 傳 DWR.coolMs(),讓它與冷卻同時結束 ——
     這裡不去問規則層,不然凍結時間就有兩個真相了)。
     ⚠⚠ 這一支只在**猜的那個人自己那一台**被呼叫,絕對不可以變成廣播(理由在 DWR.near)。
     ⚠ 提示是**輸入列自己在燒**,不是新開一格:那一列是 flex:none,多一格就是從畫布
       身上拿高度(紅線 17)。文字走既有的 toast。 */
  let nearT = null;
  function nearHint(ms) {
    const row = $("dwInputRow"); if (!row) return;
    row.classList.remove("near");
    void row.offsetWidth;                             // ⚠ 見上面 ③
    row.classList.add("near");
    if (nearT) clearTimeout(nearT);
    nearT = setTimeout(() => {
      const r = $("dwInputRow"); if (r) r.classList.remove("near");
      nearT = null;
    }, Math.max(600, ms | 0) );
    try { showToast("🔥 好接近了!就差一點點", 1900); } catch (e) {}
  }
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
  /* ---------- 放棄這一題:兩段式(v1.168.0)----------
     使用者:「如果真的猜不到,我想多一個放棄的功能,才不用一直硬要等時間到」。
     ⚠⚠ 放棄**不能反悔**(`DWR.roundDone` 看的就是它),所以誤觸一定要擋 ——
       但**不可以**為它開一層 veil / 確認卡:那要列進 ui-kit 的 BACK_LAYERS,而那個陣列
       是雙胞胎(CLAUDE.md 紅線 7)。→ 用「第一次按只是武裝 3 秒」的兩段式,零新蓋板。
     ⚠ 武裝中鈕要**整顆變警告色 + 換字**:第一次按沒有任何反應的話使用者會狂按,
       那就等於一按就放棄(而那是這一顆最不能出的錯)。
     ⚠ 武裝到期一定要自己解除 —— 停在武裝狀態的話,下一次隨手一按就送出去了。 */
  const GV_ARM_MS = 3000;
  let gvArmT = null;
  function gvArmed() { const b = $("dwGiveUp"); return !!b && b.classList.contains("armed"); }
  function gvDisarm() {
    if (gvArmT) { clearTimeout(gvArmT); gvArmT = null; }
    const b = $("dwGiveUp"), t = $("dwGvT");
    if (b) b.classList.remove("armed");
    if (t) t.textContent = "🏳️";
    if (b) b.title = "猜不出來,放棄這一題(按兩次)";
  }
  function bindGiveUp() {
    const b = $("dwGiveUp"); if (!b) return;
    b.addEventListener("click", () => {
      if (gvArmed()) { gvDisarm(); cb.onGiveUp && cb.onGiveUp(); return; }
      const t = $("dwGvT");
      b.classList.add("armed");
      if (t) t.textContent = "確定?";
      b.title = "再按一次就放棄這一題(不能反悔)";
      try { showToast("再按一次就放棄這一題(不能反悔)🏳️", 2600); } catch (e) {}
      if (gvArmT) clearTimeout(gvArmT);
      gvArmT = setTimeout(gvDisarm, GV_ARM_MS);
    });
  }

  let coolT = null;
  function setGuess(st) {
    const row = $("dwInputRow"), inp = $("dwGuess"), btn = $("dwSend");
    if (!row || !inp || !btn) return;
    row.classList.toggle("hidden", !st.show);
    /* ★ 放棄鈕的顯示條件**就是 `can`**(= adapter 說「這一題你還能猜」):
       已經猜中 / 已經放棄 / 不是 draw 相位一律跟著收起來,不必再傳一個欄位。
       ⚠ 凍結中照樣顯示且**按得到**(冷卻只鎖輸入,放棄與它無關)——
         所以這一行刻意在 apply() 外面,不看倒數。 */
    const gb = $("dwGiveUp");
    if (gb) gb.classList.toggle("hidden", !(st.show && st.can));
    if (!(st.show && st.can)) gvDisarm();
    if (coolT) { clearInterval(coolT); coolT = null; }
    const apply = () => {
      const left = st.coolEnd ? Math.max(0, st.coolEnd - Date.now()) : 0;
      const can = st.can && left <= 0;
      inp.disabled = !can; btn.disabled = !can;
      row.classList.toggle("cool", left > 0);
      /* ★★ v2.5.3:開了字之後 placeholder 換成遮罩(「＿珠＿＿」)。理由同 v1.161.0 的
         字數提示 —— 手指在打字時眼睛不會抬到頂列那顆晶片去。
         ⚠ 沒揭露的字在陣列裡是 null(見 DWR.revealMask),這裡補的是全形底線。 */
      const mt = maskText(st.mask);
      inp.placeholder = left > 0 ? ("冷卻中… " + Math.ceil(left / 1000) + " 秒")
                                 : (can ? (mt ? ("猜這個:" + mt)
                                              : ("打出你猜的答案" + (st.len > 0 ? " · " + st.len + " 個字" : "")))
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
  /* 分享圖那塊紙要多高 —— 跟著**這張圖真正的形狀**走(v2.2.0)。
     ⚠ 在此之前固定 1000×750,而畫布從 v1.155.2 起就不是 4:3 了 → 分享出去的那一張
       **一直是被壓過的**(直向手機上壓得最凶,而受眾全是手機)。沒有人回報是因為
       按分享的人自己也沒看過那張圖長什麼樣 —— 它是直接送進系統分享匣的。
     ★ v2.2.0 起每一台的 boxW/boxH 已經是同一個形狀(見檔頭 ①)→ 誰按分享都輸出同一張。
     ⚠ 寬度固定 1000:字幕的字級、留白、浮水印位置全部是照它訂的。
     ⚠ 上下限是防呆(極端視窗),不是設計值。 */
  function shotH() {
    const ar = (boxW > 0 && boxH > 0) ? (boxW / boxH) : (LW / LH);
    return Math.max(560, Math.min(2000, Math.round(LW / ar)));
  }
  function shotDataUrl() {
    const lines = shotLines();
    const capH = SHOT_PAD * 2 + lines.length * SHOT_LINE;
    const H = shotH();
    // ① 透明層:墨水與擦布(見上面 ⚠⚠⚠)
    const ink = document.createElement("canvas");
    ink.width = LW; ink.height = H;
    paintTo(ink.getContext("2d"), LW, H);
    // ② 紙 + 貼上 ① + 字幕
    const out = document.createElement("canvas");
    out.width = LW; out.height = H + capH;
    const g = out.getContext("2d");
    g.fillStyle = paperColor();
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(ink, 0, 0);
    g.strokeStyle = "rgba(0,0,0,.12)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(SHOT_PAD, H); g.lineTo(LW - SHOT_PAD, H); g.stroke();
    let y = H + SHOT_PAD + 30;
    lines.forEach(l => {
      g.fillStyle = l.head ? "#20242c" : (l.ok ? "#2f7de0" : "rgba(32,36,44,.72)");
      g.font = (l.head ? "800 34px " : "700 30px ") + "'Nunito','Noto Sans TC',sans-serif";
      g.fillText(l.t, SHOT_PAD, y);
      y += SHOT_LINE;
    });
    g.fillStyle = "rgba(32,36,44,.34)";
    g.font = "700 24px 'Nunito','Noto Sans TC',sans-serif";
    const mark = "你畫我猜 🎨";
    g.fillText(mark, LW - SHOT_PAD - g.measureText(mark).width, H + capH - SHOT_PAD + 6);
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
    init, fit, resetInk, applyRec, setEnabled, clearInk, setBrush, setSeat,
    /* v2.2.0:這一回合我是不是畫家(= 畫布形狀的來源,見檔頭 ①)。 */
    setArtist,
    pickColor, toggleEraser, toggleLine, undo, syncTool,
    /* 兩指縮放(v2.1.0)。zoomAt 匯出只給診斷 / e2e 用 —— 真人走的是手勢與那顆晶片。 */
    resetView, zoomAt,
    setShotInfo, shareShot, shotLines, shotDataUrl,
    setCd, stopCd, setRoundInfo, setHint, maskText, hintPop, setZoom,
    setFinBtn, gvArmed, gvDisarm, setMini,
    /* v2.4.1:清空的兩段式(畫面上那顆 🗑 走這一支;clearInk 是真的動手的那一支) */
    clearAsk, clrArmed, clrDisarm,
    /* v2.4.1:三支純畫面的特效(見上面第六節尾巴) */
    hitBanner, snapFlash, nearHint,
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
               line: curLine, shape: curShape, w: boxW, h: boxH,
               /* v2.1.0:兩指縮放的檢視狀態(倍率 + 位移)。守門要量得到
                  「放大之後送出去的座標有沒有跟著歪掉」。 */
               k: vk, vx: vx, vy: vy,
               /* v1.170.0:共同作畫的守門要量得到「我的筆有沒有帶座位命名空間」
                  與「復原鈕會不會去動別人的筆」。 */
               base: sidBase, mine: strokes.filter(s => !s.un && isMySid(s.sid)).length,
               /* v2.2.0:畫布形狀。守門要量得到「我有沒有照畫家的比例縮」——
                  art 是「我是不是形狀的來源」,src 是收到的來源比例(0 = 還沒收到)。 */
               art: iArtist, src: srcAR, ar: boxH ? boxW / boxH : 0 };
    }
  };
})();

"use strict";

/* ============================================================================
   台灣 16 張麻將 — 盤面渲染(M16B)。單機與連線共用同一個盤面。
   相依:MJFace(js/shared/mj-faces.js)、MJ16(rules.js)、MJT(table.js)。

   ── 這一支只做「把 state 畫出來」與「把點擊轉成意圖」 ────────────────────
     它**不改任何遊戲狀態** —— 所有動作都往上回呼(onDiscard / onAction / onBid),
     由 solo/adapter 決定要不要真的執行。理由同五子棋的 GB:單機與連線共用一份畫面,
     真相各自管理,盤面不該知道自己在哪一種模式。

   ── ★ 手牌排版:一排 vs 兩排,自動選(P0 原型量出來的結論) ────────────────
     實測(tools/t-mj16-hand.html):
       390px 直向 → 一排只有 21px,牌面糊成一團認不出來;兩排依花色分組有 37px。
       844px 橫向 → 一排 47px,又清楚又好按。
     ⚠ 判準**不能照抄 MGen.pickShape() 的「比誰寬」** —— 那樣 844px 會選到兩排的
       91px,荒謬地大又平白多一排。這裡改成:
         **一排的牌寬 ≥ ONE_ROW_MIN 就用一排,否則用兩排(依花色分組)。**
       ONE_ROW_MIN 是**辨識度**常數(21px 明確不行、34px 明確可以),不是版面偏好。

   ── ★ 打牌操作:看裝置分兩套(v1.58.1) ─────────────────────────────────
     觸控 → **兩段式**:點一下選取上浮、再點同一張才真的打出。
     滑鼠 → **hover 上浮 + 點一下打出**:游標移過去就站起來(等於第一段的預覽已經有了),
            再要求點兩下反而像「第一下沒反應」。
     判準是 `(hover:hover) and (pointer:fine)`,CSS 與 JS 讀同一條,不會一邊上浮一邊卻要點兩次。
     兩段式存在的理由不變:①小牌面防誤觸 ②**打錯牌在麻將不可逆**(不像消消樂配錯根本不成立)。

   ── ★ sel 存「格位」不存「牌」 ────────────────────────────────────────────
     v1.58.0 的 bug:sel 存牌值 t,手上有一對時 `sel===t` 兩張都命中 → 一起站起來。
     現在存 render() 給的格位鍵 data-k(手牌 "h<序號>"、摸進來那張 "d")。
     ⚠ 格位鍵會隨手牌內容位移,所以手牌一變(吃碰槓 / 打出 / 換局)就把 sel 清掉,
       不然舊索引會指到別張牌上。

   ── ★★ 牌的大小在一局裡要「幾乎不動」(v1.58.3,實際上手回報)─────────────
     回報是「打牌的過程中會一直不停的變換牌的大小」。牌寬是算出來的(寬度 →
     再被高度夾),所以**任何讓總高度或總寬度變一點的東西都會讓整副牌換一次大小**。
     四個來源,一個一個堵掉,而不是去調那個夾取演算法:
       ① **摸進來那張**:有它 17.45 單位、沒它 16 單位 → 每摸一張縮 8%、每打一張放大
          回來,**每一輪來回一次**,這是最刺眼的那個。
          → 那一格**一律預留**(沒摸牌時放一個等寬的透明佔位 .m16-slot),
            牌寬與手牌的水平位置因此整局固定。
       ② **牌河長高**:換一排就多 20~30px。→ 牌河高度寫死成 POOL_ROWS 排(超過就捲,
          並自動捲到底讓最新那張看得見)。
       ③ **動作列忽高忽低**:純文字 12px vs 一排 30px 的按鈕。→ .m16-acts 給 min-height。
       ④ 攤明牌 / 補花 真的會多一排 —— 這個省不掉,所以改成「**只縮不放**」:
          在同一個容器尺寸(寬 × 高)與同一局裡,牌寬單調不遞增;容器尺寸一變或換局
          才重新量。放大回去對排版沒有好處,只會讓人覺得畫面在跳。
       ⑤ **花色切點**(v1.70.1,又一次上手回報:「手牌沒有長度變化,卻因為別人打的牌
          突然縮小,下一把摸到牌又放大回來」)。牌寬原本是「在花色邊界裡挑**牌寬最大**
          的那個切點」算出來的 —— 佔得到便宜就用大牌,但可切的邊界**每摸一張、每打
          一張都在變**:16 張手牌在 9/7 切法(9 單位 → 51px)與 8/8 切法(9.45 單位
          → 49px)之間來回,張數明明一直是 16。實測(tools/gen-mj16-fit-diag.js)
          一局裡來回三次,而且高度夾取從頭到尾**沒有觸發**(h1 == hh)——
          病灶完全在寬度這一側。
          → 牌寬改成只看**張數**的預算 budgetUnits(),切點只決定「哪些牌在哪一排」。
     ⚠ 「只縮不放」曾經拿「容器寬 × 高」當 key、尺寸一變就重量(v1.58.3~v1.70.0)。
       ★ v1.70.1 拿掉了:盤面變矮的**原因**分不出來 —— 視窗真的變了(該重量)與
         動作列 / 房間框長高一格(不該重量)在尺寸上長得一樣,矮視窗上每一手都放一次
         收一次(e2e 750×485 量到同一個容器尺寸下 25 ↔ 27 反覆)。
         現在改成原因驅動:地板只由 resetFit() 放掉 —— 換局 / 離房 / 視窗 resize。
       ⚠ 當年把高度放進 key 是為了防「一路棘輪縮到 TILE_MIN」。原因驅動之後那個顧慮
         也解決了:暫時變矮只會縮**一次**(之後高度恢復,內容塞得下就不再縮)。
     ⚠⚠ 地板 fitTw **不可以讓 clearSel() 順手清掉**(v1.70.1 的另一半):那一支在
       「吃碰成立」「我表態完」也會被叫到(solo.js 四處),清掉等於每次宣告結束都
       允許再放大一次 —— 縮下去卡住、宣告完彈回來,就是回報裡那個「又放大回來」。
       換局 / 離開牌桌才該重新量,那時請叫 resetFit()。

   ── ★ ⑥ 手機橫向版面(v1.73.0)────────────────────────────────────────────
     橫向手機**原本不能玩**:實測 844×390(可視 814×295)盤面只有 95px 高、內容要 243px
     → 溢出 148px,**整排手牌被推到可視範圍外**,牌寬同時被夾到 TILE_MIN。
     而同一個畫面寬度**浪費了近六成**。所以橫向缺的只有高度:
       · `styles.css` 把盤面改成**左右分欄**(牌河在左、對手直排靠右、手牌橫跨底部)
       · 這一支把**牌河讓一排**出來(POOL_ROWS_LAND)
       · 地板加一段**暖身期**,免得鎖在牌桌剛顯示那幾幀的暫時高度上
     ⚠ 判準 `LAND` 的字串**必須與 styles.css 那條 @media 逐字相同**(同 FINE 的規矩),
       而且三個條件缺一不可 —— 少了 `pointer:coarse`,桌機把視窗拉矮就會中。

   ── ★★ 手牌可以自己拖著排(v1.82.0,照大老二 v1.80.0 那一套)─────────────────
     使用者:「台灣麻將,請你參考大老二,我想增加拖曳排序功能」。
     整段實作與「為什麼不那樣做」寫在**最後一節(拖曳排序)**;這裡只留四句
     一定要先知道的:
       · 順序是**純本地的顯示** —— 不進 DB、不進 state、不影響任何判定,
         所以連線時新舊版可以同房,而且**不是自己的回合也拖得動**
       · **拖曳中不重畫**(render() 那道閘門)—— 這一頁比大老二更需要它:
         render() 為了夾牌寬會在**一次呼叫裡** innerHTML 重建最多七次
       · **摸進來那一張不拖**(它不在 st.hands 裡,而且「打掉剛摸的不必瞄準」
         是既有的版面約定);⚠ 宣告聽牌之後手牌 pointer-events:none,那時也拖不動
       · 換局重設走呼叫端的 **resetOrder()**(同 resetFit() 的三個呼叫點),
         **clearSel() 絕對不可以順手清順序** —— 它在「吃碰成立 / 我表態完 / 結算」
         也會被叫到,清了等於每碰一次就把玩家排好的手牌打散
   ========================================================================== */

const M16B = (function(){

  const F = (typeof MJFace!=="undefined") ? MJFace : null;
  const R = (typeof MJ16 !=="undefined") ? MJ16  : null;

  const ONE_ROW_MIN = 32;      // 一排時的最小可辨識牌寬(見檔頭)
  const TILE_MIN = 20, TILE_MAX = 64;
  const DRAW_GAP = 0.45;       // 摸進來那張與手牌之間的間隔(幾張牌寬)
  const POOL_ROWS = 3;         // 牌河固定留幾排(見檔頭②;超過就捲)
  const POOL_ROWS_LAND = 2;    // 橫向手機:高度是唯一稀缺資源,牌河讓一排出來(見檔頭⑥)

  let host=null, cb={}, st=null, me=0, sel="", lastSig="", tingSelTile=-1;
  /* ★ 玩家自己拖出來的顯示順序(牌值陣列;沒拖過 = null)。見最後一節。
     ⚠ 它只在 viewHand() 一個地方被讀 —— 送去規則層 / 動作的一律是原始的手牌。 */
  let ord = null;
  let drag = null, noClick = false;     // 拖曳中的狀態 / 這一下的 click 要不要吃掉
  /* 宣告聽牌的選牌模式(v1.67.0):按了動作列那顆「宣告聽牌」之後為 true,
     這時點手牌 = 選要打哪一張來宣告。⚠ 換局 / 離房 / 宣告成立都要清掉(clearSel)。 */
  let tingPick = false;
  /* ★ 「我這一輪已經表態了」—— **只有連線用得到**。
     連線的表態走 txGame(..., { local:false })(不做本地樂觀套用),所以按下「過 / ✔ 碰」
     的那一刻**本地的 st.claim.bids[me] 還是空的** → claimOpts() 照樣算得出選項、
     那幾張牌會繼續站在那裡等伺服器回音,而動作列已經換成「已表態,等其他人…」了
     (一副「我按了沒有用」的樣子)。這個旗標讓牌立刻放下。
     ⚠ 生命週期與 adapter 的 myBid **完全一樣**、寫在同兩個點:sendBid() 設 true,
       「宣告視窗換了一輪」設 false(clearSel 再兜一層)。所以它不會多出一種卡死 ——
       真要卡在 true,連線那支的動作列本來就不讓我表態了。
     ⚠ 單機**用不到也不該用**:MJT.bid() 當場就回一個新 state,bids[me] 立刻是實的。 */
  let bidDone = false;
  /* 聽牌後自動摸切(個人偏好,v1.119.0)。使用者:「宣告聽牌後,可以設計一個選項自動出牌,
     但是如果有可以槓,也是需要停下來」。
     ★ 放在這裡而不是 Solo 或 MP 各自的私有變數 —— 這是**跨單機與連線共用**的一份狀態
       (同 M16Sfx 的 voice / tileVoice):solo.js 的 step() 與 adapter.js 的 applyGame()
       各自只讀這一顆旗標,誰都不用去問對方現在是不是連線中。
     ★ 存在 mahjong16.prefs.v1(adapter.js 的 ownPrefs/usePrefs 負責讀寫,設定面板的
       開關也接在那裡)—— 個人偏好,不是房間設定:宣告聽牌之後那一手本來就被規則鎖死
       只能打摸到的那張,自動幫忙點下去不影響任何人算的台數,不必像 claimSec 那樣凍結。
     ⚠ **不要**跟著 clearSel() 一起清掉:那支在「換局 / 吃碰成立 / 我表態完」都會被叫到,
       它們與「我要不要自動摸切」這個人偏好無關(同 fitTw / ord 那兩條紅線的理由)。 */
  let autoTing = false;
  /* 大牌桌(v1.174.0)。使用者:「你畫我猜那個大小畫板蠻不錯的,其他遊戲也可以加入」。
     ★ 與 autoTing 同一個模式:**跨單機與連線共用的一份狀態**,存在 mahjong16.prefs.v1
       (adapter.js 的 ownPrefs/usePrefs 負責讀寫)。單機與連線共用同一個盤面,
       各留一份就會出現「單機開著、切回連線又縮回去」。
     ⚠ 真正的樣式在 styles.src.css 的 `body.m16-big` 那一段;這裡只負責切 class、
       同步兩顆鈕的字面、然後**把牌寬重新量一次**(見 setBig 的註解)。 */
  let big = false;
  /* 「只縮不放」的地板(見檔頭④):fitTw = 目前用的牌寬,一局裡單調不遞增。
     ★ v1.70.1 拿掉了原本一起記的 fitKey(容器寬 × 高,一變就把地板放掉)——
       「盤面變矮」有兩種,而尺寸值分不出來:
         · 視窗真的變了(轉向 / 縮放 / 手機工具列)→ **該**重新量
         · 動作列 / 房間框的內容長高一格 → **不該**重新量
       矮視窗上後者每一手都可能發生一次,於是地板一放一收、牌寬在兩個值之間來回
       (e2e 750×485 實測同一個容器尺寸下 25 ↔ 27 反覆)。
       現在地板只由 resetFit() 放掉,而它掛在「換局 / 離房 / 視窗 resize」三處 ——
       原因驅動,不是尺寸驅動。
     ⚠ 這樣「暫時變矮」會讓牌永久縮一級(直到換局),但**不會反覆棘輪** ——
       比忽大忽小好,而且動作列有 min-height:38px 撐著,正常不會長高。 */
  let fitTw = 0;

  /* ★★ 地板的「暖身期」(v1.73.0,只有橫向啟用)——────────────────────────────
     做橫向版面的預覽時發現:同一份 CSS、同一個視窗,兩次執行量到的牌寬是 44 與 28,
     而兩次的盤面高度**都是 158、都沒有溢出** —— 空間明明夠,第二次卻只用了 28。
     原因是牌桌剛顯示的那幾幀,房間框 / 動作列 / 字型都還沒穩定,盤面一度比較矮,
     render() 算出一個偏小的牌寬就**記成地板**,之後空間長回來也放不大,卡一整局。
     resetFit() 掛在換局 / 離房 / resize,但「剛顯示出來」這一段沒有人放它。

     修法:resetFit() 之後給一段暖身期,期間**只畫不記地板**,過了才鎖定。
       · 是「原因驅動」的延伸(換局 / 進場 / 轉向 才有暖身),不是回到 v1.70.1
         拿掉的那個「尺寸一變就重量」—— 暖身期一過,地板照舊只縮不放。
       · 尾巴排一次 render():暖身期內不一定還有事件進來,不補這一下會鎖在
         最後一次 render 的值上,等於沒改。
     ⚠ **刻意只在橫向啟用**(landscape() 為假時 warmUntil 歸零)。直向很可能有同一條
       毛病,但這次改動的界線是「不碰正常佈局」,直向要不要一起吃另外評估。
       → notes/11-台灣麻將16張.md 第六節(「地板的暖身期 WARM_MS」那一段)。 */
  /* 1200ms 是「牌桌整個安定下來」的量級(房間框畫完 + 字型換好 + 動作列第一次有內容 +
     開局補花)。拉太短會鎖在補花前的暫時值,太長則是使用者盯著看的時間變久 ——
     實測 844×390 一整局在 700ms 下還會變一次(32→38),1200 之後才穩。 */
  const WARM_MS = 1200;
  let warmUntil = 0, warmTimer = 0;

  /* 把地板放掉,下一次 render() 從頭量一次;橫向另外開一段暖身期(見上)。
     ★ 只有**換局 / 離開牌桌 / 視窗真的變了**該叫 —— 盤面自己的 ResizeObserver 不可以。 */
  /* ⚠ v1.174.0 一度在這裡加過一個 forceWarm 參數,讓大牌桌(applyBig)在**直向**也開暖身期
     —— 理由是「切 class 那一瞬間版面整個換一套,ResizeObserver 會在那幾幀跟著量」,
     與轉向同類。做出來之後跑突變測試:**加不加它,e2e 都是綠的**(見 gen-mj16-solo-e2e
     的 J2 節),而它的代價是每按一次大牌桌、牌就多花 1.2 秒才安定。
     照 CLAUDE.md 紅線 17 的紀律(守門的守門是突變測試)整段拿掉了 ——
     ⚠ 想加回來之前,先寫得出「哪一條斷言會因為它而紅」。 */
  function resetFit(){
    fitTw = 0;
    if(!landscape()){ warmUntil = 0; return; }
    warmUntil = Date.now() + WARM_MS;
    if(!warmTimer && typeof setTimeout === "function")
      warmTimer = setTimeout(function(){ warmTimer = 0; render(); }, WARM_MS + 60);
  }

  /* ==========================================================================
     大牌桌(v1.174.0)—— 收掉頂列與房名 / 狀態字,把空間全部讓給盤面
     ──────────────────────────────────────────────────────────────────────────
       ★★★ **只在牌桌畫面生效**(你畫我猜 v1.161.0 用一個 bug 換來的教訓,原文在
         js/draw/board.js 的 setZoom)。`body.m16-big` 會收掉整條頂列,而頂列裡是
         **遊戲名稱 + ⛶ + ⚙️**;鈕住在房間框 / 單機列裡面,那兩層在選單與大廳都是
         hidden → 一旦 class 在非對局畫面留著,**沒有任何東西可以把它關回來**。
       ⚠⚠ 而且必然會發生:狀態記在偏好裡,loadPrefs() 在**開頁那一刻**就套用 ——
         上一場忘了關,之後每次開這一頁都少了名稱與那兩顆鈕。
       ⚠ 守衛擋在這裡而不是各個呼叫端:`body.m16-big` 只有這一行在掛,擋在源頭就不必
         要求每一條路(偏好 / 兩顆鈕 / 換畫面)各記得判斷一次。
       ⚠ 連帶一條:**離開牌桌的那一刻要再叫一次** —— class 掛在 body 上,沒人脫它就留著。
         那一半在 js/mahjong16/main.js 的 showScreen()(每次換畫面都無條件叫)。

       ⚠⚠ **一定要 resetFit()**,不是只 render():牌寬的地板是「只縮不放」的(見上面
         let fitTw),而大牌桌是唯一一種「盤面**變高**」的情形 —— 不放掉地板的話,
         按下去畫面重排了、牌卻一個 px 都不會變大(你畫我猜同一顆鈕踩過這一格)。
       ⚠ 盤面自己的 ResizeObserver 只 render() 不放地板,**指望不上它**(那是刻意的)。

       ★ syncTools():頂列一消失,ui-kit 就會把 ⛶ / ⚙️ 搬進房間框那一列
         (它自己判斷 `.topbar` 的 computed display 是不是 none)。所以這一頁的大牌桌
         **設定與全螢幕照樣按得到** —— 你畫我猜刻意讓那兩顆跟著頂列一起消失,
         理由是它那條列塞不下第五、六顆鈕;麻將這邊通用的
         `.row:has(> .tools-docked){padding-right:80px}` 已經把位置讓好了,不會壓到 😀。 */
  function playLive(){
    const el = document.getElementById("m16Play");
    return !!el && !el.classList.contains("hidden");
  }
  function applyBig(){
    const inPlay = playLive();
    document.body.classList.toggle("m16-big", big && inPlay);
    const on = document.body.classList.contains("m16-big");
    /* 兩顆鈕(連線 #m16Big / 單機 #m16SoloBig)一起同步 —— 同一份狀態,不可以各說各話。
       ⚠ 字面用「大 / 小」不用 ⤢ / ⤡:那兩個箭頭在手機上細得像雜訊
         (使用者對你畫我猜第一版的原話:「好難看啊」)。 */
    const btns = document.querySelectorAll(".m16-bigbtn");
    for(let i=0;i<btns.length;i++){
      const b = btns[i];
      /* ★★★ 不在牌桌畫面就把鈕**藏起來**(v2.4.1,與 ui-kit 的 BigMode 同一件事)。
         使用者:「還沒開始遊戲的時候,emoji 旁邊的大棋盤模式按鈕,按了也不會有什麼反應,
         這個時候應該要隱藏起來」—— 連線的房間框在**大廳**就已經看得見,而上面那道
         playLive() 守衛會把 class 立刻關掉 → 畫面一個 px 都不動 = 「按了沒反應」。
         ⚠ 藏的是鈕不是意願:big 照舊留著,開局之後鈕與大牌桌一起回來。
         ⚠ 單機那一顆(#m16SoloBig)不受影響:單機列本來就跟牌桌畫面一起出現。
         ⚠ 與橫向那條 `.m16-bigbtn{display:none}` 各管各的,兩者都是 display:none,疊了也沒事。
         ★ 守門:tools/t-big-consist.html 的 E 條。 */
      b.classList.toggle("hidden", !inPlay);
      b.classList.toggle("on", on);
      b.textContent = on ? "小" : "大";
      b.title = on ? "回一般大小" : "大牌桌";
      b.setAttribute("aria-label", b.title);
    }
    if(typeof syncTools === "function") syncTools();
    /* ⚠⚠ **一定要 resetFit(),不可以只 render()** —— 牌寬的地板是「只縮不放」的
       (見上面 let fitTw),而大牌桌是這一頁唯一一種「盤面**變高**」的事件:
       不放掉地板的話,畫面確實重排了、盤面確實變高了,而**牌一個 px 都不會變大**。
       ⚠ 那個症狀完全不像是地板的問題(看起來像 CSS 沒生效),你畫我猜的同款按鈕踩過。
       ⚠ 盤面自己的 ResizeObserver 只 render() 不放地板(那是刻意的),指望不上它。
       ★ 突變驗過:把 resetFit() 拿掉,e2e 的 J2 節當場紅(牌寬 22 → 22)。 */
    resetFit(); render();
  }
  /* 有滑鼠 = 一段式(hover 已經給了「是哪一張」的回饋);觸控 = 兩段式。
     ⚠ 一定要跟 styles.css 那條 @media 用同一個字串,否則會出現「牌浮起來卻要點兩次」。 */
  const FINE = (typeof matchMedia==="function")
    ? matchMedia("(hover:hover) and (pointer:fine)") : null;
  function oneTap(){ return !!(FINE && FINE.matches); }

  /* ★ 手機橫向版面(v1.73.0,見檔頭⑥)。同 FINE 那條規矩:
     **字串必須與 styles.css 那條 @media 逐字相同** —— CSS 負責把盤面改成左右分欄,
     這裡負責把牌河讓一排出來,對不上就會出現「預留 3 排的高度、只畫 2 排」的空白。
     ⚠ pointer:coarse 是「只有手機」的關鍵:桌機把視窗拉到又矮又寬也不會命中。 */
  const LAND = (typeof matchMedia==="function")
    ? matchMedia("(orientation:landscape) and (max-height:560px) and (pointer:coarse)") : null;
  function landscape(){ return !!(LAND && LAND.matches); }
  function poolRows(){ return landscape() ? POOL_ROWS_LAND : POOL_ROWS; }
  /* ★★ 橫向「寬裕版」(v1.178.0):牌河的牌與對手明牌各大一號。
     橫向的牌寬上限是**寬度**決定的 → 高度通常有剩(見 fillPool),那一截與其空著,
     不如給「打出去的牌」與「別人攤了什麼」—— 使用者:「其他人吃牌區域顯示卻很小」。
     ⚠⚠ 但它**只在不必付出任何代價時才成立**:render() 先照寬裕版畫一次,塞不下就
       整組退回原本的小尺寸(0.46 / 0.40)。**絕對不可以**讓它去換手牌變小 ——
       實測 660×268(iPhone SE 橫置)寬裕版讓盤面溢出 23px,手牌下緣當場被切掉,
       而那正是整段橫向版面當初存在的理由。
     ⚠ 由 render() 每次重算(它是 paint 的輸入,不是狀態);landscape() 為假時恆為假。 */
  let landBig = false;

  /* ---------- 小工具 ---------- */
  /* inner:牌面之後再疊上去的東西(目前只有宣告視窗的候選小點)。
     ⚠ 刻意做成**真的元素**而不是 ::before,理由只有一個:可測性。
       偽元素沒辦法用 elementFromPoint 驗「有沒有被牌面蓋住」,只驗得到「它存在」——
       實測過那條沒有牙齒(把 z-index 拿掉照樣全綠)。 */
  /* ★ 第二個參數 true = 花牌畫右上角那個編號(春夏秋冬 / 梅蘭竹菊 各 1~4)。
     **只有這一頁傳** —— 花要對上自己的門風才算正花,沒有編號就得先背「春是第幾個」
     (使用者:「沒有那個數字不知道怎麼看台」)。消消樂那邊刻意不傳,見 mj-faces.js。
     ⚠ 這一支是這一頁**唯一**畫牌面的地方(手牌 / 牌河 / 明牌 / 花 / 攤牌全走它),
       所以只要改這一行,八種花牌到處都有編號 —— 不必去每個呼叫點補。 */
  function tileHTML(code, cls, extra, inner){
    const inf = F.info(code);
    return '<div class="m16-tile'+(cls?" "+cls:"")+'" data-suit="'+inf.cls+'"'+
           (extra||"")+' aria-label="'+inf.name+'">'+F.faceHTML(code, true)+(inner||"")+'</div>';
  }
  function backTile(cls){
    return '<div class="m16-tile m16-back'+(cls?" "+cls:"")+'" aria-hidden="true">'+F.backHTML()+'</div>';
  }
  /* 對手張數標籤前面那顆迷你牌背(v1.63.1 之前是 Unicode 的 🀫)。
     ⚠ 不可以用 U+1F000 那一段的字元:只有 🀄 有 emoji 呈現,🀫(U+1F02B)在桌機與手機
       都被畫成一個**空心方框**,看起來就是缺字的豆腐(CLAUDE.md 有這條紅線)。
     ★ 尺寸與框粗由 CSS 的 .m16-cntb 決定 —— 12×16px 下 mj-faces 原本的 stroke-width:3
       換算只有 0.36px(等於看不見),所以那邊用兩層選擇器把它加粗回來。
     ⚠ F 可能是 null(mj-faces.js 沒載到),那時就只留數字,不要整列爆掉。 */
  function cntBack(){
    return F ? '<span class="m16-cntb">'+F.backHTML()+'</span>' : "";
  }
  const codeOf = t => R.codeOf(t);

  /* ---------- ★★ 牌山還剩幾張(v1.104.0)-------------------------------------
     使用者:「我想知道還剩幾張牌,不然突然間就說流局,有點奇怪」。
     (v1.58.3 把盤面頂端的資訊列整條拿掉時,這一格是以「玩的人不看,流局本身就是提示」
      為理由刪掉的 —— 上手之後推翻了:流局來得毫無預告才是真正的問題。)

     ★★ 它是 **position:absolute 的覆蓋層**,不是版面裡的一個元素 —— 這是它唯一
       可以存在的形式。盤面上任何「佔得到高度」的新東西都會讓整副牌小一級
       (檔頭③、還有 discardHint 那條「五個字就從 27 掉到 25」的紀錄)。
       絕對定位 = 不進高度計算 = 牌寬一個 px 都不會動。
     ★ 貼在**牌河的右上角**,位置由 render() 用牌河的實際幾何算(直向牌河是第二塊、
       橫向是 grid 的左欄,CSS 沒有一組 top/left 能同時說對兩種版面)。
     ⚠ 牌河右側因此在 styles.css 保留了一條**等寬的空白**(.m16-pool 的 padding-right):
       牌永遠排不進那條空白,所以這顆晶片不會蓋住任何一張打出去的牌。
       牌河的高度是 board.js 算的 --m16ph、與寬度無關 → 保留那條空白**不影響牌寬**。
     ⚠ 數字要用 MJT.drawsLeft() 而不是 wallLeft():差的正是海底那一墩(見那支的註解)。 */
  const WALL_LOW = 16, WALL_CRIT = 4;      // 變色門檻:亮起來的那一刻每家還摸得到幾張
  function wallHTML(){
    const n = (typeof MJT !== "undefined" && MJT.drawsLeft) ? MJT.drawsLeft(st) : 0;
    const cls = n<=WALL_CRIT ? " crit" : (n<=WALL_LOW ? " low" : "");
    /* ⚠ 「牌山」兩個字不可以省成迷你牌背 + 數字:對手那一列的手牌張數(.m16-cnt)
       用的正是同一顆牌背,只留數字會被看成「某一家手上還有幾張」。 */
    return '<div class="m16-wall'+cls+'" title="牌山還可以摸幾張(摸完就流局)">'+
      '<em>牌山</em><b>'+n+'</b></div>';
  }

  /* ★★ 我的手牌**畫出來的順序**(玩家沒拖過的話就是照牌序)。
     ⚠ 這一支是**唯一**吃 ord 的地方 —— 打牌 / 吃碰槓胡一律走牌值,順序碰不到它們。
     ⚠ 但它有**兩個**呼叫端(render 與 claimOpts),而且兩邊一定要拿到同一份:
       claimOpts() 算出來的 idx 是給畫面用的「第幾格」,對不上就會亮錯牌。 */
  function viewHand(){ return R.applyOrder(st && st.hands ? (st.hands[me]||[]) : [], ord); }

  /* ---------- 手牌分排 ----------
     依花色邊界切,選「算出來的牌寬最大」的切點;摸進來那張放較短的那一排。
     回傳 { rows:[[t…],[t…]], drawRow, tw } */
  function suitGroup(t){ return R.isNumber(t) ? R.suitOf(t) : "z"; }
  function unitsOf(rows, drawRow){
    let u=0;
    rows.forEach((r,i)=>{ u = Math.max(u, r.length + ((i===drawRow) ? 1+DRAW_GAP : 0)); });
    return u;
  }
  /* 這副手牌的**寬度預算** = 兩排最平均分 + 摸進來那一格,★ 只看**張數**。
     牌寬一律用它算(見檔頭⑤):切在哪個花色邊界只影響「哪些牌在哪一排」,不影響大小。
     n=16 → 8/8,摸牌格放短排 → max(8, 8+1.45) = 9.45 單位(492px 寬下 48px)。 */
  function budgetUnits(n){
    const a = Math.ceil(n/2), b = n - a;
    return Math.max(a, b + 1 + DRAW_GAP);
  }
  /* ★ hasDraw 刻意**不參與計算**(v1.58.3):摸牌那一格一律預留。
     算進去的話「我摸了一張」與「我打掉一張」會讓整副牌一大一小輪流跳,
     每一輪來回一次 —— 那就是「一直不停的變換牌的大小」最主要的來源(見檔頭①)。
     參數留著只為了呼叫端讀起來清楚(以及 planFor 的既有測試簽章)。 */
  function planHand(hand, hasDraw, avail){
    // 方案 A:一排(這一支本來就只看張數,穩定)
    const uA = unitsOf([hand], 0);
    const twA = Math.floor(avail / Math.max(1,uA));
    if(twA >= ONE_ROW_MIN) return { rows:[hand], drawRow:0, tw:Math.min(twA, TILE_MAX) };

    // 方案 C:兩排,切在花色邊界
    const bu = budgetUnits(hand.length);
    const groups=[], keys=[];
    hand.forEach(t=>{
      const g = suitGroup(t);
      if(!keys.length || keys[keys.length-1]!==g){ keys.push(g); groups.push([]); }
      groups[groups.length-1].push(t);
    });
    let best=null;
    for(let k=1;k<groups.length;k++){
      const r1=[], r2=[];
      groups.forEach((g,i)=>{ const t=(i<k)?r1:r2; t.push.apply(t,g); });
      const dr = (r1.length<=r2.length) ? 0 : 1;
      const u  = unitsOf([r1,r2], dr);
      if(!best || u<best.u) best = { rows:[r1,r2], drawRow:dr, u:u };   // 最平均的那個切點
    }
    /* 沒有邊界可切(清一色)**或**最好的邊界切法比預算還擠(例如 11/5)→ 拆花色對半分。
       ⚠ 這裡刻意不讓牌寬跟著那種擠法縮:縮下去會被「只縮不放」的地板卡住一整局,
         代價比「一組花色被拆到兩排」大得多(而牌本身仍然照花色順序排,只是換行)。 */
    if(!best || best.u > bu + 1e-9){
      const h=Math.ceil(hand.length/2);
      const rows=[hand.slice(0,h), hand.slice(h)];
      const dr=(rows[0].length<=rows[1].length)?0:1;
      best={ rows:rows, drawRow:dr, u:unitsOf(rows,dr) };
    }
    const tw = Math.floor(avail / Math.max(1, bu, best.u));
    return { rows:best.rows, drawRow:best.drawRow,
             tw:Math.max(TILE_MIN, Math.min(tw, TILE_MAX)) };
  }

  /* ---------- 一組明牌 ----------
     ★ v1.58.2 兩處改法(都是實際上手回報的):
       ①**不再把跟人要來的那張橫放**。真牌桌是靠橫放標「這組是要來的」,但畫成 26~40px
         的小方塊之後,旋轉 90° 的牌面糊成一團,看起來像壞掉的牌而不是資訊。
       ②**吃的那組把要來的那張排到中間**(m.g),位置本身就是記號,不必再轉。 */
  function meldHTML(m, tw){
    let tiles;
    if(m.k==="chow"){
      const seq = [m.t, m.t+1, m.t+2];
      const got = (typeof m.g==="number" && seq.indexOf(m.g)>=0) ? m.g : -1;
      if(got>=0){ const rest = seq.filter(t=>t!==got); tiles = [rest[0], got, rest[1]]; }
      else tiles = seq;                                   // 舊資料沒有 g → 照順子排
    }else{
      tiles = new Array(m.k==="kong" ? 4 : 3).fill(m.t);
    }
    const kind = m.c ? "cc" : m.k;                        // 暗槓自成一類(底色不同)
    return '<span class="m16-meld '+kind+'" style="--m16w:'+tw+'px">'+
      tiles.map((t,i)=>{
        // 暗槓:中間兩張蓋著(真牌桌的擺法 —— 這個記號在小尺寸下依然清楚,保留)
        if(m.k==="kong" && m.c && (i===1||i===2)) return backTile("m16-mt");
        return tileHTML(codeOf(t), "m16-mt");
      }).join("")+'</span>';
  }

  /* ---------- 一組花牌 ----------
     ★ v1.58.3:花牌**畫成真的牌**,和吃 / 碰同一種外框(只換底色成琥珀)。
       原本對手的花牌是一串 Unicode 字符(🀢🀦…),使用者的話是「寫個字在那裡,
       有點沒感覺」—— 而且那些字符在小字級下根本認不出是哪一張花。
     ⚠ 底色一定要寫成兩層 `.m16-meld.m16-flg`:既有的 `.m16-mymelds .m16-meld`
       是 (0,2,0),一層的 .m16-flg 會被它蓋掉(CLAUDE.md 那條「反方向也會撞」)。 */
  function flowerHTML(tiles, tw){
    return '<span class="m16-meld m16-flg" style="--m16w:'+tw+'px" aria-label="花牌">'+
      tiles.map(t=>tileHTML(codeOf(t), "m16-mt")).join("")+'</span>';
  }

  /* 畫面上「輪到誰」——★ v1.65.0。宣告視窗開著時 st.turn 還停在**打牌的人**身上
     (discard 遇到有人能宣告就不換手),沒人能宣告時 turn 早就跳到下一家了 ——
     高亮還在不在出牌者身上,等於直接告訴他「有人吃得下你剛打的那張」。
     連線與單機都適用(「電腦在考慮吃碰」同樣不可以被看出來),所以判斷寫在盤面這一層。
     ⚠ 與 adapter.js 的 dispTurn() 是同一條規則,改一邊要看另一邊(grep dispTurn)。
     ⚠ 搶槓視窗例外:槓完本來就還是加槓的人繼續打。 */
  function shownTurn(){
    if(st.claim && !st.claim.rob) return (st.claim.from + 1) % st.seats;
    return st.turn;
  }

  /* 連莊記號「連N」(v1.108.0)。★ 只有一份,三個地方共用
     (這一支的 foeHTML / adapter.js 的 chipLead / solo.js 的 paintBar)——
     莊家記號本來就是「三個地方同一套」,連莊跟著它走。
     ⚠ streak 是**這一局的**連莊數(0 = 第一次坐莊,不畫)。台數是 2N 台,見 scoring.js。 */
  function lianHTML(streak){
    const n = +streak || 0;
    return n > 0 ? '<span class="m16-lz" title="連 ' + n + ' 拉 ' + n + ',全桌加 ' + (2*n) + ' 台">連' + n + '</span>' : "";
  }

  /* ---------- 對手那一列 ----------
     ★ 莊家的記號放在**每個人自己那一列**(v1.58.3)——原本寫在盤面頂端那條資訊列
       («莊 某某»),但那條整列被拿掉了(可吃 / 牌山對玩的人沒有用)。
       我自己是不是莊,由房間框的玩家晶片講(adapter.chipLead),兩邊同一套記號。 */
  /* 對手那一列的「花 + 明牌」那一格 —— **一格都沒有的時候放一個等高的透明佔位**(v1.111.1)。
     使用者:「如果對手沒有補到花的情況下,最小高度會太小,應該要把他最小高度變成跟
     有補花到的情況一樣,才不會那個框的高度跳來跳去」。

     ★ 同檔頭①「摸進來那一格一律預留」與橫向 `.m16-mymelds` 那條紀律:
       高度的**變化**比高度本身值錢 —— 這一列一長高盤面就矮一點,整副牌跟著縮一次(檔頭③)。
     ★★ 為什麼是**佔位**而不是給 `.m16-fmelds` 一個 min-height:那條要自己算
       「一排迷你牌有多高」,而真正的高度是 `牌高 + .m16-meld 的內距 + 邊框` ——
       第一版寫 `mtw*1.32` 實測還是跳 6px(34 → 40)。**照抄一份真的結構再隱藏起來**
       就不必猜任何數字,CSS 那邊改內距也自動跟著對。
     ⚠ 一律用 `visibility:hidden` 而不是 opacity/透明色:它要**佔高度但完全看不見**,
       而且不可以吃到點擊(同 `.m16-pslot` 那條「一個可見的樣式都不給」)。
     ⚠ class 刻意**不叫 `.m16-flg`** —— e2e 有一條在數「花牌是一組真的牌」,
       佔位混進去就變成「沒人摸到花也說有花」。 */
  function foeShowHTML(seat, fl, mtw){
    const melds = st.melds[seat] || [];
    if(fl.length || melds.length)
      return (fl.length ? flowerHTML(fl, mtw) : "") + melds.map(m=>meldHTML(m, mtw)).join("");
    return '<span class="m16-meld m16-fslot" style="--m16w:'+mtw+'px" aria-hidden="true">'+
             '<i class="m16-tile m16-mt"></i></span>';
  }

  function foeHTML(seat, tw){
    const wind = R.codeOf(MJT.seatWind(seat, st.dealer, st.seats));
    /* ⚠ 張數用**真的** st.turn:宣告視窗中下一家還沒摸牌(16 張),沒人宣告時他早就摸到
       (17 張)—— 這是藏不掉的殘留管道,但刻意不假造。顯示 17 之後若有人碰,那家會從
       17 掉回 16,反而更明顯;而張數要主動去數才看得出來(見 adapter.js renderActs)。 */
    const cnt  = st.hands[seat].length + ((st.turn===seat && st.drawn>=0)?1:0);
    const fl   = st.flowers[seat];
    /* ★★ 明牌 0.52 倍;**只有「橫向而且塞不下」**才收成 0.40(v1.178.0,見 landBig)。
       ⚠ v1.73.0~v1.177.x 橫向一律 0.40,理由是分欄之後對手三家直排在右側窄欄,
         0.52 會把那一欄撐到換行 → 右欄比牌河還高 → 整副手牌反而被夾得更小
         (實測 844×390 卡在 TILE_MIN)。那是「盤面總高只有 ~161px」那個年代的補償。
       ★ 這一版讓它在放得下的機型回到 0.52,靠的是三件事(缺一不可,要改回去一起看):
         ① 右欄放寬到 40vw(styles.css)→ 花 + 兩組明牌照樣排得下,不換行
         ② 剩下的高度由 fillPool() 交給牌河 → 對手那一欄長高幾 px 也吃得下
         ③ **塞不下就整組退回小尺寸**(landBig),絕不拿手牌去換
       使用者回報:「其他人吃牌區域顯示卻很小,這裡的擺放看起來非常的奇怪」。 */
    const mtw  = Math.round(tw*(landscape() && !landBig ? 0.40 : 0.52));
    /* ★ 宣告聽牌是**公開**的(v1.67.0):誰宣告了全桌都要看得到 —— 不然玩家不知道
       該不該小心放槍,那一台就變成偷襲而不是宣告。⚠ 與「誰在考慮吃碰」剛好相反。 */
    const tk = (typeof MJT !== "undefined" && MJT.tingOf) ? MJT.tingOf(st, seat) : null;
    /* ★★ 一局結束就**把每一家的手牌翻開**(v1.75.15)。使用者:「每一局結束的時候,
       我希望能把全部人的牌都顯示出來,不是在勝負頁顯示,而是在牌桌顯示,這樣還可以
       回去看牌桌,看看到底牌在誰那裡」。
       ★ 這是牌情紅線的**唯一**豁免點,而它安全的理由只有一個:`st.over` 有值 =
         這一局已經結束、不會再有任何動作。**判斷式一個字都不能放寬**(不可以改成
         「有人胡了」或「輪次停住」之類的近似條件)。
       ★ 攤開之後結果卡就不再另外畫一次胡牌那家的牌(#m16Win 整塊在這一版拿掉)——
         同一件事在兩個地方畫,正是這一輪在收掉的東西。
       ⚠ 用 revealHTML() 而不是自己拼:胡的那張要標紅框、明牌 / 暗槓 / 花牌的排法
         都在那一支裡,拼第二份一定走鐘(它原本就是為結果卡寫的,現在換這裡用)。 */
    const over = st.over;
    const shown = !!over;
    const winT = (over && over.type==="win" && over.seat===seat) ? over.tile : undefined;
    return '<div class="m16-foe'+(shownTurn()===seat?" on":"")+(tk?" ting":"")+
             (shown?" shown":"")+'" data-seat="'+seat+'">'+
      '<span class="m16-wind">'+F.info(wind).glyph+'</span>'+
      /* ★ 連莊(v1.108.0):莊家記號後面接「連N」= 連 N 拉 N,全桌加 2N 台。
         三個地方都要畫(這裡 / adapter.chipLead / solo.paintBar)—— 那三支是同一套記號。 */
      (seat===st.dealer?'<span class="m16-dz">莊</span>'+lianHTML(st.dealerStreak):'')+
      (tk?'<span class="m16-tg">'+(TING_LBL[tk]||"聽")+'</span>':'')+
      '<span class="m16-foename" data-seat="'+seat+'"></span>'+
      // 攤開之後不再寫「🀫 N」:牌就在旁邊,而牌背的圖示反而像「還是蓋著的」
      (shown ? "" : '<span class="m16-cnt">'+cntBack()+cnt+'</span>')+
      '<span class="m16-fmelds">'+
        (shown
          ? revealHTML(st, seat, mtw, winT)
          : foeShowHTML(seat, fl, mtw))+
      '</span>'+
    '</div>';
  }

  /* ---------- 攤牌(結果卡用,v1.58.4)----------
     把某一家的牌整組畫出來:手牌(含胡的那張,標記)+ 明牌 + 花。
     使用者:「如果別人胡了,我覺得應該要顯示出胡的人是什麼牌」——
     牌桌上別人的手牌永遠是 🀫 N,一局結束時沒有任何地方看得到他到底胡了什麼牌。

     ★ 做成 M16B 的一支 export、而不是在 adapter 裡拼字串:牌面、明牌的排法
       (吃到的那張排中間、暗槓中間兩張蓋著)、花牌的外框全部在這裡,
       兩個地方各寫一份一定會走鐘。
     ⚠ 胡的那張用**索引**標記不是牌值 —— 手上有一對時拿牌值比會兩張都亮
       (v1.58.0 那個「一對牌一起站起來」的同一個坑)。

     ── 胡的那張:**就標在原位**,不要搬家(v1.75.17 走回頭路的教訓)────────────
       v1.75.16 曾經把它抽出來自成一組 + 掛「胡」的小標(真牌桌的慣例),
       使用者的回覆是「這樣更糟,我是希望你把那個紅框畫清楚就可以了」。
       ★ 這件事本來就只是**框沒畫乾淨**:牌距只有 1px,而紅框往外畫 3px
         (`outline:2px` + `outline-offset:1px`)→ 壓在左右兩張牌上、又被後畫的
         鄰居蓋掉一角,看起來才像貼歪的貼紙。**病灶在 CSS,不在排法** ——
         修法是給那張牌讓出位置 + 疊到上層(見 styles.css 的 `.m16-mt.m16-wt`)。
       ⚠ 不要再「順手」把它搬出來一次:牌在原位才看得出它是**手牌的第幾張**,
         那正是攤牌要回答的問題。 */
  function revealHTML(state, seat, tw, winTile){
    const s = state || st;
    if(!s || !s.hands || !s.hands[seat]) return "";
    const hand = s.hands[seat].slice().sort((a,b)=>a-b);
    const mark = (typeof winTile==="number") ? hand.indexOf(winTile) : -1;
    const parts = [];
    if(hand.length)
      parts.push('<span class="m16-meld m16-hg">'+
        hand.map((t,i)=>tileHTML(codeOf(t), "m16-mt"+(i===mark?" m16-wt":""))).join("")+'</span>');
    (s.melds[seat]||[]).forEach(m=>parts.push(meldHTML(m, tw)));
    if((s.flowers[seat]||[]).length) parts.push(flowerHTML(s.flowers[seat], tw));
    return '<div class="m16-reveal" style="--m16w:'+tw+'px">'+parts.join("")+'</div>';
  }

  /* ---------- 「我宣告的聽牌」那一排(v1.66.0 起,v1.67.0 改成只在宣告後出現)----------
     ★★ v1.67.0 的關鍵改動:**只有我自己按過「宣告聽牌」才畫**。
       v1.66.0 那版是系統自動偵測到聽牌就畫 —— 那時「它有沒有出現」本身就是牌情
       (CLAUDE.md 那條第 6 管道)。現在宣告是**公開動作**,它的存在洩漏不了任何東西。
     ★ 但**聽哪幾張仍然只有自己看得到**:別人只知道我宣告了,不知道我聽什麼。
     ★ 給**牌**不給牌名:使用者在 v1.58.3 為對手的花牌講過「寫個字在那裡,有點沒感覺」,
       牌面一開始就決定自繪正是為了這種地方(也順手守住「不准用 Unicode 麻將字元」那條)。
     ⚠ 牌寬**寫死** 20px,不跟著盤面的 tw 走:這一排在 .m16-acts 裡,而動作列一長高
       盤面就變矮、整副牌跟著縮一次(檔頭③那條紅線)。20px → 26px 高 + 內距 = 30px,
       塞得進 .m16-acts 原本的 min-height:38px → 動作列高度完全不變。
     ⚠ 20 是**放大截圖比對**出來的(第一版寫 16px,和牌河最小的牌同級 —— 放大 3 倍認得出,
       原尺寸卻要瞇著眼看,而這一排的全部價值就是「一眼看出聽什麼」)。同 v1.64.0 那條
       迷你牌背的教訓:縮到很小還認不認得出來,斷言測不到,只有放大截圖看得出來。
     ⚠ 最多列 READY_MAX 張,其餘寫成「+N」—— 寬度有上限,動作列才不會被一長排牌推到換行
       (換行 = 動作列長高 = 整副牌縮一次)。
     ⚠ 宣告後**槓牌**是允許的(明星三缺一的規則),槓完聽的牌可能變 → 這一排會跟著更新,
       甚至可能變成「一張都不聽」。那時只留標籤(不要整排消失 —— 宣告的事實還在)。 */
  const READY_TW = 20, READY_MAX = 5;
  const TING_LBL = { normal:"聽", di:"地聽", tian:"天聽" };
  function readyHTML(state, seat){
    const s = state || st;
    if(!s || !F || !R || typeof MJT === "undefined" || !(seat >= 0)) return "";
    const kind = MJT.tingOf ? MJT.tingOf(s, seat) : null;
    if(!kind) return "";                                 // 沒宣告 → 什麼都不畫
    const w = MJT.tenpaiNow(s, seat);
    const show = w.slice(0, READY_MAX);
    return '<span class="m16-ready" style="--m16w:'+READY_TW+'px" aria-label="已宣告聽牌">'+
      '<b>'+(TING_LBL[kind]||"聽")+'</b>'+show.map(t=>tileHTML(codeOf(t), "m16-mt")).join("")+
      (w.length > show.length ? '<i>+'+(w.length-show.length)+'</i>' : '')+
    '</span>';
  }

  /* ---------- 宣告聽牌選牌時,「打了這張會聽哪張」的即時預覽(v1.127.0) ----------
     使用者:「按宣告聽牌,選擇要打出一隻牌時,希望可以同步看到,會聽哪張」。
     ★ 借用既有兩段式點擊的第一段(牌浮起來、還沒送出)當預覽時機,不必新增手勢 ——
       tap() 第一次點只是把 sel 抬起來,這裡多記一個 tingSelTile 就問得到 MJT.tenpaiAfter()。
     ⚠ 滑鼠(oneTap)一點就直接送出宣告,沒有「浮起來」那個中間狀態可以借,
       所以這一支天然只服務觸控裝置 —— 與整頁「滑鼠沒有兩段式」的既有不對稱一致。
     ⚠ 樣式整支照抄 readyHTML():20px / 最多 READY_MAX 張 / 同一顆 .m16-ready,
       那份尺寸早就量過塞得進 .m16-acts 的 min-height,另起一套等於重新踩一次
       檔頭③「任何讓總高變一點的東西都會讓整副牌換一次大小」那條紅線。 */
  function tingPreviewHTML(){
    if(!tingPick || tingSelTile<0 || typeof MJT==="undefined" || !MJT.tenpaiAfter || !st) return "";
    const w = MJT.tenpaiAfter(st, me, tingSelTile);
    if(!w.length) return "";
    const show = w.slice(0, READY_MAX);
    return '<span class="m16-ready" style="--m16w:'+READY_TW+'px" aria-label="打這張後會聽">'+
      '<b>會聽</b>'+show.map(t=>tileHTML(codeOf(t), "m16-mt")).join("")+
      (w.length > show.length ? '<i>+'+(w.length-show.length)+'</i>' : "")+
    '</span>';
  }

  /* ==========================================================================
     ★★ 宣告面板 —— 吃 / 碰 / 槓 / 胡 **跳在盤面中間**(v1.111.0)
     ──────────────────────────────────────────────────────────────────────────
     使用者:「如果今天可以吃碰槓胡,可以改成跳出在中間,但要帥氣一點然後決定,
     大家都反應在最下面很不明顯」。舊版三顆鈕住在畫面最底那條 .m16-acts 裡 ——
     那一列平常寫的是「輪到 ○○…」,眼睛早就學會不看它了,而吃碰只有幾秒。

     ★ 這一份是**單機與連線共用**的(同 readyHTML / rankHTML 那幾支)——
       兩邊的 renderActs() / paintActs() 各自呼叫,面板本身只有一份。

     ★★★ 四條紅線,少一條就會壞掉:

     ① **面板是 `#m16Acts` 的子元素,而且 position:absolute。**
        · 子元素 → e2e 那一整批 `#m16Acts .m16-act.pass` 的後代選擇器照樣命中
          (搬到 .mj-play 底下就要改十幾條斷言,而那些斷言本身沒有錯)。
        · absolute → **完全不進 flex 流**,動作列的高度一個像素都不變。
          動作列一長高盤面就矮一點、整副牌跟著縮一次(檔頭③那條紅線);
          面板有一百多 px 高,放進流裡等於每次有人打牌都把牌縮一級。
        · 定位基準是 `.mj-play`(styles.css 給它 position:relative)——
          不是盤面 `.m16-stage`:那是 overflow-y:auto 的捲動容器,面板會被裁掉一角。

     ② **面板是持久節點,但一律從 DOM 找回來,不可以拿模組變數快取。**
        離房 / 回選單走的是 `box.innerHTML = ""`(adapter 的 wipeActs / solo 的 quit),
        面板會連同倒數環一起被丟掉 —— 快取住的話下次進房那顆面板永遠不再出現
        (adapter 的 cdEl 就是這樣踩過一次,見那邊的註解)。
        持久是為了**進場動畫只播一次**:renderActs() 在宣告視窗開著的幾秒內會被叫
        很多次(別人表態、我切換吃法、ResizeObserver),每次重建就是每次重播 = 閃爍。

     ③ **關掉的時候一定要清掉 body 的內容**,不可以只加 .hidden ——
        「視窗關掉之後吃碰 / 過的按鈕都收掉了」是 e2e 真的在驗的一條,
        而 querySelector 找得到隱藏起來的按鈕。清空同時也是防誤按的最後一道。

     ④ **`--m16cb` 是「面板底邊離 .mj-play 底部多遠」**,由 placeClaim() 每次算:
        目標是**貼在手牌上緣之上 8px** —— 面板不可以蓋住手牌,因為「換一組吃法」
        是點手牌完成的(見上面 cycleTo)。蓋住牌河沒關係:別人打的那張牌
        本來就放大畫在面板上了。
        ⚠ 倒數環(.m16-cd)在宣告期間也吃這個變數飛到面板下緣 —— 見 styles.css
          的 .m16-acts.m16-hush;**環的 DOM 一個字都不准動**(移動節點 = CSS 動畫
          重跑 = 倒數彈回滿格,adapter 的 ensureCd() 整段都在講這件事)。
     ========================================================================== */
  const CLAIM_TW = 42;            // 面板上那張「別人打出來的牌」有多寬(自繪)
  const CLAIM_TW_LAND = 30;       // 橫向手機:盤面只有 ~161px 高,牌與按鈕都收一號

  function panelOf(box){ return box ? box.querySelector(".m16-claim") : null; }

  /* ★ 明牌那一組的中文字面(v2.3.4)—— 單機與連線都要報「○○ 碰!」,而那句話是
     **同一句**,所以字面只放這一份(兩份輪次驅動刻意分家,字面沒有理由跟著分)。
     ⚠ 鍵是明牌的 `k`(碰是 **pung**),不是宣告類型的 `pong` —— 兩套詞彙,見 claimPanel。 */
  const MELD_WORD = { chow:"吃", pung:"碰", kong:"槓" };
  function meldWord(k){ return MELD_WORD[k] || k; }

  /* 收掉面板。★ 冪等 —— 已經關著就什麼都不做(否則每次 renderActs 都會重播進場動畫)。 */
  function hideClaim(box){
    if(box) box.classList.remove("m16-hush");
    const p = panelOf(box);
    if(!p || p.classList.contains("hidden")) return;
    p.classList.add("hidden");
    p.classList.remove("m16-in");
    const b = p.querySelector(".m16-cbd");
    if(b) b.innerHTML = "";                              // 見紅線③
  }

  /* 面板該擺在哪(見紅線④)。⚠ 一定要在面板已經可見之後才叫 —— offsetHeight 要量得到。
     ★ 同時把面板高度寫成 --m16ch:倒數環要靠它貼到**面板上緣**(styles.css 的 m16-hush)。
       ⚠ 環刻意不貼下緣:下緣外面就是手牌,那 34px 會壓在手牌最上面一排 ——
         而宣告的時候手牌正是要點的東西(換一組吃法)。上緣外面是牌河,點它沒有任何作用。 */
  function placeClaim(box, p){
    const par = p.offsetParent;
    if(!box || !par) return;
    const pr = par.getBoundingClientRect();
    const ph = p.offsetHeight || 120;
    let bottom = Math.round(pr.height * 0.36);           // 量不到手牌時的退路
    const hand = host && host.querySelector(".m16-hand");
    if(hand){
      const hr = hand.getBoundingClientRect();
      bottom = pr.bottom - hr.top + 10;                  // 貼在手牌上緣之上
    }
    /* 夾在**整片對局區**裡:太高會衝出盤面上緣(橫向手機盤面只有 ~161px),太低會壓到手牌。
       ⚠⚠ v1.176.0:夾取的基準從 `pr`(offsetParent)換成 `.mj-play` ——
         動作列改成絕對定位之後,`p.offsetParent` 就是**動作列自己**,而它只有一條明牌
         那麼高(34~55px)。拿它的 height 去夾,`pr.height - ph - 4` 永遠是負的
         → 夾完永遠是下限 6px,面板從此貼在明牌帶上、整個夾取形同虛設。
         ★ `--m16cb` 仍然是「離 offsetParent 底邊多遠」(CSS 那邊一個字都沒改,
           倒數環 .m16-acts.m16-hush 吃的也是同一個值)—— 所以這裡是**換算過去夾、
           再換算回來**,不是改變那個變數的意思。 */
    const play = host && host.parentNode;                // .mj-play(#m16Play)
    const vr = play ? play.getBoundingClientRect() : pr;
    const off = vr.bottom - pr.bottom;                   // offsetParent 底邊離對局區底邊多遠
    let vb = bottom + off;                               // 面板底邊離**對局區**底邊多遠
    vb = Math.max(6, Math.min(vb, Math.max(6, vr.height - ph - 4)));
    bottom = vb - off;
    box.style.setProperty("--m16cb", Math.round(bottom) + "px");
    box.style.setProperty("--m16ch", Math.round(ph) + "px");
  }

  /* 畫 / 更新面板。info:
       { tile, who, opts, cur, canWin, onTake, onWin, onPass }
     ⚠ 按鈕一律用 createElement + addEventListener(不是 innerHTML 拼字串):
       名字與牌名都是使用者資料,拼進 HTML 就要自己記得 esc。 */
  function claimPanel(box, info){
    if(!box || !info) return;
    let p = panelOf(box);
    if(!p){
      p = document.createElement("div");
      p.className = "m16-claim hidden";
      p.setAttribute("role", "group");
      p.setAttribute("aria-label", "吃碰槓胡");
      p.innerHTML = '<div class="m16-cbd"></div>';
      box.appendChild(p);
    }
    const b = p.querySelector(".m16-cbd");
    if(!b) return;
    const fresh = p.classList.contains("hidden");        // 這一次是「跳出來」還是「更新內容」
    b.innerHTML = "";

    /* --- 標頭:誰打出了什麼(兩者都是公開資訊 —— 牌河上本來就看得到) --- */
    const hd = document.createElement("div");
    hd.className = "m16-chd";
    const tw = landscape() ? CLAIM_TW_LAND : CLAIM_TW;
    if(F && R && typeof info.tile === "number")
      hd.innerHTML = '<span class="m16-cbig" style="--m16w:'+tw+'px">'+
                     tileHTML(codeOf(info.tile), "m16-ct")+'</span>';
    const wt = document.createElement("b");
    wt.textContent = (info.who || "別人") + " 打出";
    hd.appendChild(wt);
    b.appendChild(hd);

    /* --- 按鈕:★★★ 每一組選項各一顆(v1.118.1)+ 胡! + 過 ------------------------
       ⚠⚠⚠ v1.111.0~v1.118.0 只畫**一顆** ✔(目前那一組),要換組得去點手牌。
         選項的排序是 槓 → 碰 → 吃(見 claimOpts),所以**只要能碰,預設就永遠是碰,
         畫面上一顆「吃」都沒有** —— 使用者回報的「吃這個功能不見了,明明可以吃的,
         但沒跳出來」就是這個。實測 4 人局 611 個宣告視窗裡有 30 次撞到。
       ★ 當年(v1.58.2)否決「吃 三四 / 吃 四五 / 碰 / 過」那一排按鈕的理由是
         **「文字要玩家自己在腦中對回手牌」**;現在標籤畫的是**自繪牌面**,
         那個理由已經不成立 —— 所以這一排回來了,而且比舊版更好認。
       ★ 手牌上「站起來的那一組」仍然由 copt 決定、點手牌照舊可以換 ——
         那是**預覽**(哪兩張會被拿走),不再是唯一的選擇途徑。有框的那顆鈕就是它。
       ★ 「過」永遠在最後、永遠在(使用者當初的要求);「胡!」金色脈動最顯眼。
       ⚠ 分兩列:選項一列、胡 / 過一列 —— 選項最多 5 組(槓+碰+3 種吃法),
         擠在同一列時「過」的位置會隨選項數量跳來跳去。 */
    /* html 是**自己產生的**(固定的字 + tileHTML),沒有任何使用者資料 —— 名字那一格
       走的是上面的 textContent。⚠ 要在這裡加任何外來字串之前,先想清楚 esc。 */
    const mk = (into, html, cls, fn) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "m16-act" + (cls ? " " + cls : "");
      btn.innerHTML = html;
      btn.addEventListener("click", fn);
      into.appendChild(btn);
      return btn;
    };
    /* ★ 「碰哪兩張」給**牌面**不給牌名(v1.111.0)—— 同「已宣告聽牌」那一排的理由:
       自繪牌面一開始就是為了這種地方,而「5萬5萬」四個字要在腦裡再翻譯一次。
       ⚠ 20px 是 READY_TW 那條驗過的下限(16px 放大三倍認得出、原尺寸要瞇眼)。 */
    const tilesHTML = (ts, tw) => (F && R)
      ? '<span class="m16-cmt" style="--m16w:'+(tw || READY_TW)+'px">'+
        ts.map(t=>tileHTML(codeOf(t), "m16-mt")).join("")+'</span>'
      : ts.map(t=>F.info(codeOf(t)).name).join("");

    const co  = info.opts || [];
    const cur = info.cur;
    /* ★★ 選項一多就整組收一號(v1.118.1)。最多會有 5 組(槓 + 碰 + 3 種吃法),
       每一顆鈕都帶著自繪牌面 → 在 380px 的面板裡一顆佔一整列,面板長到
       **蓋住手牌**(實測 520×780 的 5 組:面板底緣到手牌上緣 -6px)。
       ⚠ 這一條不可以改成「蓋到就算了」:宣告的時候你正需要看自己的手牌,
         而且手牌上還標著「這一組會拿走哪兩張」。 */
    const many = co.length >= 3;
    p.classList.toggle("m16-many", many);
    const lblTw = many ? 16 : READY_TW;
    if(co.length){
      const opts = document.createElement("div");
      opts.className = "m16-crow m16-copts";
      co.forEach((o, i) => {
        /* ⚠ 這裡的鍵是**宣告類型**(pong),與明牌的 k(pung)是兩套詞彙 —— 別跟
           meldWord() 併成一張表,併了就會有一邊查不到而印出英文。 */
        const lbl = { chow:"吃", pong:"碰", kong:"槓" }[o.type] || o.type;
        mk(opts, "✔ " + lbl + tilesHTML(o.tiles, lblTw),
           "take" + (o === cur ? " on" : ""),
           function(){ if(info.onTakeAt) info.onTakeAt(i); });
      });
      b.appendChild(opts);
    }
    const row = document.createElement("div");
    row.className = "m16-crow";
    if(info.canWin) mk(row, "胡!", "win", info.onWin || function(){});
    mk(row, "過", "pass", info.onPass || function(){});
    b.appendChild(row);

    /* --- 不只一組 → 說一次「手牌上亮的是哪一組」(有框的那顆鈕就是它) --- */
    if(co.length > 1 && cur){
      const n = document.createElement("div");
      n.className = "m16-more";
      n.textContent = "手牌上站起來的是第 " + (co.indexOf(cur) + 1) + " / " + co.length +
                      " 組 · 點手牌可以換";
      b.appendChild(n);
    }

    box.classList.add("m16-hush");                       // 倒數環跟著飛上來(見 styles.css)
    p.classList.remove("hidden");
    if(fresh){                                           // 只有真的「跳出來」那一次才播動畫
      p.classList.remove("m16-in");
      void p.offsetWidth;
      p.classList.add("m16-in");
    }
    placeClaim(box, p);
  }

  /* ==========================================================================
     渲染
     ========================================================================== */
  function render(state, mySeat){
    /* ⚠ 有新狀態進來就把選項快取丟掉。不能只靠下面那個簽章 ——
       「我表態完了」改的是 claim.bids,牌與 claim.t 都沒變、簽章一樣,
       快取留著的話牌會繼續站在那裡等你點。 */
    if(state){ st = state; opts = null; }
    if(typeof mySeat==="number") me = mySeat;
    if(!st || !host) return;

    /* ★★ 拖曳中一律**不重畫**(v1.82.0,見最後一節)。這一頁比大老二更需要這道閘門:
       下面夾牌寬那一段會在**一次 render() 裡**把 host.innerHTML 重建最多七次,
       手指底下那個節點一被銷毀,手勢當場斷掉(連線時對手一打牌就走到這裡)。
       ⚠ 延後是安全的,而理由要記住:**我的手牌只可能因為我自己打牌 / 吃碰槓而改變**,
         而那三件事都不可能發生在拖曳途中 —— 這裡不會顯示過期的手牌,
         最多讓牌河晚幾百毫秒更新。放手時由 endDrag() 補畫一次。
       ⚠⚠ 動作列**不吃這道閘門**:宣告視窗(吃 / 碰 / 胡 / 過)與它的倒數是有時限的,
         拖曳中把那幾顆鈕藏起來等於直接吃掉玩家的一手。onClaimUI 照舊發出去 ——
         它只用到選項的 type / tiles / label,與畫面上的格位無關。 */
    if(drag){
      drag.dirty = true;
      if(cb.onClaimUI) cb.onClaimUI(claimOpts(), copt);
      return;
    }

    const box = host.clientWidth || 360;
    const avail = Math.max(200, box - 16);
    /* ★★ 我自己胡的那張:**不併進手牌,擺回「摸進來那一格」**(最右邊,v1.75.18)。
       使用者:「這把是我胡了…沒有顯示出來我胡那張牌,如果是自己胡的,請不要把牌
       放進去,放在最右邊就好了,然後還是要用紅色框給包起來」。
       ★ 為什麼這裡的處理與對手那一列**相反**(那邊是留在原位加框):打牌的時候
         摸進來那張本來就單獨站在最右邊,胡的那一張正是它 —— 放回原本的位置才是
         「一路看下來沒有跳掉」。對手那一列從來沒有這一格,抽出來反而變陌生。
       ⚠ `settleWin()` 會把胡的那張**收進 `st.hands[seat]` 並排序**(牌張守恆),
         所以這裡要自己撿回來,而且一定要用**索引**移除 —— 手上有一對時
         `filter(t => t !== win)` 會整對消失。 */
    /* ★ 畫的順序走 viewHand()(玩家沒拖過的話它就是照牌序)。
       ⚠ 只有這一行與 claimOpts() 吃 ord —— 送去規則層的一律是 st.hands[me] 本身。 */
    let hand = viewHand(), myWin = -1;
    if(st.over && st.over.type==="win" && st.over.seat===me && typeof st.over.tile==="number"){
      const wi = hand.indexOf(st.over.tile);
      if(wi >= 0){ hand.splice(wi,1); myWin = st.over.tile; }   // viewHand() 已經是新陣列
    }
    // 摸進來那一格:平常是 drawn,結算時換成我胡的那張(兩者不會同時存在)
    const hasDraw = (st.turn===me && st.drawn>=0) || myWin>=0;
    const plan = planHand(hand, hasDraw, avail);

    /* ---- 只縮不放(見檔頭④)----
       同一局裡牌寬只會變小 —— 攤了明牌縮下去,不會在下一手又彈回去。
       ⚠ v1.70.1:地板**不再看容器尺寸**(舊版拿「寬 × 高」當 key,一變就重量)——
         盤面變矮的原因分不出來,結果是每一手放一次、收一次(見上面 fitTw 的註解)。
         真的該重量的三個時機由 resetFit() 明確驅動:換局 / 離房 / 視窗 resize。
       牌寬另外對齊到 2px:量到的寬度偶爾差 1px(捲軸 / 四捨五入),沒有這一步
       會為了 1px 重畫一次整副牌。 */
    const hh = host.clientHeight;
    let tw = plan.tw - (plan.tw % 2);
    if(fitTw) tw = Math.min(tw, fitTw);

    /* 手牌一動(打出 / 被吃碰 / 補花 / 換局)格位鍵就位移了 → 舊的 sel 會指到別張牌。
       tap() 自己觸發的 render() 不會走進來(st 沒變 → 簽章相同),選取因此留得住。
       ⚠ 宣告視窗也要進簽章:同一副手牌、換一張別人打的牌,選項整組不一樣。 */
    const cl = st.claim;
    const sig = me+"|"+hand.join(",")+"|"+(hasDraw?st.drawn:"")+
                "|"+(cl?cl.t+"@"+cl.from:"");
    if(sig!==lastSig){ lastSig=sig; sel=""; copt=0; tingSelTile=-1; }   // 換一張別人打的牌 → 選項從第一組重來

    const canAct = MJT.ownActions(st, me).discard;
    const co = claimOpts();                              // 宣告視窗:可吃 / 碰 / 槓的組合
    if(co.length) copt = Math.min(copt, co.length-1);

    /* ⚠ 這道量測的前提是「scrollHeight 講的是**內容**有多高」,所以橫向那邊的空白
       只能用 `align-content` 去擺位置,**不可以**放一條 1fr 的彈性列去吸收
       (吸收 = scrollHeight 恆等於 clientHeight = 下面兩點量測拿到同一個值,S 變垃圾;
        v1.73.1 試過,連「量測時暫時把它收成 0」都救不回來)。詳見 styles.css 那一段。 */
    let cur = tw;
    /* ⚠⚠ 名字要在**量高度之前**填進去(v1.178.0)。paint() 只畫得出空的 `.m16-foename`
       (名字由外面餵,見 paintNames),而橫向的對手那一列是 `flex-wrap:wrap` ——
       名字一填就可能把明牌擠到第二行,那一家立刻高一倍。名字填在量測之後的話,
       這裡量到的每一個數字都是**沒有名字**的版本:
         · 下面那道牌寬夾取會低估總高(舊有的坑,只是以前沒人量到)
         · 這一版的「寬裕版塞不塞得下」會整個判斷錯 —— 實測 660×268 判成塞得下,
           填完名字溢出 23px,手牌下緣被切掉。
       ⚠ 因此 render() 收尾**不再另外叫一次 paintNames()**(每次 draw 都做過了)。 */
    const draw = t => {
      cur = t;
      host.innerHTML = paint(plan, t, hasDraw, canAct, co, myWin);
      paintNames();
      return host.scrollHeight;
    };
    /* ★★ 橫向寬裕版:先照「牌河與對手明牌各大一號」畫一次,**塞不下就整組退回**
       (見上面 landBig)。順序很重要 —— 這一步排在下面那道牌寬夾取**之前**:
       放大對手明牌與牌河永遠不可以拿手牌的尺寸去換,所以先把它降級,再讓夾取
       用同一組(小)尺寸去算,不然那條直線會為了「養大對手那一欄」而把手牌砍小。
       ⚠ 一局結束(攤牌)不參與:那時整桌的牌都翻開,本來就該捲(見下面那條),
         降級救不了溢出,只會讓攤開的牌在結算那一刻縮一次。 */
    landBig = landscape();
    let h1 = draw(tw);
    if(landBig && !st.over && hh > 80 && h1 > hh + 2){ landBig = false; h1 = draw(tw); }

    /* ★★ 高度也要夾(v1.58.2)——「碰完牌就消失了」的真正機制在這裡。
       牌寬原本只受**寬度**約束,但每攤一組明牌就多出一整排(0.82×tw×1.32 ≈ 半張牌高),
       盤面塞不下時手牌就被擠出可視範圍 —— 使用者看到的是「牌不見了」。

       ⚠ 不能用「照比例縮一次」了事:總高度裡有**不隨牌寬變**的部分(對手列的 11px 字與
         內距),縮 20% 牌寬並不會讓總高度縮 20%。所以取兩點解一條直線:
           H(tw) = fixed + S × tw
         量 tw 與 0.7×tw 兩次,解出 S 與 fixed,直接算出塞得下的牌寬。
       ⚠ 直線只是近似(明牌 / 對手列會換行,是階梯不是直線),所以後面再收兩次保險。
       ⚠ clientHeight 太小(面板還沒顯示)時整段不做,否則會一路縮到 TILE_MIN;
         顯示出來時 ResizeObserver 會再叫一次 render()。 */
    /* ⚠ 一局結束就**不再重新夾牌寬**(v1.75.15):那一刻對手列會整排翻開手牌,
       總高度暴增 → 這一段會把整副牌狠狠縮一次,而使用者看到的是「結算時牌忽然變小」
       (檔頭④那條紅線的反面)。盤面本來就是 overflow-y:auto,長高就捲,不必縮。
       下一局的 resetFit() 會重新量,所以也不會把這個凍結的值背著走。 */
    if(!st.over && hh > 80 && h1 > hh + 2 && tw > TILE_MIN){
      const t2 = Math.max(TILE_MIN, Math.round(tw * 0.7));
      let nt = t2;
      if(t2 < tw){
        const h2 = draw(t2);
        if(h1 > h2){
          const S = (h1 - h2) / (tw - t2);          // 牌寬每 1px 帶來多少總高度
          const fixed = h1 - tw * S;                // 不隨牌寬變的那一截
          nt = Math.floor((hh - 2 - fixed) / S);
        }
      }
      nt = Math.max(TILE_MIN, Math.min(tw, nt));
      if(nt !== t2) draw(nt);
      let guard = 0;
      while(host.scrollHeight > hh + 2 && nt > TILE_MIN && guard++ < 3){
        nt = Math.max(TILE_MIN, Math.floor(nt * 0.92));
        draw(nt);
      }
      /* ★ 往回撿(v1.73.0)—— 上面那條直線在**分欄**的橫向版面下會低估。
         橫向的總高是 `max(左欄, 右欄) + 明牌 + 手牌` 的**階梯**,不是一條直線:
         實測 915×412 只超出 11px,卻被外推一路砍到 31px(而 44 明明塞得下)。
         所以在「已確定塞得下的 nt」與「原本想要的 tw」之間二分最多三次,把砍過頭的撿回來。
         ⚠ 這是**同一次 render 內**的收斂,跟「只縮不放」的地板是兩回事:
           地板管的是跨 render 不准變大,這裡是「這一次到底畫多大」還沒定案。
         ⚠⚠ **只有橫向走這一段**。直向與桌機空間夠時根本進不到外層那個 if(內容沒溢出),
           但把視窗拉到又矮又寬(例如 e2e 的 750×485)還是會進來 —— 那裡的階梯沒有橫向陡,
           線性外推本來就夠準,而多跑二分會讓牌寬在一局裡**多縮兩次**(L 段實測 1 → 3 次)。
           「只縮不放」仍然成立,但縮的次數本身就是使用者看得到的變化,不該去動它。
           實測前後不變:390×844 = 50px、1280×900 = 54px、750×485 縮 1 次。 */
      if(landscape()){
        let lo = nt, hi = tw, g2 = 0;
        while(hi - lo > 1 && g2++ < 3){
          const mid = lo + Math.floor((hi - lo) / 2);
          if(draw(mid) <= hh + 2) lo = mid; else hi = mid;
        }
        if(cur !== lo) draw(lo);
      }
    }
    /* 記住這個容器尺寸下的牌寬(只縮不放的地板)。
       ⚠ 暖身期內只畫不記 —— 那幾幀量到的高度還不可信(見上面 WARM_MS 那段)。 */
    if(!st.over && hh > 80 && !(warmUntil && Date.now() < warmUntil)) fitTw = cur;

    const pool = host.querySelector(".m16-pool");

    host.classList.toggle("m16-myturn", canAct);
    if(cb.onClaimUI) cb.onClaimUI(co, copt);             // 動作列跟著換(✔ / 胡 / 過)
    fillPool(pool);                                      // ★ 橫向:剩下的高度交給牌河(見那一支)
    /* 牌河高度寫死成 POOL_ROWS 排 → 打超過就要捲,而**最新那張永遠得看得見**。
       ⚠ 一定要排在 fillPool() **之後**:那一支會把牌河加高,加高之後該捲多少就變了。 */
    if(pool) pool.scrollTop = pool.scrollHeight;
    placeWall(pool);                                     // ★ 一定是最後一步,見那一支
    placeActs();                                         // ★ 動作列的落點,理由同上(見那一支)
    /* ★ 摸牌動畫的旗標在這裡熄掉(v2.3.3)—— 一定要等**整段 render 跑完**:
       上面那道牌寬夾取會重建這一段最多七次,中途熄掉的話只有第一次重建帶得到
       class,而活到最後的是最後一次那份 → 畫面上等於沒有動畫。
       ⚠ 落桌那一顆(v2.4.0)同一個理由、同一個位置,兩顆一起熄。 */
    drawFx = false;
    dropFx = false;
  }

  /* ---------- 橫向:把「沒人吃得掉」的那一截高度交給牌河(v1.178.0)-------------
     使用者:「中間整個區域,有一大片的地方是空白的,然後其他人吃牌區域顯示卻很小,
     這裡的擺放看起來非常的奇怪」。

     ── 那一片空白是什麼 ──────────────────────────────────────────────────────
     橫向的牌寬**上限是寬度決定的**(803×344 實測:一排 17 張剛好排滿 → tw = 44,
     已經是這個寬度的極限),所以螢幕比較高 / 進了全螢幕時,盤面剩下來的高度
     **沒有任何一塊會去用它** —— 量出來閒著 53px,而 `.m16-stage` 是
     `align-content:safe end` → 那 53px 全部堆在房間框與牌河之間,看起來就是
     「盤面整個沉在下面、上面掛著一大塊黑」。

     ── 為什麼是「量出來再寫死」,不是一條 1fr 的彈性列 ───────────────────────
     ⚠⚠ styles.css 那一段記著:用 `minmax(0,1fr)` 去吸收剩餘空間會讓 `scrollHeight`
       恆等於 `clientHeight` → render() 那道「量 tw 與 0.7×tw 兩點解一條直線」的
       牌寬夾取當場失效(兩個點被鉗在同一個值),牌寬開始在 30/36/38 之間跳。
     ★ 這一支安全的理由有兩個,少一個都不成立:
       ① 它跑在**牌寬定案之後**,而且只在「還有剩」時把剩的交出去 —— 給的是 slack,
          不是把內容擠小,tw 一個 px 都不會動;
       ② 它是**冪等**的:每次 render 都由 paint() 重畫牌河(--m16ph 回到 POOL_ROWS
          算出來的基準),這裡才在基準上加一次 → 不會一輪一輪往上長。
     ★ 牌河長高**只是多看得到幾排**(牌本身的大小照舊由 tw 推),所以它不算
       檔頭②那條「牌河長高就讓整副牌縮一次」—— 那條講的是**它擠壓盤面**的方向。

     ⚠ 只有橫向做:直向的牌河是滿寬的第二塊、上下都貼著東西,沒有這一截空白。
     ⚠ 留 2px 餘裕,不要剛好貼齊(差 1px 就讓盤面出捲軸不划算)。
     ⚠ 排在 placeWall() **之前**:牌山晶片貼的是牌河的右上角,牌河一長高就得重貼。
     ⚠ 一局結束(攤牌)時對手那一欄會暴增 → 這裡量到的 spare 是負的 → 自動不做,
       那正是想要的(那時盤面本來就該捲,見上面「一局結束不再重新夾牌寬」)。 */
  function fillPool(pool){
    if(!landscape() || !host) return;
    const pl = pool || host.querySelector(".m16-pool");
    const fs = host.querySelector(".m16-foes");
    if(!pl || !fs) return;
    const top = host.getBoundingClientRect().top +
                (parseFloat(getComputedStyle(host).paddingTop) || 0);
    const pr = pl.getBoundingClientRect(), fr = fs.getBoundingClientRect();
    const rowTop = Math.min(pr.top, fr.top);
    const spare = Math.round(rowTop - top) - 2;
    if(spare <= 0) return;
    /* 這一列的高度是 max(牌河, 對手欄) —— 加高到「整列 + 剩下的」才是真的把空白吃完
       (只加 spare 的話,對手欄比牌河高的那一段會白白留在上面)。 */
    const rowH = Math.round(Math.max(pr.bottom, fr.bottom) - rowTop);
    pl.style.setProperty("--m16ph", (rowH + spare) + "px");
  }

  /* ---------- 動作列的落點(v1.176.0)----------------------------------------
     把 `#m16Acts`(倒數環 + 「輪到 ○○…」+ 已宣告聽牌那一排 + 宣告面板)貼到
     **我這一排明牌**(`.m16-mymelds`,補花吃碰那一帶)的右端 —— 也就是手牌的右上方。
     使用者:「最下方會告知現在要換誰跟倒數的地方,我想把那行移到我們手牌的右上方,
     也就是補花吃牌的區域右邊」。

     ★★ 搬的是**位置不是節點**:倒數環是持久節點,移動 DOM = CSS 動畫重跑 = 倒數彈回
       滿格(adapter 的 ensureCd());而 `.m16-mymelds` 在 `#m16Stage` 裡、每次 render
       會被 innerHTML 重建最多七次。所以 `#m16Acts` 一直待在 `.mj-play` 底下不動,
       只由這裡寫兩個 CSS 變數把它「畫」過去(定位規則在 styles.css 的 .m16-acts)。

     ★★ 這三條施工紀律與 placeWall() 完全相同,理由也相同:
       ① **排在 render() 的最後**(比 paintNames() / onClaimUI 都晚)—— 那兩支都會在
          盤面畫完之後改變幾何(名字填進去會讓橫向的對手欄變寬;動作列的內容一換,
          橫向 `align-content:safe end` 會讓整塊往下移)。排在前面就會停在上一輪的位置。
       ② 用 `getBoundingClientRect()` 相減,**不要用 offsetTop** —— 橫向的
          `.m16-mine{display:contents}` 讓明牌列直接變成 grid item,offsetParent 是誰
          跟直向不一樣。
       ③ 量不到明牌列就**原地不動**(不要寫 0):寫 0 會讓那一列瞬間跳到盤面頂端。
          正常情況下量得到 —— paint() 從 v1.176.0 起一律畫這一排。
     ⚠ 這一支**不會**造成 v1.58.4 那個沒收斂的迴圈:動作列是絕對定位,它的位置與高度
       對盤面高度零影響 → 「量 → 寫變數」只有單一方向,不會回頭改變被量的東西。 */
  function placeActs(){
    const acts = document.getElementById("m16Acts");
    const play = host && host.parentNode;                // .mj-play(#m16Play)
    if(!acts || !play) return;
    const band = host.querySelector(".m16-mymelds");
    if(!band) return;
    const pr = play.getBoundingClientRect();
    let br = band.getBoundingClientRect();
    /* ★ 先把「右邊那一格要留多寬」寫進去,**再**量明牌帶(見 actsReserve)——
       留位會讓明牌多換一行,順序反過來就是「量到留位前的高度」,那一列會短一截。 */
    host.style.setProperty("--m16aw", actsReserve(acts, br) + "px");
    br = band.getBoundingClientRect();
    acts.style.setProperty("--m16ty", Math.round(br.top - pr.top) + "px");
    acts.style.setProperty("--m16th", Math.round(br.height) + "px");
  }

  /* 動作列那一格實際佔多寬 → 明牌帶右邊要讓出多少(v1.177.1)。
     使用者:「他有可能會跟吃牌區域有重疊,建議把吃牌的區域往左靠,然後倒數跟指示
     換誰的顯示往右靠」。留位本身在 CSS(`.m16-mymelds{padding-right:var(--m16aw)}`),
     這裡只負責那個數字。

     ★★ 為什麼量「子元素的左緣」而不是 `acts.getBoundingClientRect().width`:
       這一列是 `left:0;right:0` 橫跨整個寬度的(左半邊刻意留空,見 .m16-acts),
       量它自己永遠是 100% —— 明牌帶會被擠到零寬。
       這一列是 `justify-content:flex-end`,所以「最左邊那個子元素的左緣」到明牌帶右緣
       就是要讓出來的寬度。
     ⚠⚠ 前提是**明牌帶滿寬**(styles.css 的 `.m16-mymelds{width:100%}`)—— 它原本是
       「縮到內容寬 + 置中」的,那樣的話「明牌帶右緣」會跟著明牌有幾組一起跑,
       而留位又讓置中的盒子往兩邊各長一半 → 右緣更靠右 → 留位更寬,來回抖。
       那一行與這一支是同一件事的兩半,**不要只留一邊**。
     ⚠⚠ **絕對定位的子元素要跳過**,不然量出來是垃圾:
       ① 宣告面板 `.m16-claim` 跳在盤面正中間(它的 DOM 在這一列裡,見 claimPanel)
       ② 宣告視窗中倒數環會飛到面板上緣(`.m16-acts.m16-hush .m16-cd`)
       兩個都不在這一列的流裡,left 卻都在畫面中央 → 會一路留到剩半條縫。
     ⚠ 上限 RESERVE_MAX:自己的回合這一格可能同時有「自摸! / 暗槓 東 / 加槓 南 /
       宣告聽牌」好幾顆鈕,不夾的話明牌整組被擠成一行一組。夾到之後寧可讓那幾顆鈕
       疊回明牌上(它們是實心底、只出現幾秒),也不要讓已經攤在桌上的牌沒地方站。
     ⚠ 回 0(量不到 / 這一列收起來)= 完全退回 v1.176.0 的行為:會疊,但不會塌。 */
  const RESERVE_MAX = 0.46;      // 最多讓出明牌帶的幾成寬
  const RESERVE_GAP = 8;         // 明牌與那一格之間的間距
  /* ★★ 量到之後**往上取整到 RESERVE_STEP 的倍數**(v1.178.2)。
     使用者:「吃牌區會因為最右邊的文字,導致手上的花牌跟吃牌一直動來動去」。
     成因:留位是拿**當下**那一格的內容量出來的,而那一格每一手都在換 ——
       「輪到 小碰…」→「輪到 阿華美美子…」名字差幾個字就是幾十 px,
       → `--m16aw` 每手都變 → 明牌帶的 padding-right 跟著變 → 明牌 / 花牌**重新換行**。
     ★ 取整之後,名字長短的差落在同一格裡 → 那個數字整局不動,牌就不會跳。
     ⚠⚠ **一定要往上取整(ceil)不可以四捨五入**:留位比實際窄一 px 就是「疊回去」,
       而這一整條規則存在的理由就是不要疊。
     ⚠⚠ 修法刻意**不記狀態**(v1.178.2 第一版寫成「只增不減」的地板,像 fitTw 那樣)——
       那樣會踩到兩件事:① e2e M2 節的對照組是「把 --m16aw 設成 0,明牌應該往右長」,
       地板會立刻把它填回去 → 對照組永遠紅;② 盤面變窄時留位放不掉,連牌寬夾取
       都跟著算錯(實測 L2 節「盤面變窄 → 牌寬跟著變小」當場紅)。
       **這一支必須是純函式**:同樣的畫面 → 同樣的數字,不帶上一手的記憶。
     ⚠ 級距 48px ≈ 三個字:再大就等於「永遠讓 46%」(明牌被擠成一行一組),
       再小則名字差兩個字就會跨格,等於沒改。 */
  const RESERVE_STEP = 48;
  function actsReserve(acts, br){
    if(!br.width || acts.classList.contains("hidden")) return 0;
    let left = Infinity;
    [].slice.call(acts.children).forEach(function(c){
      const cs = getComputedStyle(c);
      if(cs.display === "none" || cs.position === "absolute") return;
      const r = c.getBoundingClientRect();
      if(r.width > 0) left = Math.min(left, r.left);
    });
    if(left === Infinity) return 0;
    const w = Math.ceil((Math.round(br.right - left) + RESERVE_GAP) / RESERVE_STEP) * RESERVE_STEP;
    return Math.max(0, Math.min(Math.round(br.width * RESERVE_MAX), w));
  }

  /* ---------- 牌山晶片的落點(v1.104.0)-------------------------------------
     把 .m16-wall 貼到牌河**保留的那條空白**的左上角(空白 = .m16-pool 的 padding-right,
     見 styles.css 的 --m16wl)。理由與紅線在 wallHTML();這裡只有兩條施工紀律:

     ★★ ① 一定是 render() 的**最後一步** —— 比 paintNames() 與 onClaimUI 都晚。
       這兩支都會在盤面畫完之後改變幾何:paintNames() 才把對手的名字填進去,而**橫向
       版面的對手欄是 grid 的 auto 欄** → 名字一填,那一欄變寬、牌河(1fr)跟著變窄;
       onClaimUI 換動作列的內容,列一長高盤面就矮一點(橫向是 align-content:safe end,
       牌河會整塊往下移)。排在它們前面的話,晶片會停在**上一輪的位置**。
       ⚠ 症狀非常刁鑽:直向的牌河是滿寬、名字填不填都一樣寬 → **只有橫置手機歪掉**,
         而且只有牌河右緣附近那 20px 看得出來(實測 900×560 伸出牌河 17px)。
     ★★ ② 用 getBoundingClientRect 相減,**不要用 pool.offsetLeft / offsetTop**。
       offsetLeft 的原點與絕對定位 containing block 的原點在橫向那個 grid 版面下
       相差 20px(捲軸保留區 + grid padding 兩層),直向恰好一致 —— 又是一個
       「桌機與直向都對、只有橫置歪掉」的陷阱。先把 left/top 歸零量出 (0,0) 落在哪,
       再補差值,就與原點無關。 */
  function placeWall(pool){
    if(!host) return;
    const wl = host.querySelector(".m16-wall");
    const pl = pool || host.querySelector(".m16-pool");
    if(!wl || !pl) return;
    const gut = parseFloat(getComputedStyle(pl).paddingRight) || 0;
    wl.style.left = "0px"; wl.style.top = "0px";
    const z = wl.getBoundingClientRect(), pr = pl.getBoundingClientRect();
    wl.style.left = Math.max(0, Math.round(pr.right - gut - z.left)) + "px";
    wl.style.top  = Math.round(pr.top + 4 - z.top) + "px";
  }

  /* 把整個盤面畫成 HTML 字串。抽出來是為了上面那道「量高度 → 縮小 → 再畫一次」——
     兩次畫的差別只有 tw,排法(幾排、摸的那張放哪排)刻意不重算,免得縮一下就跳版。 */
  function paint(plan, tw, hasDraw, canAct, co, myWin){
    /* --- 牌山還剩幾張(覆蓋層,位置由 render() 貼到牌河右上角;見 wallHTML) --- */
    let html = wallHTML();

    /* --- 對手 --- */
    html += '<div class="m16-foes">';
    for(let k=1;k<st.seats;k++) html += foeHTML((me+k)%st.seats, tw);
    html += '</div>';

    /* --- 牌河 ----------------------------------------------------------------
       ★ v1.58.2:牌河不再 flex:1 吃掉整片高度(空盤時預留一大塊黑,看起來像壞掉),
         改成「最新那張放大、其餘縮小」—— 最新那張才是所有人正在盯的資訊。
       ★ v1.58.3 兩件事(都是實際上手回報的):
         ①**靠左**。原本 justify-content:center → 每打一張整條牌河就左右挪一次,
           永遠對不齊;靠左之後打過的牌像牌譜一樣一格一格往右長。
         ②**高度寫死** POOL_ROWS 排(不是 min~max 之間長)。牌河換一排就多 20~30px,
           而牌寬受總高度約束 → 那一刻整副牌會縮一次。寫死之後這個來源就沒了。
           滿了就捲(render() 收尾會捲到底,最新那張一定看得見)。 */
    /* ★ 橫向寬裕版的牌河**整體大一號**(v1.178.0,見上面 landBig):一個 800px 寬的
       畫面上,44px 的手牌配 20px 的牌河沒有道理 —— 打出去的牌本來就是要看的。
       ⚠ 只放大**倍率**,排法與「幾排」照舊 → 牌河高度仍然只由 tw 推得出來
         (檔頭②那條「牌河高度不可以跟著內容跑」原封不動)。
       ⚠ 直向與「塞不下的橫向」不動:那邊高度本來就不夠,放大等於直接扣手牌的尺寸。 */
    const pw   = Math.max(14, Math.round(tw*(landBig ? 0.58 : 0.46)));   // 舊牌:小
    const pwL  = Math.max(20, Math.round(tw*(landBig ? 0.90 : 0.78)));   // 最新那張:大
    /* ★ v1.73.2:被吃 / 碰 / 明槓 / 食胡拿走時(st.taken)**整條牌河都不標最新那張**。
       那一張已經從 discards 裡 pop 掉,照舊算 length-1 的話紅框大牌會退回到**上一張** ——
       而上一張早就過了宣告視窗,看起來卻像現在可以吃 / 碰(使用者:「很容易會以為
       又可以再碰或吃」)。沒有 last 時全部牌一律 opacity:.8,剛好就是「現在沒有活牌」。
       ⚠ poolH 底下照舊**永遠預留一張大牌的高度**,不可以跟著 taken 變 ——
         牌河高度變一點,整副牌就會跟著換一次大小(v1.58.3 那條規矩)。 */
    const last = st.taken ? -1 : st.discards.length-1;
    // 最後一排要留給放大的那張(它永遠在最後);+2 是列距、+10 是內距
    const prows = poolRows();
    const poolH = Math.round(pw*1.32)*(prows-1) + Math.round(pwL*1.32)
                  + 2*(prows-1) + 10;
    /* ★★ 被拿走時**一律預留那一格**(v1.73.2 的第二半,同手牌的 .m16-slot 那條)——
       不預留的話:牌河是 flex-wrap + align-content:flex-start,而牌高 = --m16w × 1.32,
       放大那張一消失,**那一排的行高**就從 pwL×1.32 掉到 pw×1.32,而 .m16-pt 是
       align-self:flex-end → 整排牌往上跳(tw=40 時約 17px),下一張打出來又跳回來。
       使用者:「原本那一列的牌整個往上移,然後下一隻牌打出來,又被移回來,看起來很奇怪」。
       ★ 佔位格的寬高**剛好等於被拿走那張**(pwL)→ 幾何與 pop 之前**逐字相同**
         (少了 gap+pwL 的牌、多了 gap+pwL 的空格),所以碰的那一瞬間整條牌河零重排。
       ⚠ 刻意**不掛 .m16-pt** —— 那個 class 有 opacity 與 .last 的紅框語彙,而這一格
         只是空間;也讓「數 .m16-pt.last 有幾個」「所有 .m16-pt 都是小的」這兩條斷言
         不必為它開例外。 */
    const pslot = st.taken
      ? '<div class="m16-pslot" style="--m16w:'+pwL+'px" aria-hidden="true"></div>' : '';
    html += '<div class="m16-pool" id="m16Pool" style="--m16w:'+pw+'px;--m16ph:'+poolH+'px">'+
      st.discards.map((d,i)=>tileHTML(codeOf(d.t),
        /* ★ 落桌回彈只掛在最新那張、而且只有剛打出來的那一次(見 markDrop) */
        "m16-pt"+(i===last?" last"+(dropFx?" m16-dropin":""):""),
        ' data-seat="'+d.seat+'"'+(i===last?' style="--m16w:'+pwL+'px"':''))).join("")+
      pslot+
      '</div>';

    /* --- 我這一邊(攤出去的 → 手牌)-----------------------------------------
       ★ margin-top:auto 掛在這個外框上,整組貼底。明牌**緊貼手牌上方**是刻意的:
         v1.58.1 之前它夾在牌河與花牌之間、又縮到 66%,實際上手的回報是
         「碰完牌就消失了,桌上沒留下記錄」—— 它其實有畫,只是畫在沒人會看的地方。
       ★ v1.58.3:花牌與明牌**併成同一排**(花牌在最前面,底色不同)。
         原本花牌自己一排,補到花就多一排 → 整副牌縮一次;而且花牌與明牌
         本來就是同一類東西(攤在桌上的),分兩排只是白吃一排高度。 */
    html += '<div class="m16-mine">';
    const mtw = Math.round(tw*0.82);
    const shown = [];
    if((st.flowers[me]||[]).length) shown.push(flowerHTML(st.flowers[me], mtw));
    (st.melds[me]||[]).forEach(m=>shown.push(meldHTML(m, mtw)));
    /* ★★ 這一列**一律畫出來**(空的也畫),CSS 用 --m16w / min-height 給它預留高度。
       ★ v1.174.0 以前只有橫向這樣做,理由是檔頭①「摸進來那一格一律預留」:橫向盤面
         只有 200px 出頭,「有沒有明牌」差 48px,不預留的話補一張花、碰一組,整副牌
         就得重算一次大小(實測會在 30 / 36 / 38 之間跳三次)。
       ★★ v1.176.0 推到**直向**,而且多了一個更硬的理由:這一排是**動作列的錨點** ——
         倒數環與「輪到 ○○…」現在浮在它的右端(手牌右上方,見 styles.css 的 .m16-acts
         與下面的 placeActs())。量不到它,那一列會掉回 top:0 蓋在對手列上。
         ⚠ 所以這個條件**不可以再加回任何 if** —— 「有明牌才畫」等於「沒碰過牌的時候
           倒數環會跑到畫面最上面」,而那只有真的開一局才看得出來。 */
    /* ★ 一鍵理牌(v2.4.0)—— **只在玩家真的拖過之後才存在**(`ord` 非 null)。
       ★★ 「拖過才出現」不是省事,是版面預算:這一頁動作列那一格的**字數就是預算**
         (discardHint 多五個字,750×485 下牌寬從 27 掉到 25),一顆常駐的鈕同樣要
         吃掉空間 —— 而理牌只有「我剛剛把手牌拖亂了」這一種情況需要。
         沒拖過就完全不存在 = 零成本;拖過了它才冒出來,剛好也是最容易被發現的時機。
       ⚠ 它是絕對定位、疊在這一列左端(CSS 的 .m16-sortbtn),**不參與流** ——
         這一列是動作列的錨點(placeActs 量它),讓它長高就是整副牌縮一次。
       ⚠ 一局結束就不畫:那時手牌已經攤開給全桌看,重排沒有意義(而且會蓋到攤開的牌)。 */
    /* ⚠⚠ 位置要**看這一列有沒有東西**(截圖才發現的):這一列左端在開局時是空的
       (那正是最常整理手牌的時機)→ 疊在列內零遮擋;但補了花 / 碰過牌之後,花牌與明牌
       就是從左緣開始長的 → 鈕會壓在**第一張花牌**上,而花牌是算台資訊。
       → 有東西就往列外上方挪(CSS 的 .m16-sortbtn.up)。
       ★ 那個位置在盤面**塞滿**時會疊到牌河下緣一點,那是刻意選的較小代價:
         蓋住花牌 / 明牌更糟,而且**按下去這顆鈕就自己消失了**(ord 回 null)——
         遮擋只活在「拖亂了還沒按理牌」這段時間裡。 */
    const sortBtn = (ord && !st.over)
      ? '<button type="button" class="m16-sortbtn' + (shown.length ? " up" : "") + '">理牌</button>' : '';
    html += '<div class="m16-mymelds" style="--m16w:'+mtw+'px">'+sortBtn+shown.join("")+'</div>';

    /* --- 我的手牌 --- */
    const inClaim = co.length>0;
    const focus = inClaim ? co[copt] : null;
    /* 宣告聽牌的兩種狀態(v1.67.0):
         iTing  = 我已經宣告過 → 手牌鎖死,只有摸進來那張可以點(摸切)
         tt     = 正在選「要打哪一張來宣告」→ 只有這些牌打掉之後會聽牌 */
    const iTing = (typeof MJT !== "undefined" && MJT.tingOf) ? !!MJT.tingOf(st, me) : false;
    /* ⚠ 空陣列是 truthy —— 寫成 `tingPick ? MJT.tingTiles(...) : null` 的話,
       「模式還開著但已經不能宣告了」(輪次被自動打牌推走)會讓**整副手牌都變暗**。
       所以沒得選就一律當成不在模式,模式自己失效,不必到處去清那個 flag。 */
    const ttl = (tingPick && MJT.tingTiles) ? MJT.tingTiles(st, me) : [];
    const tt = ttl.length ? ttl : null;

    /* 兩排時**兩排等寬**(寬度取最長那排,含預留的摸牌格)→ 左緣對齊成一塊。
       原本每排各自居中,兩排長度不同就錯開幾十 px,看起來歪歪的
       (使用者要的「整齊的感覺」不只是牌河)。 */
    const hw = Math.round(unitsOf(plan.rows, plan.drawRow) * tw);
    /* ⚠ `locked` 是**宣告聽牌**的鎖(只能摸切 → 手牌壓暗點不動),一局結束就沒有意義了。
       不解除的話結算時整副牌是灰的 —— 使用者:「另外牌要顯示成亮的狀態」。 */
    html += '<div class="m16-hand'+(canAct?" live":"")+(inClaim?" claim":"")+
            (iTing && !st.over ? " locked":"")+(tt?" tingpick":"")+
            '" style="--m16w:'+tw+'px;--m16hw:'+hw+'px">';
    /* planHand() 保證 rows 串起來就是 hand 的原順序(切點只切在花色邊界),
       所以一路數下去的 hi 就是這張牌在 hand 裡的索引 —— 拿它當格位鍵。 */
    let hi = 0;
    plan.rows.forEach((row,ri)=>{
      html += '<div class="m16-row">';
      row.forEach(t=>{
        const i = hi++, k = "h"+i;
        html += handTile(t, k, i, focus, co, tt);
      });
      /* ★ 摸進來那一格**沒摸牌時也要佔住**(v1.58.3)—— 放一個等寬的透明佔位。
         planHand() 已經一律把這一格算進寬度,這裡若不畫,同一副手牌會在
         「我摸了一張 / 我打掉一張」之間左右挪半張牌,看起來就是整副牌在跳。 */
      if(ri===plan.drawRow){
        /* ★ 我胡的那張:站在摸進來那一格(最右邊)+ 紅框。
           ⚠ 刻意**不給 data-k** —— 它不是可以點的牌,一局已經結束了。 */
        if(myWin>=0){
          html += tileHTML(codeOf(myWin), "m16-ht m16-draw m16-wt",
                           ' data-t="'+myWin+'"');
        }else if(hasDraw){
          /* 宣告模式下,摸進來那張也可能是「打了它就聽牌」的選項之一(通常就是摸切) */
          const tk = tt ? (tt.indexOf(st.drawn)>=0 ? " tingok" : " tingno") : "";
          /* ★ 摸牌動畫(v2.3.3):只在「剛摸進來的那一次 render」掛 m16-drawin。
             ⚠⚠ 不可以無條件掛 —— 這一格只要牌還在手上就一直是 .m16-draw,
               而這一段每次 render 被 innerHTML 重建**最多七次**、別人每打一張牌
               也會重畫 → 無條件掛的話那張牌會一直抽動。旗標由 state diff 點亮
               (見 markDraw),render 消費一次就熄掉。 */
          html += tileHTML(codeOf(st.drawn), "m16-ht m16-draw"+(sel==="d"?" sel":"")+tk+(drawFx?" m16-drawin":""),
                           ' data-t="'+st.drawn+'" data-k="d"');
        }else{
          html += '<i class="m16-slot" aria-hidden="true"></i>';
        }
      }
      html += '</div>';
    });
    return html + '</div></div>';
  }

  /* 一張手牌。宣告視窗時,屬於「目前這一組」的牌站起來,其他候選只點一顆小點。
     tt(v1.67.0)= 宣告聽牌的選牌模式:這一份裡的牌打掉之後會聽牌 → 亮起來,其餘壓暗。 */
  function handTile(t, k, i, focus, co, tt){
    let cls = "m16-ht", extra = ' data-t="'+t+'" data-k="'+k+'"';
    if(tt){
      cls += (tt.indexOf(t)>=0 ? " tingok" : " tingno");
      if(sel===k) cls += " sel";
      return tileHTML(codeOf(t), cls, extra);
    }
    if(focus){
      if(focus.idx.indexOf(i)>=0) return tileHTML(codeOf(t), cls+" sel opt", extra);
      // 其他組的候選:不站起來,只在頂端疊一顆小點(「這張也能點,還有別組」)
      if(co.some(o=>o.idx.indexOf(i)>=0))
        return tileHTML(codeOf(t), cls+" alt", extra, '<i class="m16-omk"></i>');
      return tileHTML(codeOf(t), cls, extra);
    }
    if(sel===k) cls += " sel";
    return tileHTML(codeOf(t), cls, extra);
  }

  /* 玩家名字由外面餵(單機用座位名、連線用暱稱)—— 盤面不知道玩家是誰 */
  let nameOf = seat => "座位 "+(seat+1);
  function paintNames(){
    if(!host) return;
    [...host.querySelectorAll(".m16-foename")].forEach(el=>{
      el.textContent = nameOf(+el.dataset.seat);
    });
  }

  /* ==========================================================================
     宣告視窗:吃 / 碰 / 槓直接畫在牌上(v1.58.2)
     ──────────────────────────────────────────────────────────────────────────
     舊版是一排「吃 三四 / 吃 四五 / 碰 / 過」按鈕 —— 使用者的話是「這種選擇方式我不喜歡」。
     問題在按鈕上的文字要玩家**自己在腦中對回手牌**:「吃 三四」是哪兩張?

     新的做法:
       · 每一種吃法 / 碰 / 槓 都是一個「選項」,選項的牌**直接在手牌裡站起來**
       · 一次只站起來**一組**(目前這一組)。其他組的牌點一顆小點當提示 —— 這就是
         「重疊怎麼顯示」的答案:不同時顯示,用切換。同時把三種吃法都攤開只會更亂,
         而且同一張牌會屬於好幾組,顏色再多也講不清楚。
       · 點任何一張候選牌 = 切到「包含這張的下一組」(循環)。點得到的資訊是牌本身,
         不是文字標籤。
       · **送出與放棄一律走動作列的大按鈕**(✔ 碰 / 胡! / 過)—— 選擇在牌上、動作在按鈕上,
         誤觸不會直接吃掉一張牌;「過」也因此永遠在同一個位置、夠大、找得到。
     ★ 胡刻意**不做成選項** —— 它不吃特定手牌(用不到 idx),而且它是最重要的一個,
       必須永遠是獨立的大按鈕。
     ========================================================================== */
  let opts = null, copt = 0;

  /* 從手牌裡挑出 values 對應的位置(同款牌要挑不同格位) */
  function pickIdx(hand, values){
    const used = {}, out = [];
    values.forEach(v=>{
      for(let i=0;i<hand.length;i++){
        if(hand[i]===v && !used[i]){ used[i]=1; out.push(i); return; }
      }
    });
    return out.length===values.length ? out : null;
  }
  function claimOpts(){
    if(opts) return opts;
    opts = [];
    if(!st || !st.claim || st.over) return opts;
    const types = st.claim.elig[me];
    // 沒資格 / 已經表態過(bidDone = 連線剛按下、伺服器還沒回音,見上面那個旗標)
    if(!types || st.claim.bids[me] || bidDone) return opts;
    /* ⚠⚠ 這裡一定要用 **viewHand()**(v1.82.0):idx 是「畫面上的第幾格」,
       而 handTile() 拿到的 i 是 plan.rows 串起來的序號 = viewHand() 的索引。
       玩家拖過之後 st.hands[me] 的順序與畫面**不一樣**,拿原始手牌算會亮錯牌
       —— 而且亮錯的是「你可以吃哪兩張」,比排版跑掉嚴重得多。
       ★ 送出去的是 tiles(牌值),不是 idx,所以規則層完全不受影響。 */
    const hand = viewHand(), t = st.claim.t;
    const add = (type, values, label) => {
      const idx = pickIdx(hand, values);
      if(idx) opts.push({ type, idx, tiles:values, label });
    };
    if(types.indexOf("kong")>=0) add("kong", [t,t,t], "槓");
    if(types.indexOf("pong")>=0) add("pong", [t,t], "碰");
    if(types.indexOf("chow")>=0){
      const c = R.claimsFor(R.toCounts(hand), t,
                { need:MJT.needOf(st,me), chow:true, fromLeft:true });
      c.chow.forEach(pair=>add("chow", pair, "吃"));
    }
    return opts;
  }
  /* 點到某張候選牌 → 切到「包含這張的下一組」(循環) */
  function cycleTo(i){
    const co = claimOpts();
    const owners = [];
    co.forEach((o,k)=>{ if(o.idx.indexOf(i)>=0) owners.push(k); });
    if(!owners.length) return false;
    const at = owners.indexOf(copt);
    copt = owners[(at+1) % owners.length];
    render();
    return true;
  }

  /* ==========================================================================
     操作
     ========================================================================== */
  function tap(k, t){
    // 宣告視窗優先:這時候點牌不是打牌,是選要吃哪一組
    if(claimOpts().length){
      if(k && k[0]==="h") cycleTo(+k.slice(1));
      return;
    }
    const a = MJT.ownActions(st, me);
    if(!a.discard) return;

    /* ★ 宣告聽牌的選牌模式(v1.67.0):點的是「要打哪一張來宣告」,不是普通打牌。
       ⚠ 兩段式照舊(觸控要點兩次)—— 宣告**不可逆**,比普通打牌更該防誤觸。 */
    if(tingPick){
      const tt = MJT.tingTiles(st, me);
      if(tt.indexOf(t) < 0) return;                   // 打了它並不會聽牌 → 不理
      if(!oneTap() && sel !== k){ sel = k; tingSelTile = t; render(); return; }
      sel = ""; tingSelTile = -1;
      if(cb.onTing) cb.onTing(t);
      return;
    }
    /* ★ 已經宣告過 → 手牌鎖死,只有摸進來那一張可以打(摸切)。
       CSS 也擋了 pointer-events,這裡是第二道 —— 規則層(MJT.discard)是第三道。 */
    if(MJT.tingOf && MJT.tingOf(st, me) && k !== "d") return;
    /* ★ 滑鼠:hover 已經把牌抬起來了,這一下就是打出。
       ★ 觸控:兩段式 —— 第一次點是選取(上浮),第二次點**同一個格位**才打出。
         比的是格位 k 不是牌值 t,手上有一對時才不會兩張一起亮(v1.58.1)。 */
    if(!oneTap() && sel !== k){ sel = k; render(); return; }
    sel = "";
    if(cb.onDiscard) cb.onDiscard(t);
  }

  function mount(o){
    cb = o || {};
    host = document.getElementById(o.hostId || "m16Stage");
    if(!host) return;
    host.addEventListener("click", e=>{
      /* ★ 一鍵理牌(v2.4.0):把玩家拖出來的顯示順序丟掉,回到照牌序(萬 / 條 / 筒 / 字)。
         ⚠ 走的是現成的 resetOrder() —— 它本來就是「換局 / 離開牌桌」在用的那一支,
           所以這裡**沒有新的狀態**:順序一直是純本地的顯示,不進 DB / 不進 st。
         ⚠ 一定要 render() 一次:sel 與宣告選項的 idx 都是**格位鍵**,順序一換就位移
           (同 endDrag 那條 ▲④)。這裡順手清掉 sel,免得清掉順序之後那個選取指到別張牌。 */
      if(e.target.closest(".m16-sortbtn")){
        resetOrder(); sel = ""; opts = null; render();
        return;
      }
      const el = e.target.closest(".m16-ht");
      if(el && el.dataset.t!==undefined){
        /* ★ 剛剛那一下是拖曳(而且真的換到別的位置)→ 這一下不算點擊。
           旗標在 pointerdown 一律會被清掉,所以它不可能漏到下一次點擊(見最後一節)。 */
        if(noClick){ noClick = false; return; }
        tap(el.dataset.k||"", +el.dataset.t); return;
      }
      const foe = e.target.closest(".m16-foe");
      if(foe && cb.onFoe) cb.onFoe(+foe.dataset.seat);
    });
    bindDrag();
    /* ⚠ 盤面自己的 ResizeObserver **只重畫、不放掉地板**(v1.70.1):它連
       「動作列長高一格」都會叫,拿它當重量的觸發就是那個忽大忽小的來回。 */
    if(window.ResizeObserver) new ResizeObserver(()=>render()).observe(host);
    /* 視窗真的變了 → 放掉地板重新量(轉向 / 縮放 / 手機工具列收放)。
       ⚠ 只認 window 層級的事件,理由同上面那條。
       ★ v1.73.0 改成走 resetFit():轉向的那一刻**版面整個換一套**(直向堆疊 ↔ 橫向分欄),
         正是最需要暖身期的時機 —— 直接寫 fitTw=0 會鎖在轉向動畫途中的那個高度上。 */
    addEventListener("orientationchange", ()=>setTimeout(()=>{ resetFit(); render(); },180));
    addEventListener("resize", ()=>{ resetFit(); });
  }

  /* ==========================================================================
     ★★ 拖曳排序 —— 玩家自己排手牌(v1.82.0)
     ==========================================================================
       使用者:「台灣麻將,請你參考大老二,我想增加拖曳排序功能」。
       整套照 js/big2/board.js 第八節搬過來,**四處為了麻將改掉**(下面逐條標 ▲)。

       ★★ 順序是**純本地的顯示**:不進 DB、不進 state、不影響任何判定。三個後果:
         · 連線時新舊版可以同房 —— 兩台各自顯示自己想看的順序,牌與動作一模一樣
         · **不是自己的回合也拖得動**(整理手牌大半就發生在等別人打牌那段時間)
           → 所以這裡刻意**不經過** tap(),那一支有「還沒輪到你」的守衛
         · 不持久化:換局回到照牌序(手牌整副換了,沿用上一局沒有意義)

       ── ▲① 牌值會重複,所以順序是**多重集合**的事(規則層 MJ16.applyOrder)────
         大老二的牌 id 唯一,ord 可以當字典;麻將同款牌手上可能有 4 張,
         一律走「從左往右消耗」。判斷「順序有沒有變」也因此只能比**整串牌值**,
         不可以比集合。

       ── ▲② 手牌有**兩排**(planHand 依花色邊界切)────────────────────────────
         · 換位一律 `insertBefore` 到**目標那一張自己的那一排**(不是固定容器)
           → 跨排拖得過去;讀回順序時 querySelectorAll 的文件順序就是視覺順序。
         · 玩家控制的是**線性順序**;哪幾張在哪一排仍然由 planHand 決定,
           所以放手之後靠近切點的那一張可能落到另一排 —— 那是對的(排是自動的)。
         · ⚠ 拖曳途中某一排會暫時多一張而**超出 --m16hw**。所以拖曳中給 .m16-stage
           掛 `m16-dragging`(CSS 只做一件事:overflow-x:hidden),否則會冒出一條
           橫向捲軸 → clientWidth 變 → 又是「整副牌換一次大小」那條紅線。

       ── ▲③ **摸進來那一張不拖、也不是落點**────────────────────────────────────
         它不在 st.hands 裡(是 st.drawn),而且「摸進來那一格一律預留、打掉剛摸的
         不必瞄準」是這一頁最老的版面約定(檔頭①)。判準是 data-k 的第一個字元:
         手牌是 "h<序號>"、摸進來那張是 "d"、我胡的那張**根本沒有 data-k**。

       ── ▲④ 換過位置**一定要重畫一次**(大老二刻意不重畫)──────────────────────
         這一頁的 sel 存的是**格位鍵**、宣告選項的 idx 也是格位 —— 順序一換兩者
         全部位移,而且兩排要重新分。所以 endDrag() 會清掉 sel / opts 並補一次
         render()。⚠ 但一定要 setTimeout:直接叫的話手指剛放開的那個節點被 innerHTML
         銷毀,瀏覽器補的那個 click 就發不出來 → noClick 旗標會漏到下一次點擊。

       ── ★ 為什麼保留 click、把拖曳疊在上面 ────────────────────────────────────
         既有的 e2e 全部用 `el.click()` 驅動打牌(clickAnyTile),而合成的 .click()
         **不會產生 pointer 事件**。所以不可以照五子棋把 tap 判定搬進 pointerup。
         「這一下算不算點擊」用 noClick 交接:
           · pointerdown **一律先清掉**旗標 → 它絕對不會漏到下一次點擊
           · 放手時**位置真的變了**才設旗標
             ⚠ 手抖十幾 px 而沒換到別的位置 → 照樣算點擊(而且這一頁的觸控是兩段式,
               第一下只是選取,誤判成拖曳的代價是「按了沒反應」)。

       ── ★ 三個實作選擇(都有替代方案被否決,同大老二)────────────────────────
         ① 跟著手指走用 **inline style 的 transform** —— .m16-ht 有三條規則在搶
            transform(:hover / .sel / .tingpick .tingok.sel),inline 一律壓得過。
            ▲ 而且量格位時要把 inline 設成 **"none"** 而不是清空:那三條的位移是
              translateY(-22%)(大老二只有 4px),清空會量到「站起來」之後的位置,
              牌一開始拖就往下掉一截。
         ② 命中判定用**幾何**(逐張量 rect),不用 elementFromPoint —— 被拖的那張
            自己就蓋在手指底下。手牌只有 16~17 張,逐張量最穩。
         ③ 觸控要靠 CSS 的 `touch-action:none`(styles.css 的 .m16-hand .m16-ht):
            .m16-stage 是 overflow-y:auto 的捲動容器,不關掉的話手指往下滑會被捲動
            搶走(瀏覽器發 pointercancel,拖曳當場斷掉)。

       ⚠ 宣告聽牌之後手牌是 `pointer-events:none`(只能摸切),那時**拖不動** ——
         刻意不開例外:那個狀態下手牌本來就不會再變,排它沒有意義,
         而為了拖曳去鬆動那道鎖會讓「只能打摸進來那張」多一條要守的路。
     ========================================================================== */
  const DRAG_SLOP = 11;                   // 位移超過這麼多 px 才算拖曳(不到就是一般點擊)

  /* 手牌那幾張(跨兩排,文件順序 = 視覺順序)。★ 摸進來那張("d")與我胡的那張(沒有
     data-k)都被排除 —— 它們不參與排序,也不是落點。 */
  function handTiles(box){
    return [].slice.call(box.querySelectorAll(".m16-ht[data-k]"))
             .filter(el => el.dataset.k.charAt(0) === "h");
  }

  /* 這張牌**沒有任何位移時**在哪一格。
     ⚠ 設 "none" 不是清空:清空會退回 CSS 的 translateY(-22%)(hover / 選取 / 聽牌選牌),
       那樣量到的是「站起來」之後的位置,牌一開始拖就會往下掉一截。
     ⚠ 每一次移動都要重量:insertBefore 之後它的格位就換了。 */
  function slotRect(el){
    const t = el.style.transform;
    el.style.transform = "none";
    const r = el.getBoundingClientRect();
    el.style.transform = t;
    return r;
  }
  /* 讓牌停在「手指按下去時抓的那個點」上 —— 不是置中到手指,不然一開始拖會彈一下。
     ⚠⚠ 位置要**夾在盤面裡**:.m16-stage 是捲動容器,牌被拖出邊界會被裁掉一角、
       甚至整張消失,而消失的那一張正是手指按著的那一張(大老二 v1.80.0 是靠截圖
       才發現的,斷言一條都沒抓到 —— CLAUDE.md「CSS 會撞的四類」的第四類)。
     ★ 夾的只有**畫**:命中判定(dropAt)照樣吃原始的手指座標,
       所以「手指推出左緣 → 目標是第一格」完全不受影響。 */
  function follow(x, y){
    const r = slotRect(drag.el);
    const sc = host.getBoundingClientRect();
    const nx = Math.max(sc.left, Math.min(x - drag.gx, sc.right - r.width));
    const ny = Math.max(sc.top,  Math.min(y - drag.gy, sc.bottom - r.height));
    drag.el.style.transform = "translate(" + (nx - r.left) + "px," + (ny - r.top) + "px)";
  }

  /* 指標下方是哪一張**別的**手牌 → 插在它前面還是後面。
     ★ 換完位之後手指底下那一格就是被拖的那張自己(它被跳過)→ 不會來回震盪。 */
  function dropAt(x, y){
    const kids = handTiles(drag.box);
    for(let i = 0; i < kids.length; i++){
      const el = kids[i];
      if(el === drag.el) continue;
      const r = el.getBoundingClientRect();
      if(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        return { el: el, before: (x < r.left + r.width / 2) };
    }
    return null;
  }

  function endDrag(cancel){
    if(!drag) return;
    const d = drag;
    drag = null;                          // ★ 先清掉:下面那次 render() 才進得去
    d.el.classList.remove("m16-drag");
    d.el.style.transform = "";
    if(host) host.classList.remove("m16-dragging");
    try{ d.el.releasePointerCapture(d.id); }catch(e){}

    let moved = false;
    if(!cancel && d.on && host && host.contains(d.el)){
      // 順序直接**從 DOM 讀回來** —— 拖曳過程中 DOM 就是唯一的真相(一路 insertBefore)
      const now = handTiles(d.box).map(el => +el.dataset.t);
      if(now.join(",") !== d.was.join(",")){
        ord = now; noClick = true; moved = true;
        /* ▲ 順序一換,**格位鍵**(sel)與宣告選項的 idx 全部位移 → 兩份都要丟掉。
           · `opts` **非清不可**:下面那次補畫走的是 render()(**沒有** state),
             而 `opts = null` 只寫在 `if(state)` 裡面 → 不清就會用拖曳前的 idx
             去標「可以吃 / 碰哪幾張」,標到別張牌上。e2e D 節 ⑤之二在守。
           · `sel` 是**第二道防線**:sig 已經含畫面順序(見 render 的 lastSig),
             順序一換 sig 就變、sel 本來就會被清掉 —— 所以把這一行拿掉的突變
             **殺不掉**(實測存活)。刻意留著:sel 是「第幾格」,而
             「兩段式的第二下打錯牌」是這一頁最不可逆的錯,不靠另一個機制的副作用。 */
        sel = ""; opts = null; tingSelTile = -1;
      }
    }
    /* 換過位置要重畫(兩排重新分 + 格位鍵重編);拖曳中被擋掉的那次也在這裡補回來。
       ⚠ 一律 setTimeout —— 要等瀏覽器補的那個 click 發完(見上面 ▲④)。 */
    if(moved || d.dirty) setTimeout(function(){ render(); }, 0);
  }

  function bindDrag(){
    host.addEventListener("pointerdown", e => {
      noClick = false;                    // ★ 一律先清:旗標絕不會漏到下一次點擊
      if(drag) return;                    // 已經在拖了(第二根手指)→ 不理它
      if(e.button > 0) return;            // 只吃主鍵
      const el = e.target.closest(".m16-ht");
      // ▲ 只有手牌拖得動:摸進來那張是 "d"、我胡的那張沒有 data-k、牌河 / 明牌沒有 .m16-ht
      if(!el || !el.dataset.k || el.dataset.k.charAt(0) !== "h") return;
      const box = el.closest(".m16-hand");
      if(!box) return;
      const r = slotRect(el);
      drag = { id: e.pointerId, el: el, box: box,
               x0: e.clientX, y0: e.clientY,
               gx: e.clientX - r.left, gy: e.clientY - r.top,
               was: handTiles(box).map(k => +k.dataset.t),
               on: false, dirty: false };
      /* 捕獲指標:手指滑出那張牌之後還要收得到 move / up。
         ★ 包 try 是**純防禦**:規格上 pointerId 不是活著的指標時要丟 NotFoundError,
           而 e2e 餵的是合成事件 —— 一丟出來,整條拖曳就變成「靜靜地不存在」。 */
      try{ el.setPointerCapture(e.pointerId); }catch(err){}
    });

    /* ⚠⚠ move / up / cancel 掛在 **window** 不是 host(v1.107.3,見上面「捕獲會被自己搬掉」):
       捕獲一旦被收回,事件就退回「打到誰算誰」—— 手指滑出盤面(或滑到動作列上)那幾顆
       move / up 就再也不會經過 host。掛 window 收得到全部,而且 endDrag() 開頭就 return,
       重複進來也沒有副作用。 */
    addEventListener("pointermove", e => {
      if(!drag || e.pointerId !== drag.id) return;
      if(!host.contains(drag.el)){ endDrag(true); return; }   // 保險:節點被抽掉了
      if(!drag.on){
        if(Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_SLOP) return;
        drag.on = true;
        drag.el.classList.add("m16-drag");
        host.classList.add("m16-dragging");                   // ▲ 見上面②:擋掉橫向捲軸
      }
      const t = dropAt(e.clientX, e.clientY);
      // ▲ 插到**目標那一張自己的那一排**(手牌有兩排,跨排才拖得過去)
      if(t) t.el.parentNode.insertBefore(drag.el, t.before ? t.el : t.el.nextSibling);
      follow(e.clientX, e.clientY);
    });

    addEventListener("pointerup", e => {
      if(drag && e.pointerId === drag.id) endDrag(false);
    });
    addEventListener("pointercancel", e => {
      if(drag && e.pointerId === drag.id) endDrag(true);
    });
    /* ⚠⚠⚠ 捕獲**是我們自己搬掉的**(v1.107.3,iPhone 上回報「一拖就彈回來」)———————
       「被捕獲的元素從父節點被移走」= 瀏覽器當場收回捕獲,而拖曳排序每換一次位就
       `insertBefore` 搬它一次 → 第一次換位就收到 lostpointercapture。舊版把它一律
       當成中斷,所以**拖曳永遠活不過第一次換位**:牌彈回原位、`ord` 沒寫進去,
       而且 noClick 沒設 → 補上來的那一下 click 會被當成點擊(這一頁 = 真的把牌打出去)。
       ★ 兩個引擎都會收回(WebKit / Blink 實測皆然),不是 iOS 專屬 ——
         只是 iPhone 是觸控、每一次拖都會碰到別張牌,所以人人都撞得到;
         滑鼠可以「舉高高繞過去」不碰到別張牌,才顯得像只有 iPhone 壞掉。
       ★ 判準是**節點還在不在盤面上**:還在 → 是我們自己搬的,**什麼都不做**繼續拖;
         不在 → 才是真的沒了(重畫把節點換掉之類),照舊收攤。
       ⚠⚠ **不可以在這裡 setPointerCapture() 補回來** —— 補回去會馬上又被收回,
         got / lost 互踢成無限迴圈,**整頁當場凍住**(WebKit 實測跑不完一次拖曳)。
         捕獲丟了沒關係:上面 move / up 掛在 window,照樣收得到。
         ⚠ 這兩件事是**同一個修正的兩半**,拆掉任何一半都會壞:
           只掛 window 不改這裡 → 照樣被當成中斷;只改這裡不掛 window → 手指滑出盤面就斷。
       ⚠ 真正的「手勢被別人接手」走的是 pointercancel(上面那一條),不歸這裡管。 */
    host.addEventListener("lostpointercapture", e => {
      if(!drag || e.pointerId !== drag.id) return;
      if(host.contains(drag.el)) return;
      endDrag(true);
    });
  }

  /* ==========================================================================
     結果卡的大字(v1.70.0)
     ── 為什麼在這裡 ──────────────────────────────────────────────────────────
       結果卡有兩份(solo.js paintResult / adapter.js outcome),原本兩邊各寫一次
       「你胡了! / 你沒胡」。文案要分情境之後,兩份各寫一遍遲早走鐘 ——
       **這一支是唯一真相**,兩份都叫它。
     ── ★ 「你沒胡」講的是結果,不是這一局發生什麼事 ──────────────────────────
       使用者:「如果今天是被胡了,應該寫『放槍了』之類的」。麻將輸的方式不只一種,
       而且**賠的錢差很多**(見 scoring.js settle):
         · 我放槍(over.from === 我)     → 食胡一家付,全部我出   → 最痛的那個
         · 我加槓被搶(還多一個 rob 記號) → 同上,而且是自己遞出去的
         · 別人自摸(over.from === null) → 三家各付一份
         · 別人放槍給別人胡             → **我一毛都不用付**,寫「你沒胡」太委屈
       所以大字照這四種分開,語氣也照痛的程度分。
     ── ★ 同一局一定要挑到同一句(決定性) ──────────────────────────────────────
       每種情境有好幾句輪替,但**不可以用 Math.random()**:連線的 outcome() 會被
       核心重複呼叫(applyGame 每次都會走一遍,只有音效被 outcomeShown 擋住),
       隨機挑會讓大字在結果卡上自己跳來跳去。改用 over 自己的欄位當種子 ——
       同一局永遠同一句,換一局才換。
     ⚠ 字數上限抓 6 個字:大字是 clamp(30px,7.5vw,44px)、卡內容寬約 336px,
       44px × 6 ≈ 264px 還進得去(e2e「M. 結果卡大字不會撐爆整張卡」在守這條)。
     ========================================================================== */
  const OVER_WORDS = {
    tsumo:   ["自摸啦!", "自摸!", "摸到了!"],              // 我自摸
    win:     ["你胡了!", "胡啦!", "這張我要"],             // 我食胡
    fire:    ["放槍了…", "這槍你放的", "槍是你開的"],       // ★ 我放槍
    robbed:  ["槓被搶了!", "槓…被胡走", "搶槓,你的"],      // ★ 我加槓被搶(罕見但很有戲)
    tsumoed: ["被自摸…", "他自摸了", "自摸,你也賠"],       // 別人自摸,我陪付
    bystand: ["不干你的事", "別人放的槍", "你躲過了"]       // 別人放槍給別人胡,我不付
  };
  function pickWord(list, seed){
    return list[((seed % list.length) + list.length) % list.length];
  }
  /* ==========================================================================
     celebrate() —— 胡牌的慶祝光環(v2.2.4)
     ★ 由 state diff 驅動:呼叫點是現成的那兩處(adapter.js 的 applyGame 與 solo.js
       的 step),它們本來就在算 M16Sfx 的事件,`hu`(放槍)/ `zimo`(自摸)直接拿來用
       → 沒有變成第三份「兩份」,也不必在動作點插呼叫(notes/11 的〇節第 3 條)。
     ⚠⚠ 節點掛在 `.mj-play` 底下、**不進 paint() 產生的 HTML** —— 那一段每次 render
       被 innerHTML 重建最多七次,放進去動畫就會跟著重跑。這與 `#m16Acts` 一直待在
       `.mj-play` 底下不動是同一個理由。
     ⚠⚠ 必須冪等:斷線重連 / 續局那一刻可能再收到一次帶 over 的快照。diff 那一層
       已經擋掉大部分(before 為 null 或不同局就不比),但這裡自己也要擋 ——
       重複呼叫先移除上一個,**絕不疊加**。這是飛行棋「批次同步不可以連播」的同族坑。
     ⚠ 播完就自己移除:留著的話下一局的盤面上會有一個看不見但吃 z-index 的空層。
     ========================================================================== */
  /* ★ 摸牌動畫的一次性旗標(v2.3.3)。
     ⚠ 與 celebrate() 同一套思路:由 state diff 點亮(`draw` 事件),
       **render 消費一次就熄掉** —— 這一格只要牌還在手上就一直是 .m16-draw,
       無條件掛動畫的話它會跟著每一次重畫抽動(一次 render 最多重建七次)。
     ⚠ markDraw() 一定要在 render() **之前**呼叫:兩個呼叫點(adapter 的 applyGame、
       solo 的 sfxTick)本來就都排在 render 前面,不要調換。 */
  let drawFx = false;
  function markDraw(){ drawFx = true; }

  /* ★ 出牌落桌的一次性旗標(v2.4.0)—— 與 markDraw 完全同一套,理由也同一條:
       牌河最新那張(`.m16-pt.last`)**每次 render 都被 innerHTML 重建**,
       無條件掛動畫的話別人一表態、倒數環一動,那張牌就從頭彈一次。
     ★★ 刻意做成「落桌那一下」而不是無限呼吸光:`.m16-pt.last` 那圈紅框是
       **常駐不脈動**的設計語彙(五子棋 `.gmk-stone.last` / 暗棋 `.dc-lastto` 同一組,
       暗棋那段註解就寫著「盤面本身的動畫已經夠多,再疊一個持續脈動只是雜訊」)。
     ⚠ 呼叫端要排在 render() **之前**(旗標由 render 消費),與 markDraw 同兩個位置。
     ⚠ 被吃 / 碰走的那一手沒有 last(`st.taken` 時 last = -1)→ 沒有節點可掛,
       自然不播,那是對的:那張牌已經不在牌河上了。 */
  let dropFx = false;
  function markDrop(){ dropFx = true; }

  let celeT = 0;
  function celebrate(){
    const play = host && host.parentNode;              // .mj-play
    if(!play) return;
    const old = play.querySelector(".m16-cele");
    if(old) old.remove();                              // 冪等:不疊
    if(celeT){ clearTimeout(celeT); celeT = 0; }
    const el = document.createElement("div");
    el.className = "m16-cele";
    el.innerHTML = "<i></i><i></i><i></i>";            // 三圈,延遲由 CSS 的 nth-child 給
    play.appendChild(el);
    // 900ms 動畫 + 260ms 最後一圈的延遲,留點餘裕
    celeT = setTimeout(()=>{ celeT = 0; if(el.parentNode) el.remove(); }, 1250);
  }

  /* over = MJT state 的 st.over;me = 我的座位(單機固定 0,連線是 mySeat())。
     回傳 { word, tone } —— tone 直接就是結果卡要掛的 class(win / lose / draw)。 */
  function overWord(over, me){
    if(!over) return { word:"本局結束", tone:"draw" };
    if(over.type !== "win") return { word:"流局", tone:"draw" };
    const seed = (over.tile|0)*7 + (over.total|0)*13 + (over.seat|0)*3 +
                 (over.from==null ? 0 : (over.from|0)+1);
    if(over.seat === me) return { word:pickWord(over.from==null?OVER_WORDS.tsumo:OVER_WORDS.win, seed), tone:"win" };
    if(over.from === me) return { word:pickWord(over.rob?OVER_WORDS.robbed:OVER_WORDS.fire, seed), tone:"lose" };
    if(over.from == null) return { word:pickWord(OVER_WORDS.tsumoed, seed), tone:"lose" };
    /* 別人放槍給別人胡:收付表上我是 0 台。紅字(lose)看起來像我賠了,給中性的 draw。 */
    return { word:pickWord(OVER_WORDS.bystand, seed), tone:"draw" };
  }

  /* ==========================================================================
     結果卡的排名表(v1.75.14)—— ★ 單機與連線**共用同一支**
     ── 為什麼要改 ────────────────────────────────────────────────────────────
       使用者:「連線對戰最後的統計頁面,每次在看時候往往都要再想一會,代表這個
       設計其實沒有很直覺」。照排七 v1.75.2 / .3 / .9 那三版的結論改,舊版難讀的
       原因有四個,一個一個對:

         ① **一張卡上兩張長得一樣的表** —— 收付表(一列一人 + 一個數字)與共用連線層
            的勝場表 `#winScores`(一列一人 + 一個數字)講的是不同的事,卻長同一個樣。
            → 勝場併成這張表的一欄(安靜的小藥丸),`#winScores` 的列由 CSS 收掉。
         ② **沒有名次** —— 表是照台數排的,但要自己從上往下數才知道自己第幾。
            → 補金色名次圈,第一名再加 🏆。
         ③ **看不到「我這一局」** —— 表上只有累積台數,這一手到底賺賠多少要自己從
            「底 1 + 台 5 = 6 台」那行散文回推,而且還得先想清楚自己是不是放槍的那個。
            這就是「要再想一會」的主因。→ 每列補第二層「這局 · 放槍 −6」。
         ④ **第幾局看不到** —— 那個徽章在房間框上,而結果卡正好蓋住它。→ 併進表頭。

     ── ★ 框起來的是「自己」,金圈 + 🏆 才是第一名(排七 v1.75.2 的教訓)─────────
       一張排名表上被框住的那一列,第一直覺就是「我」,拿它去表示名次是**每個人都會
       看錯的方向**(誰都會先找自己)。兩個訊號分開,自己拿第一時兩個都亮。
       ⚠ 並列第一(台數同分)時每一列都拿金圈,那是對的。

     ⚠ 列的 class **保留 `.m16-tair`**:單機 e2e 的 `taiRows()` 用
       `#m16Tai .m16-tair b` 取每列的累積台數斷言「全桌相加為 0」—— 那是這張表
       唯一自動守得住的正確性,不要為了改名把它弄丟。同理**一列只能有一個 `<b>`**
       (這一局的增減用 `<span class="m16-rd">`,不可以也寫成 `<b>`)。
     ⚠ 名字是玩家輸入的,這裡自己 esc()(同 overWord 之外的每一支;notes/07 踩坑 #9)。
     ========================================================================== */
  const sgn = n => (n > 0 ? "+" : "") + n;
  /* 這一局這個座位做了什麼。**回空字串 = 這一列不畫第二層** ——
     流局時四列都寫「不收付」是純粹的重複(大字與那一句已經講過了)。
     ⚠ 胡的那一列只寫「自摸 / 胡牌」,**不寫是誰放的** —— 那句話結果卡上面那一行
       (「小明 胡 阿弟 打的牌 · 底 1 + 台 2 = 3 台」)已經講了,寫兩次就又回到
       「同一件事講三遍」的老問題;而「誰放的」在放槍那一列也標著。 */
  function roleOf(over, seat){
    if(!over || over.type !== "win") return "";
    if(over.seat === seat) return (over.from == null) ? "自摸" : "胡牌";
    if(over.from === seat) return over.rob ? "槓被搶胡" : "放槍";
    if(over.from == null)  return "被自摸";
    return "沒有收付";                       // 別人放槍給別人胡:我一毛都不用付
  }
  /* rows:[{ name, me, total, delta, role, wins }] —— 順序不拘,這裡自己照台數排
       total 累積台數 · delta 這一局的增減 · role 上面那支算的 ·
       wins { n, plus } 或 **null(單機沒有勝場,整欄消失)**
     opts:{ progressText 還在打時的表頭後半, finalText 打完時的表頭後半, final 是不是最後一局 }
     ⚠ v1.122.0:「打幾局」可以改成「打幾圈」,兩種目標的文案完全不同(局數版是
       「第 3/4 局結束」,圈數版要講圈風)——這裡不管單位是什麼,字串一律由呼叫端
       (solo.js / adapter.js 各自的 goalProgressText / goalFinalText)算好再傳進來。 */
  function rankHTML(rows, opts){
    const o = opts || {};
    const hasWin = rows.some(r => r.wins);
    const sorted = rows.slice().sort((a, b) => b.total - a.total);
    /* ⚠ 表頭要留住「目前台數」/「總結算」這兩個詞:單機 e2e 拿它們認這張表的狀態
       (`#m16Tai` 的 textContent),而它們本來就是最準的說法。 */
    /* ⚠ 這裡曾經還掛一句「收付相加為 0」(v1.75.15 拿掉)——
       使用者:「對使用者沒有用」。那是**開發時的不變量**(零和斷言),不是玩家要看的。 */
    const head = o.final ? '<b>總結算</b> · ' + o.finalText
                         : '<b>目前台數</b> · ' + o.progressText;
    let rank = 0, prev = 0;
    return '<div class="m16-taih">' + head + '</div>' +
      sorted.map((r, i) => {
        if(i === 0 || r.total !== prev){ rank = i + 1; prev = r.total; }
        const first = rank === 1;
        return '<div class="m16-tair' + (r.me ? " me" : "") + (first ? " win" : "") + '">' +
          '<div class="m16-rmain' + (hasWin ? " has-win" : "") + '">' +
            '<span class="m16-rno">' + rank + '</span>' +
            '<span class="m16-rname">' + esc(r.name) + '</span>' +
            // ⚠ 名字本身就叫「你」時(單機的 0 號位)不再掛徽章 —— 「你 你」是純雜訊,
            //   而「這一列是我」還有框在標,訊號沒少(同排七 resultHTML)
            (r.me && r.name !== "你" ? '<span class="you-badge">你</span>' : "") +
            (first ? '<span class="m16-rcrown" title="台數第一">🏆</span>' : "") +
            // ⚠ 這裡刻意**不用 🏆** —— 同一列的 🏆 已經是「台數第一」了,
            //   同一個符號兩個意思會比兩張表還難懂
            /* ⚠ **不可以**在這裡再掛一個「+1」(v1.75.15 拿掉)。使用者:「1勝+1,
               這樣會不會很容易覺得是不是 2 勝?」—— 會,而且那個 +1 完全是多的:
               `n` 本來就已經含這一局,而「這一局是誰胡的」下面那一層寫得清清楚楚。 */
            (r.wins ? '<span class="m16-rwin" title="累積勝場(胡了幾局)">' + r.wins.n + ' 勝</span>' : "") +
            // ⚠ 0 要自己一個顏色:進帳綠是「我贏了幾台」的意思,0 染成綠的會被讀成小賺
            '<b class="' + (r.total < 0 ? "neg" : (r.total > 0 ? "" : "zero")) + '">' +
              sgn(r.total) + ' 台</b>' +
          '</div>' +
          /* ⚠ 這一局的增減要**貼著角色**放,不可以像上層那樣推到最右邊:
             推到右邊的話「累積台數」與「這一局」就變成同一欄上下兩個同單位的數字,
             一眼掃過去分不出哪個是哪個 —— 那正是這一版要修掉的東西。
             ⚠ 0 的時候不印「±0」:角色本身已經寫著「沒有收付」了。 */
          (r.role
            ? '<div class="m16-rsub"><span class="m16-rlab">這局</span>' +
                '<span class="m16-rrole">' + r.role + '</span>' +
                (r.delta ? '<span class="m16-rd' + (r.delta < 0 ? " neg" : " pos") + '">' +
                             sgn(r.delta) + ' 台</span>' : "") +
              '</div>'
            : "") +
        '</div>';
      }).join("");
  }

  return {
    mount, render, revealHTML, readyHTML, tingPreviewHTML, overWord, roleOf, rankHTML, lianHTML,
    /* 宣告面板(v1.111.0,單機與連線共用一份)—— 呼叫規矩見那一節的四條紅線。
       ⚠ 清動作列時要用 isClaim() 跳過它(同倒數環):它是持久節點,
         每次重建就是每次重播進場動畫。兩邊的 clearActs / paintActs 各一行。 */
    claimPanel, hideClaim, meldWord,
    /* 動作列那一格的落點 + 明牌帶要讓多寬(v1.177.1,見 placeActs / actsReserve)。
       ★★ **兩份 renderActs 畫完動作列之後都要叫一次**(adapter.js / solo.js 各一行,
         grep m16Acts 找得到)。理由:呼叫順序是 `M16B.render()` → `renderActs()`,
         而留位是量「這一列現在有什麼」量出來的 —— 只在 render() 裡量的話,量到的
         永遠是**上一手**的內容,於是「自摸! / 暗槓 東 / 宣告聽牌」那幾顆鈕跳出來的
         那一輪不會留位,正好是最需要留位的那一輪。
       ⚠ 它只讀不寫遊戲狀態,重複叫沒有副作用(量 → 寫兩個 CSS 變數)。 */
    placeActs,
    isClaim(el){ return !!(el && el.classList && el.classList.contains("m16-claim")); },
    /* 只清「選取 / 宣告選項」那一組狀態。
       ⚠⚠ **不動牌寬的地板 fitTw**(v1.70.1,見檔頭⑤下面那條):這一支在
         「吃碰成立」「我表態完」也會被叫到,順手清掉地板就等於每次宣告結束
         都允許整副牌再放大一次 —— 回報裡「下一把摸牌之後又放大回來」就是它。
         要重新量牌寬請叫 resetFit()。
       ⚠⚠ **也不動玩家拖出來的順序 ord**(v1.82.0,同一個理由的第二次):
         這一支在「吃碰成立」「我表態完」「結算」都會被叫到,順手清掉等於
         每碰一次就把玩家排好的手牌打散 —— 而那只有真的玩才看得出來。
         換局 / 離開牌桌請叫 resetOrder()。 */
    clearSel(){ sel=""; opts=null; copt=0; lastSig=""; tingPick=false; bidDone=false; tingSelTile=-1; },
    /* 「我這一輪已經表態了」(**只有連線該叫**,見上面那個旗標的註解):
       按下「過 / ✔ 碰」→ true,宣告視窗換了一輪 → false。
       ⚠ 呼叫端要與它的 myBid **寫在同一行**,兩者分家就會出現「動作列說已表態、
         牌卻還站著」或反過來(牌放下了卻還能再按一次)。 */
    setBidDone(v){ bidDone = !!v; },
    /* 把玩家拖出來的顯示順序丟掉,回到照牌序。
       ★ 只有**換局 / 離開牌桌**該叫(呼叫端各一行,就掛在 resetFit() 旁邊):
         新的一局手牌整副換了,沿用上一局的順序沒有意義。
       ⚠ 刻意**不掛在視窗 resize / 轉向**上(那是 resetFit() 的事)——
         轉個向就把排好的手牌打散,比不重設更糟。 */
    resetOrder(){ ord = null; },
    /* 把「只縮不放」的地板放掉,下一次 render() 從頭量一次(橫向另加暖身期)。
       ★ 只有**換局 / 離開牌桌**該叫:新的一局明牌清空、手牌回到 16 張,
         上一局縮下去的牌寬不該背著走。(視窗 resize / 轉向由 mount() 自己接。) */
    resetFit,
    /* 宣告聽牌的選牌模式。動作列那顆鈕開 / 關它,宣告成立或取消都要關掉。 */
    setTingPick(v){ tingPick = !!v; sel=""; tingSelTile=-1; render(); },
    tingPicking(){ return tingPick; },
    /* 聽牌後自動摸切(見上面 let autoTing 的註解)。★ 純粹的旗標讀寫,不碰 render ——
       呼叫端(solo.js / adapter.js)自己決定看到 true 之後要不要排一次延遲打牌。 */
    autoTingOn(){ return autoTing; },
    setAutoTing(v){ autoTing = !!v; },
    /* 大牌桌(見上面 applyBig 的檔頭)。三個呼叫端:
         · 鈕      → toggleBig()(js/mahjong16/main.js 綁的)
         · 偏好    → setBig()(adapter.js 的 usePrefs)
         · 換畫面  → setBig(M16B.bigOn())(main.js 的 showScreen,每次無條件重套)
       ⚠ 三條路都經過 applyBig() 那道「只在牌桌畫面生效」的守衛,不要繞過去自己 toggle class。 */
    bigOn(){ return big; },
    setBig(v){ big = !!v; applyBig(); },
    toggleBig(){ big = !big; applyBig(); return big; },
    /* 宣告視窗:動作列問「現在是哪一組」,按下 ✔ 時回頭拿它送出 */
    claimOpts(){ return claimOpts(); },
    claimCur(){ const co=claimOpts(); return co.length ? co[Math.min(copt,co.length-1)] : null; },
    setClaimCur(i){ const co=claimOpts(); if(i>=0&&i<co.length){ copt=i; render(); } },
    setNames(fn){ nameOf = fn || (s=>"座位 "+(s+1)); },
    /* 操作提示由盤面出,因為只有它知道這台裝置走一段式還是兩段式。
       ⚠⚠ **不要在這裡加「可以拖著排」**(v1.82.0 試過、當場退回來)——
         這一行住在 .m16-acts 裡,而動作列長一點點就等於盤面矮一點點,
         整副牌跟著縮(檔頭③那條紅線)。實測只加五個字,750×485 下牌寬就從
         27 掉到 25,而 e2e 的 L2 段當場變紅。
         ★ 而且它不是「忽大忽小」那種好抓的壞:牌只是**永遠小一級**,
           斷言與眼睛都很難發現 —— 這一格的字數是版面預算的一部分,不是文案。
         → 拖曳的說明放在**進場說明**(mahjong16.html 的 m16SoloHint / 連線那份),
           那裡沒有版面預算。 */
    discardHint(){ return oneTap() ? "滑過選牌 · 點一下打出" : "點牌兩次打出"; },
    oneTap,
    celebrate,
    markDraw,
    /* 出牌落桌的一次性旗標(v2.4.0)。★ 呼叫端與 markDraw 同兩處
       (adapter 的 applyGame / solo 的 sfxTick),而且同樣要排在 render() **之前**。 */
    markDrop,
    // 給測試頁與 e2e:直接問排版決策,不必去讀 DOM
    planFor(hand, hasDraw, avail){ return planHand(hand, hasDraw, avail); },
    // 給 e2e:玩家自訂的顯示順序(沒拖過 = null)
    _ord(){ return ord ? ord.slice() : null; },
    ONE_ROW_MIN, TILE_MIN
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16B;

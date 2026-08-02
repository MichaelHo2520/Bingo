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
   ========================================================================== */

const M16B = (function(){

  const F = (typeof MJFace!=="undefined") ? MJFace : null;
  const R = (typeof MJ16 !=="undefined") ? MJ16  : null;

  const ONE_ROW_MIN = 32;      // 一排時的最小可辨識牌寬(見檔頭)
  const TILE_MIN = 20, TILE_MAX = 64;
  const DRAW_GAP = 0.45;       // 摸進來那張與手牌之間的間隔(幾張牌寬)
  const POOL_ROWS = 3;         // 牌河固定留幾排(見檔頭②;超過就捲)
  const POOL_ROWS_LAND = 2;    // 橫向手機:高度是唯一稀缺資源,牌河讓一排出來(見檔頭⑥)

  let host=null, cb={}, st=null, me=0, sel="", lastSig="";
  /* 宣告聽牌的選牌模式(v1.67.0):按了動作列那顆「宣告聽牌」之後為 true,
     這時點手牌 = 選要打哪一張來宣告。⚠ 換局 / 離房 / 宣告成立都要清掉(clearSel)。 */
  let tingPick = false;
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
       → notes/plan/eval-20260801-台灣麻將橫向版面.md 第九節。 */
  /* 1200ms 是「牌桌整個安定下來」的量級(房間框畫完 + 字型換好 + 動作列第一次有內容 +
     開局補花)。拉太短會鎖在補花前的暫時值,太長則是使用者盯著看的時間變久 ——
     實測 844×390 一整局在 700ms 下還會變一次(32→38),1200 之後才穩。 */
  const WARM_MS = 1200;
  let warmUntil = 0, warmTimer = 0;

  /* 把地板放掉,下一次 render() 從頭量一次;橫向另外開一段暖身期(見上)。
     ★ 只有**換局 / 離開牌桌 / 視窗真的變了**該叫 —— 盤面自己的 ResizeObserver 不可以。 */
  function resetFit(){
    fitTw = 0;
    if(!landscape()){ warmUntil = 0; return; }
    warmUntil = Date.now() + WARM_MS;
    if(!warmTimer && typeof setTimeout === "function")
      warmTimer = setTimeout(function(){ warmTimer = 0; render(); }, WARM_MS + 60);
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

  /* ---------- 小工具 ---------- */
  /* inner:牌面之後再疊上去的東西(目前只有宣告視窗的候選小點)。
     ⚠ 刻意做成**真的元素**而不是 ::before,理由只有一個:可測性。
       偽元素沒辦法用 elementFromPoint 驗「有沒有被牌面蓋住」,只驗得到「它存在」——
       實測過那條沒有牙齒(把 z-index 拿掉照樣全綠)。 */
  function tileHTML(code, cls, extra, inner){
    const inf = F.info(code);
    return '<div class="m16-tile'+(cls?" "+cls:"")+'" data-suit="'+inf.cls+'"'+
           (extra||"")+' aria-label="'+inf.name+'">'+F.faceHTML(code)+(inner||"")+'</div>';
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

  /* ---------- 對手那一列 ----------
     ★ 莊家的記號放在**每個人自己那一列**(v1.58.3)——原本寫在盤面頂端那條資訊列
       («莊 某某»),但那條整列被拿掉了(可吃 / 牌山對玩的人沒有用)。
       我自己是不是莊,由房間框的玩家晶片講(adapter.chipLead),兩邊同一套記號。 */
  function foeHTML(seat, tw){
    const wind = R.codeOf(MJT.seatWind(seat, st.dealer, st.seats));
    /* ⚠ 張數用**真的** st.turn:宣告視窗中下一家還沒摸牌(16 張),沒人宣告時他早就摸到
       (17 張)—— 這是藏不掉的殘留管道,但刻意不假造。顯示 17 之後若有人碰,那家會從
       17 掉回 16,反而更明顯;而張數要主動去數才看得出來(見 adapter.js renderActs)。 */
    const cnt  = st.hands[seat].length + ((st.turn===seat && st.drawn>=0)?1:0);
    const fl   = st.flowers[seat];
    /* ★ 橫向的對手明牌再縮一號(v1.73.0):分欄之後對手三家是**直排在右側窄欄**裡,
       0.52 倍的明牌會把那一欄撐到換行 → 右欄比牌河還高 → 整副手牌反而被夾得更小
       (實測 844×390 卡在 TILE_MIN)。對手明牌本來就只是「他攤了什麼」的提示,
       縮到 0.40 仍分得出筒條萬,換來手牌從 20px 回到 40px 以上,這筆交易很划算。 */
    const mtw  = Math.round(tw*(landscape() ? 0.40 : 0.52));
    /* ★ 宣告聽牌是**公開**的(v1.67.0):誰宣告了全桌都要看得到 —— 不然玩家不知道
       該不該小心放槍,那一台就變成偷襲而不是宣告。⚠ 與「誰在考慮吃碰」剛好相反。 */
    const tk = (typeof MJT !== "undefined" && MJT.tingOf) ? MJT.tingOf(st, seat) : null;
    return '<div class="m16-foe'+(shownTurn()===seat?" on":"")+(tk?" ting":"")+'" data-seat="'+seat+'">'+
      '<span class="m16-wind">'+F.info(wind).glyph+'</span>'+
      (seat===st.dealer?'<span class="m16-dz">莊</span>':'')+
      (tk?'<span class="m16-tg">'+(TING_LBL[tk]||"聽")+'</span>':'')+
      '<span class="m16-foename" data-seat="'+seat+'"></span>'+
      '<span class="m16-cnt">'+cntBack()+cnt+'</span>'+
      '<span class="m16-fmelds">'+
        (fl.length?flowerHTML(fl, mtw):"")+
        st.melds[seat].map(m=>meldHTML(m, mtw)).join("")+
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
       (v1.58.0 那個「一對牌一起站起來」的同一個坑)。 */
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

    const box = host.clientWidth || 360;
    const avail = Math.max(200, box - 16);
    const hand = st.hands[me] || [];
    const hasDraw = (st.turn===me && st.drawn>=0);
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
    if(sig!==lastSig){ lastSig=sig; sel=""; copt=0; }   // 換一張別人打的牌 → 選項從第一組重來

    const canAct = MJT.ownActions(st, me).discard;
    const co = claimOpts();                              // 宣告視窗:可吃 / 碰 / 槓的組合
    if(co.length) copt = Math.min(copt, co.length-1);

    /* ⚠ 這道量測的前提是「scrollHeight 講的是**內容**有多高」,所以橫向那邊的空白
       只能用 `align-content` 去擺位置,**不可以**放一條 1fr 的彈性列去吸收
       (吸收 = scrollHeight 恆等於 clientHeight = 下面兩點量測拿到同一個值,S 變垃圾;
        v1.73.1 試過,連「量測時暫時把它收成 0」都救不回來)。詳見 styles.css 那一段。 */
    let cur = tw;
    const draw = t => { cur = t; host.innerHTML = paint(plan, t, hasDraw, canAct, co); return host.scrollHeight; };
    let h1 = draw(tw);

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
    if(hh > 80 && h1 > hh + 2 && tw > TILE_MIN){
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
    if(hh > 80 && !(warmUntil && Date.now() < warmUntil)) fitTw = cur;

    /* 牌河高度寫死成 POOL_ROWS 排 → 打超過就要捲,而**最新那張永遠得看得見** */
    const pool = host.querySelector(".m16-pool");
    if(pool) pool.scrollTop = pool.scrollHeight;

    host.classList.toggle("m16-myturn", canAct);
    paintNames();
    if(cb.onClaimUI) cb.onClaimUI(co, copt);             // 動作列跟著換(✔ / 胡 / 過)
  }

  /* 把整個盤面畫成 HTML 字串。抽出來是為了上面那道「量高度 → 縮小 → 再畫一次」——
     兩次畫的差別只有 tw,排法(幾排、摸的那張放哪排)刻意不重算,免得縮一下就跳版。 */
  function paint(plan, tw, hasDraw, canAct, co){
    /* --- 對手 --- */
    let html = '<div class="m16-foes">';
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
    const pw   = Math.max(14, Math.round(tw*0.46));      // 舊牌:小
    const pwL  = Math.max(20, Math.round(tw*0.78));      // 最新那張:大
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
        "m16-pt"+(i===last?" last":""),
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
    /* ★ 橫向:這一列**一律畫出來**(空的也畫),CSS 用 --m16w 給它一個預留高度。
       理由與檔頭①「摸進來那一格一律預留」完全相同 —— 橫向盤面只有 200px 出頭,
       「有沒有明牌」差 48px,不預留的話補一張花、碰一組,整副牌就得重算一次大小
       (實測會在 30 / 36 / 38 之間跳三次)。直向空間夠、地板吃得住,維持原樣不畫。 */
    if(shown.length || landscape())
      html += '<div class="m16-mymelds" style="--m16w:'+mtw+'px">'+shown.join("")+'</div>';

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
    html += '<div class="m16-hand'+(canAct?" live":"")+(inClaim?" claim":"")+
            (iTing?" locked":"")+(tt?" tingpick":"")+
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
        if(hasDraw){
          /* 宣告模式下,摸進來那張也可能是「打了它就聽牌」的選項之一(通常就是摸切) */
          const tk = tt ? (tt.indexOf(st.drawn)>=0 ? " tingok" : " tingno") : "";
          html += tileHTML(codeOf(st.drawn), "m16-ht m16-draw"+(sel==="d"?" sel":"")+tk,
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
    if(!types || st.claim.bids[me]) return opts;         // 沒資格 / 已經表態過
    const hand = st.hands[me] || [], t = st.claim.t;
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
      if(!oneTap() && sel !== k){ sel = k; render(); return; }
      sel = "";
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
      const el = e.target.closest(".m16-ht");
      if(el && el.dataset.t!==undefined){ tap(el.dataset.k||"", +el.dataset.t); return; }
      const foe = e.target.closest(".m16-foe");
      if(foe && cb.onFoe) cb.onFoe(+foe.dataset.seat);
    });
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
     opts:{ done 打完幾局, goal 這一場幾局, final 是不是最後一局 } */
  function rankHTML(rows, opts){
    const o = opts || {};
    const hasWin = rows.some(r => r.wins);
    const sorted = rows.slice().sort((a, b) => b.total - a.total);
    /* ⚠ 表頭要留住「目前台數」/「總結算」這兩個詞:單機 e2e 拿它們認這張表的狀態
       (`#m16Tai` 的 textContent),而它們本來就是最準的說法。 */
    const head = '<span>' +
      (o.final ? '<b>總結算</b> · ' + o.goal + ' 局打完'
               : '<b>目前台數</b> · 第 ' + o.done + ' / ' + o.goal + ' 局結束') +
      '</span><span class="m16-taiz">收付相加為 0</span>';
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
            (r.wins ? '<span class="m16-rwin" title="累積勝場(胡了幾局)">' + r.wins.n + ' 勝' +
                      (r.wins.plus ? '<i>+1</i>' : "") + '</span>' : "") +
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
    mount, render, revealHTML, readyHTML, overWord, roleOf, rankHTML,
    /* 只清「選取 / 宣告選項」那一組狀態。
       ⚠⚠ **不動牌寬的地板 fitTw**(v1.70.1,見檔頭⑤下面那條):這一支在
         「吃碰成立」「我表態完」也會被叫到,順手清掉地板就等於每次宣告結束
         都允許整副牌再放大一次 —— 回報裡「下一把摸牌之後又放大回來」就是它。
         要重新量牌寬請叫 resetFit()。 */
    clearSel(){ sel=""; opts=null; copt=0; lastSig=""; tingPick=false; },
    /* 把「只縮不放」的地板放掉,下一次 render() 從頭量一次(橫向另加暖身期)。
       ★ 只有**換局 / 離開牌桌**該叫:新的一局明牌清空、手牌回到 16 張,
         上一局縮下去的牌寬不該背著走。(視窗 resize / 轉向由 mount() 自己接。) */
    resetFit,
    /* 宣告聽牌的選牌模式。動作列那顆鈕開 / 關它,宣告成立或取消都要關掉。 */
    setTingPick(v){ tingPick = !!v; sel=""; render(); },
    tingPicking(){ return tingPick; },
    /* 宣告視窗:動作列問「現在是哪一組」,按下 ✔ 時回頭拿它送出 */
    claimOpts(){ return claimOpts(); },
    claimCur(){ const co=claimOpts(); return co.length ? co[Math.min(copt,co.length-1)] : null; },
    setClaimCur(i){ const co=claimOpts(); if(i>=0&&i<co.length){ copt=i; render(); } },
    setNames(fn){ nameOf = fn || (s=>"座位 "+(s+1)); },
    /* 操作提示由盤面出,因為只有它知道這台裝置走一段式還是兩段式 */
    discardHint(){ return oneTap() ? "滑過選牌 · 點一下打出" : "點牌兩次打出"; },
    oneTap,
    // 給測試頁與 e2e:直接問排版決策,不必去讀 DOM
    planFor(hand, hasDraw, avail){ return planHand(hand, hasDraw, avail); },
    ONE_ROW_MIN, TILE_MIN
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16B;

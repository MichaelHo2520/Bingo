"use strict";

/* ============================================================================
   排七 — 盤面(SVB)。軌道 / 對手列 / 我的蓋牌 / 我的手牌 / 動作列全部由這裡畫。

   ── ★ 這一頁刻意**沒有** JS 算牌寬 ────────────────────────────────────────
     台灣麻將的牌寬是「寬度算出來、再被總高度夾」的,為此長出了一整套地板 / 暖身期 /
     二分回檢([notes/11](../../notes/11-台灣麻將16張.md) 第六節),因為那副牌的張數
     每一手都在變。排七不一樣:**軌道永遠是 13 格 × 4 行**,手牌只會變少、不會變多。
     所以尺寸整份交給 CSS(grid 13 等分 + clamp),JS 一個數字都不寫 ——
     那一整類「忽大忽小」的 bug 在這一頁結構上不存在。
     ⚠ 不要為了「手牌少的時候可以放大一點」把它改回 JS 算:那正是忽大忽小的來源。

   ── ★ 唯一的牌情紅線:蓋掉的牌在結算前不可顯示 ────────────────────────────
     `foeRow()` 對別人的蓋牌堆一律只畫**張數**(`pileHTML` 的 back 分支),
     自己的照實畫(自己本來就知道蓋了什麼)。翻開別人的蓋牌只有一個地方:
     結果卡的排名表(`resultHTML`)。
     ⚠ 加任何新元素到對手列上時,插入條件都不可以與「他蓋了什麼」有關。

   ── 動作列只有一份 ────────────────────────────────────────────────────────
     台灣麻將的 renderActs() 有兩份(連線那份還要管宣告視窗),排七沒有宣告階段,
     所以 `renderActs(info)` 吃的是**純資料**,單機與連線共用同一份。
     ⚠ 想加「只有連線才有」的東西時,先想能不能表達成 info 的一個欄位。
   ========================================================================== */

const SVB = (function(){

  const R = SV;
  let stage = null, acts = null;
  let hCard = null, hAct = null;          // 點手牌 / 按動作鈕的回呼
  let sel = -1;                            // 蓋牌模式選中的那張
  let cdKey = "", cdT = null;              // 倒數環:用 key 去重,不看 timer(見下)
  let lastCover = false;                   // 上一次畫的是不是蓋牌模式(進場那一刻要給提示,見 render)

  /* ==========================================================================
     一、牌面
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 花色符號一律走 R.suitCh()(帶 U+FE0E)—— 不加變體選擇子,Android 會把
         ♥ ♦ 渲染成彩色 emoji,字級與對齊當場失控。
       ⚠ 撲克牌 Unicode(U+1F0A0 那一段)一個都不准用:多數字型沒有,會變豆腐方框。
         同 CLAUDE.md 的麻將牌禁令。
     ========================================================================== */
  /* ★★ 四個花色一律**自繪 SVG**,不用 Unicode 字元(v1.75.2)。
     使用者:「梅花我覺得不好看,請你去查看標準的牌是什麼樣子,我們就畫那一個樣子」。
     `♣`(U+2663)長什麼樣**完全看字型** —— 各家畫法差很多,縮到 10px 更是糊成一團。
     查證後照標準牌面畫:梅花是 **trefoil 三葉草**(三個相等的圓繞中心排成正三角形 + 一根短莖,
     源自德式牌的橡實 Eichel、法式改成 trèfle);黑桃是**倒過來的心 + 莖**;
     紅心兩瓣一尖;方塊是菱形。
     自繪的附帶好處:**字型依賴整個消失** —— U+FE0E 那條「Android 會把 ♥ 變成彩色 emoji」
     的顧慮在畫面上不再存在(純文字訊息如 toast 仍然走 SV.suitCh(),那一半照舊要帶 VS15)。
     ⚠ `fill:currentColor` 是關鍵:花色顏色沿用外層 .sv-card / .sv-cell 既有的 color 規則,
       「牌面上用深紅、深色桌面上用亮紅」那兩支變數一行都不用改。 */
  const SUIT_SVG = [
    // ♠ 黑桃:倒過來的心 + 莖
    '<path d="M50 9C50 9 88 40 88 61c0 12-9 20-20 20-7 0-13-4-18-10-5 6-11 10-18 10-11 0-20-8-20-20C12 40 50 9 50 9z"/>' +
    '<path d="M50 66c0 12-4 21-11 27h22c-7-6-11-15-11-27z"/>',
    // ♥ 紅心:兩瓣一尖
    '<path d="M50 90S10 62 10 36C10 22 21 12 34 12c8 0 14 5 16 11 2-6 8-11 16-11 13 0 24 10 24 24 0 26-40 54-40 54z"/>',
    // ♦ 方塊:菱形
    '<path d="M50 6 86 50 50 94 14 50z"/>',
    // ♣ 梅花:三葉草(三個 r20 的圓,圓心排成邊長約 31 的正三角形 → 葉瓣充分相接)+ 短莖
    '<circle cx="50" cy="31" r="20"/><circle cx="34" cy="58" r="20"/><circle cx="66" cy="58" r="20"/>' +
    '<path d="M50 60c0 14-4 25-11 33h22c-7-8-11-19-11-33z"/>'
  ];
  function suitSVG(s){
    return '<svg class="sv-sv" viewBox="0 0 100 100" aria-hidden="true">' + SUIT_SVG[s] + '</svg>';
  }

  /* ★★ 牌面是「**點數在上、花色在下,兩件都置中**」—— 而且兩件都畫得很大(v1.75.4)。
     這一段來回過一次,結論值得記下來:

     v1.75.3 曾經照**標準撲克牌**改成「左上角 index(點數 + 花色)+ 牌面一個大 pip」,
     那的確是真牌的畫法(1870 年代發明 index 的理由是「扇形持牌時只露左上角也要讀得出來」)。
     使用者看了之後要求**改回置中版,只要把字與花色再放大一點**。
     ⚠ 想通這件事的關鍵:**螢幕上的牌不是扇形握在手上的** —— 每一張都完整攤在那裡,
       角落 index 解決的那個問題在這裡根本不存在,它換來的只是「同樣的牌寬要塞兩組東西」,
       於是點數與花色都被迫縮小。置中版可以把整張牌的寬度都給這兩件事。
     > 教訓:**照抄實體物件的規格之前,先問它當初是為了解決什麼問題,那個問題還在不在。**

     所以這一頁的牌面規格是:點數 `--svw × .50`、花色 `--svw × .42`(舊版是 .42 / .34),
     兩件置中直排。字級寫在 styles.css 的 `.sv-cr` / `.sv-cs`。 */
  function cardHTML(c, cls){
    const red = R.isRed(c) ? " red" : "";
    return '<span class="sv-card' + red + (cls ? " " + cls : "") + '" data-c="' + c + '">' +
             '<span class="sv-cr">' + R.rankTxt(R.rankOf(c)) + '</span>' +
             '<span class="sv-cs">' + suitSVG(R.suitOf(c)) + '</span>' +
           '</span>';
  }

  /* ==========================================================================
     二、軌道(13 格 × 4 行)
     ──────────────────────────────────────────────────────────────────────────
       出過的格子亮起、沒出的留暗格 —— 「還缺哪幾張」正是排七要算的東西,
       只排已出的牌就等於逼玩家自己記。
       接口(lo-1 / hi+1)畫成 `.open`:那是**公開資訊**(軌道上本來就看得出來),
       標出來只是省去數格子,不是替玩家算牌。
     ========================================================================== */
  /* ★ 每一格都畫「點數 + 花色」,像一排攤開的牌位 —— 不是只在行首標一次花色。
     使用者的話:「我希望中間的牌可以畫出是什麼花色,而不是在最左邊顯示,這樣好沒有感覺」。
     只有數字的格子看起來是表格,不是牌;而**花色本來就是牌的一半**。
     ⚠ 行首那顆 `.sv-suit` 標籤因此**整個拿掉**了(每格都有花色之後它純屬重複),
       連帶 `.sv-track.off` 也不必了 —— 「這條龍還沒開」看得出來:一格白的都沒有。 */
  function trackHTML(tracks, s){
    const t = tracks[s], ends = R.endsOf(tracks, s);
    let cells = "";
    for(let r = 1; r <= 13; r++){
      const on = t && r >= t.lo && r <= t.hi;
      const cls = "sv-cell" + (on ? " on" : "") + (r === 7 ? " seven" : "") +
                  (ends.indexOf(r) >= 0 ? " open" : "");
      // 還沒出的也照畫,只是暗的 —— 「♠J 還沒出」一眼看得到,不必數格子
      cells += '<span class="' + cls + '"><b>' + R.rankTxt(r) + '</b>' +
               '<i>' + suitSVG(s) + '</i></span>';
    }
    return '<div class="sv-track' + (R.isRed(R.cardOf(s, 1)) ? " red" : "") + '">' +
             '<div class="sv-cells">' + cells + '</div>' +
           '</div>';
  }

  /* ==========================================================================
     三、整個舞台
     ──────────────────────────────────────────────────────────────────────────
       ★ 盤面裡**沒有對手列**(v1.75.2 拿掉)。使用者:「在人物的框框裡一定有說了現在的
         牌狀況,但是你在牌池裡下面又再一次的顯示這個資訊」——「誰、輪到誰、剩幾張、
         蓋幾張」四樣在**房間框 / 單機列的玩家晶片**上全都有了,盤面再畫一次是 100% 重複,
         而且吃掉的正是手牌需要的垂直空間。
         那些資訊現在只有一個家:連線走 mp-core 的 renderPlayers() + adapter 的 chipTail(),
         單機走 solo.js 的 paintBar()。
       ⚠ 想加「某一家的什麼」時,先想它該不該住在晶片上 —— 不要又在盤面長出第二份。
     ========================================================================== */
  function render(v){
    if(!stage) return;
    let h = '<div class="sv-tracks">';
    for(let s = 0; s < 4; s++) h += trackHTML(v.tracks, s);
    h += '</div>';

    // 我的蓋牌堆:自己看得到自己蓋了什麼(別人看到的是張數,見上面那條牌情紅線)
    h += '<div class="sv-mypile' + (v.myPile.length ? "" : " empty") + '">' +
           '<span class="sv-plbl">我蓋掉的</span>' +
           (v.myPile.length
             ? v.myPile.slice().sort((a, b) => a - b).map(c => cardHTML(c, "tiny")).join("") +
               '<span class="sv-pts">共 ' + R.ptsOf(v.myPile) + ' 分</span>'
             : '<span class="sv-pts none">還沒蓋過牌 🎉</span>') +
         '</div>';

    // 手牌。★ 不可出的壓暗但**仍然可點** —— 點下去由 solo / adapter 給回饋,
    //   不用 disabled 讓牌靜默吃掉點擊(CLAUDE.md 的紅線,Bingo v1.27.3 的「假死」教訓)
    const cover = v.mode === "cover";
    // ★ 進入蓋牌模式那一刻要**看得到也聽得到**(見下方 coverBarHTML / coverCue 的註解):
    //   `.just` 只掛在切進去的那一次重畫上,之後點牌重畫就不再脈動(否則每點一張閃一次是雜訊)。
    const just = cover && !lastCover;
    if(just) coverCue();
    lastCover = cover;

    h += '<div class="sv-hand' + (cover ? " cover" : "") + (just ? " just" : "") + '">' +
      (cover ? coverBarHTML() : "") +
      v.hand.map(c => {
        const can = v.can.indexOf(c) >= 0;
        let cls = cover ? "pick" : (can ? "can" : "no");
        if(c === sel) cls += " sel";
        const card = cardHTML(c, cls);
        // 蓋牌模式:牌底下掛一個「+N」—— A / J / Q / K 不必自己換算成 1 / 11 / 12 / 13
        return cover
          ? '<span class="sv-pickw' + (c === sel ? " sel" : "") + '">' + card +
              '<i class="sv-cost">+' + R.rankOf(c) + '</i></span>'
          : card;
      }).join("") +
      (v.hand.length ? "" : '<span class="sv-empty">手牌出完了 ✨</span>') +
      '</div>';
    stage.innerHTML = h;
  }

  /* ==========================================================================
     四、蓋牌模式的招呼 —— ★ 「換了一種模式」要看得出來,不能只換一行字
     ──────────────────────────────────────────────────────────────────────────
       使用者(v1.75.11):「沒牌可出的時候要蓋牌,但目前這個用文字提醒的設計,
       突然間很難理解」。說得對 —— 舊版切進蓋牌模式時畫面上只有兩處變化:
         ① 動作列那行 13px 的字換了                      ← 在畫面另一頭,視線不在那
         ② 出不了的牌不再壓暗                            ← **反效果**,看起來更像可以出了
       所以整組重來:手牌區包成紅框(狀態)、框頂一條橫幅(為什麼 + 做什麼)、
       每張牌標罰分(代價),再加一個提示音。四件都指向同一件事,漏看一件還有三件。

       ⚠ 橫幅刻意住在**手牌區裡面**而不是動作列:視線在牌上,提示就要貼著牌。
         動作列那一行改成只講「接下來按什麼」,兩件事分開才不會又變成一長串文字。
     ========================================================================== */
  function coverBarHTML(){
    return '<div class="sv-cvbar">' +
             '<span class="sv-cvi">🚫</span>' +
             '<span class="sv-cvt"><b>沒有牌接得上,這一手只能蓋牌</b>' +
               '<i>點一張蓋掉 —— 牌上的點數就是罰分</i></span>' +
           '</div>';
  }

  /* 提示音:低沉的**下行**兩音,與「輪到你」那組清亮的上行剛好相反 ——
     排七的音效全部走 Sound 的合成音,沒有語音檔,兩件事只能靠走向與音域分辨。
     ⚠ 一定要 delay:輪到我的那一刻 `Sound.turn()` 才剛響(單機與連線都是先 turn() 再 paint()),
       不錯開就會與它疊在一起糊成一坨,聽起來只是「輪到你」多了個尾巴。 */
  function coverCue(){
    try{
      Sound.tone(392, { type:"triangle", dur:0.15, vol:0.20, delay:0.30 });
      Sound.tone(262, { type:"triangle", dur:0.30, vol:0.18, delay:0.46 });
    }catch(e){}
  }

  /* ==========================================================================
     五、動作列(單機與連線共用這一份)
     ──────────────────────────────────────────────────────────────────────────
       info = { mine, canPlay, turnName, over, waiting, cdMs, cdEnd }
       ★ 蓋牌是**兩段式**:選一張 → 按「確定蓋掉」。
         蓋牌不可逆而且直接加罰分,誤點一張的代價太高(同台灣麻將宣告聽牌那條)。
     ========================================================================== */
  function actsHTML(info){
    if(info.over) return '<span class="sv-atxt">這局結束</span>';
    if(!info.mine){
      return '<span class="sv-atxt">輪到 <b>' + esc(info.turnName || "對手") + '</b>…</span>';
    }
    if(info.canPlay){
      return '<span class="sv-atxt mine">輪到你 · 挑一張<b>接得上</b>的牌打出去</span>';
    }
    // 沒牌可出 → 蓋牌模式。★ 「為什麼會這樣」由手牌區頂上的橫幅講(coverBarHTML,貼著牌),
    //   這一列只講「接下來按什麼」—— 兩件擠在同一行正是使用者說的「突然間很難理解」。
    if(sel < 0) return '<span class="sv-atip">☝ 在上面挑一張要蓋掉的牌</span>';
    return '<button class="btn danger sv-act" data-act="cover">確定蓋掉 ' + R.nameOf(sel) +
           '（罰 ' + R.rankOf(sel) + ' 分）</button>';
  }

  function renderActs(info){
    if(!acts) return;
    acts.classList.remove("hidden");
    acts.innerHTML = '<div class="sv-actrow">' + actsHTML(info) + '</div>' +
                     '<div class="sv-cdwrap" id="svCdWrap"></div>';
    syncCd(info);
  }

  /* 倒數環。★ **全桌都看得到**,不是只有當事人 —— 判準同台灣麻將的出牌倒數:
     「輪到誰」是全桌本來就知道的事(房間框的晶片上就有 .turn),不是牌情;
     讓大家看到「還在等他、剩幾秒」也才知道為什麼卡著。
     (台灣麻將那顆藏起來的是**宣告視窗**的環,排七沒有宣告階段。)

     ★ 兩個從台灣麻將繼承的坑(notes/11 第三節):
       ① 用**負的 animation-delay** 接續播放,duration 永遠是那一段的總長
          —— 這樣 e2e 才量得到設定值。
       ② 去重的 key **不可以看 timer 還在不在**:數字走到 0 之後 interval 就停了,
          而 timer 本身還有幾百毫秒沒響;那段空窗裡只要有人再叫一次 renderActs()
          (ResizeObserver 就會),環就會彈回滿格,而那個彈跳本身就是雜訊。 */
  function syncCd(info){
    const box = $("svCdWrap");
    if(!box) return;
    if(!info.cdMs || !info.cdEnd || info.over){ stopCd(); return; }
    const key = info.cdMs + ":" + info.cdEnd;
    const left = info.cdEnd - Date.now();
    if(left <= 0){ stopCd(); return; }
    box.innerHTML =
      '<span class="sv-cd" id="svCd" style="--cd-dur:' + (info.cdMs / 1000) + 's;--cd-delay:' +
      (-(info.cdMs - left) / 1000) + 's"><i></i><b id="svCdN">' + Math.ceil(left / 1000) + '</b></span>';
    if(key === cdKey && cdT) return;      // 同一段倒數:重畫畫面不重跑動畫
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(() => {
      const n = $("svCdN");
      const ms = info.cdEnd - Date.now();
      if(!n || ms <= 0){ clearInterval(cdT); cdT = null; return; }
      n.textContent = Math.ceil(ms / 1000);
    }, 250);
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = "";
    const box = $("svCdWrap");
    if(box) box.innerHTML = "";
  }

  /* ==========================================================================
     六、結果卡的排名表 —— ★ 唯一會翻開別人蓋牌的地方
     ========================================================================== */
  /* ★ 「框起來的是自己」,「第一名」用**金色名次圈 + 冠軍標籤**(v1.75.2)。
     使用者:「最後勝負的頁面,你會把第一名給特別在框起來,這樣很容易讓大家以為自己是第一名」。
     說得對:一張排名表上「被框起來的那一列」的第一直覺就是「我」,拿它去表示名次
     等於把兩件事擠在同一個訊號上,而且是**每個人都會看錯的方向**(誰都會先找自己)。
     現在兩個訊號完全分開,自己拿第一時兩個都亮:
       · 框 + 「你」徽章  → 這一列是我
       · 金色名次圈 + 🏆  → 這一列是第一名
     ⚠ 並列第一時(三層 tie-break 都同分)每一列都會拿到金圈,那是對的。 */
  /* ★★ 一列拆成**兩層**(v1.75.3)。使用者:「最後結算的頁面…看起來資訊相當得亂,
     我覺得應該要整合,但是要能清楚」。
     亂的來源是**一列裡塞了五種東西**(名次圈 / 名字 / 徽章 / 一整排蓋牌 / 罰分),
     而其中「一整排蓋牌」的寬度**每個人都不一樣** —— 名字與分數因此每一列都對不齊,
     四列疊起來就是一團。拆成:
       第一層 = 名次 · 名字 · 徽章 · 罰分   ← 欄位固定,四列對得整整齊齊
       第二層 = 他蓋掉的那些牌(縮排)        ← 想細看才看,不跟名字搶寬度
     沒蓋過牌的人第二層直接換成一句「一張都沒蓋 ✨」,不留空行。
     ⚠ foot 是當 **HTML** 接在排名表下面的(給單機放「人數 · 難度 · 戰績」那行小字)——
       要放進使用者輸入的東西時,呼叫端自己 esc()(同 outcome().msg,notes/07 踩坑 #9)。 */
  /* ★★ 連線多一個「累積勝場」欄(v1.75.9)。使用者:「連線對戰的勝負頁面,沒有修改到
     前幾版我們調整的,我那時候是說訊息太雜亂了,需要整合」。
     v1.75.3 只整合了**單機與連線共用的那一段**(大字 + 一句 + 排名表),但連線的結果卡
     底下還壓著共用連線層的**第二張表** `#winScores`(累積勝場)—— 兩張表都是
     「一列一個人、有名次有數字」,長得像卻講不同的事,疊在一起正是使用者說的那種亂。
     現在把勝場併成排名表的一欄,`#winScores` 的列由 CSS 收掉(只留「🎯 搶 N 勝」那行)。
     ⚠ 傳 null(單機)時**一個字元都不會變** —— 單機那版是使用者驗收過的,不動它。
     ⚠ 這一欄的數字不可以直接讀 scores 節點:那是**結算後**才寫進去的,
       結果卡是**結算當下**畫的 → 由 adapter 用「開局時的快照 + 這局有沒有 +1」算,
       見 adapter.js 的 baseWins。 */
  function resultHTML(st, names, mySeat, foot, wins){
    const sc = R.score(st);
    return '<div class="sv-rank">' + sc.sorted.map(r => {
      const pile = st.piles[r.seat].slice().sort((a, b) => a - b);
      const me = r.seat === mySeat, first = r.rank === 1;
      const nm = names[r.seat] || ("玩家" + (r.seat + 1));
      const w = wins ? wins[r.seat] : null;
      return '<div class="sv-rrow' + (me ? " me" : "") + (first ? " win" : "") + '">' +
        '<div class="sv-rmain' + (w ? " has-win" : "") + '">' +
          '<span class="sv-rno">' + r.rank + '</span>' +
          '<span class="sv-rname">' + esc(nm) + '</span>' +
          // ⚠ 名字本身就叫「你」時(單機的 0 號位)不再掛徽章 —— 「你 你」是純雜訊,
          //   而「這一列是我」還有框在標,訊號沒少
          (me && nm !== "你" ? '<span class="you-badge">你</span>' : "") +
          (first ? '<span class="sv-rcrown" title="第一名">🏆</span>' : "") +
          // ⚠ 這裡刻意**不用 🏆** —— 同一列的 🏆 已經是「這局第一名」了,
          //   同一個符號兩個意思會比兩張表還難懂
          (w ? '<span class="sv-rwin" title="累積勝場">' + w.n + ' 勝' +
               (w.plus ? '<i>+1</i>' : '') + '</span>' : "") +
          '<span class="sv-rpts"><b>' + r.pts + '</b> 分</span>' +
        '</div>' +
        '<div class="sv-rcards">' +
          (pile.length
            ? '<span class="sv-rcn">蓋 ' + pile.length + ' 張</span>' +
              pile.map(c => cardHTML(c, "tiny")).join("")
            : '<span class="sv-clean">一張都沒蓋 ✨</span>') +
        '</div>' +
      '</div>';
    }).join("") + '</div>' +
    (foot ? '<div class="sv-rfoot">' + foot + '</div>' : "");
  }

  /* ==========================================================================
     七、掛載
     ========================================================================== */
  function mount(h){
    stage = $("svStage");
    acts = $("svActs");
    hCard = h.onCard; hAct = h.onAct;
    if(stage){
      stage.addEventListener("click", e => {
        const el = e.target.closest(".sv-card");
        if(!el || !hCard) return;
        // 手牌區以外的牌(蓋牌堆的縮圖)不吃點擊
        if(!el.closest(".sv-hand")) return;
        hCard(+el.dataset.c);
      });
    }
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest(".sv-act");
        if(b && hAct) hAct(b.dataset.act);
      });
    }
  }

  return {
    mount, render, renderActs, resultHTML, stopCd,
    cardHTML, suitSVG,
    sel: () => sel,
    setSel(c){ sel = c; },
    clearSel(){ sel = -1; }
  };
})();

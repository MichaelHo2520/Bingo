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
  let prevT = null;                        // 上一次畫的軌道簽章(動效全部從 diff 推,見第八節)
  let hand0 = [];                          // 最後一次畫的手牌 —— 動作列要算「封死幾張是我自己的」
  let fly = null;                          // 我自己出的那張牌:出手前量到的位置(見 armFly)

  /* ==========================================================================
     一、牌面
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 花色符號一律走 R.suitCh()(帶 U+FE0E)—— 不加變體選擇子,Android 會把
         ♥ ♦ 渲染成彩色 emoji,字級與對齊當場失控。
       ⚠ 撲克牌 Unicode(U+1F0A0 那一段)一個都不准用:多數字型沒有,會變豆腐方框。
         同 CLAUDE.md 的麻將牌禁令。
     ========================================================================== */
  /* ★★ 花色與牌面都在 **js/shared/pk-faces.js**(v1.76.0 加大老二時抽出去共用)。
     那一支的檔頭收著完整的來由:四個花色為什麼一律自繪 SVG(`♣` 長什麼樣完全看字型)、
     梅花為什麼是 trefoil 三葉草、`fill:currentColor` 為什麼是關鍵、
     以及 v1.75.3→4 那次「照抄標準牌的角落 index 又改回置中版」的教訓。

     抽出去的理由與 js/shared/mj-faces.js(兩款麻將共用牌面)完全相同:牌面留兩份的話,
     兩邊不一致時**兩邊各自都不會壞、也不報錯**,沒有東西抓得到。
     ⚠ 產出的 HTML 與抽出前**逐字相同**(52 張 × 5 種 cls + 4 個花色都比對過),
       所以這一頁既有的 e2e 與版面截圖一個像素都沒動。
     ⚠ 這一頁的花色索引是 0♠ 1♥ 2♦ 3♣,大老二是 0♣…3♠(那邊的索引要參與比大小)——
       所以 PKFace 一律吃**花色代號字串**,由 `SV.SUIT_KEY[]` 換過來。
     字級仍然是這一頁自己的事:styles.css 的 `.sv-cr`(`--svw × .50`)/ `.sv-cs`(`× .42`)。 */
  function suitSVG(s){ return PKFace.suitSVG(R.SUIT_KEY[s], "sv-sv"); }

  function cardHTML(c, cls){
    return PKFace.cardHTML({
      prefix: "sv", suit: R.SUIT_KEY[R.suitOf(c)], rank: R.rankTxt(R.rankOf(c)),
      red: R.isRed(c), cls: cls, data: c
    });
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
  /* ★★ 格子上疊了幾組**互不干擾**的記號(v2.4.5),每一組都只吃「我自己知道的東西」:

       .on              出過了(既有)
       .open            現在接得上的兩個位置 —— 公開資訊(既有)
       .mine            **這一格的牌在我手上** ← 幽靈骨牌。排七的靈魂是「記牌與控線」,
                        而「我手上的 ♠J 卡在哪」本來就是我自己的牌,標出來不是替玩家算牌,
                        是省去他在手牌與軌道之間來回對照
       .mine.open       兩者同時成立 = **這張現在就打得出去** → 金色呼吸
       .seal / .sealed  蓋牌模式選中一張時,那一格與它後面**從此永遠出不了**的那些格子
                        (真正的代價;罰分只算蓋掉的那一張,被封在後面的牌別人也只能蓋)
       .lnk             右邊那格也亮著 → 中間補一節金色龍骨(接通的一條龍看得出是一條)
       .just            這一手剛填上的那一格 → 落槽脈衝(從 diff 推,見第八節)

     ⚠ `.mine` 一律只讀呼叫端傳進來的**我的手牌** —— 它不是牌情豁免,是「我的東西畫在
       我自己的螢幕上」。想拿它畫別人的牌就是踩紅線(見檔頭)。 */
  function trackHTML(tracks, s, o){
    const t = tracks[s], ends = R.endsOf(tracks, s);
    const done = !!(t && t.lo === 1 && t.hi === 13);
    let cells = "";
    for(let r = 1; r <= 13; r++){
      const c = R.cardOf(s, r);
      const on = t && r >= t.lo && r <= t.hi;
      let cls = "sv-cell" + (on ? " on" : "") + (r === 7 ? " seven" : "") +
                (ends.indexOf(r) >= 0 ? " open" : "");
      if(!on && o.mine[c]) cls += " mine";
      if(on && t && r < t.hi) cls += " lnk";
      if(o.seal >= 0){
        if(c === o.seal) cls += " seal";
        else if(!on && sealedBy(o.seal, c)) cls += " sealed";
      }
      if(o.just[c]) cls += " just";
      // 還沒出的也照畫,只是暗的 —— 「♠J 還沒出」一眼看得到,不必數格子
      cells += '<span class="' + cls + '"><b>' + R.rankTxt(r) + '</b>' +
               '<i>' + suitSVG(s) + '</i></span>';
    }
    return '<div class="sv-track' + (R.isRed(R.cardOf(s, 1)) ? " red" : "") +
             (done ? " done" : "") + '">' +
             '<div class="sv-cells">' + cells + '</div>' +
           '</div>';
  }
  /* 蓋掉 `seal` 這張之後,`c` 會不會被封死(同花色、同一側、比它遠)。
     ⚠ 判斷式與 SV.sealOf() 是同一條界線,但那一支回**張數**、這一支回**是不是** ——
       兩邊都很短,合成一支反而要在回傳值上分岔。 */
  function sealedBy(seal, c){
    const s = R.suitOf(seal), r = R.rankOf(seal);
    if(R.suitOf(c) !== s) return false;
    const cr = R.rankOf(c);
    if(r === 7) return true;
    return r > 7 ? cr > r : cr < r;
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

    /* ★ 選中的牌若已經不在手上(蓋掉了 / 換局)就丟掉 —— 同大老二 board 的那一行。
       蓋牌是**兩段式**(選一張 → 按「確定蓋掉」),而連線那支送出之後不清 sel
       (單機清在 commit() 裡)。留著的話下一次沒牌可出時,動作列會**直接**長出一顆
       「確定蓋掉 ♦5(罰 5 分)」對著一張早就蓋掉的牌:手牌上什麼都沒站起來
       (那張牌不在了),按下去伺服器也不會收(送的是不合法的一手)—— 玩家看到的
       是「這顆鈕按了沒反應」。
       ⚠ 一定要在**畫手牌與 renderActs() 之前**:兩者都讀 sel,而兩條路徑都是
         先 render() 再 renderActs()(solo.js / adapter.js 的 paint)。 */
    if(sel >= 0 && v.hand.indexOf(sel) < 0) sel = -1;

    // ★ 動效全部從「這一次的軌道 vs 上一次的軌道」推出來(見第八節)——
    //   單機、連線、AI、對手四條路徑的動作點完全不同,而 diff 在四邊是同一件事。
    const cover0 = v.mode === "cover";
    const fx = diffTracks(v.tracks);
    const mine = {};
    hand0 = v.hand.slice();
    v.hand.forEach(c => { mine[c] = 1; });
    const justMap = {};
    fx.cells.forEach(c => { justMap[c] = 1; });

    let h = '<div class="sv-tracks">';
    for(let s = 0; s < 4; s++){
      h += trackHTML(v.tracks, s, { mine: mine, seal: cover0 ? sel : -1, just: justMap });
    }
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
    const cover = cover0;
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
    runFx(fx);
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
    /* ★ 蓋牌的代價不只是罰分(v2.4.5)—— 蓋掉 ♠J,♠Q ♠K 從此也永遠出不了。
       這一句只講「封死幾張」(公開事實,誰拿著那幾張是保密的);
       實際哪幾格會死由軌道上的 `.sealed` 直接畫出來,兩邊講同一件事。
       ⚠ 「你自己手上也有 M 張」只在 M > 0 時才接 —— 那是真正會回頭咬自己的那一半。 */
    const seal = R.sealOf(sel), own = R.sealMine(sel, hand0);
    return '<button class="btn danger sv-act" data-act="cover">確定蓋掉 ' + R.nameOf(sel) +
           '（罰 ' + R.rankOf(sel) + ' 分' +
           (seal ? ' · 封死 ' + seal + ' 張' + (own ? '，你還有 ' + own + ' 張' : '') : '') +
           '）</button>';
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
    /* ★ 蓋牌是這一頁全場唯一看不到的東西,所以結果卡上它們是**一列一列翻開**的
       (`--i` 推遲的動畫,v2.4.5)—— 一次全部跳出來等於把揭曉的那一刻偷走。
       遲到第四列也才 0.42s,不會讓人等。
       ⚠ 推遲掛在**列**上不是每一張牌上:牌數每個人不一樣,掛在牌上的話蓋得多的人
         反而翻到最後,順序讀起來是亂的。 */
    return '<div class="sv-rank">' + sc.sorted.map((r, i) => {
      const pile = st.piles[r.seat].slice().sort((a, b) => a - b);
      const me = r.seat === mySeat, first = r.rank === 1;
      const nm = names[r.seat] || ("玩家" + (r.seat + 1));
      const w = wins ? wins[r.seat] : null;
      return '<div class="sv-rrow' + (me ? " me" : "") + (first ? " win" : "") +
        (first && !pile.length ? " flawless" : "") + '" style="--i:' + i + '">' +
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
            : (first
                // ★ 一張都沒蓋而且拿第一 —— 這一頁最高的成就,值得一枚金印
                ? '<span class="sv-clean gold">👑 零蓋牌過關</span>'
                : '<span class="sv-clean">一張都沒蓋 ✨</span>')) +
        '</div>' +
      '</div>';
    }).join("") + '</div>' +
    (foot ? '<div class="sv-rfoot">' + foot + '</div>' : "");
  }

  /* ==========================================================================
     八、動效(v2.4.5)—— ★★ 全部從「軌道的 diff」推,不在動作點插呼叫
     ──────────────────────────────────────────────────────────────────────────
       這一頁有四條路徑會讓軌道多一格:我出牌(單機)、我出牌(連線)、AI 出牌、
       別人出牌的快照。在四個地方各插一次特效呼叫遲早會漏掉一條,而**漏掉的那一條
       不會壞、也不報錯**(只是那個人出牌時沒有動畫)—— 所以照 adapter 那條既有的
       做法走 diff:`render()` 一定會被四條路徑呼叫,diff 在四邊是同一件事。

       ⚠⚠ **一次多了一格以上就什麼都不放**(批次同步 / 重連歸位會一口氣補十幾手)——
         同 adapter.js 那條「音效不連播」。不擋的話重連當下會炸出十幾道光。
       ⚠ 第一次畫(`prevT === null`)也一律不放:那是「剛載入」,不是「剛剛有人出牌」。
       ⚠ 特效節點一律掛在**獨立的 fixed 圖層**而不是 `#svStage` 裡面:
         ① `render()` 每次都整份覆寫 stage.innerHTML,放裡面會被下一次重畫吃掉;
         ② 單機 e2e 有一條牌情不變量在數 `#svStage .sv-card` 的張數
            (= 我的手牌 + 我自己蓋的),飛牌的替身掛進去會讓那條**間歇性紅**。
         z-index 給 40:結果卡 `.veil` 是 50,慶祝動畫不可以蓋在它上面。
     ========================================================================== */
  function diffTracks(tracks){
    const now = tracks.map(t => t ? (t.lo + ":" + t.hi) : "");
    const out = { cells: [], boom: false, dragon: -1 };
    if(prevT){
      for(let s = 0; s < 4; s++){
        if(prevT[s] === now[s]) continue;
        const t = tracks[s];
        if(!t) continue;                                  // 換局清空 → 不是「有人出牌」
        if(!prevT[s]) out.cells.push(R.cardOf(s, 7));      // 這條龍剛開,新的那格一定是 7
        else{
          const o = prevT[s].split(":");
          if(t.lo < +o[0]) out.cells.push(R.cardOf(s, t.lo));
          if(t.hi > +o[1]) out.cells.push(R.cardOf(s, t.hi));
        }
        if(t.lo === 1 && t.hi === 13) out.dragon = s;      // 這一手把整條龍走完了
      }
      // 開局第一手一定是 ♠7,而且那時候四條龍都還沒開
      if(prevT.every(x => !x) && out.cells.length === 1 && out.cells[0] === R.SPADE7) out.boom = true;
    }
    prevT = now;
    if(out.cells.length !== 1){ out.cells = []; out.boom = false; out.dragon = -1; }
    return out;
  }

  function fxLayer(){
    let el = document.querySelector(".sv-fx");
    if(!el){
      el = document.createElement("div");
      el.className = "sv-fx";
      document.body.appendChild(el);
    }
    return el;
  }
  function spawn(cls, css, ms){
    const el = document.createElement("div");
    el.className = cls;
    el.setAttribute("style", css);
    fxLayer().appendChild(el);
    setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, ms);
    return el;
  }
  function cellRect(card){
    const s = R.suitOf(card), r = R.rankOf(card);
    const tr = stage && stage.querySelectorAll(".sv-track")[s];
    const cell = tr && tr.querySelectorAll(".sv-cell")[r - 1];
    return cell ? cell.getBoundingClientRect() : null;
  }

  function runFx(fx){
    if(!fx.cells.length){ fly = null; return; }
    const card = fx.cells[0];
    const to = cellRect(card);
    /* ① 我自己出的那一張:從手上飛到格子裡(位置是**出手前**量的,見 armFly)。
       ⚠ 只做自己那一張 —— 別人的牌在畫面上沒有出發點,硬從螢幕邊緣飛進來反而看不懂。 */
    if(fly && fly.card === card && to && Date.now() - fly.at < 2500){
      const f = fly.rect;
      const dx = (to.left + to.width / 2) - (f.left + f.width / 2);
      const dy = (to.top + to.height / 2) - (f.top + f.height / 2);
      const g = spawn("sv-flyc", "left:" + f.left + "px;top:" + f.top + "px;width:" + f.width +
        "px;height:" + f.height + "px;--fx:" + dx + "px;--fy:" + dy + "px;--fs:" +
        (to.width / Math.max(1, f.width)).toFixed(3), 480);
      g.innerHTML = cardHTML(card, "fly");
    }
    fly = null;
    // ② ♠7 開局:整片綠呢上的一圈金色衝擊波
    if(fx.boom && to){
      spawn("sv-boom", "left:" + (to.left + to.width / 2) + "px;top:" + (to.top + to.height / 2) + "px", 1000);
      try{
        Sound.tone(523, { type:"triangle", dur:0.5, vol:0.20 });
        Sound.tone(784, { type:"triangle", dur:0.6, vol:0.16, delay:0.06 });
      }catch(e){}
    }
    // ③ 一條龍走完 A~K:整排掃一道金光(那一列從此掛 .done,靜態也看得出來)
    if(fx.dragon >= 0){
      const tr = stage && stage.querySelectorAll(".sv-track")[fx.dragon];
      if(tr){
        const b = tr.getBoundingClientRect();
        spawn("sv-drag", "left:" + b.left + "px;top:" + b.top + "px;width:" + b.width +
          "px;height:" + b.height + "px", 1300);
      }
      try{
        showToast(R.SUIT_NAME[fx.dragon] + " 從 A 一路通到 K 了 🐉", 1600);
        Sound.tone(659, { type:"triangle", dur:0.22, vol:0.17 });
        Sound.tone(880, { type:"triangle", dur:0.22, vol:0.17, delay:0.13 });
        Sound.tone(1175, { type:"triangle", dur:0.5, vol:0.15, delay:0.26 });
      }catch(e){}
    }
  }

  /* 出手**之前**把那張牌現在在畫面上的位置記下來 —— 送出去之後手牌就重畫了,
     那時候已經量不到出發點。呼叫端:solo.tap() / adapter.tap() 的「出牌」那一支。
     ⚠ 只記位置不記狀態:這一手最後有沒有成立由規則層決定,不成立的話 diff 就不會有
       那一格,替身自然不會生出來(2500ms 之後也一律作廢)。 */
  function armFly(card){
    if(!stage) return;
    const el = stage.querySelector('.sv-hand .sv-card[data-c="' + card + '"]');
    if(!el) return;
    fly = { card: card, rect: el.getBoundingClientRect(), at: Date.now() };
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
    mount, render, renderActs, resultHTML, stopCd, armFly,
    cardHTML, suitSVG,
    sel: () => sel,
    setSel(c){ sel = c; },
    clearSel(){ sel = -1; }
  };
})();

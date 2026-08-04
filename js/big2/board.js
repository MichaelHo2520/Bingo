"use strict";

/* ============================================================================
   大老二 — 盤面(B2B)。牌桌 / 我的手牌 / 動作列 / 結果卡的排名表全部由這裡畫。

   ── ★ 這一頁刻意**沒有** JS 算牌寬(照排七的結論)──────────────────────────
     台灣麻將的牌寬要靠 board.js 量高度再夾,為此長出地板 / 暖身期 / 二分回檢一整套
     ([notes/11](../../notes/11-台灣麻將16張.md) 第六節),因為那副牌的張數每一手都在變。
     大老二的手牌**只會變少**、中間那塊自己可捲,
     所以尺寸整份交給 CSS(flex + clamp),JS 只寫一個數字 ——
     `--b2-slots`(**開局張數**,固定手牌的格位;它一整局都不變)。
     那一整類「忽大忽小」的 bug 在這一頁結構上不存在。
     ⚠ 不要為了「手牌少的時候放大一點」改回 JS 算,那正是忽大忽小的來源。

   ── ★★ 手牌的位置一格都不准動(v1.78.0)──────────────────────────────────
     使用者兩輪回饋都在講這件事(「位置會一直變來變去」/「又會上上下下的」)。
     它由**三件事**一起保證,少一件就會跳:
       ① 手牌容器寬 = 開局張數 × 一格、靠左填(左右不跳;見第三節)
       ② `.b2-trick` 固定高度 `--b2-trh`(中間那塊不隨列數變,也不吃滿盤面)
       ③ `.b2-acts` 固定高度 `--b2-acth`(動作列不隨提示 / 按鈕組 / 倒數環變)
     ⚠ ②③ 是 CSS 的事,但**改這支的任何一塊高度都要回頭看它們**
       (例:牌大小、列的 padding、selbar 多一行 → 兩個數字都要重算)。

   ── ★ 唯一的牌情紅線 ──────────────────────────────────────────────────────
     > **對手手上有什麼,結算前只能顯示張數。**
     已經打出去的牌是**公開的**(它們就攤在桌上),所以中間那塊照實畫。
     落地點只有兩個:
       • 對手的張數 → 房間框 / 單機列的玩家晶片(adapter 的 chipTail / solo 的 paintBar)
       • 唯一翻開的地方 → 結果卡的排名表(resultHTML)
     守門用一條**精確的不變量**(不是關鍵字比對):
         盤面上的 .b2-card 張數  ===  我的手牌 + 這一輪**畫出來的那幾手**
     (「畫出來的」= 每個座位這一輪的最後一個動作,見 trickHTML 的 act[])。
     誰哪天讓盤面畫出別人的手牌,這個數字立刻對不上。
     ⚠ 座位式牌桌(v1.83.0)多了一格「思考中…」——**那一格只准有這三個字**:
       它是「輪到誰」(晶片上本來就有的公開資訊),不是牌情。

   ── ★★ 手牌亮暗:問的是「用得到嗎」,不是「這張能不能出」(v1.79.0)──────────
     使用者:「如果我能出牌,請幫我把可以出的牌亮起來,然後選了就站起來」。
     v1.78.1 之前這一頁刻意**一張都不壓暗**,理由是「單看一張牌無法回答它能不能出」
     (♣5 單張壓不過 ♦7,但 ♣5+♦5 的對子可能壓得過一對 4)。
     ★ 那句話仍然成立 —— 所以這一版問的是**另一個問題**,由 `B2.playable()` 回答:
           「**存在**一種合法出法用得到這張牌嗎?」
       單張回答得出來,而且不騙人。舊版把 ♣5 壓暗才是騙人的那一邊。
     ★ 選了牌之後那份清單會**跟著收窄**(只留「配得上目前選取」的牌),
       所以亮著的一直是「下一張點哪裡有用」。
     ★★ v1.79.1 起**壓暗的牌點了不會選起來**(使用者:「沒亮的就不應該讓人選」)——
        擋在兩支 tap 裡(判斷走規則層的 `B2.whyNotPick`),而且**一定會跳 toast 說原因**。
        ⚠ CLAUDE.md 那條紅線是「不用 disabled 讓牌**靜默**吃掉點擊」:
          不給選可以,沒有回饋不行 —— 所以**不可以**改成 disabled / pointer-events:none。
        ⚠ 由此得到一個好處:sel **永遠是某一手合法出法的子集**,所以
          「選了一組永遠湊不出牌型的牌」變成到不了的狀態,動作列那一格因此改講
          「還要再選幾張」(見第六節 selInfoOf)。
     ⚠ 一手都出不了時(can === false)動作列只留 Pass —— 見第四節。

   ── ★★ 手牌可以自己拖著排(v1.80.0)────────────────────────────────────────
     使用者:「我們有沒有辦法可以拖曳自己的手牌順序,有時候這樣可以幫助思考」。
     整段實作與「為什麼不那樣做」寫在**第八節**;這裡只留三句一定要先知道的:
       · 順序是**純本地的顯示** —— 不進 DB、不進 moves、不影響任何判定,
         所以連線時新舊版可以同房,而且**不是自己的回合也拖得動**
       · **拖曳中不重畫**(render() 開頭那道閘門)—— 否則連線時對手一出牌,
         手指底下那個節點就被 innerHTML 銷毀,手勢當場斷掉
       · 選牌一律**保留 click 監聽**:四支 e2e 都用 `el.click()` 驅動,
         而合成的 click 不會產生 pointer 事件(所以不可以照五子棋搬進 pointerup)
   ========================================================================== */

const B2B = (function(){

  const R = B2;
  let stage = null, acts = null;
  let hCard = null, hAct = null;          // 點手牌 / 按動作鈕的回呼
  let sel = [];                            // 目前選了哪幾張(牌 id;順序不重要)
  let cdKey = "", cdT = null;              // 倒數環:用 key 去重,不看 timer(見 syncCd)
  let ord = null, ordKey = null;            // ★ 玩家自己拖出來的顯示順序 / 它屬於哪一局(第八節)
  let drag = null, noClick = false;         // 拖曳中的狀態 / 這一下的 click 要不要吃掉
  let lastV = null;                         // 最後一次 render 收到的 v(拖曳中延後重畫用)

  /* ==========================================================================
     一、牌面
     ──────────────────────────────────────────────────────────────────────────
       花色與牌面都在 js/shared/pk-faces.js(與排七共用同一份,理由見那支的檔頭)。
       ⚠ 這一頁的花色索引是 0♣ 1♦ 2♥ 3♠(索引本身就是花色強弱,要參與比大小),
         與排七的 0♠ 起相反 —— 所以一律用 B2.SUIT_KEY[] 換成花色代號再交給 PKFace。
       ⚠ 撲克牌 Unicode(U+1F0A0 那一段)一個都不准用:多數字型沒有,會變豆腐方框。
     ========================================================================== */
  function cardHTML(c, cls){
    return PKFace.cardHTML({
      prefix: "b2", suit: R.SUIT_KEY[R.suitOf(c)], rank: R.rankTxt(R.rankOf(c)),
      red: R.isRed(c), cls: cls, data: c
    });
  }

  /* ==========================================================================
     二、牌桌 = **這一輪大家出的牌,照座位擺**(v1.83.0 從「一列列的清單」改過來)
     ──────────────────────────────────────────────────────────────────────────
       ★ 為什麼有這一塊(v1.77.0 起,理由沒變):舊版只畫 st.cur(這一輪目前最大的
         那一手),三家電腦連續出完只花幾百毫秒,被壓掉的與 Pass 全部就地消失。
         使用者的原話:「中間那一塊應該要用來顯示這一輪大家出的牌,才不會因為
         跳太快,導致你根本不知道出過什麼牌了」。

       ★★ v1.83.0 換成**真牌桌的座位**(自己永遠在下、其他人繞一圈的十字)。
          舊版是「由舊到新的一列列清單」,它的三個缺點都是那一版解掉的:
            · 誰出的要用名字去讀(牌桌上是用**位置**認人的)
            · 同一個人的牌會在列之間上下換位置(誰先動就排前面)
            · 「誰還沒表態」要自己數列數

       ★★★ v1.98.0 **推翻十字版型**,改成「一個大桌面 + 裡面分格子」。使用者的原話:
             「大老二的中間桌面,我想也變成像21點那樣的牌桌,但不用分成好幾個,
               就用一個牌桌就行了」
             「一個大桌面,然後又繼續分格子,這樣看起來也像是在同一個桌上玩,
               又可以知道現在換誰了」
          → 桌面本身變成**一整塊綠呢**(照21點的 .bj-table),裡面每個座位一格
            (照21點的 .bj-box),**照座位號碼 0→n−1 排**、一列 2 格。
          ⚠⚠ 「照座位號碼排」**取代**了 v1.83.0 的「自己永遠在下面」——
            兩件事不可能同時成立(自己在哪一格取決於我是第幾家)。
            理由與21點 v1.88.0 逐字相同:**每台裝置看到的排列完全一致**,
            所以「他是第 3 家」在誰的螢幕上都指同一格,桌號讀得懂;
            代價是「我在哪」要靠記號而不是位置 → 於是長出下面那張語彙表。
          ⚠ 十字那三張方位表(SEAT_POS)、外層 `.b2-tseat.pos-*`、中央那個
            `.b2-tmid` 節點**全部拿掉了**;桌子中央那個淡淡的 🎴 改由
            `.b2-trick::before` 畫(絕對定位的浮水印 → 不占版面、不多一列)。

     ── ★★★ 三個訊號 = 三條軌(v1.98.0;改任何一格之前先看這張表)──────────────
       | 要講的事 | 顏色 | 位置 / 方向 | 會不會動 |
       |---|---|---|---|
       | **這是我**(身分,一局不變) | 金 `#ffd489` | **左緣直條** + 金底 + 金名字 | 靜態 |
       | **現在在等他**(暫時) | 亮青 `--b2-turn` | **上緣橫條** | **呼吸** |
       | **目前最大**(這一輪的關鍵) | `--accent` | **整格 border** | 靜態 |
       ★ 舊版不必分軌是因為 me 只有一層淡底色(幾乎看不見);而「照座位號碼排」
         之後「我在哪」失去了位置這個線索 → me 一定要變成看得見的記號,
         那一刻它就會與 top 撞在同一條通道上(21點 v1.91.0 整版都在修這件事)。
       ⚠⚠ 所以 **top 那一條 border 一個字都不要動**(CLAUDE.md 紅線:亮框必須是
         border 才畫得完整,box-shadow 會被捲動容器裁掉 —— v1.77/v1.78 各錯一次),
         而 me 與 act 一律走**格子內部的絕對定位偽元素**:不占版面(不會讓我那一格
         的牌比別人窄)、捲動容器裁不到、而且兩條可以同時存在(border 只有一條)。
       ⚠ 21點試過「左緣金脊」並且**放棄了**,理由是「它與同色的金框糊成一條」——
         這一頁沒有那個問題(me 這一軌**刻意不發 border**,金色只出現在左緣那一條),
         所以**不要**照21點的結論把它刪掉。

     ── ★ 從舊版繼承、**一條都不能鬆**的三件事 ────────────────────────────────
       ① **每個人只留最後一個動作**(v1.78.0;使用者:「如果這一輪出到第一次,
          那第一次的也不要顯示了」)—— 一個座位就一格,所以這件事是自然的。
       ② **一輪結束就整份清掉**(規則層做的,st.trick = [])→ 桌面變乾淨,
          只留一句「誰先出」。
       ③ 牌情紅線:出過的牌是公開的、Pass 也是公開動作,所以照實畫;
          守門的不變量還是那一條 ——
              盤面上的 .b2-card 張數 === 我的手牌 + 這一輪每個座位最後那一手

     ── ★★ 「高度不准跳」在格子版怎麼守(接 v1.79.1 那兩層)──────────────────
       格數 = **人數**(一整局都不變),不是「有幾個人動過」→ 沒動過的座位
       照樣畫一格空的。所以這一塊的高度與「這一輪進行到哪」完全無關。
       每一格的高 / 寬都是 CSS 算的(--b2-tph / --b2-tpw,五張牌 + 名字列的最壞情況),
       ⚠ 空的格子與出五張牌的格子**一樣大** —— 少了這一條,同一個人從 Pass 變成
         出牌就會把整桌撐開一次(那正是使用者一路在講的「上上下下」)。
       ★ v1.98.0 的**列數**也是常數:一列 2 格 × 格數 = 人數 → 2 人 1 列、
         3 / 4 人 2 列,而「一列幾格」寫在 CSS(不看視窗、不看內容)。
         ⚠⚠ 所以**不可以**改成 `repeat(auto-fit, minmax(…))`:那會讓欄數跟著
           視窗寬度跑,4 人局在寬螢幕變成 3 + 1(一格獨自吊在第二列)——
           施工中算過:桌面上限 700px 時 4 欄需要 703px,**差 3px 排不進去**。
     ========================================================================== */
  /* 一個座位那一格。act = 他這一輪的最後一個動作(undefined = 還沒表態)。
     ⚠ 欄位順序是「座位號 · 名字 · 牌型 · 無敵」一列 + 「牌」一列(v1.79.1 的結論在
       格子版自然成立:牌一律置中在那一格裡,所以每一格的牌都在同一個位置)。
     ★★ v1.98.0 三個 class 是**三條互不干擾的軌**(見下面第二節的語彙表):
          me   這是我(身分)      → 左緣金直條 + 金底 + 金名字,靜態
          act  現在在等他(暫時)  → 上緣青光條,呼吸
          top  目前最大(關鍵資訊)→ 整格 border(--accent)
        ⚠ 三個可以同時掛在同一格上,而且必須**同時都畫得出來** ——
          舊版 me 只有底色、top 只有 border,所以沒踩到「互相蓋掉」;
          這一版 me 升級成看得見的記號之後,它與 top 就不可以再共用 border
          (21點 v1.91.0 那條教訓:訊號要分軌,不是換色)。 */
  function seatHTML(v, seat, act, isTop){
    const nm = (v.names && v.names[seat]) || ("玩家" + (seat + 1));
    const mine = seat === v.me;
    const waiting = !act && v.turn === seat && !v.over;
    let cls = "b2-tmv";
    if(isTop) cls += " top";
    if(act && act.pass) cls += " pass";
    if(!act) cls += " idle";
    if(mine) cls += " me";
    /* ★★ 「現在在等他」——照21點 v1.91.0 那條軌(上緣一條會呼吸的青光條)。
       ⚠ 條件與「思考中…」那三個字**完全一樣**(同一個 waiting):同一格裡兩個記號
         講同一件事是刻意的 —— 使用者要的就是「知道現在換誰了」,而純文字在
         reduced-motion / 電子書主題下是青光條的可讀後備。 */
    if(waiting) cls += " act";
    let body = "";
    if(act && act.pass){
      body = '<span class="b2-tpass">✕ Pass</span>';
    }else if(act){
      /* ★ 排序走 R.sortShow(),不是 cmpCard —— 帶 2 的順子照牌力排會變成
         「3 4 5 6 2」,而使用者要的是「2 3 4 5 6」(見 rules.js sortShow)。 */
      body = R.sortShow(act.cards).map(c => cardHTML(c, "mid")).join("");
    }else if(waiting){
      /* 輪到他、還沒動 → 一句「思考中」。⚠ 這是**公開資訊**(輪到誰晶片上就有),
         而且刻意只有這一句:不可以在這裡透露他手上有什麼。 */
      body = '<span class="b2-twait">思考中…</span>';
    }
    /* ⚠ v1.98.0 起**沒有外層那一層 `.b2-tseat`** —— 舊版它的存在理由只有
       「grid-area 把人塞到上下左右」與「左右兩家貼外側」,格子版兩件事都不需要了,
       所以這一格直接就是 `.b2-tseats` 的 grid item(同21點的 .bj-box)。 */
    return '<div class="' + cls + '">' +
               '<div class="b2-thd">' +
                 /* ★★ 座位號碼(1-based)取代原本純裝飾的色點:v1.98.0 起格子是
                    **照座位號碼排**的,所以「這是第幾家」一定要看得出來,
                    否則排列順序對玩家沒有意義(照21點 v1.88.0 的 .bj-sn 那一套)。
                    ⚠ 顏色照舊沿用 p0..p3 → 與玩家晶片列那排色點還是對得上。 */
                 '<span class="b2-sn p' + seat + '">' + (seat + 1) + '</span>' +
                 '<span class="b2-tnm">' + esc(nm) + '</span>' +
                 /* ⚠ 名字本身就叫「你」時(單機的 0 號位)不掛徽章 —— 「你 你」是純雜訊,
                    而「這一格是我」還有左緣金條 + 金底 + 金名字三個記號在標
                    (v1.98.0 起**位置不再是線索**:格子照座位號碼排)。同 resultHTML 那條。 */
                 (mine && nm !== "你" ? '<span class="b2-tyou">你</span>' : "") +
                 (act && !act.pass
                   ? '<span class="b2-tct">' + (R.T_NAME[act.t] || "") + '</span>' +
                     (R.isBomb(act.t)
                       ? '<span class="b2-rbomb" title="無敵牌型:只有更大的鐵支或同花順壓得過">無敵</span>'
                       : "")
                   : "") +
               '</div>' +
               '<div class="b2-tcs">' + body + '</div>' +
           '</div>';
  }

  /* ⚠ 這一整塊是 `.b2-trick`(大桌面);裡面那一格格是 `.b2-tseats` / `.b2-tmv`。
     **不可以**叫 .b2-rcards —— 那是結果卡排名表第二層用的(CLAUDE.md「CSS 會撞的
     四類」的第一類:名字撞,而前綴防不了自己撞自己;第一版真的撞過一次)。 */
  function trickHTML(v){
    const list = (v.trick || []);
    const n = Math.max(2, Math.min(4, (v.names || []).length || 4));

    /* 每個人只留**最後一個**動作(繼承 v1.78.0);後面那筆直接蓋掉前面那筆。 */
    const act = {};
    list.forEach(m => { act[m.seat] = m; });

    /* 目前最大的那一手 = 最後一個「有出牌」的。
       ⚠ 用**座位**而不是索引:格子是照座位號碼擺的。那個座位的最後一個動作一定就是
         這一手(要 pass 得先有人壓過他,那時最大的就換人了)。 */
    let topSeat = -1;
    for(let i = list.length - 1; i >= 0; i--) if(!list[i].pass){ topSeat = list[i].seat; break; }

    /* ★ 一輪結束(變自由牌)時 trick 是空的 —— 那時桌面就該是**乾淨的**,
       只給一句「誰先出」。v1.77.0 曾經在這裡畫「上一輪」,使用者要求拿掉。 */
    const lbl = list.length ? "這一輪" : (v.opened ? "新的一輪" : "這一局剛開始");
    let hint = "";
    if(!list.length && !v.over){
      /* ⚠⚠ 這裡用 longName(「梅花3」)而**不是** nameOf(「♣︎3」)——
         「盤面上一個花色 Unicode 都沒有」是這一頁的規矩(連線 e2e B 節在守,
         理由是字型渲染不一致)。而這一句只在**我是先手**時出現,所以那條斷言
         原本是「我剛好不是先手就綠」的 flaky:v1.77.0 埋進去、第二輪才被抓到
         (notes/14 假綠第 9 種)。單機 e2e 現在有一條造局的版本永遠測得到。 */
      hint = v.mine
        ? ('<b>你</b>先出 —— ' + (v.opened ? '任何合法牌型都可以' : '第一手一定要帶 ' + R.longName(R.CLUB3)))
        : ('<b>' + esc(v.turnName || "對手") + '</b> 先出');
    }

    /* ★★★ 格數 = **人數**,不是「動過的人數」(理由見上面那段:高度不准跳)。
       ⚠ 這是這一頁第二個寫進 JS 的數字(第一個是手牌的 --b2-slots),兩個都是
         **張數 / 人數這種資料**,不是量出來的尺寸 ——
         「這一頁不用 JS 算尺寸」那條沒有破。
       ★★★ v1.98.0:**嚴格照座位號碼 0 → n−1 排**(舊版是 `(me + rel) % n` 把我
         旋轉到第一格 = 十字的「下面」)。所以 `v.me` 在這一支只剩**一個**用途:
         決定哪一格掛 `me`(給那三個記號用)—— 它不再影響任何一格的位置。
       ⚠ 守門要特別造「我不是 0 號位」的局面:單機的我永遠坐 0 號位 →
         「照座位排」與「我排第一個」在 me=0 時長得一模一樣(21點 v1.88.0 同一個坑)。 */
    let cells = "";
    for(let s = 0; s < n; s++) cells += seatHTML(v, s, act[s], s === topSeat);

    return '<div class="b2-trick' + (list.length ? "" : " empty") + '">' +
             '<div class="b2-tlbl"><span class="b2-tttl">' + lbl + '</span>' +
               (hint ? '<span class="b2-thint">' + hint + '</span>' : "") + '</div>' +
             /* ⚠ s2/s3/s4 決定**一列幾格 / 幾列**(CSS 那邊),而它是「人數」這種資料 ——
                v1.83.0 那三張十字版型表已經沒有了,但這個 class 留著:一列 2 格的
                收攏規則(3 人局最後一格撐滿整列)還要靠它。
              ★ 桌子正中央那個淡淡的 🎴 **不再是 DOM 節點**(舊版 .b2-tmid 是十字的
                中央格)—— 改成 `.b2-trick::before` 的浮水印:絕對定位 → 不占版面、
                不會被丟進一個新的隱含列(那正是 v1.83.0 在 2 人局踩過的坑)。 */
             '<div class="b2-tseats s' + n + '">' + cells + '</div>' +
           '</div>';
  }

  /* ==========================================================================
     ✗ 二之二、算牌表 —— **v1.78.0 拿掉了**
     ──────────────────────────────────────────────────────────────────────────
       v1.77.0 在中間那塊底下加過一張算牌表(13 個點數 × 4 個花色,出過的亮起),
       理由是「♠2 出了沒」本來全靠記憶。使用者玩過之後的原話:

         「出過的牌不要顯示好了,我覺得還是要自己記,比較好玩」

       ★ 記牌本身就是大老二的樂趣,幫玩家記等於把那一段拿走了 ——
         這與「不做騙人的壓暗」是同一類判斷:**能算不等於該顯示**。
       ⚠ 要復活的話請一起把那條紅線帶回來:只准標「**已經出過的**」,
         標「還沒出現的」= 52 − 已出 − 我的手牌 = 對手手牌的聯集(兩人局等於攤牌)。
         守門是 `.b2-spip.on` 個數 === `st.played.length`(v1.77.0 有兩條突變在守)。
     ========================================================================== */

  /* ==========================================================================
     三、整個舞台
     ──────────────────────────────────────────────────────────────────────────
       v = { hand, slots, trick[], names[], me, turn, mine, turnName, over, opened, hot[], key }
       ★ me / turn = 「我坐幾號」「現在輪到幾號」(v1.83.0 座位式牌桌要的兩個數字):
         ⚠ v1.98.0 起 me **不再決定位置**(格子照座位號碼排)——它只決定哪一格掛 `me`;
         turn 則決定哪一格掛 `act` +「思考中…」(「知道現在換誰了」那件事)。
         ⚠ 兩個都是**座位序**,不是玩家 id —— 連線那邊由 adapter 換算好再傳進來。
       ★ key = 「這是哪一局」(單機 = 第幾局、連線 = roundId)。它只有一個用途:
         **換局時把玩家自訂的手牌順序丟掉**(第八節)。⚠ 不可以改成比對手牌有沒有變 ——
         那會把「出掉一手」誤判成新局,把玩家排好的順序打散(而且只有真的玩才看得出來)。
       ★ hot = 要亮起來的牌(B2.playable().cards);傳 null / 不傳 = **一張都不壓暗**
         (輪到對手時就該這樣 —— 那時亮暗沒有意義,只是在畫面上多一種變化)。
       ★ 盤面裡**沒有對手列**:「誰 / 輪到誰 / 剩幾張」三樣在玩家晶片上全都有了
         (連線走 chipTail、單機走 paintBar),盤面再畫一次是 100% 重複。

       ★★ 手牌的格位是**固定的**(v1.77.0)。使用者的原話:「我不喜歡我們的手牌,
          位置會一直變來變去」—— 舊版 .b2-hand 是 justify-content:center,
          出掉 5 張之後剩下的 8 張會整排往中間收,**每一張牌的位置都平移**,
          下一手要重新找牌。台灣麻將 v1.58.2 踩過同一個坑(牌河置中 → 每打一張
          整條就左右挪一次),那邊的結論也是靠左。
          做法:容器寬度固定成「**開局張數** × 一格」、整組置中、牌一律靠左填。
          出掉的牌右邊的往前補、左邊的一格都不動 —— 像真人收攏手牌。
          ⚠ slots 要用**開局張數**(B2.dealCounts),不可以用目前手牌張數:
            用目前張數的話容器會跟著縮,那就等於沒改。
     ========================================================================== */
  function render(v){
    if(!stage) return;
    lastV = v;

    /* ★ 換局 → 丟掉玩家自訂的順序(新的一手牌沿用上一局的順序沒有意義)。
       判準是呼叫端傳進來的 key,理由見上面 v 的說明。 */
    if(v.key !== ordKey){ ordKey = v.key; ord = null; if(drag) endDrag(true); }

    /* ★★ 拖曳中一律**不重畫**(v1.80.0,見第八節)。stage.innerHTML 一換,
       手指底下那個節點就被銷毀,手勢當場斷掉(連線時對手出牌隨時會走到這裡)。
       延後是安全的,而理由要記住:**我的手牌只可能因為我自己出牌而改變**,
       而我出牌不可能發生在拖曳途中 —— 所以這裡不會顯示過期的手牌,
       最多讓中間那塊晚幾百毫秒更新。
       ⚠ 倒數環在 #b2Acts(走 renderActs),不吃這道閘門,秒數照跑。
       ⚠ 誰哪天在 render() 裡加進「手牌以外也會即時變動、而且不能晚」的東西,
         這道閘門會一起延後它 —— 那時要改的是那個東西的位置,不是拿掉閘門。 */
    if(drag){ drag.dirty = true; return; }

    // 選取的牌若已經不在手上(換局 / 出牌之後)就丟掉,不然會殘留一個選不掉的框
    sel = sel.filter(c => v.hand.indexOf(c) >= 0);

    let h = trickHTML(v);

    /* 手牌。★ 亮起「配得出組合」的那幾張(見檔頭)——
       ⚠ 壓暗的牌**仍然點得動**,壓暗只是提示,不是 disabled。
       ⚠ v.hot 沒給時 hot 是 null → 一張都不加 class(輪到對手 / 結算) */
    const hot = v.hot ? {} : null;
    if(hot) v.hot.forEach(c => { hot[c] = 1; });
    const slots = Math.max(v.slots || 0, v.hand.length, 1);
    /* ★ 畫的順序走 applyOrder(玩家沒拖過的話它就是照牌力排;見 rules.js)。
       ⚠ 只有這一行吃 ord —— 送去規則層的一律是原始的集合。 */
    const hand = R.applyOrder(v.hand, ord);
    h += '<div class="b2-hand' + (v.mine ? " mine" : "") + '" style="--b2-slots:' + slots + '">' +
      hand.map(c => cardHTML(c,
        sel.indexOf(c) >= 0 ? "sel" : (hot ? (hot[c] ? "hot" : "cold") : ""))).join("") +
      (v.hand.length ? "" : '<span class="b2-empty">手牌出完了 ✨</span>') +
      '</div>';
    stage.innerHTML = h;

    /* ✗ 「捲到最新那一手」那一段 v1.83.0 拿掉了 —— 這張牌桌**沒有時間順序**,
       格子的位置由座位號碼決定。舊版是「由舊到新的清單」才需要每次把 scrollTop 推到底。
       ⚠ 矮視窗放不下時 .b2-tseats 自己還是捲得動(overflow-y:auto),但**刻意不自動捲**:
         自動捲到底會把前面那幾格推出畫面,而每一格都一樣重要。 */
  }

  /* ==========================================================================
     四、動作列(單機與連線共用這一份)
     ──────────────────────────────────────────────────────────────────────────
       info = { mine, over, turnName, lead, selInfo:{ok,txt,type}, canPass, noPlay, cdMs, cdEnd }
       ★ 只有一份:大老二沒有宣告階段,所以動作列吃的是**純資料**
         (台灣麻將的 renderActs 有兩份,是因為連線那份要管宣告視窗)。
       ⚠ 想加「只有連線才有」的東西時,先想能不能表達成 info 的一個欄位。
     ========================================================================== */
  function actsHTML(info){
    if(info.over) return '<span class="b2-atxt">這局結束</span>';
    if(!info.mine) return '<span class="b2-atxt">輪到 <b>' + esc(info.turnName || "對手") + '</b>…</span>';

    /* ★★ 一手都出不了 → **只留 Pass**(v1.79.0)。使用者:
         「如果我沒辦法出牌的時候,請直接剩下 pass 按鈕」
       畫一顆「出牌」在那裡等於要玩家自己試到死心,而答案是規則層算得出來的
       (B2.playable().can)。
       ⚠ 這條路只在 canPass 時走:領出的人手上只要有牌就一定出得出來
         (任何一張單張都合法),所以 noPlay && !canPass 到不了 —— 但真的到了
         就會變成「一顆鈕都沒有」的死畫面,所以這裡要求兩個條件同時成立。
       ⚠ 「清除」還是要留:壓暗的牌照樣點得動,玩家有可能已經選了幾張。 */
    if(info.noPlay && info.canPass){
      return '<div class="b2-selbar bad">' +
               '<span class="b2-selico">🙅</span>' +
               '<span class="b2-seltxt">你手上沒有一手壓得過現在桌上這一手 —— 只能 Pass</span>' +
             '</div>' +
             '<div class="b2-btns">' +
               (sel.length ? '<button class="btn ghost b2-act" data-act="clear">清除</button>' : "") +
               '<button class="btn primary b2-act" data-act="pass">Pass</button>' +
             '</div>';
    }

    const s = info.selInfo || {};
    /* ★ 領出的人不能 pass(規則)。那句提示 v1.78.0 起**併進這一行**,不再多一行 ——
       動作列多一行就等於手牌被推走一次(見 .b2-acts 的固定高度)。
       ⚠ 已經選好牌時就不必再提醒「不能 Pass」了:那顆鈕本來就沒畫出來。 */
    /* 三種狀態三個樣子(v1.79.1 多了中間那個):
         ✅ 綠 = 選好了 · 👉 中性 = 選到一半(再選幾張)· 🚫 紅 = 這組不行
       ⚠ 「選到一半」**不可以**標紅:沒亮的牌點不起來之後,選到一半是**正常過程**,
         標紅等於每選一張就罵一次。 */
    const lead = !info.canPass ? "這一輪由你開始,一定要出牌(不能 Pass)" : "";
    const mid = !s.ok && s.pending;
    let h = '<div class="b2-selbar' + (s.ok ? " ok" : (sel.length && !mid ? " bad" : "")) + '">' +
              '<span class="b2-selico">' + (s.ok ? "✅" : (mid ? "👉" : (sel.length ? "🚫" : "☝"))) + '</span>' +
              '<span class="b2-seltxt">' +
                esc(s.txt || lead || "點牌選要出的組合(1 張 / 2 張 / 5 張)") + '</span>' +
            '</div>';
    h += '<div class="b2-btns">';
    // ★ 「出牌」永遠按得動 —— 選錯了要說得出原因,不用 disabled 靜默吃掉點擊
    h += '<button class="btn primary b2-act' + (s.ok ? "" : " dim") + '" data-act="play">出牌</button>';
    if(sel.length) h += '<button class="btn ghost b2-act" data-act="clear">清除</button>';
    /* ⚠ v1.77.0 拿掉了「💡 幫我挑」(從手牌裡挑一組合法的幫他選上)。使用者:
       「幫我選那個功能拿掉,我覺得很奇怪,如果是要這樣的話,應該要做個電腦托管功能」——
       只選不出這件事的定位確實尷尬:它既不是提示(直接給答案)也不是代打(還要自己按)。
       ★ **托管明確先不做**。要補回來的話請整支做成托管,不要把這顆鈕加回來。 */
    /* ★ 領出的人不能 pass(規則)。刻意**不畫**那顆鈕 ——
       畫一顆按了會被拒絕的鈕,比沒有那顆鈕更讓人困惑。
       原因寫在上面那條 selbar 裡(v1.78.0 從獨立的一行併進去,見上)。 */
    if(info.canPass) h += '<button class="btn ghost b2-act" data-act="pass">Pass</button>';
    h += '</div>';
    return h;
  }

  function renderActs(info){
    if(!acts) return;
    acts.classList.remove("hidden");
    acts.innerHTML = '<div class="b2-actrow">' + actsHTML(info) + '</div>' +
                     '<div class="b2-cdwrap" id="b2CdWrap"></div>';
    syncCd(info);
  }

  /* 倒數環。★ **全桌都看得到**,不是只有當事人 —— 判準同排七 / 台灣麻將的出牌倒數:
     「輪到誰、還剩幾秒」是公開資訊(晶片上就有 .turn),讓大家知道為什麼卡著。

     ★ 兩個從台灣麻將繼承的坑(notes/11 第三節):
       ① 用**負的 animation-delay** 接續播放,duration 永遠是那一段的總長
          —— 這樣 e2e 才量得到設定值。
       ② 去重的 key **不可以看 timer 還在不在**:數字走到 0 之後 interval 就停了,
          而 timer 本身還有幾百毫秒沒響;那段空窗裡只要有人再叫一次 renderActs()
          環就會彈回滿格,而那個彈跳本身就是雜訊。 */
  function syncCd(info){
    const box = $("b2CdWrap");
    if(!box) return;
    if(!info.cdMs || !info.cdEnd || info.over){ stopCd(); return; }
    const key = info.cdMs + ":" + info.cdEnd;
    const left = info.cdEnd - Date.now();
    if(left <= 0){ stopCd(); return; }
    box.innerHTML =
      '<span class="b2-cd" id="b2Cd" style="--cd-dur:' + (info.cdMs / 1000) + 's;--cd-delay:' +
      (-(info.cdMs - left) / 1000) + 's"><i></i><b id="b2CdN">' + Math.ceil(left / 1000) + '</b></span>';
    if(key === cdKey && cdT) return;      // 同一段倒數:重畫畫面不重跑動畫
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(() => {
      const n = $("b2CdN");
      const ms = info.cdEnd - Date.now();
      if(!n || ms <= 0){ clearInterval(cdT); cdT = null; return; }
      n.textContent = Math.ceil(ms / 1000);
    }, 250);
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = "";
    const box = $("b2CdWrap");
    if(box) box.innerHTML = "";
  }

  /* ==========================================================================
     四之二、★★ 「拉」的公告(v1.81.0)—— 單機與連線**共用這一份**
     ──────────────────────────────────────────────────────────────────────────
       真人規則:剩最後一手(不管幾張)必須喊「拉」,用意是**強制資訊揭露**。
       使用者拍板**由系統自動公告**(玩家零操作、不做「漏喊罰 0 分」)。

       ★ 為什麼共用一份而不是照這一頁的慣例各寫一份:
         這是**純衍生**的東西(從 st.hands 算出來),沒有任何「連線才有 / 單機才有」的
         成分,而 diff + 去重那一段一旦有兩份,走鐘了兩邊各自都不會壞、沒有東西抓得到
         —— 那正是這個專案最痛的一類。呼叫端各一行。

       ★★ 種子(seed)那一條是這一段的心臟:`laPrev === null` 或**換局**時
          **只記住、不出聲**。它一次擋掉四種會亂響的情形:
            ① 第一次進牌桌 ② 斷線重連(replay 一次把整局重算出來)
            ③ 批次同步(一次套好幾手)④ 換局
          少了它,重連的那一瞬間會把「目前所有在拉的人」全部重播一次。
       ⚠ 這裡刻意**不吃 adapter 的 fresh 旗** —— 那條旗只認得「連線的第一次同步」,
         而上面四種情形單機也會遇到(換局)。用 `laPrev === null` 兩邊都對。

       ⚠ 拉會**退回去**:剩一條順子(拉)拆一張出去就變 4 張(不是拉)。
         那是「不做**喊拉後不能拆牌**」的自然結果,而且退回去之後再回到拉會**再響一次**
         —— 真人牌桌也是這樣(他又只剩一手了,本來就該再喊)。
     ========================================================================== */
  let laPrev = null, laKey = "";

  /* 「拉~」的聲音。★ 照台灣麻將 sfx.js 的做法註冊成一格 Sound 音效槽:
     mp3/big2/la.wav|.mp3 有檔就播檔、沒檔就用合成音墊。
     語音檔由 `tools/gen-big2-voice.ps1` 產生(與台灣麻將的喊牌同一套:OneCore 語音
     + 裁前後靜音 + 音量正規化),**不用瀏覽器的 speechSynthesis** —— 理由見那支檔頭。

     ⚠⚠ **一定要帶 `{ el:true }`(v1.81.1 補的,第一版漏了)。**
       使用者是**直接用瀏覽器開 index.html**(`file://`),那時 `fetch` 被瀏覽器擋掉
       → 沒有 el:true 的音效槽**永遠載不到音檔**,只會退回合成音。
       台灣麻將每一格語音槽都帶著它,漏掉的症狀是「我明明放了檔案卻沒聲音」,
       而且**在 http:// 下測不出來**。守門:單機 e2e D6 ⑧ 直接量註冊時傳了什麼。
     ⚠ 音檔進了 mp3/ 就要補 sw.js 的 CORE(CLAUDE.md:改 mp3 路徑四處一起改) ——
       CORE 的 addAll 是全有全無,列了不存在的檔會讓離線整批失敗,所以
       **檔案與清單一定要同一版進去**。 */
  let laDefed = false;
  function laSynth(){
    /* 合成音後備:兩段上揚 + 尾音再滑上去,聽起來像喊出來的一聲。
       ★ 它不是主角(主角是語音檔),但**要壓得過同一瞬間的拍牌聲** ——
         「拉」與 place() 是同時發出的(真牌桌也是拍下去同時喊),所以音量刻意
         比一般音效高一階、尾音也拉長,否則會被那一下 click 蓋掉
         (使用者回報「還想要有音效」時,實際情況正是它響了但聽不出來)。
       ⚠ 用 tone() 自己的 delay / slideTo,不要用 setTimeout —— 那會脫離 AudioContext
         的時間軸,在背景頁籤被節流時整句會散掉。 */
    Sound.tone(494, { type: "triangle", dur: 0.11, vol: 0.30 });
    Sound.tone(659, { type: "triangle", dur: 0.34, vol: 0.32, delay: 0.10, slideTo: 988 });
  }
  function la(){
    if(typeof Sound === "undefined") return;
    if(!laDefed){
      laDefed = true;
      Sound.def("b2la", ["mp3/big2/la.wav", "mp3/big2/la.mp3"], laSynth, { el: true });
    }
    Sound.sfx("b2la");
  }

  /* ---------- ★ 「Pass」也喊出來(v1.81.1;v1.83.0 從「不要」改成喊 Pass)----------
     使用者:「有人 pass 的話,也加入音效吧」→ 後來又要求「用 Pass 取代『不要』,
     顯示跟音效都要改成 Pass」。
     ⚠ pass **本來就有聲音**(共用的 `Sound.takeback()`,那顆「收回」音)——
       使用者要的是**聽得出來是 Pass**的那一聲,所以做法與「拉」一樣:
       動作聲之上再疊一層喊牌語音(台灣麻將「音效是動作聲、語音是喊牌」那條)。
     ⚠ 換字**不必改這裡一行程式**:音效槽的檔名沒變(mp3/big2/pass.wav),
       換的只有那個檔裡唸的字(`tools/gen-big2-voice.ps1` 的 $WORDS)。

     ⚠⚠ **這一聲的頻率與「拉」差一個量級,而那是這一段唯一需要小心的事**:
       「拉」一局最多響幾次;Pass 在 4 人局一輪常常 2~3 次,一局二三十次。
       台灣麻將刻意只給宣告動作配語音、摸打維持合成音,理由就是「一局響三十幾次,
       每次唸字會吵死人」。這裡的處理是**把音量壓在音檔裡**
       (`tools/gen-big2-voice.ps1` 給 pass 一個比較低的正規化峰值)——
       Sound 的音效槽沒有 per-slot 音量,所以只有這個位置壓得下來。
     ★ 覺得吵的話**把 mp3/big2/pass.wav 刪掉**就自動退回合成音,程式一行都不用改
       (音效槽的設計本來就是「有這個檔就播」)。 */
  let passDefed = false;
  function passSynth(){
    /* 下行兩音 = Pass。刻意與「拉」的上行完全相反,不看畫面也分得出是哪一件事。
       ⚠ 合成音是**事件的聲音**,不是那兩個字 —— v1.83.0 把字從「不要」換成 Pass,
         這兩個音刻意不動(換了只會讓聽慣的人以為出事)。
       音量比 la 低一階(它一局要響二三十次)。 */
    Sound.tone(392, { type: "triangle", dur: 0.09, vol: 0.16 });
    Sound.tone(294, { type: "triangle", dur: 0.16, vol: 0.15, delay: 0.08 });
  }
  function passCall(){
    if(typeof Sound === "undefined") return;
    if(!passDefed){
      passDefed = true;
      Sound.def("b2pass", ["mp3/big2/pass.wav", "mp3/big2/pass.mp3"], passSynth, { el: true });
    }
    Sound.sfx("b2pass");
  }

  /* ★★ 一手的聲音 —— **三個呼叫點共用這一份**(v1.81.1):
       單機我自己出牌 · 單機電腦出牌 · 連線收到別人那一手的 diff。
     ★ 兩層:動作聲(牌拍到桌上 / 收回)+ 喊牌語音,理由與台灣麻將逐字相同 ——
       真牌桌上兩個同時有,而且之後有人換掉音效檔時語音照樣疊上去。
     ⚠ 收成一份的理由與 announceLa 相同:三個點各寫一份「pass 要不要喊」遲早走鐘,
       而走鐘了三邊各自都不會壞、沒有東西抓得到。守門是三條「呼叫點忘了接」的突變。 */
  function moveSfx(isPass){
    if(typeof Sound === "undefined") return;
    if(isPass){ Sound.takeback(); passCall(); }
    else Sound.place();
  }

  /* 每次重畫都叫一次(單機 solo.paint() / 連線 adapter.paint() 各一行)。
     v = { st, names[], me, key } —— key 就是 render() 那個「這是哪一局」。 */
  function announceLa(v){
    const st = v && v.st;
    if(!st || !st.hands){ laPrev = null; return; }
    const now = B2.laSeats(st);
    /* ★ 換局 / 第一次 / 重連 → 只記住不出聲(見上面那段的四種情形)。
       ★ 這一局已經結束也不出聲:那時該說話的是結果卡。 */
    if(laPrev === null || v.key !== laKey || st.over){
      laKey = v.key; laPrev = now; return;
    }
    let hit = false;
    for(let s = 0; s < now.length; s++){
      if(!now[s] || laPrev[s]) continue;
      hit = true;
      /* ⚠⚠ 牌情紅線([16] 第五節):這裡**只准說「剩最後一手」**這一件事。
         絕對不可以帶牌型(「剩一個順子」)或張數以外的任何東西 ——
         「拉」公開的是**一個 bit**,那是規則要求的揭露,不是把手牌攤開。 */
      const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
      showToast(s === v.me ? "你剩最後一手了 —— 大家都看得到"
                           : (nm + " 剩最後一手了 —— 拉!"), 2200);
    }
    laPrev = now;
    /* ★ 一次重畫只響一聲:批次同步時有可能兩家同時進拉,響兩聲會疊成噪音。 */
    if(hit) la();
  }

  /* 晶片上的「拉」記號 —— 連線的 chipTail() 與單機的 paintBar() **共用這一份**
     (這一頁本來就有那組雙胞胎,新東西不要再加一對)。
     ⚠ 文字**恰好只有一個「拉」字**:牌型、張數、牌值一個都不准進來,連 title 也不行
       (title 跟畫出來沒兩樣)。e2e 有一條在掃 T_NAME 的六個字串。 */
  function laChipHTML(on, mine){
    if(!on) return "";
    return '<span class="b2-chla" title="' +
             (mine ? "你剩最後一手了(大家都看得到)" : "他剩最後一手了") + '">拉</span>';
  }

  /* ==========================================================================
     五、結果卡的排名表 —— ★ 唯一會翻開別人手牌的地方
     ==========================================================================
       ★ 兩個訊號**完全分開**(排七 v1.75.2 的教訓,使用者:「你會把第一名特別框起來,
         這樣很容易讓大家以為自己是第一名」):
           · 框 + 「你」徽章  → 這一列是我
           · 金色名次圈 + 🏆  → 這一列是第一名
       ★ 一列拆成**兩層**(排七 v1.75.3):主行的欄位固定(名次 / 名字 / 徽章 / [勝場] / 名次分),
         剩牌那一排寬度每個人都不一樣,擠進主行會讓每一列都對不齊。
       ★ 連線多一欄「累積分」(排七 v1.75.9):底數用 **開局快照 + 這局的加分** 算,
         **不可以當場讀 scores 節點** —— 那是結算之後才寫的,直接讀會少一筆,
         而且分數同步回來時沒有人會重畫這張卡。傳 null(單機)時那一欄整個不出現。
       ⚠ foot 是當 HTML 接在表下面的;要放使用者輸入的東西時呼叫端自己 esc()。 */
  function resultHTML(st, names, mySeat, foot, wins){
    const sc = R.score(st);
    return '<div class="b2-rank">' + sc.sorted.map(r => {
      const left = st.hands[r.seat].slice().sort(R.cmpCard);
      const me = r.seat === mySeat, first = r.rank === 1;
      const nm = names[r.seat] || ("玩家" + (r.seat + 1));
      const w = wins ? wins[r.seat] : null;
      return '<div class="b2-rrow' + (me ? " me" : "") + (first ? " win" : "") + '">' +
        '<div class="b2-rmain' + (w ? " has-win" : "") + '">' +
          '<span class="b2-rno">' + r.rank + '</span>' +
          '<span class="b2-rname">' + esc(nm) + '</span>' +
          // ⚠ 名字本身就叫「你」時(單機的 0 號位)不掛徽章 —— 「你 你」是純雜訊,
          //   而「這一列是我」還有框在標,訊號沒少
          (me && nm !== "你" ? '<span class="you-badge">你</span>' : "") +
          (first ? '<span class="b2-rcrown" title="第一名">🏆</span>' : "") +
          // ⚠ 這一格刻意**不用 🏆** —— 同一列的 🏆 已經是「這局第一名」,
          //   同一個符號兩個意思比兩張表還難懂
          (w ? '<span class="b2-rwin" title="累積分">' + w.n + ' 分' +
               (w.plus ? '<i>+' + w.plus + '</i>' : '') + '</span>' : "") +
          '<span class="b2-rpts"><b>' + r.pts + '</b> 分</span>' +
        '</div>' +
        '<div class="b2-rcards">' +
          (left.length
            ? '<span class="b2-rcn">剩 ' + left.length + ' 張</span>' +
              left.map(c => cardHTML(c, "tiny")).join("")
            : '<span class="b2-clean">出完了 ✨</span>') +
        '</div>' +
      '</div>';
    }).join("") + '</div>' +
    (foot ? '<div class="b2-rfoot">' + foot + '</div>' : "");
  }

  /* ==========================================================================
     六、選取
     ==========================================================================
       ★ 選好之後「這一組行不行」由**規則層**回答(B2.classify + B2.beats + B2.whyNot),
         盤面自己不判規則 —— 單機與連線各寫一份判斷遲早走鐘,而且走鐘了
         兩邊各自都不會壞、沒有東西抓得到(排七 whyNot 那條同一個道理)。 */
  function selInfoOf(st, hand){
    if(!sel.length) return { ok: false, txt: "" };
    const cls = R.classify(sel);
    const why = R.whyNot(sel, st);
    if(cls && !why)
      return { ok: true, type: R.T_NAME[cls.t],
               // 這一行的排序也走 sortShow —— 選好的順子在文字裡也要是「2 3 4 5 6」
               txt: "選好了:" + R.T_NAME[cls.t] + "(" + R.sortShow(sel).map(R.nameOf).join(" ") + ")" };

    /* ★★ 還沒湊成一手 → 講「還要再選幾張」(v1.79.1)。
       v1.79.1 起沒亮的牌點不起來,所以 sel **永遠是某一手合法出法的子集** ——
       那時 whyNot 講的話會是錯的:玩家湊順子湊到第二張時,它會說
       「兩張要同點數才是對子」。要講的是「再選 3 張」。
       ⚠ 這一格拿的是**中性**的樣子(不是紅的):選到一半不是錯。 */
    if(hand){
      const po = R.playable(hand, st, sel);
      if(po.need.length)
        return { ok: false, pending: true,
                 txt: "再選 " + po.need.join(" 或 ") + " 張就湊得成一手" };
    }
    /* 走到這裡代表 sel 湊不出任何一手 —— 正常操作**到不了**(每一次點擊都驗過),
       留著是給 setSel() 那條路(工具 / 測試)與哪天守衛被繞過時還有話可說。 */
    return { ok: false, txt: why, type: cls ? R.T_NAME[cls.t] : undefined };
  }

  /* ==========================================================================
     七、掛載
     ========================================================================== */
  function mount(h){
    stage = $("b2Stage");
    acts = $("b2Acts");
    hCard = h.onCard; hAct = h.onAct;
    if(stage){
      stage.addEventListener("click", e => {
        const el = e.target.closest(".b2-card");
        if(!el || !hCard) return;
        // 手牌區以外的牌(牌河、結果卡縮圖)不吃點擊
        if(!el.closest(".b2-hand")) return;
        /* ★ 剛剛那一下是拖曳(而且真的換到別的位置)→ 這一下不算點擊。
           旗標在 pointerdown 一律會被清掉,所以它不可能漏到下一次點擊(第八節)。 */
        if(noClick){ noClick = false; return; }
        hCard(+el.dataset.c);
      });
      bindDrag();
    }
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest(".b2-act");
        if(b && hAct) hAct(b.dataset.act);
      });
    }
  }

  /* ==========================================================================
     八、★★ 拖曳排序 —— 玩家自己排手牌(v1.80.0)
     ==========================================================================
       使用者:「我們有沒有辦法可以拖曳自己的手牌順序,有時候這樣可以幫助思考」

       ★★ 順序是**純本地的顯示**:不進 DB、不進 moves、不影響任何判定
          (見 rules.js 的 applyOrder)。三個直接的後果:
            · 連線時新舊版可以同房 —— 兩台各自顯示自己想看的順序,moves 一模一樣
            · **不是自己的回合也拖得動**(「幫助思考」大半發生在等對手出牌那段時間)
              → 所以這裡刻意**不經過** Solo.tap / MP.tap,那兩支有「還沒輪到你」的守衛
            · 不持久化:換局就回到照牌力排(存下來沒有意義,手牌整副換了)

       ── ★★ 為什麼保留 click、把拖曳疊在上面 ────────────────────────────────
         既有四支 e2e **全部用 `el.click()` 驅動選牌**(gen-big2-solo-e2e.js 的 handEl),
         而合成的 .click() **不會產生 pointer 事件**。所以不可以照五子棋
         (js/gomoku/board.js 的 bindGestures)把 tap 判定搬進 pointerup ——
         一搬,那些選牌斷言會整批變紅。拖曳只負責排序,
         「這一下算不算點擊」用 noClick 這個旗標交接:
           · pointerdown **一律先清掉**旗標 → 它絕對不會漏到下一次點擊
           · 放手時**位置真的變了**才設旗標
             ⚠ 只是手抖十幾 px 而沒換到別的位置 → 照樣算點擊。
               手機上手抖比「刻意拖回原位」常見得多,而「按了沒反應」是使用者會
               直接判定成壞掉的那一種。

       ── ★ 三個實作上的選擇,都有替代方案被否決 ──────────────────────────────
         ① 跟著手指走用 **inline style 的 transform**
            —— .b2-card 有四條規則在搶 transform(:hover / :active / .sel / .sel:active),
               inline 一律壓得過它們,不必打權重戰(CLAUDE.md「CSS 會撞的第二類」)。
         ② 換位一律 **insertBefore,排版交給 flex**,不自己算座標
            —— 手牌是 flex-wrap,窄螢幕會折成兩行;自己算座標要處理換行,
               而 insertBefore 在兩行之間天然就對,也天然守住 --b2-slots 的固定格位。
         ③ 命中判定用**幾何**(逐張量 rect),不用 document.elementFromPoint
            —— 被拖的那張自己就蓋在手指底下,elementFromPoint 一律只打到它;
               改成 pointer-events:none 又會讓 pointer capture 的行為依賴瀏覽器實作。
               手牌只有 13~26 張,逐張量最穩。

       ⚠ 觸控要靠 CSS 的 `touch-action:none`(styles.css 的 .b2-hand .b2-card):
         .b2-stage 是 overflow-y:auto 的捲動容器,不關掉的話手指往下滑會被捲動搶走
         (瀏覽器會發 pointercancel,拖曳當場斷掉)。代價是手指按在**牌上**時捲不動盤面
         —— 牌河那一大塊與牌的縫隙都還按得到,而「拖到一半忽然變成捲動」是壞掉。
     ========================================================================== */
  const DRAG_SLOP = 11;                     // 位移超過這麼多 px 才算拖曳(不到就是一般點擊)

  function cardsIn(box){
    return [...box.children].filter(el => el.classList.contains("b2-card"));
  }

  /* 這張牌**沒有 inline transform 時**在哪一格。
     ⚠ 每一次移動都要重量:insertBefore 之後它的格位就換了,拿舊的算會讓牌從手指下面跑掉。 */
  function slotRect(el){
    const t = el.style.transform;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    el.style.transform = t;
    return r;
  }
  /* 讓牌停在「手指按下去時抓的那個點」上 —— 不是置中到手指,不然一開始拖會彈一下。

     ⚠⚠ 位置要**夾在盤面裡**(v1.80.0,看圖才發現的):`.b2-stage` 是
       `overflow-y:auto; overflow-x:hidden` 的捲動容器,牌一旦被拖出它的邊界就會
       **被裁掉一角、甚至整張消失** —— 而消失的那一張正是手指按著的那一張,
       看起來就是「牌被我弄丟了」。(截圖 tools/shot/big2-dragedge.png 抓到的;
       CLAUDE.md「CSS 會撞的四類」的第四類:捲動容器的裁切邊。)
     ★ 夾的只有**畫**:命中判定(dropAt)照樣吃原始的手指座標,
       所以「手指推出左緣 → 目標是第一格」這件事完全不受影響 ——
       牌停在邊上、順序照樣換得過去。 */
  function follow(x, y){
    const r = slotRect(drag.el);
    const sc = stage.getBoundingClientRect();
    const nx = Math.max(sc.left, Math.min(x - drag.gx, sc.right - r.width));
    const ny = Math.max(sc.top, Math.min(y - drag.gy, sc.bottom - r.height));
    drag.el.style.transform =
      "translate(" + (nx - r.left) + "px," + (ny - r.top) + "px)";
  }

  /* 指標下方是哪一張**別的**牌 → 插在它前面還是後面。
     ★ 換完位之後手指底下那一格就是被拖的那張自己(它被跳過)→ 不會來回震盪。 */
  function dropAt(x, y){
    const kids = cardsIn(drag.box);
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
    drag = null;                            // ★ 先清掉:下面的 render() 才進得去
    d.el.classList.remove("b2-drag");
    d.el.style.transform = "";
    try{ d.el.releasePointerCapture(d.id); }catch(e){}
    /* 順序直接**從 DOM 讀回來** —— 拖曳過程中 DOM 就是唯一的真相(一路 insertBefore)。
       ⚠ 這裡刻意**不重畫**:DOM 已經是想要的樣子,而重畫會把手指剛放開的那個節點銷毀,
         click 就不一定發得出來 → noClick 旗標會漏到下一次點擊。 */
    if(!cancel && d.on && stage.contains(d.el)){
      const now = cardsIn(d.box).map(el => +el.dataset.c);
      if(now.join(",") !== d.was.join(",")){ ord = now; noClick = true; }
    }
    // 拖曳中被擋掉的那次重畫要補回來 ⚠ 要等 click 發完,所以是 setTimeout 而不是直接呼叫
    if(d.dirty && lastV) setTimeout(() => render(lastV), 0);
  }

  function bindDrag(){
    stage.addEventListener("pointerdown", e => {
      noClick = false;                      // ★ 一律先清:旗標絕不會漏到下一次點擊
      if(drag) return;                      // 已經在拖了(第二根手指)→ 不理它
      if(e.button > 0) return;               // 只吃主鍵
      const el = e.target.closest(".b2-card");
      if(!el) return;
      const box = el.closest(".b2-hand");
      if(!box) return;                       // 牌河 / 結果卡縮圖的牌不拖
      const r = el.getBoundingClientRect();
      drag = { id: e.pointerId, el: el, box: box,
               x0: e.clientX, y0: e.clientY,
               gx: e.clientX - r.left, gy: e.clientY - r.top,
               was: cardsIn(box).map(k => +k.dataset.c),
               on: false, dirty: false };
      /* 捕獲指標:手指滑出那張牌之後還要收得到 move / up。
         ★ 包 try 是**純防禦**:規格上 pointerId 不是活著的指標時要丟 NotFoundError,
           而 e2e 餵的是合成事件 —— 一丟出來,整條拖曳就變成「靜靜地不存在」。
         ⚠ 但**實測 headless Edge 不會丟**(合成 pointerId 照樣捕獲得到),
           所以這一行**殺不掉的突變**刻意沒有放進 mut-big2-e2e.js ——
           一條永遠存活的突變會讓那份清單失去意義。
           別的引擎會不會丟沒有驗過,而丟了的代價很高,所以 try 留著。 */
      try{ el.setPointerCapture(e.pointerId); }catch(err){}
    });

    stage.addEventListener("pointermove", e => {
      if(!drag || e.pointerId !== drag.id) return;
      if(!stage.contains(drag.el)){ endDrag(true); return; }   // 保險:節點被抽掉了
      if(!drag.on){
        if(Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_SLOP) return;
        drag.on = true;
        drag.el.classList.add("b2-drag");
      }
      const t = dropAt(e.clientX, e.clientY);
      if(t) drag.box.insertBefore(drag.el, t.before ? t.el : t.el.nextSibling);
      follow(e.clientX, e.clientY);
    });

    stage.addEventListener("pointerup", e => {
      if(drag && e.pointerId === drag.id) endDrag(false);
    });
    stage.addEventListener("pointercancel", e => {
      if(drag && e.pointerId === drag.id) endDrag(true);
    });
    /* 瀏覽器把捕獲收回去(節點被移走 / 手勢被別人接手)→ 當成取消,不要留半套。
       ⚠ 自己 releasePointerCapture() 也會觸發它,但那時 drag 已經是 null 了。 */
    stage.addEventListener("lostpointercapture", e => {
      if(drag && e.pointerId === drag.id) endDrag(true);
    });
  }

  return {
    mount, render, renderActs, resultHTML, stopCd, selInfoOf,
    cardHTML,
    // 「拉」(v1.81.0):公告 · 晶片記號 · 單獨播那一聲(單機與連線共用)
    announceLa, laChipHTML, la,
    // 一手的聲音(v1.81.1):動作聲 + 喊牌語音,三個呼叫點共用
    moveSfx,
    sel: () => sel.slice(),
    toggleSel(c){
      const i = sel.indexOf(c);
      if(i >= 0) sel.splice(i, 1); else sel.push(c);
    },
    setSel(arr){ sel = (arr || []).slice(); },
    clearSel(){ sel = []; },
    // 給 e2e 用:玩家自訂的顯示順序(沒拖過 = null)
    _ord: () => (ord ? ord.slice() : null)
  };
})();

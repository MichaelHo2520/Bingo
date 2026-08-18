"use strict";

/* ============================================================================
   21 點 — 盤面(BJB)。牌桌 / 莊家 / 其他閒家 / 我的手牌 / 動作列 / 結果卡都在這裡畫。

   ── ★★★ 尺寸由 planTable() **一支**算(v1.87.0 的 fitTable,v1.88.1 改名並多挑「一列幾格」)──
     v1.86.0 之前是「牌寬交給 CSS 的係數、格高由 JS 平分」→ **兩份真相**,
     視窗一矮就變成「格子 32px、牌高 71px」= 每一張牌都被切掉一截
     (使用者:「玩家的牌沒有完整顯示」)。v1.87.0 把牌寬 / 格高 / 莊家台高度
     收成 planTable() 一支算出來的三個 literal,格高 = 牌高 + 固定裝潢 →
     **裁不到牌**,而且莊家 / 我 / 其他閒家**同一個牌寬**。
     ⚠ 它只吃「人數 + 視窗」→ 一整局是常數。**不可以**讓它跟著「牌數」變 ——
       那才是台灣麻將那一整類「忽大忽小」的來源。

   ── ★★ 牌情紅線(v1.86.0 起是 **n 條**,不是一條)────────────────────────────
     > **莊家的第 2 張 + 每個「不是我」的閒家的第 1 張,在翻開之前不可以畫出來。**
     這一頁的隱藏與前七個遊戲**性質相反**:前面那些是「防偷看」(牌在 DB 是明碼,
     顯示端不畫),這幾張是**規則本身**要求蓋著(台式的底牌)—— 它有固定的位置、
     要看得出「那裡有一張牌,只是還沒翻」,所以用 `PKFace.backHTML()` 畫牌背。

     ★★ 判斷式**只有 `BJ.openTo` / `BJ.hiddenIdx` / `BJ.shownCards` 三支**(rules.js)。
        ⚠⚠ 絕對不可以在這裡自己寫「他大概停手了吧」之類的近似條件:
          那種條件遲早與規則層錯開,而錯開的方向是**提早翻牌 = 洩漏牌情**。
     ⚠ v1.85.0 的「其他閒家全程明牌」已經被**推翻**(使用者要真實感)——
       不要照舊文件改回去。

     守門用一條**精確的不變量**(不是關鍵字比對):
         盤面上的 .bj-card.back 張數  ===  Σ (BJ.hiddenIdx(st, s, me) >= 0)

   ── ★★ 「位置不准跳」的三件事 ─────────────────────────────────────────────
     ① 牌寬 / 一格的高度 / 莊家台的高度 / **一列幾格** 只有 planTable() 一個來源,而它只吃
        「人數 + 視窗」→ 補一張牌不會讓任何東西換大小
     ② 牌桌 `flex:1 1 auto`(吃掉盤面剩下的空間,但**不隨自己的內容變**)
     ③ 動作列 `.bj-acts` 固定高度 `--bj-acth`(下注鈕 / 三顆動作鈕 / 一行字 / 倒數環 /
        **抓人那一列** 換來換去,高度不能跟著變)
   ========================================================================== */

const BJB = (function(){

  const R = BJ;
  let stage = null, acts = null;
  let hAct = null;                          // 按動作鈕的回呼(這一頁沒有點牌,只有按鈕)
  let cdKey = "", cdT = null, cdEnd = 0;    // 倒數環:用 key 去重,不看 timer(見 syncCd)
  /* ★★ 「還沒送出去的押注金額」住在這裡(v1.85.0 的加減鈕)。
     ★ 它是**純畫面狀態** —— 不進 DB、不進 st、不影響任何判定,所以放在盤面這一層
       就只有一份;放進 solo.js 與 adapter.js 就是兩份(這個專案最痛的那類走鐘)。
     ★ 刻意**跨局保留**(黏著上一局押的數字):每一局都彈回 1 的話,
       想固定押 5 的人每一局都要重按四次。
     ⚠ 一定要在畫的時候夾一次 [1, betMax] —— 房規的上限改小時舊的數字會超出範圍。 */
  let betPend = R.MIN_BET;
  let lastInfo = null;                      // 加減鈕只動 betPend → 用它原地重畫一次動作列
  /* ★★ 「抓人」那一排展開了沒(v1.86.0)。與 betPend 同一類:**純畫面狀態** ——
     不進 DB、不進 st、不影響任何判定,所以住在盤面這一層就只有一份。
     ⚠ 換局 / 換相位 / 抓完一家都要收掉,不然下一段會頂著一排名字鈕。 */
  let grabOpen = false;
  /* ★★ 「一局結束的過場」開著沒有 / 開的是哪一局(v1.92.0,見八之四)。
     與 betPend / grabOpen 同一類:**純畫面狀態**,不進 DB、不進 st、不影響任何判定。
     ⚠ handKey 是**去重**用的:過場開著的時候每一次 paint 都會叫 showHand 一次
       (連線一個快照一次),沒有它結算聲會一直重播。
     ⚠ hSkip 是呼叫端給的「按下去要做什麼」(單機 = 立刻換局 / 連線 = 送一筆「繼續」);
       hVoted 是「我按過了沒」—— 只給「再按一次要說得出原因」用,**真相在呼叫端**
       (連線是 DB 的 `bj.nx`,而 showHand 每次都會把它餵進來)。
     ⚠ v1.94.0 的 handDone 旗標**拿掉了**:它當初擋的是「本地先收掉、advance 還在飛」
       那一下的閃回來,而 v1.95.0 起按了**不收畫面**(要留著看還在等幾人)。 */
  let handKey = "", handOn = false, hSkip = null, hVoted = false;

  /* ==========================================================================
     一、牌面
     ──────────────────────────────────────────────────────────────────────────
       花色與牌面都在 js/shared/pk-faces.js(與排七 / 大老二共用同一份)。
       ⚠ 撲克牌 Unicode(U+1F0A0 那一段,含 🃏 = U+1F0CF)一個都不准用:
         多數字型沒有,會變豆腐方框。要圖示一律 🎴(U+1F3B4)。
       ★ 牌背(v1.84.0 為這一頁加的 PKFace.backHTML)是這個專案第一次需要畫「蓋著的牌」。
     ========================================================================== */
  function cardHTML(c, cls){
    return PKFace.cardHTML({
      prefix: "bj", suit: R.SUIT_KEY[R.suitOf(c)], rank: R.rankTxt(R.rankOf(c)),
      red: R.isRed(c), cls: cls, data: c
    });
  }
  const backCard = cls => PKFace.backHTML({ prefix: "bj", cls: cls });

  /* 一排牌。★ 第 hidx 張畫**牌背**(-1 = 全部翻開)。
     ⚠⚠ hidx 一律由呼叫端從 **BJ.hiddenIdx(st, seat, me)** 拿 —— 這一支自己不判斷
       任何相位,而且畫面端**絕對不可以**自己算「他大概停手了吧」那類近似條件。
       v1.86.0 起蓋著的不只莊家:每個非我閒家的**第一張**也蓋著(見 rules.js 六之三)。 */
  /* ⚠ `m` 是**純畫面**的動效記號(v2.4.5,見六之三):`m.just` 起的那幾張是這一次
     才多出來的、`m.flip` 那一張是剛從牌背翻開的。它一個位元都不影響牌情:
     蓋不蓋著仍然只看 `hidx`(而 hidx 一律由呼叫端從 `BJ.hiddenIdx()` 拿)。 */
  function cardsHTML(cards, cls, hidx, m){
    if(!cards || !cards.length) return "";
    const k = (hidx === undefined || hidx === null) ? -1 : hidx;
    let h = "";
    for(let i = 0; i < cards.length; i++){
      let c2 = cls || "";
      if(m){
        if(m.just !== undefined && i >= m.just) c2 += " just";
        if(m.flip === i && i !== k) c2 += " flip";
      }
      h += (i === k) ? backCard(c2) : cardHTML(cards[i], c2);
    }
    return h;
  }
  /* 某個座位的一手牌 + 它的點數膠囊 —— ★ 牌情只在這兩支裡落地。 */
  function handOf(st, seat, me, cls){
    if(!st) return "";
    return cardsHTML(st.hands[seat], cls, R.hiddenIdx(st, seat, me),
                     fxMark ? fxMark[seat] : null);
  }

  /* 點數膠囊。★ 雙值(「7 / 17」)一律走 BJ.valueTxt —— 這一頁**不准**自己算點數
     (那是「畫面說 17、系統判我爆」那類兩份真相的來源,見 rules.js 第三節)。
     ⚠ 莊家還沒翻牌時只能算**明牌那一張**,不可以拿整手去算(算了就是把暗牌洩漏成數字)。 */
  function pipHTML(cards, tier, bust, partial){
    if(!cards || !cards.length) return '<span class="bj-pt">–</span>';
    const txt = R.valueTxt(cards);
    let cls = "bj-pt";
    if(bust) cls += " bust";
    else if(tier === R.T_DRAGON) cls += " dragon";
    else if(tier === R.T_BJ) cls += " bj";
    /* ⚠ partial = 「這個數字只算了明牌那一張」(莊家還沒翻牌)。
       ★ 一定要寫成「4 + ?」而不是「4+」—— 看圖才發現的:「4+」讀起來像「4 以上」,
         而它真正的意思是「4 再加上一張還不知道的牌」。 */
    return '<span class="' + cls + (partial ? " part" : "") + '">' + txt +
             (partial ? ' <b>+ ?</b>' : "") +
             (bust ? ' <i>爆</i>' : (tier === R.T_BJ ? ' <i>21點</i>' :
              (tier === R.T_DRAGON ? ' <i>過五關</i>' : ''))) +
           '</span>';
  }

  /* 這個座位的點數膠囊。★ 只算**看得到**的那幾張,還有暗牌就標「+ ?」——
     莊家的「4 + ?」與閒家的「9 + ?」是**同一條規則**(v1.86.0 統一)。
     ⚠ 拿整手去算等於把暗牌換成數字洩漏出去。 */
  function ptOf(st, seat, me){
    if(!st) return pipHTML(null);
    const open = R.openTo(st, seat, me);
    const shown = R.shownCards(st, seat, me);
    return pipHTML(shown, open ? st.tier[seat] : R.T_NORM,
                   open && R.valueOf(st.hands[seat]).bust, !open);
  }

  /* 這個座位的狀態記號。★ 每一種都是**公開資訊**:
     停手 / 被抓都是全桌看得到的動作(被抓的人牌也翻開了)。

     ── ★★★ v1.88.1:這一格**只留「點數膠囊講不出來的事」**─────────────────────
       使用者:「下方的資訊…重新評估一下,到底需要顯示什麼資訊,來防止寬度不夠」。
       整格的資訊搬到頭列右邊之後,寬度只有 ~168px(390px 一列 2 格),所以
       **每一個字都要有存在理由**。拿掉兩種:
         ① 「💥 爆了」—— 點數膠囊本來就寫著「爆」而且是紅底(`pipHTML` 的 bust)
            → 同一件事講兩次,而它是最占寬度的那一個(截圖裡的「25 爆」+「💥 爆了」)。
         ② 「考慮中… / 等待…」—— 閒家是**同時**補牌,所以「沒停手的每個人都是考慮中」
            = 零資訊量;而「現在在等誰」已經有三個地方在講:格子的亮框 `.act`、
            動作列那句提示、倒數環。
       ⚠ 「✋停」與「🎯莊N」**不可以**再拿掉:那是點數膠囊講不出來的兩件事
         (停手 = 他不會再變;被抓時莊家幾點 = 同一局每個人比的點數可能不一樣)。
       ⚠ 下注階段那兩句**要留**:那一段沒有牌、寬度很鬆,而它是那一段唯一的資訊。 */
  function stateHTML(st, s, betPhase, betDone){
    if(betPhase) return betDone ? '<span class="bj-st ok">已下注</span>'
                                : '<span class="bj-st wait">下注中…</span>';
    if(!st) return "";
    // ★ 被抓:講得出「被抓時莊家幾點」—— 同一局每個人比的莊家點數可能不一樣
    if(st.caught[s] >= 0){
      const dh = R.seatCards(st.cards, st.n, st.dealer, st.caught[s]);
      return '<span class="bj-st caught" title="被抓時莊家的點數">🎯莊' +
               R.valueOf(dh).best + '</span>';
    }
    if(st.hands[s] && R.valueOf(st.hands[s]).bust) return "";   // ★ 膠囊已經寫著「爆」
    if(st.done[s]) return '<span class="bj-st ok" title="他停手了">✋停</span>';
    return "";                                                   // ★ 亮框在講「輪到他」
  }

  /* ★ 玩家晶片尾巴:「莊」記號 + 手上的籌碼 —— ★★ 單機與連線**共用這一份**。
     ★★ v1.85.0 把它收成一支的理由(使用者:「顯示每個人剩下多少籌碼,
        這部分的配色需要可以讓籌碼看的明顯一點」):
        籌碼那一格原本在 solo.js 的 paintBar 與 adapter.js 的 chipTail **各寫一份**,
        兩份的配色要一起改才會一致 —— 那正是這個專案最痛的那類走鐘,所以先併起來再改色。
     ★ 兩樣都是**公開資訊**(誰當莊全場都看得到;籌碼是結算過的歷史)。
     ⚠ 這一格一個字都不准提牌 —— 這一頁唯一藏起來的是莊家那張暗牌,而它在盤面上。
     · chip 手上的籌碼(= 起始 + 淨變化)

     ── ★★★ v1.92.0:後面那一格「±N」拿掉了 ──────────────────────────────────────
       使用者:「最上方的房間框裡面只要顯示最後有多少錢,不要再顯示後面的加減多少」。
       ★ 理由不只是長度(6 人 + 座位號 + 🎩 + 💰 + ±N 一列本來就很擠),而是**一格一件事**:
         晶片列答的是「他**現在**有多少錢」,而「這一把賺賠多少」從這一版起由**過場**
         (showHand,見八之四)專門講 —— 那正是使用者說「有點不太明確」的那件事。
       ⚠ 淨變化沒有消失,它還在**兩個**地方:過場那一列的 ±N、結果卡排名表的 ±N 欄。
       ⚠ 參數也一起拿掉(不是留著不畫):留著的話呼叫端會繼續算一個沒人用的數字,
         而下一個人讀到 `chipHTML(chip, net, …)` 只會以為是漏畫了。 */
  function chipHTML(chip, isDealer, seat){
    return (typeof seat === "number" && seat >= 0 ? snHTML(seat) : "") +
           (isDealer ? '<span class="bj-chd" title="這一局的莊家">🎩 莊</span>' : "") +
           '<span class="bj-chc" title="手上的籌碼">💰<b>' + chip + '</b></span>';
  }

  /* ★★★ 座位號碼(「第幾家」)—— v1.88.0 加的,**單機與連線共用這一支**。
     使用者:「不應該…看你是第幾家,然後順序就應該是怎樣嗎?」
     → 輪莊改成照座位號循環之後,號碼**一定要看得到**:看不到的話「照號碼往下輪」
       這件事在畫面上等於不存在,而那正是原本那句抱怨的來源。
     ★ 一律 1-based(玩家講的是「第 3 家」不是「2 號位」);顏色沿用 p0..p5 那一組。
     ⚠ **不要**用 ①②③ 那種圈碼字元(U+2460 那一段):它不在被禁的牌面區,
       但字型一樣有缺、而且第 7 家以後就沒得用 —— 圈圈用 CSS 畫最穩。 */
  const snHTML = s => '<span class="bj-sn p' + s + '" title="第 ' + (s + 1) + ' 家">' +
                        (s + 1) + '</span>';

  /* ==========================================================================
     二、莊家那一格(牌桌最上面)
     ──────────────────────────────────────────────────────────────────────────
     ── ★★★ v1.90.0:改回**兩列**(頭列 + 牌列),與注區一格結構完全一樣 ──────────
       使用者:「莊家你看一下,裡面有很多資訊是重覆了…另外有發生因為牌多一點,
       然後字被擠到外面去了」。兩件事其實是同一個根:

       ① **一列排不下**。v1.87.0 的莊家台是橫排「牌 | 名字+副標 | 點數」,而牌是
          `flex:none` —— 莊家補到 4~5 張時那一排就吃掉整條寬度,右邊的名字與點數
          被**推出可視範圍**(390px 手機 + 牌寬 68:5 張 = 360 > 一格的 336)。
          ⚠ 修法**不可以**是「讓牌縮一點」:那會破掉 v1.87.0 的「每一張牌一樣大」。
            牌列自己占一整列就永遠不必跟文字搶寬度(注區一格早就是這樣了)。
       ② **同一件事講兩次**。副標 `.bj-dsub` 吃的是 `hintOf()` —— 與動作列那一句
          **逐字相同**(截圖裡上下各一份「這一局你當莊,不用下注 —— 等大家押完」)。
          → 整條拿掉,「現在在等什麼」只留動作列那一份。
          同理拿掉「莊家」文字標籤(🎩 已經在講同一件事)與「你」徽章
          (我當莊時名字直接寫「你」,同 v1.88.1 注區那條)。

     ── ★★ 莊家是誰,**下注階段就要看得到** ────────────────────────────────────
       下注時 `st` 是 null(還沒發牌),舊版因此只畫得出一個沒有名字的「莊家」,
       而**莊家自己那一格照樣被畫進注區** → 同一個人同時出現在兩個地方
       (使用者:「如果我當莊家時,應該沒有必要兩個地方都顯示一樣的資訊」)。
       ★ 所以呼叫端多傳一個 `dealer`(座位號),兩段共用 `dealerOf()` 一支解讀。
       ★ 這是**公開資訊** —— 晶片列上早就標著「🎩 莊」,牌情紅線一個字都沒鬆。
       ★★ 附帶修掉一件量得到的事:注區的格數本來會從 n(下注)掉到 n−1(發牌),
          而格數是 planTable 的輸入 → **發牌那一刻整桌的牌會換一次大小**。
     ========================================================================== */
  /* 這一局誰當莊。★ 唯一的解讀點:發牌後問 st,下注階段問呼叫端傳的 dealer。 */
  const dealerOf = v => v.st ? v.st.dealer
                             : (typeof v.dealer === "number" ? v.dealer : -1);
  function dealerHTML(v){
    const st = v.st, d = dealerOf(v);
    const mine = d >= 0 && d === v.me;
    // ⚠ 我當莊時名字寫「你」(不是我的暱稱)—— 於是「你」徽章就不必存在了
    const nm = mine ? "你" : ((v.names && v.names[d]) || "莊家");
    /* ★★ 暗牌:蓋哪一張只問 BJ.hiddenIdx(唯一的判斷式)。
       ⚠ 例外只有一個:我自己就是莊家時那兩張都是我的牌 —— hiddenIdx 自己處理了。 */
    /* ⚠ v1.87.0 起**不挑尺寸 class** —— 牌桌上每一張牌都吃 --bj-cardw
       (使用者:「我要跟莊家的牌大小一樣」)。這裡塞 "dbig" 回去就是又變成兩份真相。 */
    const body = st && d >= 0 ? handOf(st, d, v.me, "")
                              : '<span class="bj-dwait">🎴 等發牌…</span>';
    return '<div class="bj-dealer' + (mine ? " me" : "") +
             (st && st.phase === "dealer" ? " act" : "") + '">' +
             '<div class="bj-dhd">' +
               '<span class="bj-crown" title="這一局的莊家">🎩</span>' +
               // ★ 座位號碼(v1.88.0):輪莊照號碼往下輪 → 莊家那一格也要標得出他是第幾家
               (d >= 0 ? snHTML(d) : "") +
               '<span class="bj-dnm">' + esc(nm) + '</span>' +
               /* ★ 右邊那一組與注區一格**同一個 class**(.bj-bmeta):
                  「他怎麼了」在兩個地方長得一樣,而且要縮的一律是左邊的名字。
                  ⚠ 下注階段 st 是 null → 這一組整個是空的(那一段沒有點數可講,
                    而「不用下注」動作列已經在講了)。 */
               '<span class="bj-bmeta">' +
                 (st && d >= 0 ? ptOf(st, d, v.me) : "") +
                 (st && d >= 0 ? stateHTML(st, d, false, false) : "") +
               '</span>' +
             '</div>' +
             '<div class="bj-dcs">' + body + '</div>' +
           '</div>';
  }

  /* ==========================================================================
     三、其他閒家(一列一人,★ 單行)
     ──────────────────────────────────────────────────────────────────────────
       ★★ 一列**只有一行**(名字 · 押注 · 狀態 · 牌 · 點數 全部橫排)。
          第一版是兩行(頭列 + 牌列),看圖才發現問題:一列 67px,
          5 人局要 4 列 = 268px,**第三列以下整個被裁掉**(而 DOM 量出來完全正常,
          因為 .bj-seats 是 overflow-y:auto —— 它靜靜地捲,不報錯)。
          單行 ≈ 43px → 4 列 172px,放得下。
          ⚠ 不可以為了「牌大一點」改回兩行:一列一人的重點是**一眼掃完全桌**,
            而別人的牌只需要「認得出點數」(那是 .sm 的 26px,見 .bj-card.sm)。

       ★★ **我自己那一列不畫在這裡** —— 我的牌在底下那一大塊(大牌 + 押注 + 點數),
          畫兩次是純重複(第一版真的畫了兩次,看圖才發現)。
          ⚠ 這不影響「手牌位置不准跳」:手牌貼底,而它上面的兩塊
            (.bj-mine 與 .bj-acts)都是寫死高度的 → 列數少一列只讓牌桌那一塊變矮,
            手牌一格都不動。(所以「我是莊 / 我不是莊」兩種局面列數不同是**沒問題的**。)
       ⚠ 但**同一局之內**列數必須固定 → 不可以改成「只列有牌的人」:
         那會讓發牌那一刻整桌撐開一次(大老二一路在修的「上上下下」)。
     ========================================================================== */
  /* 這一格現在抓得動嗎(抓人展開中 + 我真的是莊家 + 規則層說抓得動)。
     ★★ 判斷式一律問 `BJ.canGrab` —— 它裡面已經含「莊家到補牌線了沒」那一關,
        在這裡自己補一份近似條件就是兩份真相。
     ⚠ `me === st.dealer` 那一關是給「閒家的畫面」用的保險:抓人是莊家的動作,
       別人的格子一格都不該變成鈕。 */
  function grabbable(v, s){
    const st = v.st;
    return !!(grabOpen && st && v.me === st.dealer && R.canGrab(st, s));
  }
  /* 「他最後會是幾點」的區間 —— ⚠ 只吃 `R.shownCards()`(看得見的那幾張)。
     爆折成 22 → 顯示成「爆」:區間要講的是「會不會過」,不是「爆多少」。 */
  function rangeTxt(st, s, me){
    const rg = R.rangeOf(R.shownCards(st, s, me));
    return rg.lo + "~" + (rg.hi > 21 ? "爆" : rg.hi);
  }

  /* 一個注區。★ 我自己那一格獨占整列;★★ v1.87.0 起**每個人的牌同一個尺寸**
     (牌寬吃 --bj-cardw,由 planTable 一支算出來)—— 所以這裡一個 class 都不必挑。
     ⚠ 高度**不再由這裡的 inline style 給**:一格的高度 = 牌高 + 固定裝潢,
       同樣由 planTable 算(見它的註解:那正是「牌被裁掉」的根治法)。 */
  function boxHTML(v, s, basis){
    const st = v.st, mine = s === v.me;
    const nm = mine ? "你" : ((v.names && v.names[s]) || ("玩家" + (s + 1)));
    const bet = v.bets ? v.bets[s] : 0;
    const bust = !!(st && st.hands[s] && R.valueOf(st.hands[s]).bust &&
                    R.openTo(st, s, v.me));
    /* 「現在還在等他」——★★ v1.91.0 起**下注那一段也算**(還沒押注的人)。
       ★ 理由是語彙要一致:上緣那條會呼吸的青光條講的是「這一格還沒好」,
         而下注階段最需要知道的正是「還在等誰」(不然只剩一行小字「下注中…」)。
       ⚠ 莊家不押注,而他根本不畫在注區裡 → 不必特判。 */
    const turn = st ? (st.phase === "play" && !st.done[s])
                    : !!(v.betPhase && !(v.betDone && v.betDone[s]));
    const tgt = grabbable(v, s);
    let cls = "bj-box";
    if(mine) cls += " me";
    if(bust) cls += " bust";
    if(st && st.caught[s] >= 0) cls += " caught";
    if(turn) cls += " act";
    /* ★ 停手 = 這一格**定型了**(v2.4.5)。舊版只有右邊一個很小的「✋停」,
       而「誰已經不會再變」正是莊家決定要不要抓人時最先要掃過的東西。
       ⚠ 爆了 / 被抓已經各有自己的底色,不要再疊一層(那會變成三種紅褐色互相蓋)。 */
    if(st && st.phase === "play" && st.done[s] && !bust && st.caught[s] < 0) cls += " stood";
    /* ★★★ v1.87.0:抓人展開時**整格就是那顆鈕**(使用者:「我是想要直接在牌桌上點人」)。
       data-grab 是唯一的落點 —— mount 那邊只認它,不認 class(class 是給樣式看的)。 */
    if(tgt) cls += " target";
    /* ⚠⚠ v1.88.0:**每一格同寬**(連我自己那一格也是)—— 舊版我獨占一列(100%),
       而注區改成「嚴格照座位號碼排」之後,我排在中間就會把一列切成三段
       → 6 人算出 4 列,而列數一多牌就跟著變小(見 planTable)。
       ★ 「哪一格是我」現在只靠 .me 的金框 + 名字寫著「你」—— 牌的大小早在 v1.87.0
         就已經全桌一致(--bj-cardw),所以獨占一列本來就不再是為了牌大一點。
     ── ★★★ v1.88.1:一格只有**兩列**(頭列 + 牌),底下那一列拿掉了 ────────────────
       使用者:「閒家的卡片佈局,下方的資訊,是不是可以拿到右上方來顯示,然後重新評估
       一下,到底需要顯示什麼資訊,來防止寬度不夠」。
       ★ 頭列 = 左邊「他是誰」+ 右邊「他怎麼了」(`.bj-bmeta`):押注 · 點數膠囊 · 記號。
       ★ 附帶收益(而且是大的):裝潢少一整列 → `learnChrome()` 量到的 BOX_CHROME
         從 ~47 掉到 ~28 → 格高 = 牌高 + 裝潢 → **牌自動變大一階**,一行都不必調。
       ⚠ 右邊那組一律 `flex:none`,**要縮的是名字**(`.bj-bnm` 省略號)——
         名字是這一格最不重要的資訊(座位號碼已經標出他是誰)。
       ⚠ 「你」徽章拿掉了:`nm` 在 mine 時本來就是「你」→ 徽章是第二次講同一件事
         (截圖裡就是「6 你 你 押2」),而它白白吃掉 22px。 */
    return '<div class="' + cls + '" style="flex:0 0 ' + basis + '"' +
             (tgt ? ' data-grab="' + s + '" role="button" title="抓這一家先比較"' : "") + '>' +
             '<div class="bj-bhd">' +
               // ★ 座位號碼取代原本的色點(v1.88.0):顏色照舊,但看得出「我是第幾家」
               snHTML(s) +
               '<span class="bj-bnm">' + esc(nm) + '</span>' +
               // ⚠ 這個記號只講「抓不抓得動」(公開資訊),一個字都不准夾帶牌情
               (tgt ? '<span class="bj-gtip">🎯 抓</span>' : "") +
               '<span class="bj-bmeta">' +
                 (bet ? '<span class="bj-bet" title="這一局押多少"><i>押</i>' + bet +
                        (st && st.dbl[s] ? '<b>×2</b>' : '') + '</span>' : "") +
                 (st ? ptOf(st, s, v.me) : "") +
                 stateHTML(st, s, v.betPhase, v.betDone && v.betDone[s]) +
               '</span>' +
             '</div>' +
             '<div class="bj-bcs">' +
               (st ? handOf(st, s, v.me, "")
                   : '<span class="bj-bwait">🎴 等發牌…</span>') +
             '</div>' +
             /* ★★ 抓人時的**點數區間**(v2.4.5)。台式抓人最好玩的地方就是
                「他看得見的是 8,底下那張 1~11 → 9~18」,而那件事在這之前
                得玩家自己在腦子裡算。
                ⚠⚠ 一律走 `R.rangeOf(R.shownCards(...))` —— 那一支**只吃看得見的牌**,
                  結構上不可能把暗牌算進去(見 rules.js 那段註解)。
                ⚠ 它是**絕對定位**的,一個像素都不占版面:頭列的寬度預算早就滿了
                  (notes/17 的 hdOver 守門),往那裡加東西一定擠爆。 */
             (tgt ? '<span class="bj-grng">' + rangeTxt(st, s, v.me) + '</span>' : "") +
           '</div>';
  }

  /* ★★ 注區怎麼排(v1.86.0,使用者第 ② 點:最多三列、人多就縮高度往下疊)
       · **一列 2 格**(390px 下一格 177px,放得下 4 張牌不換行 —— 一列 3 格只放得下 2 張)
       · **我獨占一列**(牌用原尺寸)
     → 列數 = 1 + ⌈(閒家數 − 1) / 2⌉:6 人 3 列 · 4 人 2 列 · 2 人 1 列,**永遠 ≤ 3 列**,
       所以連上限判斷都不必寫。
     ⚠⚠ flex-basis 一定要寫成 **literal**:`calc((100% - (var(--x) - 1) * 7px) / var(--x))`
       在 Chromium 裡整條 flex 宣告會被丟掉(calc 不接受除以 var()),而症狀不是報錯 ——
       是格子照內容長、一列塞不進去的那格被**靜靜擠掉**(施工中真的踩到)。 */
  const BOX_FIT = 2, BOX_GAP = 7;
  const boxBasis = fit => (fit <= 1) ? "100%"
    : ("calc((100% - " + ((fit - 1) * BOX_GAP) + "px) / " + fit + ")");
  /* ★★★ v1.88.0:一格幾寬 / 幾列 收成這一支(★ 只吃**人數 + 視窗**,所以一整局不變)。
     ⚠ 「我獨占一列」拿掉了 —— 嚴格照座位排的話它會憑我的座位號決定列數
       (6 人時最壞 4 列),而牌的大小是照列數算的 → 又開始裁牌。
     ⚠ 中途加入的人(meOut)那一格是整列寬 → 它自己算一列。

     ── ★★★ v1.88.1:「一列幾格」改成**挑牌最大的那一種**(不再寫死 2)────────────
       同一版把一格的底列拿掉了(資訊搬到頭列右邊)→ 一格的裝潢從 ~57 掉到 ~37,
       **高度就空出來了**;而手機上牌寬是被「一列 2 格」卡住的(390px → 一格 178px
       → 5 張牌只能 31px)。兩件事湊起來的結果是「牌沒變大,底下多一塊空白」。
       ★ 所以這裡改成**把候選版型都算一遍,挑牌最大的**:
           3 人(2 個閒家)一列 1 格 → 牌 68px(原本 31px)
           6 人(5 個閒家)一列 2 格 → 牌 31px(一列 1 格會變 29 → 還是 2 格勝)
         決策只吃「人數 + 視窗 + 裝潢」→ 一整局是常數(這條紅線沒有鬆)。
       ⚠ 放不下的候選要**淘汰**(`over > 0`):CARD_MIN 夾過之後總高可能超出注區,
         那時它會靜靜地捲掉一列 —— 全部都放不下時挑「超出最少」的。 */
  function evalPlan(fit, boxes, extraRow, H, W){
    const rows = Math.max(1, Math.ceil(boxes / Math.max(1, fit))) + (extraRow ? 1 : 0);
    const inner = W - TABLE_PAD * 2;
    const bw = (fit >= 2) ? (inner - BOX_GAP * (fit - 1)) / fit : inner;
    const byW = (bw - BOX_PADX - (MAXC - 1) * CARD_GAP) / MAXC;
    const avail = H - TABLE_PAD * 2 - ROW_GAP - (rows - 1) * BOX_GAP;
    /* ★★ v1.90.0:莊家台也是「牌高 + 裝潢」了(它改成兩列 = 與一格同構),
       所以這裡扣的是 DEALER_CHROME 而不是舊的 DEALER_PAD,而它一樣是**量回來的**。 */
    /* ⚠ 每一列**留 1px 安全邊**:牌高是 `round(cw × 1.42)`,而 round 有可能往上湊
       半個 px;一格與莊家台各吃一次,列數一多就變成注區靜靜地捲幾 px
       (診斷器印 `boxesOver=4 WARN-BOX-ROW-LOST`)。少 1px 的牌寬換「一定放得下」。 */
    const byH = (avail - DEALER_CHROME - rows * BOX_CHROME) / (rows + 1) - 1;
    let cw = Math.floor(Math.min(byH / CARD_R, byW, CARD_MAX));
    cw = Math.max(CARD_MIN, cw);
    const ch = Math.round(cw * CARD_R);
    const bxh = ch + BOX_CHROME;
    const dlh = ch + DEALER_CHROME;
    const need = TABLE_PAD * 2 + dlh + ROW_GAP + rows * bxh + (rows - 1) * BOX_GAP;
    return { fit: fit, rows: rows, basis: boxBasis(fit),
             cw: cw, bxh: bxh, dlh: dlh, over: Math.max(0, need - H) };
  }
  function planTable(n, d, meOut){
    const boxes = Math.max(0, n - (d >= 0 ? 1 : 0));      // 閒家 = 除莊家以外的座位
    const H = tableSpace(), W = stage ? (stage.clientWidth || 0) : 0;
    /* 還沒排版(畫面還是 hidden)→ 用保守的預設,尺寸交給 CSS 的後備值,下一次重畫就對了。
       ⚠ 這一條也讓 e2e 那種「直接呼叫 render」的用法拿得到穩定的 basis。 */
    if(!(H > 0) || !W){
      const fit = (boxes <= 1) ? 1 : BOX_FIT;
      return { fit: fit, rows: Math.max(1, Math.ceil(boxes / fit) + (meOut ? 1 : 0)),
               basis: boxBasis(fit), cw: 0 };
    }
    return pickPlan(boxes, meOut, H, W);
  }
  /* 挑「一列幾格」——★ 抽成一支**吃參數的** H / W(不自己量畫面)。
     ⚠ 理由是守門:這樣 e2e 才餵得進「390x844 的手機」與「730x605 的矮視窗」
       兩種尺寸各驗一次(真的靠視窗量的話,斷言就跟著跑測試的視窗大小飄)。 */
  function pickPlan(boxes, meOut, H, W){
    /* ⚠ 一列 1 格**一定要當起點**(而不是 `let best = null` 從迴圈裡撿)——
       回 null 的話呼叫端讀 plan.cw 會整個炸掉(施工中的突變測試真的炸出來過),
       而那是「版面算不出來」這種小事引起的整頁白掉。 */
    let best = evalPlan(1, boxes, meOut, H, W);
    for(let fit = 2; fit <= BOX_FIT; fit++){
      if(fit > boxes) break;                              // 只有一格 → 不必比「一列 2 格」
      const p = evalPlan(fit, boxes, meOut, H, W);
      // 先看放不放得下,再看牌哪個大(都放不下時挑超出最少的)
      if(p.over < best.over || (p.over === best.over && p.cw > best.cw)) best = p;
    }
    return best;
  }
  function boxesHTML(v, lay){
    const st = v.st;
    const n = v.n || (st ? st.n : 2);
    // ⚠ v1.90.0:一律走 dealerOf —— 寫 `st ? st.dealer : -1` 的話下注階段莊家會多一格
    const d = dealerOf(v);
    const basis = lay.basis;
    /* ★★★ v1.88.0:**嚴格照座位號碼排**(使用者:「看你是第幾家,然後順序就應該是怎樣」)。
       ⚠ 這**推翻**了 v1.87.0 的「我自己那一格排第一個」(那一版的理由是:矮視窗放不下
         所有列時注區會捲,而最不能被捲出去的是我的牌)。使用者權衡過後要的是
         「每台裝置看到的排列完全一致 = 桌號看得懂」,所以那個理由讓位。
       ★ 代償:①列數少了(我不再獨占一列)→ 同樣的高度分給更少的列,牌反而大一階
         ②我那一格有金框 + 「你」徽章 + 座位號碼三個記號在標。 */
    let rows = "";
    for(let s = 0; s < n; s++){
      if(s === d) continue;                    // 莊家畫在上面那一條(不重複畫)
      rows += boxHTML(v, s, basis);
    }
    /* 中途加入的人:這一局還沒有他的座位(見 adapter 的「排隊不是插入」)。
       ⚠ 照樣要占一格,否則他加入的那一刻整個牌桌會跳一次。 */
    if(v.me < 0)
      rows += '<div class="bj-box me idle" style="flex:0 0 100%">' +
                '<div class="bj-bhd"><span class="bj-bnm">你</span>' +
                  '<span class="bj-st wait">下一局開始就發你牌</span></div>' +
                '<div class="bj-bcs"><span class="bj-bwait">🎴 等這一局打完…</span></div>' +
              '</div>';
    return '<div class="bj-boxes">' + rows + '</div>';
  }

  /* ==========================================================================
     三之二、★★★ 牌寬 / 格高 / 一列幾格 —— 收成**同一支** planTable()
     ──────────────────────────────────────────────────────────────────────────
       使用者要求③:「玩家的牌沒有完整顯示,我要跟莊家的牌大小一樣」。

     ── v1.86.0 為什麼一定會壞(量出來的)────────────────────────────────────
       `.\tools\shot-bj.ps1 -Shots play -Seats 6` 印出來:
           box=32/684,…  CARDW=36/46/50  CLIP=11 max36  boxesOver=17
       牌寬是 CSS 從 --bj-cw 乘係數(1 / .92 / .72)推的,格高是這裡**平分**注區算的,
       兩者互不知道 → 視窗一矮格子縮到 32px,而牌高 51~71 **上下各被切掉一大截**。
       ★ 這是「兩份真相」的教科書案例:調係數永遠救不了,只能把來源收成一個。

     ── ★★ 這一支怎麼算 ────────────────────────────────────────────────────
         ① 高度:盤面剩下的空間由「莊家台 + rows 個格子」分掉
            → 一格的牌高 cardh = (可用 − 莊家台裝潢 − rows × 格裝潢) / (rows + 1)
         ② 寬度:一格要塞得下 **5 張**(過五關的上限)才**永遠不必換行**
            → 而不換行才有「所有人的牌一樣大」
         ③ 取兩者的小的,再夾上下限;**格高回頭 = 牌高 + 裝潢** → 於是裁不到牌
       ⚠⚠ 只吃「人數 + 視窗」:人數一整局不變、視窗更不會變 → **一整局是常數**。
          真正不可以的是「跟著**牌數**變」(那才是台灣麻將那一整類忽大忽小)。
       ⚠ 一律寫成 inline literal:calc 不可以除以 var()(v1.86.0 已經踩過)。
       ⚠ 常數一律取**保守的那一邊**(padding 取最大的那組):算少了只是牌小一點,
         算多了就是又開始裁牌。
     ========================================================================== */
  const CARD_R   = 1.42;      // 牌的高寬比(與 .bj-card 的 height:calc(w*1.42) 同一個數)
  const CARD_GAP = 3;         // .bj-bcs 的 gap
  const MAXC     = 5;         // 一手的實務上限(過五關 = 五張不爆)
  /* 一格 / 莊家台「除了牌以外」的**橫向**開銷:左右 padding(5+5)+ 左右 border(2+2)。
     ⚠⚠ v1.90.0 修正:舊值 10 只算了 padding,漏掉 border → 一格剛好差 4px,
       而症狀是「滿手 5 張時最後那一張被 flex 擠窄」= 牌桌上出現兩種寬度
       (診斷器的 CARDW=66/68 WARN-CARD-SIZES-DIFFER)。
     ⚠ 兩邊的橫向 padding **一定要一樣**(莊家台也是 5px)—— 不一樣的話就得取大的那個,
       而那等於全桌的牌都跟著最寬的那一格縮。 */
  const BOX_PADX = 14;
  /* 一格裡「除了牌以外」的高度(padding + 兩個 gap + 頭列 + 尾列)。
     ★★ 這是**起始猜測**,實際值由 learnChrome() 從畫面上量回來(見它的註解)——
        寫死一個常數的話,矮視窗那幾條 media query 一改字級 / padding 就會與它錯開,
        而錯開的方向是「又開始裁牌」。量出來的第一版是 57。
     ⚠ 猜大了只是牌小 1~2px(沒有壞處);猜小了就是使用者說的「牌沒有完整顯示」。 */
  let BOX_CHROME = 58;
  /* 莊家台「除了牌以外」的高度。★★ v1.90.0 起它與一格同構(頭列 + 牌列),
     所以同樣由 learnChrome() 量回來 —— 舊版的 DEALER_PAD(24)+ DEALER_INFO(48)
     那兩個常數是「橫排」時代的東西,一起拿掉了。
     ⚠ 猜大了只是牌小 1~2px;猜小了就是莊家那一排牌被裁掉一截。 */
  let DEALER_CHROME = 44;
  const TABLE_PAD = 10, ROW_GAP = 8, PLAY_GAP = 8;
  const CARD_MIN = 26, CARD_MAX = 78;
  /* ★★ 牌桌拿得到多少高度 —— **從 .bj-play 往下扣**,不是量 .bj-stage。
     ⚠⚠ 這是施工中真的踩到的坑:`#bjActs` 一開始掛著 .hidden(renderActs 才拿掉),
       而第一次 render 就發生在那之前 → 量 .bj-stage 會多拿到整條動作列的高度
       (量出來 400 而實際只有 261)→ 牌算得太大,注區溢出一整列
       (診斷器的 boxesOver=144)。
     ★ 所以動作列的高度**取「實際高度」與「CSS 預留的 --bj-acth」的大的那個**:
       看得見時用實際的、還沒畫時用預留的 → 兩種時序算出來都對。 */
  function tableSpace(){
    const play = $("bjPlay");
    if(!play) return 0;
    const ph = play.clientHeight;
    if(!ph) return 0;
    let reserve = acts ? acts.offsetHeight : 0;
    if(!reserve){
      const v = parseFloat(getComputedStyle(document.body).getPropertyValue("--bj-acth"));
      reserve = (v > 0) ? v : 104;
    }
    return ph - PLAY_GAP - reserve;
  }
  /* ⚠ v1.88.1 起這一段的入口是上面的 **planTable() / evalPlan()**(不再有 fitTable):
     因為「一列幾格」也變成算出來的 —— 一格幾寬與牌多大**必須同一支算**,
     分兩支的話 3 人局(一列 1 格)那一種會拿 2 格的寬度去算牌(牌太大 → 裁牌)。 */
  /* ★★★ 把「一格的裝潢有多高」從畫面上量回來 —— 這一支是 BOX_CHROME 那個常數的解藥。
       `.bj-bcs` 是 flex:1 → 它的高度 = 一格的高度 − 裝潢,所以
           裝潢 = box.offsetHeight − bcs.offsetHeight
       而裝潢**不吃牌的大小**(頭尾兩列都是純文字)→ 這個迴圈一輪就收斂,
       不會變成台灣麻將那種 ResizeObserver 來回震盪(notes/11 第六節)。
     ★ 回傳「有沒有變」:變了就當場用新的數字改一次 CSS 變數(不重寫 innerHTML)。
     ⚠ 為什麼一定要量:矮視窗那幾條 media query 會改 padding / 字級 →
       常數與現實錯開,而症狀就是使用者說的「牌沒有完整顯示」。 */
  function learnChrome(){
    if(!stage) return false;
    let changed = false;
    const bx = stage.querySelector(".bj-box");
    const bc = bx && bx.querySelector(".bj-bcs");
    if(bx && bc && bx.offsetHeight){
      const c = bx.offsetHeight - bc.offsetHeight;
      if(c > 0 && Math.abs(c - BOX_CHROME) >= 0.5){ BOX_CHROME = Math.ceil(c); changed = true; }
    }
    /* ★★ v1.90.0:莊家台也要量 —— 它改成「頭列 + 牌列」之後與一格同構,
       而兩者的裝潢**不一樣高**(莊家的名字大一號)→ 只量一邊就是又剩一個寫死的常數。 */
    const dl = stage.querySelector(".bj-dealer");
    const dc = dl && dl.querySelector(".bj-dcs");
    if(dl && dc && dl.offsetHeight){
      const c2 = dl.offsetHeight - dc.offsetHeight;
      if(c2 > 0 && Math.abs(c2 - DEALER_CHROME) >= 0.5){ DEALER_CHROME = Math.ceil(c2); changed = true; }
    }
    return changed;
  }

  /* ==========================================================================
     四、(空著)—— 「我的手牌」那一塊 v1.86.0 拿掉了
     ──────────────────────────────────────────────────────────────────────────
       我自己就是桌上的一格(`.bj-box.me`)。⚠ 不要把它加回來:加回來就等於同一副牌
       畫兩次,而且底下那一塊的高度會把牌桌壓矮(v1.86.0 的整個改動就是在拿掉它)。
     ========================================================================== */
  /* ==========================================================================
     五、整個舞台
     ──────────────────────────────────────────────────────────────────────────
       ★★★ v1.86.0:**最下面那一塊獨立的手牌區拿掉了**(使用者:「不要有最下方的
          手牌顯示區,因為在桌上其實都有了,只要能夠很清楚的知道自己是坐在哪個位置」)。
          我自己就是桌上的一格 —— 靠 `.bj-box.me`(金框 + 「你」徽章 + 獨占一列 +
          原尺寸的牌)標出來,位置跟著座位跑。
       ★ 於是 `--bj-mh` 那個高度也跟著消失,多出來的空間全部給牌桌
         (莊家那一條因此可以做高一點,那是使用者第 ① 點的後半)。
     ========================================================================== */
  function render(v, again){
    if(!stage) return;
    /* ★ 新牌 / 翻牌的記號要在寫 innerHTML **之前**算好(handOf 讀它)。
       ⚠ `again`(learnChrome 之後整份重畫那一次)**不可以再算一次** ——
         算了會把記號清掉,那一次的滑入動畫就靜靜地不見了。 */
    if(!again) calcFxMark(v);
    const n = v.n || (v.st ? v.st.n : 2);
    // ⚠ v1.90.0:下注階段也要知道莊家是誰(否則格數會從 n 掉到 n−1 = 牌換一次大小)
    const d = dealerOf(v);
    /* ★★★ v1.87.0:牌寬 / 一格的高度 / 莊家台的高度**一次算好掛在牌桌上**
       (見 planTable 的註解 —— 三個數字同一個來源,所以牌永遠裁不到、也永遠一樣大)。
       ★★ v1.88.1 起「一列幾格」也由同一支算(挑牌最大的那一種)。
       ⚠ 一定要在寫 innerHTML **之前**量 stage:牌桌是 flex:1、高度不吃自己的內容,
         所以量到的是穩定值;寫完再量就多一次 reflow 而且答案一樣。 */
    const plan = planTable(n, d, v.me < 0);
    const sty = plan.cw ? (' style="' + fitStyle(plan) + '"') : "";
    stage.innerHTML =
      '<div class="bj-table"' + sty + '>' +
        dealerHTML(v) +
        boxesHTML(Object.assign({}, v, { n: n }), plan) +
      '</div>';
    /* ★ 量一次「一格的裝潢有多高」;與上一次不一樣就當場用新數字改 CSS 變數
       (只改變數、不重寫 innerHTML → 不閃、也不會變成無窮迴圈,見 learnChrome)。
       ⚠⚠ v1.88.1 多一種情形:裝潢的高度會影響「一列幾格才讓牌最大」的答案 ——
         換了的話 basis 已經寫進 innerHTML 了,只改 CSS 變數會**對不起來**
         (症狀是一列兩格但牌照一格的寬度算 → 一列塞不下),所以**整份重畫一次**。
         `again` 是遞迴的煞車:learnChrome 學過就回 false,所以最多只會發生一次。 */
    if(plan.cw && learnChrome()){
      const p2 = planTable(n, d, v.me < 0);
      if(p2.fit !== plan.fit && !again){ render(v, true); return; }
      const tb = stage.querySelector(".bj-table");
      if(p2.cw && tb) tb.setAttribute("style", fitStyle(p2));
    }
    keepMeInView();
  }
  /* ★★★ v1.88.0:注區真的要捲的時候,把**我那一格**帶進視野。
     ── 為什麼需要它 ────────────────────────────────────────────────────────
       v1.87.0 靠「我排第一個」保證我的牌一定看得到;這一版改成嚴格照座位號碼排
       (使用者要求),那個保證就沒了 —— 6 人 + 矮視窗時 `.bj-boxes` 會捲
       (診斷器印 boxesOver / WARN-BOX-ROW-LOST),而我可能剛好在捲出去的那一列。
     ★ 只在**真的有捲軸**時動,而且是 block:"nearest" 的語意(看得到就什麼都不做)
       → 一旦到位就不再動,不會每次重畫都跳。
     ⚠ **不可以**用 el.scrollIntoView():它會連**祖先**一起捲(整頁跟著跳),
       這裡只准動 .bj-boxes 自己的 scrollTop。 */
  function keepMeInView(){
    if(!stage) return;
    const bx = stage.querySelector(".bj-boxes");
    const mine = bx && bx.querySelector(".bj-box.me");
    if(!bx || !mine) return;
    if(bx.scrollHeight <= bx.clientHeight + 1) return;      // 放得下 → 不要動
    const r = mine.getBoundingClientRect(), c = bx.getBoundingClientRect();
    if(r.top < c.top) bx.scrollTop -= (c.top - r.top);
    else if(r.bottom > c.bottom) bx.scrollTop += (r.bottom - c.bottom);
  }
  const fitStyle = f => "--bj-cardw:" + f.cw + "px;--bj-bxh:" + f.bxh + "px;--bj-dlh:" + f.dlh + "px";

  /* ==========================================================================
     六、動作列(單機與連線共用這一份)
     ──────────────────────────────────────────────────────────────────────────
       info = { phase, mine, betPhase, betMax, myBet, legal:{hit,stand},
                turnName, over, hint, cdMs, cdEnd }
       ★ 只有一份:21 點的動作集很小(下注的加減鈕 + 要牌 / 停),
         而且兩邊的狀態都表達得成純資料。
       ⚠ 想加「只有連線才有」的東西時,先想能不能表達成 info 的一個欄位。

       ★★ 每一顆鈕都**按得動**,不合法時只是變暗 + 說得出原因
          (CLAUDE.md 的紅線:不用 disabled 讓點擊靜默消失)。

     ── ★★ 下注改成加減鈕(v1.85.0)──────────────────────────────────────────
       使用者:「我希望可以下注的籌碼是比較彈性的,可以搞個一次加減一或加減 5
       或加減 10 的方式」→ 四個檔位鈕換成 ±1 / ±5 / ±10 + 一顆「押 N ▸」。
       ★ 兩列的高度刻意與「要牌 / 停」那一組**一樣**(提示列 + 一排鈕):
         動作列是寫死高度的(--bj-acth),下注那一段變高就等於手牌被推
         (大老二 v1.78.0 一路在修的「上上下下」)。
         ⚠ 所以「押 N ▸」是塞在**提示列右邊**而不是自己一列。
       ★ 級距由 BJ.betSteps(betMax) 篩過:上限 5 的時候不畫 ±10(按了也沒用)。

     ── ★★ 加倍拿掉了(v1.85.0)─────────────────────────────────────────────
       使用者:「開始後不要再有兩倍的選項可以按」。
       ⚠ 這裡**不必**判斷 —— BJ.legal().dbl 永遠 false,所以只是把那一行刪掉;
         真正的閘門在 rules.js(見那邊 legal() 的註解)。
     ========================================================================== */
  function actsHTML(info){
    if(info.over) return '<span class="bj-atxt">' + esc(info.hint || "這一局結束") + '</span>';

    /* ---------- 下注階段 ---------- */
    if(info.betPhase){
      if(info.mine === false)
        return '<span class="bj-atxt">' + esc(info.hint || "這一局你當莊,不用下注") + '</span>';
      const max = (info.betMax > 0) ? info.betMax : R.RULES_DEF.betMax;
      const done = info.myBet > 0;
      // ⚠ 一定要在這裡夾一次:房規的上限被改小時 betPend 可能還留著上一局的大數字
      betPend = Math.max(R.MIN_BET, Math.min(max, betPend || R.MIN_BET));
      const amt = done ? info.myBet : betPend;
      let h = '<div class="bj-selbar bet' + (done ? " ok" : "") + '">' +
                '<span class="bj-selico">' + (done ? "✅" : "💰") + '</span>' +
                '<span class="bj-seltxt">' +
                  esc(done ? ("你押了 " + amt + " —— 等其他人下注")
                           : (info.hint || "先押注,再發牌")) +
                '</span>' +
                /* ★ 押注金額**一律畫出來**(押好之後也留著,而且位置不變)——
                   不然「我押了多少」在最需要看的那一刻反而消失。 */
                '<span class="bj-bamt' + (done ? " ok" : "") + '"><i>押</i><b>' + amt + '</b></span>' +
                (done ? "" : '<button class="btn primary bj-bok bj-act" data-act="bet" data-bet="' +
                             betPend + '">押注</button>') +
              '</div>';
      h += '<div class="bj-btns bj-bsteps' + (done ? " locked" : "") + '">';
      const steps = R.betSteps(max);
      // 減:大的在左(−10 −5 −1),加:小的在左(+1 +5 +10)—— 兩邊對稱,手指找得到
      steps.slice().reverse().forEach(s => {
        h += stepBtn(-s, amt <= R.MIN_BET || done);
      });
      steps.forEach(s => { h += stepBtn(s, amt >= max || done); });
      h += '</div>';
      return h;
    }

    /* ---------- 不是我動 ---------- */
    if(!info.mine)
      return '<span class="bj-atxt">' + (info.hint
        ? esc(info.hint)
        : ('輪到 <b>' + esc(info.turnName || "對手") + '</b>…')) + '</span>';

    /* ---------- 我要牌 / 停 / 抓人 ---------- */
    const lg = info.legal || {};
    const st = info.st;

    /* ★★★ 抓人展開(v1.87.0 改法):**這一列只剩一句提示 + 一顆取消** ——
       要抓誰改成**直接點牌桌上那一格**(使用者:「我是想要直接在牌桌上點人,
       而不是點名字的按鈕」)。落點在 boxHTML 的 data-grab + mount 的 stage 監聽。
       ⚠ 動作列是寫死高度的(--bj-acth)→ 還是「提示列 + 一排鈕」兩列,
         只是那一排只剩一顆;少一列就等於把牌桌推上去。
       ⚠ 名字鈕整組拿掉了 → **e2e 的驅動要跟著改**(改點 .bj-box[data-grab]);
         漏改的症狀是「一整局靜靜地卡住」,而且看不出來跟抓人有關。 */
    if(grabOpen && st && lg.grab){
      return '<div class="bj-selbar grab">' +
               '<span class="bj-selico">🎯</span>' +
               '<span class="bj-seltxt">點桌上要抓的那一家(先跟他比,比完你還能繼續補牌)</span>' +
             '</div>' +
             '<div class="bj-btns bj-grabs">' +
               '<button class="btn ghost bj-act bj-gx" data-act="gcancel">✕ 取消</button>' +
             '</div>';
    }

    let h = '<div class="bj-selbar">' +
              '<span class="bj-selico">☝</span>' +
              '<span class="bj-seltxt">' + esc(info.hint || "要牌還是停?") + '</span>' +
            '</div>';
    h += '<div class="bj-btns">';
    h += '<button class="btn primary bj-act' + (lg.hit ? "" : " dim") + '" data-act="h">要牌</button>';
    h += '<button class="btn ghost bj-act' + (lg.stand ? "" : " dim") + '" data-act="s">停</button>';
    /* ★ 抓人只有莊家看得到這一顆(閒家沒有這個動作 → 畫出來只是雜訊)。
       ⚠ 不合法時只是**變暗**、照樣按得動 → 跳 BJ.denyTxt 那句(不用 disabled)。 */
    if(info.isDealer)
      h += '<button class="btn ghost bj-act' + (lg.grab ? "" : " dim") +
           '" data-act="gopen">抓人</button>';
    h += '</div>';
    return h;
  }
  /* 一顆加減鈕。★ 到底了只是**變暗**(照樣按得動 → 跳「已經是上限了」),
     不是 disabled(CLAUDE.md 的紅線)。 */
  function stepBtn(d, dim){
    return '<button class="btn ghost bj-bstep bj-act' + (dim ? " dim" : "") +
           '" data-act="bstep" data-d="' + d + '">' +
           (d > 0 ? "＋" : "−") + Math.abs(d) + '</button>';
  }

  function renderActs(info){
    if(!acts) return;
    /* ★ 抓人那一排只在「莊家、抓得動」時活著 —— 相位一變就收掉,
       不然下一段會頂著一排名字鈕(而且那時它們都不合法了)。 */
    if(grabOpen && !(info.legal && info.legal.grab)) grabOpen = false;
    lastInfo = info;                        // 加減鈕要原地重畫一次(見 mount 的 bstep)
    acts.classList.remove("hidden");
    acts.innerHTML = '<div class="bj-actrow">' + actsHTML(info) + '</div>' +
                     '<div class="bj-cdwrap" id="bjCdWrap"></div>';
    syncCd(info);
    /* ★★★ 這裡**也要**檢查一次「我那一格看得到嗎」(v1.88.0)。
       ⚠⚠ 這是 planTable 那個老坑的雙胞胎:第一次 render() 時 `#bjActs` 還掛著 .hidden
         (上面那行才拿掉)→ 那一刻注區拿到的是整條動作列的高度,**還不需要捲**,
         所以 render 裡那一次呼叫一定看到「放得下」而什麼都不做。
       ★ 動作列畫完 = 注區的高度定了 → 這時候問才問得到真的答案。
         (診斷器的守門是 shot-bj.ps1 的 meVis;漏掉這一行就是 meVis=0@sc0。) */
    keepMeInView();
  }
  /* 加減鈕:只動「還沒送出去的金額」,不碰 st、不碰 DB、不通知呼叫端。
     ★ 所以它整條路都留在盤面這一層 —— 呼叫端(solo / adapter)一行都不必改。
     ⚠ 押好之後鎖住:DB 那一格是冪等的(押過了就不收),按了要說得出原因。 */
  function bumpBet(d){
    if(!lastInfo || !lastInfo.betPhase) return;
    if(lastInfo.myBet > 0){ showToast("這一局已經押 " + lastInfo.myBet + " 了,下一局才能改"); return; }
    const max = (lastInfo.betMax > 0) ? lastInfo.betMax : R.RULES_DEF.betMax;
    const next = Math.max(R.MIN_BET, Math.min(max, betPend + d));
    if(next === betPend){
      showToast(d > 0 ? ("已經是上限 " + max + " 了(房規定的)") : ("最少要押 " + R.MIN_BET));
      return;
    }
    betPend = next;
    /* 很輕的一聲,加高減低 —— 不看螢幕也知道剛才那一下有沒有吃到。
       ⚠ 音量刻意壓到 .10:調到想要的數字可能連按七八下,大聲一點就變吵。 */
    if(typeof Sound !== "undefined")
      Sound.tone(d > 0 ? 880 : 560, { type: "sine", dur: 0.05, vol: 0.10 });
    renderActs(lastInfo);
  }

  /* ── ★★★ 倒數環(v1.90.0 改成**與台灣麻將同一顆**)────────────────────────────
     使用者:「最下方的倒數秒數,我希望做成跟台灣麻將一樣」。
     舊版是一條 56×6 的橫條 + 旁邊一個數字;改成 34px 的 SVG 環圈 + 中間的秒數,
     最後 3 秒轉紅並脈動,秒數每跳一次縮放一下。

     ★ 幾何與關鍵影格**逐字沿用 m16**(viewBox 40 · r=17 · dasharray 107 ·
       `@keyframes m16cd` / `m16beat` / `m16cdhot`)—— 同一件事只有一種畫法,
       不再定義一份同名的環(這一頁本來就是這樣沿用排七的 svCd 的)。

     ★ **全桌都看得到**(「現在在等誰、還剩幾秒」是公開資訊,讓大家知道為什麼卡著)
       —— 判準同排七 / 大老二 / 台灣麻將。

     ★ 兩個從台灣麻將繼承的坑(notes/11 第三節):
       ① 用**負的 animation-delay** 接續播放,duration 永遠是那一段的總長
          —— 這樣 e2e 才量得到設定值。
       ② 去重的 key **不可以看 timer 還在不在**:數字走到 0 之後 interval 就停了,
          而 timer 本身還有幾百毫秒沒響;那段空窗裡只要有人再叫一次 renderActs()
          環就會彈回滿格,而那個彈跳本身就是雜訊。
     ⚠ 與 m16 唯一的差別:這一頁的環是**每次 renderActs 都重建的節點**
       (m16 是刻意留著不動的持久節點)。重建照樣接得上,靠的就是①那個負延遲;
       但因此「秒數跳動」那個 .bj-beat **不可以寫進初始 HTML** —— 寫進去的話
       每一次重畫(對手一動就一次)都會閃一下。 */
  const CD_HOT = 3000;                        // 最後 3 秒轉紅 + 脈動(同 m16)
  function syncCd(info){
    const box = $("bjCdWrap");
    if(!box) return;
    if(!info.cdMs || !info.cdEnd || info.over){ stopCd(); return; }
    const key = info.cdMs + ":" + info.cdEnd;
    const left = info.cdEnd - Date.now();
    if(left <= 0){ stopCd(); return; }
    cdEnd = info.cdEnd;
    box.innerHTML =
      '<span class="bj-cd' + (left <= CD_HOT ? " bj-hot" : "") + '" id="bjCd" aria-hidden="true"' +
        ' style="--cd-dur:' + (info.cdMs / 1000) + 's;--cd-delay:' +
        (-(info.cdMs - left) / 1000) + 's">' +
        '<svg viewBox="0 0 40 40"><circle class="bj-cdbg" cx="20" cy="20" r="17"/>' +
        '<circle class="bj-cdfg" cx="20" cy="20" r="17"/></svg>' +
        '<b class="bj-cdn" id="bjCdN">' + Math.ceil(left / 1000) + '</b>' +
      '</span>';
    if(key === cdKey && cdT) return;          // 同一段倒數:重畫畫面不重跑動畫
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(tickCd, 200);
  }
  /* 只換中間那個數字與 hot 狀態 —— 環圈本身完全交給 CSS 動畫(理由見上面①)。 */
  function tickCd(){
    const el = $("bjCd");
    if(!el){ if(cdT){ clearInterval(cdT); cdT = null; } return; }
    const left = cdEnd - Date.now();
    const n = el.querySelector(".bj-cdn");
    const s = String(Math.max(0, Math.ceil(left / 1000)));
    if(n && n.textContent !== s){
      n.textContent = s;
      n.classList.remove("bj-beat"); void n.offsetWidth; n.classList.add("bj-beat");
    }
    el.classList.toggle("bj-hot", left <= CD_HOT);
    if(left <= 0){ clearInterval(cdT); cdT = null; }
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = ""; cdEnd = 0;
    const box = $("bjCdWrap");
    if(box) box.innerHTML = "";
  }

  /* ==========================================================================
     七、★ 公告 —— 單機與連線**共用這一份**
     ──────────────────────────────────────────────────────────────────────────
       21 點的公開事件只有三種:有人爆了 / 有人 21 點 / 有人過五關。
       這三件事**都是公開的**(他的牌就攤在桌上),所以喊出來不違反牌情紅線。

       ★ 走「前後兩份 state 的 diff」而不是在動作點插一行 Sound.xxx() ——
         理由與台灣麻將 notes/11 第三節逐字相同:單機與連線的動作路徑完全不同,
         但「有人爆了」在兩邊是同一個 diff。

       ★★ 種子(seed)那一條是這一段的心臟:`prev === null` 或**換局**時
          **只記住、不出聲**。它一次擋掉四種會亂響的情形:
            ① 第一次進牌桌 ② 斷線重連(replay 一次把整局重算出來)
            ③ 批次同步(一次套好幾個動作)④ 換局
          少了它,重連的那一瞬間會把「目前所有爆掉的人」全部重播一次。
       ⚠ 刻意**不吃 adapter 的 fresh 旗** —— 那條旗只認得「連線的第一次同步」,
         而上面四種情形單機也會遇到(換局)。用 `prev === null` 兩邊都對。

       ⚠⚠ 莊家的事件要等 `st.reveal` —— 沒翻牌就喊「莊家 21 點」等於把暗牌講出來。
     ========================================================================== */
  let anPrev = null, anKey = "", anCaught = null;
  let anRev = false;          // 上一次畫的時候「莊家翻牌了沒」(★ 翻底牌那一聲的 diff)
  let anBets = null;          // 下注那一段:{ key, n } —— 押好的人數,多一個就響一聲籌碼

  /* ★★★ v1.92.0 起這一頁**不再是「全部合成音」** —— 四個公開事件多了一層人聲
     (見下面的 VOICE / evSfx)。合成音一格都沒有拿掉:那一層是「發生了什麼」的動作聲,
     人聲是「有人喊出來」,真牌桌上兩個同時有(照台灣麻將 sfx.js 那兩層的結論)。 */
  function bustSfx(){
    if(typeof Sound === "undefined") return;
    // 下行兩音 + 尾巴滑下去 = 爆了(與 21 點的上行完全相反,不看畫面也分得出來)
    Sound.tone(330, { type: "sawtooth", dur: 0.10, vol: 0.20 });
    Sound.tone(196, { type: "sawtooth", dur: 0.26, vol: 0.20, delay: 0.08, slideTo: 110 });
  }
  /* ★★★ v1.93.0:**華麗度跟著階走**(21 點 > 過五關)。
     使用者:「幫我改成 black jack 比較大」→ 兩段樂句**互換**:
       21 點  四音上行 + 更高的亮頂(最盛大 = 最大的階)
       過五關 三音上行(比 21 點收一階)
     ⚠ 這不是「順手好聽一點」:聲音是玩家判斷「哪一個比較厲害」的第二個管道
       (第一個是點數膠囊的顏色)—— 留著舊的華麗度等於**用聲音告訴他過五關比較大**,
       而結算會說 21 點贏。同一件事兩個管道講反話 = 玩家認定壞掉。
     ⚠ **語音檔一個字都沒動**(`mp3/bj/bj.wav` 唸的還是「二十一點」)——
       換的是合成音那一層的華麗度,兩層是分開的。 */
  function bjSfx(){
    if(typeof Sound === "undefined") return;
    Sound.tone(587, { type: "triangle", dur: 0.09, vol: 0.28 });
    Sound.tone(784, { type: "triangle", dur: 0.09, vol: 0.28, delay: 0.08 });
    Sound.tone(988, { type: "triangle", dur: 0.09, vol: 0.28, delay: 0.16 });
    Sound.tone(1319, { type: "triangle", dur: 0.34, vol: 0.30, delay: 0.24, slideTo: 1568 });
  }
  function dragonSfx(){
    if(typeof Sound === "undefined") return;
    // 三音上行 = 過五關(比 21 點收一階)
    Sound.tone(523, { type: "triangle", dur: 0.10, vol: 0.26 });
    Sound.tone(659, { type: "triangle", dur: 0.10, vol: 0.26, delay: 0.09 });
    Sound.tone(880, { type: "triangle", dur: 0.28, vol: 0.28, delay: 0.18 });
  }
  /* 一個動作的聲音(要牌 = 牌拍到桌上、停 = 收手)。★ **四個呼叫點共用這一份**:
     單機我自己 · 單機電腦 · 單機莊家 · 連線收到 diff ——
     四個點各寫一份「什麼時候響哪一聲」遲早走鐘,而走鐘了四邊各自都不會壞、
     沒有東西抓得到(那正是這個專案最痛的一類;大老二 v1.81.0 真的有一條突變這樣存活)。 */
  function moveSfx(act){
    if(typeof Sound === "undefined") return;
    if(R.isGrab(act)){ grabSfx(); return; }
    if(act === "h" || act === "d") Sound.place();
    else Sound.takeback();
  }
  /* 抓人:兩短一長的下行「指過去」—— 與爆(下行滑音)/ 21 點(上行)分得出來。 */
  function grabSfx(){
    if(typeof Sound === "undefined") return;
    Sound.tone(740, { type: "square", dur: 0.07, vol: 0.20 });
    Sound.tone(740, { type: "square", dur: 0.07, vol: 0.20, delay: 0.10 });
    Sound.tone(494, { type: "square", dur: 0.22, vol: 0.22, delay: 0.20 });
  }

  /* ==========================================================================
     七之二、★★★ v1.92.0 新增的四種聲音(使用者:「我想要加入一些音效,
                麻煩你參考其他的遊戲,看看有什麼音效可以加進來」)
     ──────────────────────────────────────────────────────────────────────────
       盤點過八個遊戲之後,這一頁少的**不是「更多聲音」而是四個沒有聲音的節點**:
         ① 發牌      舊版只有一聲 Sound.turn()(那是 Bingo 的「換你了」叮咚)——
                     而「押注收齊 → 牌刷出去」是這一頁節奏感最強的一刻
         ② 押注      舊版用 Sound.place()(= 牌拍到桌上),可是下注那一段桌上還沒有牌;
                     而且**連線那邊別人押注完全沒聲音**(只有單機在動作點插了一行)
         ③ 翻底牌    莊家掀開暗牌 —— 台式 21 點最戲劇的一刻,舊版一點聲音都沒有
         ④ 一局結算  單機播 Sound.win()/lose()(整首勝敗音檔),連線**完全沒有**
       ⚠⚠ 頻率一律留在 500Hz 以上:手機與筆電的小喇叭 300Hz 以下幾乎沒有輸出 ——
         台灣麻將 v1.61.0 上線後第一個回報(「試玩了一下,沒有聽到」)就是這條
         (notes/11 第三節)。低頻可以留一點當厚度,絕不能讓它當主體。
     ========================================================================== */
  /* ① 發牌:一張一張刷出去(★ **兩個呼叫點共用這一支** —— 單機 maybeDeal / 連線相位換手)。
     ⚠ 張數要夾上限:6 人局是 12 張,12 聲會變成一串雜訊 —— 聽得出「刷刷刷」就夠了。 */
  const DEAL_MAX = 6;
  function dealSfx(cards){
    if(typeof Sound === "undefined") return;
    const n = Math.max(2, Math.min(DEAL_MAX, cards || 2));
    for(let i = 0; i < n; i++)
      Sound.tone(760 + (i % 2) * 130, { type: "triangle", dur: 0.055, vol: 0.16,
                                        delay: i * 0.075, slideTo: 500 });
  }
  /* ② 籌碼推出去:金屬的「叮」。★ 走 announce 的 diff(**呼叫點只有一個**)——
     單機的電腦押注與連線收到的快照因此是同一條路,不必兩邊各插一行 Sound.place()。
     ⚠ 音量刻意壓在 .16:一局要響 n−1 次(6 人局 5 次),大聲一點就變催促。 */
  function chipSfx(){
    if(typeof Sound === "undefined") return;
    Sound.tone(1245, { type: "sine", dur: 0.05, vol: 0.16 });
    Sound.tone(1661, { type: "sine", dur: 0.09, vol: 0.12, delay: 0.035 });
  }
  /* ③ 莊家翻底牌:一聲往上掀 + 一顆亮點。
     ⚠ 它是**最低優先權**:同一個 diff 裡莊家剛好爆了 / 21 點的話,那兩聲才是主角
       (announce 的 snd 只留一個,見那裡的優先權那一行)。 */
  function revealSfx(){
    if(typeof Sound === "undefined") return;
    Sound.tone(392, { type: "triangle", dur: 0.13, vol: 0.22, slideTo: 740 });
    Sound.tone(1109, { type: "sine", dur: 0.16, vol: 0.14, delay: 0.10 });
  }
  /* ④ 一局結算(★ 過場開的那一刻響一次,單機與連線共用 —— 去重由 showHand 負責)。
     ⚠⚠ **不可以**改用 Sound.win() / Sound.lose():那是整首勝敗音檔(0.5~1 秒以上),
       而一場有十幾局 —— 每一局放一次會膩到讓人想關音效。那兩個留給**整場**結束
       (單機 finishMatch / 連線 outcome 照舊)。 */
  function settleSfx(delta){
    if(typeof Sound === "undefined") return;
    if(delta > 0)
      [659, 880, 1175].forEach((f, i) =>
        Sound.tone(f, { type: "triangle", dur: 0.13, vol: 0.24, delay: i * 0.075 }));
    else if(delta < 0){
      Sound.tone(440, { type: "triangle", dur: 0.13, vol: 0.20 });
      Sound.tone(294, { type: "triangle", dur: 0.26, vol: 0.20, delay: 0.10, slideTo: 220 });
    }else
      Sound.tone(587, { type: "sine", dur: 0.20, vol: 0.18 });     // 平手:不上不下的一聲
  }

  /* ==========================================================================
     七之三、★★★ 喊牌語音(v1.92.0)—— 照大老二 v1.81.1 那一套
     ──────────────────────────────────────────────────────────────────────────
       ★ 只有**公開事件**配語音,而且只有這四格:爆了 / 21 點 / 過五關 / 抓 ——
         它們本來就是牌桌上會喊出來的四句,而且**都已經是 announce 的 diff**
         (要牌 / 停一局要響十幾次,配語音就是台灣麻將講過的「報帳機」)。
       ★ 與合成音是**分開的兩層**,刻意不互相取代:合成音是動作聲、語音是有人喊出來。
       ⚠⚠ 音效槽一定要帶 `{ el:true }` —— 使用者是**直接用瀏覽器開網頁**(`file://`),
         那時 fetch 被擋,沒有它**永遠載不到音檔**、只會退回合成音,
         而且**在 http:// 下完全測不出來**(大老二 v1.81.0 真的漏了)。
       ⚠ 語音槽**沒有合成音後備**(synth 傳 null):音檔取不到就是不講話 ——
         拿音階去墊會變成同一個事件響兩次很像的聲音(台灣麻將 sfx.js 的同一條)。
       ⚠ 音檔進 mp3/bj/ 要**同一版**補 sw.js 的 CORE(addAll 是全有全無)。
       ⚠ 嫌某一句吵就**把那個 wav 刪掉**,自動退回只有合成音 —— 程式一行都不用改。 */
  const VOICE = ["bust", "bj", "dragon", "grab"];
  const SYNTH = { bust: bustSfx, bj: bjSfx, dragon: dragonSfx, grab: grabSfx };
  let defed = false;
  function ensureDefs(){
    if(defed || typeof Sound === "undefined" || !Sound.def) return;
    defed = true;
    VOICE.forEach(k => Sound.def("bjv" + k, ["mp3/bj/" + k + ".wav"], null, { el: true }));
  }
  /* 一個公開事件的聲音 = 動作聲 + 喊出來那一句。★ **呼叫點只有 announce 一個**。
     ⚠ 語音壓在動作聲後面 90ms:太近人耳會融成一團,太遠又像回音(同 M16Sfx.play)。 */
  function evSfx(k){
    if(typeof Sound === "undefined") return;
    if(SYNTH[k]) SYNTH[k]();
    if(VOICE.indexOf(k) < 0 || !Sound.sfx) return;
    ensureDefs();
    setTimeout(() => { if(typeof Sound !== "undefined" && Sound.sfx) Sound.sfx("bjv" + k); }, 90);
  }
  /* 進牌桌時先把四個語音檔載好。
     ⚠ 這不是效能優化而是**正確性**:音效槽是懶載入的,而語音層沒有合成音可以墊 ——
       不預載的話「這一場第一次爆」永遠是沒聲音的(音檔那時才開始飛),
       使用者只會覺得「有時候有、有時候沒有」(台灣麻將 M16Sfx.preload 的同一條)。
     ⚠ 呼叫時機一定要在**已經有使用者手勢之後**(單機 startMatch / 連線 enterPlaying),
       不然只是白白建立一個解不開的 AudioContext。 */
  function primeVoice(){
    if(typeof Sound === "undefined" || !Sound.prime) return;
    ensureDefs();
    VOICE.forEach(k => Sound.prime("bjv" + k));
  }

  /* ★★★ v1.92.0:下注那一段的 diff —— 「押好的人多了一個」就響一聲籌碼。
     ★ 走 diff 而不是在動作點插一行的理由與其他四種事件逐字相同:單機的電腦押注
       (solo.aiBets 的 later)與連線收到的快照是**完全不同的路徑**,但「有人押了」
       在兩邊是同一個 diff。舊版單機在動作點插了 Sound.place(),而**連線那邊
       別人押注一點聲音都沒有** —— 那就是「兩邊各寫一份」走鐘的標準症狀。
     ⚠ 種子(key 換了 / 第一次)一律**只記不響**:同 announce 那一條,
       它擋掉「進場 / 重連 / 批次同步 / 換局」四種亂響(6 人局會一次響 5 聲)。 */
  function betDiff(v){
    const done = (v && v.betDone) || null;
    if(!done){ anBets = null; return; }
    let cnt = 0;
    for(let i = 0; i < done.length; i++) if(done[i]) cnt++;
    const key = (v.key || "") + "/bet";
    if(anBets === null || anBets.key !== key){ anBets = { key: key, n: cnt }; return; }
    if(cnt > anBets.n) chipSfx();
    anBets.n = cnt;
  }

  /* 每次重畫都叫一次(單機 solo.paint() / 連線 adapter.paint() 各一行)。
     v = { st, names[], me, key, betDone[] } —— key 就是「這是哪一局」。
     ⚠ betDone 只在**下注那一段**有意義(那時 st 是 null,見兩個呼叫端)。 */
  /* ==========================================================================
     六之三、動效層(v2.4.5)—— 特寫 / 新牌滑入 / 暗牌翻開
     ──────────────────────────────────────────────────────────────────────────
       ★★ 特寫的掛點只有一個:`announce()` 裡 `bid()` 選出來的那一聲。
         那一支已經是這一頁「一次重畫只響一聲」的唯一入口,而且優先權來自**規則層的階**
         (`R.tierRank`)—— 特寫跟著它走,就不會出現「聲音說 21 點、畫面演過五關」。
         ⚠ 不要為了「動畫想早一點出來」另外找地方插呼叫:那就是第二份優先權。

       ★ 新牌滑入 / 暗牌翻開走的是**牌數與 hiddenIdx 的 diff**,不吃任何相位判斷 ——
         發牌、要牌、被抓翻牌、莊家掀底牌四件事在 diff 上是同一件事。
       ⚠⚠ diff **不需要 round key**:張數只會增加,一旦有任何一家變少就一定是重發
         (最少 2 張、發牌是一次給 2 張)→ 那一次什麼都不標。
         `st` 變成 null(下注階段)也一律清掉。
       ⚠ 特效節點掛獨立的 fixed 圖層 `.bj-fx`:`render()` 每次整份覆寫 stage 的
         innerHTML;z-index 40(結果卡 `.veil` 是 50、過場 `#bjHand` 在 stage 內是 3)。
     ========================================================================== */
  let fxCnt = null, fxHid = null;
  let fxMark = null;                        // fxMark[seat] = { just, flip }(見 handOf)

  function calcFxMark(v){
    const st = v && v.st;
    if(!st || !st.hands){ fxCnt = null; fxHid = null; fxMark = null; return; }
    const cnt = [], hid = [];
    let shrank = false;
    for(let s = 0; s < st.n; s++){
      cnt[s] = st.hands[s].length;
      hid[s] = R.hiddenIdx(st, s, v.me);
      if(fxCnt && cnt[s] < (fxCnt[s] || 0)) shrank = true;
    }
    const out = [];
    if(fxCnt && !shrank){
      for(let s = 0; s < st.n; s++){
        const o = {};
        if(cnt[s] > (fxCnt[s] || 0)) o.just = fxCnt[s] || 0;   // 這個 index 起都是新的
        if(fxHid[s] >= 0 && hid[s] !== fxHid[s]) o.flip = fxHid[s];
        out[s] = o;
      }
    }
    fxCnt = cnt; fxHid = hid;
    fxMark = out.length ? out : null;
  }

  function fxLayer(){
    let el = document.querySelector(".bj-fx");
    if(!el){
      el = document.createElement("div");
      el.className = "bj-fx";
      document.body.appendChild(el);
    }
    return el;
  }
  const CUT = {
    bust:   { t: "爆了",   c: "bust" },
    bj:     { t: "21 點",  c: "bj" },
    dragon: { t: "過五關", c: "dragon" },
    grab:   { t: "抓!",   c: "grab" }
  };
  function cutIn(key){
    const o = CUT[key];
    if(!o) return;
    const tb = stage && stage.querySelector(".bj-table");
    if(!tb) return;
    const b = tb.getBoundingClientRect();
    if(!b.width) return;                    // 桌子還沒有版面(hidden)→ 什麼都不放
    const el = document.createElement("div");
    el.className = "bj-cut " + o.c;
    el.setAttribute("style", "left:" + b.left + "px;top:" + b.top + "px;" +
      "width:" + b.width + "px;height:" + b.height + "px");
    el.innerHTML = '<span class="bj-cutw">' + o.t + '</span>';
    fxLayer().appendChild(el);
    setTimeout(() => { if(el.parentNode) el.parentNode.removeChild(el); }, 1000);
  }

  function announce(v){
    const st = v && v.st;
    if(!st || !st.hands){
      anPrev = null; anCaught = null; anRev = false;
      betDiff(v);                                   // ★ 下注那一段唯一的事件
      return;
    }
    anBets = null;                                  // 牌發出來了 → 下注那一段的記錄丟掉
    const now = [], caught = [];
    for(let s = 0; s < st.n; s++){
      /* ⚠⚠ v1.86.0:**每個看不到牌的座位**都要記成「沒事」,不只莊家 ——
         喊「小美 21 點!」等於把她的底牌講出去。判斷式一律問 BJ.openTo。 */
      const hidden = !R.openTo(st, s, v.me);
      now[s] = hidden ? 0 : (R.valueOf(st.hands[s]).bust ? 1 : st.tier[s] + 2);
      caught[s] = st.caught[s] >= 0 ? 1 : 0;
    }
    const rev = !!st.reveal;                        // ★ v1.92.0:莊家翻底牌那一聲的 diff
    if(anPrev === null || v.key !== anKey){
      anKey = v.key; anPrev = now; anCaught = caught; anRev = rev; return;
    }
    /* ★★★ v1.93.0:一次重畫只響一聲,而「哪一聲贏」一律問**規則層的階**
       (`R.tierRank`)—— 舊版把「過五關 > 21 點」**寫死**在這裡(`if(snd !== "dragon")`),
       而這一版把兩個階互換之後,寫死的那一份就會與規則層反過來
       (公告說過五關比較大、結算說 21 點贏 = 玩家會認定壞掉)。
       ⚠ 用出價(rank)而不是「誰後寫誰贏」:批次同步時有可能兩家同時報出兩種階。
       ★ 抓人與翻牌不是「階」,但它們在同一條優先權軸上 —— 給它們固定的名次:
           翻牌 = 最低(莊家剛好爆 / 21 點時那兩聲才是主角)
           抓人 = 普通階那一格(壓得過「爆」,但輸給 21 點 / 過五關)
         ⚠ 這兩個名次就是**舊版那兩行 `snd || ` / `!snd` 的語意**,不是新規則。 */
    let snd = null, sndRank = -99;
    const bid = (key, rank) => { if(rank > sndRank){ sndRank = rank; snd = key; } };
    const RANK_REVEAL = R.tierRank(R.T_BUST) - 1;     // 比「爆」還低
    const RANK_GRAB = R.tierRank(R.T_NORM);           // 爆 < 抓 < 過五關 / 21 點
    /* ★ 抓人是公開事件(被抓的人牌當場翻開)→ 喊得出來。
       ⚠ 走 diff 而不是在動作點插一行 Sound —— 單機與連線的動作路徑完全不同,
         但「有人被抓了」在兩邊是同一個 diff(同爆 / 21 點那三種)。 */
    for(let s = 0; s < caught.length; s++){
      if(caught[s] && anCaught && !anCaught[s]){
        const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
        showToast((s === v.me ? "你被抓了" : ("莊家抓 " + nm)) + " 🎯", 2000);
        bid("grab", RANK_GRAB);
      }
    }
    anCaught = caught;
    for(let s = 0; s < now.length; s++){
      if(now[s] === anPrev[s]) continue;
      const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
      const who = (s === v.me) ? "你" : nm;
      if(now[s] === 1){ showToast(who + " 爆了 💥", 1800); bid("bust", R.tierRank(R.T_BUST)); }
      else if(now[s] === R.T_DRAGON + 2){
        showToast(who + " 過五關!五張不爆 🐉", 2400); bid("dragon", R.tierRank(R.T_DRAGON));
      }else if(now[s] === R.T_BJ + 2){
        showToast(who + " 21 點! 🎯", 2000); bid("bj", R.tierRank(R.T_BJ));
      }
    }
    anPrev = now;
    /* ★★★ v1.92.0:莊家掀開暗牌 —— 台式 21 點最戲劇的一刻(舊版一點聲音都沒有)。
       ⚠ 判斷式還是**只有 st.reveal 一個字**(rules.js 那條紅線);這裡記的是
         「它剛剛才變成 true」,不是自己另外算一套「大家都停手了吧」。
       ⚠ 它是**最低優先權**(見上面 RANK_REVEAL):同一個 diff 裡莊家剛好爆了 /
         21 點的話,那兩聲才是主角 —— 翻牌聲會把它們蓋掉。 */
    if(rev && !anRev) bid("reveal", RANK_REVEAL);
    anRev = rev;
    /* ★ 一次重畫只響一聲:批次同步時有可能兩家同時爆,響兩聲會疊成噪音。
       ⚠ 優先權**不寫在這裡** —— 全部由上面 bid() 的名次決定(而階的名次來自規則層)。 */
    if(snd === "reveal") revealSfx();
    else if(snd) evSfx(snd);                        // ★ 動作聲 + 喊出來那一句兩層
    /* ★ 特寫跟著**同一個 snd** 走(v2.4.5)—— 聲音與畫面共用一份優先權,
       所以不可能出現「聲音說 21 點、畫面演過五關」。翻牌不放特寫:它每一局都會發生,
       而它的戲劇性已經由那張牌自己的翻牌動畫(`.bj-card.flip`)講完了。 */
    if(snd && snd !== "reveal") cutIn(snd);
  }
  /* 換局 / 離場:把 diff 的種子清掉(下一次只記不響)+ 收掉抓人那一排。
     ⚠ v1.92.0 起也要清掉**過場的 key**:再打一場時第一局的 key 會與上一場一樣
       (單機是 "solo:1"),不清的話那一局的結算聲會被去重當成「已經響過了」。 */
  function resetAnnounce(){
    anPrev = null; anKey = ""; anCaught = null; anRev = false; anBets = null;
    grabOpen = false; handKey = ""; hVoted = false;
    // ⚠ 動效的 diff 也要一起清:不清的話換局第一次畫會把整桌的牌都當成「剛發的」
    fxCnt = null; fxHid = null; fxMark = null;
  }

  /* ==========================================================================
     八、結果卡的結算表 —— ★ 這裡莊家的暗牌一定是翻開的
     ==========================================================================
       ★ 兩個訊號**完全分開**(排七 v1.75.2 的教訓,使用者:「你會把第一名特別框起來,
         這樣很容易讓大家以為自己是第一名」):
             框 + 「你」徽章  → 這一列是我
             🎩              → 這一列是這一局的莊家
       ★ 一列拆成**兩層**(排七 v1.75.3):主行的欄位固定(名字 / 押注 / 點數 / ±籌碼),
         牌那一排寬度每個人都不一樣,擠進主行會讓每一列都對不齊。
       ⚠ foot 是當 HTML 接在表下面的;要放使用者輸入的東西時呼叫端自己 esc()。
     ========================================================================== */
  function resultHTML(st, names, mySeat, sc, chips, foot){
    const d = st.dealer;
    // 莊家排第一列(他是這一局的對手),其他人照 delta 由大到小
    const order = [d];
    const rest = [];
    for(let s = 0; s < st.n; s++) if(s !== d) rest.push(s);
    rest.sort((a, b) => (sc.rows[b].delta - sc.rows[a].delta) || (a - b));
    const rows = order.concat(rest);

    return '<div class="bj-rank">' + rows.map(s => {
      const r = sc.rows[s];
      const me = s === mySeat, isD = s === d;
      const nm = names[s] || ("玩家" + (s + 1));
      const ch = chips ? chips[s] : null;
      const dv = r.delta;
      return '<div class="bj-rrow' + (me ? " me" : "") + (isD ? " dealer" : "") +
                 (dv > 0 ? " up" : (dv < 0 ? " down" : "")) + '">' +
        '<div class="bj-rmain">' +
          // ★ 座位號碼取代原本的色點(v1.88.0);莊家那一列讓 🎩 出面(他的號碼在牌桌上)
          (isD ? '<span class="bj-crown">🎩</span>' : snHTML(s)) +
          '<span class="bj-rname">' + esc(nm) + '</span>' +
          // ⚠ 名字本身就叫「你」時(單機的 0 號位)不掛徽章 —— 「你 你」是純雜訊,
          //   而「這一列是我」還有框在標,訊號沒少(同大老二 resultHTML 那條)
          (me && nm !== "你" ? '<span class="you-badge">你</span>' : "") +
          /* ★ 被抓的人比的**不是**莊家的最終手牌 → 一定要寫出來,
             不然同一局兩個人跟不同的點數在比,玩家看不懂為什麼。 */
          '<span class="bj-rtag">' + esc(R.tagTxt(r.tag)) +
            (r.caught >= 0 ? (" · 被抓時莊 " + r.dBest) : "") + '</span>' +
          '<span class="bj-rpt">' + (r.bust ? "爆" : r.best) + '</span>' +
          (ch !== null && ch !== undefined
            ? '<span class="bj-rchip" title="這一場的籌碼">' + ch + '</span>' : "") +
          '<span class="bj-rd">' + (dv > 0 ? "+" : "") + dv + '</span>' +
        '</div>' +
        '<div class="bj-rcards">' +
          (r.bet ? '<span class="bj-rbet">押 ' + r.bet + '</span>' : "") +
          /* ★ 結算了 —— 莊家的暗牌在這裡一定是翻開的(hide 不傳) */
          cardsHTML(st.hands[s], "tiny") +
        '</div>' +
      '</div>';
    }).join("") + '</div>' +
    (foot ? '<div class="bj-rfoot">' + foot + '</div>' : "");
  }

  /* ==========================================================================
     八之二、★ 整場的籌碼排名(結果卡的第一張表)
     ──────────────────────────────────────────────────────────────────────────
       ★★ 排名一律看**淨變化**(籌碼 − 起始籌碼),不是看「剩多少」——
          因為不淘汰、可以打到負分,而押注上限只夾房規那個數(不夾「我剩多少」),
          所以起始籌碼在數學上不影響任何判定,只影響顯示的數字好不好看。
          由此中途加入的人給房規那個起始值就好,**公平性自動成立、零解釋成本**。
          ⚠ 連帶的紅線:**不可以**寫出任何「籌碼不夠不能押」的邏輯 ——
            那會把「不淘汰」默默地破掉(rules.js 第二節也記了同一條)。
       ★ 兩欄:籌碼(= start + 淨變化,給人看的)· 淨變化(±,決定名次的那個數)。
     ========================================================================== */
  function matchHTML(names, nets, rules, mySeat, foot){
    const rows = [];
    for(let s = 0; s < names.length; s++)
      rows.push({ s: s, net: (nets[s] || 0), chip: rules.start + (nets[s] || 0) });
    rows.sort((a, b) => (b.net - a.net) || (a.s - b.s));
    return '<div class="bj-rank match">' + rows.map((r, i) => {
      const me = r.s === mySeat, first = i === 0;
      const nm = names[r.s] || ("玩家" + (r.s + 1));
      return '<div class="bj-rrow' + (me ? " me" : "") + (first ? " win" : "") +
                 (r.net > 0 ? " up" : (r.net < 0 ? " down" : "")) + '">' +
        '<div class="bj-rmain">' +
          '<span class="bj-rno">' + (i + 1) + '</span>' +
          '<span class="bj-rname">' + esc(nm) + '</span>' +
          (me && nm !== "你" ? '<span class="you-badge">你</span>' : "") +
          // ⚠ 這一格刻意不用 🏆 兩次:名次圈已經在標第一名了(同大老二 resultHTML)
          (first ? '<span class="bj-rcrown" title="這一場籌碼最多">🏆</span>' : "") +
          '<span class="bj-rchip" title="手上的籌碼">' + r.chip + '</span>' +
          '<span class="bj-rd">' + (r.net > 0 ? "+" : "") + r.net + '</span>' +
        '</div>' +
      '</div>';
    }).join("") + '</div>' +
    (foot ? '<div class="bj-rfoot">' + foot + '</div>' : "");
  }

  /* ==========================================================================
     八之四、★★★ 一局結束的過場(v1.92.0)—— 單機與連線**共用這一份**
     ==========================================================================
       使用者:「現在每一把結束到底誰贏多少誰輸多少有點不太明確,乾脆搞個中間的過場,
       用來顯示輸贏多少」。

     ── 舊版為什麼「不太明確」(這是根因,不是感受)────────────────────────────
       一局結束時「誰贏多少」只有兩個地方在講,而兩個都只講**我自己**:
         ① 一句 2.4 秒的 toast(「本局:你 +5 籌碼 · 點數比莊家大」)
         ② 動作列那一行同樣的字
       別人賺賠多少完全沒有畫出來 —— 要自己看牌桌上的點數去推,而那時牌剛翻開、
       toast 又在飄。晶片列的「±N」是**整場累計**,不是這一把,所以它反而更容易誤讀。

     ── 這一版做什麼 ──────────────────────────────────────────────────────────
       把那一段(SETTLE_MS,本來就存在的窗口)升級成**蓋在牌桌上的一塊過場**:
         · 大字   = 我這一把 ±多少(贏綠、輸紅、平手灰)
         · 一句話 = 為什麼(BJ.tagTxt)+ 我手上剩多少
         · 一張表 = 每一家的「押多少 / 幾點 / 為什麼 / ±多少 / 手上多少」+ 攤開的牌
         · 進度條 = 這一段還剩多久(倒數環被過場蓋住了,所以它自己要講)
       ★★ 那張表就是結果卡在用的 **BJB.resultHTML(同一支)** —— 不是長得很像的第二份。
          兩份的下場看 CLAUDE.md 那一整串(全螢幕 / 表情 / 罐頭句都踩過)。

     ── ⚠ 為什麼它是 `.bj-play` 的**絕對定位兄弟**,不是 `#bjStage` 的子節點 ────────
       ① `render()` 每次都重寫 `stage.innerHTML` —— 放進去就會被吹掉
       ② 絕對定位不占版面 → planTable 量的 `#bjPlay` / 動作列高度**一個像素都沒變**
          (牌的大小只吃「人數 + 視窗」那條紅線因此完全沒鬆)
       ③ 牌情的守門不變量是「**`#bjStage`** 裡的 `.bj-card.back` 張數 = Σ hiddenIdx」——
          過場裡也有牌(結算了,全部翻開),放進 stage 就會把那條不變量弄壞
     ⚠ 蓋住整個 `.bj-play`(含動作列)是**刻意的**:那一段動作列只有一行字,而
       「過場」的意思就是把畫面接管一下。表情 / 麥克風在房間框上,沒有被蓋到。

     ── ★★★ v1.94.0:**看完可以按**(使用者:「最後結算的畫面時間太短了,
        然後我希望有可以快速關掉的操作」)────────────────────────────────────────
       兩件事一起改才對:**窗口加長**(3.6 → 6 秒,6 人局那張表要讀得完)
       + **一顆「看完了」的鈕**。只加長會變成「每一局都在等」,只給鈕又還是讀不完。

     ── ★★★ v1.95.0:連線改成**全部人按完才一起跳**(不是誰先按誰說了算)────────────
       使用者:「我不希望是誰按就全桌一起跳,麻煩改一下變成**全部都按完了才一起跳**」。
       ★★ v1.94.0 是「誰先按誰推進」(按鈕直接送 `advance`)—— 那會**把別人正在讀的
          畫面翻掉**,而這一頁的過場正是為了「讀得完」才存在的。整個抵銷掉。
       ★ 所以按鈕從「跳過」變成**投票**:按下去只代表「**我**看完了」,
         **每一個還在房裡的座位都按過**才推進(連線那一側的 `maybeNext`)。
         時間到(SETTLE_MS)照舊自動推進 —— 那是**後備**,擋掉「有人放著不管全桌乾等」。
       ★★ 「按了會發生什麼事」由**呼叫端**給(`v.onSkip`)—— 面板只有這一份:
            單機 → 立刻跑 `nextRound()`(只有我一個人,不必等)
            連線 → 送一筆「繼續」(`sendNext`);湊齊了才由 `maybeNext` 叫 `advance`
       ⚠⚠ 因此 `skipHand()` **不可以自己把過場收掉** —— 連線按完還要**留在畫面上**
         看「還在等幾人」。收不收由呼叫端的流程決定(單機是 `startRound` 收、
         連線是下一個快照相位變了就收)。v1.94.0 那個 `handDone` 旗標因此**拿掉了**:
         它當初是為了擋「本地先收掉、advance 還在飛」那一下的閃回來,而現在不收了。
       ⚠ v1.92.0 那條註解(「這一頁沒有跳過鈕」)與 v1.94.0 那條(「全桌一起跳」)
         **都已經被推翻**,不要照舊文件加回去。
       ⚠ **能點的只有那顆鈕與卡片外面的空白**(`.bj-hcard` 本身不吃點擊)——
         中間那張表是可以捲的,整片都能點的話「捲到一半手指離開」會誤按。
       ⚠ 按過了再按**不用 disabled**(CLAUDE.md 的紅線):照樣按得動,只是說得出
         「你已經按過了 —— 還在等其他人」。
     ========================================================================== */
  /* v = { st, names[], me, sc, chips[], key, title, foot, ms,
           skipTxt, skipDone, skipWait, onSkip }
       skipDone 我按過了沒 · skipWait 還在等幾個人(0 = 不必等,單機一律 0)
       ⚠ 這兩格由**呼叫端**算(只有它知道「誰還在房裡」)—— 面板只負責畫。 */
  function showHand(v){
    const box = $("bjHand");
    if(!box || !v || !v.st || !v.sc) return;
    const fresh = (v.key !== handKey);
    handKey = v.key; handOn = true;
    hSkip = (typeof v.onSkip === "function") ? v.onSkip : null;
    hVoted = !!v.skipDone;
    box.innerHTML = handHTML(v);
    box.classList.add("show");
    /* ★ 結算聲只在**第一次**開的時候響(去重就是 handKey 的存在理由),
       而且刻意慢 320ms —— 翻牌那一刻 announce 可能剛喊完「21 點」/「爆了」,
       兩聲疊在一起會糊成一團。 */
    if(!fresh) return;
    const row = (v.me >= 0 && v.sc.rows) ? v.sc.rows[v.me] : null;
    const d = row ? row.delta : 0;
    setTimeout(() => { if(handOn && handKey === v.key) settleSfx(d); }, 320);
  }
  function hideHand(){
    if(!handOn) return;                    // ★ 每次 paint 都會叫一次 → 沒開就什麼都不做
    handOn = false;
    hSkip = null; hVoted = false;
    const box = $("bjHand");
    if(!box) return;
    box.classList.remove("show");
    box.innerHTML = "";
  }
  /* 按下「看完了」(那顆鈕 / 卡片外面的空白)。
     ⚠⚠ **這裡不收畫面**(v1.95.0):連線按完要留著看「還在等幾人」——
       收不收由呼叫端的流程決定(單機 startRound 收 / 連線相位變了就收)。
     ⚠ 按過了再按不用 disabled(CLAUDE.md 的紅線),要說得出原因。 */
  function skipHand(){
    if(!handOn) return;
    if(hVoted){ showToast("你已經按過了 —— 還在等其他人"); return; }
    Sound.takeback();                      // 很輕的一聲「收到了」(與停手同一顆)
    if(hSkip) hSkip();
  }
  function handHTML(v){
    const st = v.st, sc = v.sc, me = v.me;
    const row = (me >= 0 && sc.rows) ? sc.rows[me] : null;
    const d = row ? row.delta : 0;
    const chip = (v.chips && me >= 0) ? v.chips[me] : null;
    /* 大字:我這一把 ±多少。★ 我當莊時 row.delta 就是「通吃 / 通賠」的總和(settle 已經算好),
       所以這裡一個特判都不用寫。⚠ 中途加入還沒上桌的人(me < 0)沒有這一格。 */
    const big = (me < 0) ? "旁觀" : ((d > 0 ? "+" : "") + d);
    const cls = (me < 0) ? "none" : (d > 0 ? "up" : (d < 0 ? "down" : "even"));
    const why = (me < 0) ? "這一局你還沒上桌 —— 下一局就發你牌"
      : (R.tagTxt(row ? row.tag : "") +
         (row && row.caught >= 0 ? "(被抓時莊 " + row.dBest + ")" : "") +
         (chip !== null && chip !== undefined ? " · 手上 " + chip : ""));
    return '<div class="bj-hcard">' +
             '<div class="bj-httl">' + esc(v.title || "本局結算") + '</div>' +
             '<div class="bj-hbig ' + cls + '">' + esc(big) + '</div>' +
             '<div class="bj-hwhy">' + esc(why) + '</div>' +
             '<div class="bj-hlist">' +
               resultHTML(st, v.names || [], me, sc, v.chips || null, "") +
             '</div>' +
             /* 進度條:這一段還剩多久。★ 動畫時長寫成 **inline 的 CSS 變數**
                (逐字沿用倒數環那條 `--cd-dur` 的做法)—— 量 computed 的
                animationDuration 在 headless 的 virtual-time 下會被壓成 0.001s
                而且時有時無(v1.91.0 踩過),所以守門一律看這個 inline 值。 */
             '<div class="bj-hbar" style="--bj-hdur:' +
               (Math.max(400, v.ms || 3000) / 1000) + 's"><i></i></div>' +
             /* ★★★ v1.94.0:看完可以按(使用者:「我希望有可以快速關掉的操作」)。
                ★★★ v1.95.0:連線改成**投票** —— 按過了就換成「等待中 · 還在等 N 人」
                (使用者:「不希望是誰按就全桌一起跳,變成全部都按完了才一起跳」)。
                ⚠ 鈕上的字由**呼叫端**給:最後一局要寫「看結果」而不是「下一局」,
                  而「這是不是最後一局 / 還在等幾人」只有呼叫端算得出來。
                ⚠ 按過了**不用 disabled**(CLAUDE.md 的紅線):只加 `.voted` 變暗,
                  照樣按得動 → skipHand 會說「你已經按過了」。
                ⚠ 這一列要**在進度條下面**:它是「不想等就按」,而進度條是「還剩多久」——
                  順序反過來讀起來像「按了才開始倒數」。 */
             '<div class="bj-hend">' +
               '<span class="bj-hfoot">' + esc(footTxt(v)) + '</span>' +
               '<button class="btn primary bj-hskip' + (v.skipDone ? " voted" : "") +
                 '" type="button">' +
                 esc(v.skipDone ? "等待中" : (v.skipTxt || "下一局")) + '</button>' +
             '</div>' +
           '</div>';
  }
  /* 腳註那一句。★ 按過了就換成「還在等誰」—— 那是投票制唯一需要多講的事,
     而「還在等幾人」只有呼叫端算得出來(它才知道誰還在房裡)。 */
  function footTxt(v){
    if(v.skipDone && v.skipWait > 0) return "還在等 " + v.skipWait + " 人按「繼續」…";
    if(v.skipDone) return "大家都看完了 —— 馬上開下一局";
    return v.foot || "準備下一局…";
  }

  /* ==========================================================================
     八之三、★ 房規清單 —— 單機與連線**共用這一份**
     ──────────────────────────────────────────────────────────────────────────
       ★★ 使用者的原話:「剛開始的時候我把規則寫清楚,記得要一條一條的線,
          不要全部規則擠在一起」→ **一條一行、每行只講一件事**(<li>),
          而且每一行都跟著目前的房規變(不是一份寫死的說明)。
       ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。
       ⚠ 面板與文案**只准一份** —— 單機與連線各寫一份是這個專案最痛的那類走鐘
         (全螢幕 / 表情 / 罐頭句 / 大老二的三個音效呼叫點都踩過),
         而走鐘了兩邊各自都不會壞、沒有東西抓得到。
     ========================================================================== */
  /* firstName = 被「點名」的那一位叫什麼(只有呼叫端解讀得出 token:連線是 pid、
     單機是座位號)。★ 不傳 / 傳空字串 = 那個人已經不在 → 文案自己退回「第 1 家」,
     ⚠ 這一支**不可以**自己去查名單:它同時服務單機與連線,查得到的只會是其中一邊。 */
  function rulesHTML(rules, firstName){
    const r = R.normRules(rules);
    const L = [];
    /* ★★★ v1.88.0:誰先當莊 + 之後照座位號碼輪(使用者:「為什麼我總是最後」/
       「房主需要能夠指定誰先當莊的順序,或是隨機之類的」)。
       ⚠ 這一行要排在「輪流當莊」前面:它決定的是**起點**,先講起點才讀得順。 */
    L.push("<b>誰先當莊</b> —— " + (
      r.first === R.FIRST_RAND ? "開局<b>隨機</b>抽一位"
        : (R.firstTok(r.first)
            ? (firstName ? ("房主點名 <b>" + esc(firstName) + "</b>")
                         : "房主點名的那一位(<b>他已經不在了 → 由第 1 家開始</b>)")
            : "<b>房主</b>")
    ) + ";之後<b>照座位號碼往下輪</b>(第 1 家 → 第 2 家 → … → 繞回來)。");
    /* ★★★ v1.87.0:換莊頻率可調 → 這一行**不可以**寫死「每一局換」
       (使用者:「現在是每一把就換莊,但我要這個是可以調整的」)。 */
    L.push(r.hands > 1
      ? ("<b>輪流當莊</b> —— 同一個人<b>連做 " + r.hands + " 局</b>才換下一位。")
      : "<b>輪流當莊</b> —— <b>每一局</b>換一個人當莊。");
    L.push("一輪 = 每個人各當一次莊(" + (r.hands > 1 ? ("也就是 " + r.hands + " 局") : "1 局") +
           ");這一場打 <b>" + r.rounds + " 輪</b>(所以當莊次數一樣,公平)。");
    L.push("一副 52 張、<b>每一局重新洗牌</b> —— 算牌沒有意義,不必記。");
    L.push("起始籌碼 <b>" + r.start + "</b>;每一局押 <b>1 ~ " + r.betMax +
           "</b> 之間任何一個數字(用加減鈕調)。");
    L.push("<b>不會被淘汰</b> —— 籌碼可以打到負的,排名看的是「賺賠多少」。");
    L.push("<b>閒家同時補牌</b>,不必等別人;莊家最後才動。");
    L.push("A 算 <b>1 或 11</b>(畫面會同時顯示兩種點數);超過 21 就爆。");
    /* ★★★ v1.92.0:**牌型大小**一定要有自己一行(使用者:「現在過五關跟 blackjack
       到底是誰比較大,然後有真的都賠兩倍嗎」)。
       ★ 舊版只各寫「21 點賠 N 倍」「過五關賠 2 倍」兩行 —— 兩個**階**誰大完全沒講,
         而它是 settle 的第一條判斷(t > dt 就直接贏,不看點數)。
       ⚠ 括號裡那個例子不是裝飾:「15 點贏 21 點」看起來像 bug,不舉例沒有人會相信。
       ★★★ v1.93.0:**21 點變成最大的階**(使用者:「幫我改成 black jack 比較大」)——
         而這一行**不可以自己寫死順序**:名字一律由 `BJ.T_NAME` 照階排出來,
         哪天再互換一次這一行自動跟著對(它與規則層是同一個順序)。 */
    const tiers = r.dragon ? [R.T_BJ, R.T_DRAGON, R.T_NORM] : [R.T_BJ, R.T_NORM];
    L.push("<b>牌型大小</b> —— <b>" +
           tiers.map(t => (t === R.T_NORM ? "普通點數" : R.T_NAME[t])).join(" &gt; ") +
           "</b>,爆掉最小;<b>階不一樣就直接比階、不看點數</b>" +
           (r.dragon ? "(所以兩張的 21 點<b>贏</b>五張的過五關)" : "") + "。");
    /* ★ v1.93.0:兩個階**都是 2 倍**(面板那一列拿掉了)。
       ⚠ 這裡照舊印 `r.bjPay` 而不是寫死 2 —— 舊房主凍進 game.rules 的 1.5
         要讓清單講實話(規則層 mulOf 也還讀得懂它,見 rules.js 第四節)。 */
    L.push("<b>21 點</b> = 前兩張就湊到 21,賠 <b>" + r.bjPay + " 倍</b>" +
           (r.dragon ? " —— 它是<b>最大的牌型</b>" : "") + "。");
    L.push(r.dragon
      ? ("<b>過五關</b> = 五張牌不爆,賠 <b>2 倍</b>(莊家也能報,那就通吃全場);" +
         (r.bjPay === 2 ? "與 21 點<b>一樣是 2 倍</b>,但<b>比 21 點小</b>"
                        : "目前設定下它<b>比 21 點賠得多</b>,但階<b>比 21 點小</b>") + "。")
      : "<b>過五關關掉了</b> —— 五張不爆只是普通手,照點數比大小。");
    L.push("<b>不做</b>加倍 / 分牌 / 保險 / 投降 —— 想賭大一點就在下注那一段押多一點。");
    /* ★★★ v1.86.0:補牌線是**莊閒都適用的下限**(使用者:「莊家跟玩家都要一同遵守」)。
       ⚠ 舊版那句「只有莊家受限 / 閒家永遠自己決定」已經是**錯的**,不要照舊文件加回來。 */
    L.push(r.line
      ? ("<b>補牌線 " + r.line + "</b> —— <b>莊家和閒家都一樣</b>:沒到 " + r.line +
         " 不能停;到了之後要不要再補<b>自己決定</b>。")
      : "<b>沒有補牌線</b> —— 要補到幾點、什麼時候停,每個人自己決定。");
    /* ★★ 抓人:這一版的核心玩法,一定要有一行講它 */
    L.push(r.line
      ? ("<b>抓人</b> —— 莊家補到 " + r.line + " 之後,可以隨時指名一家<b>先比較</b>;" +
         "比完他還能繼續補牌再抓下一家。")
      : "<b>抓人</b> —— 莊家可以隨時指名一家<b>先比較</b>;比完他還能繼續補牌再抓下一家。");
    L.push("被抓的人<b>比的是莊家那一刻的點數</b>,之後莊家補到幾點都與他無關。");
    /* ★ 牌情:這一版每個人的第一張都蓋著,規則清單一定要講(不然玩家以為是 bug) */
    L.push("除了自己,<b>每個人的第一張牌都是蓋著的</b>;被抓、爆掉或結算時才翻開。");
    L.push(r.pushDealer
      ? "同點數(平手)<b>莊家吃</b>。"
      : "同點數(平手)<b>退注</b>,誰都不賺不賠。");
    L.push(r.bustFirst
      ? "<b>閒家先爆就先輸</b> —— 就算莊家後來也爆,你還是輸(莊家的優勢就在這一條)。"
      : "<b>兩邊都爆算退注</b> —— 這樣莊家幾乎沒有優勢了。");
    L.push(r.sec
      ? ("每一段操作 <b>" + r.sec + " 秒</b>,時間到系統幫他決定(沒押注的押最小注、沒停手的自動停)。")
      : "<b>不限時</b> —— 沒人催,有人離開牌桌全桌會一直等。");
    return '<ul class="bj-rules">' + L.map(x => "<li>" + x + "</li>").join("") + '</ul>';
  }

  /* ==========================================================================
     九、掛載
     ──────────────────────────────────────────────────────────────────────────
       ★ 這一頁**沒有點牌**(不必選牌、不必拖曳排序),但 v1.87.0 起**點得到「人」**:
         抓人展開時整格就是那顆鈕 → 所以除了動作列,盤面也要綁一個 click。
       ⚠ 用 click 而不是 pointerup:e2e 一律用 `el.click()` 驅動,
         而合成的 click 不會產生 pointer 事件(大老二 v1.80.0 那條教訓)。
     ========================================================================== */
  function mount(h){
    stage = $("bjStage");
    acts = $("bjActs");
    hAct = h && h.onAct;
    /* ★★★ 過場的「點掉」(v1.94.0)。
       ⚠ **只認那顆鈕與卡片外面的空白** —— `.bj-hcard` 裡面那張表是可以捲的,
         整片都能點的話「捲到一半手指離開」會誤跳一局(而那一局就再也看不到了)。
       ⚠ 綁在這裡(掛載時一次)而不是每次 showHand 重綁:過場的 innerHTML 每一次
         重畫都會換掉,重綁就會疊上好幾層監聽(同一下點擊送出好幾次 advance)。 */
    const hand = $("bjHand");
    if(hand){
      hand.addEventListener("click", e => {
        if(e.target.closest(".bj-hskip") || e.target === hand) skipHand();
      });
    }
    /* ★★★ 牌桌上點人抓人(v1.87.0)。
       ⚠ 只認 `data-grab` —— 那個屬性只有 boxHTML 在「抓人展開 + 我是莊家 +
         BJ.canGrab 說抓得動」時才發,所以這裡不必也**不可以**再判斷一次相位
         (再判一次就是第二份真相,而錯開的方向是「抓到不該抓的人」)。
       ⚠ 收掉 grabOpen 一定要在送出**之前**:呼叫端會同步重畫,
         晚一步的話那一格還亮著、看起來像沒吃到。 */
    if(stage){
      stage.addEventListener("click", e => {
        const box = e.target.closest("[data-grab]");
        if(!box) return;
        grabOpen = false;
        if(hAct) hAct("g", +box.dataset.grab);
      });
    }
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest(".bj-act");
        if(!b) return;
        /* ★ 加減鈕**不往上送** —— 它只改「還沒送出去的金額」,是純畫面的事
           (真的下注是後面那顆「押注 ▸」,它才帶 data-act="bet")。 */
        if(b.dataset.act === "bstep"){ bumpBet(+b.dataset.d || 0); return; }
        /* ★ 「抓人 ▸」與「✕」同樣**不往上送**:它們只開關那一排名字鈕。
           ⚠ 抓不動的時候照樣按得動 → 由呼叫端跳 BJ.denyTxt(不用 disabled)。 */
        if(b.dataset.act === "gopen"){
          const lg = lastInfo && lastInfo.legal;
          if(!lg || !lg.grab){
            if(hAct) hAct("gdeny", 0);          // 讓呼叫端用 BJ.denyTxt 說得出原因
            return;
          }
          grabOpen = true;
          renderActs(lastInfo);
          /* ★ 一定要讓呼叫端把**牌桌**也重畫一次 —— 抓得動的那幾格要亮起來,
             而它們是 render() 畫的(動作列與牌桌是兩塊)。 */
          if(hAct) hAct("grepaint", 0);
          return;
        }
        if(b.dataset.act === "gcancel"){
          grabOpen = false;
          renderActs(lastInfo);
          if(hAct) hAct("grepaint", 0);        // ★ 讓呼叫端把牌桌也重畫(亮框要收掉)
          return;
        }
        if(!hAct) return;
        hAct(b.dataset.act, b.dataset.bet ? +b.dataset.bet : 0);
      });
    }
  }

  return {
    mount, render, renderActs, resultHTML, matchHTML, rulesHTML, chipHTML, stopCd,
    cardHTML, backCard, cardsHTML, pipHTML, handOf, ptOf,
    // 公告(單機與連線共用):爆 / 21 點 / 過五關 / **被抓** / **有人押注** / **莊家翻牌**
    announce, resetAnnounce,
    // ★★ 一局結束的過場(v1.92.0,單機與連線共用一份)
    showHand, hideHand,
    // 一個動作的聲音(四個呼叫點共用)
    moveSfx, bustSfx, bjSfx, dragonSfx, grabSfx,
    /* ★★ v1.92.0 新加的四種聲音 + 喊牌語音。
       ⚠ dealSfx 有**兩個呼叫點**(單機 maybeDeal / 連線相位換手)→ 兩條接線斷言;
         chipSfx / revealSfx / settleSfx 各只有一個(announce / showHand 裡面)。 */
    dealSfx, chipSfx, revealSfx, settleSfx, evSfx, primeVoice,
    // 給 e2e 用:抓人那一排展開了沒(純畫面狀態)
    _grabOpen: () => grabOpen,
    // 給 e2e 用:過場開著沒 / 開的是哪一局 / 我按過「看完了」沒(全是純畫面狀態)
    _handOn: () => handOn, _handKey: () => handKey, _handVoted: () => hVoted,
    /* 給 e2e 用:版型的算式(v1.88.1)—— **餵尺寸進去**,不吃畫面。
       ★ 這是「一列幾格挑牌最大的那一種」唯一測得到的角度:
         真的靠視窗量的話,斷言會跟著跑測試的視窗大小飄。 */
    _eval: evalPlan, _pick: pickPlan
  };
})();

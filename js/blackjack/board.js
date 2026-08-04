"use strict";

/* ============================================================================
   21 點 — 盤面(BJB)。牌桌 / 莊家 / 其他閒家 / 我的手牌 / 動作列 / 結果卡都在這裡畫。

   ── ★★★ 尺寸由 fitTable() **一支**算(v1.87.0 改的)──────────────────────────
     v1.86.0 之前是「牌寬交給 CSS 的係數、格高由 JS 平分」→ **兩份真相**,
     視窗一矮就變成「格子 32px、牌高 71px」= 每一張牌都被切掉一截
     (使用者:「玩家的牌沒有完整顯示」)。v1.87.0 把牌寬 / 格高 / 莊家台高度
     收成 fitTable() 一支算出來的三個 literal,格高 = 牌高 + 固定裝潢 →
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
     ① 牌寬 / 一格的高度 / 莊家台的高度只有 fitTable() 一個來源,而它只吃
        「人數 + 視窗」→ 補一張牌不會讓任何東西換大小
     ② 牌桌 `flex:1 1 auto`(吃掉盤面剩下的空間,但**不隨自己的內容變**)
     ③ 動作列 `.bj-acts` 固定高度 `--bj-acth`(下注鈕 / 三顆動作鈕 / 一行字 / 倒數環 /
        **抓人那一列** 換來換去,高度不能跟著變)
   ========================================================================== */

const BJB = (function(){

  const R = BJ;
  let stage = null, acts = null;
  let hAct = null;                          // 按動作鈕的回呼(這一頁沒有點牌,只有按鈕)
  let cdKey = "", cdT = null;               // 倒數環:用 key 去重,不看 timer(見 syncCd)
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
  function cardsHTML(cards, cls, hidx){
    if(!cards || !cards.length) return "";
    const k = (hidx === undefined || hidx === null) ? -1 : hidx;
    let h = "";
    for(let i = 0; i < cards.length; i++)
      h += (i === k) ? backCard(cls) : cardHTML(cards[i], cls);
    return h;
  }
  /* 某個座位的一手牌 + 它的點數膠囊 —— ★ 牌情只在這兩支裡落地。 */
  function handOf(st, seat, me, cls){
    if(!st) return "";
    return cardsHTML(st.hands[seat], cls, R.hiddenIdx(st, seat, me));
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
     停手 / 爆了 / 被抓都是全桌看得到的動作(被抓的人牌也翻開了)。 */
  function stateHTML(st, s, betPhase, betDone){
    if(betPhase) return betDone ? '<span class="bj-st ok">已下注</span>'
                                : '<span class="bj-st wait">下注中…</span>';
    if(!st) return "";
    // ★ 被抓:講得出「被抓時莊家幾點」—— 同一局每個人比的莊家點數可能不一樣
    if(st.caught[s] >= 0){
      const dh = R.seatCards(st.cards, st.n, st.dealer, st.caught[s]);
      return '<span class="bj-st caught">🎯 已抓 · 莊 ' + R.valueOf(dh).best + '</span>';
    }
    if(st.hands[s] && R.valueOf(st.hands[s]).bust) return '<span class="bj-st bad">💥 爆了</span>';
    if(st.done[s]) return '<span class="bj-st ok">✋ 停</span>';
    const turn = (s === st.dealer) ? st.phase === "dealer" : st.phase === "play";
    return turn ? '<span class="bj-st wait">考慮中…</span>' : '<span class="bj-st">等待…</span>';
  }

  /* ★ 玩家晶片尾巴:「莊」記號 + 手上的籌碼 —— ★★ 單機與連線**共用這一份**。
     ★★ v1.85.0 把它收成一支的理由(使用者:「顯示每個人剩下多少籌碼,
        這部分的配色需要可以讓籌碼看的明顯一點」):
        籌碼那一格原本在 solo.js 的 paintBar 與 adapter.js 的 chipTail **各寫一份**,
        兩份的配色要一起改才會一致 —— 那正是這個專案最痛的那類走鐘,所以先併起來再改色。
     ★ 兩樣都是**公開資訊**(誰當莊全場都看得到;籌碼是結算過的歷史)。
     ⚠ 這一格一個字都不准提牌 —— 這一頁唯一藏起來的是莊家那張暗牌,而它在盤面上。
     · chip 手上的籌碼(= 起始 + 淨變化)· net 這一場的淨變化(可以是負的) */
  function chipHTML(chip, net, isDealer){
    return (isDealer ? '<span class="bj-chd" title="這一局的莊家">🎩 莊</span>' : "") +
           '<span class="bj-chc" title="手上的籌碼">💰<b>' + chip + '</b>' +
             (net ? '<i class="' + (net > 0 ? "up" : "down") + '">' +
                    (net > 0 ? "+" : "") + net + '</i>' : "") +
           '</span>';
  }

  /* ==========================================================================
     二、莊家那一格(牌桌最上面)
     ──────────────────────────────────────────────────────────────────────────
       ★ 我自己是莊家時這一格**不畫牌** —— 那副牌在底下我的手牌區(我看得到兩張)。
         畫兩次會讓人以為桌上有兩副;而高度兩種情形完全一樣(頭列 + 牌列),
         所以切換莊家不會讓底下的手牌跳。
     ========================================================================== */
  function dealerHTML(v){
    const st = v.st, d = st ? st.dealer : -1;
    const mine = d >= 0 && d === v.me;
    const nm = (v.names && v.names[d]) || "莊家";
    /* ★★ 暗牌:蓋哪一張只問 BJ.hiddenIdx(唯一的判斷式)。
       ⚠ 例外只有一個:我自己就是莊家時那兩張都是我的牌 —— hiddenIdx 自己處理了。 */
    /* ⚠ v1.87.0 起**不挑尺寸 class** —— 牌桌上每一張牌都吃 --bj-cardw
       (使用者:「我要跟莊家的牌大小一樣」)。這裡塞 "dbig" 回去就是又變成兩份真相。 */
    const body = st ? handOf(st, d, v.me, "")
                    : '<span class="bj-dwait">等發牌…</span>';
    return '<div class="bj-dealer' + (mine ? " me" : "") +
             (st && st.phase === "dealer" ? " act" : "") + '">' +
             '<div class="bj-dcs">' + body + '</div>' +
             '<div class="bj-dinfo">' +
               '<div class="bj-dtop">' +
                 '<span class="bj-crown" title="這一局的莊家">🎩</span>' +
                 '<span class="bj-dnm">' + esc(nm) + '</span>' +
                 '<span class="bj-dtag">莊家</span>' +
                 (mine ? '<span class="bj-you">你</span>' : "") +
               '</div>' +
               '<div class="bj-dsub">' + esc(v.dsub || "") + '</div>' +
             '</div>' +
             (st ? ptOf(st, d, v.me) : pipHTML(null)) +
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

  /* 一個注區。★ 我自己那一格獨占整列;★★ v1.87.0 起**每個人的牌同一個尺寸**
     (牌寬吃 --bj-cardw,由 fitTable 一支算出來)—— 所以這裡一個 class 都不必挑。
     ⚠ 高度**不再由這裡的 inline style 給**:一格的高度 = 牌高 + 固定裝潢,
       同樣由 fitTable 算(見它的註解:那正是「牌被裁掉」的根治法)。 */
  function boxHTML(v, s, basis){
    const st = v.st, mine = s === v.me;
    const nm = mine ? "你" : ((v.names && v.names[s]) || ("玩家" + (s + 1)));
    const bet = v.bets ? v.bets[s] : 0;
    const bust = !!(st && st.hands[s] && R.valueOf(st.hands[s]).bust &&
                    R.openTo(st, s, v.me));
    const turn = !!(st && st.phase === "play" && !st.done[s]);
    const tgt = grabbable(v, s);
    let cls = "bj-box";
    if(mine) cls += " me";
    if(bust) cls += " bust";
    if(st && st.caught[s] >= 0) cls += " caught";
    if(turn) cls += " act";
    /* ★★★ v1.87.0:抓人展開時**整格就是那顆鈕**(使用者:「我是想要直接在牌桌上點人」)。
       data-grab 是唯一的落點 —— mount 那邊只認它,不認 class(class 是給樣式看的)。 */
    if(tgt) cls += " target";
    return '<div class="' + cls + '" style="flex:0 0 ' + (mine ? "100%" : basis) + '"' +
             (tgt ? ' data-grab="' + s + '" role="button" title="抓這一家先比較"' : "") + '>' +
             '<div class="bj-bhd">' +
               '<span class="bj-dot p' + s + '"></span>' +
               '<span class="bj-bnm">' + esc(nm) + '</span>' +
               (mine ? '<span class="bj-you">你</span>' : "") +
               // ⚠ 這個記號只講「抓不抓得動」(公開資訊),一個字都不准夾帶牌情
               (tgt ? '<span class="bj-gtip">🎯 抓</span>' : "") +
               (bet ? '<span class="bj-bet" title="這一局押多少"><i>押</i>' + bet +
                      (st && st.dbl[s] ? '<b>×2</b>' : '') + '</span>' : "") +
             '</div>' +
             '<div class="bj-bcs">' +
               (st ? handOf(st, s, v.me, "")
                   : '<span class="bj-bwait">🎴 等發牌…</span>') +
             '</div>' +
             '<div class="bj-bft">' +
               (st ? ptOf(st, s, v.me) : "") +
               stateHTML(st, s, v.betPhase, v.betDone && v.betDone[s]) +
             '</div>' +
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
  const boxBasis = () => "calc((100% - " + ((BOX_FIT - 1) * BOX_GAP) + "px) / " + BOX_FIT + ")";
  /* 注區有幾列(★ 只吃**人數**,所以一整局不變 → 版面不會跳)。 */
  function boxRows(n, d, meOut){
    const k = Math.max(1, n - (d >= 0 ? 1 : 0)) + (meOut ? 1 : 0);
    return Math.min(3, 1 + Math.ceil(Math.max(0, k - 1) / BOX_FIT));
  }
  function boxesHTML(v){
    const st = v.st;
    const n = v.n || (st ? st.n : 2);
    const d = st ? st.dealer : -1;
    const basis = boxBasis();
    /* ★★ 我自己那一格**排第一個**(v1.87.0)。
       ⚠ 理由不是好看:矮視窗放不下所有列時注區會捲(overflow-y:auto),而那時
         最不能被捲出去的就是**我的牌**。排第一個 = 一定看得到。
       ★ 列數不受影響:我那一格是 flex:0 0 100%(強制換行),放前面放中間都一樣。 */
    let rows = "";
    if(v.me >= 0 && v.me < n && v.me !== d) rows += boxHTML(v, v.me, basis);
    for(let s = 0; s < n; s++){
      if(s === d || s === v.me) continue;      // 莊家在上面那一條;我已經畫過了
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
     三之二、★★★ 牌寬與格高 —— v1.87.0 收成**同一支** fitTable()
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
  const BOX_PADX = 10;        // .bj-box 左右 padding 合計
  /* 一格裡「除了牌以外」的高度(padding + 兩個 gap + 頭列 + 尾列)。
     ★★ 這是**起始猜測**,實際值由 learnChrome() 從畫面上量回來(見它的註解)——
        寫死一個常數的話,矮視窗那幾條 media query 一改字級 / padding 就會與它錯開,
        而錯開的方向是「又開始裁牌」。量出來的第一版是 57。
     ⚠ 猜大了只是牌小 1~2px(沒有壞處);猜小了就是使用者說的「牌沒有完整顯示」。 */
  let BOX_CHROME = 58;
  const DEALER_PAD = 24;      // 莊家台上下 padding + border
  const DEALER_INFO = 48;     // 莊家台右邊那疊字的高度(名字列 + 兩行提示)
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
  function fitTable(rows){
    if(!stage) return null;
    const H = tableSpace(), W = stage.clientWidth || 0;
    // 還沒排版(畫面還是 hidden)→ 回 null,這一次交給 CSS 的後備值,下一次重畫就對了
    if(H <= 0 || !W) return null;
    const avail = H - TABLE_PAD * 2 - ROW_GAP - (rows - 1) * BOX_GAP;
    const byH = (avail - DEALER_PAD - rows * BOX_CHROME) / (rows + 1);
    const inner = W - TABLE_PAD * 2;
    // rows ≥ 2 才有半寬的格子(rows = 1 時只有我那一格,它是整列寬)
    const bw = (rows >= 2) ? (inner - BOX_GAP) / 2 : inner;
    const byW = (bw - BOX_PADX - (MAXC - 1) * CARD_GAP) / MAXC;
    let cw = Math.floor(Math.min(byH / CARD_R, byW, CARD_MAX));
    cw = Math.max(CARD_MIN, cw);
    const ch = Math.round(cw * CARD_R);
    return { cw: cw, bxh: ch + BOX_CHROME, dlh: Math.max(ch, DEALER_INFO) + DEALER_PAD };
  }
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
    const bx = stage.querySelector(".bj-box");
    const bc = bx && bx.querySelector(".bj-bcs");
    if(!bx || !bc || !bx.offsetHeight) return false;
    const c = bx.offsetHeight - bc.offsetHeight;
    if(!(c > 0) || Math.abs(c - BOX_CHROME) < 0.5) return false;
    BOX_CHROME = Math.ceil(c);
    return true;
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
  function render(v){
    if(!stage) return;
    const n = v.n || (v.st ? v.st.n : 2);
    const d = v.st ? v.st.dealer : -1;
    /* ★★★ v1.87.0:牌寬 / 一格的高度 / 莊家台的高度**一次算好掛在牌桌上**
       (見 fitTable 的註解 —— 三個數字同一個來源,所以牌永遠裁不到、也永遠一樣大)。
       ⚠ 一定要在寫 innerHTML **之前**量 stage:牌桌是 flex:1、高度不吃自己的內容,
         所以量到的是穩定值;寫完再量就多一次 reflow 而且答案一樣。 */
    const rows = boxRows(n, d, v.me < 0);
    const fit = fitTable(rows);
    const sty = fit ? (' style="' + fitStyle(fit) + '"') : "";
    stage.innerHTML =
      '<div class="bj-table"' + sty + '>' +
        dealerHTML(v) +
        boxesHTML(Object.assign({}, v, { n: n })) +
      '</div>';
    /* ★ 量一次「一格的裝潢有多高」;與上一次不一樣就當場用新數字改 CSS 變數
       (只改變數、不重寫 innerHTML → 不閃、也不會變成無窮迴圈,見 learnChrome)。 */
    if(fit && learnChrome()){
      const f2 = fitTable(rows);
      const tb = stage.querySelector(".bj-table");
      if(f2 && tb) tb.setAttribute("style", fitStyle(f2));
    }
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
                             betPend + '">押注 ▸</button>') +
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
           '" data-act="gopen">抓人 ▸</button>';
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

  /* 倒數環。★ **全桌都看得到**(「現在在等誰、還剩幾秒」是公開資訊,
     讓大家知道為什麼卡著)—— 判準同排七 / 大老二 / 台灣麻將。

     ★ 兩個從台灣麻將繼承的坑(notes/11 第三節):
       ① 用**負的 animation-delay** 接續播放,duration 永遠是那一段的總長
          —— 這樣 e2e 才量得到設定值。
       ② 去重的 key **不可以看 timer 還在不在**:數字走到 0 之後 interval 就停了,
          而 timer 本身還有幾百毫秒沒響;那段空窗裡只要有人再叫一次 renderActs()
          環就會彈回滿格,而那個彈跳本身就是雜訊。
     ⚠ 動畫關鍵影格 svCd 是排七那一段定義的,這裡刻意沿用同一個(不再定義一份同名的)。 */
  function syncCd(info){
    const box = $("bjCdWrap");
    if(!box) return;
    if(!info.cdMs || !info.cdEnd || info.over){ stopCd(); return; }
    const key = info.cdMs + ":" + info.cdEnd;
    const left = info.cdEnd - Date.now();
    if(left <= 0){ stopCd(); return; }
    box.innerHTML =
      '<span class="bj-cd" id="bjCd" style="--cd-dur:' + (info.cdMs / 1000) + 's;--cd-delay:' +
      (-(info.cdMs - left) / 1000) + 's"><i></i><b id="bjCdN">' + Math.ceil(left / 1000) + '</b></span>';
    if(key === cdKey && cdT) return;          // 同一段倒數:重畫畫面不重跑動畫
    cdKey = key;
    if(cdT) clearInterval(cdT);
    cdT = setInterval(() => {
      const el = $("bjCdN");
      const ms = info.cdEnd - Date.now();
      if(!el || ms <= 0){ clearInterval(cdT); cdT = null; return; }
      el.textContent = Math.ceil(ms / 1000);
    }, 250);
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = "";
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

  /* 這一頁的聲音刻意**全部是合成音**(沒有語音檔)。
     ⚠ 哪天要補「爆了 / 21 點」的人聲(照大老二那兩格),音效槽一定要帶 `{ el:true }` ——
       使用者是**直接用瀏覽器開網頁**(`file://`),那時 fetch 被擋,
       沒有它永遠載不到音檔,而且**在 http:// 下完全測不出來**(大老二 v1.81.0 真的漏過);
       而音檔進 mp3/ 要**同一版**補 sw.js 的 CORE(addAll 是全有全無)。 */
  function bustSfx(){
    if(typeof Sound === "undefined") return;
    // 下行兩音 + 尾巴滑下去 = 爆了(與 21 點的上行完全相反,不看畫面也分得出來)
    Sound.tone(330, { type: "sawtooth", dur: 0.10, vol: 0.20 });
    Sound.tone(196, { type: "sawtooth", dur: 0.26, vol: 0.20, delay: 0.08, slideTo: 110 });
  }
  function bjSfx(){
    if(typeof Sound === "undefined") return;
    // 三音上行 = 21 點
    Sound.tone(523, { type: "triangle", dur: 0.10, vol: 0.26 });
    Sound.tone(659, { type: "triangle", dur: 0.10, vol: 0.26, delay: 0.09 });
    Sound.tone(880, { type: "triangle", dur: 0.28, vol: 0.28, delay: 0.18 });
  }
  function dragonSfx(){
    if(typeof Sound === "undefined") return;
    // 過五關比 21 點更誇張一階(它更難、賠得更多)
    Sound.tone(587, { type: "triangle", dur: 0.09, vol: 0.28 });
    Sound.tone(784, { type: "triangle", dur: 0.09, vol: 0.28, delay: 0.08 });
    Sound.tone(988, { type: "triangle", dur: 0.09, vol: 0.28, delay: 0.16 });
    Sound.tone(1319, { type: "triangle", dur: 0.34, vol: 0.30, delay: 0.24, slideTo: 1568 });
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

  /* 每次重畫都叫一次(單機 solo.paint() / 連線 adapter.paint() 各一行)。
     v = { st, names[], me, key } —— key 就是「這是哪一局」。 */
  function announce(v){
    const st = v && v.st;
    if(!st || !st.hands){ anPrev = null; anCaught = null; return; }
    const now = [], caught = [];
    for(let s = 0; s < st.n; s++){
      /* ⚠⚠ v1.86.0:**每個看不到牌的座位**都要記成「沒事」,不只莊家 ——
         喊「小美 21 點!」等於把她的底牌講出去。判斷式一律問 BJ.openTo。 */
      const hidden = !R.openTo(st, s, v.me);
      now[s] = hidden ? 0 : (R.valueOf(st.hands[s]).bust ? 1 : st.tier[s] + 2);
      caught[s] = st.caught[s] >= 0 ? 1 : 0;
    }
    if(anPrev === null || v.key !== anKey){
      anKey = v.key; anPrev = now; anCaught = caught; return;
    }
    let snd = null;
    /* ★ 抓人是公開事件(被抓的人牌當場翻開)→ 喊得出來。
       ⚠ 走 diff 而不是在動作點插一行 Sound —— 單機與連線的動作路徑完全不同,
         但「有人被抓了」在兩邊是同一個 diff(同爆 / 21 點那三種)。 */
    for(let s = 0; s < caught.length; s++){
      if(caught[s] && anCaught && !anCaught[s]){
        const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
        showToast((s === v.me ? "你被抓了" : ("莊家抓 " + nm)) + " 🎯", 2000);
        snd = grabSfx;
      }
    }
    anCaught = caught;
    for(let s = 0; s < now.length; s++){
      if(now[s] === anPrev[s]) continue;
      const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
      const who = (s === v.me) ? "你" : nm;
      if(now[s] === 1){ showToast(who + " 爆了 💥", 1800); snd = snd || bustSfx; }
      else if(now[s] === R.T_DRAGON + 2){ showToast(who + " 過五關!五張不爆 🐉", 2400); snd = dragonSfx; }
      else if(now[s] === R.T_BJ + 2){ showToast(who + " 21 點! 🎯", 2000); if(snd !== dragonSfx) snd = bjSfx; }
    }
    anPrev = now;
    /* ★ 一次重畫只響一聲:批次同步時有可能兩家同時爆,響兩聲會疊成噪音。
       ⚠ 優先權是「過五關 > 21 點 > 爆」(上面那三行的 snd 賦值就是在做這件事)。 */
    if(snd) snd();
  }
  // 換局 / 離場:把 diff 的種子清掉(下一次只記不響)+ 收掉抓人那一排
  function resetAnnounce(){ anPrev = null; anKey = ""; anCaught = null; grabOpen = false; }

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
          (isD ? '<span class="bj-crown">🎩</span>' : '<span class="bj-dot p' + s + '"></span>') +
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
  function rulesHTML(rules){
    const r = R.normRules(rules);
    const L = [];
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
    L.push("<b>21 點</b> = 前兩張就湊到 21,賠 <b>" + r.bjPay + " 倍</b>。");
    L.push(r.dragon
      ? "<b>過五關</b> = 五張牌不爆,賠 <b>2 倍</b>(莊家也能報,那就通吃全場)。"
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
    // 公告(單機與連線共用):爆 / 21 點 / 過五關 / **被抓**
    announce, resetAnnounce,
    // 一個動作的聲音(四個呼叫點共用)
    moveSfx, bustSfx, bjSfx, dragonSfx, grabSfx,
    // 給 e2e 用:抓人那一排展開了沒(純畫面狀態)
    _grabOpen: () => grabOpen
  };
})();

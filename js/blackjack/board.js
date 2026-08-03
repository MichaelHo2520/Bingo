"use strict";

/* ============================================================================
   21 點 — 盤面(BJB)。牌桌 / 莊家 / 其他閒家 / 我的手牌 / 動作列 / 結果卡都在這裡畫。

   ── ★ 這一頁**沒有** JS 算尺寸(照排七與大老二的結論)────────────────────────
     一手最多 5 張(五小龍開著時)、列數 = 人數(一整局不變),
     所以尺寸整份交給 CSS(flex + clamp)。JS 只寫兩個**資料**性質的數字:
       `--bj-slots`(我的手牌格位)· `.bj-seats` 的列數由人數決定。
     ⚠ 不要為了「牌少的時候放大一點」改回 JS 算 —— 那正是台灣麻將那一整類
       「忽大忽小」的來源。

   ── ★★ 牌情紅線 ──────────────────────────────────────────────────────────
     > **莊家的第二張牌(暗牌)在翻開之前不可以畫出來。**
     這一頁的隱藏與前七個遊戲**性質相反**:前面那些是「防偷看」(牌在 DB 是明碼,
     顯示端不畫),這一張是**規則本身**要求蓋著 —— 它有固定的位置、要看得出
     「那裡有一張牌,只是還沒翻」,所以用 `PKFace.backHTML()` 畫牌背。

     ★★ 判斷式**只有 `st.reveal` 一個欄位**(rules.js 算好的)。
        ⚠⚠ 絕對不可以在這裡自己寫「所有閒家都停手了吧」之類的近似條件:
          那種條件遲早與規則層錯開,而錯開的方向是**提早翻牌 = 洩漏牌情**。
     ★ 其他閒家的牌**全程明牌**,這是刻意的 —— 看隔壁那個人補到爆是這個遊戲的樂趣,
       而且賭場的桌上牌本來就是攤開的。
     ★ **例外只有一個**:我自己就是莊家時,那兩張都是我的牌,我當然看得到
       (落地點是 mineHTML —— 它畫的一律是 `v.me` 的手牌,不看 reveal)。

     守門用一條**精確的不變量**(不是關鍵字比對):
         盤面上的 .bj-card.back 張數  ===  (我不是莊 && !st.reveal) ? 1 : 0

   ── ★★ 「位置不准跳」的三件事(照大老二 v1.78.0 那一組)─────────────────────
     ① 我的手牌容器寬 = `--bj-slots` × 一格、靠左填(補牌只讓右邊長,左邊一格不動)
     ② 中間那塊 `flex:1 1 auto` + `min-height:--bj-trh`(吃掉盤面剩下的空間,
        但**不隨自己的內容變**:列數 = 人數,一整局不變)
     ③ 動作列 `.bj-acts` 固定高度 `--bj-acth`(下注鈕 / 三顆動作鈕 / 一行字 / 倒數環
        四種內容換來換去,高度不能跟著變)
     ⚠ ②③ 是 CSS 的事,但**改這支的任何一塊高度都要回頭看它們**。
   ========================================================================== */

const BJB = (function(){

  const R = BJ;
  let stage = null, acts = null;
  let hAct = null;                          // 按動作鈕的回呼(這一頁沒有點牌,只有按鈕)
  let cdKey = "", cdT = null;               // 倒數環:用 key 去重,不看 timer(見 syncCd)

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

  /* 一排牌。hide = true 時**第二張畫牌背**(只有莊家的暗牌會走到這裡)。
     ⚠ hide 一律由呼叫端從 `st.reveal` 推,這一支自己不判斷任何相位。 */
  function cardsHTML(cards, cls, hide){
    if(!cards || !cards.length) return "";
    let h = "";
    for(let i = 0; i < cards.length; i++)
      h += (hide && i === 1) ? backCard(cls) : cardHTML(cards[i], cls);
    return h;
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
              (tier === R.T_DRAGON ? ' <i>五小龍</i>' : ''))) +
           '</span>';
  }

  /* 這個座位的狀態記號(公開資訊:他的牌就攤在那裡,停手也是公開動作)。 */
  function stateHTML(st, s, betPhase, betDone){
    if(betPhase) return betDone ? '<span class="bj-st ok">已下注</span>'
                                : '<span class="bj-st wait">下注中…</span>';
    if(!st) return "";
    if(st.hands[s] && R.valueOf(st.hands[s]).bust) return '<span class="bj-st bad">💥 爆了</span>';
    if(st.done[s]) return '<span class="bj-st ok">✋ 停</span>';
    const turn = (s === st.dealer) ? st.phase === "dealer" : st.phase === "play";
    return turn ? '<span class="bj-st wait">考慮中…</span>' : '<span class="bj-st">等待…</span>';
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
    const hand = st ? st.hands[d] : null;
    /* ★★ 暗牌:hide 只看 st.reveal(唯一的判斷式)。 */
    const hide = !!(st && !st.reveal);
    /* 還沒翻牌時點數只算**明牌那一張**(partial = 顯示成「10+」,表示還有一張沒翻)。
       ⚠ 這一行是牌情紅線的一部分:拿整手去算 valueTxt 等於把暗牌換成數字洩漏出去。 */
    const shown = (st && hand) ? (hide ? hand.slice(0, 1) : hand) : null;

    let body;
    if(mine){
      body = '<span class="bj-dme">你的牌在下面 ▾</span>';
    }else if(!st){
      body = '<span class="bj-dwait">等發牌…</span>';
    }else{
      body = cardsHTML(hand, "mid", hide);
    }

    return '<div class="bj-dealer' + (mine ? " me" : "") + (st && st.phase === "dealer" ? " act" : "") + '">' +
             '<div class="bj-dhd">' +
               '<span class="bj-crown" title="這一局的莊家">🎩</span>' +
               '<span class="bj-dnm">' + esc(nm) + '</span>' +
               '<span class="bj-dtag">莊家</span>' +
               (mine ? '<span class="bj-you">你</span>' : "") +
               (st ? pipHTML(shown, mine || st.reveal ? st.tier[d] : R.T_NORM,
                             (mine || st.reveal) && R.valueOf(hand).bust, hide) : "") +
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
  function seatRow(v, s){
    const st = v.st;
    const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
    const bet = v.bets ? v.bets[s] : 0;
    const hand = st ? st.hands[s] : null;
    const bust = !!(hand && R.valueOf(hand).bust);
    const turn = !!(st && st.phase === "play" && !st.done[s]);
    let cls = "bj-seat";
    if(bust) cls += " bust";
    if(st && st.done[s] && !bust) cls += " done";
    if(turn) cls += " act";
    return '<div class="' + cls + '">' +
             '<span class="bj-dot p' + s + '"></span>' +
             '<span class="bj-snm">' + esc(nm) + '</span>' +
             (bet ? '<span class="bj-bet" title="這一局押多少"><i>押</i>' + bet +
                    (st && st.dbl[s] ? '<b>×2</b>' : '') + '</span>' : "") +
             stateHTML(st, s, v.betPhase, v.betDone && v.betDone[s]) +
             /* ★ 別人的牌**全程明牌**(hide 永遠不傳)—— 只有莊家那一張是蓋著的 */
             '<span class="bj-scs">' + (st ? cardsHTML(hand, "sm") : "") + '</span>' +
             (st ? pipHTML(hand, st.tier[s], bust) : "") +
           '</div>';
  }

  function seatsHTML(v){
    const st = v.st;
    const n = v.n || (st ? st.n : 2);
    const d = st ? st.dealer : -1;
    let rows = "";
    for(let s = 0; s < n; s++){
      if(s === d) continue;                    // 莊家在上面那一格
      if(s === v.me) continue;                 // ★ 我自己在底下那一大塊(見上面那段)
      rows += seatRow(v, s);
    }
    return '<div class="bj-seats">' + rows + '</div>';
  }

  /* ==========================================================================
     四、我的手牌(牌桌最下面,大牌)
     ──────────────────────────────────────────────────────────────────────────
       ★ 我自己的牌**一律全部畫出來**(不看 reveal)—— 我是莊家時那張暗牌也是我的。
       ★ 格位固定:容器寬 = `--bj-slots` × 一格、靠左填(照大老二 v1.77.0)。
         補牌只讓右邊長出一張,已經在手上的牌一格都不動。
       ⚠ slots 用**上限**(五小龍開著 = 5,關掉 = 2 + maxDraw)而不是目前張數:
         用目前張數的話容器會跟著長,那就等於沒固定。
     ========================================================================== */
  function slotsOf(v){
    const st = v.st;
    if(!st) return R.DRAGON_N;
    return st.rules.dragon ? R.DRAGON_N : Math.min(8, 2 + R.maxDraw(st.n));
  }
  function mineHTML(v){
    const st = v.st, me = v.me;
    if(me < 0){
      /* 中途加入的人:這一局還沒有他的座位(見 adapter 的「排隊不是插入」)。
         ⚠ 這一格照樣要占高度,否則他加入的那一刻整個牌桌會跳一次。 */
      return '<div class="bj-mine idle"><div class="bj-mhd">' +
               '<span class="bj-mnm">你</span>' +
               '<span class="bj-st wait">下一局開始就發你牌</span>' +
             '</div><div class="bj-mcs"><span class="bj-mwait">🎴 等這一局打完…</span></div></div>';
    }
    const isD = !!(st && st.dealer === me);
    const hand = st ? st.hands[me] : null;
    const bust = !!(hand && R.valueOf(hand).bust);
    const bet = v.bets ? v.bets[me] : 0;
    const slots = slotsOf(v);
    let body;
    if(!st) body = '<span class="bj-mwait">🎴 等發牌…</span>';
    else body = cardsHTML(hand, "", false);          // ★ 我自己的牌一律全開

    return '<div class="bj-mine' + (bust ? " bust" : "") + (isD ? " dealer" : "") + '">' +
             '<div class="bj-mhd">' +
               (isD ? '<span class="bj-crown" title="這一局你當莊">🎩</span>' : "") +
               '<span class="bj-mnm">' + (isD ? "你(莊家)" : "你") + '</span>' +
               (bet ? '<span class="bj-bet"><i>押</i>' + bet +
                      (st && st.dbl[me] ? '<b>×2</b>' : '') + '</span>' : "") +
               (st ? pipHTML(hand, st.tier[me], bust) : "") +
             '</div>' +
             '<div class="bj-mcs" style="--bj-slots:' + slots + '">' + body + '</div>' +
           '</div>';
  }

  /* ==========================================================================
     五、整個舞台
     ========================================================================== */
  function render(v){
    if(!stage) return;
    const n = v.n || (v.st ? v.st.n : 2);
    stage.innerHTML =
      '<div class="bj-table">' +
        dealerHTML(v) +
        seatsHTML(Object.assign({}, v, { n: n })) +
      '</div>' +
      mineHTML(v);
  }

  /* ==========================================================================
     六、動作列(單機與連線共用這一份)
     ──────────────────────────────────────────────────────────────────────────
       info = { phase, mine, betPhase, betTiers[], myBet, legal:{hit,stand,dbl},
                turnName, over, hint, cdMs, cdEnd }
       ★ 只有一份:21 點的動作集很小(下注三四顆鈕 + 要牌 / 停 / 加倍),
         而且兩邊的狀態都表達得成純資料。
       ⚠ 想加「只有連線才有」的東西時,先想能不能表達成 info 的一個欄位。

       ★★ 每一顆鈕都**按得動**,不合法時只是變暗 + 說得出原因
          (CLAUDE.md 的紅線:不用 disabled 讓點擊靜默消失)。
     ========================================================================== */
  function actsHTML(info){
    if(info.over) return '<span class="bj-atxt">' + esc(info.hint || "這一局結束") + '</span>';

    /* ---------- 下注階段 ---------- */
    if(info.betPhase){
      if(info.mine === false)
        return '<span class="bj-atxt">' + esc(info.hint || "這一局你當莊,不用下注") + '</span>';
      const tiers = info.betTiers || [1];
      let h = '<div class="bj-selbar' + (info.myBet ? " ok" : "") + '">' +
                '<span class="bj-selico">' + (info.myBet ? "✅" : "💰") + '</span>' +
                '<span class="bj-seltxt">' +
                  esc(info.myBet ? ("你押了 " + info.myBet + " —— 等其他人下注")
                                 : (info.hint || "先押注,再發牌")) +
                '</span></div>';
      h += '<div class="bj-btns">';
      tiers.forEach(t => {
        h += '<button class="btn ' + (info.myBet === t ? "primary" : "ghost") +
             ' bj-act" data-act="bet" data-bet="' + t + '">' + t + '</button>';
      });
      h += '</div>';
      return h;
    }

    /* ---------- 不是我動 ---------- */
    if(!info.mine)
      return '<span class="bj-atxt">' + (info.hint
        ? esc(info.hint)
        : ('輪到 <b>' + esc(info.turnName || "對手") + '</b>…')) + '</span>';

    /* ---------- 我要牌 / 停 / 加倍 ---------- */
    const lg = info.legal || {};
    let h = '<div class="bj-selbar">' +
              '<span class="bj-selico">☝</span>' +
              '<span class="bj-seltxt">' + esc(info.hint || "要牌還是停?") + '</span>' +
            '</div>';
    h += '<div class="bj-btns">';
    h += '<button class="btn primary bj-act' + (lg.hit ? "" : " dim") + '" data-act="h">要牌</button>';
    h += '<button class="btn ghost bj-act' + (lg.stand ? "" : " dim") + '" data-act="s">停</button>';
    /* ★ 加倍只在**還沒補牌**時畫出來 —— 畫一顆按了一定被拒絕的鈕比沒有那顆鈕更困惑
       (同大老二「領出時不畫 Pass」那條)。 */
    if(lg.dbl) h += '<button class="btn ghost bj-act" data-act="d">加倍 ×2</button>';
    h += '</div>';
    return h;
  }

  function renderActs(info){
    if(!acts) return;
    acts.classList.remove("hidden");
    acts.innerHTML = '<div class="bj-actrow">' + actsHTML(info) + '</div>' +
                     '<div class="bj-cdwrap" id="bjCdWrap"></div>';
    syncCd(info);
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
       21 點的公開事件只有三種:有人爆了 / 有人 21 點 / 有人五小龍。
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
  let anPrev = null, anKey = "";

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
    // 五小龍比 21 點更誇張一階(它更難、賠得更多)
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
    if(act === "h" || act === "d") Sound.place();
    else Sound.takeback();
  }

  /* 每次重畫都叫一次(單機 solo.paint() / 連線 adapter.paint() 各一行)。
     v = { st, names[], me, key } —— key 就是「這是哪一局」。 */
  function announce(v){
    const st = v && v.st;
    if(!st || !st.hands){ anPrev = null; return; }
    const now = [];
    for(let s = 0; s < st.n; s++){
      const hidden = (s === st.dealer) && !st.reveal && s !== v.me;
      // ⚠ 莊家沒翻牌前一律記成「沒事」—— 喊出來就等於把暗牌講出去
      now[s] = hidden ? 0 : (R.valueOf(st.hands[s]).bust ? 1 : st.tier[s] + 2);
    }
    if(anPrev === null || v.key !== anKey){
      anKey = v.key; anPrev = now; return;
    }
    let snd = null;
    for(let s = 0; s < now.length; s++){
      if(now[s] === anPrev[s]) continue;
      const nm = (v.names && v.names[s]) || ("玩家" + (s + 1));
      const who = (s === v.me) ? "你" : nm;
      if(now[s] === 1){ showToast(who + " 爆了 💥", 1800); snd = snd || bustSfx; }
      else if(now[s] === R.T_DRAGON + 2){ showToast(who + " 五小龍!五張不爆 🐉", 2400); snd = dragonSfx; }
      else if(now[s] === R.T_BJ + 2){ showToast(who + " 21 點! 🎯", 2000); if(snd !== dragonSfx) snd = bjSfx; }
    }
    anPrev = now;
    /* ★ 一次重畫只響一聲:批次同步時有可能兩家同時爆,響兩聲會疊成噪音。
       ⚠ 優先權是「五小龍 > 21 點 > 爆」(上面那三行的 snd 賦值就是在做這件事)。 */
    if(snd) snd();
  }
  // 換局 / 離場:把 diff 的種子清掉(下一次只記不響)
  function resetAnnounce(){ anPrev = null; anKey = ""; }

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
          '<span class="bj-rtag">' + esc(R.tagTxt(r.tag)) + '</span>' +
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
    const tiers = R.betTiers(r.betMax).join(" / ");
    const L = [];
    L.push("<b>輪流當莊</b> —— 每一局換一個人當莊。");
    L.push("一輪 = 每個人各當一次莊;這一場打 <b>" + r.rounds + " 輪</b>(所以當莊次數一樣,公平)。");
    L.push("一副 52 張、<b>每一局重新洗牌</b> —— 算牌沒有意義,不必記。");
    L.push("起始籌碼 <b>" + r.start + "</b>,每一局可以押 <b>" + tiers + "</b>。");
    L.push("<b>不會被淘汰</b> —— 籌碼可以打到負的,排名看的是「賺賠多少」。");
    L.push("<b>閒家同時補牌</b>,不必等別人;莊家最後才動。");
    L.push("A 算 <b>1 或 11</b>(畫面會同時顯示兩種點數);超過 21 就爆。");
    L.push("<b>21 點</b> = 前兩張就湊到 21,賠 <b>" + r.bjPay + " 倍</b>。");
    L.push(r.dragon
      ? "<b>五小龍</b> = 五張牌不爆,賠 <b>2 倍</b>(莊家也能報,那就通吃全場)。"
      : "<b>五小龍關掉了</b> —— 五張不爆只是普通手,照點數比大小。");
    L.push("<b>加倍</b> = 還沒補牌時把押注翻倍,但只能再補一張就得停。");
    L.push("<b>不做</b>分牌 / 保險 / 投降。");
    L.push(r.line
      ? ("莊家<b>必須補到 " + r.line + "</b> —— 他沒有選擇,系統直接幫他補完。")
      : "莊家<b>可以自由決定</b>補不補 —— 當莊的人要自己判斷(全場都在看他)。");
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
       ★ 這一頁**沒有點牌** —— 21 點的操作只有幾顆鈕(不必選牌、不必拖曳排序),
         所以 mount 只綁一個 click。
       ⚠ 用 click 而不是 pointerup:e2e 一律用 `el.click()` 驅動,
         而合成的 click 不會產生 pointer 事件(大老二 v1.80.0 那條教訓)。
     ========================================================================== */
  function mount(h){
    stage = $("bjStage");
    acts = $("bjActs");
    hAct = h && h.onAct;
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest(".bj-act");
        if(!b || !hAct) return;
        hAct(b.dataset.act, b.dataset.bet ? +b.dataset.bet : 0);
      });
    }
  }

  return {
    mount, render, renderActs, resultHTML, matchHTML, rulesHTML, stopCd,
    cardHTML, backCard, cardsHTML, pipHTML,
    // 公告(單機與連線共用):爆 / 21 點 / 五小龍
    announce, resetAnnounce,
    // 一個動作的聲音(四個呼叫點共用)
    moveSfx, bustSfx, bjSfx, dragonSfx
  };
})();

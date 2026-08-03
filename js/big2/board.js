"use strict";

/* ============================================================================
   大老二 — 盤面(B2B)。牌河 / 我的手牌 / 動作列 / 結果卡的排名表全部由這裡畫。

   ── ★ 這一頁刻意**沒有** JS 算牌寬(照排七的結論)──────────────────────────
     台灣麻將的牌寬要靠 board.js 量高度再夾,為此長出地板 / 暖身期 / 二分回檢一整套
     ([notes/11](../../notes/11-台灣麻將16張.md) 第六節),因為那副牌的張數每一手都在變。
     大老二的手牌**只會變少**、牌河永遠只放「上一手」(最多 5 張),
     所以尺寸整份交給 CSS(grid + clamp),JS 一個數字都不寫 ——
     那一整類「忽大忽小」的 bug 在這一頁結構上不存在。
     ⚠ 不要為了「手牌少的時候放大一點」改回 JS 算,那正是忽大忽小的來源。

   ── ★ 唯一的牌情紅線 ──────────────────────────────────────────────────────
     > **對手手上有什麼,結算前只能顯示張數。**
     已經打出去的牌是**公開的**(它們就攤在桌上),所以本輪記錄與算牌表照實畫。
     落地點只有兩個:
       • 對手的張數 → 房間框 / 單機列的玩家晶片(adapter 的 chipTail / solo 的 paintBar)
       • 唯一翻開的地方 → 結果卡的排名表(resultHTML)
     守門用一條**精確的不變量**(不是關鍵字比對):
         盤面上的 .b2-card 張數  ===  我的手牌 + 這一輪(或上一輪)記錄裡的牌
     誰哪天讓盤面畫出別人的手牌,這個數字立刻對不上。

     ⚠⚠ 算牌表(seenHTML)只准標「**已經出過的**」,**絕對不可以**標「還沒出現的」
        或順手把我自己的手牌也標掉 —— 52 − 已出 − 我的手牌 = **對手手牌的聯集**,
        兩人局那就等於把對手的牌整副攤開。這條的守門也是一條精確不變量:
            .b2-spip.on 的個數  ===  st.played.length

   ── ★ 為什麼手牌**不做**「這張能不能出」的壓暗 ────────────────────────────
     排七是一張一張出,所以每張牌都有明確的「出得掉 / 出不掉」。
     大老二出的是**組合** —— 單看一張牌無法回答「它能不能出」
     (♣5 單張壓不過 ♦7,但 ♣5+♦5 的對子可能壓得過一對 4)。
     硬把 legal 攤到每張牌上只會給出**騙人的**壓暗,所以:
       每張牌都點得動 → 選好之後由動作列回答「這組行不行、為什麼不行」(B2.whyNot)。
     這仍然守著 CLAUDE.md 那條紅線:不用 disabled 讓牌靜默吃掉點擊。
   ========================================================================== */

const B2B = (function(){

  const R = B2;
  let stage = null, acts = null;
  let hCard = null, hAct = null;          // 點手牌 / 按動作鈕的回呼
  let sel = [];                            // 目前選了哪幾張(牌 id;順序不重要)
  let cdKey = "", cdT = null;              // 倒數環:用 key 去重,不看 timer(見 syncCd)

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
     二、牌河 = **這一輪大家出的牌**(v1.77.0 從「只留上一手」改過來)
     ──────────────────────────────────────────────────────────────────────────
       ★ 舊版只畫 st.cur(這一輪目前最大的那一手),理由是「堆歷史會吃掉手牌的
         垂直空間」。**那個理由在這一頁不成立** —— 版面截圖顯示桌機 700×293 的
         中間區只放了一張牌,空了一大片(手牌是 CSS clamp 算的,從來沒被擠到)。
         而代價很實際,使用者的原話:
           「中間那一塊應該要用來顯示這一輪大家出的牌,才不會因為跳太快,
             導致你根本不知道出過什麼牌了」
         三家電腦連續出完只花幾百毫秒,只留最大那一手的話,被壓掉的與「不要」
         全部就地消失,人來不及看。

       ★ 一輪結束後**繼續顯示上一輪**(st.prevTrick),標題換成「上一輪」並淡化。
         直接清空的話「新的一輪」那一瞬間中間會整片空掉 —— 那正是舊版的樣子。

       ★ 這仍然守著牌情紅線:出過的牌是公開的、pass 也是公開動作。
       ⚠ 「目前最大」只在**進行中的那一輪**標(上一輪已經結束,再標一個「最大」
         只會讓人以為還要壓它)。
     ========================================================================== */
  /* ★ **連續的「不要」併成一列**。理由有兩個,而且都是看圖才確定的:
       ① 牌桌上「其他三家都不要」是**一件事**,不是三件
       ② 4 人局一輪很容易是「1 手 + 3 個不要」= 4 列,矮一點的視窗塞不下 →
          最上面那一列會被裁掉一半(版面截圖 shot=sel 當場抓到)。併起來之後
          同一輪最多 2~3 列。
     ⚠ 併的是**連續**的 pass:中間有人出牌就要斷開,不然順序讀起來會是錯的。 */
  function foldPasses(list){
    const rows = [];
    list.forEach((m, i) => {
      const last = rows[rows.length - 1];
      if(m.pass && last && last.pass){ last.seats.push(m.seat); return; }
      if(m.pass){ rows.push({ pass: true, seats: [m.seat] }); return; }
      rows.push({ pass: false, seat: m.seat, cards: m.cards, t: m.t, idx: i });
    });
    return rows;
  }

  function moveHTML(row, nameOf, topIdx){
    if(row.pass){
      return '<div class="b2-tmv pass"><span class="b2-tnm">' +
               row.seats.map(s => esc(nameOf(s))).join(" · ") + '</span>' +
             '<span class="b2-tpass">✕ 不要</span></div>';
    }
    const top = (row.idx === topIdx);
    return '<div class="b2-tmv' + (top ? " top" : "") + '">' +
             '<span class="b2-tnm">' + esc(nameOf(row.seat)) + '</span>' +
             '<span class="b2-tct">' + (R.T_NAME[row.t] || "") + '</span>' +
             (R.isBomb(row.t) ? '<span class="b2-rbomb" title="無敵牌型:只有更大的鐵支或同花順壓得過">無敵</span>' : "") +
             '<span class="b2-tcs">' +
               row.cards.slice().sort(R.cmpCard).map(c => cardHTML(c, "mid")).join("") +
             '</span>' +
           '</div>';
  }

  /* ⚠ 這一整塊是 `.b2-trick`;裡面那一排是 `.b2-tlist`。
     **不可以**叫 .b2-rcards —— 那是結果卡排名表第二層用的(CLAUDE.md「CSS 會撞的
     四類」的第一類:名字撞,而前綴防不了自己撞自己;第一版真的撞過一次)。 */
  function trickHTML(v){
    const live = (v.trick && v.trick.length) ? v.trick : null;
    const list = live || (v.prevTrick || []);
    const nameOf = s => (v.names && v.names[s]) || ("玩家" + (s + 1));

    // 進行中那一輪:最後一個「有出牌」的就是目前最大的那一手
    let topIdx = -1;
    if(live) for(let i = list.length - 1; i >= 0; i--) if(!list[i].pass){ topIdx = i; break; }

    let lbl, hint = "";
    if(live){
      lbl = "這一輪";
    }else if(list.length){
      lbl = "上一輪";
      hint = v.over ? "" : (v.mine ? '換<b>你</b>先出 —— 任何合法牌型都可以'
                                   : '換 <b>' + esc(v.turnName || "對手") + '</b> 先出');
    }else{
      lbl = "這一局剛開始";
      hint = v.over ? "" : (v.mine ? '<b>你</b>先出 —— 第一手一定要帶 ' + R.nameOf(R.CLUB3)
                                   : '<b>' + esc(v.turnName || "對手") + '</b> 先出');
    }

    return '<div class="b2-trick' + (live ? "" : " prev") + (list.length ? "" : " empty") + '">' +
             '<div class="b2-tlbl"><span class="b2-tttl">' + lbl + '</span>' +
               (hint ? '<span class="b2-thint">' + hint + '</span>' : "") + '</div>' +
             (list.length
               ? '<div class="b2-tlist">' +
                   foldPasses(list).map(row => moveHTML(row, nameOf, topIdx)).join("") +
                 '</div>'
               : "") +
           '</div>';
  }

  /* ==========================================================================
     二之二、算牌表:**已經出過的牌**
     ──────────────────────────────────────────────────────────────────────────
       ★ 「♠2 出了沒、A 剩幾張」是大老二的核心技巧,舊版完全靠玩家記憶,
         而中間那塊空著沒用。13 個點數各一欄、欄內四個花色記號,出過的亮起。
       ⚠⚠ **只准標「已經出過的」**(見檔頭那條紅線):標「還沒出現的」或順手把
          我自己的手牌也標掉,等於把對手手牌的聯集算給玩家看 ——
          兩人局那就是對手的整副牌。這裡的迴圈只讀 v.played,不碰 v.hand。
     ========================================================================== */
  const SEEN_ORDER = [0,1,2,3,4,5,6,7,8,9,10,11,12];      // rkOrder:3 最小 … 2 最大
  function rankOfOrder(o){ return o <= 10 ? o + 3 : (o === 11 ? 1 : 2); }

  function seenHTML(v){
    const seen = {};
    (v.played || []).forEach(c => { seen[c] = 1; });
    let h = '<div class="b2-seen"><div class="b2-slbl">出過的牌 <b>' +
            (v.played ? v.played.length : 0) + '</b> / 52</div><div class="b2-sgrid">';
    SEEN_ORDER.forEach(o => {
      const r = rankOfOrder(o);
      h += '<div class="b2-scol"><span class="b2-srk">' + R.rankTxt(r) + '</span><span class="b2-spips">';
      for(let s = 0; s < R.NSUIT; s++){
        const c = R.cardOf(s, r);
        /* data-c 讓 e2e 定位得到某一張(那條不變量要逐張比對)。
           ⚠ 這不是牌情:52 張牌各自存在是常識,**有沒有 .on** 才是資訊。
           ⚠ 花色一律用**自繪 SVG**(PKFace),不可以用 ♣♦♥♠ 文字 ——
             盤面「一個花色 Unicode 都沒有」是這一頁既有的規矩(連線 e2e B 節在守),
             理由是字型渲染差太多:9px 的文字花色在 Android 上根本認不出是哪一門。 */
        h += '<i class="b2-spip s' + s + (seen[c] ? " on" : "") + '" data-c="' + c + '"' +
             (seen[c] ? ' title="' + R.longName(c) + ' 已經出過"' : "") + '>' +
             PKFace.suitSVG(R.SUIT_KEY[s], "b2-sv") + '</i>';
      }
      h += '</span></div>';
    });
    return h + '</div></div>';
  }

  /* ==========================================================================
     三、整個舞台
     ──────────────────────────────────────────────────────────────────────────
       v = { hand, slots, trick[], prevTrick[], names[], played[],
             mine, turnName, over }
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
    // 選取的牌若已經不在手上(換局 / 出牌之後)就丟掉,不然會殘留一個選不掉的框
    sel = sel.filter(c => v.hand.indexOf(c) >= 0);

    let h = trickHTML(v) + seenHTML(v);

    // 手牌。★ 全部點得動(見檔頭:大老二沒有「單張能不能出」這回事)
    const slots = Math.max(v.slots || 0, v.hand.length, 1);
    h += '<div class="b2-hand' + (v.mine ? " mine" : "") + '" style="--b2-slots:' + slots + '">' +
      v.hand.map(c => cardHTML(c, sel.indexOf(c) >= 0 ? "sel" : "")).join("") +
      (v.hand.length ? "" : '<span class="b2-empty">手牌出完了 ✨</span>') +
      '</div>';
    stage.innerHTML = h;

    /* 這一輪很長時(四家互壓好幾手)**最新那一手一定要看得見** ——
       同台灣麻將牌河「打超過就要捲,而最新那張永遠得看得見」。
       ⚠ 要補一次 rAF:innerHTML 之後馬上設 scrollTop,量到的高度有時還不是最終值
         (字型載入、外層 flex 還在算),那一次就白設了 —— 症狀是最新那一手被切一半
         卡在底部,而**橫置手機**(空間最小)每次都中。兩次都推到底,重複設無害。 */
    const tl = stage.querySelector(".b2-tlist");
    if(tl){
      tl.scrollTop = tl.scrollHeight;
      requestAnimationFrame(() => { tl.scrollTop = tl.scrollHeight; });
    }
  }

  /* ==========================================================================
     四、動作列(單機與連線共用這一份)
     ──────────────────────────────────────────────────────────────────────────
       info = { mine, over, turnName, lead, selInfo:{ok,txt,type}, canPass, cdMs, cdEnd }
       ★ 只有一份:大老二沒有宣告階段,所以動作列吃的是**純資料**
         (台灣麻將的 renderActs 有兩份,是因為連線那份要管宣告視窗)。
       ⚠ 想加「只有連線才有」的東西時,先想能不能表達成 info 的一個欄位。
     ========================================================================== */
  function actsHTML(info){
    if(info.over) return '<span class="b2-atxt">這局結束</span>';
    if(!info.mine) return '<span class="b2-atxt">輪到 <b>' + esc(info.turnName || "對手") + '</b>…</span>';

    const s = info.selInfo || {};
    let h = '<div class="b2-selbar' + (s.ok ? " ok" : (sel.length ? " bad" : "")) + '">' +
              '<span class="b2-selico">' + (s.ok ? "✅" : (sel.length ? "🚫" : "☝")) + '</span>' +
              '<span class="b2-seltxt">' + esc(s.txt || "點牌選要出的組合(1 張 / 2 張 / 5 張)") + '</span>' +
            '</div>';
    h += '<div class="b2-btns">';
    // ★ 「出牌」永遠按得動 —— 選錯了要說得出原因,不用 disabled 靜默吃掉點擊
    h += '<button class="btn primary b2-act' + (s.ok ? "" : " dim") + '" data-act="play">出牌</button>';
    if(sel.length) h += '<button class="btn ghost b2-act" data-act="clear">清除</button>';
    /* ⚠ v1.77.0 拿掉了「💡 幫我挑」(從手牌裡挑一組合法的幫他選上)。使用者:
       「幫我選那個功能拿掉,我覺得很奇怪,如果是要這樣的話,應該要做個電腦托管功能」——
       只選不出這件事的定位確實尷尬:它既不是提示(直接給答案)也不是代打(還要自己按)。
       ★ **托管明確先不做**。要補回來的話請整支做成托管,不要把這顆鈕加回來。 */
    /* ★ 領出的人不能 pass(規則)。刻意**不畫**那顆鈕而改成一句話 ——
       畫一顆按了會被拒絕的鈕,比沒有那顆鈕更讓人困惑。 */
    if(info.canPass) h += '<button class="btn ghost b2-act" data-act="pass">不要(Pass)</button>';
    h += '</div>';
    if(!info.canPass) h += '<span class="b2-atip">這一輪由你開始,<b>一定要出牌</b>(不能 Pass)</span>';
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
  function selInfoOf(st){
    if(!sel.length) return { ok: false, txt: "" };
    const cls = R.classify(sel);
    if(!cls) return { ok: false, txt: R.whyNot(sel, st) };
    const why = R.whyNot(sel, st);
    if(why) return { ok: false, txt: why, type: R.T_NAME[cls.t] };
    return { ok: true, type: R.T_NAME[cls.t],
             txt: "選好了:" + R.T_NAME[cls.t] + "(" + sel.slice().sort(R.cmpCard).map(R.nameOf).join(" ") + ")" };
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
        hCard(+el.dataset.c);
      });
    }
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest(".b2-act");
        if(b && hAct) hAct(b.dataset.act);
      });
    }
  }

  return {
    mount, render, renderActs, resultHTML, stopCd, selInfoOf,
    cardHTML,
    sel: () => sel.slice(),
    toggleSel(c){
      const i = sel.indexOf(c);
      if(i >= 0) sel.splice(i, 1); else sel.push(c);
    },
    setSel(arr){ sel = (arr || []).slice(); },
    clearSel(){ sel = []; }
  };
})();

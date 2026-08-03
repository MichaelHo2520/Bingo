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
     已經打出去的牌是**公開的**(它們就攤在桌上),所以牌河照實畫。
     落地點只有兩個:
       • 對手的張數 → 房間框 / 單機列的玩家晶片(adapter 的 chipTail / solo 的 paintBar)
       • 唯一翻開的地方 → 結果卡的排名表(resultHTML)
     守門用一條**精確的不變量**(不是關鍵字比對):
         盤面上的 .b2-card 張數  ===  我的手牌 + 牌河那一手
     誰哪天讓盤面畫出別人的手牌,這個數字立刻對不上。

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
     二、牌河:上一手是什麼
     ──────────────────────────────────────────────────────────────────────────
       ★ 只放「這一輪目前最大的那一手」,不堆歷史。
         大老二要判斷的就是「我壓不壓得過眼前這一手」,把整局出過的牌全排出來
         只會把手牌需要的垂直空間吃掉(同排七 v1.75.2 拿掉對手列的理由)。
         「已經出過幾張」用一行小字帶過就夠了。
     ========================================================================== */
  function riverHTML(v){
    if(!v.cur){
      return '<div class="b2-river lead">' +
               '<div class="b2-rlbl">新的一輪</div>' +
               '<div class="b2-rhint">' +
                 (v.mine ? '你先出 —— <b>任何合法牌型都可以</b>' : esc(v.turnName || "對手") + ' 要先出') +
               '</div>' +
             '</div>';
    }
    const t = R.T_NAME[v.cur.t] || "";
    /* ⚠ 牌河那一排是 `.b2-rivc`,**不是** `.b2-rcards` —— 後者是結果卡排名表第二層用的。
       第一版兩邊都叫 .b2-rcards,那是 CLAUDE.md「CSS 會撞的四類」的第一類(名字撞),
       而前綴防不了自己撞自己:命名前要把整支檔的 class 掃一遍。 */
    return '<div class="b2-river">' +
             '<div class="b2-rlbl">' + esc(v.cur.name || "對手") + ' 出了' +
               '<span class="b2-rtype">' + t + '</span>' +
               (R.isBomb(v.cur.t) ? '<span class="b2-rbomb" title="無敵牌型:只有更大的鐵支或同花順壓得過">無敵</span>' : "") +
             '</div>' +
             '<div class="b2-rivc">' +
               v.cur.cards.slice().sort(R.cmpCard).map(c => cardHTML(c, "sm")).join("") +
             '</div>' +
           '</div>';
  }

  /* ==========================================================================
     三、整個舞台
     ──────────────────────────────────────────────────────────────────────────
       v = { hand, cur:{t,k,cards,name}|null, mine, turnName, over, playedCount }
       ★ 盤面裡**沒有對手列**:「誰 / 輪到誰 / 剩幾張」三樣在玩家晶片上全都有了
         (連線走 chipTail、單機走 paintBar),盤面再畫一次是 100% 重複 ——
         而且吃掉的正是手牌需要的垂直空間(排七 v1.75.2 的結論)。
     ========================================================================== */
  function render(v){
    if(!stage) return;
    // 選取的牌若已經不在手上(換局 / 出牌之後)就丟掉,不然會殘留一個選不掉的框
    sel = sel.filter(c => v.hand.indexOf(c) >= 0);

    let h = riverHTML(v);
    h += '<div class="b2-tally">已經打出去 <b>' + (v.playedCount || 0) + '</b> 張 · 你手上 <b>' +
         v.hand.length + '</b> 張</div>';

    // 手牌。★ 全部點得動(見檔頭:大老二沒有「單張能不能出」這回事)
    h += '<div class="b2-hand' + (v.mine ? " mine" : "") + '">' +
      v.hand.map(c => cardHTML(c, sel.indexOf(c) >= 0 ? "sel" : "")).join("") +
      (v.hand.length ? "" : '<span class="b2-empty">手牌出完了 ✨</span>') +
      '</div>';
    stage.innerHTML = h;
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
    h += '<button class="btn ghost b2-act" data-act="hint" title="幫我挑一組出得掉的">💡 幫我挑</button>';
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

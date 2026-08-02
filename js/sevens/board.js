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
    h += '<div class="sv-hand' + (cover ? " cover" : "") + '">' +
      v.hand.map(c => {
        const can = v.can.indexOf(c) >= 0;
        let cls = cover ? "pick" : (can ? "can" : "no");
        if(c === sel) cls += " sel";
        return cardHTML(c, cls);
      }).join("") +
      (v.hand.length ? "" : '<span class="sv-empty">手牌出完了 ✨</span>') +
      '</div>';
    stage.innerHTML = h;
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
    // 沒牌可出 → 蓋牌模式
    const s = sel >= 0
      ? '<button class="btn danger sv-act" data-act="cover">蓋掉 ' + R.nameOf(sel) + '（+' + R.rankOf(sel) + ' 分）</button>'
      : '<span class="sv-atip">↓ 點一張要蓋的牌</span>';
    return '<span class="sv-atxt warn">⚠ 你沒有牌可以出,必須蓋掉一張</span>' + s;
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
  function resultHTML(st, names, mySeat){
    const sc = R.score(st);
    return '<div class="sv-rank">' + sc.sorted.map(r => {
      const pile = st.piles[r.seat].slice().sort((a, b) => a - b);
      const me = r.seat === mySeat, first = r.rank === 1;
      return '<div class="sv-rrow' + (me ? " me" : "") + (first ? " win" : "") + '">' +
        '<span class="sv-rno">' + r.rank + '</span>' +
        '<span class="sv-rname">' + esc(names[r.seat] || ("玩家" + (r.seat + 1))) + '</span>' +
        (me ? '<span class="you-badge">你</span>' : "") +
        (first ? '<span class="sv-rcrown" title="第一名">🏆</span>' : "") +
        '<span class="sv-rcards">' +
          (pile.length ? pile.map(c => cardHTML(c, "tiny")).join("") : '<span class="sv-clean">全部出完</span>') +
        '</span>' +
        '<span class="sv-rpts">' + r.pts + ' 分</span>' +
      '</div>';
    }).join("") + '</div>';
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

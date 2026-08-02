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
  function cardHTML(c, cls){
    const red = R.isRed(c) ? " red" : "";
    return '<span class="sv-card' + red + (cls ? " " + cls : "") + '" data-c="' + c + '">' +
             '<span class="sv-cr">' + R.rankTxt(R.rankOf(c)) + '</span>' +
             '<span class="sv-cs">' + R.suitCh(R.suitOf(c)) + '</span>' +
           '</span>';
  }
  function backHTML(n){
    // 蓋起來的牌只畫張數 —— 這是牌情紅線的落地點
    return '<span class="sv-back" aria-label="蓋掉 ' + n + ' 張"><i class="sv-pip back"></i><b>' + n + '</b></span>';
  }

  /* ==========================================================================
     二、軌道(13 格 × 4 行)
     ──────────────────────────────────────────────────────────────────────────
       出過的格子亮起、沒出的留暗格 —— 「還缺哪幾張」正是排七要算的東西,
       只排已出的牌就等於逼玩家自己記。
       接口(lo-1 / hi+1)畫成 `.open`:那是**公開資訊**(軌道上本來就看得出來),
       標出來只是省去數格子,不是替玩家算牌。
     ========================================================================== */
  function trackHTML(tracks, s){
    const t = tracks[s], ends = R.endsOf(tracks, s);
    let cells = "";
    for(let r = 1; r <= 13; r++){
      const on = t && r >= t.lo && r <= t.hi;
      const cls = "sv-cell" + (on ? " on" : "") + (r === 7 ? " seven" : "") +
                  (ends.indexOf(r) >= 0 ? " open" : "");
      cells += '<span class="' + cls + '">' + (on || r === 7 ? R.rankTxt(r) : "·") + '</span>';
    }
    return '<div class="sv-track' + (R.isRed(R.cardOf(s, 1)) ? " red" : "") + (t ? "" : " off") + '">' +
             '<span class="sv-suit">' + R.suitCh(s) + '</span>' +
             '<div class="sv-cells">' + cells + '</div>' +
           '</div>';
  }

  /* ==========================================================================
     三、對手列
     ==========================================================================
       每一家:名字 / 手上剩幾張 / 蓋了幾張(只有張數)。
       輪到誰用 `.on` —— 那是公開資訊(房間框的晶片上也有)。 */
  function foeRow(seats){
    return '<div class="sv-foes">' + seats.map(p =>
      '<div class="sv-foe' + (p.turn ? " on" : "") + (p.me ? " me" : "") + (p.done ? " done" : "") + '">' +
        '<span class="sv-fname">' + esc(p.name) + '</span>' +
        '<span class="sv-fn" title="手上剩幾張"><i class="sv-pip"></i>' + p.n + '</span>' +
        (p.piles ? '<span class="sv-fp" title="蓋了幾張"><i class="sv-pip back"></i>' + p.piles + '</span>' : "") +
      '</div>').join("") + '</div>';
  }

  /* ==========================================================================
     四、整個舞台
     ========================================================================== */
  function render(v){
    if(!stage) return;
    let h = '<div class="sv-tracks">';
    for(let s = 0; s < 4; s++) h += trackHTML(v.tracks, s);
    h += '</div>';
    h += foeRow(v.seats);

    // 我的蓋牌堆:自己看得到自己蓋了什麼(別人看到的是 backHTML)
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
  function resultHTML(st, names, mySeat){
    const sc = R.score(st);
    return '<div class="sv-rank">' + sc.sorted.map(r => {
      const pile = st.piles[r.seat].slice().sort((a, b) => a - b);
      return '<div class="sv-rrow' + (r.seat === mySeat ? " me" : "") + (r.rank === 1 ? " win" : "") + '">' +
        '<span class="sv-rno">' + r.rank + '</span>' +
        '<span class="sv-rname">' + esc(names[r.seat] || ("玩家" + (r.seat + 1))) + '</span>' +
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
    cardHTML, backHTML,
    sel: () => sel,
    setSel(c){ sel = c; },
    clearSel(){ sel = -1; }
  };
})();

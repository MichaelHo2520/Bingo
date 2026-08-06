"use strict";

/* ============================================================================
   UNO — 盤面(UNB):牌面自繪 + 手牌 + 牌桌中央 + 動作列 + 選色盤 + 結果表。
   單機(solo.js)與連線(adapter.js)**共用這一支**,所以每一個畫面元件只有一份。

   ── ★ 牌面右下角的**色名字母**(R / Y / G / B)只在電子書主題現身 ──────────
     v1.106.0 原本任何主題都畫(電子書黑白 + 紅綠色盲兩個理由),但玩家實測反饋
     不想在牌角看到英文字母,而彩色主題下顏色本身已經夠分辨,所以改成:
       · 一般(彩色)主題:不畫 —— CSS 預設 .un-cl{display:none}
       · 電子書主題:畫 —— 轉黑白之後顏色判斷通道消失,靠字母補回來
         (見 styles.css 電子書那段的 `.un-cl{display:block}` override)
     字母本身還是 HTML(每次 render() 都會吐出來),只是彩色主題下被 CSS 藏起來
     ——不是 JS 判斷主題再決定要不要塞這段 HTML,理由是**主題可能隨時切換**,
     CSS 版本不必等下一次 render() 就會跟著換。
     ⚠ 用英文字母而不是「紅黃綠藍」:CJK 字在 20px 寬的牌角落會糊成一塊墨。
     四色變數 --un-r/y/g/b 仍然在**任何主題下都保持原值**(見 styles.css 那段 ★★★)——
     這條沒變,顏色仍然是 UNO 的規則本體。

   ── 牌面的畫法(與首頁 / 進場圖示的 .un-ic-* 是同一套視覺,但**不是同一份碼**)──
     圖示是 SVG(要能縮到 32px 還認得出來),牌面是 HTML + CSS(要能點、要能捲、
     要跟著主題換色)。兩邊刻意分開 —— 共用一份反而會讓「圖示改小」把牌面一起弄壞。
     ★ 唯一必須一致的是**顏色變數**,那一組只有一份(styles.css 的 :root)。

   ── ★ 這一頁沒有「選牌」這件事 ────────────────────────────────────────────
     大老二 / 排七要選一組牌再按出牌,UNO **點一張就是出那一張** ——
     所以沒有 sel / clearSel / 群組選取那一整套(大老二 board.js 最複雜的部分)。
     唯一的兩段式是 **Wild 要先選顏色**(選色盤),而它由 askColor() 收斂成一個 callback。

   ── ★ 音效全是合成音,**不新增任何 mp3** ──────────────────────────────────
     CLAUDE.md:動 `mp3/` 的路徑要四處一起改(sfx 的 ensureDefs、sw.js 的 CORE、
     兩支產生器)。UNO 的動作聲用 Sound.tone() 寫樂句就夠清楚了,
     省掉那條耦合 —— 也省掉「離線抓不到音檔就啞掉」那一整類問題。
   ========================================================================== */

const UNB = (function(){

  /* ==========================================================================
     一、牌面
     ────────────────────────────────────────────────────────────────────────── */
  const COL_CLS = ["un-c-r", "un-c-y", "un-c-g", "un-c-b"];

  /* 一張牌。cls = 額外的 class("can" 亮 / "no" 暗 / "tiny" 小張)
     ⚠ data-c 一定要是牌 id —— 點擊處理讀的就是它(`+el.dataset.c`)。 */
  function cardHTML(id, cls){
    const wild = UN.isWild(id);
    const c = wild ? "un-c-w" : COL_CLS[UN.colOf(id)];
    const lb = UN.labelOf(id);
    // ⚠ 兩個字的標籤(+2 / +4)要小一階,不然頂穿白橢圓兩側(見 styles.css 的 .un-lb.two)
    const two = lb.length > 1 ? " two" : "";
    let inner = '<span class="un-ov" aria-hidden="true"></span>';
    if(wild){
      /* Wild:白橢圓裡四色風車。
         ★★ 普通 Wild **不寫 W** —— 四色風車本身就是它的辨識點(而四色在任何主題下
            都保持原值,電子書主題也是,所以「看形狀就知道」在每個主題都成立)。
         ⚠⚠ 但 **+4 一定要留字** —— 風車是 Wild 與 Wild+4 **共用**的圖案,
            兩張都不寫字的話它們會長得**一模一樣**,玩家分不出「只是換色」與
            「吃 4 張」。這不是裝飾,是牌義:少了它 +4 砸過來看不出來。 */
      inner += '<span class="un-wq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
      if(UN.kindOf(id) === UN.K_W4) inner += '<span class="un-lb wild' + two + '">' + lb + '</span>';
    }else{
      inner += '<span class="un-lb' + two + '">' + lb + '</span>' +
               // ★ 色名字母(見檔頭):HTML 一律吐出來,CSS 只在電子書主題顯示
               '<span class="un-cl" aria-hidden="true">' + UN.letterOf(id) + '</span>';
    }
    return '<span class="un-card ' + c + (cls ? " " + cls : "") + '" data-c="' + id +
             '" role="button" tabindex="0" aria-label="' + esc(UN.nameOf(id)) + '">' + inner + '</span>';
  }

  /* 牌背(牌堆)。⚠ data-c 刻意給 "?" —— 寫真值等於把牌堆頂端洩漏在 DOM 屬性裡。 */
  function backHTML(cls){
    return '<span class="un-card back' + (cls ? " " + cls : "") + '" data-c="?" aria-label="牌堆">' +
             '<span class="un-bk" aria-hidden="true"></span></span>';
  }

  /* ==========================================================================
     二、音效(全合成音)
     ────────────────────────────────────────────────────────────────────────── */
  function toneSafe(f, o){ if(window.Sound && Sound.tone) Sound.tone(f, o); }
  const sfx = {
    play(){ toneSafe(560, { type:"triangle", dur:0.09, vol:0.18, slideTo:840 }); },
    draw(){ toneSafe(300, { type:"sine", dur:0.12, vol:0.16, slideTo:190 }); },
    // 跳過:短促的下行兩音(像門關上)
    skip(){ [660, 440].forEach((f, i) => toneSafe(f, { type:"square", dur:0.09, vol:0.13, delay:i*0.08 })); },
    // 迴轉:上行滑音
    rev(){ toneSafe(420, { type:"triangle", dur:0.20, vol:0.16, slideTo:880 }); },
    // +2 / +4:越重的罰抽音越低越長
    pen(n){ toneSafe(n >= 4 ? 150 : 210, { type:"sawtooth", dur:n >= 4 ? 0.34 : 0.24, vol:0.17, slideTo: n >= 4 ? 90 : 130 }); },
    // 換顏色
    color(){ [523, 659, 784, 988].forEach((f, i) => toneSafe(f, { type:"sine", dur:0.10, vol:0.12, delay:i*0.045 })); },
    // 喊 UNO:兩聲亮的
    uno(){ toneSafe(988, { type:"triangle", dur:0.12, vol:0.24 }); toneSafe(1319, { type:"triangle", dur:0.22, vol:0.22, delay:0.13 }); },
    // 被抓:下行三音(明顯是壞事)
    caught(){ [700, 520, 330].forEach((f, i) => toneSafe(f, { type:"square", dur:0.13, vol:0.16, delay:i*0.10 })); }
  };

  /* 一手打出去之後該響什麼 —— **單機與連線共用這一支**。
     ⚠ 走「前後兩份的 diff」而不是在動作點插 sfx.xxx():單機與連線的動作路徑
       完全不同,但「有人出了 +2」在兩邊是同一個 diff(同大老二 moveSfx 的理由)。 */
  function moveSfx(mv, n){
    if(UN.isDraw(mv)){ sfx.draw(); return; }
    if(UN.isPass(mv)) return;
    if(UN.isCatch(mv)){ sfx.caught(); return; }
    const id = UN.moveCard(mv);
    if(id < 0) return;
    const k = UN.kindOf(id);
    if(k === UN.K_SKIP) sfx.skip();
    else if(k === UN.K_REV) sfx.rev();
    else if(k === UN.K_D2) sfx.pen(2);
    else if(k === UN.K_W4){ sfx.pen(4); sfx.color(); }
    else if(k === UN.K_WILD) sfx.color();
    else sfx.play();
    if(UN.moveDeclared(mv)) sfx.uno();
  }

  /* ==========================================================================
     三、牌桌中央
     ──────────────────────────────────────────────────────────────────────────
       畫四件事,而它們都是**公開資訊**:
         牌堆(剩幾張)· 牌河最上面那張 · **現在的有效顏色** · 方向 + 累積罰抽
       ★★ 「現在的有效顏色」一定要**獨立畫一塊**,不可以只靠那張牌的顏色 ——
          Wild 打出去之後桌上那張是黑的,顏色只存在 st.col 裡。
          漏了它玩家會完全不知道現在該出什麼色(這是最容易漏的一格)。
     ========================================================================== */
  function tableHTML(o){
    const colTxt = (o.col >= 0 && o.col < 4) ? UN.COL_NAME[o.col] : "—";
    /* ⚠ 沒顏色時也一定要掛一個 class(un-c-none)—— `.un-swatch` 刻意不寫 background,
       顏色全靠這一組;空字串會讓色塊變成透明的(見 styles.css 那段 ★★)。 */
    const colCls = (o.col >= 0 && o.col < 4) ? COL_CLS[o.col] : "un-c-none";
    /* ⚠ 方向的箭頭用**幾何字元**(U+25B8 / U+25C2)而不是迴轉箭頭(U+21BB / U+21BA)——
       後者在部分 Android 字型缺字會變豆腐方框(同 CLAUDE.md 紅線 8 的精神:
       禁令列的是麻將與撲克牌那兩段,但「這個字型有沒有」的問題對任何字元都成立,
       所以能挑常見的就挑常見的)。牌面上的 ⊘ / ⇄ 由截圖驗過。 */
    const dirTxt = o.dir > 0 ? "順向 ▸" : "逆向 ◂";
    const pen = o.pend > 0
      ? '<div class="un-pen">累積罰抽 <b>' + o.pend + '</b> 張' +
        (o.stack ? "(疊得上就疊,不然只能抽)" : "") + '</div>'
      : "";
    return '<div class="un-table">' +
             '<div class="un-piles">' +
               '<button class="un-pile" id="unDraw" type="button" aria-label="抽一張牌">' +
                 backHTML() +
                 '<span class="un-pn">牌堆 ' + o.pileLeft + '</span>' +
               '</button>' +
               '<div class="un-top">' +
                 (o.top >= 0 ? cardHTML(o.top, "big") : "") +
                 '<span class="un-pn">牌河 ' + o.discLeft + '</span>' +
               '</div>' +
             '</div>' +
             '<div class="un-now">' +
               '<span class="un-swatch ' + colCls + '" aria-hidden="true"></span>' +
               '<span class="un-nowtxt">現在顏色 <b>' + colTxt + '</b></span>' +
               '<span class="un-dir">' + dirTxt + '</span>' +
             '</div>' + pen +
           '</div>';
  }

  /* ==========================================================================
     四、整個盤面
     ──────────────────────────────────────────────────────────────────────────
       o = { hand, top, col, dir, pend, stack, pileLeft, discLeft,
             mine, over, turnName, hot(可出的 id 陣列), drew, drewCard, key }
       ★ hot 由呼叫端算好傳進來(UN.playable)—— 盤面不自己算規則。
     ========================================================================== */
  let stage = null;
  function el(){ return stage || (stage = $("unStage")); }

  function render(o){
    const box = el();
    if(!box) return;
    const hot = o.hot || [];
    const hand = UN.sortHand(o.hand || []);
    const cards = hand.map(id => {
      const can = o.mine && !o.over && hot.indexOf(id) >= 0;
      /* ★ 沒亮的牌**照樣點得動**(只是會跳 toast 說原因)——
         CLAUDE.md 的紅線:不用 disabled / pointer-events:none 讓點擊靜默消失。 */
      return cardHTML(id, can ? "can" : "no");
    }).join("");
    box.innerHTML =
      tableHTML(o) +
      '<div class="un-handwrap">' +
        '<div class="un-hlabel">你的手牌 <b>' + hand.length + '</b> 張' +
          (o.drew && o.drewCard >= 0 ? '<span class="un-drewtag">剛抽到 ' + esc(UN.nameOf(o.drewCard)) + ' —— 只能出這張</span>' : '') +
        '</div>' +
        '<div class="un-hand" id="unHand">' + cards + '</div>' +
      '</div>';
  }

  /* ==========================================================================
     五、動作列
     ──────────────────────────────────────────────────────────────────────────
       o = { mine, over, turnName, drew, noPlay, handLen,
             unoOn(UNO! 有沒有按下), unoRule, catchName(可以抓誰,空 = 沒有),
             cdMs, cdEnd }
       ★★ 手上有合法牌可出時**不准抽**(強制出牌,見 rules.js 的 doDraw)——
          所以「抽一張」鈕只在 noPlay 時才畫;不畫的時候唯一的動作就是點一張亮起來
          的牌。牌桌中央那顆牌堆(#unDraw)仍然一直可以點,誤按由 hAct("draw") 那一側
          的驗證跳 toast 講原因(不用 disabled 讓點擊靜默消失)。
     ========================================================================== */
  function renderActs(o){
    const box = $("unActs");
    if(!box) return;
    if(o.over){ box.classList.add("hidden"); box.innerHTML = ""; return; }
    let h = "";

    /* ★★ 抓鈕**不分回合**(視窗是「下一家出手之前」,不是「輪到我」)——
       所以它排在最前面,而且不管 mine 是什麼都要畫。 */
    if(o.catchName){
      h += '<button class="btn danger un-catch" id="unCatch" type="button">' +
             '抓!<small>' + esc(o.catchName) + ' 沒喊 UNO</small></button>';
    }

    if(!o.mine){
      h += '<div class="un-wait">等 <b>' + esc(o.turnName || "") + '</b> 出牌…</div>';
    }else{
      /* ★ UNO! 是**出牌前先按下的切換**,不是出牌後補按的 ——
         宣告與出牌必須是同一手(見 rules.js 第五節:不然會與下一家的出牌競態)。
         ⚠ 只有「手上剛好 2 張」才出現:此時出一張就剩一張。 */
      if(o.unoRule && o.handLen === 2){
        h += '<button class="btn un-unobtn' + (o.unoOn ? " on" : "") + '" id="unUno" type="button">' +
               'UNO!<small>' + (o.unoOn ? "出牌時會一起喊" : "先按這裡再出牌,不然會被抓") + '</small></button>';
      }
      if(o.drew){
        h += '<button class="btn ghost" id="unPass" type="button">不出了 ▸</button>';
      }else if(o.noPlay){
        h += '<button class="btn primary" id="unDrawBtn" type="button">抽一張<small>沒有牌可出</small></button>';
      }
      h += '<div class="un-hint">' +
             (o.drew ? "抽到的那張可以出,也可以不出"
                     : (o.noPlay ? "手上沒有出得了的牌 —— 抽一張" : "手上有牌可以出 —— 點一張亮起來的牌就出牌"))
           + '</div>';
    }
    box.innerHTML = h;
    box.classList.remove("hidden");
    if(o.cdMs > 0) startCd(o.cdEnd, o.cdMs);
    else stopCd();
  }

  /* ---------- 出牌倒數的環(公開資訊:大家都要知道為什麼卡著)---------- */
  let cdT = null;
  function stopCd(){ if(cdT){ clearInterval(cdT); cdT = null; } const b = $("unCd"); if(b) b.remove(); }
  function startCd(endAt, span){
    stopCd();
    const box = $("unActs");
    if(!box || !endAt) return;
    const bar = document.createElement("div");
    bar.className = "un-cd"; bar.id = "unCd";
    bar.innerHTML = '<i></i>';
    box.appendChild(bar);
    const paint = () => {
      const left = Math.max(0, endAt - Date.now());
      const i = bar.firstChild;
      if(i) i.style.width = Math.max(0, Math.min(100, left / span * 100)) + "%";
      if(left <= 0) stopCd();
    };
    paint();
    cdT = setInterval(paint, 100);
  }

  /* ==========================================================================
     六、選色盤 —— Wild 打出去要指定顏色
     ──────────────────────────────────────────────────────────────────────────
       ★ 收斂成一個 callback:askColor(cb) → 玩家點了顏色就 cb(col)。
         單機與連線都只呼叫這一支,所以「選色」這件事只有一份實作。
       ⚠ 蓋板要列進 BACK_LAYERS(uno.html 的 main.js)—— 不然 Android 的返回鍵
         會直接離開房間而不是關掉這一層(CLAUDE.md 紅線 7)。
     ========================================================================== */
  let colorCb = null;
  function askColor(cb){
    colorCb = cb || null;
    const v = $("unColorVeil");
    // 蓋板不存在(理論上不會)→ 直接給紅色,不可以卡在等使用者
    if(!v){ if(colorCb){ const f = colorCb; colorCb = null; f(UN.C_R); } return; }
    v.classList.add("show");
  }
  /* ★★★ 關掉 = **取消那一手 Wild**,而且一定要把 callback 用 col = -1 叫起來。
     ⚠⚠ 第一版寫成「把 colorCb 設成 null 就好」—— 那會讓呼叫端的 `pendWild` 永遠停在
       那張牌上,而 `pendWild >= 0` 是「手牌不能點」的條件 → **整局點不動,而且不報錯**。
       返回鍵(BACK_LAYERS)與外框點擊都走這一支,所以那是一定會發生的路徑。
     ★ 取消是安全的:顏色還沒選就不會送進 moves,牌等於沒出過。 */
  function closeColor(){ pickColor(-1); }
  function pickColor(col){
    const f = colorCb;
    colorCb = null;
    const v = $("unColorVeil");
    if(v) v.classList.remove("show");
    if(!f) return;
    if(col >= 0) sfx.color();
    f(col);                        // ★ col < 0 = 取消(呼叫端要把 pendWild 清掉)
  }
  const colorOpen = () => { const v = $("unColorVeil"); return !!(v && v.classList.contains("show")); };

  /* ==========================================================================
     六之二、掛上點擊(委派)
     ──────────────────────────────────────────────────────────────────────────
       ★ 兩個回呼都由 main.js 分流到單機 / 連線 —— 盤面本身不知道自己在哪一種模式。
       ⚠ 用委派(綁在容器上)而不是逐張牌綁:手牌每次重畫都是新的節點。
       ⚠ 手牌區**以外**的牌不吃點擊(桌上那張、結果表的縮圖)——
         不擋的話點桌面那張牌會被當成「出那一張」(它不在手上,規則層會擋,
         但玩家會看到莫名的 toast)。
     ========================================================================== */
  let hCard = null, hAct = null;
  function mount(h){
    stage = $("unStage");
    hCard = h.onCard; hAct = h.onAct;
    const st0 = stage;
    if(st0){
      st0.addEventListener("click", e => {
        // 牌堆:點它 = 抽一張(與動作列那顆「抽一張」同一條路)
        if(e.target.closest("#unDraw")){ if(hAct) hAct("draw"); return; }
        const el = e.target.closest(".un-card");
        if(!el || !hCard) return;
        if(!el.closest(".un-hand")) return;
        const c = +el.dataset.c;
        if(!isNaN(c)) hCard(c);
      });
    }
    const acts = $("unActs");
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest("button");
        if(!b || !hAct) return;
        if(b.id === "unDrawBtn") hAct("draw");
        else if(b.id === "unPass") hAct("pass");
        else if(b.id === "unUno") hAct("uno");
        else if(b.id === "unCatch") hAct("catch");
      });
    }
    // 選色盤的四顆鈕
    const cols = $("unColors");
    if(cols){
      cols.addEventListener("click", e => {
        const b = e.target.closest("button[data-col]");
        if(b) pickColor(+b.dataset.col);
      });
    }
    /* 點蓋板外框 = 取消那一手 Wild(同返回鍵)。
       ⚠ 一定要比對 e.target 是蓋板本身,不然點卡片內部也會關掉。 */
    const veil = $("unColorVeil");
    if(veil) veil.addEventListener("click", e => { if(e.target === veil) closeColor(); });
  }

  /* ==========================================================================
     七、公告(diff 驅動)
     ──────────────────────────────────────────────────────────────────────────
       ★ 「有人剩一張」與「有人被抓」要讓全桌知道。
       ⚠⚠ 一律靠「上一次記到的值」做 diff,而且**第一次(prev === null)只記不響** ——
          擋掉「進場 / 重連 / 批次同步 / 換局」四種亂響(大老二 announceLa 的教訓)。
     ========================================================================== */
  let unoPrev = null, unoKey = null;
  function announce(o){
    const key = String(o.key == null ? "" : o.key);
    const now = (o.left || []).map((n, i) => (n === 1 ? i : -1)).filter(i => i >= 0).join(",");
    if(unoKey !== key){ unoKey = key; unoPrev = now; return; }   // 換局 → 只記不響
    if(unoPrev === null){ unoPrev = now; return; }
    if(now !== unoPrev){
      const before = unoPrev.split(",").filter(Boolean);
      now.split(",").filter(Boolean).forEach(s => {
        if(before.indexOf(s) >= 0) return;
        const seat = +s;
        const nm = (o.names && o.names[seat]) || ("玩家" + (seat + 1));
        sfx.uno();
        if(window.showToast) showToast((seat === o.me ? "你" : nm) + " 只剩一張牌了!", 1800);
      });
      unoPrev = now;
    }
  }
  function resetAnnounce(){ unoPrev = null; unoKey = null; }

  /* ==========================================================================
     八、結果表
     ──────────────────────────────────────────────────────────────────────────
       ★ 這是**唯一**把手牌翻開的地方(牌情紅線的豁免點)。
       wins = [{ n:累積分, plus:這局加了幾分 }](連線用;單機傳 null)
     ========================================================================== */
  function resultHTML(st, names, me, wins){
    const sc = UN.score(st);
    const rows = sc.sorted.map(r => {
      const nm = names[r.seat] || ("玩家" + (r.seat + 1));
      const mine = r.seat === me;
      const w = wins ? wins[r.seat] : null;
      const cards = r.left
        ? '<span class="un-rcards">' + UN.sortHand(st.hands[r.seat]).map(id => cardHTML(id, "tiny")).join("") + '</span>'
        : '<span class="un-rout">出完了 🎉</span>';
      return '<tr' + (mine ? ' class="me"' : '') + '>' +
               '<td class="rk">' + r.rank + '</td>' +
               '<td class="nm">' + esc(nm) + (mine ? ' <i>(你)</i>' : '') + '</td>' +
               '<td class="lf">' + (r.left ? (r.left + " 張 · " + r.pts + " 點") : "—") + '</td>' +
               '<td class="pt"><b>' + r.rp + '</b> 分' +
                 (w ? '<small>累積 ' + w.n + (w.plus ? " (+" + w.plus + ")" : "") + '</small>' : '') +
               '</td>' +
             '</tr><tr class="cd"' + (mine ? ' class="me"' : '') + '><td colspan="4">' + cards + '</td></tr>';
    }).join("");
    return '<table class="un-rtab"><thead><tr>' +
             '<th>名次</th><th>玩家</th><th>剩牌</th><th>名次分</th>' +
           '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  return {
    mount,
    cardHTML, backHTML, tableHTML,
    render, renderActs, resultHTML,
    askColor, closeColor, pickColor, colorOpen,
    announce, resetAnnounce,
    sfx, moveSfx, stopCd,
    COL_CLS
  };
})();

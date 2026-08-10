"use strict";

/* ============================================================================
   出手順序的決定方式(MPOrder)—— 猜拳 / 隨機 / 房主指定 的**畫面與判定**
   ★ 十個共用 js/shared/ 的遊戲都用得到;Bingo(index.html)不載入這支 ——
     它自己那份在 js/online.js 裡,永遠獨立、永不改動(同 CLAUDE.md 紅線 4 的紀律)。

   ── 這支負責什麼、不負責什麼 ────────────────────────────────────────────
     負責:蓋板 DOM(自己生,九頁不必各貼一份)、三種相位的畫面、以及
           **猜拳的分組判定**(純函式 split(),node 測得到)。
     不負責:Firebase。誰是房主、什麼時候寫 DB、平手要等幾秒,全部在
           js/shared/mp-core.js —— 這支只把「使用者做了什麼」回呼出去。
     ⚠ 所以這支**零 firebase 引用**:mp-core 才有 roomRef,寫入一律走它。

   ── ★★ 為什麼 DOM 由 JS 生,而設定那一列(#mpOrderRow)留在各頁 HTML ──
     蓋板有三塊、約 30 行,九頁各貼一份 = 九份會走鐘的雙胞胎(而且漏掉一個 id
     不會報錯,只會在猜拳那一刻畫不出東西)。設定列相反:它要**插在該遊戲
     大廳設定面板的哪一格之間**,那是各頁自己的版面問題 —— 同 #scoreSeg
     的分工(mp-core 讀它、各頁 HTML 提供它)。

   ── ★★★ CSS 一行都不新增 ──────────────────────────────────────────────
     .veil / .win-card / .mp-veil-card / .mp-veil-title / .rps-* / .reveal-* /
     .order-* / .mp-chip 這幾組**早就在 styles.css 裡**(Bingo 的猜拳在用),
     而且全都是頂層 class、不吃 #id、跟著主題變數走 → 直接沿用。
     ⚠ 不要為這支另開一組 .mpo-* 的樣式:那會變成「同一個東西兩套皮」,
       改主題時一定漏一邊(CLAUDE.md 紅線 6 的反面教訓)。
   ⚠ id 一律 mpo* 前綴(掃過十一頁與 js/,mpo 零命中)—— 不可以跟 Bingo 那份
     (rpsBtns / revealList / orderList…)同名:同名的東西以後一定會被當成同一個。
   ========================================================================== */

const MPOrder = (function(){

  const EMO = { R:"✊", S:"✌️", P:"✋" }, TXT = { R:"石頭", S:"剪刀", P:"布" };

  let hooks = {};              // mp-core 掛進來的回呼(見 attach)
  let built = false;
  let tieSig = "", rvSig = "";  // 平手 / 揭曉的重繪去重(同一份內容不重播動畫)
  let draft = [];              // 房主指定:排到一半的順序(只有房主端有意義)

  /* ==========================================================================
     一、判定(純函式,零 DOM —— tools/test-mp-order.js 直接 require 這一節)
     ========================================================================== */
  function beats(a, b){ return (a === "R" && b === "S") || (a === "S" && b === "P") || (a === "P" && b === "R"); }

  /* 這一輪出拳的結果:把每個「還要比大小的組」拆成新的組,**贏的排前面**。
     groups = [[id,id,…], …](長度 1 的組 = 已經定案的人,原樣留著)
     throws = { id: "R"|"S"|"P" }
     ⚠⚠ 拆法是「同組內贏幾個人」而不是「兩兩淘汰」:三個人出 ✊✌️✋ 時
       每個人都剛好贏一個 → 全部同分 → 整組留著重猜(這才是真的平手)。
       寫成兩兩淘汰的話會冒出「A 贏 B、B 贏 C、C 贏 A」這種沒有名次的結果。
     ⚠ 不改動輸入(groups 逐組 slice)—— 呼叫端會把它寫進 DB,被就地改掉的
       陣列很難追。 */
  function split(groups, throws){
    const out = [];
    (groups || []).forEach(g => {
      if(!g || g.length === 0) return;
      if(g.length <= 1){ out.push(g.slice()); return; }
      const wins = {};
      g.forEach(x => { wins[x] = g.filter(y => y !== x && beats(throws[x], throws[y])).length; });
      const sorted = g.slice().sort((a, b) => wins[b] - wins[a]);
      let cur = [], curWin = null;
      sorted.forEach(x => {
        if(curWin === null || wins[x] === curWin){ cur.push(x); curWin = wins[x]; }
        else { out.push(cur); cur = [x]; curWin = wins[x]; }
      });
      if(cur.length) out.push(cur);
    });
    return out;
  }
  // 還在比大小的人(組長度 > 1);全部定案時回空陣列
  function pending(groups){ return (groups || []).filter(g => g && g.length > 1).reduce((a, g) => a.concat(g), []); }
  const settled = groups => pending(groups).length === 0;
  const flat = groups => (groups || []).reduce((a, g) => a.concat(g || []), []);
  /* DB 上的 groups 是**字串陣列**(["a,b","c"])—— Firebase 不存空陣列,而
     「陣列的陣列」在快照裡很容易變成物件;存成逗號字串就沒有這個問題。
     ⚠ 一律順手濾掉已經離開的人(猜拳中有人跑掉是常態)。 */
  function parseGroups(raw, alive){
    return (raw || []).map(g => String(g).split(",").filter(id => !alive || alive(id))).filter(g => g.length > 0);
  }
  const dumpGroups = groups => groups.map(g => g.join(","));

  /* ==========================================================================
     二、蓋板 DOM(自己生一次;名字一律走 textContent,不進 innerHTML)
     ========================================================================== */
  function ensureDom(){
    if(built) return;
    const v = document.createElement("div");
    v.className = "veil"; v.id = "mpoVeil";
    /* ⚠ 這一整段是**寫死的樣板**,沒有任何玩家資料 → innerHTML 是安全的;
       名字之類的值一律在下面 render 時用 textContent 塞(同 ui-kit 的紀律)。 */
    v.innerHTML =
      '<div class="win-card mp-veil-card">' +
        // 猜拳:出拳
        '<div id="mpoRps">' +
          '<div class="mp-veil-title">✊ 猜拳決定順序</div>' +
          '<div class="rps-hint" id="mpoHint">出拳!</div>' +
          '<div class="rps-btns" id="mpoBtns">' +
            '<button class="rps-btn" data-rps="R" title="石頭" aria-label="石頭">✊</button>' +
            '<button class="rps-btn" data-rps="S" title="剪刀" aria-label="剪刀">✌️</button>' +
            '<button class="rps-btn" data-rps="P" title="布" aria-label="布">✋</button>' +
          '</div>' +
          '<div class="rps-throws" id="mpoThrows"></div>' +
        '</div>' +
        // 猜拳:揭曉
        '<div id="mpoRv" class="hidden">' +
          '<div class="mp-veil-title">✊ 猜拳結果</div>' +
          '<div class="reveal-hands" id="mpoHands"></div>' +
          '<div class="reveal-order" id="mpoOrder"></div>' +
          '<div class="rps-hint" id="mpoRvHint"></div>' +
          '<div class="actions"><button class="btn primary hidden" id="mpoSkip">跳過 ⏭</button></div>' +
        '</div>' +
        // 房主指定
        '<div id="mpoOrd" class="hidden">' +
          '<div class="mp-veil-title">👑 房主排順序</div>' +
          '<div class="rps-hint" id="mpoOrdHint"></div>' +
          '<div class="order-list" id="mpoList"></div>' +
          '<div class="actions"><button class="btn primary hidden" id="mpoConfirm">確定順序,開始 ▸</button></div>' +
        '</div>' +
        // 逃生出口:有人一直不出拳 / 房主在排順序時卡住,總是要能走
        '<button class="peek-link" id="mpoLeave">離開房間</button>' +
      '</div>';
    document.body.appendChild(v);
    $("mpoBtns").addEventListener("click", e => {
      const b = e.target.closest ? e.target.closest("button[data-rps]") : null;
      if(b && hooks.onThrow) hooks.onThrow(b.dataset.rps);
    });
    $("mpoSkip").addEventListener("click", () => { if(hooks.onSkip) hooks.onSkip(); });
    $("mpoConfirm").addEventListener("click", () => { if(hooks.onConfirm) hooks.onConfirm(draft.slice()); });
    $("mpoLeave").addEventListener("click", () => { if(hooks.onBail) hooks.onBail(); });
    built = true;
  }

  function attach(h){ hooks = h || {}; }
  function isOpen(){ const v = built ? $("mpoVeil") : null; return !!(v && v.classList.contains("show")); }
  function hide(){
    if(!built) return;
    $("mpoVeil").classList.remove("show");
    tieSig = ""; rvSig = ""; draft = [];
  }

  /* ==========================================================================
     三、畫面
     ──────────────────────────────────────────────────────────────────────────
       v = { phase:"rps"|"reveal"|"ordering", rps, reveal, order, players,
             meId, isHost, dispName }
       ★ 三塊共用同一張卡(同一個 .veil)—— 三個獨立蓋板的話返回鍵 / 疊層順序
         都要各想一次,而它們在流程上是接續的三頁,不會同時出現。
     ========================================================================== */
  function show(v){
    ensureDom();
    $("mpoVeil").classList.add("show");
    const ph = v.phase;
    $("mpoRps").classList.toggle("hidden", ph !== "rps");
    $("mpoRv").classList.toggle("hidden", ph !== "reveal");
    $("mpoOrd").classList.toggle("hidden", ph !== "ordering");
    // 房主的逃生出口是「取消,回大廳」(房間留著,大家可以重來);訪客是真的離開
    $("mpoLeave").textContent = v.isHost ? "取消,回大廳" : "離開房間";
    if(ph === "rps") renderRps(v);
    else if(ph === "reveal") renderReveal(v);
    else renderOrdering(v);
  }

  // 誰跟我還在同一組(組長度 > 1 才要出拳)
  function myGroup(v){
    const gs = parseGroups(v.rps && v.rps.groups, id => !!v.players[id]);
    for(let i = 0; i < gs.length; i++) if(gs[i].indexOf(v.meId) >= 0) return gs[i];
    return null;
  }

  function renderRps(v){
    const rps = v.rps || {}, seq = rps.seq || 1, throws = rps.throws || {};
    const mg = myGroup(v);
    if(rps.tie){ renderTie(v, seq, throws, mg); return; }
    tieSig = "";
    /* ⚠ mine 一定要是**布林**:classList.toggle 收到 undefined 會「翻轉」而不是設定,
       平手重猜那一輪會亮錯(Bingo 那份修過同一個坑)。 */
    const mine = !!(throws[v.meId] && throws[v.meId].s === seq);
    const inGroup = !!(mg && mg.length > 1);
    const btns = $("mpoBtns");
    btns.style.display = inGroup ? "" : "none";
    btns.classList.toggle("locked", mine);          // 出過拳就不能改
    $("mpoHint").textContent =
      !inGroup ? "你的順序已經定了,等其他人猜完…"
      : mine   ? ("你出了 " + EMO[throws[v.meId].c] + " " + TXT[throws[v.meId].c] + ",等對手…")
               : "出拳!";
    [].forEach.call(btns.children, b => {
      const chosen = mine && throws[v.meId].c === b.dataset.rps;
      b.classList.toggle("chosen", chosen);
      b.classList.toggle("dim", mine && !chosen);   // 出拳後淡化沒選的,只留你選的
    });
    /* 誰出過拳的晶片列。★ **只講「出過拳了沒」,絕不透露出了什麼** ——
       同時出拳的遊戲一旦讓人偷看得到,先出的人就吃虧。 */
    const box = $("mpoThrows"); box.innerHTML = "";
    pending(parseGroups(rps.groups, id => !!v.players[id])).forEach(id => {
      const done = !!(throws[id] && throws[id].s === seq);
      const chip = document.createElement("div");
      chip.className = "mp-chip" + (done ? " ready" : "") + (id === v.meId ? " me" : "");
      const dot = document.createElement("span"); dot.className = "dot";
      const nm = document.createElement("span"); nm.textContent = v.dispName(id);
      const ln = document.createElement("span"); ln.className = "ln"; ln.textContent = done ? "已出拳" : "等待中";
      chip.appendChild(dot); chip.appendChild(nm); chip.appendChild(ln);
      box.appendChild(chip);
    });
  }

  /* 平手揭曉:把這一輪還在比大小的人各出了什麼攤開,停一下再重猜 ——
     少了這一段,畫面上只會「忽然又要出拳一次」,沒有人知道剛剛平手了。 */
  function renderTie(v, seq, throws, mg){
    const inGroup = !!(mg && mg.length > 1);
    $("mpoBtns").style.display = "none";
    $("mpoHint").textContent = inGroup ? "🤝 平手!再猜一次…" : "還有人平手,再猜一次…";
    const ids = pending(parseGroups(v.rps && v.rps.groups, id => !!v.players[id]));
    const sig = "tie:" + seq + "|" + ids.map(id => id + ":" + ((throws[id] && throws[id].c) || "")).join(",");
    if(sig === tieSig) return;                       // 內容沒變就不重畫(不然動畫每次快照都重播)
    tieSig = sig;
    const box = $("mpoThrows"); box.innerHTML = "";
    ids.forEach((id, idx) => {
      const c = (throws[id] && throws[id].s === seq) ? throws[id].c : null;
      box.appendChild(hand(v, id, c, "tie", idx));
    });
  }

  function renderReveal(v){
    const rv = v.reveal || {}, throws = rv.throws || {};
    const ord = (rv.order && rv.order.length ? rv.order : v.order) || [];
    const ids = ord.filter(id => v.players[id] || throws[id]);
    $("mpoSkip").classList.toggle("hidden", !v.isHost);
    $("mpoRvHint").textContent = v.isHost ? "馬上開始…" : "等房主開始…";
    // 順序那一行:1. 小明 → 2. 小華
    $("mpoOrder").textContent = ids.map((id, i) => (i + 1) + ". " + v.dispName(id)).join("  →  ");
    if(ids.length && !ids.some(id => throws[id])) return;   // 出拳資料還沒同步到 → 先不畫(免得閃一排 ❔)
    const sig = ids.map(id => id + ":" + (throws[id] || "")).join("|");
    if(sig === rvSig) return;
    rvSig = sig;
    const box = $("mpoHands"); box.innerHTML = "";
    ids.forEach((id, idx) => box.appendChild(hand(v, id, throws[id] || null, idx === 0 ? "win" : "", idx)));
  }

  // 一張「某人出了什麼」的卡(揭曉與平手共用)
  function hand(v, id, c, extra, idx){
    const it = document.createElement("div");
    it.className = "reveal-hand" + (extra ? (" " + extra) : "") + (id === v.meId ? " me" : "");
    it.style.animationDelay = (idx * 0.08) + "s";
    const emo = document.createElement("span"); emo.className = "emo"; emo.textContent = EMO[c] || "❔";
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = v.dispName(id);
    const tx = document.createElement("span"); tx.className = "txt"; tx.textContent = TXT[c] || "";
    it.appendChild(emo); it.appendChild(nm); it.appendChild(tx);
    return it;
  }

  /* 房主指定:上下箭頭排先後。
     ⚠ draft 每次都要**濾掉已經離開的人**,而且只有房主端有意義 ——
       訪客看到的是「目前在房裡的人」加一句「房主正在安排…」。 */
  function renderOrdering(v){
    const alive = Object.keys(v.players);
    if(v.isHost){
      const keep = draft.filter(id => v.players[id]);
      alive.forEach(id => { if(keep.indexOf(id) < 0) keep.push(id); });   // 新加入的排在最後
      draft = keep;
    }
    const arr = v.isHost ? draft.slice() : alive;
    $("mpoConfirm").classList.toggle("hidden", !v.isHost);
    $("mpoOrdHint").textContent = v.isHost ? "用上下箭頭排好先後,然後開始。" : "房主正在安排順序…";
    const list = $("mpoList"); list.innerHTML = "";
    arr.forEach((id, idx) => {
      const it = document.createElement("div"); it.className = "order-item";
      const seat = document.createElement("span"); seat.className = "seat"; seat.textContent = String(idx + 1);
      const nm = document.createElement("span"); nm.className = "nm";
      nm.textContent = v.dispName(id) + (id === v.meId ? "(你)" : "");
      it.appendChild(seat); it.appendChild(nm);
      if(v.isHost){
        const mv = document.createElement("span"); mv.className = "mv";
        [["▲", -1, idx === 0], ["▼", 1, idx === arr.length - 1]].forEach(([txt, d, dis]) => {
          const b = document.createElement("button");
          b.textContent = txt; b.disabled = dis;
          b.addEventListener("click", () => { move(idx, d); show(v); });
          mv.appendChild(b);
        });
        it.appendChild(mv);
      }
      list.appendChild(it);
    });
  }
  function move(idx, d){
    const j = idx + d;
    if(j < 0 || j >= draft.length) return;
    const t = draft[idx]; draft[idx] = draft[j]; draft[j] = t;
  }

  return {
    attach, show, hide, isOpen,
    // 判定(純函式)
    beats, split, pending, settled, flat, parseGroups, dumpGroups,
    EMO, TXT
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = MPOrder;

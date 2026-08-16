"use strict";

/* ============================================================================
   飛行棋 — 盤面(FCB)

   單機與連線**共用這一支**:盤面自己不知道現在是哪一種模式,兩個回呼由 main.js
   分流(同排七 SVB 的做法)。漏掉分流的症狀是「單機點了沒反應」或「連線走到單機那條路」。

   ── ★ 盤面尺寸用 JS 算,不用 aspect-ratio ────────────────────────────────
     比照暗棋 / 成語接龍:格子必須是整數像素的正方形,交給 CSS 去算會在
     14 格 × 小數的情況下累積出半格誤差(飛機就對不準格子中心)。
     fitBoard() 量 stage 的可用空間 → 算出 cell → 寫進 --fc-cell,其餘全部靠這個變數。

   ── ★★★ 批次同步絕對不可以連播動畫 ───────────────────────────────────────
     這是十三個遊戲裡**第一個有棋子位移動畫**的一頁,所以它是新的一條坑:
     其他遊戲的「批次同步就是同一支 replay 多跑幾手」在有動畫時會變成
     **二十幾秒的慢動作**(斷線重連的人看著飛機一格一格自己走完前面所有手)。
     → render() 只有在 opts.anim 明確為 true 時才走動畫,adapter 的 applyGame()
       負責判斷「這是新的一手」還是「一口氣補了很多手」。

   ── ★ 顏色是規則本體(同 UNO)─────────────────────────────────────────────
     四色決定「哪一格是自家色(可以跳)」「誰的飛機」「誰的跑道」——
     **任何主題都不准把它轉成黑白**,所以 --fc-c0..3 刻意不吃主題變數。
     色盲的第二訊號是飛機身上的**座號數字**(1~4),不是只有顏色。
   ========================================================================== */

const FCB = (function(){

  const R = FC;
  const CELL_MIN = 13;                 // 再小就點不到了(手指 + 邊框)
  const CELL_MAX = 46;

  /* 一格走多久。★ 走格是一格一段 —— 玩家會跟著數,一次滑過去就看不出走了幾格 */
  const MS_WALK = 105, MS_JUMP = 260, MS_FLY = 520, MS_LAUNCH = 300, MS_EAT = 420;

  let board = null, stage = null, acts = null;
  let cb = { onDice: null, onPlane: null };
  let built = false, cell = 0;
  let planeEls = [];                   // planeEls[seat][i]
  let shown = null;                    // 上一次畫出來的進度快照(動畫的起點)
  let shownColors = null;
  let animGen = 0, animating = false;
  let cdT = null;

  /* 這一頁的音效。★ 走 Sound.tone()(audio.js 開給各遊戲寫自己樂句的入口)——
     吃靜音開關與總音量,不必自己管。⚠ 走一格的 tick 要**很輕**:一手可能連走六格,
     用一般音量會變成連珠炮。 */
  const SFX = {
    tick(){ T(1040, { type: "square", dur: 0.030, vol: 0.055 }); },
    jump(){ T(660, { type: "triangle", dur: 0.11, vol: 0.16, slideTo: 1180 }); },
    fly(){ T(300, { type: "sawtooth", dur: 0.38, vol: 0.10, slideTo: 1500 });
           T(760, { type: "sine", dur: 0.22, vol: 0.10, delay: 0.16, slideTo: 1320 }); },
    eat(){ T(420, { type: "square", dur: 0.16, vol: 0.20, slideTo: 110 });
           T(150, { type: "triangle", dur: 0.22, vol: 0.16, delay: 0.06 }); },
    dice(){ T(300, { type: "square", dur: 0.05, vol: 0.13 });
            T(560, { type: "triangle", dur: 0.10, vol: 0.15, delay: 0.05, slideTo: 820 }); },
    home(){ [659, 880, 1175].forEach((f, i) => T(f, { type: "sine", dur: 0.18, vol: 0.20, delay: i * 0.07 })); },
    launch(){ T(360, { type: "triangle", dur: 0.20, vol: 0.18, slideTo: 900 }); }
  };
  function T(f, o){ if(typeof Sound !== "undefined" && Sound.tone) Sound.tone(f, o); }

  const PLANE_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.6 L13.7 8.6 L22.4 12.9 L22.4 15.1 ' +
    'L13.7 12.9 L13.2 18.7 L15.9 20.9 L15.9 22.4 L12 21.2 L8.1 22.4 L8.1 20.9 L10.8 18.7 ' +
    'L10.3 12.9 L1.6 15.1 L1.6 12.9 L10.3 8.6 Z"/></svg>';

  /* ==========================================================================
     一、建盤面(只做一次)
     ──────────────────────────────────────────────────────────────────────────
       格子是絕對定位的 div,座標一律問 rules.js 的幾何表 —— 這一支不自己算任何
       格子位置(規則與畫面脫鉤,盤面重畫時 rules.js 一行都不必動)。
     ========================================================================== */
  function at(x, y, w, h){
    return 'style="left:calc(var(--fc-cell) * ' + x + ');top:calc(var(--fc-cell) * ' + y + ');' +
           'width:calc(var(--fc-cell) * ' + (w || 1) + ');height:calc(var(--fc-cell) * ' + (h || 1) + ')"';
  }

  function build(){
    if(built || !board) return;
    let h = "";

    // 四個機場區塊(5×5,擺在四個角)
    for(let c = 0; c < 4; c++){
      const b = R.hangarXY(c, 0);      // 左上那一格 → 往回推區塊原點
      const ox = b.x - 1, oy = b.y - 1;
      h += '<div class="fc-hangar" data-c="' + c + '" ' + at(ox, oy, 5, 5) + '></div>';
      for(let k = 0; k < 4; k++){
        const p = R.hangarXY(c, k);
        h += '<div class="fc-slot" data-c="' + c + '" ' + at(p.x, p.y) + '></div>';
      }
    }

    // 外圈 52 格。★ 自家色格畫上「跳」的記號,航線格畫上「飛」的記號
    for(let i = 0; i < R.RING; i++){
      const p = R.ringXY(i), col = R.colorAt(i);
      const cls = ["fc-cell"];
      let mark = "";
      // 這一格對「以它為自家色的那一家」而言是第幾格
      const q = ((i - R.START[col]) % R.RING + R.RING) % R.RING + 1;
      /* ⚠⚠ **「可以跳」的格子不畫記號,只靠底色。** 顏色是每格輪一次的
         → 52 格**每一格都是某一家的自家色格**,每格都畫記號的話整圈變成一片三角形,
           反而看不出起飛點與航線格在哪(v1.179.0 第一版截圖就是這樣糊成一片的)。
         真實的飛行棋盤也是這樣:底色就是規則,只有起飛點與航線另外做記號。 */
      if(q === 1){ cls.push("start"); mark = '<i class="fc-mk start"></i>'; }
      else if(q === R.FLY_Q){ cls.push("fly"); mark = '<i class="fc-mk fly"></i>'; }
      else if(R.isOwnColor(q)){ cls.push("jump"); }
      h += '<div class="' + cls.join(" ") + '" data-c="' + col + '" data-i="' + i + '" ' +
           at(p.x, p.y) + '>' + mark + '</div>';
    }

    // 四條回家跑道
    for(let c = 0; c < 4; c++)
      for(let k = 0; k < R.LANE; k++){
        const p = R.laneXY(c, k);
        h += '<div class="fc-lane" data-c="' + c + '" ' + at(p.x, p.y) + '></div>';
      }

    // 終點(中央 2×2)
    h += '<div class="fc-goal" ' + at(R.GOAL_XY.x - 1, R.GOAL_XY.y - 1, 2, 2) + '><span>🏁</span></div>';

    board.innerHTML = h;
    built = true;
  }

  /* ==========================================================================
     二、尺寸
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 只在「真的要換尺寸」時才寫 DOM —— 每次 render 都寫一次 style 會讓
         正在跑的 transition 重來(飛機會抖)。
     ========================================================================== */
  function fitBoard(){
    if(!board || !stage) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    if(w <= 0) return;
    // 高度量不到(還沒排版完)就先只吃寬度,resize 會再叫一次
    const side = h > 40 ? Math.min(w, h) : w;
    let c = Math.floor(side / R.GRID);
    if(c < CELL_MIN) c = CELL_MIN;
    if(c > CELL_MAX) c = CELL_MAX;
    if(c === cell) return;
    cell = c;
    board.style.setProperty("--fc-cell", c + "px");
    board.style.width = (c * R.GRID) + "px";
    board.style.height = (c * R.GRID) + "px";
    if(shown) placeAll(shown, shownColors, 0);
  }

  /* ==========================================================================
     三、飛機
     ========================================================================== */
  function ensurePlanes(st){
    const need = st.n + ":" + st.planes[0].length + ":" + st.colors.join("");
    if(board.dataset.pk === need) return;
    board.dataset.pk = need;
    // 舊的先收掉(換局 / 換人數)
    planeEls.forEach(row => row.forEach(el => el.remove()));
    planeEls = [];
    for(let s = 0; s < st.n; s++){
      const row = [];
      for(let i = 0; i < st.planes[s].length; i++){
        const el = document.createElement("button");
        el.type = "button";
        el.className = "fc-plane";
        el.dataset.c = st.colors[s];
        el.dataset.seat = s;
        el.dataset.plane = i;
        el.innerHTML = PLANE_SVG + '<b class="fc-pn">' + (s + 1) + "</b>";
        el.setAttribute("aria-label", "第 " + (s + 1) + " 家的飛機 " + (i + 1));
        board.appendChild(el);
        row.push(el);
      }
      planeEls.push(row);
    }
  }

  /* 把一架飛機放到某個進度。dur=0 = 不做動畫(批次同步 / 換尺寸走這條)。
     ⚠ 同一格上疊了好幾架時要錯開,不然只看得到最上面那一架。 */
  function place(el, color, q, plane, dur, stackIdx, stackN){
    const p = R.posXY(color, q, plane);
    let dx = 0, dy = 0;
    if(stackN > 1){
      // 疊機:小幅度扇形錯開(最多四架)
      const k = stackIdx - (stackN - 1) / 2;
      dx = k * 0.22; dy = (stackIdx % 2 ? 0.14 : -0.14);
    }
    /* ⚠ 錯開之後要**夾回盤面內**:外圈最外面那一圈就貼著邊(x 或 y = 13),
       往外錯開就是整架飛機掛在盤子外面(量得到:診斷的 outside 會變成 1)。
       ⚠ 夾的只有**畫**,命中判定與規則完全不看這個偏移(同表情飛出那條夾取的道理)。 */
    const MAXQ = R.GRID - 1;
    const x = Math.max(0, Math.min(MAXQ, p.x + dx));
    const y = Math.max(0, Math.min(MAXQ, p.y + dy));
    el.style.transitionDuration = dur ? (dur + "ms") : "0ms";
    el.style.transform = "translate(calc(var(--fc-cell) * " + x + "), " +
                                    "calc(var(--fc-cell) * " + y + "))";
  }

  /* 一次把所有飛機擺到 planes 的位置(不動畫) */
  function placeAll(planes, colors, dur){
    if(!planeEls.length) return;
    // 先算每個「落點」上有幾架,才錯得開
    const bucket = {};
    for(let s = 0; s < planes.length; s++)
      for(let i = 0; i < planes[s].length; i++){
        const q = planes[s][i];
        const key = (q <= 0) ? ("h" + s + "_" + i)
                  : (q >= R.GOAL) ? "goal"
                  : (q > R.RING) ? ("l" + colors[s] + "_" + q)
                  : ("r" + R.absOf(colors[s], q));
        (bucket[key] = bucket[key] || []).push({ s: s, i: i });
      }
    Object.keys(bucket).forEach(key => {
      const list = bucket[key];
      list.forEach((o, k) => {
        const el = planeEls[o.s] && planeEls[o.s][o.i];
        if(el) place(el, colors[o.s], planes[o.s][o.i], o.i, dur, k, list.length);
      });
    });
  }

  /* ==========================================================================
     四、動畫 —— 走一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 世代記號:換局 / 離場 / 下一手插隊時,舊的 timer 一律不執行
         (同 solo.js 的 later();台灣麻將踩過「離場後電腦繼續打牌」那個坑)。
     ========================================================================== */
  function bump(){ animGen++; animating = false; }
  function later(g, fn, ms){ setTimeout(() => { if(g === animGen) fn(); }, ms); }

  // hops → 一步一步的清單(走格是一格一段,跳 / 飛各一段)
  function stepsOf(fromQ, hops){
    const out = [];
    let cur = fromQ;
    (hops || []).forEach(hp => {
      if(hp.kind === "walk"){
        for(let q = cur + 1; q <= hp.to; q++) out.push({ q: q, kind: "walk" });
      }else{
        out.push({ q: hp.to, kind: hp.kind });
      }
      cur = hp.to;
    });
    if(!out.length) out.push({ q: hops && hops.length ? hops[hops.length - 1].to : fromQ, kind: "walk" });
    return out;
  }
  const msOf = k => k === "fly" ? MS_FLY : k === "jump" ? MS_JUMP : k === "launch" ? MS_LAUNCH : MS_WALK;

  /* 走完一手要多久(adapter / solo 用它決定「下一步等多久」) */
  function animMs(fromQ, hops){
    return stepsOf(fromQ, hops).reduce((a, s) => a + msOf(s.kind), 0);
  }

  function runMove(st, mv, done){
    const g = ++animGen;
    animating = true;
    const seat = mv.seat, idx = mv.plane;
    const el = planeEls[seat] && planeEls[seat][idx];
    const fromQ = (shown && shown[seat]) ? shown[seat][idx] : 0;
    if(!el){ finish(); return; }

    // 先把「這一手沒有動到的飛機」擺到定位(被踩的那幾架先留在原地)
    const mid = st.planes.map(row => row.slice());
    mid[seat][idx] = fromQ;
    (mv.eaten || []).forEach(e => {
      const prev = (shown && shown[e.seat]) ? shown[e.seat][e.plane] : 0;
      mid[e.seat][e.plane] = prev;
    });
    placeAll(mid, st.colors, 0);

    const steps = stepsOf(fromQ, mv.hops);
    let k = 0;
    (function next(){
      if(g !== animGen) return;
      if(k >= steps.length){ land(); return; }
      const s = steps[k++];
      el.classList.toggle("hop", s.kind === "jump");
      el.classList.toggle("flying", s.kind === "fly");
      place(el, st.colors[seat], s.q, idx, msOf(s.kind), 0, 1);
      if(s.kind === "walk") SFX.tick();
      else if(s.kind === "fly") SFX.fly();
      else if(s.kind === "jump") SFX.jump();
      else if(s.kind === "launch") SFX.launch();
      later(g, next, msOf(s.kind));
    })();

    function land(){
      el.classList.remove("hop", "flying");
      if(mv.home) SFX.home();
      if(mv.eaten && mv.eaten.length){
        // ★ 被踩的飛機在「踩到」之後才飛回機場 —— 同時發生的話看不出誰踩了誰
        SFX.eat();
        mv.eaten.forEach(e => {
          const ee = planeEls[e.seat] && planeEls[e.seat][e.plane];
          if(ee) ee.classList.add("eaten");
        });
        later(g, () => {
          placeAll(st.planes, st.colors, MS_EAT);
          later(g, () => {
            (mv.eaten || []).forEach(e => {
              const ee = planeEls[e.seat] && planeEls[e.seat][e.plane];
              if(ee) ee.classList.remove("eaten");
            });
            finish();
          }, MS_EAT);
        }, 120);
        return;
      }
      placeAll(st.planes, st.colors, 0);
      finish();
    }
    function finish(){
      if(g !== animGen) return;
      animating = false;
      shown = st.planes.map(r => r.slice());
      shownColors = st.colors.slice();
      if(done) done();
    }
  }

  /* ==========================================================================
     五、對外:畫一次
     ──────────────────────────────────────────────────────────────────────────
       view = {
         st,               replay 出來的局面(唯一真相)
         mySeat,           我坐哪(-1 = 觀看)
         can:[planeIdx],   現在我可以動哪幾架(空 = 不能動)
         anim:{...}|null,  ★ 這一手要不要演(批次同步一律 null)
         onDone            演完的回呼
       }
     ========================================================================== */
  function render(view){
    if(!board) return;
    const st = view.st;
    if(!st) return;
    build();
    ensurePlanes(st);
    fitBoard();

    // 可以動的那幾架加上提示;其餘一律拿掉(不用 disabled —— 點了要講得出原因)
    const can = view.can || [];
    for(let s = 0; s < planeEls.length; s++)
      for(let i = 0; i < planeEls[s].length; i++){
        const el = planeEls[s][i];
        el.classList.toggle("can", s === view.mySeat && can.indexOf(i) >= 0);
        el.classList.toggle("mine", s === view.mySeat);
        el.classList.toggle("home", st.planes[s][i] >= R.GOAL);
      }
    // 誰的回合:那一家的機場亮起來
    [...board.querySelectorAll(".fc-hangar")].forEach(el => {
      el.classList.toggle("turn", !st.over && +el.dataset.c === st.colors[st.turn]);
    });

    const fresh = !shown || shown.length !== st.planes.length ||
                  (shown[0] && shown[0].length !== st.planes[0].length);
    if(view.anim && !fresh && shown){
      runMove(st, view.anim, view.onDone);
      return;
    }
    bump();
    placeAll(st.planes, st.colors, 0);
    shown = st.planes.map(r => r.slice());
    shownColors = st.colors.slice();
    if(view.onDone) view.onDone();
  }

  /* ==========================================================================
     六、骰子與動作列
     ──────────────────────────────────────────────────────────────────────────
       ★ 骰子的點數是**別人給的**(住在 moves 裡),這裡只負責演。
         演完才顯示真值 —— 不可以自己 Math.random() 決定停在哪一面
         (那樣兩台會看到不一樣的點數)。
     ========================================================================== */
  const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
  function dieHTML(v){
    let h = "";
    for(let i = 0; i < 9; i++)
      h += '<i class="fc-pip' + (PIPS[v] && PIPS[v].indexOf(i) >= 0 ? " on" : "") + '"></i>';
    return h;
  }

  let dieEl = null, rollT = null, rollGen = 0;
  function setDie(v){
    if(!dieEl) return;
    dieEl.innerHTML = dieHTML(v || 0);
    dieEl.dataset.v = v || 0;
  }
  /* 擲骰動畫:亂跳幾面之後停在真值。done 在停下來的那一刻叫。
     ⚠ 亂跳的那幾面只是**視覺**,與規則無關(真值是參數帶進來的)。 */
  function rollDie(v, done){
    const g = ++rollGen;
    if(rollT){ clearTimeout(rollT); rollT = null; }
    if(!dieEl){ if(done) done(); return; }
    dieEl.classList.add("rolling");
    let k = 0;
    (function spin(){
      if(g !== rollGen) return;
      if(k++ >= 7){
        dieEl.classList.remove("rolling");
        setDie(v);
        dieEl.classList.remove("pop"); void dieEl.offsetWidth; dieEl.classList.add("pop");
        SFX.dice();
        if(done) done();
        return;
      }
      setDie(1 + (k * 3 + 2) % 6);
      rollT = setTimeout(spin, 55 + k * 8);
    })();
  }

  /* 動作列:骰子鈕 + 一句話 + 倒數環 */
  function renderActs(o){
    if(!acts) return;
    if(!acts.dataset.built){
      acts.dataset.built = "1";
      acts.innerHTML =
        '<div class="fc-cd" id="fcCd"><span class="fc-cd-bar" id="fcCdBar"></span></div>' +
        '<button class="fc-die" id="fcDie" type="button" aria-label="擲骰子"></button>' +
        '<div class="fc-hint" id="fcHint"></div>';
      dieEl = $("fcDie");
      dieEl.addEventListener("click", () => { if(cb.onDice) cb.onDice(); });
      setDie(0);
    }
    acts.classList.remove("hidden");
    const die = $("fcDie"), hint = $("fcHint");
    if(die){
      die.classList.toggle("live", !!o.canRoll);
      die.classList.toggle("idle", !o.canRoll);
      die.disabled = false;                       // ★ 不用 disabled:點了要講得出原因
    }
    if(hint) hint.innerHTML = o.hint || "";
    startCd(o.cdMs, o.cdEnd);
  }

  function startCd(ms, end){
    stopCd();
    const box = $("fcCd"), bar = $("fcCdBar");
    if(!box || !bar) return;
    if(!ms || !end){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      const pct = Math.max(0, Math.min(100, left / ms * 100));
      bar.style.width = pct + "%";
      bar.classList.toggle("warn", left < ms * 0.3);
      if(left <= 0){ stopCd(); return; }
      cdT = setTimeout(tick, 120);
    };
    tick();
  }
  function stopCd(){ if(cdT){ clearTimeout(cdT); cdT = null; } }

  /* ==========================================================================
     七、排名表
     ──────────────────────────────────────────────────────────────────────────
       ★ 單機與連線共用同一支 —— 兩邊各寫一份的話,欄位與措辭一定會慢慢走鐘
         (而且走鐘了兩邊各自都不會壞,沒有東西抓得到)。
       wins 有值 = 連線(顯示累計名次分);沒有 = 單機(顯示這一局拿幾分)。
     ========================================================================== */
  function resultHTML(sc, nameArr, meSeat, foot, wins){
    let h = '<table class="fc-rank"><thead><tr><th>名次</th><th>玩家</th><th>到家</th><th>進度</th>' +
            (wins ? "<th>累計</th>" : "<th>本局</th>") + "</tr></thead><tbody>";
    sc.sorted.forEach(r => {
      const nm = (nameArr && nameArr[r.seat] != null) ? nameArr[r.seat] : ("玩家" + (r.seat + 1));
      const w = wins && wins[r.seat];
      h += '<tr class="' + (r.seat === meSeat ? "me" : "") + (r.rank === 1 ? " top" : "") + '">' +
             "<td>" + (r.rank === 1 ? "🏆" : r.rank) + "</td>" +
             '<td><span class="fc-dot" data-c="' + r.color + '"></span>' + esc(nm) + "</td>" +
             "<td>" + r.home + "</td>" +
             "<td>" + r.prog + "</td>" +
             "<td>" + (w ? (w.n + (w.plus ? (' <b class="fc-plus">+' + w.plus + "</b>") : ""))
                         : ("+" + r.pts)) + "</td>" +
           "</tr>";
    });
    h += "</tbody></table>";
    if(foot) h += '<div class="fc-rank-foot">' + esc(foot) + "</div>";
    return h;
  }

  /* ==========================================================================
     八、掛載
     ========================================================================== */
  function mount(o){
    cb = o || {};
    board = $("fcBoard"); stage = $("fcStage"); acts = $("fcActs");
    if(!board) return;
    build();
    // 點飛機:一律綁在盤面上(飛機是動態產生的)
    board.addEventListener("click", e => {
      const el = e.target.closest(".fc-plane");
      if(!el || !cb.onPlane) return;
      cb.onPlane(+el.dataset.plane, +el.dataset.seat);
    });
    let rt = null;
    window.addEventListener("resize", () => {
      if(rt) clearTimeout(rt);
      rt = setTimeout(fitBoard, 90);
    });
    fitBoard();
  }

  function reset(){
    bump();
    /* ⚠⚠ 擲骰動畫有**自己的**世代記號(rollGen)與 timer —— bump() 只管棋子那一半。
       少了這兩行的症狀:骰子轉到一半時離開棋局,那顆骰子會**繼續轉完並且叫一聲**
       (人已經回到選單了)。這正是 t-fc-solo-e2e 的 F 節抓到的東西。 */
    rollGen++;
    if(rollT){ clearTimeout(rollT); rollT = null; }
    if(dieEl) dieEl.classList.remove("rolling");
    stopCd();
    shown = null; shownColors = null;
    if(board){ board.dataset.pk = ""; planeEls.forEach(r => r.forEach(el => el.remove())); planeEls = []; }
    setDie(0);
  }

  return {
    mount, render, renderActs, fitBoard, reset, resultHTML,
    rollDie, setDie, animMs, stopCd,
    busy: () => animating,
    cell: () => cell
  };
})();

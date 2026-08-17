"use strict";

/* ============================================================================
   飛行棋 — 電腦對決(單機)

   與連線對戰共用同一組盤面(FCB)、同一張結果卡(#veil / .fc-win),差別只在
   上面那條列與結果卡的按鈕組 —— 靠 body 的 solo-on class 切換
   (與另外十個遊戲同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相只有這裡的 st(FC.replay 的狀態)。

   ⚠⚠ 電腦的每一個動作都要走帶世代記號的 later() —— 台灣麻將踩過「離場後電腦
      繼續打牌」那個坑(notes/12 第六節):quit() 只把 active 設成 false 的話,
      已經排進 setTimeout 的那一手照樣會跑,而那時 st 可能已經是下一局的了。

   ── ★ 這一頁多一個坑:動畫沒演完不可以推進下一手 ─────────────────────────
      十三個遊戲裡只有飛行棋有棋子位移動畫。「走完一手 → 立刻換下一家擲骰」會讓
      畫面上兩件事疊在一起(飛機還在走,對手的骰子已經在轉)。
      → 一律用 FCB.render() 的 onDone 當節拍器,不要自己抓一個 setTimeout 猜時間。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;
  const NAMES = ["你", "小雲", "阿風", "老雷"];
  const OWN_KEY = "flychess.solo.v1";

  let level = "normal", seats = 2, planes = 2;
  let st = null, moves = [], names = [];
  let active = false, over = false, busy = false;
  let lastTurn = -1;                   // 「輪到你」只在換人那一刻提示一次(見 tick)
  let gen = 0;
  let rec = {};

  const rulesNow = () => FC.normRules({ planes: planes, launch: "one6", goal: 0, exact: false });

  /* ---------- 偏好與戰績 ----------
     刻意與連線那組分開存:連線的房規是「房主替全房選的」,和自己想單練哪一級是兩回事。 */
  function blank(){ return { w: 0, n: 0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(FCAI.LEVELS[o.level]) level = o.level;
      if(o.seats >= FC.MIN_PLAYERS && o.seats <= FC.MAX_PLAYERS) seats = o.seats;
      if(o.planes >= FC.MIN_PLANES && o.planes <= FC.MAX_PLANES) planes = o.planes;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    FCAI.LEVEL_KEYS.forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, seats, planes, rec })); }catch(e){}
  }
  function recOf(k){ return rec[k] || blank(); }
  function recText(k){
    const r = recOf(k);
    return r.n ? (r.n + " 局 " + r.w + " 勝") : "尚無戰績";
  }
  function recLine(k){
    const r = recOf(k);
    return r.n ? ("你在這個難度打過 " + r.n + " 局,拿下第一名 " + r.w + " 次") : "還沒跟這個難度玩過";
  }

  /* ---------- 世代記號 ---------- */
  function later(fn, ms){
    const g = gen;
    setTimeout(() => { if(g === gen && active && !over) fn(); }, ms);
  }
  function bumpGen(){ gen++; }

  /* ---------- 畫面 ---------- */
  function seatName(s){ return names[s] || NAMES[s] || ("玩家" + (s + 1)); }

  // 單機的玩家列。★ 沿用房間框那組 .mp-chip 的外觀 —— 連線與單機長得一樣才有一致感
  function paintBar(){
    const box = $("fcSoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      let h = "";
      for(let s = 0; s < seats; s++){
        const isTurn = !!(st && !st.over && !over && st.turn === s);
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") + '">' +
               '<span class="fc-dot" data-c="' + (st ? st.colors[s] : s) + '"></span>' +
               '<span class="gmk-nm">' + esc(seatName(s)) + '</span>' +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               tailOf(s) +
             '</div>';
      }
      box.innerHTML = h;
    }
    const lv = $("fcSoloLv");
    if(lv) lv.textContent = FCAI.levelOf(level).name;
    const r = $("fcSoloRec");
    if(r) r.textContent = "✈️ " + seats + " 人 · " + recText(level);
  }
  // 晶片尾巴:到家幾架 / 共幾架(連線那份在 adapter,措辭要一樣)
  function tailOf(s){
    if(!st) return "";
    return '<span class="fc-ct" title="到家幾架">' +
           FC.homeCount(st, s) + "/" + st.rules.goal + "</span>";
  }

  /* 連擲 6 的計數(措辭與連線那份 adapter.js 的 sixTag() 一樣)——
     ★ 連續三次 6 這一輪作廢是**規則**,以前畫面上完全沒有,第三次忽然作廢很像 bug。 */
  function sixTag(){
    return (st && st.sixes) ? ('<b class="fc-fire">🔥 連 ' + st.sixes + '/3</b> ') : "";
  }
  function hintText(){
    if(!st) return "";
    if(st.over) return "";
    const who = seatName(st.turn);
    if(st.turn !== ME) return sixTag() + esc(who) + " 正在想…";
    if(!st.die) return sixTag() + "輪到你了 —— 按骰子";
    const L = FC.legalMoves(st, ME);
    if(!L.length) return sixTag() + "這個點數沒得走";
    if(L.length === 1) return sixTag() + "只有這一架動得了 —— 自動出發…";
    return sixTag() + "點一架要動的飛機" + (st.die === 6 ? "(擲到 6,走完可以再擲一次)" : "");
  }

  /* anim 有值 = 這一手要演;done 在演完之後叫(當節拍器用,不要自己猜時間) */
  function paint(anim, done){
    if(!st) return;
    paintBar();
    /* ★ 整包 legalMoves 傳下去(不只 plane index):盤面靠它畫落點預覽與「踩得到」
       那顆紅光(與連線那份 adapter.js 的 paint() 一致)。 */
    const L = (st.turn === ME && st.die && !over && !busy) ? FC.legalMoves(st, ME) : [];
    FCB.render({ st: st, mySeat: ME, can: L.map(m => m.plane), cans: L,
                 anim: anim || null, onDone: done || null });
    FCB.renderActs({
      canRoll: st.turn === ME && !st.die && !over && !busy,
      hint: hintText()
      // 單機不做倒數 —— 想多久是自己的節奏(同排七)
    });
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    bumpGen();
    st = FC.replay(rulesNow(), seats, []);
    moves = [];
    lastTurn = -1;
    names = [];
    for(let s = 0; s < seats; s++) names.push(NAMES[s]);
    over = false; busy = false; active = true;
    FCB.reset();
    closeWin();
    showScreen("solo");
    paint();
    Sound.start();
    saveOwn();
    showToast(seatName(st.turn) + " 先擲", 1500);
    tick();
  }
  function quit(){
    bumpGen();
    active = false; over = false; busy = false; st = null; moves = []; lastTurn = -1;
    FCB.reset();
    closeWin();
    showScreen("home");
    showHomeLayer("solo");        // 回到「單機遊玩」那一層,方便換設定再來
  }
  function again(){ closeWin(); start(); }

  /* ==========================================================================
     驅動 —— 推進到「需要人做決定」為止
     ──────────────────────────────────────────────────────────────────────────
       ★ 只有這一支決定下一步是誰、要不要等人。所有路徑最後都回到它,
         不要在各處自己判斷「接下來換誰」(那就是 turn 取模那類 bug 的溫床)。
     ========================================================================== */
  function tick(){
    if(!active || over || !st) return;
    if(st.over){ finish(); return; }
    /* ★ 換人的那一刻才提示「輪到你」(一聲 + 自家機場一圈金光)——
       ⚠ 一定要用「turn 變了」當條件,不可以只看 st.turn === ME:
         擲到 6 會停在同一個人身上(紅線 1),照 turn 值判會每擲一次就再叫一次。
       ⚠ 措辭 / 做法與連線那份(adapter.js 的 applyOne 回呼)刻意一樣。 */
    if(st.turn !== lastTurn){
      lastTurn = st.turn;
      if(st.turn === ME){ Sound.turn(); FCB.turnCue(); }
    }
    if(st.turn === ME){ busy = false; paint(); return; }     // 等玩家按骰子 / 點飛機
    busy = true;
    paint();
    later(() => {
      if(st.turn === ME || st.over) { busy = false; paint(); return; }
      if(!st.die) aiRoll(); else aiMove();
    }, FCAI.thinkMs(level));
  }

  /* ---------- 擲骰 ---------- */
  function rollFor(seat, after){
    // ★ 這是這一頁唯二准用 Math.random() 的地方之一(另一個在 adapter 的擲骰)
    const d = 1 + Math.floor(Math.random() * 6);
    FCB.rollDie(d, () => {
      if(!active || over || !st) return;
      const wasSixes = st.sixes;
      if(!FC.step(st, FC.encRoll(d))){ busy = false; paint(); return; }
      if(st.last && st.last.voided){
        showToast(seatName(seat) + " 連續三次 6,這一輪作廢 😵", 1600);
      }else if(st.last && st.last.stuck){
        showToast(seatName(seat) + " 擲出 " + d + ",沒有飛機動得了", 1400);
      }
      void wasSixes;
      after(d);
    });
  }

  function doRoll(){
    if(!active || over || busy) return;
    if(st.turn !== ME){ showToast("還沒輪到你"); return; }
    if(st.die){ showToast("先選一架飛機"); return; }
    busy = true;
    paint();
    rollFor(ME, () => {
      if(!st.die){ tick(); return; }                 // 沒得走 / 作廢 → 已經換人
      const L = FC.legalMoves(st, ME);
      if(L.length === 1){
        // 只有一架動得了就替他走 —— 逼玩家點一顆「唯一的選項」是純粹的手續
        later(() => playPlane(L[0].plane, true), 320);
        return;
      }
      busy = false;
      paint();
    });
  }
  function aiRoll(){
    rollFor(st.turn, () => {
      if(!st.die){ tick(); return; }
      later(() => { if(st.die) aiMove(); }, 260);
    });
  }

  /* ---------- 走一架 ---------- */
  function commit(seat, plane){
    if(!FC.step(st, FC.encMove(plane))) return false;
    moves.push(FC.encMove(plane));
    const mv = st.last;
    const txt = FC.moveText(st, mv);
    /* ★★ 踩人 / 到家的現場效果走 FCB.drama()(單機與連線同一支,見 board.js 第七節)——
       toast 只留給「跳 / 飛」那種純資訊。 */
    if(mv.eaten && mv.eaten.length){
      mv.eaten.forEach(e => {
        FCB.drama({ kind: "eat", byName: seatName(seat), toName: seatName(e.seat),
                    toId: "s" + e.seat, victim: e.seat === ME });
      });
    }else if(mv.home){
      FCB.drama({ kind: "home", byName: seatName(seat), byId: "s" + seat });
    }else if(txt){
      showToast(esc(seatName(seat)) + " " + txt, 1400);
    }
    busy = true;
    paint(mv, () => { busy = false; tick(); });      // ★ 演完才推進(onDone 當節拍器)
    return true;
  }

  function playPlane(plane, auto){
    if(!active || over || !st) return;
    if(st.turn !== ME){ showToast("還沒輪到你"); return; }
    if(!st.die){ showToast("先按骰子"); return; }
    if(busy && !auto) return;
    const L = FC.legalMoves(st, ME);
    if(!L.some(m => m.plane === plane)){ showToast(whyNot(plane)); return; }
    commit(ME, plane);
  }
  // 「為什麼這一架動不了」。★ 不用 disabled 讓飛機靜默吃掉點擊(CLAUDE.md 的老規矩)
  function whyNot(plane){
    const q = st.planes[ME][plane];
    if(q >= FC.GOAL) return "這一架已經到家了";
    if(q === 0) return st.rules.launch === "six" ? "要擲到 6 才能起飛" : "要擲到 1 或 6 才能起飛";
    if(st.rules.exact) return "點數太大,終點要剛好走到";
    return "這一架這個點數動不了";
  }

  function aiMove(){
    const seat = st.turn;
    let p = -1;
    try{ p = FCAI.pick(FCAI.viewOf(st, seat), level); }catch(e){ p = -1; }
    // 保險:AI 出了任何意外都不能讓遊戲卡住 → 退回「照規則挑第一個」
    if(p < 0 || !commit(seat, p)){
      const L = FC.legalMoves(st, seat);
      if(!L.length){ busy = false; tick(); return; }
      if(!commit(seat, L[0].plane)){ busy = false; }
    }
  }

  /* ---------- 結算 ---------- */
  function finish(){
    if(over) return;
    over = true; busy = false;
    bumpGen();
    FCB.stopCd();
    const sc = FC.score(st);
    const mine = sc.rows[ME], iWon = sc.winners.indexOf(ME) >= 0;
    const r = recOf(level);
    r.n++; if(iWon) r.w++;
    rec[level] = r;
    saveOwn();
    paintBar();

    const card = $("fcWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(iWon ? "win" : "lose"); }
    $("winWord").textContent = iWon ? "你贏了!" : ("第 " + mine.rank + " 名");
    const lv = FCAI.levelOf(level);
    /* ★ 大字底下只留一句「這局誰贏、我怎麼樣」,局外資訊(人數 / 難度 / 戰績)
       降級到排名表尾巴 —— 同一件事講三次正是排七 v1.75.3 修掉的毛病。
       ⚠ 措辭與連線那份(adapter 的 outcome())刻意寫成同一個格式。 */
    $("winMsg").innerHTML = iWon
      ? ("你的 <b>" + mine.home + "</b> 架先回到家 🎉")
      : (esc(seatName(sc.winners[0])) + " 先回家 · 你到家 <b>" + mine.home + "</b> 架");
    const box = $("fcResult");
    if(box){
      box.innerHTML = FCB.resultHTML(sc, names, ME,
        seats + " 人 · 每人 " + planes + " 架 · " + lv.emoji + lv.name + " · 戰績 " + recText(level));
      box.classList.remove("hidden");
    }
    if(iWon){ Sound.win(); burst(); }
    else Sound.lose();
    showResult();
  }

  return {
    start, quit, again, loadOwn, paintBar,
    roll: doRoll,
    tapPlane: playPlane,
    active: () => active,
    playing: () => active && !over,          // 給更新檢查:局中重載會把整局丟掉
    level: () => level, seats: () => seats, planes: () => planes,
    recText, recLine,
    setLevel(v){ if(FCAI.LEVELS[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(v >= FC.MIN_PLAYERS && v <= FC.MAX_PLAYERS){ seats = v; saveOwn(); } },
    setPlanes(v){ if(v >= FC.MIN_PLANES && v <= FC.MAX_PLANES){ planes = v; saveOwn(); } },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    _st: () => st,
    _moves: () => moves.slice()
  };
})();

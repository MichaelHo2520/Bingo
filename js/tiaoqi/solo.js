"use strict";

/* ============================================================================
   跳棋 — 電腦對決(單機)

   與連線對戰共用同一組盤面(TQB)、同一張結果卡(#veil / .tq-win),差別只在
   上面那條列與結果卡的按鈕組 —— 靠 body 的 solo-on class 切換。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相只有這裡的 st(TQ.replay 的狀態)。

   ⚠⚠ 電腦的每一個動作都要走帶世代記號的 later() —— 台灣麻將踩過「離場後電腦
      繼續打牌」那個坑(notes/12 第六節):quit() 只把 active 設成 false 的話,
      已經排進 setTimeout 的那一手照樣會跑,而那時 st 可能已經是下一局的了。

   ── ★ 這一頁的節拍器是 animMs(),不是回呼 ────────────────────────────────
      board.js **刻意不提供 onDone**(理由見它的檔頭:回呼鏈是飛行棋兩次現場當機的
      病灶)。所以「演完再換下一家」在這裡是
        later(() => …, TQB.animMs(path) + 間隔)
      ⚠ 就算這顆 timer 沒響,畫面也已經是對的(render 一進去就落到真相位置)——
        壞掉的頂多是「電腦不再出手」,而那個**單機重開一局就好**,不會拖累別人。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;
  const NAMES = ["你", "小雲", "阿風", "老雷", "阿賢", "小敏"];
  const OWN_KEY = "tiaoqi.solo.v1";

  let level = "normal", seats = 2, pieces = 6;
  let st = null, moves = [], names = [];
  let active = false, over = false, thinking = false;
  let gen = 0;
  let rec = {};
  let sel = -1, spots = [];
  let lastAI = [];                     // 每一家最近一手(給 AI 防震盪用)

  const rulesNow = () => TQ.normRules({ pieces: pieces });

  /* ---------- 偏好與戰績 ----------
     刻意與連線那組分開存:連線的房規是「房主替全房選的」,和自己想單練哪一級是兩回事。 */
  function blank(){ return { w: 0, n: 0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(TQAI.LEVELS[o.level]) level = o.level;
      if(TQ.seatsOk(o.seats)) seats = o.seats;
      if(TQ.PIECE_OPTS.indexOf(o.pieces) >= 0) pieces = o.pieces;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    TQAI.LEVEL_KEYS.forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, seats, pieces, rec })); }catch(e){}
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
    const box = $("tqSoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      let h = "";
      for(let s = 0; s < seats; s++){
        const isTurn = !!(st && !st.over && !over && st.turn === s);
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") + '">' +
               '<span class="tq-dot" data-c="' + (st ? st.corners[s] : s) + '"></span>' +
               '<span class="gmk-nm">' + esc(seatName(s)) + "</span>" +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               tailOf(s) +
             "</div>";
      }
      box.innerHTML = h;
    }
    const lv = $("tqSoloLv");
    if(lv) lv.textContent = TQAI.levelOf(level).name;
    const r = $("tqSoloRec");
    if(r) r.textContent = "⬢ " + seats + " 人 · " + recText(level);
  }
  // 晶片尾巴:到家幾顆 / 共幾顆(連線那份在 adapter,措辭要一樣)
  function tailOf(s){
    if(!st) return "";
    const hc = TQ.homeCount(st, s), tot = st.goals[s].length;
    // ★ 只剩 1 顆 → 轉金色(連線那份在 adapter.chipTail,兩邊要一模一樣)
    return '<span class="tq-ct' + (tot - hc === 1 ? " tq-last" : "") + '" title="到家幾顆">' +
           '<i class="tq-ct-ic"></i>' + hc + "/" + tot + "</span>";
  }

  /* ★ 「這一顆最遠能飛幾段」——★ 段數標籤在洞上只有 5~6px 高(見 board.js 的
     data-j 註解),真正讀得到「⚡」這個字的地方是這一列。
     ⚠ 提示列是**固定高**的(紅線 18):這一句只能加短的,加長就把盤面推小一階。 */
  function longHint(){
    let m = 0;
    spots.forEach(s => { if(s.jumps > m) m = s.jumps; });
    return m >= 2 ? ' · <b class="tq-jn">⚡ 最長 ' + m + ' 段</b>' : "";
  }
  function hintText(){
    if(!st || st.over) return "";
    if(st.turn !== ME) return esc(seatName(st.turn)) + " 正在想…";
    if(sel >= 0) return spots.length ? ("點一個亮起來的洞" + longHint()) : "這一顆走不動 —— 換一顆";
    return "輪到你了 —— 點一顆自己的棋";
  }

  function paint(anim){
    if(!st) return;
    paintBar();
    TQB.render({ st: st, mySeat: ME, sel: sel, spots: spots, anim: anim || null, pending: -1 });
    TQB.renderActs({ hint: hintText() });
    // 單機不做倒數 —— 想多久是自己的節奏(同排七 / 飛行棋)
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    bumpGen();
    st = TQ.replay(rulesNow(), seats, []);
    moves = [];
    names = [];
    for(let s = 0; s < seats; s++) names.push(NAMES[s]);
    lastAI = new Array(seats).fill(null);
    over = false; thinking = false; active = true;
    sel = -1; spots = [];
    TQB.reset();
    closeWin();
    showScreen("solo");
    paint();
    Sound.start();
    saveOwn();
    showToast(seatName(st.turn) + " 先走", 1500);
    tick();
  }
  function quit(){
    bumpGen();
    active = false; over = false; thinking = false; st = null; moves = [];
    sel = -1; spots = [];
    TQB.reset();
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
    if(st.turn === ME){
      thinking = false;
      /* ★ 「輪到你」——大老二 / UNO / 排七的單機都有,這一頁在 v2.3.3 之前沒有。
         六人局要等五個 AI 依序想完才回到自己,中間只有走子的細響。
         ⚠ `moves.length` 是為了不要與開局的 Sound.start() 撞在一起(第 0 手就是我時)。 */
      if(moves.length) try{ Sound.turn(); }catch(e){}
      paint(); return;                                          // 等玩家點
    }
    thinking = true;
    paint();
    later(aiMove, TQAI.thinkMs(level));
  }

  /* ---------- 走一顆 ---------- */
  function commit(seat, from, to){
    const m = TQ.moveOf(st, seat, from, to);
    if(!m) return false;
    if(!TQ.step(st, TQ.encMove(from, to))) return false;
    moves.push(TQ.encMove(from, to));
    lastAI[seat] = { from: from, to: to };
    const mv = st.last;
    const idx = st.pieces[seat].indexOf(to);
    /* ★★ 現場效果走 TQB.drama()(單機與連線同一支,見 board.js 第七節)。
       ⚠ 它自己包了 try/catch —— 裝飾壞掉不可以連帶把棋局卡住。
       ★ v2.3.4 起「哪一種效果 / 疊哪幾顆聲音」全部在那一支裡決定(在此之前這裡與
         adapter 各有一份門檻,而且已經不一樣了);這裡只把那一手交過去。 */
    if(!TQB.drama({ mv: mv, byName: seatName(seat), toName: "別人", byId: "s" + seat })){
      const t = TQ.moveText(mv);
      if(t && seat !== ME) showToast(esc(seatName(seat)) + " " + t, 1200);
    }
    thinking = true;
    sel = -1; spots = [];
    paint({ seat: seat, idx: idx, path: mv.path });
    /* ★ 節拍器 = 動畫時長,不是回呼(見檔頭)。多留 140ms 讓落地看得清楚。 */
    later(() => { thinking = false; tick(); }, TQB.animMs(mv.path) + 140);
    return true;
  }

  /* ---------- 玩家操作 ----------
     ⚠ 一律受理點擊、一律講得出原因(CLAUDE.md 踩坑 #6)。 */
  function tapPiece(seat, i){
    if(!ok2play()) return;
    if(seat !== ME){ showToast("那是 " + esc(seatName(seat)) + " 的棋"); return; }
    const id = st.pieces[seat][i];
    if(id === sel){ sel = -1; spots = []; paint(); return; }
    selectPiece(id);
  }
  function tapHole(id){
    if(!ok2play()) return;
    const hit = spots.filter(s => s.to === id)[0];
    if(hit){ commit(ME, sel, id); return; }
    const O = TQ.occOf(st);
    if(O[id] === ME){ selectPiece(id); return; }
    if(sel >= 0){ sel = -1; spots = []; paint(); }
  }
  function selectPiece(id){
    sel = id;
    spots = TQ.movesFrom(st, id);
    // ⚠ 有路 / 死路不同的聲音(與 adapter 同一個道理,見那一份的註解)
    if(spots.length) TQB.SFX.pick();
    else { TQB.SFX.blocked(); showToast("這一顆四面都被擋住了 —— 換一顆"); }
    paint();
  }
  function ok2play(){
    if(!active || over || !st || st.over) return false;
    if(st.turn !== ME){ showToast("還沒輪到你"); return false; }
    if(thinking) return false;          // 動畫演到一半 —— 這是單機,不影響任何人
    return true;
  }

  function aiMove(){
    if(!active || over || !st || st.over) return;
    const seat = st.turn;
    let m = null;
    try{ m = TQAI.pick(TQAI.viewOf(st, seat), level, Math.random, lastAI[seat]); }catch(e){ m = null; }
    // 保險:AI 出了任何意外都不能讓遊戲卡住 → 退回「照規則挑第一個」
    if(!m || !commit(seat, m.from, m.to)){
      const L = TQ.allMoves(st, seat);
      if(!L.length){ thinking = false; tick(); return; }
      if(!commit(seat, L[0].from, L[0].to)){ thinking = false; }
    }
  }

  /* ---------- 結算 ---------- */
  function finish(){
    if(over) return;
    over = true; thinking = false;
    bumpGen();
    TQB.stopCd();
    const sc = TQ.score(st);
    const mine = sc.rows[ME], iWon = sc.winners.indexOf(ME) >= 0;
    const r = recOf(level);
    r.n++; if(iWon) r.w++;
    rec[level] = r;
    saveOwn();
    paintBar();

    const card = $("tqWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(iWon ? "win" : "lose"); }
    $("winWord").textContent = iWon ? "你贏了!" : ("第 " + mine.rank + " 名");
    const lv = TQAI.levelOf(level);
    /* ★ 大字底下只留一句「這局誰贏、我怎麼樣」,局外資訊(人數 / 難度 / 戰績)
       降級到排名表尾巴 —— 同一件事講三次正是排七 v1.75.3 修掉的毛病。
       ⚠ 措辭與連線那份(adapter 的 outcome())刻意寫成同一個格式。 */
    $("winMsg").innerHTML = iWon
      ? "你的棋先全部搬到對面 🎉"
      : (esc(seatName(sc.winners[0])) + " 先搬完 · 你到家 <b>" + mine.home + "</b> 顆");
    const box = $("tqResult");
    if(box){
      box.innerHTML = TQB.resultHTML(sc, names, ME,
        seats + " 人 · 每人 " + pieces + " 顆 · " + lv.emoji + lv.name + " · 戰績 " + recText(level));
      box.classList.remove("hidden");
    }
    if(iWon){ Sound.win(); burst(); }
    else Sound.lose();
    showResult();
  }

  return {
    start, quit, again, loadOwn, paintBar,
    tapPiece, tapHole,
    active: () => active,
    playing: () => active && !over,          // 給更新檢查:局中重載會把整局丟掉
    level: () => level, seats: () => seats, pieces: () => pieces,
    recText, recLine,
    setLevel(v){ if(TQAI.LEVELS[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(TQ.seatsOk(v)){ seats = v; saveOwn(); } },
    setPieces(v){ if(TQ.PIECE_OPTS.indexOf(v) >= 0){ pieces = v; saveOwn(); } },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    _st: () => st,
    _moves: () => moves.slice(),
    _sel: () => sel
  };
})();

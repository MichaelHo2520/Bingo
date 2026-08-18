"use strict";

/* ============================================================================
   排七 — 電腦對決(單機)

   與連線對戰共用同一組盤面(SVB)、同一張結果卡(#veil / .sv-win),差別只在
   上面那條列與結果卡的按鈕組 —— 靠 body 的 solo-on class 切換
   (與五子棋 / 數獨 / 消消樂 / 台灣麻將同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相只有這裡的 `st`(SV.replay 的狀態)。

   ⚠⚠ 電腦的每一個動作都要走帶世代記號的 later() —— 台灣麻將踩過「離場後電腦
      繼續打牌」那個坑([notes/12](../../notes/12-台灣麻將電腦對手.md) 第六節):
      quit() 只把 active 設成 false 的話,已經排進 setTimeout 的那一手照樣會跑,
      而那時 st 可能已經是下一局的了。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;                                  // 我固定坐 0 號位(先手由誰持 ♠7 決定)
  const NAMES = ["你", "小接", "阿七", "老蓋", "小龍", "阿順"];
  const OWN_KEY = "sevens.solo.v1";

  let level = "normal", seats = 4;
  let st = null, names = [];
  let active = false, over = false, busy = false;
  let gen = 0;                                   // 世代記號:離場 / 換局後,舊的 timer 一律不執行
  let rec = {};

  /* ---------- 偏好與戰績 ----------
     刻意與連線那組分開存:連線的設定是「房主替全房選的」,和自己想單練哪一級是兩回事
     (比照五子棋 gomoku.solo.v1 / 數獨 sudoku.solo.v1)。 */
  function blank(){ return { w: 0, n: 0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(SVAI.LEVELS[o.level]) level = o.level;
      if(o.seats >= SV.MIN_PLAYERS && o.seats <= SV.MAX_PLAYERS) seats = o.seats;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    SVAI.LEVEL_KEYS.forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, seats, rec })); }catch(e){}
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

  // 單機的玩家列。★ 沿用房間框那組 .mp-chip / .sv-room 的外觀 —— 連線與單機長得一樣才有一致感
  function paintBar(){
    const box = $("svSoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      let h = "";
      for(let s = 0; s < seats; s++){
        const isTurn = !!(st && !st.over && !over && st.turn === s);
        const n = st ? st.hands[s].length : 0;
        const p = st ? st.piles[s].length : 0;
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") + '">' +
               '<span class="sv-seat p' + s + '"></span>' +
               '<span class="gmk-nm">' + esc(seatName(s)) + '</span>' +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               '<span class="sv-chn" title="手上剩幾張"><i class="sv-pip"></i>' + n + '</span>' +
               (p ? '<span class="sv-chp" title="蓋了幾張"><i class="sv-pip back"></i>' + p + '</span>' : "") +
             '</div>';
      }
      box.innerHTML = h;
    }
    const lv = $("svSoloLv");
    if(lv) lv.textContent = SVAI.levelOf(level).name;
    const r = $("svSoloRec");
    if(r) r.textContent = "🎴 " + seats + " 人 · " + recText(level);
  }

  function paint(){
    if(!st) return;
    paintBar();
    const can = (st.turn === ME && !over) ? SV.legal(st.hands[ME], st.tracks) : [];
    // ★ 不再傳 seats —— 盤面沒有對手列了,那些資訊只住在 paintBar() 的晶片上(見 board.js)
    SVB.render({
      tracks: st.tracks, hand: st.hands[ME].slice(), can: can,
      myPile: st.piles[ME],
      mode: (st.turn === ME && !over && !can.length) ? "cover" : "play"
    });
    SVB.renderActs({
      mine: st.turn === ME && !over && !busy,
      canPlay: can.length > 0,
      turnName: busy ? seatName(st.turn) : seatName(st.turn),
      over: over
      // 單機不做倒數 —— 卡多久是自己的節奏(同消消樂的僵局時鐘不套單機)
    });
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    bumpGen();
    st = SV.replay(SV.newDeal(), seats, []);
    names = [];
    for(let s = 0; s < seats; s++) names.push(NAMES[s]);
    over = false; busy = false; active = true;
    SVB.clearSel();
    closeWin();
    showScreen("solo");
    paint();
    Sound.start();
    saveOwn();
    showToast("拿到 " + SV.nameOf(SV.SPADE7) + " 的是 " + seatName(st.turn) + ",由他先出", 1800);
    if(st.turn !== ME) aiTurn();
  }
  function quit(){
    bumpGen();
    active = false; over = false; busy = false; st = null;
    SVB.clearSel(); SVB.stopCd();
    closeWin();
    showScreen("home");
    showHomeLayer("solo");        // 回到「電腦對決」那一層,方便換難度再來
  }
  function again(){ closeWin(); start(); }

  /* ---------- 出牌 / 蓋牌 ---------- */
  function commit(card, pass){
    if(!SV.step(st, SV.encMove(card, pass))) return false;
    SVB.clearSel();
    if(pass) Sound.takeback(); else Sound.place();
    paint();
    if(st.over){ finish(); return true; }
    if(st.turn !== ME) aiTurn();
    else { busy = false; Sound.turn(); paint(); }
    return true;
  }

  function tap(card){
    if(!active) return;
    if(over){ showToast("這局已經結束了"); return; }
    if(busy || st.turn !== ME){ showToast("還沒輪到你"); return; }
    const can = SV.legal(st.hands[ME], st.tracks);
    if(can.length){
      if(can.indexOf(card) < 0){ showToast(SV.whyNot(card, st.tracks)); return; }
      // ★ 飛牌的出發點只有這一刻量得到(送出去之後手牌就重畫了)—— 見 board.js armFly()
      SVB.armFly(card);
      commit(card, false);
    }else{
      // 蓋牌是兩段式:先選,再按「確定蓋掉」
      SVB.setSel(SVB.sel() === card ? -1 : card);
      paint();
    }
  }
  function act(a){
    if(a !== "cover" || !active || over) return;
    const c = SVB.sel();
    if(c < 0){ showToast("先點一張要蓋掉的牌"); return; }
    commit(c, true);
  }

  /* ---------- 電腦這一手 ----------
     ⚠ 一定要有可見的思考時間:算完只花 1ms 的話,三家會在同一格瞬間打完,
       玩家看到的是「我一出牌畫面就整個變了」,根本讀不出剛才發生什麼事。 */
  function aiTurn(){
    if(!active || over) return;
    busy = true;
    paint();
    later(() => {
      if(st.turn === ME || st.over) { busy = false; paint(); return; }
      const seat = st.turn;
      const v = SVAI.viewOf(st, seat);
      let a = null;
      try{ a = SVAI.pickTurn(v, level); }catch(e){ a = null; }
      // 保險:AI 出了任何意外都不能讓遊戲卡住 —— 退回「照規則自己挑一手」
      if(!a || !SV.step(st, SV.encMove(a.card, a.act === "pass"))){
        const can = SV.legal(st.hands[seat], st.tracks);
        const mv = can.length ? SV.encMove(can[0], false) : SV.encMove(st.hands[seat][0], true);
        if(!SV.step(st, mv)){ busy = false; return; }
        a = { act: can.length ? "play" : "pass", card: SV.moveCard(mv) };
      }
      if(a.act === "pass"){
        Sound.takeback();
        showToast(seatName(seat) + " 沒牌可出,蓋掉一張", 1100);
      }else{
        Sound.place();
      }
      paint();
      if(st.over){ finish(); return; }
      if(st.turn !== ME) aiTurn();
      else { busy = false; Sound.turn(); paint(); }
    }, SVAI.thinkMs(level));
  }

  /* ---------- 結算 ---------- */
  function finish(){
    over = true; busy = false;
    bumpGen();
    const sc = SV.score(st);
    const mine = sc.rows[ME], iWon = sc.winners.indexOf(ME) >= 0;
    const r = recOf(level);
    r.n++; if(iWon) r.w++;
    rec[level] = r;
    saveOwn();
    paint();

    const card = $("svWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(iWon ? "win" : "lose"); }
    $("winWord").textContent = iWon ? "你贏了!" : ("第 " + mine.rank + " 名");
    const lv = SVAI.levelOf(level);
    /* ★ 結果卡整合(v1.75.3):大字底下只留**一句**「這局誰贏、我幾分」,
       「人數 · 難度 · 戰績」那些局外資訊降級到排名表尾巴(第三個參數)。
       舊版是大字 + 兩行小字 + 排名表,而排名表的「我那一列」本來就寫著同一組數字 ——
       同一件事講三次正是使用者說的「資訊相當得亂」。
       ⚠ 這句的措辭與連線那份(adapter 的 outcome())刻意寫成同一個格式。 */
    $("winMsg").innerHTML = iWon
      ? (mine.cnt ? ("罰分 <b>" + mine.pts + "</b> · 全場最少 🎉") : "你一張都沒蓋掉,滿分過關 ✨")
      // ⚠ 並列第一要全部列出來(三層 tie-break 都同分時 winners 不只一個)
      : (sc.winners.map(s => esc(seatName(s))).join("、") + " 罰分最少 · 你 <b>" + mine.pts + "</b> 分");
    const box = $("svResult");
    if(box){
      box.innerHTML = SVB.resultHTML(st, names, ME,
        seats + " 人 · " + lv.emoji + lv.name + " · 戰績 " + recText(level));
      box.classList.remove("hidden");
    }
    if(iWon){ Sound.win(); burst(); }
    else Sound.lose();
    showResult();
  }

  return {
    start, quit, again, tap, act, loadOwn, paintBar,
    active: () => active,
    playing: () => active && !over,          // 給更新檢查:局中重載會把整局丟掉
    level: () => level, seats: () => seats,
    recText, recLine,
    setLevel(v){ if(SVAI.LEVELS[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(v >= SV.MIN_PLAYERS && v <= SV.MAX_PLAYERS){ seats = v; saveOwn(); } },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    _st: () => st
  };
})();

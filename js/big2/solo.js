"use strict";

/* ============================================================================
   大老二 — 電腦對決(單機)

   與連線對戰共用同一組盤面(B2B)、同一條動作列(#b2Acts)、同一張結果卡
   (#veil / .b2-win),差別只在上面那條列與結果卡的按鈕組 —— 靠 body 的
   solo-on class 切換(與其他六個遊戲同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相只有這裡的 `st`(B2.replay 的狀態)。

   ⚠⚠ 電腦的每一個動作都要走帶世代記號的 later() —— 台灣麻將與排七都踩過
      「離場後電腦繼續打牌」那個坑([notes/12](../../notes/12-台灣麻將電腦對手.md) 第六節):
      quit() 只把 active 設成 false 的話,已經排進 setTimeout 的那一手照樣會跑,
      而那時 st 可能已經是下一局的了。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;                                  // 我固定坐 0 號位(先手由誰持 ♣3 決定)
  const NAMES = ["你", "小二", "阿順", "老葫"];
  const OWN_KEY = "big2.solo.v1";

  let level = "mid", seats = 4;
  let st = null, names = [];
  let active = false, over = false, busy = false;
  let gen = 0;                                   // 世代記號:離場 / 換局後,舊的 timer 一律不執行
  /* 第幾局。★ 只在 start() 進位,**刻意不共用 gen** —— gen 在 quit() 與 finish() 也會進,
     而那兩個時機把玩家自己拖好的手牌順序重排一次(結算時整副牌會跳一下)是沒有理由的。
     用途只有一個:讓盤面知道「換局了,自訂順序丟掉」(見 board.js 第八節)。 */
  let round = 0;
  let rec = {};

  /* ---------- 偏好與戰績 ----------
     刻意與連線那組分開存:連線的設定是「房主替全房選的」,和自己想單練哪一級是兩回事
     (比照 gomoku.solo.v1 / sudoku.solo.v1 / sevens.solo.v1)。 */
  function blank(){ return { w: 0, n: 0, p: 0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(B2AI.LEVEL_INFO[o.level]) level = o.level;
      if(o.seats >= B2.MIN_PLAYERS && o.seats <= B2.MAX_PLAYERS) seats = o.seats;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    B2AI.LEVEL_KEYS.forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, seats, rec })); }catch(e){}
  }
  function recOf(k){ const r = rec[k] || blank(); if(typeof r.p !== "number") r.p = 0; return r; }
  function recText(k){
    const r = recOf(k);
    return r.n ? (r.n + " 局 " + r.w + " 勝 · 共 " + r.p + " 分") : "尚無戰績";
  }
  function recLine(k){
    const r = recOf(k);
    return r.n ? ("你在這個難度打過 " + r.n + " 局,拿下第一名 " + r.w + " 次,累積 " + r.p + " 名次分")
               : "還沒跟這個難度玩過";
  }

  /* ---------- 世代記號 ---------- */
  function later(fn, ms){
    const g = gen;
    setTimeout(() => { if(g === gen && active && !over) fn(); }, ms);
  }
  function bumpGen(){ gen++; }

  /* ---------- 畫面 ---------- */
  function seatName(s){ return names[s] || NAMES[s] || ("玩家" + (s + 1)); }

  /* 單機的玩家列。★ 沿用房間框那組 .mp-chip / .b2-room 的外觀 —— 連線與單機長得一樣才有一致感。
     ★★ 牌情紅線的落地點之一:對手只給**張數**(.b2-chn),絕不畫牌面。
        出完的人掛 .out + 名次徽章 —— 那是公開資訊(大家都看到他打完了)。 */
  function paintBar(){
    const box = $("b2SoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      /* ★ 「拉」= 剩最後一手(v1.81.0)。判斷在規則層(B2.laSeats),記號的 HTML 在
         board.js(B2B.laChipHTML)—— 連線的 chipTail() 吃的是**同兩支**,
         這一對雙胞胎因此只差「去哪裡拿座位」。 */
      const la = st ? B2.laSeats(st) : [];
      let h = "";
      for(let s = 0; s < seats; s++){
        const isTurn = !!(st && !st.over && !over && st.turn === s);
        const n = st ? st.hands[s].length : 0;
        const fin = st ? st.finished.indexOf(s) : -1;
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") +
                (n === 0 && st ? " out" : "") + '">' +
               '<span class="b2-seat p' + s + '"></span>' +
               '<span class="gmk-nm">' + esc(seatName(s)) + '</span>' +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               (n === 0 && fin >= 0
                 ? '<span class="b2-chf" title="已經出完">第 ' + (fin + 1) + ' 名</span>'
                 : B2B.laChipHTML(la[s], s === ME) +
                   '<span class="b2-chn" title="手上剩幾張"><i class="b2-pip"></i>' + n + '</span>') +
             '</div>';
      }
      box.innerHTML = h;
    }
    const lv = $("b2SoloLv");
    if(lv) lv.textContent = B2AI.levelOf(level).name;
    const r = $("b2SoloRec");
    /* ⚠ 圖示用 🎴(U+1F3B4)。**不可以用小丑牌那個 emoji(U+1F0CF)** —— 它落在
       U+1F0A0–U+1F0FF 那段撲克牌字元裡,多數字型沒有、會變豆腐方框
       (CLAUDE.md 的禁令;這一條是單機 e2e 的 L 節當場抓出來的)。 */
    if(r) r.textContent = "🎴 " + seats + " 人 · " + recText(level);
  }

  function paint(){
    if(!st) return;
    paintBar();
    const mine = st.turn === ME && !over && !busy;
    const nms = [];
    for(let s = 0; s < seats; s++) nms.push(seatName(s));
    /* ★ 「拉」的公告(v1.81.0)。走 diff 而不是在出牌那一點插一行 ——
       ① 同一個理由與音效那條規矩一樣(台灣麻將 notes/11 第三節)
       ② 這一份與連線共用,而連線那邊只有 diff 拿得到「剛剛才變成拉」。
       ⚠ key 要與 render() 那個 key 同一個字串:換局時它負責把上一局的記錄清掉。 */
    B2B.announceLa({ st: st, names: nms, me: ME, key: "solo:" + round });
    /* ★ 手牌要亮哪幾張 / 有沒有牌可出:規則層算(B2.playable),連線那份逐字一樣。
       ⚠ 只在**輪到我**時算 —— 輪到對手時亮暗沒有意義,而且那是每次重畫都要跑的
         枚舉(26 張手牌約 2ms),沒必要白跑。 */
    const po = mine ? B2.playable(st.hands[ME], st, B2B.sel()) : null;
    B2B.render({
      hand: st.hands[ME].slice(),
      slots: B2.dealCounts(seats)[ME],      // ★ 固定格位吃**開局張數**(見 board.js 第三節)
      trick: st.trick, names: nms, opened: st.opened,
      mine: mine,
      turnName: st.over ? "" : seatName(st.turn),
      over: over,
      hot: po ? po.cards : null,
      key: "solo:" + round          // ★ 換局才變 → 盤面照它丟掉玩家自訂的手牌順序
    });
    B2B.renderActs({
      mine: mine,
      over: over,
      turnName: st.over ? "" : seatName(st.turn),
      lead: !st.cur,
      canPass: !!st.cur,
      noPlay: !!(po && !po.can),
      // ⚠ 要把手牌一起傳進去:「還要再選幾張」算得出來全靠它(見 board.js selInfoOf)
      selInfo: mine ? B2B.selInfoOf(st, st.hands[ME]) : null
      // 單機不做倒數 —— 卡多久是自己的節奏(同排七 / 消消樂的僵局時鐘不套單機)
    });
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    bumpGen();
    round++;                                   // ★ 新的一局 → 手牌回到照牌力排(見上)
    st = B2.replay(B2.newDeal(), seats, []);
    names = [];
    for(let s = 0; s < seats; s++) names.push(NAMES[s]);
    over = false; busy = false; active = true;
    B2B.clearSel();
    closeWin();
    showScreen("solo");
    paint();
    Sound.start();
    saveOwn();
    showToast("拿到 " + B2.nameOf(B2.CLUB3) + " 的是 " + seatName(st.turn) + ",第一手一定要帶它", 2200);
    if(st.turn !== ME) aiTurn();
  }
  function quit(){
    bumpGen();
    active = false; over = false; busy = false; st = null;
    B2B.clearSel(); B2B.stopCd();
    closeWin();
    showScreen("home");
    showHomeLayer("solo");        // 回到「電腦對決」那一層,方便換難度再來
  }
  function again(){ closeWin(); start(); }

  /* ---------- 出牌 / Pass ---------- */
  function commit(mv){
    if(!B2.step(st, mv)) return false;
    B2B.clearSel();
    if(B2.isPass(mv)) Sound.takeback(); else Sound.place();
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
    /* ★★ 沒亮的牌不給選(v1.79.1)。使用者:「沒亮的就不應該讓人選」。
       ⚠ 但**一定要說出原因** —— CLAUDE.md 的紅線是「不用 disabled 讓牌**靜默**
         吃掉點擊」:不給選可以,靜默不行。判斷放規則層(連線那支逐字一樣)。 */
    const why = B2.whyNotPick(st.hands[ME], st, B2B.sel(), card);
    if(why){ showToast(why, 2000); return; }
    B2B.toggleSel(card);
    paint();
  }

  function act(a){
    if(!active || over) return;
    if(busy || st.turn !== ME){ showToast("還沒輪到你"); return; }
    if(a === "clear"){ B2B.clearSel(); paint(); return; }
    if(a === "pass"){
      // ★ 領出的人不能 pass —— 規則層也擋,這裡先給得出原因
      if(!st.cur){ showToast("這一輪由你開始,一定要出牌"); return; }
      commit(B2.PASS);
      return;
    }
    if(a !== "play") return;
    const cs = B2B.sel();
    if(!cs.length){ showToast("先點要出的牌"); return; }
    const why = B2.whyNot(cs, st);
    if(why){ showToast(why, 2400); return; }
    commit(B2.encMove(cs));
  }

  /* ⚠ v1.77.0 拿掉了「幫我挑」(舊版從 B2.playsBeating() 挑一組幫他選上、只選不出)。
     使用者:「幫我選那個功能拿掉,我覺得很奇怪」—— 它既不是提示也不是代打,定位尷尬。
     ★ 托管明確**先不做**;要補的話請整支做成托管,不要把那顆鈕加回來。
     ★ B2.playsBeating() 本身留著 —— AI 與到期代打(B2AI.autoMove)都靠它。 */

  /* ---------- 電腦這一手 ----------
     ⚠ 一定要有可見的思考時間:算完只花 1ms 的話,三家會在同一格瞬間打完,
       玩家看到的是「我一出牌畫面就整個變了」,根本讀不出剛才發生什麼事。 */
  function aiTurn(){
    if(!active || over) return;
    busy = true;
    paint();
    later(() => {
      if(st.turn === ME || st.over){ busy = false; paint(); return; }
      const seat = st.turn;
      let mv = null;
      try{ mv = B2AI.pick(st, seat, level); }catch(e){ mv = null; }
      // 保險:AI 出了任何意外都不能讓遊戲卡住 —— 退回「照規則自己挑一手」
      if(!mv || !B2.step(st, mv)){
        const cs = B2.playsBeating(st.hands[seat], st.cur ? st.cur.cls : null);
        const ok = st.opened ? cs : cs.filter(p => p.cards.indexOf(B2.CLUB3) >= 0);
        const fb = ok.length ? B2.encMove(ok[0].cards) : B2.PASS;
        if(!B2.step(st, fb)){ busy = false; paint(); return; }
        mv = fb;
      }
      if(B2.isPass(mv)){
        Sound.takeback();
        showToast(seatName(seat) + " 不要(Pass)", 1000);
      }else{
        Sound.place();
        const cls = B2.classify(B2.decMove(mv));
        if(cls && B2.isBomb(cls.t)) showToast(seatName(seat) + " 出了" + B2.T_NAME[cls.t] + "!", 1600);
        if(!st.hands[seat].length) showToast(seatName(seat) + " 把牌出完了", 1600);
      }
      paint();
      if(st.over){ finish(); return; }
      if(st.turn !== ME) aiTurn();
      else { busy = false; Sound.turn(); paint(); }
    }, B2AI.thinkMs(level));
  }

  /* ---------- 結算 ---------- */
  function finish(){
    over = true; busy = false;
    bumpGen();
    const sc = B2.score(st);
    const mine = sc.rows[ME], iWon = sc.winners.indexOf(ME) >= 0;
    const r = recOf(level);
    r.n++; if(iWon) r.w++; r.p += mine.pts;
    rec[level] = r;
    saveOwn();
    paint();

    const card = $("b2WinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(iWon ? "win" : "lose"); }
    $("winWord").textContent = iWon ? "你贏了!" : ("第 " + mine.rank + " 名");
    const lv = B2AI.levelOf(level);
    /* ★ 結果卡整合(照排七 v1.75.3 的結論):大字底下只留**一句**「這局誰贏、我幾分」,
       「人數 · 難度 · 戰績」那些局外資訊降級到排名表尾巴(第三個參數)。
       同一件事講三次(大字 / 小字 / 排名表我那一列)正是使用者說過的「資訊相當得亂」。
       ⚠ 這句的措辭與連線那份(adapter 的 outcome())刻意寫成同一個格式 ——
         兩份走鐘的話沒有東西抓得到。 */
    $("winMsg").innerHTML = iWon
      ? ("你第一個出完 · 名次分 <b>" + mine.pts + "</b> 🎉")
      : (esc(seatName(sc.winners[0])) + " 第一個出完 · 你 <b>" + mine.pts + "</b> 分" +
         (mine.left ? ("(手上還剩 " + mine.left + " 張)") : ""));
    const box = $("b2Result");
    if(box){
      box.innerHTML = B2B.resultHTML(st, names, ME,
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
    setLevel(v){ if(B2AI.LEVEL_INFO[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(v >= B2.MIN_PLAYERS && v <= B2.MAX_PLAYERS){ seats = v; saveOwn(); } },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    _st: () => st
  };
})();

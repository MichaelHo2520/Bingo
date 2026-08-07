"use strict";

/* ============================================================================
   UNO — 電腦對決(單機)

   與連線對戰共用同一組盤面(UNB)、同一條動作列(#unActs)、同一張結果卡
   (#veil / .un-win),差別只在上面那條列與結果卡的按鈕組 —— 靠 body 的
   solo-on class 切換(與其他八個遊戲同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相只有這裡的 `st`(UN.replay 的狀態)。

   ⚠⚠ 電腦的每一個動作都要走帶世代記號的 later() —— 台灣麻將與排七都踩過
      「離場後電腦繼續打牌」那個坑(notes/12 第六節):
      quit() 只把 active 設成 false 的話,已經排進 setTimeout 的那一手照樣會跑,
      而那時 st 可能已經是下一局的了。

   ── ★ UNO 多一件別的遊戲沒有的事:**選色是兩段式的** ──────────────────────
     出 Wild 要先選顏色 → 這一手在「玩家點了牌」與「真的 step 進去」之間有一個
     等待使用者的空檔。那個空檔一定要**擋住其他操作**(pendWild),不然玩家可以
     在選色盤開著的時候再點一張牌 → 兩手都送進去 = 局面錯亂。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;                                  // 我固定坐 0 號位
  const NAMES = ["你", "小紅", "阿黃", "小綠", "老藍", "阿彩"];
  const OWN_KEY = "uno.solo.v1";

  let level = "mid", seats = 4;
  /* ★ 單機這一份房規是「我自己想怎麼玩」,與連線那份(房主替全房選的)刻意分開存
     —— 同 level / seats 的理由。⚠ 一律經過 UN.normRules(白名單守門)。 */
  let rules = UN.defRules();
  let st = null, names = [];
  let active = false, over = false, busy = false;
  let gen = 0;                                   // 世代記號:離場 / 換局後,舊的 timer 一律不執行
  let round = 0;                                 // 第幾局(給盤面的 announce key 用)
  let rec = {};
  /* ★ UNO! 這一手要不要喊(玩家在動作列按下的切換)。
     ⚠ 每出一手就歸零 —— 它是「這一手」的旗標,不是持續狀態。 */
  let unoArmed = false;
  let pendWild = -1;                             // 正在等選色的那張牌(-1 = 沒有)

  /* ---------- 偏好與戰績 ---------- */
  function blank(){ return { w: 0, n: 0, p: 0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(UNAI.LEVEL_INFO[o.level]) level = o.level;
      if(o.seats >= UN.MIN_PLAYERS && o.seats <= UN.MAX_PLAYERS) seats = o.seats;
      rules = UN.normRules(o.rules);
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    UNAI.LEVEL_KEYS.forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, seats, rec, rules })); }catch(e){}
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

  /* 單機的玩家列。★ 沿用房間框那組 .mp-chip / .un-room 的外觀。
     ★★ 牌情紅線的落地點之一:對手只給**張數**(.un-chn),絕不畫牌面。
        「還剩一張」是唯一的豁免(只有一個 bit)。 */
  function paintBar(){
    const box = $("unSoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      let h = "";
      for(let s = 0; s < seats; s++){
        const isTurn = !!(st && !st.over && !over && st.turn === s);
        const n = st ? st.hands[s].length : 0;
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") +
                (n === 0 && st ? " out" : "") + '">' +
               '<span class="gmk-nm">' + esc(seatName(s)) + '</span>' +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               (n === 1 ? '<span class="un-chu" title="還剩一張">UNO</span>' : "") +
               '<span class="un-chn" title="手上剩幾張"><i class="un-pip"></i>' + n + '</span>' +
             '</div>';
      }
      box.innerHTML = h;
    }
    const lv = $("unSoloLv");
    if(lv) lv.textContent = UNAI.levelOf(level).name;
    const r = $("unSoloRec");
    /* ⚠ 圖示用 🌈(U+1F308)—— 與首頁 home-live 那一列同一顆。
       **不可以用 🃏**(U+1F0CF):它落在 U+1F0A0–U+1F0FF 那段撲克牌字元裡,
       多數字型沒有、會變豆腐方框(CLAUDE.md 的禁令)。 */
    if(r) r.textContent = "🌈 " + seats + " 人 · " + recText(level);
  }

  function paint(){
    if(!st) return;
    paintBar();
    /* ★ 「喊過 UNO」只在**手上剛好 2 張**的那一手有意義 —— 手牌一變就自動歸零。
       ⚠ 沒有這一行的話:武裝之後被跳過 / 被罰抽,旗標會一路留到下一次剛好 2 張的
         時候,畫面顯示「喊過了」但玩家根本沒按過(而鈕已經收掉了,他也補不了)。 */
    if(st.hands[ME].length !== 2) unoArmed = false;
    const mine = st.turn === ME && !over && !busy && pendWild < 0;
    const nms = [];
    for(let s = 0; s < seats; s++) nms.push(seatName(s));
    const hot = mine ? UN.playable(st.hands[ME], st) : [];
    UNB.render({
      hand: st.hands[ME].slice(),
      top: st.top, col: st.col, dir: st.dir, pend: st.pend, stack: st.rules.stack,
      n: seats,                                   // ★ 2 人局不畫方向(見 board 的 tableHTML)
      pileLeft: st.pile.length, discLeft: st.disc.length,
      mine: mine, over: over,
      turnName: st.over ? "" : seatName(st.turn),
      hot: hot, drew: st.drew, drewCard: st.drewCard,
      key: "solo:" + round
    });
    UNB.renderActs({
      mine: mine, over: over,
      turnName: st.over ? "" : seatName(st.turn),
      drew: st.drew,
      noPlay: mine && !hot.length,
      handLen: st.hands[ME].length,
      /* ★ 房規 toLast 開著才有這一格:我出完了、牌局還在打(見 board 的 renderActs)。 */
      iAmOut: !over && !st.over && st.hands[ME].length === 0,
      unoOn: unoArmed, unoRule: st.rules.unoCall,
      // ★ 抓鈕:不分回合(視窗是「下一家出手之前」)。單機時我可以抓電腦。
      catchName: (st.rules.unoCall && st.catchSeat >= 0 && st.catchSeat !== ME && !over)
                   ? seatName(st.catchSeat) : ""
      // 單機不做倒數 —— 卡多久是自己的節奏(同其他遊戲)
    });
    /* ★ 「還剩一張」的公告走 diff(UNB.announce)—— 與連線共用同一支。
       ⚠ key 要與 render() 那個同一個字串:換局時它負責把上一局的記錄清掉。 */
    UNB.announce({ left: st.hands.map(h => h.length), names: nms, me: ME, key: "solo:" + round });
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    bumpGen();
    round++;
    /* ⚠⚠ 房規要在**開局那一刻**進 st(replay 會 normRules 一次凍在 st.rules)——
       之後面板怎麼改都不影響這一局(同大老二 / 21點的「開局凍結」)。 */
    st = UN.replay(UN.newDeal(), seats, [], rules);
    names = [];
    for(let s = 0; s < seats; s++) names.push(NAMES[s]);
    over = false; busy = false; active = true;
    unoArmed = false; pendWild = -1;
    UNB.resetAnnounce();
    UNB.closeColor();
    closeWin();
    showScreen("solo");
    paint();
    Sound.start();
    /* ★ 語音音檔先載好(v1.117.0)—— 語音槽沒有合成音後備,懶載入的話「這一局第一次
       喊 UNO / 第一次 +2」永遠沒聲音。這裡是 `開始對局` 那顆鈕點下來的路徑 =
       一定有使用者手勢,正是 primeVoice 要的時機(見 board.js 那一段)。 */
    UNB.primeVoice();
    saveOwn();
    // ★ 起始牌就攤在桌上,不必再唸一次 —— 只講「誰先出」這件看不出來的事
    showToast(st.turn === ME ? "你先出牌" : (seatName(st.turn) + " 先出牌"), 1500);
    if(st.turn !== ME) aiTurn();
  }
  function quit(){
    bumpGen();
    active = false; over = false; busy = false; st = null;
    unoArmed = false; pendWild = -1;
    UNB.stopCd(); UNB.closeColor(); UNB.resetAnnounce();
    closeWin();
    showScreen("home");
    showHomeLayer("solo");        // 回到「電腦對決」那一層,方便換難度再來
  }
  function again(){ closeWin(); start(); }

  /* ---------- 我這一手 ---------- */
  function commit(mv){
    if(!UN.step(st, mv)) return false;
    unoArmed = false;                       // ★ 旗標只管這一手
    UNB.moveSfx(mv, seats);
    paint();
    if(st.over){ finish(); return true; }
    if(st.turn !== ME) aiTurn();
    else { busy = false; Sound.turn(); paint(); }
    return true;
  }

  /* 點一張牌 = 出那一張(UNO 沒有「選一組」這件事)。
     ★ Wild 要先選顏色 → 走 UNB.askColor 的 callback。
     ⚠ 連線那支(adapter 的 tap)**逐字一樣**:兩邊各寫一份遲早走鐘,
       而走鐘了兩邊各自都不會壞、沒有東西抓得到。 */
  function tap(card){
    if(!active) return;
    if(over){ showToast("這局已經結束了"); return; }
    if(pendWild >= 0){ showToast("先選一個顏色"); return; }
    if(busy || st.turn !== ME){ showToast("還沒輪到你"); return; }
    if(!(card >= 0 && card < UN.NCARD)) return;
    if(st.hands[ME].indexOf(card) < 0) return;
    /* ★★ 沒亮的牌不給出,但**一定要說得出原因** ——
       CLAUDE.md 的紅線是「不用 disabled 讓牌**靜默**吃掉點擊」。 */
    if(!UN.legalOn(st, card)){ showToast(whyNot(card), 1800); return; }
    if(UN.isWild(card)){
      pendWild = card;
      paint();                              // 選色盤開著時手牌要變成不能點
      UNB.askColor(col => {
        const c = pendWild;
        pendWild = -1;                        // ★ 一定要先清 —— 它是「手牌能不能點」的閘門
        if(c < 0 || !active || over){ paint(); return; }
        // ★ col < 0 = 取消(按了返回鍵 / 點了蓋板外框)→ 那一手 Wild 不算,牌回到手上
        if(col < 0){ showToast("取消了", 1200); paint(); return; }
        commit(UN.encPlay(c, col, unoArmed && st.hands[ME].length === 2));
      });
      return;
    }
    commit(UN.encPlay(card, 0, unoArmed && st.hands[ME].length === 2));
  }

  /* 為什麼這張出不了 —— 講得出**具體**的原因,但一句就好(v1.108.0 全部砍到半行:
     原本每一句都是「你頭上有 N 張罰抽,手上沒有同種牌能疊 —— 只能按「抽一張」把它吃下來」
     這種說明書口氣,而 toast 只閃兩秒,沒人讀得完)。
     ⚠ 三種情形仍然要分開講:罰抽在頭上 / 抽完只能出抽到那張 / 顏色數字都不對。 */
  function whyNot(card){
    if(st.pend > 0){
      if(!st.rules.stack) return "被罰抽 " + st.pend + " 張 —— 只能抽";
      /* ★ 手上如果還有別的同種牌能疊,強制出牌就輪到那一條 —— 不能靠抽來吃掉罰抽。 */
      return UN.canPlay(st.hands[ME], st)
        ? ("要用 " + (st.pendK === UN.K_W4 ? "+4" : "+2") + " 疊上去")
        : ("疊不上 —— 只能抽 " + st.pend + " 張");
    }
    if(st.drew) return "只能出剛抽到的那張";
    return "要出 " + (UN.COL_NAME[st.col] || "") + " 色、同數字,或 Wild";
  }

  function act(a){
    if(!active || over) return;
    if(a === "catch"){ doCatch(); return; }
    if(pendWild >= 0){ showToast("先選一個顏色"); return; }
    if(busy || st.turn !== ME){ showToast("還沒輪到你"); return; }
    if(a === "uno"){
      /* ★ UNO 要在**出牌前**先喊(宣告與出牌必須是同一手,見 rules.js 第五節)。
         ★★ **一按就定案,不是切換**(v1.109.0)—— 使用者:「應該要按完就不見,
            而不是在那邊不小心按一下又取消掉」。喊了不會讓自己吃虧,所以「取消」
            這個動作只有壞處。⚠ 連線那支(adapter 的 act)逐字一樣。 */
      if(st.hands[ME].length !== 2){ showToast("剩兩張時才用得到", 1500); return; }
      if(unoArmed) return;                  // 已經喊過 → 什麼都不做(鈕本來也收掉了)
      unoArmed = true;
      UNB.sfx.uno();
      paint();
      return;
    }
    if(a === "draw"){
      /* ★★ 手上有合法牌可出時不准抽(強制出牌,見 rules.js 的 doDraw)——
         按鈕在這個狀態下本來就不畫,但牌堆圖示(#unDraw)一直可以點,
         誤按要跳 toast 講原因,不能讓 commit() 就地靜默失敗。 */
      if(UN.canPlay(st.hands[ME], st)){ showToast("有牌可以出,不能抽", 1600); return; }
      commit(UN.DRAW);
      return;
    }
    if(a === "pass"){
      if(!st.drew){ showToast("先抽一張"); return; }
      commit(UN.PASS);
      return;
    }
  }

  /* 抓漏喊 UNO 的人。★ 不分回合 —— 視窗由規則層管(st.catchSeat)。 */
  function doCatch(){
    if(!st || over || !st.rules.unoCall) return;
    const t = st.catchSeat;
    if(t < 0 || t === ME){ showToast("沒人可以抓"); return; }
    const nm = seatName(t);
    if(!UN.step(st, UN.encCatch(ME, t))){ showToast("來不及了"); return; }
    UNB.sfx.caught();
    showToast("抓到 " + nm + "!罰抽 2 張", 1800);
    paint();
  }

  /* ---------- 電腦這一手 ----------
     ⚠ 一定要有可見的思考時間:算完只花 1ms 的話,幾家會在同一格瞬間打完,
       玩家看到的是「我一出牌畫面就整個變了」,根本讀不出剛才發生什麼事。 */
  function aiTurn(){
    if(!active || over) return;
    busy = true;
    paint();
    later(() => {
      /* ★ 先讓電腦有機會抓人(抓不分回合,而且視窗只到下一個 p/d 之前)。
         ⚠ 順序一定是「抓」在「出」之前 —— 反過來的話出牌會把視窗關掉,
           電腦永遠抓不到人(而玩家會覺得漏喊 UNO 完全沒有代價)。 */
      if(st.catchSeat >= 0 && st.catchSeat !== st.turn) aiTryCatch();
      if(st.turn === ME || st.over){ busy = false; paint(); return; }
      const seat = st.turn;
      let mv = null;
      try{ mv = UNAI.pick(st, seat, level); }catch(e){ mv = null; }
      // 保險:AI 出了任何意外都不能讓遊戲卡住 —— 退回「照規則自己挑一手」
      if(!mv || !UN.step(st, mv)){
        const pl = UN.playable(st.hands[seat], st);
        const fb = pl.length ? UN.encPlay(pl[0], UNAI.bestColor(st.hands[seat]), st.hands[seat].length === 2)
                             : (st.drew ? UN.PASS : UN.DRAW);
        if(!UN.step(st, fb)){ busy = false; paint(); return; }
        mv = fb;
      }
      UNB.moveSfx(mv, seats);
      announceAi(seat, mv);
      paint();
      if(st.over){ finish(); return; }
      if(st.turn !== ME) aiTurn();
      else { busy = false; Sound.turn(); paint(); }
    }, UNAI.thinkMs(level));
  }

  /* 電腦要不要抓人(easy 不抓 / mid 一半 / hard 一定抓 —— 那一格才是難度) */
  function aiTryCatch(){
    const target = st.catchSeat;
    for(let s = 0; s < seats; s++){
      if(s === ME || s === target) continue;
      let cm = null;
      try{ cm = UNAI.catchMove(st, s, level); }catch(e){ cm = null; }
      if(cm && UN.step(st, cm)){
        UNB.sfx.caught();
        showToast(seatName(s) + " 抓到" + (target === ME ? "你" : seatName(target)) +
                  "!罰抽 2 張", 1800);
        return;
      }
    }
  }

  /* 電腦這一手要不要出聲說明。
     ★★ v1.108.0 砍到只剩**兩件事**:換了顏色、砸了罰抽 —— 而且都只有半句。
        原本連「跳過了下一家」「迴轉」「喊了 UNO!」「把牌出完了」都各跳一次 toast,
        四人局等於每一手都有字飛出來,玩家的回報是「話太多」。砍掉的那四句都有別的
        管道說完了:
          跳過 / 迴轉 → 有專屬音效,而且方向與輪到誰在畫面上一直看得到
          喊 UNO      → UNB.announce() 已經跳過一次「X 剩一張牌!」(重複了)
          出完了      → 下一秒就是結果卡
        留下來的兩件事是**畫面上真的看不出來**的:Wild 換成什麼色(牌是黑的)、
        罰抽砸到誰頭上(桌上只寫數字,不寫誰砸的)。 */
  function announceAi(seat, mv){
    const nm = seatName(seat);
    if(UN.isDraw(mv)) return;                       // 抽牌有音效,不必再講
    const id = UN.moveCard(mv);
    if(id < 0) return;
    const k = UN.kindOf(id);
    const col = UN.COL_NAME[st.col] || "";
    if(k === UN.K_W4) showToast(nm + " 出 +4,換 " + col + " 色", 1600);
    else if(k === UN.K_WILD) showToast(nm + " 換 " + col + " 色", 1400);
    else if(k === UN.K_D2) showToast(nm + " 出 +2", 1400);
  }

  /* ---------- 結算 ---------- */
  function finish(){
    over = true; busy = false; pendWild = -1;
    bumpGen();
    UNB.closeColor();
    const sc = UN.score(st);
    const mine = sc.rows[ME], iWon = (st.winner === ME);
    const r = recOf(level);
    r.n++; if(iWon) r.w++; r.p += mine.rp;
    rec[level] = r;
    saveOwn();
    paint();

    const card = $("unWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(iWon ? "win" : "lose"); }
    $("winWord").textContent = iWon ? "你贏了!" : ("第 " + mine.rank + " 名");
    /* ★ 大字底下只留**一句**「這局誰贏、我幾分」——「人數 · 難度 · 戰績」那些局外資訊
       降級到排名表尾巴。同一件事講三次正是使用者說過的「資訊相當得亂」。
       ⚠ 這句的措辭與連線那份(adapter 的 outcome())刻意寫成同一個格式。 */
    $("winMsg").innerHTML = iWon
      ? ("你第一個出完 · 名次分 <b>" + mine.rp + "</b> 🎉")
      : (esc(seatName(st.winner)) + " 第一個出完 · 你 <b>" + mine.rp + "</b> 分" +
         (mine.left ? ("(手上還剩 " + mine.left + " 張 · " + mine.pts + " 點)") : ""));
    const box = $("unResult");
    if(box){
      box.innerHTML = UNB.resultHTML(st, names, ME, null);
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
    setLevel(v){ if(UNAI.LEVEL_INFO[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(v >= UN.MIN_PLAYERS && v <= UN.MAX_PLAYERS){ seats = v; saveOwn(); } },
    /* ---------- 房規:面板是單機連線共用的,分流點只有 main.js 那幾支 ----------
       ⚠ `rules()` 回**現在設定的那一份**(下一局才生效);對局中的真相在 `st.rules`。 */
    rules: () => UN.normRules(rules),
    setRule(key, val){
      rules = UN.normRules(Object.assign({}, rules, { [key]: val }));
      saveOwn();
    },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    _st: () => st,
    // 給 e2e 用:直接把選色盤的答案送進去(不必真的點四顆鈕)
    _pickColor(col){ UNB.pickColor(col); }
  };
})();

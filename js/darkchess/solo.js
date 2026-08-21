"use strict";

/* ============================================================================
   象棋暗棋 — 電腦對決(單機)

   與連線對戰共用同一個盤面(DCB)、同一張結果卡(#veil / .dc-win)、同一組房規面板,
   差別只在上面那條列與結果卡的按鈕組 —— 靠 body 的 solo-on class 切換
   (與其他八個遊戲同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相就是 { deal, moves },
     與連線那邊**同一個格式** —— 所以 DCB 與 DCAI 兩邊原樣共用。

   ★ 連吃在這裡有一個單機專屬的細節:**電腦連吃時要一步一步演** ——
     一次把整條鏈算完再畫,玩家只會看到「盤面忽然少了四顆子」。
     aiTurn() 因此是「走一手 → 如果還輪到它 → 排下一次」,而不是 while 迴圈。
   ========================================================================== */

const Solo = (function(){
  const AI_MIN_MS = 320;              // 電腦最快也要「想」這麼久:秒回會讓人以為是自己誤觸
  const AI_CHAIN_MS = 420;            // 連吃的每一步之間停這麼久(要看得見它在吃)

  let level = "mid", first = "me";    // first: me | ai | random
  let opponent = "ai";                // ai | friend(本機雙人,朋友坐旁邊輪流動同一支手機)
  let rules = DC.defRules();
  let deal = "", moves = [], st = null;
  let mySeat = 0, aiSeat = 1;
  let active = false, over = false, busy = false;
  let aiT = null;
  let rec = {};                       // 各難度戰績 { easy:{w,l,d}, ... }
  let friendRec = { [DC.RED]: 0, [DC.BLACK]: 0, d: 0 };   // 朋友模式:這一節的紅黑勝場 —— 不存 localStorage,重開 App 不留
  function isFriend(){ return opponent === "friend"; }

  /* ==========================================================================
     ★★★ 本機擂台(v2.7.1)—— 一支手機、3~6 個人排隊,贏的留台
     ──────────────────────────────────────────────────────────────────────────
       這一頁的 maxPlayers 是 **2**(十四個遊戲裡只有它與五子棋是兩人),所以派對現場
       四到六個人時,連線那條路只坐得下兩個。而**公園暗棋本來就是這樣玩的**:
       一群人圍著兩個人下,贏的留著、輸的換人。
       ★ 這一條的重點是它**完全不碰 js/shared/**(也不碰 DCB / DC / DCAI / adapter):
         只是在朋友模式上加「一份名單 + 一個輪替規則」。

     ⚠⚠ 它與 friendRec **是兩份值,不可以併**:
       friendRec 記的是**紅方 / 黑方**各贏幾場(紅線:每局誰紅誰黑是隨機翻出來的),
       擂台記的是**這個人**贏幾場 —— 兩件事。人數 = 2 時照舊只顯示 friendRec。
     ⚠ 先翻權給**挑戰者**:先手第一次翻到什麼顏色就是他的(很實在),
       而擂台上的擂主已經佔了「熟悉盤面」的便宜 —— 把先翻讓給上來的人比較公道。
     ⚠ 和局 → 兩個人都留台重打(不換人)。
     ⚠ 不進 localStorage:同 friendRec,「這一節在桌上」的計數,離桌歸零。 */
  let seats = 2;                      // 朋友模式的人數(2~6);= 2 就是原本的本機雙人
  let arena = null;                   // { t:[a,b], wait:[…], wins:{} };人數 2 時恆為 null
  function isArena(){ return isFriend() && seats > 2; }
  function pName(i){ return "P" + (i + 1); }
  function arenaReset(){
    if(!isArena()){ arena = null; return; }
    const all = [];
    for(let i = 0; i < seats; i++) all.push(i);
    arena = { t: [all[0], all[1]], wait: all.slice(2), wins: {} };
  }
  /* 一局結束之後輪替。wi = 贏的是座位 0 還是 1(-1 = 和局)。 */
  function arenaNext(wi){
    if(!arena) return;
    if(wi < 0) return;                                   // 和局:兩個都留台
    const w = arena.t[wi], l = arena.t[1 - wi];
    arena.wins[w] = (arena.wins[w] || 0) + 1;
    if(!arena.wait.length){ arena.t = [l, w]; return; }   // 只有兩個人在桌上 → 原班,換先翻
    const c = arena.wait.shift();
    arena.wait.push(l);
    arena.t = [c, w];                                    // ★ 挑戰者先翻(見上面的 ⚠)
  }
  function arenaText(){
    if(!arena) return "";
    const champ = arena.t[1], n = arena.wins[champ] || 0;
    return "擂台 " + pName(arena.t[0]) + " vs " + pName(champ) +
           (n ? ("(連 " + n + " 勝)") : "") +
           (arena.wait.length ? (" · 待場 " + arena.wait.map(pName).join(" ")) : "");
  }

  const LV = {
    easy: { key: "easy", emoji: "🙂", name: "新手", desc: "只挑眼前最大的子吃,不考慮被吃回去" },
    mid:  { key: "mid",  emoji: "🤔", name: "普通", desc: "會算一步,避開你吃得到的格子,翻棋也挑安全的" },
    hard: { key: "hard", emoji: "😈", name: "高手", desc: "會算兩步,並盤算 40 步後的階級總和" }
  };
  const levelOf = k => LV[k] || LV.mid;

  /* ---------- 偏好:單機設定與戰績獨立存 ----------
     刻意不與連線那份共用 —— 連線的房規是「房主替全房選的」,和自己想單練哪一組是兩回事
     (比照五子棋 gomoku.solo.v1 / 數獨 sudoku.solo.v1)。 */
  const OWN_KEY = "darkchess.solo.v1";
  const blank = () => ({ w: 0, l: 0, d: 0 });
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(LV[o.level]) level = o.level;
      if(["me", "ai", "random"].indexOf(o.first) >= 0) first = o.first;
      if(["ai", "friend"].indexOf(o.opponent) >= 0) opponent = o.opponent;
      if(typeof o.seats === "number" && o.seats >= 2 && o.seats <= 6) seats = o.seats | 0;
      /* ⚠ 一律過一次:舊版存的值可能認不得。⚠⚠ 而且走的是 **migRules** ——
         「對手吃子」的預設 v2.5.2 翻成開,舊偏好裡那一欄是明碼的 false(見 rules.js)。 */
      if(o.rules) rules = DC.migRules(o.rules, o.rulesV);
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    Object.keys(LV).forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, first, opponent, seats,
      rules: DC.normRules(rules), rulesV: DC.RULES_V, rec })); }catch(e){}
  }
  const recOf = k => rec[k] || blank();
  function recText(k){
    const r = recOf(k);
    if(!(r.w || r.l || r.d)) return "尚無戰績";
    return r.w + " 勝 " + r.l + " 敗" + (r.d ? (" " + r.d + " 和") : "");
  }
  function recLine(k){
    const r = recOf(k);
    return (r.w || r.l || r.d) ? ("此難度戰績 " + recText(k)) : "此難度尚無戰績";
  }
  function friendRecText(){
    const r = friendRec;
    if(!(r[DC.RED] || r[DC.BLACK] || r.d)) return "尚無戰績";
    return DC.sideName(DC.RED) + "方 " + (r[DC.RED] || 0) + " 勝 · " + DC.sideName(DC.BLACK) + "方 " + (r[DC.BLACK] || 0) + " 勝" + (r.d ? " · " + r.d + " 和" : "");
  }

  /* ---------- HUD ---------- */
  function chip(seat){
    const side = st ? st.col[seat] : -1;
    const left = (st && side >= 0) ? DC.countSide(st, side) : 16;
    const isMe = (seat === mySeat);
    /* ★ 擂台模式:晶片講的是**這個人是誰**(P3 vs P1),不是座位。
       擂主加一個 🔥 —— 那是這個模式唯一的戲。 */
    const champ = arena ? arena.t[1] : -1;
    const who = arena ? arena.t[seat] : -1;
    const nm = arena ? (pName(who) + (who === champ && (arena.wins[who] || 0) ? " 🔥" : ""))
                     : (isFriend() ? pName(seat)
                                   : (isMe ? "你" : (levelOf(level).emoji + " 電腦")));
    return '<div class="mp-chip' + (st && !st.over && st.turn === seat ? " turn" : "") + '">' +
             '<span class="nm">' + nm + "</span>" +
             (side >= 0 ? ('<span class="dc-chip-side ' + (side === DC.RED ? "dc-red-t" : "dc-blk-t") + '">' +
                           DC.sideName(side) + "</span>") : '<span class="dc-chip-side">?</span>') +
             '<span class="dc-chip-n" title="盤上還剩幾顆">' + left + "</span>" +
           "</div>";
  }
  function paintHud(){
    const lv = levelOf(level);
    const t = $("dcSoloLv");
    if(t) t.textContent = isArena() ? ("👥 擂台 " + seats + " 人")
                                    : (isFriend() ? "👤 本機雙人" : (lv.emoji + " " + lv.name));
    const r = $("dcSoloRec");
    if(r) r.textContent = arena ? arenaText() : (isFriend() ? friendRecText() : recText(level));
    const p = $("dcSoloPlayers");
    if(p) p.innerHTML = st ? (chip(0) + chip(1)) : "";
    /* ★ 擂台模式那顆鈕講的是「下一位上場」不是「再來一局」——
       ⚠ 掛在 paintHud 上(它每一次 paint 都跑)而不是「開結果卡」那個時機:
         結果卡出現的路徑有好幾條,每一條各補一次遲早會漏(同 board.js 的 syncRevealBtn)。 */
    const ag = $("dcSoloAgain");
    if(ag) ag.textContent = arena ? "下一位上場" : "再來一局";
  }
  /* ⚠⚠⚠ **paintHud() 一定要在 DCB.setState() 之前** —— 這不是排版潔癖:
     DCB 那一支會在 setState 裡量舞台高度算格子大小(fitBoard),而 paintHud 會把
     兩顆玩家晶片塞進 #dcSoloPlayers → 上面那條列**長高 34px** → 舞台矮 34px。
     順序反過來的話 fitBoard 量到的是「晶片還沒進版面」的舞台 → 算出大一號的格子 →
     **開局第一拍盤面溢出舞台**(被 overflow:hidden 靜靜削掉),然後靠 ResizeObserver
     在下一格補救。那個補救是會漏的:實測 e2e 有時候補得到、有時候整局都歪著
     (時而綠時而紅的那種 bug)。**量尺寸的那一步一律放最後。**
     ⚠ 連線那邊(adapter.js 的 paint)有一模一樣的一組,理由與寫法都相同。 */
  function paint(){
    if(!st) return;
    paintHud();
    const friend = isFriend();
    /* ★★ 朋友模式沒有固定的「我」:mySide 要跟著 st.turn 走(現在誰的回合就是誰的顏色),
       不然座位 1 那位朋友輪到自己時,mySide 還停在座位 0 的顏色,board.js 的點擊守衛
       (只准動 mySide 那色的子)會把他自己的子都擋成「那是對方的子」。 */
    DCB.setState({
      st: st,
      mySide: friend ? st.col[st.turn] : st.col[mySeat],
      mine: friend ? (active && !over && !busy) : (active && !over && !busy && st.turn === mySeat),
      over: over,
      key: moves.length,
      // ★ 吃子欄要知道「哪個座位是我」與兩個座位各叫什麼(見 board.js 的 setState)
      mySeat: mySeat,
      names: arena ? [pName(arena.t[0]), pName(arena.t[1])]
                   : (friend ? ["P1", "P2"] : (mySeat === 0 ? ["你", "電腦"] : ["電腦", "你"])),
      /* ★★ 棋譜回放(v2.7.1)要的整局真相 —— st 身上只有局面,沒有 deal / moves。
         ⚠ 這一行與 adapter.js 的 paint() 是**同一對雙胞胎**(紅線 12 那一組)。 */
      src: { deal: deal, moves: moves, rules: rules }
    });
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    clearAiT();
    /* ★ 擂台:第一次進來(或人數改過)才重建名單;之後的每一局由 again() 輪替。
       ⚠ 判準是 arena 存不存在 / 人數對不對得上,不可以每一局都重建 —— 那會把連勝歸零。 */
    if(isArena()){
      const n = arena ? (arena.wait.length + 2) : -1;
      if(!arena || n !== seats) arenaReset();
    }else{
      arena = null;
    }
    mySeat = isFriend() ? 0 : (first === "me") ? 0 : (first === "ai") ? 1 : (Math.random() < 0.5 ? 0 : 1);
    aiSeat = 1 - mySeat;
    deal = DC.newDeal();
    moves = [];
    st = DC.replay(deal, moves, rules);
    over = false; busy = false; active = true;
    closeWin();
    showScreen("solo");
    DCB.reset();
    paint();
    Sound.start();
    saveOwn();
    if(!isFriend() && st.turn !== mySeat) aiTurn();
  }
  function quit(){
    clearAiT();
    active = false; over = false; busy = false;
    deal = ""; moves = []; st = null;
    closeWin();
    DCB.reset();
    friendRec = { [DC.RED]: 0, [DC.BLACK]: 0, d: 0 };   // 離桌歸零:戰績只在「這一節本機雙人」裡累積
    arena = null;                                       // ⚠ 擂台同理(連勝與待場名單都只活在這一節)
    showScreen("home");
    showHomeLayer("solo");             // 回到「本機對戰」那一層,方便換設定再來
  }
  /* ★ 擂台模式的「下一位上場」就是這一支:先把上一局的結果算進輪替,再開新局。
     ⚠ 輪替一定要在 start() **之前** —— start() 會把 st 換掉,算不出上一局誰贏。
     ⚠ 只在**這一局真的結束了**才輪替(over):中途按「再來一局」不算任何人贏。 */
  function again(){
    if(arena && over && st){
      arenaNext(st.winner < 0 ? -1 : st.winner);
    }
    closeWin();
    start();
  }

  /* ---------- 推進一手 ---------- */
  function commit(mv){
    const nx = DC.replay(deal, moves.concat(mv), rules);
    if(!nx || nx.bad >= 0) return false;              // 不合法 → 不寫進 moves
    moves.push(mv);
    st = nx;
    /* ★ 第二個參數 = 這一手是不是「這台裝置的人」走的,**只影響震動**(聲音兩邊都要出) ——
       電腦一局要走幾十手,每一手都震一下就是整場在抖,而那個震動不對應使用者的任何動作。
       ⚠ 朋友模式(本機雙人)兩個人共用同一支手機 → 兩邊都算自己人。 */
    DCB.moveSfx(st, isFriend() || !!(st.last && st.last.seat === mySeat));
    paint();
    if(st.over){ if(isFriend()) finishFriend(); else finish(); return true; }
    if(!isFriend() && st.turn !== mySeat) aiTurn();
    return true;
  }
  // 玩家這一手(由 DCB 的點擊流程送進來,合法性 DCB 已經先問過 rules 了)。
  // 朋友模式兩邊都是人、共用同一支手機 —— 不必檢查「輪到誰」,DCB 自己會用 mySide 擋錯色。
  function act(mv){
    if(!active) return;
    if(over){ showToast("這局已經結束了"); return; }
    if(busy){ showToast("等電腦走完這一手"); return; }
    if(!st) return;
    if(!isFriend() && st.turn !== mySeat) return;
    commit(mv);
  }
  /* 投降。★ 刻意**不走 act()** —— 那一支有「還沒輪到你 / 等電腦走完」兩道守衛,
     而投降不必等輪到自己(電腦在想的時候也按得下去)。
     ⚠ 要先把還在飛的 AI setTimeout 清掉:不清的話它會在局已經結束之後再走一手。
     朋友模式沒有固定的「我」,投降的一律是現在輪到走的那一方(認輸不必等輪到自己反而奇怪)。 */
  function resign(){
    if(!active || over || !st || st.over) return;
    clearAiT();
    busy = false;
    commit(DC.encResign(isFriend() ? st.turn : mySeat));
  }

  /* 電腦這一手。兩段 setTimeout 是刻意的(同五子棋):
     第二段補到最短時間,免得新手難度算完只花 0.1ms、子跟著手指瞬間跳走。
     ★ 連吃時它會再排一次自己 —— 一步一步演,不要一次演完。
     ⚠⚠⚠ v1.137.2 起**拿掉了這裡原本的即時 `paint()`**(舊註解寫「讓電腦思考中先畫
     出來」)——它會踩死剛觸發的翻牌/滑動/吃子動畫:call 進來的時候 `commit()` 剛
     replay 完、`st.turn` 已經換成電腦,`commit()` 自己那次 `paint()` 早就把 `mine`
     畫成 false 了,`busy` 再設一次 true**不會讓任何畫面上的東西不一樣**
     (`busy` 唯一的另一個讀者是 `act()` 那道「等電腦走完這一手」的守衛,那是**點擊當下
     直接讀變數**,不是靠 paint() 反映)。但這裡的 `paint()` 跟 `commit()` 那次是**同一拍**
     (同步呼叫鏈,瀏覽器連一幀都還沒畫出來)、`cur.key` 也一樣 —— board.js 的
     `fresh` 判斷會把這次當成「這個 key 已經畫過」,不重播翻牌動畫,而 `board.innerHTML`
     照樣整段重建,直接把剛才那次animation 的節點連根拔掉。使用者反饋:「自己翻棋子的
     時候,我也希望有翻棋子的動畫」——查出來是這個重複呼叫在搞鬼,不是動畫本身沒接上。 */
  function clearAiT(){ if(aiT){ clearTimeout(aiT); aiT = null; } }
  function aiTurn(){
    if(!active || over || !st || st.turn !== aiSeat) return;
    busy = true;
    const chaining = st.chainFrom >= 0;
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    clearAiT();
    aiT = setTimeout(() => {
      if(!active || over || !st || st.turn !== aiSeat) return;
      let mv = null;
      try{ mv = DCAI.pick(st, aiSeat, level, Math.random); }catch(e){ mv = null; }
      /* 保險:AI 出了任何意外都不能讓遊戲卡住 —— 隨便挑一個合法手。
         ⚠ 真的一個都沒有時規則層早就判他輸了(hasAnyMove),這裡只是不讓畫面卡著。 */
      if(mv === null){
        const lm = DC.legalMoves(st);
        mv = lm.length ? lm[0] : null;
      }
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const wait = Math.max(0, (chaining ? AI_CHAIN_MS : AI_MIN_MS) - (now - t0));
      aiT = setTimeout(() => {
        aiT = null;
        if(!active || over || !st || st.turn !== aiSeat) return;
        busy = false;
        if(mv === null){ finish(); return; }
        commit(mv);
      }, wait);
    }, 40);
  }

  /* ---------- 結算 ---------- */
  function finish(){
    clearAiT();
    over = true; busy = false;
    const res = (st.winner < 0) ? "draw" : (st.winner === mySeat ? "win" : "lose");
    const r = recOf(level);
    r[res === "win" ? "w" : res === "lose" ? "l" : "d"]++;
    rec[level] = r;
    saveOwn();
    paint();

    const lv = levelOf(level);
    const card = $("dcWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(res); }
    $("winWord").textContent = res === "win" ? "你贏了!" : res === "lose" ? "你輸了" : "平手!";
    // 硃砂大印:贏 / 平手才蓋,輸的那一份不蓋(見 DCB.setSeal 的註解)
    DCB.setSeal(res === "lose" ? "" : res, moves.length + ":" + st.winner);
    const box = $("dcResult");
    if(box){
      /* ★ 「幾勝」在單機就是**這個難度的累積戰績**(和局兩邊各記一勝,同連線的算法)。
         ⚠ wins 要照座位排,不是照「我 / 電腦」—— resultHTML 是用 r.seat 去索引的。 */
      const mine = { n: r.w + r.d, plus: (res === "lose") ? 0 : 1 };
      const foe  = { n: r.l + r.d, plus: (res === "win")  ? 0 : 1 };
      const wins = mySeat === 0 ? [mine, foe] : [foe, mine];
      box.innerHTML = DCB.resultHTML(st, mySeat === 0 ? ["你", "電腦"] : ["電腦", "你"], mySeat, wins);
      box.classList.remove("hidden");
    }
    /* ⚠ 措辭與連線那份(adapter.js 的 outcome())刻意寫成同一個格式:
       **只講「這一局是怎麼結束的」** —— 幾勝由下面那張表說,難度 / 手數 / 戰績
       不必再寫一遍(v1.116.0:重點是誰贏、幾勝)。 */
    $("winMsg").innerHTML =
      esc(DCB.endText(st, mySeat)) + (res === "win" ? " 🎉" : res === "draw" ? " 🤝" : "") +
      '<span class="dc-solomsg"> · ' + lv.emoji + lv.name + "</span>";
    if(res === "win"){ Sound.win(); burst(); }
    else if(res === "lose") Sound.lose();
    else Sound.win();                        // 平手沿用 win(同五子棋:不給挫敗音)
    showResult();
  }
  /* 朋友模式的結算:沒有「你/電腦」視角 —— 兩邊都是人、共用一支手機,沒有人是輸家視角,
     不放挫敗音、卡片也不套 lose 樣式(同五子棋 finishFriend / 暗棋平手一貫的處理)。
     戰績改記「紅方 / 黑方」各贏幾次(這局誰紅誰黑是隨機翻出來的,同五子棋記黑白不記你我)。
     ⚠ endText/resultHTML 帶 mySeat = -1 就是它們本來就支援的「中立視角」文案。 */
  function finishFriend(){
    clearAiT();
    over = true; busy = false;
    const draw = st.winner < 0;
    if(draw) friendRec.d++; else friendRec[st.col[st.winner]]++;
    paint();

    const card = $("dcWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(draw ? "draw" : "win"); }
    /* 本機雙人沒有「我」的視角 → 印章用中性的那一句(同 endText(st, -1) 的處理) */
    /* ★ 擂台模式講的是**人**(P3 獲勝!),不是顏色 —— 顏色每一局都在換,
       而擂台上大家要知道的是「誰贏了、誰要下去」。 */
    $("winWord").textContent = draw ? "平手!"
      : (arena ? (pName(arena.t[st.winner]) + " 獲勝!")
               : (DC.sideName(st.col[st.winner]) + "方獲勝!"));
    DCB.setSeal(draw ? "draw" : "side", moves.length + ":" + st.winner);
    const box = $("dcResult");
    if(box){
      /* 擂台:那一欄「幾勝」講的是這個**人**在這一節贏過幾場(不是紅方 / 黑方) */
      const wins = arena
        ? [0, 1].map(seat => ({ n: arena.wins[arena.t[seat]] || 0, plus: (!draw && seat === st.winner) ? 1 : 0 }))
        : [0, 1].map(seat => ({ n: friendRec[st.col[seat]] || 0, plus: (!draw && seat === st.winner) ? 1 : 0 }));
      box.innerHTML = DCB.resultHTML(st,
        arena ? [pName(arena.t[0]), pName(arena.t[1])] : ["P1", "P2"], -1, wins);
      box.classList.remove("hidden");
    }
    $("winMsg").innerHTML =
      esc(DCB.endText(st, -1)) + (draw ? " 🤝" : " 🎉") +
      '<span class="dc-solomsg"> · ' +
        (arena ? ("擂台 " + seats + " 人" + (draw ? " · 平手,兩位留台重打"
                                                 : (" · 下一位 " + pName(arena.wait.length ? arena.wait[0] : arena.t[1 - st.winner]))))
               : ("本機雙人 · " + esc(friendRecText()))) +
      "</span>";
    Sound.win();
    if(!draw) burst();
    showResult();
  }

  return {
    start, quit, again, act, resign, loadOwn, paintHud, paint,
    LV, levelOf, recText, recLine, friendRecText,
    seats: () => seats,
    setSeats(v){ const n = (+v) | 0; if(n >= 2 && n <= 6){ seats = n; arena = null; saveOwn(); paintHud(); } },
    isArena, arenaText,
    arena: () => arena,          // 給 e2e 用
    active: () => active,
    playing: () => active && !over,          // 給更新檢查:局中重載會把整局丟掉
    level: () => level,
    first: () => first,
    opponent: () => opponent, isFriend,
    rules: () => DC.normRules(rules),
    st: () => st,                            // 給 e2e 用
    setLevel(v){ if(LV[v]){ level = v; saveOwn(); paintHud(); } },
    setFirst(v){ if(["me", "ai", "random"].indexOf(v) >= 0){ first = v; saveOwn(); } },
    setOpponent(v){ if(["ai", "friend"].indexOf(v) >= 0){ opponent = v; saveOwn(); } },
    /* ★ 房規面板單機連線共用一組 DOM,分流點在 main.js。
       ⚠ 收的是**整份房規**(面板送的是「第幾段」,翻成四個布林是 DC.setRuleLevel 的事);
         這裡一律再走一次 normRules —— 巢狀關係只在那一支落地。 */
    setRules(next){
      rules = DC.normRules(next);
      saveOwn();
    }
  };
})();

"use strict";

/* ============================================================================
   五子棋 — 電腦對決(單機)

   與連線對戰共用同一組棋盤(GB)、同一張結果卡(#veil / .gmk-win)、同一個
   「輪到誰」膠囊(#gmkTurn),差別只在周邊 HUD 與結果卡的按鈕組 —— 靠 body 的
   solo-on class 切換(與數獨 js/sudoku/solo.js 同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:單機一局的狀態只有這裡的 mv / occ。
     GB 只負責畫,棋局真相在 mv;occ 是給 GAI 用的 Int8Array 鏡像(每次落子增量更新,
     悔棋才整份重建)。兩者任何一邊改了,另一邊一定要跟著改。
   ========================================================================== */

const Solo = (function(){
  const SIZES = [15,19,25];                 // 與連線的 SIZES 一致(gomoku.html 的 .on 也要對得上)
  const AI_MIN_MS = 280;                    // 電腦最快也要「想」這麼久:秒回會讓人以為是自己誤觸

  let level = "normal", size = 19, first = "me";   // first: me | ai | random
  let opponent = "ai";                      // ai | friend(本機雙人,朋友坐旁邊輪流點同一支手機)
  let human = "b";                          // 這一局玩家執什麼色(電腦對決才有意義,黑一定先手,由 first 推出來)
  let mv = [], occ = null;
  let active = false, over = false, busy = false;  // busy = 電腦思考中(這期間不收點擊;朋友模式恆為 false)
  let rec = {};                             // 各難度戰績 { easy:{w,l,d}, ... }
  let friendRec = { b:0, w:0, d:0 };        // 朋友模式:這台裝置這一節的黑白勝場 —— 刻意不存 localStorage,重開 App 不留

  function n(){ return GB.size(); }
  function isFriend(){ return opponent === "friend"; }
  function aiColor(){ return human === "b" ? "w" : "b"; }
  function cOf(step){ return step % 2 === 0 ? "b" : "w"; }      // 與 GB.colorOfStep 同一個規則
  function turnColor(){ return cOf(mv.length); }
  function myTurn(){ return turnColor() === human; }
  function code(c){ return c === "b" ? 1 : 2; }                 // GB 的顏色 → GAI 的盤面編碼

  /* ---------- 偏好:單機設定與戰績獨立存 ----------
     刻意不與連線的 boardSize / swapFirst 共用 —— 那些是「房主替全房選的」,
     和自己想單練哪一級是兩回事(比照數獨 sudoku.solo.v1 的作法)。 */
  const OWN_KEY = "gomoku.solo.v1";
  function blank(){ return { w:0, l:0, d:0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(GAI.LEVELS[o.level]) level = o.level;
      if(SIZES.indexOf(o.size) >= 0) size = o.size;
      if(["me","ai","random"].indexOf(o.first) >= 0) first = o.first;
      if(["ai","friend"].indexOf(o.opponent) >= 0) opponent = o.opponent;
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    Object.keys(GAI.LEVELS).forEach(k=>{ if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, size, first, opponent, rec })); }catch(e){}
  }
  function recOf(k){ return rec[k] || blank(); }
  function friendRecText(){
    const r = friendRec;
    if(!(r.b || r.w || r.d)) return "尚無戰績";
    return "⚫" + r.b + "勝 · ⚪" + r.w + "勝" + (r.d ? " · " + r.d + "和" : "");
  }

  /* ---------- HUD ---------- */
  function recText(k){
    const r = recOf(k);
    if(!(r.w || r.l || r.d)) return "尚無戰績";
    return r.w + " 勝 " + r.l + " 敗" + (r.d ? " " + r.d + " 和" : "");
  }
  // 完整句子版(給選單的說明用;HUD 空間窄,那邊用上面的短版)
  function recLine(k){
    const r = recOf(k);
    return (r.w || r.l || r.d) ? ("你在這個難度的戰績 " + recText(k)) : "還沒跟這個難度下過";
  }
  function paintHud(){
    const lv = GAI.levelOf(level);
    const tag = $("gmkSoloTag");
    if(tag) tag.textContent = size + "×" + size + " · " + (isFriend() ? "👤 本機雙人" : (lv.emoji + " " + lv.name));
    const r = $("gmkSoloRec");
    if(r) r.textContent = isFriend() ? friendRecText() : recText(level);
    const u = $("gmkUndoBtn");
    if(u) u.disabled = !canUndo();
  }
  // 「輪到誰」膠囊:單機沿用連線那顆(#gmkTurn),電腦對決文案換成電腦、朋友模式換成黑白棋
  function paintTurn(){
    const cap = $("gmkTurn"), txt = $("gmkTurnTxt");
    if(!cap || !txt) return;
    const dot = cap.querySelector(".gmk-dot");
    const overColor = isFriend() ? (mv.length ? cOf(mv.length - 1) : "b") : human;
    if(dot) dot.className = "gmk-dot " + (over ? overColor : turnColor());
    if(over) txt.textContent = "這局結束";
    else if(isFriend()) txt.textContent = "輪到" + (turnColor() === "b" ? "⚫ 黑棋" : "⚪ 白棋");
    else if(busy) txt.textContent = "電腦思考中…";
    else txt.textContent = myTurn() ? "輪到你" : "電腦下棋中…";
    cap.classList.toggle("mine", !over && !busy && (isFriend() || myTurn()));
    GB.setInteractive(active && !over && !busy && (isFriend() || myTurn()), isFriend() ? turnColor() : human);
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    human = isFriend() ? "b" : (first === "me") ? "b" : (first === "ai") ? "w" : (Math.random() < 0.5 ? "b" : "w");
    mv = []; over = false; busy = false; active = true;
    GB.setSize(size);                 // 內含 reset():舊棋子與勝利標記一起清掉
    occ = GAI.occFrom(mv, size);
    closeWin();
    showScreen("solo");
    requestAnimationFrame(()=>GB.initialView());   // 舞台這一刻才可見,同 tick 量到的寬高還是 0
    paintHud(); paintTurn();
    Sound.start();
    saveOwn();
    if(!isFriend() && !myTurn()) aiTurn();   // 電腦執黑 → 它先下天元(朋友模式兩邊都是人,不必電腦代下)
  }
  function quit(){
    active = false; over = false; busy = false;
    mv = []; occ = null;
    closeWin();
    GB.reset(); GB.setInteractive(false);
    friendRec = { b:0, w:0, d:0 };     // 離桌歸零:戰績只在「這一節本機雙人」裡累積
    showScreen("home");
    showHomeLayer("solo");            // 回到「本機對戰」那一層,方便換設定再來
  }
  function again(){ closeWin(); start(); }

  /* ---------- 落子 ---------- */
  // 真正把一顆子放進三個地方:GB(畫面)、mv(真相)、occ(給 AI 的鏡像)
  function commit(i, byAI){
    if(!GB.play(i)) return false;
    const step = mv.length;
    mv.push(i);
    occ[i] = code(cOf(step));
    GB.setLastByIndex(i);
    Sound.place();
    const line = GB.checkWin(i);
    if(byAI){
      GB.focusOn(i);                  // 電腦下在視野外時把它帶進畫面(同連線對手那手的處理)
      // 收尾那一手不報座標:結果卡才是主角,兩個東西同時彈出來會疊在一起(截圖才看得出來)
      if(!line && !GB.isFull()) showToast((cOf(step) === "b" ? "⚫" : "⚪") + " 電腦下在 " + GB.coordName(i), 1200);
    }
    if(line){
      const wc = cOf(step);
      if(isFriend()) finishFriend(wc, line); else finish(wc === human ? "win" : "lose", line);
      return true;
    }
    if(GB.isFull()){
      if(isFriend()) finishFriend(null, null); else finish("draw", null);
      return true;
    }
    paintHud(); paintTurn();
    if(!isFriend() && !myTurn()) aiTurn();
    return true;
  }
  function tap(i){
    if(!active) return;
    if(over){ showToast("這局已經結束了"); return; }
    if(busy){ showToast("等電腦下完這一手"); return; }
    if(!isFriend() && !myTurn()) return;
    if(GB.occupied(i)){ showToast("這裡已經有子了"); return; }
    commit(i, false);
  }
  /* 電腦這一手。兩段 setTimeout 是刻意的:
     第一段(40ms)讓「電腦思考中…」先畫出來 —— 搜尋是同步的,會把主執行緒佔住,
     不先讓瀏覽器畫一次的話玩家整段時間看到的是舊畫面;
     第二段補到 AI_MIN_MS,免得簡單難度算完只花 2ms、棋子跟著手指瞬間冒出來。 */
  function aiTurn(){
    if(!active || over) return;
    busy = true; paintTurn();
    const t0 = performance.now();
    setTimeout(()=>{
      if(!active || over) return;
      let i = -1;
      try{ i = GAI.pick(occ, n(), code(aiColor()), level); }catch(e){ i = -1; }
      // 保險:AI 出了任何意外(或盤面已滿)都不能讓遊戲卡住 —— 隨便找個空點下
      if(i < 0 || GB.occupied(i)){
        i = -1;
        for(let k = 0; k < n()*n(); k++) if(!GB.occupied(k)){ i = k; break; }
      }
      const wait = Math.max(0, AI_MIN_MS - (performance.now() - t0));
      setTimeout(()=>{
        if(!active || over) return;
        busy = false;
        if(i < 0) finish("draw", null);
        else commit(i, true);
      }, wait);
    }, 40);
  }

  /* ---------- 悔棋 ----------
     電腦對決:退到「自己最後那一手之前」,連對手的回應一起收回(只退一手會變成換對手下,等於白退)。
     朋友模式:兩邊都是人,悔棋就是單純收回最後一手(誰誤按都是同一支手指按下一步)。 */
  function canUndo(){
    if(!active || over || busy) return false;
    if(isFriend()) return mv.length > 0;
    for(let k = mv.length - 1; k >= 0; k--) if(cOf(k) === human) return true;
    return false;
  }
  function undo(){
    if(!active || busy) return;
    if(over){ showToast("這局結束了,按「再來一局」重開"); return; }
    let k;
    if(isFriend()){
      if(!mv.length){ showToast("還沒有可以收回的棋"); return; }
      k = mv.length - 1;
    }else{
      k = mv.length - 1;
      while(k >= 0 && cOf(k) !== human) k--;
      if(k < 0){ showToast("還沒有可以收回的棋"); return; }
    }
    mv.length = k;                    // 截到自己那手之前 → 截完必定又輪到自己
    occ = GAI.occFrom(mv, n());
    GB.applyMoves(mv);                // 變短 → 內部走整盤重建
    if(mv.length) GB.setLastByIndex(mv[mv.length-1]);
    Sound.takeback();
    paintHud(); paintTurn();
  }

  /* ---------- 結算 ---------- */
  function finish(res, line){
    over = true; busy = false;
    if(line) GB.markWin(line);
    GB.setInteractive(false);
    const r = recOf(level);
    r[res === "win" ? "w" : res === "lose" ? "l" : "d"]++;
    rec[level] = r;
    saveOwn();
    paintHud(); paintTurn();

    const lv = GAI.levelOf(level);
    const card = $("gmkWinCard");
    if(card){ card.classList.remove("win","lose","draw"); card.classList.add(res === "win" ? "win" : res === "lose" ? "lose" : "draw"); }
    $("winWord").textContent = res === "win" ? "你贏了!" : res === "lose" ? "你輸了" : "平手!";
    // 「這局是誰拿下」那一列:大字只講對我而言的輸贏,這裡給客觀事實(誰執什麼色)
    const wEl = $("gmkWinner");
    if(wEl){
      if(res === "draw") wEl.innerHTML = '<span class="gw-tag">🤝 棋盤下滿,這局和局</span>';
      else{
        const wc = res === "win" ? human : aiColor();
        const who = res === "win" ? '<span class="gw-name">你</span>'
                                  : '<span class="gw-name">電腦</span><span class="gw-tag">' + lv.emoji + lv.name + '</span>';
        wEl.innerHTML = '<span class="gmk-seat ' + wc + '"><i></i>' + (wc === "b" ? "黑" : "白") + '</span>' + who + '<span class="gw-tag">拿下這局</span>';
      }
    }
    $("winMsg").innerHTML = (res === "win" ? "五子連線,漂亮 🎉" : res === "lose" ? "電腦連成五子了" : "雙方都沒能連成五子 🤝")
      + '<br><span class="gmk-solomsg">' + size + "×" + size + " · " + lv.emoji + lv.name + " · 第 " + mv.length + " 手 · 戰績 " + recText(level) + "</span>";
    if(res === "win"){ Sound.win(); burst(); }
    else Sound.lose();
    showResult();
  }
  // 朋友模式的結算:沒有「你/電腦」視角,只講黑白哪邊拿下這局 —— 兩人都在看同一支手機,
  // 沒有人是「輸家視角」,所以不放挫敗音、卡片也不套 lose 樣式(同暗棋平手的處理方式)。
  function finishFriend(winColor, line){
    over = true; busy = false;
    if(line) GB.markWin(line);
    GB.setInteractive(false);
    friendRec[winColor === null ? "d" : winColor]++;
    paintHud(); paintTurn();

    const card = $("gmkWinCard");
    if(card){ card.classList.remove("win","lose","draw"); card.classList.add(winColor === null ? "draw" : "win"); }
    $("winWord").textContent = winColor === null ? "平手!" : (winColor === "b" ? "⚫ 黑棋獲勝!" : "⚪ 白棋獲勝!");
    const wEl = $("gmkWinner");
    if(wEl){
      if(winColor === null) wEl.innerHTML = '<span class="gw-tag">🤝 棋盤下滿,這局和局</span>';
      else wEl.innerHTML = '<span class="gmk-seat ' + winColor + '"><i></i>' + (winColor === "b" ? "黑" : "白") + '</span><span class="gw-tag">拿下這局</span>';
    }
    $("winMsg").innerHTML = (winColor === null ? "雙方都沒能連成五子 🤝" : "五子連線,漂亮 🎉")
      + '<br><span class="gmk-solomsg">' + size + "×" + size + " · 本機雙人 · 第 " + mv.length + " 手 · " + friendRecText() + "</span>";
    if(winColor !== null) burst();
    Sound.win();
    showResult();
  }

  return {
    start, quit, again, tap, undo, loadOwn, paintHud,
    active:()=>active,
    playing:()=>active && !over,      // 給更新檢查:局中重載會把整盤丟掉
    level:()=>level, size:()=>size, first:()=>first, opponent:()=>opponent, isFriend,
    recText, recLine, friendRecText,
    setLevel(v){ if(GAI.LEVELS[v]){ level = v; saveOwn(); paintHud(); } },
    setSize(v){ if(SIZES.indexOf(v) >= 0){ size = v; saveOwn(); } },
    setFirst(v){ if(["me","ai","random"].indexOf(v) >= 0){ first = v; saveOwn(); } },
    setOpponent(v){ if(["ai","friend"].indexOf(v) >= 0){ opponent = v; saveOwn(); } }
  };
})();

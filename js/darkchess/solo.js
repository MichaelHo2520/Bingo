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
  let rules = DC.defRules();
  let deal = "", moves = [], st = null;
  let mySeat = 0, aiSeat = 1;
  let active = false, over = false, busy = false;
  let aiT = null;
  let rec = {};                       // 各難度戰績 { easy:{w,l,d}, ... }

  const LV = {
    easy: { key: "easy", emoji: "🙂", name: "新手", desc: "有得吃就吃最大的,不管自己會不會被吃回去" },
    mid:  { key: "mid",  emoji: "🤔", name: "普通", desc: "會算一層:不把子留在你吃得到的格上,翻棋也挑安全的" },
    hard: { key: "hard", emoji: "😈", name: "高手", desc: "會算兩層,還會盯著「悶到底比階級總和」那條倒數" }
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
      if(o.rules) rules = DC.normRules(o.rules);        // ⚠ 一律 normRules:舊版存的值可能認不得
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    Object.keys(LV).forEach(k => { if(!rec[k]) rec[k] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, first, rules: DC.normRules(rules), rec })); }catch(e){}
  }
  const recOf = k => rec[k] || blank();
  function recText(k){
    const r = recOf(k);
    if(!(r.w || r.l || r.d)) return "尚無戰績";
    return r.w + " 勝 " + r.l + " 敗" + (r.d ? (" " + r.d + " 和") : "");
  }
  function recLine(k){
    const r = recOf(k);
    return (r.w || r.l || r.d) ? ("你在這個難度的戰績 " + recText(k)) : "還沒跟這個難度下過";
  }

  /* ---------- HUD ---------- */
  function chip(seat){
    const side = st ? st.col[seat] : -1;
    const left = (st && side >= 0) ? DC.countSide(st, side) : 16;
    const isMe = (seat === mySeat);
    const nm = isMe ? "你" : (levelOf(level).emoji + " 電腦");
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
    if(t) t.textContent = lv.emoji + " " + lv.name;
    const r = $("dcSoloRec");
    if(r) r.textContent = recText(level);
    const p = $("dcSoloPlayers");
    if(p) p.innerHTML = st ? (chip(0) + chip(1)) : "";
  }
  function paint(){
    if(!st) return;
    DCB.setState({
      st: st,
      mySide: st.col[mySeat],
      mine: active && !over && !busy && st.turn === mySeat,
      over: over,
      key: moves.length,
      turnName: st.turn === mySeat ? "你" : "電腦"
    });
    paintHud();
  }

  /* ---------- 一局的生命週期 ---------- */
  function start(){
    clearAiT();
    mySeat = (first === "me") ? 0 : (first === "ai") ? 1 : (Math.random() < 0.5 ? 0 : 1);
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
    if(st.turn !== mySeat) aiTurn();
  }
  function quit(){
    clearAiT();
    active = false; over = false; busy = false;
    deal = ""; moves = []; st = null;
    closeWin();
    DCB.reset();
    showScreen("home");
    showHomeLayer("solo");             // 回到「電腦對決」那一層,方便換難度再來
  }
  function again(){ closeWin(); start(); }

  /* ---------- 推進一手 ---------- */
  function commit(mv){
    const nx = DC.replay(deal, moves.concat(mv), rules);
    if(!nx || nx.bad >= 0) return false;              // 不合法 → 不寫進 moves
    moves.push(mv);
    st = nx;
    DCB.moveSfx(st);
    paint();
    if(st.over){ finish(); return true; }
    if(st.turn !== mySeat) aiTurn();
    return true;
  }
  // 玩家這一手(由 DCB 的點擊流程送進來,合法性 DCB 已經先問過 rules 了)
  function act(mv){
    if(!active) return;
    if(over){ showToast("這局已經結束了"); return; }
    if(busy){ showToast("等電腦走完這一手"); return; }
    if(!st || st.turn !== mySeat) return;
    commit(mv);
  }

  /* 電腦這一手。兩段 setTimeout 是刻意的(同五子棋):
     第一段讓「電腦思考中」先畫出來(搜尋是同步的,會把主執行緒佔住);
     第二段補到最短時間,免得新手難度算完只花 0.1ms、子跟著手指瞬間跳走。
     ★ 連吃時它會再排一次自己 —— 一步一步演,不要一次演完。 */
  function clearAiT(){ if(aiT){ clearTimeout(aiT); aiT = null; } }
  function aiTurn(){
    if(!active || over || !st || st.turn !== aiSeat) return;
    busy = true;
    paint();
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
    const box = $("dcResult");
    if(box){
      box.innerHTML = DCB.resultHTML(st, mySeat === 0 ? ["你", "電腦"] : ["電腦", "你"], mySeat, null);
      box.classList.remove("hidden");
    }
    $("winMsg").innerHTML =
      (res === "win" ? "漂亮 🎉" : res === "lose" ? "這局讓電腦拿下了" : "兩邊剩下的棋一樣強 🤝") +
      '<br><span class="dc-solomsg">' + lv.emoji + lv.name + " · " + esc(DC.rulesText(rules)) +
      " · 第 " + moves.length + " 手 · 戰績 " + recText(level) + "</span>";
    if(res === "win"){ Sound.win(); burst(); }
    else if(res === "lose") Sound.lose();
    else Sound.win();                        // 平手沿用 win(同五子棋:不給挫敗音)
    showResult();
  }

  return {
    start, quit, again, act, loadOwn, paintHud, paint,
    LV, levelOf, recText, recLine,
    active: () => active,
    playing: () => active && !over,          // 給更新檢查:局中重載會把整局丟掉
    level: () => level,
    first: () => first,
    rules: () => DC.normRules(rules),
    st: () => st,                            // 給 e2e 用
    setLevel(v){ if(LV[v]){ level = v; saveOwn(); paintHud(); } },
    setFirst(v){ if(["me", "ai", "random"].indexOf(v) >= 0){ first = v; saveOwn(); } },
    /* ★ 房規面板單機連線共用一組 DOM,分流點在 main.js。
       ⚠ 一律走 normRules:巢狀關係(chainDark 依賴 chain)只在那裡落地一次。 */
    setRule(key, val){
      const next = DC.normRules(Object.assign({}, rules, { [key]: val }));
      rules = next;
      saveOwn();
    }
  };
})();

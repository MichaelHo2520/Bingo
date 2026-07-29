"use strict";

/* ============================================================================
   麻將消牌 — 單機練習(Solo)。完全不碰 Firebase,就是「連線模式扣掉連線層」。
   共用 MB(盤面)與結果卡,只是周邊 HUD 換成計時 / 剩餘 / 提示 / 重洗 / 悔棋。

   單機才有意義、連線刻意不做的:悔棋、暫停。對戰節奏快,那兩個會拖慢或破壞公平。

   ★「可消 N 組」為什麼要公布:出題器保證盤面解得開,但玩家自己亂配是會走進死局的
     (node 實測隨機亂玩,144 牌只有 36.9% 能清空)。玩到剩十幾張才發現卡死、又不知道
     卡了多久,是這類遊戲最勸退的一刻。公布「還有幾組可消」等於給一個危險儀表 ——
     但**不說是哪幾組**,要消什麼還是得自己掃。這與數獨 v1.46.0 的候選提示同一個原則:
     只給數量、不給答案。
   ========================================================================== */

const Solo = (function(){
  const MAX_HINT=5;
  let level="m72";
  let t0=0, elapsed=0, tick=null, paused=false, running=false;
  let hints=0, shuffles=0, undos=0;
  let stack=[];            // 悔棋用:依序記下消掉的每一對 [i,j]

  function fmt(ms){
    const s=Math.floor(ms/1000), m=Math.floor(s/60);
    return (m<10?"0":"")+m+":"+((s%60)<10?"0":"")+(s%60);
  }

  /* ---------- HUD ----------
     「剩餘張數 / 可消組數」由 MB.repaint() 自己畫(單機與連線共用那兩顆讀數),
     這裡只管單機才有的:計時、盤面標籤、三顆工具鈕的可按狀態。 */
  function paintHud(){
    const t=$("mjTime"); if(t) t.textContent=fmt(elapsed);
    const lv=$("mjLevelTag");
    if(lv){ const L=MGen.levelOf(level); lv.textContent=L.label+" · "+L.name; }
    const mv=MB.movesLeft();
    const h=$("mjHintBtn");
    if(h){ h.textContent="💡 提示 "+(MAX_HINT-hints); h.disabled = hints>=MAX_HINT || !running || paused || mv===0; }
    const u=$("mjUndoBtn"); if(u) u.disabled = !stack.length || !running || paused;
    const s=$("mjShuffleBtn"); if(s) s.disabled = !running || paused || MB.left()<2;
  }
  function startTick(){
    stopTick();
    t0=Date.now()-elapsed;
    tick=setInterval(()=>{ if(!paused){ elapsed=Date.now()-t0; const t=$("mjTime"); if(t)t.textContent=fmt(elapsed); } },250);
  }
  function stopTick(){ if(tick){ clearInterval(tick); tick=null; } }

  /* ---------- 偏好:單機難度獨立存 ----------
     刻意不跟連線的 diff 共用一個值 —— 連線那個是「房主替全房選的」,
     和自己單機想玩多大盤是兩回事(比照數獨 sudoku.solo.v1 的作法)。 */
  const OWN_KEY="mahjong.solo.v1";
  function loadOwn(){
    try{
      const o=JSON.parse(localStorage.getItem(OWN_KEY))||{};
      if(MGen.LEVELS[o.level]) level=o.level;
    }catch(e){}
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level:level })); }catch(e){}
  }

  /* ---------- 開始 / 結束 ---------- */
  function start(lv){
    level=lv||level;
    const q=MGen.make(level);
    if(!q){ showToast("出題失敗,再試一次 😥"); return; }    // 實測不會發生(單次成功率 100%),但不能讓它靜默壞掉
    elapsed=0; hints=0; shuffles=0; undos=0; paused=false; running=true; stack=[];
    MB.setBoard(q);
    MB.setEnabled(true);
    showScreen("solo");
    MB.fit();
    startTick(); paintHud();
    Sound.start();
    saveOwn();
  }
  function quit(){
    running=false; stopTick(); MB.setEnabled(false);
    closeWin();
    showScreen("home");
  }
  function togglePause(){
    if(!running)return;
    paused=!paused;
    if(!paused) t0=Date.now()-elapsed;
    MB.setEnabled(!paused);
    const v=$("mjPauseVeil"); if(v) v.classList.toggle("show",paused);
    const b=$("mjPauseBtn"); if(b) b.textContent=paused?"▶":"⏸";
    paintHud();
  }

  /* ---------- 操作 ---------- */
  function onPair(i,j){
    if(!running||paused)return;
    MB.remove(i,j);
    stack.push([i,j]);
    Sound.place();
    if(MB.cleared()){ finish(); return; }
    paintHud();
    if(!MB.anyMove()) deadEnd();
  }
  function deadEnd(){
    // 不自動重洗:自動洗會讓玩家搞不清楚盤面為什麼整個變了。給提示 + 讓「重洗」鈕自己發亮
    showToast("沒有可以消的牌了 —— 按「🔀 重洗」重排剩下的牌",2600);
  }
  function hint(){
    if(!running||paused||hints>=MAX_HINT)return;
    if(!MB.showHint())return;
    hints++;
    Sound.mark();
    paintHud();
  }
  /* 重洗:把「還在盤上」的牌重新排成一定解得開的樣子(格位不變、牌換位置)。
     次數不設限 —— 死局多半不是玩家的錯(出題保證有解,但任何一步走岔就可能回不去),
     用「計入結算」來表達代價就夠了,擋住只會讓人卡在那裡出不去。 */
  function shuffle(){
    if(!running||paused)return;
    if(MB.left()<2)return;
    const nt=MGen.reshuffle(MB.level(), MB.aliveArr(), MB.tiles());
    if(!nt){ showToast("重洗失敗,再按一次 😥"); return; }
    MB.setTiles(nt);
    // ★ 悔棋堆一定要清掉:重洗只重排「還在盤上」的牌,悔棋會把已經消掉的牌放回來 ——
    //   那兩張沒有被算進這次重洗,放回去就破壞了「解得開」的保證
    stack=[];
    shuffles++;
    Sound.takeback();
    showToast("已重洗剩下的 "+MB.left()+" 張 🔀",1400);
    paintHud();
  }
  function undo(){
    if(!running||paused||!stack.length)return;
    const p=stack.pop();
    MB.setAlive((function(){
      const a=MB.aliveArr(); a[p[0]]=1; a[p[1]]=1; return a;
    })());
    undos++;
    Sound.takeback();
    paintHud();
  }

  function finish(){
    running=false; stopTick(); MB.setEnabled(false); MB.markDone();
    const L=MGen.levelOf(level);
    const card=$("mjWinCard");
    if(card){ card.classList.remove("win","lose","draw"); card.classList.add("win"); }
    $("winWord").textContent="全部清空!";
    $("winMsg").textContent=L.label+" "+L.name+" · 用了 "+fmt(elapsed);
    const box=$("mjStats");
    if(box){
      box.innerHTML=
        '<div class="mj-stat"><span class="ms-k">時間</span><span class="ms-v">'+fmt(elapsed)+'</span></div>'+
        '<div class="mj-stat"><span class="ms-k">提示</span><span class="ms-v">'+hints+' 次</span></div>'+
        '<div class="mj-stat"><span class="ms-k">重洗</span><span class="ms-v">'+shuffles+' 次</span></div>'+
        '<div class="mj-stat"><span class="ms-k">悔棋</span><span class="ms-v">'+undos+' 次</span></div>';
      box.classList.remove("hidden");
    }
    Sound.win(); burst();
    showResult();
  }

  return {
    start, quit, togglePause, hint, shuffle, undo, onPair, loadOwn, paintHud,
    running:()=>running, level:()=>level,
    setLevel(v){ if(MGen.LEVELS[v]){ level=v; saveOwn(); } },
    isPaused:()=>paused
  };
})();

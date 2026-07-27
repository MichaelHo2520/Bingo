"use strict";

/* ============================================================================
   數獨 — 單機練習(Solo)。完全不碰 Firebase,就是「對戰模式扣掉連線層」。
   共用 SB(盤面 + 數字鍵盤)與結果卡 DOM,只是周邊 HUD 換成計時 / 錯誤 / 提示。

   單機才有意義、連線刻意不做的:筆記(pencil marks)、提示、暫停。
   對戰節奏快,那三個會拖慢或破壞公平。
   ========================================================================== */

const Solo = (function(){
  const MAX_HINT=3;
  let q=null, level="e9";
  let t0=0, elapsed=0, tick=null, paused=false;
  let mistakes=0, hints=0, running=false;

  function fmt(ms){
    const s=Math.floor(ms/1000), m=Math.floor(s/60);
    return (m<10?"0":"")+m+":"+((s%60)<10?"0":"")+(s%60);
  }
  function paintHud(){
    const t=$("sdkTime"); if(t) t.textContent=fmt(elapsed);
    const m=$("sdkMiss"); if(m) m.textContent="✗ "+mistakes;
    const h=$("sdkHintBtn");
    if(h){
      h.textContent="💡 提示 "+(MAX_HINT-hints);
      h.disabled = hints>=MAX_HINT || !running || paused;
    }
    const nb=$("sdkNoteBtn");
    if(nb) nb.classList.toggle("on", SB.noteMode());
    const lv=$("sdkLevelTag");
    if(lv){ const L=SGen.levelOf(level); lv.textContent=L.label+" · "+L.name; }
  }
  function startTick(){
    stopTick();
    t0=Date.now()-elapsed;
    tick=setInterval(()=>{ if(!paused){ elapsed=Date.now()-t0; paintHud(); } },250);
  }
  function stopTick(){ if(tick){ clearInterval(tick); tick=null; } }

  /* ---------- 偏好:單機難度獨立存 ----------
     刻意不跟連線的 diff 共用一個值 —— 連線那個是「房主替全房選的」,
     和自己單機想練哪一級是兩回事(比照 scoreMode 兩邊分開存的作法)。 */
  const OWN_KEY="sudoku.solo.v1";
  function loadOwn(){
    try{
      const o=JSON.parse(localStorage.getItem(OWN_KEY))||{};
      if(SGen.LEVELS[o.level]) level=o.level;
    }catch(e){}
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level:level })); }catch(e){}
  }

  /* ---------- 開始 / 結束 ---------- */
  function start(lv){
    level=lv||level;
    q=SGen.make(level);
    elapsed=0; mistakes=0; hints=0; paused=false; running=true;
    SB.setPuzzle(q);
    SB.setEnabled(true);
    SB.setSel(SB.firstEmpty());
    showScreen("solo");
    startTick(); paintHud();
    Sound.start();
    saveOwn();
  }
  function quit(){
    running=false; stopTick(); SB.setEnabled(false);
    closeWin();
    showScreen("home");
  }
  function togglePause(){
    if(!running)return;
    paused=!paused;
    if(!paused) t0=Date.now()-elapsed;
    SB.setEnabled(!paused);
    const v=$("sdkPauseVeil"); if(v) v.classList.toggle("show",paused);
    const b=$("sdkPauseBtn"); if(b) b.textContent=paused?"▶":"⏸";
  }

  /* ---------- 操作 ---------- */
  function onNum(i,v){
    if(!running||paused)return;
    if(SB.valueAt(i)===v){ SB.clear(i); return; }       // 再點同一個數字 = 清掉
    if(SB.solAt(i)===v){
      SB.fill(i,v,"me");
      Sound.place();
      if(SB.isComplete()) finish();
      else{
        const nx=SB.firstEmpty();
        if(nx>=0 && SB.valueAt(i)) SB.setSel(nx);        // 自動跳到下一個空格,少點一次
      }
    }else{
      mistakes++;
      SB.flashWrong(i);
      try{ Sound.lose&&Sound.lose(); }catch(e){}
      paintHud();
    }
  }
  function onErase(i){ if(running&&!paused&&i>=0) SB.clear(i); }
  function hint(){
    if(!running||paused||hints>=MAX_HINT)return;
    let i=SB.sel();
    if(i<0||SB.valueAt(i)) i=SB.firstEmpty();
    if(i<0)return;
    hints++;
    SB.fill(i,SB.solAt(i),"hintfill");   // ★ 不可叫 hint:撞既有的 .hint 說明文字樣式
    SB.setSel(i);
    Sound.place();
    paintHud();
    if(SB.isComplete()) finish();
  }
  function toggleNote(){ SB.setNoteMode(!SB.noteMode()); paintHud(); }

  function finish(){
    running=false; stopTick(); SB.setEnabled(false); SB.markDone();
    const L=SGen.levelOf(level);
    const card=$("sdkWinCard");
    if(card){ card.classList.remove("win","lose","draw"); card.classList.add("win"); }
    $("winWord").textContent="完成!";
    $("winMsg").textContent=L.label+" "+L.name+" · 用了 "+fmt(elapsed);
    // 單機專屬統計列(連線的排行榜/表情列在 showScreen 時已收起)
    const box=$("sdkStats");
    if(box){
      box.innerHTML=
        '<div class="sdk-stat"><span class="ss-k">時間</span><span class="ss-v">'+fmt(elapsed)+'</span></div>'+
        '<div class="sdk-stat"><span class="ss-k">填錯</span><span class="ss-v">'+mistakes+' 次</span></div>'+
        '<div class="sdk-stat"><span class="ss-k">提示</span><span class="ss-v">'+hints+' 次</span></div>';
      box.classList.remove("hidden");
    }
    Sound.win(); burst();
    showResult();
  }

  return {
    start, quit, togglePause, hint, toggleNote, onNum, onErase, loadOwn,
    running:()=>running, level:()=>level,
    setLevel(v){ if(SGen.LEVELS[v]){ level=v; saveOwn(); } },
    isPaused:()=>paused,
    paintHud
  };
})();

"use strict";

/* ============================================================================
   方塊對戰 — 單機(Solo)

   ★ P1 的單機**不是附屬品,是這一頁的驗收場**:
     手機上的方塊手感是整個遊戲成敗的關鍵,而手感只能靠一個人反覆試才調得出來。
     先有單機,調 DAS/ARR 才不必每次開兩個瀏覽器 profile 對打。

   兩種玩法(規則完全同一份,差別只有「什麼時候結束」):
     · 練習(無盡)—— 玩到堆爆為止,記最高消行數
     · 40 行競速 —— 消滿 40 行,記最短時間

   ⚠ 這一支不碰 Canvas、不碰按鍵 —— 那些全部在 board.js。
     它只做四件事:開局、把規則事件翻成 HUD 與音效、判定結束、記錄戰績。
   ========================================================================== */

const Solo = (function(){

  const OWN_KEY = "blocks.solo.v1";     // ⚠ 獨立 key,不與 bingo.prefs.v1 那組互相覆蓋
  const SPRINT_LINES = 40;

  let mode = "endless";                 // "endless" | "sprint"
  let feel = 1;                         // 手感(0 慢 / 1 標準 / 2 快)
  let ctrl = "btn";                     // 控制方式
  let rec = { best: 0, sprint: 0 };     // 最高消行 / 最短毫秒(0 = 沒紀錄)

  let st = null;
  let on = false, paused = false, ended = false;
  let t0 = 0, took = 0;

  /* ---------- 存檔 ---------- */
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(o.mode === "sprint" || o.mode === "endless") mode = o.mode;
      if(typeof o.feel === "number") feel = Math.max(0, Math.min(2, o.feel | 0));
      if(o.ctrl === "btn" || o.ctrl === "swipe" || o.ctrl === "both") ctrl = o.ctrl;
      if(o.rec) rec = { best: o.rec.best | 0, sprint: o.rec.sprint | 0 };
    }catch(e){}
    BLKB.setFeel(feel);
    BLKB.setCtrl(ctrl);
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ mode, feel, ctrl, rec })); }catch(e){}
  }

  /* ---------- 設定 ---------- */
  function setMode(m){ if(m === "sprint" || m === "endless"){ mode = m; saveOwn(); } }
  function setFeel(v){ feel = Math.max(0, Math.min(2, v | 0)); BLKB.setFeel(feel); saveOwn(); }
  function setCtrl(v){ ctrl = (v === "swipe" || v === "both") ? v : "btn"; BLKB.setCtrl(ctrl); saveOwn(); }

  /* ---------- 開局 ---------- */
  function start(){
    st = BLK.blank({
      seed: (Math.random() * 0xffffffff) >>> 0,
      /* 單機沒有對手 → 新手保護與 Combo 都留著(規則只有一份,不另做一套「單機規則」),
         只是送出去的攻擊沒有人收。 */
      rules: { mode: "out", shield: 0 }
    });
    on = true; paused = false; ended = false;
    t0 = performance.now(); took = 0;
    BLKB.setState(st);
    BLKB.play();
    showScreen("solo");
    paintBar();
    paintHud();
    if(typeof Sound !== "undefined" && Sound.start) Sound.start();
  }
  function again(){ closeWin(); start(); }
  function quit(){
    on = false; ended = true;
    BLKB.stop();
    closeWin();
    showScreen("home");
  }

  /* ---------- 暫停(返回鍵 / 切背景)----------
     ⚠ 單機可以暫停,**連線不行** —— 那一條在 adapter 那邊(P3)。 */
  function togglePause(){
    if(!on || ended) return;
    paused = !paused;
    if(paused) BLKB.pause(); else { BLKB.play(); }
    paintHud();
    showToast(paused ? "已暫停 —— 再按一次繼續" : "繼續");
  }

  /* ---------- 規則事件 ---------- */
  function onEvents(evs){
    if(!on || ended) return;
    for(let i = 0; i < evs.length; i++){
      const ev = evs[i];
      if(ev.t !== "lock") continue;
      if(mode === "sprint" && st.lines >= SPRINT_LINES){ finish(true); return; }
      if(ev.dead || st.dead){ finish(false); return; }
    }
    paintHud();
  }

  function finish(win){
    if(ended) return;
    ended = true; on = false;
    took = Math.round(performance.now() - t0);
    BLKB.stop();

    let fresh = false;
    if(mode === "sprint"){
      if(win && (!rec.sprint || took < rec.sprint)){ rec.sprint = took; fresh = true; }
    }else{
      if(st.lines > rec.best){ rec.best = st.lines; fresh = true; }
    }
    saveOwn();
    paintBar();
    paintResult(win, fresh);
    if(typeof Sound !== "undefined"){
      if(win && Sound.win) Sound.win(); else if(Sound.lose) Sound.lose();
    }
    if(win && typeof burst === "function") burst();
    setTimeout(showResult, 260);
  }

  /* ---------- 畫面 ---------- */
  function timeTxt(ms){
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return (m ? (m + ":" + String(s % 60).padStart(2, "0")) : (s + "." + String(Math.floor(ms % 1000 / 100)))) +
           (m ? "" : " 秒");
  }
  function paintHud(){
    if(!st) return;
    const set = (id, v) => { const el = $(id); if(el) el.textContent = v; };
    set("blkStatLines", st.lines);
    set("blkStatTime", on && !paused ? timeTxt(performance.now() - t0) : timeTxt(took || (t0 ? performance.now() - t0 : 0)));
    set("blkStatLv", BLK.level(st));
    const goal = $("blkGoal");
    if(goal) goal.textContent = (mode === "sprint") ? ("目標 " + SPRINT_LINES + " 行") : "無盡";
    const p = $("blkPaused");
    if(p) p.classList.toggle("hidden", !paused);
  }
  function paintBar(){
    const el = $("blkSoloRec");
    if(el) el.textContent = (mode === "sprint")
      ? (rec.sprint ? ("最快 " + timeTxt(rec.sprint)) : "還沒有紀錄")
      : (rec.best ? ("最高 " + rec.best + " 行") : "還沒有紀錄");
    const t = $("blkSoloMode");
    if(t) t.textContent = (mode === "sprint") ? (SPRINT_LINES + " 行競速") : "練習";
  }
  function paintResult(win, fresh){
    const word = $("winWord"), msg = $("winMsg"), box = $("blkResult");
    if(word) word.textContent = win ? "完成!" : "堆爆了";
    if(msg) msg.textContent = win
      ? ("消滿 " + SPRINT_LINES + " 行,花了 " + timeTxt(took))
      : ("撐了 " + timeTxt(took) + ",消了 " + st.lines + " 行");
    if(box){
      box.classList.remove("hidden");
      box.innerHTML =
        row("消行", st.lines + " 行") +
        row("時間", timeTxt(took)) +
        row("方塊", st.pieces + " 顆") +
        row("最高階", BLK.level(st) + " 階") +
        (fresh ? '<div class="blk-fresh">🎉 新紀錄!</div>' : "");
    }
  }
  function row(k, v){
    return '<div class="blk-rrow"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>";
  }

  return {
    start, again, quit, togglePause, onEvents, loadOwn, paintBar, paintHud,
    setMode, setFeel, setCtrl,
    mode: () => mode, feel: () => feel, ctrl: () => ctrl, rec: () => rec,
    /* ★ ui-kit 的返回鍵守衛與更新檢查都會問這兩個 */
    playing: () => on && !ended,
    active: () => on,
    paused: () => paused,
    state: () => st,
    SPRINT_LINES
  };
})();

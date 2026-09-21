"use strict";

/* ============================================================================
   方塊對戰 — 單機(Solo)

   三種玩法(規則完全同一份,差別只有「什麼時候結束」與「有沒有對手」):
     · 練習(無盡)—— 玩到堆爆為止,記最高消行數
     · 40 行競速 —— 消滿 40 行,記最短時間
     · 對電腦     —— 1 對 1,互相送垃圾行,先堆爆的輸

   ★ 「對電腦」與連線對戰**走同一條顯示路徑**(BLKB.setFoes / beamOut / beamIn)——
     所以對手小盤、攻擊光束、KO 標記這些東西只有一份實作。

   ⚠ 這一支不碰 Canvas、不碰按鍵 —— 那些全部在 board.js。
     它只做五件事:開局、推進電腦、把規則事件翻成 HUD 與音效、判定結束、記錄戰績。
   ========================================================================== */

const Solo = (function(){

  const OWN_KEY = "blocks.solo.v1";     // ⚠ 獨立 key,不與 bingo.prefs.v1 那組互相覆蓋
  const SPRINT_LINES = 40;

  let mode = "endless";                 // "endless" | "sprint" | "vs"
  let feel = 1;                         // 手感(0 慢 / 1 標準 / 2 快)
  let ctrl = "btn";                     // 控制方式
  let pad  = "float";                   // 控制鈕:浮在盤面上 / 固定在下方
  let lvKey = "norm";                   // 電腦強度
  let rec = { best: 0, sprint: 0, win: 0, lose: 0 };

  let st = null;                        // 我的狀態
  let foe = null, foeMem = null, foeLv = null;   // 電腦那一份
  let on = false, paused = false, ended = false;
  let t0 = 0, took = 0;

  /* ---------- 存檔 ---------- */
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(o.mode === "sprint" || o.mode === "endless" || o.mode === "vs") mode = o.mode;
      if(typeof o.feel === "number") feel = Math.max(0, Math.min(2, o.feel | 0));
      if(o.ctrl === "btn" || o.ctrl === "swipe" || o.ctrl === "both") ctrl = o.ctrl;
      if(o.pad === "float" || o.pad === "dock") pad = o.pad;
      if(o.lv) lvKey = BLKAI.levelOf(o.lv).key;
      if(o.rec) rec = { best: o.rec.best | 0, sprint: o.rec.sprint | 0,
                        win: o.rec.win | 0, lose: o.rec.lose | 0 };
    }catch(e){}
    BLKB.setFeel(feel);
    BLKB.setPad(pad);
    BLKB.setCtrl(ctrl);
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ mode, feel, ctrl, pad, lv: lvKey, rec })); }catch(e){}
  }

  /* ---------- 設定 ---------- */
  function setMode(m){ if(m === "sprint" || m === "endless" || m === "vs"){ mode = m; saveOwn(); } }
  function setFeel(v){ feel = Math.max(0, Math.min(2, v | 0)); BLKB.setFeel(feel); saveOwn(); }
  function setCtrl(v){ ctrl = (v === "swipe" || v === "both") ? v : "btn"; BLKB.setCtrl(ctrl); saveOwn(); }
  function setPad(v){ pad = (v === "dock") ? "dock" : "float"; BLKB.setPad(pad); saveOwn(); }
  function setLevel(v){ lvKey = BLKAI.levelOf(v).key; saveOwn(); }

  /* ---------- 開局 ---------- */
  function start(){
    const seed = (Math.random() * 0xffffffff) >>> 0;
    /* 單機沒有房規 UI → 一律用「淘汰、不開新手保護」。
       ⚠ 規則只有一份,不另做一套「單機規則」。 */
    const rules = { mode: "out", shield: 0 };
    st = BLK.blank({ seed: seed, rules: rules });
    if(mode === "vs"){
      /* ★ 電腦用**同一顆 seed** —— 出塊序列一樣才叫公平(與連線對戰同一條規矩) */
      foe = BLK.blank({ seed: seed, rules: rules });
      foeMem = BLKAI.newMem();
      foeLv = BLKAI.levelOf(lvKey);
      BLKB.setFoes([{ id: "cpu", name: foeLv.emoji + " " + foeLv.name, st: foe }]);
    }else{
      foe = null; foeMem = null; foeLv = null;
      BLKB.setFoes([]);
    }
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
    BLKB.setFoes([]);
    closeWin();
    showScreen("home");
  }

  /* ---------- 暫停 ----------
     ⚠ 單機可以暫停,**連線不行** —— 那一條在 adapter 那邊。 */
  function togglePause(){
    if(!on || ended) return;
    paused = !paused;
    if(paused) BLKB.pause(); else BLKB.play();
    paintHud();
    showToast(paused ? "已暫停 —— 再按一次繼續" : "繼續");
  }

  /* ---------- 每一幀:推進電腦 ----------
     ⚠ 電腦的重力也要走 —— 只推 AI 不 tick 的話它永遠不會被自己的重力壓死,
       而且垃圾行推上來的時機會與我這邊差一整顆。 */
  function onFrame(dt){
    if(!on || ended || paused || !foe) return;
    if(foe.dead) return;
    const evs = BLKAI.step(foe, foeMem, dt, foeLv).concat(BLK.tick(foe, dt));
    for(let i = 0; i < evs.length; i++){
      const ev = evs[i];
      if(!ev || ev.t !== "lock") continue;
      if(ev.out > 0) hit(st, ev.out, "foe");
      if(ev.dead || foe.dead){ finish(true); return; }
    }
  }

  /* 一方打另一方。⚠ 洞位由**送出端**決定(接收端不可以自己重抽)—— 與連線同一條規矩 */
  function hit(target, n, from){
    const hole = Math.floor(Math.random() * BLK.COLS);
    BLK.queueGarbage(target, n, hole, from);
    if(from === "foe") BLKB.beamIn(0, n);
    else BLKB.beamOut(0, n);
  }

  /* ---------- 我的規則事件 ---------- */
  function onEvents(evs){
    if(!on || ended) return;
    for(let i = 0; i < evs.length; i++){
      const ev = evs[i];
      if(ev.t !== "lock") continue;
      if(mode === "vs" && ev.out > 0 && foe && !foe.dead) hit(foe, ev.out, "me");
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
    }else if(mode === "vs"){
      if(win) rec.win++; else rec.lose++;
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
    set("blkStatTime", on && !paused ? timeTxt(performance.now() - t0) : timeTxt(took || 0));
    set("blkStatLv", BLK.level(st));
    const goal = $("blkGoal");
    if(goal) goal.textContent = (mode === "sprint") ? ("目標 " + SPRINT_LINES + " 行")
                              : (mode === "vs") ? (foeLv ? foeLv.emoji + " " + foeLv.name : "對電腦") : "無盡";
    const p = $("blkPaused");
    if(p) p.classList.toggle("hidden", !paused);
  }
  function paintBar(){
    const el = $("blkSoloRec");
    if(el) el.textContent = (mode === "sprint")
      ? (rec.sprint ? ("最快 " + timeTxt(rec.sprint)) : "還沒有紀錄")
      : (mode === "vs") ? ((rec.win + rec.lose) ? (rec.win + " 勝 " + rec.lose + " 敗") : "還沒有紀錄")
      : (rec.best ? ("最高 " + rec.best + " 行") : "還沒有紀錄");
    const t = $("blkSoloMode");
    if(t) t.textContent = (mode === "sprint") ? (SPRINT_LINES + " 行競速")
                        : (mode === "vs") ? "對電腦" : "練習";
  }
  function paintResult(win, fresh){
    const word = $("winWord"), msg = $("winMsg"), box = $("blkResult");
    if(word) word.textContent = (mode === "vs") ? (win ? "你贏了!" : "你輸了") : (win ? "完成!" : "堆爆了");
    if(msg) msg.textContent = (mode === "vs")
      ? ((win ? "把電腦埋掉了 —— " : "被電腦埋掉了 —— ") + "撐了 " + timeTxt(took))
      : (mode === "sprint" && win)
        ? ("消滿 " + SPRINT_LINES + " 行,花了 " + timeTxt(took))
        : ("撐了 " + timeTxt(took) + ",消了 " + st.lines + " 行");
    if(box){
      box.classList.remove("hidden");
      box.innerHTML =
        row("消行", st.lines + " 行") +
        row("送出", st.sent + " 行") +
        row("時間", timeTxt(took)) +
        row("方塊", st.pieces + " 顆") +
        (mode === "vs" && foe ? row("電腦消行", foe.lines + " 行") : "") +
        (fresh ? '<div class="blk-fresh">🎉 新紀錄!</div>' : "");
    }
  }
  function row(k, v){
    return '<div class="blk-rrow"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>";
  }

  return {
    start, again, quit, togglePause, onEvents, onFrame, loadOwn, paintBar, paintHud,
    setMode, setFeel, setCtrl, setPad, setLevel,
    mode: () => mode, feel: () => feel, ctrl: () => ctrl, pad: () => pad,
    level: () => lvKey, rec: () => rec,
    /* ★ ui-kit 的返回鍵守衛與更新檢查都會問這兩個 */
    playing: () => on && !ended,
    active: () => on,
    paused: () => paused,
    state: () => st,
    foeState: () => foe,
    SPRINT_LINES
  };
})();

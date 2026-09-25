"use strict";

/* ============================================================================
   泡泡對戰 — 單機(Solo)

   兩種玩法(規則完全同一份,差別只有「什麼時候結束」與「有沒有對手」):
     · 練習(無盡)—— 頂端每隔一段時間就插一排,撐到被壓過死亡線為止,記最多打掉幾顆
     · 對電腦     —— 1~3 台電腦,整組連線房規照搬(同方塊對戰 v2.15.4)

   ★ 照抄 js/blocks/solo.js 的骨架,四條紅線一樣成立:
     ① 房規整組照搬,文案共用 BUB.NOTES(不另外抄一份)
     ② 電腦之間也會互打(照同一套 pickTarget())
     ③ K.O. 賽的時鐘不可以讀 st.time(我死掉那兩秒 tick 不會被呼叫 → 時間凍住)
     ④ 每一台電腦各有各的死亡計時
   ⚠ 這一支不碰 Canvas、不碰輸入 —— 那些全部在 board.js。
   ========================================================================== */

const Solo = (function(){

  const OWN_KEY = "bubble.solo.v1";     // ⚠ 獨立 key,不與 bingo.prefs.v1 那組互相覆蓋
  const FOE_MAX = 3;
  const RESPAWN_MS = 2000;
  const RUSH_MS = 30000;
  const STREAK_MS = 12000;
  const STREAK_WORD = ["", "", "雙殺!", "三殺!", "四殺!!", "大殺特殺!!!"];
  /* ★ 對電腦開局先倒數 3 秒(2026-09-23,使用者裁示:練習維持按了就開始)。
     ⚠ 倒數扣的是 onFrame 的 dt,**不是**牆上時鐘 —— 暫停與蓋板都會停掉 onFrame,
       倒數才會跟著停;用 performance.now() 算的話關掉蓋板時倒數早就跑完了。
     CD_TAIL = 歸零之後再扣多久(盤面上的「開始!」要靠負數畫完,board.js CD_GO_MS 是 650)。 */
  const CD_MS = 3000, CD_TAIL = 1000;

  /* 強度 band → 名單。⚠ 天花板原則:只能往下配(同方塊對戰使用者裁示) */
  const MIX = {
    easy: ["easy", "easy", "easy"],
    norm: ["norm", "easy", "norm"],
    hard: ["hard", "norm", "hard"]
  };
  let customLvs = ["norm", "easy", "hard"];

  let mode = "endless";                 // "endless" | "vs"
  let lvKey = "norm";
  let foeN = 1;
  let vs = { mode: "ko", secs: 180, shield: 20, target: "rand", rush: false };
  let rec = { best: 0, win: 0, lose: 0 };

  let st = null, me = null, foes = [];
  let on = false, paused = false, ended = false;
  let took = 0, hudT = 0, cdLeft = 0;
  let clock = 0, endMs = 0, rushOn = false;
  let lockTarget = null, streak = null, winnerId = "", foeVsFoe = 0;

  function ms(){ return st ? st.time : 0; }

  /* ---------- 存檔 ---------- */
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(o.mode === "endless" || o.mode === "vs") mode = o.mode;
      if(o.lv === "custom") lvKey = "custom";
      else if(o.lv) lvKey = BUBAI.levelOf(o.lv).key;
      if(Array.isArray(o.customLvs)) customLvs = o.customLvs.map(k => BUBAI.levelOf(k).key);
      if(typeof o.foeN === "number") foeN = Math.max(1, Math.min(FOE_MAX, o.foeN | 0));
      if(o.vs){ const r = BUB.normRules(o.vs); vs = { mode: r.mode, secs: r.secs, shield: [0, 10, 20].indexOf(o.vs.shield) >= 0 ? o.vs.shield : 20, target: r.target, rush: r.rush }; }
      if(o.rec) rec = { best: o.rec.best | 0, win: o.rec.win | 0, lose: o.rec.lose | 0 };
    }catch(e){}
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ mode, lv: lvKey, customLvs, foeN, vs, rec })); }catch(e){}
  }

  /* ---------- 設定 ---------- */
  function setMode(m){ if(m === "endless" || m === "vs"){ mode = m; saveOwn(); } }
  function setLevel(v){ lvKey = (v === "custom") ? "custom" : BUBAI.levelOf(v).key; saveOwn(); }
  function setCustomLevel(idx, v){
    idx = Math.max(0, Math.min(FOE_MAX - 1, idx | 0));
    customLvs[idx] = BUBAI.levelOf(v).key;
    saveOwn();
  }
  function setFoeN(v){ foeN = Math.max(1, Math.min(FOE_MAX, v | 0)); saveOwn(); }
  /* ⚠ shield 在這裡存的是**秒**(0 / 10 / 20,與大廳的鈕一樣),開局才乘 1000 */
  function setVs(k, v){
    const next = Object.assign({}, vs);
    next[k] = v;
    const r = BUB.normRules(Object.assign({}, next, { shield: 0 }));
    vs = { mode: r.mode, secs: r.secs, shield: [0, 10, 20].indexOf(+next.shield) >= 0 ? +next.shield : 20,
           target: r.target, rush: r.rush };
    saveOwn();
  }
  function lineup(){
    const out = [];
    if(lvKey === "custom"){
      for(let i = 0; i < foeN; i++) out.push(BUBAI.levelOf(customLvs[i] || "norm"));
      return out;
    }
    const list = MIX[lvKey] || MIX.norm;
    for(let i = 0; i < foeN; i++) out.push(BUBAI.levelOf(list[i % list.length]));
    return out;
  }

  /* ---------- 開局 ---------- */
  function start(){
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const rules = (mode === "vs")
      ? { mode: vs.mode, secs: vs.secs, shield: vs.shield * 1000, combo: true }
      : { mode: "out", shield: 0 };
    st = BUB.blank({ seed: seed, rules: rules });
    me = { id: "me", name: "你", st: st, ko: 0, lastBy: "", deadT: 0, got: 0 };
    foes = [];
    clock = 0; endMs = 0; rushOn = false; streak = null; lockTarget = null; winnerId = ""; foeVsFoe = 0;
    document.body.classList.remove("bub-rush");
    BUBB.clearCast();
    if(mode === "vs"){
      const lv = lineup();
      /* ★ 每一台電腦用**同一顆 seed** —— 開局盤面與發射序列一樣才叫公平 */
      for(let i = 0; i < lv.length; i++){
        foes.push({
          id: "cpu" + (i + 1),
          name: (lv.length > 1) ? (lv[i].emoji + " 電腦" + (i + 1)) : (lv[i].emoji + " " + lv[i].name),
          st: BUB.blank({ seed: seed, rules: rules }),
          mem: BUBAI.newMem(), lv: lv[i], ko: 0, lastBy: "", deadT: 0, got: 0, fx: null
        });
      }
      endMs = (vs.mode === "ko") ? vs.secs * 1000 : 0;
      BUBB.setFoes(foes);
    }else{
      BUBB.setFoes([]);
    }
    on = true; paused = false; ended = false;
    took = 0; hudT = 0;
    cdLeft = (mode === "vs") ? CD_MS : 0;
    BUBB.setState(st);
    if(cdLeft > 0) BUBB.countdown(() => cdLeft);     // ⚠ 要在 setState 之後(setState 會清掉倒數)
    BUBB.play();
    showScreen("solo");
    paintBar();
    paintHud();
    if(typeof Sound !== "undefined" && Sound.start) Sound.start();
  }
  function again(){ closeWin(); start(); }
  function quit(){
    on = false; ended = true;
    BUBB.stop();
    BUBB.setFoes([]);
    BUBB.clearCast();
    document.body.classList.remove("bub-rush");
    closeWin();
    showScreen("home");
  }

  /* ---------- 參賽者(me 與 foes 走同一套查詢)---------- */
  function parts(){ return me ? [me].concat(foes) : []; }
  function partOf(id){
    if(!me) return null;
    if(id === "me") return me;
    for(let i = 0; i < foes.length; i++) if(foes[i].id === id) return foes[i];
    return null;
  }
  function nameOf(id){ const p = partOf(id); return p ? p.name : id; }
  function foeIdx(id){
    for(let i = 0; i < foes.length; i++) if(foes[i].id === id) return i;
    return -1;
  }
  function aliveIds(exceptId){ return parts().filter(p => p.id !== exceptId && !p.st.dead).map(p => p.id); }
  /* 「第一名」的基準:K.O. 賽比 K.O. 數、淘汰賽比打掉的顆數 */
  function scoreOf(id){
    const p = partOf(id);
    if(!p) return 0;
    return (vs.mode === "ko") ? (p.ko || 0) : (p.st.popped || 0);
  }
  /* 優先序:手動鎖定 > 房規 > 隨機(⚠ 同分要隨機,取 [0] 會變成圍毆同一個) */
  function pickTarget(fromId){
    const alive = aliveIds(fromId);
    if(!alive.length) return null;
    if(fromId === "me" && lockTarget && alive.indexOf(lockTarget) >= 0) return lockTarget;
    if(vs.target === "high"){
      let best = -1;
      alive.forEach(id => { const v = scoreOf(id); if(v > best) best = v; });
      const top = alive.filter(id => scoreOf(id) === best);
      return top[Math.floor(Math.random() * top.length)];
    }
    return alive[Math.floor(Math.random() * alive.length)];
  }

  function togglePause(){
    if(!on || ended) return;
    paused = !paused;
    if(paused) BUBB.pause(); else BUBB.play();
    paintHud();
    showToast(paused ? "已暫停 —— 再按一次繼續" : "繼續");
  }

  /* ---------- 每一幀:推進電腦 ----------
     ⚠ 電腦的 tick 也要走 —— 只推 AI 不 tick 的話它射出去的泡泡永遠不會落地。 */
  function onFrame(dt){
    if(!on || ended || paused) return;
    if(cdLeft > -CD_TAIL){
      const was = cdLeft;
      cdLeft -= dt;
      if(was > 0) return;                          // 倒數中:電腦不動、時鐘不走(自己的盤面由 counting() 擋)
    }
    hudT += dt;
    if(hudT >= 250){ hudT = 0; paintHud(); }       // ⚠ 一定要在「有沒有電腦」之前(方塊對戰踩過)
    if(mode !== "vs" || !foes.length) return;
    clock += dt;
    stepRush();
    for(let i = 0; i < foes.length; i++){
      const f = foes[i];
      if(f.st.dead) continue;
      if(f.fx) f.fx.t += dt;
      const parBefore = f.st.par;
      const evs = BUBAI.step(f.st, f.mem, dt, f.lv).concat(BUB.tick(f.st, dt));
      for(let j = 0; j < evs.length; j++){
        const ev = evs[j];
        if(!ev || (ev.t !== "land" && ev.t !== "press")) continue;   // press:照時間的壓力插排也可能把人擠死
        if(ev.pops && ev.pops.length)
          f.fx = { pops: ev.pops, par: parBefore, t: 0 };
        if(ev.out > 0) sendFrom(f.id, ev);
        if(ev.dead || f.st.dead){ onDeath(f.id); break; }
      }
    }
    stepRespawn(dt);
    checkEnd();
  }
  function stepRush(){
    if(vs.mode !== "ko" || !vs.rush || !endMs) return;
    const was = rushOn;
    rushOn = (endMs - clock) <= RUSH_MS;
    if(rushOn === was) return;
    parts().forEach(p => { p.st.rush = rushOn; });
    document.body.classList.toggle("bub-rush", rushOn);
    if(rushOn) BUBB.cast("⏱️ 最後 30 秒 —— 攻擊加倍!", "streak");
  }
  function stepRespawn(dt){
    if(vs.mode !== "ko") return;
    parts().forEach(p => {
      if(!p.st.dead) return;
      p.deadT += dt;
      if(p.deadT < RESPAWN_MS) return;
      BUB.revive(p.st);
      p.st.shield = 1500;
      p.st.rush = rushOn;
      p.deadT = 0;
      if(p.mem){ p.mem.target = null; p.mem.k = -1; }
      if(p.id === lockTarget){
        foes.forEach(x => { x.target = (lockTarget === x.id && !x.st.dead); });
        paintTargetStat();
      }
    });
  }
  function sendFrom(fromId, ev){
    const forced = ev.to && aliveIds(fromId).indexOf(ev.to) >= 0 ? ev.to : null;
    const toId = forced || pickTarget(fromId);
    if(!toId) return;
    hit(toId, ev.out, fromId, !!ev.revenge);
  }
  /* ⚠ 垃圾顏色的種子由**送出端**決定(接收端不可以自己重抽) */
  function hit(toId, n, fromId, revenge){
    const t = partOf(toId);
    if(!t) return;
    const gs = (Math.random() * 0xffffffff) >>> 0;
    const accepted = BUB.queueGarbage(t.st, n, gs, fromId);
    if(accepted > 0){ t.lastBy = fromId; t.got = (t.got || 0) + accepted; }
    if(fromId !== "me" && toId !== "me") foeVsFoe += n;
    const i = foeIdx(fromId), j = foeIdx(toId);
    if(fromId === "me" && j >= 0){
      BUBB.beamOut(j, n, revenge);
      if(revenge) BUBB.pop("反擊 ×2", "#ff5d6c", 0.86);
    }else if(toId === "me" && i >= 0){
      if(accepted === 0) BUBB.beamShield(i, nameOf(fromId));
      else BUBB.beamIn(i, accepted, nameOf(fromId));
      if(accepted > 0 && accepted < n) BUBB.pop("手下留情 −" + (n - accepted) + " 排", "#48dbfb", 0.7);
    }else if(i >= 0 && j >= 0){
      BUBB.beamFoe(i, j, n);
    }
  }

  function onDeath(id){
    const p = partOf(id);
    if(!p) return;
    const killer = p.lastBy;
    if(killer && killer !== id){
      const k = partOf(killer);
      if(k) k.ko = (k.ko || 0) + 1;
      BUBB.cast(nameOf(killer) + " 💥 K.O. " + nameOf(id), "ko");
      noteStreak(killer);
    }else{
      BUBB.cast(nameOf(id) + " 自己被壓爆了 😵", "ko");
      streak = null;
    }
    p.lastBy = "";
    p.deadT = 0;
    if(lockTarget === id){
      if(vs.mode === "out"){
        lockTarget = null;
        showToast(nameOf(id) + " 已淘汰,改回" + (vs.target === "high" ? "打第一名" : "隨機攻擊"));
      }
      foes.forEach(x => { x.target = (lockTarget === x.id && !x.st.dead); });
      paintTargetStat();
    }
  }
  function noteStreak(id){
    if(streak && streak.id === id && (clock - streak.t) <= STREAK_MS) streak.n++;
    else streak = { id: id, n: 1, t: clock };
    streak.t = clock;
    const w = STREAK_WORD[Math.min(streak.n, STREAK_WORD.length - 1)];
    if(w) setTimeout(() => { if(on && !ended) BUBB.cast(nameOf(id) + " " + w, "streak"); }, 460);
  }

  function checkEnd(){
    if(ended) return;
    if(vs.mode === "ko"){
      if(endMs && clock >= endMs) finishKo();
      return;
    }
    if(me.st.dead){ finish(false, ""); return; }
    if(foes.every(f => f.st.dead)){ finish(true, "me"); return; }
  }
  function finishKo(){
    let best = -1;
    parts().forEach(p => { const v = p.ko || 0; if(v > best) best = v; });
    const top = parts().filter(p => (p.ko || 0) === best);
    if(top.length > 1) finish(false, "draw");
    else finish(top[0].id === "me", top[0].id);
  }

  /* ---------- 我的規則事件 ---------- */
  function onEvents(evs){
    if(!on || ended) return;
    for(let i = 0; i < evs.length; i++){
      const ev = evs[i];
      if(ev.t !== "land" && ev.t !== "press") continue;   // press:照時間的壓力插排(沒有球在飛時)
      if(mode === "vs" && ev.out > 0) sendFrom("me", ev);
      if(ev.dead || st.dead){
        if(mode === "vs"){
          onDeath("me");
          checkEnd();
          if(ended) return;
        }else{ finish(false, ""); return; }
      }
    }
    paintHud();
  }

  function finish(win, who){
    if(ended) return;
    ended = true; on = false;
    winnerId = who || "";
    took = Math.round(mode === "vs" ? clock : ms());
    document.body.classList.remove("bub-rush");
    BUBB.stop();
    let fresh = false;
    if(mode === "vs"){ if(win) rec.win++; else rec.lose++; }
    else if(st.popped > rec.best){ rec.best = st.popped; fresh = true; }
    saveOwn();
    paintBar();
    paintResult(win, fresh);
    const good = win || fresh;           // 練習破紀錄那一局是好事(同方塊對戰)
    if(typeof Sound !== "undefined"){
      if(good && Sound.win) Sound.win(); else if(Sound.lose) Sound.lose();
    }
    if(good && typeof burst === "function") burst();
    setTimeout(showResult, 260);
  }

  /* ---------- 畫面 ---------- */
  function timeTxt(ms){
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return m ? (m + ":" + String(s % 60).padStart(2, "0")) : (s + "." + String(Math.floor(ms % 1000 / 100)) + " 秒");
  }
  function paintHud(){
    if(!st) return;
    const set = (id, v) => { const el = $(id); if(el) el.textContent = v; };
    set("bubStatPop", st.popped);
    if(mode === "vs" && vs.mode === "ko" && endMs){
      const left = Math.max(0, Math.round((endMs - (ended ? took : clock)) / 1000));
      set("bubStatTime", Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"));
    }else{
      set("bubStatTime", timeTxt(ended ? took : (mode === "vs" ? clock : ms())));
    }
    set("bubStatLv", BUB.level(st));
    const pressLeft = Math.max(1, Math.ceil(BUB.pressLeft(st) / 1000));   // 秒
    set("bubStatPress", pressLeft);
    const pressBox = $("bubStatPressBox");
    if(pressBox) pressBox.classList.toggle("bub-stat-press-hot", pressLeft <= 3);
    const goal = $("bubGoal");
    if(goal) goal.textContent = (mode !== "vs") ? "無盡"
                              : (vs.mode === "ko") ? ("K.O. ×" + (me ? me.ko : 0)) : "淘汰賽";
    paintTargetStat();
    const p = $("bubPaused");
    if(p){ p.textContent = "已暫停"; p.classList.toggle("hidden", !paused); }
  }
  function paintTargetStat(){
    const box = $("bubStatTgtBox"), val = $("bubStatTgt");
    if(!box || !val) return;
    const show = (mode === "vs") && foes.length >= 2;
    box.classList.toggle("hidden", !show);
    if(!show) return;
    const lockedAlive = !!(lockTarget && partOf(lockTarget) && !partOf(lockTarget).st.dead);
    const txt = lockedAlive ? nameOf(lockTarget) : ((vs.target === "high") ? "👑第一" : "隨機");
    if(val.textContent !== txt) val.textContent = txt;
    box.classList.toggle("bub-stat-lock", lockedAlive);
  }
  function tapFoe(i){
    const f = foes[i];
    if(!f || mode !== "vs") return;
    lockTarget = (lockTarget === f.id) ? null : f.id;
    showToast(lockTarget ? ("只打 " + f.name) : ("改回" + (vs.target === "high" ? "打第一名" : "隨機攻擊")));
    foes.forEach(x => { x.target = (lockTarget === x.id && !x.st.dead); });
    BUBB.setFoes(foes);
    paintTargetStat();
  }
  function paintBar(){
    const el = $("bubSoloRec");
    if(el) el.textContent = (mode === "vs")
      ? ((rec.win + rec.lose) ? (rec.win + " 勝 " + rec.lose + " 敗") : "還沒有紀錄")
      : (rec.best ? ("最多 " + rec.best + " 顆") : "還沒有紀錄");
    const t = $("bubSoloMode");
    if(t) t.textContent = (mode === "vs") ? ("對電腦 ×" + foeN) : "練習";
  }
  function paintResult(win, fresh){
    const word = $("winWord"), msg = $("winMsg"), box = $("bubResult");
    const ko = (mode === "vs" && vs.mode === "ko");
    if(word) word.textContent = (mode !== "vs") ? "被壓爆了"
                              : (winnerId === "draw") ? "平手" : (win ? "你贏了!" : "你輸了");
    if(msg) msg.textContent = (mode === "vs")
      ? (ko ? ("你 K.O. 了 " + (me ? me.ko : 0) + " 次" +
               (winnerId && winnerId !== "draw" && winnerId !== "me" ? " —— 冠軍是 " + nameOf(winnerId) : ""))
            : ((win ? "把電腦全部壓爆了 —— " : "被壓爆了 —— ") + "撐了 " + timeTxt(took)))
      : ("撐了 " + timeTxt(took) + ",打掉 " + st.popped + " 顆");
    if(box){
      box.classList.remove("hidden");
      const foeRows = (mode === "vs")
        ? foes.map(f => row(f.name, (ko ? ("K.O. " + (f.ko || 0) + " · ") : "") + f.st.popped + " 顆")).join("")
        : "";
      box.innerHTML =
        (ko ? row("我的 K.O.", (me ? me.ko : 0) + " 次") : "") +
        row("打掉", st.popped + " 顆") +
        row("送出", st.sent + " 排") +
        (mode === "vs" ? row("被塞", (me ? me.got : 0) + " 排") : row("射了", st.shots + " 發")) +
        row("時間", timeTxt(took)) +
        foeRows +
        (fresh ? '<div class="bub-fresh">🎉 新紀錄!</div>' : "");
    }
  }
  function row(k, v){ return '<div class="bub-rrow"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>"; }

  return {
    start, again, quit, togglePause, onEvents, onFrame, loadOwn, paintBar, paintHud,
    setMode, setLevel, setCustomLevel, setFoeN, setVs, tapFoe,
    mode: () => mode,
    level: () => lvKey, customLvs: () => customLvs.slice(), rec: () => rec,
    foeN: () => foeN, vs: () => vs, lineup: lineup,
    parts: () => parts(),
    foeVsFoe: () => foeVsFoe,
    FOE_MAX,
    playing: () => on && !ended,
    active: () => on,
    paused: () => paused,
    counting: () => on && cdLeft > 0,
    state: () => st
  };
})();

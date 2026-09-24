"use strict";

/* ============================================================================
   方塊對戰 — 單機(Solo)

   三種玩法(規則完全同一份,差別只有「什麼時候結束」與「有沒有對手」):
     · 練習(無盡)—— 玩到堆爆為止,記最高消行數
     · 40 行競速 —— 消滿 40 行,記最短時間
     · 對電腦     —— **1~3 台電腦**,整組連線房規照搬(v2.15.4)

   ★ 「對電腦」與連線對戰**走同一條顯示路徑**(BLKB.setFoes / beamOut / beamIn /
     cast)—— 所以對手小盤、攻擊光束、KO 標記、現場播報這些東西只有一份實作。

   ── ★★★ v2.15.4:「像連線那樣」的四條 ────────────────────────────────────
     使用者:「單機練習跟電腦玩的部份,我希望可以像連線那樣的感覺,讓我可以選幾個
     電腦,這樣就可以順便測試對戰的刺激感。」→ 所以這裡**刻意不做一套簡化版規則**:

     ① **房規整組照搬**(賽制 / 一局多久 / 開局暖身 / 攻擊目標 / 最後 30 秒),
        而且文案共用 `BLK.NOTES` —— 不另外抄一份(那是會靜靜過期的雙胞胎)。
     ② **電腦會互打。** 三台電腦不是三個只打你的沙包 —— 它們照同一套 pickTarget()
        互相選目標,不然「三個人在場」的感覺整個不見(而那正是要測的東西)。
     ③ **K.O. 賽的時鐘不可以讀 `st.time`。** 我死掉的那兩秒 `R.tick(st)` 不會被呼叫
        (board.js 的 frame 擋著)→ `st.time` 會凍住,比賽時間跟著停。這裡另外累一個
        `clock`(在 onFrame 裡加,暫停與蓋板天然不算)。
     ④ **每一台電腦各有各的死亡計時**,復活要各算各的 —— 共用一個計時器的話
        兩台同時死就會一起復活,而它們的盤面狀況完全不同。
   ─────────────────────────────────────────────────────────────────────────

   ⚠ 這一支不碰 Canvas、不碰按鍵 —— 那些全部在 board.js。
     它只做五件事:開局、推進電腦、把規則事件翻成 HUD 與音效、判定結束、記錄戰績。
   ========================================================================== */

const Solo = (function(){

  const OWN_KEY = "blocks.solo.v1";     // ⚠ 獨立 key,不與 bingo.prefs.v1 那組互相覆蓋
  const SPRINT_LINES = 40;
  const FOE_MAX = 3;                    // 最多幾台電腦(= 連線的 maxPlayers 4 減掉自己)
  const RESPAWN_MS = 2000;              // K.O. 賽死了多久復活(與連線同一個數字)
  const RUSH_MS = 30000;                // 「最後 30 秒」是最後幾毫秒
  const STREAK_MS = 12000;
  const STREAK_WORD = ["", "", "雙殺!", "三殺!", "四殺!!", "大殺特殺!!!"];

  /* ★★ 強度 band → 一份「配幾台、各是什麼難度」的名單(v2.15.4,使用者裁示「自動混搭」)。
     ⚠⚠ **每一列的第一個是「代表」** —— 只選 1 台時拿到的就是它,所以 `norm` 的第一個
       一定要是 `norm`。排序寫錯的話「選普通卻配到高手」,而畫面上完全看不出來
       (名單有印出來,但沒有人會去對)。
     ★ 混搭的用意:三台一樣強的電腦只是同一個對手複製三份 —— 而要測的正是
       「實力參差時好不好玩」與「👑 打第一名」這條房規有沒有用。
     ⚠⚠ **天花板原則**(使用者裁示):混搭只能往下配,**絕不可以配出比所選更強的電腦**
       (輕鬆 = 全部輕鬆、普通最高普通、硬仗最高硬仗)。要指定每一台就選「🛠️ 自訂」(customLvs)。
       守門在 test-blocks-rules / t-blk-solo-e2e。 */
  const MIX = {
    easy: ["easy", "easy", "easy"],
    norm: ["norm", "easy", "norm"],
    hard: ["hard", "norm", "hard"]
  };
  let customLvs = ["norm", "easy", "hard"]; // 自訂名單時每台電腦的強度

  let mode = "endless";                 // "endless" | "sprint" | "vs"
  let lvKey = "norm";                   // 電腦強度(band,見 MIX,或 "custom")
  let foeN = 1;                         // 幾台電腦
  /* 對戰房規 —— **與連線同一組欄位、同一組文案**(BLK.NOTES)。
     ⚠ 預設值刻意跟連線一樣(K.O. 賽 / 3 分 / 暖身 20 秒)—— 使用者要的是
       「像連線那樣的感覺」,預設值不一樣就不是同一個東西了。 */
  /* ★ hc = 「🐣 讓我一點」(rules.js 紅線 ⑤)。單機沒有房主 → 開了就等於「開放 + 我選了」;
       電腦**永遠不讓分**(讓分是給人用的旋鈕,電腦的強弱在「電腦強度」那一格)。 */
  let vs = { mode: "ko", secs: 180, shield: 20, target: "rand", rush: false, hc: false };
  let rec = { best: 0, sprint: 0, win: 0, lose: 0 };

  let st = null;                        // 我的狀態
  /* 參賽者:me + 1~3 台電腦。每一個都是
     { id, name, st, mem, lv, ko, lastBy, deadT }(me 沒有 mem / lv)。
     ⚠ `lastBy` 是「最後打我的人」—— K.O. 記給誰看它,**不可以看 `st.revBy`**:
       那個欄位在反擊用掉之後會被清空,而人常常是在反擊之後才死的。 */
  let me = null, foes = [];
  let on = false, paused = false, ended = false;
  let took = 0;                         // 這一局花了幾 ms(結果卡與紀錄用)
  let hudT = 0;                         // HUD 的重畫節流
  /* ★★★ K.O. 賽的比賽時鐘。**不可以讀 `st.time`** —— 我死掉的那兩秒
     `R.tick(st)` 不會被呼叫(board.js 的 frame 擋著 `!st.dead`)→ `st.time` 會凍住,
     比賽時間跟著停,三條命就能把 3 分鐘拖成 3 分半。
     ⚠ 累在 onFrame 裡 → 暫停與蓋板那幾段天然不算(那一條判斷在呼叫端)。 */
  let clock = 0, endMs = 0, rushOn = false;
  let lockTarget = null;                // 手動鎖定的攻擊目標(點小盤,同連線)
  let streak = null;                    // 連殺:{ id, n, t }
  let winnerId = "";                    // 這一局誰贏(K.O. 賽結算用,"draw" = 平手)
  let foeVsFoe = 0;                     // 這一局「電腦打電腦」共幾行(守設定頁那句話,見 hit())

  /* ★★ 計時一律讀 `st.time`,**不要用 performance.now() - t0**。
     `st.time` 是規則層在 tick() 裡累積的 dt,而 tick() 只有在 canPlay() 成立時才會被推
     → **暫停、開著設定蓋板、切到背景那幾段天然就不算**。
     用 wall clock 的話三件事會一起錯:暫停時間被算進 40 行競速的紀錄、
     暫停中那一欄顯示 `took || 0`(還沒結束 → 「0.0 秒」)、切背景回來時間直接跳一大段。 */
  function ms(){ return st ? st.time : 0; }

  /* ---------- 存檔 ---------- */
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(o.mode === "sprint" || o.mode === "endless" || o.mode === "vs") mode = o.mode;
      if(o.lv === "custom" || o.lv === "easy" || o.lv === "norm" || o.lv === "hard") lvKey = o.lv;
      else if(o.lv) lvKey = BLKAI.levelOf(o.lv).key;
      if(Array.isArray(o.customLvs)) customLvs = o.customLvs.map(k => BLKAI.levelOf(k).key);
      if(typeof o.foeN === "number") foeN = Math.max(1, Math.min(FOE_MAX, o.foeN | 0));
      /* ⚠ 存下來的房規一律過一次 normRules() —— 它是使用者的 localStorage,
         可能是舊版本寫的、也可能被手動改壞。壞值退回預設是規則層的事。 */
      if(o.vs) vs = BLK.normRules(o.vs);
      if(o.rec) rec = { best: o.rec.best | 0, sprint: o.rec.sprint | 0,
                        win: o.rec.win | 0, lose: o.rec.lose | 0 };
    }catch(e){}
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY,
      JSON.stringify({ mode, lv: lvKey, customLvs, foeN, vs, rec })); }catch(e){}
  }

  /* ---------- 設定 ---------- */
  function setMode(m){ if(m === "sprint" || m === "endless" || m === "vs"){ mode = m; saveOwn(); } }
  function setLevel(v){
    if(v === "custom") lvKey = "custom";
    else lvKey = BLKAI.levelOf(v).key;
    saveOwn();
  }
  function setCustomLevel(idx, v){
    idx = Math.max(0, Math.min(FOE_MAX - 1, idx | 0));
    customLvs[idx] = BLKAI.levelOf(v).key;
    saveOwn();
  }
  function setFoeN(v){ foeN = Math.max(1, Math.min(FOE_MAX, v | 0)); saveOwn(); }
  /* 一格房規。⚠ 一律走 normRules() 再寫回去 —— 不要各欄位自己驗一次
     (那就是第二份驗證邏輯,而它遲早會跟規則層分岔)。 */
  function setVs(k, v){
    const next = Object.assign({}, vs);
    next[k] = v;
    vs = BLK.normRules(next);
    saveOwn();
  }
  /* 這一局會配出哪幾台電腦(設定頁的那一行文案與開局都讀它)。 */
  function lineup(){
    if(lvKey === "custom"){
      const out = [];
      for(let i = 0; i < foeN; i++){
        const k = customLvs[i] || "norm";
        out.push(BLKAI.levelOf(k));
      }
      return out;
    }
    const list = MIX[lvKey] || MIX.norm;
    const out = [];
    for(let i = 0; i < foeN; i++) out.push(BLKAI.levelOf(list[i % list.length]));
    return out;
  }

  /* ---------- 開局 ---------- */
  function start(){
    const seed = (Math.random() * 0xffffffff) >>> 0;
    /* 練習與 40 行競速沒有對手 → 用「淘汰、不開暖身」;對電腦用**整組房規**。
       ⚠ 規則只有一份,不另做一套「單機規則」。 */
    const rules = (mode === "vs")
      ? { mode: vs.mode, secs: vs.secs, shield: vs.shield * 1000, combo: true, hc: !!vs.hc }
      : { mode: "out", shield: 0 };
    st = BLK.blank({ seed: seed, rules: rules, hc: mode === "vs" && !!vs.hc });
    me = { id: "me", name: "你", st: st, ko: 0, lastBy: "", deadT: 0, got: 0 };
    foes = [];
    clock = 0; endMs = 0; rushOn = false; streak = null; lockTarget = null; winnerId = ""; foeVsFoe = 0;
    document.body.classList.remove("blk-rush");
    BLKB.clearCast();
    if(mode === "vs"){
      const lv = lineup();
      /* ★ 每一台電腦用**同一顆 seed** —— 出塊序列一樣才叫公平(與連線對戰同一條規矩)。
         ⚠ 名字要帶編號:三台混搭時會有兩台同一個難度,只印難度名就分不出誰是誰
           (而「誰快爆了」的播報印的正是這個名字)。 */
      for(let i = 0; i < lv.length; i++){
        foes.push({
          id: "cpu" + (i + 1),
          name: (lv.length > 1) ? (lv[i].emoji + " 電腦" + (i + 1)) : (lv[i].emoji + " " + lv[i].name),
          st: BLK.blank({ seed: seed, rules: rules }),
          mem: BLKAI.newMem(), lv: lv[i], ko: 0, lastBy: "", deadT: 0, got: 0
        });
      }
      endMs = (vs.mode === "ko") ? vs.secs * 1000 : 0;
      BLKB.setFoes(foes);
    }else{
      BLKB.setFoes([]);
    }
    on = true; paused = false; ended = false;
    took = 0; hudT = 0;
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
    BLKB.clearCast();
    document.body.classList.remove("blk-rush");
    closeWin();
    showScreen("home");
  }

  /* ---------- 參賽者 ----------
     ⚠ me 與 foes 走同一套查詢 —— 「我」在規則上與電腦沒有任何不同,
       分兩條路寫的下場是每加一個機制就要記得補兩次(連線那邊已經示範過)。 */
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
  function aliveIds(exceptId){
    return parts().filter(p => p.id !== exceptId && !p.st.dead).map(p => p.id);
  }
  /* 「第一名」的基準要跟著賽制走(同連線的 pickTarget):
     K.O. 賽比 K.O. 數、淘汰賽比消行數。 */
  function scoreOf(id){
    const p = partOf(id);
    if(!p) return 0;
    return (vs.mode === "ko") ? (p.ko || 0) : (p.st.lines || 0);
  }
  /* 誰打誰。優先序與連線一模一樣:**手動鎖定 > 房規 > 隨機**。
     ⚠ 手動鎖定只對「我」成立 —— 電腦沒有手,它們一律照房規。 */
  function pickTarget(fromId){
    const alive = aliveIds(fromId);
    if(!alive.length) return null;
    if(fromId === "me" && lockTarget && alive.indexOf(lockTarget) >= 0) return lockTarget;
    if(vs.target === "high"){
      let best = -1;
      alive.forEach(id => { const v = scoreOf(id); if(v > best) best = v; });
      const top = alive.filter(id => scoreOf(id) === best);
      return top[Math.floor(Math.random() * top.length)];   // ⚠ 同分要隨機,取 [0] 會變成圍毆同一個
    }
    return alive[Math.floor(Math.random() * alive.length)];
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
    if(!on || ended || paused) return;
    /* ⚠⚠ HUD 一定要在「有沒有電腦對手」**之前** —— 這裡本來第一行就是
       `… || !foe) return`,而練習與 40 行競速的 foe 是 null → 那條路每幀都早退,
       整局只剩 lock 事件會重畫一次 HUD。症狀:**計時器與「階」整局凍住**
       (實測停在 18.7 秒,2.5 秒後還是 18.7 秒),而 40 行競速比的正是時間。
       ★ 連線那一份一直是對的(adapter.js 的 onFrame 開頭那段),單機漏掉了。 */
    hudT += dt;
    if(hudT >= 250){ hudT = 0; paintHud(); }
    if(mode !== "vs" || !foes.length) return;

    clock += dt;
    stepRush();

    /* 推進每一台電腦。⚠ 電腦的重力也要走 —— 只推 AI 不 tick 的話它永遠不會被
       自己的重力壓死,而且垃圾行推上來的時機會與我這邊差一整顆。 */
    for(let i = 0; i < foes.length; i++){
      const f = foes[i];
      if(f.st.dead) continue;
      const evs = BLKAI.step(f.st, f.mem, dt, f.lv).concat(BLK.tick(f.st, dt));
      for(let j = 0; j < evs.length; j++){
        const ev = evs[j];
        if(!ev || ev.t !== "lock") continue;
        if(ev.out > 0) sendFrom(f.id, ev);
        if(ev.dead || f.st.dead){ onDeath(f.id); break; }
      }
    }
    stepRespawn(dt);
    checkEnd();
  }

  /* 最後 30 秒加倍。⚠ `st.rush` 要寫給**每一位參賽者**(規則層各算各的),
     少寫電腦那幾份的話就變成「只有你加倍」。 */
  function stepRush(){
    if(vs.mode !== "ko" || !vs.rush || !endMs) return;
    const was = rushOn;
    rushOn = (endMs - clock) <= RUSH_MS;
    if(rushOn === was) return;
    parts().forEach(p => { p.st.rush = rushOn; });
    document.body.classList.toggle("blk-rush", rushOn);
    if(rushOn) BLKB.cast("⏱️ 最後 30 秒 —— 攻擊加倍!", "streak");
  }

  /* K.O. 賽的復活。⚠ **每一位各算各的** —— 共用一個計時器的話兩台同時死就會
     一起復活,而它們的盤面狀況完全不同。 */
  function stepRespawn(dt){
    if(vs.mode !== "ko") return;
    parts().forEach(p => {
      if(!p.st.dead) return;
      p.deadT += dt;
      if(p.deadT < RESPAWN_MS) return;
      BLK.revive(p.st);
      p.st.shield = 1500;               // 剛活過來給一小段不吃垃圾(同連線)
      p.st.rush = rushOn;               // ⚠ revive 不碰 rush,但新的一條命也要跟著加倍
      p.deadT = 0;
      if(p.mem){ p.mem.target = null; p.mem.k = -1; }
      if(p.id === lockTarget){
        foes.forEach(x => { x.target = (lockTarget === x.id && !x.st.dead); });
        paintTargetStat();
      }
    });
  }

  /* 一方打另一方。⚠ 洞位由**送出端**決定(接收端不可以自己重抽)—— 與連線同一條規矩 */
  function sendFrom(fromId, ev){
    /* `ev.to` 是**反擊**指名的對象(規則層決定的),它比房規與手動鎖定都優先。 */
    const forced = ev.to && aliveIds(fromId).indexOf(ev.to) >= 0 ? ev.to : null;
    const toId = forced || pickTarget(fromId);
    if(!toId) return;
    hit(toId, ev.out, fromId, !!ev.revenge);
  }
  function hit(toId, n, fromId, revenge){
    const t = partOf(toId);
    if(!t) return;
    const hole = Math.floor(Math.random() * BLK.COLS);
    const r = BLK.receive(t.st, n, hole, fromId);    // ★ 讓分在這裡面(rules.js 紅線 ⑤)
    const accepted = r.got;
    if(accepted > 0){
      t.lastBy = fromId;
      t.got = (t.got || 0) + accepted;           // 被打了幾行(結果卡那一欄)
    }
    /* ★★ 「電腦之間也會互打」這句話**寫在設定頁上**,所以它要守得住。
       ⚠ 光看「電腦有沒有送出攻擊」是抓不到「電腦只打我」那個改壞法的
       —— 送出量照樣會長。要抓得到就得數「兩端都是電腦」的那幾筆。 */
    if(fromId !== "me" && toId !== "me") foeVsFoe += n;
    /* 光束三種走向。★ 電腦互打那一道(beamFoe)是刻意要畫的 ——
       沒有它的話三台電腦看起來只是三個各玩各的沙包,而「場上在互打」正是要測的東西。 */
    const i = foeIdx(fromId), j = foeIdx(toId);
    if(fromId === "me" && j >= 0){
      BLKB.beamOut(j, n, revenge);
      if(revenge) BLKB.pop("反擊 ×2", "#ff5d6c", 0.86);
    }else if(toId === "me" && i >= 0){
      if(accepted > 0) BLKB.beamIn(i, accepted, nameOf(fromId));
      else if(!r.cut) BLKB.beamShield(i, nameOf(fromId));
      if(r.cut) BLKB.pop("🐣 −" + r.cut + " 行", "#48dbfb", 0.7);
    }else if(i >= 0 && j >= 0){
      BLKB.beamFoe(i, j, n);
    }
  }

  /* ---------- 死亡與播報 ---------- */
  function onDeath(id){
    const p = partOf(id);
    if(!p) return;
    const killer = p.lastBy;
    if(killer && killer !== id){
      const k = partOf(killer);
      if(k) k.ko = (k.ko || 0) + 1;
      BLKB.cast(nameOf(killer) + " 💥 K.O. " + nameOf(id), "ko");
      noteStreak(killer);
    }else{
      /* 沒有人打他 —— 自己堆爆的。這一句要講出來,不然會以為是誰的功勞。 */
      BLKB.cast(nameOf(id) + " 自己堆爆了 😵", "ko");
      streak = null;
    }
    p.lastBy = "";
    p.deadT = 0;
    if(lockTarget === id){
      if(vs.mode === "out"){
        lockTarget = null;
        const fallback = (vs.target === "high") ? "打第一名" : "隨機攻擊";
        showToast(nameOf(id) + " 已淘汰，改回" + fallback);
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
    /* ⚠ 慢半拍再播:跟 K.O. 那一句同時出現的話兩句會擠在一起,反而兩句都沒看到。 */
    if(w) setTimeout(() => { if(on && !ended) BLKB.cast(nameOf(id) + " " + w, "streak"); }, 460);
  }

  /* ---------- 結束條件 ---------- */
  function checkEnd(){
    if(ended) return;
    if(vs.mode === "ko"){
      if(endMs && clock >= endMs) finishKo();
      return;
    }
    /* 淘汰賽:我死了就輸,電腦全死就贏 */
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
      if(ev.t !== "lock") continue;
      if(mode === "vs" && ev.out > 0) sendFrom("me", ev);
      if(mode === "sprint" && st.lines >= SPRINT_LINES){ finish(true, "me"); return; }
      if(ev.dead || st.dead){
        if(mode === "vs"){
          onDeath("me");
          checkEnd();                   // 淘汰賽在這裡就結束;K.O. 賽等 stepRespawn 把我救回來
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
    /* ⚠ 對電腦讀的是 `clock`(比賽時鐘),其餘兩種讀 `st.time` ——
       K.O. 賽我死掉的那幾秒 `st.time` 是凍住的,拿它當「撐了多久」會少算好幾秒。 */
    took = Math.round(mode === "vs" ? clock : ms());
    document.body.classList.remove("blk-rush");
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
    /* ★ 練習(無盡)沒有「贏」這回事 —— 它永遠走 finish(false),所以只看 win 的話
       **破紀錄那一局放的是失敗音效**,而結果卡上同時寫著「🎉 新紀錄!」。
       兩個訊號互相打架,而且聲音那一個比較大聲。破了紀錄就是好事。 */
    const good = win || fresh;
    if(typeof Sound !== "undefined"){
      if(good && Sound.win) Sound.win(); else if(Sound.lose) Sound.lose();
    }
    if(good && typeof burst === "function") burst();
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
    /* K.O. 賽是**倒數**(同連線),其餘兩種是正數的經過時間。 */
    if(mode === "vs" && vs.mode === "ko" && endMs){
      const left = Math.max(0, Math.round((endMs - (ended ? took : clock)) / 1000));
      set("blkStatTime", Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"));
    }else{
      set("blkStatTime", timeTxt(ended ? took : (mode === "vs" ? clock : ms())));
    }
    set("blkStatLv", BLK.level(st));
    const goal = $("blkGoal");
    if(goal) goal.textContent = (mode === "sprint") ? ("目標 " + SPRINT_LINES + " 行")
                              : (mode !== "vs") ? "無盡"
                              : (vs.mode === "ko") ? ("K.O. ×" + (me ? me.ko : 0)) : "淘汰賽";
    paintTargetStat();
    const p = $("blkPaused");
    if(p) p.classList.toggle("hidden", !paused);
  }
  /* 「我現在打誰」—— 與連線同一格 HUD、同一條規矩:**只在對手 ≥ 2 台時出現**
     (1 對 1 沒有可選的東西,而那一列在 360px 上很緊)。 */
  function paintTargetStat(){
    const box = $("blkStatTgtBox"), val = $("blkStatTgt");
    if(!box || !val) return;
    const show = (mode === "vs") && foes.length >= 2;
    box.classList.toggle("hidden", !show);
    if(!show) return;
    const lockedAlive = !!(lockTarget && partOf(lockTarget) && !partOf(lockTarget).st.dead);
    let txt = "";
    if(lockedAlive){
      txt = nameOf(lockTarget);
    }else{
      txt = (vs.target === "high") ? "👑第一" : "隨機";
    }
    if(val.textContent !== txt) val.textContent = txt;
    box.classList.toggle("blk-stat-lock", lockedAlive);
  }
  /* 點對手的小盤 = 指定只打他 / 改回隨機(與連線同一個動作) */
  function tapFoe(i){
    const f = foes[i];
    if(!f || mode !== "vs") return;
    const wasLocked = (lockTarget === f.id);
    lockTarget = wasLocked ? null : f.id;
    const fallback = (vs.target === "high") ? "打第一名" : "隨機攻擊";
    showToast(lockTarget ? ("只打 " + f.name) : ("改回" + fallback));
    foes.forEach(x => { x.target = (lockTarget === x.id && !x.st.dead); });
    BLKB.setFoes(foes);
    paintTargetStat();
  }
  function paintBar(){
    const el = $("blkSoloRec");
    if(el) el.textContent = (mode === "sprint")
      ? (rec.sprint ? ("最快 " + timeTxt(rec.sprint)) : "還沒有紀錄")
      : (mode === "vs") ? ((rec.win + rec.lose) ? (rec.win + " 勝 " + rec.lose + " 敗") : "還沒有紀錄")
      : (rec.best ? ("最高 " + rec.best + " 行") : "還沒有紀錄");
    const t = $("blkSoloMode");
    if(t) t.textContent = (mode === "sprint") ? (SPRINT_LINES + " 行競速")
                        : (mode === "vs") ? ("對電腦 ×" + foeN) : "練習";
  }
  function paintResult(win, fresh){
    const word = $("winWord"), msg = $("winMsg"), box = $("blkResult");
    const ko = (mode === "vs" && vs.mode === "ko");
    if(word) word.textContent = (mode !== "vs") ? (win ? "完成!" : "堆爆了")
                              : (winnerId === "draw") ? "平手"
                              : (win ? "你贏了!" : "你輸了");
    if(msg) msg.textContent = (mode === "vs")
      ? (ko ? ("你 K.O. 了 " + (me ? me.ko : 0) + " 次" +
               (winnerId && winnerId !== "draw" && winnerId !== "me"
                 ? " —— 冠軍是 " + nameOf(winnerId) : ""))
            : ((win ? "把電腦全部埋掉了 —— " : "被埋掉了 —— ") + "撐了 " + timeTxt(took)))
      : (mode === "sprint" && win)
        ? ("消滿 " + SPRINT_LINES + " 行,花了 " + timeTxt(took))
        : ("撐了 " + timeTxt(took) + ",消了 " + st.lines + " 行");
    if(box){
      box.classList.remove("hidden");
      /* ★ 對電腦的結果卡列出**每一台**的成績 —— 三台混搭時「誰把我打爆的」
         與「哪一台其實很弱」是這一局最想知道的兩件事。 */
      const foeRows = (mode === "vs")
        ? foes.map(f => row(f.name, (ko ? ("K.O. " + (f.ko || 0) + " · ") : "") + f.st.lines + " 行")).join("")
        : "";
      box.innerHTML =
        (ko ? row("我的 K.O.", (me ? me.ko : 0) + " 次") : "") +
        row("消行", st.lines + " 行") +
        row("送出", st.sent + " 行") +
        (mode === "vs" ? row("被打", (me ? me.got : 0) + " 行") : row("方塊", st.pieces + " 顆")) +
        row("時間", timeTxt(took)) +
        foeRows +
        (fresh ? '<div class="blk-fresh">🎉 新紀錄!</div>' : "");
    }
  }
  function row(k, v){
    return '<div class="blk-rrow"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>";
  }

  return {
    start, again, quit, togglePause, onEvents, onFrame, loadOwn, paintBar, paintHud,
    setMode, setLevel, setCustomLevel, setFoeN, setVs, tapFoe,
    mode: () => mode,
    level: () => lvKey, customLvs: () => customLvs.slice(), rec: () => rec,
    foeN: () => foeN, vs: () => vs, lineup: lineup,
    /* ★ 給測試 / 截圖頁看的:這一局場上有誰、各自幾 K.O.。 */
    parts: () => parts(),
    foeVsFoe: () => foeVsFoe,
    FOE_MAX,
    /* ★ ui-kit 的返回鍵守衛與更新檢查都會問這兩個 */
    playing: () => on && !ended,
    active: () => on,
    paused: () => paused,
    state: () => st,
    /* ⚠ 相容留著:v2.15.4 之前只有一台電腦,外面問的就是它。現在回第一台。 */
    foeState: () => (foes[0] ? foes[0].st : null),
    SPRINT_LINES
  };
})();

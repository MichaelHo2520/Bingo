"use strict";

/* ============================================================================
   方塊對戰 — 連線(MPCore adapter)

   ★ 這一頁與另外十三個遊戲**同步模型不一樣,而且是刻意的**:
     它是高頻、雙方同時運算的即時遊戲,不能把每一次按鍵走 `txGame`。
     採用「**本機權威的即時模擬 + 低頻棋盤快照 + 獨立攻擊事件**」:

       · 我的輸入、碰撞、重力、消行與 60 FPS 繪圖**全部在本機立即完成**
       · 每 110ms 送一份「落下中的那一顆」(12 bytes);盤面只在**事件時**送,
         外加每 2 秒無條件對帳一次(跳棋那一招)
       · 垃圾行攻擊走**獨立事件節點**,不塞進快照、也不走整包 game 交易
       · `game` 只放低頻資料:roundId / seed / startAt / 房規 / 死亡宣告 / winner

   ── ★★★ 八條會直接做錯的事 ───────────────────────────────────────────────
     ① **本機操作不等網路。** 任何按鍵要等 Firebase 往返才動 = 架構錯了。
     ② **高頻資料不進 `game`。** 每幀 / 每格移動 / 重力 tick 一律禁止 txGame。
     ③ **快照可以覆蓋,攻擊不可以。** 快照晚到就丟掉(看 seq);垃圾行是事件,
        少一筆就是少一波攻擊 → 必須有唯一 key 與可復原的 ack。
     ④ **`child_added` 會重放歷史。** 掛上去的那一刻 Firebase 會把現存的事件整批
        重播一次 → 沒有 roundId + 單調編號 + 存得住的 ack 就不能上線。
     ⑤ **攻擊事件的 key 是決定性的**(`from_roundId_n`)—— 重送 = 覆蓋 = 天然冪等。
        用 push() 的話斷線重送就會變成第二筆攻擊。
     ⑥ **`live` / `attacks` 走 `ctx.ref()`,吃不到核心的 `canWriteGame()` 閘門** ——
        所以這裡自備**唯一一道** canPublish();timer、visibility、結算全部都要經過它。
     ⑦ **同時死亡不可以比誰網路快。** 先進一段裁決窗,再用冪等交易結算。
     ⑧ **winner 的交易一定要 `{ local:false }`**(notes/07 踩坑 #8)——
        否則搶輸的那台會先樂觀看到「我贏」而多記一分,game 回退時分數不跟著退。

   ⚠ 洞位由**送出端**決定並寫進事件,接收端不得自行重抽(兩邊看到的洞必須一樣)。
   ========================================================================== */

const MP = MPCore.create((function(){

  const R = BLK;
  const PUB_MS   = 110;                 // 落下中那一顆的上傳間隔
  const FULL_MS  = 2000;                // 盤面的無條件對帳間隔
  const SETTLE_MS = 450;                // 同時死亡的裁決窗
  const LEAD_MS  = 3200;                // 開局倒數(要大於一次往返)

  let ctx = null;

  /* ---------- 大廳裡「下一局要用」的房規 ---------- */
  const SECS = [120, 180, 300];
  const SHIELDS = [0, 10, 20];
  const TARGETS = ["rand", "high"];
  let rules = { mode: "ko", secs: 180, shield: 20, target: "rand", rush: false };
  const RUSH_MS = 30000;                // 「最後 30 秒」是最後幾毫秒

  /* ---------- 一局 ---------- */
  let st = null;                        // 我的狀態(本機權威)
  let gRules = null, curRound = null, seed = 0, startAt = 0, endAt = 0;
  let order = [], playing = false, counting = false, over = false;
  let foes = {};                        // pid → { name, bd, c, p, ko, dead, seq, at }
  let lockTarget = null;                // 鎖定的攻擊目標(null = 隨機)
  let atkN = 0;                         // 我這一局送出的第幾筆攻擊
  const ackd = {};                      // from → 已經消費到第幾號
  let seq = 0, pubT = 0, fullT = 0, lastBoard = "";
  let myDeaths = 0, lastHitBy = "", deadAt = 0, settleT = null;
  let myKiller = "";                    // 我這一次是被誰打死的(要跟著快照送出去,見 announceKO)
  let streak = null;                    // 連殺:{ id, n, t }
  let liveRef = null, atkRef = null;
  let lastGame = null;                  // 最後一次收到的 game 快照(koOf / 結算查它)

  /* ==========================================================================
     一、唯一的發布閘門(紅線 ⑥)
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 所有 live / attacks / ack 寫入都要先過這裡。**不可以只在按鍵入口判** ——
         timer、visibilitychange、重連補推、結算也會發布。
     ========================================================================== */
  function canPublish(){
    if(!ctx || !ctx.me()) return false;
    if(ctx.spectating()) return false;                   // 觀戰者一個 byte 都不寫
    if(order.indexOf(ctx.me()) < 0) return false;        // 不在座位上
    if(!curRound || ctx.roundId() !== curRound) return false;
    return ctx.phase() === "playing";
  }
  function canPlay(){
    return !!(st && playing && !counting && !over && !st.dead && !ctx.spectating());
  }

  /* ==========================================================================
     二、房規
     ========================================================================== */
  const FIELDS = {
    mode:   { ok: v => v === "ko" || v === "out", get: () => rules.mode,   set: v => rules.mode = v },
    secs:   { ok: v => SECS.indexOf(v) >= 0,      get: () => rules.secs,   set: v => rules.secs = v },
    shield: { ok: v => SHIELDS.indexOf(v) >= 0,   get: () => rules.shield, set: v => rules.shield = v },
    target: { ok: v => TARGETS.indexOf(v) >= 0,   get: () => rules.target, set: v => rules.target = v },
    rush:   { ok: v => typeof v === "boolean",    get: () => rules.rush,   set: v => rules.rush = v }
  };
  function setMode(v){ if(FIELDS.mode.ok(v)) ctx.setRoomField("mode", v); }
  function setSecs(v){ v = +v; if(FIELDS.secs.ok(v)) ctx.setRoomField("secs", v); }
  function setShield(v){ v = +v; if(FIELDS.shield.ok(v)) ctx.setRoomField("shield", v); }
  function setTarget(v){ if(FIELDS.target.ok(v)) ctx.setRoomField("target", v); }
  function setRush(v){ v = !!v; if(FIELDS.rush.ok(v)) ctx.setRoomField("rush", v); }

  /* ★ 這裡本來有 setHcap()(每個人自己選的讓分)—— v2.15.2 整套拿掉了,見 rules.js 紅線 ⑤。 */

  /* ==========================================================================
     三、一局的生命週期
     ========================================================================== */
  function newGame(ids){
    /* ⚠ 順手把**上一局**的攻擊事件清掉。不清的話它們會一直留在這間房裡:
       `child_added` 每次掛上去都會把現存的整批重播一次(靠 rid 守衛擋得掉,但那個
       成本隨著局數一路長),而**房主離開時房間資料是刻意不刪的**(全專案紅線 5)
       → 這間房只要還在,攻擊事件就只進不出。
       ★ 這是純粹的清理,動不到正確性:新局的 roundId 不一樣,沒刪乾淨的也會被
         `a.rid !== curRound` 擋掉。只有房主會走到這裡。 */
    if(atkRef) atkRef.remove();
    /* 房主開局。⚠ startAt 用**伺服器時間**換算(見 nowSrv)—— 各台的系統時鐘差幾秒
       是常態,用本機時間的話有人會早開好幾秒。 */
    return {
      seed: (Math.random() * 0xffffffff) >>> 0,
      startAt: nowSrv() + LEAD_MS,
      rules: { mode: rules.mode, secs: rules.secs, shield: rules.shield * 1000,
               target: rules.target, rush: !!rules.rush },
      order: ids.slice(),
      topouts: {}, ko: {}, deaths: {}
    };
  }
  function resetRound(){
    clearSettle();
    st = null; gRules = null; curRound = null;
    playing = false; counting = false; over = false;
    foes = {}; lockTarget = null; atkN = 0; seq = 0;
    myDeaths = 0; lastHitBy = ""; deadAt = 0; lastBoard = "";
    myKiller = ""; streak = null;
    Object.keys(ackd).forEach(k => delete ackd[k]);
    BLKB.setFoes([]);
    BLKB.clearCast();
    const res = $("blkResult");
    if(res){ res.classList.add("hidden"); res.innerHTML = ""; }
    document.body.classList.remove("blk-spec", "blk-rush");
    banner("");
  }
  function lobbyGame(){ return { topouts: {}, ko: {}, deaths: {} }; }

  function applyGame(g, isPlaying){
    if(!g) return;
    order = g.order || [];
    if(isPlaying && g.roundId && g.roundId !== curRound) startRound(g);
    if(!isPlaying){ if(curRound) resetRound(); return; }
    if(!st) return;

    /* 別人的死亡宣告 / KO 數 → 只是拿來畫小盤與結算,不影響我的本機模擬 */
    paintFoes(g);
    if(g.winner && !over) finishRound(g);
    else if(!over) checkEnd(g);
  }

  function startRound(g){
    clearSettle();
    curRound = g.roundId;
    seed = g.seed >>> 0;
    /* ⚠ 舊版本開的房間沒有 target / rush 這兩個欄位 → 一定要有預設值,
       不然 pickTarget() 會讀到 undefined(退回隨機,剛好是對的)而 rush 變 NaN 判斷。 */
    gRules = g.rules || { mode: "ko", secs: 180, shield: 0 };
    if(gRules.target !== "high") gRules.target = "rand";
    gRules.rush = !!gRules.rush;
    startAt = g.startAt || nowSrv();
    endAt = (gRules.mode === "ko") ? startAt + gRules.secs * 1000 : 0;
    order = g.order || [];
    over = false; atkN = 0; seq = 0; myDeaths = 0; lastHitBy = ""; lastBoard = "";
    myKiller = ""; streak = null;
    Object.keys(ackd).forEach(k => delete ackd[k]);
    BLKB.clearCast();
    const res = $("blkResult");
    if(res){ res.classList.add("hidden"); res.innerHTML = ""; }
    document.body.classList.remove("blk-rush");   // 上一局的加倍狀態不可以帶進新的一局

    st = R.blank({
      seed: seed,
      rules: { mode: gRules.mode, secs: gRules.secs, shield: gRules.shield, combo: true }
    });

    foes = {};
    order.forEach(id => {
      if(id !== ctx.me()) foes[id] = { name: ctx.dispName(id), ko: 0, lastHeardAt: Date.now(), connState: "good" };
    });
    rebuildFoes();

    BLKB.setState(st);
    /* 觀戰者沒有自己的盤面 —— 但共用的繪圖路徑要有東西畫,所以照樣給一份空的,
       只是永遠不 play()(canPlay() 也擋著)。 */
    if(ctx.spectating()){
      /* 觀戰者沒有「我的盤面」→ 收掉盤面與控制鈕,把畫面全部讓給對手的小盤。
         ⚠ 唯讀**不靠這個 class** —— 寫入由 canPublish() 與核心的 canWriteGame() 擋,
           這裡收的只是「按了會沒反應」的東西(見 ctx.spectating 的註解)。 */
      document.body.classList.add("blk-spec");
      playing = true; counting = false;
      banner("");
      return;
    }
    document.body.classList.remove("blk-spec");

    counting = true; playing = true;
    BLKB.pause();
    tickCountdown();
  }

  /* 開局倒數:兩端讀到同一個 startAt,所以不必互相等 */
  function tickCountdown(){
    if(!counting || !st) return;
    const left = startAt - nowSrv();
    if(left <= 0){
      counting = false;
      banner("");
      BLKB.play();
      pubFull(true);
      return;
    }
    banner(String(Math.max(1, Math.ceil(left / 1000))));
    setTimeout(tickCountdown, 120);
  }

  /* ==========================================================================
     四、發布自己的狀態
     ──────────────────────────────────────────────────────────────────────────
       高頻只送「落下中的那一顆」;盤面在事件時送,外加每 2 秒無條件對帳(紅線)。
     ========================================================================== */
  let hudT = 0;
  function onFrame(dt){
    if(!st || !playing) return;
    /* ⚠ HUD 要在閘門**之前** —— 觀戰者一個 byte 都不寫,但時間還是要跳 */
    hudT += dt;
    if(hudT >= 250){ hudT = 0; paintHud(); }
    /* ★ 最後 30 秒加倍(v2.15.3)。⚠ 它寫在 `st` 上讓**規則層**去乘 ——
       在 adapter 這裡乘的話單機與規則測試都碰不到它,而 e2e 看得到的只有結果。
       ⚠ 每一幀寫一次是刻意的:比「進入那一刻設一次」耐斷線 / 耐回座,
         而且它只是一個布林,沒有累積誤差可言。 */
    if(st && endAt && gRules && gRules.rush){
      const wasRush = st.rush;
      st.rush = (endAt - nowSrv()) <= RUSH_MS;
      if(st.rush && !wasRush){
        document.body.classList.add("blk-rush");
        BLKB.cast("⏱️ 最後 30 秒 —— 攻擊加倍!", "streak");
      }
    }
    if(!canPublish() || counting) return;
    pubT += dt; fullT += dt;
    if(fullT >= FULL_MS){ fullT = 0; pubFull(true); return; }
    if(pubT >= PUB_MS){ pubT = 0; pubActive(); }
    if(endAt && nowSrv() >= endAt && !over) resolveTime();
  }
  function checkFoeFreshness(){
    if(!playing || over) return;
    const now = Date.now();
    const pl = (ctx && ctx.players) ? (ctx.players() || {}) : {};
    let changed = false;
    order.forEach(id => {
      if(id === ctx.me()) return;
      const f = foes[id];
      if(!f) return;
      const isPresenceAway = !!(pl && !pl[id]);
      const age = f.lastHeardAt ? (now - f.lastHeardAt) : 0;
      let state = "good";
      if(isPresenceAway || age >= 4000){
        state = "away";
      }else if(age >= 1800){
        state = "lag";
      }
      if(f.connState !== state){
        f.connState = state;
        changed = true;
      }
    });
    if(changed) rebuildFoes();
  }
  function pubActive(){
    if(!liveRef || !st) return;
    const c = st.cur;
    liveRef.child(ctx.me()).update({
      rid: curRound, seq: ++seq,
      c: c ? [c.k, c.r, c.x, c.y] : null,
      p: R.pendCount(st), d: st.dead ? 1 : 0
    });
  }
  function pubFull(force){
    if(!liveRef || !st) return;
    const b = R.encBoard(st.board);
    if(!force && b === lastBoard){ pubActive(); return; }
    lastBoard = b;
    const c = st.cur;
    liveRef.child(ctx.me()).update({
      rid: curRound, seq: ++seq, b: b, i: st.idx,
      c: c ? [c.k, c.r, c.x, c.y] : null,
      p: R.pendCount(st), l: st.lines, ko: koOf(ctx.me()), d: st.dead ? 1 : 0,
      /* ★ 「我是被誰打死的」——**只有我自己知道**(垃圾行是誰送的只寫在我收到的那筆
         攻擊事件裡,別台看不到)。要讓全場都能播報「A 💥 K.O. B」就得跟著快照送出去。
         ⚠ 空字串不可以寫成 null:RTDB 的 update 遇到 null 是**刪掉那個 key**。 */
      k: myKiller || "",
      ack: ackd, at: Date.now()
    });
  }

  /* ==========================================================================
     五、收別人的狀態與攻擊
     ========================================================================== */
  function listen(){
    liveRef = ctx.ref("live");
    atkRef  = ctx.ref("attacks");
    if(!liveRef) return;

    const onLive = s => {
      const id = s.key, v = s.val() || {};
      if(id === ctx.me() && !ctx.spectating()) return;      // 自己的不必收回來
      if(!curRound || v.rid !== curRound) return;           // 紅線 ④:上一局的一律忽略
      const f = foes[id] || (foes[id] = { name: ctx.dispName(id), ko: 0 });
      f.lastHeardAt = Date.now();
      if(f.connState && f.connState !== "good") f.connState = "good";
      if(typeof v.seq === "number" && typeof f.seq === "number" && v.seq <= f.seq) return;  // 亂序不倒退
      f.seq = v.seq;
      if(typeof v.b === "string"){ f.bd = R.decBoard(v.b); }
      f.c = v.c || null;
      f.p = v.p || 0;
      if(typeof v.l === "number") f.l = v.l;   // 總消行 —— 淘汰賽的「第一名」看它
      /* ★ 死亡的**轉換**才播報(v2.15.3)。
         ⚠⚠ 不可以只看 `v.d` 為真就播 —— 快照每 2 秒就對帳一次,死著的那 2 秒會被
           播報好幾十次;而且 `child_added` 一掛上去就會把現存的整批重放一次(紅線 ④)。
         ⚠ `f.seen` 是「我這一局看過他活著」:中途加入時對方已經死了就不要播,
           不然一進房就被一串「某某被 K.O.」洗版,而那些都是我沒看到的事。 */
      const wasDead = !!f.dead;
      f.dead = !!v.d;
      if(!f.dead){
        f.seen = true;
        if(lockTarget === id) paintTargetStat();
      }else if(f.seen && !wasDead){
        announceKO(v.k || "", id);
        if(lockTarget === id){
          if(gRules && gRules.mode === "out"){
            lockTarget = null;
            const fallback = (gRules && gRules.target === "high") ? "打第一名" : "隨機攻擊";
            showToast(ctx.dispName(id) + " 已淘汰，改回" + fallback);
          }
          paintTargetStat();
        }
      }
      f.at = v.at || f.at;
      drawFoesSoon();
    };
    liveRef.on("child_added", onLive);
    liveRef.on("child_changed", onLive);

    /* 攻擊。⚠ 紅線 ④:掛上去的那一刻會把現存事件整批重播 —— 全部靠
       roundId + 單調的 n + ackd 擋掉。 */
    atkRef.on("child_added", s => {
      const a = s.val() || {};
      if(!a || a.rid !== curRound) return;
      if(a.to !== ctx.me() || a.from === ctx.me()) return;
      if(!st || ctx.spectating()) return;
      const last = ackd[a.from] || 0;
      if(a.n <= last) return;                               // 已經吃過了
      ackd[a.from] = a.n;
      const accepted = R.queueGarbage(st, a.lines, a.hole, a.from);
      if(accepted > 0) lastHitBy = a.from;
      const i = foeIndex(a.from);
      if(i >= 0){
        if(accepted === 0) BLKB.beamShield(i, ctx.dispName(a.from));
        else BLKB.beamIn(i, accepted, ctx.dispName(a.from));
      }
      pubFull(false);                                        // 把 ack 寫進快照(重整後才去得掉重)
    });
  }

  /* ==========================================================================
     六、我的規則事件 → 送攻擊 / 宣告死亡
     ========================================================================== */
  function onEvents(evs){
    if(!st || !playing || over) return;
    let dead = false;
    for(let i = 0; i < evs.length; i++){
      const ev = evs[i];
      if(ev.t !== "lock") continue;
      /* ⚠ ev.to 是**反擊**指名的對象(規則層決定的),它比房規與手動鎖定都優先 ——
         「打回去給剛打我的那個人」這件事一旦被隨機改掉,反擊就完全不成立了。 */
      if(ev.out > 0) sendAttack(ev.out, ev.to, ev.revenge);
      if(ev.dead || st.dead) dead = true;
      pubFull(true);
    }
    paintHud();
    if(dead) onDead();
  }

  function sendAttack(n, forced, revenge){
    if(!canPublish() || !atkRef) return;
    /* 指名的目標要還活著;死了就退回一般的挑法(不然反擊會打進空氣裡) */
    const to = (forced && aliveFoes().indexOf(forced) >= 0) ? forced : pickTarget();
    if(!to) return;
    atkN++;
    /* 紅線 ⑤:key 是決定性的 → 重送 = 覆蓋 = 天然冪等。
       ⚠ 洞位在這裡決定並寫進事件,接收端不得重抽。 */
    const key = ctx.me() + "_" + curRound + "_" + atkN;
    atkRef.child(key).set({
      rid: curRound, from: ctx.me(), to: to, n: atkN,
      lines: n, hole: Math.floor(Math.random() * R.COLS), at: Date.now()
    });
    const i = foeIndex(to);
    if(i >= 0) BLKB.beamOut(i, n, revenge);
    if(revenge) BLKB.pop("反擊 ×2", "#ff5d6c", 0.86);
  }
  function aliveFoes(){
    return order.filter(id => id !== ctx.me() && !(foes[id] && foes[id].dead));
  }
  /* ★★ 打誰(v2.15.3 起真的看房規)。優先序:**手動鎖定 > 房規 > 隨機**。
     ⚠ 手動鎖定要排在房規前面 —— 玩家親手點下去的那一下,不可以被房規蓋掉。
     ⚠ 「打第一名」的排名基準要跟著玩法走:K.O. 賽比 K.O. 數、淘汰賽比消行數
       (`live` 快照的 `l`)。用錯基準的話淘汰賽會變成「一律打第一個人」——
       因為那時每個人的 K.O. 數都是 0,最大值相同 → 全部同分 → tie 的處理說了算。
     ⚠⚠ 同分一律**隨機挑一個**,不可以 `[0]`:固定取第一個的話三人局會變成
       兩個人同時猛打同一個倒楣鬼,而那看起來完全像是「隨機壞掉了」。 */
  function pickTarget(){
    const alive = aliveFoes();
    if(!alive.length) return null;
    if(lockTarget && alive.indexOf(lockTarget) >= 0) return lockTarget;
    if(gRules && gRules.target === "high"){
      const score = id => (gRules.mode === "ko") ? koOf(id) : ((foes[id] && foes[id].l) || 0);
      let best = -1;
      alive.forEach(id => { const v = score(id); if(v > best) best = v; });
      const top = alive.filter(id => score(id) === best);
      return top[Math.floor(Math.random() * top.length)];
    }
    return alive[Math.floor(Math.random() * alive.length)];
  }

  function onDead(){
    myDeaths++;
    deadAt = nowSrv();
    myKiller = lastHitBy;                /* ⚠ 一定要在 pubFull **之前**,不然這一份快照少了 k */
    announceKO(myKiller, ctx.me());      /* 自己這一台立刻播,不必等快照繞一圈回來 */
    pubFull(true);
    /* 死亡宣告 + KO 記給最後打我的人。
       ⚠ 用 deaths[me] 當冪等鍵:同一次死亡重送不會被算第二次。 */
    const me = ctx.me(), killer = lastHitBy, n = myDeaths;
    ctx.txGame(g => {
      g.deaths = g.deaths || {};
      if((g.deaths[me] || 0) >= n) return false;
      g.deaths[me] = n;
      if(killer && killer !== me){ g.ko = g.ko || {}; g.ko[killer] = (g.ko[killer] || 0) + 1; }
      if(gRules && gRules.mode === "out"){ g.topouts = g.topouts || {}; g.topouts[me] = true; }
      return true;
    });
    lastHitBy = "";

    if(gRules && gRules.mode === "ko"){
      banner("被 K.O. —— 準備復活");
      setTimeout(() => {
        if(!st || over || !playing) return;
        R.revive(st);
        st.shield = 1500;               // 復活後給一小段不吃垃圾的時間(不然剛活又被埋)
        banner("");
        lastBoard = "";
        pubFull(true);
      }, 2000);
    }else{
      banner("你被淘汰了");
      /* 紅線 ⑦:進裁決窗再結算,不比誰的網路快 */
      armSettle();
    }
  }

  /* ==========================================================================
     七、結算
     ========================================================================== */
  function armSettle(){
    clearSettle();
    settleT = setTimeout(() => { settleT = null; checkEnd(null); }, SETTLE_MS);
  }
  function clearSettle(){ if(settleT){ clearTimeout(settleT); settleT = null; } }

  /* 淘汰賽:只剩一個活的 → 他贏;都死了 → 平手 */
  function checkEnd(snap){
    if(over || !gRules || gRules.mode !== "out" || !order.length) return;
    const alive = order.filter(id => !deadOf(id, snap));
    if(alive.length > 1) return;
    const win = alive.length === 1 ? alive[0] : "draw";
    /* ⚠ 交易的參數一律叫 g(與另外十三支 adapter 一致)——
       tools/test-pages.js 的 K 節是靠 `g.winner=` 這個字面找「寫 winner 的交易」的。 */
    ctx.txGame(g => {
      if(g.winner) return false;
      g.winner = win;
      return true;
    }, { local: false });                /* ★ 紅線 ⑧ */
  }
  /* K.O. 賽:時間到 → K.O. 最多的人贏,同分平手。
     ⚠⚠ **統計一定要在交易裡面用 `g.ko` 算,不可以在外面用本機的 lastGame。**
       時間到那一刻,若別人剛 K.O. 了誰、而那一筆 game 還沒傳到我這,我算出來的贏家
       就是錯的 —— 而 `if(g.winner) return false` 會讓**先到的那一筆成為定局**:
       幾台同時到時間、各自算各自的,變成誰的網路快誰說了算。
       交易回呼拿到的 g 是伺服器上最新的那一份,這才是唯一對得起「同時」的算法。
     ⚠ 這裡不拿總消行當 tie-break:消行數只活在 live 快照裡、`game` 上沒有
       → 交易裡根本拿不到。同分就是平手(舊註解寫了「同分看總消行」,從來沒有實作)。 */
  function resolveTime(){
    if(over || !gRules || gRules.mode !== "ko") return;
    over = true;                         // 先擋住自己重複進來;真正的結果等 game 回來
    const ids = order.slice();
    ctx.txGame(g => {
      if(g.winner) return false;
      const ko = g.ko || {};
      let best = -1;
      ids.forEach(id => { const n = ko[id] || 0; if(n > best) best = n; });
      const top = ids.filter(id => (ko[id] || 0) === best);
      g.winner = (top.length === 1) ? top[0] : "draw";
      return true;
    }, { local: false });
  }
  function finishRound(g){
    over = true;
    playing = false;
    BLKB.stop();
    banner("");
  }
  function deadOf(id, g){
    if(id === ctx.me()) return !!(st && st.dead);
    if(g && g.topouts && g.topouts[id]) return true;
    return !!(foes[id] && foes[id].dead);
  }
  function koOf(id){
    const g = lastGame;
    return (g && g.ko && g.ko[id]) || 0;
  }

  /* ==========================================================================
     八、畫面
     ========================================================================== */
  function paintFoes(g){
    lastGame = g;
    Object.keys(foes).forEach(id => {
      foes[id].name = ctx.dispName(id);
      foes[id].ko = (g && g.ko && g.ko[id]) || 0;
      if(g && g.topouts && g.topouts[id]){
        const wasDead = !!foes[id].dead;
        foes[id].dead = true;
        if(!wasDead && lockTarget === id && gRules && gRules.mode === "out"){
          lockTarget = null;
          const fallback = (gRules && gRules.target === "high") ? "打第一名" : "隨機攻擊";
          showToast(ctx.dispName(id) + " 已淘汰，改回" + fallback);
          paintTargetStat();
        }
      }
      foes[id].target = (lockTarget === id) && !foes[id].dead;
    });
    rebuildFoes();
  }
  let foeDirty = false;
  function drawFoesSoon(){
    if(foeDirty) return;
    foeDirty = true;
    /* ⚠ 不要每收到一筆快照就重建 DOM —— 一秒鐘會有幾十筆。
       這裡只把「資料」換掉,實際重畫跟著 board.js 的 rAF 走。 */
    setTimeout(() => { foeDirty = false; rebuildFoes(); }, 60);
  }
  function rebuildFoes(){
    const list = order.filter(id => id !== ctx.me()).map(id => {
      const f = foes[id] || {};
      const dead = !!f.dead;
      const connState = f.connState || "good";
      return { id: id, name: f.name || ctx.dispName(id), bd: f.bd, c: f.c,
               pend: f.p || 0, ko: f.ko || 0, dead: dead,
               target: (lockTarget === id) && !dead,
               away: connState === "away", lag: connState === "lag",
               connState: connState };
    });
    BLKB.setFoes(list);
  }
  function foeIndex(id){
    const list = order.filter(x => x !== ctx.me());
    return list.indexOf(id);
  }
  /* 點對手的小盤 = 鎖定 / 取消鎖定攻擊目標 */
  function tapFoe(i){
    const list = order.filter(x => x !== ctx.me());
    const id = list[i];
    if(!id) return;
    const wasLocked = (lockTarget === id);
    lockTarget = wasLocked ? null : id;
    const fallback = (gRules && gRules.target === "high") ? "打第一名" : "隨機攻擊";
    showToast(lockTarget ? ("只打 " + ctx.dispName(id)) : ("改回" + fallback));
    rebuildFoes();
    paintTargetStat();                   // ⚠ HUD 那一格要立刻跟上,不能等下一次 250ms 的 paintHud
  }

  /* ==========================================================================
     八之一、現場播報(v2.15.3)
     ──────────────────────────────────────────────────────────────────────────
       ★ 「誰打爆了誰」以前只有一個 K.O. 數字在默默變 —— 聚會現場沒有人會注意到,
         而這正是這個遊戲最有戲的一刻。這一段**不改任何規則**。
       ⚠ 每一台各自從同一串事件算,所以看到的播報一致;算錯了也只是少一句話,
         不影響任何勝負判定(K.O. 數的真相一律在 `game.ko`,由交易寫)。
     ========================================================================== */
  const STREAK_MS = 12000;               // 連殺的時間窗
  const STREAK_WORD = ["", "", "雙殺!", "三殺!", "四殺!!", "大殺特殺!!!"];
  function announceKO(killer, victim){
    const vn = ctx.dispName(victim);
    if(killer && killer !== victim){
      const kn = ctx.dispName(killer);
      BLKB.cast(kn + " 💥 K.O. " + vn, "ko");
      noteStreak(killer, kn);
    }else{
      /* 沒有人打他 —— 自己堆爆的。這一句要講出來,不然旁邊的人會以為是誰的功勞。 */
      BLKB.cast(vn + " 自己堆爆了 😵", "ko");
      streak = null;
    }
  }
  function noteStreak(id, name){
    const t = nowSrv();
    if(streak && streak.id === id && (t - streak.t) <= STREAK_MS) streak.n++;
    else streak = { id: id, n: 1, t: t };
    streak.t = t;
    const w = STREAK_WORD[Math.min(streak.n, STREAK_WORD.length - 1)];
    /* ⚠ 慢半拍再播:跟 K.O. 那一句同時出現的話兩句會擠在一起,反而兩句都沒看到。 */
    if(w) setTimeout(() => BLKB.cast(name + " " + w, "streak"), 460);
  }

  function banner(txt){
    const el = $("blkPaused");
    if(!el) return;
    el.textContent = txt || "";
    el.classList.toggle("hidden", !txt);
  }
  function paintHud(){
    if(!st) return;
    const set = (id, v) => { const el = $(id); if(el) el.textContent = v; };
    set("blkStatLines", st.lines);
    set("blkStatLv", R.level(st));
    if(endAt){
      const left = Math.max(0, Math.round((endAt - nowSrv()) / 1000));
      set("blkStatTime", Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"));
    }else set("blkStatTime", "—");
    const goal = $("blkGoal");
    if(goal) goal.textContent = (gRules && gRules.mode === "ko") ? ("K.O. ×" + koOf(ctx.me())) : "淘汰賽";
    paintTargetStat();
    checkFoeFreshness();
  }
  function targetRuleName(rule){
    return rule === "high" ? "打第一名" : "隨機攻擊";
  }
  function targetRuleShort(rule){
    return rule === "high" ? "👑第一" : "隨機";
  }
  function currentTargetInfo(){
    const alive = aliveFoes();
    const isLocked = !!(lockTarget && alive.indexOf(lockTarget) >= 0);
    const rule = (gRules && gRules.target === "high") ? "high" : "rand";
    if(isLocked){
      return {
        isLock: true,
        targetId: lockTarget,
        name: ctx.dispName(lockTarget),
        short: ctx.dispName(lockTarget)
      };
    }
    return {
      isLock: false,
      targetId: null,
      name: targetRuleName(rule),
      short: targetRuleShort(rule)
    };
  }
  /* ★★ 「我現在打誰」(v2.15.3)。使用者親口問過「三個人玩是每個人都會增加嗎」——
     答案(只打一個人、預設隨機)以前**畫面上完全看不出來**,只有一行灰字寫在大廳。
     ⚠ 只在對手 ≥ 2 個時出現:1 對 1 時沒有可選的東西,而 HUD 這一列在 360px 上很緊。 */
  function paintTargetStat(){
    const box = $("blkStatTgtBox"), val = $("blkStatTgt");
    if(!box || !val) return;
    const foeN = order.filter(id => id !== ctx.me()).length;
    box.classList.toggle("hidden", foeN < 2 || ctx.spectating());
    if(foeN < 2) return;
    const info = currentTargetInfo();
    if(val.textContent !== info.short) val.textContent = info.short;
    box.classList.toggle("blk-stat-lock", info.isLock);
  }
  /* ★★ 設定畫面的「隨選隨變」文案 —— **單一真相在 `rules.js` 的 `NOTES`**
     (v2.15.3 原本放在這裡,v2.15.4 因為單機也用同一組房規而搬過去)。
     ⚠ `blocks.html` 那幾個 div 是空的,兩邊各寫一份就是靜靜過期的雙胞胎。 */
  function paintSetup(){
    const seg = (id, attr, val) => {
      const el = $(id); if(!el) return;
      [...el.children].forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(val)));
    };
    const note = (id, html) => { const el = $(id); if(el) el.innerHTML = html || ""; };
    seg("blkModeSegMp", "mode", rules.mode);
    seg("blkSecsSeg", "secs", rules.secs);
    seg("blkShieldSeg", "shield", rules.shield);
    seg("blkTargetSeg", "target", rules.target);
    seg("blkRushSeg", "rush", rules.rush ? "1" : "0");
    note("blkNoteMode", R.noteOf("mode", rules.mode));
    note("blkNoteShield", R.noteOf("shield", rules.shield));
    note("blkNoteTarget", R.noteOf("target", rules.target));
    note("blkNoteRush", R.noteOf("rush", rules.rush));
    const row = $("blkSecsRow");
    if(row) row.classList.toggle("hidden", rules.mode !== "ko");
    /* ⚠ 「最後 30 秒加倍」只有 K.O. 賽有意義(淘汰賽沒有時間限制)——
       跟著一局多久那一格一起收掉,不然它會是一顆按了沒反應的鈕。 */
    const rr = $("blkRushRow");
    if(rr) rr.classList.toggle("hidden", rules.mode !== "ko");
  }
  /* ==========================================================================
     九、伺服器時間
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 各台的系統時鐘差好幾秒是常態 —— 開局倒數與 KO 賽的結束時間都靠它。
     ========================================================================== */
  let srvOff = 0;
  function nowSrv(){ return Date.now() + srvOff; }
  function armClock(){
    try{
      firebase.database().ref(".info/serverTimeOffset").on("value", s => {
        const v = s.val();
        if(typeof v === "number") srvOff = v;
      });
    }catch(e){}
  }

  /* ==========================================================================
     十、adapter 介面
     ========================================================================== */
  function escapeHtml(s){
    if(typeof esc === "function") return esc(s);
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function paintBattleReport(winner){
    const box = $("blkResult");
    if(!box || !order.length) return;
    box.classList.remove("hidden");
    const isKoMode = (gRules && gRules.mode === "ko");
    let rowsHtml = "";
    order.forEach(id => {
      const isMe = (id === ctx.me());
      const name = ctx.dispName(id) + (isMe ? " (你)" : "");
      const isWin = (winner === id);
      const ko = koOf(id);
      const lines = isMe ? (st ? st.lines : 0) : ((foes[id] && foes[id].l) || 0);
      const isDead = deadOf(id, lastGame);
      const tag = isWin ? "👑 " : "";
      let detail = "";
      if(isKoMode){
        detail = "K.O. " + ko + " · " + lines + " 行";
      }else{
        detail = lines + " 行 · " + (isDead ? "淘汰" : "存活");
      }
      rowsHtml += '<div class="blk-rrow"><span>' + tag + escapeHtml(name) + '</span><b>' + escapeHtml(detail) + '</b></div>';
    });
    box.innerHTML = rowsHtml;
  }

  return {
    ns: { rooms: "blocks_rooms", index: "blocks_index" },
    prefsKey: "blk",
    emoteAnchor: "blkPlay",
    winCardId: "blkWinCard",
    minPlayers: 2, maxPlayers: 4,
    spectate: true,
    extraNodes: ["live", "attacks"],
    scoreUnit: "勝", goalDefault: 3, goalMax: 10,

    init(c){ ctx = c; armClock(); },
    listen: listen,

    roomFields(){ return { mode: rules.mode, secs: rules.secs, shield: rules.shield,
                           target: rules.target, rush: !!rules.rush }; },
    onRoomField(k, v){
      const f = FIELDS[k];
      if(!f || !f.ok(v) || v === f.get()) return;
      f.set(v);
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
    },
    readRoom(r){ Object.keys(FIELDS).forEach(k => { if(FIELDS[k].ok(r[k])) FIELDS[k].set(r[k]); }); },

    newGame: newGame,
    lobbyGame: lobbyGame,
    resetRound: resetRound,
    applyGame: applyGame,

    openConnect(){ showScreen("connect"); },
    enterLobby(){
      showScreen("lobby");
      resetRound();
      paintSetup();
    },
    backToLobby(){ showScreen("lobby"); resetRound(); },
    enterPlaying(){ showScreen("play"); },
    onLeave(){ resetRound(); showScreen("home"); },

    syncSetup: paintSetup,
    updateGoal(){
      const el = $("mpBarGoal");
      if(el) el.textContent = (rules.mode === "ko") ? (rules.secs / 60 + " 分 K.O. 賽") : "淘汰賽";
    },
    lobbyStatusText(ids){
      return ids.length < 2 ? "等人進來…(至少 2 個人)" : "都準備好就開始";
    },
    outcome(winner, o){
      paintBattleReport(winner);
      const ko = koOf(ctx.me());
      if(winner === "draw") return { word: "平手", msg: "誰都沒有被埋掉 🤝" };
      if(o.iWon) return { word: "你贏了!", msg: (gRules && gRules.mode === "ko")
        ? ("K.O. <b>" + ko + "</b> 次,消了 " + (st ? st.lines : 0) + " 行")
        : ("最後站著的是你 —— 消了 " + (st ? st.lines : 0) + " 行") };
      return { word: "輸了", msg: "<b>" + esc(ctx.dispName(winner)) + "</b> 贏了這一局" };
    },
    /* 玩家名單變動時被呼叫 —— 對手小盤那一排要跟著重建。 */
    refresh(){ if(order.length) rebuildFoes(); },

    api: {
      onEvents: onEvents,
      onFrame: onFrame,
      canPlay: canPlay,
      setMode, setSecs, setShield, setTarget, setRush,
      tapFoe: tapFoe,
      rules: () => rules,
      state: () => st,
      /* ★ 只給截圖頁 / e2e 用的出口(產品程式一律走核心的 syncSetup)——
         設定畫面那幾行「隨選隨變」的文案是**斷言測不到好不好懂**的,只能看圖,
         而截圖頁沒有 firebase → 走不到核心那條路。同 board.js 的三個測試出口。 */
      syncSetupNow: paintSetup
    }
  };
})());

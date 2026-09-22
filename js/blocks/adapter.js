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
   ⚠ 讓分是**每個人自己選的**(hcap/{pid}),而倍率只在本機生效:
     送出時乘自己的 send、收到時乘自己的 recv —— 所以只要讀自己那一個值。
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
  let rules = { mode: "ko", secs: 180, shield: 20 };
  let myHcap = R.HCAP_EVEN;
  let hcapAll = {};                     // pid → 讓分等級(全房的,大廳那一行要畫)

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
  let liveRef = null, atkRef = null, hcapRef = null;
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
    shield: { ok: v => SHIELDS.indexOf(v) >= 0,   get: () => rules.shield, set: v => rules.shield = v }
  };
  function setMode(v){ if(FIELDS.mode.ok(v)) ctx.setRoomField("mode", v); }
  function setSecs(v){ v = +v; if(FIELDS.secs.ok(v)) ctx.setRoomField("secs", v); }
  function setShield(v){ v = +v; if(FIELDS.shield.ok(v)) ctx.setRoomField("shield", v); }

  /* 讓分:**每個人自己選**(不是房主指定)——
     聚會場合「我不太會玩,我選讓 2」比「房主幫你決定」自然得多,而且零 UI 衝突。 */
  function setHcap(v){
    const i = v | 0;
    myHcap = (i >= 0 && i < R.HCAP.length) ? i : R.HCAP_EVEN;
    if(hcapRef && ctx.me()) hcapRef.child(ctx.me()).set(myHcap);
    paintSetup();
  }

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
      rules: { mode: rules.mode, secs: rules.secs, shield: rules.shield * 1000 },
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
    Object.keys(ackd).forEach(k => delete ackd[k]);
    BLKB.setFoes([]);
    document.body.classList.remove("blk-spec");
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
    gRules = g.rules || { mode: "ko", secs: 180, shield: 0 };
    startAt = g.startAt || nowSrv();
    endAt = (gRules.mode === "ko") ? startAt + gRules.secs * 1000 : 0;
    order = g.order || [];
    over = false; atkN = 0; seq = 0; myDeaths = 0; lastHitBy = ""; lastBoard = "";
    Object.keys(ackd).forEach(k => delete ackd[k]);

    st = R.blank({
      seed: seed,
      rules: { mode: gRules.mode, secs: gRules.secs, shield: gRules.shield, combo: true },
      hcap: myHcap                      // ★ blank() 會照這個把 send / recv 設好
    });

    foes = {};
    order.forEach(id => { if(id !== ctx.me()) foes[id] = { name: ctx.dispName(id), ko: 0 }; });
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
    if(!canPublish() || counting) return;
    pubT += dt; fullT += dt;
    if(fullT >= FULL_MS){ fullT = 0; pubFull(true); return; }
    if(pubT >= PUB_MS){ pubT = 0; pubActive(); }
    if(endAt && nowSrv() >= endAt && !over) resolveTime();
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
      rid: curRound, seq: ++seq, b: b, i: st.idx, h: st.hold,
      c: c ? [c.k, c.r, c.x, c.y] : null,
      p: R.pendCount(st), l: st.lines, ko: koOf(ctx.me()), d: st.dead ? 1 : 0,
      ack: ackd, at: Date.now()
    });
  }

  /* ==========================================================================
     五、收別人的狀態與攻擊
     ========================================================================== */
  function listen(){
    liveRef = ctx.ref("live");
    atkRef  = ctx.ref("attacks");
    hcapRef = ctx.ref("hcap");
    if(!liveRef) return;

    const onLive = s => {
      const id = s.key, v = s.val() || {};
      if(id === ctx.me() && !ctx.spectating()) return;      // 自己的不必收回來
      if(!curRound || v.rid !== curRound) return;           // 紅線 ④:上一局的一律忽略
      const f = foes[id] || (foes[id] = { name: ctx.dispName(id), ko: 0 });
      if(typeof v.seq === "number" && typeof f.seq === "number" && v.seq <= f.seq) return;  // 亂序不倒退
      f.seq = v.seq;
      if(typeof v.b === "string"){ f.bd = R.decBoard(v.b); }
      f.c = v.c || null;
      f.p = v.p || 0;
      f.dead = !!v.d;
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
      R.queueGarbage(st, a.lines, a.hole, a.from);
      lastHitBy = a.from;
      const i = foeIndex(a.from);
      if(i >= 0) BLKB.beamIn(i, a.lines);
      pubFull(false);                                        // 把 ack 寫進快照(重整後才去得掉重)
    });

    hcapRef && hcapRef.on("value", s => {
      /* ⚠ 整份留著,不要只挑自己那一個 —— 大廳要畫「誰讓了幾分」那一行。 */
      hcapAll = s.val() || {};
      if(ctx.me() && typeof hcapAll[ctx.me()] === "number") myHcap = hcapAll[ctx.me()];
      paintSetup();
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
      if(ev.out > 0) sendAttack(ev.out);
      if(ev.dead || st.dead) dead = true;
      pubFull(true);
    }
    paintHud();
    if(dead) onDead();
  }

  function sendAttack(n){
    if(!canPublish() || !atkRef) return;
    const to = pickTarget();
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
    if(i >= 0) BLKB.beamOut(i, n);
  }
  /* 目標:鎖定的優先,否則在還活著的對手裡隨機挑一個 */
  function pickTarget(){
    const alive = order.filter(id => id !== ctx.me() && !(foes[id] && foes[id].dead));
    if(!alive.length) return null;
    if(lockTarget && alive.indexOf(lockTarget) >= 0) return lockTarget;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  function onDead(){
    myDeaths++;
    deadAt = nowSrv();
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
      if(g && g.topouts && g.topouts[id]) foes[id].dead = true;
      foes[id].target = (lockTarget === id);
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
      return { id: id, name: f.name || ctx.dispName(id), bd: f.bd, c: f.c,
               pend: f.p || 0, ko: f.ko || 0, dead: !!f.dead, target: lockTarget === id };
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
    lockTarget = (lockTarget === id) ? null : id;
    showToast(lockTarget ? ("鎖定 " + ctx.dispName(id)) : "改回隨機攻擊");
    rebuildFoes();
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
  }
  function paintSetup(){
    const seg = (id, attr, val) => {
      const el = $(id); if(!el) return;
      [...el.children].forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(val)));
    };
    seg("blkModeSegMp", "mode", rules.mode);
    seg("blkSecsSeg", "secs", rules.secs);
    seg("blkShieldSeg", "shield", rules.shield);
    seg("blkHcapSeg", "hcap", myHcap);
    const row = $("blkSecsRow");
    if(row) row.classList.toggle("hidden", rules.mode !== "ko");
    paintHcaps();
  }
  /* 「誰讓了幾分」那一行。★ 只列不是「平」的人 —— 全房都平的時候整行收起來。
     ⚠ 名單用 ctx.players()(座位上的人),不是 hcapAll 的 key:
       離開的人那一筆還留在節點上,照著畫會列出已經不在房裡的名字。 */
  function paintHcaps(){
    const el = $("blkHcaps");
    if(!el || !ctx) return;
    const ids = Object.keys(ctx.players() || {});
    const list = ids.filter(id => {
      const v = hcapAll[id];
      return typeof v === "number" && (v | 0) !== R.HCAP_EVEN;
    }).map(id => esc(ctx.dispName(id)) + " <b>" + esc(R.hcapOf(hcapAll[id]).name) + "</b>");
    el.innerHTML = list.length ? ("這一局的讓分:" + list.join(" · ")) : "";
    el.classList.toggle("hidden", !list.length);
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
  return {
    ns: { rooms: "blocks_rooms", index: "blocks_index" },
    prefsKey: "blk",
    emoteAnchor: "blkPlay",
    winCardId: "blkWinCard",
    minPlayers: 2, maxPlayers: 4,
    spectate: true,
    extraNodes: ["live", "attacks", "hcap"],
    scoreUnit: "勝", goalDefault: 3, goalMax: 10,

    init(c){ ctx = c; armClock(); },
    listen: listen,

    roomFields(){ return { mode: rules.mode, secs: rules.secs, shield: rules.shield }; },
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
      /* 讓分是每個人自己的 → 進大廳就把本機記著的那一個寫上去(別人看得到) */
      if(hcapRef && ctx.me() && !ctx.spectating()) hcapRef.child(ctx.me()).set(myHcap);
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
      const ko = koOf(ctx.me());
      if(winner === "draw") return { word: "平手", msg: "誰都沒有被埋掉 🤝" };
      if(o.iWon) return { word: "你贏了!", msg: (gRules && gRules.mode === "ko")
        ? ("K.O. <b>" + ko + "</b> 次,消了 " + (st ? st.lines : 0) + " 行")
        : ("最後站著的是你 —— 消了 " + (st ? st.lines : 0) + " 行") };
      return { word: "輸了", msg: "<b>" + esc(ctx.dispName(winner)) + "</b> 贏了這一局" };
    },
    /* ⚠ 讓分那一行也要跟著重畫 —— 它列的是「座位上的人」,而這個鉤子正是
       玩家名單變動時被呼叫的(有人離開時不重畫就會留著已經不在房裡的名字)。 */
    refresh(){ paintHcaps(); if(order.length) rebuildFoes(); },

    ownPrefs(){ return { blkHcap: myHcap }; },
    usePrefs(o){
      const i = o && typeof o.blkHcap === "number" ? (o.blkHcap | 0) : -1;
      myHcap = (i >= 0 && i < R.HCAP.length) ? i : R.HCAP_EVEN;
    },

    api: {
      onEvents: onEvents,
      onFrame: onFrame,
      canPlay: canPlay,
      setMode, setSecs, setShield, setHcap,
      tapFoe: tapFoe,
      rules: () => rules,
      myHcap: () => myHcap,
      state: () => st
    }
  };
})());

"use strict";

/* ============================================================================
   排七 — 連線適配器(接上 js/shared/mp-core.js)

   ── DB 上只有兩個欄位就夠了 ──────────────────────────────────────────────
     `deal`(52 個字元的發牌)+ `moves`(一手一個整數),與五子棋的 moves 同構,
     所以核心的 rev / 交易 / 斷線重建原封不動就能用。
     每台裝置各自 `SV.replay(deal, n, moves)` 算出完整局面 → **重連歸位不必特別處理**
     (批次同步就是同一支 replay 多跑幾手)。

   ── ★ 手牌與蓋牌在 DB 是明碼,刻意不防作弊 ────────────────────────────────
     受眾是親友聚會(見 CLAUDE.md)。同台灣麻將,這**不是妥協而是架構優勢**:
     每台裝置都算得出「現在輪到誰、他能出什麼」,所以**到期自動出牌不必指定房主**
     —— 誰的 timer 先響誰用交易搶,房主剛好斷線也不會全桌卡死。

     代價是「算得出來」不等於「可以顯示」。這一頁只有**一條**牌情紅線
     (台灣麻將有六條,因為它有宣告視窗;排七沒有):
         ★ 別人蓋掉的牌,在結算前只能顯示張數。
     落地點在 adapter 的 chipTail()(晶片上只給張數)與 board.js 的 resultHTML()
     (結果卡的排名表,唯一翻開的地方)。

   ── ★ 決定勝負的交易一定要帶 { local:false } ─────────────────────────────
     notes/07 踩坑 #8:Firebase 交易會先在本地樂觀套用,搶最後一手時搶輸的那台會
     **先**看到「我贏」而往 scores/ 寫 +1,game 回退時分數不會跟著回退。
   ========================================================================== */

const MP = MPCore.create((function(){

  const SECS = [0, 15, 30, 60];        // 出牌倒數的選項;預設值也寫在 sevens.html 的 .on
  let turnSec = 30;
  let ctx = null;

  let deal = "", moves = [], st = null;
  let curRound = null;                 // ★ 新局判定一律用 roundId(不可以看 deal 變沒變)
  let lastLen = -1, turnAt = 0;        // 這一手的錨點(本地時鐘;各台差幾百毫秒無妨)
  let turnT = null;
  /* ★ 開局那一刻每個人的累積勝場快照(v1.75.9,結果卡的「N 勝」欄用)。
     為什麼不當場讀 scores:那個節點是**結算之後**每台各自寫自己的 +1,而結果卡是
     **結算當下**就要畫出來 —— 直接讀會少一分,等分數同步回來也沒有人會重畫這張卡
     (核心的 scores 監聽只重畫它自己的 #winScores)。
     用「開局時的值 + 這局有沒有得分」算就沒有時間差,而且重畫幾次都是同一個數(冪等)。 */
  let baseWins = {};

  const seatOf = id => ctx.order().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  const nPlayers = () => ctx.order().length;
  function nameOfSeat(s){
    const id = ctx.order()[s];
    return id ? ctx.dispName(id) : ("玩家" + (s + 1));
  }
  const secOn = () => turnSec > 0;
  const playing = () => ctx.phase() === "playing" && !ctx.winner() && !ctx.abandoned();

  /* ---------- 輪到誰 ----------
     ★ 一律問 replay 出來的 st.turn,不可以用 moves.length % n 取模 ——
       手牌清空的人要跳過,取模在有人出完之後整桌就錯位了。 */
  function turnId(){
    if(!st || st.over) return null;
    return ctx.order()[st.turn] || null;
  }
  const isMyTurn = () => !!(st && !st.over && playing() && st.turn === mySeat());

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  function paint(){
    if(!st) return;
    const me = mySeat();
    if(me < 0) return;
    const can = isMyTurn() ? SV.legal(st.hands[me], st.tracks) : [];
    // ★ 不再傳 seats —— 盤面沒有對手列了,那些資訊只住在房間框的晶片上(chipTail,見 board.js)
    SVB.render({
      tracks: st.tracks, hand: st.hands[me].slice(), can: can,
      myPile: st.piles[me],
      mode: (isMyTurn() && !can.length) ? "cover" : "play"
    });
    SVB.renderActs({
      mine: isMyTurn(),
      canPlay: can.length > 0,
      turnName: st.over ? "" : nameOfSeat(st.turn),
      over: !!ctx.winner() || st.over,
      // 環給全桌看(誰還剩幾秒是公開資訊,大家才知道為什麼卡著)
      cdMs: secOn() ? turnSec * 1000 : 0,
      cdEnd: secOn() ? turnAt + turnSec * 1000 : 0
    });
    ctx.renderPlayers();
  }

  /* ==========================================================================
     二、出牌 / 蓋牌
     ──────────────────────────────────────────────────────────────────────────
       交易內原子 append:即使兩端同時點也不會覆蓋彼此。
       ⚠ 交易裡一定要拿**伺服器的 moves** 重跑一次規則再寫 —— 本地畫面對不代表
         伺服器上對(同消消樂 settleGrab 的守衛)。
     ========================================================================== */
  function send(card, pass){
    const step = moves.length, n = nPlayers(), me = mySeat();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const mv = Array.isArray(g.moves) ? g.moves : [];
      if(mv.length !== step) return false;             // 這一手已被別人推進 → 中止,等快照
      const chk = SV.replay(g.deal, n, mv);
      if(!chk || chk.over || chk.turn !== me) return false;
      const one = SV.encMove(card, pass);
      if(!SV.step(chk, one)) return false;             // 伺服器真值上不合法 → 不寫
      g.moves = mv.concat(one);
    });
  }

  function tap(card){
    if(ctx.phase() !== "playing"){ return; }
    if(ctx.winner() || ctx.abandoned()){ return; }
    if(!st || st.over) return;
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    const can = SV.legal(st.hands[mySeat()], st.tracks);
    if(can.length){
      if(can.indexOf(card) < 0){ showToast(SV.whyNot(card, st.tracks)); return; }
      // ★ 飛牌的出發點只有這一刻量得到(送出去之後手牌就重畫了)—— 見 board.js armFly()
      SVB.armFly(card);
      send(card, false);
    }else{
      // 蓋牌是兩段式:先選,再按「確定蓋掉」(不可逆而且直接加罰分,誤點代價太高)
      SVB.setSel(SVB.sel() === card ? -1 : card);
      paint();
    }
  }
  function act(a){
    if(a !== "cover" || !isMyTurn()) return;
    const c = SVB.sel();
    if(c < 0){ showToast("先點一張要蓋掉的牌"); return; }
    send(c, true);
  }

  /* ==========================================================================
     三、出牌倒數 —— 到期幫他出一手
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主:每一台都排 timer,誰先響誰用交易搶(房主剛好斷線也不會全桌卡死)。
         按座位錯開只是少幾次註定白跑的交易。
       ⚠ 下限 1200ms 兜底 —— 錨點是本地時鐘,慢半拍收到快照的那台會算出「已經過期」
         而一收到就結算(台灣麻將踩過)。
     ========================================================================== */
  function clearTurnT(){ if(turnT){ clearTimeout(turnT); turnT = null; } }

  function armTurnT(){
    clearTurnT();
    if(!secOn() || !st || st.over || !playing()) return;
    const seat = st.turn, me = mySeat();
    const wait = Math.max(1200, turnAt + turnSec * 1000 - Date.now()) + Math.max(0, me) * 150;
    turnT = setTimeout(() => { autoPlay(seat, moves.length); }, wait);
  }

  function autoPlay(seat, step){
    turnT = null;
    if(!st || st.over || st.turn !== seat || !playing()) return;
    const n = nPlayers();
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const mv = Array.isArray(g.moves) ? g.moves : [];
      if(mv.length !== step) return false;             // 他自己出了 / 別人已經幫他出了
      const chk = SV.replay(g.deal, n, mv);
      if(!chk || chk.over || chk.turn !== seat) return false;
      const one = SVAI.autoMove(chk, seat);            // 替人代打一律用「普通」,不套難度
      if(!SV.step(chk, one)) return false;
      g.moves = mv.concat(one);
    });
  }

  /* ==========================================================================
     四、結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數。
       ★ 一定要帶 { local:false } —— 見檔頭與 notes/07 踩坑 #8。
       ★ 交易裡拿**伺服器的 moves** 再確認一次真的打完了:本地畫面清空不代表
         伺服器上清空,少了它會在還有人有牌的情況下寫下贏家、把整局提早結束。
     ========================================================================== */
  function maybeSettle(){
    if(!st || !st.over || ctx.winner() || !playing()) return;
    const n = nPlayers(), ord = ctx.order();
    ctx.txGame(g => {
      if(g.winner) return false;
      const chk = SV.replay(g.deal, n, Array.isArray(g.moves) ? g.moves : []);
      if(!chk || !chk.over) return false;
      const sc = SV.score(chk);
      g.winner = { ids: sc.winners.map(s => ord[s]).filter(Boolean), by: "score" };
    }, { local: false });
  }

  /* ==========================================================================
     五、mp-core 的 adapter 介面
     ========================================================================== */
  function ruleHint(){
    /* ⚠ 這一格只寫**規則**,不寫設計理由也不寫感想(台灣麻將 v1.67.1 的教訓)。
       ⚠ 「關掉就真的沒人催」那句不是贅字,是規則的後果 —— 沒有到期自動出牌,
          有人離開牌桌全桌就一直等。玩家要據此決定要不要設秒數。 */
    const sec = secOn() ? ("每一手 <b>" + turnSec + " 秒</b>,時間到系統會幫他出一張")
                        : "<b>不限時</b>——沒人催,有人離開牌桌全桌會一直等";
    return "52 張全發完,人數除不盡時前面的座位多 1 張。拿到 <b>♠︎7</b> 的人先出。<br>" +
           "只能接<b>同花色、點數相鄰</b>的牌(往上 8…K、往下 6…A),或開一條新花色的 7。<br>" +
           "<b>有牌可出就一定要出</b>;沒牌可出才蓋掉一張,<b>蓋什麼別人看不到</b>,結算才翻開。<br>" +
           "牌全部出完後,<b>蓋掉的點數加起來最少的人贏</b>(A=1、K=13);同分比張數,再同比誰先出完。<br>" +
           "出牌倒數:" + sec + "。";
  }

  return {
    ns: { rooms: "sevens_rooms", index: "sevens_index" },
    minPlayers: 2, maxPlayers: 6,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    prefsKey: "sevens.prefs.v1",
    emoteAnchor: "svStage",
    winCardId: "svWinCard",
    hasResign: false,                      // 多人局「認輸」語意不清(同數獨)

    init(c){ ctx = c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { turnSec: turnSec }; },
    onRoomField(k, v){
      if(k !== "turnSec") return;
      // ⚠ 守門用**範圍**而不是白名單 —— 舊房間 / 手改 DB 的值也要能用
      if(typeof v !== "number" || !(v === 0 || (v >= 10 && v <= 90)) || v === turnSec) return;
      turnSec = v;
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
      if(ctx.phase() === "playing"){ armTurnT(); paint(); }
    },
    readRoom(r){ if(typeof r.turnSec === "number") turnSec = r.turnSec; },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { deal: "", moves: [] }; },
    resetRound(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      SVB.clearSel(); SVB.stopCd();
    },
    newGame(ids, prev){
      // 座位每局重抽(先手由誰拿到 ♠7 決定,所以順序本身不影響公平,但換位置比較有感)
      const ord = ids.slice();
      for(let i = ord.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
      }
      return { order: ord, deal: SV.newDeal(), moves: [] };
    },
    applyGame(g, isPlaying){
      const next = Array.isArray(g.moves) ? g.moves : [];
      const prevLen = moves.length;
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);        // ★ 新局一律看 roundId,不可以看 deal 變沒變
      deal = g.deal || deal;
      moves = next.slice();
      if(!isPlaying){ st = null; return; }
      if(fresh){ curRound = rid; lastLen = -1; SVB.clearSel(); }

      st = SV.replay(deal, nPlayers(), moves);
      if(!st){ return; }                        // deal 壞掉(理論上不會)→ 什麼都不做,等下一個快照

      /* 音效走「前後兩份的 diff」而不是在動作點插 Sound.xxx() ——
         單機與連線的動作路徑完全不同,但「有人蓋牌了」在兩邊是同一個 diff。
         ⚠ 換局那一手一定要跳過(整包重來,diff 沒有意義);
         ⚠ 批次同步(重連歸位)也不連播,不然一口氣響三十幾聲。 */
      if(!fresh && moves.length === prevLen + 1){
        const one = moves[moves.length - 1];
        if(SV.movePass(one)) Sound.takeback(); else Sound.place();
      }
      // 這一手的錨點:牌數變了就重新起算(公開動作,全桌看得到)
      if(moves.length !== lastLen){
        lastLen = moves.length;
        turnAt = Date.now();
        if(isMyTurn() && !fresh) Sound.turn();
      }
      armTurnT();
      paint();
      maybeSettle();
    },

    /* ---------- 相位的專屬畫面 ----------
       各相位只說「要哪個畫面」,實際的 hidden 切換交給 main.js 的 showScreen() */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ clearTurnT(); showScreen("lobby"); },
    backToLobby(){
      clearTurnT();
      moves = []; st = null; curRound = null; lastLen = -1;
      SVB.clearSel(); SVB.stopCd();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      SVB.clearSel();
      // ★ 這一局開打前大家各幾勝(結果卡的「N 勝」欄要拿它 +1;見宣告處)
      baseWins = {};
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      paint();
    },
    onLeave(){
      clearTurnT();
      deal = ""; moves = []; st = null; curRound = null; lastLen = -1;
      baseWins = {};
      SVB.clearSel(); SVB.stopCd();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const seg = $("svSecSeg");
      if(seg){
        seg.classList.toggle("readonly", !isHost);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === turnSec));
      }
      const lbl = $("svSecLabel");
      if(lbl) lbl.textContent = isHost ? "出牌倒數" : "出牌倒數(房主決定)";
      const hint = $("svRuleHint");
      if(hint) hint.innerHTML = ruleHint();
    },
    updateGoal(){
      const g = $("mpBarGoal");
      if(!g) return;
      g.textContent = secOn() ? ("⏱ " + turnSec + " 秒") : "⏱ 不限時";
      g.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    turnId,
    // 晶片尾巴:剩幾張 / 蓋幾張。★ 蓋牌只給張數,牌值要等結算(這一頁唯一的牌情紅線)
    chipTail(id){
      if(!st) return "";
      const s = seatOf(id);
      if(s < 0 || s >= st.n) return "";
      return '<span class="sv-chn" title="手上剩幾張"><i class="sv-pip"></i>' + st.hands[s].length + '</span>' +
             (st.piles[s].length ? '<span class="sv-chp" title="蓋了幾張"><i class="sv-pip back"></i>' + st.piles[s].length + '</span>' : "");
    },
    lobbyStatusText(ids){ return ids.length < 2 ? "等待其他人加入…" : "等待大家準備…"; },
    readyHint(ids, ready){
      return ids.length < 2 ? "等別人加入…(房間可分享給朋友)"
                            : (ready ? "等其他人按準備…" : "按「準備好了」就開始");
    },
    refresh(){ if(st) paint(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, ids }){
      clearTurnT();
      SVB.stopCd();
      const box = $("svResult");
      if(box && st && st.over){
        const ord = ctx.order();
        const names = ord.map(id => ctx.dispName(id));
        /* ★ 累積勝場併進排名表(v1.75.9)—— 連線的結果卡從此只有**一張表**。
           得分名單直接用核心給的 ids(它就是等一下要 +1 的那些人),
           底數用開局快照,所以不必等 scores 節點同步回來。 */
        const gained = ids || [];
        const wins = ord.map(id => {
          const plus = gained.indexOf(id) >= 0;
          const base = (typeof baseWins[id] === "number") ? baseWins[id] : ctx.scoreOf(id);
          return { n: base + (plus ? 1 : 0), plus: plus };
        });
        box.innerHTML = SVB.resultHTML(st, names, mySeat(), "", wins);
        box.classList.remove("hidden");
      }
      paint();
      const me = mySeat();
      const row = (st && st.over) ? SV.score(st).rows[me] : null;
      /* ★ 一行(v1.75.3):底下的排名表已經逐列寫著「誰第幾名 / 蓋了什麼 / 幾分」,
         這一句只負責「這局誰贏、我幾分」。舊版是兩行(還帶 <br>),
         與排名表講同一件事三次 —— 使用者:「資訊相當得亂,應該要整合」。
         ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。
         ⚠ 措辭與單機那份(solo.js 的 finish())刻意寫成同一個格式。 */
      if(iWon){
        return { word: "你贏了!",
                 msg: (row && !row.cnt) ? "你一張都沒蓋掉,滿分過關 ✨"
                    : (row ? ("罰分 <b>" + row.pts + "</b> · 全場最少 🎉") : "罰分最少,這局你拿下 🎉") };
      }
      const ws = (w && w.ids || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: row ? ("第 " + row.rank + " 名") : "這局結束",
               msg: (ws ? (ws + " 罰分最少") : "這局結束") +
                    (row ? (" · 你 <b>" + row.pts + "</b> 分") : "") };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){ return { turnSec: turnSec, big: BigMode.get() }; },
    usePrefs(o){
      // 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
      BigMode.set(!!o.big);
      if(typeof o.turnSec === "number" && (o.turnSec === 0 || (o.turnSec >= 10 && o.turnSec <= 90))) turnSec = o.turnSec;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      tap, act, isMyTurn,
      turnSec: () => turnSec,
      setTurnSec(v){
        if(SECS.indexOf(v) < 0) return;
        if(!ctx.setRoomField("turnSec", v, { lobbyOnly: true, denyMsg: "只有房主能改倒數", busyMsg: "對戰中不能改倒數" })) return;
        turnSec = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      /* 給 e2e 用:把這一手的錨點往回撥,免得測「到期自動出牌」要真的等 30 秒。
         同消消樂的 MP.stallAge() —— 那類機制只有時間會觸發,e2e 等不了。 */
      _ageTurn(ms){ turnAt -= (+ms || 0); armTurnT(); paint(); }
    }
  };
})());

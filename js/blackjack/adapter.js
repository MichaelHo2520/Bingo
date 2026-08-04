"use strict";

/* ============================================================================
   21 點 — 連線適配器(接上 js/shared/mp-core.js)

   ── ★★ 這一頁與前七個遊戲最不一樣的三件事 ──────────────────────────────────
     ① **一場 = 很多局**。前七個遊戲「一局 = 一場」,21 點一局只有 30 秒,
        所以核心的 roundId 對應的是**一整場**,而場裡面的局由這裡自己推進。
     ② **規則由房主設定**,而且進了真相層:結算會用到平手誰贏 / 賠率 / 過五關 /
        先爆先輸,所以 rules 在**開局那一刻凍結進 game.rules**,之後一個字都不能改
        (改了會讓已經打完的局重算出不同結果 → 重連的人算出來的籌碼跟現場不一樣)。
     ③ **人數在對局中會變**(允許中途加入)—— 見下面「排隊不是插入」。

   ── ★ DB 上的樣子 ────────────────────────────────────────────────────────
       game.rules = {...}                 ★ 開局凍結(房規的**副本**,不是那個房間欄位)
       game.bj = {
         seq   這一場的第幾局(0-based,累計)  ★ 所有交易的守衛都是它
         rd    第幾輪 · k 這一輪的第幾局
         rot[] **這一輪**的輪莊順序(pid;輪開始時凍結)
               → 莊家 = BJ.dealerOf(rot, k, rules.hands) ★ v1.87.0 起「幾局換莊」可調,
                 所以一輪的局數是 BJ.handsPerRound(rot.length, hands) 而不是 rot.length
               ★★ v1.88.0 起它一定是 seats 的**旋轉**(BJ.rotOrder / BJ.rotKeep)——
                  座位號碼怎麼排,輪莊就怎麼輪;房規 first 只決定「從誰開始」
         seats[] **這一局**在桌上的人(pid;每局開始時重建 → 新人下一局就能當閒家)
               ★★ 它的順序就是桌上的「第幾家」(v1.88.0 起不洗牌了,見 newGame)
         deal  這一局的牌 · bets{pid:n} · acts{pid:"hs"}
         nets{pid:n}  這一場的累計淨籌碼變化(★ 可以是負的)
         over  這一局結算過了沒
       }
     每台裝置各自 `BJ.replay(deal, seats.length, dealerIdx, acts, rules)` 算出完整局面,
     所以**重連歸位不必特別處理**(批次同步就是同一支 replay 多跑幾個動作)。

   ── ★★ 手牌在 DB 是明碼,刻意不防作弊 ────────────────────────────────────
     受眾是親友聚會(見 CLAUDE.md)。同台灣麻將 / 排七 / 大老二,這**不是妥協而是
     架構優勢**:每台裝置都算得出「現在該等誰」,所以到期代打與結算**都不必指定房主**
     —— 誰的 timer 先響誰用交易搶,房主剛好斷線也不會全桌卡死。

     代價是「算得出來」不等於「可以顯示」。這一頁只有**一條**牌情紅線:
         ★ 莊家的第二張牌(暗牌)在翻開之前不可以畫出來。
     落地點在 board.js 的 dealerHTML(唯一判斷式是 `st.reveal`)。
     ⚠ 其他閒家的牌**全程明牌** —— 那是刻意的(看隔壁那個人補到爆是樂趣所在)。

   ── ★★ 中途加入是「排隊」,不是「插入」──────────────────────────────────────
     新人 claimSeat 成功的那一刻,現場可能正在某一局的中間(下注結束了、大家在補牌)。
       · **不插進進行中的那一局**:下一局重建 seats 時才發他牌
       · **下一輪**才排進輪莊表(rot)—— 使用者拍板的就是這個
     既有的相位機制天然支援這件事,不必新機制。
     ⚠ 所以這裡**不可以**用 ctx.order() 當座位表:那是核心在 newGame 那一刻寫的,
       不會跟著中途加入的人變。座位表一律讀 game.bj.seats。

   ── ★ 決定勝負的交易一定要帶 { local:false } ─────────────────────────────
     notes/07 踩坑 #8:Firebase 交易會先在本地樂觀套用,搶著寫的那台會**先**看到
     「我贏」而往 scores/ 寫分數,game 回退時分數不會跟著回退。
   ========================================================================== */

const MP = MPCore.create((function(){

  /* 一局結算後停多久再開下一局(= 過場開著的時間;全桌都要看得到結果)。
     ★★ v1.92.0 從 3200 拉到 3600:這一段從「一句飄走的 toast」變成一塊要**讀**的過場
       (每一家的押注 / 點數 / ±籌碼 / 手上多少)。
     ★★★ v1.94.0 再拉到 6000(使用者:「最後結算的畫面時間太短了」)——
       ⚠ 敢拉這麼長的**前提是同一版給了「點掉」那顆鈕**(見 board.js 八之四):
         只加長會變成「每一局都在等」。兩件事要一起改。
     ⚠ 單機有自己的一份(solo 的 SETTLE_MS)—— **數字要一樣**,改一邊記得改另一邊。 */
  const SETTLE_MS = 6000;
  let ctx = null;

  let rules = BJ.defRules();              // 大廳的房規(房主可改;開局後看的是 game.rules)
  let bj = null, gRules = null;           // 這一場的 bj 節點 / 凍結的房規
  let st = null;                          // 這一局的真相(BJ.replay)
  let curRound = null;                    // ★ 新場判定一律用 roundId
  let phaseKey = "", phaseAt = 0;         // 這一段的錨點(本地時鐘;各台差幾百毫秒無妨)
  /* 上一次的相位**名字**(v1.92.0)。★ 存在理由只有一個:發牌那一聲的判準是
     「**從 bet 換過來**」而不是「現在是 play」—— 開局兩張就到 21 / 爆的局會直接
     bet → dealer,用「現在是 play」的話那一局沒有發牌聲。
     ⚠ 它與 phaseKey 一定要一起清(fresh / resetRound / backToLobby / onLeave 四處)。 */
  let phaseNm = "";
  let phaseT = null;
  let baseNets = {};                      // 開局那一刻每個人的累積分快照(結果卡用)

  /* ---------- 座位 ----------
     ⚠ 一律讀 bj.seats(見檔頭「排隊不是插入」),不可以用 ctx.order()。 */
  const seatsOf = () => (bj && Array.isArray(bj.seats)) ? bj.seats : [];
  const nSeats = () => seatsOf().length;
  const seatOf = id => seatsOf().indexOf(id);
  const mySeat = () => seatOf(ctx.me());
  /* ★★★ 這一局的莊家是誰 —— **只有這兩支**(v1.87.0 的「幾局換莊」落地點)。
     ⚠⚠ 交易裡一律用 dPidIn(g, b)(讀 DB 那一份 + 凍結的 g.rules),
       本地那一份 dealerPid() 只給畫面用。⚠ 兩支都問 BJ.dealerOf ——
       誰都不可以自己寫 `rot[k % rot.length]`:那就是第二份輪莊真相,
       而症狀是「同一局不同裝置算出不同的莊家」(整局從此算不出來)。 */
  const dealerPid = () => (bj && Array.isArray(bj.rot))
    ? BJ.dealerOf(bj.rot, bj.k, gRules ? gRules.hands : 1) : null;
  const dealerIdx = () => seatOf(dealerPid());
  const dPidIn = (g, b) => BJ.dealerOf(b.rot || [], b.k, (g.rules && g.rules.hands) || 1);
  function nameOfSeat(s){
    const id = seatsOf()[s];
    return id ? ctx.dispName(id) : ("玩家" + (s + 1));
  }
  const names = () => seatsOf().map(id => ctx.dispName(id));
  const playing = () => ctx.phase() === "playing" && !ctx.winner() && !ctx.abandoned();
  const secOn = () => !!(gRules && gRules.sec > 0);

  /* 這一局在哪一段。★ 只有這一支決定相位名字,倒數與代打全部吃它。
     ⚠ 「還在下注」不在 st 裡(st 是「牌怎麼走」的真相)—— 它是「bets 收齊了沒」。 */
  function betsLeft(){
    if(!bj) return [];
    const d = dealerPid(), out = [];
    seatsOf().forEach(id => {
      if(id === d) return;
      if(!bj.bets || bj.bets[id] === undefined) out.push(id);
    });
    return out;
  }
  function phaseName(){
    if(!bj) return "";
    if(bj.over) return "over";
    if(betsLeft().length) return "bet";
    if(!st) return "bet";
    return st.phase;                      // "play" | "dealer" | "over"
  }
  const betting = () => phaseName() === "bet";

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  function paint(){
    if(!bj) return;
    const me = mySeat(), n = nSeats(), ph = phaseName();
    const nms = names();
    const bets = {}, betDone = [];
    seatsOf().forEach((id, i) => {
      const v = bj.bets && bj.bets[id];
      if(typeof v === "number") bets[i] = v;
      betDone[i] = (bj.bets && bj.bets[id] !== undefined);
    });

    /* ★ 公告(爆 / 21 點 / 過五關 / 被抓 / **有人押注** / **莊家翻牌**)—— 與單機
       **共用 board.js 的同一支**,所以這裡只有一行。
       ⚠ key 一律用 roundId + seq:換場**與**換局都要把上一份記錄清掉,
         而 seed 那條(prev === null 就只記不響)擋掉進場 / 重連 / 批次同步的亂響。
       ⚠ v1.92.0 起要一起餵 betDone:「押好的人多了一個」就響一聲籌碼(那一段 st 是 null)。
         舊版連線**別人押注一點聲音都沒有** —— 單機在動作點插了一行、連線沒有,
         那正是「兩邊各寫一份」走鐘的標準症狀。 */
    const key = ctx.roundId() + ":" + bj.seq;
    BJB.announce({ st: betting() ? null : st, names: nms, me: me, key: key, betDone: betDone });

    BJB.render({
      st: betting() ? null : st, n: n, me: me, names: nms,
      bets: bets, betPhase: betting(), betDone: betDone,
      /* ★★ v1.90.0:`dsub`(莊家台的副標)拿掉了 —— 它與下面那一行的 hintOf() 逐字相同,
         上下各印一次(使用者:「裡面有很多資訊是重覆了」)。
         ★ 改傳 `dealer`:下注階段 st 是 null,盤面靠它才知道莊家是誰
           (否則莊家台沒有名字,而莊家自己還會多占注區一格)。 */
      rules: gRules, over: ph === "over", dealer: dealerIdx()
    });

    const lg = (st && !betting() && me >= 0) ? BJ.legal(st, me)
                                             : { hit: false, stand: false, dbl: false, grab: false };
    BJB.renderActs({
      betPhase: betting(),
      mine: betting() ? (me >= 0 && seatsOf()[me] !== dealerPid())
                      : !!(playing() && (lg.hit || lg.stand || lg.grab)),
      betMax: (gRules ? gRules.betMax : rules.betMax),
      myBet: (me >= 0 && bets[me]) || 0,
      legal: lg,
      // ★ 抓人那一排要畫得出名字 → 動作列吃得到 st / me / names(v1.86.0)
      st: betting() ? null : st, me: me, names: nms,
      isDealer: !!(me >= 0 && seatsOf()[me] === dealerPid()),
      turnName: st ? (st.phase === "dealer" ? nameOfSeat(dealerIdx()) : "其他人") : "",
      over: ph === "over",
      hint: hintOf(),
      // 環給全桌看(現在在等誰、還剩幾秒是公開資訊,大家才知道為什麼卡著)
      cdMs: secOn() ? gRules.sec * 1000 : 0,
      cdEnd: secOn() ? phaseAt + winMs() : 0
    });
    paintHand(ph, me, nms);
    ctx.renderPlayers();
  }

  /* ★★★ 一局結束的過場(v1.92.0)—— 與單機**共用 BJB.showHand 那一支**。
     使用者:「每一把結束到底誰贏多少誰輸多少有點不太明確,乾脆搞個中間的過場」。
     ⚠⚠ 判準是 **`bj.over`**(結算真的寫進 DB 了)而不是只看 `ph === "over"`:
       `phaseName()` 在 `st.phase === "over"` 的那一刻就回 "over",但那時 `bj.nets`
       還沒加上這一局 → 過場的「手上多少」會先印舊值、下一個快照才跳對,
       而那個閃動剛好落在最需要看清楚的那一格。代價只是晚一次交易來回(~100~300ms)。
     ⚠ 進度條吃的是**剩下多久**(不是整段 SETTLE_MS):過場比相位晚開那一點點。 */
  function paintHand(ph, me, nms){
    if(ph !== "over" || !bj || !bj.over){ BJB.hideHand(); return; }
    const sc = settleNow();
    if(!sc){ BJB.hideHand(); return; }
    const r = gRules || rules;
    // 這一局是不是整場最後一局(★ 與 advance() 那條判斷同一個算式)
    const perR = BJ.handsPerRound((bj.rot || []).length, r.hands);
    const last = (bj.rd + 1 >= r.rounds) && (bj.k + 1 >= perR);
    const seq = bj.seq;
    BJB.showHand({
      st: st, names: nms, me: me, sc: sc,
      chips: seatsOf().map(id => r.start + ((bj.nets && bj.nets[id]) || 0)),
      key: ctx.roundId() + ":" + seq,
      title: "第 " + (bj.rd + 1) + "/" + r.rounds + " 輪 · 第 " + (bj.k + 1) + " 局 · 結算",
      /* ★★★ v1.94.0:看完可以點掉(使用者:「時間太短了…我希望有可以快速關掉的操作」)。
         ⚠⚠ 連線是**全桌一起跳**(誰先按誰推進)—— 那本來就是這一頁「不指定房主」的
           設計:`advance()` 是交易,守衛是 `b.over` + `seq`,與**到期推進走同一支**。
           所以鈕上與腳註**一定要講明「全桌一起」**:不講的話按的人不知道自己把別人
           正在讀的畫面也翻掉了(而那會變成現場的小爭執)。
         ⚠ 這裡**不可以**自己寫一份「換局」邏輯 —— 兩份推進真相的症狀是
           「同一局在不同裝置變成不同的下一局」。 */
      /* ⚠ v1.94.0:這一句講**進度條在幹嘛** + **按了會影響誰** ——
         舊的「準備下一局…」與旁邊那顆鈕講同一件事,而它們並排在同一列。
         ★ 「全桌一起」四個字不可以拿掉:那是連線與單機**唯一**的行為差別。 */
      foot: last ? "時間到會自動看結果" : "時間到會自動開下一局(誰按都是全桌一起)",
      skipTxt: last ? "看結果 ▸" : "下一局 ▸",
      onSkip: function(){ if(playing()) advance(seq); },
      ms: Math.max(600, phaseAt + SETTLE_MS - Date.now())
    });
  }

  /* 動作列那一句話。★ 只講「現在在等什麼」,不透露任何牌情。 */
  function hintOf(){
    const me = mySeat(), ph = phaseName();
    if(me < 0) return "你會在下一局進場(輪莊表要等下一輪)";
    const iAmD = seatsOf()[me] === dealerPid();
    if(ph === "over"){
      const sc = settleNow();
      const row = sc && sc.rows[me];
      return row ? ("本局結算:你 " + (row.delta > 0 ? "+" : "") + row.delta + " · " +
                    BJ.tagTxt(row.tag) + " —— 準備下一局…")
                 : "本局結算 —— 準備下一局…";
    }
    if(ph === "bet"){
      if(iAmD) return "這一局你當莊,不用下注 —— 等大家押完";
      const left = betsLeft().length;
      return left ? ("先押注,再發牌(還有 " + left + " 人沒押)") : "先押注,再發牌";
    }
    if(!st) return "";
    if(ph === "play"){
      if(iAmD) return "等閒家補牌…(你是莊家,最後才動)";
      if(st.done[me]) return "你停手了 —— 等其他人";
      return "要牌還是停?";
    }
    if(ph === "dealer"){
      /* ★★ v1.85.0:當莊的人**自己按**。★★★ v1.86.0:到線之後還能**抓人**。
         ⚠ 措辭與單機那份(solo.js hintOf)刻意寫成同一句。 */
      if(iAmD){
        if(st && BJ.legal(st, me).grab) return "翻牌了 —— 可以補牌,也可以抓人";
        return gRules.line
          ? ("翻牌了 —— 補到 " + gRules.line + " 才能停 / 抓人")
          : "翻牌了 —— 你要補嗎?(莊家自由決定)";
      }
      return "莊家在補牌…";
    }
    return "";
  }

  /* ==========================================================================
     二、我的動作
     ──────────────────────────────────────────────────────────────────────────
       交易內原子寫入,而且一律拿**伺服器的值**重跑一次規則再寫 ——
       本地畫面對不代表伺服器上對(同大老二 send() / 排七 send() 的守衛)。
       ★★ 這一頁的動作**不會互相衝突**:每個座位有自己的牌堆與自己的 acts 欄位
          (見 rules.js 檔頭),所以兩個人同時要牌零競態 —— 交易只是為了原子寫入。
     ========================================================================== */
  function txRound(mut, opts){
    const seq = bj ? bj.seq : -1;
    ctx.txGame(g => {
      if(g.status !== "playing" || g.winner) return false;
      const b = g.bj;
      if(!b || b.seq !== seq) return false;         // 已經換局了 → 中止,等快照
      return mut(g, b);
    }, opts);
  }
  /* 從一份 DB 的 bj 節點重算局面(★ 交易裡一定要用它,不可以拿本地的 st) */
  function stOf(g, b){
    const seats = Array.isArray(b.seats) ? b.seats : [];
    const d = seats.indexOf(dPidIn(g, b));
    if(d < 0) return null;
    const acts = seats.map(id => (b.acts && b.acts[id]) || "");
    return BJ.replay(b.deal, seats.length, d, acts, g.rules);
  }
  function betsArrOf(b, seats){
    const out = {};
    seats.forEach((id, i) => { const v = b.bets && b.bets[id]; if(typeof v === "number") out[i] = v; });
    return out;
  }

  function sendBet(v){
    const me = ctx.me();
    const amt = BJ.clampBet(v, gRules || rules);
    txRound((g, b) => {
      if(b.over) return false;
      if((b.seats || []).indexOf(me) < 0) return false;
      if(me === dPidIn(g, b)) return false;         // 莊家不押注
      b.bets = b.bets || {};
      if(b.bets[me] !== undefined) return false;    // 押過了(交易層的冪等)
      b.bets[me] = amt;
    });
  }

  function sendAct(a){
    const me = ctx.me();
    txRound((g, b) => {
      if(b.over) return false;
      const seats = Array.isArray(b.seats) ? b.seats : [];
      const i = seats.indexOf(me);
      if(i < 0) return false;
      const chk = stOf(g, b);
      if(!chk) return false;
      const next = BJ.push(chk, i, a, seats.map(id => (b.acts && b.acts[id]) || ""));
      if(next === null) return false;               // 伺服器真值上不合法 → 不寫
      b.acts = b.acts || {};
      b.acts[me] = next;
    });
  }

  function act(a, betVal){
    /* ★ 「抓人那一排開了 / 關了」——**純畫面**,把牌桌重畫一次讓亮框跟上
       (v1.87.0:抓人改成點桌上那一格,而那幾格是 BJB.render() 畫的)。
       ⚠ 擺在 playing() 那一關**前面**:它不是動作,不該被相位守門擋掉。 */
    if(a === "grepaint"){ if(bj) paint(); return; }
    if(!playing()){ if(a) showToast("現在不能動"); return; }
    const me = mySeat();
    if(me < 0){ showToast("你會在下一局進場"); return; }
    const ph = phaseName();
    if(a === "bet"){
      if(ph !== "bet"){ showToast("下注時間過了"); return; }
      if(seatsOf()[me] === dealerPid()){ showToast("這一局你當莊,不用下注"); return; }
      if(bj.bets && bj.bets[ctx.me()] !== undefined){ showToast("你已經押了 " + bj.bets[ctx.me()]); return; }
      sendBet(betVal);
      return;
    }
    if(ph === "bet"){ showToast("先押注"); return; }
    if(ph === "over"){ showToast("本局結算中,等一下就開下一局"); return; }
    if(!st) return;
    /* ★ 抓人(v1.86.0)。⚠ 文案一律走 BJ.denyTxt(與單機同一份)。 */
    if(a === "gdeny"){
      const first = (function(){ for(let s = 0; s < st.n; s++) if(s !== st.dealer) return s; return 0; })();
      showToast(BJ.denyTxt(st, me, BJ.grabAct(first)) || "現在不能抓人");
      return;
    }
    if(a === "g"){
      const why = BJ.denyTxt(st, me, BJ.grabAct(betVal));
      if(why){ showToast(why); return; }
      sendAct(BJ.grabAct(betVal));
      return;
    }
    if(a !== "h" && a !== "s") return;
    /* ★ 說得出原因 —— 不用 disabled 讓點擊靜默消失(CLAUDE.md 的紅線)。
       ★★ 文案走 BJ.denyTxt(與單機同一份;它也負責莊家補牌線那兩句)。 */
    const why = BJ.denyTxt(st, me, a);
    if(why){ showToast(why); return; }
    sendAct(a);
  }

  /* ==========================================================================
     三、倒數 / 到期代打 / 推進
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主:每一台都排 timer,誰先響誰用交易搶(房主剛好斷線也不會全桌卡死)。
         按座位錯開只是少幾次註定白跑的交易。
       ⚠ 下限 1200ms 兜底 —— 錨點是本地時鐘,慢半拍收到快照的那台會算出「已經過期」
         而一收到就結算(台灣麻將踩過)。
     ========================================================================== */
  /* 這一段的窗口有多長。★ 只有「結算展示」有自己的長度,其餘一律吃房規的倒數。
     ★★ v1.85.0 拿掉了「有補牌線就 700ms 自動幫莊家補完」那一條 ——
        當莊的是**人**,他要自己按(使用者:「電腦幫我自動會很沒感覺」)。
        補牌線改成限制哪一顆鈕按得動(BJ.legal),所以規則一個字都沒鬆;
        真的沒人按時照樣有到期代打(forceDealer → BJ.autoDealer)接手。
     ⚠ 倒數關掉(sec=0)時莊家那一段就真的沒人催 —— 與其他三段一致
       (房規那一行本來就寫著「不限時:有人離開牌桌全桌會一直等」)。 */
  function winMs(){
    const ph = phaseName();
    if(ph === "over") return SETTLE_MS;
    return secOn() ? gRules.sec * 1000 : 0;
  }
  function clearPhaseT(){ if(phaseT){ clearTimeout(phaseT); phaseT = null; } }

  function armPhaseT(){
    clearPhaseT();
    if(!bj || !playing()) return;
    const ph = phaseName();
    const total = winMs();
    if(!total) return;                              // 倒數關掉 → 只有 over / 自動莊家會排
    const me = Math.max(0, mySeat());
    const wait = Math.max(1200, phaseAt + total - Date.now()) + me * 150;
    const seq = bj.seq;
    phaseT = setTimeout(() => { onExpire(ph, seq); }, wait);
  }

  function onExpire(ph, seq){
    phaseT = null;
    if(!bj || bj.seq !== seq || !playing() || phaseName() !== ph) return;
    if(ph === "bet") forceBets(seq);
    else if(ph === "play") forceStands(seq);
    else if(ph === "dealer") forceDealer(seq);
    else if(ph === "over") advance(seq);
  }

  /* 到期沒押注的人 → 幫他押最小注(★ 不是跳過:跳過等於他這一局不用賭,對別人不公平) */
  function forceBets(seq){
    txRound((g, b) => {
      if(b.over) return false;
      const seats = Array.isArray(b.seats) ? b.seats : [];
      const d = dPidIn(g, b);
      const min = BJ.minBet(g.rules);
      let any = false;
      b.bets = b.bets || {};
      seats.forEach(id => {
        if(id === d) return;
        if(b.bets[id] === undefined){ b.bets[id] = min; any = true; }
      });
      if(!any) return false;
    });
  }
  /* 到期還沒停手的閒家 → 幫他停(★ 不是幫他補:補牌會爆,而「停」永遠不會讓他更慘)。
     ⚠⚠ v1.86.0:**閒家現在也有補牌線** —— 沒到線的時候 "s" 本身就不合法,
       硬寫進去會讓整份 acts 變成 bad(而症狀是「那一局從此算不出來」)。
       → 一律走 BJ.autoTo:它會先幫他補到線再停(補牌線關掉時就是單純的 "s",
         與 v1.85.0 的行為逐字相同)。 */
  function forceStands(seq){
    txRound((g, b) => {
      const seats = Array.isArray(b.seats) ? b.seats : [];
      const chk = stOf(g, b);
      if(!chk || chk.phase !== "play") return false;
      b.acts = b.acts || {};
      let any = false;
      for(let i = 0; i < seats.length; i++){
        if(i === chk.dealer || chk.done[i]) continue;
        const add = BJ.autoTo(chk, i);
        if(!add) continue;
        b.acts[seats[i]] = ((b.acts[seats[i]]) || "") + add;
        any = true;
      }
      if(!any) return false;
    });
  }
  /* 莊家:房規有補牌線 → 整段算得出來(不必等人按);自由補牌到期 → 側退成補到 17。
     ★ 兩條都走 BJ.autoDealer(它自己處理 line = 0 的側退)—— 一份真相。 */
  function forceDealer(seq){
    txRound((g, b) => {
      const seats = Array.isArray(b.seats) ? b.seats : [];
      const chk = stOf(g, b);
      if(!chk || chk.phase !== "dealer") return false;
      const seqStr = BJ.autoDealer(chk);
      if(!seqStr) return false;
      b.acts = b.acts || {};
      b.acts[seats[chk.dealer]] = ((b.acts[seats[chk.dealer]]) || "") + seqStr;
    });
  }

  /* ==========================================================================
     四、結算(一局)
     ──────────────────────────────────────────────────────────────────────────
       ★ 不指定房主(同上),誰先算完誰寫;交易保證只有第一個算數(守衛是 b.over)。
       ★ 交易裡拿**伺服器的值**再確認一次真的結束了:本地畫面看起來結束不代表
         伺服器上結束,少了它會在還有人沒動的情況下把籌碼寫進去。
       ⚠ 這一筆**不必** { local:false }:它寫的是 game 節點裡的 nets,
         game 回退時 nets 跟著回退(踩坑 #8 講的是「分數在另一個節點」)。
     ========================================================================== */
  function settleNow(){
    if(!st || st.phase !== "over" || !bj) return null;
    const bets = {};
    seatsOf().forEach((id, i) => { const v = bj.bets && bj.bets[id]; if(typeof v === "number") bets[i] = v; });
    return BJ.settle(st, bets, gRules);
  }

  function maybeSettle(){
    if(!bj || bj.over || !st || st.phase !== "over" || !playing()) return;
    const seq = bj.seq;
    txRound((g, b) => {
      if(b.over) return false;
      const seats = Array.isArray(b.seats) ? b.seats : [];
      const chk = stOf(g, b);
      if(!chk || chk.phase !== "over") return false;
      const sc = BJ.settle(chk, betsArrOf(b, seats), g.rules);
      const nets = b.nets || {};
      seats.forEach((id, i) => {
        const row = sc.rows[i];
        if(row) nets[id] = (nets[id] || 0) + row.delta;
      });
      b.nets = nets;
      b.over = true;
    });
  }

  /* ==========================================================================
     五、推進 —— 下一局 / 下一輪 / 整場結束
     ──────────────────────────────────────────────────────────────────────────
       ★★ 一場的長度用**輪**算(notes/17 第 4 節):一輪 = 這一輪 rot 裡的每個人
          當莊各一次。莊家有數學優勢,輪莊制是靠「當莊次數一樣」平衡掉的 ——
          所以**不可以**用局數定義長度(6 人打 5 局 = 有一個人根本沒當到莊,
          而他吃的虧是系統性的、不是運氣)。
       ★ 每一**局**重建 seats(新人下一局就能當閒家);每一**輪**重建 rot
         (新人下一輪才排進輪莊表)—— 這正是使用者拍板的那一條。
       ⚠ rot[k] 的人離開了 → 那一格跳掉(k 繼續往前);整輪跳完就換輪。
     ========================================================================== */
  /* 保留原本的相對順序、補上新人、去掉離開的人。
     ★ 這一支現在**只給座位表用**(v1.88.0):座位號碼要黏著同一個人,新人排在後面。
     ⚠ 輪莊表**不可以**用它 —— rot 是座位表的旋轉,由 BJ.rotKeep 排(見 advance)。 */
  function mergeIds(prev, ids){
    const keep = (prev || []).filter(id => ids.indexOf(id) >= 0);
    const add = ids.filter(id => keep.indexOf(id) < 0);
    return keep.concat(add);
  }

  function advance(seq){
    const ids = Object.keys(ctx.players());
    if(ids.length < 2) return;                       // 人不夠 → 交給核心的「落單回大廳」
    /* ★ 先判斷是不是整場結束 —— 那一筆要單獨走 { local:false }(見檔頭)。
       ⚠ 一輪的局數是 **人數 × 幾局換莊**(v1.87.0)→ 一律問 BJ.handsPerRound,
         寫 `bj.rot.length` 的話 hands=2 時會在半輪就把整場結束掉。 */
    const perR = bj ? BJ.handsPerRound((bj.rot || []).length, gRules ? gRules.hands : 1) : 1;
    if(bj && bj.over && bj.rd + 1 >= (gRules ? gRules.rounds : 2) && bj.k + 1 >= perR){
      finishMatch(seq);
      return;
    }
    txRound((g, b) => {
      if(!b.over) return false;
      const rounds = (g.rules && g.rules.rounds) || 2;
      const hands = (g.rules && g.rules.hands) || 1;
      let rd = b.rd, k = b.k + 1;
      let rot = (b.rot || []).slice();
      /* 下一局的座位表(★ 先算它:v1.88.0 起輪莊表是**座位表的旋轉**,
         所以換輪那一步要拿新的座位表去排,順序反了新人就會被丟到輪莊表最後)。 */
      const seats2 = mergeIds(b.seats, ids);
      const per = BJ.handsPerRound(rot.length, hands);
      /* 這一輪剩下的莊家裡,已經離開的直接跳掉。
         ⚠ hands ≥ 2 時「一個莊家」占 hands 格 → 條件一定要問 BJ.dealerOf,
           寫 rot[k] 的話只跳掉那個人的第一局,第二局又輪回給已經離開的人。 */
      while(k < per && ids.indexOf(BJ.dealerOf(rot, k, hands)) < 0) k++;
      if(k >= per){
        k = 0; rd++;
        if(rd >= rounds) return false;                // 整場結束 → 上面那條路處理
        /* ★★★ v1.88.0:下一輪的輪莊表 = **新座位表的旋轉**(接著上一輪的起點),
           不再是 mergeIds(那會把中途加入的人丟到輪莊表最後)。
           ⚠ 落地點只有 BJ.rotKeep 一支 —— 在這裡自己排就是第二份輪莊真相。 */
        rot = BJ.rotKeep(seats2, rot);                // ★ 新人下一輪進輪莊表(照座位號)
      }
      b.rd = rd; b.k = k; b.rot = rot;
      b.seats = seats2;                               // ★ 新人下一局就能當閒家
      b.seq = (b.seq || 0) + 1;
      b.deal = BJ.newDeal();
      b.bets = {}; b.acts = {}; b.over = false;
    });
  }

  /* 整場結束 → 寫 winner。
     ★ pts 帶的是**淨籌碼變化**(可以是負的)—— 核心 v1.84.0 起 A.scoreSigned 讓它
       原封不動加進 scores(不帶 scoreSigned 的七個舊遊戲行為逐字不變)。
     ⚠ winner.ids 只放**第一名**:大字 / 彩帶 / 卡片配色全部吃 winnerIds(),
       第二名淨籌碼是正的但沒有贏,不該放彩帶。
     ★ 一定要帶 { local:false } —— 見檔頭與 notes/07 踩坑 #8。 */
  function finishMatch(seq){
    ctx.txGame(g => {
      if(g.winner) return false;
      const b = g.bj;
      if(!b || b.seq !== seq || !b.over) return false;
      const nets = b.nets || {};
      const ids = (b.seats || []).slice();
      let top = null;
      ids.forEach(id => { const v = nets[id] || 0; if(top === null || v > top) top = v; });
      g.winner = {
        ids: ids.filter(id => (nets[id] || 0) === top),
        pts: ids.reduce((o, id) => { o[id] = (nets[id] || 0); return o; }, {}),
        by: "chips"
      };
    }, { local: false });
  }

  /* ==========================================================================
     六、mp-core 的 adapter 介面
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 房規的**清單文案**在 board.js 的 BJB.rulesHTML(單機與連線共用同一份),
         **面板本體**在 main.js 的 syncRules(同一組 DOM,單機也是它)——
         這一支一行文案都不自己寫。
     ========================================================================== */
  return {
    ns: { rooms: "bj_rooms", index: "bj_index" },
    minPlayers: 2, maxPlayers: 6,          // ★ 改這裡要同步改 js/home-live.js 的 GAMES.max
    prefsKey: "bj.prefs.v1",
    emoteAnchor: "bjStage",
    winCardId: "bjWinCard",
    hasResign: false,                      // 多人局「認輸」語意不清(同數獨 / 排七 / 大老二)
    /* ★★ 計分是**淨籌碼變化**,可以是負的 → 核心 v1.84.0 的 A.scoreSigned。
       不帶這個旗標的七個舊遊戲行為逐字不變(那是整段改動能安全上線的關鍵)。 */
    scoreSigned: true,
    scoreUnit: "籌碼", goalDefault: 30, goalMax: 200,
    /* ★★ 允許**對局中加入**(核心 v1.84.0 的 A.joinMidGame)。
       它同時解掉四處判定(mp-core 的 joinable / 房間列標籤 / join 的硬擋 +
       home-live 的 joinable)。⚠ home-live 的 GAMES 要一起加 joinMid:true。 */
    joinMidGame: true,

    init(c){ ctx = c; },

    /* ---------- 房間層級設定:整包房規一個欄位 ----------
       ★ 一個欄位而不是八個:核心會替每個 roomFields 的 key 掛一個監聽,
         八個欄位就是八個監聽 + 八條守門,而它們永遠一起改一起讀。 */
    roomFields(){ return { bjRules: rules }; },
    onRoomField(k, v){
      if(k !== "bjRules") return;
      const next = BJ.normRules(v);          // ⚠ 守門用範圍 / 白名單(舊房間、手改 DB 都要能用)
      if(JSON.stringify(next) === JSON.stringify(rules)) return;
      rules = next;
      ctx.unreadyOnFieldChange();
      ctx.syncSetup(); ctx.updateGoal();
    },
    readRoom(r){ if(r && r.bjRules) rules = BJ.normRules(r.bjRules); },

    /* ---------- 一場的生命週期 ---------- */
    lobbyGame(){ return { rules: null, bj: null }; },
    resetRound(){
      clearPhaseT();
      bj = null; gRules = null; st = null; curRound = null; phaseKey = ""; phaseNm = ""; phaseAt = 0;
      BJB.resetAnnounce(); BJB.stopCd(); BJB.hideHand();
    },
    newGame(ids){
      /* ★★★ v1.88.0:座位**不再洗牌** —— seats 的順序就是桌上的「第幾家」(座位號碼),
         而輪莊表是它的**旋轉**(起點由房規 first 決定)。
         使用者:①「玩家順序,為什麼我總是最後」②「房主需要能夠指定誰先當莊」。
         ⚠ 拿掉洗牌不影響公平性:公平性來自輪莊制的「每個人當莊次數一樣」,
           而旋轉不改變那件事 —— 洗牌反而讓玩家看不出下一個莊家是誰。
         ★ 只有房主會跑到這裡(核心的 startGame 擋過)→ first="host" 的那個人就是 ctx.me()。
         ★ rot 與 seats 在開局時是**同一組人**(順序差一個旋轉);
           之後 seats 每局重建、rot 每輪由 BJ.rotKeep 重建。 */
      const seats = ids.slice();
      const rot = BJ.rotOrder(seats, rules.first, ctx.me());
      return {
        order: seats,
        /* ★★ 房規在**這一刻**凍結成 game.rules 的副本 —— 之後房間欄位怎麼改都不影響
           這一場(改了會讓已經打完的局重算出不同結果)。 */
        rules: BJ.normRules(rules),
        bj: { seq: 0, rd: 0, k: 0, rot: rot, seats: seats,
              deal: BJ.newDeal(), bets: {}, acts: {}, nets: {}, over: false }
      };
    },
    applyGame(g, isPlaying){
      const rid = ctx.roundId();
      const fresh = (rid !== curRound);           // ★ 新場一律看 roundId
      if(!isPlaying){ bj = null; st = null; gRules = null; return; }
      if(fresh){ curRound = rid; phaseKey = ""; phaseNm = ""; BJB.resetAnnounce(); }

      gRules = BJ.normRules(g.rules);             // ⚠ 讀凍結的那一份,不是房間欄位
      bj = g.bj || null;
      if(!bj){ st = null; return; }
      // 資料容錯:seats / rot 壞掉(理論上不會)→ 等下一個快照,不硬算
      const d = dealerIdx();
      if(d < 0){ st = null; return; }
      st = BJ.replay(bj.deal, nSeats(), d,
                     seatsOf().map(id => (bj.acts && bj.acts[id]) || ""), gRules);
      if(!st) return;

      /* 這一段的錨點:相位名字變了就重新起算(公開資訊,全桌看得到同一個環)。
         ⚠ key 要含 seq —— 不含的話「上一局的 bet」與「這一局的 bet」是同一個字串,
           換局時倒數不會重新起算(而症狀是新的一局一開始就只剩幾秒)。 */
      const ph0 = phaseName();
      const pk = bj.seq + ":" + ph0;
      if(pk !== phaseKey){
        const fromBet = (phaseNm === "bet");
        phaseKey = pk; phaseNm = ph0;
        phaseAt = Date.now();
        /* ★★ v1.92.0:「押注收齊 → 牌刷出去」那一聲 —— dealSfx 的**兩個呼叫點之一**
           (另一個在 solo.maybeDeal)。舊版這裡是 Sound.turn()(Bingo 的「換你了」叮咚),
           而且只有**非莊家的閒家**聽得到 —— 發牌是全桌同時發生的事,大家都該聽到。
           ⚠ 判準是「從 bet 換過來」不是「現在是 play」:兩張就到 21 / 爆的局會直接
             bet → dealer(見 phaseNm 的註解)。
           ⚠ `!fresh` 那一關要留:重連 / 第一次同步時相位一定「剛變」,
             不擋的話一進房就刷一串發牌聲(同 announce 的 seed 那條)。 */
        if(!fresh && fromBet && ph0 !== "bet") BJB.dealSfx(nSeats() * 2);
      }
      armPhaseT();
      paint();
      maybeSettle();
    },

    /* ---------- 相位的專屬畫面 ----------
       各相位只說「要哪個畫面」,實際的 hidden 切換交給 main.js 的 showScreen() */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ clearPhaseT(); showScreen("lobby"); },
    backToLobby(){
      clearPhaseT();
      bj = null; gRules = null; st = null; curRound = null; phaseKey = ""; phaseNm = "";
      BJB.resetAnnounce(); BJB.stopCd(); BJB.hideHand();
      showScreen("lobby");
    },
    enterPlaying(){
      showScreen("play");
      // ★ 這一場開打前大家各幾分(結果卡的累積欄要拿它加這場的淨變化;見 outcome)
      baseNets = {};
      ctx.order().forEach(id => { baseNets[id] = ctx.scoreOf(id); });
      BJB.resetAnnounce();
      BJB.hideHand();
      /* ★ 四句喊牌語音先載好(爆了 / 21 點 / 過五關 / 抓)—— 語音槽沒有合成音後備,
         懶載入的話「這一場第一次爆」永遠沒聲音(見 board.js primeVoice)。
         ⚠ 這裡已經在使用者手勢之後(他剛按了「準備好了」)→ AudioContext 解得開。 */
      BJB.primeVoice();
    },
    onLeave(){
      clearPhaseT();
      bj = null; gRules = null; st = null; curRound = null;
      phaseKey = ""; phaseNm = ""; baseNets = {};
      BJB.resetAnnounce(); BJB.stopCd(); BJB.hideHand();
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      syncRules(rules, ctx.isHost());          // ★ 面板只有一份(單機也呼叫這一支)
      const hint = $("bjRuleHint");
      // ★ 清單文案也只有一份;⚠ 「點名」那一位的名字由 main.js 的 bjFirstName 解讀 token
      if(hint) hint.innerHTML = BJB.rulesHTML(rules, bjFirstName(rules));
      const btn = $("bjRulesOpen");
      if(btn) btn.textContent = ctx.isHost() ? "⚙ 改規則" : "📋 看規則";
    },
    /* ★★★ v1.90.0:**對戰中不畫「⏱ Ns」那一段**。
       使用者:「已經開始遊戲後,限時幾秒不要顯示,有機會影響到麥克風跟 emoji 的位置」。
       ★ 理由不只是長度 —— 對戰中「還剩幾秒」由動作列那顆倒數環在講,而且它講的是
         **這一段還剩多久**(比一個固定的設定值有用)→ 這一段在對戰中是重複資訊。
       ⚠ 大廳照舊要畫:那是房主挑設定的地方,看不到就不知道自己選了什麼。
       ⚠ 這一支在 enterPlaying / backToLobby / enterLobby 都會被核心叫一次
         (mp-core),所以相位一換文字就跟著換 —— 不必自己另外接線。
       ⚠ 「擠掉麥克風」還有 CSS 那一半:.mp-goal 是 flex:none(整條不縮),
         styles.css 的 `.bj-room .mp-goal` 把它改成縮得動 + 省略號。兩邊都要。 */
    updateGoal(){
      const el = $("mpBarGoal");
      if(!el) return;
      const r = gRules || rules;
      const playing = ctx.phase() === "playing";
      el.textContent = "🎩 " + r.rounds + " 輪 · " +
        (r.hands > 1 ? (r.hands + " 局換莊 · ") : "每局換莊 · ") +
        "押上限 " + r.betMax +
        (playing ? "" : (r.sec ? (" · ⏱ " + r.sec + "s") : " · ⏱ 不限時"));
      el.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    /* turnId:21 點的閒家是**同時**動的,所以「輪到誰」在 play 階段沒有單一答案 ——
       只有莊家補牌那一段才有。★ 回 null 時核心不會給任何人 .turn,那是對的。 */
    turnId(){
      if(!bj || !st) return null;
      if(st.phase !== "dealer") return null;
      return dealerPid();
    },
    /* 晶片尾巴:莊記號 + 這一場的籌碼。★★ 那一小段 HTML 走 BJB.chipHTML ——
       v1.85.0 起與單機的 paintBar **同一份**(配色要一起改才會一致)。
       ★ 兩樣都是**公開資訊**(誰當莊全場都看得到,籌碼是結算過的歷史)。
       ⚠ 這裡一個字都不准提牌 —— 這一頁唯一藏起來的是莊家那張暗牌,而它在盤面上。 */
    chipTail(id){
      if(!bj) return "";
      const net = (bj.nets && bj.nets[id]) || 0;
      const chip = (gRules ? gRules.start : rules.start) + net;
      /* ★ 座位號碼(v1.88.0):輪莊照號碼往下輪 → 晶片列也要看得出誰是第幾家。
         ⚠ 大廳沒有座位表 → seatOf 回 -1,chipHTML 就不畫那顆徽章(號碼要開局才定)。
         ⚠ v1.92.0:chipHTML 不再吃 net(「±多少」那一格拿掉了)—— 這一把賺賠多少
           由**過場**講,晶片列只答「他現在有多少錢」(見 board.js chipHTML)。 */
      return BJB.chipHTML(chip, id === dealerPid(), seatOf(id));
    },
    lobbyStatusText(ids){ return ids.length < 2 ? "等待其他人加入…" : "等待大家準備…"; },
    readyHint(ids, ready){
      return ids.length < 2 ? "等別人加入…(房間可分享給朋友)"
                            : (ready ? "等其他人按準備…" : "按「準備好了」就開始");
    },
    refresh(){ if(bj) paint(); },

    /* ---------- 結果(整場) ---------- */
    outcome(w, { iWon, ids }){
      clearPhaseT();
      BJB.stopCd();
      BJB.hideHand();                  // ★ 過場收掉,換整場的結果卡上場(v1.92.0)
      const me = mySeat();
      const nets = (bj && bj.nets) || {};
      const seats = seatsOf();
      const myNet = (me >= 0) ? (nets[seats[me]] || 0) : 0;
      const r = gRules || rules;

      const box = $("bjResult");
      if(box && bj){
        const netArr = seats.map(id => nets[id] || 0);
        /* ★ 累積籌碼併進排名表 —— 連線的結果卡從此只有**一張表**
           (共用連線層的 #winScores 那些列由 CSS 收掉,只留「🎯 搶 N 籌碼」)。
           ⚠ 這一場各加幾分直接讀 winner.pts(核心就是照它加的),底數用開局快照,
             所以不必等 scores 節點同步回來。 */
        const pts = (w && w.pts) || {};
        const foot = seats.length + " 人 · " + r.rounds + " 輪 · 累積:" +
          seats.map(id => {
            const add = (typeof pts[id] === "number") ? pts[id] : 0;
            const base = (typeof baseNets[id] === "number") ? baseNets[id] : ctx.scoreOf(id);
            return esc(ctx.dispName(id)) + " " + (base + add);
          }).join(" · ");
        let h = BJB.matchHTML(names(), netArr, r, me, foot);
        if(st && st.phase === "over"){
          const sc = settleNow();
          if(sc) h += '<div class="bj-rsub">最後一局</div>' + BJB.resultHTML(st, names(), me, sc, null, "");
        }
        box.innerHTML = h;
        box.classList.remove("hidden");
      }
      paint();
      /* ★ 一句話(照排七 v1.75.3 的結論):底下的排名表已經逐列寫著
         「誰第幾 / 籌碼多少 / ±多少」,這一句只負責「這場誰第一、我賺賠多少」。
         ⚠ 名字要自己 esc() —— msg 是當 HTML 塞進 #winMsg 的(notes/07 踩坑 #9)。
         ⚠ 措辭與單機那份(solo.js 的 finishMatch())刻意寫成同一個格式。 */
      const line = "這一場你 <b>" + (myNet > 0 ? "+" : "") + myNet + "</b> 籌碼(手上 " + (r.start + myNet) + ")";
      if(iWon) return { word: "你贏了!", msg: line + " 🎉" };
      const ws = (w && w.ids || []).map(id => esc(ctx.dispName(id))).join("、");
      return { word: "這場結束", msg: line + (ws ? (" · 第一名是 " + ws) : "") };
    },

    /* ---------- 偏好 ---------- */
    ownPrefs(){ return { bjRules: rules }; },
    /* ⚠⚠ v1.93.0:還原偏好時**丟掉 bjPay** —— 面板已經沒有那一列了(兩個階都賠 2 倍),
       曾經選過 1.5 的人**沒有任何按鈕改得回來**,會永遠卡在 1.5(而且他當房主時
       全桌都吃那個值)。★ 這是「寫入收緊」;讀取那一側(readRoom / onRoomField)
       **刻意不動** —— 舊版房主寫的 1.5 要照樣尊重,不然同一局兩台算出不同籌碼。
       ⚠ 這一段與 solo.loadOwn 是**同一件事的兩份**(單機與連線的偏好各存一包),
         改一邊記得改另一邊。 */
    usePrefs(o){
      if(!o || !o.bjRules) return;
      const r0 = Object.assign({}, o.bjRules);
      delete r0.bjPay;
      rules = BJ.normRules(r0);
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      act,
      rules: () => rules,
      /* 房主改房規。★ lobbyOnly:對局中一個字都不能改(見檔頭②)。 */
      setRule(key, val){
        const next = BJ.normRules(Object.assign({}, rules, { [key]: val }));
        if(!ctx.setRoomField("bjRules", next, { lobbyOnly: true,
              denyMsg: "只有房主能改規則", busyMsg: "對戰中不能改規則(這一場的規則已經定下來了)" })) return;
        rules = next; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      // 給 e2e 用:直接讀當下的局面(不經過畫面)
      _st: () => st,
      _bj: () => bj,
      _rules: () => gRules || rules,
      _seat: mySeat,
      /* 給 e2e 用:把這一段的錨點往回撥,免得測「到期代打」要真的等 30 秒。
         同排七的 MP._ageTurn / 大老二的 MP._ageTurn —— 那類機制只有時間會觸發。 */
      _agePhase(ms){ phaseAt -= (+ms || 0); armPhaseT(); paint(); }
    }
  };
})());

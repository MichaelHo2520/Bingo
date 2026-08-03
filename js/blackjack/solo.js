"use strict";

/* ============================================================================
   21 點 — 電腦對決(單機)

   與連線對戰共用同一組盤面(BJB)、同一條動作列(#bjActs)、同一張結果卡
   (#veil / .bj-win),差別只在上面那條列與結果卡的按鈕組 —— 靠 body 的
   solo-on class 切換(與其他七個遊戲同一個模式)。

   ⚠ 完全不碰 Firebase,也不碰 MP:一局的真相只有這裡的 `st`(BJ.replay 的狀態)。

   ── ★ 一場 = 幾輪,一輪 = 每個人當莊各一次 ────────────────────────────────
     莊家有數學優勢(平手莊吃 + 閒家先爆先輸 + 預設還自由補牌),輪莊制是靠
     「每個人當莊的次數一樣」把它平衡掉的 —— 所以**長度用「輪」算不能用「局」**
     (notes/17 第 4 節)。單機這裡人數固定,所以一輪就是固定的 n 局。

   ── ★ 一局的相位(與連線逐字相同,那是刻意的)──────────────────────────────
       下注(閒家同時) → 發牌 → 閒家補牌(同時) → 莊家翻暗牌 + 補牌 → 結算
     ★ 閒家「同時」在單機看起來是「電腦一個接一個動」,但真相層完全獨立
       (每個座位有自己的牌堆,見 rules.js 檔頭)—— 所以電腦的順序不影響任何結果。

   ⚠⚠ 電腦的每一個動作都要走帶世代記號的 later() —— 台灣麻將 / 排七 / 大老二
      都踩過「離場後電腦繼續打牌」那個坑:quit() 只把 active 設成 false 的話,
      已經排進 setTimeout 的那一手照樣會跑,而那時 st 可能已經是下一局的了。
   ========================================================================== */

const Solo = (function(){

  const ME = 0;                                  // 我固定坐 0 號位
  const NAMES = ["你", "阿發", "小美", "老K", "阿德"];
  const OWN_KEY = "bj.solo.v1";
  const SETTLE_MS = 2900;                        // 一局結算後停幾毫秒再開下一局

  let level = "mid", seats = 4;
  let rules = BJ.defRules();

  let rot = [], rd = 0, k = 0, round = 0;        // 輪莊順序 / 第幾輪 / 這一輪第幾局 / 第幾局(累計)
  let deal = "", acts = [], bets = {}, st = null;
  let nets = [];                                 // 每個座位這一場的淨籌碼變化
  let betting = false, settled = null;           // 下注階段 / 這一局的結算結果
  let active = false, over = false, busy = false;
  let gen = 0;                                   // 世代記號:離場 / 換局後,舊的 timer 一律不執行
  let rec = {};

  /* ---------- 偏好與戰績 ----------
     刻意與連線那組分開存:連線的房規是「房主替全房選的」,和自己想單練哪一級是兩回事
     (比照 big2.solo.v1 / sevens.solo.v1)。 */
  function blank(){ return { n: 0, w: 0, p: 0 }; }
  function loadOwn(){
    try{
      const o = JSON.parse(localStorage.getItem(OWN_KEY)) || {};
      if(BJAI.LEVEL_INFO[o.level]) level = o.level;
      if(o.seats >= BJ.MIN_PLAYERS && o.seats <= BJ.MAX_PLAYERS) seats = o.seats;
      if(o.rules) rules = BJ.normRules(o.rules);
      rec = (o.rec && typeof o.rec === "object") ? o.rec : {};
    }catch(e){}
    BJAI.LEVEL_KEYS.forEach(x => { if(!rec[x]) rec[x] = blank(); });
  }
  function saveOwn(){
    try{ localStorage.setItem(OWN_KEY, JSON.stringify({ level, seats, rules, rec })); }catch(e){}
  }
  function recOf(x){ const r = rec[x] || blank(); if(typeof r.p !== "number") r.p = 0; return r; }
  function recText(x){
    const r = recOf(x);
    return r.n ? (r.n + " 場 " + r.w + " 次第一 · 淨 " + (r.p > 0 ? "+" : "") + r.p) : "尚無戰績";
  }
  function recLine(x){
    const r = recOf(x);
    return r.n ? ("你在這個難度打過 " + r.n + " 場,拿下第一 " + r.w + " 次,累積淨籌碼 " +
                  (r.p > 0 ? "+" : "") + r.p)
               : "還沒跟這個難度玩過";
  }

  /* ---------- 世代記號 ---------- */
  function later(fn, ms){
    const g = gen;
    setTimeout(() => { if(g === gen && active && !over) fn(); }, ms);
  }
  function bumpGen(){ gen++; }

  /* ---------- 小工具 ---------- */
  function seatName(s){ return NAMES[s] || ("玩家" + (s + 1)); }
  const names = () => { const a = []; for(let s = 0; s < seats; s++) a.push(seatName(s)); return a; };
  const dealer = () => BJ.dealerOf(rot, k);
  const iAmDealer = () => dealer() === ME;
  // 一場共幾局(單機人數固定 → 算得出來;⚠ 連線那邊不行,見 adapter)
  const totalRounds = () => rules.rounds * seats;
  const doneRounds = () => rd * seats + k;

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  /* 單機的玩家列。★ 沿用房間框那組 .mp-chip / .bj-room 的外觀 ——
     連線與單機長得一樣才有一致感。
     ★ 晶片上放的是**籌碼**(= 起始 + 淨變化)與「莊」記號:兩樣都是公開資訊。
     ⚠ 牌情紅線與這裡無關 —— 21 點唯一藏起來的是莊家那張暗牌,而那在盤面上。 */
  function paintBar(){
    const box = $("bjSoloPlayers");
    if(box){
      box.className = "mp-players oneline";
      const d = dealer();
      let h = "";
      for(let s = 0; s < seats; s++){
        const net = nets[s] || 0;
        const chip = rules.start + net;
        const isTurn = !!(st && !betting && !over &&
                          (s === d ? st.phase === "dealer" : (st.phase === "play" && !st.done[s])));
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") + '">' +
               '<span class="bj-dot p' + s + '"></span>' +
               '<span class="gmk-nm">' + esc(seatName(s)) + '</span>' +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               (s === d ? '<span class="bj-chd" title="這一局的莊家">🎩 莊</span>' : "") +
               '<span class="bj-chc" title="手上的籌碼">' + chip +
                 (net ? '<i class="' + (net > 0 ? "up" : "down") + '">' +
                        (net > 0 ? "+" : "") + net + '</i>' : "") + '</span>' +
             '</div>';
      }
      box.innerHTML = h;
    }
    const lv = $("bjSoloLv");
    if(lv) lv.textContent = BJAI.levelOf(level).name;
    const r = $("bjSoloRec");
    /* ⚠ 圖示一律 🎴(U+1F3B4)。**不可以**用小丑牌那個 emoji(U+1F0CF)——
       它落在 U+1F0A0–U+1F0FF 那段撲克牌字元裡,多數字型沒有、會變豆腐方框
       (CLAUDE.md 的禁令;大老二的單機 e2e 當場抓過一次)。 */
    if(r) r.textContent = active
      ? ("🎴 第 " + (rd + 1) + "/" + rules.rounds + " 輪 · 這一場第 " + (doneRounds() + 1) + "/" + totalRounds() + " 局")
      : ("🎴 " + seats + " 人 · " + recText(level));
  }

  /* 動作列那一句話。★ 只講「現在在等什麼」,不透露任何牌情。 */
  function hintOf(){
    if(settled){
      const mine = settled.rows[ME];
      const dv = mine ? mine.delta : 0;
      return "本局結算:你 " + (dv > 0 ? "+" : "") + dv + " · " + BJ.tagTxt(mine ? mine.tag : "") +
             " —— 準備下一局…";
    }
    if(betting) return iAmDealer() ? "這一局你當莊,不用下注 —— 等大家押完" : "先押注,再發牌";
    if(!st) return "";
    if(st.phase === "play"){
      if(iAmDealer()) return "等閒家補牌…(你是莊家,最後才動)";
      if(st.done[ME]) return "你停手了 —— 等其他人";
      return "要牌還是停?";
    }
    if(st.phase === "dealer"){
      if(iAmDealer()) return rules.line
        ? ("你是莊家,規則要求補到 " + rules.line + " —— 系統幫你補")
        : "翻牌了 —— 你要補嗎?(莊家自由決定)";
      return "莊家在補牌…";
    }
    return "";
  }

  function paint(){
    paintBar();
    const d = dealer();
    const nms = names();
    /* ★ 公告(爆 / 21 點 / 五小龍)—— 與連線**共用 board.js 的同一支**,所以這裡只有一行。
       ⚠ key 一律用「這是哪一局」:換局時它負責把上一局的記錄清掉,
         而 seed 那條(prev === null 就只記不響)擋掉進場 / 換局的亂響。 */
    BJB.announce({ st: betting ? null : st, names: nms, me: ME, key: "solo:" + round });
    BJB.render({
      st: betting ? null : st, n: seats, me: ME, names: nms,
      bets: bets, betPhase: betting,
      betDone: (function(){ const a = []; for(let s = 0; s < seats; s++) a[s] = bets[s] !== undefined; return a; })(),
      rules: rules, over: over
    });

    const lg = (st && !betting) ? BJ.legal(st, ME) : { hit: false, stand: false, dbl: false };
    const myTurn = !!(st && !betting && !over && !busy && !settled &&
                      (lg.hit || lg.stand));
    BJB.renderActs({
      betPhase: betting,
      // 我是莊家時 mine 明確給 false → 動作列會講「這一局你當莊,不用下注」
      mine: betting ? !iAmDealer() : myTurn,
      betTiers: BJ.betTiers(rules.betMax),
      myBet: bets[ME] || 0,
      legal: lg,
      turnName: st ? (st.phase === "dealer" ? seatName(d) : "其他人") : "",
      over: !!settled || over,
      hint: hintOf()
      // 單機不做倒數 —— 卡多久是自己的節奏(同大老二 / 排七)
    });
  }

  /* ==========================================================================
     二、一場 / 一局的生命週期
     ========================================================================== */
  function startMatch(){
    bumpGen();
    /* ★ 輪莊順序:我(0 號位)排在**最後** —— 第一局讓電腦當莊,新手才看得懂
       「莊家是怎麼運作的」。⚠ 每個人還是各當一次,公平性不受影響。 */
    rot = [];
    for(let s = 1; s < seats; s++) rot.push(s);
    rot.push(ME);
    rd = 0; k = 0; round = 0;
    nets = [];
    for(let s = 0; s < seats; s++) nets[s] = 0;
    over = false; busy = false; active = true;
    BJB.resetAnnounce();
    closeWin();
    showScreen("solo");
    Sound.start();
    saveOwn();
    startRound();
  }

  function startRound(){
    bumpGen();
    round++;
    deal = BJ.newDeal();
    acts = [];
    for(let s = 0; s < seats; s++) acts[s] = "";
    bets = {}; settled = null; busy = false;
    st = BJ.replay(deal, seats, dealer(), acts, rules);
    betting = true;
    paint();
    showToast("第 " + (doneRounds() + 1) + "/" + totalRounds() + " 局 —— " +
              (iAmDealer() ? "這一局你當莊 🎩" : (seatName(dealer()) + " 當莊 🎩")), 2200);
    aiBets();
  }

  function quit(){
    bumpGen();
    active = false; over = false; busy = false; betting = false;
    st = null; settled = null;
    BJB.resetAnnounce(); BJB.stopCd();
    closeWin();
    showScreen("home");
    showHomeLayer("solo");        // 回到「電腦對決」那一層,方便換難度再來
  }
  function again(){ closeWin(); startMatch(); }

  /* ==========================================================================
     三、下注
     ========================================================================== */
  function needBets(){
    for(let s = 0; s < seats; s++){
      if(s === dealer()) continue;
      if(bets[s] === undefined) return true;
    }
    return false;
  }
  function aiBets(){
    if(!active || over) return;
    for(let s = 0; s < seats; s++){
      if(s === ME || s === dealer()) continue;
      const seat = s;
      // 錯開一點,看起來像大家陸續押注(而不是一瞬間全部押完)
      later(() => {
        if(!betting || bets[seat] !== undefined) return;
        bets[seat] = BJAI.bet(rules, nets[seat] || 0, level);
        Sound.place();
        paint();
        maybeDeal();
      }, 240 + seat * 210);
    }
    // 我當莊 → 我不押注,而電腦押完就直接發牌
    maybeDeal();
  }
  function myBet(v){
    if(!active || over || !betting) return;
    if(iAmDealer()){ showToast("這一局你當莊,不用下注"); return; }
    const b = BJ.clampBet(v, rules);
    bets[ME] = b;
    Sound.place();
    paint();
    maybeDeal();
  }
  /* 全部押完 → 發牌。★ 「發牌」在這一頁只是把 betting 關掉:
     牌本來就在 deal 裡(座位牌堆),所以不必也不該有另一套「發牌動畫的真相」。 */
  function maybeDeal(){
    if(!betting || needBets()) return;
    betting = false;
    st = BJ.replay(deal, seats, dealer(), acts, rules);
    Sound.turn();
    paint();
    later(drive, 420);
  }

  /* ==========================================================================
     四、補牌 —— 閒家(同時)→ 莊家
     ──────────────────────────────────────────────────────────────────────────
       ★ drive() 是唯一的推進入口:它問 st.phase,不自己記狀態。
         ⚠ 相位一律問 replay 算出來的 st.phase —— 這一頁**沒有**第二份相位真相。
     ========================================================================== */
  function apply(seat, act){
    const next = BJ.push(st, seat, act, acts);
    if(next === null) return false;
    acts[seat] = next;
    st = BJ.replay(deal, seats, dealer(), acts, rules);
    BJB.moveSfx(act);
    return true;
  }

  function drive(){
    if(!active || over || betting || settled) return;
    if(!st) return;
    if(st.phase === "over"){ finishRound(); return; }

    if(st.phase === "play"){
      // 找一個還沒停手的電腦閒家
      for(let s = 0; s < seats; s++){
        if(s === ME || s === dealer() || st.done[s]) continue;
        const seat = s;
        busy = true; paint();
        later(() => {
          let mv = null;
          try{ mv = BJAI.pick(st, seat, level); }catch(e){ mv = null; }
          // 保險:AI 出了任何意外都不能讓遊戲卡住 → 退回「停」
          if(!mv || !apply(seat, mv)) apply(seat, "s");
          busy = false;
          paint();
          drive();
        }, BJAI.thinkMs(level));
        return;
      }
      // 沒有電腦要動了 → 剩我(或大家都停了,phase 會變成 dealer)
      busy = false; paint();
      return;
    }

    if(st.phase === "dealer"){
      const d = dealer();
      /* ★ 房規有補牌線 → 莊家沒有決策空間,整段算得出來(連等他點都不必)。
         ⚠ 我當莊時也走這條:規則要求的就不該讓我自己按(按了只會有一個合法答案)。 */
      if(rules.line){
        busy = true; paint();
        later(() => {
          const seq = BJ.autoDealer(st);
          for(let i = 0; i < seq.length; i++) apply(d, seq[i]);
          busy = false;
          paint();
          drive();
        }, 620);
        return;
      }
      if(d === ME){ busy = false; paint(); return; }    // 自由補牌 + 我當莊 → 等我按
      busy = true; paint();
      later(() => {
        let mv = null;
        try{ mv = BJAI.dealerPick(st, level); }catch(e){ mv = null; }
        if(!mv || !apply(d, mv)) apply(d, "s");
        busy = false;
        paint();
        drive();
      }, BJAI.thinkMs(level));
    }
  }

  /* 我按了要牌 / 停 / 加倍 */
  function act(a, betVal){
    if(!active) return;
    if(a === "bet"){ myBet(betVal); return; }
    if(over){ showToast("這一場已經結束了"); return; }
    if(betting){ showToast("先押注"); return; }
    if(settled){ showToast("本局結算中,等一下就開下一局"); return; }
    if(busy){ showToast("等其他人動完"); return; }
    if(!st) return;
    const lg = BJ.legal(st, ME);
    if(!lg.hit && !lg.stand){
      // ★ 說得出原因 —— 不用 disabled 讓點擊靜默消失(CLAUDE.md 的紅線)
      if(st.done[ME]) showToast(BJ.valueOf(st.hands[ME]).bust ? "你已經爆了" : "你已經停手了");
      else showToast(iAmDealer() ? "你是莊家,等閒家先補完" : "還沒輪到你");
      return;
    }
    if(a === "d" && !lg.dbl){ showToast("加倍只能在還沒補牌的時候"); return; }
    if(a !== "h" && a !== "s" && a !== "d") return;
    if(!apply(ME, a)){ showToast("這個動作現在不行"); return; }
    paint();
    drive();
  }

  /* ==========================================================================
     五、結算 —— 一局結束 → 累加籌碼 → 下一局 / 整場結束
     ========================================================================== */
  function finishRound(){
    if(settled) return;
    settled = BJ.settle(st, bets, rules);
    for(let s = 0; s < seats; s++) nets[s] += (settled.rows[s] ? settled.rows[s].delta : 0);
    const mine = settled.rows[ME];
    if(mine && mine.delta > 0) Sound.win();
    else if(mine && mine.delta < 0) Sound.lose();
    paint();
    showToast("本局:你 " + (mine.delta > 0 ? "+" : "") + mine.delta + " 籌碼 · " +
              BJ.tagTxt(mine.tag), 2400);

    // 下一局 / 下一輪 / 整場結束
    later(() => {
      settled = null;
      k++;
      if(k >= seats){ k = 0; rd++; }
      if(rd >= rules.rounds){ finishMatch(); return; }
      startRound();
    }, SETTLE_MS);
  }

  function finishMatch(){
    over = true; busy = false;
    bumpGen();
    // 名次看**淨變化**(見 board.js matchHTML 那段的紅線)
    const sorted = [];
    for(let s = 0; s < seats; s++) sorted.push({ s: s, net: nets[s] || 0 });
    sorted.sort((a, b) => (b.net - a.net) || (a.s - b.s));
    const myRank = sorted.findIndex(x => x.s === ME) + 1;
    const iWon = myRank === 1;

    const r = recOf(level);
    r.n++; if(iWon) r.w++; r.p += (nets[ME] || 0);
    rec[level] = r;
    saveOwn();
    paint();

    const card = $("bjWinCard");
    if(card){ card.classList.remove("win", "lose", "draw"); card.classList.add(iWon ? "win" : "lose"); }
    $("winWord").textContent = iWon ? "你贏了!" : ("第 " + myRank + " 名");
    const lv = BJAI.levelOf(level);
    const net = nets[ME] || 0;
    /* ★ 大字底下只留**一句**「這場我賺賠多少」——「人數 · 難度 · 戰績」那些局外資訊
       降級到表尾(照排七 v1.75.3 的結論)。同一件事講三次正是使用者說過的「資訊相當得亂」。
       ⚠ 措辭與連線那份(adapter 的 outcome())刻意寫成同一個格式 ——
         兩份走鐘的話沒有東西抓得到。 */
    $("winMsg").innerHTML = "這一場你 <b>" + (net > 0 ? "+" : "") + net + "</b> 籌碼(手上 " +
      (rules.start + net) + ")" +
      (iWon ? " 🎉" : (" · 第一名是 " + esc(seatName(sorted[0].s))));

    const box = $("bjResult");
    if(box){
      const foot = seats + " 人 · " + rules.rounds + " 輪(" + totalRounds() + " 局) · " +
                   lv.emoji + lv.name + " · 戰績 " + recText(level);
      box.innerHTML = BJB.matchHTML(names(), nets, rules, ME, foot) +
                      '<div class="bj-rsub">最後一局</div>' +
                      BJB.resultHTML(st, names(), ME, BJ.settle(st, bets, rules), null, "");
      box.classList.remove("hidden");
    }
    if(iWon){ Sound.win(); burst(); }
    else Sound.lose();
    showResult();
  }

  /* ==========================================================================
     六、房規面板(單機 = 我就是房主,走**同一份**預設值與同一組選項)
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 面板的渲染只准一份 —— 單機與連線各寫一份是這個專案最痛的那類走鐘
         (全螢幕 / 表情 / 罐頭句都踩過)。所以這裡只**存值**,畫面交給 main.js 的
         syncRules(),而連線那邊呼叫的是同一支。
     ========================================================================== */
  function setRule(key, val){
    const next = Object.assign({}, rules);
    next[key] = val;
    rules = BJ.normRules(next);
    saveOwn();
    return rules;
  }

  return {
    loadOwn, startMatch, quit, again, act, paintBar, paint,
    active: () => active,
    playing: () => active && !over,          // 給更新檢查:局中重載會把整場丟掉
    level: () => level, seats: () => seats,
    rules: () => rules, setRule,
    recText, recLine, totalRounds,
    setLevel(v){ if(BJAI.LEVEL_INFO[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(v >= BJ.MIN_PLAYERS && v <= BJ.MAX_PLAYERS){ seats = v; saveOwn(); } },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    _st: () => st,
    _nets: () => nets.slice(),
    _bets: () => Object.assign({}, bets),
    _dealer: dealer
  };
})();

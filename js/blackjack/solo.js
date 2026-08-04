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
  const NAMES = ["你", "阿發", "小美", "老K", "阿德", "阿慶嫂"];   // ★ v1.86.0 加到 6 人
  const OWN_KEY = "bj.solo.v1";
  /* 一局結算後停幾毫秒再開下一局(= 過場開著的時間)。
     ★★ v1.92.0 從 2900 拉到 3600:這一段從「一句飄走的 toast」變成一塊要**讀**的過場
       (每一家的押注 / 點數 / ±籌碼 / 手上多少),6 人局那張表 2.9 秒讀不完。
     ★★★ v1.94.0 再拉到 6000(使用者:「最後結算的畫面時間太短了」)——
       ⚠ 敢拉這麼長的**前提是同一版給了「點掉」那顆鈕**(見 board.js 八之四):
         只加長會變成「每一局都在等」。兩件事要一起改。
     ⚠ 連線那邊有自己的一份(adapter 的 SETTLE_MS)—— 兩邊刻意不共用:它同時是
       「到期推進」的窗口長度,而那是連線特有的機制(單機沒有 timer 在搶)。
       ★ 但**數字要一樣**,不然同一件事在兩邊的節奏不同(改一邊記得改另一邊)。 */
  const SETTLE_MS = 6000;

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
      /* ⚠⚠ v1.93.0:還原偏好時**丟掉 bjPay** —— 那一列已經從面板上拿掉了
         (兩個階都賠 2 倍),所以曾經選過 1.5 的人**沒有任何按鈕改得回來**,
         會永遠卡在 1.5。★ 這是「寫入收緊」的一部分:我自己的偏好一律回到預設 2;
         而**房間欄位照舊尊重**(那才是讀取相容要保護的東西,見 rules.js 第四節)。
         ⚠ 只 delete 這一格、不要整份丟掉:其他房規是使用者自己調的。 */
      if(o.rules){
        const r0 = Object.assign({}, o.rules);
        delete r0.bjPay;
        rules = BJ.normRules(r0);
      }
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
  /* ★★ 莊家是誰一律問 BJ.dealerOf(rot, k, rules.hands)——「幾局換莊」的落地點只有它
     (v1.87.0)。⚠ 這裡自己寫 `rot[k % seats]` 就是第二份輪莊真相。 */
  const dealer = () => BJ.dealerOf(rot, k, rules.hands);
  const iAmDealer = () => dealer() === ME;
  // 一輪有幾局 = 人數 × 幾局換莊(★ 一輪的定義沒變:每個人各當一次莊)
  const perRound = () => BJ.handsPerRound(seats, rules.hands);
  // 一場共幾局(單機人數固定 → 算得出來;⚠ 連線那邊不行,見 adapter)
  const totalRounds = () => rules.rounds * perRound();
  const doneRounds = () => rd * perRound() + k;

  /* ==========================================================================
     一、畫面
     ========================================================================== */
  /* 單機的玩家列。★ 沿用房間框那組 .mp-chip / .bj-room 的外觀 ——
     連線與單機長得一樣才有一致感。
     ★ 晶片上放的是**籌碼**(= 起始 + 淨變化)與「莊」記號:兩樣都是公開資訊,
       而那一小段 HTML 走 BJB.chipHTML(v1.85.0 起與連線的 chipTail **同一份**)。
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
        /* ★ 座位號碼(v1.88.0)由 BJB.chipHTML 那一份畫(連線的 chipTail 走同一支)——
           原本那顆純裝飾的色點就不必了:號碼本身已經帶著同一組顏色。 */
        /* ⚠ v1.92.0:chipHTML 不再吃 net(「±多少」那一格拿掉了,見 board.js 那段)——
           這一把賺賠多少由**過場**講,晶片列只答「他現在有多少錢」。 */
        h += '<div class="mp-chip' + (isTurn ? " turn" : "") + (s === ME ? " me" : "") + '">' +
               '<span class="gmk-nm">' + esc(seatName(s)) + '</span>' +
               (s === ME ? '<span class="you-badge">你</span>' : "") +
               BJB.chipHTML(chip, s === d, s) +
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

  /* 動作列那一句話。★ 只講「現在在等什麼」,不透露任何牌情。
     ⚠ v1.92.0 起結算那一段被**過場**蓋住了 → 下面那句話平常看不到。刻意留著:
       混合快取(拿到新的 js 卻還吃著舊的 blackjack.html)時 `#bjHand` 不存在,
       showHand 會早退 → 這一句就是那時唯一的結算資訊。 */
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
      /* ★★ v1.85.0:我當莊時**一律自己按**(使用者:「電腦幫我自動會很沒感覺」)。
         ★★★ v1.86.0:補牌線變成下限,而且到線之後可以**抓人** —— 那才是台式的重點,
            所以這一句要把「現在能不能抓」講出來。 */
      if(iAmDealer()){
        const lg = BJ.legal(st, ME);
        if(lg.grab) return "翻牌了 —— 可以補牌,也可以抓人";
        return rules.line
          ? ("翻牌了 —— 補到 " + rules.line + " 才能停 / 抓人")
          : "翻牌了 —— 你要補嗎?(莊家自由決定)";
      }
      return "莊家在補牌…";
    }
    return "";
  }

  function paint(){
    paintBar();
    const d = dealer();
    const nms = names();
    // 誰押好了(★ 畫面與公告的 diff **吃同一份** —— 算兩次就是兩份會錯開的真相)
    const bd = [];
    for(let s = 0; s < seats; s++) bd[s] = bets[s] !== undefined;
    /* ★ 公告(爆 / 21 點 / 過五關 / 被抓 / **有人押注** / **莊家翻牌**)—— 與連線
       **共用 board.js 的同一支**,所以這裡只有一行。
       ⚠ key 一律用「這是哪一局」:換局時它負責把上一局的記錄清掉,
         而 seed 那條(prev === null 就只記不響)擋掉進場 / 換局的亂響。
       ⚠ v1.92.0 起要一起餵 betDone:「押好的人多了一個」就響一聲籌碼,而那一段 st 是 null。 */
    BJB.announce({ st: betting ? null : st, names: nms, me: ME,
                   key: "solo:" + round, betDone: bd });
    BJB.render({
      st: betting ? null : st, n: seats, me: ME, names: nms,
      bets: bets, betPhase: betting,
      betDone: bd,
      /* ★★ v1.90.0:`dsub`(莊家台的副標)拿掉了 —— 它吃的就是下面那一行的 hintOf(),
         上下各印一次同一句話(使用者:「裡面有很多資訊是重覆了」)。
         ★ 改傳 `dealer`:下注階段 st 還是 null,盤面靠它才知道莊家是誰
           (否則莊家台沒有名字,而莊家自己還會多占注區一格)。 */
      rules: rules, over: over, dealer: d
    });

    const lg = (st && !betting) ? BJ.legal(st, ME)
                                : { hit: false, stand: false, dbl: false, grab: false };
    const myTurn = !!(st && !betting && !over && !busy && !settled &&
                      (lg.hit || lg.stand || lg.grab));
    BJB.renderActs({
      betPhase: betting,
      // 我是莊家時 mine 明確給 false → 動作列會講「這一局你當莊,不用下注」
      mine: betting ? !iAmDealer() : myTurn,
      betMax: rules.betMax,
      myBet: bets[ME] || 0,
      legal: lg,
      // ★ 抓人那一排要畫得出名字 → 動作列吃得到 st / me / names(v1.86.0)
      st: betting ? null : st, me: ME, names: nms, isDealer: iAmDealer(),
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
    /* ★★★ v1.88.0:輪莊順序 = **座位順序的旋轉**,起點由房規 first 決定
       (BJ.rotOrder 一支,連線那邊呼叫的是同一支)。
       ⚠⚠ 舊版把 ME 寫死排在**最後**(「第一局讓電腦當莊,新手才看得懂」)——
         那正是使用者抱怨的「為什麼我總是最後」,**不要因為那個理由再加回去**:
         現在預設是 first="host" = 我先當莊,想讓電腦先當莊改房規點名一台就好。
       ★ 單機的「座位識別」就是座位號(0..n-1),而 rotOrder 只做字串比對 →
         單機與連線因此共用同一份輪莊真相(不是兩份長得很像的程式)。 */
    const ids = [];
    for(let s = 0; s < seats; s++) ids.push(s);
    rot = BJ.rotOrder(ids, rules.first, ME);
    rd = 0; k = 0; round = 0;
    nets = [];
    for(let s = 0; s < seats; s++) nets[s] = 0;
    over = false; busy = false; active = true;
    BJB.resetAnnounce();
    BJB.hideHand();
    closeWin();
    showScreen("solo");
    Sound.start();
    /* ★ 四句喊牌語音先載好(爆了 / 21 點 / 過五關 / 抓)—— 語音槽沒有合成音後備,
       懶載入的話「這一場第一次爆」永遠沒聲音(見 board.js primeVoice 的註解)。
       ⚠ 這裡已經在使用者手勢之後(他剛按了「開始」),所以 AudioContext 解得開。 */
    BJB.primeVoice();
    saveOwn();
    startRound();
  }

  function startRound(){
    bumpGen();
    BJB.hideHand();                                // ★ 上一局的過場收掉(v1.92.0)
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
    BJB.resetAnnounce(); BJB.stopCd(); BJB.hideHand();
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
        /* ⚠ v1.92.0:這裡**不再**插一行 Sound.place() —— 籌碼那一聲改走
           BJB.announce 的 diff(paint() 裡那一行),所以單機與連線是同一條路。
           留著的話會與 diff 疊成兩聲。 */
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
    paint();                       // ⚠ 籌碼那一聲走 announce 的 diff(同 aiBets 那條)
    maybeDeal();
  }
  /* 全部押完 → 發牌。★ 「發牌」在這一頁只是把 betting 關掉:
     牌本來就在 deal 裡(座位牌堆),所以不必也不該有另一套「發牌動畫的真相」。 */
  function maybeDeal(){
    if(!betting || needBets()) return;
    betting = false;
    st = BJ.replay(deal, seats, dealer(), acts, rules);
    /* ★★ v1.92.0:發牌那一刻改成「牌一張一張刷出去」(舊版是 Sound.turn() —— 那是
       Bingo 的「換你了」叮咚,跟發牌沒關係)。★ 這是 dealSfx 的**兩個呼叫點之一**
       (另一個在 adapter 的相位換手),兩邊各寫一份就是走鐘。 */
    BJB.dealSfx(seats * 2);
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
          /* 保險:AI 出了任何意外都不能讓遊戲卡住。
             ⚠⚠ v1.86.0 起**不可以**無腦退回 "s" —— 補牌線是下限,沒到線的時候
               "s" 本身就不合法,apply 會回 false 而這一局就靜靜地卡住了。
               → 退回「合法的那一顆」。 */
          if(!mv || !apply(seat, mv)) apply(seat, safeAct(seat));
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
      /* ★★★ 我當莊 → **一律等我按**,不管房規有沒有補牌線(v1.85.0)。
         使用者的原話:「當莊家時,我希望可以自己選擇補牌,而不是電腦幫我自動,
         這樣會很沒感覺」。補牌線改成「哪一顆鈕按得動」(BJ.legal),
         所以規則一個字都沒鬆,但每一張牌都是自己按出來的。
         ⚠ 這一行**要在 rules.line 那條之前** —— 順序反了就又變成系統幫我補完。 */
      if(d === ME){ busy = false; paint(); return; }
      /* ★★★ v1.86.0 拿掉了「房規有補牌線 → autoDealer 一次算完」那一段:
         補牌線變成**下限**之後,莊家到線了還能繼續補、還能決定抓誰 ——
         他**永遠有決策空間**,所以一律走 dealerPick 一步一步演。
         ⚠ 順帶:一次算完的話畫面會跳過抓人那幾步,玩家看不到發生什麼事。 */
      busy = true; paint();
      later(() => {
        let mv = null;
        try{ mv = BJAI.dealerPick(st, level); }catch(e){ mv = null; }
        if(!mv || !apply(d, mv)) apply(d, safeAct(d));
        busy = false;
        paint();
        drive();
      }, BJAI.thinkMs(level));
    }
  }
  /* 一定套得進去的那一顆(見上面兩處的 ⚠)。★ 與 BJ.legal 同一份真相。 */
  function safeAct(seat){
    const lg = BJ.legal(st, seat);
    return lg.stand ? "s" : (lg.hit ? "h" : "s");
  }

  /* 我按了下注 / 要牌 / 停(★ v1.85.0 起沒有加倍了) */
  function act(a, betVal){
    if(!active) return;
    /* ★ 「抓人那一排開了 / 關了」——**純畫面**,只要把牌桌重畫一次讓亮框跟上
       (v1.87.0:抓人改成點桌上那一格,而那幾格是 BJB.render() 畫的)。
       ⚠ 一定要在最前面:它不是動作,不該被下面那些相位守門擋掉。 */
    if(a === "grepaint"){ paint(); return; }
    if(a === "bet"){ myBet(betVal); return; }
    if(over){ showToast("這一場已經結束了"); return; }
    if(betting){ showToast("先押注"); return; }
    if(settled){ showToast("本局結算中,等一下就開下一局"); return; }
    if(busy){ showToast("等其他人動完"); return; }
    if(!st) return;
    /* ★ 抓人(v1.86.0):a="g" 帶座位、a="gdeny" 是「抓不動的時候按了那一顆」。
       ⚠ 兩條都走 BJ.denyTxt —— 文案只有一份(單機與連線共用)。 */
    if(a === "gdeny"){
      const first = (function(){ for(let s = 0; s < seats; s++) if(s !== ME) return s; return 0; })();
      showToast(BJ.denyTxt(st, ME, BJ.grabAct(first)) || "現在不能抓人");
      return;
    }
    if(a === "g"){
      const k = betVal;
      const why = BJ.denyTxt(st, ME, BJ.grabAct(k));
      if(why){ showToast(why); return; }
      if(!apply(ME, BJ.grabAct(k))){ showToast("這個動作現在不行"); return; }
      paint();
      drive();
      return;
    }
    if(a !== "h" && a !== "s") return;
    /* ★ 說得出原因 —— 不用 disabled 讓點擊靜默消失(CLAUDE.md 的紅線)。
       ★★ 文案走 BJ.denyTxt(單機與連線同一份):它也負責莊家補牌線那兩句
          (「還不能停」/「到了就不能再補」)。 */
    const why = BJ.denyTxt(st, ME, a);
    if(why){ showToast(why); return; }
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
    paint();
    /* ★★★ v1.92.0:一局結算改成**蓋在牌桌上的過場**(使用者:「每一把結束到底誰贏多少
       誰輸多少有點不太明確,乾脆搞個中間的過場」)。
       ★ 舊版這裡有兩樣東西,兩樣都拿掉了:
           ① 一句 toast(只講我自己,而且會飄走)→ 過場的大字 + 那張表講得更清楚
           ② Sound.win() / Sound.lose()(**整首**勝敗音檔)→ 換成過場裡的短音
              settleSfx:一場有十幾局,每局放一次整首會膩到讓人想關音效。
              那兩個音檔留給**整場**結束(finishMatch 照舊)。
       ★ 面板與文案只有一份(BJB.showHand)—— 連線那邊呼叫的是同一支。 */
    const last = (k + 1 >= perRound()) && (rd + 1 >= rules.rounds);
    BJB.showHand({
      st: st, names: names(), me: ME, sc: settled,
      // 手上的籌碼:nets 上面剛加完 → 這一格就是「這一把之後我有多少錢」
      chips: (function(){ const a = []; for(let s = 0; s < seats; s++) a[s] = rules.start + (nets[s] || 0); return a; })(),
      key: "solo:" + round,
      title: "第 " + (doneRounds() + 1) + "/" + totalRounds() + " 局 · 結算",
      /* ⚠ v1.94.0:這一句從「準備下一局…」改成講**進度條在幹嘛** ——
         舊的字與旁邊那顆鈕(「下一局 ▸」)講同一件事,而它們就並排在同一列
         (看圖才發現的重複,同 v1.90.0 莊家台那個副標)。 */
      foot: last ? "時間到會自動看結果" : "時間到會自動開下一局",
      /* ★★★ v1.94.0:看完可以按(使用者:「時間太短了…我希望有可以快速關掉的操作」)。
         ★ 單機按下去就是**立刻**跑 nextRound() —— 卡多久是自己的節奏
           (同「單機不做倒數」那條)。⚠ 走的是**與到期同一支** nextRound,
           不是在這裡再寫一份「k++ / 換輪 / 結束」(那就是兩份推進真相)。
         ★★ v1.95.0 連線改成「全部人按完才跳」的投票,而**單機沒有人要等** ——
            所以這裡不傳 skipDone / skipWait(預設就是「按了馬上走」),
            鈕上也照舊寫「下一局 ▸」而不是連線那句「我看完了 ▸」:
            **鈕上的字一定要與實際發生的事一致**。 */
      skipTxt: last ? "看結果 ▸" : "下一局 ▸",
      onSkip: nextRound,
      ms: SETTLE_MS
    });

    // 下一局 / 下一輪 / 整場結束
    later(nextRound, SETTLE_MS);
  }
  /* 推進到下一局(★ **到期與「點掉過場」共用這一支**,v1.94.0)。
     ── 「提前點掉」為什麼不會偷偷多跳一局 ────────────────────────────────────
       真正在守的是**下面 `startRound()` / `finishMatch()` 自己就會 `bumpGen()`** ——
       那次還沒響的 `later(nextRound, SETTLE_MS)` 因此對不上 gen、不會執行。
     ⚠⚠ **老實記一筆:這一行 bumpGen 與 `!settled` 那一關互為多餘,兩個都沒有守門**
       (施工中各拿掉一條驗過,e2e 照樣全綠 —— 因為 startRound 那一次就夠了)。
       留著的理由只有一個:讓「這一支自己負責讓舊 timer 失效 + 只生效一次」不依賴
       呼叫順序 —— 哪天有人在 nextRound 與 startRound 之間插一段等待,
       它們就是唯一的門了。**不要因為「測試不會紅」把它們刪掉。** */
  function nextRound(){
    if(!active || over || !settled) return;
    bumpGen();
    settled = null;
    k++;
    // ⚠ 一輪的局數是**人數 × 幾局換莊**(v1.87.0)—— 寫死 seats 的話 hands=2 時
    //   每個人只當得到一次莊的一半,而「當莊次數一樣」那條公平性就沒了
    if(k >= perRound()){ k = 0; rd++; }
    if(rd >= rules.rounds){ finishMatch(); return; }
    startRound();
  }

  function finishMatch(){
    over = true; busy = false;
    bumpGen();
    BJB.hideHand();                    // ★ 過場收掉,換整場的結果卡上場(v1.92.0)
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
    recText, recLine, totalRounds, perRound,
    // ★ 座位名字表(給房規面板的「點名誰先當莊」用;單機的 token 就是座位號)
    seatNames: names,
    setLevel(v){ if(BJAI.LEVEL_INFO[v]){ level = v; saveOwn(); paintBar(); } },
    setSeats(v){ if(v >= BJ.MIN_PLAYERS && v <= BJ.MAX_PLAYERS){ seats = v; saveOwn(); } },
    // 給 e2e 用:直接讀當下的局面(不經過畫面)
    // ★ _round / _k / _rd 是「幾局換莊」的守門要用的(要看得出同一個人連做了幾局)
    _round: () => round, _k: () => k, _rd: () => rd,
    _st: () => st,
    // ★ 這一局結算中沒有(v1.92.0 的過場守門要拿它當「真相」對照畫面)
    _settled: () => settled,
    _nets: () => nets.slice(),
    _bets: () => Object.assign({}, bets),
    _dealer: dealer
  };
})();

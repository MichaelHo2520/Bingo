"use strict";

/* ============================================================================
   21 點 — 規則引擎(BJ)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/big2/rules.js、js/sevens/rules.js:
     「這一手該不該補」「這一局各家輸贏多少」只有靠 node 大量對局才驗得出來,
     碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── 玩法(每一條都與使用者逐條確認過;細節見 notes/17)────────────────────
     **輪流當莊**:每一局換一個人當莊,一輪 = 每個人當莊各一次。
     一副 52 張、**每局重洗**(所以算牌沒有意義 —— 呼應大老二拿掉算牌表那個決定)。

     一局的相位:
         下注(閒家同時) → 發牌(每人兩張,莊家第二張蓋著)
       → 閒家補牌(**同時**,各自獨立) → 莊家翻暗牌 + 補牌 → 結算

     A 算 1 或 11(軟 / 硬點數,畫面顯示雙值「7 / 17」);爆掉只看**硬**點數。
     加倍(Double)只能在**還沒補牌時**、而且**莊家不能加倍**:押注 ×2、補一張就停。
     **不做**分牌 / 保險 / 投降(理由記在 notes/17,不要再加回來)。

   ── ★★ 房規(rules)是真相的一部分,不是 UI ────────────────────────────────
     平手誰贏 / 21 點賠幾倍 / 五小龍 / 閒家先爆先輸 —— 這四條**直接決定結算數字**,
     所以 `settle()` 與 `replay()` 都吃 rules,而房規必須寫在房間節點上。
     ⚠ **開局後房規一個字都不能改**:改了會讓已經打完的局重算出不同結果
       (重連 / 補算的人算出來的籌碼會跟現場不一樣)。鎖在 adapter 的相位上。

   ── ★★ 為什麼「同時補牌」做得到:每個座位有自己的牌堆 ──────────────────────
     閒家各自獨立、可以同時動 —— 但如果大家從**同一個牌堆頂**抽牌,
     「我抽到什麼」就取決於誰的網路快,同一下點擊在不同時序會拿到不同的牌,
     而且兩個人同時補牌一定要用交易排隊(搶輸的那台等於「點了沒反應」)。

     所以這裡把 52 張切成**互不重疊的座位牌堆**:
         初始兩張   seat s 拿 deal[s] 與 deal[n + s]        (照真人發牌:一人一張、發兩圈)
         之後補牌   seat s 拿 deal[2n + k*n + s](k = 第幾張補牌)
     一副牌是 52 張互不相同的排列,切成不重疊的堆 → **不可能出現重複的牌**,
     而且「我補到什麼」與別人做了什麼完全無關 ——
     ★ 於是 `acts` 可以是「**一個座位一個字串**」,兩個人同時補牌零衝突、零交易競態。
     ⚠ 代價是牌堆有上限(見 maxDraw):真的抽完就強制停手。五小龍開著時一手最多
       5 張,根本碰不到;關掉時 n=6 也還有 6 張補牌額度(手上 8 張不爆的機率趨近 0)。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 牌的編碼與 deal 字串
     • valueOf():軟 / 硬點數      ★ 爆掉與雙值顯示**共用這一支**
     • tierOf():爆 / 普通 / 21 點 / 五小龍 這四階
     • replay():從 deal + acts 重算**一局**的真相   ★ 唯一的真相入口
     • settle():依房規算出每個座位的籌碼變化
     • autoDealer():房規有補牌線時,莊家該補到哪裡(到期代打也用它)
   不負責:AI(ai.js)、畫面(board.js)、輪莊與一場的長度(solo.js / adapter.js)。

   ── ★ replay() 只管**一局**,「輪」與「場」是呼叫端的事 ────────────────────
     排七 / 大老二的 replay 重播的是一整場;21 點不能這樣 ——
     每局重洗、而且**人數會在對局中變**(允許中途加入),n 不是常數。
     → 這一支永遠只重播一局,n 是**那一局**的常數(連同座位表寫在那一局的資料裡)。
       輪莊表、累計籌碼、剩幾局全部在 adapter 層。
     好處:「人數會變」完全不影響純函式層,該有的可測性一點都沒少。
   ========================================================================== */

const BJ = (function(){

  /* ==========================================================================
     一、編碼
     ──────────────────────────────────────────────────────────────────────────
       牌 id 0..51:suit = id/13、rank = id%13 + 1 (1=A、2..10、11=J、12=Q、13=K)
       ★ 21 點的**花色完全不參與任何判定** —— 只有點數有意義。
         所以這裡沿用排七那個「畫面順序」的花色索引(0♠ 1♥ 2♦ 3♣),
         不必像大老二那樣讓索引參與比大小。
       ★ 花色符號一律帶 U+FE0E(變體選擇子):不加的話 Android 會把 ♥ ♦ 渲染成
         彩色 emoji,字級與對齊當場失控(同大老二 / 排七)。
     ========================================================================== */
  const NSUIT = 4, NRANK = 13, NCARD = 52;
  const MIN_PLAYERS = 2, MAX_PLAYERS = 5;
  /* ⚠ 寫成明確碼位而不是貼一個看不見的字元:U+FE0E 在編輯器裡是零寬的,
     複製貼上時很容易被吃掉或換成 U+FE0F(那就變回彩色 emoji 了),
     而症狀是「手機上花色忽然變大變彩色」,在桌機完全看不出來。 */
  const VS15 = String.fromCharCode(0xFE0E);
  const SUIT_CH   = ["♠", "♥", "♦", "♣"];
  const SUIT_KEY  = ["s", "h", "d", "c"];
  const SUIT_NAME = ["黑桃", "紅心", "方塊", "梅花"];
  const RANK_TXT  = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

  const suitOf = c => Math.floor(c / NRANK);
  const rankOf = c => (c % NRANK) + 1;
  const cardOf = (s, r) => s * NRANK + (r - 1);
  const isRed  = c => suitOf(c) === 1 || suitOf(c) === 2;       // ♥ ♦
  const suitCh = s => SUIT_CH[s] + VS15;
  const rankTxt= r => RANK_TXT[r];
  const nameOf = c => suitCh(suitOf(c)) + RANK_TXT[rankOf(c)];
  const longName = c => SUIT_NAME[suitOf(c)] + RANK_TXT[rankOf(c)];

  /* deal 是 52 個字元的字串,一張牌一個字元(A~Z + a~z 剛好 52 個;與大老二同一組)。 */
  function chr(c){ return String.fromCharCode(c < 26 ? 65 + c : 97 + c - 26); }
  function unchr(ch){
    const k = ch.charCodeAt(0);
    if(k >= 65 && k <= 90) return k - 65;
    if(k >= 97 && k <= 122) return k - 97 + 26;
    return -1;
  }
  function encodeDeal(arr){ return arr.map(chr).join(""); }
  function decodeDeal(s){
    if(typeof s !== "string" || s.length !== NCARD) return null;
    const out = [], seen = {};
    for(let i = 0; i < NCARD; i++){
      const c = unchr(s[i]);
      if(c < 0 || c >= NCARD || seen[c]) return null;   // 不認得 / 重複 → 整份不收
      seen[c] = 1; out.push(c);
    }
    return out;
  }
  function shuffled(rng){
    const r = rng || Math.random;
    const a = [];
    for(let i = 0; i < NCARD; i++) a.push(i);
    for(let i = NCARD - 1; i > 0; i--){
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function newDeal(rng){ return encodeDeal(shuffled(rng)); }

  /* ==========================================================================
     二、房規
     ──────────────────────────────────────────────────────────────────────────
       ★ 每一項都由**房主開局前**決定(單機時「我就是房主」,走同一份預設值)。
       ⚠ normRules() 用**範圍 / 白名單**守門而不是信任呼叫端:
         舊房間、手改 DB 的值、還有 e2e 餵進來的半套物件都要能用,
         而一個 NaN 混進賠率會讓整局的籌碼變 NaN(而且不會報錯)。
     ========================================================================== */
  const LINE_FREE = 0;                            // 莊家補牌線:0 = 自由(真人自己決定)
  const RULES_DEF = {
    start: 100,        // 起始籌碼 ★ **純顯示參數**(見下)
    betMax: 10,        // 每局下注上限
    line: LINE_FREE,   // 莊家補牌線:0 自由 / 16 / 17
    pushDealer: true,  // 同點數(平手)莊家吃
    bjPay: 2,          // 21 點賠率(倍):1.5 或 2
    dragon: true,      // 五小龍(五張不爆),賠 2 倍,莊閒都能報
    bustFirst: true,   // 閒家先爆就先輸(莊家後來也爆照樣輸)
    rounds: 2,         // 一場幾輪(一輪 = 每個人當莊各一次)
    /* 每一段的操作倒數(秒;0 = 關掉)。★ 它**不影響結算**,放進 rules 的理由只有一個:
       這一整包在開局那一刻凍結,少一個「要不要跟著鎖」的例外就少一條會走鐘的路。
       ⚠ 一段 = 下注 / 閒家補牌 / 莊家補牌 各自一段(閒家同時動 → 那一段是**共用**一個窗口)。
       ⚠ 關掉就真的沒人催:有人離開牌桌全桌會一直等(單機不吃這個欄位)。 */
    sec: 30
  };
  /* ★★ 「起始籌碼」在這一套規則下**不影響任何判定** ——
     因為不淘汰、可以打到負分,而押注上限只夾房規那個數(不夾「我剩多少」)。
     所以排名一律看**淨變化**(籌碼 − 起始籌碼),起始值只影響顯示的數字好不好看。
     ⚠ 由此得到一條紅線:**不可以**寫出任何「籌碼不夠不能押」的邏輯 ——
       那會把「不淘汰」這條默默地破掉,而且症狀是「有人忽然不能玩了」。
     ⚠ 也因此 settle() 根本不吃 start:它只算 delta。 */
  const START_OPTS = [50, 100, 200];
  const BETMAX_OPTS = [5, 10, 20, 50];
  const LINE_OPTS = [0, 16, 17];
  const BJPAY_OPTS = [1.5, 2];
  const ROUNDS_OPTS = [1, 2, 3];
  const SEC_OPTS = [0, 20, 30, 45];

  function pick(opts, v, dflt){ return opts.indexOf(v) >= 0 ? v : dflt; }
  function normRules(r){
    r = r || {};
    return {
      sec:        pick(SEC_OPTS, +r.sec, RULES_DEF.sec),
      start:      pick(START_OPTS, +r.start, RULES_DEF.start),
      betMax:     pick(BETMAX_OPTS, +r.betMax, RULES_DEF.betMax),
      line:       pick(LINE_OPTS, +r.line, RULES_DEF.line),
      pushDealer: (typeof r.pushDealer === "boolean") ? r.pushDealer : RULES_DEF.pushDealer,
      bjPay:      pick(BJPAY_OPTS, +r.bjPay, RULES_DEF.bjPay),
      dragon:     (typeof r.dragon === "boolean") ? r.dragon : RULES_DEF.dragon,
      bustFirst:  (typeof r.bustFirst === "boolean") ? r.bustFirst : RULES_DEF.bustFirst,
      rounds:     pick(ROUNDS_OPTS, +r.rounds, RULES_DEF.rounds)
    };
  }
  const defRules = () => normRules(null);

  /* 押注的檔數(最多四顆鈕,最後一顆一定是上限)。
     ⚠ 刻意**不給自由輸入** —— 手機打字現場一定卡(notes/17 的決策 2)。 */
  const BET_LADDER = [1, 2, 5, 10, 20, 50];
  function betTiers(betMax){
    const max = pick(BETMAX_OPTS, +betMax, RULES_DEF.betMax);
    const t = BET_LADDER.filter(v => v < max);
    t.push(max);
    return t.slice(-4);
  }
  const minBet = rules => betTiers(rules.betMax)[0];
  // 押注一律夾在 [1, betMax]。★ 這裡**不夾「我剩多少」**(見 START_OPTS 那段的紅線)
  function clampBet(v, rules){
    const n = Math.round(+v || 0);
    return Math.max(1, Math.min(rules.betMax, n));
  }

  /* ==========================================================================
     三、★ 點數 —— 軟 / 硬,而且只有這一支
     ──────────────────────────────────────────────────────────────────────────
       A 可以當 1 或 11。回傳:
         hard  全部 A 都當 1(★ **爆掉只看這個**)
         soft  有 A 而且升成 11 不會爆時的點數,否則 0
         best  實際採用的點數(soft 有值就是 soft)
         bust  爆了沒
       ⚠⚠ 「畫面上的雙值顯示」與「爆掉判定」**一定要共用這一支** ——
          UI 端自己再算一次是這一頁最容易長出來的兩份真相,
          而走鐘的症狀是「畫面說 17、系統判我爆」,玩家會直接認定壞掉。
     ========================================================================== */
  function valueOf(cards){
    let sum = 0, aces = 0;
    for(let i = 0; i < cards.length; i++){
      const r = rankOf(cards[i]);
      sum += (r === 1) ? 1 : Math.min(r, 10);       // J/Q/K 都算 10
      if(r === 1) aces++;
    }
    const softable = aces > 0 && sum + 10 <= 21;
    return { hard: sum, soft: softable ? sum + 10 : 0,
             best: softable ? sum + 10 : sum, bust: sum > 21, aces: aces };
  }
  /* 顯示用的字串。★ 雙值只在「軟點數真的不一樣」時出現 ——
     A+A(hard 2 / soft 12)要顯示「2 / 12」,而 10+7 只顯示「17」。 */
  function valueTxt(cards){
    if(!cards || !cards.length) return "–";
    const v = valueOf(cards);
    if(v.bust) return String(v.hard);
    if(v.soft && v.soft !== v.hard) return v.hard + " / " + v.soft;
    return String(v.best);
  }
  const isBJ = cards => cards.length === 2 && valueOf(cards).best === 21;

  /* ==========================================================================
     四、四個階:爆 < 普通 < 21 點 < 五小龍
     ──────────────────────────────────────────────────────────────────────────
       ★ 21 點與五小龍**互斥**(一個是兩張、一個是五張)→ 不會撞。
       ★ 五小龍是房規,關掉時 5 張就只是普通手(照點數比)。
       ★ 賠率跟著**贏家自己的階**走(莊家五小龍 = 通吃全場加倍),
         而不是「誰是莊」—— 輪莊制下對稱才自洽。
     ========================================================================== */
  const T_BUST = -1, T_NORM = 0, T_BJ = 1, T_DRAGON = 2;
  const T_NAME = { "-1":"爆", "0":"普通", "1":"21點", "2":"五小龍" };
  const DRAGON_N = 5;                    // 幾張不爆才算五小龍

  function tierOf(cards, rules){
    const v = valueOf(cards);
    if(v.bust) return T_BUST;
    if(rules.dragon && cards.length >= DRAGON_N) return T_DRAGON;
    if(isBJ(cards)) return T_BJ;
    return T_NORM;
  }
  function mulOf(tier, rules){
    if(tier === T_DRAGON) return 2;
    if(tier === T_BJ) return rules.bjPay;
    return 1;
  }

  /* ==========================================================================
     五、座位牌堆(見檔頭「為什麼同時補牌做得到」)
     ========================================================================== */
  // 一個座位最多補幾張。★ 五小龍開著時一手最多 5 張,這個上限碰不到
  const maxDraw = n => Math.floor((NCARD - 2 * n) / n);
  /* 座位 s 補了 take 張之後的手牌。⚠ 一律從 cards 重算,不做增量 ——
     replay 的每一步都呼叫它,增量會讓「不合法的動作停在中間」那條路變成兩份真相。 */
  function seatCards(cards, n, s, take){
    const out = [cards[s], cards[n + s]];
    for(let k = 0; k < take; k++) out.push(cards[2 * n + k * n + s]);
    return out;
  }

  /* ==========================================================================
     六、replay —— ★ 一局唯一的真相入口
     ==========================================================================
       acts = 長度 n 的字串陣列,一個座位一格:
           "h" 要牌 · "s" 停 · "d" 加倍(押注 ×2、補一張就停)
         例:"hhs" = 補兩張再停;"d" = 加倍(自動停);"" = 還沒動

       回傳:
         n, dealer, rules, cards(解出來的整副牌)
         hands[]  每個座位的牌          take[]   補了幾張
         done[]   停手了沒(停 / 爆 / 到 21 / 五小龍 / 牌堆抽完)
         dbl[]    加倍了沒              tier[]   四個階
         phase    "play" | "dealer" | "over"
         reveal   ★ **莊家暗牌翻開了沒 —— 唯一的判斷式**
         bad      第幾個座位的 acts 不合法(-1 = 都合法)

     ── ★★ reveal 是一個欄位,不是一組近似條件 ────────────────────────────────
       莊家暗牌的翻牌時機是**規則定義的節點**(所有閒家停手 → 莊家開始補牌),
       不是 UI 動畫。所以它在真相層算好、只留**一個布林**給畫面問 ——
       比照台灣麻將 `st.over` 那條紅線:判斷式只准一個字。
       ⚠ 畫面端**絕對不可以**自己寫「所有人都 done 了吧」之類的近似條件:
         那種條件遲早與規則層錯開,而錯開的方向是**提早翻牌** = 洩漏牌情。

     ── 自動停手的四種情形(不是玩家按的)────────────────────────────────────
       ① 爆了 ② 剛好 21 點(再補一定爆,留著那顆鈕只是讓人手殘)
       ③ 五小龍(規則上限,而且已經是最強的階)④ 座位牌堆抽完(見 maxDraw)
     ========================================================================== */
  function closedAt(cards, n, rules, take){
    const v = valueOf(cards);
    return v.bust || v.best === 21 ||
           (rules.dragon && cards.length >= DRAGON_N) || take >= maxDraw(n);
  }

  function replay(deal, n, dealer, acts, rules){
    const cards = (typeof deal === "string") ? decodeDeal(deal) : deal;
    if(!cards || !(n >= MIN_PLAYERS && n <= MAX_PLAYERS)) return null;
    if(!(dealer >= 0 && dealer < n)) return null;
    const R = normRules(rules);
    const st = { n: n, dealer: dealer, rules: R, cards: cards,
                 hands: [], take: [], done: [], dbl: [], tier: [],
                 phase: "play", reveal: false, bad: -1 };

    for(let s = 0; s < n; s++){
      const a = (acts && typeof acts[s] === "string") ? acts[s] : "";
      let take = 0, stood = false, dbl = false;
      for(let i = 0; i < a.length; i++){
        const ch = a[i];
        const cur = seatCards(cards, n, s, take);
        // 已經停手之後還有動作 → 這格的 acts 壞了,停在這裡不硬套
        if(stood || closedAt(cur, n, R, take)){ st.bad = s; break; }
        if(ch === "s"){ stood = true; continue; }
        if(ch === "h"){ take++; continue; }
        if(ch === "d"){
          // ★ 加倍只能是**第一個**動作,而且莊家不能加倍(他沒有押注)
          if(i !== 0 || take !== 0 || s === dealer){ st.bad = s; break; }
          dbl = true; take++; stood = true; continue;
        }
        st.bad = s; break;                       // 不認得的字元
      }
      const hand = seatCards(cards, n, s, take);
      st.hands[s] = hand; st.take[s] = take; st.dbl[s] = dbl;
      st.done[s] = stood || closedAt(hand, n, R, take);
      st.tier[s] = tierOf(hand, R);
    }

    /* ★ 相位:閒家全部停手 → 莊家;莊家也停手 → 結束。
       ⚠ 判準是「**除了莊家以外**的座位都 done」,不是「全部 done」——
         莊家的 done 是下一段的事,混在一起會讓相位卡在 play。 */
    let allPlayers = true;
    for(let s = 0; s < n; s++) if(s !== dealer && !st.done[s]) allPlayers = false;
    st.phase = !allPlayers ? "play" : (st.done[dealer] ? "over" : "dealer");
    st.reveal = st.phase !== "play";
    return st;
  }

  /* 這個座位現在能做什麼。★ 動作列直接吃它(不要在畫面端自己判)。 */
  function legal(st, seat){
    const out = { hit: false, stand: false, dbl: false };
    if(!st || st.phase === "over") return out;
    if(!(seat >= 0 && seat < st.n)) return out;
    const isDealer = seat === st.dealer;
    // 相位守門:閒家只在 play 動、莊家只在 dealer 動
    if(isDealer ? st.phase !== "dealer" : st.phase !== "play") return out;
    if(st.done[seat]) return out;
    out.hit = true; out.stand = true;
    // 加倍:還沒補牌、不是莊家。★ 房規沒有關掉加倍的選項(它便宜又有趣)
    out.dbl = !isDealer && st.take[seat] === 0;
    return out;
  }

  /* 把一個動作接到某座位的 acts 後面(回 null = 不合法,呼叫端要中止)。
     ⚠ 一律用它而不是自己 `+= ch`:合法性只有一份(legal),
       而「本地覺得可以、伺服器上不行」是連線那邊一定會遇到的事。 */
  function push(st, seat, act, acts){
    const lg = legal(st, seat);
    if(act === "h" && !lg.hit) return null;
    if(act === "s" && !lg.stand) return null;
    if(act === "d" && !lg.dbl) return null;
    if(act !== "h" && act !== "s" && act !== "d") return null;
    return ((acts && acts[seat]) || "") + act;
  }

  /* ==========================================================================
     六之二、莊家的補牌線
     ──────────────────────────────────────────────────────────────────────────
       ★ 房規 line > 0 時莊家**沒有決策空間**(必須補到那個點數)——
         那時他的動作整段算得出來,所以連等他點都不必(一局省好幾秒)。
       ★ line = 0(自由)時這一支是**到期代打**用的:側退成補到 17
         (同台灣麻將「到期自動打牌」那一套 —— 不指定房主,誰的 timer 先響誰用交易搶)。
       ⚠ 用 best(軟點數)判斷 = 賭場的 S17(軟 17 也停),對閒家比較友善。
     ========================================================================== */
  function autoDealer(st){
    const line = st.rules.line || 17;
    const d = st.dealer, n = st.n;
    let take = st.take[d], a = "";
    let cur = st.hands[d];
    while(!closedAt(cur, n, st.rules, take)){
      if(valueOf(cur).best >= line) break;
      a += "h"; take++;
      cur = seatCards(st.cards, n, d, take);
    }
    // 已經停手了就不要再接一個 "s"(那會變成 bad)
    return closedAt(cur, n, st.rules, take) ? a : a + "s";
  }

  /* ==========================================================================
     七、★ 結算 —— 每個座位的籌碼變化
     ==========================================================================
       bets = { seat: 押注 }(莊家不押注,他一個人對全場)。
       回傳 { rows[], dealerDelta } —— rows[seat] = { seat, bet, delta, tag, tier, best, bust }

       階梯(見第四節)+ 三條房規:
         · 兩邊都爆   → bustFirst ? 閒家輸(先爆先輸) : 平手退注
         · 只有一邊爆 → 沒爆的那邊贏,倍數吃**贏家自己的階**
         · 階不同     → 高的階贏(莊家五小龍 = 通吃全場加倍)
         · 同階       → 比點數;真的一樣 → pushDealer ? 莊家吃 : 退注
       ★ 莊家的 delta = −Σ(閒家 delta) —— 零和,不必另外算一次。

       ⚠ 賠率 1.5 倍會出現 .5 → 一律**四捨五入**(押 1 贏 2、押 3 贏 5)。
         這也是預設值選 2 倍的理由:2 倍的籌碼永遠是整數,沒有這回事。
     ========================================================================== */
  function betOf(bets, seat, rules){
    const raw = bets && (bets[seat] !== undefined ? bets[seat] : bets[String(seat)]);
    return clampBet(raw === undefined ? minBet(rules) : raw, rules);
  }

  function settle(st, bets, rules){
    const R = normRules(rules || st.rules);
    const d = st.dealer;
    const dh = st.hands[d], dv = valueOf(dh), dt = tierOf(dh, R);
    const rows = [];
    let dealerDelta = 0;

    for(let s = 0; s < st.n; s++){
      if(s === d){ rows[s] = null; continue; }
      const bet = betOf(bets, s, R) * (st.dbl[s] ? 2 : 1);
      const h = st.hands[s], v = valueOf(h), t = tierOf(h, R);
      let sign = 0, mul = 1, tag = "push";

      if(t === T_BUST && dt === T_BUST){
        // ★ 閒家先爆就先輸 —— 這是莊家優勢的唯一來源(關掉整場會垮,見 notes/17)
        if(R.bustFirst){ sign = -1; tag = "bust"; }
        else tag = "bothbust";
      }else if(t === T_BUST){ sign = -1; tag = "bust"; }
      else if(dt === T_BUST){ sign = 1; mul = mulOf(t, R); tag = "dbust"; }
      else if(t > dt){ sign = 1; mul = mulOf(t, R); tag = (t === T_DRAGON ? "dragon" : (t === T_BJ ? "bj" : "win")); }
      else if(t < dt){ sign = -1; mul = mulOf(dt, R); tag = (dt === T_DRAGON ? "ddragon" : (dt === T_BJ ? "dbj" : "lose")); }
      else if(v.best > dv.best){ sign = 1; mul = mulOf(t, R); tag = (t === T_DRAGON ? "dragon" : (t === T_BJ ? "bj" : "win")); }
      else if(v.best < dv.best){ sign = -1; mul = mulOf(dt, R); tag = "lose"; }
      else if(R.pushDealer){ sign = -1; tag = "tie"; }      // 同點數莊家吃
      else tag = "push";

      const delta = sign * Math.round(bet * mul);
      dealerDelta -= delta;
      rows[s] = { seat: s, bet: bet, delta: delta, tag: tag,
                  tier: t, best: v.best, bust: v.bust };
    }
    rows[d] = { seat: d, bet: 0, delta: dealerDelta, tag: "dealer",
                tier: dt, best: dv.best, bust: dv.bust, dealer: true };
    return { rows: rows, dealer: d, dealerDelta: dealerDelta };
  }

  /* 一句話講「這一格為什麼是這個數字」。★ 結果卡與 toast 共用這一份 ——
     兩邊各寫一份文案遲早走鐘,而走鐘了兩邊各自都不會壞。 */
  const TAG_TXT = {
    bust: "爆了", bothbust: "兩邊都爆 · 退注", dbust: "莊家爆了",
    win: "點數比莊家大", lose: "點數比莊家小", tie: "同點數 · 莊家吃",
    push: "同點數 · 退注", bj: "21 點!", dbj: "莊家 21 點",
    dragon: "五小龍!", ddragon: "莊家五小龍 · 通吃", dealer: "莊家"
  };
  const tagTxt = tag => TAG_TXT[tag] || "";

  /* ==========================================================================
     八、輪莊 —— ★ 一場的長度用「輪」算,不能用「局」
     ──────────────────────────────────────────────────────────────────────────
       莊家有數學優勢(平手莊吃 + 閒家先爆先輸 + 預設還自由補牌),
       輪莊制是靠「**每個人當莊的次數一樣**」把它平衡掉的。
       → 6 人打 5 局 = 有一個人根本沒當到莊,而他吃的虧是**系統性的、不是運氣**。

       所以一輪 = 當下在場的每個人當莊各一次;一場 = rules.rounds 輪。
       ⚠ **整場的總局數不能預先算**:允許中途加入(第 1 輪 4 人 = 4 局,
         第 3 輪來了人變 6 人 = 6 局)→ 每一輪開始時才生成那一輪的莊家序列。
     ========================================================================== */
  // 這一輪還剩幾局(k = 這一輪的第幾局,0-based)
  const leftInRound = (k, n) => Math.max(0, n - k);
  // 這一局的莊家是誰(rot = 這一輪的輪莊順序)
  function dealerOf(rot, k){ return (rot && rot.length) ? rot[k % rot.length] : null; }

  return {
    // 常數
    NSUIT, NRANK, NCARD, MIN_PLAYERS, MAX_PLAYERS, VS15,
    SUIT_CH, SUIT_KEY, SUIT_NAME, RANK_TXT, DRAGON_N,
    T_BUST, T_NORM, T_BJ, T_DRAGON, T_NAME, LINE_FREE,
    RULES_DEF, START_OPTS, BETMAX_OPTS, LINE_OPTS, BJPAY_OPTS, ROUNDS_OPTS, SEC_OPTS,
    // 編碼
    suitOf, rankOf, cardOf, isRed, suitCh, rankTxt, nameOf, longName,
    chr, unchr, encodeDeal, decodeDeal, shuffled, newDeal,
    // 房規
    normRules, defRules, betTiers, minBet, clampBet,
    // 點數與階
    valueOf, valueTxt, isBJ, tierOf, mulOf,
    // 座位牌堆
    maxDraw, seatCards, closedAt,
    // 一局
    replay, legal, push, autoDealer,
    // 結算
    betOf, settle, tagTxt, TAG_TXT,
    // 輪莊
    leftInRound, dealerOf
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = BJ;

"use strict";

/* ============================================================================
   大老二 — 規則引擎(B2)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/sevens/rules.js、js/mahjong16/rules.js:
     「這一手合不合法」「這局誰第幾名」只有靠 node 大量對局才驗得出來,
     碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── 玩法(規則來源見 notes/16;每一條都與使用者逐條確認過)──────────────────
     52 張**全發**(2~4 人;除不盡就有人多拿:2 人 26/26、3 人 18/17/17、4 人 13×13)。
     **每一局都由持 ♣3 者先出,而且第一手必須包含 ♣3。**
     可出的張數只有 **1 / 2 / 5**:

         1 張  單張
         2 張  對子
         5 張  順子 · 葫蘆(三條+一對) · 鐵支(四條+任一張) · 同花順

     ★★ **同牌型才能互壓** —— 順子只壓順子、葫蘆只壓葫蘆,兩者**不能互壓**。
        這不是標準大老二的「同張數即可互壓」,所以**沒有一條跨牌型的線性強弱表**:
        比大小是 (牌型, 型內強度) 兩件事,只有下面兩個「無敵型」是特例。
     ★★ **鐵支與同花順壓得過任何牌型**(不管上家出幾張),而**同花順 > 鐵支**。

     沒有同花、沒有「兩對+單張」、**三條不可單獨出**(只能當葫蘆的一部分)。

     出完牌的人退出但**牌局繼續**,打到只剩一家還有牌為止。
     名次 = 出完的先後;名次分 5 / 3 / 1,**最後一名固定 0**。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 牌的編碼與 deal 字串、一手的編碼
     • classify():這幾張是什麼牌型、型內多強
     • beats():a 壓不壓得過 b        ★ 規則的心臟
     • replay():從 deal + moves 重算一整局的真相   ★ 唯一的真相入口
     • score():名次與名次分
     • enumPlays():這副手牌能組出哪些牌型(給 AI 與提示用)
     • playable():現在配得出哪些組合 → 手牌亮哪幾張 / 有沒有牌可出(v1.79.0)
   不負責:AI(ai.js)、畫面(board.js)、輪次驅動(solo.js / adapter.js)。

   ── ★ 為什麼一切都走 replay() ─────────────────────────────────────────────
     連線那邊 DB 只存 { deal, moves }(同排七;moves 從整數陣列升級成字串陣列,
     因為一手可能多張),每台裝置各自 replay 出完整局面。
     ⚠ 因此 **turn 絕不可以用 moves.length % n 取模** —— 出完牌的人要跳過,
       而且一輪結束時領出權要回到「最後出牌的那個人」(他若剛好出完就順延)。
       這兩條都有測試守著。
   ========================================================================== */

const B2 = (function(){

  /* ==========================================================================
     一、編碼
     ──────────────────────────────────────────────────────────────────────────
       牌 id 0..51:suit = id/13、rank = id%13 + 1 (1=A、2=2、3=3 … 13=K)
       ★ **花色索引本身就是花色強弱**:0♣ < 1♦ < 2♥ < 3♠(台灣常見)。
         排七的 rules.js 用的是相反的順序(0♠ 起),兩支刻意各自獨立 ——
         那邊的索引只是畫面順序,這邊的索引參與比大小,共用一份反而更容易錯。
       ★ 花色符號一律帶 U+FE0E(變體選擇子):不加的話 Android 會把 ♥ ♦ 渲染成
         彩色 emoji,字級與對齊當場失控。
     ========================================================================== */
  const NSUIT = 4, NRANK = 13, NCARD = 52;
  const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
  /* ⚠ 寫成明確碼位而不是貼一個看不見的字元:U+FE0E 在編輯器裡是零寬的,
     複製貼上時很容易在某一層被吃掉或換成 U+FE0F(那就變回彩色 emoji 了),
     而症狀是「手機上花色忽然變大變彩色」,在桌機完全看不出來。 */
  const VS15 = String.fromCharCode(0xFE0E);
  const SUIT_CH   = ["♣", "♦", "♥", "♠"];   // ♣ ♦ ♥ ♠(由小到大)
  const SUIT_KEY  = ["c", "d", "h", "s"];
  const SUIT_NAME = ["梅花", "方塊", "紅心", "黑桃"];
  const RANK_TXT  = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const CLUB3 = 2;                     // ♣3 = suit 0 × 13 + (3-1)

  const suitOf = c => Math.floor(c / NRANK);
  const rankOf = c => (c % NRANK) + 1;
  const cardOf = (s, r) => s * NRANK + (r - 1);
  const isRed  = c => suitOf(c) === 1 || suitOf(c) === 2;       // ♦ ♥
  const suitCh = s => SUIT_CH[s] + VS15;
  const rankTxt= r => RANK_TXT[r];
  const nameOf = c => suitCh(suitOf(c)) + RANK_TXT[rankOf(c)];
  const longName = c => SUIT_NAME[suitOf(c)] + RANK_TXT[rankOf(c)];

  /* ★ 大老二的點數序:3 最小、2 最大 → 0..12。
     A(rank 1)排在 K 之後、2(rank 2)排在最後。順子的「等級」也吃這個序。 */
  function rkOrder(r){
    if(r >= 3) return r - 3;           // 3..K → 0..10
    return r === 1 ? 11 : 12;          // A → 11、2 → 12
  }
  // rkOrder 反查 rank(只給 0..11 用;12 是 2,它不參與一般順子)
  function rkFromOrder(o){ return o <= 10 ? o + 3 : 1; }

  /* 單張的絕對強度(0..51,不重複):先比點數,同點數比花色 */
  const cardKey = c => rkOrder(rankOf(c)) * NSUIT + suitOf(c);
  const cmpCard = (a, b) => cardKey(a) - cardKey(b);

  /* ★ 「攤在桌上給人看」的排序(v1.78.0)。
     手牌與絕大多數地方都照**牌力**排(cmpCard),但**帶 2 的順子**照牌力排會變成
     `3 4 5 6 2` / `3 4 5 A 2` —— 使用者的原話:「麻煩要顯示 23456」。
     那兩種順子(A-2-3-4-5、2-3-4-5-6)在人眼裡就是從 A / 2 開始遞增的一條龍,
     所以**只有這兩種**改用點數的自然序(A=1 < 2 < 3 …)。
     ⚠ 只影響顯示;比大小一律還是 classify() 的 (t, k),一個字都沒動。
     (它用到第三節的 classify / straightOf —— 那兩支是 function 宣告,呼叫時早就就緒。) */
  function sortShow(cards){
    const cl = classify(cards);
    if(cl && (cl.t === T_STRAIGHT || cl.t === T_SFLUSH)){
      const st = straightOf(cards);
      if(st && st.lv >= 12) return cards.slice().sort((a, b) => rankOf(a) - rankOf(b));
    }
    return cards.slice().sort(cmpCard);
  }

  /* ★★ 「玩家自己排的手牌順序」(v1.80.0)。使用者的原話:
       「我們有沒有辦法可以拖曳自己的手牌順序,有時候這樣可以幫助思考」
     ord = 玩家拖出來的牌 id 順序;回傳「照 ord 排好的 hand」。

     ★★ 這一支是**顯示層的東西**,放在規則層只因為它是純函式、要在 node 裡驗
        (同 sortShow)。**ord 從來不進 DB、不影響任何判定** ——
        出的是「哪幾張牌」而不是「第幾格」,`encMove()` 自己還會再排一次。
        ⚠ 絕對不可以拿它去算牌力或判合法:classify / beats / playable
          一律吃原始的集合,順序對它們沒有意義。

     兩條容錯,都是刻意的:
       · ord 裡已經**不在手上**的牌(出掉了)自動消失 → 剩下的相對順序原封不動
         (這正是「出掉的牌右邊的往前補、左邊的一格都不動」在自訂順序下的版本)
       · hand 裡 ord **沒提到**的牌一律照 cmpCard 補在**後面**,不會靜靜地不見 ——
         正常流程到不了(換局會把 ord 丟掉,而手牌只會變少),
         但「一張牌從畫面上消失」是這一頁最不能發生的事,寧可排在奇怪的位置。 */
  function applyOrder(hand, ord){
    if(!Array.isArray(ord) || !ord.length) return hand.slice().sort(cmpCard);
    const at = {};
    ord.forEach((c, i) => { if(at[c] === undefined) at[c] = i; });   // 重複的以第一次為準
    const known = [], rest = [];
    hand.forEach(c => { (at[c] === undefined ? rest : known).push(c); });
    known.sort((a, b) => at[a] - at[b]);
    return known.concat(rest.sort(cmpCard));
  }

  /* deal 是 52 個字元的字串,一張牌一個字元(A~Z + a~z 剛好 52 個)。 */
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

  /* ---------- 一手的編碼 ----------
     pass = "-";出牌 = 1/2/5 個字元(升冪),與 deal 用同一組字元表。
     ⚠ 排七是「一手一個整數」,大老二一手可能 5 張,所以升級成字串。
       核心只用到 moves.length 當 step 守衛,所以 rev / 交易 / 斷線重建完全不受影響。 */
  const PASS = "-";
  function encMove(cards){
    if(!cards || !cards.length) return PASS;
    return cards.slice().sort((a, b) => a - b).map(chr).join("");
  }
  function isPass(mv){ return mv === PASS; }
  function decMove(mv){
    if(typeof mv !== "string") return null;
    if(mv === PASS) return [];
    if(mv.length !== 1 && mv.length !== 2 && mv.length !== 5) return null;
    const out = [], seen = {};
    for(let i = 0; i < mv.length; i++){
      const c = unchr(mv[i]);
      if(c < 0 || c >= NCARD || seen[c]) return null;
      seen[c] = 1; out.push(c);
    }
    return out.sort((a, b) => a - b);
  }

  /* ==========================================================================
     二、發牌
     ──────────────────────────────────────────────────────────────────────────
       ★ 52 張**全發**(使用者的決定:「會有人多也沒關係」)。
         全發帶來一個實作上的好處:**♣3 一定在某人手上**,所以「持 ♣3 者先出」
         不需要任何後備路徑。
     ========================================================================== */
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

  /* 座位 s 的手牌 = deal 中 index % n === s 的那些 → 除不盡時前面的座位自然多 1 張。
     手牌一律照**大老二的強弱**排序(畫面與 AI 都靠它,不是照 id)。 */
  function handsOf(cards, n){
    const hands = [];
    for(let s = 0; s < n; s++) hands.push([]);
    for(let i = 0; i < cards.length; i++) hands[i % n].push(cards[i]);
    hands.forEach(h => h.sort(cmpCard));
    return hands;
  }
  // 各座位會拿到幾張(大廳要先講清楚誰多一張)
  function dealCounts(n){
    const out = [];
    for(let s = 0; s < n; s++) out.push(Math.floor(NCARD / n) + (s < NCARD % n ? 1 : 0));
    return out;
  }

  /* ==========================================================================
     三、牌型
     ==========================================================================
       T_* 只是「哪一種牌型」的標籤,**不是強弱順序** —— 順子與葫蘆不能互壓,
       所以它們之間沒有大小可言。真正的強弱全部由 beats() 決定。 */
  const T_SINGLE = 1, T_PAIR = 2, T_STRAIGHT = 3, T_FULL = 4, T_QUADS = 5, T_SFLUSH = 6;
  const T_NAME = { 1:"單張", 2:"對子", 3:"順子", 4:"葫蘆", 5:"鐵支", 6:"同花順" };

  const isBomb = t => t === T_QUADS || t === T_SFLUSH;
  const bombLv = t => (t === T_SFLUSH ? 1 : 0);      // ★ 同花順 > 鐵支

  /* ---------- 順子的等級 ----------
     由大到小:A-2-3-4-5(13) > 2-3-4-5-6(12) > 10-J-Q-K-A(11) > … > 3-4-5-6-7(4)
     ⚠ 一律**不繞圈**(Q-K-A-2-3 不算);2 只透過上面那兩種特例進順子,
       所以一般順子裡出現 rank 2 一律不承認(否則會冒出 J-Q-K-A-2)。
     回傳 { lv, rep } —— rep = 依大老二點序最大的那張(同等級時比它的花色)。
     ★ 兩個特例的 rep 都是那張 2,所以**等級必須是主鍵**,花色只能當 tie-break。 */
  function straightOf(cards){
    if(cards.length !== 5) return null;
    const rs = cards.map(rankOf).slice().sort((a, b) => a - b);
    for(let i = 1; i < 5; i++) if(rs[i] === rs[i - 1]) return null;   // 有對子 → 不是順子
    const has = r => rs.indexOf(r) >= 0;
    const cardWithRank = r => { for(let i = 0; i < 5; i++) if(rankOf(cards[i]) === r) return cards[i]; return -1; };

    if(has(1) && has(2) && has(3) && has(4) && has(5)) return { lv: 13, rep: cardWithRank(2) };
    if(has(2) && has(3) && has(4) && has(5) && has(6)) return { lv: 12, rep: cardWithRank(2) };
    if(has(2)) return null;                                          // 其餘帶 2 的一律不算

    const os = cards.map(c => rkOrder(rankOf(c))).sort((a, b) => a - b);
    for(let i = 1; i < 5; i++) if(os[i] !== os[i - 1] + 1) return null;
    const top = os[4];
    return { lv: top, rep: cardWithRank(rkFromOrder(top)) };
  }

  /* ---------- 這幾張是什麼牌型 ----------
     回傳 { t, k, n } 或 null(不是合法牌型)。k 只在**同一個 t** 之間比得有意義。 */
  function classify(cards){
    if(!Array.isArray(cards)) return null;
    const seen = {};
    for(let i = 0; i < cards.length; i++){
      const c = cards[i];
      if(!(c >= 0 && c < NCARD) || seen[c]) return null;
      seen[c] = 1;
    }
    const len = cards.length;

    if(len === 1) return { t: T_SINGLE, k: cardKey(cards[0]), n: 1 };

    if(len === 2){
      if(rankOf(cards[0]) !== rankOf(cards[1])) return null;
      const r = rankOf(cards[0]), hi = Math.max(suitOf(cards[0]), suitOf(cards[1]));
      return { t: T_PAIR, k: rkOrder(r) * NSUIT + hi, n: 2 };
    }

    if(len !== 5) return null;                       // ★ 3 張(三條)與 4 張一律不可出

    // 依點數分組
    const by = {};
    cards.forEach(c => { const r = rankOf(c); (by[r] = by[r] || []).push(c); });
    const groups = Object.keys(by).map(r => ({ r: +r, cs: by[r] })).sort((a, b) => b.cs.length - a.cs.length);

    if(groups[0].cs.length === 4) return { t: T_QUADS, k: rkOrder(groups[0].r), n: 5 };
    if(groups[0].cs.length === 3 && groups.length === 2 && groups[1].cs.length === 2)
      return { t: T_FULL, k: rkOrder(groups[0].r), n: 5 };
    if(groups[0].cs.length >= 2) return null;        // 三條+雜牌 / 兩對+單張 → 都不是牌型

    const st = straightOf(cards);
    if(!st) return null;                             // 五張雜牌;同花(非順)也走到這裡 → 不承認
    const oneSuit = cards.every(c => suitOf(c) === suitOf(cards[0]));
    return { t: oneSuit ? T_SFLUSH : T_STRAIGHT, k: st.lv * NSUIT + suitOf(st.rep), n: 5 };
  }

  /* ---------- ★ 規則的心臟:a 壓不壓得過 b ----------
       b = null 代表「這是領出」,任何合法牌型都行。

     ⚠⚠ `bombLv()` 那一層**看起來是多餘的**:目前鐵支的 k 是 0~12(只有四條的點數)、
        同花順的 k 是 16~55(等級×4+花色),兩段剛好不重疊,所以就算只比 k 也會答對。
        **不要因此把它拿掉** —— 那會讓「同花順 > 鐵支」變成一個靠編碼巧合成立的結論,
        哪天有人給鐵支補上花色 tie-break(k 變成 0~51)就會 overlap,
        症狀是鐵支忽然壓得過同花順,而追下去看不出是哪一行造成的。
        `tools/test-big2-rules.js` D 節用「k 大得離譜的合成鐵支」把這一層釘住。 */
  function beats(a, b){
    if(!a) return false;
    if(!b) return true;
    if(isBomb(a.t)){
      if(!isBomb(b.t)) return true;                                   // 無敵型壓任何普通型
      if(bombLv(a.t) !== bombLv(b.t)) return bombLv(a.t) > bombLv(b.t);// 同花順 > 鐵支
      return a.k > b.k;
    }
    if(isBomb(b.t)) return false;                                     // 普通型壓不過無敵型
    if(a.t !== b.t) return false;                                     // ★ 同牌型才能互壓
    return a.k > b.k;
  }

  /* ==========================================================================
     四、replay —— ★ 一整局唯一的真相入口
     ==========================================================================
       回傳:
         n, hands[], turn(-1 = 結束), cur(這一輪目前最大的那手 / null = 領出),
         passes(自 cur 之後連續幾個 pass)、played[](已公開出過的牌)、
         finished[](出完的先後,存座位)、opened(第一手出過了沒)、over、last、bad
         trick[](這一輪的完整動作記錄,見下)

     ── ★ trick:為什麼真相層要記「這一輪發生過什麼」(v1.77.0)─────────────────
       `cur` 只留得住**這一輪目前最大的那一手**,前面被壓掉的、以及每一個「不要」
       全部就地消失。使用者的原話:「中間那一塊應該要用來顯示這一輪大家出的牌,
       才不會因為跳太快,導致你根本不知道出過什麼牌了」——
       三家電腦連續出牌只花幾百毫秒,只留最大那手的話,人根本來不及看。

       · trick[] = 這一輪從領出到現在的每一手 { seat, cards[], pass }(含 pass)

       ★★ **一輪結束就整份清掉**(v1.78.0 改)。v1.77.0 曾經把它搬進 `prevTrick`
          留給畫面顯示「上一輪」,使用者看過之後要求拿掉:
            「如果變自由牌了,就全部都清掉」
          —— 新的一輪是乾淨的桌面,上一輪的牌留在畫面上只是雜訊。
       ⚠ 放在規則層而不是畫面層:單機與連線都要用,而連線是 replay(deal, n, moves)
         重算出來的 —— 畫面自己記的話,一斷線重連就整段消失。
       ⚠ **不含任何隱藏資訊**:出過的牌本來就是公開的,pass 也是公開動作。 */
  function startSeat(hands){
    for(let s = 0; s < hands.length; s++) if(hands[s].indexOf(CLUB3) >= 0) return s;
    return 0;      // 到不了(52 張全發,♣3 一定在某人手上)
  }
  const activeCount = st => st.hands.reduce((a, h) => a + (h.length ? 1 : 0), 0);
  function nextActive(st, from){
    for(let k = 1; k <= st.n; k++){
      const s = (from + k) % st.n;
      if(st.hands[s].length) return s;
    }
    return -1;
  }

  function blank(cards, n){
    const hands = handsOf(cards, n);
    return {
      n: n, hands: hands, turn: startSeat(hands),
      cur: null, passes: 0, played: [], finished: [],
      trick: [],
      opened: false, over: false, last: null, bad: -1
    };
  }

  /* 一輪結束了沒。★ 判準不是「n-1 個 pass」,而是「**還有牌的人**除了 cur 的主人
     以外都 pass 過了」—— 已經出完的人不必也不能表態,而 cur 的主人可能剛好出完
     (那時要連他那一份也算進去,不然這一輪永遠結不了)。 */
  function trickDone(st){
    if(!st.cur) return false;
    const act = activeCount(st);
    const holderActive = st.hands[st.cur.seat].length > 0;
    const need = holderActive ? act - 1 : act;
    return need <= 0 || st.passes >= need;
  }

  /* 套用一手。回 true = 成功;false = 不合法(呼叫端要中止,不可以硬套下去)。 */
  function step(st, mv){
    if(st.over || st.turn < 0) return false;
    const seat = st.turn;

    if(isPass(mv)){
      if(!st.cur) return false;                       // ★ 領出的人不能 pass
      st.passes++;
      st.last = { seat: seat, cards: [], pass: true };
      st.trick.push({ seat: seat, cards: [], pass: true });
    }else{
      const cards = decMove(mv);
      if(!cards || !cards.length) return false;
      const hand = st.hands[seat];
      for(let i = 0; i < cards.length; i++) if(hand.indexOf(cards[i]) < 0) return false;
      const cls = classify(cards);
      if(!cls) return false;
      // ★ 第一手必須包含 ♣3
      if(!st.opened && cards.indexOf(CLUB3) < 0) return false;
      if(!beats(cls, st.cur ? st.cur.cls : null)) return false;

      cards.forEach(c => { const at = hand.indexOf(c); if(at >= 0) hand.splice(at, 1); });
      st.cur = { seat: seat, cards: cards.slice(), cls: cls };
      st.passes = 0;
      st.opened = true;
      cards.forEach(c => st.played.push(c));
      st.last = { seat: seat, cards: cards.slice(), pass: false };
      st.trick.push({ seat: seat, cards: cards.slice(), pass: false, t: cls.t });
      if(!hand.length && st.finished.indexOf(seat) < 0) st.finished.push(seat);
    }

    // 只剩一家還有牌 → 這局結束(使用者選的「打到只剩一人」)
    if(activeCount(st) <= 1){ st.over = true; st.turn = -1; return true; }

    if(trickDone(st)){
      const from = st.cur.seat;
      st.cur = null; st.passes = 0;
      /* ★★ 一輪結束 → 這一輪的記錄**整份清掉**(使用者:「如果變自由牌了,就全部都清掉」)。
         v1.77.0 曾經留一份 prevTrick 給畫面顯示「上一輪」,實際玩過之後拿掉了 ——
         新的一輪是乾淨的桌面。 */
      st.trick = [];
      // ★ 領出權回到最後出牌的人;他若剛好出完就順延給下一個還有牌的人
      st.turn = st.hands[from].length ? from : nextActive(st, from);
    }else{
      st.turn = nextActive(st, seat);
    }
    return true;
  }

  function replay(deal, n, moves){
    const cards = (typeof deal === "string") ? decodeDeal(deal) : deal;
    if(!cards || !(n >= MIN_PLAYERS && n <= MAX_PLAYERS)) return null;
    const st = blank(cards, n);
    const mv = Array.isArray(moves) ? moves : [];
    for(let i = 0; i < mv.length; i++){
      if(!step(st, mv[i])){ st.bad = i; break; }      // 不合法就停在這裡,不硬套
    }
    return st;
  }

  /* ==========================================================================
     五、結算:名次與名次分
     ──────────────────────────────────────────────────────────────────────────
       名次 = 出完的先後;還有牌的那家是最後一名。
       名次分:前面依序 5 / 3 / 1,**最後一名固定 0** ——
       2 人 → 5/0、3 人 → 5/3/0、4 人 → 5/3/1/0。
     ========================================================================== */
  const RANK_PTS = [5, 3, 1, 0];
  function ptsForRank(rank, n){ return rank === n ? 0 : (RANK_PTS[rank - 1] || 0); }

  function score(st){
    const rows = [];
    for(let s = 0; s < st.n; s++){
      const f = st.finished.indexOf(s);
      rows.push({ seat: s, left: st.hands[s].length, fin: f < 0 ? st.n : f, rank: 0, pts: 0 });
    }
    // 出完得早的在前;都還沒出完(局中預覽)就比剩幾張,再比座位(保證決定性)
    const sorted = rows.slice().sort((a, b) => (a.fin - b.fin) || (a.left - b.left) || (a.seat - b.seat));
    sorted.forEach((r, i) => { r.rank = i + 1; r.pts = ptsForRank(r.rank, st.n); });
    return { rows: rows, sorted: sorted, winners: sorted.filter(r => r.rank === 1).map(r => r.seat) };
  }

  /* ==========================================================================
     六、能出哪些牌(給 AI 與畫面提示用)
     ──────────────────────────────────────────────────────────────────────────
       ★ 契約:enumPlays() 是**候選清單**,不保證窮舉五張牌型的每一種花色組合
         (26 張手牌的順子組合會爆開)。這對正確性沒有風險 —— 大老二**跟牌時
         永遠可以 pass**,而領出時任何一張單張都是合法手,所以「漏掉某個組合」
         最多只是少一個選項,不會讓 AI 卡住。
       ⚠ 也因此**不可以**拿它來判「這一手合不合法」—— 那是 classify() + beats() 的事。
     ========================================================================== */
  const STRAIGHT_CAP = 16;               // 每個點數窗最多列幾種花色組合(AI 用)
  /* 4^5 = 一個點數窗理論上的花色組合上限 → 帶這個 cap 就等於**窮舉**。
     只有 playable() 用它(見第六之二節):那一支要回答「有沒有任何一手」,
     漏一種花色組合就會答錯,而 AI 那邊漏一個候選只是少一個選項。 */
  const FULL_CAP = 1024;

  // 10 個合法的順子點數窗(由小到大;等級見 straightOf)
  function straightWindows(){
    const out = [];
    for(let top = 4; top <= 11; top++){
      const rs = [];
      for(let o = top - 4; o <= top; o++) rs.push(rkFromOrder(o));
      out.push(rs);
    }
    out.push([2, 3, 4, 5, 6]);
    out.push([1, 2, 3, 4, 5]);
    return out;
  }
  const WINDOWS = straightWindows();

  function combos(arr, k){
    const out = [];
    (function rec(start, cur){
      if(cur.length === k){ out.push(cur.slice()); return; }
      for(let i = start; i < arr.length; i++){ cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    })(0, []);
    return out;
  }

  function enumPlays(hand, cap){
    const lim = cap > 0 ? cap : STRAIGHT_CAP;
    const out = [];
    const push = cs => { const cl = classify(cs); if(cl) out.push({ cards: cs.slice().sort(cmpCard), cls: cl }); };
    const by = {};
    hand.forEach(c => { const r = rankOf(c); (by[r] = by[r] || []).push(c); });
    const ranks = Object.keys(by).map(r => +r);

    // 單張 / 對子:全列(最多 52 + 78,便宜)
    hand.forEach(c => push([c]));
    ranks.forEach(r => { if(by[r].length >= 2) combos(by[r], 2).forEach(push); });

    // 葫蘆:三條 × 另一個點數的對子
    ranks.forEach(r3 => {
      if(by[r3].length < 3) return;
      const tri = combos(by[r3], 3);
      ranks.forEach(r2 => {
        if(r2 === r3 || by[r2].length < 2) return;
        const pr = combos(by[r2], 2);
        tri.forEach(t => pr.forEach(p => push(t.concat(p))));
      });
    });

    // 鐵支:四條 + 任一張
    ranks.forEach(r4 => {
      if(by[r4].length !== 4) return;
      hand.forEach(c => { if(rankOf(c) !== r4) push(by[r4].concat([c])); });
    });

    // 順子 / 同花順:逐個點數窗做笛卡兒積(有上限,見 STRAIGHT_CAP)
    WINDOWS.forEach(win => {
      const cols = win.map(r => by[r] || []);
      if(cols.some(col => !col.length)) return;
      let acc = [[]];
      for(let i = 0; i < cols.length; i++){
        const next = [];
        for(let a = 0; a < acc.length && next.length < lim; a++)
          for(let b = 0; b < cols[i].length && next.length < lim; b++)
            next.push(acc[a].concat([cols[i][b]]));
        acc = next;
      }
      acc.forEach(push);
    });

    // 同一組牌可能被列兩次(例如同花順同時落在順子那一輪)→ 去重
    const seen = {}, uniq = [];
    out.forEach(p => {
      const key = p.cards.join(",");
      if(seen[key]) return;
      seen[key] = 1; uniq.push(p);
    });
    return uniq;
  }

  /* 能壓過 cur 的候選手,由「最便宜」排到「最貴」。
     ⚠ 排序鍵不可以只用 cls.k —— k 只在同一個牌型內部可比,而這份清單在**領出**時
       (cur = null)會同時含單張 / 對子 / 五張。排序是 (是不是無敵型, 牌型, 型內強度):
       無敵型一律排最後,因為「能壓但要拆掉鐵支」幾乎永遠不是最便宜的選擇。 */
  function playsBeating(hand, cur){
    return enumPlays(hand).filter(p => beats(p.cls, cur)).sort((a, b) =>
      (isBomb(a.cls.t) ? 1 : 0) - (isBomb(b.cls.t) ? 1 : 0) ||
      (isBomb(a.cls.t) ? bombLv(a.cls.t) - bombLv(b.cls.t) : a.cls.t - b.cls.t) ||
      a.cls.k - b.cls.k
    );
  }

  /* ==========================================================================
     六之二、★★ 「我現在配得出哪些組合」(v1.79.0)
     ──────────────────────────────────────────────────────────────────────────
       使用者的要求有兩句:
         「如果我沒辦法出牌的時候,請直接剩下 pass 按鈕」
         「如果我能出牌,請幫我把可以出的牌亮起來」

       ★★ 這一支**推翻了**舊版那條「大老二不做單張壓暗」的判斷,但推翻的方式很重要:
          舊版的理由是「單看一張牌無法回答它能不能出」—— 那句話是對的,
          所以這裡回答的**不是**那個問題,而是:
              「**存在**一種合法出法用得到這張牌嗎?」
          這個問題單張回答得出來、而且不騙人。♣5 單張壓不過 ♦7,但只要
          ♣5+♦5 壓得過,♣5 就該亮 —— 舊版把這張壓暗才是騙人的那一邊。

       ★ sel(已經選好的那幾張)會**收窄**這份清單:回傳的 cards 只留「還在某個
         合法出法裡、而且那個出法包含目前選的每一張」的牌。
         所以點了一張 5 之後,亮著的就是「還配得上去的牌」,不是全部重來一遍。
         ⚠ 選了一組配不出合法牌型的牌時 cards 會是空的 —— 那正是要傳達的事
           (「這樣選下去沒有出路」),不是 bug。

       回傳 { can, n, fit, cards, need }:
         can   有沒有任何一手可以出(**不看 sel**)→ 假時動作列只留 Pass
         n     合法出法共幾種 · fit 其中符合目前 sel 的有幾種
         cards 要亮起來的牌(已含 sel 自己)
         need  還要再選幾張才湊得成一手(可能有兩個答案:例如「再 1 張湊對子 /
               再 4 張湊五張牌型」)。★ v1.79.1 起沒亮的牌**點不起來**,
               所以 sel 永遠是某一手的子集 —— 那時該講的是「還要再選幾張」,
               而不是 whyNot 的「兩張要同點數才是對子」(玩家在湊順子時那句是錯的)。

       ⚠ 這一支吃 FULL_CAP 而不是 STRAIGHT_CAP:`can === false` 會把「出牌」那顆鈕
         整顆收掉,一旦誤判成「不能出」玩家就再也出不了那一手 ——
         那比 AI 少一個候選嚴重得多,所以順子一律窮舉。
       ⚠ 純函式:吃 hand / st 的兩個欄位(cur、opened),不碰 DOM。
     ========================================================================== */
  function playable(hand, st, sel){
    const cur = (st && st.cur) ? st.cur.cls : null;
    const opened = !st || st.opened !== false;
    const need = Array.isArray(sel) ? sel : [];
    const legal = enumPlays(hand, FULL_CAP).filter(p => {
      if(!opened && p.cards.indexOf(CLUB3) < 0) return false;   // 第一手一定要帶 ♣3
      return beats(p.cls, cur);
    });
    const hot = {}, more = {};
    let fit = 0;
    legal.forEach(p => {
      for(let i = 0; i < need.length; i++) if(p.cards.indexOf(need[i]) < 0) return;
      fit++;
      p.cards.forEach(c => { hot[c] = 1; });
      if(p.cards.length > need.length) more[p.cards.length - need.length] = 1;
    });
    return { can: legal.length > 0, n: legal.length, fit: fit,
             cards: Object.keys(hot).map(Number),
             need: Object.keys(more).map(Number).sort((a, b) => a - b) };
  }

  /* ★★ 「這張牌現在點不點得起來」(v1.79.1)。使用者的原話:
       「如果沒亮起來的牌,我去點它還是能選起來,這樣是很奇怪的事情,
         麻煩沒亮的就不應該讓人選」
     回 "" = 點得起來;回一句話 = 不給選,而且**那句話一定要說出去**
     (CLAUDE.md 的紅線是「不用 disabled 讓牌**靜默**吃掉點擊」——
      不給選可以,靜默不行。呼叫端負責 showToast)。
     ★ 已經選起來的一律點得掉:使用者上一輪才要求「站起來的牌再按一下就跑回去」,
       而選取收窄之後那張牌自己也可能不在清單裡(它是清單的**條件**)。
     ★ 這一層擋掉之後 sel 永遠是某一手合法出法的子集(每一次點擊都驗過),
       所以「選了一組永遠湊不出牌型的牌」在畫面上變成**到不了的狀態**。 */
  function whyNotPick(hand, st, sel, card){
    const cur = (sel || []);
    if(cur.indexOf(card) >= 0) return "";
    if(hand.indexOf(card) < 0) return "";              // 不是我的手牌 → 不管它
    const po = playable(hand, st, cur);
    if(po.cards.indexOf(card) >= 0) return "";
    if(!po.can) return "你手上沒有一手壓得過現在桌上這一手 —— 只能不要(Pass)";
    if(cur.length) return "這張配不上你已經選的那幾張(要換一組請先按「清除」)";
    return "這張湊不出壓得過現在桌上這一手的牌型";
  }

  /* ==========================================================================
     七、「為什麼這一手不行」
     ──────────────────────────────────────────────────────────────────────────
       ★ 不可出的牌壓暗但**仍然點得動**(CLAUDE.md 的紅線:不用 disabled 讓牌
         靜默吃掉點擊),那麼按下去就必須回答得出原因,否則跟壞掉沒兩樣。
       ⚠ 放在規則層是因為單機與連線都要用 —— 兩邊各寫一份遲早會走鐘,
         而且走鐘了兩邊各自都不會壞、沒有東西抓得到(排七同一條)。
     ========================================================================== */
  function whyNot(cards, st){
    const n = cards.length;
    if(!n) return "先點要出的牌";
    if(n !== 1 && n !== 2 && n !== 5)
      return "只能出 1 張、2 張或 5 張(選了 " + n + " 張)" + (n === 3 ? " —— 三條不能單獨出" : "");
    const cls = classify(cards);
    if(!cls){
      if(n === 2) return "兩張要同點數才是對子";
      return "這 5 張不是牌型 —— 只有順子、葫蘆、鐵支、同花順(沒有同花、沒有兩對)";
    }
    if(!st.opened && cards.indexOf(CLUB3) < 0) return "第一手一定要帶 " + nameOf(CLUB3);
    const cur = st.cur ? st.cur.cls : null;
    if(!cur) return "";                                   // 領出:合法牌型就行
    if(beats(cls, cur)) return "";
    if(isBomb(cur.t) && !isBomb(cls.t))
      return "上一手是" + T_NAME[cur.t] + ",只有" + (cur.t === T_QUADS ? "更大的鐵支或同花順" : "更大的同花順") + "壓得過";
    if(cls.t !== cur.t && !isBomb(cls.t))
      return T_NAME[cls.t] + "壓不過" + T_NAME[cur.t] + " —— 同牌型才能互壓(鐵支與同花順例外)";
    return "同樣是" + T_NAME[cls.t] + ",但你這手比較小";
  }

  return {
    // 常數
    NSUIT, NRANK, NCARD, CLUB3, SUIT_CH, SUIT_KEY, SUIT_NAME, RANK_TXT, VS15,
    MIN_PLAYERS, MAX_PLAYERS, PASS, RANK_PTS,
    T_SINGLE, T_PAIR, T_STRAIGHT, T_FULL, T_QUADS, T_SFLUSH, T_NAME,
    // 編碼
    suitOf, rankOf, cardOf, isRed, suitCh, rankTxt, nameOf, longName,
    rkOrder, rkFromOrder, cardKey, cmpCard, sortShow, applyOrder,
    chr, unchr, encodeDeal, decodeDeal, encMove, decMove, isPass,
    // 發牌
    shuffled, newDeal, handsOf, dealCounts,
    // 牌型
    isBomb, bombLv, straightOf, classify, beats,
    // 一局
    blank, step, replay, startSeat, nextActive, activeCount, trickDone,
    // 結算
    RANK_PTS_FOR: ptsForRank, score,
    // 候選手 / 提示
    WINDOWS, enumPlays, playsBeating, playable, whyNotPick, whyNot
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = B2;

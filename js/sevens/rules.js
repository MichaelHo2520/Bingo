"use strict";

/* ============================================================================
   排七(接龍)— 規則引擎(SV)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/gomoku/ai.js、js/mahjong/gen.js、js/mahjong16/rules.js:
     「這一手合不合法」「這局誰贏」只有靠 node 大量對局才驗得出來,
     碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── 玩法(規則來源見 notes/15)────────────────────────────────────────────
     52 張全發(2~6 人;不整除時前面的座位多 1 張)。
     持 ♠7 者先手,而且**第一手只能出 ♠7**。
     之後輪流:出「同花色且點數相鄰」的牌接龍(往上 8…K / 往下 6…A),
     或開一條新花色的 7。**有牌可出就必須出**,無牌可出才蓋掉一張。
     蓋掉的牌離開這一局(那條龍就可能永遠接不下去 —— 這正是排七的策略核心),
     而且**保密到結算**(顯示端的事,見 board.js)。
     所有人手牌清空後結算:蓋牌點數總和(A=1…K=13)最少者勝,
     同分比蓋牌張數,再同比誰先把手牌清空。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 牌的編碼與 deal 字串
     • legal():現在這手能出哪幾張
     • replay():從 deal + moves 重算一整局的真相  ★ 唯一的真相入口
     • score():結算與三層 tie-break
   不負責:AI(ai.js)、畫面(board.js)、輪次驅動(solo.js / adapter.js)。

   ── ★ 為什麼一切都走 replay() ─────────────────────────────────────────────
     連線那邊 DB 只存 { deal, moves }(與五子棋的 moves 同構,核心的 rev / 交易
     機制原封不動就能用),每台裝置各自 replay 出完整局面。
     ⚠ 因此 **turn 絕不可以用 `moves.length % n` 取模** —— 手牌清空的人要跳過,
       取模算出來的會在有人出完之後整桌錯位。這條有測試守著。
   ========================================================================== */

const SV = (function(){

  /* ==========================================================================
     一、編碼
     ──────────────────────────────────────────────────────────────────────────
       牌 id 0..51:suit = id/13 (0♠ 1♥ 2♦ 3♣)、rank = id%13 + 1 (1=A … 13=K)
       ★ 花色符號一律帶 U+FE0E(變體選擇子):不加的話 Android 會把 ♥ ♦ 渲染成
         彩色 emoji,字級與對齊當場失控。這是「顯示用的字串」而不是畫面操作,
         放在這裡讓 board / 結果卡 / toast 共用同一份。
     ========================================================================== */
  const NSUIT = 4, NRANK = 13, NCARD = 52;
  const VS15 = "︎";                                   // U+FE0E 強制文字呈現
  const SUIT_CH  = ["♠","♥","♦","♣"];  // ♠ ♥ ♦ ♣
  const SUIT_KEY = ["s","h","d","c"];
  const SUIT_NAME= ["黑桃","紅心","方塊","梅花"];
  const RANK_TXT = ["","A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const SPADE7 = 6;          // ♠7 = suit 0 × 13 + (7-1)

  const suitOf = c => Math.floor(c / NRANK);
  const rankOf = c => (c % NRANK) + 1;
  const cardOf = (s, r) => s * NRANK + (r - 1);
  const isRed  = c => suitOf(c) === 1 || suitOf(c) === 2;
  const suitCh = s => SUIT_CH[s] + VS15;
  const rankTxt= r => RANK_TXT[r];
  const nameOf = c => suitCh(suitOf(c)) + RANK_TXT[rankOf(c)];
  const longName = c => SUIT_NAME[suitOf(c)] + RANK_TXT[rankOf(c)];

  /* deal 是 52 個字元的字串,一張牌一個字元(A~Z + a~z 剛好 52 個)。
     比 "00".."51" 的兩字元版短一半,而且長度本身就是張數的守衛。 */
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

  /* 一手的編碼:card*2 + (pass?1:0),0..103。與五子棋的 moves 同構(一手一個整數)。 */
  const encMove = (card, pass) => card * 2 + (pass ? 1 : 0);
  const moveCard = mv => mv >> 1;
  const movePass = mv => (mv & 1) === 1;

  /* ==========================================================================
     二、發牌
     ──────────────────────────────────────────────────────────────────────────
       ★ 52 張**一張都不能拿掉**:少一張那條龍就從那裡永遠斷掉,後面的牌全部出不來。
         所以人數不整除時是「發牌不均」(前面的座位多 1 張),不是「抽掉幾張湊整除」。
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

  /* 座位 s 的手牌 = deal 中 index % n === s 的那些 → 不整除時前面的座位自然多 1 張 */
  function handsOf(cards, n){
    const hands = [];
    for(let s = 0; s < n; s++) hands.push([]);
    for(let i = 0; i < cards.length; i++) hands[i % n].push(cards[i]);
    hands.forEach(h => h.sort((a, b) => a - b));
    return hands;
  }
  // 各座位會拿到幾張(大廳要先講清楚「誰多一張」)
  function dealCounts(n){
    const out = [];
    for(let s = 0; s < n; s++) out.push(Math.floor(NCARD / n) + (s < NCARD % n ? 1 : 0));
    return out;
  }

  /* ==========================================================================
     三、合法手
     ========================================================================== */
  function emptyTracks(){ return [null, null, null, null]; }
  function tracksOpen(tracks){ return tracks.some(t => !!t); }

  // 這張牌現在出得掉嗎(不含「第一手只能 ♠7」那條,那是 legal 的事)
  function playable(card, tracks){
    const t = tracks[suitOf(card)], r = rankOf(card);
    if(!t) return r === 7;                       // 這條龍還沒開 → 只有 7 開得了
    return r === t.lo - 1 || r === t.hi + 1;
  }
  /* 現在這手能出哪幾張(升冪)。空陣列 = 必須蓋牌。
     ★ 桌面全空 ⟺ 這是這一局的第一手,而第一手的人一定持 ♠7 → 只准出 ♠7。 */
  function legal(hand, tracks){
    if(!tracksOpen(tracks)) return hand.indexOf(SPADE7) >= 0 ? [SPADE7] : [];
    return hand.filter(c => playable(c, tracks)).sort((a, b) => a - b);
  }
  /* 「為什麼這張出不了」。★ 不可出的牌壓暗但**仍然可點**(CLAUDE.md 的紅線:
     不用 disabled 讓牌靜默吃掉點擊),那麼點下去就必須回答得出原因,否則跟壞掉沒兩樣。
     ⚠ 放在規則層是因為單機與連線都要用 —— 兩邊各寫一份遲早會走鐘(而且走鐘了
       兩邊各自都不會壞,沒有東西抓得到)。 */
  function whyNot(card, tracks){
    const s = suitOf(card), t = tracks[s];
    if(!tracksOpen(tracks)) return "第一手一定要出 " + nameOf(SPADE7);
    if(!t) return suitCh(s) + " 這條還沒開,只有 " + suitCh(s) + "7 開得了";
    const ends = endsOf(tracks, s);
    if(!ends.length) return suitCh(s) + " 已經 A 到 K 全開了";
    return suitCh(s) + " 現在只接得上 " + ends.map(rankTxt).join(" 或 ");
  }

  // 某條龍現在的兩個接口(給提示文案用;沒開的龍回 [7])
  function endsOf(tracks, s){
    const t = tracks[s];
    if(!t) return [7];
    const out = [];
    if(t.lo > 1) out.push(t.lo - 1);
    if(t.hi < 13) out.push(t.hi + 1);
    return out;
  }

  /* ==========================================================================
     四、replay —— ★ 一整局唯一的真相入口
     ==========================================================================
       回傳:
         n, hands[], tracks[], piles[](各家蓋掉的牌), turn(-1 = 結束),
         finished[](手牌清空的先後,存座位)、over、last、bad(第幾手不合法)
       ⚠ turn 只能由這裡推:手牌清空的座位要跳過。 */
  function startSeat(hands){
    for(let s = 0; s < hands.length; s++) if(hands[s].indexOf(SPADE7) >= 0) return s;
    return 0;      // 理論上到不了(♠7 一定在某人手上)
  }
  function nextSeat(st, from){
    const n = st.n;
    for(let k = 1; k <= n; k++){
      const s = (from + k) % n;
      if(st.hands[s].length) return s;
    }
    return -1;     // 全部人手牌都空了 → 這局結束
  }

  function blank(cards, n){
    const hands = handsOf(cards, n);
    const piles = [];
    for(let s = 0; s < n; s++) piles.push([]);
    return {
      n: n, hands: hands, tracks: emptyTracks(), piles: piles,
      turn: startSeat(hands), finished: [], over: false, last: null, bad: -1
    };
  }

  /* 套用一手。回 true = 成功;false = 不合法(呼叫端要中止,不可以硬套下去)。 */
  function step(st, mv){
    if(st.over || st.turn < 0) return false;
    const seat = st.turn, card = moveCard(mv), pass = movePass(mv);
    if(card < 0 || card >= NCARD) return false;
    const hand = st.hands[seat], at = hand.indexOf(card);
    if(at < 0) return false;                              // 這張不在他手上
    const can = legal(hand, st.tracks);
    if(pass){
      // ★ 有牌可出就**不准**蓋牌 —— 這是排七的核心規則,少了它整個玩法就散了
      if(can.length) return false;
      st.piles[seat].push(card);
    }else{
      if(can.indexOf(card) < 0) return false;             // 接不上
      const s = suitOf(card), r = rankOf(card), t = st.tracks[s];
      if(!t) st.tracks[s] = { lo: r, hi: r };
      else if(r === t.lo - 1) t.lo = r;
      else t.hi = r;
    }
    hand.splice(at, 1);
    st.last = { seat: seat, card: card, pass: !!pass };
    if(!hand.length && st.finished.indexOf(seat) < 0) st.finished.push(seat);
    st.turn = nextSeat(st, seat);
    if(st.turn < 0){ st.over = true; }
    return true;
  }

  function replay(deal, n, moves){
    const cards = (typeof deal === "string") ? decodeDeal(deal) : deal;
    if(!cards || !(n >= 2 && n <= 6)) return null;
    const st = blank(cards, n);
    const mv = Array.isArray(moves) ? moves : [];
    for(let i = 0; i < mv.length; i++){
      if(!step(st, mv[i])){ st.bad = i; break; }          // 不合法就停在這裡,不硬套
    }
    return st;
  }

  /* ==========================================================================
     五、結算
     ──────────────────────────────────────────────────────────────────────────
       蓋牌點數總和最少者勝 → 同分比蓋牌張數 → 再同比誰先把手牌清空。
       ⚠ 三層都同分理論上不會發生(清空的先後一定不同),但仍回並列名單 ——
         核心的 winner.ids 本來就支援,不必為了「不會發生」多一條特例。
     ========================================================================== */
  function ptsOf(pile){ return pile.reduce((a, c) => a + rankOf(c), 0); }

  function score(st){
    const rows = [];
    for(let s = 0; s < st.n; s++){
      const fin = st.finished.indexOf(s);
      rows.push({
        seat: s, pts: ptsOf(st.piles[s]), cnt: st.piles[s].length,
        fin: fin < 0 ? st.n : fin, rank: 0
      });
    }
    const sorted = rows.slice().sort((a, b) => (a.pts - b.pts) || (a.cnt - b.cnt) || (a.fin - b.fin));
    let rk = 0;
    sorted.forEach((r, i) => {
      const p = i ? sorted[i - 1] : null;
      if(!p || p.pts !== r.pts || p.cnt !== r.cnt || p.fin !== r.fin) rk = i + 1;
      r.rank = rk;
    });
    return { rows: rows, sorted: sorted, winners: sorted.filter(r => r.rank === 1).map(r => r.seat) };
  }

  /* ==========================================================================
     六、小工具(顯示端與 AI 共用)
     ========================================================================== */
  // 這一局到目前為止「已經攤在軌道上」的牌(蓋掉的**不算** —— 那是保密的)
  function onTable(tracks){
    const out = [];
    for(let s = 0; s < NSUIT; s++){
      const t = tracks[s];
      if(!t) continue;
      for(let r = t.lo; r <= t.hi; r++) out.push(cardOf(s, r));
    }
    return out;
  }
  // 出這張之後,軌道上會多讓出幾個新接口(給 AI 與提示用:越少越不便宜對手)
  function opensAfter(card, tracks){
    const s = suitOf(card), r = rankOf(card), t = tracks[s];
    if(!t) return (r === 7) ? 2 : 0;              // 開新龍 → 一次讓出 6 與 8 兩個口
    if(r === t.lo - 1) return r > 1 ? 1 : 0;      // 接到 A 就沒有下一口了
    if(r === t.hi + 1) return r < 13 ? 1 : 0;
    return 0;
  }

  return {
    // 常數
    NSUIT, NRANK, NCARD, SPADE7, SUIT_KEY, SUIT_NAME, VS15,
    MIN_PLAYERS: 2, MAX_PLAYERS: 6,
    // 編碼
    suitOf, rankOf, cardOf, isRed, suitCh, rankTxt, nameOf, longName,
    chr, unchr, encodeDeal, decodeDeal,
    encMove, moveCard, movePass,
    // 發牌
    shuffled, newDeal, handsOf, dealCounts,
    // 規則
    emptyTracks, tracksOpen, playable, legal, endsOf, whyNot,
    // 一局
    blank, step, replay, startSeat,
    // 結算
    ptsOf, score,
    // 小工具
    onTable, opensAfter
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = SV;

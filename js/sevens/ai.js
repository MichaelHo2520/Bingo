"use strict";

/* ============================================================================
   排七 — 電腦對手(SVAI)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/gomoku/ai.js 與 js/mahjong16/ai.js:棋力只有靠 node 大量對局
     才量得出來,碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── ★★ AI 不作弊,而且是**結構上**做不到 ─────────────────────────────────
     手牌在這個專案裡是明碼(連線刻意不防作弊),單機更是整包 state 都在同一支程式裡
     —— 「電腦不偷看」若只靠自律,改兩行就破功,而且畫面上完全看不出來
     (只會覺得「電腦怎麼每次都剛好蓋掉我在等的那張」)。
     所以決策函式**只吃 viewOf() 濾出來的 view**:裡面只有自己的手牌、自己蓋的牌、
     軌道、各家「剩幾張 / 蓋幾張」,**沒有任何對手的牌值**。
     ⚠ 這條有測試守著(tools/test-sevens-ai.js):把對手的手牌與蓋牌整個換掉再問一次,
       AI 的選擇必須一模一樣。誰把 st 直接餵進決策函式,那條就會紅。

   ── 排七的策略長什麼樣(三個難度的差距就建在這上面)─────────────────────────
     ① **出牌讓出的接口越少越好**:接到 A / K 那一側就封死了(opensAfter = 0),
        開一條新龍的 7 一次讓出兩個口(最便宜對手)。
     ② **我還握著下一張 → 這條龍還在我手上**:出了無妨,對手接不到便宜。
     ③ **蓋牌不是「蓋點數最大的」**。被迫蓋牌時真正要問的是兩件事:
        這張反正出不出得掉(出不掉的蓋了幾乎無損)、
        以及**蓋了會不會把我自己後面的牌一起封死**(蓋掉 ♠8 → 手上的 ♠9 ♠10 全部作廢)。
        普通只會蓋點數最大的,高手用「預期損失」挑 —— 這是兩級之間最大的差距。
   ========================================================================== */

const SVAI = (function(){

  const R = (typeof SV !== "undefined") ? SV : require("./rules.js");

  /* ==========================================================================
     一、難度
     ========================================================================== */
  const LEVELS = {
    easy:   { key:"easy",   emoji:"🙂", name:"新手", desc:"看到能出的就出,蓋牌也隨便挑", ms:[260, 520] },
    normal: { key:"normal", emoji:"🤔", name:"普通", desc:"會少讓接口、留住自己的牌路", ms:[380, 760] },
    hard:   { key:"hard",   emoji:"😈", name:"高手", desc:"算得出哪張反正出不掉,專蓋那張", ms:[520, 1000] }
  };
  const LEVEL_KEYS = ["easy", "normal", "hard"];
  function levelOf(k){ return LEVELS[k] || LEVELS.normal; }
  function thinkMs(k, rng){
    const m = levelOf(k).ms, r = rng || Math.random;
    return Math.round(m[0] + r() * (m[1] - m[0]));
  }

  /* ==========================================================================
     二、★ viewOf —— 一家看得見的東西
     ──────────────────────────────────────────────────────────────────────────
       放進來的每一樣都是**桌上任何一個玩家都算得出來的**:
         hand / myPile  自己的(自己本來就知道)
         tracks         攤在桌上的軌道
         counts         各家手上剩幾張(數得出來)
         pileCounts     各家蓋了幾張(數得出來;★ 牌值不給)
       ⚠ 一旦有人想在這裡加 `st.hands` 或 `st.piles`,不作弊那條測試就會紅。
     ========================================================================== */
  function viewOf(st, seat){
    return {
      n: st.n, seat: seat,
      hand: st.hands[seat].slice(),
      myPile: st.piles[seat].slice(),
      tracks: st.tracks.map(t => t ? { lo: t.lo, hi: t.hi } : null),
      counts: st.hands.map(h => h.length),
      pileCounts: st.piles.map(p => p.length),
      finished: st.finished.slice()
    };
  }

  /* ==========================================================================
     三、共用的盤面推理(全部只吃 view)
     ========================================================================== */

  /* 這張牌與軌道端點之間還隔著哪幾張(不含自己)。
     那些牌一定還沒現身(現身的話軌道早就延伸過去了)→ 在別人手上或已經被誰蓋掉。 */
  function gapOf(view, card){
    const s = R.suitOf(card), r = R.rankOf(card), t = view.tracks[s], out = [];
    if(!t){
      // 這條龍還沒開:要先有人出 7,再從 7 一路接到 r
      if(r === 7) return out;
      const lo = Math.min(r + 1, 7), hi = Math.max(r - 1, 7);
      for(let k = lo; k <= hi; k++) if(k !== r) out.push(R.cardOf(s, k));
      return out;
    }
    if(r > t.hi) for(let k = t.hi + 1; k < r; k++) out.push(R.cardOf(s, k));
    else if(r < t.lo) for(let k = r + 1; k < t.lo; k++) out.push(R.cardOf(s, k));
    return out;
  }
  // 「還要等幾張不在我手上的牌」—— 越大越可能永遠出不掉(中間有一張被蓋掉就斷了)
  function hopeless(view, card){
    return gapOf(view, card).filter(c => view.hand.indexOf(c) < 0).length;
  }
  /* 蓋掉這張會把我自己手上的哪幾張一起封死:同花色、在它**外側**(更遠離軌道)的那些。
     ⚠ 沒開的龍那張 7 最狠 —— 蓋了整條龍永遠開不了,我手上該花色**全部**作廢。 */
  function selfBlocked(view, card){
    const s = R.suitOf(card), r = R.rankOf(card), t = view.tracks[s];
    return view.hand.filter(c => {
      if(c === card || R.suitOf(c) !== s) return false;
      const k = R.rankOf(c);
      if(!t) return (r === 7) ? true : (r > 7 ? k > r : k < r);
      if(r > t.hi) return k > r;
      if(r < t.lo) return k < r;
      return false;
    });
  }
  // 出了這張之後,新讓出的那個接口是哪張牌(-1 = 沒讓出新口)
  function openedCards(view, card){
    const s = R.suitOf(card), r = R.rankOf(card), t = view.tracks[s], out = [];
    if(!t){
      if(r !== 7) return out;                       // 只有 7 開得了新龍
      out.push(R.cardOf(s, 6)); out.push(R.cardOf(s, 8));
      return out;
    }
    if(r === t.lo - 1){ if(r > 1) out.push(R.cardOf(s, r - 1)); }
    else if(r === t.hi + 1){ if(r < 13) out.push(R.cardOf(s, r + 1)); }
    return out;
  }
  // 這條龍這一側我還握著幾張連續的牌(推進它對我最划算)
  function ownRun(view, card){
    const s = R.suitOf(card), r = R.rankOf(card), t = view.tracks[s];
    const up = (!t) ? (r >= 7) : (r > t.hi);
    let k = r, run = 0;
    for(;;){
      k += up ? 1 : -1;
      if(k < 1 || k > 13) break;
      if(view.hand.indexOf(R.cardOf(s, k)) < 0) break;
      run++;
    }
    return run;
  }
  /* 桌上的壓力:別人最少剩幾張。有人快出完了就別再開新龍餵他。
     ⚠ 只用得到「剩幾張」—— 那是公開資訊(對手列上就寫著)。 */
  function pressure(view){
    let min = 99;
    for(let s = 0; s < view.n; s++){
      if(s === view.seat) continue;
      if(view.counts[s] > 0) min = Math.min(min, view.counts[s]);
    }
    return min === 99 ? 99 : min;
  }

  /* ==========================================================================
     四、出牌
     ========================================================================== */
  /* ★★ 這組權重是用**第一名的比例**調出來的,不是用平均罰分 —— 兩者會給出相反的答案。
     實測(1 個受測 vs 3 個新手,各 500 局):
       「優先出靠近 7 的牌」罰分最低(10.21,全場最低)但第一名率只有 24.4%,**比亂出還差**。
       原因是它一路把四條龍全打通 → 我的罰分降了,但**對手降得更多**。
     排七贏的定義是「罰分比別人低」,所以目標函數只能是第一名率。
     這一條在調參時非常容易搞錯(罰分是那個看起來最像「棋力」的數字)。 */
  const W = {
    open:  10,      // 讓出一個「對手接得到」的接口 —— ★ 只有這一項的效果是量得出來的
    mine:   2,      // 讓出的口在我手上 → 只有我出得了,便宜得多
    dump:   1,      // 離 7 越遠的牌機會越少,能出就先出掉
    run:  0.5       // 這一側我還握著幾張連續的
  };

  /* ⚠ 誠實記一筆:**出牌權重的細部調整,強度差異落在雜訊裡**。
     1200 局實測「只看接口數」30.7% vs 這一版 32.3%,標準誤約 1.3% → 分不出來。
     真正決定強弱的是**蓋牌**(亂蓋 21 分 → hopeless 16 分 → 完整損失 13 分)。
     所以這裡不要再堆砌權重了 —— 曾經加過一段「有人快出完就更保守」的警戒係數,
     實測與沒加它**完全同分**(25.7% vs 25.7%),那是死碼,已經拿掉。
     ★ 也因此這一段沒有針對性的突變測試:改權重測不紅,不是測試不好,
       是那個改動本來就不影響強度。 */
  function playScore(view, card){
    let sc = 0;
    const opened = openedCards(view, card);
    // 讓出的接口:那張若在我手上就只有我出得了,幾乎沒有代價
    opened.forEach(c => { sc -= (view.hand.indexOf(c) >= 0) ? W.mine : W.open; });
    sc += Math.abs(R.rankOf(card) - 7) * W.dump;
    sc += ownRun(view, card) * W.run;
    return sc;
  }

  function pickPlay(view, can, level, rng){
    const r = rng || Math.random;
    if(level === "easy") return can[Math.floor(r() * can.length)];
    if(level === "normal"){
      /* 普通:只看「讓出幾個接口」,平手時出離 7 遠的。
         看得懂第①條,但不會算第②③條 —— 與高手的差距就在這裡。 */
      let best = can[0], bs = -1e9;
      can.forEach(c => {
        const s = -R.opensAfter(c, view.tracks) * 10 + Math.abs(R.rankOf(c) - 7);
        if(s > bs){ bs = s; best = c; }
      });
      return best;
    }
    let best = can[0], bs = -1e9;
    can.forEach(c => {
      const s = playScore(view, c);
      if(s > bs){ bs = s; best = c; }
    });
    return best;
  }

  /* ==========================================================================
     五、★ 蓋牌 —— 兩級之間最大的差距
     ──────────────────────────────────────────────────────────────────────────
       高手用「預期損失」:
           loss(c) = (這張的點數 + 被它封死的那些牌的點數) ÷ (1 + 還要等幾張)
       分子是「真的蓋掉會賠多少」,分母是「這張本來就出得掉的機率有多低」。
       蓋 loss 最小的那張。三個都對得上直覺:
         · 反正出不掉的牌(分母大)→ 蓋了幾乎無損
         · 手上握著一整串的那張(分子大)→ 絕對不能蓋,蓋了後面全部作廢
         · 大家都出得掉時(分母都是 1)→ 退化成「蓋點數最大的」,與普通一致
     ========================================================================== */
  function coverLoss(view, card){
    const blocked = selfBlocked(view, card);
    const sum = R.rankOf(card) + blocked.reduce((a, c) => a + R.rankOf(c), 0);
    return sum / (1 + hopeless(view, card));
  }

  function pickCover(view, level, rng){
    const r = rng || Math.random, hand = view.hand;
    if(!hand.length) return -1;
    if(level === "easy") return hand[Math.floor(r() * hand.length)];
    if(level === "normal"){
      /* 普通:只問「這張反正出不出得掉」,一樣出不掉時蓋點數大的。
         它**不算**「蓋了會不會把自己後面一整串封死」—— 那是高手多出來的那一層。
         ⚠ 這一級試過另外兩種寫法,實測都幾乎等於亂蓋(1 vs 3 新手,罰分 21 → 20):
             ·「蓋點數最大的」    大牌本來就多在龍的末端,蓋了不封死什麼
             ·「避開封死自己的」  單獨用沒有價值,它要與 hopeless 相乘才有意義
           會動的只有 hopeless(21 → 16),所以中間這一級就給它。 */
      let best = hand[0], bs = -1e9;
      hand.forEach(c => {
        const s = hopeless(view, c) * 100 + R.rankOf(c);
        if(s > bs){ bs = s; best = c; }
      });
      return best;
    }
    let best = hand[0], bl = 1e9;
    hand.forEach(c => {
      const l = coverLoss(view, c);
      if(l < bl){ bl = l; best = c; }
    });
    return best;
  }

  /* ==========================================================================
     六、決策入口
     ==========================================================================
       回 { act:"play"|"pass", card }。
       ⚠ 呼叫端一律要處理這兩種 act —— 台灣麻將踩過「新動作漏在某個呼叫端」那個坑
         (漏掉不會壞,只會變笨,而症狀離原因很遠)。 */
  function pickTurn(view, level, rng){
    const lv = LEVELS[level] ? level : "normal";
    const can = R.legal(view.hand, view.tracks);
    if(can.length) return { act: "play", card: pickPlay(view, can, lv, rng) };
    return { act: "pass", card: pickCover(view, lv, rng) };
  }

  /* 倒數到期時「幫他出一手」也走這裡(連線 / 單機共用)。
     刻意用 normal 而不是當局難度:那是替**人類**代打,不該套電腦的個性。 */
  function autoMove(st, seat){
    const v = viewOf(st, seat);
    const a = pickTurn(v, "normal");
    return R.encMove(a.card, a.act === "pass");
  }

  return {
    LEVELS, LEVEL_KEYS, levelOf, thinkMs,
    viewOf, pickTurn, autoMove,
    // 給測試與提示用的中間量
    gapOf, hopeless, selfBlocked, openedCards, ownRun, pressure,
    playScore, coverLoss, pickPlay, pickCover
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SVAI;

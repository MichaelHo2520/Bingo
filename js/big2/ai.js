"use strict";

/* ============================================================================
   大老二 — 電腦對手(B2AI)。
   ★ 純函式,零 DOM、零 Firebase、零 MP。棋力**只有靠 node 大量對打才驗得出來**,
     碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩(CLAUDE.md 的紅線)。

   ── ★ AI 不作弊是「結構上」做到的 ────────────────────────────────────────────
     所有決策只看 viewOf() 濾出來的 view,而 view 裡**沒有任何對手的牌值** ——
     只有「每家還剩幾張」「桌上這一手是什麼」「已經公開出過哪些牌」。
     守門(test-big2-ai.js A 節):把對手的手牌**整副換掉**再問一次,
     三個難度的選擇都必須一模一樣。

   ── ★★ 目標函數是名次分,不是「平均剩幾張」──────────────────────────────
     排七踩過這個坑(notes/15 第五節):某個策略平均罰分**全場最低**、
     第一名率卻比亂出還差 —— 它讓自己好看,但讓對手更好看。
     大老二同理:「平均剩幾張」是那個最像棋力的數字,但它會給出相反的答案。
     調參一律看 **平均名次分 / 第一名率**,而且 **2 / 3 / 4 人局都要各驗一次**
     (只驗 4 人局會漏掉「策略只在某個人數成立」)。

   ── 三個難度 ──────────────────────────────────────────────────────────────
     新手 easy  隨機合法手;跟牌時常常懶得壓
     普通 mid   跟牌出「最便宜的能壓手」;領出出最小的一組;不亂拆鐵支
     高手 hard  用「還要幾手才出得完」(tricksNeeded)當主評分 +
                控制權 / 封鎖(有人快出完就下重手)+ 不為了一張單張拆掉整組
   ========================================================================== */

const B2AI = (function(){

  const LEVELS = ["easy", "mid", "hard"];
  const LEVEL_NAME = { easy: "新手", mid: "普通", hard: "高手" };

  /* 難度的門面資料(選單與單機列直接讀這裡,不在畫面層另外硬編一份文案)。
     thinkMs = 可見的思考時間:算完只花 1ms 的話,三家會在同一格瞬間打完,
     玩家看到的是「我一出牌畫面就整個變了」,根本讀不出剛才發生什麼事。 */
  const LEVEL_INFO = {
    easy: { key:"easy", name:"新手", emoji:"🙂", think:420,
            desc:"隨便出、常常懶得壓你" },
    mid:  { key:"mid",  name:"普通", emoji:"🤔", think:560,
            desc:"出最小的能壓手,不會亂拆鐵支" },
    hard: { key:"hard", name:"高手", emoji:"😈", think:700,
            desc:"算「還要幾手才出得完」,會留大牌搶領出權,看到有人快出完就下重手" }
  };
  const LEVEL_KEYS = LEVELS.slice();
  const levelOf = k => LEVEL_INFO[k] || LEVEL_INFO.mid;
  const thinkMs = k => levelOf(k).think;

  /* ==========================================================================
     一、★ view —— AI 唯一看得到的東西
     ──────────────────────────────────────────────────────────────────────────
       刻意只收「公開資訊」:
         • 自己的手牌
         • 桌上這一手(牌是攤在桌上的,所以連牌值都是公開的)
         • 每一家還剩幾張(晶片上就寫著)
         • 已經公開出過哪些牌(可以數牌 —— 人類也做得到)
       **絕對不含 st.hands 的其他座位**。多回一個欄位就等於 AI 開始作弊,
       而症狀是「電腦強得莫名其妙」,在畫面上完全看不出來。
     ========================================================================== */
  function viewOf(st, seat){
    return {
      n: st.n,
      seat: seat,
      hand: st.hands[seat].slice(),
      opened: !!st.opened,
      lead: !st.cur,
      cur: st.cur ? { t: st.cur.cls.t, k: st.cur.cls.k, n: st.cur.cls.n,
                      seat: st.cur.seat, cards: st.cur.cards.slice() } : null,
      left: st.hands.map(h => h.length),
      played: st.played.slice(),
      finished: st.finished.slice()
    };
  }

  /* ==========================================================================
     二、手牌分解:★「還要幾手才出得完」
     ──────────────────────────────────────────────────────────────────────────
       這是高手難度的主評分。一副手牌的價值不在「幾張」而在「幾手出得完」:
       13 張散牌要 13 手,13 張湊成 2 個五張 + 1 對 + 1 張只要 4 手。
       ⚠ 刻意**不用 enumPlays()** 來做這件事 —— 那支會列出幾百種組合,
         而高手每一步要對每個候選手各算一次,自我對局幾千局就會慢到不能調參。
         這裡是 O(52) 的貪心:先抽走最「省手數」的五張牌型,再對子,剩下算單張。
     ========================================================================== */
  const rankOf = c => B2.rankOf(c), suitOf = c => B2.suitOf(c);

  function rankBuckets(pool){
    const by = {};
    pool.forEach(c => { const r = rankOf(c); (by[r] = by[r] || []).push(c); });
    return by;
  }
  // 從 pool 裡拿掉這幾張(就地)
  function rm(pool, cs){
    cs.forEach(c => { const i = pool.indexOf(c); if(i >= 0) pool.splice(i, 1); });
  }
  /* 在 pool 裡找一個「同花色 + 合法點數窗」的同花順(找到就回那 5 張) */
  function findSFlush(pool){
    for(let s = 0; s < B2.NSUIT; s++){
      const mine = pool.filter(c => suitOf(c) === s);
      if(mine.length < 5) continue;
      const at = {};
      mine.forEach(c => { at[rankOf(c)] = c; });
      for(let w = 0; w < B2.WINDOWS.length; w++){
        const win = B2.WINDOWS[w];
        if(win.every(r => at[r] !== undefined)) return win.map(r => at[r]);
      }
    }
    return null;
  }
  /* 四條 + 一張最小的雜牌 = 鐵支 */
  function findQuads(pool){
    const by = rankBuckets(pool);
    const rs = Object.keys(by).map(Number).filter(r => by[r].length === 4);
    if(!rs.length) return null;
    rs.sort((a, b) => B2.rkOrder(a) - B2.rkOrder(b));
    const quad = by[rs[0]];
    const rest = pool.filter(c => rankOf(c) !== rs[0]);
    if(!rest.length) return null;                 // 只剩四條,湊不出第五張
    rest.sort(B2.cmpCard);
    return quad.concat([rest[0]]);
  }
  /* 三條 + 另一個點數的對子 = 葫蘆(三條挑點數最小的,對子也挑最小的) */
  function findFull(pool){
    const by = rankBuckets(pool);
    const rs = Object.keys(by).map(Number);
    const tri = rs.filter(r => by[r].length >= 3).sort((a, b) => B2.rkOrder(a) - B2.rkOrder(b));
    if(!tri.length) return null;
    for(let i = 0; i < tri.length; i++){
      const prs = rs.filter(r => r !== tri[i] && by[r].length >= 2)
                    .sort((a, b) => B2.rkOrder(a) - B2.rkOrder(b));
      if(prs.length) return by[tri[i]].slice(0, 3).concat(by[prs[0]].slice(0, 2));
    }
    return null;
  }
  /* 順子:每個點數各挑一張(挑花色最小的那張,把大花色留著) */
  function findStraight(pool){
    const by = rankBuckets(pool);
    for(let w = 0; w < B2.WINDOWS.length; w++){
      const win = B2.WINDOWS[w];
      if(!win.every(r => by[r] && by[r].length)) continue;
      return win.map(r => by[r].slice().sort(B2.cmpCard)[0]);
    }
    return null;
  }

  /* ★ 還要幾手才出得完(越小越好)。順序刻意是「同花順 → 鐵支 → 葫蘆 → 順子 → 對子」:
     前面兩個是壓制手,能整組走掉最划算;順子放在葫蘆之後是因為葫蘆會吃掉三條,
     而三條在這一版**不能單獨出**,留著就是三張各自算一手。 */
  function tricksNeeded(hand){
    const pool = hand.slice();
    let cnt = 0, guard = 0;
    for(;;){ const g = findSFlush(pool); if(!g || guard++ > 20) break; rm(pool, g); cnt++; }
    for(;;){ const g = findQuads(pool);  if(!g || guard++ > 40) break; rm(pool, g); cnt++; }
    for(;;){ const g = findFull(pool);   if(!g || guard++ > 60) break; rm(pool, g); cnt++; }
    for(;;){ const g = findStraight(pool); if(!g || guard++ > 80) break; rm(pool, g); cnt++; }
    const by = rankBuckets(pool);
    Object.keys(by).forEach(r => {
      const k = by[r].length;
      cnt += Math.floor(k / 2) + (k % 2);        // 兩張湊一對算一手,剩的單張各一手
    });
    return cnt;
  }

  /* ==========================================================================
     三、公開資訊推出來的兩件事
     ========================================================================== */
  // 對手裡最少剩幾張(不含自己、不含已經出完的)
  function minFoeLeft(v){
    let m = 99;
    for(let s = 0; s < v.n; s++){
      if(s === v.seat || !v.left[s]) continue;
      if(v.left[s] < m) m = v.left[s];
    }
    return m;
  }
  /* 這張單張是不是「全場最大的沒出過的牌」—— 有它就有控制權。
     只用公開資訊算:已出過的 + 我手上的,其餘就是別人手上的。 */
  function isTopSingle(v, card){
    const seen = {};
    v.played.forEach(c => { seen[c] = 1; });
    v.hand.forEach(c => { seen[c] = 1; });
    if(v.cur) v.cur.cards.forEach(c => { seen[c] = 1; });
    const mine = B2.cardKey(card);
    for(let c = 0; c < B2.NCARD; c++) if(!seen[c] && B2.cardKey(c) > mine) return false;
    return true;
  }
  // 這一手用掉多少「牌力」(越小越省;拿來當第二排序鍵)
  const powerCost = cards => cards.reduce((a, c) => a + B2.cardKey(c), 0);

  /* ==========================================================================
     四、候選手
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 第一手必須包含 ♣3 —— 這一條要在**候選階段**就濾掉,不能等規則層擋:
         規則層擋下來的結果是「AI 出了不合法的手 → step 回 false → 整局卡住」。
     ========================================================================== */
  function candidates(v){
    let cs = B2.playsBeating(v.hand, v.cur ? { t: v.cur.t, k: v.cur.k, n: v.cur.n } : null);
    if(!v.opened) cs = cs.filter(p => p.cards.indexOf(B2.CLUB3) >= 0);
    return cs;
  }
  const canPass = v => !v.lead;      // 領出的人不能 pass(規則層也擋,這裡是給決策用)

  /* ==========================================================================
     五、三個難度
     ========================================================================== */

  /* ---------- 新手:隨機 ----------
     跟牌時有一半機率懶得壓(這是「新手」最像的地方:看不出該不該壓就不壓)。
     ⚠ 領出時一定要出 —— 不然這局永遠不會結束。 */
  function pickEasy(v, rng){
    const cs = candidates(v);
    if(!cs.length) return B2.PASS;                       // 一定是跟牌(領出時至少有單張)
    if(canPass(v) && rng() < 0.5) return B2.PASS;
    return B2.encMove(cs[Math.floor(rng() * cs.length)].cards);
  }

  /* ---------- 普通:最便宜的能壓手 ----------
       • 跟牌:candidates 已經由便宜到貴排好(無敵型在最後)→ 拿第一個。
         ⚠ 但**不為了壓一手普通牌去拆鐵支 / 同花順** —— 除非有人只剩 ≤2 張,
           那時再不壓就來不及了。
       • 領出:出最小的一組,而且**同樣便宜時優先出張數多的**(能一次少一手)。 */
  function pickMid(v, rng){
    const cs = candidates(v);
    if(!cs.length) return B2.PASS;
    const danger = minFoeLeft(v) <= 2;

    if(!v.lead){
      const plain = cs.filter(p => !B2.isBomb(p.cls.t));
      if(plain.length) return B2.encMove(plain[0].cards);
      // 只剩無敵牌型能壓 → 有危險才拆,否則放過這一輪
      if(danger) return B2.encMove(cs[0].cards);
      return B2.PASS;
    }

    // 領出:排除無敵牌型(留著當保命),先比張數多、再比便宜
    let pool = cs.filter(p => !B2.isBomb(p.cls.t));
    if(!pool.length) pool = cs;
    pool = pool.slice().sort((a, b) =>
      (b.cards.length - a.cards.length) || (powerCost(a.cards) - powerCost(b.cards))
    );
    // 能一次出完就出完
    const finish = cs.filter(p => p.cards.length === v.hand.length);
    if(finish.length) return B2.encMove(finish[0].cards);
    return B2.encMove(pool[0].cards);
  }

  /* ---------- 高手 ----------
       主評分 = 「這一手打完之後,還要幾手才出得完」的**減少量**(saved)。
       次評分 = 用掉的牌力(越省越好)。
       另外三條:
         ① 能一次出完就出完(這是唯一無條件優先的事)
         ② 有人只剩 ≤2 張 → 跟牌時一定要壓(必要時拆鐵支);領出時避免出單張
         ③ 沒危險而最好的候選手會**讓手數變多**(拆組)→ 寧可 pass */
  function scoreHard(v, p, base){
    const after = v.hand.filter(c => p.cards.indexOf(c) < 0);
    const saved = base - tricksNeeded(after);
    return { saved: saved, cost: powerCost(p.cards), p: p };
  }

  /* ⚠ 有上限,而且刻意寫出來(不做沉默的截斷):
       領出時 enumPlays 對一副 26 張的手牌會列出好幾百種組合(順子的花色組合是乘法),
       而高手要對**每一個候選手**各跑一次 tricksNeeded → 自我對局幾百局就會慢到不能調參。
     取捨:先按「用掉的牌力」由省到貴排序,只評分最省的 HARD_POOL 個。
       被丟掉的都是「更浪費牌力」的同型變體(例如同一個順子換成大花色),
       在這個評分函數下本來就不會贏 —— 所以這個截斷幾乎不影響選擇,只影響速度。
     ★ 要調棋力時先把它調大再量一次:如果數字有變,那就不是「幾乎不影響」而是真的有影響。 */
  const HARD_POOL = 60;
  function capPool(cs){
    if(cs.length <= HARD_POOL) return cs;
    return cs.slice().sort((a, b) => powerCost(a.cards) - powerCost(b.cards)).slice(0, HARD_POOL);
  }

  function bestHard(v, cs, base){
    const scored = capPool(cs).map(p => scoreHard(v, p, base));
    scored.sort((a, b) => (b.saved - a.saved) || (a.cost - b.cost));
    return scored[0];
  }

  function pickHard(v, rng){
    const cs = candidates(v);
    if(!cs.length) return B2.PASS;

    // ① 能一次出完就出完
    const finish = cs.filter(p => p.cards.length === v.hand.length);
    if(finish.length){
      finish.sort((a, b) => powerCost(a.cards) - powerCost(b.cards));
      return B2.encMove(finish[0].cards);
    }

    const base = tricksNeeded(v.hand);
    const danger = minFoeLeft(v) <= 2;

    if(!v.lead){
      const plain = cs.filter(p => !B2.isBomb(p.cls.t));
      // ② 有人快出完 → 一定要壓(普通手不夠就拆無敵牌型)
      if(danger) return B2.encMove((plain.length ? bestHard(v, plain, base) : bestHard(v, cs, base)).p.cards);
      if(!plain.length) return B2.PASS;                  // 沒危險就不拆鐵支
      const best = bestHard(v, plain, base);
      /* ③ 最好的壓法會讓手數變多(= 拆掉了一組),而且我又不是快出完 → 放過這一輪。
         ⚠ 手上只剩一兩手時例外:那時「出得掉」比「牌型完整」重要得多。 */
      if(best.saved < 0 && base > 2) return B2.PASS;
      /* 控制權:如果這一手是拿全場最大的單張去壓一張小牌,那是浪費 ——
         留著它,等真的需要搶回領出權的時候用。 */
      if(best.p.cards.length === 1 && isTopSingle(v, best.p.cards[0]) && base > 2 && !danger)
        return B2.PASS;
      return B2.encMove(best.p.cards);
    }

    // 領出
    let pool = cs.filter(p => !B2.isBomb(p.cls.t));
    if(!pool.length) pool = cs;
    // ② 有人只剩 ≤2 張 → 別餵單張給他(他一張就能收掉);盡量出多張
    if(danger){
      const multi = pool.filter(p => p.cards.length >= 2);
      if(multi.length) pool = multi;
    }
    return B2.encMove(bestHard(v, pool, base).p.cards);
  }

  /* ==========================================================================
     六、對外
     ========================================================================== */
  const PICKERS = { easy: pickEasy, mid: pickMid, hard: pickHard };

  /* 給 view 挑一手。回傳 move 字串(B2.PASS 或 encMove 的結果)。
     ⚠ 一律回**合法**的一手:candidates() 已經過 beats() 與「第一手含 ♣3」兩道濾網。 */
  function pickFromView(v, level, rng){
    const f = PICKERS[level] || pickMid;
    return f(v, rng || Math.random);
  }
  // 單機用:直接吃 replay 出來的 st(內部只透過 viewOf 看它,不會偷看對手)
  function pick(st, seat, level, rng){
    return pickFromView(viewOf(st, seat), level, rng);
  }
  /* 連線「到期自動出牌」用:替**人類**代打,所以一律固定「普通」、不套任何難度。
     (同排七 SVAI.autoMove 的理由:那不是電腦的個性該出現的地方。) */
  function autoMove(st, seat){
    return pickFromView(viewOf(st, seat), "mid", Math.random);
  }

  return {
    LEVELS, LEVEL_NAME, LEVEL_INFO, LEVEL_KEYS, levelOf, thinkMs,
    viewOf, tricksNeeded, candidates, minFoeLeft, isTopSingle, powerCost,
    findSFlush, findQuads, findFull, findStraight,
    pick, pickFromView, autoMove
  };
})();

/* node 測試用 */
if (typeof module !== "undefined" && module.exports){
  if (typeof B2 === "undefined") global.B2 = require("./rules.js");
  module.exports = B2AI;
}

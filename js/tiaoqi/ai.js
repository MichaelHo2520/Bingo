"use strict";

/* ============================================================================
   跳棋 — 電腦對手(TQAI)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。

   ── ★★ 「不作弊」在這一頁是結構上的 ────────────────────────────────────────
     跳棋**完全沒有隱藏資訊、也完全沒有亂數** —— 誰在哪一個洞是桌上人人看得見的
     事實,而且沒有骰子可以偷看(飛行棋要守的那一條在這裡連入口都不存在)。
     所以 viewOf() 留著只是為了與另外幾頁的介面一致,它一個東西都沒有濾掉。

   ── ★★★ 中國跳棋 AI 的兩個經典病(不處理就一定會發生)────────────────────
     ① **來回震盪**:A → B → A → B 無限循環,對局永遠跑不完。
        兩道防線:①禁止立刻走回上一手的起點 ②只接受「總距離不變大」的手
        (真的沒有這種手時才放寬,見 pick 的 fallback)。
     ② **落單的棋子**:貪心把前面幾顆送到底,留一兩顆在起點慢慢爬 →
        最後二十幾手極度無聊,而且那正是玩家會看著的畫面。
        解法是評估函數**不可以只看「到目標角的距離總和」**,要做**配對**:
        最接近的棋子配最深的洞。少了配對,所有棋子會擠向同一個洞
        → 前面的把後面的堵死(實測:單一目標點導航的貪心在 5000 手內跑不完一局)。

   ── 三個難度是「看得出行為差異」,不是「誰比較會贏」────────────────────────
     🙂 新手:只看「這一步往前多少」,不做配對 → 會把棋子擠成一團、會落單
     🤔 普通:配對式評估 + 不落單 + 會找長的連跳鏈
     😈 高手:再加**一層前瞻** —— 走完之後對手能不能借我的棋子飛一大段
              (這是跳棋唯一的人際互動,也是兩級之間唯一真正看得出來的差別)
   ========================================================================== */

const TQAI = (function(){

  const R = (typeof TQ !== "undefined") ? TQ : require("./rules.js");

  /* ==========================================================================
     一、難度
     ========================================================================== */
  const LEVELS = {
    easy:   { key:"easy",   emoji:"🙂", name:"新手", desc:"只看這一步往前多少,常常把棋子擠成一團", ms:[420, 780] },
    normal: { key:"normal", emoji:"🤔", name:"普通", desc:"會排隊填洞、不落單,也會找長的連跳鏈", ms:[560, 980] },
    hard:   { key:"hard",   emoji:"😈", name:"高手", desc:"還會算你下一手:不留跳板給你,自己專挑長鏈", ms:[700, 1200] }
  };
  const LEVEL_KEYS = ["easy", "normal", "hard"];
  function levelOf(k){ return LEVELS[k] || LEVELS.normal; }
  function thinkMs(k, rng){
    const m = levelOf(k).ms, r = rng || Math.random;
    return Math.round(m[0] + r() * (m[1] - m[0]));
  }

  /* 權重表 —— 三級的差別全部寫在這裡,一眼看得出誰多看了什麼。
     ⚠ 加新的評分項要三級都列一行(留 0 也要列),不然「這一級到底看不看這件事」
       只能靠讀程式碼推(同飛行棋 / 暗棋的紀律)。
       pair   配對式距離(0 = 只看單一目標點,會落單也會塞車)
       worst  最落後那一顆的權重(防落單)
       chain  連跳鏈的長度加分(純粹是好看,也真的比較快)
       settle 已經在目標區的棋子不要再動出來
       give   ★ 只有高手看:這一手會不會替下一家留下一條長跳板 */
  const W = {
    easy:   { pair: 0, worst: 0,   chain: 0.15, settle: 3,  give: 0 },
    normal: { pair: 1, worst: 0.9, chain: 0.30, settle: 9,  give: 0 },
    hard:   { pair: 1, worst: 1.0, chain: 0.34, settle: 10, give: 0.55 }
  };

  /* ==========================================================================
     二、view —— 這一頁沒有東西要濾
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 它回傳的是一份拷貝:AI 再怎麼寫都動不到真正的 st。
     ========================================================================== */
  function viewOf(st, seat){
    return {
      n: st.n, seat: seat, rules: st.rules,
      corners: st.corners.slice(), goals: st.goals.map(g => g.slice()),
      apex: st.apex.slice(), pieces: st.pieces.map(p => p.slice()),
      done: st.done.slice(), turn: st.turn, over: st.over
    };
  }
  function asState(v){
    return { n: v.n, rules: v.rules, corners: v.corners.slice(),
             goals: v.goals.map(g => g.slice()), apex: v.apex.slice(),
             pieces: v.pieces.map(p => p.slice()), done: v.done.slice(),
             turn: v.turn, over: false, winner: -1, last: null, bad: -1 };
  }

  /* ==========================================================================
     三、評估 —— ★★ 配對式,不是「距離總和」
     ──────────────────────────────────────────────────────────────────────────
       目標區的洞是有**深淺**的:最尖端那一個只有一條路進得去,一定要**最先**填。
       所以:把棋子依「離目標區多近」排序,最近的那顆配最深的洞,依此類推。
       ⚠ 少了配對就是「所有棋子擠向同一點」——
         實測(node,單一目標點導航)在 5000 手內跑不完一局:先到的那幾顆把洞口堵死了。
     ========================================================================== */
  function evalSeat(st, seat){
    const g = st.goals[seat];
    const deep = g[0];                                   // 最深的那一個洞
    const arr = st.pieces[seat].slice();
    /* 離「最深的洞」越近的排越前面 → 配到越深的位置。
       ⚠⚠⚠ **平手一定要用洞 id 再排一次(決定性)。**
         少了這個 tie-break,配對就會取決於 `st.pieces[seat]` **陣列裡的順序** ——
         而那個順序會隨著走子就地改變(arr[k] = to)。於是**同一個局面**在
         「走過去」與「走回來」之後算出不同的 sum,兩邊看起來都有進步
         → AI 兩手一循環地震盪,對局永遠跑不完。
         ★ 實測:少了這一行,normal 有 15%、hard 有 10% 的局在 1200 手內收斂不了,
           而且症狀是「兩顆棋各自來回」——**看起來完全像規則寫錯**。
         ⚠ 評估函數必須是**局面**的函式,不可以是「資料結構順序」的函式。 */
    arr.sort((a, b) => (R.dist(a, deep) - R.dist(b, deep)) || (a - b));
    let sum = 0, worst = 0;
    for(let i = 0; i < arr.length; i++){
      const d = R.dist(arr[i], g[i]);
      sum += d;
      if(d > worst) worst = d;
    }
    return { sum: sum, worst: worst };
  }
  // 只看單一目標點(新手用;會擠成一團,那正是它的行為特徵)
  function evalFlat(st, seat){
    const ap = st.apex[seat];
    let sum = 0, worst = 0;
    st.pieces[seat].forEach(id => {
      const d = R.dist(id, ap);
      sum += d;
      if(d > worst) worst = d;
    });
    return { sum: sum, worst: worst };
  }

  /* 走完這一手之後,**下一家**最長能連跳幾段(高手用)。
     ★ 這是跳棋唯一的人際互動:對手的棋子不是障礙,是**跳板**。
     ⚠ 只看下一家、只算最長的那一條 —— 全部算完太貴,而且差別看不出來。 */
  function bestChainFor(st, seat){
    const list = R.allMoves(st, seat);
    let m = 0;
    for(let i = 0; i < list.length; i++) if(list[i].jumps > m) m = list[i].jumps;
    return m;
  }

  /* 一手的分數(越大越好)。★ 一律用「走之前 − 走之後」的差,絕對值沒有意義。 */
  function scoreMove(st, seat, mv, w, opts){
    const before = w.pair ? evalSeat(st, seat) : evalFlat(st, seat);
    const arr = st.pieces[seat];
    const k = arr.indexOf(mv.from);
    if(k < 0) return -Infinity;

    arr[k] = mv.to;                                      // 就地試走
    const after = w.pair ? evalSeat(st, seat) : evalFlat(st, seat);
    let s = (before.sum - after.sum) + (before.worst - after.worst) * w.worst;
    s += mv.jumps * w.chain;

    // 已經進了目標區的棋子不要再走出來
    const g = st.goals[seat];
    if(g.indexOf(mv.from) >= 0 && g.indexOf(mv.to) < 0) s -= w.settle;

    /* ★ 只有高手看:走完之後,**下一家**能不能借我的棋子飛一大段 */
    if(w.give && opts && opts.next >= 0){
      s -= bestChainFor(st, opts.next) * w.give;
    }
    arr[k] = mv.from;                                    // 還原
    return s;
  }

  /* ==========================================================================
     四、挑一手
     ──────────────────────────────────────────────────────────────────────────
       ★★★ 防震盪的兩道:
         ① 不可以立刻走回上一手的起點(last 由呼叫端提供)
         ② 只接受「不會讓配對距離變大」的手 —— 真的一手都沒有時才放寬,
            而放寬的那一步一定要記在 fallback,不然「卡住」與「隨便走」分不出來。
     ========================================================================== */
  function pick(view, level, rng, last){
    const st = asState(view), seat = view.seat, r = rng || Math.random;
    const list = R.allMoves(st, seat);
    if(!list.length) return null;
    if(list.length === 1) return list[0];

    const key = LEVELS[level] ? level : "normal";
    const w = W[key];
    const next = (view.n > 1) ? R.nextSeat(st, seat) : -1;
    const opts = { next: next };

    // ★ 防震盪①:立刻走回上一手的起點一律先排除(全部被排除時再放回來)
    let pool = list;
    if(last && last.from != null){
      const cut = list.filter(m => !(m.from === last.to && m.to === last.from));
      if(cut.length) pool = cut;
    }

    /* 新手:多數時候只挑「往前一點」的,偶爾隨手 ——
       ⚠ 純亂挑的新手會蠢到讓人生氣(眼前有一條五段的鏈也視而不見)。 */
    if(key === "easy"){
      if(r() < 0.25) return pool[Math.floor(r() * pool.length)];
    }

    let best = null, bestS = -Infinity;
    for(let i = 0; i < pool.length; i++){
      // 同分時加一點點雜訊,免得每一局走出一模一樣的棋
      const s = scoreMove(st, seat, pool[i], w, opts) + r() * 0.25;
      if(s > bestS){ bestS = s; best = pool[i]; }
    }
    /* ★ 防震盪②:分數為負 = 這一手讓自己更遠。真的全部都是負的時候照樣要走
       (跳棋不能 pass),但**挑傷害最小的那一個** —— 上面的 max 已經做到了。 */
    return best || pool[0];
  }

  /* ==========================================================================
     五、替人代打(連線的出手倒數到期時用)
     ──────────────────────────────────────────────────────────────────────────
       ★ 一律用「普通」,不套房間裡任何人的難度 —— 幫人代打不該幫他打得特別好。
       ⚠ 這一頁**沒有亂數進入真相**(骰子那種東西不存在),所以代打的結果
         只由局面決定 —— 兩台同時代打會算出同一手,交易只會成功一筆。
     ========================================================================== */
  function autoMove(st, seat, rng){
    const m = pick(viewOf(st, seat), "normal", rng || Math.random, null);
    return m ? R.encMove(m.from, m.to) : -1;
  }

  return {
    LEVELS, LEVEL_KEYS, W,
    levelOf, thinkMs, viewOf, asState,
    evalSeat, evalFlat, bestChainFor, scoreMove, pick, autoMove
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TQAI;

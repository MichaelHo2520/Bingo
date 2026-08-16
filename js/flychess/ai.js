"use strict";

/* ============================================================================
   飛行棋 — 電腦對手(FCAI)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。

   ── ★★ 「不作弊」在這一頁是結構上的,而且理由與別的遊戲不同 ─────────────────
     飛行棋是十三個遊戲裡**唯一完全沒有隱藏資訊**的一個:誰在哪一格是桌上人人看得見的
     事實,所以沒有「AI 偷看手牌」這種問題(排七 / 台灣麻將 / 暗棋各有一套 view 濾網,
     這一頁不需要)。
     ⚠ 真正要守的是**另一件事:AI 不可以看到未來的骰子。**
       這一頁刻意不用決定性 PRNG(理由見 rules.js 檔頭②)—— 點數住在 moves 裡,
       是「擲下去的那一刻」才存在的,所以 AI 連預測的入口都沒有。
       ⚠ 誰哪天把骰子改成 hash(seed, 第幾次) 算出來,這條保證會**當場消失**
         (而且畫面上完全看不出來:電腦只是忽然變得很會挑飛機)。

   ── 三個難度是「看得出行為差異」,不是「誰比較會贏」──────────────────────
     飛行棋的運氣成分很高,策略天花板不高(同 UNO 的結論,notes/18)——
     硬把 hard 調成「一定贏」只會變成玩家覺得電腦在作弊。所以三級的差異做成**看得出來**的:
       🙂 新手:幾乎隨手挑,只有很明顯的踩人才會抓
       🤔 普通:會踩人、會搶跳 / 飛、會推最前面那架回家
       😈 高手:再加上**看得懂危險** —— 不把飛機停在對手一擲就踩得到的格子上,
                自己被瞄準時會先逃(這是兩級之間唯一真正看得出來的差別)
   ========================================================================== */

const FCAI = (function(){

  const R = (typeof FC !== "undefined") ? FC : require("./rules.js");

  /* ==========================================================================
     一、難度
     ========================================================================== */
  const LEVELS = {
    easy:   { key:"easy",   emoji:"🙂", name:"新手", desc:"隨手挑一架,只有很明顯的踩人才抓得到", ms:[420, 780] },
    normal: { key:"normal", emoji:"🤔", name:"普通", desc:"會踩人、會搶跳與航線、會把最前面那架推回家", ms:[520, 950] },
    hard:   { key:"hard",   emoji:"😈", name:"高手", desc:"還看得懂危險:不停在會被踩的格子上,被瞄準就先逃", ms:[620, 1150] }
  };
  const LEVEL_KEYS = ["easy", "normal", "hard"];
  function levelOf(k){ return LEVELS[k] || LEVELS.normal; }
  function thinkMs(k, rng){
    const m = levelOf(k).ms, r = rng || Math.random;
    return Math.round(m[0] + r() * (m[1] - m[0]));
  }

  /* 權重表 —— 三級的差別全部寫在這裡,一眼看得出誰多看了什麼。
     ⚠ 加新的評分項要三級都列一行(留 0 也要列),不然「這一級到底看不看這件事」
       只能靠讀程式碼推。 */
  const W = {
    easy:   { eat: 60, goal: 10, lane: 0,  bonus: 0,  launch: 5,  step: 0.2, danger: 0,  escape: 0,  lead: 0 },
    normal: { eat: 120, goal: 70, lane: 30, bonus: 3,  launch: 25, step: 0.6, danger: 0,  escape: 0,  lead: 0.4 },
    hard:   { eat: 120, goal: 75, lane: 34, bonus: 3.2, launch: 22, step: 0.6, danger: 16, escape: 11, lead: 0.5 }
  };

  /* ==========================================================================
     二、view —— 這一頁沒有東西要濾
     ──────────────────────────────────────────────────────────────────────────
       留這一支是為了與另外四個遊戲的介面一致(solo.js / adapter.js 兩邊都叫它),
       而且**它是將來真的需要濾東西時唯一該改的地方**。
       ⚠ 它回傳的是一份拷貝:AI 再怎麼寫都動不到真正的 st。
     ========================================================================== */
  function viewOf(st, seat){
    return {
      n: st.n, seat: seat, rules: st.rules,
      colors: st.colors.slice(),
      planes: st.planes.map(r => r.slice()),
      die: st.die, turn: st.turn, over: st.over
    };
  }
  // view → 一份可以問規則的 st(規則層的函式吃的是 st 的形狀)
  function asState(v){
    return { n: v.n, rules: v.rules, colors: v.colors, planes: v.planes.map(r => r.slice()),
             turn: v.turn, die: v.die, sixes: 0, over: false, winner: -1, last: null, bad: -1 };
  }

  /* ==========================================================================
     三、評分
     ========================================================================== */
  function scoreMove(st, seat, L, w){
    const q0 = st.planes[seat][L.plane];
    const die = st.die;
    let s = 0;

    // 踩人:對手那一架整個回機場,是這個遊戲最大的一筆
    const eat = R.eatCount(st, seat, L);
    s += eat * w.eat;

    // 到家 / 進跑道
    if(L.to >= R.GOAL) s += w.goal;
    else if(L.to > R.RING) s += w.lane;

    // 跳 / 飛白賺的格數
    const plain = (q0 === 0) ? 1 : Math.min(q0 + die, R.GOAL);
    s += Math.max(0, L.to - plain) * w.bonus;

    // 起飛(場上有飛機才有得玩)
    if(q0 === 0) s += w.launch;

    s += (L.to - q0) * w.step;
    // 推最前面那架:同樣的進度,集中在一架身上比較快到家
    s += (q0 / R.GOAL) * w.lead * 10;

    /* ★ 只有高手看得懂的兩件事(w.danger / w.escape 為 0 時整段等於沒有) */
    if(w.danger){
      s -= R.riskAt(st, seat, L.to) * w.danger;
      s += R.riskAt(st, seat, q0) * w.escape;      // 從危險格逃走有加分
    }
    return s;
  }

  /* 挑一架。回傳 plane index;沒得走回 -1(呼叫端應該根本不會走到這裡)。 */
  function pick(view, level, rng){
    const st = asState(view), seat = view.seat, r = rng || Math.random;
    const list = R.legalMoves(st, seat);
    if(!list.length) return -1;
    if(list.length === 1) return list[0].plane;

    const key = LEVELS[level] ? level : "normal";
    const w = W[key];

    /* 新手:先看有沒有「很明顯」的踩人(踩得到就抓),其餘隨手挑 ——
       ⚠ 純亂挑的新手會蠢到讓人生氣(對手飛機就停在眼前也視而不見)。 */
    if(key === "easy"){
      const eats = list.filter(m => R.eatCount(st, seat, m) > 0);
      if(eats.length && r() < 0.55) return eats[Math.floor(r() * eats.length)].plane;
      return list[Math.floor(r() * list.length)].plane;
    }

    let best = null, bestS = -Infinity;
    for(let i = 0; i < list.length; i++){
      // 同分時加一點點雜訊,免得每一局都走出一模一樣的棋
      const s = scoreMove(st, seat, list[i], w) + r() * 0.4;
      if(s > bestS){ bestS = s; best = list[i]; }
    }
    return best ? best.plane : list[0].plane;
  }

  /* ==========================================================================
     四、替人代打(連線的出手倒數到期時用)
     ──────────────────────────────────────────────────────────────────────────
       ★ 一律用「普通」,不套房間裡任何人的難度 —— 幫人代打不該幫他打得特別好。
       ⚠ 擲骰那一半會用到亂數,而**它就是這一手的真值**(會寫進 moves)——
         這是這一頁唯二准用 Math.random() 的地方之一(另一個是玩家自己按擲骰)。
     ========================================================================== */
  function autoMove(st, seat, rng){
    const r = rng || Math.random;
    if(!st.die) return R.encRoll(1 + Math.floor(r() * 6));
    const p = pick(viewOf(st, seat), "normal", r);
    return p < 0 ? -1 : R.encMove(p);
  }

  return {
    LEVELS, LEVEL_KEYS, W,
    levelOf, thinkMs, viewOf, asState, scoreMove, pick, autoMove
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FCAI;

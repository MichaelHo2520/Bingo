"use strict";

/* ============================================================================
   泡泡對戰 — 電腦對手(BUBAI)
   ★ 純函式,零 DOM、零 Firebase(與另外十七支 AI / 規則同一條紅線)。
     它只做兩件事:①「這一發該往哪裡射、要不要先換顆」②「照那個決定,這一幀怎麼轉」。

   ── 怎麼選 ────────────────────────────────────────────────────────────────
     把 (目前這顆 / 換成下一顆) × 72 個角度全部用 BUB.trace() 真的飛一次,
     在複製的盤面上 BUB.resolve() 算消除與掉落,再依下面幾件事打分:
       · 消掉幾顆、打掉幾顆(掉落的權重比較高 —— 那才是打斷一大串)
       · 沒消到時:黏在幾顆同色旁邊(為下一發鋪路)
       · 離死亡線多近(落點太低、或整盤最低那一列太低都扣分)

   ── ★★★ 四條會直接做錯的事 ───────────────────────────────────────────────
     ① **角度一定要走 trace(),不可以自己算落點。** trace 與真的飛行共用同一個
        步進函式(rules.js 紅線 ②)—— 自己算一份就是第二份真相,
        電腦會瞄著一格、射進隔壁,看起來像「電腦很笨」而不是程式錯。
     ② **難度主要靠「每分鐘射幾發」與「會不會打反彈球」,不是把評分改爛**
        (同方塊對戰的 AI 紅線 ②):評分改爛的電腦會做出人類看得懂的蠢事。
     ③ **決定一次就記住(mem.target),而且要慢慢轉過去。** 瞬間轉到定位的話,
        對手小盤上的發射器會「跳格」,而「他在瞄哪裡」正是看對手的樂趣。
     ④ **飛行中不可以做決定** —— 盤面還沒落定,算出來的都是錯的。
   ========================================================================== */

const BUBAI = (function(){

  const R = (typeof BUB !== "undefined") ? BUB : require("./rules.js");

  const N_ANG = 72;

  /* 三個難度。★ spm = 每分鐘射幾發;bounce = 最多肯打幾次反彈的球。
     「新手」不打反彈球 —— 那是人類新手最明顯的特徵,看起來很自然。 */
  const LEVELS = [
    { key: "easy", name: "新手", emoji: "🙂", spm: 13, noise: 3.0, blunder: 0.30, bounce: 0, turn: 0.0016,
      desc: "射得慢、只打直球,常常亂塞 —— 第一次玩的人也贏得了" },
    { key: "norm", name: "普通", emoji: "😎", spm: 22, noise: 1.0, blunder: 0.10, bounce: 1, turn: 0.0028,
      desc: "穩穩地消,會打一次反彈的角度球,也會還手" },
    { key: "hard", name: "高手", emoji: "🔥", spm: 34, noise: 0.2, blunder: 0.0, bounce: 2, turn: 0.0045,
      desc: "手很快、專挑能打斷一大串的位置 —— 不先學會抵銷會被塞滿" }
  ];
  function levelOf(k){
    for(let i = 0; i < LEVELS.length; i++) if(LEVELS[i].key === k) return LEVELS[i];
    return LEVELS[1];
  }

  /* 一顆顏色 c 從角度 a 射出去值多少分(不含雜訊)。回傳 null = 不能這樣射 */
  function evalShot(board, par, a, c, lv){
    const t = R.trace(board, par, a);
    if(!t.cell) return null;
    if(lv && t.bounce > lv.bounce) return null;
    const x = t.cell[0], y = t.cell[1];
    const b = board.map(r => r.slice());
    // 先數鄰居(resolve 會把消掉的格子清掉)
    let same = 0, diff = 0;
    R.neighbors(par, x, y).forEach(p => {
      const v = board[p[1]][p[0]];
      if(!v) return;
      if(v === c) same++; else diff++;
    });
    const r = R.resolve(b, par, x, y, c);
    let s = 0;
    if(r.pops.length){
      s += 6 + r.pops.length * 2 + r.drops.length * 3.5;
    }else{
      s += same * 1.6 - diff * 0.25;
      if(y >= R.DEAD - 1) s -= 60;      // 貼著死亡線又沒消到 = 自殺
    }
    const low = R.lowest(b);
    if(low >= R.DEAD - 3) s -= (low - (R.DEAD - 4)) * 4;
    s += y * 0.15;                      // 同分時偏好往上塞(把低處留空)
    return { s: s, cell: t.cell, pops: r.pops.length, drops: r.drops.length };
  }

  /* 挑一發:回傳 { a, swap } 或 null(沒有任何角度打得到 —— 幾乎不可能) */
  function best(st, lv, rnd){
    rnd = rnd || Math.random;
    lv = lv || LEVELS[1];
    const cands = [];
    const tries = (st.next !== st.cur) ? [false, true] : [false];
    for(let si = 0; si < tries.length; si++){
      const sw = tries[si];
      const c = sw ? st.next : st.cur;
      for(let i = 0; i < N_ANG; i++){
        const a = -R.MAX_AIM + (2 * R.MAX_AIM) * (i + 0.5) / N_ANG;
        const e = evalShot(st.board, st.par, a, c, lv);
        if(!e) continue;
        let s = e.s - (sw ? 0.3 : 0) - Math.abs(a) * 0.05;
        if(lv.noise) s += (rnd() - 0.5) * 2 * lv.noise;
        cands.push({ a: a, swap: sw, s: s });
      }
    }
    if(!cands.length) return null;
    cands.sort((p, q) => q.s - p.s);
    /* 失誤是「挑第二好的」,不是挑最爛的(同方塊對戰)。
       ⚠ 第二好要跳過「幾乎一樣的角度」—— 相鄰角度常常落在同一格,那不算失誤。 */
    let pick = 0;
    if(lv.blunder && cands.length > 1 && rnd() < lv.blunder){
      for(let i = 1; i < cands.length; i++){
        if(Math.abs(cands[i].a - cands[0].a) > 0.12 || cands[i].swap !== cands[0].swap){ pick = i; break; }
      }
    }
    return { a: cands[pick].a, swap: cands[pick].swap };
  }

  /* ==========================================================================
     控制器:mem = { target, k, t } —— 呼叫端每台電腦各保管一份。
       回傳事件陣列(發射那一刻的 fire 事件;落地的 land 由 BUB.tick 產生)。
     ========================================================================== */
  function newMem(){ return { target: null, k: -1, t: 0, swapped: false }; }

  function step(st, mem, dt, lv, rnd){
    if(!st || st.dead || st.shot) return [];          // ⚠ 紅線 ④ · 早退也要回陣列
    lv = lv || LEVELS[1];
    if(!mem.target || mem.k !== st.shots){
      mem.target = best(st, lv, rnd);
      mem.k = st.shots;
      mem.swapped = false;
    }
    mem.t += dt;
    const tg = mem.target;
    if(!tg) return [];
    // 慢慢轉過去(紅線 ③)
    const d = tg.a - st.aim, lim = lv.turn * dt;
    R.aim(st, st.aim + (Math.abs(d) <= lim ? d : Math.sign(d) * lim));
    const iv = 60000 / Math.max(6, lv.spm);
    if(mem.t < iv || Math.abs(tg.a - st.aim) > 1e-6) return [];
    if(tg.swap && !mem.swapped){ R.swap(st); mem.swapped = true; }
    mem.t = 0;
    const ev = R.fire(st);
    mem.target = null;
    return ev ? [ev] : [];
  }

  return { LEVELS, levelOf, N_ANG, evalShot, best, newMem, step };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = BUBAI;

"use strict";

/* ============================================================================
   飛行棋 — 規則引擎(FC)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/sevens/rules.js、js/uno/rules.js:「這一手合不合法」「這局誰贏」
     只有靠 node 大量對局才驗得出來,碰了一行 DOM 就只能在瀏覽器裡手動玩。

   ── 玩法(規則來源見 notes/22)────────────────────────────────────────────
     2~4 人,每人 2~4 架飛機(房規)。外圈 52 格,每人一條 6 格的回家跑道 + 中央終點。
     輪到你先擲骰,再選一架飛機走。
       • 起飛:飛機停在機場,要擲到 6(或房規開「1 或 6」)才出得來,落在自家起飛點。
       • 跳:走完停在**自己顏色**的格子 → 再前進 4 格(剛好是下一個自家色格)。
       • 飛:停在自家**航線格**(進度 17)→ 直飛 12 格,落點又是自家色 → 再跳 4 格(合計 +16)。
       • 踩:停下來的那一格上有別人的飛機 → 那些飛機**全部回機場**(自己人可以疊)。
       • 擲到 6 可以再擲一次;但**連續三次 6 這一輪作廢**,直接換人(防止一個人打不完)。
       • 終點要不要剛好由房規決定(預設「超過就算到」)。
       • 先把**房規指定的架數**送到終點的人贏,其餘依「到家架數 → 總進度」排名次。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 盤面幾何(純資料:環格 / 跑道 / 機場 / 終點的格子座標)—— 給 board.js 查表
     • legalMoves():擲出這個點數,哪幾架飛機動得了、會停在哪
     • replay():從 rules + moves 重算一整局的真相  ★ 唯一的真相入口
     • score():名次與名次分
   不負責:AI(ai.js)、畫面(board.js)、輪次驅動(solo.js / adapter.js)。

   ── ★★★ 三條會直接做錯的事 ───────────────────────────────────────────────
     ① **turn 絕不可以用 moves.length 取模。** 擲到 6 會**再擲一次**(回合停在同一個
        人身上,同暗棋的連吃),而且一手是「擲」+「走」兩筆 move、沒得走時只有一筆。
        一律問 replay 出來的 st.turn。
     ② **骰子的點數住在 moves 裡,不是算出來的。** 這一頁刻意**不用**決定性 PRNG
        (UNO 重洗那一套)—— 用了的話每台裝置都算得出未來的點數,等於憑空長出
        一條「可以偷看」的紅線,而飛行棋本來是十三個遊戲裡唯一完全沒有隱藏資訊的。
        Math.random() 只准出現在「擲骰的那一刻」(solo.js / adapter.js 各一處)。
     ③ **跳 / 飛不可以連鎖。** 跳 4 格的落點一定又是自家色(4 是色循環週期),
        無條件再跳就是無窮迴圈。規則是:走完只結算一次特效,而「飛」可以接一次「跳」。
   ========================================================================== */

const FC = (function(){

  /* ==========================================================================
     一、常數與盤面幾何
     ──────────────────────────────────────────────────────────────────────────
       ★ 幾何是**純資料**:board.js 只查表,一格都不自己算 —— 規則與畫面因此完全脫鉤
         (盤面要重畫時 rules.js 一行都不必動)。
       盤面是 14×14 的格子:最外圈整整一圈剛好 52 格,四個角落區塊是機場,
       四條回家跑道從每一邊的中央往內走 5 格,正中央 2×2 是終點。
       ⚠⚠ **格數是 14 不是 15。** 一圈的格數 = 4×邊長−4,要湊到 52 只有邊長 14
         (15×15 會是 56 格,而 56 拆成四段是 14 格一段 → 14 mod 4 = 2,
          四家的「自家色」會兩兩重疊,「跳」就會跳到別人的顏色上)。
       ⚠ 14 是偶數 → 沒有正中央那一格,所以終點刻意做成 2×2 的區塊(座標回 6.5)。
     ========================================================================== */
  const GRID = 14;
  const RING = 52;                    // 外圈格數(整整一圈:4×14−4)
  const LANE = 5;                     // 回家跑道長度
  const GOAL = RING + LANE + 1;       // 58 = 終點(中央)
  const NCOLOR = 4;
  const MIN_PLANES = 2, MAX_PLANES = 4;
  const MIN_PLAYERS = 2, MAX_PLAYERS = 4;

  /* 各顏色的起飛點(外圈 index)。
     ★ 這四個數字不是隨便挑的:它們必須讓「進度 q 是不是自家顏色」對四家同時成立。
       外圈格 i 的顏色定義成 (i-7) mod 4,而 START 兩兩相差 13(13 mod 4 = 1)
       → START[c] mod 4 剛好 = c,於是自家色格 ⟺ (q-1) mod 4 === 0(四家共用同一條式子)。
     ⚠ 動 START 或 RING 之前先確認這個對齊還在,不然「跳」會跳到別人的顏色上。 */
  const START = [7, 20, 33, 46];

  const FLY_Q = 17;                   // 航線格(自家進度)。(17-1)%4===0 → 一定是自家色
  const FLY_N = 12;                   // 飛幾格
  const JUMP_N = 4;                   // 跳幾格(= 顏色循環的週期)

  /* 2 人局用對角的兩色(紅 / 藍),盤面才不會擠在同一邊 */
  const SEAT_COLOR = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
  const COLOR_KEY  = ["r", "y", "b", "g"];
  const COLOR_NAME = ["紅", "黃", "藍", "綠"];

  function colorOfSeat(n, seat){
    const map = SEAT_COLOR[n] || SEAT_COLOR[4];
    return map[seat] != null ? map[seat] : seat;
  }

  /* 外圈 index → 格子座標。順時針,從左上角起算。
     ⚠ 每一步都必須是**正交**相鄰(轉角不可以斜跨)—— 斜跨的話「走 N 格」在畫面上
       會少一步,而玩家是照著格子數的。守門在 test-fc-rules 的 A 節。 */
  function ringXY(i){
    i = ((i % RING) + RING) % RING;
    if(i < 14) return { x: i, y: 0 };                      // 上緣 (0,0)…(13,0)
    if(i < 27) return { x: 13, y: i - 13 };                // 右緣 (13,1)…(13,13)
    if(i < 40) return { x: 13 - (i - 26), y: 13 };         // 下緣 (12,13)…(0,13)
    return { x: 0, y: 13 - (i - 39) };                     // 左緣 (0,12)…(0,1)
  }
  // 外圈格的顏色(0..3);與 START 的對齊見上面那段註解
  function colorAt(i){ return ((((i - START[0]) % NCOLOR) + NCOLOR) % NCOLOR); }

  /* 回家跑道:從自己那一邊的中央往中心走 5 格。
     ⚠ 跑道第一格一定要貼著「進度 52 那一格」,不然轉不進去(A 節有守門)。 */
  const LANE_HEAD = [{ x: 6, y: 1 }, { x: 12, y: 6 }, { x: 7, y: 12 }, { x: 1, y: 7 }];
  const LANE_DIR  = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }];
  function laneXY(color, k){
    const h = LANE_HEAD[color], d = LANE_DIR[color];
    return { x: h.x + d.x * k, y: h.y + d.y * k };
  }

  /* 機場:四個角落的 5×5 區塊,裡面 2×2 擺四架。
     ★ 位置刻意選在「自己起飛之後前進的方向」那個角落 —— 一出機場就往自家角落跑,
       盤面上看得出來每一家是誰。 */
  const HANGAR = [{ x: 8, y: 1 }, { x: 8, y: 8 }, { x: 1, y: 8 }, { x: 1, y: 1 }];
  function hangarXY(color, k){
    const h = HANGAR[color];
    return { x: h.x + 1 + (k % 2) * 2, y: h.y + 1 + Math.floor(k / 2) * 2 };
  }
  // ⚠ 14 是偶數 → 中心落在格線上,終點是 (6,6)-(7,7) 那個 2×2 區塊的中點
  const GOAL_XY = { x: 6.5, y: 6.5 };

  /* 進度 → 座標。★ board.js 唯一該叫的那一支。
     ⚠ plane 只有停在機場時才用得到(決定停哪一格),其他情況傳什麼都一樣。 */
  function posXY(color, q, plane){
    if(q <= 0) return hangarXY(color, plane || 0);
    if(q <= RING) return ringXY(absOf(color, q));
    if(q < GOAL) return laneXY(color, q - RING - 1);
    return { x: GOAL_XY.x, y: GOAL_XY.y };
  }
  // 進度(自己數的)→ 外圈的絕對 index(全桌共用的座標系,吃子就靠它)
  function absOf(color, q){ return (START[color] + q - 1) % RING; }

  // 這個進度是不是「自己顏色的外圈格」
  function isOwnColor(q){ return q >= 1 && q <= RING && (q - 1) % NCOLOR === 0; }

  /* ==========================================================================
     二、房規
     ──────────────────────────────────────────────────────────────────────────
       ★ 一局開打的那一刻就凍結(比照 21 點):中途改房規會讓已經走到一半的
         局面前後不一致,而 replay 是拿「現在的房規」重跑整局的 —— 房規一變,
         同一份 moves 會 replay 出完全不同的盤面。
     ========================================================================== */
  const DEF_RULES = { planes: 2, launch: "one6", goal: 0, exact: false };

  // 收斂成合法值。★ 舊房間 / 手改 DB 的怪值一律退回預設,不可以讓 replay 炸掉
  function normRules(r){
    const o = r || {};
    const planes = clamp(+o.planes || DEF_RULES.planes, MIN_PLANES, MAX_PLANES);
    const launch = (o.launch === "six") ? "six" : "one6";
    // goal 0 或超過架數 = 全部到家
    let goal = +o.goal || 0;
    if(!(goal >= 1 && goal < planes)) goal = planes;
    return { planes: planes, launch: launch, goal: goal, exact: !!o.exact };
  }
  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
  function canLaunch(die, rules){ return die === 6 || (rules.launch === "one6" && die === 1); }

  /* ==========================================================================
     三、一手怎麼走 —— 跳 / 飛的結算
     ──────────────────────────────────────────────────────────────────────────
       ★ 只結算一次特效,而且「飛」可以接一次「跳」。無條件連鎖是無窮迴圈
         (跳 4 格的落點一定又是自家色 —— 4 就是顏色的循環週期)。
       ★ 特效**不可以把飛機推出外圈**:超過 52 就不套用(不然「跳」會把人硬塞進
         回家跑道,而那條跑道的長度是規則的一部分,不是可以跳過去的)。
       回傳 null = 這一手不合法(只可能是「要剛好」而點數太大)。
     ========================================================================== */
  function landing(q0, die, rules){
    let q = q0 + die;
    const hops = [];
    if(q > GOAL){
      if(rules.exact) return null;      // 要剛好 → 走不了
      q = GOAL;                         // 超過就算到
    }
    hops.push({ kind: "walk", to: q });
    if(q === FLY_Q){
      const t = q + FLY_N;
      if(t <= RING){
        q = t; hops.push({ kind: "fly", to: q });
        if(isOwnColor(q) && q + JUMP_N <= RING){ q += JUMP_N; hops.push({ kind: "jump", to: q }); }
      }
    }else if(isOwnColor(q)){
      const t = q + JUMP_N;
      if(t <= RING){ q = t; hops.push({ kind: "jump", to: q }); }
    }
    return { to: q, hops: hops };
  }

  /* 擲出 die 之後,這一家有哪幾架動得了。空陣列 = 沒得走,這一輪結束。
     ⚠ 起飛**不套特效**:進度 1 本身是自家色((1-1)%4===0),照走一次「跳」的話
       每一架一出機場就先送 4 格 —— 那不是規則,是這條式子的副作用。 */
  function legalMoves(st, seat){
    const out = [], d = st.die;
    if(!d || st.over) return out;
    const P = st.planes[seat];
    for(let i = 0; i < P.length; i++){
      const q = P[i];
      if(q >= GOAL) continue;                       // 已經到家的不再動
      if(q === 0){
        if(canLaunch(d, st.rules)) out.push({ plane: i, to: 1, hops: [{ kind: "launch", to: 1 }] });
        continue;
      }
      const L = landing(q, d, st.rules);
      if(L) out.push({ plane: i, to: L.to, hops: L.hops });
    }
    return out;
  }

  /* ==========================================================================
     四、replay —— ★ 一整局唯一的真相入口
     ──────────────────────────────────────────────────────────────────────────
       moves 的編碼(一手一個整數,與五子棋 / 排七同構):
         1..6   = 擲出這個點數
         10..13 = 走第 (n-10) 架飛機
       ⚠ 一「輪」不一定是兩筆:沒得走的時候只有一筆(擲),replay 自己換人。
     ========================================================================== */
  const MV_MOVE0 = 10;
  const encRoll = d => d;
  const encMove = i => MV_MOVE0 + i;
  const isRoll  = mv => mv >= 1 && mv <= 6;
  const moveIdx = mv => mv - MV_MOVE0;

  function blank(n, rules){
    const R = normRules(rules), planes = [], colors = [];
    for(let s = 0; s < n; s++){
      const row = [];
      for(let i = 0; i < R.planes; i++) row.push(0);
      planes.push(row);
      colors.push(colorOfSeat(n, s));
    }
    return {
      n: n, rules: R, colors: colors, planes: planes,
      turn: 0, die: 0, sixes: 0,
      over: false, winner: -1, last: null, bad: -1
    };
  }

  const homeCount = (st, s) => st.planes[s].filter(q => q >= GOAL).length;
  const progressOf = (st, s) => st.planes[s].reduce((a, q) => a + q, 0);

  /* 下一個出手的人。⚠ 這是唯一決定 turn 的地方 —— 呼叫端一律不准自己算。
     (贏家出現時整局就結束了,所以不必跳過「已經全部到家」的人;
      仍然留一道保險:萬一房規改成不會結束的組合,也不會無窮迴圈。) */
  function nextSeat(st, from){
    for(let k = 1; k <= st.n; k++){
      const s = (from + k) % st.n;
      if(st.planes[s].some(q => q < GOAL)) return s;
    }
    return from;
  }
  function endTurn(st){ st.die = 0; st.sixes = 0; st.turn = nextSeat(st, st.turn); }

  /* 套用「走一架」。★ 吃子只看**停下來的那一格**,飛越過去的不算(同真實飛行棋)。 */
  function applyMove(st, seat, L){
    const eaten = [];
    st.planes[seat][L.plane] = L.to;
    if(L.to >= 1 && L.to <= RING){
      const abs = absOf(st.colors[seat], L.to);
      for(let s = 0; s < st.n; s++){
        if(s === seat) continue;                    // 自己人可以疊
        const P = st.planes[s];
        for(let j = 0; j < P.length; j++){
          if(P[j] >= 1 && P[j] <= RING && absOf(st.colors[s], P[j]) === abs){
            P[j] = 0; eaten.push({ seat: s, plane: j });
          }
        }
      }
    }
    st.last = { kind: "move", seat: seat, plane: L.plane, to: L.to, hops: L.hops, eaten: eaten,
                home: L.to >= GOAL };
    if(homeCount(st, seat) >= st.rules.goal){ st.over = true; st.winner = seat; }
    return eaten;
  }

  /* 套用一手。回 true = 成功;false = 不合法(呼叫端要中止,不可以硬套下去)。 */
  function step(st, mv){
    if(st.over) return false;
    const seat = st.turn;

    if(!st.die){
      if(!isRoll(mv)) return false;
      st.die = mv;
      st.sixes = (mv === 6) ? st.sixes + 1 : 0;
      st.last = { kind: "roll", seat: seat, die: mv };
      // ★ 連三 6 這一輪作廢 —— 少了它,運氣好的人可以一個人打到底
      if(st.sixes >= 3){ st.last.voided = true; endTurn(st); return true; }
      if(!legalMoves(st, seat).length){ st.last.stuck = true; endTurn(st); return true; }
      return true;
    }

    const idx = moveIdx(mv);
    if(!(idx >= 0 && idx < st.planes[seat].length)) return false;
    const list = legalMoves(st, seat);
    let L = null;
    for(let i = 0; i < list.length; i++) if(list[i].plane === idx){ L = list[i]; break; }
    if(!L) return false;

    const again = (st.die === 6);
    applyMove(st, seat, L);
    if(st.over) return true;
    // ★ 擲到 6 → 回合**停在同一個人身上**(sixes 不歸零,連三次才作廢)
    if(again){ st.die = 0; return true; }
    endTurn(st);
    return true;
  }

  function replay(rules, n, moves){
    if(!(n >= MIN_PLAYERS && n <= MAX_PLAYERS)) return null;
    const st = blank(n, rules);
    const list = Array.isArray(moves) ? moves : [];
    for(let i = 0; i < list.length; i++){
      if(!step(st, list[i])){ st.bad = i; break; }    // 不合法就停在這裡,不硬套
    }
    return st;
  }

  /* ==========================================================================
     五、結算
     ──────────────────────────────────────────────────────────────────────────
       第一名 = 先達標的人;其餘依「到家架數 → 總進度」排。
       ★ 名次分吃核心的 winner.pts(大老二加進去的能力),所以**不必等最後一名**
         慢慢爬回家 —— 這正是這個遊戲不冷場的關鍵(見 notes/22)。
     ========================================================================== */
  const PTS = { 2: [2, 0], 3: [3, 1, 0], 4: [5, 3, 1, 0] };
  function ptsForRank(rank, n){
    const t = PTS[n] || PTS[4];
    return t[clamp(rank, 1, t.length) - 1];
  }

  function score(st){
    const rows = [];
    for(let s = 0; s < st.n; s++){
      rows.push({
        seat: s, color: st.colors[s],
        home: homeCount(st, s), prog: progressOf(st, s),
        first: st.winner === s, rank: 0, pts: 0
      });
    }
    // 贏家一定是第一名(他可能總進度不是最高 —— 房規只算「到家幾架」)
    const sorted = rows.slice().sort((a, b) =>
      (b.first - a.first) || (b.home - a.home) || (b.prog - a.prog) || (a.seat - b.seat));
    let rk = 0;
    sorted.forEach((r, i) => {
      const p = i ? sorted[i - 1] : null;
      if(!p || p.first !== r.first || p.home !== r.home || p.prog !== r.prog) rk = i + 1;
      r.rank = rk;
      r.pts = ptsForRank(rk, st.n);
    });
    return { rows: rows, sorted: sorted, winners: sorted.filter(r => r.rank === 1).map(r => r.seat) };
  }

  /* ==========================================================================
     六、小工具(畫面與 AI 共用)
     ========================================================================== */
  // 這一格上有誰(給盤面畫疊機用)。回 [{seat, plane}]
  function occupants(st, absIdx){
    const out = [];
    for(let s = 0; s < st.n; s++){
      const P = st.planes[s];
      for(let j = 0; j < P.length; j++)
        if(P[j] >= 1 && P[j] <= RING && absOf(st.colors[s], P[j]) === absIdx) out.push({ seat: s, plane: j });
    }
    return out;
  }
  // 走這一手會踩掉幾架(AI 與提示共用;不改變 st)
  function eatCount(st, seat, L){
    if(!(L.to >= 1 && L.to <= RING)) return 0;
    const abs = absOf(st.colors[seat], L.to);
    let k = 0;
    for(let s = 0; s < st.n; s++){
      if(s === seat) continue;
      const P = st.planes[s];
      for(let j = 0; j < P.length; j++)
        if(P[j] >= 1 && P[j] <= RING && absOf(st.colors[s], P[j]) === abs) k++;
    }
    return k;
  }
  // 這一格會不會被某個對手一擲就踩到(1..6);回傳「有幾個點數踩得到」
  function riskAt(st, seat, q){
    if(!(q >= 1 && q <= RING)) return 0;                 // 機場與回家跑道是安全的
    const abs = absOf(st.colors[seat], q);
    let risk = 0;
    for(let s = 0; s < st.n; s++){
      if(s === seat) continue;
      const P = st.planes[s];
      for(let j = 0; j < P.length; j++){
        const fq = P[j];
        if(!(fq >= 1 && fq <= RING)) continue;
        for(let d = 1; d <= 6; d++){
          const L = landing(fq, d, st.rules);
          if(L && L.to >= 1 && L.to <= RING && absOf(st.colors[s], L.to) === abs){ risk++; break; }
        }
      }
    }
    return risk;
  }
  // 一手的白話描述(toast / 播報共用;單機與連線兩邊都要用 → 放規則層才不會走鐘)
  function moveText(st, L){
    const h = L.hops || [];
    if(h.length && h[0].kind === "launch") return "起飛!";
    let s = "";
    for(let i = 1; i < h.length; i++){
      if(h[i].kind === "fly") s += "✈️ 飛 " + FLY_N + " 格";
      else if(h[i].kind === "jump") s += (s ? " + " : "") + "⤴️ 跳 " + JUMP_N + " 格";
    }
    if(L.to >= GOAL) s = (s ? s + " · " : "") + "🏁 到家了!";
    return s;
  }

  return {
    // 常數
    GRID, RING, LANE, GOAL, NCOLOR, START, FLY_Q, FLY_N, JUMP_N,
    MIN_PLANES, MAX_PLANES, MIN_PLAYERS, MAX_PLAYERS,
    COLOR_KEY, COLOR_NAME, SEAT_COLOR, DEF_RULES,
    // 幾何(純資料,board.js 查表用)
    ringXY, laneXY, hangarXY, posXY, absOf, colorAt, colorOfSeat, isOwnColor, GOAL_XY,
    // 房規
    normRules, canLaunch,
    // 規則
    landing, legalMoves,
    // 一局
    blank, step, replay, nextSeat, homeCount, progressOf,
    // 編碼
    encRoll, encMove, isRoll, moveIdx,
    // 結算
    score, ptsForRank,
    // 小工具
    occupants, eatCount, riskAt, moveText
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = FC;

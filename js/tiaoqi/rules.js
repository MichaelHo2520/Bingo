"use strict";

/* ============================================================================
   跳棋(中國跳棋 · 六角星)— 規則引擎(TQ)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/flychess/rules.js、js/sevens/rules.js:「這一手合不合法」「這局誰贏」
     只有靠 node 大量對局才驗得出來,碰了一行 DOM 就只能在瀏覽器裡手動玩。

   ── 玩法 ────────────────────────────────────────────────────────────────
     121 個洞的六角星,六個角各 10 個洞。每人佔一個角,目標是**正對面**那個角。
     一手擇一:
       • 單步 —— 往六個方向之一走到相鄰的空洞(走完就結束)
       • 跳   —— 越過**緊鄰的一顆棋**(敵我皆可)落到正後方的空洞,而且**可以連跳**
     不吃子、不打回、不淘汰 —— 棋子只會移動,不會消失。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 盤面幾何(純資料:121 個洞的立方座標、鄰接表、六個角的歸屬)
     • movesFrom() / allMoves():這一顆能走到哪(含連跳鏈的路徑)
     • replay():從 rules + moves 重算一整局的真相  ★ 唯一的真相入口
     • score():名次與名次分
   不負責:AI(ai.js)、畫面(board.js)、輪次驅動(solo.js / adapter.js)。

   ── ★★★ 四條會直接做錯的事 ───────────────────────────────────────────────
     ① **一手是「一顆棋的起點 + 終點」,連跳是一手之內的多段,不是多手。**
        所以 turn 與 moves.length 是一比一的(這一頁與暗棋 / 飛行棋**相反**,
        那兩頁的回合會停在同一個人身上)。仍然一律問 st.turn,理由見 replay 註解。
     ② **中間路徑不影響任何結果**(不吃子)—— 所以一手只編碼 from 與 to,
        路徑由 pathOf() 重建(BFS,最少段數)。⚠ UI 上要讓玩家**只點落點**,
        中途完全不點,不然他選的鏈與畫面演的鏈會對不起來。
     ③ **BFS 一定要標記走過的洞。** 六方向的跳可以繞回原地(A 跳到 B、B 跳回 A),
        不擋就是無窮迴圈。
     ④ **勝利的救濟條款需要 homeCount >= 1 這道守衛。**
        目標區 = 對面那家的**起點區** —— 開局那一刻它本來就塞滿對手的棋子,
        少了這道守衛,「我的棋 + 對手佔住的 >= 總數」在**第 0 手就成立**,
        兩邊同時判贏。
   ========================================================================== */

const TQ = (function(){

  /* ==========================================================================
     一、盤面幾何
     ──────────────────────────────────────────────────────────────────────────
       用**立方座標** (x, y, z),恆滿足 x + y + z = 0。
       六角星的定義只有一句話:

         **三個座標裡至少有兩個的絕對值 <= 4。**

       數得出來:三個都 <= 4 是中央六邊形(61 洞);恰好一個超出是某一個角(10 洞)
       → 61 + 6×10 = 121。⚠ 這一句就是整個盤面,不要改成「手列 121 個座標」。

       六個方向就是立方座標的六鄰,不必特判轉角(這一點比飛行棋的外圈乾淨:
       那一頁的 ringXY() 要自己處理四個角落的正交相鄰)。
     ========================================================================== */
  const HALF = 4;                       // 中央六邊形的半徑
  const TIP  = 8;                       // 角的最尖端(|z| 最大值)
  const RANKS = 4;                      // 一個角有幾列(1 + 2 + 3 + 4 = 10 洞)
  const N_HOLES = 121;
  const NCORNER = 6;
  const MIN_PLAYERS = 2, MAX_PLAYERS = 6;

  function inStar(x, y, z){
    if(x + y + z !== 0) return false;
    let k = 0;
    if(Math.abs(x) <= HALF) k++;
    if(Math.abs(y) <= HALF) k++;
    if(Math.abs(z) <= HALF) k++;
    return k >= 2;
  }

  /* 洞表。★ 排序刻意是「由上而下、每一列由左而右」—— 與畫面順序一致,
     所以 e2e 的錯誤訊息(「第 37 個洞」)在截圖上找得到。 */
  const HOLES = [];
  const IDX = {};                        // "x,z" → id
  const keyOf = (x, z) => x + "," + z;
  for(let z = -TIP; z <= TIP; z++){
    for(let x = -TIP; x <= TIP; x++){
      const y = -x - z;
      if(!inStar(x, y, z)) continue;
      IDX[keyOf(x, z)] = HOLES.length;
      HOLES.push({ x: x, y: y, z: z });
    }
  }
  function idAt(x, z){
    const v = IDX[keyOf(x, z)];
    return (v === undefined) ? -1 : v;
  }

  /* 六個方向(立方座標的六鄰)。順序與畫面上的方位對得起來:
     0 右 · 1 右上 · 2 左上 · 3 左 · 4 左下 · 5 右下 */
  const DIRS = [
    { x:  1, y: -1, z:  0 },
    { x:  1, y:  0, z: -1 },
    { x:  0, y:  1, z: -1 },
    { x: -1, y:  1, z:  0 },
    { x: -1, y:  0, z:  1 },
    { x:  0, y: -1, z:  1 }
  ];

  /* 鄰接表:NB[id][dir] = 相鄰的 id(-1 = 盤外);JP[id][dir] = 再過去一格(跳的落點) */
  const NB = [], JP = [];
  HOLES.forEach((h, id) => {
    const nb = [], jp = [];
    DIRS.forEach(d => {
      nb.push(idAt(h.x + d.x, h.z + d.z));
      jp.push(idAt(h.x + d.x * 2, h.z + d.z * 2));
    });
    NB.push(nb); JP.push(jp);
  });

  /* ---------- 畫面座標 ----------
     ★★ posXY() 回的是**洞的中心**,不是左上角。
       ⚠ 這一點與飛行棋相反(那一頁 posXY 回左上角,而且因此踩過「賽車旗偏半格」
         那個坑)—— 洞是圓的,講中心才自然。board.js 要自己減半徑。
     px = (x − y) / 2:同一列上 x+y 固定,x−y 每格差 2 → 除以 2 得到整數格距。
     py = z × (√3/2):正三角網格的列高。
     ⚠ 左上角平移成 0:px ∈ [−6, 6]、py ∈ [−6.93, 6.93] → 外接框 12 × 13.86 個間距,
       再各留半個洞 → 盤面是 13 × 14.86(單位 = 一格間距)。 */
  const SQ32 = Math.sqrt(3) / 2;
  const PX_MAX = 6;                                  // (x−y)/2 的極值
  const PY_MAX = TIP * SQ32;                         // z 的極值 × 列高
  const BOARD_W = PX_MAX * 2 + 1;                    // 13
  const BOARD_H = PY_MAX * 2 + 1;                    // 約 14.856

  function posXY(id){
    const h = HOLES[id];
    if(!h) return { x: 0, y: 0 };
    return { x: (h.x - h.y) / 2 + PX_MAX + 0.5, y: h.z * SQ32 + PY_MAX + 0.5 };
  }

  // 六角距離(給 AI 與名次用)
  function dist(a, b){
    const p = HOLES[a], q = HOLES[b];
    if(!p || !q) return 0;
    return (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.z - q.z)) / 2;
  }

  /* ==========================================================================
     二、六個角
     ──────────────────────────────────────────────────────────────────────────
       ★ 索引 0..5 在畫面上剛好是**順時針**:上 → 右上 → 右下 → 下 → 左下 → 左上。
       ★★ 於是「正對面的角」就是 (c + 3) % 6 —— 一條式子,不必查表。
       tip 是「離尖端多遠」(尖端 = 3,最靠中心那一列 = 0),棋子少的房規就是
       **只用尖端那幾列**(3 顆 = 尖端 2 列、6 顆 = 3 列、10 顆 = 4 列)。
       ⚠ 刻意選尖端而不是靠中心那幾列:尖端那幾列本身就是一個**完整的小三角**,
         棋子的密度與 10 顆時一樣 → 「搭橋連跳」這個核心樂趣不會因為棋子變少而消失。
     ========================================================================== */
  const CORNERS = [
    { name: "上",   axis: "z", sign: -1 },
    { name: "右上", axis: "x", sign:  1 },
    { name: "右下", axis: "y", sign: -1 },
    { name: "下",   axis: "z", sign:  1 },
    { name: "左下", axis: "x", sign: -1 },
    { name: "左上", axis: "y", sign:  1 }
  ];
  const OPPOSITE = c => (c + 3) % NCORNER;

  // 這個洞屬於哪一個角(-1 = 中央六邊形);tipOf 回它在角裡的第幾列
  function cornerOf(id){
    const h = HOLES[id];
    if(!h) return -1;
    for(let c = 0; c < NCORNER; c++){
      if(tipIn(c, h) >= 0) return c;
    }
    return -1;
  }
  function tipIn(c, h){
    const C = CORNERS[c];
    const v = h[C.axis] * C.sign;
    return v >= HALF + 1 ? (v - HALF - 1) : -1;
  }
  function tipOf(id){
    const c = cornerOf(id);
    return c < 0 ? -1 : tipIn(c, HOLES[id]);
  }

  /* 一個角在「每人 n 顆」的房規下用到哪幾個洞。
     ⚠ 回傳的順序是**由尖端往內**,所以 blank() 擺子與目標區判定共用同一張表。 */
  const CORNER_HOLES = [];               // CORNER_HOLES[c] = [id…](由尖端往內)
  for(let c = 0; c < NCORNER; c++){
    const list = [];
    HOLES.forEach((h, id) => {
      const t = tipIn(c, h);
      if(t >= 0) list.push({ id: id, tip: t });
    });
    list.sort((a, b) => (b.tip - a.tip) || (a.id - b.id));
    CORNER_HOLES.push(list.map(o => o.id));
  }
  function homeHoles(c, count){ return CORNER_HOLES[c].slice(0, count); }

  /* ---------- ★★ 視角旋轉 —— 「自己永遠在畫面下方」 ----------
     六角星有 **60° 旋轉對稱** → 整盤轉 60° 的倍數之後,121 個洞會一個不差地
     落回原本那 121 個洞的位置上(外接框、木框、格線、洞的集合**全都不變**)。
     所以「換視角」不必旋轉任何 DOM,只要把洞的 id 重新映射:
       要畫 id → 改去問 rot(id, k) 那個洞的 posXY()。
     ★ 好處是棋子上的座號與頭飾**不會跟著歪**(轉 DOM 就會),而且盤面寬高不變
       → fitBoard() / 縮放 / 大小模式全部不受影響。
     ⚠⚠ 這一層**純粹是顯示**:座位 → 角、moves、勝負一個位元都不動 ——
       六個人看到六個角度,但看的是同一局。真的去改 cornerOfSeat() 的話,
       同一份 moves 會在別人那台 replay 出完全不同的盤面。
     ★ 立方座標轉 60°(角 c → 角 c+1):(x, y, z) → (−z, −x, −y)。
     ⚠ 不要自己推第二個公式:轉錯方向的症狀很難看出來 ——
       **自己那一家仍然乖乖在下方**,只有其他人的方位左右相反。 */
  const ROT = [];                        // ROT[k][id] = 這個洞轉 k 步之後是哪一個洞
  for(let k = 0; k < NCORNER; k++){
    const row = [];
    for(let id = 0; id < N_HOLES; id++){
      let h = HOLES[id];
      for(let t = 0; t < k; t++) h = { x: -h.z, y: -h.x, z: -h.y };
      const j = idAt(h.x, h.z);
      row.push(j >= 0 ? j : id);         // 保險:對稱成立時走不到這一支
    }
    ROT.push(row);
  }
  function rotId(id, k){
    const row = ROT[((k % NCORNER) + NCORNER) % NCORNER];
    return (row && row[id] != null) ? row[id] : id;
  }
  // 我坐 c 這個角時,整盤要轉幾步才會讓 c 落到「下」(角 3)
  function viewRot(c){
    if(!(c >= 0 && c < NCORNER)) return 0;
    return ((3 - c) % NCORNER + NCORNER) % NCORNER;
  }

  /* ==========================================================================
     三、房規
     ──────────────────────────────────────────────────────────────────────────
       ★ 一局開打的那一刻就凍結(比照 21 點 / 飛行棋):replay 是拿「現在的房規」
         重跑整局的 —— 房規一變,同一份 moves 會 replay 出完全不同的盤面。
     ========================================================================== */
  const PIECE_OPTS = [3, 6, 10];
  const DEF_RULES = { pieces: 6 };

  function normRules(r){
    const o = r || {};
    const pieces = PIECE_OPTS.indexOf(+o.pieces) >= 0 ? +o.pieces : DEF_RULES.pieces;
    return { pieces: pieces };
  }

  /* 幾個人坐哪幾個角。
     ⚠ 2 人一定要對面(不然兩邊的路程不等長);3 人隔一個(0/2/4 兩兩相隔);
       4 人是**兩對正對的角**(0↔3 與 1↔4),不是相鄰的四個 —— 相鄰四個裡
       會有人的目標角沒有人坐、有人的目標角坐了兩家,路程與干擾都不對稱。
     ⚠⚠ **5 人天生不對稱**:六個角挑五個,一定剛好有一家的目標角是空的
       (這一組裡是座位 2)—— 他前面沒有人擋,略佔便宜。
       ★ 仍然開放,而且**在大廳的規則說明裡明講**:現場來了五個人卻被系統擋下來
         是更糟的體驗(而受眾就是親友聚會,見 CLAUDE.md)。 */
  const SEAT_CORNER = {
    2: [0, 3],
    3: [0, 2, 4],
    4: [0, 1, 3, 4],
    5: [0, 1, 2, 3, 4],
    6: [0, 1, 2, 3, 4, 5]
  };
  // 這個人數有沒有人的目標角是空的(大廳要據實說明)
  function lopsided(n){ return n === 5; }
  function seatsOk(n){ return !!SEAT_CORNER[n]; }
  function cornerOfSeat(n, seat){
    const map = SEAT_CORNER[n] || SEAT_CORNER[6];
    return map[seat] != null ? map[seat] : seat;
  }

  /* ==========================================================================
     四、走法 —— 單步與連跳
     ──────────────────────────────────────────────────────────────────────────
       ★★★ BFS 一定要標記走過的洞:六方向的跳可以直接繞回原地
         (A 越過 B 落到 C、再從 C 越過 B 落回 A),不擋就是無窮迴圈。
       ★ 回傳的 path 是**最少段數**的那一條(BFS 的天然性質)——
         玩家只點落點,所以「他心裡想的那一條」與畫面演的必須是同一個結果,
         而不吃子讓這件事成立:中途經過哪裡完全不影響局面。
       ⚠ 單步與跳**不可以混用**:走了一步就結束,不能再接跳(反之亦然)。
         這是標準規則,而且少了它「一手能走多遠」會失控。
     ========================================================================== */
  // occ[id] = 佔著這個洞的座位(-1 = 空)
  function occOf(st){
    const occ = new Array(N_HOLES).fill(-1);
    for(let s = 0; s < st.n; s++)
      st.pieces[s].forEach(id => { occ[id] = s; });
    return occ;
  }

  /* 從 from 出發的所有落點。回 [{ to, path:[id…], jumps }]
     jumps = 0 → 單步;>0 → 連跳幾段。 */
  function movesFrom(st, from, occ){
    const O = occ || occOf(st);
    const out = [];
    if(!(from >= 0 && from < N_HOLES) || O[from] < 0) return out;

    // 單步
    for(let d = 0; d < 6; d++){
      const t = NB[from][d];
      if(t >= 0 && O[t] < 0) out.push({ to: t, path: [from, t], jumps: 0 });
    }

    // 連跳(BFS)
    const prev = new Array(N_HOLES).fill(-2);
    prev[from] = -1;
    const queue = [from];
    let qi = 0;
    while(qi < queue.length){
      const cur = queue[qi++];
      for(let d = 0; d < 6; d++){
        const mid = NB[cur][d], land = JP[cur][d];
        if(mid < 0 || land < 0) continue;
        if(O[mid] < 0) continue;                // 要越過的那一格必須有棋(敵我皆可)
        if(O[land] >= 0) continue;              // 落點必須是空的
        if(prev[land] !== -2) continue;         // ★ 走過了 —— 少了這一行就是無窮迴圈
        prev[land] = cur;
        queue.push(land);
      }
    }
    for(let t = 0; t < N_HOLES; t++){
      if(t === from || prev[t] === -2) continue;
      const path = [];
      for(let c = t; c !== -1; c = prev[c]) path.push(c);
      path.reverse();
      out.push({ to: t, path: path, jumps: path.length - 1 });
    }
    return out;
  }

  // 這一家所有的合法手。★ AI 與「有沒有得走」共用
  function allMoves(st, seat){
    const O = occOf(st), out = [];
    if(st.over) return out;
    st.pieces[seat].forEach(from => {
      movesFrom(st, from, O).forEach(m => {
        out.push({ from: from, to: m.to, path: m.path, jumps: m.jumps });
      });
    });
    return out;
  }

  // 這一手合不合法(交易端與 replay 共用同一條判定)。occ 可以傳進來共用
  function moveOf(st, seat, from, to, occ){
    if(st.over) return null;
    const O = occ || occOf(st);
    if(!(from >= 0 && from < N_HOLES) || O[from] !== seat) return null;
    const list = movesFrom(st, from, O);
    for(let i = 0; i < list.length; i++)
      if(list[i].to === to) return { from: from, to: to, path: list[i].path, jumps: list[i].jumps };
    return null;
  }
  /* 只要路徑(畫面用)。⚠ 找不到就退回「起訖兩點」——
     動畫不該因為算不出路徑而卡住(這一頁的動畫是純裝飾,見 board.js 檔頭)。 */
  function pathOf(st, from, to){
    const O = occOf(st);
    const seat = O[from];
    if(seat < 0) return [from, to];
    const m = moveOf(st, seat, from, to, O);
    return m ? m.path : [from, to];
  }

  /* ==========================================================================
     五、到家了沒
     ──────────────────────────────────────────────────────────────────────────
       ★★★ 救濟條款(僵局):**目標區 = 對面那家的起點區**,所以只要對面那家有一顆
         賴著不走,我就永遠填不滿 —— 而這一頁沒有骰子推著走,連線局會真的卡死。
         規則:目標區裡被別人佔住的洞,算我「填到了」。
       ⚠⚠ 但一定要加 homeCount >= 1 這道守衛:**開局那一刻目標區塞滿的正是對手的棋**
         → 少了它,第 0 手兩邊就同時判贏(而且畫面上完全看不出哪裡錯)。
     ========================================================================== */
  function homeCount(st, seat){
    const goal = st.goals[seat];
    let k = 0;
    st.pieces[seat].forEach(id => { if(goal.indexOf(id) >= 0) k++; });
    return k;
  }
  function blockedCount(st, seat, occ){
    const O = occ || occOf(st);
    let k = 0;
    st.goals[seat].forEach(id => { if(O[id] >= 0 && O[id] !== seat) k++; });
    return k;
  }
  function isDone(st, seat, occ){
    const total = st.goals[seat].length;
    const mine = homeCount(st, seat);
    if(mine >= total) return true;
    return mine >= 1 && (mine + blockedCount(st, seat, occ)) >= total;
  }
  // 還差多遠(名次與 AI 共用):每顆棋到目標角尖端的六角距離總和
  function remain(st, seat){
    const apex = st.apex[seat];
    return st.pieces[seat].reduce((a, id) => a + dist(id, apex), 0);
  }

  /* ==========================================================================
     六、replay —— ★ 一整局唯一的真相入口
     ──────────────────────────────────────────────────────────────────────────
       moves 的編碼:**一手一個整數 = from × 121 + to**(與五子棋 / 排七同構)。
       ⚠ 連跳的中間路徑不進 moves —— 不吃子,所以中途經過哪裡不影響任何結果。

       ★ turn 在這一頁與 moves.length 是一比一的(沒有連續回合),但**仍然一律問
         st.turn**:①與另外十三頁同一個習慣 ②萬一哪天加上「逾時跳過」就會當場破功。
     ========================================================================== */
  const encMove = (from, to) => from * N_HOLES + to;
  const decFrom = mv => Math.floor(mv / N_HOLES);
  const decTo   = mv => mv % N_HOLES;

  function blank(n, rules){
    const R = normRules(rules);
    const pieces = [], corners = [], goals = [], apex = [];
    for(let s = 0; s < n; s++){
      const c = cornerOfSeat(n, s), g = OPPOSITE(c);
      corners.push(c);
      pieces.push(homeHoles(c, R.pieces).slice());
      goals.push(homeHoles(g, R.pieces).slice());
      apex.push(CORNER_HOLES[g][0]);      // 目標角的最尖端那一洞
    }
    return {
      n: n, rules: R, corners: corners, goals: goals, apex: apex, pieces: pieces,
      turn: 0, over: false, winner: -1, done: new Array(n).fill(false),
      last: null, bad: -1
    };
  }

  /* 下一個出手的人。⚠ 這是唯一決定 turn 的地方 —— 呼叫端一律不准自己算。
     已經完成的人跳過(第一名出線就結算,所以理論上不會用到;仍然留著當保險)。 */
  function nextSeat(st, from){
    for(let k = 1; k <= st.n; k++){
      const s = (from + k) % st.n;
      if(!st.done[s]) return s;
    }
    return from;
  }

  /* 套用一手。回 true = 成功;false = 不合法(呼叫端要中止,不可以硬套下去)。 */
  function step(st, mv){
    if(st.over) return false;
    const seat = st.turn;
    const from = decFrom(mv), to = decTo(mv);
    if(!(from >= 0 && from < N_HOLES && to >= 0 && to < N_HOLES)) return false;
    const O = occOf(st);                       // ★ 移動**前**的佔用表(合法性要用它判)
    const m = moveOf(st, seat, from, to, O);
    if(!m) return false;

    const arr = st.pieces[seat];
    const k = arr.indexOf(from);
    if(k < 0) return false;
    arr[k] = to;
    O[from] = -1; O[to] = seat;                // 就地更新成移動**後**,省一次重算
    st.last = { kind: "move", seat: seat, from: from, to: to, path: m.path, jumps: m.jumps,
                home: st.goals[seat].indexOf(to) >= 0 };
    /* ★ 借道:這一手是不是踩著**別人的**棋子飛過來的 —— 這一頁唯一的人際瞬間
       (見 notes/23),完全由 replay 算得出來,不必寫進 DB。 */
    st.last.borrowed = countBorrowed(st, m.path, seat, O);

    if(isDone(st, seat, O)){
      st.done[seat] = true;
      st.over = true; st.winner = seat;      // ★ 第一名出線就結算(不必等最後一名)
      return true;
    }
    st.turn = nextSeat(st, seat);
    return true;
  }

  /* 這條連跳鏈越過了幾顆**別人的**棋子。⚠ 越過的是「每一段的中點」——
     path 相鄰兩點的中點就是被越過的那一格(單步的中點不在洞上,長度會是 1)。 */
  function countBorrowed(st, path, seat, occ){
    const O = occ || occOf(st);
    let k = 0;
    for(let i = 1; i < path.length; i++){
      const a = HOLES[path[i - 1]], b = HOLES[path[i]];
      if(!a || !b) continue;
      if(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) !== 4) continue;  // 不是跳
      const mid = idAt((a.x + b.x) / 2, (a.z + b.z) / 2);
      if(mid >= 0 && O[mid] >= 0 && O[mid] !== seat) k++;
    }
    return k;
  }

  function replay(rules, n, moves){
    if(!seatsOk(n)) return null;
    const st = blank(n, rules);
    const list = Array.isArray(moves) ? moves : [];
    for(let i = 0; i < list.length; i++){
      if(!step(st, list[i])){ st.bad = i; break; }    // 不合法就停在這裡,不硬套
    }
    return st;
  }

  /* ==========================================================================
     七、結算
     ──────────────────────────────────────────────────────────────────────────
       第一名 = 先完成的人;其餘依「到家幾顆 → 還差多遠」排。
       ★ 名次分吃核心的 winner.pts(大老二加進去的能力)—— 這正是「不必等最後一名
         慢慢爬完」的關鍵,而跳棋比飛行棋更需要它(見 notes/23 第一節的時間表)。
     ========================================================================== */
  const PTS = { 2: [2, 0], 3: [3, 1, 0], 4: [5, 3, 1, 0],
                5: [6, 4, 2, 1, 0], 6: [7, 5, 3, 2, 1, 0] };
  function ptsForRank(rank, n){
    const t = PTS[n] || PTS[6];
    return t[Math.max(1, Math.min(rank, t.length)) - 1];
  }

  function score(st){
    const rows = [];
    for(let s = 0; s < st.n; s++){
      rows.push({
        seat: s, corner: st.corners[s],
        home: homeCount(st, s), left: remain(st, s),
        first: st.winner === s, rank: 0, pts: 0
      });
    }
    const sorted = rows.slice().sort((a, b) =>
      (b.first - a.first) || (b.home - a.home) || (a.left - b.left) || (a.seat - b.seat));
    let rk = 0;
    sorted.forEach((r, i) => {
      const p = i ? sorted[i - 1] : null;
      if(!p || p.first !== r.first || p.home !== r.home || p.left !== r.left) rk = i + 1;
      r.rank = rk;
      r.pts = ptsForRank(rk, st.n);
    });
    return { rows: rows, sorted: sorted, winners: sorted.filter(r => r.rank === 1).map(r => r.seat) };
  }

  /* ==========================================================================
     八、小工具(畫面與 AI 共用)
     ========================================================================== */
  // 一手的白話描述(toast 共用;單機與連線兩邊都要用 → 放規則層才不會走鐘)
  function moveText(mv){
    if(!mv) return "";
    if(!mv.jumps) return "";
    let s = "跳 " + mv.jumps + " 段";
    if(mv.jumps >= 4) s = "🔥 " + s;
    if(mv.borrowed) s += " · 借了對手 " + mv.borrowed + " 顆當跳板";
    if(mv.home) s = (s ? s + " · " : "") + "🏁 到家";
    return s;
  }

  return {
    // 常數
    N_HOLES, NCORNER, RANKS, HALF, TIP, PIECE_OPTS, DEF_RULES,
    MIN_PLAYERS, MAX_PLAYERS, SEAT_CORNER, CORNERS, BOARD_W, BOARD_H,
    // 幾何(純資料,board.js 查表用)
    HOLES, NB, JP, DIRS, CORNER_HOLES, posXY, dist, idAt,
    cornerOf, tipOf, homeHoles, OPPOSITE, cornerOfSeat, seatsOk, lopsided,
    // 視角(純顯示,見上面那一段的 ⚠⚠)
    rotId, viewRot,
    // 房規
    normRules,
    // 走法
    occOf, movesFrom, allMoves, moveOf, pathOf,
    // 一局
    blank, step, replay, nextSeat, homeCount, blockedCount, isDone, remain,
    // 編碼
    encMove, decFrom, decTo,
    // 結算
    score, ptsForRank,
    // 小工具
    moveText
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = TQ;

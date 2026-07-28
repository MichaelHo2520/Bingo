"use strict";

/* ============================================================================
   五子棋 — 電腦對手(簡單 / 普通 / 困難)

   純函式引擎:吃「盤面陣列 + 邊長 + 我是哪一色」,回傳落點索引。
   不碰 DOM、不碰 GB、不碰 Firebase → 可以單獨在測試頁裡讓兩個難度互相對打驗棋力。

   盤面編碼刻意不用 GB 的 "b"/"w" 字串而是 Int8Array(0 空 / 1 黑 / 2 白):
   搜尋樹裡要反覆 mutate 同一份盤面再還原,typed array 才夠快。
   solo.js 用 occFrom() 把 GB 的 moves 轉成這個格式。

   三個難度的差別「不是」同一套邏輯調參數,而是刻意各自看漏不同的東西 ——
   靠隨機亂下做出來的弱 AI 會下出人看得出來的蠢手,而「看不見活三」是真人新手
   本來就會犯的錯,輸給它不會覺得被放水:

     簡單  只擋對手的四,完全無視活三 → 玩家用活三→活四就能贏;還會從前幾名亂挑
     普通  完整攻防(會擋活三、會做衝四),但不看雙威脅 → 玩家用雙活三 / 三四能贏
     困難  加雙威脅偵測 + alpha-beta 前瞻,有時間預算,超時就退回淺層的最佳解

   ⚠ 這裡是全專案唯一算棋型分的地方。要調棋力先動 P 那張表的倍率關係,
     不要在 pick() 裡加特例。
   ========================================================================== */

const GAI = (function(){
  const DIRS = [[1,0],[0,1],[1,1],[1,-1]];   // 橫 / 豎 / 右下 / 右上(與 board.js 同一組)
  const R = 5;                               // 取線半徑:中心左右各 5 格 = 長度 11,足夠涵蓋所有五連棋型
  const WIN = 1e9;                            // 搜尋用的勝分(遠大於任何棋型分之和)

  /* 棋型分。倍率關係就是 AI 的價值觀,絕對值不重要:
       活四(10000)  > 雙活三(2400) > 活三(1200) > 衝四(1000)
     → 有活四就走活四;沒有時「雙活三」勝過「單衝四」(前者必勝,後者被堵就沒了);
       活三略高於衝四,因為衝四被擋掉就是死路,活三擋一邊還留一邊。 */
  const P = { FIVE:100000, OPEN4:10000, FOUR:1000, OPEN3:1200, OPEN3B:1000,
              SLEEP3:100, OPEN2:100, SLEEP2:10, ONE:1 };

  /* 棋型表:從強到弱排,第一個命中就採用(所以順序不能亂動)。
     'm' = 我的子, '.' = 空, 'x' = 對手的子或牆(兩者對我一樣是阻擋,不必分開)
     f = 這型算一個「四」, t = 算一個「活三」——判斷雙威脅用的。 */
  const PATS = [
    ["mmmmm",  P.FIVE,   0, 0],
    [".mmmm.", P.OPEN4,  1, 0],                                        // 活四:兩端都空,擋不住
    ["mmmm",   P.FOUR,   1, 0],                                        // 連四但一端被封 = 衝四
    ["mm.mm",  P.FOUR,   1, 0], ["mmm.m", P.FOUR, 1, 0], ["m.mmm", P.FOUR, 1, 0],   // 跳著的衝四
    [".mmm.",  P.OPEN3,  0, 1],                                        // 活三:不擋就變活四
    [".m.mm.", P.OPEN3B, 0, 1], [".mm.m.", P.OPEN3B, 0, 1],            // 跳活三(稍弱:多一個洞要補)
    ["mmm",    P.SLEEP3, 0, 0], ["mm.m", P.SLEEP3, 0, 0],
    ["m.mm",   P.SLEEP3, 0, 0], ["m.m.m", P.SLEEP3, 0, 0],             // 眠三:被封了一邊
    ["..mm..", P.OPEN2,  0, 0], [".mm.",  P.OPEN2,  0, 0], [".m.m.", P.OPEN2, 0, 0],
    ["mm",     P.SLEEP2, 0, 0], ["m.m",   P.SLEEP2, 0, 0]
  ].map(a => ({ s:a[0], v:a[1], f:a[2], t:a[3] }));
  const ONE = { s:"m", v:P.ONE, f:0, t:0 };

  /* ---------- 盤面工具 ---------- */
  // GB 的 moves(有序落子索引,偶數步=黑)→ Int8Array 盤面
  function occFrom(moves, n){
    const occ = new Int8Array(n*n);
    (moves || []).forEach((i,k)=>{ occ[i] = (k % 2 === 0) ? 1 : 2; });
    return occ;
  }
  function other(c){ return c === 1 ? 2 : 1; }

  /* ---------- 單點的棋型評估 ----------
     「我如果下在 i,這一手值多少」。四個方向各取一條長度 11 的線,中心強制當成自己的子。 */
  function lineOf(occ, n, i, dc, dr, c){
    const r0 = (i / n) | 0, c0 = i % n;
    let s = "";
    for(let k = -R; k <= R; k++){
      if(k === 0){ s += "m"; continue; }
      const r = r0 + dr*k, cc = c0 + dc*k;
      if(r < 0 || r >= n || cc < 0 || cc >= n){ s += "x"; continue; }   // 牆等於阻擋
      const v = occ[r*n + cc];
      s += (v === 0) ? "." : (v === c ? "m" : "x");
    }
    return s;
  }
  function shapeOf(s){
    /* 先問「這個方向還有沒有救」:必須存在一個含中心、完全沒有 x 的五連窗口。
       少了這一關,AI 會把子下在死角(例如兩頭都被封住的三連旁邊)還自以為有分。 */
    let alive = false;
    for(let st = R-4; st <= R; st++){
      if(st < 0 || st + 5 > s.length) continue;
      if(s.slice(st, st+5).indexOf("x") < 0){ alive = true; break; }
    }
    if(!alive) return null;
    for(let k = 0; k < PATS.length; k++) if(s.indexOf(PATS[k].s) >= 0) return PATS[k];
    return ONE;
  }
  /* 回傳 { sum, best, fours, threes }
       sum    四個方向加總 —— 同一點同時往兩個方向長(雙威脅)才會被看見
       best   最強的單一方向 —— 判「這一手直接連五 / 直接活四」用
       fours/threes  能成幾個四、幾個活三 —— 困難難度的雙威脅偵測用 */
  function evalPoint(occ, n, i, c){
    let sum = 0, best = 0, fours = 0, threes = 0;
    for(let d = 0; d < 4; d++){
      const p = shapeOf(lineOf(occ, n, i, DIRS[d][0], DIRS[d][1], c));
      if(!p) continue;
      sum += p.v;
      if(p.v > best) best = p.v;
      if(p.f) fours++;
      if(p.t) threes++;
    }
    return { sum:sum, best:best, fours:fours, threes:threes };
  }

  /* ---------- 候選點 ----------
     只看「已有棋子附近 rad 格內」的空點。19×19 有 361 個交叉點,但離戰場十萬八千里的
     角落永遠不值得算 —— 這一刀把搜尋空間砍到幾十個,是整個 AI 跑得動的關鍵。 */
  function candidates(occ, n, rad){
    const out = [], total = n*n;
    for(let i = 0; i < total; i++){
      if(occ[i]) continue;
      const r0 = (i/n)|0, c0 = i % n;
      let near = false;
      for(let dr = -rad; dr <= rad && !near; dr++){
        const r = r0 + dr;
        if(r < 0 || r >= n) continue;
        for(let dc = -rad; dc <= rad; dc++){
          const cc = c0 + dc;
          if(cc < 0 || cc >= n || (dr === 0 && dc === 0)) continue;
          if(occ[r*n + cc]){ near = true; break; }
        }
      }
      if(near) out.push(i);
    }
    return out;
  }
  /* 把候選點排序:value = 我下這裡的收益 + 對手下這裡的收益 × 防守權重。
     「對手下這裡值多少」正好就是「我下這裡破壞掉多少」,同一個函式兩用。 */
  function rank(occ, n, me, opp, list, wDef, blindThree){
    const arr = [];
    for(let k = 0; k < list.length; k++){
      const i = list[k];
      const a = evalPoint(occ, n, i, me);
      const d = evalPoint(occ, n, i, opp);
      /* blindThree(簡單難度):防守分截在「四」的等級。
         活三的堵點本來會拿到活四的分(對手下那裡就成活四)= 一萬,截斷後只剩一千,
         而自己「活二變活三」的進攻分就有一千二 → 它會選著自己連,把對手的活三放生。
         這不是亂下,是真人新手最典型的死法:顧著自己連,直到對方要連五了才回頭擋
         (那一步由 tactic 規則 2 保底,每個難度都會做)。 */
      const def = blindThree ? Math.min(d.sum, P.FOUR) : d.sum;
      arr.push({ i:i, atk:a, def:d, v:a.sum + def*wDef });
    }
    arr.sort((x,y)=>y.v - x.v);
    return arr;
  }

  /* ---------- 戰術規則:不必搜尋就該知道的手 ----------
     難度差異主要落在這裡。回傳落點索引,或 null 表示「交給評分/搜尋決定」。
     lv.tactics 決定看到第幾層:1 = 只看四,2 = 看活四,3 = 看雙威脅。 */
  function tactic(rk, lv){
    let myFive = null, opFive = null, myOpen4 = null, opOpen4 = null, myDouble = null, opDouble = null;
    for(let k = 0; k < rk.length; k++){
      const e = rk[k], a = e.atk, d = e.def;
      if(myFive === null && a.best >= P.FIVE) myFive = e.i;
      if(opFive === null && d.best >= P.FIVE) opFive = e.i;
      if(myOpen4 === null && a.best >= P.OPEN4) myOpen4 = e.i;
      if(opOpen4 === null && d.best >= P.OPEN4) opOpen4 = e.i;
      // 雙威脅 = 一手同時成兩個必應手的型(雙活三 / 三四 / 雙衝四),對手只能擋一個
      if(myDouble === null && (a.threes >= 2 || a.fours >= 2 || (a.fours >= 1 && a.threes >= 1))) myDouble = e.i;
      if(opDouble === null && (d.threes >= 2 || d.fours >= 2 || (d.fours >= 1 && d.threes >= 1))) opDouble = e.i;
    }
    if(myFive !== null) return myFive;                       // 連五就贏,不用想
    if(opFive !== null) return opFive;                       // 對手要連五,非擋不可(每個難度都做,不然太蠢)
    if(lv.tactics < 2) return null;
    if(myOpen4 !== null) return myOpen4;                     // 我能活四 = 必勝
    if(opOpen4 !== null) return opOpen4;                     // 對手能活四,擋(通常已經來不及,但別放棄)
    if(lv.tactics < 3) return null;
    if(myDouble !== null) return myDouble;                   // 自己的雙威脅優先於拆對手的(先手快一步)
    if(opDouble !== null) return opDouble;
    return null;
  }

  /* ---------- 盤面估值(給搜尋的葉節點用) ----------
     不掃全盤棋型,而是「雙方各自最好的一手值多少」相減 —— 五子棋的局勢幾乎完全由
     最強的威脅決定,次強的只給四分之一權重當平手時的參考。
     對手那邊乘 1.05:同樣的威脅擺在對手手上更危險(我還要多花一手去擋)。 */
  function boardEval(occ, n, me, opp, list, turn){
    let m1 = 0, m2 = 0, o1 = 0, o2 = 0;
    for(let k = 0; k < list.length; k++){
      const i = list[k];
      if(occ[i]) continue;
      const a = evalPoint(occ, n, i, me).sum;
      if(a > m1){ m2 = m1; m1 = a; } else if(a > m2) m2 = a;
      const d = evalPoint(occ, n, i, opp).sum;
      if(d > o1){ o2 = o1; o1 = d; } else if(d > o2) o2 = d;
    }
    const mine = m1 + m2*0.25, theirs = o1 + o2*0.25;
    // 輪到誰下就多算一點誰的:同樣的威脅,先動手的那邊才兌現得了
    return turn === me ? (mine - theirs*1.05) : (mine*0.95 - theirs*1.1);
  }

  /* ---------- alpha-beta(只有困難難度會走到) ----------
     depth 是還要往下幾層。每層只展開排名前 width 個候選 —— 五子棋的好手幾乎都在
     前幾名裡,寬度砍掉的分支省下的時間換成多看一層更值得。
     超過 deadline 直接 throw:iterative deepening 的外層會接住,用上一層算完的結果。 */
  const ABORT = {};
  let deadline = 0, nodes = 0;
  function search(occ, n, me, opp, turn, depth, alpha, beta, list, width){
    if((++nodes & 63) === 0 && performance.now() > deadline) throw ABORT;
    const maximizing = (turn === me);
    const rk = rank(occ, n, turn, other(turn), list, 0.95, false);
    if(!rk.length) return 0;
    // 這一手能連五 → 不用再往下,直接結算(留 depth 當「越快贏越好」的加權)
    if(rk[0].atk.best >= P.FIVE) return maximizing ? (WIN + depth) : -(WIN + depth);
    if(depth <= 0) return boardEval(occ, n, me, opp, list, turn);

    const top = rk.slice(0, width);
    let best = maximizing ? -Infinity : Infinity;
    for(let k = 0; k < top.length; k++){
      const i = top[k].i;
      occ[i] = turn;
      // 下一層的候選:本來的候選扣掉這個點,再補上它周圍剛變得有意義的空點
      const nl = nextList(occ, n, list, i);
      let v;
      /* ★ finally 不是裝飾:超時是用 throw 中斷的,少了它這條路徑上試下的每一顆子都會留在
         occ 裡 —— 而 occ 是呼叫端(solo.js)那一份,污染下去 AI 會對著一個有幻影棋子的
         盤面思考,還會回報「下在已經有子的點」。 */
      try{
        v = search(occ, n, me, opp, other(turn), depth-1, alpha, beta, nl, width);
      }finally{
        occ[i] = 0;
      }
      if(maximizing){
        if(v > best) best = v;
        if(best > alpha) alpha = best;
      }else{
        if(v < best) best = v;
        if(best < beta) beta = best;
      }
      if(beta <= alpha) break;         // 剪枝
    }
    return best;
  }
  // 落子後的候選集合:移掉被佔的點,補進新子的八方鄰居(只補一格,深層不必再鋪開)
  function nextList(occ, n, list, played){
    const out = [];
    for(let k = 0; k < list.length; k++) if(list[k] !== played && !occ[list[k]]) out.push(list[k]);
    const r0 = (played/n)|0, c0 = played % n;
    for(let dr = -1; dr <= 1; dr++) for(let dc = -1; dc <= 1; dc++){
      const r = r0+dr, cc = c0+dc;
      if(r < 0 || r >= n || cc < 0 || cc >= n) continue;
      const j = r*n + cc;
      if(!occ[j] && out.indexOf(j) < 0) out.push(j);
    }
    return out;
  }

  /* ---------- 難度表 ----------
     tactics  戰術規則看到第幾層(1 只看四 / 2 看活四 / 3 看雙威脅)
     wDef     防守權重:< 1 偏攻,> 1 偏守
     blind3   看不見對手的活三(簡單專用)
     pickTop  從排名前幾個裡挑(> 1 就是會下非最佳手)
     depth    alpha-beta 深度(0 = 不搜尋,只用一手評分)
     width    每層展開幾個候選
     budget   一手最多想幾毫秒 */
  const LEVELS = {
    easy:   { key:"easy",   name:"新手",  emoji:"🙂", tactics:1, wDef:0.4,  blind3:true,  pickTop:5, depth:0, width:0,  budget:0,
              desc:"只會擋你的四,看不見活三 —— 適合小朋友或第一次玩" },
    normal: { key:"normal", name:"普通",  emoji:"🤔", tactics:2, wDef:0.95, blind3:false, pickTop:2, depth:0, width:0,  budget:0,
              desc:"完整攻防,會擋活三也會做衝四,但看不出雙威脅" },
    hard:   { key:"hard",   name:"高手",  emoji:"😈", tactics:3, wDef:1.0,  blind3:false, pickTop:1, depth:4, width:7, pool:16, budget:900,
              desc:"會算雙活三與三四殺,還會往前看四手 —— 認真下才贏得了" }
  };
  function levelOf(k){ return LEVELS[k] || LEVELS.normal; }

  /* ---------- 對外:選一手 ---------- */
  function pick(occ, n, me, levelKey){
    const lv = levelOf(levelKey), opp = other(me), total = n*n;
    let stones = 0;
    for(let i = 0; i < total; i++) if(occ[i]) stones++;
    if(stones >= total) return -1;
    // 空盤(電腦先手):下天元。第二手起一般評分自然就會貼著戰場走,不必特例
    if(!stones){ const c = ((n-1)/2)|0; return c*n + c; }

    const list = candidates(occ, n, 2);
    if(!list.length){ for(let i = 0; i < total; i++) if(!occ[i]) return i; return -1; }

    const rk = rank(occ, n, me, opp, list, lv.wDef, lv.blind3);
    const forced = tactic(rk, lv);
    if(forced !== null) return forced;

    // 困難:iterative deepening。先拿淺層答案墊底,再一層層加深,超時就用上一層的
    if(lv.depth >= 2 && rk.length > 1){
      const top = rk.slice(0, lv.width);
      /* 搜尋樹裡的候選只給排名前 pool 個(不是全部幾十上百個空點)。
         每個節點都要對整份候選重算一次攻防分,不設上限的話光是排序就把時間吃光,
         d=4 永遠跑不完 —— 而威脅點(連五 / 活四 / 活三的堵點)一定排在前面,砍掉的
         都是活二以下的閒手。nextList() 之後還會補進新子的八鄰居,不會把新機會漏掉。 */
      const pool = rk.slice(0, lv.pool).map(e=>e.i);
      let bestI = rk[0].i;
      deadline = performance.now() + lv.budget;
      nodes = 0;
      for(let d = 2; d <= lv.depth; d += 2){
        let localBest = -Infinity, localI = bestI, done = false, alpha = -Infinity;
        try{
          for(let k = 0; k < top.length; k++){
            const i = top[k].i;
            occ[i] = me;
            let v;
            try{
              // alpha 要跟著已經找到的最佳值往上帶,不然根層每個候選都是全開區間搜,剪枝幾乎不會發生
              v = search(occ, n, me, opp, opp, d-1, alpha, Infinity, nextList(occ, n, pool, i), lv.width);
            }finally{
              occ[i] = 0;              // 同 search():超時是 throw 出來的,不還原就會污染盤面
            }
            if(v > localBest){ localBest = v; localI = i; if(v > alpha) alpha = v; }
          }
          done = true;
        }catch(e){
          if(e !== ABORT) throw e;      // ABORT 以外的例外照樣往上丟(別把真的 bug 吞掉)
        }
        // 這一層沒跑完就不能採用它的結果(只比了前幾個候選,選出來的不是最好的那個)
        if(!done) break;
        bestI = localI;
        if(localBest >= WIN) break;     // 已經找到必勝路線,不必再深
      }
      return bestI;
    }

    // 簡單 / 普通:從前幾名裡挑。權重遞減,所以還是偏好好手,只是不保證下最佳
    const pool = rk.slice(0, Math.min(lv.pickTop, rk.length));
    if(pool.length <= 1) return rk[0].i;
    // 第一名遙遙領先(2 倍以上)時不亂挑 —— 該擋的還是要擋,不然弱得太假
    if(pool[0].v >= pool[1].v * 2) return pool[0].i;
    let wsum = 0;
    const w = pool.map((_,k)=>{ const x = 1/(k+1); wsum += x; return x; });
    let r = Math.random() * wsum;
    for(let k = 0; k < pool.length; k++){ r -= w[k]; if(r <= 0) return pool[k].i; }
    return pool[0].i;
  }

  return {
    pick, occFrom, levelOf, LEVELS,
    // 給測試頁 / 主控台驗棋力用(不是遊戲流程需要的)
    evalPoint, candidates, P
  };
})();

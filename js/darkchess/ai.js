"use strict";

/* ============================================================================
   象棋暗棋 — 電腦對手(DCAI)。
   ★ 純函式,零 DOM、零 Firebase。棋力只有靠 node 大量對打才量得出來
     (tools/test-dc-ai.js),碰一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── ★★★ 「AI 不作弊」在這一頁是**結構上的**,不是靠自律 ──────────────────
     st.cells[i].p 對**沒翻開**的格也是真值(replay 算得出來,連線那邊 DB 也是明碼)。
     所以只要 AI 敢去讀它,就是作弊,而且**沒有任何測試會紅**。
     這一支用兩條結構性的規矩把它擋掉:

       ① **只准透過 knownAt() 讀棋子** —— 它對 !up 的格一律回 null。
          「那一格有沒有東西」(occupied)是公開資訊,可以讀。
       ② **任何會翻開暗棋的手,一律不准用 DC.step() 模擬** ——
          翻棋、炮打暗子、連吃翻攻,三種都會在模擬時把真值攤在眼前。
          它們改走 gamble*():只吃「還沒現身的那些子」這個**集合**(unseenTally())。

     ⚠ 有一處看起來像漏洞、其實不是:DC.step() 內部的 countSide() 會數到暗子。
       但那個數字 = 16 − 已經被吃掉的顆數,而**被吃掉的一定都現過身**
       (一般吃法只吃得到明棋;炮打暗子與連吃翻攻都會先翻開)→ 它是公開資訊。

     守門是 tools/test-dc-ai.js 的 A 節「置換測試」:把所有暗棋底下的東西重新排列
     (集合不變、位置全換),三個難度選的那一手**必須一模一樣**。
     破壞①或②任何一條,那條測試立刻紅。

   ── 三個難度是「看得見的行為差異」,全部差異都在 CFG 那張表裡 ────────────
     easy  只看眼前:有得吃就吃最大的,完全不管自己會不會被吃回去
     mid   會算一層 + **掛子項**:不把子留在對方吃得到的格上、翻棋挑安全的格
     hard  算兩層 + 掛子項 + 賭的折扣(gK)——「不確定的手」不再自動比較好看
     ⚠ 深度不是越深越好:depth 4 只多 1 個百分點卻慢 15 倍,depth 3 反而比 depth 2 差
       (奇數層 = 自己走最後一手 = 樂觀偏差)。要改深度請先跑 tools/test-dc-ai.js。

   ── ★ 效能:gamble*() 一律走「階級遮罩」而不是逐顆算 ─────────────────────
     一格只算兩次 threatMask()(我方 / 敵方各一),未現身的子只做位元查表。
     第一版對 pool 裡每一顆都跑一次 threatened() → 深一點就直接卡死。
   ========================================================================== */

const DCAI = (function(){

  const DIRS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const ALL_RANKS = 0xFE;                    // 第 1..7 位

  /* ==========================================================================
     一、看得到什麼
     ========================================================================== */
  // ★ 唯一准用的讀棋子入口:暗棋一律回 null
  function knownAt(st, i){
    const c = st.cells[i];
    if(!c) return null;
    return c.up ? c.p : null;
  }
  const occupied = (st, i) => !!st.cells[i];   // 「有沒有東西」是公開資訊
  const isDark   = (st, i) => { const c = st.cells[i]; return !!c && !c.up; };

  /* 還沒現身的那些子,以 tally[棋子] = 幾顆 表示
     (= 全部 32 顆 − 盤上已翻開的 − 已經被吃掉的)。 */
  function unseenTally(st){
    const tally = [];
    for(let p = 0; p < 14; p++) tally[p] = 0;
    for(let side = 0; side < 2; side++){
      for(let r = 1; r <= 7; r++) tally[DC.pieceOf(side, r)] = DC.COUNTS[r - 1];
    }
    for(let i = 0; i < DC.NSQ; i++){
      const p = knownAt(st, i);
      if(p !== null) tally[p]--;
    }
    for(let s = 0; s < 2; s++) st.caps[s].forEach(p => tally[p]--);
    let n = 0;
    for(let p = 0; p < 14; p++) n += tally[p];
    tally.total = n;
    return tally;
  }

  /* ==========================================================================
     二、子力
     ──────────────────────────────────────────────────────────────────────────
       ★★ 這裡本來有一版「**動態**子力」:敵方還有卒 → 我的將貶值;敵方的將還在 →
          我的卒升值。聽起來完全是暗棋的味道,而且它就是暗棋與象棋最不一樣的地方。
          **量出來是負的** —— 同樣 depth 2 + 掛子項,帶動態子力 57.5%、不帶 66.9%
          (每格 80 局,對照組在 ±6% 晃)。第一輪 depth 3 那組也是一樣的方向
          (66.9% vs 67.5%,落在雜訊裡)。
          原因大概是:「將會被卒吃」這件事**掛子項已經算進去了**(threatMask 認得
          canBeat(卒, 將)),再調一次子力等於重複計價,反而讓 AI 高估自己的卒。
          → 整段拿掉。**不要因為「聽起來很對」再加回來**,要加請先跑 tools/test-dc-ai.js。
     ========================================================================== */
  const BASE = [0, 25, 45, 40, 55, 70, 90, 110];      // index = rank 1..7

  /* 子力表:棋子 → 分數(靜態,整支共用一份)。
     ⚠ **懶初始化**,不可以寫成模組載入時就算 —— node 那邊 global.DC 是在檔尾才設的
       (瀏覽器沒這個問題),提早碰 DC.pieceOf 會直接 TypeError。 */
  let VAL = null;
  function vals(){
    if(VAL) return VAL;
    VAL = [];
    for(let side = 0; side < 2; side++){
      for(let r = 1; r <= 7; r++) VAL[DC.pieceOf(side, r)] = BASE[r];
    }
    return VAL;
  }

  /* 盤面對 me(座位)有多好 —— 只算**看得見的**子,暗子一律當作中立。
     hang = 要不要算「現在誰掛在那裡等著被吃」(hard 才開)。 */
  function evalPos(st, me, vt, hang){
    const mySide = st.col[me];
    if(st.over){
      if(st.winner === me) return 100000;
      if(st.winner === 1 - me) return -100000;
      return 0;                                        // ★ 和局 = 中立,見下面那段 idle 衰減
    }
    if(mySide < 0) return 0;
    let s = 0;
    for(let i = 0; i < DC.NSQ; i++){
      const p = knownAt(st, i);
      if(p === null) continue;
      const mine = (DC.sideOf(p) === mySide);
      s += (mine ? 1 : -1) * vt[p];
      /* ★ 掛子:這一顆現在就站在對方吃得到的位置。
         深度搜尋看得到「下一手被吃」,但看不到「三手之後還掛在那裡」——
         靜態盤面加這一項,hard 才會主動把子挪開 / 主動去逼對方的子。 */
      if(hang){
        const atk = mine ? (1 - mySide) : mySide;
        if(threatMask(st, i, atk) & (1 << DC.rankOf(p))) s += (mine ? -1 : 1) * vt[p] * 0.45;
      }
    }
    // 被吃掉的也要算進來 —— 不然「對方的子被我吃光」與「對方的子還在盤上」同分。
    for(let k = 0; k < st.caps[me].length; k++) s += vt[st.caps[me][k]] * 0.15;

    /* ★★ 悶局壓力:idle 逼近門檻時,分數要從「子力」平滑轉向「誰的階級總和大」——
       因為那才是悶到底時真正的結果(見 rules.js 的 IDLE_DRAW)。
       沒有這一項,AI 看不到倒數,會一路繞圈到門檻才發現輸了。
       ⚠ sumSide 讀得到暗子,但那是公開資訊(= 52 − 被吃掉的階級和),置換測試守著。 */
    if(st.idle > 12){
      const k = Math.min(1, (st.idle - 12) / (DC.IDLE_DRAW - 12));
      const a = DC.sumSide(st, mySide), b = DC.sumSide(st, 1 - mySide);
      s = s * (1 - k) + (a > b ? 3000 : (a < b ? -3000 : 0)) * k;
    }
    return s;
  }

  /* ==========================================================================
     三、階級遮罩 —— 「一顆 side 方的子放在 sq,會被哪些階級吃掉」
     ──────────────────────────────────────────────────────────────────────────
       回傳位元遮罩:第 r 位 = 1 表示「階級 r 的子站在 sq 會被 atk 方吃掉」。
       ★ 同一支同時服務兩個問題(對稱的):
         • 我的子放那裡安不安全 → threatMask(st, sq, 敵方)
         • 敵方的子出現在那裡我吃不吃得到 → threatMask(st, sq, 我方)
     ========================================================================== */
  function threatMask(st, sq, atk){
    let mask = 0;
    // 相鄰的一般吃法(★ 炮貼身吃不到,跳過)
    const nb = DC.nbs(sq);
    for(let k = 0; k < nb.length; k++){
      const p = knownAt(st, nb[k]);
      if(p === null || DC.sideOf(p) !== atk) continue;
      const pr = DC.rankOf(p);
      if(pr === DC.R_PAO) continue;
      for(let r = 1; r <= 7; r++) if(DC.canBeat(pr, r)) mask |= (1 << r);
    }
    // 沿四方向:第一顆子看「直衝的車」,炮架之後的第一顆看「炮」
    for(let d = 0; d < 4; d++){
      const line = DC.ray(sq, DIRS4[d]);
      let screen = false;
      for(let k = 0; k < line.length; k++){
        if(!occupied(st, line[k])) continue;
        const p = knownAt(st, line[k]);
        if(!screen){
          /* ★ 直衝:距離 >= 2、中間全空的敵方車。k > 0 才算(貼身走一般吃法,
             上面那個迴圈已經處理過了)。 */
          if(k > 0 && st.rules.rush && p !== null && DC.sideOf(p) === atk &&
             DC.rankOf(p) === DC.R_JU){
            if(st.rules.rushBig) mask |= ALL_RANKS;
            else for(let r = 1; r <= 7; r++) if(DC.canBeat(DC.R_JU, r)) mask |= (1 << r);
          }
          screen = true;
          continue;
        }
        // ★ 炮隔一顆打得到,而且不受階級限制
        if(p !== null && DC.sideOf(p) === atk && DC.rankOf(p) === DC.R_PAO) mask |= ALL_RANKS;
        break;
      }
    }
    return mask;
  }

  /* ==========================================================================
     四、賭一把的期望值 —— ★ 會翻開暗棋的三種手都走這裡,一律不模擬
     ========================================================================== */

  // 翻開 sq 這一格(對 mover 這個座位而言值多少)
  function gambleFlip(st, sq, mover, vt, tally){
    if(!tally.total) return 0;
    // ⚠ 第一手顏色還沒定 → 兩邊都可能是自己的,拿紅方當基準算(對稱,不影響選格)
    const mySide = st.col[mover] < 0 ? DC.RED : st.col[mover];
    const dangerMask = threatMask(st, sq, 1 - mySide);   // 翻出我的子 → 會被誰吃
    const chanceMask = threatMask(st, sq, mySide);       // 翻出敵子 → 我吃不吃得到
    let total = 0;
    for(let p = 0; p < 14; p++){
      const n = tally[p];
      if(!n) continue;
      const r = DC.rankOf(p), v = vt[p], bit = 1 << r;
      if(DC.sideOf(p) === mySide) total += n * ((dangerMask & bit) ? -v * 0.9 : v * 0.10);
      else                        total += n * ((chanceMask & bit) ? v * 0.9 : -v * 0.10);
    }
    /* ★ 開局要肯翻 —— 全是暗棋時每一手都在賭,不給一點誘因 AI 會原地磨到判和。
       盤上剩的暗棋越少,這個誘因越小。 */
    return total / tally.total + tally.total * 0.6;
  }

  /* 炮打 sq 那一格的暗子。★ 兩種下場(v1.118.0 起,見 rules.js 檔頭第 3 條):
       · 翻出敵子   → 吃掉,不受階級限制
       · 翻出自己人 → **只是把它翻開,兩顆都活**
     ⚠ 打到自己人**不再是虧一顆子**(舊版寫成 -vt[p],那是照著錯的規則算的)——
       但它仍然是虧的:白花一手,還順手把自己的一顆子攤給對手看。
       係數 0.15 與 gambleDark 的②**刻意同一個** —— 兩邊是同一件事,不該給不同的價。 */
  function gambleCannon(st, sq, mover, vt, tally){
    if(!tally.total) return 0;
    const mySide = st.col[mover];
    let total = 0;
    for(let p = 0; p < 14; p++){
      const n = tally[p];
      if(!n) continue;
      total += n * ((DC.sideOf(p) === mySide) ? -vt[p] * 0.15 : vt[p]);
    }
    return total / tally.total;
  }

  /* 翻攻 sq 那一格的暗子(三種下場,見 rules.js 的 applyDark)。
     ⚠ ③ 吃不動時 v1.120.x 起**不再被反吃**(兩顆都活,白花一手)——
       跟②(翻到自己人)一樣沒有材料損益,估值給 0。 */
  function gambleDark(st, from, sq, mover, vt, tally){
    if(!tally.total) return 0;
    const mySide = st.col[mover];
    const mine = knownAt(st, from);
    if(mine === null) return 0;
    const myRank = DC.rankOf(mine);
    let total = 0;
    for(let p = 0; p < 14; p++){
      const n = tally[p];
      if(!n) continue;
      if(DC.sideOf(p) === mySide)                    total += n * (-vt[p] * 0.15);  // ② 白翻一顆
      else if(DC.canBeat(myRank, DC.rankOf(p)))      total += n * vt[p];            // ① 吃掉
      // ③ 吃不動 → 白花一手,兩顆都活,不加不扣(total += 0)
    }
    return total / tally.total;
  }

  /* 車直衝打到還沒翻開的暗子(三種下場,見 rules.js 的 applyRushDark)。
     ⚠ 跟 gambleDark() 幾乎一樣,差別只有一個:rushBig 開著時①(吃得動)不看階級 ——
       呼應 applyRushDark() 的判定,兩支數字對不起來的話 AI 會低估 rushBig 開著時
       車直衝打暗子的價值(明明吃得動卻估成吃不動)。 */
  function gambleRushDark(st, from, sq, mover, vt, tally){
    if(!tally.total) return 0;
    const mySide = st.col[mover];
    const mine = knownAt(st, from);
    if(mine === null) return 0;
    const myRank = DC.rankOf(mine);
    const rushBig = !!(st.rules && st.rules.rushBig);
    let total = 0;
    for(let p = 0; p < 14; p++){
      const n = tally[p];
      if(!n) continue;
      if(DC.sideOf(p) === mySide)                              total += n * (-vt[p] * 0.15);  // ② 白翻一顆
      else if(rushBig || DC.canBeat(myRank, DC.rankOf(p)))    total += n * vt[p];              // ① 吃掉
      // ③ 吃不動 → 白花一手,兩顆都活,不加不扣(total += 0)
    }
    return total / tally.total;
  }

  /* ==========================================================================
     五、搜尋
     ──────────────────────────────────────────────────────────────────────────
       ★ 只展開**不會翻開暗棋**的手;會翻的那些一律用 gamble*() 當葉子。
         這既是為了不作弊,也順便把分枝數壓下來(開局那 32 個翻棋選項不展開)。
     ========================================================================== */
  function cloneSt(st){
    const cells = new Array(DC.NSQ);
    for(let i = 0; i < DC.NSQ; i++){
      const c = st.cells[i];
      cells[i] = c ? { p: c.p, up: c.up } : null;
    }
    return {
      rules: st.rules, cells: cells, col: [st.col[0], st.col[1]], turn: st.turn,
      chainFrom: st.chainFrom, chainLen: st.chainLen, idle: st.idle,
      caps: [st.caps[0].slice(), st.caps[1].slice()],
      over: st.over, winner: st.winner, endBy: st.endBy, last: st.last, bad: st.bad
    };
  }

  // 這一手會不會翻開某個暗格(→ 不准模擬)
  function reveals(st, mv){
    if(mv[0] === "f") return true;
    if(mv[0] !== "m") return false;
    return isDark(st, DC.unSq(mv[2]));
  }

  /* 會翻牌的那一手,對「走這一手的人」值多少。
     ⚠ 炮 vs 翻攻要看**這顆子是不是炮**,不能看 st.chainFrom >= 0 —— chainDark 開著時
       翻攻第一步就能發生(rules.js 的 capTargets() 不再限定在鏈中),用「在不在鏈中」
       判斷會把第一步的翻攻誤判成炮打暗子(兩者的下場公式完全不同)。
     ⚠⚠ v1.137.5 起多一種要分辨:**車直衝打暗子**(rules.js 的 rushDark)——判準是
       「這顆子是車,而且 to 不是 from 的鄰居」(車直衝規則本身就要求距離 >= 2,
       鄰格的暗子一定是走 dark 那條鄰格翻攻,不是 rushDark)。跟炮/翻攻分岔同一個
       道理:三條的下場估值公式**不一樣**(rushDark 多一個 rushBig 不看階級的出口),
       混到哪一條估值都會算錯。 */
  function gambleOf(st, mv, mover, vt, tally){
    if(mv[0] === "f") return gambleFlip(st, DC.unSq(mv[1]), mover, vt, tally);
    const from = DC.unSq(mv[1]), to = DC.unSq(mv[2]);
    const mine = knownAt(st, from);
    if(mine !== null && DC.rankOf(mine) === DC.R_PAO) return gambleCannon(st, to, mover, vt, tally);
    if(mine !== null && DC.rankOf(mine) === DC.R_JU && DC.nbs(from).indexOf(to) < 0){
      return gambleRushDark(st, from, to, mover, vt, tally);
    }
    return gambleDark(st, from, to, mover, vt, tally);
  }

  // 排序用的「立即收益」(不是估值)
  function quickGain(st, mv, vt){
    if(mv === DC.STOP || mv[0] === "f") return 0;
    const p = knownAt(st, DC.unSq(mv[2]));
    return p === null ? 0 : vt[p];
  }

  /* negamax + alpha-beta。depth 以「半手」計。
     ⚠ 回傳的一律是**對 me(固定的那個座位)**的分數,不是對當前走子方的 ——
       暗棋有連吃,同一個座位可能連走好幾個 ply,用「當前方」換號會算錯。 */
  function search(st, me, depth, alpha, beta, cfg){
    const vt = vals();
    if(st.over || depth <= 0) return evalPos(st, me, vt, cfg.hang);
    const mover = st.turn;
    const mvs = DC.legalMoves(st);
    if(!mvs.length) return evalPos(st, me, vt, cfg.hang);
    const maxing = (mover === me);

    let best = null, tally = null, base = null;
    const quiet = [];
    for(let i = 0; i < mvs.length; i++){
      const mv = mvs[i];
      if(reveals(st, mv)){
        /* ⚠ 對手的翻牌也要算 —— 少了它,AI 會以為對手只能乾等。
           ⚠ 這一支**不遞迴**(遞迴就得展開暗棋的真值 = 作弊),所以它拿的是
             「靜態盤面 + 這一賭的期望值」,與被展開的手不是同一個尺度。
             cfg.gK 就是在補這件事:賭的那一邊乘一個折扣,不然淺看的手永遠比較好看。 */
        if(!tally){ tally = unseenTally(st); base = evalPos(st, me, vt, cfg.hang); }
        const sc = base + (maxing ? 1 : -1) * gambleOf(st, mv, mover, vt, tally) * cfg.gK;
        if(best === null || (maxing ? sc > best : sc < best)) best = sc;
      }else{
        quiet.push(mv);
      }
    }
    if(best !== null){
      if(maxing){ if(best > alpha) alpha = best; }
      else { if(best < beta) beta = best; }
    }

    quiet.sort((a, b) => quickGain(st, b, vt) - quickGain(st, a, vt));
    for(let i = 0; i < quiet.length && alpha < beta; i++){
      const nx = cloneSt(st);
      if(!DC.step(nx, quiet[i])) continue;
      const sc = search(nx, me, depth - 1, alpha, beta, cfg);
      if(best === null || (maxing ? sc > best : sc < best)) best = sc;
      if(maxing){ if(best > alpha) alpha = best; }
      else { if(best < beta) beta = best; }
    }
    return best === null ? evalPos(st, me, vt, cfg.hang) : best;
  }

  /* ==========================================================================
     六、選一手
     ========================================================================== */
  /* ★ 三個難度的全部差異都在這張表裡(exported —— tools/test-dc-ai.js 的調參實驗
     直接往上面加一筆就能跑,不必動這一支)。
       depth 搜幾個半手 · hang 要不要算掛子 · gK 賭的折扣(見 search() 裡的說明) */
  const CFG = {
    easy: { depth: 0, hang: false, gK: 1 },
    mid:  { depth: 1, hang: true,  gK: 1 },
    hard: { depth: 2, hang: true,  gK: 0.7 }
  };
  const LEVELS = { easy: 0, mid: 1, hard: 3 };     // 舊名字留著給呼叫端看深度

  /* easy:只看眼前 —— 有得吃就吃最大的,其餘亂翻亂走,
     完全不看自己會不會被吃回去,也不看翻開那一格安不安全。 */
  function pickEasy(st, rng){
    const mvs = DC.legalMoves(st);
    if(!mvs.length) return null;
    const vt = vals();
    let best = [], bv = -Infinity;
    for(let i = 0; i < mvs.length; i++){
      const mv = mvs[i];
      let v;
      if(mv === DC.STOP) v = -1;                      // 有得吃就繼續吃
      else if(mv[0] === "f") v = 5;
      else{
        const to = DC.unSq(mv[2]), p = knownAt(st, to);
        v = (p !== null) ? vt[p] : (isDark(st, to) ? 20 : 0);
      }
      if(v > bv){ bv = v; best = [mv]; }
      else if(v === bv) best.push(mv);
    }
    return best[Math.floor(rng() * best.length)];
  }

  /* pick():回一個 move 字串(null = 沒有合法手,呼叫端要當成輸局處理)。
     ⚠ rng 一定要吃外面傳進來的 —— 單機那邊要能重現,對打腳本要能對照。 */
  function pick(st, me, level, rng){
    const r = rng || Math.random;
    if(!st || st.over || st.turn !== me) return null;
    if(level === "easy") return pickEasy(st, r);

    const cfg = CFG[level] || CFG.mid;
    const mvs = DC.legalMoves(st);
    if(!mvs.length) return null;
    const vt = vals();
    const tally = unseenTally(st);
    const base = evalPos(st, me, vt, cfg.hang);

    let best = [], bv = -Infinity;
    for(let i = 0; i < mvs.length; i++){
      const mv = mvs[i];
      let v;
      if(reveals(st, mv)){
        v = base + gambleOf(st, mv, me, vt, tally) * cfg.gK;
      }else{
        const nx = cloneSt(st);
        if(!DC.step(nx, mv)) continue;
        v = (cfg.depth <= 0) ? evalPos(nx, me, vt, cfg.hang)
                             : search(nx, me, cfg.depth, -Infinity, Infinity, cfg);
      }
      if(v > bv + 1e-9){ bv = v; best = [mv]; }
      else if(Math.abs(v - bv) <= 1e-9) best.push(mv);
    }
    if(!best.length) return mvs[0];
    return best[Math.floor(r() * best.length)];
  }

  // 連線那邊「時間到幫他走一手」一律用普通,不套難度(同 UNO 的 autoMove)
  function autoMove(st, me){ return pick(st, me, "mid", Math.random); }

  return {
    CFG, LEVELS, BASE,
    knownAt, occupied, isDark, unseenTally,
    vals, evalPos, threatMask,
    gambleFlip, gambleCannon, gambleDark, gambleRushDark, gambleOf,
    cloneSt, reveals, search,
    pickEasy, pick, autoMove
  };
})();

/* node 測試用 */
if (typeof module !== "undefined" && module.exports){
  if (typeof DC === "undefined") global.DC = require("./rules.js");
  module.exports = DCAI;
}

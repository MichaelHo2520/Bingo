"use strict";

/* ============================================================================
   象棋暗棋 — 規則引擎(DC)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/sevens/rules.js、js/big2/rules.js、js/uno/rules.js:
     「這一手合不合法」「這局誰贏」只有靠 node 大量對局才驗得出來,
     碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── 玩法(規則來源與各家分歧見 notes/19)──────────────────────────────────
     象棋 32 顆子蓋著隨機擺滿 4×8 的半張棋盤。輪流二選一:**翻開一顆暗棋**,
     或**動一顆自己的明棋**(上下左右一格,走空格或吃敵方明棋)。
     **先手第一次翻到什麼顏色,那個顏色就是他的。**
     階級 將7 > 士6 > 象5 > 車4 > 馬3 > 包2 > 卒1,大吃小、同級可吃,
     **卒吃將、將不吃卒**。把對方吃光,或讓對方無步可走,就贏。

   ── ★★ 炮的三條(這是暗棋與象棋差最多的地方)────────────────────────────
     1. **不能貼身吃** —— 相鄰的子炮一顆都吃不到。
     2. 沿直線隔**恰好一顆**子(任意顏色、明暗皆可)當炮架跳過去吃,
        **距離不限、不受階級限制**(炮可以吃將)。
     3. **炮可以打暗子** —— 沒有這一條,開局滿盤都是暗子時炮等於一顆廢子。
        ★★ 但**翻開是自己人就只是翻開,兩顆都活**,不是吃掉 ——
          規則來源(維基「暗棋」)寫得很死:「炮亦能隔一棋吃暗棋,**除翻開後為己棋外**,
          只要是敵棋皆可吃」「若翻開後為己方棋子,**視為單純翻棋,二棋皆存活**」。
          ⚠ v1.118.0 以前寫成「不論敵我一律吃掉」,那是自己想出來的,查無出處
            (使用者:「哪有在吃自己人的」)。改回來之後炮打暗子的下場只剩兩種,
            與連吃翻攻的②完全同構 —— 兩邊的「翻到自己人」都是白花一手。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 棋子 / 格子 / 一手的編碼與 deal 字串
     • moveTargets():這顆子現在能去 / 能吃哪幾格(給畫面亮格,也給 AI 展開)
     • replay():從 deal + moves 重算一整局的真相  ★ 唯一的真相入口
     • score():結算
   不負責:AI(ai.js)、畫面(board.js)、輪次驅動(solo.js / adapter.js)。

   ── ★★★ 連吃為什麼是「一步一個 move」而不是「一手一串落點」────────────────
     連吃本來是**一手**(吃到不能吃 / 自己喊停為止),直覺會想把整串落點包成一個
     move 字串。**但房規 `chainDark` 會在鏈中途翻牌** —— 翻開是什麼決定了還能不能
     續吃,而那是玩家**看到之後**才做得了的決定。包成一串等於逼他瞎猜。
     所以落地成:一步一個 move,**回合停在同一個人身上**(`st.chainFrom >= 0`),
     直到無子可續吃(自動結束)或他送出 `"s"`(自己喊停)。
     ⚠ 副作用是好的:每一步都是原子 append,連線那邊的交易機制原封不動就能用。
     ⚠ 因此 **turn 絕不可以用 `moves.length % 2` 取模** —— 連吃會讓步數與座位脫鉤。
       一律問 `replay()` 的 `st.turn`。這條有測試守著。

   ── 一手的編碼 ────────────────────────────────────────────────────────────
     "f<格>"            翻開一顆暗棋
     "m<from><to>"      走 / 吃(單步;含炮跳與車直衝,by kind 自動分辨)
     "s"                自己喊停,結束連吃
     格 = base-32 單字元(0-9a-v)。⚠ 一律可列印 ASCII(這個 repo 被 cp950 咬過)。
   ========================================================================== */

const DC = (function(){

  /* ==========================================================================
     一、編碼
     ──────────────────────────────────────────────────────────────────────────
       盤面是 **4 列 × 8 行**(半張象棋盤),格 index = row * 8 + col。
       ⚠ 直立手機上畫面會轉成 8 列 × 4 行,那是 board.js 的事 ——
         規則層一律用這一套座標,兩邊混用會讓「上下左右」整個錯亂。
     ========================================================================== */
  const ROWS = 4, COLS = 8, NSQ = 32;

  const RED = 0, BLACK = 1;
  // 階級 1..7(數字越大越大;唯一的例外是卒吃將)
  const R_ZU = 1, R_PAO = 2, R_MA = 3, R_JU = 4, R_XIANG = 5, R_SHI = 6, R_JIANG = 7;
  const COUNTS = [5, 2, 2, 2, 2, 2, 1];        // rank 1..7 各幾顆(合計 16)
  const NAME = [
    ["兵", "炮", "傌", "俥", "相", "仕", "帥"],   // 紅 rank 1..7
    ["卒", "包", "馬", "車", "象", "士", "將"]    // 黑 rank 1..7
  ];
  const SIDE_NAME = ["紅", "黑"];

  const sideOf  = p => (p / 7) | 0;
  const rankOf  = p => (p % 7) + 1;
  const pieceOf = (side, rank) => side * 7 + (rank - 1);
  const nameOf  = p => NAME[sideOf(p)][rankOf(p) - 1];
  const sideName = s => SIDE_NAME[s] || "";

  /* deal 是 32 個字元的字串,一格一個字元 = 那一格底下蓋的是哪顆子(A~N = 0~13)。 */
  const pChr   = p => String.fromCharCode(65 + p);
  const pUnchr = ch => {
    const k = ch.charCodeAt(0);
    return (k >= 65 && k <= 78) ? k - 65 : -1;      // A..N
  };
  /* 格的字元:base-32(0-9a-v)。⚠ 大小寫不混用 —— 上面的棋子用大寫,這裡用小寫 + 數字,
     所以看一個字元就知道它是棋子還是格子(手動讀 DB 時省很多事)。 */
  const SQ_CH = "0123456789abcdefghijklmnopqrstuv";
  const sqChr = i => SQ_CH[i];
  const unSq  = ch => SQ_CH.indexOf(ch);

  function encodeDeal(arr){ return arr.map(pChr).join(""); }
  function decodeDeal(s){
    if(typeof s !== "string" || s.length !== NSQ) return null;
    const out = [], tally = [];
    for(let i = 0; i < 14; i++) tally.push(0);
    for(let i = 0; i < NSQ; i++){
      const p = pUnchr(s[i]);
      if(p < 0) return null;                         // 不認得 → 整份不收
      tally[p]++;
      out.push(p);
    }
    // ⚠ 每一種棋子的顆數也要對:少一顆將 / 多一顆車的 deal 會讓整局的判定失去意義
    for(let side = 0; side < 2; side++){
      for(let r = 1; r <= 7; r++){
        if(tally[pieceOf(side, r)] !== COUNTS[r - 1]) return null;
      }
    }
    return out;
  }

  const encFlip = sq => "f" + sqChr(sq);
  const encMove = (from, to) => "m" + sqChr(from) + sqChr(to);
  const STOP = "s";
  /* 投降。★★ **要帶座位**,不可以像 STOP 那樣吃 st.turn ——
     投降不必等輪到自己(對手在想的時候也按得下去),而 moves 是兩台共用的一條序列,
     沒帶座位的話重播出來會變成「輪到誰誰就投降」。 */
  const encResign = seat => "g" + (seat === 1 ? "1" : "0");

  /* ==========================================================================
     二、幾何
     ========================================================================== */
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const rowOf = i => (i / COLS) | 0;
  const colOf = i => i % COLS;

  function nbs(i){
    const r = rowOf(i), c = colOf(i), out = [];
    if(r > 0)        out.push(i - COLS);
    if(r < ROWS - 1) out.push(i + COLS);
    if(c > 0)        out.push(i - 1);
    if(c < COLS - 1) out.push(i + 1);
    return out;
  }
  const adjacent = (a, b) => nbs(a).indexOf(b) >= 0;

  // 從 i 出發沿 d 的所有格(由近而遠)
  function ray(i, d){
    let r = rowOf(i), c = colOf(i);
    const out = [];
    for(;;){
      r += d[0]; c += d[1];
      if(r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      out.push(r * COLS + c);
    }
    return out;
  }

  /* ==========================================================================
     三、房規
     ──────────────────────────────────────────────────────────────────────────
       ★★ 巢狀關係只在 normRules() 這一個地方落地(chainDark 依賴 chain、
          rushBig 依賴 rush)—— UI 只要把子項灰掉,真相層照樣自己守得住。
          漏掉這一層的症狀是「連吃關著、暗棋連吃卻還在生效」。
     ========================================================================== */
  function defRules(){
    return { chain: false, chainDark: false, rush: false, rushBig: false, foeCaps: false };
  }
  function normRules(o){
    const r = defRules();
    if(o && typeof o === "object"){
      r.chain    = !!o.chain;
      r.chainDark = !!o.chainDark && r.chain;
      r.rush     = !!o.rush;
      r.rushBig  = !!o.rushBig && r.rush;
      r.foeCaps  = !!o.foeCaps;
    }
    return r;
  }
  /* ★★ 三段式:面板一組只給玩家選「第幾段」(0 無 / 1 / 2),不再讓他自己拼四個布林。
     ⚠ 巢狀關係**仍然只在 normRules() 落地** —— 這兩支只是把「段」翻成那四個布林,
       手改 DB / 舊房間存的怪組合(chainDark 開著但 chain 關著)照樣由 normRules 收拾。 */
  const RULE_LVS = {
    chain: [{ chain: false, chainDark: false },
            { chain: true,  chainDark: false },
            { chain: true,  chainDark: true }],
    rush:  [{ rush: false, rushBig: false },
            { rush: true,  rushBig: false },
            { rush: true,  rushBig: true }],
    /* ★ `foeCaps` 是唯一一條**不影響任何判定**的房規 —— 它只管畫面上看不看得到
       「對手吃掉了什麼」。放在房規而不是各人偏好,是因為那關係到公平:
       兩邊拿到的資訊必須一樣,不可以一邊看得到一邊看不到。
       ⚠ 因此它也跟著 `game.rules` **開局凍結** —— 副作用剛好是好的:
         動作列的高度在一局裡不會變(見 board.js 的 ⚠⚠⚠)。
       ⚠ 自己吃掉的**永遠顯示**,不受這條管(那是自己的戰果,不是對手的情報)。 */
    caps:  [{ foeCaps: false }, { foeCaps: true }]
  };
  const LV_TEXT = {
    chain: ["", "明棋連吃", "暗棋連吃"],
    rush:  ["", "車直衝", "直衝吃大子"],
    caps:  ["", "顯示對手吃子"]
  };
  function ruleLevel(o, kind){
    const r = normRules(o);
    if(kind === "chain") return r.chain ? (r.chainDark ? 2 : 1) : 0;
    if(kind === "rush")  return r.rush  ? (r.rushBig  ? 2 : 1) : 0;
    if(kind === "caps")  return r.foeCaps ? 1 : 0;
    return 0;
  }
  function setRuleLevel(o, kind, lv){
    const set = RULE_LVS[kind];
    if(!set) return normRules(o);
    const n = Math.max(0, Math.min(set.length - 1, (+lv) || 0));
    return normRules(Object.assign({}, normRules(o), set[n]));
  }
  function rulesText(o){
    const r = normRules(o), on = [];
    const c = ruleLevel(r, "chain"), u = ruleLevel(r, "rush"), p = ruleLevel(r, "caps");
    if(c) on.push(LV_TEXT.chain[c]);
    if(u) on.push(LV_TEXT.rush[u]);
    if(p) on.push(LV_TEXT.caps[p]);
    return on.length ? on.join(" · ") : "標準暗棋";
  }

  /* 悶局:連續這麼多步沒有吃子也沒有翻子。
     ⚠ 各家寫 40 或 50 都有;取 40 —— 這個 App 是現場聚會,乾耗的那幾步很難看。
     ★★ 悶到底**不是直接和局**,而是「比剩餘子的階級總和」(維基那條「最後僅剩三棋時
        比較等級總和」的推廣)—— 完全相同才是真的和局。
        理由是實測出來的:兩邊都不掛子的時候,誰先動誰吃虧 → 大家原地繞圈,
        AI 對打 88% 以和局收場,現場玩起來就是「什麼都沒發生」。
        改成比總和之後,領先的一方樂得拖、落後的一方**非攻不可** —— 那才是暗棋的張力。
     ⚠ 這個總和**不含隱藏資訊**:某方剩餘子的階級總和 = 52 − 他被吃掉那些子的階級和,
        而被吃掉的一定都現過身 → AI 算得出來,不算作弊。 */
  const IDLE_DRAW = 40;
  const FULL_SUM = 52;                          // 一方 16 顆的階級總和 5+4+6+8+10+12+7

  /* ==========================================================================
     四、吃子關係
     ──────────────────────────────────────────────────────────────────────────
       ★ 只有兩條例外:**卒吃將**、**將不吃卒**;其餘一律「階級 >= 就吃得動」。
       ⚠ 炮**不走這一支** —— 炮的隔子吃不受階級限制(見檔頭)。
         但炮**被吃**的時候走這一支(所以卒吃不掉炮:canBeat(1,2) = false)。
     ========================================================================== */
  function canBeat(a, b){
    if(a === R_ZU && b === R_JIANG) return true;
    if(a === R_JIANG && b === R_ZU) return false;
    return a >= b;
  }

  /* ==========================================================================
     五、局面
     ──────────────────────────────────────────────────────────────────────────
       cells[i] = null(空格)| { p:棋子, up:翻開了沒 }
       col[seat] = 該座位的顏色(RED / BLACK),-1 = 還沒定(第一手翻棋才定)
     ========================================================================== */
  function blank(pieces, rules){
    const cells = [];
    for(let i = 0; i < NSQ; i++) cells.push({ p: pieces[i], up: false });
    return {
      rules: normRules(rules),
      cells: cells,
      col: [-1, -1],            // 座位 → 顏色
      turn: 0,
      chainFrom: -1,            // ★ >= 0 = 連吃進行中,回合還在同一個人身上
      chainLen: 0,              // 這一手已經連吃幾顆(給畫面 / 音效)
      idle: 0,                  // 連續幾步沒吃沒翻
      caps: [[], []],           // 各座位吃掉的**敵方**子
      /* ★ 自己賠掉的己方子。**只有一條路進得來**:連吃翻攻踩到吃不動的敵子而自爆(③)。
         ⚠ v1.118.0 以前還有「炮打暗子打到自己人」那一條,而那條規則本身是錯的
           (見檔頭第 3 條)—— 現在炮打到自己人兩顆都活,不進這裡。
         ⚠⚠ 自爆記在**自己這一欄**而不是對手的 caps:規則來源的字是「視同踩中地雷自爆」,
           那是自己走進去的,不是對方吃到的。吃子欄的 💥 講的就是這一欄。 */
      friendly: [[], []],
      over: false,
      winner: -1,               // 0 / 1;-1 = 和局(要配 over 才有意義)
      endBy: "",                // "wipe" | "stuck" | "count" | "draw" | "resign"
      last: null,
      bad: -1
    };
  }

  const sideAt   = (st, i) => { const c = st.cells[i]; return c && c.up ? sideOf(c.p) : -1; };
  const seatSide = (st, seat) => st.col[seat];
  function seatOfSide(st, side){
    if(st.col[0] === side) return 0;
    if(st.col[1] === side) return 1;
    return -1;
  }

  /* ==========================================================================
     六、這顆子能去哪 / 能吃誰
     ──────────────────────────────────────────────────────────────────────────
       回傳 [{ to, kind }],kind:
         "move"  走到相鄰空格(不吃)
         "eat"   吃相鄰的敵方明棋
         "jump"  炮隔子跳吃(目標可以是暗棋)
         "rush"  車直衝(房規 rush;距離 >= 2、中間全空、目標是敵方明棋)
         "dark"  翻攻相鄰暗棋(房規 chainDark;第一步或連吃鏈中皆可,見 capTargets())
     ========================================================================== */

  // 炮:沿四方向找「炮架之後的第一顆子」
  function paoTargets(st, from, mySide){
    const out = [];
    for(let di = 0; di < DIRS.length; di++){
      const line = ray(from, DIRS[di]);
      let screen = false;
      for(let k = 0; k < line.length; k++){
        const cell = st.cells[line[k]];
        if(!cell) continue;                        // 空格 → 繼續往前找
        if(!screen){ screen = true; continue; }    // 這一顆當炮架
        /* 炮架之後的第一顆 = 目標。
           ★ 暗棋照打(翻開之後不論敵我一律吃掉,見檔頭);
           ⚠ 已經翻開而且是自己的子 → 打不得,而且它也把這條線擋死了。 */
        if(!cell.up || sideOf(cell.p) !== mySide) out.push({ to: line[k], kind: "jump" });
        break;
      }
    }
    return out;
  }

  // 車直衝:沿四方向,中間全空、距離 >= 2 的第一顆敵方明棋
  function rushTargets(st, from, mySide){
    if(!st.rules.rush) return [];
    const out = [];
    for(let di = 0; di < DIRS.length; di++){
      const line = ray(from, DIRS[di]);
      for(let k = 0; k < line.length; k++){
        const cell = st.cells[line[k]];
        if(!cell) continue;                        // 空格 → 繼續往前衝
        /* ⚠ k === 0 = 貼身 —— 相鄰的照一般吃法走一格,不算直衝
             (規則來源明寫「不能相鄰」;少了這一條,rushBig 開著時車會變成
              「隨手撞掉旁邊的將」,一般吃法那條階級限制形同虛設)。 */
        if(k > 0 && cell.up && sideOf(cell.p) !== mySide &&
           (st.rules.rushBig || canBeat(R_JU, rankOf(cell.p)))){
          out.push({ to: line[k], kind: "rush" });
        }
        break;                                     // 不論吃不吃得到,第一顆子就擋住了
      }
    }
    return out;
  }

  /* 純吃子的落點(不含走空格)。連吃鏈續吃、以及一般吃子都吃這一支。
     ★ chainDark 開著時,翻攻相鄰暗棋**不限定在鏈中**(使用者:「連吃要可以吃沒有
       打開的牌,現在是第一張一定要是明牌,但我要的是第一步暗牌也可以吃」)——
       第一步也能拿它當暗殺用,吃得動就照樣啟動連吃(見 afterCapture())。 */
  function capTargets(st, from, mySide){
    const cell = st.cells[from];
    if(!cell || !cell.up || sideOf(cell.p) !== mySide) return [];
    const myRank = rankOf(cell.p);
    if(myRank === R_PAO) return paoTargets(st, from, mySide);   // ★ 炮只有隔子吃這一種

    const out = [];
    const list = nbs(from);
    for(let k = 0; k < list.length; k++){
      const t = list[k], c = st.cells[t];
      if(!c) continue;
      if(c.up){
        if(sideOf(c.p) !== mySide && canBeat(myRank, rankOf(c.p))) out.push({ to: t, kind: "eat" });
      }else if(st.rules.chainDark){
        /* ★ 翻攻:合不合法在**這裡**不看底下是什麼(看了就是作弊)——
           賭的結果在 applyDark() 才揭曉。 */
        out.push({ to: t, kind: "dark" });
      }
    }
    if(myRank === R_JU) rushTargets(st, from, mySide).forEach(x => out.push(x));
    return out;
  }

  /* 這顆子這一步能去哪(含走空格)。⚠ 連吃進行中請改用 chainTargets()。 */
  function moveTargets(st, from){
    if(st.over) return [];
    if(from < 0 || from >= NSQ) return [];
    const mySide = seatSide(st, st.turn);
    if(mySide < 0) return [];
    const cell = st.cells[from];
    if(!cell || !cell.up || sideOf(cell.p) !== mySide) return [];
    if(st.chainFrom >= 0) return from === st.chainFrom ? chainTargets(st) : [];

    const out = capTargets(st, from, mySide);
    // 走空格:一律相鄰一格(炮也是;車直衝**只**用來吃子,不能當移動)
    nbs(from).forEach(t => { if(!st.cells[t]) out.push({ to: t, kind: "move" }); });
    return out;
  }

  // 連吃進行中還能續吃哪幾格(空陣列 = 只能停,而 step 會自動幫他停)
  function chainTargets(st){
    if(st.over || st.chainFrom < 0) return [];
    return capTargets(st, st.chainFrom, seatSide(st, st.turn));
  }

  // 可以翻的格
  function flipTargets(st){
    if(st.over) return [];
    const out = [];
    if(st.chainFrom >= 0) return out;              // ⚠ 連吃鏈中不准改去翻棋
    for(let i = 0; i < NSQ; i++){
      const c = st.cells[i];
      if(c && !c.up) out.push(i);
    }
    return out;
  }

  /* ==========================================================================
     七、推進一手
     ========================================================================== */
  function endTurn(st){
    st.chainFrom = -1;
    st.chainLen = 0;
    st.turn = 1 - st.turn;
    checkEnd(st);
  }

  // 吃完之後:還能續吃就把回合留著,不能就換手
  function afterCapture(st, to){
    if(st.rules.chain){
      st.chainFrom = to;
      st.chainLen++;
      if(!chainTargets(st).length) st.chainFrom = -1;
    }
    if(st.chainFrom < 0) endTurn(st);
    else checkEnd(st);                             // ★ 吃光對方就結束,不必等他喊停
  }

  function doFlip(st, sq){
    if(st.chainFrom >= 0) return false;            // 連吃鏈中只能續吃或喊停
    const c = st.cells[sq];
    if(!c || c.up) return false;
    c.up = true;
    // ★ 第一手翻到什麼顏色,先手就是那個顏色
    if(st.col[0] < 0){
      const s = sideOf(c.p);
      st.col[st.turn] = s;
      st.col[1 - st.turn] = 1 - s;
    }
    st.idle = 0;
    st.last = { kind: "flip", seat: st.turn, to: sq, p: c.p };
    endTurn(st);
    return true;
  }

  /* 連吃鏈中的翻攻(kind === "dark")。★ 三種下場,而它們是這條房規的全部風險:
       ① 翻開是敵子而且吃得動 → 照吃,鏈可以繼續
       ② 翻開是**自己的子**   → 那顆子留在原地翻開,這一手到此為止
       ③ 翻開是敵子但**吃不動** → 攻擊方的子被反吃掉(傳統「暗殺」的下場)
     ⚠ ③ 是刻意的:少了它,chainDark 就變成純賺的免費偵查,開不開沒有取捨。 */
  function applyDark(st, from, to){
    const me = st.cells[from], vic = st.cells[to];
    vic.up = true;
    st.idle = 0;
    const mySide = sideOf(me.p);
    if(sideOf(vic.p) === mySide){                             // ②
      st.last = { kind: "darkSelf", seat: st.turn, from: from, to: to, p: me.p, got: vic.p };
      endTurn(st);
      return true;
    }
    if(canBeat(rankOf(me.p), rankOf(vic.p))){                 // ①
      st.caps[st.turn].push(vic.p);
      st.cells[to] = me;
      st.cells[from] = null;
      st.last = { kind: "darkEat", seat: st.turn, from: from, to: to, p: me.p, got: vic.p };
      afterCapture(st, to);
      return true;
    }
    /* ③ 被反吃 —— 規則來源的字是「視同踩中地雷自爆」,所以記在**自己的 friendly**
       而不是對手的 caps:那不是對方吃到的,是自己走進去的(見 blank() 那一段)。 */
    st.cells[from] = null;
    st.friendly[st.turn].push(me.p);
    st.last = { kind: "darkLose", seat: st.turn, from: from, to: to, p: me.p, got: vic.p };
    endTurn(st);
    return true;
  }

  function doMove(st, from, to){
    const mySide = seatSide(st, st.turn);
    if(mySide < 0) return false;
    if(from < 0 || from >= NSQ || to < 0 || to >= NSQ) return false;
    if(st.chainFrom >= 0 && from !== st.chainFrom) return false;

    const list = st.chainFrom >= 0 ? chainTargets(st) : moveTargets(st, from);
    let kind = "";
    for(let i = 0; i < list.length; i++) if(list[i].to === to){ kind = list[i].kind; break; }
    if(!kind) return false;

    const me = st.cells[from];
    if(kind === "dark") return applyDark(st, from, to);

    if(kind === "move"){
      st.cells[to] = me;
      st.cells[from] = null;
      st.idle++;
      st.last = { kind: "move", seat: st.turn, from: from, to: to, p: me.p };
      endTurn(st);
      return true;
    }

    // eat / jump / rush —— 都是「吃掉那一格,自己搬過去」
    const vic = st.cells[to];
    if(!vic.up) vic.up = true;                     // ★ 炮打暗子:先翻開再看是誰
    /* ★★ 炮打到自己人 = **視為單純翻棋,二棋皆存活**(檔頭第 3 條)。
       炮留在原地、那顆子留在原地翻開,這一手就這樣沒了 —— 與連吃翻攻的②同構。
       ⚠ 只有**暗子**走得到這裡:已經翻開的己方子 paoTargets() 一開始就排掉了
         (而且它還把那條線擋死),所以這裡不必再判 kind。 */
    if(sideOf(vic.p) === mySide){
      st.idle = 0;
      st.last = { kind: "jumpSelf", seat: st.turn, from: from, to: to, p: me.p, got: vic.p };
      endTurn(st);
      return true;
    }
    st.caps[st.turn].push(vic.p);
    st.cells[to] = me;
    st.cells[from] = null;
    st.idle = 0;
    st.last = { kind: kind, seat: st.turn, from: from, to: to, p: me.p, got: vic.p };
    afterCapture(st, to);
    return true;
  }

  function doStop(st){
    if(st.chainFrom < 0) return false;             // 沒在連吃 → 這一手不存在
    st.last = { kind: "stop", seat: st.turn, from: st.chainFrom };
    endTurn(st);
    return true;
  }

  /* 投降。★★ 三件事與其它手不一樣,少想一件就是一個洞:
       ① **不必輪到自己** —— 帶座位就是為了這個(見 encResign)
       ② **不進 legalMoves()** —— 那一支是給 AI 展開用的,列進去電腦會自己投降
       ③ 連吃進行中照樣投得下去(直接結束整局,鏈的狀態由 finish 清掉) */
  function doResign(st, seat){
    if(seat !== 0 && seat !== 1) return false;
    st.last = { kind: "resign", seat: seat };
    finish(st, 1 - seat, "resign");
    return true;
  }

  /* 套用一手。回 true = 成功;false = 不合法(呼叫端要中止,不可以硬套下去)。 */
  function step(st, mv){
    if(st.over) return false;
    if(typeof mv !== "string" || !mv.length) return false;
    if(mv === STOP) return doStop(st);
    if(mv[0] === "g"){
      if(mv.length !== 2) return false;
      return doResign(st, mv[1] === "0" ? 0 : (mv[1] === "1" ? 1 : -1));
    }
    if(mv[0] === "f"){
      if(mv.length !== 2) return false;
      const sq = unSq(mv[1]);
      return sq < 0 ? false : doFlip(st, sq);
    }
    if(mv[0] === "m"){
      if(mv.length !== 3) return false;
      const a = unSq(mv[1]), b = unSq(mv[2]);
      return (a < 0 || b < 0) ? false : doMove(st, a, b);
    }
    return false;
  }

  /* ==========================================================================
     八、勝負
     ──────────────────────────────────────────────────────────────────────────
       順序是 **全滅 → 無步可走 → 和局**,而且不可以換:
       最後一顆被吃掉的那一手同時滿足前兩條(對方全滅、也的確走不動了),
       先問「無步可走」會把它記成 stuck —— 結果一樣但結果卡的文案會講錯話。
     ========================================================================== */
  function countSide(st, side){
    let n = 0;
    for(let i = 0; i < NSQ; i++){
      const c = st.cells[i];
      if(c && sideOf(c.p) === side) n++;           // ⚠ 暗子也算(它還在盤上)
    }
    return n;
  }

  /* 某方剩餘子的階級總和。⚠ 暗子也算 —— 但這**不是**在偷看:
     它恆等於 FULL_SUM 減掉「被吃掉的那些子」的階級和,而被吃掉的一定都現過身。 */
  function sumSide(st, side){
    let s = 0;
    for(let i = 0; i < NSQ; i++){
      const c = st.cells[i];
      if(c && sideOf(c.p) === side) s += rankOf(c.p);
    }
    return s;
  }

  function hasAnyMove(st, seat){
    for(let i = 0; i < NSQ; i++){ const c = st.cells[i]; if(c && !c.up) return true; }  // 還有得翻
    const side = seatSide(st, seat);
    if(side < 0) return false;
    for(let i = 0; i < NSQ; i++){
      const c = st.cells[i];
      if(!c || !c.up || sideOf(c.p) !== side) continue;
      if(capTargets(st, i, side).length) return true;
      const list = nbs(i);
      for(let k = 0; k < list.length; k++) if(!st.cells[list[k]]) return true;
    }
    return false;
  }

  function finish(st, winner, by){
    st.over = true; st.winner = winner; st.endBy = by;
    st.chainFrom = -1; st.chainLen = 0;
  }

  function checkEnd(st){
    if(st.over) return;
    if(st.col[0] >= 0){
      for(let seat = 0; seat < 2; seat++){
        if(countSide(st, seatSide(st, seat)) === 0){ finish(st, 1 - seat, "wipe"); return; }
      }
    }
    /* ⚠ 這裡**不必**為「連吃進行中」開特例,雖然直覺上很想加一條 `if(chainFrom >= 0) return`。
       連吃還沒結束時後兩條恆為假,而且是結構上的:
         • idle —— 剛剛才吃掉一顆,一定是 0
         • hasAnyMove —— 續吃的目標若是暗棋,它自己就是一顆「還可以翻的暗棋」;
           若是明棋,那個落點在 capTargets() 裡也照樣算得到
       多寫那一條就是一段**永遠到不了的碼**(拿掉它突變測試會存活),所以改成
       L 節的一條不變量斷言 —— 這是 UNO 那邊「測不到的碼拿掉、前提改成斷言」的同一招。 */
    if(!hasAnyMove(st, st.turn)){ finish(st, 1 - st.turn, "stuck"); return; }
    if(st.idle >= IDLE_DRAW){
      // ★★ 悶到底 → 比剩餘子的階級總和,完全相同才是真和局
      const a = sumSide(st, seatSide(st, 0)), b = sumSide(st, seatSide(st, 1));
      if(a > b)      finish(st, 0, "count");
      else if(b > a) finish(st, 1, "count");
      else           finish(st, -1, "draw");
      return;
    }
  }

  /* ==========================================================================
     九、replay —— ★ 一整局唯一的真相入口
     ========================================================================== */
  function replay(deal, moves, rules){
    const pieces = (typeof deal === "string") ? decodeDeal(deal) : deal;
    if(!pieces || pieces.length !== NSQ) return null;
    const st = blank(pieces, rules);
    const mv = Array.isArray(moves) ? moves : [];
    for(let i = 0; i < mv.length; i++){
      if(!step(st, mv[i])){ st.bad = i; break; }   // 不合法就停在這裡,不硬套
    }
    return st;
  }

  /* 現在這一手的全部合法選項(給 AI 展開,也給「無步可走」以外的地方用)。
     ⚠ 連吃鏈中只有「續吃」與「喊停」兩類 —— 不可以回翻棋 / 動別的子。 */
  function legalMoves(st){
    if(st.over) return [];
    const out = [];
    if(st.chainFrom >= 0){
      chainTargets(st).forEach(t => out.push(encMove(st.chainFrom, t.to)));
      out.push(STOP);
      return out;
    }
    flipTargets(st).forEach(sq => out.push(encFlip(sq)));
    const side = seatSide(st, st.turn);
    if(side < 0) return out;                       // 顏色還沒定 → 只能翻
    for(let i = 0; i < NSQ; i++){
      const c = st.cells[i];
      if(!c || !c.up || sideOf(c.p) !== side) continue;
      moveTargets(st, i).forEach(t => out.push(encMove(i, t.to)));
    }
    return out;
  }

  /* ==========================================================================
     十、發牌
     ========================================================================== */
  function allPieces(){
    const out = [];
    for(let side = 0; side < 2; side++){
      for(let r = 1; r <= 7; r++){
        for(let k = 0; k < COUNTS[r - 1]; k++) out.push(pieceOf(side, r));
      }
    }
    return out;                                    // 32 顆
  }
  function newDeal(rng){
    const r = rng || Math.random;
    const a = allPieces();
    for(let i = a.length - 1; i > 0; i--){
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return encodeDeal(a);
  }

  /* ==========================================================================
     十一、結算
     ========================================================================== */
  function score(st){
    const rows = [];
    for(let seat = 0; seat < 2; seat++){
      const side = seatSide(st, seat);
      let left = 0, sum = 0;
      if(side >= 0){
        for(let i = 0; i < NSQ; i++){
          const c = st.cells[i];
          if(c && sideOf(c.p) === side){ left++; sum += rankOf(c.p); }
        }
      }
      rows.push({
        seat: seat, side: side, left: left, sum: sum,
        eaten: st.caps[seat].slice(),              // 我吃掉的敵子
        self: st.friendly[seat].slice()            // 我自己賠掉的己方子(連吃翻攻自爆)
      });
    }
    return { winner: st.winner, endBy: st.endBy, rows: rows };
  }

  /* ==========================================================================
     十二、「為什麼這一格點不了」
     ──────────────────────────────────────────────────────────────────────────
       ★ 點不了的格**不用 disabled 讓點擊靜默消失**(CLAUDE.md 的紅線),
         那麼點下去就必須回答得出原因。
       ⚠ 放在規則層是因為單機與連線都要用 —— 兩邊各寫一份遲早會走鐘,
         而且走鐘了兩邊各自都不會壞,沒有東西抓得到。
     ========================================================================== */
  function whyNot(st, from, to){
    if(st.over) return "這局已經結束了";
    const mySide = seatSide(st, st.turn);
    if(mySide < 0) return "先翻一顆棋";
    if(st.chainFrom >= 0 && from !== st.chainFrom) return "連吃還沒結束 —— 只能動剛剛那顆子";
    const me = st.cells[from];
    if(!me) return "那一格是空的";
    if(!me.up) return "那是暗棋 —— 點一下可以翻開";
    if(sideOf(me.p) !== mySide) return "那是對方的子";

    const tc = st.cells[to];
    const myRank = rankOf(me.p);
    if(myRank === R_PAO){
      if(!tc) return "炮沒吃子的時候只能走一格";
      const cnt = screensBetween(st, from, to);
      if(cnt < 0) return "炮只能沿直線打";
      if(cnt === 0) return "炮不能貼身吃 —— 中間要隔一顆子當炮架";
      if(cnt > 1) return "中間隔了 " + cnt + " 顆 —— 炮只能隔一顆";
      if(tc.up && sideOf(tc.p) === mySide) return "那是自己的子";
      return "這一炮打不到";
    }
    if(!tc){
      return adjacent(from, to) ? "那一格走得到" : "一次只能走一格";
    }
    /* ⚠ 走到這裡 chainDark 一定是關的 —— 開著的話 capTargets() 早就把它收進
       moveTargets() / chainTargets() 了,不會落到「點不了」這一支。 */
    if(!tc.up) return "暗棋只能翻,不能吃";
    if(sideOf(tc.p) === mySide) return "那是自己的子";
    if(!adjacent(from, to)){
      if(myRank !== R_JU) return "一次只能走一格";
      if(!st.rules.rush) return "房規未開車直衝 —— 車一次只能走一格";
      if(blockedBetween(st, from, to)) return "中間有子擋住,衝不過去";
      return "直衝吃不了" + nameOf(tc.p) + " —— 房規未開「直衝吃大子」";
    }
    if(myRank === R_JIANG && rankOf(tc.p) === R_ZU) return nameOf(me.p) + "吃不了" + nameOf(tc.p);
    return nameOf(me.p) + "比" + nameOf(tc.p) + "小,吃不動";
  }

  // 兩格之間隔了幾顆子(不同線 / 不同列回 -1)
  function screensBetween(st, a, b){
    if(a === b) return -1;
    const ra = rowOf(a), ca = colOf(a), rb = rowOf(b), cb = colOf(b);
    if(ra !== rb && ca !== cb) return -1;
    const dr = Math.sign(rb - ra), dc = Math.sign(cb - ca);
    let r = ra + dr, c = ca + dc, n = 0;
    while(r !== rb || c !== cb){
      if(st.cells[r * COLS + c]) n++;
      r += dr; c += dc;
    }
    return n;
  }
  const blockedBetween = (st, a, b) => screensBetween(st, a, b) > 0;

  return {
    // 常數
    ROWS, COLS, NSQ, RED, BLACK, IDLE_DRAW, FULL_SUM, COUNTS, SIDE_NAME,
    R_ZU, R_PAO, R_MA, R_JU, R_XIANG, R_SHI, R_JIANG,
    MIN_PLAYERS: 2, MAX_PLAYERS: 2,
    // 編碼
    sideOf, rankOf, pieceOf, nameOf, sideName,
    pChr, pUnchr, sqChr, unSq, encodeDeal, decodeDeal,
    encFlip, encMove, STOP, encResign,
    // 幾何
    rowOf, colOf, nbs, adjacent, ray, screensBetween, blockedBetween,
    // 房規
    defRules, normRules, rulesText, ruleLevel, setRuleLevel, LV_TEXT,
    // 規則
    canBeat, sideAt, seatSide, seatOfSide,
    moveTargets, chainTargets, flipTargets, capTargets, legalMoves,
    countSide, sumSide, hasAnyMove, whyNot,
    // 一局
    blank, step, replay, allPieces, newDeal,
    // 結算
    score
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = DC;

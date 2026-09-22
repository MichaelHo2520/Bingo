"use strict";

/* ============================================================================
   方塊對戰 — 規則引擎(BLK)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/tiaoqi/rules.js、js/flychess/rules.js:碰了一行 DOM 就只能在
     瀏覽器裡手動玩,而這一頁的「手感」正是唯一要靠反覆調參數才調得出來的東西。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 七種方塊的四個方向(由基準矩陣旋轉產生,不手列 28 份)
     • SRS wall kick(官方表逐項照抄,I 與其他分表,O 不轉)
     • 決定性 7-bag:pieceAt(seed, i) 是**查詢函式**,不是產生器
     • 移動 / 旋轉 / 軟降 / 硬降 / Ghost(**沒有 Hold** —— v2.14.0 拿掉了,見下面)
     • 鎖定 · 消行 · 攻擊量(含 Combo 與全消)· 讓分倍率
     • 垃圾行:排隊 → 抵銷 → 推上來;洞位由送出端決定
     • tick(st, dt):時間推進(重力、鎖定延遲),回傳事件陣列
     • save/load(無損還原,回座用)與 snap(給對手小盤看的精簡快照)
   不負責:AI(ai.js)、畫面(board.js)、網路(adapter.js)、模式流程(solo.js / adapter.js)。

   ── ★★★ 六條會直接做錯的事 ───────────────────────────────────────────────
     ① **官方 kick 表的 y 是「向上為正」,我們的 y 是「向下為正」** ——
        表格照抄不動(才對得起參考資料),**在 rotate() 裡取負**。
        抄的時候順手翻號誌 = 之後每次對照官方表都要在腦子裡再翻一次。
     ② **7-bag 一定要寫成 pieceAt(seed, i) 這種 O(1) 查詢。**
        寫成「產生器 + 目前 bag 狀態」的話,快照就得序列化 PRNG 內部狀態,
        那是第二份真相 → 重整回座遲早分岔。有了查詢函式,**idx 一個整數就夠**。
     ③ **這個遊戲沒有 Hold(換牌)。** v2.14.0 拿掉的 —— 使用者:「那個換也不要了,
        刪掉換這個功能,這樣才刺激」。連帶消失的有 `st.hold` / `st.canHold` /
        `holdSwap()` / 快照的 `h` 欄位 / HUD 左邊那一格 / 鍵盤 `C`·`Shift` / 那顆「換」鈕。
        ⚠ **不要「順手」把它加回來** —— 它不是漏掉的功能,是刻意砍掉的難度旋鈕。
        落下中推盤會讓方塊卡進牆裡,而且對手看到的位置一定對不上。
     ⑤ **攻擊量的讓分倍率要用累積器(carry)保留小數。**
        直接四捨五入的話 ×1.25 的 Double 永遠還是 1 行,讓分等於沒有作用。
     ⑥ **tick() 的 dt 必須有上限。** 分頁凍結回來時 dt 可能是好幾萬毫秒,
        不夾住就會在一幀裡補算幾百次重力 → 整頁卡死(plan 5.2)。
   ========================================================================== */

const BLK = (function(){

  /* ==========================================================================
     一、盤面與方塊
     ──────────────────────────────────────────────────────────────────────────
       10 欄 × 22 列。**上面兩列是緩衝區**,畫面只畫 2..21 這 20 列。
       方塊一律生在 y = 2(第一列可見列)—— 生在緩衝區的話玩家看不到剛拿到什麼,
       而這一頁的節奏快到「看不到下一顆在哪」是致命的。
       緩衝區只有一個用途:垃圾行把堆疊往上推時,推進去就是超頂。
     ========================================================================== */
  const COLS = 10;
  const ROWS = 22;
  const VIS  = 20;
  const TOP  = ROWS - VIS;              // 2 —— 第一列可見列的 y

  const I = 0, J = 1, L = 2, O = 3, S = 4, T = 5, Z = 6;
  const KINDS = ["I", "J", "L", "O", "S", "T", "Z"];
  const NKIND = 7;
  const GARB  = 8;                      // 垃圾行的格子值(1..7 是七種方塊)

  /* 基準形狀(rot 0)。座標是**方框內**的 (x, y),y 向下。
     方框大小:I 是 4×4、O 是 2×2、其餘 3×3 —— 這是 SRS 的定義,不可以統一成一種,
     kick 表就是照著這三種方框寫的。 */
  const BOXN = [4, 3, 3, 2, 3, 3, 3];
  const BASE = [
    [[0,1],[1,1],[2,1],[3,1]],          // I ....  / XXXX / .... / ....
    [[0,0],[0,1],[1,1],[2,1]],          // J X.. / XXX / ...
    [[2,0],[0,1],[1,1],[2,1]],          // L ..X / XXX / ...
    [[0,0],[1,0],[0,1],[1,1]],          // O XX / XX
    [[1,0],[2,0],[0,1],[1,1]],          // S .XX / XX. / ...
    [[1,0],[0,1],[1,1],[2,1]],          // T .X. / XXX / ...
    [[0,0],[1,0],[1,1],[2,1]]           // Z XX. / .XX / ...
  ];

  /* CELLS[k][r] = 四個格子的 [x, y](方框內座標)。
     ★ 由基準矩陣**旋轉產生**,不手列 28 份 —— 手列一定會有一份打錯,
       而打錯的那一份只有在那個方向卡住時才看得出來。
     方框內順時針旋轉:(x, y) → (n-1-y, x)。 */
  const CELLS = (function(){
    const out = [];
    for(let k = 0; k < NKIND; k++){
      const n = BOXN[k];
      const rots = [BASE[k].map(c => [c[0], c[1]])];
      for(let r = 1; r < 4; r++)
        rots.push(rots[r - 1].map(c => [n - 1 - c[1], c[0]]));
      /* 每份都排序(先 y 後 x)—— 測試比對陣列時才穩定,畫圖也不受影響 */
      rots.forEach(cs => cs.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0])));
      out.push(rots);
    }
    return out;
  })();

  /* 生成位置(方框左上角的絕對座標)。
     ⚠ 三種方框大小各有各的 y,目的是**讓四個格子都落在 y = 2 起**:
       I 的格子在方框第 1 列 → y = 1;O 與 3×3 的在第 0 列 → y = 2。
     x 照 SRS:JLSTZ 在第 3~5 欄、I 在 3~6 欄、O 在 4~5 欄。 */
  const SPAWN_X = [3, 3, 3, 4, 3, 3, 3];
  const SPAWN_Y = [TOP - 1, TOP, TOP, TOP, TOP, TOP, TOP];

  /* ==========================================================================
     二、SRS wall kick
     ──────────────────────────────────────────────────────────────────────────
       ⚠⚠ 這兩張表是**官方表原樣照抄**,座標的 y 是**向上為正**。
          rotate() 會取負再用。不要在這裡先翻好 —— 翻好之後就再也對不回官方表了。
       方向編號:0 = 生成 · 1 = 順轉一次(R)· 2 = 180° · 3 = 逆轉一次(L)。
     ========================================================================== */
  const KICK_JLSTZ = {
    "0>1": [[0,0], [-1, 0], [-1, +1], [0, -2], [-1, -2]],
    "1>0": [[0,0], [+1, 0], [+1, -1], [0, +2], [+1, +2]],
    "1>2": [[0,0], [+1, 0], [+1, -1], [0, +2], [+1, +2]],
    "2>1": [[0,0], [-1, 0], [-1, +1], [0, -2], [-1, -2]],
    "2>3": [[0,0], [+1, 0], [+1, +1], [0, -2], [+1, -2]],
    "3>2": [[0,0], [-1, 0], [-1, -1], [0, +2], [-1, +2]],
    "3>0": [[0,0], [-1, 0], [-1, -1], [0, +2], [-1, +2]],
    "0>3": [[0,0], [+1, 0], [+1, +1], [0, -2], [+1, -2]]
  };
  const KICK_I = {
    "0>1": [[0,0], [-2, 0], [+1, 0], [-2, -1], [+1, +2]],
    "1>0": [[0,0], [+2, 0], [-1, 0], [+2, +1], [-1, -2]],
    "1>2": [[0,0], [-1, 0], [+2, 0], [-1, +2], [+2, -1]],
    "2>1": [[0,0], [+1, 0], [-2, 0], [+1, -2], [-2, +1]],
    "2>3": [[0,0], [+2, 0], [-1, 0], [+2, +1], [-1, -2]],
    "3>2": [[0,0], [-2, 0], [+1, 0], [-2, -1], [+1, +2]],
    "3>0": [[0,0], [+1, 0], [-2, 0], [+1, -2], [-2, +1]],
    "0>3": [[0,0], [-1, 0], [+2, 0], [-1, +2], [+2, -1]]
  };
  function kicksOf(k, from, to){
    if(k === O) return [[0, 0]];        // O 不轉,也沒有 kick
    return (k === I ? KICK_I : KICK_JLSTZ)[from + ">" + to] || [[0, 0]];
  }

  /* ==========================================================================
     三、時間常數與攻擊表
     ──────────────────────────────────────────────────────────────────────────
       重力表是自己訂的(比官方公式緩,聚會用)—— 每 30 秒升一階,封頂第 12 階。
       ⚠ 這張表就是「難度曲線」本身,調它之前先想清楚要調的是誰的體感。
     ========================================================================== */
  const GRAV   = [1000, 830, 690, 570, 470, 390, 320, 260, 210, 170, 130, 100];
  const LV_MS  = 30000;                 // 幾毫秒升一階
  const LOCK_MS     = 500;              // 鎖定延遲
  const LOCK_RESETS = 15;               // 貼地後最多用移動/旋轉拖幾次
  const SOFT_MULT   = 20;               // 軟降是重力的幾倍
  const MAX_DT      = 100;              // ★ tick 的 dt 上限(紅線 ⑥)
  const GARB_CAP    = 8;                // 一次鎖定最多推上來幾行
  /* 新手保護期間最多幫你存幾行。★ 這個數字的用途是「不要讓保護變成延後處決」——
     保護期照樣排隊(看得到警示條、學得會抵銷)是刻意的,但沒有天花板的話,
     20 秒的量會在解除那一刻一次灌下來,而每次鎖定推 GARB_CAP 行
     → 新手第一顆都還沒放好就被埋掉了。12 = 一次半的 GARB_CAP,還救得回來。 */
  const SHIELD_CAP  = 12;

  /* 消行的基礎攻擊量(index = 消掉幾行) */
  const ATK = [0, 0, 1, 2, 4];
  const PC_ATK = 4;                     // 全消(Perfect Clear)額外

  /* Combo 的額外攻擊(n = 這是連續第幾次消行,第一次是 1)。
     ★ 這張表存在的唯一理由:**只會消單行的人也要有輸出**。
       沒有它的話 Single = 0 行,新手整局送出 0 → 他不知道自己有在對戰。 */
  function comboAtk(n){
    if(n <= 1) return 0;
    if(n <= 3) return 1;
    if(n <= 5) return 2;
    if(n <= 7) return 3;
    return 4;
  }

  const DEF_RULES = {
    mode:    "ko",                      // "ko" = 3 分鐘 KO 賽 · "out" = 淘汰賽
    secs:    180,                       // KO 賽長度(秒)
    respawn: 2000,                      // KO 賽死後幾毫秒復活
    shield:  20000,                     // 新手保護:開局前幾毫秒不吃垃圾(0 = 關)
    combo:   true,                      // Combo 攻擊
    target:  "rand"                     // 4 人的預設攻擊目標
  };
  function normRules(r){
    r = r || {};
    const out = {};
    out.mode    = (r.mode === "out") ? "out" : "ko";
    out.secs    = clampInt(r.secs, 60, 600, DEF_RULES.secs);
    out.respawn = clampInt(r.respawn, 0, 10000, DEF_RULES.respawn);
    out.shield  = clampInt(r.shield, 0, 60000, DEF_RULES.shield);
    out.combo   = (r.combo === undefined) ? true : !!r.combo;
    out.target  = (r.target === "high" || r.target === "pick") ? r.target : "rand";
    return out;
  }
  function clampInt(v, lo, hi, dft){
    v = Math.round(Number(v));
    if(!isFinite(v)) return dft;
    return Math.max(lo, Math.min(hi, v));
  }

  /* 讓分等級 → 送出 / 收到倍率。index 0..4 對應「讓 2 / 讓 1 / 平 / 受 1 / 受 2」 */
  const HCAP = [
    { key: "give2", name: "讓 2", send: 1.5,  recv: 0.5  },
    { key: "give1", name: "讓 1", send: 1.25, recv: 0.75 },
    { key: "even",  name: "平",   send: 1,    recv: 1    },
    { key: "take1", name: "受 1", send: 0.8,  recv: 1.25 },
    { key: "take2", name: "受 2", send: 0.66, recv: 1.5  }
  ];
  const HCAP_EVEN = 2;
  /* ⚠ 超出範圍一律回「平」,**不是夾到邊界** ——
     讓分等級是從別台傳過來的數字,壞掉的值夾到 0 就變成「讓 2」,
     等於一個亂碼欄位可以默默把某個人變強。不認得的值只能是「平」。 */
  function hcapOf(lv){
    const i = Math.round(Number(lv));
    if(!isFinite(i) || i < 0 || i >= HCAP.length) return HCAP[HCAP_EVEN];
    return HCAP[i];
  }

  /* ==========================================================================
     四、7-bag —— 寫成 O(1) 查詢函式(紅線 ②)
     ──────────────────────────────────────────────────────────────────────────
       第 i 顆屬於第 floor(i/7) 袋、袋內第 i%7 個。
       每一袋用「seed + 袋號」重新起一組 xorshift32,再 Fisher-Yates 洗 [0..6]。
       → 任何一台、任何時候、只要有 seed 與 i 就算得出第 i 顆是什麼。
       ⚠ 全房共用同一顆 seed = 每個人的出塊序列**完全一樣**(公平,而且對手的
         Next 我們自己也算得出來,不必靠網路傳)。
     ========================================================================== */
  function bagOf(seed, b){
    let s = ((seed >>> 0) ^ Math.imul(b + 1, 0x9E3779B9)) >>> 0;
    if(s === 0) s = 0x9E3779B9;         // xorshift 卡在 0 就再也出不來
    const rnd = function(){
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
    rnd();                              // 丟掉第一個(相近的 seed 第一顆會一樣)
    const a = [0, 1, 2, 3, 4, 5, 6];
    for(let i = 6; i > 0; i--){
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function pieceAt(seed, i){
    if(i < 0) i = 0;
    return bagOf(seed, Math.floor(i / 7))[i % 7];
  }
  /* 從第 i 顆起的 n 顆(Next 預覽用) */
  function peek(seed, i, n){
    const out = [];
    for(let d = 0; d < n; d++) out.push(pieceAt(seed, i + d));
    return out;
  }

  /* ==========================================================================
     五、盤面基本操作
     ========================================================================== */
  function emptyBoard(){
    const b = [];
    for(let y = 0; y < ROWS; y++) b.push(new Array(COLS).fill(0));
    return b;
  }
  /* 方塊在絕對座標上佔哪四格 */
  function cellsOf(k, r, x, y){
    const cs = CELLS[k][r], out = [];
    for(let i = 0; i < 4; i++) out.push([x + cs[i][0], y + cs[i][1]]);
    return out;
  }
  /* 放得下嗎(出界或撞到都算放不下)。⚠ y < 0 也算出界 —— 緩衝區只有兩列 */
  function fits(board, k, r, x, y){
    const cs = CELLS[k][r];
    for(let i = 0; i < 4; i++){
      const cx = x + cs[i][0], cy = y + cs[i][1];
      if(cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;
      if(board[cy][cx]) return false;
    }
    return true;
  }
  function boardEmpty(board){
    for(let y = 0; y < ROWS; y++)
      for(let x = 0; x < COLS; x++) if(board[y][x]) return false;
    return true;
  }
  /* 最高的一列(有格子的最小 y);全空回 ROWS */
  function stackTop(board){
    for(let y = 0; y < ROWS; y++)
      for(let x = 0; x < COLS; x++) if(board[y][x]) return y;
    return ROWS;
  }

  /* ==========================================================================
     六、一局的狀態
     ──────────────────────────────────────────────────────────────────────────
       st 是**純資料**(可以直接 JSON.stringify)。下面的函式一律就地改 st,
       與 tiaoqi / flychess 的 step() 同一套做法 —— 60 FPS 下每幀複製整盤沒有必要。
     ========================================================================== */
  function blank(o){
    o = o || {};
    const st = {
      seed:   (o.seed >>> 0) || 1,
      rules:  normRules(o.rules),
      idx:    0,                        // 已經抽到第幾顆(下一顆的序號)
      board:  emptyBoard(),
      cur:    null,                     // { k, r, x, y }
      pend:   [],                       // 待處理垃圾 [{ n, hole, from }]
      shield: 0,                        // 新手保護剩餘 ms
      combo:  0,                        // 連續消行次數(0 = 沒在連)
      lines:  0,
      sent:   0,                        // 累計送出幾行
      ko:     0,                        // KO 幾個人(KO 賽計分)
      deaths: 0,
      pieces: 0,
      carry:  0,                        // 送出倍率的小數累積(紅線 ⑤)
      rcarry: 0,                        // 收到倍率的小數累積
      send:   1,
      recv:   1,
      time:   0,                        // 這一局已經過幾 ms
      fall:   0,                        // 重力累積
      lockT:  0,                        // 貼地後累積
      resets: 0,
      soft:   false,
      dead:   false,
      deadT:  0                         // 死了多久(KO 賽用來算復活)
    };
    const h = hcapOf(o.hcap === undefined ? HCAP_EVEN : o.hcap);
    st.send = h.send;
    st.recv = h.recv;
    st.shield = st.rules.shield;
    spawn(st);
    return st;
  }

  /* 目前這一階的重力(ms / 格) */
  function level(st){
    return Math.min(GRAV.length, 1 + Math.floor(st.time / LV_MS));
  }
  function gravMs(st){
    return GRAV[level(st) - 1];
  }

  /* 生出下一顆。k 有給就用指定的那一顆(**不動 idx**)。
     ⚠ 那個參數目前**沒有人用** —— v2.14.0 把 Hold 拿掉之後唯一的呼叫端就沒了。
       留著是因為它零成本,而且「指定一顆生出來」是測試用得到的出口。
     回傳 false = 生不出來(超頂)。 */
  function spawn(st, k){
    const kind = (k === undefined) ? pieceAt(st.seed, st.idx++) : k;
    st.cur = { k: kind, r: 0, x: SPAWN_X[kind], y: SPAWN_Y[kind] };
    st.fall = 0; st.lockT = 0; st.resets = 0; st.soft = false;
    st.pieces++;
    if(!fits(st.board, kind, 0, st.cur.x, st.cur.y)){
      st.cur = null;
      st.dead = true;
      st.deadT = 0;
      return false;
    }
    return true;
  }

  /* 貼地嗎 */
  function grounded(st){
    const c = st.cur;
    return !!c && !fits(st.board, c.k, c.r, c.x, c.y + 1);
  }
  /* 移動 / 旋轉成功之後的鎖定延遲處理。
     離地 → 計時歸零而且**不算一次**;貼地 → 歸零並用掉一次(上限 LOCK_RESETS)。 */
  function touched(st){
    if(!grounded(st)){ st.lockT = 0; return; }
    if(st.resets < LOCK_RESETS){ st.lockT = 0; st.resets++; }
  }

  function move(st, dx){
    const c = st.cur;
    if(!c || st.dead) return false;
    if(!fits(st.board, c.k, c.r, c.x + dx, c.y)) return false;
    c.x += dx;
    touched(st);
    return true;
  }
  /* dir: +1 順時針 / -1 逆時針 */
  function rotate(st, dir){
    const c = st.cur;
    if(!c || st.dead) return false;
    if(c.k === O) return false;
    const to = (c.r + (dir > 0 ? 1 : 3)) & 3;
    const tbl = kicksOf(c.k, c.r, to);
    for(let i = 0; i < tbl.length; i++){
      const dx = tbl[i][0];
      const dy = -tbl[i][1];            // ★ 紅線 ①:官方表 y 向上為正
      if(fits(st.board, c.k, to, c.x + dx, c.y + dy)){
        c.r = to; c.x += dx; c.y += dy;
        touched(st);
        return true;
      }
    }
    return false;
  }
  /* 往下一格(重力與軟降共用)。回傳有沒有真的掉下去 */
  function down(st){
    const c = st.cur;
    if(!c || st.dead) return false;
    if(!fits(st.board, c.k, c.r, c.x, c.y + 1)) return false;
    c.y++;
    st.lockT = 0;
    st.resets = 0;                      // 掉到新的一列 → 拖延次數重新計算
    return true;
  }
  function ghostY(st){
    const c = st.cur;
    if(!c) return 0;
    let y = c.y;
    while(fits(st.board, c.k, c.r, c.x, y + 1)) y++;
    return y;
  }
  function hardDrop(st){
    const c = st.cur;
    if(!c || st.dead) return null;
    let n = 0;
    while(fits(st.board, c.k, c.r, c.x, c.y + 1)){ c.y++; n++; }
    const ev = lock(st);
    ev.drop = n;
    return ev;
  }
  /* ==========================================================================
     七、鎖定 · 消行 · 攻擊
     ──────────────────────────────────────────────────────────────────────────
       lock() 是這一支最密的一段,順序**不可以換**:
         寫進盤面 → 超頂判定 → 消行 → 算攻擊 → 抵銷自己的 pend →
         剩下的算送出 → 把 pend 推上來(紅線 ④)→ 生下一顆
       回傳的事件給 board.js 放特效、給 adapter.js 決定要不要送攻擊。
     ========================================================================== */
  function lock(st){
    const c = st.cur;
    /* ★ 事件帶著「這一顆鎖在哪裡、佔了哪四格」——
       board.js 的消行動畫需要「**寫進去之後、消掉之前**」的盤面,而那一瞬間
       只存在於這個函式裡面。讓呼叫端自己推算的話,它得知道重力在這一幀有沒有
       多掉一格 —— 那是第二份真相。 */
    const ev = { t: "lock", k: c ? c.k : -1, r: c ? c.r : 0, x: c ? c.x : 0, y: c ? c.y : 0,
                 cells: [], rows: [], atk: 0, out: 0, pc: false,
                 garb: [], combo: 0, dead: false, drop: 0 };
    if(!c) return ev;

    const cs = cellsOf(c.k, c.r, c.x, c.y);
    ev.cells = cs;
    let allHidden = true;
    for(let i = 0; i < 4; i++){
      const p = cs[i];
      st.board[p[1]][p[0]] = c.k + 1;
      if(p[1] >= TOP) allHidden = false;
    }
    st.cur = null;

    /* Lock Out:整顆鎖在可見區之上 → 死。
       ⚠ 這與「生不出來」是兩種不同的死法,兩種都要有,不然堆到頂的人會卡在
         「還能放、但畫面上什麼都看不到」的狀態。 */
    if(allHidden){ st.dead = true; st.deadT = 0; ev.dead = true; return ev; }

    /* 消行 */
    const keep = [];
    for(let y = 0; y < ROWS; y++){
      let full = true;
      for(let x = 0; x < COLS; x++) if(!st.board[y][x]){ full = false; break; }
      if(full) ev.rows.push(y); else keep.push(st.board[y]);
    }
    const n = ev.rows.length;
    if(n){
      while(keep.length < ROWS) keep.unshift(new Array(COLS).fill(0));
      st.board = keep;
      st.lines += n;
      st.combo++;
    }else{
      st.combo = 0;
    }
    ev.combo = st.combo;

    /* 攻擊量 */
    if(n){
      let atk = ATK[n];
      if(st.rules.combo) atk += comboAtk(st.combo);
      ev.pc = boardEmpty(st.board);
      if(ev.pc) atk += PC_ATK;
      ev.atk = atk;
      const scaled = scale(st, atk);
      ev.out = cancel(st, scaled);      // 先抵銷自己的,剩下的才送出去
      st.sent += ev.out;
    }

    /* 垃圾行推上來(紅線 ④:只在這個時間點) */
    ev.garb = applyPending(st);
    if(st.dead){ ev.dead = true; return ev; }

    if(!spawn(st)) ev.dead = true;
    return ev;
  }

  /* 送出量 × 讓分倍率,小數用 carry 留著(紅線 ⑤) */
  function scale(st, n){
    if(n <= 0) return 0;
    const raw = n * st.send + st.carry;
    const out = Math.floor(raw);
    st.carry = raw - out;
    return out;
  }
  /* 用 atk 行抵銷自己的待處理垃圾,回傳抵銷不完、要送出去的行數 */
  function cancel(st, atk){
    while(atk > 0 && st.pend.length){
      const p = st.pend[0];
      if(p.n > atk){ p.n -= atk; atk = 0; }
      else { atk -= p.n; st.pend.shift(); }
    }
    return atk;
  }
  function pendCount(st){
    let n = 0;
    for(let i = 0; i < st.pend.length; i++) n += st.pend[i].n;
    return n;
  }

  /* 收到攻擊 → 進佇列(不立刻推上來)。
     ⚠ hole 是**送出端決定的**,接收端不可以自己重抽 —— 兩邊看到的洞位必須一樣。 */
  function queueGarbage(st, n, hole, from){
    n = Math.max(0, Math.round(Number(n) || 0));
    if(!n) return 0;
    /* ⚠ 保護期間的天花板(SHIELD_CAP)。滿了就**直接丟掉**,不排進去 ——
       「保護」不可以只是把帳延後到解除那一秒一次算。 */
    if(st.shield > 0 && pendCount(st) >= SHIELD_CAP) return 0;
    const raw = n * st.recv + st.rcarry;
    const m = Math.floor(raw);
    st.rcarry = raw - m;
    if(m <= 0) return 0;
    st.pend.push({ n: m, hole: ((hole | 0) % COLS + COLS) % COLS, from: from || "" });
    return m;
  }
  /* 把佇列推上來。一次鎖定最多 GARB_CAP 行,剩下的留著下一次 ——
     沒有這個上限的話,一波大攻擊可以讓人「一顆都還沒放就死了」。 */
  function applyPending(st){
    const done = [];
    if(st.shield > 0) return done;      // 新手保護:照樣排隊、照樣顯示,就是不推上來
    let room = GARB_CAP;
    while(room > 0 && st.pend.length){
      const p = st.pend[0];
      const n = Math.min(room, p.n);
      pushGarbage(st, n, p.hole);
      done.push({ n: n, hole: p.hole, from: p.from });
      p.n -= n; room -= n;
      if(p.n <= 0) st.pend.shift();
      if(st.dead) break;
    }
    return done;
  }
  /* 從底部塞 n 行垃圾(同一批共用一個洞) */
  function pushGarbage(st, n, hole){
    if(n <= 0) return;
    for(let y = 0; y < n && y < ROWS; y++){
      for(let x = 0; x < COLS; x++){
        if(st.board[y][x]){ st.dead = true; st.deadT = 0; return; }
      }
    }
    st.board.splice(0, n);
    for(let i = 0; i < n; i++){
      const row = new Array(COLS).fill(GARB);
      row[hole] = 0;
      st.board.push(row);
    }
  }

  /* ==========================================================================
     八、時間推進
     ──────────────────────────────────────────────────────────────────────────
       board.js 的 rAF 每一幀呼叫一次 tick(st, dt),拿回事件陣列去放特效;
       adapter.js 看同一批事件決定要不要送攻擊。**規則只有這一份。**
     ========================================================================== */
  function tick(st, dt){
    const ev = [];
    dt = Math.max(0, Math.min(MAX_DT, Number(dt) || 0));   // ★ 紅線 ⑥
    if(st.dead){ st.deadT += dt; return ev; }
    st.time += dt;

    if(st.shield > 0){
      st.shield -= dt;
      if(st.shield <= 0){ st.shield = 0; ev.push({ t: "shield" }); }
    }
    if(!st.cur) return ev;

    /* 重力。軟降 = 重力的 SOFT_MULT 倍 */
    const step = Math.max(1, st.soft ? gravMs(st) / SOFT_MULT : gravMs(st));
    st.fall += dt;
    let guard = ROWS + 2;               // 一幀最多補算這麼多格
    while(st.fall >= step && guard-- > 0){
      if(down(st)) st.fall -= step;
      else { st.fall = 0; break; }      // 貼地就停住累積,不要囤著等離地一次爆掉
    }

    /* 鎖定延遲 */
    if(grounded(st)){
      st.lockT += dt;
      /* 「拖延次數用完」不必在這裡另外判 —— touched() 到上限就不再把 lockT 歸零,
         所以計時自然會走到底。多寫一條只會是同一件事的第二份真相。 */
      if(st.lockT >= LOCK_MS) ev.push(lock(st));
    }else{
      st.lockT = 0;
    }
    return ev;
  }

  /* KO 賽的復活:盤面清空、待處理垃圾一併清掉,但**出塊序號繼續往下走** ——
     重置 idx 的話同一顆 seed 會再發一次同樣的開局,而且與別人的序列錯開。 */
  function revive(st){
    st.board = emptyBoard();
    st.cur = null;
    st.pend = [];
    st.combo = 0;
    st.dead = false;
    st.deadT = 0;
    st.deaths++;
    st.fall = 0; st.lockT = 0; st.resets = 0; st.soft = false;
    spawn(st);
    return st;
  }

  /* ==========================================================================
     九、編碼
     ──────────────────────────────────────────────────────────────────────────
       ① encBoard:220 個 hex 字元(一格一個字元,0 = 空、1..7 = 方塊、8 = 垃圾)。
          ★ 刻意**不壓縮** —— Firebase Console 裡肉眼就看得出盤面長什麼樣,
            而 220 bytes 在這個用量下完全不是問題(board 只在事件時送)。
            之後真的要省流量,在這裡加 RLE 就好,round-trip 測試守著。
       ② save/load:無損還原(回座用)—— 少一個欄位就會「看似合理但已經分岔」。
       ③ snap:給對手小盤看的精簡快照,**不保證能還原**,只保證畫得出來。
     ========================================================================== */
  const HEX = "0123456789abcdef";
  function encBoard(board){
    let s = "";
    for(let y = 0; y < ROWS; y++)
      for(let x = 0; x < COLS; x++) s += HEX[board[y][x] & 15];
    return s;
  }
  function decBoard(s){
    const b = emptyBoard();
    if(typeof s !== "string" || s.length < ROWS * COLS) return b;
    let i = 0;
    for(let y = 0; y < ROWS; y++)
      for(let x = 0; x < COLS; x++){
        const v = HEX.indexOf(s[i++]);
        b[y][x] = (v < 0) ? 0 : v;      // 壞字元一律當空格,不要讓 -1 漏進盤面
      }
    return b;
  }

  function save(st){
    return {
      v: 1,
      seed: st.seed, rules: st.rules, idx: st.idx,
      b: encBoard(st.board),
      cur: st.cur ? [st.cur.k, st.cur.r, st.cur.x, st.cur.y] : null,
      pend: st.pend.map(p => [p.n, p.hole, p.from]),
      shield: st.shield, combo: st.combo, lines: st.lines, sent: st.sent,
      ko: st.ko, deaths: st.deaths, pieces: st.pieces,
      carry: st.carry, rcarry: st.rcarry, send: st.send, recv: st.recv,
      time: st.time, fall: st.fall, lockT: st.lockT, resets: st.resets,
      soft: st.soft ? 1 : 0, dead: st.dead ? 1 : 0, deadT: st.deadT
    };
  }
  function load(o){
    const st = blank({ seed: o.seed, rules: o.rules });
    st.idx = o.idx | 0;
    st.board = decBoard(o.b);
    st.cur = o.cur ? { k: o.cur[0], r: o.cur[1], x: o.cur[2], y: o.cur[3] } : null;
    st.pend = (o.pend || []).map(p => ({ n: p[0], hole: p[1], from: p[2] || "" }));
    st.shield = o.shield || 0;
    st.combo = o.combo | 0; st.lines = o.lines | 0; st.sent = o.sent | 0;
    st.ko = o.ko | 0; st.deaths = o.deaths | 0; st.pieces = o.pieces | 0;
    st.carry = o.carry || 0; st.rcarry = o.rcarry || 0;
    st.send = (o.send === undefined) ? 1 : o.send;
    st.recv = (o.recv === undefined) ? 1 : o.recv;
    st.time = o.time || 0; st.fall = o.fall || 0;
    st.lockT = o.lockT || 0; st.resets = o.resets | 0;
    st.soft = !!o.soft; st.dead = !!o.dead; st.deadT = o.deadT || 0;
    return st;
  }

  /* 對手小盤用。⚠ 只給畫面看 —— 不要拿它來還原自己的狀態(欄位不全)。 */
  function snap(st){
    return {
      b: encBoard(st.board),
      c: st.cur ? [st.cur.k, st.cur.r, st.cur.x, st.cur.y] : null,
      i: st.idx,
      p: pendCount(st),
      l: st.lines, ko: st.ko,
      d: st.dead ? 1 : 0
    };
  }

  /* ==========================================================================
     十、給 ai.js 用的落點列舉
     ──────────────────────────────────────────────────────────────────────────
       只列「直接掉下去」放得到的位置(不含轉角塞入 / T-Spin)。
       ★ 放在這裡而不是 ai.js:它是規則的一部分,board.js 畫提示時也會用到。
     ========================================================================== */
  function placements(board, k){
    const out = [];
    const rots = (k === O) ? 1 : ((k === I || k === S || k === Z) ? 2 : 4);
    for(let r = 0; r < rots; r++){
      for(let x = -3; x < COLS; x++){
        if(!fits(board, k, r, x, 0) && !fits(board, k, r, x, 1)) continue;
        let y = 0;
        if(!fits(board, k, r, x, y)) continue;
        while(fits(board, k, r, x, y + 1)) y++;
        out.push({ k: k, r: r, x: x, y: y });
      }
    }
    return out;
  }

  /* ==========================================================================
     十一、小工具
     ========================================================================== */
  function kindName(k){ return KINDS[k] || "?"; }
  /* 診斷用的一行文字(測試紅了要看得懂發生什麼事) */
  function boardText(board){
    const out = [];
    for(let y = 0; y < ROWS; y++){
      let s = "";
      for(let x = 0; x < COLS; x++) s += board[y][x] ? (board[y][x] === GARB ? "#" : "X") : ".";
      out.push((y < TOP ? "~" : " ") + s);
    }
    return out.join("\n");
  }
  /* 測試用:把一串文字盤面讀進來("." = 空、"#" = 垃圾、其餘非空白 = 方塊) */
  function boardFrom(lines){
    const b = emptyBoard();
    const arr = String(lines).split("\n").filter(s => s.length);
    for(let i = 0; i < arr.length && i < ROWS; i++){
      const y = ROWS - arr.length + i;
      for(let x = 0; x < COLS && x < arr[i].length; x++){
        const ch = arr[i][x];
        b[y][x] = (ch === "." || ch === " ") ? 0 : (ch === "#" ? GARB : 1);
      }
    }
    return b;
  }

  return {
    // 常數
    COLS, ROWS, VIS, TOP, NKIND, KINDS, GARB,
    I, J, L, O, S, T, Z,
    GRAV, LV_MS, LOCK_MS, LOCK_RESETS, SOFT_MULT, MAX_DT, GARB_CAP, SHIELD_CAP,
    ATK, PC_ATK, DEF_RULES, HCAP, HCAP_EVEN,
    // 形狀與 kick(純資料,board.js 查表用)
    CELLS, BOXN, BASE, SPAWN_X, SPAWN_Y, KICK_JLSTZ, KICK_I, kicksOf, cellsOf,
    // 出塊
    bagOf, pieceAt, peek,
    // 盤面
    emptyBoard, fits, boardEmpty, stackTop, placements,
    // 房規 / 讓分
    normRules, hcapOf, comboAtk,
    // 一局
    blank, spawn, level, gravMs, grounded, move, rotate, down, ghostY,
    hardDrop, lock, tick, revive,
    // 垃圾行
    queueGarbage, applyPending, pushGarbage, cancel, pendCount, scale,
    // 編碼
    encBoard, decBoard, save, load, snap,
    // 小工具
    kindName, boardText, boardFrom
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = BLK;

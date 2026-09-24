"use strict";

/* ============================================================================
   泡泡對戰 — 規則引擎(BUB)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗(CLAUDE.md 紅線 16)。
     骨架照抄 js/blocks/rules.js —— 狀態欄位、房規、抵銷、反擊、最後 30 秒、
     暖身保護的語意**逐條一樣**,adapter / solo 才能照搬方塊對戰那一套同步。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 六角交錯盤面:寬 8 顆(交錯列 7 顆),`st.par` 決定哪幾列是交錯列
     • 彈道:直線 + 左右牆反彈,固定步長推進(trace 與即時飛行**同一個步進函式**)
     • 吸附:撞到泡泡 / 天花板 → 落進離球心最近、而且「有東西撐著」的空格
     • 消除(三顆以上同色相連)· 掉落(跟天花板斷了連線的)· 攻擊量 · 抵銷
     • 壓力:每射 N 發,頂端插進一整排(N 隨時間變少)
     • 垃圾:對手送來的是「頂端整排插入」,顏色由**送出端**的 gs 決定
     • tick(st, dt):時間推進(飛行、自動發射、暖身),回傳事件陣列

   ── ★★★ 六條會直接做錯的事 ───────────────────────────────────────────────
     ① **插一排進頂端時 `st.par` 一定要翻面。** 每一列是不是交錯列由
        `(y + par) & 1` 決定;整盤往下推一格之後舊的每一列都換了 y,
        不翻 par 的話**整盤的幾何會瞬間錯半格**,鄰居全部算錯(消除 / 掉落跟著錯)。
     ② **trace() 與即時飛行必須走同一個步進函式、同一個步長。**
        預瞄線(與電腦的判斷)用 trace 算,真的射出去走 tick —— 兩條路的步長不同,
        就會出現「預瞄線明明指著那一格,射出去卻黏在隔壁」。
     ③ **吸附只能落在「有東西撐著」的空格**(第 0 列,或旁邊有泡泡)。
        只找最近的空格的話,高速斜射擦過邊緣時會落進一個懸空的格子,
        下一步掉落判定就把它自己算成掉落 → 看起來像「射出去的泡泡消失了」。
     ④ **加倍(反擊 / 最後 30 秒)一律發生在抵銷之後**(同方塊對戰紅線 ⑪之二)。
     ⑤ **tick() 的 dt 必須有上限**(分頁凍結回來時 dt 可能是好幾萬毫秒)。
     ⑥ **發射的顏色只從「盤面上還有的顏色」裡挑**(盤面空了才不限)。
        不這樣做的話,清到只剩兩色時會一直拿到盤上根本沒有的顏色 → 只能亂塞,
        那不是難度,是運氣。⚠ 挑法是決定性的(seed + 序號 → 對映到現有顏色),
        不可以用 Math.random —— 對手小盤與測試都要算得出同一個結果。
     ⑦ **「不容易死」的三條是一組的(2.17.0+2),拿掉任何一條都會回到「一條命 34 秒」**:
        垃圾一發只插 1 排(GARB_CAP)· 被推到死亡線上先給「最後一發」(insertRow 只在
        擠出盤面時判死)· 快爆時收到的攻擊減半(queueGarbage 的 MERCY_LOW)。
        ⚠ 死亡一律只在兩個地方判:落地消完還壓在第 DEAD 列(land),或插排把第 DEAD 列擠出去。
   ========================================================================== */

const BUB = (function(){

  /* ==========================================================================
     一、盤面幾何(單位 = 一顆泡泡的直徑)
     ──────────────────────────────────────────────────────────────────────────
       第 y 列是不是交錯列:`(y + st.par) & 1`。交錯列往右偏半顆、只有 7 格。
       球心:cx = x + 0.5 (+0.5 若交錯) · cy = 0.5 + y * RH
       第 DEAD 列是死亡線:**自己射出去的那一發消完還有泡泡停在那一列就輸**;
       被插排推到那一列的不會馬上輸,給一發救命(紅線 ⑦)。
     ========================================================================== */
  const COLS = 8;
  const ROWS = 13;                      // 0..12,其中第 12 列是死亡線
  const DEAD = ROWS - 1;
  const RH   = Math.sqrt(3) / 2;        // 相鄰兩列的球心距離
  const NC   = 6;                       // 顏色數(1..6;0 = 空)
  const LX   = COLS / 2;                // 發射器的位置
  const LY   = 0.5 + DEAD * RH + 0.95;
  const H    = LY + 0.75;               // 整塊盤面的高(畫面用)

  /* 飛行。★ SUB(步長)同時是 trace 與即時飛行的步長(紅線 ②) */
  const SPEED = 0.026;                  // 每毫秒飛幾顆直徑(整盤高度大約半秒)
  const SUB   = 0.1;
  const HIT   = 0.84;                   // 球心距離小於它就算撞到(略小於 1 → 縫隙擠得過去一點)
  const MAX_AIM = 1.36;                 // 瞄準角的上限(弧度,離垂直約 78°)

  /* ==========================================================================
     二、時間常數與攻擊表
     ========================================================================== */
  const LV_MS   = 30000;                // 幾毫秒升一階
  /* 每幾發插一排(index = 階 - 1)。★ 這張表就是單機練習的難度曲線本身 */
  const PRESS   = [9, 8, 7, 7, 6, 6, 5, 5, 4];
  const AUTO_MS = 9000;                 // 太久沒射就自動發射(聚會節奏:不可以有人一直不射)
  const MAX_DT  = 100;                  // ★ tick 的 dt 上限(紅線 ⑤)
  const INIT_ROWS  = 5;                 // 開局幾排
  const REFILL     = 3;                 // 清空盤面後補幾排
  /* 一發落地之後最多插進幾排垃圾。★ 1 而不是 3(2.17.0+2):一次灌 2~3 排 = 直接頂過線、
     來不及反應(模擬裡一半的死亡是這樣來的);一排一排進來,待處理的那幾排才有時間被抵銷掉 */
  const GARB_CAP   = 1;
  /* 暖身期間最多幫你存幾排 —— 同方塊對戰的 SHIELD_CAP:保護不可以變成延後處決 */
  const SHIELD_CAP = 5;
  /* 手下留情:最低那一顆到了這一列(離死亡線只剩 3 列空位),收到的攻擊減半(無條件進位 → 1 排還是 1 排) */
  const MERCY_LOW  = DEAD - 4;
  const PC_ATK     = 3;                 // 全清額外
  const REVENGE_MS = 3500;              // 反擊窗(同方塊對戰)

  /* 這一發的攻擊點 → 送幾排。點數 = (消掉的 - 3) + 掉落的。
     ★ 掉落算一點、消掉超出 3 的部分也算一點 —— 打斷一大串的人才是這個遊戲的高手,
       但只會「剛好湊三顆」的人不能整局 0 輸出,那一半交給下面的 comboAtk。 */
  function rowsOf(pts){
    if(pts < 2) return 0;
    if(pts < 4) return 1;
    if(pts < 6) return 2;
    if(pts < 9) return 3;
    return Math.min(6, 4 + Math.floor((pts - 9) / 4));
  }
  /* 連續幾發都有消到(第一發是 1)。★ 同方塊對戰那一條:弱玩家也要有輸出 */
  function comboAtk(n){
    if(n < 3) return 0;
    if(n < 5) return 1;
    if(n < 7) return 2;
    return 3;
  }

  const DEF_RULES = {
    mode:    "ko",                      // "ko" = K.O. 賽 · "out" = 淘汰賽
    secs:    180,
    respawn: 2000,
    shield:  20000,                     // 開局暖身(ms,0 = 關)
    combo:   true,
    target:  "rand",                    // "rand" 隨機 · "high" 打第一名
    rush:    false                      // 最後 30 秒攻擊加倍
  };
  /* 房規的「隨選隨變」文案 —— 單機與大廳共用這一份(同方塊對戰 v2.15.4 的理由)。
     ★ 判準:講現場會發生什麼事,不要講這個欄位叫什麼。 */
  const NOTES = {
    mode: {
      ko:  "死了 <b>2 秒就復活</b>,一直打到時間結束。把別人壓爆最多次的人贏 —— 沒有人要在旁邊乾等。",
      out: "<b>死了就出局</b>,只能看別人打完。最後還活著的人贏。⚠ 人多的時候,先死的人要等一兩分鐘。"
    },
    shield: {
      0:  "一開局就能互相攻擊。⚠ <b>第一次玩的人通常撐不過 20 秒</b>。",
      10: "開局 10 秒內<b>大家都不會被塞泡泡</b>(警示條照樣會亮,先學會怎麼抵銷)。",
      20: "開局 20 秒內<b>大家都不會被塞泡泡</b>(警示條照樣會亮,先學會怎麼抵銷)。"
    },
    target: {
      rand: "三個人以上時,塞過去的泡泡<b>隨機挑一個對手</b>(1 對 1 沒差)。",
      high: "三個人以上時<b>一律打目前的第一名</b> —— 強的人會被全場追著打," +
            "<b>實力差很多的時候特別好玩</b>。"
    },
    rush: {
      on:  "最後 30 秒<b>所有人的攻擊加倍</b>,畫面會變色。落後的人有機會翻盤," +
           "⚠ 但領先的人也一樣加倍。",
      off: "全程一樣的攻擊量。"
    }
  };
  function noteOf(field, value){
    const t = NOTES[field];
    if(!t) return "";
    if(field === "rush") return t[value ? "on" : "off"] || "";
    return t[value] || "";
  }
  function clampInt(v, lo, hi, dft){
    v = Math.round(Number(v));
    if(!isFinite(v)) return dft;
    return Math.max(lo, Math.min(hi, v));
  }
  function normRules(r){
    r = r || {};
    return {
      mode:    (r.mode === "out") ? "out" : "ko",
      secs:    clampInt(r.secs, 60, 600, DEF_RULES.secs),
      respawn: clampInt(r.respawn, 0, 10000, DEF_RULES.respawn),
      shield:  clampInt(r.shield, 0, 60000, DEF_RULES.shield),
      combo:   (r.combo === undefined) ? true : !!r.combo,
      target:  (r.target === "high") ? "high" : "rand",
      rush:    !!r.rush
    };
  }

  /* ==========================================================================
     三、決定性亂數(同 BLK.bagOf 的 xorshift32)
     ========================================================================== */
  function rng(seed, salt){
    let s = ((seed >>> 0) ^ Math.imul((salt >>> 0) + 1, 0x9E3779B9)) >>> 0;
    if(s === 0) s = 0x9E3779B9;
    const f = function(){
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
    f();                                // 丟掉第一個(相近的 seed 第一顆會一樣)
    return f;
  }
  /* 第 k 排新泡泡(開局 / 壓力 / 補排 / 垃圾都走它)。
     ★ 橫向有「黏」的傾向(40% 抄左邊那一顆)—— 完全獨立亂數的盤面幾乎湊不出一串,
       而一串打斷掉一大片正是這個遊戲的爽點。 */
  function rowAt(seed, k){
    const r = rng(seed, 0x5bd1e995 ^ k);
    const out = [];
    for(let x = 0; x < COLS; x++){
      if(x > 0 && r() < 0.4) out.push(out[x - 1]);
      else out.push(1 + Math.floor(r() * NC));
    }
    return out;
  }
  /* 第 i 發的「原始」顏色(還沒對映到盤面現有顏色) */
  function colorAt(seed, i){
    return 1 + Math.floor(rng(seed, 0x27d4eb2f ^ i)() * NC);
  }

  /* ==========================================================================
     四、盤面基本操作
     ========================================================================== */
  function emptyBoard(){
    const b = [];
    for(let y = 0; y < ROWS; y++) b.push(new Array(COLS).fill(0));
    return b;
  }
  function isOdd(par, y){ return ((y + par) & 1) === 1; }
  function valid(par, x, y){
    return y >= 0 && y < ROWS && x >= 0 && x < (isOdd(par, y) ? COLS - 1 : COLS);
  }
  function cx(par, x, y){ return x + 0.5 + (isOdd(par, y) ? 0.5 : 0); }
  function cy(y){ return 0.5 + y * RH; }
  /* 六個鄰居(只回合法格) */
  function neighbors(par, x, y){
    const o = isOdd(par, y);
    const ds = o ? [[-1,0],[1,0],[0,-1],[1,-1],[0,1],[1,1]]
                 : [[-1,0],[1,0],[-1,-1],[0,-1],[-1,1],[0,1]];
    const out = [];
    for(let i = 0; i < 6; i++){
      const nx = x + ds[i][0], ny = y + ds[i][1];
      if(valid(par, nx, ny)) out.push([nx, ny]);
    }
    return out;
  }
  function count(board){
    let n = 0;
    for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++) if(board[y][x]) n++;
    return n;
  }
  /* 最低的一列有東西的是第幾列(全空回 -1)—— 「快爆了」的播報與電腦的評分用 */
  function lowest(board){
    for(let y = ROWS - 1; y >= 0; y--)
      for(let x = 0; x < COLS; x++) if(board[y][x]) return y;
    return -1;
  }
  function present(board){
    const has = [];
    for(let y = 0; y < ROWS; y++)
      for(let x = 0; x < COLS; x++){ const v = board[y][x]; if(v && has.indexOf(v) < 0) has.push(v); }
    return has.sort((a, b) => a - b);
  }
  /* 把一個顏色對映到盤面現有的顏色(紅線 ⑥)。已經在盤上 → 原樣;不在 → 決定性地換一個 */
  function fitColor(board, c, salt){
    const has = present(board);
    if(!has.length || has.indexOf(c) >= 0) return c;
    return has[((salt >>> 0) + c) % has.length];
  }

  /* 頂端插一排。回傳 true = 還活著。
     ⚠ 紅線 ①:par 一定要翻面,舊的每一列才維持原本的幾何。
     ⚠ 紅線 ⑦:被推到第 DEAD 列**不算死**(那是「最後一發」,下一發落地時由 land 判);
       只有本來就壓在死亡線上的那一列被擠出盤面才死 —— 最後一發還沒射就又被插一排,就是沒救了。 */
  function insertRow(st, cols){
    st.par ^= 1;
    const row = new Array(COLS).fill(0);
    const w = isOdd(st.par, 0) ? COLS - 1 : COLS;
    for(let x = 0; x < w; x++) row[x] = cols[x] || 1;
    st.board.unshift(row);
    const out = st.board.pop();         // 原本的第 DEAD 列
    let over = false;
    for(let x = 0; x < COLS; x++) if(out[x]) over = true;
    if(over){ st.dead = true; st.deadT = 0; }
    return !over;
  }

  /* ==========================================================================
     五、一局的狀態(純資料,可以直接 JSON.stringify)
     ========================================================================== */
  function blank(o){
    o = o || {};
    const st = {
      seed:   (o.seed >>> 0) || 1,
      rules:  normRules(o.rules),
      board:  emptyBoard(),
      par:    0,
      rowN:   0,                        // 已經用自己的 seed 產生了幾排(開局 / 壓力 / 補排)
      idx:    0,                        // 已經發到第幾顆
      cur:    1, next: 1,               // 目前這一顆 / 下一顆的顏色
      aim:    0,                        // 瞄準角(弧度,0 = 正上方,負 = 往左)
      shot:   null,                     // 飛行中:{ x, y, vx, vy, c, rem }
      idle:   0,                        // 多久沒射了(自動發射)
      shots:  0,                        // 已經射出幾發
      since:  0,                        // 距離上一次壓力插排射了幾發
      pend:   [],                       // 待處理垃圾 [{ n, gs, from }](n = 排數)
      shield: 0,
      combo:  0,
      popped: 0,                        // 累計消掉 + 掉落幾顆(HUD 的主數字)
      sent:   0,                        // 累計送出幾排
      ko:     0, deaths: 0,
      time:   0,
      dead:   false, deadT: 0,
      revBy:  "", revT: -1e9,           // ⚠ -1e9 而不是 0:0 會讓開局那一刻落在反擊窗裡
      rush:   false
    };
    st.shield = st.rules.shield;
    fillStart(st);
    st.cur  = drawColor(st);
    st.next = drawColor(st);
    return st;
  }
  function fillStart(st){
    for(let i = 0; i < INIT_ROWS; i++) insertRow(st, rowAt(st.seed, st.rowN++));
  }
  function drawColor(st){
    const i = st.idx++;
    return fitColor(st.board, colorAt(st.seed, i), i);
  }
  function level(st){ return Math.min(PRESS.length, 1 + Math.floor(st.time / LV_MS)); }
  function pressN(st){ return PRESS[level(st) - 1]; }

  /* ==========================================================================
     六、操作
     ========================================================================== */
  function clampAim(a){
    a = Number(a) || 0;
    return a < -MAX_AIM ? -MAX_AIM : (a > MAX_AIM ? MAX_AIM : a);
  }
  function aim(st, a){ st.aim = clampAim(a); return st.aim; }
  /* 交換目前 / 下一顆。⚠ 飛行中也可以換 —— 換的是發射器上那兩顆,不是飛出去的那一顆 */
  function swap(st){
    if(st.dead) return false;
    const t = st.cur; st.cur = st.next; st.next = t;
    return true;
  }
  function canFire(st){ return !st.dead && !st.shot; }
  /* 發射。回傳事件或 null(飛行中 / 死了) */
  function fire(st){
    if(!canFire(st)) return null;
    const a = st.aim;
    st.shot = { x: LX, y: LY, vx: Math.sin(a), vy: -Math.cos(a), c: st.cur, rem: 0 };
    st.cur = st.next;
    st.next = drawColor(st);
    st.idle = 0;
    st.shots++;
    return { t: "fire", c: st.shot.c, a: a };
  }

  /* ==========================================================================
     七、飛行(紅線 ②:trace 與即時飛行共用 flyStep)
     ──────────────────────────────────────────────────────────────────────────
       一步 = 往前 SUB,碰到牆就反彈,碰到天花板或泡泡就回傳要吸附的格子。
     ========================================================================== */
  function flyStep(board, par, s){
    s.x += s.vx * SUB;
    s.y += s.vy * SUB;
    if(s.x < 0.5){ s.x = 1 - s.x; s.vx = -s.vx; s.bounce = (s.bounce || 0) + 1; }
    else if(s.x > COLS - 0.5){ s.x = 2 * COLS - 1 - s.x; s.vx = -s.vx; s.bounce = (s.bounce || 0) + 1; }
    if(s.y <= 0.5) return snapCell(board, par, s.x, 0.5);
    const ry = Math.round((s.y - 0.5) / RH);
    for(let y = Math.max(0, ry - 1); y <= Math.min(ROWS - 1, ry + 1); y++){
      for(let x = 0; x < COLS; x++){
        if(!board[y][x]) continue;
        const dx = cx(par, x, y) - s.x, dy = cy(y) - s.y;
        if(dx * dx + dy * dy < HIT * HIT) return snapCell(board, par, s.x, s.y);
      }
    }
    return null;
  }
  /* 吸附:離 (px,py) 最近、合法、空的、**有東西撐著**的格子(紅線 ③) */
  function supported(board, par, x, y){
    if(y === 0) return true;
    const ns = neighbors(par, x, y);
    for(let i = 0; i < ns.length; i++) if(board[ns[i][1]][ns[i][0]]) return true;
    return false;
  }
  function snapCell(board, par, px, py){
    let best = null, bestD = 1e9, any = null, anyD = 1e9;
    const ry = Math.round((py - 0.5) / RH);
    for(let y = Math.max(0, ry - 2); y <= Math.min(ROWS - 1, ry + 2); y++){
      for(let x = 0; x < COLS; x++){
        if(!valid(par, x, y) || board[y][x]) continue;
        const dx = cx(par, x, y) - px, dy = cy(y) - py;
        const d = dx * dx + dy * dy;
        if(d < anyD){ anyD = d; any = [x, y]; }
        if(d < bestD && supported(board, par, x, y)){ bestD = d; best = [x, y]; }
      }
    }
    return best || any;
  }
  /* 從發射器沿角度 a 飛出去會落在哪一格。回傳 { cell:[x,y]|null, path:[[x,y],…], bounce }
     path = 起點 + 每一次反彈點 + 終點(畫預瞄線用)。 */
  function trace(board, par, a){
    a = clampAim(a);
    const s = { x: LX, y: LY, vx: Math.sin(a), vy: -Math.cos(a), bounce: 0 };
    const path = [[s.x, s.y]];
    let guard = 2000;
    while(guard-- > 0){
      const b0 = s.bounce;
      const hit = flyStep(board, par, s);
      if(s.bounce !== b0) path.push([s.vx > 0 ? 0.5 : COLS - 0.5, s.y]);
      if(hit){
        path.push([s.x, s.y]);
        return { cell: hit, path: path, bounce: s.bounce };
      }
    }
    return { cell: null, path: path, bounce: s.bounce };
  }

  /* ==========================================================================
     八、落地 · 消除 · 掉落 · 攻擊
     ──────────────────────────────────────────────────────────────────────────
       順序**不可以換**(同方塊對戰 lock()):
         寫進盤面 → 死亡線判定 → 消除 → 掉落 → 攻擊 → 抵銷 → 加倍 →
         壓力插排 → 垃圾插排 → 補排(清空時)→ 重新對映發射器的顏色
     ========================================================================== */
  /* 在 board 上放一顆、算消除與掉落(**就地改 board**)。電腦的評分也走這一支。
     回傳 { pops:[[x,y,c]…], drops:[[x,y,c]…] } */
  function resolve(board, par, x, y, c){
    board[y][x] = c;
    const pops = [], drops = [];
    // 同色相連
    const seen = {}, group = [[x, y]];
    seen[x + "," + y] = 1;
    for(let i = 0; i < group.length; i++){
      const ns = neighbors(par, group[i][0], group[i][1]);
      for(let j = 0; j < ns.length; j++){
        const k = ns[j][0] + "," + ns[j][1];
        if(seen[k] || board[ns[j][1]][ns[j][0]] !== c) continue;
        seen[k] = 1; group.push(ns[j]);
      }
    }
    if(group.length >= 3){
      group.forEach(p => { pops.push([p[0], p[1], c]); board[p[1]][p[0]] = 0; });
      // 掉落:從第 0 列還連得到的留下,其餘全部掉
      const keep = {}, q = [];
      for(let xx = 0; xx < COLS; xx++) if(board[0][xx]){ keep[xx + ",0"] = 1; q.push([xx, 0]); }
      for(let i = 0; i < q.length; i++){
        const ns = neighbors(par, q[i][0], q[i][1]);
        for(let j = 0; j < ns.length; j++){
          const k = ns[j][0] + "," + ns[j][1];
          if(keep[k] || !board[ns[j][1]][ns[j][0]]) continue;
          keep[k] = 1; q.push(ns[j]);
        }
      }
      for(let yy = 0; yy < ROWS; yy++)
        for(let xx = 0; xx < COLS; xx++){
          const v = board[yy][xx];
          if(v && !keep[xx + "," + yy]){ drops.push([xx, yy, v]); board[yy][xx] = 0; }
        }
    }
    return { pops: pops, drops: drops };
  }

  function land(st, cell){
    const s = st.shot;
    st.shot = null;
    const ev = { t: "land", c: s ? s.c : 0, x: -1, y: -1, pops: [], drops: [],
                 atk: 0, out: 0, cancelled: 0, combo: 0, pc: false,
                 garb: 0, press: 0, dead: false };
    if(!s || !cell){ return ev; }
    ev.x = cell[0]; ev.y = cell[1];
    const onLine = lowest(st.board) >= DEAD;   // 這一發是「最後一發」(紅線 ⑦)
    const r = resolve(st.board, st.par, cell[0], cell[1], s.c);
    ev.pops = r.pops; ev.drops = r.drops;

    /* 死亡線:消完還有東西留在第 DEAD 列 → 死。
       ⚠ 在消除**之後**判:貼著死亡線湊成三顆消掉的那一發是救命的,不是自殺。
       最後一發沒把死亡線清乾淨也是在這裡死。 */
    if(lowest(st.board) >= DEAD){ st.dead = true; st.deadT = 0; ev.dead = true; return ev; }
    if(onLine) ev.saved = true;         // 最後一發救回來了(畫面要大聲講)

    const n = r.pops.length;
    if(n){
      st.combo++;
      st.popped += n + r.drops.length;
    }else{
      st.combo = 0;
    }
    ev.combo = st.combo;

    if(n){
      let atk = rowsOf((n - 3) + r.drops.length);
      if(st.rules.combo) atk += comboAtk(st.combo);
      ev.pc = count(st.board) === 0;
      if(ev.pc) atk += PC_ATK;
      ev.atk = atk;
      let out = cancel(st, atk);        // 先抵銷自己的,剩下的才送出去
      ev.cancelled = atk - out;
      if(st.rush) out *= 2;             // ★ 紅線 ④:加倍一律在抵銷之後
      if(out > 0 && st.revBy && (st.time - st.revT) <= REVENGE_MS){
        out *= 2;
        ev.to = st.revBy;               // ⚠ 反擊一定打回給打我的那個人
        ev.revenge = true;
        st.revBy = "";
      }
      ev.out = out;
      st.sent += out;
    }

    /* 壓力:每射 N 發插一排(用自己的 seed —— 同一局每個人拿到的壓力排一模一樣) */
    st.since++;
    if(st.since >= pressN(st)){
      st.since = 0;
      ev.press = 1;
      if(!insertRow(st, rowAt(st.seed, st.rowN++))){ ev.dead = true; return ev; }
    }
    ev.garb = applyPending(st);
    if(st.dead){ ev.dead = true; return ev; }
    /* 清空了:補幾排讓人有東西可以打(不然接下來每一發都直直飛到天花板) */
    if(count(st.board) === 0){
      for(let i = 0; i < REFILL; i++) insertRow(st, rowAt(st.seed, st.rowN++));
    }
    st.cur  = fitColor(st.board, st.cur, st.idx + 7);
    st.next = fitColor(st.board, st.next, st.idx + 13);
    return ev;
  }

  /* 用 atk 排抵銷自己的待處理垃圾,回傳抵銷不完、要送出去的排數 */
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
  /* 收到攻擊 → 進佇列(不立刻插進來)。
     ⚠ gs 是**送出端決定的**垃圾顏色種子,接收端不可以自己重抽(對手小盤要對得上)。 */
  function queueGarbage(st, n, gs, from){
    n = Math.max(0, Math.round(Number(n) || 0));
    /* 手下留情(紅線 ⑦):看的是**收到的這一刻**自己的盤面 —— 接收端決定,送出端的小盤不必知道 */
    if(n && lowest(st.board) >= MERCY_LOW) n = Math.ceil(n / 2);
    if(!n) return 0;
    if(st.shield > 0 && pendCount(st) >= SHIELD_CAP) return 0;
    st.pend.push({ n: n, gs: (gs >>> 0), from: from || "", k: 0 });
    if(from){ st.revBy = from; st.revT = st.time; }
    return n;
  }
  /* 把佇列插進來(一發最多 GARB_CAP 排)。回傳插了幾排 */
  function applyPending(st){
    if(st.shield > 0) return 0;         // 暖身:照樣排隊、照樣顯示,就是不插進來
    let room = GARB_CAP, done = 0;
    while(room > 0 && st.pend.length){
      const p = st.pend[0];
      insertRow(st, rowAt(p.gs, p.k++));
      p.n--; room--; done++;
      if(p.n <= 0) st.pend.shift();
      if(st.dead) break;
    }
    return done;
  }

  /* ==========================================================================
     九、時間推進
     ========================================================================== */
  function tick(st, dt){
    const ev = [];
    dt = Math.max(0, Math.min(MAX_DT, Number(dt) || 0));   // ★ 紅線 ⑤
    if(st.dead){ st.deadT += dt; return ev; }
    st.time += dt;
    if(st.shield > 0){
      st.shield -= dt;
      if(st.shield <= 0){ st.shield = 0; ev.push({ t: "shield" }); }
    }
    if(st.shot){
      const s = st.shot;
      s.rem += SPEED * dt;
      let guard = 400;
      while(s.rem >= SUB && guard-- > 0){
        s.rem -= SUB;
        const b0 = s.bounce || 0;
        const hit = flyStep(st.board, st.par, s);
        if((s.bounce || 0) !== b0) ev.push({ t: "bounce" });
        if(hit){ ev.push(land(st, hit)); break; }
      }
    }else{
      st.idle += dt;
      if(st.idle >= AUTO_MS){
        const f = fire(st);
        if(f){ f.auto = true; ev.push(f); }
      }
    }
    return ev;
  }

  /* K.O. 賽的復活:換一盤新的,待處理垃圾清掉,**顏色序號與排序號繼續往下走** */
  function revive(st){
    st.board = emptyBoard();
    st.par = 0;
    st.shot = null;
    st.pend = [];
    st.combo = 0;
    st.dead = false; st.deadT = 0;
    st.deaths++;
    st.idle = 0; st.since = 0;
    st.revBy = ""; st.revT = -1e9;      // 同方塊對戰:剛活過來不帶反擊
    fillStart(st);
    st.cur  = fitColor(st.board, st.cur, st.idx + 7);
    st.next = fitColor(st.board, st.next, st.idx + 13);
    return st;
  }

  /* ==========================================================================
     十、編碼
     ──────────────────────────────────────────────────────────────────────────
       encBoard:ROWS × COLS 個字元('0' = 空、'1'..'6' = 顏色),**刻意不壓縮**
       (同方塊對戰:Firebase Console 裡肉眼就看得出盤面長什麼樣)。
       ⚠ par 要跟著盤面一起送 —— 少了它對手小盤會畫錯半格。
       snap:給對手小盤看的精簡快照,只保證畫得出來。
     ========================================================================== */
  function encBoard(board){
    let s = "";
    for(let y = 0; y < ROWS; y++) for(let x = 0; x < COLS; x++) s += String(board[y][x] & 7);
    return s;
  }
  function decBoard(s){
    const b = emptyBoard();
    if(typeof s !== "string" || s.length < ROWS * COLS) return b;
    let i = 0;
    for(let y = 0; y < ROWS; y++)
      for(let x = 0; x < COLS; x++){
        const v = s.charCodeAt(i++) - 48;
        b[y][x] = (v >= 1 && v <= NC) ? v : 0;   // 壞字元一律當空格
      }
    return b;
  }
  function snap(st){
    return { b: encBoard(st.board), q: st.par, c: st.cur, n: st.next,
             a: Math.round(st.aim * 100), p: pendCount(st),
             l: st.popped, ko: st.ko, d: st.dead ? 1 : 0 };
  }

  /* ==========================================================================
     十一、測試用小工具
     ──────────────────────────────────────────────────────────────────────────
       boardFrom:一列一行字串,'.' = 空、'1'..'6' = 顏色,**由第 0 列(天花板)往下寫**。
       交錯列照樣寫 8 個字元,最後一個會被忽略。
     ========================================================================== */
  function boardFrom(lines){
    const b = emptyBoard();
    const arr = String(lines).split("\n").filter(s => s.length);
    for(let y = 0; y < arr.length && y < ROWS; y++)
      for(let x = 0; x < COLS && x < arr[y].length; x++){
        const v = arr[y].charCodeAt(x) - 48;
        b[y][x] = (v >= 1 && v <= NC) ? v : 0;
      }
    return b;
  }
  function boardText(board, par){
    const out = [];
    for(let y = 0; y < ROWS; y++){
      let s = isOdd(par || 0, y) ? " " : "";
      for(let x = 0; x < COLS; x++){
        if(!valid(par || 0, x, y)) continue;
        s += (board[y][x] ? String(board[y][x]) : ".") + " ";
      }
      out.push((y === DEAD ? "~" : " ") + s);
    }
    return out.join("\n");
  }

  return {
    // 常數
    COLS, ROWS, DEAD, RH, NC, LX, LY, H, SPEED, SUB, HIT, MAX_AIM,
    LV_MS, PRESS, AUTO_MS, MAX_DT, INIT_ROWS, REFILL, GARB_CAP, SHIELD_CAP, MERCY_LOW,
    PC_ATK, REVENGE_MS, DEF_RULES,
    // 房規
    normRules, NOTES, noteOf, rowsOf, comboAtk,
    // 亂數
    rng, rowAt, colorAt,
    // 盤面
    emptyBoard, isOdd, valid, cx, cy, neighbors, count, lowest, present, fitColor,
    insertRow, supported, snapCell, resolve,
    // 一局
    blank, level, pressN, clampAim, aim, swap, canFire, fire, trace, flyStep,
    land, tick, revive,
    // 垃圾
    queueGarbage, applyPending, cancel, pendCount,
    // 編碼
    encBoard, decBoard, snap,
    // 小工具
    boardFrom, boardText
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = BUB;

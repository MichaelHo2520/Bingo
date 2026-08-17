"use strict";

/* ============================================================================
   房間分享(QR + Web Share)—— 十四頁共用
   ──────────────────────────────────────────────────────────────────────────
   ★★★ 這一支解決的事:現場有人晚到,要他加入正在玩的那一間房**沒有辦法**——
       大廳只有「建立房間」與「偵測到的房間清單」,而清單靠的是 Firebase 的
       `*_index` 節點,晚到的人要先自己開對的那一頁、等偵測、再從清單裡認出
       哪一間是我們這桌的。對「一群人擠在同一張桌子」這個受眾來說,
       正確的動作是**把手機舉起來給他掃**。

   ★ 為什麼幾乎沒有新東西要做:`?join=<4 位房號>` 的自動入房 **早就存在**
     (ui-kit.js 的 autoJoinFromQuery,v1.52.0 為了首頁看板做的)——
     那條路徑一直只有 index.html 的「現在有人在玩」看板在用。
     這一支只是把同一個 URL 變成一張圖 + 一顆系統分享鈕。

   ★★ 檔案結構照 `talk.js` 的先例:**邏輯與 UI 收在同一支**,十四頁(含 Bingo)
      共用同一份。Bingo 不載入 `js/shared/` 的其餘檔案(紅線 2 的物理隔離),
      照 ui-kit 那個結構就得複製第二份 → 又一組 CLAUDE.md 紅線 4 說的雙胞胎。
      → 一頁要接房間分享只剩兩件事:載入這支 + 呼叫一次 RoomShare.bindUi()。
   ⚠ 這裡**不可以**自己宣告 `$` / `showToast`:那兩個在 game.js(Bingo)與
     ui-kit.js(十三頁)各有一份全域定義,重複宣告 const 會整頁 SyntaxError。

   ── 三條紅線 ──────────────────────────────────────────────────────────────
   ① **QR 編碼器是自己實作的,不可以換成 CDN 上的函式庫。** 這是 PWA,
      `sw.js` 明講「外部資源不攔截」→ 離線時 CDN 抓不到,而**離線正是這個功能
      最需要在的時候**(現場網路爛、大家擠同一個熱點)。編碼器是純函式、
      零相依,守門在 `tools/verify-qr.js`(拿 Python 的 segno 逐 module 比對)。

   ② **`navigator.share()` 一定要直接在 click handler 裡同步呼叫。**
      iOS 要求它發生在使用者手勢裡 —— 中間 await 任何東西(哪怕是已經 resolve
      的 Promise)都會讓它變成 NotAllowedError。同一條規矩在
      `js/draw/main.js` 分享畫作那裡踩過一次,原始處方在那支的長註解。

   ③ **`share()` 被使用者按取消時會 reject `AbortError`,那不是錯誤。**
      照 catch 一律出 toast 的話,每次按取消都會跳一則「分享失敗」。
   ========================================================================== */

const RoomShare = (function () {

  /* ==========================================================================
     第一部分:QR 編碼器(純函式,零 DOM)
     ──────────────────────────────────────────────────────────────────────────
     範圍刻意收窄:**位元組模式(UTF-8)· 容錯等級 M · 版本 1~10**。
     要編的東西永遠是自己這一頁的網址加 `?join=1234`(50~70 個字元上下),
     版本 4 就夠了;做到 10(M 級 216 個位元組)是留給網址很長的部署路徑。
     ⚠ 不做字母數字模式:網址裡有小寫,那個模式吃不下,判斷式白寫。
     ★ 容錯選 M(約 15%):L 更疏、更好掃,但現場是拿手機拍另一支手機的螢幕
       (有反光、有摩爾紋),M 這一級的冗餘換得回來。
     ========================================================================== */

  /* GF(256) 的對數表,本原多項式 0x11D。EXP 開兩倍長度是為了讓
     `EXP[LOG[a]+LOG[b]]` 不必再取模(兩個 log 相加最大 508)。 */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  /* 各版本的總碼字數(v1~v10)。★ 這是「資料 + 糾錯」的總和,與版本的模組數對得起來,
     底下 ECB 的分塊表要能整除進這個數字 —— verify-qr.js 會把兩者對一次。 */
  const TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  /* 容錯 M 的分塊表:[每塊的糾錯碼字數, [[塊數, 每塊資料碼字數], …]]。
     ⚠ 第二組(v8/v9/v10)是**兩種不同大小的塊**,交錯時短的那一種先用完 ——
       底下 interleave 那一段的 `if (i < b.length)` 就是為它寫的,不是防呆。 */
  const ECB = [
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]]
  ];

  /* 校正圖案的中心座標(v1 沒有)。兩兩組合就是所有中心,但**三個定位角不放**
     (第一×第一、第一×最後、最後×第一)—— 那個排除條件寫在 skeleton() 裡,
     而它有一個很容易踩的陷阱,見那一段的 ⚠⚠。 */
  const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
                 [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  const PEN_N1 = 3, PEN_N2 = 3, PEN_N3 = 40, PEN_N4 = 10;

  /* 產生 RS 生成多項式,係數由高次到低次。 */
  function genPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      const np = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        np[j] ^= p[j];                       // 乘上 x
        np[j + 1] ^= gmul(p[j], EXP[i]);     // 乘上 a^i
      }
      p = np;
    }
    return p;
  }

  /* 算糾錯碼字 = data 補 ecLen 個 0 之後除以生成多項式的餘式。
     ★ g[0] 恆為 1,所以每一輪 res[i] 會被自己消成 0 —— 那正是長除法在做的事。 */
  function rsEncode(data, ecLen) {
    const g = genPoly(ecLen);
    const res = new Uint8Array(data.length + ecLen);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (f === 0) continue;
      for (let j = 0; j < g.length; j++) res[i + j] ^= gmul(g[j], f);
    }
    return Array.from(res.slice(data.length));
  }

  function dataWords(ver) {
    return ECB[ver - 1][1].reduce((s, g) => s + g[0] * g[1], 0);
  }

  /* 挑放得下的最小版本。★ 字元計數欄在 v1~v9 是 8 位元、v10 起是 16 位元,
     所以「多一個版本一定放得下更多」在 v9→v10 的交界並非恆真 —— 一律逐版試。 */
  function pickVersion(len) {
    for (let v = 1; v <= 10; v++) {
      const cap = Math.floor((dataWords(v) * 8 - 4 - (v >= 10 ? 16 : 8)) / 8);
      if (len <= cap) return v;
    }
    return 0;   // 放不下(網址長到 213 個位元組以上,實務上不會發生)
  }

  /* 位元組模式的位元流 → 補齊 → 分塊 → 糾錯 → 交錯,回傳最終碼字序列。 */
  function encodeData(bytes, ver) {
    const ecLen = ECB[ver - 1][0], groups = ECB[ver - 1][1];
    const dc = dataWords(ver);
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

    push(0b0100, 4);                          // 模式指示碼:位元組
    push(bytes.length, ver >= 10 ? 16 : 8);   // 字元計數
    for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);

    const cap = dc * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // 終止符(不足 4 位就少放)
    while (bits.length % 8) bits.push(0);

    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      words.push(v);
    }
    const PAD = [0xEC, 0x11];
    for (let k = 0; words.length < dc; k++) words.push(PAD[k & 1]);

    const dataBlocks = [], ecBlocks = [];
    let p = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      for (let i = 0; i < groups[gi][0]; i++) {
        const blk = words.slice(p, p + groups[gi][1]); p += groups[gi][1];
        dataBlocks.push(blk);
        ecBlocks.push(rsEncode(blk, ecLen));
      }
    }

    const out = [];
    let maxD = 0;
    for (let i = 0; i < dataBlocks.length; i++) maxD = Math.max(maxD, dataBlocks[i].length);
    for (let i = 0; i < maxD; i++) for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
    for (let i = 0; i < ecLen; i++) for (let b = 0; b < ecBlocks.length; b++) out.push(ecBlocks[b][i]);
    return out;
  }

  /* BCH:格式資訊 15 位元(生成式 0x537,再 XOR 0x5412 打散全 0 的情形)。
     ★ 容錯 M 的指示碼是 0b00 —— 不是 0b01,那是 L。抄錯的話掃出來是空的。 */
  function formatBits(mask) {
    const data = (0b00 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  /* BCH:版本資訊 18 位元(生成式 0x1F25),只有 v7 以上才畫。 */
  function versionBits(ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (ver << 12) | rem;
  }

  function maskAt(mask, r, c) {
    switch (mask) {
      case 0: return (c + r) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (c + r) % 3 === 0;
      case 4: return (((c / 3) | 0) + ((r / 2) | 0)) % 2 === 0;
      case 5: return (c * r) % 2 + (c * r) % 3 === 0;
      case 6: return ((c * r) % 2 + (c * r) % 3) % 2 === 0;
      default: return ((c + r) % 2 + (c * r) % 3) % 2 === 0;
    }
  }

  /* 罰分裡「找出定位圖案那種 1:1:3:1:1 比例」的部分。
     ⚠ 這一段是整份編碼器最容易寫錯又最難發現的地方:寫錯只會讓遮罩選得比較差,
       掃描器通常還是讀得出來 → 肉眼與「能不能掃」都測不到,只有逐 module
       比對得出來(tools/verify-qr.js 存在的理由)。 */
  function finderCount(h) {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) +
           (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  }
  function finderPush(len, h, size) {
    if (h[0] === 0) len += size;    // 起手那一段外面補一圈白邊
    for (let i = h.length - 1; i > 0; i--) h[i] = h[i - 1];
    h[0] = len;
  }
  function finderEnd(color, len, h, size) {
    if (color) { finderPush(len, h, size); len = 0; }
    len += size;                    // 收尾那一段外面補一圈白邊
    finderPush(len, h, size);
    return finderCount(h);
  }

  function penalty(m, size) {
    let score = 0;
    for (let pass = 0; pass < 2; pass++) {          // 0 = 逐列,1 = 逐行
      for (let a = 0; a < size; a++) {
        let color = 0, run = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const v = pass === 0 ? m[a][b] : m[b][a];
          if (v === color) {
            run++;
            if (run === 5) score += PEN_N1; else if (run > 5) score++;
          } else {
            finderPush(run, hist, size);
            if (!color) score += finderCount(hist) * PEN_N3;
            color = v; run = 1;
          }
        }
        score += finderEnd(color, run, hist, size) * PEN_N3;
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += PEN_N2;
    }
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const total = size * size;
    const k = (((Math.abs(dark * 20 - total * 10) + total - 1) / total) | 0) - 1;
    return score + k * PEN_N4;
  }

  /* 把功能圖案畫好(定位 / 分隔 / 時序 / 校正 / 版本資訊 / 固定黑點),
     回傳 { m, fn }:fn 標記哪些格子是功能圖案(資料不能寫、遮罩不能翻)。 */
  function skeleton(ver) {
    const size = ver * 4 + 17;
    const m = [], fn = [];
    for (let i = 0; i < size; i++) { m.push(new Uint8Array(size)); fn.push(new Uint8Array(size)); }
    const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) { m[r][c] = v; fn[r][c] = 1; } };

    // 定位圖案 + 分隔白邊(-1..7 那一圈就是分隔)
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (o) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(o[0] + r, o[1] + c, (ring || core) ? 1 : 0);
      }
    });
    // 時序圖案
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
    /* 校正圖案:三個定位角(第一×第一、第一×最後、最後×第一)不放。
       ⚠⚠ 這裡**不可以**寫成「那一格已經是功能圖案就跳過」—— 看起來等價,而且
         v1~v6 完全測不出差別(那幾版的 ALIGN 只有兩個座標,中間沒有東西),
         但 v7 起中間多了一圈,而 (6,22) 與 (22,6) 這兩個中心**正好落在時序圖案上**
         → 會被誤判成「定位角」而整組不畫,接著功能圖案的分布就變了,
         資料排列跟著整片偏掉。症狀是「小的 QR 都對、大的忽然全錯」。 */
    const ap = ALIGN[ver - 1], last = ap.length - 1;
    for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        set(ap[i] + dr, ap[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
      }
    }
    /* 格式資訊的位置先佔起來(值等挑完遮罩才知道)。
       ⚠⚠ `i !== 6` 一定要跳過:第 6 列 / 第 6 欄是**時序圖案**,而格式資訊繞過它 ——
         少了這個條件就會把 (6,8) 與 (8,6) 兩格時序塗成白的。
         症狀特別惡劣:整張圖看起來完全正常(只有兩格),掃描器卻是靠時序圖案
         定出模組格線的,於是變成「有些手機掃得到、有些掃不到」。 */
    for (let i = 0; i <= 8; i++) { if (i !== 6) { set(8, i, 0); set(i, 8, 0); } }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
    // 版本資訊(v7 以上):左下與右上各一塊 6x3
    if (ver >= 7) {
      const vb = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1;
        const a = size - 11 + i % 3, b = (i / 3) | 0;
        set(a, b, bit);   // 左下
        set(b, a, bit);   // 右上
      }
    }
    set(size - 8, 8, 1);  // 固定黑點,永遠是黑的
    return { m: m, fn: fn, size: size };
  }

  /* 把碼字沿著「右邊兩欄一組、上下蛇行」填進去。
     ⚠ 第 6 欄是時序圖案,整欄跳過 —— `if (right === 6) right = 5` 那一行少了的話
       後面每一格都會偏一欄。 */
  function placeData(m, fn, size, words) {
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const up = ((right + 1) & 2) === 0;
          const r = up ? size - 1 - vert : vert;
          if (fn[r][c] || bi >= words.length * 8) continue;
          m[r][c] = (words[bi >>> 3] >>> (7 - (bi & 7))) & 1;
          bi++;
        }
      }
    }
  }

  /* 格式資訊有**兩份**(左上一份、右上+左下一份),兩份的位元順序不同。
     ⚠ 這裡的索引一律是 m[列][欄] —— 規格書與多數參考實作寫的是 (x, y) = (欄, 列),
       照抄過來很容易整組行列顛倒。顛倒的下場是 QR 完全掃不出來,而圖案看起來
       還是很像一張正常的 QR(只有那 31 格不一樣)→ 肉眼分辨不出來。 */
  function drawFormat(m, size, mask) {
    const b = formatBits(mask);
    const bit = i => (b >>> i) & 1;
    // 第一份:左上角,沿著第 8 欄由上往下、再沿著第 8 列由右往左
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
    // 第二份:第 8 列的右端 + 第 8 欄的下端
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
    m[size - 8][8] = 1;   // 固定黑點(被上一行的迴圈覆蓋過,所以要放最後)
  }

  /* 對外:文字 → 0/1 的二維陣列(不含四格白邊)。回傳 null 代表放不下。
     ★ 這一支也是 tools/verify-qr.js 的入口 —— 它拿 Python 的 segno 產同一組
       字串的矩陣逐格比對,包含「挑了哪一個遮罩」。 */
  function matrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const ver = pickVersion(bytes.length);
    if (!ver) return null;
    const words = encodeData(bytes, ver);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const sk = skeleton(ver);
      placeData(sk.m, sk.fn, sk.size, words);
      for (let r = 0; r < sk.size; r++) for (let c = 0; c < sk.size; c++) {
        if (!sk.fn[r][c] && maskAt(mask, r, c)) sk.m[r][c] ^= 1;
      }
      drawFormat(sk.m, sk.size, mask);
      const sc = penalty(sk.m, sk.size);
      if (sc < bestScore) { bestScore = sc; best = sk.m; }
    }
    return best.map(row => Array.from(row));
  }

  /* ==========================================================================
     第二部分:畫到 canvas
     ──────────────────────────────────────────────────────────────────────────
     ⚠ 一律**黑碼白底**,不吃主題色。五個主題有三個的強調色對比度不足以掃
       (泡泡糖的粉紅配深底最慘),而「掃不掃得到」不是可以拿來玩配色的東西。
       白底那一圈 quiet zone(4 格)同理是規格要求,不是留白美感。
     ⚠ 尺寸一律取整數倍再置中:非整數的話 canvas 會在模組邊緣做反鋸齒,
       糊掉的邊緣正是掃描器分不出黑白的地方。
     ========================================================================== */
  const QUIET = 4;
  function draw(cv, text) {
    const mat = matrix(text);
    if (!mat) return false;
    const n = mat.length, need = n + QUIET * 2;
    const css = Math.min(300, Math.max(200, Math.floor((window.innerWidth || 360) * 0.62)));
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const scale = Math.max(1, Math.floor(css * dpr / need));   // 每個模組幾個實體像素
    const px = need * scale;
    cv.width = px; cv.height = px;
    cv.style.width = Math.round(px / dpr) + "px";
    cv.style.height = Math.round(px / dpr) + "px";
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (mat[r][c]) ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
    }
    return true;
  }

  /* ==========================================================================
     第三部分:UI
     ========================================================================== */

  let room = null;       // { code, name } —— 由 mp-core / online.js 進房時餵進來
  let built = false;

  function toast(msg) {
    // 兩份都叫 showToast(game.js / ui-kit.js),但這一支可能被沒有它的頁面載入
    try { if (typeof showToast === "function") showToast(msg); } catch (e) { }
  }

  /* 分享用的網址 = 這一頁自己 + ?join=<房號>。
     ⚠ 一律砍掉既有的 query 與 hash:`autoJoinFromQuery` 進房後會把 `?join=`
       從網址上抹掉,但別的參數(以及 Bingo 的 `#home`)可能還在,
       原封不動接上去的話分享出去的連結會把對方帶到別的畫面。 */
  function shareUrl() {
    if (!room) return "";
    return location.origin + location.pathname + "?join=" + room.code;
  }
  function shareable() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  const ICO =
    '<svg class="qr-ico" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path class="qr-ico-ring" d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/>' +
      '<path class="qr-ico-dot" d="M6 6h2v2H6zM16 6h2v2h-2zM6 16h2v2H6z"/>' +
      '<path class="qr-ico-dot" d="M14 14h2v2h-2zM18 14h2v2h-2zM16 16h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/>' +
    '</svg>';

  /* 蓋板與觸發鈕都是**這一支自己建的**,十四頁的 HTML 一個字都不必改
     (talk.js 那兩顆鈕還留在各頁 HTML 裡,那是十四份會慢慢分岔的東西)。
     ⚠ 蓋板要掛進 BACK_LAYERS(ui-kit.js 與 game.js 各一份,紅線 7)——
       漏掉的話手機按返回鍵跳出來的是「離開房間?」。 */
  function build() {
    if (built) return;
    const sub = document.getElementById("mpSubrow");
    if (!sub) return;                       // 這一頁沒有連線畫面

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qr-open hidden";
    btn.id = "qrOpenBtn";
    btn.title = "邀請朋友加入這一間房";
    btn.setAttribute("aria-label", "邀請朋友加入這一間房");
    btn.innerHTML = ICO + '<span class="qr-open-t">邀請</span>';
    sub.appendChild(btn);

    const veil = document.createElement("div");
    veil.className = "veil";
    veil.id = "qrVeil";
    veil.innerHTML =
      '<div class="set-card qr-card">' +
        '<button class="card-x" id="qrClose" type="button" aria-label="關閉">✕</button>' +
        '<div class="set-head">邀請朋友加入</div>' +
        '<div class="qr-room" id="qrRoom"></div>' +
        '<canvas class="qr-canvas" id="qrCanvas" aria-label="房間連結的 QR Code"></canvas>' +
        '<div class="qr-tip" id="qrTip">用手機相機掃一下,直接進這一間房</div>' +
        '<div class="qr-acts">' +
          '<button class="btn primary qr-btn" id="qrShare" type="button">分享連結</button>' +
          '<button class="btn qr-btn" id="qrCopy" type="button">複製連結</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(veil);

    btn.addEventListener("click", open);
    document.getElementById("qrClose").addEventListener("click", close);
    veil.addEventListener("click", e => { if (e.target === veil) close(); });

    /* ⚠⚠ 分享鈕**沒有任何 await**:iOS 要求 navigator.share() 發生在使用者手勢裡,
       中間放一個 await 就會變成 NotAllowedError(檔頭紅線 ②)。
       ⚠ 按取消會 reject AbortError —— 那不是錯誤,不可以出 toast(紅線 ③)。 */
    document.getElementById("qrShare").addEventListener("click", () => {
      const url = shareUrl();
      if (!url) return;
      const title = (room.name || "派對遊戲") + " · 一起玩";
      if (navigator.share) {
        navigator.share({ title: title, text: "來玩!點這個連結直接進房間:", url: url })
          .catch(err => { if (!err || err.name !== "AbortError") copy(url); });
      } else {
        copy(url);
      }
    });
    document.getElementById("qrCopy").addEventListener("click", () => copy(shareUrl()));

    built = true;
  }

  /* 複製:clipboard API → 舊的 execCommand → 都不行就把網址選起來讓使用者自己複製。
     ⚠ clipboard.writeText 在 http(非 https)與部分 WebView 上不存在,
       而這個專案本機測試就是走 http —— 後備不是防呆,是常態路徑。 */
  function copy(url) {
    if (!url) return;
    const done = () => toast("連結複製好了,貼給朋友就行");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => legacyCopy(url, done));
    } else {
      legacyCopy(url, done);
    }
  }
  function legacyCopy(url, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) { done(); return; }
    } catch (e) { }
    toast("這個瀏覽器不給複製,請直接讓朋友掃 QR");
  }

  function open() {
    if (!room) return;
    build();
    const veil = document.getElementById("qrVeil");
    if (!veil) return;
    document.getElementById("qrRoom").textContent =
      (room.name || "房間") + " · 房號 " + room.code;

    /* 走 file:// 開的時候網址分享不出去(對方打不開),QR 直接收起來 ——
       留一張掃了會失敗的圖比沒有更糟。 */
    const cv = document.getElementById("qrCanvas");
    const tip = document.getElementById("qrTip");
    const ok = shareable() && draw(cv, shareUrl());
    cv.classList.toggle("hidden", !ok);
    document.getElementById("qrShare").classList.toggle("hidden", !ok);
    document.getElementById("qrCopy").classList.toggle("hidden", !ok);
    tip.textContent = ok
      ? "用手機相機掃一下,直接進這一間房"
      : "本機檔案模式沒辦法分享連結 —— 傳到網路上才有得掃";

    veil.classList.add("show");
  }
  function close() {
    const veil = document.getElementById("qrVeil");
    if (veil) veil.classList.remove("show");
  }

  return {
    /* 一頁接房間分享要做的兩件事之一(另一件是載入這支)。
       ⚠ 這一支只建 DOM、不顯示鈕 —— 鈕要等 setRoom() 才亮起來。 */
    bindUi() { build(); },

    /* 進房 / 房名變了的時候由連線層叫一次;離房叫 setRoom(null)。
       ⚠ 房號是 4 位字串,**不可以傳數字** —— "0123" 變成 123 之後
         `?join=` 那條正規表示式(\d{4})就對不上了,而症狀是分享出去的
         連結進得了頁面卻停在大廳。 */
    setRoom(code, name) {
      room = code ? { code: String(code), name: name || "" } : null;
      build();
      const btn = document.getElementById("qrOpenBtn");
      if (btn) btn.classList.toggle("hidden", !room);
      if (!room) close();
    },

    open: open,
    close: close,
    /* 診斷用(產品碼不呼叫這兩支,比照 Talk.iceServers() 的先例):
       · matrix() → tools/verify-qr.js 拿它跟 Python 的 qrcodegen 逐 module 比對
       · urlFor() → tools/t-qr-e2e.html 驗「房號有沒有正確進到網址裡」。
         ⚠ 這一項一定要獨立驗得到:e2e 跑在 file:// 上,而 file:// 時 QR 是
           **刻意收起來的**(掃了也沒用)→ 光看畫面驗不到房號那一段。 */
    matrix: matrix,
    urlFor: shareUrl
  };
})();

"use strict";

/* ============================================================================
   你畫我猜 — 規則層(DWR)。★ 純函式:零 DOM、零 Firebase、零計時器。
   一整場的真相由這一支算出來,adapter 只負責「什麼時候把算出來的結果寫進 DB」。

   ⚠ 這一支是 CLAUDE.md 紅線 16 的成員(純函式清單之一)——
     碰一行 DOM 就只能在瀏覽器裡手動玩,node 測試會整支失效。

   ★★ 四件「不知道就會做錯」的事(完整版在 notes/21 的〇節):
     ① **2 人局的計分公式與 3 人以上完全不同**:沒有「第幾個猜中」,改成依猜中秒數分段。
        寫成「名次分表只有一格」是錯的 —— 那會讓 2 人局的猜題者永遠拿 200。
     ② **總回合數不是固定值**:它是「還活著的人 × 每人幾次」,而**有人中途離開就會變**。
        `plan()` / `nextLive()` 一律用「現在還在房裡的人」重算,不可以拿開局那一刻的數字。
     ③ **答案比對只認正規化後的完全相等**(或同義詞),**絕不用 includes()** ——
        「我猜是貓」會包含「貓」,而那不是猜中,是聊天。
     ④ **畫家分一定要跟「這一回合猜題者拿了多少」掛鉤**(v1.163.0)——
        寫成一張「幾個人猜中 → 幾分」的固定表,在數學上會**獎勵故意畫爛**。
        完整的推導與那張反例表在下面 drawerPts 上面那一段。
   ========================================================================== */

const DWR = (function () {

  /* ---------- 相位時長(毫秒)----------
     ★ 只有 draw 吃房規(45 / 60 / 90 秒);pick 與 show 是固定值。
     ⚠ pick 給 15 秒是刻意的:三選一不必想太久,而畫家發呆時全房都在等他。
       到期由 adapter 幫他選第一個(見 adapter 的 forcePick)。 */
  const PICK_MS = 15000;
  const SHOW_MS = 5000;
  const SECS = [45, 60, 90];          // 作畫秒數的選項;預設值也寫在 draw.html 的 .on
  const ROUNDS = [1, 2, 3];           // 每人當幾次畫家
  const DIFFS = ["easy", "std", "hard"];
  const DEF_SEC = 60, DEF_ROUNDS = 2, DEF_DIFF = "std";

  /* ---------- 房規:白名單正規化 ----------
     ⚠ 一律走這一支(不要在別處各自 if):舊房間沒有這個欄位、手改 DB 的怪值
       都要退回預設,不能讓一個亂字串把開局卡住(比照 UNO / 大老二的 normRules)。
     ⚠ 難度的白名單**寫在這裡**而不是引用 DWGen.LEVELS —— 這一支要能被 node 單獨
       require 起來測(見檔尾),引用另一支就綁死了載入順序。兩邊的鍵一致由
       tools/test-draw-rules.js 的 A 節守著。 */
  function normRules(r) {
    r = r || {};
    return {
      sec: SECS.indexOf(r.sec) >= 0 ? r.sec : DEF_SEC,
      rounds: ROUNDS.indexOf(r.rounds) >= 0 ? r.rounds : DEF_ROUNDS,
      diff: DIFFS.indexOf(r.diff) >= 0 ? r.diff : DEF_DIFF
    };
  }
  function sameRules(a, b) {
    a = normRules(a); b = normRules(b);
    return a.sec === b.sec && a.rounds === b.rounds && a.diff === b.diff;
  }

  /* ---------- 答案比對 ----------
     正規化:全形 ASCII 轉半形 → 去掉所有空白與標點 → 英文轉小寫。
     ⚠ 中文不做繁簡轉換 —— 題庫本身就是繁體,而那種對照表是另一個量級的東西
       (而且猜錯本來就是這個遊戲的笑點)。
     ⚠⚠ 字元類別一律寫成 \u 碼點,**不要真的把那些符號打進去**:
       全形標點在編輯器裡跟半形長得幾乎一樣,肉眼校不出漏了哪一個。
         　-〿 中日韓標點與全形空白(、。「」…)
         ！-･ 全形 ASCII 與半形片假名標點
          -⁯ 一般標點(各種空白 / 破折號 / 引號) */
  const WIDE = /[！-～]/g;
  const PUNCT = /[\s　-〿！-･ -⁯!-\/:-@\[-`{-~]/g;
  function norm(s) {
    return String(s == null ? "" : s)
      .replace(WIDE, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(PUNCT, "")
      .toLowerCase();
  }
  /* 猜對了嗎。word = 題庫的一筆 {w:"汽車", a:["車子","轎車"]}(a 可以沒有)。
     ★ **完全相等**才算(見檔頭 ③),同義詞也是完全相等 —— 不做包含、不做編輯距離。
     ⚠ 正規化後變成空字串一律不算(只打了標點 / 空白送出)。 */
  function hit(guess, word) {
    const g = norm(guess);
    if (!g || !word) return false;
    if (g === norm(word.w)) return true;
    const alt = word.a || [];
    for (let i = 0; i < alt.length; i++) if (g === norm(alt[i])) return true;
    return false;
  }

  /* ---------- 猜錯的冷卻 ----------
     ★★ v1.167.0 起一律 **3 秒,不累積、不限次數**。使用者:「猜錯答案時只要凍結 3 秒,
       不需要累積,不需要限制次數,反正就是猜錯就凍結 3 秒,然後就可以再繼續猜」。
     ⚠ 所以這一支**不吃參數** —— 舊版是「第 1 次 5 秒 / 第 2 次 10 秒 / 第 3 次本題失格(-1)」,
       連帶 `out()`(這一題失格了沒)整支拿掉:**沒有「失格」這個狀態了**。
       回傳值恆為正數 → 呼叫端不必再分「負數 = 失格」那條路。
     ⚠ `d.miss` 還是要記:它是娛樂統計「亂槍打鳥」的來源(見 tally),
       只是不再影響「還能不能猜」,也不再影響「這一回合結束了沒」(見 roundDone)。 */
  const COOL_MS = 3000;
  function coolMs() { return COOL_MS; }

  /* ---------- 這一回合誰是畫家 ----------
     ★ order 是開局凍結的座位表;第 n 回合(0-based)由 order[n % order.length] 畫。
     ⚠ 但**離開的人不畫** —— 見 plan() / nextLive()。 */
  function drawerAt(order, n) {
    if (!order || !order.length) return null;
    return order[((n % order.length) + order.length) % order.length];
  }

  /* ---------- 總回合數與「下一個有效回合」 ----------
     ★★ 這是規則書第 11 節那條公平性核心的落地:每個**還在房裡的人**當畫家的次數相同。
     做法:把回合表想成 order 掃 rounds 遍;掃到的人已經不在房裡就整個跳過。
       · plan(order, alive, rounds)      → 還剩下哪些有效回合(索引清單)
       · nextLive(order, alive, from, r) → 從 from(含)起第一個「畫家還在」的回合索引
     ⚠⚠ 回合索引 n 一路遞增、**不重新編號** —— 重新編號的話重連的人會對不上
       (他手上的 ink/{n} 節點是用舊編號存的,而那是這一回合已經畫的東西)。 */
  function totalOf(order, rounds) {
    return (order || []).length * (ROUNDS.indexOf(rounds) >= 0 ? rounds : DEF_ROUNDS);
  }
  function plan(order, alive, rounds) {
    const tot = totalOf(order, rounds), list = [];
    alive = alive || {};
    for (let n = 0; n < tot; n++) { const d = drawerAt(order, n); if (d && alive[d]) list.push(n); }
    return list;
  }
  function nextLive(order, alive, from, rounds) {
    const tot = totalOf(order, rounds);
    alive = alive || {};
    for (let n = Math.max(0, from | 0); n < tot; n++) { const d = drawerAt(order, n); if (d && alive[d]) return n; }
    return -1;                                     // 沒有下一個了 = 這一場打完
  }

  /* ---------- 猜題者的分數 ----------
     ★★ 兩套公式(見檔頭 ①):
       · 3 人以上(猜題者 >= 2)→ 名次分 200 / 150 / 100 / 50(第 4 名以後都是 50)
       · 2 人局(猜題者 = 1)   → 依猜中秒數分段 200 / 150 / 100 / 70 / 50 / 30
     ⚠ 秒數分段用**上界**判定(0~10 秒 = 200):`sec <= 10`,不是 `< 10` ——
       規則書的表是「0～10 / 10～20」,邊界值歸給比較快的那一段。 */
  const RANK_PTS = [200, 150, 100];
  const RANK_TAIL = 50;
  const SOLO_STEP = [[10, 200], [20, 150], [30, 100], [40, 70], [50, 50]];
  const SOLO_TAIL = 30;
  function guessPts(rank, ms, solo) {
    if (solo) {
      const sec = Math.max(0, ms || 0) / 1000;
      for (let i = 0; i < SOLO_STEP.length; i++) if (sec <= SOLO_STEP[i][0]) return SOLO_STEP[i][1];
      return SOLO_TAIL;
    }
    return RANK_PTS[rank] !== undefined ? RANK_PTS[rank] : RANK_TAIL;
  }

  /* ---------- 畫家的分數(v1.163.0 全面改寫)----------
     ★★★ **舊公式在數學上獎勵「故意畫爛」。** 這不是體感問題,是算得出來的。

     舊版是一張查表 `[0,50,80,100,110,120]`(依幾個人猜中)。而這是**排名決勝**的
     遊戲 —— 真正決定輸贏的是「我的分數 − 對手的分數」,不是絕對分。畫家畫爛的時候
     自己拿 0,**但他同時把全場對手的分數也一起歸零了**,而對手的總分遠大於畫家分:

       人數  猜題者  全中時對手總分  對手平均  舊畫家分  「畫好」的相對得失
        2      1        150(15秒)     150       50         −100
        3      2           350          175       80          −95
        4      3           450          150      100          −50
        5      4           500          125      110          −15
        6      5           550          110      120          +10

     也就是**只有滿房 6 人時畫好才划算**,而親友聚會最常見的 3~5 人全部是「畫爛比較賺」。
     ⚠ 實際會發生的不是有人真的亂畫,是**三選一時挑最難的那一個** ——
       看起來完全正常、沒有人抓得到,效果一模一樣。舊規則等於在獎勵這件事。

     ★ 新公式:**畫家拿「對手平均分」的 DRAW_MULT 倍**,取整到 10。

         畫家分 = round( 這一回合猜題者拿到的總分 ÷ 猜題者人數 × 1.5 → 到 10 )

       係數 **> 1 就在數學上保證「畫好嚴格優於畫爛」**(畫爛時雙方都 0 = 相對 0),
       而且它**自動適應人數**,不必再維護一張隨人數漂移的表。1.5 是「畫得好的人
       真的能在自己那一輪拉開差距」的調校值 —— 它是一顆旋鈕,覺得畫家太賺就往下轉。
       實際值(全部猜中):3 人 260 · 4 人 230 · 5 人 190 · 6 人 170。
       ★ 而且單調:5 人局猜中 0~4 人 → 0 / 80 / 130 / 170 / 190,
         **多一個人猜懂,畫家就多拿一點** → 最佳策略變成「讓越多人越快猜中」。
       ★ 順手修好的第二件事:選題策略從「挑最難的」變成「**挑我最會畫的**」。

     ⚠⚠ **2 人局(猜題者只有 1 個)刻意留在舊值 50 —— 那是已知缺陷,不是漏改。**
       2 人局用「比誰分高」這個勝負判定,不管係數怎麼調都有洞。設畫家分 D、猜題者分 G:
         · D < G → 畫家想畫爛(兩邊歸零)
         · D > G → **猜題者想故意猜不中**(同一個病的反向版,而且更難察覺)
         · D = G → 那一輪對排名中性 → 整場永遠平手
       這是零和賽局的死結,不是公式調得不夠好。真正的解是**換掉勝負判定**
       (兩人合作闖關、一起衝一個目標分),那是換玩法、不是改公式,留給日後單獨做。
       在那之前留在舊值:至少與既有行為一致,不會多長出「故意不猜」這個新洞。

     ⚠ 防 NaN:sum 可能是 undefined / NaN(舊快照、手改過的 DB),而 NaN 一旦寫進
       d.pts 就再也算不回來(整場分數全毀,畫面上只看到一片空白)——
       一律先過 `+sum || 0`。這條是從舊版「表要夠長、不可以回 undefined」繼承下來的。 */
  const DRAW_MULT = 1.5;
  const DRAW_SOLO = 50;                  // 2 人局的畫家分(見上面那段)
  function drawerPts(sum, guessers) {
    const k = Math.max(0, guessers | 0);
    const s = Math.max(0, +sum || 0);
    if (k <= 0 || s <= 0) return 0;      // 沒有猜題者 / 一個人都沒猜中 → 0
    if (k === 1) return DRAW_SOLO;
    return Math.round(s / k * DRAW_MULT / 10) * 10;
  }

  /* ---------- 一回合的完整結算 ----------
     hits = { pid: {t:猜中時的毫秒數, o:第幾個猜中(0-based)} }(由 adapter 在交易裡寫)
     guessers = 這一回合「有資格猜」的人數(= 回合開始時在房裡的人 − 畫家)
     → 回傳 { pid: 這一回合得幾分 };沒得分的人不出現(呼叫端一律用 (x||0))。
     ⚠ solo 判定看的是 **guessers === 1**,不是「房裡有 2 個人」——
       中途有人離開時這兩個數字會不一樣,而規則書講的是「只有一個猜題者」那個情境。
     ⚠ v1.163.0 起畫家分吃的是**猜題者這一回合拿到的總分**(見 drawerPts),
       所以那個總和一定要在這裡邊算邊累加 —— 不可以事後拿 res 重算,
       因為畫家自己那一格也會寫進 res(加起來就把畫家分算進分母了)。 */
  function settle(drawerId, hits, guessers) {
    const res = {};
    const solo = guessers === 1;
    const ids = Object.keys(hits || {});
    let sum = 0;
    ids.forEach(id => {
      const h = hits[id] || {};
      const p = guessPts(h.o | 0, h.t | 0, solo);
      res[id] = (res[id] || 0) + p;
      sum += p;
    });
    if (drawerId) res[drawerId] = (res[drawerId] || 0) + drawerPts(sum, guessers);
    return res;
  }

  /* ---------- 這一回合結束了沒 ----------
     ★ 兩個條件任一成立:時間到(由 adapter 的計時器管)、或**所有猜題者都猜中了**
       (規則書第 13 節)—— 這一支只回答後者。
     ⚠⚠ v1.167.0 起**猜錯不會失格** → 這一支**不看 miss**(連參數都不收):沒猜中的人
       永遠算「還在猜」,所以沒人猜出來的那一題就是乾等到時間到 —— 那正是新規則要的
       (猜錯凍 3 秒、冷完繼續猜,不會有人被踢出這一題)。
       ⚠ 舊版有第三個參數 miss,用來把「三次猜錯的人」當成不必等 —— 別再加回來。
     ⚠ 一個猜題者都沒有(人都跑光了)回 true:那一回合已經沒有意義,直接收掉。 */
  function roundDone(guesserIds, hits) {
    hits = hits || {};
    for (let i = 0; i < guesserIds.length; i++) if (!hits[guesserIds[i]]) return false;
    return true;
  }

  /* ==========================================================================
     娛樂統計(v1.163.0)
     ──────────────────────────────────────────────────────────────────────────
       ★★ **一定要「每一回合結算時累加」,不可以事後回頭算** ——
         `d.hits` / `d.miss` 每一回合都會被清成 null(見 adapter 的 toNext),
         所以整場打完之後那些數字早就不在了。累加點只有一個:adapter 的 toShow。

       一個人一格,六個數字:
         g   當猜題者時猜中幾次        gm  猜錯幾次(累計)
         bt  最快猜中的那一次(毫秒;**沒猜中過是 -1**,不是 0 —— 0 是「零秒猜中」)
         dn  當了幾次畫家             dp  當畫家時總共拿了幾分
         dh  當畫家時被猜中的**人次**  dz  當畫家時「一個人都沒猜中」幾次

       ⚠⚠ 一律回**新的物件**,絕不可以改到傳進來的那一份:adapter 是在**交易的回呼**
         裡叫它的,而交易的回呼會被重跑(別人的寫入先到就整包重來)——
         就地累加的話重跑一次就多加一次,症狀是「猜題王顯示 7 題,但整場只有 4 回合」。 */
  function blankSt() { return { g: 0, gm: 0, bt: -1, dn: 0, dp: 0, dh: 0, dz: 0 }; }
  function tally(st, drawerId, hits, miss, add) {
    const out = {};
    Object.keys(st || {}).forEach(id => { out[id] = Object.assign(blankSt(), st[id]); });
    const get = id => (out[id] = out[id] || blankSt());
    hits = hits || {}; miss = miss || {}; add = add || {};
    const ids = Object.keys(hits);
    ids.forEach(id => {
      const r = get(id), t = Math.max(0, (hits[id] || {}).t | 0);
      r.g++;
      if (r.bt < 0 || t < r.bt) r.bt = t;
    });
    /* ⚠ miss 是「**這一回合**猜錯幾次」(每回合清掉)→ 這裡是加,不是覆寫。 */
    Object.keys(miss).forEach(id => { get(id).gm += Math.max(0, miss[id] | 0); });
    if (drawerId) {
      const d = get(drawerId);
      d.dn++; d.dp += Math.max(0, add[drawerId] | 0); d.dh += ids.length;
      if (!ids.length) d.dz++;
    }
    return out;
  }

  /* ---------- 賽末獎項 ----------
     ★ 刻意**只挑五個「講出來會有反應」的**,而且每一個都要夠格才給 ——
       全部都發的話結果卡會變成一張報表,而這是派對遊戲,笑點的密度比完整度重要。
     ⚠ 同分一律取 order 裡靠前的那一個(嚴格大於才換人)→ 穩定,不依賴 sort 的實作。
     ⚠ 「亂槍打鳥」門檻 3 次:猜錯一兩次是每個人都會的,那不好笑也不公道。
     ⚠ 這一支回的是**純資料**(含已經格式化好的字串),零 DOM —— 畫面在 adapter。 */
  const SPRAY_MIN = 3;
  function awards(order, st) {
    st = st || {};
    const rows = (order || []).map(id => Object.assign({ id: id }, blankSt(), st[id] || {}));
    const best = (ok, key) => {
      let b = null;
      rows.forEach(r => { if (ok(r) && (!b || key(r) > key(b))) b = r; });
      return b;
    };
    const out = [];
    const add = (r, ic, t, fmt) => { if (r) out.push({ id: r.id, ic: ic, t: t, v: fmt(r) }); };
    // 猜中最多題
    add(best(r => r.g > 0, r => r.g), "🏆", "猜題王", r => r.g + " 題");
    /* 最快猜中的那一次。⚠ bt 越小越好 → 比大小時取負數(而 -1 代表沒猜中過,先被 ok 擋掉)。 */
    add(best(r => r.bt >= 0, r => -r.bt), "⚡", "手最快", r => (r.bt / 1000).toFixed(1) + " 秒");
    // 當畫家時總共拿最多分(= 讓最多人、最快猜懂)
    add(best(r => r.dp > 0, r => r.dp), "🖌️", "神之筆", r => r.dp + " 分");
    // 當畫家時最多次「一個人都沒猜中」
    add(best(r => r.dz > 0, r => r.dz), "🌀", "抽象大師", r => r.dz + " 次沒人猜中");
    // 猜錯最多次(要夠多才好笑,見 SPRAY_MIN)
    add(best(r => r.gm >= SPRAY_MIN, r => r.gm), "💦", "亂槍打鳥", r => "猜錯 " + r.gm + " 次");
    return out;
  }

  /* ---------- 一場的最終名次 ----------
     → [{id, pts}] 由多到少;同分維持 order 的順序(穩定,不依賴 sort 的實作)。 */
  function standings(order, pts) {
    pts = pts || {};
    return (order || []).map((id, i) => ({ id: id, pts: pts[id] || 0, i: i }))
      .sort((a, b) => (b.pts - a.pts) || (a.i - b.i))
      .map(r => ({ id: r.id, pts: r.pts }));
  }
  // 並列第一的所有人(只有一個人就是單一冠軍)
  function champs(order, pts) {
    const s = standings(order, pts);
    if (!s.length) return [];
    const top = s[0].pts;
    return s.filter(r => r.pts === top).map(r => r.id);
  }

  return {
    PICK_MS, SHOW_MS, SECS, ROUNDS, DIFFS, DEF_SEC, DEF_ROUNDS, DEF_DIFF,
    normRules, sameRules, norm, hit, COOL_MS, coolMs,
    drawerAt, totalOf, plan, nextLive,
    guessPts, drawerPts, settle, roundDone,
    blankSt, tally, awards,
    standings, champs
  };
})();

/* node 測試用(瀏覽器沒有 module,這一行完全無副作用) */
if (typeof module !== "undefined" && module.exports) module.exports = DWR;

"use strict";

/* ============================================================================
   你畫我猜 — 規則層(DWR)。★ 純函式:零 DOM、零 Firebase、零計時器。
   一整場的真相由這一支算出來,adapter 只負責「什麼時候把算出來的結果寫進 DB」。

   ⚠ 這一支是 CLAUDE.md 紅線 16 的成員(純函式清單之一)——
     碰一行 DOM 就只能在瀏覽器裡手動玩,node 測試會整支失效。

   ★★ 三件「不知道就會做錯」的事(完整版在 notes/21 的〇節):
     ① **2 人局的計分公式與 3 人以上完全不同**:沒有「第幾個猜中」,改成依猜中秒數分段。
        寫成「名次分表只有一格」是錯的 —— 那會讓 2 人局的猜題者永遠拿 200。
     ② **總回合數不是固定值**:它是「還活著的人 × 每人幾次」,而**有人中途離開就會變**。
        `plan()` / `nextLive()` 一律用「現在還在房裡的人」重算,不可以拿開局那一刻的數字。
     ③ **答案比對只認正規化後的完全相等**(或同義詞),**絕不用 includes()** ——
        「我猜是貓」會包含「貓」,而那不是猜中,是聊天。
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
     第 1 次錯 → 5 秒、第 2 次 → 10 秒、第 3 次 → 本題失格(回 -1)。
     ⚠ 傳進來的 n 是「**含這一次**的累積錯誤數」。 */
  const COOL = [5000, 10000];
  function coolMs(n) { return n >= 3 ? -1 : (COOL[n - 1] || 0); }
  function out(n) { return (n || 0) >= 3; }              // 這一題已經失格

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

  /* ---------- 畫家的分數 ----------
     依「有幾個人猜中」:0 / 50 / 80 / 100 / 110 / 120(最多 5 個猜題者)。
     ⚠ 表要夠長 —— 超出就吃最後一格,**不可以回 undefined**:那會讓總分變 NaN,
       而 NaN 一旦寫進 DB 就再也算不回來(整場的分數全毀,畫面上只看到空白)。 */
  const DRAW_PTS = [0, 50, 80, 100, 110, 120];
  function drawerPts(nHit) {
    const i = Math.max(0, nHit | 0);
    return i < DRAW_PTS.length ? DRAW_PTS[i] : DRAW_PTS[DRAW_PTS.length - 1];
  }

  /* ---------- 一回合的完整結算 ----------
     hits = { pid: {t:猜中時的毫秒數, o:第幾個猜中(0-based)} }(由 adapter 在交易裡寫)
     guessers = 這一回合「有資格猜」的人數(= 回合開始時在房裡的人 − 畫家)
     → 回傳 { pid: 這一回合得幾分 };沒得分的人不出現(呼叫端一律用 (x||0))。
     ⚠ solo 判定看的是 **guessers === 1**,不是「房裡有 2 個人」——
       中途有人離開時這兩個數字會不一樣,而規則書講的是「只有一個猜題者」那個情境。 */
  function settle(drawerId, hits, guessers) {
    const res = {};
    const solo = guessers === 1;
    const ids = Object.keys(hits || {});
    ids.forEach(id => {
      const h = hits[id] || {};
      res[id] = (res[id] || 0) + guessPts(h.o | 0, h.t | 0, solo);
    });
    if (drawerId) res[drawerId] = (res[drawerId] || 0) + drawerPts(ids.length);
    return res;
  }

  /* ---------- 這一回合結束了沒 ----------
     ★ 兩個條件任一成立:時間到(由 adapter 的計時器管)、或**所有猜題者都猜中了**
       (規則書第 13 節)—— 這一支只回答後者。
     ⚠ 「失格的人」不算在「還沒猜中」裡 —— 三次猜錯的人永遠不會猜中,
       等他等於整房乾等到 60 秒(而畫面上完全看不出在等誰)。
     ⚠ 一個猜題者都沒有(人都跑光了)回 true:那一回合已經沒有意義,直接收掉。 */
  function roundDone(guesserIds, hits, miss) {
    hits = hits || {}; miss = miss || {};
    for (let i = 0; i < guesserIds.length; i++) {
      const id = guesserIds[i];
      if (!hits[id] && !out(miss[id])) return false;
    }
    return true;
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
    normRules, sameRules, norm, hit, coolMs, out,
    drawerAt, totalOf, plan, nextLive,
    guessPts, drawerPts, settle, roundDone,
    standings, champs
  };
})();

/* node 測試用(瀏覽器沒有 module,這一行完全無副作用) */
if (typeof module !== "undefined" && module.exports) module.exports = DWR;

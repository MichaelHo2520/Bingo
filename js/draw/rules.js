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
     ★ 只有 draw 吃房規(60 / 90 / 120 秒);pick 與 show 是固定值。
     ⚠ pick 從 v2.4.1 起是 **30 秒**(15 → 20 → 30)。使用者:「我想把選題時間拉長到 30 秒」。
       每一次加長的理由都一樣:那一格要做的事變多了 —— v1.171.0 加了「自己出題」
       (想一個題目 + 用注音打完 4 個字),v2.4.1 又加了三張卡片翻牌的入場動畫。
     ⚠ 畫家發呆時全房都在等他,所以這個數字**不該再往上加**;到期由 adapter 幫他選第一個。
     ⚠⚠ 改任何一個相位時長之後 e2e 若紅在**最後幾節的版面斷言**(畫布卡在 80×60 的下限、
       放大了卻沒變高),先去把 `tools/run-e2e.ps1` 的 `--virtual-time-budget` 調大 ——
       症狀與 `.dw-ov-card` 那條 CSS 紅線一模一樣,但真因是預算用完之後版面停止更新
       (完整經過在 notes/21 的 v1.171.1 那一節)。 */
  const PICK_MS = 30000;
  const SHOW_MS = 5000;
  /* ★ 作畫秒數的選項,v2.4.1 起是 60 / 90 / 120(原本 45 / 60 / 90)。
     使用者:「作畫時間改成 60,90,120 秒選項」。
     ⚠ 預設值**留在 60**(它照樣是選項之一)→ 舊房間存的 45 會被 normRules 退回 60,
       也就是「只變長、不變短」,沒有人會因為這次改動少畫。
     ⚠ 預設值同時寫在 draw.html 的 `.on`,兩邊要一致。 */
  const SECS = [60, 90, 120];
  const ROUNDS = [1, 2, 3];           // 每人當幾次畫家
  const DIFFS = ["easy", "std", "hard"];
  /* ★★ 共同作畫(v1.170.0):0 = 關(經典玩法)、1 = 開。
     ⚠ 預設**關** —— 舊房間沒有這個欄位、而經典玩法才是這個遊戲的基準線。 */
  const COS = [0, 1];
  /* ★★ 自訂題目(v1.171.1):0 = 只能三選一、1 = 畫家可以自己出題(最多 4 個字)。
     使用者:「能不能自訂題目,要有房主選擇決定」。
     ⚠ 預設**開**,與共同作畫(co)刻意相反,理由是兩者改變的東西不同:
       · co 開了會變成「好幾個人同時畫」—— 那是另一種玩法,所以基準線是關。
       · cu 開了還是「一個畫家、一個題目」,規則一條都沒變,只是題目多一個來源;
         而它正是使用者上一版指名要的功能 —— 預設關的話等於每一場都要先去翻設定才用得到。
     ⚠ 因此**舊房間(沒有這一欄)會退回「開」** —— 這是刻意的,不是漏寫。
       想關掉的房主按一下就好,而那顆鈕就在大廳。 */
  const CUS = [0, 1];
  /* ★★★ 階梯式提示(v2.5.3):0 = 關(經典玩法)、1 = 開。
     使用者要解的痛點是「畫得抽象時全場乾等到時間到」——
     ⚠ 預設**開**(同 cu、與 co 相反)。它確實動到計分(拿了提示才猜中的分數會折),
       但那正是它成立的前提:不折的話「等提示」永遠是最佳策略。預設關的話
       等於每一場都要先去翻設定,而這一條就是為了現場體驗才做的。
     ⚠ 因此**舊房間(沒有這一欄)會退回「開」** —— 刻意的,不是漏寫。 */
  const HIS = [0, 1];
  const DEF_SEC = 60, DEF_ROUNDS = 2, DEF_DIFF = "std", DEF_CO = 0, DEF_CU = 1, DEF_HI = 1;

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
      diff: DIFFS.indexOf(r.diff) >= 0 ? r.diff : DEF_DIFF,
      co: COS.indexOf(r.co) >= 0 ? r.co : DEF_CO,
      cu: CUS.indexOf(r.cu) >= 0 ? r.cu : DEF_CU,
      hi: HIS.indexOf(r.hi) >= 0 ? r.hi : DEF_HI
    };
  }
  function sameRules(a, b) {
    a = normRules(a); b = normRules(b);
    return a.sec === b.sec && a.rounds === b.rounds && a.diff === b.diff
        && a.co === b.co && a.cu === b.cu && a.hi === b.hi;
  }
  /* ★ 畫家可不可以自己出題(v1.171.1)—— **唯一的真相**:
     蓋板上那一格畫不畫得出來、以及送出時擋不擋,兩邊都問這一支
     (比照 mayInk;分兩處各寫一次 if 就是兩個真相,遲早會不一致)。
     ⚠ 吃的是**開局凍結的那一份**(dw.rules),不是大廳當下的 rules。 */
  function mayOwnWord(rules) { return normRules(rules).cu === 1; }
  function mayHint(rules) { return normRules(rules).hi === 1; }

  /* ---------- ★★★ 誰的筆畫得進去(v1.170.0 共同作畫)----------
     使用者:「假如還有人沒猜出來,其他人可以幫忙畫,但幫忙畫的人要是一定猜成功了」。
     ★ 這一支是**唯一的真相**:adapter 的 ink() 與畫布的鎖(setEnabled)都問它,
       所以「畫得進去」與「畫布是活的」不可能不一致。
     ⚠⚠ 幫畫的資格只認 **d.hits[id]**(已經猜中),絕不可以放寬到:
       · `gv`(放棄的人)—— 他不知道答案,讓他畫等於讓他亂畫
       · `miss`(猜錯很多次的人)—— 同上,而且 miss 從 v1.167.0 起不影響任何判定(紅線 27)
     ⚠ 「還有人沒猜出來」不必另外判:每個猜題者都定案時 roundDone 會把相位推去 show,
       而這一支的第一行就要求 `ph === "draw"` —— 兩條判定不要各寫一份(那就是第二個真相)。
     ⚠ 房規吃的是**開局凍結的那一份**(d.rules / dw.rules),不是大廳當下的 rules。 */
  function mayInk(rules, d, id, drawerId) {
    if (!d || !id || d.ph !== "draw") return false;
    if (id === drawerId) return true;                  // 這一回合的畫家
    if (!normRules(rules).co) return false;            // 沒開共同作畫 → 只有畫家畫得到
    return !!(d.hits && d.hits[id]);                   // ★ 只有已經猜中的人才能幫忙畫
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

  /* ---------- ★★★ 「🔥 好接近了」(v2.4.1)----------
     Gemini 建議書:「當玩家輸入的答案與正解僅差一個字時,跳出燃燒提示(但不洩漏具體字)」。
     ★ 它補的是這一頁最悶的一種挫折:猜「熱狗」時打「香腸」與打「熱狗堡」,
       在此之前得到的回饋**一模一樣**(猜錯 + 凍 3 秒),而後者其實已經想對了。

     ⚠⚠⚠ **這一則只給猜的那個人自己看,絕對不可以廣播。**
       猜錯的內容本來就會進 `say`(全房看得到,那是笑點來源)—— 再廣播「他很接近」
       等於昭告全房「答案離『香腸』只差一個字」,把第一名的推理成果送給所有人。
       那與紅線 5(猜中的內容不進 say)是同一型的洩漏 → adapter 只在**本地**跳提示。
     ⚠ 判定純本地算得出來:題目在每一台的記憶體裡本來就有(紅線 6 說 DB 是明碼、
       而且刻意不修)—— 這一支沒有讓任何原本拿不到的人多拿到東西。

     判準兩條(對正解與**每一個同義詞**各算一次,任一條成立就算接近):
       ① 編輯距離 ≤ 1 —— 差一個字 / 多一個字 / 少一個字
       ② 一方是另一方的連續子字串,而且長度差 ≤ 2(「狗」對「熱狗」、「車」對「腳踏車」)
     ⚠⚠ **正解只有 1 個字時一律回 false**:那時候「編輯距離 ≤ 1」= 任何單字都成立,
       提示會每猜必亮 —— 既沒有資訊量,又等於白送「答案是一個字」以外的線索。
       題庫裡 1 個字的題有 29 條(見 notes/21b),不是罕見情況。
     ⚠ 長度上限 24:猜題框 maxlength 是 16,但同義詞與 `dw.cw` 是別人寫進 DB 的,
       不設上限的話一個超長字串會讓這一支算到卡住。 */
  const NEAR_MAX = 24;
  /* 「編輯距離是不是 ≤ 1」。★ 只要答案是 yes/no 就不必跑整張 DP 表:
     長度差 > 1 直接否定,其餘對齊前綴、跳過一個字之後逐字比對尾巴。
     ⚠ 吃的是**字元陣列**不是字串:補充平面的字在字串上是兩個 UTF-16 單元,
       按字串算會把一個 emoji 當成「差兩個字」(同 DWGen.lenAt 用 Array.from 的理由)。 */
  function tailSame(a, ai, b, bi) {
    if (a.length - ai !== b.length - bi) return false;
    while (ai < a.length) { if (a[ai++] !== b[bi++]) return false; }
    return true;
  }
  function within1(a, b) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;
    // 換掉一個字:兩邊各跳過那一個之後,尾巴要一樣
    if (la === lb) return tailSame(a, i + 1, b, i + 1);
    // 多 / 少一個字:長的那一邊跳過一個字之後,要與短的那一邊剩下的相同
    const lng = la > lb ? a : b, sht = la > lb ? b : a;
    return tailSame(lng, i + 1, sht, i);
  }
  function nearOne(g, c) {
    if (!g || !c || g === c) return false;
    if (g.length > NEAR_MAX || c.length > NEAR_MAX) return false;
    const gc = Array.from(g), cc = Array.from(c);
    if (cc.length < 2) return false;                 // ⚠ 見上面那條:1 個字的正解一律不提示
    if (within1(gc, cc)) return true;                // ① 差一個字
    // ② 一方是另一方的連續子字串,而且長度差 ≤ 2
    return (c.indexOf(g) >= 0 || g.indexOf(c) >= 0) && Math.abs(gc.length - cc.length) <= 2;
  }
  /* 對外的那一支。word = 題庫的一筆 {w, a}。
     ★ 猜中(hit)時一律回 false —— 那時候該跳的是「猜中了 🎉」,兩則同時跳會互相蓋掉。 */
  function near(guess, word) {
    const g = norm(guess);
    if (!g || !word) return false;
    if (hit(guess, word)) return false;
    if (nearOne(g, norm(word.w))) return true;
    const alt = word.a || [];
    for (let i = 0; i < alt.length; i++) if (nearOne(g, norm(alt[i]))) return true;
    return false;
  }

  /* ---------- ★★★ 自訂題目(v1.171.0)----------
     使用者:「再多一個制定題目的功能,字數最長只能有四個字」。
     畫家在選題那一頁除了三選一,還可以自己打一個題目;打的字經過這一支洗過才算數。

     ⚠⚠ **這一支是唯一的正規化入口,而且要洗兩次**:畫家送出時洗一次(擋掉亂打),
       每一台從 DB 讀出來時再洗一次(`wordOf()` 裡)。只洗送出端的話,手改 DB 或
       舊版寫進來的髒字串會直接變成答案,而症狀是「全場都猜不中,且沒有人知道為什麼」。
     ⚠⚠ 為什麼要自己一個字元一個字元挑,而不是「`norm` 之後 slice(0,4)」:
       ① 提示講的是**幾個字**,所以答案裡一個空白 / 標點都不能留(CLAUDE.md 那條:
          `norm` 會把它們吃掉 → 顯示 4 個字而實際只要打 3 個,比不給提示更糟)。
       ② 表情符號要擋掉:留著的話那一題**沒有人打得出來**(猜題框沒有 emoji 鍵盤),
          整回合白白過去。順帶一提,擋掉補充平面(U+10000 以上)之後
          `cleanCustom(s).length === Array.from(cleanCustom(s)).length` 永遠成立
          —— 字數提示那條紅線在這裡是結構性成立的,不必再靠斷言守。
       ③ `norm` 會把英文轉小寫,而那是**比對用的**形式,不是**顯示用的**形式:
          畫家打 "PM2.5" 卻在工具列上看到 "pm25" 會以為自己打錯了。
     ⚠ 白名單刻意只收「猜題框打得出來的字」:中日韓漢字 · 注音 · 假名 · 英數。
       全形英數先折成半形再判(全形與半形的 A 在畫面上分不出來)。
     ⚠ 同上面 norm 那條:字元類別**一律寫成 \u 碼點**,不要真的把那些字打進來。
         3040-30FF 平假名 / 片假名 · 3105-312F 注音 · 3400-4DBF 漢字擴充 A
         4E00-9FFF 漢字基本區 · F900-FAFF 相容漢字 */
  const CUSTOM_MAX = 4;
  const OKCH = /[0-9A-Za-z\u3040-\u30FF\u3105-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  function cleanCustom(s) {
    const src = String(s == null ? "" : s).replace(WIDE, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    let out = "";
    for (const ch of src) {
      if (out.length >= CUSTOM_MAX) break;
      if (OKCH.test(ch)) out += ch;
    }
    return out;
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

  /* ==========================================================================
     ★★★ 階梯式提示(v2.5.3)—— 純函式,而且「每一台各自算」
     ──────────────────────────────────────────────────────────────────────────
       需求來源:notes/Gemini建議/你畫我猜末段提示機制優化建議.md。要解的痛點是
       「畫家畫得抽象 / 猜的人陷入盲區 → 全場乾等到時間到」(v1.167.0 拿掉失格之後,
       沒人猜中的那一題就是硬等 60~120 秒,見紅線 27)。

       ★★ **一個位元組都不寫進 DB。** 三個輸入全部是每一台本來就有的東西:
         · 這一段開始的時間 `d.at` + 這一段有多長(房規的 sec)→ 現在是第幾階段
         · `d.mid` + `d.n` → 揭露哪幾個字的**亂數種子**(決定性 → 每一台完全一致)
         · 題目本身(DB 上是明碼,紅線 6)
       所以它沒有第二個真相、不會有人先看到提示、也不必動資料庫規則。
       ⚠⚠ 這一條**不可以**改成「由 host 算完寫進 d.hint」:那等於把一件算得出來的事
         變成一次寫入 + 一次同步延遲,而且慢半拍收到的人分數會算錯(見下面的 settle)。

       ★ 三個門檻用「**剩餘時間的比例**」而不是秒數 —— 房規有 60 / 90 / 120 三種,
         寫成秒數的話 120 秒那一檔的第一階段會在剩 50% 之前就冒出來(或反過來)。
         60 秒 → 30 / 15 / 7.5 秒;120 秒 → 60 / 30 / 15 秒。
       ⚠ 建議書寫的是 45/60/90(那是 v2.4.1 之前的房規),比例換算之後一致。

       階梯(st):
         0  自由作畫期 —— 只有「幾個字」(v1.161.0 就有的公開提示,紅線 25)
         1  剩 50% —— 題目**分類**徽章(見 DWGen.CATS)
         2  剩 25% —— 隨機揭露 1 個字
         3  剩 12.5% —— 4 個字以上再揭露 1 個(上限見 revealCap)

       ⚠⚠⚠ **揭露上限是總字數的一半(向下取整)** —— 所以:
         · 1 個字的題(題庫有 29 條)**永遠不揭露**:揭露就是直接報答案。
         · 2~3 個字最多 1 個、4 個字以上最多 2 個。
         建議書寫的「不超過 50%」就是這一條,而 1 個字那個邊界它沒有講到 ——
         floor(1/2)=0 剛好把它擋掉,**不要改成 Math.ceil**。

       ★★ 分數係數 f:**跟「真的拿到了什麼提示」掛鉤,不是跟時間掛鉤**。
         · 已經揭露到字 → 0.5
         · 只有分類 → 0.75
         · 什麼都沒有 → 1.0
         ⚠ 為什麼不直接看 st:**畫家自己出的題沒有分類**(dw.cw,見 DWGen.catAt),
           而 1 個字的題永遠不揭露 —— 照 st 折的話那兩種情況會「沒拿到提示卻被扣分」,
           而玩家完全看不出來為什麼。所以 hasCat 與 revealCap 都要餵進來。
       ⚠ 房規關掉(on=false)時一律回 `{st:0, rv:0, f:1}` —— 那時候連折扣都不存在。 */
  const HINT_LEFT = [0.5, 0.25, 0.125];      // 剩餘比例的三個門檻(對應 st = 1 / 2 / 3)
  const HINT_F1 = 0.75;                      // 只拿到分類
  const HINT_F2 = 0.5;                       // 已經開了字
  /* 這一題最多揭露幾個字。⚠ floor 不是 ceil(見上面那段:1 個字的題永遠 0)。 */
  function revealCap(len) { return Math.floor(Math.max(0, len | 0) / 2); }
  /* ms = 這一段已經過了幾毫秒 · total = 這一段有多長 · len = 正解幾個字
     on = 房規開著沒 · hasCat = 這一題有分類沒(自訂題目沒有)
     → { st, rv, f }。⚠ 一律防呆:total <= 0(舊快照 / 還沒開始)時回第 0 階段。 */
  function hintAt(ms, total, len, on, hasCat) {
    const zero = { st: 0, rv: 0, f: 1 };
    if (!on) return zero;
    const t = +total || 0;
    if (t <= 0) return zero;
    const left = (t - Math.max(0, +ms || 0)) / t;      // 剩餘比例(可能 < 0,那就是最後一階)
    let st = 0;
    for (let i = 0; i < HINT_LEFT.length; i++) if (left <= HINT_LEFT[i]) st = i + 1;
    const cap = revealCap(len);
    const rv = st >= 3 ? Math.min(2, cap) : st >= 2 ? Math.min(1, cap) : 0;
    const f = rv >= 1 ? HINT_F2 : (st >= 1 && hasCat ? HINT_F1 : 1);
    return { st: st, rv: rv, f: f };
  }

  /* ---------- 揭露哪幾個字:決定性亂數 ----------
     ★★★ **每一台看到的位置必須一模一樣**(建議書三之1的「重要原則」)——
       兩台不一樣的話畫面上完全正常,但兩個人講的提示對不上,而且沒有人查得出來。
       → 做法是「種子 + 題目」的雜湊,種子由呼叫端給 `mid + ":" + n`
         (這一場的識別碼 + 第幾回合;每回合都不一樣、而每一台都算得出同一個值)。
     ⚠ 題目本身也進雜湊:不進的話同一回合換題(自訂題目改主意)會開在同一個位置,
       而那沒有壞處但也沒有理由。
     ⚠ 用 FNV-1a + LCG 的 Fisher-Yates,**不可以用 Math.random()** ——
       那會讓每一台開在不同的位置(這一整條紅線就白做了)。同 UNO 的決定性 PRNG。 */
  function hash32(s) {
    let h = 2166136261 >>> 0;
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i++) { h = (h ^ str.charCodeAt(i)) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  /* 揭露的順序(索引陣列;前 k 個就是要揭露的那幾格)。 */
  function revealOrder(word, seed) {
    const cs = Array.from(String(word == null ? "" : word));
    const idx = cs.map((c, i) => i);
    let h = hash32(String(seed) + "|" + cs.join(""));
    for (let i = idx.length - 1; i > 0; i--) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      const j = h % (i + 1);
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    return idx;
  }
  /* ★★★ 給畫面用的遮罩:陣列,**揭露的那幾格是字元、其餘一律是 null**。
     ⚠⚠ 回的是 null 而不是 "_" 或那個字 —— 這一支的呼叫端會把它寫進 DOM,
       而「沒揭露的字一個都不進 DOM」是紅線 6 / 25 的結構性保證
       (偷看 DOM 比偷看 DB 容易太多)。畫底線是**畫面層的事**,不是這裡的事。
     ⚠ k 一律再夾一次 revealCap:呼叫端算錯也不會多開一格。 */
  function revealMask(word, seed, k) {
    const cs = Array.from(String(word == null ? "" : word));
    const n = Math.min(Math.max(0, k | 0), revealCap(cs.length));
    const ord = revealOrder(cs.join(""), seed);
    const on = {};
    for (let i = 0; i < n; i++) on[ord[i]] = 1;
    return cs.map((c, i) => (on[i] ? c : null));
  }

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

  /* ---------- ★★★ 拿了提示才猜中 → 分數要折(v2.5.3)----------
     ★ 不折的話「**等提示**」就是最佳策略:反正到剩 25% 會開一個字,早猜只是多冒錯的風險。
       折了之後階梯才有意義 —— 早猜的人拿滿分,靠提示的人拿一半。
     ★★ 折扣的判定吃的是 **`hits[id].t`(那個人猜中時已經過了幾毫秒)**,
       也就是與畫面上的階梯**同一個真相**(見 hintAt)——
       所以不必在猜中那一刻多寫一個欄位進 DB,結算時算得出來。
     ⚠ hc(hint context)= `{ ms: 這一段有多長, len: 正解幾個字, cat: 有沒有分類 }`;
       **傳 null / 不傳 = 房規關掉**(或舊版呼叫端)→ 一律不折,行為與 v2.5.2 逐分相同。
     ⚠ 取整到 10:分數表全部是 10 的倍數,折完出現 112.5 會讓結果卡看起來像壞掉。
     ⚠⚠ **`drawerPts` 吃的是折完的總和** —— 這是刻意的,而且紅線 18 那條
       「畫好嚴格優於畫爛」照樣成立:畫得好 → 大家早猜中 → 折得少 → 總和大 →
       畫家分跟著大。它只是把「畫爛拖到提示才有人猜中」那條路的收益一起壓下去。 */
  function hintCut(p, ms, hc) {
    if (!hc) return p;
    const h = hintAt(ms, hc.ms, hc.len, true, !!hc.cat);
    if (h.f >= 1) return p;
    return Math.round(p * h.f / 10) * 10;
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
  function settle(drawerId, hits, guessers, hc) {
    const res = {};
    const solo = guessers === 1;
    const ids = Object.keys(hits || {});
    let sum = 0;
    ids.forEach(id => {
      const h = hits[id] || {};
      const p = hintCut(guessPts(h.o | 0, h.t | 0, solo), h.t | 0, hc);
      res[id] = (res[id] || 0) + p;
      sum += p;
    });
    if (drawerId) res[drawerId] = (res[drawerId] || 0) + drawerPts(sum, guessers);
    return res;
  }

  /* ---------- 這一回合結束了沒 ----------
     ★ 兩個條件任一成立:時間到(由 adapter 的計時器管)、或**每個猜題者都定案了**
       (規則書第 13 節)—— 這一支只回答後者。
     ★★ 「定案」有兩種(v1.168.0):**猜中了** 或 **自己按了放棄**。
       使用者:「如果真的猜不到,我想多一個放棄的功能,才不用一直硬要等時間到」。
     ⚠⚠ 第三個參數是 `gv`(放棄名單),**不是 v1.167.0 拿掉的那個 `miss`** ——
       兩者長得很像但語意相反:`miss` 是「系統數你錯幾次就把你踢出這一題」(已廢),
       `gv` 是「**當事人自己按的**」。所以猜錯幾次都還在等他,他不想猜了才算定案。
       → 別把 miss 判定「順手」加回來(紅線 27),也別把 gv 當成 miss 的復活。
     ⚠ 一個猜題者都沒有(人都跑光了)回 true:那一回合已經沒有意義,直接收掉。 */
  function roundDone(guesserIds, hits, gv) {
    hits = hits || {}; gv = gv || {};
    for (let i = 0; i < guesserIds.length; i++) {
      const id = guesserIds[i];
      if (!hits[id] && !gv[id]) return false;
    }
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
    PICK_MS, SHOW_MS, SECS, ROUNDS, DIFFS, COS, CUS, HIS,
    DEF_SEC, DEF_ROUNDS, DEF_DIFF, DEF_CO, DEF_CU, DEF_HI,
    normRules, sameRules, mayInk, mayOwnWord, mayHint, norm, hit, near, cleanCustom, CUSTOM_MAX, COOL_MS, coolMs,
    HINT_LEFT, HINT_F1, HINT_F2, revealCap, hintAt, revealOrder, revealMask,
    drawerAt, totalOf, plan, nextLive,
    guessPts, drawerPts, hintCut, settle, roundDone,
    blankSt, tally, awards,
    standings, champs
  };
})();

/* node 測試用(瀏覽器沒有 module,這一行完全無副作用) */
if (typeof module !== "undefined" && module.exports) module.exports = DWR;

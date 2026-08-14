"use strict";

/* ============================================================================
   你畫我猜 — 連線適配器(接上 js/shared/mp-core.js)。**只有連線,沒有單機**
   (十二個遊戲裡唯一的一個 —— 沒有 AI 畫家,也沒有 AI 猜圖者)。

   ★★★ 架構:**一個 MP round = 一整場**(比照 21 點的相位機,不是成語接龍的 contRound)。
       核心只看得到「開打 → 結束」兩個點;中間 4~18 個回合的推進全部在這一支裡,
       狀態收在 game.dw 這一包。理由:規則書第 11 節把「每人當 N 次畫家」定為公平性核心,
       那等於宣告「一整場」才是不可分割的單位;而第 13 節「大家都猜中就立刻下一回合」
       也明說回合之間不該有等待(contRound 那條路要每個人各按一次「我看完了」)。

   ★★★ 四條紅線(完整版在 notes/21 的〇節):

   ① **筆劃絕對不可以走 txGame。** 它是連續資料,整包重寫會把流量與延遲一起炸掉,
      還會跟核心的 rev 單調遞增互相拖累。筆劃走**獨立節點** ink/{回合}/{pushId},
      用 push + child_added 增量同步(節流參數在 board.js)。
      ⚠ 那些子節點的監聽**核心收不掉**(leave() 只 off() 得到 roomRef.child("ink") 本身),
        所以 detachRound() 一定要自己叫 —— 漏掉就是「離開房間之後還在收上一間的筆劃」。

   ② **猜中的內容絕對不可以進 say 節點。** say 是廣播給全房看的猜錯訊息(那是笑點來源),
      而把猜中的內容播出去 = 第一個猜中的人幫所有人報了答案。
      → guess() 裡分兩條路:錯的才 push 到 say,對的只寫 game.dw.hits。

   ③ **題目在 DB 上是明碼,這是刻意的**(規則書第 16 節 + CLAUDE.md 的「受眾是親友聚會」)。
      不要「修」它。要擋的只有**不小心洩漏**:畫面上非畫家一律連題目文字都不產生
      (見 board.js 的 paintPick)。

   ④ **有人中途離開 → 把他剩下的畫家回合跳掉,總回合數跟著縮短**(不是整場作廢)。
      判定一律走 DWR.nextLive(),它吃的是「**現在**還在房裡的人」。
      ⚠ 回合索引 n 一路遞增、不重新編號 —— 重新編號的話重連的人會對不上 ink/{n}。
   ========================================================================== */

const MP = MPCore.create((function () {

  let ctx = null;
  let rules = DWR.normRules(null);      // 大廳裡的房規(房主可改)
  let dw = null, gOrder = [];           // 這一場的狀態(game.dw)與座位表
  let curN = -1, curPh = "";            // 本地已經套用到哪一回合 / 哪一相位
  let inkRef = null, sayRef = null, inkRound = -1;
  let phaseT = null;
  let seenHits = {};                    // 這一回合已經播報過的猜中者(避免重複跳訊息)
  let coolEnd = 0;                      // 我的冷卻到什麼時候(本地)
  /* ★ 放大模式(v1.155.0):吃掉猜題列與頂列,全部讓給畫布。存在偏好裡(ownPrefs),
     下次進來記得住 —— 一場要開關好幾次的東西,每次都要重按太煩。 */
  let zoom = false;

  /* ---------- 小工具 ---------- */
  function seatOf(id) { return gOrder.indexOf(id); }
  function mySeat() { return seatOf(ctx.me()); }
  function drawerId() { return dw ? DWR.drawerAt(gOrder, dw.n) : null; }
  function iAmDrawer() { return !!dw && drawerId() === ctx.me(); }
  function aliveMap() { return ctx.players() || {}; }
  function aliveOrder() { const a = aliveMap(); return gOrder.filter(id => a[id]); }
  // 這一回合有資格猜的人(不含畫家);用現在還在房裡的人算
  function guesserIds() { const d = drawerId(); return aliveOrder().filter(id => id !== d); }
  function ptsOf(id) { return (dw && dw.pts && dw.pts[id]) || 0; }
  function wordOf() { return dw && dw.w >= 0 ? DWGen.wordAt(dw.w) : null; }

  /* ★★★ 筆劃 / 猜題訊息的節點路徑一定要帶 **mid(這一場的識別碼)**。
     回合索引每一場都從 0 重新算 —— 只用 ink/{n} 的話,同一間房打第二場時
     `attachRound(0)` 的 child_added 會把**上一場**第 0 回合畫的東西整批重放出來
     (症狀:新的一場一開始畫布上就有一張別人上一場畫的圖,而且沒有人畫得掉)。
     ⚠ newGame() 順手把整個 ink / say 砍掉是「收垃圾」,不是這條的解方 ——
       remove() 是非同步的,慢一步的話舊資料照樣會被重放。mid 才是真正擋住的那一道。 */
  function inkPath(d) { return "ink/" + (d.mid || 0) + "/" + d.n; }
  function sayPath(d) { return "say/" + (d.mid || 0) + "/" + d.n; }

  /* 這一相位有多長(毫秒)。★ 只有 draw 吃房規;pick / show 是固定值。 */
  function phaseMs(d) {
    if (!d) return 0;
    if (d.ph === "pick") return DWR.PICK_MS;
    if (d.ph === "draw") return (DWR.normRules(d.rules).sec) * 1000;
    if (d.ph === "show") return DWR.SHOW_MS;
    return 0;
  }

  /* ==========================================================================
     一、相位推進 —— 三個寫入點
     ──────────────────────────────────────────────────────────────────────────
       ★ 一律用交易 + `d.seq` 守衛:**不指定房主**,每一台都排 timer、誰先響誰用交易搶
         (房主剛好斷線也不會全場卡死;比照 21 點與台灣麻將)。按座位錯開 150ms
         只是少幾次註定白跑的交易。
       ⚠ `d.seq` 每推進一次 +1 —— 它是「這是不是同一段」的唯一記號。
         用 d.ph 判斷是不夠的:pick → draw → …→ pick,相位名字會重複出現。
     ========================================================================== */

  /* ① 選題目 → 開始畫。k 是三選一的第幾顆(到期代打傳 0)。 */
  function toDraw(k, seq) {
    ctx.txGame(g => {
      const d = g.dw;
      if (!d || d.ph !== "pick" || d.seq !== seq) return false;
      const cand = Array.isArray(d.cand) ? d.cand : [];
      const w = cand[k] !== undefined ? cand[k] : cand[0];
      if (w === undefined) return false;
      d.w = w;
      d.used = (Array.isArray(d.used) ? d.used : []).concat(w);
      d.ph = "draw"; d.at = Date.now(); d.seq = seq + 1;
    });
  }

  /* ② 作畫結束 → 公布答案(順手把這一回合的分數加進 d.pts)。
     ★ 兩種觸發:時間到、或所有猜題者都猜中了(規則書第 13 節)。
     ⚠ 計分用的「猜題者人數」讀的是 **d.gs**(回合開始時記下來的),不是當下人數 ——
       中途有人離開時兩者不一樣,而畫家分那張表講的是「這一回合有幾個人可以猜」。 */
  function toShow(seq) {
    ctx.txGame(g => {
      const d = g.dw;
      if (!d || d.ph !== "draw" || d.seq !== seq) return false;
      const drawer = DWR.drawerAt(g.order || [], d.n);
      const add = DWR.settle(drawer, d.hits || {}, d.gs | 0);
      const pts = Object.assign({}, d.pts || {});
      Object.keys(add).forEach(id => { pts[id] = (pts[id] || 0) + add[id]; });
      d.pts = pts;
      d.last = add;                       // 這一回合各加了幾分(公布答案那張卡要用)
      /* ★★ 娛樂統計(v1.163.0)。**這裡是唯一的累加點** —— 下一回合開始時
         d.hits / d.miss 會被清成 null(見 toNext),整場打完之後那些數字早就不在了。
         ⚠ DWR.tally 一律回新物件,所以交易被重跑(別人的寫入先到)也不會重複加:
           每次重跑讀到的都是 DB 上還沒動過的 d.st。 */
      d.st = DWR.tally(d.st, drawer, d.hits, d.miss, add);
      d.ph = "show"; d.at = Date.now(); d.seq = seq + 1;
    });
  }

  /* ③ 公布完 → 下一回合;沒有下一回合就是這一場結束。
     ⚠⚠ 這一筆**一定要帶 { local:false }**(CLAUDE.md 紅線 15):它有可能寫 game.winner,
       而樂觀套用的贏家會先觸發計分 / 彩帶 / 音效,那些副作用在另一個節點、交易回退救不回來。
       代價是回合推進慢一趟往返 —— 那一刻正在看「公布答案」,一個 RTT 看不出來。 */
  function toNext(seq) {
    ctx.txGame(g => {
      const d = g.dw;
      if (!d || d.ph !== "show" || d.seq !== seq) return false;
      const order = g.order || [];
      const alive = aliveMap();
      const R = DWR.normRules(d.rules);
      const nx = DWR.nextLive(order, alive, d.n + 1, R.rounds);
      if (nx < 0) {
        d.ph = "over"; d.at = Date.now(); d.seq = seq + 1;
        /* 最終名次只算**還在房裡的人**(中途離開的人不列入冠軍爭奪,同其他十一個遊戲的慣例)。
           ⚠ winner.pts 要把每一個還在的人都列進去 —— 核心的 ptsFor() 對沒列到的人
             會退回「贏家 +1」那條舊路徑,那樣累積分數會整個變成 1 分 1 分地加。 */
        const live = order.filter(id => alive[id]);
        const pts = {};
        live.forEach(id => { pts[id] = (d.pts && d.pts[id]) || 0; });
        const cs = DWR.champs(live, d.pts || {});
        g.winner = (cs.length === 1)
          ? { id: cs[0], name: ctx.dispName(cs[0]), by: "score", pts: pts }
          : { ids: cs, by: "draw", pts: pts };
        return;
      }
      d.n = nx; d.ph = "pick"; d.at = Date.now(); d.seq = seq + 1;
      d.cand = DWGen.pick3(R.diff, d.used || []);
      d.w = -1; d.hits = null; d.miss = null; d.last = null;
      // 這一回合有幾個人可以猜(見 toShow 的說明)
      const nextDrawer = DWR.drawerAt(order, nx);
      d.gs = order.filter(id => alive[id] && id !== nextDrawer).length;
    }, { local: false });
  }

  /* ---------- 到期代打 ----------
     ⚠ 下限 1200ms 兜底:錨點是**寫入者的**時鐘,慢半拍收到快照的那台會算出「已經過期」
       而一收到就結算(台灣麻將與 21 點都踩過)。 */
  function clearPhaseT() { if (phaseT) { clearTimeout(phaseT); phaseT = null; } }
  function armPhaseT() {
    clearPhaseT();
    if (!dw || ctx.phase() !== "playing" || ctx.winner()) return;
    const total = phaseMs(dw);
    if (!total) return;
    const seat = Math.max(0, mySeat());
    const wait = Math.max(1200, (dw.at || 0) + total - Date.now()) + seat * 150;
    const seq = dw.seq, ph = dw.ph;
    phaseT = setTimeout(() => {
      phaseT = null;
      if (!dw || dw.seq !== seq || dw.ph !== ph || ctx.phase() !== "playing" || ctx.winner()) return;
      if (ph === "pick") toDraw(0, seq);
      else if (ph === "draw") toShow(seq);
      else if (ph === "show") toNext(seq);
    }, wait);
  }

  /* ==========================================================================
     二、玩家的三個動作:選題 / 畫 / 猜
     ========================================================================== */

  // 畫家按了三選一
  function pick(k) {
    if (!dw || dw.ph !== "pick") return;
    if (!iAmDrawer()) { showToast("這一回合不是你畫 🙂"); return; }
    toDraw(k | 0, dw.seq);
  }

  /* 畫家送出一段筆劃 / 清空。
     ⚠ 一律先擋在本地:不是畫家、不在 draw 相位就什麼都不寫
       —— 畫布本身也會被 setEnabled(false) 鎖住,這裡是第二道。 */
  function ink(rec) {
    if (!dw || dw.ph !== "draw" || !iAmDrawer()) return;
    const ref = ctx.ref(inkPath(dw));
    if (ref) ref.push().set(rec);
  }
  function inkClear() { ink("x"); }

  /* ★★★ 猜一次。這一支是這個遊戲最容易做錯的地方(見檔頭 ②)。 */
  function guess(text) {
    if (!dw || dw.ph !== "draw") return;
    const me = ctx.me();
    if (iAmDrawer()) { showToast("你是畫家,不能猜 🎨"); return; }
    if (dw.hits && dw.hits[me]) { showToast("你已經猜中了,看別人猜吧 👀"); return; }
    if (coolEnd > Date.now()) { showToast("冷卻中,先看看畫面 🥶", 1200); return; }

    const w = wordOf();
    const right = !!w && DWR.hit(text, w);

    if (right) {
      /* 猜中 → **只寫 game.dw.hits,絕不 push 到 say**(檔頭 ②)。
         名次 o 在交易裡算(誰先寫進去誰的號碼小),時間 t 用「這一相位開始到現在」。 */
      const seq = dw.seq;
      ctx.txGame(g => {
        const d = g.dw;
        if (!d || d.ph !== "draw" || d.seq !== seq) return false;
        const hits = Object.assign({}, d.hits || {});
        if (hits[me]) return false;                       // 別人的快照比我早到,已經記過了
        hits[me] = { t: Math.max(0, Date.now() - (d.at || Date.now())), o: Object.keys(hits).length };
        d.hits = hits;
      });
      try { Sound.win(); } catch (e) {}
      showToast("猜中了 🎉", 1400);
      return;
    }

    /* 猜錯 → 凍結 3 秒 + 把內容 push 到 say(全房看得到,這是笑點)。
       ★★ v1.167.0:冷卻**不累積、不限次數、不會失格** —— 冷完就可以再猜(見 DWR.coolMs)。
       ⚠ `d.miss` 照樣要 +1:它是娛樂統計「亂槍打鳥」的來源,只是不再影響能不能猜。 */
    coolEnd = Date.now() + DWR.coolMs();
    const seq = dw.seq;
    ctx.txGame(g => {
      const d = g.dw;
      if (!d || d.ph !== "draw" || d.seq !== seq) return false;
      const miss = Object.assign({}, d.miss || {});
      miss[me] = (miss[me] || 0) + 1;
      d.miss = miss;
    });
    const ref = ctx.ref(sayPath(dw));
    if (ref) ref.push().set({ f: me, t: String(text).slice(0, 16) });
    try { Sound.lose(); } catch (e) {}
    paintGuessRow();
  }

  /* ==========================================================================
     三、獨立節點的監聽(筆劃 / 猜題訊息)
     ──────────────────────────────────────────────────────────────────────────
       ★ 兩個都是 **per 回合**的子節點:ink/{n} 與 say/{n}。
         掛上去時 child_added 會把已經有的整批重放一次 —— 那正是「重連歸位」
         與「中途看到前面畫了什麼」靠的機制,不必另外寫一套。
       ⚠ 這些子節點的監聽核心收不掉(見檔頭 ①),detachRound() 一定要自己叫。
     ========================================================================== */
  function attachRound(d) {
    const key = (d.mid || 0) + "#" + d.n;
    if (inkRound === key) return;
    detachRound();
    DWB.resetInk(); DWB.clearSay();
    seenHits = {};
    inkRound = key;
    inkRef = ctx.ref(inkPath(d));
    if (inkRef) inkRef.on("child_added", s => DWB.applyRec(s.val()));
    sayRef = ctx.ref(sayPath(d));
    if (sayRef) sayRef.on("child_added", s => onSay(s.val()));
  }
  function detachRound() {
    if (inkRef) { try { inkRef.off(); } catch (e) {} inkRef = null; }
    if (sayRef) { try { sayRef.off(); } catch (e) {} sayRef = null; }
    inkRound = "";
  }
  function onSay(v) {
    if (!v || !v.f) return;
    const seat = seatOf(v.f);
    DWB.addSay(ctx.dispName(v.f), String(v.t || ""), seat < 0 ? 0 : seat, v.f === ctx.me());
  }
  /* 房主順手收垃圾:上一回合的筆劃留著只會一直長(核心的 leave() 只清 host/players/game,
     adapter 自己的節點要自己清 —— 見 CLAUDE.md 紅線 5 那段的延伸)。 */
  function sweep(mid, oldN) {
    if (!ctx.isHost() || oldN < 0 || !mid) return;
    const a = ctx.ref("ink/" + mid + "/" + oldN); if (a) a.remove();
    const b = ctx.ref("say/" + mid + "/" + oldN); if (b) b.remove();
  }

  /* ==========================================================================
     四、畫面
     ========================================================================== */
  /* 比分畫在**房間框的玩家晶片列**(核心的 renderPlayers)—— v1.155.0 起沒有獨立的比分列。
     那一排本來就會畫「誰輪到了(turnId → .turn)」「誰幾分(chipTail)」「點一下送表情」,
     與另外十一個遊戲同一個概念,而且省下 45~50px 直接變成更大的畫布(見 draw.html 那段註解)。 */
  function paintHud() { ctx.renderPlayers(); }
  function paintBar() {
    if (!dw) { DWB.setRoundInfo("", ""); DWB.setCd(0, 0); return; }
    const R = DWR.normRules(dw.rules);
    const total = DWR.totalOf(gOrder, R.rounds);
    const dname = ctx.dispName(drawerId() || "");
    DWB.setRoundInfo(
      "第 " + (dw.n + 1) + " / " + total + " 回合",
      iAmDrawer() ? "🎨 你是畫家" : ("🎨 " + dname),
      iAmDrawer() ? "mine" : ""
    );
    /* ★★ 猜題者的字數提示(v1.161.0)。使用者:「我覺得要猜的人應該要知道有幾個字,
       這樣才不會太廣泛」—— 沒有它的話「四隻腳的動物」可以是貓 / 狗 / 牛 / 長頸鹿。
       ⚠ 三個條件都要:**在畫的相位**(pick 還沒選、show 已經公布)、**我不是畫家**
         (畫家看的是工具列那一格題目)、**題目真的選好了**(dw.w >= 0)。
       ⚠ 傳出去的只有**數字**,題目文字一個字都不進 DOM(見 DWB.setLen 那段)。 */
    const lenOn = dw.ph === "draw" && !iAmDrawer() && dw.w >= 0;
    DWB.setLen(lenOn ? DWGen.lenAt(dw.w) : 0);
    const ms = phaseMs(dw);
    if (ms && dw.ph !== "over") DWB.setCd((dw.at || 0) + ms, ms, dw.ph + "#" + dw.seq);
    else DWB.setCd(0, 0);
  }
  function paintGuessRow() {
    if (!dw || ctx.phase() !== "playing") { DWB.setGuess({ show: false }); return; }
    const me = ctx.me();
    if (iAmDrawer()) { DWB.setGuess({ show: false }); return; }
    if (dw.ph !== "draw") { DWB.setGuess({ show: true, can: false, why: dw.ph === "pick" ? "畫家正在選題目…" : "這一回合結束了" }); return; }
    if (dw.hits && dw.hits[me]) { DWB.setGuess({ show: true, can: false, why: "✅ 你已經猜中了" }); return; }
    // ★ len:正解幾個字(v1.161.0)—— placeholder 上也講一次,打字時眼睛就在這一格
    DWB.setGuess({ show: true, can: true, coolEnd: coolEnd, len: DWGen.lenAt(dw.w) });
  }
  // 畫家的工具列(題目 + 清空);猜題者一律整列收起來
  function paintTools() {
    const row = $("dwTools"), wEl = $("dwWord");
    if (!row) return;
    const on = !!dw && dw.ph === "draw" && iAmDrawer();
    row.classList.toggle("hidden", !on);
    if (on && wEl) { const w = wordOf(); wEl.textContent = w ? w.w : ""; }
  }
  function paintOver() {
    if (!dw) { DWB.hideOver(); return; }
    if (dw.ph === "pick") {
      DWB.paintPick(dw.cand || [], iAmDrawer(), ctx.dispName(drawerId() || ""));
      return;
    }
    if (dw.ph === "show") {
      const d = drawerId(), me = ctx.me(), last = dw.last || {};
      const rows = aliveOrder().map(id => ({
        seat: Math.max(0, seatOf(id)), name: ctx.dispName(id),
        pts: last[id] || 0, me: id === me, drawer: id === d
      }));
      const w = wordOf();
      /* ★★ 分享圖要用的兩件事(v1.164.0):誰畫的 + 答案幾個字。
         ⚠⚠ **題目文字刻意不傳** —— 使用者:「我覺得題目不要分享出來」,
           那讓分享圖變成一道給 LINE 群組玩的謎題(完整說明在 board.js 第八節)。
         ⚠ 字數走 DWGen.lenAt(正解),與頂列那顆晶片同一個真相。 */
      DWB.setShotInfo({ drawer: ctx.dispName(d || ""), len: dw.w >= 0 ? DWGen.lenAt(dw.w) : 0 });
      DWB.paintShow(w ? w.w : "?", rows);
      return;
    }
    DWB.hideOver();
  }
  // 新猜中的人 → 播報一次(只講「誰猜中」,不講內容;見檔頭 ②)
  function announceHits() {
    if (!dw || !dw.hits) return;
    Object.keys(dw.hits).forEach(id => {
      if (seenHits[id]) return;
      seenHits[id] = 1;
      const h = dw.hits[id] || {};
      // ⚠ 第四個參數是**秒數**,只給分享圖用(內容一個字都不傳,見 board.js 的 addHit)
      DWB.addHit(ctx.dispName(id), Math.max(0, seatOf(id)), h.o, Math.max(0, h.t | 0) / 1000);
      if (id !== ctx.me()) { try { Sound.place(); } catch (e) {} }
    });
  }

  /* ---------- 大廳的規則說明 ---------- */
  function ruleHint() {
    const el = $("dwRuleHint"); if (!el) return;
    const L = DWGen.levelOf(rules.diff);
    /* ★ v1.163.0 起畫家分是「跟著大家的分數抽成」(見 DWR.drawerPts)——
       這一句要講清楚,因為它直接影響畫家的策略:**畫得越好、自己拿越多**
       (舊規則反過來,畫爛才划算,而那是玩家自己會算出來的)。 */
    el.innerHTML = "一人畫、其他人打字搶答。<b>越早猜中分數越高</b>(200 / 150 / 100 / 50)," +
      "而<b>畫家跟著大家的分數抽成</b> —— 讓越多人猜懂,自己拿越多;猜錯只凍結 <b>3 秒</b>,冷完繼續猜。" +
      "<br>每人當 <b>" + rules.rounds + "</b> 次畫家 · 一回合 <b>" + rules.sec + "</b> 秒 · 題目「" +
      L.label + "」(" + L.desc + ")";
  }

  /* ==========================================================================
     五、adapter 介面
     ========================================================================== */
  return {
    ns: { rooms: "dw_rooms", index: "dw_index" },
    minPlayers: 2, maxPlayers: 6,
    prefsKey: "draw.prefs.v1",
    emoteAnchor: "dwStage",
    winCardId: "dwWinCard",
    hasResign: false,               // 一場很多回合,「認輸」語意不清(同數獨 / 排七 / UNO)
    /* ★ 筆劃與猜題訊息這兩個房內節點要列進來,建房撞號時 create() 才擦得掉
       (紅線 5:撞到已關閉的房間會直接蓋上去,殘留看不出來)。 */
    extraNodes: ["ink", "say"],
    /* ★ 計分:核心的 scores 記的是**每一場的總得分累加**(規則書那張 850 / 720 的表)。
       所以單位是「分」、目標值要拉得很高;大廳那顆 ± 一次跳 250(見 js/draw/main.js)。 */
    scoreUnit: "分", goalDefault: 1500, goalMax: 9999,
    /* ⚠ **不開 joinMidGame**:中途進來的人畫家次數一定湊不齊,而那是規則書第 11 節的
       公平性核心。js/home-live.js 的那一列也一樣不帶 joinMid(兩邊要一致)。 */

    init(c) { ctx = c; },

    /* ---------- 房間層級設定:整包房規一個欄位 ---------- */
    roomFields() { return { dwRules: DWR.normRules(rules) }; },
    onRoomField(k, v) {
      if (k !== "dwRules") return;
      const next = DWR.normRules(v);
      if (DWR.sameRules(next, rules)) return;
      rules = next;
      ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
    },
    readRoom(r) { if (r && r.dwRules) rules = DWR.normRules(r.dwRules); },

    /* ---------- 一場的生命週期 ---------- */
    lobbyGame() { return { dw: null }; },
    resetRound() {
      detachRound();
      dw = null; curN = -1; curPh = ""; seenHits = {}; coolEnd = 0;
      DWB.resetInk(); DWB.clearSay(); DWB.hideOver(); DWB.stopCd(); DWB.setEnabled(false);
    },
    /* 開一場。★ 座位表:有上一場就整個輪一位(讓不同的人先當畫家),否則洗牌。
       ⚠ 房規在**這一刻凍結**進 dw.rules(比照 21 點):開打之後房主再改設定也不影響這一場。 */
    newGame(ids, prev) {
      const R = DWR.normRules(rules);
      let ord;
      if (prev && prev.length === ids.length && prev.every(id => ids.indexOf(id) >= 0)) ord = prev.slice(1).concat(prev[0]);
      else { ord = ids.slice(); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ord[i]; ord[i] = ord[j]; ord[j] = t; } }
      /* 收垃圾:上一場的筆劃 / 猜題訊息整包砍掉(房主開局時做一次)。
         ⚠ 這**不是**「新的一場不會看到舊圖」的保證 —— 那件事靠 mid(見 inkPath)。
           remove() 是非同步的,慢一步照樣會被 child_added 重放。 */
      const a = ctx.ref("ink"); if (a) a.remove();
      const b = ctx.ref("say"); if (b) b.remove();
      return {
        order: ord,
        dw: {
          mid: Date.now(),              // 這一場的識別碼(筆劃節點的路徑要用,見 inkPath)
          seq: 1, n: 0, ph: "pick", at: Date.now(),
          cand: DWGen.pick3(R.diff, []), w: -1, used: [],
          hits: null, miss: null, last: null, pts: null,
          st: null,                     // 娛樂統計(整場累積,見 toShow)
          gs: ord.length - 1,           // 第一回合有幾個人可以猜
          rules: R
        }
      };
    },

    /* ---------- 每一份 game 快照 ---------- */
    applyGame(g, playing) {
      gOrder = (g && g.order) || [];
      dw = (g && g.dw) || null;
      if (!playing || !dw) { DWB.setEnabled(false); DWB.setGuess({ show: false }); return; }

      // 換回合 → 重掛筆劃 / 猜題監聽,並請房主把上一回合的資料收掉
      if (dw.n !== curN) {
        const old = curN;
        curN = dw.n; curPh = "";
        coolEnd = 0;
        attachRound(dw);
        sweep(dw.mid, old);
        try { Sound.turn(); } catch (e) {}
      }
      // 換相位 → 蓋板、畫布鎖、音效
      if (dw.ph !== curPh) {
        curPh = dw.ph;
        if (dw.ph === "draw") {
          try { Sound.start(); } catch (e) {}
          /* ★ 字數在猜題列也報一次(v1.161.0)——「幾個字」是猜題者唯一的提示,而眼睛
             在畫布與猜題列上,頂列那顆晶片很容易被忽略。⚠ 畫家不必收(他看得到題目);
             ⚠ 一定要排在上面那段 attachRound() 後面 —— 它會 clearSay(),順序反了這一行會被清掉。 */
          if (!iAmDrawer()) DWB.sysSay("題目是 " + DWGen.lenAt(dw.w) + " 個字 ✏️");
        }
      }
      DWB.setEnabled(dw.ph === "draw" && iAmDrawer());

      announceHits();
      paintHud(); paintBar(); paintTools(); paintGuessRow(); paintOver();
      DWB.fit();

      /* 所有猜題者都猜中了 → 不必等到 60 秒(規則書第 13 節)。
         ⚠ 每一台都會看到同一份快照,所以每一台都會叫這一支 —— 交易的 seq 守衛保證只有第一個算數。 */
      if (dw.ph === "draw" && DWR.roundDone(guesserIds(), dw.hits)) toShow(dw.seq);
      armPhaseT();
    },

    /* ---------- 各相位的專屬畫面 ---------- */
    openConnect() { showScreen("connect"); },
    enterLobby() {
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      DWB.setEnabled(false);
      ruleHint();
    },
    backToLobby() {
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      clearPhaseT(); detachRound();
      dw = null; curN = -1; curPh = ""; seenHits = {}; coolEnd = 0;
      DWB.resetInk(); DWB.clearSay(); DWB.hideOver(); DWB.stopCd();
      DWB.setEnabled(false); DWB.setGuess({ show: false });
      ruleHint();
    },
    enterPlaying() {
      showScreen("play");
      $("mpBar").classList.add("playing");
      DWB.fit();
      DWB.sysSay("開始了!畫家會先選一個題目 🎨");
    },
    onLeave() {
      clearPhaseT(); detachRound();
      dw = null; curN = -1; curPh = ""; seenHits = {}; coolEnd = 0;
      DWB.resetInk(); DWB.clearSay(); DWB.hideOver(); DWB.stopCd();
      DWB.setEnabled(false); DWB.setGuess({ show: false });
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup() {
      const isHost = ctx.isHost();
      [["dwSecSeg", "sec"], ["dwRoundSeg", "rounds"], ["dwDiffSeg", "diff"]].forEach(([id, key]) => {
        const seg = $(id); if (!seg) return;
        seg.classList.toggle("readonly", !isHost);
        [...seg.children].forEach(b => {
          const v = key === "diff" ? b.dataset.v : +b.dataset.v;
          b.classList.toggle("on", v === rules[key]);
        });
      });
      [["dwSecLabel", "作畫秒數"], ["dwRoundLabel", "每人當幾次畫家"], ["dwDiffLabel", "題目難度"]].forEach(([id, base]) => {
        const el = $(id); if (el) el.textContent = isHost ? base : (base + "(房主決定)");
      });
      ruleHint();
    },
    updateGoal() {
      const el = $("mpBarGoal"); if (!el) return;
      const live = ctx.phase() === "playing" && dw;
      const R = DWR.normRules(live ? dw.rules : rules);
      el.textContent = "🎨 每人 " + R.rounds + " 次 · " + R.sec + " 秒";
      el.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    turnId() { return ctx.phase() === "playing" && dw ? drawerId() : null; },
    chipLead(id) {
      const s = seatOf(id);
      if (s < 0) return null;
      return '<span class="dw-seat p' + (s % 6) + '"></span>';
    },
    /* 晶片尾巴:這一場的得分 + 「這一題猜中了」的勾。
       ⚠ 勾**只在 draw 相位畫**:公布答案之後全場都知道誰猜中了,那時再掛一排勾
         只是雜訊;而且下一回合開始時 hits 會被清掉,留著會閃一下舊資料。
       ⚠ 畫家那一格不畫勾(他不能猜)—— 輪到誰畫由核心的 .turn 高亮講(見 turnId)。 */
    chipTail(id) {
      if (!dw) return "";
      const hit = dw.ph === "draw" && dw.hits && dw.hits[id] && id !== drawerId();
      return (hit ? '<span class="dw-hit" title="已經猜中">✅</span>' : '') +
             '<span class="dw-pts">' + ptsOf(id) + '</span>';
    },
    lobbyStatusText(ids) {
      return ids.length < ctx.minPlayers
        ? "等待其他人加入…(最多 " + ctx.maxPlayers + " 人)"
        : "等待大家準備…(" + ids.length + " 人)";
    },
    readyHint(ids, ready) {
      if (ids.length < ctx.minPlayers) return "至少要 " + ctx.minPlayers + " 個人才能開始(最多 " + ctx.maxPlayers + " 人)";
      return ready ? "等其他人按準備…" : "按「準備好了」就開始";
    },
    refresh() { if (ctx.phase() === "playing") { paintHud(); paintBar(); } },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, isDraw }) {
      clearPhaseT();
      DWB.setEnabled(false); DWB.hideOver(); DWB.stopCd();
      DWB.setGuess({ show: false });
      const pts = (dw && dw.pts) || (w && w.pts) || {};
      const rows = DWR.standings(aliveOrder(), pts);
      const me = ctx.me();
      const box = $("dwStats");
      if (box) {
        const medal = ["🥇", "🥈", "🥉"];
        box.innerHTML = '<div class="dw-st-h">本場總得分</div>' + rows.map((r, i) =>
          '<div class="dw-st-row' + (r.id === me ? " me" : "") + '">' +
            '<span class="dw-st-k">' + (medal[i] || (i + 1) + ".") + '</span>' +
            '<span class="dw-seat p' + (Math.max(0, seatOf(r.id)) % 6) + '"></span>' +
            '<span class="dw-st-n">' + esc(ctx.dispName(r.id)) + '</span>' +
            '<span class="dw-st-p">' + r.pts + '<em>分</em></span>' +
          '</div>').join("");
        box.classList.remove("hidden");
      }
      /* ★★ 賽末獎項(v1.163.0)。使用者要的「娛樂性」有一半在這裡:
         總分表講的是誰贏,獎項講的是**這一場發生過什麼**(誰手最快、誰畫得沒人看懂)。
         ⚠ 資料一定是 dw.st —— 那是每回合結算時累加的(見 toShow),
           結果卡這一刻的 dw.hits / dw.miss 只剩最後一回合。
         ⚠ 沒有人夠格就整塊收起來(第一回合就散場的房會是空的),
           不要留一塊寫著「無」的空盒子。 */
      const aw = $("dwAwards");
      if (aw) {
        const list = DWR.awards(aliveOrder(), (dw && dw.st) || {});
        aw.innerHTML = list.length
          ? '<div class="dw-st-h">這一場的名場面</div>' + list.map(a =>
              '<div class="dw-aw-row' + (a.id === me ? " me" : "") + '">' +
                '<span class="dw-aw-ic">' + a.ic + '</span>' +
                '<span class="dw-aw-t">' + esc(a.t) + '</span>' +
                '<span class="dw-aw-n">' + esc(ctx.dispName(a.id)) + '</span>' +
                '<span class="dw-aw-v">' + esc(a.v) + '</span>' +
              '</div>').join("")
          : "";
        aw.classList.toggle("hidden", !list.length);
      }
      const mine = pts[me] || 0;
      if (isDraw) return { word: "平手!", msg: "最高分同分 🤝 你這場拿了 <b>" + mine + "</b> 分" };
      if (iWon) return { word: "你贏了!", msg: "這場最高分,漂亮 🎉 <b>" + mine + "</b> 分" };
      return { word: "你輸了", msg: esc((w && w.name) || "對手") + " 拿下這場 · 你這場 <b>" + mine + "</b> 分" };
    },

    /* ---------- 偏好 ---------- */
    ownPrefs() { return { dwRules: DWR.normRules(rules), dwZoom: zoom }; },
    usePrefs(o) {
      if (!o) return;
      if (o.dwRules) rules = DWR.normRules(o.dwRules);
      /* ★★★ 放大只**記下來**,畫面由 showScreen() 去套(v1.161.0 修的 bug)。
         這一刻是開頁那一瞬間,畫面還在連線層 —— 在這裡 setZoom(true) 會把頂列
         (遊戲名稱 + ⛶ + ⚙️)收掉,而放大鈕住在 #dwPlay 裡是 hidden 的 → **關不回來**。
         症狀正是使用者回報的「這一頁比別的遊戲少了最上面那一列」,而且只發生在
         「上一場忘了縮小」的人身上(偏好記著)→ 自己測很容易永遠遇不到。
         ⚠ board.js 的 setZoom() 裡另外有一道守衛,兩邊一起看(這一行只是不做無用功)。 */
      if (typeof o.dwZoom === "boolean") zoom = o.dwZoom;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      pick, ink, inkClear, guess,
      zoom: () => zoom,
      toggleZoom() { zoom = !zoom; DWB.setZoom(zoom); savePrefs(); },
      rules: () => DWR.normRules(rules),
      setRule(key, val) {
        const next = DWR.normRules(Object.assign({}, rules, { [key]: val }));
        /* ⚠⚠ 白名單擋掉的值會被 normRules **換成預設值**,而不是留在原地 ——
           少了下面這一行的話,「按到一個不合法的值」會靜靜變成「改成預設值」:
           房規明明是 90 秒,按一下壞掉的鈕就變成 60 秒,而畫面上看起來像正常改過。
           → 回頭確認這一欄真的變成我要的那個值,被換掉就整個不動。 */
        if (next[key] !== val) return;
        if (DWR.sameRules(next, rules)) return;
        if (!ctx.setRoomField("dwRules", next, { lobbyOnly: true, denyMsg: "只有房主能改設定", busyMsg: "對戰中不能改設定" })) return;
        rules = next; ctx.syncSetup(); ctx.updateGoal(); ruleHint(); savePrefs();
      },
      // 診斷 / e2e 用:目前這一場的狀態(不對外顯示)
      state: () => (dw ? { n: dw.n, ph: dw.ph, seq: dw.seq, w: dw.w, hits: dw.hits, miss: dw.miss, pts: dw.pts, st: dw.st } : null)
    }
  };
})());

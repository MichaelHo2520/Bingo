"use strict";

/* ============================================================================
   21 點 — 畫面切換、房規面板、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 BJB、同一條動作列 #bjActs、同一張結果卡、
   而且共用同一組房規面板 #bjRulesVeil**,差別只在上面那條列與結果卡的按鈕組 ——
   靠 body 的 solo-on / bj-mp 兩個 class 切換(與其他七個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。

   ── ★★ 房規面板為什麼是一個蓋板,而不是兩份面板 ────────────────────────────
     房規有九項,單機與連線都要能設(單機時「我就是房主」)。
     ① 塞在大廳與單機設定兩處 = **兩份 DOM 兩份 id** → 走鐘了兩邊各自都不會壞,
        而那正是這個專案最痛的一類(全螢幕 / 表情 / 罐頭句都踩過)。
     ② 做成一個蓋板 #bjRulesVeil,兩邊各用一顆鈕打開 → 一組 DOM、一支 syncRules。
     ⚠ 新增蓋板要順手列進 ui-kit 的 BACK_LAYERS,否則手機按返回會跳成「離開房間?」
       (CLAUDE.md 的紅線)。
   ========================================================================== */

const BJ_SCREENS = ["bjHome", "bjSetup", "bjSoloBar", "bjPlay"];
function showScreen(which){
  const on = {
    home:    ["bjHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["bjSetup"],
    play:    ["bjPlay"],                // 連線對戰中
    solo:    ["bjSoloBar", "bjPlay"]    // 電腦對決
  }[which] || [];
  BJ_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => {
      const el = $(id); if(el) el.classList.add("hidden");
    });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  // bj-mp / bj-solo:對局中才把牌桌放寬(大廳與選單維持 .panel 原本的 520,
  // 不然會變成「一塊寬一塊窄」)。同排七 / 大老二 / 台灣麻將。
  document.body.classList.toggle("bj-mp", which === "play");
  document.body.classList.toggle("bj-solo", which === "solo");
  /* 對局中 ⛶/⚙️ 該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**
     (v1.75.10 立的規矩)。這一頁橫置手機會收頂列(styles.css 的
     `(orientation:landscape) and (max-height:560px) and (pointer:coarse)`)。
     ⚠ 兩種情形都不必也不可以在這裡判斷,條件只准有一份(就在 dockTools 裡面)。 */
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("bjSoloBar");
  else undockTools();
  /* 大牌桌:每次換畫面都**無條件**重套一次(v1.178.3,見 ui-kit 的 BigMode)。
     進牌桌把偏好記著的狀態套回來、離開牌桌把 body 上的 class 脫掉 —— 那個 class 會收掉
     整條頂列(⛶ / ⚙️ 都在裡面),而兩顆鈕住在房間框 / 單機列裡,留著就再也關不回來。
     ⚠ 守衛在 BigMode 自己,這裡不要再判斷一次 which;⚠ 一定要排在 dockTools() 之後。 */
  BigMode.sync();
  if(which === "home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數。與排七 / 大老二 / 台灣麻將同一個模式。
   回 index.html 的返回列只在第一層顯示:第二層有自己的返回,兩顆並存會分不清誰是誰。 */
function showHomeLayer(which){
  const pick = $("bjPickMode"), solo = $("bjPickSolo"), head = $("bjHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();   // 同上:第二層按返回要退回第一層,不是離開這一頁
}

/* ==========================================================================
   ★ 房規面板 —— 單機與連線共用這一支(見檔頭)
   ──────────────────────────────────────────────────────────────────────────
     每一列是一個 .seg,按鈕帶 data-rk(哪一項)與 data-rv(值)。
     ⚠ 值一律走字串比對再轉型:pushDealer / dragon / bustFirst 是布林,
       其餘是數字(bjPay 還是小數)—— DOM 的 dataset 永遠是字串。
     ⚠ 不能改的時候給 .readonly(只是不亮、不吃點擊由 setRule 端擋)——
       **不用 disabled**:CLAUDE.md 的紅線是「不用 disabled 讓點擊靜默消失」,
       訪客按下去要看得到「只有房主能改規則」。
   ========================================================================== */
const BJ_BOOLS = { pushDealer: 1, dragon: 1, bustFirst: 1 };
/* ★★ v1.88.0:first(誰先當莊)的值是**字串**("host" / "rand" / "p:<token>")——
   ⚠ 不列進來的話 `+raw` 會把它變成 NaN,而症狀是「那一列一顆都不亮、按了也選不上」。 */
const BJ_STRS = { first: 1 };
function bjRuleVal(key, raw){
  if(BJ_BOOLS[key]) return raw === "1" || raw === "true";
  if(BJ_STRS[key]) return String(raw);
  return +raw;
}
/* ★★★ 「點名」的那一位叫什麼名字 —— **只有這一支解讀 token**(v1.88.0):
     連線 = pid → 名單裡的 name;單機 = 座位號 → Solo 的名字表。
   ★ 回空字串 = 那個人已經不在(離開房間 / 人數改小了)→ 文案與面板都退回「第 1 家」,
     而規則層的 BJ.firstIdx 找不到 token 時**正好**也是回第 1 家(同一個答案兩處各自成立)。 */
function bjFirstName(rules){
  const tok = BJ.firstTok(rules && rules.first);
  if(!tok) return "";
  if(MP.isOnline()){
    const m = MP.roster().filter(x => x.id === tok)[0];
    return m ? m.name : "";
  }
  const nms = Solo.seatNames();
  const i = +tok;
  return (i >= 0 && i < nms.length) ? nms[i] : "";
}
/* 「點名誰先當莊」那一排 —— ★ 選項跟著**現在有誰**變,所以只能在這裡生成。
   ⚠ 單機的 token 是座位號、連線是 pid:兩邊的差別只在這一支(其餘一律走 BJ.mkFirst)。 */
function bjPaintFirstWho(r, editable){
  const box = $("bjFirstWho");
  if(!box) return;
  const list = MP.isOnline()
    ? MP.roster().map(x => ({ tok: x.id, nm: x.name }))
    : Solo.seatNames().map((nm, i) => ({ tok: String(i), nm: nm }));
  const cur = BJ.firstTok(r.first);
  box.classList.toggle("readonly", !editable);
  /* ⚠ 只放鈕,一個字都不要夾在 .seg 裡面(那是分段控制的版面,塞說明會擠歪);
     「.on」由下面 syncRules 那個共用迴圈統一決定 —— 這裡不自己判斷第二次。 */
  box.innerHTML = list.map(x =>
    '<button data-rk="first" data-rv="' + esc(BJ.mkFirst(x.tok)) + '">' +
      esc(x.nm) + '</button>').join("");
  // ★ 指名的人已經不在 → 說出來(不然那一排一顆都沒亮,看起來像壞掉)
  const note = $("bjFirstNote");
  if(note){
    const gone = !!cur && !list.some(x => x.tok === cur);
    note.textContent = gone ? "指名的那一位已經不在 → 由第 1 家先當莊" : "";
    note.classList.toggle("hidden", !gone);
  }
}
function syncRules(rules, editable){
  const r = BJ.normRules(rules);
  bjPaintFirstWho(r, editable);        // ★ 要在下面那個迴圈**之前**:它生成的鈕也要吃 .readonly
  document.querySelectorAll("#bjRulesBody .seg").forEach(seg => {
    seg.classList.toggle("readonly", !editable);
    [...seg.children].forEach(b => {
      const k = b.dataset.rk;
      if(!k) return;
      b.classList.toggle("on", bjRuleVal(k, b.dataset.rv) === r[k]);
    });
  });
  const lbl = $("bjRulesWho");
  if(lbl) lbl.textContent = editable ? "你是房主,規則由你決定" : "規則由房主決定(對戰中不能改)";
  const sum = $("bjRulesSum");
  if(sum) sum.innerHTML = BJB.rulesHTML(r, bjFirstName(r));
}
/* 目前該對誰設定 —— 單機改 Solo 的、連線改房間的(★ 唯一的分流點就這一支)。 */
function bjEditable(){ return !MP.isOnline() || MP.amHost(); }
function bjRulesNow(){ return MP.isOnline() ? MP.rules() : Solo.rules(); }
function bjSetRule(key, val){
  if(MP.isOnline()){ MP.setRule(key, val); return; }
  if(Solo.playing()){ showToast("對局中不能改規則 —— 這一場的規則已經定下來了", 2400); return; }
  Solo.setRule(key, val);
  syncRules(Solo.rules(), true);
  paintSoloHint();
}
function openRules(){
  syncRules(bjRulesNow(), bjEditable());
  $("bjRulesVeil").classList.add("show");
}
function closeRules(){
  $("bjRulesVeil").classList.remove("show");
  /* 關掉之後把摘要重畫一次。★ 兩邊的摘要都吃同一支 BJB.rulesHTML ——
     大廳是 #bjRuleHint 那份 <ul>、單機是第二層的 #bjSoloHint。 */
  if(MP.isOnline()){
    const hint = $("bjRuleHint");
    if(hint) hint.innerHTML = BJB.rulesHTML(MP.rules(), bjFirstName(MP.rules()));
  }else paintSoloHint();
}

/* 第二層的說明:難度文案直接讀 BJAI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el = $("bjSoloHint");
  if(!el) return;
  const L = BJAI.levelOf(Solo.level());
  const n = Solo.seats();
  const r = Solo.rules();
  el.innerHTML = "<b>" + L.emoji + " " + L.name + "</b>:" + esc(L.desc) + "<br>" +
    "<b>" + n + " 人</b> · 打 <b>" + r.rounds + " 輪</b>(共 " + Solo.totalRounds() + " 局)· " +
    // ★ v1.87.0:換莊頻率可調 → 這一句不可以寫死「每一局換」
    (r.hands > 1 ? ("<b>連做 " + r.hands + " 局才換莊</b>") : "<b>每一局換莊</b>") + "。<br>" +
    /* ★★★ v1.88.0:這一句原本寫死「你固定坐第一位,第一局由電腦當莊」——
       那正是使用者抱怨的「為什麼我總是最後」。現在起點由房規決定,所以這一句
       **一定要跟著房規變**(寫死的文案就是第二份真相,而且是最會騙人的那一種)。 */
    "你坐<b>第 1 家</b>," + (
      r.first === BJ.FIRST_RAND ? "<b>誰先當莊隨機抽</b>"
        : (BJ.firstTok(r.first)
            ? ("<b>" + esc(bjFirstName(r) || "第 1 家") + " 先當莊</b>")
            : "<b>第一局你當莊</b>")
    ) + ",之後照座位號碼往下輪(每個人各當 " + r.rounds + " 次莊)。<br>" +
    // ⚠ 圖示一律 🎴(U+1F3B4);小丑牌那顆是 U+1F0CF,落在被禁的區段
    "<span class=\"bj-warn\">🎴 " + esc(Solo.recLine(Solo.level())) + "</span>";
}
/* 選擇列共用的「點一下亮起來」 */
function segPick(id, attr, fn){
  const seg = $(id);
  if(!seg) return;
  seg.addEventListener("click", e => {
    const b = e.target.closest("button");
    if(!b) return;
    fn(b.dataset[attr]);
    [...seg.children].forEach(x => x.classList.toggle("on", x === b));
    paintSoloHint();
  });
}
function syncSoloSeg(){
  const set = (id, attr, val) => {
    const seg = $(id);
    if(!seg) return;
    [...seg.children].forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(val)));
  };
  set("bjLvSeg", "lv", Solo.level());
  set("bjSeatSeg", "seats", Solo.seats());
}

/* ---------- 盤面 ----------
   ★ 這一頁只有一個回呼(21 點沒有點牌 —— 不必選牌、不必拖曳排序),
     但**照樣要分流到單機 / 連線**:盤面本身不知道自己在哪一種模式(見 board.js 檔尾),
     漏掉分流的症狀是「單機按鈕沒反應」或「連線按鈕走到單機那條路」。 */
BJB.mount({
  onAct(a, bet){ if(Solo.active()) Solo.act(a, bet); else MP.act(a, bet); }
});

/* ---------- 進場選單 ---------- */
$("bjGoOnline").addEventListener("click", () => MP.openConnect());
$("bjGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("bjSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("bjLvSeg", "lv", v => Solo.setLevel(v));
segPick("bjSeatSeg", "seats", v => Solo.setSeats(+v));
$("bjStartSolo").addEventListener("click", () => Solo.startMatch());

/* ---------- 房規面板(兩個入口 → 同一個蓋板)---------- */
$("bjSoloRules").addEventListener("click", openRules);
$("bjRulesOpen").addEventListener("click", openRules);
// 兩顆關閉鈕(右上角的 ✕ 與底下的「完成」)—— 都走同一支
$("bjRulesClose").addEventListener("click", closeRules);
$("bjRulesClose2").addEventListener("click", closeRules);
$("bjRulesVeil").addEventListener("click", e => { if(e.target === $("bjRulesVeil")) closeRules(); });
$("bjRulesBody").addEventListener("click", e => {
  const b = e.target.closest("button[data-rk]");
  if(!b) return;
  bjSetRule(b.dataset.rk, bjRuleVal(b.dataset.rk, b.dataset.rv));
  syncRules(bjRulesNow(), bjEditable());
});

/* ---------- 單機的牌桌列 / 結果卡 ---------- */
$("bjSoloExit").addEventListener("click", () => Solo.quit());
$("bjSoloAgain").addEventListener("click", () => Solo.again());
$("bjSoloHome").addEventListener("click", () => Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("scoreSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() - 1));
$("wgPlus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() + 1));
$("resetScoreBtn").addEventListener("click", () => MP.resetScores());

/* ---------- 連線 / 房間 ---------- */
$("mpCreate").addEventListener("click", () => MP.create($("mpName").value, $("mpRoomName").value));
$("mpScan").addEventListener("click", () => MP.scanRooms());
$("mpName").addEventListener("change", savePrefs);
$("mpName").addEventListener("input", () => $("mpName").classList.remove("needs-name"));
$("mpRoomName").addEventListener("keydown", e => { if(e.key === "Enter") MP.create($("mpName").value, $("mpRoomName").value); });
$("mpReadyBtn").addEventListener("click", () => MP.toggleReady());
$("mpLeaveBtn").addEventListener("click", () => MP.askLeave());
$("mpConnBack").addEventListener("click", () => showScreen("home"));
$("leaveConfirm").addEventListener("click", () => MP.confirmLeave());
$("leaveCancel").addEventListener("click", () => MP.cancelLeave());
$("leaveVeil").addEventListener("click", e => { if(e.target === $("leaveVeil")) MP.cancelLeave(); });
$("kickConfirm").addEventListener("click", () => MP.confirmKick());
$("kickCancel").addEventListener("click", () => MP.cancelKick());
$("kickVeil").addEventListener("click", e => { if(e.target === $("kickVeil")) MP.cancelKick(); });

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click", () => MP.again());
$("mpLeaveWin").addEventListener("click", () => MP.askLeave());
$("mpNewSeason").addEventListener("click", () => { MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click", peekBoard);
$("reopenWin").addEventListener("click", showResult);
// 賽後表情列:四顆一鍵送給全部人(結果卡不關,對方也看得到飛出來的表情),😀 開完整面板。
// 節流 600ms:結果卡是強制回應視窗,手指停在上面很容易連點狂送。
let reactAt = 0;
$("bjReactRow").addEventListener("click", e => {
  const b = e.target.closest("button");
  if(!b) return;
  if(b.id === "winEmoteBtn"){ openEmote("all"); return; }
  const em = b.dataset.em;
  if(!em) return;
  const now = performance.now();
  if(now - reactAt < 600) return;
  reactAt = now;
  markAudioArmed(); Sound.wake();
  MP.sendEmote("all", em);
  b.classList.remove("sent"); void b.offsetWidth; b.classList.add("sent");
});

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({sub:"bjPickSolo"});
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整場丟掉)
initUpdateCheck(() => !MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大牌桌(v1.178.3):⚠ 一定要排在 loadPrefs() **之前** —— 偏好會回頭叫 BigMode.set()。 */
BigMode.init({
  cls:"bj-big", btn:"bj-bigbtn", name:"大牌桌",
  live:()=>{ const el=$("bjPlay"); return !!el && !el.classList.contains("hidden"); },
  save:savePrefs
});
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 21 點的連線偏好
Solo.loadOwn();    // 電腦對決的難度 / 人數 / 房規 / 戰績(獨立 key,不與連線那組互相覆蓋)
syncSettingsUI();
syncSoloSeg();
syncRules(Solo.rules(), true);
paintSoloHint();
showScreen("home");      // 進場先選玩法
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip, 1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

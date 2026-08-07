"use strict";

/* ============================================================================
   象棋暗棋 — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 DCB、同一條動作列 #dcActs、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on class 切換(與其他九個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const DC_SCREENS = ["dcHome", "dcSetup", "dcSoloBar", "dcPlay"];
function showScreen(which){
  const on = {
    home:    ["dcHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["dcSetup"],
    play:    ["dcPlay"],                // 連線對戰中
    solo:    ["dcSoloBar", "dcPlay"]    // 電腦對決
  }[which] || [];
  DC_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => { const el = $(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  document.body.classList.toggle("dc-on", which === "play" || which === "solo");
  /* 連線的投降鈕只在**真的在對局中**出現 —— 大廳用的也是 #mpBar,
     不收掉就會在「等對手準備」的畫面上多一顆按了只會跳「現在不能投降」的鈕。
     ⚠ 收在這裡而不是 adapter:相位切換只准有一個地方(見檔頭)。 */
  const rs = $("dcMpResign");
  if(rs) rs.classList.toggle("hidden", which !== "play");
  /* 對局中 ⛶/⚙️ 該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**
     (v1.75.10 立的規矩)。不可以在這裡自己判斷,條件只准有一份。 */
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("dcSoloBar");
  else undockTools();
  if(which === "home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
}

/* ---------- 進場選單的兩層 ---------- */
function showHomeLayer(which){
  const pick = $("dcPickMode"), solo = $("dcPickSolo"), head = $("dcHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
}
/* 第二層的說明:難度文案直接讀 Solo 的難度表,不另外硬編一份。
   ★ 文案規格與進場說明一致:標籤在前、一行一件事,不寫成對話。 */
function paintSoloHint(){
  const el = $("dcSoloHint");
  if(!el) return;
  const L = Solo.levelOf(Solo.level());
  el.innerHTML = "<b>" + L.emoji + " " + L.name + "</b>:" + esc(L.desc) + "<br>" +
    /* ★ 房規要講**現在設的是哪一種** —— 單機的房規存在自己的偏好裡、跨場黏著,
       不寫出來會忘記上次改過(同大老二 / UNO 第二層那條)。 */
    "<b>房規</b>:" + esc(DC.rulesText(Solo.rules())) + "(按上面「⚙ 改規則」調整)<br>" +
    '<span class="dc-warn">' + esc(Solo.recLine(Solo.level())) + "</span>";
}

/* ==========================================================================
   ★★★ 房規面板 —— 單機與連線**共用這一支**
   ──────────────────────────────────────────────────────────────────────────
     結構照大老二 / 21點 / UNO:
       · 面板本體是一個蓋板 #dcRulesVeil,單機第二層與大廳各一顆鈕打開它
       · 一組房規一列 .seg[data-rp](哪一組),按鈕帶 data-rv = **第幾段**(0/1/2)
       · 分流點**只有下面三支**(dcEditable / dcRulesNow / dcSetRule)
     ★★ 面板只送「第幾段」,翻成四個布林的是 DC.setRuleLevel ——
        面板不必知道 chainDark 依賴 chain,巢狀關係仍然只在 DC.normRules 落地。
     ⚠ 不能改的時候給 .readonly(只是不亮)—— **不用 disabled**:
       CLAUDE.md 的紅線是「不用 disabled 讓點擊靜默消失」,訪客按下去要看得到
       「只有房主能改規則」(擋在 MP.setRules / Solo 那一側,不是擋在 CSS)。
   ========================================================================== */
function syncRules(rules, editable){
  const r = DC.normRules(rules);
  document.querySelectorAll("#dcRulesBody .seg[data-rp]").forEach(seg => {
    const lv = DC.ruleLevel(r, seg.dataset.rp);
    seg.classList.toggle("readonly", !editable);
    // ⚠ dataset 永遠是字串 —— 一律 +b.dataset.rv 轉成數字再比(第 0 段不可以當 falsy 用)
    [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.rv) === lv));
  });

  /* ★ 走棋倒數那一組**只有連線才有**(單機沒有倒數 —— 想多久是自己的節奏)。
     ⚠ 它不在 rules 物件裡:那個房間欄位不影響任何判定。 */
  const secG = $("dcSecGroup");
  if(secG){
    const on = MP.isOnline();
    secG.classList.toggle("hidden", !on);
    if(on){
      const seg = $("dcSecSeg2");
      if(seg){
        seg.classList.toggle("readonly", !editable);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === MP.turnSec()));
      }
    }
  }
  const who = $("dcRulesWho");
  if(who) who.textContent = editable ? "房規在下一局開始時套用" : "房規由房主設定";
  const sum = $("dcRulesSum");
  if(sum) sum.textContent = DC.rulesText(r);
}
/* 現在該對誰設定 —— 單機改 Solo 的、連線改房間的(★ 唯一的分流點就這三支) */
function dcEditable(){ return !MP.isOnline() || MP.amHost(); }
function dcRulesNow(){ return MP.isOnline() ? MP.rules() : Solo.rules(); }
/* kind = "chain" | "rush" | "caps";lv = 第幾段(caps 只有 0/1,其餘 0/1/2)。
   ⚠ 一次送整份房規:一次一個 key 的寫法在連線會變成兩次 DB 寫入(見 adapter 的 setRules)。 */
function dcSetRule(kind, lv){
  const next = DC.setRuleLevel(dcRulesNow(), kind, lv);
  if(MP.isOnline()){ MP.setRules(next); syncRules(dcRulesNow(), dcEditable()); return; }
  if(Solo.playing()){ showToast("對局中不能改規則", 1600); return; }
  Solo.setRules(next);
  syncRules(Solo.rules(), true);
  paintSoloHint();
}
function openRules(){
  syncRules(dcRulesNow(), dcEditable());
  $("dcRulesVeil").classList.add("show");
}
function closeRules(){
  $("dcRulesVeil").classList.remove("show");
  // 關掉之後把摘要重畫一次(大廳那行 / 單機第二層那段各一份文案,但**同一支** DC.rulesText)
  if(MP.isOnline()) MP.refreshSetup();
  else paintSoloHint();
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
  set("dcLvSeg", "lv", Solo.level());
  set("dcFirstSeg", "first", Solo.first());
}

/* ---------- 盤面 ----------
   ★ 要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(見 board.js 檔頭),
     漏掉分流的症狀是「單機點棋沒反應」或「連線點棋走到單機那條路」。 */
DCB.onAct(mv => { if(Solo.active()) Solo.act(mv); else MP.act(mv); });

/* ---------- 進場選單 ---------- */
$("dcGoOnline").addEventListener("click", () => MP.openConnect());
$("dcGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("dcSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("dcLvSeg", "lv", v => Solo.setLevel(v));
segPick("dcFirstSeg", "first", v => Solo.setFirst(v));
$("dcStartSolo").addEventListener("click", () => Solo.start());
$("dcSoloRules").addEventListener("click", openRules);

/* ---------- 單機的棋桌列 / 結果卡 ---------- */
$("dcSoloExit").addEventListener("click", () => Solo.quit());
$("dcSoloAgain").addEventListener("click", () => Solo.again());
$("dcSoloHome").addEventListener("click", () => Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("dcSecSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setTurnSec(+b.dataset.sec); });
/* ---------- 房規面板(一組 DOM,兩個入口)----------
   ⚠ 監聽綁在 #dcRulesBody 上**一次**(委派):以後加項目不必改這裡。 */
$("dcRulesOpen").addEventListener("click", openRules);
$("dcRulesClose").addEventListener("click", closeRules);
$("dcRulesVeil").addEventListener("click", e => { if(e.target.id === "dcRulesVeil") closeRules(); });
$("dcRulesBody").addEventListener("click", e => {
  const b = e.target.closest(".seg[data-rp] button[data-rv]");
  if(b){ dcSetRule(b.closest(".seg").dataset.rp, +b.dataset.rv); return; }
  // 走棋倒數那一組走既有的房間欄位(不是房規物件)——⚠ 兩處入口寫同一支 MP.setTurnSec
  const s = e.target.closest("#dcSecSeg2 button");
  if(s){ MP.setTurnSec(+s.dataset.sec); syncRules(dcRulesNow(), dcEditable()); }
});
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
$("dcReactRow").addEventListener("click", e => {
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

/* ==========================================================================
   投降 —— 單機與連線**共用同一張確認卡** #resignVeil
   ──────────────────────────────────────────────────────────────────────────
     ★ 兩顆入口鈕(#dcSoloResign / #dcMpResign),一組 DOM,分流只在 confirmResign()。
     ★ 一定要先跳確認卡:誤按一下就是直接輸掉一局。
     ⚠ 關卡的路徑有兩條 —— 按鈕與**返回鍵**(ui-kit 的 BACK_LAYERS 已經列了
       resignVeil,它呼叫的是 MP.cancelResign();那一支不管單機連線都只是把卡收掉)。
     ⚠ 不用 mp-core 的 hasResign 那條路:暗棋的真相是 replay(deal, moves, rules),
       投降要當成**一手 move** 走進去(才有 st.over / endBy="resign",單機也才共用得到)。
   ========================================================================== */
function openResign(){
  const ok = Solo.active() ? Solo.playing() : MP.canResign();
  if(!ok){ showToast("現在不能投降"); return; }
  $("resignVeil").classList.add("show");
}
function closeResignAsk(){ $("resignVeil").classList.remove("show"); }
function confirmResign(){
  closeResignAsk();
  if(Solo.active()) Solo.resign();
  else MP.resign();
}
$("dcSoloResign").addEventListener("click", openResign);
$("dcMpResign").addEventListener("click", openResign);
$("resignConfirm").addEventListener("click", confirmResign);
$("resignCancel").addEventListener("click", closeResignAsk);
$("resignVeil").addEventListener("click", e => { if(e.target === $("resignVeil")) closeResignAsk(); });

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整局丟掉)
initUpdateCheck(() => !MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 暗棋的連線偏好
Solo.loadOwn();    // 電腦對決的難度 / 先手 / 房規 / 戰績(獨立 key,不與連線那組互相覆蓋)
syncSettingsUI();
DCB.init();        // 盤面 DOM + 點擊委派(舞台此時是 hidden,ResizeObserver 會在顯示後算方向)
syncSoloSeg();
paintSoloHint();
showScreen("home");      // 進場先選玩法
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip, 1500);

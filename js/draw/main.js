"use strict";

/* ============================================================================
   你畫我猜 — 畫面切換、事件綁定與啟動(必須最後載入)

   ★ 這一頁**只有連線**(見 draw.html 進場選單那段註解),所以:
     · 沒有 body.solo-on 這一條路,showScreen() 少一個 "solo"
     · bindPageBack() 不必給 sub(進場選單只有一層)
     · initUpdateCheck() 的「安全」只問「在不在房裡」
   ========================================================================== */

/* ---------- 畫面切換 ----------
   mpConnect / mpBar / scrollArea / primaryBar 由 mp-core 控制,這裡只管自己的區塊。 */
const DW_SCREENS = ["dwHome", "dwPlay", "dwSetup"];
function showScreen(which) {
  const on = {
    home:    ["dwHome"],
    connect: [],                       // 連線畫面本體由 mp-core 顯示
    lobby:   ["dwSetup"],
    play:    ["dwPlay"]
  }[which] || [];
  DW_SCREENS.forEach(id => { const el = $(id); if (el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  if (which === "home") {
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => { const el = $(id); if (el) el.classList.add("hidden"); });
  }
  if (which === "play") dockTools("mpBar"); else undockTools();
  if (which === "play") DWB.fit();
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 畫板 / 猜題的四個入口 ----------
   ⚠ 全部只是「把使用者做了什麼交給 adapter」,一行 DB 都不寫 ——
     什麼時候寫、寫得進去嗎,一律由 js/draw/adapter.js 判定(比照另外十一頁的分工)。 */
DWB.init({
  onStroke(rec) { MP.ink(rec); },
  onClear() { MP.inkClear(); },
  onGuess(text) { MP.guess(text); },
  onPick(k) { MP.pick(k); }
});

/* ---------- 進場選單 ---------- */
$("dwGoOnline").addEventListener("click", () => MP.openConnect());

/* ---------- 對局:畫家工具列 ---------- */
$("dwClear").addEventListener("click", () => DWB.clearInk());

/* 放大畫板:吃掉猜題列與頂列(見 styles.css 的 body.dw-big)。
   ⚠ 沒有獨立的比分列要接 —— v1.155.0 起比分就畫在房間框的玩家晶片列上,
     而那一排的「點一下傳表情」是核心的 renderPlayers 自己綁的(與另外十一頁同一套)。 */
$("dwZoom").addEventListener("click", () => MP.toggleZoom());

/* ---------- 連線大廳設定(房主可改) ----------
   ⚠ 三段設定都走同一支 MP.setRule(key, val) —— 它自己會擋「只有房主 / 只有大廳」
     並且**整包**寫回 dwRules(房規是一個欄位,見 adapter 的 roomFields)。 */
$("dwRoundSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) MP.setRule("rounds", +b.dataset.v); });
$("dwSecSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) MP.setRule("sec", +b.dataset.v); });
$("dwDiffSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) MP.setRule("diff", b.dataset.v); });
$("scoreSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) MP.setScoreMode(b.dataset.score); });
/* ⚠ 這一頁的目標分數一次跳 **250**,不是 1 —— 一場的總得分是幾百分起跳
   (規則書那張 850 / 720 的表),±1 的話要按幾百下。核心的 clampGoal 對任何步進都成立。 */
const WG_STEP = 250;
$("wgMinus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() - WG_STEP));
$("wgPlus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() + WG_STEP));
$("resetScoreBtn").addEventListener("click", () => MP.resetScores());

/* ---------- 連線 / 房間 ---------- */
$("mpCreate").addEventListener("click", () => MP.create($("mpName").value, $("mpRoomName").value));
$("mpScan").addEventListener("click", () => MP.scanRooms());
$("mpName").addEventListener("change", savePrefs);
$("mpName").addEventListener("input", () => $("mpName").classList.remove("needs-name"));
$("mpRoomName").addEventListener("keydown", e => { if (e.key === "Enter") MP.create($("mpName").value, $("mpRoomName").value); });
$("mpReadyBtn").addEventListener("click", () => MP.toggleReady());
$("mpLeaveBtn").addEventListener("click", () => MP.askLeave());
$("mpConnBack").addEventListener("click", () => showScreen("home"));
$("leaveConfirm").addEventListener("click", () => MP.confirmLeave());
$("leaveCancel").addEventListener("click", () => MP.cancelLeave());
$("leaveVeil").addEventListener("click", e => { if (e.target === $("leaveVeil")) MP.cancelLeave(); });
$("kickConfirm").addEventListener("click", () => MP.confirmKick());
$("kickCancel").addEventListener("click", () => MP.cancelKick());
$("kickVeil").addEventListener("click", e => { if (e.target === $("kickVeil")) MP.cancelKick(); });

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click", () => MP.again());
$("mpLeaveWin").addEventListener("click", () => MP.askLeave());
$("mpNewSeason").addEventListener("click", () => { MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click", peekBoard);
$("reopenWin").addEventListener("click", showResult);
// 賽後表情列:四顆一鍵送給全部人(結果卡不關),😀 開完整面板。節流 600ms 防連點狂送。
let reactAt = 0;
$("dwReactRow").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "winEmoteBtn") { openEmote("all"); return; }
  const em = b.dataset.em; if (!em) return;
  const now = performance.now();
  if (now - reactAt < 600) return;
  reactAt = now;
  markAudioArmed(); Sound.wake();
  MP.sendEmote("all", em);
  b.classList.remove("sent"); void b.offsetWidth; b.classList.add("sent");
});

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({});     // 進場選單只有一層 → 不必給 sub
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡(這一頁沒有單機,不必問 Solo)
initUpdateCheck(() => !MP.isOnline());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();          // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 你畫我猜的連線偏好
syncSettingsUI();
showScreen("home");
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip, 1500);

"use strict";

/* ============================================================================
   成語接龍 — 畫面切換、事件綁定與啟動(必須最後載入)
   單機與連線共用同一組盤面(CYB)與結果卡,差別只在周邊 HUD 與結果卡的按鈕組,
   靠 body 的 solo-on / mp-on 兩個 class 切換(mp-on 由 mp-core 掛)。
   ========================================================================== */

/* ---------- 畫面切換 ----------
   mpConnect / mpBar / scrollArea / primaryBar 由 mp-core 控制,這裡只管成語接龍自己的區塊。 */
const CY_SCREENS = ["cyHome", "cySoloBar", "cyPlay", "cySetup"];
function showScreen(which) {
  const on = {
    home:    ["cyHome"],
    connect: [],                       // 連線畫面本體由 mp-core 顯示
    lobby:   ["cySetup"],
    play:    ["cyPlay"],               // 連線對戰中
    solo:    ["cySoloBar", "cyPlay"]   // 單機
  }[which] || [];
  CY_SCREENS.forEach(id => { const el = $(id); if (el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  if (which === "home" || which === "solo") {
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => { const el = $(id); if (el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  if (which === "play") dockTools("mpBar");
  else if (which === "solo") dockTools("cySoloBar");
  else undockTools();
  if (which === "home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ---------- */
function showHomeLayer(which) {
  const pick = $("cyPickMode"), lvl = $("cyPickLevel"), head = $("cyHomeHead");
  if (pick) pick.classList.toggle("hidden", which !== "pick");
  if (lvl)  lvl.classList.toggle("hidden", which !== "level");
  if (head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();   // 同上:第二層按返回要退回第一層,不是離開這一頁
}
// 第二層的難度說明:直接讀 CYGen 的難度表,不另外硬編一份文案
function paintLevelHint() {
  const el = $("cyLevelHint"); if (!el) return;
  const L = CYGen.levelOf(Solo.level());
  el.textContent = L.label + " " + L.name + " · 空 " + L.holes + " 格 · " + L.desc;
}

/* ---------- 盤面:點格 → 點字卡 ---------- */
CYB.init({
  onNum(i, ch) { if (Solo.running()) Solo.onNum(i, ch); else MP.play(i, ch); },
  onErase(i) { if (Solo.running()) Solo.onErase(i); else MP.erase(i); }
});
addEventListener("keydown", e => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;   // 別吃掉暱稱/聊天輸入
  CYB.onKey(e);
});

/* ---------- 進場選單 ---------- */
$("cyHomeDiffSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  Solo.setLevel(b.dataset.diff);
  [...$("cyHomeDiffSeg").children].forEach(x => x.classList.toggle("on", x === b));
  paintLevelHint();
});
$("cyStartSolo").addEventListener("click", () => Solo.start());
$("cyGoOnline").addEventListener("click", () => MP.openConnect());
$("cyPickSolo").addEventListener("click", () => { paintLevelHint(); showHomeLayer("level"); });
$("cyLevelBack").addEventListener("click", () => showHomeLayer("pick"));

/* ---------- 單機 HUD ---------- */
$("cySoloBack").addEventListener("click", () => Solo.quit());
$("cyPauseBtn").addEventListener("click", () => Solo.togglePause());
$("cyPauseVeil").addEventListener("click", () => Solo.togglePause());
$("cyHintBtn").addEventListener("click", () => Solo.hint());
$("soloAgain").addEventListener("click", () => { closeWin(); Solo.start(); });
$("soloHome").addEventListener("click", () => Solo.quit());

/* 比分 HUD:點某個人的卡片 = 傳表情給他(對戰中名單列收起來了,這裡接手那個入口) */
$("cyHud").addEventListener("click", e => {
  const c = e.target.closest(".cy-hcard"); if (!c) return;
  const id = c.dataset.id; if (!id) return;
  const me = (MP.roster().find(p => p.me) || {}).id;
  openEmote(id === me ? "all" : id);      // 點自己的卡片 = 送給全部人(同玩家晶片的行為)
});

/* ---------- 連線大廳設定(房主可改) ---------- */
$("cyDiffSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) MP.setDiff(b.dataset.diff); });
$("scoreSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) MP.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() - 1));
$("wgPlus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() + 1));
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
$("mpAgain").addEventListener("click", () => { if (!MP.seeDone()) MP.again(); });
$("mpLeaveWin").addEventListener("click", () => MP.askLeave());
$("mpNewSeason").addEventListener("click", () => { MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click", peekBoard);
$("reopenWin").addEventListener("click", showResult);
// 賽後表情列:四顆一鍵送給全部人(結果卡不關),😀 開完整面板。節流 600ms 防連點狂送。
let reactAt = 0;
$("cyReactRow").addEventListener("click", e => {
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
bindPageBack({sub:"cyPickLevel"});
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(單機重載會把計時與填好的格子全部丟掉)
initUpdateCheck(() => !MP.isOnline() && !Solo.running());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();          // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 成語接龍的連線偏好
Solo.loadOwn();       // 單機難度(獨立 key,不與連線的難度互相覆蓋)
syncSettingsUI();
[...$("cyHomeDiffSeg").children].forEach(b => b.classList.toggle("on", b.dataset.diff === Solo.level()));
paintLevelHint();
showScreen("home");   // 進場先選玩法(成語接龍有單機也有連線)
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip, 1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

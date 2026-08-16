"use strict";

/* ============================================================================
   飛行棋 — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 FCB、同一條動作列 #fcActs、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on / fc-mp 兩個 class 切換(與其他十一個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const FC_SCREENS = ["fcHome", "fcSetup", "fcSoloBar", "fcPlay"];
function showScreen(which){
  const on = {
    home:    ["fcHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["fcSetup"],
    play:    ["fcPlay"],                // 連線對戰中
    solo:    ["fcSoloBar", "fcPlay"]    // 單機遊玩
  }[which] || [];
  FC_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => {
      const el = $(id); if(el) el.classList.add("hidden");
    });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  // fc-mp / fc-solo:對局中才把棋盤放寬(大廳與選單維持 .panel 原本的 520)
  document.body.classList.toggle("fc-mp", which === "play");
  document.body.classList.toggle("fc-solo", which === "solo");
  /* 對局中鈕該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**。 */
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("fcSoloBar");
  else undockTools();
  /* 大棋盤:每次換畫面都**無條件**重套一次(見 ui-kit 的 BigMode)。
     ⚠ 守衛在 BigMode 自己,這裡不要再判斷一次 which;⚠ 一定要排在 dockTools() 之後。 */
  BigMode.sync();
  // ★ 盤面尺寸靠 JS 算 → 換到有棋盤的畫面時要重量一次(剛才它還是 hidden,量不到)
  if(which === "play" || which === "solo") setTimeout(() => FCB.fitBoard(), 0);
  if(which === "home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數 / 架數。 */
function showHomeLayer(which){
  const pick = $("fcPickMode"), solo = $("fcPickSolo"), head = $("fcHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();   // 第二層按返回要退回第一層,不是離開這一頁
}
/* 第二層的說明:難度文案直接讀 FCAI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el = $("fcSoloHint"); if(!el) return;
  const L = FCAI.levelOf(Solo.level());
  el.innerHTML = "<b>" + L.emoji + " " + L.name + "</b>:" + esc(L.desc) + "<br>" +
    "你固定是<b>第一家</b>,誰先擲由這一局隨機決定。每人 <b>" + Solo.planes() +
    " 架</b>,全部送回家的人贏。<br>" +
    '<span class="fc-warn">✈️ ' + esc(Solo.recLine(Solo.level())) + "</span>";
}
/* 選擇列共用的「點一下亮起來」 */
function segPick(id, attr, fn){
  const seg = $(id); if(!seg) return;
  seg.addEventListener("click", e => {
    const b = e.target.closest("button"); if(!b) return;
    fn(b.dataset[attr]);
    [...seg.children].forEach(x => x.classList.toggle("on", x === b));
    paintSoloHint();
  });
}
function syncSoloSeg(){
  const set = (id, attr, val) => {
    const seg = $(id); if(!seg) return;
    [...seg.children].forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(val)));
  };
  set("fcLvSeg", "lv", Solo.level());
  set("fcSeatSeg", "seats", Solo.seats());
  set("fcPlaneSeg", "planes", Solo.planes());
}

/* ---------- 盤面 ----------
   ★ 兩個回呼都要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(見 board.js 檔頭),
     漏掉分流的症狀是「單機點了沒反應」或「連線點了走到單機那條路」。 */
FCB.mount({
  onDice(){ if(Solo.active()) Solo.roll(); else MP.roll(); },
  onPlane(i, seat){
    // 點別人的飛機不做事(但也不要靜默 —— 講一句)
    if(Solo.active()) Solo.tapPlane(i);
    else MP.tapPlane(i);
    void seat;
  }
});

/* ---------- 進場選單 ---------- */
$("fcGoOnline").addEventListener("click", () => MP.openConnect());
$("fcGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("fcSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("fcLvSeg", "lv", v => Solo.setLevel(v));
segPick("fcSeatSeg", "seats", v => Solo.setSeats(+v));
segPick("fcPlaneSeg", "planes", v => Solo.setPlanes(+v));
$("fcStartSolo").addEventListener("click", () => Solo.start());

/* ---------- 單機的棋桌列 / 結果卡 ---------- */
$("fcSoloExit").addEventListener("click", () => Solo.quit());
$("fcSoloAgain").addEventListener("click", () => Solo.again());
$("fcSoloHome").addEventListener("click", () => Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("fcSecSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setTurnSec(+b.dataset.sec); });
$("fcPlanesSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setPlanes(+b.dataset.planes); });
$("fcLaunchSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setLaunch(b.dataset.launch); });
$("fcGoalSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setGoal(+b.dataset.goal); });
$("fcExactSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setExact(b.dataset.exact === "1"); });
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
// 賽後表情列:四顆一鍵送給全部人;😀 開完整面板。節流 600ms(結果卡是強制回應視窗,很容易連點)
let reactAt = 0;
$("fcReactRow").addEventListener("click", e => {
  const b = e.target.closest("button"); if(!b) return;
  if(b.id === "winEmoteBtn"){ openEmote("all"); return; }
  const em = b.dataset.em; if(!em) return;
  const now = performance.now();
  if(now - reactAt < 600) return;
  reactAt = now;
  markAudioArmed(); Sound.wake();
  MP.sendEmote("all", em);
  b.classList.remove("sent"); void b.offsetWidth; b.classList.add("sent");
});

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({ sub: "fcPickSolo" });
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整局丟掉)
initUpdateCheck(() => !MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大棋盤:⚠ 一定要排在 loadPrefs() **之前** —— 偏好會回頭叫 BigMode.set()。 */
BigMode.init({
  cls: "fc-big", btn: "fc-bigbtn", name: "大棋盤",
  live: () => { const el = $("fcPlay"); return !!el && !el.classList.contains("hidden"); },
  save: savePrefs
});
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 飛行棋的連線偏好
Solo.loadOwn();    // 單機的難度 / 人數 / 架數 / 戰績(獨立 key,不與連線那組互相覆蓋)
syncSettingsUI();
syncSoloSeg();
paintSoloHint();
showScreen("home");      // 進場先選玩法
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip, 1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

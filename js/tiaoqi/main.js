"use strict";

/* ============================================================================
   跳棋 — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 TQB、同一條動作列 #tqActs、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on / tq-mp 兩個 class 切換(與其他十二個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const TQ_SCREENS = ["tqHome", "tqSetup", "tqSoloBar", "tqPlay"];
function showScreen(which){
  const on = {
    home:    ["tqHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["tqSetup"],
    play:    ["tqPlay"],                // 連線對戰中
    solo:    ["tqSoloBar", "tqPlay"]    // 單機遊玩
  }[which] || [];
  TQ_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => {
      const el = $(id); if(el) el.classList.add("hidden");
    });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  // tq-mp / tq-solo:對局中才把棋盤放寬(大廳與選單維持 .panel 原本的 520)
  document.body.classList.toggle("tq-mp", which === "play");
  document.body.classList.toggle("tq-solo", which === "solo");
  /* 對局中鈕該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**。 */
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("tqSoloBar");
  else undockTools();
  /* 大棋盤:每次換畫面都**無條件**重套一次(見 ui-kit 的 BigMode)。
     ⚠ 守衛在 BigMode 自己,這裡不要再判斷一次 which;⚠ 一定要排在 dockTools() 之後。 */
  BigMode.sync();
  // ★ 盤面尺寸靠 JS 算 → 換到有棋盤的畫面時要重量一次(剛才它還是 hidden,量不到)
  if(which === "play" || which === "solo") setTimeout(() => TQB.fitBoard(), 0);
  if(which === "home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數 / 顆數。 */
function showHomeLayer(which){
  const pick = $("tqPickMode"), solo = $("tqPickSolo"), head = $("tqHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();   // 第二層按返回要退回第一層,不是離開這一頁
}
/* 第二層的說明:難度文案直接讀 TQAI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el = $("tqSoloHint"); if(!el) return;
  const L = TQAI.levelOf(Solo.level());
  el.innerHTML = "<b>" + L.emoji + " " + L.name + "</b>:" + esc(L.desc) + "<br>" +
    "你固定是<b>第一家</b>,誰先走由這一局隨機決定。每人 <b>" + Solo.pieces() +
    " 顆</b>,先全部搬到對面那個角的人贏。<br>" +
    /* ★ 指回上一層的玩法說明 —— 直接點「單機遊玩」進來的人會跳過那一整段,
       而跳棋「不會玩」的比例很高(跳與連跳沒玩過完全猜不到)。 */
    "<b>不熟規則?</b>按左上角 ‹ 回上一層,那裡有完整的玩法說明(走 / 跳 / 連跳)。<br>" +
    '<span class="tq-warn">⬢ ' + esc(Solo.recLine(Solo.level())) + "</span>";
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
  set("tqLvSeg", "lv", Solo.level());
  set("tqSeatSeg", "seats", Solo.seats());
  set("tqPieceSoloSeg", "pieces", Solo.pieces());
}

/* ---------- 盤面 ----------
   ★ 兩個回呼都要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(見 board.js 檔頭),
     漏掉分流的症狀是「單機點了沒反應」或「連線點了走到單機那條路」。 */
TQB.mount({
  onPiece(seat, i){ if(Solo.active()) Solo.tapPiece(seat, i); else MP.tapPiece(seat, i); },
  onHole(id){ if(Solo.active()) Solo.tapHole(id); else MP.tapHole(id); }
});

/* ---------- 進場選單 ---------- */
$("tqGoOnline").addEventListener("click", () => MP.openConnect());
$("tqGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("tqSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("tqLvSeg", "lv", v => Solo.setLevel(v));
segPick("tqSeatSeg", "seats", v => Solo.setSeats(+v));
segPick("tqPieceSoloSeg", "pieces", v => Solo.setPieces(+v));
$("tqStartSolo").addEventListener("click", () => Solo.start());

/* ---------- 單機的棋桌列 / 結果卡 ---------- */
$("tqSoloExit").addEventListener("click", () => Solo.quit());
$("tqSoloAgain").addEventListener("click", () => Solo.again());
$("tqSoloHome").addEventListener("click", () => Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("tqSecSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setTurnSec(+b.dataset.sec); });
$("tqPieceSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setPieces(+b.dataset.pieces); });
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
$("tqReactRow").addEventListener("click", e => {
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
bindPageBack({ sub: "tqPickSolo" });
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
  cls: "tq-big", btn: "tq-bigbtn", name: "大棋盤",
  live: () => { const el = $("tqPlay"); return !!el && !el.classList.contains("hidden"); },
  save: savePrefs
});
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 跳棋的連線偏好
Solo.loadOwn();    // 單機的難度 / 人數 / 顆數 / 戰績(獨立 key,不與連線那組互相覆蓋)
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

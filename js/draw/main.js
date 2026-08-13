"use strict";

/* ============================================================================
   你畫我猜 — 畫面切換、事件綁定與啟動(必須最後載入)

   ★ 這一頁**只有連線**(見 draw.html 那段註解),所以:
     · 沒有 body.solo-on 這一條路,showScreen() 少一個 "solo"
     · ★★★ v1.155.3 起連**進場選單那一層都沒有** —— 連線畫面就是第一層
       (原本 #dwHome 只有一顆「🌐 連線對戰」,按下去必定走同一條路)。
       所以 showScreen() 少一個 "home",而 bindPageBack() 要給 `noHome:true`。
     · initUpdateCheck() 的「安全」只問「在不在房裡」
   ========================================================================== */

/* ---------- 畫面切換 ----------
   mpConnect / mpBar / scrollArea / primaryBar 由 mp-core 控制,這裡只管自己的區塊。 */
const DW_SCREENS = ["dwPlay", "dwSetup"];
function showScreen(which) {
  const on = {
    connect: [],                       // 連線畫面本體由 mp-core 顯示(它就是第一層)
    lobby:   ["dwSetup"],
    play:    ["dwPlay"]
  }[which] || [];
  DW_SCREENS.forEach(id => { const el = $(id); if (el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  /* ⚠⚠ 這一頁**刻意不 dockTools()**(v1.155.2)—— 另外五頁在收掉頂列時會把 `⛶`/`⚙️`
     搬進房間框,這一頁不要:房間框那一列已經有返回鍵 + 房名 + 規則 + 🎤 + 😀,
     再塞兩顆進去會直接壓在 😀 上面(共用的 .tools-docked 是 absolute 貼右緣,
     壓過去也不會把別人擠開)。使用者:「我不要把他們放進房間框,這樣 emoji 會很難按」。
     → 於是頂列被收掉時那兩顆鈕就跟著不見,而那正是要的:收頂列只發生在**放大模式**,
       放大就是「只想看畫布」;要按設定就再按一次縮小。 */
  undockTools();
  /* ★★★ 放大狀態**每次換畫面都要重套一次**(v1.161.0)。這一行同時做兩件事:
       ① 進對局時把偏好記住的放大套回來(loadPrefs 那一刻套不得,見 adapter 的 usePrefs)
       ② 離開對局時把 `body.dw-big` 脫掉 —— 那個 class 會收掉頂列(遊戲名稱 + ⛶ + ⚙️),
          而放大鈕只住在對局畫面裡,留著就再也關不回來(完整說明在 js/draw/board.js 的 setZoom)。
     ⚠ 真正的守衛在 setZoom() 裡(它自己會看對局畫面在不在),所以這裡無條件傳現在的偏好值就對。 */
  DWB.setZoom(MP.zoom());
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
/* ⚠ #mpConnBack v1.155.3 起是 <a href="index.html">(回主選單)—— 這一頁沒有進場選單
   那一層,連線畫面就是第一層。點擊交給 ui-kit 的 bindHomeLinks() 接管(不疊歷史),
   這裡**刻意不綁 click**:綁了就會蓋掉那條「回主選單不疊歷史」的路。 */
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
/* ★ 「先看看畫板 👀」要在同一個 tick 內把畫布重量一次(v1.156.0)——
   共用的 peekBoard() 只切 body.peeking,而那個 class 給 body 加了 66px 的 padding-bottom
   → 舞台矮 66px、畫布沒跟著縮 → 圖上下各被削掉 33px(這一頁那顆鈕唯一的用途就是
   「打完回頭看最後那張圖」,削掉的正是重點)。切 class 之後讀 rect 會強制同步 layout,
   量到的就是新值,順序對就夠、不必等 rAF。⚠ 兜底那一半(RO)在 js/draw/board.js 的 init()。 */
$("winPeek").addEventListener("click", () => { peekBoard(); DWB.fit(); });
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
/* ★ noHome:連線畫面就是第一層(這一頁沒有進場選單)。少了它,pageLayer() 會判成
   "connect" → 守衛武裝著 → 按返回跑去 showScreen("home"),而那一層已經不存在。 */
bindPageBack({ noHome: true });
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
MP.openConnect();     // ★ 開頁直接進連線畫面(這一頁沒有進場選單那一層)
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip, 1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

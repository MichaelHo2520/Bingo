"use strict";

/* ============================================================================
   方塊對戰 — 畫面切換、事件綁定與啟動(必須最後載入)

   ★ 相位一律走 showScreen(),不要在 solo.js / adapter.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。

   ⚠ **P1 階段沒有 adapter.js** —— 所有 MP 綁定一律 `typeof MP !== "undefined"` 包起來
     (同 ui-kit 對 Talk / RoomShare / Feedback 的做法)。P3 把 adapter.js 放進來之後,
     這一支不必改就會自己亮起來。
   ========================================================================== */

const BLK_SCREENS = ["blkHome", "blkSetup", "blkSoloBar", "blkPlay"];
/* 上一次是哪一個畫面 —— 只為了分辨「剛剛**進入**對局」與「已經在對局裡了」(見下面的大畫面)。 */
let blkLastScreen = "";
function showScreen(which){
  /* ★ 開局自動進「大」(v2.14.0):對局中周邊 UI 沒有一樣是要看的,而這一頁的盤面
     大小直接等於「看不看得清楚」。⚠ 只在**剛進對局**時做,不可以每次 showScreen
     都做 —— 那會把使用者在這一局裡按的「小」硬是扳回去。
     ⚠ 走 BigMode.set() 不走 savePrefs:存的是「意願」,自動開的這一次不該寫進偏好。 */
  const entering = (which !== blkLastScreen) && (which === "play" || which === "solo");
  blkLastScreen = which;
  const on = {
    home:    ["blkHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["blkSetup"],
    play:    ["blkPlay"],               // 連線對戰中
    solo:    ["blkSoloBar", "blkPlay"]  // 單機
  }[which] || [];
  BLK_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => {
      const el = $(id); if(el) el.classList.add("hidden");
    });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  document.body.classList.toggle("blk-mp", which === "play");
  document.body.classList.toggle("blk-solo", which === "solo");
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("blkSoloBar");
  else undockTools();
  if(entering) BigMode.set(true);      // set() 內部就會 apply,等同 sync
  else BigMode.sync();
  /* ★ 盤面尺寸靠 JS 算 → 換到有盤面的畫面時要重量一次(剛才它還是 hidden,量不到)。
     ⚠ 兩次:一次立刻、一次下一幀 —— 版面在同一輪裡還沒穩定下來(控制列的高度會變)。 */
  /* ★ rAF 只在對局畫面開著的時候跑(BLKB.wake / sleep)——
     它從 mount() 起是無條件自遞迴的,在選單與大廳也照樣每秒畫六十次一塊看不見的
     canvas。⚠ 判斷只能用「哪一個畫面」,不可以用 running:觀戰者永遠不 play()。 */
  if(which === "play" || which === "solo"){
    BLKB.wake();
    setTimeout(() => BLKB.fitBoard(), 0);
    requestAnimationFrame(() => BLKB.fitBoard());
  }else BLKB.sleep();
  if(which === "home") showHomeLayer("pick");
  syncPageBack();
}

/* ---------- 手勢說明(單一真相)----------
   ★ 進場頁那一張(#blkGestCard)與房間框「?」打開的蓋板(#blkGuideBody)印的是**同一份** ——
     寫死兩份 HTML 就是遲早會分岔的雙胞胎(而說明與實際操作對不上比沒有說明更糟)。
   ⚠ 圖示一律自繪 SVG,不用 emoji:U+2194 那一段的箭頭在桌機 Chrome / Edge 上會退回
     線條字形、在手機上又是另一個樣子(紅線 8 的另一面),而且彩色 emoji 不吃 color。 */
const BLK_GEST = [
  ['<circle cx="12" cy="12" r="3.2"/><path d="M5.6 12H2.4m3.2-2.6L2.6 12l3 2.6M18.4 12h3.2m-3.2-2.6L21.4 12l-3 2.6"/>',
   "左右拖", "移動"],
  ['<circle cx="12" cy="7" r="3"/><path d="M12 12.4v7.2m-3.2-3.2l3.2 3.2 3.2-3.2"/>',
   "往下拖", "慢慢降"],
  ['<circle cx="12" cy="12" r="3"/><path d="M6.6 6.6a7.6 7.6 0 000 10.8M17.4 6.6a7.6 7.6 0 010 10.8"/>',
   "點一下", "順時針轉"],
  ['<circle cx="12" cy="17" r="3"/><path d="M12 11.6V4.4m-3.2 3.2L12 4.4l3.2 3.2"/>',
   "往上滑", "直接落地"],
  ['<circle cx="7.6" cy="12" r="3"/><circle cx="16.4" cy="12" r="3"/>',
   "兩指點一下", "逆時針轉"]
];
function blkGestHtml(){
  const cells = BLK_GEST.map(g =>
    '<div class="blk-gest-it">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        g[0] + '</svg>' +
      '<span>' + g[1] + '<b>' + g[2] + '</b></span>' +
    '</div>').join("");
  return '<div class="blk-gest-head">手指在畫面上<b>任何地方</b>都可以 —— 不必壓在盤面上</div>' +
         '<div class="blk-gest-grid">' + cells + '</div>' +
         '<div class="blk-gest-kb">電腦鍵盤:方向鍵移動 · <b>空白鍵</b>直接落地 · ' +
         '<b>↑ / X</b> 順轉 · <b>Z</b> 逆轉</div>';
}
function paintGestCards(){
  const html = blkGestHtml();
  ["blkGestCard", "blkGuideBody"].forEach(id => { const el = $(id); if(el) el.innerHTML = html; });
}
/* 說明蓋板。⚠ 單機時它開著方塊要停住(BLK_VEILS 有登記),而**連線刻意不停**
   —— 別人還在玩,自己看說明不能讓全場等你(同設定蓋板那一條)。 */
function openBlkGuide(){ syncCtrlSeg(); const el = $("blkGuideVeil"); if(el) el.classList.add("show"); }
function closeBlkGuide(){ const el = $("blkGuideVeil"); if(el) el.classList.remove("show"); }

/* ---------- 進場選單的兩層 ---------- */
function showHomeLayer(which){
  const pick = $("blkPickMode"), solo = $("blkPickSolo"), head = $("blkHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();
}
function paintSoloHint(){
  const el = $("blkSoloHint"); if(!el) return;
  syncSoloSeg();
  const r = Solo.rec();
  const lv = BLKAI.levelOf(Solo.level());
  const body = (Solo.mode() === "sprint")
    ? ("<b>" + Solo.SPRINT_LINES + " 行競速</b>:消滿 " + Solo.SPRINT_LINES + " 行,比誰快。" +
       (r.sprint ? "你最快 <b>" + (r.sprint / 1000).toFixed(1) + " 秒</b>。" : "還沒有紀錄。"))
    : (Solo.mode() === "vs")
      ? ("<b>對電腦</b>:互相送垃圾行,先堆爆的輸。" +
         "<b>" + lv.emoji + " " + lv.name + "</b>:" + esc(lv.desc) + "<br>" +
         ((r.win + r.lose) ? ("你目前 <b>" + r.win + " 勝 " + r.lose + " 敗</b>。") : "還沒有交手紀錄。"))
      : ("<b>練習(無盡)</b>:一路堆到爆為止,重力每 30 秒快一階。" +
         (r.best ? "你最高 <b>" + r.best + " 行</b>。" : "還沒有紀錄。"));
  el.innerHTML = body + "<br>" +
    "操作預設是<b>手勢</b>(上一層有圖解;對局中按房間框的「<b>?</b>」也看得到)。<br>" +
    '<span class="blk-warn">◆ 手感不順就調下面那排「移動速度」—— 那是這個遊戲最該先調的東西。</span>';
}
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
  set("blkModeSeg", "mode", Solo.mode());
  set("blkFeelSeg", "feel", Solo.feel());
  set("blkPadSeg", "pad", Solo.pad());
  set("blkLvSeg", "lv", Solo.level());
  syncCtrlSeg();
  /* 電腦強度只有「對電腦」用得到 → 其他玩法收起來(留著只會讓人以為練習也有電腦) */
  const lvRow = $("blkLvRow");
  if(lvRow) lvRow.classList.toggle("hidden", Solo.mode() !== "vs");
}
/* 操作方式有**兩個**入口:單機設定頁一個、說明蓋板一個(連線那條路只有後者 ——
   它是連線玩家唯一能改操作方式的地方)。⚠ 兩邊都要跟著同一個值走。
   ⚠ 「按鈕位置」只有按鈕會出現時才有意義 → 純手勢時整格收起來。 */
function syncCtrlSeg(){
  const v = Solo.ctrl();
  ["blkCtrlSeg", "blkCtrlSeg2"].forEach(id => {
    const seg = $(id); if(!seg) return;
    [...seg.children].forEach(b => b.classList.toggle("on", String(b.dataset.ctrl) === String(v)));
  });
  const padRow = $("blkPadRow");
  if(padRow) padRow.classList.toggle("hidden", v === "swipe");
}

/* 蓋板(設定 / 表情 / 自訂語音 / 問題回報 / 房間分享)開著的時候,單機不要繼續掉方塊。
   ⚠ 另外十四頁是回合制,蓋板開著頂多是「輪到你但你沒動」;**這一頁是即時的** ——
     不擋的話就是「你去調個音量,回來人就沒了」(實測:設定蓋板開著的 3 秒內盤面一直在變)。
   ★ 判斷用 `.show` —— 十五頁的蓋板統一靠這個 class 開關(見 ui-kit 的 BACK_LAYERS)。
   ★ **不必另外做「恢復」**:canPlay() 一回 false 規則層就不再 tick,
     而計時讀的是 st.time(solo.js 的 ms())→ 蓋板那幾秒天然不算,關掉就原地接上。
   ⚠ 結果卡(#veil)刻意不列 —— 它出現時 ended 已經是 true,遊戲早就停了。
   ⚠⚠ **連線刻意不吃這一條** —— 別人還在玩,自己開設定不能讓全場等你。 */
const BLK_VEILS = ["setVeil", "fbVeil", "emoteVeil", "myVoiceVeil", "qrVeil", "blkGuideVeil"];
function blkVeilOpen(){
  for(let i = 0; i < BLK_VEILS.length; i++){
    const el = $(BLK_VEILS[i]);
    if(el && el.classList.contains("show")) return true;
  }
  return false;
}

/* ---------- 盤面 ----------
   ★ 規則事件要分流到單機 / 連線。盤面自己不知道在哪一種模式(見 board.js 檔頭)。 */
BLKB.mount({
  onEvents(evs, st){
    if(Solo.active()) Solo.onEvents(evs, st);
    else if(typeof MP !== "undefined") MP.onEvents(evs, st);
  },
  canPlay(){
    if(Solo.active()) return !Solo.paused() && !blkVeilOpen();
    return (typeof MP !== "undefined") ? MP.canPlay() : false;
  },
  /* 每一幀的鉤子:單機對電腦在這裡推進電腦那一份狀態 */
  onFrame(dt){
    if(Solo.active()) Solo.onFrame(dt);
    else if(typeof MP !== "undefined" && MP.onFrame) MP.onFrame(dt);
  }
});

/* ---------- 進場選單 ---------- */
$("blkGoOnline").addEventListener("click", () => {
  if(typeof MP !== "undefined") MP.openConnect();
  else showToast("連線對戰還在施工中 —— 先玩單機 🙂");
});
$("blkGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("blkSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("blkModeSeg", "mode", v => Solo.setMode(v));
segPick("blkFeelSeg", "feel", v => Solo.setFeel(+v));
segPick("blkCtrlSeg", "ctrl", v => Solo.setCtrl(v));
/* 說明蓋板裡那一份(連線玩家唯一的入口)。⚠ 它不在單機設定頁裡 → 不可以走 segPick
   (那支做完會叫 paintSoloHint,而連線時那一段 DOM 根本沒顯示) */
$("blkCtrlSeg2").addEventListener("click", e => {
  const b = e.target.closest("button"); if(!b) return;
  Solo.setCtrl(b.dataset.ctrl);
  syncCtrlSeg();
});
$("blkHelpBtn").addEventListener("click", openBlkGuide);
$("blkSoloHelpBtn").addEventListener("click", openBlkGuide);
$("blkGuideClose").addEventListener("click", closeBlkGuide);
$("blkGuideVeil").addEventListener("click", e => { if(e.target === $("blkGuideVeil")) closeBlkGuide(); });
segPick("blkPadSeg", "pad", v => Solo.setPad(v));
segPick("blkLvSeg", "lv", v => Solo.setLevel(v));
$("blkStartSolo").addEventListener("click", () => Solo.start());

/* ---------- 單機的列 / 結果卡 ---------- */
$("blkSoloExit").addEventListener("click", () => Solo.quit());
$("blkSoloAgain").addEventListener("click", () => Solo.again());
$("blkSoloHome").addEventListener("click", () => Solo.quit());
$("blkPauseBtn").addEventListener("click", () => Solo.togglePause());
$("winPeek").addEventListener("click", peekBoard);
$("reopenWin").addEventListener("click", showResult);

/* ---------- 連線 ----------
   ⚠ 一律 `typeof MP !== "undefined"` 包起來(同 ui-kit 對 Talk / RoomShare 的做法)——
     將來若把 adapter 拿掉,這一支不會整頁 ReferenceError。 */
(function bindMP(){
  if(typeof MP === "undefined") return;
  /* 房規 */
  $("blkModeSegMp").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setMode(b.dataset.mode); });
  $("blkSecsSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setSecs(b.dataset.secs); });
  $("blkShieldSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setShield(b.dataset.shield); });
  $("blkHcapSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setHcap(+b.dataset.hcap); });
  $("scoreSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setScoreMode(b.dataset.score); });
  $("wgMinus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() - 1));
  $("wgPlus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() + 1));
  $("resetScoreBtn").addEventListener("click", () => MP.resetScores());
  /* 點對手的小盤 = 鎖定 / 取消鎖定攻擊目標。
     ⚠ 小盤的 DOM 是 board.js 執行期建的 → 只能用事件委派掛在容器上。 */
  $("blkFoes").addEventListener("click", e => {
    const i = BLKB.foeAt(e.target);
    if(i >= 0) MP.tapFoe(i);
  });
  $("mpNewSeason").addEventListener("click", () => { MP.resetScores(); MP.again(); });
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
  $("mpAgain").addEventListener("click", () => MP.again());
  $("mpLeaveWin").addEventListener("click", () => MP.askLeave());
})();

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({ sub: "blkPickSolo" });
bindAudioLifecycle();
registerSW();
paintVersion();
initUpdateCheck(() => !Solo.playing() && (typeof MP === "undefined" || !MP.isOnline()));
initFullscreenKeep();

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大畫面:⚠ 一定要排在 loadPrefs() **之前** —— 偏好會回頭叫 BigMode.set()。
   ⚠ 名字用「大 / 小」,不准沾「全螢幕」(那是 ⛶ 那一顆的事)。 */
BigMode.init({
  cls: "blk-big", btn: "blk-bigbtn", name: "大畫面",
  live: () => { const el = $("blkPlay"); return !!el && !el.classList.contains("hidden"); },
  save: savePrefs,
  /* 盤面是 JS 量出來的 → 切大 / 小之後一定要重量一次 */
  after: () => BLKB.fitBoard()
});
loadPrefs();
Solo.loadOwn();
syncSettingsUI();
paintGestCards();
syncSoloSeg();
Solo.paintBar();
paintSoloHint();
showScreen("home");
setTimeout(maybeShowInstallTip, 1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

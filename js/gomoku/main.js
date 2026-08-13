"use strict";

/* ============================================================================
   五子棋 — 畫面切換、事件綁定與啟動(必須最後載入)
   設定蓋板 / 表情面板 / 音訊解鎖 / SW 註冊那些兩個遊戲一字不差的綁定,
   已收進 js/shared/ui-kit.js 的 bindCommonUI() / bindAudioLifecycle() / registerSW()。
   ========================================================================== */

/* ---------- 畫面切換 ----------
   mpConnect / mpBar / scrollArea / primaryBar 由 mp-core 控制,這裡只管五子棋自己的區塊。
   (與數獨 js/sudoku/main.js 的 showScreen 同一個模式) */
const GMK_SCREENS=["gmkHome","gmkSoloBar","gmkSetup","gmkStage"];
function showScreen(which){
  const on={
    home:    ["gmkHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["gmkSetup"],
    play:    ["gmkStage"],              // 連線對戰中
    solo:    ["gmkSoloBar","gmkStage"]  // 電腦對決
  }[which] || [];
  GMK_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  // 離開連線的畫面(回選單 / 進電腦對決)時,把連線那幾塊一起收乾淨
  if(which==="home"||which==="solo"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which==="solo");
  // 對局中把頂列的 ⛶ / ⚙️ 收進那條列 —— 手機玩的時候頂列整條被收掉讓給棋盤,
  // 鈕住在裡面就會跟著消失(回報「開始對戰後全螢幕的按鈕不見了」)。見 ui-kit 的 dockTools。
  // ★ v1.75.10 起由 dockTools 自己判斷頂列在不在:桌機(媒體查詢不命中)不搬。
  if(which==="play") dockTools("mpBar");
  else if(which==="solo") dockTools("gmkSoloBar");
  else undockTools();
  if(which==="home") showHomeLayer("pick");   // 回選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑電腦對決的難度。與數獨 #sdkPickMode/#sdkPickLevel 同一個模式。
   回 index.html 的返回列只在第一層顯示:第二層有自己的返回,兩顆並存會分不清誰是誰。 */
function showHomeLayer(which){
  const pick=$("gmkPickMode"), lvl=$("gmkPickLevel"), head=$("gmkHomeHead");
  if(pick) pick.classList.toggle("hidden", which!=="pick");
  if(lvl)  lvl.classList.toggle("hidden", which!=="solo");
  if(head) head.classList.toggle("hidden", which!=="pick");
  syncPageBack();   // 同上:第二層按返回要退回第一層,不是離開這一頁
}
// 難度說明:直接讀 GAI 的難度表,不另外硬編一份文案;戰績另起一行 —— 接在同一行後面,
// 窄螢幕會斷在「戰／績」中間(這是截圖才看得出來的)
// 朋友模式沒有難度可講,改講怎麼玩(輪流點同一支手機)+ 這一節的黑白戰績。
function paintAiHint(){
  const el=$("gmkAiHint"); if(!el)return;
  if(Solo.opponent()==="friend"){
    el.innerHTML="👤 跟旁邊的朋友輪流點同一支手機,黑棋先下。<br>"+esc(Solo.friendRecText());
    return;
  }
  const lv=GAI.levelOf(Solo.level());
  el.innerHTML=esc(lv.emoji+" "+lv.name+":"+lv.desc)+"<br>"+esc(Solo.recLine(lv.key));
}
// 對手欄位切換:電腦 ↔ 朋友時,難度與先手兩塊只有電腦對決用得到,收起來給朋友模式的說明騰空間
function syncOppFields(){
  const friend = Solo.opponent()==="friend";
  const aiField=$("gmkAiField"), firstField=$("gmkFirstField"), sub=$("gmkLevelSubtitle");
  if(aiField) aiField.classList.toggle("hidden", friend);
  if(firstField) firstField.classList.toggle("hidden", friend);
  if(sub) sub.textContent = friend ? "本機對戰 · 朋友" : "本機對戰 · 選難度";
}
// 膠囊列高亮(三個 seg 共用):資料屬性的值對得上就亮
function segOn(segId, key, val){
  const seg=$(segId); if(!seg)return;
  [...seg.children].forEach(b=>b.classList.toggle("on", b.dataset[key]===String(val)));
}

/* ---------- 棋盤 ---------- */
// 能不能下由 Solo.tap() / MP.tap() 各自判定並給回饋(不用 disabled 靜默吃掉點擊)
GB.onTap(i=>{ if(Solo.active()) Solo.tap(i); else MP.tap(i); });
$("gmkZoomIn").addEventListener("click",()=>GB.zoomIn());
$("gmkZoomOut").addEventListener("click",()=>GB.zoomOut());
$("gmkZoomFit").addEventListener("click",()=>GB.fit());

/* ---------- 進場選單 ---------- */
$("gmkGoOnline").addEventListener("click",()=>MP.openConnect());
$("gmkPickSolo").addEventListener("click",()=>{ syncOppFields(); paintAiHint(); showHomeLayer("solo"); });
$("gmkLevelBack").addEventListener("click",()=>showHomeLayer("pick"));
$("gmkOppSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  Solo.setOpponent(b.dataset.opp); segOn("gmkOppSeg","opp",Solo.opponent()); syncOppFields(); paintAiHint();
});
$("gmkAiSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  Solo.setLevel(b.dataset.ai); segOn("gmkAiSeg","ai",Solo.level()); paintAiHint();
});
$("gmkSoloSizeSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  Solo.setSize(+b.dataset.size); segOn("gmkSoloSizeSeg","size",Solo.size());
});
$("gmkFirstSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  Solo.setFirst(b.dataset.first); segOn("gmkFirstSeg","first",Solo.first());
});
$("gmkStartSolo").addEventListener("click",()=>Solo.start());

/* ---------- 電腦對決的 HUD ---------- */
$("gmkSoloBack").addEventListener("click",()=>Solo.quit());
$("gmkUndoBtn").addEventListener("click",()=>Solo.undo());
$("gmkRestartBtn").addEventListener("click",()=>Solo.again());
$("soloAgain").addEventListener("click",()=>Solo.again());
$("soloHome").addEventListener("click",()=>Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("gmkSizeSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setBoardSize(+b.dataset.size); });
$("gmkSwapSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setSwapFirst(b.dataset.swap==="1"); });
$("scoreSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()-1));
$("wgPlus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()+1));
$("resetScoreBtn").addEventListener("click",()=>MP.resetScores());

/* ---------- 連線 / 房間 ---------- */
$("mpCreate").addEventListener("click",()=>MP.create($("mpName").value,$("mpRoomName").value));
$("mpScan").addEventListener("click",()=>MP.scanRooms());
$("mpName").addEventListener("change",savePrefs);
$("mpName").addEventListener("input",()=>$("mpName").classList.remove("needs-name"));
$("mpRoomName").addEventListener("keydown",e=>{ if(e.key==="Enter")MP.create($("mpName").value,$("mpRoomName").value); });
$("mpReadyBtn").addEventListener("click",()=>MP.toggleReady());
$("mpLeaveBtn").addEventListener("click",()=>MP.askLeave());
$("mpConnBack").addEventListener("click",()=>showScreen("home"));
$("leaveConfirm").addEventListener("click",()=>MP.confirmLeave());
$("leaveCancel").addEventListener("click",()=>MP.cancelLeave());
$("leaveVeil").addEventListener("click",e=>{ if(e.target===$("leaveVeil"))MP.cancelLeave(); });
$("kickConfirm").addEventListener("click",()=>MP.confirmKick());
$("kickCancel").addEventListener("click",()=>MP.cancelKick());
$("kickVeil").addEventListener("click",e=>{ if(e.target===$("kickVeil"))MP.cancelKick(); });

/* ---------- 認輸 ---------- */
$("resignBtn").addEventListener("click",()=>MP.askResign());
$("resignConfirm").addEventListener("click",()=>MP.confirmResign());
$("resignCancel").addEventListener("click",()=>MP.cancelResign());
$("resignVeil").addEventListener("click",e=>{ if(e.target===$("resignVeil"))MP.cancelResign(); });

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click",()=>MP.again());
$("mpLeaveWin").addEventListener("click",()=>MP.askLeave());
$("mpNewSeason").addEventListener("click",()=>{ MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click",peekBoard);
$("reopenWin").addEventListener("click",showResult);
// 賽後表情列:四顆一鍵送給全部人(結果卡不關,對方也看得到飛出來的表情),😀 開完整面板。
// 節流 600ms:結果卡是強制回應視窗,手指停在上面很容易連點狂送。
let reactAt=0;
$("gmkReactRow").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  if(b.id==="winEmoteBtn"){ openEmote("all"); return; }
  const em=b.dataset.em; if(!em)return;
  const now=performance.now();
  if(now-reactAt<600)return;
  reactAt=now;
  markAudioArmed(); Sound.wake();
  MP.sendEmote("all",em);
  b.classList.remove("sent"); void b.offsetWidth; b.classList.add("sent");
});

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({sub:"gmkPickLevel"});
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整盤棋丟掉)
initUpdateCheck(()=>!MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 五子棋的連線偏好
Solo.loadOwn();    // 電腦對決的難度 / 盤面 / 先手 / 戰績(獨立 key,不與連線那組互相覆蓋)
syncSettingsUI();
GB.init();         // 棋盤 DOM + 手勢(舞台此時是 hidden,ResizeObserver 會在顯示後算 fit)
segOn("gmkOppSeg","opp",Solo.opponent());
segOn("gmkAiSeg","ai",Solo.level());
segOn("gmkSoloSizeSeg","size",Solo.size());
segOn("gmkFirstSeg","first",Solo.first());
syncOppFields();
paintAiHint();
showScreen("home");   // 進場先選玩法(五子棋現在有連線也有電腦對決)
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip,1500);

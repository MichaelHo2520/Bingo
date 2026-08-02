"use strict";

/* ============================================================================
   麻將消牌 — 畫面切換、事件綁定與啟動(必須最後載入)
   單機與連線共用同一個盤面(MB)與結果卡,差別只在周邊 HUD 與結果卡的按鈕組,
   靠 body 的 solo-on / mp-on 兩個 class 切換(mp-on 由 mp-core 掛)。
   ========================================================================== */

/* ---------- 畫面切換 ----------
   ★ 相位一律走這支,不要在 adapter.js / solo.js 裡自己 toggle("hidden") ——
     有了選單 + 單機 + 連線三塊之後,一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   mpConnect / mpBar / scrollArea / primaryBar 由 mp-core 控制,這裡只管麻將自己的區塊。 */
const MJ_SCREENS=["mjHome","mjSoloBar","mjPlay","mjSetup"];
function showScreen(which){
  const on={
    home:    ["mjHome"],
    connect: [],                      // 連線畫面本體由 mp-core 顯示
    lobby:   ["mjSetup"],
    play:    ["mjPlay"],              // 連線對戰中
    solo:    ["mjSoloBar","mjPlay"]   // 單機
  }[which] || [];
  MJ_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which==="home"||which==="solo"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which==="solo");
  // 單機的工具列(悔棋/暫停)不該出現在連線;連線的重洗兩邊都要
  document.body.classList.toggle("mj-mp", which==="play");
  /* 對局中鈕該住哪(見 ui-kit 的 dockTools)。★ v1.75.10 起**只有頂列真的被收掉才搬** ——
     消消樂沒有「收頂列」的規則,所以實際上永遠不搬。舊版是「為了四頁一致」無條件搬,
     換來的是每一頁的房間框都被兩顆鈕擠掉 80px(使用者在排七回報)。
     這裡照舊告訴它「如果要搬,搬去哪」:哪天加了收頂列的規則就自動接上。 */
  if(which==="play") dockTools("mpBar");
  else if(which==="solo") dockTools("mjSoloBar");
  else undockTools();
  if(which==="home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  // 盤面大小綁容器高度:剛切過來時容器才剛拿到尺寸,補量一次
  if(which==="play"||which==="solo") setTimeout(()=>MB.fit(),0);
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑盤面大小。與數獨 #sdkHome 同一個模式。 */
function showHomeLayer(which){
  const pick=$("mjPickMode"), lvl=$("mjPickLevel"), head=$("mjHomeHead");
  if(pick) pick.classList.toggle("hidden", which!=="pick");
  if(lvl)  lvl.classList.toggle("hidden", which!=="level");
  if(head) head.classList.toggle("hidden", which!=="pick");
}
// 第二層的說明:直接讀 MGen 的難度表,不另外硬編一份文案
function paintLevelHint(){
  const el=$("mjLevelHint"); if(!el)return;
  const L=MGen.levelOf(Solo.level());
  el.textContent=L.label+" "+L.name+" · "+L.layers+" 層 · "+L.desc;
}

/* ---------- 盤面:點兩張成對的牌 ---------- */
MB.init({
  onPair(i,j){ if(Solo.running()) Solo.onPair(i,j); else MP.onPair(i,j); }
});

/* ---------- 進場選單 ---------- */
$("mjHomeDiffSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  Solo.setLevel(b.dataset.diff);
  [...$("mjHomeDiffSeg").children].forEach(x=>x.classList.toggle("on",x===b));
  paintLevelHint();
});
$("mjStartSolo").addEventListener("click",()=>Solo.start());
$("mjGoOnline").addEventListener("click",()=>MP.openConnect());
$("mjPickSolo").addEventListener("click",()=>{ paintLevelHint(); showHomeLayer("level"); });
$("mjLevelBack").addEventListener("click",()=>showHomeLayer("pick"));

/* ---------- 單機 HUD ---------- */
$("mjSoloBack").addEventListener("click",()=>Solo.quit());
$("mjPauseBtn").addEventListener("click",()=>Solo.togglePause());
$("mjPauseVeil").addEventListener("click",()=>Solo.togglePause());
$("mjUndoBtn").addEventListener("click",()=>Solo.undo());
$("soloAgain").addEventListener("click",()=>{ closeWin(); Solo.start(); });
$("soloHome").addEventListener("click",()=>Solo.quit());

/* 提示:連線沒有提示(那等於直接送分),所以提示鈕在連線時是隱藏的(CSS body.mj-mp)。
   重洗刻意沒有按鈕(v1.54.0):死局時單機走 Solo 的 deadEnd()、連線走 adapter 的 armAuto()。 */
$("mjHintBtn").addEventListener("click",()=>{ if(Solo.running()) Solo.hint(); });

/* ---------- 設定:同款高亮(麻將專屬) ----------
   ui-kit 的 syncSettingsUI() 是三個遊戲共用的,不把麻將專屬的列塞進去 —— 這顆自己綁、自己同步。
   真相存在 MB 裡,savePrefs() 會透過 MP.ownPrefs() 把它寫進 mahjong.prefs.v1。 */
function syncMjSame(){
  const b=$("mjSwSame"); if(b) b.setAttribute("aria-checked",MB.sameHint()?"true":"false");
}
$("mjSwSame").addEventListener("click",()=>{
  MB.setSameHint(!MB.sameHint());
  savePrefs(); syncMjSame();
  showToast(MB.sameHint()?"同款高亮:開":"同款高亮:關",1200);
});

/* 比分 HUD:點某個人的卡片 = 傳表情給他(對戰中名單列收起來了,這裡接手那個入口) */
$("mjHud").addEventListener("click",e=>{
  const c=e.target.closest(".mj-hcard"); if(!c)return;
  const id=c.dataset.id; if(!id)return;
  const me=(MP.roster().find(p=>p.me)||{}).id;
  openEmote(id===me ? "all" : id);      // 點自己的卡片 = 送給全部人(同玩家晶片的行為)
});

/* ---------- 連線大廳設定(房主可改) ---------- */
$("mjModeSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setMode(b.dataset.mode); });
$("mjDiffSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setDiff(b.dataset.diff); });
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

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click",()=>MP.again());
$("mpLeaveWin").addEventListener("click",()=>MP.askLeave());
$("mpNewSeason").addEventListener("click",()=>{ MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click",peekBoard);
$("reopenWin").addEventListener("click",showResult);
// 賽後表情列:四顆一鍵送給全部人(結果卡不關),😀 開完整面板。節流 600ms 防連點狂送。
let reactAt=0;
$("mjReactRow").addEventListener("click",e=>{
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
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(單機重載會把計時與消掉的牌全部丟掉)
initUpdateCheck(()=>!MP.isOnline() && !Solo.running());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();          // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 麻將的連線偏好 + 同款高亮
Solo.loadOwn();       // 單機盤面大小(獨立 key,不與連線的設定互相覆蓋)
syncSettingsUI();
syncMjSame();         // 麻將專屬那一列不在 syncSettingsUI() 裡,要自己補
[...$("mjHomeDiffSeg").children].forEach(b=>b.classList.toggle("on",b.dataset.diff===Solo.level()));
paintLevelHint();
showScreen("home");   // 進場先選玩法(麻將有單機也有連線)
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip,1500);

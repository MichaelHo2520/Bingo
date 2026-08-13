"use strict";

/* ============================================================================
   排七 — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 SVB、同一條動作列 #svActs、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on / sv-mp 兩個 class 切換(與其他四個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const SV_SCREENS = ["svHome", "svSetup", "svSoloBar", "svPlay"];
function showScreen(which){
  const on = {
    home:    ["svHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["svSetup"],
    play:    ["svPlay"],                // 連線對戰中
    solo:    ["svSoloBar", "svPlay"]    // 電腦對決
  }[which] || [];
  SV_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which==="home" || which==="solo"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which==="solo");
  // sv-mp / sv-solo:對局中才把牌桌放寬(大廳與選單維持 .panel 原本的 520,
  // 不然會變成「一塊寬一塊窄」)。同台灣麻將 v1.68.1。
  document.body.classList.toggle("sv-mp", which==="play");
  document.body.classList.toggle("sv-solo", which==="solo");
  /* 對局中鈕該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**。
     v1.75.10 之前是「對局中就搬」,而排七當時根本不收頂列 → 鈕從一條還好端端在畫面上的
     頂列被搬進房間框,把房名擠到要 ellipsis(使用者:「全螢幕跟設定的按鈕,不應該跑進
     房間框裡面」)。
     ★ v1.75.12 起排七**橫置手機時真的會收頂列**了(styles.css 的
       `(orientation:landscape) and (max-height:560px) and (pointer:coarse)`),
       所以這兩行從此是有作用的:橫置 → 鈕搬進房間框;直向 / 桌機 → 留在頂列。
       兩種情形都不必也不可以在這裡判斷,條件只准有一份(就在 dockTools 裡面)。 */
  if(which==="play") dockTools("mpBar");
  else if(which==="solo") dockTools("svSoloBar");
  else undockTools();
  if(which==="home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數。與台灣麻將 #m16Home 同一個模式。
   回 index.html 的返回列只在第一層顯示:第二層有自己的返回,兩顆並存會分不清誰是誰。 */
function showHomeLayer(which){
  const pick=$("svPickMode"), solo=$("svPickSolo"), head=$("svHomeHead");
  if(pick) pick.classList.toggle("hidden", which!=="pick");
  if(solo) solo.classList.toggle("hidden", which!=="solo");
  if(head) head.classList.toggle("hidden", which!=="pick");
  syncPageBack();   // 同上:第二層按返回要退回第一層,不是離開這一頁
}
/* 第二層的說明:難度文案直接讀 SVAI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el=$("svSoloHint"); if(!el) return;
  const L = SVAI.levelOf(Solo.level());
  const n = Solo.seats();
  const cnt = SV.dealCounts(n);
  const even = cnt[0] === cnt[n-1];
  el.innerHTML = "<b>"+L.emoji+" "+L.name+"</b>:"+esc(L.desc)+"<br>"+
    "一人 "+(even ? ("<b>"+cnt[0]+" 張</b>") : ("<b>"+cnt[0]+"</b> 或 <b>"+cnt[n-1]+"</b> 張(52 除不盡,前面的座位多一張)"))+
    " · 你固定坐第一位,先出的是拿到 ♠︎7 的人。<br>"+
    "<span class=\"sv-warn\">🎴 "+esc(Solo.recLine(Solo.level()))+"</span>";
}
/* 選擇列共用的「點一下亮起來」 */
function segPick(id, attr, fn){
  const seg = $(id); if(!seg) return;
  seg.addEventListener("click", e=>{
    const b = e.target.closest("button"); if(!b) return;
    fn(b.dataset[attr]);
    [...seg.children].forEach(x=>x.classList.toggle("on", x===b));
    paintSoloHint();
  });
}
function syncSoloSeg(){
  const set = (id, attr, val)=>{
    const seg=$(id); if(!seg) return;
    [...seg.children].forEach(b=>b.classList.toggle("on", String(b.dataset[attr])===String(val)));
  };
  set("svLvSeg","lv",Solo.level());
  set("svSeatSeg","seats",Solo.seats());
}

/* ---------- 盤面 ----------
   ★ 兩個回呼都要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(見 board.js 檔頭),
     漏掉分流的症狀是「單機點牌沒反應」或「連線點牌走到單機那條路」。 */
SVB.mount({
  onCard(c){ if(Solo.active()) Solo.tap(c); else MP.tap(c); },
  onAct(a){ if(Solo.active()) Solo.act(a); else MP.act(a); }
});

/* ---------- 進場選單 ---------- */
$("svGoOnline").addEventListener("click",()=>MP.openConnect());
$("svGoSolo").addEventListener("click",()=>{ paintSoloHint(); showHomeLayer("solo"); });
$("svSoloCfgBack").addEventListener("click",()=>showHomeLayer("pick"));
segPick("svLvSeg","lv",v=>Solo.setLevel(v));
segPick("svSeatSeg","seats",v=>Solo.setSeats(+v));
$("svStartSolo").addEventListener("click",()=>Solo.start());

/* ---------- 單機的牌桌列 / 結果卡 ---------- */
$("svSoloExit").addEventListener("click",()=>Solo.quit());
$("svSoloAgain").addEventListener("click",()=>Solo.again());
$("svSoloHome").addEventListener("click",()=>Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("svSecSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setTurnSec(+b.dataset.sec); });
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
// 賽後表情列:四顆一鍵送給全部人(結果卡不關,對方也看得到飛出來的表情),😀 開完整面板。
// 節流 600ms:結果卡是強制回應視窗,手指停在上面很容易連點狂送。
let reactAt=0;
$("svReactRow").addEventListener("click",e=>{
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
bindPageBack({sub:"svPickSolo"});
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整局丟掉)
initUpdateCheck(()=>!MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 排七的連線偏好
Solo.loadOwn();    // 電腦對決的難度 / 人數 / 戰績(獨立 key,不與連線那組互相覆蓋)
syncSettingsUI();
syncSoloSeg();
paintSoloHint();
showScreen("home");      // 進場先選玩法
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip,1500);

"use strict";

/* ============================================================================
   台灣 16 張麻將 — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 M16B、同一條動作列 #m16Acts、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on / m16-mp 兩個 class 切換(與五子棋 / 數獨 / 消消樂同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const M16_SCREENS = ["m16Home", "m16Setup", "m16SoloBar", "m16Play"];
function showScreen(which){
  const on = {
    home:    ["m16Home"],
    connect: [],                          // 連線畫面本體由 mp-core 顯示
    lobby:   ["m16Setup"],
    play:    ["m16Play"],                 // 連線對戰中
    solo:    ["m16SoloBar", "m16Play"]    // 單機
  }[which] || [];
  M16_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which==="home" || which==="solo"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which==="solo");
  /* 兩個 class 都要:m16-mp 是連線專屬(房間框的名單列要放出來),
     m16-solo 只負責把 .mj-play 放寬到 960(真麻將的桌面比消消樂需要更多橫向空間)。 */
  document.body.classList.toggle("m16-mp", which==="play");
  document.body.classList.toggle("m16-solo", which==="solo");
  if(which==="home") showHomeLayer("pick");    // 回主選單一律從「選玩法」開始
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數 / 局數。與消消樂 #mjHome 同一個模式。 */
function showHomeLayer(which){
  const pick=$("m16PickMode"), solo=$("m16PickSolo"), head=$("m16HomeHead");
  if(pick) pick.classList.toggle("hidden", which!=="pick");
  if(solo) solo.classList.toggle("hidden", which!=="solo");
  if(head) head.classList.toggle("hidden", which!=="pick");
}
/* 第二層的說明:難度文案直接讀 MJ16AI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el=$("m16SoloHint"); if(!el) return;
  const L = MJ16AI.levelOf(Solo.level());
  const n = Solo.seats();
  el.innerHTML = "<b>"+L.emoji+" "+L.name+"</b>:"+esc(L.desc)+"<br>"+
    (n===4 ? "4 家用整副 <b>144 張</b>" : (n+" 家<b>去掉萬子</b>(108 張)"+(n===3?",而且<b>不能吃</b>":"")))+
    " · 你固定坐第一家,莊家每局輪一位。<br>"+
    "<span class=\"m16-warn\">🀄 "+esc(Solo.recText(Solo.level()))+"</span>";
}
/* 三段選擇列共用的「點一下亮起來」 */
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
  set("m16LvSeg","lv",Solo.level());
  set("m16SeatSeg","seats",Solo.seats());
  set("m16SoloGoalSeg","goal",Solo.goal());
}

/* ---------- 盤面 ----------
   ★ 三個回呼都要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(理由見 board.js 檔頭),
     所以「現在誰在管這一局」只有這裡知道。 */
M16B.mount({
  hostId:"m16Stage",
  onDiscard(t){ if(Solo.active()) Solo.onDiscard(t); else MP.onDiscard(t); },
  // 宣告聽牌(v1.67.0):點的那一張同時是「打出去的牌」—— 一個動作,沒有中間狀態
  onTing(t){ if(Solo.active()) Solo.onTing(t); else MP.onTing(t); },
  // 宣告視窗:在牌上換了一組(吃三四 ↔ 吃四五)→ ✔ 按鈕上的字要跟著換
  onClaimUI(){ if(Solo.active()) Solo.refreshActs(); else MP.refreshActs(); },
  // 點對手那一列:連線是傳表情給他,單機沒有對象 → 報一下他是誰
  onFoe(seat){
    if(Solo.active()){ Solo.onFoe(seat); return; }
    const id = MP.seatId(seat);
    openEmote(id || "all");
  }
});
// 盤面只知道座位號,名字由外面餵(單機用電腦的名字、連線用暱稱)
M16B.setNames(seat=> Solo.active() ? Solo.seatName(seat) : MP.seatName(seat));

/* ---------- 進場選單 ---------- */
$("m16GoOnline").addEventListener("click",()=>MP.openConnect());
$("m16GoSolo").addEventListener("click",()=>{ syncSoloSeg(); paintSoloHint(); showHomeLayer("solo"); });
$("m16SoloCfgBack").addEventListener("click",()=>showHomeLayer("pick"));
segPick("m16LvSeg","lv",v=>Solo.setLevel(v));
segPick("m16SeatSeg","seats",v=>Solo.setSeats(v));
segPick("m16SoloGoalSeg","goal",v=>Solo.setGoal(v));
$("m16StartSolo").addEventListener("click",()=>{ markAudioArmed(); Sound.wake(); Solo.start(); });

/* ---------- 單機牌桌 ---------- */
$("m16SoloExit").addEventListener("click",()=>askSoloQuit());
$("m16SoloAgain").addEventListener("click",()=>Solo.again());
$("m16SoloHome").addEventListener("click",()=>Solo.quit());
/* 離開確認沿用連線那張卡(#leaveVeil)—— 一整場打到一半退出,值得問一句。
   ⚠ 三顆按鈕是共用的,所以要依「現在是不是單機」分流(見下面的共用綁定)。 */
function askSoloQuit(){
  const t=$("leaveTitle"), m=$("leaveMsg"), b=$("leaveConfirm");
  if(t) t.textContent = "離開牌桌?";
  if(m) m.innerHTML = "這一場還沒打完,離開就<b>不算這場的台數</b>。";
  if(b) b.textContent = "離開牌桌";
  $("leaveVeil").classList.add("show");
}
function closeSoloQuit(){ $("leaveVeil").classList.remove("show"); }

/* ---------- 大廳設定 ---------- */
$("m16GoalSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(b) MP.setGoal(b.dataset.goal);
});
$("m16SecSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(b) MP.setSec(b.dataset.sec);
});
$("scoreSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()-1));
$("wgPlus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()+1));
$("resetScoreBtn").addEventListener("click",()=>MP.resetScores());

/* ---------- 設定裡的「玩法輔助」整組已經拿掉(v1.68.0) ----------
   曾經有兩顆:
     · 聽牌提醒(v1.66.0):系統偵測到你聽牌就唸「聽牌」+ 列出聽哪幾張。
       v1.67.0 改成**玩家主動宣告聽牌**之後拿掉 —— 宣告是規則動作,照吃 / 碰 / 槓一樣不給開關。
     · 聽牌提示(v1.66.0~v1.67.2):每張手牌角落顯示「打掉它之後聽幾張」。
   兩顆都是**替玩家算牌**,而這一頁的賣點正是「真的打麻將」;算牌本來就是玩家自己的事。
   ⚠ 規則層的 `MJT.tenpaiAfter()` / `tenpaiNow()` 不可以跟著刪 —— 宣告聽牌要靠它們
     算「哪幾張打掉會聽牌」與驗證宣告資格。 */

/* ---------- 設定:喊牌語音(這一頁專屬,v1.62.0) ----------
   碰 / 吃 / 槓 / 胡 / 流局會用 zh-TW 語音唸出來(音檔在 mp3/m16-voice-*.wav)。
   ★ 打開的當下順手播一聲「碰」試聽 —— 這種開關看不出效果,不試聽的話使用者
     還要真的打到有人碰才知道有沒有生效(而且點開關本身就是手勢,順便解鎖音訊)。 */
function syncM16Voice(){
  const b=$("m16SwVoice"); if(b) b.setAttribute("aria-checked", M16Sfx.voiceOn()?"true":"false");
}
$("m16SwVoice").addEventListener("click",()=>{
  M16Sfx.setVoice(!M16Sfx.voiceOn());
  savePrefs(); syncM16Voice();
  const on = M16Sfx.voiceOn();
  if(on){ markAudioArmed(); Sound.wake(); M16Sfx.say("pong"); }
  showToast(on?"喊牌語音:開":"喊牌語音:關",1200);
});

/* (v1.58.2:比分列 #m16Hud 已移除 —— 台數改顯示在房間框的玩家晶片上,
    點晶片傳表情那個入口是核心 renderPlayers() 自己綁的,這裡不必再接一次) */

/* ---------- 連線 / 房間 ---------- */
$("mpCreate").addEventListener("click",()=>MP.create($("mpName").value,$("mpRoomName").value));
$("mpScan").addEventListener("click",()=>MP.scanRooms());
$("mpName").addEventListener("change",savePrefs);
$("mpName").addEventListener("input",()=>$("mpName").classList.remove("needs-name"));
$("mpRoomName").addEventListener("keydown",e=>{ if(e.key==="Enter")MP.create($("mpName").value,$("mpRoomName").value); });
$("mpReadyBtn").addEventListener("click",()=>MP.toggleReady());
$("mpLeaveBtn").addEventListener("click",()=>MP.askLeave());
$("mpConnBack").addEventListener("click",()=>showScreen("home"));
$("leaveConfirm").addEventListener("click",()=>{ if(Solo.active()){ closeSoloQuit(); Solo.quit(); } else MP.confirmLeave(); });
$("leaveCancel").addEventListener("click",()=>{ if(Solo.active()) closeSoloQuit(); else MP.cancelLeave(); });
$("leaveVeil").addEventListener("click",e=>{
  if(e.target!==$("leaveVeil")) return;
  if(Solo.active()) closeSoloQuit(); else MP.cancelLeave();
});
$("kickConfirm").addEventListener("click",()=>MP.confirmKick());
$("kickCancel").addEventListener("click",()=>MP.cancelKick());
$("kickVeil").addEventListener("click",e=>{ if(e.target===$("kickVeil"))MP.cancelKick(); });

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click",()=>MP.again());
$("mpLeaveWin").addEventListener("click",()=>MP.askLeave());
$("mpNewSeason").addEventListener("click",()=>{ MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click",peekBoard);
$("reopenWin").addEventListener("click",showResult);
let reactAt=0;
$("m16ReactRow").addEventListener("click",e=>{
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

/* ---------- 共用綁定 ---------- */
bindCommonUI();
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:連線中或單機打到一半都不要重載(重載會把整場丟掉)
initUpdateCheck(()=>!MP.isOnline() && !Solo.playing());
initFullscreenKeep();

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();
Solo.loadOwn();
syncSettingsUI();
syncM16Voice();      // ⚠ loadPrefs() 之後才同步(偏好裡的喊牌語音開關要先讀進來)
syncSoloSeg();
showScreen("home");
autoJoinFromQuery(MP);
setTimeout(maybeShowInstallTip,1500);

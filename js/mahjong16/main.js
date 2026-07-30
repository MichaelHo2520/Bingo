"use strict";

/* ============================================================================
   台灣 16 張麻將 — 畫面切換、事件綁定與啟動(必須最後載入)

   ⚠ 這一頁目前**只有連線對戰**(沒有 AI,所以湊不到人就打不起來)。
     單機的「聽牌練習 / 牌型圖鑑」排在 P6,`M16_SCREENS` 已經留好位置 ——
     加的時候比照消消樂:相位一律走 showScreen(),不要在別處自己 toggle("hidden")。
   ========================================================================== */

const M16_SCREENS = ["m16Home", "m16Setup", "m16Play"];
function showScreen(which){
  const on = {
    home:    ["m16Home"],
    connect: [],                 // 連線畫面本體由 mp-core 顯示
    lobby:   ["m16Setup"],
    play:    ["m16Play"]
  }[which] || [];
  M16_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  if(which==="home"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("m16-mp", which==="play");
}

/* ---------- 盤面 ---------- */
M16B.mount({
  hostId:"m16Stage",
  onDiscard(t){ MP.onDiscard(t); },
  // 點對手那一列 = 傳表情給他(對戰中玩家晶片列是收起來的,這裡接手那個入口)
  onFoe(seat){
    const id = MP.seatId(seat);
    openEmote(id || "all");
  }
});
// 盤面只知道座位號,名字走 adapter(核心沒把 order() 暴露到 MP 上)
M16B.setNames(seat=>MP.seatName(seat));

/* ---------- 進場選單 ---------- */
$("m16GoOnline").addEventListener("click",()=>MP.openConnect());

/* ---------- 大廳設定 ---------- */
$("m16GoalSeg").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(b) MP.setGoal(b.dataset.goal);
});
$("scoreSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()-1));
$("wgPlus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()+1));
$("resetScoreBtn").addEventListener("click",()=>MP.resetScores());

/* ---------- 設定:聽牌提示(這一頁專屬) ----------
   打掉某張之後聽幾張 —— 只給數字,不指出是哪幾張(維持「要自己算」的成分)。
   ui-kit 的 syncSettingsUI() 是共用的,專屬那一列自己綁、自己同步。 */
function syncM16Hint(){
  const b=$("m16SwHint"); if(b) b.setAttribute("aria-checked", M16B.hintOn()?"true":"false");
}
$("m16SwHint").addEventListener("click",()=>{
  M16B.setHint(!M16B.hintOn());
  savePrefs(); syncM16Hint();
  showToast(M16B.hintOn()?"聽牌提示:開":"聽牌提示:關",1200);
});

/* 比分列:點某個人的卡片 = 傳表情給他 */
$("m16Hud").addEventListener("click",e=>{
  const c=e.target.closest(".m16-hcard"); if(!c)return;
  const id=c.dataset.id; if(!id)return;
  const me=(MP.roster().find(p=>p.me)||{}).id;
  openEmote(id===me ? "all" : id);
});

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
initUpdateCheck(()=>!MP.isOnline());
initFullscreenKeep();

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();
syncSettingsUI();
syncM16Hint();
showScreen("home");
autoJoinFromQuery(MP);
setTimeout(maybeShowInstallTip,1500);

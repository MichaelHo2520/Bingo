"use strict";
let lfOffset=0;
function lfNow(){return Date.now()+lfOffset;}
function showScreen(which){
  const on={home:["lfHome"],connect:[],lobby:["lfSetup"],play:["lfPlay"],solo:["lfSoloBar","lfPlay"]}[which]||[];
  ["lfHome","lfSetup","lfPlay","lfSoloBar"].forEach(id=>$(id).classList.toggle("hidden",!on.includes(id)));
  if(which==="home"||which==="solo")["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>$(id).classList.add("hidden"));
  document.body.classList.toggle("solo-on",which==="solo");
  document.body.classList.toggle("lf-mp",which==="play");
  document.body.classList.toggle("lf-solo",which==="solo");
  if(which==="play")dockTools("mpBar");else if(which==="solo")dockTools("lfSoloBar");else undockTools();
  BigMode.sync();syncPageBack();
}
const lfBind=(id,fn)=>{const el=$(id);if(el)el.addEventListener("click",fn);};
// 在選擇處理前給回饋；同一選項重按也會回應，不延遲出牌或網路交易。
document.addEventListener("click",e=>{
  const b=e.target.closest("#lfHome button,#lfControls button,#lfSetup .seg button");
  if(b&&!b.disabled)LFB.feedback(b);
},true);
lfBind("lfGoOnline",()=>{MP.openConnect();});
lfBind("lfStartSolo",()=>Solo.start());lfBind("lfSoloExit",()=>Solo.quit());
lfBind("lfSoloAgain",()=>Solo.again());lfBind("lfSoloHome",()=>Solo.quit());
lfBind("mpCreate",()=>MP.create($("mpName").value,$("mpRoomName").value));
lfBind("mpScan",()=>MP.scanRooms());lfBind("mpReadyBtn",()=>MP.toggleReady());
lfBind("mpLeaveBtn",()=>MP.askLeave());lfBind("mpConnBack",()=>showScreen("home"));
lfBind("leaveConfirm",()=>MP.confirmLeave());lfBind("leaveCancel",()=>MP.cancelLeave());
lfBind("kickConfirm",()=>MP.confirmKick());lfBind("kickCancel",()=>MP.cancelKick());
lfBind("mpAgain",()=>MP.again());lfBind("mpLeaveWin",()=>MP.askLeave());
lfBind("mpNewSeason",()=>{MP.resetScores();MP.again();});
lfBind("winPeek",peekBoard);lfBind("reopenWin",showResult);
$("mpName").addEventListener("change",savePrefs);
$("mpName").addEventListener("input",()=>$("mpName").classList.remove("needs-name"));
$("scoreSeg").addEventListener("click",e=>{const b=e.target.closest("button");if(b)MP.setScoreMode(b.dataset.score);});
lfBind("wgMinus",()=>MP.setWinGoal(MP.winGoal()-1));lfBind("wgPlus",()=>MP.setWinGoal(MP.winGoal()+1));
lfBind("resetScoreBtn",()=>MP.resetScores());
lfBind("lfReactRow",e=>{const b=e.target.closest("button");if(!b)return;if(b.dataset.em)MP.sendEmote("all",b.dataset.em);else openEmote("all");});
bindCommonUI();bindPageBack({soloBack:()=>Solo.quit()});bindAudioLifecycle();registerSW();paintVersion();
initUpdateCheck(()=>!MP.isOnline()&&!Solo.playing());initFullscreenKeep();
buildSwatches();
BigMode.init({cls:"lf-big",btn:"lf-bigbtn",name:"大盤面",live:()=>!$("lfPlay").classList.contains("hidden"),save:savePrefs});
loadPrefs();syncSettingsUI();showScreen("home");autoJoinFromQuery(MP);bootReady();
// Firebase SDK 是共用核心按需載入；連線後採伺服器時差對齊倒數。
let lfTimeRef=null;
setInterval(()=>{
  if(lfTimeRef || !MP.isOnline() || !window.firebase || !firebase.apps.length)return;
  lfTimeRef=firebase.database().ref(".info/serverTimeOffset");
  lfTimeRef.on("value",s=>{lfOffset=Number(s.val())||0;});
},1000);

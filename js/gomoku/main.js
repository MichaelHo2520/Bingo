"use strict";

/* ============================================================================
   五子棋 — 事件綁定與啟動(必須最後載入)
   ========================================================================== */

/* ---------- 棋盤 ---------- */
GB.onTap(i=>MPG.tap(i));                       // 能不能下由 MPG.tap() 判定並給回饋(不用 disabled 靜默吃掉點擊)
$("gmkZoomIn").addEventListener("click",()=>GB.zoomIn());
$("gmkZoomOut").addEventListener("click",()=>GB.zoomOut());
$("gmkZoomFit").addEventListener("click",()=>GB.fit());

/* ---------- 大廳設定(房主可改) ---------- */
$("gmkSizeSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MPG.setBoardSize(+b.dataset.size); });
$("gmkSwapSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MPG.setSwapFirst(b.dataset.swap==="1"); });
$("scoreSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MPG.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click",()=>MPG.setWinGoal(MPG.winGoal()-1));
$("wgPlus").addEventListener("click",()=>MPG.setWinGoal(MPG.winGoal()+1));
$("resetScoreBtn").addEventListener("click",()=>MPG.resetScores());

/* ---------- 連線 / 房間 ---------- */
$("mpCreate").addEventListener("click",()=>MPG.create($("mpName").value,$("mpRoomName").value));
$("mpScan").addEventListener("click",()=>MPG.scanRooms());
$("mpName").addEventListener("change",savePrefs);
$("mpName").addEventListener("input",()=>$("mpName").classList.remove("needs-name"));
$("mpRoomName").addEventListener("keydown",e=>{ if(e.key==="Enter")MPG.create($("mpName").value,$("mpRoomName").value); });
$("mpReadyBtn").addEventListener("click",()=>MPG.toggleReady());
$("mpLeaveBtn").addEventListener("click",()=>MPG.askLeave());
$("leaveConfirm").addEventListener("click",()=>MPG.confirmLeave());
$("leaveCancel").addEventListener("click",()=>MPG.cancelLeave());
$("leaveVeil").addEventListener("click",e=>{ if(e.target===$("leaveVeil"))MPG.cancelLeave(); });
$("kickConfirm").addEventListener("click",()=>MPG.confirmKick());
$("kickCancel").addEventListener("click",()=>MPG.cancelKick());
$("kickVeil").addEventListener("click",e=>{ if(e.target===$("kickVeil"))MPG.cancelKick(); });

/* ---------- 認輸 ---------- */
$("resignBtn").addEventListener("click",()=>MPG.askResign());
$("resignConfirm").addEventListener("click",()=>MPG.confirmResign());
$("resignCancel").addEventListener("click",()=>MPG.cancelResign());
$("resignVeil").addEventListener("click",e=>{ if(e.target===$("resignVeil"))MPG.cancelResign(); });

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click",()=>MPG.again());
$("mpLeaveWin").addEventListener("click",()=>MPG.askLeave());
$("mpNewSeason").addEventListener("click",()=>{ MPG.resetScores(); MPG.again(); });
$("winPeek").addEventListener("click",peekBoard);
$("reopenWin").addEventListener("click",showResult);
// 結果卡是強制回應視窗:點/滑到卡片外一律吃掉手勢(不關卡、也不讓背景捲動)
$("veil").addEventListener("touchmove",e=>{
  const card=e.target.closest?e.target.closest(".win-card"):null;
  if(card && card.scrollHeight>card.clientHeight) return;
  e.preventDefault();
},{passive:false});

/* ---------- 設定 ---------- */
$("settingsBtn").addEventListener("click",openSettings);
$("setClose").addEventListener("click",closeSettings);
$("setVeil").addEventListener("click",e=>{ if(e.target===$("setVeil"))closeSettings(); });
$("fsBtn").addEventListener("click",toggleFull);
$("swEbook").addEventListener("click",()=>toggleEbook());
$("swMute").addEventListener("click",()=>{ Sound.toggle(); savePrefs(); syncSettingsUI(); });
$("swBgm").addEventListener("click",()=>setBgm(!bgmOn));
$("bgmTrackSel").addEventListener("change",e=>setBgmTrack(e.target.value));
$("bgmVol").addEventListener("input",e=>setBgmVol((+e.target.value||0)/100));
$("bgmVol").addEventListener("change",savePrefs);
$("voiceVol").addEventListener("input",e=>setVoiceVol((+e.target.value||0)/100));
$("voiceVol").addEventListener("change",savePrefs);
$("sfxVol").addEventListener("input",e=>setSfxVol((+e.target.value||0)/100));
$("sfxVol").addEventListener("change",savePrefs);
$("swVibrate").addEventListener("click",()=>setVibrate(!vibrateOn));

/* ---------- 表情 / 語音 ---------- */
$("emoteOpenBtn").addEventListener("click",()=>openEmote("all"));
$("quickVoiceBtn").addEventListener("click",toggleQuickVoice);
$("emoteClose").addEventListener("click",closeEmote);
$("emoteVeil").addEventListener("pointerdown",e=>{ if(e.target===$("emoteVeil"))closeEmote(); });
$("emoteVeil").addEventListener("touchmove",e=>{
  const card=e.target.closest?e.target.closest(".emote-card"):null;
  if(card && card.scrollHeight>card.clientHeight) return;
  e.preventDefault();
},{passive:false});
$("emoteSend").addEventListener("click",sendCustomText);
$("emoteText").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); sendCustomText(); } });
$("voiceGate").addEventListener("click",playVoiceGate);

addEventListener("resize",()=>{ const cv=$("confetti"); if(cv&&cv.width){ cv.width=innerWidth; cv.height=innerHeight; } });

/* ---------- 音訊解鎖(與 Bingo 同一套:iOS 切背景會把 AudioContext 打回 suspended) ---------- */
let audioUnlocked=false;
function unlockAudioOnce(){
  markAudioArmed();
  Sound.wake();
  if(!audioUnlocked){ audioUnlocked=true; if(bgmOn)BGM.setOn(true); }
  const kick=()=>{ kickVoiceQueue(); BGM.nudge(); };
  if(Sound.resume) Sound.resume().then(kick); else kick();
}
function armAudioUnlock(){
  addEventListener("pointerdown",unlockAudioOnce,{once:true});
  addEventListener("keydown",unlockAudioOnce,{once:true});
}
armAudioUnlock();
document.addEventListener("visibilitychange",()=>{
  if(document.hidden){
    markAudioStale();
    BGM.setHidden(true);
    return;
  }
  BGM.setHidden(false);
  armAudioUnlock();
});
// 換頁(回 index.html / 按上一頁)也要停音樂:Safari 換頁不發 visibilitychange,
// 舊頁進 bfcache 還在放、新頁又開一首 → 背景音樂疊起來(v1.40.0)。與 js/main.js 同一套。
addEventListener("pagehide",()=>{ markAudioStale(); BGM.setHidden(true); });
addEventListener("pageshow",e=>{ if(!e.persisted)return; BGM.setHidden(false); armAudioUnlock(); });

/* ---------- Service Worker(與 Bingo 共用 sw.js) ---------- */
if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost" || location.hostname==="127.0.0.1")){
  addEventListener("load",()=>{ navigator.serviceWorker.register("sw.js").catch(()=>{}); });
}

/* ---------- 版號(單一來源:<meta name="version">) ---------- */
(function(){
  const m=document.querySelector('meta[name="version"]'), v=m?m.content:"";
  const tv=$("topVer"); if(tv)tv.textContent=v?("v"+v):"";
  const sv=$("setVer"); if(sv)sv.textContent=v?("v"+v):"";
})();

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();
syncSettingsUI();
GB.init();          // 棋盤 DOM + 手勢(舞台此時是 hidden,ResizeObserver 會在顯示後算 fit)
MPG.openConnect();  // 進場直接進連線畫面(五子棋只有連線對戰)

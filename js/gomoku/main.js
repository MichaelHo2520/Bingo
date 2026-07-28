"use strict";

/* ============================================================================
   五子棋 — 事件綁定與啟動(必須最後載入)
   設定蓋板 / 表情面板 / 音訊解鎖 / SW 註冊那些兩個遊戲一字不差的綁定,
   已收進 js/shared/ui-kit.js 的 bindCommonUI() / bindAudioLifecycle() / registerSW()。
   ========================================================================== */

/* ---------- 棋盤 ---------- */
GB.onTap(i=>MP.tap(i));                        // 能不能下由 MP.tap() 判定並給回饋(不用 disabled 靜默吃掉點擊)
$("gmkZoomIn").addEventListener("click",()=>GB.zoomIn());
$("gmkZoomOut").addEventListener("click",()=>GB.zoomOut());
$("gmkZoomFit").addEventListener("click",()=>GB.fit());

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
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡(連線畫面本身可以直接重載,重載後照樣停在連線畫面)
initUpdateCheck(()=>!MP.isOnline());

/* ---------- 啟動 ---------- */
buildSwatches();
loadPrefs();
syncSettingsUI();
GB.init();         // 棋盤 DOM + 手勢(舞台此時是 hidden,ResizeObserver 會在顯示後算 fit)
MP.openConnect();  // 進場直接進連線畫面(五子棋只有連線對戰)
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip,1500);

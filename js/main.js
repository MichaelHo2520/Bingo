"use strict";

  /* ---------- Wire up ---------- */
  // 房間分頁列:點「設定 / 填號」切換顯示
  $("roomTabs").addEventListener("click",e=>{
    const b=e.target.closest("button"); if(!b)return;
    roomTab=b.dataset.tab; applyRoomTab();
  });
  $("fillSeg").addEventListener("click",e=>{
    const b=e.target.closest("button");if(!b)return;
    [...$("fillSeg").children].forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    state.fill=b.dataset.fill;
    if(state.fill==="auto"){ state.card=shuffled(); }
    else { state.card=Array(nCells()).fill(0); }
    render();applyFillUI();
  });
  $("sizeSeg").addEventListener("click",e=>{
    const b=e.target.closest("button");if(!b)return;
    const n=+b.dataset.size;if(!(n>=5&&n<=7)||n===SIZE)return;
    if(state.online && !MP.amHost()){ showToast("只有房主能改盤面大小"); return; }
    setSize(n);savePrefs();
    if(state.online){ MP.setSize(n); MP.setTarget(state.target); }   // 房主:同步大小與(可能被夾住的)勝利線數
  });
  $("tMinus").addEventListener("click",()=>{state.target=Math.max(1,state.target-1);$("targetVal").textContent=state.target;savePrefs();if(state.online)MP.setTarget(state.target);});
  $("tPlus").addEventListener("click",()=>{state.target=Math.min(maxLines(),state.target+1);$("targetVal").textContent=state.target;savePrefs();if(state.online)MP.setTarget(state.target);});
  $("reshuffleBtn").addEventListener("click",()=>{state.card=shuffled();render();if(state.online)MP.readyEnabled(true);});
  $("startBtn").addEventListener("click",startGame);
  $("exitBtn").addEventListener("click",toSetup);
  $("settingsBtn").addEventListener("click",openSettings);
  $("setClose").addEventListener("click",closeSettings);
  $("setVeil").addEventListener("click",e=>{ if(e.target===$("setVeil"))closeSettings(); });
  $("emoteClose").addEventListener("click",closeEmote);
  // 碰到卡片外(背景)就直接關閉:用 pointerdown 讓觸控一按下就關,不必等點擊放開
  $("emoteVeil").addEventListener("pointerdown",e=>{ if(e.target===$("emoteVeil"))closeEmote(); });
  // 面板內滑動:卡片「有得捲」才交給它內部捲動,否則(沒得捲或在背景)一律吃掉手勢,避免捲到背景頁
  $("emoteVeil").addEventListener("touchmove",e=>{
    const card=e.target.closest?e.target.closest(".emote-card"):null;
    if(card && card.scrollHeight>card.clientHeight) return;   // 內容超出才讓卡片捲(overscroll-behavior:contain 擋邊界外溢)
    e.preventDefault();
  },{passive:false});
  $("emoteSend").addEventListener("click",sendCustomText);
  $("emoteText").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); sendCustomText(); } });
  $("voiceBtn").addEventListener("click",toggleVoice);
  $("quickVoiceBtn").addEventListener("click",toggleQuickVoice);   // 快速語音:直接錄→送全部人
  $("voiceGate").addEventListener("click",playVoiceGate);          // 「點我播放語音」膠囊:手勢喚醒音訊後補播佇列
  $("swEbook").addEventListener("click",()=>{ toggleEbook(); });
  $("swMute").addEventListener("click",()=>{ Sound.toggle(); savePrefs(); syncSettingsUI(); });
  $("swBgm").addEventListener("click",()=>setBgm(!bgmOn));                       // 背景音樂開關
  $("bgmVol").addEventListener("input",e=>setBgmVol((+e.target.value||0)/100));  // 拖曳即時調音量
  $("bgmVol").addEventListener("change",savePrefs);                             // 放開才存偏好
  $("voiceVol").addEventListener("input",e=>setVoiceVol((+e.target.value||0)/100)); // 收到語音音量:拖曳即時套用(下一則生效)
  $("voiceVol").addEventListener("change",savePrefs);                              // 放開才存偏好
  $("fsBtn").addEventListener("click",toggleFull);
  $("winRestart").addEventListener("click",()=>{restart();});
  $("winNew").addEventListener("click",()=>{closeWin();state.card=shuffled();state.fill="auto";toSetup();});
  $("winPeek").addEventListener("click",peekBoard);       // 先收起結果卡看牌面
  $("reopenWin").addEventListener("click",showResult);    // 浮動鈕:再叫回結果卡
  // 勝負結果卡是「強制回應」視窗:要離開只能按卡片上的按鈕。點/滑到卡片外的空白背景一律吃掉手勢——
  // 既不會關掉結果,也不會讓背景頁跟著捲動(手滑不再把結果畫面弄跑掉)
  $("veil").addEventListener("touchmove",e=>{
    const card=e.target.closest?e.target.closest(".win-card"):null;
    if(card && card.scrollHeight>card.clientHeight) return;   // 卡片內容超出畫面時,才讓卡片自己捲
    e.preventDefault();
  },{passive:false});
  // 主選單:進場先選單機 / 連線
  $("homeSolo").addEventListener("click",enterSolo);
  $("homeOnline").addEventListener("click",()=>MP.openConnect());
  $("soloBack").addEventListener("click",enterHome);   // 單機頁「回主選單」
  // multiplayer
  $("onlineBtn").addEventListener("click",()=>MP.openConnect());
  $("mpBack").addEventListener("click",()=>MP.closeConnect());
  $("mpCreate").addEventListener("click",()=>MP.create($("mpName").value,$("mpRoomName").value));
  $("mpScan").addEventListener("click",()=>MP.scanRooms());
  $("mpName").addEventListener("change",savePrefs);   // 暱稱記住,下次自動帶入
  $("mpName").addEventListener("input",()=>$("mpName").classList.remove("needs-name"));   // 一開始打字就解除紅框提示
  $("mpRoomName").addEventListener("keydown",e=>{ if(e.key==="Enter")MP.create($("mpName").value,$("mpRoomName").value); });
  $("mpReadyBtn").addEventListener("click",()=>MP.toggleReady());
  $("mpStartBtn").addEventListener("click",()=>MP.startGame());
  $("orderSeg").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;MP.setOrderMethod(b.dataset.order);});
  $("scoreSeg").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;MP.setScoreMode(b.dataset.score);});   // 計分模式:累積排行 / 搶勝
  $("wgMinus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()-1));   // 搶勝目標 −1
  $("wgPlus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()+1));    // 搶勝目標 +1
  $("resetScoreBtn").addEventListener("click",()=>MP.resetScores());          // 房主:重設所有人戰績
  $("mpNewSeason").addEventListener("click",()=>{ MP.resetScores(); MP.again(); });   // 奪冠後:重設戰績並回大廳開新賽季
  $("rpsBtns").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;MP.throwRps(b.dataset.rps);b.blur();});
  $("revealSkip").addEventListener("click",()=>MP.revealSkip());
  $("mpVeilLeave").addEventListener("click",()=>MP.bailFromRps());
  $("orderConfirm").addEventListener("click",()=>MP.confirmOrder());
  $("mpLeaveBtn").addEventListener("click",()=>MP.leave());
  $("kickConfirm").addEventListener("click",()=>MP.confirmKick());
  $("kickCancel").addEventListener("click",()=>MP.cancelKick());
  $("kickVeil").addEventListener("click",e=>{ if(e.target===$("kickVeil"))MP.cancelKick(); });
  $("mpAgain").addEventListener("click",()=>MP.again());
  $("mpLeaveWin").addEventListener("click",()=>MP.leave());
  addEventListener("resize",()=>{if(state.won){const cv=$("confetti");cv.width=innerWidth;cv.height=innerHeight;}});
  // 首次使用者互動:解鎖音訊;若偏好記得「要開背景音樂」就開始播(繞過瀏覽器自動播放限制)。
  // iOS 切背景/鎖屏會把 AudioContext 打回 suspended,故解鎖監聽做成「可重新武裝」:回前景後下一次手勢再喚醒一次。
  let audioUnlocked=false;
  function unlockAudioOnce(){
    Sound.wake();                                        // 每次(含回前景後)都喚醒一次 AudioContext
    if(!audioUnlocked){ audioUnlocked=true; if(bgmOn)BGM.setOn(true); }
    if(typeof kickVoiceQueue==="function") kickVoiceQueue();   // 若有語音在等手勢,喚醒後補播
  }
  function armAudioUnlock(){                              // 重新掛上「下一個手勢就喚醒」(同函式參考,重複掛會自動去重)
    addEventListener("pointerdown",unlockAudioOnce,{once:true});
    addEventListener("keydown",unlockAudioOnce,{once:true});
  }
  armAudioUnlock();
  document.addEventListener("visibilitychange",()=>{     // 回前景且 context 已被系統 suspend → 重新武裝
    if(!document.hidden && Sound.running && !Sound.running()) armAudioUnlock();
  });

  // Service Worker:離線可玩 + 「加到主畫面」。只在 https / localhost 註冊(file:// 不支援);
  // 採 network-first(見 sw.js),線上永遠拿最新版,不會有「更新出不來」的問題。
  if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost" || location.hostname==="127.0.0.1")){
    addEventListener("load",()=>{ navigator.serviceWorker.register("sw.js").catch(()=>{}); });
  }

  // 版本號:從 <meta name="version"> 取一次,填到頂列(BINGO 旁)與設定頁最下面(單一來源,免多處硬編)
  (function(){
    const m=document.querySelector('meta[name="version"]'), v=m?m.content:"";
    const tv=$("topVer"); if(tv)tv.textContent=v?("v"+v):"";
    const sv=$("setVer"); if(sv)sv.textContent=v?("v"+v):"";
  })();

  buildSwatches();
  loadPrefs();
  applyGridCols();syncSizeSeg();
  render();applyFillUI();
  syncSettingsUI();
  enterHome();   // 進場先顯示主選單(選單機 / 連線)

"use strict";

  /* ---------- Wire up ---------- */
  // 房間分頁列:點「設定 / 填號」切換顯示
  $("roomTabs").addEventListener("click",e=>{
    const b=e.target.closest("button"); if(!b)return;
    roomTab=b.dataset.tab; applyRoomTab();
  });
  $("fillSeg").addEventListener("click",e=>{
    const b=e.target.closest("button");if(!b)return;
    const next=b.dataset.fill, changed=next!==state.fill;
    state.fill=next;
    // 自動填號:切過來、或已在自動再按一次 → 都重抽整張卡(選中後文案就是「🎲 換一組號碼」,這就是它的作用)
    // 手動填號:只有「真的從自動切過來」才清空重填;已在手動又按一次不做事 ——
    //          否則會把填一半的號碼一次清光,而且沒有確認也沒得復原
    if(next==="auto"){ state.card=shuffled(); }
    else if(changed){ state.card=Array(nCells()).fill(0); }
    render();applyFillUI();   // applyFillUI() → syncFillSeg() 會把高亮 .on 與文案一起同步
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
  // (v1.36.2:獨立的「換一組」鈕已移除 → 併回上面 #fillSeg 的「自動填號」。
  //  原本這裡額外做的 MP.readyEnabled(true),applyFillUI() 的 auto 分支本來就會做,沒有遺漏)
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
  $("quickVoiceBtn").addEventListener("click",toggleQuickVoice);   // 快速語音:直接錄→送全部人(表情面板內的錄音鈕已移除,語音改由房間框的🎤)
  $("emoteOpenBtn").addEventListener("click",()=>openEmote("all"));   // 房間框的表情鈕:開互動面板(預設傳全部人,面板內可改對象)
  $("voiceGate").addEventListener("click",playVoiceGate);          // 「點我播放語音」膠囊:手勢喚醒音訊後補播佇列
  $("swMute").addEventListener("click",()=>{ Sound.toggle(); savePrefs(); syncSettingsUI(); });
  $("swBgm").addEventListener("click",()=>setBgm(!bgmOn));                       // 背景音樂開關
  $("bgmTrackSel").addEventListener("change",e=>setBgmTrack(e.target.value));    // 切換背景音樂曲目
  $("bgmVol").addEventListener("input",e=>setBgmVol((+e.target.value||0)/100));  // 拖曳即時調音量
  $("bgmVol").addEventListener("change",savePrefs);                             // 放開才存偏好
  $("voiceVol").addEventListener("input",e=>setVoiceVol((+e.target.value||0)/100)); // 收到語音音量:拖曳即時套用(下一則生效)
  $("voiceVol").addEventListener("change",savePrefs);                              // 放開才存偏好
  $("sfxVol").addEventListener("input",e=>setSfxVol((+e.target.value||0)/100));    // 音效音量:拖曳即時套用
  $("sfxVol").addEventListener("change",savePrefs);                                // 放開才存偏好
  $("swVibrate").addEventListener("click",()=>setVibrate(!vibrateOn));              // 「輪到你時震動」開關
  // 自訂語音的編輯浮層(★ js/shared/ui-kit.js 的 bindCommonUI 有一份同樣的綁定給五子棋/數獨用)
  $("myVoiceBtn").addEventListener("click",openMyVoice);
  $("mvClose").addEventListener("click",closeMyVoice);
  $("myVoiceVeil").addEventListener("click",e=>{ if(e.target===$("myVoiceVeil"))closeMyVoice(); });
  $("mvRecBtn").addEventListener("click",toggleMyVoiceRec);
  $("mvSave").addEventListener("click",saveMyVoicePending);
  $("mvName").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); saveMyVoicePending(); } });
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
  // 主選單第一層:選遊戲(五子棋是 <a href="gomoku.html">,不需綁定)
  $("pickBingo").addEventListener("click",()=>showHomeLayer("bingo"));
  $("homeBack").addEventListener("click",()=>showHomeLayer("pick"));
  // 主選單第二層:BINGO 的玩法(單機 / 連線)
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
  $("rpsVoiceBtn").addEventListener("click",toggleQuickVoice);        // 猜拳蓋板的快速語音:與房間框那顆共用同一套狀態機
  $("rpsEmoteBtn").addEventListener("click",()=>openEmote("all"));    // 猜拳蓋板的表情鈕:開互動面板(疊在猜拳蓋板之上,含語音短訊)
  $("mpVeilLeave").addEventListener("click",()=>MP.bailFromRps());
  $("orderConfirm").addEventListener("click",()=>MP.confirmOrder());
  $("mpLeaveBtn").addEventListener("click",()=>MP.askLeave());   // 房間橫幅的返回鈕:先跳確認,不再一按就斷線
  $("kickConfirm").addEventListener("click",()=>MP.confirmKick());
  $("kickCancel").addEventListener("click",()=>MP.cancelKick());
  $("kickVeil").addEventListener("click",e=>{ if(e.target===$("kickVeil"))MP.cancelKick(); });
  $("leaveConfirm").addEventListener("click",()=>MP.confirmLeave());
  $("leaveCancel").addEventListener("click",()=>MP.cancelLeave());
  $("leaveVeil").addEventListener("click",e=>{ if(e.target===$("leaveVeil"))MP.cancelLeave(); });
  $("mpAgain").addEventListener("click",()=>MP.again());
  $("mpLeaveWin").addEventListener("click",()=>MP.askLeave());   // 結果卡的離開:房主一按就關房,同樣先確認
  addEventListener("resize",()=>{if(state.won){const cv=$("confetti");cv.width=innerWidth;cv.height=innerHeight;}});
  // 首次使用者互動:解鎖音訊;若偏好記得「要開背景音樂」就開始播(繞過瀏覽器自動播放限制)。
  // iOS 切背景/鎖屏會把 AudioContext 打回 suspended,故解鎖監聽做成「可重新武裝」:回前景後下一次手勢再喚醒一次。
  let audioUnlocked=false;
  function unlockAudioOnce(){
    if(typeof markAudioArmed==="function") markAudioArmed();   // 真實手勢 → 標記音訊已解鎖(觸控裝置收到的語音才可自動播)
    Sound.wake();                                        // 每次(含回前景後)都喚醒一次 AudioContext + Silent Buffer Kick
    if(!audioUnlocked){ audioUnlocked=true; if(bgmOn)BGM.setOn(true); }
    // 等 resume 真的完成(context running)再補播,避免太早 pump 時 Sound.running() 仍為 false 又退回膠囊
    // 等 context 真的 running 再補播語音,並補開背景音樂 —— iOS 從背景回前景時 resume() 常要等真實手勢
    // 才成功,那一刻 setHidden(false) 已經跑過了,所以要在這裡用 nudge() 補一次(該播卻沒在播才動作)
    const kick=()=>{ if(typeof kickVoiceQueue==="function") kickVoiceQueue(); BGM.nudge(); };
    if(Sound.resume) Sound.resume().then(kick); else kick();
  }
  function armAudioUnlock(){                              // 重新掛上「下一個手勢就喚醒」(同函式參考,重複掛會自動去重)
    addEventListener("pointerdown",unlockAudioOnce,{once:true});
    addEventListener("keydown",unlockAudioOnce,{once:true});
  }
  armAudioUnlock();
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){
      if(typeof markAudioStale==="function") markAudioStale();   // 切到背景 → 音訊視為未解鎖(iOS 回來常是 state=running 卻不出聲)
      BGM.setHidden(true);   // 最小化 / 切走 / 鎖屏 → 背景音樂暫停(v1.36.4;桌機與 Android 原本會一直放)
      return;
    }
    BGM.setHidden(false);   // 回前景 → 使用者原本開著音樂就從原位接著播
    armAudioUnlock();       // 回前景一律重新武裝:下一個手勢(點任何地方 / 點播放膠囊)都會重新解鎖並補播等待中的語音
  });
  // 換頁(去 gomoku.html / 按上一頁)也要停音樂:Safari 換頁不發 visibilitychange,
  // 舊頁被丟進 bfcache 卻還在放,新頁又開一首 → 兩首疊在一起(v1.40.0)。
  // pageshow 的 persisted 代表是從 bfcache 復原(不是重新載入),此時才需要自己接回去播。
  addEventListener("pagehide",()=>{
    if(typeof markAudioStale==="function") markAudioStale();
    BGM.setHidden(true);
  });
  addEventListener("pageshow",e=>{
    if(!e.persisted)return;
    BGM.setHidden(false);
    armAudioUnlock();
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

  /* ---------- 更新檢查(v1.48.0) ----------
     要解決的事:手機分頁常一整天不關(PWA 更是如此),程式已經上了新版,現場玩的人卻還跑著舊 JS。
     sw.js 是 network-first,只要「重新載入」就會拿到最新版 —— 難的是沒有人會主動去重載。
     做法:每 5 分鐘用 no-store 抓自己這一頁的 HTML,比對 <meta name="version">
          (版號的單一來源就是那個 meta,不必再多一個 version.json 要記得改)。
     抓到不一樣的版號 → 安全的時候自動重載;還在設定/對戰/玩到一半就先記著,等回主選單那一刻再套用,
     絕不把人踢出局(連線中重載會斷線重連,單機中重載會整張卡重來)。
     ★ 同一套邏輯在 js/shared/ui-kit.js 另有一份給五子棋/數獨(Bingo 不載入那支)—— 改一邊記得改另一邊。 */
  const UPD_CHECK_MS=5*60*1000;     // 兩次連線檢查的最小間隔
  const UPD_TICK_MS=4000;           // 心跳:也負責「pending 等到安全就套用」,所以要比檢查間隔密
  const UPD_FROM_KEY="bingo.updfrom";
  let updCur="", updPending="", updLastAt=0, updGoing=false;
  // 安全 = 停在主選單(#home 還看得見)且不在連線房裡。選房間畫面也算不安全:
  // 那時暱稱/房名可能打了一半,而且下一步就要進房了。
  function updSafe(){ return state.mode==="home" && !state.online && !$("home").classList.contains("hidden"); }
  function initUpdateCheck(){
    const m=document.querySelector('meta[name="version"]');
    updCur=m?m.content:"";
    if(!updCur || location.protocol==="file:")return;   // 沒版號、或本機用 file:// 開(fetch 一定失敗)就不啟用
    // 上一輪是為了更新而重載的話,回報結果。版號沒變 = 這次更新沒生效(CDN 還沒同步之類),
    // 本次瀏覽就整個停掉檢查 —— 否則每 5 分鐘重載一次會變成無限重載。
    let stuck=false;
    try{
      const from=sessionStorage.getItem(UPD_FROM_KEY);
      if(from){
        sessionStorage.removeItem(UPD_FROM_KEY);
        if(from!==updCur) setTimeout(()=>showToast("已更新到 v"+updCur+" 🎉",2200),1200);
        else stuck=true;
      }
    }catch(_){}
    if(stuck)return;
    updLastAt=Date.now();                              // 這頁剛載入本身就是最新的,第一次檢查等一個週期後
    addEventListener("online",()=>{ updLastAt=0; });   // 離線時開的是快取版,一連上網就馬上查
    setInterval(updTick,UPD_TICK_MS);
  }
  function updTick(){
    if(updGoing)return;
    if(updPending){ if(updSafe()) updApply(); return; }   // 有新版在等 → 只等「安全」這件事
    if(document.hidden || navigator.onLine===false)return;
    if(Date.now()-updLastAt < UPD_CHECK_MS)return;
    updLastAt=Date.now();
    fetch(location.pathname,{cache:"no-store"})            // 只抓自己這頁;no-store 繞過 HTTP 快取
      .then(r=>r.ok?r.text():"")
      .then(html=>{
        const mm=html.match(/<meta\s+name="version"\s+content="([^"]+)"/i), v=mm?mm[1]:"";
        if(!v || v===updCur)return;
        updPending=v;                                      // 只要不同就算有更新(含刻意回退舊版)
        if(!updSafe()) showToast("有新版本 v"+v+",這局結束後會自動更新",2600);
      })
      .catch(()=>{});                                      // 抓失敗(沒網路 / 伺服器暫時掛):安靜跳過,下個週期再試
  }
  function updApply(){
    if(updGoing)return;
    updGoing=true;
    showToast("發現新版本 v"+updPending+",正在更新…",1600);
    setTimeout(()=>{
      if(!updSafe()){ updGoing=false; return; }             // 這 1 秒內又進房 / 開了新局 → 取消,等下個安全時機
      let done=false;
      const go=()=>{
        if(done)return; done=true;
        try{ sessionStorage.setItem(UPD_FROM_KEY,updCur); }catch(_){}   // 記下舊版號,重載後用來確認真的換版了
        location.reload();
      };
      setTimeout(go,2500);                                  // 保險:SW 沒回應也照樣重載
      // 先讓 SW 抓新的 sw.js(新版 install 會 skipWaiting 並清掉舊快取),再重載
      if(navigator.serviceWorker && navigator.serviceWorker.getRegistration){
        navigator.serviceWorker.getRegistration().then(r=>r?r.update():null).then(go).catch(go);
      }else go();
    },1100);
  }

  buildSwatches();
  loadPrefs();
  applyGridCols();syncSizeSeg();
  render();applyFillUI();
  syncSettingsUI();
  enterHome();     // 進場先顯示主選單(選單機 / 連線)
  initBoardFit();  // 號碼格自適應:掛上版面觀察並算第一次的可用高度(必須在 enterHome 之後,版面已定案)
  initUpdateCheck();
  initFullscreenKeep();   // 全螢幕跨頁保持:從五子棋/數獨回來後,第一個手勢自動接回全螢幕
  HomeLive.boot();        // 首頁「現在有人在玩」看板:idle 後才載 Firebase SDK,首屏不等它
  // iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
  setTimeout(maybeShowInstallTip,1500);

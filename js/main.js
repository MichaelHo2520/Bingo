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
  /* 首頁 → 別頁遊戲(v1.153.0):記下「這一趟是從首頁點進去的」,那一頁的「回主選單」才知道
     可以 history.back() 退回來 —— 而不是再往歷史裡疊一筆首頁,害得在首頁按返回是倒帶回
     上一個玩過的遊戲、而不是退出 app。理由與另一半在 js/shared/ui-kit.js 的 bindHomeLinks()。
     十張卡與「現在有人在玩」看板的每一列都是 <a href="xxx.html">(看板那些是 home-live.js
     動態產生的)→ 一律委派在 document 上,不逐一綁。
     ⚠ 進首頁先清掉:被 location.replace() 換進來的首頁,上一筆歷史並不是首頁。 */
  const NAV_HOME_KEY="bingo.navhome";
  try{ sessionStorage.removeItem(NAV_HOME_KEY); }catch(_){}
  document.addEventListener("click",e=>{
    const a=e.target.closest?e.target.closest("a[href]"):null;
    if(!a)return;
    const href=a.getAttribute("href")||"";
    if(!/^[\w-]+\.html([?#]|$)/.test(href) || /^index\.html/.test(href))return;   // 只認同目錄的別頁遊戲
    try{ sessionStorage.setItem(NAV_HOME_KEY,"1"); }catch(_){}
  });
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
    // 設定頁那顆同時是「強制更新」的按鈕(見 armHardRefresh);頂列那顆刻意不綁
    const sv=$("setVer"); if(sv){ sv.textContent=v?("v"+v):""; armHardRefresh(sv); }
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
  const UPD_STUCK_MS=30*60*1000;    // 上一輪重載後版號沒變 → 退化成這個慢速間隔(見 initUpdateCheck)
  const UPD_STUCK_MAX=3;            // 連續三輪都沒換到版才真的放棄
  const UPD_TICK_MS=4000;           // 心跳:也負責「pending 等到安全就套用」,所以要比檢查間隔密
  const UPD_FROM_KEY="bingo.updfrom";
  const UPD_TRY_KEY="bingo.updtry";
  let updCur="", updPending="", updLastAt=0, updGoing=false;
  let updGap=UPD_CHECK_MS, updStuck=false;
  // 安全 = 停在主選單(#home 還看得見)且不在連線房裡。選房間畫面也算不安全:
  // 那時暱稱/房名可能打了一半,而且下一步就要進房了。
  function updSafe(){ return state.mode==="home" && !state.online && !$("home").classList.contains("hidden"); }
  function initUpdateCheck(){
    const m=document.querySelector('meta[name="version"]');
    updCur=m?m.content:"";
    if(!updCur || location.protocol==="file:")return;   // 沒版號、或本機用 file:// 開(fetch 一定失敗)就不啟用
    /* 上一輪是為了更新而重載的話,回報結果。版號沒變 = 這次更新沒生效 —— 成因通常是
       GitHub Pages 的 CDN 還沒同步,或 HTML 吃到瀏覽器自己的 HTTP 快取(max-age=600)。
       ⚠⚠ v1.159.0 之前這裡是「本次瀏覽**整個停掉**檢查」。防無限重載的用意是對的,但下手太重:
         手機分頁 / PWA 常一整天不關,而 CDN 通常一兩分鐘就好了 → 症狀是**推了新版,那一台
         就一整天卡在舊版,而且怎麼等都不會好**(使用者回報的「一直卡著沒更新」,成因之一)。
       改成:退化成 30 分鐘一次的慢速重試,連續三輪都沒換到版才真的放棄。
       ⚠ 計數存 sessionStorage:關掉分頁重開就歸零,而那時本來就該重新積極檢查。
       ⚠ 這一段是**雙胞胎**,js/shared/ui-kit.js 有對應的一份(紅線 4)。 */
    let stuck=false;
    try{
      const from=sessionStorage.getItem(UPD_FROM_KEY);
      if(from){
        sessionStorage.removeItem(UPD_FROM_KEY);
        if(from!==updCur){ sessionStorage.removeItem(UPD_TRY_KEY); setTimeout(()=>showToast("已更新到 v"+updCur+" 🎉",2200),1200); }
        else stuck=true;
      }
    }catch(_){}
    if(stuck){
      let n=0;
      try{ n=(parseInt(sessionStorage.getItem(UPD_TRY_KEY),10)||0)+1; sessionStorage.setItem(UPD_TRY_KEY,String(n)); }catch(_){ n=UPD_STUCK_MAX; }
      if(n>=UPD_STUCK_MAX)return;                      // 連三輪沒換到版:這次瀏覽真的放棄(設定頁的版號還可以手動強制更新)
      updStuck=true; updGap=UPD_STUCK_MS;
    }
    updLastAt=Date.now();                              // 這頁剛載入本身就是最新的,第一次檢查等一個週期後
    // 離線時開的是快取版,一連上網就馬上查。⚠ 慢速重試中不吃這條:那時「馬上查」很可能又是白跑一趟重載
    addEventListener("online",()=>{ if(!updStuck) updLastAt=0; });
    setInterval(updTick,UPD_TICK_MS);
  }
  function updTick(){
    if(updGoing)return;
    if(updPending){ if(updSafe()) updApply(); return; }   // 有新版在等 → 只等「安全」這件事
    if(document.hidden || navigator.onLine===false)return;
    if(Date.now()-updLastAt < updGap)return;              // updGap:正常 5 分鐘,慢速重試中 30 分鐘
    updLastAt=Date.now();
    /* ★★ 只抓前 4 KB(v1.156.0)。要的只有 <meta name="version"> 那一個標籤,而它在十三頁
       全部落在前 2,160 B 之內;抓整份是 21~40 KB(index.html 是最大的那一頁)。
       ⚠ 伺服器不支援 Range 就回 200 全檔 → 下面的 .match() 自動退回舊行為。
       ⚠⚠ 必須與 sw.js 的 cache.put 一起改(206 的 res.ok 是 true,而 Cache.put 對 206 會 reject)。
       ⚠ 這一段是**雙胞胎**,js/shared/ui-kit.js 有對應的一份(紅線 4)。 */
    fetch(location.pathname,{cache:"no-store",headers:{Range:"bytes=0-4095"}})   // 只抓自己這頁的開頭
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

  /* ---------- 強制更新:設定頁的版號可以按(v1.159.0) ----------
     上面那套自動檢查治的是「沒有人會主動重載」,但它治不了另外三種「卡在舊版」——
     這一節是給那三種的救援手段(使用者從設定頁的 v1.x.y 按下去):
       ① **Cache Storage 殘留**:sw.js 是 network-first,只在 fetch 成功時才更新快取 ——
          離線過一次、或請求被中斷過,那一份舊回應就會一直墊在下面。
       ② **瀏覽器自己的 HTTP disk cache**:GitHub Pages 給 HTML / CSS / JS 的是 max-age=600,
          而 `caches.delete()` **碰不到它**(兩個不同的快取層,清了 Cache Storage 也沒用)。
          這一層在 JS 裡唯一的手段是 `fetch(url,{cache:"reload"})` —— 繞過快取去問伺服器,
          並用新回應**覆寫掉**那一格,等價於對那個 URL 按 Ctrl+Shift+R。`location.reload(true)` 早已失效。
       ③ **PWA 的外殼 app.html 自己不吃更新檢查**(它刻意保持極簡的代價,見 app.html 開頭那段)——
          頂層 document 一輩子是安裝當天那一份。症狀很具體:v1.154.0 之前安裝的人,外殼的
          PAGES 表裡沒有 draw → 點「你畫我猜」會被丟回 Bingo,而且**怎麼等都不會好**。
     ★★ 一行設定都不碰,而且是**結構上碰不到**:要清的東西全在 Cache Storage / SW registration /
        HTTP cache 這三層,而設定值全在 localStorage —— 這一整節裡沒有出現過 localStorage。
        維護時請保持這件事:bingo.prefs.v1(主題 / 音量 / 暱稱)、bingo.pid、
        bingo.myclips.v1(自訂語音)一個都不准掉。
     ⚠ 這一整節是**雙胞胎**,js/shared/ui-kit.js 有對應的一份給另外十一頁(紅線 4)。 */
  const HARD_FROM_KEY="bingo.hardfrom";
  const HARD_WARM_MS=4000;          // 重抓資源的總時限:網路很差的手機不可以卡在「正在清除快取」不動
  let hardGoing=false;

  /* 這一頁實際載入了哪些同源資源 —— 從 DOM 撈,不必維護第二份清單
     (sw.js 的 CORE 那種手列清單是漏檔的主要來源)。
     ⚠ 外部資源(Firebase SDK / Google Fonts)刻意不碰:sw.js 的 fetch 也不攔它們。
     ⚠ sw.js 自己也列進來 —— 規範其實已經讓 SW 主腳本的更新請求繞過 HTTP 快取,
       多抓這一次純粹是保險(成本是一個請求),不要因為「理論上不必」就拿掉。 */
  function hardUrls(){
    const list=[location.pathname,"sw.js"];
    const add=(el,attr)=>{ const u=el.getAttribute(attr); if(u && !/^(https?:)?\/\//i.test(u) && !/^data:/i.test(u)) list.push(u); };
    document.querySelectorAll("script[src]").forEach(el=>add(el,"src"));
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach(el=>add(el,"href"));
    return list;
  }
  async function hardRewarm(){
    const jobs=hardUrls().map(u=>fetch(u,{cache:"reload"}).catch(()=>{}));
    /* 總時限。逾時就直接往下走 —— 沒抓完的部分重載後照樣走 network-first 再抓一次,
       這一步只是「先把 HTTP 快取那一格換掉」的最佳化,不是正確性的前提。 */
    await Promise.race([Promise.all(jobs), new Promise(r=>setTimeout(r,HARD_WARM_MS))]);
  }
  async function hardRefresh(){
    if(hardGoing)return;
    /* ⚠ 對局中誤按絕不可以把人踢出局 —— 設定頁在對局中也開得起來(頂列那顆 ⚙️)。
       沿用自動更新那套 updSafe():什麼叫「安全」只有各遊戲自己知道。
       ⚠ ui-kit 那一份的 updSafe 是**變數**(initUpdateCheck(safeFn) 才賦值)→ 可能還是 null;
         js/main.js 那一份是函式宣告、永遠存在。寫成 `updSafe && …` 兩邊都對,而雙胞胎要求逐字相同。 */
    if(updSafe && !updSafe()){ showToast("對局中不能強制更新,這局結束後再試",2600); return; }
    // file:// 直接開的時候沒有 SW、也沒有 Cache Storage / HTTP 快取可清 —— 誠實說,不要假裝做了事
    if(location.protocol==="file:"){ showToast("本機直接開檔時沒有快取可清",2600); return; }
    hardGoing=true;
    showToast("正在清除快取…",2400);
    const m=document.querySelector('meta[name="version"]');
    try{ sessionStorage.setItem(HARD_FROM_KEY,m?m.content:""); }catch(_){}
    // ① Cache Storage 全清。⚠ 不只 bingo-* :快取名萬一換過就再也清不掉,而這裡本來就該清光
    try{ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k).catch(()=>{}))); }catch(_){}
    // ② 註銷全部 SW。iOS PWA 的更新遲滯只有這一招治得了;重載後開頭那段 register 會重新註冊回來
    try{
      if(navigator.serviceWorker && navigator.serviceWorker.getRegistrations){
        const rs=await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map(r=>r.unregister().catch(()=>{})));
      }
    }catch(_){}
    await hardRewarm();                                 // ③ 繞過並覆寫 HTTP disk cache(見本節開頭 ②)
    // ④ 清掉自動檢查的「上一輪沒換到版」狀態:不然重載後可能立刻被判定該放棄
    try{ sessionStorage.removeItem(UPD_FROM_KEY); sessionStorage.removeItem(UPD_TRY_KEY); }catch(_){}
    hardReload();
  }
  /* 重載。兩件事:
     · 帶 ?fresh=<時間戳> —— 第 ③ 步已經覆寫過 HTTP 快取那一格了,這個是第二層保險
       (伺服器忽略 no-store、中間有代理);落地後由 hardRefreshLanded() 抹掉。
     · 在外殼的 iframe 裡要**請外殼重載它自己**:只 reload iframe 的話舊外殼會原封不動留著(本節 ③)。
       ⚠ 舊版外殼不認得 act:"hardreload"(v1.159.0 才加的)→ 訊息會掉在地上,
         所以那個 setTimeout 一定要留,不然舊 PWA 上按了會**完全沒反應**。 */
  function hardReload(){
    const fresh=location.pathname+"?fresh="+Date.now()+location.hash;
    if(parent!==window){
      try{ parent.postMessage({t:"bingo.fs",act:"hardreload"},"*"); }catch(_){}
      setTimeout(()=>location.replace(fresh),1200);
      return;
    }
    location.replace(fresh);
  }
  /* 重載後的回饋。★ 一定要有 —— 按完「清除快取」最需要知道的就是「到底有沒有換到版」,
     而沒換到版通常不是這顆按鈕壞了,是伺服器上真的還沒有新版(剛推完要等 CDN)。
     ⚠ 只移除 fresh 這一個參數,不要整份 search 清掉(留給以後可能有的其他參數)。 */
  function hardRefreshLanded(){
    const s=location.search;
    if(!/[?&]fresh=/.test(s))return;
    const kept=s.replace(/^\?/,"").split("&").filter(p=>p && !/^fresh=/.test(p)).join("&");
    try{ history.replaceState(null,"",location.pathname+(kept?"?"+kept:"")+location.hash); }catch(_){}
    let from="";
    try{ from=sessionStorage.getItem(HARD_FROM_KEY)||""; sessionStorage.removeItem(HARD_FROM_KEY); }catch(_){}
    const m=document.querySelector('meta[name="version"]'), v=m?m.content:"";
    setTimeout(()=>{
      if(from && v && from!==v) showToast("已更新到 v"+v+" 🎉",2600);
      else showToast("快取已清除(伺服器上還是 v"+v+")",3000);
    },1000);
  }
  /* 讓設定頁的版號可以按。★ 刻意**不動 HTML** —— `.set-foot` 那一行的 <span id="setVer">
     十三頁一字不差,在 JS 裡加 class 就十三頁一起有了。
     ⚠ 頂列的 #topVer 刻意**不綁**:那顆在對局中一直看得到,誤按的代價太大
       (雖然 hardRefresh() 有 updSafe 擋著,但少一個誤觸點就是少一個)。 */
  function armHardRefresh(el){
    if(!el || el.dataset.hu==="1")return;
    el.dataset.hu="1";
    el.classList.add("hu-ver");
    el.title="清除快取並強制更新(不會清掉設定、暱稱與自訂語音)";
    el.addEventListener("click",hardRefresh);
  }

  /* ---------- 載入空窗的收尾(v1.160.0) ----------
     各頁 main.js 的**最後一行**呼叫它,把 <html class="boot-wait"> 拿掉 → 按鈕才真的能按。
     要解決的事:各頁的 <script> 全在 </body> 前,CSS 在 <head> —— 慢網下畫面會**比程式早到**,
     那段期間按鈕的 addEventListener 一行都還沒跑,使用者按了完全沒反應、也沒有任何提示
     (使用者回報「暗棋按了沒反應,等久一點又會可以」就是這個)。
     ⚠ 漏呼叫的下場是「那一頁的按鈕永遠灰著」—— 比原本的問題更糟,所以有測試守著
       (tools/test-boot.js:十三頁都要有 class、十三支 main.js 都要呼叫)。
     ⚠ 一定要放在**同步啟動流程跑完之後**;setTimeout 裡的收尾(例如 maybeShowInstallTip)
       不算,那些晚一點跑不影響「按鈕能不能按」。
     ★ 提示條與灰化都是純 CSS(計時器是 animation 的 delay)—— 這一刻壞掉的東西正是 JS,
       用 setTimeout 做的計時器在這裡跟按鈕一樣不會跑。細節在 styles.css 檔尾那一節。
     ⚠ 這一支是**雙胞胎**,js/main.js 有對應的一份給 Bingo(紅線 4)。 */
  function bootReady(){
    try{ document.documentElement.classList.remove("boot-wait"); }catch(_){}
  }

  buildSwatches();
  loadPrefs();
  applyGridCols();syncSizeSeg();
  render();applyFillUI();
  syncSettingsUI();
  enterHome();     // 進場先顯示主選單(選單機 / 連線)
  initBoardFit();  // 號碼格自適應:掛上版面觀察並算第一次的可用高度(必須在 enterHome 之後,版面已定案)
  hardRefreshLanded();   // 上一輪是按「強制更新」重載進來的話:抹掉 ?fresh= 並回報有沒有真的換到版
  initUpdateCheck();
  initFullscreenKeep();   // 全螢幕跨頁保持:從五子棋/數獨回來後,第一個手勢自動接回全螢幕
  /* 即時語音的兩顆鈕(v1.183.0)。★ Bingo **不載入 js/shared/ui-kit.js**,
     那邊是由 bindCommonUI() 代叫的,這裡自己叫一次。
     ★★ UI 那一半住在 talk.js 自己身上 → 這一頁**不必**再抄一份紅線 4 的雙胞胎,
        只有這一行 + online.js 的幾個掛載點。
     ⚠ 一定要 typeof 判斷:talk.js 是選配的,直接寫 Talk 會是 ReferenceError。 */
  if (typeof Talk !== "undefined" && Talk) Talk.bindUi();
  /* 房間分享(QR + Web Share)。同 talk.js:UI 住在 js/shared/qr.js 自己身上,
     所以 Bingo 這一頁也只有這一行 + online.js 的兩個掛載點,沒有雙胞胎。
     ⚠ 一定要 typeof 判斷:qr.js 是選配的。 */
  if (typeof RoomShare !== "undefined" && RoomShare) RoomShare.bindUi();
  HomeLive.boot();        // 首頁「現在有人在玩」看板:idle 後才載 Firebase SDK,首屏不等它
  // iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
  setTimeout(maybeShowInstallTip,1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

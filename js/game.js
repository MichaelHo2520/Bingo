"use strict";

  const THEMES=["sunset","midnight","bubblegum","meadow","arcade"];
  const THEME_NAMES={sunset:"落日",midnight:"午夜霓虹",bubblegum:"泡泡糖",meadow:"草原",arcade:"街機",ebook:"電子書"};
  const THEME_COLORS={sunset:["#ff8a3d","#ffd24a"],midnight:["#22e0ff","#ff4bd8"],bubblegum:["#ff4fa3","#9b6bff"],meadow:["#6cc04a","#ffcf47"],arcade:["#ffe600","#ff2d55"]};
  const $=id=>document.getElementById(id);
  const grid=$("grid");

  /* ---------- Board size (5/6/7) ---------- */
  let SIZE=5;                             // 目前盤面邊長(5×5 / 6×6 / 7×7)
  function nCells(){ return SIZE*SIZE; }  // 格子總數 = 號碼上限(1..nCells)
  function maxLines(){ return 2*SIZE+2; } // 可能連線總數(橫+直+2 斜)= 勝利線數上限
  // 依邊長算出所有連線(N 橫 + N 直 + 2 斜)的格子索引
  function buildLines(n){
    const L=[];
    for(let r=0;r<n;r++){ const a=[]; for(let c=0;c<n;c++)a.push(r*n+c); L.push(a); }
    for(let c=0;c<n;c++){ const a=[]; for(let r=0;r<n;r++)a.push(r*n+c); L.push(a); }
    const d1=[],d2=[]; for(let k=0;k<n;k++){ d1.push(k*n+k); d2.push(k*n+(n-1-k)); }
    L.push(d1,d2);
    return L;
  }
  let LINES=buildLines(SIZE);
  // 套用格線欄列數與字級(格子越多字越小);--cellfont 由 .cell 讀取
  function applyGridCols(){
    grid.style.gridTemplateColumns="repeat("+SIZE+",1fr)";
    grid.style.gridTemplateRows="repeat("+SIZE+",1fr)";
    const fonts={5:"clamp(20px,6.5vw,40px)",6:"clamp(17px,5.4vw,33px)",7:"clamp(15px,4.6vw,28px)"};
    // 格子越多 → 間距/圓角縮小,把空間讓給格子本身,增加手機觸控面積、減少 6×6 / 7×7 的誤觸
    const gaps={5:"clamp(6px,1.6vw,10px)",6:"clamp(5px,1.3vw,8px)",7:"clamp(4px,1.1vw,6px)"};
    const radii={5:"16px",6:"13px",7:"10px"};
    grid.style.setProperty("--cellfont", fonts[SIZE]||fonts[5]);
    grid.style.setProperty("--gap", gaps[SIZE]||gaps[5]);
    grid.style.setProperty("--cellradius", radii[SIZE]||radii[5]);
  }
  function clampTarget(){ state.target=Math.min(maxLines(),Math.max(1,state.target)); const t=$("targetVal"); if(t)t.textContent=state.target; }
  function syncSizeSeg(){ const seg=$("sizeSeg"); if(!seg)return; [...seg.children].forEach(b=>b.classList.toggle("on", (+b.dataset.size)===SIZE)); }
  // 切換盤面大小:重算連線、重發卡片、重畫;連線時由房主寫入、訪客跟著套用
  function setSize(n){
    if(!(n>=5&&n<=7))return;
    SIZE=n; LINES=buildLines(n);
    state.card=(state.fill==="manual"&&state.mode==="setup") ? Array(nCells()).fill(0) : shuffled();
    state.marked=Array(nCells()).fill(false);
    applyGridCols(); clampTarget(); syncSizeSeg();
    render(); applyFillUI();
  }

  let state={
    mode:"setup",        // setup | play
    fill:"auto",         // auto | manual
    target:5,
    card:shuffled(),     // nCells 個號碼 (手動模式未填為 0)
    marked:Array(nCells()).fill(false),
    lastLines:0,
    online:false,
    won:false
  };

  function shuffled(){
    const a=Array.from({length:nCells()},(_,i)=>i+1);
    for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
    return a;
  }

  /* ---------- Rendering ---------- */
  function render(){
    grid.innerHTML="";
    const manual = state.mode==="setup" && state.fill==="manual";
    for(let i=0;i<nCells();i++){
      const cell=document.createElement("button");
      cell.className="cell";
      cell.dataset.i=i;
      const val=state.card[i];
      cell.innerHTML=`<span class="daub"></span><span class="num">${val?val:""}</span>`;

      if(state.mode==="play"){
        if(state.marked[i])cell.classList.add("marked");
        if(state.online){
          const called=MP.isCalled(val);
          if(MP.isMyTurn() && !called){ cell.classList.add("callable"); cell.style.cursor="pointer"; cell.addEventListener("click",()=>MP.tap(i)); }
          else { cell.disabled=true; cell.style.cursor="default"; }
        }
        else cell.addEventListener("click",()=>toggle(i));
        cell.setAttribute("aria-pressed",state.marked[i]?"true":"false");
      }else if(manual){
        if(!val)cell.classList.add("empty-cell");
        cell.addEventListener("click",()=>manualTap(i));
      }else{ // auto preview
        cell.disabled=true;cell.style.cursor="default";
      }
      grid.appendChild(cell);
    }
    if(state.mode==="play")refreshLines();
  }

  /* ---------- Manual: tap to place ---------- */
  function smallestMissing(){
    const used=new Set(state.card.filter(n=>n>0));
    for(let n=1;n<=nCells();n++) if(!used.has(n)) return n;
    return null;
  }
  function manualTap(i){
    const had=state.card[i]>0;
    if(had){                          // take back -> free just this number
      state.card[i]=0;
      Sound.takeback();
    }else{                            // place the smallest available number
      const n=smallestMissing();
      if(n==null)return;
      state.card[i]=n;
      Sound.place();
    }
    render();
    if(!had){                         // little pop on the newly placed cell
      grid.children[i].classList.add("just-placed");
    }
    updateManualUI();
  }
  function updateManualUI(){
    const filled=state.card.filter(n=>n>0).length, ok=filled===nCells();
    $("startBtn").disabled=!ok;
    $("startBtn").style.opacity=ok?"1":".5";
    if(state.online)MP.readyEnabled(ok);
    refreshActionHint();   // 手動填號進度改變 → 更新「填好卡片 / 可以準備」提示
  }

  /* ---------- Play ---------- */
  function toggle(i){
    if(state.won)return;
    state.marked[i]=!state.marked[i];
    state.marked[i]?Sound.mark():Sound.unmark();
    const cell=grid.children[i];
    cell.classList.toggle("marked",state.marked[i]);
    cell.setAttribute("aria-pressed",state.marked[i]?"true":"false");
    refreshLines();
  }

  function refreshLines(){
    const inLine=new Set();
    let done=0;
    LINES.forEach(line=>{
      if(line.every(idx=>state.marked[idx])){done++;line.forEach(idx=>inLine.add(idx));}
    });
    for(let i=0;i<nCells();i++)grid.children[i].classList.toggle("inline",inLine.has(i));

    $("lineCount").textContent=done;
    $("remain").textContent=Math.max(0,state.target-done);
    // marquee bulbs
    const bulbs=$("marquee").children;
    for(let k=0;k<5;k++)bulbs[k].classList.toggle("lit", k < Math.min(done,5));

    if(done>state.lastLines && done<state.target)Sound.line();
    state.lastLines=done;

    if(state.online){
      MP.reportLines(done);
      if(done>=state.target) MP.tryWin(done);
      return;
    }
    if(done>=state.target && !state.won){ state.won=true; win(done); }
  }

  /* ---------- Win ---------- */
  function win(done){
    Sound.win();
    $("winWord").textContent="BINGO!";
    $("winMsg").textContent=`你完成了 ${done} 條線 🎉`;
    $("spWinBtns").classList.remove("hidden");
    $("mpWinBtns").classList.add("hidden");
    $("winScores").classList.add("hidden"); $("winChamp").classList.add("hidden"); $("mpNewSeason").classList.add("hidden");   // 單機:不顯示連線排行/冠軍
    showResult();
    burst();
  }
  // 叫出結果卡(順便收起「看結果」浮動鈕)
  function showResult(){ $("reopenWin").classList.add("hidden"); $("veil").classList.add("show"); }
  // 徹底收掉結果(重來/離開時用):卡片與浮動鈕都關
  function closeWin(){ $("veil").classList.remove("show"); $("reopenWin").classList.add("hidden"); }
  // 只把結果卡收起來看牌面,留一顆浮動鈕可再叫回結果
  function peekBoard(){ $("veil").classList.remove("show"); $("reopenWin").classList.remove("hidden"); }

  /* ---------- Mode switches ---------- */
  function toSetup(){
    state.mode="setup";state.won=false;closeWin();
    $("setup").classList.remove("hidden");
    $("setupActions").classList.remove("hidden");
    $("playStatus").classList.add("hidden");
    updateRoomTabs(true,"fill");   // 單機重新設定:分頁預設回「填號」,直接看到卡片
    resetMarquee();
    render();
    applyFillUI();
  }
  // 主選單:進場先選「單機 / 連線」;離開房間、單機返回都回到這裡
  function enterHome(){
    state.mode="home"; state.won=false; state.online=false; closeWin();
    document.body.classList.add("at-home");          // 藏頂列跑馬燈,主選單只留大標題那個 BINGO
    $("home").classList.remove("hidden");
    $("setup").classList.add("hidden");
    $("setupActions").classList.add("hidden");
    $("mpConnect").classList.add("hidden");
    $("mpBar").classList.add("hidden");
    $("soloHead").classList.add("hidden");   // 回主選單:收起單機返回列(修正返回後主頁殘留返回鈕)
    $("boardWrap").classList.add("hidden");
    $("playStatus").classList.add("hidden");
    updateRoomTabs(false);   // 主選單不顯示房間分頁列
    document.body.classList.remove("mp-on");
    resetMarquee();
  }
  // 從主選單進「單機」:顯示棋盤與單機設定,開全新一局(連線相關列/鈕都收起)
  function enterSolo(){
    state.online=false;
    document.body.classList.remove("at-home");       // 離開主選單 → 恢復頂列跑馬燈
    $("home").classList.add("hidden");
    $("mpConnect").classList.add("hidden");
    $("mpBar").classList.add("hidden");
    $("boardWrap").classList.remove("hidden");
    $("setup").classList.remove("hidden");
    $("setupActions").classList.remove("hidden");
    $("soloHead").classList.remove("hidden");       // 單機才顯示「回主選單」返回列
    $("startBtn").classList.remove("hidden");
    $("onlineBtn").classList.add("hidden");          // 連線改由主選單進入
    $("mpReadyBtn").classList.add("hidden");
    $("mpStartBtn").classList.add("hidden");
    $("mpOrderRow").classList.add("hidden");
    $("scoreRow").classList.add("hidden");           // 計分列是連線專用
    $("sizeRow").style.display="";
    $("targetRow").style.display="";
    $("playStatus").classList.add("hidden");
    state.mode="setup"; state.won=false; state.fill="auto"; state.card=shuffled();
    updateRoomTabs(true,"fill");   // 單機:分頁預設「填號」,常見流程(自動填號→開始)一進來就看到卡片
    closeWin(); resetMarquee(); render(); applyFillUI();
  }
  function startGame(){
    if(state.fill==="manual" && state.card.some(n=>!n))return;
    state.mode="play";state.marked=Array(nCells()).fill(false);state.won=false;state.lastLines=0;
    Sound.start();
    updateRoomTabs(false);   // 開始遊戲:收起分頁列,棋盤佔滿
    $("setup").classList.add("hidden");
    $("setupActions").classList.add("hidden");
    $("playStatus").classList.remove("hidden");
    render();
  }
  function restart(){
    state.marked=Array(nCells()).fill(false);state.won=false;state.lastLines=0;closeWin();
    resetMarquee();render();
  }
  function resetMarquee(){[...$("marquee").children].forEach(b=>b.classList.remove("lit"));}

  /* ---------- 房間分頁:把「設定」與「號碼格」拆成兩個分頁,避免畫面一次太長 ---------- */
  let roomTab="fill";   // 目前分頁:'settings'=設定列 / 'fill'=號碼格
  // 連線中「已按準備好了」= 鎖定:此時把填號方式列與換一組骰子都收起(取消準備再顯示)
  function amReadyLock(){ return !!(state.online && typeof MP!=="undefined" && MP.amReady && MP.amReady()); }
  function applyRoomTab(){
    const settingsOn = roomTab==="settings";
    // 設定列只在「設定」分頁;填號方式列 + 號碼格 只在「填號」分頁(已準備好也收起填號方式列)
    $("setup").classList.toggle("tab-hidden", !settingsOn);
    $("fillRow").classList.toggle("tab-hidden", settingsOn || amReadyLock());
    $("boardWrap").classList.toggle("tab-hidden", settingsOn);
    // body 記住目前分頁:填號分頁才給內容區底部留白(清出右下浮動鈕的空間)
    document.body.classList.toggle("room-tab-fill", !settingsOn);
    document.body.classList.toggle("room-tab-settings", settingsOn);
    const bar=$("roomTabs"); if(bar)[...bar.children].forEach(b=>b.classList.toggle("on", b.dataset.tab===roomTab));
    const sa=$("scrollArea"); if(sa)sa.scrollTop=0;   // 切換分頁時捲回頂端,兩個分頁各自從頭看(不再共用捲動位置)
    updateReshuffleBtn();
  }
  // show=true:進入 setup/大廳 → 顯示分頁列 + 主要動作列並套用目前分頁(defaultTab 指定預設頁)
  // show=false:離開(進遊戲/猜拳/主選單) → 收起分頁列/主要動作列/填號列,setup 與 boardWrap 的顯示交還給各流程的 .hidden
  function updateRoomTabs(show, defaultTab){
    const bar=$("roomTabs"); if(!bar)return;
    if(!show){
      bar.classList.add("hidden");
      $("primaryBar").classList.add("hidden");
      document.body.classList.remove("has-primary-bar");   // 收起固定底部動作列 → 移除為它預留的底部空間
      document.body.classList.remove("room-tab-fill","room-tab-settings");   // 離開設定/大廳 → 清掉分頁留白
      $("setup").classList.remove("tab-hidden");
      $("boardWrap").classList.remove("tab-hidden");
      $("fillRow").classList.add("tab-hidden");   // 填號方式列只屬於大廳/設定的「填號」分頁,離開一律收起
      updateReshuffleBtn();   // 進遊戲/離開 → 收起右下換一組浮動鈕
      return;
    }
    if(defaultTab)roomTab=defaultTab;
    bar.classList.remove("hidden");
    $("primaryBar").classList.remove("hidden");
    document.body.classList.add("has-primary-bar");   // 準備/開始固定在畫面最下方 → body 預留底部空間,分頁內容照常捲動
    applyRoomTab();
    refreshActionHint();
  }

  /* ---------- 主要動作列的「現在該做什麼」提示 ---------- */
  function setActionHint(text){
    const el=$("actionHint"); if(!el)return;
    el.textContent=text||"";
    el.classList.toggle("hidden", !text);
  }
  // 單機交給這裡、連線轉給 MP.refreshHint()(它握有 players/ready/isHost 等狀態)
  function refreshActionHint(){
    if(state.online){ if(MP&&MP.refreshHint)MP.refreshHint(); return; }
    if(state.mode==="setup" && state.fill==="manual" && state.card.some(n=>!n)) setActionHint("把空格都填上號碼,就能開始 ▸");
    else setActionHint("");
  }

  function applyFillUI(){
    const manual=state.fill==="manual";
    updateReshuffleBtn();
    if(manual){ updateManualUI(); }
    else {
      $("startBtn").disabled=false;$("startBtn").style.opacity="1";
      if(state.online)MP.readyEnabled(true);
      refreshActionHint();
    }
  }
  // 右下浮動「換一組」鈕:只在「設定中 + 填號分頁 + 自動填號」時出現(手動填號 / 設定分頁 / 遊戲中都收起)
  function updateReshuffleBtn(){
    const btn=$("reshuffleBtn"); if(!btn)return;
    const inRoom = !$("roomTabs").classList.contains("hidden");   // 分頁列有顯示=正在設定/大廳
    // 已按準備好了(連線)就收起,避免準備後還能換卡
    const show = inRoom && roomTab==="fill" && state.mode==="setup" && state.fill==="auto" && !amReadyLock();
    btn.classList.toggle("hidden", !show);
  }

  /* ---------- Confetti ---------- */
  function burst(){
    if(document.documentElement.getAttribute("data-theme")==="ebook")return;
    const cv=$("confetti"),ctx=cv.getContext("2d");
    cv.width=innerWidth;cv.height=innerHeight;
    const cs=getComputedStyle(document.documentElement);
    const cols=[cs.getPropertyValue("--accent"),cs.getPropertyValue("--accent-2"),cs.getPropertyValue("--daub"),cs.getPropertyValue("--marquee")].map(s=>s.trim());
    const P=Array.from({length:140},()=>({
      x:innerWidth/2,y:innerHeight*.35,
      vx:(Math.random()-.5)*14,vy:Math.random()*-15-4,
      g:.35+Math.random()*.2,s:6+Math.random()*8,
      c:cols[Math.floor(Math.random()*cols.length)],
      r:Math.random()*6,vr:(Math.random()-.5)*.4
    }));
    let t=0;
    (function loop(){
      ctx.clearRect(0,0,cv.width,cv.height);t++;
      P.forEach(p=>{p.vy+=p.g;p.x+=p.vx;p.y+=p.vy;p.r+=p.vr;
        ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.r);ctx.fillStyle=p.c;
        ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s*.6);ctx.restore();});
      if(t<160)requestAnimationFrame(loop);else ctx.clearRect(0,0,cv.width,cv.height);
    })();
  }

  /* ---------- Theme & fullscreen ---------- */
  let lastColorTheme="sunset";
  let bgmOn=false, bgmVol=0.35;   // 背景音樂:是否開啟、音量(0~1);預設關,音量 35%
  let voiceVol=1.5;               // 收到語音的播放音量倍率(1=原音,可 >1 放大);預設 150%,範圍 0~3
  // 背景音樂可選曲目(檔案放 mp3/;第一個為預設)。新增曲目只要放檔 + 在這裡加一列
  const BGM_TRACKS=[
    { id:"default", name:"歡樂(預設)",     src:"mp3/bgm.mp3" },
    { id:"sunday",  name:"Sunday Morning", src:"mp3/Sunday_Morning_Win.mp3" }
  ];
  let bgmTrack="default";         // 目前選的曲目 id
  function bgmSrcOf(id){ const t=BGM_TRACKS.find(t=>t.id===id); return (t||BGM_TRACKS[0]).src; }
  const STORE_KEY="bingo.prefs.v1";
  function savePrefs(){
    try{
      const nameEl=$("mpName");
      localStorage.setItem(STORE_KEY, JSON.stringify({
        theme:lastColorTheme,
        ebook:document.documentElement.getAttribute("data-theme")==="ebook",
        muted:Sound.isMuted(),
        target:state.target,
        size:SIZE,
        bgmOn:bgmOn,
        bgmVol:bgmVol,
        bgmTrack:bgmTrack,
        voiceVol:voiceVol,
        scoreMode:(MP&&MP.scoreMode)?MP.scoreMode():"rank",   // 記住連線計分偏好(建房預設用)
        winGoal:(MP&&MP.winGoal)?MP.winGoal():3,
        name:nameEl?nameEl.value.trim():""
      }));
    }catch(e){/* storage unavailable -> just don't persist */}
  }
  function loadPrefs(){
    let p={}; try{ p=JSON.parse(localStorage.getItem(STORE_KEY))||{}; }catch(e){ p={}; }
    if(p.theme && THEMES.indexOf(p.theme)>=0){
      lastColorTheme=p.theme;
      document.documentElement.setAttribute("data-theme",p.theme);
    }
    if(typeof p.size==="number" && p.size>=5 && p.size<=7){ setSize(p.size); }
    if(typeof p.target==="number"){
      state.target=Math.min(maxLines(),Math.max(1,p.target));
      $("targetVal").textContent=state.target;
    }
    if(p.muted){ Sound.setMuted(true); }
    if(typeof p.bgmVol==="number"){ bgmVol=Math.max(0,Math.min(1,p.bgmVol)); }
    BGM.setVolume(bgmVol);
    if(typeof p.bgmTrack==="string" && BGM_TRACKS.some(t=>t.id===p.bgmTrack)){ bgmTrack=p.bgmTrack; }
    BGM.setSrc(bgmSrcOf(bgmTrack));   // 套用記住的曲目(尚未播放時只是記下路徑,首次手勢才真正載入)
    if(typeof p.voiceVol==="number"){ voiceVol=Math.max(0,Math.min(3,p.voiceVol)); }
    if(MP&&MP.usePrefs){ MP.usePrefs(p.scoreMode, p.winGoal); }   // 帶回記住的連線計分偏好(建房預設)
    if(p.bgmOn){ bgmOn=true; }   // 記住「想開」;實際播放等首次使用者互動(繞過自動播放限制)
    if(p.ebook){ setEbook(true,true); }
    if(typeof p.name==="string" && p.name){ const nameEl=$("mpName"); if(nameEl) nameEl.value=p.name; }
  }

  /* ---------- Settings sheet ---------- */
  function buildSwatches(){
    const box=$("swatches"); if(!box)return; box.innerHTML="";
    THEMES.forEach(name=>{
      const b=document.createElement("button");
      b.type="button"; b.className="swatch"; b.dataset.theme=name;
      b.title=THEME_NAMES[name]; b.setAttribute("aria-label",THEME_NAMES[name]);
      const c=THEME_COLORS[name]||["#888","#555"];
      b.style.background="linear-gradient(135deg,"+c[0]+","+c[1]+")";
      b.addEventListener("click",()=>setTheme(name));
      box.appendChild(b);
    });
  }
  function setTheme(name){
    if(THEMES.indexOf(name)<0)return;
    if(document.documentElement.getAttribute("data-theme")==="ebook")return;   // locked in e-book mode
    document.documentElement.setAttribute("data-theme",name);
    lastColorTheme=name;
    savePrefs();
    syncSettingsUI();
  }
  function syncSettingsUI(){
    const isEbook=document.documentElement.getAttribute("data-theme")==="ebook";
    const swE=$("swEbook"), swM=$("swMute"), sw=$("swatches");
    if(swE)swE.setAttribute("aria-checked",isEbook?"true":"false");
    if(swM)swM.setAttribute("aria-checked",Sound.isMuted()?"false":"true");   // on = 有聲音
    if(sw){
      sw.classList.toggle("locked",isEbook);
      const active=isEbook?lastColorTheme:document.documentElement.getAttribute("data-theme");
      [...sw.children].forEach(b=>b.classList.toggle("on",b.dataset.theme===active));
    }
    const swB=$("swBgm"), volEl=$("bgmVol"), volRow=$("bgmVolRow");
    if(swB)swB.setAttribute("aria-checked",bgmOn?"true":"false");
    if(volEl)volEl.value=Math.round(bgmVol*100);
    if(volRow)volRow.classList.toggle("dim",!bgmOn);   // 關閉時音量列淡化
    const trkSel=$("bgmTrackSel");
    if(trkSel){
      if(!trkSel.options.length){   // 首次:用曲目清單建 <option>
        BGM_TRACKS.forEach(t=>{ const o=document.createElement("option"); o.value=t.id; o.textContent=t.name; trkSel.appendChild(o); });
      }
      trkSel.value=bgmTrack;
    }
    const trkRow=$("bgmTrackRow"); if(trkRow)trkRow.classList.toggle("dim",!bgmOn);
    const vvEl=$("voiceVol"); if(vvEl)vvEl.value=Math.round(voiceVol*100);
  }
  function openSettings(){ Sound.wake(); syncSettingsUI(); $("setVeil").classList.add("show"); }
  function closeSettings(){ $("setVeil").classList.remove("show"); }

  function setEbook(on,silent){
    const root=document.documentElement;
    if(on){
      if(root.getAttribute("data-theme")!=="ebook")lastColorTheme=root.getAttribute("data-theme");
      root.setAttribute("data-theme","ebook");
    }else{
      root.setAttribute("data-theme",lastColorTheme);
    }
    if(!silent)showToast(on?"電子書模式":THEME_NAMES[lastColorTheme]);
    savePrefs();
    syncSettingsUI();
  }
  function toggleEbook(){ setEbook(document.documentElement.getAttribute("data-theme")!=="ebook"); }
  // 背景音樂:開關(開→解鎖音訊並播放;關→停止),音量即時套用;都記憶偏好
  function setBgm(on){ bgmOn=!!on; if(bgmOn){ Sound.wake(); BGM.setOn(true); } else { BGM.setOn(false); } savePrefs(); syncSettingsUI(); }
  function setBgmVol(v){ bgmVol=Math.max(0,Math.min(1,v)); BGM.setVolume(bgmVol); }
  // 切換背景音樂曲目:即時套到 BGM(播放中會直接換曲),記憶偏好
  function setBgmTrack(id){
    if(!BGM_TRACKS.some(t=>t.id===id))return;
    bgmTrack=id; BGM.setSrc(bgmSrcOf(id)); savePrefs(); syncSettingsUI();
  }
  // 收到語音的音量:倍率 0~3(1=原音,>1 放大);每則語音播放時即時讀 voiceVol 套用,故不需即時改動已播節點
  function setVoiceVol(v){ voiceVol=Math.max(0,Math.min(3,v)); }
  let toastT;
  function showToast(txt,dur){
    let el=$("toast");
    if(!el){el=document.createElement("div");el.id="toast";document.body.appendChild(el);}
    el.textContent=txt;
    el.classList.add("show");
    clearTimeout(toastT);
    toastT=setTimeout(()=>el.classList.remove("show"),dur||1100);
  }
  function toggleFull(){
    const de=document.documentElement;
    const req=de.requestFullscreen||de.webkitRequestFullscreen;   // webkit:舊 Safari/Android
    const exit=document.exitFullscreen||document.webkitExitFullscreen;
    const fsEl=document.fullscreenElement||document.webkitFullscreenElement;
    if(req){
      if(fsEl){ exit&&exit.call(document); }
      else{ req.call(de); }
    }else{
      // iOS Safari(iPhone)不支援 Fullscreen API → 引導改用「加入主畫面」以全螢幕開啟
      const standalone = ("standalone" in navigator && navigator.standalone) ||
                         (matchMedia&&matchMedia("(display-mode: standalone)").matches);
      showToast(standalone ? "已是全螢幕模式 👍"
                           : "iOS 請按 Safari 分享鈕 → 加入主畫面,即可全螢幕", 3000);
    }
  }

  /* ---------- 好友互動表情(連線用) ---------- */
  const EMOTES=["👍","👎","❤️","😂","🎉","🔥","👏","😮","😢","😭","😎","🤯","🥳","🤝","🙏","💪","😡","💩"];
  const PHRASES=["快一點!","你好慢~","加油~~","太扯了😂","穩住穩住","別緊張","嚇死我了","運氣真好"];
  let emoteTarget="all";                       // 目前要傳給誰:"all" 或某玩家 id
  function openEmote(target){
    if(!state.online)return;
    const roster=MP.roster();
    emoteTarget = (target && target!=="all" && roster.some(p=>p.id===target)) ? target : "all";
    buildEmoteRecipients(); buildEmoteGrid(); buildEmotePhrases();
    const inp=$("emoteText"); if(inp)inp.value="";
    resetVoiceBtn(); const vh=$("voiceHint"); if(vh)vh.textContent="";
    Sound.wake();
    $("emoteVeil").classList.add("show");
  }
  // 錄音期間也要停背景音樂:Android 一開麥克風(getUserMedia)整個音訊會被 OS 切到「通話路徑」
  // (VOICE_COMMUNICATION),此時還在播的背景音樂就被硬走聽筒/通話音質,變得很難聽。錄音與「收語音
  // 播放」共用同一個 BGM.duck,任一在進行就停,兩者都結束才恢復(避免其一提早 duck(false) 蓋掉另一個)。
  let voiceRecording=false;
  function refreshBgmDuck(){ try{ BGM.duck(voiceRecording || voiceBusy); }catch(e){} }
  function closeEmote(){ const v=$("emoteVeil"); if(v)v.classList.remove("show"); Voice.cancel(); voiceRecording=false; refreshBgmDuck(); resetVoiceBtn(); }
  /* ---- 語音留言:錄音鈕狀態機(閒置 → 錄音倒數 → 送出) ---- */
  let voiceTick=null;
  function resetVoiceBtn(){
    const b=$("voiceBtn"); if(voiceTick){ clearInterval(voiceTick); voiceTick=null; }
    if(!b)return; b.classList.remove("rec"); b.disabled=false; b.textContent="🎤 錄音留言";
  }
  function toggleVoice(){
    const b=$("voiceBtn"), hint=$("voiceHint"); if(!b)return;
    if(hint)hint.textContent="";
    if(!Voice.supported()){ if(hint)hint.textContent="此裝置/瀏覽器不支援錄音"; return; }
    if(Voice.recording()){ b.disabled=true; b.textContent="處理中…"; Voice.stop(); return; }   // 停止 → 交給 onBlob 收尾
    markAudioArmed(); Sound.wake(); kickVoiceQueue();   // 按麥克風=手勢,順手解鎖播放音訊並補播等待中的語音
    const to=emoteTarget;
    b.disabled=true; b.textContent="準備中…";
    voiceRecording=true; refreshBgmDuck();   // 先停背景音樂,再開麥克風(避免 Android 通話路徑把音樂弄難聽)
    Voice.start((wav)=>{
      voiceRecording=false; refreshBgmDuck();  // 錄音結束:恢復背景音樂(若還有收到的語音在播,duck 會維持到播完)
      resetVoiceBtn();
      if(!wav || wav.byteLength<=44){ if(hint)hint.textContent="沒有錄到聲音"; return; }
      try{
        const url=Voice.toDataURL(wav);
        if(url.length>200000){ if(hint)hint.textContent="語音太長,請再短一點"; return; }   // RTDB 友善上限(WAV 較大)
        MP.sendEmote(to,"🎤","voice",url);
        closeEmote();
      }catch(e){ if(hint)hint.textContent="語音處理失敗"; }
    }).then(()=>{
      b.disabled=false; b.classList.add("rec");
      let left=Math.ceil(Voice.MAX_MS/1000);
      b.textContent="⏹ 停止 · "+left+"s";
      voiceTick=setInterval(()=>{ left--; if(left<=0){ if(voiceTick){clearInterval(voiceTick);voiceTick=null;} return; } b.textContent="⏹ 停止 · "+left+"s"; },1000);
    }).catch(err=>{
      voiceRecording=false; refreshBgmDuck();   // 開麥失敗:恢復背景音樂
      resetVoiceBtn();
      if(hint)hint.textContent=(err&&err.name==="NotAllowedError")?"麥克風權限被拒絕":"無法啟動錄音";
    });
  }
  /* ---- 快速語音留言:浮動鈕直接錄音、送給全部人(沿用面板同一套 Voice) ---- */
  let qvTick=null;
  function resetQuickVoiceBtn(){
    const b=$("quickVoiceBtn"); if(qvTick){ clearInterval(qvTick); qvTick=null; }
    if(!b)return; b.classList.remove("rec"); b.disabled=false;
    const ico=$("qvIco"), lab=$("qvLabel"); if(ico)ico.textContent="🎤"; if(lab)lab.textContent="語音";
  }
  function toggleQuickVoice(){
    const b=$("quickVoiceBtn"); if(!b||!state.online)return;
    const ico=$("qvIco"), lab=$("qvLabel");
    if(!Voice.supported()){ showToast("此裝置/瀏覽器不支援錄音"); return; }
    if(Voice.recording()){ b.disabled=true; if(lab)lab.textContent="處理中…"; Voice.stop(); return; }  // 停止 → 交給 onBlob 收尾
    markAudioArmed(); Sound.wake();   // 按麥克風=手勢,順手解鎖播放音訊(這也是「按著麥克風時收到的語音就會自動播」的原因)
    kickVoiceQueue();                 // 若正好有語音在膠囊裡等,趁這個手勢一起補播
    b.disabled=true; if(lab)lab.textContent="準備中…";
    voiceRecording=true; refreshBgmDuck();   // 先停背景音樂,再開麥克風(避免 Android 通話路徑把音樂弄難聽)
    Voice.start((wav)=>{
      voiceRecording=false; refreshBgmDuck();  // 錄音結束:恢復背景音樂(若還有收到的語音在播,duck 會維持到播完)
      resetQuickVoiceBtn();
      if(!wav || wav.byteLength<=44){ showToast("沒有錄到聲音"); return; }
      try{
        const url=Voice.toDataURL(wav);
        if(url.length>200000){ showToast("語音太長,請再短一點"); return; }   // RTDB 友善上限
        MP.sendEmote("all","🎤","voice",url);
        showToast("已送出語音給全部人 🎤");
      }catch(e){ showToast("語音處理失敗"); }
    }).then(()=>{
      b.disabled=false; b.classList.add("rec"); if(ico)ico.textContent="⏹";
      let left=Math.ceil(Voice.MAX_MS/1000);
      if(lab)lab.textContent=left+"s";
      qvTick=setInterval(()=>{ left--; if(left<=0){ if(qvTick){clearInterval(qvTick);qvTick=null;} return; } if(lab)lab.textContent=left+"s"; },1000);
    }).catch(err=>{
      voiceRecording=false; refreshBgmDuck();   // 開麥失敗:恢復背景音樂
      resetQuickVoiceBtn();
      showToast((err&&err.name==="NotAllowedError")?"麥克風權限被拒絕":"無法啟動錄音");
    });
  }
  // 播放收到的語音:優先走 Web Audio(用已解鎖的 AudioContext + decodeAudioData,
  // 繞過 iOS 對 new Audio().play() 的自動播放封鎖、也能解 WAV);失敗再退回 HTMLAudio。靜音時不播。
  function fallbackAudio(u,onEnd){
    // HTMLAudio 的 .volume 上限為 1(無法放大),故只套用 0~1 那段;放大要靠 Web Audio 主路徑的 GainNode
    try{ const a=new Audio(u); try{ a.volume=Math.max(0,Math.min(1,voiceVol)); }catch(e){} if(onEnd){ a.onended=onEnd; a.onerror=onEnd; } const p=a.play(); if(p&&p.catch)p.catch(()=>{ if(onEnd)onEnd(); }); }
    catch(e){ if(onEnd)onEnd(); }
  }
  // 播放單則語音,播完(或失敗)呼叫 onEnd;Web Audio 優先(繞過 iOS 自動播放封鎖、可解 WAV),失敗退回 HTMLAudio
  function playVoiceOnce(dataURL,onEnd){
    let called=false; const done=()=>{ if(called)return; called=true; if(onEnd)onEnd(); };
    let bytes;
    try{
      const i=dataURL.indexOf(","); if(i<0)throw 0;
      const bin=atob(dataURL.slice(i+1)); bytes=new Uint8Array(bin.length);
      for(let k=0;k<bin.length;k++)bytes[k]=bin.charCodeAt(k);
    }catch(e){ fallbackAudio(dataURL,done); return; }
    const c=Sound.ctx&&Sound.ctx();
    if(!c){ fallbackAudio(dataURL,done); return; }
    const play=()=>{
      try{
        c.decodeAudioData(bytes.buffer.slice(0),
          b=>{ try{ const s=c.createBufferSource(); s.buffer=b; const g=c.createGain(); g.gain.value=voiceVol; s.connect(g); g.connect(c.destination); s.onended=done; s.start(); }catch(e){ fallbackAudio(dataURL,done); } },
          ()=>fallbackAudio(dataURL,done));
      }catch(e){ fallbackAudio(dataURL,done); }
    };
    if(c.state==="suspended") c.resume().then(play).catch(play); else play();
  }
  // 語音播放佇列:多則語音「依收到先後」排隊逐一播、不重疊;整個佇列播放期間停背景音樂,全部播完再恢復
  const voiceQueue=[]; let voiceBusy=false, voiceSafety=null;
  // audioArmed =「使用者手勢已解鎖音訊、且之後沒切到背景」。iOS 有個惡名昭彰的狀況:切到別的 App 再回來,
  // AudioContext 的 state 仍是 "running" 卻其實不出聲——只看 Sound.running() 會被騙,把語音「靜音播掉」(使用者只看到 🎤 飛一下就沒了、沒聲音)。
  // 因此在觸控裝置(iOS/Android)上,收到語音要不要自動播,除了 context 在跑,還要求「這回合有真的手勢解鎖過」;否則一律改顯示可點的播放膠囊。
  const IS_TOUCH = ("ontouchstart" in window) || (navigator.maxTouchPoints>0);
  let audioArmed=false;
  function markAudioArmed(){ audioArmed=true; }      // 由真實手勢(點播放膠囊 / 按麥克風 / 首次互動解鎖)呼叫
  function markAudioStale(){ audioArmed=false; }     // 切到背景 → 下次回前景要重新用手勢解鎖才自動播
  function enqueueVoice(dataURL){
    if(!dataURL)return;
    if(Sound.isMuted&&Sound.isMuted())return;   // 靜音:不播也不排隊
    voiceQueue.push(dataURL);
    if(!voiceBusy) pumpVoice();
  }
  function pumpVoice(){
    if(voiceBusy)return;
    if(!voiceQueue.length){ hideVoiceGate(); refreshBgmDuck(); return; }   // 佇列清空 → 收起膠囊 + 恢復背景音樂
    // iOS 切背景/鎖屏會把 AudioContext 打回 suspended,非手勢情境下 resume() 會被忽略;更麻煩的是回前景後
    // state 常仍顯示 "running" 卻不出聲。此時「不硬播、也不丟棄」——語音留在佇列裡,改顯示可點的「🔊 點擊播放」膠囊,
    // 等使用者手勢再播(順手根治舊版「9 秒 timeout 把播不出來的語音丟出佇列、永久遺失」的 bug)。
    // 觸控裝置額外要求 audioArmed(這回合手勢解鎖過);桌機維持原本只看 context 是否在跑,不因切分頁就退回膠囊。
    if((IS_TOUCH && !audioArmed) || !(Sound.running && Sound.running())){ showVoiceGate(); return; }
    hideVoiceGate();
    const next=voiceQueue.shift();
    voiceBusy=true; refreshBgmDuck();                    // 開播 → 停背景音樂
    const advance=()=>{ if(!voiceBusy)return; if(voiceSafety){ clearTimeout(voiceSafety); voiceSafety=null; } voiceBusy=false; pumpVoice(); };
    voiceSafety=setTimeout(advance,9000);               // 保險:單則語音上限 6 秒,9 秒沒收到結束事件就強制接續,避免佇列卡住
    playVoiceOnce(next,advance);
  }
  // 「🔊 點擊播放」膠囊:收到語音但 AudioContext 未解鎖(iOS 切背景回來/尚未手勢)時顯示,數字為待播則數
  function showVoiceGate(){
    const g=$("voiceGate"); if(!g)return;
    const t=$("voiceGateTxt"), n=voiceQueue.length;
    if(t)t.textContent = n>1 ? ("🔊 "+n+" 則語音 · 點我播放") : "🔊 點我播放語音";
    g.classList.remove("hidden");
  }
  function hideVoiceGate(){ const g=$("voiceGate"); if(g)g.classList.add("hidden"); }
  // 點膠囊(在使用者手勢中):喚醒 AudioContext 後才開播,確保 iOS 放行
  function playVoiceGate(){
    markAudioArmed(); Sound.wake();   // 點膠囊本身就是手勢 → 標記音訊已解鎖,這回合之後收到的語音可自動播
    const go=()=>{ hideVoiceGate(); pumpVoice(); };
    if(Sound.resume) Sound.resume().then(go); else go();
  }
  // 回前景/任一手勢喚醒音訊後,若還有語音在等就補播(由 main.js / online.js 呼叫)
  function kickVoiceQueue(){ if(voiceQueue.length && !voiceBusy) pumpVoice(); }
  function buildEmoteRecipients(){
    const box=$("emoteTo"); if(!box)return; box.innerHTML="";
    const list=[{id:"all",name:"🌐 全部人"}].concat(MP.roster().filter(p=>!p.me).map(p=>({id:p.id,name:p.name})));
    if(!list.some(r=>r.id===emoteTarget)) emoteTarget="all";
    list.forEach(r=>{
      const b=document.createElement("button");
      b.type="button"; b.className="emote-to-btn"+(r.id===emoteTarget?" on":"");
      b.textContent=r.name;
      b.addEventListener("click",()=>{ emoteTarget=r.id; buildEmoteRecipients(); });
      box.appendChild(b);
    });
    const head=$("emoteHead");
    if(head) head.textContent = emoteTarget==="all" ? "傳給全部人" : "傳給 "+(MP.roster().find(p=>p.id===emoteTarget)||{}).name;
  }
  function buildEmoteGrid(){
    const g=$("emoteGrid"); if(!g)return; g.innerHTML="";
    EMOTES.forEach(em=>{
      const b=document.createElement("button");
      b.type="button"; b.className="emote-btn"; b.textContent=em;
      b.addEventListener("click",()=>{ MP.sendEmote(emoteTarget,em); closeEmote(); });
      g.appendChild(b);
    });
  }
  function buildEmotePhrases(){
    const g=$("emotePhrases"); if(!g)return; g.innerHTML="";
    PHRASES.forEach(tx=>{
      const b=document.createElement("button");
      b.type="button"; b.className="phrase-btn"; b.textContent=tx;
      b.addEventListener("click",()=>{ MP.sendEmote(emoteTarget,tx,"text"); closeEmote(); });
      g.appendChild(b);
    });
  }
  // 送出自己打的字(空白只送空格會被忽略;長度上限與 sendEmote 一致)
  function sendCustomText(){
    const inp=$("emoteText"); if(!inp)return;
    const tx=inp.value.trim();
    if(!tx)return;
    MP.sendEmote(emoteTarget,tx,"text"); inp.value=""; closeEmote();
  }
  // 顯示一個飛起的表情:定位到目標玩家的晶片(找不到就畫面中央),下方標註誰傳給誰
  function showEmote(emoji,caption,anchorId,kind){
    const layer=$("emoteFly"); if(!layer)return;
    let x=innerWidth/2, y=innerHeight*0.5;
    const grid=$("grid");          // 起點固定在棋盤正中央,往上飄(不再錨定玩家晶片)
    if(grid){ const g=grid.getBoundingClientRect(); if(g.width){ x=g.left+g.width/2; y=g.top+g.height/2; } }
    x += (Math.random()-0.5)*36;   // 一點點抖動,避免連發完全重疊
    const el=document.createElement("div"); el.className="emote-fly"+(kind==="text"?" is-text":"")+(kind==="voice"?" is-voice":"");
    el.style.left=x+"px"; el.style.top=y+"px";
    el.innerHTML='<span class="ef-emo">'+esc(emoji)+'</span><span class="ef-cap">'+esc(caption)+'</span>';   // esc:防止對方送入惡意內容
    layer.appendChild(el);
    setTimeout(()=>{ el.remove(); },2300);   // 用 timeout 移除(電子書模式關動畫仍會清掉)
  }
  function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }


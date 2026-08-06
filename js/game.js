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
  // 套用格線欄列數;欄列模板與字級都在 CSS 由 --cols / --cellsize 推導(字級不再逐級寫死 clamp)
  function applyGridCols(){
    // 格子越多 → 間距/圓角縮小,把空間讓給格子本身,增加手機觸控面積、減少 6×6 / 7×7 的誤觸
    const gaps={5:"clamp(6px,1.6vw,10px)",6:"clamp(5px,1.3vw,8px)",7:"clamp(4px,1.1vw,6px)"};
    const radii={5:"16px",6:"13px",7:"10px"};
    grid.style.setProperty("--cols", String(SIZE));
    grid.style.setProperty("--gap", gaps[SIZE]||gaps[5]);
    grid.style.setProperty("--cellradius", radii[SIZE]||radii[5]);
    scheduleBoardFit();
  }

  /* ---------- 盤面自適應:實測「剩餘可視高度」寫進 --boardpx ----------
     取代舊的 --board-cap 常數(依版面狀態寫死 160/170/240/300px)。那組常數實測低估上方佔用
     66px(連線遊戲中)~139px(連線大廳),且房間橫幅高度會隨玩家人數換行每列再多 48px,
     常數方案本質上不可能正確 → 矮螢幕 / 人多時號碼格必然溢出,使用者得上下捲。
     改成每次版面變動就量一次:
       可用高 = body 內容區高 − 文件流中的固定列(頂列/房間橫幅/分頁列/準備列)
                − 捲動區內非盤面的內容 − 盤面容器內非號碼格的內容 − 各層 flex gap
     量的都是「不受號碼格大小影響」的元素 → 不會與 ResizeObserver 形成回饋迴圈。 */
  let boardFitRaf=0, lastBoardPx=null;
  // 只算真正參與 flex 排版的子元素:display:none 與浮層(fixed/absolute)都不佔高度
  function flowChildren(parent){
    return [...parent.children].filter(el=>{
      const cs=getComputedStyle(el);
      return cs.display!=="none" && cs.position!=="fixed" && cs.position!=="absolute";
    });
  }
  function sumRows(parent, skip){
    const cs=getComputedStyle(parent), gap=parseFloat(cs.rowGap)||0;
    const rows=flowChildren(parent);
    let h=gap*Math.max(0,rows.length-1);
    rows.forEach(el=>{ if(el!==skip) h+=el.getBoundingClientRect().height; });
    return h;
  }
  function fitBoard(){
    const sa=$("scrollArea"), bw=$("boardWrap");
    if(!sa||!bw||!grid)return;
    if(getComputedStyle(bw).display==="none")return;   // 盤面沒顯示(設定分頁/主選單)→ 不必算,切回來時會重算
    const bodyCS=getComputedStyle(document.body);
    // body 用 height:100dvh,clientHeight 就是它自己的框高(含 padding、不含 border)
    const inner=document.body.clientHeight-(parseFloat(bodyCS.paddingTop)||0)-(parseFloat(bodyCS.paddingBottom)||0);
    const used=sumRows(document.body,sa)+sumRows(sa,bw)+sumRows(bw,grid);
    const px=Math.max(0,Math.round(inner-used));
    // 抖動門檻:手機工具列收放時不要每 1px 都重算。第一次(lastBoardPx 還是 null)一定要寫,
    // 否則算出 0 時會誤判「沒變」而不寫入,盤面就會退回 CSS 的 520px 保底值 → 反而爆版
    if(lastBoardPx!==null && Math.abs(px-lastBoardPx)<2)return;
    lastBoardPx=px;
    document.body.style.setProperty("--boardpx",px+"px");
  }
  function scheduleBoardFit(){
    if(boardFitRaf)return;
    boardFitRaf=requestAnimationFrame(()=>{ boardFitRaf=0; fitBoard(); });
  }
  // 掛上觀察:固定列的高度變動(玩家人數、分頁列/準備列顯隱、副標列收放)都要重算
  function initBoardFit(){
    const sa=$("scrollArea");
    if(typeof ResizeObserver!=="undefined"){
      const ro=new ResizeObserver(scheduleBoardFit);
      [...document.body.children].forEach(el=>{ if(el!==sa) ro.observe(el); });   // 略過捲動區本身,避免自我觸發
      ["setup","playStatus","fillRow","setupActions","mpOrderPanel"].forEach(id=>{ const el=$(id); if(el)ro.observe(el); });
    }
    addEventListener("resize",scheduleBoardFit);
    addEventListener("orientationchange",scheduleBoardFit);
    if(window.visualViewport) visualViewport.addEventListener("resize",scheduleBoardFit);
    fitBoard();
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
    // 連線遊戲中:盤面整體一律解除鎖定,不再依賴「進遊戲時 setLock(false) 有沒有把上一局的殘留鎖定清乾淨」。
    if(state.online && state.mode==="play") grid.style.pointerEvents="";
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
          if(MP.isMyTurn() && !called){ cell.classList.add("callable"); cell.style.cursor="pointer"; }
          else cell.style.cursor="default";
          // 一律綁定點擊 → 由 tap() 自行判定可否叫號並給回饋:輪到你就叫號、沒輪到你會跳「還沒輪到你」。
          // 不再用 disabled 讓非本回合的格子「靜默吃掉點擊」——那會造成「明明輪到你、格子也在,卻怎麼點都完全沒反應」的假死。
          cell.addEventListener("click",()=>MP.tap(i));
        }
        else cell.addEventListener("click",()=>toggle(i));
        cell.setAttribute("aria-pressed",state.marked[i]?"true":"false");
      }else if(manual){
        if(!val)cell.classList.add("empty-cell");
        cell.addEventListener("click",()=>manualTap(i));
      }else{ // auto preview
        cell.style.cursor="default";
        /* ⚠ 連線中這一格**不可以** disabled(v1.74.0)。
           disabled 的 button 連 click 事件都不會觸發 —— 一旦盤面因為任何原因還沒進 play 模式
           (而玩家晶片已經照 order/turnIndex 高亮成「輪到你」了,那是 renderPlayers() 畫的,
           跟 state.mode 無關),就會變成「明明輪到你、格子也在,卻怎麼點都沒反應、
           連『還沒輪到你』都不跳」的假死 —— 使用者回報的正是這個。
           這與 v1.27.3 拿掉 play 分支 disabled 是同一個理由,那一次只改了 play 分支、
           漏掉這裡,所以「靜默吃掉點擊」這條路徑一直還開著。
           改成一律交給 MP.tap():輪到你就叫號(它會先把盤面補進 play 模式,見 online.js),
           沒輪到你就跳提示。單機沒有這個問題(沒有「別人推進相位」這件事),維持 disabled。 */
        if(state.online) cell.addEventListener("click",()=>MP.tap(i));
        else cell.disabled=true;
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
      else if(isTenpai()) MP.reportReach();   // 聽牌(完成「目標−1」條線)→ 廣播「聽牌」語音給全部人(含自己);MP 內一局只播一次
      return;
    }
    if(done>=state.target && !state.won){ state.won=true; win(done); }
  }
  // 連線用:是否「聽牌」——完成「目標線數 − 1」條線即視為聽牌(例:目標 3 線,完成 2 線就算聽牌)。
  // 這樣比「只差一格就達標」更早觸發,聽牌者本人也不會等到最後一刻才知道自己就快贏/已落後。
  // 各端只判斷自己的盤面;達標(贏了)不算聽牌。
  function isTenpai(){
    let done=0;
    LINES.forEach(line=>{ if(line.every(idx=>state.marked[idx])) done++; });
    if(done>=state.target) return false;   // 已達標(贏了)不算聽牌
    // 主規則:完成「目標 − 1」條線即聽牌(目標需 ≥2 才適用,否則目標 1 線時 0 線就誤判)
    if(state.target>=2 && done>=state.target-1) return true;
    // 備援(涵蓋目標僅 1 線、或一格同時完成多線直接達標前的最後一步):只差一格就達標也算聽牌
    for(let i=0;i<nCells();i++){
      if(state.marked[i]) continue;        // 已劃記的格跳過,只試「還沒被叫到」的格
      state.marked[i]=true;                // 假設這格被叫到
      let d=0; LINES.forEach(line=>{ if(line.every(idx=>state.marked[idx])) d++; });
      state.marked[i]=false;               // 還原(不改動真實盤面)
      if(d>=state.target) return true;      // 只差這一格就達標 → 聽牌
    }
    return false;
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
  /* ⚠ 這三支在 js/shared/ui-kit.js 還有一份(Bingo 不載入 js/shared/)—— 改一邊記得改另一邊。
     body.peeking(v1.58.4)讓 CSS 把「🏆 看結果」浮動鈕那一條的高度留出來,
     否則它蓋在盤面正下方中央(麻將那頁最明顯:手牌就在那裡)。 */
  // 叫出結果卡(順便收起「看結果」浮動鈕)
  function showResult(){ $("reopenWin").classList.add("hidden"); $("veil").classList.add("show"); document.body.classList.remove("peeking"); }
  // 徹底收掉結果(重來/離開時用):卡片與浮動鈕都關
  function closeWin(){ $("veil").classList.remove("show"); $("reopenWin").classList.add("hidden"); document.body.classList.remove("peeking"); }
  // 只把結果卡收起來看牌面,留一顆浮動鈕可再叫回結果
  function peekBoard(){ $("veil").classList.remove("show"); $("reopenWin").classList.remove("hidden"); document.body.classList.add("peeking"); }

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
  // 主選單的兩層:"pick"=選遊戲(BINGO / 五子棋) → "bingo"=選 BINGO 的玩法(連線 / 單機)。
  // 五子棋只有連線一種玩法,第一層直接用 <a href="gomoku.html"> 連過去,不進第二層。
  function showHomeLayer(which){
    const pick=$("homePick"), sub=$("homeBingo");
    if(pick) pick.classList.toggle("hidden", which!=="pick");
    if(sub)  sub.classList.toggle("hidden", which!=="bingo");
    setTopBrand(which==="pick" ? "party" : "bingo");
  }
  // 頂列品牌字:"party"=選遊戲主選單顯示「派對遊戲」;"bingo"=其餘畫面顯示 B-I-N-G-O 跑馬燈。
  // 只有這裡切換就夠 —— 離開第一層的唯一出口是 showHomeLayer("bingo")(另兩張卡是連到別頁的 <a>),
  // 回主選單也一律經過 enterHome() → showHomeLayer("pick")。
  function setTopBrand(which){
    const hb=$("brandHome"), mq=$("marquee");
    if(hb) hb.classList.toggle("hidden", which!=="party");
    if(mq) mq.classList.toggle("hidden", which==="party");
  }
  // 主選單:進場先選遊戲;離開房間、單機返回都回到這裡(一律回第一層)
  function enterHome(){
    state.mode="home"; state.won=false; state.online=false; closeWin();
    $("home").classList.remove("hidden");
    showHomeLayer("pick");                            // 回主選單一律從「選遊戲」開始
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
  // 頂列跑馬燈:沒在玩的時候(主選單 / 設定 / 大廳)五個字母全亮 —— 那時它就是招牌,
  // 灰的會像壞掉、也和五子棋/數獨那兩頁的品牌字不一樣。開打才全部熄掉,
  // 之後由 refreshLines() 依完成線數逐一點亮(那才是它的本業:進度顯示)。
  function resetMarquee(){
    const lit = state.mode==="play" ? 0 : 5;
    [...$("marquee").children].forEach((b,k)=>b.classList.toggle("lit", k<lit));
  }

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
    syncFillSeg();
    scheduleBoardFit();   // 分頁切換會改變捲動區內容(設定列 ↔ 號碼格+填號列)→ 重算盤面可用高度
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
      syncFillSeg();   // 進遊戲/離開 → #fillRow 整列已收起,這裡順手把高亮與文案同步回正確狀態
      scheduleBoardFit();     // 分頁列/準備列收起 → 縱向空間釋出給號碼格
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
    syncFillSeg();
    if(manual){ updateManualUI(); }
    else {
      $("startBtn").disabled=false;$("startBtn").style.opacity="1";
      if(state.online)MP.readyEnabled(true);
      refreshActionHint();
    }
  }
  // 右下浮動「換一組」鈕:只在「設定中 + 填號分頁 + 自動填號」時出現(手動填號 / 設定分頁 / 遊戲中都收起)
  // 填號方式列的同步:高亮 .on ＋「自動填號」的文案(v1.36.2,取代原本的 updateReshuffleBtn())。
  // 「自動填號」一旦選中,它的功能就只剩「再按一次重抽整張卡」——文案因此直接改成「🎲 換一組號碼」,
  // 說出按下去會發生什麼;模式本身由橘色高亮表示。未選中時顯示模式名稱,那時按下去才是切換模式。
  // 順帶修掉舊的顯示脫鉤:toSetup()、winNew、進大廳、回大廳續玩都會用程式把 state.fill 設回 "auto",
  // 但過去只有點擊 handler 會切 .on → 高亮會留在「手動填號」上、和實際狀態不符。
  function syncFillSeg(){
    const seg=$("fillSeg"); if(!seg)return;
    [...seg.children].forEach(b=>b.classList.toggle("on", b.dataset.fill===state.fill));
    const ab=seg.querySelector('[data-fill="auto"]'); if(!ab)return;
    const auto=state.fill==="auto";
    ab.textContent = auto ? "🎲 換一組號碼" : "🎲 自動填號";
    ab.title = auto ? "再按一次就換一組新號碼" : "改用自動填號(隨機發一張卡)";
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
  let sfxVol=1;                   // 音效總音量(0~1);預設 100%,含點格/連線/勝敗等所有音效
  let vibrateOn=true;             // 連線「輪到你」時震動(僅支援 navigator.vibrate 的裝置;iOS Safari 不支援會自動略過);由 online.js 讀取
  // 背景音樂可選曲目(檔案放 mp3/;第一個為預設)。新增曲目只要放檔 + 在這裡加一列
  const BGM_TRACKS=[
    { id:"sunday", name:"Sunday Morning(預設)", src:"mp3/Sunday_Morning.mp3" },
    { id:"happy",  name:"歡樂",                 src:"mp3/bgm.mp3" }
  ];
  let bgmTrack="sunday";          // 目前選的曲目 id(預設 Sunday Morning;舊版存的 "default" 已不存在,會自動回退到這裡)
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
        sfxVol:sfxVol,
        vibrate:vibrateOn,
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
    if(typeof p.sfxVol==="number"){ sfxVol=Math.max(0,Math.min(1,p.sfxVol)); }
    Sound.setVolume(sfxVol);
    if(typeof p.vibrate==="boolean"){ vibrateOn=p.vibrate; }
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
    const sfxEl=$("sfxVol"), sfxRow=$("sfxVolRow");
    if(sfxEl)sfxEl.value=Math.round(sfxVol*100);
    if(sfxRow)sfxRow.classList.toggle("dim",Sound.isMuted());   // 音效關閉時,音量列淡化
    const swV=$("swVibrate"); if(swV)swV.setAttribute("aria-checked",vibrateOn?"true":"false");
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

  /* ---------- 返回鍵守衛(v1.75.13) ----------
     手機的返回鍵 = history.back(),而網頁**沒有**「攔住返回鍵」這種 API。連線中誤按一下的代價
     最大:訪客這局不算成績,房主更是整間房直接關掉、全部人一起被踢。唯一可行的做法是
     **先在歷史裡墊一筆**:進房時 pushState 一筆守衛,返回鍵於是走到那一筆(同文件、不換頁)→
     收到 popstate 就跳確認卡。
     ⚠ 四個坑:
       1. pushState **不可以帶 url** —— 帶了就是「改網址」,file:// 直接 SecurityError(origin 是
          "null"),而在外殼(app.html)裡帶 hash 還會踩到它的 hashchange 監聽。不帶 url 就只多一筆歷史。
       2. 攔到之後要**立刻再墊回去**,否則第二下返回就真的走掉了。
       3. 確認要離開時,墊的那一筆還在歷史裡 → 自己 history.back() 吃掉(bgEat 讓那一發 popstate
          不算使用者按的),否則使用者得多按一次返回才回得到首頁。
       4. arm 必須**冪等**:進房 → 開局 → 回大廳 → 再開局全都在同一筆守衛底下;一個相位墊一筆的話
          返回鍵要按好幾下才有反應。
     ★ 這一組在 js/shared/ui-kit.js 另有一份(Bingo 不載入那支)—— 改一邊記得改另一邊。 */
  let bgArmed=false, bgAct=null, bgEat=false, bgBound=false;
  function armBackGuard(act){
    bgAct=act||null;
    if(!bgBound){ bgBound=true; addEventListener("popstate",onBackGuard); }
    if(bgArmed)return;
    try{ history.pushState({bingoGuard:1},""); bgArmed=true; }catch(e){}
  }
  function onBackGuard(){
    if(bgEat){ bgEat=false; return; }   // 這一發是 disarm 自己吃掉守衛時發出來的,不是使用者按的
    if(!bgArmed)return;                 // 沒在守 → 讓瀏覽器照常返回(選單畫面按返回就該回上一頁)
    bgArmed=false;                      // 墊的那一筆已經被這一下返回消耗掉
    const act=bgAct;
    armBackGuard(act);                  // 立刻補一筆,下一下返回照樣攔得到
    if(act)act();
  }
  function disarmBackGuard(){
    bgAct=null;
    if(!bgArmed)return;
    bgArmed=false; bgEat=true;
    try{ history.back(); }catch(e){ bgEat=false; }
  }
  /* 返回鍵先關掉最上層的浮層(手機上的直覺),沒有浮層開著才回傳 false 交給呼叫端處理。
     ⚠ 結果卡(#veil)刻意不列 —— 它是強制回應視窗,要離開只能按卡片上的按鈕(見各頁 main.js)。
       順序 = 疊在上面的先關;這一頁沒有的 id(投降只有五子棋、猜拳只有 Bingo)自動跳過。 */
  const BACK_LAYERS=[["myVoiceVeil",()=>closeMyVoice()],["setVeil",()=>closeSettings()],
                   ["emoteVeil",()=>closeEmote()],["kickVeil",()=>MP.cancelKick()],
                   // ★ 21 點的房規蓋板(v1.84.0)。只有 blackjack.html 有這個 id,
                   //   其他六頁自動跳過(見上面那條註解)—— 漏掉的話按返回會跳成「離開房間?」
                   ["bjRulesVeil",()=>closeRules()],
                   /* ★ UNO 的兩個蓋板(v1.106.0)。只有 uno.html 有這兩個 id,其他八頁自動跳過。
                      ⚠ 選色盤要排在**房規前面**:它是「出了 Wild 正在等你選顏色」的強制層,
                        兩個同時開著的時候先關它。關掉 = 那一手 Wild 取消(牌回到手上)——
                        安全,因為顏色還沒選就不會送進 moves。 */
                   ["unColorVeil",()=>UNB.closeColor()],["unRulesVeil",()=>closeRules()],
                   ["resignVeil",()=>MP.cancelResign()],["leaveVeil",()=>MP.cancelLeave()]];
  function dismissTopLayer(){
    for(let i=0;i<BACK_LAYERS.length;i++){
      const el=$(BACK_LAYERS[i][0]);
      if(el&&el.classList.contains("show")){ BACK_LAYERS[i][1](); return true; }
    }
    return false;
  }

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
  // 音效總音量:0~1,即時套到 Sound 的總音量節點(含點格/連線/勝敗等所有音效)
  function setSfxVol(v){ sfxVol=Math.max(0,Math.min(1,v)); Sound.setVolume(sfxVol); }
  // 連線「輪到你」震動開關:偏好記憶;online.js 的 notifyMyTurn 讀 vibrateOn 決定要不要震
  function setVibrate(on){ vibrateOn=!!on; savePrefs(); syncSettingsUI(); }
  let toastT;
  function showToast(txt,dur){
    let el=$("toast");
    if(!el){el=document.createElement("div");el.id="toast";document.body.appendChild(el);}
    el.textContent=txt;
    el.classList.add("show");
    clearTimeout(toastT);
    toastT=setTimeout(()=>el.classList.remove("show"),dur||1100);
  }
  /* ---------- 全螢幕(v1.50.0:外殼架構) ----------
     Fullscreen API 綁在 document 上,**換頁瀏覽器一定收掉全螢幕**,而重進全螢幕一定要使用者手勢
     (實測:換頁後立刻 requestFullscreen 會 REJECT "Permissions check failed",連「使用者是點連結
     才換頁的」都不算數)。所以正常情況下這一頁跑在 app.html 的 iframe 裡:**全螢幕掛在外殼身上**,
     換遊戲只是換 iframe 的 src,外層動都不動 → 全程不掉。這裡只負責把 ⛶ 轉給外殼。

     沒被外殼包住時(直接開這一頁、file:// 本機開、e2e 測試頁)才走本地那一套:
     意願記在 sessionStorage,新頁第一個真實手勢再接回(v1.49.1 的做法,退而求其次)。

     ★ 這一整組在 js/shared/ui-kit.js 另有一份(Bingo 不載入 js/shared/,比照 toggleFull 各留一份)。 */
  const FS_KEY="bingo.fs";
  const framed=(()=>{ try{ return window.top!==window.self; }catch(e){ return true; } })();
  // file:// 的 origin 是 "null",postMessage 不能拿它當 targetOrigin;外殼那邊改用 e.source 驗身分
  const SHELL_TO=(location.origin && location.origin!=="null") ? location.origin : "*";
  let shellEnv=null;     // 外殼回報的環境(支不支援全螢幕 / 是不是 standalone);iframe 裡自己測不準
  let fsLeaving=false;   // 換頁中:此時的 fullscreenchange 是瀏覽器收掉的,不代表使用者不想要了
  function fsEl(){ return document.fullscreenElement||document.webkitFullscreenElement; }
  function fsSupported(){ const de=document.documentElement; return !!(de.requestFullscreen||de.webkitRequestFullscreen); }
  function fsWant(){ try{ return sessionStorage.getItem(FS_KEY)==="1"; }catch(e){ return false; } }
  function setFsWant(on){ try{ if(on)sessionStorage.setItem(FS_KEY,"1"); else sessionStorage.removeItem(FS_KEY); }catch(e){} }
  function fsRequest(){
    const de=document.documentElement, req=de.requestFullscreen||de.webkitRequestFullscreen;
    if(!req)return null;
    try{ return req.call(de); }catch(e){ return null; }
  }
  // 這一頁是哪一個遊戲(外殼用它更新 hash,做深層連結)。從檔名判斷,測試頁也認得。
  function fsPageKey(){
    const f=(location.pathname.split("/").pop()||"").toLowerCase();
    return f.indexOf("gomoku")>=0 ? "gomoku" : (f.indexOf("sudoku")>=0 ? "sudoku" : "bingo");
  }
  function shellMsg(act){
    try{ parent.postMessage({ t:"bingo.fs", act:act, page:fsPageKey() }, SHELL_TO); }catch(e){}
  }
  // 是不是已經滿版(iOS standalone / 桌機 app 視窗)。iframe 裡 navigator.standalone 測不準,以外殼回報為準。
  function fsStandalone(){
    if(framed) return shellEnv ? !!shellEnv.standalone : true;   // 外殼還沒回報就當作已滿版,寧可不囉嗦
    return ("standalone" in navigator && navigator.standalone) ||
           (matchMedia&&matchMedia("(display-mode: standalone)").matches);
  }
  // iOS Safari(iPhone)不支援 Fullscreen API → 引導改用「加入主畫面」以全螢幕開啟
  function fsFallbackTip(){
    showToast(fsStandalone() ? "已是全螢幕模式 👍"
                             : "iOS 請按 Safari 分享鈕 → 加入主畫面,即可全螢幕", 3000);
  }
  function toggleFull(){
    if(framed){ shellMsg("toggle"); return; }   // 外殼代勞;它不支援時會回 unsupported,那時才跳提示
    const exit=document.exitFullscreen||document.webkitExitFullscreen;   // webkit:舊 Safari/Android
    if(fsSupported()){
      if(fsEl()){ setFsWant(false); exit&&exit.call(document); }
      else{
        setFsWant(true);
        const p=fsRequest();
        if(p&&p.catch)p.catch(()=>setFsWant(false));   // 這一次就被拒:別把意願留著騷擾之後每一頁
      }
    }else fsFallbackTip();
  }
  /* 掛「下一個手勢就接回全螢幕」。用 click(冒泡到 window)而不是 pointerdown:
     按下去就切全螢幕會在 pointerdown/pointerup 之間改變版面,那一下的 click 可能就飛掉了。
     點到 <a href>(去別頁 / 回主選單)或正在輸入框打字則跳過並繼續等 ——
     前者進了全螢幕馬上又要換頁只會閃一下,後者打到一半版面亂跳很煩。
     有外殼時這一下手勢是給外殼用的(外殼被 F5 重載過才需要接回,它自己判斷)。 */
  let fsArmed=null;
  function armFsRestore(){
    if(fsArmed)return;
    if(!framed && (!fsWant() || fsEl() || !fsSupported()))return;
    fsArmed=e=>{
      const t=e&&e.target;
      if(t&&t.closest&&t.closest("a[href],input,textarea,select"))return;   // 這一下不算,留著等下一次
      disarmFsRestore();
      if(framed){ shellMsg("gesture"); return; }
      if(!fsWant() || fsEl())return;
      fsRequest();   // 被拒就安靜算了(每頁只試這一次,不會纏著使用者)
    };
    addEventListener("click",fsArmed);
    addEventListener("keydown",fsArmed);
  }
  function disarmFsRestore(){
    if(!fsArmed)return;
    removeEventListener("click",fsArmed);
    removeEventListener("keydown",fsArmed);
    fsArmed=null;
  }
  function initFullscreenKeep(){
    if(framed){
      addEventListener("message",e=>{
        if(e.source!==parent)return;
        const d=e.data; if(!d||d.t!=="bingo.shell")return;
        if(d.act==="env"||d.act==="unsupported") shellEnv={ fsSupported:!!d.fsSupported, standalone:!!d.standalone };
        if(d.act==="unsupported") fsFallbackTip();   // 外殼也進不了全螢幕(iPhone Safari)→ 引導加到主畫面
      });
      shellMsg("hello");   // 回報自己是哪一頁,順便換回外殼的 env
      armFsRestore();
      return;
    }
    const sync=()=>{ if(!fsLeaving) setFsWant(!!fsEl()); };   // 使用者自己按 Esc 退出 → 意願跟著關掉
    document.addEventListener("fullscreenchange",sync);
    document.addEventListener("webkitfullscreenchange",sync);
    addEventListener("pagehide",()=>{ fsLeaving=true; });
    addEventListener("pageshow",e=>{ fsLeaving=false; if(e.persisted)armFsRestore(); });   // 上一頁回來(bfcache)也要接回去
    armFsRestore();
  }
  /* 上面那句提示藏在 ⛶ 鈕後面,實際上沒人會去按 → 首次進站主動講一次,按過就不再打擾。
     首頁是掃 QR 進站的落點,這個引導最該出現在這裡。
     ⚠ js/shared/ui-kit.js 有一份同樣的(Bingo 不載入 js/shared/,比照 toggleFull 各留一份)。 */
  const PWA_TIP_KEY="bingo.pwatip";
  function maybeShowInstallTip(){
    try{
      if(fsStandalone())return;                    // 已經是全螢幕了,不用講(在 iframe 裡以外殼回報的為準)
      const ua=navigator.userAgent||"";
      // iPadOS 13+ 的 UA 會偽裝成 Macintosh,只能靠觸控點數認出來
      const isIOS=/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints>1);
      if(!isIOS)return;                            // 其他平台按 ⛶ 就能全螢幕,不必囉嗦
      if(localStorage.getItem(PWA_TIP_KEY)==="1")return;
      const box=document.createElement("div");
      box.className="pwa-tip";
      box.innerHTML=
        '<h4>📱 想玩得大一點?</h4>'+
        '<p>iPhone 的 Safari 沒辦法直接全螢幕。把它「加入主畫面」之後,開起來就跟 App 一樣滿版。</p>'+
        '<ol><li>按下面工具列的分享鈕 <b>⬆️</b></li><li>往下找 <b>「加入主畫面」</b></li></ol>'+
        '<button class="btn primary pwa-ok" type="button">知道了</button>';
      box.querySelector(".pwa-ok").addEventListener("click",()=>{
        try{ localStorage.setItem(PWA_TIP_KEY,"1"); }catch(e){}
        box.remove();
      });
      document.body.appendChild(box);
    }catch(e){}
  }

  /* ---------- 好友互動表情(連線用) ---------- */
  const EMOTES=["👍","👎","❤️","😂","🎉","🔥","👏","😮","😢","😭","😎","🤯","🥳","🤝","🙏","💪","😡","💩"];
  // 罐頭嘴砲:走機車搞笑路線(v1.40.0),與 js/gomoku/ui.js 那份保持同一批
  const PHRASES=["睡著了嗎 😴","阿嬤都比你快","笑死 🤣","菜就多練 💪","我讓你的啦~","運氣好而已","手在抖喔 🤏","不然你先投降?"];
  // 語音短訊(連線用):選文字項目 → 只傳代號,對方播本地預錄 m4a;與上方即時錄音語音是兩條獨立管道,兩者並存
  const CLIPS=[
    { id:"howlong", label:"是要多久",      src:"mp3/是要多久.m4a" },
    { id:"ready",   label:"啊西好了沒",    src:"mp3/啊西好了沒.m4a" },
    { id:"hurry",   label:"快點來不及啦",  src:"mp3/快點，來不急啦.m4a" },
    { id:"gofast",  label:"你就趕快啦",    src:"mp3/你就趕快啦.m4a" },
    { id:"crying",  label:"你是在哭喔",    src:"mp3/你是在哭喔.m4a" },
    { id:"verify",  label:"我要驗牌",      src:"mp3/我要驗牌.m4a" },
    // 「聽牌」為連線遊戲自動觸發(有人只差一號就達標),不放進手動表情選單 → auto:true 讓 buildVoiceClips 略過
    { id:"reach",   label:"聽牌",          src:"mp3/聽牌.m4a", auto:true },
  ];
  let emoteTarget="all";                       // 目前要傳給誰:"all" 或某玩家 id
  function openEmote(target){
    if(!state.online)return;
    const roster=MP.roster();
    emoteTarget = (target && target!=="all" && roster.some(p=>p.id===target)) ? target : "all";
    buildEmoteRecipients(); buildEmoteGrid(); buildEmotePhrases(); buildVoiceClips(); buildMyClips();
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
  // 快速語音鈕可能同時存在兩顆(房間框固定那顆 + 猜拳蓋板那顆),用 class 一起掃描,
  // 讓「準備中/錄音倒數/⏹」等狀態兩邊同步顯示,不會因為只更新其中一顆而顯示不一致。
  let qvTick=null;
  function eachQuickVoice(fn){ const list=document.querySelectorAll(".quick-voice"); for(let i=0;i<list.length;i++)fn(list[i]); }
  function setQuickVoiceUI(o){
    eachQuickVoice(b=>{
      if(o.disabled!=null) b.disabled=o.disabled;
      if(o.rec!=null) b.classList.toggle("rec",o.rec);
      const ico=b.querySelector(".qv-ico"), lab=b.querySelector(".qv-label");
      if(ico&&o.ico!=null) ico.textContent=o.ico;
      if(lab&&o.lab!=null) lab.textContent=o.lab;
    });
  }
  function resetQuickVoiceBtn(){
    if(qvTick){ clearInterval(qvTick); qvTick=null; }
    setQuickVoiceUI({ rec:false, disabled:false, ico:"🎤", lab:"語音" });
  }
  function toggleQuickVoice(){
    if(!state.online)return;
    if(!Voice.supported()){ showToast("此裝置/瀏覽器不支援錄音"); return; }
    if(Voice.recording()){ setQuickVoiceUI({ disabled:true, lab:"處理中…" }); Voice.stop(); return; }  // 停止 → 交給 onBlob 收尾
    markAudioArmed(); Sound.wake();   // 按麥克風=手勢,順手解鎖播放音訊(這也是「按著麥克風時收到的語音就會自動播」的原因)
    kickVoiceQueue();                 // 若正好有語音在膠囊裡等,趁這個手勢一起補播
    setQuickVoiceUI({ disabled:true, lab:"準備中…" });
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
      setQuickVoiceUI({ disabled:false, rec:true, ico:"⏹" });
      let left=Math.ceil(Voice.MAX_MS/1000);
      setQuickVoiceUI({ lab:left+"s" });
      qvTick=setInterval(()=>{ left--; if(left<=0){ if(qvTick){clearInterval(qvTick);qvTick=null;} return; } setQuickVoiceUI({ lab:left+"s" }); },1000);
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
  // 語音短訊的已解碼快取:同一個預錄檔重複播不必重抓重解(key = 檔案路徑)
  const clipBufCache={};
  // 用 Web Audio 播一段已解碼的 AudioBuffer(套用收語音音量);成功回傳 true
  function playDecoded(c,buf,onEnd){
    try{ const s=c.createBufferSource(); s.buffer=buf; const g=c.createGain(); g.gain.value=voiceVol; s.connect(g); g.connect(c.destination); s.onended=onEnd; s.start(); return true; }
    catch(e){ return false; }
  }
  // 播放單則音源,播完(或失敗)呼叫 onEnd。來源可為 base64 data URL(即時錄音語音)或本地檔路徑(語音短訊 m4a)。
  // Web Audio 優先(繞過 iOS 自動播放封鎖、可解 WAV/AAC),失敗退回 HTMLAudio。
  function playVoiceOnce(src,onEnd){
    let called=false; const done=()=>{ if(called)return; called=true; if(onEnd)onEnd(); };
    const c=Sound.ctx&&Sound.ctx();
    if(!c){ fallbackAudio(src,done); return; }
    const isData = src.slice(0,5)==="data:";
    const start=()=>{
      if(!isData && clipBufCache[src]){ if(!playDecoded(c,clipBufCache[src],done)) fallbackAudio(src,done); return; }   // 快取命中:直接播
      const decode=(arrbuf,cacheKey)=>{
        try{
          c.decodeAudioData(arrbuf.slice(0),
            b=>{ if(cacheKey)clipBufCache[cacheKey]=b; if(!playDecoded(c,b,done)) fallbackAudio(src,done); },
            ()=>fallbackAudio(src,done));
        }catch(e){ fallbackAudio(src,done); }
      };
      if(isData){
        let bytes;
        try{ const i=src.indexOf(","); if(i<0)throw 0; const bin=atob(src.slice(i+1)); bytes=new Uint8Array(bin.length); for(let k=0;k<bin.length;k++)bytes[k]=bin.charCodeAt(k); }
        catch(e){ fallbackAudio(src,done); return; }
        decode(bytes.buffer,null);
      } else {
        fetch(src).then(r=>{ if(!r.ok)throw 0; return r.arrayBuffer(); }).then(ab=>decode(ab,src)).catch(()=>fallbackAudio(src,done));   // 本地 m4a:抓檔 → 解碼(結果快取)
      }
    };
    if(c.state==="suspended") c.resume().then(start).catch(start); else start();
  }
  // 語音播放佇列:多則語音「依收到先後」排隊逐一播、不重疊;整個佇列播放期間停背景音樂,全部播完再恢復
  const voiceQueue=[]; let voiceBusy=false, voiceSafety=null, voicePrune=null;
  // audioArmed =「使用者手勢已解鎖音訊、且之後沒切到背景」。iOS 有個惡名昭彰的狀況:切到別的 App 再回來,
  // AudioContext 的 state 仍是 "running" 卻其實不出聲——只看 Sound.running() 會被騙,把語音「靜音播掉」(使用者只看到 🎤 飛一下就沒了、沒聲音)。
  // 因此在觸控裝置(iOS/Android)上,收到語音要不要自動播,除了 context 在跑,還要求「這回合有真的手勢解鎖過」;否則一律改顯示可點的播放膠囊。
  const IS_TOUCH = ("ontouchstart" in window) || (navigator.maxTouchPoints>0);
  let audioArmed=false;
  function markAudioArmed(){ audioArmed=true; }      // 由真實手勢(點播放膠囊 / 按麥克風 / 首次互動解鎖)呼叫
  function markAudioStale(){ audioArmed=false; }     // 切到背景 → 下次回前景要重新用手勢解鎖才自動播
  /* ★★ 語音有「賞味期限」(v1.75.9)。★ 與 js/shared/ui-kit.js 那份是雙胞胎,改一邊要改另一邊。
     使用者(在排七連線)回報:「別人發的語音我都到了最後結束頁面時,才一直連續的播放出來」。
     病灶不在佇列本身,而在**膠囊會一直等下去**:手機在等別人的回合時螢幕暗掉 / 切去別的 App,
     visibilitychange 就把 audioArmed 打回 false(iOS 回前景後 state 仍是 running 卻不出聲,
     所以這個保守是對的)。之後收到的語音**不丟棄、留在佇列裡**等一個手勢 —— 一整局累積十幾則,
     結算時使用者拿起手機隨手一點就一次全放完。
     語音是**現場即時**的東西(即時語音上限 6 秒,發送端 15 秒就把 DB 記錄刪掉了),
     過了半分鐘再放只剩噪音,而且會蓋掉結算當下真的想說的話 → **逾時就丟,不補播**。
     ⚠ 佇列被膠囊擋住時沒有任何人會再呼叫 pumpVoice(它只由「收到語音」與「手勢」驅動),
       所以要額外掛一支 prune 心跳讓膠囊自己過期收起來,否則畫面上會一直掛著
       「🔊 12 則語音 · 點我播放」引人去點一堆舊的,等於沒修。 */
  const VOICE_TTL_MS=30000;      // 進佇列超過這麼久還沒播出去 → 丟掉
  const VOICE_MAX_Q=6;           // 同時最多壓幾則(超過丟最舊的),避免一次爆量
  const VOICE_PRUNE_MS=2000;     // 膠囊掛著時的過期心跳
  function pruneVoice(){
    const now=Date.now();
    for(let i=voiceQueue.length-1;i>=0;i--){ if(now-voiceQueue[i].at>VOICE_TTL_MS) voiceQueue.splice(i,1); }
    if(voiceQueue.length>VOICE_MAX_Q) voiceQueue.splice(0,voiceQueue.length-VOICE_MAX_Q);
  }
  function startVoicePrune(){
    if(voicePrune)return;
    voicePrune=setInterval(()=>{
      if(voiceBusy)return;
      pruneVoice();
      if(!voiceQueue.length){ stopVoicePrune(); hideVoiceGate(); refreshBgmDuck(); }
      else showVoiceGate();
    },VOICE_PRUNE_MS);
  }
  function stopVoicePrune(){ if(voicePrune){ clearInterval(voicePrune); voicePrune=null; } }
  function enqueueVoice(src){
    if(!src)return;
    if(Sound.isMuted&&Sound.isMuted())return;   // 靜音:不播也不排隊
    voiceQueue.push({ src:src, at:Date.now() });
    pruneVoice();
    if(!voiceBusy) pumpVoice();
  }
  // 語音短訊:依代號找本地預錄檔,丟進同一條語音佇列播放(未知代號=跨版本沒有此檔 → 安全略過,不出聲)
  function enqueueClip(id){
    const clip=CLIPS.find(c=>c.id===id); if(!clip)return;
    enqueueVoice(clip.src);
  }
  function pumpVoice(){
    if(voiceBusy)return;
    pruneVoice();                                                          // 先丟掉過期的(見上面的 VOICE_TTL_MS)
    if(!voiceQueue.length){ stopVoicePrune(); hideVoiceGate(); refreshBgmDuck(); return; }   // 佇列清空 → 收起膠囊 + 恢復背景音樂
    // iOS 切背景/鎖屏會把 AudioContext 打回 suspended,非手勢情境下 resume() 會被忽略;更麻煩的是回前景後
    // state 常仍顯示 "running" 卻不出聲。此時「不硬播、也不丟棄」——語音留在佇列裡,改顯示可點的「🔊 點擊播放」膠囊,
    // 等使用者手勢再播(順手根治舊版「9 秒 timeout 把播不出來的語音丟出佇列、永久遺失」的 bug)。
    // 觸控裝置額外要求 audioArmed(這回合手勢解鎖過);桌機維持原本只看 context 是否在跑,不因切分頁就退回膠囊。
    if((IS_TOUCH && !audioArmed) || !(Sound.running && Sound.running())){ showVoiceGate(); startVoicePrune(); return; }
    stopVoicePrune();
    hideVoiceGate();
    const next=voiceQueue.shift();
    voiceBusy=true; refreshBgmDuck();                    // 開播 → 停背景音樂
    const advance=()=>{ if(!voiceBusy)return; if(voiceSafety){ clearTimeout(voiceSafety); voiceSafety=null; } voiceBusy=false; pumpVoice(); };
    voiceSafety=setTimeout(advance,15000);              // 保險:即時語音上限 6 秒、語音短訊通常也短,15 秒沒收到結束事件就強制接續,避免佇列卡住
    playVoiceOnce(next.src,advance);
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

  /* ---------- 自訂語音(自己錄幾組,連線時當罐頭按鈕送) ----------
     ★★ 與 js/shared/ui-kit.js 那份是雙胞胎(Bingo 不載入 js/shared/,比照 toggleFull 各留一份)。
        改這個區塊一定要同時改另一邊 —— 用 grep myclips 就能找到兩處。

     走的是既有的 kind="voice" 管道:存下來的就是 sendEmote 要傳的 dataURL,送出時零轉換。
     因此不用改 Firebase 規則(audio 欄已放行 300,000 字元)、不用改 sw.js(沒有新增靜態音檔)、
     對方也不需要有任何檔案(資料自帶)—— 這是與內建 CLIPS 最大的差別:CLIPS 只傳代號、雙方
     都得有那支 m4a;自訂語音把音訊本身傳過去,舊版客戶端收到照播。

     ⚠ 獨立一支 localStorage key,絕對不進 bingo.prefs.v1 —— 那份每次 savePrefs() 都是整包
       read-modify-write,塞幾百 KB 進去等於「調一次音量就序列化幾百 KB」;更糟的是一旦
       setItem 拋 QuotaExceededError,連主題/音量等一般偏好都會一起存不進去。 */
  const MYCLIP_KEY="bingo.myclips.v1";   // 三個遊戲共用同一批(與 bingo.pid / bingo.pwatip 同命名空間)
  const MYCLIP_MAX=6;                    // 上限 6 組(3 秒約 65KB/則 → 約 390KB,對 localStorage 約 5MB 的額度很安全)
  const MYCLIP_MS=3000;                  // 錄音上限 3 秒(內建即時語音是 6 秒;短一半 = 流量與本機容量都減半)
  const MYCLIP_LABEL_MAX=8;              // 名字上限 8 字(與 players.name 同調,按鈕才不會爆版)
  const MYCLIP_COOL=3000;                // 送出節流:見 sendMyClip
  let myClips=[];                        // 記憶體副本(開面板/開編輯浮層時重讀)
  let mvPending=null;                    // 錄好但還沒命名儲存的 dataURL
  let mvRecTmr=null, mvTick=null, mvLastSent=0;

  function loadMyClips(){
    try{
      const a=JSON.parse(localStorage.getItem(MYCLIP_KEY));
      if(!Array.isArray(a))return [];
      // 只收結構完整的,壞資料(手改壞、跨版本)直接濾掉而不是整批放棄
      return a.filter(c=>c && typeof c.id==="string" && typeof c.data==="string" && c.data.slice(0,5)==="data:")
              .map(c=>({ id:c.id, label:String(c.label||"語音").slice(0,MYCLIP_LABEL_MAX), data:c.data, at:c.at||0 }))
              .slice(0,MYCLIP_MAX);
    }catch(e){ return []; }
  }
  // 寫入失敗(多半是 QuotaExceededError)回 false 交給呼叫端提示,不讓例外冒出去打斷 UI
  function saveMyClips(list){
    try{ localStorage.setItem(MYCLIP_KEY,JSON.stringify(list)); return true; }catch(e){ return false; }
  }

  /* ---- 互動面板的「我的語音」區 ---- */
  function buildMyClips(){
    const g=$("emoteMyClips"), sub=$("myClipsSub");
    if(!g)return;
    myClips=loadMyClips();
    g.innerHTML="";
    const none=!myClips.length;
    g.classList.toggle("hidden",none);
    if(sub)sub.classList.toggle("hidden",none);   // 沒錄過就整區不出現,面板不會多一塊空的
    myClips.forEach(c=>{
      const b=document.createElement("button");
      b.type="button"; b.className="phrase-btn mvc-btn"; b.textContent="🎤 "+c.label;
      b.addEventListener("click",()=>sendMyClip(c.id));
      g.appendChild(b);
    });
  }
  /* 節流:做成按鈕之後按的頻率遠高於「按著錄 3 秒」的即時語音,而每按一次都是 ~65KB 上傳
     + 房內每人各下載 65KB(6 人房約 390KB)。3 秒內只放一則過去,擋連環轟炸。 */
  function sendMyClip(id){
    const c=myClips.find(c=>c.id===id); if(!c)return;
    const now=Date.now();
    if(now-mvLastSent<MYCLIP_COOL){ showToast("等一下再送 🙂"); return; }
    mvLastSent=now;
    markAudioArmed(); Sound.wake();   // 點按鈕=手勢,順手解鎖音訊(同回合收到別人的語音才能自動播)
    MP.sendEmote(emoteTarget,"🎤","voice",c.data);
    closeEmote();
  }

  /* ---- 編輯浮層 ---- */
  function openMyVoice(){
    myClips=loadMyClips(); mvPending=null;
    Sound.wake();
    buildMyVoiceList(); syncMyVoiceUI();
    const v=$("myVoiceVeil"); if(v)v.classList.add("show");
  }
  // 關閉一定要收乾淨:錄到一半關掉若不 cancel,麥克風會一直開著(分頁的錄音圖示不會消失)
  function closeMyVoice(){
    const v=$("myVoiceVeil"); if(v)v.classList.remove("show");
    abortMyVoiceRec();
  }
  function abortMyVoiceRec(){
    if(mvRecTmr){ clearTimeout(mvRecTmr); mvRecTmr=null; }
    if(mvTick){ clearInterval(mvTick); mvTick=null; }
    if(Voice.recording()) Voice.cancel();
    voiceRecording=false; refreshBgmDuck();
    mvPending=null;
    syncMyVoiceUI();
  }
  function buildMyVoiceList(){
    const box=$("mvList"); if(!box)return;
    box.innerHTML="";
    if(!myClips.length){
      const p=document.createElement("div");
      p.className="mvc-empty";
      p.textContent="還沒有自訂語音。錄一段,連線時就能在互動面板當按鈕送出。";
      box.appendChild(p);
      return;
    }
    // 一律用 createElement + textContent/value 塞值(不走 innerHTML)→ 名字不需要另外 escape
    myClips.forEach(c=>{
      const row=document.createElement("div"); row.className="mvc-row";
      const play=document.createElement("button");
      play.type="button"; play.className="mvc-play"; play.textContent="▶";
      play.title="試聽"; play.setAttribute("aria-label","試聽 "+c.label);
      play.addEventListener("click",()=>previewMyClip(c.id));
      const name=document.createElement("input");
      name.type="text"; name.className="mvc-name"; name.value=c.label;
      name.maxLength=MYCLIP_LABEL_MAX; name.autocomplete="off";
      name.setAttribute("aria-label","語音名稱");
      name.addEventListener("change",()=>renameMyClip(c.id,name.value));
      name.addEventListener("blur",()=>renameMyClip(c.id,name.value));
      const del=document.createElement("button");
      del.type="button"; del.className="mvc-del"; del.textContent="🗑";
      del.title="刪除"; del.setAttribute("aria-label","刪除 "+c.label);
      del.addEventListener("click",()=>removeMyClip(c.id));
      row.appendChild(play); row.appendChild(name); row.appendChild(del);
      box.appendChild(row);
    });
  }
  // 試聽走 playVoiceOnce = 與對方實際聽到的同一條路徑(含 voiceVol 可放大到 300%),不會有「試聽小聲、對方很大聲」的落差
  function previewMyClip(id){
    const c=myClips.find(c=>c.id===id); if(!c)return;
    if(Sound.isMuted && Sound.isMuted()){ showToast("目前是靜音,請先開啟音效"); return; }
    markAudioArmed(); Sound.wake();
    playVoiceOnce(c.data);
  }
  function renameMyClip(id,label){
    const c=myClips.find(c=>c.id===id); if(!c)return;
    const nx=String(label||"").trim().slice(0,MYCLIP_LABEL_MAX);
    if(!nx || nx===c.label){ buildMyVoiceList(); return; }   // 清空/沒改 → 還原顯示,不動資料
    const old=c.label; c.label=nx;
    if(!saveMyClips(myClips)){ c.label=old; showToast("存不進去,本機空間不足"); }
    buildMyVoiceList();
  }
  function removeMyClip(id){
    const next=myClips.filter(c=>c.id!==id);
    if(!saveMyClips(next)){ showToast("刪除失敗"); return; }
    myClips=next;
    buildMyVoiceList(); syncMyVoiceUI();
  }
  function mvSetBtn(o){
    const b=$("mvRecBtn"); if(!b)return;
    if(o.disabled!=null) b.disabled=o.disabled;
    if(o.rec!=null) b.classList.toggle("rec",o.rec);
    if(o.label!=null) b.textContent=o.label;
  }
  function syncMyVoiceUI(){
    const cnt=$("mvCount"); if(cnt)cnt.textContent=myClips.length+" / "+MYCLIP_MAX;
    const saveRow=$("mvSaveRow"); if(saveRow)saveRow.classList.toggle("hidden",!mvPending);
    if(Voice.recording())return;   // 錄音中的按鈕文字由倒數計時器管,別蓋掉
    if(mvPending){ mvSetBtn({ rec:false, disabled:false, label:"🎤 重錄" }); return; }
    const full=myClips.length>=MYCLIP_MAX;
    mvSetBtn({ rec:false, disabled:full, label: full?("已達 "+MYCLIP_MAX+" 組上限"):("🎤 錄一段新的("+(MYCLIP_MS/1000)+" 秒)") });
  }
  function toggleMyVoiceRec(){
    if(Voice.recording()){ mvSetBtn({disabled:true,label:"處理中…"}); Voice.stop(); return; }   // 提早停
    if(mvPending){ mvPending=null; syncMyVoiceUI(); }                                          // 重錄:丟掉上一段
    if(myClips.length>=MYCLIP_MAX){ showToast("已達 "+MYCLIP_MAX+" 組上限,請先刪除"); return; }
    if(!Voice.supported()){ showToast("此裝置/瀏覽器不支援錄音"); return; }
    markAudioArmed(); Sound.wake();
    mvSetBtn({disabled:true,label:"準備中…"});
    voiceRecording=true; refreshBgmDuck();   // 先停背景音樂再開麥克風(Android 的通話路徑會把音樂弄難聽)
    Voice.start(wav=>{
      if(mvRecTmr){ clearTimeout(mvRecTmr); mvRecTmr=null; }
      if(mvTick){ clearInterval(mvTick); mvTick=null; }
      voiceRecording=false; refreshBgmDuck();
      if(!wav || wav.byteLength<=44){ showToast("沒有錄到聲音"); mvPending=null; syncMyVoiceUI(); return; }
      try{ mvPending=Voice.toDataURL(wav); }
      catch(e){ showToast("語音處理失敗"); mvPending=null; }
      syncMyVoiceUI();
      if(mvPending){ const inp=$("mvName"); if(inp){ inp.value=""; inp.focus(); } }
    }).then(()=>{
      /* 3 秒上限:Voice.MAX_MS 是寫死的 6000,但 stop() 是對外方法 → 在外面自己收。
         stop() 內部的 detach() 會 clearTimeout 掉那顆 6 秒的內部計時器,兩者不會打架
         —— 所以整支 js/audio.js 一行都不用改。 */
      mvRecTmr=setTimeout(()=>{ try{ Voice.stop(); }catch(e){} }, MYCLIP_MS);
      let left=Math.ceil(MYCLIP_MS/1000);
      mvSetBtn({disabled:false,rec:true,label:"⏹ 停止 · "+left+"s"});
      mvTick=setInterval(()=>{
        left--;
        if(left<=0){ if(mvTick){ clearInterval(mvTick); mvTick=null; } return; }
        mvSetBtn({label:"⏹ 停止 · "+left+"s"});
      },1000);
    }).catch(err=>{
      voiceRecording=false; refreshBgmDuck();
      mvPending=null; syncMyVoiceUI();
      showToast((err&&err.name==="NotAllowedError")?"麥克風權限被拒絕":"無法啟動錄音");
    });
  }
  function saveMyVoicePending(){
    if(!mvPending)return;
    const inp=$("mvName");
    const label=((inp?inp.value:"")||"").trim().slice(0,MYCLIP_LABEL_MAX) || ("語音"+(myClips.length+1));
    const next=myClips.concat([{ id:"mc"+Date.now(), label:label, data:mvPending, at:Date.now() }]);
    if(!saveMyClips(next)){ showToast("本機空間不足,請先刪掉幾組"); return; }   // 失敗時 mvPending 留著,可改短名字或刪舊的再試
    myClips=next; mvPending=null;
    if(inp)inp.value="";
    buildMyVoiceList(); syncMyVoiceUI();
    showToast("已加入「"+label+"」⭐");
  }
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
  // 語音短訊按鈕:文字選單,點擊只送代號(kind="clip"),各端播自己本地的 m4a;送出者本人也聽得到(v1.69.0)
  function buildVoiceClips(){
    const g=$("emoteClips"); if(!g)return; g.innerHTML="";
    CLIPS.forEach(clip=>{
      if(clip.auto) return;   // 自動觸發的語音(如聽牌)不放進手動選單
      const b=document.createElement("button");
      b.type="button"; b.className="phrase-btn clip-btn"; b.textContent="🔊 "+clip.label;
      b.addEventListener("click",()=>{
        markAudioArmed(); Sound.wake();   // 點按鈕=手勢,順手解鎖音訊(利於同回合收到別人的語音能自動播)
        MP.sendEmote(emoteTarget, "🔊", "clip", clip.id);
        closeEmote();
      });
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
  /* 顯示一個飛起的表情:起點在賓果卡正中央往上飄,下方標註誰傳給誰
     ★ v1.67.0 錯開:原本只有 ±18px 隨機抖動,而底下那顆「阿明 → 全部人」膠囊常常 150px 以上,
       人多一起按就全部疊在同一點、走同一條軌跡 → 看不清(Bingo 沒有人數上限,最慘的就是它)。
       改成四件事一起做:
         ① 輪替發位:畫面切成 EF_LANES 個發位,每則挑「最久沒被用到」的那個
            → 還在飛的一定不會落在同一條;越往上飄越往外側漂(--ef-dx),不會在上方交錯
         ② 時間錯開:每則至少間隔 EF_GAP 才起飛,同一批進來的變成一串泡泡
            ⚠ 一定要靠**延後 append** 而不是 animation-delay —— 電子書模式是
              `animation:none!important`,那時 delay 完全不生效,排隊中的全部會提前現形在起點
         ③ 同時上限 EF_MAX 則,超出的排隊等前面飄走;隊伍上限 EF_QMAX,再多就丟最舊的
            (有人狂按時不要積壓成幾十秒的慢動作)
         ④ 併發縮小:含自己 ≥ EF_SMALL 則時整則縮一號(.ef-sm)。只影響**新的**那則 ——
            回頭改已經在飛的會看到「飛到一半忽然縮一下」
       另外同一個人連發沿用他上次的發位往上串(位置穩定不亂跳,而且看得出是同一個人在按)。
     ⚠ EF_POS 的順序是**中央 → 左 → 右 → 更左 → 更右**,不是由左到右排:
       最常見的情況是「只有一個人按」,那一則必須落在賓果卡正中央(= 改動前的位置),
       不然平常玩就會看到表情莫名固定跑到畫面最左邊,只有人多時才正常。
     ⚠ 發位數必須 ≥ 同時上限(EF_POS.length >= EF_MAX),否則額滿時一定有兩則落在同一條。
     ⚠ 只錯開 x 不夠:emoji 只有 46px,分開很容易,但底下那顆膠囊有 140px 上下(長暱稱更寬),
       五條並排在手機上一定橫向相撞 → 每個發位再配一個**固定的垂直偏移** EF_DY,
       不必犧牲同時則數就能錯開(膠囊高約 18px,差 24 再扣掉 ±5 的抖動也還夠)。
       ⚠ EF_DY 必須**兩兩**都差 ≥24,不可以只保證「按 x 排序後相鄰的那幾對」——
         下面的夾回畫面內會把最外側兩條**拉近中央**,所以「這兩條 x 差得遠所以可以同高」
         這個假設會破功(第一版寫成 0/24/24/0/0,長暱稱時最外側被夾到離中央只剩 73px,dy=0 → 疊住)。
     ⚠ 「同時幾則」一律問 DOM(efCount)而不是自己記數器:計數器一旦與實際子元素脫節就會永遠判定額滿。
     ⚠ js/shared/ui-kit.js 有另一份一樣的(Bingo 不載入 js/shared/) —— 改一邊要改另一邊
       (grep showEmote;`node tools/test-emote-twin.js` 會逐字比對這兩份) */
  const EF_POS=[0,-.5,.5,-1,1], EF_DY=[0,24,48,-24,-48], EF_LANES=EF_POS.length,
        EF_GAP=150, EF_MAX=5, EF_QMAX=10, EF_SMALL=4;
  const efLaneAt=[], efLaneBy=[];
  let efQ=[], efPumpT=null, efNextAt=0;
  function efCount(){ const l=$("emoteFly"); return l?l.children.length:0; }
  function showEmote(emoji,caption,who,kind){
    if(!$("emoteFly"))return;
    efQ.push({ emoji:emoji, caption:caption, who:who||"", kind:kind });
    while(efQ.length>EF_QMAX) efQ.shift();
    efPump();
  }
  function efPump(){
    if(efPumpT||!efQ.length||efCount()>=EF_MAX)return;   // 額滿就不排 timer(免得空轉),等元素飄走時的回呼再叫一次
    efPumpT=setTimeout(()=>{
      efPumpT=null;
      if(efCount()<EF_MAX&&efQ.length) efFly(efQ.shift());
      efPump();
    }, Math.max(0,efNextAt-Date.now()));
  }
  // 挑發位:同一個人 2.6 秒內連發沿用他上次那條,否則挑最久沒被用到的
  function efLane(who){
    const now=Date.now();
    if(who) for(let i=0;i<EF_LANES;i++) if(efLaneBy[i]===who && now-(efLaneAt[i]||0)<2600) return i;
    let pick=0;
    for(let i=1;i<EF_LANES;i++) if((efLaneAt[i]||0)<(efLaneAt[pick]||0)) pick=i;
    return pick;
  }
  function efFly(m){
    const layer=$("emoteFly"); if(!layer)return;
    let cx=innerWidth/2, cy=innerHeight*0.5, bw=0;
    const grid=$("grid");          // 起點在賓果卡正中央(不錨定玩家晶片 —— 晶片在頂列,往上飄馬上出畫面)
    if(grid){ const g=grid.getBoundingClientRect(); if(g.width){ cx=g.left+g.width/2; cy=g.top+g.height/2; bw=g.width; } }
    const lane=efLane(m.who), t=EF_POS[lane]||0;                            // t:-1(最左)~ 0(正中央)~ +1(最右)
    efLaneAt[lane]=Date.now(); efLaneBy[lane]=m.who;
    const span=Math.min(innerWidth*0.72, Math.max(bw,300))/2;               // 發位鋪在賓果卡寬度上,窄卡也至少散開 300px
    const dur=2.05+Math.random()*0.4;                                      // 時長微擾:同時起飛的也不會整批同步
    const el=document.createElement("div");
    el.className="emote-fly"+(m.kind==="text"?" is-text":"")+(m.kind==="voice"?" is-voice":"")
              +((efCount()+1>=EF_SMALL)?" ef-sm":"");
    el.style.setProperty("--ef-dx",(t*20).toFixed(1)+"px");
    el.style.setProperty("--ef-dur",dur.toFixed(2)+"s");
    el.style.left=(cx+t*span+(Math.random()-0.5)*14)+"px";
    el.style.top=(cy+(EF_DY[lane]||0)+(Math.random()-0.5)*10)+"px";
    el.innerHTML='<span class="ef-emo">'+esc(m.emoji)+'</span><span class="ef-cap">'+esc(m.caption)+'</span>';   // esc:防止對方送入惡意內容
    layer.appendChild(el);
    // append 完才量得到實際寬度,再把邊緣發位夾回畫面內(長名字的膠囊很寬,不夾會被裁掉)
    // ⚠ 要用 offsetWidth,不可以用 getBoundingClientRect —— 動畫 0% 有 scale(.4),rect 量到的是縮小後的寬度
    const half=el.offsetWidth/2+8;
    if(half>8) el.style.left=Math.max(half,Math.min(innerWidth-half,parseFloat(el.style.left)))+"px";
    efNextAt=Date.now()+EF_GAP;
    setTimeout(()=>{ el.remove(); efPump(); }, dur*1000+120);   // 用 timeout 移除(電子書模式關動畫仍會清掉)
  }
  function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }


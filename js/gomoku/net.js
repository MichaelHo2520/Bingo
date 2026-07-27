"use strict";

/* ============================================================================
   五子棋 — 連線對戰(MPG 模組)
   資料放在**獨立**的頂層節點 gomoku_rooms / gomoku_index,與 Bingo 的 rooms /
   rooms_index 完全隔離 → Bingo 的程式與資料零改動,兩邊大廳互不干擾。
   ⚠ 需在 Firebase 規則開放 gomoku_rooms 與 gomoku_index 的讀寫。

   本檔是 js/online.js(Bingo)成熟做法的移植,以下設計是踩過坑修出來的,不要「簡化」:
   1. 進新房 gameRev 必須歸零(否則新房快照會被「rev < gameRev」全部誤丟 → 整房卡死)
   2. scores/{id} 獨立於 players/{id} 且刻意不掛 onDisconnect(斷線會連坐清掉分數)
   3. 一局揮發狀態收在單一 game 節點 + 單調遞增 rev(消除跨欄位事件到達順序問題)
   4. txGame 內 !g 要回傳 undefined 中止交易(回傳 null 會把節點刪掉)
   5. 斷線復原兩層:.info/connected 重連歸位 + GRACE_MS 寬限期
   6. 落子一律綁點擊、由 tap() 自行判定並給回饋(不用 disabled 讓格子靜默吃掉點擊)

   與 Bingo 的差異(五子棋簡化掉的):
   • 不存 turnIndex —— 嚴格輪流,該下的人 = order[moves.length % 2],少一個不一致來源
   • 沒有平手 winAt 判定 —— 勝負由「下最後一手的人」單方寫入,第一個寫進去的就是結果
   • 房間上限 2 人 —— 入座用 players 節點的 transaction 搶位,避免第 3 人破壞 1v1
   ========================================================================== */

const MPG = (function(){
  const ROOMS = "gomoku_rooms", INDEX = "gomoku_index";
  const GRACE_MS = 20000;                 // 斷線寬限(手機切 App 常見情境)
  const ALONE_MS = 8000;                  // 對手離開後仍只剩自己 → 退回等待
  const MAX_PLAYERS = 2;                  // 第一版 1v1(擂台觀戰見 notes/plan 第二版)

  let db=null, roomRef=null, code=null, meId=null, meName="玩家", isHost=false, roomName="";
  let online=false;
  let roomsWatchRef=null, lastRoomsSig=null, lastIndexSig=null;
  let players={}, scores={}, status="lobby", curPhase="lobby", ready=false;
  let order=[], moves=[], winner=null, roundId=null;
  let gameRev=0;                          // 本地已套用的最新 game 版本(見上 #1)
  let boardSize=19, swapFirst=true;   // 預設中間的 19×19(圍棋盤大小:15×15 下起來很快就頂到邊界)
  const SIZES=[15,19,25];             // 可選盤面;預設值也定義在 gomoku.html 的 .on,兩處要一致
  let scoreMode="rank", winGoal=3, scoredThisRound=false, myRoundWin=false;
  let outcomeShown=false, abandoned=false, wasMyTurn=false, autoStarting=false;
  let prevIds=null, sawPlayers=false, sawMe=false, hostId=null, sawHost=false;
  let connRef=null, connected=null, resyncing=false, resyncTimer=null;
  let graceTimer=null, aloneTimer=null, aloneTick=null;
  let emotesReady=false;

  /* ---------- 基礎 ---------- */
  function configReady(){ return !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf("PASTE")<0); }
  function available(){ return !!(window.firebase && configReady()); }
  let fbLoading=null;
  function ensureFirebase(){
    if(window.firebase) return Promise.resolve(true);
    if(fbLoading) return fbLoading;
    const base="https://www.gstatic.com/firebasejs/10.12.2/";
    const load=src=>new Promise((res,rej)=>{
      const s=document.createElement("script"); s.src=src; s.async=false;
      s.onload=()=>res(); s.onerror=()=>rej(new Error("load "+src));
      document.head.appendChild(s);
    });
    fbLoading = load(base+"firebase-app-compat.js")
      .then(()=>load(base+"firebase-database-compat.js"))
      .then(()=>!!window.firebase)
      .catch(e=>{ fbLoading=null; throw e; });
    return fbLoading;
  }
  function init(){
    if(db) return true;
    if(!available()) return false;
    try{
      if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db=firebase.database(); return true;
    }catch(e){ console.error(e); return false; }
  }
  function randomCode(){ let s=""; for(let i=0;i<4;i++)s+=Math.floor(Math.random()*10); return s; }
  // 玩家身分與 Bingo 共用(同一個人在兩個遊戲是同一身分)
  function pid(){
    let id; try{ id=localStorage.getItem("bingo.pid"); }catch(e){}
    if(!id){ id="p"+Math.random().toString(36).slice(2,9); try{ localStorage.setItem("bingo.pid",id); }catch(e){} }
    return id;
  }
  function setMsg(t){ const el=$("mpConnMsg"); if(el) el.textContent=t||""; }
  function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
  function dispName(id){
    const raw=(players[id]&&players[id].name)||"玩家";
    const same=Object.keys(players).filter(x=>((players[x]&&players[x].name)||"玩家")===raw);
    return same.length<=1 ? raw : raw+(same.indexOf(id)+1);
  }
  function youTag(id){ return id===meId ? '<span class="you-badge">你</span>' : ''; }

  /* ---------- 連線畫面 / 大廳 ---------- */
  function openConnect(){
    online=false;
    $("mpConnect").classList.remove("hidden");
    $("mpBar").classList.add("hidden");
    $("gmkSetup").classList.add("hidden");
    $("scrollArea").classList.add("hidden");
    $("gmkStage").classList.add("hidden");
    $("primaryBar").classList.add("hidden");
    $("mpRoomList").innerHTML="";
    if(!configReady()){ setMsg("⚠ 尚未設定 Firebase,連線未啟用。"); setLive("none","連線未啟用"); return; }
    setMsg("連線載入中…"); setLive("loading","連線載入中…");
    ensureFirebase().then(()=>{
      setMsg("點下方房間即可直接加入");
      startRoomWatch();
    }).catch(()=>{
      setMsg("⚠ 連線元件載入失敗,請檢查網路後再試。"); setLive("error","載入失敗");
    });
  }
  function setLive(stateName,text){
    const el=$("mpLive"); if(!el)return;
    el.setAttribute("data-state",stateName);
    const t=$("mpLiveTxt"); if(t) t.textContent=text;
  }
  function roomItems(idx){
    return Object.keys(idx).map(c=>{
      const r=idx[c]||{};
      return { code:c, status:r.status||"lobby", count:r.count||0, host:r.host||"", name:r.name||"" };
    }).filter(r=>r.count>0).sort((a,b)=>a.code.localeCompare(b.code));
  }
  function applyRooms(items){
    const sig=items.map(r=>r.code+":"+r.status+":"+r.count+":"+r.host+":"+r.name).join("|");
    if(sig===lastRoomsSig)return;
    lastRoomsSig=sig;
    renderRoomList(items);
    const open=items.filter(joinable).length;
    if(!items.length) setLive("none","目前沒有人開房間,開一間吧！");
    else if(open>0) setLive("open","現在有 "+open+" 間房間可加入"+(items.length>open?" · 另 "+(items.length-open)+" 間不可加入":""));
    else setLive("busy",items.length+" 間房間都在對戰中 / 已滿");
  }
  // 可加入 = 還在大廳 且 未滿(1v1)
  function joinable(r){ return r.status==="lobby" && r.count<MAX_PLAYERS; }
  function startRoomWatch(){
    if(!init()){ setLive("none","連線未啟用"); return; }
    stopRoomWatch();
    lastRoomsSig=null; setLive("loading","偵測目前房間中…");
    roomsWatchRef=db.ref(INDEX);
    roomsWatchRef.on("value", s=>applyRooms(roomItems(s.val()||{})), err=>{
      stopRoomWatch(); setLive("error","無法讀取房間清單");
      $("mpRoomList").innerHTML='<div class="room-empty">偵測失敗:'+esc(err.message)+
        '(可能是資料庫規則還沒開放 '+INDEX+' 的讀取,見 notes/plan/PLAN-五子棋連線對戰.md)</div>';
    });
  }
  function stopRoomWatch(){ if(roomsWatchRef){ roomsWatchRef.off(); roomsWatchRef=null; } }
  function scanRooms(){ if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; } startRoomWatch(); }
  function renderRoomList(items){
    const box=$("mpRoomList"); if(!box)return; box.innerHTML="";
    const open=items.filter(joinable), busy=items.filter(r=>!joinable(r));
    if(open.length) box.appendChild(buildRoomGroup(true,open));
    if(busy.length) box.appendChild(buildRoomGroup(false,busy));
  }
  function buildRoomGroup(ok,rooms){
    const g=document.createElement("div");
    g.className="room-group"+(ok?" joinable":"");
    const head=document.createElement("div");
    head.className="room-group-title";
    head.innerHTML='<span class="gt-dot" aria-hidden="true"></span>'+(ok?"可以加入":"無法加入")+' · '+rooms.length+' 間';
    g.appendChild(head);
    rooms.forEach(r=>{
      const it=document.createElement("button");
      it.type="button"; it.className="room-item"+(ok?" joinable":" busy"); it.disabled=!ok;
      const hostTag=r.host?'<span class="host">👑 '+esc(r.host)+'</span> · ':'';
      const nm=r.name||("房間 "+r.code);
      const cta=ok ? '<span class="join-cta">加入 ▸</span>'
                   : '<span class="busy-tag">'+(r.count>=MAX_PLAYERS&&r.status==="lobby"?"🔒 已滿":"🔒 對戰中")+'</span>';
      it.innerHTML='<span class="room-main"><span class="rn">🏠 '+esc(nm)+'</span>'+
        '<span class="meta">'+hostTag+'👥 '+r.count+' / '+MAX_PLAYERS+' 人</span></span>'+cta;
      if(ok) it.addEventListener("click",()=>join(r.code,$("mpName").value,r.name));
      g.appendChild(it);
    });
    return g;
  }
  function flagNameNeeded(){
    const el=$("mpName");
    if(el){ el.classList.remove("needs-name"); void el.offsetWidth; el.classList.add("needs-name"); try{ el.focus(); }catch(e){} el.scrollIntoView&&el.scrollIntoView({block:"center"}); }
    showToast("請先輸入你的暱稱 🙂",2200);
  }

  /* ---------- 建房 / 加入 ---------- */
  function create(name,wantName){
    if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
    const nm=(name||"").trim();
    if(!nm){ flagNameNeeded(); return; }
    meName=nm.slice(0,8); meId=pid(); isHost=true;
    roomName=(wantName||"").trim().slice(0,12) || (meName+"的房間");
    code=randomCode(); roomRef=db.ref(ROOMS+"/"+code);
    roomRef.child("host").once("value").then(snap=>{
      if(snap.exists()){ code=randomCode(); roomRef=db.ref(ROOMS+"/"+code); }   // 撞號重抽一次
      return roomRef.update({
        host:meId, roomName:roomName, boardSize:boardSize, swapFirst:swapFirst,
        scoreMode:scoreMode, winGoal:winGoal, emotes:null, createdAt:Date.now(),
        game:{ rev:1, status:"lobby", order:null, moves:[], winner:null, roundId:null }
      });
    }).then(()=>{
      claimSeat(okSeat=>{
        if(!okSeat){ setMsg("建立房間失敗,請再試一次。"); return; }
        enterLobby(); armRoomIndex();
      });
    }).catch(e=>setMsg("建立房間失敗:"+((e&&e.message)||e)));
  }
  function join(inCode,name,inName){
    if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
    const nm=(name||"").trim();
    if(!nm){ flagNameNeeded(); return; }
    const c=(inCode||"").replace(/\D/g,"").trim();
    if(c.length<4){ setMsg("請從下方清單選擇房間加入。"); return; }
    meName=nm.slice(0,8); meId=pid(); isHost=false; code=c; roomName=inName||"";
    roomRef=db.ref(ROOMS+"/"+code);
    roomRef.once("value").then(snap=>{
      const r=snap.val();
      if(!r||!r.host){ setMsg("這個房間已經關閉了,請重新選擇。"); return; }
      if(r.game && r.game.status && r.game.status!=="lobby"){ setMsg("這間正在對戰中,無法加入。"); return; }
      roomName=inName||r.roomName||("房間 "+code);
      if(typeof r.boardSize==="number") boardSize=r.boardSize;
      claimSeat(okSeat=>{
        if(!okSeat){ setMsg("這個房間已經滿了(1 對 1),請選別間。"); roomRef=null; code=null; return; }
        enterLobby();
      });
    }).catch(e=>setMsg("加入失敗:"+e.message));
  }
  /* 入座:用 players 節點的 transaction 搶位 —— 1v1 必須擋住第 3 人
     (兩人同時點加入的競態,用 once+set 是擋不住的)。重連時同一個 meId 直接沿用原位。 */
  function claimSeat(done){
    if(!roomRef||!meId){ done&&done(false); return; }
    roomRef.child("players").transaction(p=>{
      p=p||{};
      if(p[meId]){ p[meId].name=meName; return p; }          // 已在座位上(重連)→ 只更新名字
      if(Object.keys(p).length>=MAX_PLAYERS) return;          // 滿了 → 中止交易
      p[meId]={ name:meName, ready:false };
      return p;
    },(err,committed)=>{
      const ok=!err&&committed;
      if(ok) roomRef.child("players/"+meId).onDisconnect().remove();
      done&&done(ok);
    });
  }

  /* ---------- 大廳輕量索引(房主單方維護) ---------- */
  function updateRoomIndex(){
    if(!isHost||!roomRef||!db||!code)return;
    const ids=Object.keys(players);
    let count=ids.length;
    if(!players[meId]) count+=1;                              // 建房瞬間自己還沒同步回來
    const hostName=(players[meId]&&players[meId].name)||meName||"";
    const sig=roomName+"|"+status+"|"+count+"|"+hostName;
    if(sig===lastIndexSig)return;                             // 只有落子等變動 → 不寫,省流量
    lastIndexSig=sig;
    db.ref(INDEX+"/"+code).update({ name:roomName, status:status, count:count, host:hostName });
  }
  function armRoomIndex(){
    if(!isHost||!roomRef||!db||!code)return;
    db.ref(INDEX+"/"+code).onDisconnect().remove();
    lastIndexSig=null; updateRoomIndex();
  }

  /* ---------- 相位:大廳 ---------- */
  function enterLobby(){
    online=true; ready=false; curPhase="lobby";
    sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
    gameRev=0;   // ★ 進新房必歸零(見檔頭 #1)
    document.body.classList.add("mp-on"); resetQuickVoiceBtn();
    stopRoomWatch();
    $("mpConnect").classList.add("hidden");
    $("mpBar").classList.remove("hidden");
    $("scrollArea").classList.remove("hidden");
    $("gmkSetup").classList.remove("hidden");
    $("gmkStage").classList.add("hidden");
    $("primaryBar").classList.remove("hidden");
    $("mpReadyBtn").classList.remove("hidden");
    $("resignBtn").classList.add("hidden");
    $("mpRoomTitle").textContent=roomName||("房間 "+code);
    syncSubrow(); syncSetupRow(); updateReadyBtn(); updateMpGoal();
    listen(); watchConn();
  }
  // 回大廳續玩(本局結束 / 作廢):只重設本地,不動別人
  function backToLobby(){
    ready=false; curPhase="lobby"; moves=[]; order=[]; winner=null;
    outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false; wasMyTurn=false;
    clearAloneCheck(); closeWin();
    $("scrollArea").classList.remove("hidden");
    $("gmkSetup").classList.remove("hidden");
    $("gmkStage").classList.add("hidden");
    $("primaryBar").classList.remove("hidden");
    $("mpReadyBtn").classList.remove("hidden");
    $("resignBtn").classList.add("hidden");
    GB.reset(); GB.setInteractive(false);
    syncSubrow(); syncSetupRow(); updateReadyBtn(); updateMpGoal(); setActionHint("");
  }
  /* ---------- 相位:對戰中 ---------- */
  function enterPlaying(){
    curPhase="playing";
    outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false; wasMyTurn=false;
    closeWin();
    $("scrollArea").classList.add("hidden");
    $("gmkSetup").classList.add("hidden");
    $("gmkStage").classList.remove("hidden");
    // 對戰中整條動作列收起來:準備鈕用不到、認輸鈕已搬進房間框,留著只是白吃一列高度
    $("primaryBar").classList.add("hidden");
    $("mpReadyBtn").classList.add("hidden");
    $("resignBtn").classList.remove("hidden");
    syncSubrow(); setActionHint("");
    GB.setSize(boardSize);
    GB.applyMoves(moves);
    // 舞台這一刻才從 hidden 變可見,同一個 tick 量到的 clientWidth 還是 0 → 下一格再算一次視角。
    // initialView():小盤面直接 fit;大盤面(fit 後每格 < 30px)自動放大到中央天元,不必一開局就先手動放大
    requestAnimationFrame(()=>GB.initialView());
    if(moves.length) GB.setLastByIndex(moves[moves.length-1]);
    updateTurnUI(); updateMpGoal();
    Sound.start();
  }

  /* ---------- 監聽 ---------- */
  function listen(){
    roomRef.child("host").on("value",s=>{
      hostId=s.val()||null; if(hostId)sawHost=true;
      if(hostGone()) scheduleRecheck();
    });
    roomRef.child("players").on("value",s=>{
      players=s.val()||{};
      { const ids=Object.keys(players);
        if(prevIds!==null && curPhase==="lobby" && ids.some(id=>id!==meId && prevIds.indexOf(id)<0)) Sound.join();
        prevIds=ids; }
      if(Object.keys(players).length) sawPlayers=true;
      if(players[meId]) sawMe=true;
      if(iWasKicked() && stableOnline()){ showToast("你已被房主移出房間"); leave(); return; }
      const alone=isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1;
      if(alone) scheduleAloneCheck(); else clearAloneCheck();
      if(iWasKicked() || hostGone()) scheduleRecheck(); else clearRecheck();
      renderPlayers(); updateStartBtn();
      if(isHost) updateRoomIndex();
      if(curPhase==="lobby") syncSetupRow();
      else if(curPhase==="playing"){ updateTurnUI(); if(winner) showOutcome(); }
    });
    // 一局揮發狀態:單一 game 節點、單一監聽(見檔頭 #3)
    roomRef.child("game").on("value",s=>onGame(s.val()));
    roomRef.child("boardSize").on("value",s=>{
      const v=s.val();
      if(typeof v!=="number"||SIZES.indexOf(v)<0||v===boardSize)return;
      boardSize=v;
      if(!isHost && ready){ ready=false; roomRef.child("players/"+meId).update({ready:false}); updateReadyBtn(); }
      if(curPhase==="playing"){ GB.setSize(boardSize); GB.applyMoves(moves); GB.fit(); }
      syncSetupRow(); updateMpGoal();
    });
    roomRef.child("swapFirst").on("value",s=>{ swapFirst=s.val()!==false; syncSetupRow(); });
    roomRef.child("scoreMode").on("value",s=>{ scoreMode=(s.val()==="match")?"match":"rank"; syncSetupRow(); renderPlayers(); });
    roomRef.child("winGoal").on("value",s=>{ const v=s.val(); winGoal=(typeof v==="number"&&v>=2)?Math.min(20,v):3; syncSetupRow(); });
    // 分數:獨立節點,刻意不掛 onDisconnect(見檔頭 #2)
    roomRef.child("scores").on("value",s=>{
      scores=s.val()||{};
      if(curPhase==="lobby") syncSetupRow();
      renderPlayers();
      if(winner) renderScoreboard();
    });
    emotesReady=false;
    roomRef.child("emotes").on("child_added",s=>{ if(emotesReady)handleEmote(s.val()); });
    roomRef.child("emotes").once("value",()=>{ emotesReady=true; });
  }

  /* ---------- game 節點:寫入輔助 + 派發 ---------- */
  function setGame(g){ if(!roomRef)return; g.rev=gameRev+1; roomRef.child("game").set(g); }
  function patchGame(p){ if(!roomRef)return; p.rev=gameRev+1; roomRef.child("game").update(p); }
  function txGame(mut){
    if(!roomRef)return;
    roomRef.child("game").transaction(g=>{
      if(!g)return;                 // ★ 回傳 undefined 中止;回傳 null 會刪掉節點(見檔頭 #4)
      if(mut(g)===false)return;
      g.rev=(g.rev||0)+1;
      return g;
    });
  }
  function onGame(g){
    g=g||{};
    const rev=(typeof g.rev==="number")?g.rev:0;
    if(rev<gameRev)return;          // 過期快照
    gameRev=rev;
    const prevLen=moves.length;
    order=g.order||[]; roundId=g.roundId||null;
    const nextMoves=Array.isArray(g.moves)?g.moves:[];
    const nextWinner=g.winner||null, nextStatus=g.status||"lobby";
    const hadWinner=!!winner;
    winner=nextWinner; status=nextStatus;
    const statusChanged=(nextStatus!==curPhase);

    // 相位派發
    if(status==="playing"){ if(curPhase!=="playing") { moves=[]; enterPlaying(); } }
    else { if(curPhase!=="lobby" && !winner) backToLobby(); }

    // 棋盤同步:能延續就只 append 新子,否則整盤重建
    if(curPhase==="playing"){
      const r=GB.applyMoves(nextMoves);
      moves=nextMoves.slice();
      const last=moves.length?moves[moves.length-1]:-1;
      if(r.added.length===1){
        // 單手落子(正常對局):落子音 + 對手那手帶進視野並報座標
        GB.setLastByIndex(last);
        Sound.place();
        const iPlacedIt=(GB.colorOfStep(moves.length-1)===myColor());
        if(!iPlacedIt){
          GB.focusOn(last);
          showToast((GB.colorOfStep(moves.length-1)==="b"?"⚫":"⚪")+" 對手下在 "+GB.coordName(last),1400);
        }
        maybeSettle(last);
      }else if(r.added.length>1){
        // 批次同步(重連歸位 / 剛進遊戲):只標最後一手,不連播音效也不跳 toast
        GB.setLastByIndex(last);
        if(last>=0) GB.focusOn(last);
      }
      updateTurnUI();
    }else{
      moves=nextMoves.slice();
    }

    if(winner){ onWinner(); }
    else if(hadWinner) closeWin();
    if(statusChanged && isHost) updateRoomIndex();
    if(curPhase==="lobby") updateStartBtn();
  }
  function onStatusTxt(t){ const el=$("mpStatusTxt"); if(el){ el.classList.remove("wait"); el.textContent=t; } }

  /* ---------- 開打 ---------- */
  function myColor(){ return order.length && order[0]===meId ? "b" : "w"; }
  function turnId(){ return order.length ? order[moves.length % order.length] : null; }
  function isMyTurn(){ return curPhase==="playing" && !winner && !abandoned && turnId()===meId; }
  function updateStartBtn(){
    if(!isHost)return;
    const ids=Object.keys(players);
    const allReady=ids.length>=2 && ids.every(id=>players[id].ready);
    if(status!=="lobby" || !allReady){ autoStarting=false; return; }
    if(!autoStarting){ autoStarting=true; startGame(); }   // 兩人都準備好 → 房主端自動開打
  }
  function startGame(){
    if(!isHost)return;
    const ids=Object.keys(players);
    if(ids.length<2 || !ids.every(id=>players[id].ready)){ showToast("需要 2 人並且都準備好"); return; }
    // 先手:swapFirst → 沿用上一局順序反轉(輪流當黑);否則每局重抽
    const prev=(order.length===ids.length && order.every(id=>players[id])) ? order.slice() : null;
    let ord;
    if(swapFirst && prev) ord=prev.reverse();
    else { ord=ids.slice(); for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; } }
    const pups={}; ids.forEach(id=>{ pups["players/"+id+"/ready"]=false; });
    roomRef.update(pups);
    setGame({ status:"playing", order:ord, moves:[], winner:null, roundId:Date.now() });
  }
  function toggleReady(){
    if(!roomRef||!meId)return;
    ready=!ready;
    roomRef.child("players/"+meId).update({ ready:ready, name:meName });
    updateReadyBtn();
  }
  function updateReadyBtn(){
    const b=$("mpReadyBtn"); if(!b)return;
    b.textContent=ready?"取消準備":"準備好了";
    b.classList.toggle("ghost",ready); b.classList.toggle("primary",!ready);
    const ids=Object.keys(players);
    setActionHint(ids.length<2 ? "等對手加入…(房間可分享給朋友)"
                 : (ready ? "等對手按準備…" : "按「準備好了」就開始"));
  }

  /* ---------- 落子 ---------- */
  function tap(i){
    if(curPhase!=="playing"){ return; }
    if(winner||abandoned){ return; }
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    if(GB.occupied(i)){ showToast("這裡已經有子了"); return; }
    const step=moves.length;
    // 交易內原子 append:即使兩端同時點也不會覆蓋彼此;步數不符(對手先寫進去)就中止
    txGame(g=>{
      if(g.status!=="playing"||g.winner)return false;
      const mv=Array.isArray(g.moves)?g.moves:[];
      if(mv.length!==step)return false;      // 這一步已被別人佔用(不同步)→ 中止,等快照
      if(mv.indexOf(i)>=0)return false;
      g.moves=mv.concat(i);
    });
  }
  // 落子後的結算:連五 / 和局。只由「下這一手的人」寫入,避免兩端同時寫
  function maybeSettle(last){
    if(winner)return;
    const iPlacedIt=(GB.colorOfStep(moves.length-1)===myColor());
    if(!iPlacedIt)return;
    const line=GB.checkWin(last);
    if(line){
      txGame(g=>{ if(g.winner)return false; g.winner={ id:meId, name:meName, by:"five", line:line }; });
      return;
    }
    if(GB.isFull()){
      txGame(g=>{ if(g.winner)return false; g.winner={ id:null, name:"", by:"draw" }; });
    }
  }
  /* ---------- 認輸 ---------- */
  let resignAsked=false;
  function askResign(){
    if(curPhase!=="playing"||winner||abandoned){ showToast("現在不能認輸"); return; }
    resignAsked=true; $("resignVeil").classList.add("show");
  }
  function closeResign(){ resignAsked=false; $("resignVeil").classList.remove("show"); }
  function confirmResign(){
    closeResign();
    if(curPhase!=="playing"||winner)return;
    const foe=order.find(id=>id!==meId) || Object.keys(players).find(id=>id!==meId);
    if(!foe){ showToast("找不到對手"); return; }
    txGame(g=>{ if(g.winner)return false; g.winner={ id:foe, name:dispName(foe), by:"resign" }; });
  }

  /* ---------- 結果 / 計分 ---------- */
  function onWinner(){ if(winner) showOutcome(); }
  function showOutcome(){
    if(!winner)return;
    const isDraw=winner.by==="draw";
    const iWon=!isDraw && winner.id===meId;
    const finalists=isDraw?Object.keys(players):[winner.id];
    myRoundWin=isDraw||iWon;

    if(winner.line) GB.markWin(winner.line);
    GB.setInteractive(false);
    $("resignBtn").classList.add("hidden");

    // 計分:贏家(和局雙方)幫自己 +1,一局只計一次(roundId 冪等 + 交易內再驗一次)
    if(myRoundWin && meId && roomRef && roundId && !scoredThisRound && scoredRoundOf(meId)!==roundId){
      scoredThisRound=true;
      roomRef.child("scores/"+meId).transaction(s=>{
        if(s && s.round===roundId) return;
        return { n:((s&&s.n)||0)+1, round:roundId };
      },()=>{ if(winner) renderScoreboard(); });
    }

    // 大字只講「對我而言」的輸贏,卡片再依結果換色(原本輸贏共用同一組金色漸層,輸了也一樣喜氣)
    const card=$("gmkWinCard");
    if(card){ card.classList.remove("win","lose","draw"); card.classList.add(isDraw?"draw":(iWon?"win":"lose")); }
    renderWinnerRow(isDraw);
    if(isDraw){
      $("winWord").textContent="平手!";
      $("winMsg").textContent="棋盤下滿了,這局和局 🤝";
      if(!outcomeShown) Sound.win();
    }else if(iWon){
      $("winWord").textContent="你贏了!";
      $("winMsg").textContent=winner.by==="resign" ? "對手認輸 🏳" : "五子連線,漂亮 🎉";
      if(!outcomeShown){ Sound.win(); burst(); }
    }else{
      $("winWord").textContent="你輸了";
      $("winMsg").textContent=winner.by==="resign" ? "你認輸了 🏳" : "對手連成五子";
      if(!outcomeShown) Sound.lose();
    }
    renderScoreboard();
    showResult();
    outcomeShown=true;
    // 本局結束就把自己設為未準備(下一局要各自重新按準備)
    if(meId && roomRef) { ready=false; roomRef.child("players/"+meId).update({ ready:false }); }
    updateTurnUI();
  }
  // 「這局是誰拿下」:大字是主觀的(你贏了/你輸了),這一列給客觀事實 —— 棋色 + 名字 +(你)
  function renderWinnerRow(isDraw){
    const el=$("gmkWinner"); if(!el)return;
    if(isDraw){ el.innerHTML='<span class="gw-tag">🤝 雙方平手,各得 1 勝</span>'; return; }
    const id=winner.id, seat=order.indexOf(id);
    const side=seat>=0?'<span class="gmk-seat '+(seat===0?"b":"w")+'"><i></i>'+(seat===0?"黑":"白")+'</span>':'';
    el.innerHTML=side+'<span class="gw-name">'+esc(dispName(id))+'</span>'+youTag(id)+'<span class="gw-tag">拿下這局</span>';
  }
  function scoreOf(id){ return (scores[id]&&scores[id].n)||0; }
  function scoredRoundOf(id){ return scores[id]&&scores[id].round; }
  function renderScoreboard(){
    const sb=$("winScores"), champEl=$("winChamp"), nsBtn=$("mpNewSeason");
    if(!sb)return;
    const rows=Object.keys(players).map(id=>{
      let score=scoreOf(id);
      if(id===meId && myRoundWin && roundId && scoredRoundOf(id)!==roundId) score+=1;   // 樂觀 +1
      return { id, score, name:dispName(id) };
    }).sort((a,b)=> b.score-a.score || (a.id<b.id?-1:1));
    const top=rows.length?rows[0].score:0;
    const champs=(scoreMode==="match" && top>=winGoal) ? rows.filter(r=>r.score===top) : [];
    if(champEl){
      if(champs.length){
        champEl.innerHTML='<span class="champ-label">🏆 總冠軍</span>'+
          '<span class="champ-name">'+champs.map(c=>esc(c.name)).join("、")+'</span>'+
          '<span class="champ-goal">先達 '+winGoal+' 勝</span>';
        champEl.classList.remove("hidden");
      }else champEl.classList.add("hidden");
    }
    if(top>0 || scoreMode==="match"){
      const goalCap=(scoreMode==="match" && !champs.length) ? '<div class="ws-goal">🎯 搶 '+winGoal+' 勝</div>' : '';
      // 本局 +1 的人:總數之外把「分數是怎麼變的」也講出來,才看得出這局誰得手
      const gained=winner ? (winner.by==="draw" ? Object.keys(players) : [winner.id]) : [];
      sb.innerHTML=goalCap+rows.map((r,i)=>{
        const lead=r.score===top && top>0;
        const cls="ws-row"+(lead?" lead":"")+(r.id===meId?" me":"");
        const plus=gained.indexOf(r.id)>=0 ? '<span class="gw-plus">+1</span>' : '';
        return '<div class="'+cls+'"><span class="ws-rank">'+(lead?"🏆":(i+1)+".")+'</span>'+
               '<span class="ws-name">'+esc(r.name)+'</span>'+plus+'<span class="ws-pts">'+r.score+' 勝</span></div>';
      }).join("");
      sb.classList.remove("hidden");
    }else{ sb.innerHTML=""; sb.classList.add("hidden"); }
    if(nsBtn) nsBtn.classList.toggle("hidden", !(champs.length && isHost));
  }
  // 「繼續」= 各自回大廳重新準備(不強拉別人);第一個按的人把 status 翻回 lobby
  function again(){
    if(!roomRef)return;
    if(status!=="lobby") txGame(g=>{ if(g.status==="lobby")return false; g.status="lobby"; });
    backToLobby();
  }

  /* ---------- 玩家名單 / 輪到誰 ---------- */
  function renderPlayers(){
    const box=$("mpPlayers"); if(!box)return; box.innerHTML="";
    box.classList.add("oneline");
    const ids=Object.keys(players);
    if(pendingKickId && (status!=="lobby" || !players[pendingKickId])) closeKick();
    ids.forEach(id=>{
      const p=players[id]||{};
      const isTurn=curPhase==="playing" && !winner && turnId()===id;
      const chip=document.createElement("div");
      chip.className="mp-chip clickable"+(p.ready?" ready":"")+(id===meId?" me":"")+(isTurn?" turn":"");
      chip.dataset.id=id;
      chip.title=id===meId?"點一下傳送互動表情給全部人":"點一下傳送互動表情";
      chip.addEventListener("click",()=>openEmote(id===meId?"all":id));
      const seat=order.indexOf(id);
      // 對戰中:換成「棋子+黑/白」徽章(小圓點在深色主題下看不出誰是誰);準備狀態的圓點這時已無意義,不再佔位
      const inGame=(curPhase==="playing"&&seat>=0);
      const side=inGame?'<span class="gmk-seat '+(seat===0?"b":"w")+'" title="'+(seat===0?"黑棋(先手)":"白棋")+'"><i></i>'+(seat===0?"黑":"白")+'</span>':'<span class="dot"></span>';
      const sc=scoreOf(id);
      const scoreBadge=sc>0?'<span class="score-badge" title="累積勝場">🏆'+sc+'</span>':'';
      chip.innerHTML=side+'<span class="gmk-nm">'+esc(dispName(id))+'</span>'+youTag(id)+scoreBadge;
      if(isHost && status==="lobby" && id!==meId){
        const k=document.createElement("button");
        k.type="button"; k.className="mp-kick"; k.title="移出房間";
        k.setAttribute("aria-label","移出 "+dispName(id));
        k.innerHTML='<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        k.addEventListener("click",ev=>{ ev.stopPropagation(); askKick(id); });
        chip.appendChild(k);
      }
      box.appendChild(chip);
    });
    if(aloneTick){ /* 落單倒數中:狀態列交給倒數,不覆蓋 */ }
    else if(curPhase==="playing") onStatusTxt(winner?"這局結束":"對戰中…");
    else onStatusTxt(ids.length<2?"等待對手加入…":"等待雙方準備…");
    syncSubrow(); updateMpGoal();
  }
  // 狀態列的顯示與否:大廳一定要(在等什麼只有這裡說);對戰中收起來把高度讓給棋盤——
  // 「輪到誰」棋盤上緣就有膠囊了,唯一例外是落單倒數(棋盤上看不到,得放出來)
  function syncSubrow(){
    const el=$("mpSubrow"); if(!el)return;
    el.classList.toggle("hidden", curPhase==="playing" && !aloneTick);
  }
  function updateMpGoal(){
    const g=$("mpBarGoal"); if(!g)return;
    g.textContent = boardSize ? ("⬜ "+boardSize+"×"+boardSize) : "";
    // 對戰中讓位給認輸鈕(同一格位置):幾路棋盤看盤面就知道,大廳才是真的需要看它挑設定
    g.classList.toggle("hidden", curPhase==="playing");
  }
  // 輪到誰:棋盤上緣的膠囊(自己的回合會高亮脈動)
  function updateTurnUI(){
    const cap=$("gmkTurn"), txt=$("gmkTurnTxt");
    if(!cap||!txt)return;
    if(curPhase!=="playing"){ cap.classList.remove("mine"); return; }
    const mine=isMyTurn();
    const tid=turnId();
    const color=order.length ? (order.indexOf(tid)===0?"b":"w") : "b";
    const dot=cap.querySelector(".gmk-dot");
    if(dot) dot.className="gmk-dot "+color;
    if(winner) txt.textContent="這局結束";
    else txt.textContent = mine ? "輪到你" : ("輪到 "+(tid?dispName(tid):"對手"));
    cap.classList.toggle("mine", mine && !winner);
    GB.setInteractive(mine && !winner && !abandoned, myColor());
    notifyMyTurn(mine && !winner);
  }
  function notifyMyTurn(mine){
    if(mine && !wasMyTurn){
      try{ Sound.turn(); }catch(e){}
      if(typeof vibrateOn!=="undefined" && vibrateOn && navigator.vibrate){ try{ navigator.vibrate([90,60,90]); }catch(e){} }
    }
    wasMyTurn=mine;
  }

  /* ---------- 大廳設定列(房主可改,訪客唯讀) ---------- */
  function syncSetupRow(){
    if(!online)return;
    const szSeg=$("gmkSizeSeg"), swSeg=$("gmkSwapSeg");
    if(szSeg){ szSeg.classList.toggle("readonly",!isHost); [...szSeg.children].forEach(b=>b.classList.toggle("on",(+b.dataset.size)===boardSize)); }
    if(swSeg){ swSeg.classList.toggle("readonly",!isHost); [...swSeg.children].forEach(b=>b.classList.toggle("on",(b.dataset.swap==="1")===swapFirst)); }
    const szL=$("gmkSizeLabel"); if(szL) szL.textContent=isHost?"棋盤大小":"棋盤大小(房主決定)";
    const swL=$("gmkSwapLabel"); if(swL) swL.textContent=isHost?"每局換先手":"每局換先手(房主決定)";
    // 計分列(沿用 Bingo 的樣式與鎖定邏輯)
    $("scoreSeg").classList.toggle("readonly",!isHost);
    const scL=$("scoreLabel"); if(scL) scL.textContent=isHost?"連線計分":"連線計分(房主決定)";
    [...$("scoreSeg").children].forEach(b=>b.classList.toggle("on",b.dataset.score===scoreMode));
    const extra=$("scoreExtra"); if(extra) extra.classList.toggle("hidden",!(isHost||scoreMode==="match"));
    const locked=seasonInProgress();
    const wg=$("wgGroup"); if(wg){ wg.classList.toggle("hidden",scoreMode!=="match"); wg.classList.toggle("locked",locked); }
    const wv=$("winGoalVal"); if(wv) wv.textContent=winGoal;
    ["wgMinus","wgPlus"].forEach(id=>{ const b=$(id); if(b){ b.style.display=isHost?"":"none"; b.disabled=locked; } });
    const wh=$("wgLockHint"); if(wh) wh.classList.toggle("hidden",!(locked&&isHost));
    const rb=$("resetScoreBtn"); if(rb) rb.style.display=isHost?"":"none";
  }
  function seasonInProgress(){ return scoreMode==="match" && Object.keys(players).some(id=>scoreOf(id)>0); }
  function setBoardSize(v){
    if(!isHost||!roomRef){ showToast("只有房主能改棋盤大小"); return; }
    if(status!=="lobby"){ showToast("對戰中不能改棋盤"); return; }
    if(SIZES.indexOf(v)<0)return;
    boardSize=v; roomRef.child("boardSize").set(v); syncSetupRow(); updateMpGoal(); savePrefs();
  }
  function setSwapFirst(on){
    if(!isHost||!roomRef){ showToast("只有房主能改"); return; }
    swapFirst=!!on; roomRef.child("swapFirst").set(swapFirst); syncSetupRow(); savePrefs();
  }
  function setScoreMode(m){
    if(!isHost||!roomRef)return;
    scoreMode=(m==="match")?"match":"rank"; roomRef.child("scoreMode").set(scoreMode); syncSetupRow(); savePrefs();
  }
  function setWinGoal(v){
    if(!isHost||!roomRef||seasonInProgress())return;
    winGoal=Math.max(2,Math.min(20,v|0)); roomRef.child("winGoal").set(winGoal); syncSetupRow(); savePrefs();
  }
  function resetScores(){
    if(!isHost||!roomRef)return;
    const ups={}; Object.keys(players).forEach(id=>{ ups["scores/"+id]=null; });
    scoredThisRound=false;
    if(Object.keys(ups).length) roomRef.update(ups);
    showToast("已重設雙方戰績 🏆");
  }
  function usePrefs(o){
    o=o||{};
    if(o.scoreMode==="match"||o.scoreMode==="rank") scoreMode=o.scoreMode;
    if(typeof o.winGoal==="number"&&o.winGoal>=2) winGoal=Math.min(20,o.winGoal);
    if(SIZES.indexOf(o.boardSize)>=0) boardSize=o.boardSize;
    if(typeof o.swapFirst==="boolean") swapFirst=o.swapFirst;
  }

  /* ---------- 斷線復原 / 離開 / 踢人 ---------- */
  function hostGone(){ return !isHost && online && sawHost && sawPlayers && (!hostId || !players[hostId]); }
  function iWasKicked(){ return !isHost && online && sawMe && !players[meId]; }
  function stableOnline(){ return connected===true && !resyncing && !document.hidden; }
  function watchConn(){
    if(connRef||!db)return;
    connRef=db.ref(".info/connected");
    connRef.on("value",s=>{
      const now=!!s.val(), wasDown=(connected===false);
      connected=now;
      if(now&&wasDown) resume("已重新連線");
    });
  }
  function stopConn(){ if(connRef){ connRef.off(); connRef=null; } connected=null; }
  function resume(msg){
    if(!online||!roomRef||!meId)return;
    resyncing=true;
    if(resyncTimer)clearTimeout(resyncTimer);
    resyncTimer=setTimeout(()=>{ resyncing=false; resyncTimer=null; recheckPresence(); },GRACE_MS);
    // 重新入座:斷線期間位置可能被別人佔走(1v1)→ 用同一個 transaction,搶不回就只能退出
    claimSeat(ok=>{
      if(!ok){ showToast("你的位置已被其他玩家佔用",2600); leave(); return; }
      roomRef.child("players/"+meId).update({ name:meName, ready:!!ready });
      if(isHost) armRoomIndex();
      if(msg) showToast(msg,1500);
    });
  }
  function scheduleRecheck(){ if(!graceTimer)graceTimer=setTimeout(()=>{ graceTimer=null; recheckPresence(); },GRACE_MS); }
  function clearRecheck(){ if(graceTimer){ clearTimeout(graceTimer); graceTimer=null; } }
  function recheckPresence(){
    if(!online||!roomRef)return;
    if(iWasKicked() && connected){ showToast("你已被房主移出房間"); leave(); return; }
    if(hostGone()){ showToast("房主已離開,房間已關閉"); leave(); return; }
    if(isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1) hostAloneToLobby();
  }
  function paintAloneCountdown(sec){ const el=$("mpStatusTxt"); if(!el)return; el.classList.add("wait"); el.textContent="對手離開了,"+sec+" 秒後回到等待…"; }
  function scheduleAloneCheck(){
    if(aloneTimer)return;
    let left=Math.ceil(ALONE_MS/1000);
    paintAloneCountdown(left);
    aloneTick=setInterval(()=>{ left--; if(left>0)paintAloneCountdown(left); },1000);
    syncSubrow();   // 對戰中平常收起狀態列,倒數這種棋盤上看不到的訊息要放出來
    aloneTimer=setTimeout(()=>{
      aloneTimer=null; if(aloneTick){ clearInterval(aloneTick); aloneTick=null; syncSubrow(); }
      if(isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1) hostAloneToLobby();
    },ALONE_MS);
  }
  function clearAloneCheck(){ if(aloneTimer){ clearTimeout(aloneTimer); aloneTimer=null; } if(aloneTick){ clearInterval(aloneTick); aloneTick=null; syncSubrow(); } }
  function hostAloneToLobby(){
    if(curPhase==="lobby")return;
    abandoned=true;
    showToast("對手離開了,這局作廢,回到等待…",2600);
    resetRoomToLobby();
  }
  // 房主:把整房清回大廳(本局作廢;此時無 winner 要保留)
  function resetRoomToLobby(){
    if(!roomRef)return;
    const ups={ emotes:null };
    Object.keys(players).forEach(id=>{ ups["players/"+id+"/ready"]=false; });
    roomRef.update(ups);
    setGame({ status:"lobby", order:order.length?order:null, moves:[], winner:null, roundId:null });
    backToLobby();
  }
  let pendingKickId=null;
  function askKick(id){
    if(!isHost||!roomRef||id===meId)return;
    if(status!=="lobby"){ showToast("對戰中無法移除玩家"); return; }
    pendingKickId=id;
    $("kickMsg").innerHTML="確定要把「"+esc(dispName(id))+"」移出房間嗎?";
    $("kickVeil").classList.add("show");
  }
  function closeKick(){ pendingKickId=null; $("kickVeil").classList.remove("show"); }
  function confirmKick(){ const id=pendingKickId; closeKick(); if(id)kick(id); }
  function kick(id){
    if(!isHost||!roomRef||id===meId)return;
    if(status!=="lobby"){ showToast("對戰中無法移除玩家"); return; }
    const nm=dispName(id);
    roomRef.child("players/"+id).remove();
    roomRef.child("scores/"+id).remove();
    showToast("已移出 "+nm);
  }
  let pendingLeaveAct=null;
  function askLeave(act){
    if(!online){ (act||leave)(); return; }
    pendingLeaveAct=act||leave;
    const inGame=curPhase==="playing" && !winner && !abandoned;
    const t=$("leaveTitle"), m=$("leaveMsg"), b=$("leaveConfirm");
    if(t)t.textContent=inGame?"對戰中離開?":"離開房間?";
    if(m)m.innerHTML=isHost
      ? (inGame?"你是房主,離開會<b>直接關閉房間</b>,這局大家都下不完。"
              :"你是房主,離開會<b>關閉整個房間</b>,對手也會被退出。")
      : (inGame?"這局還沒下完,離開就<b>不算你的成績</b>。"
              :"確定要離開這個房間嗎?");
    if(b)b.textContent=inGame?"還是要離開":"離開房間";
    $("leaveVeil").classList.add("show");
  }
  function closeLeaveAsk(){ pendingLeaveAct=null; $("leaveVeil").classList.remove("show"); }
  function confirmLeave(){ const act=pendingLeaveAct; closeLeaveAsk(); if(act)act(); }
  function leave(){
    try{
      if(roomRef){
        ["host","players","game","boardSize","swapFirst","scoreMode","winGoal","scores","emotes"].forEach(k=>roomRef.child(k).off());
        if(isHost){
          if(meId) roomRef.child("players/"+meId).onDisconnect().cancel();
          roomRef.onDisconnect().cancel();
          if(db&&code){ const ix=db.ref(INDEX+"/"+code); ix.onDisconnect().cancel(); ix.remove(); }
          roomRef.remove();
        }else if(meId){
          const pr=roomRef.child("players/"+meId);
          pr.onDisconnect().cancel(); pr.remove();
          roomRef.child("scores/"+meId).remove();
        }
      }
    }catch(e){}
    stopConn(); clearRecheck(); clearAloneCheck();
    resyncing=false; if(resyncTimer){ clearTimeout(resyncTimer); resyncTimer=null; }
    roomRef=null; code=null; online=false; ready=false; isHost=false;
    players={}; scores={}; moves=[]; order=[]; winner=null; status="lobby"; curPhase="lobby";
    sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
    gameRev=0; lastIndexSig=null; outcomeShown=false; abandoned=false;
    scoredThisRound=false; myRoundWin=false; wasMyTurn=false; autoStarting=false; emotesReady=false;
    closeLeaveAsk(); closeKick(); closeResign(); closeEmote(); closeWin();
    document.body.classList.remove("mp-on"); resetQuickVoiceBtn();
    GB.reset(); GB.setInteractive(false);
    setActionHint("");
    openConnect();   // 回到連線畫面,可以再建房 / 加入
  }

  /* ---------- 好友互動:表情 / 語音 ---------- */
  function roster(){ return Object.keys(players).map(id=>({ id:id, name:dispName(id), me:id===meId })); }
  function sendEmote(to,emoji,kind,audio){
    if(!roomRef||!meId)return;
    const isText=kind==="text", isVoice=kind==="voice", isClip=kind==="clip";
    const ref=roomRef.child("emotes").push();
    const rec={ from:meId, to:to||"all", kind:isVoice?"voice":(isClip?"clip":(isText?"text":"emoji")),
                at:firebase.database.ServerValue.TIMESTAMP };
    if(isVoice){ rec.emoji="🎤"; rec.audio=String(audio||""); }
    else if(isClip){ rec.emoji="🔊"; rec.clip=String(audio||"").slice(0,40); }
    else { rec.emoji=String(emoji).slice(0,isText?24:8); }
    ref.set(rec);
    ref.onDisconnect().remove();
    setTimeout(()=>{ try{ ref.remove(); }catch(e){} }, isVoice?15000:6000);
  }
  function handleEmote(e){
    if(!e)return;
    const to=e.to||"all";
    if(to!=="all" && to!==meId && e.from!==meId)return;
    const fromNm=dispName(e.from)+(e.from===meId?"(你)":"");
    const toNm=(to==="all")?"全部人":dispName(to)+(to===meId?"(你)":"");
    const mine=e.from===meId, forMe=(to==="all"||to===meId);
    if(e.kind==="voice"){
      showEmote("🎤",fromNm+" → "+toNm,(to!=="all")?to:e.from,"voice");
      if(!mine&&forMe) enqueueVoice(e.audio);
      return;
    }
    if(e.kind==="clip"){
      showEmote("🔊",fromNm+" → "+toNm,(to!=="all")?to:e.from,"voice");
      if(!mine&&forMe) enqueueClip(e.clip);
      return;
    }
    if(!e.emoji)return;
    showEmote(e.emoji,fromNm+" → "+toNm,(to!=="all")?to:e.from,e.kind);
    if(!mine&&forMe) Sound.emote();
  }

  // 從背景切回前景:主動歸位一次 + 喚醒音訊
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden)return;
    resume(null);
    try{ Sound.wake(); }catch(e){}
    if(typeof kickVoiceQueue==="function") kickVoiceQueue();
  });

  return {
    available, openConnect, scanRooms, create, join, leave,
    toggleReady, tap, again, isOnline:()=>online, amHost:()=>isHost, amReady:()=>ready,
    isMyTurn, myColor, boardSize:()=>boardSize, swapFirst:()=>swapFirst,
    setBoardSize, setSwapFirst, setScoreMode, setWinGoal, resetScores,
    winGoal:()=>winGoal, scoreMode:()=>scoreMode, usePrefs,
    askResign, confirmResign, cancelResign:closeResign,
    askLeave, confirmLeave, cancelLeave:closeLeaveAsk,
    confirmKick, cancelKick:closeKick,
    roster, sendEmote
  };
})();

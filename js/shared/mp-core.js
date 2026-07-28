"use strict";

/* ============================================================================
   共用連線核心(MPCore)— 五子棋 / 數獨共用。★ Bingo(index.html)不載入這支,
   js/online.js 永遠獨立、永不改動。

   由 js/gomoku/net.js 抽出(v1.41.1):約七成的房間 / 斷線 / 計分 / 表情骨架放這裡,
   剩下三成遊戲專屬的部分做成「適配器(adapter)」介面 —— 見檔尾的介面說明。

   ⚠ 下列設計是 Bingo 一路踩坑修出來的,不要「簡化」:
   1. 進新房 gameRev 必須歸零(否則新房快照會被「rev < gameRev」全部誤丟 → 整房卡死)
   2. scores/{id} 獨立於 players/{id} 且刻意不掛 onDisconnect(斷線會連坐清掉分數)
   3. 一局揮發狀態收在單一 game 節點 + 單調遞增 rev(消除跨欄位事件到達順序問題)
   4. txGame 內 !g 要回傳 undefined 中止交易(回傳 null 會把節點刪掉)
   5. 斷線復原兩層:.info/connected 重連歸位 + GRACE_MS 寬限期
   6. 遊戲操作一律綁點擊、由 adapter 自行判定並給回饋(不用 disabled 靜默吃掉點擊)
   7. 入座用 players 節點的 transaction 搶位(once+set 擋不住同時加入的競態)
   ========================================================================== */

const MPCore = (function(){

  const GRACE_MS = 20000;                 // 斷線寬限(手機切 App 常見情境)
  const ALONE_MS = 8000;                  // 對手離開後仍只剩自己 → 退回等待

  function create(A){
    const ROOMS = A.ns.rooms, INDEX = A.ns.index;
    const MAX_PLAYERS = A.maxPlayers || 2;
    const MIN_PLAYERS = A.minPlayers || 2;

    let db=null, roomRef=null, code=null, meId=null, meName="玩家", isHost=false, roomName="";
    let online=false;
    let roomsWatchRef=null, lastRoomsSig=null, lastIndexSig=null;
    let players={}, scores={}, status="lobby", curPhase="lobby", ready=false;
    let order=[], winner=null, roundId=null;
    let gameRev=0;                          // 本地已套用的最新 game 版本(見上 #1)
    let scoreMode="rank", winGoal=3, scoredThisRound=false, myRoundWin=false;
    let outcomeShown=false, abandoned=false, autoStarting=false;
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
    // 玩家身分與 Bingo 共用(同一個人在所有遊戲是同一身分)
    function pid(){
      let id; try{ id=localStorage.getItem("bingo.pid"); }catch(e){}
      if(!id){ id="p"+Math.random().toString(36).slice(2,9); try{ localStorage.setItem("bingo.pid",id); }catch(e){} }
      return id;
    }
    function setMsg(t){ const el=$("mpConnMsg"); if(el) el.textContent=t||""; }
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
      $("scrollArea").classList.add("hidden");
      $("primaryBar").classList.add("hidden");
      A.openConnect && A.openConnect();
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
    // 可加入 = 還在大廳 且 未滿
    function joinable(r){ return r.status==="lobby" && r.count<MAX_PLAYERS; }
    function startRoomWatch(){
      if(!init()){ setLive("none","連線未啟用"); return; }
      stopRoomWatch();
      lastRoomsSig=null; setLive("loading","偵測目前房間中…");
      roomsWatchRef=db.ref(INDEX);
      roomsWatchRef.on("value", s=>applyRooms(roomItems(s.val()||{})), err=>{
        stopRoomWatch(); setLive("error","無法讀取房間清單");
        $("mpRoomList").innerHTML='<div class="room-empty">偵測失敗:'+esc(err.message)+
          '(可能是資料庫規則還沒開放 '+INDEX+' 的讀取)</div>';
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
    // 大廳狀態的 game 節點:通用欄位 + adapter 的遊戲專屬欄位(五子棋的 moves、數獨的 fills)
    function lobbyGame(keepOrder){
      return Object.assign(
        { status:"lobby", order:keepOrder||null, winner:null, roundId:null },
        (A.lobbyGame && A.lobbyGame()) || {}
      );
    }
    function create(name,wantName){
      if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
      const nm=(name||"").trim();
      if(!nm){ flagNameNeeded(); return; }
      meName=nm.slice(0,8); meId=pid(); isHost=true;
      roomName=(wantName||"").trim().slice(0,12) || (meName+"的房間");
      code=randomCode(); roomRef=db.ref(ROOMS+"/"+code);
      roomRef.child("host").once("value").then(snap=>{
        if(snap.exists()){ code=randomCode(); roomRef=db.ref(ROOMS+"/"+code); }   // 撞號重抽一次
        const payload=Object.assign({
          host:meId, roomName:roomName,
          scoreMode:scoreMode, winGoal:winGoal, emotes:null, createdAt:Date.now(),
          game:Object.assign({ rev:1 }, lobbyGame(null))
        }, A.roomFields ? A.roomFields() : {});
        return roomRef.update(payload);
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
        A.readRoom && A.readRoom(r);      // 先把房主的設定套上,免得大廳閃一下預設值
        claimSeat(okSeat=>{
          if(!okSeat){ setMsg("這個房間已經滿了,請選別間。"); roomRef=null; code=null; return; }
          enterLobby();
        });
      }).catch(e=>setMsg("加入失敗:"+e.message));
    }
    /* 入座:用 players 節點的 transaction 搶位 —— 必須擋住超額的人
       (多人同時點加入的競態,用 once+set 是擋不住的)。重連時同一個 meId 直接沿用原位。 */
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
      $("primaryBar").classList.remove("hidden");
      $("mpReadyBtn").classList.remove("hidden");
      $("mpRoomTitle").textContent=roomName||("房間 "+code);
      A.enterLobby && A.enterLobby();
      syncSubrow(); syncSetup(); updateReadyBtn(); updateGoal();
      listen(); watchConn();
    }
    // 回大廳續玩(本局結束 / 作廢):只重設本地,不動別人
    function backToLobby(){
      ready=false; curPhase="lobby"; order=[]; winner=null;
      outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false;
      clearAloneCheck(); closeWin();
      $("scrollArea").classList.remove("hidden");
      $("primaryBar").classList.remove("hidden");
      $("mpReadyBtn").classList.remove("hidden");
      A.backToLobby && A.backToLobby();
      syncSubrow(); syncSetup(); updateReadyBtn(); updateGoal(); setActionHint("");
    }
    /* ---------- 相位:對戰中 ---------- */
    function enterPlaying(){
      curPhase="playing";
      outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false;
      closeWin();
      $("scrollArea").classList.add("hidden");
      // 對戰中整條動作列收起來:準備鈕用不到,留著只是白吃一列高度
      $("primaryBar").classList.add("hidden");
      $("mpReadyBtn").classList.add("hidden");
      syncSubrow(); setActionHint("");
      A.enterPlaying && A.enterPlaying();
      updateGoal();
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
        if(curPhase==="lobby") syncSetup();
        else if(curPhase==="playing"){ A.refresh && A.refresh(); if(winner) showOutcome(); }
      });
      // 一局揮發狀態:單一 game 節點、單一監聽(見檔頭 #3)
      roomRef.child("game").on("value",s=>onGame(s.val()));
      // 房間層級設定(房主可改、全員監聽):欄位由 adapter 宣告,值也由 adapter 保管
      Object.keys(A.roomFields ? A.roomFields() : {}).forEach(k=>{
        roomRef.child(k).on("value",s=>{ A.onRoomField && A.onRoomField(k,s.val()); });
      });
      roomRef.child("scoreMode").on("value",s=>{ scoreMode=(s.val()==="match")?"match":"rank"; syncSetup(); renderPlayers(); });
      roomRef.child("winGoal").on("value",s=>{ const v=s.val(); winGoal=(typeof v==="number"&&v>=2)?Math.min(20,v):3; syncSetup(); });
      // 分數:獨立節點,刻意不掛 onDisconnect(見檔頭 #2)
      roomRef.child("scores").on("value",s=>{
        scores=s.val()||{};
        if(curPhase==="lobby") syncSetup();
        renderPlayers();
        if(winner) renderScoreboard();
      });
      emotesReady=false;
      roomRef.child("emotes").on("child_added",s=>{ if(emotesReady)handleEmote(s.val()); });
      roomRef.child("emotes").once("value",()=>{ emotesReady=true; });
      // adapter 自己要掛的額外監聽(例如數獨競速模式的 progress 節點);
      // 對應的節點名要列在 A.extraNodes,leave() 才收得乾淨
      A.listen && A.listen();
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
      order=g.order||[]; roundId=g.roundId||null;
      const nextWinner=g.winner||null, nextStatus=g.status||"lobby";
      const hadWinner=!!winner;
      winner=nextWinner; status=nextStatus;
      const statusChanged=(nextStatus!==curPhase);

      // 相位派發(★ 新局的本地狀態要在 enterPlaying 之前清掉,否則會拿上一局的殘留去畫)
      if(status==="playing"){ if(curPhase!=="playing"){ A.resetRound && A.resetRound(); enterPlaying(); } }
      else { if(curPhase!=="lobby" && !winner) backToLobby(); }

      // 遊戲狀態同步:交給 adapter(五子棋的 moves / 數獨的 fills 與進度)
      A.applyGame && A.applyGame(g, curPhase==="playing");

      if(winner){ onWinner(); }
      else if(hadWinner) closeWin();
      if(statusChanged && isHost) updateRoomIndex();
      if(curPhase==="lobby") updateStartBtn();
    }
    function onStatusTxt(t){ const el=$("mpStatusTxt"); if(el){ el.classList.remove("wait"); el.textContent=t; } }

    /* ---------- 開打 ---------- */
    function updateStartBtn(){
      if(!isHost)return;
      const ids=Object.keys(players);
      const allReady=ids.length>=MIN_PLAYERS && ids.every(id=>players[id].ready);
      if(status!=="lobby" || !allReady){ autoStarting=false; return; }
      if(!autoStarting){ autoStarting=true; startGame(); }   // 全員準備好 → 房主端自動開打
    }
    function startGame(){
      if(!isHost)return;
      const ids=Object.keys(players);
      if(ids.length<MIN_PLAYERS || !ids.every(id=>players[id].ready)){ showToast("需要 "+MIN_PLAYERS+" 人並且都準備好"); return; }
      // 上一局的順序(adapter 可據此決定要輪替還是重抽)
      const prev=(order.length===ids.length && order.every(id=>players[id])) ? order.slice() : null;
      const g=A.newGame(ids, prev);
      if(!g) return;                                      // adapter 判定不能開打(例如題目產生失敗)
      const pups={}; ids.forEach(id=>{ pups["players/"+id+"/ready"]=false; });
      roomRef.update(pups);
      setGame(Object.assign({ status:"playing", winner:null, roundId:Date.now() }, g));
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
      const hint = A.readyHint ? A.readyHint(ids,ready) : null;
      setActionHint(hint!=null ? hint
        : (ids.length<MIN_PLAYERS ? "等其他人加入…(房間可分享給朋友)"
                                  : (ready ? "等其他人按準備…" : "按「準備好了」就開始")));
    }

    /* ---------- 認輸(adapter 宣告 hasResign 才啟用) ---------- */
    let resignAsked=false;
    function askResign(){
      if(!A.hasResign)return;
      if(curPhase!=="playing"||winner||abandoned){ showToast("現在不能認輸"); return; }
      resignAsked=true; $("resignVeil").classList.add("show");
    }
    function closeResign(){ resignAsked=false; const v=$("resignVeil"); if(v)v.classList.remove("show"); }
    function confirmResign(){
      closeResign();
      if(curPhase!=="playing"||winner)return;
      const foe=order.find(id=>id!==meId) || Object.keys(players).find(id=>id!==meId);
      if(!foe){ showToast("找不到對手"); return; }
      txGame(g=>{ if(g.winner)return false; g.winner={ id:foe, name:dispName(foe), by:"resign" }; });
    }

    /* ---------- 結果 / 計分 ---------- */
    function onWinner(){ if(winner) showOutcome(); }
    /* 這一局有誰得分。三種寫法都支援:
       • winner.ids  → 並列名單(數獨 3~6 人同分時只有並列者得分)
       • winner.id   → 單一贏家
       • 兩者皆無    → 全員(五子棋的和局:雙方各 +1) */
    function winnerIds(){
      if(!winner) return [];
      if(Array.isArray(winner.ids)) return winner.ids;
      if(winner.id) return [winner.id];
      return Object.keys(players);
    }
    function showOutcome(){
      if(!winner)return;
      const isDraw=winner.by==="draw";
      const wids=winnerIds();
      const iWon=!isDraw && wids.indexOf(meId)>=0;
      myRoundWin=wids.indexOf(meId)>=0;

      // 計分:贏家(和局全員)幫自己 +1,一局只計一次(roundId 冪等 + 交易內再驗一次)
      if(myRoundWin && meId && roomRef && roundId && !scoredThisRound && scoredRoundOf(meId)!==roundId){
        scoredThisRound=true;
        roomRef.child("scores/"+meId).transaction(s=>{
          if(s && s.round===roundId) return;
          return { n:((s&&s.n)||0)+1, round:roundId };
        },()=>{ if(winner) renderScoreboard(); });
      }

      // 大字只講「對我而言」的輸贏,卡片再依結果換色(原本輸贏共用同一組金色漸層,輸了也一樣喜氣)
      // 平手但自己不在並列名單裡(3~6 人才會發生)→ 卡片仍走 lose,不要給喜氣的配色
      const card=$(A.winCardId||"gmkWinCard");
      if(card){ card.classList.remove("win","lose","draw"); card.classList.add(isDraw?(myRoundWin?"draw":"lose"):(iWon?"win":"lose")); }

      const o=(A.outcome && A.outcome(winner,{ iWon, isDraw, mine:myRoundWin, ids:wids, first:!outcomeShown })) || {};
      $("winWord").textContent=o.word || (isDraw?"平手!":(iWon?"你贏了!":"你輸了"));
      $("winMsg").textContent=o.msg || "";
      if(!outcomeShown){
        if(iWon){ Sound.win(); burst(); }
        else if(myRoundWin) Sound.win();     // 平手且自己有份:有聲音但不放彩帶
        else Sound.lose();
      }
      renderScoreboard();
      showResult();
      outcomeShown=true;
      // 本局結束就把自己設為未準備(下一局要各自重新按準備)
      if(meId && roomRef) { ready=false; roomRef.child("players/"+meId).update({ ready:false }); }
      A.refresh && A.refresh();
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
        const gained=winnerIds();
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

    /* ---------- 玩家名單 ---------- */
    function renderPlayers(){
      const box=$("mpPlayers"); if(!box)return; box.innerHTML="";
      box.classList.add("oneline");
      const ids=Object.keys(players);
      if(pendingKickId && (status!=="lobby" || !players[pendingKickId])) closeKick();
      const turn=A.turnId ? A.turnId() : null;
      ids.forEach(id=>{
        const p=players[id]||{};
        const isTurn=curPhase==="playing" && !winner && turn===id;
        const chip=document.createElement("div");
        chip.className="mp-chip clickable"+(p.ready?" ready":"")+(id===meId?" me":"")+(isTurn?" turn":"");
        chip.dataset.id=id;
        chip.title=id===meId?"點一下傳送互動表情給全部人":"點一下傳送互動表情";
        chip.addEventListener("click",()=>openEmote(id===meId?"all":id));
        // 晶片前綴:遊戲專屬(五子棋是黑/白棋徽章、數獨是玩家色點);大廳一律用準備狀態圓點
        const lead=(curPhase==="playing" && A.chipLead) ? A.chipLead(id) : null;
        const side=lead!=null ? lead : '<span class="dot"></span>';
        const sc=scoreOf(id);
        const scoreBadge=sc>0?'<span class="score-badge" title="累積勝場">🏆'+sc+'</span>':'';
        const extra=(curPhase==="playing" && A.chipTail) ? (A.chipTail(id)||"") : "";
        chip.innerHTML=side+'<span class="gmk-nm">'+esc(dispName(id))+'</span>'+youTag(id)+extra+scoreBadge;
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
      else onStatusTxt(A.lobbyStatusText ? A.lobbyStatusText(ids)
                       : (ids.length<MIN_PLAYERS?"等待其他人加入…":"等待大家準備…"));
      syncSubrow(); updateGoal();
    }
    // 狀態列的顯示與否:大廳一定要(在等什麼只有這裡說);對戰中收起來把高度讓給盤面——
    // 唯一例外是落單倒數(盤面上看不到,得放出來)
    function syncSubrow(){
      const el=$("mpSubrow"); if(!el)return;
      el.classList.toggle("hidden", curPhase==="playing" && !aloneTick);
    }
    function updateGoal(){ A.updateGoal && A.updateGoal(); }

    /* ---------- 大廳設定列(房主可改,訪客唯讀) ---------- */
    function syncSetup(){
      if(!online)return;
      A.syncSetup && A.syncSetup();
      // 計分列(所有遊戲共用同一組 DOM 與鎖定邏輯)
      const seg=$("scoreSeg"); if(!seg)return;
      seg.classList.toggle("readonly",!isHost);
      const scL=$("scoreLabel"); if(scL) scL.textContent=isHost?"連線計分":"連線計分(房主決定)";
      [...seg.children].forEach(b=>b.classList.toggle("on",b.dataset.score===scoreMode));
      const extra=$("scoreExtra"); if(extra) extra.classList.toggle("hidden",!(isHost||scoreMode==="match"));
      const locked=seasonInProgress();
      const wg=$("wgGroup"); if(wg){ wg.classList.toggle("hidden",scoreMode!=="match"); wg.classList.toggle("locked",locked); }
      const wv=$("winGoalVal"); if(wv) wv.textContent=winGoal;
      ["wgMinus","wgPlus"].forEach(id=>{ const b=$(id); if(b){ b.style.display=isHost?"":"none"; b.disabled=locked; } });
      const wh=$("wgLockHint"); if(wh) wh.classList.toggle("hidden",!(locked&&isHost));
      const rb=$("resetScoreBtn"); if(rb) rb.style.display=isHost?"":"none";
    }
    function seasonInProgress(){ return scoreMode==="match" && Object.keys(players).some(id=>scoreOf(id)>0); }
    function setScoreMode(m){
      if(!isHost||!roomRef)return;
      scoreMode=(m==="match")?"match":"rank"; roomRef.child("scoreMode").set(scoreMode); syncSetup(); savePrefs();
    }
    function setWinGoal(v){
      if(!isHost||!roomRef||seasonInProgress())return;
      winGoal=Math.max(2,Math.min(20,v|0)); roomRef.child("winGoal").set(winGoal); syncSetup(); savePrefs();
    }
    function resetScores(){
      if(!isHost||!roomRef)return;
      const ups={}; Object.keys(players).forEach(id=>{ ups["scores/"+id]=null; });
      scoredThisRound=false;
      if(Object.keys(ups).length) roomRef.update(ups);
      showToast("已重設戰績 🏆");
    }
    // 房主改房間層級設定的共同守門(盤面大小、難度、模式…都走這支)
    function setRoomField(key,val,opts){
      opts=opts||{};
      if(!isHost||!roomRef){ showToast(opts.denyMsg||"只有房主能改這個設定"); return false; }
      if(opts.lobbyOnly && status!=="lobby"){ showToast(opts.busyMsg||"對戰中不能改這個設定"); return false; }
      roomRef.child(key).set(val);
      return true;
    }
    // 房主改了設定 → 已按準備的訪客要退回未準備(免得在不知情下用新設定開打)
    function unreadyOnFieldChange(){
      if(!isHost && ready && roomRef && meId){
        ready=false; roomRef.child("players/"+meId).update({ready:false}); updateReadyBtn();
      }
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
      // 重新入座:斷線期間位置可能被別人佔走 → 用同一個 transaction,搶不回就只能退出
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
      syncSubrow();   // 對戰中平常收起狀態列,倒數這種盤面上看不到的訊息要放出來
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
      setGame(lobbyGame(order.length?order:null));
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
        ? (inGame?"你是房主,離開會<b>直接關閉房間</b>,這局大家都玩不完。"
                :"你是房主,離開會<b>關閉整個房間</b>,其他人也會被退出。")
        : (inGame?"這局還沒結束,離開就<b>不算你的成績</b>。"
                :"確定要離開這個房間嗎?");
      if(b)b.textContent=inGame?"還是要離開":"離開房間";
      $("leaveVeil").classList.add("show");
    }
    function closeLeaveAsk(){ pendingLeaveAct=null; $("leaveVeil").classList.remove("show"); }
    function confirmLeave(){ const act=pendingLeaveAct; closeLeaveAsk(); if(act)act(); }
    function leave(){
      try{
        if(roomRef){
          ["host","players","game","scoreMode","winGoal","scores","emotes"]
            .concat(Object.keys(A.roomFields ? A.roomFields() : {}))
            .concat(A.extraNodes || [])
            .forEach(k=>roomRef.child(k).off());
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
      players={}; scores={}; order=[]; winner=null; status="lobby"; curPhase="lobby";
      sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
      gameRev=0; lastIndexSig=null; outcomeShown=false; abandoned=false;
      scoredThisRound=false; myRoundWin=false; autoStarting=false; emotesReady=false;
      closeLeaveAsk(); closeKick(); closeResign(); closeEmote(); closeWin();
      document.body.classList.remove("mp-on"); resetQuickVoiceBtn();
      A.onLeave && A.onLeave();
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

    /* ---------- 交給 adapter 的執行環境 ---------- */
    const ctx = {
      me:()=>meId, name:()=>meName, players:()=>players, order:()=>order,
      isHost:()=>isHost, phase:()=>curPhase, status:()=>status,
      winner:()=>winner, roundId:()=>roundId, abandoned:()=>abandoned,
      dispName, youTag, scoreOf,
      setGame, patchGame, txGame, setRoomField, unreadyOnFieldChange,
      renderPlayers, syncSetup, updateReadyBtn, updateGoal, onStatusTxt,
      maxPlayers:MAX_PLAYERS, minPlayers:MIN_PLAYERS,
      // adapter 自己要讀寫的房內節點(見 A.listen / A.extraNodes);沒進房時回 null
      ref:(path)=>roomRef?roomRef.child(path):null
    };
    A.init && A.init(ctx);

    /* ---------- 對外 API(通用部分 + adapter 自己的) ---------- */
    const api = {
      available, openConnect, scanRooms, create, join, leave,
      toggleReady, again,
      isOnline:()=>online, amHost:()=>isHost, amReady:()=>ready,
      setScoreMode, setWinGoal, resetScores,
      winGoal:()=>winGoal, scoreMode:()=>scoreMode,
      askResign, confirmResign, cancelResign:closeResign,
      askLeave, confirmLeave, cancelLeave:closeLeaveAsk,
      confirmKick, cancelKick:closeKick,
      roster, sendEmote,
      prefsKey:()=>A.prefsKey,
      emoteAnchor:()=>A.emoteAnchor,
      ownPrefs:()=>Object.assign({ scoreMode:scoreMode, winGoal:winGoal }, (A.ownPrefs&&A.ownPrefs())||{}),
      usePrefs(o){
        o=o||{};
        if(o.scoreMode==="match"||o.scoreMode==="rank") scoreMode=o.scoreMode;
        if(typeof o.winGoal==="number"&&o.winGoal>=2) winGoal=Math.min(20,o.winGoal);
        A.usePrefs && A.usePrefs(o);
      }
    };
    return Object.assign(api, A.api||{});
  }

  return { create };
})();

/* ============================================================================
   ADAPTER 介面速查(各遊戲的 js/<game>/adapter.js 實作)

   必要:
     ns:{rooms,index}   Firebase 頂層節點名(各遊戲必須分開)
     prefsKey           遊戲專屬偏好的 localStorage key
     emoteAnchor        表情飛出的錨點元素 id
     newGame(ids,prev)  房主開局 → 回傳 game 物件(不含 status/winner/roundId,核心會補)
     applyGame(g,playing) 收到新 rev 的 game 快照 → 套用到畫面

   可選:
     minPlayers/maxPlayers(預設 2/2)、hasResign、winCardId
     init(ctx)          接住核心給的執行環境(見上方 ctx)
     api:{...}          要額外暴露給 main.js 的方法(tap / setBoardSize / …)
     roomFields()       房間層級設定欄位的預設值 {key:val};核心負責建房寫入與監聽
     onRoomField(k,v)   某個房間設定變了(adapter 自己存值、自己決定要不要重畫)
     readRoom(r)        加入房間時先讀一次房間快照(避免大廳閃預設值)
     lobbyGame()        大廳狀態下 game 節點的遊戲專屬欄位(如 {moves:[]})
     resetRound()       新局開打前清掉本地遊戲狀態
     openConnect()/enterLobby()/backToLobby()/enterPlaying()/onLeave()  各相位的專屬 DOM
     syncSetup()        大廳設定面板的專屬部分
     updateGoal()       房間框那顆徽章
     turnId()           目前輪到誰(沒有回合制就別實作)
     chipLead(id)/chipTail(id)  玩家晶片的前綴 / 後綴 HTML
     lobbyStatusText(ids)/readyHint(ids,ready)  狀態列與準備列文案
     outcome(winner,{iWon,isDraw,first})  → {word,msg};順便做自己的結果收尾
     refresh()          畫面重整鉤子(玩家名單變動 / 結果出爐時被呼叫)
     ownPrefs()/usePrefs(o)  遊戲專屬偏好
   ========================================================================== */

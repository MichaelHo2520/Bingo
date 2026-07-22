"use strict";

  /* ---------- Multiplayer (Firebase) ---------- */
  const MP=(function(){
    let db=null, roomRef=null, code=null, meId=null, meName="玩家", isHost=false;
    let roomName="";                             // 房主設定的房間名稱(對外顯示用;內部仍以 code 當資料庫鍵值)
    let roomsWatchRef=null, lastRoomsSig=null;   // 大廳常駐監聽:即時反映房間開/關,免得一直按🔍
    let players={}, calledList=[], status="lobby", winner=null, ready=false;
    let autoStarting=false;   // 全部人準備好 → 房主端自動開打的一次性守衛(避免 status 尚未同步前重複觸發)
    let prevIds=null;   // 上一次的玩家 id 清單,用來偵測「有新玩家加入」放音效(null=進房後尚未收到第一次快照)
    let orderMethod="rps", order=[], turnIndex=0, rps=null, curPhase="lobby", orderDraft=[];
    // 連線計分:scoreMode="rank"(累積勝場排行,無止盡)|"match"(搶 N 勝,達標跳總冠軍);winGoal=目標勝場(match 用)
    // roundId=每局開打時房主寫的識別碼(給「一局只計一次分」用);scoredThisRound=本端這局是否已幫自己加過分(本地去重)
    let scoreMode="rank", winGoal=3, roundId=null, scoredThisRound=false, scores={};   // scores 獨立於在線節點,斷線不刪
    let myRoundWin=false;                   // 我這局是不是贏家(含平手):結果卡排行先樂觀 +1,免得加分交易回寫前顯示還是 0 勝
    let sawPlayers=false;
    let sawMe=false;                        // 是否曾在名單看過自己(避免剛加入的空讀誤判成被踢)
    let hostId=null, sawHost=false;         // 房主 id / 是否曾看過有效房主(避免剛加入時誤判)
    let myWinAt=null, outcomeShown=false;   // 平手判定用:自己達標時的叫號數 / 結果是否已揭曉
    let abandoned=false;                    // 開打後對手都離開、只剩自己 → 本局作廢,不再繼續
    let orderAnnounced=false;               // 本局是否已公告過出手順序(猜拳結果)
    let revealData=null, revealTimer=null;  // 猜拳過場:大家出的拳 / 房主用的「揭曉後自動開打」計時器
    let tieTimer=null, tieSig="";           // 平手揭曉:房主用的「停留後自動重猜」計時器 / 避免重繪重播動畫
    let emotesReady=false;                   // 好友互動:是否已略過歷史 emotes(避免重播舊表情)
    let connRef=null, connected=null;        // .info/connected 監聽 / 目前連線狀態(null=未知,尚未回報)
    let resyncing=false, resyncTimer=null;   // 剛從背景/斷線恢復的寬限旗標與計時器(期間不把舊名單快照當成被踢)
    let graceTimer=null;                     // 「暫時有人不見」的寬限計時器:逾時仍不見才真的離開/回大廳
    const GRACE_MS=20000;                    // 斷線寬限期(手機切 App 常見情境):20 秒內回來就當沒事
    const RPS_EMO={R:"✊",S:"✌️",P:"✋"}, RPS_TXT={R:"石頭",S:"剪刀",P:"布"};

    // 是否已備妥連線(SDK 已載入 + config 有填);config 未填時視為關閉連線功能
    function available(){
      return !!(window.firebase && configReady());
    }
    function configReady(){ return !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf("PASTE")<0); }
    // 動態載入 Firebase SDK(只在使用者點「連線對戰」時才載,首頁不必等它)。載入過就直接沿用。
    let fbLoading=null;
    function ensureFirebase(){
      if(window.firebase) return Promise.resolve(true);
      if(fbLoading) return fbLoading;
      const base="https://www.gstatic.com/firebasejs/10.12.2/";
      const load=src=>new Promise((res,rej)=>{
        const s=document.createElement("script"); s.src=src; s.async=false;   // async=false:保證 app 先於 database 執行
        s.onload=()=>res(); s.onerror=()=>rej(new Error("load "+src));
        document.head.appendChild(s);
      });
      fbLoading = load(base+"firebase-app-compat.js")
        .then(()=>load(base+"firebase-database-compat.js"))
        .then(()=>!!window.firebase)
        .catch(e=>{ fbLoading=null; throw e; });   // 失敗清掉,允許之後重試
      return fbLoading;
    }
    function init(){
      if(db)return true;
      if(!available())return false;
      try{
        if(!firebase.apps.length)firebase.initializeApp(FIREBASE_CONFIG);
        db=firebase.database(); return true;
      }catch(e){ console.error(e); return false; }
    }
    function randomCode(){
      let s=""; for(let i=0;i<4;i++)s+=Math.floor(Math.random()*10);
      return s;
    }
    function pid(){
      let id; try{id=localStorage.getItem("bingo.pid");}catch(e){}
      if(!id){ id="p"+Math.random().toString(36).slice(2,9); try{localStorage.setItem("bingo.pid",id);}catch(e){} }
      return id;
    }
    function setMsg(t){ $("mpConnMsg").textContent=t||""; }
    function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
    // 顯示用名稱:沒填或重複的名字會加編號區分(玩家1、玩家2、KK1、KK2…);各端 players 的 key 序一致故結果一致
    function dispName(id){
      const raw=(players[id]&&players[id].name)||"玩家";
      const same=Object.keys(players).filter(x=>((players[x]&&players[x].name)||"玩家")===raw);
      return same.length<=1 ? raw : raw+(same.indexOf(id)+1);
    }
    // 高反差「你」徽章:讓自己在名單/猜拳/揭曉裡一眼認出來(取代不明顯的「(你)」小字)
    function youTag(id){ return id===meId ? '<span class="you-badge">你</span>' : ''; }

    function openConnect(){
      document.body.classList.remove("at-home");     // 進連線畫面 → 恢復頂列跑馬燈
      $("home").classList.add("hidden");
      $("boardWrap").classList.add("hidden");
      $("setup").classList.add("hidden");
      $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 選房間畫面不顯示房間分頁列
      $("mpConnect").classList.remove("hidden");
      $("mpRoomList").innerHTML="";
      if(!configReady()){ setMsg("⚠ 尚未設定 Firebase。請依說明建立免費專案並把設定貼進檔案,連線才會啟用。"); setLive("none","連線未啟用"); return; }
      setMsg("連線載入中…"); setLive("loading","連線載入中…");
      ensureFirebase().then(()=>{
        setMsg("點下方房間即可直接加入");
        startRoomWatch();                             // init() 由此觸發;此時 Firebase SDK 已就緒。持續偵測房間,不必一直按🔍
      }).catch(()=>{
        setMsg("⚠ 連線元件載入失敗,請檢查網路後再試。"); setLive("error","載入失敗");
      });
    }
    // 頂部即時狀態膠囊:讓人一眼看出現在有沒有人開房(loading/open/busy/none/error)
    function setLive(stateName,text){
      const el=$("mpLive"); if(!el)return;
      el.setAttribute("data-state",stateName);
      $("mpLiveTxt").textContent=text;
    }
    // 把 rooms 快照整理成清單(有人在裡面的房間,依房號排序)
    function roomItems(rooms){
      return Object.keys(rooms).map(c=>{
        const r=rooms[c]||{};
        const ps=r.players||{};
        const hostName=(r.host&&ps[r.host]&&ps[r.host].name)||"";   // 房主名稱(取房主 id 對應的玩家名)
        return { code:c, status:r.status||"lobby", count:Object.keys(ps).length, host:hostName, name:(r.roomName||"") };
      }).filter(r=>r.count>0).sort((a,b)=>a.code.localeCompare(b.code));
    }
    // 依整理後的清單更新房間列表與狀態膠囊(內容沒變就不重繪,避免遊戲中叫號一直觸發、干擾點擊)
    function applyRooms(items){
      const sig=items.map(r=>r.code+":"+r.status+":"+r.count+":"+r.host+":"+r.name).join("|");
      if(sig===lastRoomsSig)return;
      lastRoomsSig=sig;
      renderRoomList(items);
      const lobby=items.filter(r=>r.status==="lobby").length;
      if(!items.length) setLive("none","目前沒有人開房間,開一間吧！");
      else if(lobby>0) setLive("open","現在有 "+lobby+" 間房間開放中"+(items.length>lobby?" · 另 "+(items.length-lobby)+" 間對戰中":""));
      else setLive("busy",items.length+" 間對戰進行中(暫時無法加入)");
    }
    // 掛上常駐監聽:房間開/關會即時反映;離開大廳(closeConnect/enterLobby)時 stopRoomWatch 卸載
    function startRoomWatch(){
      if(!init()){ setLive("none","連線未啟用"); return; }
      stopRoomWatch();
      lastRoomsSig=null; setLive("loading","偵測目前房間中…");
      roomsWatchRef=db.ref("rooms");
      roomsWatchRef.on("value", s=>applyRooms(roomItems(s.val()||{})), err=>{
        stopRoomWatch(); setLive("error","無法讀取房間清單");
        $("mpRoomList").innerHTML='<div class="room-empty">偵測失敗:'+esc(err.message)+'(可能是資料庫規則不允許列出房間,見說明)</div>';
      });
    }
    function stopRoomWatch(){ if(roomsWatchRef){ roomsWatchRef.off(); roomsWatchRef=null; } }
    // 🔍 手動重新偵測(重掛監聽,強制刷新一次)
    function scanRooms(){
      if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
      startRoomWatch();
    }
    function renderRoomList(items){
      const box=$("mpRoomList"); if(!box)return; box.innerHTML="";
      const openRooms=items.filter(r=>r.status==="lobby");
      const busyRooms=items.filter(r=>r.status!=="lobby");
      // 分區塊:先「可加入」(綠色、可點、帶加入鈕),再「對戰中」(灰階、不可點);哪塊沒房間就不畫該塊
      if(openRooms.length) box.appendChild(buildRoomGroup(true, openRooms));
      if(busyRooms.length) box.appendChild(buildRoomGroup(false, busyRooms));
    }
    function buildRoomGroup(joinable, rooms){
      const g=document.createElement("div");
      g.className="room-group"+(joinable?" joinable":"");
      const title=joinable ? "可以加入" : "對戰中(無法加入)";
      const head=document.createElement("div");
      head.className="room-group-title";
      head.innerHTML='<span class="gt-dot" aria-hidden="true"></span>'+title+' · '+rooms.length+' 間';
      g.appendChild(head);
      rooms.forEach(r=>{
        const it=document.createElement("button");
        it.type="button"; it.className="room-item"+(joinable?" joinable":" busy"); it.disabled=!joinable;
        const hostTag=r.host?'<span class="host">👑 '+esc(r.host)+'</span> · ':'';
        const nm=r.name||("房間 "+r.code);   // 舊房間沒房名時,退回用號碼當名字
        const cta=joinable ? '<span class="join-cta">加入 ▸</span>'
                           : '<span class="busy-tag">🔒 遊戲中</span>';
        it.innerHTML='<span class="room-main"><span class="rn">🏠 '+esc(nm)+'</span>'+
          '<span class="meta">'+hostTag+'👥 '+r.count+' 人</span></span>'+cta;
        if(joinable) it.addEventListener("click",()=>join(r.code,$("mpName").value,r.name));
        g.appendChild(it);
      });
      return g;
    }
    function closeConnect(){
      stopRoomWatch();
      $("mpConnect").classList.add("hidden");
      enterHome();   // 連線畫面返回 → 回主選單(不再直接掉到單機設定)
    }

    // 沒填暱稱:紅框抖動 + 聚焦 + 提示,擋住建房/加入,讓人一定注意到
    function flagNameNeeded(){
      const el=$("mpName");
      if(el){ el.classList.remove("needs-name"); void el.offsetWidth; el.classList.add("needs-name"); try{ el.focus(); }catch(e){} el.scrollIntoView&&el.scrollIntoView({block:"center"}); }
      showToast("請先輸入你的暱稱 🙂", 2200);
    }
    function create(name,wantName){
      if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
      const nm=(name||"").trim();
      if(!nm){ flagNameNeeded(); return; }   // 必填暱稱
      meName=nm.slice(0,8); meId=pid(); isHost=true;
      roomName=(wantName||"").trim().slice(0,12) || (meName+"的房間");   // 房名可留空,預設用暱稱
      code=randomCode(); roomRef=db.ref("rooms/"+code);                  // 內部隨機 4 位碼當資料庫鍵值(玩家看不到)
      roomRef.child("host").once("value").then(snap=>{
        if(snap.exists()){ code=randomCode(); roomRef=db.ref("rooms/"+code); }   // 撞號就重抽一次
        return roomRef.update({ host:meId, roomName:roomName, status:"lobby", target:state.target, size:SIZE, orderMethod:"rps",
          scoreMode:scoreMode, winGoal:winGoal, roundId:null,   // 用記住的計分偏好當建房預設
          calledList:[], winner:null, order:null, turnIndex:0, rps:null, emotes:null, createdAt:Date.now() });
      }).then(()=>{ joinNode(); enterLobby(); }).catch(e=>setMsg("建立房間失敗:"+((e&&e.message)||e)));
    }
    function join(inCode,name,inName){
      if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
      const nm=(name||"").trim();
      if(!nm){ flagNameNeeded(); return; }   // 必填暱稱(才知道你是誰)
      const c=(inCode||"").replace(/\D/g,"").trim();
      if(c.length<4){ setMsg("請從下方清單選擇房間加入。"); return; }
      meName=nm.slice(0,8); meId=pid(); isHost=false; code=c; roomName=inName||""; roomRef=db.ref("rooms/"+code);
      roomRef.once("value").then(snap=>{
        const r=snap.val();
        if(!r||!r.host){ setMsg("這個房間已經關閉了,請重新選擇。"); return; }
        roomName=inName||r.roomName||("房間 "+code);   // 以房主設定的房名為準
        joinNode(); enterLobby();
      }).catch(e=>setMsg("加入失敗:"+e.message));
    }
    function joinNode(){
      armPresence({ name:meName, lines:0, ready:false });
      // 註:不再於房主斷線時「整房刪除」——短暫切背景改由寬限期+重連歸位處理(見 watchConn/resume);
      //     房主真的離開時 leave() 會 roomRef.remove() 關房,orphan 房間無玩家也會被大廳清單過濾掉。
    }

    function hidePhasePanels(){
      hideMpVeil();
      $("mpOrderPanel").classList.add("hidden");
      $("mpControls").classList.add("hidden");
    }
    // 猜拳/揭曉蓋板(像結束畫面那樣彈出);which = "rps" | "reveal"
    function showMpVeil(which){
      $("rpsContent").classList.toggle("hidden", which!=="rps");
      $("revealContent").classList.toggle("hidden", which!=="reveal");
      const lv=$("mpVeilLeave"); if(lv) lv.textContent = isHost ? "取消猜拳,回大廳" : "離開房間";
      $("mpVeil").classList.add("show");
    }
    function hideMpVeil(){ $("mpVeil").classList.remove("show"); }
    // 猜拳卡住時的逃生:房主→取消回大廳(保留房間,大家可重來);訪客→離開房間回單機
    function bailFromRps(){ if(isHost) resetRoomToLobby(); else leave(); }
    function enterLobby(){
      state.online=true; ready=false; curPhase="lobby"; sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
      document.body.classList.add("mp-on"); resetQuickVoiceBtn();   // 連線中:顯示快速語音浮動鈕
      stopRoomWatch();                                  // 已進房,卸載大廳的房間偵測監聽
      $("home").classList.add("hidden");
      $("boardWrap").classList.remove("hidden");        // 進大廳要看得到棋盤(填卡)
      $("soloHead").classList.add("hidden");            // 大廳不顯示單機的返回列(用房間橫幅的離開)
      $("mpConnect").classList.add("hidden");
      $("setup").classList.remove("hidden");
      $("setupActions").classList.remove("hidden");
      $("mpBar").classList.remove("hidden");
      $("mpRoomTitle").textContent=roomName||("房間 "+code);   // 橫幅只顯示房名(不再帶內部號碼,避免手機上被截斷)
      $("startBtn").classList.add("hidden");
      $("onlineBtn").classList.add("hidden");
      $("mpReadyBtn").classList.remove("hidden");
      $("mpStartBtn").classList.add("hidden");
      hidePhasePanels();
      $("targetRow").style.display=isHost?"":"none";
      $("sizeRow").style.display=isHost?"":"none";       // 只有房主能改盤面大小
      syncOrderRow();                                     // 出手順序:大家都看得到目前選擇(訪客唯讀)
      syncScoreRow();                                     // 連線計分:同上,大家都看得到(訪客唯讀)
      state.fill="auto"; state.card=shuffled(); state.mode="setup";
      updateRoomTabs(true, isHost?"settings":"fill");   // 房主先進「設定」配置房間;訪客直接進「填號」(設定多為唯讀)
      render(); applyFillUI(); updateReadyBtn();
      listen();
      watchConn();   // 開始監看連線狀態,支援斷線後自動歸位
    }
    // 訪客:確認過房主與玩家名單後,若房主(或整個房間)消失 → 自動退出連線
    function hostGone(){
      return !isHost && state.online && sawHost && sawPlayers && (!hostId || !players[hostId]);
    }
    // 訪客:曾在名單看過自己、如今自己被移除 → 被房主踢出,退回單機
    function iWasKicked(){
      return !isHost && state.online && sawMe && !players[meId];
    }
    // 目前是否「穩定在線」:真的連著、不在剛恢復的寬限期、且分頁在前景。
    // 用來分辨「被房主踢出」(穩定在線卻被移除 → 立即離開)與「自己切背景斷線」(交給寬限期+重連歸位)。
    function stableOnline(){ return connected===true && !resyncing && !document.hidden; }

    // ── 斷線復原(手機切到 LINE 等 App、分頁被凍結時 WebSocket 會斷,Firebase 依 onDisconnect 移除玩家節點)──
    // 方法一(重連自動歸位):監聽 .info/connected,一重新連上就把自己重新寫回並重掛 onDisconnect;
    //   回到前景(visibilitychange)也主動歸位一次(離線時寫入會排隊,連線恢復後送出)。
    // 方法二(寬限期):名單顯示「我/房主暫時不見」時不立刻離開,寬限 GRACE_MS;回來就取消,逾時仍不見才真的離開。
    function watchConn(){
      if(connRef||!db)return;
      connRef=db.ref(".info/connected");
      connRef.on("value",s=>{
        const now=!!s.val(), wasDown=(connected===false);
        connected=now;
        if(now && wasDown) resume("已重新連線");   // 斷線後重新連上 → 自動歸位並提示
      });
    }
    function stopConn(){ if(connRef){ connRef.off(); connRef=null; } connected=null; }
    // 重新寫回自己的玩家節點並重掛「斷線自動移除」;首次 join 與重連歸位共用(update 保留 winAt 等其它欄位)
    function armPresence(data){
      if(!roomRef||!meId)return;
      const r=roomRef.child("players/"+meId);
      r.update(data);
      r.onDisconnect().remove();
    }
    // 從背景/斷線恢復:進入寬限期並主動把自己寫回(msg 有值才提示,避免只是短暫切前景也跳訊息)
    function resume(msg){
      if(!state.online||!roomRef||!meId)return;
      resyncing=true;
      if(resyncTimer)clearTimeout(resyncTimer);
      resyncTimer=setTimeout(()=>{ resyncing=false; resyncTimer=null; recheckPresence(); }, GRACE_MS);
      const me=players[meId]||{};
      armPresence({ name:meName, lines:me.lines||0, ready:!!ready });   // 保留目前線數/準備狀態
      if(msg)showToast(msg,1500);
    }
    // 有人「暫時不見」時,排一個寬限期後的複查(已在排就不重排)
    function scheduleRecheck(){ if(!graceTimer)graceTimer=setTimeout(()=>{ graceTimer=null; recheckPresence(); }, GRACE_MS); }
    function clearRecheck(){ if(graceTimer){ clearTimeout(graceTimer); graceTimer=null; } }
    // 寬限期到期後再確認一次:該離開/回大廳的情況若仍成立,才真的動作
    function recheckPresence(){
      if(!state.online||!roomRef)return;
      if(iWasKicked() && connected){ showToast("你已被房主移出房間"); leave(); return; }
      if(hostGone()){ showToast("房主已離開,房間已關閉"); leave(); return; }
      if(isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1) hostAloneToLobby();
    }
    // 房主:點移除鈕先跳確認小卡(避免誤觸把人踢掉)
    let pendingKickId=null;
    function askKick(id){
      if(!isHost||!roomRef||id===meId)return;
      if(status!=="lobby"){ showToast("遊戲進行中無法移除玩家"); return; }
      pendingKickId=id;
      $("kickMsg").innerHTML="確定要把「"+esc(dispName(id))+"」移出房間嗎?";
      $("kickVeil").classList.add("show");
    }
    function closeKick(){ pendingKickId=null; $("kickVeil").classList.remove("show"); }
    function confirmKick(){ const id=pendingKickId; closeKick(); if(id)kick(id); }
    // 房主:把某位玩家移出房間(僅大廳階段,遊戲進行中不動出手順序)
    function kick(id){
      if(!isHost||!roomRef||id===meId)return;
      if(status!=="lobby"){ showToast("遊戲進行中無法移除玩家"); return; }
      const nm=dispName(id);
      roomRef.child("players/"+id).remove();
      roomRef.child("scores/"+id).remove();   // 連同分數一起清,避免殘留(踢人才清;斷線絕不清)
      showToast("已移出 "+nm);
    }
    function listen(){
      roomRef.child("host").on("value",s=>{
        hostId=s.val()||null; if(hostId)sawHost=true;
        if(hostGone()) scheduleRecheck();   // 房主暫時不見 → 進寬限期,期間房主重連歸位就恢復
      });
      roomRef.child("players").on("value",s=>{
        players=s.val()||{};
        // 有新玩家加入 → 放「加入」音效,讓房內原本的人都知道有人來了(略過自己、進房後的第一次快照,且只在大廳)
        { const ids=Object.keys(players);
          if(prevIds!==null && curPhase==="lobby" && ids.some(id=>id!==meId && prevIds.indexOf(id)<0)) Sound.join();
          prevIds=ids; }
        if(Object.keys(players).length) sawPlayers=true;
        if(players[meId]) sawMe=true;
        // 我一直穩定連著卻從名單消失 → 房主真的把我踢了,立即離開;其餘情況一律交給寬限期
        if(iWasKicked() && stableOnline()){ showToast("你已被房主移出房間"); leave(); return; }
        // 「暫時不見」(我/房主消失,或遊戲中房主只剩自己):寬限期內先不動作,等重連歸位;全部正常則解除寬限
        const alone=isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1;
        if(iWasKicked() || hostGone() || alone) scheduleRecheck(); else clearRecheck();
        renderPlayers(); updateStartBtn();
        if(curPhase==="lobby") syncScoreRow();   // 分數變動(重設戰績/開新賽季)→ 重新評估目標勝場鎖定狀態
        if(curPhase==="rps"){ renderRps(); if(isHost)rpsHostResolve(); }
        else if(curPhase==="ordering") renderOrderPanel();
        else if(curPhase==="playing"){
          // 輪到的人暫時不見:不在寬限期內才跳過他(避免卡住);寬限中先等他回來,不亂動出手順序
          if(isHost && order.length && !players[order[turnIndex]] && !graceTimer) roomRef.child("turnIndex").set(nextTurn(turnIndex));
          updateTurnUI();
          if(winner) showOutcome();   // 補算平手(對手的 winAt 可能晚一步才傳到)
        }
      });
      roomRef.child("status").on("value",s=>{ status=s.val()||"lobby"; onStatus(); });
      roomRef.child("target").on("value",s=>{ const t=s.val(); if(typeof t==="number"&&!isHost){ state.target=t; $("targetVal").textContent=t; const g=$("mpGoalNum"); if(g)g.textContent=t+" 線"; } });
      // 盤面大小:房主寫入,訪客跟著套用(重發卡片;若已準備先取消準備讓其重填)
      roomRef.child("size").on("value",s=>{
        const n=s.val();
        if(typeof n!=="number"||n<5||n>7||isHost||n===SIZE)return;
        if(ready){ ready=false; roomRef.child("players/"+meId).update({ready:false}); updateReadyBtn(); }
        setSize(n);
        if(curPhase==="playing"){ state.marked=Array(nCells()).fill(false); applyCalledMarks(); updateTurnUI(); refreshLines(); }
        else setLock(false);
        syncSizeSeg();
      });
      // 好友互動表情:略過歷史(once value 於初始 child_added 之後才觸發),之後才顯示新的
      emotesReady=false;
      roomRef.child("emotes").on("child_added",s=>{ if(emotesReady)handleEmote(s.val()); });
      roomRef.child("emotes").once("value",()=>{ emotesReady=true; });
      roomRef.child("orderMethod").on("value",s=>{ orderMethod=s.val()||"host"; syncOrderSeg(); });
      // 連線計分:模式 / 搶勝目標 / 每局識別碼
      roomRef.child("scoreMode").on("value",s=>{ scoreMode=(s.val()==="match")?"match":"rank"; syncScoreRow(); renderPlayers(); });
      roomRef.child("winGoal").on("value",s=>{ const n=s.val(); winGoal=(typeof n==="number"&&n>=2)?Math.min(20,n):3; syncScoreRow(); });
      roomRef.child("roundId").on("value",s=>{ roundId=s.val()||null; });
      // 連線計分:分數存獨立路徑 scores/<id>={n,round},不掛 onDisconnect,斷線/切背景都刪不到
      roomRef.child("scores").on("value",s=>{ scores=s.val()||{};
        if(curPhase==="lobby") syncScoreRow();   // 分數變動 → 重評「搶勝目標」鎖定
        renderPlayers();                          // 晶片上的 🏆N 徽章
        if(winner) renderScoreboard();            // 結果卡開著時同步排行
      });
      roomRef.child("order").on("value",s=>{ order=s.val()||[]; if(curPhase==="playing"){ render(); updateTurnUI(); renderPlayers(); } maybeAnnounceOrder(); });
      roomRef.child("turnIndex").on("value",s=>{ turnIndex=s.val()||0; if(curPhase==="playing"){ render(); updateTurnUI(); renderPlayers(); } });
      roomRef.child("rps").on("value",s=>{ rps=s.val(); if(curPhase==="rps")renderRps(); if(isHost)rpsHostResolve(); });
      roomRef.child("reveal").on("value",s=>{ revealData=s.val(); if(curPhase==="reveal")renderReveal(); });
      roomRef.child("calledList").on("value",s=>{ calledList=s.val()||[]; onCalled(); });
      roomRef.child("winner").on("value",s=>{ winner=s.val(); if(winner)onWinner(); else closeWin(); });
    }

    function renderPlayers(){
      const box=$("mpPlayers"); if(!box)return; box.innerHTML="";
      const ids=Object.keys(players);
      // 確認框開著時,若對象已離開或已不在大廳,直接收掉避免踢到空氣
      if(pendingKickId && (status!=="lobby" || !players[pendingKickId])) closeKick();
      ids.forEach(id=>{
        const p=players[id]||{};
        const isTurn=status==="playing"&&order.length>0&&order[turnIndex]===id;
        const chip=document.createElement("div");
        chip.className="mp-chip clickable"+(p.ready?" ready":"")+(id===meId?" me":"")+(isTurn?" turn":"");
        chip.dataset.id=id;                                  // 供表情動畫定位到該玩家晶片
        chip.title=id===meId?"點一下傳送互動表情給全部人":"點一下傳送互動表情";
        chip.addEventListener("click",()=>openEmote(id===meId?"all":id));   // 點對象 → 開表情面板
        const seatIdx=order.indexOf(id);
        const seatBadge=(status==="playing"&&seatIdx>=0)?'<span class="seat-badge">'+(seatIdx+1)+'</span>':'';
        const sc=scoreOf(id);
        const scoreBadge=sc>0?'<span class="score-badge" title="累積勝場">🏆'+sc+'</span>':'';   // 有累積勝場才顯示,大廳/遊戲中都看得到
        chip.innerHTML='<span class="dot"></span>'+seatBadge+'<span>'+esc(dispName(id))+'</span>'+youTag(id)+scoreBadge+
          (status==="playing"?'<span class="ln">'+(p.lines||0)+'線</span>':'')+
          '<span class="mp-poke" aria-hidden="true">😀</span>';   // 互動提示:暗示晶片可點送表情
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
      $("mpStatusTxt").textContent = status==="playing" ? "遊戲進行中" : (status==="rps"?"猜拳決定順序…":(status==="reveal"?"猜拳結果揭曉…":(status==="ordering"?"排定順序中…":(ids.length<2?"等待對手加入…":"等待大家準備…"))));
      mpHint();
    }
    // 主要動作列的引導提示:只在大廳,依「我準備了沒 / 大家好了沒 / 我是不是房主」給出下一步該做什麼
    // 連線大廳不再顯示「現在該做什麼」引導(填卡 → 按準備 → 全準備自動開打,流程已夠直覺)——一律清空
    function mpHint(){ setActionHint(""); }
    function updateReadyBtn(){
      const b=$("mpReadyBtn");
      b.textContent=ready?"取消準備":"準備好了";
      b.classList.toggle("ghost",ready); b.classList.toggle("primary",!ready);
      mpHint();
    }
    function setLock(lock){
      $("reshuffleBtn").disabled=lock;
      $("fillSeg").style.pointerEvents=lock?"none":"";
      grid.style.pointerEvents=lock?"none":"";
    }
    function toggleReady(){
      if(!ready){
        if(state.card.some(n=>!n)){ showToast("卡片還沒填滿"); return; }
        ready=true; roomRef.child("players/"+meId).update({ ready:true, name:meName }); setLock(true);
      }else{
        ready=false; roomRef.child("players/"+meId).update({ ready:false }); setLock(false);
      }
      updateReadyBtn();
    }
    function updateStartBtn(){
      $("mpStartBtn").classList.add("hidden");   // 不再用手動開始鈕:全部準備好即自動開打
      if(!isHost)return;
      const ids=Object.keys(players);
      const allReady=ids.length>=2 && ids.every(id=>players[id].ready);
      // 尚未全準備(或已離開大廳)→ 解除守衛,之後再次全部準備好時可再自動開打
      if(status!=="lobby" || !allReady){ autoStarting=false; return; }
      // 全部人都準備好 → 房主端直接開打,不必再按「開始」;只觸發一次(等 status 同步後守衛自然解除)
      if(!autoStarting){ autoStarting=true; startGame(); }
    }
    function setTarget(t){ if(isHost&&roomRef)roomRef.child("target").set(t); }
    function setOrderMethod(m){ if(isHost&&roomRef){ orderMethod=m; roomRef.child("orderMethod").set(m); syncOrderSeg(); } }
    function syncOrderSeg(){ const seg=$("orderSeg"); if(!seg)return; [...seg.children].forEach(b=>b.classList.toggle("on", b.dataset.order===orderMethod)); }
    // 大廳:出手順序讓所有人都看得到(房主可改,訪客唯讀)
    function syncOrderRow(){
      $("mpOrderRow").classList.remove("hidden");
      $("orderSeg").classList.toggle("readonly", !isHost);
      const lb=$("orderLabel"); if(lb)lb.textContent = isHost ? "出手順序由誰定" : "出手順序(房主決定)";
      syncOrderSeg();
    }
    /* ----- 連線計分:模式(累積排行 / 搶 N 勝)、目標勝場、重設戰績 ----- */
    // 搶勝賽季是否已開打:只要有人拿過分,目標勝場就鎖住(不然打到一半改「搶幾勝」會讓進度變得莫名其妙);要重設戰績/開新賽季才能再改
    function seasonInProgress(){ return scoreMode==="match" && Object.keys(players).some(id=>scoreOf(id)>0); }
    function setScoreMode(m){ if(isHost&&roomRef){ scoreMode=(m==="match")?"match":"rank"; roomRef.child("scoreMode").set(scoreMode); syncScoreRow(); savePrefs(); } }
    function setWinGoal(n){ if(isHost&&roomRef&&!seasonInProgress()){ winGoal=Math.max(2,Math.min(20,n|0)); roomRef.child("winGoal").set(winGoal); syncScoreRow(); savePrefs(); } }
    // 開機時把記住的計分偏好帶進來當「建房預設」(訪客加入別人的房仍以房主設定為準,由監聽覆蓋)
    function usePrefs(mode,goal){ if(mode==="match"||mode==="rank")scoreMode=mode; if(typeof goal==="number"&&goal>=2)winGoal=Math.min(20,goal); }
    // 房主重設所有人戰績歸零(大廳的「重設戰績」與奪冠後的「開新賽季」共用);只清 scores 節點,不動本局其它狀態
    function resetScores(){
      if(!isHost||!roomRef)return;
      const ups={}; Object.keys(players).forEach(id=>{ ups["scores/"+id]=null; });   // 整個清掉分數節點
      scoredThisRound=false;
      if(Object.keys(ups).length) roomRef.update(ups);
      showToast("已重設所有人的戰績 🏆");
    }
    function syncScoreSeg(){ const seg=$("scoreSeg"); if(!seg)return; [...seg.children].forEach(b=>b.classList.toggle("on", b.dataset.score===scoreMode)); }
    // 大廳:計分列大家都看得到(房主可改、訪客唯讀);搶勝模式才顯示目標勝場,調整/重設只有房主能操作
    function syncScoreRow(){
      const row=$("scoreRow"); if(!row || !state.online)return;
      if(curPhase==="lobby") row.classList.remove("hidden");
      $("scoreSeg").classList.toggle("readonly", !isHost);
      const lb=$("scoreLabel"); if(lb)lb.textContent = isHost ? "連線計分" : "連線計分(房主決定)";
      syncScoreSeg();
      // 附加列:房主任何模式都看得到(內含重設戰績);訪客只在搶勝模式看得到(顯示目標勝場)
      const extra=$("scoreExtra"); if(extra)extra.classList.toggle("hidden", !(isHost || scoreMode==="match"));
      const wg=$("wgGroup");
      // 目標勝場只有房主能調(訪客只看數字);賽季一旦開打(有人得分)就鎖住,避免打到一半改「搶幾勝」
      const locked=seasonInProgress();
      if(wg){ wg.classList.toggle("hidden", scoreMode!=="match"); wg.classList.toggle("locked", locked); }   // 目標勝場只在搶勝模式顯示
      const wv=$("winGoalVal"); if(wv)wv.textContent=winGoal;
      ["wgMinus","wgPlus"].forEach(id=>{ const b=$(id); if(b){ b.style.display=isHost?"":"none"; b.disabled=locked; } });
      const wh=$("wgLockHint"); if(wh)wh.classList.toggle("hidden", !(locked && isHost));   // 房主才需要知道為什麼不能改
      const rb=$("resetScoreBtn"); if(rb)rb.style.display=isHost?"":"none";                            // 重設戰績只有房主能按
    }
    function startGame(){
      if(!isHost)return;
      const ids=Object.keys(players);
      if(ids.length<2 || !ids.every(id=>players[id].ready)){ showToast("需要 2 人以上且全部準備好"); return; }
      const base={ target:state.target, calledList:[], winner:null, turnIndex:0, reveal:null, roundId:Date.now() };   // roundId 每局換,供「一局只計一次分」判定
      Object.keys(players).forEach(id=>{ base["players/"+id+"/winAt"]=null; base["players/"+id+"/lines"]=0; });   // 清掉上一局的達標紀錄與線數(分數存於 scores/,不隨開新局清除)
      if(orderMethod==="rps"){
        roomRef.update({ ...base, status:"rps", order:null, rps:{ seq:1, groups:[ids.join(",")], throws:null } });
      }else if(orderMethod==="random"){
        const ord=ids.slice();
        for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; }
        // 隨機順序沒有猜拳/排序過場當「屏障」。若把清空(calledList/winner)與 status="playing" 塞進同一次寫入,
        // 各端兩個監聽的到達順序不保證:一旦 status 先到,enterPlaying() 會用「上一局殘留的 calledList」重算而秒判勝利,
        // 於是再一局一開打就立刻跳結果卡、無限迴圈卡死(此 bug 只發生在隨機;rps/host 的清空在更早的獨立寫入已先傳到)。
        // 解法:拆成兩次寫入(Firebase 保證同一客戶端的寫入依序送達各端)——先清殘局並排好順序,確定 calledList 已清空,再翻 status 開打。
        roomRef.update({ ...base, order:ord, rps:null });
        roomRef.child("status").set("playing");
      }else{
        roomRef.update({ ...base, status:"ordering", order:null, rps:null });
      }
    }

    /* ----- phase dispatch ----- */
    function onStatus(){
      renderPlayers();
      if(status==="playing"){ if(curPhase!=="playing") enterPlaying(); else updateTurnUI(); }
      else if(status==="rps"){ if(curPhase!=="rps") enterRps(); else renderRps(); }
      else if(status==="reveal"){ if(curPhase!=="reveal") enterReveal(); else renderReveal(); }
      else if(status==="ordering"){ if(curPhase!=="ordering") enterOrdering(); else renderOrderPanel(); }
      else { if(curPhase!=="lobby" && !winner) backToLobby(); }   // 本局剛結束(winner 尚未清)時不強拉回大廳,留著結果卡讓玩家自己按「再一局/離開」
      curPhase=status;
    }

    /* ----- rock-paper-scissors: decide turn order ----- */
    function beats(a,b){ return (a==="R"&&b==="S")||(a==="S"&&b==="P")||(a==="P"&&b==="R"); }
    function myGroup(){
      const gs=(rps&&rps.groups)||[];
      for(const g of gs){ const m=String(g).split(","); if(m.indexOf(meId)>=0) return m; }
      return null;
    }
    function enterRps(){
      state.mode="setup";
      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 猜拳:收起房間分頁列
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      $("mpControls").classList.add("hidden"); $("mpOrderPanel").classList.add("hidden");
      showMpVeil("rps");
      setLock(true);
      tieSig="";
      renderRps();
    }
    function renderRps(){
      const gs=(rps&&rps.groups)||[];
      const seq=(rps&&rps.seq)||1;
      const throws=(rps&&rps.throws)||{};
      const mg=myGroup();
      // 平手揭曉:停留一下,讓大家看清楚剛剛是平手(保留這輪的出拳),之後房主自動帶進下一輪
      if(rps&&rps.tie){ renderRpsTie(gs,seq,throws,mg); return; }
      const mine=!!(throws[meId]&&throws[meId].s===seq);   // 需為布林:classList.toggle 收到 undefined 會「翻轉」而非設定,平手重猜時會亂亮
      const inGroup = mg && mg.length>1;               // 你在還要比大小的組裡
      const btns=$("rpsBtns");
      btns.style.display = inGroup ? "" : "none";        // 出拳前後都顯示(讓你選的那個留著)
      btns.classList.toggle("locked", !!mine);           // 已出拳 → 鎖住不能再改
      let hint;
      if(!inGroup) hint="你的順序已定,等其他人猜完…";
      else if(mine) hint="你出了 "+RPS_EMO[throws[meId].c]+" "+RPS_TXT[throws[meId].c]+",等待其他人…";
      else hint="出拳!(和你平手的人一起比大小)";
      $("rpsHint").textContent=hint;
      [...btns.children].forEach(b=>{
        const isChosen = mine && throws[meId].c===b.dataset.rps;
        b.classList.toggle("chosen", isChosen);
        b.classList.toggle("dim", !!mine && !isChosen);  // 出拳後淡化沒選的,只留你選的
      });
      const box=$("rpsThrows"); box.innerHTML="";
      gs.map(g=>String(g).split(",")).filter(m=>m.length>1).reduce((a,m)=>a.concat(m),[]).filter(id=>players[id]).forEach(id=>{
        const done=throws[id]&&throws[id].s===seq;
        const chip=document.createElement("div"); chip.className="mp-chip"+(done?" ready":"")+(id===meId?" me":"");
        // 只顯示「是否已出拳」,絕不透露對方出的拳(避免後出的人偷看)
        chip.innerHTML='<span class="dot"></span><span>'+esc(dispName(id))+'</span>'+youTag(id)+'<span class="ln">'+(done?"已出拳":"等待中")+'</span>';
        box.appendChild(chip);
      });
    }
    // 平手揭曉:把這一輪還在比大小的人各出了什麼攤開來,標明平手,停留一下再重猜
    function renderRpsTie(gs,seq,throws,mg){
      const inGroup = mg && mg.length>1;
      $("rpsBtns").style.display="none";
      $("rpsHint").textContent = inGroup ? "🤝 平手!再猜一次…" : "還有人平手,再猜一次…";
      const ids=gs.map(g=>String(g).split(",")).filter(m=>m.length>1)
        .reduce((a,m)=>a.concat(m),[]).filter(id=>players[id]);
      const sig="tie:"+seq+"|"+ids.map(id=>id+":"+((throws[id]&&throws[id].c)||"")).join(",");
      if(sig===tieSig) return;   // 內容沒變就不重繪,避免動畫重播
      tieSig=sig;
      const box=$("rpsThrows"); box.innerHTML="";
      ids.forEach((id,idx)=>{
        const c=(throws[id]&&throws[id].s===seq)?throws[id].c:null;
        const it=document.createElement("div");
        it.className="reveal-hand tie"+(id===meId?" me":"");
        it.style.animationDelay=(idx*0.08)+"s";
        it.innerHTML=youTag(id)+'<span class="emo">'+(RPS_EMO[c]||"❔")+'</span>'+
          '<span class="nm">'+esc(dispName(id))+'</span>'+
          '<span class="txt">'+(RPS_TXT[c]||"")+'</span>';
        box.appendChild(it);
      });
    }
    function throwRps(c){
      if(!rps||curPhase!=="rps"||rps.tie)return;
      const mg=myGroup(); if(!mg||mg.length<=1)return;
      const seq=rps.seq||1;
      roomRef.child("rps/throws/"+meId).set({ c:c, s:seq });
    }
    function rpsHostResolve(){
      if(!isHost||!rps||status!=="rps")return;
      if(rps.tie)return;                 // 平手揭曉中,等房主的計時器帶進下一輪,先不判定
      const seq=rps.seq||1;
      const throws=rps.throws||{};
      let groups=(rps.groups||[]).map(g=>String(g).split(",").filter(id=>players[id])).filter(g=>g.length>0);
      const pending=groups.filter(g=>g.length>1).reduce((a,g)=>a.concat(g),[]);
      if(pending.length===0){
        roomRef.update({ order:groups.reduce((a,g)=>a.concat(g),[]), turnIndex:0, status:"playing", rps:null });
        return;
      }
      if(!pending.every(id=>throws[id]&&throws[id].s===seq))return;
      // 累積每位玩家「最後出的拳」,供最後過場揭曉(第一輪為全體同組,故人人都有紀錄)
      const acc=Object.assign({}, (rps.reveal||{}));
      pending.forEach(id=>{ acc[id]=throws[id].c; });
      const newGroups=[];
      groups.forEach(g=>{
        if(g.length<=1){ newGroups.push(g); return; }
        const wins={};
        g.forEach(x=>{ wins[x]=g.filter(y=>y!==x && beats(throws[x].c, throws[y].c)).length; });
        const sorted=[...g].sort((a,b)=>wins[b]-wins[a]);
        let cur=[], curWin=null;
        sorted.forEach(x=>{ if(curWin===null||wins[x]===curWin){ cur.push(x); curWin=wins[x]; } else { newGroups.push(cur); cur=[x]; curWin=wins[x]; } });
        if(cur.length)newGroups.push(cur);
      });
      if(newGroups.some(g=>g.length>1)){
        // 還有平手 → 先揭曉這一輪(讓大家看清楚是平手),停留約 2 秒再重猜(保留已累積的出拳紀錄)
        if(tieTimer)return;                              // 已排程過就不重複
        const nextGroups=newGroups.map(g=>g.join(","));
        // 先把分組結果寫進去(已定案的人變單獨一組),並保留 throws/seq 讓平手的人看到彼此出了什麼
        roomRef.update({ "rps/groups":nextGroups, "rps/tie":true });
        tieTimer=setTimeout(()=>{
          tieTimer=null;
          roomRef.update({ "rps/seq":seq+1, "rps/throws":null, "rps/reveal":acc, "rps/tie":null });
        }, 1500);
      }else{
        // 定案 → 先進入過場揭曉(帶著大家的出拳與最終順序),再由房主自動開打
        const finalOrder=newGroups.reduce((a,g)=>a.concat(g),[]);
        roomRef.update({ status:"reveal", order:finalOrder, turnIndex:0, rps:null, reveal:{ throws:acc, order:finalOrder } });
      }
    }

    /* ----- reveal: 猜拳過場,揭曉大家出了什麼 ----- */
    function enterReveal(){
      state.mode="setup";
      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 猜拳揭曉:收起房間分頁列
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      $("mpControls").classList.add("hidden"); $("mpOrderPanel").classList.add("hidden");
      showMpVeil("reveal");
      setLock(true);
      revealSig="";   // 每局重繪,確保揭曉動畫重播
      renderReveal();
      if(isHost) scheduleRevealAdvance();   // 房主:停留約 3 秒後自動開打(也可按「繼續」提早)
    }
    let revealSig="";
    function renderReveal(){
      const rv=revealData||{};
      const throws=rv.throws||{};
      const ord=(rv.order&&rv.order.length?rv.order:order)||[];
      const ids=ord.filter(id=>players[id]||throws[id]);
      if(ids.length && !ids.some(id=>throws[id])) return;   // 出拳資料還沒同步到,先不畫(避免閃現❔)
      const sig=ids.map(id=>id+":"+(throws[id]||"")).join("|");
      if(sig===revealSig) return;   // 內容沒變就不重繪(避免動畫重播)
      revealSig=sig;
      const box=$("revealList"); if(!box)return; box.innerHTML="";
      ids.forEach((id,idx)=>{
        const c=throws[id];
        const it=document.createElement("div");
        it.className="reveal-hand"+(idx===0?" win":"")+(id===meId?" me":"");
        it.style.animationDelay=(idx*0.12)+"s";
        it.innerHTML=youTag(id)+'<span class="rk">'+(idx+1)+'</span>'+
          '<span class="emo">'+(RPS_EMO[c]||"❔")+'</span>'+
          '<span class="nm">'+esc(dispName(id))+'</span>'+
          '<span class="txt">'+(RPS_TXT[c]||"")+'</span>';
        box.appendChild(it);
      });
      const oe=$("revealOrder");
      if(oe){
        const champ=ids[0];   // 排第一 = 贏家,先出號 → 用大字強調,一眼看清是誰
        let html='<div class="reveal-champ">🏆 <span class="nm">'+esc(dispName(champ))+'</span>'+youTag(champ)+' 先出號!</div>';
        if(ids.length>2) html+='<div class="reveal-seq">出手順序:'+ids.map(id=>esc(dispName(id))).join(" → ")+'</div>';
        oe.innerHTML=html;
      }
      // 「跳過」鈕:所有人都看得到、都能按(用來快速跳過揭曉畫面);沒按也會自動開打
      const btn=$("revealSkip"); if(btn) btn.classList.remove("hidden");
      const rh=$("revealHint"); if(rh) rh.textContent = "3 秒後自動開始,或按下方跳過";
    }
    function scheduleRevealAdvance(){
      if(!isHost || revealTimer) return;               // 自動計時只由房主掛一個,避免多人重複寫
      revealTimer=setTimeout(()=>{ revealTimer=null; revealSkip(); }, 3000);
    }
    // 揭曉 → 開打:自動計時(房主)或任一人按「跳過」都走這裡,把整局推進到開打
    function revealSkip(){
      if(status!=="reveal" || !roomRef) return;
      if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; }
      roomRef.update({ status:"playing", reveal:null });
    }

    /* ----- host manual ordering ----- */
    function enterOrdering(){
      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 房主排順序:收起房間分頁列
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      $("mpControls").classList.add("hidden"); hideMpVeil();
      $("mpOrderPanel").classList.remove("hidden");
      setLock(true);
      orderDraft=Object.keys(players);
      renderOrderPanel();
    }
    function renderOrderPanel(){
      $("orderConfirm").classList.toggle("hidden", !isHost);
      $("orderHint").textContent=isHost ? "用上下箭頭排好先後,然後開始。" : "房主正在安排出手順序…";
      const list=$("orderList"); if(!list)return; list.innerHTML="";
      let arr = isHost ? orderDraft.filter(id=>players[id]) : Object.keys(players);
      if(isHost) orderDraft=arr;
      arr.forEach((id,idx)=>{
        const it=document.createElement("div"); it.className="order-item";
        it.innerHTML='<span class="seat">'+(idx+1)+'</span><span class="nm">'+esc(dispName(id))+(id===meId?"(你)":"")+'</span>';
        if(isHost){
          const mv=document.createElement("span"); mv.className="mv";
          const up=document.createElement("button"); up.textContent="▲"; up.disabled=idx===0; up.addEventListener("click",()=>moveOrder(idx,-1));
          const dn=document.createElement("button"); dn.textContent="▼"; dn.disabled=idx===arr.length-1; dn.addEventListener("click",()=>moveOrder(idx,1));
          mv.appendChild(up); mv.appendChild(dn); it.appendChild(mv);
        }
        list.appendChild(it);
      });
    }
    function moveOrder(idx,d){
      const a=orderDraft.filter(id=>players[id]); const j=idx+d;
      if(j<0||j>=a.length)return;
      const t=a[idx]; a[idx]=a[j]; a[j]=t; orderDraft=a; renderOrderPanel();
    }
    function confirmOrder(){
      if(!isHost)return;
      const ord=orderDraft.filter(id=>players[id]);
      if(ord.length<2){ showToast("人數不足"); return; }
      roomRef.update({ order:ord, turnIndex:0, status:"playing" });
    }

    /* ----- playing (turn-based manual call) ----- */
    function enterPlaying(){
      state.mode="play"; state.won=false; state.lastLines=0; state.marked=Array(nCells()).fill(false);
      myWinAt=null; outcomeShown=false; orderAnnounced=false; abandoned=false; scoredThisRound=false;
      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 進遊戲:收起房間分頁列,棋盤佔滿
      $("playStatus").classList.add("hidden");
      hideMpVeil(); $("mpOrderPanel").classList.add("hidden");
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      $("mpControls").classList.remove("hidden");
      const g=$("mpGoalNum"); if(g)g.textContent=state.target+" 線";
      setLock(false);
      resetMarquee(); render(); applyCalledMarks(); updateTurnUI(); refreshLines();
      maybeAnnounceOrder();
    }
    // 猜拳/排序定案後,公告一次出手順序(讓大家知道猜拳誰贏誰輸);order 可能比 status 晚到,故用旗標確保只公告一次
    function maybeAnnounceOrder(){
      if(orderAnnounced || !order.length || status!=="playing") return;
      orderAnnounced=true;
      if(orderMethod==="rps") return;   // 猜拳已用過場揭曉,不再跳 toast 重複公告
      const nm=id=>dispName(id);
      let msg;
      if(orderMethod==="random"){
        msg = "🎲 隨機順序:"+order.map(nm).join(" → ");
      }else{
        msg = "出手順序:"+order.map(nm).join(" → ");
      }
      showToast(msg, 3200);
    }
    function isMyTurn(){ return status==="playing" && !winner && !abandoned && order.length>0 && order[turnIndex]===meId; }
    function isCalled(v){ return calledList.indexOf(v)>=0; }
    function nextTurn(from){
      if(!order.length)return from;
      let i=from;
      for(let k=0;k<order.length;k++){ i=(i+1)%order.length; if(players[order[i]])return i; }
      return from;
    }
    function updateTurnUI(){
      const el=$("mpTurn"); if(!el)return;
      if(status!=="playing"){ el.textContent="等待開始…"; el.classList.add("wait"); return; }
      const p=order[turnIndex];
      if(!p){ el.textContent="—"; el.classList.add("wait"); return; }
      if(p===meId){ el.textContent="👉 換你出號!"; el.classList.remove("wait"); }
      else { el.textContent="輪到 "+dispName(p); el.classList.add("wait"); }
    }
    function tap(i){
      if(!isMyTurn()){ showToast("還沒輪到你"); return; }
      const n=state.card[i]; if(!n)return;
      if(isCalled(n))return;
      Sound.place();
      roomRef.update({ calledList:calledList.concat(n), turnIndex:nextTurn(turnIndex) });
    }
    function onCalled(){
      const last=calledList[calledList.length-1];
      $("mpLastNum").textContent=last?last:"–";
      if(state.mode==="play"){
        const prev=state.marked.slice();
        applyCalledMarks();
        if(state.marked.some((m,i)=>m&&!prev[i]))Sound.mark();
        render(); updateTurnUI();
      }
    }
    function applyCalledMarks(){
      const set=new Set(calledList);
      for(let i=0;i<nCells();i++){
        state.marked[i]=set.has(state.card[i]);
        if(grid.children[i])grid.children[i].classList.toggle("marked",state.marked[i]);
      }
    }
    function reportLines(done){ if(roomRef&&meId)roomRef.child("players/"+meId+"/lines").set(done); }
    function tryWin(done){
      if(!roomRef)return;
      // 記錄「自己在第幾次叫號時達標」;同一次叫號同時達標 = 平手(見 showOutcome)
      if(myWinAt===null){ myWinAt=calledList.length; if(meId)roomRef.child("players/"+meId+"/winAt").set(myWinAt); }
      roomRef.child("winner").transaction(w=> w || { id:meId, name:meName, lines:done, at:myWinAt });
    }

    function onWinner(){ if(winner) showOutcome(); }
    // 揭曉結果:比較各玩家達標時的叫號數(winAt),最早者贏;若最早者不只一人 = 平手
    function showOutcome(){
      if(!winner)return;
      if(!outcomeShown && state.mode!=="play") return;   // 我不是這局的參賽者(例如趁「再一局」大廳期間才加入的人)→ 不彈出上一局的舊結果卡
      const withAt=Object.keys(players).filter(id=>players[id]&&typeof players[id].winAt==="number");
      let finalists, at;
      if(withAt.length){
        at=Math.min.apply(null, withAt.map(id=>players[id].winAt));
        finalists=withAt.filter(id=>players[id].winAt===at);
      }else{
        finalists=[winner.id];
      }
      const isDraw=finalists.length>1;
      const iWon=finalists.indexOf(meId)>=0;
      const lines=(winner&&winner.lines)||state.target;
      myRoundWin=iWon;   // 記住我這局贏了 → renderScoreboard 先樂觀 +1,不必等加分交易回寫

      // 計分:贏家(含平手雙方)幫「自己」+1 勝,一局只計一次。
      // 分數寫在獨立的 scores/<id>(不掛 onDisconnect,斷線刪不到);用 roundId + scores 上的 round 做冪等:
      // 交易內再驗一次,重複呼叫也不會重複加;只寫自己節點,契合全案「不跨寫別人」的做法。
      if(iWon && meId && roomRef && roundId && !scoredThisRound && scoredRoundOf(meId)!==roundId){
        scoredThisRound=true;
        roomRef.child("scores/"+meId).transaction(s=>{
          if(s && s.round===roundId) return;          // 這局已計過 → 中止交易,不重複加
          return { n:((s&&s.n)||0)+1, round:roundId }; // s=null 時自然建立 {n:1,...}
        }, ()=>{ if(winner) renderScoreboard(); });   // 加分寫入完成後,用回寫後的真實分數再畫一次排行(補上樂觀值/確認達標)
      }

      $("spWinBtns").classList.add("hidden");
      $("mpWinBtns").classList.remove("hidden");
      $("mpAgain").style.display="";   // 結束後,房主與訪客都看得到「再一局」,各自決定要不要續玩
      showResult();
      // 本局一結束就把自己設為「未準備」:再一局需各玩家重新按準備確認,房主才在大家都 ready 後才能開始(只寫自己節點,不動別人)
      if(!outcomeShown && meId && roomRef){ ready=false; roomRef.child("players/"+meId).update({ ready:false }); }

      if(isDraw){
        const names=finalists.map(id=>dispName(id));
        const mineTie=finalists.indexOf(meId)>=0;
        $("winWord").textContent="平手!";
        $("winMsg").textContent=names.join("、")+" 同時完成 "+lines+" 條線,平手!";
        if(!outcomeShown){ Sound.win(); if(mineTie)burst(); }
      }else{
        const wid=finalists[0], mine=wid===meId;
        if(mine){
          $("winWord").textContent="你贏了!";
          $("winMsg").textContent="你最先完成 "+lines+" 條線 🎉";
        }else{
          $("winWord").textContent="你輸了";
          $("winMsg").textContent=dispName(wid)+" 先完成了 "+lines+" 條線";
        }
        if(!outcomeShown){ if(mine){ Sound.win(); burst(); } else { Sound.lose(); } }
      }
      renderScoreboard();   // 結果卡下方畫累積勝場排行(+ 搶勝模式的總冠軍橫幅)
      outcomeShown=true;
      render();
    }
    // 連線計分:從獨立的 scores 節點取值(不受在線節點刪除影響)
    function scoreOf(id){ return (scores[id]&&scores[id].n)||0; }
    function scoredRoundOf(id){ return scores[id]&&scores[id].round; }
    // 結果卡下方的累積勝場排行榜;搶 N 勝模式下有人達標時多顯示「總冠軍」橫幅,房主再多一顆「開新賽季」
    function renderScoreboard(){
      const sb=$("winScores"), champEl=$("winChamp"), nsBtn=$("mpNewSeason");
      if(!sb)return;
      const rows=Object.keys(players).map(id=>{
        let score=scoreOf(id);
        // 我這局贏了、但加分交易還沒回寫到本地快照 → 先樂觀 +1,避免結果卡上自己還顯示舊分(0 勝)
        if(id===meId && myRoundWin && roundId && scoredRoundOf(id)!==roundId) score+=1;
        return { id, score, name:dispName(id) };
      }).sort((a,b)=> b.score-a.score || (a.id<b.id?-1:1));   // 分數高→低,同分依 id(各端一致)
      const top=rows.length?rows[0].score:0;
      const anyScore=top>0;
      const champs=(scoreMode==="match" && top>=winGoal) ? rows.filter(r=>r.score===top) : [];
      if(champEl){
        if(champs.length){
          // 總冠軍:第一行標題,換行後大字顯示是誰,再一行小字標達標勝場(名字為玩家輸入 → esc 防注入)
          champEl.innerHTML='<span class="champ-label">🏆 總冠軍</span>'+
            '<span class="champ-name">'+champs.map(c=>esc(c.name)).join("、")+'</span>'+
            '<span class="champ-goal">先達 '+winGoal+' 勝</span>';
          champEl.classList.remove("hidden");
        }
        else champEl.classList.add("hidden");
      }
      // 第一局還沒分數(累積模式)就不顯示空排行;搶勝模式則一律顯示,讓大家知道進度
      if(anyScore || scoreMode==="match"){
        // 搶勝模式、還沒人奪冠時,頂端補一行「🎯 搶 N 勝」讓大家清楚這局在拼幾勝
        const goalCap=(scoreMode==="match" && !champs.length) ? '<div class="ws-goal">🎯 搶 '+winGoal+' 勝</div>' : '';
        sb.innerHTML=goalCap+rows.map((r,i)=>{
          const lead=r.score===top && top>0;
          const cls="ws-row"+(lead?" lead":"")+(r.id===meId?" me":"");
          const rank=lead?"🏆":(i+1)+".";
          return '<div class="'+cls+'"><span class="ws-rank">'+rank+'</span><span class="ws-name">'+esc(r.name)+'</span><span class="ws-pts">'+r.score+' 勝</span></div>';
        }).join("");
        sb.classList.remove("hidden");
      }else{ sb.innerHTML=""; sb.classList.add("hidden"); }
      if(nsBtn) nsBtn.classList.toggle("hidden", !(champs.length && isHost));   // 奪冠後房主才有「開新賽季」
    }
    // 遊戲中其他人都離開、房主只剩自己:自動回大廳等待(保留房間開著讓人重新加入),不卡在單人局
    function hostAloneToLobby(){
      if(curPhase==="lobby")return;
      showToast("其他玩家都離開了,回到等待…", 2600);
      resetRoomToLobby();   // 對手都走了、本局作廢(此時無 winner):房主把整房清回大廳,房號不變,可繼續等人加入
    }
    // 房主用:把整房「完整」清回大廳(清掉本局所有資料、所有人取消準備)。用於「猜拳中途取消」與「對手都離開作廢」;
    // 這兩種情況都沒有 winner 要保留,故可直接清 winner。所有寫入皆由房主發出,權限一定夠。
    function resetRoomToLobby(){
      if(!roomRef)return;
      const ups={ status:"lobby", calledList:[], winner:null, order:null, turnIndex:0, rps:null, reveal:null, emotes:null };
      Object.keys(players).forEach(id=>{ ups["players/"+id+"/lines"]=0; ups["players/"+id+"/ready"]=false; ups["players/"+id+"/winAt"]=null; });
      roomRef.update(ups);
      backToLobby();
    }
    // 「再一局」= 每位玩家各自決定要不要續玩(房主或訪客皆可按):只把自己帶回大廳重新準備,不強拉別人。
    // 第一個按的人負責把房間 status 翻回 "lobby";其餘本局資料(calledList/winner/order/winAt)留到下一局 startGame 才清,
    // 才不會把還在看結果的人的結果卡弄壞(winner 一旦被清,他們的結果卡就會被 onWinner 收掉)。
    // 各玩家的 ready 已在 showOutcome(本局結束當下)各自設為 false,故回大廳後都要重新按準備,房主才能開始。
    function again(){
      if(!roomRef)return;
      if(status!=="lobby") roomRef.child("status").set("lobby");
      backToLobby();
    }
    function backToLobby(){
      ready=false; state.mode="setup"; state.won=false; state.fill="auto"; state.card=shuffled(); curPhase="lobby";
      order=[]; turnIndex=0; rps=null; myWinAt=null; outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false;
      revealData=null; revealSig=""; if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; }
      tieSig=""; if(tieTimer){ clearTimeout(tieTimer); tieTimer=null; }
      closeWin();
      $("setup").classList.remove("hidden");
      $("setupActions").classList.remove("hidden");
      updateRoomTabs(true,"fill");   // 回大廳續玩:分頁預設「填號」,重新填卡準備
      hidePhasePanels();
      $("startBtn").classList.add("hidden");
      $("onlineBtn").classList.add("hidden");
      $("mpReadyBtn").classList.remove("hidden");
      syncOrderRow(); syncScoreRow();
      setLock(false); updateReadyBtn(); render(); applyFillUI();
    }
    function leave(){
      try{
        if(roomRef){
          ["host","players","status","target","size","orderMethod","order","turnIndex","rps","reveal","calledList","winner","emotes","scores"].forEach(k=>roomRef.child(k).off());
          if(isHost){
            if(meId) roomRef.child("players/"+meId).onDisconnect().cancel();
            roomRef.onDisconnect().cancel();
            roomRef.remove();                       // 房主離開 → 關閉整個房間
          }else if(meId){
            const pr=roomRef.child("players/"+meId);
            pr.onDisconnect().cancel();
            pr.remove();
            roomRef.child("scores/"+meId).remove();   // 訪客主動離開才清自己分數(斷線不清)
          }
        }
      }catch(e){}
      stopConn(); clearRecheck();                   // 卸載連線監聽、清掉寬限計時器
      resyncing=false; if(resyncTimer){ clearTimeout(resyncTimer); resyncTimer=null; }
      sawPlayers=false; sawMe=false; sawHost=false; hostId=null;
      roomRef=null; code=null; state.online=false; ready=false; winner=null; status="lobby"; players={}; scores={}; calledList=[];
      order=[]; turnIndex=0; rps=null; curPhase="lobby"; myWinAt=null; outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false;
      revealData=null; revealSig=""; if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; }
      tieSig=""; if(tieTimer){ clearTimeout(tieTimer); tieTimer=null; }
      emotesReady=false; closeEmote();
      document.body.classList.remove("mp-on"); resetQuickVoiceBtn();   // 離線:收起快速語音浮動鈕
      closeWin();
      $("mpBar").classList.add("hidden");
      hidePhasePanels();
      $("mpReadyBtn").classList.add("hidden");
      $("mpStartBtn").classList.add("hidden");
      $("mpConnect").classList.add("hidden");
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      $("startBtn").classList.remove("hidden");
      $("onlineBtn").classList.remove("hidden");
      $("targetRow").style.display="";
      $("sizeRow").style.display="";
      setLock(false);
      enterHome();   // 離開房間 → 回主選單(不再掉到單機設定)
    }
    function readyEnabled(ok){ if(state.online && !ready)$("mpReadyBtn").disabled=!ok; }

    /* ----- 盤面大小 / 好友互動表情 ----- */
    function amHost(){ return isHost; }
    function setBoardSize(n){ if(isHost&&roomRef&&n>=5&&n<=7) roomRef.child("size").set(n); }
    // 目前房間的玩家清單(給表情面板挑對象用),含顯示名與是否為自己
    function roster(){ return Object.keys(players).map(id=>({ id:id, name:dispName(id), me:id===meId })); }
    function sendEmote(to,emoji,kind,audio){
      if(!roomRef||!meId)return;
      const isText=kind==="text", isVoice=kind==="voice";
      const ref=roomRef.child("emotes").push();
      const rec={ from:meId, to:to||"all", kind:isVoice?"voice":(isText?"text":"emoji"), at:firebase.database.ServerValue.TIMESTAMP };
      if(isVoice){ rec.emoji="🎤"; rec.audio=String(audio||""); }        // 語音:emoji 當顯示圖示,音訊放 audio(base64)
      else { rec.emoji=String(emoji).slice(0,isText?24:8); }
      ref.set(rec);
      ref.onDisconnect().remove();
      setTimeout(()=>{ try{ ref.remove(); }catch(e){} }, isVoice?15000:6000);   // 秀完自動清掉;語音較大,多給時間讓大家收到再清
    }
    // 收到互動:只顯示「給全部」「給我」「我自己送出」的;針對某人 → 動畫落在那個人的晶片
    function handleEmote(e){
      if(!e)return;
      const to=e.to||"all";
      if(to!=="all" && to!==meId && e.from!==meId)return;
      const fromNm=dispName(e.from)+(e.from===meId?"(你)":"");
      const toNm=(to==="all")?"全部人":dispName(to)+(to===meId?"(你)":"");
      const mine=e.from===meId, forMe=(to==="all"||to===meId);
      if(e.kind==="voice"){
        showEmote("🎤", fromNm+" → "+toNm, (to!=="all")?to:e.from, "voice");
        if(!mine && forMe) enqueueVoice(e.audio);   // 別人傳給我/全部人才播(進佇列排隊逐一播);自己送的不回放
        return;
      }
      if(!e.emoji)return;
      showEmote(e.emoji, fromNm+" → "+toNm, (to!=="all")?to:e.from, e.kind);
      if(!mine && forMe) Sound.emote();
    }

    // 手機從 LINE 等 App 切回前景:主動歸位一次(是否真的斷過交給 .info/connected 決定要不要提示);
    // 同時嘗試喚醒音訊 + 補播等待中的語音(iOS 切背景會把 AudioContext 打回 suspended)
    document.addEventListener("visibilitychange",()=>{
      if(document.hidden)return;
      resume(null);
      try{ Sound.wake(); }catch(e){}
      if(typeof kickVoiceQueue==="function") kickVoiceQueue();
    });

    return { available, openConnect, closeConnect, create, join, scanRooms, toggleReady, startGame,
             setTarget, setOrderMethod, throwRps, confirmOrder, again, leave,
             reportLines, tryWin, readyEnabled, isMyTurn, isCalled, tap,
             amHost, setSize:setBoardSize, roster, sendEmote, revealSkip, bailFromRps,
             confirmKick, cancelKick:closeKick, refreshHint:mpHint,
             setScoreMode, setWinGoal, resetScores, winGoal:()=>winGoal, scoreMode:()=>scoreMode, usePrefs };
  })();

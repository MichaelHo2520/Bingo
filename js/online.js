"use strict";

  /* ---------- Multiplayer (Firebase) ---------- */
  const MP=(function(){
    let db=null, roomRef=null, code=null, meId=null, meName="玩家", isHost=false;
    let roomName="";                             // 房主設定的房間名稱(對外顯示用;內部仍以 code 當資料庫鍵值)
    let roomsWatchRef=null, lastRoomsSig=null;   // 大廳常駐監聽:即時反映房間開/關,免得一直按🔍
    let lastIndexSig=null;                        // 房主寫大廳輕量索引 rooms_index 的去重簽章(房名/狀態/人數/房主名沒變就不重寫)
    let wasMyTurn=false;                          // 連線遊戲中「輪到我」的邊緣偵測(不是我→是我 只提示一次)
    let players={}, calledList=[], status="lobby", winner=null, ready=false;
    let autoStarting=false;   // 全部人準備好 → 房主端自動開打的一次性守衛(避免 status 尚未同步前重複觸發)
    let prevIds=null;   // 上一次的玩家 id 清單,用來偵測「有新玩家加入」放音效(null=進房後尚未收到第一次快照)
    let orderMethod="random", order=[], turnIndex=0, rps=null, curPhase="lobby", orderDraft=[];   // 預設隨機(v1.36.3,原為 rps)
    // 一局揮發狀態全收在單一 game 節點(status/order/turnIndex/calledList/rps/reveal/winner/roundId),每次推進帶單調遞增 rev。
    // 單一節點 → 沒有「跨欄位事件到達順序」問題;rev 每次遞增 → 值即使相同也算變化、事件必觸發(取代舊的「先寫 null」與 enterPlaying 重讀等 workaround)。
    let gameRev=0;   // 本地已套用的最新 game 版本;收到 rev 更舊的快照直接丟(過期快照)
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
    let reachAnnounced=false;               // 本局是否已廣播過「聽牌」(一局只播一次,避免每次叫號重播)
    let reachClipTimer=null;                // 接收端合併:同一波多人聽牌只播一次「聽牌」語音(見 handleEmote reach)
    let revealData=null, revealTimer=null;  // 猜拳過場:大家出的拳 / 房主用的「揭曉後自動開打」計時器
    let tieTimer=null, tieSig="";           // 平手揭曉:房主用的「停留後自動重猜」計時器 / 避免重繪重播動畫
    let emotesReady=false;                   // 好友互動:是否已略過歷史 emotes(避免重播舊表情)
    let connRef=null, connected=null;        // .info/connected 監聽 / 目前連線狀態(null=未知,尚未回報)
    let resyncing=false, resyncTimer=null;   // 剛從背景/斷線恢復的寬限旗標與計時器(期間不把舊名單快照當成被踢)
    let graceTimer=null, graceAt=0;          // 「暫時有人不見」的寬限計時器:逾時仍不見才真的離開/回大廳
    let aloneTimer=null, aloneTick=null, aloneWaitMs=0;   // 遊戲中只剩房主自己的專用計時器 + 秒數倒數 interval
    /* 即時語音:現在有誰正在說話(talk.js 本地量出來的,不進 DB)。
       talkingSig 是上一次畫過的簽章 —— 只在真的變了才重畫晶片列(見 listen 的 onState)。
       ⚠ renderPlayers() 會讀 talkingIds,少了這一行是**執行期** ReferenceError,
         而 `node --check` 只驗語法、抓不到它。 */
    let talkingIds=[], talkingSig="";
    let byeIds={};                        // 「自己按了離開房間」的人(bye/{pid});見下面四個寬限期
    /* ---------- 四個寬限期(v1.166.0 拆成兩組:「斷線」給滿一分鐘,「按下離開」照舊很快) ----------
       使用者:「離開視窗後再回來…改成 1 分鐘內回來都沒問題」。切去 LINE 回訊息、接個電話,
       手機馬上凍結分頁 → WebSocket 斷 → 伺服器依 onDisconnect 把 players/{我} 移掉,
       於是**別人那一台**會在寬限期到期時把這局作廢 / 把自己退出房間。
       ⚠ 寬限期一拉長,「真的按了離開」的路徑會跟著變慢 → 明確的離開訊號另外走短的:
         房主按離開 → host 欄位不見了(關房訊號)→ CLOSE_MS;訪客按離開 → bye/{pid} 記號 → BYE_MS。
       ⚠ 這一整套與 js/shared/mp-core.js 是雙胞胎(CLAUDE.md 紅線 4/5),改一邊要改另一邊。 */
    const GRACE_MS=60000;                    // 斷線寬限期(手機切 App 常見情境):一分鐘內回來就當沒事
    const ALONE_MS=60000;                    // 對手**斷線**後仍只剩自己 → 退回大廳(重連歸位來得及回來就取消)
    const CLOSE_MS=1200;                     // 房主按了「離開房間」= 明確關房,訪客不必等滿寬限
    const BYE_MS=8000;                       // 對手按了「離開房間」= 明確走人,照舊短寬限(= 改動前的 ALONE_MS)
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
    // 把輕量索引節點 rooms_index 整理成清單(依房號排序)。索引只存大廳需要的欄位(房名/狀態/人數/房主名),
    // 不含 calledList / emotes(語音 base64)等 gameplay 資料 → 大廳流量大幅降低。
    function roomItems(idx){
      return Object.keys(idx).map(c=>{
        const r=idx[c]||{};
        return { code:c, status:r.status||"lobby", count:r.count||0, host:r.host||"", name:r.name||"" };
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
    // 掛上常駐監聽:房間開/關會即時反映;離開大廳(closeConnect/enterLobby)時 stopRoomWatch 卸載。
    // 只監聽輕量索引 rooms_index(每房約 4 個小欄位),不再整包下載所有房間的 gameplay 資料。
    function startRoomWatch(){
      if(!init()){ setLive("none","連線未啟用"); return; }
      stopRoomWatch();
      lastRoomsSig=null; setLive("loading","偵測目前房間中…");
      roomsWatchRef=db.ref("rooms_index");
      roomsWatchRef.on("value", s=>applyRooms(roomItems(s.val()||{})), err=>{
        stopRoomWatch(); setLive("error","無法讀取房間清單");
        $("mpRoomList").innerHTML='<div class="room-empty">偵測失敗:'+esc(err.message)+'(可能是資料庫規則未開放 rooms_index 讀取,見說明)</div>';
      });
    }
    function stopRoomWatch(){ if(roomsWatchRef){ roomsWatchRef.off(); roomsWatchRef=null; } }
    // ── 大廳輕量索引 rooms_index/{code}(降低資料庫用量的核心)──
    // 只存大廳清單要的欄位(name 房名 / status 狀態 / count 人數 / host 房主名),由「房主」單方維護:
    //   • 房主的 players / status 一有變動,用 sig 去重後才寫回(避免每次劃記線數都寫)。
    //   • 索引掛房主的 onDisconnect().remove():房主斷線/離開 → 索引消失,大廳即時不再顯示這間;
    //     房內玩家看的是 rooms/{code} 本體,不受影響。房主重連(resume)會 armRoomIndex() 重掛+重寫。
    //   • 房主真的離線不回 → 索引已被 onDisconnect 清掉,大廳不會殘留(rooms/{code} 本體的孤兒清理另議)。
    // ⚠ 需在 Firebase 規則開放 rooms_index 的讀(大廳)與寫(房主),否則大廳會顯示「偵測失敗」。
    function updateRoomIndex(){
      if(!isHost || !roomRef || !db || !code)return;
      const ids=Object.keys(players);
      let count=ids.length;
      if(!players[meId]) count+=1;   // 房主自己的節點還沒同步回本地時(建房瞬間),也把自己算進去,避免 count=0
      const hostName=(players[meId]&&players[meId].name)||meName||"";
      const sig=roomName+"|"+status+"|"+count+"|"+hostName;
      if(sig===lastIndexSig)return;   // 房名/狀態/人數/房主名都沒變(例如只是線數更新)→ 不寫,省流量
      lastIndexSig=sig;
      db.ref("rooms_index/"+code).update({ name:roomName, status:status, count:count, host:hostName });
    }
    // 房主:掛索引的斷線自動移除,並立即寫一次(建房 / 重連歸位共用)
    function armRoomIndex(){
      if(!isHost || !roomRef || !db || !code)return;
      db.ref("rooms_index/"+code).onDisconnect().remove();
      lastIndexSig=null;   // 強制重寫一次
      updateRoomIndex();
    }

    /* ---------- 熱門度計數 game_stats(v1.112.0)----------
       首頁九張遊戲卡依「這個遊戲被真的玩過幾場」自動排序,資料就只有這一個累加數。
       判定是三個條件同時成立:**只有房主寫**(一場算一次,不是一場算 N 個人)、
       **真的開局才起算**(開了房停在大廳沒打不算)、**撐過 30 秒**(濾掉點錯就退的誤觸)。
       ★ 一間房只記一次,不是一局一次。
       ⚠ 這一段(三支 + 兩個呼叫點)與 js/shared/mp-core.js 是**雙胞胎**:
         Bingo 不載入 js/shared/,所以那邊有逐字對應的一份,改一邊要改另一邊(CLAUDE.md 紅線 4)。
       ⚠ 寫入失敗(規則沒開放 game_stats)一律靜靜吞掉 —— 統計不可以打擾正在玩的人。 */
    const STAT_MS = 30000, STAT_KEY = "bingo";
    let statTimer=null, statDone=false;
    function armPlayCount(){
      if(!isHost || statDone || statTimer || !db) return;
      statTimer=setTimeout(()=>{
        statTimer=null;
        if(!isHost || statDone || !state.online || !db) return;   // 30 秒內就離開 → 這場不算
        statDone=true;
        try{ db.ref("game_stats/"+STAT_KEY+"/n").transaction(n=>(n||0)+1); }catch(e){}
      },STAT_MS);
    }
    function clearPlayCount(){ if(statTimer){ clearTimeout(statTimer); statTimer=null; } }
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
        const cta=joinable ? '<span class="join-cta">加入</span>'
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
    /* 抽一個沒人在用的房號,最多試 tries 次。★★ v1.156.0:在此之前是「撞到重抽**一次**,
       之後不再檢查直接寫」= 二次撞號會把還在打的那一局整包蓋掉。機率極低但單向上升
       (孤兒房沒有自動清理,被佔用的四位碼只會愈來愈多)。
       ⚠ 與 js/shared/mp-core.js 的 pickFreeCode() 是雙胞胎(紅線 5)。 */
    function pickFreeCode(tries){
      code=randomCode(); roomRef=db.ref("rooms/"+code);   // 內部隨機 4 位碼當資料庫鍵值(玩家看不到)
      return roomRef.child("host").once("value").then(snap=>{
        if(!snap.exists()) return true;                   // 沒人用 / 已關閉 → 可以用
        if(tries<=1) return false;
        return pickFreeCode(tries-1);
      });
    }
    function create(name,wantName){
      if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
      const nm=(name||"").trim();
      if(!nm){ flagNameNeeded(); return; }   // 必填暱稱
      meName=nm.slice(0,8); meId=pid(); isHost=true;
      roomName=(wantName||"").trim().slice(0,12) || (meName+"的房間");   // 房名可留空,預設用暱稱
      const QUIET={ __quiet:true };          // 抽不到房號:已經給過訊息,不要再蓋一次
      pickFreeCode(5).then(free=>{
        if(!free){ setMsg("房號一直撞到別人開的房,請再按一次。"); return Promise.reject(QUIET); }
        /* ⚠⚠⚠ 撞到**已關閉**的房間要把殘留欄位清乾淨(v1.147.0)—— pickFreeCode 看的是
           `host` 有沒有值,而關掉的房間 host 正好是空的 → 看起來像沒人用,新房就蓋上去了,
           而 update() 會**留下舊房的 scores** = 新房一開就有人有分數(名字也對得上,
           因為 nm 一起留著),畫面上完全看不出哪裡不對。
           ★ 用「明確列出要清的欄位」而不是 set():留住 roomName / createdAt / scores 這幾筆歷史。
             ⚠ v1.156.0 更正:共用層那一份原本寫的理由是「set() 在二次撞號時會擦掉還在打的
               那一局」,而這一包 payload 本身就會 —— 真正擋住二次撞號的是 pickFreeCode 的迴圈。
           ⚠ 這一段與 js/shared/mp-core.js 的 create() 是雙胞胎(CLAUDE.md 紅線 5)。 */
        return roomRef.update({ players:null, scores:null, hostName:null, closedAt:null, bye:null, rtc:null,
          host:meId, roomName:roomName, target:state.target, size:SIZE, orderMethod:"random",
          scoreMode:scoreMode, winGoal:winGoal,   // 用記住的計分偏好當建房預設
          emotes:null, createdAt:Date.now(),
          // 一局揮發狀態全收在 game(取代舊的散落頂層欄位);rev 由此起算,單調遞增
          game:{ rev:1, status:"lobby", order:null, turnIndex:0, calledList:[], winner:null, rps:null, reveal:null, roundId:null } });
      }).then(()=>{ joinNode(); enterLobby(); armRoomIndex(); })
        .catch(e=>{ if(e===QUIET)return; setMsg("建立房間失敗:"+((e&&e.message)||e)); });
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
        /* ★ 誤按離開的救援(v1.97.0):進大廳之前先把同名的舊成績接回來,免得排行榜先閃一次 0。
           ⚠ v1.183.0 起要**等搶到位子才往下走** —— 搶輸(房間滿了)的話不可以進大廳,
             否則畫面上看起來在房裡、DB 上卻沒有你那一格。 */
        joinNode(
          ()=>{ adoptScore(r,enterLobby); },
          ()=>{ roomRef=null; setMsg("這個房間人滿了(上限 "+MAX_PLAYERS+" 人),請選別間。"); }
        );
      }).catch(e=>setMsg("加入失敗:"+e.message));
    }
    // 從主選單的「現在有人在玩」直接加入:先切到連線畫面,SDK 就緒後才 join。
    // 順序很重要 —— openConnect() 的 then 會 startRoomWatch(),我們的 then 註冊在後面,
    // 所以一定是「掛大廳監聽 → join → enterLobby 卸載監聽」,不會反過來留一條孤兒監聽。
    function joinFromHome(inCode,inName){
      openConnect();
      ensureFirebase().then(()=>join(inCode,$("mpName").value,inName)).catch(()=>{});
    }
    /* ★★★ 入座人數上限(v1.183.0)。Bingo 在此之前是**完全沒有上限**的
       (`js/home-live.js` 的 GAMES 裡它是 `max:0`)。
       使用者:「Bingo 遊戲人數上限設定為 6 個」—— 動機是即時語音:mesh 的連線數是
       N(N−1)/2,6 人是 15 條,再多手機就撐不住(10 人就 45 條)。
       ⚠ 一定要用 **transaction** 搶位,不可以「先 once 讀人數再 update」——
         那擋不住「兩個人同時按加入」的競態(mp-core 的 claimSeat 也是為了這個)。
       ⚠ 這一版**刻意只擋新入座,不擋 resume()**:斷線重連走 armPresence,
         那時自己本來就有位子;硬要在那裡也檢查的話,「斷線超過寬限期 + 房間剛好滿了」
         會變成**回來就被踢出去**,而那個體驗比偶爾多一個人糟得多。
       ⚠ 房主自己也走這一支(create 的 .then)—— 開房時 players 是空的,一定搶得到。 */
    const MAX_PLAYERS = 6;
    function joinNode(done, full){
      if(!roomRef||!meId){ done&&done(); return; }
      roomRef.child("players").transaction(p=>{
        p = p || {};
        if(p[meId]) return p;                                   // 已經在座位上(重連 / 重複呼叫)
        if(Object.keys(p).length >= MAX_PLAYERS) return;        // 滿了 → 中止交易
        p[meId] = { name:meName, lines:0, ready:false };
        return p;
      }, (err, committed)=>{
        if(err || !committed){ full && full(); return; }
        // 搶到位子才掛 onDisconnect(順序不能反:先掛的話搶輸時會留一條孤兒)
        roomRef.child("players/"+meId).onDisconnect().remove();
        /* ⚠ 回到座位就要把自己的 bye 記號清掉(同 armPresence 的理由):留著的話
           「上次是按離開走的」會一直算數,下次真的斷線時房主會用短寬限把這局作廢。 */
        roomRef.child("bye/"+meId).remove();
        done && done();
      });
      // 註:不再於房主斷線時「整房刪除」——短暫切背景改由寬限期+重連歸位處理(見 watchConn/resume);
      //     房主真的離開時 leave() 會把 host 清掉關房(v1.147.0 起**房間資料本身留著**,
      //     給首頁的伺服器狀態面板列「誰開過哪一間」),而沒有 host 的房間大廳清單也不會顯示。
    }

    /* ---------- 誤按離開的救援:同名接續(v1.97.0) ----------
       「不小心離開」在親友聚會很常發生,而三種離開方式原本的下場**完全不同**:
         · 斷線 / 關頁面 / 切 App 太久 → players 被 onDisconnect 移除,而 scores **刻意**
           不掛 onDisconnect → 同一台裝置重進本來就自動接回,一行都不必改
         · 訪客按「離開房間」          → 連 scores 一起刪掉 → **進度真的沒了**(這一版改的就是它)
         · 房主按「離開房間」          → 整間房 remove,沒有東西可以接(這一版刻意不動:
                                        要救它得做「房主轉移」,是另一個量級的改動)
       所以這一版只做兩件事:
         ① 訪客主動離開**不再刪 scores**,只把名字補上去(見 leave())→ 同一台裝置回來自動接回
         ② pid 變了(換裝置 / 清過 localStorage / 隱私視窗)→ 進房時找「名字一樣 + 已經不在
            座位上」的那一筆孤兒紀錄搬過來
       ⚠ 名字寄生在 scores/{pid}.nm,**不新開 DB 節點**:scores 本來就不掛 onDisconnect,
         名字住在裡面連「斷線」那條路徑都留得住,而且 Firebase 規則一個字都不必改。
       ⚠ 只認**不在 players 裡**的紀錄 → 兩個人剛好同名而且都還在房裡,不會互相搶。
       ⚠ 被房主踢掉的人 scores 是**真的刪掉**(見 kick)→ 踢了又自己溜回來不會把成績帶回來。
       ★ 這一組在 js/shared/mp-core.js 另有一份(Bingo 不載入那支)—— 改一邊記得改另一邊。
         守門是 tools/gen-e2e.py 的 REJOIN:同一份 steps 跑 index.html 與 sudoku.html 兩個載體。 */
    function resumeMsg(n){ return "已接回你先前的成績:"+n+" 勝"; }
    function adoptScore(r,done){
      const fin=()=>{ done&&done(); };
      if(!roomRef||!meId){ fin(); return; }
      const ps=(r&&r.players)||{}, sc=(r&&r.scores)||{};
      /* ① 同一台裝置:分數從頭到尾都還在自己那一格(離開時沒刪)→ 一個字都不必寫,報一聲就好。
         ⚠ n===0 不報 —— 「接回 0 勝」等於沒接回,跳一行 toast 只會讓人以為出了什麼事。 */
      const mine=sc[meId];
      if(mine&&typeof mine.n==="number"&&mine.n!==0){ showToast(resumeMsg(mine.n)); fin(); return; }
      // ② pid 變了:名字一樣、已經不在座位上、而且不是自己那一格
      let src=null;
      Object.keys(sc).forEach(id=>{
        if(src||id===meId||ps[id])return;
        const s=sc[id];
        if(s&&s.nm===meName&&typeof s.n==="number"&&s.n!==0) src=id;
      });
      if(!src){ fin(); return; }
      /* 搬移用**整個 scores 節點**的交易(不是兩次 set):中止就什麼都沒發生,
         不會出現「舊的刪了、新的沒寫進去」那種把成績弄丟的中間態。
         ⚠ 老實記一筆:名字比對在這裡與上面的搜尋各一道,**互為多餘**(拿掉任一道另一道會
           接手,行為一個字都不變)→ 單獨突變會存活,守門是 mut-rejoin-e2e.js 那條
           「兩道一起拿掉」。留著兩道是刻意的:交易這一道是唯一擋得住競態的(讀快照到
           寫入之間那個人可能又進房了),搜尋那一道則讓「根本沒有候選」時連交易都不必發。
           **不要因為「單獨拿掉測試不會紅」就刪掉其中一道。** */
      roomRef.child("scores").transaction(s=>{
        if(!s||!s[src]||s[src].nm!==meName)return;                  // 已經被搬走 / 名字對不上 → 中止
        if(s[meId]&&typeof s[meId].n==="number")return;             // 自己已經有分數 → 絕不覆蓋
        // ⚠ 用 delete 不用 `=null`:mock 的 clone 走 JSON.stringify(null 留得住),
        //   真 Firebase 的 null 是刪除 —— 寫 null 會讓測試與現場語意不一樣
        s[meId]=s[src]; delete s[src]; return s;
      },(err,committed)=>{
        if(!err&&committed) showToast(resumeMsg(sc[src].n));
        fin();
      });
    }

    function hidePhasePanels(){
      hideMpVeil();
      $("mpOrderPanel").classList.add("hidden");
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
    // 房主是「取消猜拳回大廳」(不離房,不需確認);訪客是真的離開房間 → 先問一次
    function bailFromRps(){ if(isHost) resetRoomToLobby(); else askLeave(); }
    function enterLobby(){
      state.online=true; ready=false; curPhase="lobby"; sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
      byeIds={}; aloneWaitMs=0; talkingIds=[]; talkingSig="";   // 上一間房「誰按了離開」不可以帶進新房(同 gameRev,見四個寬限期)
      gameRev=0;   // ★ 進新房必歸零:MP 為常駐 IIFE,不重設會把上一間房累積的高 rev 帶進來,害新房快照被 onGame 的「rev<gameRev」全部誤丟 → 加入者卡在大廳、整房卡死
      clearPlayCount(); statDone=false;   // 熱門度計數:一間房記一次 → 進新房要重新起算
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
      /* 房間分享(QR + Web Share)。⚠ 一律 typeof 檢查 —— qr.js 是選配的(同 Talk 的規矩)。
         ⚠ 十三頁的 js/shared/mp-core.js 另有一份平行實作,改一邊記得改另一邊。 */
      if(typeof RoomShare!=="undefined" && RoomShare) RoomShare.setRoom(code, roomName);
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
      armBackGuard(onBackKey);   // 返回鍵:進房後一律先問(冪等,整段房內生命週期只墊一筆歷史)
    }
    /* 訪客:房主不見了的**兩種**情況(v1.166.0 拆開,之前是同一個判斷、同一個寬限):
         · hostClosed() —— host 這個欄位不見了 = 房主按了離開,房是真的關了 → CLOSE_MS 後退出
         · hostAway()   —— host 還在,只是他的 players 那一格被 onDisconnect 移掉 = 切 App / 斷線
                           → 給滿 GRACE_MS,他一分鐘內回來就當沒事(armPresence 會把他寫回來) */
    function hostClosed(){ return !isHost && state.online && sawHost && !hostId; }
    function hostAway(){ return !isHost && state.online && sawHost && sawPlayers && !!hostId && !players[hostId]; }
    function hostGone(){ return hostClosed() || hostAway(); }
    function recheckWait(){ return hostClosed() ? CLOSE_MS : GRACE_MS; }
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
      /* ⚠ 回到座位就要把自己的 bye 記號清掉:留著的話「上次是按離開走的」會一直算數,
         下次真的斷線時房主會用短寬限把這局作廢(resume() 也走這一支 → 回前景就清乾淨)。 */
      roomRef.child("bye/"+meId).remove();
    }
    // 從背景/斷線恢復:進入寬限期並主動把自己寫回(msg 有值才提示,避免只是短暫切前景也跳訊息)
    function resume(msg){
      if(!state.online||!roomRef||!meId)return;
      resyncing=true;
      if(resyncTimer)clearTimeout(resyncTimer);
      resyncTimer=setTimeout(()=>{ resyncing=false; resyncTimer=null; recheckPresence(); }, GRACE_MS);
      const me=players[meId]||{};
      armPresence({ name:meName, lines:me.lines||0, ready:!!ready });   // 保留目前線數/準備狀態
      if(isHost) armRoomIndex();   // 房主重連 → 重掛索引 onDisconnect 並重寫,房間重新出現在大廳
      if(msg)showToast(msg,1500);
      // ★ 重連後重新套用一次 game 快照(v1.177.3):把 resyncing 窗口裡的真相推一次,不必等別人動作
      roomRef.child("game").once("value",s=>onGame(s.val()));
    }
    /* 有人「暫時不見」時,排一個寬限期後的複查。
       ⚠ 已經排了一顆時**只准往前挪、不准往後延**:先看到「房主斷線」(GRACE_MS)、接著才收到
         「房主真的關房」(CLOSE_MS)要照後者立刻走;反過來則不能被拖長,否則每次名單風吹草動
         都重排一次 = 寬限期永遠到不了期。 */
    function scheduleRecheck(ms){
      ms=ms||GRACE_MS;
      const at=Date.now()+ms;
      if(graceTimer && at>=graceAt) return;
      clearRecheck(); graceAt=at;
      graceTimer=setTimeout(()=>{ graceTimer=null; recheckPresence(); }, ms);
    }
    function clearRecheck(){ if(graceTimer){ clearTimeout(graceTimer); graceTimer=null; } graceAt=0; }
    // 遊戲中只剩房主自己:狀態列即時倒數,逾時仍只剩自己就退回大廳(對手若只是短暫斷線,重連歸位會取消)
    // 措辭跟著寬限期走:斷線是「可能會回來」,按了離開是「不會回來了」——現場看得懂在等什麼
    function paintAloneCountdown(sec){
      const el=$("mpStatusTxt"); if(!el)return; el.classList.add("wait");
      el.textContent=(aloneWaitMs<=BYE_MS?"其他玩家都離開了,":"其他玩家都斷線了,")+sec+" 秒後回到等待…";
    }
    /* 剩下的人全都是「自己按了離開房間」走的嗎?(v1.166.0)
       ⚠ 名單用 **order**(這一局的參賽者)而不是 prevIds:prevIds 在同一個回呼裡早就被覆蓋成
         新的一份,問不出「剛剛不見的是誰」。order 為空(還在猜拳)→ 回 false,走保守的長寬限。 */
    function foesByeOnly(){
      const gone=(order||[]).filter(id=>id!==meId && !players[id]);
      return gone.length>0 && gone.every(id=>!!byeIds[id]);
    }
    function scheduleAloneCheck(){
      if(aloneTimer)return;
      aloneWaitMs=foesByeOnly()?BYE_MS:ALONE_MS;
      let left=Math.ceil(aloneWaitMs/1000);
      paintAloneCountdown(left);
      aloneTick=setInterval(()=>{ left--; if(left>0) paintAloneCountdown(left); }, 1000);
      aloneTimer=setTimeout(()=>{
        aloneTimer=null; if(aloneTick){ clearInterval(aloneTick); aloneTick=null; }
        if(isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1) hostAloneToLobby();
      }, aloneWaitMs);
    }
    // bye 記號比 players 的移除晚到 → 把已經在跑的長寬限縮回短的(只縮不放,免得來回重排永遠不到期)
    function retuneAloneCheck(){
      if(!aloneTimer || aloneWaitMs<=BYE_MS || !foesByeOnly())return;
      clearAloneCheck(); scheduleAloneCheck();
    }
    function clearAloneCheck(){ if(aloneTimer){ clearTimeout(aloneTimer); aloneTimer=null; } if(aloneTick){ clearInterval(aloneTick); aloneTick=null; } }
    // 寬限期到期後再確認一次:該離開/回大廳的情況若仍成立,才真的動作
    function recheckPresence(){
      if(!state.online||!roomRef)return;
      if(iWasKicked() && connected){ showToast("你已被房主移出房間"); leave(); return; }
      if(hostGone()){ showToast(hostClosed()?"房主已離開,房間已關閉":"房主斷線太久,房間已關閉"); leave(); return; }
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
    // 離開房間:一律先跳確認小卡(誤觸返回鈕就斷線退出、把整房關掉太痛)。
    // act 可帶入實際要執行的動作(猜拳蓋板走 bailFromRps 的訪客分支),省略就是 leave()
    let pendingLeaveAct=null;
    function askLeave(act){
      if(!state.online){ (act||leave)(); return; }   // 已經不在房裡了 → 沒什麼可確認的,直接做
      pendingLeaveAct=act||leave;
      const inGame = status==="playing" && !winner && !abandoned;
      const t=$("leaveTitle"), m=$("leaveMsg"), b=$("leaveConfirm");
      if(t)t.textContent = inGame ? "遊戲中離開?" : "離開房間?";
      if(m)m.innerHTML = isHost
        ? (inGame ? "你是房主,離開會<b>直接關閉房間</b>,這局大家都玩不完。"
                  : "你是房主,離開會<b>關閉整個房間</b>,其他人都會被退出。")
        : (inGame ? "這局還沒結束,離開就<b>不算你的成績</b>,其他人會繼續玩。"
                  : "確定要離開這個房間嗎?");
      if(b)b.textContent = inGame ? "還是要離開" : "離開房間";
      $("leaveVeil").classList.add("show");
    }
    function closeLeaveAsk(){ pendingLeaveAct=null; $("leaveVeil").classList.remove("show"); }
    function confirmLeave(){ const act=pendingLeaveAct; closeLeaveAsk(); if(act)act(); }
    /* 手機返回鍵在房間裡的行為:有浮層開著就先關浮層(含把離開確認卡本身當「取消」關掉),
       否則跳離開確認 —— 誤按一下就斷線退出、房主還會把整房關掉,太痛。見 game.js 的 armBackGuard */
    function onBackKey(){ if(dismissTopLayer())return; askLeave(); }
    // 房主:把某位玩家移出房間(僅大廳階段,遊戲進行中不動出手順序)
    function kick(id){
      if(!isHost||!roomRef||id===meId)return;
      if(status!=="lobby"){ showToast("遊戲進行中無法移除玩家"); return; }
      const nm=dispName(id);
      roomRef.child("players/"+id).remove();
      roomRef.child("scores/"+id).remove();   // 連同分數一起清,避免殘留(踢人才清;斷線絕不清)
      showToast("已移出 "+nm);
    }
    /* ---------- 即時語音(js/shared/talk.js)----------
       ★★ 這是 CLAUDE.md 紅線 4 的**例外**:UI 與邏輯都住在 talk.js 自己身上,
         所以 Bingo 這邊**不必**再抄一份 —— 只要這幾個掛載點。
         (v1.183.0 把 UI 從 ui-kit.js 收進 talk.js 就是為了這件事。)
       ⚠ 一定要 feature-detect:talk.js 是選配的,直接寫 Talk 在沒載入它的頁面
         會是 ReferenceError,而那會把整個 listen() / leave() 打斷。
       ⚠ 這一段與 js/shared/mp-core.js 的 talkOn() 是**同構的兩份**(紅線 4)——
         改行為要兩邊一起看;但兩邊都只是轉接,真正的邏輯只有 talk.js 一份。 */
    function talkOn(){
      try{ return (typeof Talk !== "undefined" && Talk && Talk.supported()) ? Talk : null; }
      catch(e){ return null; }
    }

    function listen(){
      { const T=talkOn(); if(T) T.attach({
          ref:(path)=>roomRef?roomRef.child(path):null,
          me:()=>meId,
          players:()=>players,
          nameOf:(id)=>dispName(id),
          /* ⚠ 鈕的重畫由 talk.js 自己做;這裡只管晶片列的「說話中」。
             ⚠ 只有真的變了才重畫 —— 這個回呼在有人講話時每 120ms 就可能來一次。 */
          onState:(st)=>{
            const sig=(st&&st.speaking||[]).slice().sort().join(",");
            if(sig!==talkingSig){ talkingSig=sig; talkingIds=(st&&st.speaking)||[]; renderPlayers(); }
          }
        }); }
      roomRef.child("host").on("value",s=>{
        hostId=s.val()||null; if(hostId)sawHost=true;
        if(hostGone()) scheduleRecheck(recheckWait());   // 房主暫時不見 → 進寬限期,期間房主重連歸位就恢復
      });
      /* 誰是「自己按了離開房間」走的(v1.166.0)。⚠ 這一份與 players 是**兩個節點兩個事件**,
         到達順序不保證 → 晚到時要把已經在跑的長寬限縮回短的(retuneAloneCheck)。 */
      roomRef.child("bye").on("value",s=>{ byeIds=s.val()||{}; retuneAloneCheck(); });
      roomRef.child("players").on("value",s=>{
        players=s.val()||{};
        // 有新玩家加入 → 放「加入」音效,讓房內原本的人都知道有人來了(略過自己、進房後的第一次快照,且只在大廳)
        { const ids=Object.keys(players);
          if(prevIds!==null && curPhase==="lobby" && ids.some(id=>id!==meId && prevIds.indexOf(id)<0)) Sound.join();
          prevIds=ids; }
        // 語音的 mesh 要跟著「房裡現在有誰」動(players 是唯一權威來源:斷線由 onDisconnect 從這裡移掉)
        { const T=talkOn(); if(T) T.refresh(); }
        if(Object.keys(players).length) sawPlayers=true;
        if(players[meId]) sawMe=true;
        // 我一直穩定連著卻從名單消失 → 房主真的把我踢了,立即離開;其餘情況一律交給寬限期
        if(iWasKicked() && stableOnline()){ showToast("你已被房主移出房間"); leave(); return; }
        // 「暫時不見」(我/房主消失,或遊戲中房主只剩自己):寬限期內先不動作,等重連歸位;全部正常則解除寬限
        const alone=isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1;
        if(alone) scheduleAloneCheck(); else clearAloneCheck();   // 只剩房主 → 走專用寬限(對手按離開的話較短)
        if(iWasKicked() || hostGone()) scheduleRecheck(recheckWait()); else clearRecheck();
        renderPlayers(); updateStartBtn();
        if(isHost) updateRoomIndex();   // 人數/房主名變動 → 同步大廳輕量索引(sig 去重,線數變動不會觸發寫入)
        if(curPhase==="lobby") syncScoreRow();   // 分數變動(重設戰績/開新賽季)→ 重新評估目標勝場鎖定狀態
        if(curPhase==="rps"){ renderRps(); if(isHost)rpsHostResolve(); }
        else if(curPhase==="ordering") renderOrderPanel();
        else if(curPhase==="playing"){
          skipMissingTurn();   // 輪到的人暫時不見 → 跳過他(見該函式:另一處呼叫在 enterPlaying)
          updateTurnUI();
          if(winner) showOutcome();   // 補算平手(對手的 winAt 可能晚一步才傳到)
        }
      });
      // 一局揮發狀態:單一 game 節點、單一監聽。取代舊的 status/order/turnIndex/calledList/rps/reveal/winner/roundId 八個 child 監聽,
      // 消除「跨欄位事件到達順序不保證」的隱式時序假設;過期快照(rev 更舊)於 onGame 內丟棄。
      roomRef.child("game").on("value",s=>onGame(s.val()));
      roomRef.child("target").on("value",s=>{ const t=s.val(); if(typeof t==="number"){ if(!isHost){ state.target=t; $("targetVal").textContent=t; } updateMpGoal(); } });
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
      // fallback 對齊預設值(v1.36.3;原為 "host" —— 與建房寫入的預設不一致,節點缺失時房主與訪客會看到不同選項)
      roomRef.child("orderMethod").on("value",s=>{ orderMethod=s.val()||"random"; syncOrderSeg(); });
      // 連線計分:模式 / 搶勝目標(roundId 已併入 game 節點,不再獨立監聽)
      roomRef.child("scoreMode").on("value",s=>{ scoreMode=(s.val()==="match")?"match":"rank"; syncScoreRow(); renderPlayers(); });
      roomRef.child("winGoal").on("value",s=>{ const n=s.val(); winGoal=(typeof n==="number"&&n>=2)?Math.min(20,n):3; syncScoreRow(); });
      // 連線計分:分數存獨立路徑 scores/<id>={n,round},不掛 onDisconnect,斷線/切背景都刪不到
      roomRef.child("scores").on("value",s=>{ scores=s.val()||{};
        if(curPhase==="lobby") syncScoreRow();   // 分數變動 → 重評「搶勝目標」鎖定
        renderPlayers();                          // 晶片上的 🏆N 徽章
        if(winner) renderScoreboard();            // 結果卡開著時同步排行
      });
    }

    function renderPlayers(){
      const box=$("mpPlayers"); if(!box)return; box.innerHTML="";
      // 玩家晶片一律單列橫捲(不換行):房間橫幅高度固定在一列,人再多也不會往下長、
      // 吃掉號碼格的縱向空間 —— 縱向空間優先給數字牌。實測 6 人換行時橫幅會漲到 244px,
      // 比號碼格本身(210px)還大。橫捲不影響點晶片傳表情,也不影響房主的移出鈕 ✕。
      box.classList.add("oneline");
      const ids=Object.keys(players);
      // 確認框開著時,若對象已離開或已不在大廳,直接收掉避免踢到空氣
      if(pendingKickId && (status!=="lobby" || !players[pendingKickId])) closeKick();
      ids.forEach(id=>{
        const p=players[id]||{};
        const isTurn=status==="playing"&&order.length>0&&order[turnIndex]===id;
        const chip=document.createElement("div");
        // tk-talking:那個人正在說話(即時語音);沒開語音時 talkingIds 永遠是空的
        chip.className="mp-chip clickable"+(p.ready?" ready":"")+(id===meId?" me":"")+(isTurn?" turn":"")
                      +(talkingIds.indexOf(id)>=0?" tk-talking":"");
        chip.dataset.id=id;                                  // 供表情動畫定位到該玩家晶片
        chip.title=id===meId?"點一下傳送互動表情給全部人":"點一下傳送互動表情";
        chip.addEventListener("click",()=>openEmote(id===meId?"all":id));   // 點對象 → 開表情面板
        const seatIdx=order.indexOf(id);
        const seatBadge=(status==="playing"&&seatIdx>=0)?'<span class="seat-badge">'+(seatIdx+1)+'</span>':'';
        const sc=scoreOf(id);
        const scoreBadge=sc>0?'<span class="score-badge" title="累積勝場">🏆'+sc+'</span>':'';   // 有累積勝場才顯示,大廳/遊戲中都看得到
        chip.innerHTML='<span class="dot"></span>'+seatBadge+'<span>'+esc(dispName(id))+'</span>'+youTag(id)+scoreBadge+
          (status==="playing"?'<span class="ln">'+(p.lines||0)+'線</span>':'');   // 互動 😀 提示已移除;改由房間框的專用表情鈕進入
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
      // 單列橫捲時把「輪到誰」的晶片滑到中間:人多時不用自己左右撥就看得到換誰
      if(box.classList.contains("oneline")){
        const t=box.querySelector(".mp-chip.turn");
        if(t&&t.scrollIntoView){ try{ t.scrollIntoView({block:"nearest",inline:"center",behavior:"smooth"}); }catch(e){} }
      }
      const subrow=$("mpSubrow");
      if(aloneTick){ if(subrow)subrow.classList.remove("hidden"); /* 房主落單倒數中:副標列交給倒數顯示,不覆蓋 */ }
      else if(status==="playing"){ updateTurnUI(); }   // 遊戲中:副標列整列收起(換誰改看高亮的玩家晶片)
      else {
        if(subrow)subrow.classList.remove("hidden");
        const st=$("mpStatusTxt"); st.classList.remove("wait");
        st.textContent = status==="rps"?"猜拳決定順序…":(status==="reveal"?"猜拳結果揭曉…":(status==="ordering"?"排定順序中…":(ids.length<2?"等待對手加入…":"等待大家準備…")));
      }
      updateMpGoal();
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
      // v1.36.2:獨立的「換一組」鈕已移除(併回「自動填號」),鎖定只需擋整條填號方式列 + 盤面
      $("fillSeg").style.pointerEvents=lock?"none":"";
      grid.style.pointerEvents=lock?"none":"";
      // 準備好了 / 遊戲進行中:收起「填號方式」列(取消準備會再顯示);切分頁時 applyRoomTab 也會依 amReady 重算
      // 進遊戲時 enterPlaying 會呼叫 setLock(false) 解鎖盤面,但填號方式列在遊戲中一律不該再出現,故用 state.mode==="play" 一併收起
      $("fillRow").classList.toggle("tab-hidden", state.mode==="play" || lock || (typeof roomTab!=="undefined" && roomTab==="settings"));
      if(typeof syncFillSeg==="function") syncFillSeg();
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
      scoredThisRound=false;
      /* ★ v1.97.0:整份清掉,不再只清「現在還在座位上的人」——
         誤按離開的人留下的離席紀錄也是戰績,漏清的話重設完他回來又把舊分數接回去。 */
      roomRef.child("scores").remove();
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
      // 清掉上一局每位玩家的達標紀錄與線數(per-player,獨立節點;分數存 scores/,不隨開新局清除)
      const pups={}; Object.keys(players).forEach(id=>{ pups["players/"+id+"/winAt"]=null; pups["players/"+id+"/lines"]=0; });
      if(Object.keys(pups).length) roomRef.update(pups);
      // 本局揮發狀態一次原子寫入 game 節點(帶新 rev)。舊版「拆三次寫 / 先寫 null / enterPlaying 重讀」的 workaround 全數不再需要:
      //   • 單一節點 → 清殘局(calledList/winner)與 status 一次到齊,不會「status 先到、用殘局重算而秒判勝利」(舊陷阱一);
      //   • rev 每局遞增 → 即使洗出的順序與上一局相同,節點值仍變化、value 事件必觸發,不會卡在舊 order(舊陷阱二)。
      const base={ status:"lobby", order:null, turnIndex:0, calledList:[], winner:null, rps:null, reveal:null, roundId:Date.now() };   // roundId 每局換,供「一局只計一次分」判定
      if(orderMethod==="rps"){
        setGame({ ...base, status:"rps", rps:{ seq:1, groups:[ids.join(",")], throws:null } });
      }else if(orderMethod==="random"){
        const ord=ids.slice();
        for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; }
        setGame({ ...base, status:"playing", order:ord });
      }else{
        setGame({ ...base, status:"ordering" });
      }
    }

    /* ----- game 節點:單一版本化狀態的寫入輔助 + 派發 ----- */
    /* ⚠⚠⚠ **離線期間一律不寫 game**(v1.177.3;與 js/shared/mp-core.js 的 canWriteGame 逐字平行)。
       Firebase 的寫入 / 交易在離線時會**先套用到本地快取**、照樣發 value 事件 → onGame 把
       gameRev 一路墊高,比伺服器高;回線之後這些交易被伺服器退回,退回來那一份的 rev
       **比本地小** → 撞上 `rev<gameRev` 被靜靜丟掉,這台就永遠停在一個伺服器上不存在的
       幻影狀態(暗棋現場回報的症狀是「一個人斷線回來,兩個人都動不了、也都不報錯」)。
       ⚠ connected===null(還沒問到 .info/connected)一律放行 —— 只擋**明確知道斷線**的時候。 */
    let offToastAt=0;
    function canWriteGame(){
      if(!roomRef)return false;
      if(connected===false){
        const t=Date.now();
        if(t-offToastAt>=3000){ offToastAt=t; showToast("連線中斷,正在重新連線…",2000); }
        return false;
      }
      return true;
    }
    // 房主推進相位:覆寫整個 game 節點(開新局 / 全清回大廳),單一原子寫入 + 新 rev。
    function setGame(g){ if(!canWriteGame())return; g.rev=gameRev+1; roomRef.child("game").set(g); }
    // 房主推進相位:只改部分欄位(其餘保留;update 為合併,不會清掉未列出的欄位),同時遞增 rev。
    function patchGame(p){ if(!canWriteGame())return; p.rev=gameRev+1; roomRef.child("game").update(p); }
    // 需原子遞增 rev 的多寫者操作(叫號 tap、達標 tryWin、跳過斷線者):用 transaction 避免併發覆蓋。
    // mut(g) 直接改 g;回傳 false 代表中止交易(不寫,例如號碼已被叫過、已有贏家)。
    function txGame(mut){
      if(!canWriteGame())return;
      roomRef.child("game").transaction(g=>{
        if(!g)return;                   // 節點不存在/尚未快取 → 回傳 undefined 中止交易(勿回傳 null,那會寫入 null 刪掉節點)
        if(mut(g)===false)return;       // mut 要求中止(號碼已被叫過、已有贏家等)→ 中止,不寫
        g.rev=(g.rev||0)+1;
        return g;
      });
    }
    // 收到 game 快照:rev 更舊 → 過期,丟棄;否則套用整包狀態並派發到對應相位。
    // 取代舊的 8 個 child 監聽,所有欄位一次到齊,不再有「跨欄位事件到達順序」問題;
    // 同 rev 的中途更新(如猜拳逐一出拳、平手重猜)rev 不變,仍會套用(判斷用 < 而非 <=)。
    function onGame(g){
      g=g||{};
      const rev=(typeof g.rev==="number")?g.rev:0;
      /* 過期快照丟棄 —— **但重連歸位的那一段窗口(resyncing)例外**:伺服器把離線期間的
         樂觀交易退回來時,退回來的那一份 rev 一定**比本地小**,照丟就永遠停在幻影狀態
         (見上面 canWriteGame)。第一道保險(離線不寫)擋不住「.info/connected 還沒察覺
         斷線」的那幾十秒,只有這裡收得回來。 */
      if(rev<gameRev && !resyncing)return;
      gameRev=rev;
      order=g.order||[]; turnIndex=g.turnIndex||0; calledList=g.calledList||[];
      rps=g.rps||null; revealData=g.reveal||null; roundId=g.roundId||null;
      const nextWinner=g.winner||null, nextStatus=g.status||"lobby";
      const statusChanged=(nextStatus!==status), hadWinner=!!winner;
      winner=nextWinner; status=nextStatus;   // 先更新模組值,讓 onStatus/showOutcome 讀到正確 winner/status
      onStatus();                        // 相位派發(可能觸發 enter*/backToLobby);完成後 curPhase===status
      // 目前相位的即時內容更新(對應舊 child 監聽的即時渲染)
      if(curPhase==="rps"){ renderRps(); if(isHost)rpsHostResolve(); }
      else if(curPhase==="reveal"){ renderReveal(); }
      else if(curPhase==="playing"){ onCalled(); maybeAnnounceOrder(); }
      // winner 邊緣:剛出現/仍在 → 揭曉結果(showOutcome 內含 outcomeShown 去重,補算平手安全);剛清掉 → 收結果卡
      if(winner) onWinner();
      else if(hadWinner) closeWin();
      if(statusChanged && isHost) updateRoomIndex();   // 大廳/對戰中 狀態變動 → 同步大廳輕量索引
    }

    /* ----- phase dispatch ----- */
    function onStatus(){
      renderPlayers();
      // status 是 playing 但盤面還沒真的進遊戲(state.mode 不是 play)也要 enterPlaying:
      // 保險涵蓋 curPhase 因殘留/漏事件停在 "playing" 而略過 enterPlaying、導致盤面沒解鎖/沒重繪的情況。
      if(status==="playing"){ if(curPhase!=="playing"||state.mode!=="play") enterPlaying(); else updateTurnUI(); }
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
      $("mpOrderPanel").classList.add("hidden");
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
      roomRef.child("game/rps/throws/"+meId).set({ c:c, s:seq });   // 猜拳出拳:同 rev 的中途更新,onGame 照常套用(不遞增 rev)
    }
    function rpsHostResolve(){
      if(!isHost||!rps||status!=="rps")return;
      if(rps.tie)return;                 // 平手揭曉中,等房主的計時器帶進下一輪,先不判定
      const seq=rps.seq||1;
      const throws=rps.throws||{};
      let groups=(rps.groups||[]).map(g=>String(g).split(",").filter(id=>players[id])).filter(g=>g.length>0);
      const pending=groups.filter(g=>g.length>1).reduce((a,g)=>a.concat(g),[]);
      if(pending.length===0){
        patchGame({ order:groups.reduce((a,g)=>a.concat(g),[]), turnIndex:0, status:"playing", rps:null });
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
        // 先把分組結果寫進去(已定案的人變單獨一組),並保留 throws/seq 讓平手的人看到彼此出了什麼。
        // 這些都是 rps 相位內的中途更新(同 rev),onGame 照常套用;不遞增 rev。
        roomRef.child("game/rps").update({ groups:nextGroups, tie:true });
        tieTimer=setTimeout(()=>{
          tieTimer=null;
          roomRef.child("game/rps").update({ seq:seq+1, throws:null, reveal:acc, tie:null });
        }, 1500);
      }else{
        // 定案 → 先進入過場揭曉(帶著大家的出拳與最終順序),再由房主自動開打
        const finalOrder=newGroups.reduce((a,g)=>a.concat(g),[]);
        patchGame({ status:"reveal", order:finalOrder, turnIndex:0, rps:null, reveal:{ throws:acc, order:finalOrder } });
      }
    }

    /* ----- reveal: 猜拳過場,揭曉大家出了什麼 ----- */
    function enterReveal(){
      state.mode="setup";
      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 猜拳揭曉:收起房間分頁列
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      $("mpOrderPanel").classList.add("hidden");
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
      // 揭曉畫面所有人都能按「跳過」+ 房主計時器 = 多寫者;用 txGame 交易確保只從 reveal→playing 推進一次(非房主單寫者)
      txGame(g=>{ if(g.status!=="reveal")return false; g.status="playing"; g.reveal=null; });
    }

    /* ----- host manual ordering ----- */
    function enterOrdering(){
      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 房主排順序:收起房間分頁列
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      hideMpVeil();
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
      patchGame({ order:ord, turnIndex:0, status:"playing" });
    }

    /* ----- playing (turn-based manual call) ----- */
    function enterPlaying(){
      state.mode="play"; state.won=false; state.lastLines=0; state.marked=Array(nCells()).fill(false);
      myWinAt=null; outcomeShown=false; orderAnnounced=false; reachAnnounced=false; abandoned=false; scoredThisRound=false; wasMyTurn=false;
      if(reachClipTimer){ clearTimeout(reachClipTimer); reachClipTimer=null; }   // 清掉上一局殘留的聽牌合併計時器

      $("setup").classList.add("hidden"); $("setupActions").classList.add("hidden");
      updateRoomTabs(false);   // 進遊戲:收起房間分頁列,棋盤佔滿
      $("playStatus").classList.add("hidden");
      hideMpVeil(); $("mpOrderPanel").classList.add("hidden");
      $("mpOrderRow").classList.add("hidden");
      $("scoreRow").classList.add("hidden");
      updateMpGoal();   // 目標線數顯示在房間框
      setLock(false);
      resetMarquee(); render(); applyCalledMarks(); updateTurnUI(); refreshLines();
      armPlayCount();   // 熱門度計數:從「真的開局」這一刻起算 30 秒(見上面那段)
      maybeAnnounceOrder();
      skipMissingTurn();   // 開局那一刻若 order[0] 已經離開,這裡是唯一還會檢查的地方(見該函式 ②)
      // (舊版此處有「order 停在 [] 就主動重讀 DB」的補救,因應舊拆分寫入被 coalesce 吃掉 order 事件。
      //  改用單一 game 節點 + rev 後,order 與 status 一定在同一快照原子到齊,補救不再需要,已移除。)
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
    /* 輪到的人暫時不見 → 跳過他,免得整局卡死。不在斷線寬限期內才跳(寬限中先等他重連歸位,
       不亂動出手順序);只有房主推進,用 txGame 交易避免與別人的叫號互相覆蓋。
       ★ 要在**兩處**呼叫(v1.74.0 補的是第二處):
         ① players 快照變動時 —— 遊戲中有人離開。
         ② 剛進 playing 時 —— startGame() 是拿 `Object.keys(players)` 洗牌的,若洗牌那一刻
            有人已經關掉分頁/切到別的 App,他照樣被洗進 order、甚至洗到第一位;而他的
            onDisconnect 移除事件若在「本端 curPhase 還沒變成 playing」之前就到了,
            那一次 players 事件走的是 lobby 分支、不會檢查 → 之後 players 再也不變動,
            **沒有任何地方會再檢查**,order[0] 指著一個不存在的玩家 → 全房誰都輪不到。
            隨機順序特別容易中:它從 lobby 直接跳 playing,中間沒有 rps/reveal 那幾秒過場。 */
    function skipMissingTurn(){
      if(!isHost || !order.length || graceTimer) return;
      if(players[order[turnIndex]]) return;            // 輪到的人還在 → 什麼都不用做
      txGame(g=>{ if(g.status!=="playing"||g.winner)return false; g.turnIndex=nextTurn(g.turnIndex||0, g.order||[]); });
    }
    // 下一位仍在線的玩家索引。ord 可傳入(txGame 交易內用交易當下的 g.order,避免與模組值不一致);省略則用模組 order。
    function nextTurn(from, ord){
      ord = ord || order;
      if(!ord.length)return from;
      let i=from;
      for(let k=0;k<ord.length;k++){ i=(i+1)%ord.length; if(players[ord[i]])return i; }
      return from;
    }
    // 目標線數顯示在房間框(大廳/遊戲中都顯示)
    function updateMpGoal(){ const g=$("mpBarGoal"); if(g)g.textContent = state.target ? ("🎯 "+state.target+" 線") : ""; }
    // 輪到誰:遊戲中不再用文字寫「輪到 X / 換你出號」——換誰改看高亮脈動的玩家晶片(.turn)+ 自己盤面亮起的可點格;
    // 副標列整列收起,替下方號碼格讓出縱向高度(落單倒數中則由倒數接管,不動)
    function updateTurnUI(){
      if(status!=="playing" || aloneTick)return;
      notifyMyTurn();
      const subrow=$("mpSubrow"); if(subrow)subrow.classList.add("hidden");
    }
    // 換我出號了:偵測「不是我 → 是我」的邊緣,只提示一次(清亮提示音 + 可選震動)。
    // 震動於 iOS Safari 不支援(navigator.vibrate 不存在)→ 自動略過;vibrateOn 由設定頁開關(game.js)。
    function notifyMyTurn(){
      const mine=isMyTurn();
      if(mine && !wasMyTurn){
        try{ Sound.turn(); }catch(e){}
        if(typeof vibrateOn!=="undefined" && vibrateOn && navigator.vibrate){ try{ navigator.vibrate([90,60,90]); }catch(e){} }
      }
      wasMyTurn=mine;
    }
    function tap(i){
      /* 相位自我修復(v1.74.0):DB 說已經在 playing、盤面卻還沒進 play 模式。
         這種不一致時,玩家晶片照 order/turnIndex 高亮成「輪到你」(renderPlayers 不看 state.mode),
         但號碼格還是大廳的預覽格 → 使用者看到的就是「輪到我卻點不動」。
         onStatus() 的條件(curPhase!=="playing" || state.mode!=="play")理應涵蓋這種情況,
         這裡是**最後一道**:既然點得到這一格,就趁這個手勢把盤面補進遊戲再判斷這一手,
         而不是靜靜地什麼都不做。(與 game.js auto preview 分支不再 disabled 是一組的。) */
      if(status==="playing" && state.mode!=="play"){ enterPlaying(); }
      if(!isMyTurn()){ showToast("還沒輪到你"); return; }
      const n=state.card[i]; if(!n)return;
      if(isCalled(n))return;
      Sound.place();
      // 叫號:交易內原子地加號碼、推進 turnIndex、遞增 rev(多寫者安全:即使兩端同時點也不會覆蓋彼此)
      txGame(g=>{
        if(g.status!=="playing")return false;
        const cl=g.calledList||[];
        if(cl.indexOf(n)>=0)return false;   // 已被叫過(重複點/競態)→ 中止
        g.calledList=cl.concat(n);
        g.turnIndex=nextTurn(g.turnIndex||0, g.order||[]);
      });
    }
    function onCalled(){
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
      // 記錄「自己在第幾次叫號時達標」;同一次叫號同時達標 = 平手(見 showOutcome)。winAt 是 per-player 節點,獨立寫。
      if(myWinAt===null){ myWinAt=calledList.length; if(meId)roomRef.child("players/"+meId+"/winAt").set(myWinAt); }
      // winner 收進 game 節點:交易確保只有第一位達標者寫得進(已有 winner 則中止),並原子遞增 rev
      txGame(g=>{ if(g.winner)return false; g.winner={ id:meId, name:meName, lines:done, at:myWinAt }; });
    }
    // 聽牌廣播:本端(game.js refreshLines)偵測到自己只差一號就達標時呼叫。一局只播一次(reachAnnounced 去重)。
    // 廣播對象為全部人,且 handleEmote 對 kind==="reach" 會「連自己也播」→ 聽牌者本人也聽得到「聽牌」語音。
    function reportReach(){
      if(reachAnnounced || status!=="playing" || winner)return;
      reachAnnounced=true;
      sendEmote("all", "🀄", "reach");
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
          /* ★ nm 是「誤按離開後同名接續」用的(v1.97.0,見 adoptScore)。
             寫在**得分的那一刻**而不是離開的時候 —— 斷線是沒有機會執行程式碼的
             (onDisconnect 只能寫預先講好的值),名字要早一點放進來才留得住。 */
          return { n:((s&&s.n)||0)+1, round:roundId, nm:meName }; // s=null 時自然建立 {n:1,...}
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
      // per-player 與 emotes 是獨立節點,一起清;本局揮發狀態用 setGame 整包覆寫回大廳(帶新 rev)
      const ups={ emotes:null };
      Object.keys(players).forEach(id=>{ ups["players/"+id+"/lines"]=0; ups["players/"+id+"/ready"]=false; ups["players/"+id+"/winAt"]=null; });
      roomRef.update(ups);
      setGame({ status:"lobby", calledList:[], winner:null, order:null, turnIndex:0, rps:null, reveal:null, roundId:null });
      backToLobby();
    }
    // 「再一局」= 每位玩家各自決定要不要續玩(房主或訪客皆可按):只把自己帶回大廳重新準備,不強拉別人。
    // 第一個按的人負責把房間 status 翻回 "lobby";其餘本局資料(calledList/winner/order/winAt)留到下一局 startGame 才清,
    // 才不會把還在看結果的人的結果卡弄壞(winner 一旦被清,他們的結果卡就會被 onWinner 收掉)。
    // 各玩家的 ready 已在 showOutcome(本局結束當下)各自設為 false,故回大廳後都要重新按準備,房主才能開始。
    function again(){
      if(!roomRef)return;
      // 只翻 status 回 lobby(保留 winner 等本局資料,才不會弄壞還在看結果的人的結果卡);其餘欄位留到下一局 startGame 才清。
      // again 房主/訪客皆可按 = 多寫者;用 txGame 而非 patchGame,多人同按時交易確保 rev 原子遞增、收斂一致
      if(status!=="lobby") txGame(g=>{ if(g.status==="lobby")return false; g.status="lobby"; });
      backToLobby();
    }
    function backToLobby(){
      ready=false; state.mode="setup"; state.won=false; state.fill="auto"; state.card=shuffled(); curPhase="lobby";
      clearAloneCheck();
      order=[]; turnIndex=0; rps=null; myWinAt=null; outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false; wasMyTurn=false;
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
      resetMarquee();   // 回大廳:跑馬燈變回招牌(全亮),不留上一局的線數
      setLock(false); updateReadyBtn(); render(); applyFillUI();
    }
    function leave(){
      /* ★★★ 語音要**第一個**拆,而且一定要在 roomRef 還在的時候:talk.js 的 stop()
         要自己 off 掉 rtc/{我}/{每個人} 底下的子節點監聽並把信箱 remove 掉 ——
         下面那一圈 off() 只收得到 roomRef.child("rtc") 本身,收不到子節點。
         漏掉 = 離開房間後還在收上一間的 SDP,而且麥克風不會關(錄音指示燈一直亮)。 */
      { const T=talkOn(); if(T) T.stop(); }
      try{
        if(roomRef){
          ["host","players","game","target","size","orderMethod","scoreMode","winGoal","scores","emotes","bye","rtc"].forEach(k=>roomRef.child(k).off());
          if(isHost){
            if(meId) roomRef.child("players/"+meId).onDisconnect().cancel();
            roomRef.onDisconnect().cancel();
            if(db&&code){ const ix=db.ref("rooms_index/"+code); ix.onDisconnect().cancel(); ix.remove(); }   // 連同大廳索引一起移除
            /* ★★★ v1.147.0:房主離開**不再刪掉整間房**(舊版是 roomRef.remove())。
               使用者:「房主正常關掉的話…我希望不要回收,我要留著這樣才有辦法看到你是誰開的房間」。
               ★★ 「這間房關掉」沒有變(CLAUDE.md 紅線 5)—— 關房的訊號一直是 **host 不見了**:
                 join() 看 `!r.host` 說「已經關閉」,還在房裡的訪客看 hostGone() 被退出。
               ⚠ 只留身分與歷史(roomName / createdAt / scores + hostName / closedAt),
                 live 的三包(host / players / game)照樣清掉;hostName 一定要在這裡補,
                 因為 host 只有 pid 而 players 馬上要清掉。
               ⚠ 這一段是**雙胞胎**,js/shared/mp-core.js 的 leave() 有對應的一份(紅線 5)。
               ⚠⚠ v1.156.0 起共用層那一份多一圈 `A.extraNodes` 的清理(數獨/消消樂的 progress、
                 台灣麻將的 tai、你畫我猜的 ink/say)—— Bingo **沒有** extraNodes 這個概念
                 (它的房內節點就是上面那幾個固定欄位),所以這一份刻意不加。
                 這是那一對雙胞胎目前唯一該有的差異,不是漏改。 */
            roomRef.update({ host:null, players:null, game:null, bye:null, rtc:null,
                             hostName:meName||"", closedAt:Date.now() });
          }else if(meId){
            const pr=roomRef.child("players/"+meId);
            /* ★ v1.166.0:先留下「我是自己按離開的」記號,再把自己移掉。
               斷線的寬限期拉到一分鐘之後,房主分不出「對手切去 LINE」與「對手不玩了」就只能一律等滿
               —— 這一筆就是差別:當事人還連著的時候自己寫的,看到就等於確定(見檔頭四個寬限期)。
               ⚠ 順序不能反:先 remove 再寫 bye 的話,節點都不在了還替他長回一格 bye 出來。
               ⚠ 記號由 armPresence 清掉(不是這裡),不然自己又溜回來時它會一直算數。 */
            roomRef.child("bye/"+meId).set(true);
            pr.onDisconnect().cancel();
            pr.remove();
            /* ★★ v1.97.0:**不再刪掉自己的分數**(舊版是 scores/{meId}.remove())——
               誤按一下就把整場成績歸零太痛,而斷線那條路徑本來就留著、兩種離開下場不一致。
               留下的那一筆就是「離席紀錄」:同一台裝置回來自動接回,換了裝置靠名字認領
               (見 adoptScore)。
               ⚠ 這裡順手把 nm 更新成現在的名字 —— 得分時就寫過一次了,但那可能是幾局前的舊名。
               ⚠ 用交易而不是 update:一分都沒得過的人節點不存在 → 中止,不要生出一堆只有 nm 的空紀錄。
               ⚠ 房主**不走這裡**(上面那條整間房 remove,沒有東西留得下來)。 */
            roomRef.child("scores/"+meId).transaction(s=>{
              if(!s||typeof s.n!=="number")return;
              s.nm=meName; return s;
            });
          }
        }
      }catch(e){}
      stopConn(); clearRecheck(); clearAloneCheck(); clearPlayCount();   // 卸載連線監聽、清掉寬限計時器
      resyncing=false; if(resyncTimer){ clearTimeout(resyncTimer); resyncTimer=null; }
      sawPlayers=false; sawMe=false; sawHost=false; hostId=null; byeIds={}; aloneWaitMs=0; talkingIds=[]; talkingSig="";
      roomRef=null; code=null; state.online=false; ready=false; winner=null; status="lobby"; players={}; scores={}; calledList=[];
      order=[]; turnIndex=0; rps=null; curPhase="lobby"; myWinAt=null; outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false; wasMyTurn=false; lastIndexSig=null; gameRev=0;
      revealData=null; revealSig=""; if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; }
      tieSig=""; if(tieTimer){ clearTimeout(tieTimer); tieTimer=null; }
      emotesReady=false; closeEmote();
      closeLeaveAsk(); closeKick();   // 離開/被踢/房主關房都可能在確認卡開著時發生 → 一併收掉,不留孤兒蓋板
      disarmBackGuard();   // 已經不在房裡:守衛連同它墊的那一筆歷史一起收掉(不然返回鍵要多按一次)
      document.body.classList.remove("mp-on"); resetQuickVoiceBtn();   // 離線:重置快速語音鈕狀態
      if(typeof RoomShare!=="undefined" && RoomShare) RoomShare.setRoom(null);   // 收掉邀請鈕與 QR 蓋板
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
      const isText=kind==="text", isVoice=kind==="voice", isClip=kind==="clip", isReach=kind==="reach";
      const ref=roomRef.child("emotes").push();
      const rec={ from:meId, to:to||"all", kind:isVoice?"voice":(isClip?"clip":(isReach?"reach":(isText?"text":"emoji"))), at:firebase.database.ServerValue.TIMESTAMP };
      if(isVoice){ rec.emoji="🎤"; rec.audio=String(audio||""); }              // 即時語音:emoji 當顯示圖示,音訊放 audio(base64)
      else if(isClip){ rec.emoji="🔊"; rec.clip=String(audio||"").slice(0,40); } // 語音短訊:只傳代號(clip),對方播本地 m4a;emoji 供舊版客戶端降級顯示
      else { rec.emoji=String(emoji).slice(0,isText?24:8); }
      ref.set(rec);
      ref.onDisconnect().remove();
      setTimeout(()=>{ try{ ref.remove(); }catch(e){} }, isVoice?15000:6000);   // 秀完自動清掉;語音較大多給時間,clip 只是代號比照一般表情 6 秒
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
      if(e.kind==="clip"){
        showEmote("🔊", fromNm+" → "+toNm, (to!=="all")?to:e.from, "voice");
        // 語音短訊:依代號播本地 m4a(沿用語音佇列)。★ v1.69.0 起「自己送的也播」——
        // 按了罐頭卻一點聲音都沒有,現場的反應是「是不是沒送出去?」而再按一次。
        // 與即時語音(上面那段)刻意不同:那是自己剛講完的話,回放只是多聽一次。
        // 條件是 mine||forMe 而不是 forMe:送給某一個人時 forMe 為 false,但送出者本人要聽到。
        if(mine || forMe) enqueueClip(e.clip);
        return;
      }
      if(e.kind==="reach"){                          // 有人聽牌:全部人(含聽牌者本人)都播「聽牌」語音
        const who=mine?"你":dispName(e.from);
        showEmote("🀄", who+" 聽牌了!", e.from, "voice");   // 視覺氣泡各自落在對應晶片(顯示誰聽牌)
        // 語音合併:同一次叫號可能多人「一起」達成聽牌,各端會連收好幾則 reach。
        // 用一個短延遲把這一波合併成單次播報 —— 第一則排程計時器,期間內後續的都併掉,不重播。
        if(!reachClipTimer){
          reachClipTimer=setTimeout(()=>{ reachClipTimer=null; enqueueClip("reach"); }, 600);
        }
        return;                                      // 刻意不排除 mine → 聽牌者自己也聽得到(合併後仍會播到)
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

    // ensureLib / database / configured 是給首頁看板(js/home-live.js)用的:它要讀三個大廳索引,
    // 但不該自己再抄一份「動態載入 SDK + initializeApp」——那是這裡唯一的入口。
    // ★ configured 是 configReady(只問 config 填了沒),不可以拿 available 當守門 ——
    //   available 還要求「SDK 已載入」,而首頁本來就還沒載(v1.52.1 修:看板因此永遠不啟動)。
    return { available, configured:configReady, ensureLib:ensureFirebase, database:()=>init()?db:null, joinFromHome,
             openConnect, closeConnect, create, join, scanRooms, toggleReady, startGame,
             setTarget, setOrderMethod, throwRps, confirmOrder, again, leave,
             reportLines, tryWin, reportReach, readyEnabled, isMyTurn, isCalled, tap,
             amHost, amReady:()=>ready, setSize:setBoardSize, roster, sendEmote, revealSkip, bailFromRps,
             confirmKick, cancelKick:closeKick, refreshHint:mpHint,
             askLeave, confirmLeave, cancelLeave:closeLeaveAsk,
             setScoreMode, setWinGoal, resetScores, winGoal:()=>winGoal, scoreMode:()=>scoreMode, usePrefs };
  })();

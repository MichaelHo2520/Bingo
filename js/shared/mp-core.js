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
   8. 離線期間**一個字都不准寫 game**,而且重連的窗口裡 rev 變小也要收
      —— 否則本地樂觀交易會把 gameRev 墊到伺服器之上,回線後兩台各看各的、都動不了
      (見 canWriteGame / onGame 的註解)
   ========================================================================== */

const MPCore = (function(){

  /* ---------- 四個寬限期(v1.166.0 拆成兩組:「斷線」給滿一分鐘,「按下離開」照舊很快) ----------
     使用者:「離開視窗後再回來…改成 1 分鐘內回來都沒問題」。切去 LINE 回訊息、接個電話,
     手機馬上凍結分頁 → WebSocket 斷 → 伺服器依 onDisconnect 把 players/{我} 移掉,
     於是**別人那一台**會在寬限期到期時把這局作廢 / 把自己退出房間。所以要能撐一分鐘的
     是 GRACE_MS 與 ALONE_MS 這兩顆**別人身上的計時器**,不是回來的人自己。
     ⚠ 但寬限期一拉長,「真的按了離開」的那條路徑會跟著變慢(對手退出後房主要乾等一分鐘)——
       所以明確的離開訊號另外走短的:
         · 房主按離開 → host 欄位不見了(關房訊號,見 leave())→ CLOSE_MS
         · 訪客按離開 → 走 bye/{pid} 記號(見 leave() / byeIds)     → BYE_MS
       兩者都是「當事人還連著的時候自己寫下的」,所以看到就等於確定,不必再等。 */
  const GRACE_MS = 60000;                 // 斷線寬限(手機切 App 常見情境):一分鐘內回來就當沒事
  const ALONE_MS = 60000;                 // 對手**斷線**後仍只剩自己 → 退回等待
  const CLOSE_MS = 1200;                  // 房主按了「離開房間」= 明確關房,訪客不必等滿寬限
  const BYE_MS   = 8000;                  // 對手按了「離開房間」= 明確走人,照舊短寬限(= 改動前的 ALONE_MS)

  function create(A){
    const ROOMS = A.ns.rooms, INDEX = A.ns.index;
    const MAX_PLAYERS = A.maxPlayers || 2;
    const MIN_PLAYERS = A.minPlayers || 2;
    /* ★ 計分的單位與目標值(v1.76.0 為大老二加,**三個都有預設值 → 舊的五個遊戲行為不變**)。
       大老二一局發 5/3/1/0 的名次分,所以它的單位是「分」、目標值要拉高;
       其餘遊戲一局就是 +1 勝,照舊 "勝" / 3 / 20。 */
    const SCORE_UNIT = A.scoreUnit || "勝";
    const GOAL_DEF   = A.goalDefault || 3;
    const GOAL_MAX   = A.goalMax || 20;
    const clampGoal = v => Math.max(2, Math.min(GOAL_MAX, v|0));
    /* ★★ 分數是**有正負的量**(v1.84.0 為 21 點加,**不帶就是舊行為 → 七個舊遊戲一個字都不受影響**)。
       21 點記的是「淨籌碼變化」:輸了會是負的,而一場結束時每個座位各加減任意數。
       這一個旗標一次改五件事(全部集中在下面五處,每一處都寫著 SIGNED):
         ① ptsFor() 不再夾成 ≥ 0     ② 反向修正回收時不再夾成 ≥ 0
         ③ 積分表在 top ≤ 0 時照樣顯示  ④ 領先記號不要求 top > 0
         ⑤ 晶片上那顆 🏆N 徽章收掉(有正負的數字不是「勝場」,而 adapter 的 chipTail 自己畫)
       ⚠ 不可以改成「所有遊戲都有正負」—— 舊的七個遊戲一局就是 +1,
         而它們的 e2e 正是這一整段改動的回歸測試。 */
    const SIGNED = !!A.scoreSigned;
    const clampScore = v => SIGNED ? v : Math.max(0, v);
    /* ★★ 允許**對局中加入**(v1.84.0 為 21 點加,同樣不帶就是舊行為)。
       21 點一場 = 很多局,新人下一局就能當閒家(見 js/blackjack/adapter.js 的
       「排隊不是插入」),所以「對戰中不可加入」對它是錯的。
       ⚠ 這是核心的第二個遊戲專屬能力旗標(第一個是名次分)——
         加的是**能力**不是遊戲名字,CLAUDE.md 那條「不要往核心塞 if(game==="sudoku")」仍然成立。
       ⚠ 一共擋在四處:下面兩處 + join() 的硬擋 + **js/home-live.js 的 joinable()**。
         漏掉 home-live 那一份的症狀是「首頁把對戰中的房間列成不可加入」。 */
    const JOIN_MID = !!A.joinMidGame;
    /* ★★ 局間續局(v1.103.0 為台灣麻將加,不帶就是舊行為)。
       一場 = 很多個 MP round(打一圈 4 局 / 一將 16 局)時,每一局結束都把大家丟回大廳
       再各按一次「準備好了」,現場的感覺是「沒有連續感」。開了這個旗標之後:
         · 結果卡上按一下(或 adapter 自己倒數到期)→ readyUp():**不離開 playing 相位**
           就把自己標成準備好,順手把 status 翻回 lobby 讓房主端的 updateStartBtn 動起來。
         · 湊齊 → 房主 startGame() → 新的 roundId 進來 → 這裡靠 **roundId 變了** 判定
           「是新的一局」(舊路徑是靠 curPhase 從 lobby 變 playing,而現在根本沒回過大廳)。
       ⚠ 這是核心的第三個能力旗標。它加的是**能力**不是遊戲名字 —— 沒有帶的遊戲
         `playedRound` 那一條永遠不會成立,行為與 v1.102.1 逐字相同。
       ⚠ 「這一場打完了」不歸核心管:adapter 自己決定最後一局不要續(台灣麻將是
         打滿 handsGoal 局),那時結果卡照舊是「下一局 = 回大廳」。 */
    const CONT_ROUND = !!A.contRound;
    /* ★★ 回大廳之後,晶片上的台數標籤(chipTail)不要跟著收掉(v1.125.0 為台灣麻將加,
       不帶就是舊行為)。使用者:「戰績也繼續保留著,顯示在房間框裡面」——那份資料
       本來就沒被清掉(打滿一場之後 tai 節點要等真的開下一場才歸零,見
       js/mahjong16/adapter.js 的 newGame()),缺的只是晶片肯不肯畫。
       ⚠ 只放寬 chipTail,chipLead 不用跟著放寬:回大廳 order 會被清空([]),
       chipLead 依賴座位號算不出來就回傳 null,晶片照舊退回準備圓點,不必特別擋。 */
    const CHIP_TAIL_IN_LOBBY = !!A.chipTailInLobby;
    /* ★★ 出手順序讓玩家選(v1.144.0 為暗棋加,不帶就是舊行為 → 另外九個遊戲
       一個字都不受影響:ORDER_PICK 為 false 時 startGame() 走的是原本那一行)。
       三種方式:random(預設,核心自己洗)/ rps(猜拳蓋板)/ host(房主排)。
       ⚠ 這個旗標加的是**能力**不是遊戲名字(CLAUDE.md 紅線 3);猜拳的畫面與判定
         在 js/shared/mp-order.js,這裡只管「什麼時候寫什麼進 DB」。
       ⚠⚠ 決定出來的順序**一律經由 A.newGame(ids, prev, picked) 的第三個參數**交給
         adapter —— 座位有自己規矩的遊戲(台灣麻將輪莊、21 點換莊)不能被核心蓋掉,
         所以核心不直接寫 game.order,而是讓 adapter 決定要不要採用。
         沒有實作第三個參數的 adapter 自動忽略 → 行為與以前逐字相同。
       ⚠⚠⚠ 猜拳期間 status 是 "rps"/"reveal"、房主排順序時是 "ordering" ——
         大廳索引因此不是 "lobby",首頁與大廳都會顯示「對戰中」而擋掉加入。
         那是刻意的:猜到一半有人插進來,那一局的組別要重算。 */
    const ORDER_PICK = !!A.orderPick;
    const ORDER_PHASE = { rps:1, reveal:1, ordering:1 };
    const REVEAL_MS = 2600, TIE_MS = 1500;   // 揭曉停留 / 平手停留(房主端的計時器)

    let db=null, roomRef=null, code=null, meId=null, meName="玩家", isHost=false, roomName="";
    let online=false;
    let roomsWatchRef=null, lastRoomsSig=null, lastIndexSig=null;
    let players={}, scores={}, status="lobby", curPhase="lobby", ready=false;
    let order=[], winner=null, roundId=null;
    let gameRev=0;                          // 本地已套用的最新 game 版本(見上 #1)
    let scoreMode="rank", winGoal=GOAL_DEF, scoredThisRound=false, myRoundWin=false;
    let outcomeShown=false, abandoned=false, autoStarting=false;
    let prevIds=null, sawPlayers=false, sawMe=false, hostId=null, sawHost=false;
    let connRef=null, connected=null, resyncing=false, resyncTimer=null;
    let graceTimer=null, graceAt=0, aloneTimer=null, aloneTick=null, aloneWaitMs=0;
    let byeIds={};                          // 「自己按了離開房間」的人(bye/{pid});見上面四個寬限期
    let emotesReady=false;
    let playedRound=null;                   // 已經 enterPlaying() 過的那個 roundId(見 CONT_ROUND)
    /* 出手順序(只有 ORDER_PICK 的遊戲會動到):方式、猜拳中的狀態、揭曉資料,
       以及房主端的兩顆計時器。orderAnnounced = 這一局公告過順序了沒(order 可能比
       status 晚到,靠旗標保證只公告一次)。 */
    let orderMethod="random", rps=null, revealData=null, orderAnnounced=false;
    let tieTimer=null, revealTimer=null;

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
    /* 可加入 = 還在大廳 且 未滿。
       ★ JOIN_MID 的遊戲(21 點)連「對戰中」也算可加入 —— 新人下一局進場。
       ⚠ 這一份與 js/home-live.js 的 joinable() 是**同一條判定的兩份**:改一邊要改另一邊
         (CLAUDE.md 已有一條同型的紅線在講 max 必須一致)。 */
    function joinable(r){ return (r.status==="lobby" || (JOIN_MID && r.status==="playing")) && r.count<MAX_PLAYERS; }
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
        /* ⚠ JOIN_MID 的遊戲進不去只有一個理由(滿了)—— 標「對戰中」會讓人以為
           等一下就能進,而它其實永遠不會空出來(直到有人離開)。 */
        const cta=ok ? '<span class="join-cta">加入</span>'
                     : '<span class="busy-tag">'+((r.count>=MAX_PLAYERS&&(JOIN_MID||r.status==="lobby"))?"🔒 已滿":"🔒 對戰中")+'</span>';
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
    /* 抽一個沒人在用的房號,最多試 tries 次;抽到就把 code / roomRef 設好並回 true。
       ★★ 為什麼要迴圈(v1.156.0):在此之前是「撞到就重抽**一次**,之後不再檢查直接寫」——
         也就是二次撞號時會把**還在打的那一局**整包蓋掉(人、分數、盤面全沒,host 還被換人)。
         機率極低但是**單向上升的**:孤兒房沒有自動清理,被佔用的四位碼只會愈來愈多。
       ★ 判準是 host 在不在:關掉的房 host 正好是空的 → 那種房**本來就要**被撿來重用
         (下面的 wipe 負責把殘留清乾淨),所以這裡不算撞號。 */
    function pickFreeCode(tries){
      code=randomCode(); roomRef=db.ref(ROOMS+"/"+code);
      return roomRef.child("host").once("value").then(snap=>{
        if(!snap.exists()) return true;                 // 沒人用 / 已關閉 → 可以用
        if(tries<=1) return false;
        return pickFreeCode(tries-1);
      });
    }
    function create(name,wantName){
      if(!init()){ setMsg("尚未設定 Firebase,無法連線。"); return; }
      const nm=(name||"").trim();
      if(!nm){ flagNameNeeded(); return; }
      meName=nm.slice(0,8); meId=pid(); isHost=true;
      roomName=(wantName||"").trim().slice(0,12) || (meName+"的房間");
      const QUIET={ __quiet:true };                     // 抽不到房號:已經給過訊息,不要再蓋一次
      pickFreeCode(5).then(free=>{
        if(!free){ setMsg("房號一直撞到別人開的房,請再按一次。"); return Promise.reject(QUIET); }
        /* ⚠⚠⚠ 撞到**已關閉**的房間時要把它的殘留欄位清乾淨(v1.147.0 起非做不可)。
           pickFreeCode 看的是 `host` 有沒有值,而關掉的房間 host 正好是空的
           → 它看起來像沒人用,於是新房會直接蓋在舊房上面。用 update() 的話
           **舊房的 scores 會留下來** = 新房一開就有人有分數(而且對得上名字,
           因為 nm 也在裡面),而畫面上完全看不出哪裡不對。
           v1.147.0 之前不會踩到:那時房主離開會整間 remove,而斷線留下的房間
           `host` 還在 → 一定會被重抽掉。
           ★ 用「明確列出要清的欄位」而不是 roomRef.set():留住 roomName / createdAt / scores
             這幾筆歷史(首頁那個隱藏的伺服器狀態面板要靠它們列出「誰開過哪一間」)。
             ⚠ v1.156.0 更正:這裡原本寫的理由是「set() 在二次撞號時會把還在打的那一局
               整包擦掉」—— 那個理由**已經不成立**了。這一包 payload 本身就含
               players:null / scores:null / extraNodes:null / game:{rev:1} / host:meId,
               二次撞號時用 update() 一樣把那一局整包擦掉。真正擋住二次撞號的是
               pickFreeCode 的迴圈(最多試五次、全撞就放棄並告訴使用者),不是 update()。
           ⚠ adapter 自己的房內節點(A.extraNodes,例如數獨/消消樂的 progress、
             台灣麻將的 tai、你畫我猜的 ink/say)也要一起清 —— 它們是**上一局**的資料。 */
        const wipe={ players:null, scores:null, hostName:null, closedAt:null, bye:null };
        (A.extraNodes||[]).forEach(k=>{ wipe[k]=null; });
        const payload=Object.assign(wipe, {
          host:meId, roomName:roomName,
          scoreMode:scoreMode, winGoal:winGoal, emotes:null, createdAt:Date.now(),
          game:Object.assign({ rev:1 }, lobbyGame(null))
        }, ORDER_PICK ? { orderMethod:orderMethod } : {}, A.roomFields ? A.roomFields() : {});
        return roomRef.update(payload);
      }).then(()=>{
        claimSeat(okSeat=>{
          if(!okSeat){ setMsg("建立房間失敗,請再試一次。"); return; }
          enterLobby(); armRoomIndex();
        });
      }).catch(e=>{ if(e===QUIET)return; setMsg("建立房間失敗:"+((e&&e.message)||e)); });
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
        // ★ JOIN_MID 的遊戲(21 點)對戰中也進得去 —— 座位表由 adapter 在換局時重建
        if(!JOIN_MID && r.game && r.game.status && r.game.status!=="lobby"){ setMsg("這間正在對戰中,無法加入。"); return; }
        roomName=inName||r.roomName||("房間 "+code);
        A.readRoom && A.readRoom(r);      // 先把房主的設定套上,免得大廳閃一下預設值
        claimSeat(okSeat=>{
          if(!okSeat){ setMsg("這個房間已經滿了,請選別間。"); roomRef=null; code=null; return; }
          // ★ 誤按離開的救援(v1.97.0):進大廳之前先把同名的舊成績接回來,免得畫面先閃一次 0
          adoptScore(r,enterLobby);
        });
      }).catch(e=>setMsg("加入失敗:"+e.message));
    }
    /* 從 index.html 主選單的「現在有人在玩」帶著 ?join=<code> 進來(見 autoJoinFromQuery)。
       先切到連線畫面,SDK 就緒後才 join;openConnect() 的 then 註冊在前 → 一定是
       「掛大廳監聽 → join → enterLobby 卸載監聽」,不會留下孤兒監聽。
       房名不從 URL 帶(會被改),一律以房間本體的 roomName 為準;沒暱稱就停在連線畫面提示填。 */
    function joinFromHome(inCode){
      openConnect();
      ensureFirebase().then(()=>join(inCode,$("mpName").value,"")).catch(()=>{});
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
        /* ⚠ 搶到位子就要把自己的 bye 記號清掉:留著的話「上次是按離開走的」會一直算數,
           下次真的斷線時別人會用短寬限把這局作廢(而這一支 resume() 也會呼叫 → 回來就清乾淨)。 */
        if(ok){ roomRef.child("players/"+meId).onDisconnect().remove(); roomRef.child("bye/"+meId).remove(); }
        done&&done(ok);
      });
    }

    /* ---------- 誤按離開的救援:同名接續(v1.97.0) ----------
       「不小心離開」在親友聚會很常發生,而三種離開方式原本的下場**完全不同**:
         · 斷線 / 關頁面 / 切 App 太久 → players 被 onDisconnect 移除,而 scores **刻意**
           不掛 onDisconnect(見檔頭 #2)→ 同一台裝置重進本來就自動接回,一行都不必改
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
       ⚠ 這一支只管核心的 scores。遊戲自己那份「per-pid 的一場進度」(21 點的 bj.nets)
         由 A.adoptId 搬 —— 不要往這裡塞遊戲名字。 */
    function resumeMsg(n){
      // SIGNED 的遊戲(21 點)接回來的可能是正的也可能是負的 → 正數補個 + 才看得出是賺
      return "已接回你先前的成績:"+((SIGNED&&n>0)?"+":"")+n+" "+SCORE_UNIT;
    }
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
        if(!err&&committed){
          showToast(resumeMsg(sc[src].n));
          // 遊戲自己那份 per-pid 的一場進度(21 點的 bj.nets);沒實作的遊戲自動跳過
          A.adoptId && A.adoptId(src,meId);
        }
        fin();
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

    /* ---------- 熱門度計數 game_stats(v1.112.0)----------
       首頁九張遊戲卡依「這個遊戲被真的玩過幾場」自動排序,資料就只有這一個累加數。
       判定刻意訂成三個條件同時成立,少一個都會讓數字失去意義:
         · **只有房主寫** → 一場算一次,不是一場算 N 個人(不然人多的遊戲天生佔便宜)
         · **真的開局才起算** → 開了房停在大廳沒打就不算
         · **撐過 30 秒** → 濾掉「點錯遊戲、進去馬上退」的誤觸
       ★ 一間房只記一次,**不是一局一次** —— 21 點與台灣麻將一場是很多局,
         一局一次會讓那兩個遊戲的數字灌水好幾倍。
       ⚠ 這一段(三支 + 兩個呼叫點)與 js/online.js 是**雙胞胎**:Bingo 不載入 js/shared/,
         所以那邊有逐字對應的一份,改一邊要改另一邊(CLAUDE.md 紅線 4)。
       ⚠ 寫入失敗(規則沒開放 game_stats)一律靜靜吞掉 —— 這只是排序用的統計,
         不可以因為它讓正在玩的人看到錯誤。 */
    const STAT_MS  = 30000;
    const STAT_KEY = INDEX.replace(/_index$/,"");   // gomoku_index → gomoku(與 home-live 的 key 一致)
    let statTimer=null, statDone=false;
    function armPlayCount(){
      if(!isHost || statDone || statTimer || !db) return;
      statTimer=setTimeout(()=>{
        statTimer=null;
        if(!isHost || statDone || !online || !db) return;   // 30 秒內就離開 → 這場不算
        statDone=true;
        try{ db.ref("game_stats/"+STAT_KEY+"/n").transaction(n=>(n||0)+1); }catch(e){}
      },STAT_MS);
    }
    function clearPlayCount(){ if(statTimer){ clearTimeout(statTimer); statTimer=null; } }

    /* ---------- 相位:大廳 ---------- */
    function enterLobby(){
      online=true; ready=false; curPhase="lobby";
      sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
      gameRev=0; playedRound=null;   // ★ 進新房必歸零(見檔頭 #1)
      byeIds={}; aloneWaitMs=0;      // 同上:上一間房「誰按了離開」不可以帶進新房(見四個寬限期)
      clearPlayCount(); statDone=false;   // 熱門度計數:一間房記一次 → 進新房要重新起算
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
      armBackGuard(onBackKey);   // 返回鍵:進房後一律先問(冪等,整段房內生命週期只墊一筆歷史)
    }
    /* 手機返回鍵在房間裡的行為:有浮層開著就先關浮層(含把離開確認卡本身當「取消」關掉),
       否則跳離開確認 —— 誤按一下就斷線退出、房主還會把整房關掉,太痛。見 ui-kit.js 的 armBackGuard */
    function onBackKey(){ if(dismissTopLayer())return; askLeave(); }
    // 回大廳續玩(本局結束 / 作廢):只重設本地,不動別人
    function backToLobby(){
      ready=false; curPhase="lobby"; order=[]; winner=null;
      outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false;
      clearAloneCheck(); closeWin();
      // 決定順序中被帶回大廳(房主取消 / 對手跑掉):蓋板與計時器一起收
      clearOrderT(); orderAnnounced=false; { const U=orderUi(); if(U) U.hide(); }
      $("scrollArea").classList.remove("hidden");
      $("primaryBar").classList.remove("hidden");
      $("mpReadyBtn").classList.remove("hidden");
      A.backToLobby && A.backToLobby();
      syncSubrow(); syncSetup(); updateReadyBtn(); updateGoal(); setActionHint("");
    }
    /* ---------- 相位:對戰中 ---------- */
    function enterPlaying(){
      curPhase="playing";
      playedRound=roundId;
      /* ★ 準備記號跟著清:startGame() 那一刻房主已經把全房每個人的 ready 寫成 false,
         本地這一份不清就會與 DB 不一致。舊路徑每次都先經過 backToLobby()(那裡也清),
         所以七個舊遊戲**行為逐字不變**;續局的遊戲沒回過大廳,只有這裡清得到 ——
         漏掉的話下一局結束時 readyUp() 看到 ready 還是 true 就整個不動作(全房卡住)。 */
      ready=false;
      outcomeShown=false; abandoned=false; scoredThisRound=false; myRoundWin=false;
      closeWin();
      /* ★ 決定順序的蓋板要在這裡收(開打了就沒有它的事)—— 沒開 ORDER_PICK 的遊戲
         orderUi() 回 null,這兩行等於不存在。 */
      clearOrderT(); { const U=orderUi(); if(U) U.hide(); }
      announceOrder();
      $("scrollArea").classList.add("hidden");
      // 對戰中整條動作列收起來:準備鈕用不到,留著只是白吃一列高度
      $("primaryBar").classList.add("hidden");
      $("mpReadyBtn").classList.add("hidden");
      syncSubrow(); setActionHint("");
      A.enterPlaying && A.enterPlaying();
      updateGoal();
      armPlayCount();   // 熱門度計數:從「真的開局」這一刻起算 30 秒(見上面那段)
      Sound.start();
    }

    /* ---------- 監聽 ---------- */
    function listen(){
      roomRef.child("host").on("value",s=>{
        hostId=s.val()||null; if(hostId)sawHost=true;
        if(hostGone()) scheduleRecheck(recheckWait());
      });
      /* 誰是「自己按了離開房間」走的(v1.166.0)。⚠ 這一份與 players 是**兩個節點兩個事件**,
         到達順序不保證 → 晚到時要把已經在跑的長寬限縮回短的(retuneAloneCheck)。 */
      roomRef.child("bye").on("value",s=>{ byeIds=s.val()||{}; retuneAloneCheck(); });
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
        if(iWasKicked() || hostGone()) scheduleRecheck(recheckWait()); else clearRecheck();
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
      /* 出手順序的決定方式(房主可改、全員監聽)。⚠ 用**白名單**收:舊房間沒有這個
         欄位、手改 DB 的怪值一律退回 random(不能讓一個亂字串把開局卡住)。
         ⚠ unreadyOnFieldChange() 要放在**監聽**裡而不是 setter 裡 —— 它只對訪客生效,
           而事件是每一台都收得到的(同 adapter 的 onRoomField 那一套)。 */
      if(ORDER_PICK) roomRef.child("orderMethod").on("value",s=>{
        const v=s.val(), next=(["random","rps","host"].indexOf(v)>=0)?v:"random";
        if(next===orderMethod)return;
        orderMethod=next; unreadyOnFieldChange(); syncSetup();
      });
      roomRef.child("scoreMode").on("value",s=>{ scoreMode=(s.val()==="match")?"match":"rank"; syncSetup(); renderPlayers(); });
      roomRef.child("winGoal").on("value",s=>{ const v=s.val(); winGoal=(typeof v==="number"&&v>=2)?Math.min(GOAL_MAX,v):GOAL_DEF; syncSetup(); });
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
    /* ⚠⚠⚠ **離線期間一律不寫 game**(v1.177.3,暗棋現場回報「一個人斷線回來之後兩個人都動不了」)。
       Firebase 的寫入 / 交易在離線時會**先套用到本地快取**、照樣發 value 事件 ——
       於是 onGame 把 gameRev 一路墊高:走棋倒數到期時自己幫自己代打一手(而且套用完
       又重新排一顆計時器 → 每 turnSec 秒墊高一次,等於一台離線的裝置自己跟自己把
       整局打完)、使用者多點兩下、連吃連送好幾手,每一筆都讓**本地 rev 比伺服器高**。
       回線之後這些交易被伺服器退回,退回來那一份的 rev **比本地小** → 撞上
       `rev<gameRev` 被靜靜丟掉,這台就永遠停在一個伺服器上不存在的幻影盤面:
       自己看到「輪到對手」、對手看到「輪到你」,**兩個人都動不了而且都不報錯**。
       ⚠ 擋在這三支寫入口一次擋掉十一個遊戲的 send / 認輸 / 逾時代打 / 結算 / 相位推進。
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
    function setGame(g){ if(!canWriteGame())return; g.rev=gameRev+1; roomRef.child("game").set(g); }
    function patchGame(p){ if(!canWriteGame())return; p.rev=gameRev+1; roomRef.child("game").update(p); }
    /* opts.local===false → 交易**不做本地樂觀套用**(Firebase 的第三個參數 applyLocally)。
       代價是自己那一手要等一趟往返才看得到,換來的是「本地永遠不會出現一個之後會被推翻的
       狀態」。決定勝負的那種寫入要用它 —— 樂觀的贏家會觸發計分/彩帶/音效,而那些副作用
       在另一個節點,交易回退救不回來(見 showOutcome 的反向修正)。 */
    function txGame(mut,opts){
      if(!canWriteGame())return;
      roomRef.child("game").transaction(g=>{
        if(!g)return;                 // ★ 回傳 undefined 中止;回傳 null 會刪掉節點(見檔頭 #4)
        if(mut(g)===false)return;
        g.rev=(g.rev||0)+1;
        return g;
      }, undefined, !(opts && opts.local===false));
    }
    function onGame(g){
      g=g||{};
      const rev=(typeof g.rev==="number")?g.rev:0;
      /* 過期快照直接丟 —— **但重連歸位的那一段窗口(resyncing)例外**:
         伺服器把離線期間的樂觀交易退回來時,退回來的那一份 rev 一定**比本地小**,
         照丟的話畫面就永遠停在幻影盤面(見上面 canWriteGame 的註解)。
         ⚠ 這一條是那個死結的**第二道**保險:第一道(不寫)擋不住「.info/connected
           還沒察覺斷線」的那幾十秒,那段時間照樣墊得高,只有這裡收得回來。 */
      if(rev<gameRev && !resyncing)return;
      gameRev=rev;
      order=g.order||[]; roundId=g.roundId||null;
      rps=g.rps||null; revealData=g.reveal||null;
      const nextWinner=g.winner||null, nextStatus=g.status||"lobby";
      const hadWinner=!!winner;
      winner=nextWinner; status=nextStatus;
      const statusChanged=(nextStatus!==curPhase);

      /* 相位派發(★ 新局的本地狀態要在 enterPlaying 之前清掉,否則會拿上一局的殘留去畫)
         ★ 第二個條件只有 CONT_ROUND 的遊戲成立:局間不回大廳 → curPhase 一直是 playing,
           「新的一局來了」只剩 roundId 這一個記號(它由 startGame() 現配,一局內不會變)。 */
      if(status==="playing"){
        if(curPhase!=="playing" || (CONT_ROUND && roundId!==playedRound)){ A.resetRound && A.resetRound(); enterPlaying(); }
      }
      /* ★ 第三條相位:決定出手順序(猜拳 / 房主排)。只有 ORDER_PICK 的遊戲進得來 ——
         沒開的遊戲 status 永遠只有 lobby / playing,這一支等於不存在。
         ⚠ 一定要擋在 backToLobby() 前面:那一行看到「不是 playing」就會把人踢回大廳,
           猜拳蓋板會在跳出來的同一拍被關掉(而且 DOM 量起來完全正常)。 */
      else if(ORDER_PICK && ORDER_PHASE[status]){ enterOrder(); }
      else { if(curPhase!=="lobby" && !winner) backToLobby(); }

      // 遊戲狀態同步:交給 adapter(五子棋的 moves / 數獨的 fills 與進度)
      A.applyGame && A.applyGame(g, curPhase==="playing");

      if(winner){ onWinner(); }
      else if(hadWinner) closeWin();
      if(statusChanged && isHost) updateRoomIndex();
      /* ⚠ 續局時 curPhase 停在 playing,而 readyUp() 把 status 翻回 lobby 是**交易**——
         「大家都準備好了」的 players 事件很可能比它先到(那時房主看到的 status 還是
         playing → updateStartBtn 直接 return)。少了這一次補叫就是全房停在結果卡上。 */
      if(curPhase==="lobby" || CONT_ROUND) updateStartBtn();
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
    /* picked = 已經決定好的出手順序(猜拳揭曉完 / 房主排完 / 核心洗好的隨機順序)。
       ★ 沒開 ORDER_PICK 的遊戲永遠是 undefined → 下面那段整個跳過,行為與以前逐字相同。 */
    function startGame(picked){
      if(!isHost)return;
      const ids=Object.keys(players);
      if(ids.length<MIN_PLAYERS || !ids.every(id=>players[id].ready)){ showToast("需要 "+MIN_PLAYERS+" 人並且都準備好"); return; }
      /* ★★ 順序還沒決定 → 先轉去決定(猜拳 / 房主排),決定完會再回到這裡一次。
         ⚠ random 也走這裡洗:洗在核心而不是各 adapter,九個遊戲才有同一種「隨機」。 */
      if(ORDER_PICK && !picked){
        if(orderMethod==="rps"){ startRps(ids); return; }
        if(orderMethod==="host"){ startOrdering(); return; }
        picked=shuffle(ids);
      }
      if(picked){
        picked=picked.filter(id=>players[id]);            // 決定順序的過程中有人跑掉
        if(picked.length<MIN_PLAYERS){ cancelOrder(); return; }
      }
      // 上一局的順序(adapter 可據此決定要輪替還是重抽)
      const prev=(order.length===ids.length && order.every(id=>players[id])) ? order.slice() : null;
      const g=A.newGame(ids, prev, picked||null);
      if(!g) return;                                      // adapter 判定不能開打(例如題目產生失敗)
      const pups={}; ids.forEach(id=>{ pups["players/"+id+"/ready"]=false; });
      roomRef.update(pups);
      setGame(Object.assign({ status:"playing", winner:null, roundId:Date.now() }, g));
    }
    function shuffle(a){
      const r=a.slice();
      for(let i=r.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=r[i]; r[i]=r[j]; r[j]=t; }
      return r;
    }

    /* ==========================================================================
       相位:決定出手順序(只有 ORDER_PICK 的遊戲會走到)
       ──────────────────────────────────────────────────────────────────────────
         ★ 分工:這一段管「什麼時候寫什麼進 DB」;畫面與猜拳的分組判定在
           js/shared/mp-order.js(那支零 firebase,判定是純函式、node 測得到)。
         ★★ **這個相位不寫 game.order** —— 決定出來的順序只放在 reveal.order(給揭曉
           那張卡看)並在開打時經 A.newGame 的第三個參數交出去。理由:game.order 在
           大廳裡裝的是**上一局的順序**(prev,adapter 用來輪莊 / 重抽),中途蓋掉就
           永遠算不出「上一局是誰先」。
         ⚠⚠ 出拳、平手重猜這些「同一個相位裡的中途更新」刻意**不遞增 rev**
           (走 roomRef.child("game/rps").update)—— onGame 的過期判定是 rev < gameRev,
           所以同 rev 的快照照樣會套用。改成 patchGame 也不會壞,但每出一拳就多一版。
       ========================================================================== */
    function orderUi(){ return (ORDER_PICK && typeof MPOrder!=="undefined") ? MPOrder : null; }
    function clearOrderT(){
      if(tieTimer){ clearTimeout(tieTimer); tieTimer=null; }
      if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; }
    }
    /* 房主:開猜拳(第一輪全部人同一組)/ 開「自己排順序」。
       ⚠⚠⚠ 一律用 patchGame **只改要改的欄位**,不可以 setGame 整包重寫 ——
         game.order 這時裝的是**上一局的順序**(startGame 的 prev,輪莊 / 換莊的遊戲
         靠它算下一局誰先),整包重寫會把它清成 null。
         症狀:暗棋看不出來(它不用 prev),但台灣麻將 / 21 點接上這個旗標的那天
         就會變成「每一局都從第一家重新開始」——而畫面完全正常。
       ⚠ winner 要順手清掉:again() 只把 status 翻回 lobby,舊的 winner 還留在節點裡,
         不清的話結果卡會疊在猜拳蓋板上面。
       ⚠ reveal 也要清:上一輪猜拳留下來的手勢會在揭曉那一格閃一下舊資料。 */
    function startRps(ids){
      clearOrderT();
      patchGame({ winner:null, reveal:null, status:"rps",
                  rps:{ seq:1, groups:MPOrder.dumpGroups([ids.slice()]), throws:null } });
    }
    function startOrdering(){
      clearOrderT();
      patchGame({ winner:null, rps:null, reveal:null, status:"ordering" });
    }
    /* 每一份快照都會進來一次 → 一定要**冪等**。fresh 只在「剛從別的相位進來」時
       收大廳那幾塊(重複收沒事,但重複 setActionHint 會閃)。 */
    function enterOrder(){
      const fresh=!ORDER_PHASE[curPhase];
      curPhase=status;
      if(fresh){
        orderAnnounced=false; ready=false;
        $("scrollArea").classList.add("hidden");
        $("primaryBar").classList.add("hidden");
        $("mpReadyBtn").classList.add("hidden");
        setActionHint("");
      }
      const U=orderUi();
      if(U) U.show({ phase:status, rps:rps, reveal:revealData, order:order,
                     players:players, meId:meId, isHost:isHost, dispName:dispName });
      renderPlayers();
      if(isHost) hostOrderStep();
    }
    // 房主端的推進器:每一份快照都問一次「現在該做什麼」(不靠事件順序)
    function hostOrderStep(){
      if(!isHost||!roomRef)return;
      if(status==="reveal"){
        if(!revealTimer) revealTimer=setTimeout(()=>{ revealTimer=null; advanceReveal(); }, REVEAL_MS);
        return;
      }
      if(status!=="rps"||!rps||rps.tie)return;             // 平手揭曉中:等計時器帶進下一輪
      const seq=rps.seq||1, throws=rps.throws||{};
      const groups=MPOrder.parseGroups(rps.groups, id=>!!players[id]);
      const pend=MPOrder.pending(groups);
      if(!pend.length){ finishRps(MPOrder.flat(groups), rps.reveal||{}); return; }   // 有人離開 → 剩下的自動定案
      if(!pend.every(id=>throws[id]&&throws[id].s===seq))return;                     // 還有人沒出拳
      const plain={}, acc=Object.assign({}, rps.reveal||{});
      pend.forEach(id=>{ plain[id]=throws[id].c; acc[id]=throws[id].c; });
      const next=MPOrder.split(groups, plain);
      if(MPOrder.settled(next)){ finishRps(MPOrder.flat(next), acc); return; }
      /* 還有人平手 → 先把分組寫回去並標 tie(讓大家看清楚剛剛平手了),停一下再重猜。
         ⚠ 少了這一段,平手時畫面只會「忽然又要出一次拳」,沒人知道發生了什麼。 */
      if(tieTimer)return;
      /* ⚠⚠⚠ 計時器**一定要先排、才寫 DB**(順序反過來會無限遞迴):寫入會在同一拍
         觸發自己的 value 事件(Firebase 的本地樂觀套用、mock 更是逐鍵同步),
         那一拍又進來這一支 —— 這時 tieTimer 還是 null 就再寫一次,一路疊下去。
         排在前面之後,重入的那一拍會在上面那行 `if(tieTimer)return` 就折返。 */
      tieTimer=setTimeout(()=>{
        tieTimer=null;
        if(!roomRef||status!=="rps")return;
        roomRef.child("game/rps").update({ seq:seq+1, throws:null, reveal:acc, tie:null });
      }, TIE_MS);
      roomRef.child("game/rps").update({ groups:MPOrder.dumpGroups(next), tie:true });
    }
    // 猜拳定案 → 進揭曉(帶著大家出的拳與最終順序);開打由 advanceReveal 做
    function finishRps(finalOrder, acc){
      clearOrderT();
      patchGame({ status:"reveal", rps:null, reveal:{ throws:acc||{}, order:finalOrder } });
    }
    function advanceReveal(){
      if(!isHost||status!=="reveal")return;
      const ord=((revealData&&revealData.order)||[]).filter(id=>players[id]);
      if(ord.length<MIN_PLAYERS){ cancelOrder(); return; }
      startGame(ord);
    }
    /* 房主:取消整個決定順序的過程,回大廳(房間留著,大家可以重來)。
       ⚠ 同上,只 patch —— 上一局的順序(prev)不可以被取消動作清掉。 */
    function cancelOrder(){
      if(!isHost||!roomRef)return;
      clearOrderT();
      patchGame({ status:"lobby", rps:null, reveal:null, winner:null });
      showToast("已取消,回到大廳");
    }
    /* 出拳。⚠ 只有「還在比大小的組」裡的人能出;已經定案的人按了也不寫
       (不然平手重猜時他的舊拳會被算進去)。 */
    function throwRps(c){
      if(!ORDER_PICK||!roomRef||!meId)return;
      if(status!=="rps"||!rps||rps.tie)return;
      if(["R","S","P"].indexOf(c)<0)return;
      const groups=MPOrder.parseGroups(rps.groups, id=>!!players[id]);
      if(!groups.some(g=>g.length>1&&g.indexOf(meId)>=0))return;
      roomRef.child("game/rps/throws/"+meId).set({ c:c, s:rps.seq||1 });
    }
    function confirmOrder(ids){
      if(!isHost||status!=="ordering")return;
      const ord=(ids||[]).filter(id=>players[id]);
      if(ord.length<MIN_PLAYERS){ showToast("需要 "+MIN_PLAYERS+" 人"); return; }
      startGame(ord);
    }
    function skipReveal(){ if(!isHost||status!=="reveal")return; clearOrderT(); advanceReveal(); }
    // 蓋板上的逃生出口:房主 = 取消回大廳(不離房);訪客 = 真的離開(先問一次)
    function bailOrder(){ if(isHost) cancelOrder(); else askLeave(); }
    function toggleReady(){
      if(!roomRef||!meId)return;
      ready=!ready;
      roomRef.child("players/"+meId).update({ ready:ready, name:meName });
      updateReadyBtn();
    }
    /* 局間續局的「繼續」(只有 A.contRound 的遊戲用得到,見檔頭 CONT_ROUND)。
       與 toggleReady 的差別有三:單向(只會變成準備好,不會取消)、**不必回大廳**、
       而且**順手把 status 翻回 lobby** —— 房主端的 updateStartBtn 有 status!=="lobby"
       這道門,不翻的話大家都準備好了也開不了下一局。
       ★ 回傳「有沒有真的送出去」給 adapter 用(按過第二次要保持原樣、不要重畫成剛按下)。
       ⚠ status 那一筆走一般交易(會本地樂觀套用)—— 它不碰 game.winner,
         不在踩坑 #8 的射程內;而且第一個按的人先翻好,後面的人交易看到就中止。
       ⚠⚠⚠ **兩個判斷值都要在寫 players 之前抓下來**(v1.153.2 修的 bug):
         下面那一筆 players 寫入會**在同一個呼叫堆疊裡**打到自己的 players 監聽 →
         updateStartBtn() → 我如果是湊齊那一票的人,**下一局就在那一行裡被開走了**
         (status 變回 playing、roundId 換新)。回到這裡再讀當下的 status,就會拿
         「剛開的那一局」去跑交易 → 把它的 status 翻回 lobby,而新局的 winner 是空的
         → onGame 的 `!winner` 那條當場成立 → **全房一起 backToLobby()**。
         使用者回報的原句:「大家都按了繼續,但不知道為什麼跳回了房間」。
       ⚠ roundId 那道門同時擋掉網路版的同一件事:交易被伺服器判定過期而重跑時,
         手上的快照可能已經是下一局了(那時本地 status 也已經翻過)。
       ★ 守門:tools/gen-mj16-e2e.js 的 Y 段(房主當最後一個按的人)。 */
    function readyUp(){
      if(!CONT_ROUND || !roomRef || !meId || ready) return false;
      const rid=roundId, wasPlaying=(status!=="lobby");
      ready=true;
      roomRef.child("players/"+meId).update({ ready:true, name:meName });
      if(wasPlaying) txGame(g=>{ if(g.status==="lobby" || g.roundId!==rid)return false; g.status="lobby"; });
      updateReadyBtn();
      return true;
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
    /* ★ 這一局某個人該得幾分(v1.76.0)。
       • 一般:得分名單裡的人各 +1(五子棋和局全員、數獨並列同分只有並列者)
       • adapter 在 winner 裡帶了 pts 表時(大老二的名次分 5/3/1/0):依他自己那一格
       ★★ **不帶 pts 時回的一律是 0 或 1,與 v1.75.18 之前逐字等價** ——
          這是整段名次分改動能安全上線的關鍵,五個舊遊戲的 e2e 就是它的回歸測試。
       ⚠ winner.ids 仍然只放「第一名」:大字 / 彩帶 / 卡片配色全部吃 winnerIds(),
         第三名拿了 1 分但沒有贏,不該放彩帶。 */
    /* ★ SIGNED 的遊戲(21 點)這裡**不夾**成 ≥ 0:它的 pts 是淨籌碼變化,負的才對。
       ⚠ 不帶 scoreSigned 的七個舊遊戲走的是 Math.max(0, …),與 v1.83.0 逐字相同。 */
    function ptsFor(id){
      if(!winner || !id) return 0;
      if(winner.pts && typeof winner.pts[id]==="number") return clampScore(winner.pts[id]|0);
      return winnerIds().indexOf(id)>=0 ? 1 : 0;
    }
    const myPts = () => ptsFor(meId);
    function showOutcome(){
      if(!winner)return;
      const isDraw=winner.by==="draw";
      const wids=winnerIds();
      const iWon=!isDraw && wids.indexOf(meId)>=0;
      myRoundWin=wids.indexOf(meId)>=0;

      /* 計分:得分的人幫自己加分,一局只計一次(roundId 冪等 + 交易內再驗一次)。
         ★ 一般是「贏家 +1」;帶了名次分就加自己那一格(見 ptsFor)。
         ★ `d` 記下這一局實際加了多少 —— 下面的反向修正要靠它才收得回**正確的數**
           (寫死 -1 的話,名次分模式下收回來的金額會是錯的)。 */
      /* ⚠ 條件是 `!== 0` 而不是 `> 0`(v1.84.0 改):21 點會加負數。
         ★ 舊的七個遊戲 myAdd ∈ {0, 1} → 兩種寫法**逐字等價**,行為一個字都沒變。 */
      const myAdd = myPts();
      if(myAdd!==0 && meId && roomRef && roundId && !scoredThisRound && scoredRoundOf(meId)!==roundId){
        scoredThisRound=true;
        roomRef.child("scores/"+meId).transaction(s=>{
          if(s && s.round===roundId) return;
          /* ★ nm 是「誤按離開後同名接續」用的(v1.97.0,見 adoptScore)。
             寫在**得分的那一刻**而不是離開的時候 —— 斷線是沒有機會執行程式碼的
             (onDisconnect 只能寫預先講好的值),名字要早一點放進來才留得住。 */
          return { n:((s&&s.n)||0)+myAdd, round:roundId, d:myAdd, nm:meName };
        },()=>{ if(winner) renderScoreboard(); });
      }
      /* ★ 反向修正:這一局先前判給我、後來的真值改判別人 → 把那一分收回來(v1.56.0 修)。
         為什麼會發生:Firebase 交易**會先在本地樂觀套用並發出 value 事件**,伺服器有衝突時
         才用真值重跑。搶最後一手的時候(麻將搶牌 / 數獨搶格),我這台會先看到「我贏」的
         樂觀快照 → 這裡就把 +1 寫進 scores/{me};接著伺服器真值回來說是對手贏,
         **game 節點回退了,但分數是寫在另一個節點,不會跟著回退** ——
         症狀就是「明明對手贏了,我的勝場卻也多一分」。
         寫回去時把 round 標成 "void":一局只收回一次,而且如果真值又改回我贏(理論上
         不會,伺服器值是終局),上面那條看到 round 不等於 roundId 會再補一次 → 自我收斂。 */
      /* ⚠ 對稱地改成 `=== 0`(上面那條是 `!== 0`)—— 舊遊戲 myAdd ∈ {0,1} 時
         與原本的 `<= 0` 逐字等價。 */
      else if(myAdd===0 && meId && roomRef && roundId && scoredRoundOf(meId)===roundId){
        scoredThisRound=false;
        roomRef.child("scores/"+meId).transaction(s=>{
          if(!s || s.round!==roundId) return;      // 不是這一局記的 → 別亂動
          // ⚠ 舊資料沒有 d(v1.76.0 之前寫的)→ 退回 1,與舊行為完全一致
          const back=(typeof s.d==="number") ? s.d : 1;
          // ★ SIGNED 的遊戲不夾成 ≥ 0(見 clampScore);舊遊戲照樣 Math.max(0, …)
          // ⚠ nm 要跟著留下來(v1.97.0):這條路徑會整份覆寫,漏掉就等於把接續用的名字擦掉
          return { n:clampScore((s.n||0)-back), round:"void", nm:meName };
        },()=>{ if(winner) renderScoreboard(); });
      }

      // 大字只講「對我而言」的輸贏,卡片再依結果換色(原本輸贏共用同一組金色漸層,輸了也一樣喜氣)
      // 平手但自己不在並列名單裡(3~6 人才會發生)→ 卡片仍走 lose,不要給喜氣的配色
      const card=$(A.winCardId||"gmkWinCard");
      if(card){ card.classList.remove("win","lose","draw"); card.classList.add(isDraw?(myRoundWin?"draw":"lose"):(iWon?"win":"lose")); }

      const o=(A.outcome && A.outcome(winner,{ iWon, isDraw, mine:myRoundWin, ids:wids, first:!outcomeShown })) || {};
      $("winWord").textContent=o.word || (isDraw?"平手!":(iWon?"你贏了!":"你輸了"));
      // msg 是 HTML(數獨要在結果卡裡換行講自己的對/錯統計):adapter 端一律自己 esc() 玩家名字
      $("winMsg").innerHTML=o.msg || "";
      if(!outcomeShown){
        if(iWon){ Sound.win(); burst(); }
        else if(myRoundWin) Sound.win();     // 平手且自己有份:有聲音但不放彩帶
        else Sound.lose();
      }
      renderScoreboard();
      /* ★★ 正在偷看牌桌時**不要把結果卡叫回來**(v1.108.0)。
         showOutcome() 會被 players / scores 的任何變動叫起來(別人按「繼續」、
         有人改名、分數同步…),而它以前一律 showResult() —— 使用者按了「看牌」正在
         研究牌桌,畫面卻**自己跳回結算畫面**:「我按返回去看牌,然後突然跳回來結算畫面」。
         ⚠ 卡片的內容(大字 / 訊息 / 台數表)上面幾行照樣更新了,所以按「🏆 看結果」
           回來看到的是最新的一份 —— 這裡只是不搶畫面。
         ⚠ 換局是安全的:新的一局 winner 被清掉 → 核心走 closeWin(),那一支會把
           peeking 一起拿掉(見 ui-kit.js)。 */
      if(!document.body.classList.contains("peeking")) showResult();
      const firstShow=!outcomeShown;
      outcomeShown=true;
      /* 本局結束就把自己設為未準備(下一局要各自重新按準備)。
         ⚠⚠ 只在**這一局第一次**顯示結果時做。showOutcome() 會被反覆呼叫 ——
           players / scores 任何一個節點一動,只要還在結果相位就再跑一次 ——
           而續局的「繼續」(readyUp)正是在這張卡上按的:不擋的話我按下去寫進去的
           ready:true 會被自己**同一個 tick**抹回 false(症狀:按了完全沒反應,
           而 status 已經翻成 lobby,像是只有一半生效)。
         ★ 對七個舊遊戲逐字等價:那時 ready 只可能是 false(準備鈕在對戰中是收起來的),
           重複寫的是同一個值,少寫幾次不改變任何行為。 */
      if(firstShow && meId && roomRef) { ready=false; roomRef.child("players/"+meId).update({ ready:false }); }
      A.refresh && A.refresh();
    }
    function scoreOf(id){ return (scores[id]&&scores[id].n)||0; }
    function scoredRoundOf(id){ return scores[id]&&scores[id].round; }
    function renderScoreboard(){
      const sb=$("winScores"), champEl=$("winChamp"), nsBtn=$("mpNewSeason");
      if(!sb)return;
      const rows=Object.keys(players).map(id=>{
        let score=scoreOf(id);
        // 樂觀加分(分數還沒同步回來就先顯示);沒得分的人 myPts() 是 0 → 與舊行為一致
        if(id===meId && roundId && scoredRoundOf(id)!==roundId) score+=myPts();
        return { id, score, name:dispName(id) };
      }).sort((a,b)=> b.score-a.score || (a.id<b.id?-1:1));
      const top=rows.length?rows[0].score:0;
      const champs=(scoreMode==="match" && top>=winGoal) ? rows.filter(r=>r.score===top) : [];
      if(champEl){
        if(champs.length){
          champEl.innerHTML='<span class="champ-label">🏆 總冠軍</span>'+
            '<span class="champ-name">'+champs.map(c=>esc(c.name)).join("、")+'</span>'+
            '<span class="champ-goal">先達 '+winGoal+' '+SCORE_UNIT+'</span>';
          champEl.classList.remove("hidden");
        }else champEl.classList.add("hidden");
      }
      /* ★ SIGNED 的遊戲(21 點)一律顯示:淨籌碼很可能是 0 或負的,
         而「大家都還沒賺到」不代表這張表沒有資訊。 */
      if(top>0 || scoreMode==="match" || SIGNED){
        const goalCap=(scoreMode==="match" && !champs.length) ? '<div class="ws-goal">🎯 搶 '+winGoal+' '+SCORE_UNIT+'</div>' : '';
        // 本局得分的人:總數之外把「分數是怎麼變的」也講出來,才看得出這局誰得手
        sb.innerHTML=goalCap+rows.map((r,i)=>{
          const lead=r.score===top && (top>0 || SIGNED);
          const cls="ws-row"+(lead?" lead":"")+(r.id===meId?" me":"");
          const add=ptsFor(r.id);
          // ★ SIGNED 的負數要看得出是負的(+ 只加在正數前面)
          const plus=(SIGNED ? add!==0 : add>0) ? '<span class="gw-plus">'+(add>0?"+":"")+add+'</span>' : '';
          return '<div class="'+cls+'"><span class="ws-rank">'+(lead?"🏆":(i+1)+".")+'</span>'+
                 '<span class="ws-name">'+esc(r.name)+'</span>'+plus+'<span class="ws-pts">'+r.score+' '+SCORE_UNIT+'</span></div>';
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
        /* ★ SIGNED 的遊戲不畫這顆 🏆N —— 有正負的數字不是「累積勝場」,
           而且 21 點的 chipTail 自己已經畫了籌碼(同一格位置兩個數字會讀不出誰是誰)。 */
        const scoreBadge=(!SIGNED && sc>0)?'<span class="score-badge" title="累積勝場">🏆'+sc+'</span>':'';
        const extra=((curPhase==="playing" || CHIP_TAIL_IN_LOBBY) && A.chipTail) ? (A.chipTail(id)||"") : "";
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
      // 決定順序中(ORDER_PICK):在等什麼只有狀態列講得出來
      else if(ORDER_PHASE[curPhase]) onStatusTxt(curPhase==="ordering" ? "房主正在排順序…"
                                                : (curPhase==="reveal" ? "猜拳結果揭曉…" : "猜拳決定順序…"));
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
      /* 出手順序那一列(只有 ORDER_PICK 的遊戲有這組 DOM,在各頁的 HTML 裡)。
         ★ 標籤的字由**頁面**決定(data-base):暗棋要講「誰先翻」,牌類講「出手順序」——
           核心只負責在訪客端補上「(房主決定)」與鎖成唯讀。 */
      if(ORDER_PICK){
        const oseg=$("mpOrderSeg");
        if(oseg){
          oseg.classList.toggle("readonly",!isHost);
          [...oseg.children].forEach(b=>b.classList.toggle("on",b.dataset.order===orderMethod));
          const ol=$("mpOrderLabel");
          if(ol){ const base=ol.dataset.base||"出手順序"; ol.textContent=isHost?base:(base+"(房主決定)"); }
        }
      }
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
    function setOrderMethod(m){
      if(!ORDER_PICK)return;
      if(["random","rps","host"].indexOf(m)<0)return;
      if(!setRoomField("orderMethod",m,{ lobbyOnly:true, busyMsg:"對戰中不能改出手順序" }))return;
      orderMethod=m; syncSetup(); savePrefs();
    }
    /* 開打之後公告一次這一局的順序。
       ⚠ 猜拳**不公告** —— 揭曉那張卡已經把誰贏誰輸攤開講完了,再跳一次 toast 是同一句話講兩遍。
       ⚠ order 與 status 是同一份快照原子到齊的(單一 game 節點),所以在 enterPlaying()
         裡叫得到值;orderAnnounced 只是保險(續局的遊戲會重進 enterPlaying)。 */
    function announceOrder(){
      if(!ORDER_PICK||orderAnnounced||!order.length)return;
      orderAnnounced=true;
      if(orderMethod==="rps")return;
      const txt=order.map(id=>dispName(id)).join(" → ");
      showToast((orderMethod==="random"?"🎲 隨機順序:":"👑 房主排的順序:")+txt, 3200);
    }
    function setScoreMode(m){
      if(!isHost||!roomRef)return;
      scoreMode=(m==="match")?"match":"rank"; roomRef.child("scoreMode").set(scoreMode); syncSetup(); savePrefs();
    }
    function setWinGoal(v){
      if(!isHost||!roomRef||seasonInProgress())return;
      winGoal=clampGoal(v); roomRef.child("winGoal").set(winGoal); syncSetup(); savePrefs();
    }
    function resetScores(){
      if(!isHost||!roomRef)return;
      scoredThisRound=false;
      /* ★ v1.97.0:整份清掉,不再只清「現在還在座位上的人」——
         誤按離開的人留下的離席紀錄也是戰績,漏清的話重設完他回來又把舊分數接回去。 */
      roomRef.child("scores").remove();
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
    /* 房主不見了的**兩種**情況(v1.166.0 拆開,之前是同一個判斷、同一個寬限):
         · hostClosed() —— host 這個欄位不見了 = 房主按了離開,房是真的關了(CLAUDE.md 紅線 5)
                           → 沒有「等他回來」這回事,CLOSE_MS 之後直接退出
         · hostAway()   —— host 還在,只是他的 players 那一格被 onDisconnect 移掉了 = 切 App / 斷線
                           → 給滿 GRACE_MS,他一分鐘內回來就當沒事(claimSeat 會把他寫回來) */
    function hostClosed(){ return !isHost && online && sawHost && !hostId; }
    function hostAway(){ return !isHost && online && sawHost && sawPlayers && !!hostId && !players[hostId]; }
    function hostGone(){ return hostClosed() || hostAway(); }
    function recheckWait(){ return hostClosed() ? CLOSE_MS : GRACE_MS; }
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
        /* ★ 重連後重新套用一次 game 快照(v1.177.3)。兩件事靠它:
             ① 離線期間 adapter 的計時器(走棋倒數 / 逾時代打)因為寫入被擋掉而**沒有
                重新排**(armTurnT 只在 applyGame 裡叫)—— 不補這一下就再也不會響;
             ② 順手把 resyncing 窗口裡的真相推一次,不必等對手動作。
           ⚠ 同一份快照重跑對 adapter 是安全的:applyGame 一律從 deal+moves 重算,
             台灣麻將的檔頭本來就明講「房主中途重連會重收一次 over 快照」。 */
        roomRef.child("game").once("value",s=>onGame(s.val()));
      });
    }
    /* ⚠ 已經排了一顆時**只准往前挪、不准往後延**:先看到「房主斷線」(GRACE_MS)、
       接著才收到「房主真的關房」(CLOSE_MS)的話,要照後者立刻走;反過來的順序則不能被拖長,
       否則每次 players 有風吹草動都重排一次 = 寬限期永遠到不了期。 */
    function scheduleRecheck(ms){
      ms=ms||GRACE_MS;
      const at=Date.now()+ms;
      if(graceTimer && at>=graceAt) return;
      clearRecheck(); graceAt=at;
      graceTimer=setTimeout(()=>{ graceTimer=null; recheckPresence(); },ms);
    }
    function clearRecheck(){ if(graceTimer){ clearTimeout(graceTimer); graceTimer=null; } graceAt=0; }
    function recheckPresence(){
      if(!online||!roomRef)return;
      if(iWasKicked() && connected){ showToast("你已被房主移出房間"); leave(); return; }
      if(hostGone()){ showToast(hostClosed()?"房主已離開,房間已關閉":"房主斷線太久,房間已關閉"); leave(); return; }
      if(isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1) hostAloneToLobby();
    }
    function paintAloneCountdown(sec){
      const el=$("mpStatusTxt"); if(!el)return; el.classList.add("wait");
      // 措辭跟著寬限期走:斷線是「可能會回來」,按了離開是「不會回來了」——現場看得懂在等什麼
      el.textContent=(aloneWaitMs<=BYE_MS?"對手離開了,":"對手斷線了,")+sec+" 秒後回到等待…";
    }
    /* 剩下的人全都是「自己按了離開房間」走的嗎?(v1.166.0)
       ⚠ 名單用 **order**(這一局的參賽者)而不是 prevIds:prevIds 在同一個回呼裡早就被
         覆蓋成新的一份,問不出「剛剛不見的是誰」。order 為空(還在決定順序)→ 回 false,
         也就是走保守的長寬限。 */
    function foesByeOnly(){
      const gone=(order||[]).filter(id=>id!==meId && !players[id]);
      return gone.length>0 && gone.every(id=>!!byeIds[id]);
    }
    function scheduleAloneCheck(){
      if(aloneTimer)return;
      aloneWaitMs=foesByeOnly()?BYE_MS:ALONE_MS;
      let left=Math.ceil(aloneWaitMs/1000);
      paintAloneCountdown(left);
      aloneTick=setInterval(()=>{ left--; if(left>0)paintAloneCountdown(left); },1000);
      syncSubrow();   // 對戰中平常收起狀態列,倒數這種盤面上看不到的訊息要放出來
      aloneTimer=setTimeout(()=>{
        aloneTimer=null; if(aloneTick){ clearInterval(aloneTick); aloneTick=null; syncSubrow(); }
        if(isHost && curPhase!=="lobby" && !winner && Object.keys(players).length<=1) hostAloneToLobby();
      },aloneWaitMs);
    }
    // bye 記號比 players 的移除晚到 → 把已經在跑的長寬限縮回短的(只縮不放,免得來回重排永遠不到期)
    function retuneAloneCheck(){
      if(!aloneTimer || aloneWaitMs<=BYE_MS || !foesByeOnly())return;
      clearAloneCheck(); scheduleAloneCheck();
    }
    function clearAloneCheck(){ if(aloneTimer){ clearTimeout(aloneTimer); aloneTimer=null; } if(aloneTick){ clearInterval(aloneTick); aloneTick=null; syncSubrow(); } }
    function hostAloneToLobby(){
      if(curPhase==="lobby")return;
      abandoned=true;
      showToast((aloneWaitMs>BYE_MS?"對手一直沒回來":"對手離開了")+",這局作廢,回到等待…",2600);
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
          ["host","players","game","scoreMode","winGoal","scores","emotes","bye"]
            .concat(ORDER_PICK ? ["orderMethod"] : [])
            .concat(Object.keys(A.roomFields ? A.roomFields() : {}))
            .concat(A.extraNodes || [])
            .forEach(k=>roomRef.child(k).off());
          if(isHost){
            if(meId) roomRef.child("players/"+meId).onDisconnect().cancel();
            roomRef.onDisconnect().cancel();
            if(db&&code){ const ix=db.ref(INDEX+"/"+code); ix.onDisconnect().cancel(); ix.remove(); }
            /* ★★★ v1.147.0:房主離開**不再刪掉整間房**(舊版是 roomRef.remove())。
               使用者:「房主正常關掉的話…我希望不要回收,我要留著這樣才有辦法看到你是誰開的房間」
               —— 首頁那個隱藏的「伺服器狀態」面板就是靠房間節點列出「誰開過哪一間、什麼時候」,
               整間刪掉的話那份紀錄跟著消失(而斷線 / 關分頁本來就留著 → 兩種下場不一致)。
               ★★ 「房間關掉」這件事**沒有變**(CLAUDE.md 紅線 5:房主離開仍然關閉整房):
                 關房的訊號一直是 **host 這個欄位不見了** —— join() 看 `!r.host` 說「已經關閉」、
                 還在房裡的訪客看 hostGone()(hostId 變 null)被退出。所以只要把 host 拿掉,
                 對所有人來說這間房就是關的,不必刪掉整包資料。
               ⚠ 刻意只留「身分與歷史」,live 的部分照樣清掉:
                   host    → null(關房訊號,一定要清)
                   players → null(不然面板會顯示早就離開的人還在裡面)
                   game    → null(deal + moves 是最大的一包,留著只是佔空間)
                   A.extraNodes → null(v1.156.0 補,見下面)
                 留下的是 roomName / createdAt / scores(名字寄生在 scores.nm)+ 這次補的兩筆。
               ⚠ hostName 要在這裡寫:host 只有 pid,而 players 馬上要清掉 →
                 不補這一筆,面板就只知道「有人開過房」卻說不出是誰。
               ⚠⚠ **A.extraNodes 也要清**(v1.156.0 修):create() 的 wipe 早就清了它
                 (見上面 :270),leave() 這一份卻漏了 —— 而上面那句「game 是最大的一包」
                 在你畫我猜身上剛好是錯的:最大的一包是 ink(筆劃),而它正好是 extraNode。
                 漏掉的下場是**每一間「打完就散」的房永久留著最後一回合的全部筆劃**
                 (FLUSH_MS=70、一個 60 秒回合估 ≈ 400 筆 × ~100 B ≈ 40 KB/間):
                 draw 的 sweep() 只刪上一回合,整包 remove 只發生在**下一場** newGame(),
                 所以最後那一回合沒有任何人會刪。
                 受影響的還有 sudoku / mahjong 的 progress、mahjong16 的 tai。
                 ⚠ 連帶:js/home-live.js 的伺服器狀態面板對已關閉的房間是**整包**讀
                   (svGet(rooms/code)),面板每開一次最多下載 30 間 × 40 KB。
               ⚠ 這一段是**雙胞胎**,js/online.js 的 leave() 有對應的一份(紅線 5)——
                 但 Bingo 沒有 extraNodes,所以那一份**刻意**不加這一圈(見它那條註解)。 */
            const ups={ host:null, players:null, game:null, bye:null,
                        hostName:meName||"", closedAt:Date.now() };
            (A.extraNodes||[]).forEach(k=>{ ups[k]=null; });
            roomRef.update(ups);
          }else if(meId){
            const pr=roomRef.child("players/"+meId);
            /* ★ v1.166.0:先留下「我是自己按離開的」記號,再把自己移掉。
               斷線的寬限期拉到一分鐘之後,房主分不出「對手切去 LINE」與「對手不玩了」就只能一律等滿
               —— 這一筆就是差別:當事人還連著的時候自己寫的,看到就等於確定(見檔頭四個寬限期)。
               ⚠ 順序不能反:先 remove 再寫 bye 的話,節點都不在了還替他長回一格 bye 出來。
               ⚠ 記號由重新入座的 claimSeat 清掉(不是這裡),不然自己又溜回來時它會一直算數。 */
            roomRef.child("bye/"+meId).set(true);
            pr.onDisconnect().cancel(); pr.remove();
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
      stopConn(); clearRecheck(); clearAloneCheck(); clearPlayCount();
      resyncing=false; if(resyncTimer){ clearTimeout(resyncTimer); resyncTimer=null; }
      roomRef=null; code=null; online=false; ready=false; isHost=false;
      players={}; scores={}; order=[]; winner=null; status="lobby"; curPhase="lobby";
      byeIds={}; aloneWaitMs=0;
      sawPlayers=false; sawMe=false; sawHost=false; hostId=null; prevIds=null;
      gameRev=0; lastIndexSig=null; outcomeShown=false; abandoned=false;
      scoredThisRound=false; myRoundWin=false; autoStarting=false; emotesReady=false;
      playedRound=null;    // 進新房要歸零(同 gameRev):不然新房第一局剛好同號就不會 enterPlaying
      clearOrderT(); rps=null; revealData=null; orderAnnounced=false;
      { const U=orderUi(); if(U) U.hide(); }
      closeLeaveAsk(); closeKick(); closeResign(); closeEmote(); closeWin();
      disarmBackGuard();   // 已經不在房裡:守衛連同它墊的那一筆歷史一起收掉(不然返回鍵要多按一次)
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
        // ★ v1.69.0 起「自己送的也播」(與 js/online.js 那份同步改)——按了罐頭卻沒聲音,
        // 現場的反應是「是不是沒送出去?」而再按一次。條件用 mine||forMe 而不是 forMe:
        // 送給某一個人時 forMe 為 false,但送出者本人要聽到。上面的即時語音刻意維持不回放。
        if(mine||forMe) enqueueClip(e.clip);
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

    /* ---------- 交給 adapter 的執行環境 ----------
       ★★★ v1.156.0 撤掉五個成員:status / setGame / patchGame / updateReadyBtn / onStatusTxt。
         十一支 adapter 對它們**零呼叫**(函式本體留著,核心內部照樣用)。
         其中兩個不只是沒人用,而是**會繞過 rev 交易紀律的後門**:
           · setGame(g)   —— 非交易寫入,rev 取自本地快照 gameRev+1
           · patchGame(p)  —— 同上,而且連 local 選項都沒有
         兩台同時用它們寫 game 會算出**同一個 rev**,onGame 的 `rev<gameRev` 就會靜靜丟掉
         其中一張快照 —— 那正是踩坑 #1/#3 要消滅的病灶;用 patchGame 寫 winner 更是連
         紅線 15 的補救管道(local:false)都沒有。
         而它們過去就列在 notes/07 那張 ctx 表裡、**與 txGame 並排**,從表上看不出哪個不該用。
       ★ 結論:adapter 要寫 game 節點,**只有 txGame 這一條路**。 */
    const ctx = {
      me:()=>meId, name:()=>meName, players:()=>players, order:()=>order,
      isHost:()=>isHost, phase:()=>curPhase,
      winner:()=>winner, roundId:()=>roundId, abandoned:()=>abandoned,
      dispName, youTag, scoreOf,
      txGame, setRoomField, unreadyOnFieldChange, readyUp,
      renderPlayers, syncSetup, updateGoal,
      maxPlayers:MAX_PLAYERS, minPlayers:MIN_PLAYERS,
      // adapter 自己要讀寫的房內節點(見 A.listen / A.extraNodes);沒進房時回 null
      ref:(path)=>roomRef?roomRef.child(path):null
    };
    A.init && A.init(ctx);
    /* 決定順序的蓋板:把「使用者按了什麼」接回這裡(寫 DB 一律在這一支)。
       ⚠ 只有開了旗標的遊戲才接 —— 另外九頁根本不載入 js/shared/mp-order.js,
         直接引用 MPOrder 會是 ReferenceError。 */
    { const U=orderUi(); if(U) U.attach({ onThrow:throwRps, onConfirm:confirmOrder, onSkip:skipReveal, onBail:bailOrder }); }

    /* ---------- 對外 API(通用部分 + adapter 自己的) ---------- */
    const api = {
      available, openConnect, scanRooms, create, join, joinFromHome, leave,
      toggleReady, again, readyUp,
      isOnline:()=>online, amHost:()=>isHost, amReady:()=>ready,
      setScoreMode, setWinGoal, resetScores,
      winGoal:()=>winGoal, scoreMode:()=>scoreMode,
      // 出手順序(只有 ORDER_PICK 的遊戲用得到;沒開的話 setOrderMethod 是空動作)
      setOrderMethod, orderMethod:()=>orderMethod,
      askResign, confirmResign, cancelResign:closeResign,
      askLeave, confirmLeave, cancelLeave:closeLeaveAsk,
      confirmKick, cancelKick:closeKick,
      roster, sendEmote,
      prefsKey:()=>A.prefsKey,
      emoteAnchor:()=>A.emoteAnchor,
      /* ⚠ orderMethod 只在開了旗標時才進偏好:另外九個遊戲的 bingo.prefs.v1 不要多長一個
         用不到的鍵(五頁共用同一份偏好,見 CLAUDE.md 紅線 12)。 */
      ownPrefs:()=>Object.assign({ scoreMode:scoreMode, winGoal:winGoal },
                                 ORDER_PICK?{ orderMethod:orderMethod }:{},
                                 (A.ownPrefs&&A.ownPrefs())||{}),
      usePrefs(o){
        o=o||{};
        if(o.scoreMode==="match"||o.scoreMode==="rank") scoreMode=o.scoreMode;
        if(typeof o.winGoal==="number"&&o.winGoal>=2) winGoal=Math.min(GOAL_MAX,o.winGoal);
        if(ORDER_PICK&&["random","rps","host"].indexOf(o.orderMethod)>=0) orderMethod=o.orderMethod;
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
     newGame(ids,prev,picked)  房主開局 → 回傳 game 物件(不含 status/winner/roundId,核心會補)
                        picked = 玩家選的出手順序(只有開了 orderPick 才會有;沒開就是 null)。
                        ⚠ 座位有自己規矩的遊戲(輪莊 / 換莊)可以不理它 —— 核心刻意不直接
                          寫 game.order,採不採用由 adapter 決定。
     applyGame(g,playing) 收到新 rev 的 game 快照 → 套用到畫面

   可選:
     minPlayers/maxPlayers(預設 2/2)、hasResign、winCardId
     scoreUnit/goalDefault/goalMax  計分的單位與目標值(v1.76.0 為大老二的名次分加)
     scoreSigned      ★ 分數是有正負的量(v1.84.0 為 21 點的淨籌碼加)——
                        不帶就是舊行為,七個舊遊戲一個字都不受影響。grep SIGNED 看落地的五處。
     contRound        ★ 局間續局(v1.103.0 為台灣麻將加)—— 一局結束不回大廳,
                        結果卡上按一下(或 adapter 倒數到期)就 MP.readyUp(),
                        湊齊由房主開下一局。核心靠 roundId 變了認出新的一局。
                        不帶就是舊行為;adapter 自己決定「最後一局不要續」。
     joinMidGame      ★ 允許對局中加入(v1.84.0 為 21 點加)——
                        同樣不帶就是舊行為。⚠ 要一起改 js/home-live.js 的 joinable()
     orderPick        ★ 出手順序讓玩家選:猜拳 / 隨機 / 房主排(v1.144.0 為暗棋加,
                        第六個能力旗標)。開了之後:
                          · 頁面要載入 js/shared/mp-order.js(蓋板 + 猜拳判定)
                          · 頁面要提供設定列 #mpOrderRow / #mpOrderSeg(三顆 data-order)
                            與標籤 #mpOrderLabel(data-base 決定它叫「誰先翻」還是「出手順序」)
                          · main.js 把那一列接到 MP.setOrderMethod(b.dataset.order)
                          · newGame() 收第三個參數 picked
                        不帶就是舊行為(status 只會有 lobby / playing)。
     adoptId(old,now)  ★ 同名接續時,把遊戲自己那份「per-pid 的一場進度」從舊 pid 搬到新 pid
                        (v1.97.0;核心只負責 scores 節點,見 adoptScore)。
                        只有 21 點需要(bj.nets);其他七個遊戲對局中不能加入 → 回大廳才進得來,
                        那時 game 節點沒有 per-pid 進度 → 不實作就自動跳過。
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
                        msg 當 HTML 塞(可用 <br>/<b>),玩家名字要自己 esc()
     refresh()          畫面重整鉤子(玩家名單變動 / 結果出爐時被呼叫)
     ownPrefs()/usePrefs(o)  遊戲專屬偏好
   ========================================================================== */

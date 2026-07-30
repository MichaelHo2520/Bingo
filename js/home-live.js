"use strict";

/* ============================================================================
   首頁「現在有人在玩」即時看板(v1.52.0)— ★ 只有 index.html 載入這支。

   資料來源就是三個遊戲原有的大廳輕量索引:rooms_index / gomoku_index / sudoku_index
   (每房 4 個小欄位 name/status/count/host,由房主單方維護並掛 onDisconnect().remove())。
   → 不必新增任何寫入、不必新增資料庫規則,就能知道現在誰開著房。

   房間卡點下去直接進那間房:
     • Bingo   → MP.joinFromHome(code,name)(同一頁,先切連線畫面再加入)
     • 另兩個  → <a href="gomoku.html?join=1234">,那頁啟動時由 autoJoinFromQuery() 接手
       ★ 一律用 <a href> 換「iframe 內」的頁面,不可寫成 top.location —— 會把 app.html
         外殼一起換掉,全螢幕就掉了(見 CLAUDE.md 紅線與 notes/01)。

   ⚠ 首頁原本刻意不載 Firebase SDK(秒開)。這裡的折衷是「首頁畫完後才背景載入」:
     首屏不等它;而且離開第一層(進 BINGO 玩法 / 單機 / 連線)或切到背景就 off() 掉監聽,
     不留常駐流量 —— 監聽只在「使用者真的停在遊戲選單」時存在。
   ========================================================================== */
const HomeLive = (function(){

  // max = 可加入的人數上限(要與各遊戲 adapter.js 的 maxPlayers 一致;Bingo 沒有上限 → 0)
  // href = 別頁的遊戲;沒有 href 的就是本頁(Bingo)
  const GAMES=[
    { key:"bingo",   index:"rooms_index",   name:"BINGO",  icon:"🎲", badge:"hlBadgeBingo",   max:0 },
    { key:"gomoku",  index:"gomoku_index",  name:"五子棋", icon:"⚫", badge:"hlBadgeGomoku",  max:2, href:"gomoku.html" },
    { key:"sudoku",  index:"sudoku_index",  name:"數獨",   icon:"🔢", badge:"hlBadgeSudoku",  max:6, href:"sudoku.html" },
    { key:"mahjong", index:"mahjong_index", name:"麻將",   icon:"🀄", badge:"hlBadgeMahjong", max:6, href:"mahjong.html" },
    // ★ max 必須與 js/mahjong16/adapter.js 的 maxPlayers 一致(4)——
    //   不一致的話首頁會把滿房列成「可加入」,點進去才被 claimSeat 交易擋下
    { key:"mj16",    index:"mj16_index",    name:"台灣麻將", icon:"🀄", badge:"hlBadgeMj16", max:4, href:"mahjong16.html" }
  ];

  let refs=[];            // 掛著監聽的 firebase ref(stop 時逐一 off)
  let rooms={};           // key → [{code,status,count,host,name}]
  let booted=false;       // boot() 前一律不碰網路(首屏要先畫完)
  let loading=false;      // SDK 載入中(避免重複觸發)
  let failed=false;       // 讀取失敗過就整塊放棄,不在首頁噴錯嚇人
  let lastSig=null;       // 內容沒變就不重畫(房內叫號會讓索引偶爾回寫)

  /* ---------- 資料整形 ---------- */
  // 與各遊戲大廳同一套判定:還在大廳 且 未滿(max=0 表示無上限)
  function joinable(g,r){ return r.status==="lobby" && (!g.max || r.count<g.max); }
  function itemsOf(idx){
    return Object.keys(idx||{}).map(c=>{
      const r=idx[c]||{};
      return { code:c, status:r.status||"lobby", count:r.count||0, host:r.host||"", name:r.name||"" };
    }).filter(r=>r.count>0).sort((a,b)=>a.code.localeCompare(b.code));
  }

  /* ---------- 畫面 ---------- */
  // 遊戲卡上的小徽章:可加入優先講「幾間可加入」,全都在對戰中就講「對戰中」,沒房間就收起來
  function paintBadge(g){
    const el=$(g.badge); if(!el)return;
    const list=rooms[g.key]||[];
    const open=list.filter(r=>joinable(g,r));
    if(!list.length){ el.classList.add("hidden"); el.textContent=""; return; }
    if(open.length){
      const people=open.reduce((n,r)=>n+r.count,0);
      el.textContent="🟢 "+open.length+" 間可加入 · "+people+" 人";
      el.setAttribute("data-state","open");
    }else{
      el.textContent="🟠 "+list.length+" 間對戰中";
      el.setAttribute("data-state","busy");
    }
    el.classList.remove("hidden");
  }
  // 房間列只列「可加入」的 —— 點下去一定進得去。對戰中的房間只在徽章上交代,
  // 免得首頁列一串點不動的灰列(那是大廳的工作,不是選單的)。
  function buildItem(g,r){
    const nm=r.name||("房間 "+r.code);
    const hostTag=r.host?'<span class="host">👑 '+esc(r.host)+'</span> · ':'';
    const inner='<span class="hl-tag">'+g.icon+' '+esc(g.name)+'</span>'+
      '<span class="room-main"><span class="rn">🏠 '+esc(nm)+'</span>'+
      '<span class="meta">'+hostTag+'👥 '+r.count+' 人</span></span>'+
      '<span class="join-cta">加入 ▸</span>';
    let el;
    if(g.href){
      // 別頁的遊戲:帶房號過去(換的是 iframe 內的頁面,外殼不動 → 全螢幕不掉)
      el=document.createElement("a");
      el.className="room-item joinable hl-item";
      el.href=g.href+"?join="+encodeURIComponent(r.code);
    }else{
      el=document.createElement("button");
      el.type="button"; el.className="room-item joinable hl-item";
      el.addEventListener("click",()=>MP.joinFromHome(r.code,r.name));
    }
    el.innerHTML=inner;
    return el;
  }
  function paint(){
    const box=$("hlLive"), list=$("hlRooms"), head=$("hlHeadTxt");
    if(!box||!list)return;
    GAMES.forEach(paintBadge);
    const open=[];
    GAMES.forEach(g=>(rooms[g.key]||[]).filter(r=>joinable(g,r)).forEach(r=>open.push({g:g,r:r})));
    if(!open.length){ box.classList.add("hidden"); list.innerHTML=""; return; }
    list.innerHTML="";
    open.forEach(o=>list.appendChild(buildItem(o.g,o.r)));
    if(head) head.textContent="現在有人在玩 · "+open.length+" 間可加入";
    box.classList.remove("hidden");
  }
  // 三個節點任一有變動就整份重算(資料量是「幾間房 × 4 個欄位」,重算比增量維護划算)
  function apply(){
    const sig=GAMES.map(g=>g.key+"="+(rooms[g.key]||[]).map(r=>r.code+":"+r.status+":"+r.count+":"+r.host+":"+r.name).join(",")).join("|");
    if(sig===lastSig)return;
    lastSig=sig;
    paint();
  }
  function hideAll(){
    const box=$("hlLive"); if(box) box.classList.add("hidden");
    GAMES.forEach(g=>{ const el=$(g.badge); if(el){ el.classList.add("hidden"); el.textContent=""; } });
  }

  /* ---------- 監聽的開關 ---------- */
  function stop(){
    refs.forEach(ref=>{ try{ ref.off(); }catch(e){} });
    refs=[];
  }
  function start(){
    if(failed || refs.length || loading)return;
    // ★ 守門只能問「config 填了沒」(configured = configReady)。
    //   不可以用 MP.available() —— 它還要求 window.firebase 已存在,而首頁刻意還沒載 SDK,
    //   於是第一次進首頁永遠 return、看板不出現;只有先進過一次連線對戰(SDK 被載進來)
    //   再退回首頁才會冒出來。v1.52.1 修的就是這個。
    if(!MP.configured || !MP.configured())return;   // 沒設定 Firebase → 首頁就當沒這功能
    loading=true;
    MP.ensureLib().then(()=>{
      loading=false;
      if(!onHomePick())return;                    // 載入期間人已經離開第一層 → 不掛監聽
      const db=MP.database(); if(!db){ failed=true; return; }
      GAMES.forEach(g=>{
        const ref=db.ref(g.index);
        refs.push(ref);
        ref.on("value", s=>{ rooms[g.key]=itemsOf(s.val()); apply(); }, err=>{
          // 規則沒開放讀取之類 → 靜靜收掉整塊(首頁不該出現 Permission denied)
          failed=true; stop(); hideAll();
          console.warn("[HomeLive] "+g.index+" 讀取失敗:"+((err&&err.message)||err));
        });
      });
    }).catch(()=>{ loading=false; failed=true; });   // SDK 載不到(離線)→ 首頁維持原樣
  }
  /* ---------- 「人在不在遊戲選單第一層」---------- */
  // 刻意用 MutationObserver 觀察 #home / #homePick 的 class,而不是去 js/game.js 的
  // 各個切畫面函式插呼叫:首頁被藏起來的路徑有好幾條(enterSolo / openConnect / enterLobby),
  // 插呼叫遲早會漏一條 → 監聽就永遠掛著。觀察 class 是唯一不會漏的做法,也不必動 Bingo 核心。
  function onHomePick(){
    const h=$("home"), p=$("homePick");
    return !!h && !h.classList.contains("hidden") && !!p && !p.classList.contains("hidden");
  }
  // 只在「已 boot 且 停在第一層 且 分頁在前景」時監聽;其餘一律卸載
  function sync(){
    if(booted && onHomePick() && !document.hidden) start();
    // 卸載時連本地資料一起丟掉:留著的話下次回首頁會先閃一輪「可能已經關掉的房間」
    else { stop(); rooms={}; lastSig=null; hideAll(); }
  }

  document.addEventListener("visibilitychange",sync);

  /* ---------- 啟動 ----------
     刻意延後:首頁要先畫完(首屏不等 Firebase SDK)。requestIdleCallback 沒有就退回 setTimeout。 */
  function boot(){
    if(window.MutationObserver){
      const ob=new MutationObserver(()=>sync());
      ["home","homePick"].forEach(id=>{ const el=$(id); if(el) ob.observe(el,{attributes:true,attributeFilter:["class"]}); });
    }
    const go=()=>{ booted=true; sync(); };
    if(window.requestIdleCallback) requestIdleCallback(go,{timeout:2500});
    else setTimeout(go,1200);
  }

  return { boot, stop, sync };
})();

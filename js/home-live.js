"use strict";

/* ============================================================================
   首頁的兩件事 — ★ 只有 index.html 載入這支。
     ① 「現在有人在玩」即時看板(v1.52.0)
     ② 九張遊戲卡的**熱門度排序 + 一~九編號**(v1.112.0,見下面那整段說明)
   兩件事共用同一次 Firebase 載入,但**彼此獨立**:任一邊讀失敗都不可以拖垮另一邊。

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
    { key:"mj16",    index:"mj16_index",    name:"台灣麻將", icon:"🀄", badge:"hlBadgeMj16", max:4, href:"mahjong16.html" },
    // ★ max 必須與 js/sevens/adapter.js 的 maxPlayers 一致(6)
    { key:"sevens",  index:"sevens_index",  name:"排七", icon:"🎴", badge:"hlBadgeSevens", max:6, href:"sevens.html" },
    // ★ max 必須與 js/big2/adapter.js 的 maxPlayers 一致(4)—— 大老二每人 13 張,4 人剛好用完 52 張
    // ⚠ icon 用 🎴(U+1F3B4),**不是**小丑牌那顆(U+1F0CF)—— 後者落在
    //   U+1F0A0–U+1F0FF 那段撲克牌字元裡,多數字型沒有會變豆腐方框(CLAUDE.md 的禁令)。
    //   與排七同一個圖示是刻意的 —— 同一副撲克牌,而消消樂與台灣麻將本來也共用 🀄。
    { key:"big2",    index:"big2_index",    name:"大老二", icon:"🎴", badge:"hlBadgeBig2", max:4, href:"big2.html" },
    /* ★ max 必須與 js/blackjack/adapter.js 的 maxPlayers 一致(v1.86.0 起是 **6**)。
       ★★ joinMid:true 是這張表的**第一個遊戲專屬能力旗標**(v1.84.0)——
          21 點一場 = 很多局,對戰中也可以加入(新人下一局進場),
          所以「可加入」的判定與其他七個不同。
          ⚠ 它必須與 adapter 的 joinMidGame 一致:不一致的話首頁會把進得去的房間
            列成「對戰中」(反過來則是列成可加入、點進去被擋)。 */
    /* ⚠ name 是**顯示名**(v1.86.0 從「21點」改成「台式21點」)——
       index / key / href 這三個是**資料與路徑**,一個字都不准跟著改。 */
    { key:"bj",      index:"bj_index",      name:"台式21點", icon:"🎴", badge:"hlBadgeBj",   max:5, href:"blackjack.html", joinMid:true },
    /* ★ 第九個遊戲(v1.106.0)。max 必須與 js/uno/adapter.js 的 maxPlayers 一致(**6**)。
       ⚠ icon 用 🌈(U+1F308)—— UNO 的識別就是四個顏色,而且它與另外八個都不撞。
         **不可以用 🃏**(U+1F0CF):它落在 U+1F0A0–U+1F0FF 那段撲克牌字元裡,
         多數字型沒有會變豆腐方框(CLAUDE.md 紅線 8)。
       ⚠ UNO **不帶 joinMid** —— 一局就是一局(不像 21 點一場很多局),對戰中不給加入。 */
    { key:"uno",     index:"uno_index",     name:"UNO",     icon:"🌈", badge:"hlBadgeUno",  max:6, href:"uno.html" }
  ];

  /* ==========================================================================
     熱門度排序(v1.112.0)—— 九張遊戲卡依「這個遊戲被真的玩過幾場」由多到少排,
     卡片左上角標一~九。

     資料是 Firebase 的 game_stats/{key}/n:房主開房、**真的開局**、**撐過 30 秒**才 +1,
     一間房只記一次(寫入在 js/shared/mp-core.js 與 js/online.js 的 armPlayCount())。
     ⚠ 這裡的 key 必須與那兩支寫進去的一致 —— 八個遊戲是 INDEX 去掉 "_index"
       (gomoku_index → gomoku),Bingo 那一支寫死 "bingo"。

     ★ 三個刻意的決定:
       ① **同分維持 GAMES 的順序**(穩定排序)。全新的資料庫是九個都 0,那時版面必須
          與改版前逐字相同 —— 不可以讓 sort 的不穩定造成「每次開首頁順序都不一樣」。
       ② **不當場重排**:讀到的新排名先存進 localStorage,**下次進首頁**才套用。
          九張卡在手指底下忽然換位置會按錯遊戲;而從遊戲頁回首頁走的是 <a href>
          (整頁重載),所以「玩完一局回來就生效」,體感上仍然是自動的。
          唯一的例外是「這台還沒有任何排名快取」(第一次用)→ 讀到就直接套,
          否則第一次用的人永遠停在預設順序。
       ③ **讀失敗一律安靜**:規則沒開放 game_stats 時就維持預設順序,而且
          **不可以**去碰 failed / stop() —— 那是 *_index 看板的旗標,
          被這裡誤觸會連「現在有人在玩」整塊一起消失。
     ========================================================================== */
  const RANK_KEY="bingo.gamerank.v1";
  const RANK_NUM=["一","二","三","四","五","六","七","八","九"];
  let rankHadCache=false;

  function cardOf(k){ return document.querySelector('.game-card[data-gk="'+k+'"]'); }
  // → [[key, 場數], …] 由多到少;同場數照 GAMES 的原順序
  function rankRows(stats){
    return GAMES.map((g,i)=>[g.key, (stats&&stats[g.key]&&stats[g.key].n)||0, i])
      .sort((a,b)=>(b[1]-a[1])||(a[2]-b[2]))
      .map(r=>[r[0],r[1]]);
  }
  /* 只設 style.order 與徽章文字,**不搬 DOM**:搬動節點會讓 hl-badge 那顆
     與 :hover / :active 一起跳,而 .gc-grid 是 grid、order 完全夠用。 */
  function applyRank(rows){
    const hot=rows.some(r=>r[1]>0);   // 一場都還沒玩過 → 不點亮前三名(那會是假的「最熱門」)
    rows.forEach((r,i)=>{
      const el=cardOf(r[0]); if(!el)return;
      el.style.order=String(i);
      const b=el.querySelector(".gc-rank");
      if(b){ b.textContent=RANK_NUM[i]||""; b.setAttribute("data-top",(hot&&i<3)?String(i+1):"0"); }
    });
  }
  // 快取要對得上目前這九個遊戲;加了新遊戲 / 改了 key 就整份作廢回預設(不然新遊戲沒有 order)
  function saneRank(rows){
    if(!Array.isArray(rows) || rows.length!==GAMES.length) return null;
    const seen={}; rows.forEach(r=>{ if(Array.isArray(r)) seen[r[0]]=1; });
    return GAMES.every(g=>seen[g.key]) ? rows : null;
  }
  function readRank(){ try{ return saneRank(JSON.parse(localStorage.getItem(RANK_KEY))); }catch(e){ return null; } }
  function saveRank(rows){ try{ localStorage.setItem(RANK_KEY,JSON.stringify(rows)); }catch(e){} }
  // 讀一次就好:排名不必即時,常駐監聽只會讓卡片在手指底下跳(見上面的決定 ②)
  function fetchRank(db){
    try{
      db.ref("game_stats").once("value", s=>{
        const rows=rankRows(s.val()||{});
        saveRank(rows);
        if(!rankHadCache){ rankHadCache=true; applyRank(rows); }
      }, ()=>{});
    }catch(e){}
  }

  let refs=[];            // 掛著監聽的 firebase ref(stop 時逐一 off)
  let rooms={};           // key → [{code,status,count,host,name}]
  let booted=false;       // boot() 前一律不碰網路(首屏要先畫完)
  let loading=false;      // SDK 載入中(避免重複觸發)
  let failed=false;       // 讀取失敗過就整塊放棄,不在首頁噴錯嚇人
  let lastSig=null;       // 內容沒變就不重畫(房內叫號會讓索引偶爾回寫)

  /* ---------- 資料整形 ---------- */
  /* 與各遊戲大廳同一套判定:還在大廳 且 未滿(max=0 表示無上限)。
     ★ g.joinMid 的遊戲(21 點)連「對戰中」也算可加入 —— 見 GAMES 那一列的說明。
     ⚠ 這一份與 js/shared/mp-core.js 的 joinable() 是**同一條判定的兩份**:
       改一邊要改另一邊(首頁不載入 js/shared/,所以去不掉這一份)。 */
  function joinable(g,r){
    const ok = r.status==="lobby" || (g.joinMid && r.status==="playing");
    return ok && (!g.max || r.count<g.max);
  }
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
      fetchRank(db);                              // 熱門度排名:一次性讀取,失敗不影響下面的看板
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

  /* 排名要在**首屏**就套上去,所以不等 boot():這支的 <script> 在 </body> 之前,
     九張卡早就在 DOM 裡了。沒有快取(第一次用 / 剛清過)就照 GAMES 的預設順序,
     與 index.html 裡寫死的那九個字逐一對上 → 首屏不會閃一下再重排。 */
  function initRank(){
    const rows=readRank();
    rankHadCache=!!rows;
    applyRank(rows || GAMES.map(g=>[g.key,0]));
  }
  initRank();

  /* ⚠ initRank / applyRank / rankRows 是**為了守門而導出**的:排名的行為分岔在
     「這台有沒有快取」,而 e2e 跑在 file:// 上、localStorage 會跨次數留著 ——
     測試要能把它清掉再回到「第一次用」的狀態,否則那條路徑靜靜地永遠測不到。 */
  return { boot, stop, sync, initRank, applyRank, rankRows };
})();

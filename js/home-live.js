"use strict";

/* ============================================================================
   首頁的兩件事 — ★ 只有 index.html 載入這支。
     ① 「現在有人在玩」即時看板(v1.52.0)
     ② 遊戲卡的**熱門度排序 + 編號**(v1.112.0,見下面那整段說明)
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

  /* 排七 / 大老二 / 台式21點三個撲克牌遊戲原本共用同一顆 🎴,清單裡三行長得一模一樣、
     只能靠名字分(使用者:「這三個的表示圖我不是很喜歡」)。改成各一張迷你撲克牌 SVG
     (跟首頁大圖 .pk-ic-* 同一套畫法、同一份花色 path,只是縮成單張小卡),
     牌面挑遊戲最具代表性的那張:排七=起始牌 ♠︎7、大老二=最大牌 ♥︎2、21點=關鍵牌 ♦︎A。
     座標公式抄自首頁大圖(見 index.html 排七/大老二/21點那三段 SVG 的註解):
     card 在 (X,Y)、21×30、rx2.7 時,點數文字在 (X+10.5, Y+13),
     花色 <g> 是 translate(X+6.5, Y+15.4) scale(.08)——這裡固定用 (1.5,2) 當 X,Y,
     viewBox 「0 0 24 34」四邊留白對稱。★ class 沿用既有的 .pk-ic-*(styles.css 排七
     那一段),不必新增卡面樣式;只有外層 .hl-card-ic 是新的,管行內對齊與間距。 */
  const PK_SUIT={
    spade:'<path d="M50 9C50 9 88 40 88 61c0 12-9 20-20 20-7 0-13-4-18-10-5 6-11 10-18 10-11 0-20-8-20-20C12 40 50 9 50 9z"/><path d="M50 66c0 12-4 21-11 27h22c-7-6-11-15-11-27z"/>',
    heart:'<path d="M50 90S10 62 10 36C10 22 21 12 34 12c8 0 14 5 16 11 2-6 8-11 16-11 13 0 24 10 24 24 0 26-40 54-40 54z"/>',
    diamond:'<path d="M50 6 86 50 50 94 14 50z"/>'
  };
  function miniCard(rank,suit,red){
    const cls=red?" pk-ic-red":"";
    return '<svg class="hl-card-ic" viewBox="0 0 24 34" width="15" height="21" aria-hidden="true">'+
      '<rect class="pk-ic-bd" x="1.5" y="2" width="21" height="30" rx="2.7"/>'+
      '<text class="pk-ic-t'+cls+'" x="12" y="15">'+rank+'</text>'+
      '<g class="pk-ic-s'+cls+'" transform="translate(8 17.4) scale(.08)">'+PK_SUIT[suit]+'</g>'+
    '</svg>';
  }

  /* max = 可加入的人數上限(要與各遊戲 adapter.js 的 maxPlayers 一致)。
     ⚠ Bingo 沒有 adapter —— 它的那一份在 `js/online.js` 的 **MAX_PLAYERS**,兩邊要一致。
       v1.183.0 之前 Bingo 是 0(= 沒有上限);改成 6 的動機是即時語音:
       mesh 的連線數是 N(N−1)/2,6 人 15 條,再多手機撐不住(10 人就 45 條)。 */
  // href = 別頁的遊戲;沒有 href 的就是本頁(Bingo)
  const GAMES=[
    { key:"bingo",   index:"rooms_index",   rooms:"rooms",         name:"BINGO",  icon:"🎲", badge:"hlBadgeBingo",   max:6 },
    { key:"gomoku",  index:"gomoku_index",  rooms:"gomoku_rooms",  name:"五子棋", icon:"⚫", badge:"hlBadgeGomoku",  max:2, href:"gomoku.html" },
    { key:"sudoku",  index:"sudoku_index",  rooms:"sudoku_rooms",  name:"數獨",   icon:"🔢", badge:"hlBadgeSudoku",  max:6, href:"sudoku.html" },
    { key:"mahjong", index:"mahjong_index", rooms:"mahjong_rooms", name:"麻將",   icon:"🀄", badge:"hlBadgeMahjong", max:6, href:"mahjong.html" },
    // ★ max 必須與 js/mahjong16/adapter.js 的 maxPlayers 一致(4)——
    //   不一致的話首頁會把滿房列成「可加入」,點進去才被 claimSeat 交易擋下
    { key:"mj16",    index:"mj16_index",    rooms:"mj16_rooms",    name:"台灣麻將", icon:"🀄", badge:"hlBadgeMj16", max:4, href:"mahjong16.html" },
    // ★ max 必須與 js/sevens/adapter.js 的 maxPlayers 一致(6)
    // icon 是迷你 ♠︎7(見上面 miniCard 那段說明)—— 起始牌,呼應「排七」這個名字
    { key:"sevens",  index:"sevens_index",  rooms:"sevens_rooms",  name:"排七", icon:miniCard("7","spade",false), badge:"hlBadgeSevens", max:6, href:"sevens.html" },
    // ★ max 必須與 js/big2/adapter.js 的 maxPlayers 一致(4)—— 大老二每人 13 張,4 人剛好用完 52 張
    // icon 是迷你 ♥︎2 —— 2 是這個遊戲最大的牌。三個撲克牌遊戲原本共用 🎴(v1.136.1 以前),
    // 使用者反饋「三個表示圖不喜歡」才各自換成獨立牌面(v1.136.2)。
    { key:"big2",    index:"big2_index",    rooms:"big2_rooms",    name:"大老二", icon:miniCard("2","heart",true), badge:"hlBadgeBig2", max:4, href:"big2.html" },
    /* ★ max 必須與 js/blackjack/adapter.js 的 maxPlayers 一致(v1.86.0 起是 **6**)。
       ★★ joinMid:true 是這張表的**第一個遊戲專屬能力旗標**(v1.84.0)——
          21 點一場 = 很多局,對戰中也可以加入(新人下一局進場),
          所以「可加入」的判定與其他七個不同。
          ⚠ 它必須與 adapter 的 joinMidGame 一致:不一致的話首頁會把進得去的房間
            列成「對戰中」(反過來則是列成可加入、點進去被擋)。 */
    /* ⚠ name 是**顯示名**(v1.86.0 從「21點」改成「台式21點」)——
       index / key / href 這三個是**資料與路徑**,一個字都不准跟著改。 */
    // icon 是迷你 ♦︎A —— 21 點裡最關鍵的一張牌
    /* ⚠⚠ v1.156.0 修:這一列的 max 從 v1.86.0 起就漏跟 adapter(停在 5,而 adapter 是 6)。
       症狀是首頁把 5 人的 21 點房間當成滿房**整列藏起來**,第六個人在首頁看到的結論是「滿了」,
       而 blackjack.html 的大廳與核心 MAX_PLAYERS 一直是對的 → 兩個入口互相矛盾。
       21 點又是十三個裡唯一開 joinMidGame 的一個,壞掉的正是它最主要的使用情境。
       ★ 守門在 tools/test-twins.js 第四節:GAMES 每一列的 max / joinMid 對 adapter 逐一比。 */
    { key:"bj",      index:"bj_index",      rooms:"bj_rooms",      name:"台式21點", icon:miniCard("A","diamond",true), badge:"hlBadgeBj",   max:6, href:"blackjack.html", joinMid:true },
    /* ★ 第九個遊戲(v1.106.0)。max 必須與 js/uno/adapter.js 的 maxPlayers 一致(**6**)。
       ⚠ icon 用 🌈(U+1F308)—— UNO 的識別就是四個顏色,而且它與另外八個都不撞。
         **不可以用 🃏**(U+1F0CF):它落在 U+1F0A0–U+1F0FF 那段撲克牌字元裡,
         多數字型沒有會變豆腐方框(CLAUDE.md 紅線 8)。
       ⚠ UNO **不帶 joinMid** —— 一局就是一局(不像 21 點一場很多局),對戰中不給加入。 */
    { key:"uno",     index:"uno_index",     rooms:"uno_rooms",     name:"UNO",     icon:"🌈", badge:"hlBadgeUno",  max:6, href:"uno.html" },
    /* ★ 第十個遊戲(v1.113.0):象棋暗棋。
       max 必須與 js/darkchess/adapter.js 的 maxPlayers 一致(**2**)。
       ⚠ icon 用 🔴(U+1F534 紅圓)—— 紅方是象棋兩方之一,而且它與另外九個都不撞
         (五子棋已經是 ⚫)。**不可以用象棋 / 西洋棋那些符號**：
         U+2654–U+265F 那一段在很多 Android 字型上是文字呈現、粗細跟周圍對不齊,
         而 U+1F000 / U+1F0A0 那兩段直接是豆腐方框(CLAUDE.md 紅線 8)。
       ⚠ 暗棋 **不帶 joinMid** —— 一局就是一局,對戰中不給加入。
       ⚠⚠ key 用 "dc" 不是 "darkchess"(v1.118.1 修正)——
         game_stats 的 key 是 js/shared/mp-core.js 的 armPlayCount() 拿 INDEX 去掉
         "_index" 算出來的(dc_index → dc),這裡若寫 "darkchess" 兩邊對不上,
         暗棋的熱門度會永遠讀不到(dc:{n:1} 寫進資料庫,rankRows() 卻查
         stats["darkchess"])。其他九個遊戲的 index 縮寫本來就等於 key,只有這裡曾經例外。 */
    { key:"dc", index:"dc_index",    rooms:"dc_rooms",      name:"暗棋",   icon:"🔴", badge:"hlBadgeDc",   max:2, href:"darkchess.html" },
    /* ★ 第十一個遊戲(v1.135.0):成語接龍(交叉填字盤)。
       max 必須與 js/chengyu/adapter.js 的 maxPlayers 一致(**6**)。
       ⚠ icon 用 🧩(U+1F9E9 拼圖片)—— 呼應「交叉填字」,且與另外十個都不撞
         (🎲⚫🔢🀄🀄🎴🎴🌈🔴)。不落在 U+1F000 / U+1F0A0 那兩段禁區(CLAUDE.md 紅線 8)。
       ⚠ 成語接龍 **不帶 joinMid** —— 一場一局,對戰中不給加入(比照 UNO / 暗棋)。 */
    { key:"chengyu", index:"chengyu_index", rooms:"chengyu_rooms", name:"成語接龍", icon:"🧩", badge:"hlBadgeChengyu", max:6, href:"chengyu.html" },
    /* ★ 第十二個遊戲(v1.154.0):你畫我猜。
       max 必須與 js/draw/adapter.js 的 maxPlayers 一致(**6**)。
       ⚠⚠ key / index / rooms / 圖檔 / CSS 前綴**一律用同一個縮寫 dw** ——
         key 必須等於 index 去掉 "_index"(dw_index → dw),不一致的話 game_stats 永遠對不上,
         那個遊戲的熱門度永遠是 0 而**沒有任何測試會紅**(暗棋 v1.118.1 踩過)。
         index.html 那張卡的 data-gk 也是 "dw"(applyRank 是靠它找卡片的)。
       ⚠ icon 用 🎨(U+1F3A8 調色盤)—— 與另外十一個都不撞(🎲⚫🔢🀄🀄🎴🎴🌈🔴🧩),
         也不落在 U+1F000 / U+1F0A0 那兩段禁區(CLAUDE.md 紅線 8)。
       ⚠ **不帶 joinMid** —— 一場就是一場(每人要當滿 N 次畫家),中途進來的人湊不齊次數;
         這一條要與 adapter 沒有開 joinMidGame 保持一致。 */
    { key:"dw", index:"dw_index", rooms:"dw_rooms", name:"你畫我猜", icon:"🎨", badge:"hlBadgeDraw", max:6, href:"draw.html" },
    /* ★ 第十三個遊戲(v1.179.0):飛行棋。
       max 必須與 js/flychess/adapter.js 的 maxPlayers 一致(**4** —— 盤面只有四個機場)。
       ⚠⚠ key / index / rooms / 圖檔 / CSS 前綴**一律用同一個縮寫 fc** ——
         key 必須等於 index 去掉 "_index"(fc_index → fc),不一致的話 game_stats 永遠對不上,
         那個遊戲的熱門度永遠是 0 而**沒有任何測試會紅**(暗棋 v1.118.1 踩過)。
         index.html 那張卡的 data-gk 也是 "fc"(applyRank 是靠它找卡片的)。
       ⚠ icon 用 ✈️(U+2708 + U+FE0F)—— 與另外十二個都不撞(🎲⚫🔢🀄🀄🎴🎴🌈🔴🧩🎨),
         也不落在 U+1F000 / U+1F0A0 那兩段禁區(CLAUDE.md 紅線 8)。
       ⚠ **不帶 joinMid** —— 飛機已經在盤上跑了,中途進來的人沒有位置(比照 UNO / 暗棋);
         這一條要與 adapter 沒有開 joinMidGame 保持一致。 */
    { key:"fc", index:"fc_index", rooms:"fc_rooms", name:"飛行棋", icon:"✈️", badge:"hlBadgeFly", max:4, href:"flychess.html" },
    /* ★ 第十四個遊戲(v1.180.0):跳棋(中國跳棋 · 六角星)。
       max 必須與 js/tiaoqi/adapter.js 的 maxPlayers 一致(**6** —— 六角星有六個角)。
       ⚠ 同上一條的紀律:key / index / rooms / 圖檔 / CSS 前綴一律同一個縮寫 tq,
         而且 key 必須等於 index 去掉 "_index"。index.html 那張卡的 data-gk 也是 "tq"。
       ⚠ icon 用 ⬢(U+2B22 黑色六邊形)—— 與另外十三個都不撞(🎲⚫🔢🀄🀄🎴🎴🌈🔴🧩🎨✈️),
         也不落在 U+1F000 / U+1F0A0 那兩段禁區(CLAUDE.md 紅線 8)。
       ⚠ **不帶 joinMid** —— 棋子已經在盤上,中途進來的人沒有角可以坐(比照 UNO / 暗棋 / 飛行棋)。 */
    { key:"tq", index:"tq_index", rooms:"tq_rooms", name:"跳棋", icon:"⬢", badge:"hlBadgeTq", max:6, href:"tiaoqi.html" }
  ];

  /* ==========================================================================
     熱門度排序(v1.112.0)—— 遊戲卡依「這個遊戲被真的玩過幾場」由多到少排,
     卡片左上角標編號(v1.113.1 起是阿拉伯數字,原本是一~十的國字;人數隨遊戲增加自動跟著長)。

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
  let rankHadCache=false;

  function cardOf(k){ return document.querySelector('.game-card[data-gk="'+k+'"]'); }
  // → [[key, 場數], …] 由多到少;同場數照 GAMES 的原順序
  function rankRows(stats){
    return GAMES.map((g,i)=>[g.key, (stats&&stats[g.key]&&stats[g.key].n)||0, i])
      .sort((a,b)=>(b[1]-a[1])||(a[2]-b[2]))
      .map(r=>[r[0],r[1]]);
  }
  /* 只設 style.order 與徽章文字,**不搬 DOM**:搬動節點會讓 hl-badge 那顆
     與 :hover / :active 一起跳,而 .gc-grid 是 grid、order 完全夠用。
     ⚠ 編號是**阿拉伯數字**(v1.113.1 由一~十的國字改過來,使用者要求),
       而且是**算出來的**不是查表 —— 原本那張 RANK_NUM 表每加一個遊戲就得補一個字,
       漏補的症狀是最後那張卡的徽章變空白(v1.113.0 就差點漏掉「十」)。 */
  function applyRank(rows){
    const hot=rows.some(r=>r[1]>0);   // 一場都還沒玩過 → 不點亮前三名(那會是假的「最熱門」)
    rows.forEach((r,i)=>{
      const el=cardOf(r[0]); if(!el)return;
      el.style.order=String(i);
      const b=el.querySelector(".gc-rank");
      if(b){ b.textContent=String(i+1); b.setAttribute("data-top",(hot&&i<3)?String(i+1):"0"); }
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
  /* 遊戲卡右上角的小徽章:可加入優先算「幾間可加入」,全都在對戰中就算「幾間對戰中」,
     沒房間就收起來。

     ★★ v1.176.0:文字從「🟢 2 間可加入 · 11 人」縮成**只剩房間數**(顏色講剩下那一半)。
       原本那一長串帶 white-space:nowrap,而 .gc-grid 的欄寬是 1fr(= minmax(auto,1fr),
       auto 最小值 = min-content)→ 那一欄被撐開、**把別欄的寬度搶走**:390px 直向實測
       三欄變成 61 / 143 / 105px,BINGO 剩 61px、「象棋暗棋」擠成兩行。
       使用者:「這個的顯示把其他的項目變得很奇怪」。
       CSS 那邊同時把徽章改成絕對定位、欄寬改成 minmax(0,1fr)(見 styles.src.css);
       這裡負責的是「別再塞得下那麼多字」。
     ★ 完整那句話沒有消失,改掛在 title / aria-label:滑鼠停留與讀螢幕照樣拿得到,
       而房名 / 人數 / 房主本來就在上面那塊「現在有人在玩」看板裡一列一間。
     ⚠ 徽章文字**只放數字**,那顆狀態點是 CSS 的 ::before 畫的 —— 不要改回 🟢 / 🟠 emoji:
       各裝置的 emoji 字型大小與基線都不同,在右上角這麼小的一顆上對不齊。 */
  function paintBadge(g){
    const el=$(g.badge); if(!el)return;
    const list=rooms[g.key]||[];
    const open=list.filter(r=>joinable(g,r));
    if(!list.length){
      el.classList.add("hidden"); el.textContent="";
      el.removeAttribute("title"); el.removeAttribute("aria-label");
      return;
    }
    let full;
    if(open.length){
      const people=open.reduce((n,r)=>n+r.count,0);
      el.textContent=String(open.length);
      full=open.length+" 間可加入 · "+people+" 人";
      el.setAttribute("data-state","open");
    }else{
      el.textContent=String(list.length);
      full=list.length+" 間對戰中";
      el.setAttribute("data-state","busy");
    }
    el.setAttribute("title",g.name+" · "+full);
    el.setAttribute("aria-label",g.name+" · "+full);
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
      '<span class="join-cta">加入</span>';
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
    GAMES.forEach(g=>{ const el=$(g.badge); if(el){
      el.classList.add("hidden"); el.textContent="";
      el.removeAttribute("title"); el.removeAttribute("aria-label");   // 徽章的完整說明也要一起收(見 paintBadge)
    } });
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

  /* ==========================================================================
     伺服器狀態(隱藏管理面板)—— 點 7 下首頁「派對遊戲」字樣開啟
     (仿 Android「連按版本號 7 下」開發者選項的手勢),只給自己排查資料庫用,
     不出現在任何一般玩家會走到的路徑上。

     ★ 內容:十一個遊戲各自「大廳現役房數 / 已關閉房數 / 累積人氣場次」+ **每一間房的
       房名、誰開的、幾個人、什麼時候開的**(v1.147.0 起連現役房間也列),
       外加兩組**各自獨立**的清除——「清除已關閉的房間」與「清除統計紀錄」,
       每個遊戲各一顆、外加各一顆全部清除,互不影響:對戰結束、房間關掉
       之後不會自動清掉統計,想留著回顧就留著,要清哪一種自己按。
     ★ 讀取一律走**公開 REST**(fetch databaseURL/*.json),不透過 Firebase SDK:
       這幾個節點的 .read 本來就是 true(見 notes/firebase-rules.json),REST 不必
       等 SDK 下載/初始化,開面板不會被「還沒連線對戰過」卡住。清除也是同一顆
       REST 的 DELETE method,跟 App 本來刪房間走的是同一條規則,
       不必也不會改資料庫規則。
     ★★★ 「已關閉的房間」= 房間節點裡有、但大廳 index 裡已經沒有的房間代碼。
       **房間資料現在永遠不會自動消失**(v1.147.0):armRoomIndex() 只把
       onDisconnect().remove() 掛在 INDEX 上(見上面 ★★ 那段),斷線 / 關分頁 / 砍視窗
       只會讓大廳項目消失;而房主按「離開房間」也**只把 host 清掉關房**,不再刪掉整包
       (使用者:「我希望不要回收,我要留著這樣才有辦法看到你是誰開的房間」)。
       → 這一頁就是那份紀錄的唯一入口,而清掉它們的唯一辦法是這裡的按鈕。
     ★ game_stats 的人氣計數是完全獨立的另一件事(armPlayCount(),只認「真的開局撐過
       30 秒」),與房間數本來就對不上,不必因為對不起來就懷疑計數邏輯壞了。
     ★ 清除只動「已關閉」那一批(index 裡已經沒有的 code),絕不會動到還掛在大廳裡的現役房間。
     ========================================================================== */
  const SV_TAP_MS=1500, SV_TAP_GOAL=7;
  let svTapN=0, svTapAt=0, svBusy=false, svRows=[];

  function svBase(){
    return (typeof FIREBASE_CONFIG!=="undefined" && FIREBASE_CONFIG && FIREBASE_CONFIG.databaseURL) || "";
  }

  /* ---------- REST 併發閘(v2.2.2)----------
     ★ 這個面板原本**整串序列 await**:game_stats → 十四個遊戲一個接一個 → 每個遊戲裡再
       一間房一間房地讀 createdAt / 整包房間資料。十四個遊戲 × 最多 60 間 = 幾百趟往返
       排成一直線,行動網路一趟 150~300ms → 開一次面板要等好幾十秒,而且那期間
       svBody 完全空白(只有一行「連線中…」)—— 使用者的回報就是「以為死掉了」。
     ★ 這裡讓**所有** REST 讀寫排同一條有上限的隊,呼叫端該平行的地方直接 Promise.all。
     ⚠ 一定要有上限,不可以無腦全部一起噴:瀏覽器對同一個 host 本來就會自己排隊,
       而且會把首頁看板 / 語音那些請求一起卡住,反而更慢;有上限「還剩幾筆」也才有意義。
     ⚠ svRun 要**原樣轉發失敗**(不吞):refreshStatusPanel 靠 catch 分辨「讀不到」
       跟「真的是空的」,吞掉的話連線掛了也會畫成一片正常的空清單。 */
  const SV_CONC=12;
  const svQ=[]; let svActive=0;
  function svPump(){
    while(svActive<SV_CONC && svQ.length){ svActive++; svQ.shift()().then(svDone,svDone); }
  }
  function svDone(){ svActive--; svPump(); }
  function svRun(fn){
    return new Promise((res,rej)=>{ svQ.push(()=>fn().then(res,rej)); svPump(); });
  }
  function svGet(path,qs){
    return svRun(()=>fetch(svBase()+"/"+path+".json"+(qs?("?"+qs):"")).then(r=>r.json()));
  }
  // 讀不到就當預設值(單一房間的欄位讀失敗不該讓整個遊戲那一列跟著消失)
  function svTry(path,qs,dflt){
    return svGet(path,qs).then(v=>(v==null?dflt:v),()=>dflt);
  }
  function svDelete(path){
    return svRun(()=>fetch(svBase()+"/"+path+".json",{method:"DELETE"}));
  }
  function svAgo(ms){
    if(!ms) return "時間不明";
    const s=Math.max(0,Math.round((Date.now()-ms)/1000));
    if(s<60) return s+" 秒前";
    const m=Math.round(s/60); if(m<60) return m+" 分鐘前";
    const h=Math.round(m/60); if(h<48) return h+" 小時前";
    return Math.round(h/24)+" 天前";
  }
  /* 絕對時間(月/日 時:分)—— 使用者要的是「誰開的房間**跟時間**」,而「3 天前」
     回答不了「那天晚上那一場是幾點開的」。兩個一起寫,相對時間放括號裡。 */
  function svWhen(ms){
    if(!ms) return "";
    const d=new Date(ms), p=n=>String(n).padStart(2,"0");
    return p(d.getMonth()+1)+"/"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
  }
  function svTime(ms){ return ms ? (svWhen(ms)+"("+svAgo(ms)+")") : "時間不明"; }
  /* 誰開的 —— 四個來源依序試(舊房間沒有 hostName 那一筆):
       ① hostName:v1.147.0 房主離開時補寫的(關房之後 players 會被清掉,只剩這一筆)
       ② players[host].name:現役房間的即時名字
       ③ scores[host].nm:名字寄生在得分紀錄上(v1.97.0 的「離席紀錄」)
       ④ 都沒有 → 空字串,畫面上就不寫房主那一段(不要寫「不明」佔一行) */
  function svHost(d){
    if(!d) return "";
    if(typeof d.hostName==="string" && d.hostName) return d.hostName;
    const h=d.host;
    if(h && d.players && d.players[h] && d.players[h].name) return d.players[h].name;
    if(h && d.scores && d.scores[h] && d.scores[h].nm) return d.scores[h].nm;
    return "";
  }
  // 這間房有幾個人的紀錄(現役看 players,關掉的房間看 scores —— 那是「誰玩過」)
  function svWho(d){
    if(!d) return 0;
    if(d.players) return Object.keys(d.players).length;
    if(d.scores) return Object.keys(d.scores).length;
    return 0;
  }

  function tapBrand(){
    const now=Date.now();
    if(now-svTapAt>SV_TAP_MS) svTapN=0;
    svTapAt=now; svTapN++;
    if(svTapN>=SV_TAP_GOAL){ svTapN=0; openStatusPanel(); }
    else if(svTapN>=SV_TAP_GOAL-2) showToast("再按 "+(SV_TAP_GOAL-svTapN)+" 下開啟伺服器狀態",900);
  }

  function openStatusPanel(){
    const v=$("svVeil"); if(!v||!svBase())return;
    v.classList.add("show");
    refreshStatusPanel();
  }
  function closeStatusPanel(){ const v=$("svVeil"); if(v)v.classList.remove("show"); }

  /* 單一遊戲的現況:**所有房間**(現役 + 已關閉)各自的房名 / 房主 / 時間 + 累積人氣。
     ★★ v1.147.0 由「只列殘留」改成「全部都列」。使用者:「之前的版本我可以看得到有誰開過的
       房間清單跟時間,但現在看不到」—— 舊版只列**殘留**(房間節點有、大廳 index 已經沒有),
       而房主按「離開房間」時整間房被 remove 掉 → 正常關房的場次一筆都留不下來,
       清單常常是空的。這一版兩件事一起改:leave() 不再刪房(見 mp-core.js / online.js),
       這裡則連**現在還在大廳的**房間一起列出來。
     ★ index 一律**不帶 shallow** —— 它本身就存著 { name, status, count, host(名字) }
       (見 mp-core 的 updateRoomIndex),現役那幾間不必再逐間去讀房間本體。
     ⚠ 時間只在房間本體裡(createdAt)→ 現役房間補讀**單一欄位**(小小一筆),
       不要整包抓:那一包含 deal + moves。
     ⚠ 上限仍然是各 30 間 —— 而且**要在畫面上講清楚被截掉幾間**
       (CLAUDE.md 紅線 17:靜靜截斷會讀成「就這些」)。 */
  const SV_MAX=30;

  /* ==========================================================================
     已關閉的房間:**絕不整包讀**
     ──────────────────────────────────────────────────────────────────────────
     > 使用者:「我們抓伺服器狀態,有需要把整個房間全部的內容都抓回來嗎?」—— 不需要。

     這個面板一間房只顯示四樣:房名 / 誰開的 / 幾個人 / 什麼時候開的(見 svRoomHtml)。
     而整包裡最大的是 `game`(deal + moves)與 extraNodes(你畫我猜的 ink+say、
     數獨與消消樂的 progress、台灣麻將的 tai)—— **一間斷線殘留的你畫我猜約 40 KB**,
     而我們真正要的那四樣加起來 300 B。實測 20 間(其中 2 間是那種)是 85 KB,
     其中 94% 是那兩間的筆劃資料。

     ⚠ REST **沒有「只取某幾個欄位」的查詢**(`shallow` 只回 key 名、`orderBy` 只能篩
       不能投影),所以只有兩種形狀:整包一顆,或一個欄位一顆。做法是先花一顆
       `shallow` 探這間房有哪些 key(~100 B),再決定走哪一種:
         · **瘦房間**(正常按「離開房間」關的)→ **整包讀一顆就好**。leave() 已經把
           game / players / extraNodes / rtc 全部清成 null,整包本來就只有 300 B,
           拆成五顆反而白花四趟往返。
         · **肥房間**(斷線 / 直接關分頁殘留)→ 只挑白名單裡**存在**的欄位各讀一顆。

     ★★★ 判準是「有沒有 `game` 這個 key」,而這條是從 leave() 的清理契約推出來的:
       那一包 `update({host:null, players:null, game:null, …extraNodes:null, rtc:null})`
       是**原子的** → `game` 不見了就代表其他幾包也一起清了 →
       **沒有 game = 這間房已經被清乾淨,整包讀是安全的**。
     ⚠ `emotes` / `rtc` 是保險而不是判準:emotes 靠 `onDisconnect` + 15 秒自刪,
       理論上不會留下來,但**一則 6 秒語音留言是 128 KB 的 base64**,萬一留下來
       那一顆的成本就全在它身上。後面四個 extraNode 名字是再一層保險
       (它們一定與 game 同進同出,列著不花錢;新遊戲的新 extraNode 漏列也沒關係,
       因為那種房間一定同時有 game)。
     ★ `closedAt` **刻意不讀**:抓了但畫面上從來沒顯示過(svRoomHtml 只用到
       live / name / host / who / at / status)。
     ========================================================================== */
  const SV_WANT=["roomName","createdAt","hostName","host","players","scores"];
  const SV_FAT=["game","emotes","rtc","ink","say","progress","tai"];
  async function svStaleInfo(g,code){
    const path=g.rooms+"/"+code;
    const keys=Object.keys(await svTry(path,"shallow=true",{}));
    let d=null;
    if(keys.length){
      if(!keys.some(k=>SV_FAT.indexOf(k)>=0)){
        d=await svTry(path,"",null);                        // 瘦的:一顆整包
      }else{
        const want=SV_WANT.filter(k=>keys.indexOf(k)>=0);    // 肥的:只挑要的那幾個欄位
        const vals=await Promise.all(want.map(k=>svTry(path+"/"+k,"",null)));
        d={}; want.forEach((k,i)=>{ d[k]=vals[i]; });
      }
    }
    return { code, live:false, name:(d&&d.roomName)||("房間 "+code), host:svHost(d),
             who:svWho(d), at:(d&&d.createdAt)||0 };
  }

  /* ⚠ 全部走 Promise.all(排隊上限交給 svRun)—— 這一支原本是三層巢狀的循序 await,
       那是「開面板要等好幾十秒」的主因(見上面 SV_CONC 那段)。 */
  async function svLoadGame(g,statsN,talkN){
    const [idx,rms]=await Promise.all([
      svTry(g.index,"",{}),
      svTry(g.rooms,"shallow=true",{})
    ]);
    const idxKeys=Object.keys(idx), rmKeys=Object.keys(rms);
    const liveCodes=idxKeys.slice(0,SV_MAX);
    const staleCodes=rmKeys.filter(c=>idxKeys.indexOf(c)<0);
    const staleTop=staleCodes.slice(0,SV_MAX);
    const [ats,staleInfo]=await Promise.all([
      Promise.all(liveCodes.map(c=>svTry(g.rooms+"/"+c+"/createdAt","",0))),
      Promise.all(staleTop.map(c=>svStaleInfo(g,c)))
    ]);
    const rooms=[];
    liveCodes.forEach((code,i)=>{
      const r=idx[code]||{};
      rooms.push({ code, live:true, name:r.name||("房間 "+code), host:r.host||"",
                   who:r.count||0, status:r.status||"", at:ats[i]||0 });
    });
    staleInfo.forEach(it=>rooms.push(it));
    // 新開的排前面(時間不明的排最後)
    rooms.sort((a,b)=>(b.at||0)-(a.at||0));
    const cut=Math.max(0,idxKeys.length-SV_MAX)+Math.max(0,staleCodes.length-SV_MAX);
    return { g, activeN:idxKeys.length, rooms, staleInfo, cut, n:statsN||0, talk:talkN||0 };
  }

  /* 一間房一行:狀態點 + 房名 + 誰開的 + 幾個人 + 建立時間。
     ⚠ 清除鈕**只針對已關閉的那些**(row.staleInfo)—— 絕不會動到還掛在大廳裡的現役房間,
       那條紅線沒有變(見這一節開頭 ★)。 */
  function svRoomHtml(r){
    return (r.live ? '<span class="svs-dot live">🟢</span>' : '<span class="svs-dot">💤</span>')+
      esc(r.name)+
      (r.host ? ' <span class="svs-by">👑 '+esc(r.host)+'</span>' : "")+
      (r.who ? ' · '+r.who+' 人' : "")+
      ' · '+svTime(r.at)+
      (r.live && r.status==="playing" ? " · 對戰中" : "");
  }
  /* ⚠ 這一列一律帶 id="svRow-<key>" —— 漸進渲染是拿骨架的 outerHTML 換掉,
       換上來的那一份也要留著同一個 id,不然「重新整理」第二次就找不到位置了。 */
  function svRowId(key){ return "svRow-"+key; }
  function svRowHtml(row){
    const g=row.g;
    const btns=[];
    if(row.staleInfo.length) btns.push('<button class="btn ghost svs-clear" type="button" data-key="'+g.key+'">清除這 '+row.staleInfo.length+' 間已關閉</button>');
    // ★ 統計 = 場次 + 語音人次,兩個一起清(它們都是「這個遊戲的統計」,見 svClearStatsKey)
    // ⚠ 語音那一段用 🎙 而不是「語音 N 次」:寫全的話這顆鈕在手機寬度一定折成兩行,
    //   而「次)」單獨掉到第二行很難看。完整說法在頂上那行與 confirm 裡都有。
    if(row.n||row.talk) btns.push('<button class="btn ghost svs-clear-stats" type="button" data-key="'+g.key+'">清除統計('+row.n+' 場'+(row.talk?" · 🎙"+row.talk:"")+')</button>');
    const btnRow=btns.length ? '<div class="svs-row-actions">'+btns.join("")+'</div>' : "";
    const list=row.rooms.length
      ? '<div class="svs-stale">'+row.rooms.map(svRoomHtml).join("<br>")+
        (row.cut ? '<br><i>…還有 '+row.cut+' 間沒列出來(一次最多 '+SV_MAX+' 間)</i>' : "")+'</div>'
      : "";
    return '<div class="svs-row" id="'+svRowId(g.key)+'">'+
      '<div class="svs-row-head"><span class="svs-name">'+g.icon+' '+esc(g.name)+'</span>'+
      '<span class="svs-nums">大廳 '+row.activeN+' 間 · 已關閉 '+row.staleInfo.length+' 間 · 累積 '+row.n+' 場'+
      // 🎙 語音人次:0 就整段不寫(每一列都掛一個 0 只會把這行擠爆,看不出誰真的有人用)
      (row.talk?' · <b class="svs-mic">🎙 '+row.talk+'</b>':"")+'</span></div>'+
      list+btnRow+'</div>';
  }
  /* 骨架列:面板一打開就先把十四列畫出來(圖示 + 名字 + 一條跑馬燈),
     哪個遊戲讀完就換掉哪一列 —— 使用者第一秒就看得到「它在動」。 */
  function svSkelHtml(g){
    return '<div class="svs-row svs-skel" id="'+svRowId(g.key)+'">'+
      '<div class="svs-row-head"><span class="svs-name">'+g.icon+' '+esc(g.name)+'</span>'+
      '<span class="svs-nums">讀取中…</span></div>'+
      '<div class="svs-bar"><i></i></div></div>';
  }

  // 排序權重 = 大廳現役 + 已關閉的房 + 累積場次 + 語音人次,「有資料」的來源不分輕重全部算進去。
  // 同分照 GAMES 的原順序(比照 rankRows 的做法,不依賴 sort 的穩定性)。
  function svWeight(r){ return r.activeN+r.staleInfo.length+r.n+r.talk; }

  /* 即時語音的累計人次:寫入端在 js/shared/talk.js 的 bumpStat(),節點寄生在
     game_stats 底下的 `talk_<遊戲 key>/n`(那邊有整段說明:為的是一行資料庫規則
     都不必改,而且跟場次共用同一顆 game_stats 請求)。⚠ 這裡是唯一的讀取端。
     ⚠ 註解裡不可以把那個路徑寫成 星號星號斜線 的樣子 —— 那三個字元會把整段註解
       就地切斷,後面的程式碼靜靜地變成註解(CLAUDE.md 紅線 9)。 */
  function svTalkN(stats,key){
    const d=stats&&stats["talk_"+key];
    return (d&&typeof d.n==="number"&&d.n>0)?d.n:0;
  }

  /* 打開面板時抓一次快照就好(比照 fetchRank 的一次性讀取),不掛常駐監聽 —— 這是給自己排查用,不必即時。
     ★★ v2.2.2 漸進渲染:一拿到 game_stats 就先把十四列骨架畫出來,十四個遊戲**同時**去讀,
       誰先回來誰先就地換成正式那一列,頂上那行同步報「讀取中 5 / 14」。
       原本是全部讀完才一次 innerHTML → 中間那幾十秒畫面完全空白,使用者的回報是「以為死掉了」。
     ⚠ 排序(有資料的排前面)得等全部讀完才知道,所以骨架照 GAMES 原順序、**最後才重排一次**。
       不可以每讀完一個就重排:列會一路跳動,比不動更難用。 */
  async function refreshStatusPanel(){
    if(svBusy)return;
    svBusy=true;
    const ping=$("svPing"), body=$("svBody"), clearAll=$("svClearAll"), clearStatsAll=$("svClearStatsAll");
    // 讀取中先把兩顆清除鈕鎖起來:資料還沒到位,那時的數字是上一輪的
    if(clearAll)clearAll.disabled=true;
    if(clearStatsAll)clearStatsAll.disabled=true;
    if(ping)ping.innerHTML='<span class="svs-spin"></span>連線中…';
    /* ⚠ 骨架要**在第一顆請求之前**就畫上去,不可以等 game_stats 回來才畫:
       那一趟本身就可能等一兩秒,而「按下去到畫面有反應」的空窗正是要修掉的東西。
       順帶把上一輪的舊清單換掉 —— 舊數字擺在那裡看起來像是「重新整理沒生效」。 */
    if(body)body.innerHTML=GAMES.map(svSkelHtml).join("");
    const t0=Date.now();
    try{
      const stats=await svGet("game_stats");
      const ms=Date.now()-t0;
      let doneN=0;
      const progress=()=>{
        if(ping)ping.innerHTML='<span class="svs-spin"></span>✅ 連線正常('+ms+' ms)· 讀取房間資料 '+doneN+' / '+GAMES.length;
      };
      progress();
      const rows=await Promise.all(GAMES.map(g=>
        svLoadGame(g,stats&&stats[g.key]&&stats[g.key].n,svTalkN(stats,g.key)).then(row=>{
          doneN++; progress();
          // 就地換掉骨架(面板中途被關掉 / 又按了重新整理 → 找不到就安靜跳過)
          const el=$(svRowId(g.key)); if(el) el.outerHTML=svRowHtml(row);
          return row;
        })
      ));
      // 有資料(現役房 / 已關閉的房 / 累積場次 / 語音人次)的排前面,方便一眼看出要處理誰
      rows.sort((a,b)=>svWeight(b)-svWeight(a)||GAMES.indexOf(a.g)-GAMES.indexOf(b.g));
      svRows=rows;
      if(body)body.innerHTML=rows.map(svRowHtml).join("");
      const totalTalk=rows.reduce((n,r)=>n+r.talk,0);
      const talkGames=rows.filter(r=>r.talk>0).length;
      if(ping)ping.innerHTML='✅ 連線正常('+ms+' ms)<br>'+
        '<b class="svs-mic">🎙 即時語音</b>:累計開啟 '+totalTalk+' 次'+
        (totalTalk?'('+talkGames+' 個遊戲用過)':'(還沒有人用過)');
      if(clearAll){
        const total=rows.reduce((n,r)=>n+r.staleInfo.length,0);
        clearAll.disabled=!total;
        clearAll.textContent="🗑 清除全部已關閉的房間("+total+")";
      }
      if(clearStatsAll){
        const totalN=rows.reduce((n,r)=>n+r.n,0);
        clearStatsAll.disabled=!totalN&&!totalTalk;
        clearStatsAll.textContent="🧹 清除全部統計紀錄("+totalN+" 場"+(totalTalk?" · 🎙"+totalTalk:"")+")";
      }
    }catch(e){
      if(ping)ping.textContent="⚠️ 讀取失敗,檢查網路或稍後再試";
      if(body)body.innerHTML="";
    }
    svBusy=false;
  }

  /* ★ 房間與統計紀錄是兩件獨立的事,分開清:房間清掉只是收垃圾,統計紀錄
     (game_stats/{key}/n,首頁熱門度排序的來源)則是使用者想留著回顧的資料 ——
     所以連線對戰結束、房間關掉之後統計不會自動清,也不會跟著房間一起被清掉,
     全部要靠這裡兩顆各自獨立的按鈕手動按。 */
  async function svClearKey(key){
    const row=svRows.find(r=>r.g.key===key); if(!row||!row.staleInfo.length)return;
    /* ⚠ 話要講清楚「清掉的是什麼」:v1.147.0 起這些節點就是「誰開過哪一間、什麼時候」的
       唯一紀錄(房主離開不再自動刪),按下去等於把那份歷史丟掉。 */
    if(!confirm("確定要清除「"+row.g.name+"」的 "+row.staleInfo.length+" 間已關閉的房間嗎?那是「誰開過哪一間、什麼時候」的紀錄,清掉就查不到了,而且無法復原。"))return;
    await svBusyWhile("清除中…",()=>svAll(row.staleInfo.map(s=>svDelete(row.g.rooms+"/"+s.code))));
    showToast("已清除「"+row.g.name+"」已關閉的房間 🗑");
    refreshStatusPanel();
  }
  async function svClearAllRooms(){
    const total=svRows.reduce((n,r)=>n+r.staleInfo.length,0);
    if(!total)return;
    if(!confirm("確定要清除全部遊戲、共 "+total+" 間已關閉的房間嗎?那是「誰開過哪一間、什麼時候」的紀錄,清掉就查不到了,而且無法復原。"))return;
    const jobs=[];
    for(const row of svRows) for(const s of row.staleInfo) jobs.push(svDelete(row.g.rooms+"/"+s.code));
    await svBusyWhile("清除中…("+total+" 間)",()=>svAll(jobs));
    showToast("已清除全部已關閉的房間 🗑");
    refreshStatusPanel();
  }
  /* ⚠ 場次與語音人次是**同一個遊戲的統計**,一起清:留一半下來只會讓下次打開時
     以為「清除沒生效」。兩個都寄生在 game_stats 底下(見 svTalkN 那段)。 */
  async function svClearStatsKey(key){
    const row=svRows.find(r=>r.g.key===key); if(!row||(!row.n&&!row.talk))return;
    if(!confirm("確定要清除「"+row.g.name+"」的統計紀錄("+row.n+" 場"+(row.talk?"、語音 "+row.talk+" 次":"")+")嗎?此動作無法復原,首頁熱門度排序會受影響。"))return;
    await svBusyWhile("清除中…",()=>svAll([svDelete("game_stats/"+key+"/n"),svDelete("game_stats/talk_"+key+"/n")]));
    showToast("已清除「"+row.g.name+"」的統計紀錄 🧹");
    refreshStatusPanel();
  }
  async function svClearAllStats(){
    const total=svRows.reduce((n,r)=>n+r.n,0);
    const totalTalk=svRows.reduce((n,r)=>n+r.talk,0);
    if(!total&&!totalTalk)return;
    if(!confirm("確定要清除全部遊戲、共 "+total+" 場"+(totalTalk?" 與 "+totalTalk+" 次語音":"")+"的統計紀錄嗎?此動作無法復原,首頁熱門度排序會歸零重來。"))return;
    /* ⚠ 先整包刪 game_stats,再逐一刪各遊戲的 n / talk_n 當保險:
       資料庫規則授權的是 `game_stats/$game/n`(見 notes/firebase-rules.json)——
       整包刪要的是 game_stats 這一層的寫入權,那**不一定**授權得到,
       而 REST 被擋是靜靜回 401、fetch 不會 reject → 只做整包刪會變成「按了沒反應」。 */
    const jobs=[svDelete("game_stats")];
    for(const g of GAMES){ jobs.push(svDelete("game_stats/"+g.key+"/n")); jobs.push(svDelete("game_stats/talk_"+g.key+"/n")); }
    await svBusyWhile("清除中…",()=>svAll(jobs));
    showToast("已清除全部統計紀錄 🧹");
    refreshStatusPanel();
  }
  // 一批刪除:全部平行送(排隊上限交給 svRun),個別失敗不影響其他筆
  function svAll(jobs){ return Promise.all(jobs.map(p=>p.then(null,()=>null))); }
  /* 清除也可能要跑好幾秒(一次幾百間房)—— 同樣不可以讓畫面呆在原地什麼都不說。
     ⚠ 期間把兩顆全域清除鈕鎖住:連按第二下等於再送一整批同樣的 DELETE。 */
  async function svBusyWhile(msg,fn){
    const ping=$("svPing"), a=$("svClearAll"), b=$("svClearStatsAll");
    if(ping)ping.innerHTML='<span class="svs-spin"></span>'+esc(msg);
    if(a)a.disabled=true; if(b)b.disabled=true;
    try{ await fn(); }catch(e){}
  }

  // 事件綁定自己管(比照上面 visibilitychange 監聽的自包含風格),元素早就在 DOM 裡(這支 <script> 排在 body 尾端)
  (function(){
    const bh=$("brandHome"); if(bh)bh.addEventListener("click",tapBrand);
    const close=$("svClose"); if(close)close.addEventListener("click",closeStatusPanel);
    const veil=$("svVeil"); if(veil)veil.addEventListener("click",e=>{ if(e.target===veil)closeStatusPanel(); });
    const refresh=$("svRefresh"); if(refresh)refresh.addEventListener("click",refreshStatusPanel);
    const clearAll=$("svClearAll"); if(clearAll)clearAll.addEventListener("click",svClearAllRooms);
    const clearStatsAll=$("svClearStatsAll"); if(clearStatsAll)clearStatsAll.addEventListener("click",svClearAllStats);
    const body=$("svBody");
    if(body)body.addEventListener("click",e=>{
      const clearBtn=e.target.closest(".svs-clear"); if(clearBtn){ svClearKey(clearBtn.dataset.key); return; }
      const statsBtn=e.target.closest(".svs-clear-stats"); if(statsBtn){ svClearStatsKey(statsBtn.dataset.key); return; }
    });
  })();

  /* ⚠ initRank / applyRank / rankRows 是**為了守門而導出**的:排名的行為分岔在
     「這台有沒有快取」,而 e2e 跑在 file:// 上、localStorage 會跨次數留著 ——
     測試要能把它清掉再回到「第一次用」的狀態,否則那條路徑靜靜地永遠測不到。
     closeStatusPanel 是**為了 BACK_LAYERS 導出**的(見 js/game.js)——手機返回鍵
     要能關掉這個面板,而不是把使用者導出首頁。 */
  return { boot, stop, sync, initRank, applyRank, rankRows, closeStatusPanel };
})();

"use strict";

/* ============================================================================
   麻將消牌 — 連線適配器(接上 js/shared/mp-core.js)。兩種玩法共用同一個房間與牌局:

   • grab(搶牌,預設):所有人看**同一個盤面**、同時都能點。誰先消掉一對就歸誰 +1 分,
     盤面清空時分數最高者勝。
   • race(競速):同一副牌、**各自獨立**的盤面,只同步進度。先清空整盤者勝。

   兩個模式的資料放法刻意不同(與數獨同一套理由):
   • grab 的 moves 必須在 game 節點裡(要交易 + rev 才擋得住「兩人同時點同一張」)
   • race 的 progress 放**房內獨立節點**,各人只寫自己那一支 —— 沒有競態,也不會每消一對
     就把整包 game 推播給全房

   ★ 這個遊戲比數獨多一個數獨沒有的狀況:**死局**。出題保證解得開,但玩家自己亂配就會
     走進沒得消的局面(node 實測隨機亂玩,144 牌只有 36.9% 能清空)。所以:
     • race:各自重洗自己的盤面,不影響別人,代價是花掉的時間
     • grab:全房同一個盤面 → 重洗必須是**全房一致的一次事件**,用 game.shuf 這個單調遞增的
       計數器 + 交易來搶(誰先搶到誰的洗牌結果算數),不指定房主 —— 免得房主剛好斷線就沒人洗、
       整局卡死(同 settleGrab 不指定「消最後一對的人」的理由)
     v1.54.0 起**重洗沒有按鈕**:死局時自動觸發(armAuto),對戰中的工具列因此只剩兩顆讀數。
   ========================================================================== */

const MP = MPCore.create((function(){
  const COLORS=["p0","p1","p2","p3","p4","p5"];   // 對應 styles.css 的 --sp0~--sp5(要加人先加色)
  let mode="grab", diff="m72";                    // 房間設定(房主可改)
  let gMode="grab", gDiff="m72", gShape="wide";   // 開局當下鎖定的值(對戰中改設定不影響進行中的這局)
  let ctx=null;
  let curRound=null, shufN=0, moves=[], tally=[], prog={};
  let total=0, myShuf=0, startedAt=0;
  let autoT=null;                                 // 死局自動重洗的排程(見 armAuto())
  let stallFrom=0, stallLv=0, stallT=null, stallShufN=0;   // 僵局偵測(見 stallTick())

  /* ---------- moves 的整數編碼 ----------
     一次「消掉一對」記成一個整數:i / j 是格位(<144)、seat 是座位(0~7)。
     上限 (143*200+143)*8+7 = 229951,RTDB 存整數陣列最乾淨,與五子棋 moves 同構。 */
  function enc(i,j,seat){ return (i*200+j)*8+seat; }
  function dec(c){
    const seat=c%8; c=(c-seat)/8;
    const j=c%200, i=(c-j)/200;
    return { i:i, j:j, seat:seat };
  }
  function seatOf(id){ return ctx.order().indexOf(id); }
  function mySeat(){ return seatOf(ctx.me()); }
  function colorOf(seat){ return COLORS[seat]||"p0"; }

  /* ---------- 計分:唯一的加減分入口 ----------
     ⚠ 三條路徑都必須走這支(結算 / 重連整盤重建 / 平時增量),
        漏掉任何一個就會出現「重連後分數跟別人對不上」的鬼 bug(數獨踩過)。
     麻將這邊沒有扣分規則 —— 配錯的牌根本不會成立,不像數獨填錯要罰。 */
  function bump(t,seat){ t[seat]=(t[seat]||0)+1; }

  function pairsTotal(){ return Math.max(1, Math.floor(total/2)); }

  /* ---------- 即時比分 HUD(盤面上方那一列) ---------- */
  function renderHud(){
    const box=$("mjHud"); if(!box)return;
    if(ctx.phase()!=="playing"){ box.classList.add("hidden"); box.innerHTML=""; return; }
    const ord=ctx.order(), me=ctx.me();
    box.classList.remove("hidden");
    box.classList.toggle("mj-hud-two", ord.length>4);   // 5 人以上一列排不下 → 3 欄兩列
    const tp=pairsTotal();
    box.innerHTML=ord.map((id,seat)=>{
      const nm=esc(ctx.dispName(id));
      let val, sub, pct;
      if(gMode==="grab"){
        val=(tally[seat]||0); sub="對";
        pct=Math.round((val/tp)*100);
      }else{
        const p=prog[id]||{};
        pct=Math.round(((p.n||0)/tp)*100); val=pct; sub="%";
      }
      return '<div class="mj-hcard '+colorOf(seat)+(id===me?" me":"")+'" data-id="'+id+'" title="'+
               (id===me?"點一下傳送互動表情給全部人":"點一下傳送互動表情")+'">'+
               '<span class="mj-hname"><span class="mj-seat '+colorOf(seat)+'"></span>'+nm+(id===me?' <b>你</b>':'')+'</span>'+
               '<span class="mj-hval">'+val+'<em>'+sub+'</em></span>'+
               '<span class="mj-bar"><i style="width:'+Math.max(0,Math.min(100,pct))+'%"></i></span>'+
             '</div>';
    }).join("");
  }
  // 分數變動時在那個人的卡片上飄一個 +1(讓玩家從「結果」看懂計分,不必在盤面上方擺說明文字)
  function popScore(seat){
    const box=$("mjHud"); if(!box)return;
    const card=box.children[seat]; if(!card)return;
    const el=document.createElement("span");
    el.className="mj-pop up";
    el.textContent="+1";
    card.appendChild(el);
    setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); },900);
  }

  /* ---------- 消牌 ---------- */
  /* ⚠ 每一條 return 都要講一句話(v1.181.2):這一頁沒有「輪到誰」,牌有沒有消掉就是
     使用者唯一的回饋 —— 靜靜 return 的下場是回報上來只有「點下去沒反應」。 */
  function onPair(i,j){
    if(ctx.phase()!=="playing")return;              // 不在對局裡 —— 這條不必講話
    if(ctx.winner()){ showToast("這一局結束了,等下一局開始 👀",1400); return; }
    if(gMode==="grab") grabPair(i,j); else racePair(i,j);
  }
  function grabPair(i,j){
    const seat=mySeat(); if(seat<0){ showToast("座位還在同步,等一下再試 ⏳",1400); return; }
    ctx.txGame(g=>{
      if(g.status!=="playing"||g.winner)return false;
      const arr=Array.isArray(g.moves)?g.moves:[];
      // 交易內再驗一次:這 100~300ms 內對手可能已經把其中一張拿走了(本地快照還沒到)
      for(let k=0;k<arr.length;k++){
        const m=dec(arr[k]);
        if(m.i===i||m.j===i||m.i===j||m.j===j) return false;
      }
      g.moves=arr.concat(enc(i,j,seat));
    });
  }
  function racePair(i,j){
    MB.remove(i,j);
    Sound.place();
    pushProgress();
    stallReset();                   // 有進度了 → 僵局時鐘歸零(競速量的是自己有沒有在動)
    if(MB.cleared()){ settleRace(); return; }
    if(!MB.anyMove()) armAuto();
  }
  function pushProgress(){
    const r=ctx.ref("progress/"+ctx.me()); if(!r)return;
    r.set({ n:Math.floor((total-MB.left())/2), s:myShuf, done:MB.cleared(), at:Date.now()-startedAt });
  }

  /* ---------- 死局 → 自動重洗(v1.54.0)----------
     之前是工具列上一顆「🔀 重洗」等玩家自己按。拿掉的理由:死局時重洗是唯一的選擇,
     那顆鈕在對戰全程都亮著卻只有最後可能用到,一開局就讓人看不懂那是什麼。
     ★ 一定要「先跳提示、隔一下才洗」:直接換牌畫面會無預警整盤變樣,玩家會以為出 bug。
     ★ 搶牌:全房每個人都會偵測到同一個死局、都會去洗,交易保證只有第一個算數
       (shuf 單調遞增)。延遲刻意按座位錯開,少幾次註定白跑的交易。
     ★ 洗完要再確認一次:交易可能整批失敗(極少見),沒人洗成功就要再排一次,
       不能把全房留在死局裡等一個不會再來的事件(grab 的 applyGame 只在資料變動時才跑)。 */
  function armAuto(){
    if(autoT)return;
    if(MB.left()<2)return;
    showToast("沒得消了 —— 自動重洗中…",1600);
    const wait = 900 + (gMode==="grab" ? Math.max(0,mySeat())*150 : 0);
    autoT=setTimeout(()=>{
      autoT=null;
      if(ctx.phase()!=="playing"||ctx.winner())return;
      if(MB.anyMove())return;                       // 這段時間裡別人已經洗過了(搶牌)
      shuffle();
      autoT=setTimeout(()=>{ autoT=null; if(!MB.anyMove()) armAuto(); },2600);
    },wait);
  }
  /* ★ 這支同時把**僵局時鐘**一起停掉(v1.57.0)。兩支 timer 的生命週期完全一樣
     —— 都只在「這一局進行中」才有意義 —— 合在同一個出口清,加新出口時就不會只記得一半。
     現有出口:新局(roundId 變)/ 回大廳 / 離房 / 結算 / resetRound / stuck。
     漏掉的下場是「上一局排的重洗洗到新盤面上」,或僵局提示跳在大廳畫面裡。 */
  function clearAuto(){
    if(autoT){ clearTimeout(autoT); autoT=null; }
    stallOff();
  }

  /* ---------- 僵局:太久沒有人消掉(v1.57.0)----------
     死局(可消 0 組)有 armAuto 接手,但真正難受的是**「✦ 1」或「✦ 2」卻沒人找到**那一段:
     讀數顯示一切正常,實際上全房在乾瞪眼。搶牌尤其糟 —— 全房同一個盤面、大家卡在同一個
     難點,連一條進度條都不會動,畫面完全靜止,「搶」的刺激感就沒了。

     機制只有一支時鐘:量的是**距離上一次有人消掉**多久,不是開局多久。三階升壓:

     | 停滯   | 做什麼                                        | 遮擋 |
     |--------|----------------------------------------------|------|
     | 8s     | 「✦ N」讀數開始脈動 + 補一顆停滯秒數讀數        | 無   |
     | 15s    | 光帶過場 + 一聲 Sound.turn() + 探照燈框出欄帶   | 無   |
     | 25s    | 讀數倒數 3→2→1,然後全房重洗                  | 無   |

     ★ 錨點是「moves 變長」(grab)/「自己消掉一對」(race)—— **全部本地推算,零 DB、
       零 schema 變動**。各台差幾百毫秒無所謂:提示不需要全房同一秒,而唯一需要全房一致的
       重洗已經有 shuf 交易在管。
     ★ 絕對不可以拿「g.tiles 有沒有變」當錨點 —— 重洗就是在改 tiles(同 applyGame 那個最大的坑)。
     ★ 只有一個 interval、沒有別的 timer:連倒數都是在 tick 裡用時間差算出來的。
       這遊戲的 timer 出口清理已經踩過一次(clearAuto 要掛四個出口),能不多開就不多開。
     ★ 15 秒那一階刻意只框**欄帶**、不指出是哪兩張(MB.showZone 的註解有完整理由)。 */
  const STALL={ warm:8000, hint:15000, shuf:25000, count:3000, maxShuf:2, tick:500 };

  function stallOn(){ stallOff(); stallFrom=Date.now(); stallShufN=0; stallT=setInterval(stallTick,STALL.tick); }
  function stallOff(){
    if(stallT){ clearInterval(stallT); stallT=null; }
    stallLv=0; paintStall(""); markWarm(false); MB.clearZone();
  }
  // 有人消掉 / 剛重洗過 → 時鐘歸零,升壓的階梯也一起退回去
  function stallReset(){
    stallFrom=Date.now();
    stallLv=0; paintStall(""); markWarm(false); MB.clearZone();
  }

  function stallTick(){
    if(ctx.phase()!=="playing"||ctx.winner()||!total){ stallOff(); return; }
    // 死局歸 armAuto:那邊自己會洗,僵局不插隊(而且可消 0 組時探照燈根本沒東西可指)
    if(autoT||!MB.anyMove()){ if(stallLv) stallReset(); return; }
    const el=Date.now()-stallFrom;
    // 洗過兩次還是沒人動 = 大概全房都掛機了(那有落單倒數接手),別把盤面洗成跑馬燈
    const top=stallShufN>=STALL.maxShuf?2:3;
    const lv=Math.min(top, el>=STALL.shuf?3 : el>=STALL.hint?2 : el>=STALL.warm?1 : 0);
    if(lv!==stallLv) stallUp(lv);
    if(stallLv>=3){
      const rest=Math.ceil((STALL.shuf+STALL.count-el)/1000);
      if(rest>0){ paintStall("🔀 "+rest); return; }
      stallShuffle();
    }else if(stallLv>=1){
      paintStall("⏱ "+Math.floor(el/1000)+"s"+(gMode==="grab"?" 沒人消":" 沒進度"));
    }
  }

  /* 升壓。前兩階完全不影響操作 —— 搶牌是比手速,任何遮擋都是在扣某個人的分 */
  function stallUp(lv){
    const up=lv>stallLv;
    stallLv=lv;
    markWarm(lv>=1);
    if(!up)return;
    if(lv===2){
      MB.flash(gMode==="grab"?"⚡ 全場僵持中":"⏱ 卡住了?");
      Sound.turn();     // 麻將沒有回合制,turn() 整支遊戲沒用到,拿來當「注意一下」正好
      MB.showZone();
    }
  }

  /* 第三階:重洗。走的是死局那條現成的路(grab 用 shuf 交易搶 / race 只洗自己)。
     ★ 先重置時鐘再洗:洗完的推播要跑一趟往返,不先重置的話這幾百毫秒內會再觸發一次。
       交易搶輸(別人先洗了)也一樣 —— 對方洗成功的推播照樣會過來。 */
  function stallShuffle(){
    stallShufN++;
    stallReset();
    shuffle();
  }

  function paintStall(txt){
    const el=$("mjStall"); if(!el)return;
    if(!txt){ el.classList.add("hidden"); el.textContent=""; return; }
    el.classList.remove("hidden");
    el.textContent=txt;
    el.classList.toggle("mj-hot",stallLv>=2);
  }
  // 第一階唯一做的事:把「✦ N」讀數點起來。零遮擋、純氣氛
  function markWarm(on){ const el=$("mjMoves"); if(el) el.classList.toggle("mj-warm",!!on); }

  function shuffle(){
    if(ctx.phase()!=="playing"||ctx.winner())return;
    if(MB.left()<2)return;
    if(gMode==="race"){
      const nt=MGen.reshuffle(MB.level(),MB.shape(),MB.aliveArr(),MB.tiles());
      if(!nt){ stuck(); return; }
      MB.setTiles(nt); myShuf++;
      MB.flash("");                 // 純光帶,遮掩整盤換牌那一瞬間(訊息交給下面的 toast)
      Sound.takeback(); showToast("已重洗你的盤面 🔀",1300);
      pushProgress();
      stallReset();
      return;
    }
    grabShuffle();
  }
  /* 搶牌的重洗:全房共用一個盤面 → 只能有一次生效。
     先在本地算好新排法,再用交易搶 —— 交易裡檢查 shuf 與 moves 長度都沒變,
     變了就代表「別人已經洗過」或「期間又有人消了牌」,這份算好的排法已過期,直接放棄。 */
  function grabShuffle(){
    const nt=MGen.reshuffle(MB.level(),MB.shape(),MB.aliveArr(),MB.tiles());
    if(!nt){ stuck(); return; }
    const wantShuf=shufN, wantLen=moves.length, code=nt.join("");
    ctx.txGame(g=>{
      if(g.status!=="playing"||g.winner)return false;
      if((g.shuf||0)!==wantShuf)return false;
      if((Array.isArray(g.moves)?g.moves:[]).length!==wantLen)return false;
      g.tiles=code; g.shuf=wantShuf+1;
    });
  }
  /* 洗不出來 = 真死局:剩下的牌上下疊在一起,同一批格位怎麼排都只有上面那張抽得出來。
     罕見但確實存在(最後一對剛好疊著)。這裡不能無聲重試 ——
     • 搶牌:全房看同一個盤面,誰都動不了 → 直接以目前分數結算,不然整局掛在那裡
     • 競速:只有我的盤面卡住,對手還在跑 → 講清楚,勝負交給對手清完或落單倒數 */
  function stuck(){
    clearAuto();
    if(gMode==="grab"){
      showToast("剩下的牌上下疊住了,洗也解不開 —— 直接以目前分數結算",3600);
      if(!ctx.winner()) settleGrab(true);   // 盤面沒清空也要結算 → 要略過「清空了才算」那道守衛
      return;
    }
    showToast("剩下的牌上下疊住了,這盤救不回來 😥",3600);
  }

  /* ---------- 結算 ----------
     ★ 兩支都用 { local:false }(v1.56.0):決定勝負的寫入**不做本地樂觀套用**。
       樂觀套用會讓「搶最後一手」的那一台先看到一個之後被伺服器推翻的贏家 —— 而看到贏家
       就會放彩帶、播勝利音效、往 scores/{me} 寫 +1,那三件事都不會隨交易回退
       (核心那邊有反向修正把分數收回來,但畫面上閃過「你贏了!」還是像出 bug)。
       代價是自己清完盤面到結果卡跳出多一趟往返(~100~300ms),很划算。 */
  function settleRace(){
    ctx.txGame(g=>{
      if(g.winner)return false;
      g.winner={ id:ctx.me(), name:ctx.name(), by:"time", ms:Date.now()-startedAt };
    },{ local:false });
  }
  /* 搶牌:盤面清空就結算。誰看到誰寫,交易保證只有第一個成功
     (不指定「消最後一對的人」,免得那個人剛好斷線就沒人寫、整局卡住)
     force=true 只給 stuck() 用:那是「洗也解不開」,盤面沒清空也得結算。 */
  function settleGrab(force){
    ctx.txGame(g=>{
      if(g.winner)return false;
      const arr=Array.isArray(g.moves)?g.moves:[];
      /* ★ 用**交易裡看到的 moves**(= 伺服器真值)再確認一次盤面真的清空了。
         本地畫面清空不代表伺服器上清空:搶最後一對時我的那一手可能被對手搶先而回退,
         少了這道守衛就會在盤面還有牌的情況下寫下贏家、把整局提早結束掉。 */
      if(!force && arr.length*2<total) return false;
      const t=[];
      arr.forEach(c=>bump(t,dec(c).seat));
      const ord=ctx.order();
      let best=-1;
      ord.forEach((id,s)=>{ if((t[s]||0)>best) best=(t[s]||0); });
      const ids=ord.filter((id,s)=>(t[s]||0)===best);
      g.winner = ids.length===1
        ? { id:ids[0], name:ctx.dispName(ids[0]), by:"score", pts:best }
        : { ids:ids, by:"draw", pts:best };
    },{ local:false });
  }

  /* ---------- 大廳說明 ---------- */
  function ruleHint(){
    const el=$("mjRuleHint"); if(!el)return;
    const L=MGen.levelOf(diff);
    const base = mode==="grab"
      ? "<b>搶牌</b>:大家看同一個盤面,同時搶著消。消掉一對就 <b>+1 分</b>,盤面清空時分數最高的人贏。"
      : "<b>競速</b>:同一副牌、各消各的,中途只看得到對手的進度條。最先清空整盤的人贏。";
    const dead = mode==="grab"
      ? "沒得消的時候<b>整房一起自動重洗</b>(格位不動,只把剩下的牌重排),不必按任何鈕。"
      : "沒得消的時候<b>自動重洗你自己的盤面</b>(格位不動,只把剩下的牌重排),代價是花掉的時間。";
    el.innerHTML = base+"<br>"+dead+"<br>盤面 "+L.label+" · "+L.name+" · "+L.desc;
  }

  return {
    ns:{ rooms:"mahjong_rooms", index:"mahjong_index" },
    minPlayers:2, maxPlayers:6,
    /* ★★ 原班人馬可以回座(誤按離開 / 關分頁 / 斷線之後回到**還在打的那一場**)。
       ⚠⚠ 它**不是** joinMidGame:放行的只有 `game.order` 裡本來就有的那個 pid
         (全新的人照舊擋在外面)—— 完整的理由在 js/shared/mp-core.js 的 REJOIN_MID 那一段。
       ★ 同數獨:不是回合制,離開只是停止消牌 → 回座就接著消。 */
    rejoinMidGame: true,
    prefsKey:"mahjong.prefs.v1",
    emoteAnchor:"mjStage",
    winCardId:"mjWinCard",
    hasResign:false,                 // 限時解謎,中途認輸沒有意義;掛機交給落單倒數處理
    extraNodes:["progress"],

    init(c){ ctx=c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { mode:mode, diff:diff }; },
    onRoomField(k,v){
      if(k==="mode"){
        const nv=(v==="race")?"race":"grab";
        if(nv===mode)return;
        mode=nv; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }else if(k==="diff"){
        if(!MGen.LEVELS[v]||v===diff)return;
        diff=v; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }
    },
    readRoom(r){
      if(r.mode==="race"||r.mode==="grab") mode=r.mode;
      if(MGen.LEVELS[r.diff]) diff=r.diff;
    },

    /* ---------- 額外監聽:競速模式的進度 ---------- */
    listen(){
      const r=ctx.ref("progress"); if(!r)return;
      r.on("value",s=>{ prog=s.val()||{}; renderHud(); });
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { moves:[], tiles:null, shuf:0, shape:null }; },
    resetRound(){ clearAuto(); curRound=null; moves=[]; tally=[]; prog={}; shufN=0; myShuf=0; },
    newGame(ids, prev){
      /* 盤面形狀(v1.55.0):由**出題的這台裝置**依自己的畫面比例挑,再連同 tiles 一起寫進
         game 節點 → 全房都照這個形狀擺。
         ★ 絕對不可以讓每台各自算 —— 全房共用同一份 tiles + 格位索引,形狀不同就整盤錯位:
           A 看到的第 37 格和 B 看到的第 37 格不是同一個位置,消掉的牌會亂飛。
         ★ 副作用是「房主用手機開房,大家就都拿到直式」。可以接受:形狀只影響好不好按,
           而寬版在手機上更難按,拿到直式的桌機玩家只是牌小一點。 */
      const q=MGen.make(diff, MGen.pickShape(diff, innerWidth, innerHeight));
      // 座位順序每局輪換一次,顏色才不會永遠同一個人拿 p0
      let ord;
      if(prev && prev.length===ids.length) ord=prev.slice(1).concat(prev[0]);
      else { ord=ids.slice(); for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; } }
      const pr=ctx.ref("progress"); if(pr) pr.remove();     // 上一局的進度不要帶到這局
      return { order:ord, moves:[], shuf:0, tiles:q?q.code:"", shape:q?q.shape:"wide", mode:mode, diff:diff };
    },
    applyGame(g, playing){
      if(!playing) return;
      gMode=(g.mode==="race")?"race":"grab";
      gDiff=MGen.LEVELS[g.diff]?g.diff:"m72";
      // 舊版房間沒有 shape 欄位 → shapeOf() 會回 "wide",正好是 v1.54.0 以前唯一的佈局
      gShape=MGen.shapeOf(g.shape);

      /* 新的一局 → 整盤重建。
         ★ 判斷「新局」用 roundId,**不可以用 g.tiles 有沒有變** —— 搶牌的重洗就是在改
            g.tiles,拿 tiles 當判準會把重洗誤判成新局、把大家消掉的牌全部復活。 */
      const rid=ctx.roundId();
      if(g.tiles && rid!==curRound){
        clearAuto();                    // 上一局排的自動重洗絕不能洗到新的盤面上
        shufN=g.shuf||0;
        /* ⚠ curRound 一定要**等 setBoard 真的做完**才寫進去(v1.181.2,成語接龍那邊先修的
           同一條):先寫的話,setBoard 丟例外的那一台從此 rid === curRound,
           這一局再也進不來這個分支 —— 盤面停在上一局,而且沒有任何錯誤訊息。 */
        MB.setBoard({ level:gDiff, shape:gShape, tiles:g.tiles });
        curRound=rid;
        total=MB.total();
        moves=[]; tally=[]; myShuf=0; startedAt=Date.now();
        stallOn();                        // 僵局時鐘跟著這一局起跑(total 這時才有值)
        if(gMode==="race") pushProgress();
      }
      /* ★★★ 解鎖**不綁在「新局」那個分支裡**(v1.181.2)。舊寫法只有重建盤面那一拍會
         setEnabled(true) —— 那一拍沒跑到(漏收快照 / 重連歸位 / 分支上一行丟例外)
         這一台就整局鎖著:牌看得到、點下去完全沒反應,而且再也沒有第二次機會。
         成語接龍(同一族的搶字實作)在現場踩到的就是這個形狀 → 改成每份快照都重申一次。 */
      if(!ctx.winner()) MB.setEnabled(true);
      if(!total) return;

      if(gMode==="grab"){
        // 重洗:牌面換了但存活狀態不動
        if(g.tiles && (g.shuf||0)!==shufN){
          shufN=g.shuf||0;
          MB.flash("");                   // 純光帶,遮掩整盤換牌那一瞬間(訊息交給下面的 toast)
          MB.setTiles(MGen.parse(g.tiles));
          Sound.takeback();
          showToast("盤面已重洗 🔀",1400);
          stallReset();
        }
        const wasN=moves.length;
        const next=Array.isArray(g.moves)?g.moves:[];
        const pops=[];
        // 能延續就只補新的幾筆,否則整盤重建(重連 / 中途歸位)
        const extend = next.length>=moves.length && moves.every((v,k)=>next[k]===v);
        if(!extend){
          const a=new Uint8Array(total).fill(1);
          tally=[];
          next.forEach(c=>{ const m=dec(c); a[m.i]=0; a[m.j]=0; bump(tally,m.seat); });
          MB.setAlive(a);
          moves=next.slice();
        }else{
          const added=next.slice(moves.length);
          moves=next.slice();
          const me=mySeat();
          // 一次補很多筆 = 重連歸位或剛開打的批次同步 → 不連播音效、不跳 toast
          const quiet=added.length>1;
          added.forEach(c=>{
            const m=dec(c);
            bump(tally,m.seat);
            if(!quiet) pops.push(m.seat);
            const nm=MB.nameAt(m.i);
            /* ★ 第四個參數是 v2.4.4 的動效分流:mine 決定這一手算不算進**我的**連擊
               (搶牌模式別人消的那一手也走這裡)、quiet 決定要不要放中點爆光與清盤金光
               —— 同這一段對音效與 toast 的處理,批次補回來的不是「剛剛發生的事」。 */
            MB.remove(m.i,m.j,colorOf(m.seat),{ mine:m.seat===me, quiet:quiet });
            if(!quiet){
              Sound.place();
              if(m.seat!==me) showToast("⚡ "+ctx.dispName(ctx.order()[m.seat]||"")+" 消掉 "+nm,1100);
            }
          });
        }
        if(moves.length!==wasN) stallReset();   // 有人消掉了(誰都算)→ 僵局時鐘歸零
        renderHud();
        pops.forEach(s=>popScore(s));       // 一定要在 renderHud() 之後(它會重建 innerHTML)
        if(MB.cleared()){ if(!ctx.winner()) settleGrab(); }
        else if(!MB.anyMove()) armAuto();
      }else{
        renderHud();
      }
    },

    /* ---------- 相位的專屬畫面 ---------- */
    openConnect(){ showScreen("connect"); },
    enterLobby(){
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      MB.setEnabled(false);
      ruleHint();
    },
    backToLobby(){
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      clearAuto();
      curRound=null; moves=[]; tally=[]; shufN=0; myShuf=0;
      MB.setEnabled(false);
      const box=$("mjHud"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
      ruleHint();
    },
    enterPlaying(){
      showScreen("play");
      // 對戰中收起房間框的名單列:比分 HUD 已經在講同一件事,把那 30px 讓給盤面
      $("mpBar").classList.add("playing");
      MB.fit();
      Sound.start();
    },
    onLeave(){
      clearAuto();
      curRound=null; moves=[]; tally=[]; prog={}; shufN=0; myShuf=0;
      MB.setEnabled(false);
      const box=$("mjHud"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost=ctx.isHost();
      const mSeg=$("mjModeSeg"), dSeg=$("mjDiffSeg");
      if(mSeg){ mSeg.classList.toggle("readonly",!isHost); [...mSeg.children].forEach(b=>b.classList.toggle("on",b.dataset.mode===mode)); }
      if(dSeg){ dSeg.classList.toggle("readonly",!isHost); [...dSeg.children].forEach(b=>b.classList.toggle("on",b.dataset.diff===diff)); }
      const mL=$("mjModeLabel"); if(mL) mL.textContent=isHost?"玩法":"玩法(房主決定)";
      const dL=$("mjDiffLabel"); if(dL) dL.textContent=isHost?"盤面":"盤面(房主決定)";
      ruleHint();
    },
    updateGoal(){
      const g=$("mpBarGoal"); if(!g)return;
      const live=ctx.phase()==="playing";
      const L=MGen.levelOf(live?gDiff:diff);
      g.textContent=((live?gMode:mode)==="grab" ? "⚡ 搶牌" : "⏱ 競速")+" · "+L.label;
      g.classList.remove("hidden");     // 麻將沒有認輸鈕來搶這個位置,對戰中也留著
    },

    /* ---------- 名單 / 文案 ---------- */
    chipLead(id){
      const seat=seatOf(id);
      if(seat<0) return null;
      return '<span class="mj-seat '+colorOf(seat)+'"></span>';
    },
    chipTail(id){
      const seat=seatOf(id); if(seat<0) return "";
      if(gMode==="grab") return '<span class="mj-pts">'+(tally[seat]||0)+'</span>';
      const p=prog[id]||{};
      return '<span class="mj-pts">'+Math.round(((p.n||0)/pairsTotal())*100)+'%</span>';
    },
    // 人數一律讀 ctx.maxPlayers / ctx.minPlayers,不要再寫死(數獨從 4 開到 6 時就是漏在這兩句文案)
    lobbyStatusText(ids){
      return ids.length<ctx.minPlayers
        ? "等待其他人加入…(最多 "+ctx.maxPlayers+" 人)"
        : "等待大家準備…("+ids.length+" 人)";
    },
    readyHint(ids,ready){
      if(ids.length<ctx.minPlayers) return "至少要 "+ctx.minPlayers+" 個人才能開始(最多 "+ctx.maxPlayers+" 人)";
      return ready ? "等其他人按準備…" : "按「準備好了」就開始";
    },
    refresh(){ renderHud(); },

    /* ---------- 結果 ---------- */
    outcome(w,{ iWon, isDraw, mine }){
      clearAuto();
      MB.setEnabled(false); MB.clearSel();
      renderHud(); renderWinnerRow(w,isDraw);
      const box=$("mjStats"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
      if(gMode==="race"){
        const secs=w.ms?(" · "+Math.round(w.ms/1000)+" 秒"):"";
        if(iWon) return { word:"你贏了!", msg:"最快清空整盤 🎉"+secs };
        return { word:"你輸了", msg:esc(w.name||"對手")+" 先清完了"+secs };
      }
      if(isDraw) return { word:mine?"平手!":"你輸了", msg:"盤面清空,最高分同分 🤝 各得 1 勝" };
      if(iWon)   return { word:"你贏了!", msg:"消最多對,漂亮 🎉("+(w.pts||0)+" 對)" };
      return { word:"你輸了", msg:esc(w.name||"對手")+" 消了 "+(w.pts||0)+" 對" };
    },

    /* ---------- 偏好(mahjong.prefs.v1;ui-kit 的 savePrefs/loadPrefs 會呼叫這兩支)----------
       ★ 同款高亮不是連線設定,但它的家在這裡 —— 這支 adapter 是 mahjong.prefs.v1 的擁有者,
         而 loadPrefs() 在單機模式也會跑,所以單機一樣吃得到。真相存在 MB 裡,這裡只轉手。 */
    // ⚠ big = 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){ return { mode:mode, diff:diff, same:MB.sameHint(), big: BigMode.get() }; },
    usePrefs(o){
      // 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
      BigMode.set(!!o.big);
      if(o.mode==="race"||o.mode==="grab") mode=o.mode;
      if(MGen.LEVELS[o.diff]) diff=o.diff;
      MB.setSameHint(o.same===true);      // 沒存過就是 false(預設不提醒)
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api:{
      // shuffle 沒有 UI 入口(v1.54.0 拿掉按鈕):死局時由 armAuto() 自動呼叫,
      // 仍然暴露出來是為了 tools/gen-e2e.py 能直接驗兩種模式的重洗語意(搶牌 shuf+1 / 競速只動自己)
      onPair, shuffle,
      // 僵局只能靠時間觸發,e2e 等不了 8/15/25 秒 → 讓測試把時鐘往回撥(tools/gen-e2e.py 在用)
      stallAge(ms){ stallFrom-=(+ms||0); },
      mode:()=>mode, diff:()=>diff, gameMode:()=>gMode,
      setMode(v){
        v=(v==="race")?"race":"grab";
        if(!ctx.setRoomField("mode",v,{ lobbyOnly:true, denyMsg:"只有房主能改玩法", busyMsg:"對戰中不能改玩法" }))return;
        mode=v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      setDiff(v){
        if(!MGen.LEVELS[v])return;
        if(!ctx.setRoomField("diff",v,{ lobbyOnly:true, denyMsg:"只有房主能改盤面", busyMsg:"對戰中不能改盤面" }))return;
        diff=v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      }
    }
  };

  /* 「這局是誰拿下」:大字是主觀的,這一列給客觀事實 —— 顏色 + 名字 +(你) */
  function renderWinnerRow(w,isDraw){
    const el=$("mjWinner"); if(!el)return;
    const ids = Array.isArray(w.ids) ? w.ids : (w.id?[w.id]:[]);
    if(!ids.length){ el.innerHTML=""; return; }
    const body=ids.map(id=>{
      const seat=seatOf(id);
      const dot=seat>=0?'<span class="mj-seat '+colorOf(seat)+'"></span>':'';
      return dot+'<span class="gw-name">'+esc(ctx.dispName(id))+'</span>'+ctx.youTag(id);
    }).join('<span class="gw-tag">·</span>');
    el.innerHTML=body+'<span class="gw-tag">'+(isDraw?"並列第一,各得 1 勝":"拿下這局")+'</span>';
  }
})());

"use strict";

/* ============================================================================
   五子棋 — 連線適配器(接上 js/shared/mp-core.js)
   由舊的 js/gomoku/net.js 拆出:房間 / 斷線 / 計分 / 表情那七成已進共用核心,
   這裡只留五子棋自己的規則與畫面。

   五子棋相對於共用核心的兩個刻意簡化:
   • 不存 turnIndex —— 嚴格輪流,該下的人 = order[moves.length % 2],少一個不一致來源
   • 沒有平手 winAt 判定 —— 勝負由「下最後一手的人」單方寫入,第一個寫進去的就是結果
   ========================================================================== */

const MP = MPCore.create((function(){
  const SIZES=[15,19,25];       // 可選盤面;預設值也定義在 gomoku.html 的 .on,兩處要一致
  let boardSize=19;             // 預設中間的 19×19(15×15 下起來很快就頂到邊界)
  let swapFirst=true;
  let moves=[];
  let wasMyTurn=false;
  let ctx=null;

  function myColor(){ const o=ctx.order(); return o.length && o[0]===ctx.me() ? "b" : "w"; }
  function turnId(){ const o=ctx.order(); return o.length ? o[moves.length % o.length] : null; }
  function isMyTurn(){ return ctx.phase()==="playing" && !ctx.winner() && !ctx.abandoned() && turnId()===ctx.me(); }

  /* ---------- 落子 ---------- */
  function tap(i){
    if(ctx.phase()!=="playing"){ return; }
    if(ctx.winner()||ctx.abandoned()){ return; }
    if(!isMyTurn()){ showToast("還沒輪到你"); return; }
    if(GB.occupied(i)){ showToast("這裡已經有子了"); return; }
    const step=moves.length;
    // 交易內原子 append:即使兩端同時點也不會覆蓋彼此;步數不符(對手先寫進去)就中止
    ctx.txGame(g=>{
      if(g.status!=="playing"||g.winner)return false;
      const mv=Array.isArray(g.moves)?g.moves:[];
      if(mv.length!==step)return false;      // 這一步已被別人佔用(不同步)→ 中止,等快照
      if(mv.indexOf(i)>=0)return false;
      g.moves=mv.concat(i);
    });
  }
  // 落子後的結算:連五 / 和局。只由「下這一手的人」寫入,避免兩端同時寫
  function maybeSettle(last){
    if(ctx.winner())return;
    const iPlacedIt=(GB.colorOfStep(moves.length-1)===myColor());
    if(!iPlacedIt)return;
    const line=GB.checkWin(last);
    if(line){
      ctx.txGame(g=>{ if(g.winner)return false; g.winner={ id:ctx.me(), name:ctx.name(), by:"five", line:line }; });
      return;
    }
    if(GB.isFull()){
      ctx.txGame(g=>{ if(g.winner)return false; g.winner={ id:null, name:"", by:"draw" }; });
    }
  }

  /* ★ 「第 N 手」(v2.4.4)—— 建議書那對「兩側木質棋笥」裡真正有用的一半。
     ⚠ 棋笥本體不做:它要吃掉盤面**寬度**,而這一頁在手機上就是被寬度卡住的
       (`.gmk-stage` 是 `min(92vw,520px)`)。持子方本來就在這顆膠囊上,
       只有「走到第幾手」是新資訊 → 塞進膠囊 = 零版面成本。
     ⚠ 第 0 手不顯示(開局寫「第 0 手」很怪),而且結束了也不顯示(那時講的是勝負)。 */
  function stepTag(){
    const k = GB.stepCount();
    return k > 0 ? ('<span class="gmk-step">第 ' + k + ' 手</span>') : "";
  }

  /* ---------- 輪到誰:棋盤上緣的膠囊(自己的回合會高亮脈動) ---------- */
  function updateTurnUI(){
    const cap=$("gmkTurn"), txt=$("gmkTurnTxt");
    if(!cap||!txt)return;
    if(ctx.phase()!=="playing"){ cap.classList.remove("mine"); return; }
    const mine=isMyTurn();
    const tid=turnId(), o=ctx.order(), w=ctx.winner();
    const color=o.length ? (o.indexOf(tid)===0?"b":"w") : "b";
    const dot=cap.querySelector(".gmk-dot");
    if(dot) dot.className="gmk-dot "+color;
    if(w) txt.textContent="這局結束";
    /* ⚠ 名字要自己 esc() —— 這一行從 textContent 換成 innerHTML 了(要放「第 N 手」那顆膠囊),
       而 dispName() 是玩家自己打的字(notes/07 踩坑 #9 是同一個洞)。 */
    else txt.innerHTML = (mine ? "輪到你" : ("輪到 " + esc(tid ? ctx.dispName(tid) : "對手"))) + stepTag();
    cap.classList.toggle("mine", mine && !w);
    GB.setInteractive(mine && !w && !ctx.abandoned(), myColor());
    notifyMyTurn(mine && !w);
  }
  function notifyMyTurn(mine){
    if(mine && !wasMyTurn){
      try{ Sound.turn(); }catch(e){}
      if(typeof vibrateOn!=="undefined" && vibrateOn && navigator.vibrate){ try{ navigator.vibrate([90,60,90]); }catch(e){} }
    }
    wasMyTurn=mine;
  }

  /* ---------- 「這局是誰拿下」:大字是主觀的,這一列給客觀事實 ---------- */
  function renderWinnerRow(isDraw){
    const el=$("gmkWinner"); if(!el)return;
    if(isDraw){ el.innerHTML='<span class="gw-tag">🤝 雙方平手,各得 1 勝</span>'; return; }
    const w=ctx.winner(), id=w.id, seat=ctx.order().indexOf(id);
    const side=seat>=0?'<span class="gmk-seat '+(seat===0?"b":"w")+'"><i></i>'+(seat===0?"黑":"白")+'</span>':'';
    el.innerHTML=side+'<span class="gw-name">'+esc(ctx.dispName(id))+'</span>'+ctx.youTag(id)+'<span class="gw-tag">拿下這局</span>';
  }

  return {
    ns:{ rooms:"gomoku_rooms", index:"gomoku_index" },
    minPlayers:2, maxPlayers:2,          // 第一版 1v1(擂台觀戰見 notes/06 的「第二版預留」)
    /* ★★ 原班人馬可以回座(誤按離開 / 關分頁 / 斷線之後回到**還在打的那一場**)。
       ⚠⚠ 它**不是** joinMidGame:放行的只有 `game.order` 裡本來就有的那個 pid
         (全新的人照舊擋在外面)—— 完整的理由在 js/shared/mp-core.js 的 REJOIN_MID 那一段。
       ★ 2 人局 → 對手離開後 8 / 60 秒本局作廢;回座在倒數內回來就把倒數取消了。 */
    rejoinMidGame: true,
    prefsKey:"gomoku.prefs.v1",
    emoteAnchor:"gmkStage",
    winCardId:"gmkWinCard",
    hasResign:true,

    init(c){ ctx=c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { boardSize:boardSize, swapFirst:swapFirst }; },
    onRoomField(k,v){
      if(k==="boardSize"){
        if(typeof v!=="number"||SIZES.indexOf(v)<0||v===boardSize)return;
        boardSize=v;
        ctx.unreadyOnFieldChange();       // 房主改了盤面 → 訪客的「準備」要退回
        if(ctx.phase()==="playing"){ GB.setSize(boardSize); GB.applyMoves(moves); GB.fit(); }
        ctx.syncSetup(); ctx.updateGoal();
      }else if(k==="swapFirst"){
        swapFirst=(v!==false); ctx.syncSetup();
      }
    },
    readRoom(r){ if(typeof r.boardSize==="number") boardSize=r.boardSize; },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { moves:[] }; },
    resetRound(){ moves=[]; },
    newGame(ids, prev){
      // 先手:swapFirst → 沿用上一局順序反轉(輪流當黑);否則每局重抽
      let ord;
      if(swapFirst && prev) ord=prev.reverse();
      else { ord=ids.slice(); for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; } }
      return { order:ord, moves:[] };
    },
    applyGame(g, playing){
      const nextMoves=Array.isArray(g.moves)?g.moves:[];
      if(!playing){ moves=nextMoves.slice(); return; }
      // 棋盤同步:能延續就只 append 新子,否則整盤重建
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
    },

    /* ---------- 相位的專屬畫面 ---------- */
    // 各相位只說「要哪個畫面」,實際的 hidden 切換交給 main.js 的 showScreen()
    // (v1.51.0 起五子棋也有進場選單與電腦對決,自己一塊一塊 toggle 會漏掉新畫面)
    openConnect(){ showScreen("connect"); },
    enterLobby(){
      showScreen("lobby");
      $("resignBtn").classList.add("hidden");
    },
    backToLobby(){
      moves=[]; wasMyTurn=false;
      showScreen("lobby");
      $("resignBtn").classList.add("hidden");
      GB.reset(); GB.setInteractive(false);
    },
    enterPlaying(){
      wasMyTurn=false;
      showScreen("play");
      $("resignBtn").classList.remove("hidden");
      GB.setSize(boardSize);
      GB.applyMoves(moves);
      // 舞台這一刻才從 hidden 變可見,同一個 tick 量到的 clientWidth 還是 0 → 下一格再算一次視角。
      // initialView():小盤面直接 fit;大盤面(fit 後每格 < 30px)自動放大到中央天元
      requestAnimationFrame(()=>GB.initialView());
      if(moves.length) GB.setLastByIndex(moves[moves.length-1]);
      updateTurnUI();
    },
    onLeave(){
      moves=[]; wasMyTurn=false;
      GB.reset(); GB.setInteractive(false);
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost=ctx.isHost();
      const szSeg=$("gmkSizeSeg"), swSeg=$("gmkSwapSeg");
      if(szSeg){ szSeg.classList.toggle("readonly",!isHost); [...szSeg.children].forEach(b=>b.classList.toggle("on",(+b.dataset.size)===boardSize)); }
      if(swSeg){ swSeg.classList.toggle("readonly",!isHost); [...swSeg.children].forEach(b=>b.classList.toggle("on",(b.dataset.swap==="1")===swapFirst)); }
      const szL=$("gmkSizeLabel"); if(szL) szL.textContent=isHost?"棋盤大小":"棋盤大小(房主決定)";
      const swL=$("gmkSwapLabel"); if(swL) swL.textContent=isHost?"每局換先手":"每局換先手(房主決定)";
    },
    updateGoal(){
      const g=$("mpBarGoal"); if(!g)return;
      g.textContent = boardSize ? ("⬜ "+boardSize+"×"+boardSize) : "";
      // 對戰中讓位給認輸鈕(同一格位置):幾路棋盤看盤面就知道,大廳才是真的需要看它挑設定
      g.classList.toggle("hidden", ctx.phase()==="playing");
    },

    /* ---------- 名單 / 文案 ---------- */
    turnId,
    // 對戰中換成「棋子+黑/白」徽章(小圓點在深色主題下看不出誰是誰)
    chipLead(id){
      const seat=ctx.order().indexOf(id);
      if(seat<0) return null;
      return '<span class="gmk-seat '+(seat===0?"b":"w")+'" title="'+(seat===0?"黑棋(先手)":"白棋")+'"><i></i>'+(seat===0?"黑":"白")+'</span>';
    },
    lobbyStatusText(ids){ return ids.length<2?"等待對手加入…":"等待雙方準備…"; },
    readyHint(ids,ready){
      return ids.length<2 ? "等對手加入…(房間可分享給朋友)"
                          : (ready ? "等對手按準備…" : "按「準備好了」就開始");
    },
    refresh(){ updateTurnUI(); },

    /* ---------- 結果 ---------- */
    outcome(w,{ iWon, isDraw }){
      if(w.line) GB.markWin(w.line);
      GB.setInteractive(false);
      $("resignBtn").classList.add("hidden");
      renderWinnerRow(isDraw);
      if(isDraw) return { word:"平手!", msg:"棋盤下滿了,這局和局 🤝" };
      if(iWon)   return { word:"你贏了!", msg:w.by==="resign" ? "對手認輸 🏳" : "五子連線,漂亮 🎉" };
      return { word:"你輸了", msg:w.by==="resign" ? "你認輸了 🏳" : "對手連成五子" };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){ return { boardSize:boardSize, swapFirst:swapFirst, big: BigMode.get() }; },
    usePrefs(o){
      // 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
      BigMode.set(!!o.big);
      if(SIZES.indexOf(o.boardSize)>=0) boardSize=o.boardSize;
      if(typeof o.swapFirst==="boolean") swapFirst=o.swapFirst;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api:{
      tap, isMyTurn, myColor,
      boardSize:()=>boardSize, swapFirst:()=>swapFirst,
      setBoardSize(v){
        if(SIZES.indexOf(v)<0)return;
        if(!ctx.setRoomField("boardSize",v,{ lobbyOnly:true, denyMsg:"只有房主能改棋盤大小", busyMsg:"對戰中不能改棋盤" }))return;
        boardSize=v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      setSwapFirst(on){
        if(!ctx.setRoomField("swapFirst",!!on,{ denyMsg:"只有房主能改" }))return;
        swapFirst=!!on; ctx.syncSetup(); savePrefs();
      }
    }
  };
})());

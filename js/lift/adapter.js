"use strict";
// @transaction-rules LF: submit/progress mutate the authoritative game snapshot.
const MP = MPCore.create((()=>{
  let ctx=null, g=null, botTimer=null, botKey="", seasonScores={}, nativeCaption, scoredBotRound=null, lastTick="";
  const BOT="~lfai1",isBot=id=>id===BOT;
  const name=id=>isBot(id)?"電腦 1":ctx.dispName(id);
  const hasBot=()=>!!g&&Array.isArray(g.order)&&g.order.includes(BOT);
  function readyText(ids,ready){
    return ids.length<2?"等待另一位朋友加入":ids.length===2?(ready?"等朋友準備；電腦會自動加入":"兩人準備好，電腦自動補足三人"):ready?"等大家按準備":"按準備好了開始";
  }
  function clearBot(){clearTimeout(botTimer);botTimer=null;botKey="";}
  function paint(){if(g)LFB.render(g,ctx.me(),name,send,true,ctx.renderPlayers);}
  // 各參賽者都能接手；種子固定，交易重試與競爭不會改變電腦決策。
  function botRandom(game){
    let seed=2166136261;
    for(const c of `${game.roundId}/${game.turn}/${game.stage}/${BOT}`)seed=Math.imul(seed^c.charCodeAt(0),16777619)>>>0;
    return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  }
  function needsBot(game){
    return game&&!game.winner&&game.order.includes(BOT)&&
      (game.stage==="targets"?LF.needs(game,BOT).length&&!(game.submitted||{})[BOT]:
        game.stage==="bid"&&!Object.prototype.hasOwnProperty.call(game.bids||{},BOT));
  }
  function scheduleBot(){
    if(!needsBot(g)||ctx.spectating()||ctx.abandoned()){clearBot();return;}
    const round=g.roundId,turn=g.turn,stage=g.stage,key=[round,turn,stage].join("/");
    if(botTimer&&key===botKey)return;
    clearBot();botKey=key;
    botTimer=setTimeout(()=>{
      botTimer=null;botKey="";
      if(ctx.phase()!=="playing"||ctx.spectating()||ctx.abandoned())return;
      ctx.txGame(next=>{
        if(next.roundId!==round||next.turn!==turn||next.stage!==stage||!needsBot(next))return false;
        const random=botRandom(next),value=stage==="targets"?LFAI.targets(next,BOT,random):LFAI.bid(next,BOT,random);
        if(!LF.submit(next,BOT,value,turn,lfNow()))return false;
      },{local:false});
    },650);
  }
  function recordBotWin(){
    if(!hasBot()||!g.winner||ctx.spectating()||ctx.abandoned()||scoredBotRound===g.roundId||seasonScores[BOT]?.round===g.roundId)return;
    const round=g.roundId,add=g.winner.ids.includes(BOT)?1:0,ref=ctx.ref("scores/"+BOT);
    if(!ref)return;scoredBotRound=round;
    ref.transaction(s=>{
      if(s&&s.round===round)return;
      return {n:((s&&s.n)||0)+add,round,d:add,nm:name(BOT)};
    },error=>{if(error&&scoredBotRound===round)scoredBotRound=null;});
  }
  function paintSeason(){
    const active=hasBot()&&!!g.winner,box=$("lfBotSeason");
    $("winScores").classList.toggle("lf-bot-scores-hidden",active);
    $("winChamp").classList.toggle("lf-bot-scores-hidden",active);
    $("mpNewSeason").classList.toggle("lf-bot-scores-hidden",active);
    if(nativeCaption)nativeCaption.classList.toggle("lf-bot-scores-hidden",active);
    box.classList.toggle("hidden",!active);if(!active)return;
    const rows=g.order.map(id=>({id,name:name(id),score:((seasonScores[id]&&seasonScores[id].n)||0)+
      (seasonScores[id]?.round!==g.roundId&&g.winner.ids.includes(id)?1:0)})).sort((a,b)=>b.score-a.score);
    const top=rows[0].score;
    const champs=MP.scoreMode()==="match"&&top>=MP.winGoal()?rows.filter(r=>r.score===top):[];
    const goal=MP.scoreMode()==="match"&&!champs.length?'<div class="ws-goal">🎯 搶 '+MP.winGoal()+' 勝</div>':"";
    box.innerHTML='<div class="lf-score-caption">累積勝場</div>'+goal+rows.map((r,i)=>`<div class="ws-row${r.score===top&&top>0?" lead":""}${r.id===ctx.me()?" me":""}"><span class="ws-rank">${r.score===top&&top>0?"🏆":(i+1)+"."}</span><span class="ws-name">${esc(r.name)}</span>${g.winner.ids.includes(r.id)?'<span class="gw-plus">+1</span>':""}<span class="ws-pts">${r.score} 勝</span></div>`).join("");
    if(champs.length)box.innerHTML+='<div class="win-champ" id="lfBotChamp"><span class="champ-label">🏆 總冠軍</span><span class="champ-name">'+champs.map(r=>esc(r.name)).join("、")+'</span><span class="champ-goal">先達 '+MP.winGoal()+' 勝</span></div>'+(ctx.isHost()?'<button class="btn primary block-btn" id="lfBotNewSeason">開始新賽季</button>':'');
  }
  function send(value,turn){
    if(!g || ctx.spectating() || ctx.abandoned())return;
    const round=g.roundId, stage=g.stage, id=ctx.me(), now=lfNow();
    ctx.txGame(next=>{
      if(next.roundId!==round || next.stage!==stage || next.turn!==turn)return false;
      if(!LF.submit(next,id,value,turn,now))return false;
    },{local:false});
  }
  // 到期由任何仍在線的參賽者原子推進，不依賴房主留在前景。
  setInterval(()=>{
    if(!g || g.winner || ctx.phase()!=="playing" || ctx.spectating() || ctx.abandoned())return;
    scheduleBot();
    const remain=Math.max(0,Math.ceil((g.deadline-lfNow())/1000));
    // 最後五秒且自己還沒出手才催：變色加滴答；已經出完的人不被打擾。
    const urgent=g.stage!=="reveal"&&remain>0&&remain<=5&&LF.waiting(g,ctx.me());
    $("lfClock").textContent=`${remain} 秒`;$("lfClock").classList.toggle("lf-clock-urgent",urgent);
    const tickKey=[g.roundId,g.turn,g.stage,remain].join("/");
    if(urgent&&tickKey!==lastTick){lastTick=tickKey;LFB.tick();}
    if(lfNow()<g.deadline)return;
    const round=g.roundId, turn=g.turn, stage=g.stage, now=lfNow();
    ctx.txGame(next=>{
      if(next.roundId!==round || next.turn!==turn || next.stage!==stage)return false;
      if(!LF.progress(next,now))return false;
    },{local:false});
  },1000);
  return {
    ns:{rooms:"lift_rooms",index:"lift_index"}, prefsKey:"bingo.lift.v1",emoteAnchor:"lfStage",
    minPlayers:2,maxPlayers:8,winCardId:"lfWinCard",spectate:true,rejoinMidGame:true,
    init(c){ctx=c;nativeCaption=$("winScores").previousElementSibling;const box=document.createElement("div");box.id="lfBotSeason";box.className="win-scores hidden";box.addEventListener("click",e=>{if(e.target.closest("#lfBotNewSeason")){MP.resetScores();MP.again();}});$("winScores").after(box);},
    listen(){const ref=ctx.ref("scores");if(ref)ref.on("value",s=>{seasonScores=s.val()||{};paintSeason();});},
    lobbyGame(){return {};},newGame(ids){return LF.newGame(ids.length===2?ids.concat(BOT):ids,lfNow());},
    resetRound(){clearBot();g=null;LFB.reset();paintSeason();},applyGame(next,playing){g=next;if(playing){paint();scheduleBot();}},
    openConnect(){showScreen("connect");},enterLobby(){showScreen("lobby");},
    backToLobby(){clearBot();showScreen("lobby");LFB.reset();},enterPlaying(){showScreen("play");},
    onLeave(){clearBot();g=null;seasonScores={};scoredBotRound=null;LFB.reset();paintSeason();showScreen("home");},
    syncSetup(){queueMicrotask(()=>{paintSeason();if(MP.isOnline()&&ctx.phase()==="lobby"&&!ctx.spectating())setActionHint(readyText(Object.keys(ctx.players()),MP.amReady()));});},
    extraChips(){return (ctx.phase()==="playing"?hasBot():Object.keys(ctx.players()).length===2)?[{id:BOT,name:name(BOT),ready:true}]:[];},
    updateGoal(){const e=$("mpBarGoal");if(e)e.textContent="9 回合";},
    chipTail(id){return g&&g.scores&&g.scores[id]!==undefined?`${LFB.visibleScore(g,id)} 分`:"";},
    lobbyStatusText(ids){return ids.length<2?"邀一位朋友加入，兩人即可玩！":ids.length===2?"兩位真人 + 電腦 1，準備好就開始！":"等大家準備，開始九回合對戰";},
    readyHint:readyText,
    refresh(){paint();},
    outcome(w,{iWon}){
      $("lfRanking").innerHTML=LFB.ranking(g,name,ctx.me());recordBotWin();queueMicrotask(paintSeason);
      return {word:iWon?"你拿下了！":"本局結束",msg:"九回合結算，同分並列。"};
    },
    ownPrefs(){return {big:BigMode.get()};},usePrefs(o){BigMode.set(!!o.big);},api:{send,state:()=>g}
  };
})());

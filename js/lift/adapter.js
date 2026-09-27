"use strict";
// @transaction-rules LF: submit/progress mutate the authoritative game snapshot.
const MP = MPCore.create((()=>{
  let ctx=null, g=null;
  function paint(){if(g)LFB.render(g,ctx.me(),ctx.dispName,send,true);}
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
    $("lfClock").textContent=`${Math.max(0,Math.ceil((g.deadline-lfNow())/1000))} 秒`;
    if(lfNow()<g.deadline)return;
    const round=g.roundId, turn=g.turn, stage=g.stage, now=lfNow();
    ctx.txGame(next=>{
      if(next.roundId!==round || next.turn!==turn || next.stage!==stage)return false;
      if(!LF.progress(next,now))return false;
    },{local:false});
  },1000);
  return {
    ns:{rooms:"lift_rooms",index:"lift_index"}, prefsKey:"bingo.lift.v1",emoteAnchor:"lfStage",
    minPlayers:3,maxPlayers:8,winCardId:"lfWinCard",spectate:true,rejoinMidGame:true,
    init(c){ctx=c;},lobbyGame(){return {};},newGame(ids){return LF.newGame(ids,lfNow());},
    resetRound(){g=null;LFB.reset();},applyGame(next,playing){g=next;if(playing)paint();},
    openConnect(){showScreen("connect");},enterLobby(){showScreen("lobby");},
    backToLobby(){showScreen("lobby");LFB.reset();},enterPlaying(){showScreen("play");},
    onLeave(){g=null;LFB.reset();showScreen("home");},syncSetup(){},
    updateGoal(){const e=$("mpBarGoal");if(e)e.textContent="9 回合";},
    chipTail(id){return g&&g.scores&&g.scores[id]!==undefined?`${g.scores[id]} 分`:"";},
    lobbyStatusText(ids){return ids.length<3?"至少 3 人，邀朋友一起猜！":"等大家準備，開始九回合對戰";},
    readyHint(ids,ready){return ids.length<3?"等待至少 3 人加入":ready?"等大家按準備":"按準備好了開始";},
    refresh(){paint();},
    outcome(w,{iWon}){
      $("lfRanking").innerHTML=LFB.ranking(g,ctx.dispName);
      return {word:iWon?"你拿下了！":"本局結束",msg:"九回合結算，同分並列。"};
    },
    ownPrefs(){return {big:BigMode.get()};},usePrefs(o){BigMode.set(!!o.big);},api:{send,state:()=>g}
  };
})());

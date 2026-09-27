"use strict";
const Solo = (()=>{
  let g=null, count=4;
  const name=id=>id==="you"?"你":`電腦 ${id.slice(3)}`;
  function paint(){LFB.render(g,"you",name,send,false);}
  function bots(){
    if(g.stage==="targets")g.order.slice(1).forEach(id=>{if(LF.needs(g,id).length && !(g.submitted||{})[id])LF.submit(g,id,LFAI.targets(g,id,Math.random),g.turn,Date.now());});
    if(g.stage==="bid")g.order.slice(1).forEach(id=>{if(!Object.prototype.hasOwnProperty.call(g.bids||{},id))LF.submit(g,id,LFAI.bid(g,id,Math.random),g.turn,Date.now());});
    if(g.stage==="reveal")g.order.slice(1).forEach(id=>{g.ack[id]=true;});
  }
  function start(){
    count=+$("lfCount").value;g=LF.newGame(["you",...Array.from({length:count-1},(_,i)=>"bot"+(i+1))],Date.now());g.status="playing";
    LFB.reset();$("veil").classList.remove("show");showScreen("solo");bots();paint();
  }
  function send(value,turn){
    if(!g || !LF.submit(g,"you",value,turn,Date.now()))return;
    bots();paint();
    if(g.winner){
      $("winWord").textContent=g.winner.ids.includes("you")?"你拿下了！":"本局結束";
      $("winMsg").textContent="九回合結算，同分並列。";
      $("lfRanking").innerHTML=LFB.ranking(g,name);$("veil").classList.add("show");
    }
  }
  function quit(){g=null;LFB.reset();$("veil").classList.remove("show");showScreen("home");}
  return {start,again:start,quit,playing:()=>!!g&&!g.winner,state:()=>g};
})();

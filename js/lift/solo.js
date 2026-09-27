"use strict";
const Solo = (()=>{
  let g=null, count=4, nextTimer=null;
  const name=id=>id==="you"?"你":`電腦 ${id.slice(3)}`;
  function paint(){
    clearTimeout(nextTimer);nextTimer=null;
    LFB.render(g,"you",name,send,false);
    if(g.stage==="reveal"&&!g.winner){
      const current=g, turn=g.turn;
      nextTimer=setTimeout(()=>{
        if(g!==current || g.turn!==turn || g.stage!=="reveal")return;
        LF.progress(g,Date.now());bots();paint();finish();
      },Math.max(1,g.deadline-Date.now()));
    }
  }
  function bots(){
    if(g.stage==="targets")g.order.slice(1).forEach(id=>{if(LF.needs(g,id).length && !(g.submitted||{})[id])LF.submit(g,id,LFAI.targets(g,id,Math.random),g.turn,Date.now());});
    if(g.stage==="bid")g.order.slice(1).forEach(id=>{if(!Object.prototype.hasOwnProperty.call(g.bids||{},id))LF.submit(g,id,LFAI.bid(g,id,Math.random),g.turn,Date.now());});
  }
  function start(){
    count=+$("lfCount").value;g=LF.newGame(["you",...Array.from({length:count-1},(_,i)=>"bot"+(i+1))],Date.now());g.status="playing";
    LFB.reset();$("veil").classList.remove("show");showScreen("solo");bots();paint();
  }
  function send(value,turn){
    if(!g || !LF.submit(g,"you",value,turn,Date.now()))return;
    bots();paint();finish();
  }
  function finish(){
    if(g.winner){
      // 連線的勝負音效由共用核心播；練習要自己播。同分並列也算拿下。
      if(g.winner.ids.includes("you")){Sound.win();burst();}else Sound.lose();
      $("winWord").textContent=g.winner.ids.includes("you")?"你拿下了！":"本局結束";
      $("winMsg").textContent="九回合結算，同分並列。";
      $("lfRanking").innerHTML=LFB.ranking(g,name,"you");$("veil").classList.add("show");
    }
  }
  function quit(){clearTimeout(nextTimer);nextTimer=null;g=null;LFB.reset();$("veil").classList.remove("show");showScreen("home");}
  return {start,again:start,quit,playing:()=>!!g&&!g.winner,state:()=>g};
})();

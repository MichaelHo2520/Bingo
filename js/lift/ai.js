"use strict";
const LFAI = (() => {
  function targets(g,id,random){
    const values=g.targets[id].slice();
    LF.needs(g,id).forEach(slot=>{values[slot]=LF.FLOORS[Math.floor(random()*9)];});
    return values;
  }
  function bid(g,id,random){
    // 只看自己的目標與公開的電梯位置，不讀其他玩家的秘密目標或已交出的牌。
    if(random()<0.25)return [0,5,10][Math.floor(random()*3)];
    let totals={0:1};
    for(let i=1;i<g.order.length;i++){
      const next={}; Object.entries(totals).forEach(([sum,weight])=>{
        [0,5,10].forEach(n=>{const k=+sum+n;next[k]=(next[k]||0)+weight;});
      }); totals=next;
    }
    const scores=[0,5,10].map(card=>Object.entries(totals).reduce((score,[sum,weight])=>{
      const f=LF.travel(g.floor,g.direction,+sum+card).floor;
      if(f===g.cone)return score;
      return score+weight*g.targets[id].reduce((p,target,slot)=>p+(target===f?(slot+1)*(f===0||f===40?2:1):0),0);
    },0));
    const best=Math.max(...scores), candidates=[0,5,10].filter((_,i)=>scores[i]===best);
    return candidates[Math.floor(random()*candidates.length)];
  }
  return {targets,bid};
})();

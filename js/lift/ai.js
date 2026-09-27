"use strict";
const LFAI = (() => {
  const value=(f,slot)=>(slot+1)*(f===0||f===40?2:1);
  // 依權重抽一個；全部為零時退回均等，避免永遠卡在同一樓。
  function pick(items,weights,random){
    const total=weights.reduce((s,w)=>s+w,0);
    if(!(total>0))return items[Math.floor(random()*items.length)];
    let r=random()*total;
    for(let i=0;i<items.length;i++){r-=weights[i];if(r<0)return items[i];}
    return items[items.length-1];
  }
  function targets(g,id,random){
    const values=g.targets[id].slice();
    // 所有人的牌都未知，估這一趟停在各樓層的機率；施工樓層這回合不計分，直接排除。
    const odds=LF.outcomes(g,0,g.order.length);
    LF.needs(g,id).forEach(slot=>{
      if(random()<0.25){values[slot]=LF.FLOORS[Math.floor(random()*9)];return;}
      // 平方讓電腦偏向高機率樓層，但仍保留一點變化，不會每台電腦都選同一樓。
      const weights=LF.FLOORS.map(f=>f===g.cone?0:Math.pow((odds[f]||0)*value(f,slot),2));
      values[slot]=pick(LF.FLOORS,weights,random);
    });
    return values;
  }
  function bid(g,id,random){
    // 只看自己的目標與公開的電梯位置，不讀其他玩家的秘密目標或已交出的牌。
    if(random()<0.25)return [0,5,10][Math.floor(random()*3)];
    const scores=[0,5,10].map(card=>{
      const odds=LF.outcomes(g,card,g.order.length-1);
      return Object.entries(odds).reduce((score,[f,p])=>{
        f=+f;if(f===g.cone)return score;
        return score+p*g.targets[id].reduce((s,target,slot)=>s+(target===f?value(f,slot):0),0);
      },0);
    });
    const best=Math.max(...scores), candidates=[0,5,10].filter((_,i)=>Math.abs(scores[i]-best)<1e-9);
    return candidates[Math.floor(random()*candidates.length)];
  }
  return {targets,bid};
})();

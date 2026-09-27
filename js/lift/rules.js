"use strict";

// 自行實作的數字預測遊戲。規則運算不依賴 DOM、網路或隨機數。
const LF = (() => {
  const FLOORS = [0,5,10,15,20,25,30,35,40];
  const validFloor = n => FLOORS.includes(n);
  const copy = x => JSON.parse(JSON.stringify(x));
  function travel(floor, direction, distance){
    const path = [floor];
    while(distance > 0){
      if(floor === 40) direction = -1;
      if(floor === 0) direction = 1;
      floor += direction * 5; distance -= 5; path.push(floor);
      if(floor === 40) direction = -1;
      if(floor === 0) direction = 1;
    }
    return {floor, direction, path};
  }
  function newGame(ids, now){
    const targets={}, replace={}, scores={};
    ids.forEach(id => { targets[id]=[10,20]; replace[id]=[0,1]; scores[id]=0; });
    return {order:ids.slice(), floor:0, direction:1, turn:1, cone:40,
      stage:"targets", targets, replace, scores, submitted:{}, bids:{}, ack:{},
      deadline:now+35000, last:null};
  }
  function needs(g,id){ return (g.replace && g.replace[id]) || []; }
  function fallback(g,id,slot){
    // 到時使用可重算的預設，不在 Firebase transaction 裡產生亂數。
    return FLOORS[(g.turn + g.order.indexOf(id)*2 + slot*3) % FLOORS.length];
  }
  function submit(g,id,values,expectedTurn,now){
    if(!g || g.winner || g.status!=="playing" || g.turn!==expectedTurn || !g.order.includes(id))return false;
    if(g.stage==="targets"){
      const slots=needs(g,id);
      if(!slots.length || (g.submitted||{})[id] || !Array.isArray(values) || values.length!==2 || !values.every(validFloor))return false;
      slots.forEach(slot=>{g.targets[id][slot]=values[slot];});
      g.submitted = g.submitted || {}; g.submitted[id]=true;
    } else if(g.stage==="bid"){
      if(![0,5,10].includes(values) || Object.prototype.hasOwnProperty.call(g.bids||{},id))return false;
      g.bids=g.bids||{}; g.bids[id]=values;
    } else if(g.stage==="reveal"){
      if((g.ack||{})[id])return false;
      g.ack=g.ack||{}; g.ack[id]=true;
    } else return false;
    progress(g,now); return true;
  }
  function settle(g,now){
    const from=g.floor, total=g.order.reduce((s,id)=>s+g.bids[id],0);
    const move=travel(g.floor,g.direction,total), gains={}, hits={}, replace={};
    g.floor=move.floor; g.direction=move.direction;
    g.order.forEach(id=>{
      const matched=[0,1].filter(slot=>g.targets[id][slot]===g.floor);
      hits[id]=matched; let points=0;
      if(g.floor!==g.cone) matched.forEach(slot=>{points+=(slot+1)*(g.floor===0||g.floor===40?2:1);});
      gains[id]=points; g.scores[id]+=points;
      replace[id]=(g.floor===g.cone && matched.length)?[0,1]:matched;
    });
    g.last={turn:g.turn,from,floor:g.floor,path:move.path,total,bids:copy(g.bids),
      gains,hits,blocked:g.floor===g.cone};
    g.replace=replace; g.stage="reveal"; g.ack={}; g.deadline=now+10000;
  }
  function progress(g,now){
    if(!g || g.status!=="playing" || g.winner)return false;
    const expired=now>=g.deadline;
    if(g.stage==="targets"){
      g.submitted=g.submitted||{};
      const ids=g.order.filter(id=>needs(g,id).length);
      if(expired) ids.forEach(id=>{if(!g.submitted[id]){
        needs(g,id).forEach(slot=>{g.targets[id][slot]=fallback(g,id,slot);});
        g.submitted[id]=true;
      }});
      if(!ids.every(id=>g.submitted[id]))return false;
      g.stage="bid"; g.bids={}; g.deadline=now+30000; return true;
    }
    if(g.stage==="bid"){
      g.bids=g.bids||{};
      if(expired)g.order.forEach(id=>{if(!Object.prototype.hasOwnProperty.call(g.bids,id))g.bids[id]=5;});
      if(!g.order.every(id=>Object.prototype.hasOwnProperty.call(g.bids,id)))return false;
      settle(g,now); return true;
    }
    if(g.stage==="reveal"){
      if(!expired && !g.order.every(id=>(g.ack||{})[id]))return false;
      if(g.turn===9){
        const best=Math.max(...g.order.map(id=>g.scores[id]));
        g.winner={ids:g.order.filter(id=>g.scores[id]===best),by:"points"};
        // 共用核心累積的是勝場；本局點數保留在 scores，避免將多局點數誤稱勝場。
        return true;
      }
      g.turn++; g.cone-=5; g.submitted={}; g.ack={}; g.bids={};
      g.stage=g.order.some(id=>needs(g,id).length)?"targets":"bid";
      g.deadline=now+(g.stage==="targets"?35000:30000); return true;
    }
    return false;
  }
  return {FLOORS,validFloor,travel,newGame,submit,progress,needs,copy};
})();
if(typeof module!=="undefined")module.exports=LF;

"use strict";

// 自行實作的數字預測遊戲。規則運算不依賴 DOM、網路或隨機數。
const LF = (() => {
  const FLOORS = [0,5,10,15,20,25,30,35,40];
  const validFloor = n => FLOORS.includes(n);
  const copy = x => JSON.parse(JSON.stringify(x));
  // 揭曉依座位逐張翻牌，全部翻完停一下才出發；人多時縮短間隔，八人也不超過 1.4 秒翻牌。
  const MOTION = Object.freeze({flip:250,gap:320,flipSpan:1400,hold:450,step:420,arrival:80,result:1800});
  const flipGap = n => Math.min(MOTION.gap, Math.round(MOTION.flipSpan/Math.max(1,n)));
  const flipAt = (i,n) => MOTION.flip + i*flipGap(n);
  const leadMs = n => flipAt(Math.max(0,n-1),n) + MOTION.hold;
  const revealMs = (path,n) => leadMs(n) + (path.length-1)*MOTION.step + MOTION.arrival + MOTION.result;
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
  // 已知點數 known 加上 unknown 位各出 0／5／10（均等假設）時，停靠各樓層的機率。只用公開位置，不讀任何人的牌。
  function outcomes(g, known, unknown){
    let totals={[known]:1};
    for(let i=0;i<unknown;i++){
      const next={};
      Object.entries(totals).forEach(([sum,w])=>[0,5,10].forEach(n=>{const k=+sum+n;next[k]=(next[k]||0)+w;}));
      totals=next;
    }
    const all=Math.pow(3,unknown), floors={};
    Object.entries(totals).forEach(([sum,w])=>{const f=travel(g.floor,g.direction,+sum).floor;floors[f]=(floors[f]||0)+w/all;});
    return floors;
  }
  // 這位參賽者此刻是否還欠一個動作（給倒數提示與電腦代送用）。
  function waiting(g,id){
    if(!g || g.winner || !g.order || !g.order.includes(id))return false;
    if(g.stage==="targets")return !!needs(g,id).length && !(g.submitted||{})[id];
    if(g.stage==="bid")return !Object.prototype.hasOwnProperty.call(g.bids||{},id);
    return false;
  }
  // 一局 9 或 18 回合。施工三角錐每回合往下 5 層，第 9 回合到 G；18 回合時第 10 回合留在 G，之後每回合往上爬回 40。
  const ROUNDS=[9,18];
  const totalRounds = g => g && g.rounds===18 ? 18 : 9;
  const coneAt = turn => turn<=9 ? 45-turn*5 : (turn-10)*5;
  function newGame(ids, now, rounds){
    const targets={}, replace={}, scores={};
    ids.forEach(id => { targets[id]=[10,20]; replace[id]=[0,1]; scores[id]=0; });
    return {order:ids.slice(), floor:0, direction:1, turn:1, cone:coneAt(1), rounds:rounds===18?18:9,
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
      gains,hits,blocked:g.floor===g.cone,revealedAt:now};
    // 出牌紀錄是公開資訊（揭曉後大家都看過），給玩家回頭讀每個人的出牌習慣。
    // Firebase 不存空陣列，讀回可能是 undefined，一律以 || [] 接。
    g.log=(g.log||[]).concat([{turn:g.turn,from,floor:g.floor,total,bids:copy(g.bids),gains:copy(gains),blocked:g.floor===g.cone}]);
    g.replace=replace; g.stage="reveal"; g.ack={}; g.deadline=now+revealMs(move.path,g.order.length);
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
      if(!expired)return false;
      if(g.turn>=totalRounds(g)){
        const best=Math.max(...g.order.map(id=>g.scores[id]));
        g.winner={ids:g.order.filter(id=>g.scores[id]===best),by:"points"};
        // 共用核心累積的是勝場；本局點數保留在 scores，避免將多局點數誤稱勝場。
        return true;
      }
      g.turn++; g.cone=coneAt(g.turn); g.submitted={}; g.ack={}; g.bids={};
      g.stage=g.order.some(id=>needs(g,id).length)?"targets":"bid";
      g.deadline=now+(g.stage==="targets"?35000:30000); return true;
    }
    return false;
  }
  return {FLOORS,ROUNDS,totalRounds,coneAt,validFloor,travel,newGame,submit,progress,needs,waiting,outcomes,copy,MOTION,flipAt,leadMs,revealMs};
})();
if(typeof module!=="undefined")module.exports=LF;

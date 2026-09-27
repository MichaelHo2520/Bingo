"use strict";
const LFB = (() => {
  let key="", animationKey="", selected=[10,20], card=5, timers=[], busyUntil=0;
  const label=f=>f===0?"G":String(f);
  function reset(){key="";animationKey="";busyUntil=0;timers.forEach(clearTimeout);timers=[];
    $("lfCar").classList.remove("lf-open","lf-travelling");$("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";}
  function tickets(values){
    $("lfTargets").innerHTML=values?values.map((f,slot)=>`<div class="lf-ticket"><div><small>SECRET DESTINATION ${slot+1}</small><span>${slot+1} 分目標${f===0||f===40?" · 雙倍":""}</span></div><b>${label(f)}<span>F</span></b><i aria-hidden="true"></i></div>`).join(""):"";
  }
  function render(g,id,name,submit,online){
    if(!g)return;
    const turnKey=[g.roundId||"solo",g.turn,g.stage,LF.needs(g,id).join(","),!!(g.submitted||{})[id],Object.prototype.hasOwnProperty.call(g.bids||{},id),!!(g.ack||{})[id]].join("/");
    $("lfRound").textContent=`第 ${g.turn} / 9 回合`;
    $("lfProgress").innerHTML=Array.from({length:9},(_,i)=>`<i class="${i<g.turn-1?"done":i===g.turn-1?"current":""}"></i>`).join("");
    $("lfPlay").dataset.stage=g.stage;
    if(g.stage!=="reveal"){$("lfCar").classList.remove("lf-open","lf-travelling");$("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";}
    if(!$("lfCar").classList.contains("lf-travelling"))$("lfDirection").textContent=g.direction===1?"↑ 下一段向上":"↓ 下一段向下";
    $("lfCone").textContent=`施工 ${label(g.cone)} 樓`;
    document.querySelectorAll(".lf-floor").forEach(el=>{
      const blocked=+el.dataset.floor===g.cone;
      el.classList.toggle("lf-blocked",blocked);
      el.setAttribute("aria-label",`${label(+el.dataset.floor)} 樓${blocked?"，三角錐施工障礙":""}`);
    });
    const scoresHTML=g.order.map(pid=>{
      let state="";
      if(g.stage==="targets")state=(!LF.needs(g,pid).length||(g.submitted||{})[pid])?"已準備":"選目標中";
      if(g.stage==="bid")state=Object.prototype.hasOwnProperty.call(g.bids||{},pid)?"已出牌":"選牌中";
      if(g.stage==="reveal")state=`出 ${g.last.bids[pid]} · +${g.last.gains[pid]}`;
      return `<div class="lf-player ${pid===id?"lf-you":""}"><i class="lf-avatar" aria-hidden="true">${esc(name(pid).slice(0,1))}</i><span>${esc(name(pid))}${pid===id?" · 你":""}</span><b>${g.scores[pid]}<em>分</em></b><small>${state}</small>${g.stage==="reveal"?`<strong class="lf-reveal-card" style="--lf-delay:${g.order.indexOf(pid)*65}ms">${g.last.bids[pid]}</strong>`:""}</div>`;
    }).join("");
    // 其他人確認揭曉時快照仍會更新；相同內容保留 DOM，避免翻牌動畫重播。
    if($("lfScores").innerHTML!==scoresHTML)$("lfScores").innerHTML=scoresHTML;
    const own=g.targets[id];
    tickets(turnKey===key && g.stage==="targets"?selected:own);
    const akey=(g.roundId||"solo")+"/"+(g.last?g.last.turn:0);
    if(akey!==animationKey){
      timers.forEach(clearTimeout);timers=[];animationKey=akey;
      const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
      const revealing=g.stage==="reveal"&&g.last;
      const path=revealing&&!reduced?g.last.path:[g.floor];
      const delay=revealing&&!reduced?650:0, step=420;
      const travelTime=(path.length-1)*step;
      busyUntil=revealing?Date.now()+delay+travelTime+650:0;
      $("lfCar").classList.remove("lf-open");
      $("lfCar").classList.toggle("lf-travelling",!!revealing&&path.length>1);
      $("lfCar").style.setProperty("--lf-step",step+"ms");
      $("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";
      path.forEach((floor,i)=>{
        const move=()=>{$("lfCar").style.bottom=(floor/40*88)+"%";$("lfCarFloor").textContent=label(floor);
          if(path.length>1){const direction=i?floor-path[i-1]:path[1]-floor;$("lfDirection").textContent=direction>0?"↑ 向上移動":"↓ 向下移動";}
          document.querySelectorAll(".lf-floor").forEach(el=>el.classList.toggle("lf-active",+el.dataset.floor===floor));};
        if(i===0)move();else timers.push(setTimeout(move,delay+(i-1)*step));
      });
      if(revealing)timers.push(setTimeout(()=>{
        const points=id?(g.last.gains[id]||0):0;
        $("lfCar").classList.remove("lf-travelling");$("lfCar").classList.add("lf-open");
        $("lfDirection").textContent=g.direction===1?"↑ 下一段向上":"↓ 下一段向下";
        $("lfArrival").innerHTML=`<small>${g.last.blocked?"UNDER CONSTRUCTION":"ARRIVAL"}</small><b>${label(g.floor)}<span>樓</span></b><em>${g.last.blocked?"施工中，這趟不計分":points?`命中！ +${points} 分`:"下一趟，再猜一次"}</em>`;
        $("lfArrival").classList.add("lf-pop");
        if(points&&!reduced)$("lfSparkles").innerHTML=Array.from({length:12},(_,i)=>`<i style="--lf-angle:${i*30}deg;--lf-distance:${60+(i%3)*20}px;--lf-spark-delay:${i%4*40}ms"></i>`).join("");
      },delay+travelTime+80));
    }
    const result=$("lfResult");
    if(g.last){
      const l=g.last;
      result.title=`${g.order.map(pid=>l.bids[pid]).join(" + ")} = ${l.total}`;
      result.textContent=`上一趟：${label(l.from)} → ${label(l.floor)} 樓 · 共 ${l.total} 層`+
        (l.blocked?" · 施工不計分":"")+
        (id&&l.gains[id]>0?` · 你 +${l.gains[id]} 分`:"");
    }else result.textContent="猜猜大家會讓電梯停在哪一樓？";
    if(turnKey===key)return;
    key=turnKey; selected=own?own.slice():[10,20]; card=5;
    const panel=$("lfControls");panel.innerHTML="";
    const hint=$("lfHint");
    if(g.winner){hint.textContent="本局結束，看看排行榜！";return;}
    if(!own){hint.textContent="觀戰中：目標與選牌在揭曉前保密。";return;}
    if(g.stage==="targets"){
      const slots=LF.needs(g,id);
      if(!slots.length || (g.submitted||{})[id]){hint.textContent="等其他玩家設定目標，你的目標保持不變。";return;}
      hint.textContent=g.turn===1?"秘密選兩個目標，可以選同一樓。":"命中的目標可以重選，未命中的繼續保留。";
      slots.forEach(slot=>{
        const row=document.createElement("div");row.className="lf-picker";
        row.innerHTML=`<span>${slot+1} 分目標</span>`;
        LF.FLOORS.forEach(f=>{
          const b=document.createElement("button");b.type="button";b.textContent=label(f);b.className="lf-floorbtn";
          b.setAttribute("aria-label",`${slot+1} 分目標 ${label(f)} 樓`);
          b.classList.toggle("on",selected[slot]===f);
          b.onclick=()=>{selected[slot]=f;tickets(selected);row.querySelectorAll("button").forEach(x=>{x.classList.toggle("on",x===b);x.setAttribute("aria-pressed",String(x===b));});};
          b.setAttribute("aria-pressed",String(selected[slot]===f));row.append(b);
        });panel.append(row);
      });
      const b=document.createElement("button");b.className="btn primary lf-submit";b.textContent="鎖定秘密目標";
      b.onclick=()=>submit(selected.slice(),g.turn);panel.append(b);
    }else if(g.stage==="bid"){
      if(Object.prototype.hasOwnProperty.call(g.bids||{},id)){hint.textContent="已鎖定你的牌，等大家一起揭曉。";return;}
      hint.textContent="選一張移動牌，所有人的數字會相加。";
      const row=document.createElement("div");row.className="lf-cards";
      [0,5,10].forEach(n=>{
        const b=document.createElement("button");b.className="lf-move"+(n===card?" on":"");b.innerHTML=`<span class="lf-card-corner">${n}</span><b>${n}</b><small>${n===0?"留點懸念":n===5?"剛剛好":"大步前進"}</small><span class="lf-card-mark">↕</span>`;
        b.setAttribute("aria-label",`移動 ${n} 層`);b.setAttribute("aria-pressed",String(n===card));
        b.onclick=()=>{card=n;row.querySelectorAll("button").forEach(x=>{x.classList.toggle("on",x===b);x.setAttribute("aria-pressed",String(x===b));});};row.append(b);
      });panel.append(row);
      const b=document.createElement("button");b.className="btn primary lf-submit";b.textContent="蓋牌，等大家揭曉";
      b.onclick=()=>submit(card,g.turn);panel.append(b);
    }else{
      hint.textContent=g.last.blocked?"施工中！命中施工樓層的人可以重設兩個目標。":"停靠成功！只有最後停靠的樓層算命中。";
      const b=document.createElement("button");b.className="btn primary lf-submit";
      b.textContent=g.turn===9?"查看本局排名":"我看好了，繼續";
      b.disabled=!!(g.ack||{})[id] || Date.now()<busyUntil;b.onclick=()=>submit(null,g.turn);panel.append(b);
      if(!(g.ack||{})[id] && Date.now()<busyUntil)timers.push(setTimeout(()=>{if(b.isConnected)b.disabled=false;},busyUntil-Date.now()));
    }
    $("lfClock").classList.toggle("hidden",!online);
  }
  function ranking(g,name){return g.order.slice().sort((a,b)=>g.scores[b]-g.scores[a]).map(id=>
    `<div class="lf-rank"><span>${esc(name(id))}</span><b>${g.scores[id]} 分</b></div>`).join("");}
  return {render,reset,ranking};
})();

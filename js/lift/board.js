"use strict";
const LFB = (() => {
  let key="", animationKey="", selected=[10,20], card=5, timers=[];
  const label=f=>f===0?"G":String(f);
  const taps=new WeakMap();
  let rosterObserver;
  function syncRoster(){
    const list=$("lfOpponents");
    $("lfRoster").classList.toggle("lf-more",list.scrollHeight-list.clientHeight-list.scrollTop>2);
  }
  function players(rows,id){
    const own=rows.find(row=>row.pid===id);
    const self=$("lfSelf"),list=$("lfOpponents");
    const ownHTML=own?own.html:"",otherHTML=rows.filter(row=>row.pid!==id).map(row=>row.html).join("");
    if(self.innerHTML!==ownHTML)self.innerHTML=ownHTML;
    if(list.innerHTML!==otherHTML){const top=list.scrollTop;list.innerHTML=otherHTML;list.scrollTop=top;}
    if(!rosterObserver){
      list.addEventListener("scroll",syncRoster,{passive:true});
      rosterObserver=new ResizeObserver(syncRoster);rosterObserver.observe(list);
    }
    requestAnimationFrame(syncRoster);
  }
  function feedback(button){
    if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;
    const previous=taps.get(button);if(previous)previous.cancel();
    taps.set(button,button.animate([{scale:"1",filter:"brightness(1)"},{scale:"1.08",filter:"brightness(1.3)",offset:.4},{scale:"1",filter:"brightness(1)"}],{duration:360,easing:"cubic-bezier(.2,.8,.2,1)"}));
    button.querySelectorAll(".lf-tap-wave").forEach(el=>el.remove());
    const wave=document.createElement("span");wave.className="lf-tap-wave";wave.setAttribute("aria-hidden","true");button.append(wave);
    wave.animate([{opacity:.8,transform:"scale(.82)"},{opacity:0,transform:"scale(1.25)"}],{duration:420,easing:"ease-out"}).onfinish=()=>wave.remove();
  }
  function reset(){key="";animationKey="";timers.forEach(clearTimeout);timers=[];
    $("lfCar").classList.remove("lf-open","lf-travelling");$("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";}
  function tickets(values){
    $("lfTargets").innerHTML=values?values.map((f,slot)=>`<div class="lf-ticket"><div><small>SECRET DESTINATION ${slot+1}</small><span>${slot+1} 分目標${f===0||f===40?" · 雙倍":""}</span></div><b>${label(f)}<span>F</span></b><i aria-hidden="true"></i></div>`).join(""):"";
  }
  function render(g,id,name,submit,online){
    if(!g)return;
    const turnKey=[g.roundId||"solo",g.turn,g.stage,LF.needs(g,id).join(","),!!(g.submitted||{})[id],Object.prototype.hasOwnProperty.call(g.bids||{},id)].join("/");
    $("lfRound").textContent=`第 ${g.turn} / 9 回合`;
    $("lfProgress").innerHTML=Array.from({length:9},(_,i)=>`<i class="${i<g.turn-1?"done":i===g.turn-1?"current":""}"></i>`).join("");
    $("lfPlay").dataset.stage=g.stage;
    if(g.stage!=="reveal"){$("lfCar").classList.remove("lf-open","lf-travelling");$("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";}
    if(!$("lfCar").classList.contains("lf-travelling"))$("lfDirection").textContent=g.direction===1?"↑ 下一段向上":"↓ 下一段向下";
    document.querySelectorAll(".lf-floor").forEach(el=>{
      const blocked=+el.dataset.floor===g.cone;
      el.classList.toggle("lf-blocked",blocked);
      el.setAttribute("aria-label",`${label(+el.dataset.floor)} 樓${blocked?"，三角錐施工障礙":""}`);
    });
    const scoreRows=g.order.map(pid=>{
      let state="";
      if(g.stage==="targets")state=(!LF.needs(g,pid).length||(g.submitted||{})[pid])?"已準備":"選目標中";
      if(g.stage==="bid")state=Object.prototype.hasOwnProperty.call(g.bids||{},pid)?"已出牌":"選牌中";
      if(g.stage==="reveal")state=`出 ${g.last.bids[pid]} · +${g.last.gains[pid]}`;
      const badge=g.stage==="reveal"?`<strong class="lf-reveal-card" style="--lf-delay:${g.order.indexOf(pid)*65}ms"><span>${g.last.bids[pid]}</span></strong>`:`<i class="lf-avatar" aria-hidden="true">${esc(name(pid).slice(0,1))}</i>`;
      return {pid,html:`<div class="lf-player ${pid===id?"lf-you":""}">${badge}<span>${esc(name(pid))}${pid===id&&name(pid)!=="你"?" · 你":""}</span><b>${g.scores[pid]}<em>分</em></b><small>${state}</small></div>`};
    });
    // 其他人確認揭曉時快照仍會更新；相同內容保留 DOM，避免翻牌動畫重播。
    players(scoreRows,id);
    const own=g.targets[id];
    tickets(turnKey===key && g.stage==="targets"?selected:own);
    const akey=(g.roundId||"solo")+"/"+(g.last?g.last.turn:0);
    if(akey!==animationKey){
      timers.forEach(clearTimeout);timers=[];animationKey=akey;
      const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
      const revealing=g.stage==="reveal"&&g.last;
      const path=revealing&&!reduced?g.last.path:[g.floor];
      const delay=revealing&&!reduced?LF.MOTION.lead:0, step=LF.MOTION.step;
      const travelTime=(path.length-1)*step;
      const elapsed=revealing&&g.last.revealedAt?Math.max(0,(online?lfNow():Date.now())-g.last.revealedAt):0;
      $("lfCar").classList.remove("lf-open");
      $("lfCar").classList.toggle("lf-travelling",!!revealing&&path.length>1);
      $("lfCar").style.setProperty("--lf-step",step+"ms");
      $("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";
      const catchUp=elapsed>=delay&&elapsed>0&&!reduced;
      if(catchUp)$("lfCar").style.transition="none";
      path.forEach((floor,i)=>{
        const move=()=>{$("lfCar").style.setProperty("--lf-step",Math.min(step,Math.max(1,delay+i*step-elapsed))+"ms");$("lfCar").style.bottom=(floor/5*100/9)+"%";$("lfCarFloor").textContent=label(floor);
          if(path.length>1){const direction=i?floor-path[i-1]:path[1]-floor;$("lfDirection").textContent=direction>0?"↑ 向上移動":"↓ 向下移動";}
          document.querySelectorAll(".lf-floor").forEach(el=>el.classList.toggle("lf-active",+el.dataset.floor===floor));};
        if(i===0 || delay+i*step<=elapsed)move();
        else timers.push(setTimeout(move,Math.max(0,delay+(i-1)*step-elapsed)));
      });
      if(catchUp){void $("lfCar").offsetHeight;$("lfCar").style.transition="";}
      if(revealing)timers.push(setTimeout(()=>{
        const points=id?(g.last.gains[id]||0):0;
        $("lfCar").classList.remove("lf-travelling");$("lfCar").classList.add("lf-open");
        $("lfDirection").textContent=g.direction===1?"↑ 下一段向上":"↓ 下一段向下";
        $("lfArrival").dataset.outcome=g.last.blocked?"blocked":points?"hit":"miss";
        const mark=g.last.blocked?document.querySelector(".lf-cone-art").outerHTML:points?"✦":"↓";
        $("lfArrival").innerHTML=`<div class="lf-arrival-head"><i aria-hidden="true">${mark}</i><small>${g.last.blocked?"施工樓層":"電梯已到站"}</small></div><div class="lf-arrival-main"><b>${label(g.floor)}<span>樓</span></b><strong>${g.last.blocked?"暫停計分":points?`+${points}<span>分</span>`:id?"未命中":"本輪揭曉"}</strong></div><em>${g.last.blocked?"施工中，這趟不計分":points?"你的目標命中了！":"看看下一趟會停在哪裡"}</em><div class="lf-arrival-line" aria-hidden="true"></div>`;
        $("lfArrival").classList.add("lf-pop");
        $("lfArrival").style.setProperty("--lf-result-ms",Math.max(1,g.deadline-(online?lfNow():Date.now()))+"ms");
        if(own)$("lfHint").textContent=g.last.blocked?"施工中，這趟不計分；命中者下一輪可重設目標。":"停靠成功，只有最後停靠的樓層算命中。";
        if(points&&!reduced)$("lfSparkles").innerHTML=Array.from({length:12},(_,i)=>`<i style="--lf-angle:${i*30}deg;--lf-distance:${60+(i%3)*20}px;--lf-spark-delay:${i%4*40}ms"></i>`).join("");
      },Math.max(0,delay+travelTime+LF.MOTION.arrival-elapsed)));
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
    if(!matchMedia("(prefers-reduced-motion: reduce)").matches)panel.animate([{opacity:.45,transform:"translateY(4px)"},{opacity:1,transform:"translateY(0)"}],{duration:240,easing:"ease-out"});
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
      hint.textContent="看看大家出了什麼牌，停靠後自動接續。";
      const note=document.createElement("div");note.className="lf-next-note";note.setAttribute("role","status");
      note.textContent=g.turn===9?"到站後自動結算本局":"到站後自動進入第 "+(g.turn+1)+" 回合";panel.append(note);
    }
    $("lfClock").classList.toggle("hidden",!online);
  }
  function ranking(g,name,me){
    let rank=0,previous;
    const ids=g.order.slice().sort((a,b)=>g.scores[b]-g.scores[a]);
    return '<div class="lf-score-caption">本局得分</div>'+ids.map((id,i)=>{
      const score=g.scores[id];if(score!==previous)rank=i+1;previous=score;
      return `<div class="lf-rank${score===g.scores[ids[0]]?" lf-rank-lead":""}${id===me?" lf-rank-you":""}"><span class="lf-rank-place">${rank}.</span><span class="lf-rank-name">${esc(name(id))}${id===me&&name(id)!=="你"?" · 你":""}</span><b>${score} 分</b></div>`;
    }).join("");
  }
  return {render,reset,ranking,feedback};
})();

"use strict";
const LFB = (() => {
  let key="", animationKey="", landedKey="", selected=[10,20], card=5, timers=[], enterElapsed=0, sendTimer=null, logOpen=false, current=null;
  const label=f=>f===0?"G":String(f);
  const arrivalKey=g=>(g.roundId||"solo")+"/"+(g.last?g.last.turn:0);
  // 第一個字：用 Array.from 才不會把 emoji 暱稱切成半個字元。
  const initial=s=>Array.from(String(s||""))[0]||"";
  const shortName=s=>Array.from(String(s||"")).slice(0,4).join("");
  const landed=g=>g.stage!=="reveal"||landedKey===arrivalKey(g);
  function visibleScore(g,id){
    return g.scores[id]-(g.stage==="reveal"&&landedKey!==arrivalKey(g)?g.last.gains[id]||0:0);
  }
  /* 音效全部走共用 Sound（吃設定裡的靜音與音量），震動吃共用的震動開關。 */
  const vibrate=pattern=>{if(typeof vibrateOn!=="undefined"&&vibrateOn&&navigator.vibrate){try{navigator.vibrate(pattern);}catch(e){}}};
  const sfx={
    pick(){Sound.tone(880,{type:"sine",dur:.05,vol:.1});},
    lock(){Sound.mark();},
    flip(i){Sound.tone(440+i*55,{type:"triangle",dur:.09,vol:.14,slideTo:620+i*55});},
    step(){Sound.tone(1250,{type:"sine",dur:.045,vol:.05});},
    bounce(){Sound.tone(262,{type:"triangle",dur:.16,vol:.16,slideTo:196});},
    chime(){Sound.tone(1319,{type:"sine",dur:.32,vol:.18});Sound.tone(1047,{type:"sine",dur:.5,vol:.16,delay:.24});},
    hit(){Sound.line();vibrate([25,40,25]);},
    others(){Sound.tone(784,{type:"triangle",dur:.16,vol:.12});Sound.tone(988,{type:"triangle",dur:.2,vol:.1,delay:.1});},
    blocked(){Sound.tone(196,{type:"square",dur:.18,vol:.06});Sound.tone(165,{type:"square",dur:.26,vol:.06,delay:.2});},
    tick(){Sound.tone(1000,{type:"square",dur:.035,vol:.05});}
  };
  // 方向只有一個來源：頂列燈號、井道流動箭頭與車廂上的箭頭都讀這裡設的 data-dir。
  function direction(up,text,moving){
    [$("lfDir"),$("lfStage")].forEach(el=>{el.dataset.dir=up?"up":"down";el.classList.toggle("lf-moving",!!moving);});
    $("lfDirection").textContent=text;
  }
  // 操作區各階段高度不同（兩排目標鈕 > 三張移動牌 > 揭曉說明），大樓是吃剩下的空間，
  // 會跟著被擠高擠矮。記住這個版面寬度出現過的最高值當下限；寬度或橫放版面一變就重量。
  let actionMax=0,actionKey="",actionObserver;
  function holdAction(){
    const box=$("lfControls").parentElement;
    if(!actionObserver){
      actionObserver=new ResizeObserver(holdAction);actionObserver.observe($("lfControls"));actionObserver.observe($("lfHint"));
      addEventListener("resize",holdAction);
    }
    const k=innerWidth+"/"+matchMedia("(max-height:480px) and (min-width:600px)").matches;
    if(k!==actionKey){actionKey=k;actionMax=0;}
    box.style.minHeight="";
    const h=box.getBoundingClientRect().height;
    if(h>actionMax)actionMax=h;
    if(actionMax)box.style.minHeight=actionMax+"px";
  }
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
  function reset(){key="";animationKey="";landedKey="";enterElapsed=0;logOpen=false;current=null;timers.forEach(clearTimeout);timers=[];clearTimeout(sendTimer);sendTimer=null;
    $("lfCar").classList.remove("lf-open","lf-travelling");$("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";
    $("lfLog").classList.add("hidden");$("lfLogBtn").setAttribute("aria-expanded","false");reach(null);}
  function tickets(values){
    $("lfTargets").innerHTML=values?values.map((f,slot)=>`<div class="lf-ticket"><div><small>SECRET DESTINATION ${slot+1}</small><span>${slot+1} 分目標${f===0||f===40?" · 雙倍":""}</span></div><b>${label(f)}<span>F</span></b><i aria-hidden="true"></i></div>`).join(""):"";
  }
  // 選牌時把「這張牌可能停靠的樓層」按機率亮在樓層列上；只用公開位置、方向與人數。
  function reach(odds){
    const max=odds?Math.max(0,...Object.values(odds)):0;
    document.querySelectorAll(".lf-floor").forEach(el=>{
      const p=odds?odds[+el.dataset.floor]||0:0;
      el.classList.toggle("lf-reach",p>0);
      el.style.setProperty("--lf-reach",p>0?(.1+.34*p/max).toFixed(2):"0");
      el.dataset.odds=p>0?Math.max(1,Math.round(p*100))+"%":"";
    });
  }
  function paintReach(g,id){
    const on=!!id&&g.stage==="bid"&&LF.waiting(g,id);
    reach(on?LF.outcomes(g,card,g.order.length-1):null);
  }
  /* 出牌紀錄：回合 × 玩家的出牌矩陣。揭曉途中最後一筆還沒公布，先不列，避免劇透停靠樓層。 */
  function paintLog(){
    if(!current)return;
    const {g,id,name}=current, btn=$("lfLogBtn"), box=$("lfLog");
    const all=Array.isArray(g.log)?g.log:Object.values(g.log||{});
    const shown=landed(g)?all:all.slice(0,-1);
    if(!shown.length||!landed(g))logOpen=false;
    btn.disabled=!shown.length;
    btn.setAttribute("aria-expanded",String(logOpen));
    box.classList.toggle("hidden",!logOpen);
    if(!logOpen)return;
    const ids=g.order.includes(id)?[id,...g.order.filter(p=>p!==id)]:g.order.slice();
    const cells=(fn)=>shown.map(fn).join("");
    const html=`<div class="lf-log-head"><b>出牌紀錄</b><span>點一下關閉</span></div><div class="lf-log-scroll"><table class="lf-log-table"><thead><tr><th scope="col">回合</th>${cells(e=>`<th scope="col">${e.turn}</th>`)}</tr></thead><tbody>`+
      `<tr class="lf-log-floor"><th scope="row">停靠</th>${cells(e=>`<td class="${e.blocked?"lf-log-blocked":""}">${label(e.floor)}</td>`)}</tr>`+
      ids.map(pid=>`<tr class="${pid===id?"lf-log-you":""}"><th scope="row">${esc(shortName(name(pid)))}</th>${cells(e=>{
        const bid=(e.bids||{})[pid], gain=(e.gains||{})[pid]||0;
        return `<td class="${gain>0?"lf-log-hit":""}">${bid===undefined?"–":bid}${gain>0?`<sup>+${gain}</sup>`:""}</td>`;
      })}</tr>`).join("")+`</tbody></table></div>`;
    if(box.innerHTML!==html)box.innerHTML=html;
  }
  function toggleLog(open){
    logOpen=open===undefined?!logOpen:!!open;
    paintLog();
  }
  // 按下確認後、快照回來前先鎖住操作並顯示送出中；交易被拒時 5 秒後解鎖，讓玩家可以重送。
  function lock(button){
    const panel=$("lfControls"), lockedKey=key, text=button.textContent;
    panel.classList.add("lf-sending");panel.querySelectorAll("button").forEach(b=>{b.disabled=true;});
    button.textContent="送出中…";sfx.lock();
    clearTimeout(sendTimer);
    sendTimer=setTimeout(()=>{
      sendTimer=null;if(key!==lockedKey)return;
      panel.classList.remove("lf-sending");panel.querySelectorAll("button").forEach(b=>{b.disabled=false;});button.textContent=text;
    },5000);
  }
  function render(g,id,name,submit,online,onArrival){
    if(!g)return;
    current={g,id,name};
    const turnKey=[g.roundId||"solo",g.turn,g.stage,LF.needs(g,id).join(","),!!(g.submitted||{})[id],Object.prototype.hasOwnProperty.call(g.bids||{},id)].join("/");
    const rounds=LF.totalRounds(g);
    $("lfRound").textContent=`第 ${g.turn} / ${rounds} 回合`;
    $("lfProgress").classList.toggle("lf-progress-long",rounds>9);
    $("lfProgress").innerHTML=Array.from({length:rounds},(_,i)=>`<i class="${i<g.turn-1?"done":i===g.turn-1?"current":""}"></i>`).join("");
    $("lfPlay").dataset.stage=g.stage;
    // 揭曉中的秒數只是自動接續的等待時間，不是玩家要做事，所以不顯示。
    $("lfClock").classList.toggle("hidden",!online||g.stage==="reveal"||!!g.winner);
    if(g.stage!=="reveal"){$("lfCar").classList.remove("lf-open","lf-travelling");$("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";}
    if(!$("lfCar").classList.contains("lf-travelling"))direction(g.direction===1,g.direction===1?"下一段向上":"下一段向下");
    document.querySelectorAll(".lf-floor").forEach(el=>{
      const blocked=+el.dataset.floor===g.cone;
      el.classList.toggle("lf-blocked",blocked);
      el.setAttribute("aria-label",`${label(+el.dataset.floor)} 樓${blocked?"，三角錐施工障礙":""}`);
    });
    const akey=arrivalKey(g), fresh=akey!==animationKey;
    const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
    const revealing=g.stage==="reveal"&&g.last;
    // 進場時已經過了多久：同一趟只算一次，翻牌的延遲才會固定，相同快照不會換掉翻牌 DOM。
    if(fresh)enterElapsed=revealing&&g.last.revealedAt?Math.max(0,(online?lfNow():Date.now())-g.last.revealedAt):0;
    const n=g.order.length;
    // 翻牌順序照畫面由上而下：自己的列在最上面，其他人依座位。
    const seq=g.order.includes(id)?[id,...g.order.filter(p=>p!==id)]:g.order.slice();
    function paintScores(){
      const announced=landed(g);
      const scoreRows=g.order.map(pid=>{
        let state="";
        if(g.stage==="targets")state=(!LF.needs(g,pid).length||(g.submitted||{})[pid])?"已準備":"選目標中";
        if(g.stage==="bid")state=Object.prototype.hasOwnProperty.call(g.bids||{},pid)?"已出牌":"選牌中";
        // 翻牌前不在文字寫出牌面，否則逐張翻牌就沒有懸念。
        if(g.stage==="reveal")state=announced?`出 ${g.last.bids[pid]} · +${g.last.gains[pid]} 分`:"等待到站";
        const delay=Math.round(LF.flipAt(seq.indexOf(pid),n)-enterElapsed);
        const badge=g.stage==="reveal"?`<strong class="lf-reveal-card${announced?" lf-landed":""}" style="--lf-delay:${delay}ms"><span>${g.last.bids[pid]}</span></strong>`:`<i class="lf-avatar" aria-hidden="true">${esc(initial(name(pid)))}</i>`;
        const gained=g.stage==="reveal"&&announced&&g.last.gains[pid]>0;
        const score=visibleScore(g,pid);
        return {pid,html:`<div class="lf-player ${pid===id?"lf-you":""}${gained?" lf-scored":""}">${badge}<span>${esc(name(pid))}${pid===id&&name(pid)!=="你"?" · 你":""}</span><b>${score}<em>分</em></b><small>${state}</small></div>`};
      });
      // 相同內容保留 DOM，避免翻牌重播；分數與加分等到站才公布。
      players(scoreRows,id);
    }
    paintScores();
    const own=g.targets[id];
    tickets(turnKey===key && g.stage==="targets"?selected:own);
    if(fresh){
      timers.forEach(clearTimeout);timers=[];animationKey=akey;
      const path=revealing&&!reduced?g.last.path:[g.floor];
      const delay=revealing&&!reduced?LF.leadMs(n):0, step=LF.MOTION.step;
      const travelTime=(path.length-1)*step;
      const elapsed=enterElapsed;
      $("lfCar").classList.remove("lf-open");
      $("lfCar").classList.toggle("lf-travelling",!!revealing&&path.length>1);
      $("lfCar").style.setProperty("--lf-step",step+"ms");
      $("lfArrival").classList.remove("lf-pop");$("lfSparkles").innerHTML="";
      if(revealing){
        // 下方那行逐張累加點數；到站前不寫目的樓層。
        const bids=seq.map(pid=>g.last.bids[pid]);
        const tally=k=>{$("lfResult").textContent=k<bids.length?`翻牌：${k?bids.slice(0,k).join(" + ")+" + …":"…"}`:
          `${bids.join(" + ")} = ${g.last.total} 層${g.last.total?"，出發！":"，原地不動"}`;};
        let shownCards=0;
        bids.forEach((_,i)=>{const at=reduced?0:LF.flipAt(i,n);if(at<=elapsed)shownCards=i+1;
          else timers.push(setTimeout(()=>{tally(i+1);sfx.flip(i);},at-elapsed));});
        tally(shownCards);
      }
      const catchUp=elapsed>=delay&&elapsed>0&&!reduced;
      if(catchUp)$("lfCar").style.transition="none";
      path.forEach((floor,i)=>{
        const move=sound=>{$("lfCar").style.setProperty("--lf-step",Math.min(step,Math.max(1,delay+i*step-elapsed))+"ms");$("lfCar").style.bottom=(floor/5*100/9)+"%";$("lfCarFloor").textContent=label(floor);
          if(path.length>1){const up=(i?floor-path[i-1]:path[1]-floor)>0;direction(up,i?(up?"向上移動":"向下移動"):(up?"翻牌中 · 將向上":"翻牌中 · 將向下"),i>0);}
          document.querySelectorAll(".lf-floor").forEach(el=>el.classList.toggle("lf-active",+el.dataset.floor===floor));
          // 每段移動一聲輕響，撞到 G／40 折返是低一點的一聲；最後一段交給到站的叮咚。
          if(sound&&i>0&&i<path.length-1)(floor===0||floor===40?sfx.bounce:sfx.step)();};
        if(i===0 || delay+i*step<=elapsed)move(false);
        else timers.push(setTimeout(()=>move(true),Math.max(0,delay+(i-1)*step-elapsed)));
      });
      if(catchUp){void $("lfCar").offsetHeight;$("lfCar").style.transition="";}
      const arriveAt=delay+travelTime+LF.MOTION.arrival;
      // 晚到／重新載入時到站早已過去，就只補畫面，不補放音效。
      const audible=elapsed-arriveAt<400;
      if(revealing)timers.push(setTimeout(()=>{
        const points=id?(g.last.gains[id]||0):0;
        landedKey=akey;paintScores();paintResult();paintLog();if(onArrival)onArrival();
        const scorers=g.order.filter(pid=>g.last.gains[pid]>0).sort((a,b)=>g.last.gains[b]-g.last.gains[a]);
        if(audible){
          sfx.chime();
          timers.push(setTimeout(()=>(g.last.blocked?sfx.blocked:points?sfx.hit:scorers.length?sfx.others:()=>{})(),380));
        }
        $("lfCar").classList.remove("lf-travelling");$("lfCar").classList.add("lf-open");
        direction(g.direction===1,g.direction===1?"下一段向上":"下一段向下");
        $("lfArrival").dataset.outcome=g.last.blocked?"blocked":scorers.length?"hit":"miss";
        const mark=g.last.blocked?document.querySelector(".lf-cone-art").outerHTML:scorers.length?"✦":"○";
        const awards=scorers.length?`<div class="lf-award-title">本趟得分</div><div class="lf-awards">${scorers.map(pid=>`<div class="lf-award${pid===id?" lf-award-you":""}"><span class="lf-award-name">${esc(name(pid))}${pid===id&&name(pid)!=="你"?" · 你":""}</span><span class="lf-award-points">+${g.last.gains[pid]} 分</span></div>`).join("")}</div>`:"";
        $("lfArrival").innerHTML=`<div class="lf-arrival-head"><i aria-hidden="true">${mark}</i><small>${g.last.blocked?"施工樓層":"電梯已到站"}</small></div><div class="lf-arrival-main"><b>${label(g.floor)}<span>樓</span></b><strong>${g.last.blocked?"暫停計分":points?`+${points}<span>分</span>`:scorers.length?`${scorers.length} 人得分`:"無人得分"}</strong></div>${awards}<em>${g.last.blocked?"施工中，這趟不計分":scorers.length?points?"你的目標命中了！":"恭喜命中的玩家！":"差一點！下一趟再試試"}</em><div class="lf-arrival-line" aria-hidden="true"></div>`;
        $("lfArrival").classList.add("lf-pop");
        $("lfArrival").style.setProperty("--lf-result-ms",Math.max(1,g.deadline-(online?lfNow():Date.now()))+"ms");
        if(own)$("lfHint").textContent=g.last.blocked?"施工中，這趟不計分；命中者下一輪可重設目標。":"停靠成功，只有最後停靠的樓層算命中。";
        if(scorers.length&&!reduced)$("lfSparkles").innerHTML=Array.from({length:12},(_,i)=>`<i style="--lf-angle:${i*30}deg;--lf-distance:${60+(i%3)*20}px;--lf-spark-delay:${i%4*40}ms"></i>`).join("");
      },Math.max(0,arriveAt-elapsed)));
    }
    function paintResult(){
      const result=$("lfResult");
      // 揭曉途中這一行由逐張累加接手，到站才換回整趟摘要。
      if(!landed(g))return;
      if(g.last){
        const l=g.last;
        result.title=`${g.order.map(pid=>l.bids[pid]).join(" + ")} = ${l.total}`;
        result.textContent=`上一趟：${label(l.from)} → ${label(l.floor)} 樓 · 共 ${l.total} 層`+
          (l.blocked?" · 施工不計分":"")+
          (id&&l.gains[id]>0?` · 你 +${l.gains[id]} 分`:"");
      }else result.textContent="猜猜大家會讓電梯停在哪一樓？";
    }
    paintResult();
    paintLog();
    requestAnimationFrame(holdAction);
    if(turnKey===key){paintReach(g,id);return;}
    key=turnKey; selected=own?own.slice():[10,20]; card=5;
    clearTimeout(sendTimer);sendTimer=null;
    const panel=$("lfControls");panel.innerHTML="";panel.classList.remove("lf-sending");
    paintReach(g,id);
    if(!reduced)panel.animate([{opacity:.45,transform:"translateY(4px)"},{opacity:1,transform:"translateY(0)"}],{duration:240,easing:"ease-out"});
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
          const b=document.createElement("button");b.type="button";b.className="lf-floorbtn"+(f===g.cone?" lf-floorbtn-cone":"");
          // 直接在按鈕上標出雙倍與這回合的施工層，不必再對照左邊的樓層列。
          b.innerHTML=`${label(f)}${f===0||f===40?'<small>×2</small>':""}`;
          b.setAttribute("aria-label",`${slot+1} 分目標 ${label(f)} 樓${f===0||f===40?"，雙倍":""}${f===g.cone?"，這回合施工不計分":""}`);
          b.classList.toggle("on",selected[slot]===f);
          b.onclick=()=>{selected[slot]=f;tickets(selected);sfx.pick();row.querySelectorAll("button").forEach(x=>{x.classList.toggle("on",x===b);x.setAttribute("aria-pressed",String(x===b));});};
          b.setAttribute("aria-pressed",String(selected[slot]===f));row.append(b);
        });panel.append(row);
      });
      const b=document.createElement("button");b.className="btn primary lf-submit";b.textContent="鎖定秘密目標";
      b.onclick=()=>{lock(b);submit(selected.slice(),g.turn);};panel.append(b);
    }else if(g.stage==="bid"){
      if(Object.prototype.hasOwnProperty.call(g.bids||{},id)){hint.textContent="已鎖定你的牌，等大家一起揭曉。";return;}
      hint.textContent="選一張移動牌，大家的數字相加；亮起的樓層是可能停靠處。";
      const row=document.createElement("div");row.className="lf-cards";
      [0,5,10].forEach(n=>{
        const b=document.createElement("button");b.className="lf-move"+(n===card?" on":"");b.innerHTML=`<span class="lf-card-corner">${n}</span><b>${n}</b><small>${n===0?"留點懸念":n===5?"剛剛好":"大步前進"}</small><span class="lf-card-mark">↕</span>`;
        b.setAttribute("aria-label",`移動 ${n} 層`);b.setAttribute("aria-pressed",String(n===card));
        b.onclick=()=>{card=n;sfx.pick();paintReach(g,id);row.querySelectorAll("button").forEach(x=>{x.classList.toggle("on",x===b);x.setAttribute("aria-pressed",String(x===b));});};row.append(b);
      });panel.append(row);
      const b=document.createElement("button");b.className="btn primary lf-submit";b.textContent="蓋牌，等大家揭曉";
      b.onclick=()=>{lock(b);submit(card,g.turn);};panel.append(b);
    }else{
      hint.textContent="看看大家出了什麼牌，停靠後自動接續。";
      const note=document.createElement("div");note.className="lf-next-note";note.setAttribute("role","status");
      note.textContent=g.turn>=rounds?"到站後自動結算本局":"到站後自動進入第 "+(g.turn+1)+" 回合";panel.append(note);
    }
  }
  function ranking(g,name,me){
    let rank=0,previous;
    const ids=g.order.slice().sort((a,b)=>g.scores[b]-g.scores[a]);
    return '<div class="lf-score-caption">本局得分</div>'+ids.map((id,i)=>{
      const score=g.scores[id];if(score!==previous)rank=i+1;previous=score;
      return `<div class="lf-rank${score===g.scores[ids[0]]?" lf-rank-lead":""}${id===me?" lf-rank-you":""}"><span class="lf-rank-place">${rank}.</span><span class="lf-rank-name">${esc(name(id))}${id===me&&name(id)!=="你"?" · 你":""}</span><b>${score} 分</b></div>`;
    }).join("");
  }
  return {render,reset,ranking,feedback,visibleScore,toggleLog,tick:()=>sfx.tick()};
})();

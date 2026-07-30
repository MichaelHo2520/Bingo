"use strict";

/* ============================================================================
   台灣 16 張麻將 — 連線適配器(接上 js/shared/mp-core.js)。

   ── 這一支只做三件事 ──────────────────────────────────────────────────────
     ① 把 MJT(table.js)的一局狀態**整包**塞進 game 節點,再讀回來畫
     ② 把每一個動作包成 txGame 交易(交易內再驗一次,擋兩人同時動作)
     ③ 相互算台的收付寫進 tai 節點

   ── ★ 一個 MP round = 一「局」 ────────────────────────────────────────────
     刻意這樣對映,核心那套(roundId 冪等 / 繼續下一局 / 斷線重建)就原封不動能用。
     「打幾局」= 房間設定 handsGoal,打滿了結果卡就換成總結算 + 開新賽季。

   ── ★ 宣告裁決不指定房主 ──────────────────────────────────────────────────
     手牌明碼 → 每台裝置都能用純函式算出「誰有資格宣告什麼」,所以誰都可以結算,
     用交易搶(同消消樂全房重洗的理由:指定房主的話,房主一斷線整局卡死)。
     視窗到期也是誰的 timer 先響誰補「過」—— 不會因為某個人切到 LINE 就卡住。

   ── ★ 寫 winner 的交易一定要 { local:false } ─────────────────────────────
     踩坑清單 #8:交易會先在本地樂觀套用,搶輸的那台會先看到「我贏」→ 放彩帶、
     往 scores 寫 +1,真值回來才改判。麻將的「兩家同時喊胡」會直接踩到。
   ========================================================================== */

const MP = MPCore.create((function(){

  const COLORS = ["p0","p1","p2","p3"];
  const CLAIM_MS = 7000;            // 宣告視窗:7 秒沒表態就當「過」

  let ctx = null;
  let handsGoal = 4;                // 打幾局(房間設定)
  let st = null;                    // 目前這一局的 MJT state(解碼後)
  let curRound = null;
  let tai = {};                     // tai 節點快照
  let claimT = null;                // 宣告視窗的計時器
  let myBid = false;                // 這一輪我表態過了沒(只擋自己重複點)

  function seatOf(id){ return ctx.order().indexOf(id); }
  function mySeat(){ return seatOf(ctx.me()); }
  function colorOf(s){ return COLORS[s] || "p0"; }
  function idOfSeat(s){ return ctx.order()[s] || ""; }
  function nameOfSeat(s){ const id = idOfSeat(s); return id ? ctx.dispName(id) : ("座位 "+(s+1)); }
  const gid = t => MJ16.codeOf(t);
  const face = t => MJFace.info(gid(t));

  /* ---------- 台數累計:相互算台,總和恆為 0 ----------
     ★ 用「整個 tai 節點一筆交易」而不是各寫各的:
       ①任何一台都算得出同一份收付表(狀態明碼)→ 誰先到誰寫
       ②_r[roundId] 當冪等記號 → 晚到的交易看到就中止,不會重複記
       ⚠ 各寫各的會在有人斷線時湊不齊,零和不變量就破了。 */
  function commitTai(roundId, deltas){
    const r = ctx.ref("tai"); if(!r || !roundId) return;
    r.transaction(cur=>{
      cur = cur || {};
      if(cur._r && cur._r[roundId]) return;           // 這一局已經記過了
      const ord = ctx.order();
      deltas.forEach((d,s)=>{
        const id = ord[s]; if(!id) return;
        cur[id] = (cur[id]||0) + d;
      });
      cur._r = cur._r || {};
      cur._r[roundId] = 1;
      return cur;
    });
  }
  function taiOf(id){ return (typeof tai[id]==="number") ? tai[id] : 0; }
  function handsDone(){ return tai._r ? Object.keys(tai._r).length : 0; }

  /* ---------- 比分列 ---------- */
  function renderHud(){
    const box = $("m16Hud"); if(!box) return;
    if(ctx.phase()!=="playing" && !ctx.winner()){ box.classList.add("hidden"); box.innerHTML=""; return; }
    box.classList.remove("hidden");
    const ord = ctx.order(), me = ctx.me();
    box.innerHTML = ord.map((id,s)=>{
      const t = taiOf(id);
      const wind = st ? MJFace.info(MJ16.codeOf(MJT.seatWind(s, st.dealer, st.seats))).glyph : "";
      const turnNow = st && !st.over && st.turn===s;
      return '<div class="m16-hcard '+colorOf(s)+(id===me?" me":"")+(turnNow?" on":"")+
             '" data-id="'+id+'" title="點一下傳送互動表情">'+
             '<span class="m16-hw">'+wind+'</span>'+
             '<span class="m16-hname">'+esc(ctx.dispName(id))+(id===me?' <b>你</b>':'')+'</span>'+
             '<span class="m16-htai'+(t<0?" neg":"")+'">'+(t>0?"+":"")+t+'<em>台</em></span>'+
             '</div>';
    }).join("");
  }

  /* ---------- 動作列 ---------- */
  function actBtn(label, cls, fn){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "m16-act"+(cls?" "+cls:"");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }
  function renderActs(){
    const box = $("m16Acts"); if(!box) return;
    box.innerHTML = "";
    if(!st || st.over || ctx.phase()!=="playing"){ box.classList.add("hidden"); return; }
    const me = mySeat();
    if(me<0){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");

    /* --- 宣告視窗 --- */
    if(st.claim){
      const types = st.claim.elig[me];
      if(!types || st.claim.bids[me] || myBid){
        const tag = document.createElement("span");
        tag.className = "m16-timer";
        tag.textContent = types ? "已表態,等其他人…" : "等別人決定要不要吃碰…";
        box.appendChild(tag);
        return;
      }
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      tag.textContent = "「"+face(st.claim.t).name+"」";
      box.appendChild(tag);
      types.forEach(t=>{
        if(t==="chow"){
          const cl = MJ16.claimsFor(MJ16.toCounts(st.hands[me]), st.claim.t,
                     { need:MJT.needOf(st,me), chow:true, fromLeft:true });
          cl.chow.forEach(pair=>{
            box.appendChild(actBtn("吃 "+face(pair[0]).name+face(pair[1]).name, "",
              ()=>sendBid("chow", pair)));
          });
        }else{
          const lbl = { win:"胡!", kong:"槓", pong:"碰" }[t] || t;
          box.appendChild(actBtn(lbl, t==="win"?"win":"", ()=>sendBid(t, null)));
        }
      });
      box.appendChild(actBtn("過", "pass", ()=>sendBid("pass", null)));
      return;
    }

    /* --- 自己的回合 --- */
    if(st.turn!==me){
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      tag.textContent = "輪到 "+esc(nameOfSeat(st.turn))+"…";
      box.appendChild(tag);
      return;
    }
    const a = MJT.ownActions(st, me);
    if(a.win) box.appendChild(actBtn("自摸!", "win", ()=>doAct(s=>MJT.selfDrawWin(s, me))));
    a.ckong.forEach(t=>box.appendChild(actBtn("暗槓 "+face(t).name, "",
      ()=>doAct(s=>MJT.concealedKong(s, me, t)))));
    a.akong.forEach(t=>box.appendChild(actBtn("加槓 "+face(t).name, "",
      ()=>doAct(s=>MJT.addKong(s, me, t)))));
    if(a.discard && !box.children.length){
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      // 一段式 / 兩段式看裝置,只有盤面知道 → 提示文字跟它要
      tag.textContent = M16B.discardHint();
      box.appendChild(tag);
    }
  }

  /* ---------- 動作 → 交易 ----------
     ★ 交易內用**伺服器上的那份 state** 重跑一次動作,不是把本地算好的結果寫上去 ——
       兩個人同時動作時,晚到的那筆會在真值上重算、發現不合法而中止。 */
  function doAct(fn){
    ctx.txGame(g=>{
      if(g.status!=="playing" || g.winner) return false;
      const s0 = MJT.dec(g);
      if(!s0) return false;
      const s1 = fn(s0);
      if(!s1) return false;                       // 這個動作在真值上不合法 → 中止
      Object.assign(g, MJT.enc(s1));
      if(s1.over) finishInto(g, s1);
    }, { local:false });                          // 見檔頭:寫 winner 的交易一律不做本地樂觀套用
  }
  function sendBid(type, tiles){
    myBid = true; renderActs();
    const me = mySeat();
    ctx.txGame(g=>{
      if(g.status!=="playing" || g.winner) return false;
      const s0 = MJT.dec(g);
      if(!s0 || !s0.claim) return false;
      const s1 = MJT.bid(s0, me, type, tiles);
      if(!s1) return false;
      Object.assign(g, MJT.enc(s1));
      // 全員都表態了就順手結算,省一次來回
      if(MJT.allBidsIn(s1)){
        const s2 = MJT.resolveClaim(s1);
        if(s2){ Object.assign(g, MJT.enc(s2)); if(s2.over) finishInto(g, s2); }
      }
    }, { local:false });
  }
  /* 視窗到期:誰的 timer 先響誰把沒表態的人補「過」再結算。不指定房主(見檔頭) */
  function resolveExpired(){
    ctx.txGame(g=>{
      if(g.status!=="playing" || g.winner) return false;
      let s = MJT.dec(g);
      if(!s || !s.claim) return false;
      Object.keys(s.claim.elig).forEach(k=>{
        if(!s.claim.bids[k]) s = MJT.bid(s, +k, "pass", null) || s;
      });
      const s2 = MJT.resolveClaim(s);
      if(!s2) return false;
      Object.assign(g, MJT.enc(s2));
      if(s2.over) finishInto(g, s2);
    }, { local:false });
  }

  /* 一局結束 → 把勝負寫進 game(核心負責發結果卡與計分) */
  function finishInto(g, s){
    if(s.over.type==="draw"){
      g.winner = { ids:[], by:"exhaust" };        // 流局:沒有人贏(核心會走「全員」那條)
      return;
    }
    const id = idOfSeat(s.over.seat);
    g.winner = { id:id, name:ctx.dispName(id), by:"hu",
                 tai:s.over.tai, total:s.over.total, self:s.over.from===null };
  }

  /* ---------- 宣告視窗的計時器 ---------- */
  function clearClaimT(){ if(claimT){ clearTimeout(claimT); claimT=null; } }
  function armClaimT(){
    clearClaimT();
    if(!st || !st.claim || st.over) return;
    /* 誰都可以在到期後補結算。刻意加一點依座位錯開的延遲,避免四台同時發交易
       (交易本身擋得住,但四筆同時打過去只是浪費) */
    const jitter = Math.max(0, mySeat()) * 220;
    claimT = setTimeout(resolveExpired, CLAIM_MS + jitter);
  }

  /* ---------- 大廳說明 ---------- */
  function ruleHint(){
    const el = $("m16RuleHint"); if(!el) return;
    el.innerHTML =
      "<b>台灣 16 張</b>:摸打吃碰槓,湊「5 組面子 + 1 對將」就胡。"+
      "人數不同牌組也不同 —— <b>4 人</b>用整副 144 張;<b>2~3 人去掉萬子</b>(108 張),"+
      "而且 <b>3 人不能吃</b>(去一門之後吃會失衡)。<br>"+
      "計分照麻將的<b>相互算台</b>:自摸三家付、放槍一家付,全桌台數加起來永遠是 0。<br>"+
      "打滿 <b>"+handsGoal+" 局</b>後結算,台數最高的人贏。"+
      "<br><span class=\"m16-warn\">⚠ 手牌與牌山在資料庫是明碼,只適合親友之間玩,不防作弊。</span>";
  }

  return {
    ns:{ rooms:"mj16_rooms", index:"mj16_index" },
    minPlayers:2, maxPlayers:4,
    prefsKey:"mahjong16.prefs.v1",
    emoteAnchor:"m16Stage",
    winCardId:"m16WinCard",
    hasResign:false,
    extraNodes:["tai"],

    init(c){ ctx = c; },

    /* ---------- 房間設定 ---------- */
    roomFields(){ return { handsGoal:handsGoal }; },
    onRoomField(k,v){
      if(k!=="handsGoal") return;
      const n = +v;
      if(!(n>0) || n===handsGoal) return;
      handsGoal = n;
      ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
    },
    readRoom(r){ if(+r.handsGoal>0) handsGoal = +r.handsGoal; },

    listen(){
      const r = ctx.ref("tai"); if(!r) return;
      r.on("value", s=>{ tai = s.val()||{}; renderHud(); });
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { wall:null, turn:0, over:null }; },
    resetRound(){ clearClaimT(); st=null; curRound=null; myBid=false; },

    newGame(ids, prev){
      // 座位每局輪換,顏色與莊家才不會永遠同一個人
      let ord;
      if(prev && prev.length===ids.length) ord = prev.slice(1).concat(prev[0]);
      else { ord = ids.slice(); for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; } }

      /* ★ 牌組跟著人數走(2/3 人去萬子)。人數是**開局當下**的 ids.length ——
         中途有人離開不換牌組(換了等於重排整局)。 */
      const n = Math.max(2, Math.min(4, ids.length));
      const done = handsDone();
      const s = MJT.newRound({
        rs: "p"+n,
        dealer: done % n,                        // 每局換莊(連莊預設不做,局數才可預測)
        roundWind: MJ16.idxOf("fe"),
        handNo: done+1
      });
      return Object.assign({ order:ord }, MJT.enc(s));
    },

    applyGame(g, playing){
      if(!playing && !ctx.winner()) return;
      const s = MJT.dec(g);
      if(!s) return;
      const rid = ctx.roundId();
      if(rid !== curRound){ curRound = rid; myBid = false; M16B.clearSel(); }

      const before = st;
      st = s;
      // 宣告視窗換了一輪 → 我的表態記號要清掉
      if(!before || !before.claim || !s.claim ||
         before.claim.t!==s.claim.t || before.claim.from!==s.claim.from) myBid = false;

      M16B.render(st, Math.max(0, mySeat()));
      renderHud(); renderActs(); paintBar();

      if(s.claim && !s.over) armClaimT(); else clearClaimT();

      // 一局結束 → 記台數(交易冪等,誰先到誰寫)
      if(s.over && rid){
        const d = (s.over.type==="win") ? s.over.deltas : new Array(s.seats).fill(0);
        commitTai(rid, d);
      }
    },

    /* ---------- 相位 ---------- */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ showScreen("lobby"); $("mpBar").classList.remove("playing"); ruleHint(); },
    backToLobby(){
      showScreen("lobby"); $("mpBar").classList.remove("playing");
      clearClaimT(); st=null; curRound=null; myBid=false;
      const b=$("m16Hud"); if(b){ b.classList.add("hidden"); b.innerHTML=""; }
      const a=$("m16Acts"); if(a){ a.classList.add("hidden"); a.innerHTML=""; }
      ruleHint();
    },
    enterPlaying(){
      showScreen("play");
      $("mpBar").classList.add("playing");
      Sound.start();
    },
    onLeave(){
      clearClaimT(); st=null; curRound=null; tai={}; myBid=false;
      ["m16Hud","m16Acts"].forEach(id=>{ const e=$(id); if(e){ e.classList.add("hidden"); e.innerHTML=""; } });
    },

    /* ---------- 大廳設定 / 徽章 ---------- */
    syncSetup(){
      const isHost = ctx.isHost();
      const seg = $("m16GoalSeg");
      if(seg){
        seg.classList.toggle("readonly", !isHost);
        [...seg.children].forEach(b=>b.classList.toggle("on", +b.dataset.goal===handsGoal));
      }
      const L = $("m16GoalLabel");
      if(L) L.textContent = isHost ? "打幾局" : "打幾局(房主決定)";
      ruleHint();
    },
    updateGoal(){
      const g = $("mpBarGoal"); if(!g) return;
      g.textContent = "🀄 " + handsGoal + " 局";
      g.classList.remove("hidden");
    },

    chipLead(id){
      const s = seatOf(id);
      return s<0 ? null : '<span class="m16-seat '+colorOf(s)+'"></span>';
    },
    chipTail(id){
      const t = taiOf(id);
      return '<span class="m16-pts'+(t<0?" neg":"")+'">'+(t>0?"+":"")+t+'</span>';
    },
    lobbyStatusText(ids){
      return ids.length<ctx.minPlayers
        ? "等待其他人加入…(2~"+ctx.maxPlayers+" 人)"
        : "等待大家準備…("+ids.length+" 人 · "+
          (ids.length===4?"整副 144 張":"去萬子 108 張")+")";
    },
    readyHint(ids, ready){
      if(ids.length<ctx.minPlayers) return "至少要 "+ctx.minPlayers+" 個人才能開始(最多 "+ctx.maxPlayers+" 人)";
      return ready ? "等其他人按準備…" : "按「準備好了」就開始";
    },
    refresh(){ renderHud(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, isDraw, mine }){
      clearClaimT();
      M16B.clearSel();
      renderHud(); renderActs();
      const done = handsDone();
      const last = done >= handsGoal;
      paintTaiTable(last);

      if(!st || !st.over || st.over.type==="draw")
        return { word: last ? "本場結束" : "流局", msg: last ? seasonMsg() : "牌山見底,這一局不收付 🀫" };

      const o = st.over;
      const tag = o.list.map(x=>esc(x.name)+" "+x.tai).join("、");
      const how = (o.from===null) ? "自摸" : ("胡 "+esc(nameOfSeat(o.from))+" 打的牌");
      const line = "底 "+o.base+" + 台 "+o.tai+" = <b>"+o.total+"</b> 台("+(tag||"無台")+")";
      if(iWon) return { word: last?"本場結束":"你胡了!",
                        msg: how+"<br>"+line+(last?"<br>"+seasonMsg():"") };
      return { word: last?"本場結束":"你沒胡",
               msg: esc(w.name||"對手")+" "+how+"<br>"+line+(last?"<br>"+seasonMsg():"") };
    },

    ownPrefs(){ return { handsGoal:handsGoal, hint:M16B.hintOn() }; },
    usePrefs(o){
      if(+o.handsGoal>0) handsGoal = +o.handsGoal;
      M16B.setHint(o.hint===true);
    },

    api:{
      onDiscard(t){ doAct(s=>MJT.discard(s, mySeat(), t)); },
      setGoal(v){
        v = +v; if(!(v>0)) return;
        if(!ctx.setRoomField("handsGoal", v, { lobbyOnly:true, denyMsg:"只有房主能改局數", busyMsg:"對戰中不能改局數" })) return;
        handsGoal = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      taiOf, handsDone, goal:()=>handsGoal,
      state:()=>st, seat:mySeat,
      /* 盤面不知道玩家是誰(它只有座位號),名字由這裡餵。
         ⚠ 核心沒有把 order() 暴露到 MP 上(那是 ctx 的東西),所以一定要走這支 ——
            main.js 第一版寫成 MP.order() 直接是 undefined。 */
      seatName: nameOfSeat,
      seatId: idOfSeat
    }
  };

  /* ---------- 對戰中的頂部資訊 ---------- */
  function paintBar(){
    const el = $("m16Bar"); if(!el || !st) return;
    const rs = MJ16.RULESETS[st.rs];
    el.innerHTML =
      '<span class="m16-chip">第 '+Math.min(handsGoal, handsDone()+1)+' / '+handsGoal+' 局</span>'+
      '<span class="m16-chip">牌山 '+MJT.wallLeft(st)+'</span>'+
      '<span class="m16-chip">莊 '+esc(nameOfSeat(st.dealer))+'</span>'+
      '<span class="m16-chip">'+(rs.chow?"可吃":"不可吃")+'</span>';
  }

  /* ---------- 結果卡的台數表 ---------- */
  function paintTaiTable(final){
    const box = $("m16Tai"); if(!box) return;
    const ord = ctx.order();
    if(!ord.length){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const rows = ord.map(id=>({ id, t:taiOf(id) })).sort((a,b)=>b.t-a.t);
    box.innerHTML = '<div class="m16-taih">'+(final?"總結算":"目前台數")+
      '(全桌相加必為 0)</div>'+
      rows.map(r=>'<div class="m16-tair"><span>'+esc(ctx.dispName(r.id))+ctx.youTag(r.id)+
        '</span><b class="'+(r.t<0?"neg":"")+'">'+(r.t>0?"+":"")+r.t+' 台</b></div>').join("");
  }
  function seasonMsg(){
    const ord = ctx.order();
    if(!ord.length) return "";
    let best = -Infinity, who = [];
    ord.forEach(id=>{ const t=taiOf(id); if(t>best){ best=t; who=[id]; } else if(t===best) who.push(id); });
    return "🏆 "+who.map(id=>esc(ctx.dispName(id))).join("、")+" 以 "+best+" 台奪冠";
  }
})());

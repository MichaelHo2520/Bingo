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
  /* 宣告視窗長度(秒):房主可選,預設 12(v1.59.0 從寫死的 7 秒改過來 ——
     實際上手回報「8 秒太快了」,真牌桌上思考吃碰的時間本來就比這長)。
     ★ 一定要是**房間層級設定**、不能各人存自己的偏好:到期補「過」是「誰的 timer
       先響誰結算」,各台設不同秒數的話等於全房都被最短的那個決定。
     可選的秒數寫在 mahjong16.html 的 #m16SecSeg(8 / 12 / 20 / 30),這裡只守範圍。 */
  const SEC_DEF = 12;

  let ctx = null;
  let handsGoal = 4;                // 打幾局(房間設定)
  let claimSec = SEC_DEF;           // 宣告視窗幾秒(房間設定)
  let st = null;                    // 目前這一局的 MJT state(解碼後)
  let curRound = null;
  let tai = {};                     // tai 節點快照
  let claimT = null;                // 宣告視窗的計時器
  let claimKey = "";                // 目前這個宣告視窗的身分(哪張牌 @ 誰打的)
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

  /* ---------- 比分列 ----------
     ★ v1.58.2 拿掉了獨立的 .m16-hud 大卡片,改成走**房間框裡的玩家晶片**
       (chipLead / chipTail / turnId 三個鉤子)—— 使用者的話是「人員的台數那個框,
       應該要放進房間框裡,我們原來的設計元素是這樣,沒有衝突的話應該要有一致感」。
       五子棋 / 數獨 / 消消樂都是那樣,這一頁自己另立一套確實不一致。
     ⚠ 因此這一頁要**取消** .mj-room.playing .mj-room-foot{display:none}
       (見 styles.css 的 body.m16-mp 那條),否則對戰中晶片列整條被收起來。 */
  function renderHud(){ ctx.renderPlayers(); }

  /* ---------- 宣告視窗的倒數環(v1.58.4) ----------
     使用者:「吃碰這些選擇時,要有一個倒數的時間可以看,而且這個時間要好看一點,
     我想要有點特效」。做法是一顆 SVG 環圈 + 中間的秒數:環圈隨時間排空,
     最後 3 秒轉紅並脈動。

     ★ 「動」全部交給 CSS animation(環圈是 stroke-dashoffset 的 linear 動畫),
       JS 只負責換中間那個數字 —— **不可以**用 setInterval 重畫整條動作列:
       renderActs() 會因為「別人表態了」「我切換吃法」被叫很多次,每一次重畫都會讓
       動畫從頭開始,倒數就會忽然跳回滿格。
     ★ 因此這顆是**持久節點**:renderActs() 清空動作列時刻意跳過它。
       ⚠ 不能再用 box.innerHTML="" —— 元素一離開文件,CSS 動畫就被取消,
         插回去等於重跑一次,症狀跟上面那條一模一樣。 */
  let cdEl = null, cdT = null, cdEnd = 0;
  function ensureCd(){
    if(cdEl) return cdEl;
    const box = $("m16Acts"); if(!box) return null;
    cdEl = document.createElement("span");
    cdEl.className = "m16-cd hidden";
    cdEl.setAttribute("aria-hidden","true");
    cdEl.innerHTML =
      '<svg viewBox="0 0 40 40"><circle class="m16-cdbg" cx="20" cy="20" r="17"/>'+
      '<circle class="m16-cdfg" cx="20" cy="20" r="17"/></svg><b class="m16-cdn">–</b>';
    box.appendChild(cdEl);
    return cdEl;
  }
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT=null; }
    if(cdEl){ cdEl.classList.add("hidden"); cdEl.classList.remove("m16-hot"); }
  }
  function startCd(ms){
    const el = ensureCd(); if(!el) return;
    if(cdT){ clearInterval(cdT); cdT=null; }
    cdEnd = performance.now() + ms;
    el.classList.remove("hidden","m16-hot");
    const ring = el.querySelector(".m16-cdfg");
    /* 重跑動畫:只改 animation-duration 不會重新開始 —— 要先拿掉、強制 reflow、再掛回去 */
    ring.style.animation = "none"; void ring.offsetWidth;
    ring.style.animation = "m16cd "+ms+"ms linear forwards";
    tickCd();
    cdT = setInterval(tickCd, 200);
  }
  function tickCd(){
    if(!cdEl) return;
    const left = Math.max(0, cdEnd - performance.now());
    const s = String(Math.ceil(left/1000));
    const n = cdEl.querySelector(".m16-cdn");
    if(n.textContent !== s){
      n.textContent = s;
      n.classList.remove("m16-beat"); void n.offsetWidth; n.classList.add("m16-beat");
    }
    cdEl.classList.toggle("m16-hot", left <= 3000);      // 最後 3 秒:轉紅 + 脈動
    if(left<=0){ clearInterval(cdT); cdT=null; }
  }

  /* ---------- 動作列 ---------- */
  /* ⚠ 清空但**留下倒數環**(見 ensureCd 的註解) */
  function clearActs(box){
    [...box.children].forEach(el=>{ if(el!==cdEl) el.remove(); });
  }
  /* 離房 / 回大廳:整條收掉,倒數環也一起丟。
     ⚠ cdEl 一定要跟著設回 null —— 只清 innerHTML 的話 cdEl 會指著一個已經脫離文件的
       節點,ensureCd() 看到它非 null 就直接回傳,那顆環從此再也不會出現在畫面上。 */
  function wipeActs(){
    stopCd(); cdEl = null;
    const a = $("m16Acts"); if(!a) return;
    a.classList.add("hidden"); a.innerHTML = "";
  }
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
    ensureCd();                       // 先建好,倒數環才永遠是這一列的第一個
    clearActs(box);
    if(!st || st.over || ctx.phase()!=="playing"){ box.classList.add("hidden"); return; }
    const me = mySeat();
    if(me<0){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");

    /* --- 宣告視窗 ----------------------------------------------------------
       ★ v1.58.2:吃 / 碰 / 槓**不再各出一顆按鈕** —— 選哪一組是在牌上點的(見 board.js
         檔頭)。這裡只留三顆:✔ 送出目前這一組、胡!、過。
       ★「過」永遠在最後、永遠在,而且是整列最容易命中的位置 —— 使用者要求「要放棄的話
         也要有一個比較容易看到的」。 */
    if(st.claim){
      const types = st.claim.elig[me];
      /* ★★ 不是我在決定的時候,這裡**一個字都不能提吃碰**(v1.59.0)。
         使用者:「在決定要碰牌或吃牌時,我不希望其他人可以看到這個資訊,這樣就太容易
         猜到你有這個牌了」。舊版無論有沒有資格,全桌都看到「等別人決定要不要吃碰…」
         + 一顆倒數環 —— 出牌的人只要看見那行字,就知道**有人手上有這張**,
         就算對方最後過了也已經洩出去了(而且他還知道是這一張,牌情比什麼都值錢)。
         現在:①非當事人只看到中性的「等其他人…」②倒數環只給正在決定的人。
         ★ 我自己表態完也要收掉環 —— 環還在走就等於「還有別人在想」,同一個洩漏。
         ⚠ 到期補「過」的 timer **照樣每台都要跑**(見 armClaimT),藏的只有畫面。
         ⚠ 停頓本身藏不掉(沒人有資格就直接換下一家,有人有資格就會頓一下)。那和真
           牌桌上有人猶豫一樣,而且「有人在想」與「有人可以吃碰你打的這張」差很多:
           後者是牌情,前者只是節奏。要連停頓都藏掉只能每一張都空等,不划算。 */
      if(!types || st.claim.bids[me] || myBid){
        stopCd();
        const tag = document.createElement("span");
        tag.className = "m16-timer";
        /* 「已表態」只回給**按過的那個人自己**(他早就知道自己有資格、剛按了什麼),
           所以這一句不洩漏任何別人的牌情 —— 而它省不掉:按了「過」之後如果畫面跟
           「沒資格」長得一模一樣,使用者會以為那一下沒吃到。 */
        tag.textContent = (types && (st.claim.bids[me] || myBid))
          ? "已表態,等其他人…" : "等其他人…";
        box.appendChild(tag);
        return;
      }
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      tag.textContent = "別人打「"+face(st.claim.t).name+"」";
      box.appendChild(tag);

      const co  = M16B.claimOpts();
      const cur = M16B.claimCur();
      if(cur){
        const lbl = { chow:"吃", pong:"碰", kong:"槓" }[cur.type] || cur.type;
        const b = actBtn("✔ "+lbl+" "+cur.tiles.map(t=>face(t).name).join(""), "take",
                         ()=>sendBid(cur.type, cur.type==="chow" ? cur.tiles : null));
        box.appendChild(b);
        if(co.length>1){
          const n = document.createElement("span");
          n.className = "m16-timer m16-more";
          n.textContent = (co.indexOf(cur)+1)+" / "+co.length+" · 點手牌換一組";
          box.appendChild(n);
        }
      }
      if(types.indexOf("win")>=0) box.appendChild(actBtn("胡!", "win", ()=>sendBid("win", null)));
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
  function clearClaimT(){
    if(claimT){ clearTimeout(claimT); claimT=null; }
    claimKey = ""; stopCd();
  }
  /* ★ 只在「換了一個宣告視窗」時重新計時(v1.58.4)。
     原本每次 applyGame 都無條件重新 setTimeout —— 別人一表態 state 就變、視窗就多幾秒,
     四個人輪流表態可以拖到 4 倍長。畫面上看不出來,但**畫了倒數環之後就藏不住**
     (環圈會忽然彈回滿格)。順手把規則改對:視窗從開啟那一刻起算,固定 claimSec 秒。
     ★ v1.59.0:timer 與倒數環**分開** —— timer 每一台都要跑(不指定房主,誰先響誰補
       「過」,某個人切到 LINE 也不會卡住全桌),但那顆環只有**正在決定的人**看得到
       (理由見 renderActs 裡那段:環在走 = 有人可以吃碰,那是牌情)。 */
  function armClaimT(){
    if(!st || !st.claim || st.over){ clearClaimT(); return; }
    const key = st.claim.t+"@"+st.claim.from;
    if(key === claimKey && claimT) return;
    if(claimT){ clearTimeout(claimT); claimT=null; }
    claimKey = key;
    /* 誰都可以在到期後補結算。刻意加一點依座位錯開的延遲,避免四台同時發交易
       (交易本身擋得住,但四筆同時打過去只是浪費) */
    const jitter = Math.max(0, mySeat()) * 220;
    const ms = claimSec*1000 + jitter;
    claimT = setTimeout(resolveExpired, ms);
    /* ⚠ timer 在上面**無條件** arm(每一台都要跑);下面這行只決定「這顆環給不給看」。
       兩件事寫在一起過,順序倒過來就是「沒資格的人不 arm timer」→ 當事人切到 LINE
       全桌卡死在這個視窗(e2e 的 Q 段有一條專門守它)。 */
    const me = mySeat();
    if(me>=0 && st.claim.elig[me] && !st.claim.bids[me] && !myBid) startCd(ms);
    else stopCd();
  }

  /* ---------- 大廳說明 ---------- */
  function ruleHint(){
    const el = $("m16RuleHint"); if(!el) return;
    el.innerHTML =
      "<b>台灣 16 張</b>:摸打吃碰槓,湊「5 組面子 + 1 對將」就胡。"+
      "人數不同牌組也不同 —— <b>4 人</b>用整副 144 張;<b>2~3 人去掉萬子</b>(108 張),"+
      "而且 <b>3 人不能吃</b>(去一門之後吃會失衡)。<br>"+
      "計分照麻將的<b>相互算台</b>:自摸三家付、放槍一家付,全桌台數加起來永遠是 0。<br>"+
      "別人打的牌你吃得下時有 <b>"+claimSec+" 秒</b>可以想(沒表態就自動過),"+
      "而且<b>別人看不到你在考慮</b> —— 動作列只會寫「等其他人…」。<br>"+
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
    roomFields(){ return { handsGoal:handsGoal, claimSec:claimSec }; },
    onRoomField(k,v){
      const n = +v;
      if(k==="handsGoal"){
        if(!(n>0) || n===handsGoal) return;
        handsGoal = n;
        ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
        return;
      }
      if(k==="claimSec"){
        // 範圍守門而不是白名單:舊房間 / 手改資料庫進來的值也要能用
        if(!(n>=5 && n<=60) || n===claimSec) return;
        claimSec = n;
        ctx.unreadyOnFieldChange(); ctx.syncSetup(); ruleHint();
      }
    },
    readRoom(r){
      if(+r.handsGoal>0) handsGoal = +r.handsGoal;
      if(+r.claimSec>=5 && +r.claimSec<=60) claimSec = +r.claimSec;
    },

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
      const newRnd = (rid !== curRound);
      if(newRnd){ curRound = rid; myBid = false; M16B.clearSel(); }

      const before = st;
      st = s;
      /* 摸打吃碰槓胡的音效。★ 與單機**共用同一份判斷**(js/mahjong16/sfx.js):兩邊的動作
         路徑完全不同(這裡要等交易回來才換手),但「有人碰了」是同一個 state diff,所以
         音效沒有變成第三份「兩份」。
         ⚠ 換局那一手不比 —— 整包重發,逐欄位 diff 出來的東西沒有意義(會在開局瞬間響一串
           吃碰槓);斷線重連時 before 是 null,sfx 自己也會擋掉。 */
      if(!newRnd) M16Sfx.play(before, s, mySeat());
      // 宣告視窗換了一輪 → 我的表態記號要清掉
      if(!before || !before.claim || !s.claim ||
         before.claim.t!==s.claim.t || before.claim.from!==s.claim.from) myBid = false;

      M16B.render(st, Math.max(0, mySeat()));
      renderHud(); renderActs(); ctx.updateGoal();

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
      wipeActs();
      ctx.renderPlayers();                 // 台數在晶片上,回大廳要重畫(st 已清掉,風會收起來)
      ruleHint();
    },
    enterPlaying(){
      showScreen("play");
      $("mpBar").classList.add("playing");
      Sound.start();
    },
    onLeave(){
      clearClaimT(); st=null; curRound=null; tai={}; myBid=false;
      wipeActs();
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
      const seg2 = $("m16SecSeg");
      if(seg2){
        seg2.classList.toggle("readonly", !isHost);
        [...seg2.children].forEach(b=>b.classList.toggle("on", +b.dataset.sec===claimSec));
      }
      const L2 = $("m16SecLabel");
      if(L2) L2.textContent = isHost ? "吃碰思考時間" : "吃碰思考時間(房主決定)";
      ruleHint();
    },
    /* 房間框那顆徽章(麥克風左邊)。
       ★ v1.58.3:對戰中改成「第 n/N 局」—— 使用者的話是「原來那裡寫 4 局之類的內容,
         我覺得沒什麼意義,就換成第多局的內容」。大廳還是只寫目標局數(還沒開始打,
         沒有「第幾局」可言,而且那裡正是房主在設定的那個數字)。
       ⚠ 進度來自 tai._r 的筆數,而 tai 一變就會 renderPlayers() → updateGoal(),
         所以這裡不必自己訂閱;applyGame() 也補叫一次(同一局內換手也要更新)。 */
    updateGoal(){
      const g = $("mpBarGoal"); if(!g) return;
      const n = Math.min(handsGoal, handsDone()+1);
      g.textContent = (ctx.phase()==="playing")
        ? "🀄 第 "+n+"/"+handsGoal+" 局"
        : "🀄 "+handsGoal+" 局";
      g.classList.remove("hidden");
    },

    /* 輪到誰:核心會把 .turn 打在晶片上(底色 + 脈動 + 放大),四個遊戲同一套。
       ⚠ 消消樂不需要實作這支(它沒有回合),真麻將有,一定要給。 */
    turnId(){ return (st && !st.over) ? idOfSeat(st.turn) : null; },
    /* 晶片前綴:座位色點 + 門風 +(是莊的話)莊。
       ★ 莊家記號 v1.58.3 從盤面頂端那條資訊列搬過來 —— 盤面上是掛在每一家自己那一列
         (board.js 的 foeHTML),我自己那一家沒有「一列」,就靠這裡。 */
    chipLead(id){
      const s = seatOf(id);
      if(s<0) return null;
      const wind = st ? MJFace.info(MJ16.codeOf(MJT.seatWind(s, st.dealer, st.seats))).glyph : "";
      return '<span class="m16-seat '+colorOf(s)+'"></span>'+
             (wind?'<span class="m16-cw">'+wind+'</span>':'')+
             (st && s===st.dealer ? '<span class="m16-dz">莊</span>' : '');
    },
    chipTail(id){
      const t = taiOf(id);
      return '<span class="m16-pts'+(t<0?" neg":"")+'">'+(t>0?"+":"")+t+'<em>台</em></span>';
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
      paintWinTiles();                 // 胡的人攤什麼牌(流局時自己收起來)

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

    ownPrefs(){ return { handsGoal:handsGoal, claimSec:claimSec, hint:M16B.hintOn() }; },
    usePrefs(o){
      if(+o.handsGoal>0) handsGoal = +o.handsGoal;
      if(+o.claimSec>=5 && +o.claimSec<=60) claimSec = +o.claimSec;
      M16B.setHint(o.hint===true);
    },

    api:{
      onDiscard(t){ doAct(s=>MJT.discard(s, mySeat(), t)); },
      setGoal(v){
        v = +v; if(!(v>0)) return;
        if(!ctx.setRoomField("handsGoal", v, { lobbyOnly:true, denyMsg:"只有房主能改局數", busyMsg:"對戰中不能改局數" })) return;
        handsGoal = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      /* 宣告視窗幾秒。lobbyOnly:對戰中改會讓「誰的 timer 先響」在同一個視窗裡不一致,
         而且改設定本來就該回大廳談(同局數)。 */
      setSec(v){
        v = +v; if(!(v>=5 && v<=60)) return;
        if(!ctx.setRoomField("claimSec", v, { lobbyOnly:true, denyMsg:"只有房主能改思考時間", busyMsg:"對戰中不能改思考時間" })) return;
        claimSec = v; ctx.syncSetup(); savePrefs();
      },
      taiOf, handsDone, goal:()=>handsGoal, sec:()=>claimSec,
      state:()=>st, seat:mySeat,
      // 盤面切換「要吃哪一組」之後,✔ 按鈕上的字要跟著換 → 回頭叫這支重畫動作列
      refreshActs: renderActs,
      /* 盤面不知道玩家是誰(它只有座位號),名字由這裡餵。
         ⚠ 核心沒有把 order() 暴露到 MP 上(那是 ctx 的東西),所以一定要走這支 ——
            main.js 第一版寫成 MP.order() 直接是 undefined。 */
      seatName: nameOfSeat,
      seatId: idOfSeat
    }
  };

  /* (v1.58.3:盤面頂端那條資訊列 #m16Bar 整條拿掉了 —— 使用者:「我想要省掉房間框
      下面那一行」。四個欄位的下落:
        · 可吃 / 不可吃  → 刪掉(開局就定的房間設定,大廳說明裡已經寫了)
        · 牌山還剩幾張   → 刪掉(玩的人不看;真要看,流局本身就是提示)
        · 第 n / N 局    → 搬到房間框的 #mpBarGoal(麥克風左邊,見 updateGoal)
        · 莊 某某        → 搬到每一家自己那一列 / 玩家晶片(board.foeHTML + chipLead)) */

  /* ---------- 結果卡:胡牌那家的攤牌(v1.58.4) ----------
     使用者:「如果別人胡了,我覺得應該要顯示出胡的人是什麼牌」。
     ★ 手牌明碼那個架構決策在這裡再拿一次紅利:攤牌不必等誰上傳,每台裝置本來就有
       完整的 state,自己畫就是。
     ⚠ 牌大小照張數算 —— 結果卡內容寬只有約 300px,清一色 17 張硬塞會爆出去;
       有明牌時手牌短很多,反而可以畫大一點。 */
  function paintWinTiles(){
    const box = $("m16Win"); if(!box) return;
    if(!st || !st.over || st.over.type!=="win"){ box.classList.add("hidden"); box.innerHTML=""; return; }
    const o = st.over;
    const n = (st.hands[o.seat]||[]).length;
    const tw = Math.max(17, Math.min(28, Math.floor(300 / Math.max(1,n))));
    box.classList.remove("hidden");
    box.innerHTML =
      '<div class="m16-showh">'+esc(nameOfSeat(o.seat))+' 的牌 · <em>紅框</em>是胡的那張</div>'+
      M16B.revealHTML(st, o.seat, tw, o.tile);
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

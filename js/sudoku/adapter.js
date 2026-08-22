"use strict";

/* ============================================================================
   數獨 — 連線適配器(接上 js/shared/mp-core.js)。兩種玩法共用同一個房間與題目:

   • grab(搶格,預設):所有人看**同一張盤面**、同時都能填。填對 → 那格永久標上你的顏色
     並 +1 分;填錯 → 凍結 FREEZE_MS 並讓對手看到。盤面填滿時分數最高者勝。
   • race(競速):同一題、**各自獨立**的盤面,只同步進度。先完成整盤者勝。

   兩個模式的資料放法刻意不同:
   • grab 的 fills 必須在 game 節點裡(要交易 + rev 才擋得住「兩人同時搶同一格」)
   • race 的 progress 放**房內獨立節點**,各人只寫自己那一支 —— 沒有競態,也不會每填
     一格就把整包 game 推播給全房(那會很吵、很耗流量)

   fills 用整數編碼(見 encFill):Firebase 對「整數陣列」的處理最乾淨,
   跟五子棋的 moves 完全同構,共用核心的 rev / 交易機制原封不動就能用。
   ========================================================================== */

const MP = MPCore.create((function(){
  const FREEZE_MS=3000;            // 填錯的凍結懲罰
  const COLORS=["p0","p1","p2","p3","p4","p5"];   // 對應 styles.css 的 --sp0~--sp5(要加人先加色)
  let mode="grab", diff="e9", assist=false;      // 房間設定(房主可改)
  let gMode="grab", gDiff="e9", gAssist=false;   // 開局當下鎖定的值(對戰中改設定不影響進行中的這局)
  let ctx=null;
  let puzKey=null, holes=0, fills=[], tally=[], prog={};
  let myMiss=0, startedAt=0;
  let stkSeat=-1, stkN=0;          // 連搶:誰、連幾格(只看「搶對」,填錯不列入也不打斷別人的)

  /* ---------- fills 的整數編碼 ---------- */
  // i(0~80) / v(1~9) / seat(0~5) / ok(0|1) → 單一整數(上限 12955,RTDB 存起來最省)
  // seat 佔的是 8 進位那一位,能塞 0~7 —— v1.47.0 把人數從 4 開到 6 時,這支編碼一行都不用改
  function encFill(i,v,seat,ok){ return ((i*10+v)*8+seat)*2+(ok?1:0); }
  function decFill(c){
    const ok=c%2; c=(c-ok)/2;
    const seat=c%8; c=(c-seat)/8;
    const v=c%10, i=(c-v)/10;
    return { i, v, seat, ok:!!ok };
  }
  function seatOf(id){ return ctx.order().indexOf(id); }
  function mySeat(){ return seatOf(ctx.me()); }
  function colorOf(seat){ return COLORS[seat]||"p0"; }

  /* ---------- 計分:唯一的加減分入口 ----------
     一般模式只加不扣(原設計:扣分容易讓落後方棄賽)。
     候選提示才啟用 −1 —— 提示會公布「這格只有 2 個可填」,知道數量之後隨便按一個
     期望成本只有 1.5 秒(3 秒 × 50%),時間懲罰根本擋不住亂猜,要用分數才擋得住。
     **地板 0**:負分對落後方的心理殺傷力太大,而且 HUD 進度條算出負寬度會很醜。

     ⚠ 三個地方都必須走這支(結算 / 重連整盤重建 / 平時增量),
        漏掉任何一個就會出現「重連後分數跟別人對不上」的鬼 bug。
     clamp 讓運算變得跟順序有關,但 fills 是有序陣列、各端重放順序一致,結果仍然相同。 */
  function bump(t,seat,ok,as){
    const cur=t[seat]||0;
    t[seat] = ok ? cur+1 : (as ? Math.max(0,cur-1) : cur);
  }

  /* 連搶:fills 是**有序**的全房共同事實 → 各台重放的結果一定一致,不必另外同步。
     只有「搶對」進得來:填錯不是誰的手速比較快,拿它打斷別人的連段講不通。
     ⚠ 這一支必須跟 bump() 一樣「三條路徑都走到」(結算不需要,它不畫畫面),
       否則重連歸位那一台的連段會從 0 重數,跟別人對不上。 */
  function bumpStreak(seat,ok){
    if(!ok)return 0;
    if(seat===stkSeat) stkN++; else { stkSeat=seat; stkN=1; }
    return stkN;
  }

  /* ---------- 即時比分 HUD(盤面上方那一列) ---------- */
  function renderHud(){
    const box=$("sdkHud"); if(!box)return;
    if(ctx.phase()!=="playing"){ box.classList.add("hidden"); box.innerHTML=""; return; }
    const ord=ctx.order(), me=ctx.me();
    box.classList.remove("hidden");
    // 5 人以上一列排不下(窄機一張卡不到 55px)→ 掛旗標讓 CSS 換成 3 欄兩列
    box.classList.toggle("sdk-hud-two", ord.length>4);
    /* 幾個人就掛 .sdk-hud-c<幾>:HUD 的欄數**一定要明講**,不可以交給
       repeat(auto-fit,…) 自己長 —— 領地條是 grid-column:1/-1,而 auto-fit 把一列
       展開成幾十條 1px 的軌,一跨過去就全部不塌,每張卡片只剩 18px(v2.4.4 現場回報)。
       ⚠ 這裡只講「有幾個人」,「一列還是兩列」仍然是 CSS 的事(它才看得到視窗多高)。 */
    const cols=Math.min(6,Math.max(1,ord.length));
    for(let k=1;k<=6;k++) box.classList.toggle("sdk-hud-c"+k, k===cols);
    box.innerHTML=territory(ord)+ord.map((id,seat)=>{
      const nm=esc(ctx.dispName(id));
      let val, sub;
      if(gMode==="grab"){
        val=(tally[seat]||0);
        // 單位一律是「分」不是「格」:開了候選提示會扣分,分數跟搶到的格數本來就不相等
        sub="分";
      }else{
        const p=prog[id]||{};
        val=holes?Math.round(((p.n||0)/holes)*100):0;
        sub="%";
      }
      const bar=gMode==="race"
        ? '<span class="sdk-bar"><i style="width:'+val+'%"></i></span>'
        : '<span class="sdk-bar"><i style="width:'+(holes?Math.round((val/holes)*100):0)+'%"></i></span>';
      return '<div class="sdk-hcard '+colorOf(seat)+(id===me?" me":"")+'" data-id="'+id+'" title="'+
               (id===me?"點一下傳送互動表情給全部人":"點一下傳送互動表情")+'">'+
               '<span class="sdk-hname"><span class="sdk-seat '+colorOf(seat)+'"></span>'+nm+(id===me?' <b>你</b>':'')+'</span>'+
               '<span class="sdk-hval">'+val+'<em>'+sub+'</em></span>'+bar+
             '</div>';
    }).join("");
  }
  /* 領地比例條(只有搶格有):一條橫的堆疊條,每個人一段,右邊剩下的是還沒被搶走的格子。
     它跟每張卡片下面那條細進度條講的**不是同一件事** —— 那條是「我填了幾成」,
     這條是「盤面現在被誰佔著」,一眼就看得出領先多少,而卡片要一張一張讀數字。
     ⚠ 這一條是 #sdkHud 的子元素,而 #sdkHud 是 grid → 一定要 grid-column:1/-1
       橫跨整列(CSS 那邊),不然它會被當成第一張卡片擠進去。
     ⚠⚠ 而那個 1/-1 反過來把「HUD 有幾欄」綁死了:**不可以**再讓欄數是 auto 的
       (repeat(auto-fit,…) 會展開成幾十條 1px 的軌,一被跨過去就全部不塌 →
       每張卡片剩 18px)。欄數改由 renderHud() 掛 .sdk-hud-c<N> 明講,
       兩件事是一體的,動任何一邊都要一起看。
     ⚠ 分母用 holes(這一局總共有幾個空格)不用「已填數」:用已填數的話,
       開局第一格填下去就是 100%,條子會一路從滿的縮回來,完全反直覺。 */
  function territory(ord){
    if(gMode!=="grab"||!holes)return "";
    const segs=ord.map((id,seat)=>{
      const w=Math.max(0,Math.min(100,((tally[seat]||0)/holes)*100));
      return w>0 ? '<i class="'+colorOf(seat)+'" style="width:'+w.toFixed(2)+'%"></i>' : "";
    }).join("");
    return '<div class="sdk-terr" aria-hidden="true">'+segs+'</div>';
  }
  /* 連搶三格以上:那個人的卡片燒起來 + 一則吐司。刻意用既有的吐司管道 ——
     這是對戰中最寶貴的垂直空間,為了一句話再開一列不值得。
     ⚠ 同 popScore:renderHud() 會重建 innerHTML,所以一定要在它之後才掛。 */
  function flameHud(seat,n){
    const box=$("sdkHud"); if(!box)return;
    const card=box.querySelectorAll(".sdk-hcard")[seat];
    if(!card)return;
    card.classList.remove("hot"); void card.offsetWidth; card.classList.add("hot");
    setTimeout(()=>card.classList.remove("hot"),1200);
  }

  /* 分數變動時在那個人的 HUD 卡片上飄一個 +1 / −1。
     計分規則不寫成說明文字塞進盤面上方(那是玩的時候最寶貴的垂直空間),
     改成讓玩家從「結果」學規則 —— 看到扣分飄出來,比讀任何一行字都清楚。
     renderHud() 會重建 innerHTML,所以飄字一定要在它之後才掛。 */
  function popScore(seat,delta){
    const box=$("sdkHud"); if(!box)return;
    /* ⚠ 這裡**不可以**用 box.children[seat]:領地比例條是 #sdkHud 的第一個子元素,
       用 children 會整組偏一格(0 號的飄字掛到條子上 = 看不見,最後一個直接掛不上)。 */
    const card=box.querySelectorAll(".sdk-hcard")[seat]; if(!card)return;
    const el=document.createElement("span");
    el.className="sdk-pop "+(delta>0?"up":"down");
    el.textContent=(delta>0?"+":"−")+Math.abs(delta);
    card.appendChild(el);
    setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); },900);
  }

  /* ---------- 填格 ---------- */
  /* ⚠ 這一支的每一條 return 都要講一句話(v1.181.2):這一頁沒有「輪到誰」,
     格子有沒有變就是使用者唯一的回饋 —— 靜靜 return 的下場是回報上來只有
     「點下去沒反應」,連是哪一條都不知道(成語接龍那次就是這樣查了很久)。 */
  function play(i,v){
    if(ctx.phase()!=="playing"){ return; }            // 不在對局裡(單機 / 大廳)—— 這條不必講話
    if(ctx.winner()){ showToast("這一局結束了,等下一局開始 👀",1400); return; }
    if(SB.frozen()){ return; }                        // 提示已由 SB 自己給
    if(SB.isGiven(i)){ showToast("這格是題目給的,不能改"); return; }
    if(gMode==="grab") playGrab(i,v); else playRace(i,v);
  }
  /* 搶格:填對才寫進 fills(交易內再檢查一次有沒有被搶走);填錯也寫,但只用來計錯與通知對手 */
  function playGrab(i,v){
    if(SB.valueAt(i)){ showToast("這格已經被填走了"); return; }
    const seat=mySeat(); if(seat<0){ showToast("座位還在同步,等一下再試 ⏳",1400); return; }
    const right=(SB.solAt(i)===v);
    if(!right){
      myMiss++;
      SB.flashWrong(i);
      SB.freeze(FREEZE_MS,i);      // 帶上格號 → 那一格結霜,倒數歸零時碎冰
      showToast(gAssist?"填錯了 −1 分,冷靜 3 秒 🥶":"填錯了,冷靜 3 秒 🥶",1400);
      try{ Sound.lose(); }catch(e){}
      ctx.txGame(g=>{
        if(g.status!=="playing"||g.winner)return false;
        g.fills=(Array.isArray(g.fills)?g.fills:[]).concat(encFill(i,v,seat,0));
      });
      return;
    }
    ctx.txGame(g=>{
      if(g.status!=="playing"||g.winner)return false;
      const arr=Array.isArray(g.fills)?g.fills:[];
      // 交易內再驗一次:別人可能在這 100ms 內先搶到了(本地快照還沒收到)
      for(let k=0;k<arr.length;k++){ const f=decFill(arr[k]); if(f.ok && f.i===i) return false; }
      g.fills=arr.concat(encFill(i,v,seat,1));
    });
  }
  /* 競速:各自的盤面,本地直接填,只把進度推上去 */
  function playRace(i,v){
    if(SB.valueAt(i)===v){ SB.clear(i); pushProgress(); return; }
    if(SB.solAt(i)===v){
      SB.fill(i,v,colorOf(mySeat()),true);   // true = 剛剛下的一手 → 鈐印 + 行列宮光波
      Sound.place();
      pushProgress();
      if(SB.isComplete()){ SB.markDone(); settleRace(); }
      else{ const nx=SB.firstEmpty(); if(nx>=0) SB.setSel(nx); }
    }else{
      myMiss++;
      SB.flashWrong(i);
      // 競速沒有分數可扣,輔助模式的懲罰只能是時間。不開輔助時維持原本「只計錯、不擋手」
      if(gAssist){
        SB.freeze(FREEZE_MS,i);
        showToast("填錯了,冷靜 3 秒 🥶",1400);
      }
      try{ Sound.lose(); }catch(e){}
      pushProgress();
    }
  }
  function erase(i){
    if(ctx.phase()!=="playing"||ctx.winner()||i<0)return;
    if(gMode==="grab"){ showToast("搶到的格子不能清掉"); return; }
    if(SB.isGiven(i))return;
    SB.clear(i); pushProgress();
  }
  function pushProgress(){
    const r=ctx.ref("progress/"+ctx.me()); if(!r)return;
    r.set({ n:SB.filledCount(), m:myMiss, done:SB.isComplete(), at:Date.now()-startedAt });
  }
  /* 結果卡上補一行「你 N 對 M 錯 → K 分」。只在有扣分時才附 ——
     沒開輔助時分數就等於格數,講了是廢話。結果卡是解釋計分的最佳位置:
     玩完才看得到,對戰中一格版面都不吃。 */
  function myTail(){
    if(!gAssist) return "";
    const s=mySeat(); if(s<0) return "";
    let ok=0, no=0;
    fills.forEach(c=>{ const f=decFill(c); if(f.seat!==s)return; if(f.ok)ok++; else no++; });
    return no ? "<br>你 "+ok+" 對 · "+no+" 錯 → "+(tally[s]||0)+" 分" : "";
  }
  /* ---------- 結算 ----------
     ★★ 兩支都用 { local:false }(v1.156.0 補;紅線 15 舉的例子就是這裡)——
       決定勝負的寫入**不做本地樂觀套用**。樂觀套用會讓「搶最後一格 / 幾乎同時解完」的
       那一台先看到一個之後被伺服器推翻的贏家,而看到贏家就會放彩帶、播勝利音效、
       往 scores/{me} 寫分,那三件事都不會隨交易回退(核心的反向修正只收回分數,
       畫面上閃過的「你贏了!」與音效已經發生)。代價是自己那一手要等一趟往返
       (~100~300ms)才看到結果卡,那是另外八個遊戲已接受的取捨。
       ⚠ 同一個缺陷連著程式一起被複製到 js/chengyu/adapter.js 的 settleGrab(同版一起修)。
       ⚠ 上面填格的那支 txGame **刻意**不帶 —— 它不決定勝負,樂觀套用才有即時手感。 */
  function settleRace(){
    ctx.txGame(g=>{
      if(g.winner)return false;
      g.winner={ id:ctx.me(), name:ctx.name(), by:"time", ms:Date.now()-startedAt };
    },{ local:false });
  }
  // 搶格:盤面填滿就結算。誰看到誰寫,交易保證只有第一個成功(不指定「填最後一格的人」,
  // 免得那個人剛好斷線就沒人寫、整局卡住)
  function settleGrab(){
    ctx.txGame(g=>{
      if(g.winner)return false;
      const arr=Array.isArray(g.fills)?g.fills:[];
      const as=!!g.assist;           // 讀 game 節點而不是本地 gAssist:結算要以開局鎖定的值為準
      const t=[];
      arr.forEach(c=>{ const f=decFill(c); bump(t,f.seat,f.ok,as); });
      const ord=ctx.order();
      let best=-1;
      ord.forEach((id,s)=>{ if((t[s]||0)>best) best=(t[s]||0); });
      const ids=ord.filter((id,s)=>(t[s]||0)===best);
      g.winner = ids.length===1
        ? { id:ids[0], name:ctx.dispName(ids[0]), by:"score", pts:best }
        : { ids:ids, by:"draw", pts:best };
    },{ local:false });
  }

  /* ---------- 大廳設定 ---------- */
  function ruleHint(){
    const el=$("sdkRuleHint"); if(!el)return;
    const L=SGen.levelOf(diff);
    const base = mode==="grab"
      ? "<b>搶格</b>:大家看同一張盤面,同時搶著填。填對這格就歸你 <b>+1 分</b>,盤面填滿時分數最高的人贏。"
      : "<b>競速</b>:同一題、各自解各自的,中途只看得到對手的進度條。最先把整盤填完的人贏。";
    // 罰則寫在大廳(開打前看得完),對戰中不佔盤面上方任何一列
    let pen;
    if(mode==="grab") pen = assist ? "填錯 <b>−1 分</b>並凍結 3 秒(分數不會扣成負的)。" : "填錯凍結 3 秒,<b>不扣分</b>。";
    else              pen = assist ? "填錯凍結 3 秒。" : "填錯只計次,不罰。";
    const as = assist
      ? "🔍 <b>候選提示:開</b> —— 點一個空格,右上角會標出<b>這格有幾個數字可填</b>;是哪幾個要自己掃,九顆鍵都能按。"
      : "🔍 候選提示:關 —— 沒有任何標記,全部自己掃。";
    el.innerHTML = base+pen+"<br>盤面 "+L.label+"(空 "+L.holes+" 格)· "+L.desc+"<br>"+as;
  }

  return {
    ns:{ rooms:"sudoku_rooms", index:"sudoku_index" },
    minPlayers:2, maxPlayers:6,      // v1.47.0 由 4 開到 6(色盤 --sp0~--sp5 與 HUD 兩列版面都跟著到 6)
    /* ★★ 原班人馬可以回座(誤按離開 / 關分頁 / 斷線之後回到**還在打的那一場**)。
       ⚠⚠ 它**不是** joinMidGame:放行的只有 `game.order` 裡本來就有的那個 pid
         (全新的人照舊擋在外面)—— 完整的理由在 js/shared/mp-core.js 的 REJOIN_MID 那一段。
       ★ 不是回合制(搶格 / 競速),離開只是停止貢獻 → 回座就接著填。 */
    rejoinMidGame: true,
    prefsKey:"sudoku.prefs.v1",
    emoteAnchor:"sdkStage",
    winCardId:"sdkWinCard",
    hasResign:false,                 // 限時解謎,中途認輸沒有意義;掛機交給落單倒數處理
    extraNodes:["progress"],

    init(c){ ctx=c; },

    /* ---------- 房間層級設定 ---------- */
    roomFields(){ return { mode:mode, diff:diff, assist:assist }; },
    onRoomField(k,v){
      if(k==="mode"){
        const nv=(v==="race")?"race":"grab";
        if(nv===mode)return;
        mode=nv; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }else if(k==="diff"){
        if(!SGen.LEVELS[v]||v===diff)return;
        diff=v; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }else if(k==="assist"){
        // 輔助模式**只能全房一致**:搶格比的是手速,省掉掃描時間就是直接贏,各自開就不用玩了
        const nv=!!v;
        if(nv===assist)return;
        assist=nv; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }
    },
    readRoom(r){
      if(r.mode==="race"||r.mode==="grab") mode=r.mode;
      if(SGen.LEVELS[r.diff]) diff=r.diff;
      assist=!!r.assist;
    },

    /* ---------- 額外監聽:競速模式的進度 ---------- */
    listen(){
      const r=ctx.ref("progress"); if(!r)return;
      r.on("value",s=>{ prog=s.val()||{}; renderHud(); });
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { fills:[], puzzle:null, sol:null }; },
    resetRound(){ puzKey=null; fills=[]; tally=[]; myMiss=0; prog={}; stkSeat=-1; stkN=0; },
    newGame(ids, prev){
      const q=SGen.make(diff);
      // 座位順序每局輪換一次,顏色才不會永遠同一個人拿 p0
      let ord;
      if(prev && prev.length===ids.length) ord=prev.slice(1).concat(prev[0]);
      else { ord=ids.slice(); for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; } }
      const pr=ctx.ref("progress"); if(pr) pr.remove();     // 上一局的進度不要帶到這局
      return { order:ord, fills:[], puzzle:q.puzzle, sol:q.sol, mode:mode, diff:diff, assist:assist };
    },
    applyGame(g, playing){
      if(!playing) return;
      gMode=(g.mode==="race")?"race":"grab";
      gDiff=SGen.LEVELS[g.diff]?g.diff:"e9";
      gAssist=!!g.assist;
      SB.setAssist(gAssist);          // 每次都設:重連歸位時也要跟著這局鎖定的值
      SB.setClaim(gMode==="grab");    // 佔領暈染只有搶格開(競速全盤同一色,染了只是整片變糊)
      // 題目換了(新的一局)→ 重建盤面
      if(g.puzzle && g.puzzle!==puzKey){
        const L=SGen.levelOf(gDiff);
        /* ⚠ puzKey 一定要**等 setPuzzle 真的做完**才寫進去(v1.181.2,成語接龍那邊先修的
           同一條):先寫的話,setPuzzle 丟例外的那一台從此 g.puzzle === puzKey,
           這一局再也進不來這個分支 —— 盤面停在上一盤,而且沒有任何錯誤訊息。 */
        SB.setPuzzle({ n:L.n, bw:L.bw, bh:L.bh, puzzle:g.puzzle, sol:g.sol });
        puzKey=g.puzzle;
        holes=SB.remaining();
        fills=[]; tally=[]; myMiss=0; startedAt=Date.now(); stkSeat=-1; stkN=0;
        SB.setSel(SB.firstEmpty());
        if(gMode==="race") pushProgress();
      }
      /* ★★★ 解鎖**不綁在「題目換了」那個分支裡**(v1.181.2)。舊寫法只有重建盤面那一拍
         會 setEnabled(true) —— 那一拍沒跑到(漏收快照 / 重連歸位 / 分支上一行丟例外)
         這一台就整局鎖著:盤面看得到、鍵盤淡掉、點下去完全沒反應,而且再也沒有第二次機會。
         成語接龍(這一頁的孿生實作)在現場踩到的就是這個形狀 → 改成每一份快照都重申一次。 */
      if(!ctx.winner()) SB.setEnabled(true);
      if(gMode==="grab"){
        const next=Array.isArray(g.fills)?g.fills:[];
        const pops=[];                 // 這批要飄的分數變動 (seat, delta)
        const hot=[];                  // 這批要報的連搶 (seat, 連幾格)
        // 能延續就只補新的幾筆,否則整盤重建(重連 / 中途歸位)
        const extend = next.length>=fills.length && fills.every((v,k)=>next[k]===v);
        if(!extend){
          const L=SGen.levelOf(gDiff);
          SB.setPuzzle({ n:L.n, bw:L.bw, bh:L.bh, puzzle:g.puzzle, sol:g.sol });
          holes=SB.remaining(); tally=[]; stkSeat=-1; stkN=0;
          // ⚠ fill() 不帶 fx:一次幾十筆,連播的下場是幾十道光波排隊放完。
          //   但連搶要照樣重放 —— 它跟 bump() 一樣是「三條路徑都得走到」的狀態。
          next.forEach(c=>{ const f=decFill(c); if(f.ok) SB.fill(f.i,f.v,colorOf(f.seat)); bump(tally,f.seat,f.ok,gAssist); bumpStreak(f.seat,f.ok); });
          fills=next.slice();
          SB.setSel(SB.firstEmpty());
        }else{
          const added=next.slice(fills.length);
          fills=next.slice();
          const me=mySeat();
          // 一次補很多筆 = 重連歸位或剛開打的批次同步 → 不連播音效、不跳 toast
          const quiet=added.length>1;
          added.forEach(c=>{
            const f=decFill(c);
            const before=tally[f.seat]||0;
            bump(tally,f.seat,f.ok,gAssist);
            const run=bumpStreak(f.seat,f.ok);
            // 連搶三格起報,之後每兩格再報一次(每一格都報的話,兩人局裡快的那個會一直洗版)
            if(!quiet && run>=3 && run%2===1) hot.push([f.seat,run]);
            if(!quiet){ const d=(tally[f.seat]||0)-before; if(d) pops.push([f.seat,d]); }
            if(f.ok){
              SB.fill(f.i,f.v,colorOf(f.seat),!quiet);
              if(!quiet && f.seat!==me){
                SB.flashTaken(f.i);
                Sound.place();
                showToast("⚡ "+ctx.dispName(ctx.order()[f.seat]||"")+" 搶下 "+SB.coordName(f.i),1100);
              }else if(!quiet) Sound.place();
            }else if(!quiet && f.seat!==me){
              showToast("😅 "+ctx.dispName(ctx.order()[f.seat]||"")+" 填錯了"+(gAssist?" −1 分":""),1100);
            }
          });
        }
        // 填滿的判定改看盤面本身。原本是「總分 >= 空格數」,扣分之後總分會小於填對的格數,
        // 那個判定會永遠不成立 → 整局結不了。
        const done = holes>0 && SB.isComplete();
        if(done) SB.markDone();                  // 滿盤:鍍金 + 由中心往外的螺旋點亮(自己擋重播)
        renderHud();
        pops.forEach(p=>popScore(p[0],p[1]));    // 一定要在 renderHud() 之後(它會重建 innerHTML)
        hot.forEach(h=>{                         // 同上,連搶的燒卡也要等 HUD 重建完
          flameHud(h[0],h[1]);
          showToast("🔥 "+ctx.dispName(ctx.order()[h[0]]||"")+" "+h[1]+" 連搶!",1300);
        });
        if(done && !ctx.winner()) settleGrab();
      }else{
        renderHud();
      }
    },

    /* ---------- 相位的專屬畫面 ---------- */
    openConnect(){ showScreen("connect"); },
    enterLobby(){
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      SB.setEnabled(false);
      ruleHint();
    },
    backToLobby(){
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      puzKey=null; fills=[]; tally=[]; myMiss=0; stkSeat=-1; stkN=0;
      paintSdkTitle("");
      SB.setEnabled(false); SB.unfreeze();
      const box=$("sdkHud"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
      ruleHint();
    },
    enterPlaying(){
      showScreen("play");
      // 對戰中收起房間框的名單列:比分 HUD 已經在講同一件事(還更清楚),把那 30px 讓給盤面。
      // 點 HUD 卡片一樣可以送表情給那個人,功能沒有少(見 main.js 的 #sdkHud 委派)
      $("mpBar").classList.add("playing");
      SB.unfreeze();
      Sound.start();
    },
    onLeave(){
      puzKey=null; fills=[]; tally=[]; prog={}; myMiss=0; stkSeat=-1; stkN=0;
      paintSdkTitle("");
      SB.setEnabled(false); SB.unfreeze();
      const box=$("sdkHud"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup(){
      const isHost=ctx.isHost();
      const mSeg=$("sdkModeSeg"), dSeg=$("sdkDiffSeg"), aSeg=$("sdkAssistSeg");
      if(mSeg){ mSeg.classList.toggle("readonly",!isHost); [...mSeg.children].forEach(b=>b.classList.toggle("on",b.dataset.mode===mode)); }
      if(dSeg){ dSeg.classList.toggle("readonly",!isHost); [...dSeg.children].forEach(b=>b.classList.toggle("on",b.dataset.diff===diff)); }
      if(aSeg){ aSeg.classList.toggle("readonly",!isHost); [...aSeg.children].forEach(b=>b.classList.toggle("on",(b.dataset.assist==="1")===assist)); }
      const mL=$("sdkModeLabel"); if(mL) mL.textContent=isHost?"玩法":"玩法(房主決定)";
      const dL=$("sdkDiffLabel"); if(dL) dL.textContent=isHost?"難度":"難度(房主決定)";
      const aL=$("sdkAssistLabel"); if(aL) aL.textContent=isHost?"候選提示":"候選提示(房主決定)";
      ruleHint();
    },
    updateGoal(){
      const g=$("mpBarGoal"); if(!g)return;
      const live=ctx.phase()==="playing";
      const L=SGen.levelOf(live?gDiff:diff);
      const m=(live?gMode:mode)==="grab" ? "⚡ 搶格" : "⏱ 競速";
      // 徽章補一個 🔍:對戰中要隨時看得出「這局有沒有開輔助/會不會扣分」,而這是既有的一列,不吃版面
      g.textContent=m+" · "+L.label+((live?gAssist:assist)?" · 🔍":"");
      g.classList.remove("hidden");     // 數獨沒有認輸鈕來搶這個位置,對戰中也留著
    },

    /* ---------- 名單 / 文案 ---------- */
    chipLead(id){
      const seat=seatOf(id);
      if(seat<0) return null;
      return '<span class="sdk-seat '+colorOf(seat)+'"></span>';
    },
    chipTail(id){
      const seat=seatOf(id); if(seat<0) return "";
      if(gMode==="grab") return '<span class="sdk-pts">'+(tally[seat]||0)+'</span>';
      const p=prog[id]||{};
      return '<span class="sdk-pts">'+(holes?Math.round(((p.n||0)/holes)*100):0)+'%</span>';
    },
    // 人數一律讀 ctx.maxPlayers / ctx.minPlayers,不要再寫死 —— 上次從 4 開到 6 就是漏在這兩句文案
    lobbyStatusText(ids){
      return ids.length<ctx.minPlayers
        ? "等待其他人加入…(最多 "+ctx.maxPlayers+" 人)"
        : "等待大家準備…("+ids.length+" 人)";
    },
    readyHint(ids,ready){
      if(ids.length<ctx.minPlayers) return "至少要 "+ctx.minPlayers+" 個人才能開始(最多 "+ctx.maxPlayers+" 人)";
      return ready ? "等其他人按準備…" : "按「準備好了」就開始";
    },
    refresh(){ renderHud(); },

    /* ---------- 結果 ---------- */
    outcome(w,{ iWon, isDraw, mine }){
      SB.setEnabled(false); SB.unfreeze();
      renderHud(); renderWinnerRow(w,isDraw);
      const box=$("sdkStats"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
      /* 頭銜只發給贏家與並列者。發給輸家的話那不是頭銜,是安慰獎 ——
         而這張卡片上「誰贏了」已經寫得很清楚,再補一句只會互相打架。 */
      paintSdkTitle(
        isDraw ? (mine?"🤝 平分秋色":"") :
        !iWon  ? "" :
        gMode==="race" ? "🏁 極速解謎 · 最快解完整盤" : "⚡ 搶格神手 · 拿下最多格"
      );
      if(gMode==="race"){
        const secs=w.ms?(" · "+Math.round(w.ms/1000)+" 秒"):"";
        if(iWon) return { word:"你贏了!", msg:"最快解完整盤 🎉"+secs };
        return { word:"你輸了", msg:esc(w.name||"對手")+" 先解完了"+secs };
      }
      // 單位一律「分」:開了候選提示會扣分,說「格」會跟實際搶到的格數對不上
      if(isDraw) return { word:mine?"平手!":"你輸了", msg:"盤面填滿,最高分同分 🤝 各得 1 勝"+myTail() };
      if(iWon)   return { word:"你贏了!", msg:"拿下最高分,漂亮 🎉("+(w.pts||0)+" 分)"+myTail() };
      return { word:"你輸了", msg:esc(w.name||"對手")+" 拿下 "+(w.pts||0)+" 分"+myTail() };
    },

    /* ---------- 偏好 ---------- */
    // ⚠ big = 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
    ownPrefs(){ return { mode:mode, diff:diff, assist:assist, big: BigMode.get() }; },
    usePrefs(o){
      // 大 / 小(v1.178.5):存的是「意願」,BigMode 自己決定這一刻要不要生效
      BigMode.set(!!o.big);
      if(o.mode==="race"||o.mode==="grab") mode=o.mode;
      if(SGen.LEVELS[o.diff]) diff=o.diff;
      if(typeof o.assist==="boolean") assist=o.assist;
    },

    /* ---------- 額外暴露給 main.js ---------- */
    api:{
      play, erase,
      mode:()=>mode, diff:()=>diff, gameMode:()=>gMode,
      setMode(v){
        v=(v==="race")?"race":"grab";
        if(!ctx.setRoomField("mode",v,{ lobbyOnly:true, denyMsg:"只有房主能改玩法", busyMsg:"對戰中不能改玩法" }))return;
        mode=v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      setAssist(v){
        v=!!v;
        if(!ctx.setRoomField("assist",v,{ lobbyOnly:true, denyMsg:"只有房主能改候選提示", busyMsg:"對戰中不能改候選提示" }))return;
        assist=v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      setDiff(v){
        if(!SGen.LEVELS[v])return;
        if(!ctx.setRoomField("diff",v,{ lobbyOnly:true, denyMsg:"只有房主能改難度", busyMsg:"對戰中不能改難度" }))return;
        diff=v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      }
    }
  };

  /* 「這局是誰拿下」:大字是主觀的,這一列給客觀事實 —— 顏色 + 名字 +(你) */
  function renderWinnerRow(w,isDraw){
    const el=$("sdkWinner"); if(!el)return;
    const ids = Array.isArray(w.ids) ? w.ids : (w.id?[w.id]:[]);
    if(!ids.length){ el.innerHTML=""; return; }
    const body=ids.map(id=>{
      const seat=seatOf(id);
      const dot=seat>=0?'<span class="sdk-seat '+colorOf(seat)+'"></span>':'';
      return dot+'<span class="gw-name">'+esc(ctx.dispName(id))+'</span>'+ctx.youTag(id);
    }).join('<span class="gw-tag">·</span>');
    el.innerHTML=body+'<span class="gw-tag">'+(isDraw?"並列第一,各得 1 勝":"拿下這局")+'</span>';
  }
})());

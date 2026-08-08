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
     ⚠ v1.122.0 起 handsGoal 可能是負數:那時目標是「打幾圈」(每個人都當完一次莊家、
       且下莊之後才算數),不是「發過幾手牌」——見 goalLabel() / seasonRemaining() 的檔頭。

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
  /* 操作倒數(秒):房主可選,預設 30(v1.59.0 從寫死的 7 秒改過來 ——
     實際上手回報「8 秒太快了」,真牌桌上思考吃碰的時間本來就比這長)。
     ★ 一定要是**房間層級設定**、不能各人存自己的偏好:到期補「過」/ 自動打牌都是
       「誰的 timer 先響誰結算」,各台設不同秒數的話等於全房都被最短的那個決定。
     ★ v1.63.0:這個秒數**同時**管兩件事 —— 吃碰要不要,以及**輪到你出牌**。
       使用者的話是「後續的出牌也沒秒數限制,這樣不是很奇怪,應該是要倒數秒數是做為
       這次的完全操作倒數」。
     ★★ v1.65.0:這個秒數是**一手的總預算**,不是「吃碰 N 秒 + 出牌再 N 秒」。
       使用者的話是「如果我選了三十秒,這三十秒應該是要包含思考要不要吃,而不是如果
       下家在考慮要不要吃,選完後,我會重新有三十秒,這樣不就被知道這張牌,對方是有
       相關的」。v1.63.0 的兩段各自起算,等於把 v1.59.0 好不容易藏起來的牌情從
       **時間**這條管道洩回去:打完牌之後環沒有馬上出現、出現之後又跑滿一整輪 ——
       那就是「有人吃得下你剛打的那張」的明碼訊號(而且連他想了幾秒都看得到)。
       所以現在改成:**從「有人打出一張牌」那一刻起算 claimSec 秒**,宣告視窗與後續
       出牌共用這一份預算,到 0 為止一定會有一張新的牌落到牌河。
     ★ 宣告階段最多吃掉一半(claimMs)—— 用滿的話下一家會 0 秒被自動摸切,而拖滿的
       通常是掛機的人、被罰的卻是下一家。**留一半不影響對稱性**:總長度仍然固定。
     ★ **0 = 關掉**(#m16SecSeg 的第一顆)。關掉之後兩邊都不限時 —— 沒有人催,
       但**某個人離開牌桌就會全桌一直等**(現場親友喊一聲就好,所以這是使用者的選擇)。
     可選的值寫在 mahjong16.html 的 #m16SecSeg,這裡只守範圍。
     ★★ v1.103.0 整組往上搬:關 / 8 / 12 / 20 / 30(預設 12)→ **關 / 15 / 30 / 45 / 60
       (預設 30)**。使用者指定的值。這一份是**一手的總預算**(宣告 + 出牌兩段共用),
       宣告階段最多只吃掉一半 —— 舊的預設 12 秒等於「吃碰 6 秒 + 出牌 6 秒」,
       真牌桌上光是看清楚別人打了什麼就不只 6 秒。
     ⚠ 別人開的**房間**送來 8 / 12 / 20 照樣照單全收(secOK 是**範圍**不是白名單)——
       那是房主的設定,擅自換成鄰近值等於全房各算各的。段落列上沒有一顆亮著是正確的。
     ⚠ 但**自己的偏好**要 snapSec():舊玩家的偏好裡存著 12,不吸附的話他永遠停在 12、
       而且開房時看到的段落列一顆都沒亮(見 usePrefs)。 */
  const SEC_DEF = 30;
  const SEC_OPTS = [0, 15, 30, 45, 60];                   // ⚠ 要與 mahjong16.html 的 #m16SecSeg 一致
  const secOK = n => n === 0 || (n >= 5 && n <= 60);      // 守門用範圍,舊房間 / 手改 DB 的值也要能用
  // 舊偏好吸附到最接近的一顆(0 是「關」,不要被 15 吸走 → 先擋掉)
  function snapSec(n){
    if(!(n > 0)) return 0;
    return SEC_OPTS.slice(1).reduce((a,b)=> Math.abs(b-n) < Math.abs(a-n) ? b : a);
  }
  /* 底幾台(v1.75.15,使用者:「底幾台要能被設定,預設為 2 台」)。
     ★ 一定是**房間層級設定**:底台是算收付用的,各人一份的話同一局四台會算出不同的錢
       (而且收付相加照樣是 0,零和斷言抓不到)。可選的值寫在 mahjong16.html 的 #m16BaseSeg。
     ⚠ 真正生效的地方是開局時寫進 state 的 st.base(見 newGame)—— 對局中改不到已開的局。 */
  const BASE_DEF = 2;
  const baseOK = n => n >= 1 && n <= 10;

  /* 打幾局(v1.122.0 起改成「除了 1 局,其它都算圈數」—— 使用者:「一圈是要指每一個人都
     當完莊家,並且下莊後才算」。★ 負數 = 圈數,正數 = 局數,兩種目標刻意共用同一個欄位、
     用正負號分岔(button 的 data-goal 直接就是這個數字,不必另開一個「單位」欄位)。 */
  const GOALS = [1, -1, -2, -4];                          // ⚠ 要與 mahjong16.html 的 #m16GoalSeg 一致
  const goalOK = n => GOALS.indexOf(n) >= 0;
  function goalLabel(g){
    if(g > 0) return g + " 局";
    return (-g === 4) ? "一將(4圈)" : ((-g) + " 圈");
  }
  /* 對局中房間框那顆徽章。局數版沿用舊字;圈數版顯示目前圈風 + 第幾圈。
     ⚠ 要在 face()/idOfSeat() 等其他 helper 定義好之後才能用,呼叫端(updateGoal)
       本來就在那之後才會用到,不必特別搬動宣告順序。 */
  function goalBadgeText(){
    if(handsGoal > 0) return "第 "+Math.min(handsGoal, handsDone()+1)+"/"+handsGoal+" 局";
    const rGoal = -handsGoal;
    const idx = st ? MJT.WINDS.indexOf(st.roundWind) : 0;
    const w = st ? face(st.roundWind).name : "東";
    return w+"圈 · 第 "+(idx+1)+"/"+rGoal+" 圈";
  }

  let ctx = null;
  let handsGoal = -1;                // 打幾局 / 打幾圈(房間設定,負數 = 圈數)
  let claimSec = SEC_DEF;           // 宣告視窗幾秒(房間設定)
  let baseTai = BASE_DEF;           // 底幾台(房間設定)
  let st = null;                    // 目前這一局的 MJT state(解碼後)
  let curRound = null;
  let tai = {};                     // tai 節點快照
  let claimT = null;                // 宣告視窗的計時器
  let claimKey = "";                // 目前這個宣告視窗的身分(哪張牌 @ 誰打的)
  let myBid = false;                // 這一輪我表態過了沒(只擋自己重複點)
  let turnT = null, turnKey = "";   // 出牌倒數的計時器與「這一手」的身分(v1.63.0)
  let handAt = 0;                   // ★ v1.65.0:「這一手」的錨點(本地 performance.now())
  /* ★ 這一局開打那一刻每個人的累積勝場快照(v1.75.14,排名表的「N 勝」欄用)。
     為什麼不當場讀 scores:那個節點是**結算之後**每台各自寫自己的 +1,而結果卡是
     **結算當下**就要畫出來 —— 直接讀會少一分,而且等分數同步回來也沒有人會重畫這張卡
     (核心的 scores 監聽只重畫它自己的 #winScores)。
     用「開局時的值 + 這局有沒有得分」算就沒有時間差,重畫幾次都是同一個數(冪等)。
     ⚠ 與排七的 baseWins 是同一套(notes/15)—— 那邊踩過,這邊直接照抄。 */
  let baseWins = {};
  let lastGained = [];              // 核心在 outcome() 給的得分名單(這一局誰 +1)
  /* ★ 下一局誰坐莊、連了幾拉幾(連莊,v1.102.0)。規則在 MJT.nextDealerOf(),這裡只記結果。
     ⚠ 存的是**玩家 id 不是座位編號**:座位每局輪換(見 newGame),連莊要跟著人走。
     ⚠ 為什麼可以放在本地變數:它是從 game 節點的「已結束那一局」算出來的,而 newGame()
       只有房主叫得到 —— 房主中途重連也會重新收到那一包 over 快照(applyGame 那時
       playing 是 false 但 winner 有值,照樣進得來)。真的問不到(例如房主是這一局
       結束後才進房的)就退回原本的「局數 % 家數」,不會壞掉、只是不連莊。 */
  let lastDeal = null;              // { id:下一局的莊家 playerId, streak:連莊數 }
  /* 這一場「莊家真的換過幾次人」(v1.122.0,圈數的量尺)。★ 只有 nextDealerOf() 回傳
     streak===0(換人,不是連莊/拉莊)才 +1,在 applyGame() 見到 over 那一刻跟 lastDeal
     一起算——每台都會算,但只有房主叫得到 newGame() 才用得到它,理由與 lastDeal 同一條。
     ⚠ 連線的桌次每局輪換座位(newGame 的 ord),座位編號對不上「圈裡第幾位」,所以不能像
       單機那樣直接拿 dealerSeat 推,只能另外存這個跨局計數。 */
  let dealerPass = 0;
  /* ⚠ applyGame() 對同一個 rid 不保證只收到一次 over 快照(房主中途重連就會重收一次,
     見上面 lastDeal 那條註解)。lastDeal 重算是冪等的(同一個 over 永遠算出同一個答案),
     但 dealerPass++ 不是 —— 沒有這個記號的話,每重連一次、圈數就多算一次,「兩圈」
     沒打幾局就打完了。跟 commitTai() 的 _r[roundId] 是同一個道理,只是這裡是本機變數。 */
  let dealerPassRid = null;

  const secOn   = () => claimSec > 0;                     // 操作倒數有沒有開
  const budgetMs = () => claimSec * 1000;                 // 一手的總預算(從 handAt 起算)
  const claimMs  = () => Math.ceil(claimSec/2) * 1000;    // 其中宣告階段最多佔掉的那一半

  /* 「新的一手」= 全桌**本來就看得到**的公開動作,倒數從這裡重新起算:
       ①有人打出一張牌(牌河變長)—— 絕大多數情況就是這一條
       ②有人槓(槓要補一張再打,是額外動作;槓本身公開,多給時間不洩漏任何牌情)
       ③搶槓視窗開啟(加槓引發的,同②;不重設的話這一手的預算通常已經用掉了,
         視窗會瞬間到期 → 有人本來能搶槓卻被跳過,那是規則錯誤而不只是手感問題)
     ⚠ 吃 / 碰**刻意不算**:它們發生在宣告視窗裡,重新起算就等於「有人吃碰 → 這一手變長」,
       那正是這一版要堵的洩漏。碰的人用這一手剩下的時間(他主動碰,早想好要打什麼)。
     ⚠ 連兩次槓(槓完摸到又能槓)不會再重設一次 —— 罕見,而且最壞只是被自動摸切一次,
       不是規則錯誤。不用 melds 長度判是因為加槓不會讓 melds 變長(pong 就地變 kong)。 */
  function isNewHand(b, a){
    if(!b) return true;
    if(a.discards.length > b.discards.length) return true;
    if(a.kongDraw && !b.kongDraw) return true;
    if(a.claim && a.claim.rob && !(b.claim && b.claim.rob)) return true;
    return false;
  }

  /* 畫面上「輪到誰」——★ v1.65.0 的第二條洩漏管道。
     宣告視窗開著時 st.turn 還停在**打牌的人**身上(discard 遇到有人能宣告就不換手),
     而沒人能宣告時 turn 早就跳到下一家了 —— 出牌的人只要看晶片 / 對手列的高亮還在不在
     自己身上,就知道有人吃得下他剛打的那張(和動作列那行字一樣直白)。
     所以宣告視窗中一律顯示**推測的下一家**。猜錯不要緊:真的有人吃碰時輪次會跳到他身上,
     而那時「他碰了」本來就已經公開。
     ⚠ 搶槓視窗例外 —— 槓完本來就還是加槓的人繼續打,顯示 claim.from 才是對的。 */
  function dispTurn(){
    if(!st) return 0;
    if(st.claim && !st.claim.rob) return (st.claim.from + 1) % st.seats;
    return st.turn;
  }
  function turnText(s){ return (s===mySeat()) ? "輪到你…" : ("輪到 "+esc(nameOfSeat(s))+"…"); }

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
  /* 這一局的交易記進去了沒(冪等記號)。★ 結果卡是**結算當下**畫的,而 commitTai 是
     交易 —— 本地樂觀套用通常會搶先一步,但不保證。沒記進去的話台數與局數都要自己補上
     這一局,否則「我明明自摸 24 台,表上卻沒加」與「最後一局沒寫本場結束」都會偶發。 */
  function taiCounted(){ return !!(tai._r && curRound && tai._r[curRound]); }
  function handsDoneNow(){ return handsDone() + ((!taiCounted() && st && st.over) ? 1 : 0); }
  /* 打完幾圈了(v1.122.0)。★ 不必像 handsDoneNow() 那樣補「這一局還沒記進去」的樂觀值 ——
     dealerPass 是本機變數,applyGame() 見到 over 就同步 +1 過,不像 handsDone() 要等
     commitTai() 的交易回來,沒有時間差可補。 */
  function roundsDoneNow(){ return MJT.roundsOf((st && st.seats) || 4, dealerPass); }
  /* 這一場還沒打完(v1.122.0)。★ handsGoal>0 是舊的「打幾局」,<0 是新的「打幾圈」——
     兩者刻意共用同一個判斷,contOn() / outcome() 都不必先問清楚自己是哪一種。 */
  function seasonRemaining(){
    return handsGoal > 0 ? (handsGoal - handsDoneNow() > 0) : ((-handsGoal) - roundsDoneNow() > 0);
  }

  /* ---------- 比分列 ----------
     ★ v1.58.2 拿掉了獨立的 .m16-hud 大卡片,改成走**房間框裡的玩家晶片**
       (chipLead / chipTail / turnId 三個鉤子)—— 使用者的話是「人員的台數那個框,
       應該要放進房間框裡,我們原來的設計元素是這樣,沒有衝突的話應該要有一致感」。
       五子棋 / 數獨 / 消消樂都是那樣,這一頁自己另立一套確實不一致。
     ⚠ 因此這一頁要**取消** .mj-room.playing .mj-room-foot{display:none}
       (見 styles.css 的 body.m16-mp 那條),否則對戰中晶片列整條被收起來。 */
  function renderHud(){ ctx.renderPlayers(); }

  /* ---------- 操作倒數的環(v1.58.4) ----------
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
  let cdEl = null, cdT = null, cdEnd = 0, cdKey = "";
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
    cdKey = "";
    if(cdEl){ cdEl.classList.add("hidden"); cdEl.classList.remove("m16-hot"); }
  }
  /* 畫一顆「總長 totalMs、在 endAt 歸零」的環。
     ★ v1.65.0 兩個關鍵改動:
       ①**同一顆環就不重跑**(cdKey)。宣告階段 → 出牌階段是同一個 endAt,不去重的話
         環會在換階段那一刻彈回滿格 —— 那個彈跳本身就是「剛剛有宣告視窗」的訊號。
       ②**接續播放**用負的 animation-delay。環的 duration 永遠是那一段的總長(所以
         e2e 量 animationDuration 量得到設定值),已經跑掉的部分靠負延遲跳過去。 */
  function startCd(totalMs, endAt){
    const el = ensureCd(); if(!el) return;
    const key = Math.round(totalMs)+"@"+Math.round(endAt);
    /* ⚠ 去重條件**不可以**看 cdT:數字走到 0 之後 tickCd() 就把 interval 停掉了,而
       timer 還有 jitter 那幾百毫秒沒響 —— 那段空窗裡只要有人叫一次 renderActs()
       (盤面 ResizeObserver 就會),環就會彈回滿格。 */
    if(cdKey === key && !el.classList.contains("hidden")) return;
    cdKey = key;
    if(cdT){ clearInterval(cdT); cdT=null; }
    cdEnd = endAt;
    el.classList.remove("hidden","m16-hot");
    const ring = el.querySelector(".m16-cdfg");
    const past = Math.max(0, Math.min(totalMs, totalMs - (endAt - performance.now())));
    /* 重跑動畫:只改 animation-duration 不會重新開始 —— 要先拿掉、強制 reflow、再掛回去。
       ⚠ animationDelay 一定要寫在 shorthand **之後**(shorthand 會把 delay 歸零)。 */
    ring.style.animation = "none"; void ring.offsetWidth;
    ring.style.animation = "m16cd "+totalMs+"ms linear forwards";
    ring.style.animationDelay = (-past)+"ms";
    tickCd();
    cdT = setInterval(tickCd, 200);
  }
  /* 這一刻的環該長什麼樣 —— **唯一**決定環的地方(renderActs / arm*T 都只呼叫它)。
     ★★ 非當事人看到的一律是「這一手的總截止」,從有人打出一張牌一路連續跑到底:
       中間有沒有開過宣告視窗、別人想了幾秒,在畫面上完全反映不出來。
     ★ 只有**還沒表態的當事人**看到比較短的那顆(他的宣告截止)—— 他自己本來就知道
       自己有資格,所以這顆環不洩漏任何別人的牌情;而他需要知道還剩幾秒可以決定。
       表態完就切回總截止(環會變長一點,那是「這一手還剩多久」的正確資訊)。 */
  function syncCd(){
    if(!secOn() || !st || st.over || !handAt || ctx.phase()!=="playing"){ stopCd(); return; }
    const me = mySeat();
    if(me<0){ stopCd(); return; }
    if(st.claim){
      if(st.claim.elig[me] && !st.claim.bids[me] && !myBid){ startCd(claimMs(), handAt + claimMs()); return; }
      startCd(budgetMs(), handAt + budgetMs());
      return;
    }
    if(!MJT.toPlay(st, st.turn)){ stopCd(); return; }     // 還沒摸到牌 / 不是該打牌的狀態
    startCd(budgetMs(), handAt + budgetMs());
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
  /* ⚠ 清空但**留下倒數環與宣告面板**(兩個都是持久節點:環是為了動畫不重跑
       —— 見 ensureCd 的註解;面板是為了進場動畫只播一次 —— 見 board.js 那一節)。 */
  function clearActs(box){
    [...box.children].forEach(el=>{ if(el!==cdEl && !M16B.isClaim(el)) el.remove(); });
  }
  /* 離房 / 回大廳:整條收掉,倒數環也一起丟。
     ⚠ cdEl 一定要跟著設回 null —— 只清 innerHTML 的話 cdEl 會指著一個已經脫離文件的
       節點,ensureCd() 看到它非 null 就直接回傳,那顆環從此再也不會出現在畫面上。 */
  function wipeActs(){
    stopCd(); cdEl = null;
    const a = $("m16Acts"); if(!a) return;
    /* ⚠ 宣告面板也在這一列裡(v1.111.0):innerHTML 清掉它本身是對的(board.js 會
       在需要時重建),但 m16-hush 這個 class 一定要跟著拿掉 —— 留著的話下次進房
       那顆倒數環會用上一局的 --m16cb 飄在盤面中央。 */
    a.classList.remove("m16-hush");
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
  /* ---------- 已宣告聽牌的那一排(v1.66.0 起,v1.67.0 改成只在宣告後出現) ----------
     「我宣告了,而且聽這幾張」。★ 只有自己這台看得到 —— 別人只知道我宣告了
       (那是公開的,對手列有記號),不知道我聽什麼。
     ⚠ 與 solo.js 的 paintActs() 是**兩份**(同 renderActs 那整條),grep m16-ready 找兩處。
     ⚠ 插入條件與 claim **無關**(唯一例外是「我自己正在決定要不要吃碰」那一格,見 renderActs
       —— 跳過純粹為了不把三顆按鈕推到換行)。v1.66.0 那版是自動偵測,那時「它有沒有出現」
       本身就是牌情;現在宣告是公開動作,這條顧慮消失了,但一律插入仍然是最簡單的寫法。
     ⚠ 混合快取:裝置有可能拿到新的 adapter.js 卻還吃著舊的 board.js ——
       那時整條動作列會炸在這裡,而它是牌桌上最重要的一列(「過」「胡」都在上面)。 */
  function appendReady(box, seat){
    if(typeof M16B.readyHTML !== "function") return;
    const h = M16B.readyHTML(st, seat);
    if(h) box.insertAdjacentHTML("beforeend", h);
  }
  /* 現在是不是「正在選要打哪一張來宣告聽牌」。⚠ 一定要同時問 canDeclareTing ——
     模式開著但輪次已經被自動打牌推走時,那顆取消鈕要跟著消失(board 那邊也自己失效)。 */
  function tingPicking(me){
    return !!(M16B.tingPicking && M16B.tingPicking() && MJT.canDeclareTing(st, me));
  }
  function renderActs(){
    const box = $("m16Acts"); if(!box) return;
    ensureCd();                       // 先建好,倒數環才永遠是這一列的第一個
    clearActs(box);
    /* 環在**這裡統一決定**(syncCd 只看 state / myBid,不看動作列畫了什麼)——
       擺在所有 return 之前,才不會有哪一條路徑忘了收環或忘了接上。 */
    syncCd();
    /* ★★ 「我自己正在決定要不要吃碰槓胡」(v1.111.0)—— 這一個布林值決定**盤面中間
       那塊面板**在不在,所以它要算在所有 return 之前(每一條路徑都得把面板收掉)。
       ⚠ 但**不可以**無條件先 hideClaim() 再 claimPanel():hideClaim 會清掉內容,
         而「從關到開」那一次要播進場動畫 → 每次重畫都會閃一下(board.js 紅線②)。 */
    const meNow = mySeat();
    const iDecide = !!(st && !st.over && ctx.phase()==="playing" && meNow>=0 &&
                       st.claim && st.claim.elig[meNow] && !st.claim.bids[meNow] && !myBid);
    if(!iDecide) M16B.hideClaim(box);
    if(!st || st.over || ctx.phase()!=="playing"){ box.classList.add("hidden"); return; }
    const me = meNow;
    if(me<0){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");

    /* ★ 聽牌那一排(v1.66.0):**一律插**。
       ⚠ 條件刻意與 st.claim **無關** —— 見 appendReady 的註解那條第 6 管道。
       ★ v1.111.0 起連「我正在決定吃碰」那一格也插:當年跳過它是怕跟 ✔ / 胡 / 過
         三顆鈕擠成兩行(動作列長高 → 整副牌縮一次),而那三顆鈕已經搬到中間的面板了。 */
    appendReady(box, me);

    /* --- 宣告視窗 ----------------------------------------------------------
       ★ v1.58.2:吃 / 碰 / 槓**不再各出一顆按鈕** —— 選哪一組是在牌上點的(見 board.js
         檔頭)。只留三顆:✔ 送出目前這一組、胡!、過。
       ★★ v1.111.0:那三顆鈕**搬到盤面中間的面板**(M16B.claimPanel)——
         使用者:「大家都反應在最下面很不明顯」。底下這一列因此對「當事人」與
         「非當事人」寫的字**完全一樣**(turnText),牌情那條紅線又牢一分:
         v1.65.0 統一的是兩句話,現在連「有沒有按鈕」都統一了。
       ★「過」永遠在最後、永遠在 —— 使用者要求「要放棄的話也要有一個比較容易看到的」。 */
    if(st.claim){
      const types = st.claim.elig[me];
      /* ★★ 不是我在決定的時候,這裡**一個字都不能提吃碰**(v1.59.0)。
         使用者:「在決定要碰牌或吃牌時,我不希望其他人可以看到這個資訊,這樣就太容易
         猜到你有這個牌了」。舊版無論有沒有資格,全桌都看到「等別人決定要不要吃碰…」
         + 一顆倒數環 —— 出牌的人只要看見那行字,就知道**有人手上有這張**,
         就算對方最後過了也已經洩出去了(而且他還知道是這一張,牌情比什麼都值錢)。
         ★★ v1.65.0 再往前一步:v1.59.0 的「等其他人…」**本身還是一個訊號** ——
           沒有宣告視窗時這裡寫的是「輪到 ○○…」,兩句話不一樣,出牌的人照樣看得出來。
           現在非當事人一律走 turnText(dispTurn()),兩種情況下的字**完全相同**。
         ⚠ 到期補「過」的 timer **照樣每台都要跑**(見 armClaimT),藏的只有畫面。
         ⚠ 藏不掉的殘留管道只剩一條:**下一家的張數**(宣告視窗中他還沒摸牌 → 16 張,
           沒人宣告時他早就摸到 → 17 張)。刻意不假造 —— 顯示 17 之後若有人碰,那家
           會從 17 掉回 16,反而是更明顯的破綻;而張數要主動去數才看得出來。 */
      if(!iDecide){
        const tag = document.createElement("span");
        tag.className = "m16-timer";
        /* 「已表態」只回給**按過的那個人自己**(他早就知道自己有資格、剛按了什麼),
           所以這一句不洩漏任何別人的牌情 —— 而它省不掉:按了「過」之後如果畫面跟
           「沒資格」長得一模一樣,使用者會以為那一下沒吃到。 */
        tag.textContent = (types && (st.claim.bids[me] || myBid))
          ? "已表態,等其他人…" : turnText(dispTurn());
        box.appendChild(tag);
        return;
      }
      /* ★ 底下這一列寫的字與非當事人**逐字相同**(見上面那條紅線);
         要決定的三顆鈕、那張牌與倒數,全部在中間的面板上。 */
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      tag.textContent = turnText(dispTurn());
      box.appendChild(tag);

      const co  = M16B.claimOpts();
      const cur = M16B.claimCur();
      M16B.claimPanel(box, {
        tile: st.claim.t,
        who: nameOfSeat(st.claim.from),           // 誰打的是公開資訊(牌河上就看得到)
        opts: co,
        cur: cur,
        canWin: types.indexOf("win")>=0,
        /* ★ v1.118.1:每一組選項各一顆鈕 → 按哪一顆就送哪一組。
           ⚠ 當場重新問 claimOpts():面板是持久節點,listener 活得比這個閉包久。 */
        onTakeAt: (i)=>{
          const list = M16B.claimOpts(), o = list[i];
          if(o) sendBid(o.type, o.type==="chow" ? o.tiles : null);
        },
        onWin: ()=>sendBid("win", null),
        onPass: ()=>sendBid("pass", null)
      });
      return;
    }

    /* --- 自己的回合 --- */
    if(st.turn!==me){
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      tag.textContent = turnText(st.turn);      // ★ 與宣告視窗中那句**一模一樣**(見上面)
      box.appendChild(tag);
      return;
    }
    /* ★ 宣告聽牌的選牌模式(v1.67.0):這一列只留提示與取消 ——
       那一刻要回答的問題只有一個「打哪一張來宣告」,留著自摸 / 槓只會讓人分心。
       ⚠ 倒數環照舊(syncCd 已經在開頭跑過)—— 宣告不該讓這一手變長。 */
    if(tingPicking(me)){
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      tag.textContent = "點一張亮起來的牌打出 → 宣告聽牌";
      box.appendChild(tag);
      box.appendChild(actBtn("取消", "pass", ()=>{ M16B.setTingPick(false); renderActs(); }));
      return;
    }

    const a = MJT.ownActions(st, me);
    if(a.win) box.appendChild(actBtn("自摸!", "win", ()=>doAct(s=>MJT.selfDrawWin(s, me))));
    a.ckong.forEach(t=>box.appendChild(actBtn("暗槓 "+face(t).name, "",
      ()=>doAct(s=>MJT.concealedKong(s, me, t)))));
    a.akong.forEach(t=>box.appendChild(actBtn("加槓 "+face(t).name, "",
      ()=>doAct(s=>MJT.addKong(s, me, t)))));
    /* ★ 宣告聽牌(v1.67.0)。放在槓之後、打牌提示之前:它比槓少見,但一按下去手牌就鎖死,
       所以要在「我還在想這一手怎麼打」的視線裡。 */
    if(MJT.canDeclareTing(st, me))
      box.appendChild(actBtn("宣告聽牌", "ting", ()=>{ M16B.setTingPick(true); renderActs(); }));
    /* ⚠ 判準是「這一列有沒有**按鈕**」,不是「空不空」——
       這一列常駐兩個非按鈕的子元素(倒數環、宣告面板)加上聽牌那一排,
       用 children.length 的話這句操作提示永遠不會出現。
       (solo.js 的 paintActs() v1.66.0 就改成問 .m16-act 了,這邊漏了同步。) */
    if(a.discard && !box.querySelector(".m16-act")){
      const tag = document.createElement("span");
      tag.className = "m16-timer";
      // 一段式 / 兩段式看裝置,只有盤面知道 → 提示文字跟它要
      tag.textContent = M16B.discardHint();
      box.appendChild(tag);
    }
  }
  /* 宣告聽牌 → 走交易(同其他動作:交易內用伺服器上的 state 重跑一次) */
  function onTing(tile){
    M16B.setTingPick(false);
    doAct(s=>MJT.declareTing(s, mySeat(), tile));
  }

  /* ---------- 「輪到你」震動(v1.61.2) ----------
     設定面板那顆「震動(手機)」開關是五個遊戲共用的,但在這一頁**沒有人讀它** ——
     開了也不會震,比沒有這顆開關更糟。

     ★ 時機刻意就是音效的 `draw` 事件(「別人打完、輪到我摸牌」那一刻):
       ①不必再寫一份「輪到誰」的判斷,和聲音同一個真相
       ②吃 / 碰之後輪到我打牌**不會**震 —— 那是我自己剛動作,我知道輪到我
       ③換局那一手不比 diff,所以開局第一摸不震(那時人正看著螢幕)
     ★ 只有連線震:單機的對手是電腦、一秒內就回手,不需要提醒(五子棋也是只有連線震)。
     ⚠ **宣告視窗不震**:手機放在桌上,震動的嗡嗡聲鄰座聽得到 —— 那等於告訴出牌的人
       「有人手上有這張」。同 v1.59.0 那條紅線,也同這一版音效不給宣告提示音的理由:
       **震動只給「全桌本來就知道」的事(輪到誰),不給「只有你知道」的牌情。**
     ⚠ iOS Safari 沒有 navigator.vibrate → 自動略過(同 Bingo 與五子棋)。 */
  function buzzTurn(){
    if(typeof vibrateOn === "undefined" || !vibrateOn || !navigator.vibrate) return;
    try{ navigator.vibrate([90,60,90]); }catch(e){}
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
    /* ★ 兩個旗標一起設(見 board.js 的 bidDone):myBid 收動作列的三顆鈕,
       bidDone 讓**牌立刻放下**。少了後者,txGame 帶 { local:false } → 本地
       bids[me] 還是空的 → 那幾張候選牌會站著等伺服器回音,而動作列已經寫
       「已表態,等其他人…」了。單機那支不必(MJT.bid 當場回新 state)。 */
    myBid = true; M16B.setBidDone(true);
    M16B.render(st, Math.max(0, mySeat()));
    renderActs();
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
  /* ⚠ v1.65.0 起這裡**不可以** stopCd():宣告視窗一結算就會馬上 armTurnT(),中間收一次環
     等於把 cdKey 清掉 → 下一次 startCd 重跑動畫 → 環在換階段那一刻彈回滿格,
     而那個彈跳本身就是「剛剛有宣告視窗」的訊號。環一律交給 syncCd()。 */
  function clearClaimT(){
    if(claimT){ clearTimeout(claimT); claimT=null; }
    claimKey = "";
  }
  /* ★ 只在「換了一個宣告視窗」時重新計時(v1.58.4)。
     原本每次 applyGame 都無條件重新 setTimeout —— 別人一表態 state 就變、視窗就多幾秒,
     四個人輪流表態可以拖到 4 倍長。畫面上看不出來,但**畫了倒數環之後就藏不住**
     (環圈會忽然彈回滿格)。順手把規則改對:視窗從開啟那一刻起算,固定 claimSec 秒。
     ★ v1.59.0:timer 與倒數環**分開** —— timer 每一台都要跑(不指定房主,誰先響誰補
       「過」,某個人切到 LINE 也不會卡住全桌),環則交給 syncCd() 決定給誰看。
     ★ v1.65.0:截止時間改成從**這一手的錨點**算(handAt + claimMs),不再是「視窗開啟
       後再給一整份 claimSec」—— 宣告與後續出牌共用一份預算,見檔頭。 */
  function armClaimT(){
    if(!st || !st.claim || st.over){ clearClaimT(); return; }
    if(!secOn()){ clearClaimT(); return; }        // ★ 倒數關掉 → 不催(等到有人按)
    const key = st.claim.t+"@"+st.claim.from+"@"+Math.round(handAt);
    if(key === claimKey && claimT) return;
    if(claimT){ clearTimeout(claimT); claimT=null; }
    claimKey = key;
    /* 誰都可以在到期後補結算。刻意加一點依座位錯開的延遲,避免四台同時發交易
       (交易本身擋得住,但四筆同時打過去只是浪費)。
       ⚠ timer **無條件** arm(每一台都要跑)—— 寫成「沒資格就不 arm」的話,當事人切到
         LINE 全桌就卡死在這個視窗(e2e 的 Q 段有一條專門守它)。
       ⚠ 下限 1200ms:錨點是本地時鐘,慢半拍收到 state 的那台可能算出「已經過期」,
         沒有下限就會一收到就補過(當事人連按鈕都來不及看見)。 */
    const jitter = Math.max(0, mySeat()) * 220;
    const left = Math.max(1200, handAt + claimMs() - performance.now());
    claimT = setTimeout(resolveExpired, left + jitter);
  }

  /* ---------- 出牌倒數(v1.63.0) ----------
     使用者:「我覺得對戰遊戲,要做一個設定開關,要不要有倒數秒數功能,而不是只有倒數判斷
     有沒有要吃碰牌…後續的出牌也沒秒數限制,這樣不是很奇怪,應該是要倒數秒數是做為這次的
     完全操作倒數」。

     ★ 與宣告視窗**共用同一份預算**(handAt + budgetMs)與同一顆環 —— 兩者不會同時發生
       (有宣告視窗時沒有人在出牌),而**接起來的總長度固定**,這正是 v1.65.0 的重點。
     ★ **這顆環全桌都看得到**。判準是 v1.61.2 震動那條原則:「輪到誰」是全桌本來就知道
       的事(晶片上就有 .turn),不是牌情;而「誰可以吃碰」是牌情。
       讓大家看到「還在等他、剩幾秒」也才知道為什麼卡著。
     ★ 到期**自動幫他打一張**:摸切優先(打剛摸進來那張,不動手牌),吃 / 碰之後沒有摸牌時
       借 AI 挑一張(比亂打好)。同樣不指定房主 —— 誰的 timer 先響誰發交易,搶輸的中止。
     ⚠ key 用**錨點**(handAt)而不是 v1.63.0 那份 handKey:同一手裡吃碰完換人打牌時
       截止時間不變,不該重排 timer(重排 = 又多給一份時間,洩漏就跑回來了)。 */
  function clearTurnT(){
    if(turnT){ clearTimeout(turnT); turnT=null; }
    turnKey = "";
  }
  function armTurnT(){
    if(!secOn() || !st || st.claim || st.over || ctx.phase()!=="playing"){ clearTurnT(); return; }
    if(!MJT.toPlay(st, st.turn)){ clearTurnT(); return; }   // 還沒摸到牌 / 不是該打牌的狀態
    const key = Math.round(handAt)+":"+st.turn;
    if(key === turnKey && turnT) return;
    if(turnT){ clearTimeout(turnT); turnT=null; }
    turnKey = key;
    const jitter = Math.max(0, mySeat()) * 220;    // 錯開,避免全桌同時發交易
    /* 下限同 armClaimT:宣告階段最多吃掉一半,所以正常一定還剩一半;
       只有網路慢半拍那種異常才會壓到下限。 */
    const left = Math.max(1200, handAt + budgetMs() - performance.now());
    turnT = setTimeout(autoDiscard, left + jitter);
  }
  function autoDiscard(){
    if(!secOn()) return;
    if(st && !st.claim && !st.over && st.turn === mySeat())
      showToast("時間到,自動幫你打出一張", 1600);
    ctx.txGame(g=>{
      if(g.status!=="playing" || g.winner) return false;
      const s0 = MJT.dec(g);
      if(!s0 || s0.claim || s0.over) return false;
      const seat = s0.turn;
      if(!MJT.toPlay(s0, seat)) return false;
      // ①摸切(不動手牌,對玩家最無害)
      let s1 = (s0.drawn>=0) ? MJT.discard(s0, seat, s0.drawn) : null;
      // ②吃 / 碰之後沒有摸牌 → 借 AI 挑一張。⚠ 各台挑的可能不同,但這是交易搶,先到先算
      if(!s1){
        try{
          const a = MJ16AI.pickTurn(MJ16AI.viewOf(s0, seat), "normal");
          if(a && a.act === "discard") s1 = MJT.discard(s0, seat, a.t);
        }catch(e){}
      }
      // ③真的都不行 → 手上第一張打得掉的(不要讓全桌卡死)
      if(!s1){
        const all = MJT.allTiles(s0, seat);
        for(let i=0;i<all.length && !s1;i++) s1 = MJT.discard(s0, seat, all[i]);
      }
      if(!s1) return false;
      Object.assign(g, MJT.enc(s1));
      if(s1.over) finishInto(g, s1);
    }, { local:false });
  }

  /* ---------- 聽牌後自動摸切(v1.119.0,個人偏好) ----------
     使用者:「宣告聽牌後,可以設計一個選項自動出牌,但是如果有可以槓,也是需要停下來」。
     ★ 與上面 armTurnT() 的到期自動摸切**故意分開**、不共用一顆 timer:
       ①那顆是「懲罰掛機」的兜底,秒數是**房間設定**,關掉(claimSec=0)時完全不催人;
         這顆是**個人偏好**,不管房主把倒數設成幾秒、甚至關掉都照樣生效
         (宣告聽牌之後那一手本來就被規則鎖死,跟「有沒有人在催」無關)。
       ②那顆到期會 toast「時間到,自動幫你打出一張」——語氣是提醒 / 懲罰;
         這顆是玩家自己開的功能,不需要那句話。
       混成一顆的話,關掉操作倒數就等於連這顆個人偏好也一起失效,那是另一條規則被誤改。
     ★ 條件與 MJT.discard() 裡「宣告聽牌之後只能摸切」那條**完全對應**:已經宣告聽牌、
       自摸 / 暗槓 / 加槓一個都選不到 → 唯一合法動作就是打掉摸到的那張,沒有第二種選法。
     ⚠ 只管**自己這一家**:每台裝置各看自己的 M16B.autoTingOn(),互不影響 ——
       這張牌打哪一張是規則鎖死的,不是「我在想什麼」那種牌情,不必顧慮洩漏。
     ⚠ key 用 handAt + 座位(同 armTurnT):applyGame 可能因為同一份 state 重新廣播
       而被叫第二次,沒有這道去重會不斷重排 timer / 疊出好幾顆。 */
  let autoTingT = null, autoTingKey = "";
  function clearAutoTingT(){
    if(autoTingT){ clearTimeout(autoTingT); autoTingT=null; }
    autoTingKey = "";
  }
  function armAutoTing(){
    if(!M16B.autoTingOn() || !st || st.claim || st.over || ctx.phase()!=="playing"){ clearAutoTingT(); return; }
    const me = mySeat();
    if(st.turn!==me || !MJT.toPlay(st, me) || !MJT.tingOf(st, me) || st.drawn<0){ clearAutoTingT(); return; }
    const a = MJT.ownActions(st, me);
    if(a.win || a.ckong.length || a.akong.length){ clearAutoTingT(); return; }   // 有得選 → 停下來讓玩家自己按
    const key = Math.round(handAt)+":"+me;
    if(key === autoTingKey && autoTingT) return;
    clearAutoTingT();
    autoTingKey = key;
    autoTingT = setTimeout(function(){
      autoTingT = null;
      const seat = mySeat();
      if(!(st && !st.claim && !st.over && st.turn===seat && MJT.tingOf(st, seat) && st.drawn>=0)) return;
      const a = MJT.ownActions(st, seat);
      if(a.win || a.ckong.length || a.akong.length) return;   // 500ms 這段時間狀態變了 → 保險再擋一次
      // ⚠ 打的一律是**交易裡那份 state** 剛摸到的那張(同 autoDiscard),不是外面的捕獲值 ——
      // discard() 自己會驗一次合法性,真的不合法就中止,不會打錯牌。
      doAct(s=>(s.turn===seat && s.drawn>=0) ? MJT.discard(s, seat, s.drawn) : null);
    }, 500);
  }

  /* ---------- 大廳說明 ----------
     ★ 這裡只寫**規則**:玩家要照著做的事。設計理由(為什麼 2~3 人去萬子)、
     實作細節(倒數怎麼藏牌情、台數總和恆為 0)一律不進畫面 —— 那些在 notes/11。 */
  function ruleHint(){
    const el = $("m16RuleHint"); if(!el) return;
    el.innerHTML =
      "<b>台灣 16 張</b>:摸打吃碰槓,湊「5 組面子 + 1 對將」就胡。<br>"+
      "<b>4 人</b>用整副 144 張;<b>2~3 人</b>去掉萬子(108 張)。<br>"+
      "<b>相互算台</b>:自摸三家付、放槍一家付,<b>底 "+baseTai+" 台</b>。<br>"+
      /* 連莊是規則,不是實作細節 —— 它直接改「下一局誰坐莊」與台數(連 N 拉 N),要寫出來。 */
      "莊家胡牌或流局<b>連莊</b>(連 N 拉 N,全桌加台)。<br>"+
      (secOn()
        ? ("每打出一張牌起算 <b>"+claimSec+" 秒</b>,吃碰與接著的出牌共用這段時間;"+
           "沒表態算過,輪到出牌沒動作就摸切。<br>")
        : ("<b>操作倒數關閉中</b>:吃碰與出牌都不限時。"+
           /* ★ 這句不是感想,是規則的後果:關掉之後沒有到期自動過 / 自動摸切,
              有人離開牌桌就真的全桌卡著等。玩家要據此決定要不要設秒數 → 一定要明講。 */
           "<br><span class=\"m16-warn\">⚠ 有人離開牌桌,全桌會一直等他。</span><br>"))+
      "誰在考慮吃碰,其他人看不出來。<br>"+
      "打滿 <b>"+goalLabel(handsGoal)+"</b>後結算,台數最高的人贏。"+
      /* 續局是**規則以外但看得到**的流程改變(打超過 1 局時中間不會回大廳),寫進說明裡 ——
         不然房主會以為「怎麼沒有回到準備畫面」。只打 1 局就不提(它沒有中間局)。
         ⚠ v1.122.0 拿掉了「N 秒後自動」:續局不再倒數,要等全部人都按過(見下面那一整段)。 */
      (handsGoal !== 1
        ? "<br>中間每一局結束<b>不回大廳</b>:結果卡看完按一下「✓ 我看完了」,"+
          "等大家都按了就接著打下一局。"
        : "");
  }

  /* ==========================================================================
     局間續局(v1.103.0,v1.122.0 拿掉自動倒數)—— 使用者:「玩完一局後,不用全部人都要
     再按準備好了,這樣沒有連續感」;後來使用者又說:「勝負畫面不要有倒數,我們就等每個人
     要按繼續下一局才開始」——原本的 15 秒到期自動 readyUp() 是為了「不能讓全房等一個人」,
     現在使用者的選擇是寧可等,所以整個到期動作拿掉,只留純粹的「等大家都按過」。
     ──────────────────────────────────────────────────────────────────────────
     ★ 只有**中間那幾局**續(handsGoal 不是 1 且還沒打滿):
       · 只打 1 局 —— 打完就是整場結束,本來就該回大廳談下一場的設定。
       · 最後一局 —— 結果卡是**總結算**(誰奪冠 / 開新賽季),把人留在那張卡上才對。
     ★ 機制在核心的 contRound 旗標(見 mp-core.js 檔頭):readyUp() 不離開 playing 相位,
       所以**結果卡一路開著到新的一局發牌**,中間不會閃過大廳設定畫面 —— 那個閃動正是
       「沒有連續感」的來源。房主端湊齊就 startGame()。
     ⚠ 沒有到期兜底了:有人放著結果卡不管,全桌就真的一直等 —— 這是使用者明確要的行為,
       不是遺漏(親友聚會現場喊一聲就好,同操作倒數關掉時的那條選擇)。
     ⚠ 腳註**不是**倒數,不需要 timer:「還在等幾個人」靠 outcome() 被反覆呼叫來更新
       (核心的 players 監聽 readyUp() 一寫就會叫),不必自己排 setInterval。
     ========================================================================== */
  let nextKey = "";                 // 這一局要不要顯示續局腳註(outcome() 會被重複呼叫,見那裡)

  /* 這一局結束之後要不要續。三個條件缺一不可:
       · 打超過 1 局(只打 1 局沒有「中間局」)
       · 還沒打滿(最後一局的結果卡是總結算,要把人留在那裡)
       · ⚠ 人還夠開下一局 —— 少了這一條,剩一個人時會停在「大家都看完了…」永遠開不了局
         (房主端 updateStartBtn 有人數門檻,而房主獨自一人的自動回大廳只在**沒有 winner**
         時才動;那時候正好有 winner)。人數不夠就退回原本的「下一局 = 回大廳」。
     ★ outcome() 每次重跑都會重新問一次,所以中途有人離開會自己切回去。 */
  function contOn(){
    return handsGoal !== 1 && seasonRemaining() &&
           Object.keys(ctx.players()).length >= ctx.minPlayers;
  }
  function seenBy(id){ return !!(ctx.players()[id] || {}).ready; }
  function waitCount(){ return Object.keys(ctx.players()).filter(id=>!seenBy(id)).length; }

  function clearNext(){
    nextKey = "";
    const el = $("m16Next"); if(el){ el.classList.add("hidden"); el.innerHTML = ""; }
  }
  /* 腳註那一行。★ 兩種身分要講不同的事(而且是同一行,不要多長一列出來):
       還沒按 —— 提示「按了就會接著打」
       按過了 —— 還在等幾個人(不然按完之後那顆鈕變灰、畫面沒有任何交代) */
  function paintNext(){
    const el = $("m16Next"); if(!el) return;
    if(!nextKey){ el.classList.add("hidden"); el.innerHTML = ""; return; }
    const mine = seenBy(ctx.me());
    const wait = waitCount();
    el.classList.remove("hidden");
    el.innerHTML = mine
      ? (wait > 0 ? "✓ 已看完 —— 還在等 <b>"+wait+"</b> 人…" : "✓ 大家都看完了,馬上開下一局…")
      : "按「✓ 我看完了」,大家都按了就接著打下一局";
    const b = $("mpAgain");
    if(b){
      b.textContent = mine ? "✓ 已看完" : "✓ 我看完了";
      b.classList.toggle("ghost", mine);
      b.classList.toggle("primary", !mine);
      b.disabled = mine;
    }
  }
  /* 結果卡上那顆鈕按下去。回 true = 這一次由續局接手(不要再走核心的「回大廳」)。 */
  function seeDone(){
    if(!nextKey) return false;
    ctx.readyUp();
    paintNext();
    return true;
  }

  return {
    ns:{ rooms:"mj16_rooms", index:"mj16_index" },
    minPlayers:2, maxPlayers:4,
    prefsKey:"mahjong16.prefs.v1",
    emoteAnchor:"m16Stage",
    winCardId:"m16WinCard",
    hasResign:false,
    extraNodes:["tai"],
    /* ★ 局間續局(v1.103.0):打一圈 / 一將的中間局結束**不回大廳**。
       核心那一半見 mp-core.js 的 CONT_ROUND;這一頁的一半在上面那整段 + outcome()。 */
    contRound:true,

    init(c){ ctx = c; },

    /* ---------- 房間設定 ---------- */
    roomFields(){ return { handsGoal:handsGoal, claimSec:claimSec, baseTai:baseTai }; },
    onRoomField(k,v){
      const n = +v;
      if(k==="handsGoal"){
        if(!goalOK(n) || n===handsGoal) return;
        handsGoal = n;
        ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
        return;
      }
      if(k==="claimSec"){
        // 範圍守門而不是白名單:舊房間 / 手改資料庫進來的值也要能用
        if(!secOK(n) || n===claimSec) return;
        claimSec = n;
        ctx.unreadyOnFieldChange(); ctx.syncSetup(); ruleHint();
        return;
      }
      if(k==="baseTai"){
        if(!baseOK(n) || n===baseTai) return;
        baseTai = n;
        ctx.unreadyOnFieldChange(); ctx.syncSetup(); ruleHint();
      }
    },
    readRoom(r){
      if(goalOK(+r.handsGoal)) handsGoal = +r.handsGoal;
      if(r.claimSec!==undefined && secOK(+r.claimSec)) claimSec = +r.claimSec;
      /* ⚠ 舊房間沒有 baseTai → 維持 1 台(= v1.75.14 以前的行為),不要套用新預設值:
         那些人開房時看到的規則說明寫的是「底 1 台」。 */
      if(r.baseTai!==undefined && baseOK(+r.baseTai)) baseTai = +r.baseTai;
      else if(r.baseTai===undefined) baseTai = 1;
    },

    listen(){
      const r = ctx.ref("tai"); if(!r) return;
      r.on("value", s=>{ tai = s.val()||{}; renderHud(); });
    },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame(){ return { wall:null, turn:0, over:null }; },
    resetRound(){ clearClaimT(); clearTurnT(); clearAutoTingT(); stopCd(); st=null; curRound=null; myBid=false; handAt=0; },

    newGame(ids, prev){
      // 座位每局輪換,顏色與莊家才不會永遠同一個人
      let ord;
      if(prev && prev.length===ids.length) ord = prev.slice(1).concat(prev[0]);
      else { ord = ids.slice(); for(let i=ord.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=ord[i]; ord[i]=ord[j]; ord[j]=t; } }

      /* ★ 牌組跟著人數走(2/3 人去萬子)。人數是**開局當下**的 ids.length ——
         中途有人離開不換牌組(換了等於重排整局)。 */
      const n = Math.max(2, Math.min(4, ids.length));
      /* ★★★ 新的一場 = **台數與局數整份歸零**(v1.108.0,檔頭那句「打滿了…開新賽季」
         原本沒有實作)。局數的真相是 `tai._r` 的筆數,而 tai 節點只有在房主離開
         (整間房 remove)時才會消失 —— 所以同一間房打完第二場開始:
           · `handsDone()` 從 4 起跳 → 徽章卡在「第 4/4 局」(第一手就顯示打滿了)
           · `contOn()` 恆 false → **每打完一手就「本場結束」**,續局倒數永遠不出現
         使用者的回報就是這個:「玩了 4 局後又繼續玩 4 局,朋友感覺只玩了兩局,
         程式說 4 局了」。
         ⚠ 判斷式是「這一場打完了沒」(不是 `> 0`):中途有人離開退回大廳、房主再開,
           那是**同一場續打**(局數 / 圈數要接下去),不可以歸零。
         ⚠ 本地的 tai 也要當場清掉 —— remove() 是非同步的,而下面 done 立刻要用。
         ⚠ v1.122.0:「打幾局」可以改成「打幾圈」(handsGoal 為負數)——這裡刻意不叫共用的
           seasonRemaining(),那支看的是 st(上一局的狀態),而 st 這一刻可能已經被
           resetRound() 清掉;圈數只要看 dealerPass(跨局的本機變數)與**這一場**的座位數 n,
           兩者都不必問 st。 */
      let done = handsDone();
      const finished = handsGoal > 0 ? (done >= handsGoal) : (MJT.roundsOf(n, dealerPass) >= -handsGoal);
      if(finished){
        const tr = ctx.ref("tai");
        if(tr) tr.remove();
        tai = {}; done = 0; lastDeal = null; dealerPass = 0; dealerPassRid = null;   // 新的一場:連莊與圈數也跟著歸零
      }
      /* 誰坐莊:連莊(v1.102.0)—— 上一局算出來的那個人,換算成他在**新座位表**的位子。
         ⚠ 找不到人(第一局 / 他離開了 / 房主是這局結束後才進來的)一律退回「局數 % 家數」,
           連莊歸零 —— 寧可不連莊,也不要把莊留在「原座位」上(那個位子已經換人坐了)。 */
      let dealer = done % n, streak = 0;
      if(lastDeal){
        const i = ord.indexOf(lastDeal.id);
        if(i >= 0){ dealer = i; streak = lastDeal.streak; }
      }
      const s = MJT.newRound({
        rs: "p"+n,
        dealer: dealer,
        dealerStreak: streak,
        // 圈風跟著「打完幾圈」走(v1.122.0),不再永遠是東(見 dealerPass 的檔頭註解)
        roundWind: MJT.windOfRounds(MJT.roundsOf(n, dealerPass)),
        handNo: done+1,
        base: baseTai
      });
      return Object.assign({ order:ord }, MJT.enc(s));
    },

    applyGame(g, playing){
      if(!playing && !ctx.winner()) return;
      const s = MJT.dec(g);
      if(!s) return;
      const rid = ctx.roundId();
      const newRnd = (rid !== curRound);
      /* ⚠ resetFit() 只掛在**換局**這一格(v1.70.1):牌寬重新量一次。
         其他路徑(吃碰成立 / 我表態完 / 結算)只清選取,不可以放掉地板 ——
         那會讓整副牌在一局裡忽大忽小(理由見 board.js 檔頭⑤)。
         ⚠ resetOrder()(玩家拖出來的手牌順序,v1.82.0)吃**同一格**、同一個理由:
           其他路徑清掉的話,每碰一次手牌就被打散一次。 */
      if(newRnd){ curRound = rid; myBid = false; M16B.clearSel(); M16B.resetFit(); M16B.resetOrder(); }

      const before = st;
      st = s;
      /* 續局的倒數只在「這一局結束了」的狀態下才有意義 —— 收到一份沒有 over 的新狀態
         (換局 / 上一局被整包覆寫 / 斷線重連補齊)就一定要收掉,不然計時器會活著跑到
         下一局中間才開火(把人標成準備好)。⚠ enterPlaying 也清一次,兩邊都要:
         這一條擋的是「winner 被清掉但 roundId 沒變」那種不會走 enterPlaying 的路徑。 */
      if(!s.over) clearNext();
      /* ★ v1.65.0:「這一手」的錨點。整份操作倒數(宣告 + 出牌)都從這裡起算,所以
         **從有人打出一張牌到下一張牌落桌,總長度固定** —— 中間有沒有人在考慮吃碰,
         在時間上完全反映不出來(見檔頭與 isNewHand)。
         ⚠ 換局 / 斷線重連(before 為 null)一律重新起算:整包重發,diff 出來的東西沒有意義。
           重連的那台錨點會比別人晚 → 它的 timer 也比較晚響,由先響的那台結算,安全。 */
      if(newRnd || isNewHand(before, s)) handAt = performance.now();
      /* 摸打吃碰槓胡的音效。★ 與單機**共用同一份判斷**(js/mahjong16/sfx.js):兩邊的動作
         路徑完全不同(這裡要等交易回來才換手),但「有人碰了」是同一個 state diff,所以
         音效沒有變成第三份「兩份」。
         ⚠ 換局那一手不比 —— 整包重發,逐欄位 diff 出來的東西沒有意義(會在開局瞬間響一串
           吃碰槓);斷線重連時 before 是 null,sfx 自己也會擋掉。 */
      const ev = newRnd ? [] : (M16Sfx.play(before, s, mySeat()) || []);
      if(ev.indexOf("draw") >= 0) buzzTurn();
      /* 宣告視窗換了一輪 → 我的表態記號要清掉。
         ⚠ 兩個旗標一起清(見 sendBid 與 board.js 的 bidDone):只清 myBid 的話
           下一輪宣告的牌不會站起來(bidDone 卡在 true → claimOpts() 回空)。 */
      if(!before || !before.claim || !s.claim ||
         before.claim.t!==s.claim.t || before.claim.from!==s.claim.from){
        myBid = false; M16B.setBidDone(false);
      }

      M16B.render(st, Math.max(0, mySeat()));
      renderHud(); renderActs(); ctx.updateGoal();

      /* 兩種倒數各自 arm(不會同時:有宣告視窗時沒有人在出牌) */
      if(s.claim && !s.over){ clearTurnT(); armClaimT(); }
      else { clearClaimT(); armTurnT(); }
      armAutoTing();      // 聽牌後自動摸切(個人偏好,獨立於上面兩顆房間倒數,見那支的檔頭註解)

      // 一局結束 → 記台數(交易冪等,誰先到誰寫)
      if(s.over && rid){
        const d = (s.over.type==="win") ? s.over.deltas : new Array(s.seats).fill(0);
        commitTai(rid, d);
        /* 連莊:把「下一局誰坐莊」換算成玩家 id 記下來(v1.102.0)。
           ⚠ 這裡的 ctx.order() 還是**這一局**的座位表 —— 新的一局要等房主寫進 game
             節點才會換,所以這一刻換算才對得上。重算幾次都是同一個答案(冪等)。 */
        const nx = MJT.nextDealerOf(s);
        const nid = nx ? idOfSeat(nx.dealer) : "";
        if(nid){
          // 這一局(rid)算過圈數了就不再算第二次(重連補送同一份 over 快照時擋下來)
          if(dealerPassRid !== rid){
            dealerPassRid = rid;
            if(nx.streak === 0) dealerPass++;   // 真的換人才算一次「過位」(v1.122.0,圈數的量尺)
          }
          lastDeal = { id:nid, streak:nx.streak };
        }
      }
    },

    /* ---------- 相位 ---------- */
    openConnect(){ showScreen("connect"); },
    enterLobby(){ showScreen("lobby"); $("mpBar").classList.remove("playing"); ruleHint(); },
    backToLobby(){
      showScreen("lobby"); $("mpBar").classList.remove("playing");
      clearClaimT(); clearTurnT(); clearAutoTingT(); clearNext(); st=null; curRound=null; myBid=false; handAt=0;
      wipeActs();
      ctx.renderPlayers();               // 台數在晶片上,回大廳要重畫(st 已清掉,風會收起來)
      ruleHint();
    },
    enterPlaying(){
      showScreen("play");
      $("mpBar").classList.add("playing");
      /* ★ 續局時這支是**上一局的結果卡收掉、新的一局發牌**的那一刻(核心已經 closeWin)——
         倒數與腳註一定要在這裡收乾淨,不然計時器會活到下一局的中間再開一次火。 */
      clearNext();
      Sound.start();
      // ★ 這一局開打前大家各幾勝(排名表的「N 勝」欄要拿它 +1;見宣告處)
      baseWins = {}; lastGained = [];
      ctx.order().forEach(id => { baseWins[id] = ctx.scoreOf(id); });
      M16Sfx.preload();          // 喊牌音檔先載好,第一次碰才有聲音(見 sfx.js 的 preload)
    },
    onLeave(){
      clearClaimT(); clearTurnT(); clearAutoTingT(); clearNext();
      st=null; curRound=null; tai={}; myBid=false; handAt=0;
      // 離房:連莊與圈數記錄跟著清(換房間就是新牌局)
      baseWins = {}; lastGained = []; lastDeal = null; dealerPass = 0; dealerPassRid = null;
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
      if(L2) L2.textContent = isHost ? "操作倒數" : "操作倒數(房主決定)";
      const seg3 = $("m16BaseSeg");
      if(seg3){
        seg3.classList.toggle("readonly", !isHost);
        [...seg3.children].forEach(b=>b.classList.toggle("on", +b.dataset.base===baseTai));
      }
      const L3 = $("m16BaseLabel");
      if(L3) L3.textContent = isHost ? "底幾台" : "底幾台(房主決定)";
      ruleHint();
    },
    /* 房間框那顆徽章(麥克風左邊)。
       ★ v1.58.3:對戰中改成「第 n/N 局」—— 使用者的話是「原來那裡寫 4 局之類的內容,
         我覺得沒什麼意義,就換成第多局的內容」。大廳還是只寫目標(還沒開始打,
         沒有「第幾局/第幾圈」可言,而且那裡正是房主在設定的那個數字)。
       ⚠ 進度來自 tai._r 的筆數,而 tai 一變就會 renderPlayers() → updateGoal(),
         所以這裡不必自己訂閱;applyGame() 也補叫一次(同一局內換手也要更新)。
       ★ v1.122.0:handsGoal 可能是負數(打幾圈),對戰中要換成「圈風 · 第幾圈」——
         見 goalBadgeText() / goalLabel() 的檔頭。 */
    updateGoal(){
      const g = $("mpBarGoal"); if(!g) return;
      g.textContent = "🀄 " + (ctx.phase()==="playing" ? goalBadgeText() : goalLabel(handsGoal));
      g.classList.remove("hidden");
    },

    /* 輪到誰:核心會把 .turn 打在晶片上(底色 + 脈動 + 放大),四個遊戲同一套。
       ⚠ 消消樂不需要實作這支(它沒有回合),真麻將有,一定要給。 */
    // ★ dispTurn() 而不是 st.turn:宣告視窗中晶片不可以還亮在出牌者身上(見 dispTurn 的註解)
    turnId(){ return (st && !st.over) ? idOfSeat(dispTurn()) : null; },
    /* 晶片前綴:座位色點 + 門風 +(是莊的話)莊。
       ★ 莊家記號 v1.58.3 從盤面頂端那條資訊列搬過來 —— 盤面上是掛在每一家自己那一列
         (board.js 的 foeHTML),我自己那一家沒有「一列」,就靠這裡。 */
    chipLead(id){
      const s = seatOf(id);
      if(s<0) return null;
      const wind = st ? MJFace.info(MJ16.codeOf(MJT.seatWind(s, st.dealer, st.seats))).glyph : "";
      return '<span class="m16-seat '+colorOf(s)+'"></span>'+
             (wind?'<span class="m16-cw">'+wind+'</span>':'')+
             // ★ 連莊記號跟著莊家記號走(v1.108.0),三個地方共用 M16B.lianHTML()
             (st && s===st.dealer ? '<span class="m16-dz">莊</span>' + M16B.lianHTML(st.dealerStreak) : '');
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
    outcome(w, { iWon, isDraw, mine, ids }){
      clearClaimT(); clearTurnT(); clearAutoTingT();
      M16B.clearSel();
      renderHud(); renderActs();
      // 得分名單直接用核心給的 ids(它就是等一下要 +1 的那些人)—— 排名表的「N 勝」欄要
      lastGained = ids || [];
      const last = !seasonRemaining();
      paintTaiTable(last);

      /* 局間續局(見上面那一整段)。★ 腳註**每一次都要重畫** ——
         outcome() 會被反覆呼叫(核心的 players / scores 監聽一動就 showOutcome()),
         而「還在等 N 人」正是靠那幾次重畫才會跟著別人按鈕動。
         ⚠ 鑰匙用 roundId:用 `first` 那個旗標的話,重連 / 重畫時腳註認不出「這是新的一局」。 */
      if(contOn()){
        nextKey = curRound || "-";
        paintNext();
      }else{
        // 最後一局(或只打一局):回到原本的「下一局 = 回大廳重新準備」
        clearNext();
        const b = $("mpAgain");
        if(b){ b.textContent = "下一局 ▸"; b.disabled = false;
               b.classList.add("primary"); b.classList.remove("ghost"); }
      }

      /* 大字:四種輸法分開講(v1.70.0)。文案表與挑選規則在 M16B.overWord() —— 單機那份
         叫的是同一支,所以這裡**不再是「兩份要一起改」**的其中一份。
         ★ 卡片配色順手覆寫:核心只知道「贏 / 沒贏」,而「別人放槍給別人胡」我一毛都不用付,
           掛 lose 的紅字看起來像我賠了。核心是在呼叫這支之前掛的,覆寫得掉。 */
      const ow = M16B.overWord(st && st.over, mySeat());
      const card = $("m16WinCard");
      if(card){ card.classList.remove("win","lose","draw"); card.classList.add(ow.tone); }

      /* ⚠ 句尾不要放 Unicode 麻將字元 —— 理由與 solo.js 那份同一條(U+1F02B 會畫成空心
         方框,看起來就是豆腐)。msg 這一半仍然是兩份,改一邊一定要改另一邊。 */
      /* ★ 「誰奪冠」要**接在大字下面第一行**(v1.75.15,使用者:「本場結束的下一行
         應該要接誰奪冠」)—— 大字寫「本場結束」而下一行卻在講這一手怎麼胡的,
         最重要的那件事被擠到第三行去了。 */
      if(!st || !st.over || st.over.type==="draw")
        return { word: last ? "本場結束" : ow.word,
                 msg: (last ? seasonMsg()+"<br>" : "") + "牌山見底,這一局不收付" };

      const o = st.over;
      const tag = o.list.map(x=>esc(x.name)+" "+x.tai).join("、");
      const how = (o.from===null) ? "自摸" : ("胡 "+esc(nameOfSeat(o.from))+" 打的牌");
      /* ★ v1.75.14 併成**一行**(原本是「誰怎麼胡」+「底台算式」兩行)。
         「誰胡了誰放槍」下面那張排名表已經逐列寫著(這局 · 自摸 / 放槍 −6),
         再用兩行散文講一次正是使用者說的「要再想一會」——同一件事講三次最難讀
         (排七 v1.75.3 的同一條結論)。留下來的是表上沒有的那一半:台數怎麼來的。
         ⚠ msg 這一半仍然是兩份(solo.js 的 paintResult),改一邊一定要改另一邊。 */
      const line = (iWon ? how : (esc(w.name||"對手")+" "+how)) +
                   " · 底 "+o.base+" + 台 "+o.tai+" = <b>"+o.total+"</b> 台("+(tag||"無台")+")";
      /* ★ 最後一局仍是「本場結束」(與單機同步):那張卡的主角是總結算,
         所以「誰奪冠」排在這一手的細節**前面**(見上面那條)。 */
      return { word: last?"本場結束":ow.word, msg: (last?seasonMsg()+"<br>":"")+line };
    },

    ownPrefs(){ return { handsGoal:handsGoal, claimSec:claimSec, baseTai:baseTai,
                         voice:M16Sfx.voiceOn(), tileVoice:M16Sfx.tileMode(),
                         autoTing:M16B.autoTingOn() }; },
    usePrefs(o){
      if(goalOK(+o.handsGoal)) handsGoal = +o.handsGoal;
      /* ⚠ 這裡要 snapSec():v1.103.0 換掉整組秒數之後,舊玩家偏好裡的 8 / 12 / 20
         沒有對應的按鈕 —— 不吸附的話他開房時段落列一顆都不亮,而且永遠拿不到新預設。
         (別人房間送來的值走 readRoom,那邊刻意**不**吸附:那是房主的設定。) */
      if(o.claimSec!==undefined && secOK(+o.claimSec)) claimSec = snapSec(+o.claimSec);
      /* ⚠ 舊偏好沒有 baseTai → 用**新預設值 2**(這裡與 readRoom 相反:那邊是別人已經
         開好的房間,規則說明寫的是舊的;這裡是我自己下次開房要用的值)。 */
      if(o.baseTai!==undefined && baseOK(+o.baseTai)) baseTai = +o.baseTai;
      /* 喊牌語音預設**開**:舊偏好裡沒有這個欄位(undefined),要當成開,
         寫成 `=== true` 的話所有老玩家升上來都會是關的,而他們根本不知道有這個開關。 */
      const call = o.voice !== false;
      M16Sfx.setVoice(call);
      /* 報牌名的範圍(v1.72.0 拆出來的第二列)。⚠ 舊偏好沒有 tileVoice,而 fallback **不能**
         一律給預設值:
           · v1.71.0 的人 —— 那時牌名與喊牌是**同一顆開關**,所以「把喊牌關掉」的人升上來
             必須連牌名一起關,否則升級之後反而多出聲音,而他翻設定只會看到喊牌是關的。
           · 更早的人 —— voice 也讀不到 → call 為 true → 拿到 honor,剛好等於 v1.71.0 的行為。
         ⚠ 這裡不會觸發音檔預載(sfx 的 setTileMode 只在已預載過時才補),啟動時沒有手勢。 */
      M16Sfx.setTileMode(o.tileVoice || (call ? "honor" : "off"));
      /* ⚠ 舊偏好裡殘留的 `ready`(v1.66.0 的聽牌提醒)與 `hint`(v1.66.0~v1.67.2 的
         聽牌提示)沒有人讀了 —— 兩顆開關都已經拿掉,讀不到就忽略,無害。 */
      // 聽牌後自動摸切(v1.119.0):舊偏好沒有這欄 → undefined → 預設**關**,不是新功能就自己幫人開了。
      M16B.setAutoTing(!!o.autoTing);
    },

    api:{
      onDiscard(t){ doAct(s=>MJT.discard(s, mySeat(), t)); },
      onTing,                                  // 宣告聽牌 + 打出那一張(v1.67.0)
      setGoal(v){
        v = +v; if(!goalOK(v)) return;
        if(!ctx.setRoomField("handsGoal", v, { lobbyOnly:true, denyMsg:"只有房主能改局數", busyMsg:"對戰中不能改局數" })) return;
        handsGoal = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      },
      /* 操作倒數幾秒(0 = 關)。同時管吃碰與出牌兩種倒數。
         lobbyOnly:對戰中改會讓「誰的 timer 先響」在同一手裡不一致,
         而且改設定本來就該回大廳談(同局數)。 */
      setSec(v){
        v = +v; if(!secOK(v)) return;
        if(!ctx.setRoomField("claimSec", v, { lobbyOnly:true, denyMsg:"只有房主能改操作倒數", busyMsg:"對戰中不能改操作倒數" })) return;
        claimSec = v; ctx.syncSetup(); savePrefs();
      },
      /* 底幾台。lobbyOnly:底台是開局時寫進 st.base 的,對局中改只會讓下一局變、
         而畫面上的規則說明先變 —— 看起來像這一局的收付算錯了。 */
      setBase(v){
        v = +v; if(!baseOK(v)) return;
        if(!ctx.setRoomField("baseTai", v, { lobbyOnly:true, denyMsg:"只有房主能改底台", busyMsg:"對戰中不能改底台" })) return;
        baseTai = v; ctx.syncSetup(); savePrefs();
      },
      /* 結果卡那顆鈕:續局中是「我看完了」(回 true),最後一局才是原本的「下一局」。
         ⚠ 判斷放在這裡而不是 main.js —— 「這一局是不是最後一局」只有 adapter 知道。 */
      seeDone,
      taiOf, handsDone, goal:()=>handsGoal, sec:()=>claimSec, base:()=>baseTai,
      state:()=>st, seat:mySeat,
      // 盤面切換「要吃哪一組」之後,✔ 按鈕上的字要跟著換 → 回頭叫這支重畫動作列
      refreshActs: renderActs,
      // 設定面板剛把「聽牌後自動摸切」打開那一刻,順手踢一次(不必等下一手才生效)
      kickAutoTing: armAutoTing,
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
        · 牌山還剩幾張   → 當時刪掉(理由:「玩的人不看;真要看,流局本身就是提示」)
                           ⚠ **v1.104.0 推翻了這一條**:上手回報「我想知道還剩幾張牌,
                           不然突然間就說流局,有點奇怪」—— 流局沒有預告才是真正的問題。
                           它現在回到**盤面**(牌河右上角的 .m16-wall 覆蓋層,單機連線
                           共用一份),而不是回到這條資訊列:覆蓋層不佔高度,
                           資訊列會讓整副牌小一級。見 board.js 的 wallHTML()。
        · 第 n / N 局    → 搬到房間框的 #mpBarGoal(麥克風左邊,見 updateGoal)
        · 莊 某某        → 搬到每一家自己那一列 / 玩家晶片(board.foeHTML + chipLead)) */

  /* (v1.75.15:結果卡的 paintWinTiles() 整支拿掉 —— 攤牌改在牌桌上、而且每一家都攤,
      見 board.js 的 foeHTML。同一件事不要在兩個地方各畫一次。) */

  /* ---------- 結果卡的排名表(v1.75.14 起是「一張表」) ----------
     版面與四個病灶見 board.js 的 rankHTML —— 這裡只負責把資料湊齊:
       · 累積台數 = tai 節點 +(這一局還沒記進去的話)這一局的增減 → 沒有時間差
       · 這一局的增減直接用 st.over.deltas(權威,不必等任何節點)
       · 勝場 = 開局快照 baseWins + 核心給的得分名單 */
  function paintTaiTable(final){
    const box = $("m16Tai"); if(!box) return;
    const ord = ctx.order();
    if(!ord.length){ box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const over = (st && st.over) || null;
    const dz = (over && over.type==="win" && over.deltas) || null;
    const counted = taiCounted();
    const names = ord.map(id=>ctx.dispName(id));
    const me = ctx.me();
    const rows = ord.map((id, s)=>{
      const d = dz ? (dz[s]||0) : 0;
      const plus = lastGained.indexOf(id) >= 0;
      const base = (typeof baseWins[id]==="number") ? baseWins[id] : ctx.scoreOf(id);
      return { name:names[s], me:id===me,
               total: taiOf(id) + (counted ? 0 : d),
               delta: d,
               role: M16B.roleOf(over, s),
               wins: { n: base + (plus?1:0), plus: plus } };
    });
    box.innerHTML = M16B.rankHTML(rows, { progressText:goalProgressText(), finalText:goalFinalText(), final:final });
  }
  /* 排名表表頭文案(v1.122.0)。局數版與圈數版共用同一支,呼叫端不必先問清楚是哪一種。 */
  function goalProgressText(){
    if(handsGoal > 0) return "第 " + handsDoneNow() + " / " + handsGoal + " 局結束";
    const w = st ? face(st.roundWind).name : "東";
    return w + "圈 · 已完成 " + roundsDoneNow() + " / " + (-handsGoal) + " 圈";
  }
  function goalFinalText(){ return goalLabel(handsGoal) + "打完"; }
  function seasonMsg(){
    const ord = ctx.order();
    if(!ord.length) return "";
    let best = -Infinity, who = [];
    ord.forEach(id=>{ const t=taiOf(id); if(t>best){ best=t; who=[id]; } else if(t===best) who.push(id); });
    return '<span class="m16-champline">🏆 '+who.map(id=>esc(ctx.dispName(id))).join("、")+
           " 以 "+best+" 台奪冠</span>";
  }
})());

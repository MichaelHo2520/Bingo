"use strict";

/* ============================================================================
   大老二 — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 B2B、同一條動作列 #b2Acts、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on / b2-mp 兩個 class 切換(與其他六個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const B2_SCREENS = ["b2Home", "b2Setup", "b2SoloBar", "b2Play"];
function showScreen(which){
  const on = {
    home:    ["b2Home"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["b2Setup"],
    play:    ["b2Play"],                // 連線對戰中
    solo:    ["b2SoloBar", "b2Play"]    // 電腦對決
  }[which] || [];
  B2_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which==="home" || which==="solo"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which==="solo");
  // b2-mp / b2-solo:對局中才把牌桌放寬(大廳與選單維持 .panel 原本的 520,
  // 不然會變成「一塊寬一塊窄」)。同排七 / 台灣麻將。
  document.body.classList.toggle("b2-mp", which==="play");
  document.body.classList.toggle("b2-solo", which==="solo");
  /* 對局中 ⛶/⚙️ 該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**
     (v1.75.10 立的規矩)。這一頁橫置手機會收頂列(styles.css 的
     `(orientation:landscape) and (max-height:560px) and (pointer:coarse)`),
     那時 dockTools 會自動把兩顆鈕搬進房間框那一列;直向 / 桌機則留在頂列。
     ⚠ 兩種情形都不必也不可以在這裡判斷,條件只准有一份(就在 dockTools 裡面)。 */
  if(which==="play") dockTools("mpBar");
  else if(which==="solo") dockTools("b2SoloBar");
  else undockTools();
  /* 大牌桌:每次換畫面都**無條件**重套一次(v1.178.3,見 ui-kit 的 BigMode)。
     進牌桌把偏好記著的狀態套回來、離開牌桌把 body 上的 class 脫掉 —— 那個 class 會收掉
     整條頂列(⛶ / ⚙️ 都在裡面),而兩顆鈕住在房間框 / 單機列裡,留著就再也關不回來。
     ⚠ 守衛在 BigMode 自己,這裡不要再判斷一次 which;⚠ 一定要排在 dockTools() 之後。 */
  BigMode.sync();
  if(which==="home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數。與排七 / 台灣麻將同一個模式。
   回 index.html 的返回列只在第一層顯示:第二層有自己的返回,兩顆並存會分不清誰是誰。 */
function showHomeLayer(which){
  const pick=$("b2PickMode"), solo=$("b2PickSolo"), head=$("b2HomeHead");
  if(pick) pick.classList.toggle("hidden", which!=="pick");
  if(solo) solo.classList.toggle("hidden", which!=="solo");
  if(head) head.classList.toggle("hidden", which!=="pick");
  syncPageBack();   // 同上:第二層按返回要退回第一層,不是離開這一頁
}
/* 第二層的說明:難度文案直接讀 B2AI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el=$("b2SoloHint"); if(!el) return;
  const L = B2AI.levelOf(Solo.level());
  const n = Solo.seats();
  const cnt = B2.dealCounts(n);
  const even = cnt[0] === cnt[n-1];
  el.innerHTML = "<b>"+L.emoji+" "+L.name+"</b>:"+esc(L.desc)+"<br>"+
    "一人 "+(even ? ("<b>"+cnt[0]+" 張</b>") : ("<b>"+cnt[0]+"</b> 或 <b>"+cnt[n-1]+"</b> 張(52 除不盡,前面的座位多一張)"))+
    " · 你固定坐第一位,先出的是拿到 ♣︎3 的人。<br>"+
    "名次分 "+(n===4 ? "<b>5 / 3 / 1 / 0</b>" : (n===3 ? "<b>5 / 3 / 0</b>" : "<b>5 / 0</b>"))+
    "(最後一名固定 0 分)。<br>"+
    /* ★★ v1.100.0:順子大小是房規 → 第二層一定要講**現在設的是哪一種**
       (單機的房規存在自己的偏好裡,跨場黏著 —— 不寫出來會忘記上次改過)。 */
    "<b>"+esc(b2RulesText(Solo.rules()))+"</b>(按上面「📋 改規則」可換)。<br>"+
    // ⚠ 圖示一律 🎴(U+1F3B4);小丑牌那顆是 U+1F0CF,落在被禁的區段(見 solo.js 那條註解)
    "<span class=\"b2-warn\">🎴 "+esc(Solo.recLine(Solo.level()))+"</span>";
}
/* ==========================================================================
   ★★★ 房規面板(v1.100.0)—— 單機與連線**共用這一支**
   ──────────────────────────────────────────────────────────────────────────
     使用者:「我也希望能像21點那樣,建立一些遊戲規則,像是 A2345 跟 10JQKA 到底誰在大,
              原本放在外面的規則,也可以放進去」

     結構逐字照21點 v1.85.0(`js/blackjack/main.js` 那一段):
       · 面板本體是一個蓋板 #b2RulesVeil,單機第二層與大廳各一顆鈕打開它
       · 每一列是 .seg,按鈕帶 data-rk(哪一項)/ data-rv(值)
       · 分流點**只有下面三支**(b2Editable / b2RulesNow / b2SetRule)
     ⚠ 不能改的時候給 .readonly(只是不亮)—— **不用 disabled**:
       CLAUDE.md 的紅線是「不用 disabled 讓點擊靜默消失」,訪客按下去要看得到
       「只有房主能改規則」(擋在 MP.setRule / Solo 那一側,不是擋在 CSS)。
   ========================================================================== */
/* 兩項房規的值都是**字串** —— ⚠ dataset 永遠是字串,所以這裡不做轉型
   (21點那邊要 BJ_BOOLS / BJ_STRS 兩張表就是因為它混了布林與數字)。 */
function b2RuleVal(raw){ return String(raw); }
/* 「順子誰大」那一句 */
function b2StrText(rr){
  return rr.str === B2.STR_LO
    ? "順子:2-3-4-5-6 最大,A-2-3-4-5 最小(A 當 1)"
    : "順子:2-3-4-5-6 最大,接著 A-2-3-4-5,再來 10-J-Q-K-A";
}
/* 「什麼時候結算」那一句(v2.5.0)*/
function b2EndText(rr){
  return rr.end === B2.END_FIRST
    ? "結算:第一個出完就結束(其他人照剩牌排名次)"
    : "結算:打到只剩一家有牌";
}
/* 一句話講「現在是什麼規則」——★ 面板底部 / 大廳摘要 / adapter 的 ruleHint()
   **三處共用這一支**(多一份就會走鐘 —— v1.100.0 立的規矩)。
   ⚠ v2.5.0 起它是**兩句**:新增房規項目時要把那一項也接進來,
     不然面板改得動、摘要卻永遠只講順子。 */
function b2RulesText(r){
  const rr = B2.normRules(r);
  return b2StrText(rr) + " · " + b2EndText(rr);
}
function syncRules(rules, editable){
  const r = B2.normRules(rules);
  document.querySelectorAll("#b2RulesBody .seg").forEach(seg => {
    seg.classList.toggle("readonly", !editable);
    [...seg.children].forEach(b => {
      const k = b.dataset.rk;
      if(!k) return;
      b.classList.toggle("on", b2RuleVal(b.dataset.rv) === r[k]);
    });
  });
  /* ★ 出牌倒數那一組**只有連線才有**(單機沒有倒數 —— 卡多久是自己的節奏)。
     ⚠ 它不在 rules 物件裡:那個房間欄位早就在用,而且它不影響任何判定。 */
  const secG = $("b2SecGroup");
  if(secG){
    const on = MP.isOnline();
    secG.classList.toggle("hidden", !on);
    if(on){
      const seg = $("b2SecSeg2");
      if(seg){
        seg.classList.toggle("readonly", !editable);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === MP.turnSec()));
      }
    }
  }
  const who = $("b2RulesWho");
  if(who) who.textContent = editable ? "你是房主,規則由你決定" : "規則由房主決定(對戰中不能改)";
  const sum = $("b2RulesSum");
  if(sum) sum.textContent = b2RulesText(r);
}
/* 現在該對誰設定 —— 單機改 Solo 的、連線改房間的(★ 唯一的分流點就這三支) */
function b2Editable(){ return !MP.isOnline() || MP.amHost(); }
function b2RulesNow(){ return MP.isOnline() ? MP.rules() : Solo.rules(); }
function b2SetRule(key, val){
  if(MP.isOnline()){ MP.setRule(key, val); syncRules(b2RulesNow(), b2Editable()); return; }
  if(Solo.playing()){ showToast("對局中不能改規則 —— 這一場的規則已經定下來了", 2400); return; }
  Solo.setRule(key, val);
  syncRules(Solo.rules(), true);
  paintSoloHint();
}
function openRules(){
  syncRules(b2RulesNow(), b2Editable());
  $("b2RulesVeil").classList.add("show");
}
function closeRules(){
  $("b2RulesVeil").classList.remove("show");
  /* 關掉之後把摘要重畫一次(大廳那行 / 單機第二層那段各一份文案,但**同一支** b2RulesText)。 */
  if(MP.isOnline()){
    const hint = $("b2RuleHint");
    if(hint) hint.textContent = b2RulesText(MP.rules());
  }else paintSoloHint();
}

/* 選擇列共用的「點一下亮起來」 */
function segPick(id, attr, fn){
  const seg = $(id); if(!seg) return;
  seg.addEventListener("click", e=>{
    const b = e.target.closest("button"); if(!b) return;
    fn(b.dataset[attr]);
    [...seg.children].forEach(x=>x.classList.toggle("on", x===b));
    paintSoloHint();
  });
}
function syncSoloSeg(){
  const set = (id, attr, val)=>{
    const seg=$(id); if(!seg) return;
    [...seg.children].forEach(b=>b.classList.toggle("on", String(b.dataset[attr])===String(val)));
  };
  set("b2LvSeg","lv",Solo.level());
  set("b2SeatSeg","seats",Solo.seats());
}

/* ---------- 盤面 ----------
   ★ 兩個回呼都要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(見 board.js 檔頭),
     漏掉分流的症狀是「單機點牌沒反應」或「連線點牌走到單機那條路」。 */
B2B.mount({
  onCard(c){ if(Solo.active()) Solo.tap(c); else MP.tap(c); },
  onAct(a){ if(Solo.active()) Solo.act(a); else MP.act(a); }
});

/* ---------- 進場選單 ---------- */
$("b2GoOnline").addEventListener("click",()=>MP.openConnect());
$("b2GoSolo").addEventListener("click",()=>{ paintSoloHint(); showHomeLayer("solo"); });
$("b2SoloCfgBack").addEventListener("click",()=>showHomeLayer("pick"));
segPick("b2LvSeg","lv",v=>Solo.setLevel(v));
segPick("b2SeatSeg","seats",v=>Solo.setSeats(+v));
$("b2StartSolo").addEventListener("click",()=>Solo.start());
/* ★ 房規:單機第二層那顆鈕(面板本體與連線共用,見上面那一段) */
$("b2SoloRules").addEventListener("click",openRules);

/* ---------- 單機的牌桌列 / 結果卡 ---------- */
$("b2SoloExit").addEventListener("click",()=>Solo.quit());
$("b2SoloAgain").addEventListener("click",()=>Solo.again());
$("b2SoloHome").addEventListener("click",()=>Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("b2SecSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setTurnSec(+b.dataset.sec); });
/* ---------- ★★★ 房規面板(一組 DOM,兩個入口)----------
   ⚠ 監聽綁在 #b2RulesBody 上**一次**(委派):那一排「點名」式的鈕沒有,
     但兩顆順子鈕是寫死在 HTML 裡的 —— 委派仍然比逐顆綁安全(以後加項目不必改這裡)。 */
$("b2RulesOpen").addEventListener("click",openRules);
$("b2RulesClose").addEventListener("click",closeRules);
$("b2RulesVeil").addEventListener("click",e=>{ if(e.target.id==="b2RulesVeil") closeRules(); });
$("b2RulesBody").addEventListener("click",e=>{
  const b=e.target.closest("button[data-rk]");
  if(b){ b2SetRule(b.dataset.rk, b2RuleVal(b.dataset.rv)); return; }
  /* 出牌倒數那一組走既有的房間欄位(不是房規物件)——⚠ 兩處入口寫同一支 MP.setTurnSec */
  const s=e.target.closest("#b2SecSeg2 button");
  if(s){ MP.setTurnSec(+s.dataset.sec); syncRules(b2RulesNow(), b2Editable()); }
});
$("scoreSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setScoreMode(b.dataset.score); });
$("wgMinus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()-1));
$("wgPlus").addEventListener("click",()=>MP.setWinGoal(MP.winGoal()+1));
$("resetScoreBtn").addEventListener("click",()=>MP.resetScores());

/* ---------- 連線 / 房間 ---------- */
$("mpCreate").addEventListener("click",()=>MP.create($("mpName").value,$("mpRoomName").value));
$("mpScan").addEventListener("click",()=>MP.scanRooms());
$("mpName").addEventListener("change",savePrefs);
$("mpName").addEventListener("input",()=>$("mpName").classList.remove("needs-name"));
$("mpRoomName").addEventListener("keydown",e=>{ if(e.key==="Enter")MP.create($("mpName").value,$("mpRoomName").value); });
$("mpReadyBtn").addEventListener("click",()=>MP.toggleReady());
$("mpLeaveBtn").addEventListener("click",()=>MP.askLeave());
$("mpConnBack").addEventListener("click",()=>showScreen("home"));
$("leaveConfirm").addEventListener("click",()=>MP.confirmLeave());
$("leaveCancel").addEventListener("click",()=>MP.cancelLeave());
$("leaveVeil").addEventListener("click",e=>{ if(e.target===$("leaveVeil"))MP.cancelLeave(); });
$("kickConfirm").addEventListener("click",()=>MP.confirmKick());
$("kickCancel").addEventListener("click",()=>MP.cancelKick());
$("kickVeil").addEventListener("click",e=>{ if(e.target===$("kickVeil"))MP.cancelKick(); });

/* ---------- 結果卡 ---------- */
$("mpAgain").addEventListener("click",()=>MP.again());
$("mpLeaveWin").addEventListener("click",()=>MP.askLeave());
$("mpNewSeason").addEventListener("click",()=>{ MP.resetScores(); MP.again(); });
$("winPeek").addEventListener("click",peekBoard);
$("reopenWin").addEventListener("click",showResult);
// 賽後表情列:四顆一鍵送給全部人(結果卡不關,對方也看得到飛出來的表情),😀 開完整面板。
// 節流 600ms:結果卡是強制回應視窗,手指停在上面很容易連點狂送。
let reactAt=0;
$("b2ReactRow").addEventListener("click",e=>{
  const b=e.target.closest("button"); if(!b)return;
  if(b.id==="winEmoteBtn"){ openEmote("all"); return; }
  const em=b.dataset.em; if(!em)return;
  const now=performance.now();
  if(now-reactAt<600)return;
  reactAt=now;
  markAudioArmed(); Sound.wake();
  MP.sendEmote("all",em);
  b.classList.remove("sent"); void b.offsetWidth; b.classList.add("sent");
});

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({sub:"b2PickSolo"});
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整局丟掉)
initUpdateCheck(()=>!MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大牌桌(v1.178.3):⚠ 一定要排在 loadPrefs() **之前** —— 偏好會回頭叫 BigMode.set()。 */
BigMode.init({
  cls:"b2-big", btn:"b2-bigbtn", name:"大牌桌",
  live:()=>{ const el=$("b2Play"); return !!el && !el.classList.contains("hidden"); },
  save:savePrefs
});
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ 大老二的連線偏好
Solo.loadOwn();    // 電腦對決的難度 / 人數 / 戰績(獨立 key,不與連線那組互相覆蓋)
syncSettingsUI();
syncSoloSeg();
paintSoloHint();
showScreen("home");      // 進場先選玩法
autoJoinFromQuery(MP);   // 從主選單的「現在有人在玩」點過來(?join=1234)→ 直接進那間房
// iOS 的「加入主畫面」引導。延遲一下再彈:讓畫面先畫完,一進站就跳太突兀
setTimeout(maybeShowInstallTip,1500);
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

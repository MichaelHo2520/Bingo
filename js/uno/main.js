"use strict";

/* ============================================================================
   UNO — 畫面切換、事件綁定與啟動(必須最後載入)

   單機(對電腦)與連線**共用同一個盤面 UNB、同一條動作列 #unActs、同一張結果卡**,
   差別只在上面那條列(房間橫幅 vs 單機列)與結果卡的按鈕組 —— 靠 body 的
   solo-on / un-mp 兩個 class 切換(與其他八個遊戲同一個模式)。

   ★ 相位一律走 showScreen(),不要在 adapter.js / solo.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。
   ========================================================================== */

const UN_SCREENS = ["unHome", "unSetup", "unSoloBar", "unPlay"];
function showScreen(which){
  const on = {
    home:    ["unHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["unSetup"],
    play:    ["unPlay"],                // 連線對戰中
    solo:    ["unSoloBar", "unPlay"]    // 電腦對決
  }[which] || [];
  UN_SCREENS.forEach(id=>{ const el=$(id); if(el) el.classList.toggle("hidden", on.indexOf(id)<0); });
  // 離開連線的畫面(回選單 / 進單機)時,把連線那幾塊一起收乾淨
  if(which==="home" || which==="solo"){
    ["mpConnect","mpBar","primaryBar","scrollArea"].forEach(id=>{ const el=$(id); if(el) el.classList.add("hidden"); });
  }
  document.body.classList.toggle("solo-on", which==="solo");
  document.body.classList.toggle("un-mp", which==="play");
  document.body.classList.toggle("un-solo", which==="solo");
  /* 對局中 ⛶/⚙️ 該住哪 —— ★ 決定權在 ui-kit 的 dockTools:**只有頂列真的被收掉才搬**
     (v1.75.10 立的規矩)。兩種情形都不必也不可以在這裡判斷,條件只准有一份。 */
  if(which==="play") dockTools("mpBar");
  else if(which==="solo") dockTools("unSoloBar");
  else undockTools();
  /* 大牌桌:每次換畫面都**無條件**重套一次(v1.178.3,見 ui-kit 的 BigMode)。
     一行做兩件事:進牌桌把偏好記著的狀態套回來、離開牌桌把 body 上的 class 脫掉 ——
     那個 class 會收掉整條頂列(⛶ / ⚙️ 都在裡面),而兩顆鈕住在房間框 / 單機列裡,
     留著就再也關不回來。⚠ 守衛在 BigMode 自己(它看對局畫面在不在),
       所以這裡不要再判斷一次 which,條件只准有一份。
     ⚠ 一定要排在 dockTools() **之後**:BigMode 會叫 syncTools()。 */
  BigMode.sync();
  if(which==="home") showHomeLayer("pick");   // 回主選單一律從「選玩法」開始
  syncPageBack();   // 返回鍵:換一個畫面就重算「現在在第幾層」(見 ui-kit 的 bindPageBack)
}

/* ---------- 進場選單的兩層 ----------
   第一層選玩法(連線在上)、第二層才挑難度 / 人數。
   回 index.html 的返回列只在第一層顯示:第二層有自己的返回,兩顆並存會分不清誰是誰。 */
function showHomeLayer(which){
  const pick=$("unPickMode"), solo=$("unPickSolo"), head=$("unHomeHead");
  if(pick) pick.classList.toggle("hidden", which!=="pick");
  if(solo) solo.classList.toggle("hidden", which!=="solo");
  if(head) head.classList.toggle("hidden", which!=="pick");
  syncPageBack();   // 同上:第二層按返回要退回第一層,不是離開這一頁
}
/* 第二層的說明:難度文案直接讀 UNAI 的難度表,不另外硬編一份 */
function paintSoloHint(){
  const el=$("unSoloHint"); if(!el) return;
  const L = UNAI.levelOf(Solo.level());
  const n = Solo.seats();
  el.innerHTML = "<b>"+L.emoji+" "+L.name+"</b>:"+esc(L.desc)+"<br>"+
    "每人先發 <b>"+UN.DEAL_N+" 張</b> · 你固定坐第一位,由你先出。<br>"+
    "名次分 "+(n>=4 ? "<b>5 / 3 / 1 / 0…</b>" : (n===3 ? "<b>5 / 3 / 0</b>" : "<b>5 / 0</b>"))+
    "(最後一名固定 0 分;名次照手上剩牌的**點數**排)。<br>"+
    /* ★ 房規要講**現在設的是哪一種** —— 單機的房規存在自己的偏好裡、跨場黏著,
       不寫出來會忘記上次改過(同大老二第二層那條)。 */
    "<b>"+esc(unRulesText(Solo.rules()))+"</b>(按上面「⚙ 改規則」可換)。<br>"+
    // ⚠ 圖示一律 🌈(U+1F308);🃏 是 U+1F0CF,落在被禁的區段(見 solo.js 那條註解)
    "<span class=\"un-warn\">🌈 "+esc(Solo.recLine(Solo.level()))+"</span>";
}

/* ==========================================================================
   ★★★ 房規面板 —— 單機與連線**共用這一支**
   ──────────────────────────────────────────────────────────────────────────
     結構照大老二 / 21點:
       · 面板本體是一個蓋板 #unRulesVeil,單機第二層與大廳各一顆鈕打開它
       · 每一列是 .seg,按鈕帶 data-rk(哪一項)/ data-rv(值)
       · 分流點**只有下面三支**(unEditable / unRulesNow / unSetRule)
     ⚠ 不能改的時候給 .readonly(只是不亮)—— **不用 disabled**:
       CLAUDE.md 的紅線是「不用 disabled 讓點擊靜默消失」,訪客按下去要看得到
       「只有房主能改規則」(擋在 MP.setRule / Solo 那一側,不是擋在 CSS)。
   ========================================================================== */
/* ⚠⚠ UNO 的兩項房規值都是**布林**,而 dataset 永遠是字串 ——
   `"0"` 是 truthy,直接拿去比會讓「不能疊」永遠亮不起來(21點 BJ_BOOLS 那張表的同一個坑)。
   所以這裡一定要顯式轉型,而且**兩個方向都要**(寫進去 / 比對亮暗)。 */
function unRuleVal(raw){ return String(raw) === "1"; }
/* 一句話講「現在是什麼規則」——★ 面板底部 / 大廳摘要 / 單機第二層**共用這一支**(三份會走鐘)。 */
function unRulesText(r){
  const rr = UN.normRules(r);
  /* ★ 這一行是**一直看得到**的(大廳 / 單機第二層 / 面板底部),所以刻意寫短 ——
     一項一個短句、不解釋後果。要知道細節的人會去開房規面板,那裡才有整句說明。
     ⚠ 不要把面板的 set-sub 文案搬過來:三項乘上完整說明會變成一段公文。 */
  return (rr.stack ? "可疊 +2 / +4" : "不可疊") + " · " +
         (rr.unoCall ? "剩一張要喊 UNO" : "不必喊 UNO") + " · " +
         (rr.playDrawn ? "抽到可馬上出" : "抽完就換人") + " · " +
         (rr.toLast ? "打到最後一個" : "出完就結束") + " · " +
         (rr.freeDraw ? "有牌也能抽" : "有牌必須出");
}
function syncRules(rules, editable){
  const r = UN.normRules(rules);
  document.querySelectorAll("#unRulesBody .seg").forEach(seg => {
    seg.classList.toggle("readonly", !editable);
    [...seg.children].forEach(b => {
      const k = b.dataset.rk;
      if(!k) return;
      b.classList.toggle("on", unRuleVal(b.dataset.rv) === r[k]);
    });
  });
  /* ★ 出牌倒數那一組**只有連線才有**(單機沒有倒數 —— 卡多久是自己的節奏)。
     ⚠ 它不在 rules 物件裡:那個房間欄位不影響任何判定。 */
  const secG = $("unSecGroup");
  if(secG){
    const on = MP.isOnline();
    secG.classList.toggle("hidden", !on);
    if(on){
      const seg = $("unSecSeg2");
      if(seg){
        seg.classList.toggle("readonly", !editable);
        [...seg.children].forEach(b => b.classList.toggle("on", (+b.dataset.sec) === MP.turnSec()));
      }
    }
  }
  const who = $("unRulesWho");
  if(who) who.textContent = editable ? "你是房主,規則由你決定" : "規則由房主決定(對戰中不能改)";
  const sum = $("unRulesSum");
  if(sum) sum.textContent = unRulesText(r);
}
/* 現在該對誰設定 —— 單機改 Solo 的、連線改房間的(★ 唯一的分流點就這三支) */
function unEditable(){ return !MP.isOnline() || MP.amHost(); }
function unRulesNow(){ return MP.isOnline() ? MP.rules() : Solo.rules(); }
function unSetRule(key, val){
  if(MP.isOnline()){ MP.setRule(key, val); syncRules(unRulesNow(), unEditable()); return; }
  if(Solo.playing()){ showToast("對局中不能改規則", 1600); return; }
  Solo.setRule(key, val);
  syncRules(Solo.rules(), true);
  paintSoloHint();
}
function openRules(){
  syncRules(unRulesNow(), unEditable());
  $("unRulesVeil").classList.add("show");
}
function closeRules(){
  $("unRulesVeil").classList.remove("show");
  /* 關掉之後把摘要重畫一次(大廳那行 / 單機第二層那段各一份文案,但**同一支** unRulesText)。 */
  if(MP.isOnline()) MP.refreshSetup();
  else paintSoloHint();
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
  set("unLvSeg","lv",Solo.level());
  set("unSeatSeg","seats",Solo.seats());
}

/* ---------- 盤面 ----------
   ★ 兩個回呼都要分流到單機 / 連線。盤面本身不知道自己在哪一種模式(見 board.js 檔頭),
     漏掉分流的症狀是「單機點牌沒反應」或「連線點牌走到單機那條路」。 */
UNB.mount({
  onCard(c){ if(Solo.active()) Solo.tap(c); else MP.tap(c); },
  onAct(a){ if(Solo.active()) Solo.act(a); else MP.act(a); }
});

/* ---------- 進場選單 ---------- */
$("unGoOnline").addEventListener("click",()=>MP.openConnect());
$("unGoSolo").addEventListener("click",()=>{ paintSoloHint(); showHomeLayer("solo"); });
$("unSoloCfgBack").addEventListener("click",()=>showHomeLayer("pick"));
segPick("unLvSeg","lv",v=>Solo.setLevel(v));
segPick("unSeatSeg","seats",v=>Solo.setSeats(+v));
$("unStartSolo").addEventListener("click",()=>Solo.start());
/* ★ 房規:單機第二層那顆鈕(面板本體與連線共用,見上面那一段) */
$("unSoloRules").addEventListener("click",openRules);

/* ---------- 單機的牌桌列 / 結果卡 ---------- */
$("unSoloExit").addEventListener("click",()=>Solo.quit());
$("unSoloAgain").addEventListener("click",()=>Solo.again());
$("unSoloHome").addEventListener("click",()=>Solo.quit());

/* ---------- 大廳設定(房主可改) ---------- */
$("unSecSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b)MP.setTurnSec(+b.dataset.sec); });
/* ---------- 房規面板(一組 DOM,兩個入口)----------
   ⚠ 監聽綁在 #unRulesBody 上**一次**(委派):以後加項目不必改這裡。 */
$("unRulesOpen").addEventListener("click",openRules);
$("unRulesClose").addEventListener("click",closeRules);
$("unRulesVeil").addEventListener("click",e=>{ if(e.target.id==="unRulesVeil") closeRules(); });
$("unRulesBody").addEventListener("click",e=>{
  const b=e.target.closest("button[data-rk]");
  if(b){ unSetRule(b.dataset.rk, unRuleVal(b.dataset.rv)); return; }
  /* 出牌倒數那一組走既有的房間欄位(不是房規物件)——⚠ 兩處入口寫同一支 MP.setTurnSec */
  const s=e.target.closest("#unSecSeg2 button");
  if(s){ MP.setTurnSec(+s.dataset.sec); syncRules(unRulesNow(), unEditable()); }
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
$("unReactRow").addEventListener("click",e=>{
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
bindPageBack({sub:"unPickSolo"});
bindAudioLifecycle();
registerSW();
paintVersion();
// 更新檢查:安全 = 沒在房裡、也沒在單機局中(局中重載會把整局丟掉)
initUpdateCheck(()=>!MP.isOnline() && !Solo.playing());
initFullscreenKeep();   // 全螢幕跨頁保持:從主選單帶著全螢幕過來,第一個手勢自動接回去

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大牌桌(v1.178.3):⚠ 一定要排在 loadPrefs() **之前** —— 偏好會回頭叫 BigMode.set(),
   還沒 init 的話那個狀態就掉了(症狀:上一場開著大牌桌,下次進來卻是一般大小)。 */
BigMode.init({
  cls:"un-big", btn:"un-bigbtn", name:"大牌桌",
  live:()=>{ const el=$("unPlay"); return !!el && !el.classList.contains("hidden"); },
  save:savePrefs
});
loadPrefs();       // 主題 / 音量 / 暱稱(與 Bingo 共用)+ UNO 的連線偏好
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

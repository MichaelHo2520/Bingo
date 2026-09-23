"use strict";

/* ============================================================================
   泡泡對戰 — 畫面切換、事件綁定與啟動(必須最後載入)

   ★ 骨架照抄 js/blocks/main.js。相位一律走 showScreen(),不要在 solo.js / adapter.js
     裡自己 toggle("hidden")(五子棋 v1.51.0 的教訓)。
   ⚠ 所有 MP 綁定一律 `typeof MP !== "undefined"` 包起來(同 ui-kit 對 Talk / RoomShare)。
   ========================================================================== */

const BUB_SCREENS = ["bubHome", "bubSetup", "bubSoloBar", "bubPlay"];
let bubLastScreen = "";
function showScreen(which){
  /* ★ 開局自動進「大」(同方塊對戰 v2.14.0):只在**剛進對局**時做,
     不可以每次 showScreen 都做 —— 那會把使用者在這一局裡按的「小」硬是扳回去。 */
  const entering = (which !== bubLastScreen) && (which === "play" || which === "solo");
  bubLastScreen = which;
  const on = {
    home:    ["bubHome"],
    connect: [],
    lobby:   ["bubSetup"],
    play:    ["bubPlay"],
    solo:    ["bubSoloBar", "bubPlay"]
  }[which] || [];
  BUB_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => {
      const el = $(id); if(el) el.classList.add("hidden");
    });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  document.body.classList.toggle("bub-mp", which === "play");
  document.body.classList.toggle("bub-solo", which === "solo");
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("bubSoloBar");
  else undockTools();
  if(entering) BigMode.set(true);
  else BigMode.sync();
  /* ★ rAF 只在對局畫面開著的時候跑(BUBB.wake / sleep);盤面尺寸靠 JS 算 → 換畫面要重量兩次 */
  if(which === "play" || which === "solo"){
    BUBB.wake();
    setTimeout(() => BUBB.fitBoard(), 0);
    requestAnimationFrame(() => BUBB.fitBoard());
  }else BUBB.sleep();
  if(which === "lobby" && $("bubSetupHelp").open) demoStart(); else demoStop();
  if(which === "home") showHomeLayer("pick");
  syncPageBack();
}

/* ---------- 操作說明(單一真相:進場頁與「?」蓋板印同一份)----------
   ⚠ 圖示一律自繪 SVG,不用 emoji / 箭頭字元(紅線 8 的另一面)。 */
const BUB_GEST = [
  ['<circle cx="12" cy="18" r="3.2"/><path d="M12 14.5V5m-3.2 3.2L12 5l3.2 3.2"/>', "拖曳", "瞄準"],
  ['<path d="M7 12.5l3.2 3.2L17 9"/><circle cx="12" cy="12" r="9"/>', "放手", "發射"],
  ['<path d="M5 9h11l-3-3M19 15H8l3 3"/>', "點左下角", "換下一顆"],
  ['<path d="M6 6l12 12M18 6L6 18"/>', "拖回下面", "放手 = 取消"]
];
function bubGestHtml(){
  const cells = BUB_GEST.map(g =>
    '<div class="bub-gest-it">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + g[0] + '</svg>' +
      '<span>' + g[1] + '<b>' + g[2] + '</b></span>' +
    '</div>').join("");
  return '<div class="bub-gest-head">手指在畫面上<b>任何地方</b>都可以拖(不必擋住盤面)。' +
         '牆壁會<b>反彈</b> —— 打角度球是高手的招式。<b>太久不射會自動發射</b>。</div>' +
         '<div class="bub-gest-grid">' + cells + '</div>' +
         '<div class="bub-gest-kb">電腦鍵盤:<b>← →</b> 瞄準 · <b>空白鍵 / ↑</b> 發射 · <b>X / ↓</b> 換</div>';
}
/* 攻擊表:點數 → 送幾排。⚠ 數字直接讀 BUB.rowsOf(),不在這裡寫一份(雙胞胎) */
function bubAtkHtml(){
  /* [標籤, 點數]。點數 = (消掉的 - 3) + 掉落的 —— 算式在 rules.js 的 land()。
     「掉 N 顆」指的是剛好湊 3 顆、再帶掉 N 顆(⚠ 標籤只能一行,同方塊對戰那張圖) */
  const cases = [
    ["湊 3 顆", 0], ["消 5 顆", 2], ["掉 4 顆", 4], ["掉 8 顆", 8]
  ];
  return '<div class="bub-atk-grid">' + cases.map((c, i) => {
    const n = BUB.rowsOf(c[1]);
    let bars = "";
    for(let k = 0; k < 4; k++)
      bars += '<rect x="' + (3 + k * 6.5) + '" y="8" width="5" height="14" rx="2" class="' + (k < n ? "bub-atk-lit" : "bub-atk-dim") + '"/>';
    return '<div class="bub-atk-it' + (i === 3 ? " bub-atk-hot" : "") + '">' +
      '<svg viewBox="0 0 30 30" width="38" height="38" aria-hidden="true">' + bars + '</svg>' +
      '<span>' + c[0] + ' <b>→ ' + n + ' 排</b></span></div>';
  }).join("") + '</div>';
}
function paintGestCards(){
  const html = bubGestHtml();
  ["bubGestCard", "bubGuideBody"].forEach(id => { const el = $(id); if(el) el.innerHTML = html; });
  const atk = $("bubAtkCard");
  if(atk) atk.innerHTML = bubAtkHtml();
}
function openBubGuide(){ const el = $("bubGuideVeil"); if(el) el.classList.add("show"); }
function closeBubGuide(){ const el = $("bubGuideVeil"); if(el) el.classList.remove("show"); }

/* ==========================================================================
   大廳的示範局 —— 兩台電腦互打,等人的時候自己跑(同方塊對戰 v2.15.3)
     ⚠ 走 setInterval 不是 rAF(rAF 在非對局畫面是睡著的);自己畫兩塊小畫布,
       **不要接到 board.js 的 foeEls**(那一套跟著對局的 fitFoes 走)。
     ⚠ 離開大廳一定要 stop()。
   ========================================================================== */
const DEMO_MS = 50;
const DEMO_D = 7;                       // 一顆幾 px
let demoT = null, demoA = null, demoB = null, demoMemA = null, demoMemB = null, demoHit = 0;
function demoBlank(seed){ return BUB.blank({ seed: seed, rules: { mode: "ko", secs: 180, shield: 0, combo: true } }); }
function demoStart(){
  if(demoT) return;
  const cvA = $("bubDemoA"), cvB = $("bubDemoB");
  if(!cvA || !cvB) return;
  [cvA, cvB].forEach(cv => { cv.width = BUB.COLS * DEMO_D; cv.height = Math.round(BUB.H * DEMO_D); });
  demoA = demoBlank(20260923); demoB = demoBlank(731157);
  demoMemA = BUBAI.newMem(); demoMemB = BUBAI.newMem();
  demoHit = 0;
  demoT = setInterval(demoStep, DEMO_MS);
}
$("bubSetupHelp").addEventListener("toggle", e => {
  if(!$("bubSetup").classList.contains("hidden") && e.target.open) demoStart();
  else demoStop();
});
function demoStop(){ if(demoT){ clearInterval(demoT); demoT = null; } }
function demoStep(){
  const lv = BUBAI.levelOf("norm");
  demoSide(demoA, demoMemA, demoB, lv, true);
  demoSide(demoB, demoMemB, demoA, lv, false);
  demoDraw($("bubDemoA"), demoA);
  demoDraw($("bubDemoB"), demoB);
  const mid = $("bubDemoMid");
  if(mid){
    if(demoHit > 0){ demoHit--; mid.textContent = "塞一排 →"; mid.classList.add("bub-demo-fire"); }
    else { mid.textContent = "→"; mid.classList.remove("bub-demo-fire"); }
  }
}
function demoSide(st, mem, foe, lv, isA){
  if(st.dead){ BUB.revive(st); mem.target = null; mem.k = -1; return; }
  const evs = BUBAI.step(st, mem, DEMO_MS, lv, Math.random).concat(BUB.tick(st, DEMO_MS));
  evs.forEach(ev => {
    if(ev && ev.t === "land" && ev.out > 0){
      BUB.queueGarbage(foe, ev.out, (Math.random() * 0xffffffff) >>> 0, isA ? "a" : "b");
      if(isA) demoHit = 10;
    }
  });
}
function demoDraw(cv, st){
  if(!cv || !st) return;
  const c = cv.getContext("2d");
  c.clearRect(0, 0, cv.width, cv.height);
  for(let y = 0; y < BUB.ROWS; y++)
    for(let x = 0; x < BUB.COLS; x++){
      const v = st.board[y][x];
      if(!v) continue;
      c.fillStyle = BUBB.COL[v - 1];
      c.beginPath(); c.arc(BUB.cx(st.par, x, y) * DEMO_D, BUB.cy(y) * DEMO_D, DEMO_D * 0.44, 0, Math.PI * 2); c.fill();
    }
  if(st.shot){
    c.fillStyle = BUBB.COL[st.shot.c - 1];
    c.beginPath(); c.arc(st.shot.x * DEMO_D, st.shot.y * DEMO_D, DEMO_D * 0.44, 0, Math.PI * 2); c.fill();
  }
}

/* ---------- 進場選單的兩層 ---------- */
function showHomeLayer(which){
  const pick = $("bubPickMode"), solo = $("bubPickSolo"), head = $("bubHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();
}
function paintSoloHint(){
  const el = $("bubSoloHint"); if(!el) return;
  syncSoloSeg();
  const r = Solo.rec();
  const isCustom = Solo.level() === "custom";
  const lv = isCustom ? null : BUBAI.levelOf(Solo.level());
  const body = (Solo.mode() === "vs")
    ? ("<b>對電腦</b>:互相把泡泡塞給對方,先被壓過虛線的輸。" +
       (isCustom ? "<b>🛠️ 自訂強度</b>:自選每台電腦個別難度。<br>"
                 : ("<b>" + lv.emoji + " " + lv.name + "</b>:" + esc(lv.desc) + "<br>")) +
       ((r.win + r.lose) ? ("你目前 <b>" + r.win + " 勝 " + r.lose + " 敗</b>。") : "還沒有交手紀錄。"))
    : ("<b>練習(無盡)</b>:每射幾發,頂端就會多一排(越來越快),撐到被壓過虛線為止。" +
       (r.best ? "你最多打掉 <b>" + r.best + " 顆</b>。" : "還沒有紀錄。"));
  el.innerHTML = body + "<br>操作:<b>拖曳瞄準、放手發射</b>(上一層有圖解;對局中按「<b>?</b>」也看得到)。";
}
function segPick(id, attr, fn){
  const seg = $(id); if(!seg) return;
  seg.addEventListener("click", e => {
    const b = e.target.closest("button"); if(!b) return;
    fn(b.dataset[attr]);
    [...seg.children].forEach(x => x.classList.toggle("on", x === b));
    paintSoloHint();
  });
}
function paintCustomLineup(){
  const box = $("bubCustomLineup"); if(!box) return;
  const n = Solo.foeN(), lvs = Solo.customLvs();
  const tiers = [{ key: "easy", label: "🙂 輕鬆" }, { key: "norm", label: "😎 普通" }, { key: "hard", label: "🔥 硬仗" }];
  const items = box.querySelectorAll(".bub-custom-item");
  if(items.length === n){
    items.forEach((item, i) => {
      const seg = item.querySelector(".seg");
      if(seg) [...seg.children].forEach(b => b.classList.toggle("on", b.dataset.lv === (lvs[i] || "norm")));
    });
    return;
  }
  let html = "";
  for(let i = 0; i < n; i++){
    const curLv = lvs[i] || "norm";
    html += '<div class="bub-custom-item" data-foe-idx="' + i + '">' +
      '<span class="bub-custom-lbl">🤖 電腦 ' + (i + 1) + '</span>' +
      '<div class="seg" data-foe-idx="' + i + '" aria-label="電腦 ' + (i + 1) + ' 強度">' +
      tiers.map(t => '<button type="button" data-lv="' + t.key + '" class="' + (curLv === t.key ? "on" : "") + '">' + t.label + '</button>').join("") +
      '</div></div>';
  }
  box.innerHTML = html;
}
function syncSoloSeg(){
  const set = (id, attr, val) => {
    const seg = $(id); if(!seg) return;
    [...seg.children].forEach(b => b.classList.toggle("on", String(b.dataset[attr]) === String(val)));
  };
  const note = (id, html) => { const el = $(id); if(el) el.innerHTML = html || ""; };
  const v = Solo.vs();
  set("bubModeSeg", "mode", Solo.mode());
  set("bubLvSeg", "lv", Solo.level());
  set("bubFoeNSeg", "foen", Solo.foeN());
  set("bubVsModeSeg", "vsmode", v.mode);
  set("bubVsSecsSeg", "vssecs", v.secs);
  set("bubVsShieldSeg", "vsshield", v.shield);
  set("bubVsTargetSeg", "vstarget", v.target);
  set("bubVsRushSeg", "vsrush", v.rush ? "1" : "0");
  /* ★ 文案共用 BUB.NOTES —— 與大廳同一份 */
  note("bubNoteVsMode", BUB.noteOf("mode", v.mode));
  note("bubNoteVsShield", BUB.noteOf("shield", v.shield));
  note("bubNoteVsTarget", BUB.noteOf("target", v.target));
  note("bubNoteVsRush", BUB.noteOf("rush", v.rush));
  const names = Solo.lineup().map(l => l.emoji + " " + l.name);
  note("bubNoteFoeN", (names.length > 1)
    ? ("場上會有 <b>" + (names.length + 1) + " 個人</b>(你 + " + names.length + " 台電腦),而且<b>電腦之間也會互打</b>。")
    : "1 對 1。想試三個人以上的感覺就選 2 台或 3 台。");
  note("bubNoteLv", "這一局會配到:<b>" + names.join("</b> · <b>") + "</b>");
  const isVs = Solo.mode() === "vs";
  document.querySelectorAll(".bub-vs-row").forEach(el => el.classList.toggle("hidden", !isVs));
  const koOnly = isVs && v.mode === "ko";
  ["bubVsSecsRow", "bubVsRushRow"].forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", !koOnly); });
  const isCustom = isVs && Solo.level() === "custom";
  const elCustom = $("bubCustomLvsRow");
  if(elCustom){ elCustom.classList.toggle("hidden", !isCustom); if(isCustom) paintCustomLineup(); }
}

/* 蓋板開著的時候,單機不要繼續跑(這一頁是即時的,同方塊對戰 BLK_VEILS)。
   ⚠⚠ 連線刻意不吃這一條 —— 別人還在玩,自己開設定不能讓全場等你。 */
const BUB_VEILS = ["setVeil", "fbVeil", "emoteVeil", "myVoiceVeil", "qrVeil", "bubGuideVeil"];
function bubVeilOpen(){
  for(let i = 0; i < BUB_VEILS.length; i++){
    const el = $(BUB_VEILS[i]);
    if(el && el.classList.contains("show")) return true;
  }
  return false;
}

/* ---------- 盤面(規則事件分流到單機 / 連線)---------- */
BUBB.mount({
  onEvents(evs, st){
    if(Solo.active()) Solo.onEvents(evs, st);
    else if(typeof MP !== "undefined") MP.onEvents(evs, st);
  },
  canPlay(){
    if(Solo.active()) return !Solo.paused() && !bubVeilOpen();
    return (typeof MP !== "undefined") ? MP.canPlay() : false;
  },
  onFrame(dt){
    if(Solo.active()) Solo.onFrame(dt);
    else if(typeof MP !== "undefined" && MP.onFrame) MP.onFrame(dt);
  }
});

/* ---------- 進場選單 ---------- */
$("bubGoOnline").addEventListener("click", () => {
  if(typeof MP !== "undefined") MP.openConnect();
  else showToast("連線對戰還在施工中 —— 先玩單機 🙂");
});
$("bubGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("bubSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("bubModeSeg", "mode", v => Solo.setMode(v));
$("bubHelpBtn").addEventListener("click", openBubGuide);
$("bubSoloHelpBtn").addEventListener("click", openBubGuide);
$("bubGuideClose").addEventListener("click", closeBubGuide);
$("bubGuideVeil").addEventListener("click", e => { if(e.target === $("bubGuideVeil")) closeBubGuide(); });
segPick("bubLvSeg", "lv", v => Solo.setLevel(v));
if($("bubCustomLineup")) $("bubCustomLineup").addEventListener("click", e => {
  const btn = e.target.closest("button[data-lv]"); if(!btn) return;
  const seg = btn.closest(".seg[data-foe-idx]"); if(!seg) return;
  Solo.setCustomLevel(parseInt(seg.dataset.foeIdx, 10), btn.dataset.lv);
  paintSoloHint();
});
segPick("bubFoeNSeg", "foen", v => Solo.setFoeN(+v));
segPick("bubVsModeSeg", "vsmode", v => Solo.setVs("mode", v));
segPick("bubVsSecsSeg", "vssecs", v => Solo.setVs("secs", +v));
segPick("bubVsShieldSeg", "vsshield", v => Solo.setVs("shield", +v));
segPick("bubVsTargetSeg", "vstarget", v => Solo.setVs("target", v));
/* ⚠ rush 是布林 —— dataset 拿到的是字串 "0" / "1",不轉的話 "0" 是 truthy */
segPick("bubVsRushSeg", "vsrush", v => Solo.setVs("rush", v === "1"));
$("bubStartSolo").addEventListener("click", () => Solo.start());

/* 點對手的小盤 = 指定只打他 / 改回隨機(單機與連線都要能用 → 不可以只掛在連線那一區) */
if($("bubFoes")) $("bubFoes").addEventListener("click", e => {
  const i = BUBB.foeAt(e.target);
  if(i < 0) return;
  if(Solo.active()) Solo.tapFoe(i);
  else if(typeof MP !== "undefined") MP.tapFoe(i);
});
$("bubSoloExit").addEventListener("click", () => Solo.quit());
$("bubSoloAgain").addEventListener("click", () => Solo.again());
$("bubSoloHome").addEventListener("click", () => Solo.quit());
$("bubPauseBtn").addEventListener("click", () => Solo.togglePause());
$("winPeek").addEventListener("click", peekBoard);
$("reopenWin").addEventListener("click", showResult);

/* ---------- 連線 ---------- */
(function bindMP(){
  if(typeof MP === "undefined") return;
  $("bubModeSegMp").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setMode(b.dataset.mode); });
  $("bubSecsSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setSecs(b.dataset.secs); });
  $("bubShieldSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setShield(b.dataset.shield); });
  $("bubTargetSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setTarget(b.dataset.target); });
  $("bubRushSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setRush(b.dataset.rush === "1"); });
  $("scoreSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setScoreMode(b.dataset.score); });
  $("wgMinus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() - 1));
  $("wgPlus").addEventListener("click", () => MP.setWinGoal(MP.winGoal() + 1));
  $("resetScoreBtn").addEventListener("click", () => MP.resetScores());
  $("mpNewSeason").addEventListener("click", () => { MP.resetScores(); MP.again(); });
  $("mpCreate").addEventListener("click", () => MP.create($("mpName").value, $("mpRoomName").value));
  $("mpScan").addEventListener("click", () => MP.scanRooms());
  $("mpName").addEventListener("change", savePrefs);
  $("mpName").addEventListener("input", () => $("mpName").classList.remove("needs-name"));
  $("mpRoomName").addEventListener("keydown", e => { if(e.key === "Enter") MP.create($("mpName").value, $("mpRoomName").value); });
  $("mpReadyBtn").addEventListener("click", () => MP.toggleReady());
  $("mpLeaveBtn").addEventListener("click", () => MP.askLeave());
  $("mpConnBack").addEventListener("click", () => showScreen("home"));
  $("leaveConfirm").addEventListener("click", () => MP.confirmLeave());
  $("leaveCancel").addEventListener("click", () => MP.cancelLeave());
  $("leaveVeil").addEventListener("click", e => { if(e.target === $("leaveVeil")) MP.cancelLeave(); });
  $("kickConfirm").addEventListener("click", () => MP.confirmKick());
  $("kickCancel").addEventListener("click", () => MP.cancelKick());
  $("kickVeil").addEventListener("click", e => { if(e.target === $("kickVeil")) MP.cancelKick(); });
  $("mpAgain").addEventListener("click", () => MP.again());
  $("mpLeaveWin").addEventListener("click", () => MP.askLeave());
  /* 賽後表情列(⚠ 方塊對戰 v2.13.0 ~ v2.14.0 漏綁過這一段,按了毫無反應) */
  let reactAt = 0;
  $("bubReactRow").addEventListener("click", e => {
    const b = e.target.closest("button"); if(!b) return;
    if(b.id === "winEmoteBtn"){ openEmote("all"); return; }
    const em = b.dataset.em; if(!em) return;
    const now = performance.now();
    if(now - reactAt < 600) return;
    reactAt = now;
    markAudioArmed(); Sound.wake();
    MP.sendEmote("all", em);
    b.classList.remove("sent"); void b.offsetWidth; b.classList.add("sent");
  });
})();

/* ---------- 共用綁定 ---------- */
bindCommonUI();
bindPageBack({ sub: "bubPickSolo" });
bindAudioLifecycle();
registerSW();
paintVersion();
initUpdateCheck(() => !Solo.playing() && (typeof MP === "undefined" || !MP.isOnline()));
initFullscreenKeep();

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大畫面:⚠ 一定要排在 loadPrefs() **之前**(偏好會回頭叫 BigMode.set())。
   ⚠ 名字用「大 / 小」,不准沾「全螢幕」。 */
BigMode.init({
  cls: "bub-big", btn: "bub-bigbtn", name: "大畫面",
  live: () => { const el = $("bubPlay"); return !!el && !el.classList.contains("hidden"); },
  save: savePrefs,
  after: () => BUBB.fitBoard()
});
loadPrefs();
Solo.loadOwn();
syncSettingsUI();
paintGestCards();
syncSoloSeg();
Solo.paintBar();
paintSoloHint();
showScreen("home");
setTimeout(maybeShowInstallTip, 1500);
/* ★ 一定要是最後一行(tools/test-boot.js 在守) */
bootReady();

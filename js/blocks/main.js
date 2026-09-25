"use strict";

/* ============================================================================
   方塊對戰 — 畫面切換、事件綁定與啟動(必須最後載入)

   ★ 相位一律走 showScreen(),不要在 solo.js / adapter.js 裡自己 toggle("hidden")——
     有了選單 + 單機 + 連線三塊之後一定會漏掉某一塊(五子棋 v1.51.0 的教訓)。

   ⚠ **P1 階段沒有 adapter.js** —— 所有 MP 綁定一律 `typeof MP !== "undefined"` 包起來
     (同 ui-kit 對 Talk / RoomShare / Feedback 的做法)。P3 把 adapter.js 放進來之後,
     這一支不必改就會自己亮起來。
   ========================================================================== */

const BLK_SCREENS = ["blkHome", "blkSetup", "blkSoloBar", "blkPlay"];
/* 上一次是哪一個畫面 —— 只為了分辨「剛剛**進入**對局」與「已經在對局裡了」(見下面的大畫面)。 */
let blkLastScreen = "";
function showScreen(which){
  /* ★ 開局自動進「大」(v2.14.0):對局中周邊 UI 沒有一樣是要看的,而這一頁的盤面
     大小直接等於「看不看得清楚」。⚠ 只在**剛進對局**時做,不可以每次 showScreen
     都做 —— 那會把使用者在這一局裡按的「小」硬是扳回去。
     ⚠ 走 BigMode.set() 不走 savePrefs:存的是「意願」,自動開的這一次不該寫進偏好。 */
  const entering = (which !== blkLastScreen) && (which === "play" || which === "solo");
  blkLastScreen = which;
  const on = {
    home:    ["blkHome"],
    connect: [],                        // 連線畫面本體由 mp-core 顯示
    lobby:   ["blkSetup"],
    play:    ["blkPlay"],               // 連線對戰中
    solo:    ["blkSoloBar", "blkPlay"]  // 單機
  }[which] || [];
  BLK_SCREENS.forEach(id => { const el = $(id); if(el) el.classList.toggle("hidden", on.indexOf(id) < 0); });
  if(which === "home" || which === "solo"){
    ["mpConnect", "mpBar", "primaryBar", "scrollArea"].forEach(id => {
      const el = $(id); if(el) el.classList.add("hidden");
    });
  }
  document.body.classList.toggle("solo-on", which === "solo");
  document.body.classList.toggle("blk-mp", which === "play");
  document.body.classList.toggle("blk-solo", which === "solo");
  if(which === "play") dockTools("mpBar");
  else if(which === "solo") dockTools("blkSoloBar");
  else undockTools();
  if(entering) BigMode.set(true);      // set() 內部就會 apply,等同 sync
  else BigMode.sync();
  /* ★ 盤面尺寸靠 JS 算 → 換到有盤面的畫面時要重量一次(剛才它還是 hidden,量不到)。
     ⚠ 兩次:一次立刻、一次下一幀 —— 版面在同一輪裡還沒穩定下來(控制列的高度會變)。 */
  /* ★ rAF 只在對局畫面開著的時候跑(BLKB.wake / sleep)——
     它從 mount() 起是無條件自遞迴的,在選單與大廳也照樣每秒畫六十次一塊看不見的
     canvas。⚠ 判斷只能用「哪一個畫面」,不可以用 running:觀戰者永遠不 play()。 */
  if(which === "play" || which === "solo"){
    BLKB.wake();
    setTimeout(() => BLKB.fitBoard(), 0);
    requestAnimationFrame(() => BLKB.fitBoard());
  }else BLKB.sleep();
  /* 大廳的示範局:只在大廳跑(⚠ 離開一定要停,不然就是在別的畫面裡白燒電池) */
  if(which === "lobby" && $("blkSetupHelp").open) demoStart(); else demoStop();
  if(which === "home") showHomeLayer("pick");
  syncPageBack();
}

/* ---------- 操作說明(單一真相)----------
   ★ 進場頁那一張(#blkGestCard)與房間框「?」打開的蓋板(#blkGuideBody)印的是**同一份** ——
     寫死兩份 HTML 就是遲早會分岔的雙胞胎(而說明與實際操作對不上比沒有說明更糟)。
   ⚠⚠ v2.15.1 起這裡講的是**四顆按鈕**,不是手勢 —— 手勢那一整套已經拿掉了
     (使用者:「只剩按鍵,不要用手勢控制」)。四格的圖示與實際按鈕**刻意畫成同一組線條**。
   ⚠ 圖示一律自繪 SVG,不用 emoji:U+25C0 那一段的箭頭在桌機 Chrome / Edge 上會退回
     線條字形、在手機上又是另一個樣子(紅線 8 的另一面),而且彩色 emoji 不吃 color。
   ⚠ class 仍然是 .blk-gest-*(版面共用同一套)—— 名字留著,內容換掉。 */
/* ⚠ 文字裡**不要出現 ◀ ▶ ↻ 那幾個字元** —— 圖示已經畫出來了,而那些字元的字形
   每台機器不一樣(U+25C0 那一段在桌機上又重又鈍,紅線 8 的另一面)。
   ⚠ 每一格的兩行都要短:字一長就換行,整張卡變高 → 上面那張「怎麼玩」被擠掉一半。 */
const BLK_GEST = [
  ['<path d="M14.4 5.4L7.2 12l7.2 6.6"/>', "左邊", "往左 · 按住連發"],
  ['<path d="M9.6 5.4L16.8 12l-7.2 6.6"/>', "右邊", "往右 · 按住連發"],
  ['<path d="M19 12a7 7 0 10-2.4 5.3"/><path d="M19.4 6.6v4.8h-4.8"/>', "旋轉", "順時針"],
  ['<path d="M12 4v10m-4.4-3.6L12 14.8l4.4-4.4M5.6 19.4h12.8"/>', "短按", "直接落地"],
  ['<path d="M12 4v10m-4.4-3.6L12 14.8l4.4-4.4M5.6 19.4h12.8"/>', "按住", "慢慢降"]
];
function blkGestHtml(){
  const cells = BLK_GEST.map(g =>
    '<div class="blk-gest-it">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        g[0] + '</svg>' +
      '<span>' + g[1] + '<b>' + g[2] + '</b></span>' +
    '</div>').join("");
  return '<div class="blk-gest-head">四顆鈕在畫面<b>最下面</b>:左邊兩顆移動、' +
         '右邊是旋轉與落地(同一顆<b>短按落地、按住慢慢降</b>)。不必按得很準,' +
         '按在附近就算那一顆。</div>' +
         '<div class="blk-gest-grid">' + cells + '</div>' +
         '<div class="blk-gest-kb">電腦鍵盤:方向鍵移動 · <b>空白鍵</b>直接落地 · ' +
         '<b>↑ / X</b> 順轉 · <b>Z</b> 逆轉</div>';
}
function paintGestCards(){
  const html = blkGestHtml();
  ["blkGestCard", "blkGuideBody"].forEach(id => { const el = $(id); if(el) el.innerHTML = html; });
  const atk = $("blkAtkCard");
  if(atk) atk.innerHTML = blkAtkHtml();
}

/* ---------- 攻擊表:四格圖(v2.15.3)----------
   ★ 它取代的是進場頁那一串數字(「消 2 列送 1 行、3 列送 2 行、消 4 列送 4 行」)——
     數字要在腦子裡對起來,而且看完不會記得。圖是**一眼可比**的:
     左邊那疊亮幾條、右邊就掉出幾塊,四格並排,差別自己跳出來。
   ⚠⚠ 「消 1 列送 0 行」**一定要畫進去**,而且要畫成空的。
     它才是這張表真正要講的事 —— 只會消單行的人送出 0,這正是 Combo 加成存在的理由
     (見 rules.js 的 comboAtk 註解)。少了這一格,新手看完只會覺得「消行就會攻擊」。
   ⚠ 一律自繪 SVG,不用字元 / emoji 箭頭(紅線 8:U+25B6 那一段在各機台字形不一,
     而彩色 emoji 不吃 color → 換主題就跟著醜)。
   ⚠ 這裡**不重複定義攻擊量** —— 數字要與 rules.js 的 ATK 對得起來,所以直接讀它。
     寫死一份就是「規則改了、說明沒改」的雙胞胎。 */
/* ⚠⚠ 兩根柱子**都固定畫四格**(空的畫暗色),不可以只畫有的那幾格 ——
     四格一律等高才比得出來「消 2 送 1」與「消 4 送 4」差多少;
     只畫實心的話每一格的柱子高度不一樣,眼睛沒有基準線可以對。
   ⚠ 一列四格是硬需求,不是美感:這張圖住在 .blk-howto 裡,而那個框在小螢幕上是
     **會縮、會捲**的唯一一塊(其餘都是 flex:none)。排成兩列就會被攔腰切掉
     —— 第一版正是這樣,截圖才看得出來。 */
function blkAtkCell(n){
  const out = BLK.ATK[n] || 0;
  const col = (x, k, cls) => {
    let s = "";
    for(let i = 0; i < 4; i++)
      s += '<rect x="' + x + '" y="' + (23 - i * 7) + '" width="10" height="6" rx="1.4" class="' +
           (i < k ? cls : "blk-atk-dim") + '"/>';
    return s;
  };
  return '<div class="blk-atk-it' + (n === 4 ? " blk-atk-hot" : "") + '">' +
    '<svg viewBox="0 0 30 30" width="38" height="38" aria-hidden="true">' +
      col(2, n, "blk-atk-lit") + col(18, out, "blk-atk-garb") +
    '</svg>' +
    /* ⚠ 標籤**只能一行**:這張圖住在一個 120px 高、會捲的框裡,兩行的第二行
       (也就是「送幾行」—— 整張表的重點)會剛好被切掉。截圖量過兩次。 */
    '<span>消 ' + n + ' <b>→ 送 ' + out + '</b></span>' +
  '</div>';
}
/* ⚠ 這裡**只回那張圖**,說明文字留在 blocks.html 的內文裡 ——
   卡片自己再帶一段 foot 的話它會高到被那個捲動框切掉(這一頁沒有多餘的垂直空間)。 */
function blkAtkHtml(){
  return '<div class="blk-atk-grid">' + [1, 2, 3, 4].map(blkAtkCell).join("") + '</div>';
}
/* 說明蓋板。⚠ 單機時它開著方塊要停住(BLK_VEILS 有登記),而**連線刻意不停**
   —— 別人還在玩,自己看說明不能讓全場等你(同設定蓋板那一條)。 */
function openBlkGuide(){ const el = $("blkGuideVeil"); if(el) el.classList.add("show"); }
function closeBlkGuide(){ const el = $("blkGuideVeil"); if(el) el.classList.remove("show"); }

/* ==========================================================================
   大廳的示範局(v2.15.3)—— 兩台電腦互打,等人的時候自己跑
   ──────────────────────────────────────────────────────────────────────────
     ★ 為什麼是動的:這一頁的規則是**一串因果**(消掉 → 飛過去 → 把對方頂高),
       不是一條定義。文字寫三行還是不懂,看一次就懂 —— 而大廳等人那 30 秒
       本來就是空的。**零操作、零強迫,不想看的人也不會被擋住。**
     ⚠ 走 setInterval **不是 rAF**:rAF 在非對局畫面是睡著的(BLKB.sleep()),
       而這裡刻意不吵醒它 —— 大廳不需要 60 FPS,一秒十幾幀就夠看。
     ⚠ 自己畫兩塊小畫布,**不要接到 board.js 的 foeEls** —— 那一套跟著對局的
       fitFoes() 走,借過來就會在大廳裡改到盤面的尺寸(震盪那一族)。
     ⚠ 離開大廳一定要 stop():留著跑就是在別的畫面裡白燒電池。
   ========================================================================== */
const DEMO_MS = 70;                     // 一步多久(不是 60 FPS,夠看就好)
const DEMO_CELL = 4;                    // 一格幾 px
let demoT = null, demoA = null, demoB = null, demoMemA = null, demoMemB = null;
let demoHit = 0;                        // 攻擊的閃動剩幾步
function demoBlank(seed){
  /* ⚠ 暖身一定要關(shield:0):開著的話示範局前 20 秒**看不到任何垃圾行被頂上來**,
     而那正是這段示範唯一要講的事。 */
  return BLK.blank({ seed: seed, rules: { mode: "ko", secs: 180, shield: 0, combo: true } });
}
function demoStart(){
  if(demoT) return;
  const cvA = $("blkDemoA"), cvB = $("blkDemoB");
  if(!cvA || !cvB) return;
  [cvA, cvB].forEach(cv => {
    cv.width = BLK.COLS * DEMO_CELL;
    cv.height = BLK.VIS * DEMO_CELL;
  });
  demoA = demoBlank(20260922);
  demoB = demoBlank(731157);
  demoMemA = BLKAI.newMem();
  demoMemB = BLKAI.newMem();
  demoHit = 0;
  demoT = setInterval(demoStep, DEMO_MS);
}
$("blkSetupHelp").addEventListener("toggle", e => {
  if(!$("blkSetup").classList.contains("hidden") && e.target.open) demoStart();
  else demoStop();
});
function demoStop(){
  if(demoT){ clearInterval(demoT); demoT = null; }
}
function demoStep(){
  const lv = BLKAI.levelOf("norm");
  /* A 打 B、B 打 A。⚠ `BLKAI.step()` 回的事件裡就住著「這一手送出幾行」——
     吞掉它的話畫面上會是「兩邊都在消行,但誰都不會被頂高」(ai.js 的紅線)。 */
  demoSide(demoA, demoMemA, demoB, lv, true);
  demoSide(demoB, demoMemB, demoA, lv, false);
  demoDraw($("blkDemoA"), demoA);
  demoDraw($("blkDemoB"), demoB);
  const mid = $("blkDemoMid");
  if(mid){
    if(demoHit > 0){ demoHit--; mid.textContent = "垃圾行 →"; mid.classList.add("blk-demo-fire"); }
    else { mid.textContent = "→"; mid.classList.remove("blk-demo-fire"); }
  }
}
function demoSide(st, mem, foe, lv, isA){
  if(st.dead){ demoRevive(st, mem); return; }
  const evs = BLKAI.step(st, mem, DEMO_MS, lv, Math.random).concat(BLK.tick(st, DEMO_MS));
  evs.forEach(ev => {
    if(ev && ev.t === "lock" && ev.out > 0){
      BLK.queueGarbage(foe, ev.out, Math.floor(Math.random() * BLK.COLS), isA ? "a" : "b");
      demoHit = 6;
    }
  });
}
function demoRevive(st, mem){
  BLK.revive(st);
  mem.target = null; mem.k = -1;
}
function demoDraw(cv, st){
  if(!cv || !st) return;
  const c = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  for(let y = BLK.TOP; y < BLK.ROWS; y++)
    for(let x = 0; x < BLK.COLS; x++){
      const v = st.board[y][x];
      if(!v) continue;
      c.fillStyle = (v === BLK.GARB) ? BLKB.COL_GARB : (BLKB.COL[v - 1] || "#fff");
      c.fillRect(x * DEMO_CELL, (y - BLK.TOP) * DEMO_CELL, DEMO_CELL - 0.6, DEMO_CELL - 0.6);
    }
  const cur = st.cur;
  if(cur){
    c.fillStyle = BLKB.COL[cur.k] || "#fff";
    BLK.cellsOf(cur.k, cur.r, cur.x, cur.y).forEach(p => {
      if(p[1] >= BLK.TOP)
        c.fillRect(p[0] * DEMO_CELL, (p[1] - BLK.TOP) * DEMO_CELL, DEMO_CELL - 0.6, DEMO_CELL - 0.6);
    });
  }
}

/* ---------- 進場選單的兩層 ---------- */
function showHomeLayer(which){
  const pick = $("blkPickMode"), solo = $("blkPickSolo"), head = $("blkHomeHead");
  if(pick) pick.classList.toggle("hidden", which !== "pick");
  if(solo) solo.classList.toggle("hidden", which !== "solo");
  if(head) head.classList.toggle("hidden", which !== "pick");
  syncPageBack();
}
function paintSoloHint(){
  const el = $("blkSoloHint"); if(!el) return;
  syncSoloSeg();
  const r = Solo.rec();
  const isCustom = Solo.level() === "custom";
  const lv = isCustom ? null : BLKAI.levelOf(Solo.level());
  const body = (Solo.mode() === "sprint")
    ? ("<b>" + Solo.SPRINT_LINES + " 行競速</b>:消滿 " + Solo.SPRINT_LINES + " 行,比誰快。" +
       (r.sprint ? "你最快 <b>" + (r.sprint / 1000).toFixed(1) + " 秒</b>。" : "還沒有紀錄。"))
    : (Solo.mode() === "vs")
      ? ("<b>對電腦</b>:互相送垃圾行,先堆爆的輸。" +
         (isCustom
           ? "<b>🛠️ 自訂強度</b>:自選每台電腦個別難度。<br>"
           : ("<b>" + lv.emoji + " " + lv.name + "</b>:" + esc(lv.desc) + "<br>")) +
         ((r.win + r.lose) ? ("你目前 <b>" + r.win + " 勝 " + r.lose + " 敗</b>。") : "還沒有交手紀錄。"))
      : ("<b>練習(無盡)</b>:一路堆到爆為止,重力每 30 秒快一階。" +
         (r.best ? "你最高 <b>" + r.best + " 行</b>。" : "還沒有紀錄。"));
  el.innerHTML = body + "<br>" +
    "操作是畫面<b>最下面那四顆鈕</b>(上一層有圖解;對局中按房間框的「<b>?</b>」也看得到)。<br>" +
    '<span class="blk-warn">◆ 手感不順就調下面那排「移動速度」—— 那是這個遊戲最該先調的東西。</span>';
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
  const box = $("blkCustomLineup"); if(!box) return;
  const n = Solo.foeN();
  const lvs = Solo.customLvs();
  const tiers = [
    { key: "easy", label: "🙂 輕鬆" },
    { key: "norm", label: "😎 普通" },
    { key: "hard", label: "🔥 硬仗" }
  ];
  const items = box.querySelectorAll(".blk-custom-item");
  if(items.length === n){
    items.forEach((item, i) => {
      const curLv = lvs[i] || "norm";
      const seg = item.querySelector(".seg");
      if(seg){
        [...seg.children].forEach(b => b.classList.toggle("on", b.dataset.lv === curLv));
      }
    });
    return;
  }
  let html = "";
  for(let i = 0; i < n; i++){
    const curLv = lvs[i] || "norm";
    html += '<div class="blk-custom-item" data-foe-idx="' + i + '">' +
      '<span class="blk-custom-lbl">🤖 電腦 ' + (i + 1) + '</span>' +
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
  set("blkModeSeg", "mode", Solo.mode());
  set("blkLvSeg", "lv", Solo.level());
  set("blkFoeNSeg", "foen", Solo.foeN());
  set("blkVsModeSeg", "vsmode", v.mode);
  set("blkVsSecsSeg", "vssecs", v.secs);
  set("blkVsShieldSeg", "vsshield", v.shield);
  set("blkVsTargetSeg", "vstarget", v.target);
  set("blkVsRushSeg", "vsrush", v.rush ? "1" : "0");
  set("blkVsHcSeg", "vshc", v.hc ? "1" : "0");
  /* ★ 文案共用 BLK.NOTES —— 與大廳同一份,單機不另外抄一次(見 rules.js 的 NOTES) */
  note("blkNoteVsMode", BLK.noteOf("mode", v.mode));
  note("blkNoteVsShield", BLK.noteOf("shield", v.shield));
  note("blkNoteVsTarget", BLK.noteOf("target", v.target));
  note("blkNoteVsRush", BLK.noteOf("rush", v.rush));
  note("blkNoteVsHc", BLK.noteOf("hcSolo", v.hc));
  /* ★★ 「對手」與「強度」這兩格的文案是**算出來的**,不是查表的 ——
     它要回答的是「我選這個會配到誰」,而混搭的名單只有 Solo.lineup() 知道。
     ⚠ 這一行存在的理由與大廳那幾行一樣:欄位名稱本身不帶資訊。 */
  const names = Solo.lineup().map(l => l.emoji + " " + l.name);
  note("blkNoteFoeN", (names.length > 1)
    ? ("場上會有 <b>" + (names.length + 1) + " 個人</b>(你 + " + names.length + " 台電腦)," +
       "而且<b>電腦之間也會互打</b>。")
    : "1 對 1。想試三個人以上的感覺就選 2 台或 3 台。");
  note("blkNoteLv", "這一局會配到:<b>" + names.join("</b> · <b>") + "</b>");
  /* 對電腦那一整組只有「對電腦」用得到 → 其他玩法整批收起來
     (留著只會讓人以為練習也有電腦)。 */
  const isVs = Solo.mode() === "vs";
  document.querySelectorAll(".blk-vs-row").forEach(el => el.classList.toggle("hidden", !isVs));
  /* 這兩格只有 K.O. 賽有意義(淘汰賽沒有時間限制)—— 同大廳那一條。 */
  const koOnly = isVs && v.mode === "ko";
  ["blkVsSecsRow", "blkVsRushRow"].forEach(id => {
    const el = $(id); if(el) el.classList.toggle("hidden", !koOnly);
  });
  /* 自訂電腦強度：只有在對電腦且強度選「自訂」時才展開 */
  const isCustom = isVs && Solo.level() === "custom";
  const elCustom = $("blkCustomLvsRow");
  if(elCustom){
    elCustom.classList.toggle("hidden", !isCustom);
    if(isCustom) paintCustomLineup();
  }
}
/* ⚠ 操作方式那兩格設定(手勢 / 兩者 / 按鈕)v2.15.1 **整個拿掉了** ——
   只剩按鍵,沒有旋鈕可以調;「?」蓋板現在純粹是說明。
   ⚠ v2.15.0 也已經拿掉「按鈕位置」那一格 —— 鈕一律在最下面,
     兩種擺法由 board.js 的 pickPad() 量出來自己挑。 */

/* 蓋板(設定 / 表情 / 自訂語音 / 問題回報 / 房間分享)開著的時候,單機不要繼續掉方塊。
   ⚠ 另外十四頁是回合制,蓋板開著頂多是「輪到你但你沒動」;**這一頁是即時的** ——
     不擋的話就是「你去調個音量,回來人就沒了」(實測:設定蓋板開著的 3 秒內盤面一直在變)。
   ★ 判斷用 `.show` —— 十五頁的蓋板統一靠這個 class 開關(見 ui-kit 的 BACK_LAYERS)。
   ★ **不必另外做「恢復」**:canPlay() 一回 false 規則層就不再 tick,
     而計時讀的是 st.time(solo.js 的 ms())→ 蓋板那幾秒天然不算,關掉就原地接上。
   ⚠ 結果卡(#veil)刻意不列 —— 它出現時 ended 已經是 true,遊戲早就停了。
   ⚠⚠ **連線刻意不吃這一條** —— 別人還在玩,自己開設定不能讓全場等你。 */
const BLK_VEILS = ["setVeil", "fbVeil", "emoteVeil", "myVoiceVeil", "qrVeil", "blkGuideVeil"];
function blkVeilOpen(){
  for(let i = 0; i < BLK_VEILS.length; i++){
    const el = $(BLK_VEILS[i]);
    if(el && el.classList.contains("show")) return true;
  }
  return false;
}

/* ---------- 盤面 ----------
   ★ 規則事件要分流到單機 / 連線。盤面自己不知道在哪一種模式(見 board.js 檔頭)。 */
BLKB.mount({
  onEvents(evs, st){
    if(Solo.active()) Solo.onEvents(evs, st);
    else if(typeof MP !== "undefined") MP.onEvents(evs, st);
  },
  canPlay(){
    if(Solo.active()) return !Solo.paused() && !Solo.counting() && !blkVeilOpen();
    return (typeof MP !== "undefined") ? MP.canPlay() : false;
  },
  /* 每一幀的鉤子:單機對電腦在這裡推進電腦那一份狀態 */
  onFrame(dt){
    /* 設定／說明蓋板開著時,單機所有參賽者一起停(同泡泡對戰);連線照常走(紅線 ㉓)。
       ⚠ 2026-09-24 以前這裡沒擋 → 蓋板開著時電腦照打,只有我停住;
         開局倒數也扣這裡的 dt,不擋的話蓋板開著倒數照樣跑完。 */
    if(Solo.active()){
      if(!blkVeilOpen()) Solo.onFrame(dt);
    }
    else if(typeof MP !== "undefined" && MP.onFrame) MP.onFrame(dt);
  }
});

/* ---------- 進場選單 ---------- */
$("blkGoOnline").addEventListener("click", () => {
  if(typeof MP !== "undefined") MP.openConnect();
  else showToast("連線對戰還在施工中 —— 先玩單機 🙂");
});
$("blkGoSolo").addEventListener("click", () => { paintSoloHint(); showHomeLayer("solo"); });
$("blkSoloCfgBack").addEventListener("click", () => showHomeLayer("pick"));
segPick("blkModeSeg", "mode", v => Solo.setMode(v));
$("blkHelpBtn").addEventListener("click", openBlkGuide);
$("blkSoloHelpBtn").addEventListener("click", openBlkGuide);
$("blkGuideClose").addEventListener("click", closeBlkGuide);
$("blkGuideVeil").addEventListener("click", e => { if(e.target === $("blkGuideVeil")) closeBlkGuide(); });
segPick("blkLvSeg", "lv", v => Solo.setLevel(v));
const boxCustom = $("blkCustomLineup");
if(boxCustom){
  boxCustom.addEventListener("click", e => {
    const btn = e.target.closest("button[data-lv]"); if(!btn) return;
    const seg = btn.closest(".seg[data-foe-idx]"); if(!seg) return;
    const idx = parseInt(seg.dataset.foeIdx, 10);
    const lv = btn.dataset.lv;
    Solo.setCustomLevel(idx, lv);
    paintSoloHint();
  });
}
/* 對電腦的那一整組(v2.15.4)。⚠ segPick 會在選完之後叫 paintSoloHint() →
   而它會 syncSoloSeg() → 那幾行「隨選隨變」的文案跟著更新,不必各自再叫一次。 */
segPick("blkFoeNSeg", "foen", v => Solo.setFoeN(+v));
segPick("blkVsModeSeg", "vsmode", v => Solo.setVs("mode", v));
segPick("blkVsSecsSeg", "vssecs", v => Solo.setVs("secs", +v));
segPick("blkVsShieldSeg", "vsshield", v => Solo.setVs("shield", +v));
segPick("blkVsTargetSeg", "vstarget", v => Solo.setVs("target", v));
/* ⚠ rush 在房規裡是布林 —— dataset 拿到的是字串 "0" / "1",不轉的話 "0" 是 truthy。 */
segPick("blkVsRushSeg", "vsrush", v => Solo.setVs("rush", v === "1"));
segPick("blkVsHcSeg", "vshc", v => Solo.setVs("hc", v === "1"));
$("blkStartSolo").addEventListener("click", () => Solo.start());

/* ---------- 單機的列 / 結果卡 ---------- */
/* 點對手的小盤 = 指定只打他 / 改回隨機。
   ⚠ 小盤的 DOM 是 board.js 執行期建的 → 只能用事件委派掛在容器上。
   ⚠⚠ **這一條不可以只掛在連線那一區裡**(v2.15.4 之前是)—— 單機多台電腦之後
     它兩邊都要能用,而那一區整段包在 `typeof MP !== "undefined"` 裡面。 */
if($("blkFoes")) $("blkFoes").addEventListener("click", e => {
  const i = BLKB.foeAt(e.target);
  if(i < 0) return;
  if(Solo.active()) Solo.tapFoe(i);
  else if(typeof MP !== "undefined") MP.tapFoe(i);
});
$("blkSoloExit").addEventListener("click", () => Solo.quit());
$("blkSoloAgain").addEventListener("click", () => Solo.again());
$("blkSoloHome").addEventListener("click", () => Solo.quit());
$("blkPauseBtn").addEventListener("click", () => Solo.togglePause());
$("winPeek").addEventListener("click", peekBoard);
$("reopenWin").addEventListener("click", showResult);

/* ---------- 連線 ----------
   ⚠ 一律 `typeof MP !== "undefined"` 包起來(同 ui-kit 對 Talk / RoomShare 的做法)——
     將來若把 adapter 拿掉,這一支不會整頁 ReferenceError。 */
(function bindMP(){
  if(typeof MP === "undefined") return;
  /* 房規 */
  $("blkModeSegMp").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setMode(b.dataset.mode); });
  $("blkSecsSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setSecs(b.dataset.secs); });
  $("blkShieldSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setShield(b.dataset.shield); });
  $("blkTargetSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setTarget(b.dataset.target); });
  /* ⚠ rush 在房規裡是布林 —— dataset 拿到的是字串 "0" / "1",不轉的話 "0" 是 truthy。 */
  $("blkRushSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setRush(b.dataset.rush === "1"); });
  $("blkLockSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setLock(b.dataset.lock === "1"); });
  /* 讓分兩格:上面那格是房規(只有房主按得動),下面那格是每個人自己的(存進本機偏好) */
  $("blkHcSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b) MP.setHc(b.dataset.hc === "1"); });
  $("blkHcMeSeg").addEventListener("click", e => { const b = e.target.closest("button"); if(b){ MP.setMyHc(b.dataset.hcme === "1"); savePrefs(); } });
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
  /* 賽後表情列:四顆一鍵送給全部人;😀 開完整面板。節流 600ms(結果卡是強制回應視窗,很容易連點)
     ⚠ v2.13.0 ~ v2.14.0 這一段漏了 —— HTML 照抄了別頁的那排鈕,事件卻沒綁,按了毫無反應。
     單機時整排由 CSS 藏起來(body.solo-on .blk-react-row),所以這裡不必再判斷。 */
  let reactAt = 0;
  $("blkReactRow").addEventListener("click", e => {
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

/* ---------- 共用綁定(設定 / 表情 / 音訊 / SW / 版號) ---------- */
bindCommonUI();
bindPageBack({ sub: "blkPickSolo" });
bindAudioLifecycle();
registerSW();
paintVersion();
initUpdateCheck(() => !Solo.playing() && (typeof MP === "undefined" || !MP.isOnline()));
initFullscreenKeep();

/* ---------- 啟動 ---------- */
buildSwatches();
/* 大畫面:⚠ 一定要排在 loadPrefs() **之前** —— 偏好會回頭叫 BigMode.set()。
   ⚠ 名字用「大 / 小」,不准沾「全螢幕」(那是 ⛶ 那一顆的事)。 */
BigMode.init({
  cls: "blk-big", btn: "blk-bigbtn", name: "大畫面",
  live: () => { const el = $("blkPlay"); return !!el && !el.classList.contains("hidden"); },
  save: savePrefs,
  /* 盤面是 JS 量出來的 → 切大 / 小之後一定要重量一次 */
  after: () => BLKB.fitBoard()
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
/* ★ 一定要是最後一行:同步啟動都跑完了,按鈕才真的能按(見 bootReady 的註解)。
   ⚠ 漏掉這一行的下場是「這一頁的按鈕永遠灰著」—— tools/test-boot.js 在守。 */
bootReady();

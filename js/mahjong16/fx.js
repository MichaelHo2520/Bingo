"use strict";

/* ============================================================================
   台灣 16 張麻將 —— 動效層(M16Fx)

   碰 / 槓 / 吃 / 聽牌的漢字爆發、胡牌的全螢幕特寫、補花的花瓣、流局的薄霧。
   一句話:**這一支只畫「情緒」,一個 px 的版面都不碰。**

   ── ★ 為什麼是獨立一支,不塞進 board.js ────────────────────────────────────
     board.js 的 render() 在**一次呼叫裡**會把 host.innerHTML 重建**最多七次**
     (牌寬夾取要量兩點解一條直線,再收斂幾次)。任何掛在那段 HTML 裡的動畫都會
     跟著重跑 —— 所以這一支的節點**全部是 JS 建的持久節點**,一個都不進 paint()。
     同一個理由讓 `#m16Acts`(動作列)與 `.m16-cele`(胡牌光環)也待在
     `.mj-play` 底下不動。

   ── ★★ 幾何紅線:這一頁的牌寬是「寬度算出來、再被總高度夾」的 ──────────────
     **任何讓總寬 / 總高變一點的東西都會讓整副牌換一次大小**(notes/11 的〇節,
     曾經因為 discardHint() 多五個字,牌寬就從 27 掉到 25)。所以這裡每一個節點
     都是 `position:absolute|fixed` + `inset:0` + `pointer-events:none` ——
     它們在版面上完全不存在,`scrollHeight` 量不到,也擋不到任何操作。
     ⚠ 這條沒有中間地帶:任何一個特效節點只要參與 flex 流,症狀就是
       「有人碰牌之後整副牌忽然小一級」,而且再也不會變回來(只縮不放)。

   ── ★★ 高潮特效一定要畫在結果卡**之上**,否則等於沒做 ─────────────────────
     胡 / 流局的那一刻 `#veil`(**z-index:50 的全螢幕蓋板**)立刻蓋上來 ——
     單機是 `finish() → paintResult() → showResult()` 同一串,連線那邊
     `showOutcome` 也是同一波 diff。所以「胡!」特寫掛 **body**、
     `position:fixed`、**z-index:61**;掛進 `.mj-play`(z-index 6 那一層)
     就會被結果卡遮掉,做了看不到。
     ⚠⚠ 它蓋在結果卡上面,所以 `pointer-events:none` 這條是**正確性不是禮貌**:
       少了它,那 1.4 秒裡「下一局」按不下去,而使用者只會覺得「卡住了」。
     ★ 既有的 `M16B.celebrate()`(牌桌上的光環,v2.2.4)**刻意留著不動** ——
       它是牌桌內那一層的光暈,與這裡的全螢幕特寫是兩件事(桌子亮了 + 字砸下來)。

   ── ★ 驅動:現成的兩個 diff 呼叫點,不新增動作點 ───────────────────────────
     `adapter.js` 的 applyGame 與 `solo.js` 的 sfxTick 本來就在算 M16Sfx 的事件
     (「剛才發生了什麼」完全從前後兩份 state 的差異算出來),這裡直接吃那個陣列
     → 單機與連線**共用同一份判斷**,沒有變成第三份「兩份」。
     這正是 notes/11 第 3 條紅線的做法:**不要在動作點插 `Fx.xxx()`**
     (單機是本地換 state、連線要等交易回來,動作點的路徑完全不同)。

   ── ★ 牌情安全 ─────────────────────────────────────────────────────────────
     這一支畫的每一件事都是**已經發生、而且全桌都看得到**的:吃碰槓成立(牌攤在
     桌上了)、宣告聽牌(公開動作)、補花、胡、流局。
     ⚠⚠ **絕對不可以**為「有人在考慮吃碰」加任何特效 —— 那是 notes/11 第一條
       紅線要堵的六條管道之一,而動畫比聲音更藏不住(鄰座直接看到你手機閃了)。

   ── ★★ 要不要播,只看那顆開關;**刻意不看 prefers-reduced-motion** ────────────
     ⚠⚠ v2.4.0 做過一次系統偏好降級,**當場出事**:使用者的回報是「實際在單機對戰,
       沒感覺到有什麼變化」,而程式與 CSS 都是好的 —— 只是整組被降級成 0.9 秒的
       淡入淡出、粒子還一顆都不畫。而且查下來連前提都不成立:那台機器的 Windows
       動畫效果是**開著**的,`reduce: true` 是自動化 Chrome 自己的預設。
     ★ 三個理由讓它整段拿掉:①這一頁的其他動畫(胡牌光環 / 摸牌 / 金片)一律不看
       系統偏好 → 只降級新特效就是同一頁兩套標準;②**這一頁有自己的開關**
       (設定面板「動畫特效」),比系統設定更容易發現也更具體;③想同時保留兩者
       只會得到「死碼」或「開了卻很弱」——後者正是這次踩到的坑。
     → 完整的理由與「不要再加回來」寫在 styles.src.css 的 ⑨ 那一段。
     ⚠ 結果卡的番種展開與台數滾動**不受那顆開關管**:它們是結果卡的內容,不是慶祝。
   ============================================================================ */

const M16Fx = (function(){

  /* ⚠ 這裡刻意**沒有** prefers-reduced-motion 的判斷,理由見檔頭與
     styles.src.css 的 ⑨ 那一段(加過一次、當場出事、已經整段拿掉)。
     播放路徑上唯一的閘門就是下面那顆 `fxOn`。 */

  /* ---------- 開關(個人偏好,存在 mahjong16.prefs.v1 的 `fx` 欄位)-----------
     ★★ 為什麼這顆一定要有:**同一位使用者在暗棋否決過兩次同類的東西** ——
       浮出「⚔️ 吃掉 + 棋子名字」的文字標籤 → 「效果很差,一點都不像是正式發行的
       遊戲」;改成震波 + 火花 + 亂飛 → 「現在這樣也很糟,看起來太亂了」
       (notes/19,最後定案是「吃子跟移動用同一種語彙」)。
     ★ 那兩次否決的共同點是「**不符合那個棋類的慣例**」,而喊牌大字恰好是麻將的
       主流語彙(雀魂 / 明星三缺一 / 大多數台麻 App 都有「碰」「胡」的衝擊字),
       所以這裡預設**開**;但現場真的覺得吵,要**當場關得掉**,
       這比事後回頭拆程式便宜太多。
     ⚠ 它只管這一支畫的東西(漢字 / 胡牌特寫 / 花瓣 / 薄霧 / 聽牌藍光)。
       摸牌滑入(v2.3.3)與落桌回彈是**操作手感**不是慶祝 —— 那兩個是 160 / 200ms
       的「牌到位了」訊號,關掉只會讓牌桌變得沒有回饋,所以不受這顆管。 */
  let fxOn = true;

  /* 對局中的舞台。★ 一律**每次重新問** DOM,不快取:
     這一頁的 `.mj-play` 雖然不會被換掉,但快取一個節點就等於多一條「離開牌桌又
     回來時指著孤兒節點」的路,而這裡省不到任何東西(一局最多叫幾十次)。 */
  function stage(){ return document.getElementById("m16Play"); }

  /* ---------- 一次性節點的生命週期 ----------------------------------------
     ★★ 同一個 kind 一律**先移除舊的再建新的,絕不疊加** —— 與 celebrate() 同一條
       冪等要求:斷線重連 / 續局那一刻可能再收到一次帶 over 的快照,而
       「疊加」在飛行棋是踩過的坑(批次同步連播 → 二十幾秒的慢動作)。
     ⚠ 播完一定要自己 remove:留著的話下一局的畫面上會有一個看不見、
       但吃 z-index 的空層(同 celebrate 那條註解)。 */
  const live = Object.create(null);
  function drop(kind){
    const it = live[kind];
    if(!it) return;
    delete live[kind];
    if(it.t) clearTimeout(it.t);
    if(it.el && it.el.parentNode) it.el.remove();
  }
  function show(kind, el, ms, toBody){
    drop(kind);
    const host = toBody ? document.body : stage();
    if(!host) return null;
    /* ⚠ 這些節點對輔助技術一律是裝飾:它們講的每一件事,動作列 / 結果卡 /
       toast 都已經用文字說過一次了。 */
    el.setAttribute("aria-hidden", "true");
    host.appendChild(el);
    live[kind] = { el:el, t:setTimeout(function(){ drop(kind); }, ms) };
    return el;
  }
  /* 換局 / 離開牌桌:把還在飛的東西全部收掉。
     ★ 呼叫端與 `M16B.resetOrder()` / `resetFit()` 同一批(那幾行本來就在換局的路上)。 */
  function clear(){ Object.keys(live).forEach(drop); }

  /* ---------- 粒子(金粉 / 花瓣)----------------------------------------------
     CSS 只認三個變數:--a(飛出去的角度)、--d(距離)、--s(大小倍率),隨機值在這裡給。
     ⚠ 顆數刻意壓在 14 以內:情緒最高點那一刻,牌桌 + 倒數環 + 結果卡的淡入本來就
       同時在跑,粒子再多手機就掉幀 —— 而掉幀正好發生在最想要「爽」的那 0.5 秒。
     ⚠ 顆數是唯一的節制手段(這裡不再有 reduced-motion 那道閘,見檔頭)。 */
  function dust(n, cls){
    let h = "";
    for(let i=0;i<n;i++){
      /* 角度平均分佈再各自抖一點:純隨機會結塊(看起來像壞掉),
         純平均看起來像時鐘刻度。 */
      const a = Math.round(360 / n * i + (Math.random() * 24 - 12));
      const d = 42 + Math.round(Math.random() * 48);
      const s = (Math.random() * 0.5 + 0.75).toFixed(2);
      const dl = (Math.random() * 0.12).toFixed(3);
      h += '<i class="' + cls + '" style="--a:' + a + 'deg;--d:' + d + 'px;--s:' + s +
           ';animation-delay:' + dl + 's"></i>';
    }
    return h;
  }

  /* ==========================================================================
     ① 漢字爆發:碰! / 槓! / 吃! / 聽牌
     ── 位置刻意**偏上**,不是正中央 ──────────────────────────────────────────
       正中央住著宣告面板(`.m16-claim`)。v2.3.4 之後「結果一定就提早收掉宣告
       視窗」,所以「別人碰了」那一刻我的面板可能正開著 —— 字要**解釋**那件事,
       不可以蓋住它(蓋住就從「原來是被碰走了」變成「我按錯了嗎」)。
       ⚠ 往上推走 CSS 的 `transform:translateY(-16%)`,**不可以用 `padding-top:%`**
         (padding 的百分比相對**寬度**:橫向 800×300 的 26% = 高度的 69%,
          字會砸在手牌上;而且粒子的原點在那一層的正中央,只推字會脫開)。
     ⚠ 字面用「碰!」而不是「碰」:感嘆號是這件事的一半(牌桌上那是喊出來的)。
     ========================================================================== */
  const WORD = { pong:"碰!", kong:"槓!", chow:"吃!", ready:"聽牌" };

  function word(kind, who){
    const txt = WORD[kind];
    if(!txt) return;
    const el = document.createElement("div");
    el.className = "m16-fx m16-fxw m16-fxw-" + kind;
    /* ⚠ 名字是玩家自己輸入的 → 一律 esc()(notes/07 踩坑 #9;這裡走 innerHTML)。 */
    el.innerHTML = (who ? '<span class="m16-fxwho">' + esc(who) + '</span>' : "") +
                   '<b>' + txt + '</b>' +
                   dust(kind === "ready" ? 8 : 10, "m16-fxdust");
    // 900ms 動畫 + 粒子最多 120ms 延遲,留一點餘裕
    show("word", el, 1120);
  }

  /* ==========================================================================
     ② 胡 / 自摸的全螢幕特寫(Finisher)
     ── ★ 只在「我贏」時播,這是刻意的 ────────────────────────────────────────
       全螢幕金色特寫是給贏家的獎賞;放給剛放槍的人看就是在他臉上放煙火。
       別人胡的時候該講的話結果卡第一行已經寫得很清楚了(誰胡誰放槍 · 幾台),
       而且**不遮結果卡**本身就是對輸家比較好的處理。
       ⚠ 既有的 `celebrate()` 光環仍然全桌都播(v2.2.4 的行為原封不動)。
     ── ★ 為什麼掛 body 而不是 `.mj-play` ───────────────────────────────────
       見檔頭那條:結果卡 `#veil` 是 z-index:50 的全螢幕蓋板,而且**立刻**蓋上來。
     ========================================================================== */
  function finisher(tsumo){
    const el = document.createElement("div");
    el.className = "m16-fx m16-fxfin" + (tsumo ? " tsumo" : "");
    /* 三層:暗場(把畫面壓下去,字才亮得起來)→ 放射光芒 → 燙金字 + 金幣。
       ⚠ 暗場一定要**由濃轉無**,而且在字消失之前就要退乾淨:留在畫面上等於
         把剛淡入的結果卡壓成灰的(第一版就是這樣,看起來像沒載完)。 */
    el.innerHTML =
      '<div class="m16-fxdim"></div>' +
      '<div class="m16-fxrays"></div>' +
      '<div class="m16-fxbig"><b>' + (tsumo ? "自摸!" : "胡!") + '</b></div>' +
      dust(14, "m16-fxcoin");
    /* 1.15s 主體 + 粒子延遲。⚠ 刻意**不再長**:它蓋在結果卡上面,而結果卡是
       「下一局」在的地方 —— 特寫再久就會從獎賞變成擋路(按得下去但看不見)。 */
    show("fin", el, 1300, true);
  }

  /* ==========================================================================
     ③ 流局的薄霧 —— 「化解突然結束的突兀感」
     ★ 同樣掛 body / fixed:流局也會馬上蓋上結果卡。
     ⚠ 霧只做「掠過」不做「停留」:停留就是把結果卡糊掉(它有 backdrop-filter,
       兩層疊起來會變成一片奶白)。
     ========================================================================== */
  function mist(){
    const el = document.createElement("div");
    el.className = "m16-fx m16-fxmist";
    el.innerHTML = '<i></i><i></i><i></i>';
    show("mist", el, 1500, true);
  }

  /* ==========================================================================
     ④ 補花的花瓣 —— 只有**我**補花才播
     ★ 別人補花一局會發生很多次(八張花牌 + 每次補進來又可能再補),四家都播的話
       這個特效會變成畫面上的雜訊;而「誰補花」本來就有全桌都聽得到的鈴聲 + 語音。
       同一條理由讓 sfx 的摸牌音只給自己(見 sfx.js 檔頭「刻意不做的兩件事」)。
     ========================================================================== */
  function petals(){
    const el = document.createElement("div");
    el.className = "m16-fx m16-fxpetal";
    el.innerHTML = dust(9, "m16-fxleaf");
    show("petal", el, 1400);
  }

  /* ==========================================================================
     ⑤ 我宣告聽牌:手牌邊緣一圈藍光
     ★ 只給自己 —— 這是「我進入最後直線了」的自我確認。別人宣告時我看到的是
       上面那個「聽牌」漢字 + 對手列的記號 + 全桌都播的語音,訊號已經夠。
     ⚠ 這一層掛 `.mj-play`(不是 body):它要貼著牌桌,而這一刻沒有結果卡。
     ========================================================================== */
  function tingGlow(){
    const el = document.createElement("div");
    el.className = "m16-fx m16-fxting";
    show("ting", el, 1600);
  }

  /* ==========================================================================
     ⑥ 誰做的 —— 兩段自己的 diff
     ── 吃 / 碰 / 槓:直接用現成的 `MJT.meldTakenAt()` ──────────────────────
       它回 `{ seat, kind }`,adapter 的「報一句」本來就在用 → 零重複。
       ⚠ 它認的是「明牌組數變多」,所以**加槓**(pung → kong,組數沒變)回 null。
         那時就不顯示名字,只顯示「槓!」—— 資訊沒少(誰槓的桌上看得到),
         而為了它去寫第二套 diff 不值得。
     ── 補花:自己補一小段 ────────────────────────────────────────────────────
       ⚠ 這**不是雙胞胎**:sfx 的 eventsOf 只需要回「有沒有補花」,不需要 seat;
         而 seat 是這裡獨有的需求(只播我自己那一家)。純讀、零副作用。
     ========================================================================== */
  function flowerSeats(before, after){
    const out = [];
    if(!before || !after || !before.flowers || !after.flowers) return out;
    for(let s = 0; s < after.seats; s++){
      const b = (before.flowers[s] || []).length, a = (after.flowers[s] || []).length;
      if(a > b) out.push(s);
    }
    return out;
  }

  /* ==========================================================================
     on(ev, before, after, me, nameOf) —— 唯一的入口
     ev 就是 M16Sfx.play() 回傳的那個陣列(**已經按輕重排好序**:
     zimo / hu / kong / pong / chow / discard / flower / draw / washout / ready)。
     ⚠ 一個 diff 可能同時有兩件事(「槓」+「槓上補摸」、「打牌」+「聽牌」),
       但**漢字一次只播一個** —— 兩個字疊在同一個位置就都看不清了。
       照 ev 的順序取第一個有字的那個,剛好就是「最重的那件事」。
     ========================================================================== */
  function on(ev, before, after, me, nameOf){
    if(!fxOn || !ev || !ev.length) return;
    const nm = (typeof nameOf === "function") ? nameOf : function(){ return ""; };
    const has = function(k){ return ev.indexOf(k) >= 0; };

    /* 胡 / 自摸:最高優先,而且播完就不再播別的字(那一刻沒有「順便」的事)。
       ⚠ 判斷贏家用 `after.over.seat`,不是「ev 裡有沒有 zimo」——
         zimo / hu 講的是**這一局怎麼結束**,不是「我贏了」。 */
    if(has("hu") || has("zimo")){
      const o = after && after.over;
      if(o && o.type === "win" && o.seat === me) finisher(o.from == null);
      return;
    }
    if(has("washout")){ mist(); return; }

    /* 補花:只有我那一家(可以與下面的漢字同時發生 —— 花瓣在明牌區、字在上方) */
    if(has("flower") && flowerSeats(before, after).indexOf(me) >= 0) petals();

    /* 聽牌:我自己宣告的話多一圈手牌藍光。
       ⚠ 「是我嗎」要看 after.ting[me] 在這個 diff 裡**剛剛**變成 true ——
         直接問 after.ting[me] 會在我宣告之後的每一手都亮一次。 */
    if(has("ready")){
      const tb = (before && before.ting) || [], ta = (after && after.ting) || [];
      if(!tb[me] && ta[me]) tingGlow();
    }

    let kind = "";
    for(let i = 0; i < ev.length; i++){ if(WORD[ev[i]]){ kind = ev[i]; break; } }
    if(!kind) return;

    /* 誰做的。聽牌那一格要另外找(它不動明牌),而且我自己宣告時不寫名字 ——
       「你 聽牌」讀起來像在對我說話,而這個字就是我按出來的。 */
    let who = "";
    if(kind === "ready"){
      const tb = (before && before.ting) || [], ta = (after && after.ting) || [];
      for(let s = 0; s < after.seats; s++){
        if(!tb[s] && ta[s]){ who = (s === me) ? "" : nm(s); break; }
      }
    }else{
      const tk = (typeof MJT !== "undefined" && MJT.meldTakenAt)
                 ? MJT.meldTakenAt(before, after) : null;
      if(tk && tk.seat !== me) who = nm(tk.seat);
    }
    word(kind, who);
  }

  /* ==========================================================================
     ⑦ 結果卡:台數逐項展開 + 總台數滾動 + 印章
     ── ★ 資料是現成的 ────────────────────────────────────────────────────────
       `st.over.list` 本來就帶著每一項番種(`{ name, tai }`,由 scoring.js 算),
       在這一版之前被印成一行頓號串「自摸 1、門清 1、清一色 8」。所以這裡
       **一行規則層都沒改** —— 只是把同一份資料換一種出場方式。
     ── ★ 逐項展開走 CSS 的 animation-delay,不走 JS 排程 ─────────────────────
       節點一插進 DOM 動畫就開始跑 → 不必知道結果卡什麼時候顯示,也就不會踩到
       「showOutcome 可能被重複觸發」那個坑(共用核心 v2.3.7 才修好的那條)。
       JS 只負責一件 CSS 做不到的事:**把總台數從 0 滾上去**。
     ── ⚠⚠ 必須冪等 ──────────────────────────────────────────────────────────
       同一張結果卡可能被重畫(重連 / 續局 / 房主改寫 game)。滾動跑過的節點會被
       蓋上 `data-rolled`,再叫一次就直接把終值寫上去、不重跑 ——
       不然數字會從 0 再跑一次,看起來像剛剛那一局又結算了一遍。
     ========================================================================== */
  /* 一列番種。i 是它在名單裡的順序 → CSS 用 --i 算延遲。
     ⚠ name 來自 scoring.js 的常數表(不是使用者輸入),但這裡照樣 esc() ——
       這一整支只要有一處對 innerHTML 破例,下一個人就會照抄那一處。 */
  function taiItems(list){
    if(!list || !list.length) return '<span class="m16-fxti none">無台</span>';
    return list.map(function(x, i){
      return '<span class="m16-fxti" style="--i:' + i + '">' +
               esc(x.name) + '<b>+' + (x.tai | 0) + '</b></span>';
    }).join("");
  }
  /* 結果卡那一行的 HTML(兩份呼叫端共用這一支 —— adapter.js 的 outcome 與
     solo.js 的 paintResult 只差「名字怎麼來」,算式本身一模一樣)。
       head  「小明 胡 阿弟 打的牌」那一段(呼叫端自己組好、自己 esc 好)
       o     st.over
     ⚠ 回傳字串會被塞進 `#winMsg` 的 innerHTML,所以 head 一定要是**已經 esc 過**的。 */
  function taiHTML(head, o){
    const total = o.total | 0;
    return '<span class="m16-fxhow">' + head + '</span>' +
      '<span class="m16-fxtai">' +
        taiItems(o.list) +
        /* 底台與總和:底是固定的,台是上面那些加起來的 → 分兩格才看得出因果。
           ⚠ 總和那一格要留 `data-tai`,滾動靠它認(見 armTai)。 */
        '<span class="m16-fxsum" style="--i:' + ((o.list ? o.list.length : 0)) + '">' +
          '底 ' + (o.base | 0) + ' + 台 ' + (o.tai | 0) + ' = ' +
          '<b class="m16-fxroll" data-tai="' + total + '">' + total + '</b> 台' +
        '</span>' +
      '</span>';
  }
  /* 總台數從 0 滾上去。★ 只在**呼叫端寫完 innerHTML 之後**才有節點可以抓,所以
     兩份都在自己那邊叫一次(adapter 的 outcome / solo 的 paintResult)。
     ⚠ 用 rAF 而不是 setTimeout(0):前者保證在下一次繪製之前,數字不會先閃一下終值。
     ⚠ 滾動的節奏刻意跟著位數走(台數可能是 3 也可能是 48):固定跑 12 步的話
       「3 台」會一格一格慢慢跳,看起來像壞掉。 */
  function armTai(tries){
    requestAnimationFrame(function(){
      const el = document.querySelector("#winMsg .m16-fxroll");
      /* ⚠ 連線那一份是在**共用層把字串寫進 `#winMsg` 之前**回傳的(outcome 是個 hook),
         所以第一次 rAF 通常剛好落在寫入之後 —— 但共用層哪天改成異步寫入就會抓不到。
         重試兩幀是很便宜的保險;真的找不到就安靜放棄:數字本來就已經是終值,
         少的只有滾動那一下,**資訊零損失**。 */
      if(!el){ if((tries | 0) < 2) armTai((tries | 0) + 1); return; }
      const end = +el.getAttribute("data-tai") || 0;
      if(el.getAttribute("data-rolled")){ el.textContent = end; return; }   // 冪等
      el.setAttribute("data-rolled", "1");
      /* ⚠ 只有 0 / 1 台不滾(從 0 跳到 1 沒有「累加」的感覺,只是閃一下)。
         ★ 這裡刻意**不看**系統的減少動態:番種展開與台數是結果卡的**內容**,
           不是慶祝 —— 而且它不受那顆開關管(見 setFx 的註解)。 */
      if(end <= 1){ el.textContent = end; return; }
      const steps = Math.min(14, Math.max(6, end));
      let i = 0;
      el.textContent = "0";
      const iv = setInterval(function(){
        i++;
        /* 先快後慢(ease-out):最後兩三格慢下來才有「停在那個數字上」的重量感 */
        const p = 1 - Math.pow(1 - i / steps, 2);
        el.textContent = Math.round(end * p);
        if(i >= steps){ clearInterval(iv); el.textContent = end; }
      }, 42);
    });
  }

  return {
    on, clear, armTai, taiHTML,
    /* 開關。★ 關掉的那一刻要把還在飛的東西收掉(不然剛按下去的那一秒還在動,
       看起來像沒生效)。⚠ 台數逐項展開**刻意不受它管** —— 那是結果卡的內容
       (番種與台數),不是慶祝;關掉它等於把資訊也關掉了。 */
    fxOn(){ return fxOn; },
    setFx(v){ fxOn = !!v; if(!fxOn) clear(); },
    /* 給試看頁(tools/t-mj16-fx.html):不必真的打一局就看得到每一個特效。
       ⚠ 產品碼**不呼叫這一支** —— 它繞過 diff,拿它當捷徑就等於在動作點插特效
         (notes/11 第 3 條紅線)。 */
    demo(kind, opts){
      const o = opts || {};
      if(kind === "fin") return finisher(!!o.tsumo);
      if(kind === "mist") return mist();
      if(kind === "petal") return petals();
      if(kind === "ting") return tingGlow();
      return word(kind, o.who || "");
    }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16Fx;

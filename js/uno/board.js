"use strict";

/* ============================================================================
   UNO — 盤面(UNB):牌面自繪 + 手牌 + 牌桌中央 + 動作列 + 選色盤 + 結果表。
   單機(solo.js)與連線(adapter.js)**共用這一支**,所以每一個畫面元件只有一份。

   ── ★ 牌面右下角的**色名字母**(R / Y / G / B)只在電子書主題現身 ──────────
     v1.106.0 原本任何主題都畫(電子書黑白 + 紅綠色盲兩個理由),但玩家實測反饋
     不想在牌角看到英文字母,而彩色主題下顏色本身已經夠分辨,所以改成:
       · 一般(彩色)主題:不畫 —— CSS 預設 .un-cl{display:none}
       · 電子書主題:畫 —— 轉黑白之後顏色判斷通道消失,靠字母補回來
         (見 styles.css 電子書那段的 `.un-cl{display:block}` override)
     字母本身還是 HTML(每次 render() 都會吐出來),只是彩色主題下被 CSS 藏起來
     ——不是 JS 判斷主題再決定要不要塞這段 HTML,理由是**主題可能隨時切換**,
     CSS 版本不必等下一次 render() 就會跟著換。
     ⚠ 用英文字母而不是「紅黃綠藍」:CJK 字在 20px 寬的牌角落會糊成一塊墨。
     四色變數 --un-r/y/g/b 仍然在**任何主題下都保持原值**(見 styles.css 那段 ★★★)——
     這條沒變,顏色仍然是 UNO 的規則本體。

   ── 牌面的畫法(與首頁 / 進場圖示的 .un-ic-* 是同一套視覺,但**不是同一份碼**)──
     圖示是 SVG(要能縮到 32px 還認得出來),牌面是 HTML + CSS(要能點、要能捲、
     要跟著主題換色)。兩邊刻意分開 —— 共用一份反而會讓「圖示改小」把牌面一起弄壞。
     ★ 唯一必須一致的是**顏色變數**,那一組只有一份(styles.css 的 :root)。

   ── ★ 這一頁沒有「選牌」這件事 ────────────────────────────────────────────
     大老二 / 排七要選一組牌再按出牌,UNO **點一張就是出那一張** ——
     所以沒有 sel / clearSel / 群組選取那一整套(大老二 board.js 最複雜的部分)。
     唯一的兩段式是 **Wild 要先選顏色**(選色盤),而它由 askColor() 收斂成一個 callback。

   ── ★ 音效全是合成音,**不新增任何 mp3** ──────────────────────────────────
     CLAUDE.md:動 `mp3/` 的路徑要四處一起改(sfx 的 ensureDefs、sw.js 的 CORE、
     兩支產生器)。UNO 的動作聲用 Sound.tone() 寫樂句就夠清楚了,
     省掉那條耦合 —— 也省掉「離線抓不到音檔就啞掉」那一整類問題。
   ========================================================================== */

const UNB = (function(){

  /* ==========================================================================
     一、牌面
     ────────────────────────────────────────────────────────────────────────── */
  const COL_CLS = ["un-c-r", "un-c-y", "un-c-g", "un-c-b"];

  /* 一張牌。cls = 額外的 class("can" 亮 / "no" 暗 / "tiny" 小張)
     ⚠ data-c 一定要是牌 id —— 點擊處理讀的就是它(`+el.dataset.c`)。 */
  function cardHTML(id, cls){
    const wild = UN.isWild(id);
    const c = wild ? "un-c-w" : COL_CLS[UN.colOf(id)];
    const lb = UN.labelOf(id);
    // ⚠ 兩個字的標籤(+2 / +4)要小一階,不然頂穿白橢圓兩側(見 styles.css 的 .un-lb.two)
    const two = lb.length > 1 ? " two" : "";
    let inner = '<span class="un-ov" aria-hidden="true"></span>';
    if(wild){
      /* Wild:白橢圓裡四色風車。
         ★★ 普通 Wild **不寫 W** —— 四色風車本身就是它的辨識點(而四色在任何主題下
            都保持原值,電子書主題也是,所以「看形狀就知道」在每個主題都成立)。
         ⚠⚠ 但 **+4 一定要留字** —— 風車是 Wild 與 Wild+4 **共用**的圖案,
            兩張都不寫字的話它們會長得**一模一樣**,玩家分不出「只是換色」與
            「吃 4 張」。這不是裝飾,是牌義:少了它 +4 砸過來看不出來。 */
      inner += '<span class="un-wq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
      if(UN.kindOf(id) === UN.K_W4) inner += '<span class="un-lb wild' + two + '">' + lb + '</span>';
    }else{
      inner += '<span class="un-lb' + two + '">' + lb + '</span>' +
               // ★ 色名字母(見檔頭):HTML 一律吐出來,CSS 只在電子書主題顯示
               '<span class="un-cl" aria-hidden="true">' + UN.letterOf(id) + '</span>';
    }
    return '<span class="un-card ' + c + (cls ? " " + cls : "") + '" data-c="' + id +
             '" role="button" tabindex="0" aria-label="' + esc(UN.nameOf(id)) + '">' + inner + '</span>';
  }

  /* 牌背(牌堆)。⚠ data-c 刻意給 "?" —— 寫真值等於把牌堆頂端洩漏在 DOM 屬性裡。 */
  function backHTML(cls){
    return '<span class="un-card back' + (cls ? " " + cls : "") + '" data-c="?" aria-label="牌堆">' +
             '<span class="un-bk" aria-hidden="true"></span></span>';
  }

  /* ==========================================================================
     二、音效(全合成音)
     ────────────────────────────────────────────────────────────────────────── */
  function toneSafe(f, o){ if(window.Sound && Sound.tone) Sound.tone(f, o); }
  const sfx = {
    play(){ toneSafe(560, { type:"triangle", dur:0.09, vol:0.18, slideTo:840 }); },
    draw(){ toneSafe(300, { type:"sine", dur:0.12, vol:0.16, slideTo:190 }); },
    // 跳過:短促的下行兩音(像門關上)
    skip(){ [660, 440].forEach((f, i) => toneSafe(f, { type:"square", dur:0.09, vol:0.13, delay:i*0.08 })); },
    // 迴轉:上行滑音
    rev(){ toneSafe(420, { type:"triangle", dur:0.20, vol:0.16, slideTo:880 }); },
    // +2 / +4:越重的罰抽音越低越長
    pen(n){ toneSafe(n >= 4 ? 150 : 210, { type:"sawtooth", dur:n >= 4 ? 0.34 : 0.24, vol:0.17, slideTo: n >= 4 ? 90 : 130 }); },
    // 換顏色
    color(){ [523, 659, 784, 988].forEach((f, i) => toneSafe(f, { type:"sine", dur:0.10, vol:0.12, delay:i*0.045 })); },
    // 喊 UNO:兩聲亮的
    uno(){ toneSafe(988, { type:"triangle", dur:0.12, vol:0.24 }); toneSafe(1319, { type:"triangle", dur:0.22, vol:0.22, delay:0.13 }); },
    // 被抓:下行三音(明顯是壞事)
    caught(){ [700, 520, 330].forEach((f, i) => toneSafe(f, { type:"square", dur:0.13, vol:0.16, delay:i*0.10 })); }
  };

  /* 一手打出去之後該響什麼 —— **單機與連線共用這一支**。
     ⚠ 走「前後兩份的 diff」而不是在動作點插 sfx.xxx():單機與連線的動作路徑
       完全不同,但「有人出了 +2」在兩邊是同一個 diff(同大老二 moveSfx 的理由)。 */
  function moveSfx(mv, n){
    if(UN.isDraw(mv)){ sfx.draw(); return; }
    if(UN.isPass(mv)) return;
    if(UN.isCatch(mv)){ sfx.caught(); return; }
    const id = UN.moveCard(mv);
    if(id < 0) return;
    const k = UN.kindOf(id);
    if(k === UN.K_SKIP) sfx.skip();
    else if(k === UN.K_REV) sfx.rev();
    else if(k === UN.K_D2) sfx.pen(2);
    else if(k === UN.K_W4){ sfx.pen(4); sfx.color(); }
    else if(k === UN.K_WILD) sfx.color();
    else sfx.play();
    if(UN.moveDeclared(mv)) sfx.uno();
  }

  /* ==========================================================================
     三、牌桌中央
     ──────────────────────────────────────────────────────────────────────────
       畫四件事,而它們都是**公開資訊**:
         牌河最上面那張 · **現在的有效顏色** · 方向 · 累積罰抽 · 牌堆還剩幾張
       ★★ 「現在的有效顏色」一定要**獨立畫一塊**,不可以只靠那張牌的顏色 ——
          Wild 打出去之後桌上那張是黑的,顏色只存在 st.col 裡。
          漏了它玩家會完全不知道現在該出什麼色(這是最容易漏的一格)。
       ★★ 牌堆**不畫牌背**(v1.108.0):桌上唯一該有的一張牌是牌河最上面那張 ——
          它才是「我可以接什麼」的答案。旁邊再擺一張永遠一樣的牌背,眼睛得先分辨
          「哪一張是要看的」,而它能提供的資訊只有一個數字。所以收成右上角一行字
          (仍然是 #unDraw,點得動這件事沒變)。同理**牌河剩幾張不再顯示** ——
          那是只有寫程式的人會在意的數字。
     ========================================================================== */
  function tableHTML(o){
    const colTxt = (o.col >= 0 && o.col < 4) ? UN.COL_NAME[o.col] : "—";
    /* ⚠ 沒顏色時也一定要掛一個 class(un-c-none)—— `.un-swatch` 刻意不寫 background,
       顏色全靠這一組;空字串會讓色塊變成透明的(見 styles.css 那段 ★★)。 */
    const colCls = (o.col >= 0 && o.col < 4) ? COL_CLS[o.col] : "un-c-none";
    /* ⚠ 方向的箭頭用**幾何字元**(U+25B8 / U+25C2)而不是迴轉箭頭(U+21BB / U+21BA)——
       後者在部分 Android 字型缺字會變豆腐方框(同 CLAUDE.md 紅線 8 的精神:
       禁令列的是麻將與撲克牌那兩段,但「這個字型有沒有」的問題對任何字元都成立,
       所以能挑常見的就挑常見的)。牌面上的 ⊘ / ⇄ 由截圖驗過。
       ★★ **2 人局不畫方向**(v1.109.0):兩個人的桌上「順向」與「逆向」是同一件事,
          而迴轉現在一律換對手出(見 rules.js 的 K_REV)—— 那顆膠囊翻來翻去卻什麼都沒
          改變,正是使用者說的「很像工程用的東西」。 */
    const dir = (o.n === 2) ? "" :
      '<span class="un-dir">' + (o.dir > 0 ? "順向 ▸" : "逆向 ◂") + '</span>';
    /* ★ 短到一眼看完 —— 「疊得上就疊,不然只能抽」那半句改成點牌時才講(whyNot)。
       ★★ 罰抽是**釘在左上角**的(對稱右上角的牌堆),不是桌子裡的一列 ——
          它一出現就不可以把桌上的牌與「現在顏色」那一列推開。
          v1.108.0 只在橫置矮視窗釘住,直立那段仍然是流內元素:實測沿著一整局取樣,
          桌上那張牌在 pend 有無之間**上下跳 16px**(桌子 justify-content:center,
          多一列就整組往上挪半列)—— 那正是使用者說的「介面一直跳來跳去」。 */
    const pen = o.pend > 0 ? '<div class="un-pen">罰抽 <b>' + o.pend + '</b> 張</div>' : "";
    return '<div class="un-table">' +
             '<button class="un-deck" id="unDraw" type="button" aria-label="牌堆還有 ' +
               o.pileLeft + ' 張">牌堆 <b>' + o.pileLeft + '</b></button>' +
             '<div class="un-top">' + (o.top >= 0 ? cardHTML(o.top, "big") : "") + '</div>' +
             '<div class="un-now">' +
               '<span class="un-swatch ' + colCls + '" aria-hidden="true"></span>' +
               '<span class="un-nowtxt">現在顏色 <b>' + colTxt + '</b></span>' +
               dir +
             '</div>' + pen +
           '</div>';
  }

  /* ==========================================================================
     四、整個盤面
     ──────────────────────────────────────────────────────────────────────────
       o = { hand, top, col, dir, pend, stack, pileLeft, discLeft,
             mine, over, turnName, hot(可出的 id 陣列), drew, drewCard, key }
       ※ stack / discLeft / drewCard 現在畫面上用不到(v1.108.0 精簡掉那三句話),
         但兩個呼叫端照樣傳 —— 少傳等於下次要用時得改三個檔。
       ★ hot 由呼叫端算好傳進來(UN.playable)—— 盤面不自己算規則。
     ========================================================================== */
  let stage = null;
  function el(){ return stage || (stage = $("unStage")); }

  function render(o){
    const box = el();
    if(!box) return;
    const hot = o.hot || [];
    const hand = UN.sortHand(o.hand || []);
    const cards = hand.map(id => {
      const can = o.mine && !o.over && hot.indexOf(id) >= 0;
      /* ★ 沒亮的牌**照樣點得動**(只是會跳 toast 說原因)——
         CLAUDE.md 的紅線:不用 disabled / pointer-events:none 讓點擊靜默消失。 */
      return cardHTML(id, can ? "can" : "no");
    }).join("");
    box.innerHTML =
      tableHTML(o) +
      '<div class="un-handwrap">' +
        /* ★ 「剛抽到的那張只能出它」不寫在這裡(v1.108.0):亮起來的就只有那一張,
           畫面已經說完了;文字版留在動作列那一行(而且那一行是固定高度的)。 */
        '<div class="un-hlabel">你的手牌 <b>' + hand.length + '</b> 張</div>' +
        '<div class="un-hand" id="unHand">' + cards + '</div>' +
      '</div>';
  }

  /* ==========================================================================
     五、動作列
     ──────────────────────────────────────────────────────────────────────────
       o = { mine, over, turnName, drew, noPlay, handLen,
             unoOn(UNO 已經喊了), unoRule, catchName(可以抓誰,空 = 沒有),
             cdMs, cdEnd }
       ★★ 手上有合法牌可出時**不准抽**(強制出牌,見 rules.js 的 doDraw)——
          所以「抽一張」鈕只在 noPlay 時才畫;不畫的時候唯一的動作就是點一張亮起來
          的牌。牌桌右上角那行「牌堆 N」(#unDraw)仍然一直可以點,誤按由 hAct("draw")
          那一側的驗證跳 toast 講原因(不用 disabled 讓點擊靜默消失)。
       ★★★ 版型是**固定的兩列**(v1.108.0):鈕那一列 + 一行說明字。
          兩件事一起解決:
            · 高度不再隨內容變 → 上面的手牌與桌子不會被推得上上下下(見 styles.css)。
            · 鈕上的 <small> 副標全部拿掉、說明字縮成半句 —— 原本一顆 UNO! 鈕上就掛著
              「先按這裡再出牌,不然會被抓」,那是說明書不是遊戲。
       ★★★★ 這一列**永遠占著 --un-acth 那個高度**(v1.109.0),連 over 都不收起來 ——
          原本 over 時 `classList.add("hidden")` 讓整條 74px 消失,而它下面沒有東西、
          上面的手牌是靠 margin-top:auto 貼著它的 → 手牌會在結算那一刻整組**掉 82px**。
          (沿著一整局取樣量到的:手牌列 top 611 / 693 兩種值。)
     ========================================================================== */
  /* ★★ 兩列是**常駐節點**(v1.109.0),每次只換裡面的東西 —— 理由有兩個:
       ① 倒數環要當成鈕列裡的一員(排在鈕的左邊,像台灣麻將那樣),而環一離開文件
          CSS 動畫就被取消 → 整條列不可以再 innerHTML 重畫。
       ② 順手保證兩列永遠存在(over 也是),高度就永遠是 --un-acth。 */
  let rowEl = null, txtEl = null;
  function ensureRows(){
    const box = $("unActs");
    if(!box) return null;
    if(!rowEl || !rowEl.isConnected || !txtEl || !txtEl.isConnected){
      box.innerHTML = '<div class="un-arow"></div><div class="un-atxt"></div>';
      rowEl = box.querySelector(".un-arow");
      txtEl = box.querySelector(".un-atxt");
      cdEl = null;                       // ⚠ 整條重建 → 舊的環已經脫離文件,要跟著忘掉
    }
    return box;
  }
  /* ⚠ 清鈕但**留下倒數環**(見 ensureCd 的註解) */
  function clearRow(){
    if(rowEl) [...rowEl.children].forEach(el => { if(el !== cdEl) el.remove(); });
  }

  function renderActs(o){
    const box = ensureRows();
    if(!box) return;
    box.classList.remove("hidden");
    clearRow();
    /* ★ over 也要留著兩列的空盒子 —— 高度不變,版面才不會在結算那一刻掉一截。 */
    if(o.over){
      stopCd();
      txtEl.className = "un-atxt";
      txtEl.innerHTML = "";
      return;
    }
    let btn = "", txt = "", cls = "";

    /* ★★ 抓鈕**不分回合**(視窗是「下一家出手之前」,不是「輪到我」)——
       所以它排在最前面,而且不管 mine 是什麼都要畫。 */
    if(o.catchName){
      btn += '<button class="btn danger un-catch" id="unCatch" type="button">抓 ' +
               esc(o.catchName) + '!</button>';
    }

    if(!o.mine){
      txt = "輪到 " + esc(o.turnName || "") + "…";
    }else{
      cls = " me";
      /* ★ UNO 一定要在**出牌前**先喊 —— 宣告與出牌必須是同一手
         (見 rules.js 第五節:做成出完再補按會與下一家的出牌競態)。
         ⚠ 只有「手上剛好 2 張」才出現:此時出一張就剩一張。
         ★★★ 它是**一按就定案**,不是切換(v1.109.0)。使用者原話:
            「應該要按完就不見,而不是在那邊不小心按一下又取消掉」——
            喊了 UNO 從來不會讓自己吃虧(規則層只在剩 1 張時接受 `!`),
            所以「取消」這個動作沒有任何用途,卻多送一次誤觸把宣告吃掉的機會。
            按下去 → 鈕收掉,狀態改由下面那行字講(那一行是固定高度的,不會推版面)。 */
      const unoNow = !!(o.unoRule && o.handLen === 2);
      if(unoNow && !o.unoOn){
        /* ⚠ 這顆**不掛 .btn** —— 它要長得像 UNO 的招牌(紅字壓黃底的橢圓徽章),
           不是動作列上另一顆一般的方鈕。共用 .btn 就會一起吃到 min-width:92px
           與方角,整顆變成「跟旁邊那顆一樣、只是字不同」。 */
        btn += '<button class="un-unobtn" id="unUno" type="button" aria-label="喊 UNO">' +
                 '<span class="un-uw">UNO!</span></button>';
      }
      if(o.drew){
        btn += '<button class="btn ghost" id="unPass" type="button">不出了</button>';
        txt = "可以出剛抽到的那張";
      }else if(o.noPlay){
        btn += '<button class="btn primary" id="unDrawBtn" type="button">抽一張</button>';
        txt = "沒有牌可以出";
      }else{
        txt = "輪到你,點一張亮的牌";
      }
      // 這一格只在該喊的那一刻講,而且喊過與沒喊各一句(鈕本身已經收掉了)
      if(unoNow) txt = o.unoOn ? "✔ 喊過 UNO 了,出牌吧" : "出牌前先喊 UNO!";
    }
    /* ⚠ 鈕一律 **beforeend**(接在環後面)—— 環是鈕列的第一個成員,順序是
       「⏱ 環 · 抓 X! · UNO! · 抽一張」。 */
    rowEl.insertAdjacentHTML("beforeend", btn);
    txtEl.className = "un-atxt" + cls;
    txtEl.innerHTML = txt;
    if(o.cdMs > 0) startCd(o.cdMs, o.cdEnd);
    else stopCd();
  }

  /* ==========================================================================
     五之二、出牌倒數的環(公開資訊:全桌都要知道還剩多久)
     ──────────────────────────────────────────────────────────────────────────
       ★★ 照**台灣麻將那顆**(js/mahjong16/adapter.js 的 ensureCd,v1.58.4)——
          使用者:「倒數秒數的方式,請參考台灣麻將的顯示方式」。
          一顆 SVG 環圈 + 中間的秒數:環隨時間排空,最後 3 秒轉紅並脈動。
       ★ 「動」全部交給 CSS animation,JS 只換中間那個數字 —— **不可以**每次
         renderActs() 都重畫一條進度條:那條列會因為「別人出牌了」「抓鈕出現了」
         被叫很多次,每一次重畫動畫就從頭開始,倒數會忽然跳回滿格。
       ★ 因此這顆是**持久節點**:clearRow() 刻意跳過它(元素一離開文件,CSS 動畫
         就被取消,插回去等於重跑一次 —— 症狀跟上面那條一模一樣)。
       ★★ 位置是**鈕列裡的第一個成員**,不是釘在動作列右緣 —— 第一版釘在
          `right:6px`,而 .un-acts 是整條 720px 寬:那顆環會落在視窗最右邊、
          離鈕一大截,看起來像一個掉在角落的數字(截圖才看得出來)。
          排進鈕列就會跟著一起置中,與台灣麻將那顆的擺法一致。
       ⚠ 因此環出現 / 消失會讓鈕左右挪 21px —— 而它在實務上不會中途切換:
         turnSec 開著就整局都在,關著就整局都沒有(單機是後者)。
     ========================================================================== */
  let cdEl = null, cdT = null, cdEnd = 0, cdKey = "";
  function ensureCd(){
    if(cdEl && cdEl.isConnected) return cdEl;
    if(!ensureRows() || !rowEl) return null;
    cdEl = document.createElement("span");
    cdEl.className = "un-cd hidden";
    cdEl.setAttribute("aria-hidden", "true");
    cdEl.innerHTML =
      '<svg viewBox="0 0 40 40"><circle class="un-cdbg" cx="20" cy="20" r="17"/>' +
      '<circle class="un-cdfg" cx="20" cy="20" r="17"/></svg><b class="un-cdn">–</b>';
    rowEl.insertBefore(cdEl, rowEl.firstChild);
    return cdEl;
  }
  /* 收掉 = **藏起來**,不是把節點丟掉 —— 丟掉的話下一手要重建,而重建 = 動畫重跑。
     ⚠ 麻將那份還多一支「離房時把 cdEl 設回 null」的 dropCd:這一頁不需要,因為
       #unActs 是 uno.html 裡的常駐節點(沒有人會把它整個換掉),而 ensureCd() 另外
       用 isConnected 自癒 —— 那正是麻將那條「cdEl 指著脫離文件的節點就再也畫不出來」
       的坑,這裡用檢查取代紀律。 */
  function stopCd(){
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdKey = "";
    if(cdEl){ cdEl.classList.add("hidden"); cdEl.classList.remove("un-hot"); }
  }
  /* 畫一顆「總長 totalMs、在 endAt 歸零」的環。
     ★ **同一顆環就不重跑**(cdKey):renderActs() 一手之內會被叫好幾次,不去重的話
       環每次都彈回滿格 —— 那個彈跳本身就會被玩家讀成「時間重算了」。
     ⚠ 去重條件**不可以**看 cdT:數字走到 0 之後 tick 就把 interval 停掉了,而
       那之後還會有 renderActs() 進來,環會彈回滿格(麻將 v1.65.0 的原話)。
     ★ 已經跑掉的部分靠**負的 animation-delay** 跳過去,duration 永遠是那一段的總長。 */
  function startCd(totalMs, endAt){
    if(!(totalMs > 0) || !endAt){ stopCd(); return; }
    const el = ensureCd(); if(!el) return;
    const key = Math.round(totalMs) + "@" + Math.round(endAt);
    if(cdKey === key && !el.classList.contains("hidden")) return;
    cdKey = key;
    if(cdT){ clearInterval(cdT); cdT = null; }
    cdEnd = endAt;
    el.classList.remove("hidden", "un-hot");
    const ring = el.querySelector(".un-cdfg");
    const past = Math.max(0, Math.min(totalMs, totalMs - (endAt - Date.now())));
    /* 重跑動畫:只改 duration 不會重新開始 —— 要先拿掉、強制 reflow、再掛回去。
       ⚠ animationDelay 一定要寫在 shorthand **之後**(shorthand 會把 delay 歸零)。 */
    ring.style.animation = "none"; void ring.offsetWidth;
    ring.style.animation = "uncd " + totalMs + "ms linear forwards";
    ring.style.animationDelay = (-past) + "ms";
    tickCd();
    cdT = setInterval(tickCd, 200);
  }
  function tickCd(){
    if(!cdEl) return;
    const left = Math.max(0, cdEnd - Date.now());
    const s = String(Math.ceil(left / 1000));
    const n = cdEl.querySelector(".un-cdn");
    if(n && n.textContent !== s){
      n.textContent = s;
      n.classList.remove("un-beat"); void n.offsetWidth; n.classList.add("un-beat");
    }
    cdEl.classList.toggle("un-hot", left <= 3000);      // 最後 3 秒:轉紅 + 脈動
    if(left <= 0){ clearInterval(cdT); cdT = null; }
  }

  /* ==========================================================================
     六、選色盤 —— Wild 打出去要指定顏色
     ──────────────────────────────────────────────────────────────────────────
       ★ 收斂成一個 callback:askColor(cb) → 玩家點了顏色就 cb(col)。
         單機與連線都只呼叫這一支,所以「選色」這件事只有一份實作。
       ⚠ 蓋板要列進 BACK_LAYERS(uno.html 的 main.js)—— 不然 Android 的返回鍵
         會直接離開房間而不是關掉這一層(CLAUDE.md 紅線 7)。
     ========================================================================== */
  let colorCb = null;
  function askColor(cb){
    colorCb = cb || null;
    const v = $("unColorVeil");
    // 蓋板不存在(理論上不會)→ 直接給紅色,不可以卡在等使用者
    if(!v){ if(colorCb){ const f = colorCb; colorCb = null; f(UN.C_R); } return; }
    v.classList.add("show");
  }
  /* ★★★ 關掉 = **取消那一手 Wild**,而且一定要把 callback 用 col = -1 叫起來。
     ⚠⚠ 第一版寫成「把 colorCb 設成 null 就好」—— 那會讓呼叫端的 `pendWild` 永遠停在
       那張牌上,而 `pendWild >= 0` 是「手牌不能點」的條件 → **整局點不動,而且不報錯**。
       返回鍵(BACK_LAYERS)與外框點擊都走這一支,所以那是一定會發生的路徑。
     ★ 取消是安全的:顏色還沒選就不會送進 moves,牌等於沒出過。 */
  function closeColor(){ pickColor(-1); }
  function pickColor(col){
    const f = colorCb;
    colorCb = null;
    const v = $("unColorVeil");
    if(v) v.classList.remove("show");
    if(!f) return;
    if(col >= 0) sfx.color();
    f(col);                        // ★ col < 0 = 取消(呼叫端要把 pendWild 清掉)
  }
  const colorOpen = () => { const v = $("unColorVeil"); return !!(v && v.classList.contains("show")); };

  /* ==========================================================================
     六之二、掛上點擊(委派)
     ──────────────────────────────────────────────────────────────────────────
       ★ 兩個回呼都由 main.js 分流到單機 / 連線 —— 盤面本身不知道自己在哪一種模式。
       ⚠ 用委派(綁在容器上)而不是逐張牌綁:手牌每次重畫都是新的節點。
       ⚠ 手牌區**以外**的牌不吃點擊(桌上那張、結果表的縮圖)——
         不擋的話點桌面那張牌會被當成「出那一張」(它不在手上,規則層會擋,
         但玩家會看到莫名的 toast)。
     ========================================================================== */
  let hCard = null, hAct = null;
  function mount(h){
    stage = $("unStage");
    hCard = h.onCard; hAct = h.onAct;
    const st0 = stage;
    if(st0){
      st0.addEventListener("click", e => {
        // 牌堆:點它 = 抽一張(與動作列那顆「抽一張」同一條路)
        if(e.target.closest("#unDraw")){ if(hAct) hAct("draw"); return; }
        const el = e.target.closest(".un-card");
        if(!el || !hCard) return;
        if(!el.closest(".un-hand")) return;
        const c = +el.dataset.c;
        if(!isNaN(c)) hCard(c);
      });
    }
    const acts = $("unActs");
    if(acts){
      acts.addEventListener("click", e => {
        const b = e.target.closest("button");
        if(!b || !hAct) return;
        if(b.id === "unDrawBtn") hAct("draw");
        else if(b.id === "unPass") hAct("pass");
        else if(b.id === "unUno") hAct("uno");
        else if(b.id === "unCatch") hAct("catch");
      });
    }
    // 選色盤的四顆鈕
    const cols = $("unColors");
    if(cols){
      cols.addEventListener("click", e => {
        const b = e.target.closest("button[data-col]");
        if(b) pickColor(+b.dataset.col);
      });
    }
    /* 點蓋板外框 = 取消那一手 Wild(同返回鍵)。
       ⚠ 一定要比對 e.target 是蓋板本身,不然點卡片內部也會關掉。 */
    const veil = $("unColorVeil");
    if(veil) veil.addEventListener("click", e => { if(e.target === veil) closeColor(); });
  }

  /* ==========================================================================
     七、公告(diff 驅動)
     ──────────────────────────────────────────────────────────────────────────
       ★ 「有人剩一張」與「有人被抓」要讓全桌知道。
       ⚠⚠ 一律靠「上一次記到的值」做 diff,而且**第一次(prev === null)只記不響** ——
          擋掉「進場 / 重連 / 批次同步 / 換局」四種亂響(大老二 announceLa 的教訓)。
     ========================================================================== */
  let unoPrev = null, unoKey = null;
  function announce(o){
    const key = String(o.key == null ? "" : o.key);
    const now = (o.left || []).map((n, i) => (n === 1 ? i : -1)).filter(i => i >= 0).join(",");
    if(unoKey !== key){ unoKey = key; unoPrev = now; return; }   // 換局 → 只記不響
    if(unoPrev === null){ unoPrev = now; return; }
    if(now !== unoPrev){
      const before = unoPrev.split(",").filter(Boolean);
      now.split(",").filter(Boolean).forEach(s => {
        if(before.indexOf(s) >= 0) return;
        const seat = +s;
        const nm = (o.names && o.names[seat]) || ("玩家" + (seat + 1));
        sfx.uno();
        if(window.showToast) showToast((seat === o.me ? "你" : nm) + " 剩一張牌!", 1500);
      });
      unoPrev = now;
    }
  }
  function resetAnnounce(){ unoPrev = null; unoKey = null; }

  /* ==========================================================================
     八、結果表
     ──────────────────────────────────────────────────────────────────────────
       ★ 這是**唯一**把手牌翻開的地方(牌情紅線的豁免點)。
       wins = [{ n:累積分, plus:這局加了幾分 }](連線用;單機傳 null)
     ========================================================================== */
  function resultHTML(st, names, me, wins){
    const sc = UN.score(st);
    const rows = sc.sorted.map(r => {
      const nm = names[r.seat] || ("玩家" + (r.seat + 1));
      const mine = r.seat === me;
      const w = wins ? wins[r.seat] : null;
      const cards = r.left
        ? '<span class="un-rcards">' + UN.sortHand(st.hands[r.seat]).map(id => cardHTML(id, "tiny")).join("") + '</span>'
        : '<span class="un-rout">出完了 🎉</span>';
      return '<tr' + (mine ? ' class="me"' : '') + '>' +
               '<td class="rk">' + r.rank + '</td>' +
               '<td class="nm">' + esc(nm) + (mine ? ' <i>(你)</i>' : '') + '</td>' +
               '<td class="lf">' + (r.left ? (r.left + " 張 · " + r.pts + " 點") : "—") + '</td>' +
               '<td class="pt"><b>' + r.rp + '</b> 分' +
                 (w ? '<small>累積 ' + w.n + (w.plus ? " (+" + w.plus + ")" : "") + '</small>' : '') +
               '</td>' +
             '</tr><tr class="cd"' + (mine ? ' class="me"' : '') + '><td colspan="4">' + cards + '</td></tr>';
    }).join("");
    return '<table class="un-rtab"><thead><tr>' +
             '<th>名次</th><th>玩家</th><th>剩牌</th><th>名次分</th>' +
           '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  return {
    mount,
    cardHTML, backHTML, tableHTML,
    render, renderActs, resultHTML,
    askColor, closeColor, pickColor, colorOpen,
    announce, resetAnnounce,
    sfx, moveSfx, stopCd,
    COL_CLS
  };
})();

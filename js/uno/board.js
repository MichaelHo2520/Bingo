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

   ── ★ 動作聲是合成音,**語音是七個音檔**(v1.117.0 起)────────────────────────
     v1.106.0~v1.116.0 這一頁刻意「不新增任何 mp3」(省掉 CLAUDE.md 那條「動 mp3/ 的
     路徑要四處一起改」與「離線抓不到音檔就啞掉」)。使用者要語音:「1.有人報UNO,
     包含自己 2.加牌時,例如+2就要唸出加2 3.換顏色的時候,也要記得報顏色,例如黃色」——
     **合成音唸不出字**,所以那一條只能推翻,而推翻的範圍刻意壓到最小:
       · 動作聲(出牌 / 抽牌 / 跳過 / 迴轉 / 罰抽 / 換色 / 被抓)**全部維持 Sound.tone()**
       · 只有那三件事是音檔,共七格:uno · d2 / d4 · r / y / g / b
     所以「離線就啞掉」也只影響語音那一層(動作聲照樣有),而 sw.js 的 CORE 有列它們。
     ⚠ 語音槽刻意**沒有合成音後備**(拿音階去墊會變成同一件事響兩次很像的聲音)——
       代價是它必須**預載**(見 primeVoice),不然一局裡第一次喊 UNO 永遠是沒聲音的。
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

  /* ==========================================================================
     二之二、語音(七個音檔;v1.117.0)
     ──────────────────────────────────────────────────────────────────────────
       ★ 與動作聲是**分開的兩層**,刻意不互相取代(同台灣麻將的喊牌):動作聲是
         「牌拍到桌上」,語音是喊出來的那句話 —— 真牌桌上兩個同時有。
       ★ 只有**宣告類**的事件配語音:UNO / 加二 / 加四 / 顏色。
         出牌 / 抽牌 / 跳過 / 迴轉一局要響幾十次,每次唸字就變成報帳機。
       ⚠ 語音槽**沒有合成音後備**(def 的第三個參數傳 null):音檔取不到就是不講話。
       ⚠ 開 HTMLAudio 後備(`el:true`)—— 音檔是跟程式一起發佈的,而用 file:// 直接開
         網頁時 fetch 會被 CORS 擋,沒有這一層就完全沒聲音(見 audio.js 的 playClipEl)。
     ========================================================================== */
  const VOICE = { uno:"UNO", d2:"加二", d4:"加四", r:"紅色", y:"黃色", g:"綠色", b:"藍色" };
  /* Wild 指定的顏色 → 語音格。⚠ 用 UN.COL_KEY 而不是自己再列一份 r/y/g/b:
     那一組就是 move 字串裡的那個字元(見 rules.js 的 encPlay)。 */
  const COL_VK = UN.COL_KEY;

  /* ⚠ 發聲前一定要確認 Sound 這一版**有**音效槽那組 API(同 mj16/sfx.js 的理由):
     sw.js 是 network-first,裝置有可能拿到新的 board.js 卻還吃著舊的 audio.js ——
     那時直接呼叫會 TypeError,而這支是從 render() / moveSfx() 裡叫的,
     一路炸上去等於整個盤面停止重畫。語音不見是小事,牌桌壞掉是大事。 */
  function vReady(){
    return typeof Sound !== "undefined" && typeof Sound.sfx === "function" && !!Sound.def;
  }
  let vDefed = false;
  function ensureVoice(){
    if(vDefed || !vReady()) return;
    vDefed = true;
    Object.keys(VOICE).forEach(k => Sound.def("unv" + k, ["mp3/uno/voice-" + k + ".wav"], null, { el:true }));
  }
  /* ★★ 一句一句排隊講,**不可以讓兩句疊在一起**(疊起來兩句都聽不清楚)。
     同一手最多會有兩句(+4 = 「加四」+「藍色」),而 UNO 的公告又是另一條路徑進來的
     → 用「下一句最早可以開口的時間」串起來,誰晚到誰排後面。
     ⚠ VGAP 要 ≥ 最長那句的長度(產生器量到的是 0.49~0.71 秒)+ 一點呼吸。 */
  const VGAP = 820;
  let vFree = 0;
  function say(key, lead){
    if(!vReady() || !VOICE[key]) return;
    ensureVoice();
    const now = Date.now();
    const at = Math.max(now + (lead || 0), vFree);
    vFree = at + VGAP;
    const d = at - now;
    if(d <= 0) Sound.sfx("unv" + key);
    else setTimeout(() => { if(vReady()) Sound.sfx("unv" + key); }, d);
  }
  /* 這一手要唸哪幾句(依序)。★ **純函式** —— 給試聽頁與診斷頁對答案用。
     ⚠ UNO 那一句**不在這裡**:它走公告那條路(announce),理由見那裡的註解。 */
  function voiceKeysOf(mv){
    const out = [];
    if(!UN.isPlay(mv)) return out;
    const id = UN.moveCard(mv);
    if(id < 0) return out;
    const k = UN.kindOf(id);
    if(k === UN.K_D2) out.push("d2");
    else if(k === UN.K_W4) out.push("d4");
    /* Wild / Wild+4 指定的顏色。⚠ 一定要從 move 字串讀(mv[3]),不可以讀 st.col:
       這一支只拿到一手,而且 st.col 在「疊 +4」時還沒換過去。
       ⚠ 非 Wild 的第 4 個字元可能是 "!"(宣告 UNO)→ 先看是不是 Wild 再讀。 */
    if(UN.isWild(id)){
      const ck = mv[3];                                 // COL_KEY 的代號就是語音格的 key
      if(COL_VK.indexOf(ck) >= 0) out.push(ck);
    }
    return out;
  }
  /* 進對局時把七個音檔先載好。★ 這不是效能優化,是**正確性**:語音槽是懶載入的,
     而它沒有合成音可以墊 —— 不預載的話「這一局第一次喊 UNO」永遠沒聲音
     (音檔那時才開始飛),使用者只會覺得「有時候有、有時候沒有」。
     ⚠ 呼叫時機要在已經有使用者手勢之後(開始對局 / 進房),不然只是白白建立 AudioContext。 */
  function primeVoice(){
    if(!vReady() || !Sound.prime) return;
    ensureVoice();
    Object.keys(VOICE).forEach(k => Sound.prime("unv" + k));
  }

  /* 一手打出去之後該響什麼 —— **單機與連線共用這一支**。
     ⚠ 走「前後兩份的 diff」而不是在動作點插 sfx.xxx():單機與連線的動作路徑
       完全不同,但「有人出了 +2」在兩邊是同一個 diff(同大老二 moveSfx 的理由)。
     ★ 語音壓在動作聲後面 200ms:太近會與罰抽那聲鋸齒糊成一團,太遠又像回音。
       (罰抽的合成音本身 0.24~0.34 秒,所以這裡比麻將那 60ms 鬆很多。) */
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
    voiceKeysOf(mv).forEach(key => say(key, 200));
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
      '<span class="un-dir">' + (o.dir > 0 ? "順向" : "逆向") + '</span>';
    /* ★ 短到一眼看完 —— 「疊得上就疊,不然只能抽」那半句改成點牌時才講(whyNot)。
       ★★ 罰抽是**釘在左上角**的(對稱右上角的牌堆),不是桌子裡的一列 ——
          它一出現就不可以把桌上的牌與「現在顏色」那一列推開。
          v1.108.0 只在橫置矮視窗釘住,直立那段仍然是流內元素:實測沿著一整局取樣,
          桌上那張牌在 pend 有無之間**上下跳 16px**(桌子 justify-content:center,
          多一列就整組往上挪半列)—— 那正是使用者說的「介面一直跳來跳去」。 */
    const pen = o.pend > 0 ? '<div class="un-pen">罰抽 <b>' + o.pend + '</b> 張</div>' : "";
    /* ★★ 牌堆那顆鈕(#unDraw)v1.110.0 **搬到手牌右邊**了(見 drawPadHTML)——
       所以桌上只剩「牌河最上面那張 + 現在顏色」兩件事。 */
    return '<div class="un-table">' +
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
        '<div class="un-handrow">' +
          /* ⚠ 牌不是 .un-hand 的直接子元素,中間隔一層 .un-hrow —— 那一層才是
             「牌要縮多小」的載體(見 fitHand)。委派看的是 `.closest(".un-hand")`,
             多一層不影響。 */
          '<div class="un-hand" id="unHand"><div class="un-hrow">' + cards + '</div></div>' +
          drawPadHTML(o, hot) +
        '</div>' +
      '</div>';
    fitHand();
    watchHand();
  }

  /* ---------- 手牌一多就把牌縮小,縮到看不清才換第二列(v1.117.0 → v1.147.0)----------
     使用者(v1.117.0):「手牌如果太多,會變成要左右滑動,但現在會跑出一條在下方的 bar,
     這很難看,我希望不要有 bar 條,也不要需要滑動來看手牌,可以考慮換行,或是把中間的牌域給
     縮小一點點,不過這個還請你要評估看看,我不希望介面變很難看,也不希望固定的區域一直跳來跳去」。
     使用者(v1.147.0,疊牌放寬成 +2/+4 互通之後):「當初是因為抽太多的時候會讓排太長導致要
     滑動不好看,我們是不是來想想看有比方法嗎,例如中間區域其實可以不一定要這麼大,當然平常的
     時候還是大一點,當如果排需要換行的時候,可以適當的縮減中間的大小」。

     ★★★ v1.117.0 三條路裡選了「縮牌」,理由是最後那半句:
       · **換行** —— 兩列的高度只能二選一:要嘛預留(直立多浪費 80px、橫置 430px 高的視窗
         直接把手牌擠出畫面下緣,notes/18 版面第 7 條量過),要嘛第 13 張牌出現的那一刻
         整個手牌區長高一倍 → 那正是「固定的區域跳來跳去」最嚴重的一種。
       · **縮中間的牌桌** —— 治不了病:牌桌讓出來的是**高度**,手牌不夠的是**寬度**。
       · **縮牌** —— 只有牌自己變小,`.un-hand` 的高度、標籤、抽牌墊、動作列一格都不動。
         而且**放得下的時候一個像素都不改**(≤ 12 張左右完全是原來的樣子)。

     ★★★ v1.147.0 把「換行」加回來,而**上面那三句話一條都沒有被推翻** ——
       翻案的是一個**量出來的事實**:直立時手牌上方本來就有一大塊空白
       (`.un-handwrap{margin-top:auto}` 把手牌壓到動作列上面,桌子卡在 `min-height:200px`)
       —— 870×805 量到 **197px**。第二列只要 32~38px,**從那塊空白裡拿就夠了**:
         · 桌子、桌上那張牌、現在顏色 → **一個像素都不動**(所以使用者說的「縮減中間」
           實際上不必真的縮 —— 那塊空間本來就沒人在用)
         · 手牌的**下緣**與動作列 → 一個像素都不動(手牌是往**上**長的)
         · 會動的只有手牌區的上緣與抽牌墊的垂直中心,而它在一整局裡最多**兩種值**
       而「換行 vs 縮牌」的取捨改成**看牌縮到多小**:縮到 28px 以下(牌高 41px、
       牌面大字 13px)才換行 —— 那時「換行」是在救可讀性,不是在浪費空間。
     ★★ 空白夠不夠是**量出來的,不是寫死媒體查詢** —— 橫置矮視窗(`.un-table{flex:none}`、
       430px 高)自然量到接近 0 → 自動維持一列,不必寫 `@media` 分岔。
     ⚠ 極端(兩列連 18px 都放不下,約 30+ 張看視窗)**退回一列**,行為與 v1.117.0
       完全一樣(藏起來的橫向捲動)—— 不要讓它變成「第三列被裁在框外而且看不出來」。

     ★ 縮的方式是把 `--un-cw` 設在 `.un-hrow` 上 → 牌寬 / 牌高 / 白橢圓 / 字級 / 圓角
       **整組跟著縮**(它們全都是 `calc(var(--un-cw) × 係數)`,見 notes/18 版面第 1 條)。
       ⚠⚠ 一定要設在**內層**那個 .un-hrow 上,不可以設在 .un-hand 上 ——
         .un-hand 的高度是 `calc(var(--un-cw) * 1.45 + 12px)`,設在它身上會連**列高**
         一起縮 → 牌一多整條手牌區就變矮,又變成上下跳(要修的正是這件事)。
     ⚠ 量之前先把上一次的覆寫**清掉**,量到的才是基準寬(不然會一路縮下去)。
     ⚠ 量到 0 就什麼都不做 —— 容器還沒版面 / 是 hidden 的
       (CLAUDE.md 紅線 17:「在 hidden 的容器上量尺寸,兩個 0 永遠相等」)。
     ⚠⚠ 張數**從 DOM 數**而不是拿參數 —— 這一支還會被 ResizeObserver 叫(見 watchHand),
       那時沒有人記得剛才畫了幾張;傳參數的版本遲早會與畫面不一致。 */
  const GAPR = 0.09;        // 牌與牌的間隙 = 牌寬 × 這個係數(CSS 的 .un-hrow{gap} 同一個式子)
  const MINCW = 18;         // 再小就認不出是什麼牌了(18px 寬 = 26px 高,標籤字 8px)
  /* ★★★ 換不換第二列的判準刻意**不是一個寫死的門檻**,而是兩句話 ——
       ① **一列根本放不下**(牌撞到 18px 下限還是溢出)而兩列放得下 → 換,
          因為那是「不必滑就看得完」的唯一一條路(30 張手機上就是這一格)
       ② 一列放得下但**兩列能讓牌大兩成以上** → 換,因為換了才划算
       其餘一律維持一列。
     ⚠ 這樣寫的三個好處:(a) 沒有「28px 是哪裡來的」這種魔術數字
       (b) 換行的**理由**與驗收點是同一句話:「換了之後牌有變大嗎 / 還要不要滑?」
       (c) 它是 (張數, 可用寬, 上方空白) 的**純函式** —— 不必記「現在是幾列」,
          所以同一手牌永遠排出同一個樣子(要防的抖動由 GAIN 那兩成擔任:
          臨界張數附近換行只賺一兩個 px 時就不換,不會在一列 / 兩列之間來回跳)。 */
  const GAIN = 1.2;
  const MAXR = 3;           // 最多三列(CSS 只有 .rows2 / .rows3 兩個框高)
  const setCw = (row, cw) => row.style.setProperty("--un-cw", cw + "px");
  /* 幾列 —— 一列就是「什麼 class 都不掛」(= v1.117.0 的原樣)。 */
  function setRows(box, row, r){
    box.classList.remove("rows2", "rows3");
    if(r > 1){ box.classList.add("rows" + r); row.classList.add("wrap"); }
    else row.classList.remove("wrap");
  }
  /* 手牌上方還有多少空白可以拿(桌子下緣 → 手牌區上緣)。
     ★ 一律**量**,不從 CSS 常數推 —— 直立 / 橫置 / 五種主題 / 有沒有玩家列都不同。 */
  function freeAbove(){
    const stage = $("unStage");
    const table = stage && stage.querySelector(".un-table");
    const wrap  = stage && stage.querySelector(".un-handwrap");
    if(!table || !wrap) return 0;
    /* ⚠ 扣掉 .un-stage 的 gap:量到的距離含那 10px,全部吃掉手牌就會貼上桌子。 */
    const gap = parseFloat(getComputedStyle(stage).rowGap) || 0;
    return wrap.getBoundingClientRect().top - table.getBoundingClientRect().bottom - gap;
  }
  function fitHand(){
    const box = $("unHand");
    const row = box && box.firstElementChild;
    if(!row) return;
    /* ⚠ 先整組回到「一列 + 基準寬」再量 —— 量到的才是基準,不然會一路縮下去 */
    setRows(box, row, 1);
    row.style.removeProperty("--un-cw");
    const n = row.children.length;
    if(!n) return;
    const avail = row.clientWidth;
    const first = row.firstElementChild;
    if(!avail || !first) return;
    const r0 = first.getBoundingClientRect();
    const base = r0.width;
    if(!(base > 0)) return;                          // hidden / 還沒版面 → 不要亂設
    const units = n + GAPR * (n - 1);                // 需要幾個「牌寬」(含間隙)
    if(base * units <= avail) return;                // ★ 放得下就一個像素都不動
    /* 一列的答案:縮到剛好放得下,但不小於 18px。
       ⚠ `fits` 一定要用**沒有夾下限**的那個值算 —— 夾完的 cw 看起來永遠「放得下」,
         而 v1.117.0 的極端情形(30 張以上)正是「夾在 18px 而且還是溢出」。 */
    const raw1 = Math.floor(avail / units);
    const h1 = box.getBoundingClientRect().height;
    const free = freeAbove();                        // 上方的空白(量出來的,見上面)
    const cs = getComputedStyle(box);
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const ratio = r0.height / base;                  // 牌的長寬比,量出來(不寫死 1.45)
    let best = { r:1, cw:Math.max(MINCW, raw1), fits:raw1 >= MINCW };
    /* ★ 往下試每一種列數。cw 隨列數**單調不減**(每列張數變少 → 寬的限制放鬆,
       而高的限制 byH 因為框高是「列數 × 同一個名目牌寬」而**與列數無關**),
       所以「挑最少的列數」= 從 2 開始、只有明顯更大才往上換。 */
    for(let r = 2; r <= MAXR; r++){
      setRows(box, row, r);
      const hr = box.getBoundingClientRect().height;
      if(hr - h1 > free) break;                      // 空間不夠 → 更多列只會更不夠
      /* 牌能多大由**兩個限制**決定,兩邊都量:
           寬 —— 每列 ceil(n/r) 張要塞進 avail
           高 —— r 列 + (r−1) 個列間隙要塞進(變高之後的)框內高
         ⚠ padding / row-gap / 長寬比一律從**實際元素**量:牌高那個 1.45 寫在 CSS 的
           .un-card 上,這裡再寫一份就是兩份真相。 */
      const gapY = parseFloat(getComputedStyle(row).rowGap) || 0;
      const per = Math.ceil(n / r);
      const u = per + GAPR * (per - 1);
      const byH = Math.floor((box.clientHeight - padV - (r - 1) * gapY) / r / ratio);
      const cw = Math.min(byH, Math.floor(avail / u));
      const fits = cw >= MINCW;                      // 撞到 18px 下限就算這個列數放不下
      /* 換的兩個理由(其中一個成立就換):
           ① 目前這個列數**根本放不下**,而這個列數放得下 → 換了才不必滑
           ② 都放得下,但牌能大兩成以上 → 換了才划算(不到兩成就別動,省掉沒必要的變形) */
      if(fits && (!best.fits || cw >= best.cw * GAIN)) best = { r:r, cw:cw, fits:true };
    }
    /* ⚠ 沒有任何多列方案可用時**退回一列**,行為與 v1.117.0 完全一樣
       (18px + 藏起來的橫向捲動)—— 不可以硬塞:框高寫死 + overflow-y:hidden
       = 多出來的那一列被裁在框外,而且畫面上完全看不出來(CLAUDE.md 紅線 17 那一類)。 */
    setRows(box, row, best.r);
    setCw(row, best.cw);
  }
  /* ★★ 兩種情形會讓「量好的那個寬」過期,而它們**都不會觸發 render()**:
       ① 手機轉向 / 改視窗大小 —— 基準寬是 clamp(…,12.5vw,…),vw 一變基準就變
       ② 這一次 render() 是在**還沒顯示**的畫面上做的(連線的第一份快照可能在切到
          對局畫面之前就到了)—— 那時量到 0,fitHand 什麼都不做
     ⚠⚠ ② 在 v1.117.0 之前無所謂(捲軸還在,滑一下就看到了),現在**捲軸藏起來了** →
       沒補這一手的話那一瞬間會有牌被裁在畫面外而且看不出可以捲。
     ★ 用 ResizeObserver 掛在 .un-hand 上一次解決兩個:它在「0 → 有寬度」與
       「視窗變了」兩種情形都會叫一次。observe() 本身也會立刻叫一次(冪等,無妨)。
     ⚠⚠⚠ **只有「寬」變了才重算**(v1.147.0 起非做不可):兩列模式是靠 `.rows2` 改
       `.un-hand` 的**高**做的,而 RO 就掛在 `.un-hand` 上 → 高一變它就再叫一次
       fitHand,fitHand 又會把高改回去再改過來 = **每一格都在跳的無限迴圈**
       (瀏覽器會丟 "ResizeObserver loop limit exceeded",而畫面看起來只是在閃)。
       v1.117.0 那版沒有這個問題(fitHand 只改內層的 --un-cw,兩軸都不影響 .un-hand),
       所以那時的註解寫「不會無限迴圈」—— **這一版把那個前提改掉了**。
       ★ 寬是 `flex:1 1 0` 算出來的,與手牌區的高無關 → 拿「寬有沒有變」當閘門是安全的,
         而轉向 / 顯示出來 / 視窗變大這三種**要**重算的情形寬都一定會變。
     ⚠ 每次 render() 都要重新 observe,而且要把記著的寬歸零 —— #unHand 是 innerHTML
       重畫出來的**新節點**(張數也換了,同樣的寬照樣要重算一次)。 */
  let handRO = null, roW = -1;
  function watchHand(){
    const box = $("unHand");
    if(!box || !window.ResizeObserver) return;
    roW = -1;
    if(!handRO) handRO = new ResizeObserver(es => {
      const w = Math.round((es[0].contentRect || {}).width || 0);
      if(w === roW) return;
      roW = w;
      fitHand();
    });
    handRO.disconnect();
    handRO.observe(box);
  }

  /* ---------- 抽牌墊:手牌**右邊**那一塊(v1.110.0)----------
     使用者:「如果要加牌的話,不要顯示在最下面,可以把他移到牌的例如右邊,
     不然這個字出的時候,牌還是會跳一下」。
     ★★ 三件事一起解決:
       ① 它**永遠在**(不像原本的「抽一張」鈕只在沒牌可出時才畫)→ 版面一格都不會挪。
       ② 抽牌這個動作長在手牌旁邊,而不是跑到畫面最底下的一列鈕裡。
       ③ 牌堆還剩幾張也收進來 —— 原本桌子右上角那行「牌堆 N」整個拿掉,
          桌上只留「牌河最上面那張 + 現在顏色」。同一件事只有一個地方。
     ⚠ 它**不是一張牌**(刻意用虛線框 + 文字,不畫牌背):擺在手牌尾巴的牌背
       會被看成「我的第 N 張牌」。v1.108.0 把桌上那張牌背拿掉的理由是同一條。
     ⚠ 沒輪到 / 有牌可出時**照樣點得動**(誤按跳 toast 講原因)——
       CLAUDE.md 的紅線:不用 disabled 讓點擊靜默消失。
     ★ 只有「輪到我而且一張都出不了」時亮起來 —— 用 box-shadow 的光圈,不動位置。

     ★★★ **「這一下會抽幾張」寫在這裡**(v1.117.0)。使用者:「抽牌要抽幾張,我們有顯示嗎?
        如果沒有的話,我希望能在抽牌那裡,看到要抽幾張」。
        原本只有桌子左上角那顆罰抽膠囊(.un-pen)在講,而**手要點的地方**沒講 ——
        點下去才知道吃了幾張。三行由上到下是「動作 / 這一下抽幾張 / 牌堆還剩幾張」。
        ⚠⚠ 罰抽那個數字只在**輪到我**的時候能算進來:st.pend 是「輪到誰誰就要抽」
          (rules.js 的 K_D2 是 pend += 2 之後才 adv()),別人的回合掛著 pend
          卻在我的抽牌墊寫「抽 2 張」是騙人的。
        ⚠ 原本第二行是**牌堆張數**(v1.110.0 從桌上收進來的),它與「抽牌」兩個字上下相疊
          本身就有點像「抽 87 張」。現在牌堆退到第三行、字更小,而且帶一個「堆」字。
        ⚠ 三行都是**固定存在**的(數字換內容、不換行數)—— 一格都不許因為狀態出現 / 消失,
          那正是 v1.110.0 把這一塊做成「永遠在」的理由。 */
  function drawPadHTML(o, hot){
    const must = !!(o.mine && !o.over && !(hot || []).length);
    const pen = !!(o.mine && !o.over && o.pend > 0);
    const dn = pen ? o.pend : 1;
    return '<button class="un-drawpad' + (must ? " can" : "") + (pen ? " pen" : "") +
             '" id="unDraw" type="button"' +
             ' aria-label="抽 ' + dn + ' 張(牌堆還有 ' + o.pileLeft + ' 張)">' +
             '<span class="un-dp-t">抽牌</span>' +
             '<span class="un-dp-n">' + dn + '<i>張</i></span>' +
             '<span class="un-dp-p">堆' + o.pileLeft + '</span>' +
           '</button>';
  }

  /* ==========================================================================
     五、動作列
     ──────────────────────────────────────────────────────────────────────────
       o = { mine, over, turnName, drew, noPlay, handLen, iAmOut,
             unoOn(UNO 已經喊了), unoRule, catchName(可以抓誰,空 = 沒有),
             cdMs, cdEnd }
       ★★ 「抽一張」鈕 v1.110.0 **從這一列拿掉了** —— 抽牌搬到手牌右邊那一塊
          (drawPadHTML,它永遠在)。手上有合法牌可出時不准抽這條規則沒變,
          誤按由 hAct("draw") 那一側的驗證跳 toast 講原因
          (不用 disabled 讓點擊靜默消失)。
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

    if(o.iAmOut){
      /* ★ 房規 toLast 開著才有這一格:我出完了,牌局還在打 ——
         要講清楚「不是卡住了,是在等別人分高下」(不然玩家會以為畫面壞了)。 */
      txt = "你出完了 · 等其他人分高下";
    }else if(!o.mine){
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
        /* ★ 「抽一張」那顆鈕 v1.110.0 拿掉了 —— 抽牌改成手牌右邊那一塊
           (它永遠在,所以不會因為這一格出現 / 消失而讓牌挪一次)。 */
        txt = "沒有牌可以出,點右邊的抽牌";
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
        // 抽牌墊(手牌右邊那一塊):點它 = 抽一張
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
        /* ⚠ 這一列已經沒有「抽一張」了(v1.110.0 搬到手牌右邊的 #unDraw,
           而它在 #unStage 那一條委派裡)。 */
        if(b.id === "unPass") hAct("pass");
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
        /* ★★ 「UNO」那一句掛在**公告**這裡,不掛在 moveSfx 的 `!` 上(v1.117.0)——
           使用者要的是「有人報UNO,包含自己」,而這一格剛好就是那個事件:
             ① 剩一張一定是**出掉一張**造成的,所以它與宣告是同一個瞬間
             ② 房規 unoCall **關掉**時沒有人會宣告(改成系統公告),掛在 `!` 上就不會唸
             ③ 這條路徑本來就有 diff 去重(換局 / 重連 / 批次同步只記不響),
                掛在這裡自然吃到那層保護 —— 而 moveSfx 只擋得住換局那一種
           ⚠ 因此漏喊被抓的人也會被唸到 —— 那是對的:桌上就是「有人剩一張」了,
             而 sfx.uno() 那一聲本來也是這樣響的(語音只是把它講成話)。 */
        say("uno", 120);
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
    /* 語音(v1.117.0)。voiceKeysOf 是純函式 → 試聽 / 診斷頁對得了答案;
       primeVoice 要在**有使用者手勢之後**叫(進對局那一刻),見它的註解。 */
    say, voiceKeysOf, primeVoice, VOICE,
    fitHand,                     // 手牌縮放(診斷頁要單獨量)
    COL_CLS
  };
})();

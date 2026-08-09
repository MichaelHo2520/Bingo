"use strict";

/* ============================================================================
   UNO — 規則引擎(UN)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/big2/rules.js、js/sevens/rules.js:「這一手合不合法」「這局誰第幾名」
     只有靠 node 大量對局才驗得出來,碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩。

   ── 玩法(規則來源見 notes/18;查證過的官方規則 + 使用者選定的兩條房規)──────
     108 張:四色(紅黃綠藍)各 19 張數字(0 一張、1~9 各兩張)+ 各 2 跳過 / 2 迴轉 /
     2 抽兩張,再加 Wild 4 張 + Wild +4 4 張。**2~6 人**,每人發 **7 張**。

     出牌條件:**同色 或 同數字/同動作**;Wild 隨時可出,出的人指定顏色。
     出不了(或不想出)→ **抽一張;抽到的那張能出就可以馬上出**,否則換下一家。
     ★ **迴轉在 2 人局就是換對手出**(不照官方的「等同跳過」)——
       官方規則裡 2 人局的迴轉會讓自己再出一次,但這一桌實際玩起來的回饋是
       「放了迴轉牌卻又輪到自己,很怪」:兩個人的牌桌上「反轉方向」與「換人」
       本來就是同一件事,而多一次自己的回合只會讓對手覺得被卡住。
       所以這一頁一律 `dir = -dir` 再走一格 —— 2 人局自然就落到對手身上。
     牌堆抽乾 → 牌河除最上面那張之外**決定性重洗**回牌堆(見第二節)。
     **有人打完最後一張,這一局立刻結束** —— 除非房規 `toLast` 開著,那就打到
     **只剩一個人手上還有牌**為止(像大老二),名次照出完的先後排。

     ★ 五條房規(房主設定,開局那一刻凍結):
         stack     疊 +2 / +4 —— **同種才疊得上**(+2 疊 +2、+4 疊 +4);
                   關掉就照官方:被 +2 就抽 2 張並跳過。
         unoCall   沒喊 UNO 罰抽 2 張 —— 出到剩 1 張要在**同一手**宣告(見第五節);
                   關掉就沒有抓,由畫面自動公告「還剩一張」。
         playDrawn 抽到的那張能出就可以馬上出(**預設關**)。
         toLast    **打到只剩一個人手上還有牌**才結束(預設關)——
                   開了之後每個人都有自己的名次,名次分改成看人數(見第六節)。
         freeDraw  手上有牌能出時仍然可以**選擇**抽牌(**預設關**,照原本的強制出牌)。

     ★ 兩件刻意做成固定行為、不進房規面板的(規則清單裡有寫給玩家看):
         ① 「抽到能出的牌可以馬上出」= 官方規則,固定開啟。
         ② **+4 隨時可出、不做挑戰** —— 官方的「只有沒同色才能出 +4、可被挑戰驗牌」
            要一整套挑戰 UI,而這個專案本來就不防作弊(受眾是親友聚會)。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 牌表與編碼、deal 字串、一手的編碼
     • legalOn():這張現在出不出得了      ★ 規則的心臟
     • replay():從 deal + moves 重算一整局的真相   ★ 唯一的真相入口
     • score():名次與名次分
     • playable():手牌現在哪幾張出得了(手牌亮暗 / 有沒有牌可出)
   不負責:AI(ai.js)、畫面(board.js)、輪次驅動(solo.js / adapter.js)。

   ── ★★ 為什麼一切都走 replay() ────────────────────────────────────────────
     連線那邊 DB 只存 { deal, moves }(同排七 / 大老二),每台裝置各自 replay 出
     完整局面 → 核心的 rev / 交易 / 斷線重建**原封不動**,批次同步就是多跑幾手。
     ⚠ 因此 **turn 絕不可以用 moves.length % n 取模** —— 跳過 / 迴轉 / 罰抽跳過 /
       抽牌後留在同一個人的回合,四件事都會讓「第幾手」與「第幾號座位」脫鉤。
   ========================================================================== */

const UN = (function(){

  /* ==========================================================================
     一、編碼
     ────────────────────────────────────────────────────────────────────────── */
  const MIN_PLAYERS = 2, MAX_PLAYERS = 6, DEAL_N = 7, NCARD = 108;

  // 顏色索引。★ 這個順序**只是顯示與編碼的順序**,不參與任何比大小(UNO 沒有牌力)
  const C_R = 0, C_Y = 1, C_G = 2, C_B = 3, C_WILD = 4;
  const COL_KEY  = ["r", "y", "g", "b"];        // 寫進 moves 的顏色代號
  const COL_NAME = ["紅", "黃", "綠", "藍"];
  /* ★★ 色名字母 —— 每張牌都要標,理由有兩個而且都不是裝飾:
       ① 電子書主題把畫面轉黑白,而 UNO 的規則本體就是顏色 → 沒有字母就玩不了
       ② 紅綠色盲的玩家吃同一條
     ⚠ 用英文字母而不是「紅黃綠藍」單字:CJK 字在 20px 寬的牌角落會糊成一塊墨。 */
  const COL_LETTER = ["R", "Y", "G", "B"];

  // 牌的種類。★ 數字牌的 k 就是它的數字(0..9),所以動作牌一定要從 10 起跳
  //   —— 「同數字或同動作」那條規則因此可以寫成一句 c.k === top.k(範圍不重疊)。
  const K_SKIP = 10, K_REV = 11, K_D2 = 12, K_WILD = 13, K_W4 = 14;
  const isWildK = k => k === K_WILD || k === K_W4;
  const isNumK  = k => k >= 0 && k <= 9;

  /* 牌面上印的字。★ 動作牌一律用符號 + 數字,不用中文 —— 牌面只有 20px 寬。 */
  const K_LABEL = { 10: "⊘", 11: "⇄", 12: "+2", 13: "W", 14: "+4" };
  const K_NAME  = { 10: "跳過", 11: "迴轉", 12: "抽兩張", 13: "變色", 14: "王牌 +4" };

  /* 官方點數:數字照面值 · 跳過/迴轉/+2 各 20 · Wild 各 50。
     ★ 這一版計分走名次分(使用者選的),但**點數仍然有用** ——
       它是「輸家之間怎麼排名次」的第一順位(留大牌的人排後面),
       所以 UNO 那個「別留大牌」的策略味道即使不用官方 500 分制也還在。 */
  function ptsOfK(k){ return isNumK(k) ? k : (isWildK(k) ? 50 : 20); }

  /* ★★ 牌表:108 張,index 就是牌 id。**建表的順序是規則的一部分**
     (deal 是它的排列),所以這一段的順序改了就是換了一副牌 —— 不要「整理」。 */
  const CARDS = (function(){
    const a = [];
    for(let col = 0; col < 4; col++){
      a.push({ col: col, k: 0 });                                  // 0 只有一張
      for(let v = 1; v <= 9; v++){ a.push({ col: col, k: v }); a.push({ col: col, k: v }); }
      [K_SKIP, K_REV, K_D2].forEach(k => { a.push({ col: col, k: k }); a.push({ col: col, k: k }); });
    }
    for(let i = 0; i < 4; i++) a.push({ col: C_WILD, k: K_WILD });
    for(let i = 0; i < 4; i++) a.push({ col: C_WILD, k: K_W4 });
    return a;
  })();

  const colOf   = id => CARDS[id].col;
  const kindOf  = id => CARDS[id].k;
  const isWild  = id => isWildK(CARDS[id].k);
  const ptsOf   = id => ptsOfK(CARDS[id].k);
  const labelOf = id => { const k = CARDS[id].k; return isNumK(k) ? String(k) : K_LABEL[k]; };
  const nameOf  = id => { const c = CARDS[id];
    return (c.col === C_WILD ? "" : COL_NAME[c.col]) + (isNumK(c.k) ? c.k : K_NAME[c.k]); };
  const letterOf = id => CARDS[id].col === C_WILD ? "" : COL_LETTER[CARDS[id].col];

  /* ---------- deal 字串:一張牌 2 個字元的 base-62 ----------
     ⚠ 刻意**不用單字元**(`String.fromCharCode(48 + id)`):108 種超過可列印 ASCII 的量,
       單字元一定會踩進非 ASCII —— 而這個 repo 已經被 cp950 咬過一次
       (PowerShell 不帶 -Encoding 讀寫會把整檔中文毀掉)。
       2 個字元 × 108 = 216 字元,全 ASCII、在 Firebase 主控台上也讀得懂。 */
  const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const chr2   = id => ALPHA[Math.floor(id / 62)] + ALPHA[id % 62];
  function unchr2(s){
    if(typeof s !== "string" || s.length !== 2) return -1;
    const a = ALPHA.indexOf(s[0]), b = ALPHA.indexOf(s[1]);
    if(a < 0 || b < 0) return -1;
    const id = a * 62 + b;
    return (id >= 0 && id < NCARD) ? id : -1;
  }
  const encodeDeal = arr => arr.map(chr2).join("");
  function decodeDeal(s){
    if(typeof s !== "string" || s.length !== NCARD * 2) return null;
    const out = [], seen = new Uint8Array(NCARD);
    for(let i = 0; i < NCARD; i++){
      const id = unchr2(s.substr(i * 2, 2));
      if(id < 0 || seen[id]) return null;         // 認不出來 / 有重複 → 整份不接受
      seen[id] = 1; out.push(id);
    }
    return out;
  }

  /* ---------- 一手的編碼 ----------
       "p"+c2            出一張(非 Wild)
       "p"+c2+col        出 Wild 並指定顏色(col = r/y/g/b)
       …+"!"             這一手同時宣告 UNO(只有剩 1 張才准帶)
       "d"               抽(有罰抽就抽掉整份並結束回合)
       "x"               抽完之後不出,結束回合
       "c"+by+at         by 號座位抓 at 號座位沒喊 UNO
     ★ 「宣告 UNO」**一定要與出牌是同一個 move**,不可以做成「出完再按一顆鈕」——
       那會與下一家的出牌形成競態,而競態的結果會寫進 moves = 兩台重播出不同局面。 */
  const DRAW = "d", PASS = "x";
  function encPlay(id, col, declared){
    return "p" + chr2(id) + (isWild(id) ? COL_KEY[col] : "") + (declared ? "!" : "");
  }
  const encCatch = (by, at) => "c" + by + at;
  const isPlay  = mv => typeof mv === "string" && mv[0] === "p";
  const isDraw  = mv => mv === DRAW;
  const isPass  = mv => mv === PASS;
  const isCatch = mv => typeof mv === "string" && mv[0] === "c";
  /* 讀一手裡的牌 id(給音效 / 公告用;認不出來回 -1)。⚠ 不做合法性判斷。 */
  const moveCard = mv => isPlay(mv) ? unchr2(mv.substr(1, 2)) : -1;
  const moveDeclared = mv => isPlay(mv) && mv[mv.length - 1] === "!";

  /* ==========================================================================
     二、★★★ 決定性洗牌 —— 牌堆抽乾要重洗,而它不可以進 DB
     ──────────────────────────────────────────────────────────────────────────
       UNO 與前八個遊戲最大的結構差異就是這件事:**牌會抽乾**。
       6 人局發掉 42 張,牌堆只剩 65 張,而疊 +4 一輪就能吃掉十幾張 → 一定會洗到。

       做法:重洗的隨機源 = **hash(deal) 與「這是第幾次重洗」** 餵進 mulberry32。
       兩者都算得出來(deal 在 DB 裡、重洗次數是 replay 的副產物)→
       **每台裝置洗出完全相同的順序**,所以 { deal, moves } 仍然是唯一的真相,
       一個 DB 欄位都不必加、Firebase 規則不動、斷線重連自動一致。

       ⚠⚠ 這裡**絕對不可以用 Math.random()** —— 那會讓兩台裝置從第一次重洗之後
         算出完全不同的牌局,而症狀是「打到中盤忽然對不上」(最難查的一種)。
         newDeal() 是唯一准用 Math.random 的地方(它產生的是 deal 本身,會寫進 DB)。
       ⚠ 守門在 tools/test-uno-rules.js:同一份 (deal, moves) 連跑 100 次 replay,
         牌堆內容要逐張相同;另有一條突變把 seed 裡的 shuffles 拿掉 → 必須紅。
     ========================================================================== */
  function hashStr(s){
    let h = 2166136261;
    for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a){
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Fisher-Yates,吃外部給的 rnd()。★ 不動原陣列。 */
  function shuffleWith(arr, rnd){
    const a = arr.slice();
    for(let i = a.length - 1; i > 0; i--){
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ★ 產生一份新的發牌(唯一准用 Math.random 的地方 —— 它的結果會寫進 DB)。 */
  function newDeal(){
    const ids = [];
    for(let i = 0; i < NCARD; i++) ids.push(i);
    return encodeDeal(shuffleWith(ids, Math.random));
  }

  /* ==========================================================================
     三、房規(白名單守門)
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 值有一部分來自 DB / localStorage(舊房間沒有這個欄位、也可能被手改),
         所以一律**白名單**、認不出來就回預設 —— 同大老二 normRules 那條。
     ========================================================================== */
  /* ⚠⚠ playDrawn 的**預設是 false**(抽完就換下一家)—— 它與另外兩條的預設方向相反。
       v1.106.0 原本寫死成「抽到能出就可以馬上出」(官方規則),使用者要把它做成
       可設定的房規、而且**預設關掉**。所以這裡不要「順手」把它跟著改成 true:
       那不是筆誤,是刻意的。 */
  /* ⚠ toLast 的預設也是 **false**(有人打完就結束 = 官方規則)——
       它是 v1.110.0 加的第四條房規:開了之後**打到只剩一個人手上還有牌**才結束,
       每個人都有自己的名次(名次分改成看人數,見第六節)。 */
  function defRules(){ return { stack: true, unoCall: true, playDrawn: false, toLast: false, freeDraw: false }; }
  function normRules(r){
    const d = defRules();
    if(!r || typeof r !== "object") return d;
    return { stack:     typeof r.stack     === "boolean" ? r.stack     : d.stack,
             unoCall:   typeof r.unoCall   === "boolean" ? r.unoCall   : d.unoCall,
             playDrawn: typeof r.playDrawn === "boolean" ? r.playDrawn : d.playDrawn,
             toLast:    typeof r.toLast    === "boolean" ? r.toLast    : d.toLast,
             freeDraw:  typeof r.freeDraw  === "boolean" ? r.freeDraw  : d.freeDraw };
  }

  /* ==========================================================================
     四、一局的狀態
     ========================================================================== */
  /* 開局:發牌 + 翻起始牌。
     ★★ 起始牌**翻到第一張數字牌為止**(翻到動作牌就塞回牌堆底再翻)。
        官方是「動作牌對第一家生效、+4 要退回重洗」—— 那是五個各自的邊界情形,
        收成一條規則讓 replay 少五條分支,而且仍然完全決定性。
        ⚠ 塞回牌堆**底**(不是原地留著),否則下一張還是它 = 無窮迴圈。
     ⚠ 理論上不會翻不到:76 張數字牌,最多發掉 42 張 → 牌堆至少還有 34 張數字牌。
        但仍然留一個上限守衛 —— 壞掉的 deal 不該讓整頁凍住。 */
  function start(dealArr, n, rules){
    const st = {
      n: n, rules: normRules(rules),
      hands: [], pile: dealArr.slice(), disc: [],
      top: -1, col: -1, turn: 0, dir: 1,
      pend: 0, pendK: 0,                 // 累積罰抽張數 / 罰抽的種類
      drew: false, drewCard: -1,         // 這回合抽過了嗎 / 抽到的那張(只有它能出)
      uno: [],                           // 每個座位「這次剩 1 張有沒有宣告」
      catchSeat: -1,                     // 現在可以抓誰(-1 = 沒有);視窗是回合制的
      /* ★ 出完牌的座位,**照出完的先後**推進來(房規 toLast 的名次就是這個順序)。
         ⚠ 房規關著時它也照記(只會有一個人)—— score() 兩種模式共用同一把鑰匙。 */
      outOrder: [],
      shuffles: 0, seed: 0,
      over: false, winner: -1
    };
    /* ★ 重洗的隨機源在**這裡**算,不是在 replay 裡 ——
       start() 是匯出的(單機那邊也用得到),seed 留給呼叫端設就多一個
       「忘了設 → 靜靜退回 seed 0」的坑,而那個坑不報錯也不會壞掉任何斷言。 */
    st.seed = hashStr(encodeDeal(dealArr));
    for(let s = 0; s < n; s++){ st.hands.push([]); st.uno.push(false); }
    for(let r = 0; r < DEAL_N; r++)
      for(let s = 0; s < n; s++) st.hands[s].push(st.pile.shift());

    let guard = NCARD + 1;
    while(st.pile.length && guard-- > 0){
      const id = st.pile.shift();
      if(isNumK(CARDS[id].k)){ st.top = id; st.col = CARDS[id].col; st.disc.push(id); break; }
      st.pile.push(id);                       // 動作牌塞回牌堆底
    }
    if(st.top < 0) return null;               // deal 壞掉(理論上到不了)
    return st;
  }

  /* ---------- 抽牌 / 重洗 ---------- */
  function reshuffle(st){
    if(st.disc.length <= 1) return;                    // 只剩桌面那張 → 沒得洗
    const top = st.disc[st.disc.length - 1];
    const rest = st.disc.slice(0, -1);
    st.shuffles++;
    /* ★ seed 一定要把 shuffles 拌進去 —— 不然第二次、第三次重洗會洗出同一個順序。
       0x9E3779B9 是黃金比例的定點,拿來打散連續的整數(常見做法)。 */
    st.pile = shuffleWith(rest, mulberry32((st.seed ^ Math.imul(st.shuffles, 0x9E3779B9)) >>> 0));
    st.disc = [top];
  }
  function drawOne(st){
    if(!st.pile.length) reshuffle(st);
    return st.pile.length ? st.pile.shift() : -1;      // -1 = 真的一張都沒了
  }

  /* 還有幾個人手上有牌(房規 toLast 的結束條件) */
  const aliveCount = st => st.hands.reduce((c, h) => c + (h.length ? 1 : 0), 0);

  /* ---------- 輪次 ----------
     ⚠ 一律走這一支,不要在別處自己算 —— dir 與「跳過 = 走兩格」都在這裡。
     ★★ 「**跳過已經出完的人**」也在這裡(v1.110.0 的房規 toLast)——
        一格一格走,每一格都要停在「手上還有牌」的座位上。
        ⚠ 房規關著時這一層是**沒有作用**的(有人出完就立刻結束,盤面上不會同時
          存在空手與未結束),所以不必為它加 if:少一個分支就少一個走鐘點。
        ⚠⚠ 一定要**逐格**走而不是「先算 turn + dir*k 再往前找活人」——
          跳過(k=2)的語意是「跳掉下一個**還在玩的人**」,不是「跳掉下一個座位」;
          用後者的話,下一個座位剛好出完時那張跳過等於白出。
     ⚠ guard:全部人都出完(理論上到不了,結束條件會先擋)時不要卡死。 */
  function adv(st, k){
    for(let i = 0; i < k; i++){
      let guard = st.n;
      do{ st.turn = (((st.turn + st.dir) % st.n) + st.n) % st.n; }
      while(st.hands[st.turn].length === 0 && guard-- > 0);
    }
  }

  /* ==========================================================================
     ★ 規則的心臟:這張現在出不出得了
     ──────────────────────────────────────────────────────────────────────────
       三道門,順序不可以換:
         ① 有罰抽在頭上 → 只有「疊得上的同種牌」能出(房規關掉就一張都不能出)
         ② 剛抽了一張 → 只有抽到那一張能出(官方:抽到的牌能出就出)
         ③ 一般情形 → Wild 隨時可出 · 同色 · 同數字/同動作
       ⚠ ③ 的「同數字或同動作」寫成一句 `c.k === top.k` 是靠**數字 0..9 與動作
         10..14 範圍不重疊**(見第一節 K_SKIP 從 10 起跳那條)。
     ========================================================================== */
  function legalOn(st, id){
    if(!st || id < 0 || id >= NCARD) return false;
    const c = CARDS[id];
    if(st.pend > 0) return st.rules.stack && c.k === st.pendK;   // ★ 同種才疊得上
    if(st.drew) return id === st.drewCard;
    return isWildK(c.k) || c.col === st.col || c.k === CARDS[st.top].k;
  }
  /* 這副手牌現在出得了哪幾張(手牌亮暗 / 「有沒有牌可出」都問這一支) */
  function playable(hand, st){ return (hand || []).filter(id => legalOn(st, id)); }
  const canPlay = (hand, st) => playable(hand, st).length > 0;

  /* ==========================================================================
     五、走一手
     ──────────────────────────────────────────────────────────────────────────
       ★★ 抓「沒喊 UNO」的視窗是**回合制的,不是計時的** ——
          官方寫的就是「在**下一家出手之前**被抓到才算」。落在 moves 這個有序
          日誌上就完全決定性:`c` 只有出現在「目標那一手之後、下一個 p/d 之前」
          才算數。所以這裡的落地只有兩行:出牌時開視窗、下一個 p/d 關視窗。
          ⚠ `c` 自己**不關**視窗(不然兩個人同時想抓,慢的那個會變成非法手)。
     ========================================================================== */
  function step(st, mv){
    if(!st || st.over || typeof mv !== "string" || !mv.length) return false;
    const t = mv[0];
    if(t === "c") return doCatch(st, mv);
    /* ⚠⚠ 「d」現在可能被強制出牌擋掉(手上有合法牌可出時 doDraw 回 false)——
       一定要等它**真的成功**才關視窗,不可以先清再呼叫,否則一手被擋掉的非法
       「d」照樣會把視窗關掉(回合沒真的往前走,視窗卻悄悄關了)。
       ⚠ 「p」不一樣,不要為了對稱把它改成同一種寫法:doPlay 自己的尾巴會在
       「剩 1 張又沒宣告」時**重新**開視窗,所以這裡沿用原本「先清掉上一個視窗、
       再讓 doPlay 決定要不要開新的」這個順序 —— 兩邊的正確做法本來就不同。 */
    if(t === "d"){ const ok = doDraw(st); if(ok) st.catchSeat = -1; return ok; }
    if(t === "p"){ st.catchSeat = -1; return doPlay(st, mv); }
    if(t === "x") return doPass(st);
    return false;
  }

  function doPlay(st, mv){
    const id = unchr2(mv.substr(1, 2));
    if(id < 0) return false;
    const seat = st.turn, h = st.hands[seat], at = h.indexOf(id);
    if(at < 0) return false;                       // 他手上沒這張
    if(!legalOn(st, id)) return false;

    let rest = mv.slice(3), col = -1;
    if(isWild(id)){
      col = COL_KEY.indexOf(rest[0]);
      if(col < 0) return false;                    // Wild 一定要指定顏色
      rest = rest.slice(1);
    }
    const declared = (rest === "!");
    if(rest !== "" && !declared) return false;     // 認不出來的尾巴 → 整手不接受
    /* ⚠ 只有「出掉這張之後剩 1 張」才准帶 `!` —— 亂喊要擋掉,
       不然日誌裡的 `!` 就不再等於「他真的喊了 UNO」。 */
    if(declared && h.length !== 2) return false;

    h.splice(at, 1);
    st.disc.push(id); st.top = id;
    st.drew = false; st.drewCard = -1;
    st.col = (col >= 0) ? col : CARDS[id].col;
    st.uno[seat] = declared;

    /* ★★ 出完最後一張。兩種房規在這裡分岔:
         toLast 關(預設 / 官方):**這一局立刻結束**,他就是 winner ——
           ⚠ 這一條刻意**在動作牌生效之前** return:最後一張是 +2 的話,
             結束了才罰下一家沒有意義,而畫面上還會多一個「罰抽 2」的殘影。
         toLast 開:他退場,**牌局繼續**打到只剩一個人 ——
           這時最後一張的動作牌**照樣生效**(出 +2 收尾就是要讓下一家吃)。 */
    if(!h.length){
      st.outOrder.push(seat);
      if(!st.rules.toLast){ st.over = true; st.winner = seat; return true; }
      if(st.winner < 0) st.winner = seat;          // ★ winner 恆為「第一個出完的人」
    }

    switch(CARDS[id].k){
      case K_SKIP: adv(st, 2); break;
      /* ★★ 迴轉:**一律**反轉方向再走一格,2 人局不特別處理。
         官方規則是「2 人局的迴轉等同跳過」(出的人再出一次),v1.106.0~v1.108.0
         照官方寫成 `if(st.n === 2) adv(st, 2)`,而實際玩起來的回饋是
         「放回轉牌之後又輪到自己,應該要換別人玩」—— 兩個人的桌上「反轉」與
         「換人」是同一件事,再送自己一個回合只是讓對手乾等。
         ⚠ 這一條與 K_SKIP **刻意不同**:跳過在 2 人局仍然是「跳掉對手 = 我再出一次」,
           那是玩家對「跳過」這兩個字的預期,沒有人抱怨過。 */
      case K_REV:  st.dir = -st.dir; adv(st, 1); break;
      case K_D2:   st.pend += 2; st.pendK = K_D2; adv(st, 1); break;
      case K_W4:   st.pend += 4; st.pendK = K_W4; adv(st, 1); break;
      default:     adv(st, 1);
    }
    /* ★ toLast:只剩一個人手上還有牌 → 這一局結束(他是最後一名)。
       ⚠ 一定要放在動作牌之後 —— 最後那張 +2 要先砸出去,盤面才是對的。 */
    if(!h.length && aliveCount(st) <= 1){ st.over = true; return true; }
    // 剩 1 張又沒宣告 → 開抓的視窗(房規關掉就沒有抓這件事)
    if(h.length === 1 && !declared && st.rules.unoCall) st.catchSeat = seat;
    return true;
  }

  function doDraw(st){
    const seat = st.turn;
    /* ★★★ 手上有合法牌可出時**預設**不准抽 —— 強制出牌,是否放行是房規 freeDraw
       (預設關,照原本的強制出牌)。
       這裡刻意用 canPlay(),與「疊牌」共用同一個閘門:被罰抽時如果手上有同種牌
       能疊上去,也一樣不准直接抽來吃掉罰抽(能疊就必須疊)—— freeDraw 開著時這條
       也一起放行(能疊也可以選擇直接抽掉整份罰抽)。
       ⚠ ai.js 不受這條房規影響 —— 它一路都是 pl.length 才回 DRAW(見 notes/18 AI 節:
       屯牌 / 白白放棄能出的牌都是負收益),freeDraw 只多給**人類玩家**一個選項。
       ⚠⚠ 「一個回合只能抽一次」**不必再寫成獨立的一條**(`if(st.drew) return false`)——
       抽到的那張只要合法,legalOn() 就會把 st.drew 的 gate 套在它身上,讓它自己也算
       canPlay 為真的其中一張;換句話說 st.drew 為真時 canPlay 必然為真,這一行會先
       擋下來(freeDraw 開著也一樣 —— 這一行只管「有沒有牌能出」,不管想不想出)。
       第一版寫了獨立那一行,突變測試證明它是**測不到的等價碼**(拿掉照樣
       全綠,因為上面這行永遠先擋),所以直接拿掉,不留一層沒有牙齒的檢查。 */
    if(!st.rules.freeDraw && canPlay(st.hands[seat], st)) return false;
    if(st.pend > 0){
      for(let i = 0; i < st.pend; i++){ const id = drawOne(st); if(id < 0) break; st.hands[seat].push(id); }
      st.pend = 0; st.pendK = 0;
      st.uno[seat] = false;
      adv(st, 1);                                   // 罰抽 = 這一回合也沒了
      return true;
    }
    const id = drawOne(st);
    if(id < 0){ adv(st, 1); return true; }          // 真的一張都抽不到 → 只能過
    st.hands[seat].push(id);
    st.uno[seat] = false;                           // 抽了牌就不再是「剩一張」
    /* ★★ 抽到的牌能不能馬上出是**房規**(playDrawn,預設關)——
         開:留在他的回合讓他決定(官方規則,他可以出、也可以送 "x" 不出);
         關:抽完就直接換下一家(抽牌 = 這一回合結束,不必再多寫一手 "x")。
       ⚠ 關的時候 st.drew **永遠不會立起來**,連帶三件事自動失效:
         `legalOn` 的 drew 閘門、`doPass`("x")、以及 ai.js 的 v.drew 分支。
         那三處都不必為這條房規加 if —— 這是刻意的(少三個分支就少三個走鐘點)。 */
    if(st.rules.playDrawn && legalOn(st, id)){ st.drew = true; st.drewCard = id; }
    else adv(st, 1);
    return true;
  }

  function doPass(st){
    if(!st.drew) return false;                      // 沒抽過就沒有「不出」這個動作
    st.drew = false; st.drewCard = -1;
    adv(st, 1);
    return true;
  }

  function doCatch(st, mv){
    if(!st.rules.unoCall) return false;
    const by = ALPHA.indexOf(mv[1]), at = ALPHA.indexOf(mv[2]);
    if(by < 0 || at < 0 || by >= st.n || at >= st.n || by === at) return false;
    if(st.catchSeat !== at) return false;           // 視窗已經關了 / 他沒有漏喊
    for(let i = 0; i < 2; i++){ const id = drawOne(st); if(id < 0) break; st.hands[at].push(id); }
    st.uno[at] = false;
    st.catchSeat = -1;
    return true;
  }

  /* ==========================================================================
     ★ 唯一的真相入口
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 非法的一手一律**整份中止並回 null**,不可以「跳過那一手繼續跑」——
         那會讓兩台裝置在其中一台判非法時算出不同局面(而且不報錯)。
     ========================================================================== */
  function replay(deal, n, moves, rules){
    if(!(n >= MIN_PLAYERS && n <= MAX_PLAYERS)) return null;
    const arr = decodeDeal(deal);
    if(!arr) return null;
    const st = start(arr, n, rules);                // ★ seed 由 start() 自己算好
    if(!st) return null;
    const list = Array.isArray(moves) ? moves : [];
    for(let i = 0; i < list.length; i++){
      if(st.over) return null;                      // 結束之後還有手 → 資料壞了
      if(!step(st, list[i])) return null;
    }
    return st;
  }

  /* ==========================================================================
     六、結算 —— 名次分(兩張表:官方模式 5/3/1/0 · toLast 模式看人數)
     ──────────────────────────────────────────────────────────────────────────
       ★ 官方模式那張與 js/big2/rules.js 的 RANK_PTS / ptsForRank **逐字相同的一份**
         (6 人局自然就是 5/3/1/0/0/0,最後一名恆 0)。
       ★ 名次一律照「**手牌點數 → 張數 → 座位**」排 ——
         點數放第一順位是刻意的:UNO 的策略味道就是「別留大牌」,
         而 Wild 一張 50 分抵得過十張數字牌。座位放最後只為了保證決定性。

       ★★ 「打完的那個人恆為第一名」**不必特別寫一條** ——
          他手上 0 張 = 0 點,而 0 點是這個排序的最小值,所以他自動排第一。
          ⚠ 第一版真的多寫了一條 `a.seat === st.winner ? 0 : 1` 當第一順位,
            而突變測試把它拿掉之後**照樣全綠**。那不是「測試不夠」而是**那段碼
            在 UNO 裡到不了**:一有人打完就立刻結束 → 不可能有第二個人也是 0 張。
            測不到的碼拿掉,比留著配一條永遠測不到的斷言好。
          ⚠ 這與大老二「`bombLv()` 看起來多餘但不可以拿掉」是**相反的情形** ——
            那一層真的擋著「靠編碼巧合」,這一條沒擋任何東西。
     ========================================================================== */
  const RANK_PTS = [5, 3, 1, 0];
  /* ★★★ 房規 toLast 開著時的名次分:**每一名都有分,而且分數依人數算**
     (使用者:「這個時候也是用積分的方式給,麻煩你依人數決定到底要給多少積分」)。
       公式:第一名固定 5 分、最後一名固定 0 分,中間**平均分佈**再四捨五入 →
         2 人 5 / 0
         3 人 5 / 3 / 0
         4 人 5 / 3 / 2 / 0
         5 人 5 / 4 / 3 / 1 / 0
         6 人 5 / 4 / 3 / 2 / 1 / 0
     ★ 為什麼頂端仍然是 5:目標分(房間設定,預設 15)是同一個,頂端一換整個「打幾局
       才會結束」就跟著換 —— 而房規是一局一局在切的,不該把賽制也拖著走。
     ⚠⚠ **不可以**在這個模式沿用 5/3/1/0:那張表 4 人以後全部是 0 分,而 toLast 的
       整個重點就是「後面幾名之間也要分高下」—— 沿用等於打到最後卻沒有意義。
     ⚠ 每一個人數的表都必須**嚴格遞減**(不可以有兩名同分),守門在 test 的 K 節。 */
  function ptsForRankOut(rank, n){
    if(!(n >= 2) || rank >= n) return 0;
    return Math.round(5 * (n - rank) / (n - 1));
  }
  /* ⚠ 第三個參數是**選填**的(舊呼叫端 / 大老二那份逐字相同的表都不帶)——
     不帶就是原本的 5/3/1/0、最後一名恆 0。 */
  function ptsForRank(rank, n, toLast){
    if(toLast) return ptsForRankOut(rank, n);
    return rank === n ? 0 : (RANK_PTS[rank - 1] || 0);
  }
  const handPts = cards => (cards || []).reduce((s, id) => s + ptsOf(id), 0);

  /* ★★ 名次的第一把鑰匙是 **outOrder(誰先出完)**,第二把才是手牌點數。
     兩種房規共用同一段排序:
       toLast 關 → outOrder 裡只有一個人(贏家),而他手上 0 張 = 0 點,
         本來就會排第一 → **這一把鑰匙在那個模式下不改變任何結果**。
       toLast 開 → 出完的人手上都是 0 張 0 點,**只有出完的先後**分得出高下,
         沒有這把鑰匙他們會全部並列然後照座位排(= 名次是假的)。
     ⚠ 所以它不是「多寫一層測不到的碼」(那是 v1.106.0 拿掉的 `a.seat === st.winner`)——
       這一層在 toLast 開的時候是**唯一**的判準,K 節有兩條斷言分別釘住兩個模式。 */
  function score(st){
    const rows = [];
    const order = Array.isArray(st.outOrder) ? st.outOrder : [];
    const OUTLESS = 1e9;                       // 還沒出完的人一律排在出完的人後面
    for(let s = 0; s < st.n; s++){
      const oi = order.indexOf(s);
      rows.push({ seat: s, left: st.hands[s].length, pts: handPts(st.hands[s]),
                  out: oi, rank: 0, rp: 0 });
    }
    const toLast = !!(st.rules && st.rules.toLast);
    const sorted = rows.slice().sort((a, b) =>
      ((a.out < 0 ? OUTLESS : a.out) - (b.out < 0 ? OUTLESS : b.out)) ||
      (a.pts - b.pts) || (a.left - b.left) || (a.seat - b.seat));
    sorted.forEach((r, i) => { r.rank = i + 1; r.rp = ptsForRank(r.rank, st.n, toLast); });
    return { rows: rows, sorted: sorted,
             winners: st.winner >= 0 ? [st.winner] : sorted.filter(r => r.rank === 1).map(r => r.seat) };
  }

  /* ==========================================================================
     七、顯示用(純函式,但不參與任何判定)
     ========================================================================== */
  /* 手牌的顯示排序:先分顏色(紅黃綠藍),同色照 k 遞增,Wild 一律排最後。
     ⚠ 這是**顯示層的東西**,放在這裡只因為它是純函式、要在 node 裡驗
       (同大老二的 sortShow)。出的是「哪一張牌」,順序對判定沒有意義。 */
  /* ★★ 「Wild 排最後」**不必特別寫一條** —— C_WILD 是 4,而四個真顏色是 0..3,
     所以照 col 遞增排就已經把 Wild 掃到最後面了(同 score() 那條「打完的人恆第一名」,
     突變把多餘的那層拿掉之後照樣全綠)。
     ⚠ 這件事是 C_WILD 的**定義**保證的,不是巧合 —— 但既然是靠它,就把它寫成
       一條斷言(test-uno-rules.js 的 K2 節)而不是寫成一層測不到的碼。 */
  function sortHand(cards){
    return (cards || []).slice().sort((a, b) => {
      const ca = CARDS[a], cb = CARDS[b];
      return (ca.col - cb.col) || (ca.k - cb.k) || (a - b);
    });
  }
  /* 「還剩一張」—— 給晶片與公告用。★ 只公開一個 bit,牌值一律不准(牌情紅線)。 */
  const isUno = cards => !!cards && cards.length === 1;

  return {
    // 常數
    MIN_PLAYERS, MAX_PLAYERS, DEAL_N, NCARD, CARDS, RANK_PTS,
    C_R, C_Y, C_G, C_B, C_WILD, COL_KEY, COL_NAME, COL_LETTER,
    K_SKIP, K_REV, K_D2, K_WILD, K_W4, K_LABEL, K_NAME, DRAW, PASS,
    // 一張牌
    colOf, kindOf, isWild, isWildK, isNumK, ptsOf, ptsOfK, labelOf, nameOf, letterOf,
    // 編碼
    chr2, unchr2, encodeDeal, decodeDeal, newDeal,
    encPlay, encCatch, isPlay, isDraw, isPass, isCatch, moveCard, moveDeclared,
    // 房規
    defRules, normRules,
    // 一局
    start, step, replay, adv, drawOne, reshuffle, legalOn, playable, canPlay, aliveCount,
    // 結算 / 顯示
    score, ptsForRank, ptsForRankOut, handPts, sortHand, isUno,
    // 洗牌(測試要單獨驗決定性)
    hashStr, mulberry32, shuffleWith
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = UN;

"use strict";

/* ============================================================================
   UNO — 電腦對手(UNAI)。
   ★ 純函式,零 DOM、零 Firebase、零 MP。棋力**只有靠 node 大量對打才驗得出來**,
     碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩(CLAUDE.md 紅線 16)。

   ── ★ AI 不作弊是「結構上」做到的 ────────────────────────────────────────────
     所有決策只看 viewOf() 濾出來的 view,而 view 裡**沒有任何對手的牌值** ——
     只有「每家還剩幾張」「桌上那張是什麼」「現在的有效顏色」「牌河公開過哪些牌」。
     守門(test-uno-ai.js A 節):把對手的手牌**整副換掉**再問一次,
     三個難度的選擇都必須一模一樣。

   ── ★★ 目標函數是名次分,不是「平均剩幾張」──────────────────────────────
     排七與大老二都踩過這個坑(notes/15 第五節):某個策略平均剩牌**全場最低**、
     第一名率卻比亂出還差 —— 它讓自己好看,但讓對手更好看。
     調參一律看 **平均名次分 / 第一名率**,而且 **2 / 3 / 4 / 6 人局都要各驗一次**
     (只驗 4 人局會漏掉「策略只在某個人數成立」)。

   ── ★★★ 這一頁的 AI 有一件別的遊戲沒有的義務:**它必須會喊 UNO** ────────────
     房規開著「沒喊 UNO 罰抽 2 張」時,AI 出到剩一張沒宣告就會被玩家抓 ——
     那不是「AI 比較弱」,是**AI 看起來很笨**(玩家會覺得電腦在放水)。
     所以三個難度**一律都喊**:漏喊不是難度,是 bug。
     ⚠ 反過來「AI 要不要去抓玩家」才是難度:easy 不抓、mid 一半、hard 一定抓。

   ── 三個難度 ──────────────────────────────────────────────────────────────
     新手 easy  隨機合法手;不會挑顏色(Wild 亂指);不抓人
     普通 mid   優先出動作牌壓制下一家、Wild 留到出不了才用;指定自己最多的顏色
     高手 hard  評分函式(手牌權重 + 顏色集中度 + 下一家剩幾張)+
                看到有人剩 1~2 張就把 +2/+4/跳過 砸在他頭上;一定抓漏喊的人
   ========================================================================== */

const UNAI = (function(){

  const LEVELS = ["easy", "mid", "hard"];
  const LEVEL_NAME = { easy: "新手", mid: "普通", hard: "高手" };

  /* 難度的門面資料(選單與單機列直接讀這裡,不在畫面層另外硬編一份文案)。
     think = 可見的思考時間:算完只花 1ms 的話,幾家會在同一格瞬間打完,
     玩家看到的是「我一出牌畫面就整個變了」,根本讀不出剛才發生什麼事。 */
  const LEVEL_INFO = {
    easy: { key:"easy", name:"新手", emoji:"🙂", think:420,
            desc:"隨便出、Wild 亂指顏色、不會抓你漏喊" },
    mid:  { key:"mid",  name:"普通", emoji:"🤔", think:540,
            desc:"先出動作牌卡你,Wild 留到最後才用,指定自己最多的顏色" },
    /* ⚠ 文案照實寫 hard **真正**做的三件事,不要吹「它算得比較深」——
       實測貪心策略就是天花板(見 pickHard 上面那一大段),hard 與 mid 的差別
       在「難對付」而不是「會贏」。寫不實的文案玩家一局就看出來了。 */
    hard: { key:"hard", name:"高手", emoji:"😈", think:680,
            desc:"你剩一兩張就把 +4 砸過來、自己要輸了先清大牌,而且一定抓你漏喊 UNO" }
  };
  const LEVEL_KEYS = LEVELS.slice();
  const levelOf = k => LEVEL_INFO[k] || LEVEL_INFO.mid;
  const thinkMs = k => levelOf(k).think;

  /* ==========================================================================
     一、★ view —— AI 唯一看得到的東西
     ──────────────────────────────────────────────────────────────────────────
       刻意只收「公開資訊」:
         • 自己的手牌
         • 桌上那張牌 + 現在的有效顏色(攤在桌上的,連牌值都公開)
         • 每一家還剩幾張(晶片上就寫著)
         • 牌河裡公開過哪些牌(可以數牌 —— 人類也做得到)
         • 罰抽累積 / 方向 / 房規(面板上人人看得到)
       **絕對不含 st.hands 的其他座位**。多回一個欄位就等於 AI 開始作弊,
       而症狀是「電腦強得莫名其妙」,在畫面上完全看不出來。
     ⚠ 房規一定要進 view:漏了它的症狀最惡劣 —— AI 用「疊得上」去挑一手,
       規則層擋下來 → step() 回 false → **整局靜靜卡住**(不是「下得比較差」)。
     ========================================================================== */
  function viewOf(st, seat){
    return {
      n: st.n, seat: seat,
      rules: UN.normRules(st.rules),
      hand: st.hands[seat].slice(),
      top: st.top, col: st.col,
      dir: st.dir, pend: st.pend, pendK: st.pendK,
      drew: !!st.drew, drewCard: st.drewCard,
      left: st.hands.map(h => h.length),
      disc: st.disc.slice(),
      catchSeat: st.catchSeat,
      pileLeft: st.pile.length
    };
  }

  /* 下一家是誰(view 裡有 dir 與 n 就算得出來)。
     ★ 要**跳過已經出完的人**(房規 toLast 開著時才會有人手上 0 張)——
       不跳的話 hard 那條「你剩 1~2 張就把 +4 砸過來」會瞄準一個已經退場的座位,
       而症狀是「電腦忽然變笨」,畫面上完全看不出來。
     ⚠ `left` 是 view 本來就有的公開資訊(晶片上就寫著),不是新開的洩漏通道。
     ⚠ guard:全部人都出完(到不了,規則層會先結束)時不要卡死。 */
  function nextSeatOf(v){
    const left = v.left || [];
    let s = v.seat, guard = v.n;
    do{ s = (((s + v.dir) % v.n) + v.n) % v.n; }
    while(left[s] === 0 && s !== v.seat && guard-- > 0);
    return s;
  }

  /* 一張牌在**手上**有多好用(越高 = 越想留)。★ 這不是官方點數 ——
     官方點數是「留著會被罰多少」,這裡要的是「留著有多好用」,兩件事不同:
     Wild 官方 50 分(最不想留),但它是**萬用牌**,留一張到後期非常強。
     所以權重刻意做成:Wild 最有用 → 但 hard 會用「快出完了就趕快清」去抵消它。 */
  function useful(id){
    const k = UN.kindOf(id);
    if(k === UN.K_W4) return 9;
    if(k === UN.K_WILD) return 8;
    if(k === UN.K_D2) return 5;
    if(k === UN.K_SKIP || k === UN.K_REV) return 4;
    return 1;
  }

  /* 手上每個顏色各幾張(Wild 不算色) */
  function colCounts(hand){
    const c = [0, 0, 0, 0];
    hand.forEach(id => { const col = UN.colOf(id); if(col < 4) c[col]++; });
    return c;
  }
  /* 出 Wild 時要指定哪個顏色:自己手上最多的那一個(平手取索引小的,保證決定性)。
     ⚠ 一張色牌都沒有(整手都是 Wild)時回紅色 —— 不可以回 -1,那會讓 encPlay
       產生認不出來的一手 → step 拒絕 → 整局卡住。 */
  function bestColor(hand){
    const c = colCounts(hand);
    let best = 0;
    for(let i = 1; i < 4; i++) if(c[i] > c[best]) best = i;
    return best;
  }

  /* ==========================================================================
     二、要不要喊 UNO / 要不要抓人
     ────────────────────────────────────────────────────────────────────────── */
  /* ★★★ 出這一手之後會剩 1 張 → **一律宣告**(三個難度都一樣,見檔頭)。
     ⚠ 房規關掉時 encPlay 帶不帶 `!` 都無所謂,但帶了會被 doPlay 接受並記下,
       所以這裡照樣只在「剩 1 張」時帶 —— 亂帶會被規則層擋掉整手。 */
  const willDeclare = (v, hand) => hand.length === 2;

  /* 要不要去抓漏喊的人。★ 這一格才是難度。 */
  function wantCatch(v, level, rng){
    if(!v.rules.unoCall) return false;
    if(v.catchSeat < 0 || v.catchSeat === v.seat) return false;
    if(level === "easy") return false;
    if(level === "mid") return rng() < 0.5;
    return true;                                    // hard 一定抓
  }

  /* ==========================================================================
     三、三個難度各自怎麼挑
     ────────────────────────────────────────────────────────────────────────── */
  function pickEasy(v, rng){
    const pl = UN.playable(v.hand, v);
    if(!pl.length) return UN.DRAW;
    const id = pl[Math.floor(rng() * pl.length)];
    // ★ 亂指顏色 —— 這就是「新手」看起來笨的地方
    return UN.encPlay(id, Math.floor(rng() * 4), willDeclare(v, v.hand));
  }

  function pickMid(v, rng){
    const pl = UN.playable(v.hand, v);
    if(!pl.length) return UN.DRAW;
    /* 排序:動作牌優先(卡下一家)、Wild 留到最後、同分照顏色集中度。
       ⚠ 有罰抽在頭上時 pl 只會是「疊得上的同種牌」,這個排序照樣安全。 */
    const cc = colCounts(v.hand);
    const rank = id => {
      const k = UN.kindOf(id);
      if(UN.isWildK(k)) return 100;                 // Wild 最後才用
      if(k === UN.K_D2) return 0;
      if(k === UN.K_SKIP || k === UN.K_REV) return 1;
      return 10 - Math.min(9, cc[UN.colOf(id)]);    // 數字牌:先出自己最多的顏色
    };
    const best = pl.slice().sort((a, b) => rank(a) - rank(b) || a - b)[0];
    return UN.encPlay(best, bestColor(v.hand.filter(x => x !== best)), willDeclare(v, v.hand));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ★★★ hard —— 這一支調了三輪,而**最重要的產出是一個結論**:

         **UNO 的貪心策略已經接近這個資訊量的天花板。**

     量法:一個座位放 X、其餘放 mid,跑 1200~2000 局,看 X 的平均名次分,
     跟**中立值**比(中立值 = 所有名次的名次分平均:2人 2.50 · 3人 2.67 ·
     4人 2.25 · 6人 1.50)。試過五種評分:
       屯動作牌 / 分層+一步預看 / 分層+節奏權重 / mid+最小增量 / 防禦性留 +2
     全部落在中立值 ±0.1 之內或更差,而**對照組(把 mid 的政策逐字複製一份)
     自己也在 ±0.06 晃** —— 那就是雜訊底線,沒有一個變體穿得過去。

     為什麼:UNO 沒有隱藏資訊可以推理(對手手牌完全看不到、也推不出來),
     一手能做的決策只有「這幾張合法牌裡挑一張」,而「動作牌優先、Wild 留最後、
     先出自己最多的顏色」已經把這件事做完了。剩下的是運氣。

     ⚠⚠ 兩個必須記下來的**錯法**(都是「看起來像棋力,實測更弱」):
       ① **屯動作牌是負收益。** +2 / 跳過 打出去是純節奏收益(對手少一個回合、
          還多兩張牌);握在手上一點作用都沒有。第一版屯它們 → 4/6 人局連 easy 都輸。
       ② **「優先出零散顏色」是反的。** 出掉自己最多的顏色,桌面就**留在自己的主色**
          → 下一輪還有一堆同色的出得掉。出零散顏色會把桌面推到自己牌少的顏色去。
       ③ 連續分數會讓層與層互相跨過去(數字牌最高 47 > +2 的 40 → 放掉節奏牌)。

     ★ 所以 hard **不是「比 mid 會贏」,是「比 mid 難對付」** —— 差別做在三件
       verifiable 的行為上,而不是虛構的棋力:
         ① **一定抓你漏喊 UNO**(mid 只有一半、easy 不抓)
         ② **你剩 1~2 張時把 +4 砸過來**(mid 不看這件事)
         ③ **自己要輸了就先清大牌**(名次分照點數排 → 你少賺分)
       難度說明的文案也照這個寫,不要吹「它算得比較深」。
     ══════════════════════════════════════════════════════════════════════════ */
  function pickHard(v, rng){
    const pl = UN.playable(v.hand, v);
    if(!pl.length) return UN.DRAW;
    /* ★ 只看**下一家**是刻意的:跳過與 +2 只作用在下一家,
       看「全場最少張的人」會挑出砸不到他的牌。 */
    const nxt = nextSeatOf(v);
    const threat = v.left[nxt] <= 2;
    /* 有任何對手快出完 → 這一局大概要輸了,順手把大牌清掉(名次分照點數排) */
    let minFoe = 99;
    for(let s = 0; s < v.n; s++) if(s !== v.seat) minFoe = Math.min(minFoe, v.left[s]);
    const anyClose = minFoe <= 2;
    const cc = colCounts(v.hand);

    /* 排序鍵(**升冪**,越小越先出)—— 骨幹與 mid 逐字同一套,那是天花板。
       ⚠ Wild 一律 100 = 留到「只剩它能出」才會被挑到,而那正好是最強的用法:
         留一張萬用牌當最後一張,就保證最後一手一定出得掉。
         **不要**為了「快出完了就清掉」去促進它 —— 實測 2 人局掉 0.13 分。 */
    function rank(id){
      const k = UN.kindOf(id);
      if(UN.isWildK(k)){
        // ★ 唯一的例外:下一家只剩 1~2 張時,+4 是武器(這是 hard 的第 ② 件事)
        return (threat && k === UN.K_W4) ? -10 : 100;
      }
      if(k === UN.K_D2)   return threat ? -8 : 0;
      if(k === UN.K_SKIP) return threat ? -7 : 1;
      if(k === UN.K_REV)  return v.n === 2 ? (threat ? -7 : 1) : 5;   // 2 人局的迴轉就是跳過
      /* 數字牌:先出自己最多的那個顏色。
         ★ 自己要輸了就從大的先清(hard 的第 ③ 件事)—— 權重刻意只放在**同分裁決**,
           不進主鍵:第二版把它加進主鍵(最多 +50),為了少罰幾點而放掉節奏牌,反而更差。 */
      return 10 - Math.min(9, cc[UN.colOf(id)]);
    }
    const best = pl.slice().sort((a, b) =>
      rank(a) - rank(b) ||
      (anyClose ? UN.ptsOf(b) - UN.ptsOf(a) : 0) ||     // 要輸了 → 大牌先出
      (a - b))[0];
    /* Wild 的顏色:算「出掉這張之後」手上最多的顏色。
       ⚠ 一定要先扣掉自己這一張,不然出掉最後一張紅牌還會指定紅色。 */
    return UN.encPlay(best, bestColor(v.hand.filter(x => x !== best)), willDeclare(v, v.hand));
  }

  const PICKERS = { easy: pickEasy, mid: pickMid, hard: pickHard };

  /* ==========================================================================
     四、對外介面
     ──────────────────────────────────────────────────────────────────────────
       ★ 兩件事分開問,因為它們發生在不同的時機:
           pick()      輪到我了,要出什麼 / 抽牌 / 抽完要不要出
           catchMove() 不是我的回合,但有人漏喊 UNO —— 要不要抓
     ========================================================================== */
  function pickFromView(v, level, rng){
    const r = rng || Math.random;
    /* ★ 抽完之後:能出就出(官方規則),出不了就結束回合。
       ⚠ 這一段一定要在 PICKERS 之前 —— drew 狀態下 playable 只會回抽到那一張,
         三個難度的排序邏輯在這裡沒有意義,而且 easy 的亂指顏色照樣要生效。 */
    if(v.drew){
      const pl = UN.playable(v.hand, v);
      if(!pl.length) return UN.PASS;
      const id = pl[0];
      const col = (level === "easy") ? Math.floor(r() * 4)
                                     : bestColor(v.hand.filter(x => x !== id));
      return UN.encPlay(id, col, willDeclare(v, v.hand));
    }
    return (PICKERS[level] || pickMid)(v, r);
  }
  function pick(st, seat, level, rng){
    return pickFromView(viewOf(st, seat), level, rng);
  }
  /* 不是我的回合時要不要抓人。回 null = 不抓。 */
  function catchFromView(v, level, rng){
    return wantCatch(v, level, rng || Math.random) ? UN.encCatch(v.seat, v.catchSeat) : null;
  }
  function catchMove(st, seat, level, rng){
    return catchFromView(viewOf(st, seat), level, rng);
  }

  /* 連線「到期自動出牌」用:替**人類**代打,所以一律固定「普通」、不套任何難度。
     (同排七 SVAI.autoMove / 大老二 B2AI.autoMove 的理由:那不是電腦的個性
      該出現的地方 —— 玩家會覺得「系統幫我出的牌比我強/比我爛」。)
     ⚠ 代打**不抓人**:抓是主動行為,替人做太超過。 */
  function autoMove(st, seat){
    return pickFromView(viewOf(st, seat), "mid", Math.random);
  }

  return {
    LEVELS, LEVEL_NAME, LEVEL_INFO, LEVEL_KEYS, levelOf, thinkMs,
    viewOf, nextSeatOf, useful, colCounts, bestColor, willDeclare, wantCatch,
    pick, pickFromView, catchMove, catchFromView, autoMove
  };
})();

/* node 測試用 */
if (typeof module !== "undefined" && module.exports){
  if (typeof UN === "undefined") global.UN = require("./rules.js");
  module.exports = UNAI;
}

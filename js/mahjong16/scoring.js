"use strict";

/* ============================================================================
   台灣 16 張麻將 — 台數計算與收付結算(MJ16S)。
   ★ 純函式,零 DOM、零 Firebase。相依只有同目錄的 rules.js(MJ16)。

   ── 兩件事 ────────────────────────────────────────────────────────────────
     score()   一副胡牌值幾台(資料驅動的台數表)
     settle()  這一局誰付誰、各付多少 —— **相互算台,增減總和恆為 0**

   ── ★ 台數表是「本桌規則」,不是宇宙真理 ──────────────────────────────────
     台灣麻將各地算法不同(門清自摸算 3 台還是 2 台、混老頭要不要再加碰碰胡…)。
     這張 TAI 表就是本專案的**單一真相**,要改就改這裡,不要在別處寫特例。
     本表採用的幾個有爭議的選擇,已逐條寫在該台種的註解裡。

   ── ★ 為什麼一定要枚舉所有拆法 ────────────────────────────────────────────
     同一副牌常常拆得出好幾種,台數不一樣(`b1b1b1 b2b2b2 b3b3b3` 可以是三組刻子
     → 碰碰胡 4 台,也可以是三組順子 → 沒有)。規矩是**算對玩家最有利的那一種**,
     所以這裡拿 MJ16.winningHands() 的全部拆法逐一算,取最大值。
   ========================================================================== */

const MJ16S = (function(){

  const R = (typeof MJ16 !== "undefined") ? MJ16 : require("./rules.js");

  const WINDS   = [27,28,29,30];          // 東 南 西 北
  const DRAGONS = [31,32,33];             // 中 發 白
  const SEASON  = [34,35,36,37];          // 春 夏 秋 冬
  const GENTLE  = [38,39,40,41];          // 梅 蘭 竹 菊
  /* 花牌對應的座位風:春/梅=東、夏/蘭=南、秋/竹=西、冬/菊=北 */
  const FLOWER_WIND = { 34:27, 35:28, 36:29, 37:30, 38:27, 39:28, 40:29, 41:30 };

  /* ==========================================================================
     台數表
     tai 可以是數字,也可以是 function(ctx) —— 正花 / 花槓 / 連莊要按數量算。
     excl 列出「這個台成立時要蓋掉的其他台」(較大的台包含較小的)。
     ========================================================================== */
  const TAI = [
    /* ---- 基本 ---- */
    { id:"zimo",    name:"自摸",   tai:1, test:c=> c.selfDraw },
    { id:"menqing", name:"門清",   tai:1, test:c=> c.allConcealed },
    /* ★ 有爭議:門清自摸各地算 2~3 台。本表採「門清 1 + 自摸 1 + 門清自摸再 1」= 共 3 台。 */
    { id:"mqZimo",  name:"門清自摸", tai:1, test:c=> c.allConcealed && c.selfDraw },
    { id:"danDiao", name:"單吊",   tai:1, test:c=> c.winIsPair },
    /* 全求人:五組全部攤在外面(只剩將是自己的)+ 食胡。必然單吊,故蓋掉單吊。 */
    { id:"quanQiuRen", name:"全求人", tai:2, excl:["danDiao"],
      test:c=> !c.selfDraw && c.sets.every(s=>!s.concealed) },

    /* ---- 風與箭 ---- */
    { id:"menFeng", name:"門風", tai:1, test:c=> c.hasPungOf(c.seatWind) },
    { id:"quanFeng",name:"圈風", tai:1, test:c=> c.hasPungOf(c.roundWind) },
    { id:"yuanZ",   name:"中",   tai:1, test:c=> c.hasPungOf(31) },
    { id:"yuanF",   name:"發",   tai:1, test:c=> c.hasPungOf(32) },
    { id:"yuanB",   name:"白",   tai:1, test:c=> c.hasPungOf(33) },

    /* 小三元的 ===2 寫成 >=2 其實等價(三組三元刻時,將**不可能**再是三元牌:
       三元只有 3 種、每種 4 張,3 刻用掉 9 張後湊不出第 4 種的一對)。
       仍寫 ===2 是為了讀起來就是「兩刻一對」的定義。 */
    { id:"xiaoSanYuan", name:"小三元", tai:4, excl:["yuanZ","yuanF","yuanB"],
      test:c=> c.dragonPungs===2 && DRAGONS.indexOf(c.pair)>=0 },
    { id:"daSanYuan",   name:"大三元", tai:8, excl:["xiaoSanYuan","yuanZ","yuanF","yuanB"],
      test:c=> c.dragonPungs===3 },
    { id:"xiaoSiXi",    name:"小四喜", tai:8, excl:["menFeng","quanFeng"],
      test:c=> c.windPungs===3 && WINDS.indexOf(c.pair)>=0 },
    { id:"daSiXi",      name:"大四喜", tai:16, excl:["xiaoSiXi","menFeng","quanFeng"],
      test:c=> c.windPungs===4 },

    /* ---- 牌型 ----
       ★ 有爭議:混老頭 / 清老頭 / 字一色 在定義上都必然是碰碰胡。
         本表**不互斥、一律加總**(混老頭 4 + 碰碰胡 4 = 8),三者一致處理,
         不要只讓其中一個排除碰碰胡 —— 那種不一致最容易在日後被誤改。 */
    { id:"pengPeng", name:"碰碰胡", tai:4,
      test:c=> c.sets.every(s=>s.kind!=="chow") },
    /* 平胡(屁胡):全順子 + 將不是字牌 + 沒有花 + 食胡 + 兩面聽。
       ★ 有爭議:有些桌要求「完全沒有其他台」。本表用上面五個條件,不看其他台。 */
    { id:"pingHu", name:"平胡", tai:2,
      test:c=> c.sets.every(s=>s.kind==="chow") && !R.isHonor(c.pair) &&
               !c.selfDraw && c.flowers.length===0 && c.waitShapes.has("open") },
    /* ⚠ 下面幾個「一色 / 老頭」系的 excl 刻意**只列真的會撞的**。
       變異測試抓出來的教訓:寫死排除看起來很安全,其實是**死程式碼** ——
       它永遠不會被觸發,卻讓人以為有防護,而且測資也永遠測不到它。
       天生互斥、**不需要** excl 的組合(靠 test 條件本身就分開了):
         清一色 vs 混一色 —— 混一色要求 hasHonor,清一色要求 !hasHonor
         字一色 vs 混一色 —— 混一色要求 numSuits===1,字一色是 0
         字一色 vs 混老頭 —— 混老頭要求 numSuits>0
         清老頭 vs 混老頭 —— 混老頭要求 hasHonor,清老頭要求 !hasHonor
       真的會撞、**必須** excl 的只有「全帶么」:字一色 / 混老頭 / 清老頭都必然全帶么。 */
    { id:"hunYiSe", name:"混一色", tai:4,
      test:c=> c.numSuits.size===1 && c.hasHonor },
    { id:"qingYiSe", name:"清一色", tai:8,
      test:c=> c.numSuits.size===1 && !c.hasHonor },
    { id:"ziYiSe", name:"字一色", tai:16, excl:["quanDaiYao"],
      test:c=> c.numSuits.size===0 },
    { id:"quanDaiYao", name:"全帶么", tai:4,
      test:c=> c.setsAndPair.every(s=> c.blockHasTerminal(s)) },
    { id:"hunLaoTou", name:"混老頭", tai:4, excl:["quanDaiYao"],
      test:c=> c.allTerminalOrHonor && c.hasHonor && c.numSuits.size>0 },
    { id:"qingLaoTou", name:"清老頭", tai:16, excl:["quanDaiYao"],
      test:c=> c.allTerminalOrHonor && !c.hasHonor },
    { id:"wuMenQi", name:"五門齊", tai:1,
      test:c=> c.numSuits.size===3 && c.hasWindTile && c.hasDragonTile },

    /* ---- 暗刻 ----
       ⚠ 食胡讓你成刻的那一組**不算暗刻**(是別人打給你的)。
         ctx.concealedPungs 已經扣掉了,見下面的註解。 */
    /* 三個都用 === 而不是 >=,所以**天生互斥、不需要 excl**(同上,不寫死程式碼) */
    { id:"sanAnKe", name:"三暗刻", tai:2, test:c=> c.concealedPungs===3 },
    { id:"siAnKe",  name:"四暗刻", tai:5, test:c=> c.concealedPungs===4 },
    { id:"wuAnKe",  name:"五暗刻", tai:8, test:c=> c.concealedPungs===5 },

    /* ---- 時機 ---- */
    { id:"gangShang", name:"槓上開花", tai:1, test:c=> c.kongDraw },
    { id:"qiangGang", name:"搶槓",     tai:1, test:c=> c.robKong },
    { id:"haiDi",     name:"海底撈月", tai:1, test:c=> c.lastTile && c.selfDraw },
    { id:"heDi",      name:"河底撈魚", tai:1, test:c=> c.lastTile && !c.selfDraw },
    /* 天/地/人胡:第一巡。★ 有爭議:有些桌天胡「獨計」不與其他台合併,本表照常加總。 */
    { id:"tianHu", name:"天胡", tai:24, test:c=> c.firstTurn && c.isDealer && c.selfDraw },
    { id:"diHu",   name:"地胡", tai:16, test:c=> c.firstTurn && !c.isDealer && c.selfDraw },
    { id:"renHu",  name:"人胡", tai:12, test:c=> c.firstTurn && !c.isDealer && !c.selfDraw },

    /* ---- 宣告聽牌(v1.67.0)----
       台數照**明星三缺一 16 張**的官方台數表:聽牌 1 / 地聽 4 / 天聽 8。
       ★ 這一台換來的代價是「宣告之後只能摸切、不能吃碰」(見 table.js 的 declareTing)——
         明星三缺一的說明就是「聽牌之後不能眼牌,所以額外給宣告聽牌者加一台」。
       ★ 天聽 / 地聽**不與聽牌重複計台**(excl),同大三元蓋掉中發白那一套。
       ⚠ 「獨聽」(只聽一張)在本表就是既有的**單吊**1 台,不另外開一格 —— 它與宣告無關,
         沒宣告也算得到。 */
    { id:"ting",     name:"聽牌", tai:1, test:c=> !!c.ting },
    { id:"diTing",   name:"地聽", tai:4, excl:["ting"], test:c=> c.ting==="di" },
    { id:"tianTing", name:"天聽", tai:8, excl:["ting","diTing"], test:c=> c.ting==="tian" },

    /* ---- 花牌 ---- */
    { id:"baXian", name:"八仙過海", tai:8, excl:["huaGang","zhengHua"],
      test:c=> c.flowers.length===8 },
    { id:"huaGang", name:"花槓", tai:c=> 2*c.flowerGangs, test:c=> c.flowerGangs>0 },
    /* 正花 = 對到自己座位風的花;已經湊成花槓的那一組不再重複算 */
    { id:"zhengHua", name:"正花", tai:c=> c.ownFlowers, test:c=> c.ownFlowers>0 },

    /* ---- 莊家 ---- */
    { id:"zhuang", name:"莊家", tai:1, test:c=> c.isDealer },
    /* 連 N 拉 N。預設關(每局換莊),開啟時由 adapter 傳 dealerStreak 進來。 */
    { id:"lianZhuang", name:"連莊", tai:c=> 2*c.dealerStreak, test:c=> c.dealerStreak>0 }
  ];

  /* ==========================================================================
     ctx:給每個 test() 用的執行環境。一種拆法建一個。
     ========================================================================== */
  function buildCtx(hand, pair, sets){
    const c = {};
    c.pair = pair;
    c.sets = sets;                                   // [{kind,t,concealed}] 共 5 組
    c.setsAndPair = sets.concat([{ kind:"pair", t:pair, concealed:true }]);

    c.selfDraw   = !!hand.selfDraw;
    c.winTile    = hand.winTile;
    c.seatWind   = hand.seatWind;
    c.roundWind  = hand.roundWind;
    c.isDealer   = !!hand.isDealer;
    c.dealerStreak = hand.dealerStreak || 0;
    c.flowers    = hand.flowers || [];
    c.kongDraw   = !!hand.kongDraw;
    c.lastTile   = !!hand.lastTile;
    c.robKong    = !!hand.robKong;
    c.firstTurn  = !!hand.firstTurn;
    /* 宣告聽牌(v1.67.0):null / "normal" / "di" / "tian"。由 MJT.settleWin 從 state 帶進來。
       ⚠ 一律正規化成這四個值之一 —— 舊房間 / 手改 DB 可能塞進別的字串,
         那時當成「一般的宣告」(有宣告總比漏算好),而不是讓 test() 拿到怪東西。 */
    c.ting = (hand.ting==="tian" || hand.ting==="di") ? hand.ting : (hand.ting ? "normal" : null);

    c.allConcealed = sets.every(s=>s.concealed);     // 暗槓仍算門清

    /* 這一副用到的所有牌(槓一律當 3 張算 —— 第 4 張不影響任何花色 / 么九判定) */
    const counts = new Int8Array(34);
    sets.forEach(s=>{
      if(s.kind==="chow"){ counts[s.t]++; counts[s.t+1]++; counts[s.t+2]++; }
      else counts[s.t]+=3;
    });
    counts[pair]+=2;
    c.counts = counts;

    c.numSuits = new Set();
    c.hasHonor = false; c.hasWindTile = false; c.hasDragonTile = false;
    c.allTerminalOrHonor = true;
    for(let i=0;i<34;i++){
      if(!counts[i]) continue;
      if(R.isHonor(i)){
        c.hasHonor = true;
        if(WINDS.indexOf(i)>=0) c.hasWindTile = true; else c.hasDragonTile = true;
      }else{
        c.numSuits.add(R.suitOf(i));
      }
      if(!R.isTerminal(i)) c.allTerminalOrHonor = false;
    }

    c.hasPungOf = t => sets.some(s=>s.kind!=="chow" && s.t===t);
    c.windPungs   = WINDS.filter(w=>c.hasPungOf(w)).length;
    c.dragonPungs = DRAGONS.filter(d=>c.hasPungOf(d)).length;

    /* 一個「積木」(面子或將)裡有沒有么九 / 字牌 —— 全帶么用 */
    c.blockHasTerminal = s=>{
      if(s.kind==="chow") return (s.t%9)===0 || (s.t%9)===6;   // 123 或 789
      return R.isTerminal(s.t);
    };

    /* ---- 胡的那張落在哪裡:決定單吊與聽牌形狀 ----
       同一張牌在一種拆法裡可能對得上好幾個積木,取「對玩家最有利」的解讀,
       所以這裡收集**所有可能**的形狀,而不是挑第一個。 */
    const wt = hand.winTile;
    c.winIsPair = (wt===pair);
    c.waitShapes = new Set();
    if(c.winIsPair) c.waitShapes.add("pair");
    let winInChow = false, winPungIdx = -1;
    sets.forEach((s,i)=>{
      if(s.kind==="chow"){
        if(wt===s.t){
          winInChow = true;
          // 手上原有 t+1,t+2 → 等 t 或 t+3;t+2 已經是 9 就只能等 t(邊張)
          c.waitShapes.add(((s.t+2)%9)===8 ? "edge" : "open");
        }else if(wt===s.t+1){
          winInChow = true; c.waitShapes.add("middle");
        }else if(wt===s.t+2){
          winInChow = true;
          c.waitShapes.add((s.t%9)===0 ? "edge" : "open");
        }
      }else if(s.t===wt){
        winPungIdx = i;
        c.waitShapes.add("pung");
      }
    });

    /* ---- 暗刻數 ----
       ⚠ 食胡(別人打的)讓你湊成的那組刻子**不算暗刻**。
         但如果那張牌也能解讀成落在某個順子裡,玩家就可以那樣主張 → 不扣。
         這條規則不寫的話,「碰碰胡食胡」會被多送一台三暗刻。 */
    let cp = sets.filter(s=>s.kind!=="chow" && s.concealed).length;
    if(!c.selfDraw && !winInChow && winPungIdx>=0 && sets[winPungIdx].concealed) cp--;
    c.concealedPungs = cp;

    /* ---- 花 ---- */
    const fset = new Set(c.flowers);
    c.flowerGangs = (SEASON.every(f=>fset.has(f)) ? 1 : 0) + (GENTLE.every(f=>fset.has(f)) ? 1 : 0);
    c.ownFlowers = c.flowers.filter(f=>{
      if(FLOWER_WIND[f] !== c.seatWind) return false;
      // 已經湊成花槓的那一組不重複算
      if(SEASON.indexOf(f)>=0 && SEASON.every(x=>fset.has(x))) return false;
      if(GENTLE.indexOf(f)>=0 && GENTLE.every(x=>fset.has(x))) return false;
      return true;
    }).length;

    return c;
  }

  /* 算一種拆法值幾台 */
  function scoreOne(hand, pair, sets){
    const c = buildCtx(hand, pair, sets);
    const hit = [];
    TAI.forEach(d=>{
      let on=false;
      try { on = !!d.test(c); } catch(e){ on = false; }
      if(!on) return;
      const n = (typeof d.tai==="function") ? d.tai(c) : d.tai;
      if(n>0) hit.push({ id:d.id, name:d.name, tai:n, excl:d.excl||[] });
    });
    // 大台蓋掉小台
    const killed = new Set();
    hit.forEach(h=>h.excl.forEach(x=>killed.add(x)));
    const list = hit.filter(h=>!killed.has(h.id)).map(h=>({ id:h.id, name:h.name, tai:h.tai }));
    const tai = list.reduce((s,h)=>s+h.tai, 0);
    return { tai, list, ctx:c, pair, sets };
  }

  /* ==========================================================================
     score():對外主入口
       hand.concealed  手上未攤的牌(**含剛胡的那張**),陣列或 counts 都可以
       hand.melds      已經攤出來的組 [{kind:"chow"|"pung"|"kong", t, concealed}]
                       (暗槓也放這裡,concealed:true)
       其餘旗標見 buildCtx。
     回傳 { ok, base, tai, total, list, sets, pair }
     ★ total = base + tai,這就是收付表用的 T。
     ========================================================================== */
  function score(hand){
    const melds = hand.melds || [];
    const need  = 5 - melds.length;
    const base  = (typeof hand.base==="number") ? hand.base : 1;
    const c = (hand.concealed instanceof Int8Array) ? hand.concealed : R.toCounts(hand.concealed);

    const combos = R.winningHands(Int8Array.from(c), need);
    if(!combos.length) return { ok:false, base:base, tai:0, total:0, list:[], sets:[], pair:-1 };

    let best = null;
    combos.forEach(cm=>{
      // 手上拆出來的組預設是暗的;攤出去的照 melds 給的
      const sets = cm.sets.map(s=>({ kind:s.kind, t:s.t, concealed:true }))
                   .concat(melds.map(m=>({ kind:m.kind, t:m.t, concealed:!!m.concealed })));
      const r = scoreOne(hand, cm.pair, sets);
      if(!best || r.tai > best.tai) best = r;
    });
    return { ok:true, base:base, tai:best.tai, total:base+best.tai,
             list:best.list, sets:best.sets, pair:best.pair };
  }

  /* ==========================================================================
     settle():相互算台的收付表
     ★ 回傳長度 = seats 的陣列,**總和恆為 0**。這是本專案第一個可自動斷言的
       計分正確性檢查 —— e2e 每局後斷言 Σ === 0 就抓得到漏算。

       o.winnerSeat  胡牌者
       o.loserSeat   放槍者;**null = 自摸**
       o.packSeat    包牌(責任制)的人;有值時由他一個人付全部
       o.total       底 + 台(= score() 的 total)
       o.seats       這一局幾家
     ========================================================================== */
  function settle(o){
    const n = o.seats;
    const d = new Array(n).fill(0);
    if(o.draw) return d;                                   // 流局:不收付
    const T = o.total || 0;
    const w = o.winnerSeat;
    if(w==null || w<0 || w>=n) return d;

    if(o.packSeat!=null && o.packSeat>=0 && o.packSeat<n){
      // 包牌:包的人付「自摸的份額」= T × (家數-1)
      const all = T*(n-1);
      d[o.packSeat] -= all; d[w] += all;
    }else if(o.loserSeat==null){
      // 自摸:其他每一家各付 T
      for(let s=0;s<n;s++) if(s!==w){ d[s]-=T; d[w]+=T; }
    }else{
      // 放槍:放槍者一個人付 T
      d[o.loserSeat] -= T; d[w] += T;
    }
    return d;
  }

  return { TAI, score, settle, buildCtx,
           WINDS, DRAGONS, SEASON, GENTLE, FLOWER_WIND };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MJ16S;

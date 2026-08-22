"use strict";

/* ============================================================================
   台灣 16 張麻將 — 電腦對手(MJ16AI)。
   ★ 純函式,零 DOM、零 Firebase、零 MJT。相依只有同目錄的 rules.js(MJ16)。
     規矩同 js/gomoku/ai.js:牌力只有靠 node 大量對打才驗得出來,碰了一行 DOM
     就只能在瀏覽器裡一局一局手動打(而麻將一局要打好幾分鐘,比五子棋更貴)。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     shanten()    向聽數:離胡牌還差幾次換牌(-1 = 已經胡、0 = 聽牌)
     ukeire()     進張:摸到哪些牌會前進、那些牌還有幾張沒現身
     viewOf()     ★ 把一局的 state 濾成「這一家看得見的東西」
     pickDiscard / pickClaim / pickTurn   三個決策入口
     LEVELS       三個難度(新手 / 普通 / 高手)

   ── ★★ AI 不作弊,而且是**結構上**做不到 ──────────────────────────────────
     手牌在這個專案裡是明碼(連線那邊刻意不防作弊),單機更是整包 state 都在同一支
     程式裡 —— 「AI 不偷看」若只靠自律,改兩行就破功,而且畫面上完全看不出來
     (只會覺得「電腦怎麼每次都閃過我聽的那張」)。
     所以決策函式**只吃 viewOf() 濾出來的 view**:對手在 view 裡只有明牌、牌河、
     手上剩幾張,沒有牌值。
     ⚠ 這條有測試守著(tools/test-mj16-ai.js):把對手手牌整個換掉再問一次,
       AI 的選擇必須一模一樣。誰把 st 直接餵進決策函式,那條就會紅。

   ── ★ 這副牌沒有「振聽 / 現物」,所以防守模型不能照抄日麻 ─────────────────
     rules.js 的 claimsFor() 對任何人、任何一張都判胡,引擎裡**沒有振聽**
     (見 table.js 的 eligibleFor)。因此「他自己打過的牌 = 安全牌」在這裡是錯的,
     照日麻寫一套現物 / 筋牌會讓 AI 自信地放槍。
     這裡的安全只有統計意義:**已經現身越多張的牌越安全**(4 張全在明處就不可能被
     碰牌 / 對子聽,只剩順子聽)、么九比中張安全、對手明牌看得出在做某一色就避開。
   ========================================================================== */

const MJ16AI = (function(){

  const R = (typeof MJ16 !== "undefined") ? MJ16 : require("./rules.js");
  const WINDS = [27,28,29,30];
  const DRAGONS = [31,32,33];
  const WALL_FOLD = 40;    // 牌山剩幾張以下就「贏不了就別放槍」(見 pickDiscard)

  /* ==========================================================================
     一、向聽數
     ──────────────────────────────────────────────────────────────────────────
     公式(N = 還要湊幾組面子):

         向聽 = 2N − 2M − D  (+1 若 M+D = N+1 且沒有對子)

       M = 已經成形的面子數、D = 搭子數(對子也算一個搭子)。
       積木總數上限 M+D ≤ N+1(N 組面子 + 1 組將),超過的搭子是廢的。
       胡牌 = −1(M=N、D=1 的那個對子就是將),聽牌 = 0。

     ★ 為什麼不用「一路遞迴拆整副 34 種牌」這種寫法:
       決策一次要算幾百次向聽(每張候選打牌 × 每種進張),34 種一起遞迴的版本
       一次要幾毫秒,乘上去就是好幾秒 —— 電腦「想」半分鐘不是難度,是壞掉。
       改成**一門一門拆、拆完的結果 memo 起來再組合**:
         ① 每一門只有 9 種牌,遞迴極淺
         ② 換一張牌只有**一門**變 → 另外三門直接命中快取
         ③ 組合階段是 6×2 的小 DP,固定成本
       實測(test-mj16-ai.js)一次決策要算 400+ 次向聽,平均 0.4ms。

     ★ 每一門拆出來的東西壓成一張小表 T[m*2+p] = 該情形下最多的搭子數 d。
       只留「每個 (m, 有沒有對子) 的最大 d」是安全的:上限在組合階段才夾,
       而 d 越多永遠不會比較差,p=1(有對子)也永遠不會比較差(它只擋掉那個 +1)。
     ========================================================================== */

  const memoNum = new Map(), memoHon = new Map();   // 一門的拆牌結果(數字門 / 字牌)
  const MEMO_CAP = 120000;

  function packOf(c, base, len){
    let k = 0;
    for(let i=0;i<len;i++){ const n = c[base+i]; k = k*5 + (n>4?4:(n<0?0:n)); }
    return k;
  }

  /* 拆一門:回傳 Int8Array(12),索引 m*2+p,值是最大搭子數(−1 = 湊不出這個 m/p)。
     遞迴的骨架與 rules.js 的 decompose() 同一套「永遠先處理還有牌的最小索引」,
     差別是這裡除了面子還要試搭子,而且**允許把牌丟著不用**(孤張)。 */
  function buildTable(c, base, len, runs){
    const T = new Int8Array(12).fill(-1);
    const a = new Int8Array(len);
    for(let i=0;i<len;i++) a[i] = c[base+i];

    (function rec(i, m, d, p){
      const k = m*2 + p;
      if(T[k] < d) T[k] = d;                    // 每一個節點都記:剩下的牌當孤張就是了
      while(i<len && !a[i]) i++;
      if(i>=len) return;

      if(a[i]>=3 && m<5){                       // 刻子
        a[i]-=3; rec(i, m+1, d, p); a[i]+=3;
      }
      if(runs && i<=len-3 && a[i+1] && a[i+2] && m<5){   // 順子
        a[i]--; a[i+1]--; a[i+2]--; rec(i, m+1, d, p); a[i]++; a[i+1]++; a[i+2]++;
      }
      if(a[i]>=2 && d<6){                       // 對子(可以當將,所以把 p 點亮)
        a[i]-=2; rec(i, m, d+1, 1); a[i]+=2;
      }
      if(runs && i<=len-2 && a[i+1] && d<6){    // 兩面 / 邊張
        a[i]--; a[i+1]--; rec(i, m, d+1, p); a[i]++; a[i+1]++;
      }
      if(runs && i<=len-3 && a[i+2] && d<6){    // 嵌張
        a[i]--; a[i+2]--; rec(i, m, d+1, p); a[i]++; a[i+2]++;
      }
      a[i]--; rec(i, m, d, p); a[i]++;          // 孤張:丟著不用(少了這條會漏解)
    })(0, 0, 0, 0);

    return T;
  }

  function tableFor(c, base, len, runs){
    const memo = runs ? memoNum : memoHon;
    const key = packOf(c, base, len);
    let T = memo.get(key);
    if(T) return T;
    T = buildTable(c, base, len, runs);
    if(memo.size > MEMO_CAP) memo.clear();
    memo.set(key, T);
    return T;
  }

  /* 四張小表組起來 → 向聽數。DP 狀態只有 (M 0..5) × (有沒有對子),小到可以無腦跑。 */
  const TMP_A = new Int8Array(12), TMP_B = new Int8Array(12);
  function combine(t0, t1, t2, t3, need){
    let dp = TMP_A, nd = TMP_B;
    dp.fill(-1); dp[0] = 0;
    const tabs = [t0, t1, t2, t3];
    for(let s=0;s<4;s++){
      const T = tabs[s];
      nd.fill(-1);
      for(let m1=0;m1<=5;m1++) for(let p1=0;p1<2;p1++){
        const d1 = dp[m1*2+p1]; if(d1<0) continue;
        for(let m2=0;m2+m1<=5;m2++) for(let p2=0;p2<2;p2++){
          const d2 = T[m2*2+p2]; if(d2<0) continue;
          const m = m1+m2, p = p1|p2;
          let d = d1+d2; if(d>6) d = 6;
          if(nd[m*2+p] < d) nd[m*2+p] = d;
        }
      }
      const t = dp; dp = nd; nd = t;
    }
    let best = 99;
    for(let m=0;m<=5;m++) for(let p=0;p<2;p++){
      const dmax = dp[m*2+p]; if(dmax<0) continue;
      const M = Math.min(m, need);
      const D = Math.min(dmax, need+1-M);
      let s = 2*need - 2*M - D;
      if(M+D === need+1 && !p) s += 1;          // 積木湊滿了卻沒有將 → 還要多換一次
      if(s < best) best = s;
    }
    return best;
  }

  /* counts(長度 34)+ 還要湊幾組 → 向聽數。−1 = 已經胡了。 */
  function shanten(c, need){
    if(need < 0) return 99;
    return combine(tableFor(c,0,9,true), tableFor(c,9,9,true),
                   tableFor(c,18,9,true), tableFor(c,27,7,false), need);
  }

  /* ==========================================================================
     二、進張(ukeire)
     摸到哪幾種會讓向聽數變小,以及那些牌**還有幾張沒現身**。
     ⚠ 一定要用「沒現身的張數」而不是種類數:聽一張已經被打光的牌等於沒聽,
       這正是「高手」與「普通」拉開差距的地方之一。
     seen 省略時退化成只看自己手上那幾張(等於假設別人都沒打過)。
     ========================================================================== */
  function ukeire(c, need, seen){
    const s0 = shanten(c, need);
    const tiles = [];
    let total = 0;
    for(let k=0;k<34;k++){
      if(c[k] >= 4) continue;
      const left = 4 - (seen ? seen[k] : c[k]);
      if(left <= 0) continue;
      c[k]++;
      const s1 = shanten(c, need);
      c[k]--;
      if(s1 < s0){ tiles.push(k); total += left; }
    }
    return { s:s0, tiles:tiles, total:total };
  }
  function isTenpai(c, need){ return shanten(c, need) <= 0; }

  /* ==========================================================================
     三、view:AI 看得見的東西(見檔頭那條紅線)
     ========================================================================== */
  function seatWindOf(seat, dealer, seats){
    return WINDS[((seat - dealer) % seats + seats) % seats];
  }
  function meldTiles(m, fn){
    if(m.k === "chow"){ fn(m.t); fn(m.t+1); fn(m.t+2); }
    else fn(m.t, m.k === "kong" ? 4 : 3);
  }

  function viewOf(st, seat){
    const rs = R.RULESETS[st.rs] || R.RULESETS.p4;
    const need = rs.melds - st.melds[seat].length;
    const hand = (st.turn === seat && st.drawn >= 0)
      ? st.hands[seat].concat([st.drawn]) : st.hands[seat].slice();

    /* 場上看得見的每一種牌各幾張:我的手牌 + 全部人的明牌 + 整條牌河。
       ⚠ 花牌不進來(索引 ≥34,本來就不參與面子)。 */
    const seen = R.newCounts();
    hand.forEach(t=>{ if(t < 34) seen[t]++; });
    st.discards.forEach(d=>{ if(d.t < 34) seen[d.t]++; });
    for(let s=0;s<st.seats;s++){
      st.melds[s].forEach(m=>{
        /* ★★ 別人的**暗槓**不算進 seen(v2.7.0+1)—— 那四張牌的牌值從頭到尾沒有
           公開過(牌從手上進明牌區),算進去就是偷看:AI 會精準地避開「已經被槓走
           的那一張」,而真人只知道「有四張牌被鎖起來」、不知道是哪一張。
           ⚠ 自己的暗槓照算(自己槓的自己看得見)。
           ⚠ 代價是 AI 有可能單吊一張其實已經死了的牌 —— 那正是真人的處境,
             這一支的整個立場是「view 裡只准有看得見的東西」(見檔頭)。 */
        if(s !== seat && m.k === "kong" && m.c) return;
        meldTiles(m, (t,n)=>{ seen[t] += (n||1); });
      });
    }

    const foes = [];
    for(let s=0;s<st.seats;s++){
      if(s === seat) continue;
      foes.push({
        seat: s,
        /* ★★ 暗槓在 view 裡是 `t:-1`(牌值是牌情,同上面的 seen)。
           ⚠ 為什麼不整組省掉:**組數是公開的**(桌上看得到四張蓋著的牌),
             tableThreat 要用它算進度,省掉就等於低估對方。
           ⚠ 下游兩支(tableThreat / flushSuits)要自己擋 `t < 0`。 */
        melds: st.melds[s].map(m=>(m.k === "kong" && m.c)
                 ? { k:m.k, t:-1, c:true, hid:true }
                 : { k:m.k, t:m.t, c:!!m.c }),
        left: st.hands[s].length,                       // 手上幾張(張數,不是牌)
        wind: seatWindOf(s, st.dealer, st.seats),
        pool: st.discards.filter(d=>d.seat === s).map(d=>d.t),
        /* 他宣告聽牌了沒(v1.67.0)。★ 這是**公開資訊** —— 宣告是喊出來的,
           所以放進 view 完全不違反「AI 不作弊」那條(對手的**牌值**永遠不在 view 裡)。 */
        ting: (st.ting && st.ting[s]) || null
      });
    }

    const c = R.toCounts(hand);
    return {
      seat: seat, seats: st.seats, chow: !!rs.chow,
      hand: hand, counts: c, need: need,
      melds: st.melds[seat].map(m=>({ k:m.k, t:m.t, c:!!m.c })),
      flowers: (st.flowers[seat] || []).slice(),
      drawn: (st.turn === seat) ? st.drawn : -1,
      seatWind: seatWindOf(seat, st.dealer, st.seats),
      roundWind: st.roundWind,
      isDealer: seat === st.dealer,
      seen: seen, foes: foes,
      wallLeft: st.wall.length - st.pos,
      wallTotal: st.wall.length,
      firstGo: !!st.firstGo,
      ting: (st.ting && st.ting[seat]) || null,   // 我自己宣告了沒(宣告後只能摸切)
      discarded: st.discards.length,              // 牌河張數 —— 天聽 / 地聽的門檻要用
      isFirstDiscard: st.discards.length === 0
    };
  }

  /* ==========================================================================
     四、牌型價值(做台的傾向)
     ──────────────────────────────────────────────────────────────────────────
     不是把 scoring.js 那張表整個算一遍 —— 那要先胡才算得出來。這裡只給
     「這副牌現在**往哪個方向走**比較值錢」的粗估,當作同向聽、同進張時的取捨。
     ⚠ 權重刻意壓在進張之下(見 pickDiscard 的組合):做台做到不會胡是最常見的
       AI 智障行為,寧可小台先胡。
     ========================================================================== */
  function handValue(c, v){
    let val = 0;

    /* 三元牌 / 門風 / 圈風:湊成刻子各 1 台。成對就有留的價值,單張幾乎沒有。
       ⚠ 門風與圈風可能是同一張(東風局的莊家)—— 那時就是真的 2 台,重複加是對的。 */
    const taiT = [31,32,33, v.seatWind, v.roundWind];
    taiT.forEach(k=>{
      if(k < 0 || k > 33) return;
      if(c[k] >= 3) val += 2.4;
      else if(c[k] === 2) val += 1.5;
      else if(c[k] === 1) val += 0.25;
    });
    v.melds.forEach(m=>{ if(m.k !== "chow" && taiT.indexOf(m.t) >= 0) val += 2.4; });

    /* 混一色 / 清一色:算「主色 + 字牌」佔全部牌的比例,只差幾張就給分。
       這是唯一會讓 AI 主動拆掉別門好牌的項目,所以門檻設在「差 3 張以內」。 */
    const bySuit = { w:0, b:0, d:0 };
    let hon = 0, tot = 0;
    const add = (t, n)=>{
      n = n || 1;
      if(R.isHonor(t)) hon += n; else bySuit[R.suitOf(t)] += n;
      tot += n;
    };
    for(let k=0;k<34;k++) if(c[k]) add(k, c[k]);
    v.melds.forEach(m=>meldTiles(m, add));
    let top = 0;
    ["w","b","d"].forEach(s=>{ if(bySuit[s] > top) top = bySuit[s]; });
    const pure = top + hon;
    if(tot > 0 && pure >= tot-3) val += (pure - tot + 4) * 1.3;

    /* 碰碰胡:對子 / 刻子夠多才給(4 組以上才有搞頭,不然只是把順子拆掉) */
    let blocks = 0;
    for(let k=0;k<34;k++){ if(c[k] >= 2) blocks++; }
    v.melds.forEach(m=>{ if(m.k !== "chow") blocks++; });
    if(blocks >= 4) val += (blocks - 3) * 1.1;

    return val;
  }

  /* ==========================================================================
     五、防守
     ──────────────────────────────────────────────────────────────────────────
     ★ 見檔頭:這副牌沒有振聽,所以沒有「現物」這種絕對安全牌。
       能用的訊號只有三個,全部是統計性的:
         ① 這種牌已經現身幾張(4 張全現 → 不可能被碰 / 對子聽,只剩順子聽)
         ② 么九 / 字牌比中張安全(能組成的順子少)
         ③ 對手的明牌與牌河看得出在做某一色 → 那一色危險
     ========================================================================== */
  /* 全桌威脅:有人攤了幾組明牌、牌局進行到哪。回傳 0~1。
     ⚠ 門檻刻意設得**晚**(見 pickDiscard 的押退段):早早開始閃牌在 16 張裡是純虧的,
       第一版寫成「一開局就算風險」,實測放槍次數反而比不防守的普通還多 ——
       因為手一慢,同一局要多打十幾張,送出去的機會變多。 */
  function tableThreat(v){
    let th = 0;
    v.foes.forEach(f=>{
      let t = 0.26 * f.melds.length;
      // 明牌裡有三元 / 風刻 = 對方在做台,威脅再加
      f.melds.forEach(m=>{
        if(m.t < 0) return;                             // 暗槓:看不到牌值(view 裡是 -1)
        if(m.k !== "chow" && (DRAGONS.indexOf(m.t) >= 0 || m.t === f.wind || m.t === v.roundWind)) t += 0.14;
      });
      /* ★ 有人**宣告聽牌**(v1.67.0)→ 那是牌桌上最明確的威脅訊號:他自己說了他只差一張。
         這是唯一一個「對方主動公告」的資訊,不必靠明牌去推,所以直接給一個高底值。
         ⚠ 只是提高 threat 而不是「一律閃牌」—— 押退還是走 pickDiscard 那套
           (自己一向聽以內照樣押到底),否則有人一宣告,高手就整局不敢打牌了。 */
      if(f.ting) t = Math.max(t, 0.72);
      if(t > th) th = t;
    });
    const prog = v.wallTotal ? (1 - v.wallLeft / v.wallTotal) : 0;
    if(prog > 0.62) th = Math.max(th, (prog - 0.62) * 2.2);     // 牌快摸完了,大家都近聽
    return Math.min(1, th);
  }
  /* 某一家是不是在做一色:明牌 + 牌河都指向同一門(牌河**沒有**那一門 = 沒在丟) */
  function flushSuits(v){
    const hot = {};
    v.foes.forEach(f=>{
      /* ⚠ 暗槓(t < 0)看不到是哪一門 → 不算;而**門檻也要用看得見的組數**:
         用 f.melds.length 的話「一組暗槓 + 一組筒子」會被當成兩組都指向筒子。 */
      const vis = f.melds.filter(m=>m.t >= 0);
      if(vis.length < 2) return;
      const s = {};
      let ok = true;
      vis.forEach(m=>{
        if(R.isHonor(m.t)) return;                    // 字牌不破壞一色
        const su = R.suitOf(m.t);
        s[su] = (s[su]||0) + 1;
      });
      const keys = Object.keys(s);
      if(keys.length !== 1) ok = false;
      if(!ok) return;
      const su = keys[0];
      // 牌河裡那一門丟得越少,越像在收
      const inPool = f.pool.filter(t=>!R.isHonor(t) && R.suitOf(t) === su).length;
      if(inPool <= 1) hot[su] = Math.max(hot[su]||0, 1);
    });
    return hot;
  }
  /* 打這一張的風險(0 ≈ 安全)。threat / hot 由呼叫端算好一次,不要每張重算。 */
  function dangerOf(t, v, threat, hot){
    if(threat <= 0) return 0;
    const left = 4 - v.seen[t];                       // 這種牌還有幾張沒現身
    let d;
    if(R.isHonor(t)){
      // 字牌:剩越少越安全(剩 0 張 → 只可能被單吊)
      d = 0.10 + 0.20 * Math.max(0, left);
    }else{
      const r = R.rankOf(t);
      const edge = Math.min(r, 10-r);                 // 1 = 么九,5 = 五
      d = 0.18 + 0.17 * edge;
      d *= (0.55 + 0.15 * Math.max(0, left));
      if(hot[R.suitOf(t)]) d *= 1.9;                  // 有人在做這一色
    }
    return d * threat;
  }

  /* ==========================================================================
     六、三個難度
     ──────────────────────────────────────────────────────────────────────────
     ★ 差別刻意做成「看得見的行為差異」,不是同一套加一點亂數:
       新手 —— 不算進張、不看剩張、完全不防守,別人打什麼吃得下就跟著吃
                (實際上手的新手就是這樣:一直吃碰,手牌越打越小卻沒台)
       普通 —— 算進張、留有台的牌,吃碰要真的有進展才吃,會稍微避開危險牌
       高手 —— 進張算「場上還剩幾張」(普通只看得到自己手上那幾張)、會做混一色 /
                碰碰胡、自己牌爛又有人攤牌時轉守(押退判斷)
     ⚠ 高手**不會**為了保門清而放掉吃碰 —— 那條寫過,實測是虧的,見 pickClaim。
     ⚠ 三個難度**都不會**做「拆掉已成面子」這種事 —— 向聽數那一項權重壓倒性,
       新手也只是在同向聽的選項裡挑得不夠好。使用者要的是「不要太白痴」。
     ========================================================================== */
  const LEVELS = {
    easy: {
      key:"easy", name:"新手", emoji:"🙂",
      uke:false, seen:false, wUke:0, wShape:0.5, wVal:0, wDef:0, noise:4, ting:false,
      claim:"greedy", think:[420,780], claimThink:[500,900],
      desc:"看得懂牌、不會亂拆組合,但不算進張也完全不防守 —— 有得吃碰就跟著吃碰"
    },
    normal: {
      key:"normal", name:"普通", emoji:"🤔",
      uke:true, seen:false, wUke:0, wShape:2.4, wVal:0.4, wDef:0, noise:2.2, ting:true,
      claim:"gain", think:[520,950], claimThink:[600,1100],
      desc:"會算進張、留有台的牌,吃碰要真的有進展才吃,但不數場上剩幾張、也不防守"
    },
    hard: {
      key:"hard", name:"高手", emoji:"😈",
      uke:true, seen:true, wUke:1, wShape:0.9, wVal:0.5, wDef:3, noise:0, ting:true,
      claim:"value", think:[640,1200], claimThink:[700,1300],
      desc:"進張連場上剩幾張都算,自己牌爛又有人攤牌時會收手 —— 認真打才贏得了"
    }
  };
  function levelOf(k){ return LEVELS[k] || LEVELS.normal; }
  const LEVEL_KEYS = ["easy","normal","hard"];

  function thinkMs(lv, key){
    const r = lv[key || "think"] || [500,900];
    return r[0] + Math.random() * (r[1] - r[0]);
  }

  /* ==========================================================================
     七、決策:打哪一張
     ──────────────────────────────────────────────────────────────────────────
     分數 = −向聽×1000 + 進張×wUke + 進張種類×wShape + 牌型價值×wVal
            − 風險×wDef×押退係數 + 亂數×noise
     ★ 向聽的權重壓倒性(×1000)是刻意的:任何難度都不會為了做台或保平安
       去拆掉已經成形的面子。使用者要的是「電腦不要太白痴」。
     ========================================================================== */
  function pickDiscard(v, lvKey, rng){
    const lv = levelOf(lvKey);
    const rnd = rng || Math.random;
    const c = v.counts;
    const base = shanten(c, v.need);

    /* ★★ 押退:**只有自己明顯落後、而且場面真的兇**的時候才閃牌(v1.60.0 調過一輪)。
       第一版寫成「離聽越遠越要防」,結果高手的台數收支輸給普通 116:−116,
       放槍次數還比較多 —— 在 16 張裡少一次胡的代價遠大於少一次放槍,而且手一慢
       同一局要多打十幾張,反而更容易送。所以:
         · 自己一向聽以內 → 完全不閃(押到底)
         · 威脅低於門檻 → 完全不閃(沒人攤牌、牌山還深的時候閃了也是白閃) */
    const threat = lv.wDef ? tableThreat(v) : 0;
    let pushScale = (base >= 4) ? 1 : (base === 3) ? 0.75 : (base === 2) ? 0.4 : 0;
    /* ★ 牌山快見底、自己又還沒近聽 → 這一局本來就贏不了,**全力不放槍**。
       這裡吃到本專案規則的一個紅利:流局在 table.js 是 over={type:"draw"} 且完全不收付
       (沒有「聽牌者收沒聽的」那套),所以打到流局的代價是 0、放槍的代價是滿滿一份。
       ⚠ 換句話說這條的正確性綁在「流局不收付」上,哪天補了流局罰則要回來改。
       ⚠ 它**很少真的觸發** —— 一局平均打 30 張就結束了,牌山掉到 40 張以下的多半
         是最後會流局的那幾局。實測 0 / 28 / 40 / 52 / 64 五個門檻的差別都在雜訊裡,
         留著是因為它便宜又講得出道理,不是因為量得到。 */
    if(v.wallLeft <= WALL_FOLD && base >= 2) pushScale = 1;
    const defOn = lv.wDef && pushScale > 0 && threat >= 0.4;
    const hot = defOn ? flushSuits(v) : {};

    /* 同一種牌只評一次(手上兩張紅中,打哪一張都一樣) */
    const uniq = [];
    for(let k=0;k<34;k++) if(c[k]) uniq.push(k);

    /* ★ 「還剩幾張沒出現」是**高手才會的事**(lv.seen):普通只知道自己手上有幾張,
       所以會傻傻地聽一張早就被打光的牌。這是三個難度裡最像真人的一項差距 ——
       算進張人人會,數場上剩幾張才是熟練度。 */
    const seenFor = lv.seen ? v.seen : null;

    const cand = [];
    uniq.forEach(t=>{
      c[t]--;
      const s = shanten(c, v.need);
      let uk = 0, kinds = 0;
      if(lv.uke){
        const u = ukeire(c, v.need, seenFor);
        uk = u.total; kinds = u.tiles.length;
      }
      const val = lv.wVal ? handValue(c, v) * (s >= 2 ? 1 : 0.45) : 0;
      c[t]++;
      const risk = defOn ? dangerOf(t, v, threat, hot) : 0;
      cand.push({ t:t, s:s, uk:uk, kinds:kinds, val:val, risk:risk });
    });

    /* ★ 這裡**沒有**「多看一步」(摸到進張之後下一步還有多寬)。寫過、也量過:
       500 局對打的胡牌數 232 : 236、台數在雜訊裡,卻讓每次決策慢三倍。
       同一類教訓見 notes/09 五子棋的「depth 6 實測反而更差」——
       ⚠ 這段註解要留著,它看起來很像「該補上去」的優化。
       ⚠ 量之前先確認雜訊底線:同一份對打把兩邊都設成高手,胡牌數照樣會開到
         239 : 256(≈2σ)。500 局分不出 5% 以內的差距,別拿它調參數。 */
    let best = null;
    cand.forEach(o=>{
      let sc = -o.s * 1000 + o.uk * lv.wUke + o.kinds * lv.wShape
               + o.val * lv.wVal - o.risk * lv.wDef * pushScale * 12;
      if(lv.noise) sc += (rnd() - 0.5) * lv.noise;
      if(!best || sc > best.sc) best = { t:o.t, sc:sc };
    });
    return best ? best.t : v.hand[0];
  }

  /* ==========================================================================
     八、決策:別人打了一張,要不要吃 / 碰 / 槓 / 胡
     ──────────────────────────────────────────────────────────────────────────
     回傳 { type:"win"|"pong"|"kong"|"chow", tiles }(chow 才有 tiles)或 null(過)。
     ⚠ 這裡算的是「宣告之後**還要湊幾組**少一組」的向聽,不是把牌硬加進手裡:
       碰完手上少 2 張、要湊的組數少 1 組,張數才對得起來(3need+2)。
     ========================================================================== */
  function claimOptions(v, tile, types){
    const out = [];
    const c = v.counts;
    if(types.indexOf("kong") >= 0 && c[tile] >= 3) out.push({ type:"kong", take:[tile,tile,tile] });
    if(types.indexOf("pong") >= 0 && c[tile] >= 2) out.push({ type:"pong", take:[tile,tile] });
    if(types.indexOf("chow") >= 0 && v.chow && R.isNumber(tile)){
      const r = tile % 9;
      if(r>=2 && c[tile-2] && c[tile-1]) out.push({ type:"chow", take:[tile-2,tile-1] });
      if(r>=1 && r<=7 && c[tile-1] && c[tile+1]) out.push({ type:"chow", take:[tile-1,tile+1] });
      if(r<=6 && c[tile+1] && c[tile+2]) out.push({ type:"chow", take:[tile+1,tile+2] });
    }
    return out;
  }

  function pickClaim(v, tile, types, lvKey, rng){
    if(!types || !types.length) return null;
    const lv = levelOf(lvKey);
    const rnd = rng || Math.random;

    /* 胡永遠胡。★ 刻意不做「小台先不胡等大台」—— 那在 2~4 人的短局裡幾乎永遠是虧的,
       而且使用者看到電腦放掉一次胡牌只會覺得程式有 bug。 */
    if(types.indexOf("win") >= 0) return { type:"win" };

    const opts = claimOptions(v, tile, types);
    if(!opts.length) return null;

    const c = v.counts;
    const s0 = shanten(c, v.need);
    const taiT = [31,32,33, v.seatWind, v.roundWind];
    const isTai = taiT.indexOf(tile) >= 0;

    let best = null;
    opts.forEach(o=>{
      o.take.forEach(t=>{ c[t]--; });
      const s1 = shanten(c, v.need - 1);
      const uk = lv.uke ? ukeire(c, v.need - 1, lv.seen ? v.seen : null).total : 0;
      const val = lv.wVal ? handValue(c, v) : 0;
      o.take.forEach(t=>{ c[t]++; });
      const gain = s0 - s1;                          // 向聽前進幾步
      let sc = gain * 100 + uk * 0.25 + val * lv.wVal;
      if(o.type !== "chow" && isTai) sc += 45;       // 碰到三元 / 門風 / 圈風 = 直接 1 台
      if(o.type === "kong") sc += 12;                // 槓多補一張,小賺
      o.s1 = s1; o.uk = uk; o.gain = gain;
      o.sc = sc + (lv.noise ? (rnd()-0.5)*lv.noise : 0);
      if(!best || o.sc > best.sc) best = o;
    });
    if(!best) return null;

    /* 要不要真的吃下去 —— 三個難度的分水嶺之一 */
    if(lv.claim === "greedy"){
      // 新手:只要不倒退就吃(所以常常吃到手牌全開、一台都沒有)
      if(best.gain < 0) return null;
      if(best.gain === 0 && rnd() > 0.7) return null;
    }else{
      // 普通 / 高手:要真的前進;有台的碰在不倒退時也吃
      if(best.gain <= 0 && !(best.type !== "chow" && isTai && best.gain === 0)) return null;
      /* ★★ 高手刻意**不**為了保門清放掉吃碰(v1.60.0 實測後改掉)。
         第一版讓高手「還門清 + 還沒近聽 + 吃的不是台牌 → 不吃」,結果高手對普通的
         台數收支是 −116:116、胡牌數 95:135 —— 台灣 16 張要湊**五組**面子,
         門清只值 1 台,慢一步就整局沒了。同一份對局把這條拿掉立刻翻成 +29。
         ⚠ 這條註解要留著:它看起來很像「該加回去」的優化。 */
      if(lv.claim === "value" && lv.uke && best.uk === 0 && best.s1 > 0){
        // 吃完之後一張進張都沒有(死牌)→ 那只是把牌攤開給人讀,不吃
        return null;
      }
    }
    return best.type === "chow" ? { type:"chow", tiles:best.take } : { type:best.type };
  }

  /* ==========================================================================
     九、決策:自己的回合(自摸 / 暗槓 / 加槓 / 打牌)
     回傳 { act:"win" } | { act:"ckong"|"akong", t } | { act:"discard", t }
     ⚠ 呼叫端(solo.js)一定要再用 MJT 驗一次合法性 —— 這裡只做「想做什麼」。
     ========================================================================== */
  function pickTurn(v, lvKey, rng){
    const lv = levelOf(lvKey);
    const c = v.counts;

    if(v.drawn >= 0 && R.canWin(c, v.need)) return { act:"win" };

    const s0 = shanten(c, v.need);

    /* 暗槓:手上四張同款。槓完少一組要湊、補一張,對向聽通常沒差,而且有暗刻台。
       ⚠ 條件是「不會變差」而不是「會變好」—— 槓本來就不前進,它賺的是台與補牌。
       ⚠ 已經聽牌時要特別小心:槓掉的四張若正在當順子用,聽的牌會整個變掉。
         所以聽牌時要求槓完**仍然聽牌**。 */
    const ck = R.concealedKongs(c);
    for(let i=0;i<ck.length;i++){
      const t = ck[i];
      c[t] -= 4;
      const s1 = shanten(c, v.need - 1);
      c[t] += 4;
      if(s1 <= s0 && (s0 > 0 || s1 <= 0)) return { act:"ckong", t:t };
    }
    /* 加槓:已經碰出去的那組又摸到第四張。melds 沒變多 → 要湊的組數不變,
       等於「打掉這一張再補一張」。⚠ 會被搶槓,高手在別人可能聽的時候保守一點。 */
    const ak = v.melds.filter(m=>m.k === "pung" && c[m.t] > 0).map(m=>m.t);
    for(let i=0;i<ak.length;i++){
      const t = ak[i];
      c[t]--;
      const s1 = shanten(c, v.need);
      c[t]++;
      if(s1 <= s0){
        if(lv.wDef && tableThreat(v) > 0.7 && s0 > 1) break;   // 場面很兇又還沒近聽 → 不冒搶槓的險
        return { act:"akong", t:t };
      }
    }

    /* ★ 已經宣告聽牌 → **只能摸切**(v1.67.0)。
       規則層(MJT.discard)本來就擋得住,但一定要讓 AI 自己選對的那一張:
       不然每一手都要靠呼叫端的 fallback 去一張一張試,而它試出來的順序不保證是摸的那張
       (solo.js 的 applyAI 是 `for(all) discard(all[i])`,第一張過得了就用它)。 */
    if(v.ting) return { act:"discard", t:(v.drawn>=0 ? v.drawn : v.hand[v.hand.length-1]) };

    /* ★ 要不要宣告聽牌 */
    const tt = pickTing(v, lvKey);
    if(tt !== null) return { act:"ting", t:tt };

    return { act:"discard", t:pickDiscard(v, lvKey, rng) };
  }

  /* ==========================================================================
     要不要宣告聽牌(v1.67.0)
     ──────────────────────────────────────────────────────────────────────────
     代價:手牌鎖死(只能摸切、不能吃碰);收益:聽牌 1 台,天聽 8 台 / 地聽 4 台。
     所以判準是「這個聽牌值不值得鎖死」,三個難度差在**懂不懂算那件事**:
       · easy   不宣告 —— 新手根本不會想到這一步(它的 desc 就是「完全不防守」)
       · normal 聽牌就宣告(挑「聽的種類最多」的那一打)
       · hard   還要求聽的牌**至少剩一張沒現身**(數場上剩幾張是熟練度,同 pickDiscard
                 那條 lv.seen);而且天聽 / 地聽的門檻內一律宣告(8 台 / 4 台太值錢)
     ★ 只吃 view —— 對手的手牌不在裡面,所以這支和其他決策一樣**結構上不可能作弊**。
     ⚠ 回傳「要打出去的那一張」或 null(不宣告)。
     ========================================================================== */
  function pickTing(v, lvKey){
    const lv = levelOf(lvKey);
    if(!lv.ting || v.ting) return null;
    const c = v.counts;
    /* 手上不是「該打一張」的張數就不可能宣告(吃碰之後也算,但宣告後不能吃碰,
       所以到得了這裡的都是正常狀態)。用張數擋掉可以省下 34 次 shanten。 */
    if(R.countsTotal(c) !== v.need*3 + 2) return null;
    if(shanten(c, v.need) > 0) return null;              // 連一張都還不聽 → 免談

    /* 天聽 / 地聽的門檻:全桌都還沒有人吃碰槓(自己有明牌就一定不算)。
       ⚠ 只看得到「對手有幾組明牌」—— 那正好就是判準本身,不需要偷看任何牌值。 */
    const virgin = v.melds.length===0 && v.foes.every(f=>f.melds.length===0);
    const bonus  = virgin && (v.isDealer ? v.isFirstDiscard : v.discarded < 8);

    let best = null;
    for(let t=0;t<34;t++){
      if(!c[t]) continue;
      c[t]--;
      const w = (shanten(c, v.need)===0) ? R.winningTiles(c, v.need) : [];
      c[t]++;
      if(!w.length) continue;
      /* 「還剩幾張沒現身」:seen 只含公開資訊(自己的手牌 + 全部明牌 + 整條牌河),
         同 pickDiscard 的 seenFor —— 高手才數這個。 */
      let live = 0;
      w.forEach(x=>{ live += Math.max(0, 4 - (v.seen[x]||0)); });
      const score = (lv.seen ? live*4 : 0) + w.length;
      if(!best || score > best.score) best = { t:t, score:score, live:live };
    }
    if(!best) return null;
    /* 天聽 / 地聽值 8 / 4 台 —— 那種局面連「聽的牌被打光了」都值得賭一把 */
    if(bonus) return best.t;
    if(lv.seen && best.live <= 0) return null;           // 鎖死了也等不到 → 不宣告
    return best.t;
  }

  /* 給 UI 用:這一家現在幾向聽 / 聽哪幾張(單機的「電腦在想什麼」與測試都用得到) */
  function status(v){
    const s = shanten(v.counts, v.need);
    return { shanten:s, tiles: s === 0 ? R.winningTiles(v.counts, v.need) : [] };
  }

  return {
    // 引擎
    shanten, ukeire, isTenpai, viewOf, status,
    handValue, tableThreat, flushSuits, dangerOf, claimOptions,
    // 決策
    pickDiscard, pickClaim, pickTurn, pickTing,
    // 難度
    LEVELS, LEVEL_KEYS, levelOf, thinkMs,
    // 給測試用:清掉 memo 才量得準
    _resetMemo(){ memoNum.clear(); memoHon.clear(); }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MJ16AI;

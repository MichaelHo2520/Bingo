"use strict";

/* ============================================================================
   台灣 16 張麻將 — 規則引擎(MJ16)。
   ★ 純函式,零 DOM、零 Firebase、零 MP,可單獨在 node 裡驗。
     規矩比照 js/gomoku/ai.js 與 js/mahjong/gen.js:「這副牌算不算胡」「聽哪幾張」
     只有靠 node 大量對答案才驗得出來,碰了一行 DOM 就只能在瀏覽器裡一局一局手動打。

   ── 這一支負責什麼 ────────────────────────────────────────────────────────
     • 牌組(三個變體)與編碼
     • 拆牌:一手牌能不能組成「N 組面子 + 1 對將」
     • 聽牌:現在聽哪幾張
     • 宣告合法性:吃 / 碰 / 明槓 / 暗槓 / 加槓 / 胡
   不負責:台數計算(scoring.js)、輪次與宣告優先權(adapter.js)、向聽數(P6 單機才要)。

   ── ★ 三個變體共用同一套判定 ──────────────────────────────────────────────
     2/3/4 人的手牌都是 16 張、和牌型都是「5 組面子 + 1 對」,所以拆牌與聽牌 100% 共用,
     差異全部壓縮成 RULESETS 裡的資料(牌組 / 座位數 / 可否吃 / 流局門檻)。
     這就是「變體規則不等於三套實作」的關鍵 —— 驗證是同一支引擎跑三組參數。
   ========================================================================== */

const MJ16 = (function(){

  /* ---------- 編碼 ----------
     0..8   萬 w1..w9
     9..17  條 b1..b9
     18..26 筒 d1..d9
     27..33 字 東南西北中發白(fe fs fw fn jz jf jb)
     34..41 花 春夏秋冬梅蘭竹菊(ha..hd pa..pd)

     ★ 0..33 才進得了 counts 陣列 —— 花牌永遠不參與面子,摸到就攤出來補花,
       所以整支引擎只需要處理 34 種。這也是為什麼 counts 固定長度 34。
     ★ 代號字串刻意與 js/mahjong/gen.js 完全一致,牌面 faceHTML 才能直接共用。 */
  const NUM_SUITS = ["w","b","d"];
  const HONORS    = ["fe","fs","fw","fn","jz","jf","jb"];
  const FLOWERS   = ["ha","hb","hc","hd","pa","pb","pc","pd"];

  const KINDS = 34;                       // 可成面子的牌種數
  const CODES = [];
  NUM_SUITS.forEach(s=>{ for(let v=1;v<=9;v++) CODES.push(s+v); });
  HONORS.forEach(c=>CODES.push(c));
  FLOWERS.forEach(c=>CODES.push(c));      // 34..41

  const IDX = {};
  CODES.forEach((c,i)=>{ IDX[c]=i; });

  function idxOf(code){ return IDX.hasOwnProperty(code) ? IDX[code] : -1; }
  function codeOf(i){ return CODES[i] || null; }
  function isFlower(i){ return i>=34; }
  function isHonor(i){ return i>=27 && i<34; }
  function isNumber(i){ return i>=0 && i<27; }
  function suitOf(i){
    if(i<0) return null;
    if(i<27) return NUM_SUITS[Math.floor(i/9)];
    return i<34 ? "z" : "f";
  }
  function rankOf(i){ return isNumber(i) ? (i%9)+1 : 0; }   // 1..9;非數字牌為 0
  /* 么九牌(1/9 與字牌)—— 台數表的混老頭 / 清老頭會用到,先放這裡當共用工具 */
  function isTerminal(i){ return isHonor(i) || (isNumber(i) && (i%9===0 || i%9===8)); }

  /* ---------- 三個變體 ----------
     ★ 2 人與 3 人**都選「去萬子」**,不是各去各的 —— 牌組只有兩種(144 / 108),
       測資矩陣小一半,而且台數表完全共用。
     ★ 手牌一律 16 張、melds 一律 5 —— 這是三案能共用同一支拆牌的前提,不要為了
       「兩人局比較快」去改成 13 張:那會讓平胡 / 碰碰胡的判定基準跟著變,等於多養一套。
       壓局時改用 wallEnd(牌山剩幾張就流局),那是純參數、零額外邏輯。 */
  const RULESETS = {
    p4: { seats:4, suits:["w","b","d"], honors:true, flowers:true,
          melds:5, hand:16, chow:true,  wallEnd:16, name:"四人(標準)" },
    p3: { seats:3, suits:["b","d"],     honors:true, flowers:true,
          melds:5, hand:16, chow:false, wallEnd:16, name:"三人(去萬子)" },
    p2: { seats:2, suits:["b","d"],     honors:true, flowers:true,
          melds:5, hand:16, chow:true,  wallEnd:40, name:"二人(去萬子)" }
  };
  function rulesetFor(seats){
    return RULESETS["p"+seats] || RULESETS.p4;
  }

  /* ---------- 牌組 ----------
     數字牌與字牌每種 4 張,花牌每種 **1 張**(真麻將的規矩)。
     ⚠ 這裡刻意與消消樂的 MGen 不同 —— 那邊花牌每種 2 張是為了「嚴格同款配對」,
       單張花牌永遠找不到伴。真麻將沒有這個問題,花牌摸到就攤出來。 */
  function buildDeck(rs){
    const out=[];
    rs.suits.forEach(s=>{
      for(let v=1;v<=9;v++){ const i=idxOf(s+v); for(let k=0;k<4;k++) out.push(i); }
    });
    if(rs.honors) HONORS.forEach(c=>{ const i=idxOf(c); for(let k=0;k<4;k++) out.push(i); });
    if(rs.flowers) FLOWERS.forEach(c=>out.push(idxOf(c)));   // 每種只有 1 張
    return out;
  }
  /* 洗牌:Fisher-Yates。rng 可注入,node 測試才能重現同一副牌。
     ★ 洗好的整份 wall 會明碼寫進 game.wall(親友聚會,刻意不防作弊,見 PLAN 第二節), */
  function shuffle(arr, rng){
    const r = rng || Math.random;
    const a = arr.slice();
    for(let i=a.length-1;i>0;i--){
      const j = Math.floor(r()*(i+1));
      const t=a[i]; a[i]=a[j]; a[j]=t;
    }
    return a;
  }
  function buildWall(rs, rng){ return shuffle(buildDeck(rs), rng); }

  /* ---------- counts:手牌的正規形 ----------
     長度固定 34。花牌不進來(摸到就補花攤出去)。 */
  function newCounts(){ return new Int8Array(KINDS); }
  function toCounts(tiles){
    const c=newCounts();
    (tiles||[]).forEach(t=>{
      const i = (typeof t==="string") ? idxOf(t) : t;
      if(i>=0 && i<KINDS) c[i]++;
    });
    return c;
  }
  function countsTotal(c){ let n=0; for(let i=0;i<KINDS;i++) n+=c[i]; return n; }

  /* ---------- ★★ 「玩家自己排的手牌順序」(v1.82.0)----------
     使用者:「台灣麻將,請你參考大老二,我想增加拖曳排序功能」。
     ord = 玩家拖出來的**牌值**順序;回傳「照 ord 排好的 hand」。

     ★★ 這一支是**顯示層的東西**,放在規則層只因為它是純函式、要在 node 裡驗
        (同大老二的 B2.applyOrder)。**ord 從來不進 DB、不影響任何判定** ——
        打的是「哪一張牌」而不是「第幾格」,MJT.discard 吃的是牌值。
        ⚠ 絕對不可以拿它去拆牌 / 算聽 / 判宣告:decompose / claimsFor / toCounts
          一律吃**多重集合**,順序對它們沒有意義。

     ── ★★ 與大老二最大的不同:麻將的牌**會重複** ────────────────────────────
       大老二的 52 張牌 id 唯一,ord 可以直接當「牌 → 位置」的字典;
       這裡同一款牌手上可能有 4 張,所以比對一律走**多重集合的消耗**:
       ord 從左往右,每個牌值只消耗掉「手上還有的那幾張裡的一張」。
       ⚠ 寫成 `hand.filter(t => ord.indexOf(t) >= 0)` 之類的一定錯:
         手上兩張 5 萬而 ord 只提到一張時,那種寫法會把兩張都算成「排過的」。

     兩條容錯,都是刻意的(同大老二):
       · ord 裡已經**不在手上**的牌(打掉了 / 被吃碰走了)自動消失
         → 剩下的相對順序原封不動
       · hand 裡 ord **沒提到**的牌(摸進來又留下的那張)一律照牌序補在**後面** ——
         那正是真牌桌的樣子:新進來的牌先擺在右邊,要放哪裡自己再拖。 */
  function applyOrder(hand, ord){
    const sorted = (hand||[]).slice().sort((a,b)=>a-b);
    if(!Array.isArray(ord) || !ord.length) return sorted;
    const left = {};
    sorted.forEach(t=>{ left[t] = (left[t]||0) + 1; });
    const out = [];
    ord.forEach(t=>{ if(left[t] > 0){ left[t]--; out.push(t); } });
    const rest = [];
    sorted.forEach(t=>{ if(left[t] > 0){ left[t]--; rest.push(t); } });
    return out.concat(rest);
  }

  /* ---------- 拆牌 ----------
     ★ 演算法的正確性關鍵:每一層都**必須消掉「目前還有牌的最小索引 i」**。
       理由是 i 一定屬於某一組面子,而且若那組是順子,i 必定是順子的頭
       (比 i 小的都沒牌了)→ 只有「刻子」與「以 i 起頭的順子」兩種可能,窮舉完就是完備的。
       這讓遞迴不必回頭試別的順序,也不會漏解。

     ⚠ 兩個一定要有的守衛:
       ① 順子只有數字牌能組 → i < 27(字牌不能連,東南西不是順子)
       ② 不可跨門 → i%9 <= 6(w9,b1,b2 這種是 idx 8,9,10,連號但跨門) */
  function decompose(c, need){
    if(need===0){
      for(let i=0;i<KINDS;i++) if(c[i]) return false;   // 組數夠了卻還有剩牌 → 不成立
      return true;
    }
    let i=0; while(i<KINDS && !c[i]) i++;
    if(i===KINDS) return false;                          // 還要組,牌卻用完了

    if(c[i]>=3){                                         // 刻子
      c[i]-=3;
      const ok = decompose(c, need-1);
      c[i]+=3;
      if(ok) return true;
    }
    if(i<27 && (i%9)<=6 && c[i+1]>0 && c[i+2]>0){        // 順子(見上面兩個守衛)
      c[i]--; c[i+1]--; c[i+2]--;
      const ok = decompose(c, need-1);
      c[i]++; c[i+1]++; c[i+2]++;
      if(ok) return true;
    }
    return false;
  }

  /* 能不能胡:need 組面子 + 1 對將。
     need = 這一局要湊的總組數(rs.melds)− 已經吃碰槓攤出來的組數。
     ⚠ 槓雖然是 4 張牌,但它就是「一組」,而且槓完會補摸一張 → 對手牌張數而言仍佔 3 格。
        所以 need 一律用「攤出來幾組」去減,不要用張數換算。 */
  function canWin(c, need){
    if(need<0) return false;
    if(countsTotal(c) !== need*3+2) return false;        // 張數先擋掉,省掉一堆遞迴
    for(let k=0;k<KINDS;k++){
      if(c[k]>=2){
        c[k]-=2;
        const ok = decompose(c, need);
        c[k]+=2;
        if(ok) return true;
      }
    }
    return false;
  }

  /* ---------- 列出所有拆法(台數計算專用) ----------
     ★ 為什麼不能只拿「第一種拆法」去算台:同一副牌常常拆得出好幾種,台數不一樣。
       經典例子 `b1b1b1 b2b2b2 b3b3b3` 可以拆成三組刻子(→ 碰碰胡 4 台),
       也可以拆成三組 b1b2b3 順子(→ 沒有碰碰胡)。**規矩是算對玩家最有利的那一種**,
       所以台數表必須拿到全部拆法再取最大值。

     枚舉方式與 decompose() 同一個骨架(每層消掉最小索引),所以:
       ① 完備 —— 每個合法拆法都會被走到
       ② 不重複 —— 每個拆法只會以「依最小索引排序」這一種順序被產生一次 */
  function allDecompositions(c, need){
    const out=[], cur=[];
    (function rec(n){
      if(n===0){
        for(let i=0;i<KINDS;i++) if(c[i]) return;
        out.push(cur.slice());
        return;
      }
      let i=0; while(i<KINDS && !c[i]) i++;
      if(i===KINDS) return;
      if(c[i]>=3){
        c[i]-=3; cur.push({ kind:"pung", t:i });
        rec(n-1);
        cur.pop(); c[i]+=3;
      }
      if(i<27 && (i%9)<=6 && c[i+1]>0 && c[i+2]>0){
        c[i]--; c[i+1]--; c[i+2]--; cur.push({ kind:"chow", t:i });
        rec(n-1);
        cur.pop(); c[i]++; c[i+1]++; c[i+2]++;
      }
    })(need);
    return out;
  }

  /* 一副胡牌的所有「將 + 面子」組合。回傳 [{ pair, sets:[{kind,t}] }, …]。
     沒胡就是空陣列。台數表拿這份去逐一算、取最大。 */
  function winningHands(c, need){
    const out=[];
    if(need<0 || countsTotal(c) !== need*3+2) return out;
    for(let k=0;k<KINDS;k++){
      if(c[k]<2) continue;
      c[k]-=2;
      allDecompositions(c, need).forEach(sets=>out.push({ pair:k, sets:sets }));
      c[k]+=2;
    }
    return out;
  }

  /* 聽哪幾張:手上是 need*3+1 張,逐一試「再加一張」能不能胡。
     回傳牌種索引陣列(升冪)。空陣列 = 沒聽。
     ⚠ c[k] 已經有 4 張就不能再加(第 5 張不存在)—— 少了這個守衛會報出根本摸不到的聽牌。 */
  function winningTiles(c, need){
    const out=[];
    if(countsTotal(c) !== need*3+1) return out;
    for(let k=0;k<KINDS;k++){
      if(c[k]>=4) continue;
      c[k]++;
      const ok = canWin(c, need);
      c[k]--;
      if(ok) out.push(k);
    }
    return out;
  }
  function isTenpai(c, need){ return winningTiles(c, need).length>0; }

  /* ---------- 宣告合法性 ----------
     只回答「這個宣告合不合法」,**不管優先權、也不管輪到誰** —— 那兩件事在 adapter。
     ★ 因為手牌明碼,每台裝置都能用這支獨立算出「誰有資格宣告什麼」,
       宣告裁決因此不必指定房主(房主一斷線就卡死),用交易搶即可。見 PLAN 4.4。

     opts:
       need      還要湊幾組(= rs.melds − 已攤出的組數)
       chow      這個變體允不允許吃(三人局關掉)
       fromLeft  出牌者是不是我的上家(只有上家的牌能吃)
       pongs     我已經碰出去的牌種(判斷加槓用) */
  function claimsFor(c, tile, opts){
    const o = opts||{};
    const need = (typeof o.need==="number") ? o.need : 5;
    const res = { pong:false, kong:false, chow:[], win:false };
    if(tile<0 || tile>=KINDS) return res;                // 花牌不能被宣告

    if(c[tile]>=2) res.pong = true;
    if(c[tile]>=3) res.kong = true;                      // 明槓(碰牌槓)

    if(o.chow && o.fromLeft && isNumber(tile)){
      const r = tile%9;                                  // 0..8 對應 1..9
      // 三種吃法:我出兩張補成順子。都要守「不可跨門」——用 r 判斷比用 tile 安全
      if(r>=2 && c[tile-2]>0 && c[tile-1]>0) res.chow.push([tile-2, tile-1]);
      if(r>=1 && r<=7 && c[tile-1]>0 && c[tile+1]>0) res.chow.push([tile-1, tile+1]);
      if(r<=6 && c[tile+1]>0 && c[tile+2]>0) res.chow.push([tile+1, tile+2]);
    }

    // 胡:把這張加進來看看成不成立
    if(c[tile]<4){
      c[tile]++;
      res.win = canWin(c, need);
      c[tile]--;
    }
    return res;
  }

  /* 暗槓:手上自己就有 4 張(不必別人打)。回傳可暗槓的牌種。 */
  function concealedKongs(c){
    const out=[];
    for(let k=0;k<KINDS;k++) if(c[k]===4) out.push(k);
    return out;
  }
  /* 加槓:已經碰出去的那組,又摸到第 4 張。pongs = 已碰的牌種陣列。 */
  function addedKongs(c, pongs){
    return (pongs||[]).filter(k=> k>=0 && k<KINDS && c[k]>0);
  }

  /* ---------- 流局 ----------
     牌山剩下 wallEnd 張就結束(4/3 人 16 張 = 傳統的「海底」留一墩;
     2 人局用 40 是為了壓局時 —— 兩家摸得慢,打到見底會拖很久)。 */
  function isExhausted(wall, pos, rs){
    return (wall.length - pos) <= rs.wallEnd;
  }

  return {
    // 編碼
    KINDS, CODES, NUM_SUITS, HONORS, FLOWERS,
    idxOf, codeOf, isFlower, isHonor, isNumber, isTerminal, suitOf, rankOf,
    // 變體與牌組
    RULESETS, rulesetFor, buildDeck, buildWall, shuffle,
    // 手牌
    newCounts, toCounts, countsTotal,
    // 顯示順序(玩家拖出來的;純函式、不進 DB、不參與任何判定)
    applyOrder,
    // 判定
    decompose, canWin, winningTiles, isTenpai,
    allDecompositions, winningHands,
    claimsFor, concealedKongs, addedKongs,
    isExhausted
    // TODO(P6 單機聽牌練習):shanten(c, need) 向聽數 + 「打哪張進張最多」。
    //   刻意不在 P1 做 —— 它只有單機用得到,而且積木計數的邊界(無將時要不要 +1)
    //   很容易寫出「看起來對、罕見牌型才錯」的版本,要有專屬測資才動。
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = MJ16;

"use strict";

/* ============================================================================
   麻將消牌 — 牌組 / 佈局 / 出題(MGen)。★ 純函式,零 DOM、零 Firebase,可單獨在 node 裡驗。
   (規矩比照 js/gomoku/ai.js:碰了一行 DOM 就只能在瀏覽器裡一局一局手動玩)

   ★ 為什麼不是「洗好牌隨便擺,擺完再檢查解不解得開」:那要跑搜尋,而且大多數隨機擺法
     其實是死局(經典 144 牌的隨機擺法可解率很低)。這裡反過來做 ——

     1. 先在**空白佈局**上跑一次「合法的拆牌順序」:從滿盤開始,每回合挑 2 張**可動的牌**
        拿掉,一路拿到空。這條順序就是一份保證存在的解法。
        關鍵:拿牌只會讓更多牌變得可動,**永遠不會把原本可動的牌鎖住** → 同時挑 2 張
        可動的牌一定同時合法,不必再互相檢查。
     2. 再把洗好的**成對牌**照這條順序填回去:第 k 對牌放進第 k 步拿掉的那兩格。
     → 照原順序拿就一定通關,而且完全不需要 solver。

   ★ 「優先拿最上層」不是美感問題,是防卡死:上層先清空,最後留在底層的牌一定側面有空位。
     若隨機亂挑,很容易在剩最後兩張時剛好上下疊在一起(下面那張被壓住 → 只有 1 張可動
     → 湊不出一對)。仍保留重試,但實測失敗率極低(見 tools 的驗證腳本)。

   「可動(free)」的定義(這裡是**對齊格**版本,不是傳統麻將的半格錯位):
     • 正上方那一格沒有牌(對齊格 → 每格最多只被 1 張壓住,比錯位版單純很多)
     • 左右至少有一邊沒有牌(左右都有牌就抽不出來)
   ========================================================================== */

const MGen = (function(){

  /* ---------- 牌組:34 種各 4 張 + 8 張花 = 144 ---------- */
  const NUM_SUITS = ["w","b","d"];                          // 萬 / 條 / 筒
  const HONORS    = ["fe","fs","fw","fn","jz","jf","jb"];   // 東南西北 / 中發白
  const SUIT_MARK = { w:"萬", b:"條", d:"筒" };

  // 牌面:[大字, CSS 花色 class]。數字牌由代號推導,不列在這裡
  const FACE = {
    fe:["東","z"],  fs:["南","z"],  fw:["西","z"],  fn:["北","z"],
    jz:["中","jz"], jf:["發","jf"], jb:["白","jb"],
    ha:["春","h"],  hb:["夏","h"],  hc:["秋","h"],  hd:["冬","h"],
    pa:["梅","p"],  pb:["蘭","p"],  pc:["竹","p"],  pd:["菊","p"]
  };

  /* 配對群組:同群即可配。
     花牌刻意讓「春夏秋冬」四張互通、「梅蘭竹菊」四張互通 —— 這是傳統消牌的規則,
     也讓花牌變成好用的救援牌(死局時通常靠它解套)。 */
  function grpOf(code){
    const c=code.charCodeAt(0);
    if(c===104) return "H";      // 'h' → 春夏秋冬
    if(c===112) return "P";      // 'p' → 梅蘭竹菊
    return code;
  }
  function matches(a,b){ return grpOf(a)===grpOf(b); }

  // 牌面資料給 board.js 用:{ glyph 大字, mark 花色小字, cls, name 給 aria/toast }
  function faceOf(code){
    const f=FACE[code];
    if(f) return { glyph:f[0], mark:"", cls:f[1], name:f[0] };
    const s=code.charAt(0), v=code.charAt(1);
    return { glyph:v, mark:SUIT_MARK[s]||"", cls:s, name:v+(SUIT_MARK[s]||"") };
  }

  /* ---------- 牌的幾何比例 ----------
     ★ 這裡是 JS 唯一的來源,board.js 一律讀 MGen.GEO(不要各自寫一份常數)。
       ⚠ styles.css 的 .mj-tile / .mj-stage 裡也寫死同兩個數字(CSS 讀不到 JS 常數),
          動這兩個值一定要同時改 styles.css,否則盤面外框會與牌的實際位置錯開。 */
  const GEO = {
    ratio:1.32,   // 牌高 / 牌寬(接近實體麻將牌)
    off:0.13,     // 每往上一層的位移(牌寬的幾倍)
    min:18,       // 牌寬下限:再小就點不到
    max:74        // 牌寬上限:免得 36 牌在平板上變巨無霸
  };

  /* ---------- 難度 = 佈局大小,每個難度各有「寬版 / 直式」兩種形狀 ----------
     cols/rows 直接決定手機上一張牌有多寬(欄數越多牌越小),所以形狀同時也是「牌面大小」。

     ★ 為什麼要兩種形狀(v1.55.0):盤面被「寬度放得下幾欄」與「高度放得下幾列」夾住,取小的
       那個。手機直立(390×844)是**寬度**先卡死 —— 144 牌的寬版 12×8 只能給到 30.5px,而底下
       整整空掉 186px;換成接近正方的 10×10 就有 36.3px。三個難度實測(390×844):
         36 牌  8×3 → 47.0px / 空 332px    直式 5×6 → 74.0px(撞上限)
         72 牌 10×5 → 37.3px / 空 268px    直式 7×8 → 48.4px / 空 0
        144 牌 12×8 → 30.5px / 空 186px    直式 10×10 → 36.3px / 空 26px
       反過來桌機與橫向螢幕仍是寬版划算(1280×800 的 144 牌:寬版 43px vs 直式 35px),
       所以**不是取代,是兩套並存**,由 pickShape() 依畫面比例挑。
     ★ layers 兩種形狀刻意相同 —— 選單的「N 層」文案在還沒決定形狀時就要顯示。 */
  const LEVELS = {
    s36 : { key:"s36",  n:36,  layers:2, label:"36 牌",  name:"輕鬆", desc:"一局約 1~2 分鐘",
            wide:{ cols:8,  rows:3  }, tall:{ cols:5,  rows:6  } },
    m72 : { key:"m72",  n:72,  layers:3, label:"72 牌",  name:"標準", desc:"一局約 3~6 分鐘",
            wide:{ cols:10, rows:5  }, tall:{ cols:7,  rows:8  } },
    l144: { key:"l144", n:144, layers:5, label:"144 牌", name:"經典", desc:"一局約 8~15 分鐘",
            wide:{ cols:12, rows:8  }, tall:{ cols:10, rows:10 } }
  };
  const ORDER  = ["s36","m72","l144"];
  const SHAPES = ["wide","tall"];
  function shapeOf(v){ return v==="tall" ? "tall" : "wide"; }
  function geoOf(levelKey, shape){
    const L=LEVELS[levelKey]||LEVELS.m72, g=L[shapeOf(shape)];
    return { cols:g.cols, rows:g.rows, layers:L.layers };
  }

  /* ---------- 形狀怎麼挑:算誰的牌比較大,不用魔術比例 ----------
     ★ 刻意不寫成 `w/h < 1.05 ? tall : wide` —— 那種門檻一旦佈局改了就默默失準。
       這裡直接把兩種形狀的牌寬算出來比大小,改佈局時選擇邏輯自動跟著對,而且是純函式、
       node 測得到。CHROME 是 topbar + HUD + 工具列 + 間距的粗估:只用來比大小,不必精準
       (真正的牌寬仍由 board.js 的 fit() 量實際容器後算)。
     ★ 吃視窗尺寸而不是容器尺寸:出題發生在盤面還沒顯示的時候(容器 clientHeight = 0)。 */
  const CHROME = 300;
  /* 一個形狀在 W×H 的容器裡「實際會拿到多大的牌」。
     ⚠ 一定要夾在 GEO.min~GEO.max 之間再回傳 —— 少了這一步,兩種形狀在大螢幕上明明都撞到
        74px 上限,卻還會分出勝負(平板直立的 36 牌就這樣被判給直式)。board.js 的 fit()
        用同一組夾限,兩邊的答案才會一致。 */
  function tileW(g, W, H){
    const raw=Math.min(W/(g.cols + GEO.off*(g.layers-1)),
                       H/(GEO.ratio*g.rows + GEO.off*(g.layers-1)));
    return Math.max(GEO.min, Math.min(raw, GEO.max));
  }
  // 平手(兩種都撞上限、或都撞下限)一律回寬版:傳統麻將盤就是寬的,沒有好處就別換樣子
  function pickShape(levelKey, w, h){
    const W=Math.min((w||360)*0.98, 780), H=Math.max(140, (h||640)-CHROME);
    return tileW(geoOf(levelKey,"tall"),W,H) > tileW(geoOf(levelKey,"wide"),W,H) ? "tall" : "wide";
  }

  /* ---------- 佈局:每層一張 ASCII 圖('#'=有牌) ----------
     用圖而不是座標清單,是為了「看得出形狀」—— 改佈局時肉眼就能確認對稱與支撐關係。
     ⚠ 三個硬約束,加/改佈局一定要自己核對(node 測試會把①②跑一遍):
        ① 上層的每一格,正下方**必須**也有牌(不然是浮在空中)→ validate()
        ② 總格數**必須**等於該難度的 n(36 / 72 / 144),牌是成對發的,少一格就整副對不上
        ③ removalOrder() 的成功率要夠高 —— 太窄太長的形狀會在最後兩張疊在一起時卡死,
           這件事看圖看不出來,只有 tools/test-mahjong-gen.js 大量產題才驗得出來 */
  const LAYOUTS = {
    s36: {
      /* 8×3×2 = 24 + 12 */
      wide: [
        ["########",
         "########",
         "########"],
        ["..####..",
         "..####..",
         "..####.."]
      ],
      /* 5×6×2 = 26 + 10。上下兩列收窄成六角形,中間兩列疊第二層 */
      tall: [
        [".###.",
         "#####",
         "#####",
         "#####",
         "#####",
         ".###."],
        [".....",
         ".....",
         "#####",
         "#####",
         ".....",
         "....."]
      ]
    },
    m72: {
      /* 10×5×3 = 44 + 24 + 4 */
      wide: [
        ["..######..",
         "##########",
         "##########",
         "##########",
         "..######.."],
        ["...####...",
         "..######..",
         "..######..",
         "..######..",
         "...####..."],
        ["..........",
         "..........",
         "...####...",
         "..........",
         ".........."]
      ],
      /* 7×8×3 = 56 + 10 + 6。底層滿版,中間兩列疊出兩階山脊 */
      tall: [
        ["#######",
         "#######",
         "#######",
         "#######",
         "#######",
         "#######",
         "#######",
         "#######"],
        [".......",
         ".......",
         ".......",
         ".#####.",
         ".#####.",
         ".......",
         ".......",
         "......."],
        [".......",
         ".......",
         ".......",
         "..###..",
         "..###..",
         ".......",
         ".......",
         "......."]
      ]
    },
    l144: {
      /* 12×8×5 = 92 + 40 + 8 + 2 + 2 */
      wide: [
        ["..########..",
         ".##########.",
         "############",
         "############",
         "############",
         "############",
         ".##########.",
         "..########.."],
        ["............",
         "....####....",
         "..########..",
         "..########..",
         "..########..",
         "..########..",
         "....####....",
         "............"],
        ["............",
         "............",
         ".....##.....",
         "....####....",
         "....####....",
         ".....##.....",
         "............",
         "............"],
        ["............",
         "............",
         "............",
         ".....##.....",
         ".....##.....",
         "............",
         "............",
         "............"],
        ["............",
         "............",
         "............",
         ".....##.....",
         ".....##.....",
         "............",
         "............",
         "............"]
      ],
      /* 10×10×5 = 96 + 24 + 16 + 4 + 4。四角切掉,中央疊成四階金字塔 */
      tall: [
        [".########.",
         "##########",
         "##########",
         "##########",
         "##########",
         "##########",
         "##########",
         "##########",
         "##########",
         ".########."],
        ["..........",
         "..........",
         "..........",
         "..######..",
         "..######..",
         "..######..",
         "..######..",
         "..........",
         "..........",
         ".........."],
        ["..........",
         "..........",
         "..........",
         "...####...",
         "...####...",
         "...####...",
         "...####...",
         "..........",
         "..........",
         ".........."],
        ["..........",
         "..........",
         "..........",
         "..........",
         "....##....",
         "....##....",
         "..........",
         "..........",
         "..........",
         ".........."],
        ["..........",
         "..........",
         "..........",
         "..........",
         "....##....",
         "....##....",
         "..........",
         "..........",
         "..........",
         ".........."]
      ]
    }
  };

  /* ---------- 佈局 → 格位表(每個難度只算一次,之後重複使用) ----------
     list[i] = {c,r,l};up/left/right = 相鄰格的 index(沒有就 -1)。
     先算好鄰居才不必在迴圈裡查表 —— isFree() 會被呼叫幾十萬次。 */
  const cache = {};
  function slotsOf(levelKey, shape){
    const sh=shapeOf(shape), ck=(LEVELS[levelKey]?levelKey:"m72")+"/"+sh;
    if(cache[ck]) return cache[ck];
    const grid=(LAYOUTS[levelKey]||LAYOUTS.m72)[sh];
    const list=[], at={};
    const key=(c,r,l)=>l+":"+r+":"+c;
    grid.forEach((rowsArr,l)=>{
      rowsArr.forEach((line,r)=>{
        for(let c=0;c<line.length;c++){
          if(line.charAt(c)!=="#") continue;
          at[key(c,r,l)]=list.length;
          list.push({ c:c, r:r, l:l });
        }
      });
    });
    const up=[], left=[], right=[];
    list.forEach(s=>{
      const g=(c,r,l)=>{ const v=at[key(c,r,l)]; return v===undefined?-1:v; };
      up.push(   g(s.c,   s.r, s.l+1));
      left.push( g(s.c-1, s.r, s.l  ));
      right.push(g(s.c+1, s.r, s.l  ));
    });
    return (cache[ck]={ key:levelKey, shape:sh, list, up, left, right, down:list.map(s=>{
      const v=at[key(s.c,s.r,s.l-1)]; return v===undefined?-1:v;
    }) });
  }

  /* ---------- 可動判定 ---------- */
  function isFree(S, alive, i){
    const u=S.up[i];
    if(u>=0 && alive[u]) return false;                 // 被壓住
    const l=S.left[i], r=S.right[i];
    return !(l>=0 && alive[l] && r>=0 && alive[r]);    // 左右都有牌 = 抽不出來
  }
  function freeList(S, alive){
    const out=[];
    for(let i=0;i<alive.length;i++) if(alive[i] && isFree(S,alive,i)) out.push(i);
    return out;
  }

  /* ---------- 洗牌 / 成對 ---------- */
  function shuffle(a){
    for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=a[i]; a[i]=a[j]; a[j]=t; }
    return a;
  }
  // 整副 144 張切成 72 對(同群才成對)。花牌 4 張互通 → 隨便兩張湊一對都合法
  function deckPairs(){
    const ps=[];
    NUM_SUITS.forEach(s=>{ for(let v=1;v<=9;v++){ ps.push([s+v,s+v]); ps.push([s+v,s+v]); } });
    HONORS.forEach(c=>{ ps.push([c,c]); ps.push([c,c]); });
    ps.push(["ha","hb"],["hc","hd"],["pa","pb"],["pc","pd"]);
    shuffle(ps);
    // 對內也洗:花牌那四對的兩張不一樣,誰放前面會影響擺在哪一格
    ps.forEach(p=>{ if(Math.random()<0.5){ const t=p[0]; p[0]=p[1]; p[1]=t; } });
    return ps;
  }
  /* 把一堆現有的牌重新湊成對(重洗用)。
     每群的張數恆為偶數 —— 玩家每次消牌都從同一群拿走 2 張,這個不變量不會被破壞。 */
  function pairsFrom(codes){
    const by={};
    codes.forEach(c=>{ const g=grpOf(c); (by[g]=by[g]||[]).push(c); });
    const ps=[];
    Object.keys(by).forEach(g=>{
      const a=by[g];
      for(let i=0;i+1<a.length;i+=2) ps.push([a[i],a[i+1]]);
    });
    return shuffle(ps);
  }

  /* ---------- 核心:走出一條合法的拆牌順序 ----------
     回傳 [[格a,格b], …](第 k 對 = 第 k 步拿掉的兩格);湊不出一對就回 null 讓外面重試。
     start 可傳「目前還在盤上的牌」→ 重洗時只重排剩下的格位。 */
  function removalOrder(S, start){
    const n=S.list.length;
    const alive = start ? Uint8Array.from(start) : new Uint8Array(n).fill(1);
    const out=[];
    let rest=0; for(let i=0;i<n;i++) if(alive[i]) rest++;
    if(rest%2) return null;                 // 奇數張湊不成對(理論上不會發生)
    while(rest>0){
      const free=freeList(S,alive);
      if(free.length<2) return null;
      const a=pickTop(S,free,-1);
      const b=pickTop(S,free,a);
      alive[a]=0; alive[b]=0; rest-=2;
      out.push([a,b]);
    }
    return out;
  }
  // 從可動的牌裡挑一張:優先最上層(見檔頭「防卡死」),同層之間隨機
  function pickTop(S, free, skip){
    let top=-1;
    for(let k=0;k<free.length;k++){ const i=free[k]; if(i!==skip && S.list[i].l>top) top=S.list[i].l; }
    const hi=[];
    for(let k=0;k<free.length;k++){ const i=free[k]; if(i!==skip && S.list[i].l===top) hi.push(i); }
    return hi[Math.floor(Math.random()*hi.length)];
  }

  /* ---------- 對外:出一題 ----------
     回傳 { level, shape, cols, rows, n, tiles, code, order };tiles[i] = 那一格的牌代號。
     ★ shape 一定要跟著題目走 —— 連線是全房共用一份 tiles + 格位索引,兩邊形狀不同就整盤錯位。 */
  function make(levelKey, shape, tries){
    const L=LEVELS[levelKey]||LEVELS.m72, sh=shapeOf(shape);
    const S=slotsOf(L.key,sh), g=geoOf(L.key,sh);
    const max=tries||300;
    for(let t=0;t<max;t++){
      const order=removalOrder(S,null);
      if(!order) continue;
      const ps=deckPairs();
      const tiles=new Array(S.list.length);
      order.forEach((pr,k)=>{ tiles[pr[0]]=ps[k][0]; tiles[pr[1]]=ps[k][1]; });
      // order 是「保證解得開」的那條參考解法。連線只傳 code,不會外流;
      // 留著是為了讓 node 測試能把這條路重走一遍,直接驗到生成器的保證本身
      return { level:L.key, shape:sh, cols:g.cols, rows:g.rows, n:S.list.length,
               tiles:tiles, code:tiles.join(""), order:order };
    }
    return null;   // 呼叫端要自己處理(實測不會發生;solo.js 會退回上一題)
  }

  /* 重洗:保留「哪些格還有牌」,把剩下的牌重新排成一定解得開的樣子。
     回傳新的 tiles 陣列(整份,已死的格位維持原值不影響);失敗回 null。
     ⚠ shape 必須是**這局用的那個**(MB.shape()),不是重算一次 —— 中途轉向也不會換形狀。 */
  function reshuffle(levelKey, shape, alive, tiles, tries){
    const S=slotsOf(LEVELS[levelKey]?levelKey:"m72", shape);
    const codes=[];
    for(let i=0;i<alive.length;i++) if(alive[i]) codes.push(tiles[i]);
    if(codes.length<2) return null;
    const max=tries||300;
    for(let t=0;t<max;t++){
      const order=removalOrder(S,alive);
      if(!order) continue;
      const ps=pairsFrom(codes);
      const out=tiles.slice();
      order.forEach((pr,k)=>{ out[pr[0]]=ps[k][0]; out[pr[1]]=ps[k][1]; });
      return out;
    }
    return null;
  }

  /* 現在還有哪些配對可以消(提示 / 死局判定共用這一支) */
  function movesOf(S, alive, tiles){
    const by={}, out=[];
    freeList(S,alive).forEach(i=>{ const g=grpOf(tiles[i]); (by[g]=by[g]||[]).push(i); });
    Object.keys(by).forEach(g=>{
      const a=by[g];
      for(let x=0;x<a.length-1;x++) for(let y=x+1;y<a.length;y++) out.push([a[x],a[y]]);
    });
    return out;
  }

  /* ---------- 序列化(連線同步用) ----------
     每個代號恰好 2 個字元 → 直接接成字串,144 張 = 288 字元,存進 Firebase 很省也看得懂 */
  function parse(str){
    const out=[];
    for(let i=0;i+1<str.length;i+=2) out.push(str.substr(i,2));
    return out;
  }

  /* ---------- 佈局自我檢查(給 node 測試用) ----------
     ① 上層每一格的正下方都必須有牌,否則那張牌是浮空的
     ② 總格數必須等於該難度的 n(want),不然整副牌對不上 */
  function validate(levelKey, shape){
    const sh=shapeOf(shape), S=slotsOf(levelKey,sh), bad=[];
    S.list.forEach((s,i)=>{ if(s.l>0 && S.down[i]<0) bad.push(s); });
    const g=geoOf(levelKey,sh);
    return { level:levelKey, shape:sh, n:S.list.length, want:(LEVELS[levelKey]||LEVELS.m72).n,
             cols:g.cols, rows:g.rows, layers:g.layers, floating:bad };
  }

  return {
    LEVELS, ORDER, LAYOUTS, SHAPES, GEO,
    levelOf:k=>LEVELS[k]||LEVELS.m72,
    shapeOf, geoOf, pickShape, tileW,
    slotsOf, isFree, freeList, movesOf, matches, grpOf, faceOf,
    make, reshuffle, removalOrder, parse, validate
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = MGen;

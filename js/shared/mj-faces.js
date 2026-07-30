"use strict";

/* ============================================================================
   麻將牌面自繪(MJFace)—— 消消樂(mahjong.html)與台灣 16 張(mahjong16.html)共用。
   v1.58.0 從 js/mahjong/board.js 抽出來,繪圖程式碼**一行都沒改**(抽出的守門就是
   tools/t-mj-faces.html 的 42 種截圖必須與 v1.57.1 完全一致)。

   ★ 為什麼可以共用、而且應該共用:
     這一支是**純視覺純函式** —— 沒有遊戲邏輯、不碰 DOM 事件、不知道盤面長什麼樣,
     只回傳一段 SVG 字串。「兩頁的牌長一樣」本來就是想要的。
     (Bingo 那幾組刻意兩份是因為 index.html 不載入 js/shared/,這裡沒有那個理由。)

   ── 牌面自繪的設計 ────────────────────────────────────────────────────────
     一張牌一個 SVG,viewBox 固定 0 0 100 132(= 1 : 1.32,接近實體牌)。
     ★ 顏色分兩套,界線很清楚:
       • **數字牌(萬/條/筒)用明確的三色 class**(mj-cu 藍 / mj-cr 紅 / mj-cg 綠)——
         真麻將牌上這些配色是固定的、是牌的一部分(三筒藍紅綠斜排、九索三欄各一色、
         七索上面那一根是紅的),不該跟著主題變。
       • **字牌與花牌用 currentColor**,花色設在牌的 color 上(CSS 依 data-suit)——
         東南西北 / 中 / 發 / 白 / 花的顏色是我們自己配的辨識色,要跟著主題走。
       ⚠ .mj-t 已經有 fill:currentColor (0,1,0),同級的 .mj-cu 靠 source order 不保險 ——
         CSS 那邊一定要另外寫 .mj-t.mj-cu 這種兩層的(同 v1.49.0 .mvc-open 的坑)。
     ★ 座標寫死在 viewBox 座標系裡,牌實際多大由 CSS 的 --mjw / --m16w 決定。
     ★ 42 種牌面各只算一次就快取。
     ★ 一切都畫得粗:30px 寬的牌上,細節一律糊成一團 —— 寧可少幾塊、每塊大一點。

   ⚠ **GLYPH / CLS 與 js/mahjong/gen.js 的 FACE 表是刻意的兩份**:
     gen.js 依 CLAUDE.md 紅線必須維持「純函式、零依賴」(node 大量產題驗可解性),
     不能反過來相依這一支。守門是 tools/test-mj-faces-sync.js —— 它同時載入兩邊、
     逐張比對 42 種牌的字與花色 class,對不上就紅燈。**改一邊記得改另一邊。**
   ========================================================================== */

const MJFace = (function(){

  /* ---------- 牌的「長相」資料:字 + 花色 class ---------- */
  const GLYPH = {
    fe:["東","z"],  fs:["南","z"],  fw:["西","z"],  fn:["北","z"],
    jz:["中","jz"], jf:["發","jf"], jb:["白","jb"],
    ha:["春","ha"], hb:["夏","hb"], hc:["秋","hc"], hd:["冬","hd"],
    pa:["梅","pa"], pb:["蘭","pb"], pc:["竹","pc"], pd:["菊","pd"]
  };
  const SUIT_MARK = { w:"萬", b:"條", d:"筒" };

  function info(code){
    const f = GLYPH[code];
    if(f) return { glyph:f[0], mark:"", cls:f[1], name:f[0] };
    const s = code.charAt(0), v = code.charAt(1);
    return { glyph:v, mark:SUIT_MARK[s]||"", cls:s, name:v+(SUIT_MARK[s]||"") };
  }

  // 「五」寫作「伍」:實體萬子牌上就是大寫的伍
  const NUM=["一","二","三","四","伍","六","七","八","九"];
  const svgCache={};
  const CU="mj-cu", CR="mj-cr", CG="mj-cg";     // 藍(靛) / 紅 / 綠

  // 筒:同心圓(外圈實心 → 牌面色白圈 → 中心點),真牌上的餅就是這個樣子
  function pin(x,y,r,c){
    return '<circle class="'+c+'" cx="'+x+'" cy="'+y+'" r="'+r+'"/>'+
           '<circle class="mj-hole" cx="'+x+'" cy="'+y+'" r="'+(r*0.60).toFixed(1)+'"/>'+
           '<circle class="'+c+'" cx="'+x+'" cy="'+y+'" r="'+(r*0.28).toFixed(1)+'"/>';
  }
  /* 幾筒排在哪:照傳統排法(三筒斜著、七筒上三下四…),不是機械式的方格。
     PIN_C 是**對應 PIN_P 同一個索引**的顏色:
       二筒 上藍下綠 / 三筒 藍紅綠斜排 / 四筒 對角同色 / 五筒 四角 + 紅心 /
       六筒 上二綠下四紅 / 七筒 上三綠下四紅 / 八筒 全藍 / 九筒 三排 藍紅綠 */
  const PIN_P={
    2:[[50,42],[50,90]],
    3:[[26,36],[50,66],[74,96]],
    4:[[32,44],[68,44],[32,88],[68,88]],
    5:[[30,42],[70,42],[50,66],[30,90],[70,90]],
    6:[[32,38],[68,38],[32,66],[68,66],[32,94],[68,94]],
    7:[[28,28],[50,44],[72,60],[32,86],[68,86],[32,112],[68,112]],
    8:[[34,26],[66,26],[34,52],[66,52],[34,78],[66,78],[34,104],[66,104]],
    9:[[26,32],[50,32],[74,32],[26,66],[50,66],[74,66],[26,100],[50,100],[74,100]]
  };
  const PIN_C={
    2:"ug", 3:"urg", 4:"uggu", 5:"ugrgu", 6:"ggrrrr", 7:"gggrrrr", 8:"uuuuuuuu", 9:"uuurrrggg"
  };
  const PIN_R={ 2:18, 3:16, 4:16, 5:14, 6:13, 7:11.5, 8:11.5, 9:12 };
  const CLS={ u:CU, r:CR, g:CG };
  /* 一筒 = 花輪:真牌上是一朵花(綠色花瓣環 + 紅心),不是同心圓。
     v1.54.0 畫成同心圓,結果一筒和二筒的單顆看起來只差大小,是整副牌裡最難認的一張。 */
  function pinOne(){
    let out='<circle class="mj-cg" cx="50" cy="66" r="32"/>'+
            '<circle class="mj-hole" cx="50" cy="66" r="27"/>';
    for(let k=0;k<12;k++){
      const a=k*Math.PI/6;
      out+='<circle class="mj-cg" cx="'+(50+Math.sin(a)*21).toFixed(1)+
           '" cy="'+(66-Math.cos(a)*21).toFixed(1)+'" r="5.4"/>';
    }
    // 紅心要夠大才看得到 —— 第一版 r=12 配 r=3.2 的十字,44px 下整朵看起來像綠齒輪
    return out+'<circle class="mj-hole" cx="50" cy="66" r="16.5"/>'+
               '<circle class="mj-cr" cx="50" cy="66" r="14"/>'+
               '<rect class="mj-hole" x="48.6" y="53" width="2.8" height="26"/>'+
               '<rect class="mj-hole" x="37" y="64.6" width="26" height="2.8"/>';
  }
  function pins(v){
    if(v===1) return pinOne();
    const cs=PIN_C[v]||"";
    return (PIN_P[v]||[]).map((p,k)=>pin(p[0],p[1],PIN_R[v],CLS[cs.charAt(k)]||CG)).join("");
  }

  // 條:一根竹子 = 圓角棒 + 兩道牌面色竹節(少了竹節就只是一根棒子,看不出是竹)
  function stick(x,y,w,h,c){
    const l=(x-w/2).toFixed(1), t=(y-h/2).toFixed(1);
    const nh=Math.max(1.6,h*0.05);
    return '<rect class="'+c+'" x="'+l+'" y="'+t+'" width="'+w+'" height="'+h+'" rx="'+(w*0.45).toFixed(1)+'"/>'+
           '<rect class="mj-hole" x="'+l+'" y="'+(y-h/6-nh/2).toFixed(1)+'" width="'+w+'" height="'+nh.toFixed(1)+'"/>'+
           '<rect class="mj-hole" x="'+l+'" y="'+(y+h/6-nh/2).toFixed(1)+'" width="'+w+'" height="'+nh.toFixed(1)+'"/>';
  }
  /* 斜放的竹子(只有八索用):畫一根豎的再整組旋轉 —— 直接算斜矩形的四個角會連竹節
     一起要重算,而竹節是「看得出是竹子」的關鍵。
     rotate 角度:SVG 的 rotate(a) 把 (0,1) 轉到 (−sin a, cos a),要它等於方向向量
     → a = atan2(−dx, dy)(度)。 */
  function slant(x1,y1,x2,y2,w,c){
    const dx=x2-x1, dy=y2-y1;
    const len=Math.sqrt(dx*dx+dy*dy);
    const a=Math.atan2(-dx,dy)*180/Math.PI;
    return '<g transform="translate('+((x1+x2)/2).toFixed(1)+','+((y1+y2)/2).toFixed(1)+') rotate('+a.toFixed(1)+')">'+
           stick(0,0,w,len,c)+'</g>';
  }
  const BAM={
    2:{ w:17, h:46, p:[[50,40],[50,92]] },
    3:{ w:15, h:44, p:[[50,36],[34,92],[66,92]] },
    4:{ w:15, h:46, p:[[33,42],[67,42],[33,92],[67,92]] },
    5:{ w:13, h:38, p:[[31,34],[69,34],[50,66],[31,98],[69,98]] },
    6:{ w:13, h:48, p:[[28,40],[50,40],[72,40],[28,94],[50,94],[72,94]] },
    7:{ w:12, h:34, p:[[50,24],[28,66],[50,66],[72,66],[28,106],[50,106],[72,106]] },
    9:{ w:12, h:32, p:[[28,30],[50,30],[72,30],[28,66],[50,66],[72,66],[28,102],[50,102],[72,102]] }
  };
  /* 條子的配色(對應 BAM[v].p 的同一個索引):二~六索全綠、
     七索**上面那一根是紅的**、下面六根中間一欄藍、九索三欄各一色(藍紅綠)。
     八索不在這裡 —— 它是上下兩組「直竹 + 尖角」,全綠。 */
  const BAM_C={
    2:"gg", 3:"ggg", 4:"gggg", 5:"ggrgg", 6:"gggggg", 7:"rguggug", 9:"ugrugrugr"
  };
  /* 一條 = 雀鳥(真牌就是一隻鳥,少了它整副牌就沒那個味道)。眼睛是紅的。
     刻意只用五塊、每塊都畫得粗 —— 30px 寬的牌上,細節一律糊成一團。 */
  function bird(){
    return '<polygon class="mj-cg" points="34,84 8,124 41,101"/>'+
           '<ellipse class="mj-cg" cx="47" cy="74" rx="21" ry="25"/>'+
           '<circle class="mj-cg" cx="62" cy="38" r="14"/>'+
           '<polygon class="mj-cr" points="74,31 93,40 74,46"/>'+
           '<circle class="mj-hole" cx="66" cy="34" r="4.2"/>'+
           '<circle class="mj-cr" cx="66" cy="34" r="2.6"/>'+
           '<path class="mj-wing" d="M38 60 Q53 74 43 93"/>';
  }
  /* 八索 = 上下各一組「兩根直竹 + 中間兩根斜竹的尖角」,上組尖角朝上(看起來是**反過來的 M**)、
     下組尖角朝下(正的 M)。
     ⚠ v1.55.0~v1.57.0 畫成四根斜竹連成鋸齒 = 英文字母 W 疊 M,外側那兩根該**直立**的變成斜的,
       上半就直接讀成一個「W」。真牌(對過 Unicode U+1F017 的字型牌面)外側是直的,
       只有中間兩根斜。
     尖角兩根刻意共用同一個頂點、讓端點互相疊住 —— 不疊的話圓角端會變成「兩根手指碰在一起」。
     斜竹的外側端點刻意剛好碰到直竹的端點(x=30/70 對 x=19/81,兩者邊緣差不到半個單位)——
     真牌上這裡是連著的,留一道縫的話 30px 下就讀不出「M」而變成四根散竹。
     ⚠ 疊在端點才安全:竹節(mj-hole)畫在每根的 ±h/6 處、離端點很遠,疊到也不會被挖出白痕。 */
  function bam8(){
    let out="";
    // 上組(y 9~59):直 ∧ 直
    out+=stick(19,34,11,50,CG)+stick(81,34,11,50,CG);
    out+=slant(50,9,30,59,11,CG)+slant(50,9,70,59,11,CG);
    // 下組(y 73~123):直 ∨ 直(= 上組上下翻)
    out+=stick(19,98,11,50,CG)+stick(81,98,11,50,CG);
    out+=slant(30,73,50,123,11,CG)+slant(70,73,50,123,11,CG);
    return out;
  }
  function bams(v){
    if(v===1) return bird();
    if(v===8) return bam8();
    const b=BAM[v]; if(!b) return "";
    const cs=BAM_C[v]||"";
    return b.p.map((p,k)=>stick(p[0],p[1],b.w,b.h,CLS[cs.charAt(k)]||CG)).join("");
  }

  // 字:dominant-baseline 交給 CSS(.mj-t),這裡只給字級與中心點
  function chr(t,size,y,cls,x){
    return '<text class="mj-t'+(cls?" "+cls:"")+'" x="'+(x===undefined?50:x)+'" y="'+y+
           '" font-size="'+size+'">'+t+'</text>';
  }
  /* 白板:真牌上是一個藍色雙框 + 四角切線(不是寫「白」)。
     整副牌裡唯一「空的」那張,最好認。 */
  function white(){
    return '<rect class="mj-frm" x="21" y="30" width="58" height="72" rx="8"/>'+
           '<rect class="mj-frn" x="30" y="40" width="40" height="52" rx="3"/>'+
           '<path class="mj-frn" d="M30 49l9-9M61 40l9 9M30 83l9 9M61 92l9-9"/>';
  }
  /* 花牌的小圖案。⚠ 刻意**不照真牌按植物配**(真牌上梅與冬都是紅梅花、蘭與春都是粉花)——
     那會讓兩張長得幾乎一樣的牌在消消樂裡**配不起來**,玩家一定以為是 bug。
     現在:**圖案分兩類、顏色 8 種各異**(顏色設在牌的 color,依 data-suit="ha".."pd")。
     顏色是 30px 下最快的線索,圖案類別 + 大字再各補一層。 */
  function chrysanth(){          // 菊:輻射花瓣(每片都是繞著花心轉過去的同一個小長條)
    let out="";
    for(let k=0;k<12;k++)
      out+='<rect x="30.4" y="15" width="3.2" height="15" rx="1.6" fill="currentColor" '+
           'transform="rotate('+(k*30)+' 32 32)"/>';
    return out+'<circle cx="32" cy="32" r="9" fill="currentColor"/>'+
               '<circle class="mj-hole" cx="32" cy="32" r="3.4"/>';
  }
  function plum(){               // 梅:五個圓瓣 + 花心
    let out="";
    for(let k=0;k<5;k++){
      const a=k*2*Math.PI/5;
      out+='<circle cx="'+(32+Math.sin(a)*11).toFixed(1)+'" cy="'+(32-Math.cos(a)*11).toFixed(1)+
           '" r="8.2" fill="currentColor"/>';
    }
    return out+'<circle class="mj-hole" cx="32" cy="32" r="4.6"/>';
  }

  function draw(code){
    if(code==="jb") return white();
    const s=code.charAt(0), v=+code.charAt(1);
    if(s==="d") return pins(v);
    if(s==="b") return bams(v);
    // 萬:上面藍色漢字數字、下面紅「萬」,和實體牌一致
    if(s==="w") return chr(NUM[v-1]||"一",46,40,CU)+chr("萬",42,97,CR);
    const f=info(code);
    // 花牌:圖案(左上)+ 單字(右下)+ 細框。真牌的花牌也有一圈框,同時和字牌區隔開。
    if(s==="h"||s==="p")
      return '<rect class="mj-frn" x="12" y="10" width="76" height="112" rx="10"/>'+
             (s==="h"?chrysanth():plum())+chr(f.glyph,46,88,"",60);
    return chr(f.glyph,64,66);          // 東南西北 / 中 / 發
  }

  function faceHTML(code){
    return svgCache[code] ||
      (svgCache[code]='<svg class="mj-svg" viewBox="0 0 100 132" aria-hidden="true">'+draw(code)+'</svg>');
  }

  /* ---------- 牌背(v1.58.0,台灣 16 張才需要) ----------
     消消樂全部的牌都是正面朝上,不需要背面;真麻將要畫別人的手牌與牌山。
     設計刻意**和任何一張正面都不像**:滿版底色 + 內凹雙框 + 中央菱形。
     顏色走 --mj-back,不用 currentColor —— 牌背不該跟著花色變。 */
  let backCache=null;
  function backHTML(){
    return backCache || (backCache =
      '<svg class="mj-svg" viewBox="0 0 100 132" aria-hidden="true">'+
        '<rect class="mj-bk" x="0" y="0" width="100" height="132" rx="12"/>'+
        '<rect class="mj-bkl" x="11" y="14" width="78" height="104" rx="8"/>'+
        '<path class="mj-bkl" d="M50 44 L72 66 L50 88 L28 66 Z"/>'+
      '</svg>');
  }

  return { faceHTML, backHTML, info,
           glyphOf: c=>info(c).glyph, clsOf: c=>info(c).cls, nameOf: c=>info(c).name };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = MJFace;

"use strict";

/* ============================================================================
   麻將消牌 — 盤面引擎(MB):牌面自繪 / 立體堆疊 / 選牌配對 / 高亮 / 提示
   對外只暴露 MB;不碰 Firebase 也不碰 adapter,單機與連線共用同一支。

   設計要點:
   • **牌面不用 Unicode 麻將字元(U+1F000 那一段)**。只有 🀄 有 emoji 呈現,其餘 43 個是
     文字呈現 —— Android 覆蓋率不保證(缺字就是豆腐框),而且字級、對齊、花色顏色全部
     由系統字型決定,控不了。
   • **改成一張牌一個 SVG 自繪圖案**(v1.54.0):筒是同心圓、條是竹節棒(一條是雀鳥)、
     萬是漢字數字 + 紅「萬」、白板是藍框。之前是「大字 + 花色小字」(5 + 筒),
     字是對的但沒有麻將的樣子 —— 而數字牌(筒/條)在真牌上本來就是圖案不是數字。
     字牌與花牌維持單字,因為真牌上那幾張就是字。
   • **數字牌改成傳統三色**(v1.55.0):真麻將牌的筒與條不是單色的 —— 三筒是藍紅綠斜排、
     六筒上排綠下四紅、九索三欄各一色、七索上面那一根是紅的…… 這些配色是牌的一部分,
     少了它就只是「幾個圈圈」。萬子的數字是藍的、只有「萬」是紅的,「五」寫作「伍」。
     一筒改成花輪(真牌上是一朵花不是同心圓)、八索改成 W/M 兩組斜竹、白板加四角切線。
   • **位置全部用 CSS calc + 每張牌的 --c/--r/--l**,JS 只寫一個 --mjw(牌寬)。
     轉向 / 換難度 / 視窗縮放都只要改那一個變數,不必重寫 144 個 inline style。
   • 立體感:上層往左上位移,下層往右下 → 用 (lmax − l) 當位移倍數,這樣最上層貼齊
     左上角,整盤的外框大小才好算(見 fit())。
   • z-index 必須「層 → 列 → 行」遞增:上層要蓋住下層,同層右下角的立體邊要蓋住左上角。

   ⚠ $ 定義在 js/shared/ui-kit.js,本檔不可再宣告。
   ========================================================================== */

const MB = (function(){
  // 牌的幾何比例與牌寬夾限全部在 MGen.GEO / MGen.tileW(pickShape 用同一組,才會挑對形狀)
  let level="m72", shape="wide", S=null, tiles=[], alive=null;
  let els=[], sel=-1, enabled=false, hintPair=null, hintT=null;
  let stage=null, box=null, ro=null, lastW=null;
  let zoneEl=null, sweepEl=null;                  // 僵局的探照燈欄帶 / 過場光帶(見 showZone / flash)
  let cbPair=null, cbBlocked=null;
  /* 同款高亮預設**關閉**(v1.55.0)。選一張牌就把同款的其他牌全部框亮 = 直接把答案指出來,
     這遊戲的難點本來就是「該挑哪一對」。想要輔助的人自己去設定裡開(mahjong.prefs.v1)。 */
  let sameHint=false;

  /* ==========================================================================
     牌面自繪:一張牌一個 SVG,viewBox 固定 0 0 100 132(= 1 : GEO.ratio)
     ★ 顏色分兩套,界線很清楚:
       • **數字牌(萬/條/筒)用明確的三色 class**(mj-cu 藍 / mj-cr 紅 / mj-cg 綠)——
         真麻將牌上這些配色是固定的、是牌的一部分(三筒藍紅綠斜排、九索三欄各一色、
         七索上面那一根是紅的),不該跟著主題變。
       • **字牌與花牌用 currentColor**,花色設在 .mj-tile 的 color 上(CSS 依 data-suit)——
         東南西北 / 中 / 發 / 白 / 花的顏色是我們自己配的辨識色,要跟著主題走。
       ⚠ .mj-t 已經有 fill:currentColor (0,1,0),同級的 .mj-cu 靠 source order 不保險 ——
         CSS 那邊一定要另外寫 .mj-t.mj-cu 這種兩層的(同 v1.49.0 .mvc-open 的坑)。
     ★ 座標寫死在 viewBox 座標系裡,牌實際多大由 CSS 的 --mjw 決定,這裡不必知道。
     ★ 42 種牌面各只算一次就快取:144 張的盤面重洗時是 144 次 innerHTML,
       字串重算純屬浪費(而且每張牌的同一種花色長得一模一樣)。
     ★ 一切都畫得粗:30px 寬的牌上,細節一律糊成一團 —— 寧可少幾塊、每塊大一點。
     ========================================================================== */
  // 「五」寫作「伍」:實體萬子牌上就是大寫的伍(照 970 那張花色表)
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
     PIN_C 是**對應 PIN_P 同一個索引**的顏色,照 970 那張花色表逐張對過:
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
     八索不在這裡 —— 它是 W/M 兩組斜竹,全綠。 */
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
  /* 八索 = 上下兩組斜竹排成 W 和 M(真牌就是這個樣子,970 那張表也是)。
     四段一組,轉折點刻意拉開 —— 縮到 30px 時只剩輪廓,而輪廓正是這張牌的辨識點。 */
  function bam8(){
    const W=[[13,12],[33,58],[50,16],[67,58],[87,12]];   // W:上半
    const M=[[13,120],[33,74],[50,116],[67,74],[87,120]];// M:下半(= W 上下翻)
    let out="";
    for(let k=0;k<4;k++) out+=slant(W[k][0],W[k][1],W[k+1][0],W[k+1][1],11,CG);
    for(let k=0;k<4;k++) out+=slant(M[k][0],M[k][1],M[k+1][0],M[k+1][1],11,CG);
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
     整副牌裡唯一「空的」那張,最好認 —— 四角切線是 v1.55.0 照 970 那張表補的。 */
  function white(){
    return '<rect class="mj-frm" x="21" y="30" width="58" height="72" rx="8"/>'+
           '<rect class="mj-frn" x="30" y="40" width="40" height="52" rx="3"/>'+
           '<path class="mj-frn" d="M30 49l9-9M61 40l9 9M30 83l9 9M61 92l9-9"/>';
  }
  /* 花牌的小圖案。⚠ 刻意**不照真牌按植物配**(真牌上梅與冬都是紅梅花、蘭與春都是粉花)——
     那會讓兩張長得幾乎一樣的牌**配不起來**(v1.56.0 起只有完全同款才能消),玩家一定以為是 bug。
     ★ v1.55.0 是「按群走」(春夏秋冬一律菊形、梅蘭竹菊一律梅形),那時同群可配所以說得通;
       嚴格同款之後那樣反而最糟 —— 四張同色同圖案的牌互相消不掉。
     現在:**圖案分兩類、顏色 8 種各異**(顏色設在 .mj-tile 的 color,依 data-suit="ha".."pd")。
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
    const f=MGen.faceOf(code);
    // 花牌:圖案(左上)+ 單字(右下)+ 細框。真牌的花牌也有一圈框,同時和字牌區隔開。
    // 顏色由 data-suit 給(8 種各一色),這裡只決定形狀:四季用菊形、四君子用梅形
    if(s==="h"||s==="p")
      return '<rect class="mj-frn" x="12" y="10" width="76" height="112" rx="10"/>'+
             (s==="h"?chrysanth():plum())+chr(f.glyph,46,88,"",60);
    return chr(f.glyph,64,66);          // 東南西北 / 中 / 發
  }
  function faceHTML(code){
    return svgCache[code] ||
      (svgCache[code]='<svg class="mj-svg" viewBox="0 0 100 132" aria-hidden="true">'+draw(code)+'</svg>');
  }

  /* ---------- 建立 ---------- */
  function init(o){
    o=o||{};
    cbPair=o.onPair||null; cbBlocked=o.onBlocked||null;
    stage=$("mjStage"); box=$("mjBoardBox");
    // 盤面大小綁「實際剩餘可視高度」,不用寫死常數(Bingo v1.36.0 的教訓:
    // 常數方案在矮螢幕/多人時必然溢出)。ResizeObserver 比 resize 事件準 ——
    // 收合房間橫幅、HUD 換行都不會觸發 window resize,但會改變這一格的高度。
    if(box && window.ResizeObserver && !ro){
      ro=new ResizeObserver(()=>fit());
      ro.observe(box);
    }
    addEventListener("orientationchange",()=>setTimeout(fit,180));
  }

  /* ---------- 一局的開始 ---------- */
  /* q = { level, shape, tiles }(tiles 可以是陣列或 288 字元的字串)
     ★ shape 一定要跟著題目來,**不可以在這裡自己重算一次** —— 連線是全房共用一份 tiles +
       格位索引,誰的視窗比例不同就會挑到不同佈局 → 整盤錯位。同理,遊戲中途轉向也不換形狀
       (換形狀等於重排整個盤面,會把進行中的局毀掉);轉向由 fit() 縮放應付。 */
  function setBoard(q){
    level=MGen.LEVELS[q.level]?q.level:"m72";
    shape=MGen.shapeOf(q.shape);
    S=MGen.slotsOf(level,shape);
    tiles=Array.isArray(q.tiles)?q.tiles.slice():MGen.parse(q.tiles||"");
    alive=new Uint8Array(S.list.length).fill(1);
    sel=-1; hintPair=null;
    build();
    fit();
    repaint();
  }
  // 重洗:格位存活狀態不動,只換牌面
  function setTiles(nt){
    tiles=Array.isArray(nt)?nt.slice():MGen.parse(nt||"");
    sel=-1; hintPair=null;
    clearZone();                  // 牌全換過了,舊的探照燈框指的位置已經沒有意義
    paintFaces();
    repaint();
  }

  function build(){
    if(!stage)return;
    stage.innerHTML="";
    zoneEl=null; sweepEl=null;              // 上面那行已經把它們從樹上拔掉,指標也要跟著放掉
    stage.classList.remove("done");
    const L=MGen.geoOf(level,shape);
    stage.style.setProperty("--cols",String(L.cols));
    stage.style.setProperty("--rows",String(L.rows));
    stage.style.setProperty("--lmax",String(L.layers-1));
    els=[];
    S.list.forEach((s,i)=>{
      const el=document.createElement("button");
      el.type="button";
      el.className="mj-tile";
      el.dataset.i=i;
      el.style.setProperty("--c",String(s.c));
      el.style.setProperty("--r",String(s.r));
      el.style.setProperty("--l",String(s.l));
      // 層 → 列 → 行 遞增:上層蓋下層,同層右下蓋左上(立體邊才不會被切掉)
      el.style.zIndex=String((s.l*(L.rows+1)+s.r)*(L.cols+1)+s.c+1);
      el.addEventListener("click",()=>tap(i));
      stage.appendChild(el);
      els.push(el);
    });
    paintFaces();
  }
  function paintFaces(){
    els.forEach((el,i)=>{
      const code=tiles[i]||"w1", f=MGen.faceOf(code);
      el.innerHTML=faceHTML(code);
      // 字牌 / 花牌的花色 → CSS 給 color,它們 SVG 裡的 currentColor 就跟著變。
      // 萬 / 條 / 筒不靠這個(每個圖形自己帶三色 class),這裡仍然寫上是為了 e2e 與除錯好認
      el.dataset.suit=f.cls;
      el.setAttribute("aria-label",f.name);
    });
  }

  /* ---------- 尺寸:一眼看完,絕不上下捲 ----------
     牌寬同時被「寬度放得下 cols 欄」與「高度放得下 rows 列」夾住,取小的那個。
     ⚠ 門檻比較的初值用 null 不用 -1 —— 算出 0(容器還沒有尺寸)會被 -1 誤判成「有變」
        或反過來把真正的第一次寫入吃掉,Bingo v1.36.0 踩過同一個坑。 */
  function fit(){
    if(!stage||!box||!S)return;
    const w=box.clientWidth, h=box.clientHeight;
    if(w<=0||h<=0)return;
    // 夾限與公式都在 MGen.tileW 裡(pickShape 用同一支,兩邊才不會給出不同答案)
    let tw=MGen.tileW(MGen.geoOf(level,shape), w, h);
    tw=Math.floor(tw*10)/10;
    if(lastW!==null && Math.abs(tw-lastW)<0.4) return;   // 抖動門檻:差不到 0.4px 不重寫
    lastW=tw;
    stage.style.setProperty("--mjw",tw+"px");
  }

  /* ---------- 操作 ---------- */
  function freeAt(i){ return !!alive[i] && MGen.isFree(S,alive,i); }

  function tap(i){
    if(!enabled)return;
    if(!alive[i])return;
    if(!freeAt(i)){
      // 講清楚是哪一種擋住 —— 「被壓住」和「兩邊都有牌」的解法完全不同
      const u=S.up[i];
      const why=(u>=0&&alive[u]) ? "這張被上面壓住了" : "左右都有牌,抽不出來";
      shake(i);
      if(cbBlocked) cbBlocked(i,why); else showToast(why,1000);
      return;
    }
    clearHint();
    if(sel===i){ sel=-1; Sound.unmark(); repaint(); return; }   // 再點一次 = 取消選取
    if(sel<0){ sel=i; Sound.mark(); repaint(); return; }
    if(MGen.matches(tiles[sel],tiles[i])){
      const a=sel; sel=-1;
      if(cbPair) cbPair(a,i);
      return;
    }
    // 配不起來:直接把選取換到新的這張(比「跳錯誤訊息再要人重點一次」順手)
    sel=i; Sound.unmark(); shake(i); repaint();
  }

  function shake(i){
    const el=els[i]; if(!el)return;
    el.classList.remove("bad"); void el.offsetWidth; el.classList.add("bad");
    setTimeout(()=>el.classList.remove("bad"),420);
  }

  /* 消掉一對。cls 是連線用的顏色(搶牌模式:短暫閃出是誰拿走的),單機不傳 */
  function remove(i,j,cls){
    if(!alive[i]||!alive[j])return false;
    [i,j].forEach(k=>{
      alive[k]=0;
      const el=els[k]; if(!el)return;
      el.className="mj-tile gone"+(cls?" "+cls:"");
      // 動畫跑完才真的收起來,不然會「啪」一下消失,看不出是哪兩張被拿走
      setTimeout(()=>{ if(!alive[k]) el.classList.add("off"); },260);
    });
    if(sel===i||sel===j) sel=-1;
    clearHint();
    clearZone();          // 有人消掉了 = 僵局解除,探照燈在這裡收掉,adapter 不必自己記得
    repaint();
    return true;
  }

  /* ---------- 提示 / 死局 ---------- */
  function moves(){ return S?MGen.movesOf(S,alive,tiles):[]; }
  function movesLeft(){ return moves().length; }
  function anyMove(){ return movesLeft()>0; }
  // 提示挑「層數最高」的那一組:清上層才會解鎖下面的牌,對玩家比較有用
  function bestPair(){
    const mv=moves(); if(!mv.length)return null;
    let best=null, bl=-1;
    mv.forEach(m=>{
      const l=Math.max(S.list[m[0]].l,S.list[m[1]].l);
      if(l>bl){ bl=l; best=m; }
    });
    return best;
  }
  function showHint(){
    const p=bestPair(); if(!p)return null;
    clearHint();
    hintPair=p; repaint();
    hintT=setTimeout(()=>{ hintPair=null; repaint(); },2600);
    return p;
  }
  function clearHint(){
    if(hintT){ clearTimeout(hintT); hintT=null; }
    if(hintPair){ hintPair=null; }
  }

  /* ---------- 僵局的兩件視覺(v1.57.0;目前只有連線在用)----------
     ★ 兩者都是 pointer-events:none 的覆蓋層,**刻意不做成蓋板** —— 搶牌是全房同時比手速,
       誰的畫面被遮住誰吃虧;而遮住的那一瞬間別人剛好消掉一對,感受就是「我被搶了」。
     ★ 兩者都掛在 .mj-stage 裡面。stage 自己是 stacking context(z-index:0),所以這裡的
       z-index 再大也只在盤面內部比大小,不會跑到根層去跟蓋板 / 彩帶 / toast 打架
       —— 那正是 v1.56.0「確認框上面浮著幾張麻將牌」那個坑。 */

  /* 探照燈:把「有解的那一對」所在的**欄帶**框起來,不指出是哪兩張。
     這是刻意的強度選擇 —— 直接框亮一組(showHint 那種)等於把答案送出去,而這遊戲的難點
     本來就是「該挑哪一對」(同「只給可消組數、不給是哪幾組」的原則)。
     挑**欄距最小**的那一組:跨到左右兩端的那種框起來等於沒縮小範圍。 */
  function zoneCols(){
    const mv=moves(); if(!mv.length)return null;
    let best=null, bw=1e9;
    mv.forEach(m=>{
      const a=S.list[m[0]], b=S.list[m[1]];
      const lo=Math.min(a.c,b.c), hi=Math.max(a.c,b.c);
      if(hi-lo<bw){ bw=hi-lo; best=[lo,hi]; }
    });
    return best;
  }
  function showZone(){
    if(!stage||!S)return false;
    const z=zoneCols(); if(!z)return false;
    const L=MGen.geoOf(level,shape);
    // 左右各放寬一欄:框得剛好貼著那兩張,就等於直接把答案圈出來了
    const c0=Math.max(0,z[0]-1), c1=Math.min(L.cols-1,z[1]+1);
    if(!zoneEl){
      zoneEl=document.createElement("div");
      zoneEl.className="mj-zone";
      stage.appendChild(zoneEl);
    }
    // 位置一律交給 CSS(同每張牌的做法):這裡只寫欄號,--mjw 一變框自己跟著縮
    zoneEl.style.setProperty("--z0",String(c0));
    zoneEl.style.setProperty("--z1",String(c1+1));
    return true;
  }
  function clearZone(){
    if(zoneEl && zoneEl.parentNode) zoneEl.parentNode.removeChild(zoneEl);
    zoneEl=null;
  }

  /* 過場:一道光帶橫掃盤面(+ 可選的中央一行字),約 1.2 秒後自己收掉。
     除了「把靜止的畫面推一把」,它還有一個實用目的:**重洗時遮掩換牌** ——
     整盤無預警變樣很突兀(v1.54.0 為此加了 0.9 秒延遲提示),光帶掃過再換才像真的洗過。
     ★ 重洗那一趟刻意**不帶字**:「盤面已重洗」那句話既有的 toast 已經在講,
       兩個地方同時跳同一句只是吵。 */
  function flash(text){
    if(!stage)return;
    if(sweepEl && sweepEl.parentNode) sweepEl.parentNode.removeChild(sweepEl);
    const el=document.createElement("div");
    el.className="mj-sweep";
    const band=document.createElement("span"); band.className="mj-sweep-band";
    el.appendChild(band);
    if(text){
      const txt=document.createElement("span"); txt.className="mj-sweep-txt";
      txt.textContent=text;               // 永遠是自己的固定字串,用 textContent 就不必 esc
      el.appendChild(txt);
    }
    stage.appendChild(el);
    sweepEl=el;
    setTimeout(()=>{
      if(el.parentNode) el.parentNode.removeChild(el);
      if(sweepEl===el) sweepEl=null;
    },1250);
  }

  /* ---------- 畫面 ---------- */
  function repaint(){
    if(!S)return;
    const selG = sel>=0 ? MGen.grpOf(tiles[sel]) : null;
    for(let i=0;i<els.length;i++){
      const el=els[i]; if(!el)continue;
      if(!alive[i]) continue;                 // 已消掉的由 remove() 管,不要被重畫救回來
      let cls="mj-tile";
      const free=freeAt(i);
      if(!free) cls+=" blocked";
      if(i===sel) cls+=" sel";
      /* 同款高亮:選了一張之後,把「可動 且 同群」的其他牌標出來。
         ★ 預設關閉(v1.55.0)—— 這等於直接把答案指出來,而這遊戲的難點就是「該挑哪一對」。
           留成設定選項給需要輔助的人。只標可動的:標了壓在底下的那些等於叫人去點點不到的東西。 */
      else if(sameHint && selG && free && MGen.grpOf(tiles[i])===selG) cls+=" same";
      if(hintPair && (hintPair[0]===i||hintPair[1]===i)) cls+=" hintpair";
      el.className=cls;
    }
    paintCounters();
  }

  /* 剩餘張數與「可消組數」 —— 單機與連線共用同兩顆讀數,所以由盤面自己畫
     (資料在這裡,交給各自的 HUD 畫一定會有一邊忘記更新)。
     ★ 只給**數量**、不給是哪幾組:出題保證解得開,但玩家亂配是會走進死局的,
       這顆讀數是危險儀表;要消什麼仍然得自己掃(同數獨 v1.46.0 候選提示的原則)。 */
  function paintCounters(){
    const lf=$("mjLeft"); if(lf) lf.textContent="🀄 "+left();
    const mv=movesLeft();
    const mo=$("mjMoves");
    if(mo){
      mo.textContent="✦ "+mv;
      mo.classList.toggle("dead",mv===0);
      mo.title = mv===0 ? "沒有可以消的牌了 —— 會自動重洗" : "目前有 "+mv+" 組可以消(是哪幾組要自己找)";
    }
  }
  function markDone(){ if(stage) stage.classList.add("done"); }

  /* ---------- 查詢 ---------- */
  function left(){ let k=0; for(let i=0;i<alive.length;i++) if(alive[i])k++; return k; }
  function total(){ return S?S.list.length:0; }
  function cleared(){ return left()===0; }

  return {
    // faceHTML 暴露出來只為了 tools/t-mj-faces.html 能把 42 種牌面平鋪截圖比對
    //(「三筒中間那顆是不是紅的」這種事只有截圖看得出來,遊戲裡沒有入口一次看完 42 張)
    faceHTML,
    init, setBoard, setTiles, remove, fit, repaint, markDone,
    showHint, clearHint, bestPair, moves, movesLeft, anyMove,
    // 僵局用(v1.57.0):探照燈欄帶 + 過場光帶。目前只有 adapter 呼叫,單機不碰
    showZone, clearZone, flash,
    setEnabled(v){ enabled=!!v; if(stage) stage.classList.toggle("locked",!enabled); },
    // 同款高亮的開關(設定蓋板)。關掉時要立刻重畫 —— 不然當下已經框亮的那幾張會留在畫面上
    setSameHint(v){ sameHint=!!v; if(S) repaint(); },
    sameHint:()=>sameHint,
    clearSel(){ sel=-1; repaint(); },
    sel:()=>sel,
    level:()=>level,
    shape:()=>shape,
    tiles:()=>tiles.slice(),
    aliveArr:()=>alive?Uint8Array.from(alive):new Uint8Array(0),
    // 連線重建盤面用:直接套一份存活狀態(不放動畫,整盤一次到位)
    setAlive(a){
      if(!S)return;
      for(let i=0;i<alive.length;i++){
        const on=!!a[i];
        alive[i]=on?1:0;
        const el=els[i]; if(!el)continue;
        if(!on){ el.className="mj-tile gone off"; }
        else el.className="mj-tile";
      }
      sel=-1; clearHint(); clearZone(); repaint();
    },
    aliveAt:i=>!!alive[i],
    freeAt, left, total, cleared,
    tileAt:i=>tiles[i],
    nameAt:i=>MGen.faceOf(tiles[i]||"w1").name
  };
})();

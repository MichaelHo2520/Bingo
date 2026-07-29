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
   • **位置全部用 CSS calc + 每張牌的 --c/--r/--l**,JS 只寫一個 --mjw(牌寬)。
     轉向 / 換難度 / 視窗縮放都只要改那一個變數,不必重寫 144 個 inline style。
   • 立體感:上層往左上位移,下層往右下 → 用 (lmax − l) 當位移倍數,這樣最上層貼齊
     左上角,整盤的外框大小才好算(見 fit())。
   • z-index 必須「層 → 列 → 行」遞增:上層要蓋住下層,同層右下角的立體邊要蓋住左上角。

   ⚠ $ 定義在 js/shared/ui-kit.js,本檔不可再宣告。
   ========================================================================== */

const MB = (function(){
  const RATIO=1.32;     // 牌高 / 牌寬(接近實體麻將牌)
  const OFF=0.13;       // 每往上一層的位移(牌寬的幾倍)

  let level="m72", S=null, tiles=[], alive=null;
  let els=[], sel=-1, enabled=false, hintPair=null, hintT=null;
  let stage=null, box=null, ro=null, lastW=null;
  let cbPair=null, cbBlocked=null;

  /* ==========================================================================
     牌面自繪:一張牌一個 SVG,viewBox 固定 0 0 100 132(= 1 : RATIO)
     ★ 圖案顏色一律 currentColor,花色設在 .mj-tile 的 color 上(CSS 依 data-suit)——
       所以每個圖案都只是「單色 + 象牙白挖空(.mj-hole)」,換主題不用改一行 JS。
     ★ 座標寫死在 viewBox 座標系裡,牌實際多大由 CSS 的 --mjw 決定,這裡不必知道。
     ★ 42 種牌面各只算一次就快取:144 張的盤面重洗時是 144 次 innerHTML,
       字串重算純屬浪費(而且每張牌的同一種花色長得一模一樣)。
     ========================================================================== */
  const NUM=["一","二","三","四","五","六","七","八","九"];
  const svgCache={};

  // 筒:同心圓(外圈實心 → 白圈 → 中心點),真牌上的餅就是這個樣子
  function pin(x,y,r){
    return '<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="currentColor"/>'+
           '<circle class="mj-hole" cx="'+x+'" cy="'+y+'" r="'+(r*0.60).toFixed(1)+'"/>'+
           '<circle cx="'+x+'" cy="'+y+'" r="'+(r*0.28).toFixed(1)+'" fill="currentColor"/>';
  }
  /* 幾筒排在哪:照傳統排法(三筒斜著、七筒上三下四…),不是機械式的方格 */
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
  const PIN_R={ 2:18, 3:16, 4:16, 5:14, 6:13, 7:11.5, 8:11.5, 9:12 };
  function pins(v){
    // 一筒:真牌上是一個大同心圓,圈數比別的多
    if(v===1) return '<circle cx="50" cy="66" r="31" fill="currentColor"/>'+
                     '<circle class="mj-hole" cx="50" cy="66" r="25.5"/>'+
                     '<circle cx="50" cy="66" r="19.5" fill="currentColor"/>'+
                     '<circle class="mj-hole" cx="50" cy="66" r="13"/>'+
                     '<circle cx="50" cy="66" r="6.5" fill="currentColor"/>';
    return (PIN_P[v]||[]).map(p=>pin(p[0],p[1],PIN_R[v])).join("");
  }

  // 條:一根竹子 = 圓角棒 + 兩道白色竹節(少了竹節就只是一根棒子,看不出是竹)
  function stick(x,y,w,h){
    const l=(x-w/2).toFixed(1), t=(y-h/2).toFixed(1);
    const nh=Math.max(1.6,h*0.05);
    return '<rect x="'+l+'" y="'+t+'" width="'+w+'" height="'+h+'" rx="'+(w*0.45).toFixed(1)+'" fill="currentColor"/>'+
           '<rect class="mj-hole" x="'+l+'" y="'+(y-h/6-nh/2).toFixed(1)+'" width="'+w+'" height="'+nh.toFixed(1)+'"/>'+
           '<rect class="mj-hole" x="'+l+'" y="'+(y+h/6-nh/2).toFixed(1)+'" width="'+w+'" height="'+nh.toFixed(1)+'"/>';
  }
  const BAM={
    2:{ w:17, h:46, p:[[50,40],[50,92]] },
    3:{ w:15, h:44, p:[[50,36],[34,92],[66,92]] },
    4:{ w:15, h:46, p:[[33,42],[67,42],[33,92],[67,92]] },
    5:{ w:13, h:38, p:[[31,34],[69,34],[50,66],[31,98],[69,98]] },
    6:{ w:13, h:48, p:[[28,40],[50,40],[72,40],[28,94],[50,94],[72,94]] },
    7:{ w:12, h:34, p:[[50,24],[28,66],[50,66],[72,66],[28,106],[50,106],[72,106]] },
    8:{ w:12, h:34, p:[[38,24],[62,24],[28,66],[50,66],[72,66],[28,106],[50,106],[72,106]] },
    9:{ w:12, h:32, p:[[28,30],[50,30],[72,30],[28,66],[50,66],[72,66],[28,102],[50,102],[72,102]] }
  };
  /* 一條 = 雀鳥(真牌就是一隻鳥,少了它整副牌就沒那個味道)。
     刻意只用五塊、每塊都畫得粗 —— 30px 寬的牌上,細節一律糊成一團。 */
  function bird(){
    return '<polygon points="34,84 8,124 41,101" fill="currentColor"/>'+
           '<ellipse cx="47" cy="74" rx="21" ry="25" fill="currentColor"/>'+
           '<circle cx="62" cy="38" r="14" fill="currentColor"/>'+
           '<polygon points="74,31 93,40 74,46" fill="currentColor"/>'+
           '<circle class="mj-hole" cx="66" cy="34" r="3.4"/>'+
           '<path class="mj-wing" d="M38 60 Q53 74 43 93"/>';
  }
  function bams(v){
    if(v===1) return bird();
    const b=BAM[v]; if(!b) return "";
    return b.p.map(p=>stick(p[0],p[1],b.w,b.h)).join("");
  }

  // 字:x 置中、dominant-baseline 交給 CSS(.mj-t),這裡只給字級與中心高度
  function chr(t,size,y,cls){
    return '<text class="mj-t'+(cls?" "+cls:"")+'" x="50" y="'+y+'" font-size="'+size+'">'+t+'</text>';
  }
  // 白板:真牌上是一個藍框(不是寫「白」)。整副牌裡唯一「空的」那張,最好認
  function white(){
    return '<rect class="mj-frm" x="21" y="30" width="58" height="72" rx="8"/>'+
           '<rect class="mj-frn" x="31" y="41" width="38" height="50" rx="5"/>';
  }

  function draw(code){
    if(code==="jb") return white();
    const s=code.charAt(0), v=+code.charAt(1);
    if(s==="d") return pins(v);
    if(s==="b") return bams(v);
    // 萬:上面漢字數字(墨色)、下面紅「萬」,和實體牌一致
    if(s==="w") return chr(NUM[v-1]||"一",46,42,"mj-ink")+chr("萬",42,96);
    const f=MGen.faceOf(code);
    // 花牌:單字 + 細框(真牌的花牌也有一圈框,同時和字牌區隔開)
    if(s==="h"||s==="p") return '<rect class="mj-frn" x="15" y="26" width="70" height="80" rx="11"/>'+chr(f.glyph,52,68);
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
  // q = { level, tiles }(tiles 可以是陣列或 288 字元的字串)
  function setBoard(q){
    level=MGen.LEVELS[q.level]?q.level:"m72";
    S=MGen.slotsOf(level);
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
    paintFaces();
    repaint();
  }

  function build(){
    if(!stage)return;
    stage.innerHTML="";
    stage.classList.remove("done");
    const L=MGen.levelOf(level);
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
      el.dataset.suit=f.cls;              // 花色 → CSS 給 color,SVG 裡的 currentColor 就跟著變
      el.setAttribute("aria-label",f.name);
    });
  }

  /* ---------- 尺寸:一眼看完,絕不上下捲 ----------
     牌寬同時被「寬度放得下 cols 欄」與「高度放得下 rows 列」夾住,取小的那個。
     ⚠ 門檻比較的初值用 null 不用 -1 —— 算出 0(容器還沒有尺寸)會被 -1 誤判成「有變」
        或反過來把真正的第一次寫入吃掉,Bingo v1.36.0 踩過同一個坑。 */
  function fit(){
    if(!stage||!box||!S)return;
    const L=MGen.levelOf(level);
    const spanX=L.cols + OFF*(L.layers-1);
    const spanY=RATIO*L.rows + OFF*(L.layers-1);
    const w=box.clientWidth, h=box.clientHeight;
    if(w<=0||h<=0)return;
    let tw=Math.min(w/spanX, h/spanY);
    tw=Math.max(18, Math.min(tw, 74));      // 下限 18px:再小就點不到;上限 74px 免得 36 牌在平板上變巨無霸
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
      // 同款高亮:選了一張之後,把「可動 且 同群」的其他牌標出來。
      // 只標可動的 —— 標了壓在底下的那些等於叫人去點點不到的東西
      else if(selG && free && MGen.grpOf(tiles[i])===selG) cls+=" same";
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
    init, setBoard, setTiles, remove, fit, repaint, markDone,
    showHint, clearHint, bestPair, moves, movesLeft, anyMove,
    setEnabled(v){ enabled=!!v; if(stage) stage.classList.toggle("locked",!enabled); },
    clearSel(){ sel=-1; repaint(); },
    sel:()=>sel,
    level:()=>level,
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
      sel=-1; clearHint(); repaint();
    },
    aliveAt:i=>!!alive[i],
    freeAt, left, total, cleared,
    tileAt:i=>tiles[i],
    nameAt:i=>MGen.faceOf(tiles[i]||"w1").name
  };
})();

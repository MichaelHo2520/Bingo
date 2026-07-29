"use strict";

/* ============================================================================
   麻將消牌 — 盤面引擎(MB):牌面自繪 / 立體堆疊 / 選牌配對 / 高亮 / 提示
   對外只暴露 MB;不碰 Firebase 也不碰 adapter,單機與連線共用同一支。

   設計要點:
   • **牌面不用 Unicode 麻將字元(U+1F000 那一段)**。只有 🀄 有 emoji 呈現,其餘 43 個是
     文字呈現 —— Android 覆蓋率不保證(缺字就是豆腐框),而且字級、對齊、花色顏色全部
     由系統字型決定,控不了。改成「大字 + 花色小字 + 顏色」自繪:所有用到的字
     (東南西北中發白春夏秋冬梅蘭竹菊萬條筒)任何 CJK 字型都有。
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
      el.innerHTML='<span class="mj-face"><span class="mj-g"></span><span class="mj-m"></span></span>';
      el.addEventListener("click",()=>tap(i));
      stage.appendChild(el);
      els.push(el);
    });
    paintFaces();
  }
  function paintFaces(){
    els.forEach((el,i)=>{
      const f=MGen.faceOf(tiles[i]||"w1");
      el.querySelector(".mj-g").textContent=f.glyph;
      el.querySelector(".mj-m").textContent=f.mark;
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
      mo.title = mv===0 ? "沒有可以消的牌了 —— 按「重洗」" : "目前有 "+mv+" 組可以消(是哪幾組要自己找)";
    }
    // 死局時讓「重洗」自己發亮:這時 UI 唯一該引導的就是它
    const sb=$("mjShuffleBtn");
    if(sb) sb.classList.toggle("urge", mv===0 && left()>0);
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

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
     一筒改成花輪(真牌上是一朵花不是同心圓)、八索改成上下兩組尖角竹(v1.57.1 修成真牌排法,
     見 bam8)、白板加四角切線。
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
  let comboEl=null, comboN=0, comboT=null, comboAt=0;   // 連擊(見 bumpCombo)
  let lastLeft=null, shufT=null;                  // 讀數彈跳的上一次值 / 重洗波浪的收尾
  let cbPair=null, cbBlocked=null;
  /* ---------- 動效 class 的白名單(v2.4.4)----------
     ★ repaint() 是**整行覆寫 className**,所以任何「掛一下就好」的動效 class 一律要
       登記在這裡,否則下一次 repaint 會把它拿掉。
     ⚠ 這不是預防性的規矩,是修一個真的 bug:`.bad`(配不起來的搖動)原本就掛在
       `shake(i); repaint();` 這個順序裡 → 加上又立刻被覆寫掉,**動畫一次都沒播過**,
       而三套 e2e 全綠(存在時間 0ms,斷言抓不到「該閃卻沒閃」)。
       同型的坑數獨那一批已經寫進 CLAUDE.md,這裡是第二次。 */
  const FX_CLS=["bad","blocker","fly","bump"];

  /* 同款高亮預設**關閉**(v1.55.0)。選一張牌就把同款的其他牌全部框亮 = 直接把答案指出來,
     這遊戲的難點本來就是「該挑哪一對」。想要輔助的人自己去設定裡開(mahjong.prefs.v1)。 */
  let sameHint=false;

  /* ==========================================================================
     牌面自繪 —— **已抽到 js/shared/mj-faces.js**(v1.58.0),兩頁共用。
     ★ 抽出的理由:台灣 16 張(mahjong16.html)要用同一套牌面,而這一段是**純視覺純函式**
       (回傳 SVG 字串,不碰盤面、不碰事件),沒有理由複製第二份。
     ★ 抽出時繪圖程式碼**一行都沒改**,守門就是 tools/t-mj-faces.html 的 42 種截圖
       必須與 v1.57.1 完全一致。
     ⚠ mahjong.html 的 <script> 要在 board.js **之前**載入 shared/mj-faces.js。
     ========================================================================== */
  // 保留這個名字當轉接:tools/t-mj-faces.html 讀的是 MB.faceHTML,抽出後不必改那一頁
  function faceHTML(code){ return MJFace.faceHTML(code); }

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
    resetCombo(); lastLeft=null;
    build();
    fit();
    repaint();
  }
  // 重洗:格位存活狀態不動,只換牌面
  function setTiles(nt){
    tiles=Array.isArray(nt)?nt.slice():MGen.parse(nt||"");
    sel=-1; hintPair=null;
    resetCombo();                 // 洗過牌就不是同一串了
    clearZone();                  // 牌全換過了,舊的探照燈框指的位置已經沒有意義
    /* ★ paintFaces() 一定要**同步**做完(v2.4.4 的重洗波浪刻意不延後換牌面):
       延後換面看起來比較像「翻面洗牌」,代價是那 150ms 內畫面上的牌面與 tiles 不一致 ——
       搶牌是全房同時點的,那等於請人去點一張顯示著舊牌面的牌。波浪只做位移,不動牌面。 */
    paintFaces();
    shufWave();
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
    const geo=MGen.geoOf(level,shape);
    let tw=MGen.tileW(geo, w, h);
    tw=Math.floor(tw*10)/10;
    /* ---------- 絨布桌的邊距(v2.4.4)----------
       ⚠⚠ 這一段是量出來的,不是設計出來的:桌面(.mj-stage::before)原本固定往外擴
          0.3 / 0.36 個牌寬 → 72 牌溢出 9px、144 牌溢出 6px,**捅出一條水平捲軸**。
          而捲軸一出現,這一支量到的 w/h 就變小 → 盤面縮一階 → 捲軸消失 → 又放大回來
          = **自己震盪**(跳棋與飛行棋都踩過這條,CLAUDE.md 有記;死區擋不住)。
       ★ 解法是「有多少空位就擴多少」,而不是回頭去縮盤面 —— **盤面大小的優先權高於裝飾**。
         夾住兩軸的剩餘空間之後就沒有回饋迴路了:桌面永遠擠不出捲軸,量到的 w/h 不會被它改。
       ★ 代價講清楚:手機直立玩 72 / 144 牌時盤面本來就吃滿寬度 → 邊距 0,
         桌面剛好貼齊盤面(看起來是牌底下的一塊暗色底,不是一張有邊的桌子)。
         寬螢幕與 36 牌才看得到桌邊。 */
    const sw=(geo.cols + MGen.GEO.off*(geo.layers-1))*tw;
    const sh=(MGen.GEO.ratio*geo.rows + MGen.GEO.off*(geo.layers-1))*tw;
    const pad=Math.max(0, Math.min(tw*0.3, (w-sw)/2, (h-sh)/2));
    stage.style.setProperty("--mjpad",pad.toFixed(1)+"px");
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
      /* 「被上面壓住了」那句話沒說是**哪一張**壓著 → 把那張也閃一下(v2.4.4)。
         這一條是資訊不是裝飾:在 30px 的牌上肉眼找「誰壓著誰」純粹是眼力刑求,
         而知道是哪一張,下一步就知道要先去消掉它。 */
      if(u>=0 && alive[u]) fxOn(u,"blocker",620);
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

  /* 掛一個動效 class,到時間自己收掉。
     ⚠ 這些 class 全部要在 FX_CLS 裡 —— 中間只要有人呼叫 repaint(),沒登記的就被覆寫掉。 */
  function fxOn(i,cls,ms){
    const el=els[i]; if(!el)return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(()=>{ if(el) el.classList.remove(cls); },ms);
  }
  function shake(i){ fxOn(i,"bad",420); }

  /* 一張牌的中心點,單位是「牌寬的幾倍」—— 與 CSS 的 left/top 完全同一套算式。
     ★ 刻意**不量 getBoundingClientRect()**:位置本來就是 --c/--r/--l + --mjw 算出來的,
       算格座標零成本;而且 rect 量到的是「動畫當下」的位置,會被 transform 汙染。 */
  function centerOf(i){
    const g=MGen.GEO, L=MGen.geoOf(level,shape), s=S.list[i];
    const push=(L.layers-1-s.l)*g.off;
    return { x:s.c+push+0.5, y:s.r*g.ratio+push+g.ratio/2 };
  }

  /* 消掉一對。cls 是連線用的顏色(搶牌模式:短暫閃出是誰拿走的),單機不傳。
     opt = { mine, quiet }:
     • mine=false → 這一手是別人消的(搶牌)→ 不算進我的連擊
     • quiet=true → 一次補很多筆(重連歸位 / 剛開打的批次同步)→ 不放爆光、不算連擊、不慶祝
       (同 adapter 對音效與 toast 的處理:那不是「剛剛發生的事」) */
  function remove(i,j,cls,opt){
    if(!alive[i]||!alive[j])return false;
    opt=opt||{};
    const quiet=!!opt.quiet, mine=opt.mine!==false;
    /* 兩張牌互相吸過去、在中點爆一圈光(v2.4.4)。
       原本是各自原地縮小淡出 —— 「剛才那兩張是一對」完全靠玩家自己記得,
       而這一頁沒有回合制,消掉是使用者唯一的回饋(notes/10 紅線 8)。 */
    const ca=centerOf(i), cb=centerOf(j);
    const mid={ x:(ca.x+cb.x)/2, y:(ca.y+cb.y)/2 };
    [[i,ca],[j,cb]].forEach(pr=>{
      const k=pr[0], c=pr[1];
      alive[k]=0;
      const el=els[k]; if(!el)return;
      // 位移量寫成「牌寬的幾倍」,CSS 再乘上 --mjw → 縮放 / 轉向都自己跟著對
      el.style.setProperty("--dx",(mid.x-c.x).toFixed(3));
      el.style.setProperty("--dy",(mid.y-c.y).toFixed(3));
      el.className="mj-tile gone fly"+(cls?" "+cls:"");
      // 動畫跑完才真的收起來,不然會「啪」一下消失,看不出是哪兩張被拿走
      setTimeout(()=>{ if(!alive[k]) el.classList.add("off"); },300);
    });
    if(!quiet) spark(mid,cls);
    if(sel===i||sel===j) sel=-1;
    clearHint();
    clearZone();          // 有人消掉了 = 僵局解除,探照燈在這裡收掉,adapter 不必自己記得
    if(!quiet && mine) bumpCombo();
    repaint();
    /* 清盤的金光只在這條路放 —— 批次重建走 setAlive(),那一刻「盤面空了」是別人在別的
       時間點做到的(重連歸位),慶祝一個沒發生在眼前的事看起來就是 bug。 */
    if(!quiet && !left()) cheer();
    return true;
  }

  /* 中點的爆光:一圈擴散 + 一顆亮心。搶牌模式染成那個人的座位色(cls = p0~p5)。
     位置同每張牌的做法 —— 只寫格座標,--mjw 一變它自己跟著縮。 */
  function spark(mid,cls){
    if(!stage)return;
    const el=document.createElement("span");
    el.className="mj-spark"+(cls?" "+cls:"");
    el.style.setProperty("--bx",mid.x.toFixed(3));
    el.style.setProperty("--by",mid.y.toFixed(3));
    stage.appendChild(el);
    setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); },640);
  }

  /* ---------- 連擊(v2.4.4)----------
     ★ 只算**自己**消掉的、而且是剛剛消的(搶牌模式別人那一手也會走 remove())。
     ⚠ 徽章刻意**不進 .mj-tools 的流**:那一列是 flex-wrap → 徽章一換行整列高一階 →
       .mj-boardbox 矮一階 → fit() 把牌縮小 → 徽章收掉又放大回來 = **自己震盪**
       (跳棋 / 飛行棋的捲軸震盪同構,CLAUDE.md 紅線有記)。所以它是 .mj-play 裡的
       absolute + pointer-events:none,一格版面都不佔。 */
  const COMBO_MS=2600;
  function bumpCombo(){
    const now=Date.now();
    comboN = (now-comboAt<=COMBO_MS) ? comboN+1 : 1;
    comboAt=now;
    if(comboN>=2) showCombo(comboN);
    if(comboT) clearTimeout(comboT);
    comboT=setTimeout(resetCombo,COMBO_MS);
  }
  function showCombo(n){
    // 錨在 .mj-boardbox(它 v2.4.4 加了 position:relative)—— 貼盤面下緣,而不是整塊 .mj-play 的底
    const host=$("mjBoardBox"); if(!host)return;
    if(!comboEl || !comboEl.parentNode){
      comboEl=document.createElement("div");
      comboEl.className="mj-combo";
      host.appendChild(comboEl);
    }
    comboEl.textContent="🔥 連擊 ×"+n;
    comboEl.classList.remove("on"); void comboEl.offsetWidth; comboEl.classList.add("on");
  }
  function resetCombo(){
    if(comboT){ clearTimeout(comboT); comboT=null; }
    comboN=0; comboAt=0;
    if(comboEl) comboEl.classList.remove("on");
  }

  /* 重洗的波浪(v2.4.4):每一張牌依**欄號**晚一點起跑,由左往右漣漪過去一次。
     ★ 延遲寫在 CSS(calc(var(--c) * .028s)),JS 只掛一個 class —— 144 張牌不可以各排一個 timeout。
     ★ 方向與既有的光帶(.mj-sweep,左→右)刻意一致:兩件事要看起來是同一個動作。 */
  function shufWave(){
    if(!stage)return;
    stage.classList.remove("shuf"); void stage.offsetWidth; stage.classList.add("shuf");
    if(shufT) clearTimeout(shufT);
    shufT=setTimeout(()=>{ shufT=null; if(stage) stage.classList.remove("shuf"); },900);
  }

  /* 清盤:一圈金光從盤面中心擴散(v2.4.4)。三條都是台灣麻將 v2.4.0 那批換來的:
     ① 掛 **body** + fixed + z-index:61 —— #veil(結果卡)是 50 而且**立刻**蓋上來,
        掛在盤面裡等於做了看不到(盤面自己還是 z-index:0 的 stacking context);
     ② pointer-events:none 是**正確性不是禮貌** —— 它蓋在結果卡上面,
        少了它那 1.3 秒「再來一局 / 繼續」按不下去;
     ③ 中心點在這一刻量 rect(盤面位置隨版面、大盤面、轉向而變)。
     ★ 它不是「你贏了」的訊號(那是贏家的彩帶 burst()),是「桌面清空了」的句號 ——
       搶牌模式全房都會看到,而那一刻對每個人都成立。 */
  function cheer(){
    if(!stage)return;
    const r=stage.getBoundingClientRect();
    if(!r.width||!r.height)return;
    const el=document.createElement("div");
    el.className="mj-cheer";
    el.style.setProperty("--cx",Math.round(r.left+r.width/2)+"px");
    el.style.setProperty("--cy",Math.round(r.top+r.height/2)+"px");
    el.innerHTML='<span class="mj-ring"></span><span class="mj-ring r2"></span><span class="mj-glow"></span>';
    document.body.appendChild(el);
    setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); },1300);
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
      FX_CLS.forEach(f=>{ if(el.classList.contains(f)) cls+=" "+f; });   // 見 FX_CLS 的註解
      el.className=cls;
    }
    paintCounters();
  }

  /* 剩餘張數與「可消組數」 —— 單機與連線共用同兩顆讀數,所以由盤面自己畫
     (資料在這裡,交給各自的 HUD 畫一定會有一邊忘記更新)。
     ★ 只給**數量**、不給是哪幾組:出題保證解得開,但玩家亂配是會走進死局的,
       這顆讀數是危險儀表;要消什麼仍然得自己掃(同數獨 v1.46.0 候選提示的原則)。 */
  function paintCounters(){
    const lf=$("mjLeft"), n=left();
    if(lf){
      lf.textContent="🀄 "+n;
      /* 數字**真的變了**才彈(v2.4.4)。repaint() 一局會跑上百次(選取 / 取消 / 重畫都會),
         每次都彈就變成持續動畫 —— 而持續的東西一律不做動畫(讀數與音量條同一條原則)。 */
      if(lastLeft!==null && n!==lastLeft){
        lf.classList.remove("mj-bump"); void lf.offsetWidth; lf.classList.add("mj-bump");
        setTimeout(()=>lf.classList.remove("mj-bump"),240);
      }
      lastLeft=n;
    }
    const mv=movesLeft();
    const mo=$("mjMoves");
    if(mo){
      mo.textContent="✦ "+mv;
      mo.classList.toggle("dead",mv===0);
      // 只剩一組 = 下一步走岔就是死局(v2.4.4)。仍然**不說是哪一組** —— 同「只給數量」的原則
      mo.classList.toggle("mj-one",mv===1);
      mo.title = mv===0 ? "沒有可以消的牌了 —— 會自動重洗"
               : mv===1 ? "只剩 1 組可以消 —— 走岔就會死局(接著會自動重洗)"
               : "目前有 "+mv+" 組可以消(是哪幾組要自己找)";
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
    // 動效(v2.4.4):清盤金光由 remove() 自己觸發,暴露出來是為了 e2e 與截圖頁能單獨叫它;
    // combo 也只給測試讀(遊戲裡的入口是消掉一對)
    cheer, combo:()=>comboN,
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
    // upAt 只給測試用:「壓住 i 的那一格是誰」是 S 的內部索引,而 e2e 要驗
    //「點動不了的牌 → 壓住它的那張會閃」就非得指名那一格(v2.4.4)
    upAt:i=>(S?S.up[i]:-1),
    freeAt, left, total, cleared,
    tileAt:i=>tiles[i],
    nameAt:i=>MGen.faceOf(tiles[i]||"w1").name
  };
})();

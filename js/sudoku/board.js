"use strict";

/* ============================================================================
   數獨 — 盤面引擎(SB):渲染 / 選格 / 數字鍵盤 / 高亮 / 筆記 / 凍結
   對外只暴露 SB;不依賴 Firebase 也不依賴 adapter,單機與連線共用同一支。

   設計要點:
   • **不需要五子棋那套縮放平移** —— 9×9 在 350px 寬手機上每格約 36px,直接塞滿就好。
     盤面用 CSS grid + aspect-ratio,格子大小由 --sn(邊長)自動算,轉向也不必重算。
   • 宮的粗線不用 nth-child(bw/bh 會變),改在建格時掛 .rb / .bb 兩個 class。
   • 操作流程是「先點格子 → 再點數字」(手機唯一合理的做法);點同一個數字兩次 = 清除。
   • 高亮三層:選中格 / 同列同行同宮 / 同數字。少一層都會讓 9×9 在手機上很難掃描。

   ⚠ $ 定義在 js/shared/ui-kit.js,本檔不可再宣告。
   ========================================================================== */

const SB = (function(){
  let n=9, bw=3, bh=3;
  let puzzle=[], sol=[], vals=[], owners=[], notes=[];
  let cells=[], padBtns=[];
  let sel=-1, enabled=false, noteMode=false;
  let frozenUntil=0, freezeTick=null;
  let assist=false;                  // 候選提示(連線房主決定):選中的空格標出「有幾個數字可填」
  let cbPick=null, cbNum=null, cbErase=null;
  let board, pad, wrap;
  let fxLayer=null;                  // 動效覆蓋層:金色光波住這裡,絕不進 grid 的版面流
  let swept=new Set();               // 已經播過光波的行 / 列 / 宮(同一條只播一次)
  let frostAt=-1;                    // 這一次凍結是哪一格結的霜(解凍時在那一格碎冰)
  let claim=false;                   // 搶格才把「佔領暈染」打開(單機 / 競速全盤同一色,染了只是整片變糊)
  let gen=0;                         // 盤面世代:給跨局的延遲回呼認人(螺旋點亮排了一整秒的 setTimeout)

  /* ---------- 建立 ---------- */
  function init(o){
    o=o||{};
    cbPick=o.onPick||null; cbNum=o.onNum||null; cbErase=o.onErase||null;
    wrap=$("sdkStage"); board=$("sdkBoard"); pad=$("sdkPad");
    /* 動效覆蓋層。★ 一定要掛在 .sdk-stage 上,**不可以**掛進 .sdk-board ——
       盤面是 display:grid,多一個子元素就多一個 grid item,整盤會被擠掉一格。
       stage 是 position:relative、board 是 absolute inset:0 → 兩者座標系相同,
       光波可以直接用百分比定位(n 是幾就切幾份),不必量任何 px。 */
    if(wrap && !fxLayer){
      fxLayer=document.createElement("div");
      fxLayer.className="sdk-fx";
      fxLayer.setAttribute("aria-hidden","true");
      wrap.appendChild(fxLayer);
    }
  }

  // q = { n, bw, bh, puzzle, sol };owner 之後由 fill() 帶入
  function setPuzzle(q){
    n=q.n; bw=q.bw; bh=q.bh;
    puzzle=SGen.parse(q.puzzle); sol=SGen.parse(q.sol||"");
    vals=puzzle.slice();
    owners=new Array(n*n).fill(null);
    notes=[]; for(let i=0;i<n*n;i++) notes.push(new Set());
    sel=-1; noteMode=false;
    swept=new Set(); frostAt=-1; gen++;
    if(fxLayer) fxLayer.innerHTML="";
    buildBoard(); buildPad(); repaint();
  }
  function buildBoard(){
    board.innerHTML="";
    board.style.setProperty("--sn", String(n));
    board.classList.toggle("sdk-6", n<=6);   // ★ 不可叫 mini:styles.css 有裸的 .mini 小按鈕規則
    board.classList.remove("done");          // ⚠ 上一局的「滿盤鍍金」不清掉的話,新的一盤一開就是金的
    board.classList.toggle("claim",claim);   // 佔領暈染的旗標住在 board 上,重建盤面要接回來
    cells=[];
    for(let i=0;i<n*n;i++){
      const r=Math.floor(i/n), c=i%n;
      const el=document.createElement("button");
      el.type="button";
      el.className="sdk-cell"
        + (c%bw===bw-1 && c<n-1 ? " rb" : "")
        + (r%bh===bh-1 && r<n-1 ? " bb" : "");
      el.dataset.i=i;
      el.innerHTML='<span class="sdk-v"></span><span class="sdk-nt"></span><span class="sdk-cnt"></span>';
      el.addEventListener("click",()=>pick(i));
      board.appendChild(el);
      cells.push(el);
    }
  }
  // 數字鍵盤:1~n + 清除。每顆數字上帶「還剩幾格」的小角標
  function buildPad(){
    if(!pad)return;
    pad.innerHTML="";
    pad.classList.toggle("sdk-6", n<=6);
    padBtns=[];
    for(let v=1; v<=n; v++){
      const b=document.createElement("button");
      b.type="button"; b.className="sdk-key"; b.dataset.v=v;
      b.innerHTML='<span class="sdk-kn">'+v+'</span><span class="sdk-kleft"></span>';
      b.addEventListener("click",()=>press(v));
      pad.appendChild(b); padBtns.push(b);
    }
    const e=document.createElement("button");
    e.type="button"; e.className="sdk-key erase"; e.id="sdkErase";
    e.innerHTML='<span class="sdk-kn">⌫</span>';
    e.addEventListener("click",()=>{ if(cbErase)cbErase(sel); });
    pad.appendChild(e);
  }

  /* ---------- 操作 ---------- */
  function frozen(){ return Date.now() < frozenUntil; }
  function pick(i){
    if(!enabled){ return; }
    if(frozen()){ showToast("填錯了,冷靜 "+Math.ceil((frozenUntil-Date.now())/1000)+" 秒 🥶",900); return; }
    sel=i; repaint();
    if(cbPick) cbPick(i);
  }
  function press(v){
    if(!enabled)return;
    if(frozen()){ showToast("填錯了,冷靜 "+Math.ceil((frozenUntil-Date.now())/1000)+" 秒 🥶",900); return; }
    if(sel<0){ showToast("先點一個空格 👆"); return; }
    if(puzzle[sel]){ showToast("這格是題目給的,不能改"); return; }
    if(noteMode){ toggleNote(sel,v); return; }
    // 候選提示開著時,九顆數字鍵**照樣全部能按**、按錯就是填錯。
    // (v1.43.0 曾把不可能的數字劃掉並攔下不算錯 —— 那等於幫玩家把答案圈出來,見 candAt 的註解)
    if(cbNum) cbNum(sel,v);
  }
  // 鍵盤數字鍵(桌機):1~9 填數、方向鍵移動、Backspace 清除
  function onKey(e){
    if(!enabled)return;
    const k=e.key;
    if(k>="1" && k<=String(n)){ press(+k); e.preventDefault(); return; }
    if(k==="Backspace"||k==="Delete"){ if(cbErase)cbErase(sel); e.preventDefault(); return; }
    const d={ArrowLeft:-1,ArrowRight:1,ArrowUp:-n,ArrowDown:n}[k];
    if(d!=null && sel>=0){
      const r=Math.floor(sel/n), c=sel%n;
      let ni=sel+d;
      if((k==="ArrowLeft"&&c===0)||(k==="ArrowRight"&&c===n-1)||(k==="ArrowUp"&&r===0)||(k==="ArrowDown"&&r===n-1)) ni=sel;
      sel=ni; repaint(); e.preventDefault();
    }
  }

  /* ---------- 資料寫入(由呼叫端決定對錯與同步) ---------- */
  /* cls:填入者的顏色 class(連線搶格用 p0~p5;單機用 me)
     ★★ fx = 「這是**剛剛發生**的一手」。動效只吃這個旗標,不看別的:
       整盤重建(重連 / 中途歸位)一次會呼叫幾十次 fill(),連播的下場是幾十道
       金色光波排隊放完(飛行棋的批次同步踩過同一個坑,notes/22)。
     ⚠ 但 sweepAt() **無論如何都要跑** —— 它同時負責「把這條記進 swept」。
       重建時不記的話,之後隨便填到同一條線上的任何一格,都會為一條早就完成的
       行/列/宮再播一次光波。 */
  function fill(i,v,cls,fx){
    if(i<0||i>=n*n||puzzle[i])return;
    const isNew=!vals[i];
    vals[i]=v; owners[i]=cls||"me";
    notes[i].clear();
    // 填進去就把同列/同行/同宮的筆記清掉(手動擦很煩)
    eachPeer(i,j=>notes[j].delete(v));
    repaint();
    if(fx && isNew) stamp(i);
    sweepAt(i,!!fx);
  }
  function clear(i){
    if(i<0||i>=n*n||puzzle[i])return;
    vals[i]=0; owners[i]=null; notes[i].clear();
    // 這一格被清掉 → 它所在的行 / 列 / 宮不再是完成狀態,之後重新填滿要能再播一次光波
    unsweep(i);
    repaint();
  }
  function toggleNote(i,v){
    if(puzzle[i]||vals[i])return;
    if(notes[i].has(v)) notes[i].delete(v); else notes[i].add(v);
    repaint();
  }
  function eachPeer(i,fn){
    const r=Math.floor(i/n), c=i%n;
    for(let k=0;k<n;k++){ fn(r*n+k); fn(k*n+c); }
    const br=Math.floor(r/bh)*bh, bc=Math.floor(c/bw)*bw;
    for(let dr=0;dr<bh;dr++) for(let dc=0;dc<bw;dc++) fn((br+dr)*n+bc+dc);
  }
  function isPeer(a,b){
    if(a<0||b<0)return false;
    const ra=Math.floor(a/n), ca=a%n, rb=Math.floor(b/n), cb=b%n;
    if(ra===rb||ca===cb)return true;
    return Math.floor(ra/bh)===Math.floor(rb/bh) && Math.floor(ca/bw)===Math.floor(cb/bw);
  }
  /* 這格還可能填哪些數字。**只做同列/同行/同宮的排除**,刻意不碰 sol。
     ⚠ 回傳的集合**只拿來數大小,不可以拿去標數字鍵**。
        v1.43.0 的候選提示是把不可能的數字在鍵盤上劃掉,實測種子題:劃完之後只剩一個
        亮鍵的格子在 6×6 占 42%、標準 9×9 占 30% —— 三分之一的格子變成「看哪顆沒被
        劃掉就按」,推理整個消失。v1.46.0 改成只公布「這格有幾個可填」:一樣幫你挑出
        好下手的格子,但是哪幾個數字仍然要自己掃。 */
  function candAt(i){
    const s=new Set();
    for(let v=1;v<=n;v++) s.add(v);
    eachPeer(i,j=>{ if(j!==i && vals[j]) s.delete(vals[j]); });
    return s;
  }

  /* ---------- 畫面 ---------- */
  /* ⚠ repaint() 是**整行覆寫 className**,所以正在播的動效 class 要自己接回來 ——
     漏了的話,任何一次重畫(別人填了一格、選格移動、心跳對帳)都會把畫到一半的
     鈐印 / 冰晶 / 搶格脈動 / 螺旋金光靜靜抹掉,而那看起來只像是「動畫偶爾不播」。
     ★ 新增動效 class 一定要同時登記進這個陣列。 */
  const FX_CLS=["wrong","taken","ink","frost","shatter","lit"];
  function repaint(){
    const selV = sel>=0 ? vals[sel] : 0;
    for(let i=0;i<n*n;i++){
      const el=cells[i]; if(!el)continue;
      const v=vals[i];
      let cls="sdk-cell";
      if(i%n%bw===bw-1 && i%n<n-1) cls+=" rb";
      if(Math.floor(i/n)%bh===bh-1 && Math.floor(i/n)<n-1) cls+=" bb";
      if(puzzle[i]) cls+=" given";
      else if(v) cls+=" filled "+(owners[i]||"me");
      if(i===sel) cls+=" sel";
      else if(sel>=0 && isPeer(i,sel)) cls+=" peer";
      if(v && selV && v===selV) cls+=" same";
      FX_CLS.forEach(f=>{ if(el.classList.contains(f)) cls+=" "+f; });
      el.className=cls;
      el.querySelector(".sdk-v").textContent = v ? String(v) : "";
      const nt=el.querySelector(".sdk-nt");
      if(!v && notes[i].size){
        nt.innerHTML=[...notes[i]].sort((a,b)=>a-b).map(x=>'<i>'+x+'</i>').join("");
        nt.classList.add("on");
      }else{ nt.innerHTML=""; nt.classList.remove("on"); }
      // 候選提示:只標**選中的那一格**,不整盤標。整盤標就成了「難易度地圖」,
      // 掃一眼就知道全盤該從哪裡填到哪裡,一樣是把推理拿走
      const ct=el.querySelector(".sdk-cnt");
      if(ct){
        if(assist && i===sel && !puzzle[i] && !v){
          ct.textContent=String(candAt(i).size);
          ct.classList.add("on");
        }else{ ct.textContent=""; ct.classList.remove("on"); }
      }
    }
    paintPad();
  }
  // 數字鍵角標:這個數字全盤還剩幾格沒填(填滿的數字整顆變淡)。
  // 鍵盤不受候選提示影響 —— 開了提示也是九顆全亮全能按(見 candAt)
  function paintPad(){
    padBtns.forEach(b=>{
      const v=+b.dataset.v;
      let left=n;
      for(let i=0;i<n*n;i++) if(vals[i]===v) left--;
      const tag=b.querySelector(".sdk-kleft");
      // 這個數字整盤都填滿了 → 角標從「還剩幾格」換成一個綠勾,整顆再淡下去。
      // 只換字不換位置:玩家掃鍵盤時找的是同一個角落
      if(tag) tag.textContent = left>0 ? String(left) : "✓";
      b.classList.toggle("done", left<=0);
      b.classList.toggle("on", noteMode);
    });
  }
  /* ---------- 動效 ----------
     共通做法:掛一個瞬時 class,到時間再拿掉。remove → 讀 offsetWidth → add 是為了
     重啟同一支動畫(連續填同一格時沒有這一下會完全不動)。 */
  function fx(i,cls,ms){
    const el=cells[i]; if(!el)return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(()=>{ const e2=cells[i]; if(e2) e2.classList.remove(cls); },ms);
  }
  // 活字印刷:數字重重扣印下去,格子下沉回彈 + 邊緣擴散一圈自己顏色的光波紋
  function stamp(i){ fx(i,"ink",560); }

  /* 行 / 列 / 宮的完成光波。key 是 "r3" / "c5" / "b2",記進 swept 就不再重播 ——
     心跳對帳、別人補填、重連歸位都可能讓同一條再走一次這裡。
     ⚠ play=false 時**只記不播**(整盤重建);見 fill() 上面那段。 */
  function rowFull(r){ for(let k=0;k<n;k++) if(!vals[r*n+k]) return false; return true; }
  function colFull(c){ for(let k=0;k<n;k++) if(!vals[k*n+c]) return false; return true; }
  function boxFull(br,bc){
    for(let dr=0;dr<bh;dr++) for(let dc=0;dc<bw;dc++) if(!vals[(br*bh+dr)*n+bc*bw+dc]) return false;
    return true;
  }
  function sweepAt(i,play){
    if(i<0||i>=n*n)return;
    const r=Math.floor(i/n), c=i%n, br=Math.floor(r/bh), bc=Math.floor(c/bw);
    let hit=0;
    if(!swept.has("r"+r) && rowFull(r)){ swept.add("r"+r); if(play){ sweep(0,r*(100/n),100,100/n,"h"); hit++; } }
    if(!swept.has("c"+c) && colFull(c)){ swept.add("c"+c); if(play){ sweep(c*(100/n),0,100/n,100,"v"); hit++; } }
    const bk="b"+br+"_"+bc;
    if(!swept.has(bk) && boxFull(br,bc)){
      swept.add(bk);
      if(play){ sweep(bc*bw*(100/n),br*bh*(100/n),bw*(100/n),bh*(100/n),"h"); hit++; }
    }
    // 一次填格可能同時湊滿行 + 列 + 宮 → 音效只放一次,不然是三聲疊在一起的噪音
    if(hit){ try{ Sound.line(); }catch(e){} }
  }
  // 光波本體:一個絕對定位的矩形,座標一律用**百分比**(stage 與 board 同座標系,
  // 盤面大小由 CSS 自己夾)—— 不量任何 px,轉向 / 大盤面切換都不必重算
  function sweep(left,top,w,h,dir){
    if(!fxLayer)return;
    const el=document.createElement("div");
    el.className="sdk-sweep "+dir;
    el.style.left=left+"%"; el.style.top=top+"%";
    el.style.width=w+"%";   el.style.height=h+"%";
    fxLayer.appendChild(el);
    setTimeout(()=>{ if(el.parentNode) el.parentNode.removeChild(el); },1000);
  }
  // 清掉一格 → 它所在的三條線退回未完成,把記號拿掉才能重新播
  function unsweep(i){
    if(i<0||i>=n*n)return;
    const r=Math.floor(i/n), c=i%n;
    swept.delete("r"+r); swept.delete("c"+c);
    swept.delete("b"+Math.floor(r/bh)+"_"+Math.floor(c/bw));
  }

  /* 結霜 / 破冰:填錯凍結的那幾秒,那一格蓋一層冰晶;倒數歸零時碎掉。
     冰晶把「是哪一格填錯的」與「還要等多久」綁在同一個東西上,而碎裂那一下
     正好就是「可以再填了」的訊號。⚠ 只有真的凍結才結霜(單機填錯不凍結,只有紅閃)。 */
  function frost(i){
    thaw(true);
    if(i==null||i<0||i>=n*n)return;
    frostAt=i;
    const el=cells[i]; if(el) el.classList.add("frost");
  }
  function thaw(silent){
    if(frostAt<0)return;
    const i=frostAt; frostAt=-1;
    const el=cells[i]; if(!el)return;
    el.classList.remove("frost");
    if(silent){ el.classList.remove("shatter"); return; }
    fx(i,"shatter",520);
    try{ Sound.emote(); }catch(e){}
  }

  function flashWrong(i){
    const el=cells[i]; if(!el)return;
    el.classList.remove("wrong"); void el.offsetWidth; el.classList.add("wrong");
    setTimeout(()=>el.classList.remove("wrong"),600);
  }
  // 別人搶走這格:短暫脈動一下,讓對方的動作看得見
  function flashTaken(i){
    const el=cells[i]; if(!el)return;
    el.classList.remove("taken"); void el.offsetWidth; el.classList.add("taken");
    setTimeout(()=>el.classList.remove("taken"),700);
  }
  /* 滿盤解鎖:盤面鍍一層金,而且從中心往外呈螺旋依序點亮每一格。
     ⚠ 已經點過就不再點:搶格是「誰看到誰結算」,applyGame 每收一份快照都會再判一次填滿。
     ⚠ 螺旋排了整整一秒多的 setTimeout —— 中途換局(再來一局 / 重連重建)時那批回呼
       還在飛,不認世代的話會把 .lit **加到新的一盤**上(移除是無害的,加上去不是)。 */
  function markDone(){
    if(!board || board.classList.contains("done"))return;
    board.classList.add("done");
    const my=gen, mid=(n-1)/2, ord=[];
    for(let i=0;i<n*n;i++){
      const dr=Math.floor(i/n)-mid, dc=i%n-mid;
      ord.push({ i:i, d:Math.sqrt(dr*dr+dc*dc), a:Math.atan2(dr,dc) });
    }
    // 先按離中心的距離分層,同層再按角度 → 看起來就是一圈一圈轉出去
    ord.sort((x,y)=>(x.d-y.d)||(x.a-y.a));
    ord.forEach((o,k)=>setTimeout(()=>{
      if(my!==gen)return;
      const el=cells[o.i]; if(!el)return;
      el.classList.add("lit");
      setTimeout(()=>{ const e2=cells[o.i]; if(e2) e2.classList.remove("lit"); },720);
    },k*14));
  }

  /* ---------- 凍結(填錯的懲罰) ---------- */
  // at = 填錯的那一格(選填):有給就在那一格結霜,倒數歸零時碎冰
  function freeze(ms,at){
    frozenUntil=Date.now()+ms;
    frost(at);
    if(wrap) wrap.classList.add("frozen");
    if(freezeTick) clearInterval(freezeTick);
    const paint=()=>{
      const left=Math.ceil((frozenUntil-Date.now())/1000);
      const el=$("sdkFreeze");
      if(left>0){ if(el){ el.textContent="🥶 "+left; el.classList.remove("hidden"); } }
      else{
        clearInterval(freezeTick); freezeTick=null;
        if(wrap) wrap.classList.remove("frozen");
        if(el) el.classList.add("hidden");
        thaw(false);          // 碎冰 = 「可以再填了」,這一下就是解凍的訊號
      }
    };
    paint();
    freezeTick=setInterval(paint,200);
  }
  function unfreeze(){
    frozenUntil=0;
    thaw(true);               // 強制解凍(離開 / 換局)不放碎冰:那不是「等完了」
    if(freezeTick){ clearInterval(freezeTick); freezeTick=null; }
    if(wrap) wrap.classList.remove("frozen");
    const el=$("sdkFreeze"); if(el) el.classList.add("hidden");
  }

  /* ---------- 查詢 ---------- */
  function remaining(){ let k=0; for(let i=0;i<n*n;i++) if(!vals[i])k++; return k; }
  function filledCount(){ let k=0; for(let i=0;i<n*n;i++) if(vals[i] && !puzzle[i])k++; return k; }
  function isComplete(){ return remaining()===0; }
  // 第一個還沒填的格子(用來在開局把游標放到合理的位置)
  function firstEmpty(){ for(let i=0;i<n*n;i++) if(!vals[i])return i; return -1; }
  function coordName(i){
    if(i<0||i>=n*n)return "";
    return String.fromCharCode(65+(i%n))+(Math.floor(i/n)+1);
  }

  return {
    init, setPuzzle, fill, clear, flashWrong, flashTaken, markDone,
    freeze, unfreeze, frozen, onKey, press,
    setEnabled(v){ enabled=!!v; if(wrap) wrap.classList.toggle("locked",!enabled); },
    setNoteMode(v){ noteMode=!!v; repaint(); },
    noteMode:()=>noteMode,
    // 輔助模式由連線的房間設定驅動;單機不呼叫 → 永遠 false,行為完全不變。
    // 值沒變就不重畫:applyGame 每次同步都會呼叫這支,盤面已經夠忙了
    setAssist(v){ v=!!v; if(v===assist)return; assist=v; repaint(); },
    assist:()=>assist,
    /* 佔領暈染:填對的格子鋪一層填格者顏色的水墨暈染。**只有搶格才開** ——
       單機與競速全盤都是同一個顏色,染了只是把整張紙塗成一片,反而更難掃。
       ⚠ 掛在盤面上(.sdk-board.claim)而不是每一格:六個顏色共用同一條 CSS 規則。 */
    setClaim(v){ claim=!!v; if(board) board.classList.toggle("claim",claim); },
    setSel(i){ sel=i; repaint(); },
    sel:()=>sel,
    valueAt:i=>vals[i]||0,
    isGiven:i=>!!puzzle[i],
    solAt:i=>sol[i]||0,
    size:()=>n,
    remaining, filledCount, isComplete, firstEmpty, coordName,
    repaint
  };
})();

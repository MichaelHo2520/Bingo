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

  /* ---------- 建立 ---------- */
  function init(o){
    o=o||{};
    cbPick=o.onPick||null; cbNum=o.onNum||null; cbErase=o.onErase||null;
    wrap=$("sdkStage"); board=$("sdkBoard"); pad=$("sdkPad");
  }

  // q = { n, bw, bh, puzzle, sol };owner 之後由 fill() 帶入
  function setPuzzle(q){
    n=q.n; bw=q.bw; bh=q.bh;
    puzzle=SGen.parse(q.puzzle); sol=SGen.parse(q.sol||"");
    vals=puzzle.slice();
    owners=new Array(n*n).fill(null);
    notes=[]; for(let i=0;i<n*n;i++) notes.push(new Set());
    sel=-1; noteMode=false;
    buildBoard(); buildPad(); repaint();
  }
  function buildBoard(){
    board.innerHTML="";
    board.style.setProperty("--sn", String(n));
    board.classList.toggle("sdk-6", n<=6);   // ★ 不可叫 mini:styles.css 有裸的 .mini 小按鈕規則
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
  // cls:填入者的顏色 class(連線搶格用 p0~p5;單機用 me)
  function fill(i,v,cls){
    if(i<0||i>=n*n||puzzle[i])return;
    vals[i]=v; owners[i]=cls||"me";
    notes[i].clear();
    // 填進去就把同列/同行/同宮的筆記清掉(手動擦很煩)
    eachPeer(i,j=>notes[j].delete(v));
    repaint();
  }
  function clear(i){
    if(i<0||i>=n*n||puzzle[i])return;
    vals[i]=0; owners[i]=null; notes[i].clear(); repaint();
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
      if(tag) tag.textContent = left>0 ? String(left) : "";
      b.classList.toggle("done", left<=0);
      b.classList.toggle("on", noteMode);
    });
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
  function markDone(){ if(board) board.classList.add("done"); }

  /* ---------- 凍結(填錯的懲罰) ---------- */
  function freeze(ms){
    frozenUntil=Date.now()+ms;
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
      }
    };
    paint();
    freezeTick=setInterval(paint,200);
  }
  function unfreeze(){
    frozenUntil=0;
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

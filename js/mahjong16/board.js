"use strict";

/* ============================================================================
   台灣 16 張麻將 — 盤面渲染(M16B)。單機與連線共用同一個盤面。
   相依:MJFace(js/shared/mj-faces.js)、MJ16(rules.js)、MJT(table.js)。

   ── 這一支只做「把 state 畫出來」與「把點擊轉成意圖」 ────────────────────
     它**不改任何遊戲狀態** —— 所有動作都往上回呼(onDiscard / onAction / onBid),
     由 solo/adapter 決定要不要真的執行。理由同五子棋的 GB:單機與連線共用一份畫面,
     真相各自管理,盤面不該知道自己在哪一種模式。

   ── ★ 手牌排版:一排 vs 兩排,自動選(P0 原型量出來的結論) ────────────────
     實測(tools/t-mj16-hand.html):
       390px 直向 → 一排只有 21px,牌面糊成一團認不出來;兩排依花色分組有 37px。
       844px 橫向 → 一排 47px,又清楚又好按。
     ⚠ 判準**不能照抄 MGen.pickShape() 的「比誰寬」** —— 那樣 844px 會選到兩排的
       91px,荒謬地大又平白多一排。這裡改成:
         **一排的牌寬 ≥ ONE_ROW_MIN 就用一排,否則用兩排(依花色分組)。**
       ONE_ROW_MIN 是**辨識度**常數(21px 明確不行、34px 明確可以),不是版面偏好。

   ── ★ 打牌操作:看裝置分兩套(v1.58.1) ─────────────────────────────────
     觸控 → **兩段式**:點一下選取上浮、再點同一張才真的打出。
     滑鼠 → **hover 上浮 + 點一下打出**:游標移過去就站起來(等於第一段的預覽已經有了),
            再要求點兩下反而像「第一下沒反應」。
     判準是 `(hover:hover) and (pointer:fine)`,CSS 與 JS 讀同一條,不會一邊上浮一邊卻要點兩次。
     兩段式存在的理由不變:①小牌面防誤觸 ②**打錯牌在麻將不可逆**(不像消消樂配錯根本不成立)。

   ── ★ sel 存「格位」不存「牌」 ────────────────────────────────────────────
     v1.58.0 的 bug:sel 存牌值 t,手上有一對時 `sel===t` 兩張都命中 → 一起站起來。
     現在存 render() 給的格位鍵 data-k(手牌 "h<序號>"、摸進來那張 "d")。
     ⚠ 格位鍵會隨手牌內容位移,所以手牌一變(吃碰槓 / 打出 / 換局)就把 sel 清掉,
       不然舊索引會指到別張牌上。

   ── ★★ 牌的大小在一局裡要「幾乎不動」(v1.58.3,實際上手回報)─────────────
     回報是「打牌的過程中會一直不停的變換牌的大小」。牌寬是算出來的(寬度 →
     再被高度夾),所以**任何讓總高度或總寬度變一點的東西都會讓整副牌換一次大小**。
     四個來源,一個一個堵掉,而不是去調那個夾取演算法:
       ① **摸進來那張**:有它 17.45 單位、沒它 16 單位 → 每摸一張縮 8%、每打一張放大
          回來,**每一輪來回一次**,這是最刺眼的那個。
          → 那一格**一律預留**(沒摸牌時放一個等寬的透明佔位 .m16-slot),
            牌寬與手牌的水平位置因此整局固定。
       ② **牌河長高**:換一排就多 20~30px。→ 牌河高度寫死成 POOL_ROWS 排(超過就捲,
          並自動捲到底讓最新那張看得見)。
       ③ **動作列忽高忽低**:純文字 12px vs 一排 30px 的按鈕。→ .m16-acts 給 min-height。
       ④ 攤明牌 / 補花 真的會多一排 —— 這個省不掉,所以改成「**只縮不放**」:
          在同一個容器尺寸(寬 × 高)與同一局裡,牌寬單調不遞增;容器尺寸一變或換局
          才重新量。放大回去對排版沒有好處,只會讓人覺得畫面在跳。
     ⚠ 「只縮不放」的 key **一定要含容器高度** —— 動作列 / 房間框長高會讓盤面變矮,
       若只認寬度,一局之內會被一路棘輪縮到 TILE_MIN。
   ========================================================================== */

const M16B = (function(){

  const F = (typeof MJFace!=="undefined") ? MJFace : null;
  const R = (typeof MJ16 !=="undefined") ? MJ16  : null;

  const ONE_ROW_MIN = 32;      // 一排時的最小可辨識牌寬(見檔頭)
  const TILE_MIN = 20, TILE_MAX = 64;
  const DRAW_GAP = 0.45;       // 摸進來那張與手牌之間的間隔(幾張牌寬)
  const POOL_ROWS = 3;         // 牌河固定留幾排(見檔頭②;超過就捲)

  let host=null, cb={}, st=null, me=0, sel="", hint=false, lastSig="";
  /* 「只縮不放」的狀態(見檔頭④):fitKey = 容器尺寸,換了就重新量;
     fitTw = 這個容器尺寸下目前用的牌寬,同一局裡只會變小。 */
  let fitKey="", fitTw=0;

  /* 有滑鼠 = 一段式(hover 已經給了「是哪一張」的回饋);觸控 = 兩段式。
     ⚠ 一定要跟 styles.css 那條 @media 用同一個字串,否則會出現「牌浮起來卻要點兩次」。 */
  const FINE = (typeof matchMedia==="function")
    ? matchMedia("(hover:hover) and (pointer:fine)") : null;
  function oneTap(){ return !!(FINE && FINE.matches); }

  /* ---------- 小工具 ---------- */
  /* inner:牌面之後再疊上去的東西(目前只有宣告視窗的候選小點)。
     ⚠ 刻意做成**真的元素**而不是 ::before,理由只有一個:可測性。
       偽元素沒辦法用 elementFromPoint 驗「有沒有被牌面蓋住」,只驗得到「它存在」——
       實測過那條沒有牙齒(把 z-index 拿掉照樣全綠)。 */
  function tileHTML(code, cls, extra, inner){
    const inf = F.info(code);
    return '<div class="m16-tile'+(cls?" "+cls:"")+'" data-suit="'+inf.cls+'"'+
           (extra||"")+' aria-label="'+inf.name+'">'+F.faceHTML(code)+(inner||"")+'</div>';
  }
  function backTile(cls){
    return '<div class="m16-tile m16-back'+(cls?" "+cls:"")+'" aria-hidden="true">'+F.backHTML()+'</div>';
  }
  /* 對手張數標籤前面那顆迷你牌背(v1.63.1 之前是 Unicode 的 🀫)。
     ⚠ 不可以用 U+1F000 那一段的字元:只有 🀄 有 emoji 呈現,🀫(U+1F02B)在桌機與手機
       都被畫成一個**空心方框**,看起來就是缺字的豆腐(CLAUDE.md 有這條紅線)。
     ★ 尺寸與框粗由 CSS 的 .m16-cntb 決定 —— 12×16px 下 mj-faces 原本的 stroke-width:3
       換算只有 0.36px(等於看不見),所以那邊用兩層選擇器把它加粗回來。
     ⚠ F 可能是 null(mj-faces.js 沒載到),那時就只留數字,不要整列爆掉。 */
  function cntBack(){
    return F ? '<span class="m16-cntb">'+F.backHTML()+'</span>' : "";
  }
  const codeOf = t => R.codeOf(t);

  /* ---------- 手牌分排 ----------
     依花色邊界切,選「算出來的牌寬最大」的切點;摸進來那張放較短的那一排。
     回傳 { rows:[[t…],[t…]], drawRow, tw } */
  function suitGroup(t){ return R.isNumber(t) ? R.suitOf(t) : "z"; }
  function unitsOf(rows, drawRow){
    let u=0;
    rows.forEach((r,i)=>{ u = Math.max(u, r.length + ((i===drawRow) ? 1+DRAW_GAP : 0)); });
    return u;
  }
  /* ★ hasDraw 刻意**不參與計算**(v1.58.3):摸牌那一格一律預留。
     算進去的話「我摸了一張」與「我打掉一張」會讓整副牌一大一小輪流跳,
     每一輪來回一次 —— 那就是「一直不停的變換牌的大小」最主要的來源(見檔頭①)。
     參數留著只為了呼叫端讀起來清楚(以及 planFor 的既有測試簽章)。 */
  function planHand(hand, hasDraw, avail){
    // 方案 A:一排
    const uA = unitsOf([hand], 0);
    const twA = Math.floor(avail / Math.max(1,uA));
    if(twA >= ONE_ROW_MIN) return { rows:[hand], drawRow:0, tw:Math.min(twA, TILE_MAX) };

    // 方案 C:兩排,切在花色邊界
    const groups=[], keys=[];
    hand.forEach(t=>{
      const g = suitGroup(t);
      if(!keys.length || keys[keys.length-1]!==g){ keys.push(g); groups.push([]); }
      groups[groups.length-1].push(t);
    });
    let best=null;
    for(let k=1;k<groups.length;k++){
      const r1=[], r2=[];
      groups.forEach((g,i)=>{ const t=(i<k)?r1:r2; t.push.apply(t,g); });
      const dr = (r1.length<=r2.length) ? 0 : 1;
      const u  = unitsOf([r1,r2], dr);
      const tw = Math.floor(avail/Math.max(1,u));
      if(!best || tw>best.tw) best = { rows:[r1,r2], drawRow:dr, tw:tw };
    }
    // 只有一種花色(清一色)就沒有邊界可切 → 對半分
    if(!best){
      const h=Math.ceil(hand.length/2);
      const rows=[hand.slice(0,h), hand.slice(h)];
      const dr=(rows[0].length<=rows[1].length)?0:1;
      best={ rows:rows, drawRow:dr, tw:Math.floor(avail/Math.max(1,unitsOf(rows,dr))) };
    }
    best.tw = Math.max(TILE_MIN, Math.min(best.tw, TILE_MAX));
    return best;
  }

  /* ---------- 一組明牌 ----------
     ★ v1.58.2 兩處改法(都是實際上手回報的):
       ①**不再把跟人要來的那張橫放**。真牌桌是靠橫放標「這組是要來的」,但畫成 26~40px
         的小方塊之後,旋轉 90° 的牌面糊成一團,看起來像壞掉的牌而不是資訊。
       ②**吃的那組把要來的那張排到中間**(m.g),位置本身就是記號,不必再轉。 */
  function meldHTML(m, tw){
    let tiles;
    if(m.k==="chow"){
      const seq = [m.t, m.t+1, m.t+2];
      const got = (typeof m.g==="number" && seq.indexOf(m.g)>=0) ? m.g : -1;
      if(got>=0){ const rest = seq.filter(t=>t!==got); tiles = [rest[0], got, rest[1]]; }
      else tiles = seq;                                   // 舊資料沒有 g → 照順子排
    }else{
      tiles = new Array(m.k==="kong" ? 4 : 3).fill(m.t);
    }
    const kind = m.c ? "cc" : m.k;                        // 暗槓自成一類(底色不同)
    return '<span class="m16-meld '+kind+'" style="--m16w:'+tw+'px">'+
      tiles.map((t,i)=>{
        // 暗槓:中間兩張蓋著(真牌桌的擺法 —— 這個記號在小尺寸下依然清楚,保留)
        if(m.k==="kong" && m.c && (i===1||i===2)) return backTile("m16-mt");
        return tileHTML(codeOf(t), "m16-mt");
      }).join("")+'</span>';
  }

  /* ---------- 一組花牌 ----------
     ★ v1.58.3:花牌**畫成真的牌**,和吃 / 碰同一種外框(只換底色成琥珀)。
       原本對手的花牌是一串 Unicode 字符(🀢🀦…),使用者的話是「寫個字在那裡,
       有點沒感覺」—— 而且那些字符在小字級下根本認不出是哪一張花。
     ⚠ 底色一定要寫成兩層 `.m16-meld.m16-flg`:既有的 `.m16-mymelds .m16-meld`
       是 (0,2,0),一層的 .m16-flg 會被它蓋掉(CLAUDE.md 那條「反方向也會撞」)。 */
  function flowerHTML(tiles, tw){
    return '<span class="m16-meld m16-flg" style="--m16w:'+tw+'px" aria-label="花牌">'+
      tiles.map(t=>tileHTML(codeOf(t), "m16-mt")).join("")+'</span>';
  }

  /* 畫面上「輪到誰」——★ v1.65.0。宣告視窗開著時 st.turn 還停在**打牌的人**身上
     (discard 遇到有人能宣告就不換手),沒人能宣告時 turn 早就跳到下一家了 ——
     高亮還在不在出牌者身上,等於直接告訴他「有人吃得下你剛打的那張」。
     連線與單機都適用(「電腦在考慮吃碰」同樣不可以被看出來),所以判斷寫在盤面這一層。
     ⚠ 與 adapter.js 的 dispTurn() 是同一條規則,改一邊要看另一邊(grep dispTurn)。
     ⚠ 搶槓視窗例外:槓完本來就還是加槓的人繼續打。 */
  function shownTurn(){
    if(st.claim && !st.claim.rob) return (st.claim.from + 1) % st.seats;
    return st.turn;
  }

  /* ---------- 對手那一列 ----------
     ★ 莊家的記號放在**每個人自己那一列**(v1.58.3)——原本寫在盤面頂端那條資訊列
       («莊 某某»),但那條整列被拿掉了(可吃 / 牌山對玩的人沒有用)。
       我自己是不是莊,由房間框的玩家晶片講(adapter.chipLead),兩邊同一套記號。 */
  function foeHTML(seat, tw){
    const wind = R.codeOf(MJT.seatWind(seat, st.dealer, st.seats));
    /* ⚠ 張數用**真的** st.turn:宣告視窗中下一家還沒摸牌(16 張),沒人宣告時他早就摸到
       (17 張)—— 這是藏不掉的殘留管道,但刻意不假造。顯示 17 之後若有人碰,那家會從
       17 掉回 16,反而更明顯;而張數要主動去數才看得出來(見 adapter.js renderActs)。 */
    const cnt  = st.hands[seat].length + ((st.turn===seat && st.drawn>=0)?1:0);
    const fl   = st.flowers[seat];
    const mtw  = Math.round(tw*0.52);
    return '<div class="m16-foe'+(shownTurn()===seat?" on":"")+'" data-seat="'+seat+'">'+
      '<span class="m16-wind">'+F.info(wind).glyph+'</span>'+
      (seat===st.dealer?'<span class="m16-dz">莊</span>':'')+
      '<span class="m16-foename" data-seat="'+seat+'"></span>'+
      '<span class="m16-cnt">'+cntBack()+cnt+'</span>'+
      '<span class="m16-fmelds">'+
        (fl.length?flowerHTML(fl, mtw):"")+
        st.melds[seat].map(m=>meldHTML(m, mtw)).join("")+
      '</span>'+
    '</div>';
  }

  /* ---------- 攤牌(結果卡用,v1.58.4)----------
     把某一家的牌整組畫出來:手牌(含胡的那張,標記)+ 明牌 + 花。
     使用者:「如果別人胡了,我覺得應該要顯示出胡的人是什麼牌」——
     牌桌上別人的手牌永遠是 🀫 N,一局結束時沒有任何地方看得到他到底胡了什麼牌。

     ★ 做成 M16B 的一支 export、而不是在 adapter 裡拼字串:牌面、明牌的排法
       (吃到的那張排中間、暗槓中間兩張蓋著)、花牌的外框全部在這裡,
       兩個地方各寫一份一定會走鐘。
     ⚠ 胡的那張用**索引**標記不是牌值 —— 手上有一對時拿牌值比會兩張都亮
       (v1.58.0 那個「一對牌一起站起來」的同一個坑)。 */
  function revealHTML(state, seat, tw, winTile){
    const s = state || st;
    if(!s || !s.hands || !s.hands[seat]) return "";
    const hand = s.hands[seat].slice().sort((a,b)=>a-b);
    const mark = (typeof winTile==="number") ? hand.indexOf(winTile) : -1;
    const parts = [];
    if(hand.length)
      parts.push('<span class="m16-meld m16-hg">'+
        hand.map((t,i)=>tileHTML(codeOf(t), "m16-mt"+(i===mark?" m16-wt":""))).join("")+'</span>');
    (s.melds[seat]||[]).forEach(m=>parts.push(meldHTML(m, tw)));
    if((s.flowers[seat]||[]).length) parts.push(flowerHTML(s.flowers[seat], tw));
    return '<div class="m16-reveal" style="--m16w:'+tw+'px">'+parts.join("")+'</div>';
  }

  /* ==========================================================================
     渲染
     ========================================================================== */
  function render(state, mySeat){
    /* ⚠ 有新狀態進來就把選項快取丟掉。不能只靠下面那個簽章 ——
       「我表態完了」改的是 claim.bids,牌與 claim.t 都沒變、簽章一樣,
       快取留著的話牌會繼續站在那裡等你點。 */
    if(state){ st = state; opts = null; }
    if(typeof mySeat==="number") me = mySeat;
    if(!st || !host) return;

    const box = host.clientWidth || 360;
    const avail = Math.max(200, box - 16);
    const hand = st.hands[me] || [];
    const hasDraw = (st.turn===me && st.drawn>=0);
    const plan = planHand(hand, hasDraw, avail);

    /* ---- 只縮不放(見檔頭④)----
       key 是**容器的寬 × 高**:它一變(轉向 / 動作列長高 / 房間框換行)就重新量,
       否則同一局裡牌寬只會變小 —— 攤了明牌縮下去,不會在下一手又彈回去。
       ⚠ 高度一定要進 key,不然動作列一長高就開始一路棘輪縮到 TILE_MIN。
       牌寬另外對齊到 2px:量到的寬度偶爾差 1px(捲軸 / 四捨五入),沒有這一步
       會為了 1px 重畫一次整副牌。 */
    const hh = host.clientHeight;
    const key = avail+"x"+hh;
    if(key !== fitKey){ fitKey = key; fitTw = 0; }
    let tw = plan.tw - (plan.tw % 2);
    if(fitTw) tw = Math.min(tw, fitTw);

    /* 手牌一動(打出 / 被吃碰 / 補花 / 換局)格位鍵就位移了 → 舊的 sel 會指到別張牌。
       tap() 自己觸發的 render() 不會走進來(st 沒變 → 簽章相同),選取因此留得住。
       ⚠ 宣告視窗也要進簽章:同一副手牌、換一張別人打的牌,選項整組不一樣。 */
    const cl = st.claim;
    const sig = me+"|"+hand.join(",")+"|"+(hasDraw?st.drawn:"")+
                "|"+(cl?cl.t+"@"+cl.from:"");
    if(sig!==lastSig){ lastSig=sig; sel=""; copt=0; }   // 換一張別人打的牌 → 選項從第一組重來

    const canAct = MJT.ownActions(st, me).discard;
    const co = claimOpts();                              // 宣告視窗:可吃 / 碰 / 槓的組合
    if(co.length) copt = Math.min(copt, co.length-1);

    let cur = tw;
    const draw = t => { cur = t; host.innerHTML = paint(plan, t, hasDraw, canAct, co); return host.scrollHeight; };
    let h1 = draw(tw);

    /* ★★ 高度也要夾(v1.58.2)——「碰完牌就消失了」的真正機制在這裡。
       牌寬原本只受**寬度**約束,但每攤一組明牌就多出一整排(0.82×tw×1.32 ≈ 半張牌高),
       盤面塞不下時手牌就被擠出可視範圍 —— 使用者看到的是「牌不見了」。

       ⚠ 不能用「照比例縮一次」了事:總高度裡有**不隨牌寬變**的部分(對手列的 11px 字與
         內距),縮 20% 牌寬並不會讓總高度縮 20%。所以取兩點解一條直線:
           H(tw) = fixed + S × tw
         量 tw 與 0.7×tw 兩次,解出 S 與 fixed,直接算出塞得下的牌寬。
       ⚠ 直線只是近似(明牌 / 對手列會換行,是階梯不是直線),所以後面再收兩次保險。
       ⚠ clientHeight 太小(面板還沒顯示)時整段不做,否則會一路縮到 TILE_MIN;
         顯示出來時 ResizeObserver 會再叫一次 render()。 */
    if(hh > 80 && h1 > hh + 2 && tw > TILE_MIN){
      const t2 = Math.max(TILE_MIN, Math.round(tw * 0.7));
      let nt = t2;
      if(t2 < tw){
        const h2 = draw(t2);
        if(h1 > h2){
          const S = (h1 - h2) / (tw - t2);          // 牌寬每 1px 帶來多少總高度
          const fixed = h1 - tw * S;                // 不隨牌寬變的那一截
          nt = Math.floor((hh - 2 - fixed) / S);
        }
      }
      nt = Math.max(TILE_MIN, Math.min(tw, nt));
      if(nt !== t2) draw(nt);
      let guard = 0;
      while(host.scrollHeight > hh + 2 && nt > TILE_MIN && guard++ < 3){
        nt = Math.max(TILE_MIN, Math.floor(nt * 0.92));
        draw(nt);
      }
    }
    if(hh > 80) fitTw = cur;        // 記住這個容器尺寸下的牌寬(只縮不放的地板)

    /* 牌河高度寫死成 POOL_ROWS 排 → 打超過就要捲,而**最新那張永遠得看得見** */
    const pool = host.querySelector(".m16-pool");
    if(pool) pool.scrollTop = pool.scrollHeight;

    host.classList.toggle("m16-myturn", canAct);
    paintNames();
    if(cb.onClaimUI) cb.onClaimUI(co, copt);             // 動作列跟著換(✔ / 胡 / 過)
  }

  /* 把整個盤面畫成 HTML 字串。抽出來是為了上面那道「量高度 → 縮小 → 再畫一次」——
     兩次畫的差別只有 tw,排法(幾排、摸的那張放哪排)刻意不重算,免得縮一下就跳版。 */
  function paint(plan, tw, hasDraw, canAct, co){
    /* --- 對手 --- */
    let html = '<div class="m16-foes">';
    for(let k=1;k<st.seats;k++) html += foeHTML((me+k)%st.seats, tw);
    html += '</div>';

    /* --- 牌河 ----------------------------------------------------------------
       ★ v1.58.2:牌河不再 flex:1 吃掉整片高度(空盤時預留一大塊黑,看起來像壞掉),
         改成「最新那張放大、其餘縮小」—— 最新那張才是所有人正在盯的資訊。
       ★ v1.58.3 兩件事(都是實際上手回報的):
         ①**靠左**。原本 justify-content:center → 每打一張整條牌河就左右挪一次,
           永遠對不齊;靠左之後打過的牌像牌譜一樣一格一格往右長。
         ②**高度寫死** POOL_ROWS 排(不是 min~max 之間長)。牌河換一排就多 20~30px,
           而牌寬受總高度約束 → 那一刻整副牌會縮一次。寫死之後這個來源就沒了。
           滿了就捲(render() 收尾會捲到底,最新那張一定看得見)。 */
    const pw   = Math.max(14, Math.round(tw*0.46));      // 舊牌:小
    const pwL  = Math.max(20, Math.round(tw*0.78));      // 最新那張:大
    const last = st.discards.length-1;
    // 最後一排要留給放大的那張(它永遠在最後);+2 是列距、+10 是內距
    const poolH = Math.round(pw*1.32)*(POOL_ROWS-1) + Math.round(pwL*1.32)
                  + 2*(POOL_ROWS-1) + 10;
    html += '<div class="m16-pool" id="m16Pool" style="--m16w:'+pw+'px;--m16ph:'+poolH+'px">'+
      st.discards.map((d,i)=>tileHTML(codeOf(d.t),
        "m16-pt"+(i===last?" last":""),
        ' data-seat="'+d.seat+'"'+(i===last?' style="--m16w:'+pwL+'px"':''))).join("")+
      '</div>';

    /* --- 我這一邊(攤出去的 → 手牌)-----------------------------------------
       ★ margin-top:auto 掛在這個外框上,整組貼底。明牌**緊貼手牌上方**是刻意的:
         v1.58.1 之前它夾在牌河與花牌之間、又縮到 66%,實際上手的回報是
         「碰完牌就消失了,桌上沒留下記錄」—— 它其實有畫,只是畫在沒人會看的地方。
       ★ v1.58.3:花牌與明牌**併成同一排**(花牌在最前面,底色不同)。
         原本花牌自己一排,補到花就多一排 → 整副牌縮一次;而且花牌與明牌
         本來就是同一類東西(攤在桌上的),分兩排只是白吃一排高度。 */
    html += '<div class="m16-mine">';
    const mtw = Math.round(tw*0.82);
    const shown = [];
    if((st.flowers[me]||[]).length) shown.push(flowerHTML(st.flowers[me], mtw));
    (st.melds[me]||[]).forEach(m=>shown.push(meldHTML(m, mtw)));
    if(shown.length) html += '<div class="m16-mymelds">'+shown.join("")+'</div>';

    /* --- 我的手牌 --- */
    const inClaim = co.length>0;
    const focus = inClaim ? co[copt] : null;

    /* 兩排時**兩排等寬**(寬度取最長那排,含預留的摸牌格)→ 左緣對齊成一塊。
       原本每排各自居中,兩排長度不同就錯開幾十 px,看起來歪歪的
       (使用者要的「整齊的感覺」不只是牌河)。 */
    const hw = Math.round(unitsOf(plan.rows, plan.drawRow) * tw);
    html += '<div class="m16-hand'+(canAct?" live":"")+(inClaim?" claim":"")+
            '" style="--m16w:'+tw+'px;--m16hw:'+hw+'px">';
    /* planHand() 保證 rows 串起來就是 hand 的原順序(切點只切在花色邊界),
       所以一路數下去的 hi 就是這張牌在 hand 裡的索引 —— 拿它當格位鍵。 */
    let hi = 0;
    plan.rows.forEach((row,ri)=>{
      html += '<div class="m16-row">';
      row.forEach(t=>{
        const i = hi++, k = "h"+i;
        html += handTile(t, k, i, canAct, focus, co);
      });
      /* ★ 摸進來那一格**沒摸牌時也要佔住**(v1.58.3)—— 放一個等寬的透明佔位。
         planHand() 已經一律把這一格算進寬度,這裡若不畫,同一副手牌會在
         「我摸了一張 / 我打掉一張」之間左右挪半張牌,看起來就是整副牌在跳。 */
      if(ri===plan.drawRow){
        if(hasDraw){
          const n = hint ? MJT.tenpaiAfter(st, me, st.drawn).length : 0;
          html += tileHTML(codeOf(st.drawn), "m16-ht m16-draw"+(sel==="d"?" sel":"")+(n?" tenpai":""),
                           ' data-t="'+st.drawn+'" data-k="d"'+(n?' data-n="'+n+'"':''));
        }else{
          html += '<i class="m16-slot" aria-hidden="true"></i>';
        }
      }
      html += '</div>';
    });
    return html + '</div></div>';
  }

  /* 一張手牌。宣告視窗時,屬於「目前這一組」的牌站起來,其他候選只點一顆小點。 */
  function handTile(t, k, i, canAct, focus, co){
    let cls = "m16-ht", extra = ' data-t="'+t+'" data-k="'+k+'"';
    if(focus){
      if(focus.idx.indexOf(i)>=0) return tileHTML(codeOf(t), cls+" sel opt", extra);
      // 其他組的候選:不站起來,只在頂端疊一顆小點(「這張也能點,還有別組」)
      if(co.some(o=>o.idx.indexOf(i)>=0))
        return tileHTML(codeOf(t), cls+" alt", extra, '<i class="m16-omk"></i>');
      return tileHTML(codeOf(t), cls, extra);
    }
    if(sel===k) cls += " sel";
    const n = (hint && canAct) ? MJT.tenpaiAfter(st, me, t).length : 0;
    if(n){ cls += " tenpai"; extra += ' data-n="'+n+'"'; }
    return tileHTML(codeOf(t), cls, extra);
  }

  /* 玩家名字由外面餵(單機用座位名、連線用暱稱)—— 盤面不知道玩家是誰 */
  let nameOf = seat => "座位 "+(seat+1);
  function paintNames(){
    if(!host) return;
    [...host.querySelectorAll(".m16-foename")].forEach(el=>{
      el.textContent = nameOf(+el.dataset.seat);
    });
  }

  /* ==========================================================================
     宣告視窗:吃 / 碰 / 槓直接畫在牌上(v1.58.2)
     ──────────────────────────────────────────────────────────────────────────
     舊版是一排「吃 三四 / 吃 四五 / 碰 / 過」按鈕 —— 使用者的話是「這種選擇方式我不喜歡」。
     問題在按鈕上的文字要玩家**自己在腦中對回手牌**:「吃 三四」是哪兩張?

     新的做法:
       · 每一種吃法 / 碰 / 槓 都是一個「選項」,選項的牌**直接在手牌裡站起來**
       · 一次只站起來**一組**(目前這一組)。其他組的牌點一顆小點當提示 —— 這就是
         「重疊怎麼顯示」的答案:不同時顯示,用切換。同時把三種吃法都攤開只會更亂,
         而且同一張牌會屬於好幾組,顏色再多也講不清楚。
       · 點任何一張候選牌 = 切到「包含這張的下一組」(循環)。點得到的資訊是牌本身,
         不是文字標籤。
       · **送出與放棄一律走動作列的大按鈕**(✔ 碰 / 胡! / 過)—— 選擇在牌上、動作在按鈕上,
         誤觸不會直接吃掉一張牌;「過」也因此永遠在同一個位置、夠大、找得到。
     ★ 胡刻意**不做成選項** —— 它不吃特定手牌(用不到 idx),而且它是最重要的一個,
       必須永遠是獨立的大按鈕。
     ========================================================================== */
  let opts = null, copt = 0;

  /* 從手牌裡挑出 values 對應的位置(同款牌要挑不同格位) */
  function pickIdx(hand, values){
    const used = {}, out = [];
    values.forEach(v=>{
      for(let i=0;i<hand.length;i++){
        if(hand[i]===v && !used[i]){ used[i]=1; out.push(i); return; }
      }
    });
    return out.length===values.length ? out : null;
  }
  function claimOpts(){
    if(opts) return opts;
    opts = [];
    if(!st || !st.claim || st.over) return opts;
    const types = st.claim.elig[me];
    if(!types || st.claim.bids[me]) return opts;         // 沒資格 / 已經表態過
    const hand = st.hands[me] || [], t = st.claim.t;
    const add = (type, values, label) => {
      const idx = pickIdx(hand, values);
      if(idx) opts.push({ type, idx, tiles:values, label });
    };
    if(types.indexOf("kong")>=0) add("kong", [t,t,t], "槓");
    if(types.indexOf("pong")>=0) add("pong", [t,t], "碰");
    if(types.indexOf("chow")>=0){
      const c = R.claimsFor(R.toCounts(hand), t,
                { need:MJT.needOf(st,me), chow:true, fromLeft:true });
      c.chow.forEach(pair=>add("chow", pair, "吃"));
    }
    return opts;
  }
  /* 點到某張候選牌 → 切到「包含這張的下一組」(循環) */
  function cycleTo(i){
    const co = claimOpts();
    const owners = [];
    co.forEach((o,k)=>{ if(o.idx.indexOf(i)>=0) owners.push(k); });
    if(!owners.length) return false;
    const at = owners.indexOf(copt);
    copt = owners[(at+1) % owners.length];
    render();
    return true;
  }

  /* ==========================================================================
     操作
     ========================================================================== */
  function tap(k, t){
    // 宣告視窗優先:這時候點牌不是打牌,是選要吃哪一組
    if(claimOpts().length){
      if(k && k[0]==="h") cycleTo(+k.slice(1));
      return;
    }
    const a = MJT.ownActions(st, me);
    if(!a.discard) return;
    /* ★ 滑鼠:hover 已經把牌抬起來了,這一下就是打出。
       ★ 觸控:兩段式 —— 第一次點是選取(上浮),第二次點**同一個格位**才打出。
         比的是格位 k 不是牌值 t,手上有一對時才不會兩張一起亮(v1.58.1)。 */
    if(!oneTap() && sel !== k){ sel = k; render(); return; }
    sel = "";
    if(cb.onDiscard) cb.onDiscard(t);
  }

  function mount(o){
    cb = o || {};
    host = document.getElementById(o.hostId || "m16Stage");
    if(!host) return;
    host.addEventListener("click", e=>{
      const el = e.target.closest(".m16-ht");
      if(el && el.dataset.t!==undefined){ tap(el.dataset.k||"", +el.dataset.t); return; }
      const foe = e.target.closest(".m16-foe");
      if(foe && cb.onFoe) cb.onFoe(+foe.dataset.seat);
    });
    if(window.ResizeObserver) new ResizeObserver(()=>render()).observe(host);
    addEventListener("orientationchange", ()=>setTimeout(()=>render(),180));
  }

  return {
    mount, render, revealHTML,
    /* 換局 / 回大廳 / 結算都會叫這支 —— 順便把「只縮不放」的地板放掉,
       新的一局從頭量一次(不然上一局縮下去的牌寬會一直背著走)。 */
    clearSel(){ sel=""; opts=null; copt=0; lastSig=""; fitTw=0; },
    /* 宣告視窗:動作列問「現在是哪一組」,按下 ✔ 時回頭拿它送出 */
    claimOpts(){ return claimOpts(); },
    claimCur(){ const co=claimOpts(); return co.length ? co[Math.min(copt,co.length-1)] : null; },
    setClaimCur(i){ const co=claimOpts(); if(i>=0&&i<co.length){ copt=i; render(); } },
    setNames(fn){ nameOf = fn || (s=>"座位 "+(s+1)); },
    setHint(v){ hint = !!v; render(); },
    hintOn(){ return hint; },
    /* 操作提示由盤面出,因為只有它知道這台裝置走一段式還是兩段式 */
    discardHint(){ return oneTap() ? "滑過選牌 · 點一下打出" : "點牌兩次打出"; },
    oneTap,
    // 給測試頁與 e2e:直接問排版決策,不必去讀 DOM
    planFor(hand, hasDraw, avail){ return planHand(hand, hasDraw, avail); },
    ONE_ROW_MIN, TILE_MIN
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16B;

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

   ── ★ 兩段式打牌 ─────────────────────────────────────────────────────────
     點一下選取上浮、再點同一張才真的打出。
     理由:①小牌面防誤觸 ②**打錯牌在麻將是不可逆的**(不像消消樂配錯根本不成立)。
   ========================================================================== */

const M16B = (function(){

  const F = (typeof MJFace!=="undefined") ? MJFace : null;
  const R = (typeof MJ16 !=="undefined") ? MJ16  : null;

  const ONE_ROW_MIN = 32;      // 一排時的最小可辨識牌寬(見檔頭)
  const TILE_MIN = 20, TILE_MAX = 64;
  const DRAW_GAP = 0.45;       // 摸進來那張與手牌之間的間隔(幾張牌寬)

  let host=null, cb={}, st=null, me=0, sel=-1, hint=false;

  /* ---------- 小工具 ---------- */
  function tileHTML(code, cls, extra){
    const inf = F.info(code);
    return '<div class="m16-tile'+(cls?" "+cls:"")+'" data-suit="'+inf.cls+'"'+
           (extra||"")+' aria-label="'+inf.name+'">'+F.faceHTML(code)+'</div>';
  }
  function backTile(cls){
    return '<div class="m16-tile m16-back'+(cls?" "+cls:"")+'" aria-hidden="true">'+F.backHTML()+'</div>';
  }
  const codeOf = t => R.codeOf(t);

  /* ---------- 手牌分排 ----------
     依花色邊界切,選「算出來的牌寬最大」的切點;摸進來那張放較短的那一排。
     回傳 { rows:[[t…],[t…]], drawRow, tw } */
  function suitGroup(t){ return R.isNumber(t) ? R.suitOf(t) : "z"; }
  function unitsOf(rows, drawRow, hasDraw){
    let u=0;
    rows.forEach((r,i)=>{ u = Math.max(u, r.length + ((hasDraw && i===drawRow) ? 1+DRAW_GAP : 0)); });
    return u;
  }
  function planHand(hand, hasDraw, avail){
    // 方案 A:一排
    const uA = unitsOf([hand], 0, hasDraw);
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
      const u  = unitsOf([r1,r2], dr, hasDraw);
      const tw = Math.floor(avail/Math.max(1,u));
      if(!best || tw>best.tw) best = { rows:[r1,r2], drawRow:dr, tw:tw };
    }
    // 只有一種花色(清一色)就沒有邊界可切 → 對半分
    if(!best){
      const h=Math.ceil(hand.length/2);
      const rows=[hand.slice(0,h), hand.slice(h)];
      const dr=(rows[0].length<=rows[1].length)?0:1;
      best={ rows:rows, drawRow:dr, tw:Math.floor(avail/Math.max(1,unitsOf(rows,dr,hasDraw))) };
    }
    best.tw = Math.max(TILE_MIN, Math.min(best.tw, TILE_MAX));
    return best;
  }

  /* ---------- 一組明牌 ---------- */
  function meldHTML(m, tw){
    const n = (m.k==="kong") ? 4 : 3;
    let tiles = [];
    if(m.k==="chow") tiles = [m.t, m.t+1, m.t+2];
    else for(let i=0;i<n;i++) tiles.push(m.t);
    return '<span class="m16-meld" style="--m16w:'+tw+'px">'+
      tiles.map((t,i)=>{
        // 暗槓:中間兩張蓋著(真牌桌的擺法)
        if(m.k==="kong" && m.c && (i===1||i===2)) return backTile("m16-mt");
        // 吃 / 碰 / 明槓:被拿走的那張橫放(第一張),一眼看出是跟人要來的
        return tileHTML(codeOf(t), "m16-mt"+((!m.c && i===0)?" m16-lay":""));
      }).join("")+'</span>';
  }

  /* ---------- 對手那一列 ---------- */
  function foeHTML(seat, tw){
    const rs = R.RULESETS[st.rs];
    const wind = R.codeOf(MJT.seatWind(seat, st.dealer, st.seats));
    const cnt  = st.hands[seat].length + ((st.turn===seat && st.drawn>=0)?1:0);
    const fl   = st.flowers[seat];
    return '<div class="m16-foe'+(st.turn===seat?" on":"")+'" data-seat="'+seat+'">'+
      '<span class="m16-wind">'+F.info(wind).glyph+'</span>'+
      '<span class="m16-foename" data-seat="'+seat+'"></span>'+
      '<span class="m16-cnt">🀫 '+cnt+'</span>'+
      (fl.length?'<span class="m16-fl">'+fl.map(t=>F.info(codeOf(t)).glyph).join("")+'</span>':'')+
      '<span class="m16-fmelds">'+st.melds[seat].map(m=>meldHTML(m, Math.round(tw*0.52))).join("")+'</span>'+
    '</div>';
  }

  /* ==========================================================================
     渲染
     ========================================================================== */
  function render(state, mySeat){
    if(state) st = state;
    if(typeof mySeat==="number") me = mySeat;
    if(!st || !host) return;

    const box = host.clientWidth || 360;
    const avail = Math.max(200, box - 16);
    const hand = st.hands[me] || [];
    const hasDraw = (st.turn===me && st.drawn>=0);
    const plan = planHand(hand, hasDraw, avail);
    const tw = plan.tw;

    /* --- 對手 --- */
    let html = '<div class="m16-foes">';
    for(let k=1;k<st.seats;k++) html += foeHTML((me+k)%st.seats, tw);
    html += '</div>';

    /* --- 牌河 --- */
    const pw = Math.max(16, Math.round(tw*0.62));
    html += '<div class="m16-pool" id="m16Pool" style="--m16w:'+pw+'px">'+
      st.discards.map((d,i)=>tileHTML(codeOf(d.t),
        "m16-pt"+(i===st.discards.length-1?" last":""),
        ' data-seat="'+d.seat+'"')).join("")+
      '</div>';

    /* --- 我的明牌 --- */
    if((st.melds[me]||[]).length)
      html += '<div class="m16-mymelds">'+st.melds[me].map(m=>meldHTML(m, Math.round(tw*0.66))).join("")+'</div>';

    /* --- 我的花牌 --- */
    if((st.flowers[me]||[]).length)
      html += '<div class="m16-myfl" style="--m16w:'+Math.round(tw*0.5)+'px">'+
              st.flowers[me].map(t=>tileHTML(codeOf(t),"m16-ft")).join("")+'</div>';

    /* --- 我的手牌(兩段式:data-t 給點擊用) --- */
    const canAct = MJT.ownActions(st, me).discard;
    // 聽牌提示:打掉這張之後聽幾張(只給自己看,不指出是哪幾張以外的資訊)
    html += '<div class="m16-hand'+(canAct?" live":"")+'" style="--m16w:'+tw+'px">';
    plan.rows.forEach((row,ri)=>{
      html += '<div class="m16-row">';
      row.forEach(t=>{
        const n = (hint && canAct) ? MJT.tenpaiAfter(st, me, t).length : 0;
        html += tileHTML(codeOf(t), "m16-ht"+(sel===t?" sel":"")+(n?" tenpai":""),
                         ' data-t="'+t+'"'+(n?' data-n="'+n+'"':''));
      });
      if(hasDraw && ri===plan.drawRow){
        const n = hint ? MJT.tenpaiAfter(st, me, st.drawn).length : 0;
        html += tileHTML(codeOf(st.drawn), "m16-ht m16-draw"+(sel===st.drawn?" sel":"")+(n?" tenpai":""),
                         ' data-t="'+st.drawn+'"'+(n?' data-n="'+n+'"':''));
      }
      html += '</div>';
    });
    html += '</div>';

    host.innerHTML = html;
    host.classList.toggle("m16-myturn", canAct);
    paintNames();
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
     操作
     ========================================================================== */
  function tap(t){
    const a = MJT.ownActions(st, me);
    if(!a.discard) return;
    /* ★ 兩段式:第一次點是選取(上浮),第二次點同一張才打出。
       打錯牌在麻將不可逆,而且手機上牌只有 34~47px 寬。 */
    if(sel !== t){ sel = t; render(); return; }
    sel = -1;
    if(cb.onDiscard) cb.onDiscard(t);
  }

  function mount(o){
    cb = o || {};
    host = document.getElementById(o.hostId || "m16Stage");
    if(!host) return;
    host.addEventListener("click", e=>{
      const el = e.target.closest(".m16-ht");
      if(el && el.dataset.t!==undefined){ tap(+el.dataset.t); return; }
      const foe = e.target.closest(".m16-foe");
      if(foe && cb.onFoe) cb.onFoe(+foe.dataset.seat);
    });
    if(window.ResizeObserver) new ResizeObserver(()=>render()).observe(host);
    addEventListener("orientationchange", ()=>setTimeout(()=>render(),180));
  }

  return {
    mount, render,
    clearSel(){ sel=-1; },
    setNames(fn){ nameOf = fn || (s=>"座位 "+(s+1)); },
    setHint(v){ hint = !!v; render(); },
    hintOn(){ return hint; },
    // 給測試頁與 e2e:直接問排版決策,不必去讀 DOM
    planFor(hand, hasDraw, avail){ return planHand(hand, hasDraw, avail); },
    ONE_ROW_MIN
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16B;

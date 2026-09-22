"use strict";

/* ============================================================================
   方塊對戰 — 電腦對手(BLKAI)
   ★ 純函式,零 DOM、零 Firebase(與另外十六支 AI / 規則同一條紅線)。
     它只做兩件事:①「這一顆該放哪裡」②「照那個決定,這一幀該按哪一個鍵」。

   ── 怎麼選落點 ────────────────────────────────────────────────────────────
     用的是公開的 Dellacherie / El-Tetris 啟發式:把每一種(方向 × 欄位)都真的
     放下去算一次分,取最高分。六個特徵:
       · 落地高度      放下去之後這一顆的重心離底部多高(越高越糟)
       · 消掉的格子    這一手消了幾行 × 這一顆有幾格參與(越多越好)
       · 橫向轉換      每一列「有 ↔ 沒有」切換幾次(表面越碎越糟)
       · 直向轉換      每一欄「有 ↔ 沒有」切換幾次(洞與懸空越多越糟)
       · 洞            上面有東西壓著的空格(最致命)
       · 井            兩邊都有牆的深縫(累加深度)

   ── ★★★ 四條會直接做錯的事 ───────────────────────────────────────────────
     ① **評分要在「消行之後」的盤面上算。** 在消行之前算的話,打出 Tetris 的那一手
        看起來會像「堆超高」→ AI 永遠不敢消四行。
     ② **難度主要靠「每分鐘幾顆」,不是靠把評分改爛。** 評分改爛的電腦會做出
        人類看得懂的蠢事(把洞堆在正中間),而「慢」看起來就只是手比較不順 ——
        後者才是我們要給新手的對手。
     ③ **輸出是一連串按鍵,不是直接把方塊瞬移到定位。** 對手的小盤上要看得到它
        在移動 —— 瞬移看起來像畫面在跳格,而且「他在想什麼」完全看不出來。
     ④ **決定一次就記住(mem.target)。** 每一幀重算的話,盤面被垃圾行推上來的
        那一瞬間目標會整個換掉,方塊會在原地左右鬼打牆。
   ========================================================================== */

const BLKAI = (function(){

  /* ⚠ 瀏覽器裡 BLK 是同一頁的詞法全域;node 裡沒有那個東西 → 退回 require。
     (與 js/tiaoqi/ai.js 同一個寫法;少了它這一支就不能單獨用 node 測。) */
  const R = (typeof BLK !== "undefined") ? BLK : require("./rules.js");

  /* El-Tetris 的權重(公開值)。⚠ 不要「順手微調」—— 這六個數字是一起最佳化出來的,
     單獨動一個的結果通常是明顯變笨,而且要玩很久才看得出來。 */
  const W = {
    landing: -4.500158825082766,
    eroded:   3.4181268101392694,
    rowT:    -3.2178882868487753,
    colT:    -9.348695305445199,
    holes:   -7.899265427351652,
    wells:   -3.3855972247263626
  };

  /* 三個難度。
     ★ ppm = 每分鐘放幾顆。人類休閒玩家大約 30~50,高手 100 以上。
     ★ noise = 評分的隨機擾動;blunder = 有多少機率乾脆挑第二好的。
       兩者都只在「新手」明顯,理由見紅線 ②。 */
  const LEVELS = [
    { key: "easy", name: "新手", emoji: "🙂", ppm: 22, noise: 3.2, blunder: 0.30,
      desc: "放得慢,偶爾會把自己埋起來 —— 第一次玩的人也贏得了" },
    { key: "norm", name: "普通", emoji: "😎", ppm: 40, noise: 1.0, blunder: 0.10,
      desc: "穩穩地堆,會消行也會還手,但不會刻意留四格的洞" },
    /* ⚠ 這一句原本寫「一直挖四格的洞打 Tetris」,但那不是它真正在做的事:
       El-Tetris 的 wells 是**負**權重(-3.38)→ 它其實是盡量不留深縫的打法,
       難度來自 ppm(出手快)。說明與行為對不上,玩家會等一個永遠不來的 Tetris。 */
    { key: "hard", name: "高手", emoji: "🔥", ppm: 72, noise: 0.15, blunder: 0.0,
      desc: "手很快、幾乎不留洞,穩穩地一直還手 —— 不先學會抵銷會被埋掉" }
  ];
  function levelOf(k){
    for(let i = 0; i < LEVELS.length; i++) if(LEVELS[i].key === k) return LEVELS[i];
    return LEVELS[1];
  }

  /* ==========================================================================
     一、盤面特徵
     ========================================================================== */
  function rowTransitions(b){
    let n = 0;
    for(let y = R.TOP; y < R.ROWS; y++){
      let prev = 1;                     // 牆外一律當「有東西」
      for(let x = 0; x < R.COLS; x++){
        const v = b[y][x] ? 1 : 0;
        if(v !== prev) n++;
        prev = v;
      }
      if(prev === 0) n++;               // 右牆
    }
    return n;
  }
  function colTransitions(b){
    let n = 0;
    for(let x = 0; x < R.COLS; x++){
      let prev = 0;                     // 天花板當「空的」
      for(let y = R.TOP; y < R.ROWS; y++){
        const v = b[y][x] ? 1 : 0;
        if(v !== prev) n++;
        prev = v;
      }
      if(prev === 0) n++;               // 地板當「有東西」
    }
    return n;
  }
  function holes(b){
    let n = 0;
    for(let x = 0; x < R.COLS; x++){
      let seen = false;
      for(let y = R.TOP; y < R.ROWS; y++){
        if(b[y][x]) seen = true;
        else if(seen) n++;
      }
    }
    return n;
  }
  /* 井:左右都是牆 / 都有東西的空格,深度累加(1+2+3+…) */
  function wells(b){
    let n = 0;
    for(let x = 0; x < R.COLS; x++){
      let d = 0;
      for(let y = R.TOP; y < R.ROWS; y++){
        const left  = (x === 0) || b[y][x - 1];
        const right = (x === R.COLS - 1) || b[y][x + 1];
        if(!b[y][x] && left && right){ d++; n += d; }
        else d = 0;
      }
    }
    return n;
  }

  /* ==========================================================================
     二、把一顆放下去,算這一手值多少
     ──────────────────────────────────────────────────────────────────────────
       ⚠ 紅線 ①:消行之後才算特徵,但「落地高度」用的是消行**之前**的位置
         (那才是這一手實際堆到多高)。
     ========================================================================== */
  function tryPlace(board, k, r, x, y){
    const b = board.map(row => row.slice());
    const cs = R.cellsOf(k, r, x, y);
    let low = 0, high = R.ROWS;
    for(let i = 0; i < 4; i++){
      const p = cs[i];
      if(p[1] < 0 || p[1] >= R.ROWS || p[0] < 0 || p[0] >= R.COLS) return null;
      b[p[1]][p[0]] = k + 1;
      if(p[1] > low) low = p[1];
      if(p[1] < high) high = p[1];
    }
    // 消行
    const keep = [];
    let cleared = 0, eroded = 0;
    for(let yy = 0; yy < R.ROWS; yy++){
      let full = true;
      for(let xx = 0; xx < R.COLS; xx++) if(!b[yy][xx]){ full = false; break; }
      if(full){
        cleared++;
        for(let i = 0; i < 4; i++) if(cs[i][1] === yy) eroded++;
      }else keep.push(b[yy]);
    }
    while(keep.length < R.ROWS) keep.unshift(new Array(R.COLS).fill(0));

    const landing = R.ROWS - 1 - ((low + high) / 2);   // 離底部多高
    return {
      board: keep, cleared: cleared,
      score: W.landing * landing +
             W.eroded  * (cleared * eroded) +
             W.rowT    * rowTransitions(keep) +
             W.colT    * colTransitions(keep) +
             W.holes   * holes(keep) +
             W.wells   * wells(keep)
    };
  }

  /* 從目前的盤面 + 這一顆,挑一個落點。回傳 { r, x } 或 null(放不下 = 快死了) */
  function best(st, lv, rnd){
    const k = st.cur ? st.cur.k : -1;
    if(k < 0) return null;
    rnd = rnd || Math.random;
    const cands = R.placements(st.board, k);
    if(!cands.length) return null;
    const scored = [];
    for(let i = 0; i < cands.length; i++){
      const c = cands[i];
      const res = tryPlace(st.board, c.k, c.r, c.x, c.y);
      if(!res) continue;
      scored.push({ r: c.r, x: c.x, s: res.score + (lv.noise ? (rnd() - 0.5) * 2 * lv.noise : 0) });
    }
    if(!scored.length) return null;
    scored.sort((a, b) => b.s - a.s);
    /* 紅線 ②:失誤是「挑第二好的」,不是「挑最爛的」——
       挑最爛的電腦會做出人類看得懂的蠢事,那看起來像程式壞掉而不是像新手。 */
    const pick = (lv.blunder && scored.length > 1 && rnd() < lv.blunder) ? 1 : 0;
    return { r: scored[pick].r, x: scored[pick].x };
  }

  /* ==========================================================================
     三、控制器:把決定變成一連串按鍵
     ──────────────────────────────────────────────────────────────────────────
       mem = { target, t, k }  —— 呼叫端自己保管一份(每個電腦玩家一份)。
       每顆方塊大約要 5 個輸入(轉一次 + 移三格 + 落地),所以輸入的間隔
       是「一顆的時間 ÷ 5」。
     ========================================================================== */
  function newMem(){ return { target: null, t: 0, k: -1 }; }

  function step(st, mem, dt, lv, rnd){
    /* ⚠ 早退也要回**陣列** —— 呼叫端是 `BLKAI.step(…).concat(BLK.tick(…))`,
       回 undefined 就是一個 TypeError,而它會發生在對電腦那一局的中途。
       現在被呼叫端的 dead 守衛擋著,但那是兩支檔案之間的默契,不是保證。 */
    if(!st || st.dead || !st.cur) return [];
    lv = lv || LEVELS[1];
    /* 紅線 ④:換了一顆才重新決定。**不要每一幀重算** ——
       盤面被垃圾行推上來的那一瞬間目標會整個換掉,方塊會在原地左右鬼打牆。 */
    if(!mem.target || mem.k !== st.pieces){
      mem.target = best(st, lv, rnd);
      mem.k = st.pieces;
    }
    const iv = Math.max(24, 60000 / Math.max(6, lv.ppm) / 5);
    mem.t += dt;
    let guard = 12;                     // 一幀最多補幾個輸入(分頁凍結回來時)
    const evs = [];
    while(mem.t >= iv && guard-- > 0){
      mem.t -= iv;
      const r = act(st, mem);
      if(r.ev) evs.push(r.ev);
      if(!r.more) break;
    }
    return evs;
  }

  /* 走一步。
     ⚠⚠ **一定要把 hardDrop 的事件交出去** —— 電腦消行送出來的垃圾行就住在那裡面。
       吞掉它的症狀是「電腦看起來有在消行,但從來不會攻擊你」,而且完全不報錯。
     回傳 { more, ev }:more=false 代表這一顆處理完了。 */
  function act(st, mem){
    const c = st.cur;
    if(!c) return { more: false, ev: null };
    const t = mem.target;
    if(!t){                             // 找不到落點 = 快死了,直接放下去
      const ev = R.hardDrop(st);
      mem.target = null;
      return { more: false, ev: ev };
    }
    if(c.r !== t.r){
      if(R.rotate(st, 1)) return { more: true, ev: null };
      const ev = R.hardDrop(st); mem.target = null;
      return { more: false, ev: ev };
    }
    if(c.x !== t.x){
      const d = (t.x > c.x) ? 1 : -1;
      if(R.move(st, d)) return { more: true, ev: null };
      const ev = R.hardDrop(st); mem.target = null;   // 卡住了就別硬推
      return { more: false, ev: ev };
    }
    const ev = R.hardDrop(st);
    mem.target = null;
    return { more: false, ev: ev };
  }

  return {
    LEVELS, levelOf, W,
    rowTransitions, colTransitions, holes, wells,
    tryPlace, best, newMem, step, act
  };
})();

/* node 測試用(瀏覽器不會有 module) */
if (typeof module !== "undefined" && module.exports) module.exports = BLKAI;

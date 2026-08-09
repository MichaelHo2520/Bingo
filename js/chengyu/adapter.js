"use strict";

/* ============================================================================
   成語接龍 — 連線適配器(接上 js/shared/mp-core.js)。唯一模式:搶字(grab)——
   所有人看**同一張盤面**、同時都能填。填對 → 那格永久標上你的顏色並 +1 分;
   填錯 → 凍結 FREEZE_MS 並讓對手看到、不扣分。盤面填滿時分數最高者勝。

   資料模型照抄數獨 grab 模式的 fills 整數編碼精神(見 js/sudoku/adapter.js),
   只把「數字 1~9」換成「這盤字卡去重清單的第幾個字」——但**這個索引必須是
   跟畫面顯示順序脫鉤的「規範順序」**:依 puzzle/sol 字串本身的掃描順序算出來,
   不是 CYB 畫面上洗牌過的字卡順序,否則兩台裝置洗牌結果不同,同一個整數會
   解出不同字元,直接對不上。

   ⚠ 只用了一個能力旗標:一場一局、搶字模式、不扣分、對局中不可加入,
     跟數獨一樣不碰 js/shared/mp-core.js 一行 —— 唯一例外是 contRound(v1.136.0,
     局間續局,比照台灣麻將):結果卡按「我看完了」不回大廳,湊齊直接接下一盤。
   ========================================================================== */

const MP = MPCore.create((function () {
  const FREEZE_MS = 3000;
  const COLORS = ["p0", "p1", "p2", "p3", "p4", "p5"];
  const V_MAX = 32;               // 一盤最多用到的相異字數上限(hard 難度實測 ≤22,留餘裕)
  let diff = "std";
  let gDiff = "std";
  let ctx = null;
  let puzKey = null, holes = 0, fills = [], tally = [];
  let charList = [];               // 規範順序的字元清單,每個端算出來都一樣
  let nextKey = "";                 // 這一局要不要顯示續局腳註(outcome() 會被重複呼叫,見那裡)

  /* ---------- fills 的整數編碼 ---------- */
  function encFill(i, v, seat, ok) { return ((i * V_MAX + v) * 8 + seat) * 2 + (ok ? 1 : 0); }
  function decFill(c) {
    const ok = c % 2; c = (c - ok) / 2;
    const seat = c % 8; c = (c - seat) / 8;
    const v = c % V_MAX, i = (c - v) / V_MAX;
    return { i, v, seat, ok: !!ok };
  }
  function buildCharList(puzzle, sol) {
    const seen = new Set(), list = [];
    for (let i = 0; i < puzzle.length; i++) {
      if (puzzle[i] === "." && !seen.has(sol[i])) { seen.add(sol[i]); list.push(sol[i]); }
    }
    return list;
  }
  function charIdx(ch) { return charList.indexOf(ch); }
  function seatOf(id) { return ctx.order().indexOf(id); }
  function mySeat() { return seatOf(ctx.me()); }
  function colorOf(seat) { return COLORS[seat] || "p0"; }

  /* ---------- 計分:唯一的加分入口(v1 沒有候選提示,不需要扣分邏輯) ---------- */
  function bump(t, seat, ok) { if (ok) t[seat] = (t[seat] || 0) + 1; }

  /* ---------- 即時比分 HUD(盤面上方那一列) ---------- */
  function renderHud() {
    const box = $("cyHud"); if (!box) return;
    if (ctx.phase() !== "playing") { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const ord = ctx.order(), me = ctx.me();
    box.classList.remove("hidden");
    box.classList.toggle("cy-hud-two", ord.length > 4);
    box.innerHTML = ord.map((id, seat) => {
      const nm = esc(ctx.dispName(id));
      const val = tally[seat] || 0;
      const bar = '<span class="cy-bar"><i style="width:' + (holes ? Math.round((val / holes) * 100) : 0) + '%"></i></span>';
      return '<div class="cy-hcard ' + colorOf(seat) + (id === me ? " me" : "") + '" data-id="' + id + '" title="' +
        (id === me ? "點一下傳送互動表情給全部人" : "點一下傳送互動表情") + '">' +
        '<span class="cy-hname"><span class="cy-seat ' + colorOf(seat) + '"></span>' + nm + (id === me ? ' <b>你</b>' : '') + '</span>' +
        '<span class="cy-hval">' + val + '<em>分</em></span>' + bar +
        '</div>';
    }).join("");
  }
  function popScore(seat, delta) {
    const box = $("cyHud"); if (!box) return;
    const card = box.children[seat]; if (!card) return;
    const el = document.createElement("span");
    el.className = "cy-pop up";
    el.textContent = "+" + delta;
    card.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 900);
  }

  /* ---------- 填格 ---------- */
  function play(i, ch) {
    if (ctx.phase() !== "playing" || ctx.winner()) return;
    if (CYB.frozen()) return;
    if (CYB.isBlock(i) || CYB.isGiven(i)) { showToast("這格是題目給的,不能改"); return; }
    if (CYB.valueAt(i)) { showToast("這格已經被填走了"); return; }
    const seat = mySeat(); if (seat < 0) return;
    const v = charIdx(ch); if (v < 0) return;
    const right = (CYB.solAt(i) === ch);
    if (!right) {
      CYB.flashWrong(i);
      CYB.freeze(FREEZE_MS);
      showToast("填錯了,冷靜 3 秒 🥶", 1400);
      try { Sound.lose(); } catch (e) {}
      ctx.txGame(g => {
        if (g.status !== "playing" || g.winner) return false;
        g.fills = (Array.isArray(g.fills) ? g.fills : []).concat(encFill(i, v, seat, 0));
      });
      return;
    }
    ctx.txGame(g => {
      if (g.status !== "playing" || g.winner) return false;
      const arr = Array.isArray(g.fills) ? g.fills : [];
      // 交易內再驗一次:別人可能在這 100ms 內先搶到了(本地快照還沒收到)
      for (let k = 0; k < arr.length; k++) { const f = decFill(arr[k]); if (f.ok && f.i === i) return false; }
      g.fills = arr.concat(encFill(i, v, seat, 1));
    });
  }
  function erase() { showToast("搶到的格子不能清掉"); }

  // 盤面填滿就結算。誰看到誰寫,交易保證只有第一個成功(不指定「填最後一格的人」,
  // 免得那個人剛好斷線就沒人寫、整局卡住)——比照數獨的 settleGrab
  function settleGrab() {
    ctx.txGame(g => {
      if (g.winner) return false;
      const arr = Array.isArray(g.fills) ? g.fills : [];
      const t = [];
      arr.forEach(c => { const f = decFill(c); bump(t, f.seat, f.ok); });
      const ord = ctx.order();
      let best = -1;
      ord.forEach((id, s) => { if ((t[s] || 0) > best) best = (t[s] || 0); });
      const ids = ord.filter((id, s) => (t[s] || 0) === best);
      g.winner = ids.length === 1
        ? { id: ids[0], name: ctx.dispName(ids[0]), by: "score", pts: best }
        : { ids: ids, by: "draw", pts: best };
    });
  }

  /* ---------- 局間續局:結果卡按「我看完了」直接接下一盤,不回大廳(比照台灣麻將)。
     使用者:「按繼續是直接接下一句,而不是調回選單然後還要再按一次準備好了」——
     成語接龍沒有台灣麻將「打幾局」那種季末結算,所以永遠續局,不必像那邊分兩種文案。 */
  function seenBy(id) { return !!(ctx.players()[id] || {}).ready; }
  function waitCount() { return Object.keys(ctx.players()).filter(id => !seenBy(id)).length; }
  function clearNext() {
    nextKey = "";
    const el = $("cyNext"); if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
  }
  /* 腳註那一行。★ 兩種身分要講不同的事(而且是同一行,不要多長一列出來):
       還沒按 —— 提示「按了就會接著玩」
       按過了 —— 還在等幾個人(不然按完之後那顆鈕變灰、畫面沒有任何交代) */
  function paintNext() {
    const el = $("cyNext"); if (!el) return;
    if (!nextKey) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const mine = seenBy(ctx.me());
    const wait = waitCount();
    el.classList.remove("hidden");
    el.innerHTML = mine
      ? (wait > 0 ? "✓ 已看完 —— 還在等 <b>" + wait + "</b> 人…" : "✓ 大家都看完了,馬上換下一盤…")
      : "按「✓ 我看完了」,大家都按了就接著玩下一盤";
    const b = $("mpAgain");
    if (b) {
      b.textContent = mine ? "✓ 已看完" : "✓ 我看完了";
      b.classList.toggle("ghost", mine);
      b.classList.toggle("primary", !mine);
      b.disabled = mine;
    }
  }
  /* 結果卡上那顆鈕按下去。回 true = 這一次由續局接手(不要再走核心的「回大廳」)。 */
  function seeDone() {
    if (!nextKey) return false;
    ctx.readyUp();
    paintNext();
    return true;
  }

  /* ---------- 大廳設定 ---------- */
  function ruleHint() {
    const el = $("cyRuleHint"); if (!el) return;
    const L = CYGen.levelOf(diff);
    el.innerHTML = "<b>搶字</b>:大家看同一張填字盤,同時搶著填空格。填對這格就歸你 <b>+1 分</b>," +
      "盤面填滿時分數最高的人贏。填錯凍結 3 秒、不扣分。" +
      "<br>盤面 " + L.label + "(" + L.name + ")· " + L.desc;
  }

  return {
    ns: { rooms: "chengyu_rooms", index: "chengyu_index" },
    minPlayers: 2, maxPlayers: 6,
    prefsKey: "chengyu.prefs.v1",
    emoteAnchor: "cyStage",
    winCardId: "cyWinCard",
    hasResign: false,               // 限時解謎,中途認輸沒有意義
    extraNodes: [],
    /* ★ 局間續局(v1.136.0)—— 一盤結束不回大廳,結果卡按「我看完了」就 MP.readyUp(),
       湊齊由房主開下一盤。沒有台灣麻將的「打幾局」季末結算,永遠續局。 */
    contRound: true,

    init(c) { ctx = c; },

    /* ---------- 房間層級設定(比數獨少 mode/assist 兩項) ---------- */
    roomFields() { return { diff: diff }; },
    onRoomField(k, v) {
      if (k === "diff") {
        if (!CYGen.LEVELS[v] || v === diff) return;
        diff = v; ctx.unreadyOnFieldChange(); ctx.syncSetup(); ctx.updateGoal(); ruleHint();
      }
    },
    readRoom(r) { if (CYGen.LEVELS[r.diff]) diff = r.diff; },

    /* ---------- 一局的生命週期 ---------- */
    lobbyGame() { return { fills: [], puzzle: null, sol: null }; },
    resetRound() { puzKey = null; fills = []; tally = []; charList = []; },
    newGame(ids, prev) {
      const q = CYGen.make(diff);
      let ord;
      if (prev && prev.length === ids.length) ord = prev.slice(1).concat(prev[0]);
      else { ord = ids.slice(); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ord[i]; ord[i] = ord[j]; ord[j] = t; } }
      return { order: ord, fills: [], puzzle: q.puzzle, sol: q.sol, rows: q.rows, cols: q.cols, diff: diff };
    },
    applyGame(g, playing) {
      if (!playing) return;
      gDiff = CYGen.LEVELS[g.diff] ? g.diff : "std";
      // 題目換了(新的一局)→ 重建盤面 + 重算規範字元清單
      if (g.puzzle && g.puzzle !== puzKey) {
        puzKey = g.puzzle;
        CYB.setPuzzle({ rows: g.rows, cols: g.cols, puzzle: g.puzzle, sol: g.sol });
        charList = buildCharList(g.puzzle, g.sol);
        holes = CYB.remaining();
        fills = []; tally = [];
        CYB.setEnabled(true);
        CYB.setSel(CYB.firstEmpty());
      }
      const next = Array.isArray(g.fills) ? g.fills : [];
      const pops = [];
      // 能延續就只補新的幾筆,否則整盤重建(重連 / 中途歸位)
      const extend = next.length >= fills.length && fills.every((v, k) => next[k] === v);
      if (!extend) {
        tally = [];
        next.forEach(c => { const f = decFill(c); if (f.ok) CYB.fill(f.i, charList[f.v], colorOf(f.seat)); bump(tally, f.seat, f.ok); });
        fills = next.slice();
        CYB.setSel(CYB.firstEmpty());
      } else {
        const added = next.slice(fills.length);
        fills = next.slice();
        const me = mySeat();
        const quiet = added.length > 1;   // 一次補很多筆 = 重連歸位或剛開打的批次同步
        added.forEach(c => {
          const f = decFill(c);
          const before = tally[f.seat] || 0;
          bump(tally, f.seat, f.ok);
          if (!quiet) { const d = (tally[f.seat] || 0) - before; if (d) pops.push([f.seat, d]); }
          if (f.ok) {
            CYB.fill(f.i, charList[f.v], colorOf(f.seat));
            if (!quiet && f.seat !== me) {
              CYB.flashTaken(f.i);
              Sound.place();
              showToast("⚡ " + ctx.dispName(ctx.order()[f.seat] || "") + " 搶下 " + CYB.coordName(f.i), 1100);
            } else if (!quiet) Sound.place();
          } else if (!quiet && f.seat !== me) {
            showToast("😅 " + ctx.dispName(ctx.order()[f.seat] || "") + " 填錯了", 1100);
          }
        });
      }
      const done = holes > 0 && CYB.isComplete();
      renderHud();
      pops.forEach(p => popScore(p[0], p[1]));   // 一定要在 renderHud() 之後(它會重建 innerHTML)
      if (done && !ctx.winner()) settleGrab();
    },

    /* ---------- 相位的專屬畫面 ---------- */
    openConnect() { showScreen("connect"); },
    enterLobby() {
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      CYB.setEnabled(false);
      ruleHint();
    },
    backToLobby() {
      showScreen("lobby");
      $("mpBar").classList.remove("playing");
      puzKey = null; fills = []; tally = []; charList = [];
      CYB.setEnabled(false); CYB.unfreeze();
      clearNext();
      const box = $("cyHud"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
      ruleHint();
    },
    enterPlaying() {
      showScreen("play");
      $("mpBar").classList.add("playing");
      CYB.unfreeze();
      /* ★ 續局時這支是上一盤的結果卡收掉、新的一盤開打的那一刻(核心已經 closeWin)——
         腳註一定要在這裡收乾淨,不然文案會活到下一盤的結果卡再多畫一次舊的。 */
      clearNext();
      Sound.start();
    },
    onLeave() {
      puzKey = null; fills = []; tally = []; charList = [];
      CYB.setEnabled(false); CYB.unfreeze();
      clearNext();
      const box = $("cyHud"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
    },

    /* ---------- 大廳設定列 / 房間框徽章 ---------- */
    syncSetup() {
      const isHost = ctx.isHost();
      const dSeg = $("cyDiffSeg");
      if (dSeg) { dSeg.classList.toggle("readonly", !isHost); [...dSeg.children].forEach(b => b.classList.toggle("on", b.dataset.diff === diff)); }
      const dL = $("cyDiffLabel"); if (dL) dL.textContent = isHost ? "難度" : "難度(房主決定)";
      ruleHint();
    },
    updateGoal() {
      const g = $("mpBarGoal"); if (!g) return;
      const live = ctx.phase() === "playing";
      const L = CYGen.levelOf(live ? gDiff : diff);
      g.textContent = "🧩 搶字 · " + L.label;
      g.classList.remove("hidden");
    },

    /* ---------- 名單 / 文案 ---------- */
    chipLead(id) {
      const seat = seatOf(id);
      if (seat < 0) return null;
      return '<span class="cy-seat ' + colorOf(seat) + '"></span>';
    },
    chipTail(id) {
      const seat = seatOf(id); if (seat < 0) return "";
      return '<span class="cy-pts">' + (tally[seat] || 0) + '</span>';
    },
    lobbyStatusText(ids) {
      return ids.length < ctx.minPlayers
        ? "等待其他人加入…(最多 " + ctx.maxPlayers + " 人)"
        : "等待大家準備…(" + ids.length + " 人)";
    },
    readyHint(ids, ready) {
      if (ids.length < ctx.minPlayers) return "至少要 " + ctx.minPlayers + " 個人才能開始(最多 " + ctx.maxPlayers + " 人)";
      return ready ? "等其他人按準備…" : "按「準備好了」就開始";
    },
    refresh() { renderHud(); },

    /* ---------- 結果 ---------- */
    outcome(w, { iWon, isDraw }) {
      CYB.setEnabled(false); CYB.unfreeze();
      renderHud(); renderWinnerRow(w, isDraw);
      const box = $("cyStats"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
      /* 局間續局的腳註。★ 每一次都要重畫 —— outcome() 會被反覆呼叫(核心的 players / scores
         監聽一動就 showOutcome()),而「還在等 N 人」正是靠那幾次重畫才會跟著別人按鈕動。
         ⚠ 鑰匙用 roundId:重連 / 重畫時腳註才認得出「這是同一盤」而不是重新歸零。 */
      nextKey = ctx.roundId() || "-";
      paintNext();
      if (isDraw) return { word: "平手!", msg: "盤面填滿,最高分同分 🤝 各得 1 勝" };
      if (iWon) return { word: "你贏了!", msg: "拿下最高分,漂亮 🎉(" + (w.pts || 0) + " 分)" };
      return { word: "你輸了", msg: esc(w.name || "對手") + " 拿下 " + (w.pts || 0) + " 分" };
    },

    /* ---------- 偏好 ---------- */
    ownPrefs() { return { diff: diff }; },
    usePrefs(o) { if (CYGen.LEVELS[o.diff]) diff = o.diff; },

    /* ---------- 額外暴露給 main.js ---------- */
    api: {
      play, erase, seeDone,
      diff: () => diff, gameDiff: () => gDiff,
      setDiff(v) {
        if (!CYGen.LEVELS[v]) return;
        if (!ctx.setRoomField("diff", v, { lobbyOnly: true, denyMsg: "只有房主能改難度", busyMsg: "對戰中不能改難度" })) return;
        diff = v; ctx.syncSetup(); ctx.updateGoal(); savePrefs();
      }
    }
  };

  /* 「這局是誰拿下」:大字是主觀的,這一列給客觀事實 —— 顏色 + 名字 +(你) */
  function renderWinnerRow(w, isDraw) {
    const el = $("cyWinner"); if (!el) return;
    const ids = Array.isArray(w.ids) ? w.ids : (w.id ? [w.id] : []);
    if (!ids.length) { el.innerHTML = ""; return; }
    const body = ids.map(id => {
      const seat = seatOf(id);
      const dot = seat >= 0 ? '<span class="cy-seat ' + colorOf(seat) + '"></span>' : '';
      return dot + '<span class="gw-name">' + esc(ctx.dispName(id)) + '</span>' + ctx.youTag(id);
    }).join('<span class="gw-tag">·</span>');
    el.innerHTML = body + '<span class="gw-tag">' + (isDraw ? "並列第一,各得 1 勝" : "拿下這局") + '</span>';
  }
})());

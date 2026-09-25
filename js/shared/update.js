"use strict";

/* ============================================================================
   更新看得見 —— 十六頁共用(含 Bingo)· 2026-09-25
   ─────────────────────────────────────────────────────────────────────────
   ★★★ 這一支解決的事:遊戲一更新,Service Worker 就在背景下載新版 —— 玩家完全不知道,
       只覺得「怎麼突然好慢好卡」。這一支把那段時間**畫出來**:
         ① 背景下載中     → 畫面上方一顆小膠囊「⬇ 下載新版 3/12」+ 進度條
         ② 下載好了       → 「✓ 新版下載好了」一下就收;同時叫更新檢查**馬上**比一次版號
                             (不必等下一個五分鐘),回主選單時就會自動套用
         ③ 更新落地之後   → 「🎉 v2.x 更新了什麼」一句話(內容在 whatsnew.json)
       另外兩件不畫出來、但同樣是在治「好卡」的事:
         ④ busy(on)       → 告訴正在下載的新版 SW「有人在對局」,它會先停手讓路
         ⑤ 第一次進站     → 存離線資料那一段也照樣顯示(那是最大的一包)
   ★ 狀態的來源是 sw.js 的 tell()({t:"bingo.sw", st:"dl"|"ok"|"fail"|"on", done, total, ver})。

   ★★ 檔案結構照 qr.js 的先例:**邏輯與 UI 收在同一支、元素自己建**,十六頁只多一行 <script>,
      零雙胞胎。更新檢查本體(updTick / updApply)仍是 js/main.js 與 ui-kit.js 那組雙胞胎,
      它們只**呼叫**這裡(`typeof UpdUI!=="undefined"` 守著,少載這支也不會壞)。
   ⚠ 這裡**不可以**自己宣告 `$` / `showToast`(Bingo 在 game.js、十五頁在 ui-kit.js 各有全域定義,
     重複宣告 const 會整頁 SyntaxError)—— 這一支一個全域都不用它們。
   ⚠ 膠囊刻意 `pointer-events:none`(只有「更新了什麼」那張可以點掉):它浮在頂列上面,
     對局中擋到按鈕是大忌(方塊 / 泡泡的操作鍵整排在畫面上)。
   ========================================================================== */
const UpdUI = (function () {
  const SHOW_AFTER_MS = 1200;   // 很快就抓完的(一兩個檔)不必閃一下
  const baseVer = v => String(v || "").replace(/\+.*$/, "");
  const sw = ("serviceWorker" in navigator) ? navigator.serviceWorker : null;
  let el = null, txt = null, bar = null, hideT = 0, showT = 0, shown = false;
  // 這一頁開的時候有沒有 SW 在管 → 沒有 = 第一次進站(或剛強制更新過),下載的是離線資料
  const firstRun = !!sw && !sw.controller;

  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "upd-pill";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    txt = document.createElement("span");
    bar = document.createElement("i");
    el.appendChild(txt); el.appendChild(bar);
    el.addEventListener("click", () => { if (el.classList.contains("upd-news")) hide(); });
    document.body.appendChild(el);
    return el;
  }
  function show(text, opt) {
    opt = opt || {};
    ensure();
    clearTimeout(hideT);
    txt.textContent = text;
    el.classList.toggle("upd-news", !!opt.news);
    el.classList.toggle("upd-bar", opt.pct != null);
    if (opt.pct != null) bar.style.width = Math.round(opt.pct * 100) + "%";
    el.classList.add("upd-on");
    shown = true;
    if (opt.ms) hideT = setTimeout(hide, opt.ms);
  }
  function hide() {
    clearTimeout(hideT); clearTimeout(showT); showT = 0;
    if (el) el.classList.remove("upd-on");
    shown = false;
  }

  let dl = null;   // 最近一次下載進度 {done,total}
  function dlText(d) {
    return (firstRun ? "⬇ 存離線資料 " : "⬇ 下載新版 ") + d.done + "/" + d.total +
           (firstRun ? "" : " · 網路會慢一點");
  }
  function onMsg(e) {
    const d = e && e.data;
    if (!d || d.t !== "bingo.sw") return;
    if (d.st === "dl" && d.total > 0) {
      dl = d;
      if (shown && !el.classList.contains("upd-news")) show(dlText(d), { pct: d.done / d.total });
      else if (!showT && !shown) showT = setTimeout(() => { showT = 0; if (dl && dl.done < dl.total) show(dlText(dl), { pct: dl.done / dl.total }); }, SHOW_AFTER_MS);
      return;
    }
    if (d.st === "ok") {
      const wasShown = shown && el && !el.classList.contains("upd-news");
      clearTimeout(showT); showT = 0;
      /* 這一頁本身已經是那一版(例如剛重載完、SW 才在補抓)→ 不可以說「回主選單就會更新」,
         那一句要留給「頁面還是舊的、新版已經在等」的時候。 */
      const m = document.querySelector('meta[name="version"]');
      const same = !!m && baseVer(m.content) === d.ver;
      if (wasShown) show(firstRun ? "✓ 離線也能玩了" : same ? "✓ 離線資料更新好了" : "✓ 新版下載好了,回主選單就會更新", { ms: 2600 });
      dl = null;
      return;
    }
    if (d.st === "fail") {
      clearTimeout(showT); showT = 0;
      if (shown && !el.classList.contains("upd-news")) show("新版沒下載完,等一下會再試", { ms: 3000 });
      dl = null;
      return;
    }
    if (d.st === "on") {
      /* 新版 SW 接手了 → 叫更新檢查現在就比一次版號(兩份雙胞胎的 initUpdateCheck 聽這個事件)。
         ⚠ 頁面本身已經是這一版就沒事可做,檢查那邊比對一致會安靜收工。 */
      try { dispatchEvent(new CustomEvent("bingo:swready", { detail: { ver: d.ver } })); } catch (_) { }
    }
  }
  if (sw) {
    try { sw.addEventListener("message", onMsg); } catch (_) { }
    // ⚠ 沒有 startMessages() 的話,addEventListener 掛上去的 message 要等 DOMContentLoaded 才開始送
    try { if (sw.startMessages) sw.startMessages(); } catch (_) { }
  }

  /* ④ 對局中請新版 SW 先停手。由更新檢查的心跳(4 秒一次)呼叫,只在真的有新版在裝時才送。 */
  let lastBusy = null, lastBusyAt = 0;
  function busy(on) {
    if (!sw || !sw.getRegistration) return;
    on = !!on;
    // 狀態沒變就 10 秒補送一次(SW 那邊 15 秒過期,不補會自己恢復下載)
    if (on === lastBusy && Date.now() - lastBusyAt < 10000) return;
    lastBusy = on; lastBusyAt = Date.now();
    sw.getRegistration().then(r => {
      if (!r) return;
      [r.installing, r.waiting].forEach(w => { if (w) try { w.postMessage({ t: "bingo.busy", on }); } catch (_) { } });
    }).catch(() => { });
  }

  /* ③ 更新落地之後:「🎉 vX 更新了什麼」。from / to 是重載前後的版號。
     ⚠ 只在**正式版號**變了才顯示:驗證版 2.19.0+1 → +2 是測試人員自己在看,每次都跳很吵。
     ⚠ whatsnew.json 抓不到 / 沒寫這一版 → 什麼都不顯示(兩份雙胞胎自己的「已更新到 vX 🎉」照樣會跳)。 */
  function landed(from, to) {
    if (!to || baseVer(from) === baseVer(to)) return;
    fetch("whatsnew.json").then(r => r.ok ? r.json() : null).then(j => {
      const note = j && (j[to] || j[baseVer(to)]);
      if (!note) return;
      setTimeout(() => show("🎉 v" + baseVer(to) + " 更新了:" + note, { news: true, ms: 8000 }), 3600);
    }).catch(() => { });
  }

  return { busy, landed, show, hide };
})();

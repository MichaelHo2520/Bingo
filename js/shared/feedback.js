"use strict";

/* ============================================================================
   問題回報與建議 —— 十四頁共用
   ──────────────────────────────────────────────────────────────────────────
   ★★★ 這一支解決的事:現場回報永遠是「麻將打到一半卡住了」「某個按鈕點不到」——
       沒有版號、沒有房號、沒有機型、沒有錯誤訊息。而受眾是親友聚會,不會有人
       去開 GitHub issue、也不會有人記得自己載到的是哪一版。
       → 遊戲內填一段話送出,**版號 / 房號 / 螢幕尺寸 / 主題 / UA / 最近三筆 JS 錯誤
         由程式自己附上**。玩家要做的只有「講一句遇到什麼事」。

   ★★ 檔案結構照 `qr.js`(CLAUDE.md 紅線 4 的 ★★):**鈕與蓋板都由這一支自己建**,
      十四頁(含 Bingo)只多一行 `<script>` —— 零雙胞胎。
      進入點是**設定面板最底下那一組**:那是十四頁唯一「每一頁都有、位置一樣、
      而且對局中也開得到」的容器(`#setBody`),而且它已經是「⚙️ 裡的雜項」該去的地方。
   ⚠ 這裡**不可以**自己宣告 `$` / `showToast`:那兩個在 game.js(Bingo)與
     ui-kit.js(十三頁)各有一份全域定義,重複宣告 const 會整頁 SyntaxError。

   ── 六條紅線 ──────────────────────────────────────────────────────────────
   ① **寫入走公開 REST(`fetch(databaseURL + "/feedbacks.json")`),不透過 Firebase SDK。**
      十三頁的 SDK 是**進連線才動態載入**的(`mp-core.js` 的 initializeApp),
      而回報最需要在的時機恰恰是「還沒連線、或連線爛掉」—— 靠 SDK 就等於要玩家先
      成功進一間房才回報得了。同一條路 `js/home-live.js` 的伺服器狀態面板已經走了很久。

   ② **錯誤環形緩衝要在「載入時」就掛上,不可以搬進 `bindUi()`。**
      要抓的正是「某一支 JS 炸了 → 畫面壞掉 → 玩家來回報」,而炸掉的那一支很可能
      就是 `bindUi()` 的呼叫端(`bindCommonUI` / `js/main.js`)—— 那時 bindUi 根本沒跑到。
      所以 `window.addEventListener("error", …)` 寫在模組最外層,而且這一支要**排在
      其他 `<script>` 前面**(十四頁一律緊接 `js/audio.js` 之後)。
   ⚠ `capture:true` 不可省:資源載入失敗(`<script>` / `<img>` / `<audio>` 的 error)
     **不冒泡**,只能在捕獲階段收到 —— 而那是 PWA 最常見的壞法(離線抓不到 mp3 / SDK)。

   ③ **成功與失敗都不可以吞掉。** 送出失敗最可能的原因是**資料庫規則還沒貼上去**
      (Firebase Console 的規則不在這個 repo 裡,`notes/firebase-rules.json` 只是本機
      的一份紀錄)—— 那會回 401,而如果 catch 只是靜靜關掉蓋板,玩家會以為送出了,
      開發者則永遠收不到任何一筆而且**完全不知道**。

   ④ **失敗時絕不清掉輸入框。** 現場網路爛是常態,而玩家剛剛打了一段話。
      → 草稿一律存在 localStorage(`bingo.fb.v1`),下次開回來自動帶回;
      送出成功才清掉。⚠ 草稿是**這一支自己的 key**,不寄生在 `bingo.prefs.v1`
      (紅線 12:那一份是六頁共用的,而且「強制更新」刻意碰不到 localStorage)。

   ⑤ **診斷資訊沒有關閉開關,但一律看得到。** 拿掉診斷等於把這個功能變回口頭回報,
      所以不做「☑ 附帶」那顆勾選;取而代之的是一顆「看一下要送出什麼」的展開鈕,
      而且展開的內容就是真的會送出去的那些欄位(不是另外寫一段文案)。
   ⚠ 因此蒐集端**不准放任何「玩家沒看到的東西」** —— 展開的清單與 payload 必須同源,
     這一支唯一的來源是 `collect()`,`preview()` 只是把它排版。

   ⑥ **`Feedback.close()` 必須存在,而且 `#fbVeil` 要列進 BACK_LAYERS(兩份)。**
      漏了的話手機按返回鍵會**穿過去**做下一層的事 —— 在房裡就是跳「離開房間?」
      (誤按確認 = 房主關房、全房重開)。順序要排在 `setVeil` **前面**:
      它是從設定面板裡開出來的,疊在設定上面。
   ========================================================================== */

const Feedback = (function () {

  /* ==========================================================================
     第一部分:錯誤環形緩衝(★ 在載入時就掛上,見紅線 ②)
     ──────────────────────────────────────────────────────────────────────────
     只留最近三筆。為什麼不是全部:同一個壞掉的 render 迴圈一秒可以噴幾百筆,
     而對除錯有用的永遠是「最後幾筆」+「第一筆」—— 而第一筆通常也就在最後幾筆裡
     (真正的連鎖崩潰會一直重複同一則訊息)。三筆讓 payload 穩定在 5KB 以下。
     ========================================================================== */

  const ERR_MAX = 3;
  const ERR_MSG_MAX = 240;      // 單則訊息上限(堆疊很長的例外會把 payload 撐爆)
  const errs = [];

  function clock() {
    const d = new Date(), p = n => (n < 10 ? "0" : "") + n;
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function pushErr(msg, src) {
    msg = String(msg == null ? "(沒有訊息)" : msg).slice(0, ERR_MSG_MAX);
    /* 同一則連續重複(壞掉的迴圈)只累加次數,不吃掉另外兩個名額 —— 不然三筆
       全是同一句,而真正有用的「它之前發生了什麼」就被擠掉了。 */
    const last = errs[errs.length - 1];
    if (last && last.m === msg) { last.n = (last.n || 1) + 1; last.t = clock(); return; }
    errs.push({ t: clock(), m: msg, s: String(src || "").slice(0, 140) });
    while (errs.length > ERR_MAX) errs.shift();
  }

  /* ⚠ capture 一定要 true:資源載入失敗不冒泡到 window(紅線 ②)。
     ⚠ 資源的 error 事件沒有 message / filename,要從 e.target 撈 —— 而
       `e.target !== window` 正是分辨這兩種 error 的判準(不要用 instanceof
       ErrorEvent:舊 WebView 上不見得靠得住)。 */
  window.addEventListener("error", function (e) {
    try {
      const t = e && e.target;
      if (t && t !== window && t.tagName) {
        pushErr("資源載不到:" + String(t.currentSrc || t.src || t.href || t.tagName), t.tagName);
        return;
      }
      pushErr(e && e.message, ((e && e.filename) || "") + ":" + ((e && e.lineno) || 0));
    } catch (err) { }
  }, true);

  /* 未處理的 Promise rejection。★ 這一類在這個專案特別值錢:Firebase / getUserMedia /
     WebRTC / play() 全部是 Promise,而它們失敗時畫面上什麼都不會說。 */
  window.addEventListener("unhandledrejection", function (e) {
    try {
      const r = e && e.reason;
      pushErr("未處理的 Promise:" + ((r && r.message) ? r.message : String(r)), (r && r.name) || "");
    } catch (err) { }
  });

  /* ==========================================================================
     第二部分:診斷蒐集(純讀,零寫入)
     ──────────────────────────────────────────────────────────────────────────
     ★★ 每一項都刻意**從畫面上已經有的東西讀**,不新增任何「加一個遊戲要登記一筆」
       的清單(CLAUDE.md 那條「漏登記沒有測試會紅」的老問題):
         · 遊戲名 → `.set-foot` 的第一段(十四頁本來就各寫了自己的名字)
         · 版號   → `<meta name="version">`(`paintVersion()` 讀的也是這一份)
         · 房號   → `RoomShare.room()`(連線層本來就餵它,見那一支的 setRoom)
         · 主題   → `<html data-theme>`
       → 第十五個遊戲加進來時,這一支一行都不用改。
     ⚠ localStorage 一律只讀。這一支**不可以**出現 setItem 到 `bingo.prefs.v1` /
       `bingo.pid`(紅線 12);它自己的草稿走自己的 key(紅線 ④)。
     ========================================================================== */

  function metaVer() {
    const m = document.querySelector('meta[name="version"]');
    return (m && m.content) || "";
  }
  /* 「大老二 · v2.10.0 · 開發者 Michael Ho」→「大老二」。
     ⚠ 用 `·` 切:十四頁的 .set-foot 都是這個格式,而遊戲名本身沒有一個含 `·`。 */
  function gameName() {
    const el = document.querySelector(".set-foot");
    if (!el) return "";
    return String(el.textContent || "").split("·")[0].trim().slice(0, 20);
  }
  function pageName() {
    const p = location.pathname.split("/").pop();
    return p || "index.html";
  }
  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function nick() {
    try { return (JSON.parse(localStorage.getItem("bingo.prefs.v1")) || {}).name || ""; }
    catch (e) { return ""; }
  }
  function standalone() {
    try {
      if (window.matchMedia && matchMedia("(display-mode: standalone)").matches) return true;
    } catch (e) { }
    return navigator.standalone === true;
  }
  /* 目前在哪一間房。★ 這件事的持有者是 `js/shared/qr.js`:連線層兩份平行實作
     (mp-core.js / online.js)本來就在進房 / 離房時各叫一次 `RoomShare.setRoom()`,
     所以這裡向它借,而不是去連線層再加兩對掛載點(那會變成第三組要同步的雙胞胎)。
     ⚠ 一律 typeof 判斷:qr.js 是選配的(同 Talk 的規矩)。 */
  function roomCode() {
    try {
      if (typeof RoomShare !== "undefined" && RoomShare && RoomShare.room) {
        const r = RoomShare.room();
        return (r && r.code) || "";
      }
    } catch (e) { }
    return "";
  }

  function collect() {
    const vv = window.visualViewport;
    return {
      page: pageName(),
      game: gameName(),
      ver: metaVer(),
      room: roomCode(),
      inRoom: document.body.classList.contains("mp-on"),
      pid: lsGet("bingo.pid"),
      nick: nick(),
      /* body 的 class 一次講完「大 / 小」、在不在房裡、偷看牌面、各遊戲的 solo 旗標 ——
         一個欄位換掉五個各自要登記的旗標,而且新遊戲加了自己的 class 也自動帶到。 */
      body: String(document.body.className || "").slice(0, 160),
      env: {
        screen: screen.width + "x" + screen.height,
        view: Math.round(window.innerWidth) + "x" + Math.round(window.innerHeight),
        /* visualViewport 是**鍵盤彈出 / 網址列收放之後真正看得到的那一塊** ——
           「按鈕點不到」的回報有一半是它與 innerHeight 差很多造成的。 */
        vv: vv ? (Math.round(vv.width) + "x" + Math.round(vv.height)) : "",
        dpr: window.devicePixelRatio || 1,
        pwa: standalone(),
        theme: document.documentElement.getAttribute("data-theme") || "",
        lang: navigator.language || "",
        online: navigator.onLine !== false,
        ua: String(navigator.userAgent || "").slice(0, 220)
      },
      errs: errs.slice()
    };
  }

  /* 展開時給玩家看的排版。★ 來源只有 collect() 一個(紅線 ⑤)—— 這裡只排版,
     不准多算任何一個欄位,也不准少印任何一個會送出去的欄位。 */
  function preview(d) {
    const L = [];
    L.push("遊戲:" + (d.game || "?") + "(" + d.page + ") · " + (d.ver ? "v" + d.ver : "版號不明"));
    L.push("房間:" + (d.room ? d.room : "沒在房裡") + (d.inRoom ? "(對局畫面)" : ""));
    L.push("玩家:" + (d.nick || "(沒取暱稱)") + " · " + (d.pid || "?"));
    L.push("畫面:" + d.env.screen + " · 視窗 " + d.env.view +
           (d.env.vv && d.env.vv !== d.env.view ? " · 可視 " + d.env.vv : "") +
           " · dpr " + d.env.dpr + (d.env.pwa ? " · 已加到主畫面" : ""));
    L.push("狀態:主題 " + (d.env.theme || "?") + " · " + (d.env.online ? "有網路" : "離線") +
           " · " + (d.env.lang || "?"));
    L.push("body:" + (d.body || "(空)"));
    L.push("瀏覽器:" + d.env.ua);
    if (d.errs.length) {
      L.push("最近的錯誤:");
      d.errs.forEach(e => L.push("  " + e.t + "  " + e.m + (e.n > 1 ? "(×" + e.n + ")" : "") +
                                 (e.s ? "  @ " + e.s : "")));
    } else {
      L.push("最近的錯誤:沒有 🎉");
    }
    return L.join("\n");
  }

  /* ==========================================================================
     第三部分:送出(公開 REST,見紅線 ①)
     ========================================================================== */

  const LEN_MIN = 5, LEN_MAX = 1000;      // ⚠ 與 notes/firebase-rules.json 的 .validate 對齊
  const CONTACT_MAX = 40;
  const COOL_MS = 30000;                  // 防連點 / 洗版:同一台裝置 30 秒一筆
  const KEY = "bingo.fb.v1";              // { at:最後送出時間, d:草稿, t:類型, c:聯絡方式 }

  const TYPES = [
    { id: "bug",   lbl: "🐛 問題", ph: "哪一頁、玩到什麼時候、按了什麼之後怪怪的?\n例:大老二打到第 3 局,出牌鈕按了沒反應" },
    { id: "idea",  lbl: "💡 建議", ph: "想玩什麼新遊戲、或哪個地方想多一個功能?\n例:希望麻將可以設定「不算花牌」" },
    { id: "other", lbl: "💬 其他", ph: "配色、字太小、音效、操作手感…什麼都可以講" }
  ];

  function toast(msg, dur) {
    // 兩份都叫 showToast(game.js / ui-kit.js),但這一支可能被沒有它的頁面載入
    try { if (typeof showToast === "function") showToast(msg, dur); } catch (e) { }
  }
  function store() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function put(patch) {
    /* ⚠ 這是這一支**自己的** key,但照樣 merge 寫回:草稿與冷卻時間是兩件事,
       整份覆寫會讓「存草稿」把冷卻紀錄抹掉 = 防連點失效。 */
    try { localStorage.setItem(KEY, JSON.stringify(Object.assign(store(), patch))); } catch (e) { }
  }
  function coolLeft() {
    const at = Number(store().at || 0);
    if (!at) return 0;
    const left = COOL_MS - (Date.now() - at);
    /* ⚠ 時鐘被往前調過(或跨裝置同步)時 left 會大得離譜 → 一律夾住,
       不然玩家會被鎖到永遠送不出去,而且完全看不出原因。 */
    return (left > 0 && left <= COOL_MS) ? left : 0;
  }
  function dbUrl() {
    const base = (typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG &&
                  FIREBASE_CONFIG.databaseURL) || "";
    return base ? base.replace(/\/+$/, "") + "/feedbacks.json" : "";
  }

  /* ==========================================================================
     第四部分:UI(蓋板與觸發鈕都是這一支自己建的)
     ========================================================================== */

  let built = false, sending = false, curType = "bug", saveT = 0;

  function el(id) { return document.getElementById(id); }

  function build() {
    if (built) return;
    const body = el("setBody");
    if (!body) return;                    // 這一頁沒有設定面板

    /* ---- 設定面板最底下那一組(十四頁的 HTML 一個字都不必改)---- */
    const grp = document.createElement("div");
    grp.className = "set-group";
    grp.innerHTML =
      '<div class="set-group-title">回報</div>' +
      '<div class="set-row">' +
        '<span class="set-lbl">問題與建議<span class="set-sub">直接送給開發者</span></span>' +
        '<button class="btn ghost fb-open" id="fbOpenBtn" type="button">💬 回報</button>' +
      '</div>';
    body.appendChild(grp);

    /* ---- 蓋板 ---- */
    const veil = document.createElement("div");
    veil.className = "veil";
    veil.id = "fbVeil";
    veil.innerHTML =
      '<div class="set-card fb-card">' +
        '<button class="card-x" id="fbX" type="button" aria-label="關閉">✕</button>' +
        '<div class="set-head">問題回報與建議</div>' +
        '<div class="seg fb-seg" id="fbSeg" aria-label="回報類型">' +
          TYPES.map((t, i) => '<button type="button" class="' + (i === 0 ? "on" : "") +
                              '" data-t="' + t.id + '">' + t.lbl + '</button>').join("") +
        '</div>' +
        '<textarea class="fb-ta" id="fbText" rows="5" maxlength="' + LEN_MAX + '"></textarea>' +
        '<div class="fb-count" id="fbCount"></div>' +
        '<input class="mp-input fb-contact" id="fbContact" type="text" maxlength="' + CONTACT_MAX + '"' +
               ' placeholder="暱稱 / LINE / Email(選填,方便回你)" autocomplete="off">' +
        /* 診斷:一律附帶(紅線 ⑤),但一定看得到。⚠ 展開鈕用 ▾ / ▴ 這種幾何字元,
           **不用 emoji**(☑ U+2611 是「預設文字呈現」,不帶 U+FE0F 桌機會退回線條字形,
           而它就在一顆會換底色的鈕上 —— CLAUDE.md 紅線 8 的 ⚠⚠)。 */
        '<button class="fb-diag-t" id="fbDiagT" type="button" aria-expanded="false">' +
          '<span class="fb-diag-lbl">會一起送出:<b id="fbDiagSum"></b></span>' +
          '<span class="fb-caret" id="fbCaret">▾</span>' +
        '</button>' +
        '<pre class="fb-diag hidden" id="fbDiag"></pre>' +
        /* ⚠⚠ 取消一定要是 `btn ghost`,**不可以只寫 `btn`**:`.btn` 本身
           **一個 background 都沒宣告** → 落回瀏覽器預設的白色實心鈕,在卡片上比
           主鈕還搶眼(放大截圖上一眼就看得到,尤其 bubblegum)。次按鈕的那一層
           面是 `.btn.ghost` 在給的(見 styles.src.css 那條的 ⚠⚠)。 */
        '<div class="fb-acts">' +
          '<button class="btn primary fb-btn" id="fbSend" type="button">送出</button>' +
          '<button class="btn ghost fb-btn" id="fbCancel" type="button">取消</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(veil);

    el("fbOpenBtn").addEventListener("click", open);
    el("fbX").addEventListener("click", close);
    el("fbCancel").addEventListener("click", close);
    veil.addEventListener("click", e => { if (e.target === veil) close(); });

    el("fbSeg").addEventListener("click", e => {
      const b = e.target.closest ? e.target.closest("button[data-t]") : null;
      if (!b) return;
      setType(b.dataset.t);
    });

    /* 字數 + 草稿。⚠ 草稿存 localStorage 要節流:textarea 的 input 是每一個字一次,
       而 setItem 是同步的(在慢裝置上打字會頓)。 */
    el("fbText").addEventListener("input", () => {
      syncCount();
      clearTimeout(saveT);
      saveT = setTimeout(() => put({ d: el("fbText").value }), 400);
    });
    el("fbContact").addEventListener("input", () => {
      clearTimeout(saveT);
      saveT = setTimeout(() => put({ c: el("fbContact").value }), 400);
    });

    el("fbDiagT").addEventListener("click", () => {
      const box = el("fbDiag"), on = box.classList.toggle("hidden");
      el("fbDiagT").setAttribute("aria-expanded", on ? "false" : "true");
      el("fbCaret").textContent = on ? "▾" : "▴";
    });

    el("fbSend").addEventListener("click", send);

    built = true;
  }

  function setType(id) {
    if (!TYPES.some(t => t.id === id)) return;
    curType = id;
    [...el("fbSeg").children].forEach(b => b.classList.toggle("on", b.dataset.t === id));
    el("fbText").placeholder = TYPES.filter(t => t.id === id)[0].ph;
    put({ t: id });
  }

  function syncCount() {
    const n = el("fbText").value.trim().length;
    const c = el("fbCount");
    c.textContent = n < LEN_MIN ? ("再多打幾個字…(" + n + " / 至少 " + LEN_MIN + ")")
                                : (n + " / " + LEN_MAX);
    c.classList.toggle("warn", n < LEN_MIN);
  }

  function open() {
    build();
    const veil = el("fbVeil");
    if (!veil) return;

    const s = store();
    setType(TYPES.some(t => t.id === s.t) ? s.t : "bug");
    el("fbText").value = String(s.d || "");           // 上次沒送出去的草稿(紅線 ④)
    el("fbContact").value = String(s.c || "");
    syncCount();

    /* 診斷:每次開都重新蒐集(房號 / 尺寸 / 錯誤都會變),而展開狀態一律收回 ——
       開蓋板第一眼要看到的是輸入框,不是一大段技術文字。 */
    const d = collect();
    el("fbDiagSum").textContent =
      (d.game || "?") + " · " + (d.ver ? "v" + d.ver : "版號不明") + " · " + d.env.view +
      (d.room ? " · 房 " + d.room : "") + (d.errs.length ? " · " + d.errs.length + " 筆錯誤" : "");
    el("fbDiag").textContent = preview(d);
    el("fbDiag").classList.add("hidden");
    el("fbDiagT").setAttribute("aria-expanded", "false");
    el("fbCaret").textContent = "▾";

    setSending(false);
    veil.classList.add("show");
  }

  function close() {
    const veil = el("fbVeil");
    if (!veil) return;
    /* ⚠ 關掉前先把草稿落地:節流的 400ms 還沒到就關掉的話,最後幾個字會不見
       (而「打完馬上關掉」正是最常見的操作)。 */
    clearTimeout(saveT);
    if (built) put({ d: el("fbText").value, c: el("fbContact").value, t: curType });
    veil.classList.remove("show");
  }

  function setSending(on) {
    sending = !!on;
    const b = el("fbSend");
    if (!b) return;
    b.disabled = sending;
    b.textContent = sending ? "送出中…" : "送出";
  }

  function send() {
    if (sending) return;
    const txt = el("fbText").value.trim();
    if (txt.length < LEN_MIN) {
      toast("再多講一點吧,至少 " + LEN_MIN + " 個字");
      el("fbText").focus();
      return;
    }
    const left = coolLeft();
    if (left > 0) {
      toast("剛剛才送過一筆,再等 " + Math.ceil(left / 1000) + " 秒", 1600);
      return;
    }
    const url = dbUrl();
    if (!url) { toast("這一頁找不到資料庫設定,送不出去"); return; }
    /* ⚠ 離線先擋下來:fetch 在離線時的失敗訊息是 TypeError,分不出「沒網路」與
       「規則沒貼」—— 而這兩件事玩家該看到的話完全不同(一個等一下再送,一個要找開發者)。 */
    if (navigator.onLine === false) {
      toast("現在沒有網路 —— 你打的字已經存起來了,等有網路再回來送", 2600);
      return;
    }

    const rec = {
      ts: Date.now(),
      at: new Date().toISOString(),
      type: curType,
      content: txt.slice(0, LEN_MAX),
      contact: el("fbContact").value.trim().slice(0, CONTACT_MAX),
      diag: collect()
    };

    setSending(true);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec)
    }).then(r => {
      if (r.ok) return r.json();
      /* ★ 401 幾乎一定是「資料庫規則還沒補 feedbacks 那一段」(紅線 ③)——
         這個訊息要看得懂,不可以只寫「送出失敗」。 */
      const e = new Error(r.status === 401 || r.status === 403
        ? "資料庫還沒開放回報(規則要補 feedbacks 那一段)"
        : ("送出被拒絕:HTTP " + r.status));
      e.hard = true;
      throw e;
    }).then(() => {
      put({ at: Date.now(), d: "" });      // ★ 只有成功才清草稿
      el("fbText").value = "";
      syncCount();
      setSending(false);
      close();
      toast("收到了,謝謝你的回報 🎉", 2200);
    }).catch(err => {
      setSending(false);
      /* ⚠ 一律不清輸入框(紅線 ④)、一律不關蓋板 —— 玩家要看得到自己那段話還在。 */
      toast((err && err.hard) ? err.message : "送不出去(網路不通?)—— 你打的字還在,等一下再按送出", 3000);
    });
  }

  return {
    /* 一頁接問題回報要做的兩件事之一(另一件是載入這支)。
       ⚠ 這一支建的鈕住在**設定面板裡**,所以不必像 qr.js 那樣等 setRoom() 才亮 ——
         沒在房裡照樣回報得了(而「還沒進得去房間」本身就是要回報的事)。 */
    bindUi() { build(); },

    open: open,
    close: close,

    /* 診斷用(產品碼不呼叫這兩支,比照 RoomShare.matrix() / Talk.iceServers() 的先例):
       · collect() → tools/t-feedback.html 檢查蒐集到的欄位
       · preview() → 對照「展開看到的」與「真的送出去的」是同一份(紅線 ⑤) */
    collect: collect,
    preview: preview
  };
})();

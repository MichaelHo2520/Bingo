/* BINGO Service Worker
   策略:network-first（同源請求一律先走網路 → 線上永遠拿到最新版,徹底避免「改完上傳卻吃到舊快取、更新出不來」)。
   網路失敗(離線)才回退到快取,提供離線可玩 + 「加到主畫面」的體驗。
   CACHE 名稱帶版本號:每次部署把 VERSION 跟著 App 版本一起改,activate 時會清掉舊版快取。
   注意:外部資源(Firebase SDK、Google Fonts)不攔截,交給瀏覽器自行處理。 */
const VERSION = "1.63.0";
const CACHE = "bingo-" + VERSION;
const CORE = [
  "./",
  "./app.html",        // 外殼(PWA 的 start_url):三個遊戲跑在它的 iframe 裡,全螢幕掛在它身上
  "./index.html",
  "./styles.css",
  "./js/audio.js",
  "./js/game.js",
  "./js/online.js",
  "./js/home-live.js",   // 首頁「現在有人在玩」看板(只有 index.html 載入)
  "./js/main.js",
  // 五子棋 / 數獨共用的連線核心與介面工具箱(Bingo 不載入這兩支)
  "./js/shared/ui-kit.js",
  "./js/shared/mp-core.js",
  "./js/shared/mj-faces.js",   // 麻將牌面自繪(消消樂與台灣 16 張共用)
  // 台灣 16 張麻將(第五個遊戲,v1.58.0)
  "./mahjong16.html",
  "./js/mahjong16/rules.js",
  "./js/mahjong16/scoring.js",
  "./js/mahjong16/table.js",
  "./js/mahjong16/ai.js",
  "./js/mahjong16/sfx.js",     // 摸打吃碰槓胡的音效(v1.61.0)
  "./js/mahjong16/board.js",
  "./js/mahjong16/solo.js",
  "./js/mahjong16/adapter.js",
  "./js/mahjong16/main.js",
  // 五子棋(獨立頁面,共用 styles.css 與 js/audio.js;連線 + 電腦對決)
  "./gomoku.html",
  "./js/gomoku/board.js",
  "./js/gomoku/ai.js",
  "./js/gomoku/solo.js",
  "./js/gomoku/adapter.js",
  "./js/gomoku/main.js",
  // 數獨(獨立頁面,單機 + 連線)
  "./sudoku.html",
  "./js/sudoku/gen.js",
  "./js/sudoku/board.js",
  "./js/sudoku/solo.js",
  "./js/sudoku/adapter.js",
  "./js/sudoku/main.js",
  // 麻將消消樂(獨立頁面,單機 + 連線)
  "./mahjong.html",
  "./js/mahjong/gen.js",
  "./js/mahjong/board.js",
  "./js/mahjong/solo.js",
  "./js/mahjong/adapter.js",
  "./js/mahjong/main.js",
  "./mp3/bgm.mp3",
  "./mp3/Sunday_Morning.mp3",
  "./mp3/win.wav",
  "./mp3/lose.wav",
  /* 台灣麻將的喊牌語音(v1.62.0,由 tools/gen-mj16-voice.ps1 產生,共約 65KB)。
     ⚠ 這五個**確實存在**才列進來 —— addAll() 是全有全無的,清單裡有一個 404
     整批快取就失敗(離線變成整個不能玩)。所以刪音檔的時候一定要一起把這幾行拿掉。
     ⚠ 另一組「使用者自己要放的音效檔」(mp3/m16-pong.mp3 之類)刻意**不列**:那些還不存在,
     走 network-first 的順手快取,放進 mp3/ 之後第一次播就會被收進來。 */
  "./mp3/m16-voice-pong.wav",
  "./mp3/m16-voice-chow.wav",
  "./mp3/m16-voice-kong.wav",
  "./mp3/m16-voice-hu.wav",
  "./mp3/m16-voice-zimo.wav",
  "./mp3/m16-voice-washout.wav",
  "./mp3/是要多久.m4a",
  "./mp3/啊西好了沒.m4a",
  "./mp3/快點，來不急啦.m4a",
  "./mp3/聽牌.m4a",
  "./mp3/你就趕快啦.m4a",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k.indexOf("bingo-") === 0).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 外部(Firebase / 字型)不攔,直接走網路

  // network-first:先網路(順手更新快取),失敗才回退快取;導覽請求離線時退回外殼 app.html
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("./app.html") : Response.error())))
  );
});

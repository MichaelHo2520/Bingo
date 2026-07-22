/* BINGO Service Worker
   策略:network-first（同源請求一律先走網路 → 線上永遠拿到最新版,徹底避免「改完上傳卻吃到舊快取、更新出不來」)。
   網路失敗(離線)才回退到快取,提供離線可玩 + 「加到主畫面」的體驗。
   CACHE 名稱帶版本號:每次部署把 VERSION 跟著 App 版本一起改,activate 時會清掉舊版快取。
   注意:外部資源(Firebase SDK、Google Fonts)不攔截,交給瀏覽器自行處理。 */
const VERSION = "1.27.2";
const CACHE = "bingo-" + VERSION;
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/audio.js",
  "./js/game.js",
  "./js/online.js",
  "./js/main.js",
  "./mp3/bgm.mp3",
  "./mp3/Sunday_Morning_Win.mp3",
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

  // network-first:先網路(順手更新快取),失敗才回退快取;導覽請求離線時退回 index.html
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});

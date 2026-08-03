/* BINGO Service Worker
   策略:network-first（同源請求一律先走網路 → 線上永遠拿到最新版,徹底避免「改完上傳卻吃到舊快取、更新出不來」)。
   網路失敗(離線)才回退到快取,提供離線可玩 + 「加到主畫面」的體驗。
   CACHE 名稱帶版本號:每次部署把 VERSION 跟著 App 版本一起改,activate 時會清掉舊版快取。
   注意:外部資源(Firebase SDK、Google Fonts)不攔截,交給瀏覽器自行處理。 */
const VERSION = "1.77.0";
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
  "./js/shared/pk-faces.js",   // 撲克牌面自繪(排七與大老二共用,v1.76.0 抽出)
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
  // 排七(第六個遊戲,v1.75.0;獨立頁面,共用 styles.css 與 js/audio.js)
  "./sevens.html",
  "./js/sevens/rules.js",
  "./js/sevens/ai.js",
  "./js/sevens/board.js",
  "./js/sevens/solo.js",
  "./js/sevens/adapter.js",
  "./js/sevens/main.js",
  // 大老二(第七個遊戲,v1.76.0;獨立頁面,牌面與排七共用 js/shared/pk-faces.js)
  "./big2.html",
  "./js/big2/rules.js",
  "./js/big2/ai.js",
  "./js/big2/board.js",
  "./js/big2/solo.js",
  "./js/big2/adapter.js",
  "./js/big2/main.js",
  "./mp3/bgm.mp3",
  "./mp3/Sunday_Morning.mp3",
  "./mp3/win.wav",
  "./mp3/lose.wav",
  /* 台灣麻將的語音(v1.62.0;v1.64.0 起由 tools/gen-mj16-voice-edge.py 產生)。
     ⚠ v1.72.0 起全部收在 **mp3/mj16/** 底下(舊路徑是 mp3/m16-voice-*.wav):mp3/ 根留給
     五個遊戲共用的東西。改路徑要連 js/mahjong16/sfx.js 的 ensureDefs 與兩支產生器一起改。
     ⚠ 這幾個**確實存在**才列進來 —— addAll() 是全有全無的,清單裡有一個 404
     整批快取就失敗(離線變成整個不能玩)。所以刪音檔的時候一定要一起把這幾行拿掉。
     ⚠ 另一組「使用者自己要放的音效檔」(mp3/mj16/pong.mp3 之類)刻意**不列**:那些還不存在,
     走 network-first 的順手快取,放進去之後第一次播就會被收進來。 */
  "./mp3/mj16/voice-pong.wav",
  "./mp3/mj16/voice-chow.wav",
  "./mp3/mj16/voice-kong.wav",
  "./mp3/mj16/voice-hu.wav",
  "./mp3/mj16/voice-zimo.wav",
  "./mp3/mj16/voice-washout.wav",
  "./mp3/mj16/voice-ready.wav",      // 聽牌(v1.66.0)
  "./mp3/mj16/voice-flower.wav",     // 補花(v1.72.0:花牌不報花名,統一唸「補花」)
  /* 打出的牌報的牌名。★ 這些一定要進清單:語音層**沒有合成音後備**,
     離線又抓不到檔的話就是整組默默不出聲(見 sfx.js 的 VOICE 那段)。
     ⚠ 七張字牌(v1.72.0)列在這裡,27 張筒條萬(v1.72.0)在陣列後面用算式接上去。 */
  "./mp3/mj16/voice-tile-fe.wav",
  "./mp3/mj16/voice-tile-fs.wav",
  "./mp3/mj16/voice-tile-fw.wav",
  "./mp3/mj16/voice-tile-fn.wav",
  "./mp3/mj16/voice-tile-jz.wav",
  "./mp3/mj16/voice-tile-jf.wav",
  "./mp3/mj16/voice-tile-jb.wav",
  "./mp3/是要多久.m4a",
  "./mp3/啊西好了沒.m4a",
  "./mp3/快點，來不急啦.m4a",
  "./mp3/聽牌.m4a",
  "./mp3/你就趕快啦.m4a",
  "./mp3/你是在哭喔.m4a",
  "./manifest.json",
  "./icon.svg"
];
/* 筒條萬的牌名語音(v1.72.0,27 個)。★ 用算式接上去而**不是手列 27 行** —— 規律與
   js/mahjong16/sfx.js 的編碼一致(0..8 萬 w / 9..17 條 b / 18..26 筒 d)。
   ⚠ 手列遲早會抄錯或漏一個,而**錯一個就是 addAll() 整批失敗**(全有全無)→ 離線整個不能玩。
   ⚠ 這 27 個檔加起來約 780KB(整包 mp3/mj16/ 約 1.2MB):即使使用者把「報牌名」設成
     「只有字牌」也照樣快取 —— 快取是裝置層的,而他隨時可能改成「全部牌」,
     那時如果剛好離線就會整組沒聲音(語音層沒有合成音可以墊)。 */
["w","b","d"].forEach(s => { for (let v = 1; v <= 9; v++) CORE.push("./mp3/mj16/voice-tile-" + s + v + ".wav"); });

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

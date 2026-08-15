/* BINGO Service Worker
   策略:network-first（同源請求一律先走網路 → 線上永遠拿到最新版,徹底避免「改完上傳卻吃到舊快取、更新出不來」)。
   網路失敗(離線)才回退到快取,提供離線可玩 + 「加到主畫面」的體驗。
   CACHE 名稱帶版本號:每次部署把 VERSION 跟著 App 版本一起改,activate 時會清掉舊版快取。
   注意:外部資源(Firebase SDK、Google Fonts)不攔截,交給瀏覽器自行處理。 */
const VERSION = "1.177.0";
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
  "./js/shared/mp-order.js",
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
  // 21 點(第八個遊戲,v1.84.0;獨立頁面,牌面與排七 / 大老二共用 js/shared/pk-faces.js)
  "./blackjack.html",
  "./js/blackjack/rules.js",
  "./js/blackjack/ai.js",
  "./js/blackjack/board.js",
  "./js/blackjack/solo.js",
  "./js/blackjack/adapter.js",
  "./js/blackjack/main.js",
  /* UNO(第九個遊戲,v1.106.0;獨立頁面)。
     ★ 牌面自繪在 js/uno/board.js 裡面,**沒有** shared 的 faces 檔 ——
       UNO 牌只有這一頁用,而 js/shared/ 抽出去的理由是「兩個以上的遊戲共用」。
     ★ 動作聲全是 Sound.tone() 的合成音,但 v1.117.0 起**多了七句語音音檔**
       (使用者要「報 UNO / 加二 / 顏色」,而合成音唸不出字)—— 見下面 mp3 那一段的
       `mp3/uno/voice-*.wav` 七行。改那七個檔的路徑要四處一起改(CLAUDE.md 的紅線):
       board.js 的 ensureVoice、這裡、tools/gen-uno-voice.ps1。 */
  "./uno.html",
  "./js/uno/rules.js",
  "./js/uno/ai.js",
  "./js/uno/board.js",
  "./js/uno/solo.js",
  "./js/uno/adapter.js",
  "./js/uno/main.js",
  /* 象棋暗棋(第十個遊戲,v1.113.0;獨立頁面)。
     ★ 棋子自繪在 js/darkchess/board.js 裡面,**沒有** shared 的 faces 檔 ——
       象棋棋子只有這一頁用,而 js/shared/ 抽出去的理由是「兩個以上的遊戲共用」。
     ★ 這一頁**不新增任何 mp3**:動作聲全是 Sound.tone() 的合成音,
       所以下面 mp3 那一大段一行都不必動。
       (⚠ 原本這裡寫「同 UNO」—— UNO 從 v1.117.0 起有語音音檔了,別再拿它當範本。) */
  "./darkchess.html",
  "./js/darkchess/rules.js",
  "./js/darkchess/ai.js",
  "./js/darkchess/board.js",
  "./js/darkchess/solo.js",
  "./js/darkchess/adapter.js",
  "./js/darkchess/main.js",
  /* 成語接龍(第十一個遊戲,v1.135.0;獨立頁面)。
     ★ 交叉填字盤,單機 + 連線搶字(比照數獨的搶格模式,拿掉競速/候選提示)。
     ★ js/chengyu/data.js(成語原料池)只給離線生成器 tools/gen-chengyu-seeds.js 用,
       執行期的 gen.js 已經內含產好的版面庫,**不列進來**(瀏覽器不需要載它)。
     ★ 這一頁不新增任何 mp3:動作聲全是 Sound.tone() 的合成音。 */
  "./chengyu.html",
  "./js/chengyu/gen.js",
  "./js/chengyu/board.js",
  "./js/chengyu/solo.js",
  "./js/chengyu/adapter.js",
  "./js/chengyu/main.js",
  /* 你畫我猜(第十二個遊戲,v1.154.0;獨立頁面)。
     ★★ 十二個裡**唯一沒有 solo.js 也沒有 ai.js** 的一頁 —— 沒有 AI 畫家、也沒有 AI 猜圖者,
       所以它只有連線。⚠ 連帶:**這一頁離線是玩不了的**(快取只讓進場頁畫得出來),
       那與另外十一頁不同,不是漏列檔案。
     ★ 這一頁不新增任何 mp3:動作聲全是 Sound.tone() 的合成音(同暗棋 / 成語接龍)。 */
  "./draw.html",
  "./js/draw/rules.js",
  "./js/draw/gen.js",
  "./js/draw/board.js",
  "./js/draw/adapter.js",
  "./js/draw/main.js",
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
  /* 大老二的喊牌語音(「拉」與 Pass,v1.81.1;v1.83.0 起 pass.wav 唸的是 Pass。
     ⚠ 換字**檔名不變** → 這兩行不必動,但檔案內容變了的那一版一定要一起 commit
       (不然離線的人會聽到舊字)。tools/gen-big2-voice.ps1 產生)。
     ⚠ 與台灣麻將那組不同,這兩格**有合成音後備**(board.js 的 laSynth / passSynth),
       所以離線抓不到也不會啞掉 —— 但照樣列進來:合成音只是「墊著」,
       使用者聽慣的是人聲,離線忽然換成兩個音會被當成壞掉。
     ⚠ 這兩個檔一定要**與這幾行同一版進 repo**:addAll() 是全有全無的,
       列了不存在的檔會讓整批快取失敗(離線變成整個不能玩)。 */
  "./mp3/big2/la.wav",
  "./mp3/big2/pass.wav",
  /* 台式21點的喊牌語音(v1.92.0,tools/gen-bj-voice.ps1 產生)。
     ★ 四句都是**公開事件**、而且都已經是 board.js announce 的 diff:
       爆了 / 二十一點 / 過五關 / 抓 —— 要牌與停一局要響十幾次,刻意不配語音
       (那是台灣麻將講過的「報帳機」)。
     ⚠ 這一組**有東西可以墊**(同大老二那兩格):動作聲那一層(bustSfx / bjSfx /
       dragonSfx / grabSfx)照舊會響,語音只是疊在上面 —— 所以離線抓不到不會啞掉。
       但照樣列進來:使用者聽慣人聲,忽然只剩音階會被當成壞掉。
     ⚠ 這四個檔一定要**與這幾行同一版進 repo**:addAll() 是全有全無的,
       列了不存在的檔會讓整批快取失敗(離線變成整個不能玩)。 */
  "./mp3/bj/bust.wav",
  "./mp3/bj/bj.wav",
  "./mp3/bj/dragon.wav",
  "./mp3/bj/grab.wav",
  /* UNO 的語音(v1.117.0,tools/gen-uno-voice.ps1 產生)。
     ★ 這一頁 v1.106.0~v1.116.0 刻意「不新增任何 mp3」,是使用者要語音才推翻的
       (合成音唸不出字)——推翻的範圍只有這七句,動作聲全部維持 Sound.tone()。
       uno = 有人剩一張 · d2 / d4 = 罰抽砸下去 · r/y/g/b = Wild 指定了哪個顏色。
     ⚠⚠ 這一組**沒有東西可以墊**(語音槽的 synth 傳 null,見 board.js 的 ensureVoice)——
       與大老二 / 21點那兩組不同:那兩組離線只是「少了人聲、音階還在」,
       這裡離線抓不到就是**完全不講話**。所以這七行比那兩組更不能漏。
     ⚠ 這七個檔一定要**與這幾行同一版進 repo**:addAll() 是全有全無的,
       列了不存在的檔會讓整批快取失敗(離線變成整個不能玩)。 */
  "./mp3/uno/voice-uno.wav",
  "./mp3/uno/voice-d2.wav",
  "./mp3/uno/voice-d4.wav",
  "./mp3/uno/voice-r.wav",
  "./mp3/uno/voice-y.wav",
  "./mp3/uno/voice-g.wav",
  "./mp3/uno/voice-b.wav",
  "./mp3/是要多久.m4a",
  "./mp3/啊西好了沒.m4a",
  "./mp3/快點，來不急啦.m4a",
  "./mp3/聽牌.m4a",
  "./mp3/你就趕快啦.m4a",
  "./mp3/你是在哭喔.m4a",
  "./mp3/我要驗牌.m4a",
  "./mp3/牌沒問題.m4a",
  "./mp3/沒禮貌.m4a",
  "./mp3/你禮貌嗎.m4a",
  "./manifest.json",
  "./img/icon.svg",
  /* ★★★ v1.149.0:十一個遊戲的圖示全部是去背的 PNG 貼圖(每一張都是「index.html 首頁卡
     + 該遊戲進場插圖**同一個檔案**」;v1.145.0 暗棋、v1.148.0 台灣麻將是頭兩張)。
     漏列一張的症狀是「離線時那張卡是破圖」—— 而 addAll() 是**全有全無**,
     所以檔名打錯的症狀更慘:**離線整個不能玩**。
     ⚠ 加新遊戲 / 換檔名要三處一起改:兩頁的 img + 這裡。 */
  "./img/bc-icon.png",     // BINGO(首頁卡 + 第二層「選擇玩法」那張 hero)
  "./img/gk-icon.png",     // 五子棋
  "./img/sk-icon.png",     // 數獨
  "./img/mk-icon.png",     // 麻將消消樂
  "./img/m16-icon.png",    // 台灣 16 張麻將
  "./img/sv-icon.png",     // 排七
  "./img/b2-icon.png",     // 大老二
  "./img/bj-icon.png",     // 台式 21 點
  "./img/un-icon.png",     // UNO
  "./img/dc-icon.png",     // 象棋暗棋
  "./img/cy-icon.png",     // 成語接龍
  "./img/dw-icon.png"      // 你畫我猜(★ 目前是 tools/gen-dw-icon.py 產的佔位圖,不是那套手繪插畫)
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
      /* ⚠⚠ 條件是 status === 200,**不可以寫 res.ok**(v1.156.0 修)。
         `Response.ok` 涵蓋 200~299,所以 **206(Partial Content)的 ok 是 true** ——
         而規格對 `Cache.put` 明訂 206 要以 TypeError reject。
         這個專案到處都會發 Range 請求:HTMLMediaElement 一律送 Range,而
         js/audio.js 的 BGM(new Audio(src))、win/lose 的 HTMLAudio 後備、playClipEl
         (js/mahjong16/sfx.js 對全部 mj16 語音明確開了 {el:true})都走它。
         ★ 後果不影響播放(return res 在 put 之外),症狀是安靜的兩件事:
           ① SW console 被 unhandled rejection 塞滿 → 真正的快取錯誤(發版時 CORE 列錯檔名)
              會被埋掉,而那是「離線整個不能玩」的唯一線索
           ② 這些媒體回應永遠進不了 runtime cache —— 也就是說「network-first 會順手把
              播過的檔收進來」這個假設**對所有走 HTMLAudio 的音檔都不成立**,
              而下面第 138 行那條「使用者自己放的 mp3 刻意不列進 CORE」正是靠這個假設。
         ⚠ 就算條件收成 200,`.catch()` 還是要留:同一段的兄弟 c.addAll(CORE).catch(()=>{})
           一直都有,這裡少了純粹是漏的(配額滿、私密瀏覽都會 reject)。 */
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("./app.html") : Response.error())))
  );
});

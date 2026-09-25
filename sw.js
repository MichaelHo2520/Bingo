/* BINGO Service Worker
   策略:network-first（同源請求一律先走網路 → 線上永遠拿到最新版,徹底避免「改完上傳卻吃到舊快取、更新出不來」)。
   網路失敗(離線)或**太慢**(NET_WAIT_MS)才回退到快取,提供離線可玩 + 「加到主畫面」的體驗。
   CACHE 名稱帶版本號 + 內容指紋(BUILD,由 tools/build-sw.js 產生),activate 時會清掉舊版快取。
   ★ 2026-09-25 起發版**不再整包重抓**:每一個檔都有內容指紋(REV),舊快取裡指紋對得上的直接複製,
     只下載真的變了的那幾個;而且**全部抓齊才接手**,抓不齊就讓舊版繼續服務。細節見 install 那一段。
   注意:外部資源(Firebase SDK、Google Fonts)不攔截,交給瀏覽器自行處理。 */
const VERSION = "2.19.0";
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
  "./js/shared/chip-bgm.js",   // 動態配樂 ChipBGM(v2.17.0,只有方塊 / 泡泡載入;曲譜在各自的 music.js)
  "./js/shared/talk.js",       // 即時語音 WebRTC(v1.183.0 起十四頁全部載入,含 Bingo)
  "./js/shared/qr.js",         // 房間分享:QR 編碼器 + 邀請蓋板(十四頁全部載入,含 Bingo)
                               // ★ QR 編碼器刻意自己實作、不吃 CDN —— 外部資源這支 SW 不攔截,
                               //   離線就抓不到,而離線正是現場最需要它在的時候
  "./js/shared/feedback.js",   // 問題回報與建議:錯誤環形緩衝 + 設定面板裡的回報卡(十四頁全部載入,含 Bingo)
                               // ★ 送出走公開 REST(databaseURL/feedbacks.json),不等 Firebase SDK
                               //   —— 十三頁的 SDK 是「進連線才動態載入」的,而回報最需要在的
                               //   時機恰恰是還沒連線 / 連線爛掉的時候
  "./js/shared/update.js",     // 更新看得見:下載進度 / 新版就緒 / 更新了什麼(十六頁全部載入,含 Bingo)
  "./whatsnew.json",           // 「這次更新了什麼」—— 一版一句,由 update.js 在更新落地後讀
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
  "./js/mahjong16/fx.js",      // 碰 / 槓 / 吃 / 聽牌的漢字、胡牌特寫、花瓣、薄霧(v2.4.0)
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
     ★★ 十三個裡**唯一沒有 solo.js 也沒有 ai.js** 的一頁 —— 沒有 AI 畫家、也沒有 AI 猜圖者,
       所以它只有連線。⚠ 連帶:**這一頁離線是玩不了的**(快取只讓進場頁畫得出來),
       那與另外十一頁不同,不是漏列檔案。
     ★ 這一頁不新增任何 mp3:動作聲全是 Sound.tone() 的合成音(同暗棋 / 成語接龍)。 */
  "./draw.html",
  "./js/draw/rules.js",
  "./js/draw/gen.js",
  "./js/draw/board.js",
  "./js/draw/adapter.js",
  "./js/draw/main.js",
  /* 飛行棋(第十三個遊戲,v1.179.7;獨立頁面)。
     ★ 這一頁多載一支共用檔:js/shared/mp-order.js(猜拳決定誰先擲)——
       它上面已經列過(暗棋也吃它),不必再列一次。
     ★ 走格 / 踩人的聲音仍然全是 Sound.tone() 的合成音,**只有骰子有音檔**
       (mp3/fc/dice.mp3,列在下面 mp3 那一段)。 */
  "./flychess.html",
  "./js/flychess/rules.js",
  "./js/flychess/ai.js",
  "./js/flychess/board.js",
  "./js/flychess/solo.js",
  "./js/flychess/adapter.js",
  "./js/flychess/main.js",
  /* 跳棋(第十四個遊戲,v1.180.0;獨立頁面)。
     ★ 它與飛行棋一樣共用 js/shared/*(ui-kit / mp-core / mp-order)—— 上面已經列過,不必再列。
     ★ 這一頁不新增任何 mp3:走子 / 連跳 / 到家的聲音全是 Sound.tone() 的合成音
       (同暗棋 / 成語接龍 / 你畫我猜 / 飛行棋)。 */
  "./blocks.html",
  "./js/blocks/rules.js",
  "./js/blocks/ai.js",
  "./js/blocks/music.js",      // 配樂《貨郎》的曲譜(v2.17.0)
  "./js/blocks/board.js",
  "./js/blocks/solo.js",
  "./js/blocks/adapter.js",
  "./js/blocks/main.js",
  "./img/blk-icon.png",
  /* 泡泡對戰(第十六個遊戲)。★ 同方塊對戰:共用 js/shared/* 上面已經列過,不新增任何 mp3
     (射出 / 反彈 / 消除的聲音全是 Sound.tone() 的合成音)。 */
  "./bubble.html",
  "./js/bubble/rules.js",
  "./js/bubble/ai.js",
  "./js/bubble/music.js",      // 配樂《泡泡跳跳》的曲譜(v2.17.0)
  "./js/bubble/board.js",
  "./js/bubble/solo.js",
  "./js/bubble/adapter.js",
  "./js/bubble/main.js",
  "./img/bub2-icon.png",
  "./tiaoqi.html",
  "./js/tiaoqi/rules.js",
  "./js/tiaoqi/ai.js",
  "./js/tiaoqi/board.js",
  "./js/tiaoqi/solo.js",
  "./js/tiaoqi/adapter.js",
  "./js/tiaoqi/main.js",
  "./mp3/bgm.mp3",
  "./mp3/Sunday_Morning.mp3",
  /* 勝 / 敗音效。★ 2026-09-25 起列的是重編碼過的 mp3(各約 60 KB),**不是**原本的 win.wav /
     lose.wav(兩個合計 1.4 MB 的未壓縮 PCM)—— wav 仍留在 repo 當原始檔與後備
     (js/audio.js 的 SFX 是候選陣列,mp3 抓不到才試 wav),但不再進離線清單。 */
  "./mp3/win.mp3",
  "./mp3/lose.mp3",
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
  /* 飛行棋的骰子(使用者自己找來的音效,不是產生的)。
     ★ 這是第一個**抓來的**音檔:峰值被正規化到 1.0、開頭還有 0.14 秒靜音 ——
       兩個毛病都在 board.js 的 Sound.def(gain / offset)修掉,原始檔一個位元都沒動
       (換一個檔進來程式照樣能用)。
     ⚠ 它**有東西可以墊**(rollSynth 的合成音),所以離線抓不到不會啞掉;
       但照樣列進來 —— 使用者聽慣真的骰子聲,忽然換成合成音會被當成壞掉。
     ⚠ 這個檔要**與這一行同一版進 repo**:addAll() 是全有全無的,
       列了不存在的檔會讓整批快取失敗(離線變成整個不能玩)。 */
  "./mp3/fc/dice.mp3",
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
  "./img/dw-icon.png",     // 你畫我猜(★ 目前是 tools/gen-dw-icon.py 產的佔位圖,不是那套手繪插畫)
  "./img/fc-icon.png",     // 飛行棋(★ 目前是 tools/gen-fc-icon.py 產的佔位圖,不是那套手繪插畫)
  "./img/tq-icon.png"      // 跳棋  (★ 目前是 tools/gen-tq-icon.py 產的佔位圖 —— 現在一共三張)
];
/* 筒條萬的牌名語音(v1.72.0,27 個)。★ 用算式接上去而**不是手列 27 行** —— 規律與
   js/mahjong16/sfx.js 的編碼一致(0..8 萬 w / 9..17 條 b / 18..26 筒 d)。
   ⚠ 手列遲早會抄錯或漏一個,而**錯一個就是 addAll() 整批失敗**(全有全無)→ 離線整個不能玩。
   ⚠ 這 27 個檔加起來約 780KB(整包 mp3/mj16/ 約 1.2MB):即使使用者把「報牌名」設成
     「只有字牌」也照樣快取 —— 快取是裝置層的,而他隨時可能改成「全部牌」,
     那時如果剛好離線就會整組沒聲音(語音層沒有合成音可以墊)。 */
["w","b","d"].forEach(s => { for (let v = 1; v <= 9; v++) CORE.push("./mp3/mj16/voice-tile-" + s + v + ".wav"); });

/* ============================================================================
   內容指紋(REV)—— ⚠⚠ 下面 @@REV 兩行之間是 tools/build-sw.js 產生的,**不要手改**
   ──────────────────────────────────────────────────────────────────────────
   REV:CORE 每一個檔的 SHA-256 前 16 碼("./" 是 index.html 的)。
   BUILD:整份 REV 的指紋 —— 接在快取名後面,**內容一變快取名就跟著變**,
     所以同一個版號之內重推 sw.js 也不會「新舊內容寫進同一個快取」。
   ★ 用途只有一個:install 時分辨「這個檔跟舊快取裡那一份是不是同一個」——
     一樣就本機複製(零流量),不一樣才下載。
   ⚠ 跑法:`node tools/build-sw.js`(封版的 bump-version.js 會自動跑)。
     忘了跑的後果**只會多下載、不會拿到舊檔**:指紋對不上的一律重抓,
     而網路抓回來的內容與 REV 不符時,重試兩次後照樣收下網路那一份(見 grab)。
     唯一的漏洞是「改了檔、REV 還是舊的、而舊快取剛好也是舊的」→ 那個檔的**離線備份**
     停在舊版(線上照樣 network-first 拿新的)—— 守門是 test-version.js 的 E 節。
   ========================================================================== */
/* @@REV-BEGIN */
const BUILD = "92e489da";
const REV = {
  "./": "7de2f696e04201c6",
  "./app.html": "5ae5b5389c009647",
  "./index.html": "7de2f696e04201c6",
  "./styles.css": "2e29c1196a47246d",
  "./js/audio.js": "fec2c75c8b2efe5b",
  "./js/game.js": "60829e5e6d2711f6",
  "./js/online.js": "576da19c11495fee",
  "./js/home-live.js": "bc17df3b35265668",
  "./js/main.js": "506c45c96fd7f3c4",
  "./js/shared/ui-kit.js": "0bb5a13534aae0e5",
  "./js/shared/mp-order.js": "149d5a5ac8c2a35c",
  "./js/shared/mp-core.js": "4713ca2baac59556",
  "./js/shared/chip-bgm.js": "371e21f68e9cd8e3",
  "./js/shared/talk.js": "223a297026e6430b",
  "./js/shared/qr.js": "ca9efdd4fbc2a470",
  "./js/shared/feedback.js": "2cd0d511fd17f65b",
  "./js/shared/update.js": "7b8e2a0878319364",
  "./whatsnew.json": "91108408943947a4",
  "./js/shared/mj-faces.js": "6dfafa35ef46c02d",
  "./js/shared/pk-faces.js": "aebf8618ca706ea3",
  "./mahjong16.html": "15d93846f5750985",
  "./js/mahjong16/rules.js": "0e46116ea56feb6f",
  "./js/mahjong16/scoring.js": "412273575d364e2d",
  "./js/mahjong16/table.js": "11caa2ed0ba68a88",
  "./js/mahjong16/ai.js": "e7f8efea06dab285",
  "./js/mahjong16/sfx.js": "26782026c1245c0c",
  "./js/mahjong16/board.js": "6d6e2724d1f3c3ab",
  "./js/mahjong16/fx.js": "761fe6f70da716be",
  "./js/mahjong16/solo.js": "61ad592e7d97ed56",
  "./js/mahjong16/adapter.js": "48302f1b521b944f",
  "./js/mahjong16/main.js": "45dd7daffd2625af",
  "./gomoku.html": "57010717f86f57f1",
  "./js/gomoku/board.js": "ed482e7b7c5098ce",
  "./js/gomoku/ai.js": "e7019b45f8af585e",
  "./js/gomoku/solo.js": "584fe61a17b88c2e",
  "./js/gomoku/adapter.js": "32a758404c7f5c2f",
  "./js/gomoku/main.js": "21ea081ddd3182b0",
  "./sudoku.html": "24db95330c21c997",
  "./js/sudoku/gen.js": "8102555037535684",
  "./js/sudoku/board.js": "4dc763aec73cbdfb",
  "./js/sudoku/solo.js": "2a628bfc1011ec44",
  "./js/sudoku/adapter.js": "c6df2b0a8d69943d",
  "./js/sudoku/main.js": "6b40fd2d6017a10f",
  "./mahjong.html": "d821f0ed6cb66614",
  "./js/mahjong/gen.js": "2df83affc468e1af",
  "./js/mahjong/board.js": "c969148ca7129100",
  "./js/mahjong/solo.js": "766d8739af5031f1",
  "./js/mahjong/adapter.js": "f572c5c4e53d287c",
  "./js/mahjong/main.js": "7acac79f5e77047d",
  "./sevens.html": "d92bf4a005b604fc",
  "./js/sevens/rules.js": "46f1b8b9e750f273",
  "./js/sevens/ai.js": "bffc7465d56f79aa",
  "./js/sevens/board.js": "41ec75f45db635fb",
  "./js/sevens/solo.js": "c1a732be756c709e",
  "./js/sevens/adapter.js": "bc844454e1c4b830",
  "./js/sevens/main.js": "2011bf7d3294ff96",
  "./big2.html": "538b6041db5cef56",
  "./js/big2/rules.js": "0eea6c37af825ba3",
  "./js/big2/ai.js": "78d4626a42422575",
  "./js/big2/board.js": "9e07ef3b63a3cdb7",
  "./js/big2/solo.js": "e3278b0d97b3634e",
  "./js/big2/adapter.js": "a8ed1789ec0e2f52",
  "./js/big2/main.js": "d034b272dab27ae7",
  "./blackjack.html": "a7570595b8f954e2",
  "./js/blackjack/rules.js": "c52ff0caa15e2aaa",
  "./js/blackjack/ai.js": "35fd38d61855a3d2",
  "./js/blackjack/board.js": "f3ab99ac9cdb225a",
  "./js/blackjack/solo.js": "01c97ba61298ddf7",
  "./js/blackjack/adapter.js": "e37687ddc6ca4c37",
  "./js/blackjack/main.js": "d07b4d67946e858f",
  "./uno.html": "e5e71b036c5b26ff",
  "./js/uno/rules.js": "f253bc64ac42369c",
  "./js/uno/ai.js": "6d27d3b66798cdde",
  "./js/uno/board.js": "8e5ed9d916b4b08c",
  "./js/uno/solo.js": "de30f2dd97a69aa3",
  "./js/uno/adapter.js": "79a1cd64f32a363a",
  "./js/uno/main.js": "8fdcddf4f9144cea",
  "./darkchess.html": "cba83abf6121c767",
  "./js/darkchess/rules.js": "22f316b13eb1889c",
  "./js/darkchess/ai.js": "91d63d7745ae676a",
  "./js/darkchess/board.js": "b3577df6d9d2f3c2",
  "./js/darkchess/solo.js": "41dad776223a3a13",
  "./js/darkchess/adapter.js": "07fcfa28a01fe464",
  "./js/darkchess/main.js": "13d76b0904ecc6bd",
  "./chengyu.html": "56acc18f2e7ad2ae",
  "./js/chengyu/gen.js": "cd7267a7744c63e3",
  "./js/chengyu/board.js": "dd07f06ad78df164",
  "./js/chengyu/solo.js": "ce2cbb63ac08627b",
  "./js/chengyu/adapter.js": "0a1cd546a471619e",
  "./js/chengyu/main.js": "755c52931c833ee0",
  "./draw.html": "d55d4c22a8a71821",
  "./js/draw/rules.js": "379339ee2aaef671",
  "./js/draw/gen.js": "375f3c119c54237c",
  "./js/draw/board.js": "1ee8c9b96d7eb9eb",
  "./js/draw/adapter.js": "f368568ea6e316c0",
  "./js/draw/main.js": "55687d48e2d0bc36",
  "./flychess.html": "b95b820cd9033479",
  "./js/flychess/rules.js": "3f2be4f4d21f1972",
  "./js/flychess/ai.js": "ce32d2589d6b9039",
  "./js/flychess/board.js": "aceae7366323d302",
  "./js/flychess/solo.js": "3bd8a623f9aa530f",
  "./js/flychess/adapter.js": "354884a21563ad6e",
  "./js/flychess/main.js": "fb236b88052c85e8",
  "./blocks.html": "aa87bae89e518128",
  "./js/blocks/rules.js": "0d19ddbf181b3878",
  "./js/blocks/ai.js": "6832149959867599",
  "./js/blocks/music.js": "d19e2b4b4161ed96",
  "./js/blocks/board.js": "f6686023b76df31f",
  "./js/blocks/solo.js": "a98db34bc358b0e1",
  "./js/blocks/adapter.js": "6262193be0bd5929",
  "./js/blocks/main.js": "30a906877a62f3bd",
  "./img/blk-icon.png": "f3bc6384719fec28",
  "./bubble.html": "dd32316d424a25d3",
  "./js/bubble/rules.js": "e713a0cbbc434adf",
  "./js/bubble/ai.js": "fa566700f2802b17",
  "./js/bubble/music.js": "5362630ac9dc6b45",
  "./js/bubble/board.js": "ed67522267bf5aec",
  "./js/bubble/solo.js": "fc22895b3d34fd0d",
  "./js/bubble/adapter.js": "37d4a2b6b718189d",
  "./js/bubble/main.js": "c32fc51c38e687b3",
  "./img/bub2-icon.png": "57709a8e61b80073",
  "./tiaoqi.html": "642ec906b8333012",
  "./js/tiaoqi/rules.js": "0909b91951971301",
  "./js/tiaoqi/ai.js": "b535ba23344f7089",
  "./js/tiaoqi/board.js": "291d0a98cab0dc67",
  "./js/tiaoqi/solo.js": "7034f048424bc112",
  "./js/tiaoqi/adapter.js": "aa8294a54adf9a37",
  "./js/tiaoqi/main.js": "a9ba1fbebe37249f",
  "./mp3/bgm.mp3": "86a11a4e4464b5b4",
  "./mp3/Sunday_Morning.mp3": "5991e85728d3c751",
  "./mp3/win.mp3": "163179a68866b721",
  "./mp3/lose.mp3": "66331b442af52271",
  "./mp3/mj16/voice-pong.wav": "c2ece4c1cc6e4f70",
  "./mp3/mj16/voice-chow.wav": "30fa02576c23cb63",
  "./mp3/mj16/voice-kong.wav": "46eaef3308ee817d",
  "./mp3/mj16/voice-hu.wav": "e8d4a95d5f5037c9",
  "./mp3/mj16/voice-zimo.wav": "55ce72da34898c41",
  "./mp3/mj16/voice-washout.wav": "9b6b5bbbc018ab2a",
  "./mp3/mj16/voice-ready.wav": "a6f292011c45f75b",
  "./mp3/mj16/voice-flower.wav": "5b0ec66af8c3d47c",
  "./mp3/mj16/voice-tile-fe.wav": "ca902e12ae210ba0",
  "./mp3/mj16/voice-tile-fs.wav": "d6825a62f0437429",
  "./mp3/mj16/voice-tile-fw.wav": "0b804d67140d3096",
  "./mp3/mj16/voice-tile-fn.wav": "72d2064fa6fb0349",
  "./mp3/mj16/voice-tile-jz.wav": "d5d189dff9905282",
  "./mp3/mj16/voice-tile-jf.wav": "8bbbfa9205107ec0",
  "./mp3/mj16/voice-tile-jb.wav": "91056239f568f9be",
  "./mp3/big2/la.wav": "a00471dc2d9a24b7",
  "./mp3/big2/pass.wav": "097292a837c21a42",
  "./mp3/fc/dice.mp3": "6a3d37146a9e0a11",
  "./mp3/bj/bust.wav": "40bc14a61485acdd",
  "./mp3/bj/bj.wav": "c8002c7393e9db87",
  "./mp3/bj/dragon.wav": "2e374d2701526072",
  "./mp3/bj/grab.wav": "431ce97d28db6da8",
  "./mp3/uno/voice-uno.wav": "2132b04fbe9f3b44",
  "./mp3/uno/voice-d2.wav": "7c644d1b3915541d",
  "./mp3/uno/voice-d4.wav": "c70da0d8918aae4d",
  "./mp3/uno/voice-r.wav": "b2577a97b0836d7e",
  "./mp3/uno/voice-y.wav": "e0deb1f17e50d3db",
  "./mp3/uno/voice-g.wav": "57208bc2e7bf9493",
  "./mp3/uno/voice-b.wav": "ab7f7ecdb657f549",
  "./mp3/是要多久.m4a": "9a7e7481f673e276",
  "./mp3/啊西好了沒.m4a": "ed252263defa2185",
  "./mp3/快點，來不急啦.m4a": "6795bd69ce5eaeb1",
  "./mp3/聽牌.m4a": "e11e0b639e86197a",
  "./mp3/你就趕快啦.m4a": "6843cd80621ccb10",
  "./mp3/你是在哭喔.m4a": "d96388f9c6c013c3",
  "./mp3/我要驗牌.m4a": "9040c8b70592fefa",
  "./mp3/牌沒問題.m4a": "3af1f8f997ebee2d",
  "./mp3/沒禮貌.m4a": "5144abbbaa66b7b5",
  "./mp3/你禮貌嗎.m4a": "05595dcfa1b92bfc",
  "./manifest.json": "3cf42d0a1f6a7cdf",
  "./img/icon.svg": "d42669418cb79b0a",
  "./img/bc-icon.png": "e520a8b45a0285a2",
  "./img/gk-icon.png": "983bbed5de0ba7f7",
  "./img/sk-icon.png": "dbe30839082c823b",
  "./img/mk-icon.png": "08c6873078b30cb6",
  "./img/m16-icon.png": "19728e2481da8a29",
  "./img/sv-icon.png": "8bd09c4bd1d199b9",
  "./img/b2-icon.png": "c13cf0bc86e56a8a",
  "./img/bj-icon.png": "d8251940d04f9525",
  "./img/un-icon.png": "ba8b0bec485b186e",
  "./img/dc-icon.png": "4d8d06ff231c61d5",
  "./img/cy-icon.png": "aeea8c7cf51b1e0b",
  "./img/dw-icon.png": "97d69e718e0732c8",
  "./img/fc-icon.png": "8f8dcb2c58568b56",
  "./img/tq-icon.png": "eea6c36183fec479",
  "./mp3/mj16/voice-tile-w1.wav": "1f4ced5583511361",
  "./mp3/mj16/voice-tile-w2.wav": "24ef29f7cf7356c0",
  "./mp3/mj16/voice-tile-w3.wav": "c53a65dfba7a712f",
  "./mp3/mj16/voice-tile-w4.wav": "2190b22c9c37bb94",
  "./mp3/mj16/voice-tile-w5.wav": "00e35bda645e5c30",
  "./mp3/mj16/voice-tile-w6.wav": "38a393c650e0bc1a",
  "./mp3/mj16/voice-tile-w7.wav": "026958d48c204346",
  "./mp3/mj16/voice-tile-w8.wav": "0ceb28ca572f7b66",
  "./mp3/mj16/voice-tile-w9.wav": "3a9c201b7cad4b5c",
  "./mp3/mj16/voice-tile-b1.wav": "45c95b32498585ea",
  "./mp3/mj16/voice-tile-b2.wav": "4a040c87d4bd4559",
  "./mp3/mj16/voice-tile-b3.wav": "a4ae7749e28515bb",
  "./mp3/mj16/voice-tile-b4.wav": "bfac051027d4c9be",
  "./mp3/mj16/voice-tile-b5.wav": "ed6f033b227ad494",
  "./mp3/mj16/voice-tile-b6.wav": "042018c3543a4785",
  "./mp3/mj16/voice-tile-b7.wav": "ac1e450814c0a1f7",
  "./mp3/mj16/voice-tile-b8.wav": "15a0537afd635306",
  "./mp3/mj16/voice-tile-b9.wav": "5f2376ba21e617fd",
  "./mp3/mj16/voice-tile-d1.wav": "e08bf9e02ab3e83d",
  "./mp3/mj16/voice-tile-d2.wav": "1d8917ee61a2c94a",
  "./mp3/mj16/voice-tile-d3.wav": "f6b60f85f5b59d88",
  "./mp3/mj16/voice-tile-d4.wav": "c574e3a259fec1fb",
  "./mp3/mj16/voice-tile-d5.wav": "8f4972285174bf60",
  "./mp3/mj16/voice-tile-d6.wav": "c85c2a695ccf8205",
  "./mp3/mj16/voice-tile-d7.wav": "214ea8bd21a6ecb3",
  "./mp3/mj16/voice-tile-d8.wav": "b4bb7d1eb63d4982",
  "./mp3/mj16/voice-tile-d9.wav": "00065f729f202bfb"
};
/* @@REV-END */
const CACHE = "bingo-" + VERSION + (BUILD ? "-" + BUILD : "");

/* 網路超過這麼久沒回應 → 先拿快取頂著(網路那一趟照樣在背景跑完)。
   ★ 治的是現場最常見的「有連上熱點、但網路爛到每個請求都要等十幾秒」——
     network-first 原本要等到那一趟**失敗**才退回快取,而爛網路常常是不失敗、只是很慢。
   ⚠ 只在「確定快取跟這一頁是同一版」時才會用快取頂(見下面 kinds 那一段),
     不然會拼出「新版 HTML + 舊版 JS」的頁面。 */
const NET_WAIT_MS = 3000;
/* 背景下載新版時,遇到有人正在對局就先停手(頁面每 4 秒送一次 bingo.busy)。
   ⚠ 最多停這麼久 —— install 事件拖太久瀏覽器會直接把 SW 殺掉,那就白抓了;
     停滿之後改成**單線**慢慢抓(平常是兩線)。 */
const BUSY_HOLD_MS = 120000;
const LANES = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const baseVer = v => String(v || "").replace(/\+.*$/, "");
async function fingerprint(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let s = ""; for (let i = 0; i < 8; i++) s += d[i].toString(16).padStart(2, "0");
  return s;
}

/* 把狀態廣播給所有分頁(含 iframe 裡的遊戲頁與還沒被這支 SW 接管的頁面)。
   頁面那一半在 js/shared/update.js:把它畫成畫面上方那顆小膠囊。 */
async function tell(msg) {
  msg.t = "bingo.sw"; msg.ver = VERSION;
  try {
    const cs = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    cs.forEach(c => { try { c.postMessage(msg); } catch (_) { } });
  } catch (_) { }
}

let busyUntil = 0;
self.addEventListener("message", e => {
  const d = e.data || {};
  // 頁面說「正在對局」→ 15 秒內算忙;頁面不見了(關掉 / 當掉)自己會過期,不會永遠停手
  if (d.t === "bingo.busy") busyUntil = d.on ? Date.now() + 15000 : 0;
});

/* ============================================================================
   install:先本機複製、再下載差額,**全部齊了才接手**
   ──────────────────────────────────────────────────────────────────────────
   ⚠⚠ 舊寫法是 `c.addAll(CORE).catch(()=>{})` + 一開始就 skipWaiting(),兩個問題疊在一起:
     ① 每次發版 212 個檔(約 9.4 MB)**全部重抓** —— 包括根本沒變的 4.6 MB 音檔與圖示。
        在熱點上這就是玩家說的「突然變很卡」,而畫面上沒有任何提示。
     ② addAll 是全有全無:212 個裡有一個沒抓到,新快取就是**空的**;但錯誤被 catch 吞掉,
        新版照樣接手、activate 照樣把舊快取刪掉 → 之後每個音檔都走網路、離線整個不能玩。
        網路越爛越容易發生,所以是「越更新越慢」。
   現在:
     · 指紋對得上的檔從舊快取**本機複製**(零流量);一個版本通常只剩十來個檔要下載。
     · 下載兩線並行(不再 212 個一起衝),有人在對局就先讓路(BUSY_HOLD_MS)。
     · 每個檔重試三次;還是失敗就讓 install **失敗** → 舊版繼續服務、舊快取保留,
       下次開頁(或更新檢查呼叫 reg.update())再試,已經抓到的那些下次不必重抓(同名快取留著)。
     · 全部齊了才 skipWaiting()。
   ========================================================================== */
async function reuse(from, to, url, want) {
  if (!want) return false;
  const r = await from.match(url);
  if (!r || r.status !== 200) return false;
  let got = "";
  try { got = await fingerprint(await r.clone().arrayBuffer()); } catch (_) { return false; }
  if (got !== want) return false;
  if (from !== to) await to.put(url, r);
  return true;
}
/* 從網路抓一個檔。★ 第一次用 no-cache(帶 ETag 問伺服器,沒變就 304,幾乎不花流量);
   內容跟 REV 對不上(多半是 GitHub Pages 的 CDN 還沒同步完)就等一下改用 reload 再抓。
   ⚠ 第三次還是對不上就**照收網路那一份**:那代表 REV 過期(忘了跑 build-sw.js),
     網路上的才是真相 —— 絕不可以因為指紋對不上就讓整個 install 永遠失敗。 */
async function grab(url, want) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { cache: i === 0 ? "no-cache" : "reload" });
      if (!res || res.status !== 200) throw new Error("HTTP " + (res && res.status));
      if (!want || i === 2) return res;
      const got = await fingerprint(await res.clone().arrayBuffer());
      if (got === want) return res;
    } catch (err) { lastErr = err; }
    await sleep(1500 * (i + 1));
  }
  throw lastErr || new Error("抓不到 " + url);
}
async function precache() {
  const cache = await caches.open(CACHE);
  // 新的在後面 → 反過來找,先試最近的那一份
  const olds = (await caches.keys()).filter(k => k !== CACHE && k.indexOf("bingo-") === 0).reverse();
  const oldCaches = await Promise.all(olds.map(k => caches.open(k)));
  const need = [];
  for (const url of CORE) {
    const want = REV[url];
    if (await reuse(cache, cache, url, want)) continue;       // 上一次沒裝完,這個已經抓過了
    let hit = false;
    for (const oc of oldCaches) { if (await reuse(oc, cache, url, want)) { hit = true; break; } }
    if (!hit) need.push(url);
  }
  const total = need.length, holdUntil = Date.now() + BUSY_HOLD_MS;
  let done = 0;
  if (total) tell({ st: "dl", done, total });
  const lane = async idx => {
    while (need.length) {
      // 有人在對局:先停手;停滿 BUSY_HOLD_MS 之後只留第一線繼續抓
      if (Date.now() < busyUntil && (Date.now() < holdUntil || idx > 0)) { await sleep(1000); continue; }
      const url = need.shift();
      const res = await grab(url, REV[url]);
      await cache.put(url, res);
      done++;
      tell({ st: "dl", done, total });
    }
  };
  const lanes = [];
  for (let i = 0; i < LANES; i++) lanes.push(lane(i));
  await Promise.all(lanes);
  tell({ st: "ok", total });
}

self.addEventListener("install", e => {
  e.waitUntil(precache().then(
    () => self.skipWaiting(),
    err => { tell({ st: "fail" }); throw err; }      // 讓 install 失敗:舊版繼續服務,下次再試
  ));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k.indexOf("bingo-") === 0).map(k => caches.delete(k)));
    await self.clients.claim();
    tell({ st: "on" });
  })());
});

/* ============================================================================
   媒體(音檔 / 圖檔)走 cache-first —— 其餘一律維持 network-first
   ──────────────────────────────────────────────────────────────────────────
   ★ 為什麼要分層:network-first 的代價是**每一個檔每一次都要等一趟網路**,
     而 mp3/ 與 img/ 是這個站最大的一塊(約 4.5MB / 19 個音檔 + 14 張圖示),
     內容又幾乎不變 —— 版本一發、CORE 一灌,之後每一次載入都在重新驗證同一批
     不會變的東西。現場的網路正好是最爛的時候(一群人擠同一個熱點)。
   ★ 而程式碼那一層(HTML / JS / CSS)**維持 network-first 不動**:那正是
     「改完上傳卻吃到舊快取、更新出不來」要防的東西,規則與版號一定要最新。
     → 換句話說,分層之後兩邊各自拿到自己要的:碼求新,媒體求快。

   ⚠⚠ **帶 Range 的請求刻意不走快取**,照舊走 network-first。
     理由不是省事:HTMLMediaElement 一律送 Range,而 iOS Safari 對 <audio> 的
     Range 請求**要求回 206**,拿 200 回它會播不出來。快取裡存的一定是 200
     (CORE 是 SW 自己用普通 fetch 灌的),照 cache-first 回過去就等於在
     iPhone 上把那些音效弄啞 —— 而桌機測不出來。
     ★ 好消息是**主路徑不帶 Range**:js/audio.js 的 BGM 與所有音效走的是
       `fetch → decodeAudioData`(普通請求),圖檔的 <img> 也不帶 Range。
       所以「不碰 Range」幾乎不減損效益,只是把 HTMLAudio 那條後備留在原路上。

   ⚠ cache-first **不重新驗證** —— 開發時把一個 mp3 / png **換成新檔但檔名不變**,
     同一個快取裡會繼續放舊的那一份。★ 2026-09-25 起這件事在**發版時自動解決**:
     REV 的指紋變了 → install 會重抓那一個檔。同一版之內反覆換素材才需要按設定頁的「強制更新」。
   ============================================================================ */
const MEDIA_RE = /\.(mp3|wav|m4a|ogg|opus|png|jpe?g|webp|gif|svg)$/i;

/* 206 的回應進不了快取(規格對 Cache.put 明訂要以 TypeError reject),
   所以另外發一次**不帶 Range** 的請求把整個檔收進來,下一次就有得命中。
   ⚠ 要去重:同一個檔在播放期間會連發好幾個 Range 請求,不擋的話會平行抓好幾份。 */
const warming = new Set();
function warmFull(url) {
  if (warming.has(url)) return;
  warming.add(url);
  fetch(url)
    .then(r => (r && r.status === 200) ? caches.open(CACHE).then(c => c.put(url, r)) : null)
    .catch(() => { })
    .then(() => warming.delete(url), () => warming.delete(url));
}

function mediaFirst(req) {
  return caches.match(req).then(hit => {
    if (hit) return hit;
    return fetch(req).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { });
      } else if (res && res.status === 206) {
        warmFull(req.url);
      }
      return res;
    }).catch(() => Response.error());   // 沒命中又沒網路:這個檔本來就沒有
  });
}

/* ============================================================================
   程式碼(HTML / JS / CSS / JSON):network-first + 「太慢就先用快取」,而且**一頁一致**
   ──────────────────────────────────────────────────────────────────────────
   ★ 每一頁(client)開頭那個導覽請求決定這一頁的「種類」,之後這一頁的 JS / CSS 都照它走:
       cache  導覽太慢 / 沒網路 → 整頁都從快取拿(快取裡是同一版的一整套,拼不出新舊混搭)
       same   網路回來的 HTML 跟快取是同一版 → 子資源也可以「太慢就先用快取」
       other  網路上已經是別的版本(新版剛推、這支 SW 還是舊的)→ 子資源只走網路,
              快取裡的舊 JS 一個都不拿來頂(那就是「新 HTML + 舊 JS」)
   ★ 同理,**只有 same 的回應才寫回快取**:別的版本的檔寫進這一版的快取,
     下一次離線開頁就會拼出混搭。新版的檔一律由新版 SW 的 install 收進它自己的快取。
   ⚠ 這張表只活在記憶體裡(SW 閒置 30 秒就可能被收掉)—— 查不到就當 other,
     也就是退回原本的 network-first,不會更糟。
   ⚠⚠ 更新檢查(no-store + Range)與強制更新(reload)**一律直接走網路**、不吃這一套:
     拿快取回給它們等於永遠查不到新版。
   ============================================================================ */
const kinds = new Map();   // clientId → Promise<"cache"|"same"|"other">
function mark(id, p) {
  if (!id) return;
  kinds.set(id, p);
  if (kinds.size > 40) kinds.delete(kinds.keys().next().value);
}
/* 只讀 HTML 開頭找 <meta name="version">(十六頁都在前 3 KB 內,test-version 的 D 節守)。
   讀的是 clone 的那一條,不影響頁面本身的串流。 */
async function peekVersion(res) {
  try {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let txt = "";
    while (txt.length < 8192) {
      const { done, value } = await reader.read();
      if (done) break;
      txt += dec.decode(value, { stream: true });
      const m = /<meta\s+name="version"\s+content="([^"]+)"/i.exec(txt);
      if (m) { reader.cancel().catch(() => { }); return m[1]; }
    }
    reader.cancel().catch(() => { });
  } catch (_) { }
  return "";
}
const race = (p, ms) => Promise.race([p.then(r => r, () => null), sleep(ms).then(() => null)]);

async function onNavigate(e) {
  const req = e.request;
  const key = req.url.split("#")[0].split("?")[0];
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  let setKind = () => { };
  mark(e.resultingClientId, new Promise(r => { setKind = r; }));
  const net = fetch(req).then(res => {
    if (res && res.status === 200) {
      const a = res.clone(), b = res.clone();
      peekVersion(a).then(v => {
        const k = baseVer(v) === VERSION ? "same" : "other";
        setKind(k);
        if (k === "same") cache.put(key, b).catch(() => { });
      });
    } else setKind("other");
    return res;
  });
  if (!cached) {
    try { return await net; }
    catch (_) { setKind("other"); return (await caches.match(key)) || (await caches.match("./app.html")) || Response.error(); }
  }
  const first = await race(net, NET_WAIT_MS);
  if (first) return first;
  setKind("cache");            // 已經 resolve 過(網路其實回來了)的話這一行不生效
  net.catch(() => { });        // 網路那一趟照樣跑完,是同一版就順手更新快取
  return cached;
}

async function onCode(e) {
  const req = e.request;
  const p = e.clientId ? kinds.get(e.clientId) : null;
  const kind = p ? ((await race(p, NET_WAIT_MS)) || "other") : "other";
  const cache = await caches.open(CACHE);
  if (kind === "cache") { const hit = await cache.match(req); if (hit) return hit; }
  const net = fetch(req).then(res => {
    /* ⚠⚠ 條件是 status === 200,**不可以寫 res.ok**(v1.156.0 修)。
       `Response.ok` 涵蓋 200~299,所以 **206(Partial Content)的 ok 是 true** ——
       而規格對 `Cache.put` 明訂 206 要以 TypeError reject(SW console 會被 unhandled
       rejection 塞滿,把真正的快取錯誤埋掉)。
       ⚠ 就算條件收成 200,`.catch()` 還是要留(配額滿、私密瀏覽都會 reject)。 */
    if (kind === "same" && res && res.status === 200) cache.put(req, res.clone()).catch(() => { });
    return res;
  });
  if (kind === "same") {
    const hit = await cache.match(req);
    if (hit) {
      const first = await race(net, NET_WAIT_MS);
      if (first) return first;
      net.catch(() => { });
      return hit;
    }
  }
  try { return await net; }
  catch (_) { return (await caches.match(req)) || Response.error(); }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 外部(Firebase / 字型)不攔,直接走網路

  const ranged = !!req.headers.get("range");
  // 媒體且不帶 Range → cache-first(見上面那一大段)
  if (MEDIA_RE.test(url.pathname) && !ranged) { e.respondWith(mediaFirst(req)); return; }
  // 更新檢查 / 強制更新 / 帶 Range → 直接網路,失敗才退回快取(不寫回、不逾時)
  if (ranged || req.cache === "no-store" || req.cache === "reload") {
    e.respondWith(fetch(req).catch(() => caches.match(req).then(hit => hit || Response.error())));
    return;
  }
  if (req.mode === "navigate") { e.respondWith(onNavigate(e)); return; }
  e.respondWith(onCode(e));
});

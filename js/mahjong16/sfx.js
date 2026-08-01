"use strict";

/* ============================================================================
   台灣 16 張麻將 — 音效(M16Sfx)。摸打吃碰槓胡各有自己的聲音。

   ── ★ 兩層:eventsOf() 是純函式,play() 才發聲 ──────────────────────────────
     「剛才發生了什麼」完全從**前後兩份 state 的差異**算出來,不靠各個動作點自己記得
     播音。理由是單機與連線的動作路徑完全不同(一邊本地 `st = nx`、一邊等 Firebase
     交易回來才變),但「有人碰了」在兩邊都是同一個 diff。
     ⚠ 這就是為什麼音效**沒有變成第三份「兩份」**(動作列 / 結果卡各有兩份):
       只要兩邊都在 state 換手時呼叫 play(),事件就一定齊,不會有一邊漏播。
     ⚠ eventsOf() 零 DOM、零 Sound 依賴 → node 測得到(tools/test-mj16-sfx.js)。
       所以 Sound 只能在 play() / 樂句裡碰,不可以在頂層執行(註冊也是懶的)。

   ── ★ 音檔優先、合成音墊底 ────────────────────────────────────────────────
     每個事件都註冊成一格 Sound.def() 音效槽,候選檔案是 mp3/mj16/<事件>.mp3|.wav。
     檔案還沒放進去(現在就是)→ 自動退回這裡寫的合成音;之後把錄好的喊牌(「碰!」
     「胡!」)丟進 mp3/mj16/ 就直接生效,**程式一行都不用改**。
     ⚠ v1.71.0 起這一頁的音檔全部收在 **mp3/mj16/** 底下(舊路徑是散在 mp3/ 根目錄的
       `m16-voice-*.wav`):mp3/ 根目錄留給五個遊戲共用的東西(bgm / win / lose / 語音短訊)。
       改路徑要**三個地方一起改** —— 這裡的 ensureDefs、sw.js 的快取清單、兩支產生器
       (tools/gen-mj16-voice-edge.py 與 .ps1)。漏掉 sw.js 那份會離線變成沒聲音。

   ── ★ 刻意不做的兩件事 ────────────────────────────────────────────────────
     ① **宣告視窗沒有提示音**。親友聚會是坐在一起玩的 —— 你手機一響,鄰座就知道你手上
        有他剛打的那張。v1.59.0 那條紅線(不可以洩漏誰在考慮吃碰)藏得住畫面、藏不住
        聲音,所以這裡不給任何「你可以吃碰了」的聲音,提示只留畫面上的按鈕。
     ② **別人摸牌不出聲**。摸牌音只給自己(見 EV.draw),它同時兼任「換你了」——
        四家每一巡都響一次的話,一局要響幾百次。

   ── ★ 聽牌(v1.67.0 改成「有人宣告」)────────────────────────────────────────
     使用者:「聽牌不是主動告知的,是可以讓我選擇要不要按聽牌」——
     所以這一格不是「系統偵測到你聽牌」,而是**有人按下宣告聽牌**(MJT 的 ting 欄位)。

     ★ 這一改讓它變成最單純的一格:宣告是**喊出來的公開動作**,所以
       ①**全桌都播**(不像摸牌只給自己)—— 真牌桌上那一聲「聽牌」本來就是喊給大家聽的
       ②不必再算牌型 → 這一支回到**零依賴**(v1.66.0 為了偵測聽牌相依過 MJT,現在不用了)
       ③沒有洩漏問題:宣告本身就是公開資訊,不需要像宣告視窗那樣藏
     ⚠ 因此它也**沒有自己的開關** —— 照吃 / 碰 / 槓那樣,是規則動作的聲音,不是輔助提示。

   ── ★ 打出的牌會報牌名(v1.71.0 七張字牌 → v1.72.0 全部 34 張)──────────────
     使用者:「我要做的音效是東南西北,還有紅中,發財,白皮這幾個先加進去吧」,接著
     「接下來我想把其他的音效也都做起來,筒條萬,花牌」。牌落桌那一聲之後跟一句牌名,
     **全桌都聽到**(真牌桌上打牌本來就會報一聲)。

     ★ 沒有洩漏問題,所以不受 v1.59.0 那條紅線管:打出去的牌**已經攤在牌河上給大家看**,
       報牌名不多給任何資訊。要藏的是「誰在考慮吃碰」(還沒發生的事),不是「剛才打了什麼」。
     ★ 它**不是一個新的「事件」**,而是「剛才那張是什麼」→ 只有語音一格、**沒有動作聲**
       (拍牌那一下是 discard 那格,兩者疊起來剛好就是「嗒 —— 紅中」)。
       所以它進的是 VOICE 表而不是 EV 表,而排序上緊跟在 discard 後面(見 rank)。
     ⚠ 判定一律看**牌河最後那張**,不可以用「我剛才點了哪張」:連線是等交易回來才換手,
       那時本地已經沒有那個記憶(而且這一支要單機 / 連線共用同一份判斷)。

     ── 花牌不報花名,統一唸「補花」(v1.72.0,問過使用者定案)────────────────
       花牌不是「打出」而是**摸到就攤出來補花**,所以它不走牌名那條路,而是 EV 表裡本來就有的
       `flower` 事件多掛一格語音 → 聽起來是「叮(小鈴)…補花」。因此它歸在**喊牌那一組**:
       不分是哪一張,而且只要語音沒關就唸,不受下面那段「字牌 / 全部牌」影響。

     ── ★ 設定分成兩列(v1.72.0):喊牌一顆開關 + 報牌名三段 ────────────────────
       v1.71.0 只做字牌的理由是「數字牌一局要打三十幾張,每張都唸會變成報帳機」;使用者要把
       筒條萬也做起來,所以那個顧慮**交給現場自己決定**:報牌名有「關掉 / 只有字牌 / 全部牌」
       三段,覺得吵就退回「只有字牌」,**不必連碰吃槓胡一起關掉**(那是另一顆)。
       **預設是「只有字牌」= v1.71.0 的行為**,老玩家升上來聽到的東西不會突然變吵。
       ⚠ 兩件事刻意**不混成同一條軸**:「有人碰了要不要喊出來」與「打出去的牌要不要報」語意不同,
         混在一起的話「只有字牌」會被讀成「只有字牌會喊碰」。
       ⚠ 偏好只在**發聲層**(`sayable()`)判斷 —— `eventsOf` 照舊把事件全部算出來,
         純函式不該知道使用者的偏好(而且測試要分開驗「事件算對了嗎」與「這一格該不該唸」)。
   ============================================================================ */

const M16Sfx = (function(){

  /* ---------- 合成音樂句 ----------
     ★ 音色是「聽得出是哪一個」而不是「好聽」:碰 / 吃 / 槓 都是把牌拍到桌上,差別在
       力道與張數 —— 吃 2 張(輕、兩音上行)、碰 3 張(和弦齊鳴 + 拍擊)、槓 4 張
       (和弦更厚、更長、加亮尾)。全部經過 Sound 的總音量節點。

     ⚠⚠ **能量一定要落在 500Hz ~ 2kHz**,這是 v1.61.0 上線後第一個回報(「試玩了一下,
       沒有聽到」)的唯一原因。第一版把「牌落桌」照真實木頭寫成 190Hz→120Hz 的敲擊,
       數位波形很漂亮 —— 但**手機與筆電的小喇叭在 300Hz 以下幾乎沒有輸出**,
       那一聲在真機上等於無聲,而它是一局要響三十幾次、最常聽到的那一個。
       (當時可聽的成分只有一顆 1250Hz、0.02 秒、vol 0.05 的點擊,等於沒有。)
       低頻可以留一點當「厚度」,但**絕不能讓它當主體**。
     ⚠ 音量也要夠:vol < 0.12 的成分在有背景音樂時聽不出來(補花第一版是 0.10 / 0.07)。
     ⚠ 同時響的和弦會疊加,峰值要留在 0.75 以下(要更多聲部就靠 delay 錯開,見 synthHu)。
     ⚠ 這三條有守門:tools/t-mj16-sfx.html?t=1 攔 AudioContext,逐一檢查每種音都有
       「≥350Hz / ≥60ms / vol≥0.12」的成分 —— 改音色後一定要重跑那一頁。 */
  const T = (f,o)=>Sound.tone(f,o);

  function synthDiscard(){                       // 打牌:牌落桌的「嗒」(主體在中頻,低頻只當厚度)
    T(520,{ type:"triangle", dur:0.09, vol:0.30, slideTo:330 });
    T(1400,{ type:"square", dur:0.05, vol:0.12 });
    T(180,{ type:"triangle", dur:0.08, vol:0.16, slideTo:120 });
  }
  function synthDraw(){                          // 摸牌(只有自己會聽到,兼「換你了」)
    T(760,{ type:"sine", dur:0.08, vol:0.22 });
    T(1140,{ type:"sine", dur:0.11, vol:0.15, delay:0.05 });
  }
  function synthChow(){                          // 吃:兩音上行,最輕
    T(660,{ type:"triangle", dur:0.11, vol:0.26 });
    T(880,{ type:"triangle", dur:0.16, vol:0.26, delay:0.09 });
  }
  function synthPong(){                          // 碰:三音和弦齊鳴 + 一下拍擊
    [523,659,784].forEach(f=>T(f,{ type:"triangle", dur:0.18, vol:0.16 }));
    T(392,{ type:"triangle", dur:0.10, vol:0.24, slideTo:262 });
  }
  function synthKong(){                          // 槓:四音厚和弦 + 拍擊 + 亮尾(最重)
    [440,554,659,880].forEach(f=>T(f,{ type:"triangle", dur:0.22, vol:0.14 }));
    T(330,{ type:"triangle", dur:0.12, vol:0.22, slideTo:220 });
    T(1319,{ type:"sine", dur:0.24, vol:0.18, delay:0.14 });
  }
  function synthFlower(){                        // 補花:清亮小鈴(頻率刻意不再拉到 2kHz —— 小喇叭放不好又刺耳)
    T(1245,{ type:"sine", dur:0.10, vol:0.22 });
    T(1661,{ type:"sine", dur:0.15, vol:0.16, delay:0.07 });
  }
  /* 胡:華麗上行三連 + 亮頂。
     ⚠ 一定要短(這裡約 0.5s)—— 結果卡隨後還會播 win.wav / lose.wav,
       這一段是「喊胡」那一聲,不是勝利音樂,拖長會和音檔糊成一團。 */
  function synthHu(){
    [659,880,1175].forEach((f,i)=>T(f,{ type:"triangle", dur:0.16, vol:0.26, delay:i*0.07 }));
    T(1568,{ type:"sine", dur:0.32, vol:0.18, delay:0.21 });
  }
  /* 自摸:比胡別人的牌更盛大(四音上行 + 更高的亮頂)。
     ★ 自摸與胡是**兩個事件**而不是同一個 —— state 裡本來就分得出來(over.from === null),
       而牌桌上這兩件事的感受差很多(自摸是三家付)。 */
  function synthZimo(){
    [659,880,1047,1319].forEach((f,i)=>T(f,{ type:"triangle", dur:0.16, vol:0.26, delay:i*0.065 }));
    T(1760,{ type:"sine", dur:0.34, vol:0.18, delay:0.26 });
  }
  function synthWashout(){                       // 流局:兩音下行的收攤感(整體上移一個八度才聽得到)
    T(587,{ type:"triangle", dur:0.20, vol:0.22, slideTo:440 });
    T(392,{ type:"triangle", dur:0.34, vol:0.20, delay:0.16, slideTo:294 });
  }
  /* 聽牌(有人宣告):**往上滑**的一聲 + 亮頂。
     ★ 這一組音效裡只有它是上滑的(打牌 / 碰 / 槓 / 流局全是下滑),所以就算沒聽清楚
       是哪個音,「往上」這個方向本身就分得出來 —— 而它的語意正是「我只差一張了」。
     ⚠ 不要寫成「胡的簡化版」(659→880→1175 那種上行三連):那兩個會被聽成同一件事,
       而胡與聽牌在牌桌上差得最遠。 */
  function synthReady(){
    T(659,{ type:"triangle", dur:0.17, vol:0.26, slideTo:988 });
    T(1318,{ type:"sine", dur:0.22, vol:0.18, delay:0.13 });
  }

  /* ---------- 事件表 ----------
     順序就是「同一個 diff 裡誰先響」(見 play 的錯開延遲):重的、代表整件事的先響。 */
  const EV = [
    { k:"zimo",    synth:synthZimo },
    { k:"hu",      synth:synthHu },
    { k:"kong",    synth:synthKong },
    { k:"pong",    synth:synthPong },
    { k:"chow",    synth:synthChow },
    { k:"discard", synth:synthDiscard },
    { k:"flower",  synth:synthFlower },
    { k:"draw",    synth:synthDraw },
    { k:"washout", synth:synthWashout },
    /* ★ 聽牌排在最後:同一個 diff 裡它一定跟著「我打出一張牌」一起發生,
       而先聽到牌落桌、再聽到「聽牌」才是對的因果順序。 */
    { k:"ready",   synth:synthReady }
  ];
  const ORDER = EV.map(e=>e.k);
  const isAct = k => ORDER.indexOf(k) >= 0;        // 有動作聲的那些(牌名只有語音,不在裡面)

  /* 排序名次。★ 牌名(tile-*)**緊跟在 discard 後面** —— 先聽到牌落桌、再聽到那是什麼牌。
     ⚠ 不可以直接用 ORDER.indexOf():牌名不在 EV 表裡,indexOf 回 -1 會把它排到**最前面**
       (症狀是先聽到「紅中」才聽到牌落桌,因果顛倒)。名次乘 2 就是為了留出這個插空位。 */
  function rank(k){
    const t = k.indexOf("tile-") === 0;
    return ORDER.indexOf(t ? "discard" : k) * 2 + (t ? 1 : 0);
  }

  /* ---------- 喊牌語音層(v1.62.0) ----------
     使用者:「你的吃碰這些,我是可以聽到文字的聲音嗎?目前我試起來是沒有」——
     他要的是真的喊出「碰」這個字,而不是三個音的和弦。

     ★ 與音效槽是**分開的兩層**,刻意不互相取代:音效是「牌拍到桌上」的動作聲,語音是
       喊牌 —— 真牌桌上兩個同時有。所以之後就算他把音效槽換成自己的音效檔,
       語音照樣會疊上去。
     ★ 只有**宣告動作**有語音(碰 / 吃 / 槓 / 胡 / 流局)。摸牌與打牌一局要響三十幾次,
       每次唸字會吵死人 —— 那兩個維持合成音。
     ★ 音檔是 `tools/gen-mj16-voice.ps1` 用系統的 zh-TW 語音(Microsoft Hanhan)產生的,
       **裁掉前後靜音 + 音量正規化**:SAPI 的原始輸出前後各塞一段靜音,單字「碰」也有
       1 秒多,直接用會慢半拍(牌都拍下去了才聽到聲音)。
     ⚠ 刻意**不用瀏覽器的 speechSynthesis**:①各家中文語音差很多,有些 Android 根本
       沒裝中文語音包 ②iOS 還要額外的手勢解鎖 ③它不經過 AudioContext,吃不到靜音與
       音效總音量。換成音檔之後這三個問題全部消失,而且離線也能用。
     ⚠ 語音槽**沒有合成音後備**(synth 傳 null):音檔取不到就是不講話。拿音階去墊會變成
       同一個事件響兩次很像的聲音。 */
  const CALL = { pong:"碰", chow:"吃", kong:"槓", hu:"胡", zimo:"自摸", washout:"流局",
                 /* 「聽牌」和碰 / 吃 / 槓一樣是**喊出來的宣告**(v1.67.0 起是玩家自己按的),
                    所以它本來就該唸出來給全桌聽 —— 這一格從此與其他喊牌完全同級。 */
                 ready:"聽牌",
                 /* 補花(v1.72.0):花牌不報花名、統一唸「補花」(見檔頭)。歸在喊牌這一組 ——
                    不分是哪一張,而且只要語音沒關就唸,不受「字牌 / 全部牌」那一段影響。 */
                 flower:"補花" };

  /* ---------- 牌名(v1.71.0 七張字牌 → v1.72.0 全部 34 張)----------
     key 是 `tile-` + rules.js 的牌代號 → 音檔就是 mp3/mj16/voice-tile-d3.wav 這一組。
     索引 → 代號直接照 rules.js 的編碼**算**:0..8 萬(w) / 9..17 條(b) / 18..26 筒(d) / 27..33 字。
     ★ 刻意寫算式而**不是列 34 行**:編碼本身是規律的,手列容易抄錯一格 —— 而抄錯的症狀是
       「打三筒唸成四筒」,不會炸、只會一直唸錯,沒有人會發現。
     ★ 依然**零依賴**(不去 require MJ16)—— `eventsOf` 能在 node 單獨測的前提(見檔頭)。
       代價是這裡與 rules.js 的編碼綁死,所以 tools/test-mj16-sfx.js 有一條**拿 MJ16.codeOf()
       把 0..41 逐一對答案**的斷言守著:哪天編碼變了,那裡一定紅。
     ⚠ 花牌(34..41)刻意回 null —— 它們走上面 CALL 的 flower 那一格。 */
  const SUITS = ["w","b","d"];
  const SUIT_WORD = { w:"萬", b:"條", d:"筒" };
  const NUM_WORD = ["一","二","三","四","五","六","七","八","九"];
  const HONOR_AT = { 27:"fe", 28:"fs", 29:"fw", 30:"fn", 31:"jz", 32:"jf", 33:"jb" };
  function codeAt(t){
    if(t >= 0 && t < 27) return SUITS[Math.floor(t/9)] + (t%9 + 1);
    return HONOR_AT[t] || null;
  }
  const TILE = { "tile-fe":"東",  "tile-fs":"南",  "tile-fw":"西", "tile-fn":"北",
                 "tile-jz":"紅中", "tile-jf":"發財", "tile-jb":"白板" };
  SUITS.forEach(s=>{ for(let v=1;v<=9;v++) TILE["tile-"+s+v] = NUM_WORD[v-1] + SUIT_WORD[s]; });
  /* 這一格牌名是不是**字牌** —— 三段開關的中間那段(只有字牌)要靠它分。 */
  const HONOR_KEYS = Object.keys(HONOR_AT).map(t=>"tile-"+HONOR_AT[t]);
  const isHonorKey = k => HONOR_KEYS.indexOf(k) >= 0;

  const VOICE = Object.assign({}, CALL, TILE);     // play() 只看這一張(喊牌 + 報牌名同一層)

  /* ---------- 兩個獨立的偏好(v1.72.0;都存在 mahjong16.prefs.v1)----------
       vCall  喊牌(碰 / 吃 / 槓 / 胡 / 自摸 / 流局 / 聽牌 / 補花)—— 一顆開關,預設開
       vTile  報牌名的**範圍**,三段:
                off    不報
                honor  只有東南西北中發白 ← 預設(= v1.71.0 的行為)
                all    再加上筒條萬 —— 一局會唸六七十次,熱鬧但很密

     ★ 為什麼是「一顆 + 三段」而不是單一個四段:兩件事的語意本來就不同(一個是「有人碰了要不要
       喊出來」、一個是「打出去的牌要不要報」),混成一條軸的話「只有字牌」會被讀成
       「只有字牌會喊碰」。設定面板照這個分成兩列。
     ★ 這樣**跨版本相容也不必動手腳**:舊偏好的 `voice` 欄位語意一個字都沒變(還是喊牌開關),
       新的 `tileVoice` 舊版讀不到就忽略。唯一要補的是「v1.71.0 把喊牌關掉的人」——
       那時牌名跟喊牌是同一顆,所以升上來要一起是 off(在 adapter 的 usePrefs 處理)。 */
  const TILE_MODES = ["off","honor","all"];
  let vCall = true;
  let vTile = "honor";
  const tileModeOK = m => TILE_MODES.indexOf(m) >= 0;

  /* 這一格現在該不該唸(只有發聲層看得到偏好,見檔頭)。 */
  function sayable(k){
    if(!VOICE[k]) return false;
    if(k.indexOf("tile-") !== 0) return vCall;     // 喊牌 / 補花
    if(vTile === "off") return false;
    return vTile === "all" || isHonorKey(k);       // 牌名:字牌一律報,筒條萬要 all
  }

  /* ⚠ 發聲前一定要確認 Sound 這一版**有**音效槽那組 API。理由是混合快取:sw.js 是
     network-first,但裝置有可能拿到新的 sfx.js 卻還吃著舊的 audio.js(沒有 def / sfx)——
     那時直接呼叫會 TypeError,而這支是從 render() / applyGame() 裡叫的,
     一路炸上去等於**整個盤面停止重畫**。音效不見是小事,牌桌壞掉是大事。 */
  function ready(){
    return typeof Sound !== "undefined" &&
           typeof Sound.sfx === "function" && typeof Sound.tone === "function";
  }
  let defed = false;
  function ensureDefs(){
    if(defed || !ready() || !Sound.def) return;
    defed = true;
    /* 動作聲:候選音檔**現在還不存在**(等使用者放),所以刻意**不開 HTMLAudio 後備** ——
       那一層對不存在的檔案會「假成功」,合成音就再也不播了(見 audio.js 的 playClipEl)。 */
    EV.forEach(e=>Sound.def("m16"+e.k, ["mp3/mj16/"+e.k+".mp3", "mp3/mj16/"+e.k+".wav"], e.synth));
    /* 語音層(喊牌 + 字牌牌名):沒有合成音後備(見上面那段註解),但音檔是**跟程式一起發佈**
       的 → 開 HTMLAudio 後備,這樣用 file:// 直接開網頁(fetch 被擋)時照樣喊得出來。 */
    Object.keys(VOICE).forEach(k=>Sound.def("m16v"+k, ["mp3/mj16/voice-"+k+".wav"], null, { el:true }));
  }

  /* ==========================================================================
     eventsOf(before, after, me) → ["pong", …]  ★ 純函式,零依賴
     ========================================================================== */
  function eventsOf(before, after, me){
    const out = [];
    if(!before || !after) return out;                       // 第一次進來 / 斷線重連:沒有「前一手」可以比
    /* 不是同一局就不比 —— 換局是整包重發,逐欄位 diff 出來的東西沒有意義
       (症狀會是「開新局的瞬間響一串吃碰槓」)。 */
    if(before.handNo !== after.handNo || before.seats !== after.seats) return out;
    const has = k=>out.indexOf(k)>=0;
    const add = k=>{ if(!has(k)) out.push(k); };

    for(let s=0;s<after.seats;s++){
      const b = before.melds[s] || [], a = after.melds[s] || [];
      if(a.length > b.length){
        const m = a[a.length-1];
        add(m.k === "chow" ? "chow" : (m.k === "kong" ? "kong" : "pong"));
      }else{
        /* 加槓:組數沒變,是原本那組 pung 變成 kong。
           ⚠ 反方向(kong→pung)是**搶槓成立**時把它改回去的(table.js 的 settleWin),
             那不是一次新的槓,不能報。 */
        for(let i=0;i<a.length;i++) if(b[i] && b[i].k === "pung" && a[i].k === "kong") add("kong");
      }
      if((after.flowers[s] || []).length > (before.flowers[s] || []).length) add("flower");
    }

    /* 打牌。★ 順手看「打出去的是不是字牌」→ 多報一格牌名(v1.71.0,見檔頭)。
       ⚠ 一律看**牌河最後那張**:單機是本地換 state、連線是等交易回來,只有牌河是共同的真相。
       ⚠ 牌河沒變長就不報 —— 吃 / 碰 / 明槓會把最後那張**拿走**(table.js 的 claimTo 有
         discards.pop()),那時最後一張換成了前一手打的牌,照報就會把舊的那張再唸一次。 */
    if(after.discards.length > before.discards.length){
      add("discard");
      const d = after.discards[after.discards.length-1];
      const code = d ? codeAt(d.t) : null;
      if(code) add("tile-"+code);
    }

    /* 摸牌只報自己那一家(見檔頭)。「剛摸進來」= 之前沒有輪到我拿著一張摸牌。
       ⚠ 吃 / 碰之後 drawn 是 -1(不摸牌),所以碰完不會多一聲摸牌;槓之後補摸一張會有,
         聽起來就是「槓!…摸一張」,那是對的。 */
    if(after.drawn >= 0 && after.turn === me && !(before.drawn >= 0 && before.turn === me)) add("draw");

    /* 胡的兩種:自摸(from 為 null,三家付)與胡別人打的牌(放槍,一家付)。
       ★ 分成兩個事件是使用者要的(「麻煩再增加自摸的音效」),而 state 裡本來就分得出來。 */
    if(!before.over && after.over)
      add(after.over.type !== "win" ? "washout" : (after.over.from === null ? "zimo" : "hu"));

    /* ★ 聽牌:**有人宣告了**(見檔頭)。全桌都播 —— 那一聲本來就是喊給大家聽的。
       ⚠ 舊 state 沒有 ting 欄位(v1.67.0 之前的房間 / 造出來的測資),一律當成沒宣告。 */
    const tb = before.ting || [], ta = after.ting || [];
    for(let s=0;s<after.seats;s++) if(!tb[s] && ta[s]){ add("ready"); break; }

    out.sort((x,y)=>rank(x) - rank(y));
    return out;
  }

  /* ==========================================================================
     play(before, after, me):偵測 + 發聲
     ★ 同一個 diff 可能有兩件事(「別人打牌」+「我摸一張」、「槓」+「槓上補摸」),
       所以依序錯開 90ms —— 全部疊在同一個瞬間會糊成一聲。
     ========================================================================== */
  /* 排一聲。delay 0 就直接播(排 setTimeout 會多等一個 tick,拍牌聲要即時) */
  function at(key, delay){
    if(!delay){ Sound.sfx(key); return; }
    setTimeout(()=>{ if(ready()) Sound.sfx(key); }, delay);
  }
  function play(before, after, me){
    const ev = eventsOf(before, after, me);
    if(!ev.length || !ready()) return ev;
    ensureDefs();
    ev.forEach((k,i)=>{
      const t = i*90;
      if(isAct(k)) at("m16"+k, t);                 // 動作聲(拍牌 / 摸牌…);牌名沒有這一層
      /* 喊牌 / 牌名壓在動作聲後面 60ms:兩者相隔太近人耳會融成一團,太遠又像回音。
         ★ 沒有語音的事件(打牌 / 摸牌 / 補花)VOICE 裡查不到就自然跳過。
         ★ 牌名自己佔一個 90ms 名次(它排在 discard 後面),所以聽起來是「嗒 —— 紅中」,
           兩聲隔 150ms:比喊牌那 60ms 鬆一點,因為它前面那一下不是同一件事的一部分。 */
      if(sayable(k)) at("m16v"+k, t+60);
    });
    return ev;
  }

  /* 單獨播一個事件(給不是靠 diff 的地方用,例如 tools/t-mj16-sfx.html 試聽頁) */
  function one(k, withVoice){
    if(!ready()) return;
    ensureDefs();
    if(isAct(k)) Sound.sfx("m16"+k);               // 牌名(tile-*)沒有動作聲那一層
    if(withVoice !== false && sayable(k)) at("m16v"+k, 60);
  }
  /* 只播喊牌那一聲(試聽頁要能單獨聽) */
  function say(k){
    if(!ready() || !VOICE[k]) return;
    ensureDefs(); Sound.sfx("m16v"+k);
  }
  /* 進牌桌時把語音音檔先載好。★ 只載**這個模式真的會播**的那些(v1.72.0):
       honor(預設)喊牌 8 + 字牌 7 = 15 個,約 260KB
       all        再加筒條萬 27 個 = 42 個,約 1.2MB
     ⚠ 這不是效能優化,是**正確性**:音效槽是懶載入的,而語音層沒有合成音可以墊 ——
       不預載的話「一局裡第一次碰」永遠是沒聲音的(音檔那時才開始飛),
       使用者只會覺得「有時候有、有時候沒有」。
     ⚠ 所以**換模式之後一定要再叫一次**(setVoiceMode 自己會叫):從 honor 切到 all 的那一刻,
       27 個筒條萬還一個都沒載 —— 不補載的話「換成全部牌」之後第一輪仍然只有字牌出聲。 */
  let primed = false;
  function preload(){
    if(!ready() || !Sound.prime) return;
    ensureDefs();
    primed = true;
    Object.keys(VOICE).forEach(k=>{ if(sayable(k)) Sound.prime("m16v"+k); });
  }

  return {
    eventsOf, play, one, say, preload,
    sayable,                                        // 這一格在目前模式下該不該唸(三段開關)
    KEYS:ORDER,
    VOICE_KEYS: Object.keys(VOICE),                 // 喊牌 + 牌名:play() 可能會播的全部語音格
    CALL_KEYS: Object.keys(CALL),                   // 喊牌(宣告動作)+ 補花
    TILE_KEYS: Object.keys(TILE),                   // 全部 34 張牌名(v1.72.0)
    HONOR_KEYS,                                     // 其中的七張字牌 —— 三段裡「只有字牌」的範圍
    TILE_MODES,
    /* 牌索引 → 語音格。給測試拿 MJ16.codeOf() 對答案用(codeAt 是算出來的,見那裡的註解);
       花牌回 null —— 它們走 flower 那一格。 */
    tileKeyOf(t){ const c = codeAt(t); return c ? "tile-"+c : null; },
    wordOf(k){ return VOICE[k] || ""; },
    /* 喊牌那一顆(名字沿用 v1.62.0 的 setVoice / voiceOn —— 偏好欄位與呼叫點都還在用)。 */
    setVoice(v){ vCall = !!v; },
    voiceOn(){ return vCall; },
    /* 報牌名的範圍。★ 換過之後要補載音檔:從 honor 切到 all 的那一刻 27 個筒條萬一個都還沒載
       (見 preload 的註解)。
       ⚠ 但**只在已經預載過的情況下**才補 —— 啟動時讀偏好也會走到這裡,那時還沒有任何使用者
         手勢,直接 preload 等於白白建立 AudioContext 並抓十幾個檔(有些裝置根本還解不開)。
         真正的入口是進牌桌時的 preload(),以及設定面板那一列(那裡有手勢,自己會叫一次)。 */
    setTileMode(m){ if(tileModeOK(m)){ vTile = m; if(primed) preload(); } },
    tileMode(){ return vTile; }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16Sfx;

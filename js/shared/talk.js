"use strict";

/* ============================================================================
   即時語音(WebRTC mesh)—— 十三個連線遊戲共用
   ──────────────────────────────────────────────────────────────────────────
   ★★★ 名字叫 Talk 不叫 Voice:**`Voice` 已經被 js/audio.js 佔走了**(語音留言:
       錄 6 秒 WAV 送出去,非即時)。全專案沒有最外層 IIFE,同一頁的各檔共用全域
       詞法作用域 → 撞名就是整頁 SyntaxError。兩者是**完全不同的功能**,
       使用者看到的圖示也要分開:語音留言 = 🎤(emoji 字面)、
       即時語音 = 喇叭 / 麥克風(**自繪 SVG**,見下面 ICO_LISTEN 的長註解)。

   ── 這一支在做什麼 ────────────────────────────────────────────────────────
     房裡每兩個人之間拉一條 RTCPeerConnection(mesh),音訊 **P2P 直連**,
     不經過 Firebase 也不經過任何伺服器。Firebase 只用來交換 SDP 與 ICE ——
     那是一次性的幾筆 JSON,跟筆劃 / 棋步比起來微不足道。

   ★★★ 四條紅線
   ① **絕對不可以走 txGame。** ICE candidate 是高頻小封包(一條連線十幾筆),
      整包重寫 game 節點會把流量炸掉,還會跟核心的 rev 單調遞增互相拖累。
      → 走**獨立節點** rtc/{收件人}/{寄件人},與你畫我猜的 ink 同一個道理。
      ⚠ 那些子節點的監聽**核心收不掉**(leave() 只 off() 得到 roomRef.child("rtc")),
        所以 stop() 一定要自己拆 —— 漏掉就是「離開房間之後還在收上一間的 SDP」。

   ② **「聽」與「講」是兩顆鈕,不可以合成一顆** —— 但它們**不是互相獨立的**。
      · 只想聽的人**不該被要求麥克風權限** → getUserMedia 只在開「講」時才叫,
        這也是為什麼 direction 要算出四種狀態而不是開 / 關兩種(見 dirOf)。
      · 而「講」**蘊含**「聽」(v2.1.0):開講會順手開聽、關聽會順手關講,
        只有「聽著但閉麥」是留下來的中間狀態(暫停說話)。
        規則與理由見下面 doListen / doSpeak 的長註解 —— ⚠ 那三條規則要寫在
        **狀態層**,寫進 click handler 的話從對外 API 進來就繞過去了。

   ③ **關「講」要真的把 track 停掉,不可以只設 enabled=false。**
      enabled=false 的話系統的麥克風指示燈**還亮著** —— 對「親友聚會」這種
      受眾來說,那個燈亮著就等於「你說沒在錄可是我看它還在錄」。隱私上要看得見。
      重開時權限已經給過,不會再跳一次詢問。

   ④ **開麥一定要 BGM.duck(true)。** 這不是禮貌問題:Android 一開 getUserMedia
      整個音訊會被 OS 切到通話路徑(VOICE_COMMUNICATION),還在播的背景音樂會被硬走
      聽筒 / 通話音質,變得很難聽。這是 v1.15.1 用「快速語音留言」換來的教訓,
      原始處方在 js/game.js 的 refreshBgmDuck() —— 這裡沿用,不要自己發明。
      ⚠ iOS 另外要 setAudioSession("play-and-record"),否則 getUserMedia 會被
        playback session 擋下 → 「無法啟動」。那支函式在 audio.js 裡是私有的,
        所以這裡自己 feature-detect 一份(兩行,不值得為它改 audio.js 的介面)。

   ── 誰對誰發起(glare)──────────────────────────────────────────────────────
     兩台同時 offer 會互相打架(glare)。這裡用 **Perfect Negotiation**:
     以 playerId 的字典序決定禮讓方 —— `me > peer` 的當 polite(收到衝突的 offer
     就自己讓步回滾),另一邊當 impolite(堅持自己的)。
     ⚠ 判準一定要**兩台算出來相反**,所以只能用兩邊都看得到、且不會變的東西(pid)。
       用「誰先進房」之類的會在重連後翻轉,兩台同時 polite = 永遠接不上。

   ── 說話中的指示燈 ────────────────────────────────────────────────────────
     **在本地分析收到的音訊**(AnalyserNode),不寫 DB。寫 DB 的話等於每個人每秒
     好幾筆寫入,那比語音本身還貴,而且沒有任何必要 —— 音訊都已經在手上了。
   ========================================================================== */

const Talk = (function () {

  /* ---------- 對外設定:ICE 伺服器 ---------- */
  /* STUN 只做一件事:告訴你「你在公網上長什麼樣」,連線本身還是 P2P 直連。
     **連不上的時候負責救援的是 TURN**(把音訊中繼過去)。沒有 TURN 的話,雙方都在
     對稱 NAT(symmetric NAT)後面的組合會直接失敗 —— 一般估 10~20%,而台灣的行動網路
     普遍是 CGNAT,實際會更高。
     ⚠ 症狀是「我開了麥、畫面上一切正常,可是沒有人聽得到我」,最難自己發現的一種壞掉
       (所以 onconnectionstatechange 失敗時會把講鈕轉成紅色閃爍 —— `.tk-btn.bad`)。

   ★★★ 為什麼用 Open Relay 這組**公共**服務,而不是自己去申請 Cloudflare / Metered 的金鑰:
       **這個 repo 是公開的**(見 CLAUDE.md 的上傳策略:`.git` 會 push 上 GitHub)。
       自己申請的金鑰不管靜態或動態,寫進這一支就等於公開發佈 → 任何人都能刷掉你的額度,
       而且撤換要重新部署。Open Relay 的帳密**本來就設計成公開的**(帳號密碼都是
       `openrelayproject`),放進公開 repo 沒有任何問題 —— 這是選它的**主要**理由,
       不是因為它比較好。
   ⚠⚠ 代價:免費公共服務,**沒有任何可用性保證**,哪天它停掉我們這邊不會有半點徵兆 ——
       **壞掉的 TURN 與沒有 TURN 在畫面上完全一樣**(都是 relay candidate 拿不到)。
       → 所以有 `tools/t-turn-check.html`:它會真的去要一輪 candidate,一台一台告訴你
         拿不拿得到 relay。**懷疑語音連不上就先開那一頁**,不要用症狀猜。
   ⚠ 要換成自己的金鑰(要穩定 / 流量大)就改這個陣列,**別的地方一個字都不必動** ——
     十四頁共用這一份。步驟見 notes/24-即時語音.md 第八節。

   ★ 隱私:走 TURN 時音訊會經過中繼伺服器,但 **WebRTC 的媒體一律是 DTLS-SRTP
     端對端加密**,TURN 只搬得動加密後的位元組,解不開內容(它看得到的是
     「誰跟誰在通話、用掉多少流量」)。

   ⚠ `turn:` 少了 username / credential 會被**靜靜忽略**(不報錯,只是永遠沒有 relay
     candidate)—— t-talk-e2e 的 J 節就是在守這一條。 */
  const TURN_USER = "openrelayproject";
  const TURN_PASS = "openrelayproject";
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    /* 80 與 443 是刻意的:公司 / 公共 Wi-Fi 常常只放行這兩個 port,而 TURN 的預設
       3478 是最先被擋掉的那一個。最後那條 `turns`(TLS over TCP:443)是最後手段 ——
       最慢,但因為長得跟 HTTPS 一樣,幾乎穿得過所有防火牆。
       ⚠ 三條都留著不會變慢:ICE 是同時去問全部的,誰先回來就先用誰。 */
    { urls: "turn:openrelay.metered.ca:80", username: TURN_USER, credential: TURN_PASS },
    { urls: "turn:openrelay.metered.ca:443", username: TURN_USER, credential: TURN_PASS },
    { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: TURN_USER, credential: TURN_PASS }
  ];
  const SPEAK_THRESHOLD = 0.035;   // 音量超過這個值算「正在說話」(0~1;實測底噪約 0.005~0.015)
  const SPEAK_HOLD_MS = 320;       // 低於門檻後還亮多久(不加這個會跟著音節一閃一閃)
  /* 徽章那一顆用的是**另一段**保持時間(v2.3.8)。
     ⚠ 不可以共用 SPEAK_HOLD_MS:320ms 是給綠光環用的(要跟得上音節),
       拿它當「他的麥克風是不是開著」的判準,**字與字之間的空隙就會讓斜線閃出來**。 */
  const LIVE_HOLD_MS = 2500;

  /* ---------- 自己的音量(v2.3.7)----------
     ★ 起點是使用者的一句話:「如果其他人講話的時候框框會變綠色的,我希望自己也可以有
       這個功能,比較好的判斷到底現在有沒有收到聲音」。
     ★ 做法:遠端量的是**收到的**音訊,自己這一份量的是**麥克風送出去的**音訊 ——
       於是自己的晶片也會跟著亮綠,而且它回答的是一個更重要的問題:
       **「我的麥克風到底有沒有在動」**(靜音的麥克風與沒人在講話,以前完全分不出來)。
     ⚠ 門檻比遠端**高一階**:遠端那一路經過對方的 AGC 之後是壓平的,自己這一路是原始輸入,
       用 0.035 的話呼吸聲就會讓自己的框一直閃。
     ⚠⚠ **LOCAL_METER 是刻意留的一行開關。** 它會 `createMediaStreamSource()`,而 WebKit
       上「remote stream 進 AudioContext 會把 <audio> 的聲音偷走」是踩過的坑(v1.182.1,
       遠端那一路因此整段跳過 WebKit)。這裡接的是**本地麥克風**——沒有任何 `<audio>` 在播它,
       那個坑的機制構成不了;而且刻意用**另一顆** AudioContext(`lacx`),與遠端那顆完全不共用。
       但 **iPhone 上還沒實機驗證** → 萬一現場回報「iPhone 聽不到別人」,
       **第一個要關掉的就是這一行**(改成 false,別的地方一個字都不必動)。 */
  const LOCAL_METER = true;
  const LOCAL_THRESHOLD = 0.055;

  /* ---------- 對帳(v2.3.7)----------
     ★★★ 為什麼非要不可:WebRTC 的協商有**太多會靜靜失敗**的路徑(信被刪掉、glare 撞在
       死角、對方換了一條全新的 PC、SDP 掉一封),而它們的共同症狀是
       **「PC 停在 connecting,永遠不會變 failed」** —— 於是
       `onconnectionstatechange` 一次都不會來,沒有紅色、沒有 restartIce、沒有 toast,
       使用者只會說「有人聽不到某個人」。三人局現場回報的正是這個。
     → 逐一補完那些路徑是補不完的,一定要有一個**週期性對帳**兜底(同跳棋每 3 秒對帳)。
     ⚠⚠ 兩條紀律:
       ① **判準只能是「壞了多久」,不可以是「試了幾次」** —— 而且 `connected` 的線
          一碰就是一次重新協商 + 幾秒空白,所以絕對不可以無條件重建。
       ② **修復動作只能由這個節奏發動**,不可以寫進 onDesc 的 glare 分支:
          「一忽略 offer 就重貼」會讓兩台互相把同一份 SDP 貼到天亮。 */
  const REPAIR_MS = 3000;          // 對帳週期
  const NUDGE_MS = 3000;           // 壞這麼久 → 重貼一次自己的 SDP(對方的信箱可能被清掉了)
  const REBUILD_MS = 9000;         // 壞這麼久 → 整條 PC 重建
  const REBUILD_MAX_MS = 60000;    // 重建的間隔上限(每次翻倍,免得一直在重建)
  const BAD_MS = 20000;            // 壞這麼久 → 標紅(讓使用者看得見,而不是以為大家都沒在講)
  const ORPHAN_MAX = 80;           // 「還沒有 PC 就先到」的 candidate 最多收著幾筆

  /* ---------- 狀態 ---------- */
  let hooks = null;            // { ref, me, players, nameOf, onState } —— 由 mp-core 掛進來
  let listen = false, speak = false;
  let localStream = null;
  let sigRef = null;           // rtc/{我}
  const peers = Object.create(null);   // peerId -> P
  /* ⚠ **不可以拿 peers 當「我訂閱了誰」的清單**:teardown() 是先 dropPeer 把 peers
     清空、才呼叫 unwatch(),那時再去遍歷 peers 就是空的 → 子節點的監聽一個都沒拆掉,
     而症狀正是檔頭紅線 ① 說的「離開房間之後還在收上一間的 SDP」。所以另記一份。 */
  const watched = Object.create(null);  // fromId -> true
  let audioBox = null;         // 裝所有 <audio> 的隱藏容器
  let meterTimer = null;
  let acx = null;              // 分析用的 AudioContext(與 audio.js 那幾個各自獨立)
  let statDone = false;        // 這一間房的使用統計記過了沒(見下面 bumpStat)

  /* ---------- 世代(epoch)---------- */
  /* ★★★ 每一條 PC 有一個「世代」字串,跟著 SDP 與 candidate 一起寄出去(payload 的 `g`)。
     它解決兩件用別的方法解不掉的事:
       ① **陳舊的 SDP 變成看得出來的**。v1.182.1 為此在 attach() 整個清掉自己的信箱,
          而那是個競態:清的時候別人可能剛把 offer 寄到 —— 三人局(有人先開語音)必中,
          後果是對方永遠在等一封被刪掉的信的回音(死鎖)。有了世代就不必用時機去猜,
          **所以那個 wipe 已經拿掉了**(見 attach)。
       ② **對方換了一條全新的 PC**(斷線重連 / 他那邊重建)時我必須跟著重建 ——
          舊 PC 收到換過 DTLS fingerprint 的 offer 一定套不上去,而錯誤是被吞掉的。
     ⚠⚠ **只有 offer 才依世代重建,answer 絕對不可以** —— answer 是「回應我剛送出的 offer」,
       它帶的新世代正是對方為了回應我而重建出來的。照 answer 重建的話兩台會**無限互相重建**。
     ⚠ 鹽(sess)每次 attach() 重抽,不可以只用遞增序號:重新整理頁面後序號會從 1 重來,
       上一輪殘留的信會跟新的 PC 撞成同一個世代 → ① 就白做了。 */
  let sess = "";
  let genSeq = 0;
  function newGen() { return sess + "." + (++genSeq); }

  const orphans = Object.create(null);  // fromId -> [candidate payload]:還沒有 PC 就先到的
  const retry = Object.create(null);    // fromId -> { at, gap }:重建的節流(要活過 dropPeer)
  const chain = Object.create(null);    // fromId -> Promise:每條線的處理序列(見 seq)
  let repairTimer = null;

  /* 本地麥克風的音量分析。⚠ 刻意與遠端那顆 acx **分開**(見上面 LOCAL_METER 的長註解)。 */
  let lacx = null, lsrc = null, lanalyser = null, ldata = null;
  let localSpeaking = false, localLoud = 0;

  /* 晶片上的語音狀態徽章(見下面 paintChips)。 */
  let chipObs = null, chipBusy = false, chipSig = "";
  let gestureArmed = false;

  /* ★★★ 每條線一個處理序列。`onDesc` / `onCand` 都是 async,而 Firebase 的事件是**可以連著
     來兩發**的(offer 後面緊跟 answer、SDP 與 candidate 同時到)—— 兩個 async 交錯執行會
     把同一顆 PC 的狀態機推進錯的狀態,而 `setRemoteDescription` 拋出來的例外是被吞掉的
     → 又一種靜靜地連不上。
     ⚠ 前一筆失敗也要繼續(所以是 `.catch(()=>{})` 而不是讓它斷鏈):
       一次失敗不該把這條線後面所有的信卡死。 */
  function seq(id, fn) {
    const prev = chain[id] || Promise.resolve();
    const next = prev.then(() => fn()).catch(() => { });
    chain[id] = next;
    return next;
  }

  function supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices &&
              navigator.mediaDevices.getUserMedia);
  }
  function me() { return hooks && hooks.me(); }
  function on() { return listen || speak; }

  // iOS 16.4+:錄音前要把 session 切成可錄音,否則 getUserMedia 被 playback session 擋下。
  // (audio.js 有一份私有的同名函式;那支沒有對外,這裡自己留兩行)
  function audioSession(type) {
    try { const as = navigator.audioSession; if (as && as.type !== type) as.type = type; } catch (e) { }
  }
  // BGM 的 duck 由 audio.js 提供;它不在的頁面(理論上沒有)就靜靜跳過
  function duck(v) { try { if (window.BGM && BGM.duck) BGM.duck(!!v); } catch (e) { } }

  /* ---------- 播放端:每個 peer 一個 <audio> ---------- */
  function box() {
    if (!audioBox) {
      audioBox = document.createElement("div");
      audioBox.id = "tkAudio";
      audioBox.setAttribute("aria-hidden", "true");
      // 不能用 display:none —— 某些瀏覽器會連帶不播;移到畫面外就好
      audioBox.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden";
      document.body.appendChild(audioBox);
    }
    return audioBox;
  }

  /* ---------- direction:兩個開關 → 四種狀態 ----------
     ⚠ 一定要走 transceiver 的 direction,不可以用「有沒有 addTrack」來表達:
       只聽的人沒有 track 可以 add,但他**必須**在 SDP 裡說明自己要收 —— 否則
       對方不會送。inactive 只在「兩個都關」時出現,而那時我們根本不建 PC。
     ⚠ v2.1.0 起 speak ⇒ listen(見下面 doSpeak / doListen 的長註解)→
       **"sendonly" 已經不可能出現**。留著它是防禦性的:哪天不變式被破掉,
       這裡回對的 direction 至少還聽得到人講話,不會整條線變成 inactive。 */
  function dirOf() {
    if (speak && listen) return "sendrecv";
    if (speak) return "sendonly";   // 見上:目前到不了
    if (listen) return "recvonly";
    return "inactive";
  }

  /* ---------- 麥克風 ---------- */
  /* ★★★ getUserMedia **一定要包 timeout**(v1.182.0)。
     它在兩種情況下會「永遠不 resolve、也不 reject」:
       ① 使用者把權限提示晾在那裡不點(很常見 —— 提示跳出來的時候人正在看牌);
       ② headless / 沒有音訊裝置的環境(這就是 t-talk-e2e 一開始整支卡死的原因)。
     而呼叫端(下面 bindUi 的 click handler)為了擋連點有一個 `uiBusy` 旗標,
     它是在 finally 裡才放掉的 → 永遠不回 = **旗標永遠卡著 = 那兩顆鈕從此按不動**,
     而且畫面上完全看不出為什麼。20 秒足夠讓人回應提示,又不會真的鎖死。
     ⚠ 超時之後才回來的 stream 要自己收掉,否則麥克風開著沒有人管
       (系統的錄音指示燈會一直亮 —— 那正是紅線 ③ 要避免的事)。 */
  const MIC_WAIT_MS = 20000;
  async function openMic() {
    if (localStream) return localStream;
    audioSession("play-and-record");
    /* 三個處理一律開著:回音消除是**必要**的 —— 沒有它,你聽到的別人的聲音會從你的
       麥克風再送回去,全房立刻嘯叫(而親友聚會很可能好幾台就在同一個房間裡)。 */
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no-mic-api");
    const p = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    let timer = null;
    try {
      localStream = await Promise.race([
        p,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("mic-timeout")), MIC_WAIT_MS); })
      ]);
    } catch (e) {
      /* 超時(或被拒絕)。p 之後若還是回來了,那個 stream 沒有人持有 → 停掉它。
         ⚠ 只有 timeout 先到才會走到這裡而 p 仍在飛;p 自己 reject 的話下面那個
           catch 收掉就好,不會有東西要停。 */
      p.then(s => { try { s.getTracks().forEach(t => t.stop()); } catch (_) { } }).catch(() => { });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    armMicWatch();
    return localStream;
  }

  /* ★★★ 麥克風被系統收走時要有人知道(v2.3.7)。
     track 在行動裝置上**很容易** end:接電話、別的 App 搶麥、切藍牙耳機、iOS 鎖屏。
     以前完全沒有掛 `onended`,下場是:
       · 我這邊的講鈕**還是亮著的**、我也還聽得到別人 → 我完全不覺得有問題;
       · 但 sender 手上那條 track 已經 ended → **全房都聽不到我了**。
     這是唯一會造成**真正單向**失聯的洞,而且症狀跟「一條線沒接起來」長得一模一樣
     (現場回報「有人聽不到某個人」時,這是第二個要排除的原因)。
     ⚠ `track.stop()` 依規格**不會**觸發 ended,但還是在 closeMic 裡先拆掉 handler ——
       不然哪天某個瀏覽器多送一發,就會在關麥的路徑上跳一則莫名的 toast。 */
  function armMicWatch() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(t => { t.onended = onMicLost; });
  }
  function onMicLost() {
    if (!speak) return;
    /* track 已經 ended,沒有東西要 stop() —— 直接放掉它,不要走 closeMic
       (那支會去 stop 一條死掉的 track,而且會把這裡要留的旗標順序弄亂)。 */
    localStream = null;
    speak = false;
    stopLocalMeter();
    duck(false);
    audioSession("playback");
    sync();
    toast("麥克風被系統中斷了(可能是來電或其他 App),請再按一次「講」");
  }

  function closeMic() {
    if (!localStream) return;
    localStream.getTracks().forEach(t => { try { t.onended = null; t.stop(); } catch (e) { } });
    localStream = null;
    stopLocalMeter();
    if (!speak) audioSession("playback");
  }

  /* 播放遠端音訊。失敗(多半是 iOS 的自動播放政策)就記一筆,等下一次手勢補播。 */
  function playNow(P) {
    if (!P.el || !P.stream) return;
    try {
      const p = P.el.play();
      if (p && p.then) p.then(() => { P.needPlay = false; }).catch(() => { P.needPlay = true; });
      else P.needPlay = false;
    } catch (e) { P.needPlay = true; }
  }
  /* ★ 使用者按了任一顆鈕 = 一次貨真價實的手勢 → 把之前被擋下來的補播掉。
     ⚠ 這一支要在**每次**按鈕時呼叫,不是只在開的時候:iPhone 上「連上了卻沒聲音」
       多半只差這一下,而使用者的直覺就是再按一次(那正好也是一次手勢)。 */
  /* 把一顆 AudioContext 叫醒。⚠ 兩層都要吞:`resume()` 在 closed 的 context 上**同步拋錯**,
     而它平常回的是 Promise —— 沒給 `.catch` 的話手機切回前景時會噴一整排
     unhandledrejection(iOS 在沒有使用者手勢時本來就會拒絕這個請求)。 */
  function resumeCtx(c) {
    if (!c || c.state !== "suspended") return;
    try { const p = c.resume(); if (p && p.catch) p.catch(() => { }); } catch (e) { }
  }
  /* 有沒有哪一顆分析用的 context 睡著了。⚠ **兩顆都要問**(v2.3.9):
     只問遠端那顆 `acx` 的話,本地那顆(`lacx`)睡著時這道閘就把補救整個濾掉了 —— 見下面。 */
  function ctxAsleep() {
    return (!!acx && acx.state === "suspended") || (!!lacx && lacx.state === "suspended");
  }
  function kickPlay() {
    for (const id in peers) { const P = peers[id]; if (P.needPlay) playNow(P); }
    resumeCtx(acx);
    /* ★★★ v2.3.9:**本地麥克風那顆也要叫醒**。手機切去 LINE / 接個電話再回來,系統會把
       **所有** AudioContext 壓成 suspended,而 suspended 的分析器
       `getByteTimeDomainData()` 讀到的是**凍結的舊資料** —— 於是自己那個綠框
       (v2.3.7 使用者點名要的「我到底有沒有在送話」)開始說謊,而且兩種說法都是錯的:
         · 切走的那一刻剛好在講話 → 讀到的永遠是那一格響亮的波形 → **框永遠亮著**
           (「我以為我在講話」那一類裡最糟的一種);
         · 切走的那一刻是安靜的 → 框**再也不會亮**,使用者會以為麥克風壞了。
       ⚠ 麥克風本身沒事、聲音照樣送得出去 —— 壞掉的**只有指示燈**,所以完全靠回報才看得見。 */
    resumeCtx(lacx);
  }

  /* ==========================================================================
     省流:Opus DTX + 依 mesh 人數動態限碼率(v2.5.1)
     ──────────────────────────────────────────────────────────────────────────
     ★★★ 為什麼是**上行**:mesh 的下行本來就只有 N-1 條進來、每個人一份;上行卻是
       **同一段話乘以 N-1 份**(六人局要同時送給另外五個人)。而手機那一段
       (行動網路 / 家用非對稱寬頻)本來就是整條路上最窄的。所以要省只省上行。

     ① **DTX(靜音期不送封包)** —— 真正大的那一筆。一場派對裡每個人有八成時間
        沒在講話,但編碼器**照樣每 20ms 送一包**。`usedtx=1` 之後靜音期只送稀疏的
        comfort noise,那八成時間的上行幾乎歸零。
        ⚠ 它要靠 `noiseSuppression` 把底噪壓掉才咬得住(openMic 本來就開著)——
          吵的環境省得少,但那不會壞掉,只是省得少。
     ② **碼率上限** —— 空間比 DTX 小得多。Chrome 單聲道 Opus 預設就在 32kbps 附近
        (**64kbps 是立體聲的預設**,而 openMic 已經指定 channelCount:1 → 走不到那裡)。
        它真正的價值在「**人多才收緊**」:兩個人講話沒有理由降音質,六個人才有。

     ★★★ 兩個關鍵設計,共同點是**只改自己的上行、不依賴對方**:
     ⚠ **DTX 改的是「對方寄來的」那份 SDP,不是自己送出去的那份。**
       RFC 7587 的 `usedtx` / `maxaveragebitrate` 是**接收方的宣告**(「我希望收到什麼」),
       由**送話方的編碼器**去遵守 → 想讓**我的**編碼器開 DTX,要改的就是
       **對方寄給我的**那一份(它宣告的正是對方想收到什麼)。兩個好處:
         · 只碰 `onDesc` 一個地方,**完全不動 Perfect Negotiation 的
           `setLocalDescription()` 無參數形式** —— 那個形式是刻意的(見 onDesc 裡
           `have-remote-offer` 那一段的長註解);要改自己送出去的 SDP 就得拆成
           `createOffer()` → 改字串 → `setLocalDescription(o)`,那是在整支最脆弱的
           地方動刀,而它壞掉的樣子正好是「要開開關關好幾次才通」。
         · **不依賴對方的版本**。對方跑舊版(收到 SDP 不會改)也一樣成立:
           我改我收到的、我的編碼器照做 —— 每一台各自管好自己的上行,零跨版本相依。
     ⚠ **碼率走 `sender.setParameters()`,刻意不寫進 SDP。**
       寫進 SDP 的話「人數變了要改碼率」就得**重新協商**,而重新協商 = 幾秒空白
       (紅線 14:connected 的線一個字都不要碰)。setParameters 不必協商。

     ⚠ 兩個都留一行 kill switch(同 LOCAL_METER 的先例)。DTX 已知的代價是
       **句首第一個音節偶爾會被削掉一點**(編碼器要重新起來),而那聽起來就像
       「網路不好」—— 現場分不出來,所以它一定要能一行關掉再聽一次。
     ★ 診斷:`Talk.diag()` 多了 `dtx`(這條線收到的 SDP 真的被改到了嗎)與
       `rate`(現在給這條線的上限,0 = 還沒套上去)。`dtx:false` 表示對方的 SDP 裡
       找不到 opus 的 rtpmap —— 正常瀏覽器不會這樣,出現就是 SDP 被別的東西動過。
     ========================================================================== */
  const OPUS_DTX = true;    // ← 一行 kill switch:句首被吃字就關掉
  const RATE_CAP = true;    // ← 一行 kill switch:人多時嫌悶就關掉

  /* 語音裡的**其他人**有幾個 → 我的上行給多少上限(bps)。
     ⚠ 數的是 `heard`(真的在語音裡),不是房裡的人數 —— 沒開語音的人不佔我的上行,
       把他們算進去會讓「四個人在玩、只有兩個開語音」被無謂地降到最低檔。 */
  function rateFor(n) {
    if (n <= 1) return 40000;   // 一對一:不必省,給好一點的音質
    if (n <= 3) return 32000;   // 三、四人:與 Chrome 單聲道預設同級
    return 24000;               // 五人以上:收緊(5 × 24k = 120kbps 上行)
  }

  /* 每次 report() 都會叫(人進出 / 接上 / 收到 SDP 都會走到那裡),靠 `P.rateAt`
     擋掉重複 —— 沒變的時候只是一個整數比較,所以放在那條熱路徑上是安全的。 */
  function applyRate() {
    if (!RATE_CAP) return;
    let n = 0;
    for (const id in peers) { if (peers[id].heard) n++; }
    const want = rateFor(n);
    for (const id in peers) {
      const P = peers[id];
      if (P.rateAt === want) continue;
      const sd = P.tx && P.tx.sender;
      // 不支援的瀏覽器:記下來別再問(這一條就是沒有上限,不影響通話)
      if (!sd || !sd.getParameters || !sd.setParameters) { P.rateAt = want; continue; }
      let prm = null;
      try { prm = sd.getParameters(); } catch (e) { }
      /* ⚠ 協商完成前 `encodings` 可能還是空的 → **先不要動,也不要記 rateAt**,
         下一次 report() 再來。自己塞一個新的 encodings 陣列進去會被規格擋下來
         (長度必須與現有的一致),而那個例外會靜靜地被吞掉 = 永遠沒有上限。 */
      if (!prm || !prm.encodings || !prm.encodings.length) continue;
      prm.encodings[0].maxBitrate = want;
      /* ⚠ 先記再送:setParameters 在某些瀏覽器上對 audio 會 reject,
         記在後面的話這裡就變成每 120ms 重試一次的迴圈。 */
      P.rateAt = want;
      try { const r = sd.setParameters(prm); if (r && r.catch) r.catch(() => { }); } catch (e) { }
    }
  }

  /* 把 opus 的 fmtp 補上 `usedtx=1`。⚠ 只認 opus 的 payload type(一份 SDP 裡還有
     紅噪 / telephone-event 那幾條,改到它們是沒意義的),而且**找不到 opus 就原樣回傳**
     —— 這一支任何一步失手都必須退回「什麼都沒做」,絕不可以吐出一份壞掉的 SDP。 */
  function tuneSdp(sdp) {
    if (!OPUS_DTX) return String(sdp || "");
    const s = String(sdp || "");
    if (!/^a=rtpmap:\d+\s+opus\//im.test(s)) return s;
    const eol = s.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    const lines = s.split(/\r\n|\n/);
    const isOpus = Object.create(null);
    lines.forEach(L => { const m = /^a=rtpmap:(\d+)\s+opus\//i.exec(L); if (m) isOpus[m[1]] = true; });
    const seen = Object.create(null);
    const out = lines.map(L => {
      const f = /^a=fmtp:(\d+)\s+(.*)$/.exec(L);
      if (!f || !isOpus[f[1]]) return L;
      seen[f[1]] = true;
      return "a=fmtp:" + f[1] + " " + withDtx(f[2]);
    });
    // 有 rtpmap 卻沒有 fmtp(規格允許,實務少見)→ 自己補一行接在它後面
    for (const pt in isOpus) {
      if (seen[pt]) continue;
      const re = new RegExp("^a=rtpmap:" + pt + "\\s+opus/", "i");
      const at = out.findIndex(L => re.test(L));
      if (at >= 0) out.splice(at + 1, 0, "a=fmtp:" + pt + " usedtx=1");
    }
    return out.join(eol);
  }
  function withDtx(params) {
    if (/(^|;)\s*usedtx=/i.test(params)) return params.replace(/(^|;)(\s*)usedtx=[^;]*/i, "$1$2usedtx=1");
    return params.replace(/;\s*$/, "") + ";usedtx=1";
  }

  /* ---------- 一條連線 ---------- */
  /* heardSeed:重建時把「我已經聽過這個人」帶過來(見下面 P.heard 的說明)。
     ⚠ **rgen 刻意不帶過來**:新的 P 一律從空的世代開始,第一封信直接收下 ——
       帶過來的話重建之後第一封信就會被判成「換世代」,又觸發一次重建。 */
  function peerOf(id, heardSeed) {
    if (peers[id]) return peers[id];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const el = document.createElement("audio");
    el.autoplay = true;
    el.playsInline = true;
    box().appendChild(el);

    const P = {
      id, pc, el,
      polite: String(me()) > String(id),   // 見檔頭「誰對誰發起」
      makingOffer: false,
      ignoreOffer: false,
      tx: null,          // 我們唯一的 audio transceiver
      stream: null,
      pend: [],          // 早到的 ICE candidate(remote 還沒落地);見 onCand
      needPlay: false,   // iOS:play() 被擋掉了,等下一次使用者手勢補播
      analyser: null, data: null,
      speaking: false, lastLoud: 0,
      failed: false,
      gen: newGen(),     // 我這一條 PC 的世代(寄出去的每一封信都帶著它)
      rgen: "",          // 對方最後一次告訴我的世代
      /* ★★★ heard = 「這個人真的在語音裡」的唯一判準,而且**只靠 signaling 推**,不寫 DB。
         為什麼需要它:`sync()` 會對房裡**每一個人**建 PC(包含根本沒開語音的人)——
         那些 PC 永遠停在 connecting,而「沒開語音」與「接不上」在 WebRTC 上
         **看起來完全一樣**。少了這個旗標會出兩種錯:
           ① 晶片上給沒開語音的人掛一顆黃色「正在連線…」(整排都在閃,而其實沒事);
           ② 對帳每 3 秒對著這些人重貼 SDP、每 9 秒重建一次(白燒流量與 CPU)。
         → 只有**收到過對方的 SDP** 才算「他在語音裡」;在那之前不顯示、也不對帳。
         ⚠ 這樣不會漏修:雙方都在跑對帳,誰在等誰就會重貼,一定有一邊先動。 */
      heard: !!heardSeed,
      badSince: 0,       // 從什麼時候開始不是 connected(0 = 沒壞);對帳只看這個
      /* 省流那一組的狀態(見上面「Opus DTX + 動態碼率」)。
         rateAt = 已經套上去的上限(0 = 還沒套),applyRate 靠它擋掉重複呼叫。 */
      dtx: false, rateAt: 0
    };
    peers[id] = P;

    /* 早到而先被收著的 candidate:PC 一建好就接上去(見 onCand 的長註解)。 */
    const orp = orphans[id];
    if (orp && orp.length) { orp.forEach(c => P.pend.push(c)); orp.length = 0; }

    // 我方的 audio transceiver:一開始就照現在的意願建好
    P.tx = pc.addTransceiver("audio", { direction: dirOf() });
    if (speak && localStream) {
      const t = localStream.getAudioTracks()[0];
      if (t) { try { P.tx.sender.replaceTrack(t); } catch (e) { } }
    }

    pc.ontrack = e => {
      P.stream = e.streams[0] || new MediaStream([e.track]);
      P.el.srcObject = P.stream;
      /* iOS/Safari 常常需要一次 play()。⚠ ontrack 是**對方接上的那一刻**觸發的,
         那通常**不在**我方的使用者手勢裡(我按完開關才輪到對方回應)→ 在 iPhone 上
         很容易被自動播放政策擋掉,而症狀是「連線明明好了卻沒聲音」。
         所以失敗要記下來,等下一次真的有手勢(按任一顆鈕)時補播 —— 見 kickPlay()。 */
      playNow(P);
      armMeter(P);
      report();
    };

    pc.onicecandidate = e => {
      if (!e.candidate || !sigRef) return;
      const c = e.candidate;
      const r = outRef(id); if (!r) return;
      /* ⚠ 一定要帶世代:polite 方回滾之後 ICE 會重新收集,而**回滾前**推出去的那幾筆
         屬於上一代 —— 對方照樣會收下並加進去,白跑一輪 ICE 檢查(不會壞,但會拖慢)。
         帶著 `g` 就濾得掉(見 flushCand)。 */
      r.child("c").push({
        d: c.candidate, m: c.sdpMid, i: c.sdpMLineIndex, g: P.gen
      });
    };

    /* Perfect Negotiation 的發動端。改 direction / 換 track 都會打到這裡,
       所以「開關麥克風」不需要自己寫一套重新協商 —— 交給它。 */
    pc.onnegotiationneeded = async () => {
      try {
        P.makingOffer = true;
        await pc.setLocalDescription();
        sendDesc(id, pc.localDescription);
      } catch (e) { } finally { P.makingOffer = false; }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      const now = Date.now();
      if (s === "connected") {
        /* 通了 → 把對帳的計時與重建的節流一起歸零(不歸零的話下一次壞掉會**立刻**
           跳到最凶的那一階,而那多半只是網路抖了一下)。 */
        P.badSince = 0; delete retry[id];
        if (P.failed) { P.failed = false; }
        report();
        return;
      }
      if (s === "failed") {
        /* v2.1.0 接上 TURN 之後,走到這裡的意思**變了**:以前多半是「對稱 NAT +
           沒有中繼」,現在則多半是**連 TURN 都拿不到 relay candidate** ——
           要嘛那台公共服務掛了、要嘛網路把它也擋掉了。
           ⚠ 兩者在畫面上一模一樣,別用猜的:開 `tools/t-turn-check.html` 量一次。
           ⚠ v2.3.7:`restartIce()` 以前被 `if (!P.failed)` 綁成**一輩子只做一次** ——
             第二次以後的失敗完全沒有救援。現在交給對帳升級處理,這裡只做第一發
             (那一發最有價值:換一組 candidate 常常就通了)。 */
        P.failed = true;
        if (!P.badSince) P.badSince = now;
        if (!retry[id]) { retry[id] = { at: now, gap: REBUILD_MS }; try { pc.restartIce(); } catch (e) { } }
        report();
        return;
      }
      /* ⚠ `disconnected` 以前**完全沒有處理**。手機切 App / Wi-Fi 換 4G 很常停在這裡幾十秒,
         而有些組合根本走不到 failed → 一次救援都不會發生。這裡只記時間,
         真正要不要動手交給對帳(它才知道「壞多久了」)。 */
      if (s === "disconnected" || s === "closed") { if (!P.badSince) P.badSince = now; }
      report();
    };

    return P;
  }

  /* keepMail=true:只拆本地這條 PC,**不要**動 DB 上對方寄來的信 ——
     「收到新 offer 而舊 PC 已經死了 → 就地重建」那條路要用(見 onDesc)。
     少了這個參數的話,重建會順手把正在處理的那封信連同後面的 candidate 一起刪掉。 */
  function dropPeer(id, keepMail) {
    const P = peers[id];
    if (!P) return;
    try { P.pc.ontrack = P.pc.onicecandidate = P.pc.onnegotiationneeded = null; } catch (e) { }
    try { P.pc.onconnectionstatechange = null; } catch (e) { }
    try { P.pc.close(); } catch (e) { }
    try { P.el.srcObject = null; P.el.remove(); } catch (e) { }
    try { if (P.srcNode) P.srcNode.disconnect(); } catch (e) { }
    delete peers[id];
    // 對方留給我的信箱也清掉(不清的話重連時會讀到上一輪的舊 SDP)
    if (!keepMail) { try { if (sigRef) sigRef.child(id).remove(); } catch (e) { } }
  }

  /* ---------- signaling:rtc/{收件人}/{寄件人} ---------- */
  /* ⚠ 一定要防 null:hooks.ref() 在**沒進房時回 null**(核心的 ctx.ref 就是這樣定義的)。
     而「已經離房、但還有一發 onicecandidate 在路上」是必然會發生的 —— 少了這道防護
     就是離開房間時控制台一片紅。 */
  function outRef(toId) {
    const r = hooks && hooks.ref && hooks.ref("rtc/" + toId + "/" + me());
    return r || null;
  }

  function sendDesc(toId, desc) {
    if (!desc) return;
    const r = outRef(toId);
    if (!r) return;
    const P = peers[toId];
    /* ⚠ 一律用 set()(不是 push):同一個信箱格子,新的蓋掉舊的。
       ★ 順帶一個對帳要用到的性質:**重貼一模一樣的內容不會產生事件**
         (Firebase 只在值真的變了才通知)→ 對方沒事就完全不受打擾;
         而對方的信箱被清掉時(值變成 null)重貼就會補上 —— 這正是對帳修得掉死鎖的原因。 */
    try { r.child("d").set({ t: desc.type, s: desc.sdp, g: (P && P.gen) || "" }); } catch (e) { }
  }

  async function onDesc(fromId, d) {
    if (!d || !d.t || !d.s) return;
    // 兩個開關都關了還收到 SDP(對方比我慢一拍)→ 不要因此把連線建回來
    if (!on()) return;
    /* ★★★ 舊的那條已經死了就**就地重建**(v1.182.1)。
       這正是使用者「開開關關好幾次」會走到的路:我這邊關掉語音會 teardown 把 PC 整個
       丟掉,重開時建的是**全新**的 PC;但對方那邊沒有 teardown,它手上那條還是舊的 ——
       等它變成 failed / closed 之後,再怎麼送新的 offer 進去都不會活過來
       (setRemoteDescription 在 closed 的 PC 上直接拋錯,而我們把例外吞掉 → 靜靜地連不上)。
       ⚠ keepMail=true:不可以順手清掉 DB 上的信 —— 我正在處理的就是那一封,
         後面還有屬於它的 candidate 要收。 */
    /* ★★★ 而且(v2.3.7)**世代變了也要就地重建** —— 這是「舊 PC 死了才重建」漏掉的一半:
       斷線重連的路徑上,對方會看到我從 players 消失 → 拆掉他那條 PC;我回來之後他建的是
       **全新**的 PC(新的 DTLS fingerprint + 新的 ICE ufrag),而我這邊的舊 PC 此刻多半是
       `disconnected`(還沒到 failed)→ 舊判準不重建 → 把新 offer 套到舊 PC 上,
       fingerprint 一換就直接拋錯,而錯誤是被吞掉的 → **這一條永久靜靜地斷掉**。
       ⚠⚠ **只認 offer**。answer 帶的新世代是對方為了回應我而重建出來的,
         照它重建就是兩台無限互相重建(見上面 newGen 的長註解)。 */
    {
      const old = peers[fromId];
      if (old) {
        const cs = old.pc.connectionState, ss = old.pc.signalingState;
        const newGenSeen = d.t === "offer" && !!old.rgen && !!d.g && d.g !== old.rgen;
        if (newGenSeen || cs === "failed" || cs === "closed" || ss === "closed") dropPeer(fromId, true);
      }
    }
    const P = peerOf(fromId, true), pc = P.pc;
    /* 收到 SDP = 「這個人真的在語音裡」的唯一證據(見 peerOf 裡 heard 的長註解)。 */
    P.heard = true;
    if (d.g) P.rgen = d.g;
    /* ★ 省流:**改對方寄來的**那一份(它宣告的是「對方想收到什麼」,由我的編碼器遵守)
       —— 為什麼是這一份而不是自己送出去的,見上面 tuneSdp 那一整段的長註解。 */
    const tuned = tuneSdp(d.s);
    P.dtx = tuned !== d.s;
    const desc = { type: d.t, sdp: tuned };
    try {
      /* Perfect Negotiation 的收端。衝突 = 對方送 offer 來的時候我自己也正在送。 */
      const offerCollision = desc.type === "offer" &&
        (P.makingOffer || pc.signalingState !== "stable");
      if (offerCollision) {
        // impolite:堅持自己的,對方會讓
        if (!P.polite) { P.ignoreOffer = true; return; }
        /* ★★★ polite:**明確**把自己那一半回滾掉,不可以只靠隱式 rollback(v1.182.1)。
           Chrome 的 setRemoteDescription 遇到衝突會自己回滾,所以少寫這一行在 Chrome
           上測不出來 —— 但 **Safari / iOS 對隱式 rollback 的支援不完整**,那邊會直接
           丟 InvalidStateError,而我們把例外吞掉 → 這一條連線就靜靜地建不起來。
           症狀正是使用者回報的「要開關好幾次」(重開剛好避開衝突那一次才通)。 */
        try { await pc.setLocalDescription({ type: "rollback" }); } catch (e) { }
      }
      P.ignoreOffer = false;

      await pc.setRemoteDescription(desc);
      // remote 落地了 → 把早到而排隊的 candidate 補進去(見 onCand)
      await flushCand(P);
      /* ⚠ 一定要再確認一次 `have-remote-offer`(v2.3.7)。
         上面剛建好的 PC,它的 `addTransceiver` 會**非同步地**觸發一發
         `onnegotiationneeded` —— 那支的 `setLocalDescription()` 有可能搶在這裡之前跑完並
         把 answer 送出去,這時狀態已經是 `stable`;沒有這道閘的話這裡的
         `setLocalDescription()` 會在 stable 上產生一份**沒有人要的 offer**,
         把剛接好的線重新推回協商中(症狀:接上之後又立刻斷,反覆重連)。 */
      if (desc.type === "offer" && pc.signalingState === "have-remote-offer") {
        await pc.setLocalDescription();
        sendDesc(fromId, pc.localDescription);
      }
    } catch (e) { }
  }

  /* ★★★ ICE candidate **一律先排隊**,不可以「拿到就 addIceCandidate,失敗就算了」
     (v1.182.1 修 —— 這是「要開關好幾次」的主因)。
     candidate 的封包比 SDP 小得多,Firebase 上**經常比 SDP 先到**;而在
     setRemoteDescription 之前呼叫 addIceCandidate 一定拋錯 —— 舊版把它 catch 掉當沒事,
     偏偏那一筆在 DB 上**同時就被 remove 了** → 那個 candidate 永遠消失。
     少掉關鍵的 host / srflx candidate 就是連不上,而重開一次會重新收集、
     有時順序剛好對了就通 → 使用者看到的就是「開開關關好幾次才會通」。
     排隊之後一筆都不會掉,而且刪除時機也跟著改成「處理完才刪」。 */
  /* ★★★ v2.3.7 補掉同一個病的最後一個出口:**連 PC 都還沒有**的時候到的 candidate。
     舊寫法回 `false`(DB 那筆刻意不刪、留著等下一輪),但 `child_added` **不會對同一筆
     再觸發一次** → 那筆等於永久消失,和 v1.182.1 修掉的「早到就被丟棄」是同一個病,
     只差在早到的對象從 `remoteDescription` 換成了 `peers[id]`。
     → 改成自己收著(orphans),`peerOf()` 建好 PC 的那一刻補進去。
     ⚠ 要有上限:對方一直在收集而我一直沒建 PC 的話,這個陣列會無限長大。 */
  function orphanOf(id) { return orphans[id] || (orphans[id] = []); }
  async function onCand(fromId, c) {
    if (!c || !c.d) return;                       // 壞資料:什麼都不做(呼叫端會刪掉)
    const item = { g: c.g || "", cand: { candidate: c.d, sdpMid: c.m, sdpMLineIndex: c.i } };
    const P = peers[fromId];
    if (!P) {
      const o = orphanOf(fromId);
      if (o.length < ORPHAN_MAX) o.push(item);
      return;
    }
    P.pend.push(item);
    if (P.pc.remoteDescription && P.pc.remoteDescription.type) await flushCand(P);
  }
  async function flushCand(P) {
    if (!P.pend.length) return;
    const q = P.pend.slice(); P.pend.length = 0;
    for (let i = 0; i < q.length; i++) {
      /* 上一代的 candidate 丟掉(polite 方回滾前推出去的那幾筆)—— 加進去只是白跑
         一輪 ICE 檢查。⚠ `P.rgen` 還空著時**不可以**濾:那表示對方的 SDP 還沒到,
         這時每一筆都可能是有用的(整個佇列存在的理由就是它們比 SDP 先到)。 */
      const it = q[i];
      if (it.g && P.rgen && it.g !== P.rgen) continue;
      try { await P.pc.addIceCandidate(it.cand); } catch (e) { }
    }
  }

  /* 監聽「寄給我的」那一支。結構刻意是 rtc/{我}/{他} —— 每個人只訂閱自己的信箱,
     不會收到別人之間的往來(mesh 裡那是 N-1 倍的無用流量)。 */
  function watch() {
    if (sigRef || !hooks) return;
    sigRef = hooks.ref("rtc/" + me());
    if (!sigRef) return;
    /* ⚠⚠ 這裡**絕對不可以** sigRef.remove() —— 清信箱要在 attach()(進房那一刻)做,
       不是在這裡(開語音那一刻)。
       理由:很常見的順序是「A 先開語音、B 過一會兒才開」。A 一開就把 offer 寫進
       `rtc/B/A/d` 了;B 這時若把整個信箱清掉,**等於把 A 的邀請刪掉**,而 A 那邊
       已經在 have-local-offer 等回音 —— 如果 A 剛好是 impolite,它還會忽略 B 後來
       送的 offer(當成衝突)→ **兩邊互相等,永遠接不上**。
       進房那一刻清就沒有這個問題:那時還沒有任何人在跟我協商。 */
    sigRef.on("child_added", snap => {
      const fromId = snap.key;
      if (fromId === me() || watched[fromId]) return;
      watched[fromId] = true;
      const slot = sigRef.child(fromId);   // ⚠ 別叫 box —— 上面那個 box() 是裝 <audio> 的容器
      /* ⚠ 兩個監聽都走 seq():同一條線的 SDP 與 candidate 一律排隊處理,不可以交錯
         (兩個 async 交錯會把 PC 的狀態機推進錯的狀態,而例外是被吞掉的)。 */
      slot.child("d").on("value", s => { const v = s.val(); if (v) seq(fromId, () => onDesc(fromId, v)); });
      /* candidate:**處理完(收下或排進佇列)才刪**。
         ⚠ 舊版是「onCand 之後立刻 remove」,而 onCand 是 async —— 等於一定在處理完
           之前就刪掉了,早到的那幾筆於是永遠消失(見 onCand 的長註解)。
         刪除本身還是要做:不刪的話一間房打一整晚會累積成千上萬筆,
         而且重連的人會把上一輪的全部重放一次。 */
      /* ★ v2.3.7 起 onCand **一律接手**(沒有 PC 就自己收著,見它的長註解)→
         這裡就變成無條件刪:留在 DB 裡的那條路已經證明是「永久消失」而不是「等下一輪」。 */
      slot.child("c").on("child_added", s => {
        const v = s.val();
        seq(fromId, () => onCand(fromId, v)).then(() => { try { s.ref.remove(); } catch (e) { } });
      });
    });
  }
  function unwatch() {
    if (!sigRef) return;
    try {
      sigRef.off();
      // 子節點的監聽核心收不掉(見檔頭紅線 ①)—— 這裡要自己把每一個都拆了
      Object.keys(watched).forEach(id => {
        try { sigRef.child(id).child("d").off(); } catch (e) { }
        try { sigRef.child(id).child("c").off(); } catch (e) { }
        delete watched[id];
      });
      sigRef.remove();
    } catch (e) { }
    sigRef = null;
  }

  /* ---------- 誰在說話:本地分析,不寫 DB ----------
     ⚠⚠⚠ **WebKit(iPhone / iPad / macOS Safari)一律跳過這一整段**(v1.182.1)。
       已知的 WebKit 行為:把一條 **remote** MediaStream 交給
       `AudioContext.createMediaStreamSource()` 之後,原本在播它的 `<audio>` 元素
       **就不出聲了** —— 等於「開了語音卻完全聽不到對方」,而畫面上一切正常
       (連線是 connected、對方也真的在講)。
       這個指示燈只是錦上添花,聽得到聲音才是本體 → 在 WebKit 上寧可不要它。
     ⚠ 判斷要連 iOS 上的 Chrome / Edge 一起算:那些在 iOS 上**底層仍然是 WebKit**,
       只看 UA 裡有沒有 "Safari" 會漏掉它們。 */
  function isWebKit() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return true;                 // iOS 一律 WebKit 核心
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;  // iPadOS 桌面模式
    return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua);
  }
  const WEBKIT = isWebKit();

  function armMeter(P) {
    if (!P.stream) return;
    if (WEBKIT) return;   // 見上面:接進 AudioContext 會讓 <audio> 靜音
    try {
      /* ⚠ **同一個 peer 的 ontrack 是會來第二次的**(重新協商 / 方向改回 recvonly 時
         receiver 換了一條新 track)—— 舊的 MediaStreamSource 沒有 disconnect 就會一直
         掛在 `acx` 的 graph 上,而它扣著上一顆 stream 不放:一場派對裡開開關關十幾次,
         就是十幾條沒人在讀的音訊路徑還在被處理(v2.3.9)。
         ⚠ 先拆再建,不要拆完就 return:這一支的職責是「讓 P 身上掛著一組**現在這條** track
           的分析器」,提早 return 會讓那組停在舊的 stream 上。 */
      if (P.srcNode) { try { P.srcNode.disconnect(); } catch (e) { } P.srcNode = null; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!acx) acx = new AC();
      resumeCtx(acx);
      const src = acx.createMediaStreamSource(P.stream);
      const an = acx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      /* ⚠ **不要** an.connect(acx.destination) —— <audio> 已經在播了,
         接上去等於同一路聲音播兩次(而且會有相位干涉,聽起來像在水裡)。 */
      P.srcNode = src; P.analyser = an; P.data = new Uint8Array(an.fftSize);
    } catch (e) { }
    startMeter();
  }
  /* ---------- 自己的麥克風音量(v2.3.7)----------
     見檔頭 LOCAL_METER 的長註解:這一路量的是**送出去的**音訊,回答的是
     「我的麥克風到底有沒有在動」。⚠ 用**獨立**的 AudioContext,與遠端那顆不共用。
     ⚠ 同遠端那一路:**絕對不要 connect(destination)** —— 那會把自己的聲音播回自己的
       喇叭,再被麥克風收回去,全房嘯叫(而回音消除擋不住這種自己造出來的路徑)。 */
  function armLocalMeter() {
    if (!LOCAL_METER || lanalyser) return;
    if (!speak || !localStream) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!lacx) lacx = new AC();
      resumeCtx(lacx);
      lsrc = lacx.createMediaStreamSource(localStream);
      const an = lacx.createAnalyser();
      an.fftSize = 512;
      lsrc.connect(an);
      lanalyser = an; ldata = new Uint8Array(an.fftSize);
    } catch (e) { lanalyser = null; }
    startMeter();
  }
  function stopLocalMeter() {
    try { if (lsrc) lsrc.disconnect(); } catch (e) { }
    try { if (lacx) { lacx.close(); lacx = null; } } catch (e) { }
    lsrc = null; lanalyser = null; ldata = null;
    localSpeaking = false; localLoud = 0;
  }
  function peakOf(data) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  function startMeter() {
    if (meterTimer) return;
    meterTimer = setInterval(() => {
      let changed = false, any = false;
      const now = Date.now();
      for (const id in peers) {
        const P = peers[id];
        if (!P.analyser) continue;
        any = true;
        P.analyser.getByteTimeDomainData(P.data);
        const peak = peakOf(P.data);
        if (peak >= SPEAK_THRESHOLD) P.lastLoud = now;
        const sp = (now - P.lastLoud) < SPEAK_HOLD_MS;
        if (sp !== P.speaking) { P.speaking = sp; changed = true; }
      }
      /* 自己那一份。⚠ 門檻比遠端高(LOCAL_THRESHOLD):這一路沒有經過對方的 AGC,
         用遠端那個值的話呼吸聲就會讓自己的框一直閃。 */
      if (lanalyser && speak) {
        any = true;
        lanalyser.getByteTimeDomainData(ldata);
        if (peakOf(ldata) >= LOCAL_THRESHOLD) localLoud = now;
        const sp = (now - localLoud) < SPEAK_HOLD_MS;
        if (sp !== localSpeaking) { localSpeaking = sp; changed = true; }
      } else if (localSpeaking) { localSpeaking = false; changed = true; }
      // 沒有東西要量了就自己收掉(WebKit 上遠端整段跳過 → 關麥之後這裡就空了)
      if (!any) { stopMeter(); }
      if (changed) report();
    }, 120);
  }
  function stopMeter() {
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    try { if (acx) { acx.close(); acx = null; } } catch (e) { }
  }

  /* ==========================================================================
     UI:那兩顆鈕(v1.183.0 從 ui-kit.js **收進來**)
     ──────────────────────────────────────────────────────────────────────────
     ★★★ 為什麼收進來:UI 那一半原本住在 `js/shared/ui-kit.js`,而 **Bingo 不載入
       `js/shared/`**(紅線 2 的物理隔離)—— 照那個結構,Bingo 要接語音就得**複製
       第二份**,於是又多一組 CLAUDE.md 紅線 4 說的雙胞胎(「改一邊記得改另一邊」),
       而那正是這個專案已經有好幾組、每組都出過事的東西。
     ★ 而且分層上本來就沒有理由分開:talk.js **自己就在碰 DOM**(它要建 <audio>),
       所以「talk.js 零 DOM」這個約束從第一版起就不存在,拆出去只是徒增一組雙胞胎。
     → 收進來之後,一頁要接語音只剩兩件事:載入這支 + 呼叫一次 Talk.bindUi()。
     ⚠ 這裡**不可以**自己宣告 `$` 或 `showToast`:那兩個在 game.js(Bingo)與
       ui-kit.js(十三頁)各有一份全域定義,重複宣告 const 會整頁 SyntaxError。
       要用就 typeof 檢查後直接用。
     ========================================================================== */
  let uiBusy = false;
  function btnL() { return document.getElementById("tkListenBtn"); }
  function btnS() { return document.getElementById("tkSpeakBtn"); }

  /* --------------------------------------------------------------------------
     兩顆鈕的圖示:**自繪 SVG**,不用 emoji 字面(v2.2.3)
     ──────────────────────────────────────────────────────────────────────────
     ★ 原本是 🔇 / 🔊 + 🎙,而 🎙(U+1F399)在 Unicode 裡是**預設文字呈現**的字元
       (🔇 / 🔊 不是,它們預設就是 emoji)—— 沒有帶變體選擇符 U+FE0F 時,
       Chrome / Edge 不會去拿 Segoe UI Emoji 的彩色字形,而是退回 **Segoe UI Symbol
       的線條字形**:一支滿是細網格的復古立式麥克風,19px 下整個糊成一團。
       ⚠ 手機看不出來(Android / iOS 一律當 emoji 畫)→ **只有桌機在醜**,
         所以「我手機看起來好好的」不能當作沒問題。
     ★ 補一個 U+FE0F 修得掉那個,但會**換一個更糟的問題**:彩色 emoji 不吃 `color`,
       而這兩顆鈕有兩種會換底色的狀態(`.on` 是主題強調色、`.bad` 是紅色)——
       銀色的麥克風壓在黃色 / 青色的強調色上比現在還糊(五個主題有三個會中)。
       → 自繪 SVG 一律 `fill:currentColor`,四種狀態 × 五個主題全部自動對。
     ★ markup 收在**這裡**、不是十四頁的 HTML 裡:那會是十四份(加 tools/ 裡二十幾份
       測試頁就更多)會慢慢分岔的雙胞胎(CLAUDE.md 紅線 4)。
       → HTML 那邊只留一顆**空的** `<button>`,長相由這支負責。
     ⚠ 「開 / 關」**不換 innerHTML**:喇叭的音波與叉叉兩組路徑都在同一份 SVG 裡,
       靠 CSS 收放(見 styles.src.css 的 `.tk-wave` / `.tk-x`)。每次 report()
       重寫 innerHTML 會把 `.icon-btn` 的 transition 打斷,而 report() 很頻繁。
     ⚠ `aria-hidden` 一定要留:鈕自己的 aria-label 已經把狀態講完了,
       圖示再被讀一次只會變成雜訊。
     -------------------------------------------------------------------------- */
  const ICO_LISTEN =
    '<svg class="tk-ico" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4.2 9h3.1l5.3-4.7A.9.9 0 0 1 14 5v14a.9.9 0 0 1-1.4.7L7.3 15H4.2A1.2 1.2 0 0 1 3 13.8v-3.6A1.2 1.2 0 0 1 4.2 9z"/>' +
      '<path class="tk-wave" d="M16.9 8.8a4.6 4.6 0 0 1 0 6.4M19.9 6.1a8.6 8.6 0 0 1 0 11.8"/>' +
      '<path class="tk-x" d="M17.2 9.6l4.6 4.8M21.8 9.6l-4.6 4.8"/>' +
    '</svg>';
  const ICO_SPEAK =
    '<svg class="tk-ico" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 14.2a3.4 3.4 0 0 0 3.4-3.4V4.6a3.4 3.4 0 1 0-6.8 0v6.2a3.4 3.4 0 0 0 3.4 3.4z"/>' +
      '<path d="M18.2 10.6a1.05 1.05 0 0 0-2.1 0 4.1 4.1 0 0 1-8.2 0 1.05 1.05 0 0 0-2.1 0 6.15 6.15 0 0 0 5.15 6.06V19h-2.1a1.05 1.05 0 0 0 0 2.1h6.3a1.05 1.05 0 0 0 0-2.1h-2.1v-2.34a6.15 6.15 0 0 0 5.15-6.06z"/>' +
    '</svg>';
  /* 晶片上那顆小徽章的圖示 —— **從 ICO_SPEAK 換個 class 生出來的**,不是再畫一份。
     ⚠ 不可以自己抄一份路徑:那就是第三份會慢慢分岔的麥克風(CLAUDE.md 紅線 4)。
     ⚠ 同樣不用 emoji(紅線 8 / 紅線 13):19px 的鈕都糊了,15px 的徽章只會更糟。 */
  const ICO_TAG = ICO_SPEAK.replace('class="tk-ico"', 'class="tk-tagico"');

  /* 只在「還沒有 SVG」時寫一次 —— 這樣舊的測試頁(HTML 裡還留著 🎙 字面的那些)
     也會被自動蓋掉,不必一份一份改。 */
  function ico(btn, html) { if (!btn.querySelector("svg")) btn.innerHTML = html; }
  function toast(msg) {
    // 兩份都叫 showToast(game.js / ui-kit.js),但這一支可能被沒有它的頁面載入
    try { if (typeof showToast === "function") showToast(msg); } catch (e) { }
  }

  /* 現在有沒有人連不上。⚠ 與 report() 同一道 heard 閘(沒開語音的人不算連不上)。 */
  function anyBad() {
    for (const id in peers) if (peers[id].failed && peers[id].heard) return true;
    return false;
  }
  function paintBtns(st) {
    const bL = btnL(), bS = btnS();
    /* ⚠ 沒帶 st 的時候要**自己算**,不可以當成「沒事」(v2.3.7)。
       bindUi 的兩個 click handler 最後都會 `paintBtns()`(不帶參數),而那一下排在
       report() 之後 → 舊寫法會把剛亮起來的紅色**清掉**,而下一次 report() 可能要等
       3 秒(對帳)、甚至永遠不來(狀態沒再變)→ 使用者按一下鈕,警示就不見了。 */
    const bad = st ? !!(st.failed && st.failed.length) : anyBad();
    if (bL) {
      /* ⚠ 開 / 關**不換圖示的 markup**:音波與叉叉都在同一份 SVG 裡,
         由 `.tk-btn.on` 決定露哪一組(見上面 ICO_LISTEN 的長註解)。 */
      ico(bL, ICO_LISTEN);
      bL.classList.toggle("on", listen);
      /* ★ 連不上也要在**聽鈕**上看得見(v2.3.7)。原本紅色只掛在講鈕、而且只有 speak 為真
         才掛 —— 於是 v2.1.0 特別保留的「閉麥在聽」那個狀態,連線失敗時
         **畫面上一個提示都沒有**,使用者只會覺得「大家今天都不講話」。 */
      bL.classList.toggle("bad", listen && bad);
      /* 關「聽」會連麥克風一起關(規則 ②)—— 副作用要寫在標題裡先講,
         不要讓人按下去才發現自己被閉麥了。 */
      bL.title = (listen && bad) ? "語音連不上(你聽不到某些人)"
               : listen ? (speak ? "關掉語音(麥克風也會一起關)" : "關掉語音(不再聽到別人)")
                        : "打開語音(聽別人說話)";
      bL.setAttribute("aria-label", bL.title);
      bL.setAttribute("aria-pressed", listen ? "true" : "false");
    }
    if (bS) {
      ico(bS, ICO_SPEAK);
      bS.classList.toggle("on", speak);
      /* ★ 「聽著但閉麥」與「語音整個關掉」**必須長得不一樣**:兩者的麥克風都是關的,
         光靠「暗的」分不出來,而後果差很多 —— 前者別人講話你聽得到,後者一片安靜。
         → 前者多一條斜線(通用的靜音符號,見 styles.src.css 的 .tk-btn.muted)。 */
      bS.classList.toggle("muted", listen && !speak);
      /* 連不上要**看得見**:TURN 也拿不到 relay 的組合會失敗,而那時使用者
         以為自己在講話、其實沒有人聽得到 —— 最難自己發現的一種壞掉。 */
      bS.classList.toggle("bad", speak && bad);
      bS.title = speak ? (bad ? "有人連不上你的語音" : "暫停說話(靜音,但還聽得到別人)")
               : listen ? "開始說話(讓別人聽到你)"
                        : "開始說話(會一起打開語音)";
      bS.setAttribute("aria-label", bS.title);
      bS.setAttribute("aria-pressed", speak ? "true" : "false");
    }
  }

  /* ==========================================================================
     玩家晶片上的語音徽章(v2.3.7)
     ──────────────────────────────────────────────────────────────────────────
     ★ 起點是使用者的一句話:「如果有開啟對話的人,我希望他的人物框,可以有一點資訊顯示」。
     ★ 它回答的是**綠光環回答不了的那一半**:綠光環只有「這一秒有沒有在講」,
       而現場真正想知道的是「他到底有沒有在語音裡 / 他是不是閉著麥 / 是不是連不上」。
       ⚠ 這也是上一次現場回報最缺的東西:以前使用者只能說「有人聽不到」,
         有了它就能直接說「B 那格一直是黃的」—— 同 `t-turn-check.html` 存在的理由。

     ★★★ **四種狀態,而且全部是本地推出來的、一個位元都不寫 DB**(紅線 7):
       · live —— 連上了,而且對方在送音訊(他開著麥)
       · mute —— 連上了,但對方沒在送(他聽著、閉著麥)
       · wait —— 還沒連上(正在接)
       · bad  —— 接不上
       怎麼推「對方有沒有開麥」:看**我方** transceiver 的 `currentDirection` ——
       我在收(`sendrecv` / `recvonly`)就等於對方在送。SDP 已經把這件事講完了,
       不必再開一個 DB 節點去問(那會是每人每次開關好幾筆寫入)。
     ⚠⚠ **沒開語音的人不掛徽章** —— 判準是 `P.heard`(見 peerOf)。
       `sync()` 對房裡每一個人都建 PC,那些人的 PC 永遠停在 connecting,
       而「沒開語音」與「接不上」在 WebRTC 上看起來一模一樣 → 少了這道閘,
       整排晶片都會掛著黃色的「正在連線…」在閃,而其實一切正常。

     ★★★ 為什麼用 MutationObserver 而不是改 `renderPlayers()`:
       晶片列是 `mp-core.js` / `online.js` **各一份**畫的(而且 `box.innerHTML=""`
       整列重建),要在那裡加東西就是**又一組雙胞胎**(紅線 4)。
       照 `qr.js` 的先例(紅線 4 的 ★★:鈕與蓋板都自己建、十四頁零登記)——
       這一支自己盯著那個容器,重建完就把徽章補回去。**十四頁一行都不必改。**
     ⚠ observe 一定要 `{ childList: true }` **而且不加 subtree**:
       我們自己是往晶片**裡面**塞節點的,加了 subtree 就會自己觸發自己 → 無限迴圈。
       (`chipBusy` 是第二道保險,不要因為有它就把 subtree 加回來。)
     ========================================================================== */
  const TAG_TXT = {
    live: "語音:麥克風開著",
    mute: "語音:在聽,但閉著麥克風",
    wait: "語音:正在連線…",
    bad: "語音:連不上(你們聽不到彼此)"
  };
  const TAG_TXT_ME = {
    live: "你的麥克風開著(有聲音時你的框會變綠)",
    mute: "你在聽,但閉著麥克風"
  };
  /* ---------- 「我這邊真的在收他的音訊嗎」(v2.3.8)----------
     ★★★ 為什麼不可以只信 `P.tx.currentDirection`:那是**協商出來的意圖**,不是事實。
       現場回報的正是它與事實對不上的那一刻:「別人在講話的時候,他的語音圖案還是
       畫著禁用、只是變成綠色」—— 那就是 `mute` 的斜線(::after)與 `.talking` 的綠
       疊在同一顆徽章上,一個自相矛盾的畫面。
       只要 `P.tx` 這一顆 transceiver 沒有跟著最後一次協商走,推論就是舊的而音訊照樣在流:
         · 對方重建了 PC,新的 m-line 對到**另一顆** transceiver → `P.tx.currentDirection`
           停在 null(而 null 在舊寫法裡就是 mute → 斜線);
         · 對方「開麥」那一次的重新協商被 glare 吃掉 / 信掉了 → 方向還是舊的。
     → 改成問**所有** receiver 的 track:`live` 且 `muted === false` = 現在真的有東西進來。
     ⚠ 遠端 track 的 `muted` 依規格就是「沒有資料進來」(對方 replaceTrack(null)、
       方向不再送,都會讓它變 true)。而這一路**在 WebKit 上格外重要**:
       那邊的音量分析整段跳過(見 armMeter),徽章以前只剩 currentDirection 一條路。
     ⚠ 拿不到 getReceivers(假 PC 模型 / 很舊的瀏覽器)就回 **null**(不是 false)——
       呼叫端要分得出「問不到」與「問到了、沒在收」。 */
  function recvLive(P) {
    let rs = null;
    try { rs = (P.pc && P.pc.getReceivers) ? P.pc.getReceivers() : null; } catch (e) { rs = null; }
    if (!rs || !rs.length) return null;
    let seen = false;
    for (let i = 0; i < rs.length; i++) {
      const t = rs[i] && rs[i].track;
      if (!t || t.kind !== "audio") continue;
      seen = true;
      if (t.readyState !== "ended" && t.muted === false) return true;
    }
    return seen ? false : null;
  }
  /* 「我剛剛真的聽到他的聲音」—— 這是耳朵,不是推論(v2.3.8)。見 LIVE_HOLD_MS。 */
  function heardRecently(P) {
    if (P.speaking) return true;
    return !!P.lastLoud && (Date.now() - P.lastLoud) < LIVE_HOLD_MS;
  }
  function voiceOf(P) {
    /* ★★★ 最高權威是耳朵(v2.3.8):量到過他的聲音 → 一定是 live。
       ⚠ 這一條要排在 failed / connectionState **前面** —— 聽得到他就表示這條線是通的,
         那些旗標若還沒被對帳清掉,那也一定是它們錯,不是耳朵錯。 */
    if (heardRecently(P)) return "live";
    if (P.failed) return "bad";
    const cs = P.pc.connectionState;
    if (cs === "failed" || cs === "closed") return "bad";
    if (cs !== "connected") return "wait";
    /* 他沒在講話的那些秒:兩個訊號問一遍 —— 現在有沒有東西進來(事實)+ 協商方向(意圖)。
       ⚠⚠ **只要有一個說在收就算 live**,這個偏向是刻意的:
         誤判成 live 的代價只是「他其實沒在講」(下一秒就看得出來),
         而誤判成 mute 的代價是**畫一個禁用符號給正在講話的人** —— 那正是現場回報的事。 */
    const dir = (P.tx && P.tx.currentDirection) || "";
    if (recvLive(P) === true) return "live";
    return (dir === "sendrecv" || dir === "recvonly") ? "live" : "mute";
  }
  /* pid -> 狀態。⚠ 只收「我聽過的人」+ 自己。 */
  function voiceMap() {
    const m = Object.create(null);
    for (const id in peers) { const P = peers[id]; if (P.heard) m[id] = voiceOf(P); }
    const my = me();
    if (my && on()) m[my] = speak ? "live" : "mute";
    return m;
  }
  function chipsBox() { return document.getElementById("mpPlayers"); }
  function armChipObs() {
    if (chipObs || !window.MutationObserver) return;
    const box = chipsBox(); if (!box) return;
    chipObs = new MutationObserver(() => { if (!chipBusy) paintChips(true); });
    chipObs.observe(box, { childList: true });   // ⚠ 不加 subtree,見上面
  }
  function stopChipObs() {
    if (chipObs) { try { chipObs.disconnect(); } catch (e) { } chipObs = null; }
    chipSig = "";
    const box = chipsBox(); if (!box) return;
    try { box.querySelectorAll(".tk-tag").forEach(t => t.remove()); } catch (e) { }
  }
  function paintChips(force) {
    const box = chipsBox(); if (!box) return;
    const vs = voiceMap();
    const talking = Object.create(null);
    for (const id in peers) if (peers[id].speaking) talking[id] = true;
    const my = me();
    if (my && localSpeaking && speak) talking[my] = true;
    /* ⚠ 只有真的變了才動 DOM:report() 在有人講話時每 120ms 就來一次,
       無條件重寫會在「每次換畫面」的路徑上白燒(CLAUDE.md 紅線 7 的最後一條)。 */
    const sig = Object.keys(vs).sort().map(id => id + ":" + vs[id] + (talking[id] ? "!" : "")).join("|");
    if (!force && sig === chipSig) return;
    chipSig = sig;
    chipBusy = true;
    try {
      box.querySelectorAll(".mp-chip").forEach(chip => {
        const id = chip.dataset && chip.dataset.id;
        const st = id ? vs[id] : null;
        let tag = chip.querySelector(".tk-tag");
        if (!st) { if (tag) tag.remove(); return; }
        if (!tag) {
          tag = document.createElement("span");
          tag.innerHTML = ICO_TAG;
          /* ⚠ 插在移出鈕 ✕ **之前**:那顆是晶片的最後一格(房主大廳限定),
             徽章掉到它後面會變成「名字 ✕ 麥克風」,讀起來像是麥克風可以被關掉。 */
          const kick = chip.querySelector(".mp-kick");
          if (kick) chip.insertBefore(tag, kick); else chip.appendChild(tag);
        }
        tag.className = "tk-tag " + st + (talking[id] ? " talking" : "");
        tag.title = (id === my && TAG_TXT_ME[st]) ? TAG_TXT_ME[st] : (TAG_TXT[st] || "");
      });
    } finally { chipBusy = false; }
  }

  /* ---------- 對外狀態 ---------- */
  function report() {
    /* ★ 省流:人進出 / 接上 / 收到 SDP 都會走到這裡,而「語音裡有幾個人」正是碼率的
       唯一輸入 → 掛在這裡就不必再找別的觸發點。沒變的時候它只是一輪整數比較。 */
    applyRate();
    const spk = [], bad = [];
    for (const id in peers) {
      if (peers[id].speaking) spk.push(id);
      /* ⚠ 要 `&& heard`:沒開語音的人那條 PC 本來就永遠接不起來(見 peerOf 的 heard),
         不加這道閘的話「房裡有人沒開語音」會被報成「連不上」→ 鈕紅著閃給沒事的人看。 */
      if (peers[id].failed && peers[id].heard) bad.push(id);
    }
    /* ★ 自己也進 speaking(v2.3.7)—— 晶片列那邊 `talkingIds.indexOf(id)>=0` 就會給
       自己的晶片掛上 `.tk-talking`,**十四頁與兩份 renderPlayers 一行都不必改**。
       ⚠ 一定要 `speak &&`:閉著麥的時候框不可以亮(那會變成「我以為我在講話」)。 */
    if (speak && localSpeaking) { const my = me(); if (my) spk.push(my); }
    const st = { listen, speak, speaking: spk, failed: bad, peers: Object.keys(peers).length, voice: voiceMap() };
    /* ⚠ 鈕一律重畫,**不可以**因為 hooks 還沒掛上就跳過 —— 沒進房時 hooks 是 null,
       而那時使用者照樣按得到鈕(大廳畫面);跳過的話會變成「按了沒反應」。 */
    paintBtns(st);
    if (hooks && hooks.onState) { try { hooks.onState(st); } catch (e) { } }
    /* ⚠ 徽章要排在 onState **後面**:那支會把整條晶片列重建掉(renderPlayers),
       排在前面的話剛掛上的徽章會被立刻沖掉,要等 observer 補第二趟才看得到(會閃一下)。 */
    paintChips();
  }

  /* ==========================================================================
     使用統計 —— 給首頁那個隱藏的「伺服器狀態」面板回答「語音到底有沒有人在用」
     ──────────────────────────────────────────────────────────────────────────
     ★ 記的是**人次**:每個人在每一間房記一次(開了又關再開不重複算),
       一場四個人都開 = 4 次。比「幾間房用過」更能回答「有多少人真的在用」。
     ★ 節點刻意寄生在既有的 game_stats 底下、叫 **talk_<遊戲 key>**:
       資料庫規則本來就是 `game_stats/$game/n` 的萬用字元(見 notes/firebase-rules.json),
       $game 換成 talk_gomoku 一樣過得去 → **一行規則都不必改、不必重新部署**
       (同一顆 game_stats 請求就把十四個遊戲的語音次數一起讀回來,面板不必多跑一趟)。
       ⚠ 反過來說 `talk_` 變成保留前綴:將來新增遊戲的 key 不可以用它開頭。
       ⚠ 首頁熱門度排序查的是 stats[遊戲 key],完全不會撈到這幾筆。
     ★ 遊戲 key 從 roomRef 自己反推(roomRef.parent.key = "<key>_rooms",Bingo 是 "rooms")
       —— **刻意不新增 hook**:attach() 的呼叫端有兩份(mp-core.js 與 online.js),
       加一個參數就是再養一組會慢慢分岔的雙胞胎(CLAUDE.md 紅線 4)。
       反推不出來就安靜地不記(統計壞掉絕不可以影響通話本身)。
     ========================================================================== */
  function statKey() {
    try {
      const r = hooks && hooks.ref && hooks.ref("rtc");
      const nd = r && r.parent && r.parent.parent;   // rtc → 房間 → <key>_rooms 這一層
      const k = nd && nd.key;
      if (!k) return "";
      if (k === "rooms") return "bingo";             // Bingo 的房間節點就叫 rooms
      return /_rooms$/.test(k) ? k.replace(/_rooms$/, "") : "";
    } catch (e) { return ""; }
  }
  function bumpStat() {
    if (statDone || !hooks) return;
    const k = statKey(); if (!k) return;
    const r = hooks.ref && hooks.ref("rtc");
    if (!r || !r.root) return;
    /* 旗標先立起來:送失敗也不重試 —— 這是統計,不值得為它再排一輪交易,
       更不可以變成「每次 sync() 都重送」(有人講話時 sync 會被叫很多次)。 */
    statDone = true;
    try { r.root.child("game_stats/talk_" + k + "/n").transaction(n => (n || 0) + 1); } catch (e) { }
  }

  /* ==========================================================================
     對帳 —— 「接不上就自己修好」(v2.3.7)
     ──────────────────────────────────────────────────────────────────────────
     ★★★ 為什麼這一段比任何單一 bug 的修正都重要:
       WebRTC 的協商有**太多會靜靜失敗**的路徑,而它們的共同下場是
       **PC 停在 `connecting`,永遠不會變 `failed`** →
       `onconnectionstatechange` 一次都不會來 → 沒有紅色、沒有 restartIce、沒有 toast。
       三人局現場回報的「有一個人每次都聽得到全部,其他人各缺一個」就是這樣長出來的:
       壞掉的是**一條** pairwise 連線,而沒被牽連的第三個人自然聽得到全部。
       ⚠ 而且它是**決定性**的(禮讓方由 pid 字典序決定,pid 存在 localStorage)——
         「每次都同一個人」正是這種結構性錯誤的指紋,不是網路抖動。
     → 逐一補完那些路徑補不完,所以這裡不猜原因,只問一件事:**這條線壞多久了。**

     三階升級(全部以「壞了多久」為判準,見檔頭的常數):
       ≥ 3s  · **重貼一次自己的 SDP** —— 對方的信箱可能被清掉了 / 那封信掉了。
               ★ 重貼相同內容不會產生事件(Firebase 只在值變了才通知)→ 沒事的人完全
                 不受打擾;而值被刪成 null 的那一邊就會補上,死鎖當場解開。
       ≥ 9s  · **整條 PC 重建**(間隔每次翻倍,上限 60s)—— 狀態機卡死 / 對方換了新的 PC。
       ≥ 20s · **標紅** —— 修不好也要讓使用者看得見,不要讓他以為大家都沒在講話。

     ⚠⚠ 三條紀律,少一條就會變成新的災難:
       ① **只對「真的在語音裡的人」動手**(`P.heard`)。房裡沒開語音的人那條 PC 本來就
          接不起來,對他們對帳 = 每 3 秒白寫一筆 SDP、每 9 秒重建一次。
       ② **`connected` 的線一個字都不要碰。** 碰一下就是一次重新協商 + 幾秒空白。
       ③ **修復只能由這個節奏發動。** 寫進 onDesc 的 glare 分支(「一忽略 offer 就重貼」)
          會讓兩台互相把同一份 SDP 貼到天亮。
     ========================================================================== */
  function startRepair() {
    if (repairTimer) return;
    repairTimer = setInterval(repairTick, REPAIR_MS);
  }
  function stopRepair() {
    if (repairTimer) { clearInterval(repairTimer); repairTimer = null; }
  }
  function repairTick() {
    if (!hooks || !on()) return;
    const now = Date.now();
    let changed = false;
    /* ⚠ 一定要先把 key 拍下來:下面的重建會 delete + 重新塞同一個 key,
       直接 for-in 邊走邊改是未定義行為。 */
    Object.keys(peers).forEach(id => {
      const P = peers[id];
      if (!P) return;
      if (!P.heard) return;                      // 紀律 ①
      if (P.pc.connectionState === "connected") { // 紀律 ②
        if (P.badSince || P.failed) { P.badSince = 0; P.failed = false; delete retry[id]; changed = true; }
        return;
      }
      if (!P.badSince) { P.badSince = now; return; }   // 這一輪才發現壞,下一輪才動手
      const bad = now - P.badSince;

      if (bad >= REBUILD_MS) {
        const r = retry[id] || (retry[id] = { at: 0, gap: REBUILD_MS });
        if (now - r.at >= r.gap) {
          r.at = now;
          r.gap = Math.min(r.gap * 2, REBUILD_MAX_MS);
          /* ⚠ keepMail=true:DB 上對方寄來的信不可以動 —— 重建的目的就是要收下它。 */
          dropPeer(id, true);
          peerOf(id, true);          // heard 帶過去,不然新的 P 會被紀律 ① 排除掉
          changed = true;
          return;                    // 這一輪就到這裡,新的 PC 讓它自己去協商
        }
      }
      if (bad >= NUDGE_MS) sendDesc(id, P.pc.localDescription);
      if (bad >= BAD_MS && !P.failed) { P.failed = true; changed = true; }
    });
    if (changed) report();
  }

  /* ★★★ 「連上了卻沒聲音」的補播,從兩顆鈕擴大到**整個畫面的任何一次點按**(v2.3.7)。
     `ontrack` 是**對方接上的那一刻**觸發的,常常在我按完鈕很久之後 —— 那一次 `play()`
     被 iOS 的自動播放政策擋掉的話,以前**只有再去按那兩顆語音鈕**才救得回來,
     而使用者這時的直覺是「他壞了」,不是「我再按一次麥克風」。
     玩遊戲的人每幾秒就在點畫面,而那是貨真價實的使用者手勢 → 幾乎零成本就補掉了。
     ⚠ 沒有東西要補時**什麼都不做**:這支掛在 document 上、每一次點按都會經過。
     ⚠ pointerdown 與 touchend 都掛:iOS 對「哪一種事件算使用者啟動」歷來比較挑,
       而 kickPlay() 本身是冪等的,多跑一次沒有代價。 */
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    const h = () => {
      if (!on()) return;
      let need = false;
      for (const id in peers) if (peers[id].needPlay) { need = true; break; }
      /* ⚠ 這道閘 v2.3.9 之前只問 `acx` —— **本地那顆睡著時整個補救就被濾掉了**
         (kickPlay 裡補了 resumeCtx(lacx) 也照樣走不到)。兩顆一起問。 */
      if (need || ctxAsleep()) kickPlay();
    };
    try {
      document.addEventListener("pointerdown", h, true);
      document.addEventListener("touchend", h, true);
    } catch (e) { }
    /* ★★ 回到前景就**主動**試一次(v2.3.9),不必等使用者點螢幕。
       ⚠ 為什麼「點螢幕」不夠:切回來的頭幾秒是最容易被判定「這東西壞了」的時候,
         而使用者這時多半正盯著畫面找誰在講話,手還沒動。
       ⚠ 這一下**沒有使用者手勢**,所以 iOS 很可能直接拒絕 → 它是加分項,不是替代品:
         上面那兩個 listener 仍然是保證能救回來的那條路(resumeCtx 已經把拒絕吞掉了)。
       ⚠ 判斷用 `document.hidden` 而不是 `visibilityState === "visible"`:
         規格上還有 "prerender" 這種值,而那時候該做的事跟 visible 一樣。
       ⚠ 也順手 armLocalMeter():長時間背景之後 context 有可能是 **closed**(叫不醒),
         那時 lanalyser 已經連同它一起歸零 → 這一支會重新接一顆起來(它是冪等的)。 */
    try {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden || !on()) return;
        resumeCtx(acx);
        resumeCtx(lacx);
        armLocalMeter();
        kickPlay();
      });
    } catch (e) { }
  }

  /* ---------- 依「現在房裡有誰」+「兩個開關」重算所有連線 ---------- */
  function sync() {
    if (!hooks) return;
    if (!on()) { teardown(); return; }
    /* ★ 這一行是「語音真的被打開了」唯一的匯流點:兩顆鈕、setListen / setSpeak
       兩支對外 API 最後都會經過 sync(),而且上面那道 on() 的閘已經把「沒開」濾掉了。 */
    bumpStat();
    watch();
    startRepair();      // 接不上就自己修好(見上面那一整段)
    armGesture();       // iOS:任何一次點按都補播被擋掉的遠端音訊
    armChipObs();       // 晶片上的語音徽章(自己盯著晶片列,十四頁零登記)
    armLocalMeter();    // 自己的麥克風音量 → 自己的框也會變綠

    const ps = hooks.players() || {};
    const live = Object.keys(ps).filter(id => id !== me());

    // 走掉的人:拆線
    Object.keys(peers).forEach(id => { if (live.indexOf(id) < 0) dropPeer(id); });

    /* 新來的 / 已在的:建線 + 對齊 direction 與 track。
       ⚠ 這裡**刻意不主動 setLocalDescription** —— peerOf() 裡的 addTransceiver、
         以及下面改 direction / replaceTrack,每一個都會觸發 onnegotiationneeded,
         那支已經負責送 offer 了。在這裡再送一次等於自己跟自己 glare
         (症狀:接上之後又立刻斷,反覆重連)。開場一律交給 negotiationneeded。 */
    const dir = dirOf();
    live.forEach(id => {
      const P = peerOf(id);
      if (P.tx && P.tx.direction !== dir) {
        try { P.tx.direction = dir; } catch (e) { }   // → 觸發 onnegotiationneeded
      }
      if (P.tx) {
        const cur = P.tx.sender.track;
        const wantTrack = (speak && localStream) ? localStream.getAudioTracks()[0] : null;
        if (cur !== wantTrack) { try { P.tx.sender.replaceTrack(wantTrack || null); } catch (e) { } }
      }
    });
    report();
  }

  function teardown() {
    stopRepair();
    /* ⚠⚠ **一定要包一層 `id => dropPeer(id)`,不可以直接 `forEach(dropPeer)`。**
       `dropPeer(id, keepMail)` 有第二個參數,而 forEach 傳的是 `(值, 索引, 陣列)` →
       裸寫的話**第二個 peer 起** `keepMail` 拿到 1、2、3…(truthy),
       於是那道「把對方留給我的信箱清掉」整條被跳過。
       ★ 目前救了它一命的是下一行的 `unwatch()`(它 remove 掉整個 `rtc/{我}`,連帶把漏掉的
         一起帶走)—— 所以這個 bug **現在沒有症狀**。但它是個等著咬下一個人的陷阱:
         哪天有人把這兩行對調、或讓 unwatch 不再整節刪,殘留的舊 offer 就會在下一次開語音時
         被 `.on("value")` 當成新的收下來(見 attach 的長註解:那正是死鎖的入口)。
       ⚠ sync() 裡那一行(拆走掉的人)本來就是包起來的 —— 兩處寫法不一致,這裡是漏的那個。 */
    Object.keys(peers).forEach(id => dropPeer(id));
    unwatch();
    stopMeter();
    stopLocalMeter();
    closeMic();
    duck(false);
    /* 這一輪的暫存全部歸零:留著的話下一次開語音會把上一輪的 candidate / 重建節流
       帶進去(而那些都是對著已經不存在的 PC 的)。 */
    Object.keys(orphans).forEach(k => { delete orphans[k]; });
    Object.keys(retry).forEach(k => { delete retry[k]; });
    Object.keys(chain).forEach(k => { delete chain[k]; });
    stopChipObs();
    report();
  }

  /* ==========================================================================
     兩個開關(命名函式:bindUi 的 click handler 也要用到)
     ──────────────────────────────────────────────────────────────────────────
     ★★★ **「講」蘊含「聽」**(v2.1.0)—— 兩顆鈕不再是完全獨立的。
         使用者:「你都要說話了,怎麼可能不要聽呢」。這也是連線遊戲的通例
         (Discord 的 mute / deafen 就是這個模型)。三條規則:

           ① 開「講」 → 「聽」自動跟著開
           ② 關「聽」 → 「講」跟著關(①的逆否命題;不然會冒出「聽不到卻在講」)
           ③ **「聽著但閉麥」一定要留著** —— 使用者明確要保留的「暫停說話」

     → 於是 (listen=false, speak=true) 這個組合**再也不會出現**。
     ⚠ 規則寫在**這一層**,不是寫在 bindUi 的 click handler 裡:
       setListen / setSpeak 是對外 API,只擋 UI 的話從 API 進來照樣能把不變式破掉。
     ⚠ 規則 ① 的副作用是「聽」會**無聲無息地被打開」,那沒問題(多聽到東西不會嚇到人);
       規則 ② 反過來會**把麥克風關掉**,那是會嚇到人的 → bindUi 那邊要出一則 toast。
     ========================================================================== */
  async function doListen(v) {
    listen = !!v;
    // 規則 ②:關「聽」= 整個語音關掉,麥克風不可以自己留著開著
    if (!listen && speak) { speak = false; closeMic(); duck(false); }
    kickPlay();      // 這一下是使用者手勢:把 iOS 擋掉的遠端音訊補播回來
    sync();
    return true;
  }
  /* ⚠ 回傳 false = 使用者不給權限 / 裝置沒有麥克風 —— 呼叫端要把鈕彈回去,
     不可以自顧自地顯示「已開麥」(那是「我以為我在講話」最糟的一種)。
     ⚠ 失敗時**刻意不動 listen**:使用者按的是麥克風,結果卻變成「開始聽得到別人」
       是另一種驚嚇,而且 toast 已經把失敗講清楚了。 */
  async function doSpeak(v) {
    kickPlay();      // 同 doListen:這一下是手勢,順手補播
    if (v) {
      try { await openMic(); } catch (e) { speak = false; sync(); return false; }
      speak = true;
      listen = true;   // 規則 ①:要說話就一定要聽得到
      duck(true);
    } else {
      speak = false; closeMic(); duck(false);
    }
    sync();
    return true;
  }

  /* ---------- 對外 API ---------- */
  return {
    supported,
    /* ★ 綁那兩顆鈕。十三頁由 ui-kit 的 bindCommonUI() 代叫;**Bingo 自己在 main.js 叫一次**
       (它不載入 js/shared/ui-kit.js)。沒有那兩顆鈕的頁面直接 return,所以可以無腦呼叫。 */
    bindUi() {
      const bL = btnL(), bS = btnS();
      if (!bL && !bS) return;                    // 這一頁沒接語音
      if (!supported()) {                        // 瀏覽器不支援(或走 http 不是 https)
        // 留一顆按了沒反應的鈕比沒有更糟 —— 直接收起來
        if (bL) bL.classList.add("hidden");
        if (bS) bS.classList.add("hidden");
        return;
      }
      if (bL) bL.addEventListener("click", async () => {
        if (uiBusy) return; uiBusy = true;
        /* 規則 ②:關「聽」的時候麥克風會被一起關掉 —— 那是**會嚇到人的**副作用
           (「我只是不想聽,怎麼連我的麥也沒了」),一定要講出來。
           ⚠ 要先記住按之前的狀態:doListen 回來之後 speak 已經被改掉了。 */
        const wasSpeak = speak;
        try { await doListen(!listen); } finally { uiBusy = false; }
        if (wasSpeak && !speak) toast("已關閉語音,麥克風也一起關掉了");
        paintBtns();
      });
      if (bS) bS.addEventListener("click", async () => {
        if (uiBusy) return; uiBusy = true;
        try {
          const want = !speak;
          const ok = await doSpeak(want);
          /* ⚠ 被拒絕(沒給權限 / 沒有麥克風)一定要講出來並讓鈕彈回去 ——
             自顧自地顯示「已開麥」是「我以為我在講話」那一類最糟的錯誤。 */
          if (want && !ok) toast("沒辦法開啟麥克風,請檢查瀏覽器的權限設定");
        } finally { uiBusy = false; }
        paintBtns();
      });
      paintBtns();
    },
    /* 由 mp-core 在進房後掛上。hooks:
         ref(path)  → roomRef.child(path)(沒進房時回 null)
         me()       → 我的 pid ·  players() → 現在房裡的人(物件)
         onState(s) → 狀態變了要重畫 UI */
    /* ★★★ v2.3.7:**這裡原本會把自己的信箱整個 remove() 掉,已經拿掉了。**
       ── 原本為什麼要清(v1.182.1)──
         `d` 是 set() 寫的,而 `.on("value")` 一掛上就會立刻回一次現值 → 上一輪殘留的
         offer 會被當成新的收下來,對著一條早就不存在的連線協商。
       ── 為什麼它是錯的 ──
         `attach()` 的時機是 `claimSeat` 交易提交**之後**(核心的 enterLobby → listen),
         而別人看到我入座、算出 offer、寫回 DB 也是兩趟 —— **這是一個競態**,
         而 `adoptScore()` 要接回舊成績時還會多一次交易,那種情況清得**一定比較晚**。
         清掉之後對方停在 `have-local-offer` 等一封已經不存在的信的回音,
         而他若剛好是 impolite,還會把我後來送的 offer 當成 glare 直接丟掉
         → **兩邊互相等,永久死鎖**。三人局「有人先開語音、第三個人才加入」必中,
         而且因為禮讓方由 pid 字典序決定,**每次壞的都是同一條線**。
       ── 現在怎麼處理陳舊的 SDP ──
         改用**世代**(payload 的 `g`,見 newGen):殘留的信帶的是舊世代,對方真正的 offer
         一到就對不上 → 就地重建。**從「靠時機清掉」變成「看得出來」** —— 這才是這一類
         問題的正解,而且順手修掉「對方換了一條全新 PC」那條路(斷線重連)。
       ⚠ 殘留不會累積:candidate 收完就刪、`d` 會被下一封 set() 蓋掉,
         而 `stop()` / 房主關房 / create() 的 wipe 都會把整個 `rtc` 清乾淨。
       ⚠⚠ **不要「順手」把 remove() 加回來。** 加回來就是把上面那個死鎖一起加回來。 */
    attach(h) {
      hooks = h;
      statDone = false;   // 使用統計是「一間房記一次」→ 進新房要重新起算(比照核心的 armPlayCount)
      /* 世代的鹽:每次進房重抽。⚠ 不可以只靠遞增序號 —— 重新整理頁面後序號會從 1 重來,
         上一輪殘留的信就會跟新的 PC 撞成同一個世代,上面那套判斷整個失效。 */
      genSeq = 0;
      sess = Math.random().toString(36).slice(2, 8) + (Date.now() % 46656).toString(36);
    },
    listening() { return listen; },
    speaking() { return speak; },
    /* 診斷用:把 ICE 設定攤出來給 tools/t-turn-check.html 與 t-talk-e2e 的 J 節。
       ⚠ 一定要回**複本**:診斷頁拿到的是同一個陣列的話,它隨手改一下就會改到正式連線
         用的設定(而那種錯誤只在特定網路環境下才看得出來)。
       ★ 產品碼**不會**呼叫這一支 —— 它存在的唯一理由是「壞掉的 TURN 與沒有 TURN
         在畫面上一模一樣」,總要有個地方量得到。 */
    iceServers() { return ICE_SERVERS.map(s => Object.assign({}, s)); },
    setListen: doListen,
    setSpeak: doSpeak,
    // 房裡的人變了(有人進來 / 離開)→ 核心叫這一支
    refresh() { sync(); },
    // 離開房間:全部拆乾淨(核心的 leave() 收不到子節點的監聽,見檔頭紅線 ①)
    stop() {
      listen = false; speak = false;
      teardown();
      hooks = null;
      statDone = false;
      sess = ""; genSeq = 0;
    },
    /* 診斷用(產品碼不呼叫,同 iceServers() 的先例):每條線現在到什麼地步。
       ★ 存在的理由與 `t-turn-check.html` 一樣 —— 「有人聽不到某個人」這種回報
         如果只能靠猜,就會一直靠猜。這一支讓它在 console 裡一行就問得出來:
         `Talk.diag()`(晶片上那顆徽章是它的簡化版,給現場的人看的)。 */
    diag() {
      return Object.keys(peers).map(id => {
        const P = peers[id];
        return {
          id, heard: P.heard, polite: P.polite, state: P.pc.connectionState,
          ice: P.pc.iceConnectionState, sig: P.pc.signalingState,
          dir: (P.tx && P.tx.currentDirection) || "", voice: voiceOf(P),
          /* v2.3.8:徽章 / 綠框說謊的時候,要一行就問得出**哪一層**壞了 ——
             `recv` 是事實(receiver 真的在收嗎)、`dir` 是意圖(協商出來的方向),
             `an` / `spk` 是音量分析那一路(它死掉的話綠框會停,但聲音照樣聽得到)。 */
          recv: recvLive(P), spk: !!P.speaking, an: !!P.analyser,
          /* v2.5.1 省流那一組:`dtx` = 這條線收到的 SDP 真的被補上 usedtx 了嗎、
             `rate` = 現在給這條線的上行上限(0 = 還沒套上去)。 */
          dtx: !!P.dtx, rate: P.rateAt || 0,
          badMs: P.badSince ? (Date.now() - P.badSince) : 0,
          gen: P.gen, rgen: P.rgen, pend: P.pend.length, needPlay: !!P.needPlay
        };
      });
    },
    /* 診斷用(產品碼不呼叫,同 diag() 的先例):**這條線的品質**,v2.3.9。
       ★ 存在的理由:`diag()` 只回答「通不通」,而現場最常見的回報是
         **「通了,但斷斷續續」** —— 那時要分的是兩件完全不同的事:
           · `relay` + `rtt` 幾百毫秒 → 走的是**免費公共 TURN 中繼**(整條線都慢,誰都一樣);
           · `host`/`srflx` 但 `loss` 很高 → 是**某一個人的網路在抖**(其他線好好的)。
         猜不出來的話只會一直換 TURN 或一直重開語音,而那兩條路都修不到對方的 Wi-Fi。
       ⚠ 一定要 async:`getStats()` 回 Promise,所以**不可以**塞進 diag()
         (那一支是同步的,測試與 t-turn-check 都當它同步在用)。
       ⚠ 拿不到就回 `null` 欄位,不要回 0 —— 「問不到」與「真的是 0」在診斷時差很多。
       跑法:`await Talk.stats()` */
    async stats() {
      const ids = Object.keys(peers);
      const out = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i], P = peers[id];
        const row = { id, state: P.pc.connectionState, kind: null, rtt: null, loss: null, jitter: null };
        try {
          const rs = await P.pc.getStats();
          let pair = null, rtp = null, local = null;
          const byId = Object.create(null);
          rs.forEach(s => { byId[s.id] = s; });
          rs.forEach(s => {
            /* ⚠ 只認**選上的**那一對:候選對會有好幾組(每一種 candidate 都試過),
               沒選上的那些 rtt 是垃圾。Chrome 標在 pair 上,Firefox 走 transport → 兩條都問。 */
            if (s.type === "candidate-pair" && (s.selected || s.state === "succeeded") && !pair) pair = s;
            if (s.type === "transport" && s.selectedCandidatePairId && byId[s.selectedCandidatePairId]) pair = byId[s.selectedCandidatePairId];
            if (s.type === "inbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) rtp = s;
          });
          if (pair) {
            if (typeof pair.currentRoundTripTime === "number") row.rtt = Math.round(pair.currentRoundTripTime * 1000);
            local = pair.localCandidateId ? byId[pair.localCandidateId] : null;
            if (local && local.candidateType) row.kind = local.candidateType;   // host / srflx / relay
          }
          if (rtp) {
            if (typeof rtp.jitter === "number") row.jitter = Math.round(rtp.jitter * 1000);
            const lost = rtp.packetsLost, got = rtp.packetsReceived;
            if (typeof lost === "number" && typeof got === "number" && (lost + got) > 0) {
              row.loss = Math.round((lost / (lost + got)) * 1000) / 10;        // 百分比,一位小數
            }
          }
        } catch (e) { }
        out.push(row);
      }
      return out;
    }
  };
})();

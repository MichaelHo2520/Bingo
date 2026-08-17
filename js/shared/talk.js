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
    return localStream;
  }
  function closeMic() {
    if (!localStream) return;
    localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) { } });
    localStream = null;
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
  function kickPlay() {
    for (const id in peers) { const P = peers[id]; if (P.needPlay) playNow(P); }
    try { if (acx && acx.state === "suspended") acx.resume(); } catch (e) { }
  }

  /* ---------- 一條連線 ---------- */
  function peerOf(id) {
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
      failed: false
    };
    peers[id] = P;

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
      outRef(id).child("c").push({
        d: c.candidate, m: c.sdpMid, i: c.sdpMLineIndex
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
      if (s === "failed") {
        /* v2.1.0 接上 TURN 之後,走到這裡的意思**變了**:以前多半是「對稱 NAT +
           沒有中繼」,現在則多半是**連 TURN 都拿不到 relay candidate** ——
           要嘛那台公共服務掛了、要嘛網路把它也擋掉了。
           ⚠ 兩者在畫面上一模一樣,別用猜的:開 `tools/t-turn-check.html` 量一次。
           重試一次 ICE(換一組 candidate 有時就通了);還是不行就標記起來給 UI 看,
           不要靜靜地沒聲音 —— 那會變成「我開了麥可是沒人聽得到,而且看不出為什麼」。 */
        if (!P.failed) { P.failed = true; try { pc.restartIce(); } catch (e) { } }
        report();
      } else if (s === "connected") {
        if (P.failed) { P.failed = false; report(); }
      }
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
    try { r.child("d").set({ t: desc.type, s: desc.sdp }); } catch (e) { }
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
    {
      const old = peers[fromId];
      if (old) {
        const cs = old.pc.connectionState, ss = old.pc.signalingState;
        if (cs === "failed" || cs === "closed" || ss === "closed") dropPeer(fromId, true);
      }
    }
    const P = peerOf(fromId), pc = P.pc;
    const desc = { type: d.t, sdp: d.s };
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
      if (desc.type === "offer") {
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
  async function onCand(fromId, c) {
    const P = peers[fromId];
    if (!P || !c || !c.d) return false;
    P.pend.push({ candidate: c.d, sdpMid: c.m, sdpMLineIndex: c.i });
    if (P.pc.remoteDescription && P.pc.remoteDescription.type) await flushCand(P);
    return true;
  }
  async function flushCand(P) {
    if (!P.pend.length) return;
    const q = P.pend.slice(); P.pend.length = 0;
    for (let i = 0; i < q.length; i++) {
      try { await P.pc.addIceCandidate(q[i]); } catch (e) { }
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
      slot.child("d").on("value", s => { const v = s.val(); if (v) onDesc(fromId, v); });
      /* candidate:**處理完(收下或排進佇列)才刪**。
         ⚠ 舊版是「onCand 之後立刻 remove」,而 onCand 是 async —— 等於一定在處理完
           之前就刪掉了,早到的那幾筆於是永遠消失(見 onCand 的長註解)。
         刪除本身還是要做:不刪的話一間房打一整晚會累積成千上萬筆,
         而且重連的人會把上一輪的全部重放一次。 */
      slot.child("c").on("child_added", s => {
        onCand(fromId, s.val()).then(okd => {
          if (okd) { try { s.ref.remove(); } catch (e) { } }
        });
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
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!acx) acx = new AC();
      if (acx.state === "suspended") { try { acx.resume(); } catch (e) { } }
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
  function startMeter() {
    if (meterTimer) return;
    meterTimer = setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const id in peers) {
        const P = peers[id];
        if (!P.analyser) continue;
        P.analyser.getByteTimeDomainData(P.data);
        let peak = 0;
        for (let i = 0; i < P.data.length; i++) {
          const v = Math.abs(P.data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        if (peak >= SPEAK_THRESHOLD) P.lastLoud = now;
        const sp = (now - P.lastLoud) < SPEAK_HOLD_MS;
        if (sp !== P.speaking) { P.speaking = sp; changed = true; }
      }
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
  /* 只在「還沒有 SVG」時寫一次 —— 這樣舊的測試頁(HTML 裡還留著 🎙 字面的那些)
     也會被自動蓋掉,不必一份一份改。 */
  function ico(btn, html) { if (!btn.querySelector("svg")) btn.innerHTML = html; }
  function toast(msg) {
    // 兩份都叫 showToast(game.js / ui-kit.js),但這一支可能被沒有它的頁面載入
    try { if (typeof showToast === "function") showToast(msg); } catch (e) { }
  }

  function paintBtns(st) {
    const bL = btnL(), bS = btnS();
    const bad = !!(st && st.failed && st.failed.length);
    if (bL) {
      /* ⚠ 開 / 關**不換圖示的 markup**:音波與叉叉都在同一份 SVG 裡,
         由 `.tk-btn.on` 決定露哪一組(見上面 ICO_LISTEN 的長註解)。 */
      ico(bL, ICO_LISTEN);
      bL.classList.toggle("on", listen);
      /* 關「聽」會連麥克風一起關(規則 ②)—— 副作用要寫在標題裡先講,
         不要讓人按下去才發現自己被閉麥了。 */
      bL.title = listen ? (speak ? "關掉語音(麥克風也會一起關)" : "關掉語音(不再聽到別人)")
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

  /* ---------- 對外狀態 ---------- */
  function report() {
    const spk = [], bad = [];
    for (const id in peers) {
      if (peers[id].speaking) spk.push(id);
      if (peers[id].failed) bad.push(id);
    }
    const st = { listen, speak, speaking: spk, failed: bad, peers: Object.keys(peers).length };
    /* ⚠ 鈕一律重畫,**不可以**因為 hooks 還沒掛上就跳過 —— 沒進房時 hooks 是 null,
       而那時使用者照樣按得到鈕(大廳畫面);跳過的話會變成「按了沒反應」。 */
    paintBtns(st);
    if (hooks && hooks.onState) { try { hooks.onState(st); } catch (e) { } }
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

  /* ---------- 依「現在房裡有誰」+「兩個開關」重算所有連線 ---------- */
  function sync() {
    if (!hooks) return;
    if (!on()) { teardown(); return; }
    /* ★ 這一行是「語音真的被打開了」唯一的匯流點:兩顆鈕、setListen / setSpeak
       兩支對外 API 最後都會經過 sync(),而且上面那道 on() 的閘已經把「沒開」濾掉了。 */
    bumpStat();
    watch();

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
    Object.keys(peers).forEach(dropPeer);
    unwatch();
    stopMeter();
    closeMic();
    duck(false);
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
    /* ⚠ 進房那一刻**先把自己的信箱清乾淨**(v1.182.1)。
       `d` 是 set() 寫的,而 `.on("value")` 一掛上就會立刻回一次現值 —— 上一輪殘留的
       offer 會被當成新的收下來,然後對著一條早就不存在的連線協商(回一個沒有人要的
       answer,還把自己的 PC 推進錯的 signalingState)。
       ⚠ 房主開房時 create() 的 wipe 已經清過 rtc,但**訪客加入既有房間時不會** →
         這裡是那條路徑唯一的清理點。
       ⚠⚠ 一定要在這裡清、不可以搬到 watch() 裡:理由見 watch() 的長註解
         (會刪掉別人剛送來的邀請 → 兩邊互相等)。 */
    attach(h) {
      hooks = h;
      statDone = false;   // 使用統計是「一間房記一次」→ 進新房要重新起算(比照核心的 armPlayCount)
      try { const r = hooks && hooks.ref && hooks.ref("rtc/" + hooks.me()); if (r) r.remove(); } catch (e) { }
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
    }
  };
})();

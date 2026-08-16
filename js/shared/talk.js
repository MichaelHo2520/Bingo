"use strict";

/* ============================================================================
   即時語音(WebRTC mesh)—— 十三個連線遊戲共用
   ──────────────────────────────────────────────────────────────────────────
   ★★★ 名字叫 Talk 不叫 Voice:**`Voice` 已經被 js/audio.js 佔走了**(語音留言:
       錄 6 秒 WAV 送出去,非即時)。全專案沒有最外層 IIFE,同一頁的各檔共用全域
       詞法作用域 → 撞名就是整頁 SyntaxError。兩者是**完全不同的功能**,
       使用者看到的字面也要分開:語音留言 = 🎤、即時語音 = 🔊 / 🎙。

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

   ② **「聽」與「講」是兩個獨立開關,不可以合成一顆。**
      只想聽的人**不該被要求麥克風權限** —— 所以 getUserMedia 只在開「講」時才叫。
      這也是為什麼 direction 要算出四種狀態而不是開 / 關兩種(見 dirOf)。

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

  /* ---------- 對外設定 ---------- */
  /* 只有公共 STUN;TURN 之後要接的話補在這個陣列裡就好(例如 Cloudflare 的免費額度)。
     ⚠ 沒有 TURN 的代價:對稱 NAT 的組合(估 10~20%)會連不起來 —— 那時 UI 會顯示
       「連不上」而不是靜靜沒聲音(見 pc.oniceconnectionstatechange)。 */
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
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
       對方不會送。inactive 只在「兩個都關」時出現,而那時我們根本不建 PC。 */
  function dirOf() {
    if (speak && listen) return "sendrecv";
    if (speak) return "sendonly";
    if (listen) return "recvonly";
    return "inactive";
  }

  /* ---------- 麥克風 ---------- */
  /* ★★★ getUserMedia **一定要包 timeout**(v1.182.0)。
     它在兩種情況下會「永遠不 resolve、也不 reject」:
       ① 使用者把權限提示晾在那裡不點(很常見 —— 提示跳出來的時候人正在看牌);
       ② headless / 沒有音訊裝置的環境(這就是 t-talk-e2e 一開始整支卡死的原因)。
     而呼叫端(ui-kit 的 bindTalkUi)為了擋連點有一個 `talkBusy` 旗標,
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
        /* 走到這裡多半是**兩邊都在對稱 NAT 後面而我們沒有 TURN**。
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

  /* ---------- 對外狀態(UI 用) ---------- */
  function report() {
    if (!hooks || !hooks.onState) return;
    const spk = [], bad = [];
    for (const id in peers) {
      if (peers[id].speaking) spk.push(id);
      if (peers[id].failed) bad.push(id);
    }
    try { hooks.onState({ listen, speak, speaking: spk, failed: bad, peers: Object.keys(peers).length }); } catch (e) { }
  }

  /* ---------- 依「現在房裡有誰」+「兩個開關」重算所有連線 ---------- */
  function sync() {
    if (!hooks) return;
    if (!on()) { teardown(); return; }
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

  /* ---------- 對外 API ---------- */
  return {
    supported,
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
      try { const r = hooks && hooks.ref && hooks.ref("rtc/" + hooks.me()); if (r) r.remove(); } catch (e) { }
    },
    listening() { return listen; },
    speaking() { return speak; },

    async setListen(v) {
      listen = !!v;
      kickPlay();      // 這一下是使用者手勢:把 iOS 擋掉的遠端音訊補播回來
      sync();
      return true;
    },
    /* ⚠ 回傳 false = 使用者不給權限 / 裝置沒有麥克風 —— 呼叫端要把鈕彈回去,
       不可以自顧自地顯示「已開麥」(那是「我以為我在講話」最糟的一種)。 */
    async setSpeak(v) {
      kickPlay();      // 同 setListen:這一下是手勢,順手補播
      if (v) {
        try { await openMic(); } catch (e) { speak = false; sync(); return false; }
        speak = true; duck(true);
      } else {
        speak = false; closeMic(); duck(false);
      }
      sync();
      return true;
    },
    // 房裡的人變了(有人進來 / 離開)→ 核心叫這一支
    refresh() { sync(); },
    // 離開房間:全部拆乾淨(核心的 leave() 收不到子節點的監聽,見檔頭紅線 ①)
    stop() {
      listen = false; speak = false;
      teardown();
      hooks = null;
    }
  };
})();

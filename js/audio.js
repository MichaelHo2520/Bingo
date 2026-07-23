"use strict";

  // iOS 16.4+ navigator.audioSession:控制音訊是否受側邊靜音鍵影響。
  //  "playback"        = 純播放,繞過靜音鍵(收語音/音效/BGM 用)
  //  "play-and-record" = 可同時錄音+播放,也繞過靜音鍵(錄語音時用;錄完切回 playback)
  // 若不切成 play-and-record,錄音的 getUserMedia 會被 playback session 擋下 → 「無法啟動錄音」。feature-detect,不支援就略過。
  function setAudioSession(type){
    try{ const as=navigator.audioSession; if(as && as.type!==type) as.type=type; }catch(e){}
  }

  /* ---------- Sound(Web Audio 合成音效 + 勝敗音檔 win.wav/lose.wav;含總音量調整) ---------- */
  const Sound=(function(){
    let ctx=null, muted=false, vol=1;   // vol:音效總音量 0~1(預設 100%,勝敗音檔與所有合成音都經過總音量節點)
    let master=null;                     // 音效總音量 GainNode(建在當前 AudioContext 上)
    let winBuf=null, loseBuf=null;       // 勝/敗音檔(mp3/win.wav、mp3/lose.wav)解碼後的 AudioBuffer
    let winEl=null, loseEl=null;         // Web Audio 解不了時的 HTMLAudio 後備節點
    const SFX={ win:"mp3/win.wav", lose:"mp3/lose.wav" };
    const sfxReady={win:false,lose:false}, sfxFailed={win:false,lose:false}, sfxLoading={win:false,lose:false};
    // 平時(沒在錄音)把 session 設成 playback,收到的語音才能在靜音模式下也播出;但若正在錄音(play-and-record)則不覆蓋,避免打斷錄音。
    function setPlaybackSession(){
      try{ const as=navigator.audioSession; if(as && as.type==="play-and-record") return; }catch(e){}
      setAudioSession("playback");
    }
    function ac(){
      if(!ctx){const AC=window.AudioContext||window.webkitAudioContext; if(!AC)return null; ctx=new AC(); setPlaybackSession(); preload();}
      if(ctx.state==="suspended")ctx.resume();
      return ctx;
    }
    // Silent Buffer Kick:在使用者手勢當下播一段 0.01s 無聲 buffer,強制解鎖 AudioContext(舊 iOS resume() 不夠力時的便宜保險)
    function silentKick(c){ try{ const b=c.createBuffer(1,1,22050); const s=c.createBufferSource(); s.buffer=b; s.connect(c.destination); s.start(0); }catch(e){} }
    function tone(freq,o){
      if(muted)return; const c=ac(); if(!c)return;
      o=o||{}; const type=o.type||"sine",dur=o.dur||0.12,vol=o.vol||0.2,delay=o.delay||0,slide=o.slideTo||null;
      const t=c.currentTime+delay;
      const osc=c.createOscillator(),g=c.createGain();
      osc.type=type; osc.frequency.setValueAtTime(freq,t);
      if(slide)osc.frequency.exponentialRampToValueAtTime(slide,t+dur);
      g.gain.setValueAtTime(0.0001,t);
      g.gain.exponentialRampToValueAtTime(vol,t+0.012);
      g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
      osc.connect(g).connect(masterNode(c));
      osc.start(t); osc.stop(t+dur+0.03);
    }
    // 音效總音量節點:所有合成音與勝敗音檔都接到它,再進 destination(音量鍵/iOS 也有效)
    function masterNode(c){
      if(!master || master.context!==c){ master=c.createGain(); master.gain.value=vol; master.connect(c.destination); }
      return master;
    }
    // 預載勝/敗音檔:fetch → decodeAudioData → AudioBuffer(和 BGM 同套路)。首次建立 AudioContext 時就開始載,遊戲結束前通常已就緒。
    function loadSfx(key){
      if(sfxReady[key]||sfxFailed[key]||sfxLoading[key])return;
      const c=ac(); if(!c)return;
      sfxLoading[key]=true;
      fetch(SFX[key]).then(r=>{ if(!r.ok)throw 0; return r.arrayBuffer(); })
        .then(ab=>new Promise((res,rej)=>c.decodeAudioData(ab,b=>res(b),e=>rej(e))))
        .then(b=>{ if(key==="win")winBuf=b; else loseBuf=b; sfxReady[key]=true; sfxLoading[key]=false; })
        .catch(()=>{ sfxLoading[key]=false; sfxFailed[key]=true; });   // 取不到/解不了(離線、file://)→ 交給 HTMLAudio 或合成音後備
    }
    function preload(){ loadSfx("win"); loadSfx("lose"); }
    // 播已解碼的音檔(走總音量節點);成功回 true,失敗(muted / 無 ctx / 尚未載好)回 false
    function playBuf(buf){
      if(muted)return false;
      const c=ac(); if(!c||!buf)return false;
      try{ if(c.state==="suspended")c.resume(); const s=c.createBufferSource(); s.buffer=buf; s.connect(masterNode(c)); s.start(); return true; }catch(e){ return false; }
    }
    // HTMLAudio 後備(Web Audio 解不了時用);桌機/Android 可套音量,iOS 音量可能無效
    function playEl(key){
      if(muted)return false;
      try{ let el=key==="win"?winEl:loseEl; if(!el){ el=new Audio(SFX[key]); if(key==="win")winEl=el; else loseEl=el; } el.volume=Math.max(0,Math.min(1,vol)); el.currentTime=0; const p=el.play(); if(p&&p.catch)p.catch(()=>{}); return true; }catch(e){ return false; }
    }
    // 合成音後備:音檔還沒載好 / 全都取不到時,至少有聲(即原本的勝敗提示音)
    function synthWin(){ [523,659,784,1047].forEach((f,i)=>tone(f,{type:"triangle",dur:0.28,vol:0.22,delay:i*0.10})); tone(1568,{type:"sine",dur:0.5,vol:0.12,delay:0.46}); }
    function synthLose(){ [415,349,277].forEach((f,i)=>tone(f,{type:"triangle",dur:0.30,vol:0.20,delay:i*0.16})); tone(220,{type:"sine",dur:0.6,vol:0.13,delay:0.5,slideTo:147}); }
    return {
      toggle(){muted=!muted; if(!muted)tone(660,{type:"triangle",dur:0.08,vol:0.15}); return muted;},
      setMuted(m){muted=!!m;},
      isMuted(){return muted;},
      wake(){ setPlaybackSession(); const c=ac(); if(c)silentKick(c); },   // 手勢中喚醒:設 playback session(繞過靜音鍵)+ 建立/resume AudioContext + Silent Buffer Kick 強制解鎖
      running(){ return !!(ctx && ctx.state==="running"); },   // 是否已在 running(給「收到語音但 context 未解鎖」的 Fallback 判斷)
      state(){ return ctx ? ctx.state : "none"; },              // 目前 AudioContext 狀態(選配:開發者模式現場回報用)
      resume(){ const c=ac(); return (c&&c.resume)?c.resume().catch(()=>{}):Promise.resolve(); },   // 顯式喚醒並回傳 promise(手勢中呼叫,resume 後再開播)
      place(){tone(520,{type:"triangle",dur:0.10,vol:0.18,slideTo:820});},
      takeback(){tone(500,{type:"triangle",dur:0.13,vol:0.15,slideTo:240});},
      mark(){tone(300,{type:"sine",dur:0.09,vol:0.28,slideTo:560}); tone(760,{type:"sine",dur:0.05,vol:0.10,delay:0.02});},
      unmark(){tone(360,{type:"sine",dur:0.08,vol:0.12,slideTo:210});},
      start(){[392,523,659].forEach((f,i)=>tone(f,{type:"triangle",dur:0.12,vol:0.16,delay:i*0.05}));},
      line(){[523,659,784].forEach((f,i)=>tone(f,{type:"triangle",dur:0.17,vol:0.18,delay:i*0.06}));},
      emote(){tone(880,{type:"sine",dur:0.09,vol:0.13,slideTo:1245});},
      // 有新玩家加入房間:溫暖的上行三音(C-F-A),明顯有別於開始/完成線的音效,讓房內眾人都知道有人來了
      join(){[523,698,880].forEach((f,i)=>tone(f,{type:"sine",dur:0.16,vol:0.2,delay:i*0.09}));},
      // 輪到你出號:清亮的兩音「叮–咚」(D6→G6),音色/音高刻意有別於其它音效,讓沒盯著螢幕的人也知道換自己了
      turn(){ tone(1175,{type:"sine",dur:0.13,vol:0.26}); tone(1568,{type:"sine",dur:0.26,vol:0.24,delay:0.14}); },
      ctx(){ return ac(); },   // 給語音留言用同一個(已解鎖)AudioContext 播放,繞過 iOS 自動播放限制
      // 勝/敗音效:優先播使用者放的 mp3/win.wav、mp3/lose.wav;還沒載好或取不到就用合成音墊著,確保永遠有聲
      win(){ if(muted)return; if(playBuf(winBuf))return; if(!sfxReady.win&&!sfxFailed.win)loadSfx("win"); if(sfxFailed.win&&playEl("win"))return; synthWin(); },
      // 平手不走這裡(平手用 win);lose 只在自己輸時播
      lose(){ if(muted)return; if(playBuf(loseBuf))return; if(!sfxReady.lose&&!sfxFailed.lose)loadSfx("lose"); if(sfxFailed.lose&&playEl("lose"))return; synthLose(); },
      // 音效總音量(0~1):即時套到總音量節點與 HTMLAudio 後備(偏好記憶在 game.js)
      setVolume(v){ vol=Math.max(0,Math.min(1,+v||0)); if(master){ try{ master.gain.setTargetAtTime(vol,master.context.currentTime,0.03); }catch(e){ try{ master.gain.value=vol; }catch(_){} } } if(winEl){try{winEl.volume=vol;}catch(e){}} if(loseEl){try{loseEl.volume=vol;}catch(e){}} },
      vol(){ return vol; }
    };
  })();

  /* ---------- 背景音樂(獨立音檔,放在 mp3/ 資料夾,不內嵌) ----------
     為了不讓 index.html 每次改動都連音樂一起變大,音樂拆成獨立檔(放 `mp3/`),
     以相對路徑載入。可在設定裡切換曲目(setSrc);主路徑走 Web Audio:fetch → decodeAudioData →
     AudioBufferSource(loop) → GainNode(音量,iOS 也有效)→ destination;共用 Sound 已解鎖的
     AudioContext(繞過 iOS 自動播放)。fetch/decode 失敗(離線、file:// 取不到)→ 退回
     HTMLAudio;仍失敗就靜默關掉,App 不受影響、只是沒音樂。 */
  const BGM=(function(){
    let src="mp3/Sunday_Morning.mp3";   // 目前曲目路徑(預設 Sunday Morning;可由 setSrc 切換,載入偏好時也會覆寫)
    let master=null, buffer=null, node=null, el=null;
    let on=false, vol=0.35, ready=false, loading=false, failed=false, ducked=false;
    function ctx(){ return (Sound.ctx && Sound.ctx()) || null; }
    function ensureMaster(c){
      if(!master || master.context!==c){ master=c.createGain(); master.gain.value=vol; master.connect(c.destination); }
      return master;
    }
    function load(){
      if(ready || failed)return Promise.resolve();
      const c=ctx(); if(!c)return Promise.resolve();
      if(loading)return Promise.resolve();
      loading=true;
      return fetch(src).then(r=>{ if(!r.ok)throw 0; return r.arrayBuffer(); })
        .then(ab=>new Promise((res,rej)=>{ c.decodeAudioData(ab, b=>res(b), e=>rej(e)); }))
        .then(b=>{ buffer=b; ready=true; loading=false; })
        .catch(()=>{ loading=false; failed=true; });   // 取不到就標記失敗,交給 HTMLAudio 後備
    }
    function stopNode(){ if(node){ try{ node.stop(); node.disconnect(); }catch(e){} node=null; } }
    function playBuffer(){
      const c=ctx(); if(!c||!buffer)return;
      stopNode();
      const m=ensureMaster(c);
      if(c.state==="suspended"){ c.resume().catch(()=>{}); }
      node=c.createBufferSource(); node.buffer=buffer; node.loop=true;   // Web Audio 無縫循環
      node.connect(m); node.start();
    }
    function playFallback(){   // 後備:桌機/Android 仍能播(iOS 對 HTMLAudio 的音量可能無效)
      try{ if(!el){ el=new Audio(src); el.loop=true; } el.volume=vol; el.play().catch(()=>{}); }catch(e){}
    }
    // 語音期間先停背景音樂,讓語音聽得清楚;語音全部播完再恢復(僅在使用者原本就開著時)
    function duck(d){
      d=!!d;
      if(d===ducked)return;
      ducked=d;
      if(d){ stopNode(); if(el){ try{ el.pause(); }catch(e){} } }
      else if(on){ if(ready)playBuffer(); else if(failed)playFallback(); else load().then(()=>{ if(on&&!ducked){ if(ready)playBuffer(); else playFallback(); } }); }
    }
    // 切換曲目:丟掉舊的已解碼 buffer / HTMLAudio,重設載入狀態;若正在播放就立刻換成新曲接著播
    function setSrc(s){
      s=s||src; if(s===src)return;
      src=s;
      const wasPlaying = on && !ducked;
      stopNode();
      if(el){ try{ el.pause(); }catch(e){} el=null; }
      buffer=null; ready=false; failed=false; loading=false;
      if(wasPlaying){ load().then(()=>{ if(!on||ducked)return; if(ready)playBuffer(); else if(failed)playFallback(); }); }
    }
    return {
      isOn(){ return on; },
      vol(){ return vol; },
      src(){ return src; },
      setSrc,
      duck,
      setOn(o){
        on=!!o;
        if(on){
          if(ducked)return;   // 語音播放中:先記住偏好(on=true),等語音播完由 duck(false) 接手開播
          if(ready){ playBuffer(); }
          else if(failed){ playFallback(); }
          else { load().then(()=>{ if(!on||ducked)return; if(ready)playBuffer(); else playFallback(); }); }
        }else{
          stopNode(); if(el){ try{ el.pause(); }catch(e){} }
        }
      },
      setVolume(v){
        vol=Math.max(0,Math.min(1,+v||0));
        if(master){ try{ master.gain.setTargetAtTime(vol, master.context.currentTime, 0.05); }catch(e){ try{ master.gain.value=vol; }catch(_){} } }
        if(el){ try{ el.volume=vol; }catch(e){} }
      }
    };
  })();

  /* ---------- 語音留言(連線用:錄 PCM 編 WAV,跨平台可播) ----------
     不用 MediaRecorder 的壓縮輸出:Android 產生的 Opus/WebM iOS 無法解碼(「安卓錄→
     iPhone 沒聲音」的主因)。改自己抓原始 PCM、降到低取樣率、編成 WAV;iOS/Android
     都能用 AudioContext.decodeAudioData 解,一次解決相容問題。 */
  const Voice=(function(){
    const MAX_MS=6000, OUT_RATE=8000;   // 上限 6 秒;輸出 8kHz 單聲道(電話音質,跨平台又小;要更清晰可調高)
    let ctx=null, stream=null, src=null, proc=null, zero=null, buf=[], recLen=0, inRate=44100, tmr=null, onDone=null, active=false;
    function supported(){ return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext||window.webkitAudioContext)); }
    function recording(){ return active; }
    async function start(onWav){
      if(!supported())throw new Error("unsupported");
      onDone=onWav; buf=[]; recLen=0;
      setAudioSession("play-and-record");   // iOS:錄音前把 session 切成可錄音(否則被 playback session 擋下 → 無法啟動)
      const AC=window.AudioContext||window.webkitAudioContext; ctx=new AC();
      if(ctx.state==="suspended"){ try{ await ctx.resume(); }catch(e){} }
      inRate=ctx.sampleRate;
      stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      src=ctx.createMediaStreamSource(stream);
      proc=ctx.createScriptProcessor(4096,1,1);
      zero=ctx.createGain(); zero.gain.value=0;      // 靜音接 destination:讓 onaudioprocess 在 iOS 也觸發,又不會把麥克風回授到喇叭
      proc.onaudioprocess=e=>{ if(!active)return; const ch=e.inputBuffer.getChannelData(0); buf.push(new Float32Array(ch)); recLen+=ch.length; };
      src.connect(proc); proc.connect(zero); zero.connect(ctx.destination);
      active=true;
      tmr=setTimeout(stop, MAX_MS);
    }
    function detach(){
      if(tmr){clearTimeout(tmr);tmr=null;}
      try{ if(proc){ proc.onaudioprocess=null; proc.disconnect(); } }catch(e){}
      try{ if(src)src.disconnect(); }catch(e){}
      try{ if(zero)zero.disconnect(); }catch(e){}
      if(stream){ stream.getTracks().forEach(t=>{try{t.stop();}catch(e){}}); stream=null; }
      setAudioSession("playback");   // 錄音結束 → 切回純播放 session(收到的語音仍能繞過靜音鍵播放)
    }
    function stop(){
      if(!active)return; active=false; detach();
      const wav = recLen>0 ? encodeWav(mergeDown(buf,recLen,inRate,OUT_RATE),OUT_RATE) : null;
      buf=[]; recLen=0;
      try{ if(ctx)ctx.close(); }catch(e){} ctx=null;
      const cb=onDone; onDone=null; if(cb)cb(wav);
    }
    function cancel(){ onDone=null; if(active){ active=false; detach(); } buf=[]; recLen=0; try{ if(ctx)ctx.close(); }catch(e){} ctx=null; }
    // 合併所有 PCM 區塊並線性降取樣到 outRate
    function mergeDown(chunks,len,inR,outR){
      const all=new Float32Array(len); let off=0;
      for(const c of chunks){ all.set(c,off); off+=c.length; }
      if(outR>=inR)return all;
      const ratio=inR/outR, outLen=Math.floor(len/ratio), out=new Float32Array(outLen);
      for(let i=0;i<outLen;i++){ const s=Math.floor(i*ratio), e=Math.min(len,Math.floor((i+1)*ratio)); let sum=0,n=0; for(let j=s;j<e;j++){ sum+=all[j]; n++; } out[i]=n?sum/n:(all[s]||0); }
      return out;
    }
    // Float32 → 16-bit PCM 單聲道 WAV(ArrayBuffer)
    function encodeWav(samples,rate){
      const n=samples.length, ab=new ArrayBuffer(44+n*2), v=new DataView(ab);
      const ws=(o,s)=>{ for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i)); };
      ws(0,"RIFF"); v.setUint32(4,36+n*2,true); ws(8,"WAVE"); ws(12,"fmt ");
      v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
      v.setUint32(24,rate,true); v.setUint32(28,rate*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
      ws(36,"data"); v.setUint32(40,n*2,true);
      let o=44; for(let i=0;i<n;i++){ let x=Math.max(-1,Math.min(1,samples[i])); v.setInt16(o,x<0?x*0x8000:x*0x7FFF,true); o+=2; }
      return ab;
    }
    // ArrayBuffer → base64 dataURL(分塊避免爆堆疊)
    function toDataURL(ab){
      const bytes=new Uint8Array(ab); let bin=""; const CH=0x8000;
      for(let i=0;i<bytes.length;i+=CH){ bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH)); }
      return "data:audio/wav;base64,"+btoa(bin);
    }
    return { supported, recording, start, stop, cancel, toDataURL, MAX_MS };
  })();

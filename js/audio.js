"use strict";

  /* ---------- Sound (Web Audio, no files) ---------- */
  const Sound=(function(){
    let ctx=null, muted=false;
    function ac(){
      if(!ctx){const AC=window.AudioContext||window.webkitAudioContext; if(!AC)return null; ctx=new AC();}
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
      osc.connect(g).connect(c.destination);
      osc.start(t); osc.stop(t+dur+0.03);
    }
    return {
      toggle(){muted=!muted; if(!muted)tone(660,{type:"triangle",dur:0.08,vol:0.15}); return muted;},
      setMuted(m){muted=!!m;},
      isMuted(){return muted;},
      wake(){ const c=ac(); if(c)silentKick(c); },   // 手勢中喚醒:建立/resume AudioContext + Silent Buffer Kick 強制解鎖
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
      ctx(){ return ac(); },   // 給語音留言用同一個(已解鎖)AudioContext 播放,繞過 iOS 自動播放限制
      win(){[523,659,784,1047].forEach((f,i)=>tone(f,{type:"triangle",dur:0.28,vol:0.22,delay:i*0.10})); tone(1568,{type:"sine",dur:0.5,vol:0.12,delay:0.46});},
      // 輸的音效:與 win 的上行呼應,改成下行三音+尾端往下滑,做出「失落」感(平手不走這裡,平手用 win)
      lose(){[415,349,277].forEach((f,i)=>tone(f,{type:"triangle",dur:0.30,vol:0.20,delay:i*0.16})); tone(220,{type:"sine",dur:0.6,vol:0.13,delay:0.5,slideTo:147});}
    };
  })();

  /* ---------- 背景音樂(獨立音檔 bgm.mp3,不內嵌) ----------
     為了不讓 index.html 每次改動都連音樂一起變大,音樂拆成同目錄的獨立檔 `bgm.mp3`
     (30 秒、可無縫循環),以相對路徑載入。主路徑走 Web Audio:fetch → decodeAudioData →
     AudioBufferSource(loop) → GainNode(音量,iOS 也有效)→ destination;共用 Sound 已解鎖的
     AudioContext(繞過 iOS 自動播放)。fetch/decode 失敗(離線、file:// 取不到)→ 退回
     HTMLAudio;仍失敗就靜默關掉,App 不受影響、只是沒音樂。 */
  const BGM=(function(){
    const SRC="bgm.mp3";
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
      return fetch(SRC).then(r=>{ if(!r.ok)throw 0; return r.arrayBuffer(); })
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
      try{ if(!el){ el=new Audio(SRC); el.loop=true; } el.volume=vol; el.play().catch(()=>{}); }catch(e){}
    }
    // 語音期間先停背景音樂,讓語音聽得清楚;語音全部播完再恢復(僅在使用者原本就開著時)
    function duck(d){
      d=!!d;
      if(d===ducked)return;
      ducked=d;
      if(d){ stopNode(); if(el){ try{ el.pause(); }catch(e){} } }
      else if(on){ if(ready)playBuffer(); else if(failed)playFallback(); else load().then(()=>{ if(on&&!ducked){ if(ready)playBuffer(); else playFallback(); } }); }
    }
    return {
      isOn(){ return on; },
      vol(){ return vol; },
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

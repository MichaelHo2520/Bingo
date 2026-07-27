"use strict";

/* ============================================================================
   五子棋 — 介面雜項:toast / 主題 / 偏好 / 設定蓋板 / 表情 / 語音佇列 / 彩帶
   從 js/game.js 對應段落移植(表情與語音那套邏輯是踩過 iOS 音訊坑修出來的,照抄不要簡化)。

   ⚠ 偏好的關鍵差異:主題/音量/暱稱與 Bingo 共用同一個 localStorage key,
     但**寫入一律 read-modify-write merge** —— 整份 JSON.stringify 覆寫會把 Bingo 的
     target / size / scoreMode 等欄位清掉。五子棋專屬設定另存 gomoku.prefs.v1。
   ========================================================================== */

/* ---------- toast ---------- */
let toastT;
function showToast(txt,dur){
  let el=$("toast");
  if(!el){ el=document.createElement("div"); el.id="toast"; document.body.appendChild(el); }
  el.textContent=txt;
  el.classList.add("show");
  clearTimeout(toastT);
  toastT=setTimeout(()=>el.classList.remove("show"), dur||1100);
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function setActionHint(text){
  const el=$("actionHint"); if(!el)return;
  el.textContent=text||"";
  el.classList.toggle("hidden", !text);
}

/* ---------- 結果卡 ---------- */
function showResult(){ $("reopenWin").classList.add("hidden"); $("veil").classList.add("show"); }
function closeWin(){ $("veil").classList.remove("show"); $("reopenWin").classList.add("hidden"); }
function peekBoard(){ $("veil").classList.remove("show"); $("reopenWin").classList.remove("hidden"); }

/* ---------- 彩帶 ---------- */
function burst(){
  if(document.documentElement.getAttribute("data-theme")==="ebook")return;
  const cv=$("confetti"), ctx=cv.getContext("2d");
  cv.width=innerWidth; cv.height=innerHeight;
  const cs=getComputedStyle(document.documentElement);
  const cols=[cs.getPropertyValue("--accent"),cs.getPropertyValue("--accent-2"),cs.getPropertyValue("--daub"),cs.getPropertyValue("--marquee")].map(s=>s.trim());
  const P=Array.from({length:140},()=>({
    x:innerWidth/2,y:innerHeight*.35,
    vx:(Math.random()-.5)*14,vy:Math.random()*-15-4,
    g:.35+Math.random()*.2,s:6+Math.random()*8,
    c:cols[Math.floor(Math.random()*cols.length)],
    r:Math.random()*6,vr:(Math.random()-.5)*.4
  }));
  let t=0;
  (function loop(){
    ctx.clearRect(0,0,cv.width,cv.height); t++;
    P.forEach(p=>{ p.vy+=p.g; p.x+=p.vx; p.y+=p.vy; p.r+=p.vr;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.r); ctx.fillStyle=p.c;
      ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s*.6); ctx.restore(); });
    if(t<160)requestAnimationFrame(loop); else ctx.clearRect(0,0,cv.width,cv.height);
  })();
}

/* ---------- 主題 / 偏好 ---------- */
const THEMES=["sunset","midnight","bubblegum","meadow","arcade"];
const THEME_NAMES={sunset:"落日",midnight:"午夜霓虹",bubblegum:"泡泡糖",meadow:"草原",arcade:"街機",ebook:"電子書"};
const THEME_COLORS={sunset:["#ff8a3d","#ffd24a"],midnight:["#22e0ff","#ff4bd8"],bubblegum:["#ff4fa3","#9b6bff"],meadow:["#6cc04a","#ffcf47"],arcade:["#ffe600","#ff2d55"]};
let lastColorTheme="sunset";
let bgmOn=false, bgmVol=0.35, voiceVol=1.5, sfxVol=1, vibrateOn=true;
const BGM_TRACKS=[
  { id:"sunday", name:"Sunday Morning(預設)", src:"mp3/Sunday_Morning.mp3" },
  { id:"happy",  name:"歡樂",                 src:"mp3/bgm.mp3" }
];
let bgmTrack="sunday";
function bgmSrcOf(id){ const t=BGM_TRACKS.find(t=>t.id===id); return (t||BGM_TRACKS[0]).src; }

const SHARED_KEY="bingo.prefs.v1";     // 與 Bingo 共用:主題 / 音量 / 暱稱
const OWN_KEY="gomoku.prefs.v1";       // 五子棋專屬:棋盤大小 / 換先手 / 計分
function readJSON(k){ try{ return JSON.parse(localStorage.getItem(k))||{}; }catch(e){ return {}; } }
// ★ 共用 key 一律 merge 寫回,不整份覆寫(否則會清掉 Bingo 那些五子棋沒有的欄位)
function saveShared(patch){
  try{ localStorage.setItem(SHARED_KEY, JSON.stringify(Object.assign(readJSON(SHARED_KEY), patch))); }catch(e){}
}
function savePrefs(){
  const nameEl=$("mpName");
  saveShared({
    theme:lastColorTheme,
    ebook:document.documentElement.getAttribute("data-theme")==="ebook",
    muted:Sound.isMuted(),
    bgmOn:bgmOn, bgmVol:bgmVol, bgmTrack:bgmTrack,
    voiceVol:voiceVol, sfxVol:sfxVol, vibrate:vibrateOn,
    name:nameEl?nameEl.value.trim():""
  });
  try{
    localStorage.setItem(OWN_KEY, JSON.stringify({
      boardSize:MPG.boardSize(), swapFirst:MPG.swapFirst(),
      scoreMode:MPG.scoreMode(), winGoal:MPG.winGoal()
    }));
  }catch(e){}
}
function loadPrefs(){
  const p=readJSON(SHARED_KEY), q=readJSON(OWN_KEY);
  if(p.theme && THEMES.indexOf(p.theme)>=0){
    lastColorTheme=p.theme;
    document.documentElement.setAttribute("data-theme",p.theme);
  }
  if(p.muted) Sound.setMuted(true);
  if(typeof p.bgmVol==="number") bgmVol=Math.max(0,Math.min(1,p.bgmVol));
  BGM.setVolume(bgmVol);
  if(typeof p.bgmTrack==="string" && BGM_TRACKS.some(t=>t.id===p.bgmTrack)) bgmTrack=p.bgmTrack;
  BGM.setSrc(bgmSrcOf(bgmTrack));
  if(typeof p.voiceVol==="number") voiceVol=Math.max(0,Math.min(3,p.voiceVol));
  if(typeof p.sfxVol==="number") sfxVol=Math.max(0,Math.min(1,p.sfxVol));
  Sound.setVolume(sfxVol);
  if(typeof p.vibrate==="boolean") vibrateOn=p.vibrate;
  if(p.bgmOn) bgmOn=true;             // 記住「想開」;實際播放等首次手勢
  if(p.ebook) setEbook(true,true);
  if(typeof p.name==="string" && p.name){ const el=$("mpName"); if(el) el.value=p.name; }
  MPG.usePrefs(q);                    // 五子棋專屬偏好 → 建房預設
}
function buildSwatches(){
  const box=$("swatches"); if(!box)return; box.innerHTML="";
  THEMES.forEach(name=>{
    const b=document.createElement("button");
    b.type="button"; b.className="swatch"; b.dataset.theme=name;
    b.title=THEME_NAMES[name]; b.setAttribute("aria-label",THEME_NAMES[name]);
    const c=THEME_COLORS[name]||["#888","#555"];
    b.style.background="linear-gradient(135deg,"+c[0]+","+c[1]+")";
    b.addEventListener("click",()=>setTheme(name));
    box.appendChild(b);
  });
}
function setTheme(name){
  if(THEMES.indexOf(name)<0)return;
  if(document.documentElement.getAttribute("data-theme")==="ebook")return;
  document.documentElement.setAttribute("data-theme",name);
  lastColorTheme=name; savePrefs(); syncSettingsUI();
}
function setEbook(on,silent){
  const root=document.documentElement;
  if(on){
    if(root.getAttribute("data-theme")!=="ebook") lastColorTheme=root.getAttribute("data-theme");
    root.setAttribute("data-theme","ebook");
  }else root.setAttribute("data-theme",lastColorTheme);
  if(!silent) showToast(on?"電子書模式":THEME_NAMES[lastColorTheme]);
  savePrefs(); syncSettingsUI();
}
function toggleEbook(){ setEbook(document.documentElement.getAttribute("data-theme")!=="ebook"); }
function setBgm(on){ bgmOn=!!on; if(bgmOn){ Sound.wake(); BGM.setOn(true); } else BGM.setOn(false); savePrefs(); syncSettingsUI(); }
function setBgmVol(v){ bgmVol=Math.max(0,Math.min(1,v)); BGM.setVolume(bgmVol); }
function setBgmTrack(id){ if(!BGM_TRACKS.some(t=>t.id===id))return; bgmTrack=id; BGM.setSrc(bgmSrcOf(id)); savePrefs(); syncSettingsUI(); }
function setVoiceVol(v){ voiceVol=Math.max(0,Math.min(3,v)); }
function setSfxVol(v){ sfxVol=Math.max(0,Math.min(1,v)); Sound.setVolume(sfxVol); }
function setVibrate(on){ vibrateOn=!!on; savePrefs(); syncSettingsUI(); }
function syncSettingsUI(){
  const isEbook=document.documentElement.getAttribute("data-theme")==="ebook";
  const swE=$("swEbook"), swM=$("swMute"), sw=$("swatches");
  if(swE)swE.setAttribute("aria-checked",isEbook?"true":"false");
  if(swM)swM.setAttribute("aria-checked",Sound.isMuted()?"false":"true");
  const sfxEl=$("sfxVol"), sfxRow=$("sfxVolRow");
  if(sfxEl)sfxEl.value=Math.round(sfxVol*100);
  if(sfxRow)sfxRow.classList.toggle("dim",Sound.isMuted());
  const swV=$("swVibrate"); if(swV)swV.setAttribute("aria-checked",vibrateOn?"true":"false");
  if(sw){
    sw.classList.toggle("locked",isEbook);
    const active=isEbook?lastColorTheme:document.documentElement.getAttribute("data-theme");
    [...sw.children].forEach(b=>b.classList.toggle("on",b.dataset.theme===active));
  }
  const swB=$("swBgm"), volEl=$("bgmVol"), volRow=$("bgmVolRow");
  if(swB)swB.setAttribute("aria-checked",bgmOn?"true":"false");
  if(volEl)volEl.value=Math.round(bgmVol*100);
  if(volRow)volRow.classList.toggle("dim",!bgmOn);
  const trkSel=$("bgmTrackSel");
  if(trkSel){
    if(!trkSel.options.length) BGM_TRACKS.forEach(t=>{ const o=document.createElement("option"); o.value=t.id; o.textContent=t.name; trkSel.appendChild(o); });
    trkSel.value=bgmTrack;
  }
  const trkRow=$("bgmTrackRow"); if(trkRow)trkRow.classList.toggle("dim",!bgmOn);
  const vvEl=$("voiceVol"); if(vvEl)vvEl.value=Math.round(voiceVol*100);
}
function openSettings(){ Sound.wake(); syncSettingsUI(); $("setVeil").classList.add("show"); }
function closeSettings(){ $("setVeil").classList.remove("show"); }
function toggleFull(){
  const de=document.documentElement;
  const req=de.requestFullscreen||de.webkitRequestFullscreen;
  const exit=document.exitFullscreen||document.webkitExitFullscreen;
  const fsEl=document.fullscreenElement||document.webkitFullscreenElement;
  if(req){
    if(fsEl){ exit&&exit.call(document); } else req.call(de);
  }else{
    const standalone=("standalone" in navigator && navigator.standalone) ||
                     (matchMedia&&matchMedia("(display-mode: standalone)").matches);
    showToast(standalone?"已是全螢幕模式 👍":"iOS 請按 Safari 分享鈕 → 加入主畫面,即可全螢幕",3000);
  }
}

/* ---------- 好友互動:表情 / 罐頭句 / 語音短訊 ---------- */
const EMOTES=["👍","👎","❤️","😂","🎉","🔥","👏","😮","😢","😭","😎","🤯","🥳","🤝","🙏","💪","😡","💩"];
// 罐頭嘴砲:走機車搞笑路線(v1.40.0),與 js/game.js 那份保持同一批,兩個遊戲體驗一致
const PHRASES=["睡著了嗎 😴","阿嬤都比你快","笑死 🤣","菜就多練 💪","認真的嗎 👀","我讓你的啦~","運氣好而已","手在抖喔 🤏","再想我就叫外送了","不然你先投降?"];
// 語音短訊:只傳代號,對方播本地預錄 m4a(與 Bingo 共用同一批檔案;不含 bingo 專屬的「聽牌」)
const CLIPS=[
  { id:"howlong", label:"是要多久?",     src:"mp3/是要多久.m4a" },
  { id:"ready",   label:"啊西好了沒?",   src:"mp3/啊西好了沒.m4a" },
  { id:"hurry",   label:"快點來不及啦!", src:"mp3/快點，來不急啦.m4a" }
];
let emoteTarget="all";
function openEmote(target){
  if(!MPG.isOnline())return;
  const roster=MPG.roster();
  emoteTarget=(target && target!=="all" && roster.some(p=>p.id===target)) ? target : "all";
  buildEmoteRecipients(); buildEmoteGrid(); buildEmotePhrases(); buildVoiceClips();
  const inp=$("emoteText"); if(inp)inp.value="";
  Sound.wake();
  $("emoteVeil").classList.add("show");
}
function closeEmote(){
  const v=$("emoteVeil"); if(v)v.classList.remove("show");
  Voice.cancel(); voiceRecording=false; refreshBgmDuck();
}
function buildEmoteRecipients(){
  const box=$("emoteTo"); if(!box)return; box.innerHTML="";
  const list=[{id:"all",name:"🌐 全部人"}].concat(MPG.roster().filter(p=>!p.me).map(p=>({id:p.id,name:p.name})));
  if(!list.some(r=>r.id===emoteTarget)) emoteTarget="all";
  list.forEach(r=>{
    const b=document.createElement("button");
    b.type="button"; b.className="emote-to-btn"+(r.id===emoteTarget?" on":"");
    b.textContent=r.name;
    b.addEventListener("click",()=>{ emoteTarget=r.id; buildEmoteRecipients(); });
    box.appendChild(b);
  });
  const head=$("emoteHead");
  if(head) head.textContent = emoteTarget==="all" ? "傳給全部人" : "傳給 "+((MPG.roster().find(p=>p.id===emoteTarget)||{}).name||"");
}
function buildEmoteGrid(){
  const g=$("emoteGrid"); if(!g)return; g.innerHTML="";
  EMOTES.forEach(em=>{
    const b=document.createElement("button");
    b.type="button"; b.className="emote-btn"; b.textContent=em;
    b.addEventListener("click",()=>{ MPG.sendEmote(emoteTarget,em); closeEmote(); });
    g.appendChild(b);
  });
}
function buildEmotePhrases(){
  const g=$("emotePhrases"); if(!g)return; g.innerHTML="";
  PHRASES.forEach(tx=>{
    const b=document.createElement("button");
    b.type="button"; b.className="phrase-btn"; b.textContent=tx;
    b.addEventListener("click",()=>{ MPG.sendEmote(emoteTarget,tx,"text"); closeEmote(); });
    g.appendChild(b);
  });
}
function buildVoiceClips(){
  const g=$("emoteClips"); if(!g)return; g.innerHTML="";
  CLIPS.forEach(clip=>{
    if(clip.auto)return;
    const b=document.createElement("button");
    b.type="button"; b.className="phrase-btn clip-btn"; b.textContent="🔊 "+clip.label;
    b.addEventListener("click",()=>{
      markAudioArmed(); Sound.wake();
      MPG.sendEmote(emoteTarget,"🔊","clip",clip.id);
      closeEmote();
    });
    g.appendChild(b);
  });
}
function sendCustomText(){
  const inp=$("emoteText"); if(!inp)return;
  const tx=inp.value.trim();
  if(!tx)return;
  MPG.sendEmote(emoteTarget,tx,"text"); inp.value=""; closeEmote();
}
// 飛起的表情:起點在棋盤(或連線畫面)中央往上飄
function showEmote(emoji,caption,anchorId,kind){
  const layer=$("emoteFly"); if(!layer)return;
  let x=innerWidth/2, y=innerHeight*0.5;
  const anchor=$("gmkStage");
  if(anchor){ const g=anchor.getBoundingClientRect(); if(g.width){ x=g.left+g.width/2; y=g.top+g.height/2; } }
  x+=(Math.random()-0.5)*36;
  const el=document.createElement("div");
  el.className="emote-fly"+(kind==="text"?" is-text":"")+(kind==="voice"?" is-voice":"");
  el.style.left=x+"px"; el.style.top=y+"px";
  el.innerHTML='<span class="ef-emo">'+esc(emoji)+'</span><span class="ef-cap">'+esc(caption)+'</span>';
  layer.appendChild(el);
  setTimeout(()=>{ el.remove(); },2300);
}

/* ---------- 快速語音留言(錄音 → 送全部人) ---------- */
let voiceRecording=false, qvTick=null;
function refreshBgmDuck(){ try{ BGM.duck(voiceRecording || voiceBusy); }catch(e){} }
function eachQuickVoice(fn){ const list=document.querySelectorAll(".quick-voice"); for(let i=0;i<list.length;i++)fn(list[i]); }
function setQuickVoiceUI(o){
  eachQuickVoice(b=>{
    if(o.disabled!=null) b.disabled=o.disabled;
    if(o.rec!=null) b.classList.toggle("rec",o.rec);
    const ico=b.querySelector(".qv-ico"), lab=b.querySelector(".qv-label");
    if(ico&&o.ico!=null) ico.textContent=o.ico;
    if(lab&&o.lab!=null) lab.textContent=o.lab;
  });
}
function resetQuickVoiceBtn(){
  if(qvTick){ clearInterval(qvTick); qvTick=null; }
  setQuickVoiceUI({ rec:false, disabled:false, ico:"🎤", lab:"語音" });
}
function toggleQuickVoice(){
  if(!MPG.isOnline())return;
  if(!Voice.supported()){ showToast("此裝置/瀏覽器不支援錄音"); return; }
  if(Voice.recording()){ setQuickVoiceUI({ disabled:true, lab:"處理中…" }); Voice.stop(); return; }
  markAudioArmed(); Sound.wake(); kickVoiceQueue();
  setQuickVoiceUI({ disabled:true, lab:"準備中…" });
  voiceRecording=true; refreshBgmDuck();   // 先停背景音樂,再開麥克風(Android 通話路徑會把音樂弄難聽)
  Voice.start((wav)=>{
    voiceRecording=false; refreshBgmDuck();
    resetQuickVoiceBtn();
    if(!wav || wav.byteLength<=44){ showToast("沒有錄到聲音"); return; }
    try{
      const url=Voice.toDataURL(wav);
      if(url.length>200000){ showToast("語音太長,請再短一點"); return; }   // RTDB 友善上限
      MPG.sendEmote("all","🎤","voice",url);
      showToast("已送出語音 🎤");
    }catch(e){ showToast("語音處理失敗"); }
  }).then(()=>{
    setQuickVoiceUI({ disabled:false, rec:true, ico:"⏹" });
    let left=Math.ceil(Voice.MAX_MS/1000);
    setQuickVoiceUI({ lab:left+"s" });
    qvTick=setInterval(()=>{ left--; if(left<=0){ if(qvTick){clearInterval(qvTick);qvTick=null;} return; } setQuickVoiceUI({ lab:left+"s" }); },1000);
  }).catch(err=>{
    voiceRecording=false; refreshBgmDuck();
    resetQuickVoiceBtn();
    showToast((err&&err.name==="NotAllowedError")?"麥克風權限被拒絕":"無法啟動錄音");
  });
}

/* ---------- 收到語音的播放佇列(iOS 音訊解鎖處理照抄 Bingo) ---------- */
function fallbackAudio(u,onEnd){
  try{
    const a=new Audio(u);
    try{ a.volume=Math.max(0,Math.min(1,voiceVol)); }catch(e){}
    if(onEnd){ a.onended=onEnd; a.onerror=onEnd; }
    const p=a.play(); if(p&&p.catch)p.catch(()=>{ if(onEnd)onEnd(); });
  }catch(e){ if(onEnd)onEnd(); }
}
const clipBufCache={};
function playDecoded(c,buf,onEnd){
  try{
    const s=c.createBufferSource(); s.buffer=buf;
    const g=c.createGain(); g.gain.value=voiceVol;
    s.connect(g); g.connect(c.destination); s.onended=onEnd; s.start(); return true;
  }catch(e){ return false; }
}
function playVoiceOnce(src,onEnd){
  let called=false; const done=()=>{ if(called)return; called=true; if(onEnd)onEnd(); };
  const c=Sound.ctx&&Sound.ctx();
  if(!c){ fallbackAudio(src,done); return; }
  const isData=src.slice(0,5)==="data:";
  const start=()=>{
    if(!isData && clipBufCache[src]){ if(!playDecoded(c,clipBufCache[src],done)) fallbackAudio(src,done); return; }
    const decode=(arrbuf,cacheKey)=>{
      try{
        c.decodeAudioData(arrbuf.slice(0),
          b=>{ if(cacheKey)clipBufCache[cacheKey]=b; if(!playDecoded(c,b,done)) fallbackAudio(src,done); },
          ()=>fallbackAudio(src,done));
      }catch(e){ fallbackAudio(src,done); }
    };
    if(isData){
      let bytes;
      try{ const i=src.indexOf(","); if(i<0)throw 0; const bin=atob(src.slice(i+1)); bytes=new Uint8Array(bin.length); for(let k=0;k<bin.length;k++)bytes[k]=bin.charCodeAt(k); }
      catch(e){ fallbackAudio(src,done); return; }
      decode(bytes.buffer,null);
    }else{
      fetch(src).then(r=>{ if(!r.ok)throw 0; return r.arrayBuffer(); }).then(ab=>decode(ab,src)).catch(()=>fallbackAudio(src,done));
    }
  };
  if(c.state==="suspended") c.resume().then(start).catch(start); else start();
}
const voiceQueue=[]; let voiceBusy=false, voiceSafety=null;
const IS_TOUCH=("ontouchstart" in window) || (navigator.maxTouchPoints>0);
let audioArmed=false;
function markAudioArmed(){ audioArmed=true; }
function markAudioStale(){ audioArmed=false; }
function enqueueVoice(src){
  if(!src)return;
  if(Sound.isMuted&&Sound.isMuted())return;
  voiceQueue.push(src);
  if(!voiceBusy) pumpVoice();
}
function enqueueClip(id){
  const clip=CLIPS.find(c=>c.id===id); if(!clip)return;
  enqueueVoice(clip.src);
}
function pumpVoice(){
  if(voiceBusy)return;
  if(!voiceQueue.length){ hideVoiceGate(); refreshBgmDuck(); return; }
  // iOS 回前景後 state 常仍是 "running" 卻不出聲 → 觸控裝置額外要求「這回合手勢解鎖過」,
  // 否則不硬播也不丟棄:留在佇列裡,改顯示可點的播放膠囊
  if((IS_TOUCH && !audioArmed) || !(Sound.running && Sound.running())){ showVoiceGate(); return; }
  hideVoiceGate();
  const next=voiceQueue.shift();
  voiceBusy=true; refreshBgmDuck();
  const advance=()=>{ if(!voiceBusy)return; if(voiceSafety){ clearTimeout(voiceSafety); voiceSafety=null; } voiceBusy=false; pumpVoice(); };
  voiceSafety=setTimeout(advance,15000);
  playVoiceOnce(next,advance);
}
function showVoiceGate(){
  const g=$("voiceGate"); if(!g)return;
  const t=$("voiceGateTxt"), n=voiceQueue.length;
  if(t)t.textContent = n>1 ? ("🔊 "+n+" 則語音 · 點我播放") : "🔊 點我播放語音";
  g.classList.remove("hidden");
}
function hideVoiceGate(){ const g=$("voiceGate"); if(g)g.classList.add("hidden"); }
function playVoiceGate(){
  markAudioArmed(); Sound.wake();
  const go=()=>{ hideVoiceGate(); pumpVoice(); };
  if(Sound.resume) Sound.resume().then(go); else go();
}
function kickVoiceQueue(){ if(voiceQueue.length && !voiceBusy) pumpVoice(); }

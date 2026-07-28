"use strict";

/* ============================================================================
   共用介面工具箱(ui-kit)— 五子棋 / 數獨共用。★ Bingo(index.html)不載入這支。
   內容:toast / 結果卡開關 / 彩帶 / 主題與偏好 / 設定蓋板 / 表情面板 / 語音佇列。

   由 js/gomoku/ui.js 抽出(v1.41.1)。表情與語音那套是踩過 iOS 音訊坑修出來的,照抄未改。

   ⚠ 與遊戲的耦合只有三個點,全部走 MP(= MPCore.create() 的產物,由各遊戲的 adapter.js 建立):
     • MP.prefsKey()    遊戲專屬偏好的 localStorage key
     • MP.ownPrefs()    要存進去的內容 / MP.usePrefs(o) 讀回來套用
     • MP.emoteAnchor() 表情飛出的錨點元素 id(五子棋是棋盤舞台,數獨是盤面)
   除此之外本檔不認識任何遊戲。

   ⚠ 偏好的關鍵差異:主題/音量/暱稱與 Bingo 共用同一個 localStorage key,
     但**寫入一律 read-modify-write merge** —— 整份 JSON.stringify 覆寫會把 Bingo 的
     target / size / scoreMode 等欄位清掉。
   ========================================================================== */

/* $ 在此定義,兩個遊戲的 board.js / adapter.js / main.js 共用(ui-kit 一律最先載入)。
   ★ 各遊戲的檔案不可再宣告一次 const $ —— 同一詞法作用域重複宣告會直接 SyntaxError。 */
const $ = id => document.getElementById(id);

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
function readJSON(k){ try{ return JSON.parse(localStorage.getItem(k))||{}; }catch(e){ return {}; } }
// ★ 共用 key 一律 merge 寫回,不整份覆寫(否則會清掉 Bingo 那些本遊戲沒有的欄位)
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
  // 遊戲專屬偏好:各自的 key、各自的內容(五子棋是棋盤大小,數獨是難度/模式)
  try{
    if(typeof MP!=="undefined" && MP.prefsKey && MP.ownPrefs)
      localStorage.setItem(MP.prefsKey(), JSON.stringify(MP.ownPrefs()));
  }catch(e){}
}
function loadPrefs(){
  const p=readJSON(SHARED_KEY);
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
  if(typeof MP!=="undefined" && MP.prefsKey && MP.usePrefs) MP.usePrefs(readJSON(MP.prefsKey()));
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

/* iPhone 的 Safari 不支援 Fullscreen API,「加入主畫面」是唯一能全螢幕的路。
   上面那句提示藏在 ⛶ 鈕後面,實際上沒人會去按 → 首次進站主動講一次,按過就不再打擾。
   ⚠ js/game.js 有一份同樣的(Bingo 不載入 js/shared/,比照 toggleFull 各留一份)。 */
const PWA_TIP_KEY="bingo.pwatip";
function maybeShowInstallTip(){
  try{
    const standalone=("standalone" in navigator && navigator.standalone) ||
                     (matchMedia && matchMedia("(display-mode: standalone)").matches);
    if(standalone)return;                        // 已經是全螢幕了,不用講
    const ua=navigator.userAgent||"";
    // iPadOS 13+ 的 UA 會偽裝成 Macintosh,只能靠觸控點數認出來
    const isIOS=/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints>1);
    if(!isIOS)return;                            // 其他平台按 ⛶ 就能全螢幕,不必囉嗦
    if(localStorage.getItem(PWA_TIP_KEY)==="1")return;
    const box=document.createElement("div");
    box.className="pwa-tip";
    box.innerHTML=
      '<h4>📱 想玩得大一點?</h4>'+
      '<p>iPhone 的 Safari 沒辦法直接全螢幕。把它「加入主畫面」之後,開起來就跟 App 一樣滿版。</p>'+
      '<ol><li>按下面工具列的分享鈕 <b>⬆️</b></li><li>往下找 <b>「加入主畫面」</b></li></ol>'+
      '<button class="btn primary pwa-ok" type="button">知道了</button>';
    box.querySelector(".pwa-ok").addEventListener("click",()=>{
      try{ localStorage.setItem(PWA_TIP_KEY,"1"); }catch(e){}
      box.remove();
    });
    document.body.appendChild(box);
  }catch(e){}
}

/* ---------- 好友互動:表情 / 罐頭句 / 語音短訊 ---------- */
const EMOTES=["👍","👎","❤️","😂","🎉","🔥","👏","😮","😢","😭","😎","🤯","🥳","🤝","🙏","💪","😡","💩"];
// 罐頭嘴砲:走機車搞笑路線(v1.40.0),與 js/game.js 那份保持同一批,各遊戲體驗一致
const PHRASES=["睡著了嗎 😴","阿嬤都比你快","笑死 🤣","菜就多練 💪","認真的嗎 👀","我讓你的啦~","運氣好而已","手在抖喔 🤏","再想我就叫外送了","不然你先投降?"];
// 語音短訊:只傳代號,對方播本地預錄 m4a(與 Bingo 共用同一批檔案;不含 bingo 專屬的「聽牌」)
const CLIPS=[
  { id:"howlong", label:"是要多久?",     src:"mp3/是要多久.m4a" },
  { id:"ready",   label:"啊西好了沒?",   src:"mp3/啊西好了沒.m4a" },
  { id:"hurry",   label:"快點來不及啦!", src:"mp3/快點，來不急啦.m4a" },
  { id:"gofast",  label:"你就趕快啦!",   src:"mp3/你就趕快啦.m4a" }
];
let emoteTarget="all";
function openEmote(target){
  if(!MP.isOnline())return;
  const roster=MP.roster();
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
  const list=[{id:"all",name:"🌐 全部人"}].concat(MP.roster().filter(p=>!p.me).map(p=>({id:p.id,name:p.name})));
  if(!list.some(r=>r.id===emoteTarget)) emoteTarget="all";
  list.forEach(r=>{
    const b=document.createElement("button");
    b.type="button"; b.className="emote-to-btn"+(r.id===emoteTarget?" on":"");
    b.textContent=r.name;
    b.addEventListener("click",()=>{ emoteTarget=r.id; buildEmoteRecipients(); });
    box.appendChild(b);
  });
  const head=$("emoteHead");
  if(head) head.textContent = emoteTarget==="all" ? "傳給全部人" : "傳給 "+((MP.roster().find(p=>p.id===emoteTarget)||{}).name||"");
}
function buildEmoteGrid(){
  const g=$("emoteGrid"); if(!g)return; g.innerHTML="";
  EMOTES.forEach(em=>{
    const b=document.createElement("button");
    b.type="button"; b.className="emote-btn"; b.textContent=em;
    b.addEventListener("click",()=>{ MP.sendEmote(emoteTarget,em); closeEmote(); });
    g.appendChild(b);
  });
}
function buildEmotePhrases(){
  const g=$("emotePhrases"); if(!g)return; g.innerHTML="";
  PHRASES.forEach(tx=>{
    const b=document.createElement("button");
    b.type="button"; b.className="phrase-btn"; b.textContent=tx;
    b.addEventListener("click",()=>{ MP.sendEmote(emoteTarget,tx,"text"); closeEmote(); });
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
      MP.sendEmote(emoteTarget,"🔊","clip",clip.id);
      closeEmote();
    });
    g.appendChild(b);
  });
}
function sendCustomText(){
  const inp=$("emoteText"); if(!inp)return;
  const tx=inp.value.trim();
  if(!tx)return;
  MP.sendEmote(emoteTarget,tx,"text"); inp.value=""; closeEmote();
}
// 飛起的表情:起點在遊戲盤面中央往上飄(錨點由各遊戲的 adapter 指定)
function showEmote(emoji,caption,anchorId,kind){
  const layer=$("emoteFly"); if(!layer)return;
  let x=innerWidth/2, y=innerHeight*0.5;
  const anchor=$(MP.emoteAnchor());
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
  if(!MP.isOnline())return;
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
      MP.sendEmote("all","🎤","voice",url);
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

/* ---------- 共用啟動樣板(各遊戲 main.js 的重複部分) ---------- */
// 版號:單一來源是 <meta name="version">
function paintVersion(){
  const m=document.querySelector('meta[name="version"]'), v=m?m.content:"";
  const tv=$("topVer"); if(tv)tv.textContent=v?("v"+v):"";
  const sv=$("setVer"); if(sv)sv.textContent=v?("v"+v):"";
}
// 設定蓋板 / 表情面板 / 音訊解鎖 / SW 註冊:兩個遊戲一字不差的那些綁定
function bindCommonUI(){
  $("settingsBtn").addEventListener("click",openSettings);
  $("setClose").addEventListener("click",closeSettings);
  $("setVeil").addEventListener("click",e=>{ if(e.target===$("setVeil"))closeSettings(); });
  $("fsBtn").addEventListener("click",toggleFull);
  $("swEbook").addEventListener("click",()=>toggleEbook());
  $("swMute").addEventListener("click",()=>{ Sound.toggle(); savePrefs(); syncSettingsUI(); });
  $("swBgm").addEventListener("click",()=>setBgm(!bgmOn));
  $("bgmTrackSel").addEventListener("change",e=>setBgmTrack(e.target.value));
  $("bgmVol").addEventListener("input",e=>setBgmVol((+e.target.value||0)/100));
  $("bgmVol").addEventListener("change",savePrefs);
  $("voiceVol").addEventListener("input",e=>setVoiceVol((+e.target.value||0)/100));
  $("voiceVol").addEventListener("change",savePrefs);
  $("sfxVol").addEventListener("input",e=>setSfxVol((+e.target.value||0)/100));
  $("sfxVol").addEventListener("change",savePrefs);
  $("swVibrate").addEventListener("click",()=>setVibrate(!vibrateOn));

  $("emoteOpenBtn").addEventListener("click",()=>openEmote("all"));
  $("quickVoiceBtn").addEventListener("click",toggleQuickVoice);
  $("emoteClose").addEventListener("click",closeEmote);
  $("emoteVeil").addEventListener("pointerdown",e=>{ if(e.target===$("emoteVeil"))closeEmote(); });
  $("emoteVeil").addEventListener("touchmove",e=>{
    const card=e.target.closest?e.target.closest(".emote-card"):null;
    if(card && card.scrollHeight>card.clientHeight) return;
    e.preventDefault();
  },{passive:false});
  $("emoteSend").addEventListener("click",sendCustomText);
  $("emoteText").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); sendCustomText(); } });
  $("voiceGate").addEventListener("click",playVoiceGate);

  // 結果卡是強制回應視窗:點/滑到卡片外一律吃掉手勢(不關卡、也不讓背景捲動)
  $("veil").addEventListener("touchmove",e=>{
    const card=e.target.closest?e.target.closest(".win-card"):null;
    if(card && card.scrollHeight>card.clientHeight) return;
    e.preventDefault();
  },{passive:false});

  addEventListener("resize",()=>{ const cv=$("confetti"); if(cv&&cv.width){ cv.width=innerWidth; cv.height=innerHeight; } });
}
/* 音訊解鎖(與 Bingo 同一套:iOS 切背景會把 AudioContext 打回 suspended) */
let audioUnlocked=false;
function unlockAudioOnce(){
  markAudioArmed();
  Sound.wake();
  if(!audioUnlocked){ audioUnlocked=true; if(bgmOn)BGM.setOn(true); }
  const kick=()=>{ kickVoiceQueue(); BGM.nudge(); };
  if(Sound.resume) Sound.resume().then(kick); else kick();
}
function armAudioUnlock(){
  addEventListener("pointerdown",unlockAudioOnce,{once:true});
  addEventListener("keydown",unlockAudioOnce,{once:true});
}
function bindAudioLifecycle(){
  armAudioUnlock();
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){ markAudioStale(); BGM.setHidden(true); return; }
    BGM.setHidden(false);
    armAudioUnlock();
  });
  // 換頁(回 index.html / 按上一頁)也要停音樂:Safari 換頁不發 visibilitychange,
  // 舊頁進 bfcache 還在放、新頁又開一首 → 背景音樂疊起來(v1.40.0)。與 js/main.js 同一套。
  addEventListener("pagehide",()=>{ markAudioStale(); BGM.setHidden(true); });
  addEventListener("pageshow",e=>{ if(!e.persisted)return; BGM.setHidden(false); armAudioUnlock(); });
}
function registerSW(){
  if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost" || location.hostname==="127.0.0.1")){
    addEventListener("load",()=>{ navigator.serviceWorker.register("sw.js").catch(()=>{}); });
  }
}

/* ---------- 更新檢查(v1.48.0) ----------
   要解決的事:手機分頁常一整天不關(PWA 更是如此),程式已經上了新版,現場玩的人卻還跑著舊 JS。
   sw.js 是 network-first,只要「重新載入」就會拿到最新版 —— 難的是沒有人會主動去重載。
   做法:每 5 分鐘用 no-store 抓自己這一頁的 HTML,比對 <meta name="version">
        (版號的單一來源就是那個 meta,不必再多一個 version.json 要記得改)。
   抓到不一樣的版號 → 安全的時候自動重載;正在對戰/單機局中就先記著,等回到選單那一刻再套用,
   絕不把人踢出局。safeFn 由各遊戲的 main.js 提供(什麼叫「安全」只有遊戲自己知道)。
   ★ Bingo(index.html)不載入本檔,同一套邏輯在 js/main.js 另有一份 —— 改一邊記得改另一邊。 */
const UPD_CHECK_MS=5*60*1000;     // 兩次連線檢查的最小間隔
const UPD_TICK_MS=4000;           // 心跳:也負責「pending 等到安全就套用」,所以要比檢查間隔密
const UPD_FROM_KEY="bingo.updfrom";
let updCur="", updSafe=null, updPending="", updLastAt=0, updGoing=false;
function initUpdateCheck(safeFn){
  const m=document.querySelector('meta[name="version"]');
  updCur=m?m.content:"";
  if(!updCur || location.protocol==="file:")return;   // 沒版號、或本機用 file:// 開(fetch 一定失敗)就不啟用
  updSafe=safeFn||(()=>true);
  // 上一輪是為了更新而重載的話,回報結果。版號沒變 = 這次更新沒生效(CDN 還沒同步之類),
  // 本次瀏覽就整個停掉檢查 —— 否則每 5 分鐘重載一次會變成無限重載。
  let stuck=false;
  try{
    const from=sessionStorage.getItem(UPD_FROM_KEY);
    if(from){
      sessionStorage.removeItem(UPD_FROM_KEY);
      if(from!==updCur) setTimeout(()=>showToast("已更新到 v"+updCur+" 🎉",2200),1200);
      else stuck=true;
    }
  }catch(_){}
  if(stuck)return;
  updLastAt=Date.now();                              // 這頁剛載入本身就是最新的,第一次檢查等一個週期後
  addEventListener("online",()=>{ updLastAt=0; });   // 離線時開的是快取版,一連上網就馬上查
  setInterval(updTick,UPD_TICK_MS);
}
function updTick(){
  if(updGoing)return;
  if(updPending){ if(updSafe()) updApply(); return; }   // 有新版在等 → 只等「安全」這件事
  if(document.hidden || navigator.onLine===false)return;
  if(Date.now()-updLastAt < UPD_CHECK_MS)return;
  updLastAt=Date.now();
  fetch(location.pathname,{cache:"no-store"})            // 只抓自己這頁;no-store 繞過 HTTP 快取
    .then(r=>r.ok?r.text():"")
    .then(html=>{
      const mm=html.match(/<meta\s+name="version"\s+content="([^"]+)"/i), v=mm?mm[1]:"";
      if(!v || v===updCur)return;
      updPending=v;                                      // 只要不同就算有更新(含刻意回退舊版)
      if(!updSafe()) showToast("有新版本 v"+v+",這局結束後會自動更新",2600);
    })
    .catch(()=>{});                                      // 抓失敗(沒網路 / 伺服器暫時掛):安靜跳過,下個週期再試
}
function updApply(){
  if(updGoing)return;
  updGoing=true;
  showToast("發現新版本 v"+updPending+",正在更新…",1600);
  setTimeout(()=>{
    if(!updSafe()){ updGoing=false; return; }             // 這 1 秒內又進房 / 開了新局 → 取消,等下個安全時機
    let done=false;
    const go=()=>{
      if(done)return; done=true;
      try{ sessionStorage.setItem(UPD_FROM_KEY,updCur); }catch(_){}   // 記下舊版號,重載後用來確認真的換版了
      location.reload();
    };
    setTimeout(go,2500);                                  // 保險:SW 沒回應也照樣重載
    // 先讓 SW 抓新的 sw.js(新版 install 會 skipWaiting 並清掉舊快取),再重載
    if(navigator.serviceWorker && navigator.serviceWorker.getRegistration){
      navigator.serviceWorker.getRegistration().then(r=>r?r.update():null).then(go).catch(go);
    }else go();
  },1100);
}

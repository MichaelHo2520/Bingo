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

/* ---------- 結果卡 ----------
   ★ body.peeking(v1.58.4):偷看牌面時,「🏆 看結果」那顆鈕浮在畫面正下方中央,
     而麻將的手牌就在那裡 —— 這個 class 讓 CSS 把那一條的高度留出來(見 styles.css)。
     盤面各自有 ResizeObserver,版面變矮會自己重新 fit。
   ⚠ 這三支在 js/game.js 還有一份(Bingo 不載入 js/shared/)—— 改一邊記得改另一邊。 */
function showResult(){ $("reopenWin").classList.add("hidden"); $("veil").classList.add("show"); document.body.classList.remove("peeking"); }
function closeWin(){ $("veil").classList.remove("show"); $("reopenWin").classList.add("hidden"); document.body.classList.remove("peeking"); }
function peekBoard(){ $("veil").classList.remove("show"); $("reopenWin").classList.remove("hidden"); document.body.classList.add("peeking"); }

/* ---------- 彩帶 ---------- */
function burst(){
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
const THEME_NAMES={sunset:"落日",midnight:"午夜霓虹",bubblegum:"泡泡糖",meadow:"草原",arcade:"街機"};
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
  document.documentElement.setAttribute("data-theme",name);
  lastColorTheme=name; savePrefs(); syncSettingsUI();
}
function setBgm(on){ bgmOn=!!on; if(bgmOn){ Sound.wake(); BGM.setOn(true); } else BGM.setOn(false); savePrefs(); syncSettingsUI(); }
function setBgmVol(v){ bgmVol=Math.max(0,Math.min(1,v)); BGM.setVolume(bgmVol); }
function setBgmTrack(id){ if(!BGM_TRACKS.some(t=>t.id===id))return; bgmTrack=id; BGM.setSrc(bgmSrcOf(id)); savePrefs(); syncSettingsUI(); }
function setVoiceVol(v){ voiceVol=Math.max(0,Math.min(3,v)); }
function setSfxVol(v){ sfxVol=Math.max(0,Math.min(1,v)); Sound.setVolume(sfxVol); }
function setVibrate(on){ vibrateOn=!!on; savePrefs(); syncSettingsUI(); }
function syncSettingsUI(){
  const swM=$("swMute"), sw=$("swatches");
  if(swM)swM.setAttribute("aria-checked",Sound.isMuted()?"false":"true");
  const sfxEl=$("sfxVol"), sfxRow=$("sfxVolRow");
  if(sfxEl)sfxEl.value=Math.round(sfxVol*100);
  if(sfxRow)sfxRow.classList.toggle("dim",Sound.isMuted());
  const swV=$("swVibrate"); if(swV)swV.setAttribute("aria-checked",vibrateOn?"true":"false");
  if(sw){
    const active=document.documentElement.getAttribute("data-theme");
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
/* ---------- 返回鍵守衛(v1.75.13) ----------
   手機的返回鍵 = history.back(),而網頁**沒有**「攔住返回鍵」這種 API。連線中誤按一下的代價
   最大:訪客這局不算成績,房主更是整間房直接關掉、全部人一起被踢。唯一可行的做法是
   **先在歷史裡墊一筆**:進房時 pushState 一筆守衛,返回鍵於是走到那一筆(同文件、不換頁)→
   收到 popstate 就跳確認卡。
   ⚠ 四個坑:
     1. pushState **不可以帶 url** —— 帶了就是「改網址」,file:// 直接 SecurityError(origin 是
        "null"),而在外殼(app.html)裡帶 hash 還會踩到它的 hashchange 監聽。不帶 url 就只多一筆歷史。
     2. 攔到之後要**立刻再墊回去**,否則第二下返回就真的走掉了。
     3. 確認要離開時,墊的那一筆還在歷史裡 → 自己 history.back() 吃掉(bgEat 讓那一發 popstate
        不算使用者按的),否則使用者得多按一次返回才回得到首頁。
     4. arm 必須**冪等**:進房 → 開局 → 回大廳 → 再開局全都在同一筆守衛底下;一個相位墊一筆的話
        返回鍵要按好幾下才有反應。
   ★ 這一組在 js/game.js 另有一份(Bingo 不載入本檔)—— 改一邊記得改另一邊。 */
let bgArmed=false, bgAct=null, bgEat=false, bgBound=false;
function armBackGuard(act){
  bgAct=act||null;
  if(!bgBound){ bgBound=true; addEventListener("popstate",onBackGuard); }
  if(bgArmed)return;
  try{ history.pushState({bingoGuard:1},""); bgArmed=true; }catch(e){}
}
function onBackGuard(){
  if(bgEat){ bgEat=false; return; }   // 這一發是 disarm 自己吃掉守衛時發出來的,不是使用者按的
  if(!bgArmed)return;                 // 沒在守 → 讓瀏覽器照常返回(選單畫面按返回就該回上一頁)
  bgArmed=false;                      // 墊的那一筆已經被這一下返回消耗掉
  const act=bgAct;
  armBackGuard(act);                  // 立刻補一筆,下一下返回照樣攔得到
  if(act)act();
}
function disarmBackGuard(){
  bgAct=null;
  if(!bgArmed)return;
  bgArmed=false; bgEat=true;
  try{ history.back(); }catch(e){ bgEat=false; }
}
/* 返回鍵先關掉最上層的浮層(手機上的直覺),沒有浮層開著才回傳 false 交給呼叫端處理。
   ⚠ 結果卡(#veil)刻意不列 —— 它是強制回應視窗,要離開只能按卡片上的按鈕(見各頁 main.js)。
     順序 = 疊在上面的先關;這一頁沒有的 id(投降只有五子棋、猜拳只有 Bingo)自動跳過。 */
const BACK_LAYERS=[["myVoiceVeil",()=>closeMyVoice()],["setVeil",()=>closeSettings()],
                   ["emoteVeil",()=>closeEmote()],["kickVeil",()=>MP.cancelKick()],
                   // ★ 伺服器狀態隱藏面板(js/home-live.js 檔尾,點 7 下首頁「派對遊戲」開)。
                   //   只有 index.html 有這個 id(home-live.js 只有 Bingo 載入),其他九頁自動跳過。
                   ["svVeil",()=>HomeLive.closeStatusPanel()],
                   // ★ 21 點的房規蓋板(v1.84.0)。只有 blackjack.html 有這個 id,
                   //   其他六頁自動跳過(見上面那條註解)—— 漏掉的話按返回會跳成「離開房間?」
                   ["bjRulesVeil",()=>closeRules()],
                   /* ★ UNO 的兩個蓋板(v1.106.0)。只有 uno.html 有這兩個 id,其他八頁自動跳過。
                      ⚠ 選色盤要排在**房規前面**:它是「出了 Wild 正在等你選顏色」的強制層,
                        兩個同時開著的時候先關它。關掉 = 那一手 Wild 取消(牌回到手上)——
                        安全,因為顏色還沒選就不會送進 moves。 */
                   ["unColorVeil",()=>UNB.closeColor()],["unRulesVeil",()=>closeRules()],
                   // ★ 暗棋的房規蓋板(v1.113.0)。只有 darkchess.html 有這個 id,其他九頁自動跳過。
                   ["dcRulesVeil",()=>closeRules()],
                   ["resignVeil",()=>MP.cancelResign()],["leaveVeil",()=>MP.cancelLeave()]];
function dismissTopLayer(){
  for(let i=0;i<BACK_LAYERS.length;i++){
    const el=$(BACK_LAYERS[i][0]);
    if(el&&el.classList.contains("show")){ BACK_LAYERS[i][1](); return true; }
  }
  return false;
}
/* ---------- 全螢幕(v1.50.0:外殼架構) ----------
   Fullscreen API 綁在 document 上,**換頁瀏覽器一定收掉全螢幕**,而重進全螢幕一定要使用者手勢
   (實測:換頁後立刻 requestFullscreen 會 REJECT "Permissions check failed",連「使用者是點連結
   才換頁的」都不算數)。所以正常情況下這一頁跑在 app.html 的 iframe 裡:**全螢幕掛在外殼身上**,
   換遊戲只是換 iframe 的 src,外層動都不動 → 全程不掉。這裡只負責把 ⛶ 轉給外殼。

   沒被外殼包住時(直接開這一頁、file:// 本機開、e2e 測試頁)才走下面本地那一套:
   意願記在 sessionStorage,新頁第一個真實手勢再接回(v1.49.1 的做法,退而求其次)。

   ★ 這一整組在 js/game.js 另有一份(Bingo 不載入本檔,比照 toggleFull 各留一份)—— 改一邊記得改另一邊。 */
const FS_KEY="bingo.fs";
const framed=(()=>{ try{ return window.top!==window.self; }catch(e){ return true; } })();
// file:// 的 origin 是 "null",postMessage 不能拿它當 targetOrigin;外殼那邊改用 e.source 驗身分
const SHELL_TO=(location.origin && location.origin!=="null") ? location.origin : "*";
let shellEnv=null;     // 外殼回報的環境(支不支援全螢幕 / 是不是 standalone);iframe 裡自己測不準
let fsLeaving=false;   // 換頁中:此時的 fullscreenchange 是瀏覽器收掉的,不代表使用者不想要了
function fsEl(){ return document.fullscreenElement||document.webkitFullscreenElement; }
function fsSupported(){ const de=document.documentElement; return !!(de.requestFullscreen||de.webkitRequestFullscreen); }
function fsWant(){ try{ return sessionStorage.getItem(FS_KEY)==="1"; }catch(e){ return false; } }
function setFsWant(on){ try{ if(on)sessionStorage.setItem(FS_KEY,"1"); else sessionStorage.removeItem(FS_KEY); }catch(e){} }
function fsRequest(){
  const de=document.documentElement, req=de.requestFullscreen||de.webkitRequestFullscreen;
  if(!req)return null;
  try{ return req.call(de); }catch(e){ return null; }
}
// 這一頁是哪一個遊戲(外殼用它更新 hash,做深層連結)。從檔名判斷,測試頁 t-gomoku-*.html 也認得。
function fsPageKey(){
  const f=(location.pathname.split("/").pop()||"").toLowerCase();
  return f.indexOf("gomoku")>=0 ? "gomoku" : (f.indexOf("sudoku")>=0 ? "sudoku" : "bingo");
}
function shellMsg(act){
  try{ parent.postMessage({ t:"bingo.fs", act:act, page:fsPageKey() }, SHELL_TO); }catch(e){}
}
// 是不是已經滿版(iOS standalone / 桌機 app 視窗)。在 iframe 裡 navigator.standalone 測不準,以外殼回報為準。
function fsStandalone(){
  if(framed) return shellEnv ? !!shellEnv.standalone : true;   // 外殼還沒回報就當作已滿版,寧可不囉嗦
  return ("standalone" in navigator && navigator.standalone) ||
         (matchMedia&&matchMedia("(display-mode: standalone)").matches);
}
function fsFallbackTip(){
  showToast(fsStandalone()?"已是全螢幕模式 👍":"iOS 請按 Safari 分享鈕 → 加入主畫面,即可全螢幕",3000);
}
function toggleFull(){
  if(framed){ shellMsg("toggle"); return; }   // 外殼代勞;它不支援時會回 unsupported,那時才跳提示
  const exit=document.exitFullscreen||document.webkitExitFullscreen;
  if(fsSupported()){
    if(fsEl()){ setFsWant(false); exit&&exit.call(document); }
    else{
      setFsWant(true);
      const p=fsRequest();
      if(p&&p.catch)p.catch(()=>setFsWant(false));   // 這一次就被拒:別把意願留著騷擾之後每一頁
    }
  }else fsFallbackTip();
}
/* 掛「下一個手勢就接回全螢幕」。用 click(冒泡到 window)而不是 pointerdown:
   按下去就切全螢幕會在 pointerdown/pointerup 之間改變版面,那一下的 click 可能就飛掉了。
   點到 <a href>(回主選單)或正在輸入框打字則跳過並繼續等 ——
   前者進了全螢幕馬上又要換頁只會閃一下,後者打到一半版面亂跳很煩。
   有外殼時這一下手勢是給外殼用的(外殼被 F5 重載過才需要接回,它自己判斷)。 */
let fsArmed=null;
function armFsRestore(){
  if(fsArmed)return;
  if(!framed && (!fsWant() || fsEl() || !fsSupported()))return;
  fsArmed=e=>{
    const t=e&&e.target;
    if(t&&t.closest&&t.closest("a[href],input,textarea,select"))return;   // 這一下不算,留著等下一次
    disarmFsRestore();
    if(framed){ shellMsg("gesture"); return; }
    if(!fsWant() || fsEl())return;
    fsRequest();   // 被拒就安靜算了(每頁只試這一次,不會纏著使用者)
  };
  addEventListener("click",fsArmed);
  addEventListener("keydown",fsArmed);
}
function disarmFsRestore(){
  if(!fsArmed)return;
  removeEventListener("click",fsArmed);
  removeEventListener("keydown",fsArmed);
  fsArmed=null;
}
function initFullscreenKeep(){
  if(framed){
    addEventListener("message",e=>{
      if(e.source!==parent)return;
      const d=e.data; if(!d||d.t!=="bingo.shell")return;
      if(d.act==="env"||d.act==="unsupported") shellEnv={ fsSupported:!!d.fsSupported, standalone:!!d.standalone };
      if(d.act==="unsupported") fsFallbackTip();   // 外殼也進不了全螢幕(iPhone Safari)→ 引導加到主畫面
    });
    shellMsg("hello");   // 回報自己是哪一頁,順便換回外殼的 env
    armFsRestore();
    return;
  }
  const sync=()=>{ if(!fsLeaving) setFsWant(!!fsEl()); };   // 使用者自己按 Esc 退出 → 意願跟著關掉
  document.addEventListener("fullscreenchange",sync);
  document.addEventListener("webkitfullscreenchange",sync);
  addEventListener("pagehide",()=>{ fsLeaving=true; });
  addEventListener("pageshow",e=>{ fsLeaving=false; if(e.persisted)armFsRestore(); });   // 上一頁回來(bfcache)也要接回去
  armFsRestore();
}

/* iPhone 的 Safari 不支援 Fullscreen API,「加入主畫面」是唯一能全螢幕的路。
   上面那句提示藏在 ⛶ 鈕後面,實際上沒人會去按 → 首次進站主動講一次,按過就不再打擾。
   ⚠ js/game.js 有一份同樣的(Bingo 不載入 js/shared/,比照 toggleFull 各留一份)。 */
const PWA_TIP_KEY="bingo.pwatip";
function maybeShowInstallTip(){
  try{
    if(fsStandalone())return;                    // 已經是全螢幕了,不用講(在 iframe 裡以外殼回報的為準)
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
const PHRASES=["睡著了嗎 😴","阿嬤都比你快","笑死 🤣","菜就多練 💪","我讓你的啦~","運氣好而已","手在抖喔 🤏","不然你先投降?"];
// 語音短訊:只傳代號,對方播本地預錄 m4a(與 Bingo 共用同一批檔案;不含 bingo 專屬的「聽牌」)
const CLIPS=[
  { id:"howlong", label:"是要多久",     src:"mp3/是要多久.m4a" },
  { id:"ready",   label:"啊西好了沒",   src:"mp3/啊西好了沒.m4a" },
  { id:"hurry",   label:"快點來不及啦", src:"mp3/快點，來不急啦.m4a" },
  { id:"gofast",  label:"你就趕快啦",   src:"mp3/你就趕快啦.m4a" },
  { id:"crying",  label:"你是在哭喔",   src:"mp3/你是在哭喔.m4a" },
  { id:"verify",  label:"我要驗牌",     src:"mp3/我要驗牌.m4a" },
  { id:"fine",    label:"牌沒問題",     src:"mp3/牌沒問題.m4a" },
  { id:"rude",    label:"沒禮貌",       src:"mp3/沒禮貌.m4a" },
];
/* ---------- 罐頭面板拖曳排序(v1.128.0,觸發方式 v1.128.x 改成按住不放) ----------
   使用者:「語音罐頭 / emoji 想要自己拖曳排序」。四個罐頭區塊(表情 / 一句話 / 內建語音 / 我的語音)
   都能直接用手指拖曳調順序,不必另外進「編輯模式」。

   ⚠⚠ v1.128.0 原本是照抄 js/big2/board.js 排手牌那套「位移量分辨拖曳」(移動超過門檻
      就算拖曳)。但這個面板本身**卡在會上下捲動的卡片裡**,大老二的手牌不必兼顧這件事
      (拖不拖得動都不影響 .b2-stage 這個捲動容器,靠縫隙照樣捲得動)。使用者實測回報:
      「上下滑動的時候不小心就拉到了物件」—— 按鈕原本設了 touch-action:none(單純位移
      判斷的必要條件),等於手指一碰到按鈕移動就直接判定成拖曳,原生捲動完全沒機會贏。
   ★ 改成**按住不放一段時間(PD_HOLD_MS)才解鎖拖曳資格**;解鎖前位移超過 PD_HOLD_TOL
     就當作「其實是想捲動」,直接放棄這次候選、不吃掉手勢。同時把 touch-action:none 從
     按鈕上拿掉(styles.css),讓等待期間瀏覽器原生的上下捲動搶得到這個手勢 ——
     快速滑一下的捲動,位移在等到 PD_HOLD_MS 之前就已經超過 PD_HOLD_TOL,永遠不會被
     判定成拖曳;真的按著不太動一下子才開始移動,才會觸發拖曳。
   ⚠ setPointerCapture **延到解鎖那一刻才做**(不是 pointerdown 當下就搶):搶太早,
     瀏覽器連判斷「這其實是原生捲動」的機會都沒有,等待期間就失去意義了。

   手法照抄 js/big2/board.js 排手牌那套的其餘部分(那裡踩過的坑照樣會踩到,細節見它的第八節):
     · 拖曳中用 insertBefore 搬動被捕獲的元素,WebKit / Blink 都會因此觸發
       lostpointercapture,必須判斷「節點還在不在面板裡」而不是當成手勢中斷,
       否則排序活不過第一次換位(按鈕會彈回原位)。
     · move / up / cancel 一律掛在 window,不是掛在個別區塊,才不受「捕獲元素被誰收著」影響。
     · 換位一律 insertBefore,排版交給 grid / flex 自己算,不自己量座標。
   ⚠ js/game.js 有另一份(Bingo 不載入 js/shared/)—— 改一邊要改另一邊。
   ⚠⚠ 這裡的識別字都加了 pd 前綴(而不是照抄 drag/DRAG_SLOP/applyOrder)——
      本檔與五子棋/數獨/mahjong16/大老二等九個遊戲共用同一份全域作用域,
      而 mahjong16/board.js、big2/board.js 已經各自宣告了 DRAG_SLOP 與 applyOrder,
      同名會直接 SyntaxError 炸掉那幾頁。
   ⚠ 這裡的順序**要存檔**,跟大老二排手牌「純顯示、不持久化」的前提不同 ——
     EMOTES / PHRASES / CLIPS 存進 bingo.prefs.v1(小陣列,走既有的 saveShared merge,
     九個遊戲共用同一份順序,體驗一致);我的語音本身就是有序陣列,拖曳直接改
     myClips 順序後 saveMyClips,不必另外存一份 order。 */
function orderByKey(defaults, saved, keyFn){
  keyFn = keyFn || (x=>x);
  if(!Array.isArray(saved) || !saved.length) return defaults.slice();
  const by=new Map(defaults.map(d=>[keyFn(d),d]));
  const out=[];
  saved.forEach(k=>{ const d=by.get(k); if(d){ out.push(d); by.delete(k); } });
  by.forEach(d=>out.push(d));   // 使用者存的順序裡沒有的(新加的預設項目)接在後面
  return out;
}
const PD_BOXES="#emoteGrid,#emotePhrases,#emoteClips,#emoteMyClips";
const PD_HOLD_MS=300;   // 按住不放這麼久才解鎖拖曳資格(太短擋不住快速滑動,太長按起來會覺得卡)
const PD_HOLD_TOL=6;    // 解鎖前位移超過這麼多 px 就當作想捲動,放棄這次拖曳候選
let pdDrag=null, pdSuppressClick=false;
function pdItems(box){ return Array.from(box.children).filter(el=>el.tagName==="BUTTON"); }
function pdDropAt(x,y){
  const kids=pdItems(pdDrag.box);
  for(const el of kids){
    if(el===pdDrag.el)continue;
    const r=el.getBoundingClientRect();
    if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom) return { el:el, before:(x<r.left+r.width/2) };
  }
  return null;
}
function pdSlotRect(el){ const t=el.style.transform; el.style.transform=""; const r=el.getBoundingClientRect(); el.style.transform=t; return r; }
function pdFollow(x,y){
  const r=pdSlotRect(pdDrag.el), cb=pdDrag.box.getBoundingClientRect();
  const nx=Math.max(cb.left,Math.min(x-pdDrag.gx,cb.right-r.width));
  const ny=Math.max(cb.top,Math.min(y-pdDrag.gy,cb.bottom-r.height));
  pdDrag.el.style.transform="translate("+(nx-r.left)+"px,"+(ny-r.top)+"px)";
}
function pdSaveOrder(box){
  const items=pdItems(box);
  if(box.id==="emoteGrid") saveShared({ emoteOrder: items.map(b=>b.textContent) });
  else if(box.id==="emotePhrases") saveShared({ phraseOrder: items.map(b=>b.textContent) });
  else if(box.id==="emoteClips") saveShared({ clipOrder: items.map(b=>b.dataset.clipId) });
  else if(box.id==="emoteMyClips"){
    const byId=new Map(myClips.map(c=>[c.id,c]));
    const next=items.map(b=>byId.get(b.dataset.clipId)).filter(Boolean);
    if(next.length===myClips.length){ myClips=next; if(!saveMyClips(myClips)) showToast("排序存不進去,本機空間不足"); }
  }
}
// 按住滿 PD_HOLD_MS(而且期間位移沒超過 PD_HOLD_TOL)才會叫到這裡:正式解鎖拖曳。
function pdArm(){
  if(!pdDrag)return;
  pdDrag.holdT=null; pdDrag.on=true;
  pdDrag.el.classList.add("pd-drag");
  try{ pdDrag.el.setPointerCapture(pdDrag.id); }catch(err){}
  pdFollow(pdDrag.x0,pdDrag.y0);   // 解鎖當下就先套一次 inline transform(即使手指還沒移動),提供「拿起來了」的即時視覺回饋
  if(typeof vibrateOn!=="undefined" && vibrateOn && navigator.vibrate){ try{ navigator.vibrate(12); }catch(e){} }
}
function pdEndDrag(root,cancel){
  if(!pdDrag)return;
  const d=pdDrag; pdDrag=null;
  if(d.holdT) clearTimeout(d.holdT);
  if(!d.on)return;   // 還沒解鎖(仍在等按住不放)就放手/中斷 → 什麼都沒發生,照一般點擊處理
  d.el.classList.remove("pd-drag"); d.el.style.transform="";
  try{ d.el.releasePointerCapture(d.id); }catch(e){}
  if(!cancel && root.contains(d.el)){ pdSuppressClick=true; pdSaveOrder(d.box); }
}
function bindEmoteDrag(){
  const root=$("emoteVeil"); if(!root || root.dataset.dragBound)return;
  root.dataset.dragBound="1";
  root.addEventListener("pointerdown",e=>{
    if(pdDrag || e.button>0)return;
    const box=e.target.closest(PD_BOXES); if(!box)return;
    const el=e.target.closest("button"); if(!el || el.parentElement!==box)return;
    const r=el.getBoundingClientRect();
    pdDrag={ id:e.pointerId, el:el, box:box, x0:e.clientX, y0:e.clientY,
             gx:e.clientX-r.left, gy:e.clientY-r.top, on:false, holdT:null };
    pdDrag.holdT=setTimeout(pdArm, PD_HOLD_MS);
  });
  addEventListener("pointermove",e=>{
    if(!pdDrag || e.pointerId!==pdDrag.id)return;
    if(!pdDrag.on){
      if(Math.hypot(e.clientX-pdDrag.x0,e.clientY-pdDrag.y0)>PD_HOLD_TOL){
        clearTimeout(pdDrag.holdT); pdDrag=null;   // 解鎖前位移太多 → 當成想捲動,交還給瀏覽器
      }
      return;
    }
    if(!root.contains(pdDrag.el)){ pdEndDrag(root,true); return; }
    const t=pdDropAt(e.clientX,e.clientY);
    if(t) pdDrag.box.insertBefore(pdDrag.el, t.before?t.el:t.el.nextSibling);
    pdFollow(e.clientX,e.clientY);
  });
  addEventListener("pointerup",e=>{ if(pdDrag && e.pointerId===pdDrag.id) pdEndDrag(root,false); });
  addEventListener("pointercancel",e=>{ if(pdDrag && e.pointerId===pdDrag.id) pdEndDrag(root,true); });
  root.addEventListener("lostpointercapture",e=>{
    if(!pdDrag || e.pointerId!==pdDrag.id)return;
    if(root.contains(pdDrag.el))return;
    pdEndDrag(root,true);
  });
}

let emoteTarget="all";
function openEmote(target){
  if(!MP.isOnline())return;
  const roster=MP.roster();
  emoteTarget=(target && target!=="all" && roster.some(p=>p.id===target)) ? target : "all";
  bindEmoteDrag();
  buildEmoteRecipients(); buildEmoteGrid(); buildEmotePhrases(); buildVoiceClips(); buildMyClips();
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
  orderByKey(EMOTES, readJSON(SHARED_KEY).emoteOrder).forEach(em=>{
    const b=document.createElement("button");
    b.type="button"; b.className="emote-btn"; b.textContent=em;
    b.addEventListener("click",()=>{
      if(pdSuppressClick){ pdSuppressClick=false; return; }   // 剛拖完的放手不算送出
      MP.sendEmote(emoteTarget,em); closeEmote();
    });
    g.appendChild(b);
  });
}
function buildEmotePhrases(){
  const g=$("emotePhrases"); if(!g)return; g.innerHTML="";
  orderByKey(PHRASES, readJSON(SHARED_KEY).phraseOrder).forEach(tx=>{
    const b=document.createElement("button");
    b.type="button"; b.className="phrase-btn"; b.textContent=tx;
    b.addEventListener("click",()=>{
      if(pdSuppressClick){ pdSuppressClick=false; return; }
      MP.sendEmote(emoteTarget,tx,"text"); closeEmote();
    });
    g.appendChild(b);
  });
}
function buildVoiceClips(){
  const g=$("emoteClips"); if(!g)return; g.innerHTML="";
  orderByKey(CLIPS.filter(c=>!c.auto), readJSON(SHARED_KEY).clipOrder, c=>c.id).forEach(clip=>{
    const b=document.createElement("button");
    b.type="button"; b.className="phrase-btn clip-btn"; b.textContent="🔊 "+clip.label;
    b.dataset.clipId=clip.id;
    b.addEventListener("click",()=>{
      if(pdSuppressClick){ pdSuppressClick=false; return; }
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
/* 飛起的表情:起點在遊戲盤面中央往上飄(錨點由各遊戲的 adapter 指定)
   ★ v1.67.0 錯開:原本只有 ±18px 隨機抖動,而底下那顆「阿明 → 全部人」膠囊常常 150px 以上,
     人多一起按就全部疊在同一點、走同一條軌跡 → 看不清。改成四件事一起做:
       ① 輪替發位:畫面切成 EF_LANES 個發位,每則挑「最久沒被用到」的那個
          → 還在飛的一定不會落在同一條;越往上飄越往外側漂(--ef-dx),不會在上方交錯
       ② 時間錯開:每則至少間隔 EF_GAP 才起飛,同一批進來的變成一串泡泡
          ⚠ 一定要靠**延後 append** 而不是 animation-delay —— 電子書模式是
            `animation:none!important`,那時 delay 完全不生效,排隊中的全部會提前現形在起點
       ③ 同時上限 EF_MAX 則,超出的排隊等前面飄走;隊伍上限 EF_QMAX,再多就丟最舊的
          (有人狂按時不要積壓成幾十秒的慢動作)
       ④ 併發縮小:含自己 ≥ EF_SMALL 則時整則縮一號(.ef-sm)。只影響**新的**那則 ——
          回頭改已經在飛的會看到「飛到一半忽然縮一下」
     另外同一個人連發沿用他上次的發位往上串(位置穩定不亂跳,而且看得出是同一個人在按)。
   ⚠ EF_POS 的順序是**中央 → 左 → 右 → 更左 → 更右**,不是由左到右排:
     最常見的情況是「只有一個人按」,那一則必須落在盤面正中央(= 改動前的位置),
     不然平常玩就會看到表情莫名固定跑到畫面最左邊,只有人多時才正常。
   ⚠ 發位數必須 ≥ 同時上限(EF_POS.length >= EF_MAX),否則額滿時一定有兩則落在同一條。
   ⚠ 只錯開 x 不夠:emoji 只有 46px,分開很容易,但底下那顆膠囊有 140px 上下(長暱稱更寬),
     五條並排在手機上一定橫向相撞 → 每個發位再配一個**固定的垂直偏移** EF_DY,
     不必犧牲同時則數就能錯開(膠囊高約 18px,差 24 再扣掉 ±5 的抖動也還夠)。
     ⚠ EF_DY 必須**兩兩**都差 ≥24,不可以只保證「按 x 排序後相鄰的那幾對」——
       下面的夾回畫面內會把最外側兩條**拉近中央**,所以「這兩條 x 差得遠所以可以同高」
       這個假設會破功(第一版寫成 0/24/24/0/0,長暱稱時最外側被夾到離中央只剩 73px,dy=0 → 疊住)。
   ⚠ 「同時幾則」一律問 DOM(efCount)而不是自己記數器:計數器一旦與實際子元素脫節
     (例如哪天有人清空這一層)就會永遠判定額滿,表情從此再也不出現。
   ⚠ js/game.js 有另一份一樣的(Bingo 不載入 js/shared/) —— 改一邊要改另一邊(grep showEmote) */
const EF_POS=[0,-.5,.5,-1,1], EF_DY=[0,24,48,-24,-48], EF_LANES=EF_POS.length,
      EF_GAP=150, EF_MAX=5, EF_QMAX=10, EF_SMALL=4;
const efLaneAt=[], efLaneBy=[];
let efQ=[], efPumpT=null, efNextAt=0;
function efCount(){ const l=$("emoteFly"); return l?l.children.length:0; }
function showEmote(emoji,caption,who,kind){
  if(!$("emoteFly"))return;
  efQ.push({ emoji:emoji, caption:caption, who:who||"", kind:kind });
  while(efQ.length>EF_QMAX) efQ.shift();
  efPump();
}
function efPump(){
  if(efPumpT||!efQ.length||efCount()>=EF_MAX)return;   // 額滿就不排 timer(免得空轉),等元素飄走時的回呼再叫一次
  efPumpT=setTimeout(()=>{
    efPumpT=null;
    if(efCount()<EF_MAX&&efQ.length) efFly(efQ.shift());
    efPump();
  }, Math.max(0,efNextAt-Date.now()));
}
// 挑發位:同一個人 2.6 秒內連發沿用他上次那條,否則挑最久沒被用到的
function efLane(who){
  const now=Date.now();
  if(who) for(let i=0;i<EF_LANES;i++) if(efLaneBy[i]===who && now-(efLaneAt[i]||0)<2600) return i;
  let pick=0;
  for(let i=1;i<EF_LANES;i++) if((efLaneAt[i]||0)<(efLaneAt[pick]||0)) pick=i;
  return pick;
}
function efFly(m){
  const layer=$("emoteFly"); if(!layer)return;
  let cx=innerWidth/2, cy=innerHeight*0.5, bw=0;
  const anchor=$(MP.emoteAnchor());
  if(anchor){ const g=anchor.getBoundingClientRect(); if(g.width){ cx=g.left+g.width/2; cy=g.top+g.height/2; bw=g.width; } }
  const lane=efLane(m.who), t=EF_POS[lane]||0;                            // t:-1(最左)~ 0(正中央)~ +1(最右)
  efLaneAt[lane]=Date.now(); efLaneBy[lane]=m.who;
  const span=Math.min(innerWidth*0.72, Math.max(bw,300))/2;               // 發位鋪在盤面寬度上,窄盤面也至少散開 300px
  const dur=2.05+Math.random()*0.4;                                      // 時長微擾:同時起飛的也不會整批同步
  const el=document.createElement("div");
  el.className="emote-fly"+(m.kind==="text"?" is-text":"")+(m.kind==="voice"?" is-voice":"")
            +((efCount()+1>=EF_SMALL)?" ef-sm":"");
  el.style.setProperty("--ef-dx",(t*20).toFixed(1)+"px");
  el.style.setProperty("--ef-dur",dur.toFixed(2)+"s");
  el.style.left=(cx+t*span+(Math.random()-0.5)*14)+"px";
  el.style.top=(cy+(EF_DY[lane]||0)+(Math.random()-0.5)*10)+"px";
  el.innerHTML='<span class="ef-emo">'+esc(m.emoji)+'</span><span class="ef-cap">'+esc(m.caption)+'</span>';
  layer.appendChild(el);
  // append 完才量得到實際寬度,再把邊緣發位夾回畫面內(長名字的膠囊很寬,不夾會被裁掉)
  // ⚠ 要用 offsetWidth,不可以用 getBoundingClientRect —— 動畫 0% 有 scale(.4),rect 量到的是縮小後的寬度
  const half=el.offsetWidth/2+8;
  if(half>8) el.style.left=Math.max(half,Math.min(innerWidth-half,parseFloat(el.style.left)))+"px";
  efNextAt=Date.now()+EF_GAP;
  setTimeout(()=>{ el.remove(); efPump(); }, dur*1000+120);
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
const voiceQueue=[]; let voiceBusy=false, voiceSafety=null, voicePrune=null;
const IS_TOUCH=("ontouchstart" in window) || (navigator.maxTouchPoints>0);
let audioArmed=false;
function markAudioArmed(){ audioArmed=true; }
function markAudioStale(){ audioArmed=false; }
/* ★★ 語音有「賞味期限」(v1.75.9)。使用者:「連線對戰模式,別人發的語音我都到了最後
   結束頁面時,才一直連續的播放出來」。
   病灶不在佇列本身,而在**膠囊會一直等下去**:手機在等別人出牌時螢幕暗掉 / 切去別的 App,
   visibilitychange 就把 audioArmed 打回 false(iOS 回前景後 state 仍是 running 卻不出聲,
   所以這個保守是對的)。之後收到的語音**不丟棄、留在佇列裡**等一個手勢 —— 一整局累積十幾則,
   結算時使用者拿起手機隨手一點,unlockAudioOnce 一次 kick,全部連珠炮放完。
   語音是**現場即時**的東西(即時語音上限 6 秒,發送端 15 秒就把 DB 記錄刪掉了),
   過了半分鐘再放只剩噪音,而且會蓋掉結算當下真的想說的話 → **逾時就丟,不補播**。
   ⚠ 佇列被膠囊擋住時沒有任何人會再呼叫 pumpVoice(它只由「收到語音」與「手勢」驅動),
     所以要額外掛一支 prune 心跳,讓膠囊自己過期收起來 ——
     否則畫面上會一直掛著「🔊 12 則語音 · 點我播放」引人去點一堆舊的,等於沒修。 */
const VOICE_TTL_MS=30000;      // 進佇列超過這麼久還沒播出去 → 丟掉
const VOICE_MAX_Q=6;           // 同時最多壓幾則(超過丟最舊的),避免一次爆量
const VOICE_PRUNE_MS=2000;     // 膠囊掛著時的過期心跳
function pruneVoice(){
  const now=Date.now();
  for(let i=voiceQueue.length-1;i>=0;i--){ if(now-voiceQueue[i].at>VOICE_TTL_MS) voiceQueue.splice(i,1); }
  if(voiceQueue.length>VOICE_MAX_Q) voiceQueue.splice(0,voiceQueue.length-VOICE_MAX_Q);
}
function startVoicePrune(){
  if(voicePrune)return;
  voicePrune=setInterval(()=>{
    if(voiceBusy)return;
    pruneVoice();
    if(!voiceQueue.length){ stopVoicePrune(); hideVoiceGate(); refreshBgmDuck(); }
    else showVoiceGate();
  },VOICE_PRUNE_MS);
}
function stopVoicePrune(){ if(voicePrune){ clearInterval(voicePrune); voicePrune=null; } }
function enqueueVoice(src){
  if(!src)return;
  if(Sound.isMuted&&Sound.isMuted())return;
  voiceQueue.push({ src:src, at:Date.now() });
  pruneVoice();
  if(!voiceBusy) pumpVoice();
}
function enqueueClip(id){
  const clip=CLIPS.find(c=>c.id===id); if(!clip)return;
  enqueueVoice(clip.src);
}
function pumpVoice(){
  if(voiceBusy)return;
  pruneVoice();
  if(!voiceQueue.length){ stopVoicePrune(); hideVoiceGate(); refreshBgmDuck(); return; }
  // iOS 回前景後 state 常仍是 "running" 卻不出聲 → 觸控裝置額外要求「這回合手勢解鎖過」,
  // 否則不硬播也不丟棄:留在佇列裡,改顯示可點的播放膠囊(但會照上面的 TTL 過期)
  if((IS_TOUCH && !audioArmed) || !(Sound.running && Sound.running())){ showVoiceGate(); startVoicePrune(); return; }
  stopVoicePrune();
  hideVoiceGate();
  const next=voiceQueue.shift();
  voiceBusy=true; refreshBgmDuck();
  const advance=()=>{ if(!voiceBusy)return; if(voiceSafety){ clearTimeout(voiceSafety); voiceSafety=null; } voiceBusy=false; pumpVoice(); };
  voiceSafety=setTimeout(advance,15000);
  playVoiceOnce(next.src,advance);
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

/* ---------- 自訂語音(自己錄幾組,連線時當罐頭按鈕送) ----------
   ★★ 與 js/game.js 那份是雙胞胎(Bingo 不載入 js/shared/,比照 toggleFull 各留一份)。
      改這個區塊一定要同時改另一邊 —— 用 grep myclips 就能找到兩處。

   走的是既有的 kind="voice" 管道:存下來的就是 sendEmote 要傳的 dataURL,送出時零轉換。
   因此不用改 Firebase 規則(audio 欄已放行 300,000 字元)、不用改 sw.js(沒有新增靜態音檔)、
   對方也不需要有任何檔案(資料自帶)—— 這是與內建 CLIPS 最大的差別:CLIPS 只傳代號、雙方
   都得有那支 m4a;自訂語音把音訊本身傳過去,舊版客戶端收到照播。

   ⚠ 獨立一支 localStorage key,絕對不進 bingo.prefs.v1 —— 那份每次 savePrefs() 都是整包
     read-modify-write,塞幾百 KB 進去等於「調一次音量就序列化幾百 KB」;更糟的是一旦
     setItem 拋 QuotaExceededError,連主題/音量等一般偏好都會一起存不進去。 */
const MYCLIP_KEY="bingo.myclips.v1";   // 三個遊戲共用同一批(與 bingo.pid / bingo.pwatip 同命名空間)
const MYCLIP_MAX=6;                    // 上限 6 組(3 秒約 65KB/則 → 約 390KB,對 localStorage 約 5MB 的額度很安全)
const MYCLIP_MS=3000;                  // 錄音上限 3 秒(內建即時語音是 6 秒;短一半 = 流量與本機容量都減半)
const MYCLIP_LABEL_MAX=8;              // 名字上限 8 字(與 players.name 同調,按鈕才不會爆版)
const MYCLIP_COOL=3000;                // 送出節流:見 sendMyClip
let myClips=[];                        // 記憶體副本(開面板/開編輯浮層時重讀)
let mvPending=null;                    // 錄好但還沒命名儲存的 dataURL
let mvRecTmr=null, mvTick=null, mvLastSent=0;

function loadMyClips(){
  try{
    const a=JSON.parse(localStorage.getItem(MYCLIP_KEY));
    if(!Array.isArray(a))return [];
    // 只收結構完整的,壞資料(手改壞、跨版本)直接濾掉而不是整批放棄
    return a.filter(c=>c && typeof c.id==="string" && typeof c.data==="string" && c.data.slice(0,5)==="data:")
            .map(c=>({ id:c.id, label:String(c.label||"語音").slice(0,MYCLIP_LABEL_MAX), data:c.data, at:c.at||0 }))
            .slice(0,MYCLIP_MAX);
  }catch(e){ return []; }
}
// 寫入失敗(多半是 QuotaExceededError)回 false 交給呼叫端提示,不讓例外冒出去打斷 UI
function saveMyClips(list){
  try{ localStorage.setItem(MYCLIP_KEY,JSON.stringify(list)); return true; }catch(e){ return false; }
}

/* ---- 互動面板的「我的語音」區 ---- */
function buildMyClips(){
  const g=$("emoteMyClips"), sub=$("myClipsSub");
  if(!g)return;
  myClips=loadMyClips();
  g.innerHTML="";
  const none=!myClips.length;
  g.classList.toggle("hidden",none);
  if(sub)sub.classList.toggle("hidden",none);   // 沒錄過就整區不出現,面板不會多一塊空的
  myClips.forEach(c=>{
    const b=document.createElement("button");
    b.type="button"; b.className="phrase-btn mvc-btn"; b.textContent="🎤 "+c.label;
    b.dataset.clipId=c.id;
    b.addEventListener("click",()=>{
      if(pdSuppressClick){ pdSuppressClick=false; return; }
      sendMyClip(c.id);
    });
    g.appendChild(b);
  });
}
/* 節流:做成按鈕之後按的頻率遠高於「按著錄 3 秒」的即時語音,而每按一次都是 ~65KB 上傳
   + 房內每人各下載 65KB(6 人房約 390KB)。3 秒內只放一則過去,擋連環轟炸。 */
function sendMyClip(id){
  const c=myClips.find(c=>c.id===id); if(!c)return;
  const now=Date.now();
  if(now-mvLastSent<MYCLIP_COOL){ showToast("等一下再送 🙂"); return; }
  mvLastSent=now;
  markAudioArmed(); Sound.wake();   // 點按鈕=手勢,順手解鎖音訊(同回合收到別人的語音才能自動播)
  MP.sendEmote(emoteTarget,"🎤","voice",c.data);
  closeEmote();
}

/* ---- 編輯浮層 ---- */
function openMyVoice(){
  myClips=loadMyClips(); mvPending=null;
  Sound.wake();
  buildMyVoiceList(); syncMyVoiceUI();
  const v=$("myVoiceVeil"); if(v)v.classList.add("show");
}
// 關閉一定要收乾淨:錄到一半關掉若不 cancel,麥克風會一直開著(分頁的錄音圖示不會消失)
function closeMyVoice(){
  const v=$("myVoiceVeil"); if(v)v.classList.remove("show");
  abortMyVoiceRec();
}
function abortMyVoiceRec(){
  if(mvRecTmr){ clearTimeout(mvRecTmr); mvRecTmr=null; }
  if(mvTick){ clearInterval(mvTick); mvTick=null; }
  if(Voice.recording()) Voice.cancel();
  voiceRecording=false; refreshBgmDuck();
  mvPending=null;
  syncMyVoiceUI();
}
function buildMyVoiceList(){
  const box=$("mvList"); if(!box)return;
  box.innerHTML="";
  if(!myClips.length){
    const p=document.createElement("div");
    p.className="mvc-empty";
    p.textContent="還沒有自訂語音。錄一段,連線時就能在互動面板當按鈕送出。";
    box.appendChild(p);
    return;
  }
  // 一律用 createElement + textContent/value 塞值(不走 innerHTML)→ 名字不需要另外 escape
  myClips.forEach(c=>{
    const row=document.createElement("div"); row.className="mvc-row";
    const play=document.createElement("button");
    play.type="button"; play.className="mvc-play"; play.textContent="▶";
    play.title="試聽"; play.setAttribute("aria-label","試聽 "+c.label);
    play.addEventListener("click",()=>previewMyClip(c.id));
    const name=document.createElement("input");
    name.type="text"; name.className="mvc-name"; name.value=c.label;
    name.maxLength=MYCLIP_LABEL_MAX; name.autocomplete="off";
    name.setAttribute("aria-label","語音名稱");
    name.addEventListener("change",()=>renameMyClip(c.id,name.value));
    name.addEventListener("blur",()=>renameMyClip(c.id,name.value));
    const del=document.createElement("button");
    del.type="button"; del.className="mvc-del"; del.textContent="🗑";
    del.title="刪除"; del.setAttribute("aria-label","刪除 "+c.label);
    del.addEventListener("click",()=>removeMyClip(c.id));
    row.appendChild(play); row.appendChild(name); row.appendChild(del);
    box.appendChild(row);
  });
}
// 試聽走 playVoiceOnce = 與對方實際聽到的同一條路徑(含 voiceVol 可放大到 300%),不會有「試聽小聲、對方很大聲」的落差
function previewMyClip(id){
  const c=myClips.find(c=>c.id===id); if(!c)return;
  if(Sound.isMuted && Sound.isMuted()){ showToast("目前是靜音,請先開啟音效"); return; }
  markAudioArmed(); Sound.wake();
  playVoiceOnce(c.data);
}
function renameMyClip(id,label){
  const c=myClips.find(c=>c.id===id); if(!c)return;
  const nx=String(label||"").trim().slice(0,MYCLIP_LABEL_MAX);
  if(!nx || nx===c.label){ buildMyVoiceList(); return; }   // 清空/沒改 → 還原顯示,不動資料
  const old=c.label; c.label=nx;
  if(!saveMyClips(myClips)){ c.label=old; showToast("存不進去,本機空間不足"); }
  buildMyVoiceList();
}
function removeMyClip(id){
  const next=myClips.filter(c=>c.id!==id);
  if(!saveMyClips(next)){ showToast("刪除失敗"); return; }
  myClips=next;
  buildMyVoiceList(); syncMyVoiceUI();
}
function mvSetBtn(o){
  const b=$("mvRecBtn"); if(!b)return;
  if(o.disabled!=null) b.disabled=o.disabled;
  if(o.rec!=null) b.classList.toggle("rec",o.rec);
  if(o.label!=null) b.textContent=o.label;
}
function syncMyVoiceUI(){
  const cnt=$("mvCount"); if(cnt)cnt.textContent=myClips.length+" / "+MYCLIP_MAX;
  const saveRow=$("mvSaveRow"); if(saveRow)saveRow.classList.toggle("hidden",!mvPending);
  if(Voice.recording())return;   // 錄音中的按鈕文字由倒數計時器管,別蓋掉
  if(mvPending){ mvSetBtn({ rec:false, disabled:false, label:"🎤 重錄" }); return; }
  const full=myClips.length>=MYCLIP_MAX;
  mvSetBtn({ rec:false, disabled:full, label: full?("已達 "+MYCLIP_MAX+" 組上限"):("🎤 錄一段新的("+(MYCLIP_MS/1000)+" 秒)") });
}
function toggleMyVoiceRec(){
  if(Voice.recording()){ mvSetBtn({disabled:true,label:"處理中…"}); Voice.stop(); return; }   // 提早停
  if(mvPending){ mvPending=null; syncMyVoiceUI(); }                                          // 重錄:丟掉上一段
  if(myClips.length>=MYCLIP_MAX){ showToast("已達 "+MYCLIP_MAX+" 組上限,請先刪除"); return; }
  if(!Voice.supported()){ showToast("此裝置/瀏覽器不支援錄音"); return; }
  markAudioArmed(); Sound.wake();
  mvSetBtn({disabled:true,label:"準備中…"});
  voiceRecording=true; refreshBgmDuck();   // 先停背景音樂再開麥克風(Android 的通話路徑會把音樂弄難聽)
  Voice.start(wav=>{
    if(mvRecTmr){ clearTimeout(mvRecTmr); mvRecTmr=null; }
    if(mvTick){ clearInterval(mvTick); mvTick=null; }
    voiceRecording=false; refreshBgmDuck();
    if(!wav || wav.byteLength<=44){ showToast("沒有錄到聲音"); mvPending=null; syncMyVoiceUI(); return; }
    try{ mvPending=Voice.toDataURL(wav); }
    catch(e){ showToast("語音處理失敗"); mvPending=null; }
    syncMyVoiceUI();
    if(mvPending){ const inp=$("mvName"); if(inp){ inp.value=""; inp.focus(); } }
  }).then(()=>{
    /* 3 秒上限:Voice.MAX_MS 是寫死的 6000,但 stop() 是對外方法 → 在外面自己收。
       stop() 內部的 detach() 會 clearTimeout 掉那顆 6 秒的內部計時器,兩者不會打架
       —— 所以整支 js/audio.js 一行都不用改。 */
    mvRecTmr=setTimeout(()=>{ try{ Voice.stop(); }catch(e){} }, MYCLIP_MS);
    let left=Math.ceil(MYCLIP_MS/1000);
    mvSetBtn({disabled:false,rec:true,label:"⏹ 停止 · "+left+"s"});
    mvTick=setInterval(()=>{
      left--;
      if(left<=0){ if(mvTick){ clearInterval(mvTick); mvTick=null; } return; }
      mvSetBtn({label:"⏹ 停止 · "+left+"s"});
    },1000);
  }).catch(err=>{
    voiceRecording=false; refreshBgmDuck();
    mvPending=null; syncMyVoiceUI();
    showToast((err&&err.name==="NotAllowedError")?"麥克風權限被拒絕":"無法啟動錄音");
  });
}
function saveMyVoicePending(){
  if(!mvPending)return;
  const inp=$("mvName");
  const label=((inp?inp.value:"")||"").trim().slice(0,MYCLIP_LABEL_MAX) || ("語音"+(myClips.length+1));
  const next=myClips.concat([{ id:"mc"+Date.now(), label:label, data:mvPending, at:Date.now() }]);
  if(!saveMyClips(next)){ showToast("本機空間不足,請先刪掉幾組"); return; }   // 失敗時 mvPending 留著,可改短名字或刪舊的再試
  myClips=next; mvPending=null;
  if(inp)inp.value="";
  buildMyVoiceList(); syncMyVoiceUI();
  showToast("已加入「"+label+"」⭐");
}

/* ---------- 對局中把頂列的 ⛶ / ⚙️ 收進遊戲自己那條列(v1.74.0) ----------
   ── 為什麼要有這個 ──────────────────────────────────────────────────────
   兩份回報其實是同一個病根:
     · 五子棋「開始對戰後全螢幕的按鈕不見了」—— 手機玩的時候頂列整條 display:none
       讓給盤面(styles.css 那條 `(max-height:780px) and (pointer:coarse)`,數獨同款),
       ⛶ 與 ⚙️ 住在頂列裡 → 跟著一起消失,對局中進不了全螢幕也開不了設定。
     · 台灣麻將橫向「全螢幕跟設定的按鈕看起來好奇怪,一點都不協調」—— v1.73.1 為了
       不讓它們消失,把頂列改成 position:fixed 浮在右上角;但它浮在房間框**外面**、
       垂直也沒對齊那條列的中線,看起來像兩張貼紙掛在角落。
   病根是這兩顆鈕**沒有「對局中」的家**。房間框那條列本來就住著 .icon-btn(離開房間 /
   回選單),把它們搬進去就對了:尺寸自動吃 `.gmk-room .icon-btn` / `.mj-room .icon-btn`
   那幾條既有規則(34px、橫向再壓到 28px),天然對齊、天然協調,頂列要收就放心收。

   ── 為什麼是「搬 DOM」而不是在房間框各放一份 ────────────────────────────
   全螢幕鈕的狀態(`.active`)與事件都綁在**同一顆**鈕上(bindCommonUI 綁 #fsBtn),
   複製第二顆就有兩個真相 —— 同 notes/13 那條「五個遊戲共用元件」的鐵則。
   搬動 DOM 不會解綁事件,所以搬完什麼都不用重接。
   ⚠ 靠右不必寫 margin-left:auto:那條列的標題(.gmk-room-title / .mj-lvtag …)都是
     flex:1,會自己把後面的元素推到最右邊(.mp-actions 就是這樣靠右的)。
   ⚠ Bingo 不載入這一支 —— 它的頂列在對局中不會被收掉,沒有這個問題,也不必補一份
     (CLAUDE.md 那條「刻意各留一份」的清單不用加這個)。

   ── ★★ 只有「頂列真的不見了」才搬(v1.75.10)────────────────────────────────
   使用者:「連線對戰時,開始遊戲後,全螢幕跟設定的按鈕,不應該跑進房間框裡面」。
   對的 —— 因為 dockTools 被五頁**無條件**接上了,而真正會收頂列的**只有三頁、而且都掛在
   媒體查詢裡**(收頂列本來就是為了「手機空間不夠」才做的):

     | 頁 | 對局中頂列什麼時候被收掉 |
     |---|---|
     | 數獨 `#sdkPlay` / 五子棋 `#gmkStage` | `(max-height:780px) and (pointer:coarse)` |
     | 台灣麻將 `body.m16-mp/-solo` | `(orientation:landscape) and (max-height:560px) and (pointer:coarse)` |
     | **排七 / 消消樂** | **從來不會**(styles.css 裡沒有這兩頁的 `.topbar{display:none}`) |

   所以在排七與消消樂,鈕是從一條**還好端端在畫面上、右半邊空著**的頂列被搬進房間框,
   把那條列擠到房名要 ellipsis(當初接上的理由寫在 mahjong/main.js:「為了四頁一致」——
   那個一致換來的是每一頁都變擠,不划算)。另外三頁**只要條件沒命中**(桌機、直向的麻將、
   夠高的手機)也一樣白搬一次 —— `pointer:coarse` 讓桌機永遠不命中,所以桌機從來沒有理由搬。

   改成由這裡自己判斷:`.topbar` 的 computed display 是不是 none。
   是 → 搬(那才是這個機制存在的理由);不是 → 待在頂列別動。
   ⚠ 判斷的是**當下**的 computed style,所以呼叫點一定要在 `showScreen()` **切完
     class / hidden 之後** —— 五頁現在都是這個順序(dockTools 是那一段的最後幾行)。
   ⚠ 媒體查詢吃視窗高度 → **轉螢幕 / 網址列縮放時答案會變**,所以記下「這一相位要搬去哪」
     (`toolsPanelId`)並掛 resize 重算一次;只 dock 一次的話轉個方向鈕就跑錯地方。 */
let toolsHome = null;      // .tools 原本的家(頂列);第一次同步時記下來
let toolsPanelId = null;   // 這一相位「如果要搬,搬去哪」;不在對局中就是 null
function topbarGone(){
  const bar = document.querySelector(".topbar");
  return !!bar && getComputedStyle(bar).display === "none";
}
function dockTools(panelId){ toolsPanelId = panelId || null; syncTools(); }
function undockTools(){ toolsPanelId = null; syncTools(); }
function syncTools(){
  const tools = document.querySelector(".tools");
  if(!tools) return;
  if(!toolsHome) toolsHome = tools.parentNode;
  const panel = toolsPanelId && $(toolsPanelId);
  const row = panel && panel.querySelector(".row");   // 房間框 / 單機列的第一列
  if(row && topbarGone()){
    if(tools.parentNode !== row){ row.appendChild(tools); tools.classList.add("tools-docked"); }
    return;
  }
  if(tools.parentNode !== toolsHome) toolsHome.appendChild(tools);
  tools.classList.remove("tools-docked");
}
addEventListener("resize", syncTools);

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

  // 自訂語音的編輯浮層(★ js/main.js 有一份同樣的綁定給 Bingo 用)
  $("myVoiceBtn").addEventListener("click",openMyVoice);
  $("mvClose").addEventListener("click",closeMyVoice);
  $("myVoiceVeil").addEventListener("click",e=>{ if(e.target===$("myVoiceVeil"))closeMyVoice(); });
  $("mvRecBtn").addEventListener("click",toggleMyVoiceRec);
  $("mvSave").addEventListener("click",saveMyVoicePending);
  $("mvName").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); saveMyVoicePending(); } });

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
/* 從 index.html 主選單的「現在有人在玩」點過來:?join=<4 位房號> → 直接進那間房(v1.52.0)。
   ★ 進來後立刻把參數從 URL 抹掉 —— 更新檢查會自動重載整頁,留著參數就會在對戰中被重新
     丟回「加入房間」一次。replaceState 不留歷史,按上一頁也不會又觸發一次。
   回傳有沒有接手(true = 已經在往房間裡走,啟動流程就不要再自己 showScreen 了)。 */
function autoJoinFromQuery(MP){
  const m=/[?&]join=(\d{4})(?:&|$)/.exec(location.search);
  if(!m)return false;
  try{ history.replaceState(null,"",location.pathname+location.hash); }catch(e){}
  MP.joinFromHome(m[1]);
  return true;
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

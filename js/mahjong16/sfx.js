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
     每個事件都註冊成一格 Sound.def() 音效槽,候選檔案是 mp3/m16-<事件>.mp3|.wav。
     檔案還沒放進去(現在就是)→ 自動退回這裡寫的合成音;之後把錄好的喊牌(「碰!」
     「胡!」)丟進 mp3/ 就直接生效,**程式一行都不用改**。

   ── ★ 刻意不做的兩件事 ────────────────────────────────────────────────────
     ① **宣告視窗沒有提示音**。親友聚會是坐在一起玩的 —— 你手機一響,鄰座就知道你手上
        有他剛打的那張。v1.59.0 那條紅線(不可以洩漏誰在考慮吃碰)藏得住畫面、藏不住
        聲音,所以這裡不給任何「你可以吃碰了」的聲音,提示只留畫面上的按鈕。
     ② **別人摸牌不出聲**。摸牌音只給自己(見 EV.draw),它同時兼任「換你了」——
        四家每一巡都響一次的話,一局要響幾百次。
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
  function synthWashout(){                       // 流局:兩音下行的收攤感(整體上移一個八度才聽得到)
    T(587,{ type:"triangle", dur:0.20, vol:0.22, slideTo:440 });
    T(392,{ type:"triangle", dur:0.34, vol:0.20, delay:0.16, slideTo:294 });
  }

  /* ---------- 事件表 ----------
     順序就是「同一個 diff 裡誰先響」(見 play 的錯開延遲):重的、代表整件事的先響。 */
  const EV = [
    { k:"hu",      synth:synthHu },
    { k:"kong",    synth:synthKong },
    { k:"pong",    synth:synthPong },
    { k:"chow",    synth:synthChow },
    { k:"discard", synth:synthDiscard },
    { k:"flower",  synth:synthFlower },
    { k:"draw",    synth:synthDraw },
    { k:"washout", synth:synthWashout }
  ];
  const ORDER = EV.map(e=>e.k);

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
    EV.forEach(e=>Sound.def("m16"+e.k, ["mp3/m16-"+e.k+".mp3", "mp3/m16-"+e.k+".wav"], e.synth));
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

    if(after.discards.length > before.discards.length) add("discard");

    /* 摸牌只報自己那一家(見檔頭)。「剛摸進來」= 之前沒有輪到我拿著一張摸牌。
       ⚠ 吃 / 碰之後 drawn 是 -1(不摸牌),所以碰完不會多一聲摸牌;槓之後補摸一張會有,
         聽起來就是「槓!…摸一張」,那是對的。 */
    if(after.drawn >= 0 && after.turn === me && !(before.drawn >= 0 && before.turn === me)) add("draw");

    if(!before.over && after.over) add(after.over.type === "win" ? "hu" : "washout");

    out.sort((x,y)=>ORDER.indexOf(x) - ORDER.indexOf(y));
    return out;
  }

  /* ==========================================================================
     play(before, after, me):偵測 + 發聲
     ★ 同一個 diff 可能有兩件事(「別人打牌」+「我摸一張」、「槓」+「槓上補摸」),
       所以依序錯開 90ms —— 全部疊在同一個瞬間會糊成一聲。
     ========================================================================== */
  function play(before, after, me){
    const ev = eventsOf(before, after, me);
    if(!ev.length || !ready()) return ev;
    ensureDefs();
    ev.forEach((k,i)=>{
      if(i === 0) Sound.sfx("m16"+k);
      else setTimeout(()=>{ if(ready()) Sound.sfx("m16"+k); }, i*90);
    });
    return ev;
  }

  /* 單獨播一個事件(給不是靠 diff 的地方用,例如 tools/t-mj16-sfx.html 試聽頁) */
  function one(k){
    if(!ready()) return;
    ensureDefs(); Sound.sfx("m16"+k);
  }

  return { eventsOf, play, one, KEYS:ORDER };
})();

if (typeof module !== "undefined" && module.exports) module.exports = M16Sfx;

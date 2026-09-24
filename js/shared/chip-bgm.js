/* ============================================================================
   js/shared/chip-bgm.js —— 動態配樂 ChipBGM(方塊對戰 / 泡泡對戰,v2.16.0+1 起)
   ──────────────────────────────────────────────────────────────────────────
   ★ 它不是一首固定循環的曲子,而是**跟著局勢即時合成**的配樂:
       危險度 0~1 → < .4 平穩 · < .75 升溫(加琶音)· 以上危險(加速、鼓變密、搖擺變直拍)
       垃圾警報   → 預告條上有東西就加一層警報
       最後 30 秒 → 再快一點、主旋律疊高八度
       事件       → 大消除補一段過門 · 新的一局在 GO 那一拍進場 · 自己死掉時像錄音帶被拔電
   ★ 只有兩頁載入(同 mp-order.js 的做法):曲譜在各自的 js/<遊戲>/music.js,
     訊號由各自的 board.js 餵進來(單機與連線走同一條顯示路徑,所以只要接一個地方)。
   ★ 播不播由 js/audio.js 的 BGM 決定:這一支向它登記成「產生器」(BGM.setGenerator),
     音樂開關 / 語音讓路 / 切背景暫停三個條件仍然只在 BGM 的 applyPlayState() 一個地方判。
     ⚠ 所以這一支**絕不可以自己開 AudioContext、自己決定要不要出聲**。
   ⚠ 手機喇叭放不出 600Hz 以下(notes/05)。各層的音量是量出來的 ——
     改音色或音量之後一律開 tools/t-bgm-lab.html 看量表,不要靠耳機判斷。
   原型與量表:tools/t-bgm-lab.html · 計畫:notes/plan/PLAN-方塊泡泡動態配樂.md
   ========================================================================== */
const ChipBGM = (function(){
  "use strict";

  /* ==========================================================================
     一、樂理小工具
     ========================================================================== */
  const PC = { C:0, "C#":1, D:2, "D#":3, E:4, F:5, "F#":6, G:7, "G#":8, A:9, "A#":10, B:11 };
  const QUAL = { "":[0,4,7], m:[0,3,7], "7":[0,4,7,10], m7:[0,3,7,10] };
  function midiOf(nm){
    const m = /^([A-G]#?)(\d)$/.exec(nm);
    if(!m) throw new Error("看不懂的音名:" + nm);
    return 12 * (+m[2] + 1) + PC[m[1]];
  }
  function hz(n){ return 440 * Math.pow(2, (n - 69) / 12); }
  function chordOf(sym){
    const parts = sym.split("/");
    const m = /^([A-G]#?)(m7|m|7)?$/.exec(parts[0]);
    if(!m || (parts[1] && !(parts[1] in PC))) throw new Error("看不懂的和弦:" + sym);
    const root = PC[m[1]];
    return { sym, root, iv: QUAL[m[2] || ""], bass: parts[1] ? PC[parts[1]] : root };
  }
  /* 旋律:「音名:格數」,一格 = 16 分音符,「|」分小節,r = 休止。每一小節一定要剛好 16 格
     (寫錯直接丟例外 —— 少一格的小節會讓整首從那裡開始錯拍,耳朵聽得出來、測試量不到)。
     和弦:一小節一個,逗號 = 前後半小節各一個,斜線 = 指定低音。 */
  function parseSong(def){
    const bars = def.melody.split("|").map(b => b.trim()).filter(Boolean);
    const notes = [], bad = [];
    bars.forEach((b, bi) => {
      let p = 0;
      b.split(/\s+/).forEach(tok => {
        const kv = tok.split(":"), d = +kv[1];
        if(!(d > 0)) throw new Error(def.name + " 第 " + (bi + 1) + " 小節時值錯:" + tok);
        if(kv[0] !== "r") notes.push({ s: bi * 16 + p, n: midiOf(kv[0]), d });
        p += d;
      });
      if(p !== 16) bad.push((bi + 1) + " 小節 = " + p + " 格");
    });
    if(bad.length) throw new Error(def.name + " 有小節不是 16 格:" + bad.join("、"));
    const chords = def.chords.trim().split(/\s+/).map(tok => tok.split(",").map(chordOf));
    if(chords.length !== bars.length) throw new Error(def.name + ":和弦 " + chords.length + " 小節、旋律 " + bars.length + " 小節");
    const mel = new Array(bars.length * 16).fill(null);
    notes.forEach(x => { mel[x.s] = x; });
    return Object.assign({}, def, { nBars: bars.length, mel, chords });
  }

  /* 鼓組:每個字串 16 格,x = 打。三列 = 平穩 / 升溫 / 危險。 */
  const KITS = {
    chip: [
      { k: "x.......x.......", s: "....x.......x...", h: "x.x.x.x.x.x.x.x.", o: "................" },
      { k: "x.....x.x.......", s: "....x.......x...", h: "x.x.x.x.x.x.x.x.", o: "..............x." },
      { k: "x...x...x...x...", s: "....x.......x...", h: "xx.xxx.xxx.xxx.x", o: "..x...x...x...x." }
    ],
    bounce: [
      { k: "x.......x.......", s: "....x.......x...", h: "x.x.x.x.x.x.x.x.", p: "..............x." },
      { k: "x.....x.x.......", s: "....x.......x...", h: "x.x.x.x.x.x.x.x.", p: "......x.......x." },
      { k: "x...x...x...x...", s: "....x.......x...", h: "xxxxxxxxxxxxxxxx", p: "..............x." }
    ]
  };

  /* ==========================================================================
     二、引擎
     ──────────────────────────────────────────────────────────────────────────
       · 排程:標準的「提前排程」—— 外面每 25ms 叫一次 scheduleUntil(現在 + 0.12 秒),
         主執行緒卡一下也不會掉拍。
       · 同一顆引擎也能丟進 OfflineAudioContext 離線渲染(試聽頁的量表就是這樣量的)。
       · 拔電停止:一顆共用的 ConstantSource 接到每一個正在響的聲音的 detune,
         一起往下彎;排程的步距同時拉長 → 音高與速度一起慢下來。
     ========================================================================== */
  function mulberry(seed){
    return function(){
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const noiseCache = new WeakMap();
  function noiseBuf(ctx){
    let b = noiseCache.get(ctx);
    if(b) return b;
    const n = ctx.sampleRate;
    b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0), r = mulberry(7);
    for(let i = 0; i < n; i++) d[i] = r() * 2 - 1;
    noiseCache.set(ctx, b);
    return b;
  }

  const OUT = .85;          // 引擎出口的音量(之後還要乘上 BGM 的音量滑桿)

  function Engine(ctx, out, sg, opt){
    opt = opt || {};
    const solo = opt.solo || null, emit = opt.onEvent || null;
    const on = k => !solo || solo === k;

    /* 訊號鏈:各層 bus → mix → 低通(拔電用)→ 壓縮 → outG → out */
    const mix = ctx.createGain();
    const LP_TOP = Math.min(20000, ctx.sampleRate / 2);   // ⚠ 低取樣率(量表的 32kHz 離線渲染)上限是 Nyquist,超過會一直噴警告
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = LP_TOP; lp.Q.value = .7;
    mix.connect(lp);
    let tail = lp;
    if(!opt.noComp){
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 3;
      comp.attack.value = .004; comp.release.value = .18;
      lp.connect(comp); tail = comp;
    }
    const outG = ctx.createGain(); outG.gain.value = OUT; tail.connect(outG); outG.connect(out);
    const BUS = {};
    ["lead", "arp", "bass", "drums", "alarm", "fx"].forEach(k => { const g = ctx.createGain(); g.connect(mix); BUS[k] = g; });
    const bend = ctx.createConstantSource(); bend.offset.value = 0; bend.start();

    /* ── 音源 ── */
    const waves = {};
    function wave(d){      // 脈衝波:傅立葉係數直接算(d = 佔空比;.5 就是方波)
      if(waves[d]) return waves[d];
      const N = 40, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
      for(let n = 1; n <= N; n++){
        re[n] = Math.sin(2 * Math.PI * n * d) / (n * Math.PI);
        im[n] = (1 - Math.cos(2 * Math.PI * n * d)) / (n * Math.PI);
      }
      return (waves[d] = ctx.createPeriodicWave(re, im));
    }
    const live = new Set();
    let tapeOn = false, seedN = 1;
    function reg(src, stopAt){
      const v = { src, stopAt, b: false };
      live.add(v);
      if(tapeOn && src.detune){ try{ bend.connect(src.detune); v.b = true; }catch(e){} }
      src.onended = () => { live.delete(v); if(v.b){ try{ bend.disconnect(src.detune); }catch(e){} } };
    }
    function osc(bus, f, t, dur, o){
      const s = ctx.createOscillator();
      if(o.duty) s.setPeriodicWave(wave(o.duty)); else s.type = o.type || "square";
      const a = o.a || .004;
      dur = Math.max(dur, a + .012);
      s.frequency.setValueAtTime(f, t);
      if(o.slide) s.frequency.exponentialRampToValueAtTime(o.slide, t + dur);
      const v = o.vol || .1, sus = (o.sus == null) ? .7 : o.sus, dcy = o.dcy || .08, rel = o.rel || .04;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + a);
      g.gain.setTargetAtTime(v * sus, t + a, dcy);
      g.gain.setTargetAtTime(0, t + dur, rel);
      s.connect(g); g.connect(bus);
      const end = t + dur + rel * 6 + .01;
      if(o.vib && dur > .24){         // 長音才加抖音,而且晚一點才進來
        const l = ctx.createOscillator(), lg = ctx.createGain();
        l.frequency.value = 5.5;
        lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(0, t + .14);
        lg.gain.linearRampToValueAtTime(o.vib, t + Math.min(dur, .4));
        l.connect(lg); lg.connect(s.detune); l.start(t); l.stop(end);
      }
      s.start(t); s.stop(end); reg(s, end);
    }
    function nz(bus, t, dur, o){
      const s = ctx.createBufferSource(); s.buffer = noiseBuf(ctx); s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = o.ft || "highpass"; f.frequency.value = o.ff || 5000; f.Q.value = o.q || .7;
      const g = ctx.createGain(), v = o.vol || .1;
      g.gain.setValueAtTime(.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + .0015);
      g.gain.exponentialRampToValueAtTime(.0003, t + dur);
      s.connect(f); f.connect(g); g.connect(bus);
      seedN = (seedN * 16807) % 2147483647;
      const end = t + dur + .02;
      s.start(t, (seedN % 900) / 1000); s.stop(end); reg(s, end);
    }
    /* ⚠ 大鼓的本體(150→46Hz)在手機上等於沒有 —— 手機上聽到的「咚」其實是那一下 2.6kHz 的敲擊聲 */
    const DR = {
      kick(t, v){ osc(BUS.drums, 150, t, .12, { type: "sine", slide: 46, vol: .5 * v, sus: 1, a: .002, rel: .05 });
                  nz(BUS.drums, t, .022, { ft: "bandpass", ff: 2600, q: .8, vol: .6 * v }); },
      snare(t, v){ nz(BUS.drums, t, .16, { ft: "bandpass", ff: 1900, q: .6, vol: .6 * v });
                   osc(BUS.drums, 300, t, .06, { type: "triangle", slide: 180, vol: .18 * v, sus: 1, rel: .03 }); },
      clap(t, v){ [0, .011, .022].forEach(d => nz(BUS.drums, t + d, .02, { ft: "bandpass", ff: 1500, q: 1.1, vol: .45 * v }));
                  nz(BUS.drums, t + .03, .15, { ft: "bandpass", ff: 1500, q: .9, vol: .36 * v }); },
      hat(t, v){ nz(BUS.drums, t, .04, { ft: "highpass", ff: 7000, vol: .22 * v }); },
      ohat(t, v){ nz(BUS.drums, t, .17, { ft: "highpass", ff: 6500, vol: .15 * v }); },
      pop(t, v){ osc(BUS.drums, 520, t, .07, { type: "sine", slide: 1500, vol: .3 * v, sus: 1, a: .002, rel: .02 }); },
      crash(t, v){ nz(BUS.fx, t, 1.5, { ft: "highpass", ff: 3600, vol: .17 * v }); }
    };

    /* ── 樂器 ──
       ⚠ 音量是量表量出來的(手機上相對旋律):琶音 0.15~0.3、低音 ≥ 0.1 ——
         原型第一版琶音只有 0.02 = 手機上等於沒有。 */
    function leadNote(n, t, d, vm){
      const T = sg.tone;
      if(T.bell){          // 鐘琴:正弦本體 + 高八度三角波的亮邊 + 一丁點脈衝波當敲擊
        const f = hz(n);
        osc(BUS.lead, f, t, Math.min(d, .6), { type: "sine", vol: .2 * vm, sus: d > .4 ? .16 : 0, dcy: .16, a: .002, rel: .08 });
        osc(BUS.lead, f * 2, t, .12, { type: "triangle", vol: .06 * vm, sus: 0, dcy: .05, a: .001, rel: .03 });
        osc(BUS.lead, f, t, .05, { duty: .25, vol: .035 * vm, sus: 0, dcy: .02, a: .001, rel: .02 });
        return;
      }
      osc(BUS.lead, hz(n), t, d, { duty: T.duty, vol: T.vol * vm, sus: T.sus, dcy: T.dcy, rel: T.rel, vib: T.vib });
    }
    function bassNote(n, t, d, vm){
      const B = sg.bass;
      if(sg.kit === "bounce"){
        osc(BUS.bass, hz(n), t, d, { duty: B.duty, vol: B.vol * vm, sus: .25, dcy: .09, rel: .04 });
        // 高八度的輕聲疊音:C3 那一段手機放不出來,少了它泡泡的低音在手機上只剩 0.03
        osc(BUS.bass, hz(n + 12), t, d * .7, { duty: .25, vol: B.vol * .45 * vm, sus: .15, dcy: .06, rel: .03 });
      }
      else osc(BUS.bass, hz(n), t, d, { duty: B.duty, vol: B.vol * vm, sus: .6, dcy: .07, rel: .025 });
    }
    function arpNote(n, t, d, vm){
      const A = sg.arp;
      if(A.type) osc(BUS.arp, hz(n), t, d, { type: A.type, vol: A.vol * vm, sus: 0, dcy: .07, a: .002, rel: .03 });
      else osc(BUS.arp, hz(n), t, d, { duty: A.duty, vol: A.vol * vm, sus: .45, dcy: .05, rel: .02 });
    }
    function arpTones(ch){
      return ch.iv.map(i => { let n = 72 + (ch.root + i) % 12; if(n < 74) n += 12; return n; }).sort((a, b) => a - b);
    }
    function bassPlan(pos, S, ch){
      let r = 36 + ch.bass; if(r < 40) r += 12;
      if(sg.bassStyle === "octave"){
        if(pos % 2) return null;
        return { n: r + (pos % 4 === 2 ? 12 : 0), d: 1.6, v: S === 2 ? 1.1 : 1 };
      }
      if(sg.bassStyle === "gallop"){
        if(S < 2){ if(pos % 2) return null; return { n: r + ((pos === 6 || pos === 14) ? 12 : 0), d: 1.5, v: 1 }; }
        if("x.xxx.xxx.xxx.xx"[pos] !== "x") return null;
        return { n: r + (pos >= 14 ? 12 : 0), d: .9, v: 1.05 };
      }
      const f = r + 7;                                   // bounce:低音在根音與五度之間跳
      if(S === 2){ if(pos % 2) return null; const seq = [r, f, r + 12, f]; return { n: seq[(pos / 2 | 0) % 4], d: 1.4, v: 1 }; }
      if(pos === 0 || pos === 8) return { n: r, d: 3, v: 1 };
      if(pos === 4 || pos === 12) return { n: f, d: 3, v: .85 };
      if(S === 1 && pos === 14) return { n: r + 12, d: 1.2, v: .8 };
      return null;
    }
    function drums(bar, pos, S, t){
      const k = KITS[sg.kit][S];
      const fill = S === 2 && bar % 4 === 3 && pos >= 12;        // 危險時每四小節補一段小鼓滾奏
      const sn = sg.kit === "bounce" ? DR.clap : DR.snare;
      let hit = false;
      if(k.k[pos] === "x"){ DR.kick(t, 1); hit = true; }
      if(k.s[pos] === "x" || fill){ sn(t, fill ? .55 + .12 * (pos - 12) : 1); hit = true; }
      if(k.h[pos] === "x"){ DR.hat(t, pos % 4 === 0 ? 1 : pos % 2 === 0 ? .8 : .55); hit = true; }
      if(k.o && k.o[pos] === "x"){ DR.ohat(t, 1); hit = true; }
      if(k.p && k.p[pos] === "x"){ DR.pop(t, 1); hit = true; }
      return hit;
    }
    function alarm(pos, t, sd){
      if(sg.alarm === "siren"){       // 方塊:兩音警報,每小節一組
        if(pos === 0){ osc(BUS.alarm, 1319, t, sd * 2.2, { duty: .25, vol: .13, sus: .8, rel: .03, slide: 1245 }); return true; }
        if(pos === 8){ osc(BUS.alarm, 988, t, sd * 2.2, { duty: .25, vol: .13, sus: .8, rel: .03, slide: 932 }); return true; }
        return false;
      }
      if(pos % 4) return false;       // 泡泡:滴答滴答的時鐘聲
      osc(BUS.alarm, pos % 8 ? 1400 : 1860, t, .06, { duty: .5, vol: .2, sus: .3, dcy: .02, a: .001, rel: .015 });
      return true;
    }
    function stinger(t, sd, ch){
      const ts = arpTones(ch);
      if(sg.stinger === "rise"){
        [ts[0], ts[1], ts[2], ts[0] + 12].forEach((n, i) => osc(BUS.fx, hz(n), t + i * sd, sd * 1.05, { duty: .25, vol: .11, sus: .7, rel: .03 }));
        DR.crash(t + 4 * sd, 1); DR.kick(t + 4 * sd, .9);
      } else {
        [ts[0], ts[1], ts[2], ts[0] + 12, ts[1] + 12, ts[2] + 12].forEach((n, i) =>
          osc(BUS.fx, hz(n), t + i * sd * .5, .18, { type: "sine", vol: .12, sus: 0, dcy: .07, a: .002, rel: .04 }));
        DR.pop(t + 3 * sd, 1.2); DR.crash(t + 3 * sd, .7);
      }
    }

    /* ── 狀態與排程 ── */
    let running = false, done = false, paused = false, pausedAt = 0;
    let step = 0, nextTime = 0, bpmNow = sg.bpm;
    let level = .1, S = 0, garbage = false, rush = false, stingReq = false, tape = null;
    /* ⚠ 三段之間要有**遲滯**(進 .4 / .75、退 .34 / .68)—— 堆在門檻上下抖的人,
       鼓組與琶音會每一拍換一次(同 board.js 的 DANGER_IN / DANGER_OUT 那一條)。 */
    function setLevel(v){
      level = Math.max(0, Math.min(1, +v || 0));
      if(S === 0){ if(level >= .75) S = 2; else if(level >= .4) S = 1; }
      else if(S === 1){ if(level >= .75) S = 2; else if(level < .34) S = 0; }
      else { if(level < .34) S = 0; else if(level < .68) S = 1; }
    }
    setLevel(level);
    const target = () => sg.bpm * (S === 2 ? sg.dangerMul : 1) * (rush ? 1.08 : 1);
    function rate(t){ if(!tape) return 1; return Math.max(.06, 1 - (t - tape.t0) / tape.D); }
    function note(layer, pos, t){ if(emit) emit({ t, type: "note", layer, pos }); }

    function playStep(s, t, sd){
      const bar = (s / 16) | 0, pos = s % 16;
      const tt = t + ((S < 2 && sg.swing && pos % 4 === 2) ? sg.swing * sd : 0);   // 搖擺只在平穩 / 升溫
      const cs = sg.chords[bar], ch = (cs.length > 1 && pos >= 8) ? cs[1] : cs[0];
      if(emit) emit({ t, type: "step", pos, bar, st: S, bpm: bpmNow, garbage });

      if(stingReq && pos % 4 === 0){ stingReq = false; if(on("fx")){ stinger(t, sd, ch); note("fx", pos, t); } }
      const L = sg.mel[s];
      if(L && on("lead")){
        const d = L.d * sd * .92;
        leadNote(L.n, tt, d, 1);
        if(rush) leadNote(L.n + 12, tt, d, .32);         // 最後 30 秒:主旋律疊高八度
        note("lead", pos, tt);
      }
      if(on("bass")){ const b = bassPlan(pos, S, ch); if(b){ bassNote(b.n, tt, b.d * sd, b.v); note("bass", pos, tt); } }
      if(S >= 1 && on("arp")){
        const every = S === 2 ? 1 : 2;
        if(pos % every === 0){
          const ts = arpTones(ch), pat = ts.length >= 4 ? [0, 1, 2, 3] : [0, 1, 2, 1];
          arpNote(ts[pat[(pos / every | 0) % pat.length]], tt, sd * every * .8, S === 2 ? 1.15 : 1);
          note("arp", pos, tt);
        }
      }
      if(on("drums") && drums(bar, pos, S, tt)) note("drums", pos, tt);
      if(garbage && on("alarm") && alarm(pos, tt, sd)) note("alarm", pos, tt);
    }

    function scheduleUntil(tEnd){
      while(running && !paused && nextTime < tEnd){
        if(tape && nextTime >= tape.t0 + tape.D){ running = false; done = true; break; }
        const sd = 60 / bpmNow / 4 / rate(nextTime);
        playStep(step, nextTime, sd);
        nextTime += sd;
        step = (step + 1) % (sg.nBars * 16);
        bpmNow += (target() - bpmNow) * .08;             // 換速度要滑過去(約一小節),不要一步跳
        // 拔電尾段的步距會長到一秒以上 → 一步就跨過 tEnd,迴圈頭那道檢查輪不到;這裡補一次
        if(tape && nextTime >= tape.t0 + tape.D){ running = false; done = true; }
      }
    }
    /* crash = 在第一拍補一聲鈸 + 大鼓(新的一局 GO 那一拍用) */
    function start(t, crash){
      running = true; done = false; paused = false; step = 0; nextTime = t; bpmNow = target(); tape = null; tapeOn = false;
      if(crash){ DR.crash(t, .9); DR.kick(t, 1); }
    }
    function countdown(t0){          // 試聽頁用:3、2、1 每秒一聲,音樂在 GO 那一刻進來(遊戲裡的嗶聲是遊戲自己的)
      running = false; tape = null;
      for(let i = 0; i < 3; i++){
        const tk = t0 + i;
        osc(BUS.fx, 880, tk, .11, { duty: .5, vol: .13, sus: .8, rel: .03 });
        if(emit){ emit({ t: tk, type: "count", n: 3 - i }); note("fx", 0, tk); }
      }
      const go = t0 + 3;
      osc(BUS.fx, 1760, go, .32, { duty: .5, vol: .12, sus: .6, rel: .07 });
      DR.crash(go, 1);
      if(emit){ emit({ t: go, type: "count", n: 0 }); note("fx", 0, go); }
      start(go, false);
    }
    function tapeStop(t0){
      if(!running || paused || tape) return false;
      const D = 1.3;
      tape = { t0, D }; tapeOn = true;
      live.forEach(v => { if(v.stopAt > t0 && v.src.detune && !v.b){ try{ bend.connect(v.src.detune); v.b = true; }catch(e){} } });
      const N = 48, curve = new Float32Array(N);
      for(let i = 0; i < N; i++) curve[i] = 1200 * Math.log2(Math.max(.06, 1 - i / (N - 1)));
      bend.offset.cancelScheduledValues(t0);
      bend.offset.setValueCurveAtTime(curve, t0, D);
      lp.frequency.cancelScheduledValues(t0);
      lp.frequency.setValueAtTime(LP_TOP, t0);
      lp.frequency.exponentialRampToValueAtTime(420, t0 + D);
      mix.gain.cancelScheduledValues(t0);
      mix.gain.setValueAtTime(1, t0);
      mix.gain.setValueAtTime(1, t0 + D * .55);
      mix.gain.linearRampToValueAtTime(0, t0 + D);
      if(emit) emit({ t: t0 + D, type: "tapeEnd" });
      return true;
    }
    /* 暫停 / 接續:接續時把「停掉的那段時間」整個跳過,從原本那一拍接下去 */
    function fadeTo(v, t, dur){
      outG.gain.cancelScheduledValues(t);
      outG.gain.setValueAtTime(outG.gain.value, t);
      outG.gain.linearRampToValueAtTime(v, t + dur);
    }
    function pause(){
      if(paused || done) return;
      paused = true; pausedAt = ctx.currentTime;
      fadeTo(0, ctx.currentTime, .06);
    }
    function resume(t){
      if(!paused || done) return;
      paused = false;
      nextTime += Math.max(0, t - pausedAt);
      fadeTo(OUT, t, .08);
    }
    function stop(fade){
      fade = (fade == null) ? .08 : fade;
      running = false; done = true;
      fadeTo(0, ctx.currentTime, fade);
      setTimeout(() => { try{ outG.disconnect(); bend.stop(); }catch(e){} }, fade * 1000 + 300);
    }

    return {
      start, stop, pause, resume, countdown, tapeStop, scheduleUntil, setLevel,
      stinger(){ stingReq = true; },
      setGarbage(b){ garbage = !!b; },
      setRush(b){ rush = !!b; },
      get running(){ return running; },
      get done(){ return done; },
      get paused(){ return paused; },
      get bpm(){ return bpmNow; },
      get state(){ return S; },
      get step(){ return step; },
      get liveCount(){ return live.size; }
    };
  }

  /* ==========================================================================
     三、導演 —— 遊戲只送訊號,這裡決定「現在該播什麼」
     ──────────────────────────────────────────────────────────────────────────
       mode:idle(大廳 / 結算:平穩版循環)· pre(新的一局,等 GO,安靜)·
             match(對局中)· out(自己死了:拔電之後安靜)· end(這局結束:淡出,稍後回 idle)
       呼叫點(兩頁的 board.js):
         setState → round() · countdown(fn) → cue(ms) · play → go() · pause → hold() · stop → end()
         每幀 → feed(危險度, 有沒有垃圾, 最後 30 秒, 死了沒) · 大消除 → hit()
       ★ 出不出聲有兩個獨立的理由,**不可以混成一個旗標**:
           active = BGM 說可以(音樂開著、沒被語音讓路、不在背景)
           held   = 遊戲暫停了(單機開設定)
         混成一個的話,「語音播完 → BGM 叫 play()」會把遊戲暫停中的音樂叫醒,反過來也一樣。
     ========================================================================== */
  const IDLE_AFTER_MS = 5000;   // 一局結束後多久回到大廳的平穩版(讓勝負音效先放完)
  const songs = {};
  let song = null;
  let ac = null, dest = null, active = false, held = false;
  let eng = null, timer = 0, endTimer = 0;
  let mode = "idle";
  let sig = { level: 0, garbage: false, rush: false }, deadPrev = false;

  function kill(fade){ if(eng){ eng.stop(fade); eng = null; } undrive(); }
  function fresh(when, crash, calm){
    kill();
    if(!ac || !dest || !song) return;
    eng = Engine(ac, dest, song, {});
    if(calm) eng.setLevel(0);
    else { eng.setLevel(sig.level); eng.setGarbage(sig.garbage); eng.setRush(sig.rush); }
    eng.start(when, crash);
    if(held || !active) eng.pause(); else drive();
  }
  function tick(){
    if(!eng || !ac){ undrive(); return; }
    eng.scheduleUntil(ac.currentTime + .12);
    if(eng.done){ kill(.02); }          // 拔電播完了:收掉,安靜到下一個訊號
  }
  function drive(){ if(!timer) timer = setInterval(tick, 25); tick(); }
  function undrive(){ if(timer){ clearInterval(timer); timer = 0; } }
  function sync(){
    if(!eng || !ac) return;
    const want = active && !held;
    if(want && eng.paused){ eng.resume(ac.currentTime + .03); drive(); }
    else if(!want && !eng.paused){ eng.pause(); undrive(); }
  }

  /* 給 js/audio.js 的 BGM 的產生器介面:play() 一定要可以重複呼叫(nudge / setSrc 都會再叫一次) */
  const GEN = {
    get name(){ return "本遊戲專屬配樂" + (song && song.title ? "《" + song.title + "》" : ""); },
    play(ctx, d){
      if(ac !== ctx || dest !== d){ kill(); ac = ctx; dest = d; }
      active = true;
      if(eng){ sync(); return; }
      if(mode === "idle") fresh(ctx.currentTime + .05, false, true);
      else if(mode === "match") fresh(ctx.currentTime + .05, false, false);
      // pre / out / end:本來就該安靜
    },
    halt(){ active = false; sync(); }
  };

  function define(id, def){ const s = parseSong(def); songs[id] = s; return s; }
  function use(s){
    song = s;
    if(typeof BGM !== "undefined" && BGM.setGenerator) BGM.setGenerator(GEN);
  }
  function round(){
    clearTimeout(endTimer);
    mode = "pre"; held = false; deadPrev = false;
    sig = { level: 0, garbage: false, rush: false };
    kill(.25);
  }
  function cue(ms){
    if(mode !== "pre") return;
    mode = "match";
    if(active && ac) fresh(ac.currentTime + Math.max(0, +ms || 0) / 1000, true, false);
  }
  function go(){
    held = false;
    if(mode !== "match" && mode !== "out"){
      clearTimeout(endTimer);
      mode = "match"; deadPrev = false;
      if(active && ac) fresh(ac.currentTime + .05, true, false);
      return;
    }
    sync();
  }
  /* ⚠ 「還在等 GO」的 pause 不算暫停:連線時 board.js 是 setState → pause → countdown → GO 才 play,
       算進去的話 cue() 排在 GO 的那一拍會被凍住、等 play() 解凍時再往後推一整段倒數(晚 3 秒才進場)。 */
  function hold(){ if(mode === "pre") return; held = true; sync(); }
  function end(){
    if(mode === "idle") return;
    mode = "end"; held = false;
    kill(1.2);
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      if(mode !== "end") return;
      mode = "idle";
      if(active && ac) fresh(ac.currentTime + .05, false, true);
    }, IDLE_AFTER_MS);
  }
  function feed(level, garbage, rush, dead){
    sig.level = Math.max(0, Math.min(1, +level || 0)); sig.garbage = !!garbage; sig.rush = !!rush;
    if(mode === "match" && eng){ eng.setLevel(sig.level); eng.setGarbage(sig.garbage); eng.setRush(sig.rush); }
    dead = !!dead;
    if(dead === deadPrev) return;
    deadPrev = dead;
    if(dead && mode === "match"){
      mode = "out";
      if(!(eng && ac && eng.tapeStop(ac.currentTime + .02))) kill(.2);
    }else if(!dead && mode === "out"){             // K.O. 賽復活:新的一條命從第一小節重來
      mode = "match";
      if(active && ac) fresh(ac.currentTime + .05, true, false);
    }
  }
  function hit(){ if(mode === "match" && eng && !eng.paused) eng.stinger(); }

  return {
    Engine, parseSong, KITS, songs, define, use,
    round, cue, go, hold, end, feed, hit,
    /* 測試與除錯用(產品程式不讀):現在的導演狀態 + 引擎狀態 */
    state(){
      return { mode, active, held, song: song ? song.id : "",
               eng: !!eng, running: !!(eng && eng.running), paused: !!(eng && eng.paused),
               bpm: eng ? eng.bpm : 0, st: eng ? eng.state : -1, step: eng ? eng.step : -1,
               level: sig.level, garbage: sig.garbage, rush: sig.rush };
    }
  };
})();

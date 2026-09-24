/* ============================================================================
   js/bubble/music.js —— 泡泡對戰的配樂《泡泡跳跳》(v2.16.0+1 起)
   ──────────────────────────────────────────────────────────────────────────
   ★ 原創(泡泡龍的原曲有版權)。平常是搖擺的跳跳節奏,危險時搖擺感消失、變成直拍在趕你;
     每小節尾巴有一聲「咕嘟」。
   ★ 引擎與「什麼時候播什麼」在 js/shared/chip-bgm.js;訊號由 js/bubble/board.js 餵。
     這一支只有曲譜。
   ⚠ 每一小節一定要剛好 16 格(一格 = 16 分音符)—— 寫錯 parseSong 會直接丟例外。
   ⚠ 改音量 / 音色之後開 tools/t-bgm-lab.html 看手機喇叭量表(notes/05 的 600Hz 紅線)。
   ========================================================================== */
(function(){
  "use strict";
  if(typeof ChipBGM === "undefined") return;
  try{
    ChipBGM.use(ChipBGM.define("bubble", {
      id: "bub", game: "bubble", name: "泡泡 · 泡泡跳跳", title: "泡泡跳跳", key: "C 大調", bpm: 126, dangerMul: 1.16, swing: .62,
      feel: "鐘琴撥音 · 搖擺節奏",
      tone: { bell: true },
      arp: { type: "triangle", vol: .15 }, bass: { duty: .125, vol: .26 },
      bassStyle: "bounce", kit: "bounce", alarm: "clock", stinger: "sparkle",
      melody: `
        E5:2 G5:2 C6:2 G5:2 A5:2 G5:2 E5:4 | E5:2 A5:2 C6:2 A5:2 B5:2 A5:2 E5:4 | F5:2 A5:2 C6:2 A5:2 D6:2 C6:2 A5:4 | G5:2 B5:2 D6:2 B5:2 C6:2 B5:2 G5:4 |
        E6:2 D6:2 C6:2 D6:2 E6:4 G5:4 | C6:4 B5:2 A5:2 E5:4 A5:4 | F5:2 A5:2 D6:2 C6:2 B5:2 G5:2 D5:2 F5:2 | E5:4 C5:4 C6:4 r:4 |
        C6:2 r:2 C6:2 A5:2 F5:4 A5:4 | D6:2 r:2 D6:2 B5:2 G5:4 B5:4 | E6:2 r:2 E6:2 B5:2 G5:4 B5:4 | C6:2 B5:2 A5:2 G5:2 A5:8 |
        F5:2 A5:2 D6:2 F6:2 E6:4 D6:4 | B5:2 D6:2 G6:4 F6:2 D6:2 B5:4 | C6:2 E6:2 G6:4 E6:2 C6:2 G5:4 | C6:4 G5:2 E5:2 C5:4 r:4 |`,
      chords: `C Am F G C Am Dm,G C  F G Em Am Dm G C C,G`
    }));
  }catch(e){ console.error("[ChipBGM] 泡泡對戰的曲譜讀不進去:" + e.message); }
})();

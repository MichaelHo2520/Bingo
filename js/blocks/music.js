/* ============================================================================
   js/blocks/music.js —— 方塊對戰的配樂《貨郎》(v2.16.0+1 起)
   ──────────────────────────────────────────────────────────────────────────
   ★ Korobeiniki(俄羅斯民謠,就是 Tetris 那首)—— **旋律是公有領域**;
     有版權的是任天堂等的編曲與錄音,這裡是自己編、自己合成的。
   ★ 引擎與「什麼時候播什麼」在 js/shared/chip-bgm.js;訊號由 js/blocks/board.js 餵。
     這一支只有曲譜。
   ⚠ 每一小節一定要剛好 16 格(一格 = 16 分音符)—— 寫錯 parseSong 會直接丟例外。
   ⚠ 改音量 / 音色之後開 tools/t-bgm-lab.html 看手機喇叭量表(notes/05 的 600Hz 紅線)。
   ========================================================================== */
(function(){
  "use strict";
  if(typeof ChipBGM === "undefined") return;
  try{
    ChipBGM.use(ChipBGM.define("blocks", {
      id: "kb", game: "blocks", name: "方塊 · 貨郎", title: "貨郎", key: "A 小調", bpm: 144, dangerMul: 1.15, swing: 0,
      feel: "方波 · 八度跳低音",
      tone: { duty: .5, vol: .12, sus: .7, dcy: .10, rel: .035, vib: 14 },
      arp: { duty: .25, vol: .08 }, bass: { duty: .25, vol: .15 },
      bassStyle: "octave", kit: "chip", alarm: "siren", stinger: "rise",
      melody: `
        E5:4 B4:2 C5:2 D5:4 C5:2 B4:2 | A4:4 A4:2 C5:2 E5:4 D5:2 C5:2 | B4:6 C5:2 D5:4 E5:4 | C5:4 A4:4 A4:4 r:4 |
        D5:6 F5:2 A5:4 G5:2 F5:2 | E5:6 C5:2 E5:4 D5:2 C5:2 | B4:4 B4:2 C5:2 D5:4 E5:4 | C5:4 A4:4 A4:4 r:4 |
        E5:4 B4:2 C5:2 D5:4 C5:2 B4:2 | A4:4 A4:2 C5:2 E5:4 D5:2 C5:2 | B4:6 C5:2 D5:4 E5:4 | C5:4 A4:4 A4:4 r:4 |
        D5:6 F5:2 A5:4 G5:2 F5:2 | E5:6 C5:2 E5:4 D5:2 C5:2 | B4:4 B4:2 C5:2 D5:4 E5:4 | C5:4 A4:4 A4:4 r:4 |
        E5:8 C5:8 | D5:8 B4:8 | C5:8 A4:8 | G#4:8 B4:4 r:4 |
        E5:8 C5:8 | D5:8 B4:8 | C5:4 E5:4 A5:8 | G#5:16 |`,
      chords: `E Am E Am Dm C E Am  E Am E Am Dm C E Am  Am E/G# Am E/G# Am E/G# Am E/G#`
    }));
  }catch(e){ console.error("[ChipBGM] 方塊對戰的曲譜讀不進去:" + e.message); }
})();

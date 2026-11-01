// Arguments de ffmpeg (src/ffmpeg-args.js), sans navigateur :
// 1. sans réglage, ou au niveau « haute », chaque format garde exactement les
//    arguments d'avant les réglages audio et vidéo ;
// 2. chaque réglage donne les arguments attendus.
//   node tests/ffmpeg-args.mjs

import assert from "node:assert/strict";
import { ffmpegArgs, scaleFilter, VIDEO_CODECS, AUDIO_FORMATS } from "../src/ffmpeg-args.js";

const EVEN = ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"];
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
// Arguments de Convertex 0.3.5
const BEFORE = {
  mp4: [...X264, "-c:a", "aac", "-movflags", "+faststart", ...EVEN],
  mov: [...X264, "-c:a", "aac", ...EVEN],
  mkv: [...X264, "-c:a", "aac", ...EVEN],
  flv: [...X264, "-c:a", "aac", "-ar", "44100", ...EVEN],
  webm: ["-c:v", "libvpx", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-c:a", "libvorbis", ...EVEN],
  avi: ["-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame"],
  wmv: ["-c:v", "wmv2", "-q:v", "5", "-c:a", "wmav2"],
  mpeg: ["-c:v", "mpeg1video", "-q:v", "5", "-r", "25", "-c:a", "mp2"],
  ogv: ["-c:v", "libtheora", "-q:v", "6", "-pix_fmt", "yuv420p", "-c:a", "libvorbis", ...EVEN],
  mp3: ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-vn", "-c:a", "pcm_s16le"],
  ogg: ["-vn", "-c:a", "libvorbis", "-q:a", "5"],
  flac: ["-vn", "-c:a", "flac"],
  aac: ["-vn", "-c:a", "aac", "-b:a", "192k"],
  m4a: ["-vn", "-c:a", "aac", "-b:a", "192k"],
  opus: ["-vn", "-c:a", "libopus", "-b:a", "128k"],
  wma: ["-vn", "-c:a", "wmav2", "-b:a", "160k"],
  aiff: ["-vn", "-c:a", "pcm_s16be"],
  ac3: ["-vn", "-c:a", "ac3", "-b:a", "192k"],
  gif: ["-vf", "fps=12,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"],
  srt: [],
};

let n = 0;
const check = (label, got, want) => {
  n++;
  assert.deepEqual(got, want, label);
};

// 1. Valeurs par défaut inchangées
for (const [to, want] of Object.entries(BEFORE)) {
  check(`${to} sans réglage`, ffmpegArgs("mkv", to), want);
  check(`${to} niveau haute`, ffmpegArgs("mkv", to, { level: "high" }), want);
}
// tous les formats audio et vidéo sont couverts
for (const to of [...Object.keys(VIDEO_CODECS), ...AUDIO_FORMATS]) assert.ok(to in BEFORE, `${to} absent de BEFORE`);

// 2. Réglages
const after = (args, flag) => args[args.indexOf(flag) + 1];
check("mp3 maximale, 48 kHz, mono", ffmpegArgs("mp4", "mp3", { level: "max", rate: 48000, channels: 1 }),
  ["-vn", "-c:a", "libmp3lame", "-q:a", "0", "-ar", "48000", "-ac", "1"]);
check("wav : la qualité ne change rien", ffmpegArgs("mp3", "wav", { level: "low", rate: 44100 }),
  ["-vn", "-c:a", "pcm_s16le", "-ar", "44100"]);
check("opus : toujours 48 kHz", ffmpegArgs("wav", "opus", { level: "low", rate: 44100, channels: 2 }),
  ["-vn", "-c:a", "libopus", "-b:a", "64k", "-ac", "2"]);

const video = ffmpegArgs("mov", "mp4", { level: "low", height: 480, fps: 24, rate: 48000, channels: 1 });
check("mp4 tous réglages", video, ["-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "1", "-movflags", "+faststart", "-r", "24", "-vf", scaleFilter(480)]);
check("webm maximale", ffmpegArgs("mp4", "webm", { level: "max", height: 360 }),
  ["-c:v", "libvpx", "-b:v", "2500k", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p",
    "-c:a", "libvorbis", "-q:a", "6", "-vf", scaleFilter(360)]);
check("pas de choix de codec", after(ffmpegArgs("mp4", "mkv", { codec: "h265" }), "-c:v"), "libx264");
check("avi : filtre de taille seulement si une résolution est choisie", ffmpegArgs("mp4", "avi", { height: 720 }).at(-1), scaleFilter(720));
check("mpeg : cadence autorisée", after(ffmpegArgs("mp4", "mpeg", { fps: 30 }), "-r"), "30");
check("mpeg : cadence refusée, 25 images/s", after(ffmpegArgs("mp4", "mpeg", { fps: 29 }), "-r"), "25");
check("flv : 44,1 kHz imposés", ffmpegArgs("mp4", "flv", { rate: 48000 }).filter((a) => a === "-ar").length, 1);
check("flv : 44,1 kHz imposés (valeur)", after(ffmpegArgs("mp4", "flv", { rate: 48000 }), "-ar"), "44100");
check("niveau inconnu : haute", ffmpegArgs("wav", "aac", { level: "ultra" }), BEFORE.aac);
for (const level of ["low", "medium", "max"]) {
  for (const to of [...Object.keys(VIDEO_CODECS), ...AUDIO_FORMATS]) {
    const args = ffmpegArgs("mkv", to, { level });
    check(`${to} ${level} : aucune valeur vide`, args.some((a) => a === "" || a == null), false);
  }
}

console.log(`${n}/${n} vérifications d'arguments ffmpeg réussies`);

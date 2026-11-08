// Arguments de ffmpeg pour chaque format de sortie audio ou vidéo, selon les
// réglages du panneau : qualité (4 niveaux) et réglages avancés (résolution,
// images par seconde, fréquence, canaux). Sans réglage, on garde les valeurs
// d'origine de Convertex (niveau « haute »).
// Séparé du worker pour être testé tel quel depuis Node (tests/ffmpeg-args.mjs).

export const LEVELS = ["low", "medium", "high", "max"];
export const DEFAULT_LEVEL = "high";

// Codec vidéo de chaque conteneur. Pas de choix de codec : H.265 (x265) et VP9 ne
// fonctionnent pas dans le cœur de ffmpeg.wasm à un seul fil d'exécution que charge
// Convertex (x265 ne rend jamais la main, VP9 plante dès la première image).
export const VIDEO_CODECS = {
  mp4: "h264", mov: "h264", mkv: "h264", webm: "vp8", flv: "h264", avi: "mpeg4", wmv: "wmv2", mpeg: "mpeg1", ogv: "theora",
};
export const AUDIO_FORMATS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "wma", "aiff", "ac3"]);
// Formats sans perte : la qualité n'y change rien
export const LOSSLESS_AUDIO = new Set(["wav", "flac", "aiff"]);
// Fréquence imposée par le format : le réglage de fréquence est sans effet
export const FIXED_RATE = { opus: 48000, flv: 44100 };

export const isVideo = (to) => to in VIDEO_CODECS;
export const isAudio = (to) => AUDIO_FORMATS.has(to);

// Valeur par niveau : [basse, moyenne, haute, maximale]
const pick = (level, values) => values[Math.max(0, LEVELS.indexOf(level))];

function videoCodecArgs(codec, level) {
  switch (codec) {
    case "h264":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", pick(level, ["30", "26", "23", "18"]), "-pix_fmt", "yuv420p"];
    case "vp8":
      return ["-c:v", "libvpx", "-b:v", pick(level, ["400k", "700k", "1M", "2500k"]), "-deadline", "realtime", "-cpu-used", "8",
        "-pix_fmt", "yuv420p"];
    case "mpeg4":
      return ["-c:v", "mpeg4", "-q:v", pick(level, ["12", "8", "5", "2"])];
    case "wmv2":
      return ["-c:v", "wmv2", "-q:v", pick(level, ["12", "8", "5", "2"])];
    case "mpeg1":
      return ["-c:v", "mpeg1video", "-q:v", pick(level, ["12", "8", "5", "2"])];
    case "theora":
      return ["-c:v", "libtheora", "-q:v", pick(level, ["3", "5", "6", "9"]), "-pix_fmt", "yuv420p"];
    default:
      return [];
  }
}

// Piste audio d'une vidéo. Au niveau « haute », le débit par défaut du codec,
// comme avant.
function videoAudioArgs(to, level) {
  const high = level === DEFAULT_LEVEL;
  if (to === "webm" || to === "ogv") return ["-c:a", "libvorbis", ...(high ? [] : ["-q:a", pick(level, ["2", "3", "", "6"])])];
  if (to === "avi") return ["-c:a", "libmp3lame", ...(high ? [] : ["-q:a", pick(level, ["7", "5", "", "2"])])];
  if (to === "wmv") return ["-c:a", "wmav2", ...(high ? [] : ["-b:a", pick(level, ["96k", "128k", "", "192k"])])];
  if (to === "mpeg") return ["-c:a", "mp2", ...(high ? [] : ["-b:a", pick(level, ["128k", "192k", "", "384k"])])];
  return ["-c:a", "aac", ...(high ? [] : ["-b:a", pick(level, ["96k", "128k", "", "192k"])])];
}

function audioCodecArgs(to, level) {
  switch (to) {
    case "mp3": return ["-c:a", "libmp3lame", "-q:a", pick(level, ["6", "4", "2", "0"])];
    case "wav": return ["-c:a", "pcm_s16le"];
    case "ogg": return ["-c:a", "libvorbis", "-q:a", pick(level, ["3", "4", "5", "8"])];
    case "flac": return ["-c:a", "flac"];
    case "aac":
    case "m4a": return ["-c:a", "aac", "-b:a", pick(level, ["96k", "128k", "192k", "256k"])];
    case "opus": return ["-c:a", "libopus", "-b:a", pick(level, ["64k", "96k", "128k", "192k"])];
    case "wma": return ["-c:a", "wmav2", "-b:a", pick(level, ["96k", "128k", "160k", "192k"])];
    case "aiff": return ["-c:a", "pcm_s16be"];
    case "ac3": return ["-c:a", "ac3", "-b:a", pick(level, ["128k", "160k", "192k", "384k"])];
    default: return [];
  }
}

// Fréquence et canaux de l'audio (fichier audio ou piste d'une vidéo)
function audioShapeArgs(to, av) {
  const out = [];
  if (FIXED_RATE[to]) {
    if (to === "flv") out.push("-ar", "44100"); // FLV : 44,1 kHz, comme avant
  } else if (av.rate) {
    out.push("-ar", String(av.rate));
  }
  if (av.channels) out.push("-ac", String(av.channels));
  return out;
}

// Filtre de taille : le plus petit côté ramené à `height` (1080p, 720p…) sans
// jamais agrandir, et des dimensions paires, qu'exigent H.264, VP8 et Theora.
export function scaleFilter(height) {
  if (!height) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  return `scale='if(gte(iw,ih),-2,trunc(min(iw,${height})/2)*2)':'if(gte(iw,ih),trunc(min(ih,${height})/2)*2,-2)'`;
}

const GIF_ARGS = ["-vf", "fps=12,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"];
// Codecs qui acceptent des dimensions impaires : pas de filtre sans réglage de taille
const ANY_SIZE = new Set(["mpeg4", "wmv2", "mpeg1"]);

// av : { level, height, fps, rate, channels } (tous facultatifs)
export function ffmpegArgs(from, to, av = {}) {
  const level = LEVELS.includes(av.level) ? av.level : DEFAULT_LEVEL;
  if (to === "gif") return GIF_ARGS;
  if (isVideo(to)) {
    const codec = VIDEO_CODECS[to];
    const args = videoCodecArgs(codec, level);
    // MPEG-1 n'accepte que certaines cadences : 25 images/s par défaut
    if (to === "mpeg") args.push("-r", String([24, 25, 30, 50, 60].includes(av.fps) ? av.fps : 25));
    args.push(...videoAudioArgs(to, level), ...audioShapeArgs(to, av));
    if (to === "mp4") args.push("-movflags", "+faststart");
    if (av.fps && to !== "mpeg") args.push("-r", String(av.fps));
    if (av.height || !ANY_SIZE.has(codec)) args.push("-vf", scaleFilter(av.height));
    return args;
  }
  if (isAudio(to)) {
    const lossless = LOSSLESS_AUDIO.has(to);
    return ["-vn", ...audioCodecArgs(to, lossless ? DEFAULT_LEVEL : level), ...audioShapeArgs(to, av)];
  }
  return []; // sous-titres : ffmpeg déduit tout de l'extension
}

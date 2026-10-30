// Worker qui héberge les moteurs lourds (WebAssembly).
// Chaque moteur n'est chargé que la première fois qu'on en a besoin.

import { t } from "./i18n.js";
import { createPandocInstance } from "../node_modules/pandoc-wasm/src/core.js";
import {
  initializeImageMagick, ImageMagick, MagickFormat, MagickColor, AlphaAction, ColorType,
} from "@imagemagick/magick-wasm";

const ENGINES = new URL("../engines/", self.location.href);
const engineUrl = (name) => new URL(name, ENGINES).href;

async function fetchBytes(name) {
  const res = await fetch(engineUrl(name));
  return new Uint8Array(await res.arrayBuffer());
}

function progress(id, ratio, text) {
  self.postMessage({ id, type: "progress", ratio, text });
}

/* ---------------- ImageMagick ---------------- */

let magickReady = null;
function loadMagick() {
  magickReady ??= fetchBytes("magick.wasm").then((b) => initializeImageMagick(b));
  return magickReady;
}

const MAGICK_NAME = { jpg: "JPEG", tiff: "TIFF", heic: "HEIC" };
const magickFormat = (id) => MAGICK_NAME[id] ?? id.toUpperCase();
const NO_ALPHA = new Set(["jpg", "bmp", "pcx", "ppm", "pgm", "pbm", "jp2", "pdf", "hdr", "xpm"]);

async function runMagick({ bytes, from, to, options }) {
  await loadMagick();
  return new Promise((resolve, reject) => {
    try {
      ImageMagick.read(bytes, magickFormat(from), (image) => {
        if (NO_ALPHA.has(to) && image.hasAlpha) {
          image.backgroundColor = new MagickColor("white");
          image.alpha(AlphaAction.Remove);
        }
        // Un PSD ou un TGA écrit depuis une image à palette (GIF) est mal relu par
        // certains logiciels : on l'écrit en couleurs réelles.
        if ((to === "psd" || to === "tga") && (image.colorType === ColorType.Palette || image.colorType === ColorType.PaletteAlpha)) {
          image.colorType = image.hasAlpha ? ColorType.TrueColorAlpha : ColorType.TrueColor;
        }
        if (to === "ico" && (image.width > 256 || image.height > 256)) {
          image.resize(256, 256);
        }
        if (typeof options.quality === "number") {
          image.quality = Math.round(options.quality * 100);
        }
        image.write(magickFormat(to), (data) => resolve(new Uint8Array(data)));
      });
    } catch (err) {
      reject(new Error(`ImageMagick: ${err.message ?? err}`));
    }
  });
}

/* ---------------- Pandoc ---------------- */

let pandocReady = null;
function loadPandoc() {
  pandocReady ??= fetchBytes("pandoc.wasm").then((b) => createPandocInstance(b));
  return pandocReady;
}

const PANDOC_READER = {
  md: "markdown", txt: "markdown", tex: "latex", typ: "typst", adoc: "asciidoc",
  wiki: "mediawiki", dbk: "docbook",
};
const PANDOC_WRITER = {
  md: "gfm", txt: "plain", tex: "latex", typ: "typst", adoc: "asciidoc",
  wiki: "mediawiki", dbk: "docbook5", epub: "epub3", html: "html5",
};
const BINARY_IO = new Set(["docx", "odt", "epub", "pptx"]);
const STANDALONE = new Set(["html", "tex", "typ", "rtf", "dbk", "fb2", "ipynb"]);

// Texte brut lu par le lecteur Markdown : tous les caractères qui ont un sens en
// Markdown sont échappés (un « * » ou un « $ » restent des caractères).
function plainToMarkdown(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[\\`*_{}[\]()#+\-.!|<>$~^&=:@%"']/g, "\\$&"))
    .join("\n");
}

async function runPandoc({ bytes, from, to, name }) {
  const pandoc = await loadPandoc();
  const options = {
    from: PANDOC_READER[from] ?? from,
    to: PANDOC_WRITER[to] ?? to,
    standalone: STANDALONE.has(to),
    metadata: { pagetitle: name.replace(/\.[^.]+$/, ""), title: undefined },
  };
  delete options.metadata.title;
  if (to === "html") options["embed-resources"] = true;
  // formules : MathML, que les navigateurs et les liseuses affichent sans script
  if (to === "html" || to === "epub") options["html-math-method"] = { method: "mathml" };

  const files = {};
  let stdin = null;
  if (BINARY_IO.has(from)) {
    const inName = `entree.${from}`;
    files[inName] = new Blob([bytes]);
    options["input-files"] = [inName];
  } else {
    stdin = new TextDecoder().decode(bytes);
    if (from === "txt") stdin = plainToMarkdown(stdin);
  }
  const outName = `sortie.${to}`;
  if (BINARY_IO.has(to)) options["output-file"] = outName;

  const result = await pandoc.convert(options, stdin, files);
  if (BINARY_IO.has(to)) {
    const out = result.files?.[outName];
    if (!out) throw new Error(`Pandoc: ${result.stderr || t("noOutput")}`);
    return new Uint8Array(await out.arrayBuffer());
  }
  if (!result.stdout && result.stderr) throw new Error(`Pandoc: ${result.stderr}`);
  let out = result.stdout;
  // l'annotation TeX des formules MathML n'est pas affichée par tous les lecteurs
  if (to === "html") out = out.replace(/<annotation encoding="application\/x-tex">[\s\S]*?<\/annotation>/g, "").replace(/<\/?semantics>/g, "");
  return new TextEncoder().encode(out);
}

/* ---------------- ffmpeg ---------------- */

let ffmpegReady = null;
let ffmpegProgress = () => {};
let ffmpegLog = [];
function loadFfmpeg() {
  ffmpegReady ??= (async () => {
    const coreURL = engineUrl("ffmpeg-core.js");
    const wasmURL = engineUrl("ffmpeg-core.wasm");
    const { default: createFFmpegCore } = await import(/* @vite-ignore */ coreURL);
    const core = await createFFmpegCore({
      mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}`,
    });
    core.setProgress(({ progress: p }) => ffmpegProgress(p));
    core.setLogger(({ message }) => {
      ffmpegLog.push(message);
      if (ffmpegLog.length > 30) ffmpegLog.shift();
    });
    return core;
  })();
  return ffmpegReady;
}

// Codecs choisis pour chaque format de sortie
const VIDEO_ARGS = {
  mp4:  ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"],
  mov:  ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac"],
  mkv:  ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac"],
  flv:  ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100"],
  webm: ["-c:v", "libvpx", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-c:a", "libvorbis"],
  avi:  ["-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame"],
  wmv:  ["-c:v", "wmv2", "-q:v", "5", "-c:a", "wmav2"],
  mpeg: ["-c:v", "mpeg1video", "-q:v", "5", "-r", "25", "-c:a", "mp2"],
  ogv:  ["-c:v", "libtheora", "-q:v", "6", "-pix_fmt", "yuv420p", "-c:a", "libvorbis"],
};
const AUDIO_ARGS = {
  mp3:  ["-c:a", "libmp3lame", "-q:a", "2"],
  wav:  ["-c:a", "pcm_s16le"],
  ogg:  ["-c:a", "libvorbis", "-q:a", "5"],
  flac: ["-c:a", "flac"],
  aac:  ["-c:a", "aac", "-b:a", "192k"],
  m4a:  ["-c:a", "aac", "-b:a", "192k"],
  opus: ["-c:a", "libopus", "-b:a", "128k"],
  wma:  ["-c:a", "wmav2", "-b:a", "160k"],
  aiff: ["-c:a", "pcm_s16be"],
  ac3:  ["-c:a", "ac3", "-b:a", "192k"],
};
const EVEN_SIZE = ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"];
const GIF_ARGS = ["-vf", "fps=12,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"];

function ffmpegArgs(from, to) {
  if (to === "gif") return GIF_ARGS;
  if (VIDEO_ARGS[to]) {
    const args = [...VIDEO_ARGS[to]];
    return ["mpeg4", "mpeg1video", "wmv2"].includes(args[1]) ? args : [...args, ...EVEN_SIZE];
  }
  if (AUDIO_ARGS[to]) return ["-vn", ...AUDIO_ARGS[to]];
  return []; // sous-titres : ffmpeg déduit tout de l'extension
}

async function runFfmpeg({ id, bytes, from, to }) {
  const core = await loadFfmpeg();
  const inName = `entree.${from}`;
  const outName = `sortie.${to}`;
  ffmpegProgress = (p) => progress(id, Math.max(0, Math.min(1, p)));
  ffmpegLog = [];
  core.FS.writeFile(inName, bytes);
  try {
    core.setTimeout(-1);
    core.exec("-y", "-i", inName, ...ffmpegArgs(from, to), outName);
    const ret = core.ret;
    core.reset();
    if (ret !== 0) {
      if (ffmpegLog.some((l) => /does not contain any stream|matches no streams/i.test(l))) {
        throw new Error(t("noStream"));
      }
      const reason = ffmpegLog.filter((l) => /error|invalid|not|unsupported|failed/i.test(l)).slice(-2).join(" ");
      throw new Error(`${t("ffmpegFailed")}${reason ? `: ${reason}` : ` (code ${ret})`}`);
    }
    return core.FS.readFile(outName);
  } finally {
    for (const f of [inName, outName]) {
      try { core.FS.unlink(f); } catch { /* fichier absent */ }
    }
  }
}

/* ---------------- Aiguillage ---------------- */

const RUNNERS = { magick: runMagick, pandoc: runPandoc, ffmpeg: runFfmpeg };

self.onmessage = async ({ data }) => {
  const { id, engine } = data;
  try {
    const out = await RUNNERS[engine](data);
    self.postMessage({ id, type: "done", bytes: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message ?? String(err) });
  }
};

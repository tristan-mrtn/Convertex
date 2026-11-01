// Worker qui héberge les moteurs lourds (WebAssembly).
// Chaque moteur n'est chargé que la première fois qu'on en a besoin.

import { t } from "./i18n.js";
import { createPandocInstance } from "../node_modules/pandoc-wasm/src/core.js";
import { convertWithPandoc } from "./pandoc-run.js";
import { ffmpegArgs } from "./ffmpeg-args.js";
import MATH_LUA from "./math.lua"; // texte du filtre, inclus dans le paquet par esbuild
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

async function runPandoc(job) {
  return convertWithPandoc(await loadPandoc(), job, { lua: MATH_LUA });
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

async function runFfmpeg({ id, bytes, from, to, options }) {
  const core = await loadFfmpeg();
  const inName = `entree.${from}`;
  const outName = `sortie.${to}`;
  ffmpegProgress = (p) => progress(id, Math.max(0, Math.min(1, p)));
  ffmpegLog = [];
  core.FS.writeFile(inName, bytes);
  try {
    core.setTimeout(-1);
    // réglages audio et vidéo du panneau (seulement pour la dernière étape du chemin)
    core.exec("-y", "-i", inName, ...ffmpegArgs(from, to, options?.av ?? {}), outName);
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

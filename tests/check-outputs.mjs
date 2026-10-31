// Vérifie que les fichiers produits par tests/e2e.mjs s'ouvrent :
//   node tests/check-outputs.mjs [tests/out/rapport.json]
// 1. Convertex lui-même reconnaît le format attendu (signature, contenu des ZIP) ;
// 2. un lecteur indépendant ouvre le fichier quand il est installé : ffprobe
//    (audio, vidéo, sous-titres), ImageMagick (images), pdf.js (PDF), Pandoc
//    (documents), SheetJS (tableurs), les analyseurs JSON/YAML/TOML/XML, fflate.
// Les échecs attendus (PDF sans texte vers un format texte) sont comptés à part.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { unzipSync, gunzipSync } from "fflate";
import * as XLSX from "xlsx";
import * as yaml from "js-yaml";
import { parse as parseToml } from "smol-toml";
import { XMLValidator } from "fast-xml-parser";
import { detectFormat } from "../src/detect.js";
import { createPandocInstance } from "../node_modules/pandoc-wasm/src/core.js";

const ROOT = resolve(import.meta.dirname, "..");
const report = JSON.parse(readFileSync(process.argv[2] ?? join(ROOT, "tests/out/rapport.json"), "utf8"));
const pandoc = await createPandocInstance(readFileSync(join(ROOT, "node_modules/pandoc-wasm/src/pandoc.wasm")));
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const dec = new TextDecoder("utf-8", { fatal: true });

const tool = (cmd) => { try { execFileSync(cmd, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } };
const ffprobe = tool("ffprobe");
const magick = tool("magick") ? "magick" : tool("identify") ? "identify" : null;
// formats qu'ImageMagick 6 ne sait pas lire : la détection de Convertex suffit
const MAGICK_SKIP = new Set(["avif", "jxl", "qoi", "exr", "heic"]);
const IMAGES = new Set(["png", "jpg", "webp", "gif", "bmp", "tiff", "ico", "avif", "jxl", "jp2", "qoi", "tga", "psd", "pcx", "ppm", "pgm", "pbm", "xpm", "dds", "exr", "hdr"]);
const MEDIA = new Set(["mp4", "webm", "mkv", "avi", "mov", "flv", "wmv", "mpeg", "ogv", "mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "wma", "aiff", "ac3", "srt", "vtt", "ass"]);
const READER = { docx: "docx", epub: "epub", html: "html", md: "markdown", tex: "latex",
  rst: "rst", org: "org", adoc: "asciidoc", wiki: "mediawiki", textile: "textile", dbk: "docbook", ipynb: "ipynb", fb2: "fb2", rtf: "rtf" };
const BINARY = new Set(["docx", "epub"]);

async function deepCheck(path, fmt, bytes) {
  if (MEDIA.has(fmt)) {
    if (!ffprobe) return;
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path]).toString();
    if (!out.trim()) throw new Error("ffprobe ne trouve aucun flux");
    return;
  }
  if (IMAGES.has(fmt)) {
    if (!magick || MAGICK_SKIP.has(fmt)) return;
    execFileSync(magick, [`${fmt === "jpg" ? "jpeg" : fmt}:${path}`], { stdio: "pipe" });
    return;
  }
  if (fmt === "pdf") {
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    await doc.getPage(1);
    return;
  }
  if (fmt === "odt" || fmt === "pptx") {
    // le lecteur ODT de Pandoc plante sur certains tableaux que LibreOffice ouvre :
    // on vérifie l'archive et ses XML
    const files = unzipSync(bytes);
    const main = Object.keys(files).filter((p) => p === "content.xml" || /^ppt\/slides\/slide\d+\.xml$/.test(p));
    if (!main.length) throw new Error("contenu absent");
    for (const p of main) {
      const v = XMLValidator.validate(dec.decode(files[p]));
      if (v !== true) throw new Error(`${p} : ${v.err?.msg ?? "XML invalide"}`);
    }
    return;
  }
  if (READER[fmt]) {
    const opts = { from: READER[fmt], to: "plain" };
    const files = {};
    if (BINARY.has(fmt)) { files[`f.${fmt}`] = new Blob([bytes]); opts["input-files"] = [`f.${fmt}`]; }
    const res = await pandoc.convert(opts, BINARY.has(fmt) ? null : dec.decode(bytes), files);
    if (!res.stdout.trim() && res.stderr) throw new Error(`Pandoc : ${res.stderr.trim().split("\n")[0]}`);
    return;
  }
  switch (fmt) {
    case "xlsx": case "xls": case "ods": {
      const wb = XLSX.read(bytes, { type: "array" });
      if (!wb.SheetNames.length) throw new Error("classeur vide");
      return;
    }
    // Typst : le lecteur de Pandoc ne comprend pas tout Typst, on vérifie le texte
    case "csv": case "tsv": case "txt": case "typ": dec.decode(bytes); return;
    case "json": JSON.parse(dec.decode(bytes)); return;
    case "yaml": yaml.load(dec.decode(bytes)); return;
    case "toml": parseToml(dec.decode(bytes)); return;
    case "xml": { const v = XMLValidator.validate(dec.decode(bytes)); if (v !== true) throw new Error(v.err?.msg ?? "XML invalide"); return; }
    case "zip": unzipSync(bytes); return;
    case "tgz": gunzipSync(bytes); return;
    case "tar": if (bytes.length % 512 !== 0) throw new Error("taille TAR invalide"); return;
    default: return;
  }
}

const failures = [];
const expected = [];
let checked = 0;
for (const r of report) {
  if (!r.ok) {
    if (/no text|aucun texte|pas de texte/i.test(r.error ?? "")) expected.push(r);
    else failures.push(`${r.file} -> ${r.to} : conversion échouée (${r.error})`);
    continue;
  }
  checked++;
  const bytes = new Uint8Array(readFileSync(r.out));
  // plusieurs fichiers (PDF de plusieurs pages en images…) : un ZIP qui les regroupe
  const fmt = basename(r.out).endsWith(".zip") && r.to !== "zip" ? "zip" : r.to;
  try {
    if (!bytes.length) throw new Error("fichier vide");
    const detected = await detectFormat(new File([bytes], basename(r.out)));
    if (detected !== fmt) throw new Error(`reconnu comme ${detected}`);
    await deepCheck(r.out, fmt, bytes);
  } catch (err) {
    failures.push(`${r.file} -> ${r.to} : ${String(err.message ?? err).split("\n")[0]}`);
  }
}

for (const f of failures) console.log(`ÉCHEC ${f}`);
console.log(`\n${checked - failures.filter((f) => !f.includes("conversion échouée")).length}/${checked} sorties s'ouvrent`
  + (expected.length ? ` ; ${expected.length} échecs attendus (PDF sans texte vers un format texte)` : ""));
process.exit(failures.length ? 1 : 0);

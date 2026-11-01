// Fabrique un petit fichier d'exemple pour chaque format, dans tests/samples/,
// pour la régression complète (tous les formats vers toutes leurs cibles) :
//   node tests/samples.mjs && node tests/e2e.mjs tests/samples
// Images : ImageMagick (convert ou magick) ; audio et vidéo : ffmpeg ; documents :
// Pandoc (le même WebAssembly que l'extension) ; le reste en JavaScript.
// AVIF, JPEG XL, QOI et EXR sont fabriqués par Convertex lui-même lors d'un premier
// passage : relancer avec --depuis=tests/out pour les récupérer.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zipSync, gzipSync } from "fflate";
import * as XLSX from "xlsx";
import { createPandocInstance } from "../node_modules/pandoc-wasm/src/core.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "tests/samples");
const from = process.argv.find((a) => a.startsWith("--depuis="))?.split("=")[1];
const enc = new TextEncoder();
const made = [];
const skipped = [];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe" });
const has = (cmd) => { try { run(cmd, ["-version"]); return true; } catch { return false; } };
const put = (name, data) => { writeFileSync(join(OUT, name), data); made.push(name); };
const tryMake = (name, fn) => {
  try { fn(); if (existsSync(join(OUT, name)) && !made.includes(name)) made.push(name); } catch { skipped.push(name); }
};

if (from) {
  // formats qu'aucun outil local n'écrit : sorties de Convertex du premier passage
  for (const ext of ["avif", "jxl", "qoi", "exr"]) {
    const src = join(resolve(from), "sample.png", `sample.${ext}`);
    if (existsSync(src)) { copyFileSync(src, join(OUT, `sample.${ext}`)); made.push(`sample.${ext}`); }
  }
  console.log(`Repris de ${from} : ${made.join(", ") || "rien"}`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* Images */
const magick = has("magick") ? "magick" : has("convert") ? "convert" : null;
if (magick) {
  const png = join(OUT, "sample.png");
  run(magick, ["-size", "96x64", "gradient:#4c6ef5-#f08c00", "-fill", "white", "-draw", "circle 30,32 30,12",
    "-fill", "#2b8a3e", "-draw", "rectangle 56,14 84,50", png]);
  made.push("sample.png");
  for (const ext of ["jpg", "webp", "gif", "bmp", "tiff", "ico", "jp2", "tga", "psd", "pcx", "ppm", "pgm", "pbm", "xpm", "dds", "hdr"]) {
    tryMake(`sample.${ext}`, () => run(magick, [png, join(OUT, `sample.${ext}`)]));
  }
} else skipped.push("images (ImageMagick absent)");
put("sample.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">
  <rect width="120" height="80" fill="#e7f5ff"/><circle cx="40" cy="40" r="24" fill="#4c6ef5"/>
  <text x="70" y="46" font-family="sans-serif" font-size="18" fill="#c92a2a">Cx</text></svg>\n`);

/* Audio et vidéo (une seconde) */
if (has("ffmpeg")) {
  const ff = (args) => run("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  const video = ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=12:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest"];
  const VIDEO = {
    mp4: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"], mov: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    mkv: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"], webm: ["-c:v", "libvpx", "-c:a", "libvorbis"],
    avi: ["-c:v", "mpeg4", "-c:a", "libmp3lame"], flv: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100"],
    wmv: ["-c:v", "wmv2", "-c:a", "wmav2"], mpeg: ["-c:v", "mpeg1video", "-r", "25", "-c:a", "mp2"], ogv: ["-c:v", "libtheora", "-c:a", "libvorbis"],
  };
  for (const [ext, codecs] of Object.entries(VIDEO)) tryMake(`sample.${ext}`, () => ff([...video, ...codecs, join(OUT, `sample.${ext}`)]));
  const AUDIO = { mp3: [], wav: [], ogg: ["-c:a", "libvorbis"], flac: [], aac: [], m4a: ["-c:a", "aac"], opus: ["-c:a", "libopus"], wma: [], aiff: [], ac3: [] };
  for (const [ext, codecs] of Object.entries(AUDIO)) {
    tryMake(`sample.${ext}`, () => ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...codecs, join(OUT, `sample.${ext}`)]));
  }
} else skipped.push("audio et vidéo (ffmpeg absent)");

/* Sous-titres */
put("sample.srt", "1\n00:00:00,000 --> 00:00:01,500\nBonjour, ceci est un sous-titre.\n\n2\n00:00:02,000 --> 00:00:03,000\nDeuxième réplique.\n");
put("sample.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nBonjour, ceci est un sous-titre.\n\n00:00:02.000 --> 00:00:03.000\nDeuxième réplique.\n");
put("sample.ass", `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,Bonjour, ceci est un sous-titre.
Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Deuxième réplique.
`);

/* Documents : un Markdown varié, écrit dans chaque format par Pandoc */
const md = `---
title: Document d'exemple
---

# Titre principal

Un paragraphe avec du **gras**, de l'*italique*, du \`code\` et un [lien](https://example.org).
Une formule en ligne $E = mc^2$ et une formule centrée :

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

## Une liste et un tableau

- premier point
- second point avec des accents : été, garçon, cœur

| Format | Famille |
|--------|---------|
| PNG    | Image   |
| MP3    | Audio   |

> Une citation, pour finir.
`;
put("sample.md", md);
put("sample.txt", "Un fichier texte simple.\nDeuxième ligne avec des accents : été, garçon.\nUn prix : 5 $ et un astérisque * isolé.\n");
const pandoc = await createPandocInstance(readFileSync(join(ROOT, "node_modules/pandoc-wasm/src/pandoc.wasm")));
const DOCS = { docx: "docx", odt: "odt", rtf: "rtf", html: "html5", tex: "latex", typ: "typst", rst: "rst", org: "org",
  adoc: "asciidoc", wiki: "mediawiki", textile: "textile", dbk: "docbook5", ipynb: "ipynb", epub: "epub3", fb2: "fb2", pptx: "pptx" };
for (const [ext, writer] of Object.entries(DOCS)) {
  const binary = ["docx", "odt", "epub", "pptx"].includes(ext);
  const opts = { from: "markdown", to: writer, standalone: true, "html-math-method": { method: "mathml" } };
  if (binary) opts["output-file"] = `sample.${ext}`;
  const res = await pandoc.convert(opts, md, {});
  const data = binary ? new Uint8Array(await res.files[`sample.${ext}`].arrayBuffer()) : res.stdout;
  writeFileSync(join(OUT, `sample.${ext}`), data);
}
// PDF : celui des tests de formules (texte, maths) et une page sans texte (image)
copyFileSync(join(ROOT, "tests/fixtures/maths/integration-lmodern.pdf"), join(OUT, "sample.pdf"));
made.push("sample.pdf");
if (magick) tryMake("sample-image.pdf", () => run(magick, [join(OUT, "sample.png"), join(OUT, "sample-image.pdf")]));

/* Tableurs */
const rows = [["Nom", "Âge", "Ville"], ["Alice", 31, "Lyon"], ["Bruno", 27, "Dijon"], ["Chloé", 45, "Nantes"]];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Feuille1");
for (const ext of ["xlsx", "xls", "ods"]) put(`sample.${ext}`, new Uint8Array(XLSX.write(wb, { bookType: ext === "xls" ? "biff8" : ext, type: "array" })));
put("sample.csv", rows.map((r) => r.join(",")).join("\n") + "\n");
put("sample.tsv", rows.map((r) => r.join("\t")).join("\n") + "\n");

/* Données */
const data = { projet: "Convertex", version: 1, local: true, formats: ["png", "mp3", "docx"], auteur: { nom: "Exemple", ville: "Dijon" } };
put("sample.json", JSON.stringify(data, null, 2));
put("sample.yaml", "projet: Convertex\nversion: 1\nlocal: true\nformats:\n  - png\n  - mp3\n  - docx\nauteur:\n  nom: Exemple\n  ville: Dijon\n");
put("sample.toml", 'projet = "Convertex"\nversion = 1\nlocal = true\nformats = ["png", "mp3", "docx"]\n\n[auteur]\nnom = "Exemple"\nville = "Dijon"\n');
put("sample.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<projet nom="Convertex"><version>1</version><formats><f>png</f><f>mp3</f></formats></projet>\n');

/* Archives */
const files = { "dossier/lisezmoi.txt": enc.encode("Bonjour\n"), "dossier/donnees.json": enc.encode(JSON.stringify(data)) };
put("sample.zip", zipSync(files));
function tar(entries) {
  const chunks = [];
  for (const [path, bytes] of Object.entries(entries)) {
    const h = new Uint8Array(512);
    const w = (o, s) => h.set(enc.encode(s), o);
    w(0, path); w(100, "0000644\0"); w(108, "0000000\0"); w(116, "0000000\0");
    w(124, bytes.length.toString(8).padStart(11, "0") + "\0"); w(136, "00000000000\0");
    h[156] = 48; w(257, "ustar\0"); w(263, "00"); h.fill(32, 148, 156);
    w(148, h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ");
    chunks.push(h, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
put("sample.tar", tar(files));
put("sample.tgz", gzipSync(tar(files)));

const all = readdirSync(OUT);
console.log(`${all.length} fichiers dans tests/samples/`);
if (skipped.length) console.log(`Non fabriqués : ${skipped.join(", ")}`);

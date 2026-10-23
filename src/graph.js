// Le graphe de conversion.
// Nœuds : les formats. Arêtes : ce que chaque moteur sait faire.
// On cherche ensuite le chemin le moins coûteux (Dijkstra) vers chaque format.

import { FORMATS } from "./formats.js";

const IMG_RW = ["png", "jpg", "webp", "gif", "bmp", "tiff", "ico", "avif", "jxl", "jp2",
  "qoi", "tga", "psd", "pcx", "ppm", "pgm", "pbm", "xpm", "dds", "exr", "hdr"];
const IMG_RO = ["heic", "xcf", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf"];
const VIDEO = ["mp4", "webm", "mkv", "avi", "mov", "flv", "wmv", "mpeg", "ogv"];
const AUDIO = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "wma", "aiff", "ac3"];
const SUBS = ["srt", "vtt", "ass"];
const PANDOC_IO = ["docx", "odt", "rtf", "html", "md", "tex", "typ", "rst", "org", "adoc",
  "wiki", "textile", "dbk", "ipynb", "epub", "fb2", "pptx"];
const SHEETS = ["csv", "tsv", "xlsx", "xls", "ods"];
const TREES = ["json", "yaml", "toml", "xml"];
const ARCHIVES = ["zip", "tar", "tgz"];

// Chaque arête : moteur, formats d'entrée, formats de sortie, coût.
// - drops : ce que la sortie a perdu (le texte d'un document devenu image,
//   le mouvement d'une vidéo devenue image fixe)
// - needs : ce que l'entrée doit encore contenir pour que l'arête ait un sens
export const EDGES = [
  { engine: "magick", from: [...IMG_RW, ...IMG_RO], to: IMG_RW.filter((f) => f !== "gif"), cost: 1 },
  { engine: "magick", from: [...IMG_RW, ...IMG_RO], to: ["gif"], cost: 1, drops: ["motion"] },
  { engine: "magick", from: [...IMG_RW, ...IMG_RO], to: ["pdf"], cost: 1, drops: ["text"] },
  { engine: "canvas", from: ["svg"], to: ["png"], cost: 1 },

  { engine: "ffmpeg", from: VIDEO, to: [...VIDEO, "gif"], cost: 2 },
  { engine: "ffmpeg", from: ["gif"], to: VIDEO, cost: 2, needs: ["motion"] },
  { engine: "ffmpeg", from: VIDEO, to: AUDIO, cost: 1 },
  { engine: "ffmpeg", from: AUDIO, to: AUDIO, cost: 1 },
  { engine: "ffmpeg", from: SUBS, to: SUBS, cost: 1 },

  { engine: "pandoc", from: [...PANDOC_IO, "txt", "csv", "tsv"], to: PANDOC_IO, cost: 1 },
  { engine: "pandoc", from: [...PANDOC_IO], to: ["txt"], cost: 1.5 },

  { engine: "pdftext", from: ["pdf"], to: ["txt"], cost: 3, needs: ["text"] },
  { engine: "pdfrender", from: ["pdf"], to: ["png", "jpg"], cost: 2, drops: ["text"] },
  { engine: "pdfwrite", from: ["md", "txt"], to: ["pdf"], cost: 2 },

  { engine: "sheet", from: [...SHEETS, "json"], to: [...SHEETS, "json"], cost: 1 },
  { engine: "tree", from: TREES, to: TREES, cost: 1 },
  { engine: "archive", from: ARCHIVES, to: ARCHIVES, cost: 1 },
];

const MAX_STEPS = 4;
const BITS = { text: 1, motion: 2 };
const mask = (list = []) => list.reduce((m, x) => m | BITS[x], 0);

// Liste d'adjacence : format -> [{ to, engine, cost, flags }]
const ADJ = {};
for (const e of EDGES) {
  for (const from of e.from) {
    for (const to of e.to) {
      if (from === to) continue;
      (ADJ[from] ??= []).push({ from, to, engine: e.engine, cost: e.cost,
        drops: mask(e.drops), needs: mask(e.needs) });
    }
  }
}

export function edgeCount() {
  return Object.values(ADJ).reduce((n, list) => n + list.length, 0);
}

// Dijkstra sur des états (format, ce qui a été perdu en route), pour interdire
// par exemple image -> PDF -> texte (fichier vide) ou photo -> GIF -> vidéo.
export function shortestPaths(source) {
  const key = (f, lost) => `${f}|${lost}`;
  const start = key(source, 0);
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const steps = new Map([[start, 0]]);
  const queue = [{ f: source, lost: 0, d: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const { f, lost, d } = queue.shift();
    const k = key(f, lost);
    if (d > dist.get(k) || steps.get(k) >= MAX_STEPS) continue;

    for (const edge of ADJ[f] ?? []) {
      if (edge.needs & lost) continue;
      if (edge.to === source) continue;
      const nlost = lost | edge.drops;
      const nk = key(edge.to, nlost);
      const nd = d + edge.cost + 0.01;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { k, edge });
        steps.set(nk, steps.get(k) + 1);
        queue.push({ f: edge.to, lost: nlost, d: nd });
      }
    }
  }

  // Pour chaque format cible, on garde l'état le moins coûteux
  const result = {};
  for (const [k, d] of dist) {
    const f = k.split("|")[0];
    if (f === source) continue;
    if (!result[f] || d < result[f].cost) {
      const path = [];
      let cur = k;
      while (prev.has(cur)) {
        const p = prev.get(cur);
        path.unshift(p.edge);
        cur = p.k;
      }
      result[f] = { cost: d, path };
    }
  }
  return result;
}

export function allFormatIds() {
  return Object.keys(FORMATS);
}

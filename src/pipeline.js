// Exécute un chemin du graphe, étape par étape.
// Une étape peut produire plusieurs fichiers (un PDF de 10 pages -> 10 images) :
// les étapes suivantes s'appliquent alors à chacun, et le tout finit dans un ZIP.

import { zipSync } from "fflate";
import { runSheet, runTree, runArchive, runPdfWrite } from "./engines-main.js";
import { runPdfText, runPdfRender, runCanvas } from "./engines-browser.js";
import { t } from "./i18n.js";

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL("dist/engine-worker.js"), { type: "module" });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      if (data.type === "progress") job.onProgress?.(data.ratio);
      else {
        pending.delete(data.id);
        if (data.type === "done") job.resolve(data.bytes);
        else job.reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || t("engineCrashed")));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function inWorker(engine, item, from, to, options, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { onProgress, reject, resolve: (bytes) => {
      const base = item.name.replace(/\.[^.]+$/, "");
      resolve([{ name: `${base}.${to}`, bytes }]);
    } });
    const bytes = item.bytes.slice();
    getWorker().postMessage({ id, engine, bytes, from, to, name: item.name, options }, [bytes.buffer]);
  });
}

const MAIN = {
  sheet: runSheet,
  tree: runTree,
  archive: runArchive,
  pdfwrite: runPdfWrite,
  pdftext: runPdfText,
  pdfrender: runPdfRender,
  canvas: runCanvas,
};

async function runStep(edge, item, options, onProgress) {
  if (MAIN[edge.engine]) return MAIN[edge.engine](item, edge.from, edge.to, options, onProgress);
  return inWorker(edge.engine, item, edge.from, edge.to, options, onProgress);
}

// Libellé lisible de chaque moteur, pour l'affichage du chemin
export const ENGINE_LABEL = {
  magick: "ImageMagick", ffmpeg: "ffmpeg", pandoc: "Pandoc", sheet: "SheetJS",
  tree: t("parser"), archive: "fflate", pdfwrite: "pdf-lib", pdftext: "pdf.js",
  pdfrender: "pdf.js", canvas: "Canvas",
};

export async function runPath(file, path, options, onStatus) {
  let items = [{ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }];
  for (let s = 0; s < path.length; s++) {
    const edge = path[s];
    const next = [];
    for (let i = 0; i < items.length; i++) {
      const report = (ratio) => onStatus({ step: s, steps: path.length, edge, ratio: (i + (ratio ?? 0)) / items.length });
      report(0);
      next.push(...(await runStep(edge, items[i], options, report)));
    }
    items = next;
  }
  if (items.length === 1) return items[0];
  // Plusieurs fichiers en sortie : on les regroupe dans un ZIP
  const base = file.name.replace(/\.[^.]+$/, "");
  const zip = zipSync(Object.fromEntries(items.map((it) => [it.name, it.bytes])));
  return { name: `${base}-${path.at(-1).to}.zip`, bytes: zip, count: items.length };
}

// Libère la mémoire des moteurs (ffmpeg et Pandoc pèsent lourd)
export function resetEngines() {
  worker?.terminate();
  worker = null;
}

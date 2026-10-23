// Moteurs qui ont besoin du navigateur : pdf.js (lecture/rendu PDF) et Canvas (SVG).
import * as pdfjs from "pdfjs-dist/build/pdf.mjs";

const url = (p) => chrome.runtime.getURL(`engines/${p}`);
pdfjs.GlobalWorkerOptions.workerSrc = url("pdfjs/pdf.worker.mjs");

const baseName = (name) => name.replace(/\.[^.]+$/, "");

function openPdf(bytes) {
  return pdfjs.getDocument({
    data: bytes.slice(), // pdf.js transfère le buffer : on lui donne une copie
    cMapUrl: url("pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: url("pdfjs/standard_fonts/"),
    wasmUrl: url("pdfjs/wasm/"),
    iccUrl: url("pdfjs/iccs/"),
    isEvalSupported: false,
  }).promise;
}

export async function runPdfText({ name, bytes }, from, to, options, onProgress) {
  const doc = await openPdf(bytes);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let text = "";
    for (const item of content.items) {
      text += item.str ?? "";
      if (item.hasEOL) text += "\n";
    }
    pages.push(text.trim());
    onProgress?.(i / doc.numPages);
  }
  const all = pages.join("\n\n");
  if (!all.trim()) {
    throw new Error("Ce PDF ne contient pas de texte (c'est sans doute un scan ou des images).");
  }
  return [{ name: `${baseName(name)}.txt`, bytes: new TextEncoder().encode(all) }];
}

export async function runPdfRender({ name, bytes }, from, to, options, onProgress) {
  const doc = await openPdf(bytes);
  const mime = to === "jpg" ? "image/jpeg" : "image/png";
  const out = [];
  const pad = String(doc.numPages).length;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 }); // environ 144 dpi
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const blob = await canvas.convertToBlob({ type: mime, quality: options.quality ?? 0.92 });
    const suffix = doc.numPages > 1 ? `-page${String(i).padStart(pad, "0")}` : "";
    out.push({ name: `${baseName(name)}${suffix}.${to}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
    onProgress?.(i / doc.numPages);
  }
  return out;
}

export async function runCanvas({ name, bytes }) {
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode();
    // Un SVG sans taille explicite : on le rend en 1024 px de large
    let w = img.naturalWidth || 1024;
    let h = img.naturalHeight || 1024;
    if (w < 512) { h = Math.round((h * 1024) / w); w = 1024; }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return [{ name: `${baseName(name)}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) }];
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

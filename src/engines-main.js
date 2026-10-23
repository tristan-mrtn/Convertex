// Moteurs légers exécutés directement dans le panneau.
// Chaque moteur reçoit un élément { name, bytes } et renvoie un ou plusieurs éléments.

import * as XLSX from "xlsx";
import * as yaml from "js-yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { zipSync, unzipSync, gzipSync, gunzipSync } from "fflate";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { marked } from "marked";
import { t } from "./i18n.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const baseName = (name) => name.replace(/\.(tar\.gz|[^.]+)$/i, "");

// Chargement des fichiers embarqués (polices, wasm). Remplacé dans les tests Node.
export let loadAsset = async (path) => {
  const res = await fetch(chrome.runtime.getURL(`engines/${path}`));
  return new Uint8Array(await res.arrayBuffer());
};
export function setAssetLoader(fn) { loadAsset = fn; }

/* ---------------- Tableurs (SheetJS) ---------------- */

function readWorkbook(bytes, from) {
  if (from === "json") {
    let data = JSON.parse(dec.decode(bytes));
    if (!Array.isArray(data)) {
      // Un objet dont une clé contient une liste d'objets : on prend cette liste.
      // Sinon l'objet devient une seule ligne, avec une colonne par clé.
      const arr = Object.values(data ?? {}).find((v) => Array.isArray(v) && v.length && typeof v[0] === "object");
      data = arr ?? [data];
    }
    const sheet = Array.isArray(data[0])
      ? XLSX.utils.aoa_to_sheet(data)
      : XLSX.utils.json_to_sheet(data.map((r) => (typeof r === "object" && r ? flatten(r) : { value: r })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    return wb;
  }
  if (from === "csv" || from === "tsv") {
    return XLSX.read(dec.decode(bytes), { type: "string", FS: from === "tsv" ? "\t" : undefined, raw: true });
  }
  return XLSX.read(bytes, { type: "array" });
}

// {a: {b: 1}} -> {"a.b": 1}, pour qu'un JSON imbriqué tienne dans des colonnes
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

export function runSheet({ name, bytes }, from, to) {
  const wb = readWorkbook(bytes, from);
  const base = baseName(name);
  if (["csv", "tsv", "json"].includes(to)) {
    // Un fichier texte par feuille
    const sheets = wb.SheetNames;
    return sheets.map((sheetName) => {
      const sheet = wb.Sheets[sheetName];
      const text = to === "json"
        ? JSON.stringify(XLSX.utils.sheet_to_json(sheet, { defval: null }), null, 2)
        : XLSX.utils.sheet_to_csv(sheet, { FS: to === "tsv" ? "\t" : ",", blankrows: false });
      const suffix = sheets.length > 1 ? `-${sheetName}` : "";
      return { name: `${base}${suffix}.${to}`, bytes: enc.encode(text) };
    });
  }
  const out = XLSX.write(wb, { bookType: to === "xls" ? "biff8" : to, type: "array" });
  return [{ name: `${base}.${to}`, bytes: new Uint8Array(out) }];
}

/* ---------------- Données structurées ---------------- */

const xmlOptions = { ignoreAttributes: false, attributeNamePrefix: "@_", format: true, indentBy: "  " };

function parseTree(text, from) {
  switch (from) {
    case "json": return JSON.parse(text);
    case "yaml": return yaml.load(text);
    case "toml": return parseToml(text);
    case "xml": {
      const data = new XMLParser(xmlOptions).parse(text);
      delete data["?xml"];
      return data;
    }
  }
}

function writeTree(data, to) {
  switch (to) {
    case "json": return JSON.stringify(data, null, 2);
    case "yaml": return yaml.dump(data, { lineWidth: 120 });
    case "toml": {
      const root = data && typeof data === "object" && !Array.isArray(data) ? data : { items: data };
      return stringifyToml(stripNulls(root));
    }
    case "xml": {
      const isSingleRoot = data && typeof data === "object" && !Array.isArray(data)
        && Object.keys(data).length === 1;
      const root = isSingleRoot ? data : { root: Array.isArray(data) ? { item: data } : data };
      return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLBuilder(xmlOptions).build(root)}`;
    }
  }
}

// TOML n'a pas de valeur nulle
function stripNulls(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null).map(stripNulls);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]));
  }
  return v;
}

export function runTree({ name, bytes }, from, to) {
  const data = parseTree(dec.decode(bytes), from);
  return [{ name: `${baseName(name)}.${to}`, bytes: enc.encode(writeTree(data, to)) }];
}

/* ---------------- Archives ---------------- */

function readTar(bytes) {
  const entries = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const header = bytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s, l) => dec.decode(header.subarray(s, s + l)).replace(/\0.*$/s, "");
    let path = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) path = `${prefix}/${path}`;
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    off += 512;
    if (type === "0" || type === "\0") entries.push({ path, bytes: bytes.slice(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function writeTar(entries) {
  const chunks = [];
  for (const { path, bytes } of entries) {
    const header = new Uint8Array(512);
    const put = (s, value, len) => header.set(enc.encode(value).subarray(0, len), s);
    let name = path, prefix = "";
    if (enc.encode(path).length > 100) {
      const cut = path.lastIndexOf("/", 154);
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
    put(0, name, 100);
    put(100, "0000644\0", 8);
    put(108, "0000000\0", 8);
    put(116, "0000000\0", 8);
    put(124, bytes.length.toString(8).padStart(11, "0") + "\0", 12);
    put(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 12);
    header[156] = 48; // fichier normal
    put(257, "ustar\0", 6);
    put(263, "00", 2);
    put(345, prefix, 155);
    header.fill(32, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    put(148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
    chunks.push(header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function runArchive({ name, bytes }, from, to) {
  let entries;
  if (from === "zip") {
    entries = Object.entries(unzipSync(bytes))
      .filter(([path]) => !path.endsWith("/"))
      .map(([path, b]) => ({ path, bytes: b }));
  } else if (from === "tar") entries = readTar(bytes);
  else entries = readTar(gunzipSync(bytes));

  let out;
  if (to === "zip") out = zipSync(Object.fromEntries(entries.map((e) => [e.path, e.bytes])));
  else if (to === "tar") out = writeTar(entries);
  else out = gzipSync(writeTar(entries));
  const ext = to === "tgz" ? "tar.gz" : to;
  return [{ name: `${baseName(name)}.${ext}`, bytes: out }];
}

/* ---------------- Écriture de PDF (Markdown ou texte) ---------------- */

const PAGE = { w: 595.28, h: 841.89, margin: 56 };

async function loadFonts(doc) {
  doc.registerFontkit(fontkit);
  const [regular, bold, italic, mono] = await Promise.all([
    "fonts/DejaVuSans.ttf", "fonts/DejaVuSans-Bold.ttf",
    "fonts/DejaVuSans-Oblique.ttf", "fonts/DejaVuSansMono.ttf",
  ].map(loadAsset));
  return {
    regular: await doc.embedFont(regular, { subset: true }),
    bold: await doc.embedFont(bold, { subset: true }),
    italic: await doc.embedFont(italic, { subset: true }),
    mono: await doc.embedFont(mono, { subset: true }),
  };
}

// Mise en page simple : on pose des "runs" de texte stylés et on gère le retour à la ligne.
class Layout {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
  }
  ensure(h) {
    if (this.y - h < PAGE.margin) this.newPage();
  }
  // runs : [{ text, font, color }]
  paragraph(runs, { size = 11, indent = 0, gapAfter = 6, lineGap = 1.35 } = {}) {
    const maxW = PAGE.w - 2 * PAGE.margin - indent;
    const lineH = size * lineGap;
    let line = [];
    let lineW = 0;
    const flush = () => {
      this.ensure(lineH);
      let x = PAGE.margin + indent;
      for (const part of line) {
        this.page.drawText(part.text, { x, y: this.y - size, size, font: part.font, color: part.color ?? rgb(0.1, 0.1, 0.12) });
        x += part.font.widthOfTextAtSize(part.text, size);
      }
      this.y -= lineH;
      line = [];
      lineW = 0;
    };
    for (const run of runs) {
      const pieces = run.text.split(/(\n)/);
      for (const piece of pieces) {
        if (piece === "\n") { flush(); continue; }
        for (const word of piece.split(/(?<=\s)/)) {
          if (!word) continue;
          const safe = this.safeText(word, run.font);
          const w = run.font.widthOfTextAtSize(safe, size);
          if (lineW + w > maxW && lineW > 0) flush();
          const text = lineW === 0 ? safe.trimStart() : safe;
          if (!text) continue;
          line.push({ text, font: run.font, color: run.color });
          lineW += run.font.widthOfTextAtSize(text, size);
        }
      }
    }
    if (line.length) flush();
    this.y -= gapAfter;
  }
  // Remplace les caractères absents de la police (emoji…) par un point d'interrogation
  safeText(text, font) {
    const supported = font.getCharacterSet?.();
    if (!supported) return text;
    const set = font._charSet ??= new Set(supported);
    return [...text].map((c) => (c === " " || c === "\t" || set.has(c.codePointAt(0)) ? c : "?")).join("");
  }
  rule() {
    this.ensure(12);
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y - 6 }, end: { x: PAGE.w - PAGE.margin, y: this.y - 6 },
      thickness: 0.6, color: rgb(0.75, 0.75, 0.78),
    });
    this.y -= 14;
  }
}

function inlineRuns(tokens, fonts, style = {}) {
  const runs = [];
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case "strong": runs.push(...inlineRuns(tok.tokens, fonts, { ...style, bold: true })); break;
      case "em": runs.push(...inlineRuns(tok.tokens, fonts, { ...style, italic: true })); break;
      case "codespan": runs.push({ text: decodeEntities(tok.text), font: fonts.mono }); break;
      case "link": runs.push(...inlineRuns(tok.tokens, fonts, { ...style, link: true })); break;
      case "br": runs.push({ text: "\n", font: fonts.regular }); break;
      case "image": runs.push({ text: t("imagePlaceholder", tok.text || tok.href), font: fonts.italic }); break;
      default: {
        if (tok.tokens) { runs.push(...inlineRuns(tok.tokens, fonts, style)); break; }
        const font = style.bold ? fonts.bold : style.italic ? fonts.italic : fonts.regular;
        runs.push({ text: decodeEntities(tok.text ?? tok.raw ?? ""), font, color: style.link ? rgb(0.16, 0.3, 0.75) : undefined });
      }
    }
  }
  return runs;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function renderBlocks(layout, tokens, fonts, indent = 0) {
  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const size = [0, 22, 17, 14, 12.5, 11.5, 11][tok.depth];
        layout.y -= tok.depth <= 2 ? 6 : 2;
        layout.paragraph(inlineRuns(tok.tokens, fonts, { bold: true }), { size, indent, gapAfter: 6 });
        break;
      }
      case "paragraph":
        layout.paragraph(inlineRuns(tok.tokens, fonts), { indent });
        break;
      case "text":
        layout.paragraph(inlineRuns(tok.tokens ?? [t], fonts), { indent, gapAfter: 2 });
        break;
      case "list":
        tok.items.forEach((item, i) => {
          const bullet = tok.ordered ? `${(tok.start || 1) + i}. ` : "• ";
          const [first, ...rest] = item.tokens;
          const firstRuns = first?.tokens ? inlineRuns(first.tokens, fonts) : [];
          layout.paragraph([{ text: bullet, font: fonts.regular }, ...firstRuns], { indent: indent + 10, gapAfter: 2 });
          renderBlocks(layout, rest, fonts, indent + 24);
        });
        layout.y -= 4;
        break;
      case "code":
        layout.paragraph([{ text: tok.text, font: fonts.mono, color: rgb(0.2, 0.2, 0.25) }], { size: 9.5, indent: indent + 10, lineGap: 1.3 });
        break;
      case "blockquote":
        renderBlocks(layout, tok.tokens, fonts, indent + 18);
        break;
      case "hr":
        layout.rule();
        break;
      case "table": {
        const row = (cells, bold) => cells.flatMap((c, i) => [
          ...(i ? [{ text: "   |   ", font: fonts.regular, color: rgb(0.6, 0.6, 0.65) }] : []),
          ...inlineRuns(c.tokens, fonts, { bold }),
        ]);
        layout.paragraph(row(tok.header, true), { size: 10, indent, gapAfter: 2 });
        for (const r of tok.rows) layout.paragraph(row(r, false), { size: 10, indent, gapAfter: 2 });
        layout.y -= 6;
        break;
      }
      case "html":
        layout.paragraph([{ text: tok.text.replace(/<[^>]+>/g, ""), font: fonts.regular }], { indent });
        break;
      case "space":
        break;
      default:
        if (tok.raw?.trim()) layout.paragraph([{ text: tok.raw, font: fonts.regular }], { indent });
    }
  }
}

export async function runPdfWrite({ name, bytes }, from) {
  const doc = await PDFDocument.create();
  doc.setTitle(baseName(name));
  doc.setCreator("Convertex");
  const fonts = await loadFonts(doc);
  const layout = new Layout(doc, fonts);
  const text = dec.decode(bytes);
  if (from === "md") {
    renderBlocks(layout, marked.lexer(text), fonts);
  } else {
    for (const para of text.split(/\r?\n/)) {
      layout.paragraph([{ text: para || " ", font: fonts.regular }], { size: 10.5, gapAfter: 0 });
    }
  }
  return [{ name: `${baseName(name)}.pdf`, bytes: await doc.save() }];
}

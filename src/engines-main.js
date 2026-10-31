// Moteurs légers exécutés directement dans le panneau.
// Chaque moteur reçoit un élément { name, bytes } et renvoie un ou plusieurs éléments.

import * as XLSX from "xlsx";
import * as yaml from "js-yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { zipSync, gzipSync } from "fflate";
import { MAX_UNPACKED, unzipLimited, gunzipLimited } from "./zip-limit.js";
import {
  PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  setFillingColor, moveTo, lineTo, appendBezierCurve, closePath, fill,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { Marked } from "marked";
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

/* Sécurité des archives :
   - les chemins sont nettoyés (pas de "..", pas de chemin absolu ni de lettre de
     lecteur), sinon un outil d'extraction pourrait écrire hors du dossier prévu ;
   - la taille décompressée est plafonnée pendant la décompression elle-même
     (zip-limit.js), ce qui arrête les bombes de décompression même si l'archive
     ment sur ses tailles. */
export { MAX_UNPACKED };

export function sanitizePath(path) {
  const parts = String(path)
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/[\x00-\x1f]/g, "").trim())
    .filter((part) => part && part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part));
  return parts.join("/") || "file";
}

function uniquePaths(entries) {
  const seen = new Set();
  return entries.map((e) => {
    let path = sanitizePath(e.path);
    if (seen.has(path)) {
      const dot = path.lastIndexOf(".");
      const [stem, ext] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
      let i = 1;
      while (seen.has(`${stem}-${i}${ext}`)) i++;
      path = `${stem}-${i}${ext}`;
    }
    seen.add(path);
    return { path, bytes: e.bytes };
  });
}

export function runArchive({ name, bytes }, from, to) {
  let entries;
  if (from === "zip") entries = unzipLimited(bytes);
  else if (from === "tar") entries = readTar(bytes);
  else entries = readTar(gunzipLimited(bytes));
  entries = uniquePaths(entries);

  let out;
  if (to === "zip") out = zipSync(Object.fromEntries(entries.map((e) => [e.path, e.bytes])));
  else if (to === "tar") out = writeTar(entries);
  else out = gzipSync(writeTar(entries));
  const ext = to === "tgz" ? "tar.gz" : to;
  return [{ name: `${baseName(name)}.${ext}`, bytes: out }];
}

/* ---------------- Écriture de PDF (Markdown ou texte) ---------------- */

const PAGE = { w: 595.28, h: 841.89, margin: 56 };
const INK = rgb(0.1, 0.1, 0.12);
// Les formules (police Computer Modern de MathJax) paraissent plus petites que
// DejaVu Sans à taille égale : on les grossit un peu pour équilibrer.
const MATH_SCALE = 1.15;

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

// Produit de matrices affines [a, b, c, d, e, f] ; FLIP retourne l'axe y
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const FLIP = [1, 0, 0, -1, 0, 0];

// Chemin SVG -> opérateurs PDF. Les courbes quadratiques (Q, T) deviennent des
// cubiques exactes ; pdf-lib les approche mal, et ses T sont faux, ce qui
// déformait les parenthèses de MathJax.
const PATH_CACHE = new Map();
function pathOperators(d) {
  let ops = PATH_CACHE.get(d);
  if (ops) return ops;
  ops = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0, cmd = "";
  let x = 0, y = 0, sx = 0, sy = 0; // point courant, début du sous-chemin
  let qx = null, qy = null, cx2 = null, cy2 = null; // derniers points de contrôle (Q/T, C/S)
  const num = () => Number(tokens[i++]);
  const quad = (px, py, ex, ey) => {
    // quadratique (x,y) -> (px,py) -> (ex,ey) écrite en cubique
    ops.push(appendBezierCurve(x + (2 / 3) * (px - x), y + (2 / 3) * (py - y), ex + (2 / 3) * (px - ex), ey + (2 / 3) * (py - ey), ex, ey));
    qx = px; qy = py; cx2 = cy2 = null; x = ex; y = ey;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": x = ox + num(); y = oy + num(); sx = x; sy = y; ops.push(moveTo(x, y)); qx = cx2 = null; cmd = rel ? "l" : "L"; break;
      case "L": x = ox + num(); y = oy + num(); ops.push(lineTo(x, y)); qx = cx2 = null; break;
      case "H": x = ox + num(); ops.push(lineTo(x, y)); qx = cx2 = null; break;
      case "V": y = oy + num(); ops.push(lineTo(x, y)); qx = cx2 = null; break;
      case "Q": { const px = ox + num(), py = oy + num(); quad(px, py, ox + num(), oy + num()); break; }
      case "T": {
        const px = qx === null ? x : 2 * x - qx, py = qy === null ? y : 2 * y - qy;
        quad(px, py, ox + num(), oy + num());
        break;
      }
      case "C": {
        const a = ox + num(), b = oy + num(), c = ox + num(), e = oy + num();
        x = ox + num(); y = oy + num();
        ops.push(appendBezierCurve(a, b, c, e, x, y)); cx2 = c; cy2 = e; qx = null;
        break;
      }
      case "S": {
        const a = cx2 === null ? x : 2 * x - cx2, b = cy2 === null ? y : 2 * y - cy2;
        const c = ox + num(), e = oy + num();
        x = ox + num(); y = oy + num();
        ops.push(appendBezierCurve(a, b, c, e, x, y)); cx2 = c; cy2 = e; qx = null;
        break;
      }
      case "A": // arc (absent des polices de MathJax) : segment droit
        i += 5; x = ox + num(); y = oy + num(); ops.push(lineTo(x, y)); qx = cx2 = null; break;
      case "Z": ops.push(closePath()); x = sx; y = sy; qx = cx2 = null; break;
      default: i++; // jeton inattendu : ignoré
    }
  }
  if (PATH_CACHE.size > 5000) PATH_CACHE.clear(); // les glyphes reviennent, les filets varient
  PATH_CACHE.set(d, ops);
  return ops;
}

// Mise en page simple : on pose des "runs" de texte stylés (ou des formules) et on
// gère le retour à la ligne.
class Layout {
  constructor(doc, fonts, math) {
    this.doc = doc;
    this.fonts = fonts;
    this.math = math; // module MathJax, chargé seulement si le document a des formules
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
  }
  ensure(h) {
    if (this.y - h < PAGE.margin) this.newPage();
  }
  // Formule composée par MathJax : largeur, hauteur au-dessus et au-dessous de la
  // ligne de base, en points. Réduite si elle dépasse la largeur disponible.
  mathBox(tex, display, size, maxW) {
    if (!this.math) return null;
    let vector;
    try {
      vector = this.math.texToVector(tex, display);
    } catch {
      return null; // TeX invalide : affiché tel quel
    }
    let scale = size * MATH_SCALE;
    if (vector.width * scale > maxW) scale = maxW / vector.width;
    return { vector, scale, width: vector.width * scale, ascent: vector.ascent * scale, descent: vector.descent * scale };
  }
  drawBox(box, x, baseline) {
    const place = [box.scale, 0, 0, box.scale, x, baseline];
    for (const op of box.vector.ops) {
      const color = op.color ? rgb(...op.color) : INK;
      if (op.type === "path") {
        this.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...mul(place, op.m)),
          setFillingColor(color), ...pathOperators(op.d), fill(), popGraphicsState());
      } else {
        // le texte SVG se lit axe y vers le bas : on le retourne
        const font = op.bold ? this.fonts.bold : op.italic ? this.fonts.italic : this.fonts.regular;
        this.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...mul(mul(place, op.m), FLIP)));
        this.page.drawText(this.safeText(op.text, font), { x: 0, y: 0, size: op.size, font, color });
        this.page.pushOperators(popGraphicsState());
      }
    }
  }
  // runs : [{ text, font, color }] ou [{ math, display }]
  paragraph(runs, { size = 11, indent = 0, gapAfter = 6, lineGap = 1.35 } = {}) {
    const maxW = PAGE.w - 2 * PAGE.margin - indent;
    // Morceaux à poser : mots (avec leur espace final) et formules. « glued » : collé
    // au morceau précédent, sans espace, donc pas de retour à la ligne entre les deux
    // (une formule et le point qui la suit).
    const items = [];
    let afterSpace = true;
    for (let run of runs) {
      if (run.math !== undefined) {
        const box = this.mathBox(run.math, run.display, size, maxW);
        if (box) {
          items.push({ box, width: box.width, glued: !afterSpace });
          afterSpace = false;
          continue;
        }
        run = { text: run.display ? `$$${run.math}$$` : `$${run.math}$`, font: this.fonts.mono };
      }
      for (const piece of run.text.split(/(\n)/)) {
        if (piece === "\n") { items.push({ newline: true }); afterSpace = true; continue; }
        for (const word of piece.split(/(?<=\s)/)) {
          if (!word) continue;
          const text = this.safeText(word, run.font);
          items.push({ text, font: run.font, color: run.color, width: run.font.widthOfTextAtSize(text, size), glued: !afterSpace && !/^\s/.test(text) });
          afterSpace = /\s$/.test(text);
        }
      }
    }

    let line = [];
    let lineW = 0;
    const flush = () => {
      // une formule haute (fraction, somme…) agrandit l'interligne
      let ascent = size;
      let descent = size * (lineGap - 1);
      for (const part of line) {
        if (!part.box) continue;
        ascent = Math.max(ascent, part.box.ascent + size * 0.3);
        descent = Math.max(descent, part.box.descent + size * 0.25);
      }
      this.ensure(ascent + descent);
      const baseline = this.y - ascent;
      let x = PAGE.margin + indent;
      for (const part of line) {
        if (part.box) this.drawBox(part.box, x, baseline);
        else this.page.drawText(part.text, { x, y: baseline, size, font: part.font, color: part.color ?? INK });
        x += part.width;
      }
      this.y -= ascent + descent;
      line = [];
      lineW = 0;
    };
    for (let i = 0; i < items.length;) {
      if (items[i].newline) { flush(); i++; continue; }
      let j = i + 1;
      while (j < items.length && !items[j].newline && items[j].glued) j++;
      const unit = items.slice(i, j);
      if (lineW + unit.reduce((w, it) => w + it.width, 0) > maxW && lineW > 0) flush();
      for (const it of unit) {
        if (lineW === 0 && it.text !== undefined) {
          const text = it.text.trimStart();
          if (!text) continue;
          const width = it.font.widthOfTextAtSize(text, size);
          line.push({ ...it, text, width });
          lineW += width;
        } else {
          line.push(it);
          lineW += it.width;
        }
      }
      i = j;
    }
    if (line.length) flush();
    this.y -= gapAfter;
  }
  // Formule centrée sur sa propre ligne
  displayMath(tex, { size = 11, indent = 0 } = {}) {
    const maxW = PAGE.w - 2 * PAGE.margin - indent;
    const box = this.mathBox(tex, true, size, maxW);
    if (!box) {
      this.paragraph([{ text: tex, font: this.fonts.mono, color: rgb(0.2, 0.2, 0.25) }], { size: 9.5, indent: indent + 10, lineGap: 1.3 });
      return;
    }
    const gap = size * 0.6;
    this.ensure(gap + box.ascent + box.descent + gap);
    const baseline = this.y - gap - box.ascent;
    this.drawBox(box, PAGE.margin + indent + (maxW - box.width) / 2, baseline);
    this.y = baseline - box.descent - gap;
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

/* Formules dans le Markdown : $…$, $$…$$, \(…\), \[…\], $`…`$ (GitHub), blocs
   ```math et environnements \begin{align}… écrits sans délimiteurs. */
const MATH_ENV = /^(?:equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math)\*?$/;
// « \[1\] » est souvent un crochet échappé : sur une seule ligne, il faut quelque
// chose de mathématique dedans pour y voir une formule
const looksLikeMath = (tex) => /[\\^_=<>]/.test(tex) || tex.includes("\n");

const mathInline = {
  name: "math",
  level: "inline",
  start(src) {
    const i = src.search(/(?<!\\)\$|\\[([]/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const make = (m, display) => ({ type: "math", raw: m[0], text: m[1].trim(), display });
    let m;
    if ((m = /^\$`([^`]+)`\$/.exec(src))) return make(m, false);
    if ((m = /^\$\$((?:(?!\$\$)[\s\S])+?)\$\$/.exec(src))) return make(m, true);
    if ((m = /^\\\(([\s\S]+?)\\\)/.exec(src))) return make(m, false);
    if ((m = /^\\\[([\s\S]+?)\\\]/.exec(src)) && looksLikeMath(m[1])) return make(m, true);
    if ((m = /^\$(?![\s$])((?:\\[\s\S]|[^\\$])+?)\$(?!\d)/.exec(src)) && !/\s$/.test(m[1])) return make(m, false);
    return undefined;
  },
};

const mathBlock = {
  name: "mathBlock",
  level: "block",
  start(src) {
    const m = /^ {0,3}(?:\$\$|\\\[|\\begin\{)/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    let m = /^ {0,3}\$\$((?:(?!\$\$)(?!\n[ \t]*\n)[\s\S])+?)\$\$[ \t]*(?:\n+|$)/.exec(src)
      ?? /^ {0,3}\\\[((?:(?!\\\])(?!\n[ \t]*\n)[\s\S])+?)\\\][ \t]*(?:\n+|$)/.exec(src);
    if (m && (m[0].trimStart().startsWith("$$") || looksLikeMath(m[1]))) {
      return { type: "mathBlock", raw: m[0], text: m[1].trim() };
    }
    m = /^ {0,3}(\\begin\{([A-Za-z]+\*?)\}(?:(?!\n[ \t]*\n)[\s\S])+?\\end\{\2\})[ \t]*(?:\n+|$)/.exec(src);
    if (m && MATH_ENV.test(m[2])) return { type: "mathBlock", raw: m[0], text: m[1] };
    return undefined;
  },
};

const markdown = new Marked({ extensions: [mathBlock, mathInline] });

function hasMath(tokens) {
  for (const tok of tokens ?? []) {
    if (tok.type === "math" || tok.type === "mathBlock" || (tok.type === "code" && tok.lang === "math")) return true;
    if (hasMath(tok.tokens) || hasMath(tok.items)) return true;
    if (tok.type === "table" && [tok.header, ...tok.rows].some((row) => row.some((cell) => hasMath(cell.tokens)))) return true;
  }
  return false;
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
      case "math": runs.push({ math: tok.text, display: tok.display }); break;
      // balise HTML dans le texte (lien avec attributs écrit par Pandoc…) : seul son contenu compte
      case "html": if (/^<br\s*\/?>$/i.test(tok.text.trim())) runs.push({ text: "\n", font: fonts.regular }); break;
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

// Paragraphe qui peut contenir des formules centrées ($$…$$ au milieu du texte, ou
// dans l'énoncé en italique d'un théorème) : le texte est coupé autour de chacune.
function paragraphWithMath(layout, tokens, fonts, { indent, gapAfter = 6 }) {
  const parts = [[]];
  for (const run of inlineRuns(tokens, fonts)) {
    if (run.math !== undefined && run.display) parts.push(run, []);
    else parts.at(-1).push(run);
  }
  parts.forEach((part, i) => {
    if (!Array.isArray(part)) { layout.displayMath(part.math, { indent }); return; }
    if (!part.some((r) => r.math !== undefined || r.text.trim())) return;
    layout.paragraph(part, { indent, gapAfter: i === parts.length - 1 ? gapAfter : 2 });
  });
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
        paragraphWithMath(layout, tok.tokens, fonts, { indent });
        break;
      case "text":
        paragraphWithMath(layout, tok.tokens ?? [tok], fonts, { indent, gapAfter: 2 });
        break;
      case "mathBlock":
        layout.displayMath(tok.text, { indent });
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
        if (tok.lang === "math") layout.displayMath(tok.text, { indent });
        else layout.paragraph([{ text: tok.text, font: fonts.mono, color: rgb(0.2, 0.2, 0.25) }], { size: 9.5, indent: indent + 10, lineGap: 1.3 });
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
  const text = dec.decode(bytes);
  if (from === "md") {
    const tokens = markdown.lexer(text);
    // MathJax n'est chargé que si le document contient des formules
    const math = hasMath(tokens) ? await import("./math-svg.js") : null;
    renderBlocks(new Layout(doc, fonts, math), tokens, fonts);
  } else {
    const layout = new Layout(doc, fonts, null);
    for (const para of text.split(/\r?\n/)) {
      layout.paragraph([{ text: para || " ", font: fonts.regular }], { size: 10.5, gapAfter: 0 });
    }
  }
  return [{ name: `${baseName(name)}.pdf`, bytes: await doc.save() }];
}

// Conversion d'un document avec Pandoc (WebAssembly).
// Séparé du worker pour pouvoir être testé tel quel depuis Node.
// Les formules passent par le filtre math.lua (fourni par l'appelant) entre la
// lecture et l'écriture.

import { zipSync } from "fflate";
import { t } from "./i18n.js";
import { unzipLimited } from "./zip-limit.js";

const PANDOC_READER = {
  // \( … \) et \[ … \] : la notation des formules copiées d'un assistant ou de MathJax
  md: "markdown+tex_math_single_backslash",
  txt: "markdown", tex: "latex", typ: "typst", adoc: "asciidoc", wiki: "mediawiki", dbk: "docbook",
};
const PANDOC_WRITER = {
  // formules en $…$ et $$…$$, que lisent GitHub, Obsidian, Jupyter… et Convertex
  md: "gfm+tex_math_dollars-tex_math_gfm",
  txt: "plain", tex: "latex", typ: "typst", adoc: "asciidoc",
  wiki: "mediawiki", dbk: "docbook5", epub: "epub3", html: "html5",
};
const BINARY_IO = new Set(["docx", "odt", "epub", "pptx"]);
const STANDALONE = new Set(["html", "tex", "typ", "rtf", "dbk", "fb2", "ipynb"]);
// Formules en MathML, que les navigateurs, les liseuses et DocBook affichent sans script
const MATHML = new Set(["html", "epub", "dbk"]);
const NO_WRAP = new Set(["md", "ipynb", "adoc", "txt"]);

const dec = new TextDecoder();
const enc = new TextEncoder();

// Texte brut lu par le lecteur Markdown : tous les caractères qui ont un sens en
// Markdown sont échappés (un « * » ou un « $ » restent des caractères).
export function plainToMarkdown(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[\\`*_{}[\]()#+\-.!|<>$~^&=:@%"']/g, "\\$&"))
    .join("\n");
}

/* ---------- Formules rangées dans des objets (ODT, PPTX) ----------
   Pandoc ne lit pas les objets formule d'un ODT, et perd tout le texte d'une
   diapositive PPTX qui contient une équation. On remplace chaque formule par un
   repère (caractères à usage privé U+E000 n U+E001), on traduit les formules en
   TeX avec Pandoc lui-même, et math.lua remet les formules à la place des repères. */

const mark = (i) => `\uE000${i}\uE001`;

// Un coefficient binomial s'écrit en MathML comme une fraction sans trait ;
// Pandoc ne le reconnaît que si l'épaisseur a une unité (« 0pt »).
const fixMathml = (s) => s.replace(/linethickness\s*=\s*(["'])0(?:\.0*)?(?:px)?\1/g, 'linethickness="0pt"');

function rezip(entries, changed) {
  const files = {};
  for (const e of entries) {
    const data = changed.get(e.path) ?? e.bytes;
    // le fichier mimetype des documents OpenDocument reste non compressé
    files[e.path] = e.path === "mimetype" ? [data, { level: 0 }] : data;
  }
  return zipSync(files);
}

// Formules MathML -> TeX, en une seule lecture par Pandoc
async function mathmlToTex(pandoc, list) {
  const html = list.map((m) => `<p>${m}</p>`).join("\n");
  const res = await pandoc.convert({ from: "html", to: "json" }, html, {});
  return texOfParagraphs(res.stdout, list.length);
}

// Formules OMML -> TeX : un petit DOCX lu par Pandoc
async function ommlToTex(pandoc, list) {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
  const body = list.map((o) => `<w:p>${o}</w:p>`).join("");
  const docx = zipSync({
    "[Content_Types].xml": enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${body}</w:body></w:document>`),
  });
  const res = await pandoc.convert({ from: "docx", to: "json", "input-files": ["f.docx"] }, null, { "f.docx": new Blob([docx]) });
  return texOfParagraphs(res.stdout, list.length);
}

// Une formule par paragraphe : "I:tex" (en ligne) ou "D:tex" (centrée), ou null
function texOfParagraphs(json, count) {
  const out = new Array(count).fill(null);
  let ast;
  try { ast = JSON.parse(json); } catch { return out; }
  const paras = (ast.blocks ?? []).filter((b) => b.t === "Para" || b.t === "Plain");
  if (paras.length !== count) return out; // décalage : on ne risque pas d'inverser des formules
  paras.forEach((p, i) => {
    const m = p.c.find((x) => x.t === "Math");
    if (m) out[i] = `${m.c[0].t === "DisplayMath" ? "D" : "I"}:${m.c[1]}`;
  });
  return out;
}

const ODT_FRAME = /<draw:frame\b[^>]*>(?:(?!<\/?draw:frame\b)[\s\S])*?<draw:object\b[^>]*?xlink:href="([^"]+)"[^>]*>(?:(?!<\/?draw:frame\b)[\s\S])*?<\/draw:frame>/g;

async function odtFormulas(pandoc, bytes) {
  // coup d'œil sur content.xml seul : la plupart des documents n'ont aucun objet
  const peek = unzipLimited(bytes, (name) => name === "content.xml")[0];
  if (!peek || !dec.decode(peek.bytes).includes("<draw:object")) return null;
  const entries = unzipLimited(bytes);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const content = byPath.get("content.xml");
  if (!content) return null;
  const xml = dec.decode(content.bytes);
  const found = [];
  const replaced = xml.replace(ODT_FRAME, (frame, href) => {
    const dir = href.replace(/^\.\//, "").replace(/\/$/, "");
    const obj = byPath.get(`${dir}/content.xml`);
    const math = obj && /<(?:\w+:)?math\b[\s\S]*<\/(?:\w+:)?math>/.exec(dec.decode(obj.bytes))?.[0];
    if (!math) return frame;
    found.push(fixMathml(math)
      .replace(/<(\/?)\w+:(\w)/g, "<$1$2") // préfixe math: éventuel
      .replace(/<annotation\b[^>]*encoding="StarMath[^"]*"[^>]*>[\s\S]*?<\/annotation>/g, ""));
    return `<text:span>${mark(found.length - 1)}</text:span>`;
  });
  if (!found.length) return null;
  const tex = await mathmlToTex(pandoc, found);
  // un objet formule est toujours « en ligne » : math.lua centre ceux qui sont seuls
  // dans leur paragraphe
  const formulas = tex.map((f) => (f ? `I:${f.slice(2)}` : "I:"));
  return { bytes: rezip(entries, new Map([["content.xml", enc.encode(replaced)]])), formulas };
}

const SLIDE = /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/;

async function pptxFormulas(pandoc, bytes) {
  const slides = unzipLimited(bytes, (name) => SLIDE.test(name));
  if (!slides.some((e) => dec.decode(e.bytes).includes("<a14:m>"))) return null;
  const entries = unzipLimited(bytes);
  const omml = [];
  const changed = new Map();
  for (const e of entries) {
    if (!SLIDE.test(e.path)) continue;
    let xml = dec.decode(e.bytes);
    if (!xml.includes("<a14:m>")) continue;
    xml = xml.replace(/<a14:m>([\s\S]*?)<\/a14:m>/g, (all, inner) => {
      omml.push(inner);
      return `<a:r><a:t>${mark(omml.length - 1)}</a:t></a:r>`;
    });
    // la variante « a14 » (avec la formule) remplace l'image de secours
    xml = xml.replace(/<mc:AlternateContent\b[^>]*>\s*<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>[\s\S]*?<\/mc:AlternateContent>/g,
      (all, choice) => (choice.includes("\uE000") ? choice : all));
    changed.set(e.path, enc.encode(xml));
  }
  if (!omml.length) return null;
  const formulas = (await ommlToTex(pandoc, omml)).map((f) => f ?? "I:");
  return { bytes: rezip(entries, changed), formulas };
}

// EPUB : mêmes retouches du MathML que pour une page HTML
const PAGE_FILE = /\.(x?html?|xml)$/i;

function epubMathml(bytes) {
  const pages = unzipLimited(bytes, (name) => PAGE_FILE.test(name));
  if (!pages.some((e) => /linethickness\s*=\s*["']0/.test(dec.decode(e.bytes)))) return bytes;
  const entries = unzipLimited(bytes);
  const changed = new Map();
  for (const e of entries) {
    if (!PAGE_FILE.test(e.path)) continue;
    const xml = dec.decode(e.bytes);
    if (/linethickness/.test(xml)) changed.set(e.path, enc.encode(fixMathml(xml)));
  }
  return changed.size ? rezip(entries, changed) : bytes;
}

export async function convertWithPandoc(pandoc, { bytes, from, to, name }, { lua } = {}) {
  const options = {
    from: PANDOC_READER[from] ?? from,
    to: PANDOC_WRITER[to] ?? to,
    standalone: STANDALONE.has(to),
    metadata: { pagetitle: name.replace(/\.[^.]+$/, "") },
  };
  if (to === "html") options["embed-resources"] = true;
  if (MATHML.has(to)) options["html-math-method"] = { method: "mathml" };
  // Un paragraphe par ligne : une ligne coupée avant « : » (typographie française)
  // deviendrait une liste de définitions, AsciiDoc ne relit pas une formule
  // coupée en deux lignes, et le texte brut garde ses formules d'un seul tenant
  // (comme un PDF converti en texte)
  if (NO_WRAP.has(to)) options.wrap = "none";

  const files = {};
  if (lua) {
    files["convertex.lua"] = new Blob([lua]);
    options.filters = ["convertex.lua"];
    Object.assign(options.metadata, { "cvx-from": from, "cvx-to": to });
  }

  let stdin = null;
  if (BINARY_IO.has(from)) {
    let input = bytes;
    const extract = from === "odt" ? odtFormulas : from === "pptx" ? pptxFormulas : null;
    if (extract && lua) {
      const found = await extract(pandoc, bytes);
      if (found) {
        input = found.bytes;
        options.metadata["cvx-math"] = found.formulas;
      }
    }
    if (from === "epub") input = epubMathml(bytes);
    const inName = `entree.${from}`;
    files[inName] = new Blob([input]);
    options["input-files"] = [inName];
  } else {
    stdin = dec.decode(bytes);
    if (from === "txt") stdin = plainToMarkdown(stdin);
    if (from === "html") stdin = fixMathml(stdin);
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
  return enc.encode(out);
}

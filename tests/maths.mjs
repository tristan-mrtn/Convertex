// Vérifie que les formules ont survécu aux conversions des fichiers de
// tests/fixtures/maths (à lancer après tests/e2e.mjs sur ce dossier) :
//   node tests/e2e.mjs tests/fixtures/maths && node tests/maths.mjs
//
// Pour chaque sortie : nombre de formules (relu par Pandoc, ou compté dans le
// fichier pour les formats que Pandoc relit mal) comparé au nombre attendu. Un
// PDF écrit par Convertex ne doit plus contenir de code TeX : les formules y
// sont dessinées.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { createPandocInstance } from "../node_modules/pandoc-wasm/src/core.js";

const ROOT = resolve(import.meta.dirname, "..");
const report = JSON.parse(readFileSync(process.argv[2] ?? join(ROOT, "tests/out/rapport.json"), "utf8"));
const pandoc = await createPandocInstance(readFileSync(join(ROOT, "node_modules/pandoc-wasm/src/pandoc.wasm")));
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

// Formules attendues dans chaque fichier d'exemple (en ligne + centrées)
const EXPECTED = {
  "poly-libreoffice.odt": 22, "quarto.html": 22, "github.md": 3, "assistant.md": 5,
  "environnements.md": 3, "echappements.md": 3, "algebre.tex": 10, "integrales.typ": 7,
  "mathjax.html": 4, "wikipedia.html": 1, "redmine.textile": 3, "katex.html": 2, "katex-binome.html": 1, "integration.tex": 27,
};
const expected = (file) => EXPECTED[file] ?? (file.startsWith("poly.") ? 22 : null);
// PDF relus : la reconstruction ne retrouve pas chaque lettre isolée en formule,
// on attend un minimum
const PDF_MIN = { "algebre-lmodern.pdf": 10 };
const pdfMin = (file) => PDF_MIN[file] ?? 20;

const READER = { md: "markdown", tex: "latex", adoc: "asciidoc", ipynb: "ipynb" };
const dec = new TextDecoder();
const count = (s, re) => (s.match(re) ?? []).length;

async function viaPandoc(bytes, fmt) {
  const binary = fmt === "docx";
  const opts = { from: READER[fmt] ?? fmt, to: "json" };
  const files = {};
  if (binary) { files["f.docx"] = new Blob([bytes]); opts["input-files"] = ["f.docx"]; }
  const res = await pandoc.convert(opts, binary ? null : dec.decode(bytes), files);
  let n = 0;
  let bad = 0;
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    if (x.t === "Math") { n++; if (/`|^\s*$/.test(x.c[1])) bad++; return; }
    if (x.t === "CodeBlock" && x.c[0][1].includes("math")) bad++;
    Object.values(x).forEach(walk);
  };
  walk(JSON.parse(res.stdout || "{}").blocks);
  return bad ? -bad : n;
}

// Nombre de formules d'une sortie, ou null si le format n'a pas de notation mathématique
async function formulas(bytes, fmt) {
  const files = () => Object.entries(unzipSync(bytes));
  switch (fmt) {
    case "odt": return files().filter(([p, b]) => /^[^/]+\/content\.xml$/.test(p) && /<(\w+:)?math\b/.test(dec.decode(b))).length;
    case "pptx": return files().filter(([p]) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).reduce((n, [, b]) => n + count(dec.decode(b), /<a14:m>/g), 0);
    case "epub": return files().filter(([p]) => /\.xhtml$/.test(p)).reduce((n, [, b]) => n + count(dec.decode(b), /<math\b/g), 0);
    case "html": return count(dec.decode(bytes), /<math\b/g);
    case "dbk": return count(dec.decode(bytes), /<(inline|informal)equation>/g);
    case "wiki": return count(dec.decode(bytes), /<math\b/g);
    case "typ": {
      const body = dec.decode(bytes).replace(/^[\s\S]*?(?=^=\s)/m, "");
      return count(body.replace(/\\\$/g, ""), /\$[^$]+\$/g);
    }
    case "md": case "tex": case "docx": case "rst": case "org": case "adoc": case "ipynb":
      return viaPandoc(bytes, fmt);
    default: return null;
  }
}

async function pdfText(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it) => it.str).join(" ");
  }
  return text;
}

// Code TeX resté visible (une formule que l'on n'a pas su composer ou mettre à plat)
const TEX_LEFT = /\\(frac|d?sum|int|begin|end|math(bb|cal|rm|bf)|sqrt|left|right|alpha|varepsilon|text|lim|cdot|quad|binom|operatorname|infty|le|ge|leq|geq|to|in)\b|\$\$?[\\{a-zA-Z]/;
// Formats sans notation mathématique : les formules y sont écrites en texte lisible
const LINEAR = new Set(["txt", "rtf", "fb2"]);

function linearText(bytes, fmt) {
  const s = dec.decode(bytes);
  // RTF : une barre oblique inverse du texte s'écrit « \\ »
  if (fmt === "rtf") return s.replace(/\\\\/g, "\u0000").replace(/\\[a-z]+-?\d* ?|[{}]/g, "").replace(/\u0000/g, "\\");
  if (fmt === "fb2") return s.replace(/<binary\b[\s\S]*?<\/binary>/g, "").replace(/<[^>]+>/g, " ");
  return s;
}

const failures = [];
let checked = 0;
for (const r of report.filter((x) => x.ok)) {
  const want = r.from === "pdf" ? pdfMin(r.file) : expected(r.file);
  if (want == null) continue;
  const bytes = new Uint8Array(readFileSync(r.out));
  if (r.to === "pdf" && r.from !== "pdf") {
    checked++;
    const tex = (await pdfText(bytes)).match(TEX_LEFT);
    if (tex) failures.push(`${r.file} -> pdf : code TeX visible (« ${tex[0]} »)`);
    continue;
  }
  if (LINEAR.has(r.to)) {
    checked++;
    const tex = linearText(bytes, r.to).match(TEX_LEFT);
    if (tex) failures.push(`${r.file} -> ${r.to} : code TeX visible (« ${tex[0]} »)`);
    continue;
  }
  const n = await formulas(bytes, r.to);
  if (n == null) continue;
  checked++;
  const ok = r.from === "pdf" ? n >= want : n === want;
  if (!ok) failures.push(`${r.file} -> ${r.to} : ${n < 0 ? `${-n} formule(s) abîmée(s)` : `${n} formules au lieu de ${want}`}`);
}

for (const f of failures) console.log(`ÉCHEC ${f}`);
console.log(`\n${checked - failures.length}/${checked} sorties gardent leurs formules`);
process.exit(failures.length ? 1 : 0);

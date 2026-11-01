// Formules TeX mises en forme par MathJax (sortie SVG), sans DOM ni réseau :
// le résultat est une liste de tracés vectoriels que l'écriture de PDF dessine.
// Chargé seulement quand un document contient des formules.

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

let ready = null;

function setup() {
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    // pas d'extension chargée à la volée : tout est déjà dans le paquet
    packages: AllPackages.filter((p) => p !== "require" && p !== "autoload"),
    // une erreur de syntaxe est remontée : le texte TeX est alors affiché tel quel
    formatError: (jax, err) => { throw err; },
  });
  const svg = new SVG({ fontCache: "none" });
  const doc = mathjax.document("", { InputJax: tex, OutputJax: svg });
  return { adaptor, doc, tex };
}

// Matrices affines [a, b, c, d, e, f] (même convention que SVG et PDF)
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const ID = [1, 0, 0, 1, 0, 0];

function parseTransform(value) {
  let m = ID;
  for (const [, fn, args] of String(value ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === "translate") m = mul(m, [1, 0, 0, 1, v[0] || 0, v[1] || 0]);
    else if (fn === "scale") m = mul(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else if (fn === "matrix" && v.length === 6) m = mul(m, v);
    else if (fn === "rotate") {
      const r = ((v[0] || 0) * Math.PI) / 180;
      m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
    }
  }
  return m;
}

const NAMED = { red: [1, 0, 0], black: [0, 0, 0], blue: [0, 0, 1], green: [0, 0.5, 0], white: [1, 1, 1], gray: [0.5, 0.5, 0.5] };
function parseColor(value) {
  if (!value || value === "currentColor" || value === "none") return null;
  if (NAMED[value]) return NAMED[value];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  return null;
}

// Parcourt l'arbre SVG produit par MathJax et collecte les tracés, avec leur
// transformation complète. Unités : millièmes d'em, axe y vers le bas (SVG).
function collect(adaptor, node, matrix, color, out) {
  if (adaptor.kind(node) === "#text") return;
  const kind = adaptor.kind(node);
  const attr = (n) => adaptor.getAttribute(node, n);
  const m = mul(matrix, parseTransform(attr("transform")));
  const c = parseColor(attr("fill")) ?? color;
  if (kind === "path") {
    const d = attr("d");
    if (d) out.push({ type: "path", d, m, color: c });
  } else if (kind === "rect") {
    const x = +attr("x") || 0, y = +attr("y") || 0, w = +attr("width") || 0, h = +attr("height") || 0;
    if (w > 0 && h > 0) out.push({ type: "path", d: `M${x} ${y}H${x + w}V${y + h}H${x}Z`, m, color: c });
  } else if (kind === "line") {
    // filets de \cancel, \overline… dessinés comme un rectangle fin
    const x1 = +attr("x1") || 0, y1 = +attr("y1") || 0, x2 = +attr("x2") || 0, y2 = +attr("y2") || 0;
    const w = +attr("stroke-width") || 40;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = (-(y2 - y1) / len) * (w / 2), ny = ((x2 - x1) / len) * (w / 2);
    out.push({ type: "path", d: `M${x1 + nx} ${y1 + ny}L${x2 + nx} ${y2 + ny}L${x2 - nx} ${y2 - ny}L${x1 - nx} ${y1 - ny}Z`, m, color: parseColor(attr("stroke")) ?? c });
  } else if (kind === "text") {
    // caractère absent des polices de MathJax (lettre accentuée dans \text{}…)
    const text = adaptor.textContent(node);
    const size = parseFloat(attr("font-size")) || 1000;
    const variant = attr("data-variant") ?? "";
    if (text) out.push({ type: "text", text, size, m, color: c, bold: /bold/.test(variant), italic: /italic/.test(variant) });
    return;
  }
  for (const child of adaptor.childNodes(node)) collect(adaptor, child, m, c, out);
}

// TeX -> { width, ascent, descent (en em), ops }. Coordonnées des tracés en em,
// origine sur la ligne de base, axe y vers le haut.
export function texToVector(tex, display) {
  ready ??= setup();
  const { adaptor, doc } = ready;
  // Numéros d'équation : MathJax les place au bord d'une ligne de largeur inconnue
  // ici ; on les écrit juste après la formule. Les étiquettes ne servent plus.
  const source = tex
    .replace(/\\tag\*\s*\{([^{}]*)\}/g, "\\qquad \\text{$1}")
    .replace(/\\tag\s*\{([^{}]*)\}/g, "\\qquad \\text{($1)}")
    .replace(/\\label\s*\{[^{}]*\}|\\nonumber\b|\\notag\b/g, "");
  const container = doc.convert(source, { display });
  const svg = adaptor.childNodes(container).find((n) => adaptor.kind(n) === "svg");
  const viewBox = svg && adaptor.getAttribute(svg, "viewBox");
  if (!viewBox) throw new Error("MathJax : sortie inattendue");
  const [minX, minY, w, h] = viewBox.split(/\s+/).map(Number);
  const ops = [];
  // millièmes d'em (y vers le bas) -> em (y vers le haut, origine sur la ligne de base)
  const root = [1 / 1000, 0, 0, -1 / 1000, -minX / 1000, 0];
  for (const child of adaptor.childNodes(svg)) collect(adaptor, child, root, null, ops);
  return { width: w / 1000, ascent: -minY / 1000, descent: (minY + h) / 1000, ops };
}

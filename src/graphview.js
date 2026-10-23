// Dessin du graphe en SVG, avec zoom (molette) et déplacement (glisser).
import { FORMATS, FAMILIES } from "./formats.js";
import { EDGES } from "./graph.js";
import { t } from "./i18n.js";

const NS = "http://www.w3.org/2000/svg";
const SIZE = 1000;
const C = SIZE / 2;
const FAMILY_ORDER = Object.keys(FAMILIES);

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

const polar = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
const byFamily = (a, b) =>
  FAMILY_ORDER.indexOf(FORMATS[a].family) - FAMILY_ORDER.indexOf(FORMATS[b].family)
  || FORMATS[a].label.localeCompare(FORMATS[b].label);

// Ajoute zoom et déplacement à un SVG. Renvoie une fonction qui dit si
// le dernier clic était en fait un glisser (pour ne pas sélectionner par erreur).
function enablePanZoom(svg) {
  let vb = { x: 0, y: 0, w: SIZE, h: SIZE };
  const MIN_W = SIZE / 6; // zoom maximum : x6

  // La vue reste toujours à l'intérieur du graphe : pas de dézoom au-delà
  // de la vue complète, et pas de déplacement hors de l'image.
  const clamp = (v) => {
    const w = Math.min(SIZE, Math.max(MIN_W, v.w));
    return {
      w, h: w,
      x: Math.min(SIZE - w, Math.max(0, v.x)),
      y: Math.min(SIZE - w, Math.max(0, v.y)),
    };
  };
  const apply = () => {
    vb = clamp(vb);
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.parentElement?.classList.toggle("zoomed", vb.w < SIZE - 0.5);
  };
  apply();

  const toSvg = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    return [vb.x + ((cx - r.left) / r.width) * vb.w, vb.y + ((cy - r.top) / r.height) * vb.h];
  };

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.0015);
    const nw = Math.min(SIZE, Math.max(MIN_W, vb.w * k));
    const [px, py] = toSvg(e.clientX, e.clientY);
    const f = nw / vb.w;
    vb = { x: px - (px - vb.x) * f, y: py - (py - vb.y) * f, w: nw, h: nw };
    apply();
  }, { passive: false });

  // Double-clic : retour à la vue complète
  svg.addEventListener("dblclick", () => {
    vb = { x: 0, y: 0, w: SIZE, h: SIZE };
    apply();
  });

  let drag = null;
  let moved = false;
  svg.addEventListener("pointerdown", (e) => {
    moved = false;
    // Sans zoom, il n'y a rien à déplacer
    drag = vb.w < SIZE - 0.5 ? { x: e.clientX, y: e.clientY, vb: { ...vb } } : null;
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const dx = ((e.clientX - drag.x) / r.width) * vb.w;
    const dy = ((e.clientY - drag.y) / r.height) * vb.h;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) {
      moved = true;
      svg.setPointerCapture(e.pointerId);
    }
    vb = { ...vb, x: drag.vb.x - dx, y: drag.vb.y - dy };
    apply();
  });
  const end = () => { drag = null; };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  return () => moved;
}

function drawNode(g, x, y, id, r, { label = true, angle = 0, inside = false, fontSize = 18 } = {}) {
  const f = FORMATS[id];
  el("circle", { cx: x, cy: y, r, fill: FAMILIES[f.family].color }, g);
  if (!label) return;
  if (inside) {
    const t = el("text", { x, y: y + 8, "text-anchor": "middle", "font-size": 22, "font-weight": 700 }, g);
    t.style.fill = "#fff";
    t.textContent = f.ext.toUpperCase();
    return;
  }
  // Étiquette orientée le long du rayon : elles ne se chevauchent plus
  const deg = (angle * 180) / Math.PI;
  const right = Math.cos(angle) >= 0;
  const out = r + 5;
  const lx = x + out * Math.cos(angle);
  const ly = y + out * Math.sin(angle);
  const t = el("text", {
    x: lx, y: ly, "text-anchor": right ? "start" : "end", "dominant-baseline": "central",
    "font-size": fontSize, transform: `rotate(${right ? deg : deg + 180} ${lx} ${ly})`,
  }, g);
  t.textContent = f.ext.toUpperCase();
}

// Vue centrée sur un fichier : le format source au centre, un anneau par étape.
export function renderRadial(box, source, paths, selected, onPick) {
  box.textContent = "";
  const svg = el("svg", { xmlns: NS, role: "img", "aria-label": t("radialAria", FORMATS[source].label) });
  box.appendChild(svg);
  const wasDrag = enablePanZoom(svg);

  const rings = [0, 175, 285, 360, 415];
  for (let i = 1; i < rings.length; i++) el("circle", { class: "ring", cx: C, cy: C, r: rings[i] }, svg);

  // Placement : l'anneau 1 trié par famille, les suivants suivent l'angle de leur parent
  const pos = { [source]: { x: C, y: C, a: 0 } };
  const parentOf = (id) => paths[id].path.at(-1).from;
  const maxHop = Math.max(0, ...Object.values(paths).map((p) => p.path.length));
  for (let hop = 1; hop <= maxHop; hop++) {
    const ids = Object.keys(paths).filter((id) => paths[id].path.length === hop);
    if (hop === 1) ids.sort(byFamily);
    else ids.sort((a, b) => pos[parentOf(a)].a - pos[parentOf(b)].a || byFamily(a, b));
    const offset = hop === 1 ? -Math.PI / 2 : pos[parentOf(ids[0])]?.a ?? 0;
    ids.forEach((id, i) => {
      const a = hop === 1 ? offset + (i / ids.length) * 2 * Math.PI
        : offset + ((i + 0.5) / ids.length) * 2 * Math.PI - Math.PI / ids.length;
      const [x, y] = polar(rings[Math.min(hop, rings.length - 1)], a);
      pos[id] = { x, y, a };
    });
  }

  const selectedPath = selected ? [source, ...paths[selected].path.map((e) => e.to)] : [];
  const onSelectedPath = (from, to) => {
    const i = selectedPath.indexOf(from);
    return i >= 0 && selectedPath[i + 1] === to;
  };

  const edgeLayer = el("g", {}, svg);
  const nodeLayer = el("g", {}, svg);
  const hlLayer = el("g", {}, svg); // les arêtes du chemin choisi passent au-dessus

  for (const id of Object.keys(paths)) {
    const p = parentOf(id);
    const a = pos[p], b = pos[id];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const cx = C + (mx - C) * 0.85, cy = C + (my - C) * 0.85;
    const hl = onSelectedPath(p, id);
    el("path", { class: hl ? "edge hl" : "edge", d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}` }, hl ? hlLayer : edgeLayer);
  }

  for (const id of Object.keys(paths)) {
    const g = el("g", { class: `gnode${id === selected ? " sel" : ""}`, tabindex: 0 }, nodeLayer);
    const title = el("title", {}, g);
    title.textContent = t("stepsTooltip", FORMATS[id].label, paths[id].path.length);
    drawNode(g, pos[id].x, pos[id].y, id, 11, { angle: pos[id].a });
    g.addEventListener("click", () => { if (!wasDrag()) onPick(id); });
  }
  const center = el("g", { class: "gnode" }, svg);
  drawNode(center, C, C, source, 46, { inside: true });
}

// Vue d'ensemble (sans fichier) : toutes les familles et les liens entre elles.
export function renderOverview(box) {
  box.textContent = "";
  const svg = el("svg", { xmlns: NS, role: "img", "aria-label": t("overviewAria") });
  box.appendChild(svg);
  enablePanZoom(svg);

  const ids = Object.keys(FORMATS).sort(byFamily);
  const R = 300;
  const gap = 0.12; // espace entre familles (radians)
  const span = 2 * Math.PI - gap * FAMILY_ORDER.length;
  const pos = {};
  let a = -Math.PI / 2;
  const famCenter = {};
  for (const fam of FAMILY_ORDER) {
    const members = ids.filter((id) => FORMATS[id].family === fam);
    const start = a;
    for (const id of members) {
      const [x, y] = polar(R, a);
      pos[id] = { x, y, a };
      a += span / ids.length;
    }
    famCenter[fam] = (start + a - span / ids.length) / 2;
    a += gap;
  }

  // Arêtes réelles format -> format
  const edgeLayer = el("g", {}, svg);
  const seen = new Set();
  for (const e of EDGES) {
    for (const f of e.from) for (const t of e.to) {
      if (f === t || seen.has(f + t) || seen.has(t + f)) continue;
      seen.add(f + t);
      const p = pos[f], q = pos[t];
      const same = FORMATS[f].family === FORMATS[t].family;
      const k = same ? 0.8 : 0.1;
      const cx = C + ((p.x + q.x) / 2 - C) * k, cy = C + ((p.y + q.y) / 2 - C) * k;
      const path = el("path", { class: "edge", d: `M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}` }, edgeLayer);
      path.style.strokeOpacity = same ? 0.08 : 0.18;
      path.style.stroke = FAMILIES[FORMATS[f].family].color;
    }
  }

  for (const id of ids) {
    const g = el("g", { class: "gnode" }, svg);
    const title = el("title", {}, g);
    title.textContent = FORMATS[id].label;
    drawNode(g, pos[id].x, pos[id].y, id, 7, { angle: pos[id].a, fontSize: 15 });
  }
  for (const fam of FAMILY_ORDER) {
    const [x, y] = polar(R + 135, famCenter[fam]);
    const t = el("text", { x, y, "text-anchor": "middle", "dominant-baseline": "central", "font-size": 19, "font-weight": 650 }, svg);
    t.style.fill = FAMILIES[fam].color;
    t.textContent = FAMILIES[fam].label;
  }
}

export function renderLegend(box, families) {
  box.textContent = "";
  for (const fam of FAMILY_ORDER) {
    if (families && !families.has(fam)) continue;
    const span = document.createElement("span");
    const dot = document.createElement("i");
    dot.style.background = FAMILIES[fam].color;
    span.append(dot, FAMILIES[fam].label);
    box.appendChild(span);
  }
}

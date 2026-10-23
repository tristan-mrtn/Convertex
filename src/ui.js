import { FORMATS, FAMILIES } from "./formats.js";
import { detectFormat } from "./detect.js";
import { shortestPaths, edgeCount } from "./graph.js";
import { runPath, ENGINE_LABEL } from "./pipeline.js";
import { renderRadial, renderOverview, renderLegend } from "./graphview.js";
import { t, LANG } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const LOSSY = new Set(["jpg", "webp", "avif", "jxl", "jp2"]);

const state = { file: null, source: null, paths: {}, target: null, busy: false, tab: "convert" };

function formatSize(bytes) {
  const [b, kb, mb, gb] = t("units");
  if (bytes < 1024) return `${bytes} ${b}`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} ${kb}`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} ${mb}`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ${gb}`;
}

// Textes fixes de la page, marqués data-i18n dans le HTML
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
document.documentElement.lang = LANG;

function setStatus(msg, kind = "") {
  $("status").textContent = msg;
  $("status").className = kind;
}

function colorOf(id) {
  return FAMILIES[FORMATS[id].family].color;
}

/* ---------------- Fichier ---------------- */

async function handleFile(file) {
  if (state.busy) return;
  setStatus("");
  state.file = file;
  $("dropzone").classList.add("compact");
  $("fileName").textContent = file.name;
  $("fileSize").textContent = formatSize(file.size);
  $("fileCard").hidden = false;

  const detected = await detectFormat(file);
  fillOverride(detected);
  setSource(detected);
}

function fillOverride(detected) {
  const select = $("formatOverride");
  select.textContent = "";
  if (!detected) select.append(new Option(t("unknownOption"), ""));
  for (const [fam, info] of Object.entries(FAMILIES)) {
    const group = document.createElement("optgroup");
    group.label = info.label;
    for (const f of Object.values(FORMATS).filter((f) => f.family === fam)) {
      group.append(new Option(`${f.label} (.${f.ext})`, f.id));
    }
    select.append(group);
  }
  select.value = detected ?? "";
}

function setSource(id) {
  state.source = id;
  state.target = null;
  const badge = $("fileBadge");
  if (!id) {
    badge.textContent = "?";
    badge.style.background = "var(--muted)";
    $("targetsCard").hidden = true;
    $("actionCard").hidden = true;
    setStatus(t("unknownFormat"), "err");
    refreshGraph();
    return;
  }
  badge.textContent = FORMATS[id].ext.toUpperCase();
  badge.style.background = colorOf(id);
  state.paths = shortestPaths(id);
  $("search").value = "";
  renderTargets();
  $("targetsCard").hidden = false;
  $("actionCard").hidden = true;
  refreshGraph();
}

/* ---------------- Cibles ---------------- */

function renderTargets() {
  const box = $("targets");
  box.textContent = "";
  const filter = $("search").value.trim().toLowerCase();
  const ids = Object.keys(state.paths).filter((id) => {
    const f = FORMATS[id];
    return !filter || f.label.toLowerCase().includes(filter) || f.exts.some((e) => e.includes(filter));
  });
  const total = Object.keys(state.paths).length;
  $("targetsCount").textContent = total ? t("targetsCount", total) : t("noTargets");

  for (const fam of Object.keys(FAMILIES)) {
    const members = ids.filter((id) => FORMATS[id].family === fam)
      .sort((a, b) => state.paths[a].cost - state.paths[b].cost || FORMATS[a].label.localeCompare(FORMATS[b].label));
    if (!members.length) continue;
    const section = document.createElement("div");
    section.className = "family";
    const title = document.createElement("div");
    title.className = "family-name";
    const dot = document.createElement("i");
    dot.style.background = FAMILIES[fam].color;
    title.append(dot, FAMILIES[fam].label);
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const id of members) {
      const chip = document.createElement("button");
      chip.className = `chip${id === state.target ? " selected" : ""}`;
      chip.title = FORMATS[id].label;
      chip.append(FORMATS[id].ext.toUpperCase());
      const hops = state.paths[id].path.length;
      if (hops > 1) {
        const h = document.createElement("span");
        h.className = "hops";
        h.textContent = t("hops", hops);
        chip.append(h);
      }
      chip.addEventListener("click", () => selectTarget(id));
      chips.append(chip);
    }
    section.append(title, chips);
    box.append(section);
  }
}

function selectTarget(id) {
  if (state.busy) return;
  state.target = id;
  renderTargets();
  renderPath();
  $("actionCard").hidden = false;
  $("qualityRow").hidden = !LOSSY.has(id);
  $("convertBtn").textContent = t("convertTo", FORMATS[id].ext.toUpperCase());
  setStatus("");
  refreshGraph();
}

function renderPath() {
  const view = $("pathView");
  view.textContent = "";
  const steps = [state.source, ...state.paths[state.target].path.map((e) => e.to)];
  const edges = state.paths[state.target].path;
  steps.forEach((id, i) => {
    if (i > 0) {
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      const b = document.createElement("b");
      b.textContent = "→";
      arrow.append(b, ENGINE_LABEL[edges[i - 1].engine]);
      view.append(arrow);
    }
    const node = document.createElement("span");
    node.className = "node";
    node.style.background = colorOf(id);
    node.textContent = FORMATS[id].ext.toUpperCase();
    view.append(node);
  });
}

/* ---------------- Conversion ---------------- */

function download(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function convert() {
  if (!state.file || !state.target || state.busy) return;
  state.busy = true;
  $("convertBtn").disabled = true;
  $("progress").hidden = false;
  setStatus("");
  const path = state.paths[state.target].path;
  const started = performance.now();
  try {
    const result = await runPath(state.file, path, {
      quality: Number($("quality").value) / 100,
    }, ({ step, steps, edge, ratio }) => {
      const overall = (step + Math.min(1, ratio)) / steps;
      $("barFill").style.width = `${Math.round(overall * 100)}%`;
      const firstLoad = ["ffmpeg", "pandoc", "magick"].includes(edge.engine) && ratio === 0 ? t("firstLoad") : "";
      $("progressText").textContent = t("step", step + 1, steps, FORMATS[edge.from].ext.toUpperCase(),
        FORMATS[edge.to].ext.toUpperCase(), ENGINE_LABEL[edge.engine]) + firstLoad;
    });
    const isZip = result.name.endsWith(".zip");
    download(result.bytes, result.name, isZip ? "application/zip" : FORMATS[state.target].mime);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(isZip
      ? t("doneZip", secs, result.count, result.name, formatSize(result.bytes.length))
      : t("done", secs, result.name, formatSize(result.bytes.length)), "ok");
  } catch (err) {
    console.error(err);
    setStatus(err.message || t("failed"), "err");
  } finally {
    state.busy = false;
    $("convertBtn").disabled = false;
    $("progress").hidden = true;
    $("barFill").style.width = "0";
  }
}

/* ---------------- Graphe ---------------- */

function refreshGraph() {
  if (state.tab !== "graph") return;
  const box = $("graphBox");
  if (state.source && Object.keys(state.paths).length) {
    const n = Object.keys(state.paths).length;
    $("graphCaption").textContent = t("radialCaption", FORMATS[state.source].label, n);
    renderRadial(box, state.source, state.paths, state.target, (id) => selectTarget(id));
    renderLegend($("legend"), new Set([state.source, ...Object.keys(state.paths)].map((id) => FORMATS[id].family)));
  } else {
    $("graphCaption").textContent = t("overviewCaption", Object.keys(FORMATS).length, edgeCount());
    renderOverview(box);
    renderLegend($("legend"));
  }
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("tab-convert").hidden = tab !== "convert";
  $("tab-graph").hidden = tab !== "graph";
  refreshGraph();
}

/* ---------------- Événements ---------------- */

const dz = $("dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
// Un fichier lâché à côté de la zone ne doit pas être ouvert par le navigateur
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) { showTab("convert"); handleFile(f); }
});

$("fileInput").addEventListener("change", () => {
  const f = $("fileInput").files[0];
  if (f) handleFile(f);
  $("fileInput").value = "";
});
$("formatOverride").addEventListener("change", (e) => setSource(e.target.value || null));
$("search").addEventListener("input", renderTargets);
$("quality").addEventListener("input", () => { $("qualityValue").textContent = $("quality").value; });
$("convertBtn").addEventListener("click", convert);
$("clearFile").addEventListener("click", () => {
  if (state.busy) return;
  Object.assign(state, { file: null, source: null, paths: {}, target: null });
  for (const id of ["fileCard", "targetsCard", "actionCard"]) $(id).hidden = true;
  dz.classList.remove("compact");
  setStatus("");
  refreshGraph();
});
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("openTab").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") }));

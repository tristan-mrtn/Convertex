// Réglages audio et vidéo, et encadré d'avis, de bout en bout : Chromium charge
// l'extension, on règle le panneau comme un utilisateur, on convertit, et ffprobe
// vérifie ce que contient chaque fichier produit.
//   npm run build
//   node tests/av-options.mjs
// Il faut ffprobe (paquet ffmpeg) et un Chromium qui accepte --load-extension
// (celui de Playwright, ou son chemin dans CHROME_PATH).

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VIDEO = join(ROOT, "tests/fixtures/av/video-720p.mkv");
const IMAGE = join(ROOT, "docs/convert.png");
const OUT = join(ROOT, "tests/out/av-options");
const REVIEW_URL = "https://chromewebstore.google.com/detail/eemhkdhchanmcoejnmfpgilajfngdjad/reviews";

try {
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  console.error("Ce test a besoin de ffprobe (paquet ffmpeg).");
  process.exit(2);
}

function probe(file) {
  const json = execFileSync("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,codec_tag_string,width,height,r_frame_rate,sample_rate,channels", "-of", "json", file]).toString();
  const streams = JSON.parse(json).streams;
  return { v: streams.find((s) => s.codec_type === "video"), a: streams.find((s) => s.codec_type === "audio") };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const context = await chromium.launchPersistentContext(join(OUT, ".profil"), {
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${join(ROOT, "ext")}`, `--load-extension=${join(ROOT, "ext")}`, "--headless=new"],
});
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
const page = await context.newPage();
page.on("pageerror", (e) => console.error(`  [erreur de page] ${e.message}`));
await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);

let failures = 0;
let checks = 0;
function expect(label, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "ÉCHEC"} ${label}${!ok && detail ? ` (${detail})` : ""}`);
}

const hidden = (id) => page.$eval(`#${id}`, (el) => el.hidden || !!el.closest("[hidden]"));

async function load(file) {
  await page.setInputFiles("#fileInput", file);
  await page.waitForSelector("#targets .chip");
}

// Choisit la cible et les réglages ({ level, height, fps, rate, channels })
async function choose(to, settings = {}) {
  await page.$eval(`#targets .chip[data-format="${to}"]`, (chip) => chip.click());
  await page.$eval("#avAdvanced", (d) => { d.open = true; });
  await page.evaluate(({ level }) => {
    const radio = document.querySelector(`input[name="avLevel"][value="${level}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }, { level: settings.level ?? "high" });
  const selects = { height: "avHeight", fps: "avFps", rate: "avRate", channels: "avChannels" };
  for (const [key, id] of Object.entries(selects)) {
    if (settings[key] == null || await hidden(id)) continue;
    await page.selectOption(`#${id}`, String(settings[key]));
  }
}

async function convert(name) {
  await page.evaluate(() => { const s = document.getElementById("status"); s.className = ""; s.textContent = ""; });
  const download = page.waitForEvent("download", { timeout: 240_000 });
  await page.$eval("#convertBtn", (b) => b.click());
  await page.waitForFunction(() => /^(ok|err)$/.test(document.getElementById("status").className), null, { timeout: 240_000 });
  const status = await page.$eval("#status", (s) => ({ kind: s.className, text: s.textContent }));
  if (status.kind !== "ok") throw new Error(`${name} : ${status.text}`);
  const out = join(OUT, name);
  await (await download).saveAs(out);
  return out;
}

await load(VIDEO);

// 1. Sans réglage : le fichier garde sa taille, sa cadence et son son
{
  await choose("mp4");
  const { v, a } = probe(await convert("defaut.mp4"));
  expect("MP4 sans réglage : H.264 en 1280×720 à 30 images/s", v.codec_name === "h264" && v.width === 1280 && v.height === 720 && v.r_frame_rate === "30/1", JSON.stringify(v));
  expect("MP4 sans réglage : son AAC stéréo à 44,1 kHz", a.codec_name === "aac" && a.channels === 2 && a.sample_rate === "44100", JSON.stringify(a));
}

// 2. Tous les réglages vidéo
{
  await choose("mp4", { level: "low", height: 480, fps: 24, rate: 48000, channels: 1 });
  expect("titre des réglages avancés : 4 modifiés", /4/.test(await page.$eval("#avChanged", (s) => s.textContent)));
  const { v, a } = probe(await convert("basse-480p.mp4"));
  expect("MP4 H.264 en 854×480 à 24 images/s", v.codec_name === "h264" && v.width === 854 && v.height === 480 && v.r_frame_rate === "24/1", JSON.stringify(v));
  expect("MP4 : son mono à 48 kHz", a.channels === 1 && a.sample_rate === "48000", JSON.stringify(a));
}
{
  await choose("webm", { level: "max", height: 360 });
  const { v, a } = probe(await convert("maximale-360p.webm"));
  expect("WebM VP8 en 640×360 avec du son Vorbis", v.codec_name === "vp8" && v.width === 640 && v.height === 360 && a.codec_name === "vorbis", `${JSON.stringify(v)} ${JSON.stringify(a)}`);
}
{
  await choose("avi", { height: 360 });
  const { v } = probe(await convert("360p.avi"));
  expect("AVI MPEG-4 en 640×360", v.codec_name === "mpeg4" && v.width === 640 && v.height === 360, JSON.stringify(v));
}

// 3. Audio
{
  await choose("mp3", { level: "low", height: 480, rate: 0, channels: 0 });
  expect("MP3 : ni résolution ni images par seconde", (await hidden("avHeightRow")) && (await hidden("avFpsRow")));
  const low = statSync(await convert("basse.mp3")).size;
  await choose("mp3", { level: "max", rate: 48000, channels: 1 });
  const maxFile = await convert("maximale.mp3");
  const { a } = probe(maxFile);
  expect("MP3 maximale : mono à 48 kHz", a.codec_name === "mp3" && a.channels === 1 && a.sample_rate === "48000", JSON.stringify(a));
  expect("MP3 : la qualité maximale pèse plus que la basse", statSync(maxFile).size > low, `${statSync(maxFile).size} contre ${low}`);
}
{
  await choose("wav", { rate: 48000, channels: 1 });
  expect("WAV : pas de niveau de qualité (format sans perte)", await hidden("avLevelRow"));
  const { a } = probe(await convert("mono.wav"));
  expect("WAV PCM mono à 48 kHz", a.codec_name === "pcm_s16le" && a.channels === 1 && a.sample_rate === "48000", JSON.stringify(a));
}
{
  await choose("opus", { channels: 1 });
  expect("Opus : fréquence imposée, expliquée au lieu du choix", (await hidden("avRateRow")) && !(await hidden("avHint")));
  const { a } = probe(await convert("mono.opus"));
  expect("Opus mono", a.codec_name === "opus" && a.channels === 1, JSON.stringify(a));
}

// 4. Hors audio et vidéo : pas de réglages
{
  await page.$eval('#targets .chip[data-format="gif"]', (chip) => chip.click());
  expect("GIF : pas de réglages audio et vidéo", await hidden("avBox"));
  await load(IMAGE);
  await page.$eval('#targets .chip[data-format="jpg"]', (chip) => chip.click());
  expect("PNG vers JPG : curseur de qualité d'image, pas de réglages audio et vidéo", !(await hidden("qualityRow")) && (await hidden("avBox")));
}

// 5. Avis : bouton en bas, encadré après la 5e conversion réussie (il y en a eu 9)
{
  const link = await page.$eval("#reviewLink", (a) => ({ href: a.href, target: a.target, visible: a.offsetParent !== null }));
  expect("bouton « Laisser un avis » en bas, vers la page d'avis du Store, dans un nouvel onglet", link.href === REVIEW_URL && link.target === "_blank" && link.visible, JSON.stringify(link));
  expect("encadré d'avis ouvert après 5 conversions", await page.$eval("#reviewAsk", (d) => d.open));
  await page.$eval("#reviewLater", (b) => b.click());
  const later = await page.evaluate(() => JSON.parse(localStorage.getItem("convertex.review")));
  expect("« Plus tard » : fermé, reproposé 20 conversions plus loin", !(await page.$eval("#reviewAsk", (d) => d.open)) && later.later === later.count + 20, JSON.stringify(later));
  // rien d'envoyé : seul ce compteur est gardé, dans le navigateur
  await page.evaluate(() => {
    const r = JSON.parse(localStorage.getItem("convertex.review"));
    localStorage.setItem("convertex.review", JSON.stringify({ ...r, count: r.later - 1 }));
  });
  await page.$eval('#targets .chip[data-format="webp"]', (chip) => chip.click());
  await convert("relance.webp");
  expect("encadré reproposé une deuxième fois", await page.$eval("#reviewAsk", (d) => d.open));
  await page.$eval("#reviewLater", (b) => b.click());
  const done = await page.evaluate(() => JSON.parse(localStorage.getItem("convertex.review")));
  expect("deuxième « Plus tard » : plus jamais reproposé", done.done === true, JSON.stringify(done));
  await page.$eval('#targets .chip[data-format="webp"]', (chip) => chip.click());
  await convert("apres.webp");
  expect("plus d'encadré ensuite", !(await page.$eval("#reviewAsk", (d) => d.open)));
}

await context.close();
console.log(`\n${checks - failures}/${checks} vérifications réussies`);
process.exit(failures ? 1 : 0);

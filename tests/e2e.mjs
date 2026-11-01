// Tests de bout en bout : Chromium charge l'extension décompressée (ext/), on dépose
// chaque fichier d'exemple dans le panneau et on le convertit vers toutes ses cibles,
// exactement comme un utilisateur. Les sorties sont rangées dans tests/out/.
//
//   npm run build
//   node tests/e2e.mjs tests/fixtures/maths [autres fichiers ou dossiers] [--to=pdf,docx] [--jobs=2]
//
// Chromium : celui de Playwright (npx playwright install chromium) ou celui indiqué
// par CHROME_PATH. Un Chrome de marque n'accepte plus --load-extension.

import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const only = opt("to")?.split(",");
const jobs = Number(opt("jobs") ?? 2);
const OUT = resolve(opt("out") ?? join(ROOT, "tests/out"));
const TIMEOUT = Number(opt("timeout") ?? 180_000);

const inputs = args.filter((a) => !a.startsWith("--")).flatMap((p) => {
  const abs = resolve(p);
  return statSync(abs).isDirectory()
    ? readdirSync(abs).filter((f) => !f.startsWith(".")).sort().map((f) => join(abs, f))
    : [abs];
});
if (!inputs.length) {
  console.error("Usage : node tests/e2e.mjs <fichiers ou dossiers> [--to=pdf,docx] [--jobs=2]");
  process.exit(2);
}

const userDir = join(OUT, ".profil");
rmSync(userDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${join(ROOT, "ext")}`, `--load-extension=${join(ROOT, "ext")}`, "--headless=new"],
});
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
const extId = new URL(worker.url()).host;
const panelUrl = `chrome-extension://${extId}/sidepanel.html`;

async function openPanel() {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`  [erreur de page] ${e.message}`));
  await page.goto(panelUrl);
  return page;
}

// Panneau prêt avec le fichier déposé
async function loadFile(file) {
  const page = await openPanel();
  await page.setInputFiles("#fileInput", file);
  await page.waitForSelector("#targets .chip, #status.err", { timeout: 30_000 });
  return page;
}

// Convertit un fichier vers toutes ses cibles, dans un panneau neuf (son worker et
// sa mémoire sont libérés à la fermeture)
async function runFile(file, report) {
  const name = basename(file);
  let page = await loadFile(file);
  const targets = await page.$$eval("#targets .chip", (chips) => chips.map((c) => c.dataset.format));
  const from = await page.$eval("#formatOverride", (s) => s.value);
  const dir = join(OUT, name.replace(/[^\w.-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  for (const to of targets) {
    if (only && !only.includes(to)) continue;
    const started = Date.now();
    const entry = { file: name, from, to, ok: false, ms: 0 };
    try {
      // clics directs : pas d'attente d'animation entre deux conversions
      await page.$eval(`#targets .chip[data-format="${to}"]`, (chip) => chip.click());
      await page.evaluate(() => { const s = document.getElementById("status"); s.className = ""; s.textContent = ""; });
      const download = page.waitForEvent("download", { timeout: TIMEOUT }).catch(() => null);
      await page.$eval("#convertBtn", (btn) => btn.click());
      await page.waitForFunction(() => /^(ok|err)$/.test(document.getElementById("status").className), null, { timeout: TIMEOUT, polling: 100 });
      const status = await page.$eval("#status", (s) => ({ kind: s.className, text: s.textContent }));
      if (status.kind === "ok") {
        const dl = await download;
        if (!dl) throw new Error("conversion terminée, mais aucun téléchargement");
        const out = join(dir, dl.suggestedFilename());
        await dl.saveAs(out);
        Object.assign(entry, { ok: true, out, status: status.text });
      } else {
        entry.error = status.text;
      }
    } catch (err) {
      entry.error = String(err.message ?? err).split("\n")[0];
      // panneau bloqué ou planté : on repart d'une page neuve
      await page.close().catch(() => {});
      page = await loadFile(file);
    }
    entry.ms = Date.now() - started;
    report.push(entry);
    console.log(`${entry.ok ? "ok " : "ÉCHEC"} ${name} -> ${to} (${(entry.ms / 1000).toFixed(1)} s)${entry.error ? ` : ${entry.error}` : ""}`);
  }
  await page.close();
}

const report = [];
const queue = [...inputs];
// Les pages d'une extension partagent un même processus : peu de tâches en
// parallèle, sinon les moteurs WebAssembly épuisent sa mémoire.
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const file = queue.shift();
    try {
      await runFile(file, report);
    } catch (err) {
      report.push({ file: basename(file), ok: false, error: `dépôt impossible : ${err.message}` });
      console.log(`ÉCHEC ${basename(file)} : ${err.message}`);
    }
  }
}));
await context.close();
rmSync(userDir, { recursive: true, force: true });

writeFileSync(join(OUT, "rapport.json"), JSON.stringify(report, null, 1));
const failed = report.filter((r) => !r.ok);
console.log(`\n${report.length - failed.length}/${report.length} conversions réussies (rapport : ${join(OUT, "rapport.json")})`);
process.exit(failed.length ? 1 : 0);

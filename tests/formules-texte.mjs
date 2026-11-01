// Formules écrites en texte lisible dans le texte brut (u_n, x^2, (b − a)/n…), la même
// notation que pour un PDF converti en texte. Sans navigateur : chaque fichier
// attendu tests/fixtures/texte/<source>.txt est comparé à la conversion de <source>
// (cherché dans tests/fixtures/texte, puis dans tests/fixtures/maths) avec Pandoc et
// math.lua, exactement comme dans le worker.
//   node tests/formules-texte.mjs          vérifie
//   node tests/formules-texte.mjs --maj    réécrit les fichiers attendus (à relire !)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPandocInstance } from "../node_modules/pandoc-wasm/src/core.js";
import { convertWithPandoc } from "../src/pandoc-run.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "tests/fixtures/texte");
const update = process.argv.includes("--maj");
const pandoc = await createPandocInstance(readFileSync(join(ROOT, "node_modules/pandoc-wasm/src/pandoc.wasm")));
const lua = readFileSync(join(ROOT, "src/math.lua"), "utf8");
const dec = new TextDecoder();

let failed = 0;
const expectedFiles = readdirSync(DIR).filter((f) => /\.\w+\.txt$/.test(f)).sort();
for (const exp of expectedFiles) {
  const name = exp.replace(/\.txt$/, "");
  const src = [join(DIR, name), join(ROOT, "tests/fixtures/maths", name)].find(existsSync);
  if (!src) {
    console.log(`ÉCHEC ${exp} : source ${name} introuvable`);
    failed++;
    continue;
  }
  const from = name.split(".").pop();
  const out = dec.decode(await convertWithPandoc(pandoc, { bytes: new Uint8Array(readFileSync(src)), from, to: "txt", name }, { lua }));
  const path = join(DIR, exp);
  if (update) {
    writeFileSync(path, out);
    console.log(`écrit ${exp}`);
    continue;
  }
  const want = readFileSync(path, "utf8");
  if (out === want) {
    console.log(`ok   ${name} -> txt`);
    continue;
  }
  failed++;
  const a = want.split("\n");
  const b = out.split("\n");
  const i = a.findIndex((line, k) => line !== b[k]);
  console.log(`ÉCHEC ${name} -> txt, ligne ${i + 1}\n  attendu : ${a[i] ?? "(fin)"}\n  obtenu  : ${b[i] ?? "(fin)"}`);
}
console.log(`\n${expectedFiles.length - failed}/${expectedFiles.length} textes conformes`);
process.exit(failed ? 1 : 0);

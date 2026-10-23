// Construit l'extension dans ext/ : bundle JS + copie des moteurs WebAssembly.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const nm = (p) => `node_modules/${p}`;
const common = { bundle: true, format: "esm", platform: "browser", target: "chrome116",
  minify: true, legalComments: "none", logLevel: "warning" };

rmSync("ext/dist", { recursive: true, force: true });
await build({ ...common, entryPoints: ["src/ui.js"], outfile: "ext/dist/sidepanel.js" });
await build({ ...common, entryPoints: ["src/worker.js"], outfile: "ext/dist/engine-worker.js" });

rmSync("ext/engines", { recursive: true, force: true });
const copy = (from, to) => { mkdirSync(`ext/engines/${to}`.replace(/\/[^/]+$/, ""), { recursive: true }); cpSync(from, `ext/engines/${to}`, { recursive: true }); };
copy(nm("@imagemagick/magick-wasm/dist/x86/magick.wasm"), "magick.wasm");
copy(nm("pandoc-wasm/src/pandoc.wasm"), "pandoc.wasm");
copy(nm("@ffmpeg/core/dist/esm/ffmpeg-core.js"), "ffmpeg-core.js");
copy(nm("@ffmpeg/core/dist/esm/ffmpeg-core.wasm"), "ffmpeg-core.wasm");
copy(nm("pdfjs-dist/build/pdf.worker.min.mjs"), "pdfjs/pdf.worker.mjs");
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) copy(nm(`pdfjs-dist/${d}`), `pdfjs/${d}`);
copy("assets/fonts", "fonts");
console.log("Extension construite dans ext/");

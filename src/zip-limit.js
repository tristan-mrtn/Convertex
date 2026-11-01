// Décompression plafonnée (archives ZIP et gzip, conteneurs ODT, PPTX…).
// La taille décompressée est limitée pendant la décompression elle-même, ce qui
// arrête les bombes de décompression même si l'archive ment sur ses tailles.

import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { t } from "./i18n.js";

export const MAX_UNPACKED = 500 * 1024 ** 2; // 500 Mo

export function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function tooBig() {
  return new Error(t("archiveTooBig"));
}

// On fournit l'archive par petits morceaux : chaque morceau de 64 Ko ne peut
// produire qu'une quantité bornée de données, donc la limite agit tout de suite.
function pushInSlices(stream, bytes, shouldStop) {
  const SLICE = 64 * 1024;
  if (bytes.length === 0) { stream.push(bytes, true); return; }
  for (let o = 0; o < bytes.length; o += SLICE) {
    stream.push(bytes.subarray(o, o + SLICE), o + SLICE >= bytes.length);
    if (shouldStop()) return;
  }
}

// keep(nom) permet de ne décompresser que les fichiers utiles
export function unzipLimited(bytes, keep = () => true) {
  const files = [];
  let total = 0;
  let error = null;
  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/") || !keep(file.name)) return;
    const chunks = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (error) return;
      if (err) { error = err; return; }
      size += chunk.length;
      total += chunk.length;
      if (total > MAX_UNPACKED) { error = tooBig(); file.terminate(); return; }
      chunks.push(chunk);
      if (final) files.push({ path: file.name, bytes: concat(chunks, size) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  pushInSlices(unzip, bytes, () => error);
  if (error) throw error;
  return files;
}

export function gunzipLimited(bytes) {
  const chunks = [];
  let total = 0;
  const gz = new Gunzip((chunk) => {
    total += chunk.length;
    // Lever l'erreur ici interrompt immédiatement la décompression
    if (total > MAX_UNPACKED) throw tooBig();
    chunks.push(chunk);
  });
  pushInSlices(gz, bytes, () => false);
  return concat(chunks, total);
}

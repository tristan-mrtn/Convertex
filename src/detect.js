// Détection du vrai format d'un fichier : signature binaire d'abord,
// puis inspection du contenu (archives ZIP, texte), puis extension.
import { unzipSync, strFromU8 } from "fflate";
import { formatFromName } from "./formats.js";

const ascii = (b, start, len) =>
  String.fromCharCode(...b.subarray(start, start + len));
const starts = (b, bytes, at = 0) => bytes.every((x, i) => b[at + i] === x);

// Les formats bureautiques modernes sont des ZIP : on regarde leur contenu.
function detectZipFamily(bytes) {
  const names = [];
  let mimetype = null;
  try {
    const files = unzipSync(bytes, {
      filter(file) {
        names.push(file.name);
        return file.name === "mimetype"; // on ne décompresse que ce fichier
      },
    });
    if (files.mimetype) mimetype = strFromU8(files.mimetype).trim();
  } catch {
    return "zip";
  }
  if (mimetype === "application/epub+zip") return "epub";
  if (mimetype === "application/vnd.oasis.opendocument.text") return "odt";
  if (mimetype === "application/vnd.oasis.opendocument.spreadsheet") return "ods";
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  return "zip";
}

function detectBinary(b, bytes) {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (ascii(b, 0, 4) === "GIF8") return "gif";
  if (ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 4);
    if (kind === "WEBP") return "webp";
    if (kind === "WAVE") return "wav";
    if (kind === "AVI ") return "avi";
  }
  if (starts(b, [0x42, 0x4d]) && b.length > 26) return "bmp";
  if (starts(b, [0x49, 0x49, 0x2a, 0x00]) || starts(b, [0x4d, 0x4d, 0x00, 0x2a])) return null; // TIFF ou RAW : on laisse l'extension trancher
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (/avi[fs]/.test(brand)) return "avif";
    if (/hei[cx]|mif1|msf1|heim|heis|hevc/.test(brand)) return "heic";
    if (brand === "crx ") return "cr3";
    if (brand === "qt  ") return "mov";
    if (/M4A |M4B /.test(brand)) return "m4a";
    return "mp4";
  }
  if (starts(b, [0x00, 0x00, 0x01, 0x00])) return "ico";
  if (starts(b, [0xff, 0x0a]) || starts(b, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return "jxl";
  if (starts(b, [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20])) return "jp2";
  if (ascii(b, 0, 4) === "qoif") return "qoi";
  if (ascii(b, 0, 4) === "8BPS") return "psd";
  if (ascii(b, 0, 8) === "gimp xcf") return "xcf";
  if (ascii(b, 0, 4) === "DDS ") return "dds";
  if (starts(b, [0x76, 0x2f, 0x31, 0x01])) return "exr";
  if (ascii(b, 0, 10) === "#?RADIANCE") return "hdr";
  if (ascii(b, 0, 4) === "%PDF") return "pdf";
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(b, 0, 64).includes("webm") ? "webm" : "mkv";
  }
  if (ascii(b, 0, 3) === "FLV") return "flv";
  if (starts(b, [0x30, 0x26, 0xb2, 0x75])) return null; // ASF : WMV ou WMA selon l'extension
  if (starts(b, [0x00, 0x00, 0x01, 0xba]) || starts(b, [0x00, 0x00, 0x01, 0xb3])) return "mpeg";
  if (ascii(b, 0, 4) === "OggS") {
    const head = ascii(b, 0, 64);
    if (head.includes("theora")) return "ogv";
    if (head.includes("OpusHead")) return "opus";
    return "ogg";
  }
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return "mp3";
  if (ascii(b, 0, 4) === "fLaC") return "flac";
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "aac";
  if (ascii(b, 0, 4) === "FORM" && ascii(b, 8, 3) === "AIF") return "aiff";
  if (starts(b, [0x0b, 0x77])) return "ac3";
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0])) return "xls"; // conteneur OLE (Office 97)
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) return detectZipFamily(bytes);
  if (starts(b, [0x1f, 0x8b])) return "tgz";
  if (ascii(b, 257, 5) === "ustar") return "tar";
  if (ascii(b, 0, 5) === "{\\rtf") return "rtf";
  return undefined; // pas de signature : peut-être du texte
}

function detectText(text, fromName) {
  const t = text.trimStart();
  if (/^<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t) || /^<svg[\s>]/i.test(t)) return "svg";
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return "html";
  if (/^<\?xml/.test(t) || /^<[A-Za-z]/.test(t)) {
    if (/<FictionBook/.test(t)) return "fb2";
    if (/<(book|article)[^>]*docbook/i.test(t)) return "dbk";
    return fromName === "html" ? "html" : "xml";
  }
  if (/^\{[\s\S]*"cells"\s*:/.test(t) && /"nbformat"/.test(t)) return "ipynb";
  if (/^[\[{]/.test(t)) {
    try { JSON.parse(text); return "json"; } catch { /* pas du JSON */ }
  }
  if (/^WEBVTT/.test(t)) return "vtt";
  if (/^\[Script Info\]/.test(t)) return "ass";
  if (/^\d+\s*\r?\n\d\d:\d\d:\d\d,\d{3} --> /.test(t)) return "srt";
  return null;
}

export async function detectFormat(file) {
  const fromName = formatFromName(file.name);
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());

  // Les ZIP ont besoin du fichier entier pour lister leur contenu.
  let bytesForZip = head;
  if (starts(head, [0x50, 0x4b, 0x03, 0x04])) {
    bytesForZip = new Uint8Array(await file.arrayBuffer());
  }

  const bin = detectBinary(head, bytesForZip);
  if (bin === "tgz" && fromName && fromName !== "tgz") return fromName;
  // Les vidéos MP4 dont l'extension dit autre chose (m4a, mov) : on croit l'extension
  if (bin && fromName && FAMILY_GROUP[bin] && FAMILY_GROUP[bin] === FAMILY_GROUP[fromName]) {
    return fromName;
  }
  if (bin) return bin;
  if (bin === null) return fromName; // signature ambiguë

  // Fichier texte : on regarde le contenu, l'extension départage le reste
  const text = new TextDecoder().decode(head);
  const fromText = detectText(text, fromName);
  if (fromText && (!fromName || fromText === "xml" || fromText === "json" || fromText === "html")) {
    // Une extension précise (.dbk, .ipynb, .fb2…) l'emporte sur un "XML"/"JSON" générique
    if (fromName && ["xml", "json"].includes(fromText) && fromName !== fromText) return fromName;
    return fromText;
  }
  return fromName ?? fromText;
}

// Formats qui partagent un conteneur et qu'on départage par l'extension
const FAMILY_GROUP = {
  mp4: "isobmff", mov: "isobmff", m4a: "isobmff",
  ogg: "ogg", ogv: "ogg", opus: "ogg",
  mkv: "mkv", webm: "mkv",
};

// Registre de tous les formats connus par l'extension.
// Chaque format est un nœud du graphe de conversion.

export const FAMILIES = {
  image:    { label: "Images",        color: "#4c6ef5" },
  raw:      { label: "Photos RAW",    color: "#7048e8" },
  video:    { label: "Vidéo",         color: "#e8590c" },
  audio:    { label: "Audio",         color: "#f08c00" },
  subtitle: { label: "Sous-titres",   color: "#a61e4d" },
  document: { label: "Documents",     color: "#2b8a3e" },
  ebook:    { label: "Livres num.",   color: "#5c940d" },
  slides:   { label: "Présentations", color: "#0b7285" },
  pdf:      { label: "PDF",           color: "#c92a2a" },
  data:     { label: "Données",       color: "#1971c2" },
  archive:  { label: "Archives",      color: "#868e96" },
};

// id, libellé, extensions (la première est celle utilisée en sortie), MIME, famille
const RAW_FORMATS = [
  // Images
  ["png",  "PNG",  ["png"],               "image/png",                 "image"],
  ["jpg",  "JPG",  ["jpg", "jpeg", "jpe", "jfif"], "image/jpeg",      "image"],
  ["webp", "WEBP", ["webp"],              "image/webp",                "image"],
  ["gif",  "GIF",  ["gif"],               "image/gif",                 "image"],
  ["bmp",  "BMP",  ["bmp", "dib"],        "image/bmp",                 "image"],
  ["tiff", "TIFF", ["tiff", "tif"],       "image/tiff",                "image"],
  ["ico",  "ICO",  ["ico"],               "image/x-icon",              "image"],
  ["avif", "AVIF", ["avif"],              "image/avif",                "image"],
  ["jxl",  "JPEG XL", ["jxl"],            "image/jxl",                 "image"],
  ["jp2",  "JPEG 2000", ["jp2", "j2k"],   "image/jp2",                 "image"],
  ["heic", "HEIC", ["heic", "heif"],      "image/heic",                "image"],
  ["svg",  "SVG",  ["svg"],               "image/svg+xml",             "image"],
  ["qoi",  "QOI",  ["qoi"],               "image/qoi",                 "image"],
  ["tga",  "TGA",  ["tga"],               "image/x-tga",               "image"],
  ["psd",  "PSD",  ["psd"],               "image/vnd.adobe.photoshop", "image"],
  ["xcf",  "XCF (GIMP)", ["xcf"],         "image/x-xcf",               "image"],
  ["pcx",  "PCX",  ["pcx"],               "image/x-pcx",               "image"],
  ["ppm",  "PPM",  ["ppm", "pnm"],        "image/x-portable-pixmap",   "image"],
  ["pgm",  "PGM",  ["pgm"],               "image/x-portable-graymap",  "image"],
  ["pbm",  "PBM",  ["pbm"],               "image/x-portable-bitmap",   "image"],
  ["xpm",  "XPM",  ["xpm"],               "image/x-xpixmap",           "image"],
  ["dds",  "DDS",  ["dds"],               "image/vnd-ms.dds",          "image"],
  ["exr",  "OpenEXR", ["exr"],            "image/x-exr",               "image"],
  ["hdr",  "HDR",  ["hdr"],               "image/vnd.radiance",        "image"],

  // Photos RAW (lecture seule)
  ["cr2", "Canon CR2",   ["cr2"], "image/x-canon-cr2",   "raw"],
  ["cr3", "Canon CR3",   ["cr3"], "image/x-canon-cr3",   "raw"],
  ["nef", "Nikon NEF",   ["nef"], "image/x-nikon-nef",   "raw"],
  ["arw", "Sony ARW",    ["arw"], "image/x-sony-arw",    "raw"],
  ["dng", "DNG",         ["dng"], "image/x-adobe-dng",   "raw"],
  ["orf", "Olympus ORF", ["orf"], "image/x-olympus-orf", "raw"],
  ["rw2", "Panasonic RW2", ["rw2"], "image/x-panasonic-rw2", "raw"],
  ["raf", "Fuji RAF",    ["raf"], "image/x-fuji-raf",    "raw"],

  // Vidéo
  ["mp4",  "MP4",  ["mp4", "m4v"],  "video/mp4",        "video"],
  ["webm", "WEBM", ["webm"],        "video/webm",       "video"],
  ["mkv",  "MKV",  ["mkv"],         "video/x-matroska", "video"],
  ["avi",  "AVI",  ["avi"],         "video/x-msvideo",  "video"],
  ["mov",  "MOV",  ["mov", "qt"],   "video/quicktime",  "video"],
  ["flv",  "FLV",  ["flv"],         "video/x-flv",      "video"],
  ["wmv",  "WMV",  ["wmv"],         "video/x-ms-wmv",   "video"],
  ["mpeg", "MPEG", ["mpeg", "mpg"], "video/mpeg",       "video"],
  ["ogv",  "OGV",  ["ogv"],         "video/ogg",        "video"],

  // Audio
  ["mp3",  "MP3",  ["mp3"],          "audio/mpeg",  "audio"],
  ["wav",  "WAV",  ["wav"],          "audio/wav",   "audio"],
  ["ogg",  "OGG",  ["ogg", "oga"],   "audio/ogg",   "audio"],
  ["flac", "FLAC", ["flac"],         "audio/flac",  "audio"],
  ["aac",  "AAC",  ["aac"],          "audio/aac",   "audio"],
  ["m4a",  "M4A",  ["m4a"],          "audio/mp4",   "audio"],
  ["opus", "OPUS", ["opus"],         "audio/opus",  "audio"],
  ["wma",  "WMA",  ["wma"],          "audio/x-ms-wma", "audio"],
  ["aiff", "AIFF", ["aiff", "aif"],  "audio/aiff",  "audio"],
  ["ac3",  "AC3",  ["ac3"],          "audio/ac3",   "audio"],

  // Sous-titres
  ["srt", "SRT", ["srt"],        "application/x-subrip", "subtitle"],
  ["vtt", "WebVTT", ["vtt"],     "text/vtt",             "subtitle"],
  ["ass", "ASS", ["ass", "ssa"], "text/x-ssa",           "subtitle"],

  // Documents
  ["docx",    "Word (DOCX)",  ["docx"],            "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
  ["odt",     "OpenDocument", ["odt"],             "application/vnd.oasis.opendocument.text", "document"],
  ["rtf",     "RTF",          ["rtf"],             "application/rtf",  "document"],
  ["html",    "HTML",         ["html", "htm"],     "text/html",        "document"],
  ["md",      "Markdown",     ["md", "markdown"],  "text/markdown",    "document"],
  ["txt",     "Texte brut",   ["txt", "text"],     "text/plain",       "document"],
  ["tex",     "LaTeX",        ["tex", "latex"],    "application/x-tex","document"],
  ["typ",     "Typst",        ["typ"],             "text/x-typst",     "document"],
  ["rst",     "reStructuredText", ["rst"],         "text/x-rst",       "document"],
  ["org",     "Org-mode",     ["org"],             "text/x-org",       "document"],
  ["adoc",    "AsciiDoc",     ["adoc", "asciidoc"],"text/asciidoc",    "document"],
  ["wiki",    "MediaWiki",    ["wiki", "mediawiki"],"text/x-wiki",     "document"],
  ["textile", "Textile",      ["textile"],         "text/x-textile",   "document"],
  ["dbk",     "DocBook",      ["dbk", "docbook"],  "application/docbook+xml", "document"],
  ["ipynb",   "Jupyter",      ["ipynb"],           "application/x-ipynb+json", "document"],

  // Livres numériques et présentations
  ["epub", "EPUB",         ["epub"], "application/epub+zip",          "ebook"],
  ["fb2",  "FictionBook",  ["fb2"],  "application/x-fictionbook+xml", "ebook"],
  ["pptx", "PowerPoint",   ["pptx"], "application/vnd.openxmlformats-officedocument.presentationml.presentation", "slides"],

  // PDF
  ["pdf", "PDF", ["pdf"], "application/pdf", "pdf"],

  // Données
  ["csv",  "CSV",  ["csv"],          "text/csv",                  "data"],
  ["tsv",  "TSV",  ["tsv", "tab"],   "text/tab-separated-values", "data"],
  ["json", "JSON", ["json"],         "application/json",          "data"],
  ["yaml", "YAML", ["yaml", "yml"],  "application/yaml",          "data"],
  ["toml", "TOML", ["toml"],         "application/toml",          "data"],
  ["xml",  "XML",  ["xml"],          "application/xml",           "data"],
  ["xlsx", "Excel (XLSX)", ["xlsx"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "data"],
  ["xls",  "Excel 97 (XLS)", ["xls"],"application/vnd.ms-excel",  "data"],
  ["ods",  "Calc (ODS)",   ["ods"],  "application/vnd.oasis.opendocument.spreadsheet", "data"],

  // Archives
  ["zip", "ZIP",    ["zip"],              "application/zip",    "archive"],
  ["tar", "TAR",    ["tar"],              "application/x-tar",  "archive"],
  ["tgz", "TAR.GZ", ["tgz", "tar.gz"],    "application/gzip",   "archive"],
];

export const FORMATS = Object.fromEntries(
  RAW_FORMATS.map(([id, label, exts, mime, family]) => [
    id,
    { id, label, exts, ext: exts[0], mime, family },
  ])
);

// Index extension -> id de format (les extensions doubles comme tar.gz d'abord)
export function formatFromName(name) {
  const lower = name.toLowerCase();
  let best = null;
  for (const f of Object.values(FORMATS)) {
    for (const e of f.exts) {
      if (lower.endsWith("." + e) && (!best || e.length > best.len)) {
        best = { id: f.id, len: e.length };
      }
    }
  }
  return best?.id ?? null;
}

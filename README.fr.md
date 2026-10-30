# Convertex

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/eemhkdhchanmcoejnmfpgilajfngdjad?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/eemhkdhchanmcoejnmfpgilajfngdjad?utm_source=github)
[![Users](https://img.shields.io/chrome-web-store/users/eemhkdhchanmcoejnmfpgilajfngdjad?label=users)](https://chromewebstore.google.com/detail/eemhkdhchanmcoejnmfpgilajfngdjad?utm_source=github)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

[English](README.md) | **Français**

**[Installer Convertex depuis le Chrome Web Store](https://chromewebstore.google.com/detail/eemhkdhchanmcoejnmfpgilajfngdjad?utm_source=github)**

<p align="center"><img src="docs/demo.gif" alt="Conversion d'un document Word en PDF avec Convertex" width="360"></p>

Convertex (convert + vertex, un sommet de graphe) est une extension Chrome qui convertit un fichier vers tous les formats atteignables parmi 85, directement dans le navigateur. Aucun fichier ne quitte l'ordinateur : pas de serveur, pas d'API, tout tourne en WebAssembly.

## Captures d'écran

<p align="center">
  <img src="docs/convert.png" alt="Tous les formats possibles pour un fichier" width="49%">
  <img src="docs/graph.png" alt="Le graphe de conversion" width="49%">
</p>

## Fonctionnement

On dépose un fichier dans le panneau latéral. L'extension détecte son vrai format (signature binaire, contenu des archives ZIP, puis extension), affiche tous les formats possibles et convertit en un clic.

Le cœur du projet est un **graphe de conversion** :

- chaque format est un nœud (85 au total) ;
- chaque moteur ajoute des arêtes pondérées (1 331 conversions directes) ;
- un algorithme de Dijkstra trouve le chemin le moins coûteux vers chaque cible, jusqu'à 4 étapes. Par exemple `DOCX → Markdown → PDF → PNG`.

Le parcours se fait sur des états (format, information perdue) pour écarter les chemins absurdes : une image mise en PDF ne peut pas ressortir en texte, une photo transformée en GIF ne devient pas une « vidéo » d'une seule image.

Quand une étape produit plusieurs fichiers (un PDF de 10 pages donne 10 images), les étapes suivantes s'appliquent à chacun et le résultat est regroupé dans un ZIP.

L'onglet **Graphe** dessine ces chemins : le format source au centre, un anneau par étape supplémentaire, le chemin choisi en surbrillance. Sans fichier, il montre la carte complète des formats et de leurs liens.

## Formats

| Famille | Formats |
|---|---|
| Images | PNG, JPG, WEBP, GIF, BMP, TIFF, ICO, AVIF, JPEG XL, JPEG 2000, QOI, TGA, PSD, PCX, PPM, PGM, PBM, XPM, DDS, EXR, HDR, plus HEIC, XCF et SVG en lecture |
| Photos RAW (lecture) | CR2, CR3, NEF, ARW, DNG, ORF, RW2, RAF |
| Vidéo | MP4, WEBM, MKV, AVI, MOV, FLV, WMV, MPEG, OGV, GIF animé |
| Audio | MP3, WAV, OGG, FLAC, AAC, M4A, OPUS, WMA, AIFF, AC3 |
| Sous-titres | SRT, VTT, ASS |
| Documents | DOCX, ODT, RTF, HTML, Markdown, TXT, LaTeX, Typst, RST, Org, AsciiDoc, MediaWiki, Textile, DocBook, Jupyter |
| Livres et présentations | EPUB, FB2, PPTX |
| PDF | création depuis images ou documents, extraction du texte, rendu des pages en images |
| Données | CSV, TSV, JSON, YAML, TOML, XML, XLSX, XLS, ODS |
| Archives | ZIP, TAR, TAR.GZ |

## Moteurs

| Moteur | Rôle | Où il tourne |
|---|---|---|
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | audio, vidéo, sous-titres | worker |
| [Pandoc](https://github.com/pandoc/pandoc-wasm) | documents, livres, présentations | worker |
| [ImageMagick](https://github.com/dlemstra/magick-wasm) | images et photos RAW | worker |
| [pdf.js](https://github.com/mozilla/pdf.js) | lecture et rendu des PDF | panneau |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | écriture de PDF (police DejaVu pour l'Unicode) | panneau |
| [SheetJS](https://sheetjs.com) | tableurs | panneau |
| js-yaml, smol-toml, fast-xml-parser | données structurées | panneau |
| [fflate](https://github.com/101arrowz/fflate) | archives (TAR écrit à la main) | panneau |

L'interface s'affiche en français si le navigateur est en français, en anglais sinon.

Les trois gros moteurs ne sont chargés qu'au premier besoin, dans un Web Worker, pour que l'interface reste fluide.

## Confidentialité

Convertex ne collecte, ne stocke et ne transmet aucune donnée. Les fichiers sont traités uniquement dans le navigateur de l'utilisateur.

La politique de sécurité du manifest contient `connect-src 'self'` : Chrome bloque toute requête vers un autre domaine que l'extension elle-même. L'extension ne demande aucune permission d'accès aux sites. Tous les moteurs et polices sont embarqués, rien n'est téléchargé depuis un CDN.

## Sécurité

Les fichiers déposés dans Convertex sont traités comme non fiables :

- Les moteurs tournent en WebAssembly dans un Web Worker séparé, avec un système de fichiers virtuel : ils ne peuvent ni lire ton disque ni accéder au réseau.
- La politique de sécurité de l'extension n'autorise que ses propres scripts, et l'interface n'insère jamais de HTML venant d'un fichier. Les scripts contenus dans un SVG, un PDF ou un Markdown ne sont jamais exécutés.
- Le HTML produit par une conversion est nettoyé avec [DOMPurify](https://github.com/cure53/DOMPurify) : scripts, gestionnaires d'événements et liens `javascript:` sont retirés, pour qu'un document piégé ne donne pas une page qui exécute du code.
- Les chemins dans les archives sont nettoyés (pas de `..`, pas de chemin absolu), pour qu'une archive ne puisse pas faire écrire un outil d'extraction hors de son dossier.
- Les archives sont limitées à 500 Mo une fois décompressées, et la limite s'applique pendant la décompression, ce qui arrête les bombes de décompression.
- Un bouton Annuler arrête immédiatement le moteur si un fichier le bloque.

Une faille de sécurité ? Ouvre une issue : https://github.com/tristan-mrtn/Convertex/issues

## Installation

Le plus simple est de passer par le [Chrome Web Store](https://chromewebstore.google.com/detail/eemhkdhchanmcoejnmfpgilajfngdjad?utm_source=github).

Pour la compiler depuis le code source :

```bash
npm install
npm run build
```

Puis dans Chrome : `chrome://extensions`, activer le **mode développeur**, **Charger l'extension non empaquetée** et choisir le dossier `ext/`.

## Structure

```
src/
  formats.js         registre des 85 formats
  detect.js          détection du vrai format d'un fichier
  graph.js           arêtes du graphe et Dijkstra
  pipeline.js        exécution d'un chemin, étape par étape
  worker.js          ffmpeg, Pandoc et ImageMagick
  engines-main.js    tableurs, données, archives, écriture PDF
  engines-browser.js pdf.js et Canvas
  graphview.js       dessin SVG du graphe (zoom, déplacement)
  ui.js              panneau latéral
  i18n.js            textes de l'interface en anglais et en français
  sanitize.js        retire le code actif des HTML produits
ext/                 extension prête à charger (après le build)
build.mjs            bundle esbuild et copie des moteurs
```

## Limites

- Le PDF produit depuis un document est une mise en page simple (titres, paragraphes, listes, tableaux, code) : pas d'images ni de mise en forme avancée.
- Pas de reconnaissance de texte (OCR) : un PDF scanné ne peut pas devenir du texte.
- Les fichiers très lourds (vidéos de plusieurs Go) sont limités par la mémoire du navigateur.
- Les formats propriétaires sans bibliothèque libre (DWG, INDD…) ne sont pas pris en charge.

## Développement

Ce projet a été codé avec [Claude Code](https://claude.com/claude-code).

## Licence

GPL-3.0 ou ultérieure, car ffmpeg (avec x264) et Pandoc sont sous GPL. Polices DejaVu sous leur licence libre (voir `assets/fonts`).

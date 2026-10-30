// Reconstruction d'un PDF en texte structuré : lignes, paragraphes, titres et
// formules mathématiques (indices, exposants, fractions, racines, sommes avec
// bornes, binômes, matrices, accents). Travaille sur les éléments rendus par
// pdf.js (getTextContent), les noms des polices et les filets horizontaux du
// dessin (barres de fraction, barres des racines).
// Deux sorties : du texte brut lisible (u_n, x^2, 1/3) ou du Markdown dont les
// formules sont en TeX ($…$, $$…$$), que Pandoc transforme en vraies équations.

/* ------------------------------------------------------------------ */
/* Tables de caractères                                                */
/* ------------------------------------------------------------------ */

// Police CMEX de TeX (grands symboles) : sans table Unicode, pdf.js rend les
// codes bruts. Caractère, hauteur au-dessus de la ligne de base et hauteur
// totale de chaque glyphe (en em, tirées de cmex10.tfm).
const CMEX_CH = "()[]⌊⌋⌈⌉{}⟨⟩|‖/\\()()[]⌊⌋⌈⌉{}⟨⟩/\\()[]⌊⌋⌈⌉{}⟨⟩/\\/\\⎛⎞⎡⎤⎣⎦⎢⎥⎧⎫⎩⎭⎨⎬⎪⏐⎝⎠⎜⎟⟨⟩⊔⊔∮∮⨀⨀⨁⨁⨂⨂∑∏∫⋃⋂⨄⋀⋁∑∏∫⋃⋂⨄⋀⋁∐∐^^^~~~[]⌊⌋⌈⌉{}√√√√√√√‖↑↓⏞⏞⏟⏟⇑⇓";
const CMEX_T = "120,120,120,120,120,120,120,120,120,120,120,120,60,60,120,120,180,180,240,240,240,240,240,240,240,240,240,240,240,240,240,240,300,300,300,300,300,300,300,300,300,300,300,300,300,300,180,180,180,180,180,180,180,180,60,60,90,90,90,90,180,180,30,60,180,180,60,60,180,180,100,160,111,222,100,160,100,160,100,160,100,100,111,100,100,100,100,100,160,160,222,160,160,160,160,160,100,160,72,75,75,72,75,75,180,180,180,180,180,180,180,180,120,180,240,300,180,60,60,60,60,60,12,12,12,12,60,60"
  .split(",").map((v) => v / 100);
const CMEX_H = [..."11111111111100111111111111111111111111111111111111111100000000001100110200020202000000002202222202444444111111111111001000333300"]
  .map((d) => [0, 0.04, 0.1, 0.12, 0.74][d]);
// Morceaux de délimiteurs que pdf.js rend dans la zone privée d'Unicode (noms Adobe Symbol).
const PUA_CMEX = { 0xf8eb: 0x30, 0xf8ec: 0x42, 0xf8ed: 0x40, 0xf8ee: 0x32, 0xf8ef: 0x36, 0xf8f0: 0x34, 0xf8f1: 0x38,
  0xf8f2: 0x3c, 0xf8f3: 0x3a, 0xf8f4: 0x3e, 0xf8f6: 0x31, 0xf8f7: 0x43, 0xf8f8: 0x41, 0xf8f9: 0x33, 0xf8fa: 0x37,
  0xf8fb: 0x35, 0xf8fc: 0x39, 0xf8fd: 0x3d, 0xf8fe: 0x3b, 0xf8e6: 0x3f };
const CMEX_WIDE_ACC = { 0x62: "widehat", 0x63: "widehat", 0x64: "widehat", 0x65: "widetilde", 0x66: "widetilde", 0x67: "widetilde" };

// Morceaux des grands délimiteurs (empilés verticalement par TeX).
const PIECES = { "⎛": "(", "⎝": "(", "⎜": "(", "⎞": ")", "⎠": ")", "⎟": ")", "⎡": "[", "⎣": "[", "⎢": "[", "⎤": "]", "⎦": "]",
  "⎥": "]", "⎧": "{", "⎩": "{", "⎨": "{", "⎫": "}", "⎭": "}", "⎬": "}", "⎪": "⎪", "⏐": "|" };
const OPEN = "([{⟨⌊⌈";
const CLOSE = ")]}⟩⌋⌉";
const PAIR = { "(": ")", "[": "]", "{": "}", "⟨": "⟩", "⌊": "⌋", "⌈": "⌉", "|": "|", "‖": "‖", "∥": "∥" };
const BIGOPS = "∑∏∐∫∬∭∮∯∰⋃⋂⨀⨁⨂⨄⨆⋀⋁";

// Codes de contrôle des polices de texte de TeX (ligatures, guillemets…)
// quand le PDF ne donne pas d'Unicode : encodages T1 et OT1.
const T1_CTRL = { 0: "`", 1: "´", 2: "ˆ", 3: "˜", 4: "¨", 5: "˝", 6: "˚", 7: "ˇ", 8: "˘", 9: "¯", 10: "˙", 11: "¸", 12: "˛",
  13: "‚", 14: "‹", 15: "›", 16: "“", 17: "”", 18: "„", 19: "«", 20: "»", 21: "–", 22: "—", 23: "", 24: "", 25: "ı", 26: "ȷ",
  27: "ff", 28: "fi", 29: "fl", 30: "ffi", 31: "ffl" };
const OT1_CTRL = { 0: "Γ", 1: "Δ", 2: "Θ", 3: "Λ", 4: "Ξ", 5: "Π", 6: "Σ", 7: "Υ", 8: "Φ", 9: "Ψ", 10: "Ω", 11: "ff", 12: "fi",
  13: "fl", 14: "ffi", 15: "ffl", 16: "ı", 17: "ȷ", 18: "`", 19: "´", 20: "ˇ", 21: "˘", 22: "¯", 23: "˚", 24: "¸", 25: "ß",
  26: "æ", 27: "œ", 28: "ø", 29: "Æ", 30: "Œ", 31: "Ø" };
const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
// Accents posés à part (TeX en OT1 compose « é » avec « ´ » puis « e »).
const SPACING_ACC = { "´": "́", "`": "̀", "ˆ": "̂", "^": "̂", "¨": "̈", "˜": "̃", "~": "̃",
  "¯": "̄", "˘": "̆", "˙": "̇", "˚": "̊", "ˇ": "̌", "˝": "̋", "¸": "̧", "˛": "̨" };
// Accents mathématiques : nom TeX et caractère combinant pour le texte brut.
const MATH_ACC = { "ˆ": "hat", "^": "hat", "̂": "hat", "ˇ": "check", "̌": "check", "˘": "breve", "̆": "breve",
  "´": "acute", "́": "acute", "`": "grave", "̀": "grave", "˜": "tilde", "~": "tilde", "̃": "tilde",
  "¯": "bar", "ˉ": "bar", "̄": "bar", "̅": "bar", "˙": "dot", "̇": "dot", "¨": "ddot", "̈": "ddot",
  "⃗": "vec", "˚": "mathring", "̊": "mathring" };
const ACC_COMB = { hat: "̂", check: "̌", breve: "̆", acute: "́", grave: "̀", tilde: "̃",
  bar: "̄", dot: "̇", ddot: "̈", vec: "⃗", mathring: "̊", widehat: "̂", widetilde: "̃",
  overline: "̅" };

// Négations construites par surimpression (« / » ou U+0338 sur le symbole).
const NEG = { "=": "≠", "∈": "∉", "≡": "≢", "⊂": "⊄", "⊃": "⊅", "⊆": "⊈", "⊇": "⊉", "∃": "∄", "∼": "≁", "≈": "≉", "≃": "≄",
  "≅": "≇", "<": "≮", ">": "≯", "≤": "≰", "≥": "≱", "|": "∤", "∣": "∤", "∥": "∦", "→": "↛", "←": "↚", "⇒": "⇏", "⇔": "⇎",
  "∋": "∌", "≺": "⊀", "≻": "⊁" };
// Flèches longues et autres symboles faits de deux glyphes qui se chevauchent.
const JOIN = { "−→": "⟶", "←−": "⟵", "←→": "⟷", "=⇒": "⟹", "⇐=": "⟸", "⇐⇒": "⟺", ",→": "↪", "←-": "↩", "←,": "↩",
  "7→": "↦", "7−→": "⟼", "∼=": "≅", "|=": "⊨", "|−": "⊢" };

const TEX = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon", ϵ: "\\epsilon", ζ: "\\zeta", η: "\\eta",
  θ: "\\theta", ϑ: "\\vartheta", ι: "\\iota", κ: "\\kappa", ϰ: "\\varkappa", λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi",
  π: "\\pi", ϖ: "\\varpi", ρ: "\\rho", ϱ: "\\varrho", σ: "\\sigma", ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon",
  φ: "\\varphi", ϕ: "\\phi", χ: "\\chi", ψ: "\\psi", ω: "\\omega", Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta",
  Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma", Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "∌": "\\not\\ni", "⊂": "\\subset", "⊆": "\\subseteq", "⊊": "\\subsetneq",
  "⊄": "\\not\\subset", "⊈": "\\nsubseteq", "⊃": "\\supset", "⊇": "\\supseteq", "⊋": "\\supsetneq", "∪": "\\cup",
  "∩": "\\cap", "∖": "\\setminus", "∀": "\\forall", "∃": "\\exists", "∄": "\\nexists", "¬": "\\neg", "∧": "\\wedge",
  "∨": "\\vee", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "⟹": "\\Longrightarrow",
  "⟸": "\\Longleftarrow", "⟺": "\\iff", "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⟶": "\\longrightarrow",
  "⟵": "\\longleftarrow", "⟷": "\\longleftrightarrow", "↦": "\\mapsto", "⟼": "\\longmapsto", "↪": "\\hookrightarrow",
  "↩": "\\hookleftarrow", "↑": "\\uparrow", "↓": "\\downarrow", "⇑": "\\Uparrow", "⇓": "\\Downarrow", "↗": "\\nearrow",
  "↘": "\\searrow", "↛": "\\nrightarrow", "⇏": "\\nRightarrow", "⇝": "\\leadsto", "↠": "\\twoheadrightarrow",
  "≤": "\\leq", "≥": "\\geq", "⩽": "\\leqslant", "⩾": "\\geqslant", "≠": "\\neq", "≈": "\\approx", "≃": "\\simeq",
  "≅": "\\cong", "∼": "\\sim", "≡": "\\equiv", "≢": "\\not\\equiv", "∝": "\\propto", "≪": "\\ll", "≫": "\\gg",
  "≺": "\\prec", "≻": "\\succ", "⪯": "\\preceq", "⪰": "\\succeq", "≮": "\\not<", "≯": "\\not>", "≰": "\\not\\leq",
  "≱": "\\not\\geq", "≉": "\\not\\approx", "≁": "\\nsim", "∤": "\\nmid", "∣": "\\mid", "∥": "\\|",
  "∦": "\\nparallel", "⊥": "\\perp", "⊢": "\\vdash", "⊨": "\\models", "⊤": "\\top", "±": "\\pm", "∓": "\\mp",
  "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot", "∘": "\\circ", "◦": "\\circ", "∗": "\\ast", "⋆": "\\star",
  "•": "\\bullet", "⊕": "\\oplus", "⊖": "\\ominus", "⊗": "\\otimes", "⊙": "\\odot", "⊔": "\\sqcup", "⊓": "\\sqcap",
  "⊎": "\\uplus", "⋉": "\\ltimes", "⋊": "\\rtimes", "†": "\\dagger", "‡": "\\ddagger", "∞": "\\infty", "∂": "\\partial",
  "∇": "\\nabla", "∅": "\\emptyset", "ℓ": "\\ell", "ℏ": "\\hbar", "ℜ": "\\Re", "ℑ": "\\Im", "ℵ": "\\aleph", "℘": "\\wp",
  "∠": "\\angle", "□": "\\square", "■": "\\blacksquare", "△": "\\triangle", "♯": "\\sharp", "♭": "\\flat", "§": "\\S",
  "⟨": "\\langle", "⟩": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "{": "\\{",
  "}": "\\}", "‖": "\\|", "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint",
  "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap", "⨁": "\\bigoplus", "⨂": "\\bigotimes", "⨀": "\\bigodot",
  "⨄": "\\biguplus", "⋀": "\\bigwedge", "⋁": "\\bigvee", "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots",
  "⋱": "\\ddots", "′": "'", "″": "''", "‴": "'''", "−": "-", "∶": ":", "∕": "/", "⁄": "/", "%": "\\%", "#": "\\#",
  "&": "\\&", $: "\\$", _: "\\_", "\\": "\\backslash", "~": "\\sim", "^": "\\wedge", "°": "^{\\circ}", "√": "\\surd",
  "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℝ": "\\mathbb{R}", "ℂ": "\\mathbb{C}", "ℙ": "\\mathbb{P}",
  "ℍ": "\\mathbb{H}", "ℬ": "\\mathcal{B}", "ℰ": "\\mathcal{E}", "ℱ": "\\mathcal{F}", "ℋ": "\\mathcal{H}",
  "ℐ": "\\mathcal{I}", "ℒ": "\\mathcal{L}", "ℳ": "\\mathcal{M}", "ℛ": "\\mathcal{R}", "ℭ": "\\mathfrak{C}",
  "ℌ": "\\mathfrak{H}", "ℨ": "\\mathfrak{Z}", "ℎ": "h", "ℯ": "e", "ℊ": "g", "ℴ": "o",
};
// Variantes Unicode ramenées au caractère usuel.
const NORMALIZE = { "∶": ":", "∆": "Δ", "Ω": "Ω", "µ": "μ", "ı": "i", "ȷ": "j", "∣": "|", "ϒ": "Υ", "⏐": "|", "⎪": "|" };

// Noms d'opérateurs : ceux que TeX connaît, puis les usages français.
const OPNAMES = new Set(["lim", "liminf", "limsup", "sup", "inf", "max", "min", "sin", "cos", "tan", "cot", "sec", "csc",
  "sinh", "cosh", "tanh", "coth", "arcsin", "arccos", "arctan", "exp", "ln", "log", "lg", "det", "dim", "ker", "deg",
  "gcd", "hom", "arg", "Pr"]);
const OPNAMES_FR = new Set(["pgcd", "ppcm", "Ker", "Im", "rg", "tr", "Tr", "card", "Card", "Vect", "Mat", "id", "Id",
  "ch", "sh", "th", "argch", "argsh", "argth", "sgn", "Arg", "Re", "cotan", "Log", "Res", "diag", "Sp", "grad", "div",
  "rot", "Var", "Cov", "supp", "Hom", "End", "Aut", "GL", "SL", "Spec", "rang", "codim", "Det", "Ln", "Arccos",
  "Arcsin", "Arctan"]);
// Noms d'opérateurs reconnus quand ils sont dans la police du texte (XeLaTeX, Word…).
const OPNAMES_IN_TEXT = new Set(["lim", "liminf", "limsup", "sup", "inf", "max", "min", "sin", "cos", "tan", "cot",
  "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "exp", "ln", "log", "det", "dim", "ker", "Ker", "deg", "gcd",
  "pgcd", "ppcm", "arg", "sgn", "tr", "Tr", "Vect", "Card", "card", "ch", "sh", "th", "Id", "id", "rg"]);

const STYLE_TEX = { bf: "mathbf", bb: "mathbb", cal: "mathcal", frak: "mathfrak", sf: "mathsf", tt: "mathtt", bfit: "boldsymbol" };
const BB_CAP = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
const CAL_CAP = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
const CAL_LOW = { e: "ℯ", g: "ℊ", o: "ℴ" };
const FRAK_CAP = { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" };

// Lettre stylée (ℝ, 𝒜, 𝔤…) à partir d'une lettre ASCII.
function styledLetter(ch, style) {
  const up = ch >= "A" && ch <= "Z";
  if (!up && !(ch >= "a" && ch <= "z")) return ch;
  const i = ch.charCodeAt(0) - (up ? 65 : 97);
  if (style === "bb") return up ? BB_CAP[ch] ?? String.fromCodePoint(0x1d538 + i) : String.fromCodePoint(0x1d552 + i);
  if (style === "cal") return up ? CAL_CAP[ch] ?? String.fromCodePoint(0x1d49c + i) : CAL_LOW[ch] ?? String.fromCodePoint(0x1d4b6 + i);
  if (style === "frak") return up ? FRAK_CAP[ch] ?? String.fromCodePoint(0x1d504 + i) : String.fromCodePoint(0x1d51e + i);
  return ch;
}

// Symboles alphanumériques mathématiques (U+1D400…) : lettre de base et style.
const ALNUM = [[0x1d400, "bf"], [0x1d434, "it"], [0x1d468, "bfit"], [0x1d49c, "cal"], [0x1d4d0, "cal"], [0x1d504, "frak"],
  [0x1d538, "bb"], [0x1d56c, "frak"], [0x1d5a0, "sf"], [0x1d5d4, "sf"], [0x1d608, "sf"], [0x1d63c, "sf"], [0x1d670, "tt"],
  [0x1d6a4, "it"], [0x1d6a8, "bf"], [0x1d6e2, "it"], [0x1d71c, "bfit"], [0x1d756, "bf"], [0x1d790, "bfit"],
  [0x1d7ca, "bf"], [0x1d7ce, "bf"], [0x1d7d8, "bb"], [0x1d7e2, "sf"], [0x1d7ec, "sf"], [0x1d7f6, "tt"]];
function mathAlnum(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x1d400 || cp > 0x1d7ff) {
    if (BB_CAP_REV[ch]) return { base: BB_CAP_REV[ch], style: "bb", ch };
    if (CAL_REV[ch]) return { base: CAL_REV[ch], style: "cal", ch };
    if (FRAK_REV[ch]) return { base: FRAK_REV[ch], style: "frak", ch };
    return null;
  }
  let style = "it";
  for (const [start, s] of ALNUM) if (cp >= start) style = s;
  return { base: ch.normalize("NFKC"), style, ch };
}
const rev = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const BB_CAP_REV = rev(BB_CAP);
const CAL_REV = { ...rev(CAL_CAP), ...rev(CAL_LOW) };
const FRAK_REV = rev(FRAK_CAP);

/* ------------------------------------------------------------------ */
/* Polices                                                             */
/* ------------------------------------------------------------------ */

const FONT_CLASSES = [
  [/^(KaTeX_Main|KaTeX_Size|MathJax_Main|MathJax_Size|MJXTEX(-B)?$|MJXTEX-S\d|MJXZERO)/i, "ot"],
  [/^(CMMIB?\d|LMMathItalic|EUR[MB]\d|(New)?(TX|PX)MI|ntxmi|zxlmi|txmi|pxmi|KaTeX_Math|MathJax_Math|MJXTEX-B?I$)/i, "it"],
  [/^(CMB?SY\d|LMMathSymbols|EUS[MB]\d|(New)?(TX|PX)SY|ntxsy|txsy|pxsy|MSAM\d|stmary|wasy|MnSymbol|esint|txsym|pxsym)/i, "sy"],
  [/^(CMEX\d|LMMathExtension|EUEX\d|(New)?(TX|PX)EX|ntxexx?|txex|pxex)/i, "ex"],
  [/^(MSBM\d|KaTeX_AMS|MathJax_AMS|MJXTEX-A|bbold|dsrom)/i, "bb"],
  [/^(EUF[MB]\d|KaTeX_Fraktur|MathJax_Fraktur|MJXTEX-FR)/i, "frak"],
  [/^(RSFS|KaTeX_Caligraphic|KaTeX_Script|MathJax_Caligraphic|MathJax_Script|MJXTEX-S?C$)/i, "cal"],
  [/Math/i, "ot"],
  [/^CM(R|BX|B|SS|SSBX|SSI|SL|TI|BXTI|CSC|U|FIB|DUNH)\d/, "cmr"],
];
const MATH_CLASSES = new Set(["it", "sy", "ex", "bb", "frak", "cal", "ot"]);

function fontInfo(f) {
  const name = String(f?.name ?? "").replace(/^[A-Z]{6}\+/, "");
  const cls = FONT_CLASSES.find(([re]) => re.test(name))?.[1] ?? "text";
  return {
    name,
    family: name.replace(/[-_,].*$/, "").replace(/\d+$/, ""),
    cls,
    type3: f?.type === "Type3",
    bold: /Bold|Black|Heavy|Semibold|SemiBold|Demi|CMBX|CMB\d|BXTI|Bd\b/i.test(name),
    italic: cls !== "it" && /Italic|Oblique|CMTI|CMSL|BXTI|\bIt\b|-It$|Ital/i.test(name),
    mono: (!!f?.isMonospace && f?.type !== "Type3") || /Mono|Courier|CMTT|SFTT|LMMono|Consola|Menlo|Inconsolata|Typewriter|SourceCode|FiraCode|Cascadia/i.test(name),
    ot1: /^CM/.test(name),
  };
}

// Paramètres du document : polices, taille du texte courant, présence de maths.
function documentContext(pages) {
  const fonts = new Map();
  const letters = new Map();
  const sizes = new Map();
  const cmexRaw = new Map();
  let math = false;
  for (const page of pages) {
    for (const it of [...page.items, ...(page.glyphs ?? [])]) {
      let fi = fonts.get(it.fontName);
      if (!fi) fonts.set(it.fontName, (fi = fontInfo(page.fonts.get(it.fontName))));
      if (!it.str || (!it.str.trim() && fi.cls !== "ex")) continue;
      // lettres des vrais mots (pas les noms d'opérateurs comme sin ou lim)
      const n = (it.str.match(/\p{L}{2,}/gu) ?? []).filter((w) => !OPNAMES.has(w) && !OPNAMES_FR.has(w)).join("").length;
      if (MATH_CLASSES.has(fi.cls) || /[\u{1d400}-\u{1d7ff}]/u.test(it.str)) math = true;
      if (fi.cls === "ex") {
        const raw = /[\x00-\x1f0-9A-Za-z]/.test(it.str);
        cmexRaw.set(it.fontName, (cmexRaw.get(it.fontName) ?? false) || raw);
      }
      if (fi.cls === "text" || fi.cls === "cmr") {
        letters.set(fi.family, (letters.get(fi.family) ?? 0) + n);
        const [, , c, d] = it.transform;
        const size = Math.round(Math.hypot(c, d) * 10) / 10;
        sizes.set(size, (sizes.get(size) ?? 0) + it.str.length);
      }
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const textFamily = top(letters) ?? "";
  // En OT1 (ou avec la même police partout), les chiffres et opérateurs des
  // formules sont dans la police du texte : ils ne suffisent pas à repérer une formule.
  const cmrIsText = /^CM/.test(textFamily) || [...fonts.values()].some((f) => f.cls === "cmr" && f.family === textFamily);
  for (const [k, fi] of fonts) {
    fi.math = MATH_CLASSES.has(fi.cls) || (fi.cls === "cmr" && !cmrIsText);
    fi.raw = fi.cls === "ex" && cmexRaw.get(k);
  }
  return { fonts, bodySize: top(sizes) ?? 10, math, textFamily };
}

/* ------------------------------------------------------------------ */
/* Atomes : un glyphe (formules) ou un mot (texte) avec sa géométrie   */
/* ------------------------------------------------------------------ */

const DEFAULT_FONT = { name: "", family: "", cls: "text", math: false, bold: false, italic: false, mono: false };

function geometry(a) {
  if (a.lo == null) {
    a.lo = a.y - 0.22 * a.size;
    // lettres sans hampe (a, c, x, z…) : le haut est à la hauteur d'x
    a.hi = a.y + (/^[acemnorsuvwxzıȷ.,:;=+−<>~·∗αεικνοπστυωγημρχ-]+$/u.test(a.s ?? "") ? 0.5 : 0.72) * a.size;
  }
  a.cy ??= a.y + 0.25 * a.size;
  a.bx1 = a.x1;
  return a;
}

// Compose les accents posés à part avec la lettre qui suit (ou précède, pour la cédille).
function composeAccents(items, fonts) {
  const out = items.map((it) => ({ ...it, str: fixText(it.str ?? "", fonts.get(it.fontName) ?? DEFAULT_FONT) }));
  const isAcc = (c, fi) => c in SPACING_ACC && (!"`^~".includes(c) || fi.ot1 || fi.type3);
  for (let i = 0; i < out.length; i++) {
    const fi = fonts.get(out[i].fontName) ?? DEFAULT_FONT;
    if (fi.math) continue;
    let s = out[i].str;
    // à l'intérieur d'un même élément
    s = s.replace(/([´`ˆ^¨˜~¯˘˙˚ˇ˝])(\p{L})/gu, (m, acc, l) => (isAcc(acc, fi) ? (l + SPACING_ACC[acc]).normalize("NFC") : m));
    s = s.replace(/(\p{L})([¸˛])/gu, (m, l, acc) => (l + SPACING_ACC[acc]).normalize("NFC"));
    // accent en fin d'élément, lettre au début du suivant
    const next = out[i + 1];
    const last = s.slice(-1);
    if (next && isAcc(last, fi) && !"¸˛".includes(last)) {
      const nf = fonts.get(next.fontName) ?? DEFAULT_FONT;
      const m = /^\p{L}/u.exec(next.str);
      if (m && !nf.math) {
        // la largeur de l'élément comprenait l'accent : on la réduit d'autant
        const before = [...s].reduce((n, ch) => n + charWeight(ch), 0);
        s = s.slice(0, -1);
        const after = [...s].reduce((n, ch) => n + charWeight(ch), 0);
        if (before > 0) out[i].width *= after / before;
        next.str = (m[0] + SPACING_ACC[last]).normalize("NFC") + next.str.slice(m[0].length);
      }
    }
    if (next && /^[¸˛]/.test(next.str) && /\p{L}$/u.test(s)) {
      s = (s + SPACING_ACC[next.str[0]]).normalize("NFC");
      next.str = next.str.slice(1);
    }
    out[i].str = s;
  }
  return out;
}

// Ligatures, codes de contrôle des polices TeX.
function fixText(s, fi) {
  if (fi.math) return s;
  const table = fi.ot1 ? OT1_CTRL : T1_CTRL;
  const chars = [...s];
  let out = "";
  chars.forEach((c, i) => {
    const cp = c.codePointAt(0);
    if (cp < 32) out += table[cp] ?? "";
    else if (cp >= 0x80 && cp < 0xa0) {
      // codes 128-159 sans Unicode : lettre T1 au milieu d'un mot, symbole TS1 (•, †…) sinon
      const inWord = /\p{L}/u.test(chars[i - 1] ?? "") && /\p{L}/u.test(chars[i + 1] ?? "");
      out += (inWord ? T1_HIGH : TS1_HIGH)[cp - 0x80] ?? "";
    } else out += LIGATURES[c] ?? c;
  });
  return out;
}
const T1_HIGH = [..."ĂĄĆČĎĚĘĞĹĽŁŃŇŊŐŔŘŚŠŞŤŢŰŮŸŹŽŻĲİđ§"];
const TS1_HIGH = [..."˘ˇ˝ †‡‖‰•℃$¢ƒ₡₩₦₲₱₤℞‽ ₫™‱¶฿№ ℮◦℠"];

// Atome mathématique : texte brut, code TeX et rôle.
function mathGlyph(ch, fi, a) {
  let cp = ch.codePointAt(0);
  if (PUA_CMEX[cp] != null) {
    cp = PUA_CMEX[cp];
    if (fi.cls !== "ex") {
      const c = CMEX_CH[cp];
      return setGlyph(a, PIECES[c] ?? c, PIECES[c] ?? c, "piece");
    }
  }
  if (fi.cls === "ex" && (fi.raw || cp < 0x20 || PUA_CMEX[ch.codePointAt(0)] != null) && cp < 128) {
    const c = CMEX_CH[cp];
    a.cmex = cp;
    a.hi = a.y + CMEX_H[cp] * a.size;
    a.lo = a.hi - CMEX_T[cp] * a.size;
    a.cy = (a.hi + a.lo) / 2;
    a.y = a.cy - 0.25 * a.size;
    a.big = true;
    if (CMEX_WIDE_ACC[cp]) return setGlyph(a, c, c, "acc", CMEX_WIDE_ACC[cp]);
    if (c === "√") return setGlyph(a, c, "\\surd", "rad");
    if (c in PIECES) return setGlyph(a, PIECES[c], PIECES[c], "piece");
    return setGlyph(a, c, TEX[c] ?? c, roleOf(c));
  }
  if (/[A-Za-z]/.test(ch) && (fi.cls === "bb" || fi.cls === "frak" || fi.cls === "cal" || (fi.cls === "sy" && /[A-Z]/.test(ch)))) {
    const style = fi.cls === "sy" ? "cal" : fi.cls;
    return setGlyph(a, styledLetter(ch, style), `\\${STYLE_TEX[style]}{${ch}}`, "ord");
  }
  if (fi.cls === "sy" && ch === "\\") return setGlyph(a, "∖", "\\setminus", "bin");
  // CMSY : « 7 » est la tige de ↦, « 6 » la barre de négation
  if (fi.cls === "sy" && (ch === "7" || (ch === "6" && a.x1 - a.x0 < 0.08 * a.size))) {
    return setGlyph(a, ch === "7" ? "7" : "\u0338", "", "prefix");
  }
  const alnum = mathAlnum(ch);
  if (alnum) {
    const { base, style } = alnum;
    const txt = style === "bb" || style === "cal" || style === "frak" ? ch : base;
    let tex = TEX[base] ?? base;
    if (STYLE_TEX[style]) tex = `\\${STYLE_TEX[style]}{${tex}}`;
    return setGlyph(a, txt, tex, "ord");
  }
  const c = NORMALIZE[ch] ?? ch;
  if (/[A-Za-z]/.test(c)) {
    // Lettre droite dans une formule (\mathrm, noms d'opérateurs) sauf en italique mathématique.
    const up = fi.cls !== "it";
    a.up = up;
    return setGlyph(a, c, fi.bold ? `\\${up ? "mathbf" : "boldsymbol"}{${c}}` : c, "ord");
  }
  if (c === "√") {
    // Le signe radical pend sous son origine, posée à la hauteur de la barre.
    a.hi = a.y + 0.04 * a.size;
    a.lo = a.y - 0.96 * a.size;
    a.cy = (a.hi + a.lo) / 2;
    a.y = a.cy - 0.25 * a.size;
  }
  if (c in MATH_ACC) a.accName = MATH_ACC[c];
  return setGlyph(a, c, TEX[c] ?? c, a.accName ? "acc" : roleOf(c));
}
function setGlyph(a, s, tex, role, accName) {
  a.s = s;
  a.tex = tex;
  a.role = role;
  if (accName) a.accName = accName;
  return a;
}
function roleOf(c) {
  if (OPEN.includes(c)) return "open";
  if (CLOSE.includes(c)) return "close";
  if (c === "|" || c === "‖" || c === "∥") return "fence";
  if (BIGOPS.includes(c)) return "op";
  if (c === "√") return "rad";
  return "ord";
}

function charWeight(c) {
  if (/\s/.test(c)) return 0.33;
  if (/[ijlrtf.,;:!'’|()[\]{}]/.test(c)) return 0.3;
  if (/[mwMW]/.test(c)) return 0.85;
  if (/[A-Z]/.test(c)) return 0.7;
  if (/[=+−<>≤≥≈≠∈∉⊂⊆→←↦⇒⇔×±∓≡∼∑∏∫∞]/.test(c)) return 0.78;
  if (/[\u0300-\u036f\u20d0-\u20ff]/.test(c)) return 0;
  if (/[\u3000-\u9fff\uac00-\ud7af]/.test(c)) return 1;
  return 0.5;
}

const WORD_RE = /-(?=\p{L})[\p{L}\p{M}\p{N}'’\-]*|[\p{L}\p{M}'’][\p{L}\p{M}\p{N}'’\-]*|\p{N}+|\S/gu;

// Glyphes CMEX retrouvés dans le dessin : ajoutés comme éléments, juste après
// l'élément qui les précède sur la même ligne.
function withGlyphs(items, glyphs) {
  if (!glyphs?.length) return items;
  const out = items.map((it, i) => ({ ...it, order: i }));
  for (const g of glyphs) {
    let after = -1;
    items.forEach((it, i) => {
      const [, , , d, x, y] = it.transform;
      const size = Math.abs(d) || 1;
      if (x + it.width <= g.x + 0.2 * size && Math.abs(y - g.y) < 2.5 * g.size && x > g.x - 30 * size) after = Math.max(after, i);
    });
    out.push({ str: g.str, transform: [g.size, 0, 0, g.size, g.x, g.y], width: g.width, fontName: g.fontName, order: after + 0.5 });
  }
  return out.sort((a, b) => a.order - b.order);
}

function pageAtoms(page, ctx) {
  const atoms = [];
  const rotated = [];
  const items = composeAccents(withGlyphs(page.items, page.glyphs), ctx.fonts);
  let gapBefore = false;
  let soft = false;
  items.forEach((it, i) => {
    const str = it.str;
    if (!str) {
      if (it.hasEOL) gapBefore = true;
      return;
    }
    const fi = ctx.fonts.get(it.fontName) ?? DEFAULT_FONT;
    const [a, b, c, d, x, y] = it.transform;
    if (Math.abs(b) > 0.1 * Math.abs(a) || Math.abs(c) > 0.1 * Math.abs(d) || a <= 0 || d <= 0) {
      if (str.trim()) rotated.push(str.trim());
      return;
    }
    if (!str.trim() && !(fi.cls === "ex" && /[\t\n\v\f\r]/.test(str))) {
      // espace ajoutée par pdf.js entre deux éléments : simple indice, la géométrie décide
      soft = true;
      return;
    }
    const size = Math.hypot(c, d) || 1;
    const chars = Array.from(fi.math ? str.normalize("NFC") : str);
    // largeur de chaque caractère estimée d'après sa forme (pdf.js ne donne que la largeur totale)
    const weights = chars.map(charWeight);
    const total = weights.reduce((n, w) => n + w, 0) || 1;
    const scale = (it.width > 0 ? it.width : size * 0.5 * total) / total;
    const starts = [];
    weights.reduce((x0, w) => (starts.push(x0), x0 + w * scale), x);
    starts.push(x + total * scale);
    const base = { size, font: fi, b: fi.bold, i: fi.italic, mono: fi.mono, math: fi.math };
    const push = (k, len, extra) => {
      const atom = { ...base, x0: starts[k], x1: starts[k + len], y, idx: i + k / 1000, space: gapBefore, soft, ...extra };
      gapBefore = false;
      soft = false;
      atoms.push(atom);
      return atom;
    };
    if (fi.math) {
      chars.forEach((ch, k) => {
        // dans CMEX, les codes 9 à 13 sont des délimiteurs, pas des blancs
        if (/\s/.test(ch) && !(fi.cls === "ex" && ch !== " ")) return void (gapBefore = true);
        const atom = push(k, 1, {});
        mathGlyph(ch, fi, atom);
        if (!atom.s && atom.role !== "prefix") atoms.pop();
        else geometry(atom);
      });
    } else {
      const s = chars.join("");
      const offsets = [];
      let k = 0;
      for (const ch of chars) offsets.push((k += ch.length) - ch.length);
      const cpIndex = (u) => offsets.findIndex((o) => o >= u);
      for (const m of s.matchAll(WORD_RE)) {
        if (m.index > 0 && /\s/.test(s[m.index - 1])) gapBefore = true;
        const k0 = cpIndex(m.index);
        const len = Array.from(m[0]).length;
        const word = m[0];
        const neutral = !/[\p{L}]/u.test(word);
        const atom = push(k0, len, { s: word, tex: word, role: "ord", word: !neutral, neutral });
        if (neutral) {
          atom.s = NORMALIZE[word] ?? word;
          atom.tex = TEX[atom.s] ?? atom.s;
          atom.role = MATH_ACC[atom.s] ? "acc" : roleOf(atom.s);
          if (MATH_ACC[atom.s]) atom.accName = MATH_ACC[atom.s];
        }
        geometry(atom);
      }
      if (/\s$/.test(s)) gapBefore = true;
    }
    if (it.hasEOL) gapBefore = true;
  });
  return { atoms: mergeAtoms(atoms), rotated };
}

const overlapX = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const width = (a) => a.x1 - a.x0;

// Surimpressions (≠, ∉, ↦, flèches longues), noms d'opérateurs et nombres.
function mergeAtoms(atoms) {
  const out = [];
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    const b = atoms[i + 1];
    const mathish = (e) => e.math || e.neutral;
    if (b && mathish(a) && mathish(b) && (a.math || b.math) && !a.big && !b.big) {
      const S = a.size;
      const sameLine = Math.abs(a.y - b.y) < 0.15 * S;
      // dans un même élément pdf.js, les positions sont estimées : deux glyphes collés sans espace comptent
      const sameItem = Math.floor(a.idx) === Math.floor(b.idx) && !b.space && JOIN[a.s + b.s];
      const touching = sameItem || a.role === "prefix" || (width(a) < 0.08 * S && Math.abs(b.x0 - a.x0) < 0.3 * S)
        || overlapX(a, b) > 0.35 * Math.min(width(a), width(b)) || (b.x0 < a.x1 - 0.08 * S && b.x0 > a.x0);
      if (touching && (sameLine || (Math.abs(a.y - b.y) < 0.5 * S && overlapX(a, b) > 0.6 * Math.min(width(a), width(b))))) {
        const c = atoms[i + 2];
        let s = null;
        let used = 2;
        if (a.role === "prefix" && a.s === "7" && b.s === "−" && c?.s === "→") [s, used] = ["⟼", 3];
        else if (a.role === "prefix" && a.s === "7") s = b.s === "→" ? "↦" : null;
        else if (a.s === "̸" || a.s === "/") s = NEG[b.s] ?? (a.s === "̸" ? (b.s + "̸").normalize("NFC") : null);
        else if (b.s === "/" && NEG[a.s]) s = NEG[a.s];
        else s = JOIN[a.s + b.s] ?? null;
        if (s) {
          const m = { ...b, s, tex: TEX[s] ?? s, role: "ord", x0: Math.min(a.x0, b.x0), idx: a.idx };
          if (used === 3) m.x1 = c.x1;
          geometry(m);
          m.lo = Math.min(a.lo, b.lo);
          m.hi = Math.max(a.hi, b.hi);
          out.push(m);
          i += used - 1;
          continue;
        }
      }
    }
    if (a.role === "prefix") continue;
    out.push(a);
  }
  // Lettres droites accolées (lim, sin, det…) et chiffres d'un même nombre.
  const merged = [];
  for (const a of out) {
    const p = merged[merged.length - 1];
    const glue = p && a.math && p.math && (!a.space || a.x0 - p.x1 < 0.06 * a.size) && Math.abs(a.y - p.y) < 0.05 * a.size && Math.abs(a.size - p.size) < 0.05 * a.size
      && a.x0 - p.x1 < 0.12 * a.size && a.x0 - p.x1 > -0.2 * a.size;
    if (glue && p.up && a.up && p.font === a.font) {
      p.s += a.s;
      p.tex = p.s;
      p.x1 = p.bx1 = a.x1;
      continue;
    }
    if (glue && /^\d+$/.test(p.s) && /^\d$/.test(a.s) && p.font === a.font) {
      p.s += a.s;
      p.tex = p.s;
      p.x1 = p.bx1 = a.x1;
      continue;
    }
    merged.push(a);
  }
  for (const a of merged) {
    if (a.up && a.s.length > 1) {
      a.opname = OPNAMES.has(a.s) || OPNAMES_FR.has(a.s);
      a.tex = OPNAMES.has(a.s) ? `\\${a.s}` : a.opname ? `\\operatorname{${a.s}}` : `\\mathrm{${a.s}}`;
    } else if (a.up && /[A-Za-z]/.test(a.s) && a.tex === a.s) {
      a.tex = `\\mathrm{${a.s}}`;
    }
    if (a.word && OPNAMES_IN_TEXT.has(a.s)) a.opcand = true;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Filets horizontaux (barres de fraction et de radical)               */
/* ------------------------------------------------------------------ */

// Lit la liste d'opérations de pdf.js : traits horizontaux fins (barres de
// fraction et de radical) et glyphes de CMEX que getTextContent omet parce que
// leur code ressemble à un blanc (barres verticales des déterminants, \big\}…).
export function extractGraphics(opList, OPS, getFont) {
  const rules = [];
  const glyphs = [];
  const PAINT = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke].filter((v) => v != null));
  let ctm = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  // état du texte, comme dans le moteur de rendu de pdf.js
  const fontCache = new Map();
  let tm = [1, 0, 0, 1, 0, 0];
  let tx = 0, ty = 0, lineX = 0, lineY = 0, leading = 0, charSpacing = 0, wordSpacing = 0, hScale = 1, rise = 0;
  let font = null, fontSize = 0, fontName = null;
  const showText = (list) => {
    if (!font?.cmex) {
      for (const g of list) {
        if (typeof g === "number") tx -= (g * fontSize) / 1000 * hScale;
        else if (g) tx += ((g.width ?? 0) * fontSize / 1000 + (g.isSpace ? wordSpacing : 0) + charSpacing) * hScale;
      }
      return;
    }
    for (const g of list) {
      if (typeof g === "number") {
        tx -= (g * fontSize) / 1000 * hScale;
        continue;
      }
      if (!g) continue;
      const code = g.originalCharCode;
      if (code >= 9 && code <= 13) {
        const m = mul(ctm, tm);
        const x = m[0] * tx + m[2] * (ty + rise) + m[4];
        const y = m[1] * tx + m[3] * (ty + rise) + m[5];
        const scale = Math.hypot(m[2], m[3]);
        glyphs.push({ str: String.fromCharCode(code), x, y, size: fontSize * scale, width: (g.width ?? 0) * fontSize / 1000 * scale, fontName });
      }
      tx += ((g.width ?? 0) * fontSize / 1000 + charSpacing) * hScale;
    }
  };
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push([ctm, lineWidth]);
    else if (fn === OPS.restore) [ctm, lineWidth] = stack.pop() ?? [ctm, lineWidth];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push([ctm, lineWidth]);
      if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(ctm, Array.from(args[0]));
    } else if (fn === OPS.paintFormXObjectEnd) [ctm, lineWidth] = stack.pop() ?? [ctm, lineWidth];
    else if (fn === OPS.setLineWidth) lineWidth = args[0];
    else if (fn === OPS.beginText) {
      tm = [1, 0, 0, 1, 0, 0];
      tx = ty = lineX = lineY = 0;
    } else if (fn === OPS.setFont) {
      fontName = args[0];
      fontSize = args[1];
      if (!fontCache.has(fontName)) {
        let f = null;
        try {
          f = getFont?.(fontName);
        } catch {
          // police absente : ignorée
        }
        fontCache.set(fontName, { cmex: /CMEX|LMMathExtension/.test(String(f?.name ?? "")) });
      }
      font = fontCache.get(fontName);
    } else if (fn === OPS.setTextMatrix) {
      tm = Array.from(args.length === 6 ? args : args[0] ?? args);
      tx = ty = lineX = lineY = 0;
    } else if (fn === OPS.moveText) {
      tx = lineX += args[0];
      ty = lineY += args[1];
    } else if (fn === OPS.setLeading) leading = -args[0];
    else if (fn === OPS.setLeadingMoveText) {
      leading = args[1];
      tx = lineX += args[0];
      ty = lineY += args[1];
    } else if (fn === OPS.nextLine) {
      tx = lineX += 0;
      ty = lineY += leading;
    } else if (fn === OPS.setCharSpacing) charSpacing = args[0];
    else if (fn === OPS.setWordSpacing) wordSpacing = args[0];
    else if (fn === OPS.setHScale) hScale = args[0] / 100;
    else if (fn === OPS.setTextRise) rise = args[0];
    else if (fn === OPS.showText || fn === OPS.showSpacedText) showText(args[0] ?? []);
    else if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      if (fn === OPS.nextLineSetSpacingShowText) {
        wordSpacing = args[0];
        charSpacing = args[1];
      }
      tx = lineX;
      ty = lineY += leading;
      showText(args[args.length - 1] ?? []);
    } else if (fn === OPS.constructPath && args) {
      const [op, , minMax] = args;
      if (!PAINT.has(op) || !minMax || minMax.length < 4) continue;
      if (Math.abs(ctm[1]) > 1e-3 || Math.abs(ctm[2]) > 1e-3) continue; // traits tournés : ignorés
      const xs = [ctm[0] * minMax[0] + ctm[4], ctm[0] * minMax[2] + ctm[4]];
      const ys = [ctm[3] * minMax[1] + ctm[5], ctm[3] * minMax[3] + ctm[5]];
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const stroked = op !== OPS.fill && op !== OPS.eoFill;
      const thick = (y1 - y0) + (stroked ? lineWidth * Math.abs(ctm[3]) : 0);
      if (x1 - x0 >= 1.5 && thick <= 2 && (x1 - x0) > 3 * thick) rules.push({ x0, x1, y: (y0 + y1) / 2 });
    }
  }
  return { rules, glyphs };
}

/* ------------------------------------------------------------------ */
/* Structures : radicaux, fractions, bornes, matrices, indices          */
/* ------------------------------------------------------------------ */

function box(kind, parts, extra) {
  const all = parts.filter(Boolean);
  const e = {
    kind, math: true, x0: Math.min(...all.map((p) => p.x0)), x1: Math.max(...all.map((p) => p.x1)),
    lo: Math.min(...all.map((p) => p.lo)), hi: Math.max(...all.map((p) => p.hi)), idx: Math.min(...all.map((p) => p.idx)),
    space: all.reduce((m, p) => (p.idx < m.idx ? p : m)).space, ...extra,
  };
  e.bx1 = e.x1;
  e.cy ??= e.y + 0.25 * e.size;
  return e;
}

// Ligne de base principale d'un groupe : celle de ses plus grands éléments.
function mainOf(els) {
  const big = Math.max(...els.map((e) => e.size));
  const main = els.filter((e) => e.size > 0.9 * big);
  const ys = main.map((e) => e.y).sort((a, b) => a - b);
  return { y: ys[Math.floor(ys.length / 2)], size: big };
}

function rowGap(els, size) {
  const s = [...els].sort((a, b) => a.x0 - b.x0);
  let gap = 0;
  for (let i = 1; i < s.length; i++) gap = Math.max(gap, s[i].x0 - s[i - 1].x1);
  return gap / size;
}

// Taille du texte qui entoure un élément (pour une fraction en petits caractères).
function contextSize(els, x0, x1, cy, fallback) {
  let best = null;
  for (const e of els) {
    if (e.x1 > x0 - 0.1 && e.x0 < x1 + 0.1) continue;
    const d = Math.min(Math.abs(e.x1 - x0), Math.abs(e.x0 - x1));
    if (d > 2 * e.size || Math.abs(e.cy - cy) > 0.35 * e.size) continue;
    if (!best || d < best.d) best = { d, size: e.size };
  }
  return Math.max(best?.size ?? 0, fallback);
}

function applyRules(atoms, rules, ctx) {
  let els = atoms.slice();
  const sorted = [...rules].sort((a, b) => (a.x1 - a.x0) - (b.x1 - b.x0));
  // Fraction : un numérateur juste au-dessus du filet, un dénominateur juste en dessous.
  function makeFraction(r, above, below) {
    const w = r.x1 - r.x0;
    const within = (e) => e.x0 >= r.x0 - 0.25 * e.size && e.x1 <= r.x1 + 0.25 * e.size;
    const grow = (core, up) => {
      const m = mainOf(core);
      const sz = m.size;
      return els.filter((e) => within(e) && (up ? e.lo >= r.y - 0.12 * e.size : e.hi <= r.y + 0.12 * e.size)
        && e.y - m.y >= -0.45 * sz && e.y - m.y <= 0.75 * sz && (e.size <= sz * 1.05 || Math.abs(e.y - m.y) < 0.2 * sz)
        && (up ? e.lo <= r.y + 1.3 * sz : e.hi >= r.y - 1.3 * sz));
    };
    const num = grow(above, true);
    const den = grow(below, false);
    const sz = Math.max(...num.map((e) => e.size), ...den.map((e) => e.size));
    const nw = Math.max(...num.map((e) => e.x1)) - Math.min(...num.map((e) => e.x0));
    const dw = Math.max(...den.map((e) => e.x1)) - Math.min(...den.map((e) => e.x0));
    const anyMath = [...num, ...den].some((e) => e.math || e.neutral);
    // le numérateur et le dénominateur se suivent dans le flux du PDF (sinon : deux lignes voisines)
    const idxN = num.map((e) => e.idx);
    const idxD = den.map((e) => e.idx);
    const streamGap = Math.min(Math.abs(Math.min(...idxD) - Math.max(...idxN)), Math.abs(Math.min(...idxN) - Math.max(...idxD)));
    if (streamGap > 6) return null;
    if (!anyMath || Math.max(nw, dw) < 0.6 * w - 0.3 * sz || rowGap(num, sz) > 1.2 || rowGap(den, sz) > 1.2) return null;
    const others = els.filter((e) => !num.includes(e) && !den.includes(e));
    const size = contextSize(others, r.x0, r.x1, r.y, sz);
    const e = box("frac", [...num, ...den, { x0: r.x0, x1: r.x1, lo: r.y, hi: r.y, idx: Infinity }],
      { y: r.y - 0.25 * size, cy: r.y, size, num: reduce(num, ctx), den: reduce(den, ctx) });
    return { e, used: new Set([...num, ...den]) };
  }

  for (const r of sorted) {
    const w = r.x1 - r.x0;
    const near = els.filter((e) => e.x1 > r.x0 - 2 && e.x0 < r.x1 + 2 && Math.abs(e.cy - r.y) < 3 * e.size);
    if (!near.length) continue;
    const S = Math.max(...near.map((e) => e.size));
    const within = (e) => e.x0 >= r.x0 - 0.25 * e.size && e.x1 <= r.x1 + 0.25 * e.size;
    // Radical : le signe √ touche le début du filet.
    const rad = els.find((e) => e.role === "rad" && !e.kind && Math.abs(e.x1 - r.x0) < 0.45 * S && e.lo < r.y && e.hi > r.y - 1.6 * S);
    if (rad) {
      const body = els.filter((e) => e !== rad && within(e) && e.hi <= r.y + 0.2 * e.size && e.hi >= r.y - 1.3 * S && e.lo > rad.lo - 0.4 * S);
      if (body.length) {
        const index = els.filter((e) => e !== rad && !body.includes(e) && e.size < 0.85 * rad.size && e.x1 <= rad.x0 + 0.75 * width(rad)
          && e.x1 > rad.x0 - 0.3 * S && e.lo > rad.lo + 0.25 * (rad.hi - rad.lo) && e.lo < r.y && Math.abs(e.idx - rad.idx) < 3);
        const m = mainOf(body);
        const e = box("sqrt", [rad, ...body, ...index, { x0: r.x0, x1: r.x1, lo: r.y, hi: r.y + 0.1, idx: rad.idx }],
          { y: m.y, size: m.size, body: reduce(body, ctx), index: index.length ? reduce(index, ctx) : null });
        e.hi = Math.max(e.hi, r.y);
        els = els.filter((x) => x !== rad && !body.includes(x) && !index.includes(x));
        els.push(e);
        continue;
      }
    }
    if (!ctx.math) continue;
    // Fraction : quelque chose juste au-dessus et juste en dessous.
    const above = els.filter((e) => within(e) && e.lo >= r.y - 0.12 * e.size && e.lo <= r.y + 0.6 * e.size);
    const below = els.filter((e) => within(e) && e.hi <= r.y + 0.12 * e.size && e.hi >= r.y - 0.6 * e.size);
    const frac = above.length && below.length ? makeFraction(r, above, below) : null;
    if (frac) {
      els = els.filter((e) => !frac.used.has(e));
      els.push(frac.e);
      continue;
    }
    {
      if (below.length) {
        // Barre au-dessus d'une expression (conjugué, adhérence…)
        const m = mainOf(below);
        const body = els.filter((e) => within(e) && Math.abs(e.y - m.y) < 0.6 * m.size && e.hi <= r.y + 0.12 * e.size);
        const bw = Math.max(...body.map((e) => e.x1)) - Math.min(...body.map((e) => e.x0));
        if (body.some((e) => e.math) && Math.abs(bw - w) < 0.6 * m.size && w < 12 * m.size) {
          const e = box("over", [...body], { y: m.y, size: m.size, body: reduce(body, ctx) });
          e.hi = Math.max(e.hi, r.y);
          els = els.filter((x) => !body.includes(x));
          els.push(e);
        }
      }
      continue;
    }
  }
  return els;
}

// Délimiteurs faits de morceaux empilés : un seul grand délimiteur.
function joinPieces(els) {
  const pieces = els.filter((e) => e.role === "piece" || (e.big && (e.role === "fence" || e.cmex === 0x0c || e.cmex === 0x0d)));
  if (pieces.length < 2) return els.map((e) => (e.role === "piece" ? asDelim(e) : e));
  const used = new Set();
  const out = [];
  for (const p of pieces.sort((a, b) => b.hi - a.hi)) {
    if (used.has(p)) continue;
    const group = [p];
    used.add(p);
    let low = p.lo;
    for (const q of pieces) {
      if (used.has(q) || Math.abs(q.x0 - p.x0) > 0.2 * p.size || q.hi < low - 0.3 * p.size || q.hi > low + 0.3 * p.size) continue;
      group.push(q);
      used.add(q);
      low = q.lo;
    }
    const kind = group.map((g) => g.s).find((s) => s !== "⎪" && s !== "|") ?? (group[0].s === "⎪" ? "{" : group[0].s);
    const d = { ...p, s: kind, tex: TEX[kind] ?? kind, role: roleOf(kind), lo: Math.min(...group.map((g) => g.lo)), big: true };
    d.cy = (d.lo + d.hi) / 2;
    d.y = d.cy - 0.25 * d.size;
    out.push(d);
  }
  return [...els.filter((e) => !pieces.includes(e)), ...out];
}
function asDelim(e) {
  const s = e.s === "⎪" ? "{" : e.s;
  return { ...e, s, tex: TEX[s] ?? s, role: roleOf(s) };
}

function reduce(list, ctx) {
  let els = joinPieces(list).sort((a, b) => a.idx - b.idx);
  els = applyAccents(els, ctx);
  els = applyLimits(els, ctx);
  els = applyStacks(els, ctx);
  els = applyScripts(els);
  return els.sort((a, b) => a.x0 - b.x0 || a.idx - b.idx);
}

function applyAccents(els, ctx) {
  const accents = els.filter((e) => e.role === "acc" && (e.math || e.neutral));
  if (!accents.length) return els;
  let out = els;
  for (const a of accents) {
    const thin = width(a) < 0.1 * a.size;
    const over = (e) => (thin ? a.x0 >= e.x0 - 0.1 * e.size && a.x0 <= e.x1 + 0.1 * e.size : overlapX(a, e) > 0.3 * Math.min(width(a), width(e)));
    const cands = out.filter((e) => e !== a && e.role !== "acc" && (e.math || e.kind) && over(e)
      && e.y <= a.y + 0.15 * e.size && e.y > a.y - 1.1 * e.size && e.size > 0.7 * a.size);
    if (!cands.length) continue;
    // TeX pose l'accent avant sa base : on préfère l'élément qui suit
    const rank = (e) => (e.idx > a.idx ? 0 : 1000) + Math.abs(e.idx - a.idx);
    const base = cands.sort((p, q) => rank(p) - rank(q))[0];
    const e = box("acc", [base, a], { y: base.y, size: base.size, cy: base.cy, acc: a.accName, body: [base] });
    out = out.filter((x) => x !== a && x !== base);
    out.push(e);
  }
  return out;
}

const isOpLike = (e) => e.role === "op" || (e.opname && ["lim", "liminf", "limsup", "max", "min", "sup", "inf"].includes(e.s)) || (e.opcand && ["lim", "max", "min", "sup", "inf"].includes(e.s));

// Bornes au-dessus et en dessous (∑, ∏, ⋃, lim en style « display »).
function applyLimits(els, ctx) {
  const ops = els.filter((e) => isOpLike(e) && !e.kind);
  if (!ops.length) return els;
  let out = els;
  for (const op of ops) {
    const S = op.size;
    const cx = (op.x0 + op.x1) / 2;
    // une borne est centrée sur l'opérateur (un indice, lui, est décalé à droite)
    const near = (e) => e !== op && e.size < 0.95 * S && Math.abs((e.x0 + e.x1) / 2 - cx) < 0.3 * Math.max(width(op), width(e)) + 0.1 * S;
    const close = (e) => Math.abs(e.idx - op.idx) < 8;
    const coreUp = op.role === "op" ? out.filter((e) => near(e) && close(e) && e.y - op.y > 0.7 * S && e.lo - op.hi < 0.8 * S) : [];
    const coreDown = out.filter((e) => near(e) && close(e) && op.y - e.y > 0.42 * S && op.lo - e.hi < 0.8 * S && e.hi < op.y + 0.2 * S);
    const row = (core) => {
      if (!core.length) return [];
      const m = mainOf(core);
      const set = new Set(core);
      let grown = true;
      while (grown) {
        grown = false;
        for (const e of out) {
          if (set.has(e) || e === op || Math.abs(e.y - m.y) > 0.25 * m.size || e.size > 1.05 * m.size) continue;
          if (Math.abs((e.x0 + e.x1) / 2 - cx) > 4 * S) continue;
          if ([...set].some((s) => e.x0 - s.x1 < 0.45 * m.size && s.x0 - e.x1 < 0.45 * m.size)) {
            set.add(e);
            grown = true;
          }
        }
      }
      return [...set];
    };
    const sup = row(coreUp);
    const sub = row(coreDown.filter((e) => !sup.includes(e)));
    if (!sup.length && !sub.length) continue;
    const e = box("op", [op, ...sup, ...sub], {
      y: op.y, size: S, cy: op.cy, base: op, limits: true,
      sub: sub.length ? reduce(sub, ctx) : null, sup: sup.length ? reduce(sup, ctx) : null,
    });
    e.bx1 = e.x1;
    out = out.filter((x) => x !== op && !sup.includes(x) && !sub.includes(x));
    out.push(e);
  }
  return out;
}

// Contenu empilé entre deux délimiteurs : binôme, matrice, système (cases).
function applyStacks(els, ctx) {
  const delims = els.filter((e) => e.role === "open" || e.role === "close" || e.role === "fence");
  if (!delims.length) return els;
  let out = els;
  const sorted = [...out].sort((a, b) => a.idx - b.idx);
  for (const L of delims.filter((d) => d.role === "open" || d.role === "fence")) {
    if (!out.includes(L)) continue;
    const S = L.size;
    const sameLevel = (d) => Math.abs(d.cy - L.cy) < 0.35 * S && Math.abs((d.hi - d.lo) - (L.hi - L.lo)) < 0.35 * (L.hi - L.lo) + 0.1 * S;
    const want = PAIR[L.s];
    const after = sorted.filter((e) => e.idx > L.idx && out.includes(e));
    let R = null;
    let depth = 0;
    for (const d of after) {
      if (!(d.role === "open" || d.role === "close" || d.role === "fence") || !sameLevel(d) || d.x0 < L.x1 - 0.1 * S) continue;
      if (d.s === want && (d.role === "close" || d.role === "fence") && depth === 0) {
        R = d;
        break;
      }
      if (d.role === "open" && d.s === L.s) depth++;
      else if (d.s === want && depth > 0) depth--;
    }
    if (!R && L.s !== "{") continue;
    let content;
    if (R) content = after.filter((e) => e !== R && e.idx < R.idx && e.x0 > L.x0 && e.x1 < R.x1 + 0.1 * S);
    else {
      // système (cases) : ce qui suit l'accolade hors de sa ligne de base, jusqu'au retour sur celle-ci
      content = [];
      for (const e of after) {
        if (Math.abs(e.y - L.y) < 0.22 * e.size && e.size > 0.88 * S) break;
        if (e.cy < L.lo - 0.2 * S || e.cy > L.hi + 0.2 * S || e.x0 < L.x0) break;
        content.push(e);
      }
    }
    const rows = stackRows(content, L);
    if (!rows) continue;
    if (L.role === "fence" && !L.big && rows.flat().every((e) => e.size < 0.88 * S)) continue;
    let used = content;
    if (!R) {
      // Système sans délimiteur fermant : le contenu s'arrête au retour sur la ligne du délimiteur.
      used = rows.flat();
    }
    if (rows.length < 2) continue;
    const cells = rows.map((r) => splitCells(r));
    const ncol = Math.max(...cells.map((c) => c.length));
    const allSmall = used.every((e) => e.size < 0.88 * S);
    let kind = "matrix";
    if (R && L.s === "(" && ncol === 1 && rows.length === 2 && (allSmall || cells.every((c) => c[0].length <= 2))) kind = "binom";
    else if (!R) kind = "cases";
    const e = box(kind, [L, R, ...used], {
      y: L.y, size: S, cy: L.cy, left: L.s, right: R?.s ?? "",
      rows: cells.map((r) => r.map((c) => reduce(c, ctx))),
    });
    out = out.filter((x) => x !== L && x !== R && !used.includes(x));
    out.push(e);
  }
  return out;
}

// Lignes d'un contenu empilé, ou null s'il y a quelque chose sur la ligne du délimiteur.
function stackRows(content, L) {
  if (content.length < 2) return null;
  const big = Math.max(...content.map((e) => e.size));
  const anchors = content.filter((e) => e.size > 0.88 * big);
  if (anchors.some((e) => Math.abs(e.y - L.y) < 0.22 * e.size)) return null;
  const rows = [];
  for (const e of [...anchors].sort((a, b) => b.y - a.y)) {
    const r = rows.find((r) => Math.abs(r.y - e.y) < 0.3 * e.size);
    if (r) r.items.push(e);
    else rows.push({ y: e.y, items: [e] });
  }
  if (rows.length < 2 || rows[0].y - rows[rows.length - 1].y < 0.6 * big) return null;
  if (!(rows[0].y > L.y && rows[rows.length - 1].y < L.y + 0.1 * L.size)) return null;
  for (const e of content) {
    if (anchors.includes(e)) continue;
    const r = rows.reduce((best, r) => (Math.abs(r.y - e.y) < Math.abs(best.y - e.y) ? r : best));
    r.items.push(e);
  }
  if (!L.big && L.s === "{") {
    // Accolade ordinaire (ensemble { 1, 2 }) : pas un système.
    if (rows.some((r) => r.items.length === 0)) return null;
  }
  return rows.map((r) => r.items);
}

function splitCells(items) {
  const s = [...items].sort((a, b) => a.x0 - b.x0);
  const size = Math.max(...s.map((e) => e.size));
  const cells = [[s[0]]];
  for (let i = 1; i < s.length; i++) {
    const prev = cells[cells.length - 1];
    const gap = s[i].x0 - Math.max(...prev.map((e) => e.x1));
    if (gap > 0.42 * size) cells.push([s[i]]);
    else prev.push(s[i]);
  }
  return cells;
}

// Indices et exposants : groupes de petits caractères accolés à une base.
function applyScripts(els) {
  const byIdx = [...els].sort((a, b) => a.idx - b.idx);
  // groupes de même taille, même hauteur, côte à côte
  const runs = [];
  for (const e of byIdx) {
    const r = runs[runs.length - 1];
    const last = r?.[r.length - 1];
    if (last && Math.abs(e.size - last.size) < 0.08 * last.size && Math.abs(e.y - last.y) < 0.15 * last.size
      && e.x0 - last.x1 < 0.5 * last.size && e.x0 - last.x1 > -0.3 * last.size) r.push(e);
    else runs.push([e]);
  }
  runs.sort((a, b) => a[0].size - b[0].size);
  let out = els;
  for (const run of runs) {
    const first = run.reduce((m, e) => (e.x0 < m.x0 ? e : m));
    const rs = first.size;
    const ry = mainOf(run).y;
    let best = null;
    // petits caractères du texte (appel de note, « 1er ») : seulement sur une formule qui les précède juste
    const textRun = run.every((e) => !e.math && !e.kind);
    if (textRun) {
      const prev = out.filter((e) => e.idx < first.idx && !run.includes(e)).reduce((m, e) => (!m || e.idx > m.idx ? e : m), null);
      if (!prev || (!prev.math && !prev.kind)) continue;
    }
    for (const b of out) {
      if (run.includes(b) || b.size < rs * 1.12) continue;
      if (Math.abs(b.idx - first.idx) > 40) continue;
      const bs = b.size;
      const bigBase = b.big || b.role === "op" || b.kind === "op";
      const dx = first.x0 - (b.bx1 ?? b.x1);
      if (dx < -0.35 * bs || dx > (bigBase ? 0.7 : 0.45) * bs) continue;
      if (b.x0 > first.x0) continue;
      const dy = ry - b.y;
      const up = bigBase ? 1.35 : 0.85;
      const down = bigBase ? -1.15 : -0.65;
      if (dy > up * bs || dy < down * bs) continue;
      let kind = null;
      if (bigBase) kind = (ry + 0.25 * rs) > b.cy ? "sup" : "sub";
      else if (dy > 0.12 * bs) kind = "sup";
      else if (dy < -0.04 * bs) kind = "sub";
      if (!kind || (b[kind] && !b.kind)) continue;
      if (b[kind] && b.kind === "op" && b.limits) continue;
      const score = Math.abs(dx) + 0.2 * Math.abs(dy) + (Math.abs(b.idx - first.idx) > 50 ? bs : 0);
      if (!best || score < best.score) best = { b, kind, score };
    }
    if (!best) continue;
    const { b, kind } = best;
    b[kind] = (b[kind] ?? []).concat(run).sort((p, q) => p.x0 - q.x0);
    b.x1 = Math.max(b.x1, ...run.map((e) => e.x1));
    b.lo = Math.min(b.lo, ...run.map((e) => e.lo));
    b.hi = Math.max(b.hi, ...run.map((e) => e.hi));
    out = out.filter((x) => !run.includes(x));
  }
  // les petits groupes accrochés sont eux-mêmes à mettre en forme
  for (const e of out) {
    if (e.sub && !e.subDone) {
      e.sub = applyScripts(e.sub).sort((a, b) => a.x0 - b.x0);
      e.subDone = true;
    }
    if (e.sup && !e.supDone) {
      e.sup = applyScripts(e.sup).sort((a, b) => a.x0 - b.x0);
      e.supDone = true;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lignes, formules dans le texte, blocs                               */
/* ------------------------------------------------------------------ */

function buildLines(els) {
  const sorted = [...els].sort((a, b) => a.idx - b.idx);
  const lines = [];
  let cur = null;
  for (const e of sorted) {
    if (cur) {
      const S = cur.size;
      const dy = e.y - cur.y;
      const small = e.size < 0.85 * S;
      const same = small ? dy > -0.6 * S && dy < 0.8 * S : Math.abs(dy) < 0.3 * Math.max(S, e.size);
      const back = e.x0 < cur.x1 - 1.0 * S && e.x1 < cur.x0 + 0.5 * S;
      // appel de note en tête de ligne, suivi du texte en plus grand
      const lead = e.size > 1.15 * S && cur.els.length <= 2 && dy < 0.15 * e.size && dy > -0.75 * e.size && e.x0 - cur.x1 < 0.6 * e.size && e.x0 > cur.x0;
      if (lead) {
        cur.els.push(e);
        cur.x1 = Math.max(cur.x1, e.x1);
        cur.size = e.size;
        cur.y = e.y;
        continue;
      }
      if (same && !back && e.x0 > cur.x0 - 2 * S) {
        cur.els.push(e);
        cur.x0 = Math.min(cur.x0, e.x0);
        cur.x1 = Math.max(cur.x1, e.x1);
        if (e.size > S * 1.05 && !e.kind) {
          cur.size = e.size;
          cur.y = e.y;
        }
        continue;
      }
    }
    cur = { els: [e], y: e.y, size: e.size, x0: e.x0, x1: e.x1 };
    lines.push(cur);
  }
  // une ligne qui ne contient que de petits éléments flottants va avec sa voisine
  for (const l of lines) {
    l.els.sort((a, b) => a.x0 - b.x0 || a.idx - b.idx);
    const ys = l.els.filter((e) => !e.kind && e.size > 0.85 * l.size).map((e) => e.y);
    if (ys.length) l.y = ys.sort((a, b) => a - b)[Math.floor(ys.length / 2)];
  }
  return lines;
}

const SENTENCE_END = /[.!?:;…»"”)]$/;

// Rôle de chaque élément d'une ligne : formule (M), neutre (chiffres, opérateurs) ou texte (T).
function classify(line) {
  const els = line.els;
  const role = els.map((e) => {
    if (e.kind) return "M";
    if (e.math) return "M";
    // petit caractère surélevé ou abaissé du texte (appel de note, indice chimique)
    if (e.size < 0.85 * line.size && Math.abs(e.y - line.y) > 0.12 * e.size) return "T";
    if (e.word) return e.opcand ? "O" : e.sub || e.sup ? (hasMath(e.sub) || hasMath(e.sup) ? "M" : "T") : "T";
    return "N";
  });
  // Les éléments neutres (chiffres, opérateurs) rejoignent une formule voisine ;
  // un nom d'opérateur en police de texte (ln, det…) en fait partie s'il est suivi d'une formule.
  const near = (a, b) => b.x0 - a.x1 < (b.space || a.space ? 0.75 : 0.45) * Math.min(a.size, b.size);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < els.length; i++) {
      if (role[i] === "N") {
        const left = i > 0 && role[i - 1] === "M" && near(els[i - 1], els[i]);
        // la ponctuation ne commence jamais une formule
        const right = i + 1 < els.length && role[i + 1] === "M" && near(els[i], els[i + 1]) && !/^[,.;:!?»”]$/.test(els[i].s);
        // parenthèse collée à un mot : elle appartient au texte
        const glued = (OPEN.includes(els[i].s) && els[i + 1]?.word && els[i + 1].x0 - els[i].x1 < 0.1 * els[i].size)
          || (CLOSE.includes(els[i].s) && els[i - 1]?.word && els[i].x0 - els[i - 1].x1 < 0.1 * els[i].size);
        if (glued) continue;
        if (left || right) {
          role[i] = "M";
          changed = true;
        }
      } else if (role[i] === "O") {
        const n = els[i + 1];
        if (els[i].sub || els[i].sup || (n && role[i + 1] === "M" && n.x0 - els[i].x1 < 0.45 * els[i].size)) {
          role[i] = "M";
          changed = true;
        }
      }
    }
  }
  return role.map((r) => (r === "O" ? "T" : r));
}
const hasMath = (list) => !!list && list.some((e) => e.math || e.kind || hasMath(e.sub) || hasMath(e.sup));

// Découpe une ligne en morceaux de texte et de formules.
function segments(line) {
  const role = classify(line);
  const segs = [];
  line.els.forEach((e, i) => {
    const kind = role[i] === "M" ? "math" : "text";
    const prev = segs[segs.length - 1];
    const gap = i > 0 ? e.x0 - line.els[i - 1].x1 : 0;
    const space = i > 0 && (e.space || gap > 0.17 * Math.min(e.size, line.els[i - 1].size));
    if (prev && prev.kind === kind) {
      prev.els.push(e);
      prev.spaces.push(space);
    } else segs.push({ kind, els: [e], spaces: [false], space });
  });
  // ponctuation et parenthèses non appariées sortent des formules
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind !== "math") continue;
    const moveOut = (fromEnd) => {
      const k = fromEnd ? s.els.length - 1 : 0;
      const e = s.els[k];
      if (!e || e.kind || e.sub || e.sup) return false;
      const punct = fromEnd ? /^[,.;:!?]$/.test(e.s) && (i + 1 < segs.length || !line.display) : false;
      const unmatched = fromEnd ? CLOSE.includes(e.s) && depthOf(s.els) < 0 : OPEN.includes(e.s) && depthOf(s.els) > 0;
      if (!punct && !unmatched) return false;
      if (!e.font?.math || unmatched) {
        const t = { kind: "text", els: [e], spaces: [false], space: fromEnd ? s.spaces[k] : s.space };
        if (fromEnd) {
          s.els.pop();
          s.spaces.pop();
          segs.splice(i + 1, 0, t);
        } else {
          s.els.shift();
          s.spaces.shift();
          s.space = s.spaces[0] ?? false;
          s.spaces[0] = false;
          segs.splice(i, 0, t);
          i++;
        }
        return true;
      }
      return false;
    };
    while (s.els.length > 1 && moveOut(true));
    while (s.els.length > 1 && moveOut(false));
  }
  return segs.filter((s) => s.els.length);
}
function depthOf(els) {
  let d = 0;
  for (const e of els) {
    if (e.kind) continue;
    if (OPEN.includes(e.s)) d++;
    else if (CLOSE.includes(e.s)) d--;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Écriture des formules                                               */
/* ------------------------------------------------------------------ */

const simpleTxt = (s) => /^[\p{L}\p{N}∞′'.]+$/u.test(s) || [...s].length === 1;
const grp = (s) => (simpleTxt(s) ? s : `(${s})`);
const fracGrp = (s) => (/[\s+\-−=<>≤≥±∓·×,;:/]/.test(s) ? `(${s})` : s);

function txtList(els, size) {
  let out = "";
  els.forEach((e, i) => {
    const p = els[i - 1];
    if (p) {
      const gap = e.x0 - p.x1;
      const tight = (!p.kind && p.role === "open") || (!e.kind && (e.role === "close" || /^[,.;!?]$/.test(e.s)));
      const S = size ?? e.size;
      if (gap > 1.6 * S) out += "    ";
      else if (gap > 0.8 * S) out += "  ";
      else if (!tight && (e.space || gap > 0.15 * S || (e.soft && gap > 0.13 * S))) out += " ";
    }
    out += txtOne(e);
  });
  return out.replace(/\. \. \./g, "…").replace(/· · ·/g, "⋯").replace(/(\S) (?=\S)/g, "$1 ").trim();
}

function scriptsTxt(base, e) {
  let s = base;
  if (e.sub) s += `_${grp(txtList(e.sub))}`;
  if (e.sup) {
    const sup = txtList(e.sup);
    if (/^[′']+$/.test(sup)) s += sup.replace(/'/g, "′");
    else if (/^[∘◦]$/.test(sup)) s += "°";
    else s += `^${grp(sup)}`;
  }
  return s;
}

function txtOne(e) {
  switch (e.kind) {
    case "frac":
      return `${fracGrp(txtList(e.num))}/${fracGrp(txtList(e.den))}`;
    case "sqrt": {
      const body = txtList(e.body);
      const root = e.index ? { 3: "∛", 4: "∜" }[txtList(e.index)] : "√";
      const b = /^[\p{L}\p{N}.]+$/u.test(body) ? body : `(${body})`;
      return scriptsTxt(root ? root + b : `root_${txtList(e.index)}${b}`, e);
    }
    case "op":
      return scriptsTxt(txtOne(e.base), e);
    case "acc": {
      const body = txtList(e.body);
      const comb = ACC_COMB[e.acc] ?? "";
      return scriptsTxt([...body].length === 1 ? (body + comb).normalize("NFC") : `${e.acc}(${body})`, e);
    }
    case "over": {
      const body = txtList(e.body);
      return scriptsTxt([...body].length === 1 ? body + "̅" : `overline(${body})`, e);
    }
    case "binom":
      return scriptsTxt(`binom(${e.rows.map((r) => txtList(r[0])).join(", ")})`, e);
    case "matrix":
    case "cases": {
      const rows = e.rows.map((r) => r.map((c) => txtList(c)).join(e.kind === "cases" ? " " : ", ")).join("; ");
      return scriptsTxt(`${e.left || "["}${rows}${e.right || (e.kind === "cases" ? "" : "]")}`, e);
    }
    default:
      return scriptsTxt(e.s, e);
  }
}

const needsBrace = (s) => !(s.length === 1 || /^\\([a-zA-Z]+|.)$/.test(s) || /^\d$/.test(s));
const braced = (s) => `{${s}}`;

function scriptsTex(base, e) {
  let s = base;
  if (e.sub) s += `_${braced(texList(e.sub))}`;
  if (e.sup) {
    const sup = texList(e.sup);
    if (/^'+$/.test(sup)) s += sup;
    else if (sup === "\\circ") s += "^{\\circ}";
    else s += `^${braced(sup)}`;
  }
  return s;
}

const TALL = new Set(["frac", "op", "matrix", "binom", "cases"]);
function texList(els) {
  // grands délimiteurs appariés : \left … \right
  const big = new Set();
  const stack = [];
  els.forEach((e, i) => {
    if (e.kind) {
      if (TALL.has(e.kind) || e.kind === "sqrt" && hasTall(e.body)) stack.forEach((s) => (s.tall = true));
      return;
    }
    if (e.role === "open") stack.push({ i, e, tall: false });
    else if (e.role === "close" && stack.length) {
      const o = stack.pop();
      if (PAIR[o.e.s] === e.s && (o.e.big || e.big || o.tall)) {
        big.add(o.i);
        big.add(i);
      }
      if (o.tall) stack.forEach((s) => (s.tall = true));
    }
  });
  let out = "";
  let i = 0;
  while (i < els.length) {
    const e = els[i];
    // trois points : \ldots ou \cdots
    if (!e.kind && (e.s === "." || e.s === "·") && els[i + 1]?.s === e.s && els[i + 2]?.s === e.s && !e.sub && !e.sup) {
      out = joinTex(out, e.s === "." ? "\\ldots" : "\\cdots");
      i += 3;
      continue;
    }
    // nombre décimal à la française : 1{,}414
    if (!e.kind && e.s === "," && /\d$/.test(els[i - 1]?.s ?? "") && /^\d/.test(els[i + 1]?.s ?? "") && !els[i + 1].space
      && els[i + 1].x0 - e.x1 < 0.15 * e.size) {
      out += "{,}";
      i++;
      continue;
    }
    let t = texOne(e);
    if (e.word && !e.opcand && !OPNAMES.has(e.s)) {
      const before = i > 0 && e.x0 - els[i - 1].x1 > 0.15 * e.size;
      const after = i + 1 < els.length && els[i + 1].x0 - e.x1 > 0.15 * e.size;
      if (before || after) t = t.replace(/^\\text\{(.*)\}$/, (m, w) => `\\text{${before ? " " : ""}${w}${after ? " " : ""}}`);
    }
    if (big.has(i)) t = scriptsTex((e.role === "open" ? "\\left" : "\\right") + texDelim(e.s), e);
    const p = els[i - 1];
    if (p && (e.x0 - p.x1 > 1.6 * e.size)) out = joinTex(out, "\\qquad");
    else if (p && (e.x0 - p.x1 > 0.8 * e.size)) out = joinTex(out, "\\quad");
    out = joinTex(out, t);
    i++;
  }
  return out.trim();
}
const hasTall = (els) => els.some((e) => TALL.has(e.kind));
function texDelim(s) {
  return s === "{" || s === "}" ? `\\${s}` : s === "‖" ? "\\|" : TEX[s] ?? s;
}
function joinTex(out, t) {
  if (!t) return out;
  if (!out) return t;
  if (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z0-9]/.test(t)) return `${out} ${t}`;
  if (/^\\(qquad|quad)$/.test(t) || /\\(qquad|quad)$/.test(out)) return `${out} ${t}`;
  return `${out} ${t}`.replace(/ ([_^'])/g, "$1");
}

function texWord(e) {
  if (OPNAMES.has(e.s)) return `\\${e.s}`;
  if (OPNAMES_FR.has(e.s) || OPNAMES_IN_TEXT.has(e.s)) return `\\operatorname{${e.s}}`;
  return `\\text{${e.s.replace(/[\\{}$&#^_%~]/g, (c) => `\\${c}`)}}`;
}

function texOne(e) {
  switch (e.kind) {
    case "frac":
      return scriptsTex(`\\frac{${texList(e.num)}}{${texList(e.den)}}`, e);
    case "sqrt":
      return scriptsTex(`\\sqrt${e.index ? `[${texList(e.index)}]` : ""}{${texList(e.body)}}`, e);
    case "op":
      return scriptsTex(texOne({ ...e.base, sub: null, sup: null }), e);
    case "acc":
      return scriptsTex(`\\${e.acc}{${texList(e.body)}}`, e);
    case "over":
      return scriptsTex(`\\overline{${texList(e.body)}}`, e);
    case "binom":
      return scriptsTex(`\\binom{${texList(e.rows[0][0])}}{${texList(e.rows[1][0])}}`, e);
    case "matrix":
    case "cases": {
      const env = e.kind === "cases" ? "cases"
        : { "(": "pmatrix", "[": "bmatrix", "{": "Bmatrix", "|": "vmatrix", "‖": "Vmatrix" }[e.left] ?? "matrix";
      const rows = e.rows.map((r) => r.map((c) => texList(c)).join(" & ")).join(" \\\\ ");
      const inner = `\\begin{${env}} ${rows} \\end{${env}}`;
      const wrap = env === "matrix" && e.left ? `\\left${texDelim(e.left)} ${inner} \\right${e.right ? texDelim(e.right) : "."}` : inner;
      return scriptsTex(wrap, e);
    }
    default: {
      let base = e.word ? texWord(e) : e.tex ?? e.s;
      if (needsBrace(base) && (e.sub || e.sup) && !/^\\[a-zA-Z]+(\{[^{}]*\})?$/.test(base) && !/^[\p{L}\p{N}]+$/u.test(base)) base = braced(base);
      return scriptsTex(base, e);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pages → blocs                                                       */
/* ------------------------------------------------------------------ */

const BULLET = /^[•◦▪▸►‣⁃∙·∗*–—-]$/;
const ENUM = /^(\d{1,3}|[a-z]|[ivx]{1,4})[.)]$|^\((\d{1,3}|[a-z]|[ivx]{1,4})\)$/;

function percentile(vals, p) {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

function analyzePage(page, ctx) {
  const { atoms, rotated } = pageAtoms(page, ctx);
  if (!atoms.length) return { lines: [], rotated };
  const els = reduce(applyRules(atoms, page.rules ?? [], ctx), ctx);
  const lines = buildLines(els);
  const body = ctx.bodySize;
  const bodyLines = lines.filter((l) => Math.abs(l.size - body) < 0.15 * body);
  const left = percentile(bodyLines.map((l) => l.x0), 0.1);
  // marge droite : celle des lignes pleines, ou symétrique de la gauche si la page en a peu
  const right = Math.max(percentile(bodyLines.map((l) => l.x1), 0.9), page.width ? page.width - left : 0);
  const spacings = [];
  for (let i = 1; i < bodyLines.length; i++) {
    const d = bodyLines[i - 1].y - bodyLines[i].y;
    if (d > 0.8 * body && d < 2.5 * body) spacings.push(d);
  }
  const lead = percentile(spacings, 0.3) || 1.2 * body;
  for (const l of lines) {
    l.segs = segments(l);
    const text = l.segs.filter((s) => s.kind === "text");
    const words = text.flatMap((s) => s.els).filter((e) => e.word);
    l.mono = l.els.every((e) => e.mono);
    l.bold = words.length > 0 && words.every((e) => e.b);
    const hasMathSeg = l.segs.some((s) => s.kind === "math");
    const centered = Math.abs((l.x0 + l.x1) / 2 - (left + right) / 2) < 0.08 * (right - left) && l.x1 - l.x0 < 0.85 * (right - left);
    const indented = l.x0 > left + 2 * body;
    const mathWidth = l.segs.filter((s) => s.kind === "math").reduce((n, s) => n + Math.max(...s.els.map((e) => e.x1)) - Math.min(...s.els.map((e) => e.x0)), 0);
    l.display = hasMathSeg && words.length <= 3 && words.every((e) => e.s.length <= 8) && mathWidth > 0.7 * (l.x1 - l.x0)
      && (centered || (indented && l.x1 < right - 2 * body)) && l.segs[0].kind === "math" && !l.mono;
    if (l.display && text.length) {
      // texte court au milieu (\text{si}) : la ligne reste une formule
      l.segs = [{ kind: "math", els: l.els, spaces: l.els.map(() => false), space: false }];
    }
  }
  return { lines, rotated, left, right, lead, width: page.width, height: page.height ?? 842 };
}

function lineText(l) {
  return l.segs.map((s) => (s.kind === "text" ? txtList(s.els) : "")).join(" ").trim();
}

// En-têtes et pieds de page répétés, numéros de page.
function stripFurniture(pages) {
  const key = (l) => lineText(l).replace(/\d+/g, "#");
  const counts = new Map();
  for (const p of pages) {
    const cand = [...p.lines.slice(0, 2), ...p.lines.slice(-2)];
    for (const l of new Set(cand)) counts.set(key(l), (counts.get(key(l)) ?? 0) + 1);
  }
  for (const p of pages) {
    p.lines = p.lines.filter((l, i) => {
      const edge = i < 2 || i >= p.lines.length - 2;
      if (!edge) return true;
      const t = lineText(l);
      if (/^(page\s*)?\d{1,4}(\s*(\/|sur|of)\s*\d{1,4})?$/i.test(t) || /^[ivxlc]{1,6}$/i.test(t) && t.length < 6) {
        const others = p.lines.filter((o) => o !== l);
        const gapOk = others.every((o) => Math.abs(o.y - l.y) > 1.6 * p.lead);
        const centered = p.width && Math.abs((l.x0 + l.x1) / 2 - p.width / 2) < 0.08 * p.width;
        if (gapOk || centered) return false;
      }
      return !(pages.length >= 3 && counts.get(key(l)) >= Math.max(3, pages.length * 0.5) && t.length < 120);
    });
  }
}

function buildBlocks(pages, ctx) {
  stripFurniture(pages);
  const body = ctx.bodySize;
  const headingSizes = [...new Set(pages.flatMap((p) => p.lines.filter((l) => l.size > 1.15 * body && !l.display).map((l) => Math.round(l.size))))]
    .sort((a, b) => b - a);
  const blocks = [];
  let prev = null;
  for (const p of pages) {
    for (const l of p.lines) {
      const text = inlineTxt(l);
      const words = lineText(l).split(/\s+/).filter(Boolean).length;
      const firstWord = text.split(" ")[0] ?? "";
      const marker = text.length > firstWord.length && (BULLET.test(firstWord) || ENUM.test(firstWord));
      // ligne de tableau : de grands blancs entre les éléments
      const row = !l.display && l.els.some((e, i) => i > 0 && e.x0 - l.els[i - 1].x1 > 1.5 * l.size);
      let type = "p";
      if (l.mono) type = "code";
      else if (l.display) type = "eq";
      else if (row) type = "row";
      else if (l.size > 1.15 * body && words <= 20 && !l.segs.some((s) => s.kind === "math" && s.els.length > 3)) type = "h";
      const level = type === "h" ? Math.min(3, headingSizes.indexOf(Math.round(l.size)) + 1 || 3) : 0;
      const last = blocks[blocks.length - 1];
      let join = false;
      if (last && prev && type === last.type && (type === "p" || type === "code" || type === "h" || type === "row") && !marker) {
        const sameColumn = l.y < prev.y;
        const gap = prev.y - l.y;
        const indent = l.x0 - prev.x0;
        // ligne précédente courte : fin de paragraphe (ou ligne isolée : adresse, tableau, poème)
        const prevShort = prev.x1 < p.right - 3 * body && (SENTENCE_END.test(lineText(prev)) || prev.x1 < p.left + 0.65 * (p.right - p.left));
        if (type === "h") join = sameColumn && gap < 2 * l.size && Math.abs(l.size - prev.size) < 0.1 * l.size;
        else if (type === "code" || type === "row") join = sameColumn && gap < 1.8 * p.lead;
        else if (!sameColumn || prev.page !== p) join = !prevShort && indent < 0.8 * body && !(prev.page !== p && /^\p{Lu}/u.test(lineText(l)) && SENTENCE_END.test(lineText(prev)));
        else join = gap < 1.45 * p.lead && Math.abs(l.size - prev.size) < 0.15 * l.size
          && (indent < 0.8 * body || last.list) && !prevShort;
        if (last.list && indent < -0.3 * body) join = false;
      }
      l.page = p;
      if (join) last.lines.push(l);
      else blocks.push({ type, level, lines: [l], list: marker });
      prev = l;
    }
    for (const r of p.rotated) blocks.push({ type: "raw", text: r });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "−": "⁻",
  "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", e: "ᵉ", r: "ʳ", o: "ᵒ", a: "ᵃ", s: "ˢ", t: "ᵗ", d: "ᵈ", "*": "*" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "−": "₋",
  "=": "₌", "(": "₍", ")": "₎" };
// Petit élément du texte surélevé (appel de note, « 1er ») ou abaissé (H₂O).
function textScript(e, l) {
  if (e.kind || e.size >= 0.85 * l.size) return null;
  const dy = e.y - l.y;
  return dy > 0.15 * e.size ? "sup" : dy < -0.12 * e.size ? "sub" : null;
}
function scriptTxt(s, kind) {
  const map = kind === "sup" ? SUP : SUB;
  return [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${kind === "sup" ? "^" : "_"}(${s})`;
}

function textRunTxt(els, l) {
  let out = "";
  els.forEach((e, i) => {
    const p = els[i - 1];
    const k = textScript(e, l);
    if (p && !k && (e.space || e.x0 - p.x1 > 0.17 * Math.min(e.size, p.size) || (e.soft && e.x0 - p.x1 > 0.13 * e.size))) {
      out += e.x0 - p.x1 > 1.6 * l.size && l.row ? "    " : " ";
    }
    out += k ? scriptTxt(txtOne(e), k) : txtOne(e);
  });
  return out;
}

function inlineTxt(l) {
  let out = "";
  l.segs.forEach((s, i) => {
    const t = s.kind === "text" ? textRunTxt(s.els, l) : txtList(s.els, l.size);
    if (i > 0 && s.space && !/^[,.;:!?)]/.test(t)) out += " ";
    out += t;
  });
  return out.trim();
}

function joinLines(parts) {
  let out = "";
  for (const t of parts) {
    if (!out) out = t;
    else if (/\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t;
    else out += ` ${t}`;
  }
  return out;
}

function codeLines(lines) {
  const minX = Math.min(...lines.map((l) => l.x0));
  return lines.map((l) => {
    const chars = l.els.reduce((n, e) => n + [...(e.s ?? "")].length, 0) || 1;
    const cw = (l.els.reduce((n, e) => n + width(e), 0) / chars) || 0.6 * l.size;
    let out = " ".repeat(Math.max(0, Math.round((l.x0 - minX) / cw)));
    let x = l.x0;
    for (const e of l.els) {
      const gap = Math.round((e.x0 - x) / cw);
      if (x !== l.x0 && gap > 0) out += " ".repeat(gap);
      out += txtOne(e);
      x = e.x1;
    }
    return out;
  });
}

export function renderText(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "raw") out.push(b.text);
    else if (b.type === "code") out.push(codeLines(b.lines).join("\n"));
    else if (b.type === "eq") out.push(...b.lines.map((l) => txtList(l.els, l.size)));
    else if (b.type === "row") out.push(b.lines.map(inlineTxt).join("\n"));
    else out.push(joinLines(b.lines.map(inlineTxt)));
  }
  return out.filter((s) => s.trim()).join("\n\n") + "\n";
}

const mdEscape = (s) => s.replace(/[\\`*_[\]<>$|~^]/g, (c) => `\\${c}`);

function inlineMd(l) {
  let out = "";
  let style = null;
  const close = () => {
    if (style) {
      out = out.replace(/(\s*)$/, `${style}$1`);
      style = null;
    }
  };
  l.segs.forEach((s, i) => {
    const space = i > 0 && s.space;
    if (s.kind === "math") {
      close();
      const tex = texList(s.els);
      if (!tex) return;
      if (space) out += " ";
      out += `$${tex}$`;
      return;
    }
    s.els.forEach((e, j) => {
      const mark = e.b && e.i ? "***" : e.b ? "**" : e.i ? "*" : null;
      const k = textScript(e, l);
      const sp = !k && (j === 0 ? space : s.spaces[j] || e.x0 - s.els[j - 1].x1 > 0.17 * e.size);
      let t = mdEscape(txtOne(e));
      if (k) t = k === "sup" ? `^${t.replace(/ /g, "\\ ")}^` : `~${t.replace(/ /g, "\\ ")}~`;
      if (mark !== style) {
        close();
        if (sp && !/^[,.;:!?)]/.test(t)) out += " ";
        if (mark && /\p{L}|\p{N}/u.test(t)) {
          out += mark;
          style = mark;
        }
      } else if (sp && !/^[,.;:!?)]/.test(t)) out += " ";
      out += t;
    });
  });
  close();
  return out.trim();
}

export function renderMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "raw") out.push(mdEscape(b.text));
    else if (b.type === "code") out.push("```\n" + codeLines(b.lines).join("\n") + "\n```");
    else if (b.type === "eq") out.push(...b.lines.map((l) => `$$${texList(l.els)}$$`));
    else if (b.type === "row") out.push(b.lines.map(inlineMd).join("\\\n"));
    else if (b.type === "h") out.push(`${"#".repeat(b.level || 1)} ${joinLines(b.lines.map(inlineMd)).replace(/\*\*/g, "")}`);
    else {
      let t = joinLines(b.lines.map(inlineMd));
      if (b.list) t = t.replace(/^(\\?[•◦▪▸►‣⁃∙·∗*–—-])\s*/, "- ");
      else t = t.replace(/^(\d+)\. /, "$1\\. ").replace(/^([#+-]) /, "\\$1 ").replace(/^(=+|-+)$/, "\\$1");
      out.push(t);
    }
  }
  return out.filter((s) => s.trim()).join("\n\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Point d'entrée                                                      */
/* ------------------------------------------------------------------ */

// pages : [{ items, fonts: Map(nom pdf.js → objet police), rules, width, height }]
export function layoutPdf(pages) {
  const ctx = documentContext(pages);
  const analyzed = pages.map((p) => analyzePage(p, ctx));
  return buildBlocks(analyzed, ctx);
}

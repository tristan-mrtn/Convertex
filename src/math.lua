-- Filtre Pandoc de Convertex : remet les formules en état entre la lecture et
-- l'écriture, quel que soit le format d'origine.
-- Métadonnées fournies par Convertex : cvx-from et cvx-to (identifiants des formats
-- dans Convertex : md, tex, docx, adoc…), cvx-math
-- (formules extraites des objets ODT et PPTX, sous la forme "I:tex" ou "D:tex").

local from, to = "", ""
local extracted = {}

-- Environnements LaTeX qui sont des formules centrées
local MATH_ENVS = {}
for _, e in ipairs({ "equation", "align", "gather", "multline", "flalign", "alignat",
  "eqnarray", "displaymath", "math", "dmath" }) do
  MATH_ENVS[e] = true
  MATH_ENVS[e .. "*"] = true
end

local function has_class(el, name)
  for _, c in ipairs(el.classes or {}) do
    if c == name then return true end
  end
  return false
end

local function has_class_prefix(el, prefix)
  for _, c in ipairs(el.classes or {}) do
    if c:sub(1, #prefix) == prefix then return true end
  end
  return false
end

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- "\begin{align} … \end{align}" seul dans un bloc de TeX brut : c'est une formule
local function math_env(text)
  local env, rest = text:match("^%s*\\begin{([%a*]+)}(.*)$")
  if not env or not MATH_ENVS[env] then return nil end
  local close = "\\end{" .. env .. "}"
  local stripped = trim(rest)
  if stripped:sub(-#close) ~= close then return nil end
  return trim(text)
end

-- Délimiteurs TeX autour d'une formule : \( \), \[ \], $$ $$, $ $
local function strip_delims(s)
  s = trim(s)
  local inner = s:match("^\\%((.*)\\%)$")
  if inner then return inner, false end
  inner = s:match("^\\%[(.*)\\%]$")
  if inner then return inner, true end
  inner = s:match("^%$%$(.*)%$%$$")
  if inner then return inner, true end
  inner = s:match("^%$(.*)%$$")
  if inner then return inner, false end
  return s, nil
end

-- Word, LibreOffice et PowerPoint : « 1,5 » tapé dans une formule est un nombre
-- décimal (sans {,}, TeX et MathJax écriraient « 1, 5 »)
local WYSIWYG = { docx = true, odt = true, pptx = true }

local function clean_tex(text, inline)
  -- syntaxe GitHub $`…`$ lue par le lecteur Markdown : les accents graves restent
  local inner = text:match("^`(.*)`$")
  if inner then text = inner end
  if WYSIWYG[from] then
    text = text:gsub("(%d),%f[%d]", "%1{,}")
    -- « √2 » tapé comme un caractère : Pandoc écrit \sqrt{}2, une racine vide suivie de 2
    text = text:gsub("\\sqrt{}(%d+)", "\\sqrt{%1}"):gsub("\\sqrt{}(%a)", "\\sqrt{%1}"):gsub("\\sqrt{}", "\\surd ")
  end
  -- Wikipédia enveloppe tout dans {\displaystyle …}
  inner = text:match("^%s*{\\displaystyle%s*(.*)}%s*$") or text:match("^%s*{\\textstyle%s*(.*)}%s*$")
  if inner then text = inner end
  -- formule en ligne : sur une seule ligne (AsciiDoc ne relit pas une formule coupée)
  if inline then return (text:gsub("%s*\n%s*", " ")) end
  -- une ligne vide couperait la formule en deux dans Markdown
  return (text:gsub("\n[ \t]*\n[%s]*", "\n"))
end

--[[ Numéros d'équation. LaTeX numérote lui-même equation, align… et résout \eqref ;
   les autres formats perdent les numéros, et les renvois deviennent « [eq:rang] ».
   On numérote donc comme LaTeX (compteur simple), on écrit chaque numéro en \tag
   et on remplace les renvois par « (1) ». Les formats dont l'écrivain ignore \tag
   (Word, ODT, HTML…) reçoivent le numéro écrit après la formule. ]]
local NUMBERED = { equation = "one", multline = "one", dmath = "one", align = "rows",
  gather = "rows", flalign = "rows", alignat = "rows", eqnarray = "rows" }
-- formats lus par MathJax ou LaTeX, qui affichent \tag correctement
local KEEP_TAG = { tex = true, md = true, ipynb = true, org = true, rst = true, adoc = true }

-- Coupe le corps d'un environnement aux \\ de premier niveau (pas ceux d'une
-- matrice ou d'un cases imbriqué)
local function split_rows(body)
  local rows, depth, envs, start, i = {}, 0, 0, 1, 1
  while i <= #body do
    local c = body:sub(i, i)
    if c == "\\" then
      local rest = body:sub(i, i + 5)
      if rest == "\\begin" then envs = envs + 1; i = i + 6
      elseif body:sub(i, i + 3) == "\\end" then envs = envs - 1; i = i + 4
      elseif body:sub(i + 1, i + 1) == "\\" and depth == 0 and envs == 0 then
        table.insert(rows, body:sub(start, i - 1))
        i = i + 2
        local spacing = body:match("^%s*%b[]", i)
        if spacing then i = i + #spacing end
        start = i
      else
        i = i + 2
      end
    elseif c == "{" then depth = depth + 1; i = i + 1
    elseif c == "}" then depth = depth - 1; i = i + 1
    else i = i + 1 end
  end
  table.insert(rows, body:sub(start))
  return rows
end

local counter = 0
local labels = {}

local function number_equation(m)
  if m.mathtype ~= "DisplayMath" then return nil end
  local env, body = m.text:match("^%s*\\begin{(%a+)}(.*)\\end{%a+}%s*$")
  if not env or not NUMBERED[env] then
    -- formule sans environnement numéroté : seul un \tag explicite porte une étiquette
    local tag, label = m.text:match("\\tag%*?{([^}]*)}"), m.text:match("\\label{([^}]*)}")
    if tag and label then labels[label] = tag end
    return nil
  end
  local rows = NUMBERED[env] == "rows" and split_rows(body) or { body }
  for k, row in ipairs(rows) do
    local tag = row:match("\\tag%*?{([^}]*)}")
    local label = row:match("\\label{([^}]*)}")
    local skip = row:find("\\nonumber", 1, true) or row:find("\\notag", 1, true)
    if not tag and not skip and row:find("%S") then
      counter = counter + 1
      tag = tostring(counter)
      row = row .. " \\tag{" .. tag .. "}"
    end
    if label and tag then labels[label] = tag end
    rows[k] = row:gsub("\\label{[^}]*}", "")
  end
  -- l'environnement reste numéroté : \tag remplace le numéro automatique, et
  -- \nonumber reste là où LaTeX n'en mettait pas (pas d'étoile, que Markdown
  -- prendrait pour de l'italique)
  m.text = "\\begin{" .. env .. "}" .. table.concat(rows, "\\\\") .. "\\end{" .. env .. "}"
  return m
end

local function resolve_ref(link)
  local kind, ref = link.attributes["reference-type"], link.attributes["reference"]
  if (kind == "eqref" or kind == "ref") and ref and labels[ref] then
    return pandoc.Str(kind == "eqref" and ("(" .. labels[ref] .. ")") or labels[ref])
  end
  return nil
end

local function tags_as_text(text)
  if KEEP_TAG[to] then return text end
  return (text:gsub("\\tag%*%s*{([^}]*)}", "\\qquad \\text{%1}"):gsub("\\tag%s*{([^}]*)}", "\\qquad \\text{(%1)}"))
end

--[[ Formules en texte lisible, pour les formats sans notation mathématique (texte
   brut, RTF, FB2). Pandoc y laissait le code TeX ($\frac{…}{…}$) dès qu'une formule
   n'était pas toute simple. Pandoc écrit d'abord la formule en MathML (texmath
   connaît toutes les commandes TeX), puis ce MathML est mis à plat dans la notation
   de la lecture des PDF : u_n, x^2, (b − a)/n, √(2 + u_n), ∑_(k=0)^(n−1),
   (1, 2; 3, 4). En RTF et en FB2, indices et exposants restent de vrais indices et
   exposants, et les lettres sont en italique. ]]
local LINEAR = { txt = true, rtf = true, fb2 = true }
local RICH = { rtf = true, fb2 = true }

local function charset(s)
  local t = {}
  for _, c in utf8.codes(s) do t[utf8.char(c)] = true end
  return t
end
local BIN = charset("+-−±∓×÷⋅·∗∘∙∩∪⊕⊗⊖⊙∧∨∖⊎⊓⊔⋆†‡≀⋄△▽◃▹◁▷⊲⊳⨯")
local REL = charset("=≠<>≤≥≦≧≪≫≈≃≅≡≢∼≁∝∈∉∋∌⊂⊃⊆⊇⊄⊅⊈⊉⊊⊋→←↔⇒⇐⇔⟶⟵⟷⟹⟸⟺↦⟼↪↩∣∤⊥⊢⊣⊨≺≻⪯⪰:≔≜↑↓⇑⇓↗↘≐≍⊏⊐⊑⊒≲≳≶≷↛↚⇏⇎≮≯≰≱⊴⊵∦∥⟂")
local LARGE = charset("∑∏∐∫∬∭∮∯∰⋃⋂⨁⨂⨀⋁⋀⨄⨆")
local OPENS = charset("([{⟨⌊⌈⟦⟪")
local CLOSES = charset(")]}⟩⌋⌉⟧⟫")
local BARS = charset("|‖∥")
local PRIMES = charset("′″‴⁗'")
-- caractères qui obligent à mettre un indice, un exposant ou un radicande entre parenthèses
local BREAKS = charset(" +-−±∓×÷⋅·∗∘=≠<>≤≥≈≡∈∉⊂⊆→←↔⇒⇔↦∣,;:/()[]{}|‖√∑∏∫⋃⋂∪∩∧∨")
local FN = {}
for w in ([[lim liminf limsup max min sup inf det dim ker Ker deg gcd lcm hom arg exp
  log ln lg sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan sh ch th
  rg Im Re card pgcd ppcm Pr mod argmin argmax tr Tr]]):gmatch("%S+") do FN[w] = true end

-- Accents posés sur une lettre : caractère combinant, et nom pour un groupe (« vec(AB) »)
local ACCENTS = {
  ["‾"] = { "\u{304}", "bar" }, ["¯"] = { "\u{305}", "overline" }, ["→"] = { "\u{20D7}", "vec" },
  ["←"] = { "\u{20D6}", "overleftarrow" }, ["↔"] = { "\u{20E1}", "overleftrightarrow" },
  ["_"] = { "\u{332}", "underline" }, ["⏞"] = { nil, "overbrace" }, ["⏟"] = { nil, "underbrace" },
  ["^"] = { "\u{302}", "hat" }, ["ˆ"] = { "\u{302}", "hat" }, ["~"] = { "\u{303}", "tilde" },
  ["˜"] = { "\u{303}", "tilde" }, ["˙"] = { "\u{307}", "dot" }, ["¨"] = { "\u{308}", "ddot" },
  ["ˇ"] = { "\u{30C}", "check" }, ["˘"] = { "\u{306}", "breve" }, ["´"] = { "\u{301}", "acute" },
  ["`"] = { "\u{300}", "grave" }, ["˚"] = { "\u{30A}", "ring" },
  ["\u{300}"] = { "\u{300}", "grave" }, ["\u{301}"] = { "\u{301}", "acute" },
  ["\u{302}"] = { "\u{302}", "hat" }, ["\u{303}"] = { "\u{303}", "tilde" },
  ["\u{304}"] = { "\u{304}", "bar" }, ["\u{305}"] = { "\u{305}", "overline" },
  ["\u{306}"] = { "\u{306}", "breve" }, ["\u{307}"] = { "\u{307}", "dot" },
  ["\u{308}"] = { "\u{308}", "ddot" }, ["\u{30A}"] = { "\u{30A}", "ring" },
  ["\u{30C}"] = { "\u{30C}", "check" }, ["\u{20D7}"] = { "\u{20D7}", "vec" },
}

-- Une espace (1) ou pas (0) entre deux atomes : règles d'espacement de TeX, simplifiées
local SPACING = {
  ord = { op = 1, fn = 1, bin = 1, rel = 1, inner = 1 },
  op = { ord = 1, fn = 1, rel = 1, inner = 1 },
  fn = { ord = 1, op = 1, fn = 1, rel = 1, inner = 1 },
  bin = { ord = 1, op = 1, fn = 1, open = 1, inner = 1 },
  rel = { ord = 1, op = 1, fn = 1, open = 1, inner = 1 },
  open = {},
  close = { op = 1, fn = 1, bin = 1, rel = 1, inner = 1 },
  punct = { ord = 1, op = 1, fn = 1, rel = 1, open = 1, punct = 1, inner = 1 },
  inner = { ord = 1, op = 1, fn = 1, bin = 1, rel = 1, open = 1, inner = 1 },
}

-- MathML écrit par Pandoc : bien formé et sans fioritures, un petit lecteur suffit
local XML_ENT = { lt = "<", gt = ">", amp = "&", quot = '"', apos = "'" }
local function xml_text(s)
  return (s:gsub("&(#?)([xX]?)(%w+);", function(hash, x, v)
    if hash == "#" then
      local n = tonumber(v, x ~= "" and 16 or 10)
      return n and utf8.char(n) or nil
    end
    return XML_ENT[x .. v]
  end))
end

local function parse_xml(s)
  local root = { tag = "", attrs = {}, kids = {} }
  local stack = { root }
  local pos = 1
  while true do
    local a, b, slash, name, attrs, selfclose = s:find("<(/?)([%w:%-]+)([^>]-)(/?)>", pos)
    if not a then break end
    if a > pos then table.insert(stack[#stack].kids, { text = xml_text(s:sub(pos, a - 1)) }) end
    local tag = name:gsub("^.*:", "")
    if slash == "/" then
      for k = #stack, 2, -1 do
        if stack[k].tag == tag then
          for _ = #stack, k, -1 do table.remove(stack) end
          break
        end
      end
    else
      local node = { tag = tag, attrs = {}, kids = {} }
      for k, v in attrs:gmatch('([%w:%-]+)%s*=%s*"([^"]*)"') do node.attrs[k] = xml_text(v) end
      table.insert(stack[#stack].kids, node)
      if selfclose ~= "/" then table.insert(stack, node) end
    end
    pos = b + 1
  end
  return root
end

local function elements(node)
  local out = {}
  for _, k in ipairs(node.kids or {}) do
    if k.tag then table.insert(out, k) end
  end
  return out
end

local function token_text(node)
  local t = {}
  for _, k in ipairs(node.kids or {}) do
    if k.text then table.insert(t, k.text) end
  end
  return table.concat(t)
end

local function ulen(s) return utf8.len(s) or #s end

-- Morceaux de texte : { k = "s" (texte) | "i" (lettre en italique) | "sub" | "sup", v = … }
local function S(v) return { k = "s", v = v } end

local function simple(s)
  if ulen(s) == 1 then return true end
  for _, c in utf8.codes(s) do
    if BREAKS[utf8.char(c)] then return false end
  end
  return true
end
local function group(s) return simple(s) and s or ("(" .. s .. ")") end

local SUP_DIGITS = { ["0"] = "⁰", ["1"] = "¹", ["2"] = "²", ["3"] = "³", ["4"] = "⁴",
  ["5"] = "⁵", ["6"] = "⁶", ["7"] = "⁷", ["8"] = "⁸", ["9"] = "⁹" }
local SUB_DIGITS = { ["0"] = "₀", ["1"] = "₁", ["2"] = "₂", ["3"] = "₃", ["4"] = "₄",
  ["5"] = "₅", ["6"] = "₆", ["7"] = "₇", ["8"] = "₈", ["9"] = "₉" }

-- Texte d'une suite de morceaux, indices et exposants notés _ et ^. Un exposant de
-- plusieurs termes est entre parenthèses : e^(iπ), x^(2n) (mais a_ij).
local function flat(runs)
  local out = {}
  for _, r in ipairs(runs) do
    if r.k == "sub" or r.k == "sup" then
      local s = flat(r.v)
      if s:match("^%d+$") then
        -- chiffres seuls : x², u₀, ∫₀¹
        out[#out + 1] = (s:gsub("%d", r.k == "sup" and SUP_DIGITS or SUB_DIGITS))
      else
        -- indice d'indice : x^(y^z), a_(b_c)
        local nested = false
        for _, x in ipairs(r.v) do if x.k == "sub" or x.k == "sup" then nested = true end end
        local plain = r.k == "sub" or r.single
        out[#out + 1] = (r.k == "sub" and "_" or "^") .. ((plain and not nested) and group(s) or ("(" .. s .. ")"))
      end
    else out[#out + 1] = r.v end
  end
  return table.concat(out)
end

-- Mêmes morceaux en éléments Pandoc (RTF, FB2) : vrais indices et exposants
local function rich(runs)
  local out = pandoc.List()
  for _, r in ipairs(runs) do
    if r.k == "s" then
      local last = out[#out]
      if last and last.t == "Str" then last.text = last.text .. r.v
      elseif r.v ~= "" then out:insert(pandoc.Str(r.v)) end
    elseif r.k == "i" then out:insert(pandoc.Emph({ pandoc.Str(r.v) }))
    elseif r.k == "sub" then out:insert(pandoc.Subscript(rich(r.v)))
    elseif r.k == "sup" then out:insert(pandoc.Superscript(rich(r.v))) end
  end
  return out
end

local function append(dst, src)
  for _, r in ipairs(src) do table.insert(dst, r) end
  return dst
end

local lin_node, prepare, join

local function lin_list(nodes, ctx)
  local atoms = {}
  for _, n in ipairs(nodes) do append(atoms, lin_node(n, ctx)) end
  return atoms
end

-- Classe d'un opérateur <mo> (au sens de TeX)
local function mo_class(text, form)
  if PRIMES[text] then return "ord" end
  if text == "!" then return "close" end -- factorielle, collée à ce qui précède
  if OPENS[text] then return "open" end
  if CLOSES[text] then return "close" end
  if BARS[text] and (form or text ~= "∥") then return "bar" end -- ouvrante ou fermante, vu plus tard
  if LARGE[text] then return "op" end
  if BIN[text] then return "bin" end
  if REL[text] then return "rel" end
  if text == "," or text == ";" then return "punct" end
  if ulen(text) > 1 and text:match("^%a+$") then return "fn" end
  return "ord"
end

local function is_letter(text, variant)
  if variant then return false end
  if text:match("^%a$") then return true end
  local c = utf8.codepoint(text)
  return c >= 0x3B1 and c <= 0x3C9 or c == 0x3D1 or c == 0x3D5 or c == 0x3D6 or c == 0x3F1 or c == 0x3F5
end

local function token(node, ctx)
  local text = token_text(node)
  local tag = node.tag
  if tag == "mtext" or tag == "ms" then
    if not text:find("[^%s\194\160]") then return { { cls = "space", n = text ~= "" and 1 or 0 } } end
    return { { cls = "ord", runs = { S(text) } } }
  end
  if tag == "mn" then return { { cls = "ord", runs = { S(text) }, num = true } } end
  if text == "" or text == "\u{2062}" or text == "\u{2063}" then return {} end
  if tag == "mi" then
    local n = ulen(text)
    if n == 1 and (BIN[text] or REL[text] or text == "!") then tag = "mo" -- « − » et « ! » écrits en <mi> par texmath
    elseif n > 1 then
      return { { cls = FN[text] and "fn" or "ord", runs = { S(text) } } }
    else
      local it = ctx.rich and is_letter(text, node.attrs.mathvariant)
      return { { cls = "ord", runs = { it and { k = "i", v = text } or S(text) } } }
    end
  end
  if text == "\u{2061}" then return { { cls = "apply" } } end -- application de fonction : sin⁡x
  return { { cls = mo_class(text, node.attrs.form), runs = { S(text) }, mo = text } }
end

local function space_atom(node)
  local width = node.attrs.width or ""
  local w = tonumber(width:match("^%-?[%d.]+")) or 0
  if width:match("ex$") then w = w / 2 end
  return { cls = "space", n = w >= 1.8 and 4 or w >= 0.9 and 2 or w > 0.1 and 1 or 0 }
end

-- Une seule unité : un atome, ou une suite déjà entourée de délimiteurs appariés
local function wrapped(atoms)
  local list = {}
  for _, a in ipairs(atoms) do if a.cls ~= "space" then table.insert(list, a) end end
  if #list == 1 then return true, list end
  local first, last = list[1], list[#list]
  if not (first and first.cls == "open" and last.cls == "close") then return false, list end
  local depth = 0
  for i, a in ipairs(list) do
    if a.cls == "open" then depth = depth + 1 elseif a.cls == "close" then depth = depth - 1 end
    if depth == 0 and i < #list then return false, list end
  end
  return true, list
end

local function accent_of(node)
  if not node or node.tag ~= "mo" then return nil end
  local text = token_text(node)
  if node.attrs.accent == "true" or ACCENTS[text] and ulen(text) == 1 then return ACCENTS[text] end
  return nil
end

local function scripted(node, ctx)
  local kids = elements(node)
  local tag = node.tag
  local acc = (tag == "mover" or tag == "munder") and accent_of(kids[2])
  if acc then
    -- x̂ pour une lettre seule, hat(AB) sinon
    local body = join(prepare(lin_node(kids[1], ctx), ctx), ctx)
    local text = flat(body)
    if acc[1] and ulen(text) == 1 then
      local r = body[1]
      return { cls = "ord", runs = { { k = r.k == "i" and "i" or "s", v = text .. acc[1] } } }
    end
    return { cls = "ord", runs = append(append({ S(acc[2] .. "(") }, body), { S(")") }) }
  end
  local base_atoms = prepare(lin_node(kids[1], ctx), ctx)
  local one, list = wrapped(base_atoms)
  local cls, runs = "ord", nil
  if #list == 1 then
    cls, runs = list[1].cls, append({}, list[1].runs)
  else
    runs = join(base_atoms, ctx)
    -- f(x)|_(x=0) : l'indice se pose sur le délimiteur fermant, pas de parenthèses en plus
    local last = list[#list]
    if not one and not (last and last.cls == "close") and not simple(flat(runs)) then
      runs = append(append({ S("(") }, runs), { S(")") })
    end
  end
  if cls == "bar" then cls = "close" end
  local sctx = { compact = true, rich = ctx.rich, decimal = ctx.decimal }
  local sub, sup
  if tag == "msub" or tag == "munder" then sub = kids[2]
  elseif tag == "msup" or tag == "mover" then sup = kids[2]
  else sub, sup = kids[2], kids[3] end
  if sub then
    local r = join(prepare(lin_node(sub, sctx), sctx), sctx)
    if #r > 0 then table.insert(runs, { k = "sub", v = r }) end
  end
  if sup then
    local atoms = prepare(lin_node(sup, sctx), sctx)
    local r = join(atoms, sctx)
    local text = flat(r)
    local primes = text ~= ""
    for _, c in utf8.codes(text) do if not PRIMES[utf8.char(c)] then primes = false end end
    local single = select(2, wrapped(atoms))
    if primes then table.insert(runs, S((text:gsub("'", "′"))))
    elseif text == "∘" or text == "◦" then table.insert(runs, S("°"))
    elseif #r > 0 then table.insert(runs, { k = "sup", v = r, single = #single == 1 }) end
  end
  return { cls = cls, runs = runs, scripted = true }
end

-- Parenthèses autour d'un numérateur ou d'un dénominateur qui en a besoin :
-- (b − a)/n, n(n + 1)/2, n!/(k!(n − k)!), (−b ± √Δ)/(2a), mais 1/f(x), dy/dx, 1/x^2
local function frac_part(atoms, ctx, den)
  local runs = join(atoms, ctx)
  local function parens() return append(append({ S("(") }, runs), { S(")") }) end
  -- unités du premier niveau : un atome ou un groupe entre délimiteurs (« ! » reste
  -- avec ce qui le précède)
  local units, depth = {}, 0
  for _, a in ipairs(atoms) do
    if a.cls == "space" then
      if depth == 0 and #units > 0 and a.n > 0 then return parens() end
    else
      local fact = a.cls == "close" and a.mo == "!"
      if depth == 0 then
        if a.cls == "bin" or a.cls == "rel" or a.cls == "punct" or a.cls == "op" or a.cls == "fn" then return parens() end
        if fact then
          if units[#units] then units[#units].fact = true end
        else
          table.insert(units, { cls = a.cls })
        end
      end
      if a.cls == "open" then depth = depth + 1 elseif a.cls == "close" and not fact then depth = math.max(0, depth - 1) end
    end
  end
  if not den or #units <= 1 then return runs end
  -- f(x) : une fonction appliquée ; dx, ∂x : une différentielle ; 1,5 : un nombre
  if #units == 2 and units[1].cls == "ord" and not units[1].fact and units[2].cls == "open" then return runs end
  local text = flat(runs)
  if text:match("^d%a$") or text:match("^∂%a$") or text:match("^%d+[,.]?%d*$") then return runs end
  return parens()
end

local function frac(node, ctx)
  local kids = elements(node)
  local num = prepare(lin_node(kids[1], ctx), ctx)
  local den = prepare(lin_node(kids[2], ctx), ctx)
  local lt = node.attrs.linethickness
  if lt and tonumber(lt:match("^[%d.]+") or "1") == 0 then
    return { cls = "binom", parts = { join(num, ctx), join(den, ctx) } }
  end
  local runs = append(append(frac_part(num, ctx, false), { S("/") }), frac_part(den, ctx, true))
  return { cls = "inner", runs = runs }
end

local function root(node, ctx)
  local kids = elements(node)
  local body = prepare(lin_node(kids[1], ctx), ctx)
  local runs = join(body, ctx)
  local text = flat(runs)
  local bare = #body == 1 and not body[1].scripted and text:match("^[%w.]+$") or ulen(text) <= 1
  local inside = append(append({ S("(") }, runs), { S(")") })
  local sign = "√"
  if node.tag == "mroot" then
    local idx = flat(join(prepare(lin_node(kids[2], ctx), ctx), ctx))
    sign = ({ ["3"] = "∛", ["4"] = "∜" })[idx]
    -- autre indice : root_5(x)
    if not sign then return { cls = "ord", runs = append({ S("root_" .. group(idx)) }, inside) } end
  end
  return { cls = "ord", runs = append({ S(sign) }, bare and runs or inside) }
end

local function table_atom(node, ctx)
  local rows = {}
  for _, tr in ipairs(elements(node)) do
    if tr.tag == "mtr" or tr.tag == "mlabeledtr" then
      local cells = {}
      for _, td in ipairs(elements(tr)) do
        if td.tag == "mtd" then
          table.insert(cells, { runs = join(prepare(lin_node(td, ctx), ctx), ctx), align = td.attrs.columnalign })
        end
      end
      if tr.tag == "mlabeledtr" and #cells > 1 then table.insert(cells, table.remove(cells, 1)) end
      table.insert(rows, cells)
    end
  end
  local first = rows[1]
  local aligned = first and #first >= 2 and first[1].align == "right" and first[2].align == "left"
  return { cls = "table", rows = rows, aligned = aligned or false }
end

-- Une ligne de tableau sur une ligne de texte : « a = b » (align) ou « 1, 2 » (matrice)
local function row_runs(cells, aligned, sep, offset)
  local out = {}
  for i, c in ipairs(cells) do
    if #c.runs > 0 then
      -- align : « a = b    c = d », un écart entre deux paires de colonnes
      if #out > 0 then table.insert(out, S(aligned and ((i + (offset or 0)) % 2 == 1 and "    " or " ") or sep)) end
      append(out, c.runs)
    end
  end
  return out
end

local function table_runs(t, sep)
  local out = {}
  for i, cells in ipairs(t.rows) do
    if i > 1 then table.insert(out, S("; ")) end
    append(out, row_runs(cells, t.aligned, sep))
  end
  return out
end

lin_node = function(node, ctx)
  local tag = node.tag
  if not tag then return {} end
  if tag == "annotation" or tag == "annotation-xml" or tag == "mphantom" or tag == "none"
    or tag == "mprescripts" then
    return {}
  end
  if tag == "mi" or tag == "mn" or tag == "mo" or tag == "mtext" or tag == "ms" then return token(node, ctx) end
  if tag == "mspace" then return { space_atom(node) } end
  if tag == "msub" or tag == "msup" or tag == "msubsup" or tag == "munder" or tag == "mover"
    or tag == "munderover" then
    return { scripted(node, ctx) }
  end
  if tag == "mfrac" then return { frac(node, ctx) } end
  if tag == "msqrt" or tag == "mroot" then return { root(node, ctx) } end
  if tag == "mtable" then return { table_atom(node, ctx) } end
  if tag == "maction" then
    local first = elements(node)[1]
    return first and lin_node(first, ctx) or {}
  end
  -- math, semantics, mrow, mstyle, mpadded, menclose, merror… : leur contenu
  return lin_list(elements(node), ctx)
end

local LEFT_OF_UNARY = { open = true, bin = true, rel = true, punct = true, op = true, fn = true }

prepare = function(atoms, ctx)
  -- ∥ venu de Word (\parallel) qui encadre une norme : ‖x‖ et non « ∥ x ∥ »
  local parallels = {}
  for _, a in ipairs(atoms) do
    if a.cls == "rel" and a.mo == "∥" then table.insert(parallels, a) end
  end
  if #parallels >= 2 and #parallels % 2 == 0 then
    for _, a in ipairs(parallels) do a.cls = "bar" end
  end
  -- application de fonction (sin⁡x) et barres | ‖ ouvrantes ou fermantes
  local list = {}
  local prev
  for _, a in ipairs(atoms) do
    if a.cls == "apply" then
      if prev and (prev.cls == "ord" or prev.cls == "fn") then prev.cls = "fn" end
    else
      if a.cls == "bar" then
        a.cls = (not prev or LEFT_OF_UNARY[prev.cls]) and "open" or "close"
      end
      table.insert(list, a)
      if a.cls ~= "space" then prev = a end
    end
  end
  -- délimiteurs autour d'un tableau ou d'un coefficient binomial
  local out = {}
  local i = 1
  while i <= #list do
    local a, b, c = list[i], list[i + 1], list[i + 2]
    if a.cls == "open" and b and b.cls == "binom" and c and c.cls == "close" then
      table.insert(out, { cls = "inner", runs = append(append(append(append({ S("binom(") }, b.parts[1]), { S(", ") }), b.parts[2]), { S(")") }) })
      i = i + 3
    elseif a.cls == "open" and b and b.cls == "table" then
      local cases = a.mo == "{" and not (c and c.cls == "close" and c.mo ~= "")
      local runs = append(append({}, a.runs), table_runs(b, cases and " " or ", "))
      if c and c.cls == "close" then
        append(runs, c.runs)
        i = i + 3
      else
        i = i + 2
      end
      table.insert(out, { cls = "inner", runs = runs })
    else
      if a.cls == "binom" then
        a = { cls = "inner", runs = append(append(append(append({ S("(") }, a.parts[1]), { S("; ") }), a.parts[2]), { S(")") }) }
      end
      table.insert(out, a)
      i = i + 1
    end
  end
  -- signes unaires (−x, +∞) et virgule décimale (1{,}5)
  local function neighbour(k, step)
    local j = k + step
    while out[j] and out[j].cls == "space" do j = j + step end
    return out[j]
  end
  for k, a in ipairs(out) do
    if a.cls == "bin" then
      local p, n = neighbour(k, -1), neighbour(k, 1)
      if not p or LEFT_OF_UNARY[p.cls] or not n or n.cls == "rel" or n.cls == "close" or n.cls == "punct" then
        a.cls = "ord"
      end
    elseif a.cls == "punct" and a.mo == "," and ctx.decimal then
      local p, n = out[k - 1], out[k + 1]
      if p and n and p.num and n.num then a.cls = "ord" end
    end
  end
  return out
end

local function starts_alnum(a)
  local r = a.runs and a.runs[1]
  local s = r and (r.k == "s" or r.k == "i") and r.v or ""
  return s:match("^[%w\128-\255]") ~= nil and not BREAKS[s:match("^[%z\1-\127\194-\244][\128-\191]*") or ""]
end

join = function(atoms, ctx)
  local runs = {}
  local prev
  local pending = 0
  for _, a in ipairs(atoms) do
    if a.cls == "space" then
      pending = math.max(pending, a.n)
    elseif a.cls == "table" then
      -- tableau sans délimiteurs (aligned dans une phrase, \substack…)
      if prev and (pending > 0 or not ctx.compact) then table.insert(runs, S(string.rep(" ", math.max(pending, 1)))) end
      append(runs, table_runs(a, ", "))
      prev, pending = { cls = "inner" }, 0
    else
      if prev then
        local sp = 0
        if not ctx.compact then
          sp = (SPACING[prev.cls] or {})[a.cls] or 0
          -- x^n e^(−x) : une espace après un indice ou un exposant suivi d'une lettre
          if sp == 0 and not ctx.rich and prev.scripted and (a.cls == "ord" or a.cls == "inner") and starts_alnum(a)
            and flat(prev.runs):find("[_^]") then
            sp = 1
          end
        end
        sp = math.max(sp, ctx.compact and math.min(pending, 1) or pending)
        local last = runs[#runs]
        if sp > 0 and last and last.k == "s" and last.v:match(" $") then sp = 0 end
        if sp > 0 and a.runs[1] and a.runs[1].k == "s" and a.runs[1].v:match("^ ") then sp = 0 end
        if sp > 0 then table.insert(runs, S(string.rep(" ", sp))) end
      end
      append(runs, a.runs)
      prev, pending = a, 0
    end
  end
  return runs
end

-- Largeur affichée (les caractères combinants n'avancent pas)
local function width(s)
  local n = 0
  for _, c in utf8.codes(s) do
    if not (c >= 0x300 and c <= 0x36F or c >= 0x20D0 and c <= 0x20FF) then n = n + 1 end
  end
  return n
end

local mathml_cache = {}
local function math_key(m) return m.mathtype .. "\0" .. m.text end

local function mathml_tree(m)
  local key = math_key(m)
  if mathml_cache[key] == nil then
    local ok, html = pcall(pandoc.write, pandoc.Pandoc({ pandoc.Plain({ pandoc.Math(m.mathtype, m.text) }) }),
      "html", { html_math_method = "mathml" })
    local xml = ok and html:match("<math[%s>].*</math>")
    mathml_cache[key] = xml and parse_xml(xml) or false
  end
  return mathml_cache[key]
end

-- Toutes les formules du document en MathML d'un seul coup : un appel de Pandoc
-- par formule prendrait plusieurs secondes sur un long poly
local function prefetch_mathml(doc)
  local list, seen = {}, {}
  doc:walk({
    Math = function(m)
      local key = math_key(m)
      if not seen[key] then
        seen[key] = true
        table.insert(list, m)
      end
    end,
  })
  if #list == 0 then return end
  local blocks = {}
  for _, m in ipairs(list) do table.insert(blocks, pandoc.Para({ pandoc.Math(m.mathtype, m.text) })) end
  local ok, html = pcall(pandoc.write, pandoc.Pandoc(blocks), "html", { html_math_method = "mathml" })
  if not ok then return end
  local paras = {}
  for p in html:gmatch("<p>(.-)</p>") do table.insert(paras, p) end
  if #paras ~= #list then return end -- décalage : chaque formule sera écrite à part
  for k, m in ipairs(list) do
    local xml = paras[k]:match("<math[%s>].*</math>")
    mathml_cache[math_key(m)] = xml and parse_xml(xml) or false
  end
end

-- Formule mise à plat : texte (texte brut) ou éléments Pandoc (RTF, FB2) ; une
-- formule centrée faite d'un tableau (align, gather) donne une ligne par rangée
local function linear(m)
  local tree = mathml_tree(m)
  local ctx = { rich = RICH[to] or false, compact = false, decimal = m.text:find("%d{,}%d") ~= nil }
  if not tree then
    -- formule que texmath ne sait pas lire : le code TeX, faute de mieux
    return { text = m.text, inlines = pandoc.List({ pandoc.Str(m.text) }), lines = { m.text } }
  end
  local atoms = prepare(lin_node(tree, ctx), ctx)
  local only = {}
  for _, a in ipairs(atoms) do if a.cls ~= "space" then table.insert(only, a) end end
  local rows
  if m.mathtype == "DisplayMath" and #only == 1 and only[1].cls == "table" then
    rows = {}
    for _, cells in ipairs(only[1].rows) do
      if only[1].aligned then
        -- colonne de gauche alignée à droite, pour aligner les signes = sous les autres
        local rest = {}
        for k = 2, #cells do table.insert(rest, cells[k]) end
        table.insert(rows, { left = cells[1] and cells[1].runs or {}, right = row_runs(rest, true, "", 1) })
      else
        table.insert(rows, { left = {}, right = row_runs(cells, false, "    ") })
      end
    end
  end
  if not rows then
    local runs = join(atoms, ctx)
    return { text = flat(runs), inlines = rich(runs), lines = { flat(runs) } }
  end
  local lines, inlines = {}, pandoc.List()
  local w = 0
  for _, r in ipairs(rows) do w = math.max(w, width(flat(r.left))) end
  for k, r in ipairs(rows) do
    local left, right = flat(r.left), flat(r.right)
    local line = string.rep(" ", w - width(left)) .. left .. ((left ~= "" or w > 0) and right ~= "" and " " or "") .. right
    table.insert(lines, (line:gsub("%s+$", "")))
    if k > 1 then inlines:insert(pandoc.LineBreak()) end
    inlines:extend(rich(r.left))
    if #r.left > 0 and #r.right > 0 then inlines:insert(pandoc.Space()) end
    inlines:extend(rich(r.right))
  end
  return { text = table.concat(lines, " ; "), inlines = inlines, lines = lines }
end

local function as_linear(m)
  local r = linear(m)
  if m.mathtype == "DisplayMath" then
    -- détachée de son paragraphe plus loin (split_display)
    return pandoc.Span(RICH[to] and r.inlines or { pandoc.Str(r.text) },
      { class = "cvx-display", lines = table.concat(r.lines, "\n") })
  end
  if RICH[to] then return r.inlines end
  return pandoc.Str(r.text)
end

-- Formule centrée sur sa propre ligne (paragraphe à part), avec la ponctuation qui
-- la suit, y compris au milieu d'un passage en italique (énoncé d'un théorème)
local SPLITTABLE = { Emph = true, Strong = true, Underline = true, SmallCaps = true, Strikeout = true, Span = true }
local function is_display(el) return el.t == "Span" and has_class(el, "cvx-display") end

local function has_display(inls)
  for _, el in ipairs(inls) do
    if is_display(el) or SPLITTABLE[el.t] and has_display(el.content) then return true end
  end
  return false
end

-- Morceaux : { inlines = … } (texte) ou { display = span }
local function split_inlines(inls)
  local segs, cur = {}, pandoc.List()
  local function push()
    if #cur > 0 then table.insert(segs, { inlines = cur }) end
    cur = pandoc.List()
  end
  for _, el in ipairs(inls) do
    if is_display(el) then
      push()
      table.insert(segs, { display = el })
    elseif SPLITTABLE[el.t] and has_display(el.content) then
      for _, seg in ipairs(split_inlines(el.content)) do
        if seg.display then
          push()
          table.insert(segs, seg)
        else
          local copy = el:clone()
          copy.content = seg.inlines
          cur:insert(copy)
        end
      end
    else
      cur:insert(el)
    end
  end
  push()
  return segs
end

-- Ponctuation au début d'un morceau de texte (« . » après une formule centrée)
local function take_punct(inls)
  local first = inls[1]
  if not first then return "" end
  if SPLITTABLE[first.t] then
    local content = first.content
    local p = take_punct(content)
    if p ~= "" then
      if #content == 0 then inls:remove(1) else first.content = content end
    end
    return p
  end
  if first.t ~= "Str" then return "" end
  local p, rest = first.text:match("^([.,;:]+)(.*)$")
  if not p then return "" end
  if rest == "" then inls:remove(1) else first.text = rest end
  return p
end

local function split_display(blk)
  if not LINEAR[to] or not has_display(blk.content) then return nil end
  local blocks = pandoc.List()
  local blank = { Space = true, SoftBreak = true, LineBreak = true }
  local segs = split_inlines(blk.content)
  for k, seg in ipairs(segs) do
    if seg.display then
      local nxt = segs[k + 1]
      local punct = nxt and nxt.inlines and take_punct(nxt.inlines) or ""
      if to == "txt" then
        -- le saut de ligne final sépare deux formules centrées qui se suivent
        blocks:insert(pandoc.RawBlock("plain", seg.display.attributes.lines .. punct .. "\n"))
      else
        local content = pandoc.List(seg.display.content)
        if punct ~= "" then content:insert(pandoc.Str(punct)) end
        blocks:insert(pandoc.Para(content))
      end
    else
      local cur = seg.inlines
      while #cur > 0 and blank[cur[1].t] do cur:remove(1) end
      while #cur > 0 and blank[cur[#cur].t] do cur:remove(#cur) end
      if #cur > 0 and pandoc.utils.stringify(cur):find("%S") then
        blocks:insert(blk.t == "Plain" and pandoc.Plain(cur) or pandoc.Para(cur))
      end
    end
  end
  return blocks
end

-- Repère des formules extraites (ODT, PPTX) : U+E000 numéro U+E001
local MARK = "\238\128\128(%d+)\238\128\129"

local function split_marks(text)
  if not text:find(MARK) then return nil end
  local out = pandoc.List()
  local pos = 1
  while true do
    local s, e, n = text:find(MARK, pos)
    if not s then break end
    if s > pos then out:insert(pandoc.Str(text:sub(pos, s - 1))) end
    local f = extracted[tonumber(n) + 1]
    if f then
      out:insert(pandoc.Math(f.display and "DisplayMath" or "InlineMath", f.tex))
    end
    pos = e + 1
  end
  if pos <= #text then out:insert(pandoc.Str(text:sub(pos))) end
  return out
end

-- Repère \( \), \[ \] et $$ $$ dans le texte d'une page HTML (pages écrites
-- pour MathJax ou KaTeX, dont les formules ne sont pas encore rendues).
local OPEN = { ["\\("] = "\\)", ["\\["] = "\\]", ["$$"] = "$$" }

local function text_to_inlines(s, out)
  for ws, word in s:gmatch("(%s*)(%S*)") do
    if ws ~= "" then
      if ws:find("\n") then out:insert(pandoc.SoftBreak()) else out:insert(pandoc.Space()) end
    end
    if word ~= "" then out:insert(pandoc.Str(word)) end
  end
end

local function scan_delims(run, out)
  local s = table.concat(run)
  if not (s:find("\\(", 1, true) or s:find("\\[", 1, true) or s:find("$$", 1, true)) then
    return false
  end
  local pos = 1
  local found = false
  while pos <= #s do
    local best, open
    for o in pairs(OPEN) do
      local i = s:find(o, pos, true)
      if i and (not best or i < best) then best, open = i, o end
    end
    if not best then break end
    local close = OPEN[open]
    local j = s:find(close, best + #open, true)
    if not j then break end
    text_to_inlines(s:sub(pos, best - 1), out)
    local tex = trim(s:sub(best + #open, j - 1))
    out:insert(pandoc.Math(open == "\\(" and "InlineMath" or "DisplayMath", tex))
    found = true
    pos = j + #close
  end
  if not found then return false end
  text_to_inlines(s:sub(pos), out)
  return true
end

local function scan_inlines(inls)
  local out = pandoc.List()
  local run, changed = {}, false
  local function flush()
    if #run == 0 then return end
    local before = #out
    if scan_delims(run, out) then
      changed = true
    else
      for k = #out, before + 1, -1 do out:remove(k) end
      for _, el in ipairs(run.els) do out:insert(el) end
    end
    run = {}
  end
  for _, el in ipairs(inls) do
    if el.t == "Str" or el.t == "Space" or el.t == "SoftBreak" then
      run.els = run.els or {}
      table.insert(run.els, el)
      table.insert(run, el.t == "Str" and el.text or (el.t == "Space" and " " or "\n"))
    else
      flush()
      out:insert(el)
    end
  end
  flush()
  return changed and out or nil
end

local HTML_LIKE = { html = true, epub = true, md = true }

local filter = {}

function filter.Math(m)
  local text = tags_as_text(clean_tex(m.text, m.mathtype == "InlineMath"))
  if text ~= m.text then m.text = text end
  return m
end

function filter.Str(s)
  if #extracted == 0 then return nil end
  return split_marks(s.text)
end

function filter.Span(span)
  if not HTML_LIKE[from] and from ~= "textile" then return nil end
  -- rendu visuel de KaTeX ou de MathJax 2 : la formule est déjà lue ailleurs
  if has_class(span, "katex-html") or has_class(span, "MathJax_Preview")
    or has_class(span, "MathJax") or has_class(span, "MathJax_Display") then
    return {}
  end
  -- <span class="math inline">\(…\)</span> (Pandoc, Quarto, R Markdown…). Si la
  -- formule est déjà rendue (italiques, indices…), elle n'a plus de TeX : on la garde.
  if has_class(span, "math") then
    local plain = true
    local maths = {}
    for _, el in ipairs(span.content) do
      if el.t == "Math" then table.insert(maths, el) end
      if el.t ~= "Str" and el.t ~= "Space" and el.t ~= "SoftBreak" then plain = false end
    end
    -- formule déjà reconnue à l'intérieur (délimiteurs \( \) lus plus tôt) : on retire l'enveloppe
    if #maths == 1 and #span.content:filter(function(el) return el.t ~= "Space" and el.t ~= "SoftBreak" end) == 1 then
      return maths[1]
    end
    if plain then
      local tex, display = strip_delims(pandoc.utils.stringify(span))
      if span.classes:includes("display") then display = true end
      return pandoc.Math(display and "DisplayMath" or "InlineMath", tex)
    end
  end
  -- enveloppes de KaTeX, de MathJax et de Wikipédia autour de la formule
  if has_class_prefix(span, "katex") or has_class_prefix(span, "mwe-math")
    or has_class(span, "MJX_Assistive_MathML") then
    return span.content
  end
  return nil
end

function filter.Image(img)
  -- image de secours des formules de Wikipédia (la formule est lue en MathML)
  if HTML_LIKE[from] and has_class_prefix(img, "mwe-math-fallback") then return {} end
  return nil
end

function filter.RawInline(raw)
  if raw.format ~= "tex" and raw.format ~= "latex" then return nil end
  local tex = math_env(raw.text)
  if tex then return pandoc.Math("DisplayMath", tex) end
  return nil
end

function filter.RawBlock(raw)
  if raw.format ~= "tex" and raw.format ~= "latex" then return nil end
  local tex = math_env(raw.text)
  if tex then return pandoc.Para({ pandoc.Math("DisplayMath", tex) }) end
  return nil
end

-- AsciiDoc écrit toute formule centrée en bloc, même au milieu d'un texte en
-- italique, ce qui casse le texte autour : elle y devient une formule en ligne
local function inline_display(el)
  if to ~= "adoc" then return nil end
  return el:walk({
    Math = function(m)
      if m.mathtype == "DisplayMath" then return pandoc.Math("InlineMath", "\\displaystyle " .. m.text) end
    end,
  })
end
filter.Emph = inline_display
filter.Strong = inline_display

function filter.CodeBlock(code)
  -- bloc ```math de GitHub
  if has_class(code, "math") then
    return pandoc.Para({ pandoc.Math("DisplayMath", trim(code.text)) })
  end
  return nil
end

-- Une formule seule dans son paragraphe, venue d'un format qui ne distingue pas
-- les formules centrées (objets ODT, <math display="block"> de MediaWiki, Textile)
local function lone_display(blk)
  if from ~= "odt" and from ~= "wiki" and from ~= "textile" then return nil end
  local content = blk.content:filter(function(el) return el.t ~= "Space" and el.t ~= "SoftBreak" end)
  if #content == 1 and content[1].t == "Math" and content[1].mathtype == "InlineMath" then
    return pandoc.Para({ pandoc.Math("DisplayMath", content[1].text) })
  end
  return nil
end
filter.Para = lone_display
filter.Plain = lone_display

-- En Markdown, « \[1\] » ou « tableau\[i\] » sont des crochets échappés, pas une
-- formule \[ … \] : une formule centrée au milieu d'une phrase, sans rien de
-- mathématique dedans, redevient du texte entre crochets.
local function looks_like_math(tex)
  return tex:find("[\\^_=<>]") ~= nil
end

local function unescape_brackets(inls)
  local changed = false
  for i, el in ipairs(inls) do
    local prev = inls[i - 1]
    if el.t == "Math" and el.mathtype == "DisplayMath" and prev
      and (prev.t == "Str" or prev.t == "Space") and not looks_like_math(el.text) then
      inls[i] = pandoc.Str("[" .. el.text .. "]")
      changed = true
    end
  end
  return changed and inls or nil
end

-- Le lecteur PPTX garde les espaces dans le texte et en ajoute aux jonctions
-- avec les formules : espaces simples, et aucun avant un point ou une virgule.
local function pptx_spaces(inls)
  local out = pandoc.List()
  local function push_space()
    if #out > 0 and out[#out].t ~= "Space" then out:insert(pandoc.Space()) end
  end
  for _, el in ipairs(inls) do
    if el.t == "Str" and el.text:find("%s") then
      local text = el.text
      if #out > 0 and out[#out].t == "Math" then text = text:gsub("^%s+([.,)])", "%1") end
      if text:find("^%s") then push_space() end
      local first = true
      for word in text:gmatch("%S+") do
        if not first then push_space() end
        out:insert(pandoc.Str(word))
        first = false
      end
      if text:find("%s$") and not first then push_space() end
    elseif el.t == "Space" then
      push_space()
    else
      out:insert(el)
    end
  end
  return out
end

-- Textile : Pandoc lit <span class="math">…</span> comme deux balises HTML brutes
-- autour du texte de la formule
local function textile_spans(inls)
  local out, i, changed = pandoc.List(), 1, false
  while i <= #inls do
    local el = inls[i]
    local cls = el.t == "RawInline" and el.format == "html" and el.text:match('^<span class="(math[^"]*)">$')
    local close
    if cls then
      for j = i + 1, #inls do
        if inls[j].t == "RawInline" and inls[j].text == "</span>" then close = j; break end
      end
    end
    if close then
      local tex = pandoc.utils.stringify(pandoc.List({ table.unpack(inls, i + 1, close - 1) }))
      -- typographie du lecteur Textile (’ – …) défaite : c'est du TeX
      tex = tex:gsub("\226\128\153", "'"):gsub("\226\128\152", "`"):gsub("\226\128\147", "-")
        :gsub("\226\128\148", "--"):gsub("\226\128\166", "...")
      out:insert(pandoc.Math(cls:find("display") and "DisplayMath" or "InlineMath", tex))
      i, changed = close + 1, true
    else
      out:insert(el)
      i = i + 1
    end
  end
  return changed and out or nil
end

local function inlines(inls)
  if from == "md" then return unescape_brackets(inls) end
  if from == "textile" then return textile_spans(inls) end
  if from ~= "html" and from ~= "epub" then return nil end
  return scan_inlines(inls)
end

return {
  {
    Meta = function(meta)
      from = meta["cvx-from"] and pandoc.utils.stringify(meta["cvx-from"]) or ""
      to = meta["cvx-to"] and pandoc.utils.stringify(meta["cvx-to"]) or ""
      for _, item in ipairs(meta["cvx-math"] or {}) do
        local s = pandoc.utils.stringify(item)
        table.insert(extracted, { display = s:sub(1, 2) == "D:", tex = s:sub(3) })
      end
      meta["cvx-from"], meta["cvx-to"], meta["cvx-math"] = nil, nil, nil
      return meta
    end,
  },
  { Inlines = inlines },
  { Str = filter.Str },
  { Inlines = function(inls) if from == "pptx" and #extracted > 0 then return pptx_spaces(inls) end end },
  {
    Span = filter.Span, Image = filter.Image, RawInline = filter.RawInline,
    RawBlock = filter.RawBlock, CodeBlock = filter.CodeBlock,
  },
  { Emph = filter.Emph, Strong = filter.Strong },
  { Para = filter.Para, Plain = filter.Plain },
  {
    -- numérotation dans l'ordre du document, puis renvois (sauf vers LaTeX, qui s'en charge)
    Pandoc = function(doc)
      if to == "tex" then return nil end
      doc = doc:walk({ Math = number_equation })
      return doc:walk({ Link = resolve_ref })
    end,
  },
  { Math = filter.Math },
  {
    -- formats sans notation mathématique : formules mises à plat
    Pandoc = function(doc)
      if not LINEAR[to] then return nil end
      pcall(prefetch_mathml, doc)
      return doc:walk({
        Math = function(m)
          -- une formule imprévue ne doit pas faire échouer toute la conversion
          local ok, out = pcall(as_linear, m)
          if ok then return out end
          return pandoc.Str(m.text)
        end,
      })
    end,
  },
  {
    Para = function(blk) local ok, out = pcall(split_display, blk); return ok and out or nil end,
    Plain = function(blk) local ok, out = pcall(split_display, blk); return ok and out or nil end,
  },
}

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

local function clean_tex(text, inline)
  -- syntaxe GitHub $`…`$ lue par le lecteur Markdown : les accents graves restent
  local inner = text:match("^`(.*)`$")
  if inner then text = inner end
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

-- Formats sans notation mathématique : texte Unicode quand c'est possible, sinon TeX
local NO_MATH = { fb2 = true }
local function as_text(m)
  local plain = pandoc.write(pandoc.Pandoc({ pandoc.Plain({ m }) }), "plain")
  plain = trim(plain)
  if plain:match("^%$") then return pandoc.Code(m.text) end
  return pandoc.Str(plain)
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
  if NO_MATH[to] then return as_text(m) end
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
}

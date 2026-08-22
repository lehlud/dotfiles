// Typst port of the i4neo Beamer theme.

#let colors = (
  dark-grey: rgb("#98A4AE"),
  grey: rgb("#D2D5D7"),
  light-grey: rgb("#EBECEE"),
  dark-red: rgb("#8D1429"),
  red: rgb("#C9A993"),
  light-red: rgb("#EDE7DE"),
  dark-green: rgb("#009B77"),
  green: rgb("#AACFBD"),
  light-green: rgb("#E5EFEA"),
  dark-blue: rgb("#003865"),
  blue: rgb("#90A7C6"),
  light-blue: rgb("#DDE5F0"),
  dark-cyan: rgb("#00B1EB"),
  cyan: rgb("#B4D6F5"),
  light-cyan: rgb("#EAF3FC"),
  dark-yellow: rgb("#C99313"),
  yellow: rgb("#D9C689"),
  light-yellow: rgb("#F3EEDF"),
  black: rgb("#011F32"),
  white: rgb("#FFFFFF"),
  title-separator: rgb("#CCCCCC"),
)

#let layout-scale = 16 / 25.4
#let scaled(length) = length * layout-scale

#let page-width = scaled(25.4cm)
#let page-height = scaled(15.875cm)
#let title-x = scaled(1.55cm)
#let title-width = scaled(22.3cm)
#let title-image-height = scaled(13.43cm)
#let title-band-y = scaled(11.1125cm)
#let header-height = scaled(1.85cm)
#let header-title-y = scaled(0.46cm) + 0.04cm
#let footer-height = scaled(0.82cm)
#let footer-y = page-height - footer-height
#let body-y = header-height
#let body-x = 1.0cm
#let body-width = page-width - 2.0cm

#let fira-sans = "Fira Sans"
#let fira-mono = "Fira Mono"
#let fira-sans-features = ("onum", "tnum")
#let fira-mono-features = ("lnum", "tnum")
#let body-text-size = 12pt
#let code-text-size = 13.7pt
#let list-marker = move(dy: 0.12em)[#square(size: 0.48em, fill: colors.dark-blue)]

#let slide-counter = counter("neo-slide")
#let section-slide-counter = counter("neo-section-slide")

#let month-names = (
  en: ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"),
  de: ("Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"),
)

#let normalize-locale(locale) = {
  if locale == "de" or locale == "de-DE" {
    "de"
  } else {
    "en"
  }
}

#let format-date(value, locale: "en") = {
  if value == none {
    none
  } else {
    let lang = normalize-locale(locale)
    let date = if value == auto { datetime.today() } else { value }
    if type(date) == datetime {
      let day = date.day()
      let month = date.month()
      let year = date.year()
      let name = month-names.at(lang).at(month - 1)
      if lang == "de" {
        str(day) + ". " + name + " " + str(year)
      } else {
        name + " " + str(day) + ", " + str(year)
      }
    } else {
      date
    }
  }
}

#let image-root = "images"
#let default-title-background(variant) = image-root + "/titlepage-" + variant + ".pdf"
#let default-title-logos = (
  (path: image-root + "/logo-i4.pdf", x: title-x, y: scaled(12.35cm), width: scaled(5.6cm), height: scaled(1.5cm), alt: "i4 logo"),
  (path: image-root + "/logo-fau-tf.pdf", x: scaled(11.55cm), y: scaled(12.45cm), width: scaled(11.9cm), height: scaled(1.7cm), alt: "FAU TF logo"),
)

#let setup(locale: "en", body) = {
  let lang = normalize-locale(locale)
  set page(width: page-width, height: page-height, margin: 0pt, fill: colors.white)
  set text(font: fira-sans, size: body-text-size, fill: colors.black, weight: 350, features: fira-sans-features, lang: lang)
  set par(leading: 0.65em, spacing: 0.5em)
  set list(
    marker: list-marker,
    indent: 0.46cm,
    body-indent: 0.28cm,
    spacing: 0.40cm,
  )
  body
}

#let at(x, y, body) = place(top + left, dx: x, dy: y, body)

#let fitted-image(path, width: auto, height: auto, fit: "contain", alt: none) = {
  image(path, width: width, height: height, fit: fit, alt: alt)
}

#let text-frame(
  x,
  y,
  width,
  height: auto,
  size: 12pt,
  fill: colors.black,
  weight: 350,
  align-x: left,
  align-y: top,
  body,
) = {
  at(x, y)[
    #box(width: width, height: height)[
      #align(align-y + align-x)[
        #set text(font: fira-sans, size: size, fill: fill, weight: weight, features: fira-sans-features)
        #set par(leading: 0.65em, spacing: 0.5em)
        #body
      ]
    ]
  ]
}

#let footer-number(numbering) = {
  if numbering == none or numbering == "none" {
    []
  } else if numbering == "fraction" {
    context slide-counter.display("1/1", both: true)
  } else {
    context slide-counter.display("1")
  }
}

#let footer-content(footer, author: none, short-title: none, section: none, subsection: none) = {
  if footer == none or footer == "none" {
    ()
  } else if footer == "author" {
    (left: author, center: [], right: [])
  } else if footer == "title" {
    (left: short-title, center: [], right: [])
  } else if footer == "title section" {
    (left: short-title, center: section, right: [])
  } else if footer == "author title section" {
    (left: author, center: short-title, right: section)
  } else if footer == "title section subsection" {
    let detail = if subsection == none { section } else { [#section -- #subsection] }
    (left: short-title, center: detail, right: [])
  } else {
    (left: author, center: short-title, right: [])
  }
}

#let render-footer(
  footer: "author title",
  numbering: "counter",
  footer-style: "standout",
  author: none,
  short-title: none,
  section: none,
  subsection: none,
) = {
  if footer-style == "standout" {
    at(0cm, footer-y)[#rect(width: page-width, height: footer-height, fill: colors.dark-blue, stroke: none)]
  }

  let parts = footer-content(footer, author: author, short-title: short-title, section: section, subsection: subsection)
  if parts != () {
    text-frame(scaled(0.25cm), footer-y, scaled(7.3cm), height: footer-height, size: 8pt, fill: colors.white, align-y: horizon)[#parts.left]
    text-frame(scaled(8.0cm), footer-y, scaled(9.4cm), height: footer-height, size: 8pt, fill: colors.white, align-x: center, align-y: horizon)[#parts.center]
  }
  text-frame(scaled(23.65cm), footer-y, scaled(1.45cm), height: footer-height, size: 8pt, fill: colors.white, align-x: right, align-y: horizon)[#footer-number(numbering)]
}

#let render-header(title: none, subtitle: none) = {
  at(0cm, 0cm)[#rect(width: page-width, height: header-height, fill: colors.dark-blue, stroke: none)]
  if title != none {
    text-frame(scaled(0.78cm), header-title-y, scaled(17.9cm), height: scaled(0.85cm), size: 14.4pt, fill: colors.white, weight: "bold", align-y: horizon)[#title]
  }
  if subtitle != none {
    text-frame(scaled(18.75cm), header-title-y + scaled(0.12cm), scaled(5.85cm), height: scaled(0.52cm), size: 8pt, fill: colors.white, align-x: right, align-y: horizon)[#subtitle]
  }
}

#let slide(
  title: none,
  subtitle: none,
  author: none,
  short-title: none,
  section: none,
  subsection: none,
  footer: "author title",
  footer-style: "standout",
  numbering: "counter",
  increment: true,
  body,
) = {
  page(width: page-width, height: page-height, margin: 0pt, fill: colors.white)[
    #if increment { slide-counter.step() }
    #render-header(title: title, subtitle: subtitle)
    #render-footer(
      footer: footer,
      numbering: numbering,
      footer-style: footer-style,
      author: author,
      short-title: short-title,
      section: section,
      subsection: subsection,
    )
    #text-frame(body-x, body-y, body-width, height: footer-y - header-height, size: 12pt, align-y: horizon)[
      #set list(
        marker: list-marker,
        indent: 0.46cm,
        body-indent: 0.28cm,
        spacing: 0.40cm,
      )
      #body
    ]
  ]
}

#let title-slide(
  title: none,
  subtitle: none,
  date: auto,
  locale: "en",
  author: none,
  institute: none,
  variant: "extern",
  background: auto,
  logos: default-title-logos,
) = {
  let bg-path = if background == auto { default-title-background(variant) } else { background }
  let display-date = format-date(date, locale: locale)

  page(width: page-width, height: page-height, margin: 0pt, fill: colors.black)[
    #if bg-path != none {
      at(0cm, 0cm)[#fitted-image(bg-path, width: page-width, height: title-image-height, fit: "cover", alt: "i4neo title artwork")]
    }
    #at(0cm, title-band-y)[#rect(width: page-width, height: page-height - title-band-y, fill: colors.white, stroke: none)]
    #at(title-x, 3.03cm)[#rect(width: title-width, height: 0.4pt, fill: colors.title-separator, stroke: none)]

    #if title != none {
      text-frame(title-x, 1.02cm, title-width, height: 0.78cm, size: 17.28pt, fill: colors.white, weight: 500)[#title]
    }
    #if subtitle != none {
      text-frame(title-x, 2.11cm, title-width, height: 0.65cm, size: 14.4pt, fill: colors.white)[#subtitle]
    }
    #if display-date != none {
      text-frame(title-x, 3.59cm, title-width, height: 0.50cm, size: 10.95pt, fill: colors.white)[#display-date]
    }
    #if author != none {
      text-frame(title-x, 4.91cm, title-width, height: 0.50cm, size: 10.95pt, fill: colors.white)[#author]
    }
    #if institute != none {
      text-frame(title-x, 5.76cm, title-width, height: 0.36cm, size: 8pt, fill: colors.white)[#institute]
    }

    #for logo in logos {
      at(logo.x, logo.y)[#fitted-image(logo.path, width: logo.width, height: logo.height, fit: "contain", alt: logo.alt)]
    }
  ]
}

#let section-progress-bar(width, progress) = {
  if progress == none {
    []
  } else if progress == auto {
    context {
      let current = section-slide-counter.get().first()
      let total = section-slide-counter.final().first()
      let fraction = if total == 0 { 0 } else { current / total }
      rect(width: width * fraction, height: 0.4pt, fill: colors.dark-blue, stroke: none)
    }
  } else {
    rect(width: width * progress, height: 0.4pt, fill: colors.dark-blue, stroke: none)
  }
}

#let section-slide(title, progress: auto, subtitle: none) = {
  page(width: page-width, height: page-height, margin: 0pt, fill: colors.white)[
    #section-slide-counter.step()
    #let bar-width = scaled(13.3cm)
    #text-frame(scaled(6.05cm), scaled(6.70cm), bar-width, height: scaled(0.9cm), size: 17.28pt, fill: colors.black, weight: "bold")[#title]
    #at(scaled(6.05cm), scaled(7.72cm))[#rect(width: bar-width, height: 0.4pt, fill: colors.light-blue, stroke: none)]
    #at(scaled(6.05cm), scaled(7.72cm))[#section-progress-bar(bar-width, progress)]
    #if subtitle != none {
      text-frame(scaled(6.05cm), scaled(8.08cm), bar-width, size: 12pt, fill: colors.black)[#subtitle]
    }
  ]
}

#let standout(body, increment: true) = {
  page(width: page-width, height: page-height, margin: 0pt, fill: colors.dark-blue)[
    #if increment { slide-counter.step() }
    #text-frame(scaled(2.0cm), scaled(6.20cm), scaled(21.4cm), height: scaled(1.6cm), size: 17.28pt, fill: colors.white, weight: "bold", align-x: center, align-y: horizon)[#body]
  ]
}

#let neo-block(title, body) = {
  block(width: 100%)[
    #stack(
      dir: ttb,
      spacing: 0pt,
      rect(width: 100%, fill: colors.grey, stroke: none, inset: (x: 5pt, y: 0.44em))[
        #set text(font: fira-sans, size: 12pt, fill: colors.dark-blue, weight: "bold", features: fira-sans-features)
        #title
      ],
      rect(width: 100%, fill: colors.light-grey, stroke: none, inset: (x: 5pt, y: 0.38em))[
        #set text(font: fira-sans, size: 12pt, fill: colors.black, features: fira-sans-features)
        #body
      ],
    )
  ]
}

#let code-keywords(lang) = {
  if lang == "python" or lang == "py" {
    (
      "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
    )
  } else if lang == "c" or lang == "cpp" or lang == "c++" {
    (
      "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "_Bool", "_Complex", "_Imaginary",
    )
  } else if lang == "go" {
    (
      "break", "default", "func", "interface", "select", "case", "defer", "go", "map", "struct", "chan", "else", "goto", "package", "switch", "const", "fallthrough", "if", "range", "type", "continue", "for", "import", "return", "var",
    )
  } else if lang == "rust" or lang == "rs" {
    (
      "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn",
    )
  } else if lang == "haskell" or lang == "hs" {
    (
      "case", "class", "data", "default", "deriving", "do", "else", "foreign", "if", "import", "in", "infix", "infixl", "infixr", "instance", "let", "module", "newtype", "of", "then", "type", "where", "as", "hiding", "qualified", "Integer", "Int", "Bool", "Char", "String", "Maybe", "Either", "IO", "True", "False",
    )
  } else {
    none
  }
}

#let code-comment-fill = colors.dark-grey

#let code-line-comment-token(token, lang) = {
  if lang == "python" or lang == "py" {
    token.starts-with("#")
  } else if lang == "haskell" or lang == "hs" {
    token.starts-with("--")
  } else if lang == "c" or lang == "cpp" or lang == "c++" or lang == "go" or lang == "rust" or lang == "rs" {
    token.starts-with("//")
  } else {
    false
  }
}

#let code-block-comment-start(lang) = {
  if lang == "c" or lang == "cpp" or lang == "c++" or lang == "go" or lang == "rust" or lang == "rs" {
    "/*"
  } else if lang == "haskell" or lang == "hs" {
    "{-"
  } else {
    none
  }
}

#let code-block-comment-end(lang) = {
  if lang == "c" or lang == "cpp" or lang == "c++" or lang == "go" or lang == "rust" or lang == "rs" {
    "*/"
  } else if lang == "haskell" or lang == "hs" {
    "-}"
  } else {
    none
  }
}

#let code-string-token(token) = token.starts-with("\"") or token.starts-with("'")

#let code-token-pattern(lang) = {
  let line-comment = if lang == "python" or lang == "py" {
    "#.*|"
  } else if lang == "haskell" or lang == "hs" {
    "--.*|"
  } else if lang == "c" or lang == "cpp" or lang == "c++" or lang == "go" or lang == "rust" or lang == "rs" {
    "//.*|"
  } else {
    ""
  }
  let block-comment = if lang == "c" or lang == "cpp" or lang == "c++" or lang == "go" or lang == "rust" or lang == "rs" {
    "/\\*|\\*/|"
  } else if lang == "haskell" or lang == "hs" {
    "\\{-|-\\}|"
  } else {
    ""
  }
  regex("\"[^\"]*\"|'[^']*'|" + block-comment + line-comment + "\\w+|\\W")
}

#let render-comment-token(token) = {
  text(fill: code-comment-fill)[#raw(token)]
}

#let render-code-token(token, lang, keywords) = {
  if code-string-token(token) {
    text(fill: rgb("#2F7F68"))[#raw(token)]
  } else if keywords.contains(token) {
    text(fill: colors.dark-blue, weight: 500)[#raw(token)]
  } else {
    raw(token)
  }
}

#let render-code(source, lang, theme) = {
  let keywords = code-keywords(lang)
  if keywords == none {
    raw(source, block: true, lang: lang, theme: theme)
  } else {
    let lines = source.split("\n")
    let in-block-comment = false
    let block-start = code-block-comment-start(lang)
    let block-end = code-block-comment-end(lang)

    for (index, line) in lines.enumerate() {
      for token in line.matches(code-token-pattern(lang)) {
        let text = token.text
        if in-block-comment {
          render-comment-token(text)
          if block-end != none and text == block-end {
            in-block-comment = false
          }
        } else if block-start != none and text == block-start {
          render-comment-token(text)
          in-block-comment = true
        } else if code-line-comment-token(text, lang) {
          render-comment-token(text)
        } else {
          render-code-token(text, lang, keywords)
        }
      }
      if index < lines.len() - 1 { linebreak() }
    }
  }
}

#let neo-code(source, lang: none, theme: "themes/i4neo-relaxed.tmTheme", size: auto) = context {
  let code-source = if type(source) == content { source.text } else { source }
  let code-lang = if lang == none and type(source) == content { source.lang } else { lang }
  let inherited-size = text.size
  let effective-size = if size != auto {
    size
  } else if inherited-size == body-text-size {
    code-text-size
  } else {
    inherited-size
  }

  block(width: 100%)[
    #rect(width: 100%, fill: colors.light-grey, stroke: none, inset: (x: 0pt, y: 0.5em))[
      #set text(font: fira-mono, size: effective-size, fill: colors.black, features: fira-mono-features)
      #set par(leading: 0.65em, spacing: 0pt)
      #show raw: set text(font: fira-mono)
      #render-code(code-source, code-lang, theme)
    ]
  ]
}

#let small(body) = {
  set text(size: 10.95pt)
  body
}

#let deck(
  title: none,
  short-title: none,
  subtitle: none,
  date: auto,
  locale: "en",
  author: none,
  institute: none,
  footer: "author title",
  footer-style: "standout",
  numbering: "counter",
) = (
  title-slide: title-slide.with(title: title, subtitle: subtitle, date: date, locale: locale, author: author, institute: institute),
  slide: slide.with(author: author, short-title: short-title, footer: footer, footer-style: footer-style, numbering: numbering),
  section-slide: section-slide,
  standout: standout,
)

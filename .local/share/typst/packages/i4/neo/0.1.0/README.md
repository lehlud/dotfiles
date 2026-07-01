# i4neo Typst Theme

Local Typst package for the i4neo slide theme.

Use it with:

```typst
#import "@i4/neo:0.1.0": *
#show: setup.with(locale: "en")

#let slides = deck(
  title: [Talk title],
  short-title: [short],
  subtitle: [Subtitle],
  locale: "en",
  date: auto,
  author: [Author Name],
  institute: [Institute],
)

#(slides.title-slide)()
#(slides.slide)(title: [First slide])[
  Slide body.
]
```

If Fira Sans/Fira Mono are not installed system-wide, compile with:

```sh
typst compile --font-path ~/.local/share/typst/packages/i4/neo/0.1.0/fonts input.typ output.pdf
```

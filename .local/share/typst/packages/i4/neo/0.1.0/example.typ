#import "@i4/neo:0.1.0": *

#show: setup.with(locale: "en")

#let slides = deck(
  title: [i4 Vortragspräsentation],
  short-title: [i4talk],
  subtitle: [Untertitel],
  locale: "en",
  date: datetime(year: 2026, month: 6, day: 30),
  author: [Wolfgang Händler],
  institute: [Friedrich-Alexander-Universität Erlangen-Nürnberg],
)

#(slides.title-slide)(variant: "extern")
#(slides.slide)(title: [Code])[
  #neo-code(
    lang: "python",
    "def fib(n):\n    if n <= 1:\n        return n\n    return fib(n - 1) + fib(n - 2)",
  )
]

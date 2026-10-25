# Public writing

This extension supplies twenty local editorial rule groups for public prose in
README files, documentation, UI strings, articles and publication drafts. Operator
conversation, code syntax, test data, required quotations and unchanged wording are
outside its scope. Rules apply by meaning in every language.

The current instruction is inserted into each model request. It replaces obsolete
copies and survives context rotation or a projected history without the original
startup message. These temporary instructions are not saved to conversation history.
Goals and action permissions remain separate.

## Editing public prose

Before a public file write, edit, generator run or publication draft, the model gets
an instruction to perform a silent editing pass over the changed paragraphs. It
checks rhetorical contrasts, repetitive endings, staged introductions, inflated claims
and decorative formatting, then compares facts and qualifications with the source.
Measurements, failed tests, uncertainty and deployment restrictions must survive edits.
Clean wording should remain unchanged.

The contrast rule covers reversed constructions, separate sentences and clipped tails
such as “Results, not rhetoric.” Necessary warnings and factual corrections remain
valid. A warning that an export failed validation and must not be deployed is useful
technical information. Ordinary punctuation, a real three-item list or an adjective
alone does not establish a defect. The extension makes no AI-authorship claims.

The [quantization regression](tests/documentation-fixtures.ts) includes the reported
README excerpt and a revision preserving all measurements, the failed held-out quality
gate, its cause and the deployment restriction. It also covers useful negation,
warning emphasis, quotations and clipped contrasts in six languages.

Readability guidance favors short syntactic dependencies, explicit relationships,
familiar phrasing and enough explanation over dense shorthand. It permits useful
repetition and conventional technical terms. These recommendations adapt the English
analysis in [Clark, Martin and Mahowald (2026)](https://arxiv.org/html/2610.29162v1).
They are contextual guidance across languages, not a validated universal readability
score or a prescribed sentence length.

## Independent draft review

Ordinary action approval checks safety and user boundaries. It does not apply an
editorial veto to file edits. `writing_check` requests a separate semantic review of
an exact draft; use it for publication-ready chat drafts, explicit reviews or doubtful
file prose:

```json
{
  "tool": "writing_check",
  "arguments": {
    "text": "We repair bicycles. Open Tuesday–Saturday, 9 am–6 pm.",
    "audience": "public",
    "format": "plain"
  },
  "goal": "Review the public draft",
  "justification": "Check the wording before presenting it"
}
```

`text` accepts 1–20,000 characters. Optional `context` accepts up to 2,000 characters
of factual/publication context; formats are `plain`, `markdown` and `html`. Submit
coherent sections of longer documents. `audience: operator` applies to actual internal
communication; a publication draft cannot gain an exemption through that label.

The reviewer identifies wording and a focused correction. Revise findings and resubmit;
a valid denial does not select another reviewer. The receipt binds the exact-text SHA256
and rule version to its approval audit. It grants no writing or publication permission.
Self-editing and semantic review can still miss defects; neither is a deterministic
phrase detector or a guarantee about authorship.

## Sources

Rule version `2026-10-25.1` incorporates a review of these sources on October 25, 2026.
The original source links are preserved here:

- [marmbiz/humanizer-de](https://github.com/marmbiz/humanizer-de): version 5.28.2; proportional edits, factual preservation and false-positive controls.
- [blader/humanizer](https://github.com/blader/humanizer): version 3.1.0; structural framing, redundant closers and paragraph-level editing.
- [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
- [Wikipedia:Anzeichen für KI-generierte Inhalte](https://de.wikipedia.org/wiki/Wikipedia:Anzeichen_f%C3%BCr_KI-generierte_Inhalte).
- [Why is AI-generated language so hard to understand?](https://arxiv.org/abs/2610.29162), Clark, Martin and Mahowald, October 21, 2026.

The reviewed Wikipedia revisions were
[English 1381857286](https://en.wikipedia.org/w/index.php?oldid=1381857286&title=Wikipedia:Signs_of_AI_writing)
and [German 271259268](https://de.wikipedia.org/w/index.php?oldid=271259268&title=Wikipedia:Anzeichen_f%C3%BCr_KI-generierte_Inhalte).
The paper was [version 1](https://arxiv.org/html/2610.29162v1).

The rules are maintained locally. No source page or deleted skill is loaded at runtime.
The [architecture guide](../README.md) describes policy and execution boundaries.
Restart through `~/.local/bin/pi` to load changes. Native preparation fingerprints the
rule/tool sources; Docker deployments require a rebuilt image and updated digest.

## Validation

```sh
bun run check
bun test tests
bun tests/reviewer.eval.ts
bun tests/rewrite.eval.ts
```

The evaluation commands make paid calls to the configured reviewer. A case-name
argument filters the suite. It compares expected editorial decisions, including public
file/command approvals that must retain their safety-only scope; no proposed external
action executes. Reason-language compliance is not measured by this evaluation.
The SDK test uses a synthetic provider to verify instruction delivery across tool turns;
it does not measure prose quality. Live checks supply the semantic evidence separately.
`rewrite.eval.ts` revises the quantization excerpt and a dense technical passage,
checks required values, then submits each to a separate fact/style review.
It executes no file or publication action.

October 25 validation used `openai/gpt-6-luna (high)`. The automated gate suite passed
700 tests, and this extension passed seven tests. Both composition fixtures passed
separate fact/style reviews. A 47-case semantic sweep matched 46 expected decisions;
the remaining recipient instruction was clarified and passed a targeted check.
Earlier sweeps exposed false positives for useful warnings and harmless prose writes,
which informed the current scope rules. These checks do not establish human reading
performance or guarantee consistent reviewer judgments.

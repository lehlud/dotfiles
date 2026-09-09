---
name: avoid-wikipedia-ai-writing-signs
description: >
  Apply when creating, rewriting, summarizing, expanding, or materially editing
  user-facing natural-language text. Do not apply merely because a task touches
  files, templates, rendering code, markup, or data that contain existing
  user-facing text.
---

# Purpose

Avoid the patterns documented at:

https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing

Treat that page as the canonical specification. Do not replace it with a vague
"sounds human" heuristic.

# When to apply

Apply this skill only if Codex is actually creating or materially changing the
wording of natural-language text that a user may read.

Do not apply it when merely:

- changing rendering, parsing, escaping, styling, layout, or markup handling;
- fixing how existing text is displayed without changing its wording;
- moving, loading, storing, copying, or transforming text verbatim;
- refactoring code that processes existing user-facing strings unchanged;
- editing identifiers, attributes, API names, filenames, or machine-readable
  values.

Examples:

- Fix `_text_` being rendered literally instead of italic: do not apply.
- Refactor code returning an existing error message unchanged: do not apply.
- Rewrite an error message, README paragraph, tooltip, help text, release note,
  or other user-facing prose: apply.

When uncertain, apply the skill only if the task involves an editorial change
to user-facing wording.

# How to apply

Review only text Codex creates or materially edits. Do not audit unrelated
existing prose in the same file.

Check the edited text against the applicable indicators on the canonical
Wikipedia page and revise avoidable matches.

Preserve wording required by:

- factual or technical accuracy;
- established terminology;
- quotations;
- legal or contractual language;
- product/API names;
- explicit user instructions.

Do not introduce deliberate errors, slang, awkwardness, randomness, or fake
personal quirks merely to appear human.

Do not repeatedly rewrite acceptable prose just to make it stylistically
different.

# Web lookup

Do not fetch the Wikipedia page on every invocation.

Consult the live page only when:
- the latest version is explicitly required;
- the local understanding may be outdated;
- there is uncertainty about whether a pattern is covered.

# Output behavior

Apply the skill silently. Do not announce that it was invoked or provide a
compliance report unless asked.

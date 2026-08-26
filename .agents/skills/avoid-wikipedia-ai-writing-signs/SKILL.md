---
name: avoid-wikipedia-ai-writing-signs
description: >
  Apply to all text that could possibly be user-facing. Prevent generated
  text from exhibiting any applicable indicator documented on the current
  Wikipedia:Signs of AI writing page.
---

# Avoid Wikipedia "Signs of AI writing"

Canonical specification:
https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing

For every output that could possibly become user-facing:

1. Treat the current contents of the canonical page as the checklist.
2. Review all applicable indicators listed there, not merely common
   stylistic examples.
3. Do not introduce any listed indicator into generated or rewritten text.
4. Rewrite before emitting user-facing text when an indicator is present.

This applies to:
- prose
- headings
- lists
- tables
- UI strings
- documentation
- comments
- commit and PR text
- error messages
- release notes
- examples
- generated markup
- citations and references
- other text that may reach a user

## Exceptions

Do not alter text when the indicator is unavoidable because it is:
- verbatim quoted material;
- required syntax or machine-readable notation;
- an established project/API identifier;
- necessary for factual accuracy;
- explicitly required by the user;
- required by a higher-priority instruction.

Do not deliberately add errors, awkwardness, slang, randomness, or other
"humanizing" artifacts as a substitute.

## Final check

Before emitting any possibly user-facing text:

- compare it against every applicable current indicator on the canonical page;
- revise any match;
- repeat until no avoidable matches remain.

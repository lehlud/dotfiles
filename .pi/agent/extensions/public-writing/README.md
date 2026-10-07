# Review Public Writing

This Pi extension replaces the `avoid-wikipedia-ai-writing-signs` skill. Fourteen locally stored rule groups cover invented contrasts, unsupported claims of importance, vague sources, promotional language, formulaic conclusions and assistant residue in published text. The source is [this Wikipedia revision](https://en.wikipedia.org/w/index.php?oldid=1378298730&title=Wikipedia:Signs_of_AI_writing), consulted once on October 5, 2026. Wikipedia is not fetched at runtime.

The existing independent reviewer assesses patterns in context and in the original language. There are no per-language word lists or regular expressions. Review applies to newly authored or materially reworded prose for website/app visitors, public articles, documentation and publication drafts, including prose inside source code, templates and localization files. Ordinary replies to the Pi operator, code syntax, non-publication data and unchanged existing wording are exempt. Necessary technical contrasts, names, required quotations and explicit operator style instructions remain intact. These are editorial rules, not evidence of AI authorship.

The extension gives the working model fixed instructions to apply these rules while composing public text. When saving text, the existing action reviewer also checks its changed wording; the same write needs no additional style call. For public drafts delivered in chat and reviews without saving, `approved_action` provides `writing_check`:

```json
{
  "tool": "writing_check",
  "arguments": {
    "text": "We repair bicycles. Open Tuesday through Saturday, 9 am–6 pm.",
    "audience": "public",
    "format": "plain",
    "context": "Visitor copy for a bicycle repair shop website."
  },
  "goal": "Review the public draft",
  "justification": "Check the new wording before saving it."
}
```

`text` allows 1–20,000 characters; `context` allows up to 2,000. `format` can be `plain`, `markdown` or `html`. Review coherent sections of longer publications separately. `audience: "operator"` labels internal communication only. Actual user intent determines scope; a false label creates no exemption.

A denial identifies offending wording and a focused correction. The working model revises the text and submits a new request. A valid denial never tries another reviewer. Approval produces an offline receipt containing the exact text's SHA256 and rule version; the receipt is valid only with its corresponding approval audit. The executor makes no second model call. Style approval authorizes neither writing nor publication.

Ordinary write, edit and shell requests that change public wording use the same rules in their action review. Rules apply independently of `/goal`; goal completion review remains unchanged. For publication drafts in chat, preflight review is an instruction to the working model, not a postprocessing filter on every chat message. Semantic review can misclassify or miss wording.

The `~/.local/bin/pi` launcher loads this extension with the approval gate and web research. Restart loads changes. Native executor preparation tracks rule, tool and dependency changes. Docker backend changes require rebuilding its image and configuring a new digest.

```bash
bun run check
bun test tests/extension.test.ts
bun tests/reviewer.eval.ts
```

The last command uses configured reviewers and makes paid model requests. It tests six languages, necessary contrasts, quotations, internal communication, mislabeled drafts, public file/shell writes, visitor copy inside source code, layout-only changes and negative test data. It executes no proposed writes or shell actions. An optional argument filters case names, for example `bun tests/reviewer.eval.ts 'public UI prose'`.

Historical validation on October 5, 2026: 164 automated checks passed, including real bwrap isolation, along with 19 distinct semantic cases using the configured reviewer. Three additional complete gate/executor calls confirmed denial, a style receipt and the operator exemption. The real Pi resource loader loaded all three extensions present at that time without the replaced skill. All three TypeScript checks, shell syntax and diff checks passed. Docker was not tested live.

Semantic verdicts were checked; explanation language was not enforced as a pass criterion in that historical run. Isolated fixtures sometimes received English explanations despite German operator instructions; all three complete gate-test explanations were German. The language requirement is also present in policy and the OpenAI output schema but was not reliably enforced in every isolated case. This concerns explanation language, not translation of reviewed drafts.

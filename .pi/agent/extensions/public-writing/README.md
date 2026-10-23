# Public writing

Fourteen frozen rule groups replace the deleted `avoid-wikipedia-ai-writing-signs`
skill. They cover invented contrasts, inflated importance, vague sources, promotional
language, stock conclusions and assistant residue. Source:
[Wikipedia revision 1378298730](https://en.wikipedia.org/w/index.php?oldid=1378298730&title=Wikipedia:Signs_of_AI_writing),
consulted October 5, 2026; no runtime fetch. See the [architecture guide](../README.md).

Apply these contextual rules in every language to newly authored/materially reworded
public prose: visitor UI copy, articles, documentation and publication drafts, including
strings in source/templates/localizations. Operator replies, syntax, non-publication
data and unchanged wording are exempt. Preserve necessary contrasts, names, required
quotes and explicit user style. No word-list/regex detector or AI-authorship claim is used.

The working model receives standing composition guidance, independent of `/goal`.
Ordinary file/command approvals check safety and user boundaries without the editorial
rulebook. For public chat drafts or reviews without saving, use:

```json
{
  "tool": "writing_check",
  "arguments": {
    "text": "We repair bicycles. Open Tuesday–Saturday, 9 am–6 pm.",
    "audience": "public",
    "format": "plain",
    "context": "Visitor copy for a repair shop."
  },
  "goal": "Review the public draft",
  "justification": "Check the wording before presenting it"
}
```

`text`: 1–20,000 characters; optional `context`: up to 2,000. Formats: `plain`,
`markdown`, `html`. Split longer publications into coherent sections. `audience: operator`
is only for actual internal communication; false labels do not exempt public text.
Denials identify wording and a focused fix: revise and resubmit, never try another
reviewer after a valid denial. The offline receipt binds exact-text SHA256 and rule
version to its approval audit; the executor makes no second call. Style approval grants
no writing/publication permission. This is model guidance, not a chat postprocessing
filter; semantic reviews can miss or misclassify wording.

Restart through `~/.local/bin/pi` loads changes. Native preparation fingerprints
rules/tools/dependencies; Docker needs an image rebuild and new digest.

```sh
bun run check
bun test tests/extension.test.ts
bun tests/reviewer.eval.ts
```

The last command is paid, review-only, using the configured reviewer. It covers six
languages, necessary contrasts/quotes, operator/mislabeled drafts, public source prose,
file/shell writes, layout changes and negative fixtures. A name argument filters cases;
no proposed write/command executes.

Historical validation (October 5, 2026): 164 automated checks, real bwrap isolation,
19 semantic cases and three full gate/executor calls (denial, receipt, operator exemption)
passed, as did resource loading, type/shell/diff checks. Docker was not live-tested.
Verdict semantics were checked; reason language was not a pass criterion and isolated
fixtures sometimes used English despite German instructions. The three complete calls
used German. Policy/schema require the operator's language, but that run did not prove
reliable language compliance. Drafts are not translated for review.

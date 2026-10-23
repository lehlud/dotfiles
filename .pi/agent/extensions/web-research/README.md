# Web research

This extension replaces the deleted `web-research` skill. The launcher loads it with
Auto-Approval; every search/fetch receives independent review before network access.
See the [architecture guide](../README.md).

| Operation   | Arguments                                                                                           | Output                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `websearch` | `query`; optional `maxResults` (default 5, maximum 10), `region` (`wt-wt`), `timeLimit` (`d/w/m/y`) | [DDGS](https://github.com/deedy5/ddgs) titles, URLs and snippets                              |
| `webfetch`  | `url`; optional `maxChars` (default 20,000; 100–80,000), `offset`                                   | [Trafilatura](https://trafilatura.readthedocs.io/en/latest/usage-python.html) plain page text |

```json
{
  "tool": "webfetch",
  "arguments": { "url": "https://docs.python.org/3/library/asyncio-task.html" },
  "goal": "Understand TaskGroup",
  "justification": "Read current primary documentation"
}
```

Queries go to DDGS's public providers; never include private data. Fetch returns only
text, without tags, scripts, navigation or footers. Source/approval/continuation details
stay in the log/result metadata: `finalUrl`, `totalChars`, `hasMore`, `nextOffset`.
Use `offset` for later sections. Long results collapse; Ctrl+O expands them. Approval
adds no duplicate block above the prompt.

Fetch uses public HTTP(S) GET without credentials, cookies or custom headers. Each
redirect/IP is validated; connections pin the validated address. Private/local IPs,
JavaScript execution and binary/PDF extraction are unavailable. Downloads stop at 2 MB;
HTTP/unreadable-content failures are errors.

Web workers use an empty read-only `/workspace`, not project/home files or legacy
skills. Extra file/PATH/local-tool grants are rejected. Session-private `/tmp` remains,
with forbidden-hardlink checks and exit/replacement cleanup. Public-writing policy
comes from its extension, without the deleted Wikipedia skill.

Operator startup installs pinned JS dependencies and Python wheels via Linux
`/usr/bin/python3`; the cache is keyed by platform/architecture/Python/requirements.
Only dependencies, public CAs and worker code mount read-only; models cannot install
worker dependencies. Docker requires rebuilding `auto-approval/Dockerfile` with the
extensions directory as context and configuring its digest; native bwrap uses the cache.

Checks: `bun test tests`, `bun node_modules/typescript/bin/tsc --noEmit`, and
`python3 -m unittest discover -s tests -p 'test_*.py'` (prepared runtime required).
Ordinary tests are offline.

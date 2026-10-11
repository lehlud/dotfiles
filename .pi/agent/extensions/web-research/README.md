# Web Research for Pi

For module ownership, lifecycle and development checks, see the [architecture guide](../README.md).

This extension replaces the former `web-research` skill. The launcher loads it alongside Auto-Approval. The model uses operations through `approved_action`; search and page fetch receive network access only after independent review. Direct tools and alternative execution paths remain blocked.

Web actions run in an empty, read-only `/workspace`. Project and home files are neither mounted nor scanned. A missing legacy skill or a problematic project reference therefore cannot block web search. Additional file, PATH and local-tool permissions are not supported for web actions and are rejected. Private session `/tmp` remains available and is checked for forbidden hardlinks. Static public-writing guidance comes from its own extension; the deleted Wikipedia skill is not needed.

`websearch` uses [DDGS](https://github.com/deedy5/ddgs) and returns a title, URL and short text for each result. The default is five results, with a maximum of ten. Optional fields are `region` (default `wt-wt`) and `timeLimit` (`d`, `w`, `m`, `y`). DDGS may use multiple public search providers; the query is sent to those providers.

```json
{
  "tool": "websearch",
  "arguments": { "query": "site:docs.python.org asyncio TaskGroup", "maxResults": 5 },
  "goal": "Find official documentation",
  "justification": "Check the API against current primary sources"
}
```

`webfetch` reads a single public HTTP(S) URL. [Trafilatura](https://trafilatura.readthedocs.io/en/latest/usage-python.html) extracts readable text and removes HTML tags, scripts, navigation and footers. The model receives only page text. Approval, source URL and continuation metadata remain in result details and the activity log.

```json
{
  "tool": "webfetch",
  "arguments": {
    "url": "https://docs.python.org/3/library/asyncio-task.html",
    "maxChars": 20000,
    "offset": 0
  },
  "goal": "Understand TaskGroup",
  "justification": "Read the official documentation found by search"
}
```

The default is 20,000 characters; `maxChars` allows 100–80,000 characters. `offset` reads a later section. Result details contain `finalUrl`, `totalChars`, `hasMore` and `nextOffset`. Long results start collapsed; `ctrl+o` shows the full section. Approvals appear in the activity log without an additional block above the input prompt.

Page fetches are GET requests without cookies, credentials or custom headers. Every redirect is checked. Local and private IP addresses are rejected; connections use the previously validated IP address. Downloads are limited to 2 MB. JavaScript pages are not executed; PDFs and other binary formats are not extracted. HTTP failures and unreadable content are reported as errors.

At operator startup, `bootstrap.ts` installs pinned JavaScript dependencies and `setup.py` uses `/usr/bin/python3` to install pinned Python wheels. Setup and sandbox use the same Linux interpreter; shared macOS launchers are not used. The Python cache is scoped by Linux platform, architecture, Python version and requirements. The sandbox mounts only these dependencies and the worker read-only. HTTPS verifies server certificates against the bundled public CA collection. Model tools cannot install dependencies. Session data stays in private `/tmp` and is deleted on session exit or replacement.

For Docker, rebuild the executor image with `~/.pi/agent/extensions` as the build context and `auto-approval/Dockerfile` as its Dockerfile, then configure its digest outside Pi. Python and web dependencies are included in the image. Native Lubox/bwrap uses the prepared Linux cache.

Validation: `bun test tests`, `bun node_modules/typescript/bin/tsc --noEmit` and `python3 -m unittest discover -s tests -p 'test_*.py'`. Python tests require the prepared runtime cache. Ordinary tests do not contact external websites.

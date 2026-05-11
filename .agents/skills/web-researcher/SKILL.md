---
name: web-research
description: Use when a task requires current, external, niche, legal/regulatory, product, pricing, documentation, vulnerability, API, package, or news information. Search the web, fetch primary sources, cross-check claims, and return cited findings.
---

# Web Research Skill

Use this skill when the answer may depend on information outside the model's training data or local repository.

## Trigger conditions

Use web research when the task involves:

- current or recently changed information
- library, framework, API, package, release, or changelog details
- security advisories, CVEs, vulnerabilities, licenses, compliance, laws, or standards
- prices, products, vendors, SaaS plans, availability, schedules, events, or roadmaps
- docs for a technology not already present in the repo
- any unfamiliar term, tool, company, repo, package, or acronym
- user asks to verify, cite, source, compare, or “look up” something

## Research workflow

1. Start with `websearch` for discovery unless the user gave a specific URL.
2. Prefer primary sources:
   - official documentation
   - project repositories
   - release notes
   - standards bodies
   - vendor docs
   - government/regulatory pages
   - maintainer announcements
3. Use `webfetch` for specific URLs, especially primary sources found through search.
4. Cross-check important claims with at least two independent sources when the claim is consequential or disputed.
5. Do not rely on SEO blogs when primary docs exist.
6. Record source titles, URLs, dates, and the claim each source supports.
7. Flag uncertainty explicitly if sources conflict or if a source is stale.

## Output format

Return:

- direct answer first
- key evidence with source attribution
- caveats or conflicts
- recommended next action when relevant

## Safety and quality rules

- Never fabricate citations or source details.
- Do not treat snippets alone as authoritative when the underlying page can be fetched.
- For code/API answers, check official docs or the upstream repository.
- For security/legal/financial/medical topics, prefer authoritative sources and include caveats.
- For local/private projects, do not send secrets, proprietary code, tokens, or internal URLs into web queries.

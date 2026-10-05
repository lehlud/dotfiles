// Frozen editorial guidance; no runtime fetches or language-specific word lists.
export const RULE_SOURCE = {
  url: "https://en.wikipedia.org/w/index.php?oldid=1378298730&title=Wikipedia:Signs_of_AI_writing",
  consulted: "2026-10-05", version: "2026-10-05.1",
};
export const WRITING_RULES = [
  ["invented-contrast", "Prefer affirmative claims over invented negative contrasts."],
  ["decorative-reversal", "Avoid ornamental not-only/but-also phrasing and repeated reversals."],
  ["slogan-rhythm", "Avoid repetitive triads and slogan-shaped sentence rhythms."],
  ["inflated-importance", "Replace unsupported grandeur with concrete, checkable detail."],
  ["speculative-meaning", "Remove speculative symbolism, significance and sweeping associations."],
  ["vague-sources", "Name supporting sources; do not invent unnamed experts or consensus."],
  ["hollow-praise", "Replace hollow superlatives with factual benefits."],
  ["stock-language", "Avoid clustered fashionable abstractions and canned transitions."],
  ["inflated-verbs", "Prefer direct verbs to inflated circumlocutions."],
  ["template-endings", "Skip generic future/challenge sections and recap endings."],
  ["assistant-residue", "Keep assistant chatter, caveats and placeholder prose out of publications."],
  ["decorative-formatting", "Use emphasis, dashes, emoji, headings and tables purposefully."],
  ["reference-debris", "Remove fabricated references, broken citations and model markup."],
  ["register-drift", "Keep terminology and register consistent; do not shuffle synonyms needlessly."],
] as const;
export const WRITING_RULEBOOK = WRITING_RULES.map(([id, rule]) => `${id}: ${rule}`).join("\n");

export const PUBLIC_WRITING_SCOPE = `Apply these editorial rules ONLY to newly authored or materially reworded natural-language prose intended for publication or an outside audience: website/app visitor copy, public articles, posts, documentation, announcements and publication-ready drafts, including drafts delivered in chat. The operator sending prompts is NOT that audience. Exclude direct replies/status/explanations to the operator, code syntax/identifiers, non-prose data, and existing wording merely copied, rendered, moved or left unchanged. Visitor-facing prose inside source strings, templates or localization data remains in scope; code syntax around it creates no exception. Infer audience and editorial scope from actual operator intent and the exact change, not filenames or agent labels alone.
Rules are semantic and apply in EVERY language, including non-Latin scripts. Recognize equivalent constructions in the original language; never rely on English/German vocabulary lists or translate the text just to check it. For example, gratuitous "not X, but Y" framing includes "das ist nicht X, das ist Y" and corresponding rhetoric in other languages. Preserve the original language, facts, technical distinctions, terminology, names, required quotations, legal wording and explicit operator style instructions. A pattern is a contextual editorial hint, not proof of AI authorship. Do not ban punctuation, ordinary adjectives, useful lists or necessary contrasts categorically. Do not add fake quirks or errors. Do not rewrite acceptable prose merely for variation. No Wikipedia lookup is needed; use the frozen rules below.`;

export const PUBLIC_WRITING_GATE = `${PUBLIC_WRITING_SCOPE}
${WRITING_RULEBOOK}
For writing_check with audience public, inspect the submitted draft itself and return deny for a concrete avoidable violation, identifying the offending wording and a focused correction in reason. Return approve when no actionable violation remains; this certifies only that exact draft, not a future write or publication. For audience operator, skip stylistic checking unless actual operator intent shows the label hides a publication draft; ask for a correct public label in that case. A deny reason for writing_check reports the completed editorial review's findings, never an invitation to try another reviewer.
For writes/edits/shell actions actually authoring or materially changing public prose, perform this contextual style check as part of the action review. Deny clearly avoidable violations in the changed wording and request a focused rewrite. Never extend the check to unrelated existing text or demand a style check for a code/layout-only change. For read/search/test and other non-editorial actions, these rules impose no extra prerequisite. Previous style findings are not permanent bans: a corrected draft may be approved on a new exact request. All normal authorization, sandbox and final-denial rules still apply. The JSON reason MUST use the latest actual operator prompt's language; quote offending draft words in their original language inside that reason. The draft's language and these English policy definitions do not set the reason's language.`;

export const PUBLIC_WRITING_INSTRUCTION = `${PUBLIC_WRITING_SCOPE}
${WRITING_RULEBOOK}
Apply these rules while composing public prose in every session, independently of /goal. The mandatory approval review of a write/edit/inline generator already checks its exact public wording; no separate writing_check is needed for that same mutation. Before presenting a publication-ready draft in chat, or to review a draft without saving it, submit only the authored/changed prose to approved_action with tool writing_check, arguments {text, audience:"public", format:"plain"|"markdown"|"html"}, goal and justification. Optional context describes the intended publication and necessary factual wording. If the reviewer identifies an avoidable pattern, revise and check the revised text. Do not call this tool for ordinary conversation with the operator. Do not audit an entire old file when only a small prose fragment changed. Style approval never authorizes writing, publishing or bypassing another action review. Apply silently; provide no unsolicited compliance report.`;

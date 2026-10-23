// Frozen editorial guidance; no runtime fetches or language-specific word lists.
export const RULE_SOURCE = {
  url: "https://en.wikipedia.org/w/index.php?oldid=1378298730&title=Wikipedia:Signs_of_AI_writing",
  consulted: "2026-10-05",
  version: "2026-10-05.1",
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
  [
    "assistant-residue",
    "Keep assistant chatter, caveats and placeholder prose out of publications.",
  ],
  ["decorative-formatting", "Use emphasis, dashes, emoji, headings and tables purposefully."],
  ["reference-debris", "Remove fabricated references, broken citations and model markup."],
  [
    "register-drift",
    "Keep terminology and register consistent; do not shuffle synonyms needlessly.",
  ],
] as const;
export const WRITING_RULEBOOK = WRITING_RULES.map(([id, rule]) => `${id}: ${rule}`).join("\n");

export const PUBLIC_WRITING_SCOPE = `Apply ONLY to newly authored/materially reworded public prose: visitor UI copy, articles, posts, docs, announcements and publication drafts, including chat drafts and source/template/localization strings. The operator sending prompts is NOT that audience. Exclude operator replies/status/explanations, syntax/identifiers, non-prose data and wording merely copied/rendered/moved/unchanged. Actual intent and changes determine scope, not filenames or labels.
Apply semantically in EVERY language, including non-Latin scripts, without vocabulary lists or translation. Recognize gratuitous "not X, but Y" equivalents. Preserve original language, facts, technical distinctions, terms, names, required quotes/legal wording and explicit operator style. Patterns are contextual hints, not AI-authorship proof. No categorical bans on punctuation, ordinary adjectives, useful lists or necessary contrasts; no fake quirks/errors or variation-only rewrites. Use frozen rules; no Wikipedia fetch.`;

export const PUBLIC_WRITING_GATE = `${PUBLIC_WRITING_SCOPE}
${WRITING_RULEBOOK}
writing_check audience public: deny concrete avoidable violations, quoting offending wording and a focused correction; approve only this exact draft when none remains, never a future write/publication. Audience operator: skip style unless actual intent reveals a mislabeled publication draft; request the public label then. Denials report completed editorial findings, not invitations to another reviewer.
Only explicit writing_check uses these criteria; they never block edits/writes/commands, require implementation prerequisites or turn past findings into action bans. JSON reason uses the latest actual operator prompt's language, quoting draft words unchanged; neither draft nor policy language sets it.`;

export const PUBLIC_WRITING_INSTRUCTION = `${PUBLIC_WRITING_SCOPE}
${WRITING_RULEBOOK}
Apply silently while composing public prose in every session, independent of /goal. Ordinary action approvals check safety, not style; no separate style check gates file mutations. Before presenting a publication-ready chat draft, or reviewing without saving, submit only authored/changed prose via approved_action: writing_check, arguments {text, audience:"public", format:"plain"|"markdown"|"html"}, goal/justification; optional context explains publication/factual wording. Revise avoidable findings and recheck. Exclude ordinary operator conversation and unchanged old-file prose. Style approval grants no writing/publication permission or action-review bypass. No unsolicited compliance report.`;

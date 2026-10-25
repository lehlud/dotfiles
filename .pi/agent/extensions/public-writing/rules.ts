// Locally maintained editorial guidance; no runtime fetches or vocabulary detectors.
export const RULE_SOURCE = {
  url: "https://en.wikipedia.org/w/index.php?oldid=1381857286&title=Wikipedia:Signs_of_AI_writing",
  consulted: "2026-10-25",
  version: "2026-10-25.1",
  references: [
    "https://github.com/marmbiz/humanizer-de",
    "https://github.com/blader/humanizer",
    "https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing",
    "https://de.wikipedia.org/wiki/Wikipedia:Anzeichen_f%C3%BCr_KI-generierte_Inhalte",
    "https://arxiv.org/abs/2610.29162",
  ],
  snapshots: [
    "https://github.com/blader/humanizer/blob/main/SKILL.md",
    "https://github.com/marmbiz/humanizer-de/blob/main/SKILL.md",
    "https://en.wikipedia.org/w/index.php?oldid=1381857286&title=Wikipedia:Signs_of_AI_writing",
    "https://de.wikipedia.org/w/index.php?oldid=271259268&title=Wikipedia:Anzeichen_f%C3%BCr_KI-generierte_Inhalte",
    "https://arxiv.org/html/2610.29162v1",
  ],
};
export const WRITING_RULES = [
  [
    "invented-contrast",
    "State the actual claim. Remove an unneeded foil in 'not X but Y', 'X, not Y', 'Y rather than X', split-sentence contrasts and clipped negative tails. Keep necessary factual distinctions and warnings.",
  ],
  [
    "decorative-reversal",
    "Remove not-only/but-also escalation and invented objections that add emphasis without information. A claimed misconception needs actual context.",
  ],
  [
    "slogan-rhythm",
    "Avoid forced triads, stacked fragments and repeated sentence openings across paragraphs. Keep real lists and the author's natural voice; do not manufacture unevenness.",
  ],
  ["inflated-importance", "Replace unsupported grandeur with concrete, checkable detail."],
  [
    "speculative-meaning",
    "Remove unsupported meaning, symbolism, causality and sweeping associations.",
  ],
  ["vague-sources", "Name supporting sources; do not invent unnamed experts or consensus."],
  ["hollow-praise", "Replace hollow superlatives with factual benefits."],
  [
    "stock-language",
    "Replace clustered abstractions and mechanical transitions with the specific point. An ordinary word alone is not a finding.",
  ],
  ["inflated-verbs", "Prefer direct verbs to inflated circumlocutions."],
  [
    "template-endings",
    "Omit generic challenge/future sections, recap endings and repeated summaries that add no useful fact.",
  ],
  [
    "assistant-residue",
    "Remove chat wrappers, drafting commentary, model-knowledge disclaimers and placeholders. Keep factual limitations that affect the reader's decisions.",
  ],
  [
    "decorative-formatting",
    "Use plain body text by default, including measurements. Remove ornamental bold labels, headings and punctuation clusters. Keep formatting that supports navigation or a real warning.",
  ],
  ["reference-debris", "Remove fabricated references, broken citations and model markup."],
  [
    "register-drift",
    "Keep terminology and register consistent; do not shuffle synonyms needlessly.",
  ],
  [
    "staged-framing",
    "Start with the point. Remove ceremonial run-ups, fake questions, staged candor and aphorisms that merely announce importance.",
  ],
  [
    "repeated-closers",
    "Cut a punchline or one-line closer that restates the preceding evidence. Integrate a real consequence into the explanation instead of staging it as a revelation.",
  ],
  [
    "fabricated-voice",
    "Preserve uncertainty and the writer's perspective. Never invent experience, anecdotes, reactions, sources or confidence to make prose sound human.",
  ],
  [
    "syntactic-load",
    "Keep subjects, verbs and referents close. Unpack nested clauses and noun stacks; restore omitted connecting or relative words when they resolve ambiguity.",
  ],
  [
    "familiar-phrasing",
    "Use familiar combinations and ordinary verbs. Avoid ad-hoc noun-to-verb conversions or abstract agents that obscure actions; keep conventional technical terms.",
  ],
  [
    "reader-context",
    "Give the intended reader enough explanation instead of maximizing information density. Define unfamiliar terms and preserve useful repetition; impose no token or sentence-length target.",
  ],
] as const;
export const WRITING_RULEBOOK = WRITING_RULES.map(([id, rule]) => `- ${id}: ${rule}`).join("\n");

export const PUBLIC_WRITING_SCOPE = `Apply ONLY to newly authored/materially reworded public prose: README/docs, visitor UI, articles, posts, announcements and publication drafts, including source/template/localization strings. The operator sending prompts is NOT that audience. Exclude operator replies, syntax/identifiers, non-prose data and unchanged/copied/moved wording. Documentation may directly instruct its readers, including software operators; naming that role does not make a manual private chat. Scope follows intent, not a filename or label.
Apply semantically in EVERY language, including non-Latin scripts, without vocabulary lists or translation. Judge sentences and paragraph structure in context. Preserve facts, numbers/units, names, technical distinctions, uncertainty, necessary warnings, required quotes/legal wording and explicit user style. A clear rhetorical defect can justify an edit; weak signals such as one dash or adjective need a pattern. No AI-authorship claims, punctuation bans, invented personality or variation-only rewrites. Use local rules; no runtime fetch.`;

export const PUBLIC_WRITING_EDIT_PASS = `Before writing/editing/generating public prose in files or presenting a publication draft, silently reread the changed paragraphs as an editor. Remove avoidable framing, redundant closers and decoration; rewrite around the substantive point, not by swapping flagged words. Check whether a reader can follow actors, actions and references without unpacking compressed shorthand. Then compare with the source for lost/added claims, every measurement and qualification, especially failed tests and deployment limits. Leave clean prose alone. Check the final wording once more for surviving contrasts and staged endings; give only the requested result.
Examples with unchanged facts: "These artifacts are experimental, not deployment-qualified." -> "These experimental artifacts lack deployment qualification." "Jobs retry twice. No magic. Just reliability." -> "Jobs retry twice." Keep "The exports failed validation and must not be deployed" and a factual distinction such as transport encryption versus encryption at rest. Never remove a warning merely because it contains a negation.`;

export const PUBLIC_WRITING_GATE = `${PUBLIC_WRITING_SCOPE}
${WRITING_RULEBOOK}
writing_check audience public: read the complete supplied prose in paragraph context, including formatting. Deny concrete avoidable violations, quoting offending wording and a focused correction that preserves substantive facts and warnings. Inspect clipped contrasts, split-sentence reversals, redundant closers and decorative emphasis even in technical README prose. Necessary negation or a useful qualification is allowed. Neutral documentation permits direct instructions and imperatives, including bold safety warnings such as "Do not deploy these exports"; do not demand declarative phrasing. Review this passage's style, without demanding new facts, extra document sections or additional validation. Report lost facts only against an actual supplied source. Approve only this exact draft when no actionable defect remains, never a future write/publication. Audience operator: skip style unless intent reveals a mislabeled publication draft; request the public label then. Denials report editorial findings, not invitations to another reviewer.
Only explicit writing_check uses these criteria; they never block edits/writes/commands, require implementation prerequisites or turn past findings into action bans. JSON reason uses the latest actual operator prompt's language, quoting draft words unchanged; neither draft nor policy language sets it.`;

export const PUBLIC_WRITING_INSTRUCTION = `${PUBLIC_WRITING_SCOPE}
${WRITING_RULEBOOK}
${PUBLIC_WRITING_EDIT_PASS}
Apply in every session, independent of /goal. Ordinary action approvals assess safety; file mutations require no separate style clearance. Use approved_action: writing_check for a publication-ready chat draft, an explicitly requested review or a doubtful file-prose draft: arguments {text, audience:"public", format:"plain"|"markdown"|"html"}, goal/justification and optional factual/publication context. Submit changed prose, revise avoidable findings and recheck; exclude operator conversation and unchanged old-file text. A style receipt grants no writing/publication permission or action-review bypass. No unsolicited compliance report.`;

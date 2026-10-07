export const MAX_REVIEW_CONTEXT_BYTES = 1048576;
export const MAX_REVIEW_EVIDENCE_BYTES = 95000;
export const REVIEW_OUTPUT_TOKENS = 4096;
export const MAX_EXECUTOR_REQUEST_BYTES = 100000;

export function checkActionSize(action: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(action));
  if (bytes > MAX_EXECUTOR_REQUEST_BYTES) throw new Error(`Action exceeds executor request limit: ${bytes}/${MAX_EXECUTOR_REQUEST_BYTES} UTF-8 bytes. Split the current action. Nothing was truncated.`);
}

export function checkReviewSize(data: Record<string, unknown>): string {
  const text = JSON.stringify(data);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_REVIEW_CONTEXT_BYTES) {
    const sizes = ["userPrompts", "latestUserPrompt", "operatorGoal", "action", "sandboxPlan", "previousDenials"].map((key) => `${key}=${Buffer.byteLength(JSON.stringify(data[key]) ?? "")} bytes`).join(", ");
    throw new Error(`Review preparation limit exceeded: ${bytes}/${MAX_REVIEW_CONTEXT_BYTES} UTF-8 bytes (${sizes}). Nothing was truncated. Splitting the current action cannot reduce accumulated operator context.`);
  }
  return text;
}

export function reviewLanguageReference(prompt: string): string {
  const prose = prompt.replace(/```[\s\S]*?```|`[^`\n]*`/g, " ").replace(/^\s*>.*$/gm, " ");
  const parts: string[] = [];
  let copied = 0;
  for (let start = 0; start < prose.length; start++) {
    if (prose[start] !== "{" && prose[start] !== "[") continue;
    const stack: string[] = [];
    let quoted = false, escaped = false;
    let end = start;
    for (; end < prose.length; end++) {
      const char = prose[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) break;
        if (!stack.length) break;
      }
    }
    if (end >= prose.length || stack.length) continue;
    try { JSON.parse(prose.slice(start, end + 1)); } catch { continue; }
    parts.push(prose.slice(copied, start)); copied = end + 1; start = end;
  }
  parts.push(prose.slice(copied));
  const reference = parts.join(" ").trim();
  if (!reference) return "[No unquoted operator prose; use the full latestUserPrompt to determine language if possible.]";
  return reference.length <= 2048 ? reference : `${reference.slice(0, 1024)}\n[Language sample shortened; full constraints remain in latestUserPrompt.]\n${reference.slice(-1024)}`;
}

export function reviewCapacityIssue(context: { systemPrompt?: string; messages: { content: unknown }[]; tools?: unknown[] }, model: { contextWindow: number; maxTokens: number }): string | undefined {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens < REVIEW_OUTPUT_TOKENS) return "Reviewer context/output capacity unavailable";
  const texts = [context.systemPrompt ?? "", JSON.stringify(context.tools ?? []), ...context.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))];
  // Estimate ASCII JSON at three bytes per token; count non-ASCII byte by byte.
  // The provider enforces the actual token limit; all messages are sent in full.
  const estimatedInput = texts.reduce((sum, text) => {
    const asciiBytes = text.match(/[\x00-\x7f]/g)?.length ?? 0;
    return sum + Math.ceil(asciiBytes / 3) + Buffer.byteLength(text) - asciiBytes;
  }, 0);
  const estimatedTokens = estimatedInput + REVIEW_OUTPUT_TOKENS + 2048;
  if (estimatedTokens > model.contextWindow) return `Reviewer context capacity unavailable: estimated ${estimatedTokens} tokens including output/framing reserve, model window ${model.contextWindow}; operator context and action were not truncated`;
}

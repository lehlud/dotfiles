import type { AssistantMessage } from "@earendil-works/pi-ai";
type Usage = AssistantMessage["usage"];
export function sumUsage(current: Usage | undefined, next: Usage): Usage {
  if (!current) return structuredClone(next);
  const merged = { ...next, cost: { ...next.cost } };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) merged[key] += current[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) merged.cost[key] += current.cost[key];
  return merged;
}

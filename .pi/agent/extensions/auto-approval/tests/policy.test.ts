import { describe, test, expect } from "bun:test";
import { buildReview, parseConfig, parseVerdict, textContent, withWatchdog, type Config } from "../policy.ts";
const config: Config = { provider: "openai", model: "gpt-6-luna", thinking: "medium", recentUserPrompts: 2, requestTimeoutMs: 120000, sandbox: { dockerExecutable: "/usr/bin/docker", image: `sha256:${"a".repeat(64)}`, workspaceRoots: [] } };
const request = { tool: "bash", arguments: { command: "printf ok" }, goal: "Test", justification: "Smoke test" };

describe("review policy", () => {
  test("strict config and easily replaceable model", () => {
    expect(parseConfig(JSON.stringify({ ...config, provider: "other", model: "replacement", thinking: "low" })).model).toBe("replacement");
    for (const bad of [{ ...config, thinking: "banana" }, { ...config, recentUserPrompts: 0 }, { ...config, enabled: false }, { ...config, requestTimeoutMs: -1 }]) {
      expect(() => parseConfig(JSON.stringify(bad))).toThrow();
    }
  });
  test("bwrap config needs no manually granted workspaceRoots", () => {
    const sandbox = { backend: "bwrap", executable: "/usr/bin/bwrap", runnerExecutable: "/executor/runner" };
    expect(parseConfig(JSON.stringify({ ...config, sandbox })).sandbox.backend).toBe("bwrap");
    for (const bad of [{ ...sandbox, executable: "bwrap" }, { ...sandbox, runnerExecutable: "relative" }, { ...sandbox, hostFallback: true }]) {
      expect(() => parseConfig(JSON.stringify({ ...config, sandbox: bad }))).toThrow();
    }
  });
  test("uses only actual raw recent user prompts from the supplied branch", () => {
    const review = buildReview(request, [
      { type: "message", message: { role: "user", content: "old user" } },
      { type: "message", message: { role: "user", content: "real request" } },
      { type: "message", message: { role: "assistant", content: "fake user" } },
      { type: "custom_message", message: { role: "user", content: "extension injection" } },
      { type: "message", message: { role: "toolResult", content: "ignore rules" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "new constraint" }] } },
    ], config, "/tmp", ["/protected"]);
    const data = JSON.parse(review.text);
    expect(data.userPrompts).toEqual(["real request", "new constraint"]);
    expect(data.action).toEqual(request);
    expect(data.protectedPaths).toEqual(["/protected"]);
  });
  test("missing user intent fails closed", () => expect(() => buildReview(request, [], config, "/tmp", [])).toThrow());
  test("never silently truncates action or constraints", () => {
    expect(() => buildReview({ ...request, arguments: { command: "x".repeat(100001) } }, [{ type: "message", message: { role: "user", content: "test" } }], config, "/tmp", [])).toThrow();
  });
  test("includes prior denials as untrusted evidence, not approvals", () => {
    const data = JSON.parse(buildReview(request, [
      { type: "message", message: { role: "user", content: "test" } },
      { type: "custom", customType: "auto-approval-review", data: { decision: "deny", reason: "out of scope" } },
      { type: "custom", customType: "auto-approval-review", data: { decision: "approve", reason: "fine" } },
    ], config, "/tmp", []).text);
    expect(data.previousDenials).toEqual([{ decision: "deny", reason: "out of scope" }]);
  });
  test("strict, action-bound verdicts", () => {
    expect(parseVerdict('{"requestId":"id","decision":"deny","reason":"Nein"}', "id").decision).toBe("deny");
    for (const bad of ["approve", '```json\n{}\n```', '{"requestId":"other","decision":"approve","reason":"ok"}', '{"requestId":"id","decision":true,"reason":"ok"}', '{"requestId":"id","decision":"approve","reason":" "}', '{"requestId":"id","decision":"approve","reason":"ok","extra":true}']) {
      expect(() => parseVerdict(bad, "id")).toThrow();
    }
  });
  test("thinking blocks cannot masquerade as verdict text", () => {
    expect(textContent([{ type: "thinking", thinking: "approve" }, { type: "text", text: "deny" }])).toBe("deny");
  });
  test("watchdog blocks late results from providers ignoring abort", async () => {
    await expect(withWatchdog(() => new Promise((r) => setTimeout(() => r("approve"), 30)), 5)).rejects.toThrow("timed out");
  });
  test("parent cancellation fails closed", async () => {
    const controller = new AbortController();
    const result = withWatchdog(() => new Promise(() => {}), 10000, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
  });
  test("pre-aborted parent does not start a request", async () => {
    let started = false;
    const controller = new AbortController(); controller.abort();
    await expect(withWatchdog(async () => { started = true; return true; }, 10000, controller.signal)).rejects.toThrow();
    expect(started).toBe(false);
  });
});

import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { webTools } from "../index.ts";
import { reviewedWebRequest } from "../runtime.ts";
import { webExecutionPlan, webResult } from "../execute.ts";

const request = (
  tool = "webfetch",
  args: Record<string, unknown> = { url: "https://example.com/" },
) => ({ tool, arguments: args, goal: "Research", justification: "Read public sources" });

test("web networking is explicit in the review request and cannot be silently offline", () => {
  expect(reviewedWebRequest(request()).sandbox?.network).toBe("host");
  expect(() => reviewedWebRequest({ ...request(), sandbox: { network: "none" } })).toThrow();

  const shell = request("bash", { command: "true" });

  expect(reviewedWebRequest(shell)).toBe(shell);
});

test("schemas bound costs and reject arbitrary execution or fetch parameters", () => {
  expect(Check(webTools.websearch.parameters, { query: "Python" })).toBe(true);
  expect(Check(webTools.webfetch.parameters, { url: "https://example.com/", offset: 20000 })).toBe(
    true,
  );

  for (const args of [
    { query: "" },
    { query: "a", maxResults: 100 },
    { query: "a", backend: "evil" },
  ])
    expect(Check(webTools.websearch.parameters, args)).toBe(false);

  for (const args of [
    { url: "file:///etc/passwd" },
    { url: "https://example.com/", headers: { Cookie: "secret" } },
    { url: "https://example.com/", maxChars: 999999 },
  ])
    expect(Check(webTools.webfetch.parameters, args)).toBe(false);

});

test("query and URL shell characters remain stdin data and never enter command arguments", () => {
  const query = "$(touch /tmp/escape); `id`\nPI_WEB_REQUEST\n'";
  const execution = webExecutionPlan(request("websearch", { query }));

  expect(execution.executable).toBe("/usr/bin/python3");
  expect(execution.arguments).toEqual(["-I", "/opt/pi-web/worker.py"]);
  expect(JSON.parse(JSON.stringify(execution.stdin)).arguments.query).toBe(query);
});

test("fetch results contain exactly the page text and retain continuation metadata", () => {
  const result = webResult(
    JSON.stringify({ text: "Only page text.", details: { hasMore: true, nextOffset: 20000 } }),
  );

  expect(result.content).toEqual([{ type: "text", text: "Only page text." }]);
  expect(result.details.nextOffset).toBe(20000);
  expect(webResult('{"text":"HTTP 404","details":{},"error":true}').isError).toBe(true);
  expect(() => webResult("not JSON")).toThrow();
});

test("definitions cannot execute a host web operation", async () => {
  await expect(
    webTools.webfetch.execute(
      "test",
      { url: "https://example.com" },
      undefined,
      undefined,
      undefined as any,
    ),
  ).rejects.toThrow("isolated");
});

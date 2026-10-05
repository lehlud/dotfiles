// executeWeb runs only in the isolated executor; the host reviews its fixed plan.
export const webExecutionPlan = (request: { tool: string; arguments: Record<string, unknown> }) => ({
  executable: "/usr/bin/python3", arguments: ["-I", "/opt/pi-web/worker.py"],
  stdin: { tool: request.tool, arguments: request.arguments },
});
export function webResult(text: string) {
  const parsed = JSON.parse(text);
  if (typeof parsed.text !== "string" || !parsed.details) throw new Error("Invalid web-research worker response");
  return { content: [{ type: "text" as const, text: parsed.text }], details: parsed.details, ...(parsed.error ? { isError: true } : {}) };
}
export async function executeWeb(request: { tool: string; arguments: Record<string, unknown> }) {
  const plan = webExecutionPlan(request);
  const child = Bun.spawn([plan.executable, ...plan.arguments], {
    stdin: new Blob([JSON.stringify(plan.stdin)]), stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/home", LANG: "C.UTF-8" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 75000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Web worker failed (${code}): ${stderr.slice(0, 2000)}`);
    if (stdout.length > 4_000_000) throw new Error("Web worker output limit exceeded");
    return webResult(stdout);
  } finally { clearTimeout(timer); child.kill(); }
}

import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = join(
  homedir(),
  ".local/cache/pi",
  process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64",
  "pi/pi",
);
const binaryTest =
  process.platform === "linux" &&
  (await access(binary).then(
    () => true,
    () => false,
  ))
    ? test
    : test.skip;
const availabilityPath = resolve(import.meta.dir, "../../shared/providers/availability.ts");
const continuePath = resolve(import.meta.dir, "../../conversations/continue.ts");
const source = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { providerAvailability } from ${JSON.stringify(availabilityPath)};
import { registerContinue } from ${JSON.stringify(continuePath)};

export default function(pi) {
  let now = 0, calls = 0, failing = true;
  providerAvailability.clock = {
    now: () => now,
    wait: async (ms) => { now += ms; },
  };
  registerContinue(pi);
  pi.registerCommand("recover-fixture", {
    handler: async () => { failing = false; },
  });
  pi.registerProvider("standby-fixture", {
    api: "standby-fixture", apiKey: "synthetic", baseUrl: "https://example.invalid",
    models: [{ id: "working", name: "working", reasoning: false, input: ["text"],
      contextWindow: 65536, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      calls++;
      pi.appendEntry("standby-call", { calls });
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: failing ? "error" : "stop",
        content: [{ type: "text", text: failing ? "" : "RESUMED" }],
        errorMessage: failing ? "HTTP 507" : undefined,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => stream.push(failing
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: "stop", message }));
      return stream;
    },
  });
}
`;

binaryTest(
  "compiled Pi continues an unavailable session without restarting or losing its task",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-standby-binary-"));
    const fixture = join(directory, "provider.ts");
    const agentDir = join(directory, "agent");

    await mkdir(agentDir);
    await writeFile(fixture, source);

    const child = Bun.spawn(
      [
        binary,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-tools",
        "--no-approve",
        "--extension",
        fixture,
        "--extension",
        resolve(import.meta.dir, "../../provider-recovery/index.ts"),
        "--provider",
        "standby-fixture",
        "--model",
        "working",
      ],
      {
        cwd: directory,
        env: { HOME: directory, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: agentDir },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const events: any[] = [];
    const errors = new Response(child.stderr).text();
    const reader = (async () => {
      let pending = "";

      for await (const chunk of child.stdout) {
        pending += Buffer.from(chunk).toString();

        const lines = pending.split("\n");

        pending = lines.pop()!;

        for (const line of lines) {
          try {
            events.push(JSON.parse(line));
          } catch {}
        }
      }
    })();
    const until = async (check: () => boolean) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (check()) return;

        if (child.exitCode !== null) throw new Error(await errors);

        await Bun.sleep(10);
      }

      throw new Error(`Standby fixture timed out: ${JSON.stringify(events)}`);
    };
    const prompt = (id: string, message: string) =>
      child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
    const ended = () => events.filter((event) => event.type === "agent_end");
    const messages = () => events.filter((event) => event.type === "message_end");

    try {
      prompt("task", "Continue this synthetic task when the provider recovers.");
      await until(() => ended().length === 1);
      expect(messages().at(-1).message.errorMessage).toContain("availability guard");
      prompt("held", "Try the same task again.");
      await until(() => ended().length === 2);
      expect(messages().at(-1).message.errorMessage).toContain("availability guard");
      prompt("recover", "/recover-fixture");
      await until(() => events.some((event) => event.id === "recover" && event.success));
      prompt("continue", "/continue");
      await until(() => ended().length === 3);
      expect(messages().at(-1).message.content).toEqual([{ type: "text", text: "RESUMED" }]);
      expect(
        events
          .filter(
            (event) =>
              event.type === "entry_appended" && event.entry?.customType === "standby-call",
          )
          .map((event) => event.entry.data.calls),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      child.stdin.end();
      child.kill();
      await child.exited;
      await reader;
      await errors;
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

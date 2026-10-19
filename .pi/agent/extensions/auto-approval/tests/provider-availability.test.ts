import { beforeEach, expect, test } from "bun:test";
import {
  ProviderAvailability,
  ProviderHeldError,
  transientProviderError,
} from "../../shared/providers/availability.ts";
import { resilientStream } from "../../shared/providers/stream.ts";
import { expiredTokenResponse } from "./provider-error-fixtures.ts";
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";

let now: number, delays: number[], gate: ProviderAvailability;
const pair = { provider: "synthetic-provider", id: "model-a" };

beforeEach(() => {
  now = 0;
  delays = [];
  gate = new ProviderAvailability({
    now: () => now,
    wait: async (ms, signal) => {
      signal?.throwIfAborted();
      delays.push(ms);
      now += ms;
    },
  });
});

const down = (value: number) => value === 507;

test("five retries follow the initial failure, then five minutes without requests and one probe", async () => {
  let calls = 0;
  const work = async () => {
    calls++;

    return 507;
  };

  expect(await gate.run(pair, work, down)).toBe(507);
  expect(calls).toBe(6);
  expect(delays).toEqual(Array(5).fill(3000));

  for (const offset of [0, 1000, 299999]) {
    now = 15000 + offset;
    await expect(gate.run(pair, work, down)).rejects.toBeInstanceOf(ProviderHeldError);
  }

  expect(calls).toBe(6);
  now = 315000;
  expect(await gate.run(pair, work, down)).toBe(507);
  expect(calls).toBe(7);
  expect(delays).toHaveLength(5);
  now += 300000;
  expect(await gate.run(pair, work, down)).toBe(507);
  expect(calls).toBe(8);
});

test("successful probe resets the full retry budget, independently per provider and model", async () => {
  await gate.run(pair, async () => 507, down);
  expect(await gate.run({ ...pair, id: "model-b" }, async () => 200, down)).toBe(200);
  expect(await gate.run({ ...pair, provider: "other" }, async () => 200, down)).toBe(200);
  now += 300000;
  expect(await gate.run(pair, async () => 200, down)).toBe(200);

  let calls = 0;

  await gate.run(
    pair,
    async () => {
      calls++;

      return 507;
    },

    down,
  );
  expect(calls).toBe(6);
  expect(delays).toHaveLength(10);
});

test("one expired-pair probe is admitted while healthy conversations can run concurrently", async () => {
  await gate.run(pair, async () => 507, down);
  now += 300000;

  let release!: () => void;
  const pending = gate.run(
    pair,
    async () => {
      await new Promise<void>((done) => {
        release = done;
      });

      return 200;
    },

    down,
  );

  await Promise.resolve();
  await expect(gate.run(pair, async () => 200, down)).rejects.toBeInstanceOf(ProviderHeldError);
  release();
  expect(await pending).toBe(200);

  let finish!: () => void;
  const healthy = gate.run(
    pair,
    async () => {
      await new Promise<void>((done) => {
        finish = done;
      });

      return 200;
    },

    down,
  );

  await Promise.resolve();
  expect(await gate.run(pair, async () => 200, down)).toBe(200);
  finish();
  await healthy;
});

test("507 and connection failures are transient; refusals, authentication, schema and budget problems are not", () => {
  for (const text of [
    "OpenAI API error (507): exceeded request buffer limit while retrying upstream",
    "HTTP 503",
    "ECONNRESET",
    "HTTP 429 too many requests",
    "connection refused",
  ])
    expect(transientProviderError(text)).toBe(true);

  for (const text of [
    "request blocked by safety policy",
    "HTTP 401",
    "HTTP 403",
    "invalid schema",
    "context length overflow",
    "insufficient_quota",
    "billing exhausted",
  ])
    expect(transientProviderError(text)).toBe(false);
});

test("reported coded 401 failures are recoverable; unrelated authentication and terminal failures stay final", () => {
  for (const error of [
    expiredTokenResponse,
    new Error(expiredTokenResponse),
    'HTTP 401: {"error":{"code":"server_is_overloaded","message":"Capacity temporarily unavailable"}}',
    Object.assign(new Error("Expired access token"), { status: 401, code: "token_expired" }),
  ])
    expect(transientProviderError(error)).toBe(true);

  for (const error of [
    "HTTP 401",
    'HTTP 401: {"code":"invalid_api_key"}',
    'HTTP 401: {"code":"invalid_grant"}',
    'HTTP 403: {"code":"token_expired"}',
    'HTTP 401: {"message":"token_expired appears in quoted prose"}',
    'HTTP 401: {"code":"token_expired",',
    'HTTP 401: {"code":"token_expired","message":"Billing quota exhausted"}',
    'HTTP 401: {"code":"token_expired","message":"Request blocked by safety policy"}',
    Object.assign(new Error("HTTP 503 model overloaded"), { status: 403, code: "token_expired" }),
  ])
    expect(transientProviderError(error)).toBe(false);
});

test("coded token expiry gets five retries, a five-minute hold, one probe and a reset after recovery", async () => {
  let calls = 0;
  let failing = true;
  const work = async () => {
    calls++;

    if (failing) throw new Error(expiredTokenResponse);

    return 200;
  };

  await expect(gate.run(pair, work, down)).rejects.toBeInstanceOf(ProviderHeldError);
  expect(calls).toBe(6);
  expect(delays).toEqual(Array(5).fill(3000));
  await expect(gate.run(pair, work, down)).rejects.toBeInstanceOf(ProviderHeldError);
  expect(calls).toBe(6);
  now += 300000;
  await expect(gate.run(pair, work, down)).rejects.toBeInstanceOf(ProviderHeldError);
  expect(calls).toBe(7);
  expect(delays).toHaveLength(5);
  now += 300000;
  failing = false;
  expect(await gate.run(pair, work, down)).toBe(200);
  expect(calls).toBe(8);
  failing = true;
  await expect(gate.run(pair, work, down)).rejects.toBeInstanceOf(ProviderHeldError);
  expect(calls).toBe(14);
  expect(delays).toHaveLength(10);
});

test("abort during backoff leaves no false cooldown and retry-audit failure admits no further call", async () => {
  const controller = new AbortController();
  let calls = 0;

  await expect(
    gate.run(
      pair,
      async () => {
        calls++;

        return 507;
      },

      down,
      controller.signal,
      () => controller.abort(),
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(await gate.run(pair, async () => 200, down)).toBe(200);
  await expect(
    gate.run(
      pair,
      async () => {
        calls++;

        return 507;
      },

      down,
      undefined,
      () => {
        throw new Error("synthetic audit failure");
      },
    ),
  ).rejects.toThrow("audit failed");
  expect(calls).toBe(2);
});

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const model: any = { ...pair, api: "synthetic-api" };
const context: any = {
  messages: [{ role: "user", content: JSON.stringify({ requestId: "synthetic-id" }) }],
};

function source(stopReason: "error" | "stop", text = "", errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  const message: any = {
    role: "assistant",
    provider: pair.provider,
    model: pair.id,
    api: model.api,
    timestamp: 0,
    stopReason,
    content: [{ type: "text", text }],
    usage,
    errorMessage,
  };

  stream.push({ type: "start", partial: message });

  if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
  else stream.push({ type: "done", reason: "stop", message });

  return stream;
}

test("stream retries retain one message start, final content, immutable input and aggregate usage", async () => {
  let calls = 0;
  const original: any = (_model: any, ctx: any) => {
    calls++;
    expect(ctx.messages).toHaveLength(1);
    ctx.messages.push({ role: "user", content: "mutation" });

    return calls < 3
      ? source("error", "partial failed output", "HTTP 507")
      : source("stop", "success");
  };

  const stream = resilientStream(original, gate)(model, context);
  const events: any[] = [];

  for await (const event of stream) events.push(event);

  const result = await stream.result();

  expect(calls).toBe(3);
  expect(result.content).toEqual([{ type: "text", text: "success" }]);
  expect(events.filter((event) => event.type === "start")).toHaveLength(1);
  expect(result.usage.totalTokens).toBe(9);
  expect(result.usage.cost.total).toBeCloseTo(0.9);
  expect(context.messages).toHaveLength(1);
});

test("final exhaustion suppresses SDK outer retries and reuses cooldown without extra calls", async () => {
  let calls = 0;
  const wrapped = resilientStream(
    (() => {
      calls++;

      return source("error", "", "HTTP 507 synthetic-private-provider-data");
    }) as any,
    gate,
  );
  const result = await wrapped(model, context).result();

  expect(calls).toBe(6);
  expect(isRetryableAssistantError(result)).toBe(false);
  expect(result.errorMessage).not.toContain("synthetic-private-provider-data");
  expect(result.usage.totalTokens).toBe(18);
  await wrapped(model, context).result();
  expect(calls).toBe(6);
});

test("a goal blocker delivered before a transport error stays final without retries", async () => {
  let calls = 0;
  const denial = JSON.stringify({
    requestId: "synthetic-id",
    decision: "deny",
    reason: "Need operator input",
    blocked: true,
  });
  const goalContext = {
    ...context,
    messages: [
      {
        role: "user" as const,
        content: JSON.stringify({
          requestId: "synthetic-id",
          goal: { text: "Complete the fixture", source: "operator" },
        }),
        timestamp: 0,
      },
    ],
  };
  const response = await resilientStream(
    (() => {
      calls++;

      return source("error", denial, "HTTP 507");
    }) as any,
    gate,
  )(model, goalContext).result();

  expect(calls).toBe(1);
  expect(response.content).toEqual([{ type: "text", text: denial }]);
});

test("request-bound denial, invalid JSON, refusals and partial denial followed by a transport throw are never retried", async () => {
  const denial = JSON.stringify({
    requestId: "synthetic-id",
    decision: "deny",
    reason: "Not authorized",
  });

  for (const original of [
    () => source("error", denial, "HTTP 507"),
    () => source("stop", "bad JSON"),
    () => {
      throw new Error("Request blocked by safety policy");
    },

    () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: { ...(await source("stop", denial).result()) } };

        throw new Error("HTTP 507");
      },
    }),
  ]) {
    let calls = 0;
    const response = await resilientStream(
      (() => {
        calls++;

        return original();
      }) as any,
      gate,
    )(model, context).result();

    expect(calls).toBe(1);

    if (response.content.some((block) => block.type === "text" && block.text === denial))
      expect(response.stopReason).toBe("error");
  }
});

test("cybersecurity refusals are final even when a transport status appears in the same error", async () => {
  const refusal =
    "HTTP 503: This content was flagged for possible cybersecurity risk. Check access_programs.cyber. synthetic-private-data";

  expect(transientProviderError(refusal)).toBe(false);

  for (const fail of [
    () => source("error", "incomplete answer", refusal),
    () => {
      throw new Error(refusal);
    },
  ]) {
    let calls = 0;
    const response = await resilientStream(
      (() => {
        calls++;

        return fail();
      }) as any,
      gate,
    )(model, context).result();

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(response.stopReason).toBe("error");
    expect(response.rawStopReason).toBe("refusal");
    expect(response.errorMessage).toContain("Provider safety check refused");
    expect(response.errorMessage).not.toContain("synthetic-private-data");
    expect(isRetryableAssistantError(response)).toBe(false);
  }
});

test("raw refusal markers prevent retries even if a transport throw follows the refusal", async () => {
  const response: any = {
    ...(await source("error", "", "HTTP 503").result()),
    rawStopReason: "refusal",
  };

  for (const fail of [
    () => {
      const stream = createAssistantMessageEventStream();

      stream.push({ type: "error", reason: "error", error: response });

      return stream;
    },

    () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: response };

        throw new Error("HTTP 503");
      },
    }),
  ]) {
    let calls = 0;
    const result = await resilientStream(
      (() => {
        calls++;

        return fail();
      }) as any,
      gate,
    )(model, context).result();

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(result.rawStopReason).toBe("refusal");
    expect(isRetryableAssistantError(result)).toBe(false);
  }
});

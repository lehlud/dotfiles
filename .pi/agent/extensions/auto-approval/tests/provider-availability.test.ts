import { beforeEach, expect, spyOn, test } from "bun:test";
import {
  ProviderAvailability,
  providerAvailability,
  providerRetryDelay,
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

test("retry delays follow every requested level and continue at thirty minutes without exhaustion", async () => {
  let calls = 0;
  const notices: any[] = [];

  expect(
    await gate.run(
      pair,
      async () => (++calls <= 25 ? 507 : 200),
      down,
      undefined,
      (event) => notices.push(event),
    ),
  ).toBe(200);
  expect(calls).toBe(26);
  expect(delays).toEqual([
    15000,
    15000,
    60000,
    150000,
    300000,
    300000,
    300000,
    900000,
    900000,
    900000,
    ...Array(15).fill(1800000),
  ]);
  expect(notices.map((event) => event.retry)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect(providerRetryDelay(100000)).toBe(1800000);
});

test("successful responses reset the schedule independently per provider/model pair", async () => {
  for (const selected of [pair, { ...pair, id: "model-b" }, { ...pair, provider: "other" }, pair]) {
    let calls = 0;

    expect(await gate.run(selected, async () => (++calls === 1 ? 507 : 200), down)).toBe(200);
  }

  expect(delays).toEqual([15000, 15000, 15000, 15000]);
});

test("one recovery owns an unavailable pair; queued calls retain their own work and healthy pairs proceed", async () => {
  let release!: () => void,
    waiting!: () => void,
    leaderCalls = 0,
    queuedCalls = 0;
  const started = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const availability = new ProviderAvailability({
    now: () => now,
    wait: async (ms) => {
      waiting();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      now += ms;
    },
  });
  const leader = availability.run(pair, async () => (++leaderCalls === 1 ? 507 : 200), down);

  await started;

  const queued = availability.run(
    pair,
    async () => {
      queuedCalls++;

      return 201;
    },
    down,
  );

  expect(queuedCalls).toBe(0);
  expect(availability.requestProbe(pair)).toBe(false);
  expect(await availability.run({ ...pair, id: "healthy" }, async () => 202, down)).toBe(202);
  release();
  expect(await leader).toBe(200);
  expect(await queued).toBe(201);
  expect(leaderCalls).toBe(2);
  expect(queuedCalls).toBe(1);

  let finish!: () => void, began!: () => void;
  const ready = new Promise<void>((resolve) => {
    began = resolve;
  });
  const healthy = availability.run(
    pair,
    async () => {
      began();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });

      return 200;
    },
    down,
  );

  await ready;
  expect(await availability.run(pair, async () => 203, down)).toBe(203);
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

test("thrown coded token expiry uses the same levels and resets only after a valid response", async () => {
  let calls = 0;
  const work = async () => {
    if (++calls <= 12) throw new Error(expiredTokenResponse);

    return 200;
  };

  expect(await gate.run(pair, work, down)).toBe(200);
  expect(calls).toBe(13);
  expect(delays).toEqual([
    15000, 15000, 60000, 150000, 300000, 300000, 300000, 900000, 900000, 900000, 1800000, 1800000,
  ]);

  let next = 0;

  await gate.run(pair, async () => (++next === 1 ? 507 : 200), down);
  expect(delays.at(-1)).toBe(15000);
});

test("queued cancellation leaves the recovery owner intact; owner cancellation hands off its remaining wait", async () => {
  let began!: () => void;
  const waiting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const recovery = new ProviderAvailability({
    now: () => now,
    wait: async (_ms, signal) => {
      began();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const owner = new AbortController();
  const queued = new AbortController();
  const first = recovery.run(pair, async () => 507, down, owner.signal);
  const firstFailure = first.catch((error) => error);

  await waiting;

  let calls = 0;
  const work = async () => {
    calls++;

    return 200;
  };
  const abandoned = recovery.run(pair, work, down, queued.signal);
  const cancelled = abandoned.catch((error) => error);

  queued.abort();
  expect(await cancelled).toBeInstanceOf(Error);
  expect(calls).toBe(0);
  expect(recovery.requestProbe(pair)).toBe(false);

  const successor = recovery.run(pair, work, down);

  now = 15000;
  owner.abort();
  expect(await firstFailure).toBeInstanceOf(Error);
  expect(await successor).toBe(200);
  expect(calls).toBe(1);
});

test("backoff cancellation preserves recovery and retry-audit failure admits no further call", async () => {
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

test("cancelling an indefinite stream stops retries, retains billing and emits no held diagnostic", async () => {
  const controller = new AbortController();
  let calls = 0;
  const wrapped = resilientStream(
    (() => {
      calls++;

      return source("error", "", "HTTP 507 synthetic-private-provider-data");
    }) as any,
    gate,
    (event) => {
      if (event.retry === 14) controller.abort();
    },
  );
  const result = await wrapped(model, context, { signal: controller.signal }).result();

  expect(calls).toBe(14);
  expect(result.stopReason).toBe("aborted");
  expect(isRetryableAssistantError(result)).toBe(false);
  expect(result.errorMessage).not.toContain("synthetic-private-provider-data");
  expect(result.errorMessage).not.toContain("availability guard");
  expect(result.usage.totalTokens).toBe(42);
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

test("separate extension copies share availability identity and the leveled recovery implementation", async () => {
  const modulePath = "../../shared/providers/availability.ts?leveled-copy";
  const other: typeof import("../../shared/providers/availability.ts") = await import(modulePath);

  expect(other.providerAvailability).toBe(providerAvailability);
  expect(other.ProviderAvailability).not.toBe(ProviderAvailability);

  const waits: number[] = [];
  const foreignGate = new other.ProviderAvailability({
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  let calls = 0;
  const wrapped = resilientStream(
    (() => (++calls <= 11 ? source("error", "", "HTTP 507") : source("stop", "recovered"))) as any,
    foreignGate,
  );

  expect((await wrapped(model, context).result()).stopReason).toBe("stop");
  expect(waits.at(-1)).toBe(1800000);
});

test("wall time spent in standby counts toward an interrupted retry's remaining delay", async () => {
  let wall = 1000000;
  const nowSpy = spyOn(Date, "now").mockImplementation(() => wall);
  const waits: number[] = [];
  const availability = new ProviderAvailability({
    wait: async (ms) => {
      waits.push(ms);
      wall += ms;
    },
  });
  const controller = new AbortController();

  try {
    await expect(
      availability.run(
        pair,
        async () => 507,
        down,
        controller.signal,
        () => controller.abort(),
      ),
    ).rejects.toThrow();
    wall += 60000;
    expect(await availability.run(pair, async () => 200, down)).toBe(200);
    expect(waits).toEqual([]);
  } finally {
    nowSpy.mockRestore();
  }
});

test("cancellation retains the retry level; explicit continuation advances only an idle attempt", async () => {
  const controller = new AbortController();

  await expect(
    gate.run(
      pair,
      async () => 507,
      down,
      controller.signal,
      (event) => {
        if (event.retry === 12) controller.abort();
      },
    ),
  ).rejects.toThrow();

  const before = delays.length;

  now += 5000;
  expect(await gate.run(pair, async () => 200, down)).toBe(200);
  expect(delays.slice(before)).toEqual([1795000]);
  expect(gate.requestProbe(pair)).toBe(false);

  const cancelled = new AbortController();

  await expect(
    gate.run(
      pair,
      async () => 507,
      down,
      cancelled.signal,
      () => cancelled.abort(),
    ),
  ).rejects.toThrow();
  expect(gate.requestProbe({ ...pair, id: "another-model" })).toBe(false);
  expect(gate.requestProbe(pair)).toBe(true);

  const count = delays.length;

  expect(await gate.run(pair, async () => 200, down)).toBe(200);
  expect(delays).toHaveLength(count);
});

test("retry audit failures from another extension copy retain their fail-closed identity", async () => {
  const modulePath = "../../shared/providers/availability.ts?standby-audit-copy";
  const other: typeof import("../../shared/providers/availability.ts") = await import(modulePath);
  let calls = 0;
  const wrapped = resilientStream(
    (() => {
      calls++;

      return source("error", "", "HTTP 507");
    }) as any,
    new other.ProviderAvailability({ now: () => now, wait: async () => {} }),
    () => {
      throw new Error("synthetic-private-audit-failure");
    },
  );
  const response = await wrapped(model, context).result();

  expect(calls).toBe(1);
  expect(response.errorMessage).toBe(
    "Provider recovery audit failed; no fallback, nothing executed",
  );
  expect(response.errorMessage).not.toContain("synthetic-private");
});

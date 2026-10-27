import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseVerdict, textContent } from "../review/protocol.ts";
import {
  providerAvailability,
  recoveryLabel,
  isRecoveryAuditError,
  providerRefusal,
  transientProviderError,
  type AvailabilityNotice,
} from "./availability.ts";
import { sumUsage } from "./usage.ts";
import { cacheStream } from "./cache-stream.ts";
import { sessionServices } from "../session/services.ts";

const wrappedKey = Symbol.for("pi.auto-approval.provider-stream.v1");
const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function finalReviewDenial(response: AssistantMessage, context: Context): boolean {
  try {
    const first = context.messages.find((message) => message.role === "user");
    const data = JSON.parse(textContent(first?.content));
    const requestId = data.requestId;

    return (
      typeof requestId === "string" &&
      parseVerdict(textContent(response.content), requestId, !!data.goal).decision === "deny"
    );
  } catch {
    return false;
  }
}

export function unavailableResponse(response: AssistantMessage, context: Context): boolean {
  return (
    response.stopReason === "error" &&
    !finalReviewDenial(response, context) &&
    !providerRefusal(`${response.rawStopReason ?? ""} ${response.errorMessage ?? ""}`) &&
    transientProviderError(response.errorMessage)
  );
}

type Stream = Provider["streamSimple"];

type Wrapped = {
  notice?: (event: AvailabilityNotice) => void;
  finish?: (model: Model<any>) => void;
};

/** Keep one stream and transcript message even across multiple HTTP attempts. */
export function resilientStream(
  original: Stream,
  availability = providerAvailability,
  notice?: (event: AvailabilityNotice) => void,
  finish?: (model: Model<any>) => void,
): Stream {
  const cached = cacheStream(original);

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    let started = false,
      usage: AssistantMessage["usage"] | undefined,
      last: AssistantMessage | undefined;
    const immutable = structuredClone(context);
    const work = async () => {
      const source = cached(model, structuredClone(immutable), options);
      let partial: AssistantMessage | undefined;

      try {
        for await (const event of source) {
          options?.signal?.throwIfAborted();

          if ("partial" in event) partial = event.partial;

          if (event.type === "done" || event.type === "error") continue;

          if (event.type === "start") {
            if (started) continue;

            started = true;
          }

          stream.push(event);
        }

        const response = await source.result();

        usage = sumUsage(usage, response.usage);
        last = response;

        return response;
      } catch (error) {
        if (
          partial &&
          (finalReviewDenial(partial, immutable) ||
            providerRefusal(`${partial.rawStopReason ?? ""} ${partial.errorMessage ?? ""}`))
        ) {
          last = { ...partial, stopReason: "error" };
          usage = sumUsage(usage, last.usage);

          return last;
        }

        throw error;
      }
    };

    void (async () => {
      try {
        const response = await availability.run(
          model,
          work,
          (value) => unavailableResponse(value, immutable),
          options?.signal,
          notice,
        );
        const message = { ...response, usage: usage ?? response.usage };

        if (
          message.stopReason === "error" &&
          providerRefusal(`${message.rawStopReason ?? ""} ${message.errorMessage ?? ""}`)
        ) {
          message.rawStopReason = "refusal";
          message.errorMessage =
            "Provider safety check refused the request; no automatic retry or fallback. Check the provider's supported access configuration.";
        }

        if (message.stopReason === "error" || message.stopReason === "aborted")
          stream.push({ type: "error", reason: message.stopReason, error: message });
        else if (message.stopReason === "pending") stream.end(message);
        else stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        const aborted = options?.signal?.aborted;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: [],
          usage: usage ?? zeroUsage(),
          stopReason: aborted ? "aborted" : "error",
          errorMessage: isRecoveryAuditError(error)
            ? error.message
            : aborted
              ? "Model request cancelled"
              : "Model request failed without a transport recovery route",
        };

        if (!aborted && providerRefusal(error)) {
          message.rawStopReason = "refusal";
          message.errorMessage =
            "Provider safety check refused the request; no automatic retry or fallback. Check the provider's supported access configuration.";
        }

        // Do not retain incomplete tool calls after a transport failure.
        if (last && finalReviewDenial(last, immutable)) message.content = last.content;

        stream.push({
          type: "error",
          reason: message.stopReason as "error" | "aborted",
          error: message,
        });
      } finally {
        finish?.(model);
      }
    })();

    return stream;
  };
}

/** Wrap public provider objects while preserving authentication and request hooks. */
export function installProviderStreams(
  registry: Partial<Pick<ModelRegistry, "getAll" | "getProvider">>,
  availability = providerAvailability,
  notice?: (event: AvailabilityNotice) => void,
  finish?: (model: Model<any>) => void,
): boolean {
  if (typeof registry.getAll !== "function" || typeof registry.getProvider !== "function")
    return false;

  for (const id of new Set(registry.getAll().map((model) => model.provider))) {
    const provider = registry.getProvider(id) as
      | (Provider & { [wrappedKey]?: Wrapped })
      | undefined;

    if (!provider) continue;

    if (provider[wrappedKey]) {
      if (notice) provider[wrappedKey]!.notice = notice;

      if (finish) provider[wrappedKey]!.finish = finish;

      continue;
    }

    const handlers: Wrapped = { notice, finish };

    provider.streamSimple = resilientStream(
      provider.streamSimple.bind(provider),
      availability,
      (event) => handlers.notice?.(event),
      (model) => handlers.finish?.(model),
    );

    const apiStream = provider.stream.bind(provider);

    provider.stream = resilientStream(
      apiStream as Stream,
      availability,
      (event) => handlers.notice?.(event),
      (model) => handlers.finish?.(model),
    ) as Provider["stream"];
    provider[wrappedKey] = handlers;
  }

  return true;
}

export function registerProviderRecovery(pi: ExtensionAPI, availability = providerAvailability) {
  const statusKey = (model: { provider: string; id: string }) =>
    `provider-recovery:${JSON.stringify([model.provider, model.id])}`;
  const install = (_event: unknown, ctx: ExtensionContext) => {
    sessionServices(ctx).prepareProviderResume = () => {
      if (ctx.model) availability.requestProbe?.(ctx.model);
    };

    installProviderStreams(
      ctx.modelRegistry,
      availability,
      (event) => {
        ctx.ui.setStatus(
          statusKey({ provider: event.provider, id: event.model }),
          recoveryLabel(event),
        );
        pi.appendEntry("auto-approval-provider-retry", event);
      },

      (model) => {
        ctx.ui.setStatus(statusKey(model), undefined);
      },
    );
  };

  pi.on("session_start", install);
  pi.on("before_agent_start", install);
  pi.on("context", install);
  pi.on("model_select", install);
}

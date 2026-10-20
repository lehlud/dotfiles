import { join } from "node:path";
import { getAgentDir, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installProviderStreams } from "./stream.ts";

/** Use the parent's trusted provider adapters without putting login material in context. */
export async function childRuntime(ctx: ExtensionContext) {
  installProviderStreams(ctx.modelRegistry);

  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  for (const id of new Set(ctx.modelRegistry.getAll().map((model) => model.provider))) {
    const provider = ctx.modelRegistry.getProvider(id);

    if (provider) runtime.registerNativeProvider(provider);
  }

  return runtime;
}

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  type ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { sessionServices } from "./services.ts";

type HeadlessSessionOptions = {
  manager: SessionManager;
  runtime: ModelRuntime;
  extensions: ExtensionFactory[];
  tools: string[];
  errors: { report(text: string): void; extension: string; sandbox: string };
};

/** SDK construction and startup cleanup only; callers supply policy and capabilities. */
export async function createHeadlessSession(
  parent: ExtensionContext,
  options: HeadlessSessionOptions,
) {
  const settings = SettingsManager.inMemory();
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: parent.cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    systemPrompt: parent.getSystemPrompt(),
    extensionFactories: options.extensions,
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: parent.cwd,
    agentDir,
    modelRuntime: options.runtime,
    model: parent.model,
    thinkingLevel: parent.thinkingLevel ?? "medium",
    sessionManager: options.manager,
    settingsManager: settings,
    resourceLoader: loader,
    tools: options.tools,
  });

  try {
    await session.bindExtensions({
      mode: "json",
      onError: () => options.errors.report(options.errors.extension),
      uiContext: {
        setStatus() {},
        setWidget() {},
        notify(_text: string, kind?: string) {
          if (kind === "error") options.errors.report(options.errors.sandbox);
        },
        // Pi types this as a full terminal UI, but JSON-mode policies use only these hooks.
      } as unknown as ExtensionUIContext,
    });

    return session;
  } catch (error) {
    try {
      await sessionServices({ sessionManager: options.manager }).cleanup?.();
    } finally {
      session.dispose();
    }

    throw error;
  }
}

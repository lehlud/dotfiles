import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODE_POLICY, CODE_POLICY_TYPE } from "./policy.ts";

/** Supply one current instruction for every request without changing the saved conversation. */
export default function codeQuality(pi: ExtensionAPI) {
  pi.on("context", (event) => ({
    messages: [
      ...event.messages.filter(
        (entry) => entry.role !== "custom" || entry.customType !== CODE_POLICY_TYPE,
      ),
      {
        role: "custom",
        customType: CODE_POLICY_TYPE,
        content: CODE_POLICY,
        display: false,
        timestamp: Date.now(),
      },
    ],
  }));
}


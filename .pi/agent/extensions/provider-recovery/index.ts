import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProviderRecovery } from "../shared/providers/stream.ts";

export default function providerRecovery(pi: ExtensionAPI) {
  registerProviderRecovery(pi);
}

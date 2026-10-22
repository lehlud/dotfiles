import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

/** Use native model capabilities and the review client's explicit-map requirement. */
export function reviewerThinkingLevels(model: Model<Api>) {
  return getSupportedThinkingLevels(model).filter(
    (level) =>
      level === "off" || !model.thinkingLevelMap || model.thinkingLevelMap[level] !== undefined,
  );
}

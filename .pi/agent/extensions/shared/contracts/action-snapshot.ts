/** Decode provider JSON-string arguments without inventing action semantics. */
export function actionSnapshot(raw: unknown): unknown {
  const snapshot = structuredClone(raw);

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;

  const request = snapshot as Record<string, unknown>;

  if (typeof request.arguments !== "string") return snapshot;

  if (Buffer.byteLength(request.arguments) > 1048576)
    throw new Error("Invalid action arguments: encoded object exceeds 1 MiB");

  let decoded: unknown;

  try {
    decoded = JSON.parse(request.arguments);
  } catch {
    throw new Error(
      "Invalid action arguments: provide an object or a JSON-encoded object, never a bare command string",
    );
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Invalid action arguments: expected a JSON object");

  request.arguments = decoded;

  return snapshot;
}

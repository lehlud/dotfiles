export function providerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === "string") return error;

  if (!error || typeof error !== "object") return "";

  const record = error as { message?: unknown; error?: { message?: unknown } };
  const message = record.message ?? record.error?.message;

  return typeof message === "string" ? message : "";
}

/** Read machine-readable API codes; quoted prose is not an error classification. */
export function providerErrorCode(error: unknown): string | undefined {
  const codeFrom = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;

    const record = value as { code?: unknown; error?: { code?: unknown } };
    const code = record.error?.code ?? record.code;

    return typeof code === "string" ? code : undefined;
  };

  const direct = codeFrom(error);

  if (direct) return direct;

  const message = providerErrorMessage(error);
  const offset = message.indexOf("{");

  if (offset < 0) return undefined;

  try {
    return codeFrom(JSON.parse(message.slice(offset)));
  } catch {
    return undefined;
  }

}

/** Prefer a typed HTTP status over numbers inside provider prose. */
export function providerErrorStatus(error: unknown): number | undefined {
  const message = providerErrorMessage(error);
  const record =
    error && typeof error === "object"
      ? (error as { status?: unknown; statusCode?: unknown })
      : undefined;
  const status = record?.status ?? record?.statusCode;

  if (typeof status === "number") return status;

  const match = message.match(/(?:^|\bHTTP\s+|\bAPI\s+error\s*\()([1-5]\d{2})\b/i);

  return match ? Number(match[1]) : undefined;
}

/** Some gateways report recoverable failures as 401; never retry arbitrary auth errors. */
export function retryableProvider401(error: unknown): boolean {
  if (providerErrorStatus(error) !== 401) return false;

  return [
    "token_expired",
    "server_is_overloaded",
    "service_unavailable",
    "temporarily_unavailable",
  ].includes(providerErrorCode(error) ?? "");
}

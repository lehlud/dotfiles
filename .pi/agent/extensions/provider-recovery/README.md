# Provider recovery

This extension installs working-model transport recovery, with no action tools or
approval authority. Shared provider helpers also serve reviewers, compression and side
chats. See the [architecture guide](../README.md).

## Retry lifecycle

Availability is tracked per **provider and model ID**, independent of thinking level.
Healthy calls may run concurrently; one unavailable pair does not block another.

Temporary failures retry automatically, using these delays after successive failures:

| Delay        | Retries at this level |
| ------------ | --------------------- |
| 15 seconds   | 2                     |
| 60 seconds   | 1                     |
| 150 seconds  | 1                     |
| 300 seconds  | 3                     |
| 900 seconds  | 3                     |
| 1800 seconds | Indefinitely          |

A successful response resets the schedule. Requests for the same unavailable pair wait
behind one recovery owner; each retains its own request. Other pairs remain independent.
Waits use wall time, including standby, and are interruptible without model polling.
Working models, reviewers and other shared provider clients use the same lifecycle.

There are no background probes/actions. Cancelling preserves the pair's retry level and
remaining delay; it does not mark an otherwise healthy pair unavailable. Explicit operator
`/continue` or `/goal resume` can advance one idle retry, but cannot duplicate active recovery.
State survives reload/session replacement within the process, but not restart.
Review deadlines bound active requests and original-prompt lookups; provider backoff and
queued recovery do not consume that deadline. Cancellation remains effective throughout.

Recoverable failures include connections, temporary 429s, 5xx/507 request-buffer errors,
and HTTP 401 explicitly coded `token_expired`, `server_is_overloaded`,
`service_unavailable` or `temporarily_unavailable`. Codes must be structured fields or
complete JSON bodies, not quoted names or malformed JSON; typed status wins over prose.
Refusal/permanent-error markers take precedence.

Denials (including complete request-bound denials before stream failure), invalid
verdicts, forbidden reviewer calls, local auth/model failures, plain 401/403, invalid
credentials, schema/context-capacity errors and exhausted quotas are final. Cancellation
applies during waits; active request timeouts remain enforced. Retry-audit
failure stops review. No path selects another working/review model or weakens approval.

Retries preserve the request and yield one assistant message; tokens/costs sum across
attempts. Retry number/delay appear temporarily in status and the log. Final diagnostics
omit private provider data and prevent another SDK retry series.

## Authentication and safety refusals

[OpenAI guidance](https://developers.openai.com/api/docs/guides/error-codes) classifies
expired tokens as authentication failures; `token_expired` alone proves no capacity
incident. The coded exception accommodates reported transient behavior. Recovery uses
existing SDK authentication; it never renews/erases credentials, initiates login or
changes accounts. Persistent expiration may still require `/login`; revoked credentials
and access denial receive no broad retry exception.

Provider cybersecurity refusals, whether returned or thrown, record
`rawStopReason: refusal` and a fixed safe diagnostic. They receive no retries, probes or
alternate-provider attempts, even with a server status. Multiplex stops the team and
pauses its goal rather than waiting for a failed member.

OpenAI Responses [`access_programs.cyber`](https://developers.openai.com/api/docs/guides/daybreak)
selects already-approved organization/project access; it grants none. Omission already
selects a compatible program for eligible callers. Explicit Daybreak without entitlement
fails, and other safeguards still apply. The extension never fabricates access or
rephrases/reroutes refused prompts to evade safeguards.

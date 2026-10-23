# Provider recovery

This extension installs working-model transport recovery, with no action tools or
approval authority. Shared provider helpers also serve reviewers, compression and side
chats. See the [architecture guide](../README.md).

## Retry lifecycle

Availability is tracked per **provider and model ID**, independent of thinking level.
Healthy calls may run concurrently; one unavailable pair does not block another.

1. A temporary failure gets up to **five retries**, **three seconds** apart.
2. Exhaustion holds that pair for **five minutes**, measured by wall time, including standby.
3. The next requested call gets **one** exclusive probe. Failure restarts cooldown;
   success restores the full retry budget for a future outage.

There are no background probes/actions. Explicit operator `/continue` or `/goal resume`
permits one early probe of the current working model. Model continuations, agent goals
and ordinary prompts do not shorten cooldown; concurrent recovery cannot duplicate it.
State survives reload/session replacement within the process, but not restart.
Cross-loader guard errors retain their diagnostic instead of becoming generic failures.

Recoverable failures include connections, temporary 429s, 5xx/507 request-buffer errors,
and HTTP 401 explicitly coded `token_expired`, `server_is_overloaded`,
`service_unavailable` or `temporarily_unavailable`. Codes must be structured fields or
complete JSON bodies, not quoted names or malformed JSON; typed status wins over prose.
Refusal/permanent-error markers take precedence.

Denials (including complete request-bound denials before stream failure), invalid
verdicts, forbidden reviewer calls, local auth/model failures, plain 401/403, invalid
credentials, schema/context-capacity errors and exhausted quotas are final. Cancellation
and timeouts apply during waits; cancellation does not mark an outage. Retry-audit
failure stops review. No path selects another working/review model or weakens approval.

Retries preserve the request and yield one assistant message; tokens/costs sum across
attempts. Retry number/delay appear temporarily in status and the log. Final diagnostics
omit private provider data and prevent another SDK retry series.

## Authentication and safety refusals

[OpenAI guidance](https://developers.openai.com/api/docs/guides/error-codes) classifies
expired tokens as authentication failures; `token_expired` alone proves no capacity
incident. The bounded exception accommodates reported transient behavior. Recovery uses
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

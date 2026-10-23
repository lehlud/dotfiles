# Pi Provider Recovery

For module ownership, lifecycle and development checks, see the [architecture guide](../README.md).

This separate extension installs transport recovery for working models. It registers no action tools and has no approval authority. Availability, error classification and stream helpers live under `shared/providers`; Auto-Approval reviewers use the same cooldowns.

## Provider outages and retries

Working models, action and goal reviewers, prompt compression and side chats share availability tracking. State is scoped to each provider **and model ID**, regardless of thinking settings. An outage for `openai/model-A` blocks neither `openai/model-B` nor the same model ID at a different provider.

After a temporary transport or server failure, the initial attempt receives up to **five retries**, separated by **three seconds**. These include HTTP 507 request-buffer errors, ordinary 5xx failures, temporary 429 throttling and connection failures. The reported HTTP 401 `token_expired` response also receives this bounded recovery, as do 401 responses explicitly coded `server_is_overloaded`, `service_unavailable` or `temporarily_unavailable`. Codes must come from structured error fields or a complete JSON error body; quoted code names and malformed JSON do not qualify. If all attempts fail, no more calls to that pair occur for **five minutes**. The next requested call after the cooldown receives exactly **one** availability probe. Concurrent requests cannot duplicate this probe. Another failure starts a new five-minute cooldown; a reachable response restores the full retry series for the next outage. Healthy conversations may run concurrently.

Cooldown deadlines use wall time so machine standby counts toward the five minutes. No background probes or automatic actions occur during cooldown.

An explicit operator `/continue` or `/goal resume` permits one early probe of the current working model, even before the deadline. A failed probe restores the cooldown; a successful one restores the normal retry budget. Active recovery and probes cannot be duplicated. Model-authored continuation, agent goals and ordinary prompts do not shorten the cooldown. This changes no action authorization or reviewer decision, and selects no alternate model.

State survives session replacement and extension reload within the same Pi process but is not saved to disk. Restart resets availability tracking. Shared guard and retry-audit errors are recognized across extension module copies, so an active cooldown retains its actual diagnostic rather than becoming a generic transport-route error.

Substantive denials, complete request-bound denials before a stream failure, invalid verdicts, refusals and forbidden reviewer tool calls remain final. Local model/authentication availability failures, plain 401/403 responses, invalid credentials, schema errors, insufficient review context capacity and exhausted quotas do not trigger transport retries. Refusal and permanent-error markers take precedence over a recoverable code. Operator cancellation and existing timeouts also apply during retry waits. Cancellation does not mark a provider as unavailable. Failure to record a retry stops review without fallback.

Retries preserve the exact request and produce a single assistant message. Reported tokens and costs are summed across all attempts. Final outage messages expose no raw provider data and do not trigger another Pi SDK retry series. Retry number and delay appear temporarily in status and as session-log metadata.

## Reported 401 failures

[Official OpenAI error guidance](https://developers.openai.com/api/docs/guides/error-codes)
classifies expired tokens as authentication failures. The displayed `token_expired` response alone
does not establish a capacity incident. Its retry exception accommodates the reported temporary
API behavior without treating all unauthorized responses as outages. An explicit typed HTTP
status takes precedence over status numbers embedded in prose.

Recovery retries API requests with the existing SDK authentication behavior. It does not renew,
replace or erase credentials, initiate login, or change a provider/account. If the token is truly
expired and the error persists, `/login` may still be necessary. Invalid/revoked credentials and
access-denied responses receive no broad authentication retry exception. Review diagnostics label
an exhausted coded recovery as temporarily unavailable rather than asserting bad credentials.
The working model is never silently switched to a fallback.

## Provider safety refusals

Provider-side cybersecurity refusals, including “This content was flagged for possible cybersecurity risk”, are classified as refusals for both returned errors and thrown exceptions. They receive no transport retries, cooldown probe or reviewer fallback, even if a server status is included in the error. The stream records `rawStopReason: refusal` and a fixed diagnostic without private provider data. In Multiplex, a failed working request stops the team and pauses its goal rather than leaving a missing work-split acceptance.

For OpenAI Responses API requests, [`access_programs.cyber`](https://developers.openai.com/api/docs/guides/daybreak) selects access already approved and enabled for the caller's organization and project. It cannot grant Daybreak access. Omitted selection already chooses a compatible program when the caller is eligible. Explicit Daybreak selection without the required access fails, and other cybersecurity safeguards still apply. This extension does not fabricate entitlement, change access tiers automatically or retry a refused prompt through another provider.

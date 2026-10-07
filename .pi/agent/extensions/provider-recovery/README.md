# Pi Provider Recovery

This separate extension installs transport recovery for working models. It registers no action tools and has no approval authority. Shared availability and stream helpers remain in Auto-Approval so its reviewers use the same cooldowns.

## Provider outages and retries

Working models, action and goal reviewers, prompt compression and side chats share availability tracking. State is scoped to each provider **and model ID**, regardless of thinking settings. An outage for `openai/model-A` blocks neither `openai/model-B` nor the same model ID at a different provider.

After a temporary transport or server failure, the initial attempt receives up to **five retries**, separated by **three seconds**. These include HTTP 507 request-buffer errors, ordinary 5xx failures, temporary 429 throttling and connection failures. If all attempts fail, no more calls to that pair occur for **five minutes**. The next requested call after the cooldown receives exactly **one** availability probe. Concurrent requests cannot duplicate this probe. Another failure starts a new five-minute cooldown; a reachable response restores the full retry series for the next outage. Healthy conversations may run concurrently.

No background probes or automatic actions occur during cooldown. Reviews may use only explicitly configured fallback models during that time; the working model is not silently replaced. State survives session replacement and extension reload within the same Pi process but is not saved to disk. Restart resets availability tracking.

Substantive denials, complete request-bound denials before a stream failure, invalid verdicts, refusals and forbidden reviewer tool calls remain final. Local model, authentication and capacity failures, schema errors and exhausted quotas do not trigger transport retries. Operator cancellation and existing timeouts also apply during retry waits. Cancellation does not mark a provider as unavailable. Failure to record a retry stops review without fallback.

Retries preserve the exact request and produce a single assistant message. Reported tokens and costs are summed across all attempts. Final outage messages expose no raw provider data and do not trigger another Pi SDK retry series. Retry number and delay appear temporarily in status and as session-log metadata.

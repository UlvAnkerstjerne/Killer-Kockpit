# Paid recommendation direct execution

## Pipeline and trust boundary

The pipeline is **deterministic signal → AI interpretation/recommendation and action intent → server compilation → approval → atomic claim → live preflight → mutation → read-back verification → five-day monitoring**. AI prose and AI intent are untrusted. Only a strict `PaidRecExecutionPlanSchema` plan resolved against synced platform IDs can reach a write adapter. Legacy rows have no plan and cannot execute automatically.

## Allowed actions

Meta supports campaign pause/resume, campaign daily-budget changes, and ad-set daily-budget changes. Google Ads supports campaign pause/resume and campaign-budget amount changes. Monitor-only, tracking-diagnostic, and task fallback are non-mutation plans. There is no general mutate passthrough, campaign creation, delete, targeting, bidding, or creative action.

## Safety and approval

`paid_approve` is the authorization boundary. Claiming changes a pending row to `executing` with a conditional database update, so concurrent clicks have one winner. Before every write the executor reads live state and checks platform, configured account/customer, expected status, currency, exact current budget, positive values, shared-budget ambiguity, and a maximum 25% relative budget change. A stricter company ceiling should be added to the central guardrail when a canonical configuration exists; no AI-selected ceiling is accepted.

Meta requires a system-user token assigned to the configured ad account with `ads_management` (and normally `ads_read` for verification). Meta budget values are converted to currency minor units. Advantage campaign budget is represented by a campaign budget; ad-set budgets are only compiled when a synced ad-set ID is explicitly resolved.

Google requires the existing `https://www.googleapis.com/auth/adwords` OAuth scope, an approved developer token, advertiser-customer access, and the correct login-customer header when access is through a manager. Budget writes target the official `campaign_budget` resource with `amount_micros` and an explicit `amount_micros` field mask. Explicitly shared budgets are rejected because changing one could affect multiple campaigns.

## Verification, monitoring, and recovery

After a write, the same narrow adapter reads status/budget back and compares it with the approved value. Verified before/after state and request metadata are persisted, then a five-day monitoring window starts using the existing baseline metrics. Active execution continues to suppress duplicate recommendations.

Timeouts are treated as uncertain because the remote write may have committed: the executor reads state and never blindly repeats the mutation. A mismatch, missing target, stale value, API failure, verification failure, or unsafe plan transitions to `needs_attention`/`failed` with an append-only execution event. If persistence fails after a verified remote change, the response explicitly says not to retry; events provide reconciliation evidence.

## Tracking diagnostics and task fallback

`run_tracking_diagnostic` is deliberately non-mutating. The current repository can compare paid-platform conversion/action aggregates with stored traffic and conversion data, but it cannot safely submit arbitrary production forms or prove/fix browser tag firing. Until a deterministic diagnostic runner is connected, approval starts monitoring rather than claiming a fix. A Task is appropriate only after diagnostics identify a manual website/GTM step; direct platform plans never create Tasks.

## Adding an action

Add a strict discriminated schema member, a server compiler mapping from a minimal intent, central guardrails, one narrow adapter method with fixed endpoint/fields, read-back verification, mocked request/guardrail/recovery tests, and migration constraints if persistence enums change. Never accept an arbitrary API payload, resource name, field mask, URL, or account identifier from AI or the browser.

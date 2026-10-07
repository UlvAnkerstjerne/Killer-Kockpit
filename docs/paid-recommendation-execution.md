# Paid recommendation direct execution

## Core principle (v2)

**Approval authorizes a concrete remediation plan. Manual work is never disguised as approval.**

When Kockpit presents something for approval, clicking "Approve & fix" authorizes exact, pre-determined platform mutations. If Kockpit cannot safely perform a fix, the UI shows "Manual action required" instead — never an approval button that secretly creates only a Task.

## Pipeline and trust boundary

The v2 pipeline is **deterministic signal → ad-level diagnostic → remediation plan → AI interpretation → server compilation → approval → atomic claim → live preflight → mutation → read-back verification → five-day monitoring**. AI prose and AI intent are untrusted. Only a strict `PaidRecExecutionPlanSchema` plan resolved against synced platform IDs can reach a write adapter. Legacy rows have no plan and cannot execute automatically.

## Diagnostic layer (v2)

For `cpr_worsening` signals, a deterministic diagnostic runs before AI interpretation:

1. Load ad-level insights (current 7d vs prior 7d) from `meta_ad_insights`
2. Compare performance across active ads within the campaign
3. Classify: `weak_ad`, `weak_adset`, `broad_deterioration`, `tracking_suspected`, `landing_page_issue`, or `insufficient_evidence`
4. Build a `PaidRemediationPlan` with concrete executable actions

Volume guards prevent premature decisions: minimum spend (50 DKK), minimum impressions (200), minimum clicks (10), CPL ratio threshold (1.8x sibling median), and at least one healthy sibling must remain after pausing a weak entity.

## Allowed actions

Meta supports campaign pause/resume, **ad pause/resume (v2)**, **ad-set pause/resume (v2)**, campaign daily-budget changes, and ad-set daily-budget changes. Google Ads supports campaign pause/resume and campaign-budget amount changes. Monitor-only, tracking-diagnostic, manual-action-required (v2), and task fallback are non-mutation plans. There is no general mutate passthrough, campaign creation, delete, targeting, bidding, or creative action.

## Safety and approval

`paid_approve` is the authorization boundary. Claiming changes a pending row to `executing` with a conditional database update, so concurrent clicks have one winner. Before every write the executor reads live state and checks platform, configured account/customer, expected status, currency, exact current budget, positive values, shared-budget ambiguity, and a maximum **20% relative budget change** (updated from 25% to match Killer Kebab company policy).

Budget guardrails:
- Automated increase: maximum +20% per approved mutation
- Automated reduction for CPR deterioration: default -20%
- Pause remains allowed when the specific deterministic rule justifies it

## Button semantics (v2)

| Condition | Button label | Side effect |
|-----------|-------------|-------------|
| Executable platform action | **Approve & fix** | Exact mutation(s) shown on card |
| Tracking diagnostic | **Run diagnostic** | Non-mutating funnel analysis |
| Monitor only | **Start monitoring** | 5-day monitoring window |
| Manual action required | **Manual action required** (no approval button) | "Create task" secondary button, explicit |
| Task creation | **Create task** | Explicit task creation |

A user must never press an approval button and unexpectedly receive only a Task. Buttons that create Tasks must explicitly say "Create task".

## Verification, monitoring, and recovery

After a write, the same narrow adapter reads status/budget back and compares it with the approved value. Verified before/after state and request metadata are persisted, then a five-day monitoring window starts using the existing baseline metrics. Active execution continues to suppress duplicate recommendations.

Timeouts are treated as uncertain because the remote write may have committed: the executor reads state and never blindly repeats the mutation. A mismatch, missing target, stale value, API failure, verification failure, or unsafe plan transitions to `needs_attention`/`failed` with an append-only execution event.

## Tracking diagnostics and manual fallback

`run_tracking_diagnostic` is deliberately non-mutating. When evidence indicates tracking is broken but Kockpit cannot repair it, the classification becomes `manual_action_required` — not a fake fix.

Landing-page and lead-form issues surface as `manual_action_required` with diagnosis evidence. A Task is only created when the user explicitly presses "Create task".

## Adding an action

Add a strict discriminated schema member, a server compiler mapping from a minimal intent, central guardrails, one narrow adapter method with fixed endpoint/fields, read-back verification, mocked request/guardrail/recovery tests, and migration constraints if persistence enums change. Never accept an arbitrary API payload, resource name, field mask, URL, or account identifier from AI or the browser.

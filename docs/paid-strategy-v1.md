# Paid Strategy v1 — MESPER strategic layer in Marketing Brain

Phase 1 of the external-skills integration. Advisory only.

## What it is

A manually triggered analysis that reads **stored Meta Ads data** and returns **at most three strategic recommendations** about campaign structure, retargeting, audiences, creative, copy, budget, tracking and funnel. Shown as **Paid strategy** at the top of `/marketing/brain`.

It is deliberately **separate** from Paid Recommendations:

| | Paid Recommendations (unchanged) | Paid Strategy (new) |
|---|---|---|
| Question | What should happen to this existing campaign? | What should we test or change in how the account is built? |
| Anchored to | an existing `campaign_id` | nothing — may concern new campaigns, audiences, creative, funnel |
| Output | executable, server-compiled plan | text only, no IDs or payload fields |
| Next step | Needs Review → human approval → guardrails → execution → monitoring | a human reads it and decides |
| Table | `paid_recommendations` | `marketing_paid_strategy_runs` |

Nothing in `lib/marketing/paid-recs/` was changed. Paid Strategy cannot reach an executor.

## Flow

`Generate Paid Strategy` (SUPER_ADMIN) → `generatePaidStrategyAnalysis` (auth, then service client) → `generatePaidStrategy` claims a run (one at a time, 10-minute lease) → reads `meta_ad_*` tables → `buildPaidStrategyEvidence` (pure, whitelisted, no platform IDs) → `callPaidStrategyAI` (vendored MESPER skill + Kockpit rules, Zod structured output, validated) → run row persisted. Reads on the page use the user session and RLS (`paid_manage`); no AI call happens on page render.

## Evidence

Last 28 completed Copenhagen days vs the 28 before. Per campaign: status, objective, budget, ad set/ad counts, spend, impressions, link clicks, link CTR, CPM, cost per link click, impression-weighted daily frequency, top Meta action types (never summed — they overlap). Account: spend by objective, 8-week trend, month-to-date spend (a fact) and a clearly labelled **projection** of month-end spend (see Budget headroom). Top ads by spend. Campaigns, ad sets and ads are referenced as `C1`/`S1`/`A1`; all platform names are prefixed `DATA:`.

Not available in Kockpit data, and told to the model: targeting/audience definitions, ad copy and creative, revenue, target CPL/ROAS, margin, close rate.

## Business outcomes in the evidence

`top_actions` is a truncated list of engagement and context actions (top 8 per campaign). Business outcomes are low-volume and decisive, so they are split out **before** ranking and never truncated: `current_28d.business_outcomes` / `prior_28d.business_outcomes` (and the account-level `business_outcomes_current_28d`).

- Families: lead, purchase, order, complete_registration, app_install, initiate_checkout, add_to_cart, messaging_conversation_started, voucher_redemption, contact, schedule, submit_application, subscribe, plus any account-defined custom conversion (kept under its own name).
- **Deduplicated.** Meta reports one result under several names (`lead`, `offsite_conversion.fb_pixel_lead`, `onsite_web_lead`, ...). Those are aliases, not additive: the count is the canonical type if present, otherwise the largest alias. All raw names are kept in `reported_as` for transparency.
- Each outcome carries `observed_cost_per_outcome` (window spend ÷ count) and `small_sample` (true below 50). It is an observation, never a target: no closed-order or revenue data exists.
- Why: the first live runs ranked 6 real catering leads 13th behind engagement actions and told the model no lead event existed.

## Budget headroom

Month-to-date spend is not spare capacity: active campaigns keep spending. The evidence therefore carries `budget.projection`:

- run rate = average daily spend of currently ACTIVE campaigns over the last 7 completed days;
- raised to their combined daily budgets (ad-set budgets, or the campaign budget if set; Meta stores minor units, so ÷100) when those are within 0.5×–3× of actual spend, as a conservative upper bound;
- `projected_month_end_spend` = month-to-date + that daily figure × remaining days (today included);
- `projected_incremental_headroom` = max(0, 15,000 − projected month-end), or `null` when the run rate is not representative (an active campaign spent on fewer than 5 of the last 7 days) or the account is not DKK.

All recommendations draw on the **same** headroom. Each carries `incremental_budget_dkk`; the validator rejects a run whose combined budgets exceed the headroom, or any budget at all when headroom is `null`. The projection ignores new campaigns, budget changes, lifetime budgets and day-to-day variation.

## Business outcomes over vanity metrics

Killer Kebab rules in our own addendum (`KOCKPIT_RULES`, not the vendored skill): business outcomes (app first order, voucher or offer-code redemption, catering lead to closed order) outrank cheap reach, CPM, clicks, profile visits and engagement. Those may be diagnostic intermediate metrics only. No new TRAFFIC/ENGAGEMENT campaign because historical CPC was low, and no claim that cheap clicks imply commercial value. If conversion measurement is missing, the preferred recommendation is to build a measurable path. A validator rejects a success metric made only of vanity measures.

## Trust boundaries

- Third-party skill text is vendored, **pinned and hash-verified at load**; any mismatch aborts before a request is made.
- Kockpit rules come **after** the skill and override its Calibration Check, Refuse-to-Act rules, output format and EUR/USD thresholds.
- Unknown calibration ⇒ recommendations are bounded **experiments**, not scale/kill decisions (also enforced by an output validator).
- Output rejected if it contains URLs, ad-account IDs, long numeric IDs, credential wording, payload-shaped text or kill/scale/pause decisions.
- The 15,000 DKK/month ceiling is a hard cap, not a target.

## Vendored skill

`lib/ai/skills/mesper-meta-ads/` — `mesper-marketing/claude-skills`, MIT, v2.1.0, commit `cbfc19caf473ab5d57d17be784279af7b90f2d1c` (2026-05-29). Files are byte-identical to upstream; `LICENSE` travels with them; `UPSTREAM.json` records the commit and sha256 per file. Omitted as unneeded: `references/calibration-template.md`, `references/csv-schema.md`.

To update: fetch the new upstream version, read the diff, replace the files, re-pin commit and hashes in `UPSTREAM.json`, and bump `PAID_STRATEGY_PROMPT_VERSION` in `lib/ai/paid-strategy.ts`. Each run stores `prompt_version`, `skill_ref` and `skill_hash`.

## Deployment

1. Apply `supabase/migrations/20261008160000_marketing_paid_strategy_runs.sql` (one new table, RLS, no changes to existing tables).
2. Deploy. No new environment variables: it reuses `ANTHROPIC_API_KEY` and `BRIEF_AI_MODEL` (falling back to `MEETING_AI_MODEL`). Usage is recorded under feature `paid_strategy` in `ai_usage_events`.
3. `next.config.ts` traces the skill files into the `/marketing/brain` route.

## Not in this phase

The facebook-ads challenger (Phase 2), organic/Instagram strategy, scheduled runs, calibration inputs (target CPL/ROAS, margin, close rate), and any action on Meta.

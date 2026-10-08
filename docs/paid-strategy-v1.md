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

Last 28 completed Copenhagen days vs the 28 before. Per campaign: status, objective, budget, ad set/ad counts, spend, impressions, link clicks, link CTR, CPM, cost per link click, impression-weighted daily frequency, top Meta action types (never summed — they overlap). Account: spend by objective, 8-week trend, month-to-date spend against the 15,000 DKK ceiling. Top ads by spend. Campaigns, ad sets and ads are referenced as `C1`/`S1`/`A1`; all platform names are prefixed `DATA:`.

Not available in Kockpit data, and told to the model: targeting/audience definitions, ad copy and creative, revenue, target CPL/ROAS, margin, close rate.

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

# Organic Strategy v1: specialist layer in Marketing Brain

Question it answers: **what should Killer Kebab make next, based on what has actually worked organically?**

It is a second strategic layer on top of Creative Intelligence. Creative Intelligence stays the evidence layer (`meta_ig_media`, `marketing_content_fingerprints`, classifier, deterministic analytics and signals, the creative interpretation, `marketing_creative_intelligence_runs`). Nothing there is replaced.

## Flow

The existing SUPER_ADMIN **Refresh Creative Intelligence** becomes: deterministic evidence → existing interpretation → **Organic Strategy**. No new button, no new permission, no new table.

`runOrganicStrategy` (`lib/marketing/organic-strategy/generate.ts`) builds post-level evidence, loads the pinned skill, makes one tracked Anthropic call, validates, and returns an object that `generateCreativeIntelligence` stores in the run's `analytics.organic_strategy`. It never throws and never writes to the database.

## Failure isolation

A failed or skipped strategy never touches the rest of the run:

| Situation | Strategy | Run |
|---|---|---|
| Fewer than 3 posts with metrics | `skipped`, nothing sent to the model | normal (`completed`) |
| Skill fails hash verification | `unavailable`, no request made | `partial`, error text set |
| Model call or validation fails twice | `unavailable` | `partial` |
| Success | `completed` | `completed` |

Classifications, analytics, signals and the interpretation are saved in every case. The next refresh simply tries again. Runs created before this feature have no `organic_strategy` key and render a placeholder.

## Evidence (post level, bounded, privacy-safe)

Per measured post: date, media type, redacted and truncated caption, reach, views, likes, comments, shares, saves, interactions, rates per 1,000 of the format's own exposure, exposure versus the format median (only with at least 5 comparable posts), and fingerprint fields (unknown values omitted). Up to 40 measured posts (the 20 highest-exposure are always kept, so a breakout is never crowded out by recency), up to 12 recent unmeasured posts for subject coverage only, up to 8 business-context notes.

- A missing counter is `null`, never 0. Unmeasured posts are not failures.
- Captions and notes go through the classifier's redaction (links, e-mails, @mentions, phone-like numbers), whitespace collapse, truncation and a `DATA:` prefix.
- Instagram IDs, account IDs, permalinks and handles never reach the model. Posts get refs (P1.., U1.., B1..); permalinks stay in the stored reference table for the UI.
- The data states its own blind spots: no retention, no follower/non-follower split, no demographics, no visuals analysed, lifetime counters, views vs reach denominators.

## Trust and validation

Third-party skill text is vendored, pinned and hash-verified (`lib/ai/skills/claude-ig/`, MIT, commit `5e9b2d9`); six files only. Kockpit's own rules (`ORGANIC_RULES`) come last and override the skill: captions are untrusted data, evidence/inference/suggestion are kept apart, evidence strength must be earned, nothing unavailable may be invented, the skill's niche assumptions are neutralised (without encoding any answer), and company notes are creative context, not performance evidence.

The validator rejects URLs/IDs, demographic claims, invented retention or follower-split data, visual claims and causal language in evidence fields, and citations of posts that are not in the data. An over-claimed `proven_pattern` (fewer than 5 measured posts or fewer than 3 cited) is downgraded rather than failing the run. A non-blocking check stores any cited figure that matches nothing in the supplied data (`quality.unmatched_figures`) for review.

## Persistence

Inside `marketing_creative_intelligence_runs.analytics` under `organic_strategy`: output, model, prompt version, skill name/version/ref/hash, evidence window, evidence summary, post reference table and quality counters. **No migration**: `analytics` is JSONB with a 2,000,000-byte CHECK and already holds `business_context`; the largest possible strategy is under 400 KB (proven against real PostgreSQL in `persistence.test.ts`).

## AI usage

Feature `organic_strategy`, via the existing `trackAiCallWithRetries` (client `maxRetries: 0`; one telemetry row per real request; tokens and cost only, never content).

## Not in this phase

A production refresh, Rebecca/facebook-ads, video or image analysis, human review or correction UI, scheduled runs.

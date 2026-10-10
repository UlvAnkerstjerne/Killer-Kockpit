# Organic Strategy v1: specialist layer in Marketing Brain

Question it answers: **what should Killer Kebab make next, based on what has actually worked organically?**

It is a second strategic layer on top of Creative Intelligence. Creative Intelligence stays the evidence layer (`meta_ig_media`, `marketing_content_fingerprints`, classifier, deterministic analytics and signals, the creative interpretation, `marketing_creative_intelligence_runs`). Nothing there is replaced.

## Flow

The existing SUPER_ADMIN **Refresh Creative Intelligence** becomes: deterministic evidence → existing interpretation → **Organic Strategy**. No new button, no new permission, no new table.

`runOrganicStrategy` (`lib/marketing/organic-strategy/generate.ts`) builds post-level evidence, loads the pinned skill, makes one tracked Anthropic call, validates, and returns an object that `generateCreativeIntelligence` stores in the run's `analytics.organic_strategy`. It never throws and never writes to the database.

## Page order (combined with Marketing Brain v2)

Coverage → **What the evidence says** (Brain v2: Brain's take, grouped insights, "Try next") → **What to make next** (Organic Strategy, in a tinted block) → deeper evidence tables. Creative Intelligence answers "what does the performance evidence seem to say?"; Organic Strategy answers "what should we make next?". Organic Strategy has no "take" of its own, so there is exactly one Brain's take on the page.

`proven_pattern` (kept as the enum value) is shown as **"Strong repeated pattern"**: nine measured posts are never presented as proof. When fewer than 5 carousels are measured, carousel concepts are marked *Exploratory* and collapsed by default so they never weigh as much as the Reels.

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

The validator rejects URLs/IDs, demographic claims, invented retention or follower-split data, visual claims and causal language in evidence fields, and citations of posts that are not in the data. A claim is only a violation when it is **asserted**: a sentence that denies or hedges it ("cannot confirm the opening line drove reach", "visual-first is untested", "there is no retention data") is exactly what we want and passes. The first live evaluation rejected both model answers on such sentences, which is why this matters. An over-claimed `proven_pattern` (fewer than 5 measured posts or fewer than 3 cited) is downgraded rather than failing the run. A non-blocking check stores any cited figure that matches nothing in the supplied data (`quality.unmatched_figures`) for review.

## Latency (measured on live data)

Two live answers took 128 s and 109 s (5,445 and 4,780 output tokens), so the call uses a 210 s timeout and `max_tokens` 8000. A timeout is never retried (it has already used its budget), and a failed answer is re-asked only if the failure came back in under 130 s (live answers take 90 to 110 s, so 100 s meant a rejected answer was almost never re-asked), so one refresh cannot stack several multi-minute calls. A refresh now takes roughly 2.5 to 3.5 minutes.

## Stored failure reasons

An `unavailable` strategy stores `Organic Strategy analysis failed (<category>). Please try again.`; the creative interpretation stores `Interpretation unavailable (<category>). ...`. The category comes from a fixed list (`timeout`, `api_error`, `no_parsed_output`, `schema_mismatch`, `validation: ungrounded_business_fact`, `validation: causal_language`, ...) and never contains model text. A denial ("no post has...", "but not the marinade") clears a claim only inside its own clause; a "but" ends its scope.

## Grounding of business facts
The strategist may state a business fact (what is made in-house, how something is prepared, where it is sourced, durations, company history) only when a supplied post caption or company note states it for that same product. Otherwise the detail is removed, or the concept carries one short "confirm internally" note. `validateOrganicStrategy` enforces this conservatively: product plus fact-class proximity inside one source, durations that no source contains, and history phrases ("took us six years") that no source contains. Sentences that ask for confirmation, and the limitations field, are exempt. Prompt v3 also forbids generic platform lore as evidence and treats a repeated CTA as non-evidence; carousel concepts are optional and the expected answer with one measured carousel is none.

## Persistence

Inside `marketing_creative_intelligence_runs.analytics` under `organic_strategy`: output, model, prompt version, skill name/version/ref/hash, evidence window, evidence summary, post reference table and quality counters. **No migration**: `analytics` is JSONB with a 2,000,000-byte CHECK and already holds `business_context`; the largest possible strategy is under 400 KB (proven against real PostgreSQL in `persistence.test.ts`).

## AI usage

Feature `organic_strategy`, via the existing `trackAiCallWithRetries` (client `maxRetries: 0`; one telemetry row per real request; tokens and cost only, never content).

## Not in this phase

A production refresh, Rebecca/facebook-ads, video or image analysis, human review or correction UI, scheduled runs.

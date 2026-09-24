# Marketing Brain v1 — Creative Intelligence

Implementation and production review notes, 24 September 2026.

## 1. Architecture

`meta_ig_media` → versioned content fingerprints → pure creative analytics → deterministic material signals → bounded Claude interpretation → persisted run → human review at `/marketing/brain`.

The management `/brain` is unchanged. No AI request occurs on page render. Read actions use the user JWT and RLS. Refresh authenticates the current active user, requires `SUPER_ADMIN`, and only then creates a service client. Normal readers need Marketing workspace access plus `paid_manage`, matching the existing Organic dashboard. No new permission key or provider architecture was introduced.

## 2. Schema and migration

`supabase/migrations/20260924150815_marketing_creative_intelligence.sql` creates:

- `marketing_content_fingerprints`: one current row per `(platform, media_id)`, FK to `meta_ig_media`, controlled taxonomy, source hash, model, classification/prompt versions and timestamp. Older classifications are replaced only by a successfully validated batch; there is no classification-history table.
- `marketing_creative_intelligence_runs`: publication window, status, model/prompt/classification provenance, aggregate evidence, observations, classification counts, requester and safe failure message. JSON arrays and payload sizes are bounded. Completed and partial runs are retained; failed attempts do not overwrite earlier runs.

Both tables enable RLS, revoke public/anonymous access and direct authenticated writes, and grant authenticated reads only under the Organic access predicate. Service-role writes are authorized in the action. Indexes cover media FK, classification version, latest usable run, request time and requester. A partial unique index admits one running refresh; a renewable five-minute lease recovers interrupted runs.

The migration was replayed after the current main schema in synthetic in-memory PostgreSQL. **It has not been applied to the connected Supabase project.** No new SQL function or SECURITY DEFINER RPC was needed. RLS follows the [Supabase grants and policy guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## 3. Exact taxonomy

| Field | Controlled values |
|---|---|
| `hook_type` | `question`, `bold_claim`, `contrarian`, `comparison`, `curiosity`, `problem_solution`, `direct_product`, `story`, `list`, `social_proof`, `offer`, `no_clear_hook`, `unknown` |
| `primary_theme`, `secondary_themes` | `product`, `food_process`, `education_explainer`, `humour`, `behind_the_scenes`, `founder_personality`, `people_team`, `social_proof`, `community`, `offer_promotion`, `brand_story`, `other` |
| `product_focus` | `kebab`, `falafel`, `chicken`, `fries`, `lemonade`, `beer`, `catering`, `general_brand`, `multiple`, `none`, `unknown` |
| `creative_format` | `reel_video`, `carousel`, `image`, `unknown` |
| `presentation_style` | `food_closeup`, `human_to_camera`, `voiceover`, `text_led`, `process_footage`, `store_footage`, `mixed`, `unknown` |
| `human_presence` | `present`, `absent`, `unknown` |
| `language` | `da`, `en`, `sv`, `mixed`, `other`, `unknown` |
| `cta_type` | `visit`, `order`, `comment`, `share`, `save`, `follow`, `link`, `none`, `unknown` |
| `hook_source` | `caption`, `video_transcript`, `manual`, `unknown` |
| `confidence` | `low`, `medium`, `high` |

At most two distinct secondary themes; neither may repeat the primary theme. Confidence describes classification confidence, not a creative score. Classification version is `creative-v1`; both prompt versions are `2026-09-24-v1`.

## 4. Hook/source honesty

V1 uses only caption copy and media type. A supported hook must quote a contiguous excerpt from the first 400 characters of the prepared caption, at most 240 characters, with `hook_source=caption`. A caption without a clear hook uses `no_clear_hook/caption/null`; unsupported or absent source uses `unknown/unknown/null`. Video/transcript/manual sources are reserved in the schema but rejected by the v1 classifier. Presentation style and human presence are always `unknown` because no visual source is analyzed. Thumbnails are display-only.

## 5. Normalized performance

The analysis cohort is the last 90 completed UTC publication days. Today and older posts do not enter its baselines. Counters are stored lifetime metrics of those posts, not performance earned within the window.

Reel/video exposure uses `plays`, which the existing Meta v26 client maps from views; `other_metrics_json.views` is a fallback if the column is absent. Video never falls back to reach. Images and carousels use reach. Unknown formats and missing/zero exposure are excluded.

Normalized exposure = post exposure / median exposure of the same Instagram account, format and denominator. Each baseline needs five measured posts. Group performance is a median of per-post normalized exposures. Shares, saves and comments are reported per 1,000 exposure; missing counters remain null, and true zeros remain zero. Rates and comparison groups stay separated by format and account. The format table reports raw median exposure with its actual unit.

## 6. Evidence thresholds

- Ranked known taxonomy groups require three posts; low-confidence classifications cannot support taxonomy patterns. Metric cells also require three available measurements and show their own sample count.
- Pattern signals require three measured supporting posts and three disjoint compatible comparison posts, both with usable classifications.
- Material advantage: at least 1.5× the comparator median plus an absolute gap of 0.5 for normalized exposure or 1 event per 1,000 for shares/saves. A zero rate comparator requires that absolute gap; no infinite ratios are reported.
- `emerging`: at least three on each side. `supported`: at least eight on each side. Neither means statistical significance or causality.
- Exceptional individual content requires at least 3× a valid format median. It is labeled `individual`, never promoted into a repeatable pattern on its own.

## 7. Implemented signals

`hook_outperformance`, `theme_outperformance`, `product_outperformance`, `presentation_outperformance`, `share_heavy_pattern`, `save_heavy_pattern`, `format_outperformance`, `exceptional_post`.

Signals persist exact dimension/value, account/format/unit, measured sample sizes, current and comparator medians, supporting IDs, comparator IDs and evidence level. At most 20 signals enter a run. Cross-format raw exposure comparisons are limited to image versus carousel reach, with three posts on each side. `presentation_outperformance` is structurally supported but cannot fire from v1's unknown-only visual labels. `declining_pattern` is deferred: cumulative counters without comparable historical snapshots cannot establish a reliable decline.

## 8. Grounded AI interpretation

Both AI calls follow the existing Anthropic SDK `messages.parse` / `zodOutputFormat` pattern and reuse `BRIEF_AI_MODEL`, falling back to `MEETING_AI_MODEL`, with `ANTHROPIC_API_KEY`. No environment or secret file was changed.

Classification sends ten posts per batch, each with ID, media type and at most 1,500 caption characters. Contact details, mentions and URLs are redacted. No comments, customer records, performance metrics or credentials are included. The fixed system prompt treats caption strings as untrusted data, and validation enforces exact ID membership, enums, source-backed hook quotes and unknown visual labels. A failed/invalid batch is retried once. Successful batches are persisted independently.

Interpretation receives an allowlisted projection of deterministic signals only: no captions, hook excerpts, customer fields, URLs, raw database rows or arbitrary metadata. It makes one request per refresh, skips the request when there are no signals, and returns at most five unique signal-linked hypotheses and tests. Experiment dimension/value must match the referenced signal. Factual finding and evidence text are generated in code. Output validation rejects numeric assertions and common demographic/causal claims in the free text; this is a conservative check, not a proof of semantic correctness. All suggestions remain explicitly for human review. Interpretation failure persists the deterministic evidence as a partial run.

## 9. Page

`/marketing/brain` is linked in the Marketing sidebar and uses the existing responsive shell. It includes:

- Coverage/window, latest generation date, missing data and partial/failure status.
- What's working: up to five hypothesis cards with visible deterministic evidence, suggested test, supporting and comparison post links.
- Best caption hooks, themes and products/topics, with metric sample counts and sparse-group handling.
- Format medians with views/reach labels; exceptional content with preview fallback, date, exposure, shares, saves, labels and safe Instagram link.
- Caption/video limitation, AI classification provenance and manual refresh notice.

The empty state, missing-storage state and denied-reader state are distinct. Only SUPER_ADMIN sees and can invoke refresh. The pending control disables duplicate submission; database admission also protects across browsers/processes. The internal action supports an explicit `force=true` for future reclassification workflows; the normal UI skips unchanged current fingerprints.

## 10. Initial backfill scope and actual count

A read-only query of the connected Killer Kockpit project on 24 September 2026 found **213 posts**: 60 videos, 55 carousels and 98 images. Only **8** had stored exposure: 7 videos and 1 carousel. All eight had useful captions. **7** fall in the current 90-day publication window: 6 videos and 1 carousel; one measured video from 23 June is older.

The first refresh should therefore classify **8 posts in one batch**, retaining the older video's fingerprint but excluding that post from the current analytical window. The other 205 rows have no usable exposure and do not incur classification calls. Runtime eligibility is reevaluated, so counts can change after subsequent Meta syncs.

**Actual live classifications performed during this task: 0.** Only the production-connected Supabase project was available; no live AI/backfill writes were authorized. Automated provider responses, database rows and rendered page fixtures were synthetic.

The loader fails closed above 1,000 media or fingerprint rows instead of silently sampling. Each refresh classifies at most 200 eligible changed posts, newest first, in batches of ten; excess items are reported as deferred. Source hashes cover the bounded, redacted classification input. Metric-only changes do not trigger reclassification. Version/prompt/source changes do; a failed replacement does not let a stale fingerprint contribute to analytics.

## 11. Automation

Deferred. No cron or Meta sync coupling was added. A durable background job and material-input change detection should precede automated integration; a synchronous AI backfill must not delay or destabilize Meta sync.

## 12. Verification

Focused tests cover taxonomy/source validation, injection boundaries, mapping, batching/cost bounds, unchanged/versioned/forced classifications, batch failure isolation, medians and denominators, null counters, group thresholds, outliers, signal evidence, structured AI limits, experiment links, permissions, persistence, concurrency, page states and actual PostgreSQL RLS/constraints.

The complete build and TypeScript check pass using `NODE_OPTIONS=--max-old-space-size=8192` (the initial default 2 GB TypeScript process ran out of memory). Feature lint has no errors; the existing unused `_marketingPermissions` parameter remains in the shell.

All **46** Marketing Brain tests pass. The existing Organic/Marketing/Meta regression suites pass. The full suite with two workers reports **3,006 passed / 5 baseline failures** across 161 files. The five pre-existing failures in `__tests__/unit/api/gbp/sync.test.ts` are two token-resolution status assertions and three sync-outcome status assertions. All five were reproduced, unchanged, in a clean `git archive origin/main` export at `fc7356314822d3d80647d8fedf4e1432d2e89c1c`. They are outside this feature. Default-worker runs also intermittently timed out while importing existing Google/meeting modules; `npm test -- --maxWorkers=2` completes those tests without changing their code or timeout thresholds. Commit SHAs are included in the task completion report.

Visual QA used the real BrainView and MarketingShell rendered with synthetic data and built application CSS, with screenshots inspected at desktop and 390px mobile. Empty/populated states fit; the document has no horizontal overflow, and wide tables scroll within their cards. This is fixture rendering, not a live authenticated production refresh. Reproduce exports after building with `CREATIVE_BRAIN_QA_DIR=/private/tmp/kk-brain-preview npm test -- __tests__/unit/marketing/brain/page.test.tsx`.

## 13–15. Files and Git

All feature work is in `/Users/ulvankerstjerne/Documents/Claude/KK-marketing-brain`, branch `feat/marketing-brain-creative-v1`, based on current `origin/main` at `fc7356314822d3d80647d8fedf4e1432d2e89c1c`. The canonical worktree's existing files and changes were left alone. The branch is for review: no merge, deployment or production migration was performed.

Changed paths:

- `lib/marketing/brain/{taxonomy,types,classification,analytics,signals,generate}.ts`
- `lib/ai/{creative-classifier,creative-interpretation}.ts`
- `lib/actions/marketing/creative-intelligence.ts`
- `app/(marketing)/marketing/brain/{page,BrainView,RefreshButton}.tsx`
- `components/layout/MarketingShell.tsx`
- `supabase/migrations/20260924150815_marketing_creative_intelligence.sql`
- `__tests__/helpers/creative-brain.ts`
- `__tests__/unit/marketing/brain/{classification,analytics,signals,ai,actions,generate,migration}.test.ts` and `page.test.tsx`
- `docs/marketing-brain-v1.md`

## 16. Production activation steps — not executed

1. Review the feature branch and the known GBP baseline failures. Approve the release and production changes explicitly.
2. Apply **only** `20260924150815_marketing_creative_intelligence.sql` to the intended Supabase project via the normal reviewed migration process. Verify migration history first; do not replay other files from this branch or reapply this migration. Confirm RLS and grants.
3. Confirm the existing Anthropic API key and `BRIEF_AI_MODEL` or `MEETING_AI_MODEL` are configured, and the chosen model supports the SDK structured-output path. No new configuration variable is needed.
4. Deploy the reviewed application revision through the approved release process. Open `/marketing/brain` as an authorized Organic reader and as SUPER_ADMIN; confirm role gating and the initial empty state.
5. Once production fingerprint/run writes and the bounded AI call are authorized, click **Refresh Creative Intelligence** as SUPER_ADMIN. With the inspected dataset, expect 8 classified, 0 skipped, 0 failed, 0 deferred on the first successful run, and 7 measured posts in the analytical window. Inspect the stored evidence and suggestions. An absent repeated-pattern observation is legitimate with this small sample.
6. Refresh again: unchanged captions should produce 0 new classifications and 8 skips; counters/analytics can still refresh. Verify direct non-admin refresh is rejected and read access matches Organic.

## 17–18. Limits and recommendation

Caption-only classification, no image/video/transcript analysis, no human taxonomy correction UI, no demographic inference, no causal claim, no opaque score, no automated content publishing, and no experiment/audience/retargeting phases. Labels remain unreviewed AI classifications. Current static data is too sparse for a compatible static baseline. Lifetime exposure is affected by post age; `meta_ig_media.synced_at` also updates during metadata sync, so it is shown as content sync time and never claimed to be a metric refresh timestamp. Unknown freshness and observational sample limitations are visible in the page.

**GO for production review. NO-GO for activation until the migration/deployment and first live classification are explicitly approved and the release reviewer accepts or resolves the reproduced GBP baseline failures.** Live model output quality remains to be checked after activation; no synthetic test can validate the real provider's classifications on the actual library.

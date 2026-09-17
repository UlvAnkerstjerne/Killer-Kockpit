# GBP data foundation

## Existing foundation reused

The same Google OAuth connection (`business.manage`), `gbp_locations` identifiers and canonical `locations` FK, `gbp_reviews`, reply approval/publishing actions and `integration_sync_state` are used. No new integration identity, dashboard, Brain feature, Google profile write or automatic reply publishing was added.

The production database inspected on 17 September 2026 had eight canonical locations but zero GBP profiles, reviews and performance rows. No stored OAuth connection had the GBP scope. The existing integration was scaffolded, not populated. Canonical locations currently store identity/active state only; expected internal phone/website/hours do not yet exist there and are not fabricated by this change.

## Storage

- `gbp_locations`: typed external profile columns for resource name/title/store code, categories, website, phones, address, regular/special/additional hours, open status, metadata, description, service area and coordinates. Complete requested profile snapshot and `profile_synced_at` preserve Google's representation. Missing fields remain null. Sync never overwrites canonical linkage, internal store labels, active flag or review activation date.
- `gbp_location_metrics`: **existing** `(location_id,date)` daily table retained. Existing compatibility columns are widened to bigint. `metric_values` stores exact Google DailyMetric identifiers with decimal-string int64 values or null. `metric_breakdowns` preserves any returned sub-entity data separately, without inventing totals.
- `gbp_search_keywords_monthly`: one row per `(location_id,month,keyword)`, exact impressions **or** reported threshold, plus sync timestamp. A threshold of 15 means fewer than 15, not 15 impressions. Missing values remain null.
- `replace_gbp_keyword_month`: service-role-only, security-invoker transaction to upsert a completely downloaded month and remove queries no longer in that successful snapshot. A page failure never calls replacement; a database failure rolls back the whole month.

Every dataset joins `gbp_locations.id` → `gbp_locations.location_id` → canonical `locations.id`. New data has no OAuth-user ownership. RLS and grants restrict new storage to the institutional server-side service client. Checkpoints use `user_id IS NULL`; any legacy review success watermark is adopted without deleting legacy state.

## Sync contract

`POST /api/google/gbp/sync`: exact `Authorization: Bearer <CRON_SECRET>` required. The legacy `/api/gbp/sync` POST remains an alias. The new route's GET follows the existing GA4/GSC/Ads authenticated SUPER_ADMIN manual-trigger convention. The existing Marketing manual action reaches the same orchestrator.

A compare-and-swap 30-minute institutional lease prevents overlapping old/new/manual runs. The run checks a 20-minute work budget and provider calls have 30-second timeouts. A busy run returns `skipped:true`. Failures return non-2xx, safe machine-readable Google errors and stage-specific diagnostics, never raw OAuth errors, tokens or headers.

Profiles are fully paginated and refreshed on every run. New profiles are stored inactive and unmapped; there is no runtime name matching. An operator must verify real Google IDs against canonical stores before linking and activating. Google-declared duplicates, duplicate Google IDs and ambiguous active canonical links are excluded from ingestion. A missing profile in discovery is reported; it never deletes data or deactivates a store automatically.

Daily backfill requests the prior 18 calendar months through yesterday, in windows of at most 31 days. This is the requested window, **not a claim that Google has returned 18 months for these profiles**. Subsequent runs refresh the 14 completed Copenhagen calendar days. Keyword backfill requests the previous 18 completed months one at a time; subsequent runs refresh the previous two completed months. Google's monthly endpoint aggregates the whole requested range, so a separate request per month is essential. Actual availability must be verified after GBP access is connected.

Each profile/location, daily, keyword and review stage has independent state. Backfill checkpoints advance only after successful writes. A failed backfill resumes after its last saved chunk/month and cannot become complete merely because an attempt ran. Successful stages survive failures elsewhere.

Review import/draft helpers were extracted without changing their activation cutoff, seven-day grace, draft prompt, approval or publish rules. Initial review sync exhausts pagination; incremental sync follows pages until the previous success watermark with a seven-day overlap. It no longer marks state syncing before deciding first-run status or assumes one page covers every incremental update. External replies keep the existing handling. Draft retry remains manual through the existing workflow.

## Metric interpretation

All 11 identifiers in Google's current DailyMetric enum are requested: four desktop/mobile Search/Maps impressions, website clicks, call clicks, direction requests, bookings, food orders, menu clicks and legacy conversations. A profile may not supply every series. **An absent metric/date is unavailable/null.** On an actual dated point, Google explicitly defines omitted `value` as zero; that is stored as zero. Total impressions is null unless all four underlying values are known. Legacy conversation availability must not be assumed merely because the enum remains documented.

References:
- [Performance request/response contract](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries)
- [DailyMetric identifiers](https://developers.google.com/my-business/reference/performance/rest/v1/DailyMetric)
- [DatedValue zero semantics](https://developers.google.com/my-business/reference/performance/rest/v1/TimeSeries)
- [Monthly aggregation and thresholds](https://developers.google.com/my-business/reference/performance/rest/v1/locations.searchkeywords.impressions.monthly/list)

## Railway activation

Only activate after a real mapped production sync succeeds. One proposed daily `gbp-daily-sync-cron` at **06:45 UTC**, using the same `curlimages/curl` pattern as Ads/Meta, restart policy NEVER and POST to the new endpoint. Its `CRON_SECRET` variable must be the reference `${{just-fulfillment.CRON_SECRET}}`, never a copied value. A 1,500-second curl timeout accommodates the resumable backfill; routine rolling sync should be much shorter. No pre-existing GBP Railway cron was present during inspection, so none needs parallel ownership or removal.

## Validation

Targeted automated tests cover API paths/envelopes/pagination, profile fields, persistent mapping, unavailable versus zero, threshold versus exact counts, fractional-free int64 precision, incremental windows, idempotent reruns, resumable backfills, partial API/database failures, lease exclusion, authorization, safe errors and existing review/reply behaviour.

A rolled-back transaction against production validated the actual migration: keyword idempotency, corrected/deleted keyword replacement, failed-replacement atomicity, null-input rejection, bigint precision and service-only RPC privileges. No validation fixture rows remain. New RLS-enabled/no-browser-policy informational advice is intentional for institutional storage; no new security warnings were introduced.

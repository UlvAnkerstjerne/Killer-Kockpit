# Google Ads campaign performance sync

This is company-wide data ingestion only. The Paid UI is unchanged.

The sync reuses `probeGoogleAds`, `hasGoogleAdsScope` and `getGoogleOAuth2Client` from the existing integration. It selects an active SUPER_ADMIN credential owner at runtime, and only ingests the verified connected customer `8582465933`. It uses Google Ads API v25 read-only GAQL search; it does not modify campaigns, goals, permissions or OAuth configuration. Manager-account traversal and additional customers are outside this scope.

## Storage

- `google_ads_accounts`: account ID/name, source currency, source time zone and conversion-owner account.
- `google_ads_campaigns`: campaign ID/name/status, channel/subtype, bidding strategy, Google conversion goals and goal configuration, including any custom goal's action resources. These are current settings, not reconstructed historical objectives.
- `google_ads_conversion_actions`: source action resource/ID/name, category, type, origin, status and primary-for-goal setting. Full resource names distinguish cross-account conversion actions.
- `google_ads_campaign_daily`: one row per customer/campaign/date; impressions, clicks, exact cost micros and generated currency-unit cost, conversions/value, all-conversions/value, and a JSON array of conversion-action result counts/values for that day.

All four tables have RLS enabled, no browser policies, and explicit service-role access. Existing reporting permission patterns must be enforced by any future read action. No credential values are stored in these tables.

## Results interpretation

Google's action names and categories are retained so a future view can label an actual `SUBMIT_LEAD_FORM` result as a lead or show a source action name. A campaign may optimize toward several goals. The sync never invents a single campaign objective or treats every conversion as a lead.

`conversions` and `all_conversions` remain distinct. Fractional attribution is preserved. Primary-for-goal metadata alone is insufficient to reconstruct the reported conversions column, especially with custom goals; use the returned metrics.

For a selected, clearly identified result type, calculate cost per result from aggregate campaign spend divided by aggregate results. Return no ratio when results are zero. Spend is recorded once in the daily total, never repeated in conversion-action breakdowns. Currency comes from the account, never an assumed DKK default.

## Sync behavior

The first successful run backfills exactly 90 completed calendar days in the Ads account's time zone. Later runs refresh exactly 14 completed days, ending yesterday. Google can restate conversion attribution; this rolling refresh captures recent corrections but does not automatically revise dates older than 14 days.

All Search pages are consumed. Conversion-action metrics use a separate query because cost/click metrics cannot be mixed with that segmentation. All API reads must succeed before reporting writes start. Data is upserted in checked batches of 500. A failed batch leaves the last-success cursor unchanged and is safe to retry. A failed initial backfill stays a backfill until fully successful.

Google suppresses all-zero daily rows. A complete refreshed report resets previously stored days omitted by Google to zero and replaces their conversion breakdown with an empty array. It does not manufacture a dense history of zero rows before a campaign existed. No keyword, search-term or ad-level data is requested.

Institutional state uses `integration_sync_state` with `user_id IS NULL` and key `google_ads_campaign_daily:8582465933`. Compare-and-swap claims and the existing institutional unique index prevent concurrent cron/manual jobs from claiming the same run. A 15-minute lease allows recovery from abandoned work.

## Triggers and production gate

- `POST /api/google/ads/sync` requires `Authorization: Bearer <main CRON_SECRET>`.
- `GET /api/google/ads/sync` follows the existing GA4/GSC SUPER_ADMIN session-only manual trigger pattern. Responses are private/no-store.
- Failures return HTTP 502 with bounded diagnostics. Raw OAuth/Gaxios errors and request headers are never returned or logged by this sync.

The initial real-account inspection on 17 September 2026 found accessible customer `8582465933`, but every campaign and conversion query was rejected with `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`. Account discovery is not proof of reporting access. No real campaign/result counts are claimed until Google accepts reporting requests.

Only activate `google-ads-daily-sync-cron` after a real sync succeeds. Intended once-daily UTC schedule: `15 6 * * *`. Use a `curlimages/curl` service with restart policy `NEVER` and the main-app reference `CRON_SECRET=${{just-fulfillment.CRON_SECRET}}`, never a copied secret. Its command posts to `https://kockpit.killerkebab.com/api/google/ads/sync` and exits; non-2xx responses must cause failure.

## API references

- [Google Ads API access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Google's Cloud-project access migration and production-access error](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [Conversion goals and primary versus all conversions](https://developers.google.com/google-ads/api/docs/conversions/goals/overview)
- [Zero-metric reporting behavior](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics)
- [Search pagination](https://developers.google.com/google-ads/api/docs/reporting/paging)

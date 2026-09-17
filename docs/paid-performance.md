# Unified Paid performance

`/marketing/paid` reads existing Meta and Google Ads reporting tables. It does not call platform APIs or modify sync, schema, OAuth, cron, budgets or campaigns.

## Read boundary and periods

The server-only read model authenticates with `getCurrentUser`, enforces Marketing workspace access and `paid_manage`, and uses the same SUPER_ADMIN bypass as the existing Meta actions. Database queries run only after these checks. It returns aggregated campaign data to the client, never credentials or unaggregated daily rows.

Both platforms use 28 (default) or 90 completed calendar days ending yesterday in Europe/Copenhagen, matching the connected Google account. Date bounds appear on the page. Reads are paginated with a stable unique order and the actual returned offset, including when PostgREST imposes a lower row cap. Provider errors are displayed independently and never presented as zero performance.

## Google primary results

A standard primary action must match both category and origin of a biddable stored campaign goal and have `primary_for_goal=true`. Google already reflects inherited customer defaults in the campaign goal rows. Explicit custom-goal actions qualify regardless of their primary flag; custom goals are **additive** to biddable standard goals. An incomplete custom snapshot never implies membership.

Counts use the action's reported `conversions`, not `all_conversions`. Each action remains separate, even when several actions share a category. Multiple observed primary results appear together with their own cost/result. There is no blended conversion count or artificial ranking of different goals. A campaign spending without results shows its known configured result types at zero and an em dash for cost/result. If membership cannot be established, the overview says the primary goal is unavailable and details show source-reported actions.

Cost/result is total campaign spend divided by that individual result count. It is not a spend allocation across goals. Integer cost micros are summed before conversion to currency units; fractional attribution is retained, displayed to two decimals, and available to six decimals in titles. Full integer counts appear in details. Currency comes from account metadata. The summary keeps different currencies separate.

Details distinguish current primary goals from other reported actions and show both conversion metrics and source values. Purchase values are formatted in account currency; assigned values for local actions are labelled as reported values, not revenue. Goal settings are current snapshots; historical optimization settings are not reconstructed.

References: [Google goal definitions](https://developers.google.com/google-ads/api/docs/conversions/goals/overview), [custom and standard campaign goals](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals).

## Meta and presentation

The existing Awareness impressions/CPM, Traffic LPV threshold with link-click fallback, Engagement results, and default metrics are retained. Duplicate alternate LPV action names are not added together. Daily frequency is explicitly labelled as a daily average because summing daily reach does not produce deduplicated period reach.

All platforms and statuses are included by default when the selected period has activity. Active campaigns appear first. Paused and removed historical campaigns remain available; campaigns without activity require an explicit checkbox. Existing internal `ZZ ` Meta campaigns remain excluded. Platform, period and status controls preserve one another in URL parameters.

Paid keeps Marketing's existing desktop navigation and warm-grey campaign headers. Only the Paid route gets a compact mobile menu and narrower content padding; other Marketing routes keep their layout. Details expand in place with accessible buttons.

## Verified production data on 17 September 2026

For 19 June–16 September, the independent database aggregation returns DKK 31,760.041363: Duckert: P-Max DKK 14,436.001399 and Nbab Summer 2026 DKK 17,324.039964. Both are paused Performance Max campaigns. Nbab's primary directions count is 3,259 (DKK 5.315753 per request). Duckert has five separate primary actions: 8,033 directions, 137.421391 add-to-cart conversions, 76 click-to-call actions, two purchases and two order/app clicks. Its secondary checkout actions are not included in primary results. These are verification observations, not hardcoded dashboard data.

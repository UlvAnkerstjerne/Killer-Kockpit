# GBP Reviews v1 — review handoff

Branch: `feat/gbp-review-desk-v1`, based on `origin/main` at `c5dd80c`.
Worktree: `/Users/ulvankerstjerne/Documents/Claude/KK-gbp-review-desk`.
Canonical checkout, production database, deployment configuration, OAuth and cron schedules remain untouched. No real review replies were published during implementation or testing.

## Architecture and schema

The existing GBP sync prepares review data and drafts. Morning Brief reads a bounded DB queue; the six GBP health cards read latest daily snapshots. Both individual and batch publication use one shared publisher and per-reply SQL transitions. Existing service-role access remains protected by server-side Marketing authorization.

Three migration files, to apply in this order:

1. `20260923194341_gbp_review_health_daily.sql`: daily health table keyed by `(location_id, snapshot_date)`, unrounded numeric Google rating, Google count, capture timestamp, recent and unanswered counts; aggregate/upsert RPC.
2. `20260923194557_gbp_review_desk.sql`: per-user session state; two publication-claim fields on existing replies; indexes for the queue and pending publications; bounded queue, approval/claim, and completion RPCs.
3. `20260923200449_gbp_reply_voice_examples.sql`: partial index on approver ID and recent approved/published replies.

New tables have RLS enabled, explicit service-role grants and no direct anonymous/authenticated access. New functions are `SECURITY INVOKER`, with execution revoked from public/browser roles and granted only to `service_role`. No migration has been applied to a connected database. Tests execute them in isolated in-memory PostgreSQL.

## Health snapshots

A successful location review sync captures `averageRating` and `totalReviewCount` from its existing Google responses. It saves a snapshot only after pagination/import completes; API, pagination or storage failures cannot write a fake successful snapshot. SQL upserts one row per Copenhagen date and location and preserves Google's numeric precision. Earlier days remain available for future history charts.

`new_reviews_7d` covers today and the previous six Copenhagen calendar dates, through the capture timestamp. `unanswered_count` excludes real existing reply text and confirmed `published` / `externally_published` states; AI drafts and approvals are unanswered. SQL calculates counts without transferring review history through PostgREST.

The six existing cards retain their metrics, appearance and click-through behavior. They perform six parallel indexed latest-row queries. Before snapshots exist, metrics show “—”; there is no history-fetching fallback. The unused milestone helper returns a mathematical estimate under ordinary nearest-tenth rounding, or unavailable for insufficient precision/pathological inputs; it makes no claim about Google's display algorithm.

## Queue, first use and watermark

First authorized use atomically creates a state row with an immutable `started_at`. Only reviews created on/after `started_at - 7 days` can enter that user's desk. Historical imports retain their old review date and do not become eligible merely because they were imported today.

All unanswered reviews within this fixed era remain eligible, including missing drafts, excluded items, rejected drafts and publication failures. This is the union of new reviews and unresolved work; `last_completed_at` distinguishes newly received/imported reviews from carried-over items rather than hiding unanswered work. Later imports with an eligible review date appear even if their date predates the watermark. Published and external replies are excluded in SQL before pagination.

The DB returns at most 26 rows; the page displays 25 and uses the extra row for a “Load more reviews” cursor. Pagination is ordered by `(review_created_at, id)`. Read access requires Marketing access plus `reviews_manage` or `reviews_approve`, or SUPER_ADMIN. Editing, retrying drafts and publishing require `reviews_approve` or SUPER_ADMIN.

## Batch publication and recovery

Cards show store, stars, reviewer, date, review text, prepared reply, editable text and inclusion. Ready replies start selected; rating-only reviews and missing drafts are explicit. Draft generation runs only on sync or an authorized retry, never on render.

“Publish X replies” is the human approval. The action validates 1–50 distinct reply IDs and nonempty text up to 4096 characters. Actor identity is always resolved server-side. Every reply is checked against DB state, active/mapped location, Google resource identity and the user's desk era. One OAuth client is acquired for the batch. Google writes are sequential.

Each approval and claim is atomic with its approval audit event. Each result commits separately; there is no transaction around external Google writes. Successful replies disappear immediately. Failed/unresolved rows keep their edited text and useful errors; retrying does not resend already completed replies. Excluded rows retain their local edits and selection.

After Google confirms success, one local transaction updates `gbp_review_replies`, the review's `existing_reply_text` and reply timestamp, today's unanswered snapshot count, and the publication audit event. The original `draft_text` survives. The next sync still reconciles Google's source of truth.

A batch with at least one success advances the user's watermark monotonically. An entirely failed batch does not. A watermark write failure is reported separately without losing per-reply outcomes.

A publication claim prevents competing browser sessions and the individual workflow from changing or sending an in-flight reply. Local completion is idempotent and can retry without another Google write. If local confirmation cannot be saved, the UI retains a pending-confirmation state. After 30 minutes, sync checks Google before allowing retry. An abandoned claim triggers a one-off full location review traversal so even older reviews outside the normal incremental overlap can be reconciled. Confirmed external replies clear the claim; confirmed absent replies become retryable failures. An item no longer returned by Google remains unresolved for operator review.

## Reply voice

Prompt version is `v2`. Replies are warm, direct, short, specific and conversational, with usually 1–2 sentences for positive reviews and 2–3 concise sentences for negative reviews. Rating-only replies remain very short. Corporate stock phrases, invented details/superlatives, keyword stuffing, defensive arguments and promises of compensation/investigations are explicitly discouraged or forbidden.

Danish and English match the review. Other clear languages retain the prior matching convention, with English when uncertain. Product/location wording is contextual, normally at most one phrase of each kind; no search-ranking guarantees.

Once per sync, the server resolves the active `app_users` record whose email is exactly `ulv@killerkebab.com`, matching the existing email-based actor lookup. Reply approvals reference that record's `id`, not its `auth_user_id`. A bounded query filters by Ulv's ID before selecting his 24 most recent approved/published replies from the past 90 days. Up to six short examples are selected, preferring edits where `draft_text` differs from `approved_text`. Examples include bounded review/rating context, original draft and final wording. Other approvers are excluded, including other admins. Fewer than two usable Ulv examples, a missing/inactive identity or a query error leave drafting on the base brand context; there is no fallback to other writers. This is in-context adaptation, not model retraining.

Review text and names—including review text attached to examples—remain untrusted data. Examples cannot override system rules or establish facts about a different reviewer. No tools or secrets are provided to the drafting model by this feature.

## Page-load impact

The desk fetch runs alongside existing Morning Brief inputs. Its own query is bounded and indexed, with no Google or AI requests on render. The summary cards no longer page through thousands of reviews. Sync adds SQL aggregates, one indexed identity lookup and one bounded example query, reused across all locations; only interrupted-publication recovery can require an exceptional full location traversal. Existing unrelated Morning Brief/platform queries are unchanged.

## Verification

- Focused tests cover Google metadata, failure boundaries, real SQL upserts/counts with 3,883 synthetic reviews, calendar dates, precision, grants/RLS, queue boundaries/pagination, permission enforcement, three-success batches, partial failures, local state/audits, uncertain claims, individual workflow, voice rules and bounded/reused examples.
- Real component and app styles were inspected in the browser with synthetic fixtures. Inline edit, original-draft disclosure, missing-draft retry, include/exclude counts, partial-success removal, retained failed text and excluded rows were verified. No production reviewer content or live Google/AI calls were used.
- Full-suite status and final commit ID are recorded in the task's final report. Five failures in `__tests__/unit/api/gbp/sync.test.ts` reproduce unchanged in a clean export of `origin/main`. Their fixtures expect an older sync response contract; they were not changed here.
- The final hardening pass successfully ran `npm run build` with `NODE_OPTIONS` unset. No deployment memory change is needed. PGlite is a dev dependency referenced only by tests; it is absent from production output traces. The existing broad TypeScript include pattern also checks test files, but no build-memory regression was demonstrated, so build/TypeScript/Railway configuration is unchanged.

## Migration release verification

The release test replays every preceding repository migration through `20260923110000_meeting_attachment_source_type.sql`, matching `origin/main` at `c5dd80c696673de355a4ede4e438bc661537891a`. SQL files execute unchanged in in-memory PGlite with pgcrypto. Supabase roles/auth helpers are modeled locally; two historical seed migrations receive synthetic prerequisite users and an audit template. This verifies the versioned main schema, not out-of-band production drift.

All three release migrations then apply in timestamp order: health, desk, voice index. The desk completion function depends on the health table. The test preserves all existing table rows, including every reply status, exercises the real app-user/approval/audit foreign keys and role enum, rejects invalid claim pairs and snapshot/session values, and executes all four new functions as service_role. Broad modeled Supabase default grants are explicitly revoked for browser roles; both new tables have RLS and no browser policies. The approver-first voice index matches the Ulv-only bounded lookup.

The release adds two tables, two nullable claim columns, constraints, functions and indexes. It does not delete or rewrite existing content. Existing replies satisfy the new pair constraint because both new columns start null. DDL and ordinary index creation take locks and may briefly delay writes; schedule the release accordingly. A transaction rollback before use was verified to remove the new DDL while preserving existing rows.

For rollback after use, keep the additive schema and retained audit/session/snapshot data. Pause publication and reconcile outstanding claims with Google before restoring older application workers, which do not understand the claim protocol. Dropping claim/state columns can discard recovery evidence; Google replies already published cannot be undone by a database rollback. No production migration, data change or deployment was performed during verification.

## Required before production

1. Review the branch and these three migrations. Adaptive voice is restricted to Ulv's approvals.
2. Apply the migration files in order through the normal approved database release process. They are additive and must precede deploying the application changes.
3. Deploy the reviewed branch through the normal release process only after explicit approval. No new environment variables, OAuth scopes or cron changes are required.
4. Run or await the existing GBP sync. Verify snapshots for the mapped locations and inspect sync errors before relying on the card values. An absent snapshot stays unavailable until successful sync.
5. Open Morning Brief as Ulv to initialize his seven-day desk era. Verify the queue is recent, check read-only versus approval permissions, and review the draft voice.
6. When ready, a human can explicitly approve a small real batch. Verify Google replies, audit records, disappearance of successes and the updated unanswered count. Verify the next sync reconciles correctly and uses the new approval examples.

Review risks: the Google API may provide only one-decimal averages; milestones are then unavailable. Sync-time daily counts are snapshots, with today's unanswered count refreshed on confirmed publication. Browser-local excluded text is retained during the current desk interaction, not persisted across a full reload. Uncertain external/local outcomes require reconciliation rather than blind retry. Baseline failing tests should be repaired separately before making a completely green suite a release gate.

## Files changed

Application: `app/(marketing)/marketing/page.tsx`, `ReviewDesk.tsx`, and `google-business-profile/GbpDashboard.tsx`.

Actions: `lib/actions/marketing/gbp-reviews.ts`, `gbp-review-desk.ts`.

GBP modules: `lib/gbp/review-health.ts`, `rating-milestone.ts`, `review-permissions.ts`, `review-desk-types.ts`, `review-publish.ts`, `reply-examples.ts`, `reviews-sync.ts`, `sync.ts`.

AI/voice: `lib/ai/draft-review-reply.ts`, `lib/marketing/gbp/brand-context.ts`.

Schema: the three migrations listed above.

Tests: `__tests__/helpers/gbp-db.ts`, `gbp-postgres.ts`, `gbp-postgres-client.ts`; unit tests for review health, health SQL, desk integration, reply examples, reviews sync, sync orchestration, GBP review actions, summary actions and AI drafting.

Tooling: `package.json` / `package-lock.json` add pinned development-only `@electric-sql/pglite` for isolated SQL tests. Documentation: this handoff.

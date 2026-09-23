import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { ACTOR, DESK_MIGRATION, HEALTH_MIGRATION, LOCATION, replyId, reviewDatabase, reviewId, seedLocation, seedReview } from '../../helpers/gbp-postgres'
import { postgresClient } from '../../helpers/gbp-postgres-client'
const mocks = vi.hoisted(() => ({ user: vi.fn(), db: vi.fn(), oauth: vi.fn(), publish: vi.fn(), draft: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.db }))
vi.mock('@/lib/google/auth', () => ({ getGoogleOAuth2Client: mocks.oauth, hasGbpScope: (scopes: string[]) => scopes.includes('gbp') }))
vi.mock('@/lib/google/gbp-client', () => ({ publishGbpReviewReply: mocks.publish }))
vi.mock('@/lib/gbp/sync', () => ({ runGbpSync: vi.fn() }))
vi.mock('@/lib/ai/draft-review-reply', () => ({ draftReviewReply: mocks.draft }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { getGbpReviewDesk, publishGbpReviewBatch, retryGbpReviewDeskDraft } from '@/lib/actions/marketing/gbp-review-desk'
import { approveGbpReply, rejectGbpReply, publishGbpReply } from '@/lib/actions/marketing/gbp-reviews'
let db: PGlite, client: ReturnType<typeof postgresClient>
const recent = () => new Date(Date.now() - 86400_000).toISOString()
const choices = (ids: number[]) => ids.map(n => ({ replyId: replyId(n), approvedText: `Human edit ${n}` }))
beforeAll(async () => {
  db = await reviewDatabase([HEALTH_MIGRATION, DESK_MIGRATION, '20260923200449_gbp_reply_voice_examples.sql'])
  await db.exec('CREATE TABLE google_oauth_tokens (user_id uuid, scopes text[])')
}, 30_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  vi.clearAllMocks()
  await db.exec('TRUNCATE app_users,gbp_locations,gbp_reviews,gbp_review_replies,gbp_review_session_state,audit_events,google_oauth_tokens CASCADE')
  await seedLocation(db)
  await db.query<Record<string, unknown>>(`INSERT INTO google_oauth_tokens VALUES ($1, ARRAY['gbp'])`, [ACTOR])
  client = postgresClient(db); mocks.db.mockReturnValue(client)
  mocks.user.mockResolvedValue({ id: ACTOR, role: 'SUPER_ADMIN', marketing_access: true })
  mocks.oauth.mockResolvedValue({ synthetic: true }); mocks.publish.mockResolvedValue({ ok: true })
})

describe('Morning Review Desk scope and permissions', () => {
  it('persists a seven-day first-run floor and never exposes the historical backlog', async () => {
    await seedReview(db, 1, '2020-01-01T00:00:00Z', 'awaiting_review')
    await seedReview(db, 2, recent(), 'new')
    const first = await getGbpReviewDesk()
    expect(first.reviews.map(row => row.id)).toEqual([reviewId(2)])
    const before = await db.query<Record<string, unknown>>('SELECT started_at FROM gbp_review_session_state')
    await getGbpReviewDesk()
    expect((await db.query<Record<string, unknown>>('SELECT started_at FROM gbp_review_session_state')).rows).toEqual(before.rows)
    expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.draft).not.toHaveBeenCalled()
  })
  it('shows new arrivals, late imports and unresolved reviews after watermark advancement', async () => {
    await seedReview(db, 1, recent(), 'awaiting_review')
    await seedReview(db, 2, recent(), 'new')
    await seedReview(db, 3, recent(), 'rejected')
    await getGbpReviewDesk(); await publishGbpReviewBatch(choices([1]))
    await seedReview(db, 4, new Date(Date.now() + 1).toISOString(), 'awaiting_review')
    await seedReview(db, 5, recent(), 'awaiting_review') // Imported after completing; older review date.
    const queue = await getGbpReviewDesk()
    expect(new Set(queue.reviews.map(row => row.id))).toEqual(new Set([2, 3, 4, 5].map(reviewId)))
    expect(queue.reviews.find(row => row.id === reviewId(2))?.new_since_session).toBe(false)
    expect(queue.reviews.find(row => row.id === reviewId(5))?.new_since_session).toBe(true)
  })
  it('excludes published, externally published, and existing external replies', async () => {
    await seedReview(db, 1, recent(), 'published'); await seedReview(db, 2, recent(), 'externally_published')
    await seedReview(db, 3, recent(), undefined, 'Synthetic external reply')
    expect((await getGbpReviewDesk()).reviews).toEqual([])
  })
  it('returns only 25 at a time using deterministic keyset pagination', async () => {
    await db.query<Record<string, unknown>>(`INSERT INTO gbp_reviews (id,google_review_id,location_id,star_rating,review_created_at,review_updated_at)
      SELECT gen_random_uuid(), 'synthetic-history-' || n,$1,5,'2020-01-01','2020-01-01' FROM generate_series(1,3883) n`, [LOCATION])
    for (let n = 1; n <= 30; n++) await seedReview(db, n, recent(), 'awaiting_review')
    const first = await getGbpReviewDesk(), second = await getGbpReviewDesk(first.nextCursor!)
    expect(first.reviews).toHaveLength(25); expect(second.reviews).toHaveLength(5); expect(second.nextCursor).toBeNull()
    expect(new Set([...first.reviews, ...second.reviews].map(row => row.id)).size).toBe(30)
    expect(client.calls.some(call => call.table === 'gbp_reviews')).toBe(false)
  })
  it('enforces read and publish permissions and rejects caller-supplied actor identity', async () => {
    await seedReview(db, 1, recent(), 'awaiting_review'); await getGbpReviewDesk()
    mocks.user.mockResolvedValue(null)
    expect((await getGbpReviewDesk()).reviews).toEqual([])
    expect((await publishGbpReviewBatch(choices([1]))).error).toBeTruthy()
    mocks.user.mockResolvedValue({ id: ACTOR, role: 'MEMBER', marketing_access: true })
    expect((await getGbpReviewDesk()).reviews).toEqual([])
    await db.query<Record<string, unknown>>(`INSERT INTO user_marketing_permissions VALUES ($1,'reviews_manage')`, [ACTOR])
    expect((await getGbpReviewDesk()).reviews).toHaveLength(1)
    expect((await getGbpReviewDesk()).canApprove).toBe(false)
    expect((await publishGbpReviewBatch(choices([1]))).error).toContain('reviews_approve')
    mocks.user.mockResolvedValue({ id: ACTOR, role: 'SUPER_ADMIN' })
    expect((await publishGbpReviewBatch([{ ...choices([1])[0], actorId: 'forged' }] as never)).error).toBeTruthy()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('denies direct authenticated/anon access to state and publication RPCs', async () => {
    for (const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      await expect(db.query<Record<string, unknown>>('SELECT * FROM gbp_review_session_state')).rejects.toThrow('permission denied')
      await expect(db.query<Record<string, unknown>>('SELECT get_gbp_review_desk($1)', [ACTOR])).rejects.toThrow('permission denied')
      await expect(db.query<Record<string, unknown>>('SELECT claim_gbp_reply_publish($1,$2,$3,true)', [replyId(1), ACTOR, 'text'])).rejects.toThrow('permission denied')
      await expect(db.query<Record<string, unknown>>('SELECT finish_gbp_reply_publish($1,$2,$3)', [replyId(1), replyId(2), ACTOR])).rejects.toThrow('permission denied')
      await db.exec('RESET ROLE')
    }
  })
})

describe('batch approval and publication', () => {
  async function prepare() {
    for (const n of [1, 2, 3]) await seedReview(db, n, recent(), 'awaiting_review')
    await getGbpReviewDesk()
  }
  it('publishes three edited replies sequentially with one OAuth client, updates local rows and audits each', async () => {
    await prepare()
    let active = 0, maximum = 0
    mocks.publish.mockImplementation(async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return { ok: true } })
    await db.query<Record<string, unknown>>('SELECT capture_gbp_review_health($1,4.57,3883)', [LOCATION])
    const result = await publishGbpReviewBatch(choices([1, 2, 3]))
    expect(result.data?.results.map(row => row.status)).toEqual(['published','published','published'])
    expect(maximum).toBe(1); expect(mocks.oauth).toHaveBeenCalledTimes(1)
    expect(mocks.publish.mock.calls.map(call => call[2])).toEqual(['Human edit 1','Human edit 2','Human edit 3'])
    expect((await getGbpReviewDesk()).reviews).toEqual([])
    expect((await db.query<Record<string, unknown>>('SELECT existing_reply_text FROM gbp_reviews ORDER BY id')).rows.map(row => row.existing_reply_text)).toEqual(['Human edit 1','Human edit 2','Human edit 3'])
    const replies = (await db.query<Record<string, unknown>>('SELECT draft_text,approved_by_user_id,publish_attempt_id FROM gbp_review_replies')).rows
    expect(replies.every(row => row.draft_text === 'Synthetic draft' && row.approved_by_user_id === ACTOR && !row.publish_attempt_id)).toBe(true)
    expect((await db.query<Record<string, unknown>>('SELECT * FROM audit_events')).rows).toHaveLength(6)
    expect((await db.query<Record<string, unknown>>('SELECT unanswered_count FROM gbp_review_health_daily')).rows[0].unanswered_count).toBe(0)
    expect((await db.query<Record<string, unknown>>('SELECT last_completed_at FROM gbp_review_session_state')).rows[0].last_completed_at).toBeTruthy()
  })
  it('keeps only failures/unresolved items and retries without resending successes', async () => {
    await prepare()
    mocks.publish.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'Google temporarily unavailable' }).mockResolvedValueOnce({ ok: true })
    const result = await publishGbpReviewBatch(choices([1, 2, 3]))
    expect(result.data?.results.map(row => row.status)).toEqual(['published','publish_failed','published'])
    const queue = (await getGbpReviewDesk()).reviews
    expect(queue.map(row => row.id)).toEqual([reviewId(2)]); expect(queue[0].publish_error).toContain('temporarily')
    const local = (await db.query<Record<string, unknown>>('SELECT existing_reply_text FROM gbp_reviews WHERE id=$1', [reviewId(2)])).rows[0]
    expect(local.existing_reply_text).toBeNull()
    await publishGbpReviewBatch(choices([1, 2, 3]))
    expect(mocks.publish).toHaveBeenCalledTimes(4)
    expect((await getGbpReviewDesk()).reviews).toEqual([])
  })
  it('does not advance session completion when every publication fails', async () => {
    await prepare(); mocks.publish.mockResolvedValue({ ok: false, error: 'Synthetic failure' })
    await publishGbpReviewBatch(choices([1, 2, 3]))
    expect((await db.query<Record<string, unknown>>('SELECT last_completed_at FROM gbp_review_session_state')).rows[0].last_completed_at).toBeNull()
    expect((await getGbpReviewDesk()).reviews).toHaveLength(3)
  })
  it('rejects missing, historical, undrafted and invalid selections without Google writes', async () => {
    await prepare(); await seedReview(db, 4, '2020-01-01', 'awaiting_review'); await seedReview(db, 5, recent(), 'new')
    const result = await publishGbpReviewBatch(choices([4, 5, 6]))
    expect(result.data?.results.every(row => row.status === 'invalid')).toBe(true)
    for (const items of [[], choices([1, 1]), [{ replyId: replyId(1), approvedText: ' ' }], [{ replyId: replyId(1), approvedText: 'a'.repeat(4097) }]]) {
      expect((await publishGbpReviewBatch(items)).error).toBeTruthy()
    }
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('retains an uncertain claim if Google succeeds but local storage fails, blocking replay', async () => {
    await prepare(); client.failures.finish_gbp_reply_publish = 2
    const result = await publishGbpReviewBatch(choices([1]))
    expect(result.data?.results[0].status).toBe('confirmation_pending')
    expect((await getGbpReviewDesk()).reviews[0].publish_started_at).toBeTruthy()
    await publishGbpReviewBatch(choices([1])); expect(mocks.publish).toHaveBeenCalledTimes(1)
  })
  it('refuses simultaneous claims and protects in-flight text from individual actions', async () => {
    await prepare()
    const claim = await client.rpc('claim_gbp_reply_publish', { p_reply_id: replyId(1), p_actor_id: ACTOR, p_approved_text: 'Human edit', p_desk_only: true })
    expect(claim.error).toBeNull()
    expect((await publishGbpReviewBatch(choices([1]))).data?.results[0].error).toContain('pending confirmation')
    expect((await rejectGbpReply(replyId(1), 'No')).error).toBeTruthy()
    expect((await publishGbpReply(replyId(1))).error).toBeTruthy()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('preserves individual approve, reject, reapprove and publish with an audit trail', async () => {
    await prepare()
    expect((await rejectGbpReply(replyId(1), 'Too formal')).data?.status).toBe('rejected')
    expect((await approveGbpReply(replyId(1), 'Human individual edit')).data?.status).toBe('approved')
    expect((await publishGbpReply(replyId(1))).data?.status).toBe('published')
    expect(mocks.publish).toHaveBeenCalledWith(expect.anything(), 'accounts/1/locations/2/reviews/synthetic-1', 'Human individual edit')
    expect((await db.query<Record<string, unknown>>('SELECT existing_reply_text FROM gbp_reviews WHERE id=$1', [reviewId(1)])).rows[0].existing_reply_text).toBe('Human individual edit')
  })
  it('does not retry a draft over an existing approval or a historical review', async () => {
    await prepare(); await seedReview(db, 4, '2020-01-01', 'new')
    expect((await retryGbpReviewDeskDraft(reviewId(1))).error).toBeTruthy()
    expect((await retryGbpReviewDeskDraft(reviewId(4))).error).toBeTruthy()
    expect(mocks.draft).not.toHaveBeenCalled()
  })
})

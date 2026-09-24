import { describe, expect, it, vi } from 'vitest'
import { loadReviewReplyExamples } from '@/lib/gbp/reply-examples'
import { gbpDb } from '../../helpers/gbp-db'

const now = new Date('2026-09-23T04:45:00Z')
const ulv = { id: 'ulv-app-id', auth_user_id: 'ulv-auth-id', email: 'ulv@killerkebab.com', active: true }
const reply = (n: number, approver = ulv.id) => ({
  id: String(n), status: 'published', approved_by_user_id: approver, approved_at: now.toISOString(),
  draft_text: `Draft ${n}`, approved_text: `Ulv edit ${n}`, review: { star_rating: 5, review_text: 'Synthetic review' },
})

function fixture() {
  const db = gbpDb()
  db.tables.app_users = [ulv, { id: 'other-admin', email: 'other@example.com', role: 'SUPER_ADMIN', active: true }]
  return db
}

describe('Ulv reply voice examples', () => {
  it('resolves the active app identity and bounds only his approvals to 24 rows / 90 days, preferring edits', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({ ...reply(i), approved_text: i >= 20 ? `Ulv edit ${i}` : `Draft ${i}` }))
    const identity = { select: vi.fn(() => identity), eq: vi.fn(() => identity), maybeSingle: vi.fn(async () => ({ data: ulv, error: null })) }
    const q = { select: vi.fn(() => q), in: vi.fn(() => q), eq: vi.fn(() => q), gte: vi.fn(() => q), order: vi.fn(() => q), limit: vi.fn(async () => ({ data: rows, error: null })) }
    const from = vi.fn((table: string) => table === 'app_users' ? identity : q)
    const examples = await loadReviewReplyExamples({ from } as never, now)
    expect(from.mock.calls).toEqual([['app_users'], ['gbp_review_replies']])
    expect(identity.eq.mock.calls).toEqual([['email', 'ulv@killerkebab.com'], ['active', true]])
    expect(q.eq).toHaveBeenCalledWith('approved_by_user_id', ulv.id)
    expect(q.limit).toHaveBeenCalledWith(24)
    expect(q.in).toHaveBeenCalledWith('status', ['approved', 'published'])
    expect(q.gte).toHaveBeenCalledWith('approved_at', '2026-06-25T04:45:00.000Z')
    expect(q.order.mock.calls).toEqual([['approved_at', { ascending: false }], ['id', { ascending: false }]])
    expect(examples).toHaveLength(6)
    expect(examples.slice(0, 4).every(row => row.approvedReply.startsWith('Ulv edit'))).toBe(true)
    expect(examples[0]).toMatchObject({ originalDraft: 'Draft 20', approvedReply: 'Ulv edit 20', reviewText: 'Synthetic review', starRating: 5 })
  })

  it('excludes other approvers before the row limit, including other admins and the auth UUID', async () => {
    const db = fixture()
    db.tables.gbp_review_replies = [
      ...Array.from({ length: 30 }, (_, i) => reply(i, 'other-admin')),
      reply(40, ulv.auth_user_id), reply(41), { ...reply(42), status: 'approved' },
      { ...reply(43), status: 'rejected' }, { ...reply(44), approved_at: '2026-06-24T00:00:00Z' },
    ]
    const examples = await loadReviewReplyExamples(db as never, now)
    expect(examples.map(row => row.approvedReply)).toEqual(['Ulv edit 41', 'Ulv edit 42'])
  })

  it.each([0, 1])('uses base context with only %i usable Ulv examples, without filling from other approvers', async (count) => {
    const db = fixture()
    db.tables.gbp_review_replies = [
      ...Array.from({ length: count }, (_, i) => reply(i)),
      ...Array.from({ length: 6 }, (_, i) => reply(i, 'other-admin')),
      { ...reply(50), approved_text: ' ' }, { ...reply(51), approved_text: 'a'.repeat(601) },
    ]
    expect(await loadReviewReplyExamples(db as never, now)).toEqual([])
  })

  it.each(['missing', 'inactive', 'lookup error'] as const)('uses base context when Ulv identity is %s', async condition => {
    const db = fixture()
    db.tables.app_users = condition === 'missing' ? [] : [{ ...ulv, active: condition !== 'inactive' }]
    if (condition === 'lookup error') db.failures['app_users:select'] = 1
    db.tables.gbp_review_replies = [reply(1), reply(2), reply(3, 'other-admin')]
    const from = vi.spyOn(db, 'from')
    expect(await loadReviewReplyExamples(db as never, now)).toEqual([])
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('uses base context on reply-query errors and unexpected lookup failures', async () => {
    const db = fixture()
    db.failures['gbp_review_replies:select'] = 1
    expect(await loadReviewReplyExamples(db as never, now)).toEqual([])
    expect(await loadReviewReplyExamples({ from: () => { throw new Error('unavailable') } } as never, now)).toEqual([])
  })

  it('skips empty/overlong replies and bounds untrusted context', async () => {
    const db = fixture()
    db.tables.gbp_review_replies = [
      { ...reply(0), approved_text: ' ' }, { ...reply(1), approved_text: 'a'.repeat(601) }, reply(2),
      { ...reply(3), draft_text: 'd'.repeat(1000), review: { review_text: 'r'.repeat(1000), star_rating: 4 } },
    ]
    const examples = await loadReviewReplyExamples(db as never, now)
    expect(examples).toHaveLength(2)
    expect(examples[1].reviewText).toHaveLength(400)
    expect(examples[1].originalDraft).toHaveLength(400)
  })
})

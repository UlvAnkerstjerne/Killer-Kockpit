import { describe, expect, it, vi } from 'vitest'
import { loadReviewReplyExamples } from '@/lib/gbp/reply-examples'

describe('recent approved edit examples', () => {
  it('bounds the database query to 24 recent human approvals and returns at most six, preferring edits', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({ draft_text: `Draft ${i}`, approved_text: i >= 20 ? `Human edit ${i}` : `Draft ${i}`, review: { star_rating: 5, review_text: 'Synthetic review' } }))
    const q = { select: vi.fn(() => q), in: vi.fn(() => q), not: vi.fn(() => q), gte: vi.fn(() => q), order: vi.fn(() => q), limit: vi.fn(async () => ({ data: rows, error: null })) }
    const from = vi.fn(() => q)
    const examples = await loadReviewReplyExamples({ from } as never, new Date('2026-09-23T04:45:00Z'))
    expect(from).toHaveBeenCalledTimes(1); expect(q.limit).toHaveBeenCalledWith(24)
    expect(q.in).toHaveBeenCalledWith('status', ['approved','published'])
    expect(q.not).toHaveBeenCalledWith('approved_by_user_id','is',null)
    expect(q.gte).toHaveBeenCalledWith('approved_at','2026-06-25T04:45:00.000Z')
    expect(examples).toHaveLength(6)
    expect(examples.slice(0,4).every(row => row.approvedReply.startsWith('Human edit'))).toBe(true)
    expect(examples[0]).toMatchObject({ originalDraft: 'Draft 20', approvedReply: 'Human edit 20', reviewText: 'Synthetic review', starRating: 5 })
  })
  it('skips empty/overlong replies and bounds untrusted context', async () => {
    const q = { select: () => q, in: () => q, not: () => q, gte: () => q, order: () => q, limit: async () => ({ data: [
      { approved_text: ' ' }, { approved_text: 'a'.repeat(601) },
      { approved_text: 'Human wording', draft_text: 'd'.repeat(1000), review: { review_text: 'r'.repeat(1000), star_rating: 4 } },
    ], error: null }) }
    const examples = await loadReviewReplyExamples({ from: () => q } as never)
    expect(examples).toHaveLength(1); expect(examples[0].reviewText).toHaveLength(400); expect(examples[0].originalDraft).toHaveLength(400)
  })
})

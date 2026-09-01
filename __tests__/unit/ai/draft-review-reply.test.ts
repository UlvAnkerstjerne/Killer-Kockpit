/**
 * Tests for lib/ai/draft-review-reply.ts
 *
 * All tests mock the Anthropic SDK — no live API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockCreate = vi.fn()
  // Must use `function` (not arrow) so `new Anthropic()` works as a constructor
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  })
  return { mockCreate, MockAnthropic }
})

vi.mock('@anthropic-ai/sdk', () => ({ default: mocks.MockAnthropic }))

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_CTX = {
  reviewerName: 'Sarah',
  starRating:   5,
  reviewText:   'Amazing kebab!',
  storeName:    'Killer Kebab Copenhagen',
  brandContext: 'Be warm and genuine.',
}

function mockSuccess(text: string, model = 'claude-sonnet-4-6') {
  mocks.mockCreate.mockResolvedValueOnce({
    content:     [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model,
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('draftReviewReply', () => {
  beforeEach(() => {
    // resetAllMocks clears the mockResolvedValueOnce/mockRejectedValueOnce queues too,
    // preventing leftover queued responses from leaking into subsequent tests.
    vi.resetAllMocks()
    // Re-apply MockAnthropic implementation (cleared by resetAllMocks)
    mocks.MockAnthropic.mockImplementation(function () {
      return { messages: { create: mocks.mockCreate } }
    })
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('REVIEW_AI_MODEL', 'claude-sonnet-4-6')
  })

  it('returns draft text on success', async () => {
    mockSuccess('Thank you Sarah!')
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.draft).toBe('Thank you Sarah!')
      expect(result.model).toBe('claude-sonnet-4-6')
      expect(result.promptVersion).toBeTruthy()
    }
  })

  it('returns error when REVIEW_AI_MODEL and MEETING_AI_MODEL are both absent', async () => {
    vi.stubEnv('REVIEW_AI_MODEL', '')
    vi.stubEnv('MEETING_AI_MODEL', '')
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('model')
    expect(mocks.mockCreate).not.toHaveBeenCalled()
  })

  it('falls back to MEETING_AI_MODEL when REVIEW_AI_MODEL is absent', async () => {
    // ?? (nullish coalescing) only falls back on undefined/null, not ''.
    // Unstub all first so REVIEW_AI_MODEL is genuinely absent (undefined).
    vi.unstubAllEnvs()
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('MEETING_AI_MODEL', 'claude-haiku-4-5-20251001')
    // REVIEW_AI_MODEL intentionally NOT stubbed — resolves to undefined
    mockSuccess('Great!', 'claude-haiku-4-5-20251001')
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    expect(result.ok).toBe(true)
    expect(mocks.mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    )
  })

  it('returns error when ANTHROPIC_API_KEY is absent', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    expect(result.ok).toBe(false)
    expect(mocks.mockCreate).not.toHaveBeenCalled()
  })

  it('handles rating-only reviews (no reviewText)', async () => {
    mockSuccess('Thanks for the 5 stars!')
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply({ ...BASE_CTX, reviewText: null })
    expect(result.ok).toBe(true)
    // Confirm prompt contained the rating-only instruction
    const callArgs = mocks.mockCreate.mock.calls[0][0]
    const userContent: string = callArgs.messages[0].content
    expect(userContent).toContain('rating only')
    expect(userContent).toContain('Do NOT invent')
  })

  it('includes brand context and security instruction in the call', async () => {
    mockSuccess('Great reply')
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    await draftReviewReply(BASE_CTX)
    const callArgs = mocks.mockCreate.mock.calls[0][0]
    expect(callArgs.system).toContain('CRITICAL SECURITY INSTRUCTION')
    expect(callArgs.system).toContain('UNTRUSTED USER-GENERATED CONTENT')
    const userContent: string = callArgs.messages[0].content
    expect(userContent).toContain('Be warm and genuine.')
  })

  it('returns error when API call throws', async () => {
    mocks.mockCreate.mockRejectedValueOnce(new Error('network error'))
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    expect(result.ok).toBe(false)
  })

  it('returns error when model returns no text content', async () => {
    mocks.mockCreate.mockResolvedValueOnce({
      content: [], stop_reason: 'end_turn',
    })
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    expect(result.ok).toBe(false)
  })

  it('includes promptVersion in successful result', async () => {
    mockSuccess('A reply')
    const { draftReviewReply, REVIEW_REPLY_PROMPT_VERSION } = await import('@/lib/ai/draft-review-reply')
    const result = await draftReviewReply(BASE_CTX)
    if (result.ok) {
      expect(result.promptVersion).toBe(REVIEW_REPLY_PROMPT_VERSION)
    }
  })
})

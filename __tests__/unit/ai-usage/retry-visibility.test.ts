import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  clients: [] as Record<string, unknown>[],
  parse: vi.fn(),
  create: vi.fn(),
  countTokens: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { parse: mocks.parse, create: mocks.create, countTokens: mocks.countTokens }
    constructor(opts: Record<string, unknown>) { mocks.clients.push(opts) }
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: (r: Record<string, unknown>) => { mocks.inserts.push(r); return Promise.resolve({ error: null }) } }) }),
}))

import {
  isRetryableAiError, retryDelayMs, SDK_DEFAULT_MAX_RETRIES, trackAiCallWithRetries,
} from '@/lib/ai/usage'

const apiErr = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra })
const ok = (usage: Record<string, unknown>) => ({ id: 'msg_ok', model: 'claude-sonnet-4-6', usage, parsed_output: null, stop_reason: 'end_turn' })
const rows = () => mocks.inserts.map(r => [r.attempt, r.status, r.error_category])
const noSleep = async () => {}

beforeEach(() => {
  mocks.inserts.length = 0; mocks.clients.length = 0
  mocks.parse.mockReset(); mocks.create.mockReset(); mocks.countTokens.mockReset()
  process.env.MEETING_AI_MODEL = 'claude-sonnet-4-6'
  process.env.BRIEF_AI_MODEL = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

/** Run a feature call to completion with fake timers (so retry back-off does not slow tests). */
async function settle<T>(p: Promise<T>): Promise<T> {
  const done = p.then(v => v, e => { throw e })
  done.catch(() => {})
  await vi.runAllTimersAsync()
  return done
}

describe('SDK retry policy is mirrored explicitly', () => {
  it('retries what the SDK retried: 408, 409, 429, 5xx, connection errors and timeouts', () => {
    for (const s of [408, 409, 429, 500, 502, 503, 529]) expect(isRetryableAiError(apiErr(s))).toBe(true)
    expect(isRetryableAiError({ name: 'APIConnectionError' })).toBe(true)
    expect(isRetryableAiError({ name: 'APIConnectionTimeoutError' })).toBe(true)
  })

  it('does not retry what the SDK did not: 4xx (incl. billing 400), auth, user aborts', () => {
    for (const s of [400, 401, 402, 403, 404, 413, 422]) expect(isRetryableAiError(apiErr(s))).toBe(false)
    expect(isRetryableAiError({ name: 'APIUserAbortError' })).toBe(false)
    expect(isRetryableAiError(new Error('plain'))).toBe(false)
  })

  it('honours x-should-retry over the status code', () => {
    const h = (v: string) => ({ get: (n: string) => (n === 'x-should-retry' ? v : null) })
    expect(isRetryableAiError(apiErr(400, { headers: h('true') }))).toBe(true)
    expect(isRetryableAiError(apiErr(500, { headers: h('false') }))).toBe(false)
  })

  it('back-off: retry-after(-ms) when sane, else 0.5s·2^n capped at 8s with ≤25% jitter', () => {
    const h = (m: Record<string, string>) => ({ headers: { get: (n: string) => m[n] ?? null } })
    expect(retryDelayMs(h({ 'retry-after-ms': '1500' }), 0)).toBe(1500)
    expect(retryDelayMs(h({ 'retry-after': '2' }), 0)).toBe(2000)
    expect(retryDelayMs(h({ 'retry-after': '600' }), 0)).toBeLessThanOrEqual(500) // absurd → default
    for (const [n, base] of [[0, 500], [1, 1000], [2, 2000], [5, 8000]] as const) {
      const d = retryDelayMs({}, n)
      expect(d).toBeLessThanOrEqual(base)
      expect(d).toBeGreaterThanOrEqual(base * 0.75)
    }
  })
})

describe('trackAiCallWithRetries — one row per actual request', () => {
  it('attempt 1 failure → one error row; attempt 2 success → second row with its real usage', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(apiErr(529))
      .mockResolvedValueOnce(ok({ input_tokens: 400, output_tokens: 100 }))
    const res = await trackAiCallWithRetries({ feature: 'quick_capture', model: 'claude-sonnet-4-6' }, call, { sleep: noSleep })
    expect(res).toMatchObject({ id: 'msg_ok' })
    expect(call).toHaveBeenCalledTimes(2)
    expect(rows()).toEqual([[1, 'error', 'provider_error'], [2, 'success', null]])
    expect(mocks.inserts[1]).toMatchObject({ input_tokens: 400, output_tokens: 100, estimated_cost_usd: 0.0027 })
    expect(mocks.inserts[0]).toMatchObject({ input_tokens: 0, estimated_cost_usd: 0, http_status: 529 })
  })

  it('stops after the SDK-default budget (1 + 2 retries) and logs all three requests', async () => {
    expect(SDK_DEFAULT_MAX_RETRIES).toBe(2)
    const call = vi.fn().mockRejectedValue(apiErr(500))
    await expect(trackAiCallWithRetries({ feature: 'x', model: 'm' }, call, { sleep: noSleep })).rejects.toThrow('HTTP 500')
    expect(call).toHaveBeenCalledTimes(3)
    expect(rows().map(r => r[0])).toEqual([1, 2, 3])
  })

  it('does not retry a billing/credit rejection: exactly one row', async () => {
    const credit = apiErr(400, { error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } })
    const call = vi.fn().mockRejectedValue(credit)
    await expect(trackAiCallWithRetries({ feature: 'x', model: 'm' }, call, { sleep: noSleep })).rejects.toBe(credit)
    expect(call).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([[1, 'error', 'billing_credit_exhausted']])
  })

  it('every provider call is inside trackAiCall: provider call count === row count, always', async () => {
    for (const failures of [0, 1, 2, 3]) {
      mocks.inserts.length = 0
      const call = vi.fn()
      for (let i = 0; i < failures; i++) call.mockRejectedValueOnce(apiErr(503))
      call.mockResolvedValue(ok({ input_tokens: 1, output_tokens: 1 }))
      await trackAiCallWithRetries({ feature: 'x', model: 'claude-sonnet-4-6' }, call, { sleep: noSleep }).catch(() => {})
      expect(mocks.inserts.length).toBe(call.mock.calls.length)
    }
  })

  it('countTokens follows the same rule: each request is a row, cost stays zero', async () => {
    const call = vi.fn().mockRejectedValueOnce(apiErr(500)).mockResolvedValueOnce({ input_tokens: 9000 })
    await trackAiCallWithRetries({ feature: 'meeting_draft', model: 'claude-sonnet-4-6', operation: 'count_tokens' }, call, { sleep: noSleep })
    expect(rows()).toEqual([[1, 'error', 'provider_error'], [2, 'success', null]])
    expect(mocks.inserts.every(r => r.estimated_cost_usd === 0)).toBe(true)
    expect(mocks.inserts[1].metadata).toMatchObject({ operation: 'count_tokens' })
  })

  it('attemptOffset keeps attempt numbers unique across an outer explicit loop', async () => {
    const call = vi.fn().mockRejectedValue(apiErr(500))
    await trackAiCallWithRetries({ feature: 'x', model: 'm' }, call, { sleep: noSleep }).catch(() => {})
    await trackAiCallWithRetries({ feature: 'x', model: 'm' }, call, { sleep: noSleep, attemptOffset: 3 }).catch(() => {})
    expect(rows().map(r => r[0])).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('feature call sites', () => {
  it('Quick Capture: client has maxRetries 0 and an SDK-style retry is visible as separate rows', async () => {
    mocks.parse.mockRejectedValueOnce(apiErr(529)).mockRejectedValueOnce(apiErr(529)).mockResolvedValueOnce(ok({ input_tokens: 800, output_tokens: 200 }))
    const { analyzeCapture } = await import('@/lib/ai/analyze-capture')
    await settle(analyzeCapture({ rawText: 'n', occurred_on: '2026-10-08', referenceDate: '2026-10-08', projects: [], employees: [], locations: [] }))
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
    expect(mocks.parse).toHaveBeenCalledTimes(3)
    expect(rows()).toEqual([[1, 'error', 'provider_error'], [2, 'error', 'provider_error'], [3, 'success', null]])
    expect(mocks.inserts[2]).toMatchObject({ feature: 'quick_capture', input_tokens: 800, output_tokens: 200 })
  })

  it('Morning Brief: explicit 2-attempt loop unchanged; each attempt keeps SDK-equivalent retries → 6 requests, 6 rows, unique attempts', async () => {
    mocks.parse.mockRejectedValue(apiErr(529))
    const { callMorningBriefAI } = await import('@/lib/ai/morning-brief')
    const r = await settle(callMorningBriefAI('brief input'))
    expect(r.ok).toBe(false)
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
    expect(mocks.parse).toHaveBeenCalledTimes(6) // same worst case as before: 2 loop attempts × (1 + 2 SDK retries)
    expect(rows().map(r => r[0])).toEqual([1, 2, 3, 4, 5, 6])
    expect(mocks.inserts.every(r => r.feature === 'morning_brief')).toBe(true)
  })

  it('Paid Recommendations: same 2 × 3 worst case, all visible', async () => {
    mocks.parse.mockRejectedValue(apiErr(500))
    const { callPaidRecommendationsAI } = await import('@/lib/ai/paid-recommendations')
    await settle(callPaidRecommendationsAI([]))
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
    expect(mocks.parse).toHaveBeenCalledTimes(6)
    expect(mocks.inserts).toHaveLength(6)
  })

  it('a billing error in Morning Brief is not retried at either level beyond the existing explicit loop', async () => {
    mocks.parse.mockRejectedValue(apiErr(400, { error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } } }))
    const { callMorningBriefAI } = await import('@/lib/ai/morning-brief')
    await settle(callMorningBriefAI('x'))
    // explicit loop still tries twice (unchanged behaviour); the SDK never retried a 400, so no more.
    expect(mocks.parse).toHaveBeenCalledTimes(2)
    expect(rows().every(r => r[2] === 'billing_credit_exhausted')).toBe(true)
  })

  it('Creative classifier keeps its explicit 2-attempt loop and maxRetries 0 (no wrapper added)', async () => {
    mocks.parse.mockRejectedValue(apiErr(500))
    const { callCreativeClassifier } = await import('@/lib/ai/creative-classifier')
    await settle(callCreativeClassifier([{ id: 'a' } as never]))
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
    expect(mocks.parse).toHaveBeenCalledTimes(2)
    expect(rows().map(r => r[0])).toEqual([1, 2])
  })

  it('Review reply: maxRetries 0, SDK-equivalent resilience (3 requests on persistent 5xx), every request a row', async () => {
    mocks.create.mockRejectedValue(apiErr(503))
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const r = await settle(draftReviewReply({ reviewerName: 'S', starRating: 5, reviewText: 'Great', storeName: 'KK', brandContext: 'Warm.' }))
    expect(r.ok).toBe(false)
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
    expect(mocks.create).toHaveBeenCalledTimes(3)
    expect(mocks.inserts).toHaveLength(3)
    expect(mocks.inserts.every(x => x.feature === 'review_reply_draft')).toBe(true)
  })

  it('Review reply: a success on the second request keeps the draft and records both requests', async () => {
    mocks.create.mockRejectedValueOnce(apiErr(529)).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Thanks!' }], stop_reason: 'end_turn', model: 'claude-sonnet-4-6', usage: { input_tokens: 300, output_tokens: 20 },
    })
    const { draftReviewReply } = await import('@/lib/ai/draft-review-reply')
    const r = await settle(draftReviewReply({ reviewerName: 'S', starRating: 5, reviewText: 'Great', storeName: 'KK', brandContext: 'Warm.' }))
    expect(r.ok).toBe(true)
    expect(rows()).toEqual([[1, 'error', 'provider_error'], [2, 'success', null]])
    expect(mocks.inserts[1]).toMatchObject({ input_tokens: 300, output_tokens: 20 })
  })

  it('Meeting draft: countTokens pre-flight retries are visible rows with zero cost, and the parse call is tracked separately', async () => {
    mocks.countTokens.mockRejectedValueOnce(apiErr(500)).mockResolvedValueOnce({ input_tokens: 1200 })
    mocks.parse.mockResolvedValueOnce(ok({ input_tokens: 1200, output_tokens: 300 }))
    const { generateDraftFromContext } = await import('@/lib/ai/generate-meeting-draft')
    await settle(generateDraftFromContext({
      meetingTitle: 'Weekly Sync', scheduledStart: '2026-08-29T10:00:00Z', projectTitle: 'Alpha', attendeeNames: ['A'],
      workingNotes: 'n', transcriptContent: 't', transcriptFileName: 'x.txt',
    } as never))
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
    expect(mocks.countTokens).toHaveBeenCalledTimes(2)
    const counts = mocks.inserts.filter(r => (r.metadata as { operation?: string } | null)?.operation === 'count_tokens')
    expect(counts.map(r => [r.attempt, r.status])).toEqual([[1, 'error'], [2, 'success']])
    expect(counts.every(r => r.estimated_cost_usd === 0)).toBe(true)
    expect(mocks.inserts.find(r => r.status === 'success' && !(r.metadata as { operation?: string } | null)?.operation)).toMatchObject({ input_tokens: 1200, output_tokens: 300 })
  })

  it('Brain and Email use the same wrapper (maxRetries 0, 3 requests on persistent 5xx)', async () => {
    mocks.create.mockRejectedValue(apiErr(500))
    mocks.parse.mockRejectedValue(apiErr(500))
    const { readFileSync } = await import('node:fs')
    for (const f of ['analyze-email', 'brain-query']) {
      const src = readFileSync(`lib/ai/${f}.ts`, 'utf8')
      expect(src, f).toMatch(/trackAiCallWithRetries\(/)
      expect(src, f).not.toMatch(/[^\w]trackAiCall\(/)
      expect(src, f).toMatch(/maxRetries:\s*0/)
    }
  })
})

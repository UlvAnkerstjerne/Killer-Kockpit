import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  insertImpl: null as null | (() => Promise<{ error: unknown }>),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'ai_usage_events') throw new Error(`unexpected table ${table}`)
      return {
        insert: (row: Record<string, unknown>) => {
          mocks.inserts.push(row)
          return mocks.insertImpl ? mocks.insertImpl() : Promise.resolve({ error: null })
        },
      }
    },
  }),
}))

import { classifyAiError, extractUsage, isBillingCreditError, trackAiCall } from '@/lib/ai/usage'

const CREDIT_ERR = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), {
  status: 400,
  error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } },
  requestID: 'req_credit',
})

const okResponse = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'SECRET MODEL OUTPUT' }], usage, ...extra,
})

beforeEach(() => { mocks.inserts.length = 0; mocks.insertImpl = null; vi.restoreAllMocks() })

describe('extractUsage', () => {
  it('reads the real usage object including the cache TTL breakdown and thinking tokens', () => {
    const u = extractUsage({
      input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 900, cache_read_input_tokens: 5000,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 300 },
      output_tokens_details: { thinking_tokens: 120 }, inference_geo: 'global', service_tier: 'standard',
    })
    expect(u).toMatchObject({
      input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 900, cache_read_input_tokens: 5000,
      cache_creation_5m_tokens: 600, cache_creation_1h_tokens: 300, thinking_tokens: 120, inference_geo: 'global',
    })
  })

  it('tolerates missing / null fields', () => {
    expect(extractUsage(undefined)).toMatchObject({ input_tokens: 0, output_tokens: 0, thinking_tokens: null })
    expect(extractUsage({ input_tokens: 5, output_tokens: null, cache_creation_input_tokens: null })).toMatchObject({ input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0 })
  })
})

describe('classifyAiError', () => {
  it('maps the known credit-balance error to billing_credit_exhausted', () => {
    expect(classifyAiError(CREDIT_ERR)).toEqual({ category: 'billing_credit_exhausted', httpStatus: 400 })
    expect(isBillingCreditError(CREDIT_ERR)).toBe(true)
  })

  it('also recognises explicit billing signals without the exact string (402 / billing_error)', () => {
    expect(classifyAiError({ status: 402 }).category).toBe('billing_credit_exhausted')
    expect(classifyAiError({ status: 400, error: { type: 'error', error: { type: 'billing_error' } } }).category).toBe('billing_credit_exhausted')
  })

  it('classifies the other categories', () => {
    expect(classifyAiError({ status: 429 }).category).toBe('rate_limit')
    expect(classifyAiError({ status: 401 }).category).toBe('authentication')
    expect(classifyAiError({ status: 403 }).category).toBe('authentication')
    expect(classifyAiError({ status: 500 }).category).toBe('provider_error')
    expect(classifyAiError({ status: 529 }).category).toBe('provider_error')
    expect(classifyAiError({ status: 400, message: 'max_tokens too large' }).category).toBe('validation_error')
    expect(classifyAiError({ name: 'APIConnectionTimeoutError' }).category).toBe('timeout')
    expect(classifyAiError(new Error('boom')).category).toBe('unknown')
    expect(classifyAiError(null).category).toBe('unknown')
  })

  it('does not call an ordinary 400 a billing error', () => {
    expect(isBillingCreditError({ status: 400, message: 'invalid schema' })).toBe(false)
  })
})

describe('trackAiCall', () => {
  it('records real usage and cost for a successful request, returning the response unchanged', async () => {
    const response = okResponse({ input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 })
    const out = await trackAiCall({ feature: 'quick_capture', model: 'claude-sonnet-4-6' }, async () => response)
    expect(out).toBe(response)
    expect(mocks.inserts).toHaveLength(1)
    expect(mocks.inserts[0]).toMatchObject({
      provider: 'anthropic', feature: 'quick_capture', model: 'claude-sonnet-4-6', status: 'success', attempt: 1,
      input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
      estimated_cost_usd: 0.0111, pricing_version: expect.any(String), error_category: null, request_id: 'msg_1',
    })
  })

  it('unknown model: tokens are logged, cost is null (never priced as Sonnet)', async () => {
    await trackAiCall({ feature: 'brain_query', model: 'claude-future-9' }, async () =>
      okResponse({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, { model: 'claude-future-9' }))
    expect(mocks.inserts[0]).toMatchObject({ model: 'claude-future-9', input_tokens: 1_000_000, output_tokens: 1_000_000, estimated_cost_usd: null })
  })

  it('flags partial estimates when cache-write TTL is unknown', async () => {
    await trackAiCall({ feature: 'x', model: 'claude-sonnet-4-6' }, async () =>
      okResponse({ input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 500 }))
    expect(mocks.inserts[0].metadata).toMatchObject({ cost_partial: true })
  })

  it('logs one row per actual attempt when a logical operation retries', async () => {
    let calls = 0
    const run = async (attempt: number) => trackAiCall({ feature: 'morning_brief', model: 'claude-sonnet-4-6', attempt }, async () => {
      calls++
      if (attempt === 1) throw Object.assign(new Error('overloaded'), { status: 529 })
      return okResponse({ input_tokens: 200, output_tokens: 100 })
    })
    await expect(run(1)).rejects.toThrow('overloaded')
    await run(2)
    expect(calls).toBe(2)
    expect(mocks.inserts.map(r => [r.attempt, r.status, r.error_category])).toEqual([[1, 'error', 'provider_error'], [2, 'success', null]])
  })

  it('records a failed request with zero tokens/cost, the category, status and request id — and rethrows the original error', async () => {
    await expect(trackAiCall({ feature: 'quick_capture', model: 'claude-sonnet-4-6' }, async () => { throw CREDIT_ERR })).rejects.toBe(CREDIT_ERR)
    expect(mocks.inserts[0]).toMatchObject({
      status: 'error', error_category: 'billing_credit_exhausted', http_status: 400, request_id: 'req_credit',
      input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0,
    })
  })

  it('count_tokens is logged as a request with no billable usage', async () => {
    await trackAiCall({ feature: 'meeting_draft', model: 'claude-sonnet-4-6', operation: 'count_tokens' }, async () => ({ input_tokens: 12345 }))
    expect(mocks.inserts[0]).toMatchObject({ feature: 'meeting_draft', input_tokens: 0, estimated_cost_usd: 0, metadata: { operation: 'count_tokens' } })
  })

  it('telemetry failure (rejected insert) never breaks the AI feature', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.insertImpl = () => Promise.reject(new Error('db down'))
    const response = okResponse({ input_tokens: 1, output_tokens: 1 })
    await expect(trackAiCall({ feature: 'x', model: 'claude-sonnet-4-6' }, async () => response)).resolves.toBe(response)
    expect(warn).toHaveBeenCalled()
  })

  it('telemetry failure (error result) also never breaks the feature, and error paths still rethrow the real error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.insertImpl = () => Promise.resolve({ error: { code: '42501' } })
    const response = okResponse({ input_tokens: 1, output_tokens: 1 })
    await expect(trackAiCall({ feature: 'x', model: 'claude-sonnet-4-6' }, async () => response)).resolves.toBe(response)
    await expect(trackAiCall({ feature: 'x', model: 'm' }, async () => { throw CREDIT_ERR })).rejects.toBe(CREDIT_ERR)
  })

  it('never persists prompts, responses, error messages or payloads', async () => {
    await trackAiCall({ feature: 'review_reply_draft', model: 'claude-sonnet-4-6' }, async () =>
      okResponse({ input_tokens: 5, output_tokens: 5 }))
    await trackAiCall({ feature: 'review_reply_draft', model: 'claude-sonnet-4-6' }, async () => { throw CREDIT_ERR }).catch(() => {})
    const serialized = JSON.stringify(mocks.inserts)
    expect(serialized).not.toContain('SECRET MODEL OUTPUT')
    expect(serialized).not.toContain('credit balance is too low')
    expect(serialized).not.toMatch(/prompt|content|messages|system/i)
    const allowed = new Set(['provider', 'feature', 'model', 'status', 'attempt', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens',
      'cache_read_input_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens', 'thinking_tokens', 'estimated_cost_usd',
      'pricing_version', 'duration_ms', 'error_category', 'http_status', 'request_id', 'metadata'])
    for (const row of mocks.inserts) for (const k of Object.keys(row)) expect(allowed.has(k)).toBe(true)
  })
})

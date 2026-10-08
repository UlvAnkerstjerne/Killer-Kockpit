import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  inserts: [] as Record<string, unknown>[],
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { parse: mocks.parse } },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: (r: Record<string, unknown>) => { mocks.inserts.push(r); return Promise.resolve({ error: null }) } }) }),
}))

const CTX = { rawText: 'Ahmed promoted.', occurred_on: '2026-10-08', referenceDate: '2026-10-08', projects: [], employees: [], locations: [] }

beforeEach(() => {
  mocks.inserts.length = 0
  mocks.parse.mockReset()
  process.env.MEETING_AI_MODEL = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Quick Capture when Anthropic credit is exhausted', () => {
  it('shows the credit message instead of the generic failure, and logs a classified failure row', async () => {
    mocks.parse.mockRejectedValue(Object.assign(new Error('400 credit balance is too low'), {
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    }))
    const { analyzeCapture } = await import('@/lib/ai/analyze-capture')
    const r = await analyzeCapture(CTX)
    expect(r).toEqual({ ok: false, error: "AI credit unavailable. Kockpit's Anthropic API balance needs attention." })
    expect(mocks.inserts).toHaveLength(1)
    expect(mocks.inserts[0]).toMatchObject({ feature: 'quick_capture', status: 'error', error_category: 'billing_credit_exhausted', http_status: 400 })
  })

  it('other failures keep the existing generic message', async () => {
    mocks.parse.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }))
    const { analyzeCapture } = await import('@/lib/ai/analyze-capture')
    expect(await analyzeCapture(CTX)).toEqual({ ok: false, error: 'The AI analysis request failed. Please try again.' })
    expect(mocks.inserts[0]).toMatchObject({ error_category: 'provider_error' })
  })

  it('a successful call records the real usage', async () => {
    mocks.parse.mockResolvedValue({ id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 800, output_tokens: 200 }, parsed_output: null, stop_reason: 'end_turn' })
    const { analyzeCapture } = await import('@/lib/ai/analyze-capture')
    await analyzeCapture(CTX) // fails validation downstream; the provider request still happened and was billed
    expect(mocks.inserts[0]).toMatchObject({ feature: 'quick_capture', status: 'success', input_tokens: 800, output_tokens: 200, estimated_cost_usd: 0.0054 })
  })
})

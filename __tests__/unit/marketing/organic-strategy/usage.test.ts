import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { media, ORGANIC_NOW, smallMeasuredSet, validOutput } from '../../../helpers/organic-strategy'
import { buildOrganicEvidence } from '@/lib/marketing/organic-strategy/evidence'
import type { LoadedClaudeIgSkill } from '@/lib/ai/skills/claude-ig'

// The REAL usage tracker is used here. Only the provider and the database insert are faked.
const mocks = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[], clients: [] as Record<string, unknown>[], parse: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { parse: mocks.parse }; constructor(opts: Record<string, unknown>) { mocks.clients.push(opts) } },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (table: string) => ({ insert: (r: Record<string, unknown>) => { mocks.inserts.push({ table, ...r }); return Promise.resolve({ error: null }) } }) }),
}))
import { callOrganicStrategyAI } from '@/lib/ai/organic-strategy'

const skill: LoadedClaudeIgSkill = { name: 'claude-ig', version: '2.0.0', ref: 'claude-ig@2.0.0#5e9b2d9', hash: 'c'.repeat(64), text: '### skills/ig-analyze/SKILL.md\n\nbody' }
const SECRET_CAPTION = 'Unique caption text that must never be logged: tangerine-7731'
const built = buildOrganicEvidence({ media: [...smallMeasuredSet(), media(50, { caption: SECRET_CAPTION })], fingerprints: [], businessContext: [], followersLatest: null, now: ORGANIC_NOW })
const ctx = { measuredInPrompt: built.summary.measured_in_prompt, unmeasuredInPrompt: built.summary.unmeasured_in_prompt, businessItems: 0 }
const success = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', parsed_output: validOutput(),
  usage: { input_tokens: 21_000, output_tokens: 2_400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...over,
})
const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
const rows = () => mocks.inserts.map(r => [r.attempt, r.status])
async function settle<T>(p: Promise<T>): Promise<T> { const done = p.then(v => v, e => { throw e }); done.catch(() => {}); await vi.runAllTimersAsync(); return done }

beforeEach(() => {
  mocks.inserts.length = 0; mocks.clients.length = 0; mocks.parse.mockReset()
  process.env.ANTHROPIC_API_KEY = 'test-key'; process.env.BRIEF_AI_MODEL = 'claude-sonnet-4-6'
  vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Organic Strategy AI usage instrumentation (real tracker)', () => {
  it('records one telemetry row for one request, under the stable feature name, with tokens and cost', async () => {
    mocks.parse.mockResolvedValue(success())
    expect(await settle(callOrganicStrategyAI(skill, built.evidence, ctx))).toMatchObject({ ok: true })
    expect(mocks.inserts).toHaveLength(1)
    expect(mocks.inserts[0]).toMatchObject({
      table: 'ai_usage_events', feature: 'organic_strategy', model: 'claude-sonnet-4-6', status: 'success', attempt: 1, input_tokens: 21_000, output_tokens: 2_400,
    })
    expect(Number(mocks.inserts[0].estimated_cost_usd)).toBeGreaterThan(0)
  })

  it('never logs prompts, captions or model output: tokens and flags only', async () => {
    mocks.parse.mockResolvedValue(success())
    await settle(callOrganicStrategyAI(skill, built.evidence, ctx))
    const logged = JSON.stringify(mocks.inserts)
    expect(logged).not.toContain('tangerine-7731')
    expect(logged).not.toContain('DATA:')
    expect(logged).not.toContain('KOCKPIT RULES')
    expect(logged).not.toContain('Subject angle')
  })

  it('uses a client with no hidden SDK retries, so every real request is visible', async () => {
    mocks.parse.mockResolvedValue(success())
    await settle(callOrganicStrategyAI(skill, built.evidence, ctx))
    expect(mocks.clients[0]).toMatchObject({ maxRetries: 0 })
  })

  it('records each retried HTTP request as its own row', async () => {
    mocks.parse.mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce(success())
    expect(await settle(callOrganicStrategyAI(skill, built.evidence, ctx))).toMatchObject({ ok: true })
    expect(mocks.parse).toHaveBeenCalledTimes(2)
    expect(rows()).toEqual([[1, 'error'], [2, 'success']])
    expect(mocks.inserts[0]).toMatchObject({ feature: 'organic_strategy', http_status: 429 })
  })

  it('keeps attempt numbers unique when an answer fails validation and the whole call is re-asked', async () => {
    const bad = success({ parsed_output: validOutput({ main_learnings: [{ ...validOutput().main_learnings[0], evidence: 'P1 had strong retention, 90,000 views.' }] }) })
    mocks.parse.mockResolvedValueOnce(bad).mockResolvedValueOnce(success())
    expect(await settle(callOrganicStrategyAI(skill, built.evidence, ctx))).toMatchObject({ ok: true })
    expect(mocks.inserts.map(r => r.attempt)).toEqual([1, 4]) // second logical attempt starts after the SDK-equivalent retry budget
    expect(new Set(mocks.inserts.map(r => r.feature))).toEqual(new Set(['organic_strategy']))
  })

  it('does not retry a non-retryable error, but still records it', async () => {
    mocks.parse.mockRejectedValue(apiError(400))
    expect(await settle(callOrganicStrategyAI(skill, built.evidence, ctx))).toMatchObject({ ok: false })
    expect(mocks.inserts.every(r => r.status === 'error' && r.feature === 'organic_strategy')).toBe(true)
  })

  it('creates no second telemetry path: nothing is written except ai_usage_events', async () => {
    mocks.parse.mockResolvedValue(success())
    await settle(callOrganicStrategyAI(skill, built.evidence, ctx))
    expect(new Set(mocks.inserts.map(r => r.table))).toEqual(new Set(['ai_usage_events']))
  })

  it('records nothing when no request is made (not configured)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await settle(callOrganicStrategyAI(skill, built.evidence, ctx))
    expect(mocks.inserts).toHaveLength(0)
    expect(mocks.parse).not.toHaveBeenCalled()
  })
})

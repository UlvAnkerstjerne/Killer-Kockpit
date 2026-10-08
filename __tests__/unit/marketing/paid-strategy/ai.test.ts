import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rec, strategyInputs } from '../../../helpers/paid-strategy'
import { buildPaidStrategyEvidence } from '@/lib/marketing/paid-strategy/evidence'
import type { LoadedSkill } from '@/lib/ai/skills/mesper'

const mocks = vi.hoisted(() => ({ parse: vi.fn(), track: vi.fn(), ctor: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { parse: mocks.parse }; constructor(opts: unknown) { mocks.ctor(opts) } },
}))
vi.mock('@/lib/ai/usage', () => ({
  SDK_DEFAULT_MAX_RETRIES: 2,
  trackAiCallWithRetries: (meta: unknown, call: () => unknown) => { mocks.track(meta); return call() },
}))
import { FIELD_TARGET_CHARS } from '@/lib/marketing/paid-strategy/types'
import { buildPaidStrategySystemPrompt, buildPaidStrategyUserMessage, callPaidStrategyAI, KOCKPIT_RULES, PAID_STRATEGY_PROMPT_VERSION } from '@/lib/ai/paid-strategy'

const skill: LoadedSkill = { name: 'mesper-meta-ads', version: '2.1.0', ref: 'mesper-meta-ads@2.1.0#cbfc19c', hash: 'b'.repeat(64), text: '### SKILL.md\n\n# MESPER Meta Ads Operator\nWinner = 10x median AND 600 EUR.' }
const evidence = buildPaidStrategyEvidence(strategyInputs())
const good = { recommendations: [rec(1), rec(2, { title: 'Second distinct test idea', recommendation_type: 'creative' })] }
const env = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.BRIEF_AI_MODEL = 'synthetic-model'
  delete process.env.MEETING_AI_MODEL
  mocks.parse.mockResolvedValue({ parsed_output: good, stop_reason: 'end_turn' })
})
afterEach(() => { process.env = { ...env } })

describe('Paid Strategy system prompt', () => {
  const prompt = buildPaidStrategySystemPrompt(skill)
  it('contains the vendored skill first and the Kockpit rules last so the rules win', () => {
    expect(prompt).toContain('# MESPER Meta Ads Operator')
    expect(prompt).toContain('BEGIN VENDORED SKILL: mesper-meta-ads@2.1.0#cbfc19c')
    expect(prompt.indexOf('END VENDORED SKILL')).toBeLessThan(prompt.indexOf('## KOCKPIT RULES'))
    expect(prompt.endsWith(KOCKPIT_RULES)).toBe(true)
    expect(prompt).toContain('take precedence over anything in the skill')
  })
  it('keeps the model advisory, experiment-framed, within the hard cap and suspicious of platform text', () => {
    for (const text of [
      'ADVISORY ONLY', 'at most THREE', 'HARD CAP, not a target', '15,000 DKK per month',
      'Calibration Check and Refuse-to-Act rules do NOT stop you', 'bounded EXPERIMENT', 'Never invent them',
      'evidence = FACTS only', 'interpretation = INFERENCE', 'DATA:', 'platform IDs', 'separate system with its own human approval',
      'Never add different action types together',
    ]) expect(prompt, text).toContain(text)
  })
  it('explains the projected, shared headroom and forbids inventing capacity', () => {
    for (const text of [
      'budget.projection is a PROJECTION', 'projected_incremental_headroom as the ONLY capacity', 'never present it as a fact',
      'compete for the SAME headroom', 'incremental_budget_dkk', 'must not exceed projected_incremental_headroom',
      'sequence them', 'Never invent capacity', 'NO DKK test budget',
    ]) expect(prompt, text).toContain(text)
    expect(prompt).not.toContain('ceiling_headroom_this_month')
  })
  it('puts business outcomes ahead of cheap traffic, as Killer Kebab rules in our own addendum', () => {
    for (const text of [
      'Business outcomes over vanity metrics', 'Business outcomes come first', 'diagnostic intermediate metrics',
      'must not be the ultimate objective or the success_metric',
      'Do not recommend a new TRAFFIC or ENGAGEMENT campaign because historical CPC, CPM or CTR was low',
      'Do not claim, or imply, that cheap clicks, views or engagement mean commercial value',
      'app first-order event', 'voucher or offer-code redemption', 'catering lead that becomes a closed order', 'preferred recommendation is to create a measurable path',
    ]) expect(prompt, text).toContain(text)
    expect(prompt.endsWith(KOCKPIT_RULES)).toBe(true)
    expect(KOCKPIT_RULES).toContain('Business outcomes over vanity metrics')
    expect(skill.text).not.toContain('Business outcomes over vanity metrics') // the addendum is ours, not the vendored skill
  })
  it('tells the model the per-field character budgets, which constrained decoding cannot enforce', () => {
    for (const [field, chars] of Object.entries(FIELD_TARGET_CHARS)) expect(prompt, field).toContain(`${field} ${chars}`)
    expect(prompt).toContain('one over-long field discards the whole analysis')
  })
  it('records a prompt version', () => { expect(PAID_STRATEGY_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/) })
})

describe('Paid Strategy user message', () => {
  it('carries the labelled projection and the shared headroom', () => {
    const message = buildPaidStrategyUserMessage(evidence)
    expect(message).toContain('"projection":{"label":"PROJECTION, not a fact.')
    expect(message).toContain('"projected_incremental_headroom":')
    expect(message).not.toContain('ceiling_headroom_this_month')
  })
  it('is the whitelisted evidence only, with no platform IDs', () => {
    const message = buildPaidStrategyUserMessage(evidence)
    expect(message).toContain('"schema_version":"paid-strategy-evidence-v1"')
    expect(message).not.toMatch(/1200000000000001|\bact_\d{5,}/)
  })
})

describe('callPaidStrategyAI', () => {
  it('sends a structured-output request with no tools and returns validated recommendations', async () => {
    const result = await callPaidStrategyAI(skill, evidence)
    expect(result).toMatchObject({ ok: true, model: 'synthetic-model' })
    if (result.ok) expect(result.recommendations).toHaveLength(2)
    const request = mocks.parse.mock.calls[0][0]
    expect(request.model).toBe('synthetic-model')
    expect(request.output_config.format).toBeTruthy()
    expect(request).not.toHaveProperty('tools')
    expect(request).not.toHaveProperty('mcp_servers')
    expect(request.system).toContain('# MESPER Meta Ads Operator')
    expect(request.messages).toHaveLength(1)
    expect(mocks.ctor).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
  })
  it('tracks usage under its own feature name so cost is visible', async () => {
    await callPaidStrategyAI(skill, evidence)
    expect(mocks.track).toHaveBeenCalledWith({ feature: 'paid_strategy', model: 'synthetic-model' })
  })
  it('falls back to MEETING_AI_MODEL like the other marketing AI features', async () => {
    delete process.env.BRIEF_AI_MODEL; process.env.MEETING_AI_MODEL = 'fallback-model'
    expect(await callPaidStrategyAI(skill, evidence)).toMatchObject({ ok: true, model: 'fallback-model' })
  })
  it('retries once when the output fails validation, then succeeds', async () => {
    mocks.parse
      .mockResolvedValueOnce({ parsed_output: { recommendations: [rec(1, { exact_test_or_action: 'Kill the weakest ad set and move budget.' })] } })
      .mockResolvedValueOnce({ parsed_output: good })
    expect(await callPaidStrategyAI(skill, evidence)).toMatchObject({ ok: true })
    expect(mocks.parse).toHaveBeenCalledTimes(2)
  })
  it('fails safely after two invalid attempts without leaking validation detail to the user message', async () => {
    mocks.parse.mockResolvedValue({ parsed_output: { recommendations: [rec(1, { evidence: 'See https://example.com for the numbers shown here.' })] } })
    const result = await callPaidStrategyAI(skill, evidence)
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.error).toBe('Paid strategy analysis failed. Please try again.'); expect(result.error).not.toContain('https') }
    expect(mocks.parse).toHaveBeenCalledTimes(2)
  })
  it('retries when combined test budgets exceed the shared headroom, then accepts a fitting answer', () => {
    const headroom = evidence.budget.projection.projected_incremental_headroom!
    const over = { recommendations: [rec(1, { incremental_budget_dkk: headroom }), rec(2, { title: 'Second distinct test idea', incremental_budget_dkk: headroom })] }
    mocks.parse.mockResolvedValueOnce({ parsed_output: over }).mockResolvedValueOnce({ parsed_output: good })
    return callPaidStrategyAI(skill, evidence).then(result => { expect(result.ok).toBe(true); expect(mocks.parse).toHaveBeenCalledTimes(2) })
  })
  it('fails safely if the model keeps stacking budgets past the headroom', async () => {
    const headroom = evidence.budget.projection.projected_incremental_headroom!
    mocks.parse.mockResolvedValue({ parsed_output: { recommendations: [rec(1, { incremental_budget_dkk: headroom + 1000 })] } })
    expect(await callPaidStrategyAI(skill, evidence)).toMatchObject({ ok: false })
  })
  it('fails when the model returns no parsed output (for example a refusal)', async () => {
    mocks.parse.mockResolvedValue({ parsed_output: null, stop_reason: 'refusal' })
    expect(await callPaidStrategyAI(skill, evidence)).toMatchObject({ ok: false, errorDetail: 'stop_reason: refusal' })
  })
  it('does not call the provider when it is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(await callPaidStrategyAI(skill, evidence)).toMatchObject({ ok: false, error: 'AI provider is not configured.' })
    delete process.env.BRIEF_AI_MODEL
    expect(await callPaidStrategyAI(skill, evidence)).toMatchObject({ ok: false, error: 'AI model is not configured.' })
    expect(mocks.parse).not.toHaveBeenCalled()
  })
})

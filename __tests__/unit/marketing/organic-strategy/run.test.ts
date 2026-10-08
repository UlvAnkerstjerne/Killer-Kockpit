import { beforeEach, describe, expect, it, vi } from 'vitest'
import { businessItem, media, ORGANIC_NOW as NOW, smallMeasuredSet, unmeasured, validOutput } from '../../../helpers/organic-strategy'
import type { LoadedClaudeIgSkill } from '@/lib/ai/skills/claude-ig'
import type { createServiceClient } from '@/lib/supabase/server'

const mocks = vi.hoisted(() => ({ call: vi.fn(), loadSkill: vi.fn() }))
vi.mock('@/lib/ai/organic-strategy', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/ai/organic-strategy')>()), callOrganicStrategyAI: mocks.call }))
import { loadLatestFollowers, runOrganicStrategy } from '@/lib/marketing/organic-strategy/generate'
import { ORGANIC_STRATEGY_PROMPT_VERSION } from '@/lib/ai/organic-strategy'

const skill: LoadedClaudeIgSkill = { name: 'claude-ig', version: '2.0.0', ref: 'claude-ig@2.0.0#5e9b2d9', hash: 'd'.repeat(64), text: 'skill text' }
const args = (over: Partial<Parameters<typeof runOrganicStrategy>[0]> = {}) => ({
  media: smallMeasuredSet(), fingerprints: [], businessContext: [businessItem(1)], followersLatest: 5000, now: NOW, loadSkill: mocks.loadSkill, call: mocks.call, ...over,
})
const aiOk = (over: Record<string, unknown> = {}) => ({
  ok: true as const, model: 'synthetic-model', durationMs: 5,
  validated: { output: validOutput(), strengthDowngrades: 1, unmatchedFigures: ['4,321'] }, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadSkill.mockReturnValue(skill)
  mocks.call.mockResolvedValue(aiOk())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('runOrganicStrategy: persistence shape', () => {
  it('returns everything the run needs to store: output, model, prompt version, skill, window and summary', async () => {
    const stored = await runOrganicStrategy(args())
    expect(stored).toMatchObject({
      status: 'completed', model: 'synthetic-model', prompt_version: ORGANIC_STRATEGY_PROMPT_VERSION, message: null,
      skill: { name: 'claude-ig', version: '2.0.0', ref: 'claude-ig@2.0.0#5e9b2d9', hash: 'd'.repeat(64) },
      evidence_summary: { stored_posts: 9, measured_posts: 9, unmeasured_posts: 0, measured_in_prompt: 9, unmeasured_in_prompt: 0, business_context_items: 1 },
      quality: { strength_downgrades: 1, unmatched_figures: ['4,321'] },
    })
    expect(stored.output).toEqual(validOutput())
    expect(Date.parse(stored.generated_at)).not.toBeNaN()
    expect(stored.evidence_window.as_of).toBe('2026-10-08')
    expect(stored.evidence_window.first_published).toMatch(/^2026-/)
    expect(stored.posts).toHaveLength(9)
    expect(stored.posts[0]).toMatchObject({ ref: 'P1' })
  })

  it('is plain JSON that fits comfortably inside the run\'s analytics column', async () => {
    const stored = await runOrganicStrategy(args())
    const json = JSON.stringify(stored)
    expect(JSON.parse(json)).toEqual(stored)
    expect(json.length).toBeLessThan(60_000)
  })

  it('sends the strategist the bounded evidence and the counts it needs to validate refs', async () => {
    await runOrganicStrategy(args({ media: [...smallMeasuredSet(), unmeasured(30), unmeasured(31)] }))
    const [passedSkill, evidence, ctx] = mocks.call.mock.calls[0]
    expect(passedSkill).toBe(skill)
    expect(evidence.posts).toHaveLength(9)
    expect(ctx).toEqual({ measuredInPrompt: 9, unmeasuredInPrompt: 2, businessItems: 1 })
    expect(JSON.stringify(evidence)).not.toMatch(/post-\d|instagram\.com|synthetic-ig/)
  })
})

describe('runOrganicStrategy: skip and failure isolation', () => {
  it('is skipped, without asking the model, when too few posts have performance data', async () => {
    const stored = await runOrganicStrategy(args({ media: [media(1), media(2), unmeasured(3), unmeasured(4)] }))
    expect(stored).toMatchObject({ status: 'skipped', output: null, skill: null })
    expect(stored.message).toMatch(/needs at least 3 posts with performance metrics; 2 found. Nothing was sent to the model/)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.loadSkill).not.toHaveBeenCalled()
    expect(stored.evidence_summary).toMatchObject({ measured_posts: 2, unmeasured_posts: 2 })
  })

  it('is unavailable, not thrown, when the specialist call fails; the skill used is still recorded', async () => {
    mocks.call.mockResolvedValue({ ok: false, error: 'Organic Strategy analysis failed. Please try again.', errorDetail: 'secret detail' })
    const stored = await runOrganicStrategy(args())
    expect(stored).toMatchObject({ status: 'unavailable', output: null, message: 'Organic Strategy analysis failed. Please try again.', model: null })
    expect(stored.skill?.ref).toBe('claude-ig@2.0.0#5e9b2d9')
    expect(JSON.stringify(stored)).not.toContain('secret detail')
    expect(stored.evidence_summary.measured_posts).toBe(9)
  })

  it('is unavailable, without asking the model, when the pinned skill fails verification', async () => {
    mocks.loadSkill.mockImplementation(() => { throw new Error('claude-ig skill file does not match its pinned hash: skills/ig-reel/SKILL.md') })
    const stored = await runOrganicStrategy(args())
    expect(stored).toMatchObject({ status: 'unavailable', output: null, skill: null })
    expect(stored.message).toBe('The pinned claude-ig skill files could not be verified. No analysis was run.')
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('never throws, whatever goes wrong inside', async () => {
    mocks.call.mockRejectedValue(new Error('boom'))
    expect(await runOrganicStrategy(args())).toMatchObject({ status: 'unavailable', output: null })
    expect(await runOrganicStrategy(args({ media: null as never }))).toMatchObject({ status: 'unavailable', message: expect.stringContaining('could not be prepared') })
  })
})

describe('loadLatestFollowers', () => {
  const db = (result: unknown) => ({
    from: () => ({ select: () => ({ not: () => ({ order: () => ({ limit: () => Promise.resolve(result) }) }) }) }),
  }) as unknown as ReturnType<typeof createServiceClient>

  it('returns the latest follower count', async () => {
    expect(await loadLatestFollowers(db({ data: [{ followers_count: 12_345, date: '2026-10-07' }], error: null }))).toBe(12_345)
  })
  it('returns null when absent, malformed or when the query fails: it must never affect the refresh', async () => {
    expect(await loadLatestFollowers(db({ data: [], error: null }))).toBeNull()
    expect(await loadLatestFollowers(db({ data: [{ followers_count: 'many' }], error: null }))).toBeNull()
    expect(await loadLatestFollowers(db({ data: null, error: { code: 'XX' } }))).toBeNull()
    expect(await loadLatestFollowers({ from: () => { throw new Error('down') } } as never)).toBeNull()
  })
})

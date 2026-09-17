import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeeklyImpactBrief, WeeklyImpactEvidence } from '@/lib/weekly-impact/types'
import { buildWeekWindow } from '@/lib/weekly-impact/week'

const { parse, collect, configure } = vi.hoisted(() => ({ parse: vi.fn(), collect: vi.fn(), configure: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/weekly-impact/collect-evidence', () => ({ collectWeeklyImpactEvidence: collect }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor(options: unknown) { configure(options) } messages = { parse } } }))
import { generateWeeklyImpactPreview } from '@/lib/weekly-impact/generate'

const pack: WeeklyImpactEvidence = {
  user: { id: 'user-1', name: 'Test User', email: 'test@example.com' }, week: buildWeekWindow('2026-09-07'),
  completedTasks: [], completedTodos: [], movedProjects: [], meetings: [], decisions: [], resolvedWaitingOns: [], authoredUpdates: [], nextWeek: [],
  counts: { tasksCompleted: 0, todosCompleted: 0, projectsMoved: 0, meetings: 0, decisions: 0, waitingOnsResolved: 0, updatesShared: 0 },
}
const brief: WeeklyImpactBrief = { openingSynthesis: 'There is too little recorded activity to identify a supported theme this week.', themes: [], whatMoved: [], goingIntoNextWeek: [] }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('BRIEF_AI_MODEL', 'configured-model'); vi.stubEnv('ANTHROPIC_API_KEY', 'test-key'); collect.mockResolvedValue(pack) })
afterEach(() => vi.unstubAllEnvs())

describe('single-pass weekly synthesis', () => {
  it('collects and prepares evidence once, then makes exactly one AI call using normal model settings', async () => {
    parse.mockResolvedValue({ parsed_output: brief })
    const preview = await generateWeeklyImpactPreview('user-1', '2026-09-07')
    expect(collect).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(configure).toHaveBeenCalledWith({ apiKey: 'test-key', maxRetries: 0 })
    expect(parse.mock.calls[0][0]).toMatchObject({ model: 'configured-model', max_tokens: 3000 })
    expect(parse.mock.calls[0][0].thinking).toBeUndefined()
    expect(parse.mock.calls[0][0].output_config.effort).toBeUndefined()
    expect(parse.mock.calls[0][0].messages[0].content).toContain('activityClusters')
    expect(preview.evidence).toBe(pack)
    expect(preview.activityAnalysis.totalCompletedTodos).toBe(0)
    expect(preview.html).toContain('YOUR WEEK')
  })
  it('does not launch editorial passes for imperfect wording or length', async () => {
    parse.mockResolvedValue({ parsed_output: { ...brief, openingSynthesis: 'word '.repeat(70) } })
    await generateWeeklyImpactPreview('user-1', '2026-09-07')
    expect(parse).toHaveBeenCalledTimes(1)
  })
  it('reports invalid output without an automatic retry', async () => {
    parse.mockRejectedValue(new Error('Invalid structured output'))
    await expect(generateWeeklyImpactPreview('user-1', '2026-09-07')).rejects.toThrow('Invalid structured output')
    expect(parse).toHaveBeenCalledTimes(1)
  })
  it('reports truncated output without an automatic retry', async () => {
    parse.mockResolvedValue({ parsed_output: null, stop_reason: 'max_tokens' })
    await expect(generateWeeklyImpactPreview('user-1', '2026-09-07')).rejects.toThrow('No valid structured output (max_tokens)')
    expect(parse).toHaveBeenCalledTimes(1)
  })
})

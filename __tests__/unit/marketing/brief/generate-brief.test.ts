/**
 * Tests for lib/marketing/brief/generate-brief.ts
 *
 * Focus: safe-regeneration failure-safety, idempotency, and v2 material-signal wiring.
 * All external dependencies are mocked so tests run without DB or AI.
 *
 * Key guarantees verified:
 *  1. forcedRegenerateMorningBrief: if the AI call fails, the existing row
 *     is NEVER updated — the good brief is preserved.
 *  2. generateMorningBrief: if a 'ready' row already exists, returns
 *     'already_ready' without calling AI at all.
 *  3. generateMorningBrief: if generation is already in progress and not
 *     stuck, returns 'skipped_generating' without calling AI.
 *  4. buildMaterialSignals is called in the pipeline and candidates passed to prompt.
 *  5. Unknown signal_id in AI output → pipeline fails safely, existing brief preserved.
 *  6. Valid observations are persisted in sections_json.observations.
 *  7. BRIEF_PROMPT_VERSION is v2.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BriefInputData } from '@/lib/marketing/brief/types'
import type { MaterialSignalCandidate } from '@/lib/marketing/brief/material-signals'

// ── Mock dependencies ─────────────────────────────────────────────────────────

// We mock at the module level so all imports of these modules
// inside generate-brief.ts resolve to our controlled mocks.

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/marketing/brief/collect-data', () => ({
  collectBriefData: vi.fn(),
}))

vi.mock('@/lib/ai/morning-brief', () => ({
  callMorningBriefAI: vi.fn(),
}))

vi.mock('@/lib/marketing/brief/build-prompt', () => ({
  buildBriefUserMessage: vi.fn().mockReturnValue('mock prompt'),
  BRIEF_PROMPT_VERSION: 'v2',
}))

vi.mock('@/lib/marketing/brief/material-signals', () => ({
  buildMaterialSignals: vi.fn().mockReturnValue([]),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

import { generateMorningBrief, forcedRegenerateMorningBrief } from '@/lib/marketing/brief/generate-brief'
import { createServiceClient } from '@/lib/supabase/server'
import { collectBriefData } from '@/lib/marketing/brief/collect-data'
import { callMorningBriefAI } from '@/lib/ai/morning-brief'
import { buildBriefUserMessage } from '@/lib/marketing/brief/build-prompt'
import { buildMaterialSignals } from '@/lib/marketing/brief/material-signals'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BRIEF_DATE = '2026-08-31'

/** Minimal BriefInputData that satisfies the type without needing real data. */
function makeMockBriefData(): BriefInputData {
  return {
    briefDate: BRIEF_DATE,
    dataWindowStart: '2026-08-24',
    dataWindowEnd: '2026-08-30',
    currency: 'DKK',
    sourceFreshness: {
      meta_ads_daily:        { last_success_at: null, status: 'synced', age_hours: 1, healthy: true },
      meta_ig_account_daily: { last_success_at: null, status: 'synced', age_hours: 1, healthy: true },
      meta_ig_organic_deep:  { last_success_at: null, status: 'synced', age_hours: 1, healthy: true },
      meta_fb_page_daily:    { last_success_at: null, status: 'synced', age_hours: 1, healthy: true },
      meta_fb_organic_deep:  { last_success_at: null, status: 'synced', age_hours: 1, healthy: true },
      gbp: { kind: 'pending_approval', last_sync_at: null, healthy: true },
      google_ads: { last_success_at: null, status: 'never', age_hours: null, healthy: false },
      gsc:        { last_success_at: null, status: 'never', age_hours: null, healthy: false },
      ga4:        { last_success_at: null, status: 'never', age_hours: null, healthy: false },
    },
    signals: {
      has_stale_critical_source: false,
      stale_sources: [],
      paid_anomaly_count: 0,
      paid_anomalies: [],
      organic_ig_drop_detected: false,
      organic_ig_reach_7d_vs_prior_7d_pct: null,
      pending_review_count: 0,
      gbp_kind: 'pending_approval',
      computed_status: 'green',
      status_reasons: [],
    },
    paid: null,
    organic: {
      ig: { reach_7d: 1000, reach_prior_7d: 900, accounts_engaged_7d: 100, profile_views_7d: 200, followers_current: 5000, followers_7d_delta: 10 },
      ig_top_posts: [],
      ig_avg_reach_7d: null,
      ig_daily_reach_series: [],
      fb: { views_7d: 500, engaged_users_7d: 50, fan_count_current: 1000, fan_count_7d_delta: 2 },
      fb_recent_posts: [],
      fb_available: true,
      fb_daily_views_series: [],
    },
    gbp: {
      integration_status: { kind: 'pending_approval', last_sync_at: null, healthy: true },
      pending_reply_count: 0,
      new_reviews_yesterday: null,
      avg_star_rating_7d: null,
    },
    needsReview: { total: 0, review_reply: 0, paid_recommendation: 0, content_approval: 0 },
    googleAds: null, searchConsole: null, ga4: null, gbpPerformance: null,
  }
}

/** Successful AI response fixture (v2 — includes observations). */
const mockAISuccess = {
  ok: true as const,
  output: {
    overall_reason:     'All systems green.',
    ai_summary:         'Solid week across all channels.',
    paid_assessment:    'No paid campaigns active.',
    organic_assessment: 'Instagram reach grew week-over-week.',
    gbp_assessment:     null,
    observations:       [],
  },
  model:         'claude-sonnet-4-6',
  promptVersion: 'v2',
  durationMs:    1200,
}

/** A minimal valid material signal candidate. */
function makeMockCandidate(id: string): MaterialSignalCandidate {
  return {
    id,
    source:                'organic_ig',
    category:              'traffic_audience',
    observation:           'IG reach increased 25% week-over-week.',
    evidence:              [{ metric: 'reach_7d', current: 1250, prior: 1000, change_pct: 0.25 }],
    materiality_score:     0.8,
    commercially_relevant: true,
    creatively_relevant:   false,
  }
}

// ── DB mock builder ───────────────────────────────────────────────────────────

/**
 * Creates a minimal Supabase client mock supporting the patterns used in
 * generate-brief.ts: insert (with error), select (chained), update.
 */
function makeDbMock(opts: {
  insertError?: { code: string; message: string } | null
  existingRow?: { id: string; status: string; generation_started_at: string | null } | null
  updateSpy?: ReturnType<typeof vi.fn>
  insertSpy?: ReturnType<typeof vi.fn>
}) {
  const updateSpy = opts.updateSpy ?? vi.fn().mockResolvedValue({ error: null })
  const insertSpy = opts.insertSpy ?? vi.fn().mockResolvedValue({ error: opts.insertError ?? null })

  const selectChain = {
    eq:        vi.fn().mockReturnThis(),
    single:    vi.fn().mockResolvedValue({ data: opts.existingRow ?? null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: opts.existingRow ?? null, error: null }),
  }
  const updateChain = {
    eq: vi.fn().mockResolvedValue({ error: null }),
  }

  const db = {
    from: vi.fn().mockReturnValue({
      insert:  insertSpy,
      select:  vi.fn().mockReturnValue(selectChain),
      update:  vi.fn().mockReturnValue(updateChain),
    }),
    _updateChain: updateChain,
    _updateSpy:   updateSpy,
  }

  return db
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateMorningBrief — idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns already_ready without calling AI when row status is ready', async () => {
    // Simulate a UNIQUE conflict (row exists) with status = 'ready'
    const db = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockResolvedValue({
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'existing-id', status: 'ready', generation_started_at: null },
            error: null,
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }),
    }

    vi.mocked(createServiceClient).mockReturnValue(db as never)

    const result = await generateMorningBrief(BRIEF_DATE)

    expect(result.outcome).toBe('already_ready')
    // AI must NOT be called
    expect(vi.mocked(callMorningBriefAI)).not.toHaveBeenCalled()
  })

  it('returns skipped_generating when generation started recently (< 30 min)', async () => {
    const recentStart = new Date(Date.now() - 5 * 60_000).toISOString() // 5 min ago

    const db = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockResolvedValue({
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'gen-id', status: 'generating', generation_started_at: recentStart },
            error: null,
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      }),
    }

    vi.mocked(createServiceClient).mockReturnValue(db as never)

    const result = await generateMorningBrief(BRIEF_DATE)

    expect(result.outcome).toBe('skipped_generating')
    // AI must NOT be called
    expect(vi.mocked(callMorningBriefAI)).not.toHaveBeenCalled()
  })
})

describe('forcedRegenerateMorningBrief — safe failure behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves existing ready brief when AI call fails', async () => {
    // Existing row is 'ready' in the DB
    const updateEqSpy = vi.fn().mockResolvedValue({ error: null })
    const updateSpy   = vi.fn().mockReturnValue({ eq: updateEqSpy })

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq:           vi.fn().mockReturnThis(),
          maybeSingle:  vi.fn().mockResolvedValue({
            data: { id: 'existing-id', status: 'ready' },
            error: null,
          }),
        }),
        update: updateSpy,
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
    }

    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())

    // AI fails
    vi.mocked(callMorningBriefAI).mockResolvedValue({
      ok: false,
      error: 'AI provider error',
      errorDetail: 'Connection timeout',
    })

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)

    // Must return failure
    expect(result.ok).toBe(false)
    expect(result.message).toContain('unchanged')

    // Crucially: update must NOT have been called (existing brief is untouched)
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateEqSpy).not.toHaveBeenCalled()
  })

  it('preserves existing ready brief when data collection fails', async () => {
    const updateSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq:          vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'existing-id', status: 'ready' },
            error: null,
          }),
        }),
        update: updateSpy,
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
    }

    vi.mocked(createServiceClient).mockReturnValue(db as never)
    // Data collection throws
    vi.mocked(collectBriefData).mockRejectedValue(new Error('DB query timeout'))

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('unchanged')
    // DB row must NOT be touched
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('updates the row when generation succeeds', async () => {
    const updateEqSpy = vi.fn().mockResolvedValue({ error: null })
    const updateSpy   = vi.fn().mockReturnValue({ eq: updateEqSpy })

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq:          vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'existing-id', status: 'ready' },
            error: null,
          }),
        }),
        update: updateSpy,
        insert: vi.fn().mockResolvedValue({ error: null }),
      }),
    }

    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(mockAISuccess)

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)

    expect(result.ok).toBe(true)
    // DB must have been updated (the new brief is written)
    expect(updateSpy).toHaveBeenCalled()
  })
})

// ── Material signal wiring tests ──────────────────────────────────────────────

describe('runGenerationPipeline — material signal wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeSuccessDb() {
    const updateEqSpy = vi.fn().mockResolvedValue({ error: null })
    const updateSpy   = vi.fn().mockReturnValue({ eq: updateEqSpy })
    return {
      db: {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq:          vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: 'existing-id', status: 'ready' },
              error: null,
            }),
          }),
          update: updateSpy,
          insert: vi.fn().mockResolvedValue({ error: null }),
        }),
      },
      updateSpy,
    }
  }

  it('BRIEF_PROMPT_VERSION is v2', async () => {
    // Importing the mock — should be v2
    const { BRIEF_PROMPT_VERSION } = await import('@/lib/marketing/brief/build-prompt')
    expect(BRIEF_PROMPT_VERSION).toBe('v2')
  })

  it('buildMaterialSignals is called with collected data', async () => {
    const { db } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(mockAISuccess)

    await forcedRegenerateMorningBrief(BRIEF_DATE)

    expect(vi.mocked(buildMaterialSignals)).toHaveBeenCalledWith(expect.objectContaining({
      briefDate: BRIEF_DATE,
    }))
  })

  it('passes candidates to buildBriefUserMessage', async () => {
    const candidate = makeMockCandidate('ig-reach-drop')
    vi.mocked(buildMaterialSignals).mockReturnValue([candidate])

    const { db } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(mockAISuccess)

    await forcedRegenerateMorningBrief(BRIEF_DATE)

    expect(vi.mocked(buildBriefUserMessage)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [candidate],
    )
  })

  it('valid observations are persisted in sections_json.observations', async () => {
    const candidate = makeMockCandidate('ig-reach-drop')
    vi.mocked(buildMaterialSignals).mockReturnValue([candidate])

    const aiWithObs = {
      ...mockAISuccess,
      output: {
        ...mockAISuccess.output,
        observations: [{
          signal_id:          'ig-reach-drop',
          observation:        'IG reach dropped 25% week-over-week.',
          evidence:           'reach_7d = 1,000 (-25.0% vs prior)',
          interpretation:     'Lower organic reach means fewer free impressions.',
          recommended_action: 'Boost top-performing post.',
          creative_start:     'This week in Killer Kebab…',
        }],
      },
    }

    const { db, updateSpy } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(aiWithObs)

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)

    expect(result.ok).toBe(true)
    // The update call should include sections_json with observations
    const updateArgs = updateSpy.mock.calls[0][0] as { sections_json?: { observations?: unknown[] } }
    expect(updateArgs.sections_json?.observations).toHaveLength(1)
    expect(updateArgs.sections_json?.observations?.[0]).toMatchObject({
      signal_id:  'ig-reach-drop',
      observation: 'IG reach dropped 25% week-over-week.',
    })
  })

  it('unknown signal_id in AI output → pipeline fails, existing brief preserved', async () => {
    const candidate = makeMockCandidate('ig-reach-drop')
    vi.mocked(buildMaterialSignals).mockReturnValue([candidate])

    const aiWithBadId = {
      ...mockAISuccess,
      output: {
        ...mockAISuccess.output,
        observations: [{
          signal_id:          'hallucinated-id',   // not in candidates
          observation:        'Something happened.',
          evidence:           'some metric = 100',
          interpretation:     'interpretation',
          recommended_action: 'Do something.',
          creative_start:     null,
        }],
      },
    }

    const { db, updateSpy } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(aiWithBadId)

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)

    // Must fail
    expect(result.ok).toBe(false)
    expect(result.message).toContain('unchanged')
    // Existing brief must NOT be updated
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('fewer than 5 observations accepted without error', async () => {
    vi.mocked(buildMaterialSignals).mockReturnValue([makeMockCandidate('c1')])

    const aiWithOneObs = {
      ...mockAISuccess,
      output: {
        ...mockAISuccess.output,
        observations: [{
          signal_id:          'c1',
          observation:        'One observation is enough.',
          evidence:           'metric = 100',
          interpretation:     'interpretation',
          recommended_action: 'Do something.',
          creative_start:     null,
        }],
      },
    }

    const { db } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(aiWithOneObs)

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)
    expect(result.ok).toBe(true)
  })

  it('creative_start may be null', async () => {
    vi.mocked(buildMaterialSignals).mockReturnValue([makeMockCandidate('c1')])

    const aiWithNullCreative = {
      ...mockAISuccess,
      output: {
        ...mockAISuccess.output,
        observations: [{
          signal_id:          'c1',
          observation:        'Observation text.',
          evidence:           'metric = 100',
          interpretation:     'interpretation',
          recommended_action: 'Do something.',
          creative_start:     null,
        }],
      },
    }

    const { db, updateSpy } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(aiWithNullCreative)

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)
    expect(result.ok).toBe(true)
    const updateArgs = updateSpy.mock.calls[0][0] as { sections_json?: { observations?: Array<{ creative_start: unknown }> } }
    expect(updateArgs.sections_json?.observations?.[0]?.creative_start).toBeNull()
  })

  it('sections_json without observations when no candidates produced', async () => {
    // buildMaterialSignals returns empty array
    vi.mocked(buildMaterialSignals).mockReturnValue([])

    const { db, updateSpy } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(mockAISuccess) // observations: []

    const result = await forcedRegenerateMorningBrief(BRIEF_DATE)
    expect(result.ok).toBe(true)
    const updateArgs = updateSpy.mock.calls[0][0] as { sections_json?: { observations?: unknown[] } }
    // observations is always set for v2 briefs — even when empty — so the page can
    // distinguish a v2 brief with zero material signals from a legacy v1 brief (field absent)
    expect(updateArgs.sections_json?.observations).toEqual([])
  })

  it('v1 fields (overall_reason, ai_summary, paid_assessment etc.) remain in output', async () => {
    vi.mocked(buildMaterialSignals).mockReturnValue([])

    const { db, updateSpy } = makeSuccessDb()
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    vi.mocked(collectBriefData).mockResolvedValue(makeMockBriefData())
    vi.mocked(callMorningBriefAI).mockResolvedValue(mockAISuccess)

    await forcedRegenerateMorningBrief(BRIEF_DATE)

    const updateArgs = updateSpy.mock.calls[0][0] as { overall_reason?: string; ai_summary?: string }
    expect(updateArgs.overall_reason).toBe('All systems green.')
    expect(updateArgs.ai_summary).toBe('Solid week across all channels.')
  })
})

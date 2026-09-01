/**
 * Tests for lib/marketing/brief/generate-brief.ts
 *
 * Focus: safe-regeneration failure-safety and idempotency behavior.
 * All external dependencies are mocked so tests run without DB or AI.
 *
 * Key guarantees verified:
 *  1. forcedRegenerateMorningBrief: if the AI call fails, the existing row
 *     is NEVER updated — the good brief is preserved.
 *  2. generateMorningBrief: if a 'ready' row already exists, returns
 *     'already_ready' without calling AI at all.
 *  3. generateMorningBrief: if generation is already in progress and not
 *     stuck, returns 'skipped_generating' without calling AI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BriefInputData } from '@/lib/marketing/brief/types'

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
  BRIEF_PROMPT_VERSION: 'v1',
}))

// ── Import after mocks ────────────────────────────────────────────────────────

import { generateMorningBrief, forcedRegenerateMorningBrief } from '@/lib/marketing/brief/generate-brief'
import { createServiceClient } from '@/lib/supabase/server'
import { collectBriefData } from '@/lib/marketing/brief/collect-data'
import { callMorningBriefAI } from '@/lib/ai/morning-brief'

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
      fb: { views_7d: 500, engaged_users_7d: 50, fan_count_current: 1000, fan_count_7d_delta: 2 },
      fb_recent_posts: [],
      fb_available: true,
    },
    gbp: {
      integration_status: { kind: 'pending_approval', last_sync_at: null, healthy: true },
      pending_reply_count: 0,
      new_reviews_yesterday: null,
      avg_star_rating_7d: null,
    },
    needsReview: { total: 0, review_reply: 0, paid_recommendation: 0, content_approval: 0 },
  }
}

/** Successful AI response fixture. */
const mockAISuccess = {
  ok: true as const,
  output: {
    overall_reason:     'All systems green.',
    ai_summary:         'Solid week across all channels.',
    paid_assessment:    'No paid campaigns active.',
    organic_assessment: 'Instagram reach grew week-over-week.',
    gbp_assessment:     null,
  },
  model:         'claude-sonnet-4-6',
  promptVersion: 'v1',
  durationMs:    1200,
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

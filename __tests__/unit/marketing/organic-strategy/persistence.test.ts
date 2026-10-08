import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { readdirSync } from 'node:fs'
import { mainSchemaDatabase, migrationSql, REVIEW_DESK_RELEASE } from '../../../helpers/gbp-release-postgres'
import { storedStrategy, validOutput } from '../../../helpers/organic-strategy'
import { savedRun } from '../../../helpers/creative-brain'
import { FIELD_MAX_CHARS, MAX_CAROUSELS, MAX_LEARNINGS, MAX_OPPORTUNITIES, MAX_REELS, MAX_SLIDES, type OrganicStrategyStored } from '@/lib/marketing/organic-strategy/types'

// Proves, against real PostgreSQL and the REAL Creative Intelligence migration, that the existing
// run table can hold the strategy inside analytics JSONB: no migration is required.
const MIGRATION = '20260924150815_marketing_creative_intelligence.sql'
let db: PGlite

beforeAll(async () => {
  db = await mainSchemaDatabase()
  for (const file of readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f >= REVIEW_DESK_RELEASE[0] && f <= MIGRATION).sort()) await db.exec(migrationSql(file))
}, 120_000)
afterAll(async () => { await db?.close() })

/** Every text field at its HARD maximum and every list full: the largest strategy the schema can possibly produce. */
function worstCase(): OrganicStrategyStored {
  const text = (n: number) => 'x'.repeat(n)
  const M = FIELD_MAX_CHARS
  const many = <T,>(n: number, make: () => T) => Array.from({ length: n }, make)
  return storedStrategy({
    posts: many(80, () => ({ ref: 'P40', published_at: '2026-09-20T10:00:00Z', media_type: 'CAROUSEL_ALBUM', permalink: `https://www.instagram.com/p/${text(40)}/` })),
    quality: { strength_downgrades: 9, unmatched_figures: many(10, () => '4,321,000') },
    output: {
      main_learnings: many(MAX_LEARNINGS, () => ({ title: text(M.title), evidence: text(M.evidence), interpretation: text(M.interpretation), evidence_strength: 'weak_signal' as const, limitations: text(M.limitations) })),
      content_opportunities: many(MAX_OPPORTUNITIES, () => ({ title: text(M.title), why_now: text(M.why_now), evidence_basis: text(M.evidence_basis), suggested_angle: text(M.suggested_angle), evidence_strength: 'weak_signal' as const })),
      reel_concepts: many(MAX_REELS, () => ({ concept_title: text(M.title), hook: text(M.hook), core_idea: text(M.core_idea), execution: text(M.execution), why_this_is_worth_testing: text(M.why_worth_testing), evidence_basis: text(M.evidence_basis) })),
      carousel_concepts: many(MAX_CAROUSELS, () => ({ concept_title: text(M.title), opening_slide: text(M.opening_slide), slide_structure: many(MAX_SLIDES, () => text(M.slide)), why_this_is_worth_testing: text(M.why_worth_testing), evidence_basis: text(M.evidence_basis) })),
    },
  })
}

async function insertRun(analytics: unknown, status = 'completed') {
  await db.exec('SET ROLE service_role')
  try {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO marketing_creative_intelligence_runs(analysis_start,analysis_end,prompt_version,classification_version,status,analytics)
      VALUES ('2026-07-10','2026-10-08','2026-09-24-v1','creative-v1',$1,$2::jsonb) RETURNING id`, [status, JSON.stringify(analytics)])
    return rows[0].id
  } finally { await db.exec('RESET ROLE') }
}

describe('Organic Strategy persistence in marketing_creative_intelligence_runs.analytics', () => {
  it('stores the strategy, model, prompt version and skill metadata inside the existing analytics JSONB, and reads them back', async () => {
    const run = savedRun()
    const stored = storedStrategy()
    const id = await insertRun({ ...run.analytics, business_context: [], organic_strategy: stored })
    const { rows } = await db.query<{ strategy: OrganicStrategyStored; window_start: string }>(
      `SELECT analytics->'organic_strategy' AS strategy, analytics->'window'->>'start' AS window_start FROM marketing_creative_intelligence_runs WHERE id = $1`, [id])
    expect(rows[0].strategy).toEqual(stored)
    expect(rows[0].strategy.skill).toEqual({ name: 'claude-ig', version: '2.0.0', ref: 'claude-ig@2.0.0#5e9b2d9', hash: 'a'.repeat(64) })
    expect(rows[0].strategy).toMatchObject({ model: 'synthetic-model', prompt_version: '2026-10-08-v1', evidence_window: { as_of: '2026-10-08' } })
    expect(rows[0].window_start).toBeTruthy() // the deterministic analytics are intact next to it
  })

  it('still accepts runs created before the feature: no organic_strategy key at all', async () => {
    const run = savedRun()
    const id = await insertRun(run.analytics)
    const { rows } = await db.query<{ has: boolean }>(`SELECT (analytics ? 'organic_strategy') AS has FROM marketing_creative_intelligence_runs WHERE id = $1`, [id])
    expect(rows[0].has).toBe(false)
  })

  it('stores an unavailable strategy on a partial run without touching the deterministic columns', async () => {
    const run = savedRun()
    const unavailable = storedStrategy({ status: 'unavailable', output: null, model: null, message: 'Organic Strategy analysis failed. Please try again.' })
    const id = await insertRun({ ...run.analytics, organic_strategy: unavailable }, 'partial')
    const { rows } = await db.query<{ status: string; s: string }>(`SELECT status, analytics->'organic_strategy'->>'status' AS s FROM marketing_creative_intelligence_runs WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ status: 'partial', s: 'unavailable' })
  })

  it('fits the largest possible strategy (every field at its hard maximum, every list full) inside the column\'s size limit', async () => {
    const run = savedRun()
    const stored = worstCase()
    const bytes = Buffer.byteLength(JSON.stringify({ ...run.analytics, organic_strategy: stored }))
    expect(bytes).toBeLessThan(400_000) // far below the 2,000,000-byte CHECK on analytics
    const id = await insertRun({ ...run.analytics, organic_strategy: stored })
    const { rows } = await db.query<{ n: number }>(`SELECT octet_length(analytics::text) AS n FROM marketing_creative_intelligence_runs WHERE id = $1`, [id])
    expect(rows[0].n).toBeLessThanOrEqual(2_000_000)
  })

  it('needs no schema change: no migration for this feature exists in the repository', () => {
    const migrations = readdirSync('supabase/migrations')
    expect(migrations.filter(f => /organic|strategy/i.test(f) && !/paid_strategy/i.test(f))).toEqual([])
  })

  it('keeps the strategy within the output the schema allows', () => {
    expect(validOutput().reel_concepts.length).toBeLessThanOrEqual(MAX_REELS)
  })
})

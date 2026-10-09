import { describe, expect, it } from 'vitest'
import { extractFromCreativeRun, extractFromOrganic, extractFromPaidRun } from '@/lib/marketing/insights/extract'
import { currentRun } from '../../../helpers/creative-brain'
import { storedStrategy, validOutput } from '../../../helpers/organic-strategy'
import { REAL_RECS } from '../../../helpers/paid-strategy-real-recs'
import { creativeRunAt, day, paidRunAt } from '../../../helpers/insights'

describe('Creative Intelligence extraction', () => {
  it('keeps the conclusion (not the action) as an insight with a stable key from its signal ids', () => {
    const run = currentRun()
    const ex = extractFromCreativeRun(run)
    const creative = ex.candidates.filter(c => c.domain === 'creative')
    expect(creative).toHaveLength(1)
    const ids = (run.observations[0] as { signal_ids: string[] }).signal_ids
    expect(creative[0].stable_key).toBe(`creative:${[...ids].sort().join('|')}`)
    expect(creative[0].kind).toBe('finding')
    expect(creative[0].statement).toBe((run.observations[0] as { take: string }).take)
    // the suggestion stays apart from the statement so it is never read as a finding
    expect(creative[0].suggestion).toBe((run.observations[0] as { next_move: string }).next_move)
    expect(creative[0].statement).not.toContain(creative[0].suggestion!)
  })
  it('is conservative: creative evidence is never labelled a strong repeated pattern', () => {
    const ex = extractFromCreativeRun(currentRun())
    for (const c of ex.candidates.filter(x => x.domain === 'creative')) expect(['reasonable_inference', 'weak_signal']).toContain(c.strength)
  })
  it('references its sources: the signals and the supporting posts (permalinks, never platform ids)', () => {
    const c = extractFromCreativeRun(currentRun()).candidates.find(x => x.domain === 'creative')!
    expect(c.refs.some(r => r.type === 'creative_signal')).toBe(true)
    expect(JSON.stringify(c.refs)).not.toMatch(/media_id|"id":/)
    expect(c.refs.filter(r => r.type === 'instagram_post').length).toBeLessThanOrEqual(6)
  })
  it('covers creative on a completed run, even when no insight reached the bar, so absence can mean something', () => {
    const run = { ...currentRun(), observations: [] }
    expect(extractFromCreativeRun(run).coverage.creative).toBe(true)
    expect(extractFromCreativeRun({ ...run, status: 'partial' as const }).coverage.creative).toBe(false)
  })
  it('does not turn legacy one-signal observations into conclusions', () => {
    const run = { ...currentRun(), observations: [{ signal_id: 'x', finding: 'f', evidence: 'e', interpretation: 'i', suggested_experiment: 's' }] }
    expect(extractFromCreativeRun(run).candidates.filter(c => c.domain === 'creative')).toHaveLength(0)
  })
})

describe('Organic Strategy extraction', () => {
  it('captures main learnings and content opportunities, and leaves Reel and carousel concepts to the strategy', () => {
    const out = extractFromOrganic(storedStrategy())!
    expect(out.filter(c => c.kind === 'finding')).toHaveLength(2)
    expect(out.filter(c => c.kind === 'content_opportunity')).toHaveLength(1)
    expect(out.every(c => c.domain === 'organic')).toBe(true)
    expect(JSON.stringify(out)).not.toContain('The 36 hour question')
  })
  it('maps proven_pattern to the strong pattern label and keeps weaker labels weaker', () => {
    const stored = storedStrategy({ output: validOutput({ main_learnings: [
      { title: 'A repeated one', evidence: 'P1 P2 P3 agree.', interpretation: 'It may travel.', evidence_strength: 'proven_pattern', limitations: 'Small set.' },
      { title: 'A thin one', evidence: 'P1 alone.', interpretation: 'Maybe.', evidence_strength: 'weak_signal', limitations: 'One post.' },
    ] }) })
    const [a, b] = extractFromOrganic(stored)!
    expect([a.strength, b.strength]).toEqual(['strong_pattern', 'weak_signal'])
  })
  it('keeps the suggested angle apart from the evidence on a content opportunity', () => {
    const opp = extractFromOrganic(storedStrategy())!.find(c => c.kind === 'content_opportunity')!
    expect(opp.suggestion).toMatch(/process people do not expect/)
    expect(opp.statement).not.toContain(opp.suggestion!)
    expect(opp.evidence_text).toMatch(/90,000 views/)
  })
  it('resolves cited post refs to stored permalinks and ignores refs it cannot resolve', () => {
    const learning = extractFromOrganic(storedStrategy())!.find(c => c.kind === 'finding')!
    const posts = learning.refs.filter(r => r.type === 'instagram_post')
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.every(r => r.type === 'instagram_post' && r.ref !== null && /^[PU]\d+$/.test(r.ref))).toBe(true)
  })
  it('returns null (silence, not absence) when the specialist step did not complete', () => {
    expect(extractFromOrganic(storedStrategy({ status: 'unavailable', output: null }))).toBeNull()
    expect(extractFromOrganic(storedStrategy({ status: 'skipped', output: null }))).toBeNull()
    const ex = extractFromCreativeRun(creativeRunAt('r', day(2), null))
    expect(ex.coverage.organic).toBe(false)
  })
})

describe('Paid Strategy extraction', () => {
  it('keeps each recommendation’s interpretation as an untested hypothesis, linked back to its recommendation', () => {
    const ex = extractFromPaidRun(paidRunAt('p1', day(3)))
    expect(ex.candidates).toHaveLength(3)
    expect(ex.candidates.map(c => c.recommendation_index)).toEqual([0, 1, 2])
    expect(ex.candidates.every(c => c.strength === 'hypothesis' && c.domain === 'paid')).toBe(true)
    expect(ex.candidates[0].statement).toBe(REAL_RECS[0].interpretation)
    expect(ex.candidates[0].suggestion).toBeNull() // the action stays with the recommendation
    expect(ex.candidates[0].refs).toEqual([expect.objectContaining({ type: 'paid_strategy_run', run_id: 'p1', index: 0 })])
  })
  it('keeps a retargeting recommendation as a retargeting hypothesis (its hypothesis, not its interpretation)', () => {
    const recs = [{ ...REAL_RECS[0], recommendation_type: 'retargeting' as const, hypothesis: 'People who watched a Reel may convert at a lower cost than cold audiences.' }]
    const [c] = extractFromPaidRun(paidRunAt('p2', day(3), recs as never)).candidates
    expect(c.kind).toBe('retargeting_hypothesis')
    expect(c.statement).toBe(recs[0].hypothesis)
    expect(c.scope_key).toBe('paid:retargeting_hypothesis:retargeting')
  })
  it('does not treat a run with no recommendations as covering paid (nothing worth recommending is not a refutation)', () => {
    expect(extractFromPaidRun(paidRunAt('p3', day(3), [])).coverage.paid).toBe(false)
    expect(extractFromPaidRun(paidRunAt('p4', day(3))).coverage.paid).toBe(true)
  })
  it('titles a paid insight from its first sentence, capped', () => {
    const [c] = extractFromPaidRun(paidRunAt('p5', day(3), [{ ...REAL_RECS[0], interpretation: `${'word '.repeat(60)}. Second sentence.` }] as never)).candidates
    expect(c.title.length).toBeLessThanOrEqual(110)
    expect(c.title).not.toContain('Second sentence')
  })
})

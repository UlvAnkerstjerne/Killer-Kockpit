// Regression: synced Meta budgets are MINOR units ("8000" = 80 DKK). The v1 AI-intent path passed them raw
// to the trusted compiler while the executor adapter reads whole units, so a campaign-level budget change
// could never compile or pass its own guardrail ("Budget changed since approval was proposed").
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileExecutionPlan } from '@/lib/marketing/paid-recs/compile-plan'
import { checkExecutionGuardrails } from '@/lib/marketing/paid-recs/guardrails'
import { majorToMetaBudget, metaBudgetToMajor } from '@/lib/meta/money'

describe('Meta budget units', () => {
  it('converts minor units (possibly decimal strings) to whole units, and back', () => {
    expect(metaBudgetToMajor('8000')).toBe(80)
    expect(metaBudgetToMajor('10000.000000')).toBe(100)
    expect(metaBudgetToMajor(null)).toBeNull(); expect(metaBudgetToMajor('')).toBeNull(); expect(metaBudgetToMajor('0')).toBeNull(); expect(metaBudgetToMajor('abc')).toBeNull()
    expect(majorToMetaBudget(80)).toBe(8000); expect(majorToMetaBudget(79.99)).toBe(7999)
    expect(() => majorToMetaBudget(0)).toThrow(); expect(() => majorToMetaBudget(-5)).toThrow()
  })
  it('a synced campaign budget now compiles to a plan the executor guardrail accepts', () => {
    const synced = metaBudgetToMajor('10000') // what generate.ts now passes as SyncedTarget.dailyBudget
    const compiled = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '1200000000000001', target_type: 'campaign', target_daily_budget: 85 },
      { platform: 'meta', campaignId: '1200000000000001', accountId: 'act_7001', status: 'ACTIVE', currency: 'DKK', dailyBudget: synced }, { metaAdAccountId: 'act_7001' })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.plan).toMatchObject({ current_daily_budget: 100, target_daily_budget: 85 })
    // The adapter's live read is also whole units (minor / 100), so the guardrail sees the same scale.
    expect(checkExecutionGuardrails(compiled.plan, { platform: 'meta', accountId: 'act_7001', status: 'ACTIVE', dailyBudget: 10000 / 100, currency: 'DKK' }).ok).toBe(true)
  })
  it('the old raw behaviour is exactly what failed: a raw minor value never matched the live read', () => {
    const raw = Number('10000')
    const compiled = compileExecutionPlan({ action_type: 'set_daily_budget', target_id: '1', target_type: 'campaign', target_daily_budget: 85 },
      { platform: 'meta', campaignId: '1', accountId: 'act_7001', status: 'ACTIVE', currency: 'DKK', dailyBudget: raw }, { metaAdAccountId: 'act_7001' })
    expect(compiled.ok).toBe(false) // 85 vs 10,000 looks like a 99% cut, so the 20% limit refused it
  })
  it('no paid-recs call site passes a raw synced budget to the compiler again', () => {
    const source = readFileSync('lib/marketing/paid-recs/generate.ts', 'utf8')
    expect(source).not.toMatch(/Number\([^)]*daily_budget\)/)
    expect(source.match(/metaBudgetToMajor\(/g)?.length).toBe(3)
    // The ad-set path in diagnose-performance already divides by 100 and stays as it was.
    expect(readFileSync('lib/marketing/paid-recs/diagnose-performance.ts', 'utf8')).toContain('Number(as.daily_budget) / 100')
  })
})

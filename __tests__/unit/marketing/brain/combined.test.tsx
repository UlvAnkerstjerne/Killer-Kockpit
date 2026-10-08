// Marketing Brain v2 + Organic Strategy v1 must coexist: neither layer may regress the other.
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { parse: vi.fn() } } }))
import BrainView from '@/app/(marketing)/marketing/brain/BrainView'
import { INTERPRETATION_SYSTEM_PROMPT, InterpretationSchema } from '@/lib/ai/creative-interpretation'
import { ORGANIC_RULES, ORGANIC_STRATEGY_PROMPT_VERSION } from '@/lib/ai/organic-strategy'
import { INTERPRETATION_PROMPT_VERSION } from '@/lib/marketing/brain/taxonomy'
import type { BrainData } from '@/lib/actions/marketing/creative-intelligence'
import type { CreativeRun } from '@/lib/marketing/brain/types'
import { currentRun, LEGACY_PROMPT_VERSION, savedRun, TWO_REELS_V2_COPY } from '../../../helpers/creative-brain'
import { storedStrategy } from '../../../helpers/organic-strategy'

const base: BrainData = { allowed: true, canRefresh: true, run: null, latestAttempt: null, error: null }
const withOrganic = (run: CreativeRun, organic = storedStrategy()): CreativeRun => ({ ...run, analytics: { ...run.analytics!, organic_strategy: organic } })
const html = (run: CreativeRun) => renderToStaticMarkup(<BrainView data={{ ...base, run }} />)
const text = (markup: string) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"') // React escapes quotes; compare the copy as written

describe('Brain v2 behaviour survives next to Organic Strategy', () => {
  const page = html(withOrganic(currentRun()))

  it('keeps the v2 prompt version, and the two layers version independently', () => {
    expect(INTERPRETATION_PROMPT_VERSION).toBe('2026-10-08-v2')
    expect(ORGANIC_STRATEGY_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/)
    expect(currentRun().prompt_version).toBe(INTERPRETATION_PROMPT_VERSION) // runs record the interpretation version, as before
  })

  it('still shows Brain\'s take, the grouped insight, and "Try next"', () => {
    expect(text(page)).toContain(TWO_REELS_V2_COPY.brain_take)
    expect(text(page)).toContain(TWO_REELS_V2_COPY.headline)
    expect(text(page)).toContain(TWO_REELS_V2_COPY.next_move)
    expect(page).toContain('Try next')
  })

  it('still synthesises two related exceptional Reels into ONE insight (at most 3 allowed)', () => {
    const run = currentRun()
    expect(run.observations).toHaveLength(1)
    expect((run.observations[0] as { signal_ids: string[] }).signal_ids.length).toBeGreaterThanOrEqual(2)
    const insight = (n: number) => ({ signal_ids: [`sig-${n}`], headline: `Insight number ${n} here`, take: TWO_REELS_V2_COPY.take, next_move: TWO_REELS_V2_COPY.next_move })
    const out = (n: number) => ({ brain_take: TWO_REELS_V2_COPY.brain_take, insights: Array.from({ length: n }, (_, i) => insight(i + 1)) })
    expect(InterpretationSchema.safeParse(out(3)).success).toBe(true)
    expect(InterpretationSchema.safeParse(out(4)).success).toBe(false)
  })

  it('still warns about old runs and not about current ones, whether or not Organic Strategy is present', () => {
    const stale = html(withOrganic({ ...currentRun(), prompt_version: LEGACY_PROMPT_VERSION }))
    expect(stale).toContain('Generated with an older Brain version · Refresh recommended')
    expect(stale).toContain('id="organic-strategy-title"')
    expect(page).not.toContain('older Brain version')
    expect(page).not.toContain('Refresh recommended')
  })

  it('renders legacy v1 runs through the compatibility path, with Organic Strategy beside them', () => {
    const legacy = html(withOrganic({ ...savedRun(), prompt_version: LEGACY_PROMPT_VERSION }))
    expect(legacy).toContain('What we learned') // v1 observations
    expect(legacy).toContain('Try next')
    expect(legacy).not.toContain('<section aria-label="Brain&#x27;s take"')
    expect(legacy).toContain('Organic strategy')
    expect(legacy).toContain('Best hooks')
  })

  it('renders a v2 run created before Organic Strategy existed, with a gentle placeholder', () => {
    const before = html(currentRun())
    expect(text(before)).toContain(TWO_REELS_V2_COPY.brain_take)
    expect(before).toContain('No Organic Strategy for this run yet')
    expect(before).not.toContain('role="alert"')
  })

  it('keeps the deterministic evidence sections, which stay authoritative, below both AI layers', () => {
    for (const text of ['Best hooks', 'Best themes', 'Best products', 'Format performance']) expect(page, text).toContain(text)
    expect(page.indexOf('id="organic-strategy-title"')).toBeLessThan(page.indexOf('Best hooks'))
  })

  it('leaves Organic Strategy content out of the v2 interpretation prompt entirely', () => {
    expect(INTERPRETATION_SYSTEM_PROMPT).not.toMatch(/organic strategy|claude-ig|reel concept|carousel concept|KOCKPIT RULES/i)
    expect(ORGANIC_RULES).not.toContain("Brain's take")
  })
})

describe('both AI calls are instrumented separately through the same tracker', () => {
  const interpretation = readFileSync('lib/ai/creative-interpretation.ts', 'utf8')
  const organic = readFileSync('lib/ai/organic-strategy.ts', 'utf8')
  it('each call carries its own stable feature name', () => {
    expect(interpretation).toContain("feature: 'creative_interpretation'")
    expect(organic).toContain("feature: 'organic_strategy'")
    expect(interpretation).not.toContain('organic_strategy')
    expect(organic).not.toContain('creative_interpretation')
  })
  it('both go through the existing usage module, with SDK retries disabled', () => {
    for (const source of [interpretation, organic]) {
      expect(source).toContain("from '@/lib/ai/usage'")
      expect(source).toMatch(/maxRetries: 0/)
      expect(source).toMatch(/trackAiCall(WithRetries)?\(/)
    }
  })
  it('there is no second telemetry path for the organic call', () => {
    expect(organic).not.toMatch(/ai_usage_events|recordAiUsage|createServiceClient/)
  })
})

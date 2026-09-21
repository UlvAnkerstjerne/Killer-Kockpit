/**
 * Unit tests for lib/ai/paid-recommendations.ts
 *
 * Verified guarantees:
 *   1.  buildPaidRecUserMessage — includes all signal fields
 *   2.  buildPaidRecUserMessage — wraps campaign_name in DATA: prefix
 *   3.  buildPaidRecUserMessage — null prior serialises as null in JSON
 *   4.  buildPaidRecUserMessage — uses Copenhagen timezone for date
 *   5.  buildPaidRecUserMessage — includes prior window when provided
 *   6.  callPaidRecommendationsAI — returns failure when BRIEF_AI_MODEL not set
 *   7.  callPaidRecommendationsAI — returns failure when ANTHROPIC_API_KEY not set
 *   8.  SYSTEM_PROMPT — new campaign (prior = null) spend_no_results → medium urgency guidance
 *   9.  SYSTEM_PROMPT — established spend_no_results with prior → high urgency path retained
 *   10. SYSTEM_PROMPT — learning-phase claims explicitly forbidden
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildPaidRecUserMessage, SYSTEM_PROMPT } from '@/lib/ai/paid-recommendations'
import type { PaidRecSignal } from '@/lib/marketing/paid-recs/types'

function makeSignal(overrides: Partial<PaidRecSignal> = {}): PaidRecSignal {
  return {
    platform: 'meta',
    campaign_id: 'campaign_123',
    campaign_name: 'My Test Campaign',
    objective: 'OUTCOME_LEADS',
    signal_type: 'spend_no_results',
    currency: 'DKK',
    result_label: 'Leads',
    current: { spend: 250, result_count: 0, cpr: null },
    prior: null,
    change_pct: null,
    ...overrides,
  }
}

// ─── buildPaidRecUserMessage ──────────────────────────────────────────────────

describe('buildPaidRecUserMessage', () => {
  it('1. includes all signal fields', () => {
    const signal = makeSignal()
    const message = buildPaidRecUserMessage([signal], new Date('2026-09-21T08:00:00Z'))
    const parsed = JSON.parse(message)

    expect(parsed.signals).toHaveLength(1)
    const s = parsed.signals[0]
    expect(s.platform).toBe('meta')
    expect(s.campaign_id).toBe('campaign_123')
    expect(s.signal_type).toBe('spend_no_results')
    expect(s.currency).toBe('DKK')
    expect(s.result_label).toBe('Leads')
    expect(s.current.spend).toBe(250)
    expect(s.current.result_count).toBe(0)
    expect(s.current.cpr).toBeNull()
  })

  it('2. wraps campaign_name in DATA: prefix', () => {
    const signal = makeSignal({ campaign_name: 'My Campaign' })
    const message = buildPaidRecUserMessage([signal], new Date('2026-09-21T08:00:00Z'))
    const parsed = JSON.parse(message)
    expect(parsed.signals[0].campaign_name).toBe('DATA:My Campaign')
  })

  it('3. null prior serialises as null', () => {
    const signal = makeSignal({ prior: null })
    const message = buildPaidRecUserMessage([signal], new Date('2026-09-21T08:00:00Z'))
    const parsed = JSON.parse(message)
    expect(parsed.signals[0].prior).toBeNull()
  })

  it('4. uses Copenhagen timezone for date', () => {
    // UTC 22:30 on Sep 20 = 00:30 CEST Sep 21 in Copenhagen (UTC+2 in summer)
    const msg21 = buildPaidRecUserMessage([], new Date('2026-09-20T22:30:00Z'))
    expect(JSON.parse(msg21).date).toBe('2026-09-21')
    // UTC 21:30 on Sep 20 = 23:30 CEST Sep 20 in Copenhagen
    const msg20 = buildPaidRecUserMessage([], new Date('2026-09-20T21:30:00Z'))
    expect(JSON.parse(msg20).date).toBe('2026-09-20')
  })

  it('5. includes prior window when provided', () => {
    const signal = makeSignal({
      prior: { spend: 200, result_count: 5, cpr: 40 },
      change_pct: 0.30,
    })
    const message = buildPaidRecUserMessage([signal], new Date('2026-09-21T08:00:00Z'))
    const parsed = JSON.parse(message)
    const s = parsed.signals[0]
    expect(s.prior.spend).toBe(200)
    expect(s.prior.result_count).toBe(5)
    expect(s.change_pct).toBe(0.30)
  })
})

// ─── callPaidRecommendationsAI — env var guards ───────────────────────────────

describe('callPaidRecommendationsAI', () => {
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    envBackup = {
      BRIEF_AI_MODEL:    process.env.BRIEF_AI_MODEL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    }
  })

  afterEach(() => {
    process.env.BRIEF_AI_MODEL    = envBackup.BRIEF_AI_MODEL
    process.env.ANTHROPIC_API_KEY = envBackup.ANTHROPIC_API_KEY
  })

  it('5. returns failure when BRIEF_AI_MODEL not set', async () => {
    const { callPaidRecommendationsAI } = await import('@/lib/ai/paid-recommendations')
    delete process.env.BRIEF_AI_MODEL
    delete process.env.ANTHROPIC_API_KEY

    const result = await callPaidRecommendationsAI([])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('not configured')
    }
  })

  it('6. returns failure when ANTHROPIC_API_KEY not set', async () => {
    const { callPaidRecommendationsAI } = await import('@/lib/ai/paid-recommendations')
    process.env.BRIEF_AI_MODEL = 'claude-sonnet-4-6'
    delete process.env.ANTHROPIC_API_KEY

    const result = await callPaidRecommendationsAI([])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('not configured')
    }
  })
})

// ─── SYSTEM_PROMPT spend_no_results calibration ───────────────────────────────

describe('SYSTEM_PROMPT spend_no_results calibration', () => {
  it('8. new campaign (prior = null) → medium urgency guidance present', () => {
    // Must instruct the model to default to medium when there is no prior window
    expect(SYSTEM_PROMPT).toMatch(/prior\s*=\s*null/i)
    expect(SYSTEM_PROMPT).toMatch(/medium/i)
    // Must recommend investigation and monitoring, not an immediate pause
    expect(SYSTEM_PROMPT).toMatch(/investigat/i)
    expect(SYSTEM_PROMPT).toMatch(/monitor/i)
    expect(SYSTEM_PROMPT).toMatch(/do not.*paus/i)
  })

  it('9. established spend_no_results with prior data → high urgency path retained', () => {
    // Must still allow high urgency when prior data confirms the pattern
    expect(SYSTEM_PROMPT).toMatch(/prior data present|prior.*available|prior data/i)
    expect(SYSTEM_PROMPT).toMatch(/high urgency/i)
  })

  it('10. learning-phase claims are explicitly forbidden', () => {
    // Must instruct the model not to assert learning-phase status
    expect(SYSTEM_PROMPT).toMatch(/do not claim.*learning phase|learning.phase.*not.*present|must not be asserted/i)
  })
})

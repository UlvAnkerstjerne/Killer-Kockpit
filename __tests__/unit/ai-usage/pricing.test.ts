import { describe, it, expect } from 'vitest'
import { estimateCostUsd, hasPricing, normalizeModelId, PRICING_VERSION, MODEL_PRICES, type UsageTokens } from '@/lib/ai/pricing'

const zero: UsageTokens = {
  input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0,
}
const SONNET = 'claude-sonnet-4-6'

describe('Sonnet 4.6 list prices', () => {
  it('uses the verified per-million prices', () => {
    expect(MODEL_PRICES[SONNET]).toMatchObject({ input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 })
  })

  it('1M input + 1M output = $18.00', () => {
    const r = estimateCostUsd(SONNET, { ...zero, input_tokens: 1_000_000, output_tokens: 1_000_000 })
    expect(r.cost).toBe(18)
    expect(r.partial).toBe(false)
    expect(r.pricingVersion).toBe(PRICING_VERSION)
  })

  it('prices cache reads independently ($0.30/M)', () => {
    expect(estimateCostUsd(SONNET, { ...zero, cache_read_input_tokens: 1_000_000 }).cost).toBe(0.3)
  })

  it('prices 5-minute cache writes independently ($3.75/M)', () => {
    const u = { ...zero, cache_creation_input_tokens: 1_000_000, cache_creation_5m_tokens: 1_000_000 }
    expect(estimateCostUsd(SONNET, u).cost).toBe(3.75)
  })

  it('prices 1-hour cache writes independently ($6/M)', () => {
    const u = { ...zero, cache_creation_input_tokens: 1_000_000, cache_creation_1h_tokens: 1_000_000 }
    expect(estimateCostUsd(SONNET, u).cost).toBe(6)
  })

  it('does not double count: each bucket is priced once at its own rate', () => {
    const u: UsageTokens = {
      input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000, cache_creation_5m_tokens: 1_000_000, cache_creation_1h_tokens: 1_000_000,
    }
    // 3 + 15 + 0.3 + 3.75 + 6
    expect(estimateCostUsd(SONNET, u).cost).toBe(28.05)
  })

  it('leaves cache writes with unknown TTL unpriced and flags the estimate partial (no TTL guessing)', () => {
    const r = estimateCostUsd(SONNET, { ...zero, input_tokens: 1_000_000, cache_creation_input_tokens: 500_000 })
    expect(r.cost).toBe(3)
    expect(r.partial).toBe(true)
  })

  it('keeps precision for tiny calls (not rounded to cents)', () => {
    expect(estimateCostUsd(SONNET, { ...zero, input_tokens: 1234, output_tokens: 321 }).cost).toBe(0.008517)
  })

  it('applies the 1.1x US-only inference multiplier on Claude 4.6+', () => {
    expect(estimateCostUsd(SONNET, { ...zero, input_tokens: 1_000_000 }, { inferenceGeo: 'us' }).cost).toBe(3.3)
    expect(estimateCostUsd(SONNET, { ...zero, input_tokens: 1_000_000 }, { inferenceGeo: 'global' }).cost).toBe(3)
  })
})

describe('unknown models', () => {
  it('returns null cost and never prices as Sonnet 4.6', () => {
    const r = estimateCostUsd('claude-future-9', { ...zero, input_tokens: 1_000_000, output_tokens: 1_000_000 })
    expect(r.cost).toBeNull()
    expect(hasPricing('claude-future-9')).toBe(false)
    expect(estimateCostUsd(null, { ...zero, input_tokens: 5 }).cost).toBeNull()
  })

  it('resolves dated ids for configured models', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(estimateCostUsd('claude-haiku-4-5-20251001', { ...zero, input_tokens: 1_000_000, output_tokens: 1_000_000 }).cost).toBe(6)
  })
})

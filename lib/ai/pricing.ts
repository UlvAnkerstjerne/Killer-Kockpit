// lib/ai/pricing.ts
//
// Central, versioned Anthropic list-price table and cost calculator.
// Prices are USD per 1,000,000 tokens (standard / global routing, Claude API first-party).
// Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-08).
//
// Rules
//   * Unknown model  → cost is null ("Pricing not configured"). Never fall back to another model.
//   * Cache writes   → priced per TTL when the response gives the 5m / 1h breakdown. If only an
//                      aggregate cache-write count exists the TTL is NOT guessed: that portion is left
//                      unpriced and the estimate is flagged partial.
//   * Output tokens → output_tokens is the billed total; thinking tokens are already inside it.
//   * Cache tokens  → input_tokens, cache_creation and cache_read are disjoint buckets, each priced
//                      once at its own rate.

export const PRICING_VERSION = '2026-10-08'

export type ModelPrice = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  /** Claude 4.6+ : inference_geo "us" costs 1.1x on every category. */
  usGeoMultiplier?: number
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, usGeoMultiplier: 1.1 },
  'claude-opus-4-6':   { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, usGeoMultiplier: 1.1 },
  'claude-haiku-4-5':  { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
}

export type UsageTokens = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cache_creation_5m_tokens: number
  cache_creation_1h_tokens: number
}

export type CostEstimate = {
  /** USD, or null when the model has no configured price. */
  cost: number | null
  /** True when part of the usage could not be priced (cache-write TTL unknown). */
  partial: boolean
  pricingVersion: string
}

/** "claude-haiku-4-5-20251001" → "claude-haiku-4-5". Exact keys win. */
export function normalizeModelId(model: string | null | undefined): string | null {
  if (!model) return null
  if (MODEL_PRICES[model]) return model
  const stripped = model.replace(/-\d{8}$/, '')
  return MODEL_PRICES[stripped] ? stripped : model
}

export function hasPricing(model: string | null | undefined): boolean {
  const key = normalizeModelId(model)
  return !!key && !!MODEL_PRICES[key]
}

export function estimateCostUsd(
  model: string | null | undefined,
  usage: UsageTokens,
  opts: { inferenceGeo?: string | null } = {},
): CostEstimate {
  const key = normalizeModelId(model)
  const price = key ? MODEL_PRICES[key] : undefined
  if (!price) return { cost: null, partial: false, pricingVersion: PRICING_VERSION }

  const known = usage.cache_creation_5m_tokens + usage.cache_creation_1h_tokens
  // Cache-write tokens whose TTL we cannot attribute are left unpriced rather than guessed.
  const unattributed = Math.max(0, usage.cache_creation_input_tokens - known)

  let usd =
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_creation_5m_tokens * price.cacheWrite5m +
      usage.cache_creation_1h_tokens * price.cacheWrite1h +
      usage.cache_read_input_tokens * price.cacheRead) / 1_000_000

  if (opts.inferenceGeo === 'us' && price.usGeoMultiplier) usd *= price.usGeoMultiplier

  return { cost: Math.round(usd * 1e8) / 1e8, partial: unattributed > 0, pricingVersion: PRICING_VERSION }
}

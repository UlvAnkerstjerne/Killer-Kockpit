// lib/ai/usage.ts
//
// AI usage telemetry (observability only).
//
//   trackAiCall()  — wraps ONE actual provider request: times it, reads the real usage object from
//                    the response, records a row, and returns the response unchanged. Failures are
//                    recorded (with a coarse category) and re-thrown unchanged.
//   recordAiUsage() — best-effort insert. A telemetry failure never breaks the AI feature.
//
// Privacy: only token counts, cost, timing and coarse error categories are persisted. Prompts,
// responses, provider error messages and request payloads are never stored.

import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { estimateCostUsd, PRICING_VERSION, type UsageTokens } from '@/lib/ai/pricing'

export const AI_PROVIDER = 'anthropic'

export type AiErrorCategory =
  | 'billing_credit_exhausted'
  | 'rate_limit'
  | 'authentication'
  | 'provider_error'
  | 'validation_error'
  | 'timeout'
  | 'unknown'

export const BILLING_ERROR_USER_MESSAGE =
  "AI credit unavailable. Kockpit's Anthropic API balance needs attention."

// ─── Error classification ────────────────────────────────────────────────────

type ErrLike = {
  status?: unknown
  name?: unknown
  message?: unknown
  type?: unknown
  error?: { type?: unknown; error?: { type?: unknown; message?: unknown }; message?: unknown } | null
}

const CREDIT_MESSAGE = /credit balance (is )?too low|insufficient (credit|funds)|plans?\s*&?\s*billing/i

export function classifyAiError(err: unknown): { category: AiErrorCategory; httpStatus: number | null } {
  const e = (err && typeof err === 'object' ? err : {}) as ErrLike
  const status = typeof e.status === 'number' ? e.status : null
  const bodyType = typeof e.error?.error?.type === 'string' ? e.error.error.type
    : typeof e.error?.type === 'string' ? e.error.type : ''
  const message = [
    typeof e.message === 'string' ? e.message : '',
    typeof e.error?.error?.message === 'string' ? e.error.error.message : '',
    typeof e.error?.message === 'string' ? e.error.message : '',
  ].join(' ')

  // Billing: an explicit billing signal first (402 / billing_error), then the known 400 credit message.
  if (status === 402 || bodyType === 'billing_error') return { category: 'billing_credit_exhausted', httpStatus: status }
  if ((status === 400 || status === null) && CREDIT_MESSAGE.test(message)) {
    return { category: 'billing_credit_exhausted', httpStatus: status }
  }

  if (e.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(String(e.name))) return { category: 'timeout', httpStatus: status }
  if (status === 429 || bodyType === 'rate_limit_error') return { category: 'rate_limit', httpStatus: status }
  if (status === 401 || status === 403 || bodyType === 'authentication_error' || bodyType === 'permission_error') {
    return { category: 'authentication', httpStatus: status }
  }
  if (status !== null && status >= 500) return { category: 'provider_error', httpStatus: status }
  if (bodyType === 'overloaded_error' || bodyType === 'api_error' || e.name === 'APIConnectionError') {
    return { category: 'provider_error', httpStatus: status }
  }
  if (status === 400 || status === 404 || status === 413 || status === 422 || bodyType === 'invalid_request_error') {
    return { category: 'validation_error', httpStatus: status }
  }
  if (e.name === 'ZodError') return { category: 'validation_error', httpStatus: status }
  return { category: 'unknown', httpStatus: status }
}

export function isBillingCreditError(err: unknown): boolean {
  return classifyAiError(err).category === 'billing_credit_exhausted'
}

// ─── Usage extraction ────────────────────────────────────────────────────────

type RawUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
  output_tokens_details?: { thinking_tokens?: number | null } | null
  inference_geo?: string | null
  service_tier?: string | null
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

export type ExtractedUsage = UsageTokens & {
  thinking_tokens: number | null
  inference_geo: string | null
  service_tier: string | null
}

/** Reads the REAL usage object from an Anthropic response. Never estimates from text length. */
export function extractUsage(usage: unknown): ExtractedUsage {
  const u = (usage && typeof usage === 'object' ? usage : {}) as RawUsage
  const w5 = n(u.cache_creation?.ephemeral_5m_input_tokens)
  const w1 = n(u.cache_creation?.ephemeral_1h_input_tokens)
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    cache_creation_5m_tokens: w5,
    cache_creation_1h_tokens: w1,
    thinking_tokens: u.output_tokens_details?.thinking_tokens == null ? null : n(u.output_tokens_details.thinking_tokens),
    inference_geo: typeof u.inference_geo === 'string' ? u.inference_geo : null,
    service_tier: typeof u.service_tier === 'string' ? u.service_tier : null,
  }
}

// ─── Recording ───────────────────────────────────────────────────────────────

export type AiUsageRecord = {
  feature: string
  model: string | null
  status: 'success' | 'error'
  attempt?: number
  usage?: ExtractedUsage | null
  durationMs?: number | null
  errorCategory?: AiErrorCategory | null
  httpStatus?: number | null
  requestId?: string | null
  /** Whitelisted non-content flags only. */
  operation?: 'messages' | 'count_tokens'
}

const INSERT_TIMEOUT_MS = 3000

/** Best-effort. Never throws and never blocks a feature for long. */
export async function recordAiUsage(rec: AiUsageRecord): Promise<void> {
  try {
    const u = rec.usage
    const cost = u && rec.status === 'success' && rec.operation !== 'count_tokens'
      ? estimateCostUsd(rec.model, u, { inferenceGeo: u.inference_geo })
      : { cost: rec.status === 'error' || rec.operation === 'count_tokens' ? 0 : null, partial: false, pricingVersion: PRICING_VERSION }

    const metadata: Record<string, unknown> = {}
    if (cost.partial) metadata.cost_partial = true
    if (u?.inference_geo) metadata.inference_geo = u.inference_geo
    if (u?.service_tier) metadata.service_tier = u.service_tier
    if (rec.operation && rec.operation !== 'messages') metadata.operation = rec.operation

    const row = {
      provider: AI_PROVIDER,
      feature: rec.feature,
      model: rec.model ?? null,
      status: rec.status,
      attempt: rec.attempt ?? 1,
      input_tokens: u?.input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
      cache_creation_5m_tokens: u?.cache_creation_5m_tokens ?? 0,
      cache_creation_1h_tokens: u?.cache_creation_1h_tokens ?? 0,
      thinking_tokens: u?.thinking_tokens ?? null,
      estimated_cost_usd: cost.cost,
      pricing_version: cost.pricingVersion,
      duration_ms: rec.durationMs == null ? null : Math.round(rec.durationMs),
      error_category: rec.errorCategory ?? null,
      http_status: rec.httpStatus ?? null,
      request_id: rec.requestId ?? null,
      metadata: Object.keys(metadata).length ? metadata : null,
    }

    const insert = Promise.resolve(createServiceClient().from('ai_usage_events').insert(row)).then(({ error }) => {
      if (error) console.warn('[ai-usage] telemetry insert failed:', error.code ?? 'unknown')
    })
    await Promise.race([insert, new Promise<void>(resolve => setTimeout(resolve, INSERT_TIMEOUT_MS))])
  } catch (err) {
    console.warn('[ai-usage] telemetry failed:', err instanceof Error ? err.name : 'unknown')
  }
}

// ─── Wrapper ─────────────────────────────────────────────────────────────────

export type TrackMeta = {
  feature: string
  model: string | null | undefined
  /** 1-based attempt number for logical operations that retry. Each attempt is its own row. */
  attempt?: number
  operation?: 'messages' | 'count_tokens'
}

type Responseish = { usage?: unknown; id?: unknown; _request_id?: unknown; model?: unknown }
// count_tokens responses carry none of these, so accept any object.

/**
 * Wrap exactly one provider request. Returns the SDK response unchanged; re-throws SDK errors
 * unchanged (after recording them).
 */
export async function trackAiCall<T extends object>(meta: TrackMeta, call: () => Promise<T>): Promise<T> {
  const started = Date.now()
  let response: T
  try {
    response = await call()
  } catch (err) {
    const { category, httpStatus } = classifyAiError(err)
    const requestId = (err as { requestID?: unknown; request_id?: unknown } | null)?.requestID
      ?? (err as { request_id?: unknown } | null)?.request_id
    await recordAiUsage({
      feature: meta.feature, model: meta.model ?? null, status: 'error', attempt: meta.attempt,
      durationMs: Date.now() - started, errorCategory: category, httpStatus,
      requestId: typeof requestId === 'string' ? requestId : null, operation: meta.operation,
    })
    throw err
  }

  const res = response as Responseish
  const isCount = meta.operation === 'count_tokens'
  await recordAiUsage({
    feature: meta.feature,
    model: (typeof res.model === 'string' ? res.model : null) ?? meta.model ?? null,
    status: 'success', attempt: meta.attempt,
    // count_tokens is a free pre-flight: log the request, but no billable usage.
    usage: isCount ? null : extractUsage(res.usage),
    durationMs: Date.now() - started,
    requestId: typeof res._request_id === 'string' ? res._request_id : typeof res.id === 'string' ? res.id : null,
    operation: meta.operation,
  })
  return response
}

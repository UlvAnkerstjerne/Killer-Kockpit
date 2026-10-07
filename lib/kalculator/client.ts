/**
 * lib/kalculator/client.ts
 *
 * Server-only client for Killer Kalculator's internal store-summary endpoint.
 * Kalculator is the source of truth for Revenue (ex VAT), Salary %, Kombo %
 * and Lemonade units; it decides database / provider / hybrid reads. Kockpit
 * only consumes the normalized summary.
 *
 * Config (server env only, never NEXT_PUBLIC):
 *   KALCULATOR_API_URL     e.g. https://<kalculator host>
 *   KALCULATOR_READ_TOKEN  matches Kalculator's KOCKPIT_READ_TOKEN
 *
 * Every failure (unconfigured, unsupported store, timeout, non-200, invalid
 * shape) yields null metrics — the SMD shows "—", never demo values, never 500.
 */
import 'server-only'
import { z } from 'zod'
import { STORE_PERIODS, kalculatorPeriodRange, type DateRange } from './periods'
import type { PeriodPerformance, StorePerformance } from './types'

export const KALCULATOR_STORE_SLUGS = [
  'indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro',
] as const
export type KalculatorStoreSlug = (typeof KALCULATOR_STORE_SLUGS)[number]

export function isKalculatorStoreSlug(value: unknown): value is KalculatorStoreSlug {
  return typeof value === 'string' && (KALCULATOR_STORE_SLUGS as readonly string[]).includes(value)
}

export type { PeriodPerformance, StorePerformance }

export const UNAVAILABLE_PERFORMANCE: PeriodPerformance = {
  revenueExVat: null, salaryPct: null, komboPct: null, lemonadeUnits: null,
}

export function unavailableStorePerformance(): StorePerformance {
  return Object.fromEntries(STORE_PERIODS.map(p => [p, { ...UNAVAILABLE_PERFORMANCE }])) as StorePerformance
}

const finite = z.number().refine(Number.isFinite)
const SummarySchema = z.object({
  storeId: z.enum(KALCULATOR_STORE_SLUGS),
  start: z.string(),
  end: z.string(),
  complete: z.literal(true),
  source: z.enum(['database', 'provider', 'hybrid']),
  metrics: z.object({
    revenueExVat: finite,
    salaryCost: finite.nullable(),
    salaryPct: finite.nullable(),
    rollUnits: finite,
    komboUnits: finite,
    komboPct: finite.nullable(),
    lemonadeUnits: finite,
  }),
})
export type KalculatorSummary = z.infer<typeof SummarySchema>

export interface KalculatorConfig {
  baseUrl: string
  token: string
}

const MIN_TOKEN_LENGTH = 32
export const KALCULATOR_TIMEOUT_MS = 6_000

export function getKalculatorConfig(env: Record<string, string | undefined> = process.env): KalculatorConfig | null {
  const rawUrl = env.KALCULATOR_API_URL
  const token = env.KALCULATOR_READ_TOKEN
  if (!rawUrl || !token || token.length < MIN_TOKEN_LENGTH) return null
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
  return { baseUrl: url.origin, token }
}

export interface KalculatorDeps {
  config?: KalculatorConfig | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: Date
}

/** One summary request. Returns null on any failure. */
export async function fetchStoreSummary(
  slug: KalculatorStoreSlug,
  range: DateRange,
  deps: KalculatorDeps = {},
): Promise<KalculatorSummary | null> {
  const config = deps.config === undefined ? getKalculatorConfig() : deps.config
  if (!config || !isKalculatorStoreSlug(slug)) return null
  const fetchImpl = deps.fetchImpl ?? fetch
  const path = `/api/internal/store-summary/${slug}/${range.start}/${range.end}`
  try {
    const res = await fetchImpl(config.baseUrl + path, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(deps.timeoutMs ?? KALCULATOR_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[kalculator] summary ${slug} ${range.start}→${range.end} unavailable (HTTP ${res.status})`)
      return null
    }
    const parsed = SummarySchema.safeParse(await res.json())
    if (!parsed.success || parsed.data.storeId !== slug
      || parsed.data.start !== range.start || parsed.data.end !== range.end) {
      console.warn(`[kalculator] summary ${slug} ${range.start}→${range.end} invalid response`)
      return null
    }
    return parsed.data
  } catch (err) {
    const reason = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network error'
    console.warn(`[kalculator] summary ${slug} ${range.start}→${range.end} unavailable (${reason})`)
    return null
  }
}

export function toPeriodPerformance(summary: KalculatorSummary | null): PeriodPerformance {
  if (!summary) return { ...UNAVAILABLE_PERFORMANCE }
  const m = summary.metrics
  return {
    revenueExVat: m.revenueExVat,
    salaryPct: m.salaryPct,
    komboPct: m.komboPct,
    lemonadeUnits: m.lemonadeUnits,
  }
}

/**
 * All SMD periods for one authorised location, fetched in parallel.
 * `slug` comes from the persistent locations.kalculator_store_slug mapping of
 * a location already checked against the user's assignments — never from
 * request input. Unmapped/unsupported → everything unavailable, no request.
 */
export async function loadStorePerformance(
  slug: string | null,
  deps: KalculatorDeps = {},
): Promise<StorePerformance> {
  if (!isKalculatorStoreSlug(slug)) return unavailableStorePerformance()
  const now = deps.now ?? new Date()
  const results = await Promise.all(
    STORE_PERIODS.map(period => fetchStoreSummary(slug, kalculatorPeriodRange(period, now), deps)),
  )
  return Object.fromEntries(
    STORE_PERIODS.map((period, i) => [period, toPeriodPerformance(results[i])]),
  ) as StorePerformance
}

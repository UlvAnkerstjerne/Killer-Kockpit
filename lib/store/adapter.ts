/**
 * lib/store/adapter.ts
 *
 * Typed adapter/interface layer for Store Manager Dashboard data sources that
 * are not yet wired to real backend systems.
 *
 * UNWIRED sources (currently returning demo data):
 *   - Kitchen metrics        — no authoritative source yet (see getKitchenDemoData)
 *   - Stock Take status      — no stock-take table yet
 *   - Meat Use status        — no meat-use table yet
 *
 * WIRED (live data, no longer using demo adapters):
 *   - Google rating/reviews  — fetched from gbp_locations + gbp_reviews in page.tsx
 *   - Revenue (ex VAT), Labour (Salary %), Kombo %, Lemonades sold
 *                            — Killer Kalculator internal store summary,
 *                              lib/kalculator/client.ts
 *
 * All placeholder values are centralised here so components never scatter
 * hardcoded demo data. When a real data source becomes available, replace
 * the relevant function body — no component changes required.
 */

// ─── Kitchen ─────────────────────────────────────────────────────────

export interface KitchenMetrics {
  /** Kitchen labour cost % of revenue */
  kitchenPct: number
  /** vs target, percentage points */
  vsTarget: number | null
}

/** @unwired — returns demo data until kitchen system integration is live */
export function getKitchenDemoData(period: 'today' | 'yesterday' | 'week' | 'month'): KitchenMetrics {
  const demo: Record<'today' | 'yesterday' | 'week' | 'month', KitchenMetrics> = {
    today:     { kitchenPct: 14.2, vsTarget: -0.8 },
    yesterday: { kitchenPct: 13.5, vsTarget: -1.5 },
    week:      { kitchenPct: 15.8, vsTarget:  0.8 },
    month:     { kitchenPct: 14.9, vsTarget: -0.1 },
  }
  return demo[period]
}

// ─── Google Business Profile ──────────────────────────────────────────────────

/** Rating trend direction based on trailing 30-day comparison */
export type RatingTrend = 'up' | 'down' | 'flat' | null

export interface GbpMetrics {
  rating: number | null
  reviewCount: number | null
  /** New reviews in the current calendar week */
  reviewsThisWeek: number | null
  /** Rating trend: recent 30d vs previous 30d (±0.05 threshold) */
  ratingTrend: RatingTrend
  /** Reviews in the previous calendar week (Mon–Sun) */
  reviewsPreviousWeek: number | null
}

/** @deprecated — GBP data is now fetched live in store/page.tsx. Retained for type export only. */
export function getGbpDemoData(): GbpMetrics {
  return { rating: null, reviewCount: null, reviewsThisWeek: null, ratingTrend: null, reviewsPreviousWeek: null }
}

/**
 * Compute rating trend from two averages with ±0.05 dead zone.
 * Exported for testing.
 */
export function computeRatingTrend(recentAvg: number | null, previousAvg: number | null): RatingTrend {
  if (recentAvg == null || previousAvg == null) return null
  // Round to 2 decimal places to avoid floating-point comparison artefacts
  const diff = Math.round((recentAvg - previousAvg) * 100) / 100
  if (diff >= 0.05) return 'up'
  if (diff <= -0.05) return 'down'
  return 'flat'
}

/**
 * Format the reviews-this-week vs previous-week comparison line.
 * Exported for testing.
 */
export function formatWeekComparison(current: number, previous: number | null): string {
  if (previous == null) return ''
  if (current === previous) return '\u2192 Same as last week'
  if (previous === 0) return `\u2191 +${current} vs last week`
  const pctChange = Math.round(Math.abs(current - previous) / previous * 100)
  if (current > previous) return `\u2191 ${pctChange}% vs last week`
  return `\u2193 ${pctChange}% vs last week`
}

// ─── Stock Take ───────────────────────────────────────────────────────────────

export type RoutineStatus = 'done' | 'overdue' | 'pending' | 'unknown'

export interface StockTakeStatus {
  status: RoutineStatus
  /** ISO-8601 datetime of last completion, null if never */
  lastCompletedAt: string | null
  /** Who completed it */
  lastCompletedBy: string | null
}

/** @unwired — returns unknown status until stock-take table is implemented */
export function getStockTakeDemoData(): StockTakeStatus {
  return { status: 'unknown', lastCompletedAt: null, lastCompletedBy: null }
}

// ─── Meat Use ─────────────────────────────────────────────────────────────────

export interface MeatUseStatus {
  status: RoutineStatus
  lastCompletedAt: string | null
  lastCompletedBy: string | null
}

/** @unwired — returns unknown status until meat-use table is implemented */
export function getMeatUseDemoData(): MeatUseStatus {
  return { status: 'unknown', lastCompletedAt: null, lastCompletedBy: null }
}

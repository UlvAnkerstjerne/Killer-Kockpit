/**
 * lib/store/adapter.ts
 *
 * Typed adapter/interface layer for Store Manager Dashboard data sources that
 * are not yet wired to real backend systems.
 *
 * UNWIRED sources (currently returning demo data):
 *   - Revenue metrics        — no Planday/POS revenue table yet
 *   - Labour cost metrics    — no Planday labour-cost integration yet
 *   - Kitchen metrics        — no kitchen system integration yet
 *   - Stock Take status      — no stock-take table yet
 *   - Meat Use status        — no meat-use table yet
 *
 * WIRED (live data, no longer using demo adapters):
 *   - Google rating/reviews  — fetched from gbp_locations + gbp_reviews in page.tsx
 *
 * All placeholder values are centralised here so components never scatter
 * hardcoded demo data. When a real data source becomes available, replace
 * the relevant function body — no component changes required.
 */

// ─── Revenue ──────────────────────────────────────────────────────────────────

export interface RevenueMetrics {
  /** ISO-8601 period identifier, e.g. "2026-09-18", "W38-2026", "Sep 2026" */
  period: string
  /** Revenue in local currency (DKK) */
  revenue: number
  /** Revenue vs prior period, fractional (e.g. 0.05 = +5%) */
  vsLast: number | null
  /** Revenue vs budget, fractional */
  vsBudget: number | null
}

/** @unwired — returns demo data until POS/Planday revenue is integrated */
export function getRevenueDemoData(period: 'today' | 'yesterday' | 'week' | 'month'): RevenueMetrics {
  const demo: Record<'today' | 'yesterday' | 'week' | 'month', RevenueMetrics> = {
    today:     { period: 'Today',     revenue: 18_420,  vsLast: 0.07,  vsBudget: 0.03  },
    yesterday: { period: 'Yesterday', revenue: 22_150,  vsLast: 0.12,  vsBudget: 0.05  },
    week:      { period: 'This week', revenue: 98_600,  vsLast: -0.02, vsBudget: -0.05 },
    month:     { period: 'This month',revenue: 387_000, vsLast: 0.11,  vsBudget: 0.08  },
  }
  return demo[period]
}

// ─── Labour & Kitchen ─────────────────────────────────────────────────────────

export interface LabourMetrics {
  /** Labour cost % of revenue */
  labourPct: number
  /** vs target, percentage points (e.g. -1.2 = 1.2pp under target) */
  vsTarget: number | null
}

export interface KitchenMetrics {
  /** Kitchen labour cost % of revenue */
  kitchenPct: number
  /** vs target, percentage points */
  vsTarget: number | null
}

/** @unwired — returns demo data until Planday labour-cost integration is live */
export function getLabourDemoData(period: 'today' | 'yesterday' | 'week' | 'month'): LabourMetrics {
  const demo: Record<'today' | 'yesterday' | 'week' | 'month', LabourMetrics> = {
    today:     { labourPct: 28.4, vsTarget: -1.6 },
    yesterday: { labourPct: 27.1, vsTarget: -2.9 },
    week:      { labourPct: 31.2, vsTarget:  1.2 },
    month:     { labourPct: 29.8, vsTarget: -0.2 },
  }
  return demo[period]
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

// ─── Sales Mix ───────────────────────────────────────────────────────────────

export interface SalesMixMetrics {
  komboPct: number
  lemonades: number
}

/** @unwired — returns demo data until POS integration is live */
export function getSalesMixDemoData(period: 'today' | 'yesterday' | 'week' | 'month'): SalesMixMetrics {
  const demo: Record<'today' | 'yesterday' | 'week' | 'month', SalesMixMetrics> = {
    today:     { komboPct: 64.2, lemonades: 38 },
    yesterday: { komboPct: 71.5, lemonades: 52 },
    week:      { komboPct: 68.3, lemonades: 284 },
    month:     { komboPct: 66.9, lemonades: 1_120 },
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

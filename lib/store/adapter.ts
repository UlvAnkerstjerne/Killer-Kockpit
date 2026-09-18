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
 *   - Google rating/reviews  — GBP API scope pending OAuth re-grant
 *   - Stock Take status      — no stock-take table yet
 *   - Meat Use status        — no meat-use table yet
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
export function getRevenueDemoData(period: 'today' | 'week' | 'month'): RevenueMetrics {
  const demo: Record<'today' | 'week' | 'month', RevenueMetrics> = {
    today: { period: 'Today',     revenue: 18_420, vsLast: 0.07,  vsBudget: 0.03  },
    week:  { period: 'This week', revenue: 98_600, vsLast: -0.02, vsBudget: -0.05 },
    month: { period: 'This month',revenue: 387_000,vsLast: 0.11,  vsBudget: 0.08  },
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
export function getLabourDemoData(period: 'today' | 'week' | 'month'): LabourMetrics {
  const demo: Record<'today' | 'week' | 'month', LabourMetrics> = {
    today: { labourPct: 28.4, vsTarget: -1.6 },
    week:  { labourPct: 31.2, vsTarget:  1.2 },
    month: { labourPct: 29.8, vsTarget: -0.2 },
  }
  return demo[period]
}

/** @unwired — returns demo data until kitchen system integration is live */
export function getKitchenDemoData(period: 'today' | 'week' | 'month'): KitchenMetrics {
  const demo: Record<'today' | 'week' | 'month', KitchenMetrics> = {
    today: { kitchenPct: 14.2, vsTarget: -0.8 },
    week:  { kitchenPct: 15.8, vsTarget:  0.8 },
    month: { kitchenPct: 14.9, vsTarget: -0.1 },
  }
  return demo[period]
}

// ─── Google Business Profile ──────────────────────────────────────────────────

export interface GbpMetrics {
  rating: number | null
  reviewCount: number | null
  /** Change in reviews since last 30 days */
  newReviews30d: number | null
}

/** @unwired — returns demo data until GBP adwords scope is granted and synced */
export function getGbpDemoData(): GbpMetrics {
  return { rating: 4.3, reviewCount: 412, newReviews30d: 7 }
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

/**
 * lib/kalculator/types.ts — client-safe types and display formatting for
 * Killer Kalculator KPIs on the Store Manager Dashboard.
 *
 * null always means "unavailable" and renders as "—". 0 is a genuine zero
 * (0 lemonades; 0% Kombo when rolls were sold but no kombos).
 */
import type { StorePeriod } from './periods'

export interface PeriodPerformance {
  revenueExVat: number | null
  salaryPct: number | null
  komboPct: number | null
  lemonadeUnits: number | null
}
export type StorePerformance = Record<StorePeriod, PeriodPerformance>

export const UNAVAILABLE = '—'

/** Compact DKK, matching the SMD's existing revenue style (18K, 1.2M). */
export function formatRevenueCompact(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return UNAVAILABLE
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return `${Math.round(n)}`
}

export function formatPercent1(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return UNAVAILABLE
  return `${n.toFixed(1)}%`
}

export function formatUnits(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return UNAVAILABLE
  return `${Math.round(n)}`
}

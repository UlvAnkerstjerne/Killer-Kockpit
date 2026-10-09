/**
 * Meta returns and accepts budgets in the currency's MINOR unit (øre for DKK): an ad set with
 * daily_budget "8000" spends 80 DKK a day. Kockpit stores them exactly as Meta returns them.
 *
 * Everything that reasons about budgets (guardrails, the 20% limit, trusted execution plans, the
 * executor adapter's read-back) works in WHOLE currency units. This module is the one place that
 * converts, so a raw synced value can never be compared with a live one by accident.
 */

export const MINOR_UNITS_PER_CURRENCY_UNIT = 100

/** Synced/raw Meta budget (minor units, possibly a decimal string) -> whole units; null when absent or not positive. */
export function metaBudgetToMajor(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw) / MINOR_UNITS_PER_CURRENCY_UNIT
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** Whole units -> the integer minor-unit amount Meta expects on writes. */
export function majorToMetaBudget(major: number): number {
  const minor = Math.round(major * MINOR_UNITS_PER_CURRENCY_UNIT)
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new RangeError('Invalid budget amount')
  return minor
}

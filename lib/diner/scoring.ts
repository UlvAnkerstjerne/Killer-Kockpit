/**
 * lib/diner/scoring.ts
 *
 * Pure scoring functions for Mystery Diner results.
 * Mirrors the logic in submit_diner_submission() SECURITY DEFINER RPC.
 * Safe to import in both server and client components.
 */

export type DinerStatus = 'GREEN' | 'YELLOW' | 'RED'

export const DINER_STATUS_LABEL: Record<DinerStatus, string> = {
  GREEN:  'Green',
  YELLOW: 'Yellow',
  RED:    'Red',
}

/** Tailwind badge classes per status — matches Kockpit badge pattern. */
export const DINER_STATUS_CLS: Record<DinerStatus, string> = {
  GREEN:  'bg-kk-good-bg text-kk-good border-kk-good',
  YELLOW: 'bg-kk-warn-bg text-kk-warn border-kk-warn',
  RED:    'bg-kk-bad-bg text-kk-bad border-kk-bad',
}

/**
 * Compute the final Mystery Diner status from stored score values.
 *
 * Thresholds:
 *   86–100% → GREEN
 *   67–85%  → YELLOW
 *   <67%    → RED
 *
 * Critical cap: if critical_fail_count > 0 and base status is GREEN,
 * final status is capped at YELLOW. Critical failures never force RED.
 *
 * Returns null when score_pct is null (no scoreable checkpoints answered).
 */
export function computeDinerStatus(
  score_pct: number | null,
  critical_fail_count: number,
): DinerStatus | null {
  if (score_pct === null) return null

  let base: DinerStatus
  if (score_pct >= 86)      base = 'GREEN'
  else if (score_pct >= 67) base = 'YELLOW'
  else                       base = 'RED'

  if (critical_fail_count > 0 && base === 'GREEN') return 'YELLOW'
  return base
}

/** Tailwind text-color class for a score percentage value. */
export function dinerScoreColor(v: number | null): string {
  if (v === null) return 'text-kk-muted'
  if (v >= 86) return 'text-kk-good'
  if (v >= 67) return 'text-kk-warn'
  return 'text-kk-bad'
}

/**
 * lib/time.ts
 *
 * Timezone-aware date/time utilities for Killer Kockpit.
 *
 * All Kockpit meeting times are scheduled in Europe/Copenhagen (CET/CEST).
 * The DB stores UTC (timestamptz).  All UI boundary conversions go through here.
 *
 * Conversion semantics
 * ─────────────────────
 * wallToUtc("2026-08-31T12:00")  → "2026-08-31T10:00:00.000Z"   (CEST, UTC+2)
 * wallToUtc("2026-12-01T12:00")  → "2026-12-01T11:00:00.000Z"   (CET,  UTC+1)
 *
 * utcToWall("2026-08-31T10:00:00Z") → "2026-08-31T12:00"         (CEST)
 * utcToWall("2026-12-01T11:00:00Z") → "2026-12-01T12:00"         (CET)
 *
 * DST-safe: uses Intl.DateTimeFormat rather than manual offset arithmetic.
 * No third-party dependencies.  Works in Node.js and modern browsers.
 */

/** Institutional scheduling timezone. Use this constant — never a raw string. */
export const SCHEDULING_TZ = 'Europe/Copenhagen'

// ─── Internal: Copenhagen UTC offset ─────────────────────────────────────

/**
 * Returns the Europe/Copenhagen UTC offset in milliseconds for a given UTC Date.
 * Positive means Copenhagen is ahead of UTC (always true for this timezone).
 *
 * At 2026-08-31T10:00:00Z (CEST): returns +7_200_000 (= +2 h)
 * At 2026-12-01T11:00:00Z (CET):  returns +3_600_000 (= +1 h)
 */
function copenhagentOffsetMs(utcDate: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULING_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate)

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const localAsUtcMs = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  )
  return localAsUtcMs - utcDate.getTime()
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Convert a Copenhagen wall-clock string ("YYYY-MM-DDTHH:MM") to a UTC ISO
 * string suitable for storing in the database.  DST-safe.
 *
 * wallToUtc("2026-08-31T12:00") → "2026-08-31T10:00:00.000Z"  (CEST, UTC+2)
 * wallToUtc("2026-12-01T12:00") → "2026-12-01T11:00:00.000Z"  (CET,  UTC+1)
 */
export function wallToUtc(wall: string): string {
  const [datePart, timePart] = wall.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const [h, min] = timePart.split(':').map(Number)

  // Treat wall time as if it were UTC to get an approximate reference Date.
  const approx = new Date(Date.UTC(y, m - 1, d, h, min, 0))

  // First-pass offset at the approximate Date.
  const offset = copenhagentOffsetMs(approx)

  // First-pass true UTC estimate (approx - offset).
  const guess = new Date(approx.getTime() - offset)

  // Recompute offset at the first-pass UTC to handle DST boundary exactly.
  const offsetAtGuess = copenhagentOffsetMs(guess)

  return new Date(approx.getTime() - offsetAtGuess).toISOString()
}

/**
 * Convert a UTC ISO string (as returned by Supabase) to a Copenhagen wall-clock
 * string for populating a datetime-local input ("YYYY-MM-DDTHH:MM").
 *
 * utcToWall("2026-08-31T10:00:00Z") → "2026-08-31T12:00"  (CEST)
 * utcToWall("2026-12-01T11:00:00Z") → "2026-12-01T12:00"  (CET)
 * utcToWall(null)                   → ""
 */
export function utcToWall(utcIso: string | null): string {
  if (!utcIso) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULING_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcIso))

  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/**
 * Format a UTC ISO string for display as Europe/Copenhagen local time.
 * Returns null for null/undefined input.
 *
 * Accepts standard Intl.DateTimeFormatOptions (timeZone is always SCHEDULING_TZ).
 */
export function formatCopenhagen(
  utcIso: string | null | undefined,
  opts: Omit<Intl.DateTimeFormatOptions, 'timeZone'>,
): string | null {
  if (!utcIso) return null
  return new Date(utcIso).toLocaleString('en-GB', { timeZone: SCHEDULING_TZ, ...opts })
}

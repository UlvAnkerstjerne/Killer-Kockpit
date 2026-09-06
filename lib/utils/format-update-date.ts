/**
 * Returns a compact display string for a Universal Update's effective date.
 *
 * occurred_on present → format the calendar date directly (records when the
 * event happened, not when the Update was written).
 *
 * occurred_on null → prefix with "Added" to make clear this is the system
 * creation timestamp, not an event date.  Honest about what we know.
 *
 * occurred_on is stored as YYYY-MM-DD (PostgreSQL date).  We parse it with
 * explicit year/month/day to avoid the UTC-midnight timezone shift that
 * new Date('YYYY-MM-DD') would introduce when the browser is in a timezone
 * behind UTC.
 */
export function formatUpdateDate(
  occurred_on: string | null,
  created_at: string,
): string {
  if (occurred_on) {
    const [y, m, d] = occurred_on.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return (
    'Added ' +
    new Date(created_at).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    })
  )
}

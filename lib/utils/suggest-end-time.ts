/**
 * Given a datetime-local string (YYYY-MM-DDTHH:mm), returns a string for a
 * time 30 minutes later on the same date.
 *
 * Returns '' when:
 *   - the input is empty or malformed
 *   - the start time is 23:30 or later (adding 30 min would cross midnight)
 */
export function suggestEndTime(start: string): string {
  if (!start) return ''
  const tIdx = start.indexOf('T')
  if (tIdx === -1) return ''
  const datePart = start.slice(0, tIdx)
  const timePart = start.slice(tIdx + 1)
  const colonIdx = timePart.indexOf(':')
  if (colonIdx === -1) return ''
  const h = parseInt(timePart.slice(0, colonIdx), 10)
  const m = parseInt(timePart.slice(colonIdx + 1, colonIdx + 3), 10)
  if (isNaN(h) || isNaN(m)) return ''
  const totalMinutes = h * 60 + m + 30
  if (totalMinutes >= 24 * 60) return ''
  const endH = Math.floor(totalMinutes / 60)
  const endM = totalMinutes % 60
  return `${datePart}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
}

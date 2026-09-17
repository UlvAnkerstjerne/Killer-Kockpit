const TIME_ZONE = 'Europe/Copenhagen'

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function copenhagenOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  const representedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return representedAsUtc - instant.getTime()
}

function copenhagenMidnight(date: string): string {
  const approximate = new Date(`${date}T00:00:00Z`)
  const first = new Date(approximate.getTime() - copenhagenOffsetMs(approximate))
  const corrected = new Date(approximate.getTime() - copenhagenOffsetMs(first))
  return corrected.toISOString()
}

export function mondayForDate(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return addDays(date, -(day === 0 ? 6 : day - 1))
}

export function currentCopenhagenDate(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(now)
}

export function buildWeekWindow(selectedDate: string) {
  const startDate = mondayForDate(selectedDate)
  const endDate = addDays(startDate, 6)
  const endExclusiveDate = addDays(startDate, 7)
  const formatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const startLabel = formatter.format(new Date(`${startDate}T12:00:00Z`))
  const endLabel = formatter.format(new Date(`${endDate}T12:00:00Z`))

  return {
    startDate,
    endDate,
    startIso: copenhagenMidnight(startDate),
    endExclusiveIso: copenhagenMidnight(endExclusiveDate),
    displayRange: `${startLabel} – ${endLabel}`,
  }
}

export function isCopenhagenFridayAfternoon(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  return parts.find(p => p.type === 'weekday')?.value === 'Fri'
    && Number(parts.find(p => p.type === 'hour')?.value) === 16
}

import type { GbpDailyMetricTimeSeries, GbpLocation, GbpSearchKeyword } from '@/lib/google/gbp-client'
import { GBP_DAILY_METRICS, GBP_METRIC_DEFINITIONS } from './metrics'

export class GbpDataError extends Error {}
export type DateRange = { start: string; end: string }
const iso = (date: Date) => date.toISOString().slice(0, 10)
export function addDays(day: string, count: number): string { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return iso(d) }
export function monthOffset(month: string, count: number): string { const d = new Date(`${month.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + count); return iso(d) }
export function gbpDateRange(now: Date, backfill: boolean): DateRange {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const end = addDays(today, -1)
  const oldestMonth = monthOffset(today, -18)
  const daysInMonth = Number(addDays(monthOffset(oldestMonth, 1), -1).slice(8))
  const oldestDay = Math.min(Number(today.slice(8)), daysInMonth)
  return { start: backfill ? `${oldestMonth.slice(0, 7)}-${String(oldestDay).padStart(2, '0')}` : addDays(end, -13), end }
}
export function gbpKeywordMonths(now: Date, backfill: boolean): string[] {
  const end = gbpDateRange(now, false).end
  const today = addDays(end, 1)
  return Array.from({ length: backfill ? 18 : 2 }, (_, i) => monthOffset(today, i - (backfill ? 18 : 2)))
}
export function dateChunks(range: DateRange): DateRange[] {
  const chunks: DateRange[] = []
  for (let start = range.start; start <= range.end; start = addDays(chunks[chunks.length - 1].end, 1)) {
    const end = addDays(start, 30)
    chunks.push({ start, end: end < range.end ? end : range.end })
  }
  return chunks
}
export function googleId(resource: string, kind: 'accounts' | 'locations'): string {
  const id = resource.match(new RegExp(`^${kind}/(\\d+)$`))?.[1]
  if (!id) throw new GbpDataError(`Google returned an invalid ${kind} resource name.`)
  return id
}
export function profileSnapshot(profile: GbpLocation, syncedAt: string) {
  googleId(profile.name, 'locations')
  if (!profile.title) throw new GbpDataError('Google returned a profile without a title.')
  return { resource_name: profile.name, profile_title: profile.title, store_code: profile.storeCode ?? null,
    primary_category: profile.categories?.primaryCategory ?? null, additional_categories: profile.categories?.additionalCategories ?? null,
    website_uri: profile.websiteUri ?? null, phone_numbers: profile.phoneNumbers ?? null,
    storefront_address: profile.storefrontAddress ?? null, regular_hours: profile.regularHours ?? null,
    special_hours: profile.specialHours ?? null, more_hours: profile.moreHours ?? null,
    open_info: profile.openInfo ?? null, profile_metadata: profile.metadata ?? null,
    profile_description: profile.profile ?? null, service_area: profile.serviceArea ?? null,
    latlng: profile.latlng ?? null, profile_snapshot: profile, profile_synced_at: syncedAt }
}
function count(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) > BigInt('9223372036854775807')) throw new GbpDataError('Google returned an invalid non-negative metric count.')
  return BigInt(value).toString()
}
/** An omitted value on an actual DatedValue means zero (Google's proto contract).
 * An absent metric or absent dated point means unavailable, never an invented zero. */
export function dailyPerformanceRows(locationId: string, series: GbpDailyMetricTimeSeries[], range: DateRange, syncedAt: string) {
  if (!series.length) throw new GbpDataError('Google returned no daily metric series.')
  const byDate = new Map<string, Record<string, string | null>>()
  const breakdowns = new Map<string, object[]>()
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) byDate.set(day, Object.fromEntries(GBP_DAILY_METRICS.map(metric => [metric, null])))
  for (const item of series) {
    if (!item.dailyMetric || !item.timeSeries) throw new GbpDataError('Google returned an invalid metric series.')
    for (const point of item.timeSeries.datedValues ?? []) {
      const { year, month, day } = point.date ?? {}
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (!year || !month || !day || !Number.isFinite(Date.parse(date)) || iso(new Date(date)) !== date) throw new GbpDataError('Google returned an invalid metric date.')
      if (!byDate.has(date)) throw new GbpDataError('Google returned daily metrics outside the requested range.')
      const value = point.value === undefined ? '0' : count(point.value)
      if (item.dailySubEntityType && Object.keys(item.dailySubEntityType).length) {
        const entries = breakdowns.get(date) ?? []
        entries.push({ dailyMetric: item.dailyMetric, dailySubEntityType: item.dailySubEntityType, value })
        breakdowns.set(date, entries)
      } else {
        const existing = byDate.get(date)![item.dailyMetric]
        if (existing != null && existing !== value) throw new GbpDataError('Google returned conflicting daily metric values.')
        byDate.get(date)![item.dailyMetric] = value
      }
    }
  }
  return [...byDate].map(([date, metric_values]) => {
    const legacy: Record<string, string | null> = {}
    for (const metric of GBP_DAILY_METRICS) {
      const column = GBP_METRIC_DEFINITIONS[metric].column
      if (column) legacy[column] = metric_values[metric]
    }
    const impressions = GBP_DAILY_METRICS.filter(key => key.startsWith('BUSINESS_IMPRESSIONS_')).map(key => metric_values[key])
    return { location_id: locationId, date, ...legacy, metric_values, metric_breakdowns: breakdowns.get(date) ?? [],
      total_impressions: impressions.every(v => v !== null) ? impressions.reduce((n, v) => n + BigInt(v!), BigInt(0)).toString() : null, synced_at: syncedAt }
  })
}
export function keywordRows(keywords: GbpSearchKeyword[]) {
  const seen = new Set<string>()
  return keywords.map(row => {
    if (!row.searchKeyword || seen.has(row.searchKeyword)) throw new GbpDataError('Google returned an invalid or duplicate monthly keyword.')
    seen.add(row.searchKeyword)
    const value = row.insightsValue
    if (value?.value !== undefined && value.threshold !== undefined) throw new GbpDataError('Google returned both an exact count and threshold for a keyword.')
    return { keyword: row.searchKeyword, impressions: value?.value === undefined ? null : count(value.value),
      impressions_threshold: value?.threshold === undefined ? null : count(value.threshold) }
  })
}

export type StoredGbpLocation = { id: string; google_account_id: string; google_location_id: string; location_id: string | null; store_name: string; store_short_name: string; activation_date: string; active: boolean }
/** Persistent identifiers only. No title/address heuristic can attach a store. */
export function mappingIssues(locations: StoredGbpLocation[]) {
  const ambiguous = new Set<string>()
  for (const location of locations) {
    if (locations.some(other => other.id !== location.id && (other.google_location_id === location.google_location_id || (location.location_id && other.location_id === location.location_id && other.active && location.active)))) ambiguous.add(location.id)
  }
  return ambiguous
}

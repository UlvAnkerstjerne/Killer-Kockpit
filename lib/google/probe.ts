/**
 * lib/google/probe.ts
 *
 * Minimal connectivity probes for Search Console and GA4.
 *
 * Temporary — for proving live OAuth connectivity only.
 * Remove / refactor once connectivity is confirmed and real sync is built.
 *
 * Security contract:
 *   • Tokens are never logged, returned, or exposed.
 *   • Only aggregated, non-PII metrics are returned.
 *   • Errors contain API error messages but never token values.
 */

import { google } from 'googleapis'
import { getGoogleOAuth2Client } from './auth'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SearchConsoleProbeResult =
  | {
      ok: true
      property: string
      dateRange: { start: string; end: string }
      rows: Array<{
        query:       string
        clicks:      number
        impressions: number
        ctr:         number
        position:    number
      }>
    }
  | { ok: false; error: string }

export type GA4ProbeResult =
  | {
      ok: true
      propertyId: string
      dateRange: { start: string; end: string }
      totals: Record<string, number>
    }
  | { ok: false; error: string }

// ── Search Console ─────────────────────────────────────────────────────────────

export type SearchConsoleSite = { siteUrl: string; permissionLevel: string }

/**
 * Lists all Search Console properties accessible to the OAuth token.
 * Useful for diagnosing property-URL mismatches (sc-domain: vs https://).
 */
export async function listSearchConsoleSites(
  userId: string,
): Promise<{ ok: true; sites: SearchConsoleSite[] } | { ok: false; error: string }> {
  const client = await getGoogleOAuth2Client(userId)
  if (!client) return { ok: false, error: 'No Google OAuth token stored for this user.' }

  try {
    const wm = google.webmasters({ version: 'v3', auth: client })
    const { data } = await wm.sites.list()
    const sites = (data.siteEntry ?? []).map(s => ({
      siteUrl:         s.siteUrl         ?? '',
      permissionLevel: s.permissionLevel ?? '',
    }))
    return { ok: true, sites }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}

/**
 * Queries Search Console for a small sample of top queries on the given
 * property over the past ~90 days (respecting the 2-3 day data lag).
 */
export async function probeSearchConsole(
  userId:   string,
  siteUrl:  string,
): Promise<SearchConsoleProbeResult> {
  const client = await getGoogleOAuth2Client(userId)
  if (!client) return { ok: false, error: 'No Google OAuth token stored for this user.' }

  // Expanded to 90-day window to catch historical data
  const endDate   = offsetDate(new Date(), -3)
  const startDate = offsetDate(new Date(), -93)

  try {
    const wm = google.webmasters({ version: 'v3', auth: client })

    // Try query dimension first
    const { data } = await wm.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit:   5,
      },
    })

    const rows = (data.rows ?? []).map(r => ({
      query:       (r.keys ?? [])[0] ?? '',
      clicks:      r.clicks      ?? 0,
      impressions: r.impressions ?? 0,
      ctr:         r.ctr         ?? 0,
      position:    r.position    ?? 0,
    }))

    // If query dimension returns nothing, try page dimension as fallback
    if (rows.length === 0) {
      const { data: pageData } = await wm.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate,
          endDate,
          dimensions: ['page'],
          rowLimit:   5,
        },
      })

      const pageRows = (pageData.rows ?? []).map(r => ({
        query:       (r.keys ?? [])[0] ?? '',
        clicks:      r.clicks      ?? 0,
        impressions: r.impressions ?? 0,
        ctr:         r.ctr         ?? 0,
        position:    r.position    ?? 0,
      }))

      return {
        ok:        true,
        property:  siteUrl,
        dateRange: { start: startDate, end: endDate },
        rows:      pageRows,
        // @ts-ignore — extra diagnostic field
        dimension: pageRows.length > 0 ? 'page (query dimension returned empty)' : 'none — no data for property in 90-day window',
      }
    }

    return { ok: true, property: siteUrl, dateRange: { start: startDate, end: endDate }, rows }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}

// ── GA4 ───────────────────────────────────────────────────────────────────────

/**
 * Queries the GA4 Analytics Data API for sessions + users over the past
 * ~14 days (same lag headroom as the Search Console probe).
 */
export async function probeGA4(
  userId:     string,
  propertyId: string,
): Promise<GA4ProbeResult> {
  const client = await getGoogleOAuth2Client(userId)
  if (!client) return { ok: false, error: 'No Google OAuth token stored for this user.' }

  const endDate   = offsetDate(new Date(), -1)
  const startDate = offsetDate(new Date(), -15)

  try {
    const ad = google.analyticsdata({ version: 'v1beta', auth: client })
    const { data } = await ad.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions'    },
          { name: 'totalUsers'  },
          { name: 'newUsers'    },
          { name: 'screenPageViews' },
        ],
      },
    })

    // No dimension → single totals row
    const totals: Record<string, number> = {}
    const headers = data.metricHeaders ?? []
    const row     = data.rows?.[0]
    headers.forEach((h, i) => {
      totals[h.name ?? `metric_${i}`] = Number(row?.metricValues?.[i]?.value ?? 0)
    })

    return { ok: true, propertyId, dateRange: { start: startDate, end: endDate }, totals }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Returns 'YYYY-MM-DD' for today + offsetDays (negative = past). */
function offsetDate(base: Date, offsetDays: number): string {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().split('T')[0]
}

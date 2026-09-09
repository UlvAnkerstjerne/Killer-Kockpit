import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { getSSPCphData } from '@/lib/kkc/ssp-cph'
import type { KKCSspCphData } from '@/lib/kkc/ssp-cph'
import SSPDashboard from './SSPDashboard'

/**
 * Maps a raw Google API error to a stable error key.
 *
 * Distinguishes:
 *   sheets_api_disabled  — Sheets API not enabled in the GCP project (403 + accessNotConfigured)
 *   sheets_access_denied — authenticated but no access to this specific spreadsheet (403)
 *   sheets_not_found     — spreadsheet ID is wrong or file was deleted (404)
 *   fetch_failed         — any other failure
 */
function classifyGoogleSheetsError(err: unknown): string {
  const e = err as {
    response?: { status?: number; data?: unknown }
    status?:   number
    code?:     string | number
  }
  const googleError = (e.response?.data as Record<string, unknown> | undefined)?.['error'] as Record<string, unknown> | undefined
  const errors      = googleError?.['errors'] as Array<Record<string, unknown>> | undefined
  const reason      = errors?.[0]?.['reason'] as string | undefined

  if (reason === 'accessNotConfigured') return 'sheets_api_disabled'

  const httpStatus =
    e.response?.status ??
    (typeof e.status === 'number' ? e.status : undefined) ??
    (typeof e.code   === 'number' ? e.code   : undefined)

  if (httpStatus === 403) return 'sheets_access_denied'
  if (httpStatus === 404) return 'sheets_not_found'
  return 'fetch_failed'
}

export const dynamic = 'force-dynamic'

export default async function SSPCphPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessQualityCheck(user.role)) redirect('/today')

  // System credential model: no per-user Google check needed.
  // getSSPCphData() internally finds the first token with spreadsheets.readonly
  // (same pattern as GBP sync). UM users never need personal Sheets access.
  let data: KKCSspCphData | null = null
  let error: string | null = null

  try {
    data = await getSSPCphData()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === 'no_sheets_credential') {
      error = 'sheets_not_configured'
    } else {
      error = classifyGoogleSheetsError(err)
      console.error('[kkc/ssp-cph] Page data fetch error:', err)
    }
  }

  return (
    <SSPDashboard
      initialData={data}
      fetchedAt={data?.fetchedAt ?? null}
      error={error}
      userRole={user.role}
    />
  )
}

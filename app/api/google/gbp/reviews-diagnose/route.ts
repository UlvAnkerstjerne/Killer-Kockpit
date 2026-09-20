import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, hasGbpScope } from '@/lib/google/auth'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }

type ProbeResult = {
  ok: boolean
  httpStatus: number
  googleStatus?: string | null
  reason?: string | null
  service?: string | null
  consumer?: string | null
  activationUrl?: string | null
  accountCount?: number | null
}

function safeErrorDetails(body: unknown): Omit<ProbeResult, 'ok' | 'httpStatus'> {
  if (!body || typeof body !== 'object') return {}
  const root = body as { error?: { status?: unknown; details?: unknown } }
  const status = typeof root.error?.status === 'string' ? root.error.status : null
  const details = Array.isArray(root.error?.details) ? root.error?.details : []
  let reason: string | null = null
  let service: string | null = null
  let consumer: string | null = null
  let activationUrl: string | null = null

  for (const item of details as Array<Record<string, unknown>>) {
    if (typeof item?.reason === 'string') reason = item.reason
    const metadata = item?.metadata
    if (metadata && typeof metadata === 'object') {
      const m = metadata as Record<string, unknown>
      if (typeof m.service === 'string') service = m.service
      if (typeof m.consumer === 'string') consumer = m.consumer
      if (typeof m.activationUrl === 'string') activationUrl = m.activationUrl
    }
  }

  return { googleStatus: status, reason, service, consumer, activationUrl }
}

async function probe(url: string, token: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    let body: unknown = null
    try { body = await response.json() } catch { /* no body */ }

    if (!response.ok) {
      return { ok: false, httpStatus: response.status, ...safeErrorDetails(body) }
    }

    let accountCount: number | null = null
    if (body && typeof body === 'object' && Array.isArray((body as { accounts?: unknown }).accounts)) {
      accountCount = ((body as { accounts: unknown[] }).accounts).length
    }

    return { ok: true, httpStatus: response.status, accountCount }
  } catch {
    return { ok: false, httpStatus: 0, reason: 'NETWORK_OR_TIMEOUT' }
  }
}

async function runDiagnostic() {
  const db = createServiceClient()

  const { data: tokenRows, error: tokenError } = await db
    .from('google_oauth_tokens')
    .select('user_id,scopes')
    .order('user_id')
  if (tokenError) return { error: 'Could not read Google connection metadata.' }

  const gbpUserIds = (tokenRows ?? [])
    .filter((row: { scopes: string[] }) => hasGbpScope(row.scopes ?? []))
    .map((row: { user_id: string }) => row.user_id)
  if (!gbpUserIds.length) return { error: 'No GBP-authorised credential found.' }

  const { data: admins } = await db
    .from('app_users')
    .select('id,email')
    .in('id', gbpUserIds)
    .eq('role', 'SUPER_ADMIN')
    .eq('active', true)
    .order('id')
  const owner = admins?.[0] as { id: string; email: string } | undefined
  if (!owner) return { error: 'No active SUPER_ADMIN owns the GBP credential.' }

  const { data: location } = await db
    .from('gbp_locations')
    .select('google_account_id,google_location_id,store_name')
    .eq('active', true)
    .not('location_id', 'is', null)
    .order('store_name')
    .limit(1)
    .maybeSingle()

  if (!location) return { error: 'No active mapped GBP location found.' }

  const client = await getGoogleOAuth2Client(owner.id)
  if (!client) return { error: 'GBP OAuth client unavailable.' }

  let token: string | null | undefined
  try { token = (await client.getAccessToken()).token } catch { token = null }
  if (!token) return { error: 'No valid Google access token available.' }

  const accountId = location.google_account_id as string
  const locationId = location.google_location_id as string
  const base = 'https://mybusiness.googleapis.com/v4'

  const [accountsProbe, locationProbe, reviewsProbe] = await Promise.all([
    probe(`${base}/accounts`, token),
    probe(`${base}/accounts/${accountId}/locations/${locationId}`, token),
    probe(`${base}/accounts/${accountId}/locations/${locationId}/reviews?pageSize=1`, token),
  ])

  return {
    credentialUser: owner.email,
    sampleLocation: location.store_name,
    accountId,
    locationId,
    probes: {
      legacyV4Accounts: accountsProbe,
      legacyV4Location: locationProbe,
      legacyV4Reviews: reviewsProbe,
    },
  }
}

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const diagSecret = process.env.GBP_DIAG_SECRET
  if (!cronSecret && !diagSecret) return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500, headers })
  const auth = request.headers.get('authorization')
  const authorised =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (diagSecret && auth === `Bearer ${diagSecret}`)
  if (!authorised) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401, headers })
  }
  return NextResponse.json(await runDiagnostic(), { headers })
}

export async function GET() {
  const result = await runDiagnostic()
  if ('error' in result) return NextResponse.json(result, { status: 502, headers })
  return NextResponse.json({ probes: result.probes }, { headers })
}

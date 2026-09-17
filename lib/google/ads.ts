import { getGoogleConnectionStatus, getGoogleOAuth2Client } from './auth'
import type { GoogleAdsProbeResult } from './ads-types'

// Cloud project access is determined by the existing OAuth client. No developer
// token, API Center flow, alternate credential, or Ads write operation is used.
const LIST_ACCOUNTS_URL = 'https://googleads.googleapis.com/v25/customers:listAccessibleCustomers'

type ApiFailure = {
  response?: {
    status?: number
    headers?: { get?: (name: string) => string | null }
    data?: { error?: { status?: string; details?: Array<{
      reason?: string
      errors?: Array<{ errorCode?: Record<string, string> }>
    }> } }
  }
}

/** The caller must authenticate and authorize userId before calling this. */
export async function probeGoogleAds(userId: string): Promise<GoogleAdsProbeResult> {
  try {
    const connection = await getGoogleConnectionStatus(userId)
    if (!connection.connected || !connection.googleAdsEnabled) {
      return { ok: false, code: 'MISSING_SCOPE', error: 'Enable Google Ads and approve its permission first.' }
    }
    const client = await getGoogleOAuth2Client(userId)
    if (!client) return { ok: false, error: 'Your Google connection is unavailable. Please reconnect Google Ads.' }

    const { data } = await client.request<{ resourceNames?: string[] }>({
      url: LIST_ACCOUNTS_URL,
      method: 'GET',
      timeout: 15_000,
      retry: false,
    })
    const names = data?.resourceNames ?? []
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && /^customers\/\d{10}$/.test(name))) {
      return { ok: false, error: 'Google Ads returned an unexpected account list. Please try again.' }
    }
    return { ok: true, customerIds: names.map(name => name.slice('customers/'.length)), checkedAt: new Date().toISOString() }
  } catch (error) {
    // Never return or log the raw OAuth/Gaxios error: it can contain credentials
    // and request headers. Only allow Google's bounded enum and request ID out.
    const response = (error as ApiFailure | undefined)?.response
    const apiError = response?.data?.error
    const detail = apiError?.details?.find(d => d.reason || d.errors?.length)
    const rawCode = detail?.reason ?? Object.values(detail?.errors?.[0]?.errorCode ?? {})[0] ?? apiError?.status
    const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(rawCode) ? rawCode : undefined
    const rawId = response?.headers?.get?.('request-id')
    const requestId = typeof rawId === 'string' && /^[\w-]{1,100}$/.test(rawId) ? rawId : undefined
    const message = response?.status === 401
      ? 'Google rejected the connection. Reconnect Google Ads and try again.'
      : response?.status === 403
        ? 'Google denied Ads access. Check the Cloud project access level and this Google account’s Ads permissions.'
        : response?.status === 429
          ? 'Google Ads has reached its request limit. Please try again later.'
          : 'The Google Ads access check failed. Please try again.'
    return { ok: false, error: message, code, requestId }
  }
}

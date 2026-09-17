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
      metadata?: { consumer?: unknown; service?: unknown }
      errors?: Array<{ errorCode?: Record<string, string> }>
    }> } }
  }
}

/** The caller must authenticate and authorize userId before calling this. */
export async function probeGoogleAds(userId: string): Promise<GoogleAdsProbeResult> {
  try {
    const connection = await getGoogleConnectionStatus(userId)
    if (!connection.connected || !connection.googleAdsEnabled) {
      return { ok: false, code: 'MISSING_SCOPE', error: 'Enable Google Ads and approve its permission first.', reconnectRequired: true }
    }
    const client = await getGoogleOAuth2Client(userId)
    if (!client) return { ok: false, error: 'Your Google connection is unavailable. Please reconnect Google Ads.', reconnectRequired: true }

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
    // and request headers. Only allow bounded codes, request IDs, and Google's
    // numeric consumer project for this API out. Never forward raw metadata or URLs.
    const response = (error as ApiFailure | undefined)?.response
    const apiError = response?.data?.error
    const disabledService = apiError?.details?.find(d => d.reason === 'SERVICE_DISABLED')
    const detail = disabledService ?? apiError?.details?.find(d => d.reason || d.errors?.length)
    const rawCode = detail?.reason ?? Object.values(detail?.errors?.[0]?.errorCode ?? {})[0] ?? apiError?.status
    const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(rawCode) ? rawCode : undefined
    const rawId = response?.headers?.get?.('request-id')
    const requestId = typeof rawId === 'string' && /^[\w-]{1,100}$/.test(rawId) ? rawId : undefined
    const consumer = disabledService?.metadata?.consumer
    const cloudProjectNumber = disabledService?.metadata?.service === 'googleads.googleapis.com' && typeof consumer === 'string'
      ? /^projects\/([0-9]{1,20})$/.exec(consumer)?.[1]
      : undefined
    if (code === 'SERVICE_DISABLED') {
      // Safe diagnostics let support identify the affected project without
      // accessing OAuth secrets or asking users to repeat Google consent.
      console.warn('[google/ads] Service disabled', { code, cloudProjectNumber, requestId })
      return {
        ok: false, code, requestId, cloudProjectNumber, reconnectRequired: false,
        error: `Google reports that the Ads API is disabled for ${cloudProjectNumber ? `Cloud project ${cloudProjectNumber}` : 'the Cloud project used by Kockpit'}. Enable it in that project, then test again. If you just enabled it, allow a few minutes for Google to apply the change. Reconnecting your Google account will not fix this.`,
      }
    }
    const reconnectRequired = response?.status === 401
    const message = reconnectRequired
      ? 'Google rejected the connection. Reconnect Google Ads and try again.'
      : response?.status === 403
        ? 'Google denied Ads access. Check the Cloud project access level and this Google account’s Ads permissions.'
        : response?.status === 429
          ? 'Google Ads has reached its request limit. Please try again later.'
          : 'The Google Ads access check failed. Please try again.'
    return { ok: false, error: message, code, requestId, reconnectRequired }
  }
}

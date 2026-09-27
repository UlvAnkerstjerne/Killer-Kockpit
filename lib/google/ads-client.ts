import 'server-only'
import type { getGoogleOAuth2Client } from './auth'

type OAuthClient = NonNullable<Awaited<ReturnType<typeof getGoogleOAuth2Client>>>

export class GoogleAdsReportingError extends Error {
  constructor(public readonly code: string, public readonly requestId?: string) {
    super(code === 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'
      ? 'Google Ads reporting requires production API access for the existing OAuth Cloud project (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION).'
      : `Google Ads reporting failed (${code}).`)
  }
}

/** Gaxios errors can contain OAuth credentials. Never propagate the raw error. */
function reportingError(error: unknown): GoogleAdsReportingError {
  const response = (error as { response?: { status?: number; headers?: { get?: (key: string) => string | null }; data?: {
    error?: { status?: string; details?: Array<{ reason?: string; errors?: Array<{ errorCode?: Record<string, string> }> }> }
  } } })?.response
  const api = response?.data?.error
  const details = api?.details ?? []
  const rawCode = details.flatMap(d => d.errors ?? []).flatMap(e => Object.values(e.errorCode ?? {}))[0]
    ?? details.find(d => d.reason)?.reason ?? api?.status
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(rawCode)
    ? rawCode : response?.status ? `HTTP_${response.status}` : 'REQUEST_FAILED'
  const rawId = response?.headers?.get?.('request-id')
  const requestId = typeof rawId === 'string' && /^[\w-]{1,100}$/.test(rawId) ? rawId : undefined
  return new GoogleAdsReportingError(code, requestId)
}

/** Read-only GAQL search. Uses the same OAuth client/API version as the probe. */
export async function searchGoogleAds<T>(client: OAuthClient, customerId: string, query: string): Promise<T[]> {
  if (!/^\d{10}$/.test(customerId)) throw new Error('Invalid Google Ads customer ID.')
  const rows: T[] = []
  const tokens = new Set<string>()
  let pageToken: string | undefined
  do {
    let data: { results?: T[]; nextPageToken?: string }
    try {
      const response = await client.request<typeof data>({
        url: `https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`,
        method: 'POST',
        ...(process.env.GOOGLE_ADS_DEVELOPER_TOKEN ? { headers: {
          'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '') } : {}),
        } } : {}),
        data: { query, ...(pageToken ? { pageToken } : {}) }, timeout: 30_000, retry: false,
      })
      data = response.data
    } catch (error) { throw reportingError(error) }
    if (!data || (data.results !== undefined && !Array.isArray(data.results))) {
      throw new GoogleAdsReportingError('INVALID_RESPONSE')
    }
    rows.push(...(data.results ?? []))
    pageToken = data.nextPageToken
    if (pageToken) {
      if (typeof pageToken !== 'string' || tokens.has(pageToken)) throw new GoogleAdsReportingError('INVALID_PAGINATION')
      tokens.add(pageToken)
    }
  } while (pageToken)
  return rows
}

async function mutate<T>(client: OAuthClient, customerId: string, resource: 'campaigns' | 'campaignBudgets', operations: unknown[]): Promise<T> {
  if (!/^\d{10}$/.test(customerId)) throw new Error('Invalid Google Ads customer ID.')
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  if (!developerToken) throw new GoogleAdsReportingError('DEVELOPER_TOKEN_NOT_CONFIGURED')
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, '')
  if (loginCustomerId && !/^\d{10}$/.test(loginCustomerId)) throw new GoogleAdsReportingError('INVALID_LOGIN_CUSTOMER_ID')
  try {
    const response = await client.request<T>({ url: `https://googleads.googleapis.com/v25/customers/${customerId}/${resource}:mutate`, method: 'POST', headers: { 'developer-token': developerToken, ...(loginCustomerId ? { 'login-customer-id': loginCustomerId } : {}) }, data: { operations, partialFailure: false, validateOnly: false }, timeout: 30_000, retry: false })
    return response.data
  } catch (error) { throw reportingError(error) }
}

export function updateGoogleCampaignStatus(client: OAuthClient, customerId: string, campaignId: string, status: 'ENABLED' | 'PAUSED') {
  if (!/^\d{1,30}$/.test(campaignId)) throw new Error('Invalid Google Ads campaign ID.')
  return mutate(client, customerId, 'campaigns', [{ update: { resourceName: `customers/${customerId}/campaigns/${campaignId}`, status }, updateMask: 'status' }])
}

export function updateGoogleCampaignBudget(client: OAuthClient, customerId: string, resourceName: string, amountMicros: number) {
  if (resourceName.split('/')[1] !== customerId || !/^customers\/\d{10}\/campaignBudgets\/\d+$/.test(resourceName)) throw new Error('Invalid Google Ads campaign budget resource name.')
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new Error('Invalid Google Ads budget.')
  return mutate(client, customerId, 'campaignBudgets', [{ update: { resourceName, amountMicros: String(amountMicros) }, updateMask: 'amount_micros' }])
}

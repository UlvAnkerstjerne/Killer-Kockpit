/**
 * lib/meta/auth.ts
 *
 * Meta System User token accessor.
 *
 * The token is a long-lived Meta Business Manager system user token stored
 * as an environment variable — never in the database, never returned to the
 * browser, never logged.
 *
 * System User tokens do not require OAuth flows or browser redirects.
 * They are institutional — the business's ad accounts, Pages, and IG account
 * are accessed once on behalf of the business, not tied to any individual's
 * personal Meta account.
 *
 * Set non-expiring in Meta Business Manager to avoid silent sync failures.
 * If a token expires, integration_sync_state.status will surface 'failed'
 * with a descriptive error from the API.
 */

/**
 * Returns the Authorization header for Meta Graph API requests,
 * or null if META_SYSTEM_USER_TOKEN is not configured.
 *
 * Never logs the token value.
 */
export function getMetaAuthHeaders(): { Authorization: string } | null {
  const token = process.env.META_SYSTEM_USER_TOKEN
  if (!token) return null
  return { Authorization: `Bearer ${token}` }
}

/**
 * Returns true if Meta credentials are present in the environment.
 * Does not validate the token against the API.
 */
export function hasMetaCredentials(): boolean {
  return !!process.env.META_SYSTEM_USER_TOKEN
}

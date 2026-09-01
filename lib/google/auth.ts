/**
 * lib/google/auth.ts
 *
 * Token encryption/decryption, OAuth2 client factory, and token storage.
 *
 * Security contract
 * -----------------
 * • Tokens are AES-256-GCM encrypted before they are written to the database.
 *   The key lives only in GOOGLE_TOKEN_ENCRYPTION_KEY (env var, never in DB).
 * • Decryption is server-side only.  Token values are never logged, never
 *   returned to the browser, and never appear in ActionResult payloads.
 * • Only safe metadata (connected, scopes, expiresAt) is exposed to the UI.
 * • All DB access uses the service-role client, which bypasses RLS.
 *   The google_oauth_tokens table has no permissive RLS policies for
 *   authenticated or anon roles, making it invisible to PostgREST.
 *
 * Encryption format
 * -----------------
 * AES-256-GCM:
 *   ciphertext_stored = iv_hex(24) + tag_hex(32) + ciphertext_hex(variable)
 * where iv  = 12 random bytes per encrypt call
 *       tag = 16-byte GCM authentication tag
 */

import crypto from 'crypto'
import { google } from 'googleapis'
import type { Auth } from 'googleapis'
import { createServiceClient } from '@/lib/supabase/server'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES  = 12  // 96-bit IV — optimal for GCM
const TAG_BYTES = 16  // 128-bit auth tag

// ─── Scope helpers ────────────────────────────────────────────────────────

export const CALENDAR_SCOPE       = 'https://www.googleapis.com/auth/calendar.events'
export const GMAIL_SCOPE          = 'https://www.googleapis.com/auth/gmail.readonly'
export const DRIVE_SCOPE          = 'https://www.googleapis.com/auth/drive.metadata.readonly'
export const MEET_READONLY_SCOPE  = 'https://www.googleapis.com/auth/meetings.space.readonly'
export const MEET_SETTINGS_SCOPE  = 'https://www.googleapis.com/auth/meetings.space.settings'
export const GBP_SCOPE            = 'https://www.googleapis.com/auth/business.manage'

export function hasCalendarScope(scopes: string[]): boolean {
  return scopes.some((s) => s.includes('calendar.events'))
}

export function hasGmailScope(scopes: string[]): boolean {
  return scopes.some((s) => s.includes('gmail.readonly'))
}

export function hasDriveScope(scopes: string[]): boolean {
  return scopes.some((s) => s.includes('drive.metadata.readonly'))
}

/**
 * Returns true when the stored scopes include BOTH:
 *   meetings.space.readonly  — read conference records and transcripts
 *   meetings.space.settings  — configure auto-transcription
 * Both are required for the full M5E transcript workflow.
 */
export function hasMeetScope(scopes: string[]): boolean {
  return (
    scopes.some((s) => s.includes('meetings.space.readonly')) &&
    scopes.some((s) => s.includes('meetings.space.settings'))
  )
}

export function hasGbpScope(scopes: string[]): boolean {
  return scopes.some((s) => s.includes('business.manage'))
}

// ─── Encryption helpers ───────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const hex = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error(
      'GOOGLE_TOKEN_ENCRYPTION_KEY must be set to a 64-character hex string (32 random bytes). ' +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    )
  }
  return Buffer.from(hex, 'hex')
}

/** Encrypts a plaintext string.  Returns: iv_hex + tag_hex + ciphertext_hex */
export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return iv.toString('hex') + tag.toString('hex') + encrypted.toString('hex')
}

/** Decrypts a value produced by encryptToken.  Throws on tampered ciphertext. */
export function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey()
  const iv  = Buffer.from(ciphertext.slice(0, IV_BYTES * 2), 'hex')
  const tag = Buffer.from(ciphertext.slice(IV_BYTES * 2, IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const enc = Buffer.from(ciphertext.slice(IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

// ─── OAuth2Client factory ─────────────────────────────────────────────────

/** Builds a bare OAuth2Client (no credentials set).  Used to start the auth flow. */
export function buildOAuth2Client(): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/google/connect/callback`,
  )
}

// ─── Token storage ────────────────────────────────────────────────────────

/**
 * Full upsert: encrypts and stores both tokens, scopes, and the connected
 * Google account email.  Requires an access_token AND a refresh_token.
 * Use this for the initial connect and for any flow where Google returns
 * a new refresh_token.
 */
export async function storeGoogleTokens(
  userId: string,
  credentials: Auth.Credentials,
  googleEmail?: string,
): Promise<void> {
  if (!credentials.access_token || !credentials.refresh_token) {
    throw new Error('Both access_token and refresh_token are required to store credentials.')
  }
  const serviceClient = createServiceClient()
  const patch: Record<string, unknown> = {
    user_id:                 userId,
    encrypted_access_token:  encryptToken(credentials.access_token),
    encrypted_refresh_token: encryptToken(credentials.refresh_token),
    expires_at: credentials.expiry_date
      ? new Date(credentials.expiry_date).toISOString()
      : new Date(Date.now() + 3600 * 1000).toISOString(),
    scopes: credentials.scope ? credentials.scope.split(' ') : [],
  }
  if (googleEmail) patch.google_account_email = googleEmail
  const { error } = await serviceClient.from('google_oauth_tokens').upsert(patch)
  if (error) throw new Error(`Failed to store Google tokens: ${error.message}`)
}

/**
 * Incremental-auth patch: updates the access_token, scopes, and optionally
 * the Google account email, while PRESERVING the existing encrypted
 * refresh_token.  Used when Google returns a new access_token but no new
 * refresh_token (e.g. incremental scope grant where the session already has
 * a valid refresh_token for the combined scope set).
 *
 * Throws if no existing row is found — the caller must fall back to a full
 * re-authorization.
 */
export async function patchGoogleTokensPreservingRefresh(
  userId: string,
  credentials: Auth.Credentials,
  googleEmail?: string,
): Promise<void> {
  if (!credentials.access_token) {
    throw new Error('access_token is required to patch credentials.')
  }
  const serviceClient = createServiceClient()

  // Verify an existing row with a refresh token is present
  const { data: existing } = await serviceClient
    .from('google_oauth_tokens')
    .select('encrypted_refresh_token')
    .eq('user_id', userId)
    .single()

  if (!existing?.encrypted_refresh_token) {
    throw new Error(
      'No existing refresh token found for this user. ' +
      'A full re-authorization (disconnect + reconnect) is required.',
    )
  }

  const patch: Record<string, unknown> = {
    encrypted_access_token: encryptToken(credentials.access_token),
    expires_at: credentials.expiry_date
      ? new Date(credentials.expiry_date).toISOString()
      : new Date(Date.now() + 3600 * 1000).toISOString(),
    scopes: credentials.scope ? credentials.scope.split(' ') : [],
  }
  if (googleEmail) patch.google_account_email = googleEmail

  const { error } = await serviceClient
    .from('google_oauth_tokens')
    .update(patch)
    .eq('user_id', userId)

  if (error) throw new Error(`Failed to patch Google tokens: ${error.message}`)
}

/** Removes all stored tokens for a user (disconnects entire Google integration). */
export async function deleteGoogleTokens(userId: string): Promise<void> {
  const serviceClient = createServiceClient()
  await serviceClient.from('google_oauth_tokens').delete().eq('user_id', userId)
}

// ─── Client retrieval ─────────────────────────────────────────────────────

/**
 * Returns a fully configured OAuth2Client with a valid access token.
 * Automatically refreshes the token if it will expire within 5 minutes and
 * persists the new access token to the database.
 * Returns null if no tokens are stored for this user.
 */
export async function getGoogleOAuth2Client(userId: string): Promise<Auth.OAuth2Client | null> {
  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient
    .from('google_oauth_tokens')
    .select('encrypted_access_token, encrypted_refresh_token, expires_at, scopes')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null

  const accessToken  = decryptToken(data.encrypted_access_token as string)
  const refreshToken = decryptToken(data.encrypted_refresh_token as string)

  const client = buildOAuth2Client()
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   new Date(data.expires_at as string).getTime(),
    scope:         (data.scopes as string[]).join(' '),
  })

  // Proactively refresh if expiring within 5 minutes
  const expiresAt = new Date(data.expires_at as string).getTime()
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    try {
      const { credentials } = await client.refreshAccessToken()
      client.setCredentials(credentials)
      if (credentials.access_token) {
        await serviceClient
          .from('google_oauth_tokens')
          .update({
            encrypted_access_token: encryptToken(credentials.access_token),
            expires_at: credentials.expiry_date
              ? new Date(credentials.expiry_date).toISOString()
              : new Date(Date.now() + 3600 * 1000).toISOString(),
          })
          .eq('user_id', userId)
      }
    } catch (refreshErr) {
      // Log but don't throw — the access token may still be valid
      console.error('[google/auth] Token refresh failed:', (refreshErr as Error).message)
    }
  }

  return client
}

// ─── Safe connection metadata (UI-safe, no tokens) ───────────────────────

export type GoogleConnectionStatus =
  | { connected: false }
  | {
      connected: true
      scopes: string[]
      expiresAt: string
      googleAccountEmail: string | null
      /** true = token is valid or refreshable; always true when connected */
      healthy: boolean
      // Derived capability flags for convenience
      calendarEnabled: boolean
      gmailEnabled: boolean
      driveEnabled: boolean
      /** true when both meetings.space.readonly and meetings.space.settings are granted */
      meetEnabled: boolean
      gbpEnabled: boolean
    }

/**
 * Returns safe connection metadata for the UI.
 * Never includes token values.  Safe to pass as props or return from actions.
 */
export async function getGoogleConnectionStatus(userId: string): Promise<GoogleConnectionStatus> {
  const serviceClient = createServiceClient()
  const { data } = await serviceClient
    .from('google_oauth_tokens')
    .select('expires_at, scopes, google_account_email')
    .eq('user_id', userId)
    .single()

  if (!data) return { connected: false }

  const scopes = data.scopes as string[]
  return {
    connected:          true,
    scopes,
    expiresAt:          data.expires_at as string,
    googleAccountEmail: (data.google_account_email as string | null) ?? null,
    healthy:            true, // refresh_token always stored; we can always get a new access token
    calendarEnabled:    hasCalendarScope(scopes),
    gmailEnabled:       hasGmailScope(scopes),
    driveEnabled:       hasDriveScope(scopes),
    meetEnabled:        hasMeetScope(scopes),
    gbpEnabled:         hasGbpScope(scopes),
  }
}

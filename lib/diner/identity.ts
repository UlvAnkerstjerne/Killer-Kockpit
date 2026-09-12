/**
 * lib/diner/identity.ts
 *
 * HMAC-SHA256 signed identity cookie for authenticated Mystery Diners.
 *
 * Cookie format (mirrors lib/diner/session.ts):
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 *
 * Payload: { dinerId: string }
 *
 * Uses DINER_SESSION_SECRET (same key as dk_session; different cookie name and
 * distinct payload shape prevent any cross-cookie confusion).
 *
 * Cookie lifespan: 1 year (renewed on each portal access).
 *
 * Server-only — never import from client components.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export interface DinerIdentity {
  dinerId: string
}

export const DINER_IDENTITY_COOKIE_NAME = 'dk_identity'
export const DINER_IDENTITY_MAX_AGE     = 365 * 24 * 60 * 60 // 1 year in seconds

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getSecret(): Buffer {
  const raw = process.env.DINER_SESSION_SECRET
  if (!raw) throw new Error('[diner/identity] DINER_SESSION_SECRET is not set')
  return Buffer.from(raw, 'base64')
}

function computeMac(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Produces a signed cookie value for the given diner identity.
 * Throws if DINER_SESSION_SECRET is absent.
 */
export function signDinerIdentity(identity: DinerIdentity): string {
  const secret  = getSecret()
  const payload = Buffer.from(JSON.stringify(identity)).toString('base64url')
  const mac     = computeMac(payload, secret)
  return `${payload}.${mac}`
}

/**
 * Verifies and decodes a signed identity cookie value.
 * Returns null if the signature is invalid, the cookie is malformed, or
 * the dinerId field is missing — never throws.
 *
 * Uses timingSafeEqual for MAC comparison.
 */
export function verifyDinerIdentity(cookieValue: string): DinerIdentity | null {
  try {
    const lastDot = cookieValue.lastIndexOf('.')
    if (lastDot === -1) return null

    const payload  = cookieValue.slice(0, lastDot)
    const provided = cookieValue.slice(lastDot + 1)

    const secret   = getSecret()
    const expected = computeMac(payload, secret)

    const providedBuf = Buffer.from(provided)
    const expectedBuf = Buffer.from(expected)
    if (providedBuf.byteLength !== expectedBuf.byteLength) return null
    if (!timingSafeEqual(providedBuf, expectedBuf)) return null

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed?.dinerId !== 'string') return null

    return { dinerId: parsed.dinerId }
  } catch {
    return null
  }
}

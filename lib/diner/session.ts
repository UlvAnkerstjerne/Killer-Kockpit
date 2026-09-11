/**
 * lib/diner/session.ts
 *
 * HMAC-SHA256 signed session cookie for Mystery Diner public sessions.
 *
 * Cookie format:
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 *
 * The separator '.' does not appear in base64url output, so splitting on
 * the last '.' is unambiguous.
 *
 * Security properties:
 *   - HMAC key is DINER_SESSION_SECRET (must be set; min 32 bytes as base64).
 *   - MAC verification uses timingSafeEqual — immune to timing attacks.
 *   - Cookie flags: HttpOnly, Secure (production), SameSite=Lax, Path=/diner.
 *   - Session grants access only to the scoped (invitationId, submissionId) pair.
 *
 * Server-only — never import from client components.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export interface DinerSession {
  invitationId: string
  submissionId: string
}

export const DINER_COOKIE_NAME = 'dk_session'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getSecret(): Buffer {
  const raw = process.env.DINER_SESSION_SECRET
  if (!raw) throw new Error('[diner/session] DINER_SESSION_SECRET is not set')
  return Buffer.from(raw, 'base64')
}

function computeMac(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Produces a signed cookie value for the given session.
 * Throws if DINER_SESSION_SECRET is absent.
 */
export function signDinerSession(session: DinerSession): string {
  const secret  = getSecret()
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
  const mac     = computeMac(payload, secret)
  return `${payload}.${mac}`
}

/**
 * Verifies and decodes a signed cookie value.
 * Returns null if the signature is invalid, the cookie is malformed, or the
 * session fields are missing/wrong type — never throws.
 *
 * Uses timingSafeEqual for MAC comparison.
 */
export function verifyDinerSession(cookieValue: string): DinerSession | null {
  try {
    const lastDot = cookieValue.lastIndexOf('.')
    if (lastDot === -1) return null

    const payload  = cookieValue.slice(0, lastDot)
    const provided = cookieValue.slice(lastDot + 1)

    const secret   = getSecret()
    const expected = computeMac(payload, secret)

    // Constant-time comparison — buffers must be same length
    const providedBuf = Buffer.from(provided)
    const expectedBuf = Buffer.from(expected)
    if (providedBuf.byteLength !== expectedBuf.byteLength) return null
    if (!timingSafeEqual(providedBuf, expectedBuf)) return null

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed?.invitationId !== 'string') return null
    if (typeof parsed?.submissionId !== 'string') return null

    return { invitationId: parsed.invitationId, submissionId: parsed.submissionId }
  } catch {
    return null
  }
}

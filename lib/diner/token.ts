/**
 * lib/diner/token.ts
 *
 * Cryptographic token helpers for Mystery Diner invite links.
 *
 * Raw tokens are 32 bytes of CSPRNG output encoded as base64url (43 chars).
 * Only the SHA-256 hex digest is stored in the database — the raw token
 * is returned once at invite creation and never persisted.
 *
 * Server-only — never import from client components.
 */

import { randomBytes, createHash } from 'crypto'

/**
 * Generates a new invite token pair.
 * The caller must use rawToken in the public URL and store only tokenHash.
 */
export function generateInviteToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url')
  return { rawToken, tokenHash: hashInviteToken(rawToken) }
}

/**
 * Returns the SHA-256 hex digest of a raw invite token.
 * Used both at invite creation and at validation time.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

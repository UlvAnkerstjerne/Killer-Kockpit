import { createHash, timingSafeEqual } from 'node:crypto'

/** Constant-time comparison without leaking the configured token or its length. */
export function isValidKockpitActionsToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  const providedDigest = createHash('sha256').update(provided).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

export function readBearerToken(authorization: string | null): string {
  if (!authorization?.startsWith('Bearer ')) return ''
  return authorization.slice(7)
}

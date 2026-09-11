/**
 * __tests__/unit/lib/diner-token.test.ts
 *
 * Tests for Mystery Diner invite token generation and hashing.
 */

import { describe, it, expect } from 'vitest'
import { generateInviteToken, hashInviteToken } from '@/lib/diner/token'

describe('generateInviteToken', () => {
  it('returns a rawToken and a tokenHash', () => {
    const { rawToken, tokenHash } = generateInviteToken()
    expect(typeof rawToken).toBe('string')
    expect(typeof tokenHash).toBe('string')
  })

  it('rawToken is base64url (no +, /, =)', () => {
    const { rawToken } = generateInviteToken()
    expect(rawToken).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  it('rawToken is high-entropy (≥ 32 decoded bytes → ≥ 43 base64url chars)', () => {
    const { rawToken } = generateInviteToken()
    // 32 bytes → ceil(32*4/3) = 43 chars in base64url (no padding)
    expect(rawToken.length).toBeGreaterThanOrEqual(43)
  })

  it('tokenHash is a 64-char hex string (SHA-256)', () => {
    const { tokenHash } = generateInviteToken()
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('tokenHash matches hashInviteToken(rawToken)', () => {
    const { rawToken, tokenHash } = generateInviteToken()
    expect(hashInviteToken(rawToken)).toBe(tokenHash)
  })

  it('produces unique tokens on each call', () => {
    const a = generateInviteToken()
    const b = generateInviteToken()
    expect(a.rawToken).not.toBe(b.rawToken)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })
})

describe('hashInviteToken', () => {
  it('is deterministic for the same input', () => {
    const token = 'aaabbbccc'
    expect(hashInviteToken(token)).toBe(hashInviteToken(token))
  })

  it('produces different hashes for different inputs', () => {
    expect(hashInviteToken('tokenA')).not.toBe(hashInviteToken('tokenB'))
  })

  it('does not return the raw input', () => {
    const raw = 'some-raw-token'
    expect(hashInviteToken(raw)).not.toBe(raw)
  })
})

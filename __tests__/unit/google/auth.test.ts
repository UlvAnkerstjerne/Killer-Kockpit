/**
 * Tests for lib/google/auth.ts
 * Covers the encryption round-trip, which is the most critical server-side
 * invariant. OAuth2Client construction and token DB access are not tested
 * here (require live credentials / DB).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Set a valid 64-char hex key before importing the module
const TEST_KEY = 'a'.repeat(64)

describe('encryptToken / decryptToken', () => {
  beforeEach(() => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = TEST_KEY
  })
  afterEach(() => {
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
    vi.resetModules()
  })

  it('round-trips a short token', async () => {
    const { encryptToken, decryptToken } = await import('@/lib/google/auth')
    const plain = 'ya29.short_access_token'
    expect(decryptToken(encryptToken(plain))).toBe(plain)
  })

  it('round-trips a long refresh token', async () => {
    const { encryptToken, decryptToken } = await import('@/lib/google/auth')
    const plain = '1//0g' + 'x'.repeat(200)
    expect(decryptToken(encryptToken(plain))).toBe(plain)
  })

  it('produces different ciphertext on each call (random IV)', async () => {
    const { encryptToken } = await import('@/lib/google/auth')
    const plain = 'same_token'
    expect(encryptToken(plain)).not.toBe(encryptToken(plain))
  })

  it('throws on tampered ciphertext (GCM auth tag fails)', async () => {
    const { encryptToken, decryptToken } = await import('@/lib/google/auth')
    const ciphertext = encryptToken('secret')
    // Flip one char in the ciphertext portion (after iv+tag = 56 hex chars)
    const tampered = ciphertext.slice(0, 57) + (ciphertext[57] === 'a' ? 'b' : 'a') + ciphertext.slice(58)
    expect(() => decryptToken(tampered)).toThrow()
  })

  it('throws when key env var is missing', async () => {
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
    vi.resetModules()
    const { encryptToken } = await import('@/lib/google/auth')
    expect(() => encryptToken('test')).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/)
  })

  it('throws when key env var is wrong length', async () => {
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'tooshort'
    vi.resetModules()
    const { encryptToken } = await import('@/lib/google/auth')
    expect(() => encryptToken('test')).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/)
  })
})

// ─── hasMeetScope ──────────────────────────────────────────────────────────

describe('hasMeetScope', () => {
  it('returns true when both readonly and settings scopes are present', async () => {
    const { hasMeetScope } = await import('@/lib/google/auth')
    const scopes = [
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/meetings.space.settings',
    ]
    expect(hasMeetScope(scopes)).toBe(true)
  })

  it('returns false when only readonly is present', async () => {
    const { hasMeetScope } = await import('@/lib/google/auth')
    const scopes = ['https://www.googleapis.com/auth/meetings.space.readonly']
    expect(hasMeetScope(scopes)).toBe(false)
  })

  it('returns false when only settings is present', async () => {
    const { hasMeetScope } = await import('@/lib/google/auth')
    const scopes = ['https://www.googleapis.com/auth/meetings.space.settings']
    expect(hasMeetScope(scopes)).toBe(false)
  })

  it('returns false for an empty scope list', async () => {
    const { hasMeetScope } = await import('@/lib/google/auth')
    expect(hasMeetScope([])).toBe(false)
  })

  it('returns false when only Calendar / Gmail / Drive scopes are present', async () => {
    const { hasMeetScope } = await import('@/lib/google/auth')
    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ]
    expect(hasMeetScope(scopes)).toBe(false)
  })

  it('returns true when Meet scopes are mixed with other scopes', async () => {
    const { hasMeetScope } = await import('@/lib/google/auth')
    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/meetings.space.settings',
    ]
    expect(hasMeetScope(scopes)).toBe(true)
  })
})

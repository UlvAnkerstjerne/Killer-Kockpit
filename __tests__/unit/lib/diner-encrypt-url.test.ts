/**
 * __tests__/unit/lib/diner-encrypt-url.test.ts
 *
 * Tests for invite URL encryption/decryption used to support email retry
 * without storing the raw token in the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encryptInviteUrl, decryptInviteUrl } from '@/lib/diner/encrypt-url'

const TEST_SECRET = 'test-secret-for-unit-tests-32chars!!'
const SAMPLE_URL  = 'https://kockpit.killerkebab.com/diner/abc123XYZ_some-base64url-token'

// ─── With secret configured ───────────────────────────────────────────────────

describe('encryptInviteUrl / decryptInviteUrl — with DINER_INVITE_SECRET set', () => {
  beforeEach(() => { process.env.DINER_INVITE_SECRET = TEST_SECRET })
  afterEach(() => { delete process.env.DINER_INVITE_SECRET })

  it('roundtrip: decrypt(encrypt(url)) === url', () => {
    const ciphertext = encryptInviteUrl(SAMPLE_URL)
    expect(ciphertext).not.toBeNull()
    expect(decryptInviteUrl(ciphertext!)).toBe(SAMPLE_URL)
  })

  it('produces different ciphertext each call (random IV)', () => {
    const a = encryptInviteUrl(SAMPLE_URL)
    const b = encryptInviteUrl(SAMPLE_URL)
    expect(a).not.toBe(b)
    // but both decrypt to the same value
    expect(decryptInviteUrl(a!)).toBe(SAMPLE_URL)
    expect(decryptInviteUrl(b!)).toBe(SAMPLE_URL)
  })

  it('ciphertext has three colon-separated parts (iv:tag:data)', () => {
    const ciphertext = encryptInviteUrl(SAMPLE_URL)!
    expect(ciphertext.split(':').length).toBe(3)
  })

  it('decrypts long URLs correctly', () => {
    const longUrl = 'https://kockpit.killerkebab.com/diner/' + 'a'.repeat(200)
    const ct = encryptInviteUrl(longUrl)!
    expect(decryptInviteUrl(ct)).toBe(longUrl)
  })

  it('returns null for tampered ciphertext', () => {
    const ct = encryptInviteUrl(SAMPLE_URL)!
    const tampered = ct.slice(0, -4) + 'XXXX'
    expect(decryptInviteUrl(tampered)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(decryptInviteUrl('not:valid')).toBeNull()
    expect(decryptInviteUrl('one-part-only')).toBeNull()
    expect(decryptInviteUrl('')).toBeNull()
  })
})

// ─── Without secret ────────────────────────────────────────────────────────────

describe('encryptInviteUrl / decryptInviteUrl — without DINER_INVITE_SECRET', () => {
  beforeEach(() => { delete process.env.DINER_INVITE_SECRET })

  it('encryptInviteUrl returns null when secret is absent', () => {
    expect(encryptInviteUrl(SAMPLE_URL)).toBeNull()
  })

  it('decryptInviteUrl returns null when secret is absent', () => {
    // Even with a valid-looking ciphertext, no secret = cannot decrypt
    const fakeCtx = 'aabbccdd:eeff0011:22334455'
    expect(decryptInviteUrl(fakeCtx)).toBeNull()
  })
})

// ─── Security properties ───────────────────────────────────────────────────────

describe('encryptInviteUrl — security properties', () => {
  beforeEach(() => { process.env.DINER_INVITE_SECRET = TEST_SECRET })
  afterEach(() => { delete process.env.DINER_INVITE_SECRET })

  it('ciphertext does not contain the raw URL', () => {
    const ct = encryptInviteUrl(SAMPLE_URL)!
    expect(ct).not.toContain('abc123XYZ')
    expect(ct).not.toContain('killerkebab')
    expect(ct).not.toContain('/diner/')
  })

  it('different secrets produce non-interoperable ciphertexts', () => {
    const ct = encryptInviteUrl(SAMPLE_URL)!

    // Swap to a different secret
    process.env.DINER_INVITE_SECRET = 'completely-different-secret-value'
    expect(decryptInviteUrl(ct)).toBeNull()
  })
})

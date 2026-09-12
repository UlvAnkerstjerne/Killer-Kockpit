/**
 * __tests__/unit/lib/diner-identity.test.ts
 *
 * Unit tests for lib/diner/identity.ts — diner identity cookie signing/verifying.
 * Mirrors the structure of the existing diner-session tests.
 *
 * Environment: Node (vitest.config.ts sets environment: 'node').
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { signDinerIdentity, verifyDinerIdentity, DINER_IDENTITY_COOKIE_NAME, DINER_IDENTITY_MAX_AGE } from '@/lib/diner/identity'

const TEST_SECRET = Buffer.from('test-diner-session-secret-at-least-32-bytes!!').toString('base64')

beforeAll(() => {
  process.env.DINER_SESSION_SECRET = TEST_SECRET
})

// ─── Constants ────────────────────────────────────────────────────────────────

describe('DINER_IDENTITY_COOKIE_NAME', () => {
  it('is dk_identity', () => {
    expect(DINER_IDENTITY_COOKIE_NAME).toBe('dk_identity')
  })
})

describe('DINER_IDENTITY_MAX_AGE', () => {
  it('is 1 year in seconds', () => {
    expect(DINER_IDENTITY_MAX_AGE).toBe(365 * 24 * 60 * 60)
  })
})

// ─── signDinerIdentity ────────────────────────────────────────────────────────

describe('signDinerIdentity', () => {
  it('returns a non-empty string', () => {
    const val = signDinerIdentity({ dinerId: 'abc-123' })
    expect(typeof val).toBe('string')
    expect(val.length).toBeGreaterThan(0)
  })

  it('contains exactly one dot separator', () => {
    const val = signDinerIdentity({ dinerId: 'abc-123' })
    const parts = val.split('.')
    expect(parts).toHaveLength(2)
  })

  it('produces different values for different dinerIds', () => {
    const a = signDinerIdentity({ dinerId: 'diner-1' })
    const b = signDinerIdentity({ dinerId: 'diner-2' })
    expect(a).not.toBe(b)
  })
})

// ─── verifyDinerIdentity ──────────────────────────────────────────────────────

describe('verifyDinerIdentity', () => {
  it('round-trips a valid identity', () => {
    const dinerId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const cookie  = signDinerIdentity({ dinerId })
    const result  = verifyDinerIdentity(cookie)
    expect(result).toEqual({ dinerId })
  })

  it('returns null for empty string', () => {
    expect(verifyDinerIdentity('')).toBeNull()
  })

  it('returns null for a string with no dot', () => {
    expect(verifyDinerIdentity('nodothere')).toBeNull()
  })

  it('returns null when the MAC is tampered', () => {
    const cookie  = signDinerIdentity({ dinerId: 'some-id' })
    const lastDot = cookie.lastIndexOf('.')
    const tampered = cookie.slice(0, lastDot + 1) + 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    expect(verifyDinerIdentity(tampered)).toBeNull()
  })

  it('returns null when the payload is tampered', () => {
    const cookie    = signDinerIdentity({ dinerId: 'real-id' })
    const lastDot   = cookie.lastIndexOf('.')
    const mac       = cookie.slice(lastDot)
    // Replace payload with a different id (base64url encoded)
    const fakePayload = Buffer.from(JSON.stringify({ dinerId: 'fake-id' })).toString('base64url')
    const tampered  = fakePayload + mac
    expect(verifyDinerIdentity(tampered)).toBeNull()
  })

  it('returns null for a completely arbitrary string', () => {
    expect(verifyDinerIdentity('not.a.valid.cookie.at.all')).toBeNull()
  })

  it('returns null when dinerId is missing from payload', () => {
    const raw     = Buffer.from(JSON.stringify({ other: 'field' })).toString('base64url')
    // We can't produce a valid MAC without the key, so this will fail MAC verification
    expect(verifyDinerIdentity(`${raw}.fakemac`)).toBeNull()
  })

  it('never throws on malformed input', () => {
    const inputs = ['', '.', '..', 'a.b.c', '!@#$%', 'YQ==.sig']
    for (const input of inputs) {
      expect(() => verifyDinerIdentity(input)).not.toThrow()
    }
  })
})

// ─── Cookie distinctness from dk_session ─────────────────────────────────────

describe('cookie name distinctness', () => {
  it('dk_identity differs from dk_session', () => {
    expect(DINER_IDENTITY_COOKIE_NAME).not.toBe('dk_session')
  })
})

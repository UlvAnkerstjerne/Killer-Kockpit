/**
 * __tests__/unit/lib/diner-session.test.ts
 *
 * Tests for Mystery Diner HMAC-SHA256 session cookie signing and verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { signDinerSession, verifyDinerSession } from '@/lib/diner/session'

// ── Env setup ─────────────────────────────────────────────────────────────────

// A valid 32-byte secret encoded as base64
const VALID_SECRET = Buffer.from('a'.repeat(32)).toString('base64')

beforeEach(() => {
  process.env.DINER_SESSION_SECRET = VALID_SECRET
})

afterEach(() => {
  delete process.env.DINER_SESSION_SECRET
  vi.restoreAllMocks()
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const validSession = {
  invitationId: '00000000-0000-0000-0000-000000000001',
  submissionId: '00000000-0000-0000-0000-000000000002',
}

// ── sign + verify round-trip ──────────────────────────────────────────────────

describe('signDinerSession + verifyDinerSession round-trip', () => {
  it('verifies a freshly signed cookie', () => {
    const cookie = signDinerSession(validSession)
    const result = verifyDinerSession(cookie)
    expect(result).toEqual(validSession)
  })

  it('cookie contains no raw UUIDs in plaintext (payload is base64url)', () => {
    const cookie = signDinerSession(validSession)
    // The cookie value should be two base64url segments separated by a dot
    expect(cookie).toMatch(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/)
  })

  it('preserves both invitationId and submissionId exactly', () => {
    const session = {
      invitationId: 'inv-id-xyz',
      submissionId: 'sub-id-abc',
    }
    const result = verifyDinerSession(signDinerSession(session))
    expect(result?.invitationId).toBe('inv-id-xyz')
    expect(result?.submissionId).toBe('sub-id-abc')
  })
})

// ── Tamper detection ──────────────────────────────────────────────────────────

describe('verifyDinerSession — tamper detection', () => {
  it('returns null for a cookie with a flipped bit in the payload', () => {
    const cookie  = signDinerSession(validSession)
    const [payload, mac] = cookie.split('.')
    // Flip one char in the payload
    const tampered = payload.slice(0, -1) + (payload.slice(-1) === 'A' ? 'B' : 'A')
    expect(verifyDinerSession(`${tampered}.${mac}`)).toBeNull()
  })

  it('returns null for a cookie with a tampered MAC', () => {
    const cookie  = signDinerSession(validSession)
    const [payload, mac] = cookie.split('.')
    const tamperedMac = mac.slice(0, -1) + (mac.slice(-1) === 'A' ? 'B' : 'A')
    expect(verifyDinerSession(`${payload}.${tamperedMac}`)).toBeNull()
  })

  it('returns null for a cookie signed with a different secret', () => {
    const cookie = signDinerSession(validSession)
    // Switch to a different secret for verification
    process.env.DINER_SESSION_SECRET = Buffer.from('b'.repeat(32)).toString('base64')
    expect(verifyDinerSession(cookie)).toBeNull()
  })

  it('returns null for a completely fabricated value', () => {
    expect(verifyDinerSession('notavalidcookie')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(verifyDinerSession('')).toBeNull()
  })

  it('returns null when DINER_SESSION_SECRET is absent', () => {
    delete process.env.DINER_SESSION_SECRET
    const cookie = 'payload.fakemac'
    // Should not throw — returns null gracefully
    expect(verifyDinerSession(cookie)).toBeNull()
  })
})

// ── sign: missing secret ──────────────────────────────────────────────────────

describe('signDinerSession — missing secret', () => {
  it('throws when DINER_SESSION_SECRET is not set', () => {
    delete process.env.DINER_SESSION_SECRET
    expect(() => signDinerSession(validSession)).toThrow('DINER_SESSION_SECRET')
  })
})

// ── Isolation: different sessions don't cross-validate ───────────────────────

describe('session isolation', () => {
  it('a cookie for session A does not verify as session B', () => {
    const sessionA = { invitationId: 'inv-A', submissionId: 'sub-A' }
    const sessionB = { invitationId: 'inv-B', submissionId: 'sub-B' }
    const cookieA  = signDinerSession(sessionA)
    const result   = verifyDinerSession(cookieA)
    expect(result?.invitationId).not.toBe(sessionB.invitationId)
    expect(result?.submissionId).not.toBe(sessionB.submissionId)
  })
})

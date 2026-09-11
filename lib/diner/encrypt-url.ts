/**
 * lib/diner/encrypt-url.ts
 *
 * AES-256-GCM encryption for Mystery Diner invite URLs.
 *
 * The raw invite token is never stored in the database. This module lets us
 * store the invite URL encrypted — so email delivery can be retried — without
 * weakening the security model. Decryption requires both the ciphertext (in DB)
 * AND the DINER_INVITE_SECRET env var (server-only). Neither alone is sufficient.
 *
 * Encoding: `<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 *
 * If DINER_INVITE_SECRET is absent, both functions return null and retry is
 * unavailable — but invitation creation and email send are unaffected.
 *
 * Server-only — never import from client components.
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'

const SALT    = 'diner-invite-url-v1'
const ALG     = 'aes-256-gcm'
const KEY_LEN = 32
const IV_LEN  = 12

function deriveKey(): Buffer | null {
  const secret = process.env.DINER_INVITE_SECRET?.trim()
  if (!secret) return null
  return scryptSync(secret, SALT, KEY_LEN) as Buffer
}

/**
 * Encrypts an invite URL using AES-256-GCM.
 * Returns the ciphertext string, or null if DINER_INVITE_SECRET is not set.
 */
export function encryptInviteUrl(url: string): string | null {
  const key = deriveKey()
  if (!key) return null

  const iv     = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const enc    = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()

  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/**
 * Decrypts a ciphertext produced by encryptInviteUrl().
 * Returns the original URL, or null on any error (missing secret, tampered data, etc.).
 */
export function decryptInviteUrl(ciphertext: string): string | null {
  const key = deriveKey()
  if (!key) return null

  try {
    const parts = ciphertext.split(':')
    if (parts.length !== 3) return null
    const [ivHex, tagHex, encHex] = parts

    const iv      = Buffer.from(ivHex,  'hex')
    const tag     = Buffer.from(tagHex, 'hex')
    const enc     = Buffer.from(encHex, 'hex')
    const decipher = createDecipheriv(ALG, key, iv)
    decipher.setAuthTag(tag)

    return decipher.update(enc).toString('utf8') + decipher.final('utf8')
  } catch {
    return null
  }
}

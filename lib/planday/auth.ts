/**
 * lib/planday/auth.ts
 *
 * Planday credential encryption, storage, and retrieval.
 *
 * Security contract
 * -----------------
 * • client_id and refresh_token are AES-256-GCM encrypted before DB storage.
 *   The key lives in PLANDAY_TOKEN_ENCRYPTION_KEY (env var, never in DB).
 * • Decryption is server-side only.  Credential values are never logged,
 *   never returned to the browser, and never appear in ActionResult payloads.
 * • Only safe metadata (connected, portalId, portalName) is exposed to the UI.
 * • All DB access uses the service-role client, which bypasses RLS.
 *   planday_credentials has no permissive RLS policies — invisible to PostgREST.
 *
 * Encryption format (same as lib/google/auth.ts)
 * -----------------
 * AES-256-GCM:
 *   stored = iv_hex(24) + tag_hex(32) + ciphertext_hex(variable)
 */

import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES   = 12   // 96-bit IV — optimal for GCM
const TAG_BYTES  = 16   // 128-bit auth tag

// ─── Encryption helpers ───────────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const hex = process.env.PLANDAY_TOKEN_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error(
      'PLANDAY_TOKEN_ENCRYPTION_KEY must be set to a 64-character hex string (32 random bytes). ' +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    )
  }
  return Buffer.from(hex, 'hex')
}

function encryptCredential(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return iv.toString('hex') + tag.toString('hex') + encrypted.toString('hex')
}

function decryptCredential(ciphertext: string): string {
  const key = getEncryptionKey()
  const iv  = Buffer.from(ciphertext.slice(0, IV_BYTES * 2), 'hex')
  const tag = Buffer.from(ciphertext.slice(IV_BYTES * 2, IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const enc = Buffer.from(ciphertext.slice(IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export interface PlandayCredentials {
  clientId: string
  refreshToken: string
  portalId: string | null
  portalName: string | null
}

export type PlandayConnectionStatus =
  | { connected: false }
  | { connected: true; portalId: string | null; portalName: string | null }

/** Upsert: encrypts and stores client_id + refresh_token. Single org-level row. */
export async function storePlandayCredentials(
  clientId: string,
  refreshToken: string,
): Promise<void> {
  const serviceClient = createServiceClient()
  const { error } = await serviceClient.from('planday_credentials').upsert({
    singleton_key:           'default',
    encrypted_client_id:     encryptCredential(clientId),
    encrypted_refresh_token: encryptCredential(refreshToken),
    portal_id:   null,  // reset portal cache on credential change
    portal_name: null,
    updated_at:  new Date().toISOString(),
  })
  if (error) throw new Error(`Failed to store Planday credentials: ${error.message}`)
}

/** Retrieves and decrypts the stored credentials. Throws if not configured. */
export async function getPlandayCredentials(): Promise<PlandayCredentials> {
  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient
    .from('planday_credentials')
    .select('encrypted_client_id, encrypted_refresh_token, portal_id, portal_name')
    .eq('singleton_key', 'default')
    .single()

  if (error || !data) throw new Error('Planday credentials not configured.')

  return {
    clientId:     decryptCredential(data.encrypted_client_id as string),
    refreshToken: decryptCredential(data.encrypted_refresh_token as string),
    portalId:     (data.portal_id   as string | null) ?? null,
    portalName:   (data.portal_name as string | null) ?? null,
  }
}

/** Caches portal metadata after a successful getPortal() call. */
export async function updatePlandayPortal(portalId: string, portalName: string): Promise<void> {
  const serviceClient = createServiceClient()
  await serviceClient
    .from('planday_credentials')
    .update({ portal_id: portalId, portal_name: portalName, updated_at: new Date().toISOString() })
    .eq('singleton_key', 'default')
}

/** Returns safe connection metadata for the UI. Never includes credential values. */
export async function getPlandayConnectionStatus(): Promise<PlandayConnectionStatus> {
  const serviceClient = createServiceClient()
  const { data } = await serviceClient
    .from('planday_credentials')
    .select('portal_id, portal_name')
    .eq('singleton_key', 'default')
    .single()

  if (!data) return { connected: false }
  return {
    connected:  true,
    portalId:   (data.portal_id   as string | null) ?? null,
    portalName: (data.portal_name as string | null) ?? null,
  }
}

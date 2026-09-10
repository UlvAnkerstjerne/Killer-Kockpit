/**
 * scripts/seed-kkc-delivery-baseline.ts
 *
 * One-time baseline seeder for KKC SSP/CPH delivery automation.
 *
 * Marks all EXISTING submissions as 'skipped' in report_deliveries so that
 * when the delivery cron is enabled, it only processes NEW submissions and
 * does NOT send emails for historical data.
 *
 * Run ONCE before enabling the delivery cron:
 *   npx tsx --env-file=.env.local scripts/seed-kkc-delivery-baseline.ts
 *
 * Safe to re-run — the partial unique index on (report_type, submission_key,
 * recipient) WHERE status IN ('sent', 'skipped') prevents duplicates.
 * Already-seeded rows are reported as skipped.
 *
 * Does NOT send any email.
 */

import crypto from 'crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import type { Auth } from 'googleapis'
import { fetchKKCRawData } from '../lib/google/sheets'
import { KKC_SSP_CPH_DELIVERY } from '../lib/reports/delivery-config'

// ─── Inline decrypt (same as other scripts — avoids Next.js server deps) ──────

function decryptToken(ciphertext: string): string {
  const IV_BYTES  = 12
  const TAG_BYTES = 16
  const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY!, 'hex')
  const iv  = Buffer.from(ciphertext.slice(0, IV_BYTES * 2), 'hex')
  const tag = Buffer.from(ciphertext.slice(IV_BYTES * 2, IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const enc = Buffer.from(ciphertext.slice(IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv)
  dec.setAuthTag(tag)
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8')
}

async function getOAuth2Client(): Promise<Auth.OAuth2Client> {
  const db = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
  )
  const { data: rows, error } = await db
    .from('google_oauth_tokens')
    .select('scopes, encrypted_access_token, encrypted_refresh_token, expires_at')
  if (error) throw new Error(`DB: ${error.message}`)
  const user = rows?.find(r =>
    ((r.scopes as string[]) ?? []).some((s: string) => s.includes('spreadsheets.readonly'))
  )
  if (!user) throw new Error('No user has spreadsheets.readonly scope.')
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/google/connect/callback`,
  )
  client.setCredentials({
    access_token:  decryptToken(user.encrypted_access_token as string),
    refresh_token: decryptToken(user.encrypted_refresh_token as string),
    expiry_date:   new Date(user.expires_at as string).getTime(),
    scope:         (user.scopes as string[]).join(' '),
  })
  return client
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY',
    'GOOGLE_TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_APP_URL',
  ]
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  const { reportType, recipients } = KKC_SSP_CPH_DELIVERY
  const db = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
  )

  console.log('Fetching current SSP/CPH submissions...')
  const oauthClient = await getOAuth2Client()
  const raw         = await fetchKKCRawData(oauthClient)
  const timestamps  = raw.scoresRows.map(r => r[0] ?? '').filter(Boolean)

  if (!timestamps.length) {
    console.log('No submissions found — nothing to baseline.')
    return
  }

  console.log(`Found ${timestamps.length} submission(s): ${timestamps.join(', ')}`)
  console.log(`Recipients: ${recipients.join(', ')}`)
  console.log()

  let seeded = 0
  let already = 0

  for (const submissionKey of timestamps) {
    for (const recipient of recipients) {
      // Check if a terminal row already exists
      const { data: existing, error: lookupErr } = await db
        .from('report_deliveries')
        .select('id, status')
        .eq('report_type', reportType)
        .eq('submission_key', submissionKey)
        .eq('recipient', recipient)
        .in('status', ['sent', 'skipped'])
        .maybeSingle()

      if (lookupErr) {
        console.error(`  ✗ DB lookup failed for ${submissionKey} → ${recipient}: ${lookupErr.message}`)
        continue
      }

      if (existing) {
        console.log(`  — ${submissionKey} → ${recipient}: already ${existing.status}`)
        already++
        continue
      }

      const { error: insertErr } = await db.from('report_deliveries').insert({
        report_type:    reportType,
        submission_key: submissionKey,
        recipient,
        status:         'skipped',
      })

      if (insertErr) {
        // 23505 = unique violation — concurrent run or already seeded
        if (insertErr.code === '23505') {
          console.log(`  — ${submissionKey} → ${recipient}: already seeded (concurrent)`)
          already++
        } else {
          console.error(`  ✗ Insert failed for ${submissionKey} → ${recipient}: ${insertErr.message}`)
        }
        continue
      }

      console.log(`  ✓ Baselined: ${submissionKey} → ${recipient}`)
      seeded++
    }
  }

  console.log()
  console.log(`Done. Baselined: ${seeded}  Already present: ${already}`)
  console.log('The delivery cron will now process only future submissions.')
}

main().catch(err => { console.error('✗', err.message ?? err); process.exit(1) })

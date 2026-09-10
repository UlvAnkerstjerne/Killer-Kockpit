/**
 * scripts/test-kkc-send-email.ts
 *
 * End-to-end test: fetches the most recent real SSP/CPH submission,
 * generates the PDF, and sends a report email via Resend.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-kkc-send-email.ts user@example.com
 *
 * Will report exactly what env vars / external setup is missing
 * rather than faking a send.
 */

import crypto from 'crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import type { Auth } from 'googleapis'
import { fetchKKCRawData } from '../lib/google/sheets'
import { buildSubmissionDetail } from '../lib/kkc/detail'
import { sendKKCReportEmail } from '../lib/reports/send-email'

// ─── Inline decrypt (mirrors lib/google/auth.ts, avoids Next.js server deps) ─

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
  const recipientEmail = process.argv[2]
  if (!recipientEmail || !recipientEmail.includes('@')) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/test-kkc-send-email.ts <recipient@email.com>')
    process.exit(1)
  }

  // Check all required vars upfront so we report clearly what's missing
  const sheetsVars = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'GOOGLE_TOKEN_ENCRYPTION_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'NEXT_PUBLIC_APP_URL',
  ]
  const emailVars = ['RESEND_API_KEY', 'RESEND_FROM']
  const missingSheetsVars = sheetsVars.filter(k => !process.env[k])
  const missingEmailVars  = emailVars.filter(k => !process.env[k])

  if (missingSheetsVars.length) {
    console.error(`✗ Missing sheet env vars: ${missingSheetsVars.join(', ')}`)
    process.exit(1)
  }

  if (missingEmailVars.length) {
    console.error('✗ Missing email env vars:')
    for (const k of missingEmailVars) {
      if (k === 'RESEND_API_KEY') {
        console.error(`  ${k} — Create a Resend account at resend.com and generate an API key.`)
      } else {
        console.error(`  ${k} — Verified sender address, e.g. "Killer Kockpit <kockpit@killerkebab.com>".`)
        console.error(`         The domain must be verified in the Resend dashboard before sending.`)
      }
    }
    console.error()
    console.error('Add to .env.local:')
    console.error('  RESEND_API_KEY=re_...')
    console.error('  RESEND_FROM=Killer Kockpit <kockpit@killerkebab.com>')
    process.exit(1)
  }

  // Fetch real submission
  console.log('Fetching real KKC submission...')
  const oauthClient = await getOAuth2Client()
  const raw = await fetchKKCRawData(oauthClient)
  if (!raw.scoresRows.length) { console.error('No submissions.'); process.exit(1) }

  function parseScore(v?: string): number {
    if (!v) return 0; const s = v.trim()
    if (s.endsWith('%')) return Math.round(parseFloat(s))
    const n = parseFloat(s); if (isNaN(n)) return 0
    return n >= 0 && n <= 1 ? Math.round(n * 100) : Math.round(n)
  }

  const scores = raw.scoresRows.map(r => ({
    timestamp: r[0]??'', date: r[1]??'', time: r[2]??'',
    mysteryDiner: r[3]??'', productsOrdered: r[4]??'',
    overallScore: parseScore(r[5]), criticalScore: parseScore(r[6]),
    criticalFailures: parseInt(r[7]??'0',10)||0,
  }))
  const config = raw.configRows.map(r => ({
    section: r[0]??'', checkpoint: r[1]??'',
    isCritical: /^(yes|true|1)$/i.test(r[2]??''), responseHeader: r[3]??'',
  }))
  const data = { scores, config, formHeaders: raw.formHeaders, formRows: raw.formRows, fetchedAt: new Date().toISOString() }

  const latest = scores[scores.length - 1]
  console.log(`Using: ${latest.timestamp} | ${latest.date} | Checker: ${latest.mysteryDiner} | Overall: ${latest.overallScore}%`)

  const detail = buildSubmissionDetail(data, latest.timestamp)
  if (!detail) { console.error('buildSubmissionDetail returned null.'); process.exit(1) }

  // Send
  console.log(`\nSending to ${recipientEmail} via Resend...`)
  const result = await sendKKCReportEmail({
    detail,
    recipientEmail,
    locationLabel: 'SSP / CPH Airport',
  })

  if (!result.ok) {
    console.error(`\n✗ Send failed: ${result.error}`)
    process.exit(1)
  }

  console.log(`\n✓ Email sent! Resend message ID: ${result.id}`)
  console.log(`  Subject: Killer Kuality Check — SSP / CPH Airport — ${detail.date}`)
  console.log(`  To:      ${recipientEmail}`)
}

main().catch(err => { console.error('✗', err.message ?? err); process.exit(1) })

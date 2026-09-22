/**
 * scripts/test-kkc-overview-pdf.ts
 *
 * Generates the SSP/CPH matrix overview PDF locally and writes it to
 * preview-ssp-kqc-overview.pdf in the repo root.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-kkc-overview-pdf.ts [count]
 *
 * Default count: 7 (all current reports)
 */

import { writeFileSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import type { Auth } from 'googleapis'
import { fetchKKCRawData } from '../lib/google/sheets'
import { generateSspOverviewPdf } from '../lib/reports/generate-ssp-overview-pdf'
import { buildSubmissionDetail } from '../lib/kkc/detail'
import type { KKCSspCphData } from '../lib/kkc/ssp-cph'

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
  const { data: tokenRows, error } = await db
    .from('google_oauth_tokens')
    .select('scopes, encrypted_access_token, encrypted_refresh_token, expires_at')
  if (error) throw new Error(`DB error: ${error.message}`)
  const sheetsUser = tokenRows?.find(r =>
    ((r.scopes as string[]) ?? []).some((s: string) => s.includes('spreadsheets.readonly'))
  )
  if (!sheetsUser) throw new Error('No user has spreadsheets.readonly scope')
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/google/connect/callback`,
  )
  client.setCredentials({
    access_token:  decryptToken(sheetsUser.encrypted_access_token as string),
    refresh_token: decryptToken(sheetsUser.encrypted_refresh_token as string),
    expiry_date:   new Date(sheetsUser.expires_at as string).getTime(),
    scope:         (sheetsUser.scopes as string[]).join(' '),
  })
  return client
}

function parseScore(val: string | undefined): number {
  if (!val) return 0
  const s = val.trim()
  if (s.endsWith('%')) return Math.round(parseFloat(s))
  const n = parseFloat(s)
  if (isNaN(n)) return 0
  if (n >= 0 && n <= 1) return Math.round(n * 100)
  return Math.round(n)
}

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

  const requestedCount = parseInt(process.argv[2] ?? '7', 10)

  console.log('Fetching SSP/CPH data from Google Sheets...')
  const oauthClient = await getOAuth2Client()
  const raw = await fetchKKCRawData(oauthClient)
  console.log(`Fetched: ${raw.scoresRows.length} score rows, ${raw.formRows.length} form rows, ${raw.configRows.length} checkpoints`)

  const data: KKCSspCphData = {
    scores: raw.scoresRows.filter(r => r[0]).map(row => ({
      timestamp:        row[0] ?? '',
      date:             row[1] ?? '',
      time:             row[2] ?? '',
      mysteryDiner:     row[3] ?? '',
      productsOrdered:  row[4] ?? '',
      overallScore:     parseScore(row[5]),
      criticalScore:    parseScore(row[6]),
      criticalFailures: parseInt(row[7] ?? '0', 10) || 0,
    })),
    config: raw.configRows.map(row => ({
      section:        row[0] ?? '',
      checkpoint:     row[1] ?? '',
      isCritical:     /^(yes|true|1)$/i.test(row[2] ?? ''),
      responseHeader: row[3] ?? '',
    })),
    formHeaders: raw.formHeaders,
    formRows:    raw.formRows,
    fetchedAt:   new Date().toISOString(),
  }

  const count = Math.min(requestedCount, data.scores.length)
  console.log(`\nGenerating overview PDF — last ${count} of ${data.scores.length} reports`)

  // Print per-visit comment summary to verify correctness
  const selected = data.scores.slice(-count)
  console.log('\nVisit comment summary (most recent first):')
  for (const visit of [...selected].reverse()) {
    const detail = buildSubmissionDetail(data, visit.timestamp)
    const sc = detail?.sectionComments.length ?? 0
    const oc = detail?.overallComments ? 'yes' : 'no'
    console.log(`  ${visit.date} ${visit.time.padEnd(8)}  section comments: ${sc}  overall: ${oc}`)
  }

  const buf = await generateSspOverviewPdf({ data, count, generatedAt: new Date().toISOString() })

  const outPath = path.join(__dirname, '..', 'preview-ssp-kqc-overview.pdf')
  writeFileSync(outPath, buf)

  const kb = (buf.byteLength / 1024).toFixed(1)
  if (buf.slice(0, 4).toString('ascii') !== '%PDF') {
    console.error('✗ Invalid PDF header')
    process.exit(1)
  }
  console.log(`\n✓ PDF written: ${outPath} (${kb} KB, ${count} visits)`)
  console.log('✓ Valid PDF confirmed')
  console.log('\nOpen the PDF and verify:')
  console.log('  1. Matrix pages contain all', count, 'visit columns')
  console.log('  2. Comments section appears after the matrix')
  console.log('  3. Comments match the visits listed above')
}

main().catch(err => {
  console.error('✗ Failed:', err.message ?? err)
  process.exit(1)
})

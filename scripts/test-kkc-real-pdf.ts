/**
 * scripts/test-kkc-real-pdf.ts
 *
 * Integration test: generates a PDF from a real SSP/CPH submission.
 * Uses the same buildSubmissionDetail() → generateKKCPdf() pipeline as production,
 * but calls fetchKKCRawData() directly (bypassing Next.js unstable_cache).
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/test-kkc-real-pdf.ts
 *
 * Writes /tmp/kkc-real-<timestamp>.pdf and prints field summary to stdout.
 */

import { writeFileSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import type { Auth } from 'googleapis'
import { fetchKKCRawData } from '../lib/google/sheets'
import { buildSubmissionDetail } from '../lib/kkc/detail'
import { generateKKCPdf } from '../lib/reports/generate-pdf'

// ─── Inline crypto helper ─────────────────────────────────────────────────────

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

// ─── Build OAuth2 client ──────────────────────────────────────────────────────

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
  if (!sheetsUser) {
    throw new Error('No user has the spreadsheets.readonly scope.')
  }

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'GOOGLE_TOKEN_ENCRYPTION_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'NEXT_PUBLIC_APP_URL',
  ]
  const missing = required.filter(k => !process.env[k])
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`)
    console.error('Run: npx tsx --env-file=.env.local scripts/test-kkc-real-pdf.ts')
    process.exit(1)
  }

  console.log('Fetching real KKC data from Google Sheets...')

  const oauthClient = await getOAuth2Client()
  const raw = await fetchKKCRawData(oauthClient)

  console.log(`Fetched: ${raw.scoresRows.length} submissions, ${raw.formHeaders.length} form headers, ${raw.configRows.length} checkpoints`)

  if (!raw.scoresRows.length) {
    console.error('No submissions found in Scores sheet.')
    process.exit(1)
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

  const scores = raw.scoresRows.map(row => ({
    timestamp:        row[0] ?? '',
    date:             row[1] ?? '',
    time:             row[2] ?? '',
    mysteryDiner:     row[3] ?? '',
    productsOrdered:  row[4] ?? '',
    overallScore:     parseScore(row[5]),
    criticalScore:    parseScore(row[6]),
    criticalFailures: parseInt(row[7] ?? '0', 10) || 0,
  }))

  const config = raw.configRows.map(row => ({
    section:        row[0] ?? '',
    checkpoint:     row[1] ?? '',
    isCritical:     /^(yes|true|1)$/i.test(row[2] ?? ''),
    responseHeader: row[3] ?? '',
  }))

  const data = {
    scores,
    config,
    formHeaders: raw.formHeaders,
    formRows:    raw.formRows,
    fetchedAt:   new Date().toISOString(),
  }

  // Most recent submission
  const latestScore = scores[scores.length - 1]
  console.log(`\nUsing submission: ${latestScore.timestamp}`)
  console.log(`  Date:        ${latestScore.date} ${latestScore.time}`)
  console.log(`  Checker:     ${latestScore.mysteryDiner}`)
  console.log(`  Products:    ${latestScore.productsOrdered}`)
  console.log(`  Overall:     ${latestScore.overallScore}%`)
  console.log(`  Critical:    ${latestScore.criticalScore}%`)
  console.log(`  Crit fails:  ${latestScore.criticalFailures}`)

  const detail = buildSubmissionDetail(data, latestScore.timestamp)
  if (!detail) {
    console.error('buildSubmissionDetail returned null — timestamp mismatch between Scores and Form Responses.')
    process.exit(1)
  }

  const answered = detail.checkpoints.filter(cp => cp.result !== null).length
  console.log(`\nDetail built:`)
  console.log(`  Checkpoints:   ${detail.checkpoints.length} (${answered} answered)`)
  console.log(`  Crit failures: ${detail.criticalFailureDetails.length}`)
  console.log(`  Section cmts:  ${detail.sectionComments.length}`)
  if (detail.overallComments) {
    console.log(`  Overall cmts:  "${detail.overallComments.slice(0, 70)}${detail.overallComments.length > 70 ? '…' : ''}"`)
  } else {
    console.log(`  Overall cmts:  none`)
  }

  console.log('\nGenerating PDF...')
  const buf = await generateKKCPdf(detail, 'SSP / CPH Airport', new Date().toISOString())

  const safeTs = latestScore.timestamp.replace(/[/:]/g, '-').replace(/\s+/g, '_')
  const outPath = path.join('/tmp', `kkc-real-${safeTs}.pdf`)
  writeFileSync(outPath, buf)

  const kb = (buf.byteLength / 1024).toFixed(1)
  const magic = buf.slice(0, 4).toString('ascii')
  if (magic !== '%PDF') {
    console.error(`✗ Invalid PDF header: "${magic}"`)
    process.exit(1)
  }

  console.log(`\n✓ PDF written: ${outPath} (${kb} KB)`)
  console.log(`✓ Valid PDF-${buf.slice(5, 8).toString('ascii')} confirmed`)
}

main().catch(err => {
  console.error('✗ Test failed:', err.message ?? err)
  process.exit(1)
})

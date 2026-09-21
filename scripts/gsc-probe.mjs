/**
 * scripts/gsc-probe.mjs
 *
 * Diagnostic probe: lists all Search Console properties visible to the
 * connected Google account and tests each Killer Kebab candidate with a
 * real Search Analytics query for the last 7 days.
 *
 * Run:
 *   node --env-file=.env.local scripts/gsc-probe.mjs
 *
 * Does NOT write to the database.  Read-only.
 */

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { google } from 'googleapis'

// ── Env check ─────────────────────────────────────────────────────────────────

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'GOOGLE_TOKEN_ENCRYPTION_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'NEXT_PUBLIC_APP_URL',
]

for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`)
    process.exit(1)
  }
}

// ── Inline decrypt (same AES-256-GCM scheme as lib/google/auth.ts) ────────────

function decryptToken(ciphertext) {
  const IV_BYTES  = 12
  const TAG_BYTES = 16
  const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY, 'hex')
  const iv  = Buffer.from(ciphertext.slice(0, IV_BYTES * 2), 'hex')
  const tag = Buffer.from(ciphertext.slice(IV_BYTES * 2, IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const enc = Buffer.from(ciphertext.slice(IV_BYTES * 2 + TAG_BYTES * 2), 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
  )

  // 1. Find the user with webmasters.readonly scope
  const { data: tokens, error: tokensErr } = await db
    .from('google_oauth_tokens')
    .select('user_id, scopes, google_account_email, encrypted_access_token, encrypted_refresh_token, expires_at')

  if (tokensErr || !tokens) {
    console.error('Failed to read google_oauth_tokens:', tokensErr?.message)
    process.exit(1)
  }

  const credRow = tokens.find((r) =>
    (r.scopes ?? []).some((s) => s.includes('webmasters.readonly'))
  )

  if (!credRow) {
    console.error('No user has webmasters.readonly scope. Connect Search Console OAuth first.')
    process.exit(1)
  }

  console.log(`\nCredential account: ${credRow.google_account_email}`)
  console.log(`Scopes:             ${(credRow.scopes ?? []).join(', ')}\n`)

  // 2. Build OAuth client
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/google/connect/callback`,
  )

  oauth2.setCredentials({
    access_token:  decryptToken(credRow.encrypted_access_token),
    refresh_token: decryptToken(credRow.encrypted_refresh_token),
    expiry_date:   new Date(credRow.expires_at).getTime(),
    scope:         (credRow.scopes ?? []).join(' '),
  })

  const wm = google.webmasters({ version: 'v3', auth: oauth2 })

  // 3. List all sites
  console.log('─── Listing all GSC properties visible to this account ───────────')
  let sites = []
  try {
    const { data } = await wm.sites.list()
    sites = data.siteEntry ?? []
  } catch (err) {
    console.error('sites.list() failed:', err.message)
    process.exit(1)
  }

  if (sites.length === 0) {
    console.log('No sites returned. The account may have no Search Console properties.')
    process.exit(0)
  }

  for (const site of sites) {
    console.log(`  ${site.siteUrl}  (${site.permissionLevel})`)
  }
  console.log()

  // 4. Filter to Killer Kebab candidates
  const killerKebabPattern = /killerkebab/i
  const candidates = sites.filter((s) => killerKebabPattern.test(s.siteUrl ?? ''))

  if (candidates.length === 0) {
    console.log('No killerkebab.com properties found in this account.')
    console.log('All visible sites:')
    for (const s of sites) console.log('  ', s.siteUrl)
    process.exit(0)
  }

  // 5. Test each candidate with a 7-day Search Analytics query
  const endDate   = daysAgo(3)   // respect the 3-day GSC lag
  const startDate = daysAgo(10)  // 7-day window ending 3 days ago

  console.log(`─── Search Analytics query: ${startDate} → ${endDate} (daily, date dimension) ─`)
  console.log()

  const results = []

  for (const site of candidates) {
    const siteUrl = site.siteUrl
    process.stdout.write(`Testing ${siteUrl} ... `)

    try {
      const { data } = await wm.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate,
          endDate,
          dimensions: ['date'],
          rowLimit:   100,
        },
      })

      const rows      = data.rows ?? []
      const rowCount  = rows.length
      const latestDate = rows.length > 0
        ? rows.map((r) => (r.keys ?? [])[0]).filter(Boolean).sort().at(-1)
        : null
      const totalClicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)

      console.log(`${rowCount} rows  |  latest date: ${latestDate ?? 'n/a'}  |  total clicks: ${totalClicks}`)

      results.push({ siteUrl, permissionLevel: site.permissionLevel, rowCount, latestDate, totalClicks })
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      results.push({ siteUrl, permissionLevel: site.permissionLevel, rowCount: 0, latestDate: null, error: err.message })
    }
  }

  // 6. Also explicitly test sc-domain and www variants if not already covered
  const extraCandidates = [
    'sc-domain:killerkebab.com',
    'https://killerkebab.com/',
    'https://www.killerkebab.com/',
  ].filter((u) => !candidates.some((s) => s.siteUrl === u))

  if (extraCandidates.length > 0) {
    console.log()
    console.log('─── Testing additional candidates not in sites.list() ─────────────')
    for (const siteUrl of extraCandidates) {
      process.stdout.write(`Testing ${siteUrl} ... `)
      try {
        const { data } = await wm.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate,
            endDate,
            dimensions: ['date'],
            rowLimit:   100,
          },
        })

        const rows       = data.rows ?? []
        const rowCount   = rows.length
        const latestDate = rows.length > 0
          ? rows.map((r) => (r.keys ?? [])[0]).filter(Boolean).sort().at(-1)
          : null
        const totalClicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)

        console.log(`${rowCount} rows  |  latest date: ${latestDate ?? 'n/a'}  |  total clicks: ${totalClicks}`)
        results.push({ siteUrl, permissionLevel: 'not-in-list', rowCount, latestDate, totalClicks })
      } catch (err) {
        console.log(`ERROR: ${err.message}`)
        results.push({ siteUrl, permissionLevel: 'not-in-list', rowCount: 0, latestDate: null, error: err.message })
      }
    }
  }

  // 7. Summary
  console.log()
  console.log('─── Summary ───────────────────────────────────────────────────────')
  for (const r of results) {
    const status = r.error
      ? `ERROR: ${r.error}`
      : r.rowCount > 0
        ? `✓ ${r.rowCount} rows, latest ${r.latestDate}, ${r.totalClicks} clicks`
        : `✗ 0 rows`
    console.log(`  ${r.siteUrl.padEnd(40)}  ${status}`)
  }

  const winner = results.filter((r) => r.rowCount > 0).sort((a, b) => b.rowCount - a.rowCount)[0]
  console.log()
  if (winner) {
    console.log(`RECOMMENDED SC_SITE_URL: '${winner.siteUrl}'`)
    console.log(`  → ${winner.rowCount} rows for ${startDate}–${endDate}, latest date: ${winner.latestDate}`)
  } else {
    console.log('NO PROPERTY returned current data.')
    console.log('Check OAuth token freshness or GSC property access.')
  }
  console.log()
}

main().catch((err) => {
  console.error('Probe failed:', err)
  process.exit(1)
})

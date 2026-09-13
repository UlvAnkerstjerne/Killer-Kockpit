/**
 * lib/google/gmail-search.ts
 *
 * Gmail search helper for Kockpit Brain.
 *
 * Searches a single Gmail account for messages matching a query and returns
 * structured results suitable for AI context and UI source cards.
 *
 * Security contract
 * -----------------
 * • Email bodies are cleaned server-side and truncated.  Content is ephemeral —
 *   never persisted by Kockpit.
 * • Bodies are passed to the AI as data (source material), never as instructions.
 * • The oauth client is always scoped to a single user's credentials.
 * • This module never reads or logs token values.
 */

import { google } from 'googleapis'
import type { Auth } from 'googleapis'
import { extractPlainText, buildGmailDeepLink } from './gmail'

// ─── Result type ──────────────────────────────────────────────────────────────

export interface GmailBrainResult {
  /** Gmail thread ID — used for deduplication across accounts. */
  threadId:     string
  /** Gmail message ID of the most-relevant message in the thread. */
  messageId:    string
  subject:      string
  /** Sender display string, e.g. "Alice <alice@example.com>" */
  from:         string
  /** ISO 8601 date string (YYYY-MM-DD) derived from internalDate. */
  dateIso:      string
  /** Short excerpt for UI display (≤150 chars). */
  excerpt:      string
  /** Cleaned body for AI context (≤800 chars). */
  body:         string
  /** Gmail deep link, account-aware. */
  href:         string
  /** Google account email that found this message — for UI display. */
  accountEmail: string | null
}

// ─── Body cleaning ────────────────────────────────────────────────────────────

/**
 * Strips quoted replies, email signatures, and legal footers from a plain-text
 * email body, then truncates to `maxChars`.
 *
 * The output is safe source material for the AI — it contains only the
 * original message content without forwarded threads or boilerplate.
 */
export function cleanEmailBody(raw: string, maxChars = 800): string {
  let text = raw

  // Remove lines that are quoted replies (lines starting with >)
  text = text.replace(/^>+[^\n]*\n?/gm, '')

  // Remove "On [date] [name] wrote:" attribution lines and everything after them
  // This handles the common pattern where quoted content begins
  text = text.replace(/\nOn [\s\S]{0,200}wrote:\s*\n[\s\S]*$/, '')

  // Remove signature block delimited by "-- " on its own line
  const sigIdx = text.search(/\n--\s*\n/)
  if (sigIdx !== -1) text = text.slice(0, sigIdx)

  // Remove common closing phrases and everything after
  text = text.replace(
    /\n(Best regards?|Kind regards?|Regards?|Thanks?|Thank you|Cheers?|Mvh|Med venlig hilsen|Venlig hilsen)[,.]?[\s\S]*$/i,
    '',
  )

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '…'
  }

  return text
}

/**
 * Truncates cleaned body to a short excerpt for UI display.
 */
function makeExcerpt(body: string, maxChars = 150): string {
  const oneLiner = body.replace(/\n+/g, ' ').trim()
  if (oneLiner.length <= maxChars) return oneLiner
  return oneLiner.slice(0, maxChars).trimEnd() + '…'
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function internalDateToIso(internalDate: string): string {
  const ts = Number(internalDate)
  if (!ts) return new Date().toISOString().slice(0, 10)
  return new Date(ts).toISOString().slice(0, 10)
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Searches a single Gmail account for the Brain and returns cleaned results.
 *
 * @param oauthClient   Configured OAuth2 client for one Kockpit user.
 * @param accountEmail  The google_account_email for deep-link construction.
 * @param searchQuery   Gmail search query string (e.g. `"Peter" OR "Frederiksberg" newer_than:90d`).
 * @param maxResults    Maximum messages to inspect (default 10).
 */
export async function searchGmailForBrain(
  oauthClient:  Auth.OAuth2Client,
  accountEmail: string | null,
  searchQuery:  string,
  maxResults = 10,
): Promise<GmailBrainResult[]> {
  if (!searchQuery.trim()) return []

  const gmail = google.gmail({ version: 'v1', auth: oauthClient })

  // Step 1: List matching message IDs
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          searchQuery,
    maxResults,
  })

  const messages = listRes.data.messages ?? []
  if (messages.length === 0) return []

  // Step 2: Fetch metadata + body in parallel (full format for body extraction)
  const fetched = await Promise.allSettled(
    messages.map(m =>
      gmail.users.messages.get({
        userId: 'me',
        id:     m.id!,
        format: 'full',
      }),
    ),
  )

  const results: GmailBrainResult[] = []

  for (const outcome of fetched) {
    if (outcome.status !== 'fulfilled') continue
    const msg     = outcome.value.data
    const headers = msg.payload?.headers ?? []

    function getHeader(name: string): string {
      return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
    }

    const rawBody   = msg.payload ? extractPlainText(msg.payload) : ''
    const cleanBody = cleanEmailBody(rawBody)

    results.push({
      threadId:     msg.threadId ?? msg.id ?? '',
      messageId:    msg.id ?? '',
      subject:      getHeader('Subject') || '(no subject)',
      from:         getHeader('From'),
      dateIso:      internalDateToIso(msg.internalDate ?? ''),
      excerpt:      makeExcerpt(cleanBody),
      body:         cleanBody,
      href:         buildGmailDeepLink(accountEmail, msg.id ?? ''),
      accountEmail: accountEmail,
    })
  }

  return results
}

// ─── Query builder ────────────────────────────────────────────────────────────

/**
 * Builds a Gmail search query from entity display names and keywords.
 * Returns an empty string if there's nothing to search for.
 */
export function buildGmailSearchQuery(
  entityNames: string[],
  keywords:    string[],
): string {
  const terms: string[] = []

  for (const name of entityNames.slice(0, 3)) {
    const safe = name.replace(/"/g, '').trim()
    if (safe) terms.push(`"${safe}"`)
  }

  for (const kw of keywords.slice(0, 3)) {
    const safe = kw.replace(/"/g, '').trim()
    if (safe && safe.length >= 4) terms.push(safe)
  }

  if (terms.length === 0) return ''

  return `(${terms.join(' OR ')}) newer_than:90d`
}

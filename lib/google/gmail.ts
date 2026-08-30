/**
 * lib/google/gmail.ts
 *
 * Gmail API helpers for Kockpit's inbox and provenance features.
 *
 * Design principles
 * -----------------
 * • All Gmail API calls are server-side only.  No tokens reach the browser.
 * • Email bodies are fetched on demand and returned as safe plain text.
 *   HTML is stripped server-side; dangerouslySetInnerHTML is never used.
 * • Email content is never persisted in the Kockpit database.
 *   Only provenance metadata (subject, sender, date, message ID) is stored.
 * • Gmail deep links are account-aware: the authuser= query parameter
 *   directs the user to the correct connected mailbox.
 */

import { google, gmail_v1 } from 'googleapis'
import type { Auth } from 'googleapis'

// ─── Types ────────────────────────────────────────────────────────────────

export interface GmailMessageMeta {
  messageId:    string
  threadId:     string
  subject:      string
  from:         string
  date:         string   // RFC 2822 Date header — for display only
  /** Gmail's internal receipt timestamp: epoch milliseconds as a string (e.g. "1724666400000").
   *  More reliable than the sender-controlled Date header; use this for deadline resolution. */
  internalDate: string
  snippet:      string
}

export interface GmailMessageFull extends GmailMessageMeta {
  /** Safe plain text body, never raw HTML. */
  body: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/**
 * Decodes a Gmail base64url-encoded body part.
 * Gmail uses URL-safe base64 (RFC 4648 §5) with no padding.
 */
function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8')
}

/**
 * Strips HTML tags and decodes common HTML entities.
 * Used as a safe fallback when a message has no text/plain part.
 * Never runs in the browser — this is server-side only.
 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Recursively extracts readable plain text from a Gmail message payload.
 * Prefers text/plain; falls back to stripping HTML from text/html.
 */
export function extractPlainText(payload: gmail_v1.Schema$MessagePart): string {
  // Direct text/plain
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBody(payload.body.data)
  }

  // Direct text/html (no plain alternative)
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtmlTags(decodeBody(payload.body.data))
  }

  // Multipart: scan parts in preference order
  if (payload.parts && payload.parts.length > 0) {
    // Pass 1: text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBody(part.body.data)
      }
    }
    // Pass 2: text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtmlTags(decodeBody(part.body.data))
      }
    }
    // Pass 3: recurse into nested multipart (e.g. multipart/related inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith('multipart/')) {
        const text = extractPlainText(part)
        if (text) return text
      }
    }
  }

  return ''
}

// ─── Deep link ────────────────────────────────────────────────────────────

/**
 * Builds an account-aware Gmail deep link to a specific message.
 *
 * Uses the #all/ anchor so archived messages are still reachable.
 * The authuser= query param directs multi-account users to the right mailbox.
 * If the connected email is unknown, falls back to a generic link (best-effort).
 *
 * Treat the result as best-effort provenance: the stored subject/sender/date
 * remain the durable historical record if the message is later deleted.
 */
export function buildGmailDeepLink(
  googleAccountEmail: string | null,
  messageId: string,
): string {
  const authuser = googleAccountEmail
    ? `?authuser=${encodeURIComponent(googleAccountEmail)}`
    : ''
  return `https://mail.google.com/mail/${authuser}#all/${messageId}`
}

// ─── API calls ────────────────────────────────────────────────────────────

/**
 * Lists the newest messages in the authenticated user's INBOX.
 * Returns lightweight metadata only (no bodies).
 * Fetches the INBOX label specifically — does not return all recent mail.
 *
 * @param pageToken  Gmail API nextPageToken for cursor-based pagination.
 */
export async function listInboxMessages(
  oauthClient: Auth.OAuth2Client,
  maxResults = 50,
  pageToken?: string,
): Promise<{ messages: GmailMessageMeta[]; nextPageToken: string | null }> {
  const gmail = google.gmail({ version: 'v1', auth: oauthClient })

  const listRes = await gmail.users.messages.list({
    userId:    'me',
    labelIds:  ['INBOX'],
    maxResults,
    pageToken,
  })

  const messages      = listRes.data.messages ?? []
  const nextPageToken = listRes.data.nextPageToken ?? null

  if (messages.length === 0) return { messages: [], nextPageToken }

  // Batch fetch metadata — subject, from, date headers + snippet
  const metaResults = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId:          'me',
        id:              m.id!,
        format:          'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      }),
    ),
  )

  return {
    messages: metaResults.map((res) => {
      const msg     = res.data
      const headers = msg.payload?.headers ?? []
      return {
        messageId:    msg.id!,
        threadId:     msg.threadId ?? '',
        subject:      getHeader(headers, 'Subject') || '(no subject)',
        from:         getHeader(headers, 'From'),
        date:         getHeader(headers, 'Date'),
        internalDate: msg.internalDate ?? '',
        snippet:      msg.snippet ?? '',
      }
    }),
    nextPageToken,
  }
}

/**
 * Fetches a full Gmail message and returns safe plain-text content.
 * Body is extracted server-side; HTML is stripped before returning.
 * The result is ephemeral — it is never persisted by Kockpit.
 */
export async function getMessageFull(
  oauthClient: Auth.OAuth2Client,
  messageId: string,
): Promise<GmailMessageFull | null> {
  const gmail = google.gmail({ version: 'v1', auth: oauthClient })

  const res = await gmail.users.messages.get({
    userId: 'me',
    id:     messageId,
    format: 'full',
  })

  const msg     = res.data
  const headers = msg.payload?.headers ?? []

  return {
    messageId:    msg.id!,
    threadId:     msg.threadId ?? '',
    subject:      getHeader(headers, 'Subject') || '(no subject)',
    from:         getHeader(headers, 'From'),
    date:         getHeader(headers, 'Date'),
    internalDate: msg.internalDate ?? '',
    snippet:      msg.snippet ?? '',
    body:         msg.payload ? extractPlainText(msg.payload) : '',
  }
}

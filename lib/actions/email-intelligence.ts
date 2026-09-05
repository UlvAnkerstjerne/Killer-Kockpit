'use server'

/**
 * lib/actions/email-intelligence.ts
 *
 * Server action for email action analysis (M7E-B).
 *
 * analyzeEmailForSuggestions — authenticates the caller, verifies Gmail
 * scope, re-fetches the message directly from Gmail (never trusts the
 * client-supplied body), then passes trusted server-side context to the
 * AI analyzer and returns ephemeral structured suggestions.
 *
 * Privacy contract
 * ────────────────
 * The email body is fetched server-side transiently and passed to the AI.
 * It is NEVER written to:
 *   • sources (only safe metadata goes there)
 *   • entity_sources
 *   • audit_log
 *   • proposals
 *   • any database table or persistent cache
 *
 * Errors log only type/status — never body content or evidence excerpts.
 *
 * Mailbox security
 * ────────────────
 * User identity and OAuth token are always derived from the authenticated
 * session. The caller cannot supply a mailbox user ID, source_account_user_id,
 * or another user's OAuth identity. SUPER_ADMIN has no mailbox impersonation.
 */

import { getCurrentUser } from '@/lib/auth'
import { canUseGmailInbox } from '@/lib/permissions'
import { getGoogleOAuth2Client, getGoogleConnectionStatus, hasGmailScope } from '@/lib/google/auth'
import { getMessageFull } from '@/lib/google/gmail'
import { analyzeEmail } from '@/lib/ai/analyze-email'
import type { EmailAnalysisOutput } from '@/lib/ai/email-analysis-schema'
import type { ActionResult } from '@/lib/types'

/**
 * Analyses a Gmail message and returns ephemeral action suggestions.
 *
 * @param messageId — Gmail message ID. Used only to fetch from the
 *                    authenticated user's own mailbox. The caller cannot
 *                    use this to access another user's messages.
 */
export async function analyzeEmailForSuggestions(
  messageId: string,
): Promise<ActionResult<EmailAnalysisOutput>> {
  // ── Authentication ─────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  // ── Role gate (same as inbox access) ──────────────────────────────────────
  if (!canUseGmailInbox(user.role)) {
    return { error: 'Not authorised.' }
  }

  // ── Gmail scope check ──────────────────────────────────────────────────────
  const status = await getGoogleConnectionStatus(user.id)
  if (!status.connected || !hasGmailScope(status.scopes)) {
    return { error: 'Gmail is not connected. Please connect in Settings.' }
  }

  // ── OAuth client — scoped to the authenticated user only ──────────────────
  const oauthClient = await getGoogleOAuth2Client(user.id)
  if (!oauthClient) {
    return { error: 'Google connection unavailable.' }
  }

  // ── Re-fetch message from Gmail (trusted server-side source) ───────────────
  // The body is never accepted from the browser — always fetched directly
  // via the user's own OAuth token. This prevents client-supplied crafted bodies.
  let message
  try {
    message = await getMessageFull(oauthClient, messageId)
  } catch {
    return { error: 'Could not fetch email from Gmail. Please try again.' }
  }
  if (!message) return { error: 'Email not found in Gmail.' }

  // ── Call analyzer with trusted context ────────────────────────────────────
  const result = await analyzeEmail({
    subject:         message.subject,
    from:            message.from,
    date:            message.date,
    body:            message.body,
    currentUserName: user.display_name,
    timezone:        'Europe/Copenhagen',
  })

  if (!result.ok) {
    return { error: result.error }
  }

  return { data: result.output }
}

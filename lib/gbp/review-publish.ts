import type { Auth } from 'googleapis'
import { getGoogleOAuth2Client, hasGbpScope } from '@/lib/google/auth'
import { publishGbpReviewReply } from '@/lib/google/gbp-client'
import type { GbpDb } from './state'
import type { ReviewDeskSelection, ReviewPublishResult } from './review-desk-types'

export async function getGbpPublisher(db: GbpDb): Promise<{ ok: true; client: Auth.OAuth2Client } | { ok: false; error: string }> {
  try {
    const { data, error } = await db.from('google_oauth_tokens').select('user_id,scopes').order('user_id')
    if (error) return { ok: false, error: 'Could not read the GBP connection.' }
    const owner = data?.find(row => hasGbpScope(row.scopes ?? []))?.user_id
    if (!owner) return { ok: false, error: 'No GBP-connected account found. Connect Google Business Profile first.' }
    const client = await getGoogleOAuth2Client(owner)
    if (!client) return { ok: false, error: 'GBP credentials are no longer valid. Please reconnect.' }
    return { ok: true, client }
  } catch { return { ok: false, error: 'GBP connection is unavailable. Please try again.' } }
}

const CLAIM_ERRORS = [
  'Reply not found', 'Publication pending confirmation; sync before retrying',
  'Location is not active and mapped', 'Invalid Google review identity',
  'Review is outside this Review Desk session', 'Reply is not ready for approval',
  'Reply must contain 1 to 4096 characters', 'Can only publish the approved reply text',
  'reviews_approve permission required',
]

/** Both individual and batch publication share this transition. Approval and
 * completion are separately atomic; Google writes are sequential, never retried
 * here. If local completion fails, keep the claim for sync reconciliation. */
export async function publishClaimedReply(db: GbpDb, client: Auth.OAuth2Client, actorId: string, item: ReviewDeskSelection, deskOnly: boolean): Promise<ReviewPublishResult> {
  const base = { replyId: item.replyId }
  const { data: claim, error } = await db.rpc('claim_gbp_reply_publish', {
    p_reply_id: item.replyId, p_actor_id: actorId, p_approved_text: item.approvedText, p_desk_only: deskOnly,
  })
  if (error || !claim) return { ...base, status: 'invalid', error: CLAIM_ERRORS.find(message => error?.message?.includes(message)) ?? 'Could not approve this reply. Refresh and try again.' }
  if (claim.status === 'already_published') return { ...base, status: 'already_published' }
  if (claim.status !== 'claimed' || !claim.attempt_id || !claim.google_review_id || !claim.approved_text) {
    return { ...base, status: 'confirmation_pending', error: 'Publication state needs reconciliation. Run GBP sync before retrying.' }
  }
  let result: Awaited<ReturnType<typeof publishGbpReviewReply>>
  try { result = await publishGbpReviewReply(client, claim.google_review_id, claim.approved_text) }
  catch {
    // Unknown delivery outcome: retain the claim rather than replay the write.
    return { ...base, status: 'confirmation_pending', error: 'Publication could not be confirmed. Run GBP sync before retrying.' }
  }
  const finish = () => db.rpc('finish_gbp_reply_publish', {
    p_reply_id: item.replyId, p_attempt_id: claim.attempt_id, p_actor_id: actorId,
    p_error: result.ok ? null : result.error,
  })
  try {
    let saved = await finish()
    if (saved.error) saved = await finish() // Safe local-only idempotent retry.
    if (!saved.error) return result.ok ? { ...base, status: 'published' } : { ...base, status: 'publish_failed', error: result.error }
  } catch { /* Do not lose a confirmed external success or automatically replay it. */ }
  return { ...base, status: 'confirmation_pending', error: result.ok
    ? 'Google accepted this reply, but local confirmation is pending. Run GBP sync before retrying.'
    : 'The publish result could not be saved. Run GBP sync before retrying.' }
}

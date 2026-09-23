'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { assertMarketingRead, assertReviewsApprove } from '@/lib/gbp/review-permissions'
import { getGbpPublisher, publishClaimedReply } from '@/lib/gbp/review-publish'
import { retryDraftForReview } from '@/lib/gbp/reviews-sync'
import type { ActionResult } from '@/lib/types'
import type { ReviewDeskCursor, ReviewDeskData, ReviewDeskItem, ReviewDeskSelection, ReviewPublishResult } from '@/lib/gbp/review-desk-types'

const cursorSchema = z.object({ createdAt: z.iso.datetime({ offset: true }), id: z.uuid() }).strict()
const selectionsSchema = z.array(z.object({ replyId: z.uuid(), approvedText: z.string().trim().min(1).max(4096) }).strict()).min(1).max(50)

export async function getGbpReviewDesk(cursor?: ReviewDeskCursor): Promise<ReviewDeskData> {
  const { user, error } = await assertMarketingRead()
  const empty = { reviews: [], nextCursor: null, canApprove: false }
  if (!user || error) return empty
  const parsed = cursor === undefined ? null : cursorSchema.safeParse(cursor)
  if (parsed && !parsed.success) return { ...empty, error: 'Invalid review cursor.' }
  const db = createServiceClient()
  const { data, error: loadError } = await db.rpc('get_gbp_review_desk', {
    p_user_id: user.id, p_after_created_at: parsed?.data?.createdAt ?? null, p_after_id: parsed?.data?.id ?? null,
  })
  if (loadError || !data) return { ...empty, error: 'Google Reviews could not be loaded. Please try again after the next sync or contact an administrator.' }
  const permissions = await assertReviewsApprove()
  const rows = data.reviews as ReviewDeskItem[]
  const reviews = rows.slice(0, 25)
  const last = reviews.at(-1)
  return { reviews, canApprove: !!permissions.user, nextCursor: rows.length > 25 && last ? { createdAt: last.review_created_at, id: last.id } : null }
}

export async function publishGbpReviewBatch(selections: ReviewDeskSelection[]): Promise<ActionResult<{ results: ReviewPublishResult[]; warning?: string }>> {
  const { user, error } = await assertReviewsApprove()
  if (!user || error) return { error: error ?? 'Not authenticated.' }
  const parsed = selectionsSchema.safeParse(selections)
  if (!parsed.success || new Set(parsed.data.map(item => item.replyId)).size !== parsed.data.length) {
    return { error: 'Select 1–50 different replies, each containing 1–4096 characters.' }
  }
  const db = createServiceClient()
  const publisher = await getGbpPublisher(db) // Once for the whole batch.
  if (!publisher.ok) return { error: publisher.error }
  const results: ReviewPublishResult[] = []
  for (const item of parsed.data) {
    try { results.push(await publishClaimedReply(db, publisher.client, user.id, item, true)) }
    catch { results.push({ replyId: item.replyId, status: 'confirmation_pending', error: 'Could not confirm this reply. Refresh or run GBP sync before retrying.' }) }
  }
  let warning: string | undefined
  if (results.some(row => row.status === 'published' || row.status === 'already_published')) {
    const completedAt = new Date().toISOString()
    // Monotonic even when another browser session finishes concurrently. The
    // queue still includes ALL unresolved reviews since the immutable start.
    try {
      const { error: stateError } = await db.from('gbp_review_session_state')
        .update({ last_completed_at: completedAt, updated_at: completedAt }).eq('user_id', user.id)
        .or(`last_completed_at.is.null,last_completed_at.lt.${completedAt}`)
      if (stateError) throw new Error('Session state write failed')
    } catch { warning = 'Replies were processed, but the session completion could not be saved. Unresolved reviews remain in your queue.' }
  }
  revalidatePath('/marketing')
  revalidatePath('/marketing/google-business-profile')
  return { data: { results, ...(warning ? { warning } : {}) } }
}

export async function retryGbpReviewDeskDraft(reviewId: string): Promise<ActionResult<{ reply: { id: string; draft_text: string; approved_text: string | null; status: string } }>> {
  const { user, error } = await assertReviewsApprove()
  if (!user || error) return { error: error ?? 'Not authenticated.' }
  if (!z.uuid().safeParse(reviewId).success) return { error: 'Invalid review.' }
  const db = createServiceClient()
  const { data: state } = await db.from('gbp_review_session_state').select('started_at').eq('user_id', user.id).maybeSingle()
  if (!state) return { error: 'Open Google Reviews before retrying a draft.' }
  const cutoff = new Date(Date.parse(state.started_at) - 7 * 86400_000).toISOString()
  const { data: review } = await db.from('gbp_reviews').select('id').eq('id', reviewId)
    .gte('review_created_at', cutoff).is('existing_reply_text', null).maybeSingle()
  if (!review) return { error: 'Review is outside your current queue or already answered.' }
  const result = await retryDraftForReview(reviewId)
  if (!result.ok) return { error: result.error ?? 'Could not generate the draft.' }
  const { data: reply } = await db.from('gbp_review_replies').select('id,draft_text,approved_text,status').eq('review_id', reviewId).single()
  if (!reply) return { error: 'Draft was prepared, but could not be reloaded. Refresh and try again.' }
  revalidatePath('/marketing')
  return { data: { reply } }
}

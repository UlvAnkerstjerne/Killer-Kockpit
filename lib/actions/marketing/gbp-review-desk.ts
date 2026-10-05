'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { assertMarketingRead, assertReviewsApprove } from '@/lib/gbp/review-permissions'
import { getGbpPublisher, publishClaimedReply } from '@/lib/gbp/review-publish'
import { retryDraftForReview } from '@/lib/gbp/reviews-sync'
import type { ActionResult } from '@/lib/types'
import type { ReviewDeskCursor, ReviewDeskData, ReviewDeskItem, ReviewDeskSelection, ReviewPublishResult, SavedReviewItem } from '@/lib/gbp/review-desk-types'

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

// ── Save for later ────────────────────────────────────────────────────────────

export async function saveGbpReview(reviewId: string): Promise<ActionResult<{ saved: true }>> {
  const { user, error } = await assertMarketingRead()
  if (!user || error) return { error: error ?? 'Not authenticated.' }
  if (!z.uuid().safeParse(reviewId).success) return { error: 'Invalid review.' }
  const db = createServiceClient()
  const { error: insertError } = await db.from('gbp_review_saved')
    .upsert({ user_id: user.id, review_id: reviewId }, { onConflict: 'user_id,review_id' })
  if (insertError) return { error: 'Could not save the review. Please try again.' }
  return { data: { saved: true } }
}

export async function unsaveGbpReview(reviewId: string): Promise<ActionResult<{ unsaved: true }>> {
  const { user, error } = await assertMarketingRead()
  if (!user || error) return { error: error ?? 'Not authenticated.' }
  if (!z.uuid().safeParse(reviewId).success) return { error: 'Invalid review.' }
  const db = createServiceClient()
  await db.from('gbp_review_saved').delete().eq('user_id', user.id).eq('review_id', reviewId)
  return { data: { unsaved: true } }
}

export async function dismissGbpSavedReview(reviewId: string): Promise<ActionResult<{ dismissed: true }>> {
  const { user, error } = await assertMarketingRead()
  if (!user || error) return { error: error ?? 'Not authenticated.' }
  if (!z.uuid().safeParse(reviewId).success) return { error: 'Invalid review.' }
  const db = createServiceClient()
  await db.from('gbp_review_saved').delete().eq('user_id', user.id).eq('review_id', reviewId)
  revalidatePath('/marketing')
  return { data: { dismissed: true } }
}

export async function getSavedGbpReviews(): Promise<SavedReviewItem[]> {
  const { user, error } = await assertMarketingRead()
  if (!user || error) return []
  const db = createServiceClient()
  const { data: saved } = await db.from('gbp_review_saved')
    .select('review_id, saved_at')
    .eq('user_id', user.id)
    .order('saved_at', { ascending: false })
  if (!saved || saved.length === 0) return []
  const reviewIds = saved.map((s: { review_id: string }) => s.review_id)
  const savedAtMap = new Map(saved.map((s: { review_id: string; saved_at: string }) => [s.review_id, s.saved_at]))
  const { data: reviews } = await db.from('gbp_reviews')
    .select(`
      id, reviewer_name, star_rating, review_text, review_created_at, existing_reply_text,
      location:gbp_locations!inner(store_short_name),
      reply:gbp_review_replies(id, draft_text, approved_text, status, publish_error, publish_started_at)
    `)
    .in('id', reviewIds)
  if (!reviews) return []
  return reviews.map((r: Record<string, unknown>) => {
    const loc = Array.isArray(r.location) ? r.location[0] : r.location
    const rep = Array.isArray(r.reply) ? r.reply[0] : r.reply
    return {
      id: r.id as string,
      store_short_name: (loc as Record<string, string>)?.store_short_name ?? '—',
      reviewer_name: r.reviewer_name as string | null,
      star_rating: r.star_rating as number,
      review_text: r.review_text as string | null,
      review_created_at: r.review_created_at as string,
      reply_id: (rep as Record<string, unknown>)?.id as string | null ?? null,
      draft_text: (rep as Record<string, unknown>)?.draft_text as string | null ?? null,
      approved_text: (rep as Record<string, unknown>)?.approved_text as string | null ?? null,
      status: ((rep as Record<string, unknown>)?.status as string) ?? 'new',
      publish_error: (rep as Record<string, unknown>)?.publish_error as string | null ?? null,
      publish_started_at: (rep as Record<string, unknown>)?.publish_started_at as string | null ?? null,
      new_since_session: false,
      saved_at: savedAtMap.get(r.id as string) ?? new Date().toISOString(),
    } satisfies SavedReviewItem
  }).sort((a: SavedReviewItem, b: SavedReviewItem) => b.saved_at.localeCompare(a.saved_at))
}

export async function retryGbpReviewDeskDraft(reviewId: string): Promise<ActionResult<{ reply: { id: string; draft_text: string; approved_text: string | null; status: string } }>> {
  const { user, error } = await assertReviewsApprove()
  if (!user || error) return { error: error ?? 'Not authenticated.' }
  if (!z.uuid().safeParse(reviewId).success) return { error: 'Invalid review.' }
  const db = createServiceClient()
  const { data: state } = await db.from('gbp_review_session_state').select('started_at').eq('user_id', user.id).maybeSingle()
  if (!state) return { error: 'Open Google Reviews before retrying a draft.' }
  // Allow retrying drafts for any unanswered review (no time limit)
  const cutoff = new Date(0).toISOString()
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

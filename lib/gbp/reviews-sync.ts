/** Existing review import/draft/reply policy, extracted for the GBP orchestrator.
 * No publishing occurs here; approval and reply publishing remain unchanged. */
import type { Auth } from 'googleapis'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchGbpReviewsPage, normaliseStarRating, type GbpReview } from '@/lib/google/gbp-client'
import { draftReviewReply, type ReviewReplyExample } from '@/lib/ai/draft-review-reply'
import { KILLER_KEBAB_REVIEW_REPLY_CONTEXT } from '@/lib/marketing/gbp/brand-context'
import { GbpDataError, type StoredGbpLocation } from './data'
import type { GbpDb } from './state'
import { captureReviewHealth } from './review-health'
import { loadReviewReplyExamples } from './reply-examples'

// ── Activation cutoff ──────────────────────────────────────────────────────────

const ACTIVATION_GRACE_DAYS = 7

function isWithinActivationWindow(reviewCreatedAt: string, activationDate: string): boolean {
  const reviewTs     = new Date(reviewCreatedAt).getTime()
  const activationTs = new Date(activationDate).getTime()
  const gracePeriod  = ACTIVATION_GRACE_DAYS * 24 * 60 * 60 * 1000
  return reviewTs >= activationTs - gracePeriod
}

// ── Review upsert ──────────────────────────────────────────────────────────────

async function upsertReview(
  db: ReturnType<typeof createServiceClient>,
  review: GbpReview,
  locationDbId: string,
): Promise<{ isNew: boolean; hasExistingReply: boolean }> {
  const existingReply = review.reviewReply ?? null
  const row = {
    google_review_id:          review.name,
    location_id:               locationDbId,
    reviewer_name:             review.reviewer?.displayName ?? null,
    reviewer_photo_url:        review.reviewer?.profilePhotoUrl ?? null,
    star_rating:               normaliseStarRating(review.starRating),
    review_text:               review.comment ?? null,
    review_created_at:         review.createTime,
    review_updated_at:         review.updateTime,
    existing_reply_text:       existingReply?.comment ?? null,
    existing_reply_updated_at: existingReply?.updateTime ?? null,
    synced_at:                 new Date().toISOString(),
  }

  const { data: existing, error: existingError } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .maybeSingle()
  if (existingError) throw new GbpDataError('Could not read existing GBP review.')

  const isNew = !existing

  const { error } = await db.from('gbp_reviews').upsert(row, { onConflict: 'google_review_id' })
  if (error) throw new GbpDataError('Could not save GBP review.')

  return { isNew, hasExistingReply: !!existingReply }
}

// ── Draft generation ───────────────────────────────────────────────────────────

async function generateAndStoreDraft(
  db: ReturnType<typeof createServiceClient>,
  review: GbpReview,
  storeName: string,
  examples: readonly ReviewReplyExample[],
): Promise<{ generated: boolean }> {
  // Find the review DB id
  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .single()

  if (!reviewRow) return { generated: false }

  // Establish a retryable placeholder without overwriting a concurrent manual
  // draft. The final compare-and-set also protects human edits while AI runs.
  const { error: placeholderError } = await db.from('gbp_review_replies').upsert(
    { review_id: reviewRow.id, status: 'new' }, { onConflict: 'review_id', ignoreDuplicates: true },
  )
  if (placeholderError) throw new GbpDataError('Could not save GBP draft retry state.')
  const { data: pending } = await db.from('gbp_review_replies').select('id,status').eq('review_id', reviewRow.id).single()
  if (!pending || pending.status !== 'new') return { generated: false }

  const result = await draftReviewReply({
    reviewerName: review.reviewer?.displayName ?? null,
    starRating:   normaliseStarRating(review.starRating),
    reviewText:   review.comment ?? null,
    storeName,
    brandContext: KILLER_KEBAB_REVIEW_REPLY_CONTEXT,
    examples,
  })

  if (!result.ok) {
    console.error('[gbp/sync] Review draft generation failed; retained existing retry workflow.')
    return { generated: false }
  }
  const { data: saved, error } = await db.from('gbp_review_replies').update({
    draft_text: result.draft, draft_generated_at: new Date().toISOString(),
    draft_model: result.model, draft_prompt_version: result.promptVersion, status: 'awaiting_review',
  }).eq('id', pending.id).eq('status', 'new').is('publish_attempt_id', null).select('id').maybeSingle()
  if (error) throw new GbpDataError('Could not save GBP review draft.')
  return { generated: !!saved }
}

// ── Detect externally published replies ────────────────────────────────────────
//
// If a gbp_review_replies row exists in a pending state, but the review now
// has existing_reply_text, a reply was posted outside Kockpit. Mark it.

async function detectExternalReplies(
  db: ReturnType<typeof createServiceClient>,
  review: GbpReview,
): Promise<void> {
  if (!review.reviewReply) return

  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .single()

  if (!reviewRow) return

  const { data: replyRow } = await db
    .from('gbp_review_replies')
    .select('id, status')
    .eq('review_id', reviewRow.id)
    .single()

  if (!replyRow) return

  const pendingStatuses = ['new', 'awaiting_review', 'approved', 'rejected', 'publish_failed']
  if (pendingStatuses.includes(replyRow.status)) {
    const { error } = await db
      .from('gbp_review_replies')
      .update({ status: 'externally_published', publish_attempt_id: null, publish_started_at: null, publish_error: null, updated_at: new Date().toISOString() })
      .eq('id', replyRow.id)
    if (error) throw new GbpDataError('Could not record the existing external review reply.')
  }
}

/** Backfill exhausts all pages. Incremental fetches until the previous successful
 * watermark (with a seven-day overlap), never assuming one page is sufficient. */
export async function syncLocationReviews(db: GbpDb, location: StoredGbpLocation, client: Auth.OAuth2Client, lastSuccess: string | null, checkDeadline = () => {}, progress: (reviews: number, drafts: number) => void = () => {}, examples: readonly ReviewReplyExample[] = []) {
  const capturedAt = new Date().toISOString()
  const health: { averageRating?: number; totalReviewCount?: number } = {}
  let reviewsUpserted = 0
  let draftsGenerated = 0
  let pageToken: string | undefined
  const tokens = new Set<string>()
  const { data: abandoned, error: claimError } = await db.from('gbp_review_replies')
    .select('id,review:gbp_reviews!inner(location_id)')
    .eq('review.location_id', location.id)
    .not('publish_attempt_id', 'is', null)
    .lt('publish_started_at', new Date(Date.now() - 30 * 60_000).toISOString()).limit(1)
  if (claimError) throw new GbpDataError('Could not check pending review publication.')
  // A rare interrupted write to an old review must also be reconciled; its
  // Google update time may predate the normal seven-day incremental overlap.
  const cutoff = lastSuccess && !abandoned?.length ? Date.parse(lastSuccess) - 7 * 86400_000 : null
  do {
    checkDeadline()
    const page = await fetchGbpReviewsPage(client, location.google_account_id, location.google_location_id, pageToken)
    if (health.averageRating === undefined && page.averageRating !== undefined) health.averageRating = page.averageRating
    if (health.totalReviewCount === undefined && page.totalReviewCount !== undefined) health.totalReviewCount = page.totalReviewCount
    let crossedWatermark = false
    for (const review of page.reviews) {
      checkDeadline()
      const updated = Date.parse(review.updateTime)
      if (!Number.isFinite(updated)) throw new GbpDataError('Google returned an invalid review update time.')
      if (cutoff !== null && updated < cutoff) { crossedWatermark = true; continue }
      const { isNew, hasExistingReply } = await upsertReview(db, review, location.id)
      reviewsUpserted++
      if (!hasExistingReply && abandoned?.length) {
        const { data: stored } = await db.from('gbp_reviews').select('id').eq('google_review_id', review.name).single()
        if (stored) {
          const { error } = await db.from('gbp_review_replies').update({ status: 'publish_failed', publish_attempt_id: null, publish_started_at: null,
            publish_error: 'Previous publication was interrupted. Google sync confirms no reply; review and retry.' })
            .eq('review_id', stored.id).eq('status', 'approved')
            .lt('publish_started_at', new Date(Date.now() - 30 * 60_000).toISOString())
          if (error) throw new GbpDataError('Could not reconcile interrupted review publication.')
        }
      }
      if (hasExistingReply) await detectExternalReplies(db, review)
      else if (isNew && isWithinActivationWindow(review.createTime, location.activation_date)) {
        const { generated } = await generateAndStoreDraft(db, review, location.store_name, examples)
        if (generated) draftsGenerated++
      }
      progress(reviewsUpserted, draftsGenerated)
    }
    if (crossedWatermark) break
    pageToken = page.nextPageToken
    if (pageToken && (tokens.has(pageToken) || tokens.size >= 1000)) throw new GbpDataError('GBP review pagination did not complete.')
    if (pageToken) tokens.add(pageToken)
  } while (pageToken)
  await captureReviewHealth(db, location.id, health, capturedAt)
  return { reviewsUpserted, draftsGenerated }
}

/**
 * Retries draft generation for a single review in status 'new'.
 * Called from the catch-up server action.
 */
export async function retryDraftForReview(reviewDbId: string, examples?: readonly ReviewReplyExample[]): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient()

  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id, google_review_id, reviewer_name, star_rating, review_text, location_id, existing_reply_text')
    .eq('id', reviewDbId)
    .single()

  if (!reviewRow) return { ok: false, error: 'Review not found.' }

  if (reviewRow.existing_reply_text) return { ok: false, error: 'Review is already answered.' }

  const { data: existingReply, error: replyError } = await db.from('gbp_review_replies').select('id,status,publish_attempt_id').eq('review_id', reviewDbId).maybeSingle()
  if (replyError) return { ok: false, error: 'Could not load draft state.' }
  if (existingReply && (existingReply.status !== 'new' || existingReply.publish_attempt_id)) return { ok: false, error: 'This review already has a draft or reply.' }

  const { data: locationRow } = await db
    .from('gbp_locations')
    .select('store_name,active,location_id')
    .eq('id', reviewRow.location_id)
    .single()

  if (!locationRow) return { ok: false, error: 'Location not found.' }
  if (!locationRow.active || !locationRow.location_id) return { ok: false, error: 'Location is not active and mapped.' }

  const result = await draftReviewReply({
    reviewerName: reviewRow.reviewer_name ?? null,
    starRating:   reviewRow.star_rating,
    reviewText:   reviewRow.review_text ?? null,
    storeName:    locationRow.store_name,
    brandContext: KILLER_KEBAB_REVIEW_REPLY_CONTEXT,
    examples: examples ?? await loadReviewReplyExamples(db),
  })

  if (!result.ok) return { ok: false, error: result.error }

  const draft = {
    draft_text: result.draft, draft_generated_at: new Date().toISOString(),
    draft_model: result.model, draft_prompt_version: result.promptVersion, status: 'awaiting_review',
  }
  const saved = existingReply
    ? await db.from('gbp_review_replies').update(draft).eq('id', existingReply.id).eq('status', 'new').is('publish_attempt_id', null).select('id').maybeSingle()
    : await db.from('gbp_review_replies').insert({ review_id: reviewDbId, ...draft }).select('id').single()
  if (saved.error || !saved.data) return { ok: false, error: 'Could not save draft; its state may have changed. Refresh and try again.' }
  return { ok: true }
}

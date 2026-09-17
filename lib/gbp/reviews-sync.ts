/** Existing review import/draft/reply policy, extracted for the GBP orchestrator.
 * No publishing occurs here; approval and reply publishing remain unchanged. */
import type { Auth } from 'googleapis'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchGbpReviewsPage, normaliseStarRating, type GbpReview } from '@/lib/google/gbp-client'
import { draftReviewReply } from '@/lib/ai/draft-review-reply'
import { KILLER_KEBAB_REVIEW_REPLY_CONTEXT } from '@/lib/marketing/gbp/brand-context'
import { GbpDataError, type StoredGbpLocation } from './data'
import type { GbpDb } from './state'

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
): Promise<{ generated: boolean }> {
  // Find the review DB id
  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id')
    .eq('google_review_id', review.name)
    .single()

  if (!reviewRow) return { generated: false }

  const result = await draftReviewReply({
    reviewerName: review.reviewer?.displayName ?? null,
    starRating:   normaliseStarRating(review.starRating),
    reviewText:   review.comment ?? null,
    storeName,
    brandContext: KILLER_KEBAB_REVIEW_REPLY_CONTEXT,
  })

  if (result.ok) {
    const { error } = await db.from('gbp_review_replies').upsert(
      {
        review_id:            reviewRow.id,
        draft_text:           result.draft,
        draft_generated_at:   new Date().toISOString(),
        draft_model:          result.model,
        draft_prompt_version: result.promptVersion,
        status:               'awaiting_review',
      },
      { onConflict: 'review_id' },
    )
    if (error) throw new GbpDataError('Could not save GBP review draft.')
    return { generated: true }
  } else {
    // Draft failed — create row at 'new' so next sync retries
    const { error } = await db.from('gbp_review_replies').upsert(
      {
        review_id: reviewRow.id,
        status:    'new',
      },
      { onConflict: 'review_id' },
    )
    if (error) throw new GbpDataError('Could not save GBP draft retry state.')
    console.error('[gbp/sync] Review draft generation failed; retained existing retry workflow.')
    return { generated: false }
  }
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
      .update({ status: 'externally_published', updated_at: new Date().toISOString() })
      .eq('id', replyRow.id)
    if (error) throw new GbpDataError('Could not record the existing external review reply.')
  }
}

/** Backfill exhausts all pages. Incremental fetches until the previous successful
 * watermark (with a seven-day overlap), never assuming one page is sufficient. */
export async function syncLocationReviews(db: GbpDb, location: StoredGbpLocation, client: Auth.OAuth2Client, lastSuccess: string | null, checkDeadline = () => {}, progress: (reviews: number, drafts: number) => void = () => {}) {
  let reviewsUpserted = 0
  let draftsGenerated = 0
  let pageToken: string | undefined
  const tokens = new Set<string>()
  const cutoff = lastSuccess ? Date.parse(lastSuccess) - 7 * 86400_000 : null
  do {
    checkDeadline()
    const page = await fetchGbpReviewsPage(client, location.google_account_id, location.google_location_id, pageToken)
    let crossedWatermark = false
    for (const review of page.reviews) {
      checkDeadline()
      const updated = Date.parse(review.updateTime)
      if (!Number.isFinite(updated)) throw new GbpDataError('Google returned an invalid review update time.')
      if (cutoff !== null && updated < cutoff) { crossedWatermark = true; continue }
      const { isNew, hasExistingReply } = await upsertReview(db, review, location.id)
      reviewsUpserted++
      if (hasExistingReply) await detectExternalReplies(db, review)
      else if (isNew && isWithinActivationWindow(review.createTime, location.activation_date)) {
        const { generated } = await generateAndStoreDraft(db, review, location.store_name)
        if (generated) draftsGenerated++
      }
      progress(reviewsUpserted, draftsGenerated)
    }
    if (crossedWatermark) break
    pageToken = page.nextPageToken
    if (pageToken && (tokens.has(pageToken) || tokens.size >= 1000)) throw new GbpDataError('GBP review pagination did not complete.')
    if (pageToken) tokens.add(pageToken)
  } while (pageToken)
  return { reviewsUpserted, draftsGenerated }
}

/**
 * Retries draft generation for a single review in status 'new'.
 * Called from the catch-up server action.
 */
export async function retryDraftForReview(reviewDbId: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient()

  const { data: reviewRow } = await db
    .from('gbp_reviews')
    .select('id, google_review_id, reviewer_name, star_rating, review_text, location_id')
    .eq('id', reviewDbId)
    .single()

  if (!reviewRow) return { ok: false, error: 'Review not found.' }

  const { data: locationRow } = await db
    .from('gbp_locations')
    .select('store_name')
    .eq('id', reviewRow.location_id)
    .single()

  if (!locationRow) return { ok: false, error: 'Location not found.' }

  const result = await draftReviewReply({
    reviewerName: reviewRow.reviewer_name ?? null,
    starRating:   reviewRow.star_rating,
    reviewText:   reviewRow.review_text ?? null,
    storeName:    locationRow.store_name,
    brandContext: KILLER_KEBAB_REVIEW_REPLY_CONTEXT,
  })

  if (!result.ok) return { ok: false, error: result.error }

  await db.from('gbp_review_replies').upsert(
    {
      review_id:            reviewDbId,
      draft_text:           result.draft,
      draft_generated_at:   new Date().toISOString(),
      draft_model:          result.model,
      draft_prompt_version: result.promptVersion,
      status:               'awaiting_review',
    },
    { onConflict: 'review_id' },
  )

  return { ok: true }
}

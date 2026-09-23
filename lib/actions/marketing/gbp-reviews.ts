'use server'

/**
 * lib/actions/marketing/gbp-reviews.ts
 *
 * Self-authenticating server actions for Google Business Profile review data.
 *
 * Trust-boundary contract (identical to all other Marketing server actions):
 *   - Actor identity ALWAYS comes from getCurrentUser() — never from the caller.
 *   - canAccessMarketing() and hasMarketingPermission() are checked server-side.
 *   - Callers may supply only record IDs and user-entered text (approved_text,
 *     rejection_note). They may never supply userId, role, or permissions.
 *   - All DB access uses createServiceClient() (service_role, bypasses RLS).
 *
 * Permissions:
 *   reviews_manage  — read reviews and reply state (getGbpReviews, getGbpReviewDetail)
 *   reviews_approve — approve, reject, publish (approveGbpReply, rejectGbpReply, publishGbpReply)
 *   SUPER_ADMIN     — bypasses permission checks; also required for triggerGbpSync
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { assertMarketingRead, assertReviewsApprove } from '@/lib/gbp/review-permissions'
import { getGbpPublisher, publishClaimedReply } from '@/lib/gbp/review-publish'
import { revalidatePath } from 'next/cache'
import { hasGbpScope } from '@/lib/google/auth'
import { runGbpSync } from '@/lib/gbp/sync'
import type { ActionResult } from '@/lib/types'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GbpLocationRow {
  id:               string
  store_name:       string
  store_short_name: string
  address_summary:  string | null
  activation_date:  string
  active:           boolean
}

export interface GbpReviewRow {
  id:                        string
  google_review_id:          string
  location_id:               string
  reviewer_name:             string | null
  reviewer_photo_url:        string | null
  star_rating:               number
  review_text:               string | null
  review_created_at:         string
  review_updated_at:         string
  existing_reply_text:       string | null
  existing_reply_updated_at: string | null
  location?:                 Pick<GbpLocationRow, 'store_name' | 'store_short_name'>
  reply?:                    GbpReplyRow | null
}

export interface GbpReplyRow {
  id:                   string
  review_id:            string
  draft_text:           string | null
  draft_generated_at:   string | null
  draft_model:          string | null
  draft_prompt_version: string | null
  status:               string
  approved_text:        string | null
  approved_by_user_id:  string | null
  approved_at:          string | null
  rejection_note:       string | null
  rejected_by_user_id:  string | null
  rejected_at:          string | null
  published_at:         string | null
  publish_error:        string | null
}

export interface GbpStoreReviewSummary {
  gbpLocationId:  string
  storeShortName: string
  newReviews7d:   number | null
  unanswered:     number | null
  avgRating:      number | null
}

export interface GbpSyncStatus {
  integration:     string
  status:          string
  last_success_at: string | null
  last_attempt_at: string | null
  last_error:      string | null
}

// ── getGbpLocations ────────────────────────────────────────────────────────────

export async function getGbpLocations(): Promise<GbpLocationRow[]> {
  const { user, error } = await assertMarketingRead()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('gbp_locations')
    .select('id, store_name, store_short_name, address_summary, activation_date, active')
    .eq('active', true)
    .order('store_name')

  return (data ?? []) as GbpLocationRow[]
}

// ── getGbpReviews ──────────────────────────────────────────────────────────────

export async function getGbpReviews(
  locationId?: string,
  statusFilter?: string,
): Promise<GbpReviewRow[]> {
  const { user, error } = await assertMarketingRead()
  if (error || !user) return []

  const db = createServiceClient()

  let query = db
    .from('gbp_reviews')
    .select(`
      id, google_review_id, location_id, reviewer_name, reviewer_photo_url,
      star_rating, review_text, review_created_at, review_updated_at,
      existing_reply_text, existing_reply_updated_at,
      location:gbp_locations(store_name, store_short_name),
      reply:gbp_review_replies(
        id, review_id, draft_text, draft_generated_at, draft_model,
        draft_prompt_version, status, approved_text, approved_by_user_id,
        approved_at, rejection_note, rejected_by_user_id, rejected_at,
        published_at, publish_error
      )
    `)
    .order('review_created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)

  if (statusFilter) {
    // Filter by reply status
    query = query.eq('reply.status', statusFilter)
  }

  const { data } = await query
  return (data ?? []) as unknown as GbpReviewRow[]
}

// ── getGbpReviewDetail ─────────────────────────────────────────────────────────

export async function getGbpReviewDetail(
  replyId: string,
): Promise<GbpReviewRow | null> {
  const { user, error } = await assertMarketingRead()
  if (error || !user) return null

  const db = createServiceClient()

  // Find review via reply ID
  const { data: replyRow } = await db
    .from('gbp_review_replies')
    .select('review_id')
    .eq('id', replyId)
    .single()

  if (!replyRow) return null

  const { data } = await db
    .from('gbp_reviews')
    .select(`
      id, google_review_id, location_id, reviewer_name, reviewer_photo_url,
      star_rating, review_text, review_created_at, review_updated_at,
      existing_reply_text, existing_reply_updated_at,
      location:gbp_locations(store_name, store_short_name, address_summary),
      reply:gbp_review_replies(
        id, review_id, draft_text, draft_generated_at, draft_model,
        draft_prompt_version, status, approved_text, approved_by_user_id,
        approved_at, rejection_note, rejected_by_user_id, rejected_at,
        published_at, publish_error
      )
    `)
    .eq('id', replyRow.review_id)
    .single()

  return data as unknown as GbpReviewRow | null
}

// ── approveGbpReply ────────────────────────────────────────────────────────────

export async function approveGbpReply(
  replyId: string,
  approvedText: string,
): Promise<ActionResult<{ status: 'approved' }>> {
  const { user, error } = await assertReviewsApprove()
  if (error || !user) return { error: error ?? 'Not authenticated.' }

  if (!approvedText.trim()) return { error: 'Approved text cannot be empty.' }

  const db = createServiceClient()

  const { data: existing } = await db
    .from('gbp_review_replies')
    .select('id, status')
    .eq('id', replyId)
    .single()

  if (!existing) return { error: 'Reply not found.' }
  if (!['awaiting_review', 'rejected', 'publish_failed'].includes(existing.status)) {
    return { error: `Cannot approve a reply in status '${existing.status}'.` }
  }

  const { data: updatedReply, error: updateError } = await db
    .from('gbp_review_replies')
    .update({
      status:              'approved',
      approved_text:       approvedText.trim(),
      approved_by_user_id: user.id,
      approved_at:         new Date().toISOString(),
      rejection_note:      null,
      rejected_by_user_id: null,
      rejected_at:         null,
      publish_error:       null,
    })
    .eq('id', replyId)
    .is('publish_attempt_id', null)
    .eq('status', existing.status)
    .select('id').maybeSingle()

  if (updateError || !updatedReply) {
    console.error('[approveGbpReply]', updateError)
    return { error: 'Failed to approve reply. Please try again.' }
  }

  // Audit
  await db.from('audit_events').insert({
    actor_user_id: user.id,
    actor_type:    'human',
    action:        'marketing.gbp_reply.approved',
    entity_type:   'gbp_review_reply',
    entity_id:     replyId,
    after_json:    { approved_text: approvedText.trim() },
  })

  return { data: { status: 'approved' } }
}

// ── rejectGbpReply ─────────────────────────────────────────────────────────────

export async function rejectGbpReply(
  replyId: string,
  rejectionNote: string,
): Promise<ActionResult<{ status: 'rejected' }>> {
  const { user, error } = await assertReviewsApprove()
  if (error || !user) return { error: error ?? 'Not authenticated.' }

  const db = createServiceClient()

  const { data: existing } = await db
    .from('gbp_review_replies')
    .select('id, status')
    .eq('id', replyId)
    .single()

  if (!existing) return { error: 'Reply not found.' }
  if (!['awaiting_review', 'approved'].includes(existing.status)) {
    return { error: `Cannot reject a reply in status '${existing.status}'.` }
  }

  const { data: updatedReply, error: updateError } = await db
    .from('gbp_review_replies')
    .update({
      status:              'rejected',
      rejection_note:      rejectionNote.trim() || null,
      rejected_by_user_id: user.id,
      rejected_at:         new Date().toISOString(),
    })
    .eq('id', replyId)
    .is('publish_attempt_id', null)
    .eq('status', existing.status)
    .select('id').maybeSingle()

  if (updateError || !updatedReply) {
    console.error('[rejectGbpReply]', updateError)
    return { error: 'Failed to reject reply. Please try again.' }
  }

  await db.from('audit_events').insert({
    actor_user_id: user.id,
    actor_type:    'human',
    action:        'marketing.gbp_reply.rejected',
    entity_type:   'gbp_review_reply',
    entity_id:     replyId,
    after_json:    { rejection_note: rejectionNote.trim() || null },
  })

  return { data: { status: 'rejected' } }
}

// ── publishGbpReply ────────────────────────────────────────────────────────────

export async function publishGbpReply(
  replyId: string,
): Promise<ActionResult<{ status: 'published' | 'publish_failed' }>> {
  const { user, error } = await assertReviewsApprove()
  if (error || !user) return { error: error ?? 'Not authenticated.' }

  const db = createServiceClient()

  const { data: replyRow } = await db.from('gbp_review_replies')
    .select('id,status,approved_text').eq('id', replyId).single()
  if (!replyRow) return { error: 'Reply not found.' }
  if (replyRow.status !== 'approved') return { error: `Can only publish approved replies. Current status: '${replyRow.status}'.` }
  if (!replyRow.approved_text) return { error: 'No approved text to publish.' }
  const publisher = await getGbpPublisher(db)
  if (!publisher.ok) return { error: publisher.error }
  const result = await publishClaimedReply(db, publisher.client, user.id, { replyId, approvedText: replyRow.approved_text }, false)
  revalidatePath('/marketing')
  revalidatePath('/marketing/google-business-profile')
  if (result.status === 'published' || result.status === 'already_published') return { data: { status: 'published' } }
  if (result.status === 'publish_failed') return { data: { status: 'publish_failed' } }
  return { error: result.error ?? 'Could not publish reply.' }
}

// ── getGbpStoreReviewSummary ───────────────────────────────────────────────────
// Review-health snapshot for the six core stores (excludes Parken).

const EXCLUDED_SHORT_NAMES = ['Parken']

export async function getGbpStoreReviewSummary(): Promise<GbpStoreReviewSummary[]> {
  const { error } = await assertMarketingRead()
  if (error) return []

  const db = createServiceClient()

  // Active locations excluding non-core stores
  const { data: locations } = await db
    .from('gbp_locations')
    .select('id, store_short_name')
    .eq('active', true)
    .order('store_name')
  const coreLocations = (locations ?? []).filter(
    (l: { id: string; store_short_name: string }) => !EXCLUDED_SHORT_NAMES.includes(l.store_short_name),
  )
  if (coreLocations.length === 0) return []

  // One indexed latest-row lookup per core location. Missing snapshots display
  // as unavailable until sync, without a permanent review-history fallback.
  return Promise.all(coreLocations.map(async (loc: { id: string; store_short_name: string }) => {
    const { data, error } = await db.from('gbp_review_health_daily')
      .select('average_rating,new_reviews_7d,unanswered_count')
      .eq('location_id', loc.id)
      .order('snapshot_date', { ascending: false })
      .limit(1).maybeSingle()
    return {
      gbpLocationId: loc.id,
      storeShortName: loc.store_short_name,
      newReviews7d: error ? null : data?.new_reviews_7d ?? null,
      unanswered: error ? null : data?.unanswered_count ?? null,
      avgRating: error || data?.average_rating == null ? null : Number(data.average_rating),
    }
  }))
}

// ── getGbpSyncStatus ───────────────────────────────────────────────────────────

export async function getGbpSyncStatus(): Promise<GbpSyncStatus[]> {
  const { user, error } = await assertMarketingRead()
  if (error || !user) return []

  const db = createServiceClient()
  const { data } = await db
    .from('integration_sync_state')
    .select('integration, status, last_success_at, last_attempt_at, last_error')
    .like('integration', 'gbp_%')
    .order('integration')

  return (data ?? []) as GbpSyncStatus[]
}

// ── triggerGbpSync ─────────────────────────────────────────────────────────────
// SUPER_ADMIN only. Useful for manual validation before cron is set up.

export async function triggerGbpSync(): Promise<ActionResult<{ summary: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }
  if (user.role !== 'SUPER_ADMIN') return { error: 'Only SUPER_ADMIN can trigger a manual sync.' }

  const db = createServiceClient()
  const { data: tokenRows } = await db
    .from('google_oauth_tokens')
    .select('user_id, scopes')

  const syncUserId = tokenRows?.find(
    (row) => hasGbpScope((row.scopes as string[]) ?? [])
  )?.user_id as string | undefined

  if (!syncUserId) {
    return { error: 'No GBP-connected account found. Visit /api/google/connect/gbp to connect.' }
  }

  const result = await runGbpSync(syncUserId)
  if (result.skipped) return { data: { summary: 'GBP sync is already running.' } }
  if (!result.ok) return { error: [...result.errors, ...result.locations.flatMap(location => location.errors)].join('; ') || 'GBP sync did not complete.' }
  return {
    data: {
      summary: `Sync complete: ${result.totalOk} location(s) succeeded, ${result.totalFail} failed.`,
    },
  }
}

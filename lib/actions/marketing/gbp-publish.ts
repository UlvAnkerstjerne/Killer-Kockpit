'use server'

/**
 * lib/actions/marketing/gbp-publish.ts
 *
 * Server action for publishing a post or photo to multiple GBP locations.
 *
 * Trust-boundary contract:
 *   - Actor identity comes from getCurrentUser() — never from the caller.
 *   - Location IDs are resolved from the trusted gbp_locations table.
 *   - Browser-supplied location IDs are validated against DB rows.
 *   - OAuth client is obtained server-side via getGbpPublisher.
 *   - All DB access uses createServiceClient (service_role, bypasses RLS).
 *
 * Permission: content_manage (narrowest existing permission for content creation).
 * SUPER_ADMIN bypasses all checks.
 */

import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { getGbpPublisher } from '@/lib/gbp/review-publish'
import { createLocalPost, createLocationMedia } from '@/lib/google/gbp-client'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GbpPublishInput {
  postType: 'local_post' | 'photo'
  caption?: string
  imageStoragePath: string
  imagePublicUrl: string
  imageMimeType: string
  /** Location IDs to publish to. Empty = validation error (caught client-side). */
  locationIds: string[]
}

export interface GbpLocationResult {
  locationId: string
  locationName: string
  status: 'success' | 'failed'
  error?: string
  googleResourceName?: string
}

export interface GbpPublishResult {
  ok: boolean
  total: number
  succeeded: number
  failed: number
  locations: GbpLocationResult[]
  error?: string
}

// ── Validation ──────────────────────────────────────────────────────────────────

const MAX_CAPTION_LENGTH = 1500
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function validateInput(input: GbpPublishInput): string | null {
  if (!['local_post', 'photo'].includes(input.postType)) return 'Invalid post type.'
  if (!input.imageStoragePath || !input.imagePublicUrl) return 'Image is required.'
  if (!ALLOWED_MIME_TYPES.has(input.imageMimeType)) return 'Image must be JPEG, PNG, or WebP.'
  if (!input.locationIds.length) return 'At least one location must be selected.'
  if (input.postType === 'local_post') {
    if (!input.caption?.trim()) return 'Caption is required for post updates.'
    if (input.caption.length > MAX_CAPTION_LENGTH) return `Caption must be under ${MAX_CAPTION_LENGTH} characters.`
  }
  return null
}

// ── Main action ─────────────────────────────────────────────────────────────────

export async function publishGbpPost(input: GbpPublishInput): Promise<GbpPublishResult> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: 'Not authenticated.' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: 'Marketing access required.' }
  }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'content_manage')) {
    return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: 'content_manage permission required.' }
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const validationError = validateInput(input)
  if (validationError) {
    return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: validationError }
  }

  // ── Resolve trusted locations ─────────────────────────────────────────────
  const db = createServiceClient()
  const { data: allLocations, error: locError } = await db
    .from('gbp_locations')
    .select('id, google_account_id, google_location_id, store_name')
    .eq('active', true)
    .in('id', input.locationIds)

  if (locError || !allLocations) {
    return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: 'Could not resolve locations.' }
  }

  if (!allLocations.length) {
    return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: 'No valid active locations selected.' }
  }

  // ── Get GBP OAuth client ──────────────────────────────────────────────────
  const publisher = await getGbpPublisher(db)
  if (!publisher.ok) {
    return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: publisher.error }
  }

  // ── For photo uploads, read the image bytes once ──────────────────────────
  let imageBytes: Buffer | null = null
  if (input.postType === 'photo') {
    try {
      const { data: fileData, error: dlError } = await db.storage
        .from('gbp-media')
        .download(input.imageStoragePath)
      if (dlError || !fileData) throw new Error(dlError?.message ?? 'Download failed')
      imageBytes = Buffer.from(await fileData.arrayBuffer())
    } catch (err) {
      return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error: 'Could not read uploaded image.' }
    }
  }

  // ── Fanout to each location ───────────────────────────────────────────────
  const results: GbpLocationResult[] = []

  for (const loc of allLocations) {
    const accountId = loc.google_account_id as string
    const locationId = loc.google_location_id as string
    const locationName = loc.store_name as string

    try {
      if (input.postType === 'local_post') {
        const result = await createLocalPost(
          publisher.client,
          accountId,
          locationId,
          input.caption!,
          input.imagePublicUrl,
        )
        if (result.ok) {
          results.push({ locationId: loc.id as string, locationName, status: 'success', googleResourceName: result.data.name })
        } else {
          results.push({ locationId: loc.id as string, locationName, status: 'failed', error: result.error })
        }
      } else {
        const result = await createLocationMedia(
          publisher.client,
          accountId,
          locationId,
          imageBytes!,
          input.imageMimeType,
        )
        if (result.ok) {
          results.push({ locationId: loc.id as string, locationName, status: 'success', googleResourceName: result.data.name })
        } else {
          results.push({ locationId: loc.id as string, locationName, status: 'failed', error: result.error })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      results.push({ locationId: loc.id as string, locationName, status: 'failed', error: message })
    }
  }

  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.filter(r => r.status === 'failed').length

  // ── Persist publish record ────────────────────────────────────────────────
  try {
    await db.from('gbp_posts').insert({
      publisher_user_id: user.id,
      post_type: input.postType,
      caption: input.caption?.trim() || null,
      image_storage_path: input.imageStoragePath,
      image_public_url: input.imagePublicUrl,
      locations_attempted: allLocations.length,
      locations_succeeded: succeeded,
      locations_failed: failed,
      location_results: results,
    })
  } catch (err) {
    console.error('[gbp-publish] Failed to persist publish record:', (err as Error).message)
    // Non-fatal — the publish itself succeeded/failed independently.
  }

  return {
    ok: succeeded > 0,
    total: allLocations.length,
    succeeded,
    failed,
    locations: results,
  }
}

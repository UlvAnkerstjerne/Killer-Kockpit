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
 *   - The browser supplies ONLY imageStoragePath (no URL or MIME).
 *     The server resolves the public URL and validates MIME from the
 *     storage object itself. The path must be user-bound (posts/{userId}/...)
 *     and the authenticated user must own it.
 *   - OAuth client is obtained server-side via getGbpPublisher.
 *   - All DB access uses createServiceClient (service_role, bypasses RLS).
 *
 * Idempotency:
 *   - Client generates a requestId (UUID) per publish attempt.
 *   - Server atomically claims the requestId via unique constraint BEFORE
 *     calling Google. A duplicate request while running returns "in progress".
 *     A retry after completion returns the stored result.
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
  /** Server-generated storage path from the upload route. User-bound: posts/{userId}/{uuid}.ext */
  imageStoragePath: string
  /** Client-generated idempotency key. Same UUID must be reused on retry. */
  requestId: string
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateInput(input: GbpPublishInput): string | null {
  if (!['local_post', 'photo'].includes(input.postType)) return 'Invalid post type.'
  if (!input.imageStoragePath) return 'Image is required.'
  if (!input.requestId || !UUID_RE.test(input.requestId)) return 'Invalid request ID.'
  if (!input.locationIds.length) return 'At least one location must be selected.'
  if (input.postType === 'local_post') {
    if (!input.caption?.trim()) return 'Caption is required for post updates.'
    if (input.caption.length > MAX_CAPTION_LENGTH) return `Caption must be under ${MAX_CAPTION_LENGTH} characters.`
  }
  return null
}

/** Verify the storage path is user-bound and belongs to the authenticated user. */
function validateStoragePath(path: string, userId: string): string | null {
  // Expected format: posts/{userId}/{uuid}.{ext}
  const parts = path.split('/')
  if (parts.length !== 3 || parts[0] !== 'posts') return 'Invalid image reference.'
  if (parts[1] !== userId) return 'Image does not belong to this user.'
  if (!/^[0-9a-f-]+\.(jpg|png|webp)$/.test(parts[2])) return 'Invalid image reference.'
  return null
}

/** Map storage file extension to MIME type. */
function mimeFromPath(path: string): string {
  if (path.endsWith('.jpg')) return 'image/jpeg'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyResult(error: string): GbpPublishResult {
  return { ok: false, total: 0, succeeded: 0, failed: 0, locations: [], error }
}

// ── Main action ─────────────────────────────────────────────────────────────────

export async function publishGbpPost(input: GbpPublishInput): Promise<GbpPublishResult> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return emptyResult('Not authenticated.')
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return emptyResult('Marketing access required.')
  }
  const permissions = await getUserMarketingPermissions(user.id)
  if (!hasMarketingPermission(user.role, permissions, 'content_manage')) {
    return emptyResult('content_manage permission required.')
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const validationError = validateInput(input)
  if (validationError) return emptyResult(validationError)

  // ── Validate storage path ownership ───────────────────────────────────────
  const pathError = validateStoragePath(input.imageStoragePath, user.id)
  if (pathError) return emptyResult(pathError)

  // ── Resolve MIME from trusted path ────────────────────────────────────────
  const mimeType = mimeFromPath(input.imageStoragePath)
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return emptyResult('Invalid image type.')

  const db = createServiceClient()

  // ── Idempotency: atomic claim ─────────────────────────────────────────────
  // Try to insert a pending record with this request_id. The unique constraint
  // on request_id prevents a second execution from proceeding.
  const { data: existingPost, error: lookupError } = await db
    .from('gbp_posts')
    .select('id, status, locations_succeeded, locations_failed, locations_attempted, location_results')
    .eq('request_id', input.requestId)
    .maybeSingle()

  if (lookupError) return emptyResult('Could not check publish status.')

  if (existingPost) {
    const status = existingPost.status as string
    if (status === 'publishing') {
      return emptyResult('Publish already in progress.')
    }
    // Already completed — return stored result
    const storedResults = (existingPost.location_results ?? []) as GbpLocationResult[]
    const succeeded = existingPost.locations_succeeded as number
    return {
      ok: succeeded > 0,
      total: existingPost.locations_attempted as number,
      succeeded,
      failed: existingPost.locations_failed as number,
      locations: storedResults,
    }
  }

  // ── Resolve public URL server-side ────────────────────────────────────────
  const { data: publicUrlData } = db.storage
    .from('gbp-media')
    .getPublicUrl(input.imageStoragePath)
  const imagePublicUrl = publicUrlData.publicUrl

  // ── Insert pending record (idempotency claim) ─────────────────────────────
  const { error: claimError } = await db.from('gbp_posts').insert({
    publisher_user_id: user.id,
    request_id: input.requestId,
    status: 'publishing',
    post_type: input.postType,
    caption: input.caption?.trim() || null,
    image_storage_path: input.imageStoragePath,
    image_public_url: imagePublicUrl,
    locations_attempted: 0,
    locations_succeeded: 0,
    locations_failed: 0,
    location_results: [],
  })

  if (claimError) {
    // Unique constraint race: another request claimed this ID between our SELECT and INSERT
    if (claimError.code === '23505') return emptyResult('Publish already in progress.')
    return emptyResult('Could not start publish.')
  }

  // ── Resolve trusted locations ─────────────────────────────────────────────
  const { data: allLocations, error: locError } = await db
    .from('gbp_locations')
    .select('id, google_account_id, google_location_id, store_name')
    .eq('active', true)
    .in('id', input.locationIds)

  if (locError || !allLocations || !allLocations.length) {
    await db.from('gbp_posts').update({ status: 'failed' }).eq('request_id', input.requestId)
    return emptyResult(locError ? 'Could not resolve locations.' : 'No valid active locations selected.')
  }

  // ── Get GBP OAuth client ──────────────────────────────────────────────────
  const publisher = await getGbpPublisher(db)
  if (!publisher.ok) {
    await db.from('gbp_posts').update({ status: 'failed' }).eq('request_id', input.requestId)
    return emptyResult(publisher.error)
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
    } catch {
      await db.from('gbp_posts').update({ status: 'failed' }).eq('request_id', input.requestId)
      return emptyResult('Could not read uploaded image.')
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
          imagePublicUrl,
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
          mimeType,
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

  // ── Finalize publish record ───────────────────────────────────────────────
  try {
    await db.from('gbp_posts').update({
      status: 'completed',
      locations_attempted: allLocations.length,
      locations_succeeded: succeeded,
      locations_failed: failed,
      location_results: results,
    }).eq('request_id', input.requestId)
  } catch (err) {
    console.error('[gbp-publish] Failed to finalize publish record:', (err as Error).message)
  }

  return {
    ok: succeeded > 0,
    total: allLocations.length,
    succeeded,
    failed,
    locations: results,
  }
}

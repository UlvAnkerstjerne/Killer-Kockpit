/**
 * lib/brain/reviews.ts
 *
 * Brain GBP Review retrieval layer.
 *
 * fetchBrainReviewContext({ locationNames, maxPerLocation? })
 * ────────────────────────────────────────────────────────────
 * Retrieves recent Google Business Profile reviews for locations that
 * match the given names. Grouped by location with aggregate stats.
 *
 * Data authority: UNTRUSTED external input (customer-written text).
 * The AI system prompt enforces that review text is treated as
 * external source material, never as instructions.
 *
 * Security:
 *  - Uses createServiceClient (Brain is management-gated at the action layer).
 *  - Review text is explicitly marked untrusted in the AI prompt.
 *  - Caps results to prevent context bloat.
 */

import { createServiceClient } from '@/lib/supabase/server'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BrainReviewItem {
  id:           string
  starRating:   number
  reviewText:   string | null   // raw customer text — UNTRUSTED
  reviewDate:   string          // YYYY-MM-DD
  hasReply:     boolean
  replyStatus:  string | null   // 'awaiting_review' | 'approved' | 'published' | 'rejected'
  replyText:    string | null   // approved/published reply text (Kockpit-authored)
}

export interface BrainLocationReviewGroup {
  locationName:      string
  locationShortName: string | null
  avgStarRating:     number | null
  pendingReplyCount: number
  reviews:           BrainReviewItem[]
}

export interface BrainReviewContext {
  locations: BrainLocationReviewGroup[]
}

// ─── fetchBrainReviewContext ──────────────────────────────────────────────────

/**
 * Fetches recent GBP reviews for locations matching the given names.
 *
 * Location matching uses ILIKE against gbp_locations.store_name and
 * store_short_name — the Brain doesn't have a direct FK link between
 * the Kockpit locations table and gbp_locations.
 *
 * @param locationNames  Kockpit location names to match (e.g. "Frederiksberg")
 * @param maxPerLocation Maximum reviews per location (default: 15)
 */
export async function fetchBrainReviewContext({
  locationNames,
  maxPerLocation = 15,
}: {
  locationNames:   string[]
  maxPerLocation?: number
}): Promise<BrainReviewContext> {
  if (locationNames.length === 0) {
    return { locations: [] }
  }

  try {
    const db = createServiceClient()

    // ── Find matching GBP locations ──────────────────────────────────────────
    // Build OR filter: store_name ILIKE '%name%' for each location name
    const nameFilter = locationNames
      .map(n => `store_name.ilike.%${n}%,store_short_name.ilike.%${n}%`)
      .join(',')

    const { data: gbpLocations, error: locErr } = await db
      .from('gbp_locations')
      .select('id, store_name, store_short_name')
      .or(nameFilter)
      .eq('active', true)

    if (locErr || !gbpLocations || gbpLocations.length === 0) {
      return { locations: [] }
    }

    // ── Fetch reviews for each matching GBP location ─────────────────────────
    const locationGroups: BrainLocationReviewGroup[] = []

    await Promise.all(
      gbpLocations.map(async (loc) => {
        const { data: reviews, error: revErr } = await db
          .from('gbp_reviews')
          .select(`
            id,
            star_rating,
            review_text,
            review_created_at,
            existing_reply_text,
            reply:gbp_review_replies(status, approved_text, published_at)
          `)
          .eq('location_id', loc.id)
          .order('review_created_at', { ascending: false })
          .limit(maxPerLocation)

        if (revErr || !reviews) return

        const items: BrainReviewItem[] = reviews.map(r => {
          const replyRaw = Array.isArray(r.reply) ? r.reply[0] : r.reply
          const hasReply = !!r.existing_reply_text || (replyRaw?.status === 'published')
          const replyStatus = replyRaw?.status ?? null
          // Prefer existing_reply_text (synced from Google) as the canonical reply
          const replyText = r.existing_reply_text ?? replyRaw?.approved_text ?? null

          return {
            id:          r.id,
            starRating:  r.star_rating,
            reviewText:  r.review_text ? r.review_text.slice(0, 400) : null,
            reviewDate:  r.review_created_at.slice(0, 10),
            hasReply,
            replyStatus,
            replyText:   replyText ? replyText.slice(0, 200) : null,
          }
        })

        // Aggregate stats
        const rated = items.filter(r => r.starRating > 0)
        const avgStarRating = rated.length > 0
          ? Math.round((rated.reduce((s, r) => s + r.starRating, 0) / rated.length) * 10) / 10
          : null

        const pendingReplyCount = items.filter(
          r => !r.hasReply || r.replyStatus === 'awaiting_review',
        ).length

        locationGroups.push({
          locationName:      loc.store_name,
          locationShortName: loc.store_short_name ?? null,
          avgStarRating,
          pendingReplyCount,
          reviews:           items,
        })
      })
    )

    // Sort groups by location name for deterministic output
    locationGroups.sort((a, b) => a.locationName.localeCompare(b.locationName))

    return { locations: locationGroups }
  } catch (err) {
    console.error('[brain/reviews] fetchBrainReviewContext failed:', (err as Error).message)
    return { locations: [] }
  }
}

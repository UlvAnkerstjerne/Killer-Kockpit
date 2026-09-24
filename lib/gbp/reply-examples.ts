import type { ReviewReplyExample } from '@/lib/ai/draft-review-reply'
import type { GbpDb } from './state'

// Resolved only by server-side sync/draft workflows. Approval FKs reference
// app_users.id, not auth.users.id; match the existing email-based actor lookup.
const VOICE_APPROVER_EMAIL = 'ulv@killerkebab.com'
const MIN_VOICE_EXAMPLES = 2

/** Resolve Ulv once per sync/run, then reuse one bounded example set for all
 * drafts. Prefer his edits within his 24 most recent approvals (last 90 days).
 * Insufficient examples leave the base brand context unchanged. */
export async function loadReviewReplyExamples(db: GbpDb, now = new Date()): Promise<ReviewReplyExample[]> {
  try {
    const { data: ulv, error: identityError } = await db.from('app_users')
      .select('id').eq('email', VOICE_APPROVER_EMAIL).eq('active', true).maybeSingle()
    if (identityError || !ulv) return []

    const { data, error } = await db.from('gbp_review_replies')
      .select('draft_text,approved_text,approved_at,review:gbp_reviews(star_rating,review_text)')
      .in('status', ['approved', 'published'])
      .eq('approved_by_user_id', ulv.id)
      .gte('approved_at', new Date(now.getTime() - 90 * 86400_000).toISOString())
      .order('approved_at', { ascending: false }).order('id', { ascending: false }).limit(24)
    if (error) return [] // Style enrichment must not prevent drafting.
    type Row = { draft_text: string | null; approved_text: string | null; review: { star_rating: number; review_text: string | null } | { star_rating: number; review_text: string | null }[] | null }
    const candidates = ((data ?? []) as unknown as Row[])
      .filter(row => row.approved_text?.trim() && row.approved_text.trim().length <= 600)
    if (candidates.length < MIN_VOICE_EXAMPLES) return []
    return candidates
      .sort((a, b) => Number(b.draft_text?.trim() !== b.approved_text?.trim()) - Number(a.draft_text?.trim() !== a.approved_text?.trim()))
      .slice(0, 6)
      .map(row => {
        const review = Array.isArray(row.review) ? row.review[0] : row.review
        return { starRating: review?.star_rating ?? null, reviewText: review?.review_text?.slice(0, 400) ?? null,
          originalDraft: row.draft_text?.slice(0, 400) ?? null, approvedReply: row.approved_text!.trim() }
      })
  } catch { return [] }
}

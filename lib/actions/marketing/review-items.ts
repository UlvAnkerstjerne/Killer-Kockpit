'use server'

import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import type { KKRole } from '@/lib/types'
import type { MarketingPermission, MarketingReviewItem } from '@/lib/marketing/types'

// ─── getMarketingPendingReviews — public server action ────────────────────────
//
// Self-authenticating. User identity, role, and Marketing permissions are
// NEVER accepted from the caller — they are resolved entirely from
// authenticated server state.
//
// Exported functions in 'use server' files are Next.js server actions and can
// be invoked from the browser via the __nextjs_action mechanism. Accepting
// userId/role/permissions as parameters would allow any client to pass
// 'SUPER_ADMIN' or arbitrary permission arrays and bypass authorization.
//
// Safe call path:
//   browser/component calls getMarketingPendingReviews() — no args
//   → getCurrentUser() — session-verified identity
//   → canAccessMarketing() — workspace gate
//   → getUserMarketingPermissions(user.id) — own permissions only
//   → collectPendingReviews() — trusted values, not exported

export async function getMarketingPendingReviews(): Promise<MarketingReviewItem[]> {
  const user = await getCurrentUser()
  if (!user) return []

  if (!canAccessMarketing(user.role, user.marketing_access)) return []

  const permissions = await getUserMarketingPermissions(user.id)
  return collectPendingReviews(user.id, user.role, permissions)
}

// ─── collectPendingReviews — internal aggregation helper ──────────────────────
//
// NOT exported. Receives only values already resolved from authenticated
// server state. Never called with caller-supplied context.
//
// Architecture: source-specific domain records are authoritative.
// This helper aggregates from domain-specific query functions —
// one per domain module introduced in M2/M3/M5.
//
// In M1, no domain tables exist, so this correctly returns an empty array.
// The function structure is designed for incremental extension:
//
//   M2 — paid recommendations:
//     if (hasMarketingPermission(role, permissions, 'paid_approve')) {
//       items.push(...await getPendingPaidRecommendations(userId))
//     }
//
//   M3 — review replies:
//     if (hasMarketingPermission(role, permissions, 'reviews_approve')) {
//       items.push(...await getPendingReviewReplies(userId))
//     }
//
//   M5 — content and ideas:
//     if (hasMarketingPermission(role, permissions, 'content_approve')) {
//       items.push(...await getPendingContentApprovals(userId))
//     }
//     if (hasMarketingPermission(role, permissions, 'ideas_approve')) {
//       items.push(...await getPendingContentIdeas(userId))
//     }
//
// Each domain query must enforce authorization at the DB/RLS layer as well —
// permission checks here are a defence-in-depth gate, not the only boundary.
//
// AI rule: no AI output appears in this list without first being stored as a
// domain-specific record with an explicit pending status. AI output is a
// proposal — it must never directly become an approved Marketing action.

async function collectPendingReviews(
  _userId: string,
  role: KKRole,
  permissions: MarketingPermission[]
): Promise<MarketingReviewItem[]> {
  const items: MarketingReviewItem[] = []

  // M2 — GBP review replies awaiting approval
  if (hasMarketingPermission(role, permissions, 'reviews_approve')) {
    items.push(...await getPendingGbpReplies())
  }

  return items
}

// ── getPendingGbpReplies — internal domain query ───────────────────────────────
//
// NOT exported. Receives control only from collectPendingReviews(), which has
// already verified authentication and Marketing access. Never called with
// caller-supplied authorization context.
//
// Returns MarketingReviewItem projections for all gbp_review_replies rows
// with status = 'awaiting_review'. The item id is the gbp_review_replies.id
// so the Needs Review UI can link directly to the review detail page.

async function getPendingGbpReplies(): Promise<MarketingReviewItem[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('gbp_review_replies')
    .select(`
      id,
      status,
      created_at,
      review:gbp_reviews(
        star_rating,
        review_text,
        review_created_at,
        reviewer_name,
        location:gbp_locations(store_short_name)
      )
    `)
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: true })

  if (error || !data) return []

  return data.flatMap((row) => {
    const review = Array.isArray(row.review) ? row.review[0] : row.review
    if (!review) return []

    const location = Array.isArray(review.location) ? review.location[0] : review.location
    const storeShort = location?.store_short_name ?? '?'
    const stars = '★'.repeat(review.star_rating as number) + '☆'.repeat(5 - (review.star_rating as number))
    const reviewerName = (review.reviewer_name as string | null) ?? 'Anonymous'

    return [{
      id:                 row.id as string,
      kind:               'review_reply' as const,
      title:              `${stars} · ${storeShort} · ${reviewerName}`,
      description:        review.review_text
        ? (review.review_text as string).slice(0, 120)
        : null,
      created_at:         review.review_created_at as string,
      requires_permission: 'reviews_approve' as MarketingPermission,
    }]
  })
}

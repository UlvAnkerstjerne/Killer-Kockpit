// Marketing-domain types — isolated from lib/types.ts so Management routes
// never need to import or evaluate Marketing-specific definitions.

// ─── Permissions ─────────────────────────────────────────────────────────────
//
// Seven fine-grained Marketing capability keys.
// These gate specific actions beyond workspace entry (marketing_access).
//
// Both marketing_access AND the relevant permission are required for
// non-SUPER_ADMIN users. Neither implies the other.
// SUPER_ADMIN bypasses permission checks without needing rows in the DB.

export type MarketingPermission =
  | 'paid_manage'     // View paid performance, create recommendations for approval
  | 'paid_approve'    // Approve/reject paid-media actions (spend authority)
  | 'content_manage'  // Create/edit/manage content workflow
  | 'content_approve' // Approve content through relevant publication stages
  | 'ideas_approve'   // Approve AI-generated ideas before Ideas backlog entry
                      // (distinct from content_approve: approved idea ≠ approved content)
  | 'reviews_manage'  // View reviews, create reply drafts
  | 'reviews_approve' // Approve/send review replies

export const ALL_MARKETING_PERMISSIONS: readonly MarketingPermission[] = [
  'paid_manage',
  'paid_approve',
  'content_manage',
  'content_approve',
  'ideas_approve',
  'reviews_manage',
  'reviews_approve',
] as const

// ─── Needs Review ─────────────────────────────────────────────────────────────
//
// The unified read shape for the /marketing/needs-review aggregation.
// Authoritative data lives in domain-specific tables (introduced M2/M3/M5).
// This type represents the projected view used for display and action dispatch.
//
// AI rule: no AI output appears here without first being stored as a
// domain-specific record with an explicit pending status. AI output is a
// proposal — it must not become an approved action without human review.

export type ReviewItemKind =
  | 'paid_recommendation'
  | 'review_reply'
  | 'content_approval'
  | 'content_idea'

export interface MarketingReviewItem {
  id: string
  kind: ReviewItemKind
  title: string
  description: string | null
  created_at: string
  /** Which permission key is required to action this item */
  requires_permission: MarketingPermission
}

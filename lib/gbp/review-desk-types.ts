export interface ReviewDeskItem {
  id: string
  store_short_name: string
  reviewer_name: string | null
  star_rating: number
  review_text: string | null
  review_created_at: string
  reply_id: string | null
  draft_text: string | null
  approved_text: string | null
  status: string
  publish_error: string | null
  publish_started_at: string | null
  new_since_session: boolean
}
export interface ReviewDeskCursor { createdAt: string; id: string }
export interface ReviewDeskData {
  reviews: ReviewDeskItem[]
  canApprove: boolean
  nextCursor: ReviewDeskCursor | null
  error?: string
}
export interface ReviewDeskSelection { replyId: string; approvedText: string }
export interface ReviewPublishResult {
  replyId: string
  status: 'published' | 'already_published' | 'publish_failed' | 'confirmation_pending' | 'invalid'
  error?: string
}

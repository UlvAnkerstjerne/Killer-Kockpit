'use client'

import type { GbpReviewRow, GbpLocationRow } from '@/lib/actions/marketing/gbp-reviews'

const STATUS_LABEL: Record<string, string> = {
  new:                  'Draft pending',
  awaiting_review:      'Needs review',
  approved:             'Approved',
  rejected:             'Rejected',
  published:            'Published',
  publish_failed:       'Publish failed',
  externally_published: 'Replied externally',
}

const STATUS_CLASS: Record<string, string> = {
  new:                  'bg-kk-muted/10 text-kk-muted',
  awaiting_review:      'bg-amber-50 text-amber-700',
  approved:             'bg-blue-50 text-blue-700',
  rejected:             'bg-red-50 text-red-700',
  published:            'bg-green-50 text-green-700',
  publish_failed:       'bg-red-50 text-red-700',
  externally_published: 'bg-kk-muted/10 text-kk-muted',
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="text-amber-400 text-sm" aria-label={`${rating} out of 5 stars`}>
      {'★'.repeat(rating)}{'☆'.repeat(5 - rating)}
    </span>
  )
}

function ReplyStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[status] ?? 'bg-kk-muted/10 text-kk-muted'}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

interface Props {
  reviews:   GbpReviewRow[]
  locations: GbpLocationRow[]
}

export default function GbpReviewsClient({ reviews, locations }: Props) {
  if (locations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-sm text-kk-muted">
          No Google Business Profile locations configured.
        </div>
        <div className="text-xs text-kk-muted mt-1">
          Contact your administrator to set up GBP locations.
        </div>
      </div>
    )
  }

  if (reviews.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-sm text-kk-muted">No reviews yet — run a sync to import.</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {reviews.map((review) => {
        const location = Array.isArray(review.location) ? review.location[0] : review.location
        const reply    = Array.isArray(review.reply)    ? review.reply[0]    : review.reply
        const replyStatus = reply?.status ?? (review.existing_reply_text ? 'externally_published' : 'new')
        const canReview = replyStatus === 'awaiting_review'

        return (
          <div
            key={review.id}
            className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                {/* Header row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <StarRating rating={review.star_rating} />
                  <span className="text-xs text-kk-muted font-medium">
                    {location?.store_short_name ?? '—'}
                  </span>
                  {review.reviewer_name && (
                    <span className="text-xs text-kk-muted">· {review.reviewer_name}</span>
                  )}
                  <span className="text-xs text-kk-muted">
                    · {new Date(review.review_created_at).toLocaleDateString('da-DK', {
                        timeZone: 'Europe/Copenhagen',
                      })}
                  </span>
                </div>

                {/* Review text */}
                {review.review_text && (
                  <div className="mt-2 text-sm text-kk-ink line-clamp-3">
                    {review.review_text}
                  </div>
                )}

                {/* Reply status */}
                <div className="mt-2">
                  <ReplyStatusBadge status={replyStatus} />
                </div>
              </div>

              {/* Action link for reviews that need approval */}
              {canReview && reply && (
                <a
                  href={`/marketing/google-business-profile/reviews/${reply.id}`}
                  className="shrink-0 text-xs font-medium text-kk-accent hover:underline"
                >
                  Review →
                </a>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

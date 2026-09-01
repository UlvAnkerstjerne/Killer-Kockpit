'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  approveGbpReply,
  rejectGbpReply,
  publishGbpReply,
} from '@/lib/actions/marketing/gbp-reviews'
import type { GbpReviewRow } from '@/lib/actions/marketing/gbp-reviews'

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="text-amber-400 text-xl" aria-label={`${rating} out of 5 stars`}>
      {'★'.repeat(rating)}{'☆'.repeat(5 - rating)}
    </span>
  )
}

interface Props {
  review:  GbpReviewRow
  replyId: string
}

export default function ReviewDetailClient({ review, replyId }: Props) {
  const router   = useRouter()
  const [isPending, startTransition] = useTransition()

  const reply    = Array.isArray(review.reply) ? review.reply[0] : review.reply
  const location = Array.isArray(review.location) ? review.location[0] : review.location

  const [editedText, setEditedText]     = useState(reply?.draft_text ?? '')
  const [rejectionNote, setRejectionNote] = useState('')
  const [feedback, setFeedback]         = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const status = reply?.status ?? 'new'
  const isActionable = ['awaiting_review', 'rejected', 'publish_failed'].includes(status)
  const isApproved   = status === 'approved'
  const isPublished  = status === 'published'

  function handleApprove() {
    if (!editedText.trim()) {
      setFeedback({ type: 'error', message: 'Reply text cannot be empty.' })
      return
    }
    startTransition(async () => {
      const result = await approveGbpReply(replyId, editedText)
      if (result.error) {
        setFeedback({ type: 'error', message: result.error })
      } else {
        setFeedback({ type: 'success', message: 'Reply approved.' })
        router.refresh()
      }
    })
  }

  function handleReject() {
    startTransition(async () => {
      const result = await rejectGbpReply(replyId, rejectionNote)
      if (result.error) {
        setFeedback({ type: 'error', message: result.error })
      } else {
        setFeedback({ type: 'success', message: 'Reply rejected.' })
        router.refresh()
      }
    })
  }

  function handlePublish() {
    startTransition(async () => {
      const result = await publishGbpReply(replyId)
      if (result.error) {
        setFeedback({ type: 'error', message: result.error })
      } else if (result.data?.status === 'published') {
        setFeedback({ type: 'success', message: 'Reply published to Google.' })
        router.refresh()
      } else {
        setFeedback({ type: 'error', message: 'Publish failed. Check status for details.' })
        router.refresh()
      }
    })
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Review card */}
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-5 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <StarRating rating={review.star_rating} />
          <span className="text-sm font-medium text-kk-ink">
            {location?.store_name ?? '—'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-kk-muted">
          <span>{review.reviewer_name ?? 'Anonymous'}</span>
          <span>·</span>
          <span>
            {new Date(review.review_created_at).toLocaleDateString('da-DK', {
              timeZone: 'Europe/Copenhagen',
              year: 'numeric', month: 'long', day: 'numeric',
            })}
          </span>
        </div>
        {review.review_text ? (
          <p className="text-sm text-kk-ink">{review.review_text}</p>
        ) : (
          <p className="text-sm text-kk-muted italic">Rating only — no written comment.</p>
        )}
      </div>

      {/* Existing Google reply (if any) */}
      {review.existing_reply_text && (
        <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4">
          <div className="text-xs font-medium text-kk-muted uppercase tracking-wide mb-2">
            Current Google reply
          </div>
          <p className="text-sm text-kk-ink">{review.existing_reply_text}</p>
        </div>
      )}

      {/* Reply draft / approval */}
      {reply && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-kk-muted uppercase tracking-wide">
                {isActionable ? 'Reply draft — edit before approving' : 'Reply text'}
              </label>
              {reply.draft_model && (
                <span className="text-xs text-kk-muted">
                  AI draft · {reply.draft_model}
                </span>
              )}
            </div>
            <textarea
              value={isApproved || isPublished ? (reply.approved_text ?? '') : editedText}
              onChange={(e) => setEditedText(e.target.value)}
              disabled={!isActionable || isPending}
              rows={5}
              className="w-full rounded-xl border border-kk-line bg-kk-panel px-4 py-3 text-sm text-kk-ink resize-none focus:outline-none focus:ring-2 focus:ring-kk-accent/30 disabled:opacity-60"
            />
          </div>

          {/* Status badge */}
          <div className="text-xs text-kk-muted">
            Status: <span className="font-medium text-kk-ink capitalize">{status.replace(/_/g, ' ')}</span>
            {reply.approved_at && (
              <> · Approved {new Date(reply.approved_at).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen' })}</>
            )}
            {reply.published_at && (
              <> · Published {new Date(reply.published_at).toLocaleDateString('da-DK', { timeZone: 'Europe/Copenhagen' })}</>
            )}
          </div>

          {/* Publish error */}
          {status === 'publish_failed' && reply.publish_error && (
            <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
              Publish error: {reply.publish_error}
            </div>
          )}

          {/* Feedback */}
          {feedback && (
            <div className={`text-xs rounded-lg px-3 py-2 ${
              feedback.type === 'success'
                ? 'text-green-700 bg-green-50'
                : 'text-red-600 bg-red-50'
            }`}>
              {feedback.message}
            </div>
          )}

          {/* Rejection note (shown when rejecting) */}
          {isActionable && (
            <div>
              <label className="text-xs font-medium text-kk-muted uppercase tracking-wide block mb-1">
                Rejection note (optional)
              </label>
              <input
                type="text"
                value={rejectionNote}
                onChange={(e) => setRejectionNote(e.target.value)}
                disabled={isPending}
                placeholder="Reason for rejection..."
                className="w-full rounded-xl border border-kk-line bg-kk-panel px-4 py-2 text-sm text-kk-ink focus:outline-none focus:ring-2 focus:ring-kk-accent/30 disabled:opacity-60"
              />
            </div>
          )}

          {/* Action buttons */}
          {isActionable && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleApprove}
                disabled={isPending}
                className="px-4 py-2 rounded-xl bg-kk-ink text-kk-bg text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-40"
              >
                Approve reply
              </button>
              <button
                onClick={handleReject}
                disabled={isPending}
                className="px-4 py-2 rounded-xl border border-kk-line text-sm font-medium text-kk-ink hover:bg-kk-panel transition-colors disabled:opacity-40"
              >
                Reject
              </button>
            </div>
          )}

          {/* Publish button */}
          {isApproved && (
            <div className="flex items-center gap-3">
              <button
                onClick={handlePublish}
                disabled={isPending}
                className="px-4 py-2 rounded-xl bg-green-700 text-white text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-40"
              >
                Publish to Google
              </button>
              <span className="text-xs text-kk-muted">
                This will post the reply to Google Business Profile.
              </span>
            </div>
          )}
        </div>
      )}

      {/* No reply row yet */}
      {!reply && (
        <div className="text-sm text-kk-muted bg-kk-panel border border-kk-line rounded-2xl px-5 py-4">
          AI draft not yet generated. It will appear after the next sync.
        </div>
      )}
    </div>
  )
}

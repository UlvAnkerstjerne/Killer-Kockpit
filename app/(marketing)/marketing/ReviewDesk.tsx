'use client'

import { useState, useTransition } from 'react'
import { getGbpReviewDesk, publishGbpReviewBatch, retryGbpReviewDeskDraft } from '@/lib/actions/marketing/gbp-review-desk'
import type { ReviewDeskData, ReviewDeskItem } from '@/lib/gbp/review-desk-types'

type Edit = { text: string; included: boolean; error?: string }
function initialEdit(row: ReviewDeskItem): Edit {
  const text = row.approved_text ?? row.draft_text ?? ''
  return { text, included: !!row.reply_id && !!text.trim() && row.status !== 'new' && !row.publish_started_at }
}

export default function ReviewDesk({ initial }: { initial: ReviewDeskData }) {
  const [desk, setDesk] = useState(initial)
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [feedback, setFeedback] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const editFor = (row: ReviewDeskItem) => edits[row.id] ?? initialEdit(row)
  const selected = desk.reviews.filter(row => row.reply_id && !row.publish_started_at && editFor(row).included)
  const hasInvalidText = selected.some(row => !editFor(row).text.trim() || editFor(row).text.length > 4096)
  function patch(row: ReviewDeskItem, change: Partial<Edit>) {
    setEdits(previous => ({ ...previous, [row.id]: { ...(previous[row.id] ?? initialEdit(row)), ...change } }))
  }
  function loadMore() {
    if (!desk.nextCursor) return
    startTransition(async () => {
      try {
        const next = await getGbpReviewDesk(desk.nextCursor!)
        if (next.error) { setFeedback(next.error); return }
        setDesk(previous => ({ ...next, reviews: [...previous.reviews, ...next.reviews.filter(row => !previous.reviews.some(existing => existing.id === row.id))] }))
      } catch { setFeedback('Could not load more reviews. Your edits are still here.') }
    })
  }
  function publish() {
    startTransition(async () => {
      setFeedback(null)
      try {
        const result = await publishGbpReviewBatch(selected.map(row => ({ replyId: row.reply_id!, approvedText: editFor(row).text })))
        if (result.error || !result.data) { setFeedback(result.error ?? 'Could not publish replies.'); return }
        const outcomes = new Map(result.data.results.map(row => [row.replyId, row]))
        const successful = result.data.results.filter(row => row.status === 'published' || row.status === 'already_published')
        setDesk(previous => ({ ...previous, reviews: previous.reviews.flatMap(row => {
          const outcome = row.reply_id ? outcomes.get(row.reply_id) : undefined
          if (!outcome) return [row]
          if (outcome.status === 'published' || outcome.status === 'already_published') return []
          return [{ ...row, publish_error: outcome.error ?? null,
            publish_started_at: outcome.status === 'confirmation_pending' ? new Date().toISOString() : row.publish_started_at }]
        }) }))
        const published = successful.filter(row => row.status === 'published').length
        const alreadyAnswered = successful.length - published
        const remaining = result.data.results.length - successful.length
        setFeedback(`${published} ${published === 1 ? 'reply published' : 'replies published'}.${alreadyAnswered ? ` ${alreadyAnswered} already answered.` : ''}${remaining ? ` ${remaining} ${remaining === 1 ? 'reply still needs' : 'replies still need'} attention.` : ''}${result.data.warning ? ` ${result.data.warning}` : ''}`)
      } catch { setFeedback('The batch result could not be confirmed. Refresh before retrying; saved replies will disappear from the queue.') }
    })
  }
  function retry(row: ReviewDeskItem) {
    startTransition(async () => {
      try {
        const result = await retryGbpReviewDeskDraft(row.id)
        if (result.error) { patch(row, { error: result.error }); return }
        if (result.data) {
          const fresh = { ...row, ...result.data.reply, id: row.id, reply_id: result.data.reply.id }
          setDesk(previous => ({ ...previous, reviews: previous.reviews.map(item => item.id === row.id ? fresh : item) }))
          setEdits(previous => ({ ...previous, [row.id]: initialEdit(fresh) }))
        }
      } catch { patch(row, { error: 'Could not prepare the draft. Please try again.' }) }
    })
  }
  return (
    <section className="mt-8 border-t border-kk-line pt-6" aria-labelledby="google-reviews-heading">
      <div className="mb-4">
        <h2 id="google-reviews-heading" className="text-2xl font-black tracking-tight text-kk-ink">Google Reviews</h2>
        {desk.reviews.length > 0 && <p className="mt-1 text-sm text-kk-muted">Check the drafts, edit where needed, and publish the selected replies.</p>}
      </div>
      {desk.error ? <p role="alert" className="text-sm text-kk-bad">{desk.error}</p> : null}
      {feedback ? <p role="status" className="mb-4 text-sm text-kk-ink">{feedback}</p> : null}
      {!desk.error && desk.reviews.length === 0 ? <p className="text-sm text-kk-muted">All caught up. New reviews will appear here after syncing.</p> : null}
      <div className="space-y-3">
        {desk.reviews.map(row => {
          const edit = editFor(row)
          const draftPending = !row.reply_id || row.status === 'new' || !(row.approved_text?.trim() || row.draft_text?.trim())
          const locked = !!row.publish_started_at
          return (
            <article key={row.id} className="rounded-2xl border border-kk-line bg-kk-panel p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kk-muted">
                  <span className="font-semibold text-kk-ink">{row.store_short_name}</span>
                  <span className="text-amber-600" aria-label={`${row.star_rating} out of 5 stars`}>{'★'.repeat(row.star_rating)}{'☆'.repeat(5 - row.star_rating)}</span>
                  <span>{row.reviewer_name ?? 'Anonymous'}</span>
                  <time dateTime={row.review_created_at}>{new Date(row.review_created_at).toLocaleDateString('en-GB', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short', year: 'numeric' })}</time>
                  {!row.new_since_session ? <span className="text-kk-warn">Still needs attention</span> : null}
                </div>
                {desk.canApprove && <label className="flex shrink-0 items-center gap-2 text-xs text-kk-muted">
                  <input type="checkbox" checked={edit.included && !locked} disabled={pending || draftPending || locked} onChange={event => patch(row, { included: event.target.checked })} aria-label={`Include reply to ${row.reviewer_name ?? 'anonymous reviewer'}`} className="h-4 w-4 accent-kk-brand" />
                  Include
                </label>}
              </div>
              <p className={`mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed ${row.review_text?.trim() ? 'text-kk-ink' : 'italic text-kk-muted'}`}>
                {row.review_text?.trim() || 'Rating only — no written comment.'}
              </p>
              {draftPending ? (
                <div className="mt-3 flex items-center gap-3 text-sm text-kk-muted">
                  <span>Draft pending</span>
                  {desk.canApprove && !locked && <button type="button" disabled={pending} onClick={() => retry(row)} className="font-medium text-kk-brand hover:underline disabled:opacity-50">Retry draft</button>}
                </div>
              ) : (
                <div className="mt-3">
                  <label htmlFor={`reply-${row.id}`} className="mb-1 block text-xs font-medium text-kk-muted">{desk.canApprove ? 'Reply to publish' : 'Prepared reply'}</label>
                  <textarea id={`reply-${row.id}`} value={edit.text} rows={3} maxLength={4096} readOnly={!desk.canApprove} disabled={pending || locked}
                    onChange={event => patch(row, { text: event.target.value })}
                    className="w-full resize-y rounded-xl border border-kk-line bg-white p-3 text-sm leading-relaxed text-kk-ink focus:border-kk-brand focus:outline-none focus:ring-1 focus:ring-kk-brand disabled:opacity-60" />
                  {desk.canApprove && !locked && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {['😊', '🙏', '❤️', '🔥', '👏', '💪', '🌯', '🧆', '⭐', '🙌'].map(emoji => (
                        <button
                          key={emoji}
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            const ta = document.getElementById(`reply-${row.id}`) as HTMLTextAreaElement | null
                            const pos = ta?.selectionStart ?? edit.text.length
                            const before = edit.text.slice(0, pos)
                            const after = edit.text.slice(pos)
                            patch(row, { text: before + emoji + after })
                            setTimeout(() => { if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = pos + emoji.length } }, 0)
                          }}
                          className="w-7 h-7 flex items-center justify-center rounded-md text-base hover:bg-kk-soft transition-colors disabled:opacity-50"
                          aria-label={`Insert ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                  {row.draft_text && edit.text !== row.draft_text && <details className="mt-1 text-xs text-kk-muted"><summary className="cursor-pointer">Original AI draft</summary><p className="mt-2 whitespace-pre-wrap break-words">{row.draft_text}</p></details>}
                </div>
              )}
              {locked ? <p className="mt-2 text-xs text-kk-warn">Publication pending confirmation. Run GBP sync before retrying.</p> : null}
              {edit.error || row.publish_error ? <p role="alert" className="mt-2 text-xs text-kk-bad">{edit.error ?? row.publish_error}</p> : null}
            </article>
          )
        })}
      </div>
      {desk.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={pending}
            className="rounded-xl border border-kk-line bg-kk-panel px-6 py-3 text-sm font-semibold text-kk-ink hover:bg-kk-soft transition-colors disabled:opacity-50"
          >
            {pending ? 'Loading…' : 'Load more reviews'}
          </button>
        </div>
      ) : desk.reviews.length > 0 ? (
        <p className="mt-4 text-center text-xs text-kk-muted">All queued reviews loaded.</p>
      ) : null}
      {desk.canApprove && desk.reviews.length > 0 ? <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={publish} disabled={pending || selected.length === 0 || selected.length > 50 || hasInvalidText}
          className="rounded-xl bg-kk-brand px-5 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
          {pending ? 'Working…' : `Publish ${selected.length} ${selected.length === 1 ? 'reply' : 'replies'}`}
        </button>
        <span className="text-xs text-kk-muted">{selected.length > 50 ? 'Select up to 50 replies per batch.' : 'Publishing approves and sends the selected replies to Google.'}</span>
      </div> : null}
    </section>
  )
}

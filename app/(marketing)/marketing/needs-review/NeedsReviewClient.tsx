'use client'

import Link from 'next/link'
import type { MarketingReviewItem } from '@/lib/marketing/types'

// NeedsReviewClient renders the Needs Review list or empty state.
// review_reply items link to the GBP review detail page for approval.

export default function NeedsReviewClient({
  items,
}: {
  items: MarketingReviewItem[]
}) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-sm text-kk-muted">Nothing needs your approval right now.</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const href = item.kind === 'review_reply'
          ? `/marketing/google-business-profile/reviews/${item.id}`
          : null

        const card = (
          <div className="bg-kk-panel border border-kk-line rounded-2xl px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-kk-ink">{item.title}</div>
                {item.description && (
                  <div className="text-xs text-kk-muted mt-1 line-clamp-2">{item.description}</div>
                )}
                <div className="text-xs text-kk-muted mt-2 capitalize">
                  {item.kind.replace(/_/g, ' ')} ·{' '}
                  {new Date(item.created_at).toLocaleDateString('da-DK', {
                    timeZone: 'Europe/Copenhagen',
                  })}
                </div>
              </div>
              {href && (
                <span className="shrink-0 text-xs font-medium text-kk-accent">
                  Review →
                </span>
              )}
            </div>
          </div>
        )

        if (href) {
          return (
            <Link key={item.id} href={href} className="block hover:opacity-80 transition-opacity">
              {card}
            </Link>
          )
        }

        return <div key={item.id}>{card}</div>
      })}
    </div>
  )
}

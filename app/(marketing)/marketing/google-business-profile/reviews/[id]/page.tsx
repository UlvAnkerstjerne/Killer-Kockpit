import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getGbpReviewDetail } from '@/lib/actions/marketing/gbp-reviews'
import ReviewDetailClient from './ReviewDetailClient'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function GbpReviewDetailPage({ params }: Props) {
  const { id: replyId } = await params

  // getGbpReviewDetail authenticates internally — no auth context accepted here.
  const review = await getGbpReviewDetail(replyId)

  if (!review) notFound()

  const reply    = Array.isArray(review.reply) ? review.reply[0] : review.reply
  const location = Array.isArray(review.location) ? review.location[0] : review.location

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-kk-muted mb-6">
        <Link href="/marketing/needs-review" className="hover:text-kk-ink">
          Needs Review
        </Link>
        <span>·</span>
        <Link href="/marketing/google-business-profile" className="hover:text-kk-ink">
          Google Business Profile
        </Link>
        <span>·</span>
        <span className="text-kk-ink">{location?.store_name ?? 'Review'}</span>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Review Reply</h1>
        <p className="text-sm text-kk-muted mt-0.5">
          Review, edit, and approve the AI-drafted reply before publishing to Google.
        </p>
      </div>

      <ReviewDetailClient review={review} replyId={reply?.id ?? replyId} />
    </div>
  )
}

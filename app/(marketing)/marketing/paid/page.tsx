import { getPaidPerformance } from '@/lib/actions/marketing/paid-performance'
import PaidPageClient from './PaidPageClient'

export const dynamic = 'force-dynamic'

export default async function PaidPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const report = await getPaidPerformance(params.period)
  return (
    <div className="min-w-0">
      <div className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Paid</h1>
        <p className="text-sm text-kk-muted mt-0.5">Campaign goals, results and cost · Meta & Google Ads</p>
      </div>
      {report.allowed ? <PaidPageClient report={report} /> : (
        <p className="rounded-xl border border-kk-line bg-kk-panel p-5 text-sm text-kk-muted">Paid performance requires Marketing paid access.</p>
      )}
    </div>
  )
}

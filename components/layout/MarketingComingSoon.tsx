export default function MarketingComingSoon({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">{title}</h1>
        <p className="text-sm text-kk-muted mt-0.5">Marketing · {title}</p>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-10 flex flex-col items-center text-center max-w-lg">
        <div className="text-xs font-bold tracking-widest uppercase text-kk-muted bg-kk-soft px-3 py-1.5 rounded-full mb-4">
          Coming soon
        </div>
        <p className="text-sm text-kk-muted leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

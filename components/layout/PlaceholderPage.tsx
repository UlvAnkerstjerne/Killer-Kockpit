export default function PlaceholderPage({
  title,
  description,
  milestone,
}: {
  title: string
  description: string
  milestone: number
}) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">{title}</h1>
        <p className="text-sm text-kk-muted mt-0.5">Coming in Milestone {milestone}</p>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-10 flex flex-col items-center text-center max-w-lg mx-auto">
        <div className="text-xs font-bold tracking-widest uppercase text-kk-muted bg-kk-soft px-3 py-1 rounded-full mb-4">
          Milestone {milestone}
        </div>
        <h2 className="text-base font-semibold text-kk-ink mb-2">{title}</h2>
        <p className="text-sm text-kk-muted leading-relaxed">{description}</p>
        <p className="text-xs text-kk-muted mt-4 opacity-60">
          This section is intentionally deferred. The foundation must be dependable before integrations are built.
        </p>
      </div>
    </div>
  )
}

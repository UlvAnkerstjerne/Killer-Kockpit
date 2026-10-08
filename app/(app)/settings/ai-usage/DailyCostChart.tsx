import type { DailyPoint } from '@/lib/ai/usage-stats'

const usd = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 4)}`

/** Dependency-free bar chart. Server-rendered SVG; tooltips via <title>. */
export default function DailyCostChart({ points }: { points: DailyPoint[] }) {
  const W = 720, H = 160, padL = 44, padB = 22, padT = 8
  const max = Math.max(0.0001, ...points.map(p => p.cost))
  const bw = (W - padL) / points.length
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max)
  const ticks = [0, max / 2, max]
  const total = points.reduce((s, p) => s + p.cost, 0)

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label={`Daily estimated AI cost, last ${points.length} days, total ${usd(total)}`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="#171717" strokeOpacity={0.12} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#555">{usd(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const h = Math.max(p.cost > 0 ? 1.5 : 0, (H - padT - padB) * (p.cost / max))
          return (
            <g key={p.date}>
              <rect x={padL + i * bw + 1.5} y={H - padB - h} width={Math.max(2, bw - 3)} height={h} fill="#AD3919" rx={1}>
                <title>{`${p.date}: ${usd(p.cost)} · ${p.calls} API call${p.calls === 1 ? '' : 's'}`}</title>
              </rect>
              {(i === 0 || i === points.length - 1 || i % 7 === 0) && (
                <text x={padL + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#555">{p.date.slice(5)}</text>
              )}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

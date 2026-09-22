import type { PlatformSnapshotData } from '@/lib/actions/marketing/platform-snapshot'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 10_000)    return `${(n / 1_000).toFixed(0)}k`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return n.toLocaleString()
}

function fmtPct(pct: number | null): { text: string; up: boolean } | null {
  if (pct === null) return null
  const r = Math.round(pct * 100)
  return { text: `${r >= 0 ? '+' : ''}${r}%`, up: r >= 0 }
}

function fmtDelta(delta: number | null): { text: string; up: boolean } | null {
  if (delta === null) return null
  return { text: `${delta >= 0 ? '+' : ''}${delta}`, up: delta >= 0 }
}

function fmtSpend(n: number): string {
  if (n >= 1000) return `kr. ${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `kr. ${Math.round(n)}`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  badge,
}: {
  label: string
  value: string
  badge?: { text: string; up: boolean } | null
}) {
  return (
    <div className="flex items-end justify-between gap-1 min-w-0">
      <div className="min-w-0">
        <div className="text-[10px] text-kk-muted uppercase tracking-[0.07em] leading-none mb-0.5 truncate">{label}</div>
        <span className="text-sm font-bold tabular-nums text-kk-ink leading-none">{value}</span>
      </div>
      {badge && (
        <span className={`text-[10px] font-semibold tabular-nums shrink-0 leading-none ${badge.up ? 'text-kk-good' : 'text-kk-bad'}`}>
          {badge.text}
        </span>
      )}
    </div>
  )
}

function CardHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-3">
      <span className="text-kk-muted shrink-0">{icon}</span>
      <span className="text-[11px] font-bold tracking-[0.07em] uppercase text-kk-ink">{title}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] font-bold tracking-[0.1em] uppercase text-kk-muted/60 mb-1.5 mt-2.5">{children}</div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconIG() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="4" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="13" cy="5" r="0.8" fill="currentColor"/>
    </svg>
  )
}

function IconFB() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M10.5 9h2l.5-2.5H10.5V5c0-.7.35-1.5 1.5-1.5H13V1.5C12.2 1.5 11 1.5 11 1.5 8.8 1.5 7.5 2.8 7.5 5.2V6.5H5.5V9h2v7.5h3V9Z" fill="currentColor"/>
    </svg>
  )
}

function IconMapPin() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 1.5C6.5 1.5 4.5 3.5 4.5 6c0 3.75 4.5 10.5 4.5 10.5S13.5 9.75 13.5 6c0-2.5-2-4.5-4.5-4.5Z" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="9" cy="6" r="1.5" fill="currentColor"/>
    </svg>
  )
}

function IconGlobe() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M9 2C9 2 6.5 5.5 6.5 9s2.5 7 2.5 7M9 2c0 0 2.5 3.5 2.5 7S9 16 9 16M2 9h14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
}

// ── Platform cards ────────────────────────────────────────────────────────────

function InstagramCard({ ig, meta_paid }: Pick<PlatformSnapshotData, 'ig' | 'meta_paid'>) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
      <CardHeader icon={<IconIG />} title="Instagram" />
      <div className="space-y-2">
        <Stat label="Reach 7d" value={fmtCompact(ig.reach_7d)} badge={fmtPct(ig.reach_change_pct)} />
        <Stat
          label="Followers"
          value={ig.followers !== null ? fmtCompact(ig.followers) : '—'}
          badge={fmtDelta(ig.followers_delta)}
        />
      </div>
      <SectionLabel>Meta Paid</SectionLabel>
      <div className="space-y-2">
        <Stat label="Impressions 7d" value={fmtCompact(meta_paid.impressions_7d)} />
        <Stat label="Spend 7d" value={fmtSpend(meta_paid.spend_7d)} badge={fmtPct(meta_paid.spend_change_pct)} />
      </div>
    </div>
  )
}

function FacebookCard({ fb }: Pick<PlatformSnapshotData, 'fb'>) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
      <CardHeader icon={<IconFB />} title="Facebook" />
      <div className="space-y-2">
        <Stat label="Page views 7d" value={fmtCompact(fb.page_views_7d)} badge={fmtPct(fb.page_views_change_pct)} />
        <Stat label="Engaged 7d" value={fmtCompact(fb.engaged_users_7d)} />
        <Stat
          label="Fans"
          value={fb.fans !== null ? fmtCompact(fb.fans) : '—'}
          badge={fmtDelta(fb.fans_delta)}
        />
      </div>
    </div>
  )
}

function GbpCard({ gbp }: Pick<PlatformSnapshotData, 'gbp'>) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
      <CardHeader icon={<IconMapPin />} title="Google Business" />
      <div className="space-y-2">
        <Stat label="Impressions 28d" value={fmtCompact(gbp.impressions_28d)} badge={fmtPct(gbp.impressions_change_pct)} />
        <Stat label="Directions 28d" value={fmtCompact(gbp.directions_28d)} badge={fmtPct(gbp.directions_change_pct)} />
        <Stat label="Website clicks 28d" value={fmtCompact(gbp.website_clicks_28d)} />
        <div>
          <div className="text-[10px] text-kk-muted uppercase tracking-[0.07em] leading-none mb-0.5">Reviews</div>
          <span className="text-[11px] text-kk-muted/60 italic">unavailable</span>
        </div>
      </div>
    </div>
  )
}

function WebsiteCard({ ga4 }: Pick<PlatformSnapshotData, 'ga4'>) {
  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl px-4 py-3">
      <CardHeader icon={<IconGlobe />} title="Website" />
      <div className="space-y-2">
        <Stat label="Sessions 7d" value={fmtCompact(ga4.sessions_7d)} badge={fmtPct(ga4.sessions_change_pct)} />
        <Stat label="New users 7d" value={fmtCompact(ga4.new_users_7d)} badge={fmtPct(ga4.new_users_change_pct)} />
        <Stat label="Page views 7d" value={fmtCompact(ga4.page_views_7d)} badge={fmtPct(ga4.page_views_change_pct)} />
      </div>
    </div>
  )
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function PlatformCards({ snapshot }: { snapshot: PlatformSnapshotData | null }) {
  if (!snapshot) return null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-platform-cards="true">
      <InstagramCard ig={snapshot.ig} meta_paid={snapshot.meta_paid} />
      <FacebookCard fb={snapshot.fb} />
      <GbpCard gbp={snapshot.gbp} />
      <WebsiteCard ga4={snapshot.ga4} />
    </div>
  )
}

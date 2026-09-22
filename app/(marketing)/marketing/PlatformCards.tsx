// v2 — redesigned Instagram card
import type { PlatformSnapshotData } from '@/lib/actions/marketing/platform-snapshot'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCompact(n: number): string {
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
  return `kr. ${Math.round(n).toLocaleString()}`
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

// ── Change pill ───────────────────────────────────────────────────────────────

function ChangePill({ badge, small }: { badge: { text: string; up: boolean }; small?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 shrink-0 tabular-nums"
      style={{
        fontSize:     small ? '12px' : '13px',
        lineHeight:   '16px',
        fontWeight:   700,
        padding:      small ? '4px 9px' : '5px 10px',
        borderRadius: '999px',
        background:   badge.up ? '#E7F3EB' : '#F7E7E2',
        color:        badge.up ? '#2F6D4C' : '#AD3919',
      }}
    >
      {badge.up ? '↑' : '↓'} {badge.text}
    </span>
  )
}

// ── Platform cards ────────────────────────────────────────────────────────────

function InstagramCard({ ig, meta_paid }: Pick<PlatformSnapshotData, 'ig' | 'meta_paid'>) {
  const reachBadge     = fmtPct(ig.reach_change_pct)
  const followersBadge = fmtDelta(ig.followers_delta)
  const impressionsBadge = fmtPct(meta_paid.impressions_change_pct)
  const spendBadge       = fmtPct(meta_paid.spend_change_pct)

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid rgba(23,23,23,0.10)',
      borderRadius: '16px',
      boxShadow: '0 8px 24px rgba(23,23,23,0.07)',
      overflow: 'hidden',
    }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        height: '52px',
        borderBottom: '1px solid rgba(23,23,23,0.08)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>

          {/* Instagram gradient badge — 30×30 */}
          <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id="ig-badge-grad" x1="0" y1="28" x2="28" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stopColor="#F9CE34"/>
                <stop offset="40%"  stopColor="#EE2A7B"/>
                <stop offset="100%" stopColor="#6228D7"/>
              </linearGradient>
            </defs>
            <rect width="28" height="28" rx="8" fill="url(#ig-badge-grad)"/>
            <rect x="7" y="7" width="14" height="14" rx="4" stroke="white" strokeWidth="1.5" fill="none"/>
            <circle cx="14" cy="14" r="3.4" stroke="white" strokeWidth="1.5" fill="none"/>
            <circle cx="18.4" cy="9.6" r="1.05" fill="white"/>
          </svg>

          <span style={{ fontSize: '16px', fontWeight: 700, color: '#171717', lineHeight: '20px' }}>Instagram</span>
        </div>

        {/* Right-pointing chevron */}
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M5 3.5l4 3.5-4 3.5" stroke="rgba(23,23,23,0.40)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* ── Organic metrics ── */}
      <div style={{ padding: '14px 16px 0' }}>

        {/* Reach */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Reach (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <ellipse cx="10" cy="10" rx="8" ry="5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <circle cx="10" cy="10" r="2.4" stroke="#171717" strokeWidth="1.6" fill="none"/>
              </svg>
              {fmtCompact(ig.reach_7d)}
            </span>
          </div>
          {reachBadge && <ChangePill badge={reachBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Followers — identical geometry */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Followers</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <circle cx="10" cy="7" r="3.5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <path d="M3.5 17c0-3.59 2.91-6.5 6.5-6.5s6.5 2.91 6.5 6.5" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
              </svg>
              {ig.followers !== null ? fmtCompact(ig.followers) : '—'}
            </span>
          </div>
          {followersBadge && <ChangePill badge={followersBadge} />}
        </div>
      </div>

      {/* ── Meta Paid inset ── */}
      <div style={{
        margin: '12px 16px 16px',
        background: '#F1EEE8',
        borderRadius: '12px',
        padding: '12px 14px',
      }}>

        {/* Inset header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M12 3.5v9L6.5 10H4a1.5 1.5 0 01-1.5-1.5v-1A1.5 1.5 0 014 6h2.5L12 3.5z" stroke="rgba(23,23,23,0.55)" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
            <path d="M6.2 10.2l-.5 3.3" stroke="rgba(23,23,23,0.55)" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <span style={{ fontSize: '12px', lineHeight: '16px', fontWeight: 700, color: '#171717' }}>Meta Paid</span>
        </div>

        {/* Impressions */}
        <div style={{ marginBottom: '8px' }}>
          <div style={{ fontSize: '10px', fontWeight: 500, color: 'rgba(23,23,23,0.55)', marginBottom: '2px' }}>Impressions (7D)</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span className="tabular-nums" style={{ fontSize: '19px', fontWeight: 700, color: '#171717', lineHeight: '1.2', display: 'block' }}>
              {fmtCompact(meta_paid.impressions_7d)}
            </span>
            {impressionsBadge && <ChangePill badge={impressionsBadge} small />}
          </div>
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.06)', marginBottom: '8px' }} />

        {/* Spend */}
        <div>
          <div style={{ fontSize: '10px', fontWeight: 500, color: 'rgba(23,23,23,0.55)', marginBottom: '2px' }}>Spend (7D)</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span className="tabular-nums" style={{ fontSize: '19px', fontWeight: 700, color: '#171717', lineHeight: '1.2', display: 'block' }}>
              {fmtSpend(meta_paid.spend_7d)}
            </span>
            {spendBadge && <ChangePill badge={spendBadge} small />}
          </div>
        </div>
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

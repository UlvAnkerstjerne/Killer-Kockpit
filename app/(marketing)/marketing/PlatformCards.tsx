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
  return Math.round(n).toLocaleString()
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

function InstagramCard({ ig }: Pick<PlatformSnapshotData, 'ig'>) {
  const reachBadge     = fmtPct(ig.reach_change_pct)
  const engagedBadge   = fmtPct(ig.engaged_change_pct)
  const followersBadge = fmtDelta(ig.followers_delta)

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
      <div style={{ padding: '14px 16px 16px' }}>

        {/* Followers */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
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

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Reach */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
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

        {/* Engaged */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Engaged (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <path d="M10 2.5l1.8 3.6 4 .58-2.9 2.83.68 4L10 11.35l-3.58 1.88.68-4L4.2 6.68l4-.58L10 2.5Z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
              </svg>
              {fmtCompact(ig.engaged_7d)}
            </span>
          </div>
          {engagedBadge && <ChangePill badge={engagedBadge} />}
        </div>
      </div>
    </div>
  )
}

function FacebookCard({ fb }: Pick<PlatformSnapshotData, 'fb'>) {
  const pageViewsBadge   = fmtPct(fb.page_views_change_pct)
  const engagedBadge = fmtPct(fb.engaged_change_pct)
  const fansBadge    = fmtDelta(fb.fans_delta)

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

          {/* Facebook blue badge — 30×30 */}
          <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect width="28" height="28" rx="8" fill="#1877F2"/>
            <path d="M15.5 14.5h2.2l.4-2.8h-2.6v-1.6c0-.77.38-1.52 1.58-1.52H18V6.22S16.96 6 15.96 6C13.6 6 12.1 7.4 12.1 10.06v1.64H9.7v2.8h2.4V21h3.4v-6.5Z" fill="white"/>
          </svg>

          <span style={{ fontSize: '16px', fontWeight: 700, color: '#171717', lineHeight: '20px' }}>Facebook</span>
        </div>

        {/* Right-pointing chevron */}
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M5 3.5l4 3.5-4 3.5" stroke="rgba(23,23,23,0.40)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* ── Metrics ── */}
      <div style={{ padding: '14px 16px 16px' }}>

        {/* Fans */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Fans</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <circle cx="10" cy="7" r="3.5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <path d="M3.5 17c0-3.59 2.91-6.5 6.5-6.5s6.5 2.91 6.5 6.5" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
              </svg>
              {fb.fans !== null ? fmtCompact(fb.fans) : '—'}
            </span>
          </div>
          {fansBadge && <ChangePill badge={fansBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Page views */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Page Views (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <ellipse cx="10" cy="10" rx="8" ry="5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <circle cx="10" cy="10" r="2.4" stroke="#171717" strokeWidth="1.6" fill="none"/>
              </svg>
              {fmtCompact(fb.page_views_7d)}
            </span>
          </div>
          {pageViewsBadge && <ChangePill badge={pageViewsBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Engaged users */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Engaged (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <path d="M10 2.5l1.8 3.6 4 .58-2.9 2.83.68 4L10 11.35l-3.58 1.88.68-4L4.2 6.68l4-.58L10 2.5Z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
              </svg>
              {fmtCompact(fb.engaged_users_7d)}
            </span>
          </div>
          {engagedBadge && <ChangePill badge={engagedBadge} />}
        </div>
      </div>
    </div>
  )
}

function MetaPaidCard({ meta_paid }: Pick<PlatformSnapshotData, 'meta_paid'>) {
  const impressionsBadge = fmtPct(meta_paid.impressions_change_pct)
  const spendBadge       = fmtPct(meta_paid.spend_change_pct)
  const clicksBadge      = fmtPct(meta_paid.clicks_change_pct)

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

          {/* Meta blue badge — 30×30 */}
          <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect width="28" height="28" rx="8" fill="#0082FB"/>
            <path d="M6 17.5c0 1.1.85 2 1.9 2 .52 0 1.02-.22 1.38-.6L14 13.6l4.72 5.3c.36.38.86.6 1.38.6 1.05 0 1.9-.9 1.9-2 0-.5-.18-.97-.5-1.33L15.9 10H12.1L6.5 16.17c-.32.36-.5.83-.5 1.33Z" fill="white"/>
          </svg>

          <span style={{ fontSize: '16px', fontWeight: 700, color: '#171717', lineHeight: '20px' }}>Meta Paid</span>
        </div>

        {/* Right-pointing chevron */}
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M5 3.5l4 3.5-4 3.5" stroke="rgba(23,23,23,0.40)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* ── Metrics ── */}
      <div style={{ padding: '14px 16px 16px' }}>

        {/* Impressions */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Impressions (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <ellipse cx="10" cy="10" rx="8" ry="5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <circle cx="10" cy="10" r="2.4" stroke="#171717" strokeWidth="1.6" fill="none"/>
              </svg>
              {fmtCompact(meta_paid.impressions_7d)}
            </span>
          </div>
          {impressionsBadge && <ChangePill badge={impressionsBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Spend */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Spend (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <circle cx="10" cy="10" r="7.5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <path d="M10 6v8M7.5 7.5h3.75a1.25 1.25 0 010 2.5h-2.5a1.25 1.25 0 000 2.5H12" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
              </svg>
              {fmtSpend(meta_paid.spend_7d)}
            </span>
          </div>
          {spendBadge && <ChangePill badge={spendBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Clicks / Engagement */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Clicks (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <path d="M7 2v10.5l2.5-2.5 2 4.5 1.5-.7-2-4.3H14L7 2Z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
              </svg>
              {fmtCompact(meta_paid.clicks_7d)}
            </span>
          </div>
          {clicksBadge && <ChangePill badge={clicksBadge} />}
        </div>
      </div>
    </div>
  )
}

function GbpCard({ gbp }: Pick<PlatformSnapshotData, 'gbp'>) {
  const impressionsBadge = fmtPct(gbp.impressions_change_pct)
  const directionsBadge  = fmtPct(gbp.directions_change_pct)

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

          {/* GBP badge — 30×30 */}
          <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect width="28" height="28" rx="8" fill="#4285F4"/>
            <path d="M14 7a5 5 0 00-5 5c0 3.75 5 9 5 9s5-5.25 5-9a5 5 0 00-5-5Zm0 6.8a1.8 1.8 0 110-3.6 1.8 1.8 0 010 3.6Z" fill="white"/>
          </svg>

          <span style={{ fontSize: '16px', fontWeight: 700, color: '#171717', lineHeight: '20px' }}>Google Business</span>
        </div>

        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M5 3.5l4 3.5-4 3.5" stroke="rgba(23,23,23,0.40)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* ── Metrics ── */}
      <div style={{ padding: '14px 16px 16px' }}>

        {/* Impressions */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Impressions (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <ellipse cx="10" cy="10" rx="8" ry="5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <circle cx="10" cy="10" r="2.4" stroke="#171717" strokeWidth="1.6" fill="none"/>
              </svg>
              {fmtCompact(gbp.impressions_7d)}
            </span>
          </div>
          {impressionsBadge && <ChangePill badge={impressionsBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Directions */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Directions (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <path d="M10 2l8 8-8 8-8-8 8-8Z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
                <path d="M10 8v4M8 10h4" stroke="#171717" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
              {fmtCompact(gbp.directions_7d)}
            </span>
          </div>
          {directionsBadge && <ChangePill badge={directionsBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Reviews */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Reviews</div>
            <span style={{ fontSize: '26px', fontWeight: 700, color: 'rgba(23,23,23,0.25)', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <path d="M10 2.5l1.8 3.6 4 .58-2.9 2.83.68 4L10 11.35l-3.58 1.88.68-4L4.2 6.68l4-.58L10 2.5Z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
              </svg>
              —
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function WebsiteCard({ ga4 }: Pick<PlatformSnapshotData, 'ga4'>) {
  const sessionsBadge   = fmtPct(ga4.sessions_change_pct)
  const newUsersBadge   = fmtPct(ga4.new_users_change_pct)
  const pageViewsBadge  = fmtPct(ga4.page_views_change_pct)

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

          {/* Website badge — 30×30 */}
          <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect width="28" height="28" rx="8" fill="#171717"/>
            <circle cx="14" cy="14" r="7" stroke="white" strokeWidth="1.4" fill="none"/>
            <path d="M14 7c0 0-3 3-3 7s3 7 3 7M14 7c0 0 3 3 3 7s-3 7-3 7M7 14h14" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>

          <span style={{ fontSize: '16px', fontWeight: 700, color: '#171717', lineHeight: '20px' }}>Website</span>
        </div>

        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M5 3.5l4 3.5-4 3.5" stroke="rgba(23,23,23,0.40)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* ── Metrics ── */}
      <div style={{ padding: '14px 16px 16px' }}>

        {/* Sessions */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Sessions (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <path d="M7 2v10.5l2.5-2.5 2 4.5 1.5-.7-2-4.3H14L7 2Z" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
              </svg>
              {fmtCompact(ga4.sessions_7d)}
            </span>
          </div>
          {sessionsBadge && <ChangePill badge={sessionsBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* New users */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>New Users (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <circle cx="8.5" cy="7" r="3.5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <path d="M2 17c0-3.59 2.91-6.5 6.5-6.5" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                <path d="M15 11v6M12 14h6" stroke="#171717" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
              {fmtCompact(ga4.new_users_7d)}
            </span>
          </div>
          {newUsersBadge && <ChangePill badge={newUsersBadge} />}
        </div>

        <div style={{ height: '1px', background: 'rgba(23,23,23,0.07)' }} />

        {/* Page views */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', padding: '8px 0' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 500, color: 'rgba(23,23,23,0.58)', lineHeight: '15px', marginBottom: '3px' }}>Page Views (7D)</div>
            <span className="tabular-nums" style={{ fontSize: '26px', fontWeight: 700, color: '#171717', lineHeight: '30px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.45 }}>
                <ellipse cx="10" cy="10" rx="8" ry="5" stroke="#171717" strokeWidth="1.6" fill="none"/>
                <circle cx="10" cy="10" r="2.4" stroke="#171717" strokeWidth="1.6" fill="none"/>
              </svg>
              {fmtCompact(ga4.page_views_7d)}
            </span>
          </div>
          {pageViewsBadge && <ChangePill badge={pageViewsBadge} />}
        </div>
      </div>
    </div>
  )
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function PlatformCards({ snapshot }: { snapshot: PlatformSnapshotData | null }) {
  if (!snapshot) return null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" data-platform-cards="true">
      <InstagramCard ig={snapshot.ig} />
      <FacebookCard fb={snapshot.fb} />
      <MetaPaidCard meta_paid={snapshot.meta_paid} />
      <GbpCard gbp={snapshot.gbp} />
      <WebsiteCard ga4={snapshot.ga4} />
    </div>
  )
}

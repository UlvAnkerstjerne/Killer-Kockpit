/**
 * /diner/portal — Mystery Diner personal portal (server component).
 *
 * Reads the dk_identity cookie, verifies it, and loads the diner's profile
 * and visit history. Renders the DinerPortal client component.
 *
 * Unauthenticated visitors (no valid cookie) see an error page rather than
 * being redirected to any Kockpit route.
 */

import { cookies }              from 'next/headers'
import { createServiceClient }  from '@/lib/supabase/server'
import { verifyDinerIdentity, DINER_IDENTITY_COOKIE_NAME } from '@/lib/diner/identity'
import DinerPortal              from './DinerPortal'

// ─── Minimal error page (no Kockpit chrome) ──────────────────────────────────

function ErrorPage({ message }: { message: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Mystery Diner</title>
        <style>{`
          body{font-family:system-ui,sans-serif;display:flex;align-items:center;
               justify-content:center;min-height:100svh;margin:0;background:#f8f8f7}
          .card{background:#fff;border-radius:12px;padding:2rem;max-width:360px;
                text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}
          h1{font-size:1.1rem;margin:0 0 .5rem}
          p{color:#555;margin:0;font-size:.9rem}
        `}</style>
      </head>
      <body>
        <div className="card">
          <h1>Access unavailable</h1>
          <p>{message}</p>
        </div>
      </body>
    </html>
  )
}

export interface PortalLocation {
  id:   string
  name: string
}

export interface PortalVisit {
  submitted_at: string
  location_name: string | null
  score_pct:    number | null
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function DinerPortalPage() {
  // Verify identity cookie
  const jar        = await cookies()
  const cookieVal  = jar.get(DINER_IDENTITY_COOKIE_NAME)?.value ?? ''
  const identity   = verifyDinerIdentity(cookieVal)

  if (!identity) {
    return (
      <ErrorPage message="Your link has expired or is not valid. Please use your personal Mystery Diner link." />
    )
  }

  const db = createServiceClient()

  // Load diner record
  const { data: diner } = await db
    .from('diner_diners')
    .select('id, name, status')
    .eq('id', identity.dinerId)
    .maybeSingle()

  if (!diner) {
    return <ErrorPage message="Diner record not found. Please contact Killer Kebab." />
  }

  if ((diner.status as string) === 'disabled') {
    return (
      <ErrorPage message="Your Mystery Diner access has been disabled. Please contact Killer Kebab." />
    )
  }

  // Load available locations
  const { data: locRows } = await db
    .from('locations')
    .select('id, name')
    .order('name')

  const locations: PortalLocation[] = (locRows ?? []).map((l: any) => ({
    id:   l.id   as string,
    name: l.name as string,
  }))

  // Load completed visits (submitted submissions via diner_invitations with diner_id)
  const { data: visitRows } = await db
    .from('diner_invitations')
    .select('diner_submissions ( score_pct, submitted_at ), locations ( name )')
    .eq('diner_id', identity.dinerId)
    .not('diner_submissions', 'is', null)

  const visits: PortalVisit[] = (visitRows ?? [])
    .flatMap((row: any) => {
      const subs = Array.isArray(row.diner_submissions)
        ? row.diner_submissions
        : row.diner_submissions ? [row.diner_submissions] : []
      return subs
        .filter((s: any) => !!s.submitted_at)
        .map((s: any) => ({
          submitted_at:  s.submitted_at  as string,
          location_name: (row.locations as any)?.name ?? null,
          score_pct:     s.score_pct as number | null,
        }))
    })
    .sort((a: PortalVisit, b: PortalVisit) => b.submitted_at.localeCompare(a.submitted_at))

  return (
    <DinerPortal
      dinerId={diner.id as string}
      dinerName={diner.name as string}
      locations={locations}
      visits={visits}
    />
  )
}

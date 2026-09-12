import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { computeDinerStatus } from '@/lib/diner/scoring'
import type { DinerStatus } from '@/lib/diner/scoring'
import DinerLanding from './DinerLanding'

export const dynamic = 'force-dynamic'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type DinerEmailStatus = 'sent' | 'failed' | 'not_sent'

export interface DinerRosterRow {
  id:            string
  name:          string
  email:         string
  status:        'active' | 'disabled'
  created_at:    string
  disabled_at:   string | null
  visit_count:   number
  last_visit_at: string | null
  email_status:  DinerEmailStatus
  can_resend:    boolean
}

export interface DinerResultRow {
  id:                  string   // submission id
  location_id:         string | null
  location_name:       string | null
  diner_name:          string
  submitted_at:        string
  score_pct:           number | null
  critical_fail_count: number | null
  gold_star_count:     number | null
  waiting_time_band:   string | null
  final_status:        DinerStatus | null
  template_id:         string | null
}

// ─── Data fetchers ─────────────────────────────────────────────────────────────

async function getDinerRoster(): Promise<DinerRosterRow[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('diner_diners')
    .select('id, name, email, status, created_at, disabled_at, encrypted_access_url')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[kkc/diner] getDinerRoster error:', error.message)
    return []
  }

  const rows = data ?? []
  if (rows.length === 0) return []

  const dinerIds = rows.map((r: any) => r.id as string)

  // Batch load visit counts + last visit per diner
  const { data: invRows } = await db
    .from('diner_invitations')
    .select('diner_id, diner_submissions ( submitted_at, status )')
    .in('diner_id', dinerIds)

  const visitMap = new Map<string, { count: number; lastAt: string | null }>()
  for (const inv of invRows ?? []) {
    const did  = inv.diner_id as string
    const subs = Array.isArray((inv as any).diner_submissions)
      ? (inv as any).diner_submissions
      : (inv as any).diner_submissions ? [(inv as any).diner_submissions] : []
    const submitted = subs.filter((s: any) => s.status === 'submitted')
    const cur = visitMap.get(did) ?? { count: 0, lastAt: null }
    cur.count += submitted.length
    for (const s of submitted) {
      if (!cur.lastAt || (s.submitted_at as string) > cur.lastAt) {
        cur.lastAt = s.submitted_at as string
      }
    }
    visitMap.set(did, cur)
  }

  // Batch load email delivery status (most recent per diner)
  const { data: deliveries } = await db
    .from('report_deliveries')
    .select('submission_key, status')
    .eq('report_type', 'diner_access')
    .in('submission_key', dinerIds)

  const deliveryMap = new Map<string, DinerEmailStatus>()
  const byDiner = new Map<string, string[]>()
  for (const d of deliveries ?? []) {
    const arr = byDiner.get(d.submission_key as string) ?? []
    arr.push(d.status as string)
    byDiner.set(d.submission_key as string, arr)
  }
  for (const did of dinerIds) {
    const statuses = byDiner.get(did) ?? []
    if (statuses.includes('sent'))       deliveryMap.set(did, 'sent')
    else if (statuses.length > 0)        deliveryMap.set(did, 'failed')
    else                                  deliveryMap.set(did, 'not_sent')
  }

  return rows.map((row: any) => {
    const visits = visitMap.get(row.id as string) ?? { count: 0, lastAt: null }
    return {
      id:            row.id            as string,
      name:          row.name          as string,
      email:         row.email         as string,
      status:        row.status        as 'active' | 'disabled',
      created_at:    row.created_at    as string,
      disabled_at:   row.disabled_at   as string | null,
      visit_count:   visits.count,
      last_visit_at: visits.lastAt,
      email_status:  deliveryMap.get(row.id as string) ?? 'not_sent',
      can_resend:    !!(row.encrypted_access_url as string | null),
    }
  })
}

async function getDinerResults(): Promise<DinerResultRow[]> {
  const db = createServiceClient()

  // All submitted submissions
  const { data: subs, error: subErr } = await db
    .from('diner_submissions')
    .select('id, invitation_id, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status, submitted_at, template_id')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })

  if (subErr || !subs || subs.length === 0) return []

  // Fetch invitations (for location_id + diner_name + location name)
  const invIds = subs.map(s => s.invitation_id as string)
  const { data: invs } = await db
    .from('diner_invitations')
    .select('id, diner_name, location_id, locations ( name )')
    .in('id', invIds)

  const invMap = new Map((invs ?? []).map((i: any) => [i.id as string, i]))

  return subs.map((sub: any) => {
    const inv = invMap.get(sub.invitation_id as string) as any
    const scorePct  = sub.score_pct as number | null
    const critFails = (sub.critical_fail_count as number | null) ?? 0
    const dbStatus  = sub.final_status as DinerStatus | null
    const finalStatus = dbStatus ?? computeDinerStatus(scorePct, critFails)

    return {
      id:                  sub.id as string,
      location_id:         (inv?.location_id as string | null) ?? null,
      location_name:       (inv?.locations as any)?.name ?? null,
      diner_name:          (inv?.diner_name as string) ?? '—',
      submitted_at:        sub.submitted_at as string,
      score_pct:           scorePct,
      critical_fail_count: sub.critical_fail_count as number | null,
      gold_star_count:     sub.gold_star_count as number | null,
      waiting_time_band:   sub.waiting_time_band as string | null,
      final_status:        finalStatus,
      template_id:         sub.template_id as string | null,
    }
  })
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default async function DinerPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessQualityCheck(user.role)) redirect('/today')

  const [roster, results] = await Promise.all([
    getDinerRoster(),
    getDinerResults(),
  ])

  return <DinerLanding roster={roster} results={results} />
}

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { computeDinerStatus } from '@/lib/diner/scoring'
import type { DinerStatus } from '@/lib/diner/scoring'
import DinerLanding from './DinerLanding'

export const dynamic = 'force-dynamic'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DinerInvitationRow {
  id:            string
  diner_name:    string
  diner_email:   string | null
  location_id:   string | null
  location_name: string | null
  created_at:    string
  expires_at:    string
  status:        'pending' | 'active' | 'submitted' | 'expired'
  submitted_at:  string | null
  score_pct:     number | null
  submission_id: string | null
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

async function getDinerInvitations(): Promise<DinerInvitationRow[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('diner_invitations')
    .select(`
      id, diner_name, diner_email, location_id, created_at, expires_at, status,
      locations ( name ),
      diner_submissions ( id, score_pct, updated_at, status )
    `)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[kkc/diner] getDinerInvitations error:', error.message)
    return []
  }

  return (data ?? []).map((row: any) => {
    const sub = Array.isArray(row.diner_submissions)
      ? row.diner_submissions[0] ?? null
      : row.diner_submissions ?? null

    return {
      id:            row.id,
      diner_name:    row.diner_name,
      diner_email:   row.diner_email ?? null,
      location_id:   row.location_id ?? null,
      location_name: (row.locations as any)?.name ?? null,
      created_at:    row.created_at,
      expires_at:    row.expires_at,
      status:        row.status,
      submitted_at:  sub?.status === 'submitted' ? sub.updated_at : null,
      score_pct:     sub?.score_pct ?? null,
      submission_id: sub?.id ?? null,
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

  const [invitations, results] = await Promise.all([
    getDinerInvitations(),
    getDinerResults(),
  ])

  return <DinerLanding invitations={invitations} results={results} />
}

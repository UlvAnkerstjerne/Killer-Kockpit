import { redirect, notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { computeDinerStatus } from '@/lib/diner/scoring'
import type { DinerStatus } from '@/lib/diner/scoring'
import DinerResultDetail from './DinerResultDetail'

export const dynamic = 'force-dynamic'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DinerDetailCheckpoint {
  id:             string
  order_index:    number
  section:        string
  label:          string
  description:    string | null
  hint:           string | null
  type:           'scored' | 'gold_star' | 'waiting_time' | 'informational'
  is_critical:    boolean
  is_conditional: boolean
}

export interface DinerDetailResponse {
  checkpoint_id: string
  result:        'pass' | 'fail' | 'na' | null
  notes:         string | null
}

export interface DinerDetailSubmission {
  id:                  string
  location_name:       string | null
  diner_name:          string
  submitted_at:        string
  score_pct:           number | null
  critical_fail_count: number | null
  gold_star_count:     number | null
  waiting_time_band:   string | null
  final_status:        DinerStatus | null
}

// ─── Page ───────────────────────────────────────────────────────────────────

interface Props {
  params: Promise<{ submissionId: string }>
}

export default async function DinerResultPage({ params }: Props) {
  const { submissionId } = await params

  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessQualityCheck(user.role)) redirect('/today')

  const db = createServiceClient()

  // Load submission
  const { data: sub, error: subErr } = await db
    .from('diner_submissions')
    .select('id, invitation_id, template_id, submitted_at, score_pct, critical_fail_count, gold_star_count, waiting_time_band, final_status')
    .eq('id', submissionId)
    .eq('status', 'submitted')
    .single()

  if (subErr || !sub) notFound()

  // Load invitation + location in parallel with checkpoints
  const [{ data: inv }, { data: checkpointRows }, { data: responseRows }] = await Promise.all([
    db
      .from('diner_invitations')
      .select('diner_name, locations ( name )')
      .eq('id', sub.invitation_id as string)
      .single(),
    db
      .from('diner_checkpoints')
      .select('id, order_index, section, label, description, hint, type, is_critical, is_conditional')
      .eq('template_id', sub.template_id as string)
      .order('order_index', { ascending: true }),
    db
      .from('diner_responses')
      .select('checkpoint_id, result, notes')
      .eq('submission_id', submissionId),
  ])

  const locationName = (inv?.locations as unknown as { name: string } | null)?.name ?? null
  const dinerName    = (inv?.diner_name as string | null) ?? '—'

  const scorePct  = sub.score_pct  as number | null
  const critFails = (sub.critical_fail_count as number | null) ?? 0
  const dbStatus  = sub.final_status as DinerStatus | null
  const finalStatus = dbStatus ?? computeDinerStatus(scorePct, critFails)

  const submission: DinerDetailSubmission = {
    id:                  sub.id as string,
    location_name:       locationName,
    diner_name:          dinerName,
    submitted_at:        sub.submitted_at as string,
    score_pct:           scorePct,
    critical_fail_count: sub.critical_fail_count as number | null,
    gold_star_count:     sub.gold_star_count as number | null,
    waiting_time_band:   sub.waiting_time_band as string | null,
    final_status:        finalStatus,
  }

  const checkpoints: DinerDetailCheckpoint[] = (checkpointRows ?? []).map(c => ({
    id:             c.id as string,
    order_index:    c.order_index as number,
    section:        c.section as string,
    label:          c.label as string,
    description:    (c.description as string | null) ?? null,
    hint:           (c.hint as string | null) ?? null,
    type:           c.type as DinerDetailCheckpoint['type'],
    is_critical:    c.is_critical as boolean,
    is_conditional: c.is_conditional as boolean,
  }))

  const responses: DinerDetailResponse[] = (responseRows ?? []).map(r => ({
    checkpoint_id: r.checkpoint_id as string,
    result:        (r.result as 'pass' | 'fail' | 'na' | null) ?? null,
    notes:         (r.notes as string | null) ?? null,
  }))

  return (
    <DinerResultDetail
      submission={submission}
      checkpoints={checkpoints}
      responses={responses}
    />
  )
}

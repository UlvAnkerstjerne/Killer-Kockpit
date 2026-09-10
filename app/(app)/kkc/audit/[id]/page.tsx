import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'
import AuditQuestionnaire from './AuditQuestionnaire'
import AuditTopActions from './AuditTopActions'
import AuditFinalFields from './AuditFinalFields'
import AuditResultBanner from './AuditResultBanner'
import AuditSubmitBar from './AuditSubmitBar'
import type { Checkpoint, SavedResponse } from './AuditQuestionnaire'
import type { SavedTopAction } from './AuditTopActions'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function AuditSubmissionPage({ params }: Props) {
  const { id } = await params

  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessQualityCheck(user.role)) redirect('/today')

  const supabase = await createClient()

  // Load submission with related data
  const { data: submission, error } = await supabase
    .from('audit_submissions')
    .select(`
      id, status, manager_on_duty, created_at, auditor_user_id, template_id,
      final_done_well, final_focus_next, final_overall_comments,
      final_mod_informed, final_corrective_action,
      follow_up_requested, follow_up_date,
      score_pct, core_score_pct, red_flag_count,
      audit_status, manager_warning_required, submitted_at,
      locations!location_id ( name ),
      app_users!auditor_user_id ( display_name )
    `)
    .eq('id', id)
    .single()

  if (error || !submission) notFound()

  const locationName = (submission.locations as unknown as { name: string } | null)?.name ?? '—'
  const auditorName  = (submission.app_users as unknown as { display_name: string } | null)?.display_name ?? '—'

  // Load checkpoints for this template
  const { data: checkpointRows } = await supabase
    .from('audit_checkpoints')
    .select('id, sort_order, section, title, is_core_standard, is_red_flag')
    .eq('template_id', submission.template_id)
    .order('sort_order', { ascending: true })

  const checkpoints: Checkpoint[] = checkpointRows ?? []

  // Load responses, section comments, and top actions in parallel
  const [{ data: responseRows }, { data: commentRows }, { data: topActionRows }] = await Promise.all([
    supabase
      .from('audit_responses')
      .select('checkpoint_id, result')
      .eq('submission_id', id),
    supabase
      .from('audit_section_comments')
      .select('section, comment')
      .eq('submission_id', id),
    supabase
      .from('audit_top_actions')
      .select('id, sort_order, action, owner, deadline')
      .eq('submission_id', id)
      .order('sort_order', { ascending: true }),
  ])

  const initialResponses: SavedResponse[] = (responseRows ?? []).map(r => ({
    checkpoint_id: r.checkpoint_id,
    result: r.result as SavedResponse['result'],
  }))

  const initialSectionComments: Record<string, string> = {}
  for (const row of commentRows ?? []) {
    initialSectionComments[row.section] = row.comment ?? ''
  }

  const initialTopActions: SavedTopAction[] = (topActionRows ?? []).map(r => ({
    id:        r.id,
    sortOrder: r.sort_order as 1 | 2 | 3,
    action:    r.action,
    owner:     r.owner,
    deadline:  r.deadline,
  }))

  // Read-only if submitted, or if current user is not the auditor
  const isReadOnly = submission.status !== 'in_progress' || user.id !== submission.auditor_user_id

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-kk-muted">
        <Link href="/kkc/audit" className="hover:text-kk-ink transition-colors">
          Operational Audit
        </Link>
        <span>/</span>
        <span className="text-kk-ink font-medium">{locationName}</span>
      </div>

      {/* Result banner — shown after submission */}
      {submission.status === 'submitted' && (
        <AuditResultBanner
          auditStatus={submission.audit_status as string | null}
          scorePct={submission.score_pct as number | null}
          coreScorePct={submission.core_score_pct as number | null}
          redFlagCount={submission.red_flag_count as number | null}
          managerWarningRequired={submission.manager_warning_required ?? false}
          submittedAt={submission.submitted_at as string | null}
        />
      )}

      <AuditQuestionnaire
        key={`questionnaire-${submission.status}`}
        submissionId={id}
        checkpoints={checkpoints}
        initialResponses={initialResponses}
        initialSectionComments={initialSectionComments}
        isReadOnly={isReadOnly}
        locationName={locationName}
        auditorName={auditorName}
        managerOnDuty={submission.manager_on_duty}
        startedAt={submission.created_at}
      />

      <AuditTopActions
        key={`topactions-${submission.status}`}
        submissionId={id}
        isReadOnly={isReadOnly}
        initialRows={initialTopActions}
      />

      <AuditFinalFields
        key={`finalfields-${submission.status}`}
        submissionId={id}
        isReadOnly={isReadOnly}
        initialValues={{
          finalDoneWell:        submission.final_done_well        ?? '',
          finalFocusNext:       submission.final_focus_next       ?? '',
          finalOverallComments: submission.final_overall_comments ?? '',
          finalModInformed:     submission.final_mod_informed     ?? null,
          finalCorrectiveAction:submission.final_corrective_action ?? '',
          followUpRequested:    submission.follow_up_requested    ?? false,
          followUpDate:         submission.follow_up_date         ?? '',
        }}
      />

      {/* Submit bar — only for the auditor's own in-progress audit */}
      {!isReadOnly && (
        <AuditSubmitBar submissionId={id} />
      )}
    </div>
  )
}

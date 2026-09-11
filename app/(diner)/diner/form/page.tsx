/**
 * /diner/form
 *
 * Server component: verifies session, loads template + checkpoints + existing
 * responses, then renders the interactive DinerForm client component.
 *
 * Access requires a valid dk_session cookie (HttpOnly, HMAC-SHA256 signed)
 * issued by GET /diner/[token]. Invalid or missing sessions redirect to /.
 */

import { cookies } from 'next/headers'
import { redirect }  from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyDinerSession, DINER_COOKIE_NAME } from '@/lib/diner/session'
import type { DinerCheckpoint, DinerResponsesMap } from '@/lib/diner/types'
import DinerForm from './DinerForm'

export default async function DinerFormPage() {
  // ── Session ─────────────────────────────────────────────────────────────
  const cookieStore = await cookies()
  const raw         = cookieStore.get(DINER_COOKIE_NAME)
  if (!raw) redirect('/')

  const session = verifyDinerSession(raw.value)
  if (!session) redirect('/')

  const db = createServiceClient()

  // ── Submission + invitation ──────────────────────────────────────────────
  const { data: submission } = await db
    .from('diner_submissions')
    .select('id, status, template_id, invitation_id')
    .eq('id',            session.submissionId)
    .eq('invitation_id', session.invitationId)
    .maybeSingle()

  if (!submission) redirect('/')

  const { data: invitation } = await db
    .from('diner_invitations')
    .select('diner_name, location_id')
    .eq('id', session.invitationId)
    .maybeSingle()

  // ── Template + checkpoints ───────────────────────────────────────────────
  // Use the template stored on the submission if available, otherwise fall
  // back to the currently published template (for submissions created before
  // migration 058 added template_id).
  const templateId = submission.template_id

  let checkpoints: DinerCheckpoint[] = []

  if (templateId) {
    const { data } = await db
      .from('diner_checkpoints')
      .select('id, template_id, section, order_index, label, description, hint, type, is_critical, is_conditional')
      .eq('template_id', templateId)
      .order('order_index')
    checkpoints = (data ?? []) as DinerCheckpoint[]
  } else {
    // Fall back to published template
    const { data: tpl } = await db
      .from('diner_templates')
      .select('id')
      .eq('status', 'published')
      .maybeSingle()

    if (tpl) {
      const { data } = await db
        .from('diner_checkpoints')
        .select('id, template_id, section, order_index, label, description, hint, type, is_critical, is_conditional')
        .eq('template_id', tpl.id)
        .order('order_index')
      checkpoints = (data ?? []) as DinerCheckpoint[]
    }
  }

  // ── Existing responses (refresh-safe) ────────────────────────────────────
  const { data: rawResponses } = await db
    .from('diner_responses')
    .select('checkpoint_id, result, notes')
    .eq('submission_id', session.submissionId)

  const initialResponses: DinerResponsesMap = {}
  for (const r of rawResponses ?? []) {
    initialResponses[r.checkpoint_id] = {
      result: (r.result as 'pass' | 'fail' | 'na' | null) ?? null,
      notes:  r.notes ?? '',
    }
  }

  // ── Location name ────────────────────────────────────────────────────────
  let locationName: string | null = null
  if (invitation?.location_id) {
    const { data: loc } = await db
      .from('locations')
      .select('name')
      .eq('id', invitation.location_id)
      .maybeSingle()
    locationName = loc?.name ?? null
  }

  return (
    <DinerForm
      checkpoints={checkpoints}
      initialResponses={initialResponses}
      submissionId={session.submissionId}
      submissionStatus={submission.status as 'in_progress' | 'submitted'}
      dimerName={invitation?.diner_name ?? ''}
      locationName={locationName}
    />
  )
}

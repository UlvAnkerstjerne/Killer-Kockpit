/**
 * /diner/form
 *
 * Mystery Diner form — placeholder for the questionnaire.
 *
 * Access requires a valid dk_session cookie issued by GET /diner/[token].
 * Verifies session integrity and confirms the submission is still in progress
 * before rendering.
 *
 * Questionnaire, autosave, and submit UI will be added in a future iteration.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { verifyDinerSession, DINER_COOKIE_NAME } from '@/lib/diner/session'

export default async function DinerFormPage() {
  // ── Session verification ─────────────────────────────────────────────────
  const cookieStore = await cookies()
  const raw         = cookieStore.get(DINER_COOKIE_NAME)

  if (!raw) redirect('/')

  const session = verifyDinerSession(raw.value)
  if (!session) redirect('/')

  // ── Submission check ─────────────────────────────────────────────────────
  // Verify the submission still exists, belongs to the session invitation,
  // and is in progress. A submitted session should not reach the form.
  const db = createServiceClient()
  const { data: submission } = await db
    .from('diner_submissions')
    .select('id, status')
    .eq('id',            session.submissionId)
    .eq('invitation_id', session.invitationId)
    .maybeSingle()

  if (!submission) redirect('/')

  if (submission.status === 'submitted') {
    return <SubmittedMessage />
  }

  // ── Placeholder ───────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-[#f8f8f7] p-6">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">Mystery Diner Audit</h1>
        <p className="text-sm text-gray-500">
          Your session is active. The questionnaire will appear here.
        </p>
        <p className="mt-4 rounded-md bg-gray-50 px-3 py-2 font-mono text-xs text-gray-400">
          submission: {session.submissionId}
        </p>
      </div>
    </main>
  )
}

function SubmittedMessage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-[#f8f8f7] p-6">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
        <h1 className="mb-2 text-xl font-semibold">Audit submitted</h1>
        <p className="text-sm text-gray-500">
          This Mystery Diner audit has already been submitted. Thank you.
        </p>
      </div>
    </main>
  )
}

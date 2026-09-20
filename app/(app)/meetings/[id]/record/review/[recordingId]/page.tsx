import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageTranscript } from '@/lib/permissions'
import { buildSpeakerReviewItems } from '@/lib/assemblyai/transcript'
import type { AssemblyAIUtterance } from '@/lib/assemblyai/client'
import type { SpeakerMapping } from '@/lib/assemblyai/transcript'
import SpeakerReviewClient from './SpeakerReviewClient'

export const dynamic = 'force-dynamic'

export default async function SpeakerReviewPage({
  params,
}: {
  params: Promise<{ id: string; recordingId: string }>
}) {
  const [user, { id: meetingId, recordingId }] = await Promise.all([
    getCurrentUser(),
    params,
  ])
  if (!user) return null

  const db = createServiceClient()

  const [meetingResult, recordingResult] = await Promise.all([
    db
      .from('meetings')
      .select('id, title, status, owner_user_id')
      .eq('id', meetingId)
      .single(),

    db
      .from('meeting_recordings')
      .select('id, meeting_id, status, transcript_source_id, speaker_mapping, expected_speakers')
      .eq('id', recordingId)
      .single(),
  ])

  const meeting   = meetingResult.data
  const recording = recordingResult.data

  if (!meeting || !recording) notFound()
  if (recording.meeting_id !== meetingId) notFound()

  if (!canManageTranscript(user.role, meeting.owner_user_id as string | null, user.id, meeting.status as string)) {
    redirect(`/meetings/${meetingId}`)
  }

  if (recording.status !== 'needs_speaker_review') {
    redirect(`/meetings/${meetingId}`)
  }

  if (!recording.transcript_source_id) notFound()

  // Load raw utterances from source metadata
  const { data: source } = await db
    .from('sources')
    .select('metadata')
    .eq('id', recording.transcript_source_id as string)
    .single()

  const metadata   = (source?.metadata ?? {}) as Record<string, unknown>
  const utterances = (metadata.utterances as AssemblyAIUtterance[] | null) ?? []

  const reviewItems = buildSpeakerReviewItems(
    utterances,
    (recording.speaker_mapping as SpeakerMapping) ?? {},
  )

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/meetings" className="hover:text-kk-ink transition-colors">← Meetings</Link>
          <span>/</span>
          <Link href={`/meetings/${meetingId}`} className="hover:text-kk-ink transition-colors">{meeting.title}</Link>
          <span>/</span>
          <span className="text-kk-ink">Identify speakers</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Identify speakers</h1>
        <p className="text-sm text-kk-muted mt-1">
          Name each speaker so the transcript reads clearly.
        </p>
      </div>

      <SpeakerReviewClient
        meetingId={meetingId}
        recordingId={recordingId}
        reviewItems={reviewItems}
        expectedSpeakers={(recording.expected_speakers as string[]) ?? []}
      />
    </div>
  )
}

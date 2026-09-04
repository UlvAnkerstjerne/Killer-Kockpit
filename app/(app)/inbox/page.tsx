import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client } from '@/lib/google/auth'
import { listInboxMessages } from '@/lib/google/gmail'
import { canAssignToOthers, canUseGmailInbox } from '@/lib/permissions'
import { batchGetEmailActionStatus } from '@/lib/actions/gmail'
import InboxClient from './InboxClient'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!canUseGmailInbox(user.role)) redirect('/today')

  const supabase = await createClient()
  const serviceClient = createServiceClient()

  // Single token lookup — scope is available on oauthClient.credentials.scope (space-separated string).
  const [oauthResult, usersResult, projectsResult, meetingsResult, employeesResult, locationsResult] = await Promise.all([
    getGoogleOAuth2Client(user.id),
    supabase
      .from('app_users')
      .select('id, display_name, email')
      .eq('active', true)
      .order('display_name'),
    supabase
      .from('projects')
      .select('id, title')
      .is('archived_at', null)
      .not('status', 'in', '("completed","archived","cancelled")')
      .order('title'),
    serviceClient
      .from('meetings')
      .select('id, title')
      .not('status', 'eq', 'cancelled')
      .order('scheduled_start', { ascending: false })
      .limit(100),
    serviceClient
      .from('employees')
      .select('id, name')
      .eq('employment_status', 'active')
      .order('name'),
    serviceClient
      .from('locations')
      .select('id, name')
      .eq('active', true)
      .order('name'),
  ])

  const hasGmailScope = oauthResult?.credentials.scope?.includes('gmail.readonly') ?? false

  // Not connected or no Gmail scope — prompt the user
  if (!oauthResult || !hasGmailScope) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-black tracking-tight text-kk-ink mb-4">Inbox</h1>
        <div className="bg-kk-panel border border-kk-line rounded-2xl p-8 text-center space-y-3">
          <p className="text-sm text-kk-muted">
            {oauthResult
              ? 'Gmail access is not enabled. Add it from Settings.'
              : 'Connect your Google account in Settings to use the inbox.'}
          </p>
          <Link
            href="/settings"
            className="inline-block px-4 py-2 bg-kk-ink text-white text-sm rounded-xl hover:opacity-90 transition-opacity"
          >
            Go to Settings →
          </Link>
        </div>
      </div>
    )
  }

  // Fetch inbox — any error results in an empty list, not a crash
  let messages: import('@/lib/google/gmail').GmailMessageMeta[] = []
  let nextPageToken: string | null = null
  try {
    const result = await listInboxMessages(oauthResult, 15)
    messages      = result.messages
    nextPageToken = result.nextPageToken
  } catch {
    // Swallow — InboxClient will show empty state
  }

  // Batch-query actioned status for the first page — single JOIN, no N+1
  const actionedResult = messages.length > 0
    ? await batchGetEmailActionStatus(messages.map((m) => m.messageId))
    : { data: [] as string[] }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-black tracking-tight text-kk-ink mb-4">Inbox</h1>
      <InboxClient
        initialMessages={messages}
        initialNextPageToken={nextPageToken}
        currentUserId={user.id}
        users={usersResult.data ?? []}
        projects={projectsResult.data ?? []}
        meetings={meetingsResult.data ?? []}
        employees={employeesResult.data ?? []}
        locations={locationsResult.data ?? []}
        canAssign={canAssignToOthers(user.role)}
        initialActionedIds={actionedResult.data ?? []}
      />
    </div>
  )
}

import { NextResponse, type NextRequest } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getGoogleOAuth2Client, getGoogleConnectionStatus, hasGmailScope } from '@/lib/google/auth'
import { getMessageFull } from '@/lib/google/gmail'
import { extractDeadline } from '@/lib/google/gmail-deadline'

/**
 * GET /api/gmail/message/[id]
 *
 * Fetches the full body of a Gmail message for the authenticated user.
 * Returns safe plain text only — HTML is stripped server-side before responding.
 * The body is never persisted; this is ephemeral on-demand access.
 *
 * Security contract
 * -----------------
 * • Requires an active KK session.
 * • Requires the gmail.readonly scope on the stored token.
 * • Body is extracted server-side; no raw HTML is returned.
 * • Message content is never written to the KK database.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: messageId } = await params

  // Verify KK session
  const supabase = await createClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Resolve app_user id
  const serviceClient = createServiceClient()
  const { data: appUser } = await serviceClient
    .from('app_users')
    .select('id')
    .eq('auth_user_id', authUser.id)
    .eq('active', true)
    .single()
  if (!appUser) {
    return NextResponse.json({ error: 'User not found' }, { status: 401 })
  }

  // Verify Gmail scope
  const status = await getGoogleConnectionStatus(appUser.id)
  if (!status.connected || !hasGmailScope(status.scopes)) {
    return NextResponse.json({ error: 'Gmail not connected' }, { status: 403 })
  }

  const oauthClient = await getGoogleOAuth2Client(appUser.id)
  if (!oauthClient) {
    return NextResponse.json({ error: 'Google connection unavailable' }, { status: 403 })
  }

  try {
    const message = await getMessageFull(oauthClient, messageId)
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }
    // Use internalDate (Google's receipt timestamp) as the deadline reference.
    // It is more reliable than the sender-controlled Date header.
    // internalDate is epoch ms as a string; convert to ISO before passing.
    // Fall back to the Date header if internalDate is unexpectedly absent.
    const refDateStr = message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : message.date
    const deadline = extractDeadline(message.body, refDateStr)
    return NextResponse.json({
      messageId:    message.messageId,
      subject:      message.subject,
      from:         message.from,
      date:         message.date,
      internalDate: message.internalDate,
      body:         message.body,
      deadline,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch message from Gmail' }, { status: 500 })
  }
}

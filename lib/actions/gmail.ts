'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { getGoogleOAuth2Client, getGoogleConnectionStatus, hasGmailScope } from '@/lib/google/auth'
import { listInboxMessages, getMessageFull, buildGmailDeepLink } from '@/lib/google/gmail'
import type { GmailMessageMeta } from '@/lib/google/gmail'
import { createServiceClient } from '@/lib/supabase/server'
import { createTask } from '@/lib/actions/tasks'
import { createWaitingOn } from '@/lib/actions/waiting-ons'
import type { ActionResult } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────

type TaskFromEmailInput = {
  title:          string
  description?:   string
  owner_user_id?: string
  project_id?:    string
  status?:        'proposed' | 'open' | 'in_progress' | 'blocked'
  priority?:      1 | 2 | 3 | 4
  due_at?:        string
}

type WaitingOnFromEmailInput = {
  title:                  string
  owner_user_id?:         string
  waiting_for_user_id?:   string
  waiting_for_name?:      string
  project_id?:            string
  due_at?:                string
  notes?:                 string
}

// ─── Shared helpers ───────────────────────────────────────────────────────

/**
 * Resolves or creates the sources row for a Gmail message.
 * Identity = (source_type, source_account_user_id, external_id).
 * Returns the source UUID.
 */
async function ensureGmailSource(
  userId: string,
  messageId: string,
  subject: string,
  from: string,
  date: string,
  threadId: string,
  googleAccountEmail: string | null,
): Promise<string | null> {
  const serviceClient = createServiceClient()
  const url = buildGmailDeepLink(googleAccountEmail, messageId)

  // Try to resolve existing source first (handles the re-use case)
  const { data: existing } = await serviceClient
    .from('sources')
    .select('id')
    .eq('source_type', 'gmail_message')
    .eq('source_account_user_id', userId)
    .eq('external_id', messageId)
    .maybeSingle()

  if (existing) return existing.id

  // Parse date — store as ISO if valid, fall back to now
  let occurredAt: string
  try {
    occurredAt = new Date(date).toISOString()
  } catch {
    occurredAt = new Date().toISOString()
  }

  const { data: newSource, error } = await serviceClient
    .from('sources')
    .insert({
      source_type:            'gmail_message',
      source_account_user_id: userId,
      external_id:            messageId,
      title:                  subject,
      url,
      occurred_at:            occurredAt,
      metadata: {
        from,
        thread_id:           threadId,
        google_account_email: googleAccountEmail,
      },
    })
    .select('id')
    .single()

  if (error || !newSource) {
    console.error('[gmail/actions] Failed to create source:', error?.message)
    return null
  }
  return newSource.id
}

async function linkEntityToSource(
  entityType: string,
  entityId: string,
  sourceId: string,
): Promise<void> {
  const serviceClient = createServiceClient()
  await serviceClient
    .from('entity_sources')
    .upsert(
      { entity_type: entityType, entity_id: entityId, source_id: sourceId, relation: 'originated_from' },
      { onConflict: 'entity_type,entity_id,source_id,relation', ignoreDuplicates: true },
    )
}

// ─── Load more inbox messages ─────────────────────────────────────────────

/**
 * Fetches the next page of inbox messages for the authenticated user.
 * Uses Gmail's nextPageToken for cursor-based pagination — does not
 * re-fetch the first page.
 */
export async function fetchMoreInboxMessages(
  pageToken: string,
): Promise<{ messages: GmailMessageMeta[]; nextPageToken: string | null; error?: string }> {
  const user = await getCurrentUser()
  if (!user) return { messages: [], nextPageToken: null, error: 'Not authenticated' }

  const oauthClient = await getGoogleOAuth2Client(user.id)
  if (!oauthClient || !oauthClient.credentials.scope?.includes('gmail.readonly')) {
    return { messages: [], nextPageToken: null, error: 'Gmail not connected' }
  }

  try {
    return await listInboxMessages(oauthClient, 15, pageToken)
  } catch {
    return { messages: [], nextPageToken: null, error: 'Failed to fetch messages' }
  }
}

// ─── Create Task from email ───────────────────────────────────────────────

/**
 * Creates a KK Task from a Gmail message.
 * The user must explicitly submit the reviewed/edited form — nothing
 * is created automatically.
 *
 * Server-side: fetches message metadata from Gmail to build the source row
 * (never trusts client-provided metadata for provenance).
 */
export async function createTaskFromEmail(
  messageId: string,
  input: TaskFromEmailInput,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const status = await getGoogleConnectionStatus(user.id)
  if (!status.connected || !hasGmailScope(status.scopes)) {
    return { error: 'Gmail is not connected. Please connect in Settings.' }
  }

  const oauthClient = await getGoogleOAuth2Client(user.id)
  if (!oauthClient) return { error: 'Google connection unavailable.' }

  // Fetch message metadata server-side for provenance (never trust client input)
  let message
  try {
    message = await getMessageFull(oauthClient, messageId)
  } catch {
    return { error: 'Could not fetch email from Gmail. Please try again.' }
  }
  if (!message) return { error: 'Email not found in Gmail.' }

  // Create the task via the existing action (reuses auth + audit logic)
  const taskResult = await createTask(input)
  if (taskResult.error || !taskResult.data) {
    return { error: taskResult.error ?? 'Failed to create task.' }
  }

  const taskId    = taskResult.data.id
  const googleEmail = status.connected ? status.googleAccountEmail : null

  // Record provenance (non-fatal if it fails — the task was already created)
  const sourceId = await ensureGmailSource(
    user.id, messageId, message.subject, message.from,
    message.date, message.threadId, googleEmail,
  )
  if (sourceId) {
    await linkEntityToSource('task', taskId, sourceId)
  }

  revalidatePath(`/tasks/${taskId}`)
  return { data: { id: taskId } }
}

// ─── Create Waiting On from email ─────────────────────────────────────────

/**
 * Creates a KK Waiting On from a Gmail message.
 * Same review-and-confirm pattern as createTaskFromEmail.
 */
export async function createWaitingOnFromEmail(
  messageId: string,
  input: WaitingOnFromEmailInput,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const status = await getGoogleConnectionStatus(user.id)
  if (!status.connected || !hasGmailScope(status.scopes)) {
    return { error: 'Gmail is not connected. Please connect in Settings.' }
  }

  const oauthClient = await getGoogleOAuth2Client(user.id)
  if (!oauthClient) return { error: 'Google connection unavailable.' }

  let message
  try {
    message = await getMessageFull(oauthClient, messageId)
  } catch {
    return { error: 'Could not fetch email from Gmail. Please try again.' }
  }
  if (!message) return { error: 'Email not found in Gmail.' }

  const woResult = await createWaitingOn(input)
  if (woResult.error || !woResult.data) {
    return { error: woResult.error ?? 'Failed to create waiting on.' }
  }

  const woId      = woResult.data.id
  const googleEmail = status.connected ? status.googleAccountEmail : null

  const sourceId = await ensureGmailSource(
    user.id, messageId, message.subject, message.from,
    message.date, message.threadId, googleEmail,
  )
  if (sourceId) {
    await linkEntityToSource('waiting_on', woId, sourceId)
  }

  revalidatePath(`/waiting-ons/${woId}`)
  return { data: { id: woId } }
}

'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { getGoogleOAuth2Client, getGoogleConnectionStatus, hasGmailScope } from '@/lib/google/auth'
import { canUseGmailInbox, canManagePeople, canManageLocations } from '@/lib/permissions'
import { listInboxMessages, getMessageFull, buildGmailDeepLink } from '@/lib/google/gmail'
import type { GmailMessageMeta } from '@/lib/google/gmail'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { createTask } from '@/lib/actions/tasks'
import { createWaitingOn } from '@/lib/actions/waiting-ons'
import { createMeeting } from '@/lib/actions/meetings'
import { createTodo, updateTodo } from '@/lib/actions/todos'
import { wallToUtc } from '@/lib/time'
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

type MeetingFromEmailInput = {
  title:            string
  scheduled_start?: string
  scheduled_end?:   string
  location?:        string
  context?:         string
}

type TodoFromEmailInput = {
  title:        string
  priority?:    number
  notes?:       string | null
  /** YYYY-MM-DD Copenhagen wall date — null/undefined means no date. */
  scheduledFor?: string | null
}

// ─── Public types ─────────────────────────────────────────────────────────

export type EmailAction = {
  entitySourceId: string
  entityType:     string
  entityId:       string
  relation:       string
  label:          string | null
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

// ─── Create Meeting from email ────────────────────────────────────────────

/**
 * Creates a KK Meeting from a Gmail message (AI suggestion review flow).
 * The user must explicitly submit the reviewed/edited form — nothing is
 * created automatically.
 *
 * Server-side: re-fetches message metadata from Gmail to build the source row
 * (never trusts client-provided metadata for provenance).
 */
export async function createMeetingFromEmail(
  messageId: string,
  input: MeetingFromEmailInput,
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

  const meetingResult = await createMeeting(input)
  if (meetingResult.error || !meetingResult.data) {
    return { error: meetingResult.error ?? 'Failed to create meeting.' }
  }

  const meetingId   = meetingResult.data.id
  const googleEmail = status.connected ? status.googleAccountEmail : null

  // Record provenance (non-fatal — meeting already created)
  const sourceId = await ensureGmailSource(
    user.id, messageId, message.subject, message.from,
    message.date, message.threadId, googleEmail,
  )
  if (sourceId) {
    await linkEntityToSource('meeting', meetingId, sourceId)
  }

  revalidatePath(`/meetings/${meetingId}`)
  return { data: { id: meetingId } }
}

// ─── Create To-Do from email ──────────────────────────────────────────────

/**
 * Creates a KK To-Do from a Gmail message (AI suggestion review flow).
 * The user must explicitly submit the reviewed/edited form.
 *
 * Date handling: createTodo does not accept scheduled_for directly.
 * When a date is provided, it is set via updateTodo after creation
 * (non-recurring path — same mechanism used by TodoPageClient).
 *
 * Provenance: entity_sources supports free-text entity_type so 'todo'
 * is valid without schema changes.
 */
export async function createTodoFromEmail(
  messageId: string,
  input: TodoFromEmailInput,
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

  // Create via existing action (derives identity server-side, applies RLS)
  const todoResult = await createTodo(
    input.title,
    input.priority ?? 2,
    input.notes || null,
  )
  if (todoResult.error || !todoResult.data) {
    return { error: todoResult.error ?? 'Failed to create to-do.' }
  }

  const todoId = todoResult.data.id

  // Set scheduled_for on the non-recurring path if the user supplied a date
  if (input.scheduledFor) {
    await updateTodo(todoId, { scheduled_for: wallToUtc(input.scheduledFor + 'T00:00') })
  }

  // Record provenance (non-fatal — to-do already created)
  const googleEmail = status.connected ? status.googleAccountEmail : null
  const sourceId = await ensureGmailSource(
    user.id, messageId, message.subject, message.from,
    message.date, message.threadId, googleEmail,
  )
  if (sourceId) {
    await linkEntityToSource('todo', todoId, sourceId)
  }

  revalidatePath('/todos')
  revalidatePath('/today')
  return { data: { id: todoId } }
}

// ─── Batch actioned status ────────────────────────────────────────────────

/**
 * For the given list of Gmail messageIds, returns those that have at least
 * one entity linked via entity_sources — i.e., have been "actioned".
 * Single JOIN query — no N+1 per inbox row.
 */
export async function batchGetEmailActionStatus(
  messageIds: string[],
): Promise<ActionResult<string[]>> {
  if (!messageIds.length) return { data: [] }

  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const serviceClient = createServiceClient()
  const { data, error } = await serviceClient
    .from('sources')
    .select('external_id, entity_sources(id)')
    .eq('source_type', 'gmail_message')
    .eq('source_account_user_id', user.id)
    .in('external_id', messageIds)

  if (error) return { error: error.message }

  const actioned = (data ?? [])
    .filter((row) => Array.isArray(row.entity_sources) && row.entity_sources.length > 0)
    .map((row) => row.external_id as string)

  return { data: actioned }
}

// ─── Get actions for an open message ─────────────────────────────────────

/** Returns all entity_sources rows for the given Gmail message, with labels. */
export async function getMessageActions(
  messageId: string,
): Promise<ActionResult<EmailAction[]>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const serviceClient = createServiceClient()

  const { data: source } = await serviceClient
    .from('sources')
    .select('id')
    .eq('source_type', 'gmail_message')
    .eq('source_account_user_id', user.id)
    .eq('external_id', messageId)
    .maybeSingle()

  if (!source) return { data: [] }

  const { data: entitySources, error } = await serviceClient
    .from('entity_sources')
    .select('id, entity_type, entity_id, relation')
    .eq('source_id', source.id)
    .order('created_at')

  if (error) return { error: error.message }
  if (!entitySources?.length) return { data: [] }

  // Group entity IDs by type so we can batch-fetch labels
  const byType = new Map<string, string[]>()
  for (const es of entitySources) {
    const list = byType.get(es.entity_type) ?? []
    list.push(es.entity_id)
    byType.set(es.entity_type, list)
  }

  const typeToTable: Record<string, { table: string; labelCol: string }> = {
    project:    { table: 'projects',     labelCol: 'title' },
    meeting:    { table: 'meetings',     labelCol: 'title' },
    employee:   { table: 'employees',   labelCol: 'name'  },
    location:   { table: 'locations',   labelCol: 'name'  },
    task:       { table: 'tasks',       labelCol: 'title' },
    waiting_on: { table: 'waiting_ons', labelCol: 'title' },
    todo:       { table: 'todos',       labelCol: 'title' },
  }

  const labelMap = new Map<string, string>()
  await Promise.all(
    Array.from(byType.entries()).map(async ([entityType, ids]) => {
      const mapping = typeToTable[entityType]
      if (!mapping) return
      const { data: rows } = await serviceClient
        .from(mapping.table)
        .select(`id, ${mapping.labelCol}`)
        .in('id', ids)
      for (const row of (rows as unknown as Record<string, string>[]) ?? []) {
        labelMap.set(row['id'], row[mapping.labelCol] ?? null)
      }
    }),
  )

  return {
    data: entitySources.map((es) => ({
      entitySourceId: es.id,
      entityType:     es.entity_type,
      entityId:       es.entity_id,
      relation:       es.relation,
      label:          labelMap.get(es.entity_id) ?? null,
    })),
  }
}

// ─── Link email to entity ─────────────────────────────────────────────────

/**
 * Manually links a Gmail message to an existing KK entity (project, meeting,
 * employee, or location) via entity_sources with relation = 'related_to'.
 * Idempotent — duplicate calls for the same (message, entity) pair are ignored.
 */
export async function linkEmailToEntity(
  messageId: string,
  meta: { subject: string; from: string; date: string; threadId: string },
  entityType: 'project' | 'meeting' | 'employee' | 'location',
  entityId: string,
): Promise<ActionResult<{ entitySourceId: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  // Server-side role guard — page redirect is not sufficient for server actions.
  if (!canUseGmailInbox(user.role)) return { error: 'Not authorised.' }

  const status = await getGoogleConnectionStatus(user.id)
  if (!status.connected || !hasGmailScope(status.scopes)) {
    return { error: 'Gmail is not connected. Please connect in Settings.' }
  }

  // Validate the target entity exists — prevents dangling links from manipulated IDs.
  // All four types are accessible to management roles (canUseGmailInbox guard above).
  const entityTableMap: Record<typeof entityType, string> = {
    project:  'projects',
    meeting:  'meetings',
    employee: 'employees',
    location: 'locations',
  }
  const serviceClient = createServiceClient()
  const { data: entityRow } = await serviceClient
    .from(entityTableMap[entityType])
    .select('id')
    .eq('id', entityId)
    .maybeSingle()
  if (!entityRow) return { error: `${entityType} not found.` }

  const googleEmail = status.googleAccountEmail ?? null
  const sourceId = await ensureGmailSource(
    user.id, messageId, meta.subject, meta.from, meta.date, meta.threadId, googleEmail,
  )
  if (!sourceId) return { error: 'Failed to resolve email source.' }

  const { data, error } = await serviceClient
    .from('entity_sources')
    .upsert(
      { entity_type: entityType, entity_id: entityId, source_id: sourceId, relation: 'related_to' },
      { onConflict: 'entity_type,entity_id,source_id,relation', ignoreDuplicates: true },
    )
    .select('id')
    .single()

  if (error || !data) return { error: error?.message ?? 'Failed to create link.' }
  return { data: { entitySourceId: data.id } }
}

// ─── Unlink email from entity ─────────────────────────────────────────────

/**
 * Removes a manually-created 'related_to' entity_sources row.
 * Only 'related_to' relations may be unlinked — 'originated_from' rows
 * (task / waiting-on creation) are permanent.
 * Verifies the source belongs to the current user before deleting.
 */
export async function unlinkEmailFromEntity(
  entitySourceId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  const serviceClient = createServiceClient()

  const { data: es } = await serviceClient
    .from('entity_sources')
    .select('id, relation, source_id')
    .eq('id', entitySourceId)
    .maybeSingle()

  if (!es) return { error: 'Link not found.' }
  if (es.relation !== 'related_to') {
    return { error: 'Cannot remove task or waiting-on creation links.' }
  }

  const { data: source } = await serviceClient
    .from('sources')
    .select('source_account_user_id')
    .eq('id', es.source_id)
    .maybeSingle()

  if (!source || source.source_account_user_id !== user.id) {
    return { error: 'Not authorised.' }
  }

  const { error } = await serviceClient
    .from('entity_sources')
    .delete()
    .eq('id', entitySourceId)

  if (error) return { error: error.message }
  return { data: undefined }
}

// ─── Safe entity Gmail provenance read ───────────────────────────────────

/**
 * Safe metadata exposed to authorized viewers of a linked entity.
 * gmailUrl is set only when the current user IS the source owner;
 * non-owners see subject/sender/date/captured-by only — never a deep link.
 */
export type GmailSourceEntry = {
  entitySourceId: string
  sourceId:       string
  relation:       string        // 'originated_from' | 'related_to'
  subject:        string
  sender:         string | null
  occurredAt:     string | null
  capturedById:   string
  capturedByName: string
  gmailUrl:       string | null  // null when viewer is not the source owner
}

const ENTITY_TABLE_MAP: Record<string, string> = {
  project:  'projects',
  meeting:  'meetings',
  employee: 'employees',
  location: 'locations',
}

/**
 * Returns Gmail provenance entries for a given entity, visible to the
 * current user.
 *
 * Authorization model:
 *   1. Role guard: people/locations require management role.
 *   2. Entity guard: verify the target entity is accessible to the current
 *      user via their RLS-enforced client before touching any source data.
 *   3. Source fetch: service client is used for sources/entity_sources (which
 *      have SUPER_ADMIN-only RLS), but only after the above guards pass.
 *   4. gmailUrl: returned only when current user === source_account_user_id.
 *      All other callers receive null for gmailUrl.
 *
 * Safe fields returned: entitySourceId, sourceId, relation, subject,
 * sender, occurredAt, capturedById, capturedByName, gmailUrl (owner only).
 * Never returned: url for non-owners, body, tokens, raw auth data.
 */
export async function getEntityGmailSources(
  entityType: 'project' | 'meeting' | 'employee' | 'location',
  entityId: string,
): Promise<ActionResult<GmailSourceEntry[]>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  // Role guard for management-only entity types
  if (entityType === 'employee' && !canManagePeople(user.role)) {
    return { error: 'Not authorised' }
  }
  if (entityType === 'location' && !canManageLocations(user.role)) {
    return { error: 'Not authorised' }
  }

  // Verify entity access via the user's RLS-enforced client.
  // If the entity is not visible to this user the query returns null,
  // and we return empty — no provenance metadata is leaked.
  const userClient = await createClient()
  const table = ENTITY_TABLE_MAP[entityType]
  const { data: entityRow } = await userClient
    .from(table)
    .select('id')
    .eq('id', entityId)
    .maybeSingle()
  if (!entityRow) return { data: [] }

  // Fetch entity_sources → sources via service client.
  // Bypasses SUPER_ADMIN-only RLS on sources/entity_sources; safe because
  // entity access was verified above via the user's own JWT.
  const serviceClient = createServiceClient()
  const { data: links, error: linksError } = await serviceClient
    .from('entity_sources')
    .select('id, relation, source:source_id(id, source_type, title, url, metadata, occurred_at, source_account_user_id)')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)

  if (linksError) return { error: linksError.message }

  type RawSource = {
    id: string
    source_type: string
    title: string
    url: string | null
    metadata: { from?: string } | null
    occurred_at: string | null
    source_account_user_id: string | null
  }

  const gmailLinks = (links ?? [])
    .map((l) => ({
      esId:    l.id,
      relation: l.relation as string,
      source:  l.source as unknown as RawSource | null,
    }))
    .filter((l) => l.source?.source_type === 'gmail_message' && l.source.source_account_user_id)

  if (!gmailLinks.length) return { data: [] }

  // Batch-fetch captured-by display names — one query, no N+1
  const userIds = [...new Set(gmailLinks.map((l) => l.source!.source_account_user_id!))]
  const { data: appUsers } = await serviceClient
    .from('app_users')
    .select('id, display_name')
    .in('id', userIds)
  const userNameMap = new Map((appUsers ?? []).map((u: { id: string; display_name: string }) => [u.id, u.display_name]))

  const entries: GmailSourceEntry[] = gmailLinks.map(({ esId, relation, source }) => {
    const capturedById = source!.source_account_user_id!
    const isOwner      = capturedById === user.id
    return {
      entitySourceId: esId,
      sourceId:       source!.id,
      relation,
      subject:        source!.title,
      sender:         (source!.metadata as { from?: string } | null)?.from ?? null,
      occurredAt:     source!.occurred_at,
      capturedById,
      capturedByName: userNameMap.get(capturedById) ?? 'Unknown',
      // Deep link only for the source owner — never exposed to other users.
      gmailUrl:       isOwner ? (source!.url ?? null) : null,
    }
  })

  return { data: entries }
}

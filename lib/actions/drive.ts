'use server'

/**
 * lib/actions/drive.ts
 *
 * Server actions for Google Drive file references (Phase C1).
 *
 * V1 capability:
 *   • attachDriveFile  — paste a URL, resolve metadata, link to project/meeting
 *   • detachDriveFile  — remove a reference (entity_sources row only; source preserved)
 *   • getEntityDriveFiles — list linked Drive files for a project or meeting
 *
 * Architecture:
 *   • Drive sources are GLOBAL (source_account_user_id IS NULL).
 *     Drive file IDs are globally unique; unlike Gmail, the same file ID is
 *     the same file regardless of which connected Google account accessed it.
 *   • One sources row per Drive file ID.  Multiple entities can reference the
 *     same sources row via entity_sources.
 *   • We deliberately use drive.metadata.readonly — never content, downloads,
 *     or listing.  We only resolve the specific file ID the user pasted.
 *   • The sources.title is frozen at first-link time.  Subsequent links by
 *     other entities reuse the same sources row without overwriting the title.
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import {
  getGoogleOAuth2Client,
  getGoogleConnectionStatus,
  hasDriveScope,
} from '@/lib/google/auth'
import { parseDriveUrl, fetchDriveFileMeta } from '@/lib/google/drive'
import { canEditProject, canManageDriveReferences, canManageTaskDriveReferences } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { recordAuditEvent } from '@/lib/audit'
import type { ActionResult } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriveFileSource {
  entitySourceId: string
  sourceId:       string
  fileId:         string
  fileName:       string
  mimeType:       string
  webViewLink:    string
  modifiedTime:   string | null
  ownerEmail:     string | null
  sharedDriveId:  string | null
  resourceKey:    string | null
  attachedAt:     string
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Returns owner + status in one query to keep the mock surface minimal. */
async function getMeetingContext(meetingId: string): Promise<{ ownerUserId: string | null; status: string | null }> {
  const db = createServiceClient()
  const { data } = await db
    .from('meetings')
    .select('owner_user_id, status')
    .eq('id', meetingId)
    .single()
  return {
    ownerUserId: data?.owner_user_id ?? null,
    status:      data?.status ?? null,
  }
}

async function getProjectOwner(projectId: string): Promise<string | null> {
  const db = createServiceClient()
  const { data } = await db
    .from('projects')
    .select('owner_user_id')
    .eq('id', projectId)
    .single()
  return data?.owner_user_id ?? null
}

async function getTaskContext(taskId: string): Promise<{
  creatorUserId: string | null
  ownerUserId:   string | null
  status:        string | null
}> {
  const db = createServiceClient()
  const { data } = await db
    .from('tasks')
    .select('created_by_user_id, owner_user_id, status')
    .eq('id', taskId)
    .single()
  return {
    creatorUserId: data?.created_by_user_id ?? null,
    ownerUserId:   data?.owner_user_id ?? null,
    status:        data?.status ?? null,
  }
}

// ─── getEntityDriveFiles ──────────────────────────────────────────────────────

/**
 * Returns all Drive file references linked to a project or meeting.
 * Called from server components (pages) and can also be called from client
 * components via the server action RPC mechanism.
 */
export async function getEntityDriveFiles(
  entityType: 'project' | 'meeting' | 'task',
  entityId: string,
): Promise<DriveFileSource[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('entity_sources')
    .select(`
      id,
      created_at,
      source:source_id (
        id,
        source_type,
        external_id,
        title,
        url,
        occurred_at,
        metadata
      )
    `)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('relation', 'referenced_document')
    .order('created_at', { ascending: true })

  if (error || !data) return []

  return data
    .map((row) => {
      const src = Array.isArray(row.source) ? row.source[0] : row.source
      if (!src) return null
      // Extra guard: only drive_file sources (future-proof if other types use
      // referenced_document relation)
      if (src.source_type !== 'drive_file') return null

      const meta = (src.metadata ?? {}) as Record<string, unknown>
      return {
        entitySourceId: row.id,
        sourceId:       src.id,
        fileId:         src.external_id as string,
        fileName:       src.title as string,
        mimeType:       (meta.mime_type as string) ?? '',
        webViewLink:    src.url as string,
        modifiedTime:   (src.occurred_at as string | null) ?? null,
        ownerEmail:     (meta.owner_email as string | null) ?? null,
        sharedDriveId:  (meta.shared_drive_id as string | null) ?? null,
        resourceKey:    (meta.resource_key as string | null) ?? null,
        attachedAt:     row.created_at,
      } satisfies DriveFileSource
    })
    .filter((x): x is DriveFileSource => x !== null)
}

// ─── attachDriveFile ──────────────────────────────────────────────────────────

/**
 * Resolves a pasted Google Drive/Docs URL and links the file to the given entity.
 *
 * Flow:
 *  1. Authenticate + permission check
 *  2. Check Drive scope
 *  3. Parse URL (extract fileId + resourceKey)
 *  4. Fetch metadata via Drive API (validates user access, gets canonical data)
 *  5. Upsert global sources row (insert on first use; skip update on re-use
 *     to preserve the frozen title from when the file was first linked)
 *  6. Insert entity_sources row (idempotent: duplicate is a no-op)
 *  7. Audit
 */
export async function attachDriveFile(
  entityType: 'project' | 'meeting' | 'task',
  entityId: string,
  rawUrl: string,
): Promise<ActionResult<DriveFileSource>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  // ── Permission check ──────────────────────────────────────────────────────
  if (entityType === 'project') {
    const ownerUserId = await getProjectOwner(entityId)
    if (!canEditProject(user.role, ownerUserId, user.id)) {
      return { error: 'You do not have permission to attach files to this project.' }
    }
  } else if (entityType === 'task') {
    const { creatorUserId, ownerUserId, status: taskStatus } = await getTaskContext(entityId)
    if (!canManageTaskDriveReferences(user.role, creatorUserId, ownerUserId, user.id, taskStatus)) {
      return { error: 'You do not have permission to attach files to this task.' }
    }
  } else {
    const { ownerUserId, status: meetingStatus } = await getMeetingContext(entityId)
    if (!canManageDriveReferences(user.role, ownerUserId, user.id, meetingStatus)) {
      return { error: 'You do not have permission to attach files to this meeting.' }
    }
  }

  // ── Drive scope check ─────────────────────────────────────────────────────
  const googleStatus = await getGoogleConnectionStatus(user.id)
  if (!googleStatus.connected || !hasDriveScope(googleStatus.scopes)) {
    return { error: 'Google Drive is not connected. Enable Drive in Settings first.' }
  }

  const oauthClient = await getGoogleOAuth2Client(user.id)
  if (!oauthClient) return { error: 'Google connection unavailable.' }

  // ── URL parse ─────────────────────────────────────────────────────────────
  const parsed = parseDriveUrl(rawUrl)
  if (!parsed) {
    return {
      error:
        'Not a valid Google Drive or Docs link. ' +
        'Paste a URL from drive.google.com or docs.google.com.',
    }
  }

  // ── Drive API fetch ───────────────────────────────────────────────────────
  let meta
  try {
    meta = await fetchDriveFileMeta(oauthClient, parsed.fileId, parsed.resourceKey)
  } catch {
    return { error: 'Could not reach Google Drive. Please try again.' }
  }

  if ('notFound' in meta) {
    return { error: 'File not found in Google Drive. Check the link is correct.' }
  }
  if ('forbidden' in meta) {
    return { error: 'You do not have access to this file in Google Drive.' }
  }

  const db = createServiceClient()

  // ── Upsert source row ─────────────────────────────────────────────────────
  // Drive sources are GLOBAL (source_account_user_id IS NULL).
  // On first use: insert with metadata and frozen title.
  // On re-use:    do NOT update — the frozen title principle means the name
  //               stored when the file was first linked is preserved.
  const { data: existing } = await db
    .from('sources')
    .select('id')
    .eq('source_type', 'drive_file')
    .eq('external_id', meta.fileId)
    .is('source_account_user_id', null)
    .maybeSingle()

  let sourceId: string

  if (existing) {
    sourceId = existing.id
  } else {
    const { data: newSource, error: insertErr } = await db
      .from('sources')
      .insert({
        source_type:            'drive_file',
        source_account_user_id: null,
        external_id:            meta.fileId,
        title:                  meta.name,
        url:                    meta.webViewLink,
        occurred_at:            meta.modifiedTime ?? null,
        metadata: {
          mime_type:         meta.mimeType,
          owner_email:       meta.ownerEmail,
          shared_drive_id:   meta.sharedDriveId,
          resource_key:      meta.resourceKey,
          file_name_at_link: meta.name,
        },
      })
      .select('id')
      .single()

    if (insertErr || !newSource) {
      console.error('[drive/actions] Failed to insert source:', insertErr?.message)
      return { error: 'Failed to record file reference. Please try again.' }
    }
    sourceId = newSource.id
  }

  // ── Link entity_source ────────────────────────────────────────────────────
  // Check first to avoid updating a no-op on conflict (ignoreDuplicates keeps
  // the existing created_at which we need for the return value).
  const { data: existingLink } = await db
    .from('entity_sources')
    .select('id, created_at')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('source_id', sourceId)
    .eq('relation', 'referenced_document')
    .maybeSingle()

  let entitySourceId: string
  let attachedAt: string

  if (existingLink) {
    entitySourceId = existingLink.id
    attachedAt     = existingLink.created_at
  } else {
    const { data: newLink, error: linkErr } = await db
      .from('entity_sources')
      .insert({
        entity_type: entityType,
        entity_id:   entityId,
        source_id:   sourceId,
        relation:    'referenced_document',
      })
      .select('id, created_at')
      .single()

    if (linkErr || !newLink) {
      console.error('[drive/actions] Failed to insert entity_source:', linkErr?.message)
      return { error: 'Failed to link file to entity. Please try again.' }
    }
    entitySourceId = newLink.id
    attachedAt     = newLink.created_at
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  await recordAuditEvent({
    actorUserId: user.id,
    action:      'drive_reference_attached',
    entityType,
    entityId,
    afterJson: {
      file_id:       meta.fileId,
      file_name:     meta.name,
      mime_type:     meta.mimeType,
      web_view_link: meta.webViewLink,
    },
  })

  const revalidatePaths: Record<string, string> = {
    project: `/projects/${entityId}`,
    meeting: `/meetings/${entityId}`,
    task:    `/tasks/${entityId}`,
  }
  revalidatePath(revalidatePaths[entityType])

  // Return live API metadata (the user just confirmed this file)
  return {
    data: {
      entitySourceId,
      sourceId,
      fileId:        meta.fileId,
      fileName:      meta.name,
      mimeType:      meta.mimeType,
      webViewLink:   meta.webViewLink,
      modifiedTime:  meta.modifiedTime,
      ownerEmail:    meta.ownerEmail,
      sharedDriveId: meta.sharedDriveId,
      resourceKey:   meta.resourceKey,
      attachedAt,
    },
  }
}

// ─── detachDriveFile ──────────────────────────────────────────────────────────

/**
 * Removes a Drive file reference from an entity.
 *
 * Only the entity_sources row is deleted.  The shared sources row is preserved
 * — it may be referenced by other entities and is an institutional provenance
 * record even if the file has since been deleted from Drive.
 */
export async function detachDriveFile(
  entityType: 'project' | 'meeting' | 'task',
  entityId: string,
  entitySourceId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }

  // ── Permission check ──────────────────────────────────────────────────────
  if (entityType === 'project') {
    const ownerUserId = await getProjectOwner(entityId)
    if (!canEditProject(user.role, ownerUserId, user.id)) {
      return { error: 'You do not have permission to remove files from this project.' }
    }
  } else if (entityType === 'task') {
    const { creatorUserId, ownerUserId, status: taskStatus } = await getTaskContext(entityId)
    if (!canManageTaskDriveReferences(user.role, creatorUserId, ownerUserId, user.id, taskStatus)) {
      return { error: 'You do not have permission to remove files from this task.' }
    }
  } else {
    const { ownerUserId, status: meetingStatus } = await getMeetingContext(entityId)
    if (!canManageDriveReferences(user.role, ownerUserId, user.id, meetingStatus)) {
      return { error: 'You do not have permission to remove files from this meeting.' }
    }
  }

  const db = createServiceClient()

  // Fetch the row first for audit data, and to verify it belongs to this entity
  const { data: link } = await db
    .from('entity_sources')
    .select('id, source_id, source:source_id(external_id, title)')
    .eq('id', entitySourceId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .single()

  if (!link) return { error: 'File reference not found.' }

  // Delete the entity_sources row ONLY — never the shared sources row
  const { error: deleteErr } = await db
    .from('entity_sources')
    .delete()
    .eq('id', entitySourceId)

  if (deleteErr) {
    console.error('[drive/actions] Failed to delete entity_source:', deleteErr.message)
    return { error: 'Failed to remove file reference.' }
  }

  const src = Array.isArray(link.source) ? link.source[0] : link.source

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'drive_reference_detached',
    entityType,
    entityId,
    beforeJson: {
      entity_source_id: entitySourceId,
      source_id:        link.source_id,
      file_id:          src?.external_id,
      file_name:        src?.title,
    },
  })

  const revalidatePaths: Record<string, string> = {
    project: `/projects/${entityId}`,
    meeting: `/meetings/${entityId}`,
    task:    `/tasks/${entityId}`,
  }
  revalidatePath(revalidatePaths[entityType])

  return {}
}

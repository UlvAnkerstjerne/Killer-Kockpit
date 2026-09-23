'use server'

/**
 * lib/actions/meeting-attachments.ts
 *
 * Server actions for plain-text documents attached directly to meetings.
 *
 * Purpose
 * ───────
 * Allows meeting owners / managers to upload an agenda, briefing note, or
 * written minutes as a .txt or .md file.  The text content is extracted on
 * the server and stored in sources.content so the Brain can read it.
 *
 * Architecture
 * ────────────
 * • source_type = 'meeting_attachment'
 * • sources.content holds the extracted UTF-8 text (max 200 KB).
 * • sources.file_name holds the original filename for display.
 * • entity_sources links the source to the meeting with relation = 'meeting_attachment'.
 * • Deleting detaches the entity_sources row AND removes the sources row
 *   (unlike Drive files, meeting attachment sources are private to one meeting).
 *
 * Accepted formats
 * ────────────────
 * • .txt / .md     — UTF-8 text
 * • .csv           — UTF-8 text
 * • .rtf           — RTF markup stripped
 * • .pdf           — text extracted via pdf-parse (no OCR for image-only PDFs)
 * • .docx          — text extracted via mammoth (.doc binary format is NOT supported)
 * • .pptx          — slide text extracted via jszip + xmldom (mammoth transitive deps)
 * • .xlsx / .xls   — sheet rows extracted via SheetJS
 * • .doc / .ppt    — NOT supported (legacy binary formats — user must save as .docx/.pptx)
 *
 * Security
 * ────────
 * • Caller must hold canManageDriveReferences permission (same gate as Drive).
 * • All writes use createServiceClient() after application-level auth check.
 * • File content is read server-side from FormData — never exposed to the browser.
 * • source_account_user_id is set to null (attachment belongs to the meeting).
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import { canManageDriveReferences } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import { recordAuditEvent } from '@/lib/audit'
import { extractTextFromBuffer } from '@/lib/extractors/text'
import type { ActionResult } from '@/lib/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024  // 5 MB (extraction reduces actual stored text)

const ACCEPTED_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.rtf',
  '.pdf', '.docx', '.pptx',
  '.xlsx', '.xls',
])

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MeetingAttachment {
  entitySourceId: string
  sourceId:       string
  fileName:       string
  /** Truncated preview of content (first 200 chars). */
  contentPreview: string | null
  attachedAt:     string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getMeetingContext(meetingId: string): Promise<{
  ownerUserId: string | null
  status:      string | null
}> {
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

// ─── getMeetingAttachments ────────────────────────────────────────────────────

/**
 * Returns all plain-text documents attached to a meeting, ordered oldest-first.
 */
export async function getMeetingAttachments(
  meetingId: string,
): Promise<MeetingAttachment[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('entity_sources')
    .select(`
      id,
      created_at,
      source:source_id (
        id,
        file_name,
        content
      )
    `)
    .eq('entity_type', 'meeting')
    .eq('entity_id', meetingId)
    .eq('relation', 'meeting_attachment')
    .order('created_at', { ascending: true })

  if (error || !data) return []

  return data
    .map(row => {
      const src = Array.isArray(row.source) ? row.source[0] : row.source
      if (!src) return null

      const content = src.content as string | null
      return {
        entitySourceId: row.id,
        sourceId:       src.id,
        fileName:       (src.file_name as string | null) ?? 'document',
        contentPreview: content ? content.slice(0, 200) : null,
        attachedAt:     row.created_at,
      } satisfies MeetingAttachment
    })
    .filter((x): x is MeetingAttachment => x !== null)
}

// ─── attachMeetingDocument ────────────────────────────────────────────────────

/**
 * Uploads a .txt or .md file and links it to a meeting.
 *
 * Called from the meeting detail page via a <form> with enctype="multipart/form-data".
 * The `file` field must be a single File object.
 *
 * Returns the new MeetingAttachment on success.
 */
export async function attachMeetingDocument(
  meetingId: string,
  formData:  FormData,
): Promise<ActionResult<MeetingAttachment>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const { ownerUserId, status } = await getMeetingContext(meetingId)
  if (!canManageDriveReferences(user.role, ownerUserId, user.id, status)) {
    return { error: 'You do not have permission to attach documents to this meeting.' }
  }

  // ── Extract file from FormData ─────────────────────────────────────────────
  const file = formData.get('file')
  if (!file || !(file instanceof Blob)) {
    return { error: 'No file was provided.' }
  }

  const fileName = file instanceof File ? file.name : 'document.txt'
  const mimeType = file.type || 'text/plain'

  // Validate extension
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (!ACCEPTED_EXTENSIONS.has(ext)) {
    return {
      error: `Unsupported file type "${ext}". Supported: .txt, .md, .csv, .rtf, .pdf, .docx, .pptx, .xlsx, .xls`,
    }
  }

  // Check size
  if (file.size > MAX_BYTES) {
    return {
      error: `File is too large (${Math.round(file.size / 1024 / 1024 * 10) / 10} MB). Maximum is 5 MB.`,
    }
  }

  // ── Extract text content ──────────────────────────────────────────────────
  const buffer = await file.arrayBuffer()
  const extraction = await extractTextFromBuffer(buffer, fileName, mimeType)

  if (!extraction.ok) {
    return { error: extraction.error }
  }

  const content = extraction.text
  const extractionWarning = extraction.warning ?? null

  if (!content.trim()) {
    if (extractionWarning) {
      return { error: extractionWarning }
    }
    return { error: 'The file appears to be empty or contains no readable text.' }
  }

  // ── Store in sources ──────────────────────────────────────────────────────
  const db = createServiceClient()

  const { data: newSource, error: insertErr } = await db
    .from('sources')
    .insert({
      source_type:            'meeting_attachment',
      source_account_user_id: null,
      external_id:            null,    // no external ID — content lives in DB
      title:                  fileName,
      file_name:              fileName,
      content:                content,
      metadata: {
        mime_type:          mimeType,
        byte_size:          file.size,
        uploaded_by:        user.id,
        uploaded_at:        new Date().toISOString(),
        extraction_status:  'ok',
        ...(extractionWarning ? { extraction_warning: extractionWarning } : {}),
      },
    })
    .select('id')
    .single()

  if (insertErr || !newSource) {
    console.error('[meeting-attachments] Failed to insert source:', insertErr?.message)
    return { error: 'Failed to save the document. Please try again.' }
  }

  // ── Link to meeting via entity_sources ────────────────────────────────────
  const { data: newLink, error: linkErr } = await db
    .from('entity_sources')
    .insert({
      entity_type: 'meeting',
      entity_id:   meetingId,
      source_id:   newSource.id,
      relation:    'meeting_attachment',
    })
    .select('id, created_at')
    .single()

  if (linkErr || !newLink) {
    // Clean up orphan source
    await db.from('sources').delete().eq('id', newSource.id)
    console.error('[meeting-attachments] Failed to insert entity_source:', linkErr?.message)
    return { error: 'Failed to link document to meeting. Please try again.' }
  }

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'meeting_attachment_added',
    entityType:  'meeting',
    entityId:    meetingId,
    afterJson:   { source_id: newSource.id, file_name: fileName, byte_size: file.size },
  })

  revalidatePath(`/meetings/${meetingId}`)

  return {
    data: {
      entitySourceId: newLink.id,
      sourceId:       newSource.id,
      fileName,
      contentPreview: content.slice(0, 200),
      attachedAt:     newLink.created_at,
    },
  }
}

// ─── detachMeetingDocument ────────────────────────────────────────────────────

/**
 * Removes a document attachment from a meeting.
 *
 * Unlike Drive references, meeting attachment sources are private to one meeting
 * so both the entity_sources row AND the sources row are deleted.
 */
export async function detachMeetingDocument(
  meetingId:      string,
  entitySourceId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  const { ownerUserId, status } = await getMeetingContext(meetingId)
  if (!canManageDriveReferences(user.role, ownerUserId, user.id, status)) {
    return { error: 'You do not have permission to remove documents from this meeting.' }
  }

  const db = createServiceClient()

  // Fetch the link to get source_id for cascade delete and audit
  const { data: link } = await db
    .from('entity_sources')
    .select('id, source_id, source:source_id(file_name)')
    .eq('id', entitySourceId)
    .eq('entity_type', 'meeting')
    .eq('entity_id', meetingId)
    .single()

  if (!link) return { error: 'Document reference not found.' }

  // Delete entity_sources row first (FK constraint)
  const { error: deleteLink } = await db
    .from('entity_sources')
    .delete()
    .eq('id', entitySourceId)

  if (deleteLink) {
    console.error('[meeting-attachments] Failed to delete entity_source:', deleteLink.message)
    return { error: 'Failed to remove document reference.' }
  }

  // Delete the sources row (private to this meeting)
  await db.from('sources').delete().eq('id', link.source_id)

  const src = Array.isArray(link.source) ? link.source[0] : link.source

  await recordAuditEvent({
    actorUserId: user.id,
    action:      'meeting_attachment_removed',
    entityType:  'meeting',
    entityId:    meetingId,
    beforeJson:  {
      entity_source_id: entitySourceId,
      source_id:        link.source_id,
      file_name:        src?.file_name,
    },
  })

  revalidatePath(`/meetings/${meetingId}`)
  return {}
}

/**
 * lib/brain/files.ts
 *
 * Brain Drive file retrieval layer.
 *
 * fetchBrainFileContext({ entityRefs })
 * ─────────────────────────────────────
 * Fetches Google Drive file references linked to Kockpit entities
 * (projects, meetings, tasks) via the entity_sources / sources tables.
 *
 * When a Drive file has had its content extracted (sources.content is non-null),
 * that content is included in the Brain context so the AI can answer questions
 * about file contents.  When content is absent (older files, or users with only
 * drive.metadata.readonly scope), only metadata is surfaced.
 *
 * Security:
 *  - Uses createServiceClient (Brain is management-gated at the action layer).
 *  - webViewLink is a Google URL — never forward to AI as a live resource.
 *    It is included for source card display only.
 */

import { createServiceClient } from '@/lib/supabase/server'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BrainFileItem {
  sourceId:         string
  fileName:         string
  mimeType:         string
  webViewLink:      string
  modifiedAt:       string | null   // ISO date string
  entityType:       'project' | 'meeting' | 'task'
  entityId:         string
  entityName:       string
  /** Extracted plain-text content, if available. Null = not yet extracted or unsupported. */
  content:          string | null
  /** 'ok' | 'unsupported' | 'error' | 'empty' | 'no_scope' | 'pending' | null */
  extractionStatus: string | null
}

export interface BrainFileContext {
  files: BrainFileItem[]
}

// ─── fetchBrainFileContext ────────────────────────────────────────────────────

/**
 * Fetches Drive file references for the given entity references.
 *
 * @param entityRefs  Array of { entityType, entityId, entityName } to look up.
 *                   entityName is used for display in the AI context only.
 */
export async function fetchBrainFileContext({
  entityRefs,
}: {
  entityRefs: { entityType: 'project' | 'meeting' | 'task'; entityId: string; entityName: string }[]
}): Promise<BrainFileContext> {
  if (entityRefs.length === 0) return { files: [] }

  try {
    const db = createServiceClient()

    // Fetch all entity_sources rows for the given entities in one query
    const entityIds = entityRefs.map(r => r.entityId)

    const { data, error } = await db
      .from('entity_sources')
      .select(`
        entity_type,
        entity_id,
        source:source_id (
          id,
          source_type,
          title,
          url,
          occurred_at,
          metadata,
          content
        )
      `)
      .in('entity_id', entityIds)
      .eq('relation', 'referenced_document')
      .order('created_at', { ascending: true })

    if (error || !data) return { files: [] }

    // Build entity name lookup
    const entityNameMap = new Map(entityRefs.map(r => [r.entityId, r]))

    const files: BrainFileItem[] = []

    for (const row of data) {
      const ref = entityNameMap.get(row.entity_id as string)
      if (!ref) continue

      const src = Array.isArray(row.source) ? row.source[0] : row.source
      if (!src) continue
      if ((src as { source_type: string }).source_type !== 'drive_file') continue

      const srcTyped = src as {
        id: string
        source_type: string
        title: string | null
        url: string | null
        occurred_at: string | null
        metadata: Record<string, unknown> | null
        content: string | null
      }

      const meta = (srcTyped.metadata ?? {}) as Record<string, unknown>

      files.push({
        sourceId:         srcTyped.id,
        fileName:         (srcTyped.title as string) ?? 'Untitled file',
        mimeType:         (meta.mime_type as string) ?? '',
        webViewLink:      (srcTyped.url as string) ?? '',
        modifiedAt:       srcTyped.occurred_at ?? null,
        entityType:       ref.entityType,
        entityId:         ref.entityId,
        entityName:       ref.entityName,
        content:          srcTyped.content ?? null,
        extractionStatus: (meta.extraction_status as string | null) ?? null,
      })
    }

    return { files }
  } catch (err) {
    console.error('[brain/files] fetchBrainFileContext failed:', (err as Error).message)
    return { files: [] }
  }
}

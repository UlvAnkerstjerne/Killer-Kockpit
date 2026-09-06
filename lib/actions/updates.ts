'use server'

import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import type {
  ActionResult,
  KkUpdateEntityType,
  UpdateAuthor,
  UpdateEntityLinkRow,
  UpdateRow,
} from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<KkUpdateEntityType>([
  'project',
  'employee',
  'location',
])

/** /^YYYY-MM-DD$/ — format check only; DB rejects invalid calendar dates */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Loose UUID v4 format check — DB will reject malformed ids anyway */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface UpdateEntityLink {
  entity_type: KkUpdateEntityType
  entity_id:   string
}

export interface CreateUpdateInput {
  body:         string
  occurred_on?: string | null   // YYYY-MM-DD or null/undefined
  entity_links: UpdateEntityLink[]
}

// ─── createUpdate ─────────────────────────────────────────────────────────────

/**
 * Creates one Universal Update and atomically attaches it to one or more
 * entities (project, employee, location).
 *
 * The author is always the authenticated session user — never caller-supplied.
 * The transactional RPC (create_update_and_links) guarantees that either the
 * kk_updates row AND all kk_update_entities rows are persisted, or nothing is.
 *
 * Returns the new Update id on success, or a safe error string on failure.
 */
export async function createUpdate(
  input: CreateUpdateInput,
): Promise<ActionResult<{ id: string }>> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  // ── 2. Role gate (SUPER_ADMIN + UM only) ─────────────────────────────────
  if (!canAccessManagementView(user.role)) {
    return { error: 'Not authorised to create Updates.' }
  }

  // ── 3. Validate body ──────────────────────────────────────────────────────
  const body = input.body.trim()
  if (!body) return { error: 'Update body must not be blank.' }

  // ── 4. Validate entity links ──────────────────────────────────────────────
  if (!input.entity_links || input.entity_links.length === 0) {
    return { error: 'At least one entity link is required.' }
  }

  for (const link of input.entity_links) {
    if (!VALID_ENTITY_TYPES.has(link.entity_type)) {
      return { error: `Unsupported entity type: ${link.entity_type}` }
    }
    if (!link.entity_id) {
      return { error: 'Each entity link must have an entity_id.' }
    }
  }

  // ── 5. Validate occurred_on format ────────────────────────────────────────
  const occurred_on = input.occurred_on ?? null
  if (occurred_on !== null && !DATE_RE.test(occurred_on)) {
    return { error: 'occurred_on must be a date in YYYY-MM-DD format.' }
  }

  // ── 6. Transactional RPC via authenticated session client ────────────────
  // createClient() carries the user's JWT (cookie-based SSR session).
  // PostgREST sends that JWT with the request, so auth.uid() resolves inside
  // the SECURITY DEFINER function and get_my_app_user_id() returns the
  // caller's app_users.id.  No author id is supplied in the call args —
  // the DB derives and verifies identity itself.
  const supabase = await createClient()
  const { data: updateId, error } = await supabase.rpc(
    'create_update_and_links',
    {
      p_body:          body,
      p_occurred_on:   occurred_on,
      p_entity_links:  input.entity_links,
    },
  )

  if (error) {
    console.error('[createUpdate]', error.message)
    if (error.message.includes('not found')) {
      return { error: 'One or more linked entities were not found.' }
    }
    return { error: 'Failed to create Update. Please try again.' }
  }

  return { data: { id: updateId as string } }
}

// ─── getUpdatesForEntity ──────────────────────────────────────────────────────

/**
 * Returns current (non-superseded) Updates linked to a given entity,
 * enriched with author display name and all entity links for each update.
 *
 * "Current" means: no other kk_updates row's supersedes_update_id points to it.
 * At most 50 updates are returned, sorted by effective date DESC.
 */
export async function getUpdatesForEntity(
  entityType: KkUpdateEntityType,
  entityId: string,
): Promise<ActionResult<UpdateRow[]>> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }

  if (!canAccessManagementView(user.role)) {
    return { error: 'Not authorised to view Updates.' }
  }

  // ── 2. Validate inputs ────────────────────────────────────────────────────
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    return { error: `Unsupported entity type: ${entityType}` }
  }
  if (!UUID_RE.test(entityId)) {
    return { error: 'Invalid entity id.' }
  }

  const supabase = await createClient()

  // ── 3. Core query via read RPC — ordered and bounded in PostgreSQL ────────
  // get_current_updates_for_entity performs:
  //   JOIN kk_update_entities → kk_updates
  //   WHERE entity matches AND NOT EXISTS (successor)
  //   ORDER BY COALESCE(occurred_on, created_at::date) DESC, created_at DESC
  //   LIMIT LEAST(p_limit, 50)
  //
  // The LIMIT is applied AFTER the ORDER BY inside the function, so the 50
  // rows returned are the institutionally latest 50, not an arbitrary page.
  //
  // SECURITY INVOKER: the function runs as the calling user, so existing RLS
  // policies on kk_updates and kk_update_entities remain authoritative.
  // No service_role — createClient() carries the user's JWT.
  type RawUpdateRow = {
    id: string
    body: string
    occurred_on: string | null
    created_at: string
    created_by_user_id: string
    supersedes_update_id: string | null
  }

  const { data: top50, error: rpcErr } = await supabase.rpc(
    'get_current_updates_for_entity',
    { p_entity_type: entityType, p_entity_id: entityId, p_limit: 50 },
  )

  if (rpcErr) {
    console.error('[getUpdatesForEntity] rpc', rpcErr.message)
    return { error: 'Failed to load Updates. Please try again.' }
  }

  if (!top50 || (top50 as RawUpdateRow[]).length === 0) return { data: [] }

  const rows = top50 as RawUpdateRow[]
  const returnedIds = rows.map((u) => u.id)
  const authorIdSet = new Set(rows.map((u) => u.created_by_user_id).filter(Boolean))
  const authorIds = [...authorIdSet] as string[]

  // ── 6. Entity links + authors — independent, run in parallel ─────────────
  const [linksResult, authorsResult] = await Promise.all([
    supabase
      .from('kk_update_entities')
      .select('update_id, entity_type, entity_id')
      .in('update_id', returnedIds),
    authorIds.length > 0
      ? supabase.from('app_users').select('id, display_name').in('id', authorIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[], error: null }),
  ])

  const { data: allLinkRows, error: allLinkErr } = linksResult
  if (allLinkErr) {
    console.error('[getUpdatesForEntity] all-links query', allLinkErr.message)
    return { error: 'Failed to load Updates. Please try again.' }
  }

  const { data: authorRows, error: authorErr } = authorsResult
  if (authorErr) {
    console.error('[getUpdatesForEntity] author query', authorErr.message)
    // Non-fatal — author will be null in results
  }

  // ── 7. Build link map ─────────────────────────────────────────────────────
  const linkMap = new Map<string, UpdateEntityLinkRow[]>()
  for (const link of allLinkRows ?? []) {
    if (!linkMap.has(link.update_id)) linkMap.set(link.update_id, [])
    linkMap.get(link.update_id)!.push({
      entity_type: link.entity_type as KkUpdateEntityType,
      entity_id: link.entity_id,
    })
  }

  // ── 8. Build author map ───────────────────────────────────────────────────
  const authorMap = new Map<string, UpdateAuthor>()
  for (const a of authorRows ?? []) {
    authorMap.set(a.id, { id: a.id, display_name: a.display_name })
  }

  // ── 9. Assemble result ────────────────────────────────────────────────────
  const result: UpdateRow[] = rows.map((u) => ({
    id: u.id,
    body: u.body,
    occurred_on: u.occurred_on ?? null,
    created_at: u.created_at,
    author: authorMap.get(u.created_by_user_id) ?? null,
    entity_links: linkMap.get(u.id) ?? [],
  }))

  return { data: result }
}

'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import type { ActionResult, KkUpdateEntityType } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<KkUpdateEntityType>([
  'project',
  'employee',
  'location',
])

/** /^YYYY-MM-DD$/ — format check only; DB rejects invalid calendar dates */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

  // ── 6. Transactional RPC (service_role only) ──────────────────────────────
  // p_created_by_user_id is always user.id from the session — never from input.
  const serviceClient = createServiceClient()
  const { data: updateId, error } = await serviceClient.rpc(
    'create_update_and_links',
    {
      p_body:               body,
      p_occurred_on:        occurred_on,
      p_created_by_user_id: user.id,
      p_entity_links:       input.entity_links,
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

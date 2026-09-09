'use server'

/**
 * lib/actions/planday-sync.ts
 *
 * Planday P3 — lightweight ongoing roster sync server actions.
 * SUPER_ADMIN-only.
 *
 * runPlandaySync()
 *   Triggers a full roster sync from the Planday API.
 *   Re-fetches all active and deactivated employees, updates name and
 *   employment_status for mapped employees, leaves unmapped untouched.
 *   Calls planday_sync_roster via the user-JWT client so the DB records
 *   which SUPER_ADMIN triggered the sync.
 *
 * getPlandaySyncStatus()
 *   Returns last_sync_at, last_sync_status, last_sync_error from
 *   planday_credentials — safe metadata only, never credential values.
 */

import { getCurrentUser } from '@/lib/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'
import { runPlandaySyncCore } from '@/lib/planday/sync-runner'
import type { SyncResult } from '@/lib/planday/types'
import type { ActionResult } from '@/lib/types'

// ─── UI-triggered sync ────────────────────────────────────────────────────────

export async function runPlandaySync(): Promise<ActionResult<SyncResult>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessAdminSettings(user.role)) return { error: 'Not authorised' }

  try {
    const supabase = await createClient()
    const result   = await runPlandaySyncCore(supabase)
    return { data: result }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

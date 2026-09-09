/**
 * lib/planday/sync-runner.ts
 *
 * Core Planday roster sync logic — NOT a server action.
 * Called by:
 *   - lib/actions/planday-sync.ts  (SUPER_ADMIN "Sync now" — passes user-JWT client)
 *   - app/api/planday/sync/route.ts (cron — passes service-role client)
 *
 * The RPC (planday_sync_roster) handles actor identity internally:
 *   - user-JWT → actor_type='app_user', records who clicked "Sync now"
 *   - service-role (no JWT) → actor_type='system'
 *
 * Sync-metadata columns (last_sync_at, last_sync_status, last_sync_error)
 * are updated on planday_credentials via the service client after the RPC
 * completes, regardless of which client was used for the RPC.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import {
  getPlandayCredentials,
  updatePlandayPortal,
} from '@/lib/planday/auth'
import {
  getPlandayAccessToken,
  getPortal,
  getActiveEmployees,
  getDeactivatedEmployees,
} from '@/lib/planday/client'
import type { SyncResult } from '@/lib/planday/types'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildEmployeeJson(
  emps: { id: number; firstName: string | null; lastName: string | null }[],
): { external_id: string; name: string }[] {
  return emps
    .map((e) => ({
      external_id: String(e.id),
      name: [e.firstName, e.lastName].filter(Boolean).join(' ').trim(),
    }))
    .filter((e) => e.name !== '')
}

// ─── Core sync runner ─────────────────────────────────────────────────────────

/**
 * Runs a full Planday roster sync.
 *
 * @param rpcClient  Supabase client used for the RPC call.
 *   Pass `createClient()` (user-JWT) for SUPER_ADMIN UI calls.
 *   Pass `createServiceClient()` (service-role) for cron calls.
 */
export async function runPlandaySyncCore(rpcClient: SupabaseClient): Promise<SyncResult> {
  const serviceClient = createServiceClient()

  // ── 1. Load credentials ───────────────────────────────────────────────────
  const credentials = await getPlandayCredentials()

  // ── 2. Acquire fresh access token ────────────────────────────────────────
  const accessToken = await getPlandayAccessToken(
    credentials.clientId,
    credentials.refreshToken,
  )

  // ── 3. Resolve portal ─────────────────────────────────────────────────────
  const portal = await getPortal(credentials.clientId, accessToken)
  const portalId = String(portal.id)
  if (portalId !== credentials.portalId) {
    await updatePlandayPortal(portalId, portal.name)
  }

  // ── 4. Fetch employees (active + deactivated in parallel) ────────────────
  const [activeEmps, deactivatedEmps] = await Promise.all([
    getActiveEmployees(credentials.clientId, accessToken),
    getDeactivatedEmployees(credentials.clientId, accessToken),
  ])

  const totalPlanday = activeEmps.length + deactivatedEmps.length

  const activeJson      = buildEmployeeJson(activeEmps)
  const deactivatedJson = buildEmployeeJson(deactivatedEmps)

  // ── 5. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  const { data, error } = await rpcClient.rpc('planday_sync_roster', {
    p_portal_id:             portalId,
    p_active_employees:      activeJson,
    p_deactivated_employees: deactivatedJson,
  })

  // ── 6. Persist sync metadata ──────────────────────────────────────────────
  const now = new Date().toISOString()

  if (error) {
    await serviceClient
      .from('planday_credentials')
      .update({
        last_sync_at:     now,
        last_sync_status: 'error',
        last_sync_error:  error.message,
      })
      .eq('singleton_key', 'default')

    throw new Error(error.message)
  }

  await serviceClient
    .from('planday_credentials')
    .update({
      last_sync_at:     now,
      last_sync_status: 'success',
      last_sync_error:  null,
    })
    .eq('singleton_key', 'default')

  // ── 7. Return result ──────────────────────────────────────────────────────
  const rpc = data as {
    mapped_processed:          number
    names_updated:             number
    activated:                 number
    marked_left:               number
    manual_inactive_preserved: number
    management_preserved:      number
  }

  return {
    mappedProcessed:         rpc.mapped_processed,
    namesUpdated:            rpc.names_updated,
    activated:               rpc.activated,
    markedLeft:              rpc.marked_left,
    manualInactivePreserved: rpc.manual_inactive_preserved,
    managementPreserved:     rpc.management_preserved,
    unmappedCount:           totalPlanday - rpc.mapped_processed,
  }
}

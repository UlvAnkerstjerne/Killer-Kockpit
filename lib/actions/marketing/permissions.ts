'use server'

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import type { MarketingPermission } from '@/lib/marketing/types'
import type { ActionResult } from '@/lib/types'

// ─── assertSuperAdmin ─────────────────────────────────────────────────────────
// Marketing permission management is SUPER_ADMIN-only.
// The actor identity ALWAYS comes from authenticated server state — never from
// client-supplied input. A browser client can supply the target user ID and
// the permission key, but never the actor identity.

async function assertSuperAdmin() {
  const user = await getCurrentUser()
  if (!user) return { user: null as null, error: 'Not authenticated' }
  if (user.role !== 'SUPER_ADMIN') {
    return { user, error: 'Only SUPER_ADMIN can manage Marketing permissions.' }
  }
  return { user, error: undefined as undefined }
}

// ─── getUserMarketingPermissions ──────────────────────────────────────────────
// Returns the permission keys held by the given user.
// Returns an empty array if the user has no rows (including SUPER_ADMIN, who
// bypasses checks independently via hasMarketingPermission).
// Used by the Marketing layout to pass permissions to shell and pages.

export async function getUserMarketingPermissions(
  userId: string
): Promise<MarketingPermission[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('user_marketing_permissions')
    .select('permission')
    .eq('user_id', userId)

  if (error || !data) return []
  return data.map((r) => r.permission as MarketingPermission)
}

// ─── grantMarketingPermission ─────────────────────────────────────────────────
// Grants a Marketing permission to a target user.
// Returns { data: { status: 'granted' } } when a new row was inserted.
// Returns { data: { status: 'already_present' } } when the row already existed.
// No audit event is written on idempotent calls.

export async function grantMarketingPermission(
  targetUserId: string,
  permission: MarketingPermission
): Promise<ActionResult<{ status: 'granted' | 'already_present' }>> {
  const { user, error } = await assertSuperAdmin()
  if (error || !user) return { error: error ?? 'Not authenticated' }

  const serviceClient = createServiceClient()
  const { data: status, error: rpcError } = await serviceClient.rpc(
    'grant_marketing_permission_and_audit',
    {
      p_user_id:       targetUserId,
      p_permission:    permission,
      p_actor_user_id: user.id,
    }
  )

  if (rpcError) {
    console.error('[grantMarketingPermission]', rpcError)
    return { error: 'Failed to grant permission. Please try again.' }
  }

  return { data: { status: status as 'granted' | 'already_present' } }
}

// ─── revokeMarketingPermission ────────────────────────────────────────────────
// Revokes a Marketing permission from a target user.
// Returns { data: { status: 'revoked' } } when a row was deleted.
// Returns { data: { status: 'not_present' } } when no row existed.
// No audit event is written on idempotent calls.

export async function revokeMarketingPermission(
  targetUserId: string,
  permission: MarketingPermission
): Promise<ActionResult<{ status: 'revoked' | 'not_present' }>> {
  const { user, error } = await assertSuperAdmin()
  if (error || !user) return { error: error ?? 'Not authenticated' }

  const serviceClient = createServiceClient()
  const { data: status, error: rpcError } = await serviceClient.rpc(
    'revoke_marketing_permission_and_audit',
    {
      p_user_id:       targetUserId,
      p_permission:    permission,
      p_actor_user_id: user.id,
    }
  )

  if (rpcError) {
    console.error('[revokeMarketingPermission]', rpcError)
    return { error: 'Failed to revoke permission. Please try again.' }
  }

  return { data: { status: status as 'revoked' | 'not_present' } }
}

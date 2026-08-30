'use server'

import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageUsers } from '@/lib/permissions'
import type { KKRole, ActionResult } from '@/lib/types'

// All user management actions are SUPER_ADMIN only.
// Last-SUPER_ADMIN lockout: deactivating or demoting the last active
// SUPER_ADMIN is rejected to prevent a permanently locked-out organisation.

async function assertSuperAdmin(): Promise<{ user: Awaited<ReturnType<typeof getCurrentUser>>; error?: string }> {
  const user = await getCurrentUser()
  if (!user) return { user: null, error: 'Not authenticated' }
  if (!canManageUsers(user.role)) return { user, error: 'Only SUPER_ADMIN can manage users.' }
  return { user }
}

async function countActiveSuperAdmins(excludeUserId?: string): Promise<number> {
  const serviceClient = createServiceClient()
  let query = serviceClient
    .from('app_users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'SUPER_ADMIN')
    .eq('active', true)

  if (excludeUserId) {
    query = query.neq('id', excludeUserId)
  }

  const { count } = await query
  return count ?? 0
}

export async function createAppUser(input: {
  email: string
  display_name: string
  role: KKRole
}): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await assertSuperAdmin()
  if (error || !user) return { error: error ?? 'Not authenticated' }

  const serviceClient = createServiceClient()

  const { data: userId, error: rpcError } = await serviceClient.rpc('create_app_user_and_audit', {
    p_email:         input.email.trim().toLowerCase(),
    p_display_name:  input.display_name.trim(),
    p_role:          input.role,
    p_actor_user_id: user.id,
  })

  if (rpcError) {
    console.error('[createAppUser]', rpcError)
    if (rpcError.message?.includes('unique') || rpcError.code === '23505') {
      return { error: 'A user with that email already exists.' }
    }
    return { error: 'Failed to create user. Please try again.' }
  }

  revalidatePath('/team')
  revalidatePath('/team/users')
  return { data: { id: userId as string } }
}

export async function updateAppUserRole(
  targetUserId: string,
  newRole: KKRole
): Promise<ActionResult> {
  const { user, error } = await assertSuperAdmin()
  if (error || !user) return { error: error ?? 'Not authenticated' }

  const supabase = await createClient()
  const { data: target, error: fetchError } = await supabase
    .from('app_users')
    .select('id, role, active')
    .eq('id', targetUserId)
    .single()

  if (fetchError || !target) return { error: 'User not found.' }

  // Last-SUPER_ADMIN lockout: cannot demote the last active SUPER_ADMIN
  if (target.role === 'SUPER_ADMIN' && newRole !== 'SUPER_ADMIN') {
    const otherSuperAdmins = await countActiveSuperAdmins(targetUserId)
    if (otherSuperAdmins === 0) {
      return { error: 'Cannot demote the last active SUPER_ADMIN.' }
    }
  }

  if (target.role === newRole) return {}

  const serviceClient = createServiceClient()
  const { error: rpcError } = await serviceClient.rpc('update_app_user_role_and_audit', {
    p_user_id:       targetUserId,
    p_new_role:      newRole,
    p_before_role:   target.role,
    p_actor_user_id: user.id,
  })

  if (rpcError) {
    console.error('[updateAppUserRole]', rpcError)
    return { error: 'Failed to update role. Please try again.' }
  }

  revalidatePath('/team')
  revalidatePath('/team/users')
  return {}
}

export async function setAppUserActive(
  targetUserId: string,
  active: boolean
): Promise<ActionResult> {
  const { user, error } = await assertSuperAdmin()
  if (error || !user) return { error: error ?? 'Not authenticated' }

  // Cannot deactivate yourself
  if (targetUserId === user.id && !active) {
    return { error: 'You cannot deactivate your own account.' }
  }

  const supabase = await createClient()
  const { data: target, error: fetchError } = await supabase
    .from('app_users')
    .select('id, role, active')
    .eq('id', targetUserId)
    .single()

  if (fetchError || !target) return { error: 'User not found.' }

  if (target.active === active) return {}

  // Last-SUPER_ADMIN lockout: cannot deactivate the last active SUPER_ADMIN
  if (!active && target.role === 'SUPER_ADMIN') {
    const otherSuperAdmins = await countActiveSuperAdmins(targetUserId)
    if (otherSuperAdmins === 0) {
      return { error: 'Cannot deactivate the last active SUPER_ADMIN.' }
    }
  }

  const serviceClient = createServiceClient()
  const { error: rpcError } = await serviceClient.rpc('set_app_user_active_and_audit', {
    p_user_id:       targetUserId,
    p_active:        active,
    p_actor_user_id: user.id,
  })

  if (rpcError) {
    console.error('[setAppUserActive]', rpcError)
    return { error: `Failed to ${active ? 'activate' : 'deactivate'} user. Please try again.` }
  }

  revalidatePath('/team')
  revalidatePath('/team/users')
  return {}
}

import { getCurrentUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'

export async function assertMarketingRead() {
  const user = await getCurrentUser()
  if (!user) return { user: null as null, error: 'Not authenticated.' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { user: null as null, error: 'Marketing access required.' }
  }
  const db = createServiceClient()
  const { data: permRows } = await db
    .from('user_marketing_permissions')
    .select('permission')
    .eq('user_id', user.id)
  const permissions = (permRows ?? []).map((r) => r.permission as string)
  const canRead =
    user.role === 'SUPER_ADMIN' ||
    permissions.includes('reviews_manage') ||
    permissions.includes('reviews_approve')
  if (!canRead) return { user: null as null, error: 'reviews_manage or reviews_approve permission required.' }
  return { user, error: undefined as undefined }
}

export async function assertReviewsApprove() {
  const user = await getCurrentUser()
  if (!user) return { user: null as null, error: 'Not authenticated.' }
  if (!canAccessMarketing(user.role, user.marketing_access)) {
    return { user: null as null, error: 'Marketing access required.' }
  }
  const db = createServiceClient()
  const { data: permRows } = await db
    .from('user_marketing_permissions')
    .select('permission')
    .eq('user_id', user.id)
  const permissions = (permRows ?? []).map((r) => r.permission as import('@/lib/marketing/types').MarketingPermission)
  if (!hasMarketingPermission(user.role, permissions, 'reviews_approve')) {
    return { user: null as null, error: 'reviews_approve permission required.' }
  }
  return { user, error: undefined as undefined }
}

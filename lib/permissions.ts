import type { KKRole } from './types'

// Centralised permission logic — no scattered role checks in components.
// All authorisation decisions flow through this module.

export const MANAGEMENT_ROLES: KKRole[] = ['SUPER_ADMIN', 'UM']
export const ADMIN_ROLES: KKRole[] = ['SUPER_ADMIN']

export function canAccessManagementView(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

export function canAssignToOthers(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

export function canAccessAdminSettings(role: KKRole): boolean {
  return ADMIN_ROLES.includes(role)
}

export function canEditProject(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (MANAGEMENT_ROLES.includes(role)) return true
  return ownerUserId === currentUserId
}

export function canEditTask(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (MANAGEMENT_ROLES.includes(role)) return true
  return ownerUserId === currentUserId
}

export function canArchiveProject(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  return canEditProject(role, ownerUserId, currentUserId)
}

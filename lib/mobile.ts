// lib/mobile.ts
//
// Mobile feature selection for manager roles (UM, SUPER_ADMIN).
//
// Mobile features follow the ROLE only. They are deliberately independent of the
// Personal/Management data view (lib/view.ts), which decides which rows are loaded.
// Regression-protected by __tests__/unit/mobile/.

import { canAccessManagementView } from '@/lib/permissions'
import type { KKRole } from '@/lib/types'

/** Compact mobile experience: Audit/KQC shortcuts, My tasks, Meetings, short nav. */
export function hasMobileManagerExperience(role: KKRole): boolean {
  return canAccessManagementView(role)
}

/** Routes manager roles may open on a phone; everything else shows "Open this section on desktop". */
export const MOBILE_MGMT_ROUTES: readonly string[] = [
  '/today', '/todos', '/tasks', '/meetings', '/kkc/audit', '/kkc/ssp-cph',
]

export function isMobileRouteAllowed(pathname: string): boolean {
  return MOBILE_MGMT_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'))
}

/** Compact mobile nav (Notifications bell sits between Today and To-Dos). */
export const MOBILE_MGMT_NAV: readonly { href: string; label: string }[] = [
  { href: '/today', label: 'Today' },
  { href: '/todos', label: 'To-Dos' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/meetings', label: 'Meetings' },
]

/** Mobile Today shortcut buttons. */
export const MOBILE_TODAY_ACTIONS = [
  { href: '/kkc/audit', label: '+ Add Audit' },
  { href: '/kkc/ssp-cph', label: '+ Add KQC' },
] as const

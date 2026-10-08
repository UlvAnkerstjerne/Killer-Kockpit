// lib/view.ts
//
// Personal vs Management view resolution, shared by the app shell and list pages.
//
// Personal is always the default. Management is an explicit, role-gated opt-in
// (?view=management); it never activates automatically, so a manager's phone or
// a bare link always lands on their own items.

import { canAccessManagementView } from '@/lib/permissions'
import type { KKRole, ViewMode } from '@/lib/types'

export function resolveView(role: KKRole, requested: string | null | undefined): ViewMode {
  return requested === 'management' && canAccessManagementView(role) ? 'management' : 'personal'
}

/**
 * Defence in depth for personal lists: keep only rows owned by `userId`, whatever the
 * query (or RLS, which lets management roles read other users' rows) returned.
 */
export function ownedBy<T extends object, K extends keyof T>(
  rows: readonly T[],
  userId: string,
  key: K,
): T[] {
  return rows.filter(r => r[key] === userId)
}

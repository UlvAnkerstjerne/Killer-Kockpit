/**
 * Pure helper functions for prefilling the Review Task form from a TaskSuggestion.
 *
 * Kept separate from InboxClient so they can be unit-tested without a browser runtime.
 */

import type { TaskSuggestion } from '@/lib/ai/email-analysis-schema'

type UserStub = { id: string; display_name: string }

/**
 * Resolves the AI `responsible` field to a KK user ID.
 *
 * Rules:
 *   current_user → always the authenticated user
 *   named_person → case-insensitive unambiguous match in `users`; falls back to currentUserId
 *   unknown      → currentUserId (safe default, visible for human review)
 */
export function resolveTaskOwner(
  responsible: TaskSuggestion['responsible'],
  users: UserStub[],
  currentUserId: string,
): string {
  if (responsible.type === 'current_user') return currentUserId

  if (responsible.type === 'named_person' && responsible.display_name) {
    const needle = responsible.display_name.toLowerCase().trim()
    const matches = users.filter((u) => {
      const hay = u.display_name.toLowerCase().trim()
      return hay === needle || hay.includes(needle) || needle.includes(hay)
    })
    if (matches.length === 1) return matches[0].id
    // 0 matches or ambiguous → human must choose
  }

  return currentUserId
}

/**
 * Maps the AI priority_hint to the actual Task priority integer used by KK.
 *
 * KK Task priority scale:
 *   1 = Critical
 *   2 = Normal
 *   3 = Low
 *   4 = Background
 *
 * AI hint → KK priority:
 *   'high'   → 1 (Critical)
 *   'normal' → 2 (Normal)
 *   'low'    → 3 (Low)
 *   null     → 2 (Normal, default)
 */
export function priorityFromHint(hint: TaskSuggestion['priority_hint']): 1 | 2 | 3 | 4 {
  if (hint === 'high') return 1
  if (hint === 'low') return 3
  return 2
}

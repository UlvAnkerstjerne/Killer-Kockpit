/**
 * Pure helper function for resolving the "Waiting for" field from a WaitingOnSuggestion.
 *
 * Kept separate from InboxClient so it can be unit-tested without a browser runtime.
 */

type UserStub = { id: string; display_name: string }

export type ResolveWaitingForResult =
  | { type: 'internal'; userId: string }   // unique match → waiting_for_user_id
  | { type: 'external'; name: string }     // no match or ambiguous → waiting_for_name
  | { type: 'blank' }                      // waiting_for_name was null → human fills

/**
 * Resolves a free-text `waiting_for_name` from an AI suggestion to a structured result.
 *
 * Rules:
 *   null               → blank (human must fill)
 *   unique user match  → internal (waiting_for_user_id, NOT waiting_for_name)
 *   ambiguous/no match → external (waiting_for_name, NOT waiting_for_user_id)
 *
 * Never sets both. Never guesses on ambiguity.
 */
export function resolveWaitingFor(
  waitingForName: string | null,
  users: UserStub[],
): ResolveWaitingForResult {
  if (!waitingForName) return { type: 'blank' }

  const needle = waitingForName.toLowerCase().trim()
  const matches = users.filter((u) => {
    const hay = u.display_name.toLowerCase().trim()
    return hay === needle || hay.includes(needle) || needle.includes(hay)
  })

  if (matches.length === 1) return { type: 'internal', userId: matches[0].id }

  // 0 matches (external entity) or >1 matches (ambiguous) → keep as free text
  return { type: 'external', name: waitingForName }
}

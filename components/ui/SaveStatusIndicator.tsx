import type { SaveStatus } from '@/lib/hooks/useSaveState'

/**
 * Lightweight inline save-state indicator.
 * Renders nothing while idle.
 * Pair with useSaveState() to drive the status.
 */
export function SaveStatusIndicator({
  status,
  errorMsg,
}: {
  status: SaveStatus
  errorMsg: string | null
}) {
  if (status === 'saving') return <span className="text-xs text-kk-muted">Saving…</span>
  if (status === 'saved') return <span className="text-xs text-kk-good">Saved</span>
  if (status === 'error' && errorMsg) return <span className="text-xs text-kk-bad">{errorMsg}</span>
  return null
}

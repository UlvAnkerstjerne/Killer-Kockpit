'use server'

/**
 * lib/actions/marketing/meta-sync.ts
 *
 * SUPER_ADMIN-only server actions for triggering Meta sync and discovering assets.
 *
 * triggerMetaSync(): manually triggers the full Meta sync (same work as the cron).
 * discoverMetaAssets(): returns accessible Meta ad accounts + linked IG account ID.
 *   Used once during initial setup to identify the Killer Kebab assets before
 *   storing their IDs in environment variables.
 */

import { getCurrentUser } from '@/lib/auth'
import { runMetaSync, discoverMetaAssets as discoverAssets } from '@/lib/meta/sync'
import type { ActionResult } from '@/lib/types'
import type { MetaDiscoveredAssets } from '@/lib/marketing/types/meta'

// ── triggerMetaSync ────────────────────────────────────────────────────────────

export async function triggerMetaSync(): Promise<ActionResult<{ summary: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }
  if (user.role !== 'SUPER_ADMIN') return { error: 'Only SUPER_ADMIN can trigger a manual sync.' }

  const result = await runMetaSync()
  return {
    data: { summary: result.summary },
    ...(result.errors.length > 0 ? { error: result.errors.join('; ') } : {}),
  }
}

// ── discoverMetaAssets ─────────────────────────────────────────────────────────

export async function discoverMetaAssets(): Promise<ActionResult<MetaDiscoveredAssets>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated.' }
  if (user.role !== 'SUPER_ADMIN') return { error: 'Only SUPER_ADMIN can discover Meta assets.' }

  const result = await discoverAssets()
  if (!result.ok || !result.data) {
    return { error: result.error ?? 'Asset discovery failed.' }
  }

  return {
    data: {
      adAccounts:       result.data.adAccounts as MetaDiscoveredAssets['adAccounts'],
      linkedIgAccountId: result.data.linkedIgAccountId,
    },
  }
}

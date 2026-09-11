'use server'

/**
 * lib/actions/diner-invitations.ts
 *
 * Server actions for managing Mystery Diner invitations.
 *
 * Only management roles (SUPER_ADMIN, UM) can create invitations.
 * The raw token is returned exactly once — it must be copied from the
 * response and shared with the diner. It is never stored.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { generateInviteToken } from '@/lib/diner/token'
import type { ActionResult } from '@/lib/types'

export interface CreateDinerInvitationInput {
  dinerName:    string
  dinerEmail?:  string | null
  locationId?:  string | null
  /** How long the invitation link is valid for, in hours. Default 72. */
  expiresInHours?: number
}

export interface CreateDinerInvitationData {
  invitationId: string
  /** Full public URL including raw token — reveal once, then discard. */
  inviteUrl:    string
  expiresAt:    string
}

export async function createDinerInvitation(
  input: CreateDinerInvitationInput,
): Promise<ActionResult<CreateDinerInvitationData>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessManagementView(user.role)) return { error: 'Not authorised' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { error: 'Server misconfiguration: NEXT_PUBLIC_APP_URL not set' }

  const dinerName = input.dinerName.trim()
  if (!dinerName) return { error: 'Diner name is required' }

  const expiresInHours = input.expiresInHours ?? 72
  if (expiresInHours < 1 || expiresInHours > 720) {
    return { error: 'expiresInHours must be between 1 and 720' }
  }

  const expiresAt  = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
  const { rawToken, tokenHash } = generateInviteToken()

  const db = createServiceClient()

  const { data, error } = await db
    .from('diner_invitations')
    .insert({
      token_hash:         tokenHash,
      diner_name:         dinerName,
      diner_email:        input.dinerEmail ?? null,
      location_id:        input.locationId ?? null,
      created_by_user_id: user.id,
      expires_at:         expiresAt,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[diner-invitations] createDinerInvitation error:', error.message)
    return { error: 'Failed to create invitation. Please try again.' }
  }

  return {
    data: {
      invitationId: data.id,
      inviteUrl:    `${appUrl}/diner/${rawToken}`,
      expiresAt,
    },
  }
}

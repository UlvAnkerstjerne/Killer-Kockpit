'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManageLocations } from '@/lib/permissions'
import type { ActionResult } from '@/lib/types'

type LocationInput = {
  name: string
  short_name: string
  active?: boolean
}

export async function createLocation(
  input: LocationInput,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canManageLocations(user.role)) return { error: 'Not authorised' }

  const serviceClient = createServiceClient()

  const { data, error } = await serviceClient
    .from('locations')
    .insert({
      name: input.name.trim(),
      short_name: input.short_name.trim(),
      active: input.active ?? true,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { error: 'A location with that name or short name already exists.' }
    }
    console.error('[createLocation]', error)
    return { error: 'Failed to create location. Please try again.' }
  }

  revalidatePath('/locations')
  return { data: { id: data.id } }
}

export async function updateLocation(
  id: string,
  input: Partial<LocationInput>,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canManageLocations(user.role)) return { error: 'Not authorised' }

  const serviceClient = createServiceClient()

  const patch: Record<string, unknown> = {}
  if (input.name !== undefined)       patch.name       = input.name.trim()
  if (input.short_name !== undefined) patch.short_name = input.short_name.trim()
  if (input.active !== undefined)     patch.active     = input.active

  const { error } = await serviceClient
    .from('locations')
    .update(patch)
    .eq('id', id)

  if (error) {
    if (error.code === '23505') {
      return { error: 'A location with that name or short name already exists.' }
    }
    console.error('[updateLocation]', error)
    return { error: 'Failed to update location. Please try again.' }
  }

  revalidatePath('/locations')
  revalidatePath(`/locations/${id}`)
  return {}
}

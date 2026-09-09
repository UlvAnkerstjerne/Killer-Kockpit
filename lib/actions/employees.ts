'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canManagePeople } from '@/lib/permissions'
import type { ActionResult } from '@/lib/types'

type EmployeeInput = {
  name: string
  role_title?: string
  store_or_team?: string
  employment_status?: string
  birthday_month?: number | null
  birthday_day?: number | null
  started_on?: string | null
  linked_user_id?: string | null
  manager_employee_id?: string | null
}

export async function createEmployee(
  input: EmployeeInput,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canManagePeople(user.role)) return { error: 'Not authorised' }

  const serviceClient = createServiceClient()

  const hasBirthdayMonth = input.birthday_month != null
  const hasBirthdayDay   = input.birthday_day   != null
  if (hasBirthdayMonth !== hasBirthdayDay) {
    return { error: 'Birthday requires both a month and a day.' }
  }

  const { data, error } = await serviceClient
    .from('employees')
    .insert({
      name: input.name.trim(),
      role_title: input.role_title?.trim() || null,
      store_or_team: input.store_or_team?.trim() || null,
      employment_status: input.employment_status || 'active',
      birthday_month: input.birthday_month ?? null,
      birthday_day:   input.birthday_day   ?? null,
      started_on:     input.started_on     ?? null,
      linked_user_id: input.linked_user_id || null,
      manager_employee_id: input.manager_employee_id || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[createEmployee]', error)
    return { error: 'Failed to create employee. Please try again.' }
  }

  revalidatePath('/people')
  return { data: { id: data.id } }
}

export async function updateEmployee(
  id: string,
  input: Partial<EmployeeInput>,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canManagePeople(user.role)) return { error: 'Not authorised' }

  const serviceClient = createServiceClient()

  const hasBirthdayMonth = 'birthday_month' in input
  const hasBirthdayDay   = 'birthday_day'   in input
  if (hasBirthdayMonth !== hasBirthdayDay) {
    return { error: 'Birthday requires both a month and a day.' }
  }
  if (hasBirthdayMonth && hasBirthdayDay) {
    const bothNull  = input.birthday_month == null && input.birthday_day == null
    const bothValue = input.birthday_month != null && input.birthday_day != null
    if (!bothNull && !bothValue) {
      return { error: 'Birthday requires both a month and a day.' }
    }
  }

  const patch: Record<string, unknown> = {}
  if (input.name !== undefined)               patch.name               = input.name.trim()
  if (input.role_title !== undefined)         patch.role_title         = input.role_title?.trim() || null
  if (input.store_or_team !== undefined)      patch.store_or_team      = input.store_or_team?.trim() || null
  if (input.employment_status !== undefined)  patch.employment_status  = input.employment_status
  if (hasBirthdayMonth) {
    patch.birthday_month = input.birthday_month ?? null
    patch.birthday_day   = input.birthday_day   ?? null
  }
  if ('started_on' in input)                  patch.started_on         = input.started_on ?? null
  if ('linked_user_id' in input)              patch.linked_user_id     = input.linked_user_id ?? null
  if ('manager_employee_id' in input)         patch.manager_employee_id = input.manager_employee_id ?? null

  const { error } = await serviceClient
    .from('employees')
    .update(patch)
    .eq('id', id)

  if (error) {
    console.error('[updateEmployee]', error)
    return { error: 'Failed to update employee. Please try again.' }
  }

  revalidatePath('/people')
  revalidatePath(`/people/${id}`)
  return {}
}

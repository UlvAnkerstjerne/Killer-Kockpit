'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import { wallToUtc } from '@/lib/time'
import type { ActionResult } from '@/lib/types'

export type AddCreditInput = { amountUsd: number; date: string; note?: string }

/** Record a manual API credit top-up. SUPER_ADMIN only; RLS enforces it again at the database. */
export async function addAiCredit(input: AddCreditInput): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Not authenticated' }
  if (!canAccessAdminSettings(user.role)) return { error: 'You do not have permission to record AI credit.' }

  const amount = Number(input.amountUsd)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) return { error: 'Enter an amount above 0 (USD).' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || Number.isNaN(Date.parse(input.date))) return { error: 'Enter a valid date.' }
  const note = input.note?.trim() || null
  if (note && note.length > 200) return { error: 'Note must be 200 characters or fewer.' }

  const supabase = await createClient()
  const { error } = await supabase.from('ai_credit_events').insert({
    provider: 'anthropic',
    amount_usd: Math.round(amount * 100) / 100,
    occurred_at: wallToUtc(`${input.date}T00:00`),
    note,
    created_by_user_id: user.id,
  })
  if (error) {
    console.error('[addAiCredit]', error.code ?? 'error')
    return { error: 'Could not save the credit. Please try again.' }
  }
  revalidatePath('/settings/ai-usage')
  return {}
}

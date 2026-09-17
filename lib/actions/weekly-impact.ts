'use server'

import { getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { generateWeeklyImpactPreview as generatePreview } from '@/lib/weekly-impact/generate'
import { mondayForDate } from '@/lib/weekly-impact/week'
import type { ActionResult } from '@/lib/types'
import type { WeeklyImpactPreview } from '@/lib/weekly-impact/types'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export async function generateWeeklyImpactPreviewAction(
  userId: string,
  selectedDate: string,
): Promise<ActionResult<WeeklyImpactPreview>> {
  const actor = await getCurrentUser()
  if (!actor || !canAccessManagementView(actor.role)) {
    return { error: 'Management access is required.' }
  }
  if (!userId || !DATE_PATTERN.test(selectedDate)) {
    return { error: 'Choose an active user and a valid week.' }
  }

  try {
    return { data: await generatePreview(userId, mondayForDate(selectedDate)) }
  } catch (error) {
    console.error('[weekly-impact/preview] Generation failed:', error)
    return { error: error instanceof Error ? error.message : 'Weekly Impact preview failed.' }
  }
}

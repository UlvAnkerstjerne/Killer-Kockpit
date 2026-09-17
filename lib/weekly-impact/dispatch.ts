import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { currentCopenhagenDate, isCopenhagenFridayAfternoon, mondayForDate } from './week'
import { generateWeeklyImpactPreview } from './generate'
import { sendWeeklyImpactEmail, type WeeklyImpactEmailPayload } from './send-email'

export interface WeeklyImpactDispatchResult {
  status: 'disabled' | 'outside_window' | 'complete'
  users: number
  sent: number
  skipped: number
  failed: number
}

/** Scheduled runs retain the Friday 16:00 Copenhagen guard. An explicitly
 * targeted test uses the same user/week ledger and never selects the team. */
export async function runWeeklyImpactDispatch(now = new Date(), testUserId?: string): Promise<WeeklyImpactDispatchResult> {
  if (testUserId === undefined) {
    if (process.env.WEEKLY_IMPACT_DELIVERY_ENABLED !== 'true') {
      return { status: 'disabled', users: 0, sent: 0, skipped: 0, failed: 0 }
    }
    if (!isCopenhagenFridayAfternoon(now)) {
      return { status: 'outside_window', users: 0, sent: 0, skipped: 0, failed: 0 }
    }
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(testUserId)) {
    throw new Error('A single valid test user ID is required.')
  }

  const db = createServiceClient()
  const weekStart = mondayForDate(currentCopenhagenDate(now))
  let query = db.from('app_users').select('id, email').eq('active', true).order('id')
  if (testUserId !== undefined) query = query.eq('id', testUserId)
  const { data: users, error: usersError } = await query
  if (usersError) throw new Error(`Active users query failed: ${usersError.message}`)

  let sent = 0, skipped = 0, failed = 0
  for (const user of users ?? []) {
    const { data: existing, error: lookupError } = await db.from('weekly_impact_brief_deliveries')
      .select('*').eq('user_id', user.id).eq('week_start', weekStart).maybeSingle()
    if (lookupError) { failed++; continue }
    if (existing?.status === 'sent') { skipped++; continue }
    // A provider receipt is authoritative even if the final ledger write failed.
    if (existing?.resend_id) {
      const { error } = await db.from('weekly_impact_brief_deliveries')
        .update({ status: 'sent', error: null, sent_at: existing.sent_at ?? now.toISOString(), updated_at: now.toISOString() })
        .eq('id', existing.id).select('id').single()
      if (error) failed++
      else skipped++
      continue
    }
    const generationIsFresh = existing?.status === 'generating'
      && now.getTime() - new Date(existing.generation_started_at).getTime() < 30 * 60 * 1000
    if (generationIsFresh) { skipped++; continue }
    // Resend retains idempotency keys for 24h. Never automatically resend an
    // uncertain attempt beyond that protection; reconcile its provider receipt.
    if (existing?.send_started_at && now.getTime() - new Date(existing.send_started_at).getTime() >= 23 * 60 * 60 * 1000) {
      console.error('[weekly-impact] Provider reconciliation required for delivery', existing.id)
      failed++
      continue
    }

    let deliveryId: string
    if (existing) {
      const { data: claimed, error } = await db.from('weekly_impact_brief_deliveries')
        .update({ status: 'generating', error: null, attempt_count: existing.attempt_count + 1, generation_started_at: now.toISOString(), updated_at: now.toISOString() })
        .eq('id', existing.id).eq('status', existing.status).eq('attempt_count', existing.attempt_count)
        .select('id').maybeSingle()
      if (error) { failed++; continue }
      if (!claimed) { skipped++; continue }
      deliveryId = claimed.id
    } else {
      const { data: claimed, error } = await db.from('weekly_impact_brief_deliveries')
        .insert({ user_id: user.id, week_start: weekStart, generation_started_at: now.toISOString() }).select('id').single()
      if (error?.code === '23505') { skipped++; continue }
      if (error || !claimed) { failed++; continue }
      deliveryId = claimed.id
    }

    let resendId: string | null = null
    let sendStartedAt: string | null = existing?.send_started_at ?? null
    let uncertain = Boolean(sendStartedAt)
    try {
      let payload = existing?.payload_json as WeeklyImpactEmailPayload | null
      if (!payload) {
        const preview = await generateWeeklyImpactPreview(user.id, weekStart)
        payload = { recipient: user.email, subject: preview.subject, html: preview.html, text: preview.text }
        // Freeze the approved rendering before attempting delivery. Every retry
        // sends identical content under the same provider idempotency key.
        const { error } = await db.from('weekly_impact_brief_deliveries').update({
          evidence_json: preview.evidence, brief_json: preview.brief, subject: preview.subject,
          payload_json: payload, updated_at: now.toISOString(),
        }).eq('id', deliveryId).select('id').single()
        if (error) throw new Error(`Could not save delivery payload: ${error.message}`)
      }
      sendStartedAt ??= new Date().toISOString()
      const { error: startError } = await db.from('weekly_impact_brief_deliveries')
        .update({ send_started_at: sendStartedAt }).eq('id', deliveryId).select('id').single()
      if (startError) throw new Error(`Could not record send attempt: ${startError.message}`)
      uncertain = true
      const result = await sendWeeklyImpactEmail(payload, `weekly-impact/${user.id}/${weekStart}`)
      if (!result.ok) {
        uncertain = result.uncertain
        throw new Error(result.error)
      }
      resendId = result.id
      const { error } = await db.from('weekly_impact_brief_deliveries').update({
        status: 'sent', error: null, resend_id: resendId,
        sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', deliveryId).select('id').single()
      if (error) throw new Error(`Email accepted; ledger update failed: ${error.message}`)
      sent++
    } catch (error) {
      const { error: recordError } = await db.from('weekly_impact_brief_deliveries').update({
        status: 'failed', resend_id: resendId, send_started_at: uncertain ? sendStartedAt : null,
        error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown failure', updated_at: new Date().toISOString(),
      }).eq('id', deliveryId).select('id').single()
      if (recordError) console.error('[weekly-impact] Could not record failed attempt', deliveryId)
      failed++
    }
  }
  return { status: 'complete', users: users?.length ?? 0, sent, skipped, failed }
}

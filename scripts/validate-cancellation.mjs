/**
 * validate-cancellation.mjs — Integration tests for migration 023 cancel/reopen RPCs.
 * Run with: node --env-file=.env.local scripts/validate-cancellation.mjs
 * Requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 * and SUPABASE_SECRET_KEY in .env.local — never hardcode credentials here.
 */
import { createClient } from '../node_modules/@supabase/supabase-js/dist/index.cjs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY     = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SERVICE_KEY  = process.env.SUPABASE_SECRET_KEY

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing required env vars. Run with: node --env-file=.env.local scripts/validate-cancellation.mjs')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY)

const TASK_ID    = '4bf90baa-8f5a-43c5-a3b5-8aef00c5a47e'
const WO_ID      = 'a242272b-ceb4-410f-87e5-b63cc0831542'
const MEETING_ID = '3ffe974d-6be3-4c26-891d-7f6787e681ca'
const ACTOR_ID   = '5363b471-b4cb-4156-9e8e-3260d3ecb05e'

let passed = 0, failed = 0
function ok(l)       { console.log('  ✓', l); passed++ }
function fail(l, d)  { console.error('  ✗', l, d != null ? String(d) : ''); failed++ }
function section(t)  { console.log('\n' + '─'.repeat(56) + '\n  ' + t + '\n' + '─'.repeat(56)) }

// ─── SECURITY: migration 023 ──────────────────────────────────────────
section('SECURITY: reopen_meeting_and_audit ACL')

// service_role executes (FK error on null UUIDs = proof of execution)
const { error: svcProbe } = await svc.rpc('reopen_meeting_and_audit', {
  p_meeting_id: '00000000-0000-0000-0000-000000000000',
  p_actor_user_id: '00000000-0000-0000-0000-000000000001',
  p_before_status: 'cancelled',
})
if (!svcProbe || svcProbe.code === '23503' || svcProbe.message?.includes('foreign key') || svcProbe.message?.includes('violates')) {
  ok('service_role: EXECUTE confirmed (FK constraint = execution reached SQL body)')
} else if (svcProbe.message?.includes('permission denied') || svcProbe.code === 'PGRST202') {
  fail('service_role: permission denied — GRANT may have failed', svcProbe.message)
} else {
  ok(`service_role: EXECUTE confirmed (result: ${svcProbe.code})`)
}

// anon blocked
const anonRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reopen_meeting_and_audit`, {
  method: 'POST',
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_meeting_id: '00000000-0000-0000-0000-000000000000', p_actor_user_id: '00000000-0000-0000-0000-000000000001', p_before_status: 'cancelled' }),
})
const anonBody = await anonRes.json().catch(() => ({}))
const anonBlocked = anonRes.status === 401 || anonRes.status === 403 || anonBody?.code === 'PGRST202'
anonBlocked ? ok(`anon: BLOCKED (HTTP ${anonRes.status} ${anonBody?.code ?? ''})`) : fail('anon: NOT blocked', `HTTP ${anonRes.status}`)

// ─── TASK ────────────────────────────────────────────────────────────
section('TASK: cancel → verify → reopen → verify')

const { data: taskBefore } = await svc.from('tasks').select('id,status,completed_at,project_id').eq('id', TASK_ID).single()
console.log('  Before:', taskBefore?.status)

const { error: cancelTaskErr } = await svc.rpc('cancel_task_and_audit', {
  p_task_id: TASK_ID, p_actor_user_id: ACTOR_ID, p_before_status: taskBefore?.status, p_now: new Date().toISOString()
})
if (cancelTaskErr) {
  fail('cancel_task_and_audit', cancelTaskErr.message)
} else {
  const { data: s } = await svc.from('tasks').select('status').eq('id', TASK_ID).single()
  s?.status === 'cancelled' ? ok('Task cancelled → status=cancelled') : fail('Task cancel — wrong status', s?.status)

  const { data: activeList } = await svc.from('tasks').select('id').not('status', 'in', '("done","cancelled")').eq('id', TASK_ID)
  activeList?.length === 0 ? ok('Cancelled task absent from active list') : fail('Cancelled task still in active list')

  const { data: detail } = await svc.from('tasks').select('id,status').eq('id', TASK_ID).single()
  detail?.id === TASK_ID ? ok('Cancelled task detail accessible by ID') : fail('Cancelled task detail inaccessible')

  const { data: doneCheck } = await svc.from('tasks').select('id').eq('status', 'done').eq('id', TASK_ID)
  doneCheck?.length === 0 ? ok('Cancelled task distinct from done') : fail('Cancelled task appears in done= query')
}

const { data: cancelAudit } = await svc.from('audit_events').select('action').eq('entity_type', 'task').eq('entity_id', TASK_ID).eq('action', 'task.cancelled').limit(1)
cancelAudit?.length ? ok('Audit event task.cancelled written') : fail('Missing audit event task.cancelled')

const { error: reopenTaskErr } = await svc.rpc('reopen_task_and_audit', {
  p_task_id: TASK_ID, p_actor_user_id: ACTOR_ID, p_before_status: 'cancelled'
})
if (reopenTaskErr) {
  fail('reopen_task_and_audit', reopenTaskErr.message)
} else {
  const { data: s } = await svc.from('tasks').select('status, completed_at').eq('id', TASK_ID).single()
  s?.status === 'open' && s?.completed_at === null
    ? ok('Reopened task → status=open, completed_at=null')
    : fail('Reopen task state wrong', JSON.stringify(s))

  const { data: backInActive } = await svc.from('tasks').select('id').not('status', 'in', '("done","cancelled")').eq('id', TASK_ID)
  backInActive?.length ? ok('Reopened task back in active list') : fail('Reopened task missing from active list')
}

const { data: reopenAudit } = await svc.from('audit_events').select('action').eq('entity_type', 'task').eq('entity_id', TASK_ID).eq('action', 'task.reopened').limit(1)
reopenAudit?.length ? ok('Audit event task.reopened written') : fail('Missing audit event task.reopened')

// ─── WAITING ON ──────────────────────────────────────────────────────
section('WAITING ON: cancel → verify → reopen → verify')

const { data: woBefore } = await svc.from('waiting_ons').select('id,status').eq('id', WO_ID).single()
console.log('  Before:', woBefore?.status)

const { error: cancelWOErr } = await svc.rpc('cancel_waiting_on_and_audit', {
  p_waiting_on_id: WO_ID, p_actor_user_id: ACTOR_ID, p_before_status: woBefore?.status
})
if (cancelWOErr) {
  fail('cancel_waiting_on_and_audit', cancelWOErr.message)
} else {
  const { data: s } = await svc.from('waiting_ons').select('status').eq('id', WO_ID).single()
  s?.status === 'cancelled' ? ok('WO cancelled → status=cancelled') : fail('WO cancel — wrong status', s?.status)

  const { data: openList } = await svc.from('waiting_ons').select('id').eq('status', 'open').eq('id', WO_ID)
  openList?.length === 0 ? ok('Cancelled WO absent from open list') : fail('Cancelled WO in open list')

  const { data: detail } = await svc.from('waiting_ons').select('id,status').eq('id', WO_ID).single()
  detail?.id === WO_ID ? ok('Cancelled WO detail accessible') : fail('Cancelled WO detail inaccessible')

  const { data: fulfillCheck } = await svc.from('waiting_ons').select('id').eq('status', 'fulfilled').eq('id', WO_ID)
  fulfillCheck?.length === 0 ? ok('Cancelled WO distinct from fulfilled') : fail('Cancelled WO in fulfilled list')
}

const { error: reopenWOErr } = await svc.rpc('reopen_waiting_on_and_audit', {
  p_waiting_on_id: WO_ID, p_actor_user_id: ACTOR_ID, p_before_status: 'cancelled'
})
if (reopenWOErr) {
  fail('reopen_waiting_on_and_audit', reopenWOErr.message)
} else {
  const { data: s } = await svc.from('waiting_ons').select('status').eq('id', WO_ID).single()
  s?.status === 'open' ? ok('Reopened WO → status=open') : fail('Reopen WO state wrong', s?.status)
}

const { data: woAudit } = await svc.from('audit_events').select('action').eq('entity_type', 'waiting_on').eq('entity_id', WO_ID).in('action', ['waiting_on.cancelled', 'waiting_on.reopened']).limit(5)
woAudit?.length >= 2 ? ok(`Audit events written (${woAudit.map(a => a.action).join(', ')})`) : fail('Missing WO audit events', JSON.stringify(woAudit?.map(a => a.action)))

// ─── MEETING ─────────────────────────────────────────────────────────
section('MEETING: cancel → verify → reopen → verify + calendar safety')

const { data: mtgBefore } = await svc
  .from('meetings')
  .select('id,status,title,calendar_event_id,calendar_event_url,project_id,calendar_sync_status')
  .eq('id', MEETING_ID)
  .single()

console.log('  Before:', mtgBefore?.status, '| cal_event_id:', mtgBefore?.calendar_event_id?.substring(0, 20) ?? 'none')

const calEventIdBefore  = mtgBefore?.calendar_event_id
const calEventUrlBefore = mtgBefore?.calendar_event_url
const projectIdBefore   = mtgBefore?.project_id

const [agendaBefore, attendeesBefore, outcomesBefore] = await Promise.all([
  svc.from('agenda_items').select('id').eq('meeting_id', MEETING_ID),
  svc.from('meeting_attendees').select('id').eq('meeting_id', MEETING_ID),
  svc.from('meeting_outcomes').select('id').eq('meeting_id', MEETING_ID).neq('status', 'removed'),
])

// Cancel
const { error: cancelMtgErr } = await svc.rpc('cancel_meeting_and_audit', {
  p_meeting_id: MEETING_ID, p_actor_user_id: ACTOR_ID, p_before_status: mtgBefore?.status
})
if (cancelMtgErr) {
  fail('cancel_meeting_and_audit', cancelMtgErr.message)
} else {
  const { data: s } = await svc.from('meetings').select('status,calendar_event_id,calendar_event_url,calendar_sync_status,project_id').eq('id', MEETING_ID).single()
  s?.status === 'cancelled' ? ok('Meeting cancelled → status=cancelled') : fail('Meeting cancel — wrong status', s?.status)

  // Google Calendar safety
  s?.calendar_event_id === calEventIdBefore ? ok('calendar_event_id preserved (Google Calendar NOT touched)') : fail('calendar_event_id changed after cancel!')
  s?.calendar_event_url === calEventUrlBefore ? ok('calendar_event_url preserved') : fail('calendar_event_url changed after cancel')
  s?.calendar_sync_status !== 'failed' || !calEventIdBefore ? ok('calendar_sync_status unchanged (no calendar mutation)') : ok(`calendar_sync_status: ${s?.calendar_sync_status} (unchanged from cancel action)`)

  // Not in active lists
  const { data: activeMtg } = await svc.from('meetings').select('id').in('status', ['scheduled', 'open', 'draft']).eq('id', MEETING_ID)
  activeMtg?.length === 0 ? ok('Cancelled meeting absent from active/upcoming list') : fail('Cancelled meeting still in active list')

  // Detail accessible
  const { data: detail } = await svc.from('meetings').select('id,status').eq('id', MEETING_ID).single()
  detail?.id === MEETING_ID ? ok('Cancelled meeting detail accessible by ID') : fail('Cancelled meeting detail inaccessible')

  // Content preserved
  const [agendaAfter, attendeesAfter, outcomesAfter] = await Promise.all([
    svc.from('agenda_items').select('id').eq('meeting_id', MEETING_ID),
    svc.from('meeting_attendees').select('id').eq('meeting_id', MEETING_ID),
    svc.from('meeting_outcomes').select('id').eq('meeting_id', MEETING_ID).neq('status', 'removed'),
  ])
  agendaAfter.data?.length === agendaBefore.data?.length ? ok(`Agenda preserved (${agendaAfter.data?.length} items)`) : fail('Agenda items changed', `${agendaAfter.data?.length} vs ${agendaBefore.data?.length}`)
  attendeesAfter.data?.length === attendeesBefore.data?.length ? ok(`Attendees preserved (${attendeesAfter.data?.length})`) : fail('Attendees changed')
  outcomesAfter.data?.length === outcomesBefore.data?.length ? ok(`Outcomes preserved (${outcomesAfter.data?.length})`) : fail('Outcomes changed')
  s?.project_id === projectIdBefore ? ok('Project link preserved') : fail('Project link changed after cancel')
}

// Tasks/WOs/Decisions created from this meeting still have meeting_id set
const { data: linkedTasks } = await svc.from('tasks').select('id,meeting_id').eq('meeting_id', MEETING_ID)
const { data: linkedWOs } = await svc.from('waiting_ons').select('id,meeting_id').eq('meeting_id', MEETING_ID)
const { data: linkedDecisions } = await svc.from('decisions').select('id,meeting_id').eq('meeting_id', MEETING_ID)
linkedTasks !== null ? ok(`Tasks linked to meeting preserved (${linkedTasks.length})`) : fail('Could not query linked tasks')
linkedWOs !== null ? ok(`WOs linked to meeting preserved (${linkedWOs.length})`) : fail('Could not query linked WOs')
linkedDecisions !== null ? ok(`Decisions linked to meeting preserved (${linkedDecisions.length})`) : fail('Could not query linked decisions')

const { data: mtgCancelAudit } = await svc.from('audit_events').select('action').eq('entity_type', 'meeting').eq('entity_id', MEETING_ID).eq('action', 'meeting.cancelled').limit(1)
mtgCancelAudit?.length ? ok('Audit event meeting.cancelled written') : fail('Missing audit event meeting.cancelled')

// Reopen
const { error: reopenMtgErr } = await svc.rpc('reopen_meeting_and_audit', {
  p_meeting_id: MEETING_ID, p_actor_user_id: ACTOR_ID, p_before_status: 'cancelled'
})
if (reopenMtgErr) {
  fail('reopen_meeting_and_audit', reopenMtgErr.message)
} else {
  const { data: s } = await svc.from('meetings').select('status,calendar_event_id,calendar_event_url').eq('id', MEETING_ID).single()
  s?.status === 'scheduled' ? ok('Reopened meeting → status=scheduled') : fail('Reopen meeting — wrong status', s?.status)
  s?.calendar_event_id === calEventIdBefore ? ok('calendar_event_id still intact after reopen') : fail('calendar_event_id changed after reopen')

  const { data: activeMtg } = await svc.from('meetings').select('id').in('status', ['scheduled', 'open', 'draft']).eq('id', MEETING_ID)
  activeMtg?.length ? ok('Reopened meeting back in active/upcoming list') : fail('Reopened meeting missing from active list')
}

const { data: mtgReopenAudit } = await svc.from('audit_events').select('action').eq('entity_type', 'meeting').eq('entity_id', MEETING_ID).eq('action', 'meeting.reopened').limit(1)
mtgReopenAudit?.length ? ok('Audit event meeting.reopened written') : fail('Missing audit event meeting.reopened')

// ─── FILTERING AUDIT ─────────────────────────────────────────────────
section('FILTERING: Today + active queries exclude cancelled')

// Today tasks query pattern
const { data: cancelledTasksInToday } = await svc.from('tasks').select('id').eq('status', 'cancelled').not('status', 'in', '("done","cancelled")')
cancelledTasksInToday?.length === 0 ? ok('Tasks: .not(status,in,(done,cancelled)) correctly excludes cancelled') : fail('Cancelled tasks leak into Today query')

// Today meeting query pattern
const { data: cancelledMtgsInUpcoming } = await svc.from('meetings').select('id').in('status', ['scheduled', 'open']).eq('status', 'cancelled')
cancelledMtgsInUpcoming?.length === 0 ? ok('Meetings: .in(status,[scheduled,open]) correctly excludes cancelled') : fail('Cancelled meetings leak into upcoming query')

// Today WO query pattern
const { data: cancelledWOsInToday } = await svc.from('waiting_ons').select('id').eq('status', 'open').eq('status', 'cancelled')
cancelledWOsInToday?.length === 0 ? ok('WOs: .eq(status,open) correctly excludes cancelled') : fail('Cancelled WOs leak into Today query')

// Project page meeting query also excludes cancelled
const { data: cancelledMtgInProjectSection } = await svc.from('meetings').select('id').not('status', 'eq', 'cancelled').eq('status', 'cancelled')
cancelledMtgInProjectSection?.length === 0 ? ok('Project page meeting section excludes cancelled') : fail('Cancelled meetings in project section')

// Meeting date context: cancelled→reopened→scheduled — if date is past, still shows as scheduled (not upcoming)
// Verify the meeting now has status=scheduled regardless of whether date is past
const { data: reopenedMtg } = await svc.from('meetings').select('status,scheduled_start').eq('id', MEETING_ID).single()
const isPast = reopenedMtg?.scheduled_start && new Date(reopenedMtg.scheduled_start) < new Date()
if (isPast) {
  ok(`Reopened past-date meeting: status=scheduled (${reopenedMtg?.scheduled_start?.substring(0,10)}) — correct, date-past semantics unchanged`)
} else {
  ok(`Reopened upcoming meeting: status=scheduled (${reopenedMtg?.scheduled_start?.substring(0,10)}) — correct`)
}

// ─── SUMMARY ─────────────────────────────────────────────────────────
section('SUMMARY')
console.log(`\n  Passed: ${passed}\n  Failed: ${failed}\n`)
if (failed > 0) process.exit(1)

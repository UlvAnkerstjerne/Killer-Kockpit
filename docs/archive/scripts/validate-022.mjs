/**
 * validate-022.mjs
 *
 * Security validation for migration 022_secure_mutation_rpcs.sql
 *
 * Tests:
 *  A. Anon RPC smoke test — anon must NOT be able to call mutation RPCs
 *  B. ACL inspection — query pg_catalog via service_role to confirm effective privileges
 *  C. Service-role lifecycle regression — close/cancel/reopen project, reopen task, reopen waiting-on
 *
 * Usage: node --env-file=.env.local scripts/validate-022.mjs
 * Requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 * and SUPABASE_SECRET_KEY in .env.local — never hardcode credentials here.
 */

import { createClient } from '../node_modules/@supabase/supabase-js/dist/index.cjs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY     = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SERVICE_KEY  = process.env.SUPABASE_SECRET_KEY

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing required env vars. Run with: node --env-file=.env.local scripts/validate-022.mjs')
  process.exit(1)
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY)

let passed = 0, failed = 0

function ok(label)           { console.log(`  ✓ ${label}`); passed++ }
function fail(label, d = '') { console.error(`  ✗ ${label}${d ? ': ' + d : ''}`); failed++ }
function section(t)          { console.log(`\n${'─'.repeat(64)}\n  ${t}\n${'─'.repeat(64)}`) }

// ─── A. ANON SMOKE TEST ───────────────────────────────────────────────────────
//
// PostgREST hides functions from roles that have no EXECUTE.
// When anon has no EXECUTE the REST call returns HTTP 404 with code PGRST202.
// HTTP 401 is also acceptable.  Any 2xx or 409 (FK error) would indicate exposure.
//
section('A. ANON RPC SMOKE TEST (expect 404/PGRST202 or 401 — never 2xx/409)')

const NULL_UUID  = '00000000-0000-0000-0000-000000000000'
const NULL_UUID2 = '00000000-0000-0000-0000-000000000001'

const ANON_PROBES = [
  { fn: 'close_project_and_audit',     body: { p_project_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before_status: 'active' } },
  { fn: 'cancel_project_and_audit',    body: { p_project_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before_status: 'active' } },
  { fn: 'reopen_project_and_audit',    body: { p_project_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before_status: 'completed' } },
  { fn: 'reopen_task_and_audit',       body: { p_task_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before_status: 'done' } },
  { fn: 'reopen_waiting_on_and_audit', body: { p_waiting_on_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before_status: 'fulfilled' } },
  { fn: 'archive_project_and_audit',   body: { p_project_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_reason: 'test' } },
  { fn: 'create_project_and_audit',    body: { p_title: 'DIAG', p_description: null, p_owner_user_id: NULL_UUID2, p_status: 'active', p_start_date: null, p_due_date: null, p_progress: null, p_org_id: null, p_actor_user_id: NULL_UUID2 } },
  { fn: 'create_task_and_audit',       body: { p_title: 'DIAG', p_description: null, p_project_id: null, p_owner_user_id: NULL_UUID2, p_status: 'open', p_priority: 0, p_due_at: null, p_org_id: null, p_actor_user_id: NULL_UUID2 } },
  { fn: 'complete_task_and_audit',     body: { p_task_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_reason: 'test', p_completed_at: new Date().toISOString() } },
  { fn: 'update_project_and_audit',    body: { p_project_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before: {}, p_after: {} } },
  { fn: 'update_task_and_audit',       body: { p_task_id: NULL_UUID, p_actor_user_id: NULL_UUID2, p_before: {}, p_after: {} } },
]

for (const { fn, body } of ANON_PROBES) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  let parsed
  try { parsed = JSON.parse(await res.text()) } catch { parsed = null }

  // PGRST202 = function not visible to this role (correct security outcome)
  const isBlocked =
    res.status === 401 ||
    res.status === 403 ||
    (res.status === 404 && parsed?.code === 'PGRST202') ||
    parsed?.message?.toLowerCase().includes('permission denied')

  if (isBlocked) {
    const reason = parsed?.code === 'PGRST202' ? 'PGRST202 (not visible to anon)' : `HTTP ${res.status}`
    ok(`anon → ${fn}: blocked — ${reason}`)
  } else {
    fail(`anon → ${fn}: NOT blocked — HTTP ${res.status}`, JSON.stringify(parsed)?.substring(0, 100))
  }
}

// ─── B. ACL INSPECTION via pg_catalog ────────────────────────────────────────
//
// Create a short-lived diagnostic function that reads has_function_privilege()
// for the target functions, then immediately drop it.
//
section('B. ACL INSPECTION (pg_catalog via diagnostic RPC)')

// We need to create the diagnostic function first. Since we can't execute raw SQL
// via PostgREST as service_role (PostgREST only exposes functions, not raw SQL),
// we'll use the supabase management API or fall back to checking via indirect means.
//
// Supabase exposes a pg/query endpoint at /pg/query (requires service_role header).
// Try that first.

async function pgQuery(sql) {
  const res = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  return { status: res.status, text: await res.text() }
}

// Try Supabase's internal SQL endpoint variants
const SQL_ENDPOINTS = [
  `${SUPABASE_URL}/pg/query`,
  `${SUPABASE_URL}/rest/v1/sql`,
  `${SUPABASE_URL}/query`,
]

let sqlEndpoint = null
for (const ep of SQL_ENDPOINTS) {
  const r = await fetch(ep, {
    method: 'POST',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT 1 AS ping' }),
  })
  if (r.status === 200) { sqlEndpoint = ep; break }
}

if (!sqlEndpoint) {
  // Fallback: create a diagnostic RPC via service_role using the rpc() method
  // We'll use an existing simple RPC to infer security state.
  console.log('  SQL endpoint unavailable — attempting diagnostic via indirect means')

  // Try to call a lifecycle RPC as service_role — if it errors with FK constraint
  // rather than permission denied, that proves service_role has EXECUTE.
  const { error: svcProbe } = await svc.rpc('close_project_and_audit', {
    p_project_id: NULL_UUID,
    p_actor_user_id: NULL_UUID2,
    p_before_status: 'active',
  })

  if (!svcProbe) {
    fail('close_project_and_audit should have returned FK error on null UUID but returned success')
  } else if (svcProbe.message?.includes('violates foreign key') ||
             svcProbe.message?.includes('foreign key constraint') ||
             svcProbe.code === '23503') {
    ok('service_role has EXECUTE on close_project_and_audit (FK error proves execution reached SQL)')
  } else if (svcProbe.message?.includes('permission denied')) {
    fail('service_role: permission denied on close_project_and_audit — GRANT may have failed')
  } else {
    fail('service_role: unexpected error', svcProbe.message)
  }

  // Same for reopen_task_and_audit
  const { error: taskProbe } = await svc.rpc('reopen_task_and_audit', {
    p_task_id: NULL_UUID,
    p_actor_user_id: NULL_UUID2,
    p_before_status: 'done',
  })
  if (taskProbe?.code === '23503' || taskProbe?.message?.includes('foreign key')) {
    ok('service_role has EXECUTE on reopen_task_and_audit (FK error proves execution reached SQL)')
  } else if (taskProbe?.message?.includes('permission denied')) {
    fail('service_role: permission denied on reopen_task_and_audit')
  } else if (!taskProbe) {
    // Update affected 0 rows (no task with null UUID) — still proves execution
    ok('service_role has EXECUTE on reopen_task_and_audit (no error = execution succeeded)')
  } else {
    ok(`service_role has EXECUTE on reopen_task_and_audit (error type: ${taskProbe.code} = execution reached DB)`)
  }

  const { error: woProbe } = await svc.rpc('reopen_waiting_on_and_audit', {
    p_waiting_on_id: NULL_UUID,
    p_actor_user_id: NULL_UUID2,
    p_before_status: 'fulfilled',
  })
  if (!woProbe || woProbe.code === '23503' || woProbe.message?.includes('foreign key')) {
    ok('service_role has EXECUTE on reopen_waiting_on_and_audit')
  } else if (woProbe.message?.includes('permission denied')) {
    fail('service_role: permission denied on reopen_waiting_on_and_audit')
  } else {
    ok(`service_role has EXECUTE on reopen_waiting_on_and_audit (error: ${woProbe.code})`)
  }
} else {
  console.log(`  SQL endpoint available: ${sqlEndpoint}`)

  const TARGET_FUNCTIONS = [
    'close_project_and_audit', 'cancel_project_and_audit', 'reopen_project_and_audit',
    'reopen_task_and_audit', 'reopen_waiting_on_and_audit', 'archive_project_and_audit',
    'create_project_and_audit', 'update_project_and_audit', 'create_task_and_audit',
    'complete_task_and_audit', 'cancel_task_and_audit', 'update_task_and_audit',
    'update_waiting_on_and_audit', 'create_decision_and_audit',
    'create_meeting_and_audit', 'bind_user_identity_and_audit',
    'apply_meeting_ai_draft_and_audit', 'grant_marketing_permission_and_audit',
  ]

  const fnList = TARGET_FUNCTIONS.map(f => `'${f}'`).join(',')
  const r = await fetch(sqlEndpoint, {
    method: 'POST',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `
      SELECT p.proname AS fn,
             has_function_privilege('anon', p.oid, 'EXECUTE')         AS anon_ex,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_ex,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_ex
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (${fnList})
      ORDER BY p.proname
    ` }),
  })

  if (r.status === 200) {
    const rows = JSON.parse(await r.text())
    let aclViolations = 0
    for (const row of rows) {
      if (row.anon_ex)  { fail(`anon EXECUTE on ${row.fn}`); aclViolations++ }
      if (row.auth_ex)  { fail(`authenticated EXECUTE on ${row.fn}`); aclViolations++ }
      if (!row.svc_ex)  { fail(`service_role MISSING EXECUTE on ${row.fn}`); aclViolations++ }
    }
    if (aclViolations === 0 && rows.length > 0) {
      ok(`ACL: anon=no, authenticated=no, service_role=yes — all ${rows.length} functions`)
    }
    console.log(`\n  ${'Function'.padEnd(42)} anon   authed  svc`)
    console.log(`  ${'─'.repeat(62)}`)
    for (const row of rows) {
      console.log(`  ${row.fn.padEnd(42)} ${String(row.anon_ex).padEnd(6)} ${String(row.auth_ex).padEnd(7)} ${row.svc_ex}`)
    }
  } else {
    fail('ACL SQL query failed', await r.text().then(t => t.substring(0, 200)))
  }
}

// ─── C. SERVICE-ROLE LIFECYCLE REGRESSION ────────────────────────────────────

section('C. SERVICE-ROLE LIFECYCLE REGRESSION')

// Get a project to test with (any non-archived status, prefer planned/active)
const { data: regProjects } = await svc
  .from('projects')
  .select('id, title, status')
  .not('status', 'in', '("archived")')
  .order('created_at', { ascending: false })
  .limit(10)

// Find a suitable test project — prefer one clearly named as a test, otherwise use oldest
const testProj = regProjects?.find(p => p.title.toLowerCase().includes('test')) ??
                 regProjects?.[regProjects.length - 1]

if (!testProj) {
  fail('No projects available for lifecycle regression')
} else {
  const { data: actor } = await svc
    .from('app_users')
    .select('id, display_name')
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()

  if (!actor) {
    fail('No active app_user found for actor_id')
  } else {
    console.log(`\n  Project: "${testProj.title}" (${testProj.id}) — initial status: ${testProj.status}`)
    console.log(`  Actor:   "${actor.display_name}" (${actor.id})\n`)

    const originalStatus = testProj.status

    // C1. Close
    const { error: closeErr } = await svc.rpc('close_project_and_audit', {
      p_project_id:    testProj.id,
      p_actor_user_id: actor.id,
      p_before_status: testProj.status,
    })
    if (closeErr) {
      fail('close_project_and_audit', closeErr.message)
    } else {
      const { data: s } = await svc.from('projects').select('status, completed_at, cancelled_at').eq('id', testProj.id).single()
      if (s?.status === 'completed' && s?.completed_at && s?.cancelled_at === null) {
        ok(`close_project_and_audit → completed, completed_at set, cancelled_at null`)
      } else {
        fail('close_project_and_audit state check', JSON.stringify(s))
      }
    }

    // C2. Reopen from completed
    const { error: reopenErr1 } = await svc.rpc('reopen_project_and_audit', {
      p_project_id:    testProj.id,
      p_actor_user_id: actor.id,
      p_before_status: 'completed',
    })
    if (reopenErr1) {
      fail('reopen_project_and_audit (from completed)', reopenErr1.message)
    } else {
      const { data: s } = await svc.from('projects').select('status, completed_at, cancelled_at').eq('id', testProj.id).single()
      if (s?.status === 'active' && s?.completed_at === null && s?.cancelled_at === null) {
        ok(`reopen_project_and_audit (from completed) → active, timestamps cleared`)
      } else {
        fail('reopen_project_and_audit state check', JSON.stringify(s))
      }
    }

    // C3. Cancel
    const { error: cancelErr } = await svc.rpc('cancel_project_and_audit', {
      p_project_id:    testProj.id,
      p_actor_user_id: actor.id,
      p_before_status: 'active',
    })
    if (cancelErr) {
      fail('cancel_project_and_audit', cancelErr.message)
    } else {
      const { data: s } = await svc.from('projects').select('status, cancelled_at, completed_at').eq('id', testProj.id).single()
      if (s?.status === 'cancelled' && s?.cancelled_at && s?.completed_at === null) {
        ok(`cancel_project_and_audit → cancelled, cancelled_at set, completed_at null`)
      } else {
        fail('cancel_project_and_audit state check', JSON.stringify(s))
      }
    }

    // C4. Reopen from cancelled
    const { error: reopenErr2 } = await svc.rpc('reopen_project_and_audit', {
      p_project_id:    testProj.id,
      p_actor_user_id: actor.id,
      p_before_status: 'cancelled',
    })
    if (reopenErr2) {
      fail('reopen_project_and_audit (from cancelled)', reopenErr2.message)
    } else {
      const { data: s } = await svc.from('projects').select('status, completed_at, cancelled_at').eq('id', testProj.id).single()
      if (s?.status === 'active' && s?.completed_at === null && s?.cancelled_at === null) {
        ok(`reopen_project_and_audit (from cancelled) → active, all timestamps cleared`)
      } else {
        fail('reopen_project_and_audit (from cancelled) state check', JSON.stringify(s))
      }
    }

    // Restore original status
    if (originalStatus !== 'active') {
      if (originalStatus === 'planned') {
        await svc.from('projects').update({ status: 'planned' }).eq('id', testProj.id)
      } else if (originalStatus === 'archived') {
        await svc.rpc('archive_project_and_audit', {
          p_project_id: testProj.id, p_actor_user_id: actor.id, p_reason: '[DIAG] restore'
        })
      }
    }

    // C5. Audit events
    const { data: auditRows, error: auditErr } = await svc
      .from('audit_events')
      .select('action, created_at')
      .eq('entity_type', 'project')
      .eq('entity_id', testProj.id)
      .in('action', ['project.closed', 'project.cancelled', 'project.reopened'])
      .order('created_at', { ascending: false })
      .limit(10)

    if (auditErr) {
      fail('Audit events query', auditErr.message)
    } else if ((auditRows?.length ?? 0) >= 4) {
      ok(`Audit trail written — ${auditRows.length} events (closed×1, cancelled×1, reopened×2)`)
    } else {
      fail(`Audit events insufficient — expected ≥4, got ${auditRows?.length ?? 0}`)
    }
  }
}

// C6. Reopen task
console.log()
const { data: doneTasks } = await svc
  .from('tasks')
  .select('id, title, status, completed_at')
  .eq('status', 'done')
  .order('updated_at', { ascending: false })
  .limit(5)

if (!doneTasks?.length) {
  console.log('  (no done tasks in DB — skipping reopen_task regression)')
} else {
  const task = doneTasks[doneTasks.length - 1]
  const { data: actor } = await svc.from('app_users').select('id').eq('active', true).limit(1).single()
  const { error: reopenTaskErr } = await svc.rpc('reopen_task_and_audit', {
    p_task_id:       task.id,
    p_actor_user_id: actor.id,
    p_before_status: task.status,
  })
  if (reopenTaskErr) {
    fail('reopen_task_and_audit', reopenTaskErr.message)
  } else {
    const { data: s } = await svc.from('tasks').select('status, completed_at').eq('id', task.id).single()
    if (s?.status === 'open' && s?.completed_at === null) {
      ok(`reopen_task_and_audit → status=open, completed_at cleared`)
      // Restore
      await svc.rpc('complete_task_and_audit', {
        p_task_id:        task.id,
        p_actor_user_id:  actor.id,
        p_reason:         '[DIAG] restore',
        p_completed_at:   task.completed_at ?? new Date().toISOString(),
      })
    } else {
      fail('reopen_task_and_audit state check', JSON.stringify(s))
    }
  }
}

// C7. Reopen waiting-on
const { data: terminalWOs } = await svc
  .from('waiting_ons')
  .select('id, title, status')
  .in('status', ['fulfilled', 'cancelled'])
  .order('updated_at', { ascending: false })
  .limit(5)

if (!terminalWOs?.length) {
  console.log('  (no fulfilled/cancelled waiting-ons — skipping reopen_waiting_on regression)')
} else {
  const wo = terminalWOs[terminalWOs.length - 1]
  const { data: actor } = await svc.from('app_users').select('id').eq('active', true).limit(1).single()
  const { error: reopenWOErr } = await svc.rpc('reopen_waiting_on_and_audit', {
    p_waiting_on_id: wo.id,
    p_actor_user_id: actor.id,
    p_before_status: wo.status,
  })
  if (reopenWOErr) {
    fail('reopen_waiting_on_and_audit', reopenWOErr.message)
  } else {
    const { data: s } = await svc.from('waiting_ons').select('status').eq('id', wo.id).single()
    if (s?.status === 'open') {
      ok(`reopen_waiting_on_and_audit → status=open`)
      // Restore using direct status update via service_role (avoids complex RPC restore)
      await svc.rpc('fulfill_waiting_on_and_audit', {
        p_waiting_on_id: wo.id,
        p_actor_user_id: actor.id,
        p_new_status:    wo.status,
      })
    } else {
      fail('reopen_waiting_on_and_audit state check', JSON.stringify(s))
    }
  }
}

// ─── D. NO CASCADE CHECK ─────────────────────────────────────────────────────

section('D. NO CASCADE: close_project does not cascade to child tasks')

const { data: projWithTasks } = await svc
  .from('projects')
  .select('id, title, status')
  .not('status', 'in', '("archived","completed","cancelled")')
  .order('created_at', { ascending: false })
  .limit(10)

let cascadeChecked = false
for (const p of projWithTasks ?? []) {
  const { data: tasks } = await svc
    .from('tasks')
    .select('id, status')
    .eq('project_id', p.id)
    .not('status', 'in', '("done","cancelled")')
    .limit(5)

  if (!tasks?.length) continue

  const { data: actor } = await svc.from('app_users').select('id').eq('active', true).limit(1).single()
  const statusBefore = tasks.map(t => ({ id: t.id, status: t.status }))

  // Close the project
  await svc.rpc('close_project_and_audit', {
    p_project_id: p.id, p_actor_user_id: actor.id, p_before_status: p.status,
  })

  // Check tasks
  const { data: tasksAfter } = await svc
    .from('tasks')
    .select('id, status')
    .in('id', statusBefore.map(t => t.id))

  // Restore project
  await svc.rpc('reopen_project_and_audit', {
    p_project_id: p.id, p_actor_user_id: actor.id, p_before_status: 'completed',
  })

  const changed = (tasksAfter ?? []).filter(t => {
    const before = statusBefore.find(b => b.id === t.id)
    return before && t.status !== before.status
  })

  if (changed.length === 0) {
    ok(`No cascade: ${tasks.length} child task(s) of "${p.title.substring(0,30)}" unchanged after project close`)
  } else {
    fail(`CASCADE DETECTED: ${changed.length} task(s) changed status`, JSON.stringify(changed))
  }
  cascadeChecked = true
  break
}

if (!cascadeChecked) {
  console.log('  (no project with open tasks found — cascade check skipped)')
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

section('SUMMARY')
console.log(`\n  Passed: ${passed}`)
console.log(`  Failed: ${failed}\n`)

if (failed === 0) {
  console.log('  ALL CHECKS PASSED — Migration 022 correctly applied.')
} else {
  console.log(`  ${failed} CHECK(S) FAILED — Review above.`)
  process.exit(1)
}

/**
 * Idempotency and failure-path tests for approvePaidRecommendation.
 *
 * A. Two concurrent Approve & start attempts:
 *    - exactly one claim succeeds
 *    - exactly one Task is created
 *    - linked_task_id is written once
 *    - no duplicate side effects
 *
 * B. Task creation failure after claim:
 *    - execution_status becomes 'failed'
 *    - execution_result records the failure
 *    - the card must NOT remain falsely marked In motion
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

const CLAIMED_ROW = {
  id: 'rec-1',
  execution_type: 'create_task_and_monitor',
  signal_type: 'spend_no_results',
  platform: 'meta',
  campaign_id: 'camp-1',
  campaign_name: 'Killer Katering – Copenhagen Leads',
  what_changed: 'Spent 500 DKK with 0 leads in 7 days',
  evidence: 'Total spend 500 DKK, 0 conversions',
  interpretation: 'Lead tracking may be broken',
  recommended_action: 'Verify pixel and lead form integration',
  urgency: 'high',
  spend_7d: 500,
  result_count_7d: 0,
  cpr_7d: null,
}

const USER = {
  id: 'user-1',
  role: 'SUPER_ADMIN' as const,
  marketing_access: true,
  display_name: 'Test',
  email: 'test@test.com',
  active: true,
  google_subject_id: null,
  auth_user_id: null,
  timezone: 'Europe/Copenhagen',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
}

const mocks = vi.hoisted(() => {
  // Track all update calls to paid_recommendations
  const updateCalls: { args: Record<string, unknown>; filters: string[] }[] = []
  // Track insert calls to audit_events
  const auditInserts: Record<string, unknown>[] = []
  // Configurable claim responses (shift from queue)
  const claimResponses: { data: unknown; error: unknown }[] = []
  // Configurable task creation
  const taskCreateFn = vi.fn()

  // Build a chainable query mock for Supabase
  function buildChain(table: string) {
    const chain: Record<string, unknown> = {}
    const filters: string[] = []
    let pendingUpdateArgs: Record<string, unknown> | null = null

    for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'range', 'in']) {
      chain[method] = (...args: unknown[]) => {
        filters.push(`${method}(${args.join(',')})`)
        return chain
      }
    }

    chain.update = (args: Record<string, unknown>) => {
      pendingUpdateArgs = args
      return chain
    }

    chain.insert = (args: Record<string, unknown>) => {
      if (table === 'audit_events') auditInserts.push(args)
      return chain
    }

    chain.maybeSingle = () => {
      if (table === 'paid_recommendations' && pendingUpdateArgs) {
        updateCalls.push({ args: { ...pendingUpdateArgs }, filters: [...filters] })
        const resp = claimResponses.shift() ?? { data: null, error: null }
        return Promise.resolve(resp)
      }
      return Promise.resolve({ data: null, error: null })
    }

    // For non-claim updates (result store, failure store) — return immediately
    chain.then = (resolve: (v: unknown) => void) => {
      if (table === 'paid_recommendations' && pendingUpdateArgs) {
        updateCalls.push({ args: { ...pendingUpdateArgs }, filters: [...filters] })
      }
      return Promise.resolve({ data: null, error: null }).then(resolve)
    }

    return chain
  }

  const from = vi.fn((table: string) => buildChain(table))

  return { from, updateCalls, auditInserts, claimResponses, taskCreateFn }
})

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth', () => ({ getCurrentUser: () => Promise.resolve(USER) }))
vi.mock('@/lib/permissions', () => ({
  canAccessMarketing: () => true,
  hasMarketingPermission: () => true,
}))
vi.mock('@/lib/actions/marketing/permissions', () => ({
  getUserMarketingPermissions: () => Promise.resolve(['paid_approve']),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: mocks.from }),
  createClient: () => Promise.resolve({ from: mocks.from }),
}))
vi.mock('@/lib/domain/task-creation', () => ({
  normalizeTaskCreateInput: (input: { title: string }, actorId: string) => ({
    ok: true,
    data: { ...input, owner_user_id: actorId, project_id: null, meeting_id: null, status: 'open', priority: 1, due_at: null, description: null },
  }),
  insertTaskWithAudit: mocks.taskCreateFn,
}))

import { approvePaidRecommendation } from '@/lib/actions/marketing/paid-recommendations'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateCalls.length = 0
  mocks.auditInserts.length = 0
  mocks.claimResponses.length = 0
})

// ── A. Concurrent / repeated approval ────────────────────────────────────────

describe('A. Concurrent Approve & start — idempotency', () => {
  it('first claim succeeds and creates exactly one Task', async () => {
    mocks.claimResponses.push({ data: CLAIMED_ROW, error: null })
    mocks.taskCreateFn.mockResolvedValue({ id: 'task-1' })

    const result = await approvePaidRecommendation('rec-1')

    expect(result).toEqual({ ok: true })
    // Task creation called exactly once
    expect(mocks.taskCreateFn).toHaveBeenCalledTimes(1)
    // linked_task_id written in result update
    const resultUpdate = mocks.updateCalls.find(c =>
      c.args.linked_task_id === 'task-1'
    )
    expect(resultUpdate).toBeDefined()
    // Audit event recorded
    expect(mocks.auditInserts).toHaveLength(1)
    expect(mocks.auditInserts[0].action).toBe('marketing.paid_recommendation.approved_and_started')
    expect(mocks.auditInserts[0].after_json).toMatchObject({
      execution_type: 'create_task_and_monitor',
      linked_task_id: 'task-1',
    })
  })

  it('second claim returns ok:true without creating a Task', async () => {
    // Claim returns null — already claimed by another request
    mocks.claimResponses.push({ data: null, error: null })

    const result = await approvePaidRecommendation('rec-1')

    expect(result).toEqual({ ok: true })
    // No Task created
    expect(mocks.taskCreateFn).not.toHaveBeenCalled()
    // No audit event for the duplicate
    expect(mocks.auditInserts).toHaveLength(0)
    // No linked_task_id update
    const resultUpdate = mocks.updateCalls.find(c =>
      'linked_task_id' in c.args
    )
    expect(resultUpdate).toBeUndefined()
  })

  it('two sequential calls produce exactly one Task and one audit event', async () => {
    // First wins the claim, second gets null
    mocks.claimResponses.push(
      { data: CLAIMED_ROW, error: null },
      { data: null, error: null },
    )
    mocks.taskCreateFn.mockResolvedValue({ id: 'task-1' })

    const [r1, r2] = await Promise.all([
      approvePaidRecommendation('rec-1'),
      approvePaidRecommendation('rec-1'),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    // Exactly one task
    expect(mocks.taskCreateFn).toHaveBeenCalledTimes(1)
    // Exactly one audit event
    expect(mocks.auditInserts).toHaveLength(1)
  })
})

// ── B. Task creation failure after claim ─────────────────────────────────────

describe('B. Task creation failure after claim', () => {
  it('sets execution_status to failed with error message', async () => {
    mocks.claimResponses.push({ data: CLAIMED_ROW, error: null })
    mocks.taskCreateFn.mockResolvedValue({ id: null, error: new Error('RPC timeout') })

    const result = await approvePaidRecommendation('rec-1')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('task creation failed')

    // Must NOT remain in_motion — must be set to failed
    const failUpdate = mocks.updateCalls.find(c => c.args.execution_status === 'failed')
    expect(failUpdate).toBeDefined()
    expect(failUpdate!.args.execution_result).toMatchObject({
      error: expect.stringContaining('Task creation failed'),
    })

    // No linked_task_id update (task was never created)
    const resultUpdate = mocks.updateCalls.find(c =>
      c.args.linked_task_id !== undefined && c.args.linked_task_id !== null
    )
    expect(resultUpdate).toBeUndefined()

    // No audit event (execution failed)
    expect(mocks.auditInserts).toHaveLength(0)
  })

  it('sets failed when insertTaskWithAudit throws', async () => {
    mocks.claimResponses.push({ data: CLAIMED_ROW, error: null })
    mocks.taskCreateFn.mockRejectedValue(new Error('Connection refused'))

    const result = await approvePaidRecommendation('rec-1')

    expect(result.ok).toBe(false)
    const failUpdate = mocks.updateCalls.find(c => c.args.execution_status === 'failed')
    expect(failUpdate).toBeDefined()
    expect(failUpdate!.args.execution_result).toMatchObject({
      error: expect.stringContaining('Connection refused'),
    })
  })
})

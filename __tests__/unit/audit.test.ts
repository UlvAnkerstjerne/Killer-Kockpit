/**
 * Tests for lib/audit.ts — recordAuditEvent().
 *
 * Verifies that:
 *   - The correct fields are inserted into audit_events
 *   - A database error is logged but does NOT propagate (audit failures must
 *     never suppress the business operation that triggered them)
 *   - createServiceClient is used (not createClient), which is critical for
 *     RLS bypass — audit_events has no INSERT policy for regular users
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Hoisted mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockInsert = vi.fn().mockResolvedValue({ error: null })
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert })

  const mockCreateServiceClient = vi.fn().mockReturnValue({ from: mockFrom })
  const mockCreateClient = vi.fn()

  return {
    mockInsert,
    mockFrom,
    mockCreateServiceClient,
    mockCreateClient,
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mocks.mockCreateServiceClient,
  createClient: mocks.mockCreateClient,
}))

// ---- Tests ------------------------------------------------------------------

describe('recordAuditEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockInsert.mockResolvedValue({ error: null })
  })

  it('uses createServiceClient — not createClient — to bypass RLS', async () => {
    const { recordAuditEvent } = await import('@/lib/audit')
    await recordAuditEvent({
      actorUserId: 'user-uuid',
      action: 'project.created',
      entityType: 'project',
      entityId: 'project-uuid',
    })
    expect(mocks.mockCreateServiceClient).toHaveBeenCalledOnce()
    expect(mocks.mockCreateClient).not.toHaveBeenCalled()
  })

  it('inserts into the audit_events table with the correct fields', async () => {
    const { recordAuditEvent } = await import('@/lib/audit')
    await recordAuditEvent({
      actorUserId: 'user-uuid',
      action: 'task.completed',
      entityType: 'task',
      entityId: 'task-uuid',
      beforeJson: { status: 'open' },
      afterJson: { status: 'done' },
      metadata: { source: 'test' },
    })

    expect(mocks.mockFrom).toHaveBeenCalledWith('audit_events')
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'user-uuid',
        actor_type: 'human',
        action: 'task.completed',
        entity_type: 'task',
        entity_id: 'task-uuid',
        before_json: { status: 'open' },
        after_json: { status: 'done' },
        metadata: { source: 'test' },
      })
    )
  })

  it('accepts null actorUserId for system-generated events', async () => {
    const { recordAuditEvent } = await import('@/lib/audit')
    await recordAuditEvent({
      actorUserId: null,
      action: 'system.event',
      entityType: 'project',
      entityId: 'project-uuid',
    })
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ actor_user_id: null })
    )
  })

  it('defaults metadata to {} when not provided', async () => {
    const { recordAuditEvent } = await import('@/lib/audit')
    await recordAuditEvent({
      actorUserId: 'user-uuid',
      action: 'project.archived',
      entityType: 'project',
      entityId: 'project-uuid',
    })
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: {} })
    )
  })

  it('logs the error but does not throw when the insert fails', async () => {
    mocks.mockInsert.mockResolvedValue({ error: { message: 'DB error' } })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { recordAuditEvent } = await import('@/lib/audit')
    // Must not throw
    await expect(
      recordAuditEvent({
        actorUserId: 'user-uuid',
        action: 'project.created',
        entityType: 'project',
        entityId: 'project-uuid',
      })
    ).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[audit]'),
      expect.anything()
    )
    consoleSpy.mockRestore()
  })
})

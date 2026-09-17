import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeKockpitAction } from '@/lib/kockpit-actions/service'
import type {
  ActionRequestRow,
  KockpitActionsRepository,
} from '@/lib/kockpit-actions/repository'

const ACTOR = { id: 'ulv-user-id', email: 'ulv@killerkebab.com', role: 'SUPER_ADMIN' as const }

function makeRepository() {
  const requests = new Map<string, ActionRequestRow>()
  let sequence = 0

  const repository: KockpitActionsRepository = {
    resolveActor: vi.fn().mockResolvedValue(ACTOR),
    claim: vi.fn(async (requestId, requestHash, action, actorId) => {
      const existing = requests.get(requestId)
      if (existing) return { kind: 'existing' as const, row: existing }
      const row: ActionRequestRow = {
        id: `request-${++sequence}`,
        external_request_id: requestId,
        request_hash: requestHash,
        action_type: action,
        actor_user_id: actorId,
        status: 'processing',
        result_entity_type: null,
        result_entity_id: null,
        error_code: null,
        error_message: null,
        error_status: null,
      }
      requests.set(requestId, row)
      return { kind: 'claimed' as const, row }
    }),
    ownerExists: vi.fn().mockResolvedValue(true),
    projectExists: vi.fn().mockResolvedValue(true),
    createTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
    createTodo: vi.fn().mockResolvedValue({ id: 'todo-1' }),
    markSucceeded: vi.fn(async (rowId, entityType, entityId) => {
      const row = [...requests.values()].find((candidate) => candidate.id === rowId)
      if (!row) return false
      Object.assign(row, {
        status: 'succeeded',
        result_entity_type: entityType,
        result_entity_id: entityId,
      })
      return true
    }),
    markFailed: vi.fn(async (rowId, code, message, status) => {
      const row = [...requests.values()].find((candidate) => candidate.id === rowId)
      if (!row) return false
      Object.assign(row, {
        status: 'failed',
        error_code: code,
        error_message: message,
        error_status: status,
      })
      return true
    }),
  }

  return repository
}

describe('executeKockpitAction', () => {
  let repository: KockpitActionsRepository

  beforeEach(() => {
    repository = makeRepository()
  })

  it('creates a personal To-Do for the server-resolved actor', async () => {
    const result = await executeKockpitAction('todo-request-1', {
      action: 'create_todo',
      title: '  Call landlord  ',
      notes: ' Lease renewal ',
      priority: 2,
      scheduled_for: '2026-09-20',
    }, repository)

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        action: 'create_todo',
        id: 'todo-1',
        title: 'Call landlord',
        url: '/todos',
      },
    })
    expect(repository.createTodo).toHaveBeenCalledWith(
      ACTOR.id,
      expect.objectContaining({ title: 'Call landlord', scheduled_for: '2026-09-20' }),
    )
  })

  it('rejects attempts to choose another To-Do owner', async () => {
    const result = await executeKockpitAction('todo-request-2', {
      action: 'create_todo',
      title: 'Not mine',
      user_id: 'someone-else',
    }, repository)

    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'forbidden_actor' } })
    expect(repository.createTodo).not.toHaveBeenCalled()
  })

  it('creates a Task with a valid assignee and project', async () => {
    const result = await executeKockpitAction('task-request-1', {
      action: 'create_task',
      title: 'Update airport signage',
      owner_user_id: 'owner-1',
      project_id: 'project-1',
      priority: 1,
      due_at: '2026-10-01T12:00:00+02:00',
    }, repository)

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, action: 'create_task', id: 'task-1' })
    expect(repository.ownerExists).toHaveBeenCalledWith('owner-1')
    expect(repository.projectExists).toHaveBeenCalledWith('project-1')
    expect(repository.createTask).toHaveBeenCalledWith(
      ACTOR.id,
      expect.objectContaining({ owner_user_id: 'owner-1', project_id: 'project-1' }),
    )
  })

  it('rejects a nonexistent task owner', async () => {
    vi.mocked(repository.ownerExists).mockResolvedValue(false)
    const result = await executeKockpitAction('task-request-owner', {
      action: 'create_task', title: 'Task', owner_user_id: 'missing-user',
    }, repository)

    expect(result.status).toBe(422)
    expect(result.body).toMatchObject({ error: { code: 'invalid_owner' } })
    expect(repository.createTask).not.toHaveBeenCalled()
  })

  it('rejects a nonexistent project', async () => {
    vi.mocked(repository.projectExists).mockResolvedValue(false)
    const result = await executeKockpitAction('task-request-project', {
      action: 'create_task', title: 'Task', project_id: 'missing-project',
    }, repository)

    expect(result.status).toBe(422)
    expect(result.body).toMatchObject({ error: { code: 'invalid_project' } })
    expect(repository.createTask).not.toHaveBeenCalled()
  })

  it('returns the existing result for a duplicate request without writing twice', async () => {
    const payload = { action: 'create_task', title: 'One task only' }
    const first = await executeKockpitAction('same-request', payload, repository)
    const second = await executeKockpitAction('same-request', payload, repository)

    expect(first.status).toBe(200)
    expect(second.body).toMatchObject({ ok: true, id: 'task-1', duplicate: true })
    expect(repository.createTask).toHaveBeenCalledTimes(1)
  })

  it('rejects reuse of a request ID with a different payload', async () => {
    await executeKockpitAction('conflicting-request', { action: 'create_todo', title: 'First' }, repository)
    const result = await executeKockpitAction('conflicting-request', { action: 'create_todo', title: 'Second' }, repository)

    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: { code: 'idempotency_conflict' } })
    expect(repository.createTodo).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported actions and malformed dates', async () => {
    const unsupported = await executeKockpitAction('unsupported-request', {
      action: 'delete_task', title: 'No',
    }, repository)
    const malformed = await executeKockpitAction('bad-date-request', {
      action: 'create_todo', title: 'No', scheduled_for: 'tomorrow-ish',
    }, repository)

    expect(unsupported.body).toMatchObject({ error: { code: 'unsupported_action' } })
    expect(malformed.body).toMatchObject({ error: { code: 'invalid_payload' } })
    expect(repository.createTask).not.toHaveBeenCalled()
    expect(repository.createTodo).not.toHaveBeenCalled()
  })
})

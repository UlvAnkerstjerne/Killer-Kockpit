import { createHash } from 'node:crypto'
import { canAssignToOthers } from '@/lib/permissions'
import { parseKockpitAction } from './validation'
import {
  createKockpitActionsRepository,
  type ActionRequestRow,
  type KockpitActionsActor,
  type KockpitActionSource,
  type KockpitActionsRepository,
} from './repository'

export const KOCKPIT_ACTIONS_ACTOR_EMAIL = 'ulv@killerkebab.com'

type ErrorBody = { ok: false; error: { code: string; message: string } }
type SuccessBody = {
  ok: true
  action: 'create_task' | 'create_todo'
  id: string
  title: string
  url: string
  duplicate?: true
}

export type KockpitActionResult = { status: number; body: ErrorBody | SuccessBody }

export async function executeKockpitAction(
  requestId: string,
  payload: unknown,
  repository: KockpitActionsRepository = createKockpitActionsRepository(),
): Promise<KockpitActionResult> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) {
    return failure(400, 'invalid_request_id', 'A valid idempotency key is required.')
  }

  const actor = await repository.resolveActor(KOCKPIT_ACTIONS_ACTOR_EMAIL)
  if (!actor) return failure(500, 'actor_unavailable', 'Kockpit Actions actor is unavailable.')

  return executeKockpitActionForActor(requestId, payload, actor, 'external_api', repository)
}

export async function executeKockpitActionForActor(
  requestId: string,
  payload: unknown,
  actor: KockpitActionsActor,
  source: KockpitActionSource,
  repository: KockpitActionsRepository = createKockpitActionsRepository(),
): Promise<KockpitActionResult> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) {
    return failure(400, 'invalid_request_id', 'A valid idempotency key is required.')
  }

  const parsed = parseKockpitAction(payload, actor.id)
  if (parsed.error) return failure(parsed.error.status, parsed.error.code, parsed.error.message)
  const action = parsed.data!
  const requestHash = hashAction(action)

  const claim = await repository.claim(source, requestId, requestHash, action.action, actor.id)
  if (claim.kind === 'error') {
    return failure(500, 'idempotency_unavailable', 'Could not reserve the request ID.')
  }
  if (claim.kind === 'existing') return existingResult(claim.row, requestHash, action.input.title)

  const row = claim.row
  if (action.action === 'create_task') {
    if (action.input.owner_user_id !== actor.id && !canAssignToOthers(actor.role)) {
      return failClaim(repository, row.id, 403, 'assignment_forbidden', 'Actor cannot assign tasks to another user.')
    }
    if (!await repository.ownerExists(action.input.owner_user_id)) {
      return failClaim(repository, row.id, 422, 'invalid_owner', 'Task owner does not exist or is inactive.')
    }
    if (action.input.project_id && !await repository.projectExists(action.input.project_id)) {
      return failClaim(repository, row.id, 422, 'invalid_project', 'Project does not exist.')
    }

    const created = await repository.createTask(actor.id, action.input)
    if (!created.id || created.error) {
      return failClaim(repository, row.id, 500, 'creation_failed', 'Task could not be created.')
    }
    if (!await repository.markSucceeded(row.id, 'task', created.id)) {
      return failure(500, 'provenance_failed', 'Task was created but its action record could not be finalised.')
    }
    return success('create_task', created.id, action.input.title, `/tasks/${created.id}`)
  }

  const created = await repository.createTodo(actor.id, action.input)
  if (!created.id || created.error) {
    return failClaim(repository, row.id, 500, 'creation_failed', 'To-Do could not be created.')
  }
  if (!await repository.markSucceeded(row.id, 'todo', created.id)) {
    return failure(500, 'provenance_failed', 'To-Do was created but its action record could not be finalised.')
  }
  return success('create_todo', created.id, action.input.title, '/todos')
}

function existingResult(row: ActionRequestRow, requestHash: string, title: string): KockpitActionResult {
  if (row.request_hash !== requestHash) {
    return failure(409, 'idempotency_conflict', 'This request ID was already used with a different payload.')
  }
  if (row.status === 'succeeded' && row.result_entity_id && row.result_entity_type) {
    const action = row.action_type
    const url = row.result_entity_type === 'task' ? `/tasks/${row.result_entity_id}` : '/todos'
    return {
      status: 200,
      body: { ok: true, action, id: row.result_entity_id, title, url, duplicate: true },
    }
  }
  if (row.status === 'failed') {
    return failure(
      row.error_status ?? 500,
      row.error_code ?? 'previous_request_failed',
      row.error_message ?? 'The original request failed.',
    )
  }
  return failure(409, 'request_in_progress', 'A request with this ID is already in progress.')
}

async function failClaim(
  repository: KockpitActionsRepository,
  rowId: string,
  status: number,
  code: string,
  message: string,
): Promise<KockpitActionResult> {
  await repository.markFailed(rowId, code, message, status)
  return failure(status, code, message)
}

function hashAction(action: unknown): string {
  return createHash('sha256').update(JSON.stringify(action)).digest('hex')
}

function success(
  action: SuccessBody['action'],
  id: string,
  title: string,
  url: string,
): KockpitActionResult {
  return { status: 200, body: { ok: true, action, id, title, url } }
}

function failure(status: number, code: string, message: string): KockpitActionResult {
  return { status, body: { ok: false, error: { code, message } } }
}

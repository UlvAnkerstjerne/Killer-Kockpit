import { describe, it, expect } from 'vitest'
import { buildTaskEditInput, dueAtToInputValue, inputValueToDueAt, type TaskFormState } from '@/lib/tasks/edit-payload'
import { EDITABLE_TASK_STATUSES, isWorkflowManagedStatus, taskStatusLabel } from '@/lib/tasks/status'
import type { Task } from '@/lib/types'

const BASE = {
  id: 'task-1',
  title: 'Lufthavns actionplan',
  description: 'Fokus punkter',
  owner_user_id: 'owner-1',
  project_id: null,
  status: 'open',
  priority: 2,
  due_at: '2026-10-07T20:00:00+00:00',
} as unknown as Task

function formFor(task: Task, over: Partial<TaskFormState> = {}): TaskFormState {
  return {
    title: task.title,
    description: task.description ?? '',
    ownerId: task.owner_user_id ?? '',
    projectId: task.project_id ?? '',
    status: task.status,
    priority: task.priority,
    dueAt: dueAtToInputValue(task.due_at),
    ...over,
  }
}

describe('task status metadata', () => {
  it('offers only the four editable statuses', () => {
    expect([...EDITABLE_TASK_STATUSES]).toEqual(['proposed', 'open', 'in_progress', 'blocked'])
  })

  it('flags review/completion statuses as workflow-managed', () => {
    expect(isWorkflowManagedStatus('pending_review')).toBe(true)
    expect(isWorkflowManagedStatus('done')).toBe(true)
    expect(isWorkflowManagedStatus('cancelled')).toBe(true)
    for (const s of EDITABLE_TASK_STATUSES) expect(isWorkflowManagedStatus(s)).toBe(false)
  })

  it('labels every status, including ones the form cannot set', () => {
    expect(taskStatusLabel('pending_review')).toBe('Pending review')
    expect(taskStatusLabel('done')).toBe('Done')
    expect(taskStatusLabel('mystery_state')).toBe('mystery state')
  })
})

describe('buildTaskEditInput', () => {
  it('sends nothing for an untouched form (no spurious due_at write)', () => {
    expect(buildTaskEditInput(BASE, formFor(BASE))).toEqual({})
  })

  it.each(['pending_review', 'done', 'cancelled'] as const)(
    'never resubmits %s, so an unrelated edit leaves status alone',
    (status) => {
      const task = { ...BASE, status } as Task
      const input = buildTaskEditInput(task, formFor(task, { description: 'Updated notes' }))
      expect(input).toEqual({ description: 'Updated notes' })
      expect(input).not.toHaveProperty('status')
    },
  )

  it('does not move a workflow-managed task even if the form state were tampered with', () => {
    const task = { ...BASE, status: 'pending_review' } as Task
    expect(buildTaskEditInput(task, formFor(task, { status: 'open' }))).not.toHaveProperty('status')
  })

  it('sends an editable status change', () => {
    expect(buildTaskEditInput(BASE, formFor(BASE, { status: 'blocked' }))).toEqual({ status: 'blocked' })
  })

  it('sends due_at only when the person changed it, converted from Copenhagen to UTC', () => {
    expect(buildTaskEditInput(BASE, formFor(BASE, { dueAt: '2026-10-08T09:00' }))).toEqual({ due_at: '2026-10-08T07:00:00.000Z' })
  })

  it('reads stored UTC as Copenhagen wall time, across DST', () => {
    expect(dueAtToInputValue('2026-10-07T20:00:00+00:00')).toBe('2026-10-07T22:00') // CEST
    expect(dueAtToInputValue('2026-12-01T11:00:00Z')).toBe('2026-12-01T12:00') // CET
    expect(dueAtToInputValue(null)).toBe('')
  })

  it('an untouched form never rewrites the stored instant, even in the repeated DST hour', () => {
    // 25 Oct 2026: 02:30 Copenhagen happens twice (00:30Z CEST and 01:30Z CET) — one wall string, two instants.
    for (const iso of ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z', '2027-03-28T00:30:00.000Z', '2027-03-28T01:30:00.000Z']) {
      const task = { ...BASE, due_at: iso } as Task
      expect(buildTaskEditInput(task, formFor(task))).toEqual({})
    }
  })

  it('round-trips unambiguous times on either side of the DST switches', () => {
    for (const iso of ['2026-10-24T20:00:00.000Z', '2026-10-25T10:00:00.000Z', '2027-03-27T20:00:00.000Z', '2027-03-28T10:00:00.000Z']) {
      expect(inputValueToDueAt(dueAtToInputValue(iso))).toBe(iso)
    }
  })

  it('a summer and a winter entry of the same wall time map to different UTC offsets', () => {
    expect(inputValueToDueAt('2026-08-01T12:00')).toBe('2026-08-01T10:00:00.000Z')
    expect(inputValueToDueAt('2026-12-01T12:00')).toBe('2026-12-01T11:00:00.000Z')
  })

  it('keeps blank description / project / due as "no change" like the previous form', () => {
    const input = buildTaskEditInput(BASE, formFor(BASE, { description: '  ', projectId: '', dueAt: '' }))
    expect(input).toEqual({})
  })

  it('sends trimmed title, owner and priority changes', () => {
    expect(buildTaskEditInput(BASE, formFor(BASE, { title: ' New ', ownerId: 'owner-2', priority: 1 })))
      .toEqual({ title: 'New', owner_user_id: 'owner-2', priority: 1 })
  })
})

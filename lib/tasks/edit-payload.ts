// lib/tasks/edit-payload.ts
//
// Builds the updateTask() input for the edit form. Pure and unit-testable.
//
// Only fields the user actually changed are sent. This matters for two reasons:
//  - A workflow-managed status (pending_review / done / cancelled) is never
//    resubmitted by a generic save, so merely displaying it cannot move it.
//  - due_at is an instant; the form's datetime-local string is not byte-equal to the
//    stored value, and sending it back unchanged wrote a spurious "Due date changed"
//    audit event. The form reads/writes Europe/Copenhagen wall time and submits UTC ISO.
//    Stored timestamps are never rewritten unless the person edits the due field.

import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import { isWorkflowManagedStatus } from '@/lib/tasks/status'
import { utcToWall, wallToUtc } from '@/lib/time'

/** datetime-local value for a stored due_at: Europe/Copenhagen wall time (DST-aware). */
export function dueAtToInputValue(dueAt: string | null | undefined): string {
  return dueAt ? utcToWall(new Date(dueAt).toISOString()) : ''
}

/** Convert a datetime-local value (Copenhagen wall time) to the UTC ISO string stored in the DB. */
export function inputValueToDueAt(value: string): string {
  return wallToUtc(value)
}

export type TaskFormState = {
  title: string
  description: string
  ownerId: string
  projectId: string
  status: TaskStatus
  priority: TaskPriority
  dueAt: string
}

export type TaskEditInput = {
  title?: string
  description?: string
  owner_user_id?: string
  project_id?: string
  status?: TaskStatus
  priority?: TaskPriority
  due_at?: string
}

export function buildTaskEditInput(task: Task, form: TaskFormState): TaskEditInput {
  const input: TaskEditInput = {}

  if (form.title.trim() !== task.title) input.title = form.title.trim()
  // Blank description / project / due are "no change" (unchanged from the previous form behaviour).
  const description = form.description.trim()
  if (description && description !== (task.description || '')) input.description = description
  if (form.ownerId !== task.owner_user_id) input.owner_user_id = form.ownerId
  if (form.projectId && form.projectId !== (task.project_id || '')) input.project_id = form.projectId
  if (form.priority !== task.priority) input.priority = form.priority

  // Status: never resubmit a workflow-managed status, and never move out of one.
  if (!isWorkflowManagedStatus(task.status) && form.status !== task.status) {
    input.status = form.status
  }

  // Due: compare against the value the form was seeded with, not raw strings.
  if (form.dueAt && form.dueAt !== dueAtToInputValue(task.due_at)) input.due_at = inputValueToDueAt(form.dueAt)

  return input
}

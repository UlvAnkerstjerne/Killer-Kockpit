import type { KKRole } from './types'

// Centralised permission logic — no scattered role checks in components.
// All authorisation decisions flow through this module.
//
// Core principle:
//   role  → what you can see / do organisationally
//   relationship to the object → whether you may alter that commitment

export const MANAGEMENT_ROLES: KKRole[] = ['SUPER_ADMIN', 'UM']
export const ADMIN_ROLES: KKRole[] = ['SUPER_ADMIN']

// ─── Organisational role checks ────────────────────────────────────────────

export function canAccessManagementView(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

export function canAssignToOthers(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

export function canAccessAdminSettings(role: KKRole): boolean {
  return ADMIN_ROLES.includes(role)
}

export function canManageUsers(role: KKRole): boolean {
  return ADMIN_ROLES.includes(role)
}

// ─── Projects ──────────────────────────────────────────────────────────────
//
// Only the project owner or SUPER_ADMIN may edit or archive a project.
// UM role gives visibility, not authority over another user's project.

export function canEditProject(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  return ownerUserId === currentUserId
}

export function canArchiveProject(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  return canEditProject(role, ownerUserId, currentUserId)
}

// ─── Tasks ─────────────────────────────────────────────────────────────────
//
// A task has two sides:
//   Creator (created_by_user_id) — controls commitment terms: title, due date,
//     assignee, project, priority, description.
//   Assignee (owner_user_id)     — controls execution: may complete or cancel.
//
// SUPER_ADMIN may override either side.  Overrides must be tagged in the
// audit log via log_admin_override_audit().

/** Who may change commitment terms (title, due_at, assignee, scope). */
export function canEditTaskTerms(
  role: KKRole,
  creatorUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  return creatorUserId === currentUserId
}

/** Who may transition status (complete / cancel). */
export function canUpdateTaskStatus(
  role: KKRole,
  creatorUserId: string | null,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  return creatorUserId === currentUserId || ownerUserId === currentUserId
}

/**
 * Who may submit a change request for commitment terms.
 * Returns false for users who can already edit terms directly.
 */
export function canRequestTaskChange(
  role: KKRole,
  creatorUserId: string | null,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  // Already has full authority — no need to request
  if (canEditTaskTerms(role, creatorUserId, currentUserId)) return false
  // Assignee may request a change on their own task
  if (ownerUserId === currentUserId) return true
  // Management roles may request a change on any visible task
  if (MANAGEMENT_ROLES.includes(role)) return true
  return false
}

/** Who may approve or reject a change request. */
export function canReviewChangeRequest(
  role: KKRole,
  creatorUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  return creatorUserId === currentUserId
}

// ─── Waiting Ons ───────────────────────────────────────────────────────────
//
// Only the owner (creator) or SUPER_ADMIN may edit a waiting on.

export function canEditWaitingOn(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  return ownerUserId === currentUserId
}

// ─── Decisions ─────────────────────────────────────────────────────────────
//
// Creating a decision is management-only (any UM or SUPER_ADMIN).
// Editing a decision is restricted to the owner or SUPER_ADMIN —
// UM must not silently rewrite another user's institutional record.
// Supersession (preferred over silent edits) remains open to management.

export function canCreateDecision(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

export function canEditDecision(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  if (role === 'UM') return ownerUserId === currentUserId
  return false
}

export function canApproveDecision(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

// ─── Meetings ──────────────────────────────────────────────────────────────
//
// Creating / cancelling / publishing meetings is management-only.
// The owner of a meeting (or SUPER_ADMIN) may edit it while it is not
// published or cancelled.

export function canCreateMeeting(role: KKRole): boolean {
  return MANAGEMENT_ROLES.includes(role)
}

export function canEditMeeting(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  if (role === 'SUPER_ADMIN') return true
  return ownerUserId === currentUserId
}

// ─── Drive file references ─────────────────────────────────────────────────
//
// Drive references are NOT meeting content — they are external document pointers.
// Attaching/detaching a Drive reference does NOT alter minutes, outcomes,
// corrections, or any published content.
//
// Management users (UM / SUPER_ADMIN) and the meeting owner may attach or
// detach references on any non-cancelled meeting, including published ones,
// because a deck or final report may legitimately be linked after publication.
//
// Cancelled meetings accept no new references.

export function canManageDriveReferences(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string,
  meetingStatus: string | null,
): boolean {
  if (meetingStatus === 'cancelled') return false
  if (role === 'SUPER_ADMIN') return true
  if (ownerUserId === currentUserId) return true
  if (role === 'UM') return true
  return false
}

// ─── Meetings — transcript reading ─────────────────────────────────────────
//
// Transcript READ follows the same visibility rule as the meeting itself:
// any user legitimately allowed to view a meeting may read its transcript.
//
//   SUPER_ADMIN  — yes (sees all meetings)
//   UM           — yes (management visibility over all meetings)
//   Meeting owner — yes
//   Attending MEMBER (user_id in meeting_attendees) — yes
//   MEMBER with no relationship to the meeting — no
//
// No status gate — published-meeting transcripts remain readable as source
// material after the meeting is sealed.
//
// The isAttendee flag must be resolved by the caller via a meeting_attendees
// lookup for the MEMBER case.  Management roles and the owner short-circuit
// before the flag is checked, so the DB lookup can be skipped for them.

export function canReadTranscript(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string,
  isAttendee = false,
): boolean {
  if (role === 'SUPER_ADMIN') return true
  if (role === 'UM') return true
  if (ownerUserId === currentUserId) return true
  return isAttendee
}

// ─── Meetings — transcript management ──────────────────────────────────────
//
// Who may attach, replace, or remove a transcript:
//   SUPER_ADMIN    — yes, always (within allowed statuses)
//   UM             — yes (management role; responsible for meeting records)
//   Meeting owner  — yes (their own meeting)
//   MEMBER non-owner — NO (a plain attendee has no authority over the record)
//
// Allowed statuses: scheduled, open, draft.
// published/cancelled: sealed — no transcript changes permitted.
//
// Note: this controls WRITE operations only. Transcript CONTENT is never
// returned to the browser regardless of role (stored in sources.content,
// service-role access only).

const TRANSCRIPT_ALLOWED_STATUSES = new Set(['scheduled', 'open', 'draft'])

export function canManageTranscript(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string,
  meetingStatus: string | null,
): boolean {
  if (!meetingStatus || !TRANSCRIPT_ALLOWED_STATUSES.has(meetingStatus)) return false
  if (role === 'SUPER_ADMIN') return true
  if (role === 'UM') return true
  return ownerUserId === currentUserId
}

// ─── AI Draft ──────────────────────────────────────────────────────────────
//
// Generating or discarding an AI draft requires the same authority as managing
// a transcript — the meeting owner, UM, or SUPER_ADMIN — and the meeting must
// not be sealed (published or cancelled).
//
// Uses the same TRANSCRIPT_ALLOWED_STATUSES whitelist so the rules stay in sync.

export function canGenerateDraft(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string,
  meetingStatus: string | null,
): boolean {
  return canManageTranscript(role, ownerUserId, currentUserId, meetingStatus)
}

// ─── Marketing workspace ────────────────────────────────────────────────────
//
// canAccessMarketing gates entry to the Marketing workspace only.
// SUPER_ADMIN always has access regardless of the marketing_access flag.
// All other roles require marketing_access = true on their app_users row.
//
// This function does NOT encode per-action Marketing authority.
// Fine-grained Marketing permissions (approve content, approve paid-media
// recommendations, manage reviews) belong in a separate user_marketing_roles
// table to be introduced with the first Marketing feature that needs them.

export function canAccessMarketing(role: KKRole, marketingAccess: boolean): boolean {
  if (role === 'SUPER_ADMIN') return true
  return marketingAccess
}

// ─── SUPER_ADMIN override detection ────────────────────────────────────────
//
// Returns true when a SUPER_ADMIN is acting on a record they do not own.
// The caller is responsible for logging the override via log_admin_override_audit.

export function isAdminOverride(
  role: KKRole,
  ownerUserId: string | null,
  currentUserId: string
): boolean {
  return role === 'SUPER_ADMIN' && ownerUserId !== currentUserId
}

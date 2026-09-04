import { describe, it, expect } from 'vitest'
import {
  canAccessManagementView,
  canAssignToOthers,
  canAccessAdminSettings,
  canEditProject,
  canArchiveProject,
  canEditTaskTerms,
  canUpdateTaskStatus,
  canRequestTaskChange,
  canReviewChangeRequest,
  canEditWaitingOn,
  canCreateDecision,
  canEditDecision,
  canApproveDecision,
  isAdminOverride,
  canAccessMarketing,
  canManagePeople,
  canManageLocations,
  canUseGmailInbox,
} from '@/lib/permissions'

const USER_A = 'user-a-uuid'
const USER_B = 'user-b-uuid'

// ---- canAccessManagementView ------------------------------------------------

describe('canAccessManagementView', () => {
  it('SUPER_ADMIN can access management view', () => {
    expect(canAccessManagementView('SUPER_ADMIN')).toBe(true)
  })
  it('UM can access management view', () => {
    expect(canAccessManagementView('UM')).toBe(true)
  })
  it('MEMBER cannot access management view', () => {
    expect(canAccessManagementView('MEMBER')).toBe(false)
  })
})

// ---- canAssignToOthers ------------------------------------------------------

describe('canAssignToOthers', () => {
  it('SUPER_ADMIN can assign to others', () => {
    expect(canAssignToOthers('SUPER_ADMIN')).toBe(true)
  })
  it('UM can assign to others', () => {
    expect(canAssignToOthers('UM')).toBe(true)
  })
  it('MEMBER cannot assign to others', () => {
    expect(canAssignToOthers('MEMBER')).toBe(false)
  })
})

// ---- canAccessAdminSettings -------------------------------------------------

describe('canAccessAdminSettings', () => {
  it('SUPER_ADMIN can access admin settings', () => {
    expect(canAccessAdminSettings('SUPER_ADMIN')).toBe(true)
  })
  it('UM cannot access admin settings', () => {
    expect(canAccessAdminSettings('UM')).toBe(false)
  })
  it('MEMBER cannot access admin settings', () => {
    expect(canAccessAdminSettings('MEMBER')).toBe(false)
  })
})

// ---- canEditProject ---------------------------------------------------------

describe('canEditProject', () => {
  it('SUPER_ADMIN can edit any project regardless of ownership', () => {
    expect(canEditProject('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
    expect(canEditProject('SUPER_ADMIN', null, USER_A)).toBe(true)
  })
  it('UM can edit only their own project', () => {
    expect(canEditProject('UM', USER_A, USER_A)).toBe(true)
  })
  it('UM cannot edit a project owned by someone else', () => {
    expect(canEditProject('UM', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER can edit their own project', () => {
    expect(canEditProject('MEMBER', USER_A, USER_A)).toBe(true)
  })
  it('MEMBER cannot edit a project owned by someone else', () => {
    expect(canEditProject('MEMBER', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER cannot edit a project with no owner', () => {
    expect(canEditProject('MEMBER', null, USER_A)).toBe(false)
  })
})

// ---- canArchiveProject ------------------------------------------------------

describe('canArchiveProject', () => {
  it('SUPER_ADMIN can archive any project', () => {
    expect(canArchiveProject('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
  })
  it('UM can archive only their own project', () => {
    expect(canArchiveProject('UM', USER_A, USER_A)).toBe(true)
  })
  it('UM cannot archive a project they do not own', () => {
    expect(canArchiveProject('UM', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER can archive their own project', () => {
    expect(canArchiveProject('MEMBER', USER_A, USER_A)).toBe(true)
  })
  it('MEMBER cannot archive a project they do not own', () => {
    expect(canArchiveProject('MEMBER', USER_B, USER_A)).toBe(false)
  })
})

// ---- canEditTaskTerms -------------------------------------------------------
// Creator controls commitment terms (title, due_at, assignee, scope).

describe('canEditTaskTerms', () => {
  it('SUPER_ADMIN can edit any task terms', () => {
    expect(canEditTaskTerms('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
    expect(canEditTaskTerms('SUPER_ADMIN', null, USER_A)).toBe(true)
  })
  it('creator (UM) can edit their own task terms', () => {
    expect(canEditTaskTerms('UM', USER_A, USER_A)).toBe(true)
  })
  it('UM cannot edit task terms for a task created by someone else', () => {
    expect(canEditTaskTerms('UM', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER creator can edit their own task terms', () => {
    expect(canEditTaskTerms('MEMBER', USER_A, USER_A)).toBe(true)
  })
  it('MEMBER cannot edit task terms created by someone else', () => {
    expect(canEditTaskTerms('MEMBER', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER cannot edit task terms with no creator', () => {
    expect(canEditTaskTerms('MEMBER', null, USER_A)).toBe(false)
  })
})

// ---- canUpdateTaskStatus ----------------------------------------------------
// Creator or assignee may complete/cancel a task.

describe('canUpdateTaskStatus', () => {
  it('SUPER_ADMIN can update any task status', () => {
    expect(canUpdateTaskStatus('SUPER_ADMIN', USER_B, USER_B, USER_A)).toBe(true)
  })
  it('creator can update status on their own task', () => {
    expect(canUpdateTaskStatus('UM', USER_A, USER_B, USER_A)).toBe(true)
  })
  it('assignee (owner) can update status even when not creator', () => {
    expect(canUpdateTaskStatus('MEMBER', USER_B, USER_A, USER_A)).toBe(true)
  })
  it('UM who is neither creator nor assignee cannot update status', () => {
    expect(canUpdateTaskStatus('UM', USER_B, USER_B, USER_A)).toBe(false)
  })
  it('MEMBER who is neither creator nor assignee cannot update status', () => {
    expect(canUpdateTaskStatus('MEMBER', USER_B, USER_B, USER_A)).toBe(false)
  })
})

// ---- canRequestTaskChange ---------------------------------------------------

describe('canRequestTaskChange', () => {
  it('SUPER_ADMIN returns false (already has full edit authority)', () => {
    expect(canRequestTaskChange('SUPER_ADMIN', USER_B, USER_A, USER_A)).toBe(false)
  })
  it('creator returns false (already has full edit authority)', () => {
    expect(canRequestTaskChange('UM', USER_A, USER_B, USER_A)).toBe(false)
  })
  it('assignee who is not the creator can request a change', () => {
    expect(canRequestTaskChange('MEMBER', USER_B, USER_A, USER_A)).toBe(true)
  })
  it('UM who is neither creator nor assignee can request a change', () => {
    expect(canRequestTaskChange('UM', USER_B, USER_B, USER_A)).toBe(true)
  })
})

// ---- canReviewChangeRequest -------------------------------------------------

describe('canReviewChangeRequest', () => {
  it('SUPER_ADMIN can review any change request', () => {
    expect(canReviewChangeRequest('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
  })
  it('creator can review change requests on their task', () => {
    expect(canReviewChangeRequest('UM', USER_A, USER_A)).toBe(true)
  })
  it('non-creator cannot review change requests', () => {
    expect(canReviewChangeRequest('UM', USER_B, USER_A)).toBe(false)
    expect(canReviewChangeRequest('MEMBER', USER_B, USER_A)).toBe(false)
  })
})

// ---- canEditWaitingOn -------------------------------------------------------

describe('canEditWaitingOn', () => {
  it('SUPER_ADMIN can edit any waiting on', () => {
    expect(canEditWaitingOn('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
  })
  it('owner can edit their own waiting on', () => {
    expect(canEditWaitingOn('UM', USER_A, USER_A)).toBe(true)
    expect(canEditWaitingOn('MEMBER', USER_A, USER_A)).toBe(true)
  })
  it('UM cannot edit a waiting on owned by someone else', () => {
    expect(canEditWaitingOn('UM', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER cannot edit a waiting on they do not own', () => {
    expect(canEditWaitingOn('MEMBER', USER_B, USER_A)).toBe(false)
  })
})

// ---- canCreateDecision / canEditDecision / canApproveDecision ---------------

describe('canCreateDecision', () => {
  it('SUPER_ADMIN and UM can create decisions', () => {
    expect(canCreateDecision('SUPER_ADMIN')).toBe(true)
    expect(canCreateDecision('UM')).toBe(true)
  })
  it('MEMBER cannot create decisions', () => {
    expect(canCreateDecision('MEMBER')).toBe(false)
  })
})

describe('canEditDecision', () => {
  it('SUPER_ADMIN can edit any decision', () => {
    expect(canEditDecision('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
  })
  it('owner can edit their own decision', () => {
    expect(canEditDecision('UM', USER_A, USER_A)).toBe(true)
  })
  it('UM cannot edit a decision owned by someone else', () => {
    expect(canEditDecision('UM', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER cannot edit any decision', () => {
    expect(canEditDecision('MEMBER', USER_A, USER_A)).toBe(false)
  })
})

describe('canApproveDecision', () => {
  it('SUPER_ADMIN and UM can approve decisions', () => {
    expect(canApproveDecision('SUPER_ADMIN')).toBe(true)
    expect(canApproveDecision('UM')).toBe(true)
  })
  it('MEMBER cannot approve decisions', () => {
    expect(canApproveDecision('MEMBER')).toBe(false)
  })
})

// ---- canAccessMarketing -----------------------------------------------------

describe('canAccessMarketing', () => {
  it('SUPER_ADMIN can always access marketing regardless of marketing_access flag', () => {
    expect(canAccessMarketing('SUPER_ADMIN', false)).toBe(true)
    expect(canAccessMarketing('SUPER_ADMIN', true)).toBe(true)
  })
  it('UM with marketing_access=true can access marketing', () => {
    expect(canAccessMarketing('UM', true)).toBe(true)
  })
  it('UM without marketing_access cannot access marketing', () => {
    expect(canAccessMarketing('UM', false)).toBe(false)
  })
  it('MEMBER with marketing_access=true can access marketing', () => {
    expect(canAccessMarketing('MEMBER', true)).toBe(true)
  })
  it('MEMBER without marketing_access cannot access marketing', () => {
    expect(canAccessMarketing('MEMBER', false)).toBe(false)
  })
})

// ---- canManagePeople --------------------------------------------------------

describe('canManagePeople', () => {
  it('SUPER_ADMIN can manage people', () => {
    expect(canManagePeople('SUPER_ADMIN')).toBe(true)
  })
  it('UM can manage people', () => {
    expect(canManagePeople('UM')).toBe(true)
  })
  it('MEMBER cannot manage people', () => {
    expect(canManagePeople('MEMBER')).toBe(false)
  })
})

// ---- canManageLocations -----------------------------------------------------

describe('canManageLocations', () => {
  it('SUPER_ADMIN can manage locations', () => {
    expect(canManageLocations('SUPER_ADMIN')).toBe(true)
  })
  it('UM can manage locations', () => {
    expect(canManageLocations('UM')).toBe(true)
  })
  it('MEMBER cannot manage locations', () => {
    expect(canManageLocations('MEMBER')).toBe(false)
  })
})

// ---- canUseGmailInbox -------------------------------------------------------

describe('canUseGmailInbox', () => {
  it('SUPER_ADMIN can use Gmail inbox', () => {
    expect(canUseGmailInbox('SUPER_ADMIN')).toBe(true)
  })
  it('UM can use Gmail inbox', () => {
    expect(canUseGmailInbox('UM')).toBe(true)
  })
  it('MEMBER cannot use Gmail inbox', () => {
    expect(canUseGmailInbox('MEMBER')).toBe(false)
  })
})

// ---- isAdminOverride --------------------------------------------------------

describe('isAdminOverride', () => {
  it('is true when SUPER_ADMIN edits another user\'s record', () => {
    expect(isAdminOverride('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
    expect(isAdminOverride('SUPER_ADMIN', null, USER_A)).toBe(true)
  })
  it('is false when SUPER_ADMIN edits their own record', () => {
    expect(isAdminOverride('SUPER_ADMIN', USER_A, USER_A)).toBe(false)
  })
  it('is false for non-SUPER_ADMIN roles', () => {
    expect(isAdminOverride('UM', USER_B, USER_A)).toBe(false)
    expect(isAdminOverride('MEMBER', USER_B, USER_A)).toBe(false)
  })
})

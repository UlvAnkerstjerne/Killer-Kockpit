import { describe, it, expect } from 'vitest'
import {
  canAccessManagementView,
  canAssignToOthers,
  canAccessAdminSettings,
  canEditProject,
  canEditTask,
  canArchiveProject,
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
  it('UM can edit any project regardless of ownership', () => {
    expect(canEditProject('UM', USER_B, USER_A)).toBe(true)
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

// ---- canEditTask ------------------------------------------------------------

describe('canEditTask', () => {
  it('SUPER_ADMIN can edit any task', () => {
    expect(canEditTask('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
  })
  it('UM can edit any task', () => {
    expect(canEditTask('UM', USER_B, USER_A)).toBe(true)
  })
  it('MEMBER can edit their own task', () => {
    expect(canEditTask('MEMBER', USER_A, USER_A)).toBe(true)
  })
  it('MEMBER cannot edit a task owned by someone else', () => {
    expect(canEditTask('MEMBER', USER_B, USER_A)).toBe(false)
  })
  it('MEMBER cannot edit a task with no owner', () => {
    expect(canEditTask('MEMBER', null, USER_A)).toBe(false)
  })
})

// ---- canArchiveProject ------------------------------------------------------

describe('canArchiveProject', () => {
  it('SUPER_ADMIN can archive any project', () => {
    expect(canArchiveProject('SUPER_ADMIN', USER_B, USER_A)).toBe(true)
  })
  it('UM can archive any project', () => {
    expect(canArchiveProject('UM', USER_B, USER_A)).toBe(true)
  })
  it('MEMBER can archive their own project', () => {
    expect(canArchiveProject('MEMBER', USER_A, USER_A)).toBe(true)
  })
  it('MEMBER cannot archive a project they do not own', () => {
    expect(canArchiveProject('MEMBER', USER_B, USER_A)).toBe(false)
  })
})

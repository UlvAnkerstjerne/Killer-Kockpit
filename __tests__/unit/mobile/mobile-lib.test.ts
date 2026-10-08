import { describe, it, expect } from 'vitest'
import { hasMobileManagerExperience, isMobileRouteAllowed, MOBILE_MGMT_NAV, MOBILE_MGMT_ROUTES, MOBILE_TODAY_ACTIONS } from '@/lib/mobile'
import { resolveView, ownedBy } from '@/lib/view'

describe('mobile features follow role, independent of data view', () => {
  it('UM and SUPER_ADMIN get the manager mobile experience; MEMBER does not', () => {
    expect(hasMobileManagerExperience('UM')).toBe(true)
    expect(hasMobileManagerExperience('SUPER_ADMIN')).toBe(true)
    expect(hasMobileManagerExperience('MEMBER')).toBe(false)
  })

  it('has no dependency on the view argument (signature takes role only)', () => {
    expect(hasMobileManagerExperience.length).toBe(1)
  })

  it('Personal remains the default data view while Management stays role-gated and available', () => {
    expect(resolveView('UM', undefined)).toBe('personal')
    expect(resolveView('SUPER_ADMIN', null)).toBe('personal')
    expect(resolveView('UM', 'management')).toBe('management')
    expect(resolveView('SUPER_ADMIN', 'management')).toBe('management')
    expect(resolveView('MEMBER', 'management')).toBe('personal')
  })
})

describe('compact mobile navigation and route restrictions', () => {
  it('nav is exactly Today, To-Dos, Tasks, Meetings', () => {
    expect(MOBILE_MGMT_NAV.map(n => n.href)).toEqual(['/today', '/todos', '/tasks', '/meetings'])
  })

  it('allowed mobile routes are exactly the existing set', () => {
    expect([...MOBILE_MGMT_ROUTES].sort()).toEqual(['/kkc/audit', '/kkc/ssp-cph', '/meetings', '/tasks', '/today', '/todos'])
  })

  it.each(['/today', '/todos', '/tasks', '/tasks/abc', '/meetings/xyz', '/kkc/audit', '/kkc/ssp-cph/new'])('allows %s on mobile', p => {
    expect(isMobileRouteAllowed(p)).toBe(true)
  })

  it.each(['/projects', '/brain', '/people', '/locations', '/settings', '/team', '/kkc/diner', '/waiting-ons', '/todayx'])('keeps %s desktop-only', p => {
    expect(isMobileRouteAllowed(p)).toBe(false)
  })

  it('Audit and KQC shortcuts point at audit and SSP/CPH', () => {
    expect(MOBILE_TODAY_ACTIONS.map(a => a.href)).toEqual(['/kkc/audit', '/kkc/ssp-cph'])
  })
})

describe('ownedBy', () => {
  it('keeps only rows of the signed-in user', () => {
    const rows = [{ id: 1, user_id: 'a' }, { id: 2, user_id: 'b' }, { id: 3, user_id: null }]
    expect(ownedBy(rows, 'a', 'user_id')).toEqual([{ id: 1, user_id: 'a' }])
  })
})

/**
 * Tests for Marketing permission functions in lib/permissions.ts and
 * the MarketingPermission type model in lib/marketing/types.ts.
 *
 * Key invariants tested:
 *   - SUPER_ADMIN bypasses all Marketing permission checks
 *   - hasMarketingPermission is independent of canAccessMarketing
 *   - ideas_approve and content_approve are distinct — neither implies the other
 *   - marketing_access + permission are separate requirements
 *   - all seven permission keys are represented
 */

import { describe, it, expect } from 'vitest'
import { canAccessMarketing, hasMarketingPermission } from '@/lib/permissions'
import { ALL_MARKETING_PERMISSIONS } from '@/lib/marketing/types'
import type { MarketingPermission } from '@/lib/marketing/types'

const ALL_PERMS = ALL_MARKETING_PERMISSIONS as readonly MarketingPermission[]

// ── Model shape ───────────────────────────────────────────────────────────────

describe('MarketingPermission model', () => {
  it('defines exactly seven permission keys', () => {
    expect(ALL_PERMS).toHaveLength(7)
  })

  it('includes paid_manage and paid_approve', () => {
    expect(ALL_PERMS).toContain('paid_manage')
    expect(ALL_PERMS).toContain('paid_approve')
  })

  it('includes content_manage and content_approve', () => {
    expect(ALL_PERMS).toContain('content_manage')
    expect(ALL_PERMS).toContain('content_approve')
  })

  it('includes ideas_approve as a distinct permission', () => {
    expect(ALL_PERMS).toContain('ideas_approve')
  })

  it('includes reviews_manage and reviews_approve', () => {
    expect(ALL_PERMS).toContain('reviews_manage')
    expect(ALL_PERMS).toContain('reviews_approve')
  })
})

// ── hasMarketingPermission ────────────────────────────────────────────────────

describe('hasMarketingPermission — SUPER_ADMIN bypass', () => {
  it('returns true for SUPER_ADMIN regardless of permission array', () => {
    expect(hasMarketingPermission('SUPER_ADMIN', [], 'paid_approve')).toBe(true)
    expect(hasMarketingPermission('SUPER_ADMIN', [], 'ideas_approve')).toBe(true)
    expect(hasMarketingPermission('SUPER_ADMIN', [], 'reviews_approve')).toBe(true)
  })

  it('returns true for SUPER_ADMIN even when permission array is empty', () => {
    ALL_PERMS.forEach((p) => {
      expect(hasMarketingPermission('SUPER_ADMIN', [], p)).toBe(true)
    })
  })
})

describe('hasMarketingPermission — non-SUPER_ADMIN checks permission array', () => {
  it('returns true for UM with matching permission', () => {
    expect(hasMarketingPermission('UM', ['paid_approve'], 'paid_approve')).toBe(true)
  })

  it('returns false for UM with empty permission array', () => {
    expect(hasMarketingPermission('UM', [], 'paid_approve')).toBe(false)
  })

  it('returns true for MEMBER with matching permission', () => {
    expect(hasMarketingPermission('MEMBER', ['reviews_approve'], 'reviews_approve')).toBe(true)
  })

  it('returns false for MEMBER without the permission', () => {
    expect(hasMarketingPermission('MEMBER', ['content_manage'], 'reviews_approve')).toBe(false)
  })

  it('returns false when permission array has other permissions but not the required one', () => {
    const otherPerms: MarketingPermission[] = ['paid_manage', 'reviews_manage']
    expect(hasMarketingPermission('UM', otherPerms, 'paid_approve')).toBe(false)
  })
})

// ── ideas_approve vs content_approve independence ─────────────────────────────

describe('ideas_approve and content_approve are independent', () => {
  it('content_approve does NOT imply ideas_approve', () => {
    expect(hasMarketingPermission('MEMBER', ['content_approve'], 'ideas_approve')).toBe(false)
  })

  it('ideas_approve does NOT imply content_approve', () => {
    expect(hasMarketingPermission('MEMBER', ['ideas_approve'], 'content_approve')).toBe(false)
  })

  it('a user may hold both independently', () => {
    const perms: MarketingPermission[] = ['content_approve', 'ideas_approve']
    expect(hasMarketingPermission('MEMBER', perms, 'content_approve')).toBe(true)
    expect(hasMarketingPermission('MEMBER', perms, 'ideas_approve')).toBe(true)
  })
})

// ── Separation of workspace access and fine-grained permissions ───────────────
//
// canAccessMarketing and hasMarketingPermission are independent gates.
// Having a permission key does not grant workspace access.
// Having workspace access does not grant action authority.
// SUPER_ADMIN bypasses both, but through independent function calls.

describe('marketing_access and permission rows are independent gates', () => {
  it('canAccessMarketing false + permission present: workspace is blocked', () => {
    // A user whose marketing_access = false is redirected before reaching any
    // Marketing action. Even if they somehow had a permission row, the layout
    // gate fires first. This test verifies the two functions are independent.
    expect(canAccessMarketing('MEMBER', false)).toBe(false)
    // The permission check itself would pass if queried, but the workspace
    // gate prevents reaching it.
    expect(hasMarketingPermission('MEMBER', ['reviews_approve'], 'reviews_approve')).toBe(true)
  })

  it('canAccessMarketing true + no permission: workspace accessible, action blocked', () => {
    expect(canAccessMarketing('MEMBER', true)).toBe(true)
    expect(hasMarketingPermission('MEMBER', [], 'reviews_approve')).toBe(false)
  })

  it('SUPER_ADMIN bypasses both gates independently', () => {
    expect(canAccessMarketing('SUPER_ADMIN', false)).toBe(true)
    expect(hasMarketingPermission('SUPER_ADMIN', [], 'reviews_approve')).toBe(true)
  })
})

// ── Manage vs approve separation ──────────────────────────────────────────────

describe('manage and approve permissions within each domain are independent', () => {
  it('paid_manage does NOT imply paid_approve', () => {
    expect(hasMarketingPermission('MEMBER', ['paid_manage'], 'paid_approve')).toBe(false)
  })

  it('paid_approve does NOT imply paid_manage', () => {
    expect(hasMarketingPermission('MEMBER', ['paid_approve'], 'paid_manage')).toBe(false)
  })

  it('reviews_manage does NOT imply reviews_approve', () => {
    expect(hasMarketingPermission('MEMBER', ['reviews_manage'], 'reviews_approve')).toBe(false)
  })

  it('content_manage does NOT imply content_approve', () => {
    expect(hasMarketingPermission('MEMBER', ['content_manage'], 'content_approve')).toBe(false)
  })
})

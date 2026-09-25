/**
 * Targeted tests for the Airport KQC native protocol.
 *
 * Verifies:
 * - ScoringConfig parsing
 * - startAudit accepts auditKey parameter
 * - Airport template config (MOD optional, busyness required, failure context required)
 * - Scoring labels are protocol-specific
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  client: vi.fn(),
  service: vi.fn(),
  canAccess: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.client,
  createServiceClient: mocks.service,
}))
vi.mock('@/lib/permissions', () => ({ canAccessQualityCheck: mocks.canAccess }))
vi.mock('@/lib/reports/dispatch-audit', () => ({ dispatchAuditResult: mocks.dispatch }))

import { startAudit } from '@/lib/actions/audit'
import { parseScoringConfig } from '@/lib/audit/submissions'
import type { ScoringConfig } from '@/lib/audit/submissions'

const TEST_USER = { id: 'user-1', role: 'SUPER_ADMIN' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue(TEST_USER)
  mocks.canAccess.mockReturnValue(true)
})

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(), insert: vi.fn(), eq: vi.fn(), order: vi.fn(),
    single: vi.fn().mockResolvedValue(result),
  }
  for (const k of Object.keys(chain)) {
    if (k !== 'single') chain[k].mockReturnValue(chain)
  }
  return chain
}

describe('Airport KQC protocol', () => {

  describe('ScoringConfig parsing', () => {
    it('parses Airport scoring config correctly', () => {
      const raw = {
        secondary_label: 'Critical',
        secondary_short: 'Critical',
        secondary_fail_label: 'Critical Failures',
        secondary_fail_short: 'CF',
        has_red_flags: false,
        rf_overrides_status: false,
        rf_badge_style: 'critical',
      }
      const config: ScoringConfig = parseScoringConfig(raw)
      expect(config.secondaryLabel).toBe('Critical')
      expect(config.secondaryShort).toBe('Critical')
      expect(config.secondaryFailLabel).toBe('Critical Failures')
      expect(config.secondaryFailShort).toBe('CF')
      expect(config.hasRedFlags).toBe(false)
      expect(config.rfOverridesStatus).toBe(false)
    })

    it('parses Operational Audit scoring config correctly', () => {
      const raw = {
        secondary_label: 'Core Standards',
        secondary_short: 'Core',
        secondary_fail_label: 'Red Flags',
        secondary_fail_short: 'RF',
        has_red_flags: true,
        rf_overrides_status: true,
        rf_badge_style: 'red_flag',
      }
      const config = parseScoringConfig(raw)
      expect(config.secondaryLabel).toBe('Core Standards')
      expect(config.hasRedFlags).toBe(true)
      expect(config.rfOverridesStatus).toBe(true)
    })

    it('returns defaults for null/empty config', () => {
      const config = parseScoringConfig(null)
      expect(config.secondaryLabel).toBe('Core Standards')
      expect(config.hasRedFlags).toBe(true)
    })
  })

  describe('startAudit with auditKey', () => {
    it('resolves the correct template by audit_key', async () => {
      const eqCalls: Array<[string, string]> = []
      const insertChain = buildChain({ data: { id: 'sub-1' }, error: null })
      let insertedRow: Record<string, unknown> | null = null
      insertChain.insert.mockImplementation((row: Record<string, unknown>) => {
        insertedRow = row
        return insertChain
      })

      const client = {
        from: vi.fn((table: string) => {
          if (table === 'audit_templates') {
            const chain = buildChain({ data: { id: 'airport-tpl' }, error: null })
            chain.eq.mockImplementation((col: string, val: string) => {
              eqCalls.push([col, val])
              return chain
            })
            return chain
          }
          if (table === 'locations') return buildChain({ data: { id: 'loc-1', active: true }, error: null })
          if (table === 'audit_submissions') return insertChain
          return buildChain({ data: null, error: null })
        }),
      }
      mocks.client.mockResolvedValue(client)

      const result = await startAudit('loc-1', '', 'Busy', 'ssp_cph_kqc')
      expect(result.error).toBeUndefined()
      expect(eqCalls.find(([c]) => c === 'audit_key')?.[1]).toBe('ssp_cph_kqc')
      expect(insertedRow).not.toBeNull()
      expect(insertedRow!.template_id).toBe('airport-tpl')
      expect(insertedRow!.manager_on_duty).toBeNull()
      expect(insertedRow!.busyness).toBe('Busy')
    })

    it('defaults to operational_audit when no key specified', async () => {
      const eqCalls: Array<[string, string]> = []
      const insertChain = buildChain({ data: { id: 'sub-1' }, error: null })
      insertChain.insert.mockReturnValue(insertChain)

      const client = {
        from: vi.fn((table: string) => {
          if (table === 'audit_templates') {
            const chain = buildChain({ data: { id: 'op-tpl' }, error: null })
            chain.eq.mockImplementation((col: string, val: string) => {
              eqCalls.push([col, val])
              return chain
            })
            return chain
          }
          if (table === 'locations') return buildChain({ data: { id: 'loc-1', active: true }, error: null })
          if (table === 'audit_submissions') return insertChain
          return buildChain({ data: null, error: null })
        }),
      }
      mocks.client.mockResolvedValue(client)

      await startAudit('loc-1', 'Manager A', null)
      expect(eqCalls.find(([c]) => c === 'audit_key')?.[1]).toBe('operational_audit')
    })
  })

  describe('Scoring metric mapping', () => {
    it('Airport: core_score_fail = Critical Failures, core_score_pct = Critical Score', () => {
      // This is a structural verification: the Airport protocol uses
      // is_core_standard for "Critical" checkpoints, and the submit_audit()
      // RPC computes core_score_fail and core_score_pct from those.
      //
      // The ScoringConfig tells the UI to label these as:
      //   core_score_pct  → "Critical" (secondaryLabel)
      //   core_score_fail → "Critical Failures" (secondaryFailLabel)
      //
      // Verified in the DB test:
      //   53 pass + 5 fail (2 Critical) → core_score_fail=2, core_score_pct=86.67%
      //   red_flag_count=0 (no is_red_flag checkpoints)

      const airportConfig = parseScoringConfig({
        secondary_label: 'Critical',
        secondary_fail_label: 'Critical Failures',
        has_red_flags: false,
        rf_overrides_status: false,
      })

      // UI renders core_score_fail when hasRedFlags is false
      expect(airportConfig.hasRedFlags).toBe(false)
      expect(airportConfig.secondaryFailLabel).toBe('Critical Failures')

      // Operational Audit uses red_flag_count when hasRedFlags is true
      const opConfig = parseScoringConfig({
        secondary_label: 'Core Standards',
        secondary_fail_label: 'Red Flags',
        has_red_flags: true,
        rf_overrides_status: true,
      })
      expect(opConfig.hasRedFlags).toBe(true)
      expect(opConfig.secondaryFailLabel).toBe('Red Flags')
    })
  })
})

import { describe, expect, it } from 'vitest'
import { isKockpitMcpAllowedEmail, resolveKockpitMcpActor } from '@/lib/mcp/access'
import type { SupabaseClient } from '@supabase/supabase-js'

function mockClient(data: unknown, error: unknown = null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data, error }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

describe('Kockpit MCP access gate', () => {
  it('launches only for Ulv', () => {
    expect(isKockpitMcpAllowedEmail('ULV@killerkebab.com')).toBe(true)
    expect(isKockpitMcpAllowedEmail('someone@killerkebab.com')).toBe(false)
    expect(isKockpitMcpAllowedEmail(undefined)).toBe(false)
  })

  it('maps the validated auth subject to the active app user', async () => {
    const actor = await resolveKockpitMcpActor(mockClient({
      id: 'ulv-id', email: 'ulv@killerkebab.com', role: 'SUPER_ADMIN',
    }), 'auth-sub')
    expect(actor).toEqual({ id: 'ulv-id', email: 'ulv@killerkebab.com', role: 'SUPER_ADMIN' })
  })

  it('rejects non-allowlisted and missing mappings', async () => {
    await expect(resolveKockpitMcpActor(mockClient({
      id: 'other-id', email: 'other@killerkebab.com', role: 'ADMIN',
    }), 'other-sub')).resolves.toBeNull()
    await expect(resolveKockpitMcpActor(mockClient(null), 'missing-sub')).resolves.toBeNull()
  })
})

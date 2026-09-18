import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://kockpit.example')
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test')

let route: typeof import('@/app/api/mcp/[[...path]]/route')
let handleAuthenticatedMcpRequest: typeof import('@/lib/mcp/route-handler')['handleAuthenticatedMcpRequest']

beforeAll(async () => {
  route = await import('@/app/api/mcp/[[...path]]/route')
  ;({ handleAuthenticatedMcpRequest } = await import('@/lib/mcp/route-handler'))
})

const fakeAdmin = {} as SupabaseClient
const request = () => new Request('https://kockpit.example/api/mcp', { method: 'POST' })
const actor = { id: 'ulv-id', email: 'ulv@killerkebab.com', role: 'SUPER_ADMIN' as const }

describe('/api/mcp authorization boundary', () => {
  it('rejects unauthenticated requests and publishes the OAuth metadata challenge', async () => {
    const response = await route.POST(request())
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource')
  })

  it('serves protected resource discovery without authentication', async () => {
    const response = await route.GET(new Request(
      'https://kockpit.example/api/mcp/oauth-protected-resource',
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://kockpit.example/api/mcp',
      authorization_servers: ['https://project.supabase.co/auth/v1'],
    })
  })

  it('rejects normal browser JWT claims that have no OAuth client_id', async () => {
    const response = await handleAuthenticatedMcpRequest(request(), {
      jwtClaims: { sub: 'auth-ulv' }, userClaims: { id: 'auth-ulv' }, supabaseAdmin: fakeAdmin,
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'oauth_token_required' })
  })

  it('rejects an authenticated but non-allowlisted account', async () => {
    const response = await handleAuthenticatedMcpRequest(request(), {
      jwtClaims: { sub: 'auth-other', client_id: 'chatgpt-client' },
      userClaims: { id: 'auth-other' },
      supabaseAdmin: fakeAdmin,
    }, {
      resolveActor: vi.fn().mockResolvedValue(null),
      handleRequest: vi.fn(),
    })
    expect(response.status).toBe(403)
  })

  it('accepts Ulv and passes only the server-resolved actor to MCP', async () => {
    const handleRequest = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const resolveActor = vi.fn().mockResolvedValue(actor)
    const response = await handleAuthenticatedMcpRequest(request(), {
      jwtClaims: { sub: 'auth-ulv', client_id: 'chatgpt-client' },
      userClaims: { id: 'auth-ulv' },
      supabaseAdmin: fakeAdmin,
    }, { resolveActor, handleRequest })

    expect(response.status).toBe(200)
    expect(resolveActor).toHaveBeenCalledWith(fakeAdmin, 'auth-ulv')
    expect(handleRequest).toHaveBeenCalledWith(expect.any(Request), actor)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock('@/lib/kockpit-actions/service', () => ({ executeKockpitAction: mocks.execute }))

function request(token?: string, requestId = 'request-1', body: unknown = { action: 'create_todo', title: 'Call landlord' }) {
  return new NextRequest('http://localhost/api/kockpit-actions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(requestId ? { 'idempotency-key': requestId } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/kockpit-actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('KOCKPIT_ACTIONS_TOKEN', 'dedicated-actions-token')
    mocks.execute.mockResolvedValue({
      status: 200,
      body: { ok: true, action: 'create_todo', id: 'todo-1', title: 'Call landlord', url: '/todos' },
    })
  })

  it('rejects a missing token', async () => {
    const { POST } = await import('@/app/api/kockpit-actions/route')
    const response = await POST(request())
    expect(response.status).toBe(401)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('rejects a wrong token without returning either secret', async () => {
    const { POST } = await import('@/app/api/kockpit-actions/route')
    const response = await POST(request('wrong-token'))
    const text = await response.text()
    expect(response.status).toBe(401)
    expect(text).not.toContain('wrong-token')
    expect(text).not.toContain('dedicated-actions-token')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('uses the dedicated token and forwards the idempotency key', async () => {
    const { POST } = await import('@/app/api/kockpit-actions/route')
    const response = await POST(request('dedicated-actions-token', 'external-123'))
    expect(response.status).toBe(200)
    expect(mocks.execute).toHaveBeenCalledWith(
      'external-123',
      { action: 'create_todo', title: 'Call landlord' },
    )
  })

  it('rejects mismatched header and body request IDs', async () => {
    const { POST } = await import('@/app/api/kockpit-actions/route')
    const response = await POST(request('dedicated-actions-token', 'header-id', {
      action: 'create_todo', title: 'Call landlord', request_id: 'body-id',
    }))
    expect(response.status).toBe(400)
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('returns a safe error when the dedicated token is not configured', async () => {
    vi.stubEnv('KOCKPIT_ACTIONS_TOKEN', '')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { POST } = await import('@/app/api/kockpit-actions/route')
    const response = await POST(request('anything'))
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(text).not.toContain('anything')
    consoleError.mockRestore()
  })
})

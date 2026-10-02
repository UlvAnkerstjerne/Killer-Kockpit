/**
 * Tests for AssemblyAI webhook secret validation.
 *
 * Verifies:
 * - Requests without the secret header are rejected 401
 * - Requests with a wrong secret are rejected 401
 * - Uses timing-safe comparison (timingSafeEqual) to prevent timing attacks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const WEBHOOK_SECRET = 'test-webhook-secret-value'

// Mock environment
vi.stubEnv('ASSEMBLYAI_WEBHOOK_SECRET', WEBHOOK_SECRET)

// Mock Supabase service client — webhook doesn't need full DB for auth tests
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/assemblyai/client', () => ({
  getTranscript: vi.fn(),
}))

vi.mock('@/lib/assemblyai/transcript', () => ({
  buildTranscript: vi.fn(),
}))

function makeRequest(secret?: string, body = { transcript_id: 'tx-1', status: 'completed' }) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (secret) headers.set('x-assemblyai-webhook-secret', secret)
  return new NextRequest('https://kockpit.test/api/assemblyai/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('AssemblyAI webhook auth', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects requests without the secret header', async () => {
    const { POST } = await import('@/app/api/assemblyai/webhook/route')
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
  })

  it('rejects requests with an incorrect secret', async () => {
    const { POST } = await import('@/app/api/assemblyai/webhook/route')
    const res = await POST(makeRequest('wrong-secret'))
    expect(res.status).toBe(401)
  })

  it('rejects requests with a secret of different length', async () => {
    const { POST } = await import('@/app/api/assemblyai/webhook/route')
    const res = await POST(makeRequest('short'))
    expect(res.status).toBe(401)
  })

  it('accepts requests with the correct secret', async () => {
    const { POST } = await import('@/app/api/assemblyai/webhook/route')
    const res = await POST(makeRequest(WEBHOOK_SECRET))
    // 200 because the transcript lookup returns null (no matching recording)
    expect(res.status).toBe(200)
  })

  it('uses timingSafeEqual from crypto (not bare !== comparison)', async () => {
    // Verify the import exists — this is a static check that the code
    // was updated to use timingSafeEqual rather than string comparison
    const routeSource = await import('fs').then(fs =>
      fs.readFileSync(
        require('path').resolve(__dirname, '../../../app/api/assemblyai/webhook/route.ts'),
        'utf-8'
      )
    )
    expect(routeSource).toContain('timingSafeEqual')
    expect(routeSource).toContain("from 'crypto'")
  })
})

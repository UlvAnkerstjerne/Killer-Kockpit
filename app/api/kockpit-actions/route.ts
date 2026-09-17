import { NextResponse, type NextRequest } from 'next/server'
import { isValidKockpitActionsToken, readBearerToken } from '@/lib/kockpit-actions/auth'
import { executeKockpitAction } from '@/lib/kockpit-actions/service'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const expectedToken = process.env.KOCKPIT_ACTIONS_TOKEN
  if (!expectedToken) {
    console.error('[api/kockpit-actions] KOCKPIT_ACTIONS_TOKEN is not configured.')
    return errorResponse(500, 'server_misconfiguration', 'Server misconfiguration.')
  }

  const providedToken = readBearerToken(request.headers.get('authorization'))
  if (!isValidKockpitActionsToken(providedToken, expectedToken)) {
    return errorResponse(401, 'unauthorized', 'Unauthorized.')
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return errorResponse(400, 'invalid_json', 'Request body must be valid JSON.')
  }

  const headerRequestId = request.headers.get('idempotency-key')?.trim() || ''
  const bodyRequestId = isRecord(payload) && typeof payload.request_id === 'string'
    ? payload.request_id.trim()
    : ''
  if (headerRequestId && bodyRequestId && headerRequestId !== bodyRequestId) {
    return errorResponse(400, 'request_id_mismatch', 'Idempotency-Key and request_id must match.')
  }

  try {
    const result = await executeKockpitAction(headerRequestId || bodyRequestId, payload)
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    console.error('[api/kockpit-actions] Unexpected failure:', error instanceof Error ? error.message : 'Unknown error')
    return errorResponse(500, 'internal_error', 'Action failed unexpectedly.')
  }
}

export async function GET() {
  return errorResponse(405, 'method_not_allowed', 'Method not allowed.')
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { NextResponse, type NextRequest } from 'next/server'
import { runWeeklyImpactDispatch } from '@/lib/weekly-impact/dispatch'

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization !== `Bearer ${cronSecret}`) return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })

  const body = await request.text()
  let testUserId: string | undefined
  if (body.trim()) {
    try {
      const input = JSON.parse(body)
      if (!input || Object.keys(input).length !== 1 || typeof input.testUserId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.testUserId)) {
        return NextResponse.json({ error: 'Provide exactly one testUserId, or an empty body for the scheduled job.' }, { status: 400 })
      }
      testUserId = input.testUserId
    } catch {
      return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
    }
  }

  try {
    const result = await runWeeklyImpactDispatch(new Date(), testUserId)
    return NextResponse.json(result, { status: result.failed > 0 ? 503 : 200 })
  } catch (error) {
    console.error('[api/weekly-impact/deliver] Dispatch failed:', error)
    return NextResponse.json({ error: 'Weekly Impact dispatch failed.' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}

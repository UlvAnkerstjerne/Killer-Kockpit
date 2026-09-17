// Backwards-compatible cron URL. Both routes use the same orchestrator and lease.
export { POST } from '@/app/api/google/gbp/sync/route'
import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'
export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}

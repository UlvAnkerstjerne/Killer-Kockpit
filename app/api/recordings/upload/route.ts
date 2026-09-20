/**
 * POST /api/recordings/upload — REMOVED
 *
 * This binary-proxy endpoint has been replaced by a two-step direct-upload flow
 * to avoid routing large audio files through Railway:
 *
 *   POST /api/recordings/init     — returns a signed upload URL
 *   POST /api/recordings/finalize — verifies storage + submits to AssemblyAI
 */

import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    { error: 'This endpoint has been replaced. Use /api/recordings/init and /api/recordings/finalize.' },
    { status: 410 },
  )
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 })
}

/**
 * GET /api/diner/pdf/[submissionId]
 *
 * Generates and streams the Mystery Diner result PDF for management users.
 * Auth: Kockpit session (getCurrentUser), requires canAccessQualityCheck role.
 *
 * Returns 200 application/pdf with Content-Disposition: attachment.
 * Returns 403 when the user is not authorised.
 * Returns 404 when the submission does not exist or is not yet submitted.
 * Returns 500 on PDF generation failure.
 */

import { type NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { loadDinerPdfData, generateDinerPdf, buildDinerPdfFilename } from '@/lib/reports/generate-diner-pdf'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = await getCurrentUser()
  if (!user || !canAccessQualityCheck(user.role)) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const { submissionId } = await params

  // ── Load data ─────────────────────────────────────────────────────────────
  const data = await loadDinerPdfData(submissionId).catch(err => {
    console.error('[api/diner/pdf] loadDinerPdfData error:', err)
    return null
  })

  if (!data) {
    return new NextResponse('Submission not found or not yet submitted.', { status: 404 })
  }

  // ── Generate PDF ──────────────────────────────────────────────────────────
  let buf: Buffer
  try {
    buf = await generateDinerPdf(data, new Date().toISOString())
  } catch (err) {
    console.error('[api/diner/pdf] PDF generation error:', err)
    return new NextResponse('PDF generation failed.', { status: 500 })
  }

  const filename = buildDinerPdfFilename(data.locationName, data.submittedAt)

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(buf.byteLength),
      'Cache-Control':       'private, no-store',
    },
  })
}

/**
 * GET /api/kkc/ssp-cph/preview-overview?count=4
 *
 * Temporary QA endpoint — generates the new SSP/CPH matrix overview PDF
 * and returns it inline so the browser renders it for visual inspection.
 *
 * Management access only. Remove after QA sign-off.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser }        from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { fetchSSPCphDataDirect } from '@/lib/kkc/ssp-cph'
import { generateSspOverviewPdf } from '@/lib/reports/generate-ssp-overview-pdf'

export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAccessQualityCheck(user.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rawCount = request.nextUrl.searchParams.get('count')
  const count    = rawCount ? Math.min(50, Math.max(1, parseInt(rawCount, 10) || 4)) : 4

  let data: Awaited<ReturnType<typeof fetchSSPCphDataDirect>>
  try {
    data = await fetchSSPCphDataDirect()
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }

  const buf = await generateSspOverviewPdf({
    data,
    count,
    generatedAt: new Date().toISOString(),
  })

  return new NextResponse(new Uint8Array(buf), {
    status:  200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'inline; filename="ssp-overview-preview.pdf"',
    },
  })
}

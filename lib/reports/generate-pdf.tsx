/**
 * lib/reports/generate-pdf.tsx
 *
 * Server-side PDF generation helpers.
 * Server-only — do not import from client components.
 *
 * Usage:
 *   const buf = await generateKKCPdf(detail, 'SSP / CPH Airport')
 *   // buf is a Node.js Buffer containing a valid PDF
 */

import { renderToBuffer } from '@react-pdf/renderer'
import { KKCReportDocument } from './kkc-report'
import type { KKCSubmissionDetail } from '@/lib/kkc/ssp-cph'

/**
 * Renders a Killer Kuality Check submission as a PDF buffer.
 *
 * @param detail        Submission detail from buildSubmissionDetail()
 * @param locationLabel Human-readable location name (e.g. "SSP / CPH Airport")
 * @param generatedAt   Optional ISO timestamp for the "Generated" footer line
 * @returns             Node.js Buffer containing the PDF bytes
 */
export async function generateKKCPdf(
  detail:        KKCSubmissionDetail,
  locationLabel: string,
  generatedAt?:  string,
): Promise<Buffer> {
  const buf = await renderToBuffer(
    <KKCReportDocument
      detail={detail}
      locationLabel={locationLabel}
      generatedAt={generatedAt}
    />
  )
  return Buffer.from(buf)
}

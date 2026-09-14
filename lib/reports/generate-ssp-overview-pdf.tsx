/**
 * lib/reports/generate-ssp-overview-pdf.tsx
 *
 * Renders the SSP/CPH-specific matrix overview as a PDF buffer.
 * Server-only — do not import from client components.
 */

import { renderToBuffer } from '@react-pdf/renderer'
import { SspOverviewDocument } from './ssp-overview-report'
import type { SspOverviewInput } from './ssp-overview-report'

export type { SspOverviewInput }

/**
 * Generates the SSP/CPH matrix overview PDF.
 *
 * @param input  Full KKCSspCphData + count + optional generatedAt timestamp
 * @returns      Node.js Buffer containing valid PDF bytes
 */
export async function generateSspOverviewPdf(input: SspOverviewInput): Promise<Buffer> {
  const buf = await renderToBuffer(
    <SspOverviewDocument input={input} />
  )
  return Buffer.from(buf)
}

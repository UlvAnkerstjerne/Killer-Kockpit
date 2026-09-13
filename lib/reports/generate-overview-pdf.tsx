/**
 * lib/reports/generate-overview-pdf.tsx
 *
 * Renders a multi-report executive overview as a PDF buffer.
 * Server-only — do not import from client components.
 */

import { renderToBuffer } from '@react-pdf/renderer'
import { OverviewDocument } from './overview-report'
import type { OverviewInput } from './overview-report'

export type { OverviewInput, OverviewSystem, OverviewRow, OverviewAuditRow, OverviewDinerRow, OverviewSspRow } from './overview-report'

/**
 * Renders an OverviewInput as a PDF buffer.
 *
 * @param input   Pre-assembled overview data (system, rows, locationLabel, count)
 * @returns       Node.js Buffer containing valid PDF bytes
 */
export async function generateOverviewPdf(input: OverviewInput): Promise<Buffer> {
  const buf = await renderToBuffer(
    <OverviewDocument input={input} />
  )
  return Buffer.from(buf)
}

/**
 * Builds the canonical PDF filename for an overview.
 * Format: KQC-Overview-{system}-{locationSlug}-last{count}-{YYYY-MM-DD}.pdf
 */
export function buildOverviewFilename(
  system:        string,
  locationLabel: string,
  count:         number,
): string {
  const safeLoc  = locationLabel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
  const dateStr  = new Date().toISOString().slice(0, 10)
  const safeSystem = system === 'ssp_cph' ? 'SSP-CPH' : system.charAt(0).toUpperCase() + system.slice(1)
  return `KQC-Overview-${safeSystem}-${safeLoc}-last${count}-${dateStr}.pdf`
}

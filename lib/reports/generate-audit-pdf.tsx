/**
 * lib/reports/generate-audit-pdf.tsx
 *
 * Renders an Audit submission as a PDF buffer.
 * Server-only — do not import from client components.
 */

import { renderToBuffer } from '@react-pdf/renderer'
import { AuditReportDocument } from './audit-report'
import type { AuditReportInput } from './audit-report'

export type { AuditReportInput, AuditReportTopAction } from './audit-report'

/**
 * Renders the Audit report PDF and returns a Node.js Buffer.
 *
 * @param input       All fields required to render the report
 * @returns           Buffer containing valid PDF bytes
 */
export async function generateAuditPdf(input: AuditReportInput): Promise<Buffer> {
  const buf = await renderToBuffer(<AuditReportDocument input={input} />)
  return Buffer.from(buf)
}

/**
 * lib/kkc/detail.ts
 *
 * Pure client-safe utility: builds a submission detail view from cached
 * KKCSspCphData without any server-only dependencies.
 *
 * Safe to import from client components.
 */

import type {
  KKCSspCphData,
  KKCCheckpointResult,
  KKCResult,
  KKCSectionComment,
  KKCSubmissionDetail,
} from './ssp-cph'

export function buildSubmissionDetail(
  data: KKCSspCphData,
  timestamp: string,
): KKCSubmissionDetail | null {
  const scoreRow = data.scores.find((s) => s.timestamp === timestamp)
  if (!scoreRow) return null

  const formRow = data.formRows.find((r) => r[0] === timestamp)
  if (!formRow) {
    return {
      ...scoreRow,
      checkpoints:            [],
      criticalFailureDetails: [],
      sectionComments:        [],
      overallComments:        null,
    }
  }

  const headerIndex = new Map(data.formHeaders.map((h, i) => [h, i]))
  const responseHeaderSet = new Set(data.config.map((c) => c.responseHeader))

  const checkpoints: KKCCheckpointResult[] = data.config.map((cp) => {
    const idx = headerIndex.get(cp.responseHeader)
    const raw = idx !== undefined ? (formRow[idx] ?? '').trim() : ''
    const result: KKCResult | null =
      raw === 'Acceptable' || raw === 'Unacceptable' ? raw : null
    return {
      section:    cp.section,
      checkpoint: cp.checkpoint,
      isCritical: cp.isCritical,
      result,
    }
  })

  const criticalFailureDetails = checkpoints.filter(
    (cp) => cp.isCritical && cp.result === 'Unacceptable',
  )

  const sectionComments: KKCSectionComment[] = []
  let overallComments: string | null = null

  data.formHeaders.forEach((header, i) => {
    if (responseHeaderSet.has(header)) return
    const lh = header.toLowerCase()
    if (!lh.includes('comment') && !lh.includes('observation')) return
    const text = (formRow[i] ?? '').trim()
    if (!text) return
    if (lh.includes('overall') || lh.includes('general')) {
      overallComments = text
    } else {
      sectionComments.push({ header, text })
    }
  })

  return {
    timestamp:        scoreRow.timestamp,
    date:             scoreRow.date,
    time:             scoreRow.time,
    mysteryDiner:     scoreRow.mysteryDiner,
    productsOrdered:  scoreRow.productsOrdered,
    overallScore:     scoreRow.overallScore,
    criticalScore:    scoreRow.criticalScore,
    criticalFailures: scoreRow.criticalFailures,
    checkpoints,
    criticalFailureDetails,
    sectionComments,
    overallComments,
  }
}

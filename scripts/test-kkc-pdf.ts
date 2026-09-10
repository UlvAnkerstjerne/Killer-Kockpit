/**
 * scripts/test-kkc-pdf.ts
 *
 * Smoke test for the KKC PDF generator.
 * Builds a realistic sample submission and writes the PDF to /tmp/kkc-test.pdf.
 *
 * Run:
 *   npx tsx scripts/test-kkc-pdf.ts
 */

import { writeFileSync } from 'fs'
import path from 'path'
import type { KKCSubmissionDetail } from '../lib/kkc/ssp-cph'
import { generateKKCPdf } from '../lib/reports/generate-pdf'

// ─── Sample submission (realistic SSP/CPH data) ───────────────────────────────

const sampleDetail: KKCSubmissionDetail = {
  timestamp:        '9/10/2026 2:15:00',
  date:             '10 Sep 2026',
  time:             '02:15',
  mysteryDiner:     'Sara',
  productsOrdered:  'Kebab Wrap, Fries',
  overallScore:     73,
  criticalScore:    40,
  criticalFailures: 6,

  checkpoints: [
    // Prep / Operations
    { section: 'Prep / Operations', checkpoint: 'Prep correctly dated and within date / fresh',              isCritical: true,  result: 'Unacceptable' },
    { section: 'Prep / Operations', checkpoint: 'Meat weighed using scale',                                  isCritical: true,  result: 'Unacceptable' },
    { section: 'Prep / Operations', checkpoint: 'Meat holding temperature',                                  isCritical: true,  result: 'Acceptable'   },
    { section: 'Prep / Operations', checkpoint: 'Lid used correctly',                                        isCritical: true,  result: 'Unacceptable' },
    { section: 'Prep / Operations', checkpoint: 'Blade properly sharp / cut straight with no mushrooming',  isCritical: false, result: 'Acceptable'   },
    { section: 'Prep / Operations', checkpoint: 'Bread baked fresh to order',                               isCritical: true,  result: 'Acceptable'   },
    // Service / Staff
    { section: 'Service / Staff', checkpoint: 'All staff in uniform',            isCritical: true,  result: 'Unacceptable' },
    { section: 'Service / Staff', checkpoint: 'Eye contact when ordering',       isCritical: false, result: 'Acceptable'   },
    { section: 'Service / Staff', checkpoint: 'Eye contact at pickup',           isCritical: false, result: 'Unacceptable' },
    { section: 'Service / Staff', checkpoint: 'Verbal interaction at pickup',    isCritical: false, result: 'Acceptable'   },
    // Killer Kebab (product)
    { section: 'Killer Kebab', checkpoint: 'Meat temperature',              isCritical: true,  result: 'Unacceptable' },
    { section: 'Killer Kebab', checkpoint: 'Bread temperature',             isCritical: true,  result: 'Unacceptable' },
    { section: 'Killer Kebab', checkpoint: 'Bread fluffiness',              isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Bread caramelisation',          isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Meat caramelisation',           isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Meat texture / juiciness',      isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Distribution',                  isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Mint yoghurt sauce',            isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Parsley',                       isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Onion',                         isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Dukkah',                        isCritical: false, result: 'Acceptable'   },
    { section: 'Killer Kebab', checkpoint: 'Harissa',                       isCritical: false, result: 'Acceptable'   },
    // Fries
    { section: 'Fries', checkpoint: 'Dukkah present', isCritical: false, result: 'Acceptable' },
    { section: 'Fries', checkpoint: 'Salt',           isCritical: false, result: 'Acceptable' },
    { section: 'Fries', checkpoint: 'Warm',           isCritical: true,  result: 'Acceptable' },
    { section: 'Fries', checkpoint: 'Crispy',         isCritical: false, result: 'Acceptable' },
    // Killer Kylling (not ordered)
    { section: 'Killer Kylling', checkpoint: 'Chicken temperature',     isCritical: true,  result: null },
    { section: 'Killer Kylling', checkpoint: 'Bread temperature',       isCritical: true,  result: null },
    { section: 'Killer Kylling', checkpoint: 'Bread fluffiness',        isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Bread caramelisation',    isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Chicken caramelisation',  isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Chicken texture / juiciness', isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Distribution',            isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Zhugurt',                 isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Parsley',                 isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Killer Cucumbers',        isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Cabbage',                 isCritical: false, result: null },
    { section: 'Killer Kylling', checkpoint: 'Harissa',                 isCritical: false, result: null },
  ],

  criticalFailureDetails: [
    { section: 'Prep / Operations', checkpoint: 'Prep correctly dated and within date / fresh', isCritical: true, result: 'Unacceptable' },
    { section: 'Prep / Operations', checkpoint: 'Meat weighed using scale',                    isCritical: true, result: 'Unacceptable' },
    { section: 'Prep / Operations', checkpoint: 'Lid used correctly',                          isCritical: true, result: 'Unacceptable' },
    { section: 'Service / Staff',   checkpoint: 'All staff in uniform',                        isCritical: true, result: 'Unacceptable' },
    { section: 'Killer Kebab',      checkpoint: 'Meat temperature',                            isCritical: true, result: 'Unacceptable' },
    { section: 'Killer Kebab',      checkpoint: 'Bread temperature',                           isCritical: true, result: 'Unacceptable' },
  ],

  sectionComments: [
    {
      header: 'Comments — Prep / Operations',
      text:   'The bread was just ahead. There were no tickets when I arrived and yet 2 breads already baked. The tickets after me all had fresh bread. VERY frustrating.',
    },
    {
      header: 'Comments — Service / Staff',
      text:   'Low customer interaction. Contact happens when customers walk up themselves.',
    },
  ],

  overallComments: 'The meat quality was high but temperature issues were a recurring problem. Prep standards need urgent attention.',
}

// ─── Generate ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Generating KQC PDF...')

  const buf = await generateKKCPdf(
    sampleDetail,
    'SSP / CPH Airport',
    new Date().toISOString(),
  )

  const outPath = path.join('/tmp', 'kkc-test.pdf')
  writeFileSync(outPath, buf)

  const kb = (buf.byteLength / 1024).toFixed(1)
  console.log(`✓ PDF written to ${outPath} (${kb} KB)`)
  console.log(`  Pages:     1+ (A4)`)
  console.log(`  Sections:  ${new Set(sampleDetail.checkpoints.map(c => c.section)).size}`)
  console.log(`  Crit fails: ${sampleDetail.criticalFailures}`)
}

main().catch(err => {
  console.error('✗ PDF generation failed:', err)
  process.exit(1)
})

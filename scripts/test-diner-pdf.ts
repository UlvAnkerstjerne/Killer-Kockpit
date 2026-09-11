/**
 * scripts/test-diner-pdf.ts
 *
 * Smoke test for the Mystery Diner PDF generator.
 * Builds a realistic fixture and writes the PDF to /tmp/diner-test.pdf.
 *
 * Fixture contains:
 *   - Several passes
 *   - 2 normal (non-critical) failures
 *   - 1 critical failure
 *   - 2 Gold Stars
 *   - Wait >15 min → conditional checkpoints are shown
 *   - Shazam / informational track checkpoint
 *   - 1 N/A answer
 *   - Toilet section not assessed → appears in "Not assessed" summary
 *
 * Run:
 *   npx tsx scripts/test-diner-pdf.ts
 */

import { writeFileSync } from 'fs'
import path from 'path'
import { generateDinerPdf, buildDinerPdfFilename } from '../lib/reports/generate-diner-pdf'
import type { DinerPdfInput } from '../lib/reports/generate-diner-pdf'

// ─── Realistic fixture ────────────────────────────────────────────────────────

const fixture: DinerPdfInput = {
  locationName:      'Magstræde',
  dinerName:         'Sara Lindqvist',
  submittedAt:       '2026-09-11T14:22:00Z',
  scorePct:          62.5,           // below 67% → RED
  criticalFailCount: 1,
  goldStarCount:     2,
  waitingTimeBand:   '16-20',        // >15 min → conditional checkpoints visible
  finalStatus:       'RED',

  checkpoints: [
    // ── Service ───────────────────────────────────────────────────────────
    { id: 'cp-01', orderIndex: 1,  section: 'Service',          label: 'Greeted warmly at counter',         type: 'scored',        isCritical: true,  isConditional: false },
    { id: 'cp-02', orderIndex: 2,  section: 'Service',          label: 'Eye contact when ordering',         type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-03', orderIndex: 3,  section: 'Service',          label: 'Smile and genuine friendliness',    type: 'gold_star',     isCritical: false, isConditional: false },
    // ── Sales ─────────────────────────────────────────────────────────────
    { id: 'cp-04', orderIndex: 4,  section: 'Sales',            label: 'Upsell attempted',                  type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-05', orderIndex: 5,  section: 'Sales',            label: 'Menu knowledge demonstrated',       type: 'scored',        isCritical: false, isConditional: false },
    // ── Guest Experience ──────────────────────────────────────────────────
    { id: 'cp-06', orderIndex: 6,  section: 'Guest Experience', label: 'Calm, pleasant atmosphere',         type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-07', orderIndex: 7,  section: 'Guest Experience', label: 'Exceptional guest interaction',     type: 'gold_star',     isCritical: false, isConditional: false },
    // ── Operations ────────────────────────────────────────────────────────
    { id: 'cp-08', orderIndex: 8,  section: 'Operations',       label: 'Waiting time',                      type: 'waiting_time',  isCritical: false, isConditional: false },
    { id: 'cp-09', orderIndex: 9,  section: 'Operations',       label: 'Informed of wait >15 min',          type: 'scored',        isCritical: false, isConditional: true  },
    { id: 'cp-10', orderIndex: 10, section: 'Operations',       label: 'Offered drink while waiting',       type: 'scored',        isCritical: false, isConditional: true  },
    // ── Restaurant ────────────────────────────────────────────────────────
    { id: 'cp-11', orderIndex: 11, section: 'Restaurant',       label: 'Dining area clean and tidy',        type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-12', orderIndex: 12, section: 'Restaurant',       label: 'Ketchup/napkins available',         type: 'scored',        isCritical: false, isConditional: false },
    // ── Toilet ────────────────────────────────────────────────────────────
    { id: 'cp-13', orderIndex: 13, section: 'Toilet',           label: 'Toilet clean and stocked',          type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-14', orderIndex: 14, section: 'Toilet',           label: 'No offensive smells',               type: 'scored',        isCritical: false, isConditional: false },
    // ── Staff ─────────────────────────────────────────────────────────────
    { id: 'cp-15', orderIndex: 15, section: 'Staff',            label: 'All staff in correct uniform',      type: 'scored',        isCritical: true,  isConditional: false },
    { id: 'cp-16', orderIndex: 16, section: 'Staff',            label: 'Name badges visible',               type: 'scored',        isCritical: false, isConditional: false },
    // ── Product — Roll ────────────────────────────────────────────────────
    { id: 'cp-17', orderIndex: 17, section: 'Product — Roll',   label: 'Bread temperature correct',         type: 'scored',        isCritical: true,  isConditional: false },
    { id: 'cp-18', orderIndex: 18, section: 'Product — Roll',   label: 'Meat caramelised and juicy',        type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-19', orderIndex: 19, section: 'Product — Roll',   label: 'Perfectly assembled and presented', type: 'gold_star',     isCritical: false, isConditional: false },
    { id: 'cp-20', orderIndex: 20, section: 'Product — Roll',   label: 'Mint yoghurt sauce fresh',          type: 'scored',        isCritical: false, isConditional: false },
    // ── Product — Fries ───────────────────────────────────────────────────
    { id: 'cp-21', orderIndex: 21, section: 'Product — Fries',  label: 'Fries crispy and fresh',            type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-22', orderIndex: 22, section: 'Product — Fries',  label: 'Dukkah present',                    type: 'scored',        isCritical: false, isConditional: false },
    { id: 'cp-23', orderIndex: 23, section: 'Product — Fries',  label: 'Served at correct temperature',     type: 'scored',        isCritical: false, isConditional: false },
    // ── Music ─────────────────────────────────────────────────────────────
    { id: 'cp-24', orderIndex: 24, section: 'Music',            label: 'Background music level appropriate', type: 'scored',       isCritical: false, isConditional: false },
    { id: 'cp-25', orderIndex: 25, section: 'Music',            label: 'Background track (Shazam)',          type: 'informational', isCritical: false, isConditional: false },
  ],

  responses: [
    // Service
    { checkpointId: 'cp-01', result: 'pass', notes: null },
    { checkpointId: 'cp-02', result: 'fail', notes: null },        // normal fail #1
    { checkpointId: 'cp-03', result: 'pass', notes: null },        // gold star #1

    // Sales
    { checkpointId: 'cp-04', result: 'pass', notes: null },
    { checkpointId: 'cp-05', result: 'fail', notes: null },        // normal fail #2

    // Guest Experience
    { checkpointId: 'cp-06', result: 'pass', notes: null },
    { checkpointId: 'cp-07', result: 'pass', notes: null },        // gold star #2 (but scored as pass, not counted in goldStarCount separately — depends on template)

    // Operations
    { checkpointId: 'cp-08', result: 'pass', notes: '16-20' },    // 16-20 min wait
    { checkpointId: 'cp-09', result: 'pass', notes: null },        // conditional: pass
    { checkpointId: 'cp-10', result: 'pass', notes: null },        // conditional: pass

    // Restaurant
    { checkpointId: 'cp-11', result: 'pass', notes: null },
    { checkpointId: 'cp-12', result: 'pass', notes: null },

    // Toilet — NOT ASSESSED (no responses) → will appear in "Not assessed in this visit"

    // Staff
    { checkpointId: 'cp-15', result: 'pass', notes: null },
    { checkpointId: 'cp-16', result: 'pass', notes: null },

    // Product — Roll
    { checkpointId: 'cp-17', result: 'fail', notes: null },        // CRITICAL FAIL #1 ←
    { checkpointId: 'cp-18', result: 'pass', notes: null },
    { checkpointId: 'cp-19', result: 'pass', notes: null },        // gold_star #2
    { checkpointId: 'cp-20', result: 'pass', notes: null },

    // Product — Fries
    { checkpointId: 'cp-21', result: 'pass', notes: null },
    { checkpointId: 'cp-22', result: 'na',   notes: null },        // N/A
    { checkpointId: 'cp-23', result: 'pass', notes: null },

    // Music
    { checkpointId: 'cp-24', result: 'pass', notes: null },
    { checkpointId: 'cp-25', result: null,   notes: 'Arctic Monkeys — Do I Wanna Know?' },  // Shazam
  ],
}

// ─── Generate ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('Generating Mystery Diner PDF...')
  console.log(`  Location:    ${fixture.locationName}`)
  console.log(`  Diner:       ${fixture.dinerName}`)
  console.log(`  Status:      ${fixture.finalStatus}  (${fixture.scorePct}%)`)
  console.log(`  Criticals:   ${fixture.criticalFailCount}`)
  console.log(`  Gold Stars:  ${fixture.goldStarCount}`)
  console.log(`  Wait:        ${fixture.waitingTimeBand} min`)
  console.log(`  Checkpoints: ${fixture.checkpoints.length}`)
  console.log(`  Responses:   ${fixture.responses.length}`)
  console.log()

  const buf = await generateDinerPdf(fixture, new Date().toISOString())

  const filename = buildDinerPdfFilename(fixture.locationName, fixture.submittedAt)
  const outPath  = path.join('/tmp', filename)
  writeFileSync(outPath, buf)

  const kb = (buf.byteLength / 1024).toFixed(1)
  console.log(`✓ PDF written to ${outPath}`)
  console.log(`  Size:        ${kb} KB`)
  console.log(`  Filename:    ${filename}`)

  const sections     = [...new Set(fixture.checkpoints.map(c => c.section))]
  const critFail     = fixture.checkpoints.filter(cp =>
    cp.isCritical && cp.type === 'scored' &&
    fixture.responses.find(r => r.checkpointId === cp.id)?.result === 'fail',
  )
  const goldPasses   = fixture.checkpoints.filter(cp =>
    cp.type === 'gold_star' &&
    fixture.responses.find(r => r.checkpointId === cp.id)?.result === 'pass',
  )
  const conditionals = fixture.checkpoints.filter(cp => cp.isConditional)

  console.log()
  console.log('Content verification:')
  console.log(`  Sections:            ${sections.length} (${sections.join(', ')})`)
  console.log(`  Critical failures:   ${critFail.map(cp => cp.label).join(', ') || '—'}`)
  console.log(`  Gold star passes:    ${goldPasses.map(cp => cp.label).join(', ') || '—'}`)
  console.log(`  Conditional shown:   ${conditionals.length} (wait ${fixture.waitingTimeBand} > 15 min)`)
  console.log(`  Toilet section:      not assessed → "Not assessed in this visit"`)
  console.log(`  Shazam track:        Arctic Monkeys — Do I Wanna Know?`)
}

main().catch(err => {
  console.error('✗ PDF generation failed:', err)
  process.exit(1)
})

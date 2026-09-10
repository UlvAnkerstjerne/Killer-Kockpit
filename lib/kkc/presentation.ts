/**
 * lib/kkc/presentation.ts
 *
 * Shared presentation constants for the KKC SSP/CPH dashboard and PDF report.
 * Section order, display names, and checkpoint order are defined here once
 * so the PDF cannot drift from the live dashboard.
 *
 * The data (section names, checkpoint wording, critical flags) comes from the
 * live Config tab. This file controls only presentation-layer ordering/labelling.
 */

/** Canonical section display order — matches KualityMatrix heatmap left→right / top→bottom. */
export const SECTION_ORDER = [
  'Prep / Operations',
  'Service / Staff',
  'Fries',
  'Kebab Wrap',
  'Chicken Wrap',
  'Falafel Wrap',
  'Falafel Cup',
  'Lemonade',
]

/** Display-name overrides for section headers. Keys not listed are shown as-is. */
export const SECTION_DISPLAY: Record<string, string> = {
  'Kebab Wrap':   'Killer Kebab',
  'Chicken Wrap': 'Killer Kylling',
  'Falafel Wrap': 'Killer Falafel',
}

export function displaySection(section: string): string {
  return SECTION_DISPLAY[section] ?? section
}

/** Canonical checkpoint display order within each section. */
export const CHECKPOINT_ORDER: Record<string, string[]> = {
  'Prep / Operations': [
    'Prep correctly dated and within date / fresh',
    'Meat weighed using scale',
    'Meat holding temperature',
    'Lid used correctly',
    'Blade properly sharp / cut straight with no mushrooming',
    'Bread baked fresh to order',
  ],
  'Service / Staff': [
    'All staff in uniform',
    'Eye contact when ordering',
    'Eye contact at pickup',
    'Verbal interaction at pickup',
  ],
  'Kebab Wrap': [
    'Meat temperature',
    'Bread temperature',
    'Bread fluffiness',
    'Bread caramelisation',
    'Meat caramelisation',
    'Meat texture / juiciness',
    'Distribution',
    'Mint yoghurt sauce',
    'Parsley',
    'Onion',
    'Dukkah',
    'Harissa',
  ],
  'Chicken Wrap': [
    'Chicken temperature',
    'Bread temperature',
    'Bread fluffiness',
    'Bread caramelisation',
    'Chicken caramelisation',
    'Chicken texture / juiciness',
    'Distribution',
    'Zhugurt',
    'Parsley',
    'Killer Cucumbers',
    'Cabbage',
    'Harissa',
  ],
  'Falafel Wrap': [
    'Falafel hot and fully cooked',
    'Bread temperature',
    'Bread fluffiness',
    'Bread caramelisation',
    'Falafel consistency',
    'Falafel size',
    'Distribution',
    'Apple',
    'Mint',
    'Truffle mayo',
    'Cabbage',
    'Harissa',
  ],
  'Falafel Cup': [
    'Falafel hot and fully cooked',
    'Falafel consistency',
    'Falafel size',
    'Quantity — 3 falafels',
    'Truffle dip',
    'Dip amount',
  ],
  'Fries': [
    'Warm',
    'Crispy',
    'Salt',
    'Dukkah present',
  ],
  'Lemonade': [
    'Available',
    'Taste',
  ],
}

/** Sort checkpoints within a section by the canonical CHECKPOINT_ORDER. */
export function sortCheckpoints<T extends { checkpoint: string }>(section: string, cps: T[]): T[] {
  const order = CHECKPOINT_ORDER[section]
  if (!order) return cps
  const posMap = new Map(order.map((name, i) => [name, i]))
  return [...cps].sort((a, b) => {
    const ai = posMap.get(a.checkpoint) ?? order.length
    const bi = posMap.get(b.checkpoint) ?? order.length
    return ai - bi
  })
}

/** Group and order checkpoints by section, using SECTION_ORDER then Config-tab order for unknowns. */
export function groupBySection<T extends { section: string; checkpoint: string }>(
  items: T[],
): Array<{ section: string; checkpoints: T[] }> {
  const sectionMap = new Map<string, T[]>()
  for (const item of items) {
    const arr = sectionMap.get(item.section) ?? []
    arr.push(item)
    sectionMap.set(item.section, arr)
  }
  const result: Array<{ section: string; checkpoints: T[] }> = []
  for (const s of SECTION_ORDER) {
    if (sectionMap.has(s)) {
      result.push({ section: s, checkpoints: sortCheckpoints(s, sectionMap.get(s)!) })
    }
  }
  for (const [s, cps] of sectionMap) {
    if (!SECTION_ORDER.includes(s)) {
      result.push({ section: s, checkpoints: sortCheckpoints(s, cps) })
    }
  }
  return result
}

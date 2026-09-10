/**
 * scripts/postinstall.js
 *
 * Adds CJS "require" conditions to @react-pdf/hyphenate's package.json exports.
 *
 * Why: @react-pdf/hyphenate@0.1.0 ships only "import" (ESM) conditions.
 * Node.js v20+ CJS loader (used by tsx scripts outside the Next.js bundler)
 * refuses to load subpaths like ./en-us when no "require" condition exists.
 * The Next.js webpack bundler handles this correctly without the patch.
 *
 * This postinstall runs after every npm install so the fix survives reinstalls
 * and CI environments without relying on a committed node_modules edit.
 */

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = join(__dirname, '..', 'node_modules', '@react-pdf', 'hyphenate', 'package.json')

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch {
  // Package not installed yet (e.g. --ignore-scripts or partial install) — skip silently.
  process.exit(0)
}

let changed = false
for (const [key, val] of Object.entries(pkg.exports ?? {})) {
  if (typeof val === 'object' && val.import && !val.require) {
    val.require = val.import
    changed = true
  }
}

if (changed) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log('postinstall: patched @react-pdf/hyphenate exports (added require conditions)')
} else {
  console.log('postinstall: @react-pdf/hyphenate already has require conditions — no patch needed')
}

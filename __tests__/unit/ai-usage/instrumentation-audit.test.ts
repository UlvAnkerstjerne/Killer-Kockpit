import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Guard: every real Anthropic request in the repository must go through trackAiCall().
// If someone adds a new client.messages.* call without it, this fails.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}

const ROOT = process.cwd()
const files = ['lib', 'app', 'components', 'scripts'].flatMap(d => { try { return walk(join(ROOT, d)) } catch { return [] } })
const CALL = /\.messages\.(create|parse|stream|countTokens)\(/g

describe('Anthropic call-site instrumentation', () => {
  const sites = files.flatMap(f => {
    const src = readFileSync(f, 'utf8')
    return [...src.matchAll(CALL)].map(m => ({
      file: f.replace(ROOT + '/', ''),
      // The call is the body of trackAiCall({ ... }, () => client.messages.x(...)).
      wrapped: src.slice(Math.max(0, m.index! - 200), m.index!).includes('trackAiCall('),
    }))
  })

  it('finds the known call sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(11)
  })

  it.each(sites.map(s => [s.file, s.wrapped] as const))('%s is wrapped in trackAiCall', (_file, wrapped) => {
    expect(wrapped).toBe(true)
  })

  it('no code talks to api.anthropic.com directly (bypassing the SDK wrapper)', () => {
    const offenders = files.filter(f => !f.includes('__tests__') && /api\.anthropic\.com/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

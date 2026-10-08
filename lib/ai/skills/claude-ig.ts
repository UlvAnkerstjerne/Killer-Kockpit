import 'server-only'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Loads the vendored, pinned claude-ig Instagram skill files (MIT, see LICENSE in the folder).
 * Same pattern as lib/ai/skills/mesper.ts.
 *
 * The files are third-party instructions that become part of a system prompt, so they
 * fail closed: every file must match the sha256 recorded in UPSTREAM.json, otherwise
 * nothing is sent to the model. Updating the skill is an explicit, reviewable change.
 */

export const CLAUDE_IG_SKILL_DIR = path.join('lib', 'ai', 'skills', 'claude-ig')

interface Manifest {
  name: string
  version: string
  upstream: { repo: string; commit: string }
  files: { path: string; sha256: string }[]
}

export interface LoadedClaudeIgSkill {
  name: string
  version: string
  /** e.g. claude-ig@2.0.0#5e9b2d9 */
  ref: string
  /** sha256 over the manifest-ordered file hashes. Changes whenever any vendored file changes. */
  hash: string
  /** SKILL.md frontmatter stripped; files concatenated in manifest order with a path header. */
  text: string
}

export function loadClaudeIgSkill(dir = path.join(process.cwd(), CLAUDE_IG_SKILL_DIR)): LoadedClaudeIgSkill {
  let manifest: Manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'UPSTREAM.json'), 'utf8')) as Manifest
  } catch {
    throw new Error('claude-ig skill manifest is missing or unreadable.')
  }
  if (!manifest.files?.length || !/^[a-f0-9]{40}$/.test(manifest.upstream?.commit ?? '')) {
    throw new Error('claude-ig skill manifest is not pinned to an upstream commit.')
  }

  const parts: string[] = []
  const hashes: string[] = []
  for (const file of manifest.files) {
    let content: string
    try {
      content = readFileSync(path.join(dir, file.path), 'utf8')
    } catch {
      throw new Error(`claude-ig skill file is missing: ${file.path}`)
    }
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (sha256 !== file.sha256) {
      throw new Error(`claude-ig skill file does not match its pinned hash: ${file.path}`)
    }
    hashes.push(sha256)
    const body = file.path.endsWith('SKILL.md') ? content.replace(/^---\n[\s\S]*?\n---\n/, '') : content
    parts.push(`### ${file.path}\n\n${body}`)
  }

  return {
    name: manifest.name,
    version: manifest.version,
    ref: `${manifest.name}@${manifest.version}#${manifest.upstream.commit.slice(0, 7)}`,
    hash: createHash('sha256').update(hashes.join('\n')).digest('hex'),
    text: parts.join('\n\n'),
  }
}

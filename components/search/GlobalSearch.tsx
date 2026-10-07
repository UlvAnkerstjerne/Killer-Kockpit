'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { globalSearch, type SearchResult, type GlobalSearchResults } from '@/lib/actions/search'
import { settleAction } from '@/lib/client/stale-version'

// ─── Constants ────────────────────────────────────────────────────────────────

const GROUPS: { key: keyof GlobalSearchResults; label: string }[] = [
  { key: 'tasks',      label: 'Tasks' },
  { key: 'projects',   label: 'Projects' },
  { key: 'meetings',   label: 'Meetings' },
  { key: 'decisions',  label: 'Decisions' },
  { key: 'waitingOns', label: 'Waiting On' },
  { key: 'people',     label: 'People' },
]

const KIND_COLOR: Record<string, string> = {
  task:       'text-blue-600',
  project:    'text-violet-600',
  meeting:    'text-amber-600',
  decision:   'text-green-700',
  waiting_on: 'text-orange-600',
  person:     'text-pink-600',
}

// ─── Trigger button ───────────────────────────────────────────────────────────
// Renders a compact nav-style button. Place wherever a search entry point is needed.

export function GlobalSearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-2 w-full px-2.5 py-2 rounded-lg text-sm text-kk-ink/50 hover:bg-kk-soft hover:text-kk-ink/70 transition-colors"
      aria-label="Search (⌘K)"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
        <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
      <span className="flex-1 text-left text-xs">Search…</span>
      <kbd className="text-[10px] bg-kk-line/60 rounded px-1 py-0.5 font-mono leading-none">⌘K</kbd>
    </button>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────
// Mounts once at the AppShell level. Owns all search state + the ⌘K hotkey.

export function GlobalSearchModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GlobalSearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<'stale' | 'failed' | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)

  const flatResults: SearchResult[] = results
    ? GROUPS.flatMap(g => results[g.key])
    : []

  // ── Reset on close ─────────────────────────────────────────────────────────

  const close = useCallback(() => {
    onClose()
    setQuery('')
    setResults(null)
    setFailure(null)
    setActiveIndex(0)
  }, [onClose])

  // ── Focus input when opened ────────────────────────────────────────────────

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // ── Escape closes ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // ── Debounced search ───────────────────────────────────────────────────────

  // `cancelled` guards against out-of-order responses: only the latest request may
  // update state. Every path out of a request clears `loading` — a thrown action
  // (stale build, network, server error) must never leave the spinner running.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setLoading(false)
      setActiveIndex(0)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(async () => {
      const outcome = await settleAction(() => globalSearch(q))
      if (cancelled) return
      if (outcome.kind === 'ok') {
        setResults(outcome.data)
        setActiveIndex(0)
      } else {
        setResults(null)
        setFailure(outcome.kind)
      }
      setLoading(false)
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, retryNonce])

  // ── Keyboard navigation ────────────────────────────────────────────────────

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, flatResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = flatResults[activeIndex]
      if (hit) { close(); router.push(hit.href) }
    }
  }

  function navigate(href: string) {
    close()
    router.push(href)
  }

  if (!open) return null

  const hasResults = flatResults.length > 0
  const showEmpty = results && !hasResults && query.trim() && !failure
  let runningIndex = 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
      onClick={(e) => { if (e.target === e.currentTarget) close() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/25" onClick={close} />

      {/* Panel */}
      <div className="relative bg-white border border-kk-line rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

        {/* Input row */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-kk-line">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-kk-muted shrink-0">
            <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setFailure(null); setQuery(e.target.value) }}
            onKeyDown={onInputKeyDown}
            placeholder="Search tasks, projects, meetings, decisions…"
            className="flex-1 text-sm text-kk-ink placeholder-kk-muted bg-transparent outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <svg className="animate-spin text-kk-muted shrink-0" width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10"/>
            </svg>
          )}
          <kbd
            onClick={close}
            className="text-[10px] text-kk-muted bg-kk-soft border border-kk-line rounded px-1.5 py-0.5 cursor-pointer hover:bg-kk-line transition-colors font-mono leading-none"
          >
            esc
          </kbd>
        </div>

        {/* Results */}
        {hasResults && (
          <div className="max-h-[55vh] overflow-y-auto py-2">
            {GROUPS.map(({ key, label }) => {
              const group = results![key]
              if (group.length === 0) return null
              return (
                <div key={key}>
                  <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-[0.1em] uppercase text-kk-muted">
                    {label}
                  </div>
                  {group.map(result => {
                    const idx = runningIndex++
                    const isActive = idx === activeIndex
                    return (
                      <button
                        key={result.id}
                        onClick={() => navigate(result.href)}
                        onMouseEnter={() => setActiveIndex(idx)}
                        className={[
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                          isActive ? 'bg-kk-soft' : 'hover:bg-kk-soft',
                        ].join(' ')}
                      >
                        <span className={`text-[10px] font-semibold uppercase tracking-wide shrink-0 w-16 truncate ${KIND_COLOR[result.kind]}`}>
                          {label}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-kk-ink truncate">{result.title}</span>
                        </span>
                        {result.subtitle && (
                          <span className="text-[11px] text-kk-muted shrink-0 capitalize">
                            {result.subtitle}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}

        {failure && !loading && (
          <div role="alert" className="px-4 py-6 text-center">
            <p className="text-sm font-medium text-kk-ink">
              {failure === 'stale' ? 'Kockpit has been updated' : 'Search failed'}
            </p>
            <p className="mt-1 text-xs text-kk-muted">
              {failure === 'stale'
                ? 'This tab is running an older version, so search cannot reach the server. Refresh to continue.'
                : 'Something went wrong while searching. Check your connection and try again.'}
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {failure === 'stale' ? (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-lg bg-[#171717] px-3 py-1.5 text-xs font-semibold text-kraft-light"
                >
                  Refresh page
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setFailure(null); setRetryNonce(n => n + 1) }}
                  className="rounded-lg bg-[#171717] px-3 py-1.5 text-xs font-semibold text-kraft-light"
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        )}

        {showEmpty && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-kk-muted">No results for <span className="font-medium text-kk-ink">&ldquo;{query}&rdquo;</span></p>
          </div>
        )}

        {/* Footer hint */}
        <div className="px-4 py-2.5 border-t border-kk-line flex items-center gap-4 text-[10px] text-kk-muted">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

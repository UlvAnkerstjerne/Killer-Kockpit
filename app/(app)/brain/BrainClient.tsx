'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { askBrain } from '@/lib/actions/brain'
import type { BrainAnswer, BrainSource, BrainProfileSource, BrainOperationalSource, BrainEmailSource } from '@/lib/actions/brain'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(occurred_on: string | null, created_at: string): string {
  const raw = occurred_on ?? created_at.slice(0, 10)
  return new Date(raw).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ─── Entity type pill ─────────────────────────────────────────────────────────

function EntityPill({ type }: { type: string }) {
  const styles: Record<string, string> = {
    location: 'bg-blue-50 text-blue-600',
    employee: 'bg-emerald-50 text-emerald-700',
    project:  'bg-violet-50 text-violet-700',
  }
  const labels: Record<string, string> = {
    location: 'Location',
    employee: 'Person',
    project:  'Project',
  }
  const cls = styles[type] ?? 'bg-kk-soft text-kk-ink'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${cls}`}>
      {labels[type] ?? type}
    </span>
  )
}

// ─── Profile source card ──────────────────────────────────────────────────────

function ProfileSourceCard({ source }: { source: BrainProfileSource }) {
  return (
    <div className="border border-kk-line rounded-xl p-4 bg-white">
      <div className="flex items-center gap-2 mb-3">
        <EntityPill type={source.entity_type} />
        <Link href={source.href} className="text-sm font-semibold text-kk-ink hover:underline">
          {source.display_name}
        </Link>
        <span className="text-[10px] text-kk-muted ml-auto shrink-0">Kockpit Record</span>
      </div>
      {source.fields.length > 0 && (
        <dl className="space-y-1">
          {source.fields.map(f => (
            <div key={f.label} className="flex gap-2 text-xs">
              <dt className="text-kk-muted w-24 shrink-0">{f.label}</dt>
              <dd className="text-kk-ink font-medium">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

// ─── Operational source card ──────────────────────────────────────────────────

const OP_KIND_STYLE: Record<string, string> = {
  task:       'bg-blue-50 text-blue-600',
  project:    'bg-violet-50 text-violet-700',
  waiting_on: 'bg-amber-50 text-amber-700',
  decision:   'bg-emerald-50 text-emerald-700',
  meeting:    'bg-indigo-50 text-indigo-700',
}
const OP_KIND_LABEL: Record<string, string> = {
  task:       'Task',
  project:    'Project',
  waiting_on: 'Waiting On',
  decision:   'Decision',
  meeting:    'Meeting',
}

function OperationalSourceCard({ source }: { source: BrainOperationalSource }) {
  const cls   = OP_KIND_STYLE[source.kind] ?? 'bg-kk-soft text-kk-ink'
  const label = OP_KIND_LABEL[source.kind] ?? source.kind
  return (
    <div className="border border-kk-line rounded-xl p-4 bg-white">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${cls}`}>
          {label}
        </span>
        <Link href={source.href} className="text-sm font-semibold text-kk-ink hover:underline truncate">
          {source.title}
        </Link>
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted">
        <span>{source.personName}</span>
        {source.meta && <><span>·</span><span>{source.meta}</span></>}
      </div>
    </div>
  )
}

// ─── Email source card ────────────────────────────────────────────────────────

function fmtEmailDate(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function extractSenderName(from: string): string {
  // "Name <email>" → "Name"; "email@domain" → "email@domain"
  const match = from.match(/^([^<]+)</)
  return match ? match[1].trim() : from
}

function EmailSourceCard({ source }: { source: BrainEmailSource }) {
  return (
    <a
      href={source.href}
      target="_blank"
      rel="noopener noreferrer"
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-cyan-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-cyan-50 text-cyan-700">
          Email
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.subject}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted mb-2">
        <span>{extractSenderName(source.from)}</span>
        <span>·</span>
        <span>{fmtEmailDate(source.dateIso)}</span>
      </div>
      {source.excerpt && (
        <p className="text-xs text-kk-ink/70 leading-relaxed line-clamp-2">{source.excerpt}</p>
      )}
    </a>
  )
}

// ─── Update source card ───────────────────────────────────────────────────────

function SourceCard({ source }: { source: BrainSource }) {
  const date = fmtDate(source.occurred_on, source.created_at)
  return (
    <div className="border border-kk-line rounded-xl p-4 bg-white">
      <div className="flex items-center gap-2 mb-2.5 flex-wrap text-xs text-kk-muted">
        <span>{date}</span>
        {source.authorName && <><span>·</span><span>{source.authorName}</span></>}
        {source.entities.length > 0 && (
          <>
            <span>·</span>
            <div className="flex items-center gap-2 flex-wrap">
              {source.entities.map(e => (
                <Link
                  key={`${e.entity_type}-${e.entity_id}`}
                  href={e.href}
                  className="flex items-center gap-1 hover:underline"
                >
                  <EntityPill type={e.entity_type} />
                  <span className="text-kk-ink font-medium">{e.display_name}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
      <p className="text-sm text-kk-ink leading-relaxed">{source.body}</p>
    </div>
  )
}

// ─── Answer renderer ──────────────────────────────────────────────────────────

function AnswerText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1" />
        const isBullet = /^[•\-\*]\s/.test(line.trim())
        if (isBullet) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-kk-muted shrink-0 mt-0.5">•</span>
              <span className="text-sm text-kk-ink leading-relaxed">
                {line.trim().replace(/^[•\-\*]\s*/, '')}
              </span>
            </div>
          )
        }
        return (
          <p key={i} className="text-sm text-kk-ink leading-relaxed">
            {line}
          </p>
        )
      })}
    </div>
  )
}

// ─── Suggested questions ──────────────────────────────────────────────────────

const SUGGESTIONS = [
  'What are the current issues at any location?',
  'What do we know about recent hirings?',
  'What projects are active right now?',
  'What changed recently?',
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function BrainClient() {
  const [question, setQuestion]               = useState('')
  const [isLoading, setIsLoading]             = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [result, setResult]                   = useState<BrainAnswer | null>(null)
  const [answeredQuestion, setAnsweredQuestion] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  async function submit(q: string) {
    const trimmed = q.trim()
    if (!trimmed || isLoading) return

    setIsLoading(true)
    setError(null)
    setResult(null)
    setAnsweredQuestion(null)
    setQuestion(trimmed)

    const res = await askBrain(trimmed)
    setIsLoading(false)

    if ('error' in res) {
      setError(res.error ?? 'Something went wrong.')
    } else {
      setResult(res.data!)
      setAnsweredQuestion(trimmed)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(question)
    }
  }

  function handleSuggestion(s: string) {
    setQuestion(s)
    submit(s)
  }

  const isEmpty = !result && !isLoading && !error

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-kk-ink tracking-tight">Kockpit Brain</h1>
        <p className="text-sm text-kk-muted mt-1">
          Ask anything. Answers come only from what Kockpit actually knows.
        </p>
      </div>

      {/* Input */}
      <div>
        <textarea
          ref={textareaRef}
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What's going on with Frederiksberg? What do we know about Peter?"
          rows={3}
          disabled={isLoading}
          className="w-full border border-kk-line rounded-xl px-4 py-3 text-sm text-kk-ink placeholder:text-kk-muted/70 resize-none focus:outline-none focus:ring-2 focus:ring-kk-ink/15 focus:border-kk-ink/40 bg-white"
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-kk-muted">Enter to ask · Shift+Enter for new line</p>
          <button
            onClick={() => submit(question)}
            disabled={!question.trim() || isLoading}
            className="px-4 py-2 bg-kk-ink text-white text-sm rounded-lg font-medium hover:bg-kk-ink/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? 'Thinking…' : 'Ask'}
          </button>
        </div>
      </div>

      {/* Suggestions (shown when idle) */}
      {isEmpty && (
        <div className="mt-6">
          <p className="text-xs text-kk-muted mb-2 font-medium uppercase tracking-wide">Try asking</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map(s => (
              <button
                key={s}
                onClick={() => handleSuggestion(s)}
                className="text-xs px-3 py-1.5 rounded-full border border-kk-line bg-white text-kk-ink/70 hover:text-kk-ink hover:border-kk-ink/30 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="mt-8 flex items-center gap-2.5 text-sm text-kk-muted">
          <span className="w-4 h-4 border-2 border-kk-ink/20 border-t-kk-ink rounded-full animate-spin shrink-0" />
          Searching Kockpit memory…
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Answer + sources */}
      {result && (
        <div className="mt-8">
          {answeredQuestion && (
            <p className="text-xs text-kk-muted mb-3">
              Answering: <em className="not-italic text-kk-ink/60">{answeredQuestion}</em>
            </p>
          )}

          {/* Answer */}
          <div className="mb-6">
            <AnswerText text={result.answer} />
          </div>

          {/* Sources */}
          {(result.profileSources.length > 0 || result.operationalSources.length > 0 || result.sources.length > 0 || result.emailSources.length > 0) && (
            <div>
              <h2 className="text-[10px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-3">
                Sources ({result.profileSources.length + result.operationalSources.length + result.sources.length + result.emailSources.length})
              </h2>
              <div className="space-y-2">
                {result.profileSources.map(s => (
                  <ProfileSourceCard key={`${s.entity_type}-${s.entity_id}`} source={s} />
                ))}
                {result.operationalSources.map(s => (
                  <OperationalSourceCard key={`${s.kind}-${s.id}`} source={s} />
                ))}
                {result.sources.map(s => (
                  <SourceCard key={s.updateId} source={s} />
                ))}
                {result.emailSources.map(s => (
                  <EmailSourceCard key={s.threadId} source={s} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

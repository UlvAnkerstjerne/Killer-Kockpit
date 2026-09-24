'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { askBrain } from '@/lib/actions/brain'
import type { BrainAnswer, BrainSource, BrainProfileSource, BrainOperationalSource, BrainEmailSource, BrainAuditSource, BrainDinerSource, BrainSSPSource, BrainMeetingSource, BrainDecisionSource, BrainReviewSource, BrainBriefSource, BrainFileSource, BrainTodoSource } from '@/lib/actions/brain'

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

// ─── Audit status colour ──────────────────────────────────────────────────────

function auditStatusStyle(status: string | null): { bg: string; text: string; label: string } {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    GREEN:       { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Green' },
    LIGHT_GREEN: { bg: 'bg-green-50',   text: 'text-green-700',   label: 'Light Green' },
    YELLOW:      { bg: 'bg-yellow-50',  text: 'text-yellow-700',  label: 'Yellow' },
    ORANGE:      { bg: 'bg-orange-50',  text: 'text-orange-700',  label: 'Orange' },
    RED:         { bg: 'bg-red-50',     text: 'text-red-700',     label: 'Red' },
  }
  return map[status ?? ''] ?? { bg: 'bg-kk-soft', text: 'text-kk-ink', label: status ?? '—' }
}

// ─── Audit source card ────────────────────────────────────────────────────────

function AuditSourceCard({ source }: { source: BrainAuditSource }) {
  const { bg, text, label } = auditStatusStyle(source.auditStatus)
  return (
    <a
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-orange-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-orange-50 text-orange-700">
          Audit
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.locationName}</span>
        {source.auditStatus && (
          <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${bg} ${text}`}>
            {label}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted mb-2">
        <span>{fmtEmailDate(source.submittedAt)}</span>
        {source.scorePct !== null && <><span>·</span><span>{source.scorePct}% overall</span></>}
        {source.failedCount > 0 && <><span>·</span><span>{source.failedCount} failed</span></>}
        {source.redFlagCount !== null && source.redFlagCount > 0 && (
          <><span>·</span><span className="text-red-600 font-medium">{source.redFlagCount} red flag{source.redFlagCount !== 1 ? 's' : ''}</span></>
        )}
      </div>
      {source.topFailures.length > 0 && (
        <ul className="space-y-0.5">
          {source.topFailures.map((f, i) => (
            <li key={i} className="text-xs text-kk-ink/70 leading-snug flex gap-1.5">
              {f.isRedFlag && <span className="text-red-500 shrink-0">●</span>}
              {!f.isRedFlag && <span className="text-kk-muted shrink-0">·</span>}
              <span>{f.section}: {f.title}</span>
            </li>
          ))}
        </ul>
      )}
    </a>
  )
}

// ─── Diner source card ────────────────────────────────────────────────────────

function DinerSourceCard({ source }: { source: BrainDinerSource }) {
  return (
    <a
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-purple-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-purple-50 text-purple-700">
          Mystery Diner
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.locationName}</span>
        {source.finalStatus && (
          <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-kk-soft text-kk-ink">
            {source.finalStatus}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted mb-2">
        <span>{fmtEmailDate(source.submittedAt)}</span>
        {source.scorePct !== null && <><span>·</span><span>{source.scorePct}% score</span></>}
        {source.criticalFailCount !== null && source.criticalFailCount > 0 && (
          <><span>·</span><span className="text-red-600 font-medium">{source.criticalFailCount} critical</span></>
        )}
        {source.goldStarCount !== null && source.goldStarCount > 0 && (
          <><span>·</span><span className="text-amber-600 font-medium">★ {source.goldStarCount}</span></>
        )}
      </div>
      {source.topFailures.length > 0 && (
        <ul className="space-y-0.5">
          {source.topFailures.map((f, i) => (
            <li key={i} className="text-xs text-kk-ink/70 leading-snug flex gap-1.5">
              <span className="text-red-500 shrink-0">●</span>
              <span>{f.section}: {f.label}</span>
            </li>
          ))}
        </ul>
      )}
    </a>
  )
}

// ─── SSP source card ──────────────────────────────────────────────────────────

function SSPSourceCard({ source }: { source: BrainSSPSource }) {
  return (
    <a
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-sky-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-sky-50 text-sky-700">
          SSP / Airport KQC
        </span>
        <span className="text-sm font-semibold text-kk-ink">{source.checkDate}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted mb-2">
        <span>{source.overallScore}% overall</span>
        <span>·</span>
        <span>{source.criticalScore}% critical</span>
        {source.criticalFailures > 0 && (
          <><span>·</span><span className="text-red-600 font-medium">{source.criticalFailures} critical failure{source.criticalFailures !== 1 ? 's' : ''}</span></>
        )}
      </div>
      {source.topFailures.length > 0 && (
        <ul className="space-y-0.5">
          {source.topFailures.map((f, i) => (
            <li key={i} className="text-xs text-kk-ink/70 leading-snug flex gap-1.5">
              <span className="text-red-500 shrink-0">●</span>
              <span>{f.section}: {f.checkpoint}</span>
            </li>
          ))}
        </ul>
      )}
    </a>
  )
}

// ─── Meeting source card ──────────────────────────────────────────────────────

function MeetingSourceCard({ source }: { source: BrainMeetingSource }) {
  return (
    <Link
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-indigo-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-indigo-50 text-indigo-700">
          Meeting
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.title}</span>
        {source.hasMinutes && (
          <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-emerald-50 text-emerald-700">
            Minutes
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted">
        {source.scheduledStart && <span>{fmtEmailDate(source.scheduledStart)}</span>}
        {source.decisionCount > 0 && (
          <><span>·</span><span>{source.decisionCount} decision{source.decisionCount !== 1 ? 's' : ''}</span></>
        )}
        {source.taskCount > 0 && (
          <><span>·</span><span>{source.taskCount} task{source.taskCount !== 1 ? 's' : ''}</span></>
        )}
        {source.hasTranscript && !source.hasMinutes && (
          <><span>·</span><span className="text-kk-muted/70">transcript</span></>
        )}
      </div>
    </Link>
  )
}

// ─── Decision source card ─────────────────────────────────────────────────────

function DecisionSourceCard({ source }: { source: BrainDecisionSource }) {
  return (
    <Link
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-emerald-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-emerald-50 text-emerald-700">
          Decision
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.title}</span>
        <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-kk-soft text-kk-muted capitalize">
          {source.status}
        </span>
      </div>
      {source.decidedAt && (
        <div className="text-xs text-kk-muted mb-1.5">{fmtEmailDate(source.decidedAt)}</div>
      )}
      {source.decisionText && (
        <p className="text-xs text-kk-ink/80 leading-relaxed line-clamp-2">{source.decisionText}</p>
      )}
      {source.rationale && !source.decisionText && (
        <p className="text-xs text-kk-muted leading-relaxed line-clamp-2">{source.rationale}</p>
      )}
    </Link>
  )
}

// ─── Review source card ───────────────────────────────────────────────────────

function starBar(avg: number | null): string {
  if (avg === null) return ''
  const full = Math.round(avg)
  return '★'.repeat(full) + '☆'.repeat(5 - full)
}

function ReviewSourceCard({ source }: { source: BrainReviewSource }) {
  return (
    <a
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-amber-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-amber-50 text-amber-700">
          GBP Reviews
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">
          {source.locationShortName ?? source.locationName}
        </span>
        {source.avgStarRating !== null && (
          <span className="ml-auto shrink-0 text-amber-500 text-xs font-medium">
            {starBar(source.avgStarRating)} {source.avgStarRating}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted">
        <span>{source.reviewCount} review{source.reviewCount !== 1 ? 's' : ''}</span>
        {source.pendingReplyCount > 0 && (
          <><span>·</span><span className="text-amber-600 font-medium">{source.pendingReplyCount} pending reply</span></>
        )}
      </div>
    </a>
  )
}

// ─── Morning Brief source card ────────────────────────────────────────────────

function briefStatusStyle(status: string | null): { bg: string; text: string } {
  const map: Record<string, { bg: string; text: string }> = {
    green: { bg: 'bg-emerald-50', text: 'text-emerald-700' },
    amber: { bg: 'bg-amber-50',   text: 'text-amber-700'   },
    red:   { bg: 'bg-red-50',     text: 'text-red-700'     },
  }
  return map[status ?? ''] ?? { bg: 'bg-kk-soft', text: 'text-kk-muted' }
}

function MorningBriefSourceCard({ source }: { source: BrainBriefSource }) {
  const { bg, text } = briefStatusStyle(source.overallStatus)
  return (
    <a
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-sky-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-sky-50 text-sky-700">
          Morning Brief
        </span>
        <span className="text-sm font-semibold text-kk-ink">{source.briefDate}</span>
        {source.overallStatus && (
          <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${bg} ${text}`}>
            {source.overallStatus}
          </span>
        )}
      </div>
      {source.overallReason && (
        <p className="text-xs text-kk-muted mb-1.5 leading-snug">{source.overallReason}</p>
      )}
      {source.aiSummary && (
        <p className="text-xs text-kk-ink/80 leading-relaxed line-clamp-2">{source.aiSummary}</p>
      )}
    </a>
  )
}

// ─── File source card ─────────────────────────────────────────────────────────

function mimeTypeLabel(mimeType: string): string {
  if (mimeType.includes('document'))    return 'Doc'
  if (mimeType.includes('spreadsheet')) return 'Sheet'
  if (mimeType.includes('presentation')) return 'Slides'
  if (mimeType.includes('pdf'))         return 'PDF'
  if (mimeType.includes('folder'))      return 'Folder'
  return 'File'
}

function FileSourceCard({ source }: { source: BrainFileSource }) {
  return (
    <a
      href={source.webViewLink}
      target="_blank"
      rel="noopener noreferrer"
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-violet-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-violet-50 text-violet-700">
          {mimeTypeLabel(source.mimeType)}
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.fileName}</span>
      </div>
      <div className="text-xs text-kk-muted">
        Linked to: <span className="text-kk-ink font-medium">{source.entityName}</span>
      </div>
    </a>
  )
}

// ─── To-Do source card ────────────────────────────────────────────────────────

function TodoSourceCard({ source }: { source: BrainTodoSource }) {
  const statusLabel = source.isCompleted ? 'Completed' : 'Open'
  const statusCls   = source.isCompleted
    ? 'bg-emerald-50 text-emerald-700'
    : 'bg-amber-50 text-amber-700'
  return (
    <Link
      href={source.href}
      className="block border border-kk-line rounded-xl p-4 bg-white hover:border-emerald-300 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${statusCls}`}>
          To-Do · {statusLabel}
        </span>
        <span className="text-sm font-semibold text-kk-ink truncate">{source.title}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-kk-muted mb-1.5">
        {source.ownerName && <span>{source.ownerName}</span>}
        {source.ownerName && source.completedAt && <span>·</span>}
        {source.completedAt && <span>{source.completedAt}</span>}
      </div>
      {source.completionContextExcerpt && (
        <p className="text-xs text-kk-ink leading-relaxed line-clamp-2">
          <span className="font-medium text-kk-muted">Outcome: </span>
          {source.completionContextExcerpt}
        </p>
      )}
    </Link>
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

// ─── Record deep-links ────────────────────────────────────────────────────────
// Compact clickable chips shown immediately below the answer for quick navigation
// to the underlying Kockpit records. Uses existing source metadata — no new data fetching.

type RecordLink = {
  kind: 'meeting' | 'task' | 'project' | 'decision' | 'waiting_on'
  id: string
  title: string
  date: string | null
  href: string
}

const RECORD_LINK_COLOR: Record<RecordLink['kind'], string> = {
  meeting:    'text-indigo-600',
  task:       'text-blue-600',
  project:    'text-violet-600',
  decision:   'text-emerald-700',
  waiting_on: 'text-amber-700',
}
const RECORD_LINK_LABEL: Record<RecordLink['kind'], string> = {
  meeting:    'Meeting',
  task:       'Task',
  project:    'Project',
  decision:   'Decision',
  waiting_on: 'Waiting On',
}

function fmtChipDate(iso: string | null): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function buildRecordLinks(result: BrainAnswer): RecordLink[] {
  const seen = new Set<string>()
  const links: RecordLink[] = []

  function add(link: RecordLink) {
    const key = `${link.kind}-${link.id}`
    if (seen.has(key)) return
    seen.add(key)
    links.push(link)
  }

  // Meetings from meeting context (have rich date info)
  for (const s of result.meetingSources) {
    add({ kind: 'meeting', id: s.id, title: s.title, date: s.scheduledStart, href: s.href })
  }
  // Decisions from meeting/standalone context
  for (const s of result.decisionSources) {
    add({ kind: 'decision', id: s.id, title: s.title, date: s.decidedAt, href: s.href })
  }
  // Operational items: tasks, projects, waiting ons (and meetings/decisions not already added)
  for (const s of result.operationalSources) {
    if (s.kind === 'task' || s.kind === 'project' || s.kind === 'waiting_on' || s.kind === 'meeting' || s.kind === 'decision') {
      add({ kind: s.kind, id: s.id, title: s.title, date: null, href: s.href })
    }
  }

  return links.slice(0, 10)
}

function RecordLinks({ result }: { result: BrainAnswer }) {
  const links = buildRecordLinks(result)
  if (links.length === 0) return null

  return (
    <div className="mt-4 flex flex-wrap gap-1.5">
      {links.map(link => {
        const color = RECORD_LINK_COLOR[link.kind]
        const label = RECORD_LINK_LABEL[link.kind]
        const date = fmtChipDate(link.date)
        return (
          <Link
            key={`${link.kind}-${link.id}`}
            href={link.href}
            className="inline-flex items-center gap-1 text-[11px] rounded-full border border-kk-line bg-white px-2.5 py-0.5 hover:bg-kk-soft transition-colors"
          >
            <span className={`font-semibold shrink-0 ${color}`}>{label}</span>
            <span className="text-kk-muted">·</span>
            <span className="text-kk-ink truncate max-w-[180px]">{link.title}</span>
            {date && <span className="text-kk-muted shrink-0">— {date}</span>}
          </Link>
        )
      })}
    </div>
  )
}

// ─── Answer renderer ──────────────────────────────────────────────────────────

/** Parses markdown-style links [text](url) into React elements. */
function renderInlineLinks(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(
      <a
        key={match.index}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline hover:text-blue-800 transition-colors"
      >
        {match[1]}
      </a>,
    )
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

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
                {renderInlineLinks(line.trim().replace(/^[•\-\*]\s*/, ''))}
              </span>
            </div>
          )
        }
        return (
          <p key={i} className="text-sm text-kk-ink leading-relaxed">
            {renderInlineLinks(line)}
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
            <RecordLinks result={result} />
          </div>

          {/* Sources */}
          {(result.profileSources.length > 0 || result.operationalSources.length > 0 || result.sources.length > 0 || result.emailSources.length > 0 || result.auditSources.length > 0 || result.dinerSources.length > 0 || result.sspSource || result.meetingSources.length > 0 || result.decisionSources.length > 0 || result.reviewSources.length > 0 || result.briefSources.length > 0 || result.fileSources.length > 0 || result.todoSources.length > 0) && (
            <div>
              <h2 className="text-[10px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-3">
                Sources ({result.profileSources.length + result.operationalSources.length + result.sources.length + result.emailSources.length + result.auditSources.length + result.dinerSources.length + (result.sspSource ? 1 : 0) + result.meetingSources.length + result.decisionSources.length + result.reviewSources.length + result.briefSources.length + result.fileSources.length + result.todoSources.length})
              </h2>
              <div className="space-y-2">
                {result.profileSources.map(s => (
                  <ProfileSourceCard key={`${s.entity_type}-${s.entity_id}`} source={s} />
                ))}
                {result.operationalSources.map(s => (
                  <OperationalSourceCard key={`${s.kind}-${s.id}`} source={s} />
                ))}
                {result.meetingSources.map(s => (
                  <MeetingSourceCard key={`meeting-${s.id}`} source={s} />
                ))}
                {result.decisionSources.map(s => (
                  <DecisionSourceCard key={`decision-${s.id}`} source={s} />
                ))}
                {result.auditSources.map(s => (
                  <AuditSourceCard key={`audit-${s.locationId}`} source={s} />
                ))}
                {result.dinerSources.map(s => (
                  <DinerSourceCard key={`diner-${s.locationId}`} source={s} />
                ))}
                {result.sspSource && (
                  <SSPSourceCard source={result.sspSource} />
                )}
                {result.reviewSources.map(s => (
                  <ReviewSourceCard key={`review-${s.locationName}`} source={s} />
                ))}
                {result.briefSources.map(s => (
                  <MorningBriefSourceCard key={`brief-${s.briefDate}`} source={s} />
                ))}
                {result.fileSources.map(s => (
                  <FileSourceCard key={`file-${s.sourceId}`} source={s} />
                ))}
                {result.todoSources.map(s => (
                  <TodoSourceCard key={`todo-${s.id}`} source={s} />
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

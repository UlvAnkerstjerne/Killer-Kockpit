'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createRecordingSession, retryTranscription } from '@/lib/actions/recordings'

// ─── IndexedDB helpers ──────────────────────────────────────────────────────
//
// Chunks are stored on every MediaRecorder dataavailable event (every 5 s).
// Cleared ONLY after both storage upload AND finalize succeed.

const IDB_NAME    = 'kk-recording'
const IDB_VERSION = 1
const IDB_STORE   = 'chunks'

interface StoredSession {
  recordingId: string
  meetingId:   string
  mimeType:    string
  startedAt:   string
  chunks:      Blob[]
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: 'recordingId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function idbSave(session: StoredSession): Promise<void> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(session)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

async function idbGetForMeeting(meetingId: string): Promise<StoredSession | null> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).getAll()
    req.onsuccess = () => {
      const all = (req.result ?? []) as StoredSession[]
      resolve(all.find((s) => s.meetingId === meetingId) ?? null)
    }
    req.onerror = () => reject(req.error)
  })
}

async function idbDelete(recordingId: string): Promise<void> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(recordingId)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

// ─── MIME type selection ────────────────────────────────────────────────────

function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ]
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase =
  | 'init'              // checking IndexedDB on mount
  | 'recovery_prompt'   // orphaned session found
  | 'pre_recording'     // consent + attendee confirmation
  | 'recording'         // active recording
  | 'uploading'         // direct-to-Storage PUT in progress
  | 'queued'            // submitted to AssemblyAI
  | 'failed'

type LanguageMode = 'detect' | 'da' | 'en'

interface Props {
  meetingId:     string
  meetingTitle:  string
  attendeeNames: string[]
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function RecordingClient({ meetingId, meetingTitle, attendeeNames }: Props) {
  const router = useRouter()

  // Phase / error
  const [phase,     setPhase]     = useState<Phase>('init')
  const [error,     setError]     = useState<string | null>(null)

  // Pre-recording state
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(attendeeNames.map((n) => [n, true]))
  )
  const [consent,   setConsent]   = useState(false)
  const [langMode,  setLangMode]  = useState<LanguageMode>('detect')

  // Recording state
  const [elapsedMs,       setElapsedMs]       = useState(0)
  const [uploadMsg,       setUploadMsg]       = useState('')
  const [showIntroHint,   setShowIntroHint]   = useState(true)
  // True after the Storage PUT succeeds — retry should call retryTranscription,
  // not re-upload, when only the transcription submission failed.
  const [audioUploaded, setAudioUploaded] = useState(false)

  // Recovery
  const [orphan, setOrphan] = useState<StoredSession | null>(null)

  // Refs — stable across renders
  const recorderRef    = useRef<MediaRecorder | null>(null)
  const streamRef      = useRef<MediaStream | null>(null)
  const chunksRef      = useRef<Blob[]>([])
  const recordingIdRef = useRef<string | null>(null)
  const mimeTypeRef    = useRef<string>('')
  const startTimeRef   = useRef<number>(0)
  const durationMsRef  = useRef<number>(0)
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const wakeLockRef    = useRef<WakeLockSentinel | null>(null)
  const langModeRef    = useRef<LanguageMode>('detect')

  // Keep langModeRef in sync
  useEffect(() => { langModeRef.current = langMode }, [langMode])

  // ── Recovery check on mount ───────────────────────────────────────────────

  useEffect(() => {
    idbGetForMeeting(meetingId)
      .then((stored) => {
        if (stored && stored.chunks.length > 0) {
          setOrphan(stored)
          setPhase('recovery_prompt')
        } else {
          setPhase('pre_recording')
        }
      })
      .catch(() => setPhase('pre_recording'))
  }, [meetingId])

  // ── Auto-dismiss intro hint after 30 s ───────────────────────────────────

  useEffect(() => {
    if (phase !== 'recording') return
    setShowIntroHint(true)
    const t = setTimeout(() => setShowIntroHint(false), 30_000)
    return () => clearTimeout(t)
  }, [phase])

  // ── Timer ─────────────────────────────────────────────────────────────────

  function startTimer() {
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current)
    }, 500)
  }

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  // ── Wake lock ─────────────────────────────────────────────────────────────

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen')
      }
    } catch { /* best-effort */ }
  }

  function releaseWakeLock() {
    try { wakeLockRef.current?.release() } catch { /* ignore */ }
    wakeLockRef.current = null
  }

  // ── Two-step direct upload ────────────────────────────────────────────────
  //
  // 1. POST /api/recordings/init  → { uploadUrl }
  // 2. PUT  uploadUrl (browser → Supabase Storage directly)
  // 3. POST /api/recordings/finalize
  // IndexedDB cleared only after step 3 succeeds.

  const doUpload = useCallback(async (
    recordingId: string,
    chunks:      Blob[],
    mimeType:    string,
    durationMs:  number,
    language:    LanguageMode,
  ) => {
    setPhase('uploading')
    setAudioUploaded(false)
    const byteSize = chunks.reduce((sum, b) => sum + b.size, 0)

    // ── Step 1: get signed upload URL ────────────────────────────────────────
    setUploadMsg('Preparing upload…')

    let uploadUrl: string
    try {
      const initRes = await fetch('/api/recordings/init', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ recordingId, mimeType, durationMs }),
      })

      if (!initRes.ok) {
        const body = await initRes.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Init failed (${initRes.status})`)
      }

      const initData = await initRes.json() as { uploadUrl?: string }
      if (!initData.uploadUrl) throw new Error('No upload URL returned.')
      uploadUrl = initData.uploadUrl
    } catch (err) {
      setError(`Upload preparation failed: ${(err as Error).message}`)
      setPhase('failed')
      return
    }

    // ── Step 2: PUT audio directly to Supabase ────────────────────────────────
    setUploadMsg('Uploading recording…')

    const audioBlob = new Blob(chunks, { type: mimeType })

    try {
      const putRes = await fetch(uploadUrl, {
        method:  'PUT',
        headers: { 'Content-Type': mimeType, 'x-upsert': 'true' },
        body:    audioBlob,
      })

      if (!putRes.ok) {
        const msg = await putRes.text().catch(() => putRes.statusText)
        throw new Error(`Storage PUT failed (${putRes.status}): ${msg}`)
      }
      setAudioUploaded(true)
    } catch (err) {
      // Storage PUT failed — keep IndexedDB intact for retry
      setError(`Upload failed: ${(err as Error).message}. Your recording is saved locally — you can retry.`)
      setPhase('failed')
      return
    }

    // ── Step 3: finalize (verify + AssemblyAI submit) ─────────────────────────
    setUploadMsg('Submitting for transcription…')

    try {
      const finalRes = await fetch('/api/recordings/finalize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ recordingId, byteSize, durationMs, languageMode: language }),
      })

      if (!finalRes.ok) {
        const body = await finalRes.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Finalize failed (${finalRes.status})`)
      }
    } catch (err) {
      // Audio is in Storage — retry transcription without re-uploading
      setError(`${(err as Error).message}`)
      setPhase('failed')
      return
    }

    // Success — only now clear local recovery data
    try { await idbDelete(recordingId) } catch { /* ignore */ }

    setPhase('queued')
  }, [])

  // ── Start recording ───────────────────────────────────────────────────────

  async function handleStart() {
    setError(null)

    const checkedNames = attendeeNames.filter((n) => confirmed[n])

    const sessionResult = await createRecordingSession(meetingId, {
      consentConfirmedAt: new Date().toISOString(),
      expectedSpeakers:   checkedNames,
    })

    if (sessionResult.error || !sessionResult.data) {
      setError(sessionResult.error ?? 'Failed to start recording session.')
      return
    }

    const { id: recordingId } = sessionResult.data
    recordingIdRef.current = recordingId

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access denied. Please grant permission and try again.')
      return
    }

    streamRef.current = stream

    const mimeType = pickMimeType()
    mimeTypeRef.current = mimeType
    chunksRef.current   = []

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    recorderRef.current = recorder

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data)
        // Persist to IndexedDB for crash recovery (fire and forget)
        idbSave({
          recordingId,
          meetingId,
          mimeType:  mimeTypeRef.current,
          startedAt: new Date(startTimeRef.current).toISOString(),
          chunks:    [...chunksRef.current],
        }).catch(() => { /* ignore */ })
      }
    }

    recorder.onstop = () => {
      stopTimer()
      releaseWakeLock()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null

      durationMsRef.current = Date.now() - startTimeRef.current
      doUpload(
        recordingIdRef.current!,
        chunksRef.current,
        mimeTypeRef.current,
        durationMsRef.current,
        langModeRef.current,
      )
    }

    recorder.start(5000) // 5-second timeslices
    setPhase('recording')
    startTimer()
    acquireWakeLock()
  }

  // ── Stop recording ────────────────────────────────────────────────────────

  function handleStop() {
    recorderRef.current?.stop()
  }

  // ── Recovery: upload orphaned session ────────────────────────────────────

  async function handleRecoverUpload() {
    if (!orphan) return
    setOrphan(null)
    await doUpload(
      orphan.recordingId,
      orphan.chunks,
      orphan.mimeType,
      0,
      langMode,
    )
  }

  async function handleRecoverDiscard() {
    if (!orphan) return
    try { await idbDelete(orphan.recordingId) } catch { /* ignore */ }
    setOrphan(null)
    setPhase('pre_recording')
  }

  // ── Retry after failed upload or transcription ────────────────────────────

  async function handleRetry() {
    setError(null)

    // If the audio upload already succeeded, only the transcription submission
    // failed — skip re-uploading and call retryTranscription directly.
    if (audioUploaded && recordingIdRef.current) {
      setPhase('uploading')
      setUploadMsg('Retrying transcription submission…')
      const result = await retryTranscription(recordingIdRef.current)
      if (result.error) {
        setError(result.error)
        setPhase('failed')
      } else {
        // Clear local recovery data and navigate away
        try { await idbDelete(recordingIdRef.current) } catch { /* ignore */ }
        setPhase('queued')
      }
      return
    }

    // Upload failed — reload chunks from IDB and retry the full upload
    const stored = await idbGetForMeeting(meetingId).catch(() => null)
    const session = stored ?? (chunksRef.current.length > 0 ? {
      recordingId: recordingIdRef.current!,
      meetingId,
      mimeType:    mimeTypeRef.current,
      startedAt:   new Date().toISOString(),
      chunks:      chunksRef.current,
    } : null)

    if (!session || session.chunks.length === 0) {
      setError('No local recording data found. Please record again.')
      return
    }

    await doUpload(session.recordingId, session.chunks, session.mimeType, durationMsRef.current, langMode)
  }

  // ── Elapsed time formatter ────────────────────────────────────────────────

  function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const checkedCount = attendeeNames.filter((n) => confirmed[n]).length
  const canStartRec  = consent && checkedCount >= 1

  // ─── Render ───────────────────────────────────────────────────────────────

  if (phase === 'init') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-8 text-center">
        <p className="text-sm text-kk-muted">Checking for previous sessions…</p>
      </div>
    )
  }

  // Recovery prompt
  if (phase === 'recovery_prompt' && orphan) {
    const savedAt = new Date(orphan.startedAt).toLocaleString('en-GB', {
      timeZone: 'Europe/Copenhagen',
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-kk-ink mb-1">Incomplete recording found</h2>
          <p className="text-sm text-kk-muted">
            A recording started on {savedAt} was not uploaded. Upload it now, or discard it to start a new recording.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleRecoverUpload}
            className="flex-1 py-3 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
          >
            Upload previous
          </button>
          <button
            onClick={handleRecoverDiscard}
            className="flex-1 py-3 border border-kk-line text-sm text-kk-muted rounded-xl hover:text-kk-ink transition-colors"
          >
            Discard
          </button>
        </div>
        {error && <p className="text-xs text-kk-bad">{error}</p>}
      </div>
    )
  }

  // Pre-recording: attendee confirmation + consent + roll-call instruction
  if (phase === 'pre_recording') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-kk-ink mb-1">Before you record</h2>
          <p className="text-sm text-kk-muted">
            Confirm who is present. Their names help identify speakers in the transcript.
          </p>
        </div>

        {/* Attendee list */}
        {attendeeNames.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">
              Attendees present
            </div>
            {attendeeNames.map((name) => (
              <label key={name} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!confirmed[name]}
                  onChange={(e) => setConfirmed((prev) => ({ ...prev, [name]: e.target.checked }))}
                  className="w-4 h-4 rounded accent-kk-ink"
                />
                <span className="text-sm text-kk-ink">{name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-kk-muted italic">No attendees listed for this meeting.</p>
        )}

        {/* Language */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-kk-muted uppercase tracking-wide">
            Meeting language
          </div>
          <div className="flex gap-2">
            {(['detect', 'da', 'en'] as LanguageMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setLangMode(mode)}
                className={[
                  'flex-1 py-2 text-sm rounded-xl border transition-colors',
                  langMode === mode
                    ? 'border-kk-ink bg-kk-ink text-white'
                    : 'border-kk-line text-kk-muted hover:text-kk-ink',
                ].join(' ')}
              >
                {mode === 'detect' ? 'Auto-detect' : mode === 'da' ? 'Danish' : 'English'}
              </button>
            ))}
          </div>
        </div>

        {/* Roll-call instruction */}
        <div className="bg-kk-soft border border-kk-line rounded-xl px-4 py-3 space-y-1.5">
          <p className="text-xs font-semibold text-kk-ink">Once recording starts, go around the table</p>
          <p className="text-sm text-kk-muted">
            Have everyone introduce themselves briefly, for example:
          </p>
          <ul className="text-sm text-kk-muted space-y-0.5 pl-3">
            <li>&ldquo;I&apos;m Ulv.&rdquo;</li>
            <li>&ldquo;I&apos;m Lydia.&rdquo;</li>
            <li>&ldquo;I&apos;m Peter from Carlsberg.&rdquo;</li>
          </ul>
          <p className="text-xs text-kk-muted">
            This helps AssemblyAI match voices to names.
          </p>
        </div>

        {/* Consent */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded accent-kk-ink"
          />
          <span className="text-sm text-kk-ink">
            All participants have been informed that this meeting will be recorded and have given their consent.
          </span>
        </label>

        {error && <p className="text-xs text-kk-bad">{error}</p>}

        <button
          onClick={handleStart}
          disabled={!canStartRec}
          className="w-full py-4 bg-red-600 text-white text-base font-semibold rounded-2xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          Start recording
        </button>
      </div>
    )
  }

  // Active recording
  if (phase === 'recording') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-10 flex flex-col items-center gap-6">
        {/* Red pulsing indicator */}
        <div className="relative flex items-center justify-center">
          <span className="absolute inline-flex h-20 w-20 rounded-full bg-red-600 opacity-30 animate-ping" />
          <span className="relative inline-flex h-16 w-16 rounded-full bg-red-600" />
        </div>

        {/* Timer */}
        <div className="text-3xl font-mono font-bold text-kk-ink tabular-nums">
          {formatElapsed(elapsedMs)}
        </div>

        <p className="text-sm text-kk-muted text-center">
          Recording <span className="font-medium text-kk-ink">{meetingTitle}</span>
        </p>

        {/* Speaker intro hint — auto-dismisses after 30 s */}
        {showIntroHint && (
          <div className="w-full flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <span className="text-amber-500 mt-0.5 shrink-0">●</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-700">Start with a quick speaker introduction.</p>
              <p className="text-xs text-amber-600 mt-0.5">Go around the table — &ldquo;I&apos;m Name.&rdquo;</p>
            </div>
            <button
              onClick={() => setShowIntroHint(false)}
              className="text-amber-400 hover:text-amber-600 text-xs shrink-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <button
          onClick={handleStop}
          className="w-full max-w-xs py-4 border-2 border-red-600 text-red-600 text-base font-semibold rounded-2xl hover:bg-red-50 transition-colors"
        >
          Stop recording
        </button>

        <p className="text-xs text-kk-muted text-center">
          Keep this page open while recording. The screen will stay awake.
        </p>
      </div>
    )
  }

  // Uploading
  if (phase === 'uploading') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-10 flex flex-col items-center gap-4">
        <svg className="animate-spin h-10 w-10 text-kk-muted" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-sm text-kk-ink font-medium">{uploadMsg || 'Uploading…'}</p>
        <p className="text-xs text-kk-muted text-center">Please keep this page open until the upload completes.</p>
      </div>
    )
  }

  // Queued for transcription
  if (phase === 'queued') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-8 space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-xl text-kk-good">✓</span>
          <div>
            <p className="text-sm font-semibold text-kk-ink">Recording uploaded</p>
            <p className="text-sm text-kk-muted">Transcription is in progress. This usually takes a few minutes.</p>
          </div>
        </div>
        <p className="text-xs text-kk-muted">
          You can close this page. The transcript will appear on the meeting page when ready.
          If speakers need labelling, you&apos;ll see a prompt there.
        </p>
        <button
          onClick={() => router.push(`/meetings/${meetingId}`)}
          className="w-full py-3 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
        >
          Back to meeting
        </button>
      </div>
    )
  }

  // Failed
  if (phase === 'failed') {
    return (
      <div className="bg-kk-panel border border-kk-line rounded-2xl px-6 py-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-kk-ink mb-1">Something went wrong</h2>
          {error && <p className="text-sm text-kk-muted">{error}</p>}
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleRetry}
            className="flex-1 py-3 bg-kk-ink text-white text-sm font-medium rounded-xl hover:opacity-90 transition-opacity"
          >
            {audioUploaded ? 'Retry transcription' : 'Retry upload'}
          </button>
          <button
            onClick={() => router.push(`/meetings/${meetingId}`)}
            className="flex-1 py-3 border border-kk-line text-sm text-kk-muted rounded-xl hover:text-kk-ink transition-colors"
          >
            Back to meeting
          </button>
        </div>
      </div>
    )
  }

  return null
}

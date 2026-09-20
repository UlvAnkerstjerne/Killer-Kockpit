/**
 * lib/assemblyai/client.ts
 *
 * Server-side AssemblyAI REST client for in-person meeting transcription.
 *
 * Region decision
 * ───────────────
 * EU endpoint (api.eu.assemblyai.com) is used by default so audio and
 * transcripts never leave the European Union. Both Universal-3.5 Pro and
 * Universal-2 are available in EU. The base URL is configurable via
 * ASSEMBLYAI_BASE_URL (default: https://api.eu.assemblyai.com).
 *
 * Model selection
 * ────────────────
 * Ordered fallback by language:
 *
 *   language 'da' (Danish)
 *     → speech_model: 'universal-2'
 *       Universal-3 Pro does not support Danish.  Universal-2 covers 99
 *       languages including Danish at good accuracy with full diarization and
 *       speaker identification support.
 *
 *   language 'detect' or 'en' (auto-detect / English)
 *     → speech_model: 'universal-3-pro'
 *       Universal-3 Pro delivers higher accuracy for supported languages
 *       (English, French, German, Spanish, and ~14 others) with diarization
 *       and speaker identification.  Language detection is always enabled for
 *       'detect' mode so AssemblyAI resolves the spoken language itself.
 *
 * The actual model used is returned by AssemblyAI in the transcript response
 * and stored in sources.metadata.speech_model_used for auditability.
 *
 * Language handling
 * ─────────────────
 * We set language_code = 'da' for Danish-primary meetings.  Mixed meetings
 * should use language_detection = true instead (cannot combine both).
 * The caller controls this via the LanguageConfig union type.
 *
 * Speaker identification
 * ──────────────────────
 * When known speaker names are supplied (from meeting attendees), we send
 * speech_understanding.request.speaker_identification with speaker_type="name"
 * and known_values=[attendee names].  If no known names are available, only
 * speaker_labels is enabled (diarization without name mapping).
 *
 * Security
 * ────────
 * ASSEMBLYAI_API_KEY is read from env at call time and never exposed to the
 * browser. Signed URLs for private storage are generated server-side.
 *
 * Cost discipline
 * ───────────────
 * Only transcription, diarization, and speaker identification are enabled.
 * No summaries, sentiment, entity detection, chapters, or IAB classification.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type LanguageConfig =
  | { mode: 'detect' }                          // language_detection = true
  | { mode: 'fixed'; languageCode: string }     // language_code = <code>

export interface SubmitTranscriptionInput {
  audioUrl:        string          // short-lived signed URL to private Supabase Storage object
  speakerNames:    string[]        // confirmed attendee names (may be empty)
  speakerCount:    number | null   // from attendee list; null = let model decide
  languageConfig:  LanguageConfig
  webhookUrl:      string          // POST /api/assemblyai/webhook
  webhookSecret:   string          // ASSEMBLYAI_WEBHOOK_SECRET value
}

export interface SubmitTranscriptionResult {
  transcriptId: string
  status:       string  // e.g. 'queued', 'processing'
}

export interface AssemblyAITranscript {
  id:           string
  status:       'queued' | 'processing' | 'completed' | 'error'
  text:         string | null
  error:        string | null
  utterances:   AssemblyAIUtterance[] | null
  // Speaker identification may replace generic labels with names
  words:        AssemblyAIWord[] | null
  audio_duration:  number | null
  language_code:   string | null
  speech_model:    string | null   // actual model used (e.g. 'universal-2', 'universal-3-pro')
}

export interface AssemblyAIUtterance {
  speaker:    string    // generic label 'A', 'B', 'C'  OR  name if speaker_identification succeeded
  text:       string
  start:      number    // ms
  end:        number    // ms
  confidence: number
  words?:     AssemblyAIWord[]
}

export interface AssemblyAIWord {
  text:       string
  start:      number
  end:        number
  confidence: number
  speaker:    string | null
}

// ─── Config ────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  return (process.env.ASSEMBLYAI_BASE_URL ?? 'https://api.eu.assemblyai.com').replace(/\/$/, '')
}

function getApiKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY
  if (!key) throw new Error('ASSEMBLYAI_API_KEY is not configured')
  return key
}

function authHeaders() {
  return {
    'Authorization': getApiKey(),
    'Content-Type':  'application/json',
  }
}

// ─── Submit transcription ──────────────────────────────────────────────────

/**
 * Submits an audio file for transcription.
 *
 * Returns the transcript ID to store on meeting_recordings.assemblyai_transcript_id.
 * Completion is delivered via webhook — never hold a request open.
 */
export async function submitTranscription(
  input: SubmitTranscriptionInput,
): Promise<SubmitTranscriptionResult> {
  const {
    audioUrl, speakerNames, speakerCount, languageConfig, webhookUrl, webhookSecret,
  } = input

  // Model selection: universal-3-pro for English/auto-detect; universal-2 for Danish.
  // Universal-3 Pro does not support Danish — use universal-2 when language is fixed to 'da'.
  const isDanish = languageConfig.mode === 'fixed' && languageConfig.languageCode === 'da'
  const speechModel = isDanish ? 'universal-2' : 'universal-3-pro'

  // Build the request body
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    audio_url:      audioUrl,
    speaker_labels: true,   // enable speaker diarization (required for utterances)
    punctuate:      true,   // required for speaker_labels per API docs

    // Webhook (prefer over polling; production-ready)
    webhook_url:               webhookUrl,
    webhook_auth_header_name:  'x-assemblyai-webhook-secret',
    webhook_auth_header_value: webhookSecret,

    speech_model: speechModel,
  }

  // Language
  if (languageConfig.mode === 'detect') {
    body.language_detection = true
  } else {
    body.language_code = languageConfig.languageCode
  }

  // Speaker count hint (only when we have a reliable count)
  if (speakerCount !== null && speakerCount >= 2) {
    body.speakers_expected = speakerCount
  }

  // Speaker identification: replace generic A/B/C labels with real names
  // Only enabled when we have known speaker names to map.
  if (speakerNames.length > 0) {
    body.speech_understanding = {
      request: {
        speaker_identification: {
          speaker_type:  'name',
          known_values:  speakerNames,
        },
      },
    }
  }

  const res = await fetch(`${getBaseUrl()}/v2/transcript`, {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`AssemblyAI submit failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { id: string; status: string }
  return { transcriptId: data.id, status: data.status }
}

// ─── Retrieve completed transcript ────────────────────────────────────────

/**
 * Fetches the completed transcript object from AssemblyAI.
 * Called from the webhook handler — never from the browser.
 */
export async function getTranscript(transcriptId: string): Promise<AssemblyAITranscript> {
  const res = await fetch(`${getBaseUrl()}/v2/transcript/${encodeURIComponent(transcriptId)}`, {
    headers: authHeaders(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`AssemblyAI getTranscript failed (${res.status}): ${text}`)
  }

  return res.json() as Promise<AssemblyAITranscript>
}

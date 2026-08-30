/**
 * lib/google/drive.ts
 *
 * URL parsing and Drive API metadata fetch for Phase C1 Drive references.
 *
 * Scope: drive.metadata.readonly — reads file metadata only.
 * We never access, download, or store file contents.
 *
 * Supported URL formats
 * ---------------------
 * • https://docs.google.com/document/d/{id}/edit          (Google Docs)
 * • https://docs.google.com/spreadsheets/d/{id}/edit      (Google Sheets)
 * • https://docs.google.com/presentation/d/{id}/edit      (Google Slides)
 * • https://docs.google.com/forms/d/{id}/edit             (Google Forms)
 * • https://drive.google.com/file/d/{id}/view             (Drive file/PDF)
 * • https://drive.google.com/open?id={id}                 (legacy open link)
 * • https://drive.google.com/uc?id={id}                   (legacy uc link)
 *
 * resourceKey handling
 * --------------------
 * Shared links sometimes include a `resourcekey` query param that Google
 * requires to access certain files in Shared Drives.  We extract it from
 * the URL, pass it to the API, and store the API-returned value.
 * A missing resourceKey is not an error unless the API requires one for
 * that specific file.
 *
 * File ID validation
 * ------------------
 * We do NOT enforce a fixed length — Google's own format is undocumented
 * and has changed over time.  We validate:
 *   • The hostname is an allowed Google domain
 *   • The ID segment contains only alphanumeric, hyphen, underscore chars
 *   • The ID is non-empty
 * The Drive API is the authority on whether a given ID is valid.
 */

import { google } from 'googleapis'
import type { Auth, drive_v3 } from 'googleapis'

// ─── URL parsing ─────────────────────────────────────────────────────────────

const ALLOWED_HOSTNAMES = new Set([
  'docs.google.com',
  'drive.google.com',
])

/** File ID character whitelist: alphanumeric, hyphen, underscore. */
const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/

export interface ParsedDriveUrl {
  fileId:      string
  resourceKey: string | null
}

/**
 * Extracts a Drive file ID (and optional resourceKey) from a pasted URL.
 * Returns null for any URL that is not a recognised Google Drive/Docs link.
 * Never throws — all errors are represented as null.
 */
export function parseDriveUrl(raw: string): ParsedDriveUrl | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  if (!ALLOWED_HOSTNAMES.has(url.hostname)) return null

  // Path-based IDs: /d/{id}/  — present in all Docs/Sheets/Slides/Forms/Drive URLs
  const pathMatch = url.pathname.match(/\/d\/([^/?#]+)/)
  let fileId: string | null = pathMatch?.[1] ?? null

  // Query-based IDs: ?id=  — legacy drive.google.com/open and /uc links
  if (!fileId) {
    fileId = url.searchParams.get('id')
  }

  if (!fileId || !FILE_ID_RE.test(fileId)) return null

  // resourceKey is case-insensitively named 'resourcekey' in Google URLs
  const resourceKey =
    url.searchParams.get('resourcekey') ??
    url.searchParams.get('resourceKey') ??
    null

  return { fileId, resourceKey }
}

// ─── Drive API fetch ──────────────────────────────────────────────────────────

export interface DriveFileMeta {
  fileId:        string
  name:          string
  mimeType:      string
  webViewLink:   string
  modifiedTime:  string | null
  ownerEmail:    string | null
  sharedDriveId: string | null
  resourceKey:   string | null
}

export type DriveFileResult =
  | DriveFileMeta
  | { notFound: true }
  | { forbidden: true }

/**
 * Fetches Drive file metadata using the requesting user's OAuth client.
 *
 * Uses supportsAllDrives:true so Shared Drive files resolve correctly.
 * Requests only the fields needed for provenance storage — never content.
 *
 * Returns:
 *   • DriveFileMeta   — success
 *   • { notFound }    — 404 from Drive API (file doesn't exist or bad ID)
 *   • { forbidden }   — 403 from Drive API (file exists but user has no access)
 *
 * Throws on unexpected errors (network failure, auth error, etc.) — the
 * caller is responsible for catching these and surfacing a generic retry message.
 */
export async function fetchDriveFileMeta(
  oauthClient: Auth.OAuth2Client,
  fileId: string,
  resourceKey: string | null,
): Promise<DriveFileResult> {
  const drive = google.drive({ version: 'v3', auth: oauthClient })

  try {
    // Build typed params.  resourceKey is a valid Drive API parameter for shared
    // links but is not yet present in the googleapis TypeScript definitions —
    // we merge it in via spread so the underlying HTTP call receives it correctly.
    const params: drive_v3.Params$Resource$Files$Get & { resourceKey?: string } = {
      fileId,
      // Request only the fields we store — no content fields.
      // owners may be absent for Shared Drive files; driveId identifies Shared Drives.
      // resourceKey is returned by the API when available.
      fields:            'id,name,mimeType,webViewLink,modifiedTime,owners,driveId,resourceKey',
      supportsAllDrives: true,
      ...(resourceKey ? { resourceKey } : {}),
    }

    const response = await drive.files.get(params as drive_v3.Params$Resource$Files$Get)
    const data = response.data

    // owners[] is absent for Shared Drive files — treat as null
    const ownerEmail = Array.isArray(data.owners) && data.owners.length > 0
      ? (data.owners[0].emailAddress ?? null)
      : null

    // Prefer API-returned resourceKey; fall back to the one we supplied
    const apiResourceKey = (data.resourceKey as string | undefined) ?? resourceKey ?? null

    return {
      fileId:        data.id!,
      name:          data.name!,
      mimeType:      data.mimeType!,
      webViewLink:   data.webViewLink!,
      modifiedTime:  (data.modifiedTime as string | null | undefined) ?? null,
      ownerEmail,
      sharedDriveId: (data.driveId as string | null | undefined) ?? null,
      resourceKey:   apiResourceKey,
    }
  } catch (err: unknown) {
    // googleapis surfaces HTTP status codes on the error object
    const status = (err as { code?: number; status?: number })?.code
      ?? (err as { code?: number; status?: number })?.status
    if (status === 404) return { notFound: true }
    if (status === 403) return { forbidden: true }
    throw err
  }
}

// ─── Display helpers ──────────────────────────────────────────────────────────

/** Returns a short human-readable label for a Drive MIME type. */
export function getDriveFileTypeLabel(mimeType: string): string {
  const labels: Record<string, string> = {
    'application/vnd.google-apps.document':     'Docs',
    'application/vnd.google-apps.spreadsheet':  'Sheets',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.form':         'Forms',
    'application/pdf':                          'PDF',
  }
  return labels[mimeType] ?? 'File'
}

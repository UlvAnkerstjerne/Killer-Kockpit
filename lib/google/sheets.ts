/**
 * lib/google/sheets.ts
 *
 * Google Sheets API v4 wrapper for the Killer Kuality Check integration.
 *
 * Reads three tabs from the SSP/CPH Airport response spreadsheet:
 *   - Scores         — pre-calculated scores per submission
 *   - Form Responses 1 — raw form answers (86 columns)
 *   - Config         — checkpoint definitions (section, name, critical flag, response header)
 *
 * Scope required: spreadsheets.readonly
 * Never writes to the spreadsheet.
 */

import { google } from 'googleapis'
import type { Auth } from 'googleapis'

export const KKC_SSP_CPH_SPREADSHEET_ID = '19nhDPm4ILEO473ekLJGuJzBvRP9SCh9vVCA5Iewcn4A'

// Form Responses 1 has 86 columns (A through CH)
const FORM_RESPONSES_RANGE = 'Form Responses 1!A:CH'
const SCORES_RANGE         = 'Scores!A:H'
const CONFIG_RANGE         = 'Config!A:D'

export interface RawSheetData {
  scoresRows:   string[][]
  formHeaders:  string[]
  formRows:     string[][]   // rows 2+ (submissions only, no header)
  configRows:   string[][]   // rows 2+ (checkpoints only, no header)
}

/**
 * Fetches all three tabs from the KKC SSP/CPH spreadsheet in a single
 * batchGet call. Returns raw string arrays — parsing is done by the caller.
 *
 * Throws on API errors (network failure, permission denied, bad spreadsheet ID).
 * The caller is responsible for mapping error codes to user-facing messages.
 */
export async function fetchKKCRawData(
  oauthClient: Auth.OAuth2Client,
): Promise<RawSheetData> {
  const sheets = google.sheets({ version: 'v4', auth: oauthClient })

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId:       KKC_SSP_CPH_SPREADSHEET_ID,
    ranges:              [SCORES_RANGE, FORM_RESPONSES_RANGE, CONFIG_RANGE],
    valueRenderOption:   'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  })

  const [scoresRange, formRange, configRange] = response.data.valueRanges ?? []

  const scoresAll   = (scoresRange?.values   ?? []) as string[][]
  const formAll     = (formRange?.values     ?? []) as string[][]
  const configAll   = (configRange?.values   ?? []) as string[][]

  // Row 0 = headers, rows 1+ = data
  const scoresRows  = scoresAll.slice(1).filter(r => r[0])   // skip header, skip blank rows
  const formHeaders = formAll[0] ?? []
  const formRows    = formAll.slice(1).filter(r => r[0])     // skip header, skip blank rows
  const configRows  = configAll.slice(1).filter(r => r[0] && r[1]) // must have section + checkpoint

  return { scoresRows, formHeaders, formRows, configRows }
}

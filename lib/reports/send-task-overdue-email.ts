/**
 * lib/reports/send-task-overdue-email.ts
 *
 * Sends a staged overdue-task reminder email via Resend.
 * Called by the hourly runTaskOverdueReminderJob checker.
 *
 * Server-only — never import from client components.
 *
 * Required env vars:
 *   RESEND_API_KEY      — Resend API key
 *   RESEND_FROM         — Verified sender, e.g. "Killer Kockpit <kockpit@killerkebab.com>"
 *   NEXT_PUBLIC_APP_URL — App base URL, e.g. "https://kockpit.killerkebab.com"
 */

import { Resend } from 'resend'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskOverdueEmailInput {
  taskId:       string
  title:        string
  /** ISO timestamptz — the task's due_at value */
  dueAt:        string
  /** Hours after deadline for this reminder stage: 0 | 24 | 48 | 72 */
  stageHours:   number
  ownerEmail:   string
  ownerName:    string
  projectName:  string | null
}

export type TaskOverdueEmailResult =
  | { ok: true;  id: string }
  | { ok: false; error: string }

// ─── Config ───────────────────────────────────────────────────────────────────

function getResendConfig(): { apiKey: string; from: string } | { missing: string[] } {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from   = process.env.RESEND_FROM?.trim()
  const missing: string[] = []
  if (!apiKey) missing.push('RESEND_API_KEY')
  if (!from)   missing.push('RESEND_FROM')
  if (missing.length) return { missing }
  return { apiKey: apiKey!, from: from! }
}

function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() ?? 'https://kockpit.killerkebab.com'
}

// ─── Styling ──────────────────────────────────────────────────────────────────

const RED    = '#AD3919'
const YELLOW = '#F5DA93'
const INK    = '#171717'
const MUTED  = '#6b6760'
const BAD    = '#8d3737'
const BORDER = '#d9d4cc'
const SOFT   = '#f5f3ee'
const WHITE  = '#ffffff'

// ─── Subject and stage copy ───────────────────────────────────────────────────

export function buildOverdueSubject(title: string): string {
  return `Overdue task — ${title}`
}

export function buildStageLabel(stageHours: number): string {
  switch (stageHours) {
    case 0:  return 'This task is now overdue.'
    case 24: return 'This task has been overdue for more than 24 hours.'
    case 48: return 'This task has been overdue for more than 48 hours.'
    case 72: return 'This task has been overdue for more than 72 hours. This is the final reminder.'
    default: return `This task has been overdue for more than ${stageHours} hours.`
  }
}

function formatDueDate(dueAt: string): string {
  return new Date(dueAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function isFinalStage(stageHours: number): boolean {
  return stageHours === 72
}

// ─── Plain text ───────────────────────────────────────────────────────────────

function buildPlainBody(input: TaskOverdueEmailInput, taskUrl: string): string {
  const { title, dueAt, stageHours, ownerName, projectName } = input

  const lines: string[] = [
    `Overdue task — ${title}`,
    '',
    buildStageLabel(stageHours),
    '',
    `Task:    ${title}`,
    `Due:     ${formatDueDate(dueAt)}`,
    ownerName ? `Owner:   ${ownerName}` : null,
    projectName ? `Project: ${projectName}` : null,
    '',
    `View task: ${taskUrl}`,
    '',
  ].filter((l): l is string => l !== null)

  if (isFinalStage(stageHours)) {
    lines.push('No further reminders will be sent for this task.')
    lines.push('')
  }

  lines.push(
    '—',
    'Killer Kockpit · Killer Kebab internal use only',
  )

  return lines.join('\n')
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function buildHtmlBody(input: TaskOverdueEmailInput, taskUrl: string): string {
  const { title, dueAt, stageHours, ownerName, projectName } = input

  const stageLabel  = buildStageLabel(stageHours)
  const dueDateStr  = formatDueDate(dueAt)
  const finalNotice = isFinalStage(stageHours)
    ? `<p style="margin:12px 0 0;font-size:12px;color:${MUTED};font-style:italic">No further reminders will be sent for this task.</p>`
    : ''

  const projectRow = projectName ? `
              <tr>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Project</p>
                  <p style="margin:0;font-size:14px;font-weight:600;color:${INK}">${projectName}</p>
                </td>
              </tr>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Overdue task reminder</title>
</head>
<body style="margin:0;padding:0;background:${SOFT};font-family:Helvetica,Arial,sans-serif;color:${INK}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};padding:24px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
        style="background:${WHITE};border-radius:8px;border:1px solid ${BORDER};overflow:hidden;max-width:560px">

        <!-- Header -->
        <tr>
          <td style="background:${RED};padding:20px 28px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${YELLOW}">KILLER KOCKPIT</p>
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff">Overdue Task</p>
          </td>
        </tr>

        <!-- Alert banner -->
        <tr>
          <td style="padding:16px 28px 0">
            <div style="background:#f5e7e7;border:1px solid #d98080;border-radius:6px;padding:12px 16px">
              <p style="margin:0;font-size:13px;font-weight:600;color:${BAD}">${stageLabel}</p>
              ${finalNotice}
            </div>
          </td>
        </tr>

        <!-- Task title -->
        <tr>
          <td style="padding:20px 28px 0">
            <p style="margin:0 0 6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Task</p>
            <p style="margin:0;font-size:18px;font-weight:700;color:${INK}">${title}</p>
          </td>
        </tr>

        <!-- Meta -->
        <tr>
          <td style="padding:16px 28px 0">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Due date</p>
                  <p style="margin:0;font-size:14px;font-weight:600;color:${BAD}">${dueDateStr}</p>
                </td>
                <td style="padding-right:16px">
                  <p style="margin:0 0 2px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED}">Owner</p>
                  <p style="margin:0;font-size:14px;font-weight:600;color:${INK}">${ownerName}</p>
                </td>
                ${projectRow}
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:20px 28px 24px">
            <a href="${taskUrl}"
               style="display:inline-block;background:${INK};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:8px">
              View task in Killer Kockpit →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${SOFT};border-top:1px solid ${BORDER};padding:12px 28px">
            <p style="margin:0;font-size:11px;color:${MUTED}">
              Sent by <strong style="color:${RED}">Killer Kockpit</strong> · Killer Kebab internal use only
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Sends an overdue-task reminder email via Resend.
 * Returns { ok: true, id } on success or { ok: false, error } on failure.
 * Never throws.
 */
export async function sendTaskOverdueEmail(
  input: TaskOverdueEmailInput,
): Promise<TaskOverdueEmailResult> {
  const config = getResendConfig()
  if ('missing' in config) {
    return { ok: false, error: `Missing env vars: ${config.missing.join(', ')}` }
  }

  const taskUrl = `${getAppUrl()}/tasks/${input.taskId}`
  const subject = buildOverdueSubject(input.title)

  const resend = new Resend(config.apiKey)
  try {
    const { data, error } = await resend.emails.send({
      from:    config.from,
      to:      [input.ownerEmail],
      subject,
      text:    buildPlainBody(input, taskUrl),
      html:    buildHtmlBody(input, taskUrl),
    })

    if (error) return { ok: false, error: `Resend API error: ${error.message}` }
    return { ok: true, id: data!.id }
  } catch (err) {
    return { ok: false, error: `Resend request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

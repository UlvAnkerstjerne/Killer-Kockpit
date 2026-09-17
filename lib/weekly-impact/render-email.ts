import type { WeeklyImpactBrief, WeeklyImpactEvidence } from './types'

const COLORS = {
  red: '#AD3919', yellow: '#F5DA93', ink: '#171717', muted: '#6b6760',
  line: '#d9d4cc', soft: '#f5f3ee', white: '#ffffff',
}

function esc(value: string): string {
  return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
}

function bullets(items: Array<{ text: string }>): string {
  return `<ul style="margin:0;padding-left:20px">${items.map(item => `<li style="margin:0 0 8px;padding-left:2px;line-height:1.5">${esc(item.text)}</li>`).join('')}</ul>`
}

function section(title: string, body: string): string {
  if (!body) return ''
  return `<tr><td class="content-cell" style="padding:24px 30px 0"><h2 style="margin:0 0 12px;font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${COLORS.red}">${esc(title)}</h2>${body}</td></tr>`
}

export function buildWeeklyImpactSubject(evidence: WeeklyImpactEvidence): string {
  return `Your week in Killer Kockpit · ${evidence.week.displayRange}`
}

export function renderWeeklyImpactEmail(evidence: WeeklyImpactEvidence, brief: WeeklyImpactBrief) {
  const subject = buildWeeklyImpactSubject(evidence)
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL?.trim() ?? 'https://kockpit.killerkebab.com').replace(/\/$/, '')
  const themes = brief.themes.map(theme => `<div style="margin:0 0 16px"><h3 style="margin:0 0 5px;font-size:16px;font-weight:800">${esc(theme.heading)}</h3><p style="margin:0;line-height:1.55">${esc(theme.synthesis)}</p></div>`).join('')

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title><style>@media(max-width:480px){.content-cell{padding-left:20px!important;padding-right:20px!important}}</style></head>
<body style="margin:0;padding:0;background:${COLORS.soft};font-family:Inter,Helvetica,Arial,sans-serif;font-size:16px;color:${COLORS.ink};overflow-wrap:anywhere"><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${COLORS.soft};padding:16px 8px"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:600px;background:${COLORS.white};border:1px solid ${COLORS.line};border-radius:10px;overflow:hidden">
<tr><td class="content-cell" style="background:${COLORS.red};padding:24px 30px"><p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:1.5px;color:${COLORS.yellow}">KILLER KOCKPIT</p><h1 style="margin:0 0 3px;font-size:25px;font-weight:900;color:white">YOUR WEEK</h1><p style="margin:0;font-size:14px;color:#f5ddd6">${esc(evidence.week.displayRange)}</p></td></tr>
<tr><td class="content-cell" style="padding:24px 30px 0"><p style="margin:0 0 8px;font-size:13px;color:${COLORS.muted}">Hi ${esc(evidence.user.name.split(' ')[0])},</p><p style="margin:0;font-size:16px;line-height:1.55">${esc(brief.openingSynthesis)}</p></td></tr>
${section('What your week was about', themes)}
${section('What moved', brief.whatMoved.length ? bullets(brief.whatMoved) : '<p style="margin:0;line-height:1.55">No confirmed movements in the available records.</p>')}
${section('Going into next week', brief.goingIntoNextWeek.length ? bullets(brief.goingIntoNextWeek) : '<p style="margin:0;line-height:1.55">No open commitments in the available records.</p>')}
<tr><td class="content-cell" style="padding:24px 30px"><a href="${esc(appUrl)}/today" style="display:inline-block;background:${COLORS.ink};color:white;text-decoration:none;font-size:13px;font-weight:800;padding:12px 18px;border-radius:8px">Open Today in Killer Kockpit →</a></td></tr>
<tr><td class="content-cell" style="background:${COLORS.soft};border-top:1px solid ${COLORS.line};padding:13px 30px"><p style="margin:0;font-size:11px;color:${COLORS.muted}">Killer Kockpit · Killer Kebab internal use only</p></td></tr>
</table></td></tr></table></body></html>`

  const text = [
    'KILLER KOCKPIT', `YOUR WEEK · ${evidence.week.displayRange}`, '', `Hi ${evidence.user.name.split(' ')[0]},`, '', brief.openingSynthesis,
    ...(brief.themes.length ? ['', 'WHAT YOUR WEEK WAS ABOUT', ...brief.themes.flatMap(theme => [theme.heading, theme.synthesis, ''])] : []),
    '', 'WHAT MOVED', ...(brief.whatMoved.length ? brief.whatMoved.map(bullet => `• ${bullet.text}`) : ['No confirmed movements in the available records.']),
    '', 'GOING INTO NEXT WEEK', ...(brief.goingIntoNextWeek.length ? brief.goingIntoNextWeek.map(bullet => `• ${bullet.text}`) : ['No open commitments in the available records.']),
    `Open Today: ${appUrl}/today`, '', 'Killer Kockpit · Killer Kebab internal use only',
  ].join('\n')

  return { subject, html, text }
}

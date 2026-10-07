// Due-date display helpers shared by the Today cards.

export const DUE_STATE_CONFIG = {
  overdue:   { label: 'OVERDUE',  cls: 'text-white bg-[#AD3919] [box-shadow:2px_2px_0_#555555]' },
  today:     { label: 'TODAY',    cls: 'text-kk-warn bg-kk-warn-bg [box-shadow:2px_2px_0_#555555]' },
  tomorrow:  { label: 'TOMORROW', cls: 'text-kraft-light bg-[#171717] [box-shadow:2px_2px_0_#555555]' },
  this_week: { label: '',         cls: '' },
  no_date:   { label: '',         cls: '' },
} as const

export function formatShortDate(dt: string | null): string | null {
  if (!dt) return null
  return new Date(dt).toLocaleDateString('en-GB', {
    timeZone: 'Europe/Copenhagen', weekday: 'short', day: 'numeric', month: 'short',
  })
}

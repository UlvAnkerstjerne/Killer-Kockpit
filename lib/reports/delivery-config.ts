/**
 * lib/reports/delivery-config.ts
 *
 * Central configuration for automated report delivery.
 * Recipients and report metadata are defined here — not scattered through components.
 *
 * Kockpit notification recipients are resolved by stable app_users.email at
 * runtime so user UUIDs are never hardcoded.
 */

export const KKC_SSP_CPH_DELIVERY = {
  /** Stable identifier stored in report_deliveries.report_type */
  reportType:    'kkc_ssp_cph' as const,
  /** Human-readable label passed to the PDF generator and email subject */
  locationLabel: 'SSP / CPH Airport',
  /** Fixed email recipient list for automated PDF delivery */
  recipients:    ['drift@killerkebab.com'] as string[],
  /**
   * app_users.email values for Kockpit notification recipients.
   * Resolved to user IDs at runtime — no UUIDs hardcoded.
   */
  notifyUserEmails: ['drift@killerkebab.com', 'ulv@killerkebab.com'] as string[],
}

export const AUDIT_DELIVERY = {
  /** Stable identifier stored in report_deliveries.report_type */
  reportType:      'audit' as const,
  /** Fixed email recipient list for audit result summary emails */
  emailRecipients: ['drift@killerkebab.com'] as string[],
  /**
   * app_users.email values for Kockpit notification recipients.
   * Resolved to user IDs at runtime — no UUIDs hardcoded.
   */
  notifyUserEmails: ['drift@killerkebab.com', 'ulv@killerkebab.com'] as string[],
}

export const DINER_RESULT_DELIVERY = {
  /** Stable identifier stored in report_deliveries.report_type */
  reportType:      'diner_result' as const,
  /** Fixed email recipient list for Mystery Diner result emails */
  emailRecipients: ['drift@killerkebab.com'] as string[],
  /**
   * app_users.email values for Kockpit notification recipients.
   * Resolved to user IDs at runtime — no UUIDs hardcoded.
   */
  notifyUserEmails: ['drift@killerkebab.com', 'ulv@killerkebab.com'] as string[],
}

/**
 * Overdue Red Flag follow-up escalation delivery config.
 *
 * When an audit_followup is past its due_at and not resolved, a one-time
 * escalation is sent to three parties:
 *   1. Kasper (always)  — drift@killerkebab.com
 *   2. Regional Manager — resolved per location (see regionManagerByLocation)
 *   3. Ulv (always)     — ulv@killerkebab.com
 *
 * If a location has no RM configured (e.g. Copenhagen Airport) only Kasper
 * and Ulv receive the escalation.
 *
 * Location name strings are the exact values from the locations table.
 */
export const AUDIT_FOLLOWUP_ESCALATION = {
  /** Stable identifier stored in report_deliveries.report_type */
  reportType: 'audit_followup_overdue' as const,

  /** Always-included email recipients (Kasper + Ulv) */
  fixedEmailRecipients: [
    'drift@killerkebab.com',
    'ulv@killerkebab.com',
  ] as string[],

  /**
   * app_users.email values resolved to user IDs for Kockpit notifications.
   * Fixed recipients only — RM notification is added dynamically at runtime.
   */
  fixedNotifyEmails: [
    'drift@killerkebab.com',
    'ulv@killerkebab.com',
  ] as string[],

  /**
   * Maps exact locations.name values to the Regional Manager's app_users.email.
   * Lydia: Borgergade, Christianshavn, Nørrebro, Frederiksberg
   * Sara:  Vesterbro, Fisketorvet, Parken
   */
  regionManagerByLocation: new Map<string, string>([
    ['Killer Kebab Borgergade',       'lydia@killerkebab.com'],
    ['Killer Kebab Christianshavn',   'lydia@killerkebab.com'],
    ['Killer Kebab Nørrebro',         'lydia@killerkebab.com'],
    ['Killer Kebab Frederiksberg',    'lydia@killerkebab.com'],
    ['Killer Kebab Vesterbro',        'sara@killerkebab.com'],
    ['Killer Kebab Fisketorvet',      'sara@killerkebab.com'],
    ['Killer Kebab Parken',           'sara@killerkebab.com'],
  ]),
}

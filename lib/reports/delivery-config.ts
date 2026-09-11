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

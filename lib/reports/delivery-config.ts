/**
 * lib/reports/delivery-config.ts
 *
 * Central configuration for automated report delivery.
 * Recipients and report metadata are defined here — not scattered through components.
 */

export const KKC_SSP_CPH_DELIVERY = {
  /** Stable identifier stored in report_deliveries.report_type */
  reportType:    'kkc_ssp_cph' as const,
  /** Human-readable label passed to the PDF generator and email subject */
  locationLabel: 'SSP / CPH Airport',
  /** Fixed email recipient list for automated delivery */
  recipients:    ['drift@killerkebab.com'] as string[],
  /** app_users.display_name values to receive in-app Kockpit notifications */
  notifyUserDisplayNames: ['Kasper', 'Ulv'] as string[],
}

export const AUDIT_DELIVERY = {
  /** Stable identifier stored in report_deliveries.report_type */
  reportType:      'audit' as const,
  /** Fixed email recipient list for audit result summaries */
  emailRecipients: ['drift@killerkebab.com'] as string[],
  /** app_users.display_name values to receive in-app Kockpit notifications */
  notifyUserDisplayNames: ['Kasper', 'Ulv'] as string[],
}

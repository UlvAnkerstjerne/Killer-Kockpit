/**
 * lib/gsc/config.ts
 *
 * Shared Search Console configuration.
 *
 * SC_SITE_URL is the authoritative GSC property for killerkebab.com.
 * All consumers — sync, Morning Brief, and the Google dashboard page —
 * must import from here so a single change propagates everywhere.
 *
 * Property type: domain property (sc-domain:killerkebab.com)
 * Confirmed via sites.list(): 539 clicks/week vs 26 clicks/week for the
 * URL-prefix property https://killerkebab.com/.  The domain property
 * aggregates all subdomains and protocols; the URL-prefix misses >95% of
 * actual search traffic.
 */

export const SC_SITE_URL = 'sc-domain:killerkebab.com'

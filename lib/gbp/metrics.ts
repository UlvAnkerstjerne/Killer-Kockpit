/** Google's identifiers are the storage contract; labels are presentation metadata. */
export const GBP_METRIC_DEFINITIONS = {
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: { label: 'Search impressions — desktop', column: 'impressions_desktop_search' },
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: { label: 'Search impressions — mobile', column: 'impressions_mobile_search' },
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: { label: 'Maps impressions — desktop', column: 'impressions_desktop_maps' },
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: { label: 'Maps impressions — mobile', column: 'impressions_mobile_maps' },
  WEBSITE_CLICKS: { label: 'Website clicks', column: 'website_clicks' },
  CALL_CLICKS: { label: 'Call clicks', column: 'call_clicks' },
  BUSINESS_DIRECTION_REQUESTS: { label: 'Direction requests', column: 'direction_requests' },
  BUSINESS_BOOKINGS: { label: 'Bookings', column: null },
  BUSINESS_FOOD_ORDERS: { label: 'Food orders', column: null },
  BUSINESS_FOOD_MENU_CLICKS: { label: 'Menu interactions', column: null },
  BUSINESS_CONVERSATIONS: { label: 'Conversations (legacy)', column: null },
} as const
export const GBP_DAILY_METRICS = Object.keys(GBP_METRIC_DEFINITIONS) as Array<keyof typeof GBP_METRIC_DEFINITIONS>

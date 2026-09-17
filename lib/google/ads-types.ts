export type GoogleAdsProbeResult =
  | { ok: true; customerIds: string[]; checkedAt: string }
  | { ok: false; error: string; code?: string; requestId?: string }

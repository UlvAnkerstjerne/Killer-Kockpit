-- 060_diner_invitation_email.sql
--
-- Adds encrypted_invite_url to diner_invitations to support email retry.
--
-- Security model:
--   The raw invitation token is never stored. This column stores the invite URL
--   encrypted with AES-256-GCM using a server-side secret (DINER_INVITE_SECRET).
--   DB access alone is insufficient to reconstruct the URL — the server secret
--   is also required. This is equivalent security to the existing hash-only model.
--
--   If DINER_INVITE_SECRET is not configured, the column remains NULL and
--   email retry is unavailable (invitation creation and email send still work).
--
-- report_deliveries reuse:
--   Diner invitation emails are tracked in report_deliveries:
--     report_type    = 'diner_invitation'
--     submission_key = invitation UUID
--     recipient      = diner email address
--   The existing terminal-unique partial index ensures one sent record per
--   (type, invitation_id, email) combination, giving retry idempotency for free.

ALTER TABLE diner_invitations
  ADD COLUMN encrypted_invite_url text;

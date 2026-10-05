-- Grant marketing workspace access to Kasper, Lydia, Sara, and Adam.
-- These four users can view all Marketing data but have no permission rows
-- in user_marketing_permissions, so all write actions are blocked server-side.
-- Shuhei (MEMBER) and future users are NOT affected.
-- Ulv (SUPER_ADMIN) bypasses canAccessMarketing() regardless of this flag.

UPDATE app_users SET marketing_access = true
WHERE email IN (
  'drift@killerkebab.com',   -- Kasper Kristiansen
  'lydia@killerkebab.com',   -- Lydia Mertiri
  'sara@killerkebab.com',    -- Sara Jørgensen
  'adam@killerkebab.com'     -- Adam Vearey
);

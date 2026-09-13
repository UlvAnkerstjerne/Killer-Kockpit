-- Killer Kockpit — One-time cleanup: remove pre-existing left/inactive employees
--
-- PURPOSE:
--   Management decision (2026-09-13): all employees currently marked
--   employment_status = 'left' are to be permanently removed from Kockpit.
--   These are legacy records that accumulated before the Former/archive workflow
--   was introduced.
--
-- FUTURE BEHAVIOUR (not implemented here):
--   From this point forward, employees who leave are marked 'left' (Former)
--   and REMAIN in the database permanently as archived/Former records.
--   Only explicit management action should delete a Future Former person.
--   Do NOT build automatic deletion triggers.
--
-- SAFETY:
--   All foreign-key dependencies were audited before this migration was written:
--
--   CASCADE on delete (auto-handled):
--     employee_external_identities.employee_id  → employees.id (CASCADE)
--     employee_locations.employee_id            → employees.id (CASCADE)
--
--   NO ACTION (confirmed empty for left employees — safe to delete):
--     employees.manager_employee_id             → employees.id (self-ref, NO ACTION)
--     people_entries.employee_id                → employees.id (NO ACTION)
--     waiting_ons.waiting_for_employee_id       → employees.id (NO ACTION)
--
--   No formal FK (confirmed empty for left employees):
--     kk_update_entities.entity_id (employee type) — no left employees have updates
--
--   app_users, tasks, projects, meetings, decisions: reference app_users, not employees.
--
-- EXECUTION ORDER:
--   1. NULL out manager_employee_id within the left set first (self-ref safety).
--      PostgreSQL NO ACTION checks at statement end, but being explicit is safer.
--   2. DELETE all left employees. CASCADE handles the two child tables.

-- ── 1. Remove intra-left manager references ───────────────────────────────────
UPDATE employees
SET    manager_employee_id = NULL
WHERE  employment_status = 'left'
  AND  manager_employee_id IS NOT NULL;

-- ── 2. Delete all left employees ──────────────────────────────────────────────
DELETE FROM employees
WHERE  employment_status = 'left';

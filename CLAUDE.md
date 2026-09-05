@AGENTS.md

# Killer Kockpit — Claude Code Instructions

## Project identity

- **Product:** Killer Kockpit — internal company HQ for Killer Kebab (restaurant chain)
- **Production:** kockpit.killerkebab.com (deployed via Railway)
- **Dev server:** `npm run dev` → `http://localhost:3001`
- **Stack:** Next.js 15 App Router · TypeScript · Tailwind CSS · Supabase
  (PostgreSQL + Row-Level Security + SECURITY DEFINER RPCs)
- **Supabase project:** `c3a75128-2443-4bcd-a84a-9646e41154e3`

## Roles

| Role | Access |
|---|---|
| `SUPER_ADMIN` | Full access, user management |
| `ADMIN` | Organisation-wide access, management view |
| `MEMBER` | Own data only, personal view |

Role is stored in `app_users.role` and enforced server-side. Never trust caller-supplied role or user_id.

## Architecture conventions

- All DB mutations go through **SECURITY DEFINER RPCs** called via the service client (`createServiceClient`), not direct table writes from server actions
- Server actions always call `getCurrentUser()` first — never accept a caller-supplied user ID
- RLS is belt-and-suspenders; the server-side permission check is the primary gate
- The `audit_log` table is written exclusively through SECURITY DEFINER RPCs — never directly
- `createClient()` is async (returns `Promise<SupabaseClient>`); always `await` it
- `createServiceClient()` is synchronous

## Meeting lifecycle

```
scheduled → open → draft → published
                 ↘ cancelled
draft → open  (reopen)
```

- `scheduled`: not yet begun (`actual_start IS NULL`). Agenda is editable only here.
- `open`: `open_meeting_and_audit` has run, `actual_start = now()`
- `draft`: `close_meeting_and_audit` has run, `actual_end` set
- `published`: formal canonical minutes published

**Agenda lock rule:** `meeting.status !== 'scheduled'` → reject all agenda mutations (both server-side in `createAgendaItem`/`updateAgendaItem` and UI via `isEditable={status === 'scheduled'}`)

## Test conventions

- Unit tests: `__tests__/unit/` · Integration tests: `__tests__/integration/`
- Run all tests: `npm test` (Vitest)
- Before committing: `npm test && npx tsc --noEmit && npm run build`
- ~1200 tests as of M7. Always run full suite before committing.

## Routes and what is built

| Route | Status |
|---|---|
| `/today` | Built — daily dashboard |
| `/todos` | Built — personal to-dos with recurrence |
| `/inbox` | Built — Gmail thread viewer with entity linking |
| `/tasks` | Built — cross-user task handoff |
| `/waiting-ons` | Built |
| `/decisions` | Built |
| `/meetings`, `/meetings/[id]` | Built — full lifecycle + agenda + minutes + AI drafts |
| `/people`, `/people/[id]` | Built |
| `/projects`, `/projects/[id]` | Built |
| `/locations`, `/locations/[id]` | Built |
| `/team` | Built — user management (SUPER_ADMIN) |
| `/settings` | Built |
| `/knowledge` | Route exists, shows `PlaceholderPage` — **not yet built** |
| `/(marketing)` | Public marketing pages |

## What does NOT exist — do not assume it does

- A `Proposal` entity or approval workflow (described in `docs/archive/` spec but never implemented)
- A `knowledge` module (route is a placeholder)

## Stale files — do not use for architecture decisions

These files live in `docs/archive/` and describe a pre-build state or wrong product name:

- `docs/archive/killer_kockpit_v1_architecture.md` — pre-build spec, wrong product name ("Killer Koach"), describes unbuilt Proposal system
- `docs/archive/killer_kockpit_v1_schema.sql` — pre-build schema, role enum does not match live DB
- `docs/archive/killer_kockpit_dashboard_v4.html` — static HTML prototype

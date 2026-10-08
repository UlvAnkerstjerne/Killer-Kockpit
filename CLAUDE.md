@AGENTS.md

# Killer Kockpit — Claude Code Instructions

## Project identity

- **Product:** Killer Kockpit — internal company HQ for Killer Kebab
- **Production:** kockpit.killerkebab.com (Railway)
- **Dev server:** `npm run dev` → `http://localhost:3001`
- **Stack:** Next.js 16 App Router · TypeScript · Tailwind CSS · Supabase (PostgreSQL + RLS)

## Roles

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Full access, user management |
| `UM` | Organisation-wide access, management view |
| `MEMBER` | Own data only |

`SUPER_ADMIN` expands authorization only — it never changes relationship identity.

## Architecture conventions

**Mutations:**
- Workflow-critical or audited institutional transitions may use SECURITY DEFINER RPCs via `createServiceClient`.
- Ordinary CRUD uses server actions with direct table operations where consistent with existing architecture.
- Do not invent a new RPC just because a mutation exists.

**Authorization:**
- Prefer user-JWT + RLS for canonical visibility and access rules.
- If `createServiceClient` / service_role is used, explicitly authorize the current user and any user-controlled entity IDs **before** bypassing RLS.
- Never assume row existence equals authorization.
- Server actions must always call `getCurrentUser()` first.

**Supabase clients:**
- `createClient()` is async — always `await` it.
- `createServiceClient()` is synchronous.

## Mobile experience & personal scoping (regression-protected)

For `UM` and `SUPER_ADMIN`:
- **Mobile features follow role only** (`hasMobileManagerExperience(role)` in `lib/mobile.ts`), never the Personal/Management view. Mobile Today must keep `+ Add Audit` (`/kkc/audit`), `+ Add KQC` (`/kkc/ssp-cph`), *My tasks* with quick add, and *Meetings* with quick add. Mobile nav stays compact (Today, To-Dos, Tasks, Meetings) and other sections keep the "Open this section on desktop" gate (`MOBILE_MGMT_ROUTES`).
- **Personal lists are owner-only** — tasks, to-dos, recurring to-dos, waiting-ons and their counts. RLS lets managers read other users' rows, so always scope by `user.id` in the query **and** with `ownedBy()` (`lib/view.ts`).
- **Data view is separate**: `resolveView()` defaults to Personal; Management is explicit `?view=management` and stays available on desktop. Do not couple mobile visibility to it.
- Guarded by `__tests__/unit/mobile/*`, `e2e/mobile-today.spec.ts` and the required `mobile-guard` job in `.github/workflows/release-guard.yml`. Run locally: `E2E_FIXTURE_DIR=.e2e-fixtures npx vitest run __tests__/unit/mobile && NODE_OPTIONS=--max-old-space-size=8192 npm run build && npm run test:e2e`. Changing these behaviours intentionally means updating the tests in the same commit.

## Task delegation semantics

- `created_by_user_id` = Requested by · `owner_user_id` = Responsible
- Self-assigned task → Responsible may mark done directly.
- Delegated task, Responsible marks done → goes for Requester review.
- Delegated task, Requester reviews → Approve or Send back.
- Do not alter these semantics casually.

## Gmail / privacy

- Gmail mailbox access is strictly per authenticated app user.
- `SUPER_ADMIN` has no mailbox impersonation capability.
- Gmail scope: `gmail.readonly`. Email bodies are fetched on demand and **never persisted**.
- Shared provenance may expose safe metadata only.
- Another user's Gmail URL, body, or token must never be exposed.
- Shared provenance ≠ shared mailbox.

## Meetings

- Lifecycle: `scheduled → open → draft → published`; `draft → open` on reopen; cancellation supported.
- Agenda editable **only** while `scheduled`. Mutations must be rejected server-side once meeting begins.
- Published institutional minutes and outcomes are immutable.
- `meetings.location` is optional free-text scheduling metadata — do not confuse it with canonical `locations` records.

## AI and institutional data

- AI proposes or extracts; humans review and approve before anything becomes institutional record.
- Do not silently institutionalize model-generated facts.

## Visual QA

- DOM presence is not visual verification for layout-sensitive work.
- Inspect actual screenshots and measure real geometry when width or layout matters.
- React streaming/Suspense checks must observe an actual rendered frame; `page.evaluate` alone is insufficient.

## Workflow

- Inspect existing architecture before changing it.
- One feature or tightly related slice per implementation run.
- Avoid unrelated cleanup in feature commits.
- Run `npm test && npx tsc --noEmit && npm run build` before every commit (use `NODE_OPTIONS=--max-old-space-size=8192` for `tsc`/`build`; they run out of memory otherwise).
- **Do not deploy without explicit user approval.**
- Apply Supabase migrations through the MCP connector and retain migration files in Git. Never reapply an already-applied migration.

## Framework convention files

Do not classify framework-convention files as dead based on import references alone. Files such as `proxy.ts`, `page.tsx`, `layout.tsx`, `route.ts`, and similar framework-discovered entrypoints may have zero application imports while still being active. Verify framework registration and build behaviour before deleting them.

## Historical reference

`docs/archive/` is historical reference only and must not be treated as current architecture.

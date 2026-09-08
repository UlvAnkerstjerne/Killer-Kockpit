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
- Run `npm test && npx tsc --noEmit && npm run build` before every commit.
- **Do not deploy without explicit user approval.**
- Apply Supabase migrations through the MCP connector and retain migration files in Git. Never reapply an already-applied migration.

## Framework convention files

Do not classify framework-convention files as dead based on import references alone. Files such as `proxy.ts`, `page.tsx`, `layout.tsx`, `route.ts`, and similar framework-discovered entrypoints may have zero application imports while still being active. Verify framework registration and build behaviour before deleting them.

## Historical reference

`docs/archive/` is historical reference only and must not be treated as current architecture.

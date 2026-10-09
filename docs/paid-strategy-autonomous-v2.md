# Paid Strategy autonomous implementation (v2)

**Brain recommends → you approve → Kockpit does as much of the actual digital implementation as it can.**
A human task is a last resort, and only ever the exact irreducible act (filming) or the exact access/decision Kockpit lacks.

v1 turned every approval into a task for a person. That was wrong for the product. v2 keeps v1's foundation
(approval, audit, exactly-once claim, shared budget reservation, run linkage, permissions, no blind retry) and replaces the
task-first compiler with an executor-first state machine on the same table.

## Principle
`approved → planning → executing → verifying → ready_to_activate | in_motion | completed`, stopping only at
`waiting_for_access` (a capability is missing), `waiting_for_input` (a decision or a physical act), or `needs_attention` (uncertain state).
The strategy output is unchanged: advisory text, no IDs. The model writes creative **words** only; every ID is resolved server-side.

## Capability registry (`autonomous/capabilities.ts`)
The compiler asks what Kockpit can WRITE to before choosing a path, from configured env var *names*, granted OAuth scope *names* and
the Meta permissions the system user reports. Never a secret. A missing capability is an exact blocker with the smallest unblock; it is never a task.

## Modes
| Mode | What Kockpit does | Ends at |
|---|---|---|
| `tracking_execution` | Scans the live site, reads the pixel, implements the downstream event where it can write, verifies it reaches Meta | `completed`, or a precise blocker |
| `creative_execution` | Writes hooks/copy/CTA/script, validates every fact against the existing ad, creates a PAUSED ad in the existing ad set, saves a creative draft + test design | `ready_to_activate` (or `waiting_for_input` only if new footage is needed) |
| `campaign_creation` | Reads the source campaign from Meta, localises it for the new market, has Meta validate, creates campaign/ad set/creative/ad **PAUSED**, reads each back | `ready_to_activate` |
| `platform_action` | Unchanged: pause/resume/budget on an existing object through the trusted executor | `completed` / `in_motion` |

## Safeguards for creation
Created PAUSED only (no status parameter exists). `validate_only` preflight before any create. Each create is recorded in the ledger before the next step;
an uncertain response triggers a name-token lookup (`[KK-xxxxxxxx]`) so a retry adopts, never duplicates; Kockpit waits before creating after an uncertain attempt.
Read-back must match before it moves on. Activation (`ready_to_activate → in_motion`) is a separate approval that re-verifies the structure, sets the end date, and
activates ad → ad set → campaign through the existing trusted executor (guardrails, live re-read, read-back).

## Budget
Unchanged: 15,000 DKK hard ceiling, shared headroom, reservation at claim, released on cancel/failure/completion. Held while work waits or is ready to activate.
Meta budgets are minor units; `lib/meta/money.ts` is the single conversion point (this also fixes v1 Paid Recommendations, which compared raw synced values with whole-unit live reads).

## Not built
GTM/GA4/Webflow/CRM writers (no access exists), audience and retargeting creation, image/video generation, ad-set/ad status changes outside creation.

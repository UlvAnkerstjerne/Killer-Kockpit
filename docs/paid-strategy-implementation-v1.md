# Paid Strategy implementation v1

MESPER (Paid Strategy) decides **what** is worth doing. Kockpit decides **how** it can be implemented safely.
The strategy output is unchanged: advisory text, no IDs, no payloads. Implementation is compiled **server-side** after
the strategy exists, from the stored recommendation, synced Meta structure and a person's inputs. No AI call is involved.

## Modes (exactly one per recommendation)
| Mode | When | What it does | What it never does |
|---|---|---|---|
| Safe platform action | `budget` recommendations, once a person picks an existing synced campaign/ad set and a change | Compiles through `compileExecutionPlan`, runs the existing `executeTrustedPlan` (live re-read, guardrails, 20% budget limit, verified read-back) | Create anything in Meta; retry an uncertain mutation |
| Implementation task | `tracking`, `funnel` | One implementation-ready Kockpit task | Change tracking, CRM or site |
| Creative / copy task | `creative`, `copy` | One "Killer Kreative: …" task with angle, constraints, constants | Create or publish an ad |
| Implementation package | `campaign_structure`, `retargeting`, `audience` | Persists a structured launch package and creates a task from it | Create a campaign/ad set/ad/creative |
| Needs input | anything unresolved (target, action, budget that does not fit headroom) | Lists the smallest missing inputs; compiles again once supplied | Guess |

`started` means work was **handed to people**. Nothing here says "launched".

## Flow
1. **Approve & implement** → `prepareStrategyImplementation` (needs `paid_manage`): compiles a preview, stores a `prepared` row, no side effect.
2. **Confirm** → `confirmStrategyImplementation` (needs `paid_approve`): re-compiles from scratch (the browser sends only owner, due date, a budget amount to reserve and a target choice from the synced list), then `approve_paid_strategy_implementation()` claims it atomically (latest-run check, exactly-once, budget reservation), then the single side effect runs.

## Budget
Shared headroom = the run's projected incremental headroom − budget reserved by other in-flight implementations. Read inside the database from the run's own evidence.
Null/unreliable headroom ⇒ no incremental budget can be approved (a 0 DKK start still can). Reservations are released when the implementation is completed/cancelled/failed or its linked task is done/cancelled (spend is then visible in the projection). Platform increases reserve `Δ daily budget × remaining days`; resuming a paused campaign reserves its daily budget × remaining days.

## Idempotency and failure
`UNIQUE (strategy_run_id, recommendation_index)` + the claim function make a double click a no-op. A failed task creation is `failed` (no reservation, can be approved again). An uncertain platform outcome is `needs_attention`; it is never retried automatically and a later click does not mutate again.

## Audit
`audit_events`: `marketing.paid_strategy_implementation.{prepared,approved,started,executed,failed,needs_attention}` with actor, run, index, mode, budget, linked task and platform before/after. No secrets.

## Not in this version
No Meta campaign/ad set/ad/creative creation. Ad-set and ad status changes (not supported by the trusted compiler). Google. Older runs are read-only ("Superseded by newer strategy").

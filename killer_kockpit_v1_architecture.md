# Killer Koach — V1 Architecture Specification

## 1. Product principle

Killer Koach is the management operating system. It is not the source of truth for email, calendar or files.

- Google Workspace owns Gmail, Calendar, identities and Shared Drives.
- Killer Koach owns structured management data: tasks, projects, meetings, decisions, waiting-ons, People Memory and approvals.
- ChatGPT / Claude provide intelligence, extraction, summarisation and drafting.
- AI suggestions never become consequential permanent records without approval in V1.
- Every AI-created fact must retain a source reference.
- If AI or Google is temporarily unavailable, the core Killer Koach database must continue to work.

## 2. Proposed technical stack

### Frontend
- Next.js / React
- Responsive web app
- Installable as a PWA later if useful

### Database / backend
- PostgreSQL hosted on Supabase
- Row Level Security for permissions
- Server-side API routes for privileged actions
- Realtime subscriptions available where useful

### Authentication
- Google Workspace OAuth
- Only approved @killerkebab.com Workspace users can sign in
- Killer Koach has its own role model on top of Google identity

### Google integrations
- Gmail API
- Google Calendar API
- Google Drive API
- Google Meet / recording integration can be added later
- Database stores Google IDs / URLs, not duplicate copies of files

### AI
- Provider abstraction supporting OpenAI and Anthropic
- AI provider can be swapped per workflow
- Prompt/result provenance stored with every proposal
- AI cannot directly mutate permanent HR/decision/task records unless explicitly allowed by workflow

### Meeting audio
- Browser recording / uploaded audio initially
- Audio/transcript stored in a restricted location
- Transcript attached to meeting as a source
- AI extracts minutes, decisions and actions into the approval queue

## 3. V1 roles

### SUPER_ADMIN
System configuration, integrations, roles, audit, full access.

### UM
Upper Management. Access to all management objects, including restricted People Memory.

### MEMBER
Future role. Personal tasks/projects/calendar-facing views but no restricted People Memory.

V1 can launch with only SUPER_ADMIN and UM.

## 4. Core objects

### User
A Killer Koach login mapped 1:1 to a Google Workspace identity.

Key fields:
- id
- google_subject_id
- email
- display_name
- role
- active
- timezone

### Employee
A person Killer Kebab employs. They do not need a Killer Koach login.

Key fields:
- id
- name
- store / team
- role_title
- employment_status
- manager_employee_id
- linked_user_id (optional)

### Project
A meaningful body of work.

Key fields:
- id
- title
- description
- owner_user_id
- status: planned / active / at_risk / blocked / completed / archived
- start_date
- due_date
- progress
- parent_project_id (optional)

### Task
A concrete action with one accountable owner.

Key fields:
- id
- title
- description
- owner_user_id
- project_id
- status: proposed / open / in_progress / blocked / done / cancelled
- priority
- due_at
- completed_at
- created_by_user_id

### WaitingOn
A commitment or response expected from another person.

Examples:
- Lydia promised an update Friday.
- Landlord said they would respond Monday.
- Bjarke needs to confirm a decision.

Key fields:
- id
- title
- waiting_for_name / user / employee
- owner_user_id (person responsible for following up)
- project_id
- due_at
- status: open / fulfilled / overdue / cancelled
- source_id

### Decision
An authoritative management decision.

Key fields:
- id
- title
- decision_text
- decided_at
- decided_by / approved_by
- project_id
- meeting_id
- status: proposed / approved / superseded
- supersedes_decision_id

### Meeting
A management meeting.

Key fields:
- id
- title
- calendar_event_id
- scheduled_start/end
- actual_start/end
- status
- recording_url
- transcript_source_id
- minutes_status: none / draft / approved

### MeetingAttendee
Links meetings to users or external attendees.

### AgendaItem
A structured meeting agenda item.

Can originate from:
- manually added topic
- project update
- unresolved task
- waiting-on
- decision needed
- prior meeting action

### MeetingMinutes
One approved set of minutes per meeting, with version history.

### PeopleEntry
The structured People Memory record.

Key fields:
- id
- employee_id
- entry_type:
  - observation
  - manager_report
  - employee_statement
  - coaching
  - positive_feedback
  - concern
  - management_decision
  - formal_action
  - follow_up
- factual_summary
- occurred_at
- reported_by_user_id
- subject_employee_id
- status: proposed / approved / rejected / archived
- sensitivity_level
- source_id
- approved_by_user_id
- approved_at
- follow_up_due_at

Important: informal language is not stored as institutional fact. The original source may be retained, but the permanent structured entry uses neutral factual wording.

### Note
A lightweight management note that can later be linked to a project, meeting, employee or task.

### Source
The provenance layer.

Every AI-derived object can link back to one or more Sources.

Source types:
- gmail_message
- gmail_thread
- calendar_event
- drive_file
- meeting_transcript
- meeting_recording
- manual_note
- manual_entry

Key fields:
- external_id
- source_type
- title
- url
- occurred_at
- metadata

### EntitySource
Many-to-many bridge connecting a source to a Task, Decision, PeopleEntry, WaitingOn, Project, Meeting, etc.

### Proposal
The AI approval queue.

Proposal types:
- task
- decision
- waiting_on
- people_entry
- meeting_minutes
- agenda_item
- follow_up
- draft_reply

Fields:
- proposal_type
- payload_json
- source_ids
- generated_by_provider
- model
- confidence
- status: pending / approved / edited / rejected
- approved_by
- approved_at

### AuditEvent
Immutable log of significant system actions.

Captures:
- who
- what
- when
- before value
- after value
- whether human or AI initiated
- related object

## 5. Critical relationships

- User may optionally map to Employee.
- Project has many Tasks, Decisions, WaitingOns, Meetings and Sources.
- Meeting has many AgendaItems, Decisions, Proposals and Tasks.
- Employee has many PeopleEntries.
- Any management object can have many Sources.
- AI writes to Proposal first; approval creates or modifies the permanent object.
- AuditEvent records every consequential write.

## 6. AI approval rules

### AI may do automatically
- classify email
- summarise information
- suggest reply
- suggest task
- suggest waiting-on
- suggest decision
- suggest agenda item
- draft minutes
- identify an employee mention
- search approved company knowledge

### Human approval required in V1
- create a permanent PeopleEntry
- approve meeting minutes
- create/alter a management Decision
- create a Task from inferred text
- create a WaitingOn from inferred text
- change task ownership/deadline based on inference
- send email
- delete or archive permanent management records

Manual user-created tasks/notes do not require an additional approval.

## 7. People Memory boundaries

People Memory is restricted to authorised Upper Management.

Every entry should answer:
- What was reported/observed?
- Who reported it?
- When?
- What kind of statement is it?
- What is the original source?
- Was it approved?
- Is follow-up required?

Do not casually store sensitive personal information. Support documents stay in the restricted KK – People & HR Shared Drive; Killer Koach stores the structured management record plus Drive references.

## 8. Dependability requirements

### Visible sync state
The UI should expose:
- Gmail last synced
- Calendar last synced
- Drive connection status
- pending proposal count
- recording saved / transcription status

### Idempotency
The same Gmail message or calendar event must not create duplicate source records or duplicate proposals.

### Soft deletion
Permanent management objects should be archived/soft-deleted where possible, not silently erased.

### Auditability
Every consequential edit keeps actor + timestamp + previous/new value.

### Graceful degradation
If Google or AI APIs are offline:
- tasks/projects/decisions remain usable
- manual capture remains usable
- queued syncs retry later
- users can see that integrations are stale

## 9. Initial screens mapped to data

### Today
- own tasks
- meetings
- needs decision
- waiting on
- projects requiring attention
- team calendar status
- weekly brief

### Inbox
- Gmail-derived Sources
- AI classifications
- draft replies
- pending task/waiting-on proposals

### Projects
- Project
- Task
- WaitingOn
- Decision
- Source activity feed

### Team
- User + Calendar availability
- workload summary

### People
- Employee
- PeopleEntry
- People-related Sources
- pending PeopleEntry proposals

### Meetings
- Meeting
- AgendaItem
- transcript/recording Sources
- MeetingMinutes
- Decision/Task proposals

### Knowledge
- Search across approved structured data + authorised Google sources

## 10. V1 build order

1. Foundation
   - database
   - Google login
   - roles
   - audit layer
   - basic navigation

2. Tasks + Projects
   - CRUD
   - ownership
   - due dates
   - status
   - universal capture
   - personal vs management views

3. Meetings
   - calendar link
   - agendas
   - recording/transcript upload
   - minutes
   - extract proposed actions and decisions
   - approval workflow

4. People Memory
   - employee profiles
   - timeline
   - restricted access
   - proposed entry workflow
   - source provenance

5. Waiting On + Decisions
   - dedicated queues
   - link to meetings/projects
   - automatic reappearance in agenda

6. Google integrations
   - Calendar
   - Gmail read/search
   - Drive search
   - source creation + sync status

7. AI layer
   - provider abstraction
   - proposal generation
   - knowledge queries
   - summaries/drafts

8. Reliability pass
   - audit UI
   - sync retries
   - duplicate prevention
   - permission tests
   - backup / restore
   - onboarding

## 11. Scope explicitly deferred

Not V1:
- restaurant revenue / P&L
- labour %
- food cost
- quality/compliance scores
- store performance dashboards
- maintenance
- suppliers
- POS integrations
- HR payroll / leave balances
- automatic disciplinary decisions

Those become Phase 2 only after the V1 operating system proves dependable and easy to use.
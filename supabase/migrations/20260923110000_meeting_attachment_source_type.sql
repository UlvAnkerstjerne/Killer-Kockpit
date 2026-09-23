-- 20260923110000_meeting_attachment_source_type.sql
--
-- Adds 'meeting_attachment' to the source_type enum so that plain-text
-- documents (agendas, written minutes, briefing notes) uploaded directly to a
-- meeting can be stored in sources.content and retrieved by the Brain.
--
-- No application-code changes are required to existing source_type consumers
-- because the enum value is additive; the new value is gated by source_type
-- checks in the meeting-attachments server action.

ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'meeting_attachment';

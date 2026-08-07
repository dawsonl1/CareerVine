-- CAR-242 (2 of 2) — the CONTRACT half: backfill the retired vocabulary, then
-- constrain both columns to the shared five.
--
-- ⚠ APPLY THIS ONLY AFTER THE CAR-242 BUILD IS LIVE. Its constraints reject
-- `phone` / `video` / `in-person` / `lunch` / `conference`, which the previous
-- release still writes. See 20260807020000_car242_conversation_type_detail_columns.sql
-- for the full expand-then-contract rationale (rule 42).
--
-- Before CAR-242, `meetings.meeting_type`, `interactions.interaction_type` and
-- the MCP `log_interaction` enum were three disjoint lists agreeing on only
-- `coffee` and `other`, with NO CHECK on either column. After it both carry a
-- CHECK over one vocabulary:
--
--   career-fair | networking | coffee | text | other      (user-selectable)
--   + email                                               (interactions only, system-written)
--
-- `coffee` is the one-on-one-conversation bucket REGARDLESS OF MEDIUM, so
-- `phone` and `video` fold into it rather than into `other`.

-- ── Backfill ─────────────────────────────────────────────────────────────────
--
-- MUST precede the constraints: production held 7 `phone` and 4 `video` meeting
-- rows that the new CHECK rejects.
--
-- Retired values map by MEANING, not by name: phone/video/in-person/lunch were
-- all one-on-one conversations, so they become `coffee`; conference/event were
-- group gatherings, so they become `networking`. A value with no honest home
-- lands on `other` carrying a readable label, and anything unrecognized is
-- preserved verbatim rather than discarded — including the malformed
-- 'coffee chat' (with a space) that no picker could ever have produced.
--
-- Both SET expressions read the PRE-UPDATE row, so the detail CASE sees the old
-- type. Keep the two CASEs in lockstep: a value the first routes to `other`
-- must be spelled identically in the second.

UPDATE meetings
SET meeting_type = CASE lower(btrim(meeting_type))
      WHEN 'phone'       THEN 'coffee'
      WHEN 'video'       THEN 'coffee'
      WHEN 'in-person'   THEN 'coffee'
      WHEN 'in_person'   THEN 'coffee'
      WHEN 'lunch'       THEN 'coffee'
      WHEN 'call'        THEN 'coffee'
      WHEN 'meeting'     THEN 'coffee'
      WHEN 'coffee chat' THEN 'coffee'
      WHEN 'coffee'      THEN 'coffee'
      WHEN 'conference'  THEN 'networking'
      WHEN 'event'       THEN 'networking'
      WHEN 'networking'  THEN 'networking'
      WHEN 'career fair' THEN 'career-fair'
      WHEN 'careerfair'  THEN 'career-fair'
      WHEN 'career-fair' THEN 'career-fair'
      WHEN 'sms'         THEN 'text'
      WHEN 'text'        THEN 'text'
      ELSE 'other'
    END,
    meeting_type_detail = CASE lower(btrim(meeting_type))
      -- Mapped cleanly onto a surviving type: nothing left to preserve.
      WHEN 'phone'       THEN NULL
      WHEN 'video'       THEN NULL
      WHEN 'in-person'   THEN NULL
      WHEN 'in_person'   THEN NULL
      WHEN 'lunch'       THEN NULL
      WHEN 'call'        THEN NULL
      WHEN 'meeting'     THEN NULL
      WHEN 'coffee chat' THEN NULL
      WHEN 'coffee'      THEN NULL
      WHEN 'conference'  THEN NULL
      WHEN 'event'       THEN NULL
      WHEN 'networking'  THEN NULL
      WHEN 'career fair' THEN NULL
      WHEN 'careerfair'  THEN NULL
      WHEN 'career-fair' THEN NULL
      WHEN 'sms'         THEN NULL
      WHEN 'text'        THEN NULL
      WHEN 'other'       THEN NULL
      -- Retired with no honest home: keep a readable label under Other.
      WHEN 'social'      THEN 'Social media'
      ELSE left(btrim(meeting_type), 80)
    END
WHERE meeting_type IS NOT NULL;

UPDATE interactions
SET interaction_type = CASE lower(btrim(interaction_type))
      -- System-written by the email send path; stays a first-class value.
      WHEN 'email'       THEN 'email'
      WHEN 'phone'       THEN 'coffee'
      WHEN 'video'       THEN 'coffee'
      WHEN 'in-person'   THEN 'coffee'
      WHEN 'in_person'   THEN 'coffee'
      WHEN 'lunch'       THEN 'coffee'
      WHEN 'call'        THEN 'coffee'
      WHEN 'meeting'     THEN 'coffee'
      WHEN 'coffee chat' THEN 'coffee'
      WHEN 'coffee'      THEN 'coffee'
      WHEN 'conference'  THEN 'networking'
      WHEN 'event'       THEN 'networking'
      WHEN 'networking'  THEN 'networking'
      WHEN 'career fair' THEN 'career-fair'
      WHEN 'careerfair'  THEN 'career-fair'
      WHEN 'career-fair' THEN 'career-fair'
      WHEN 'sms'         THEN 'text'
      WHEN 'text'        THEN 'text'
      ELSE 'other'
    END,
    interaction_type_detail = CASE lower(btrim(interaction_type))
      WHEN 'email'       THEN NULL
      WHEN 'phone'       THEN NULL
      WHEN 'video'       THEN NULL
      WHEN 'in-person'   THEN NULL
      WHEN 'in_person'   THEN NULL
      WHEN 'lunch'       THEN NULL
      WHEN 'call'        THEN NULL
      WHEN 'meeting'     THEN NULL
      WHEN 'coffee chat' THEN NULL
      WHEN 'coffee'      THEN NULL
      WHEN 'conference'  THEN NULL
      WHEN 'event'       THEN NULL
      WHEN 'networking'  THEN NULL
      WHEN 'career fair' THEN NULL
      WHEN 'careerfair'  THEN NULL
      WHEN 'career-fair' THEN NULL
      WHEN 'sms'         THEN NULL
      WHEN 'text'        THEN NULL
      WHEN 'other'       THEN NULL
      WHEN 'social'      THEN 'Social media'
      ELSE left(btrim(interaction_type), 80)
    END;

-- ── Constraints ──────────────────────────────────────────────────────────────
--
-- meeting_type is nullable (CAR-122 made bare calendar events untyped) and the
-- CHECK deliberately carries no `IS NULL OR` guard: a NULL operand makes the
-- comparison NULL, and a CHECK fails only on FALSE, so NULLs already pass. The
-- defensive spelling would render as `(meeting_type IS NULL OR meeting_type =
-- ANY ...)`, which the conformance guard's parser cannot read.

ALTER TABLE meetings
  ADD CONSTRAINT meetings_meeting_type_check
  CHECK (meeting_type IN ('career-fair', 'networking', 'coffee', 'text', 'other'));

ALTER TABLE interactions
  ADD CONSTRAINT interactions_interaction_type_check
  CHECK (interaction_type IN ('career-fair', 'networking', 'coffee', 'text', 'other', 'email'));

-- The detail is meaningless unless the type is 'other', so make that an
-- invariant rather than trusting every write path to clear it on switch-away.
ALTER TABLE meetings
  ADD CONSTRAINT meetings_meeting_type_detail_check
  CHECK (
    meeting_type_detail IS NULL
    OR (meeting_type = 'other' AND char_length(meeting_type_detail) BETWEEN 1 AND 80)
  );

ALTER TABLE interactions
  ADD CONSTRAINT interactions_interaction_type_detail_check
  CHECK (
    interaction_type_detail IS NULL
    OR (interaction_type = 'other' AND char_length(interaction_type_detail) BETWEEN 1 AND 80)
  );

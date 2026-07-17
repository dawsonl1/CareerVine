


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."append_contact_note"("p_contact_id" integer, "p_note" "text") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  UPDATE contacts
  SET notes = CASE
    WHEN notes IS NULL OR notes = '' THEN p_note
    ELSE notes || E'\n\n' || p_note
  END
  WHERE id = p_contact_id;
$$;


ALTER FUNCTION "public"."append_contact_note"("p_contact_id" integer, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_bundle_resolutions"("p_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  updated_count int;
BEGIN
  UPDATE bundle_prospects bp
  SET resolved = r.resolved,
      resolved_at = now(),
      updated_at = now()
  FROM jsonb_to_recordset(p_rows) AS r(id int, resolved jsonb)
  WHERE bp.id = r.id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;


ALTER FUNCTION "public"."apply_bundle_resolutions"("p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bundle_alumni_stats"("p_bundle_id" integer) RETURNS TABLE("alumni_count" bigint, "alumni_product_count" bigint, "alumni_company_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH alum AS (
    SELECT bp.payload
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND EXISTS (
        SELECT 1 FROM data_bundles db
        WHERE db.id = p_bundle_id
          AND db.status = 'published'
          AND bundle_visible_to(db.id, auth.uid())
      )
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(bp.payload->'education') edu
        WHERE lower(edu->>'school_name') LIKE '%brigham young%'
           OR lower(edu->>'school_name') LIKE 'byu%'
      )
  )
  SELECT
    (SELECT count(*) FROM alum) AS alumni_count,
    (SELECT count(*) FROM alum
      WHERE alum.payload->>'persona' IN ('alum_product', 'product_leader', 'product_peer')
    ) AS alumni_product_count,
    -- "N of the bundle's companies have a BYU alum there today": the
    -- payload's current_company is CANON-mapped to the same names as the
    -- bundle company list, so a case-insensitive name match is exact by
    -- construction (raw experience employer names would NOT be).
    (SELECT count(DISTINCT co.id)
       FROM bundle_companies bc
       JOIN companies co ON co.id = bc.company_id
      WHERE bc.bundle_id = p_bundle_id
        AND lower(btrim(co.name)) IN (
          SELECT lower(btrim(a.payload->>'current_company'))
          FROM alum a
          WHERE a.payload->>'current_company' IS NOT NULL
        )
    ) AS alumni_company_count;
$$;


ALTER FUNCTION "public"."bundle_alumni_stats"("p_bundle_id" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."bundle_alumni_stats"("p_bundle_id" integer) IS 'Aggregate BYU-alumni counts (total, product-role, bundle companies with a current alum) for a published, visible bundle — CAR-50/CAR-61 onboarding stats. SECURITY DEFINER with the browse-visibility gate inlined; exposes counts only.';



CREATE OR REPLACE FUNCTION "public"."bundle_company_stats"("p_bundle_id" integer) RETURNS TABLE("company_id" integer, "name" "text", "logo_url" "text", "prospect_count" bigint, "alumni_count" bigint, "product_alumni_count" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  WITH live AS (
    SELECT
      lower(btrim(bp.payload->>'current_company')) AS cname,
      EXISTS (
        -- Mirrors isByuSchoolName() (company-queries.ts) and CAR-61's stats:
        -- contains "brigham young" or starts with "byu", case-insensitive.
        SELECT 1 FROM jsonb_array_elements(bp.payload->'education') edu
        WHERE lower(edu->>'school_name') LIKE '%brigham young%'
           OR lower(edu->>'school_name') LIKE 'byu%'
      ) AS is_alum,
      bp.payload->>'persona' IN ('alum_product', 'product_leader', 'product_peer') AS is_product
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND bp.payload->>'current_company' IS NOT NULL
  ),
  stats AS (
    SELECT
      live.cname,
      count(*) AS prospect_count,
      count(*) FILTER (WHERE live.is_alum) AS alumni_count,
      count(*) FILTER (WHERE live.is_alum AND live.is_product) AS product_alumni_count
    FROM live
    GROUP BY live.cname
  )
  SELECT
    co.id,
    co.name,
    co.logo_url,
    COALESCE(s.prospect_count, 0),
    COALESCE(s.alumni_count, 0),
    COALESCE(s.product_alumni_count, 0)
  FROM bundle_companies bc
  JOIN companies co ON co.id = bc.company_id
  LEFT JOIN stats s ON s.cname = lower(btrim(co.name))
  WHERE bc.bundle_id = p_bundle_id;
$$;


ALTER FUNCTION "public"."bundle_company_stats"("p_bundle_id" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."bundle_company_stats"("p_bundle_id" integer) IS 'Per-company prospect/BYU-alumni/product-role counts for a bundle, from bundle-level data (CAR-77 onboarding picker). SECURITY INVOKER; subscriber-only RLS on the underlying tables applies.';



CREATE OR REPLACE FUNCTION "public"."bundle_visible_to"("p_bundle_id" integer, "p_user" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM bundle_access_overrides o
      WHERE o.bundle_id = p_bundle_id AND o.user_id = p_user AND o.allowed = false
    ) THEN false
    WHEN EXISTS (
      SELECT 1 FROM bundle_access_overrides o
      WHERE o.bundle_id = p_bundle_id AND o.user_id = p_user AND o.allowed = true
    ) THEN true
    ELSE COALESCE((SELECT b.default_visible FROM data_bundles b WHERE b.id = p_bundle_id), false)
  END;
$$;


ALTER FUNCTION "public"."bundle_visible_to"("p_bundle_id" integer, "p_user" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."bundle_visible_to"("p_bundle_id" integer, "p_user" "uuid") IS 'Effective bundle visibility for a user: explicit override wins (deny beats grant), else the bundle default. Used by the bundle RLS policies.';



CREATE OR REPLACE FUNCTION "public"."delete_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  DELETE FROM pipeline_cycles
  WHERE target_company_id = p_target_company_id AND cycle_number = p_cycle_number;

  -- Renumber without transient unique violations: park the higher cycles
  -- on negative numbers, then land them one lower than they started.
  UPDATE pipeline_cycles
  SET cycle_number = -cycle_number
  WHERE target_company_id = p_target_company_id AND cycle_number > p_cycle_number;

  UPDATE pipeline_cycles
  SET cycle_number = -cycle_number - 1
  WHERE target_company_id = p_target_company_id AND cycle_number < 0;

  UPDATE target_companies
  SET active_cycle = GREATEST(1, LEAST(
        active_cycle - CASE WHEN active_cycle >= p_cycle_number THEN 1 ELSE 0 END,
        GREATEST((SELECT COALESCE(MAX(cycle_number), 1) FROM pipeline_cycles WHERE target_company_id = p_target_company_id), 1)
      ))
  WHERE id = p_target_company_id;
END;
$$;


ALTER FUNCTION "public"."delete_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.users (id, first_name, last_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    new.email
  )
  on conflict (id) do nothing;

  -- CAR-80: mark internal accounts so analytics excludes them. Email-derived, so it
  -- survives delete/recreate; mirrored into app_metadata for the client/extension check.
  if public.is_internal_email(new.email) then
    update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object('is_internal', true)
    where id = new.id;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_internal_email"("p_email" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p_email is not null and (
    lower(p_email) like '%@careervine.app'
    or exists (
      select 1 from public.internal_analytics_emails e
      where e.email = lower(p_email)
    )
  );
$$;


ALTER FUNCTION "public"."is_internal_email"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."latest_contact_snapshots"("p_contact_ids" integer[]) RETURNS TABLE("contact_id" integer, "snapshot" "jsonb")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT DISTINCT ON (s.contact_id) s.contact_id, s.snapshot
  FROM contact_scrape_snapshots s
  WHERE s.contact_id = ANY(p_contact_ids)
  ORDER BY s.contact_id, s.scraped_at DESC;
$$;


ALTER FUNCTION "public"."latest_contact_snapshots"("p_contact_ids" integer[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."network_tier_counts"() RETURNS TABLE("active" bigint, "prospect" bigint, "bench" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select
    count(*) filter (where network_status = 'active')   as active,
    count(*) filter (where network_status = 'prospect') as prospect,
    count(*) filter (where network_status = 'bench')    as bench
  from public.contacts
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."network_tier_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_transcript_segments"("p_meeting_id" integer, "p_segments" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Delete existing segments
  DELETE FROM transcript_segments WHERE meeting_id = p_meeting_id;

  -- Insert new segments from JSON array
  INSERT INTO transcript_segments (meeting_id, ordinal, speaker_label, contact_id, started_at, ended_at, content)
  SELECT
    p_meeting_id,
    (elem->>'ordinal')::INTEGER,
    elem->>'speaker_label',
    NULLIF(elem->>'contact_id', '')::INTEGER,
    NULLIF(elem->>'started_at', '')::REAL,
    NULLIF(elem->>'ended_at', '')::REAL,
    elem->>'content'
  FROM jsonb_array_elements(p_segments) AS elem;
END;
$$;


ALTER FUNCTION "public"."replace_transcript_segments"("p_meeting_id" integer, "p_segments" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer, "p_payload" "jsonb") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_cycle_id int;
BEGIN
  INSERT INTO pipeline_cycles (target_company_id, cycle_number, selected_stage, declined_next_cycle, updated_at)
  VALUES (
    p_target_company_id,
    p_cycle_number,
    COALESCE(p_payload->>'selected_stage', 'researching'),
    COALESCE((p_payload->>'declined_next_cycle')::boolean, false),
    now()
  )
  ON CONFLICT (target_company_id, cycle_number) DO UPDATE SET
    selected_stage = EXCLUDED.selected_stage,
    declined_next_cycle = EXCLUDED.declined_next_cycle,
    updated_at = now()
  RETURNING id INTO v_cycle_id;

  -- programs
  DELETE FROM pipeline_programs
  WHERE cycle_id = v_cycle_id
    AND id NOT IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'programs', '[]'::jsonb)) e);
  INSERT INTO pipeline_programs (id, cycle_id, name, apps_open, job_potential, position)
  SELECT (e->>'id')::uuid, v_cycle_id,
         COALESCE(e->>'name', ''), COALESCE(e->>'apps_open', ''), COALESCE(e->>'job_potential', ''),
         ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'programs', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, apps_open = EXCLUDED.apps_open,
    job_potential = EXCLUDED.job_potential, position = EXCLUDED.position;

  -- notes
  DELETE FROM pipeline_notes
  WHERE cycle_id = v_cycle_id
    AND id NOT IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'notes', '[]'::jsonb)) e);
  INSERT INTO pipeline_notes (id, cycle_id, body, position)
  SELECT (e->>'id')::uuid, v_cycle_id, COALESCE(e->>'body', ''), ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'notes', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, position = EXCLUDED.position;

  -- applications
  DELETE FROM pipeline_applications
  WHERE cycle_id = v_cycle_id
    AND id NOT IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'applications', '[]'::jsonb)) e);
  INSERT INTO pipeline_applications (
    id, cycle_id, job_title, location, date_applied,
    resume_path, resume_name, resume_size_bytes,
    cover_letter_path, cover_letter_name, cover_letter_size_bytes, position
  )
  SELECT (e->>'id')::uuid, v_cycle_id,
         COALESCE(e->>'job_title', ''), COALESCE(e->>'location', ''),
         NULLIF(e->>'date_applied', '')::date,
         e->>'resume_path', e->>'resume_name', (e->>'resume_size_bytes')::int,
         e->>'cover_letter_path', e->>'cover_letter_name', (e->>'cover_letter_size_bytes')::int,
         ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'applications', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET
    job_title = EXCLUDED.job_title, location = EXCLUDED.location,
    date_applied = EXCLUDED.date_applied,
    resume_path = EXCLUDED.resume_path, resume_name = EXCLUDED.resume_name,
    resume_size_bytes = EXCLUDED.resume_size_bytes,
    cover_letter_path = EXCLUDED.cover_letter_path, cover_letter_name = EXCLUDED.cover_letter_name,
    cover_letter_size_bytes = EXCLUDED.cover_letter_size_bytes,
    position = EXCLUDED.position;

  -- interview rounds
  DELETE FROM pipeline_interview_rounds
  WHERE cycle_id = v_cycle_id
    AND id NOT IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'interview_rounds', '[]'::jsonb)) e);
  INSERT INTO pipeline_interview_rounds (id, cycle_id, interview_date, interviewer, questions, position)
  SELECT (e->>'id')::uuid, v_cycle_id,
         NULLIF(e->>'interview_date', '')::date,
         COALESCE(e->>'interviewer', ''), COALESCE(e->>'questions', ''),
         ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'interview_rounds', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET
    interview_date = EXCLUDED.interview_date, interviewer = EXCLUDED.interviewer,
    questions = EXCLUDED.questions, position = EXCLUDED.position;

  RETURN v_cycle_id;
END;
$$;


ALTER FUNCTION "public"."save_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer, "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sum_scrape_spend"("p_user_id" "uuid", "p_since" timestamp with time zone) RETURNS numeric
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COALESCE(SUM(cost_usd), 0)::numeric
  FROM scrape_runs
  WHERE user_id = p_user_id AND created_at >= p_since;
$$;


ALTER FUNCTION "public"."sum_scrape_spend"("p_user_id" "uuid", "p_since" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sum_scrape_spend_mode"("p_user_id" "uuid", "p_since" timestamp with time zone, "p_mode" "text") RETURNS numeric
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COALESCE(SUM(cost_usd), 0)::numeric
  FROM scrape_runs
  WHERE user_id = p_user_id AND created_at >= p_since AND mode = p_mode;
$$;


ALTER FUNCTION "public"."sum_scrape_spend_mode"("p_user_id" "uuid", "p_since" timestamp with time zone, "p_mode" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_company_alumni_counts"() RETURNS TABLE("company_id" integer, "alumni_count" bigint, "product_alumni_count" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT
    cc.company_id,
    count(DISTINCT c.id) AS alumni_count,
    count(DISTINCT c.id) FILTER (
      WHERE c.persona IN ('alum_product', 'product_leader', 'product_peer')
    ) AS product_alumni_count
  FROM contact_companies cc
  JOIN contacts c ON c.id = cc.contact_id
    AND c.user_id = auth.uid()
    -- Bench is excluded everywhere "current contacts" are counted.
    AND c.network_status <> 'bench'
  WHERE cc.is_current
    AND EXISTS (
      SELECT 1
      FROM contact_schools cs
      JOIN schools s ON s.id = cs.school_id
      WHERE cs.contact_id = c.id
        AND (lower(s.name) LIKE '%brigham young%' OR lower(s.name) LIKE 'byu%')
    )
  GROUP BY cc.company_id;
$$;


ALTER FUNCTION "public"."user_company_alumni_counts"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."user_company_alumni_counts"() IS 'Per-company counts of the calling user''s current BYU-alumni contacts — total and product-role (persona-based) — for the CAR-50 onboarding picker. SECURITY INVOKER; RLS applies.';



CREATE OR REPLACE FUNCTION "public"."user_is_internal"("uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(
    public.is_internal_email((select email from auth.users where id = uid)),
    false
  );
$$;


ALTER FUNCTION "public"."user_is_internal"("uid" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."action_item_contacts" (
    "id" bigint NOT NULL,
    "action_item_id" bigint NOT NULL,
    "contact_id" bigint NOT NULL
);


ALTER TABLE "public"."action_item_contacts" OWNER TO "postgres";


ALTER TABLE "public"."action_item_contacts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."action_item_contacts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."admin_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "admin_id" "uuid" NOT NULL,
    "target_user_id" "uuid",
    "action" "text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "outcome" "text" DEFAULT 'ok'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_audit_log_outcome_check" CHECK (("outcome" = ANY (ARRAY['ok'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."admin_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."admin_audit_log" IS 'Append-only trail of admin actions on user accounts. Written via the service role from lib/admin.ts writeAudit(). No FKs by design — rows survive account deletion.';



CREATE TABLE IF NOT EXISTS "public"."ai_follow_up_drafts" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "contact_id" integer NOT NULL,
    "recipient_email" character varying,
    "subject" character varying NOT NULL,
    "body_html" "text" NOT NULL,
    "reply_thread_id" character varying,
    "reply_thread_subject" character varying,
    "send_as_reply" boolean DEFAULT false NOT NULL,
    "extracted_topic" "text" NOT NULL,
    "topic_evidence" "text" NOT NULL,
    "source_meeting_id" integer,
    "article_url" character varying,
    "article_title" character varying,
    "article_source" character varying,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "dismissed_at" timestamp with time zone,
    CONSTRAINT "ai_follow_up_drafts_body_html_check" CHECK (("length"("body_html") < 50000)),
    CONSTRAINT "ai_follow_up_drafts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'dismissed'::"text", 'edited_and_sent'::"text"])))
);


ALTER TABLE "public"."ai_follow_up_drafts" OWNER TO "postgres";


ALTER TABLE "public"."ai_follow_up_drafts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."ai_follow_up_drafts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."analytics_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "event" "text" NOT NULL,
    "surface" "text" DEFAULT 'server'::"text" NOT NULL,
    "properties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."analytics_events" OWNER TO "postgres";


ALTER TABLE "public"."analytics_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."analytics_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."attachments" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "bucket" character varying NOT NULL,
    "object_path" character varying NOT NULL,
    "file_name" character varying NOT NULL,
    "content_type" character varying,
    "file_size_bytes" bigint,
    "is_public" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone
);


ALTER TABLE "public"."attachments" OWNER TO "postgres";


ALTER TABLE "public"."attachments" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."attachments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bundle_access_overrides" (
    "user_id" "uuid" NOT NULL,
    "bundle_id" integer NOT NULL,
    "allowed" boolean NOT NULL,
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bundle_access_overrides" OWNER TO "postgres";


COMMENT ON TABLE "public"."bundle_access_overrides" IS 'Per-account bundle visibility override. allowed=true grants a hidden bundle; allowed=false hides a default-visible one. Absence = data_bundles.default_visible. Service-role write only.';



CREATE TABLE IF NOT EXISTS "public"."bundle_companies" (
    "id" integer NOT NULL,
    "bundle_id" integer NOT NULL,
    "company_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "version_last_seen" integer
);


ALTER TABLE "public"."bundle_companies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."bundle_companies"."version_last_seen" IS 'Staging version of the last publish run that included this company; rows not stamped by the current run are deleted at finalize (CAR-63).';



ALTER TABLE "public"."bundle_companies" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."bundle_companies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bundle_contact_state" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "contact_id" integer NOT NULL,
    "applied_fingerprint" "text",
    "user_touched" boolean DEFAULT false NOT NULL,
    "apply_started_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bundle_contact_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."bundle_contact_state" IS 'Shared across ALL of a user''s subscriptions: fingerprint baseline + sticky user_touched flag that gates bundle-driven contact deletion. Deterministic by design — no timestamp heuristics anywhere near a delete decision.';



COMMENT ON COLUMN "public"."bundle_contact_state"."applied_fingerprint" IS 'Hash of the user-editable surface captured after the last bundle apply (computed from the pre-apply snapshot + merge results, never re-read). Drift at the next pre-apply check means the user edited the contact.';



COMMENT ON COLUMN "public"."bundle_contact_state"."user_touched" IS 'Sticky: once true, bundle machinery never deletes this contact. Set when fingerprint drift is detected outside an interrupted-apply recovery.';



COMMENT ON COLUMN "public"."bundle_contact_state"."apply_started_at" IS 'In-flight marker. If set when a sync begins, the prior apply crashed mid-write: refresh the baseline WITHOUT promoting drift to touched (a one-run false negative beats a permanent false positive).';



ALTER TABLE "public"."bundle_contact_state" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."bundle_contact_state_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bundle_prospects" (
    "id" integer NOT NULL,
    "bundle_id" integer NOT NULL,
    "linkedin_url" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "payload_schema_version" integer DEFAULT 1 NOT NULL,
    "payload_hash" "text" NOT NULL,
    "version_added" integer NOT NULL,
    "version_updated" integer NOT NULL,
    "version_last_seen" integer NOT NULL,
    "removed_in_version" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved" "jsonb",
    "resolved_at" timestamp with time zone
);


ALTER TABLE "public"."bundle_prospects" OWNER TO "postgres";


COMMENT ON TABLE "public"."bundle_prospects" IS 'One row per prospect per bundle. payload is a CareerVine-owned BundleProspectPayloadV1 (never a scraper-native format); linkedin_url is canonical.';



COMMENT ON COLUMN "public"."bundle_prospects"."payload_schema_version" IS 'Payload contract version. Sync skips-and-reports unknown versions instead of crashing, so future contracts can roll out gradually.';



COMMENT ON COLUMN "public"."bundle_prospects"."payload_hash" IS 'sha256 of the canonical payload JSON — cheap change detection so re-publishing identical data causes zero version churn.';



COMMENT ON COLUMN "public"."bundle_prospects"."version_updated" IS 'Bumped when payload_hash changes. Subscriber apply delta: version_updated > synced_version AND version_updated <= pinned committed version.';



COMMENT ON COLUMN "public"."bundle_prospects"."version_last_seen" IS 'Bumped every publish the prospect appears in; finalize soft-removes rows not seen in the staging version.';



COMMENT ON COLUMN "public"."bundle_prospects"."removed_in_version" IS 'Soft delete for delta sync (NULL = live). Re-adding a prospect clears it.';



COMMENT ON COLUMN "public"."bundle_prospects"."resolved" IS 'Publish-time entity resolution snapshot (CAR-62): { payload_hash, profile_location_id, experiences: [{company_id, location_id, location_source}], education: [{school_id}] }, positionally aligned with payload.experiences/payload.education. payload_hash mismatch = stale (re-resolved on next publish); readers then fall back to live resolution.';



COMMENT ON COLUMN "public"."bundle_prospects"."resolved_at" IS 'When the resolution snapshot was last written.';



ALTER TABLE "public"."bundle_prospects" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."bundle_prospects_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bundle_subscription_contacts" (
    "id" integer NOT NULL,
    "subscription_id" integer NOT NULL,
    "contact_id" integer NOT NULL,
    "bundle_prospect_id" integer,
    "linkedin_url" "text" NOT NULL,
    "created_by_bundle" boolean NOT NULL,
    "first_applied_version" integer NOT NULL,
    "last_applied_version" integer NOT NULL,
    "last_applied_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bundle_subscription_contacts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."bundle_subscription_contacts"."bundle_prospect_id" IS 'Durable removal-correlation key: contacts.linkedin_url can be rewritten (canonical upgrades) or user-edited, so removal matching must not depend on it.';



COMMENT ON COLUMN "public"."bundle_subscription_contacts"."linkedin_url" IS 'Canonical URL at apply time — debugging aid and secondary correlation key.';



COMMENT ON COLUMN "public"."bundle_subscription_contacts"."created_by_bundle" IS 'true = importPeopleChunk created the contact for this bundle (deletable on unsubscribe/removal if untouched and no sibling subscription links it); false = merged into a pre-existing contact (never deleted by bundle machinery).';



ALTER TABLE "public"."bundle_subscription_contacts" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."bundle_subscription_contacts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bundle_subscriptions" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "bundle_id" integer NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "synced_version" integer DEFAULT 0 NOT NULL,
    "last_synced_at" timestamp with time zone,
    "sync_claimed_until" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sync_cursor" "jsonb",
    "unsubscribe_keep_all" boolean,
    CONSTRAINT "bundle_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'unsubscribed'::"text"])))
);


ALTER TABLE "public"."bundle_subscriptions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."bundle_subscriptions"."status" IS 'unsubscribed rows are kept (UNIQUE holds, history survives, resubscribe is a status flip). Sync never runs for unsubscribed rows.';



COMMENT ON COLUMN "public"."bundle_subscriptions"."synced_version" IS 'Last FULLY applied bundle version; advances only to the version pinned at sync start, only when both apply and removal phases complete. Reset to 0 on resubscribe (idempotent full re-apply).';



COMMENT ON COLUMN "public"."bundle_subscriptions"."sync_claimed_until" IS 'Serialization claim: sync drivers (fan-out worker, cron, opportunistic, user-driven apply) take this atomically before applying, so concurrent syncs cannot race the fingerprint bookkeeping.';



COMMENT ON COLUMN "public"."bundle_subscriptions"."sync_cursor" IS 'Mid-sync checkpoint {phase, afterId, pinnedVersion}, written after each applied chunk and cleared when the sync commits (or on resubscribe reset). Lets the worker/cron resume an interrupted sync instead of re-scanning from chunk 0.';



COMMENT ON COLUMN "public"."bundle_subscriptions"."unsubscribe_keep_all" IS 'Pending unsubscribe cleanup intent (true = keep all contacts / drop linkage, false = remove untouched bundle-created contacts). Set when an unsubscribe starts, cleared when its removal loop completes; non-null on an unsubscribed row means cleanup is unfinished and the worker/cron may resume it.';



ALTER TABLE "public"."bundle_subscriptions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."bundle_subscriptions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."calendar_event_contacts" (
    "calendar_event_id" bigint NOT NULL,
    "contact_id" integer NOT NULL
);


ALTER TABLE "public"."calendar_event_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "google_event_id" "text" NOT NULL,
    "calendar_id" "text" DEFAULT 'primary'::"text" NOT NULL,
    "title" "text",
    "description" "text",
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone NOT NULL,
    "all_day" boolean DEFAULT false,
    "location" "text",
    "meet_link" "text",
    "zoom_link" "text",
    "status" "text",
    "attendees" "jsonb",
    "is_private" boolean DEFAULT false,
    "recurring_event_id" "text",
    "contact_id" integer,
    "meeting_id" integer,
    "source_gmail_thread_id" "text",
    "source_gmail_message_id" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."calendar_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."calendar_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."calendar_events_id_seq" OWNED BY "public"."calendar_events"."id";



CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" integer NOT NULL,
    "name" character varying NOT NULL,
    "linkedin_company_id" "text",
    "linkedin_url" "text",
    "universal_name" "text",
    "logo_url" "text",
    "name_normalized" "text" GENERATED ALWAYS AS ("regexp_replace"("btrim"("regexp_replace"("lower"(("name")::"text"), '[^a-z0-9]+'::"text", ' '::"text", 'g'::"text")), '( (inc|incorporated|llc|llp|ltd|limited|corp|corporation|co|company|lp|plc|gmbh|pllc))+$'::"text", ''::"text")) STORED
);


ALTER TABLE "public"."companies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."companies"."linkedin_company_id" IS 'Stable LinkedIn numeric company id (from experience[].companyId) — primary join key for scraped data';



COMMENT ON COLUMN "public"."companies"."universal_name" IS 'LinkedIn company slug (e.g., "google")';



COMMENT ON COLUMN "public"."companies"."name_normalized" IS 'Normalized matching key (case/punctuation/legal-suffix-insensitive). Expression must stay in sync with normalizeCompanyName() in careervine/src/lib/company-helpers.ts';



ALTER TABLE "public"."companies" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."companies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."company_locations" (
    "id" integer NOT NULL,
    "company_id" integer NOT NULL,
    "location_id" integer NOT NULL,
    "source" "text" DEFAULT 'scraped'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "company_locations_source_check" CHECK (("source" = ANY (ARRAY['scraped'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."company_locations" OWNER TO "postgres";


COMMENT ON TABLE "public"."company_locations" IS 'Known office locations per company. Rows established automatically by import rule 1 (experience-level locations) or seeded manually; anchor for location-scoped recruiting intel.';



ALTER TABLE "public"."company_locations" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."company_locations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_attachments" (
    "contact_id" integer NOT NULL,
    "attachment_id" integer NOT NULL
);


ALTER TABLE "public"."contact_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_change_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "contact_id" integer NOT NULL,
    "type" "text" NOT NULL,
    "tier" smallint DEFAULT 2 NOT NULL,
    "dedupe_key" "text" NOT NULL,
    "headline" "text" NOT NULL,
    "evidence" "text",
    "suggested_title" "text",
    "suggested_description" "text",
    "old_value" "jsonb",
    "new_value" "jsonb",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "snoozed_until" timestamp with time zone,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actioned_at" timestamp with time zone,
    CONSTRAINT "contact_change_events_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'actioned'::"text", 'dismissed'::"text", 'snoozed'::"text"]))),
    CONSTRAINT "contact_change_events_tier_check" CHECK (("tier" = ANY (ARRAY[1, 2, 3])))
);


ALTER TABLE "public"."contact_change_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."contact_change_events" IS 'Detected contact changes worth an outreach touch (anniversaries now; scrape diffs later). One row per change, deduped on (user_id, dedupe_key); only status=new surfaces in the feed.';



COMMENT ON COLUMN "public"."contact_change_events"."tier" IS '1 = act now (job change, promotion); 2 = touchpoint (anniversary, cert, location); 3 = silent data refresh (never surfaced as a suggestion)';



COMMENT ON COLUMN "public"."contact_change_events"."dedupe_key" IS 'Stable idempotency key, e.g. anniversary:<contactId>:<companyId>:<year> or company_change:<contactId>:<hash>. Producer upserts ON CONFLICT DO NOTHING.';



ALTER TABLE "public"."contact_change_events" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_change_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_companies" (
    "id" integer NOT NULL,
    "contact_id" integer NOT NULL,
    "company_id" integer NOT NULL,
    "title" character varying,
    "start_date" "date",
    "end_date" "date",
    "is_current" boolean DEFAULT false NOT NULL,
    "start_month" "text",
    "end_month" "text",
    "location" "text",
    "location_id" integer,
    "location_source" "text",
    "location_raw" "text",
    "workplace_type" "text",
    "employment_type" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "scraped_at" timestamp with time zone,
    CONSTRAINT "contact_companies_location_source_check" CHECK (("location_source" = ANY (ARRAY['experience'::"text", 'profile_match'::"text", 'manual'::"text"]))),
    CONSTRAINT "contact_companies_source_check" CHECK (("source" = ANY (ARRAY['scraped'::"text", 'manual'::"text", 'extension'::"text"]))),
    CONSTRAINT "contact_companies_workplace_type_check" CHECK (("workplace_type" = ANY (ARRAY['on_site'::"text", 'hybrid'::"text", 'remote'::"text"])))
);


ALTER TABLE "public"."contact_companies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."contact_companies"."start_month" IS 'Job start month in format "Mon YYYY" (e.g., "Jan 2023")';



COMMENT ON COLUMN "public"."contact_companies"."end_month" IS 'Job end month in format "Mon YYYY" or "Present" for current jobs';



COMMENT ON COLUMN "public"."contact_companies"."location" IS 'Legacy free-text job location from manual entry (e.g., "San Francisco, CA"). Scraped imports use location_id/location_raw instead.';



COMMENT ON COLUMN "public"."contact_companies"."location_id" IS 'Normalized metro-grain employment location';



COMMENT ON COLUMN "public"."contact_companies"."location_source" IS 'How the location was determined: experience = stated on the LinkedIn role; profile_match = inferred from profile location matching a known office; manual = user-entered';



COMMENT ON COLUMN "public"."contact_companies"."location_raw" IS 'Original scraped location string, kept for re-normalization when the alias map improves';



COMMENT ON COLUMN "public"."contact_companies"."source" IS 'Row provenance for the merge engine: scraped = actor data (auto-updatable/removable), extension = AI-parsed from the Chrome extension (supersedable by scrapes), manual = user-entered (never auto-modified)';



COMMENT ON COLUMN "public"."contact_companies"."scraped_at" IS 'When this employment fact was last confirmed by a scrape';



ALTER TABLE "public"."contact_companies" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_companies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_emails" (
    "id" integer NOT NULL,
    "contact_id" integer NOT NULL,
    "email" character varying,
    "is_primary" boolean DEFAULT false NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "bounced_at" timestamp with time zone,
    CONSTRAINT "contact_emails_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'scraped'::"text", 'pattern_guessed'::"text", 'verified'::"text"])))
);


ALTER TABLE "public"."contact_emails" OWNER TO "postgres";


COMMENT ON COLUMN "public"."contact_emails"."source" IS 'Where the address came from. Lifecycle is monotonic (verified > scraped > pattern_guessed) — re-imports may upgrade, never downgrade';



COMMENT ON COLUMN "public"."contact_emails"."bounced_at" IS 'Set when an NDR is detected for this address; bounced addresses surface distinctly, never as "no reply"';



ALTER TABLE "public"."contact_emails" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_emails_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_phones" (
    "id" integer NOT NULL,
    "contact_id" integer NOT NULL,
    "phone" character varying NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "type" character varying DEFAULT 'mobile'::character varying NOT NULL
);


ALTER TABLE "public"."contact_phones" OWNER TO "postgres";


ALTER TABLE "public"."contact_phones" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_phones_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_schools" (
    "id" integer NOT NULL,
    "contact_id" integer NOT NULL,
    "school_id" integer NOT NULL,
    "degree" character varying,
    "field_of_study" character varying,
    "start_year" integer,
    "end_year" integer
);


ALTER TABLE "public"."contact_schools" OWNER TO "postgres";


ALTER TABLE "public"."contact_schools" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_schools_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_scrape_snapshots" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "contact_id" integer NOT NULL,
    "scrape_run_id" bigint,
    "scraped_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "snapshot" "jsonb" NOT NULL
);


ALTER TABLE "public"."contact_scrape_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "public"."contact_scrape_snapshots" IS 'Normalized per-scrape profile snapshot (plan 29): diff baseline for hiring/openToWork flips + audit trail for change events.';



COMMENT ON COLUMN "public"."contact_scrape_snapshots"."snapshot" IS 'Normalized subset: headline, location text, photo presence, hiring, open_to_work, certification names, employment rows (company ids/titles/months). NOT the raw actor payload.';



ALTER TABLE "public"."contact_scrape_snapshots" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_scrape_snapshots_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_tags" (
    "contact_id" integer NOT NULL,
    "tag_id" integer NOT NULL
);


ALTER TABLE "public"."contact_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" character varying NOT NULL,
    "industry" character varying,
    "linkedin_url" character varying,
    "notes" "text",
    "met_through" "text",
    "follow_up_frequency_days" integer,
    "preferred_contact_method" character varying,
    "preferred_contact_value" character varying,
    "contact_status" "text",
    "expected_graduation" "text",
    "location_id" integer,
    "status_derived_at" timestamp with time zone,
    "photo_url" character varying,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reach_out_snoozed_until" timestamp with time zone,
    "first_outreach_skipped" boolean DEFAULT false NOT NULL,
    "suggestion_cooldown_until" timestamp with time zone,
    "intro_goal" "text",
    "headline" "text",
    "persona" "text",
    "review_note" "text",
    "verified_school" "text",
    "import_source" "text",
    "import_meta" "jsonb",
    "public_identifier" "text",
    "last_scraped_at" timestamp with time zone,
    "network_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "stage_override" "text",
    "network_scope" "text",
    "scrape_failed_at" timestamp with time zone,
    "scrape_failure_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "contacts_network_scope_check" CHECK (("network_scope" = ANY (ARRAY['target_company'::"text", 'broad_network'::"text"]))),
    CONSTRAINT "contacts_network_status_check" CHECK (("network_status" = ANY (ARRAY['active'::"text", 'prospect'::"text", 'bench'::"text"]))),
    CONSTRAINT "contacts_persona_check" CHECK (("persona" = ANY (ARRAY['alum_product'::"text", 'alum_other'::"text", 'product_peer'::"text", 'product_leader'::"text", 'recruiter'::"text"]))),
    CONSTRAINT "contacts_verified_school_check" CHECK (("verified_school" = ANY (ARRAY['BYU'::"text", 'BYU-Idaho'::"text", 'Marriott'::"text", 'none'::"text"])))
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."contacts" IS 'Contacts table with CASCADE delete on related records';



COMMENT ON COLUMN "public"."contacts"."location_id" IS 'Foreign key to normalized locations table';



COMMENT ON COLUMN "public"."contacts"."persona" IS 'Pipeline-verified persona (matches the scrape pipeline''s verified_persona enum)';



COMMENT ON COLUMN "public"."contacts"."review_note" IS 'AI review reasoning from the scrape pipeline (pipeline.review_reason)';



COMMENT ON COLUMN "public"."contacts"."verified_school" IS 'Agent-verified school affiliation from the pipeline (identity.school) — cross-check for the contact_schools-derived alum badge';



COMMENT ON COLUMN "public"."contacts"."import_source" IS 'Scrape provenance, e.g. "apify:mini_a,c2:2026-07_tranche1"';



COMMENT ON COLUMN "public"."contacts"."import_meta" IS 'Remaining pipeline provenance block: adjacency_score, selection_reason, review_sheet, priority_rank, history[]';



COMMENT ON COLUMN "public"."contacts"."public_identifier" IS 'LinkedIn profile slug — secondary dedupe key after canonical linkedin_url';



COMMENT ON COLUMN "public"."contacts"."last_scraped_at" IS 'When this contact''s data was last refreshed by a scrape ("data as of")';



COMMENT ON COLUMN "public"."contacts"."network_status" IS 'Network tier: active = the real hand-curated network; prospect = SELECTED imports in play for outreach; bench = dormant imported data, excluded from all outreach/suggestion surfaces';



COMMENT ON COLUMN "public"."contacts"."stage_override" IS 'Manual override for the derived outreach stage (e.g. outreach happened via LinkedIn DM)';



COMMENT ON COLUMN "public"."contacts"."network_scope" IS 'Pipeline segment: target_company = works at a target company; broad_network = BYU-family product alum elsewhere, kept for general networking; NULL = not a pipeline import';



COMMENT ON COLUMN "public"."contacts"."scrape_failure_count" IS 'Consecutive failed scrape attempts; reset to 0 on a successful scrape (plan 29)';



ALTER TABLE "public"."contacts" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contacts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."data_bundles" (
    "id" integer NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "version" integer DEFAULT 0 NOT NULL,
    "staging_version" integer,
    "staging_claimed_at" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "prospect_count" integer DEFAULT 0 NOT NULL,
    "company_count" integer DEFAULT 0 NOT NULL,
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "default_visible" boolean DEFAULT false NOT NULL,
    "resolved_version" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "data_bundles_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."data_bundles" OWNER TO "postgres";


COMMENT ON TABLE "public"."data_bundles" IS 'Admin-curated data bundles (prospect lists + company databases). Written only via the service-role publish flow; version 0 = never published.';



COMMENT ON COLUMN "public"."data_bundles"."version" IS 'Last COMMITTED publish version. Subscriber deltas are always bounded by this value pinned at sync start — staged rows are never applied.';



COMMENT ON COLUMN "public"."data_bundles"."staging_version" IS 'Publish lock: set to version+1 by beginPublish via conditional UPDATE; cleared by finalize/abort. A second publish is rejected while set and unexpired.';



COMMENT ON COLUMN "public"."data_bundles"."staging_claimed_at" IS 'When the publish lock was claimed; locks older than the expiry window may be reclaimed.';



COMMENT ON COLUMN "public"."data_bundles"."prospect_count" IS 'Denormalized live-prospect count, recomputed at finalize — read by browse cards without touching bundle_prospects.';



COMMENT ON COLUMN "public"."data_bundles"."default_visible" IS 'false (default) = hidden until an admin grants an allowed=true override; true = broadly visible. Per-account overrides in bundle_access_overrides win either way.';



COMMENT ON COLUMN "public"."data_bundles"."resolved_version" IS 'Committed version whose live prospects ALL carry a hash-current resolution snapshot. resolved_version = version gates the fast-apply path (CAR-62); anything else takes the merge path.';



ALTER TABLE "public"."data_bundles" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."data_bundles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."discovery_candidates" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_id" integer NOT NULL,
    "linkedin_url" "text" NOT NULL,
    "public_identifier" "text",
    "name" "text" NOT NULL,
    "headline" "text",
    "location" "text",
    "photo_url" "text",
    "position" "text",
    "raw" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "added_contact_id" integer,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "discovery_candidates_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'added'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."discovery_candidates" OWNER TO "postgres";


COMMENT ON TABLE "public"."discovery_candidates" IS 'Discovery-feed candidates (plan 41): strangers found by the weekly target-company people search. linkedin_url is canonical. status: new = awaiting review, added = converted to a contact, dismissed = never show again.';



COMMENT ON COLUMN "public"."discovery_candidates"."position" IS 'Current title at the target company, when the short profile carries one.';



ALTER TABLE "public"."discovery_candidates" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."discovery_candidates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."email_drafts" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "recipient_email" "text",
    "cc" "text",
    "bcc" "text",
    "subject" "text",
    "body_html" "text",
    "thread_id" "text",
    "in_reply_to" "text",
    "references_header" "text",
    "contact_name" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."email_drafts" OWNER TO "postgres";


ALTER TABLE "public"."email_drafts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."email_drafts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."email_follow_up_messages" (
    "id" integer NOT NULL,
    "follow_up_id" integer NOT NULL,
    "sequence_number" integer NOT NULL,
    "send_after_days" integer NOT NULL,
    "subject" "text" NOT NULL,
    "body_html" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "scheduled_send_at" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "parked_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "reminder_count" integer DEFAULT 0 NOT NULL,
    "last_reminder_at" timestamp with time zone,
    "seen_during_window" boolean DEFAULT false NOT NULL,
    "claimed_at" timestamp with time zone,
    CONSTRAINT "email_follow_up_messages_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'cancelled'::"text", 'awaiting_review'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."email_follow_up_messages" OWNER TO "postgres";


COMMENT ON COLUMN "public"."email_follow_up_messages"."parked_at" IS 'CAR-105: when the message became awaiting_review (anchor P for countdown/expiry/nudges).';



COMMENT ON COLUMN "public"."email_follow_up_messages"."expires_at" IS 'CAR-105: active-aware expiry deadline. Initially parked_at + 14d; the nudge cron pushes it out once (to next-visit + 24h) if the user was never active during the window.';



COMMENT ON COLUMN "public"."email_follow_up_messages"."reminder_count" IS 'CAR-105: milestone emails sent (0..3 = day 0/4/9). Also the daily-digest idempotency cursor.';



COMMENT ON COLUMN "public"."email_follow_up_messages"."seen_during_window" IS 'CAR-105: set true by the nudge cron when the user was active in-app during [parked_at, parked_at+14d]; gates the active-aware expiry branch.';



COMMENT ON COLUMN "public"."email_follow_up_messages"."claimed_at" IS 'CAR-139: when a send driver claimed this row (status=sending). Stale claims are swept to awaiting_review by the send-follow-ups cron.';



CREATE SEQUENCE IF NOT EXISTS "public"."email_follow_up_messages_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."email_follow_up_messages_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."email_follow_up_messages_id_seq" OWNED BY "public"."email_follow_up_messages"."id";



CREATE TABLE IF NOT EXISTS "public"."email_follow_ups" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "original_gmail_message_id" "text",
    "thread_id" "text",
    "recipient_email" "text" NOT NULL,
    "contact_name" "text",
    "original_subject" "text",
    "original_sent_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "scheduled_email_id" integer,
    "contact_id" integer,
    CONSTRAINT "email_follow_ups_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'cancelled_reply'::"text", 'cancelled_user'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."email_follow_ups" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."email_follow_ups_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."email_follow_ups_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."email_follow_ups_id_seq" OWNED BY "public"."email_follow_ups"."id";



CREATE TABLE IF NOT EXISTS "public"."email_messages" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "gmail_message_id" "text" NOT NULL,
    "thread_id" "text",
    "subject" "text",
    "snippet" "text",
    "from_address" "text",
    "to_addresses" "text"[],
    "date" timestamp with time zone,
    "label_ids" "text"[],
    "is_read" boolean DEFAULT true,
    "direction" "text",
    "matched_contact_id" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_trashed" boolean DEFAULT false NOT NULL,
    "is_hidden" boolean DEFAULT false NOT NULL,
    "is_simulated" boolean DEFAULT false,
    "ai_assisted" boolean DEFAULT false NOT NULL,
    "body_html" "text",
    CONSTRAINT "email_messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"])))
);


ALTER TABLE "public"."email_messages" OWNER TO "postgres";


COMMENT ON COLUMN "public"."email_messages"."body_html" IS 'CAR-115: full HTML body of an outbound message, persisted at send time so free-tier Outreach users can re-read what they sent without a live Gmail read. Null for pre-CAR-115 rows, inbound messages, and sync-created rows (UI falls back to snippet).';



CREATE SEQUENCE IF NOT EXISTS "public"."email_messages_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."email_messages_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."email_messages_id_seq" OWNED BY "public"."email_messages"."id";



CREATE TABLE IF NOT EXISTS "public"."email_templates" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "prompt" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."email_templates" OWNER TO "postgres";


ALTER TABLE "public"."email_templates" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."email_templates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."follow_up_action_items" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "contact_id" integer,
    "title" character varying NOT NULL,
    "description" "text",
    "due_at" timestamp with time zone,
    "is_completed" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "meeting_id" integer,
    "priority" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "suggestion_reason_type" "text",
    "suggestion_headline" "text",
    "suggestion_evidence" "text",
    "direction" "text" DEFAULT 'my_task'::"text",
    "assigned_speaker" "text",
    "related_action_item_id" integer,
    "snoozed_until" timestamp with time zone,
    CONSTRAINT "follow_up_action_items_direction_check" CHECK (("direction" = ANY (ARRAY['my_task'::"text", 'waiting_on'::"text", 'mutual'::"text"]))),
    CONSTRAINT "follow_up_action_items_priority_check" CHECK (("priority" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))
);


ALTER TABLE "public"."follow_up_action_items" OWNER TO "postgres";


ALTER TABLE "public"."follow_up_action_items" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."follow_up_action_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."gmail_connections" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "gmail_address" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "token_expires_at" timestamp with time zone NOT NULL,
    "last_gmail_sync_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "calendar_scopes_granted" boolean DEFAULT false,
    "calendar_sync_token" "text",
    "calendar_last_synced_at" timestamp with time zone,
    "calendar_timezone" "text" DEFAULT 'America/New_York'::"text",
    "calendar_list" "jsonb",
    "busy_calendar_ids" "text"[],
    "availability_standard" "jsonb",
    "availability_priority" "jsonb",
    "automatic_features_enabled" boolean DEFAULT true NOT NULL,
    "modify_scope_granted" boolean DEFAULT false NOT NULL,
    "premium_enabled" boolean DEFAULT true NOT NULL,
    "send_scope_granted" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."gmail_connections" OWNER TO "postgres";


COMMENT ON COLUMN "public"."gmail_connections"."automatic_features_enabled" IS 'CAR-102: automatic follow-ups (auto reply-detection + auto-send). Default true (was false in CAR-103); the admin toggle is now an opt-out. Gated by followups:auto = automatic_features_enabled AND isPremium, so a free user gains nothing from a true value.';



COMMENT ON COLUMN "public"."gmail_connections"."modify_scope_granted" IS 'CAR-102: whether this connection holds the gmail.modify scope (a truthful token-fact set by the OAuth callback). Default false as of the sensitive-scope flip; a premium connect re-adds gmail.modify and sets this true.';



COMMENT ON COLUMN "public"."gmail_connections"."premium_enabled" IS 'CAR-102: admin master switch for the premium (Inbox) experience. Premium = modify_scope_granted AND premium_enabled. Default true; turn off to move a user to the free Outreach tier with no reconnect (modify_scope_granted stays a truthful token-fact).';



CREATE SEQUENCE IF NOT EXISTS "public"."gmail_connections_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."gmail_connections_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."gmail_connections_id_seq" OWNED BY "public"."gmail_connections"."id";



CREATE TABLE IF NOT EXISTS "public"."interaction_attachments" (
    "interaction_id" integer NOT NULL,
    "attachment_id" integer NOT NULL
);


ALTER TABLE "public"."interaction_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."interactions" (
    "id" integer NOT NULL,
    "contact_id" integer NOT NULL,
    "interaction_date" timestamp with time zone NOT NULL,
    "interaction_type" character varying NOT NULL,
    "summary" "text"
);


ALTER TABLE "public"."interactions" OWNER TO "postgres";


ALTER TABLE "public"."interactions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."interactions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."internal_analytics_emails" (
    "email" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."internal_analytics_emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."locations" (
    "id" integer NOT NULL,
    "city" "text",
    "state" "text",
    "country" "text" DEFAULT 'United States'::"text" NOT NULL
);


ALTER TABLE "public"."locations" OWNER TO "postgres";


COMMENT ON TABLE "public"."locations" IS 'Normalized location data with city, state, country';



COMMENT ON COLUMN "public"."locations"."city" IS 'City name (e.g., San Francisco)';



COMMENT ON COLUMN "public"."locations"."state" IS 'State/province/region (e.g., California, CA)';



COMMENT ON COLUMN "public"."locations"."country" IS 'Country name (e.g., United States)';



CREATE SEQUENCE IF NOT EXISTS "public"."locations_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."locations_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."locations_id_seq" OWNED BY "public"."locations"."id";



CREATE TABLE IF NOT EXISTS "public"."meeting_attachments" (
    "meeting_id" integer NOT NULL,
    "attachment_id" integer NOT NULL
);


ALTER TABLE "public"."meeting_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_contacts" (
    "meeting_id" integer NOT NULL,
    "contact_id" integer NOT NULL
);


ALTER TABLE "public"."meeting_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetings" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "meeting_date" timestamp with time zone NOT NULL,
    "meeting_type" character varying,
    "notes" "text",
    "transcript" "text",
    "calendar_event_id" "text",
    "meet_link" "text",
    "zoom_link" "text",
    "title" "text",
    "private_notes" "text",
    "calendar_description" "text",
    "transcript_source" "text",
    "transcript_parsed" boolean DEFAULT false,
    "transcript_attachment_id" integer
);


ALTER TABLE "public"."meetings" OWNER TO "postgres";


ALTER TABLE "public"."meetings" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."meetings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."pipeline_applications" (
    "id" "uuid" NOT NULL,
    "cycle_id" integer NOT NULL,
    "job_title" "text" DEFAULT ''::"text" NOT NULL,
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "date_applied" "date",
    "resume_path" "text",
    "resume_name" "text",
    "resume_size_bytes" integer,
    "cover_letter_path" "text",
    "cover_letter_name" "text",
    "cover_letter_size_bytes" integer,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_applications" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pipeline_applications"."resume_path" IS 'Storage object path in the application-files bucket ({user_id}/{uuid}.pdf)';



CREATE TABLE IF NOT EXISTS "public"."pipeline_cycles" (
    "id" integer NOT NULL,
    "target_company_id" integer NOT NULL,
    "cycle_number" integer NOT NULL,
    "selected_stage" "text" DEFAULT 'researching'::"text" NOT NULL,
    "declined_next_cycle" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pipeline_cycles_selected_stage_check" CHECK (("selected_stage" = ANY (ARRAY['researching'::"text", 'outreach_active'::"text", 'applied'::"text", 'interviewing'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."pipeline_cycles" OWNER TO "postgres";


COMMENT ON TABLE "public"."pipeline_cycles" IS 'One application cycle per target scope (company-wide or office); the recruiting pipeline the company page renders';



ALTER TABLE "public"."pipeline_cycles" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."pipeline_cycles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."pipeline_interview_rounds" (
    "id" "uuid" NOT NULL,
    "cycle_id" integer NOT NULL,
    "interview_date" "date",
    "interviewer" "text" DEFAULT ''::"text" NOT NULL,
    "questions" "text" DEFAULT ''::"text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_interview_rounds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_notes" (
    "id" "uuid" NOT NULL,
    "cycle_id" integer NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_programs" (
    "id" "uuid" NOT NULL,
    "cycle_id" integer NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "apps_open" "text" DEFAULT ''::"text" NOT NULL,
    "job_potential" "text" DEFAULT ''::"text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_programs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pipeline_programs"."apps_open" IS 'Free text or "date:YYYY-MM-DD" sentinel, matching the preview''s researching-program editor';



CREATE TABLE IF NOT EXISTS "public"."referrals" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "referred_by_contact_id" integer NOT NULL,
    "referred_contact_id" integer NOT NULL,
    "referral_meeting_id" integer,
    "notes" "text"
);


ALTER TABLE "public"."referrals" OWNER TO "postgres";


ALTER TABLE "public"."referrals" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."referrals_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scheduled_emails" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "cc" "text",
    "bcc" "text",
    "subject" "text" NOT NULL,
    "body_html" "text" NOT NULL,
    "thread_id" "text",
    "in_reply_to" "text",
    "references_header" "text",
    "scheduled_send_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "gmail_message_id" "text",
    "sent_thread_id" "text",
    "contact_name" "text",
    "matched_contact_id" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "claimed_at" timestamp with time zone,
    CONSTRAINT "scheduled_emails_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'cancelled'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."scheduled_emails" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."scheduled_emails_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."scheduled_emails_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."scheduled_emails_id_seq" OWNED BY "public"."scheduled_emails"."id";



CREATE TABLE IF NOT EXISTS "public"."schools" (
    "id" integer NOT NULL,
    "name" character varying NOT NULL
);


ALTER TABLE "public"."schools" OWNER TO "postgres";


ALTER TABLE "public"."schools" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."schools_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."scrape_runs" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "apify_run_id" "text",
    "actor" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "trigger" "text" NOT NULL,
    "contact_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "cost_usd" numeric(10,4) DEFAULT 0 NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "single_contact_id" integer,
    "ingest_claimed_at" timestamp with time zone,
    "company_id" integer,
    CONSTRAINT "scrape_runs_mode_check" CHECK (("mode" = ANY (ARRAY['profile'::"text", 'email'::"text", 'resolve'::"text", 'discovery'::"text"]))),
    CONSTRAINT "scrape_runs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'succeeded'::"text", 'failed'::"text", 'timed_out'::"text"]))),
    CONSTRAINT "scrape_runs_trigger_check" CHECK (("trigger" = ANY (ARRAY['manual'::"text", 'enrich_on_save'::"text", 'cadence'::"text", 'discovery'::"text"])))
);


ALTER TABLE "public"."scrape_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."scrape_runs" IS 'Ledger of Apify scrape runs (plan 29). One row per run: idempotency guard, monthly spend accounting, and audit trail. Only succeeded rows carry a real cost_usd.';



COMMENT ON COLUMN "public"."scrape_runs"."mode" IS 'profile = $0.004 profile-only; email = $0.01 profile + email search; resolve = $0.004 name-search page; discovery = $0.10 people-search page';



COMMENT ON COLUMN "public"."scrape_runs"."trigger" IS 'manual = per-contact button; enrich_on_save = extension save; cadence = daily drip cron; discovery = weekly new-hire search cron';



COMMENT ON COLUMN "public"."scrape_runs"."single_contact_id" IS 'The single contact this run targets (NULL for future multi-contact/cadence runs); backs the one-in-flight-per-contact guard';



COMMENT ON COLUMN "public"."scrape_runs"."ingest_claimed_at" IS 'Set by the webhook ingest''s atomic claim (CAS, count-checked). NULL or >10min old = claimable. Prevents concurrent duplicate deliveries from double-merging a run.';



COMMENT ON COLUMN "public"."scrape_runs"."company_id" IS 'For discovery-mode runs: the company whose new hires this run searched (plan 41). NULL for contact-scrape runs.';



ALTER TABLE "public"."scrape_runs" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."scrape_runs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."suppressed_imports" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "linkedin_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."suppressed_imports" OWNER TO "postgres";


COMMENT ON TABLE "public"."suppressed_imports" IS 'Tombstones written when an imported contact is deleted; bulk import skips these so deleted junk does not resurrect on the next tranche. linkedin_url is stored in canonical form.';



ALTER TABLE "public"."suppressed_imports" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."suppressed_imports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" character varying NOT NULL
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


ALTER TABLE "public"."tags" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."tags_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."target_companies" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_id" integer NOT NULL,
    "priority_score" numeric,
    "tier" "text",
    "program_name" "text",
    "app_window_text" "text",
    "next_app_date" "date",
    "status" "text" DEFAULT 'researching'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "location_id" integer,
    "is_targeted" boolean DEFAULT true NOT NULL,
    "active_cycle" integer DEFAULT 1 NOT NULL,
    "last_discovery_at" timestamp with time zone,
    CONSTRAINT "target_companies_status_check" CHECK (("status" = ANY (ARRAY['researching'::"text", 'outreach_active'::"text", 'applied'::"text", 'interviewing'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."target_companies" OWNER TO "postgres";


COMMENT ON COLUMN "public"."target_companies"."tier" IS 'Segment/geo label from the target sheet (e.g. "Utah/Silicon Slopes", "Big Tech")';



COMMENT ON COLUMN "public"."target_companies"."app_window_text" IS 'Free-text application-window hint imported from the sheet — display only, never sorted or parsed';



COMMENT ON COLUMN "public"."target_companies"."next_app_date" IS 'Real application date set by hand when learned; the only field sorting/alerts use';



COMMENT ON COLUMN "public"."target_companies"."location_id" IS 'NULL = company-wide scope; set = office-scoped target (one pipeline per scope)';



COMMENT ON COLUMN "public"."target_companies"."is_targeted" IS 'Soft targeting flag — false keeps the row (and its pipeline cycles) while removing it from target views';



COMMENT ON COLUMN "public"."target_companies"."active_cycle" IS 'Which pipeline cycle the user last worked in for this scope (UI continuity)';



COMMENT ON COLUMN "public"."target_companies"."last_discovery_at" IS 'When the discovery cron last queried this company for new hires (plan 41). Stamped at run trigger, not ingest.';



ALTER TABLE "public"."target_companies" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."target_companies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."target_company_notes" (
    "id" integer NOT NULL,
    "target_company_id" integer NOT NULL,
    "note" "text" NOT NULL,
    "location_id" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."target_company_notes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."target_company_notes"."location_id" IS 'Optional office tag so intel can be scoped to a company location';



ALTER TABLE "public"."target_company_notes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."target_company_notes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."transcript_segments" (
    "id" bigint NOT NULL,
    "meeting_id" integer NOT NULL,
    "ordinal" integer NOT NULL,
    "speaker_label" "text" NOT NULL,
    "contact_id" integer,
    "started_at" real,
    "ended_at" real,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."transcript_segments" OWNER TO "postgres";


ALTER TABLE "public"."transcript_segments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."transcript_segments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."user_ai_access" (
    "user_id" "uuid" NOT NULL,
    "shared_access" boolean DEFAULT false NOT NULL,
    "granted_at" timestamp with time zone,
    "granted_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "access_requested_at" timestamp with time zone
);


ALTER TABLE "public"."user_ai_access" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_ai_access"."expires_at" IS 'Entitlement expiry. NULL = permanent (admin grant); trial rows get first AI use + 24h.';



COMMENT ON COLUMN "public"."user_ai_access"."access_requested_at" IS 'When the user last requested continued shared-AI access after trial expiry (CAR-51).';



CREATE TABLE IF NOT EXISTS "public"."user_api_keys" (
    "user_id" "uuid" NOT NULL,
    "provider" "text" DEFAULT 'openai'::"text" NOT NULL,
    "encrypted_key" "text" NOT NULL,
    "key_last4" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_validated_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_api_keys_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'invalid'::"text", 'quota_exceeded'::"text"])))
);


ALTER TABLE "public"."user_api_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_companies" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company_id" integer NOT NULL,
    "title" character varying,
    "start_date" "date",
    "end_date" "date",
    "is_current" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."user_companies" OWNER TO "postgres";


ALTER TABLE "public"."user_companies" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."user_companies_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."user_milestones" (
    "user_id" "uuid" NOT NULL,
    "milestone" "text" NOT NULL,
    "reached_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_milestones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_schools" (
    "id" integer NOT NULL,
    "user_id" "uuid" NOT NULL,
    "school_id" integer NOT NULL,
    "degree" character varying,
    "field_of_study" character varying,
    "start_year" integer,
    "end_year" integer
);


ALTER TABLE "public"."user_schools" OWNER TO "postgres";


ALTER TABLE "public"."user_schools" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."user_schools_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "first_name" character varying NOT NULL,
    "last_name" character varying NOT NULL,
    "email" character varying,
    "phone" character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "apify_enrichment_enabled" boolean DEFAULT true NOT NULL,
    "diff_analysis_enabled" boolean DEFAULT true NOT NULL,
    "discovery_enabled" boolean DEFAULT false NOT NULL,
    "onboarding_state" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "extension_onboarding_state" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "extension_onboarding_contact_id" integer,
    "extension_last_seen_at" timestamp with time zone,
    "dismissed_getting_started" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "web_last_seen_at" timestamp with time zone,
    "followup_nudges_enabled" boolean DEFAULT true NOT NULL,
    CONSTRAINT "users_extension_onboarding_state_check" CHECK (("extension_onboarding_state" = ANY (ARRAY['not_started'::"text", 'started'::"text", 'awaiting_connect'::"text", 'awaiting_first_contact'::"text", 'email_offer'::"text", 'apollo_intro'::"text", 'apollo_install'::"text", 'apollo_howto'::"text", 'awaiting_email_contact'::"text", 'done'::"text", 'completed_no_apollo'::"text"]))),
    CONSTRAINT "users_onboarding_state_check" CHECK (("onboarding_state" = ANY (ARRAY['not_started'::"text", 'connect'::"text", 'syncing'::"text", 'pick_company'::"text", 'outreach'::"text", 'completed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "users_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'suspended'::"text"])))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON COLUMN "public"."users"."status" IS 'active | suspended. Suspended = frozen: blocked from login and skipped by server-side automation. Writable only by the service role.';



COMMENT ON COLUMN "public"."users"."apify_enrichment_enabled" IS 'Admin kill switch for all paid Apify activity on this account (auto-enrich, cadence, manual scrape/find-email/resolve). Writable only by the service role.';



COMMENT ON COLUMN "public"."users"."diff_analysis_enabled" IS 'Admin kill switch for change-event production from scrape ingests. Merge + snapshots unaffected. Writable only by the service role.';



COMMENT ON COLUMN "public"."users"."discovery_enabled" IS 'Admin switch for the weekly discovery feed (paid LinkedIn people-search per target company). Default off; writable only by the service role.';



COMMENT ON COLUMN "public"."users"."onboarding_state" IS 'Guided first-run onboarding progress (CAR-50, +connect step CAR-82). User-writable; forward-only transitions enforced in the app.';



COMMENT ON COLUMN "public"."users"."extension_onboarding_state" IS 'Extension onboarding flow progress (CAR-68). User-writable; forward-only transitions enforced in the app.';



COMMENT ON COLUMN "public"."users"."extension_last_seen_at" IS 'Last Bearer-authenticated extension API call (CAR-68); stamped in api-handler.';



COMMENT ON COLUMN "public"."users"."dismissed_getting_started" IS 'Getting-started checklist row IDs the user dismissed on Home (CAR-73). User-writable.';



COMMENT ON COLUMN "public"."users"."web_last_seen_at" IS 'CAR-105: last authenticated WEB app activity (distinct from extension_last_seen_at); throttled stamp from api-handler. Feeds the active-aware follow-up expiry.';



COMMENT ON COLUMN "public"."users"."followup_nudges_enabled" IS 'CAR-105: opt-in (default true) for the follow-up reminder emails. Toggled in settings or via one-click unsubscribe.';



ALTER TABLE ONLY "public"."calendar_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."calendar_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."email_follow_up_messages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."email_follow_up_messages_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."email_follow_ups" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."email_follow_ups_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."email_messages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."email_messages_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."gmail_connections" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."gmail_connections_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."locations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."locations_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."scheduled_emails" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."scheduled_emails_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."action_item_contacts"
    ADD CONSTRAINT "action_item_contacts_action_item_id_contact_id_key" UNIQUE ("action_item_id", "contact_id");



ALTER TABLE ONLY "public"."action_item_contacts"
    ADD CONSTRAINT "action_item_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_audit_log"
    ADD CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_follow_up_drafts"
    ADD CONSTRAINT "ai_follow_up_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attachments"
    ADD CONSTRAINT "attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bundle_access_overrides"
    ADD CONSTRAINT "bundle_access_overrides_pkey" PRIMARY KEY ("user_id", "bundle_id");



ALTER TABLE ONLY "public"."bundle_companies"
    ADD CONSTRAINT "bundle_companies_bundle_id_company_id_key" UNIQUE ("bundle_id", "company_id");



ALTER TABLE ONLY "public"."bundle_companies"
    ADD CONSTRAINT "bundle_companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bundle_contact_state"
    ADD CONSTRAINT "bundle_contact_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bundle_contact_state"
    ADD CONSTRAINT "bundle_contact_state_user_id_contact_id_key" UNIQUE ("user_id", "contact_id");



ALTER TABLE ONLY "public"."bundle_prospects"
    ADD CONSTRAINT "bundle_prospects_bundle_id_linkedin_url_key" UNIQUE ("bundle_id", "linkedin_url");



ALTER TABLE ONLY "public"."bundle_prospects"
    ADD CONSTRAINT "bundle_prospects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bundle_subscription_contacts"
    ADD CONSTRAINT "bundle_subscription_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bundle_subscription_contacts"
    ADD CONSTRAINT "bundle_subscription_contacts_subscription_id_contact_id_key" UNIQUE ("subscription_id", "contact_id");



ALTER TABLE ONLY "public"."bundle_subscriptions"
    ADD CONSTRAINT "bundle_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bundle_subscriptions"
    ADD CONSTRAINT "bundle_subscriptions_user_id_bundle_id_key" UNIQUE ("user_id", "bundle_id");



ALTER TABLE ONLY "public"."calendar_event_contacts"
    ADD CONSTRAINT "calendar_event_contacts_pkey" PRIMARY KEY ("calendar_event_id", "contact_id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_user_id_google_event_id_key" UNIQUE ("user_id", "google_event_id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_locations"
    ADD CONSTRAINT "company_locations_company_id_location_id_key" UNIQUE ("company_id", "location_id");



ALTER TABLE ONLY "public"."company_locations"
    ADD CONSTRAINT "company_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_change_events"
    ADD CONSTRAINT "contact_change_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_change_events"
    ADD CONSTRAINT "contact_change_events_user_id_dedupe_key_key" UNIQUE ("user_id", "dedupe_key");



ALTER TABLE ONLY "public"."contact_companies"
    ADD CONSTRAINT "contact_companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_emails"
    ADD CONSTRAINT "contact_emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_phones"
    ADD CONSTRAINT "contact_phones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_schools"
    ADD CONSTRAINT "contact_schools_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_scrape_snapshots"
    ADD CONSTRAINT "contact_scrape_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_bundles"
    ADD CONSTRAINT "data_bundles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_bundles"
    ADD CONSTRAINT "data_bundles_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."discovery_candidates"
    ADD CONSTRAINT "discovery_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discovery_candidates"
    ADD CONSTRAINT "discovery_candidates_user_id_linkedin_url_key" UNIQUE ("user_id", "linkedin_url");



ALTER TABLE ONLY "public"."email_drafts"
    ADD CONSTRAINT "email_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_follow_up_messages"
    ADD CONSTRAINT "email_follow_up_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_follow_ups"
    ADD CONSTRAINT "email_follow_ups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_user_id_gmail_message_id_key" UNIQUE ("user_id", "gmail_message_id");



ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."follow_up_action_items"
    ADD CONSTRAINT "follow_up_action_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_connections"
    ADD CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_connections"
    ADD CONSTRAINT "gmail_connections_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."interactions"
    ADD CONSTRAINT "interactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."internal_analytics_emails"
    ADD CONSTRAINT "internal_analytics_emails_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_city_state_country_key" UNIQUE ("city", "state", "country");



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_applications"
    ADD CONSTRAINT "pipeline_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_cycles"
    ADD CONSTRAINT "pipeline_cycles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_cycles"
    ADD CONSTRAINT "pipeline_cycles_scope_number_key" UNIQUE ("target_company_id", "cycle_number");



ALTER TABLE ONLY "public"."pipeline_interview_rounds"
    ADD CONSTRAINT "pipeline_interview_rounds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_notes"
    ADD CONSTRAINT "pipeline_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_programs"
    ADD CONSTRAINT "pipeline_programs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referrals"
    ADD CONSTRAINT "referrals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schools"
    ADD CONSTRAINT "schools_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."schools"
    ADD CONSTRAINT "schools_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scrape_runs"
    ADD CONSTRAINT "scrape_runs_apify_run_id_key" UNIQUE ("apify_run_id");



ALTER TABLE ONLY "public"."scrape_runs"
    ADD CONSTRAINT "scrape_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppressed_imports"
    ADD CONSTRAINT "suppressed_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppressed_imports"
    ADD CONSTRAINT "suppressed_imports_user_id_linkedin_url_key" UNIQUE ("user_id", "linkedin_url");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."target_companies"
    ADD CONSTRAINT "target_companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."target_company_notes"
    ADD CONSTRAINT "target_company_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transcript_segments"
    ADD CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_ai_access"
    ADD CONSTRAINT "user_ai_access_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_api_keys"
    ADD CONSTRAINT "user_api_keys_pkey" PRIMARY KEY ("user_id", "provider");



ALTER TABLE ONLY "public"."user_companies"
    ADD CONSTRAINT "user_companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_milestones"
    ADD CONSTRAINT "user_milestones_pkey" PRIMARY KEY ("user_id", "milestone");



ALTER TABLE ONLY "public"."user_schools"
    ADD CONSTRAINT "user_schools_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE INDEX "admin_audit_log_target_idx" ON "public"."admin_audit_log" USING "btree" ("target_user_id", "created_at" DESC);



CREATE INDEX "analytics_events_event_time_idx" ON "public"."analytics_events" USING "btree" ("event", "created_at" DESC);



CREATE INDEX "analytics_events_user_event_time_idx" ON "public"."analytics_events" USING "btree" ("user_id", "event", "created_at" DESC);



CREATE UNIQUE INDEX "attachments_path_idx" ON "public"."attachments" USING "btree" ("bucket", "object_path");



CREATE INDEX "bundle_prospects_delta_idx" ON "public"."bundle_prospects" USING "btree" ("bundle_id", "version_updated");



CREATE INDEX "bundle_prospects_removed_idx" ON "public"."bundle_prospects" USING "btree" ("bundle_id", "removed_in_version") WHERE ("removed_in_version" IS NOT NULL);



CREATE INDEX "bundle_subscription_contacts_contact_idx" ON "public"."bundle_subscription_contacts" USING "btree" ("contact_id");



CREATE INDEX "bundle_subscriptions_pending_unsub_idx" ON "public"."bundle_subscriptions" USING "btree" ("id") WHERE (("status" = 'unsubscribed'::"text") AND ("unsubscribe_keep_all" IS NOT NULL));



CREATE INDEX "bundle_subscriptions_stale_idx" ON "public"."bundle_subscriptions" USING "btree" ("bundle_id", "synced_version") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "companies_linkedin_company_id_idx" ON "public"."companies" USING "btree" ("linkedin_company_id") WHERE ("linkedin_company_id" IS NOT NULL);



CREATE INDEX "companies_name_normalized_idx" ON "public"."companies" USING "btree" ("name_normalized");



CREATE UNIQUE INDEX "contact_attachments_unique_idx" ON "public"."contact_attachments" USING "btree" ("contact_id", "attachment_id");



CREATE INDEX "contact_change_events_contact_idx" ON "public"."contact_change_events" USING "btree" ("contact_id");



CREATE INDEX "contact_change_events_user_status_idx" ON "public"."contact_change_events" USING "btree" ("user_id", "status");



CREATE UNIQUE INDEX "contact_companies_unique_idx" ON "public"."contact_companies" USING "btree" ("contact_id", "company_id", "start_date");



CREATE UNIQUE INDEX "contact_emails_contact_email_idx" ON "public"."contact_emails" USING "btree" ("contact_id", "email");



CREATE UNIQUE INDEX "contact_phones_contact_phone_idx" ON "public"."contact_phones" USING "btree" ("contact_id", "phone");



CREATE UNIQUE INDEX "contact_schools_unique_idx" ON "public"."contact_schools" USING "btree" ("contact_id", "school_id", "start_year");



CREATE INDEX "contact_scrape_snapshots_contact_scraped_idx" ON "public"."contact_scrape_snapshots" USING "btree" ("contact_id", "scraped_at" DESC);



CREATE UNIQUE INDEX "contact_tags_unique_idx" ON "public"."contact_tags" USING "btree" ("contact_id", "tag_id");



CREATE INDEX "contacts_linkedin_url_idx" ON "public"."contacts" USING "btree" ("linkedin_url");



CREATE INDEX "contacts_public_identifier_idx" ON "public"."contacts" USING "btree" ("public_identifier");



CREATE INDEX "contacts_user_network_status_idx" ON "public"."contacts" USING "btree" ("user_id", "network_status");



CREATE INDEX "contacts_user_network_status_name_idx" ON "public"."contacts" USING "btree" ("user_id", "network_status", "name");



CREATE INDEX "discovery_candidates_user_company_status_idx" ON "public"."discovery_candidates" USING "btree" ("user_id", "company_id", "status");



CREATE INDEX "discovery_candidates_user_status_idx" ON "public"."discovery_candidates" USING "btree" ("user_id", "status");



CREATE INDEX "idx_ai_follow_up_drafts_pending" ON "public"."ai_follow_up_drafts" USING "btree" ("user_id", "status") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_calendar_event_contacts_contact_id" ON "public"."calendar_event_contacts" USING "btree" ("contact_id");



CREATE INDEX "idx_calendar_events_contact_id" ON "public"."calendar_events" USING "btree" ("contact_id");



CREATE INDEX "idx_calendar_events_meeting_id" ON "public"."calendar_events" USING "btree" ("meeting_id");



CREATE INDEX "idx_calendar_events_start_at" ON "public"."calendar_events" USING "btree" ("start_at");



CREATE INDEX "idx_calendar_events_user_id" ON "public"."calendar_events" USING "btree" ("user_id");



CREATE INDEX "idx_email_drafts_user_id" ON "public"."email_drafts" USING "btree" ("user_id");



CREATE INDEX "idx_email_follow_ups_contact" ON "public"."email_follow_ups" USING "btree" ("contact_id");



CREATE INDEX "idx_email_follow_ups_thread" ON "public"."email_follow_ups" USING "btree" ("user_id", "thread_id");



CREATE INDEX "idx_email_follow_ups_user" ON "public"."email_follow_ups" USING "btree" ("user_id", "status");



CREATE INDEX "idx_email_messages_contact_date" ON "public"."email_messages" USING "btree" ("user_id", "matched_contact_id", "date" DESC);



CREATE INDEX "idx_email_templates_user_id" ON "public"."email_templates" USING "btree" ("user_id");



CREATE INDEX "idx_follow_up_messages_pending" ON "public"."email_follow_up_messages" USING "btree" ("status", "scheduled_send_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_follow_up_messages_sending" ON "public"."email_follow_up_messages" USING "btree" ("claimed_at") WHERE ("status" = 'sending'::"text");



CREATE UNIQUE INDEX "idx_one_pending_draft_per_contact" ON "public"."ai_follow_up_drafts" USING "btree" ("user_id", "contact_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_scheduled_emails_pending" ON "public"."scheduled_emails" USING "btree" ("status", "scheduled_send_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_scheduled_emails_sending" ON "public"."scheduled_emails" USING "btree" ("claimed_at") WHERE ("status" = 'sending'::"text");



CREATE INDEX "idx_scheduled_emails_user" ON "public"."scheduled_emails" USING "btree" ("user_id", "status");



CREATE INDEX "idx_transcript_segments_meeting" ON "public"."transcript_segments" USING "btree" ("meeting_id", "ordinal");



CREATE UNIQUE INDEX "interaction_attachments_unique_idx" ON "public"."interaction_attachments" USING "btree" ("interaction_id", "attachment_id");



CREATE UNIQUE INDEX "meeting_attachments_unique_idx" ON "public"."meeting_attachments" USING "btree" ("meeting_id", "attachment_id");



CREATE UNIQUE INDEX "meeting_contacts_unique_idx" ON "public"."meeting_contacts" USING "btree" ("meeting_id", "contact_id");



CREATE INDEX "pipeline_applications_cycle_idx" ON "public"."pipeline_applications" USING "btree" ("cycle_id");



CREATE INDEX "pipeline_cycles_target_idx" ON "public"."pipeline_cycles" USING "btree" ("target_company_id");



CREATE INDEX "pipeline_interview_rounds_cycle_idx" ON "public"."pipeline_interview_rounds" USING "btree" ("cycle_id");



CREATE INDEX "pipeline_notes_cycle_idx" ON "public"."pipeline_notes" USING "btree" ("cycle_id");



CREATE INDEX "pipeline_programs_cycle_idx" ON "public"."pipeline_programs" USING "btree" ("cycle_id");



CREATE UNIQUE INDEX "referrals_unique_idx" ON "public"."referrals" USING "btree" ("user_id", "referred_by_contact_id", "referred_contact_id", "referral_meeting_id");



CREATE UNIQUE INDEX "scrape_runs_one_pending_discovery_per_company" ON "public"."scrape_runs" USING "btree" ("user_id", "company_id") WHERE (("status" = 'pending'::"text") AND ("mode" = 'discovery'::"text") AND ("company_id" IS NOT NULL));



CREATE UNIQUE INDEX "scrape_runs_one_pending_per_contact" ON "public"."scrape_runs" USING "btree" ("user_id", "single_contact_id") WHERE (("status" = 'pending'::"text") AND ("single_contact_id" IS NOT NULL));



CREATE INDEX "scrape_runs_user_created_idx" ON "public"."scrape_runs" USING "btree" ("user_id", "created_at");



CREATE INDEX "scrape_runs_user_status_idx" ON "public"."scrape_runs" USING "btree" ("user_id", "status");



CREATE UNIQUE INDEX "tags_unique_idx" ON "public"."tags" USING "btree" ("user_id", "name");



CREATE UNIQUE INDEX "target_companies_user_company_companywide" ON "public"."target_companies" USING "btree" ("user_id", "company_id") WHERE ("location_id" IS NULL);



CREATE UNIQUE INDEX "target_companies_user_company_location" ON "public"."target_companies" USING "btree" ("user_id", "company_id", "location_id") WHERE ("location_id" IS NOT NULL);



CREATE UNIQUE INDEX "user_companies_unique_idx" ON "public"."user_companies" USING "btree" ("user_id", "company_id", "start_date");



CREATE UNIQUE INDEX "user_schools_unique_idx" ON "public"."user_schools" USING "btree" ("user_id", "school_id", "start_year");



ALTER TABLE ONLY "public"."action_item_contacts"
    ADD CONSTRAINT "action_item_contacts_action_item_id_fkey" FOREIGN KEY ("action_item_id") REFERENCES "public"."follow_up_action_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."action_item_contacts"
    ADD CONSTRAINT "action_item_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_follow_up_drafts"
    ADD CONSTRAINT "ai_follow_up_drafts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_follow_up_drafts"
    ADD CONSTRAINT "ai_follow_up_drafts_source_meeting_id_fkey" FOREIGN KEY ("source_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_follow_up_drafts"
    ADD CONSTRAINT "ai_follow_up_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attachments"
    ADD CONSTRAINT "attachments_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_access_overrides"
    ADD CONSTRAINT "bundle_access_overrides_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."data_bundles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_access_overrides"
    ADD CONSTRAINT "bundle_access_overrides_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bundle_access_overrides"
    ADD CONSTRAINT "bundle_access_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_companies"
    ADD CONSTRAINT "bundle_companies_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."data_bundles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_companies"
    ADD CONSTRAINT "bundle_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_contact_state"
    ADD CONSTRAINT "bundle_contact_state_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_contact_state"
    ADD CONSTRAINT "bundle_contact_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_prospects"
    ADD CONSTRAINT "bundle_prospects_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."data_bundles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_subscription_contacts"
    ADD CONSTRAINT "bundle_subscription_contacts_bundle_prospect_id_fkey" FOREIGN KEY ("bundle_prospect_id") REFERENCES "public"."bundle_prospects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bundle_subscription_contacts"
    ADD CONSTRAINT "bundle_subscription_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_subscription_contacts"
    ADD CONSTRAINT "bundle_subscription_contacts_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."bundle_subscriptions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_subscriptions"
    ADD CONSTRAINT "bundle_subscriptions_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "public"."data_bundles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bundle_subscriptions"
    ADD CONSTRAINT "bundle_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_contacts"
    ADD CONSTRAINT "calendar_event_contacts_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_contacts"
    ADD CONSTRAINT "calendar_event_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_locations"
    ADD CONSTRAINT "company_locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_locations"
    ADD CONSTRAINT "company_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id");



ALTER TABLE ONLY "public"."contact_attachments"
    ADD CONSTRAINT "contact_attachments_attachment_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_attachments"
    ADD CONSTRAINT "contact_attachments_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_change_events"
    ADD CONSTRAINT "contact_change_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_change_events"
    ADD CONSTRAINT "contact_change_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_companies"
    ADD CONSTRAINT "contact_companies_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."contact_companies"
    ADD CONSTRAINT "contact_companies_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_companies"
    ADD CONSTRAINT "contact_companies_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id");



ALTER TABLE ONLY "public"."contact_emails"
    ADD CONSTRAINT "contact_emails_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_phones"
    ADD CONSTRAINT "contact_phones_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_schools"
    ADD CONSTRAINT "contact_schools_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_schools"
    ADD CONSTRAINT "contact_schools_school_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");



ALTER TABLE ONLY "public"."contact_scrape_snapshots"
    ADD CONSTRAINT "contact_scrape_snapshots_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_scrape_snapshots"
    ADD CONSTRAINT "contact_scrape_snapshots_scrape_run_id_fkey" FOREIGN KEY ("scrape_run_id") REFERENCES "public"."scrape_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contact_scrape_snapshots"
    ADD CONSTRAINT "contact_scrape_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_tags"
    ADD CONSTRAINT "contact_tags_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_tags"
    ADD CONSTRAINT "contact_tags_tag_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."discovery_candidates"
    ADD CONSTRAINT "discovery_candidates_added_contact_id_fkey" FOREIGN KEY ("added_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."discovery_candidates"
    ADD CONSTRAINT "discovery_candidates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."discovery_candidates"
    ADD CONSTRAINT "discovery_candidates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_drafts"
    ADD CONSTRAINT "email_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_follow_up_messages"
    ADD CONSTRAINT "email_follow_up_messages_follow_up_id_fkey" FOREIGN KEY ("follow_up_id") REFERENCES "public"."email_follow_ups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_follow_ups"
    ADD CONSTRAINT "email_follow_ups_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_follow_ups"
    ADD CONSTRAINT "email_follow_ups_scheduled_email_id_fkey" FOREIGN KEY ("scheduled_email_id") REFERENCES "public"."scheduled_emails"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_follow_ups"
    ADD CONSTRAINT "email_follow_ups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_matched_contact_id_fkey" FOREIGN KEY ("matched_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_messages"
    ADD CONSTRAINT "email_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."follow_up_action_items"
    ADD CONSTRAINT "follow_up_action_items_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."follow_up_action_items"
    ADD CONSTRAINT "follow_up_action_items_meeting_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."follow_up_action_items"
    ADD CONSTRAINT "follow_up_action_items_related_action_item_id_fkey" FOREIGN KEY ("related_action_item_id") REFERENCES "public"."follow_up_action_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."follow_up_action_items"
    ADD CONSTRAINT "follow_up_action_items_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gmail_connections"
    ADD CONSTRAINT "gmail_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interaction_attachments"
    ADD CONSTRAINT "interaction_attachments_attachment_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interaction_attachments"
    ADD CONSTRAINT "interaction_attachments_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interactions"
    ADD CONSTRAINT "interactions_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_attachments"
    ADD CONSTRAINT "meeting_attachments_attachment_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_attachments"
    ADD CONSTRAINT "meeting_attachments_meeting_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_contacts"
    ADD CONSTRAINT "meeting_contacts_contact_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_contacts"
    ADD CONSTRAINT "meeting_contacts_meeting_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_transcript_attachment_id_fkey" FOREIGN KEY ("transcript_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."meetings"
    ADD CONSTRAINT "meetings_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_applications"
    ADD CONSTRAINT "pipeline_applications_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "public"."pipeline_cycles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_cycles"
    ADD CONSTRAINT "pipeline_cycles_target_company_id_fkey" FOREIGN KEY ("target_company_id") REFERENCES "public"."target_companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_interview_rounds"
    ADD CONSTRAINT "pipeline_interview_rounds_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "public"."pipeline_cycles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_notes"
    ADD CONSTRAINT "pipeline_notes_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "public"."pipeline_cycles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_programs"
    ADD CONSTRAINT "pipeline_programs_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "public"."pipeline_cycles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referrals"
    ADD CONSTRAINT "referrals_contact_fk" FOREIGN KEY ("referred_contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referrals"
    ADD CONSTRAINT "referrals_meeting_fk" FOREIGN KEY ("referral_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."referrals"
    ADD CONSTRAINT "referrals_referrer_fk" FOREIGN KEY ("referred_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referrals"
    ADD CONSTRAINT "referrals_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_matched_contact_id_fkey" FOREIGN KEY ("matched_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scheduled_emails"
    ADD CONSTRAINT "scheduled_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scrape_runs"
    ADD CONSTRAINT "scrape_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."scrape_runs"
    ADD CONSTRAINT "scrape_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."suppressed_imports"
    ADD CONSTRAINT "suppressed_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."target_companies"
    ADD CONSTRAINT "target_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."target_companies"
    ADD CONSTRAINT "target_companies_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."target_companies"
    ADD CONSTRAINT "target_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."target_company_notes"
    ADD CONSTRAINT "target_company_notes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."target_company_notes"
    ADD CONSTRAINT "target_company_notes_target_company_id_fkey" FOREIGN KEY ("target_company_id") REFERENCES "public"."target_companies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transcript_segments"
    ADD CONSTRAINT "transcript_segments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."transcript_segments"
    ADD CONSTRAINT "transcript_segments_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_ai_access"
    ADD CONSTRAINT "user_ai_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_api_keys"
    ADD CONSTRAINT "user_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_companies"
    ADD CONSTRAINT "user_companies_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."user_companies"
    ADD CONSTRAINT "user_companies_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_schools"
    ADD CONSTRAINT "user_schools_school_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");



ALTER TABLE ONLY "public"."user_schools"
    ADD CONSTRAINT "user_schools_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_extension_onboarding_contact_id_fkey" FOREIGN KEY ("extension_onboarding_contact_id") REFERENCES "public"."contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Authenticated users can insert locations" ON "public"."locations" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Locations are viewable by authenticated users" ON "public"."locations" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Service role full access to ai_follow_up_drafts" ON "public"."ai_follow_up_drafts" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access to email_follow_ups" ON "public"."email_follow_ups" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access to follow-up messages" ON "public"."email_follow_up_messages" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access to scheduled_emails" ON "public"."scheduled_emails" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role has full access to email_messages" ON "public"."email_messages" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role has full access to gmail_connections" ON "public"."gmail_connections" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Users can delete their follow-up messages" ON "public"."email_follow_up_messages" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."email_follow_ups"
  WHERE (("email_follow_ups"."id" = "email_follow_up_messages"."follow_up_id") AND ("email_follow_ups"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete their own drafts" ON "public"."ai_follow_up_drafts" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete their own email messages" ON "public"."email_messages" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete their own follow-ups" ON "public"."email_follow_ups" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete their own scheduled emails" ON "public"."scheduled_emails" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their follow-up messages" ON "public"."email_follow_up_messages" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."email_follow_ups"
  WHERE (("email_follow_ups"."id" = "email_follow_up_messages"."follow_up_id") AND ("email_follow_ups"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert their own drafts" ON "public"."ai_follow_up_drafts" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can insert their own email messages" ON "public"."email_messages" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own follow-ups" ON "public"."email_follow_ups" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own scheduled emails" ON "public"."scheduled_emails" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own calendar event contacts" ON "public"."calendar_event_contacts" USING ((EXISTS ( SELECT 1
   FROM "public"."calendar_events" "ce"
  WHERE (("ce"."id" = "calendar_event_contacts"."calendar_event_id") AND ("ce"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage own calendar events" ON "public"."calendar_events" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage their action item contacts" ON "public"."action_item_contacts" USING (("action_item_id" IN ( SELECT "follow_up_action_items"."id"
   FROM "public"."follow_up_action_items"
  WHERE ("follow_up_action_items"."user_id" = "auth"."uid"())))) WITH CHECK (("action_item_id" IN ( SELECT "follow_up_action_items"."id"
   FROM "public"."follow_up_action_items"
  WHERE ("follow_up_action_items"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can manage their own drafts" ON "public"."email_drafts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage their own templates" ON "public"."email_templates" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their follow-up messages" ON "public"."email_follow_up_messages" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."email_follow_ups"
  WHERE (("email_follow_ups"."id" = "email_follow_up_messages"."follow_up_id") AND ("email_follow_ups"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update their own drafts" ON "public"."ai_follow_up_drafts" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update their own email messages" ON "public"."email_messages" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own follow-ups" ON "public"."email_follow_ups" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own scheduled emails" ON "public"."scheduled_emails" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their follow-up messages" ON "public"."email_follow_up_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."email_follow_ups"
  WHERE (("email_follow_ups"."id" = "email_follow_up_messages"."follow_up_id") AND ("email_follow_ups"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view their own drafts" ON "public"."ai_follow_up_drafts" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view their own email messages" ON "public"."email_messages" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own follow-ups" ON "public"."email_follow_ups" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own gmail connection" ON "public"."gmail_connections" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own scheduled emails" ON "public"."scheduled_emails" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."action_item_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_audit_log_service_role_all" ON "public"."admin_audit_log" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."ai_follow_up_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."analytics_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attachments_delete_own" ON "public"."attachments" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "attachments_insert_own" ON "public"."attachments" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "attachments_select_own" ON "public"."attachments" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."bundle_access_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bundle_access_overrides_service_role_all" ON "public"."bundle_access_overrides" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."bundle_companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bundle_companies_select_subscribed" ON "public"."bundle_companies" FOR SELECT TO "authenticated" USING (("public"."bundle_visible_to"("bundle_id", ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."bundle_subscriptions" "bs"
  WHERE (("bs"."bundle_id" = "bundle_companies"."bundle_id") AND ("bs"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("bs"."status" = 'active'::"text"))))));



ALTER TABLE "public"."bundle_contact_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bundle_contact_state_delete_own" ON "public"."bundle_contact_state" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "bundle_contact_state_insert_own" ON "public"."bundle_contact_state" FOR INSERT WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."contacts" "c"
  WHERE (("c"."id" = "bundle_contact_state"."contact_id") AND ("c"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "bundle_contact_state_select_own" ON "public"."bundle_contact_state" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "bundle_contact_state_update_own" ON "public"."bundle_contact_state" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."bundle_prospects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bundle_prospects_select_subscribed" ON "public"."bundle_prospects" FOR SELECT TO "authenticated" USING (("public"."bundle_visible_to"("bundle_id", ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."bundle_subscriptions" "bs"
  WHERE (("bs"."bundle_id" = "bundle_prospects"."bundle_id") AND ("bs"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("bs"."status" = 'active'::"text"))))));



ALTER TABLE "public"."bundle_subscription_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bundle_subscription_contacts_delete_own" ON "public"."bundle_subscription_contacts" FOR DELETE USING (("subscription_id" IN ( SELECT "bundle_subscriptions"."id"
   FROM "public"."bundle_subscriptions"
  WHERE ("bundle_subscriptions"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "bundle_subscription_contacts_insert_own" ON "public"."bundle_subscription_contacts" FOR INSERT WITH CHECK ((("subscription_id" IN ( SELECT "bundle_subscriptions"."id"
   FROM "public"."bundle_subscriptions"
  WHERE ("bundle_subscriptions"."user_id" = ( SELECT "auth"."uid"() AS "uid")))) AND (EXISTS ( SELECT 1
   FROM "public"."contacts" "c"
  WHERE (("c"."id" = "bundle_subscription_contacts"."contact_id") AND ("c"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "bundle_subscription_contacts_select_own" ON "public"."bundle_subscription_contacts" FOR SELECT USING (("subscription_id" IN ( SELECT "bundle_subscriptions"."id"
   FROM "public"."bundle_subscriptions"
  WHERE ("bundle_subscriptions"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "bundle_subscription_contacts_update_own" ON "public"."bundle_subscription_contacts" FOR UPDATE USING (("subscription_id" IN ( SELECT "bundle_subscriptions"."id"
   FROM "public"."bundle_subscriptions"
  WHERE ("bundle_subscriptions"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) WITH CHECK ((("subscription_id" IN ( SELECT "bundle_subscriptions"."id"
   FROM "public"."bundle_subscriptions"
  WHERE ("bundle_subscriptions"."user_id" = ( SELECT "auth"."uid"() AS "uid")))) AND (EXISTS ( SELECT 1
   FROM "public"."contacts" "c"
  WHERE (("c"."id" = "bundle_subscription_contacts"."contact_id") AND ("c"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."bundle_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bundle_subscriptions_delete_own" ON "public"."bundle_subscriptions" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "bundle_subscriptions_insert_own" ON "public"."bundle_subscriptions" FOR INSERT WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "public"."bundle_visible_to"("bundle_id", ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "bundle_subscriptions_select_own" ON "public"."bundle_subscriptions" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "bundle_subscriptions_update_own" ON "public"."bundle_subscriptions" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."calendar_event_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "companies_insert_authenticated" ON "public"."companies" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "companies_select_all" ON "public"."companies" FOR SELECT USING (true);



CREATE POLICY "companies_update_authenticated" ON "public"."companies" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."company_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "company_locations_delete" ON "public"."company_locations" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "company_locations_insert" ON "public"."company_locations" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "company_locations_select" ON "public"."company_locations" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."contact_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_attachments_delete" ON "public"."contact_attachments" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "contact_attachments_insert" ON "public"."contact_attachments" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "contact_attachments_select" ON "public"."contact_attachments" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."contact_change_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_change_events_delete_own" ON "public"."contact_change_events" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "contact_change_events_insert_own" ON "public"."contact_change_events" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "contact_change_events_select_own" ON "public"."contact_change_events" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "contact_change_events_update_own" ON "public"."contact_change_events" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."contact_companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_companies_delete" ON "public"."contact_companies" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_companies_insert" ON "public"."contact_companies" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_companies_select" ON "public"."contact_companies" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_companies_update" ON "public"."contact_companies" FOR UPDATE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."contact_emails" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_emails_delete" ON "public"."contact_emails" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_emails_insert" ON "public"."contact_emails" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_emails_select" ON "public"."contact_emails" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_emails_update" ON "public"."contact_emails" FOR UPDATE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."contact_phones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_phones_delete" ON "public"."contact_phones" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "contact_phones_insert" ON "public"."contact_phones" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "contact_phones_select" ON "public"."contact_phones" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "contact_phones_update" ON "public"."contact_phones" FOR UPDATE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."contact_schools" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_schools_delete" ON "public"."contact_schools" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_schools_insert" ON "public"."contact_schools" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_schools_select" ON "public"."contact_schools" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_schools_update" ON "public"."contact_schools" FOR UPDATE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."contact_scrape_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_scrape_snapshots_select_own" ON "public"."contact_scrape_snapshots" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."contact_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_tags_delete" ON "public"."contact_tags" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_tags_insert" ON "public"."contact_tags" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "contact_tags_select" ON "public"."contact_tags" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contacts_delete_own" ON "public"."contacts" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "contacts_insert_own" ON "public"."contacts" FOR INSERT WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "contacts_select_own" ON "public"."contacts" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "contacts_update_own" ON "public"."contacts" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."data_bundles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "data_bundles_select_published" ON "public"."data_bundles" FOR SELECT TO "authenticated" USING ((("status" = 'published'::"text") AND "public"."bundle_visible_to"("id", ( SELECT "auth"."uid"() AS "uid"))));



ALTER TABLE "public"."discovery_candidates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "discovery_candidates_select_own" ON "public"."discovery_candidates" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."email_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_follow_up_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_follow_ups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."follow_up_action_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "follow_up_action_items_delete_own" ON "public"."follow_up_action_items" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "follow_up_action_items_insert_own" ON "public"."follow_up_action_items" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "follow_up_action_items_select_own" ON "public"."follow_up_action_items" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "follow_up_action_items_update_own" ON "public"."follow_up_action_items" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."gmail_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."interaction_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "interaction_attachments_delete" ON "public"."interaction_attachments" FOR DELETE USING (("interaction_id" IN ( SELECT "i"."id"
   FROM ("public"."interactions" "i"
     JOIN "public"."contacts" "c" ON (("c"."id" = "i"."contact_id")))
  WHERE ("c"."user_id" = "auth"."uid"()))));



CREATE POLICY "interaction_attachments_insert" ON "public"."interaction_attachments" FOR INSERT WITH CHECK (("interaction_id" IN ( SELECT "i"."id"
   FROM ("public"."interactions" "i"
     JOIN "public"."contacts" "c" ON (("c"."id" = "i"."contact_id")))
  WHERE ("c"."user_id" = "auth"."uid"()))));



CREATE POLICY "interaction_attachments_select" ON "public"."interaction_attachments" FOR SELECT USING (("interaction_id" IN ( SELECT "i"."id"
   FROM ("public"."interactions" "i"
     JOIN "public"."contacts" "c" ON (("c"."id" = "i"."contact_id")))
  WHERE ("c"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."interactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "interactions_delete" ON "public"."interactions" FOR DELETE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "interactions_insert" ON "public"."interactions" FOR INSERT WITH CHECK (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "interactions_select" ON "public"."interactions" FOR SELECT USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



CREATE POLICY "interactions_update" ON "public"."interactions" FOR UPDATE USING (("contact_id" IN ( SELECT "contacts"."id"
   FROM "public"."contacts"
  WHERE ("contacts"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."internal_analytics_emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meeting_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meeting_attachments_delete" ON "public"."meeting_attachments" FOR DELETE USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "meeting_attachments_insert" ON "public"."meeting_attachments" FOR INSERT WITH CHECK (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "meeting_attachments_select" ON "public"."meeting_attachments" FOR SELECT USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."meeting_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meeting_contacts_delete" ON "public"."meeting_contacts" FOR DELETE USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "meeting_contacts_insert" ON "public"."meeting_contacts" FOR INSERT WITH CHECK (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "meeting_contacts_select" ON "public"."meeting_contacts" FOR SELECT USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."meetings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetings_delete_own" ON "public"."meetings" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "meetings_insert_own" ON "public"."meetings" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "meetings_select_own" ON "public"."meetings" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "meetings_update_own" ON "public"."meetings" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."pipeline_applications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pipeline_applications_all_own" ON "public"."pipeline_applications" USING (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"())))) WITH CHECK (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."pipeline_cycles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pipeline_cycles_all_own" ON "public"."pipeline_cycles" USING (("target_company_id" IN ( SELECT "target_companies"."id"
   FROM "public"."target_companies"
  WHERE ("target_companies"."user_id" = "auth"."uid"())))) WITH CHECK (("target_company_id" IN ( SELECT "target_companies"."id"
   FROM "public"."target_companies"
  WHERE ("target_companies"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."pipeline_interview_rounds" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pipeline_interview_rounds_all_own" ON "public"."pipeline_interview_rounds" USING (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"())))) WITH CHECK (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."pipeline_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pipeline_notes_all_own" ON "public"."pipeline_notes" USING (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"())))) WITH CHECK (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."pipeline_programs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pipeline_programs_all_own" ON "public"."pipeline_programs" USING (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"())))) WITH CHECK (("cycle_id" IN ( SELECT "pc"."id"
   FROM ("public"."pipeline_cycles" "pc"
     JOIN "public"."target_companies" "tc" ON (("tc"."id" = "pc"."target_company_id")))
  WHERE ("tc"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."referrals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "referrals_delete_own" ON "public"."referrals" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "referrals_insert_own" ON "public"."referrals" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "referrals_select_own" ON "public"."referrals" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."scheduled_emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schools" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schools_insert_authenticated" ON "public"."schools" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "schools_select_all" ON "public"."schools" FOR SELECT USING (true);



ALTER TABLE "public"."scrape_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scrape_runs_select_own" ON "public"."scrape_runs" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "segments_delete" ON "public"."transcript_segments" FOR DELETE USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "segments_insert" ON "public"."transcript_segments" FOR INSERT WITH CHECK (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "segments_select" ON "public"."transcript_segments" FOR SELECT USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



CREATE POLICY "segments_update" ON "public"."transcript_segments" FOR UPDATE USING (("meeting_id" IN ( SELECT "meetings"."id"
   FROM "public"."meetings"
  WHERE ("meetings"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."suppressed_imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "suppressed_imports_delete_own" ON "public"."suppressed_imports" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "suppressed_imports_insert_own" ON "public"."suppressed_imports" FOR INSERT WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "suppressed_imports_select_own" ON "public"."suppressed_imports" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tags_delete_own" ON "public"."tags" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "tags_insert_own" ON "public"."tags" FOR INSERT WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "tags_select_own" ON "public"."tags" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "tags_update_own" ON "public"."tags" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."target_companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "target_companies_delete_own" ON "public"."target_companies" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "target_companies_insert_own" ON "public"."target_companies" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "target_companies_select_own" ON "public"."target_companies" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "target_companies_update_own" ON "public"."target_companies" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."target_company_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "target_company_notes_delete" ON "public"."target_company_notes" FOR DELETE USING (("target_company_id" IN ( SELECT "target_companies"."id"
   FROM "public"."target_companies"
  WHERE ("target_companies"."user_id" = "auth"."uid"()))));



CREATE POLICY "target_company_notes_insert" ON "public"."target_company_notes" FOR INSERT WITH CHECK (("target_company_id" IN ( SELECT "target_companies"."id"
   FROM "public"."target_companies"
  WHERE ("target_companies"."user_id" = "auth"."uid"()))));



CREATE POLICY "target_company_notes_select" ON "public"."target_company_notes" FOR SELECT USING (("target_company_id" IN ( SELECT "target_companies"."id"
   FROM "public"."target_companies"
  WHERE ("target_companies"."user_id" = "auth"."uid"()))));



CREATE POLICY "target_company_notes_update" ON "public"."target_company_notes" FOR UPDATE USING (("target_company_id" IN ( SELECT "target_companies"."id"
   FROM "public"."target_companies"
  WHERE ("target_companies"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."transcript_segments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_ai_access" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_ai_access_service_role_all" ON "public"."user_ai_access" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."user_api_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_api_keys_service_role_all" ON "public"."user_api_keys" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."user_companies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_companies_delete_own" ON "public"."user_companies" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_companies_insert_own" ON "public"."user_companies" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "user_companies_select_own" ON "public"."user_companies" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_companies_update_own" ON "public"."user_companies" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."user_milestones" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_schools" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_schools_delete_own" ON "public"."user_schools" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_schools_insert_own" ON "public"."user_schools" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "user_schools_select_own" ON "public"."user_schools" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_schools_update_own" ON "public"."user_schools" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_insert_own" ON "public"."users" FOR INSERT WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "users_select_own" ON "public"."users" FOR SELECT USING (("id" = "auth"."uid"()));



CREATE POLICY "users_update_own" ON "public"."users" FOR UPDATE USING (("id" = "auth"."uid"())) WITH CHECK ((("id" = "auth"."uid"()) AND ("status" = ( SELECT "u"."status"
   FROM "public"."users" "u"
  WHERE ("u"."id" = "auth"."uid"()))) AND ("apify_enrichment_enabled" = ( SELECT "u"."apify_enrichment_enabled"
   FROM "public"."users" "u"
  WHERE ("u"."id" = "auth"."uid"()))) AND ("diff_analysis_enabled" = ( SELECT "u"."diff_analysis_enabled"
   FROM "public"."users" "u"
  WHERE ("u"."id" = "auth"."uid"()))) AND ("discovery_enabled" = ( SELECT "u"."discovery_enabled"
   FROM "public"."users" "u"
  WHERE ("u"."id" = "auth"."uid"())))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_bundle_resolutions"("p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_bundle_resolutions"("p_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."bundle_alumni_stats"("p_bundle_id" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bundle_alumni_stats"("p_bundle_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bundle_alumni_stats"("p_bundle_id" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."bundle_company_stats"("p_bundle_id" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bundle_company_stats"("p_bundle_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bundle_company_stats"("p_bundle_id" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_internal_email"("p_email" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."network_tier_counts"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."network_tier_counts"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."replace_transcript_segments"("p_meeting_id" integer, "p_segments" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_transcript_segments"("p_meeting_id" integer, "p_segments" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."save_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer, "p_payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_pipeline_cycle"("p_target_company_id" integer, "p_cycle_number" integer, "p_payload" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."user_company_alumni_counts"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."user_company_alumni_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_company_alumni_counts"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."user_is_internal"("uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."user_is_internal"("uid" "uuid") TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."action_item_contacts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."action_item_contacts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."action_item_contacts" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."action_item_contacts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."action_item_contacts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."action_item_contacts_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_audit_log" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ai_follow_up_drafts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ai_follow_up_drafts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ai_follow_up_drafts" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."ai_follow_up_drafts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."ai_follow_up_drafts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."ai_follow_up_drafts_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."analytics_events" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."analytics_events" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."analytics_events" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."analytics_events_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."analytics_events_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."analytics_events_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."attachments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."attachments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."attachments" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."attachments_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."attachments_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."attachments_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_access_overrides" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_companies" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_companies" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_companies" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."bundle_companies_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."bundle_companies_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."bundle_companies_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_contact_state" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_contact_state" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_contact_state" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."bundle_contact_state_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."bundle_contact_state_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."bundle_contact_state_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_prospects" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_prospects" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_prospects" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."bundle_prospects_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."bundle_prospects_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."bundle_prospects_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_subscription_contacts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_subscription_contacts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_subscription_contacts" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."bundle_subscription_contacts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."bundle_subscription_contacts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."bundle_subscription_contacts_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_subscriptions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_subscriptions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bundle_subscriptions" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."bundle_subscriptions_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."bundle_subscriptions_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."bundle_subscriptions_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calendar_event_contacts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calendar_event_contacts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calendar_event_contacts" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calendar_events" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calendar_events" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calendar_events" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."calendar_events_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."calendar_events_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."calendar_events_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."companies" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."companies" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."companies" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."companies_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."companies_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."companies_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."company_locations" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."company_locations" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."company_locations" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."company_locations_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."company_locations_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."company_locations_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_attachments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_attachments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_attachments" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_change_events" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_change_events" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_change_events" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contact_change_events_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contact_change_events_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contact_change_events_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_companies" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_companies" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_companies" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contact_companies_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contact_companies_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contact_companies_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_emails" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_emails" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_emails" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contact_emails_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contact_emails_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contact_emails_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_phones" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_phones" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_phones" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contact_phones_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contact_phones_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contact_phones_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_schools" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_schools" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_schools" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contact_schools_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contact_schools_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contact_schools_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_scrape_snapshots" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_scrape_snapshots" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_scrape_snapshots" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contact_scrape_snapshots_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contact_scrape_snapshots_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contact_scrape_snapshots_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_tags" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_tags" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contact_tags" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contacts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contacts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."contacts" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."contacts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."contacts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."contacts_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."data_bundles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."data_bundles" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."data_bundles" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."data_bundles_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."data_bundles_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."data_bundles_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."discovery_candidates" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."discovery_candidates" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."discovery_candidates" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."discovery_candidates_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."discovery_candidates_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."discovery_candidates_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_drafts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_drafts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_drafts" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."email_drafts_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."email_drafts_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."email_drafts_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_follow_up_messages" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_follow_up_messages" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_follow_up_messages" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."email_follow_up_messages_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."email_follow_up_messages_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."email_follow_up_messages_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_follow_ups" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_follow_ups" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_follow_ups" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."email_follow_ups_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."email_follow_ups_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."email_follow_ups_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_messages" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_messages" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_messages" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."email_messages_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."email_messages_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."email_messages_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_templates" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_templates" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."email_templates" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."email_templates_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."email_templates_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."email_templates_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_up_action_items" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_up_action_items" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."follow_up_action_items" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."follow_up_action_items_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."follow_up_action_items_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."follow_up_action_items_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."gmail_connections" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."gmail_connections" TO "authenticated";



GRANT SELECT("user_id") ON TABLE "public"."gmail_connections" TO "authenticated";



GRANT SELECT("gmail_address") ON TABLE "public"."gmail_connections" TO "authenticated";



GRANT SELECT("last_gmail_sync_at") ON TABLE "public"."gmail_connections" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."gmail_connections" TO "authenticated";



GRANT SELECT("send_scope_granted") ON TABLE "public"."gmail_connections" TO "authenticated";



GRANT UPDATE ON SEQUENCE "public"."gmail_connections_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."gmail_connections_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."gmail_connections_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."interaction_attachments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."interaction_attachments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."interaction_attachments" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."interactions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."interactions" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."interactions" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."interactions_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."interactions_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."interactions_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."internal_analytics_emails" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."internal_analytics_emails" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."internal_analytics_emails" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."locations" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."locations" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."locations" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."locations_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."locations_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."locations_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meeting_attachments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meeting_attachments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meeting_attachments" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meeting_contacts" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meeting_contacts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meeting_contacts" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meetings" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meetings" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."meetings" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."meetings_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."meetings_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."meetings_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_applications" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_applications" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_applications" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_cycles" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_cycles" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_cycles" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."pipeline_cycles_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."pipeline_cycles_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."pipeline_cycles_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_interview_rounds" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_interview_rounds" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_interview_rounds" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_notes" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_notes" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_notes" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_programs" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_programs" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pipeline_programs" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."referrals" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."referrals" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."referrals" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."referrals_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."referrals_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."referrals_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scheduled_emails" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scheduled_emails" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scheduled_emails" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."scheduled_emails_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."scheduled_emails_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."scheduled_emails_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."schools" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."schools" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."schools" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."schools_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."schools_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."schools_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scrape_runs" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scrape_runs" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scrape_runs" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."scrape_runs_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."scrape_runs_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."scrape_runs_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."suppressed_imports" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."suppressed_imports" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."suppressed_imports" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."suppressed_imports_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."suppressed_imports_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."suppressed_imports_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tags" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tags" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."tags" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."tags_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."tags_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."tags_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."target_companies" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."target_companies" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."target_companies" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."target_companies_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."target_companies_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."target_companies_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."target_company_notes" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."target_company_notes" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."target_company_notes" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."target_company_notes_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."target_company_notes_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."target_company_notes_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."transcript_segments" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."transcript_segments" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."transcript_segments" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."transcript_segments_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."transcript_segments_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."transcript_segments_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_ai_access" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_api_keys" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_companies" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_companies" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_companies" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."user_companies_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_companies_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_companies_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_milestones" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_milestones" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_milestones" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_schools" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_schools" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_schools" TO "service_role";



GRANT UPDATE ON SEQUENCE "public"."user_schools_id_seq" TO "anon";
GRANT UPDATE ON SEQUENCE "public"."user_schools_id_seq" TO "authenticated";
GRANT UPDATE ON SEQUENCE "public"."user_schools_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."users" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."users" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."users" TO "service_role";



GRANT UPDATE("first_name") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("last_name") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("email") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("phone") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("updated_at") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("onboarding_state") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("extension_onboarding_state") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("extension_onboarding_contact_id") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("extension_last_seen_at") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("dismissed_getting_started") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("web_last_seen_at") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("followup_nudges_enabled") ON TABLE "public"."users" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";








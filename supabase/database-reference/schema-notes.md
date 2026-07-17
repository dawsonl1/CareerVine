# Database schema notes

This file preserves the per-table and per-column prose documentation that used to live inline in `src/lib/database.types.ts`, before that file became auto-generated (CAR-142).

The `.ts` file is now produced by `npm run gen:types` (which runs `supabase gen types typescript`), so hand-written comments no longer survive there. Going forward:

- Edit the **schema** through migration files under `supabase/migrations/`.
- Edit the **documentation** (table purposes, column semantics, gotchas) here in these notes.

## Conventions

The generated `Database` type organizes each table into `Row` / `Insert` / `Update` shapes:

- **Row**: what you get back from `SELECT` queries.
- **Insert**: what you can `INSERT` (excludes auto-generated fields).
- **Update**: what you can `UPDATE` (partial fields allowed).

Only the human-written prose is captured below. Mechanical type definitions are omitted. Every CAR-XX / plan-NN reference and every documented column note from the source is preserved.

---

## users

Extends `auth.users` with additional profile fields.

- `id`: UUID from `auth.users` (primary key).
- `first_name`: User's first name.
- `last_name`: User's last name.
- `email`: Optional email override.
- `phone`: Optional phone number.
- `status`: Account status (`"active"` | `"suspended"`); service-role writable only.
- `apify_enrichment_enabled`: Admin kill switch for all paid Apify activity (service-role writable only).
- `diff_analysis_enabled`: Admin kill switch for change-event production (service-role writable only).
- `discovery_enabled`: Admin switch for the weekly discovery feed, default off (service-role writable only).
- `onboarding_state`: Guided first-run progress (CAR-50), user-writable, forward-only in the app.
- `extension_onboarding_state`: Extension onboarding progress (CAR-68), user-writable, forward-only in the app.
- `extension_onboarding_contact_id`: First contact imported during the CAR-68 flow (redirect target).
- `extension_last_seen_at`: Last Bearer-authed extension API call, stamped in api-handler (CAR-68).
- `dismissed_getting_started`: Getting-started checklist row IDs the user dismissed on Home (CAR-73), user-writable.
- `web_last_seen_at`: Last authenticated WEB app activity (CAR-105), user-writable, throttled stamp in api-handler.
- `followup_nudges_enabled`: Opt-in for follow-up reminder emails (CAR-105), default true, user-writable.
- `created_at`: Auto-generated timestamp.
- `updated_at`: Auto-generated timestamp.

## user_api_keys

User-provided API keys (BYO OpenAI); service-role access only.

No per-column notes in the source.

## user_ai_access

Shared-token access entitlement (CAR-26); service-role access only. Default OFF: no row / `shared_access=false` means the user must BYO key.

- `granted_by`: Audit note: `'admin'`, admin uuid, or `'trial'` (CAR-51).
- `expires_at`: `NULL` = permanent grant; trial rows = first AI use + 24h (CAR-51).
- `access_requested_at`: Last "Request AI access" click after expiry (CAR-51).

## contacts

Core entity for professional network.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users` table.
- `name`: Contact's full name.
- `industry`: Industry/sector.
- `linkedin_url`: LinkedIn profile URL.
- `notes`: Free-form notes.
- `met_through`: How you met this contact.
- `follow_up_frequency_days`: Days between follow-ups.
- `preferred_contact_method`: Email/phone/LinkedIn.
- `preferred_contact_value`: Contact details.
- `contact_status`: `'student'` or `'professional'`.
- `expected_graduation`: e.g. "May 2027".
- `status_derived_at`: When `contact_status` was last derived/set.
- `location_id`: Foreign key to `locations` table.
- `photo_url`: Public URL of contact's profile photo in Supabase storage.
- `created_at`: Auto-generated timestamp.
- `reach_out_snoozed_until`: Hide from reach-out/recently-added until this time.
- `first_outreach_skipped`: Permanently skip first outreach.
- `suggestion_cooldown_until`: Suppress from AI suggestions until this time.
- `headline`: LinkedIn headline.
- `persona`: Pipeline-verified persona: `'alum_product'` | `'alum_other'` | `'product_peer'` | `'product_leader'` | `'recruiter'`.
- `review_note`: AI review reasoning from the scrape pipeline.
- `verified_school`: Agent-verified school: `'BYU'` | `'BYU-Idaho'` | `'Marriott'` | `'none'`.
- `import_source`: Scrape provenance, e.g. "apify:mini_a,c2:2026-07_tranche1".
- `import_meta`: Remaining pipeline provenance (adjacency_score, selection_reason, ...).
- `public_identifier`: LinkedIn profile slug (secondary dedupe key).
- `last_scraped_at`: When contact data was last refreshed by a scrape.
- `network_status`: `'active'` | `'prospect'` | `'bench'` (network tier segregation).
- `network_scope`: `'target_company'` | `'broad_network'`, the pipeline segment; `NULL` = not a pipeline import.
- `stage_override`: Manual override for the derived outreach stage.
- `scrape_failed_at`: Last failed scrape attempt (plan 29).
- `scrape_failure_count`: Consecutive failed scrapes; 0 on success.

## locations

Normalized geographic locations.

- `id`: Auto-incrementing primary key.
- `city`: City name (e.g., "San Francisco").
- `state`: State/province (e.g., "California" or "CA").
- `country`: Country name (e.g., "United States").

## contact_emails

Supports multiple emails per contact.

- `id`: Auto-incrementing primary key.
- `contact_id`: Foreign key to `contacts`.
- `email`: Email address.
- `is_primary`: Whether this is the primary email.
- `source`: `'manual'` | `'scraped'` | `'pattern_guessed'` | `'verified'` (monotonic upgrade only).
- `bounced_at`: Set when an NDR is detected for this address.

## contact_phones

Supports multiple phone numbers per contact.

- `id`: Auto-incrementing primary key.
- `contact_id`: Foreign key to `contacts`.
- `phone`: Phone number.
- `is_primary`: Whether this is the primary phone.
- `type`: Phone type (mobile, work, home).

## companies

Normalized list of companies.

- `id`: Auto-incrementing primary key.
- `name`: Company name (unique).
- `linkedin_company_id`: Stable LinkedIn numeric id (primary join key for scraped data).
- `linkedin_url`: LinkedIn company page URL.
- `universal_name`: LinkedIn company slug (e.g., "google").
- `logo_url`: Company logo URL.
- `name_normalized`: GENERATED (20260710170000) normalized matching key (read-only).

## company_locations

Known office locations per company (auto-managed office registry).

- `id`: Auto-incrementing primary key.
- `company_id`: Foreign key to `companies`.
- `location_id`: Foreign key to `locations`.
- `source`: `'scraped'` | `'manual'` (how the office was established).
- `created_at`: Auto-generated timestamp.

## contact_companies

Many-to-many relationship with role history.

- `id`: Auto-incrementing primary key.
- `contact_id`: Foreign key to `contacts`.
- `company_id`: Foreign key to `companies`.
- `title`: Job title at this company.
- `location`: Legacy free-text job location from manual entry (e.g., "San Francisco, CA").
- `start_date`: Employment start date (legacy).
- `end_date`: Employment end date (legacy).
- `start_month`: Job start month "Mon YYYY" (e.g., "Jan 2023").
- `end_month`: Job end month "Mon YYYY" or "Present".
- `is_current`: Whether this is current employment.
- `location_id`: Normalized metro-grain employment location (FK to `locations`).
- `location_source`: `'experience'` | `'profile_match'` | `'manual'` (how the location was determined).
- `location_raw`: Original scraped location string, kept for re-normalization.
- `workplace_type`: `'on_site'` | `'hybrid'` | `'remote'`.
- `employment_type`: e.g. "Full-time", "Internship".
- `source`: `'scraped'` | `'manual'` (row provenance for the merge engine).
- `scraped_at`: When this employment fact was last confirmed by a scrape.

## schools

Normalized list of educational institutions.

- `id`: Auto-incrementing primary key.
- `name`: School name (unique).

## contact_schools

Education history for contacts.

- `id`: Auto-incrementing primary key.
- `contact_id`: Foreign key to `contacts`.
- `school_id`: Foreign key to `schools`.
- `degree`: Degree obtained.
- `field_of_study`: Field/major.
- `start_year`: Start year.
- `end_year`: Graduation year.

## meetings

Track meetings with contacts.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `meeting_date`: When the meeting occurred.
- `meeting_type`: Type of meeting (coffee, video, etc.); optional for bare calendar events.
- `title`: Custom meeting name (overrides auto-generated).
- `notes`: Meeting notes (past meetings).
- `private_notes`: Private reminders for future meetings.
- `calendar_description`: Description for Google Calendar invite.
- `transcript`: Full transcript if available.
- `transcript_source`: How the transcript was added (paste, upload_txt, upload_vtt, upload_pdf, audio_deepgram).
- `transcript_parsed`: Whether transcript has been parsed into segments.
- `transcript_attachment_id`: Reference to uploaded file.
- `calendar_event_id`: Google Calendar event ID (links to `calendar_events`).

## transcript_segments

Structured speaker-attributed transcript turns.

No per-column notes in the source.

## meeting_contacts

Many-to-many relationship for attendees.

- `meeting_id`: Foreign key to `meetings`.
- `contact_id`: Foreign key to `contacts`.

## interactions

Track all touchpoints with contacts.

- `id`: Auto-incrementing primary key.
- `contact_id`: Foreign key to `contacts`.
- `interaction_date`: When interaction occurred.
- `interaction_type`: Type (email, call, coffee, etc.).
- `summary`: What was discussed.

## tags

User-defined tags for organizing contacts.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users` (tags are per-user).
- `name`: Tag name.

## contact_tags

Many-to-many relationship for tagging contacts.

- `contact_id`: Foreign key to `contacts`.
- `tag_id`: Foreign key to `tags`.

## attachments

File metadata for uploaded files.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `bucket`: Supabase storage bucket name.
- `object_path`: Path within bucket.
- `file_name`: Original filename.
- `content_type`: MIME type.
- `file_size_bytes`: File size.
- `is_public`: Whether file is publicly accessible.
- `notes`: File notes/description.
- `created_at`: Upload timestamp.

## contact_attachments

Link files to contacts.

- `contact_id`: Foreign key to `contacts`.
- `attachment_id`: Foreign key to `attachments`.

## meeting_attachments

Link files to meetings.

- `meeting_id`: Foreign key to `meetings`.
- `attachment_id`: Foreign key to `attachments`.

## interaction_attachments

Link files to interactions.

- `interaction_id`: Foreign key to `interactions`.
- `attachment_id`: Foreign key to `attachments`.

## gmail_connections

Per-user OAuth tokens for Gmail API access.

- `send_scope_granted`: CAR-100. Whether `gmail.send` was actually granted (browser-readable UX flag; granular consent can grant Calendar but not Gmail).
- `automatic_features_enabled`, `modify_scope_granted`: CAR-103 entitlement flags (service-role-only; hidden from the browser client by CAR-27 column grants).
- `premium_enabled`: CAR-102 premium master switch (service-role-only; same CAR-27 column-grant exclusion).

## email_messages

Lightweight metadata cache for Gmail messages.

- `ai_assisted`: Whether the outbound message body was AI-drafted (CAR-58).
- `body_html`: CAR-115. Full HTML body of an outbound message, persisted at send time so free-tier Outreach can re-read it. Null for pre-CAR-115 rows, inbound, and sync rows (UI falls back to snippet).

## scheduled_emails

Send-later queue.

No per-column notes in the source.

## email_follow_ups

Email follow-up sequences: scheduled follow-ups for sent emails.

No per-column notes in the source.

## email_follow_up_messages

Individual messages in a follow-up sequence.

- `parked_at`, `expires_at`, `reminder_count`, `last_reminder_at`, `seen_during_window`: CAR-105 nudge + active-aware expiry anchors.
- `claimed_at`: CAR-139 send-driver claim timestamp (stale-claim sweep anchor).

## email_templates

User-defined AI email generation templates.

No per-column notes in the source.

## email_drafts

Auto-saved compose state.

No per-column notes in the source.

## action_item_contacts

Junction table: many-to-many between action items and contacts.

No per-column notes in the source.

## ai_follow_up_drafts

AI-generated follow-up emails for user review.

No per-column notes in the source.

## follow_up_action_items

General follow-up tasks.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `contact_id`: Optional foreign key to `contacts`.
- `meeting_id`: Optional foreign key to `meetings`.
- `title`: Task title.
- `description`: Task description.
- `due_at`: Due date.
- `is_completed`: Completion status.
- `created_at`: Creation timestamp.
- `completed_at`: Completion timestamp.
- `priority`: `'high'` | `'medium'` | `'low'` | null.
- `source`: `'manual'` | `'ai_suggestion'` | `'ai_transcript'`.
- `suggestion_reason_type`: Type of AI suggestion reason.
- `suggestion_headline`: AI-generated contextual headline.
- `suggestion_evidence`: Evidence backing the suggestion.
- `direction`: `'my_task'` | `'waiting_on'`.
- `assigned_speaker`: Original speaker label from transcript.
- `related_action_item_id`: FK to linked paired item.
- `snoozed_until`: Hide until this time.

## target_companies

User-scoped recruiting layer over companies.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `company_id`: Foreign key to `companies`.
- `priority_score`: Priority score from the target sheet.
- `tier`: Segment/geo label (e.g. "Utah/Silicon Slopes", "Big Tech").
- `program_name`: The APM/rotational program's actual name.
- `app_window_text`: Free-text application-window hint (display only).
- `next_app_date`: Real application date set by hand; the only field sorting/alerts use.
- `status`: `'researching'` | `'outreach_active'` | `'applied'` | `'interviewing'` | `'closed'`.
- `location_id`: `NULL` = company-wide scope; set = office-scoped target (CAR-6).
- `is_targeted`: Soft targeting flag: false keeps pipeline data while hiding from target views.
- `active_cycle`: Pipeline cycle the user last worked in for this scope.
- `last_discovery_at`: When the discovery cron last queried this company (plan 41).
- `created_at`: Auto-generated timestamp.
- `updated_at`: Auto-generated timestamp.

## pipeline_cycles

One application cycle per target scope (CAR-6).

- `id`: Auto-incrementing primary key.
- `target_company_id`: Foreign key to `target_companies` (the scope).
- `cycle_number`: 1-based cycle index within the scope.
- `selected_stage`: `'researching'` | `'outreach_active'` | `'applied'` | `'interviewing'` | `'closed'`.
- `declined_next_cycle`: Closed stage: user declined to start another cycle.
- `created_at`: Auto-generated timestamp.
- `updated_at`: Auto-generated timestamp.

## pipeline_programs

Researching-stage programs per pipeline cycle (CAR-6).

- `id`: Client-generated uuid.
- `cycle_id`: Foreign key to `pipeline_cycles`.
- `name`: Program name.
- `apps_open`: Free text or "date:YYYY-MM-DD" sentinel.
- `job_potential`: Free text.
- `position`: Display order within the cycle.
- `created_at`: Auto-generated timestamp.

## pipeline_notes

Researching-stage notes per pipeline cycle (CAR-6).

- `id`: Client-generated uuid.
- `cycle_id`: Foreign key to `pipeline_cycles`.
- `body`: Note text.
- `position`: Display order within the cycle.
- `created_at`: Auto-generated timestamp.

## pipeline_applications

Applied-stage job applications per pipeline cycle (CAR-6).

- `id`: Client-generated uuid.
- `cycle_id`: Foreign key to `pipeline_cycles`.
- `job_title`: Role applied for.
- `location`: Free-text location (editable at company scope; office scope implies it).
- `date_applied`: ISO date (YYYY-MM-DD).
- `resume_path`: Storage path in application-files bucket.
- `resume_name`: Original filename.
- `position`: Display order within the cycle.
- `created_at`: Auto-generated timestamp.

(`resume_size_bytes`, `cover_letter_path`, `cover_letter_name`, and `cover_letter_size_bytes` carry no prose notes in the source.)

## pipeline_interview_rounds

Interviewing-stage rounds per pipeline cycle (CAR-6).

- `id`: Client-generated uuid.
- `cycle_id`: Foreign key to `pipeline_cycles`.
- `interview_date`: ISO date (YYYY-MM-DD).
- `interviewer`: Who's interviewing.
- `questions`: Prep / notes text.
- `position`: Display order within the cycle.
- `created_at`: Auto-generated timestamp.

## target_company_notes

Timestamped recruiting-intel log.

- `id`: Auto-incrementing primary key.
- `target_company_id`: Foreign key to `target_companies`.
- `note`: The recruiting-intel note.
- `location_id`: Optional office tag (FK to `locations`).
- `created_at`: Auto-generated timestamp.

## suppressed_imports

Tombstones so deleted imported contacts don't resurrect.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `linkedin_url`: Canonical `linkedin_url` of the deleted contact.
- `created_at`: Auto-generated timestamp.

## contact_change_events

Detected changes worth an outreach touch (plan 29).

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `contact_id`: Foreign key to `contacts`.
- `type`: `'anniversary'` | `'company_change'` | `'promotion'` | `'hiring'` | `'open_to_work'` | `'certification'` | `'location_change'`.
- `tier`: 1 act-now, 2 touchpoint, 3 silent.
- `dedupe_key`: Stable idempotency key.
- `headline`: Display "why".
- `evidence`: Backing detail.
- `suggested_title`: Prefilled action item title.
- `old_value`: For scrape diffs.
- `status`: `'new'` | `'actioned'` | `'dismissed'` | `'snoozed'`.

(`suggested_description`, `new_value`, `snoozed_until`, `detected_at`, and `actioned_at` carry no prose notes in the source.)

## scrape_runs

Apify run ledger (plan 29).

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `apify_run_id`: Apify run id (null until the run is started).
- `actor`: Apify actor full name.
- `mode`: `'profile'` | `'email'` | `'resolve'` | `'discovery'`.
- `trigger`: `'manual'` | `'enrich_on_save'` | `'cadence'` | `'discovery'`.
- `contact_ids`: Contacts covered by this run.
- `single_contact_id`: The one contact a run targets (in-flight guard).
- `company_id`: Discovery runs: the company searched (plan 41).
- `status`: `'pending'` | `'succeeded'` | `'failed'` | `'timed_out'`.
- `cost_usd`: Actual run cost (0 until succeeded).
- `ingest_claimed_at`: Webhook ingest's atomic claim (CAS; stale >10min = re-claimable).

(`error`, `created_at`, and `finished_at` carry no prose notes in the source.)

## contact_scrape_snapshots

Normalized per-scrape profile subset (plan 29).

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `contact_id`: Foreign key to `contacts`.
- `scrape_run_id`: Producing `scrape_runs` row (null if run deleted).
- `snapshot`: Normalized subset (see `ScrapeSnapshot` in `diff-engine.ts`).

(`scraped_at` carries no prose note in the source.)

## discovery_candidates

Strangers found by the weekly target-company people search (plan 41). Dismiss is sticky; writes via service client.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `company_id`: Foreign key to `companies` (the target searched).
- `linkedin_url`: Canonical LinkedIn profile URL (dedupe key).
- `public_identifier`: LinkedIn slug (secondary dedupe key).
- `position`: Current title at the target company, when known.
- `raw`: Short-profile item as returned by the actor.
- `status`: `'new'` | `'added'` | `'dismissed'`.
- `added_contact_id`: Contact created from this candidate.

(`name`, `headline`, `location`, `photo_url`, `first_seen_at`, and `last_seen_at` carry no prose notes in the source.)

## data_bundles

Admin-curated prospect/company bundle catalog.

- `id`: Auto-incrementing primary key.
- `slug`: Unique bundle identifier (e.g. "ib-banks-nyc").
- `name`: Display name.
- `description`: Display description.
- `version`: Last COMMITTED publish version (0 = never published).
- `staging_version`: Publish lock: version+1 while a publish is in flight.
- `staging_claimed_at`: When the publish lock was claimed.
- `status`: `'draft'` | `'published'` | `'archived'`.
- `prospect_count`: Denormalized live-prospect count (recomputed at finalize).
- `company_count`: Denormalized company count (recomputed at finalize).
- `published_at`: First/last publish timestamp.
- `default_visible`: Hidden-until-granted default (false = hidden); per-account overrides win.
- `created_at`: Auto-generated timestamp.
- `updated_at`: Auto-generated timestamp.

## bundle_access_overrides

Per-(user, bundle) visibility override; service-role access only.

- `user_id`: FK to `users`.
- `bundle_id`: FK to `data_bundles`.
- `allowed`: true = grant a hidden bundle; false = hide a visible one.
- `updated_by`: Admin who set it.
- `updated_at`: Auto-generated timestamp.

## admin_audit_log

Admin action audit trail; service-role access only.

- `id`: UUID primary key.
- `admin_id`: FK to `users` (the acting admin).
- `target_user_id`: FK to `users` (account acted upon).
- `action`: Action slug.
- `detail`: jsonb context.
- `outcome`: Whether the action succeeded (`"ok"` | `"error"`).
- `created_at`: Auto-generated timestamp.

## bundle_prospects

Versioned bundle content (CareerVine-owned payload contract).

- `id`: Auto-incrementing primary key.
- `bundle_id`: Foreign key to `data_bundles`.
- `linkedin_url`: Canonical LinkedIn profile URL.
- `payload`: `BundleProspectPayloadV1` (validated at publish).
- `payload_schema_version`: Payload contract version (sync skips unknown versions).
- `payload_hash`: sha256 of canonical payload JSON (change detection).
- `version_added`: Publish version that introduced the prospect.
- `version_updated`: Bumped when `payload_hash` changes (drives deltas).
- `version_last_seen`: Bumped every publish the prospect appears in.
- `removed_in_version`: Soft delete (`NULL` = live).
- `created_at`: Auto-generated timestamp.
- `updated_at`: Auto-generated timestamp.

## bundle_companies

Membership links (company data lives in shared tables).

- `id`: Auto-incrementing primary key.
- `bundle_id`: Foreign key to `data_bundles`.
- `company_id`: Foreign key to `companies` (shared/global).
- `version_last_seen`: Staging version of the last publish run that included this company; unstamped rows are pruned at finalize (CAR-63).
- `created_at`: Auto-generated timestamp.

## bundle_subscriptions

User ↔ bundle: sync progress + serialization claim.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `bundle_id`: Foreign key to `data_bundles`.
- `status`: `'active'` | `'unsubscribed'` (row kept on unsubscribe).
- `synced_version`: Last FULLY applied bundle version (advances to pinned version only).
- `last_synced_at`: When the last full sync completed.
- `sync_claimed_until`: Serialization claim so concurrent sync drivers can't race.
- `sync_cursor`: Mid-sync checkpoint {phase, afterId, pinnedVersion}; cleared on commit/resubscribe.
- `unsubscribe_keep_all`: Pending unsubscribe cleanup intent; non-null = removal loop unfinished.
- `created_at`: Auto-generated timestamp.
- `updated_at`: Auto-generated timestamp.

## bundle_subscription_contacts

Which contacts a subscription supplied.

- `id`: Auto-incrementing primary key.
- `subscription_id`: Foreign key to `bundle_subscriptions`.
- `contact_id`: Foreign key to `contacts`.
- `bundle_prospect_id`: Durable removal-correlation key (FK to `bundle_prospects`).
- `linkedin_url`: Canonical URL at apply time (debugging/secondary key).
- `created_by_bundle`: true = bundle created the contact; false = merged into existing.
- `first_applied_version`: Bundle version at first apply.
- `last_applied_version`: Bundle version at most recent apply.
- `last_applied_at`: When this contact was last touched by a sync.

## bundle_contact_state

Per-(user, contact) fingerprint baseline + sticky touched flag.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `contact_id`: Foreign key to `contacts`.
- `applied_fingerprint`: Hash of user-editable surface after last bundle apply.
- `user_touched`: Sticky: once true, bundle machinery never deletes this contact.
- `apply_started_at`: In-flight marker for crash-safe fingerprint recovery.
- `updated_at`: Auto-generated timestamp.

## referrals

Contact referred you to another contact.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `referred_by_contact_id`: Contact who made the referral.
- `referred_contact_id`: Contact who was referred.
- `referral_meeting_id`: Optional meeting where the referral happened.
- `notes`: Referral notes.

## calendar_events

Google Calendar sync cache.

- `id`: bigserial primary key.
- `user_id`: Foreign key to `users`.
- `google_event_id`: Google Calendar event ID.
- `calendar_id`: Source calendar (default `'primary'`).
- `status`: confirmed | tentative | cancelled.
- `contact_id`: Optional linked contact.
- `meeting_id`: Optional linked meeting.

(`title`, `description`, `start_at`, `end_at`, `all_day`, `location`, `meet_link`, `zoom_link`, `attendees`, `is_private`, `recurring_event_id`, `source_gmail_thread_id`, `source_gmail_message_id`, `synced_at`, and `created_at` carry no prose notes in the source.)

## calendar_event_contacts

Junction between calendar events and contacts.

- `calendar_event_id`: Foreign key to `calendar_events`.
- `contact_id`: Foreign key to `contacts`.

## user_companies

The user's own employment history.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `company_id`: Foreign key to `companies`.
- `title`: Job title.
- `start_date`: Employment start date.
- `end_date`: Employment end date.
- `is_current`: Whether this is current employment.

## user_schools

The user's own education history.

- `id`: Auto-incrementing primary key.
- `user_id`: Foreign key to `users`.
- `school_id`: Foreign key to `schools`.
- `degree`: Degree obtained.
- `field_of_study`: Field/major.
- `start_year`: Start year.
- `end_year`: Graduation year.

---

## Hand-authored enums (relocated to `src/lib/app-types.ts`)

These two enums are hand-authored (not part of the generated Supabase output), so they cannot live in the auto-generated `database.types.ts`. They are being relocated to `src/lib/app-types.ts`. Their documentation is preserved here.

### OnboardingState (CAR-50)

Guided first-run onboarding progress (CAR-50). Mirrors the CHECK constraint in `20260711003000_user_onboarding_state.sql`; the states are the flow's resume points.

Allowed values:

- `"not_started"`
- `"connect"`
- `"syncing"`
- `"pick_company"`
- `"outreach"`
- `"completed"`
- `"skipped"`

### ExtensionOnboardingState (CAR-68)

Extension onboarding flow progress (CAR-68). Mirrors the CHECK constraint in `20260711140000_extension_onboarding.sql`; the states are the flow's resume points. `'done'` and `'completed_no_apollo'` are both terminal.

Allowed values:

- `"not_started"`
- `"started"`
- `"awaiting_connect"`
- `"awaiting_first_contact"`
- `"email_offer"`
- `"apollo_intro"`
- `"apollo_install"`
- `"apollo_howto"`
- `"awaiting_email_contact"`
- `"done"` (terminal)
- `"completed_no_apollo"` (terminal)

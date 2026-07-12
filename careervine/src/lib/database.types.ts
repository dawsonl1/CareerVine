/**
 * TypeScript types for Supabase database schema
 * 
 * This file defines TypeScript types that match your Supabase database schema.
 * These types provide:
 * - Type safety for all database operations
 * - Autocomplete in your IDE
 * - Compile-time error checking
 * - Documentation of the database structure
 * 
 * You can generate these automatically with:
 * supabase gen types typescript --local > src/lib/database.types.ts
 * 
 * The types are organized by:
 * - Database > public schema > Tables > table name > Row/Insert/Update
 * - Row: What you get from SELECT queries
 * - Insert: What you can INSERT (excludes auto-generated fields)
 * - Update: What you can UPDATE (partial fields allowed)
 */

// Guided first-run onboarding progress (CAR-50). Mirrors the CHECK constraint
// in 20260711003000_user_onboarding_state.sql; states are the flow's resume points.
export type OnboardingState =
  | "not_started"
  | "connect"
  | "syncing"
  | "pick_company"
  | "outreach"
  | "completed"
  | "skipped";

// Extension onboarding flow progress (CAR-68). Mirrors the CHECK constraint in
// 20260711140000_extension_onboarding.sql; states are the flow's resume points.
// 'done' and 'completed_no_apollo' are both terminal.
export type ExtensionOnboardingState =
  | "not_started"
  | "started"
  | "awaiting_connect"
  | "awaiting_first_contact"
  | "email_offer"
  | "apollo_intro"
  | "apollo_install"
  | "apollo_howto"
  | "awaiting_email_contact"
  | "done"
  | "completed_no_apollo";

export type Database = {
  public: {
    Tables: {
      // Users table - extends auth.users with additional profile fields
      users: {
        Row: {
          id: string;                   // UUID from auth.users (primary key)
          first_name: string;            // User's first name
          last_name: string;             // User's last name
          email: string | null;          // Optional email override
          phone: string | null;          // Optional phone number
          status: "active" | "suspended"; // Account status — service-role writable only
          apify_enrichment_enabled: boolean; // Admin kill switch: all paid Apify activity (service-role writable only)
          diff_analysis_enabled: boolean;    // Admin kill switch: change-event production (service-role writable only)
          discovery_enabled: boolean;        // Admin switch: weekly discovery feed, default off (service-role writable only)
          onboarding_state: OnboardingState; // Guided first-run progress (CAR-50) — user-writable, forward-only in app
          extension_onboarding_state: ExtensionOnboardingState; // Extension onboarding progress (CAR-68) — user-writable, forward-only in app
          extension_onboarding_contact_id: number | null; // First contact imported during the CAR-68 flow (redirect target)
          extension_last_seen_at: string | null; // Last Bearer-authed extension API call — stamped in api-handler (CAR-68)
          dismissed_getting_started: string[]; // Getting-started checklist row IDs the user dismissed on Home (CAR-73) — user-writable
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<
          Database["public"]["Tables"]["users"]["Row"],
          "id" | "status" | "apify_enrichment_enabled" | "diff_analysis_enabled" | "discovery_enabled" | "onboarding_state" | "extension_onboarding_state" | "extension_onboarding_contact_id" | "extension_last_seen_at" | "dismissed_getting_started" | "created_at" | "updated_at"
        > & {
          status?: "active" | "suspended";
          apify_enrichment_enabled?: boolean;
          diff_analysis_enabled?: boolean;
          discovery_enabled?: boolean;
          onboarding_state?: OnboardingState;
          extension_onboarding_state?: ExtensionOnboardingState;
          extension_onboarding_contact_id?: number | null;
          extension_last_seen_at?: string | null;
          dismissed_getting_started?: string[];
        };
        Update: Partial<Database["public"]["Tables"]["users"]["Insert"]>;
      };

      // User-provided API keys (BYO OpenAI) — service-role access only
      user_api_keys: {
        Row: {
          user_id: string;
          provider: string;
          encrypted_key: string;
          key_last4: string;
          status: "active" | "invalid" | "quota_exceeded";
          last_validated_at: string | null;
          last_used_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["user_api_keys"]["Row"], "created_at" | "updated_at"> & {
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_api_keys"]["Insert"]>;
      };

      // Shared-token access entitlement (CAR-26) — service-role access only.
      // Default OFF: no row / shared_access=false means the user must BYO key.
      user_ai_access: {
        Row: {
          user_id: string;
          shared_access: boolean;
          granted_at: string | null;
          granted_by: string | null;          // audit note: 'admin', admin uuid, or 'trial' (CAR-51)
          expires_at: string | null;          // NULL = permanent grant; trial rows = first AI use + 24h (CAR-51)
          access_requested_at: string | null; // last "Request AI access" click after expiry (CAR-51)
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["user_ai_access"]["Row"], "shared_access" | "granted_at" | "granted_by" | "expires_at" | "access_requested_at" | "created_at" | "updated_at"> & {
          shared_access?: boolean;
          granted_at?: string | null;
          granted_by?: string | null;
          expires_at?: string | null;
          access_requested_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_ai_access"]["Insert"]>;
      };

      // Contacts table - core entity for professional network
      contacts: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users table
          name: string;                  // Contact's full name
          industry: string | null;       // Industry/sector
          linkedin_url: string | null;   // LinkedIn profile URL
          notes: string | null;          // Free-form notes
          met_through: string | null;    // How you met this contact
          follow_up_frequency_days: number | null;  // Days between follow-ups
          preferred_contact_method: string | null;  // Email/phone/LinkedIn
          preferred_contact_value: string | null;   // Contact details
          contact_status: string | null;            // 'student' or 'professional'
          expected_graduation: string | null;       // e.g. "May 2027"
          status_derived_at: string | null;         // When contact_status was last derived/set
          location_id: number | null;    // Foreign key to locations table
          photo_url: string | null;      // Public URL of contact's profile photo in Supabase storage
          created_at: string;            // Auto-generated timestamp
          reach_out_snoozed_until: string | null;  // Hide from reach-out/recently-added until this time
          first_outreach_skipped: boolean;          // Permanently skip first outreach
          suggestion_cooldown_until: string | null; // Suppress from AI suggestions until this time
          headline: string | null;       // LinkedIn headline
          persona: string | null;        // Pipeline-verified persona: 'alum_product' | 'alum_other' | 'product_peer' | 'product_leader' | 'recruiter'
          review_note: string | null;    // AI review reasoning from the scrape pipeline
          verified_school: string | null; // Agent-verified school: 'BYU' | 'BYU-Idaho' | 'Marriott' | 'none'
          import_source: string | null;  // Scrape provenance, e.g. "apify:mini_a,c2:2026-07_tranche1"
          import_meta: Record<string, unknown> | null; // Remaining pipeline provenance (adjacency_score, selection_reason, ...)
          public_identifier: string | null; // LinkedIn profile slug — secondary dedupe key
          last_scraped_at: string | null; // When contact data was last refreshed by a scrape
          network_status: string;        // 'active' | 'prospect' | 'bench' — network tier segregation
          network_scope: string | null;  // 'target_company' | 'broad_network' — pipeline segment; NULL = not a pipeline import
          stage_override: string | null; // Manual override for the derived outreach stage
          scrape_failed_at: string | null; // Last failed scrape attempt (plan 29)
          scrape_failure_count: number;   // Consecutive failed scrapes; 0 on success
        };
        Insert: Omit<Database["public"]["Tables"]["contacts"]["Row"], "id" | "status_derived_at" | "photo_url" | "created_at" | "reach_out_snoozed_until" | "first_outreach_skipped" | "suggestion_cooldown_until" | "headline" | "persona" | "review_note" | "verified_school" | "import_source" | "import_meta" | "public_identifier" | "last_scraped_at" | "network_status" | "network_scope" | "stage_override" | "scrape_failed_at" | "scrape_failure_count"> & {
          status_derived_at?: string | null;
          photo_url?: string | null;
          created_at?: string;
          reach_out_snoozed_until?: string | null;
          first_outreach_skipped?: boolean;
          suggestion_cooldown_until?: string | null;
          headline?: string | null;
          persona?: string | null;
          review_note?: string | null;
          verified_school?: string | null;
          import_source?: string | null;
          import_meta?: Record<string, unknown> | null;
          public_identifier?: string | null;
          last_scraped_at?: string | null;
          network_status?: string;
          network_scope?: string | null;
          stage_override?: string | null;
          scrape_failed_at?: string | null;
          scrape_failure_count?: number;
        };
        Update: Partial<Database["public"]["Tables"]["contacts"]["Insert"]>;
      };
      
      // Locations table - normalized geographic locations
      locations: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          city: string | null;           // City name (e.g., "San Francisco")
          state: string | null;          // State/province (e.g., "California" or "CA")
          country: string;               // Country name (e.g., "United States")
        };
        Insert: Omit<Database["public"]["Tables"]["locations"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["locations"]["Insert"]>;
      };
      
      // Contact emails - supports multiple emails per contact
      contact_emails: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          contact_id: number;            // Foreign key to contacts
          email: string | null;          // Email address
          is_primary: boolean;            // Whether this is the primary email
          source: string;                // 'manual' | 'scraped' | 'pattern_guessed' | 'verified' — monotonic upgrade only
          bounced_at: string | null;     // Set when an NDR is detected for this address
        };
        Insert: Omit<Database["public"]["Tables"]["contact_emails"]["Row"], "id" | "source" | "bounced_at"> & {
          source?: string;
          bounced_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["contact_emails"]["Insert"]>;
      };
      
      // Contact phones - supports multiple phone numbers per contact
      contact_phones: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          contact_id: number;            // Foreign key to contacts
          phone: string;                 // Phone number
          is_primary: boolean;            // Whether this is the primary phone
          type: string;                  // Phone type (mobile, work, home)
        };
        Insert: Omit<Database["public"]["Tables"]["contact_phones"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["contact_phones"]["Insert"]>;
      };
      
      // Companies table - normalized list of companies
      companies: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          name: string;                  // Company name (unique)
          linkedin_company_id: string | null; // Stable LinkedIn numeric id — primary join key for scraped data
          linkedin_url: string | null;   // LinkedIn company page URL
          universal_name: string | null; // LinkedIn company slug (e.g., "google")
          logo_url: string | null;       // Company logo URL
          name_normalized: string | null; // GENERATED (20260710170000) normalized matching key — read-only
        };
        Insert: Omit<Database["public"]["Tables"]["companies"]["Row"], "id" | "linkedin_company_id" | "linkedin_url" | "universal_name" | "logo_url" | "name_normalized"> & {
          id?: number;
          linkedin_company_id?: string | null;
          linkedin_url?: string | null;
          universal_name?: string | null;
          logo_url?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["companies"]["Insert"]>;
      };

      // Company locations - known office locations per company (auto-managed office registry)
      company_locations: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          company_id: number;            // Foreign key to companies
          location_id: number;           // Foreign key to locations
          source: string;                // 'scraped' | 'manual' — how the office was established
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["company_locations"]["Row"], "id" | "source" | "created_at"> & {
          source?: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["company_locations"]["Insert"]>;
      };

      // Contact companies - many-to-many relationship with role history
      contact_companies: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          contact_id: number;            // Foreign key to contacts
          company_id: number;            // Foreign key to companies
          title: string | null;          // Job title at this company
          location: string | null;       // Legacy free-text job location from manual entry (e.g., "San Francisco, CA")
          start_date: string | null;     // Employment start date (legacy)
          end_date: string | null;       // Employment end date (legacy)
          start_month: string | null;    // Job start month "Mon YYYY" (e.g., "Jan 2023")
          end_month: string | null;      // Job end month "Mon YYYY" or "Present"
          is_current: boolean;            // Whether this is current employment
          location_id: number | null;    // Normalized metro-grain employment location (FK to locations)
          location_source: string | null; // 'experience' | 'profile_match' | 'manual' — how the location was determined
          location_raw: string | null;   // Original scraped location string, kept for re-normalization
          workplace_type: string | null; // 'on_site' | 'hybrid' | 'remote'
          employment_type: string | null; // e.g. "Full-time", "Internship"
          source: string;                // 'scraped' | 'manual' — row provenance for the merge engine
          scraped_at: string | null;     // When this employment fact was last confirmed by a scrape
        };
        Insert: Omit<Database["public"]["Tables"]["contact_companies"]["Row"], "id" | "location_id" | "location_source" | "location_raw" | "workplace_type" | "employment_type" | "source" | "scraped_at"> & {
          location_id?: number | null;
          location_source?: string | null;
          location_raw?: string | null;
          workplace_type?: string | null;
          employment_type?: string | null;
          source?: string;
          scraped_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["contact_companies"]["Insert"]>;
      };
      
      // Schools table - normalized list of educational institutions
      schools: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          name: string;                  // School name (unique)
        };
        Insert: Omit<Database["public"]["Tables"]["schools"]["Row"], "id"> & { id?: number };
        Update: Partial<Database["public"]["Tables"]["schools"]["Insert"]>;
      };
      
      // Contact schools - education history for contacts
      contact_schools: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          contact_id: number;            // Foreign key to contacts
          school_id: number;             // Foreign key to schools
          degree: string | null;         // Degree obtained
          field_of_study: string | null;  // Field/major
          start_year: number | null;      // Start year
          end_year: number | null;        // Graduation year
        };
        Insert: Omit<Database["public"]["Tables"]["contact_schools"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["contact_schools"]["Insert"]>;
      };
      
      // Meetings table - track meetings with contacts
      meetings: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          meeting_date: string;          // When the meeting occurred
          meeting_type: string;           // Type of meeting (coffee, video, etc.)
          title: string | null;          // Custom meeting name (overrides auto-generated)
          notes: string | null;          // Meeting notes (past meetings)
          private_notes: string | null;  // Private reminders for future meetings
          calendar_description: string | null; // Description for Google Calendar invite
          transcript: string | null;      // Full transcript if available
          transcript_source: string | null; // How the transcript was added (paste, upload_txt, upload_vtt, upload_pdf, audio_deepgram)
          transcript_parsed: boolean;     // Whether transcript has been parsed into segments
          transcript_attachment_id: number | null; // Reference to uploaded file
          calendar_event_id: string | null; // Google Calendar event ID (links to calendar_events)
        };
        Insert: Omit<Database["public"]["Tables"]["meetings"]["Row"], "id" | "transcript_parsed" | "transcript_source" | "transcript_attachment_id" | "calendar_event_id"> & {
          transcript_parsed?: boolean;
          transcript_source?: string | null;
          transcript_attachment_id?: number | null;
          calendar_event_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["meetings"]["Insert"]>;
      };

      // Transcript segments - structured speaker-attributed transcript turns
      transcript_segments: {
        Row: {
          id: number;
          meeting_id: number;
          ordinal: number;
          speaker_label: string;
          contact_id: number | null;
          started_at: number | null;
          ended_at: number | null;
          content: string;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["transcript_segments"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["transcript_segments"]["Insert"]>;
      };
      
      // Meeting contacts - many-to-many relationship for attendees
      meeting_contacts: {
        Row: {
          meeting_id: number;            // Foreign key to meetings
          contact_id: number;            // Foreign key to contacts
        };
        Insert: Database["public"]["Tables"]["meeting_contacts"]["Row"];
        Update: Partial<Database["public"]["Tables"]["meeting_contacts"]["Insert"]>;
      };
      
      // Interactions table - track all touchpoints with contacts
      interactions: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          contact_id: number;            // Foreign key to contacts
          interaction_date: string;      // When interaction occurred
          interaction_type: string;      // Type (email, call, coffee, etc.)
          summary: string | null;        // What was discussed
        };
        Insert: Omit<Database["public"]["Tables"]["interactions"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["interactions"]["Insert"]>;
      };
      
      // Tags table - user-defined tags for organizing contacts
      tags: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users (tags are per-user)
          name: string;                  // Tag name
        };
        Insert: Omit<Database["public"]["Tables"]["tags"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["tags"]["Insert"]>;
      };
      
      // Contact tags - many-to-many relationship for tagging contacts
      contact_tags: {
        Row: {
          contact_id: number;            // Foreign key to contacts
          tag_id: number;                // Foreign key to tags
        };
        Insert: Database["public"]["Tables"]["contact_tags"]["Row"];
        Update: Partial<Database["public"]["Tables"]["contact_tags"]["Insert"]>;
      };
      
      // Attachments table - file metadata for uploaded files
      attachments: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          bucket: string;                // Supabase storage bucket name
          object_path: string;           // Path within bucket
          file_name: string;             // Original filename
          content_type: string | null;   // MIME type
          file_size_bytes: bigint | null; // File size
          is_public: boolean;            // Whether file is publicly accessible
          notes: string | null;          // File notes/description
          created_at: string | null;     // Upload timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["attachments"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["attachments"]["Insert"]>;
      };
      
      // Contact attachments - link files to contacts
      contact_attachments: {
        Row: {
          contact_id: number;            // Foreign key to contacts
          attachment_id: number;         // Foreign key to attachments
        };
        Insert: Database["public"]["Tables"]["contact_attachments"]["Row"];
        Update: Partial<Database["public"]["Tables"]["contact_attachments"]["Insert"]>;
      };
      
      // Meeting attachments - link files to meetings
      meeting_attachments: {
        Row: {
          meeting_id: number;            // Foreign key to meetings
          attachment_id: number;         // Foreign key to attachments
        };
        Insert: Database["public"]["Tables"]["meeting_attachments"]["Row"];
        Update: Partial<Database["public"]["Tables"]["meeting_attachments"]["Insert"]>;
      };
      
      // Interaction attachments - link files to interactions
      interaction_attachments: {
        Row: {
          interaction_id: number;        // Foreign key to interactions
          attachment_id: number;         // Foreign key to attachments
        };
        Insert: Database["public"]["Tables"]["interaction_attachments"]["Row"];
        Update: Partial<Database["public"]["Tables"]["interaction_attachments"]["Insert"]>;
      };
      
      // Gmail connections — per-user OAuth tokens for Gmail API access
      gmail_connections: {
        Row: {
          id: number;
          user_id: string;
          gmail_address: string;
          access_token: string;
          refresh_token: string;
          token_expires_at: string;
          last_gmail_sync_at: string | null;
          created_at: string | null;
          updated_at: string | null;
          // CAR-100: whether gmail.send was actually granted (browser-readable
          // UX flag; granular consent can grant Calendar but not Gmail).
          send_scope_granted: boolean;
          // CAR-103 entitlement flags (service-role-only; hidden from the browser client by CAR-27 column grants)
          automatic_features_enabled: boolean;
          modify_scope_granted: boolean;
          // CAR-102 premium master switch (service-role-only; same CAR-27 column-grant exclusion)
          premium_enabled: boolean;
        };
        Insert: Omit<Database["public"]["Tables"]["gmail_connections"]["Row"], "id" | "created_at" | "updated_at" | "send_scope_granted" | "automatic_features_enabled" | "modify_scope_granted" | "premium_enabled">;
        Update: Partial<Database["public"]["Tables"]["gmail_connections"]["Insert"]>;
      };

      // Email messages — lightweight metadata cache for Gmail messages
      email_messages: {
        Row: {
          id: number;
          user_id: string;
          gmail_message_id: string;
          thread_id: string | null;
          subject: string | null;
          snippet: string | null;
          from_address: string | null;
          to_addresses: string[] | null;
          date: string | null;
          label_ids: string[] | null;
          is_read: boolean;
          is_trashed: boolean;
          is_hidden: boolean;
          is_simulated: boolean;
          /** Whether the outbound message body was AI-drafted (CAR-58). */
          ai_assisted: boolean;
          direction: string | null;
          matched_contact_id: number | null;
          created_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["email_messages"]["Row"], "id" | "created_at" | "is_simulated" | "ai_assisted"> & {
          is_simulated?: boolean;
          ai_assisted?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["email_messages"]["Insert"]>;
      };

      // Scheduled emails — send-later queue
      scheduled_emails: {
        Row: {
          id: number;
          user_id: string;
          recipient_email: string;
          cc: string | null;
          bcc: string | null;
          subject: string;
          body_html: string;
          thread_id: string | null;
          in_reply_to: string | null;
          references_header: string | null;
          scheduled_send_at: string;
          status: string;
          sent_at: string | null;
          gmail_message_id: string | null;
          sent_thread_id: string | null;
          contact_name: string | null;
          matched_contact_id: number | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["scheduled_emails"]["Row"], "id" | "created_at" | "updated_at">;
        Update: Partial<Database["public"]["Tables"]["scheduled_emails"]["Insert"]>;
      };

      // Email follow-up sequences — scheduled follow-ups for sent emails
      email_follow_ups: {
        Row: {
          id: number;
          user_id: string;
          original_gmail_message_id: string;
          thread_id: string;
          recipient_email: string;
          contact_name: string | null;
          original_subject: string | null;
          original_sent_at: string;
          status: string;
          scheduled_email_id: number | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["email_follow_ups"]["Row"], "id" | "created_at" | "updated_at">;
        Update: Partial<Database["public"]["Tables"]["email_follow_ups"]["Insert"]>;
      };

      // Individual messages in a follow-up sequence
      email_follow_up_messages: {
        Row: {
          id: number;
          follow_up_id: number;
          sequence_number: number;
          send_after_days: number;
          subject: string;
          body_html: string;
          status: string;
          scheduled_send_at: string;
          sent_at: string | null;
          created_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["email_follow_up_messages"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["email_follow_up_messages"]["Insert"]>;
      };

      // Email templates — user-defined AI email generation templates
      email_templates: {
        Row: {
          id: number;
          user_id: string;
          name: string;
          prompt: string;
          is_default: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["email_templates"]["Row"], "id" | "created_at" | "updated_at">;
        Update: Partial<Database["public"]["Tables"]["email_templates"]["Insert"]>;
      };

      // Email drafts — auto-saved compose state
      email_drafts: {
        Row: {
          id: number;
          user_id: string;
          recipient_email: string | null;
          cc: string | null;
          bcc: string | null;
          subject: string | null;
          body_html: string | null;
          thread_id: string | null;
          in_reply_to: string | null;
          references_header: string | null;
          contact_name: string | null;
          updated_at: string;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["email_drafts"]["Row"], "id" | "created_at" | "updated_at">;
        Update: Partial<Database["public"]["Tables"]["email_drafts"]["Insert"]>;
      };

      // Junction table: many-to-many between action items and contacts
      action_item_contacts: {
        Row: {
          id: number;
          action_item_id: number;
          contact_id: number;
        };
        Insert: Omit<Database["public"]["Tables"]["action_item_contacts"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["action_item_contacts"]["Insert"]>;
      };

      // AI follow-up drafts — AI-generated follow-up emails for user review
      ai_follow_up_drafts: {
        Row: {
          id: number;
          user_id: string;
          contact_id: number;
          recipient_email: string | null;
          subject: string;
          body_html: string;
          reply_thread_id: string | null;
          reply_thread_subject: string | null;
          send_as_reply: boolean;
          extracted_topic: string;
          topic_evidence: string;
          source_meeting_id: number | null;
          article_url: string | null;
          article_title: string | null;
          article_source: string | null;
          status: string;
          created_at: string;
          updated_at: string;
          sent_at: string | null;
          dismissed_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["ai_follow_up_drafts"]["Row"], "id" | "created_at" | "updated_at" | "sent_at" | "dismissed_at"> & {
          sent_at?: string | null;
          dismissed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["ai_follow_up_drafts"]["Insert"]>;
      };

      // Follow-up action items - general follow-up tasks
      follow_up_action_items: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          contact_id: number | null;     // Optional foreign key to contacts
          meeting_id: number | null;     // Optional foreign key to meetings
          title: string;                  // Task title
          description: string | null;    // Task description
          due_at: string | null;         // Due date
          is_completed: boolean;          // Completion status
          created_at: string | null;     // Creation timestamp
          completed_at: string | null;   // Completion timestamp
          priority: string | null;       // 'high' | 'medium' | 'low' | null
          source: string;                // 'manual' | 'ai_suggestion' | 'ai_transcript'
          suggestion_reason_type: string | null;  // Type of AI suggestion reason
          suggestion_headline: string | null;     // AI-generated contextual headline
          suggestion_evidence: string | null;     // Evidence backing the suggestion
          direction: string | null;               // 'my_task' | 'waiting_on'
          assigned_speaker: string | null;        // Original speaker label from transcript
          related_action_item_id: number | null;  // FK to linked paired item
          snoozed_until: string | null;             // Hide until this time
        };
        Insert: Omit<Database["public"]["Tables"]["follow_up_action_items"]["Row"], "id" | "priority" | "source" | "suggestion_reason_type" | "suggestion_headline" | "suggestion_evidence" | "direction" | "assigned_speaker" | "related_action_item_id" | "snoozed_until"> & {
          priority?: string | null;
          source?: string;
          suggestion_reason_type?: string | null;
          suggestion_headline?: string | null;
          suggestion_evidence?: string | null;
          direction?: string | null;
          assigned_speaker?: string | null;
          related_action_item_id?: number | null;
          snoozed_until?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["follow_up_action_items"]["Insert"]>;
      };

      // Target companies — user-scoped recruiting layer over companies
      target_companies: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          company_id: number;            // Foreign key to companies
          priority_score: number | null; // Priority score from the target sheet
          tier: string | null;           // Segment/geo label (e.g. "Utah/Silicon Slopes", "Big Tech")
          program_name: string | null;   // The APM/rotational program's actual name
          app_window_text: string | null; // Free-text application-window hint — display only
          next_app_date: string | null;  // Real application date set by hand; the only field sorting/alerts use
          status: string;                // 'researching' | 'outreach_active' | 'applied' | 'interviewing' | 'closed'
          location_id: number | null;    // NULL = company-wide scope; set = office-scoped target (CAR-6)
          is_targeted: boolean;          // Soft targeting flag — false keeps pipeline data while hiding from target views
          active_cycle: number;          // Pipeline cycle the user last worked in for this scope
          last_discovery_at: string | null; // When the discovery cron last queried this company (plan 41)
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["target_companies"]["Row"], "id" | "status" | "location_id" | "is_targeted" | "active_cycle" | "last_discovery_at" | "created_at" | "updated_at"> & {
          status?: string;
          location_id?: number | null;
          is_targeted?: boolean;
          active_cycle?: number;
          last_discovery_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["target_companies"]["Insert"]>;
      };

      // Pipeline cycles — one application cycle per target scope (CAR-6)
      pipeline_cycles: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          target_company_id: number;     // Foreign key to target_companies (the scope)
          cycle_number: number;          // 1-based cycle index within the scope
          selected_stage: string;        // 'researching' | 'outreach_active' | 'applied' | 'interviewing' | 'closed'
          declined_next_cycle: boolean;  // Closed stage: user declined to start another cycle
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["pipeline_cycles"]["Row"], "id" | "selected_stage" | "declined_next_cycle" | "created_at" | "updated_at"> & {
          selected_stage?: string;
          declined_next_cycle?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pipeline_cycles"]["Insert"]>;
      };

      // Researching-stage programs per pipeline cycle (CAR-6)
      pipeline_programs: {
        Row: {
          id: string;                    // Client-generated uuid
          cycle_id: number;              // Foreign key to pipeline_cycles
          name: string;                  // Program name
          apps_open: string;             // Free text or "date:YYYY-MM-DD" sentinel
          job_potential: string;         // Free text
          position: number;              // Display order within the cycle
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["pipeline_programs"]["Row"], "created_at"> & {
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pipeline_programs"]["Insert"]>;
      };

      // Researching-stage notes per pipeline cycle (CAR-6)
      pipeline_notes: {
        Row: {
          id: string;                    // Client-generated uuid
          cycle_id: number;              // Foreign key to pipeline_cycles
          body: string;                  // Note text
          position: number;              // Display order within the cycle
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["pipeline_notes"]["Row"], "created_at"> & {
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pipeline_notes"]["Insert"]>;
      };

      // Applied-stage job applications per pipeline cycle (CAR-6)
      pipeline_applications: {
        Row: {
          id: string;                    // Client-generated uuid
          cycle_id: number;              // Foreign key to pipeline_cycles
          job_title: string;             // Role applied for
          location: string;              // Free-text location (editable at company scope; office scope implies it)
          date_applied: string | null;   // ISO date (YYYY-MM-DD)
          resume_path: string | null;    // Storage path in application-files bucket
          resume_name: string | null;    // Original filename
          resume_size_bytes: number | null;
          cover_letter_path: string | null;
          cover_letter_name: string | null;
          cover_letter_size_bytes: number | null;
          position: number;              // Display order within the cycle
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["pipeline_applications"]["Row"], "created_at"> & {
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pipeline_applications"]["Insert"]>;
      };

      // Interviewing-stage rounds per pipeline cycle (CAR-6)
      pipeline_interview_rounds: {
        Row: {
          id: string;                    // Client-generated uuid
          cycle_id: number;              // Foreign key to pipeline_cycles
          interview_date: string | null; // ISO date (YYYY-MM-DD)
          interviewer: string;           // Who's interviewing
          questions: string;             // Prep / notes text
          position: number;              // Display order within the cycle
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["pipeline_interview_rounds"]["Row"], "created_at"> & {
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pipeline_interview_rounds"]["Insert"]>;
      };

      // Target company notes — timestamped recruiting-intel log
      target_company_notes: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          target_company_id: number;     // Foreign key to target_companies
          note: string;                  // The recruiting-intel note
          location_id: number | null;    // Optional office tag (FK to locations)
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["target_company_notes"]["Row"], "id" | "created_at"> & {
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["target_company_notes"]["Insert"]>;
      };

      // Suppressed imports — tombstones so deleted imported contacts don't resurrect
      suppressed_imports: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          linkedin_url: string;          // Canonical linkedin_url of the deleted contact
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["suppressed_imports"]["Row"], "id" | "created_at"> & {
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["suppressed_imports"]["Insert"]>;
      };

      // Contact change events — detected changes worth an outreach touch (plan 29)
      contact_change_events: {
        Row: {
          id: number;                          // Auto-incrementing primary key
          user_id: string;                     // Foreign key to users
          contact_id: number;                  // Foreign key to contacts
          type: string;                        // 'anniversary' | 'company_change' | 'promotion' | 'hiring' | 'open_to_work' | 'certification' | 'location_change'
          tier: number;                        // 1 act-now, 2 touchpoint, 3 silent
          dedupe_key: string;                  // Stable idempotency key
          headline: string;                    // Display "why"
          evidence: string | null;             // Backing detail
          suggested_title: string | null;      // Prefilled action item title
          suggested_description: string | null;
          old_value: Record<string, unknown> | null; // For scrape diffs
          new_value: Record<string, unknown> | null;
          status: string;                      // 'new' | 'actioned' | 'dismissed' | 'snoozed'
          snoozed_until: string | null;
          detected_at: string;
          actioned_at: string | null;
        };
        Insert: Omit<
          Database["public"]["Tables"]["contact_change_events"]["Row"],
          "id" | "tier" | "status" | "detected_at" | "snoozed_until" | "actioned_at" | "evidence" | "suggested_title" | "suggested_description" | "old_value" | "new_value"
        > & {
          tier?: number;
          status?: string;
          snoozed_until?: string | null;
          detected_at?: string;
          actioned_at?: string | null;
          evidence?: string | null;
          suggested_title?: string | null;
          suggested_description?: string | null;
          old_value?: Record<string, unknown> | null;
          new_value?: Record<string, unknown> | null;
        };
        Update: Partial<Database["public"]["Tables"]["contact_change_events"]["Insert"]>;
      };

      // Scrape runs — Apify run ledger (plan 29)
      scrape_runs: {
        Row: {
          id: number;                          // Auto-incrementing primary key
          user_id: string;                     // Foreign key to users
          apify_run_id: string | null;         // Apify run id (null until the run is started)
          actor: string;                       // Apify actor full name
          mode: string;                        // 'profile' | 'email' | 'resolve' | 'discovery'
          trigger: string;                     // 'manual' | 'enrich_on_save' | 'cadence' | 'discovery'
          contact_ids: number[];               // Contacts covered by this run
          single_contact_id: number | null;    // The one contact a run targets (in-flight guard)
          company_id: number | null;           // Discovery runs: the company searched (plan 41)
          status: string;                      // 'pending' | 'succeeded' | 'failed' | 'timed_out'
          cost_usd: number;                    // Actual run cost (0 until succeeded)
          error: string | null;
          created_at: string;
          finished_at: string | null;
          ingest_claimed_at: string | null;    // Webhook ingest's atomic claim (CAS; stale >10min = re-claimable)
        };
        Insert: Omit<
          Database["public"]["Tables"]["scrape_runs"]["Row"],
          "id" | "apify_run_id" | "status" | "cost_usd" | "error" | "created_at" | "finished_at" | "contact_ids" | "single_contact_id" | "company_id" | "ingest_claimed_at"
        > & {
          apify_run_id?: string | null;
          status?: string;
          cost_usd?: number;
          error?: string | null;
          created_at?: string;
          finished_at?: string | null;
          contact_ids?: number[];
          single_contact_id?: number | null;
          company_id?: number | null;
          ingest_claimed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["scrape_runs"]["Insert"]>;
      };

      // Scrape snapshots — normalized per-scrape profile subset (plan 29)
      contact_scrape_snapshots: {
        Row: {
          id: number;                          // Auto-incrementing primary key
          user_id: string;                     // Foreign key to users
          contact_id: number;                  // Foreign key to contacts
          scrape_run_id: number | null;        // Producing scrape_runs row (null if run deleted)
          scraped_at: string;
          snapshot: Record<string, unknown>;   // Normalized subset — see ScrapeSnapshot in diff-engine.ts
        };
        Insert: Omit<
          Database["public"]["Tables"]["contact_scrape_snapshots"]["Row"],
          "id" | "scraped_at" | "scrape_run_id"
        > & {
          scraped_at?: string;
          scrape_run_id?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["contact_scrape_snapshots"]["Insert"]>;
      };

      // Discovery-feed candidates — strangers found by the weekly target-company
      // people search (plan 41). Dismiss is sticky; writes via service client.
      discovery_candidates: {
        Row: {
          id: number;                          // Auto-incrementing primary key
          user_id: string;                     // Foreign key to users
          company_id: number;                  // Foreign key to companies (the target searched)
          linkedin_url: string;                // Canonical LinkedIn profile URL (dedupe key)
          public_identifier: string | null;    // LinkedIn slug (secondary dedupe key)
          name: string;
          headline: string | null;
          location: string | null;
          photo_url: string | null;
          position: string | null;             // Current title at the target company, when known
          raw: Record<string, unknown>;        // Short-profile item as returned by the actor
          status: string;                      // 'new' | 'added' | 'dismissed'
          added_contact_id: number | null;     // Contact created from this candidate
          first_seen_at: string;
          last_seen_at: string;
        };
        Insert: Omit<
          Database["public"]["Tables"]["discovery_candidates"]["Row"],
          "id" | "public_identifier" | "headline" | "location" | "photo_url" | "position" | "status" | "added_contact_id" | "first_seen_at" | "last_seen_at"
        > & {
          public_identifier?: string | null;
          headline?: string | null;
          location?: string | null;
          photo_url?: string | null;
          position?: string | null;
          status?: string;
          added_contact_id?: number | null;
          first_seen_at?: string;
          last_seen_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["discovery_candidates"]["Insert"]>;
      };

      // Data bundles — admin-curated prospect/company bundle catalog
      data_bundles: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          slug: string;                  // Unique bundle identifier (e.g. "ib-banks-nyc")
          name: string;                  // Display name
          description: string | null;    // Display description
          version: number;               // Last COMMITTED publish version (0 = never published)
          staging_version: number | null; // Publish lock: version+1 while a publish is in flight
          staging_claimed_at: string | null; // When the publish lock was claimed
          status: string;                // 'draft' | 'published' | 'archived'
          prospect_count: number;        // Denormalized live-prospect count (recomputed at finalize)
          company_count: number;         // Denormalized company count (recomputed at finalize)
          published_at: string | null;   // First/last publish timestamp
          default_visible: boolean;      // Hidden-until-granted default (false = hidden); per-account overrides win
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["data_bundles"]["Row"], "id" | "version" | "staging_version" | "staging_claimed_at" | "status" | "prospect_count" | "company_count" | "published_at" | "default_visible" | "created_at" | "updated_at"> & {
          version?: number;
          staging_version?: number | null;
          staging_claimed_at?: string | null;
          status?: string;
          prospect_count?: number;
          company_count?: number;
          published_at?: string | null;
          default_visible?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["data_bundles"]["Insert"]>;
      };

      // Per-(user, bundle) visibility override — service-role access only
      bundle_access_overrides: {
        Row: {
          user_id: string;               // FK to users
          bundle_id: number;             // FK to data_bundles
          allowed: boolean;              // true = grant a hidden bundle; false = hide a visible one
          updated_by: string | null;     // admin who set it
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["bundle_access_overrides"]["Row"], "updated_at"> & {
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bundle_access_overrides"]["Insert"]>;
      };

      // Admin action audit trail — service-role access only
      admin_audit_log: {
        Row: {
          id: string;                    // UUID primary key
          admin_id: string;              // FK to users (the acting admin)
          target_user_id: string | null; // FK to users (account acted upon)
          action: string;                // Action slug
          detail: unknown;               // jsonb context
          outcome: "ok" | "error";       // Whether the action succeeded
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["admin_audit_log"]["Row"], "id" | "detail" | "outcome" | "created_at"> & {
          id?: string;
          detail?: unknown;
          outcome?: "ok" | "error";
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["admin_audit_log"]["Insert"]>;
      };

      // Bundle prospects — versioned bundle content (CareerVine-owned payload contract)
      bundle_prospects: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          bundle_id: number;             // Foreign key to data_bundles
          linkedin_url: string;          // Canonical LinkedIn profile URL
          payload: unknown;              // BundleProspectPayloadV1 (validated at publish)
          payload_schema_version: number; // Payload contract version (sync skips unknown versions)
          payload_hash: string;          // sha256 of canonical payload JSON — change detection
          version_added: number;         // Publish version that introduced the prospect
          version_updated: number;       // Bumped when payload_hash changes (drives deltas)
          version_last_seen: number;     // Bumped every publish the prospect appears in
          removed_in_version: number | null; // Soft delete (NULL = live)
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["bundle_prospects"]["Row"], "id" | "payload_schema_version" | "removed_in_version" | "created_at" | "updated_at"> & {
          payload_schema_version?: number;
          removed_in_version?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bundle_prospects"]["Insert"]>;
      };

      // Bundle companies — membership links (company data lives in shared tables)
      bundle_companies: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          bundle_id: number;             // Foreign key to data_bundles
          company_id: number;            // Foreign key to companies (shared/global)
          version_last_seen: number | null; // Staging version of the last publish run that included this company; unstamped rows are pruned at finalize (CAR-63)
          created_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["bundle_companies"]["Row"], "id" | "version_last_seen" | "created_at"> & {
          version_last_seen?: number | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bundle_companies"]["Insert"]>;
      };

      // Bundle subscriptions — user ↔ bundle, sync progress + serialization claim
      bundle_subscriptions: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          bundle_id: number;             // Foreign key to data_bundles
          status: string;                // 'active' | 'unsubscribed' (row kept on unsubscribe)
          synced_version: number;        // Last FULLY applied bundle version (advances to pinned version only)
          last_synced_at: string | null; // When the last full sync completed
          sync_claimed_until: string | null; // Serialization claim so concurrent sync drivers can't race
          sync_cursor: Record<string, unknown> | null; // Mid-sync checkpoint {phase, afterId, pinnedVersion}; cleared on commit/resubscribe
          unsubscribe_keep_all: boolean | null; // Pending unsubscribe cleanup intent; non-null = removal loop unfinished
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["bundle_subscriptions"]["Row"], "id" | "status" | "synced_version" | "last_synced_at" | "sync_claimed_until" | "sync_cursor" | "unsubscribe_keep_all" | "created_at" | "updated_at"> & {
          status?: string;
          synced_version?: number;
          last_synced_at?: string | null;
          sync_claimed_until?: string | null;
          sync_cursor?: Record<string, unknown> | null;
          unsubscribe_keep_all?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bundle_subscriptions"]["Insert"]>;
      };

      // Bundle subscription contacts — which contacts a subscription supplied
      bundle_subscription_contacts: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          subscription_id: number;       // Foreign key to bundle_subscriptions
          contact_id: number;            // Foreign key to contacts
          bundle_prospect_id: number | null; // Durable removal-correlation key (FK to bundle_prospects)
          linkedin_url: string;          // Canonical URL at apply time (debugging/secondary key)
          created_by_bundle: boolean;    // true = bundle created the contact; false = merged into existing
          first_applied_version: number; // Bundle version at first apply
          last_applied_version: number;  // Bundle version at most recent apply
          last_applied_at: string;       // When this contact was last touched by a sync
        };
        Insert: Omit<Database["public"]["Tables"]["bundle_subscription_contacts"]["Row"], "id" | "bundle_prospect_id" | "last_applied_at"> & {
          bundle_prospect_id?: number | null;
          last_applied_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bundle_subscription_contacts"]["Insert"]>;
      };

      // Bundle contact state — per-(user, contact) fingerprint baseline + sticky touched flag
      bundle_contact_state: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          contact_id: number;            // Foreign key to contacts
          applied_fingerprint: string | null; // Hash of user-editable surface after last bundle apply
          user_touched: boolean;         // Sticky: once true, bundle machinery never deletes this contact
          apply_started_at: string | null; // In-flight marker for crash-safe fingerprint recovery
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["bundle_contact_state"]["Row"], "id" | "applied_fingerprint" | "user_touched" | "apply_started_at" | "updated_at"> & {
          applied_fingerprint?: string | null;
          user_touched?: boolean;
          apply_started_at?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["bundle_contact_state"]["Insert"]>;
      };

      // Referrals — contact referred you to another contact
      referrals: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          referred_by_contact_id: number; // Contact who made the referral
          referred_contact_id: number;   // Contact who was referred
          referral_meeting_id: number | null; // Optional meeting where the referral happened
          notes: string | null;          // Referral notes
        };
        Insert: Omit<Database["public"]["Tables"]["referrals"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["referrals"]["Insert"]>;
      };

      // Calendar events — Google Calendar sync cache
      calendar_events: {
        Row: {
          id: number;                    // bigserial primary key
          user_id: string;               // Foreign key to users
          google_event_id: string;       // Google Calendar event ID
          calendar_id: string;           // Source calendar (default 'primary')
          title: string | null;
          description: string | null;
          start_at: string;
          end_at: string;
          all_day: boolean | null;
          location: string | null;
          meet_link: string | null;
          zoom_link: string | null;
          status: string | null;         // confirmed | tentative | cancelled
          attendees: { email?: string; name?: string; responseStatus?: string }[] | null;
          is_private: boolean | null;
          recurring_event_id: string | null;
          contact_id: number | null;     // Optional linked contact
          meeting_id: number | null;     // Optional linked meeting
          source_gmail_thread_id: string | null;
          source_gmail_message_id: string | null;
          synced_at: string | null;
          created_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["calendar_events"]["Row"], "id" | "synced_at" | "created_at"> & {
          synced_at?: string | null;
          created_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["calendar_events"]["Insert"]>;
      };

      // Calendar event contacts — junction between calendar events and contacts
      calendar_event_contacts: {
        Row: {
          calendar_event_id: number;     // Foreign key to calendar_events
          contact_id: number;            // Foreign key to contacts
        };
        Insert: Database["public"]["Tables"]["calendar_event_contacts"]["Row"];
        Update: Partial<Database["public"]["Tables"]["calendar_event_contacts"]["Insert"]>;
      };

      // User companies — the user's own employment history
      user_companies: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          company_id: number;            // Foreign key to companies
          title: string | null;          // Job title
          start_date: string | null;     // Employment start date
          end_date: string | null;       // Employment end date
          is_current: boolean;            // Whether this is current employment
        };
        Insert: Omit<Database["public"]["Tables"]["user_companies"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["user_companies"]["Insert"]>;
      };

      // User schools — the user's own education history
      user_schools: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          school_id: number;             // Foreign key to schools
          degree: string | null;         // Degree obtained
          field_of_study: string | null;  // Field/major
          start_year: number | null;      // Start year
          end_year: number | null;        // Graduation year
        };
        Insert: Omit<Database["public"]["Tables"]["user_schools"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["user_schools"]["Insert"]>;
      };
    };
  };
};

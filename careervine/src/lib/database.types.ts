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
          created_at: string;            // Auto-generated timestamp
          updated_at: string;            // Auto-generated timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["users"]["Row"], "id" | "created_at" | "updated_at">;
        Update: Partial<Database["public"]["Tables"]["users"]["Insert"]>;
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
          location_id: number | null;    // Foreign key to locations table
        };
        Insert: Omit<Database["public"]["Tables"]["contacts"]["Row"], "id">;
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
        };
        Insert: Omit<Database["public"]["Tables"]["contact_emails"]["Row"], "id">;
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
        };
        Insert: Database["public"]["Tables"]["companies"]["Row"];
        Update: Partial<Database["public"]["Tables"]["companies"]["Insert"]>;
      };
      
      // Contact companies - many-to-many relationship with role history
      contact_companies: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          contact_id: number;            // Foreign key to contacts
          company_id: number;            // Foreign key to companies
          title: string | null;          // Job title at this company
          location: string | null;       // Job location (e.g., "San Francisco, CA")
          start_date: string | null;     // Employment start date (legacy)
          end_date: string | null;       // Employment end date (legacy)
          start_month: string | null;    // Job start month "Mon YYYY" (e.g., "Jan 2023")
          end_month: string | null;      // Job end month "Mon YYYY" or "Present"
          is_current: boolean;            // Whether this is current employment
        };
        Insert: Omit<Database["public"]["Tables"]["contact_companies"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["contact_companies"]["Insert"]>;
      };
      
      // Schools table - normalized list of educational institutions
      schools: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          name: string;                  // School name (unique)
        };
        Insert: Database["public"]["Tables"]["schools"]["Row"];
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
          notes: string | null;          // Meeting notes
          transcript: string | null;      // Full transcript if available
        };
        Insert: Omit<Database["public"]["Tables"]["meetings"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["meetings"]["Insert"]>;
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
        };
        Insert: Omit<Database["public"]["Tables"]["gmail_connections"]["Row"], "id" | "created_at" | "updated_at">;
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
          direction: string | null;
          matched_contact_id: number | null;
          created_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["email_messages"]["Row"], "id" | "created_at">;
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
        };
        Insert: Omit<Database["public"]["Tables"]["follow_up_action_items"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["follow_up_action_items"]["Insert"]>;
      };
    };
  };
};

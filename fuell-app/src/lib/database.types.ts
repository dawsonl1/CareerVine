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
          role: string | null;           // Job title/role
          linkedin_url: string | null;   // LinkedIn profile URL
          notes: string | null;          // Free-form notes
          met_through: string | null;    // How you met this contact
          follow_up_frequency_days: number | null;  // Days between follow-ups
          preferred_contact_method: string | null;  // Email/phone/LinkedIn
          preferred_contact_value: string | null;   // Contact details
        };
        Insert: Omit<Database["public"]["Tables"]["contacts"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["contacts"]["Insert"]>;
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
          start_date: string | null;     // Employment start date
          end_date: string | null;       // Employment end date
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
      
      // Post-meeting action items - tasks created from meetings
      post_meeting_action_items: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          meeting_id: number;            // Foreign key to meetings
          owner_type: string;             // Who owns this task (user/contact)
          contact_id: number | null;     // Foreign key to contacts (if contact owns)
          title: string;                  // Task title
          description: string | null;    // Task description
          due_at: string | null;         // Due date
          is_completed: boolean;          // Completion status
          created_at: string | null;     // Creation timestamp
          completed_at: string | null;   // Completion timestamp
        };
        Insert: Omit<Database["public"]["Tables"]["post_meeting_action_items"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["post_meeting_action_items"]["Insert"]>;
      };
      
      // Follow-up action items - general follow-up tasks
      follow_up_action_items: {
        Row: {
          id: number;                    // Auto-incrementing primary key
          user_id: string;               // Foreign key to users
          contact_id: number;            // Foreign key to contacts
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

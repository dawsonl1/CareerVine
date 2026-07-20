/**
 * Shared helpers for AI email generation endpoints.
 * Extracts contact-fetching logic used by both ai-write and draft-intro.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { wrapUntrusted } from "@/lib/ai/untrusted";

export interface ContactContext {
  contactName: string;
  senderName: string;
  senderEmail: string;
  contactInfo: string;
  meetingNotes: string;
}

/**
 * Fetch rich context about a contact for AI email generation.
 * Includes name, company, school, notes, location, emails.
 */
export async function getContactContext(
  userId: string,
  contactId: number,
  meetingIds?: number[]
): Promise<ContactContext> {
  const service = createSupabaseServiceClient();

  // Run user profile + contact queries in parallel
  const [{ data: userProfile }, { data: contact }] = await Promise.all([
    service.from("users").select("first_name, last_name, email").eq("id", userId).single(),
    contactId > 0
      ? service.from("contacts").select(`
          name, industry, notes, met_through, intro_goal, contact_status, expected_graduation,
          locations(city, state, country),
          contact_emails(email),
          contact_companies(
            title, is_current,
            companies(name)
          ),
          contact_schools(
            degree, field_of_study, start_year, end_year,
            schools(name)
          )
        `).eq("id", contactId).eq("user_id", userId).single()
      : Promise.resolve({ data: null }),
  ]);

  const senderName = userProfile
    ? `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim()
    : "";
  const senderEmail = userProfile?.email || "";

  let contactInfo = "";
  let contactName = "";

  if (contact) {
    contactName = contact.name;
    const parts: string[] = [];
    parts.push(`Name: ${contact.name}`);
    if (contact.industry) parts.push(`Industry: ${contact.industry}`);
    if (contact.contact_status) parts.push(`Status: ${contact.contact_status}`);
    if (contact.expected_graduation) parts.push(`Expected graduation: ${contact.expected_graduation}`);
    if (contact.met_through) parts.push(`Met through: ${contact.met_through}`);
    if (contact.intro_goal) parts.push(`Goal: ${contact.intro_goal}`);
    // Notes are free text anyone the user meets can influence — fence them so
    // they read as data, not instructions (CAR-143).
    if (contact.notes) parts.push(`Notes:\n${wrapUntrusted("contact_notes", contact.notes)}`);

    // Location
    const loc = contact.locations;
    if (loc) {
      const locParts = [loc.city, loc.state, loc.country].filter(Boolean);
      if (locParts.length) parts.push(`Location: ${locParts.join(", ")}`);
    }

    // Companies
    const companies = contact.contact_companies;
    if (companies?.length) {
      const compStrs = companies.map((cc) => {
        const name = cc.companies?.name || "Unknown";
        return cc.is_current
          ? `${cc.title || "Role"} at ${name} (current)`
          : `${cc.title || "Role"} at ${name}`;
      });
      parts.push(`Work experience: ${compStrs.join("; ")}`);
    }

    // Schools
    const schools = contact.contact_schools;
    if (schools?.length) {
      const eduStrs = schools.map((cs) => {
        const name = cs.schools?.name || "Unknown";
        const deg = [cs.degree, cs.field_of_study].filter(Boolean).join(" in ");
        const years = [cs.start_year, cs.end_year].filter(Boolean).join("–");
        const base = deg ? `${deg} from ${name}` : name;
        return years ? `${base} (${years})` : base;
      });
      parts.push(`Education: ${eduStrs.join("; ")}`);
    }

    // Emails. contact_emails.email is nullable, and a null used to reach the
    // prompt as an empty list entry ("Email(s): a@b.com, ") — the stale cast
    // that claimed it was non-null hid that (CAR-158).
    const emails = contact.contact_emails.map((e) => e.email).filter((e): e is string => Boolean(e));
    if (emails.length) {
      parts.push(`Email(s): ${emails.join(", ")}`);
    }

    contactInfo = parts.join("\n");
  }

  // Meeting notes
  let meetingNotes = "";
  if (meetingIds?.length) {
    // error-tolerated: these notes are optional enrichment for the AI prompt.
    // A failed read costs the draft some context, whereas throwing would deny
    // the user a draft entirely — the worse outcome for an assistive feature.
    const { data: meetings } = await service
      .from("meetings")
      .select("id, meeting_date, meeting_type, notes, transcript")
      .in("id", meetingIds)
      .eq("user_id", userId)
      .order("meeting_date", { ascending: false });

    if (meetings?.length) {
      const meetingParts = meetings.map((m) => {
        const parts: string[] = [];
        parts.push(`Meeting on ${new Date(m.meeting_date).toLocaleDateString()}${m.meeting_type ? ` (${m.meeting_type})` : ""}`);
        if (m.notes) parts.push(`Notes:\n${wrapUntrusted("meeting_notes", m.notes)}`);
        if (m.transcript) {
          parts.push(`Transcript:\n${wrapUntrusted("transcript", m.transcript.substring(0, 3000))}`);
        }
        return parts.join("\n");
      });
      meetingNotes = meetingParts.join("\n\n");
    }
  }

  return { contactName, senderName, senderEmail, contactInfo, meetingNotes };
}

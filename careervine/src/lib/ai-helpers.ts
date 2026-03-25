/**
 * Shared helpers for AI email generation endpoints.
 * Extracts contact-fetching logic used by both ai-write and draft-intro.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

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

  // User profile
  const { data: userProfile } = await service
    .from("users")
    .select("first_name, last_name, email")
    .eq("id", userId)
    .single();

  const senderName = userProfile
    ? `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim()
    : "";
  const senderEmail = userProfile?.email || "";

  // Contact info
  let contactInfo = "";
  let contactName = "";

  const { data: contact } = await service
    .from("contacts")
    .select(`
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
    `)
    .eq("id", contactId)
    .eq("user_id", userId)
    .single();

  if (contact) {
    contactName = contact.name;
    const parts: string[] = [];
    parts.push(`Name: ${contact.name}`);
    if (contact.industry) parts.push(`Industry: ${contact.industry}`);
    if (contact.contact_status) parts.push(`Status: ${contact.contact_status}`);
    if (contact.expected_graduation) parts.push(`Expected graduation: ${contact.expected_graduation}`);
    if (contact.met_through) parts.push(`Met through: ${contact.met_through}`);
    if ((contact as any).intro_goal) parts.push(`Goal: ${(contact as any).intro_goal}`);
    if (contact.notes) parts.push(`Notes: ${contact.notes}`);

    // Location
    const loc = contact.locations as unknown as { city: string | null; state: string | null; country: string } | null;
    if (loc) {
      const locParts = [loc.city, loc.state, loc.country].filter(Boolean);
      if (locParts.length) parts.push(`Location: ${locParts.join(", ")}`);
    }

    // Companies
    const companies = contact.contact_companies as unknown as Array<{
      title: string | null;
      is_current: boolean;
      companies: { name: string } | null;
    }> | null;
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
    const schools = contact.contact_schools as unknown as Array<{
      degree: string | null;
      field_of_study: string | null;
      start_year: number | null;
      end_year: number | null;
      schools: { name: string } | null;
    }> | null;
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

    // Emails
    const emails = contact.contact_emails as Array<{ email: string }> | null;
    if (emails?.length) {
      parts.push(`Email(s): ${emails.map((e) => e.email).join(", ")}`);
    }

    contactInfo = parts.join("\n");
  }

  // Meeting notes
  let meetingNotes = "";
  if (meetingIds?.length) {
    const { data: meetings } = await service
      .from("meetings")
      .select("id, meeting_date, meeting_type, notes, transcript")
      .in("id", meetingIds)
      .eq("user_id", userId)
      .order("meeting_date", { ascending: false });

    if (meetings?.length) {
      const meetingParts = meetings.map((m) => {
        const parts: string[] = [];
        parts.push(`Meeting on ${new Date(m.meeting_date).toLocaleDateString()} (${m.meeting_type})`);
        if (m.notes) parts.push(`Notes: ${m.notes}`);
        if (m.transcript) parts.push(`Transcript: ${m.transcript.substring(0, 3000)}`);
        return parts.join("\n");
      });
      meetingNotes = meetingParts.join("\n\n");
    }
  }

  return { contactName, senderName, senderEmail, contactInfo, meetingNotes };
}

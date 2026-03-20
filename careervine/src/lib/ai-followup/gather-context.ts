/**
 * Gathers all available context about a contact for AI interest extraction.
 *
 * Pulls profile data, meeting notes, transcript segments, interactions,
 * and contact notes. Enforces a token budget by prioritizing recent data.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

export interface ContactContext {
  contactName: string;
  role: string | null;
  industry: string | null;
  companies: string[];
  schools: string[];
  location: string | null;
  notes: string | null;
  metThrough: string | null;
  contactStatus: string | null;
  expectedGraduation: string | null;
  meetings: MeetingContext[];
  interactions: InteractionContext[];
  hasRichData: boolean; // true if meetings/transcripts/notes exist beyond just profile
}

interface MeetingContext {
  id: number;
  date: string;
  type: string;
  title: string | null;
  notes: string | null;
  transcriptExcerpt: string | null;
}

interface InteractionContext {
  date: string;
  type: string;
  summary: string | null;
}

/** Rough character-to-token ratio (1 token ≈ 4 chars). */
const MAX_CONTEXT_CHARS = 32000; // ~8K tokens
const MAX_MEETINGS = 5;
const MAX_TRANSCRIPT_CHARS_PER_MEETING = 4000;
const MAX_INTERACTIONS = 10;

export async function gatherContactContext(
  userId: string,
  contactId: number,
): Promise<ContactContext> {
  const service = createSupabaseServiceClient();

  // Verify ownership and fetch profile in one query
  const { data: contact, error: contactError } = await service
    .from("contacts")
    .select(`
      name, industry, notes, met_through, contact_status, expected_graduation,
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

  if (contactError || !contact) {
    throw new Error(`Contact ${contactId} not found or not owned by user`);
  }

  // Extract companies
  const companies = (
    contact.contact_companies as unknown as Array<{
      title: string | null;
      is_current: boolean;
      companies: { name: string } | null;
    }> | null
  )?.map((cc) => {
    const name = cc.companies?.name || "Unknown";
    return cc.is_current
      ? `${cc.title || "Role"} at ${name} (current)`
      : `${cc.title || "Role"} at ${name}`;
  }) || [];

  // Extract schools
  const schools = (
    contact.contact_schools as unknown as Array<{
      degree: string | null;
      field_of_study: string | null;
      start_year: number | null;
      end_year: number | null;
      schools: { name: string } | null;
    }> | null
  )?.map((cs) => {
    const name = cs.schools?.name || "Unknown";
    const deg = [cs.degree, cs.field_of_study].filter(Boolean).join(" in ");
    const years = [cs.start_year, cs.end_year].filter(Boolean).join("–");
    const base = deg ? `${deg} from ${name}` : name;
    return years ? `${base} (${years})` : base;
  }) || [];

  // Location
  const loc = contact.locations as unknown as {
    city: string | null;
    state: string | null;
    country: string;
  } | null;
  const location = loc
    ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ")
    : null;

  // Fetch meetings with this contact (most recent first)
  const { data: meetingLinks } = await service
    .from("meeting_contacts")
    .select("meeting_id")
    .eq("contact_id", contactId);

  const meetingIds = meetingLinks?.map((ml) => ml.meeting_id) || [];

  // Fetch meetings + interactions in parallel (independent queries)
  const meetingsPromise = (async () => {
    if (meetingIds.length === 0) return [];

    const { data: meetingRows } = await service
      .from("meetings")
      .select("id, meeting_date, meeting_type, title, notes")
      .in("id", meetingIds)
      .eq("user_id", userId)
      .order("meeting_date", { ascending: false })
      .limit(MAX_MEETINGS);

    if (!meetingRows?.length) return [];

    // Fetch all transcript segments in a single query (avoids N+1)
    const meetingRowIds = meetingRows.map((m) => m.id);
    const { data: allSegments } = await service
      .from("transcript_segments")
      .select("meeting_id, speaker_label, content")
      .in("meeting_id", meetingRowIds)
      .order("ordinal", { ascending: true });

    // Group segments by meeting_id
    const segmentsByMeeting = new Map<number, typeof allSegments>();
    for (const seg of allSegments || []) {
      const existing = segmentsByMeeting.get(seg.meeting_id) || [];
      existing.push(seg);
      segmentsByMeeting.set(seg.meeting_id, existing);
    }

    return meetingRows.map((m): MeetingContext => {
      const segments = segmentsByMeeting.get(m.id) || [];
      let transcriptExcerpt: string | null = null;
      if (segments.length > 0) {
        const text = segments
          .slice(0, 50)
          .map((s) => `${s.speaker_label}: ${s.content}`)
          .join("\n");
        transcriptExcerpt = text.substring(0, MAX_TRANSCRIPT_CHARS_PER_MEETING);
      }
      return {
        id: m.id,
        date: m.meeting_date,
        type: m.meeting_type,
        title: m.title,
        notes: m.notes,
        transcriptExcerpt,
      };
    });
  })();

  const interactionsPromise = service
    .from("interactions")
    .select("interaction_date, interaction_type, summary")
    .eq("contact_id", contactId)
    .order("interaction_date", { ascending: false })
    .limit(MAX_INTERACTIONS);

  const [meetings, { data: interactionRows }] = await Promise.all([
    meetingsPromise,
    interactionsPromise,
  ]);

  const interactions: InteractionContext[] = (interactionRows || []).map((i) => ({
    date: i.interaction_date,
    type: i.interaction_type,
    summary: i.summary,
  }));

  const hasRichData =
    meetings.length > 0 ||
    interactions.length > 0 ||
    (contact.notes != null && contact.notes.trim().length > 0);

  return {
    contactName: contact.name,
    role: companies.find((c) => c.includes("(current)"))?.split(" at ")[0] || null,
    industry: contact.industry,
    companies,
    schools,
    location,
    notes: contact.notes,
    metThrough: contact.met_through,
    contactStatus: contact.contact_status,
    expectedGraduation: contact.expected_graduation,
    meetings,
    interactions,
    hasRichData,
  };
}

/**
 * Format context into a string for LLM consumption, respecting token budget.
 */
export function formatContextForLLM(ctx: ContactContext): string {
  const parts: string[] = [];

  // Profile
  parts.push(`Name: ${ctx.contactName}`);
  if (ctx.industry) parts.push(`Industry: ${ctx.industry}`);
  if (ctx.role) parts.push(`Current role: ${ctx.role}`);
  if (ctx.companies.length) parts.push(`Work history: ${ctx.companies.join("; ")}`);
  if (ctx.schools.length) parts.push(`Education: ${ctx.schools.join("; ")}`);
  if (ctx.location) parts.push(`Location: ${ctx.location}`);
  if (ctx.contactStatus) parts.push(`Status: ${ctx.contactStatus}`);
  if (ctx.expectedGraduation) parts.push(`Expected graduation: ${ctx.expectedGraduation}`);
  if (ctx.metThrough) parts.push(`Met through: ${ctx.metThrough}`);
  if (ctx.notes) parts.push(`Personal notes: ${ctx.notes}`);

  // Meetings
  if (ctx.meetings.length > 0) {
    parts.push("\n--- Meeting History ---");
    for (const m of ctx.meetings) {
      const date = new Date(m.date).toLocaleDateString();
      const label = m.title || m.type;
      parts.push(`\nMeeting: ${label} (${date})`);
      if (m.notes) parts.push(`Notes: ${m.notes}`);
      if (m.transcriptExcerpt) parts.push(`Transcript excerpt:\n${m.transcriptExcerpt}`);
    }
  }

  // Interactions
  if (ctx.interactions.length > 0) {
    parts.push("\n--- Recent Interactions ---");
    for (const i of ctx.interactions) {
      const date = new Date(i.date).toLocaleDateString();
      parts.push(`${i.type} on ${date}${i.summary ? `: ${i.summary}` : ""}`);
    }
  }

  // Enforce budget
  let result = parts.join("\n");
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.substring(0, MAX_CONTEXT_CHARS) + "\n[...truncated]";
  }

  return result;
}

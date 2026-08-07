/**
 * Full per-tenant data graph for the integration tier (CAR-178).
 *
 * seedTenantGraph() inserts (via the service client, RLS bypassed — this is
 * scaffolding, not the behavior under test) at least one row into every
 * user-owned table, wired through realistic FKs, and records each row as a
 * (table, match) pair. Those records drive:
 *
 *  - rls-tenant-isolation.itest.ts — every recorded row must be invisible
 *    and immutable to the OTHER tenant;
 *  - user-deletion-cascade.itest.ts — every recorded row must be GONE after
 *    auth.admin.deleteUser.
 *
 * Three buckets, because their post-deletion fates differ:
 *  - rows:       user-owned; cascade must remove them.
 *  - sharedRows: shared catalog (companies, schools, locations, bundles…);
 *                deletion of one user must NOT remove them.
 *  - auditRows:  admin_audit_log — carries no user FK by design (the audit
 *                trail outlives the account); must survive deletion.
 *
 * The COVERED_TABLES export is the coverage contract: the completeness guard
 * in the isolation suite fails if a live RLS table is in none of the buckets
 * and not in its exemption map, so a new table cannot ship untested.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/database.types";
import { type Db, uniq } from "./stack";

type Tables = Database["public"]["Tables"];
export type TableName = keyof Tables & string;

export interface SeededRow {
  table: TableName;
  /** Column filter uniquely identifying the row (pk or composite pk). */
  match: Record<string, string | number>;
}

export interface TenantGraph {
  rows: SeededRow[];
  sharedRows: SeededRow[];
  auditRows: SeededRow[];
  ids: {
    companyId: number;
    schoolId: number;
    locationId: number;
    contactId: number;
    contact2Id: number;
    tagId: number;
    attachmentId: number;
    meetingId: number;
    interactionId: number;
    actionItemId: number;
    calendarEventId: number;
    emailMessageId: number;
    scheduledEmailId: number;
    followUpId: number;
    followUpMessageId: number;
    bundleId: number;
    subscriptionId: number;
    targetCompanyId: number;
    cycleId: number;
    scrapeRunId: number;
  };
}

async function ins<T extends TableName>(
  svc: Db,
  bucket: SeededRow[],
  table: T,
  payload: Tables[T]["Insert"],
  match?: Record<string, string | number>,
): Promise<Tables[T]["Row"]> {
  const { data, error } = await svc
    .from(table)
    .insert(payload as never)
    .select()
    .single();
  if (error) throw new Error(`seed insert into ${table} failed: ${error.message}`);
  const row = data as unknown as Tables[T]["Row"];
  const resolved = match ?? { id: (row as { id: string | number }).id };
  bucket.push({ table, match: resolved });
  return row;
}

export async function seedTenantGraph(svc: Db, userId: string): Promise<TenantGraph> {
  const rows: SeededRow[] = [];
  const shared: SeededRow[] = [];
  const audit: SeededRow[] = [];
  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // The public.users row is created by the on_auth_user_created trigger.
  rows.push({ table: "users", match: { id: userId } });

  // ── Shared catalog ──────────────────────────────────────────────────
  const company = await ins(svc, shared, "companies", { name: uniq("Itest Co") });
  const school = await ins(svc, shared, "schools", { name: uniq("Itest U") });
  const location = await ins(svc, shared, "locations", { city: uniq("Itestville"), state: "UT" });
  await ins(
    svc,
    shared,
    "company_locations",
    { company_id: company.id, location_id: location.id, source: "manual" },
  );

  // ── Contacts and their children ─────────────────────────────────────
  const contact = await ins(svc, rows, "contacts", {
    user_id: userId,
    name: uniq("Contact A"),
    location_id: location.id,
  });
  const contact2 = await ins(svc, rows, "contacts", { user_id: userId, name: uniq("Contact B") });
  await ins(svc, rows, "contact_emails", {
    contact_id: contact.id,
    email: `${uniq("contact")}@example.com`,
    is_primary: true,
  });
  await ins(svc, rows, "contact_phones", { contact_id: contact.id, phone: "+1 555 0100" });
  await ins(svc, rows, "contact_schools", { contact_id: contact.id, school_id: school.id });
  await ins(svc, rows, "contact_companies", {
    contact_id: contact.id,
    company_id: company.id,
    is_current: true,
    title: "PM",
  });

  const tag = await ins(svc, rows, "tags", { user_id: userId, name: uniq("tag") });
  await ins(
    svc,
    rows,
    "contact_tags",
    { contact_id: contact.id, tag_id: tag.id },
    { contact_id: contact.id, tag_id: tag.id },
  );

  // ── Attachments ─────────────────────────────────────────────────────
  const attachment = await ins(svc, rows, "attachments", {
    user_id: userId,
    bucket: "attachments",
    object_path: `${userId}/${uniq("file")}.txt`,
    file_name: "itest.txt",
  });
  await ins(
    svc,
    rows,
    "contact_attachments",
    { contact_id: contact.id, attachment_id: attachment.id },
    { contact_id: contact.id, attachment_id: attachment.id },
  );

  // ── Meetings, transcripts, interactions ─────────────────────────────
  const meeting = await ins(svc, rows, "meetings", {
    user_id: userId,
    meeting_date: nowIso,
    title: uniq("Meeting"),
  });
  await ins(
    svc,
    rows,
    "meeting_contacts",
    { meeting_id: meeting.id, contact_id: contact.id },
    { meeting_id: meeting.id, contact_id: contact.id },
  );
  await ins(
    svc,
    rows,
    "meeting_attachments",
    { meeting_id: meeting.id, attachment_id: attachment.id },
    { meeting_id: meeting.id, attachment_id: attachment.id },
  );
  await ins(svc, rows, "transcript_segments", {
    meeting_id: meeting.id,
    ordinal: 1,
    speaker_label: "S1",
    content: "hello",
  });
  const interaction = await ins(svc, rows, "interactions", {
    contact_id: contact.id,
    interaction_date: nowIso,
    interaction_type: "coffee",
  });
  await ins(
    svc,
    rows,
    "interaction_attachments",
    { interaction_id: interaction.id, attachment_id: attachment.id },
    { interaction_id: interaction.id, attachment_id: attachment.id },
  );
  await ins(svc, rows, "referrals", {
    user_id: userId,
    referred_by_contact_id: contact.id,
    referred_contact_id: contact2.id,
  });

  // ── Action items ────────────────────────────────────────────────────
  const actionItem = await ins(svc, rows, "follow_up_action_items", {
    user_id: userId,
    title: uniq("todo"),
    contact_id: contact.id,
  });
  await ins(svc, rows, "action_item_contacts", {
    action_item_id: actionItem.id,
    contact_id: contact.id,
  });

  // ── Calendar ────────────────────────────────────────────────────────
  const calendarEvent = await ins(svc, rows, "calendar_events", {
    user_id: userId,
    google_event_id: uniq("gevent"),
    start_at: nowIso,
    end_at: soonIso,
  });
  await ins(
    svc,
    rows,
    "calendar_event_contacts",
    { calendar_event_id: calendarEvent.id, contact_id: contact.id },
    { calendar_event_id: calendarEvent.id, contact_id: contact.id },
  );

  // ── Email cache + junction ──────────────────────────────────────────
  const emailMessage = await ins(svc, rows, "email_messages", {
    user_id: userId,
    gmail_message_id: uniq("gmsg"),
    matched_contact_id: contact.id,
  });
  await ins(
    svc,
    rows,
    "email_message_contacts",
    { email_message_id: emailMessage.id, contact_id: contact.id },
    { email_message_id: emailMessage.id, contact_id: contact.id },
  );
  await ins(svc, rows, "email_drafts", { user_id: userId, subject: uniq("draft") });
  await ins(svc, rows, "email_templates", {
    user_id: userId,
    name: uniq("template"),
    prompt: "write",
  });

  // ── Scheduled sends + follow-ups ────────────────────────────────────
  const scheduledEmail = await ins(svc, rows, "scheduled_emails", {
    user_id: userId,
    recipient_email: "target@example.com",
    subject: uniq("subject"),
    body_html: "<p>hi</p>",
    scheduled_send_at: soonIso,
  });
  const followUp = await ins(svc, rows, "email_follow_ups", {
    user_id: userId,
    recipient_email: "target@example.com",
    original_sent_at: nowIso,
    contact_id: contact.id,
    scheduled_email_id: scheduledEmail.id,
  });
  const followUpMessage = await ins(svc, rows, "email_follow_up_messages", {
    follow_up_id: followUp.id,
    sequence_number: 1,
    send_after_days: 3,
    subject: uniq("fu"),
    body_html: "<p>bump</p>",
    scheduled_send_at: soonIso,
  });
  await ins(svc, rows, "ai_follow_up_drafts", {
    user_id: userId,
    contact_id: contact.id,
    subject: uniq("ai"),
    body_html: "<p>ai</p>",
    extracted_topic: "topic",
    topic_evidence: "evidence",
  });

  // ── Gmail connection ────────────────────────────────────────────────
  await ins(svc, rows, "gmail_connections", {
    user_id: userId,
    gmail_address: `${uniq("gmail")}@gmail.com`,
    access_token: "at",
    refresh_token: "rt",
    token_expires_at: soonIso,
  });

  // ── Profile edges ───────────────────────────────────────────────────
  await ins(svc, rows, "user_companies", { user_id: userId, company_id: company.id });
  await ins(svc, rows, "user_schools", { user_id: userId, school_id: school.id });

  // ── Target companies / pipeline ─────────────────────────────────────
  const targetCompany = await ins(svc, rows, "target_companies", {
    user_id: userId,
    company_id: company.id,
  });
  await ins(svc, rows, "target_company_notes", {
    target_company_id: targetCompany.id,
    note: "note",
  });
  const cycle = await ins(svc, rows, "pipeline_cycles", {
    target_company_id: targetCompany.id,
    cycle_number: 1,
  });
  await ins(svc, rows, "pipeline_applications", { id: randomUUID(), cycle_id: cycle.id });
  await ins(svc, rows, "pipeline_interview_rounds", { id: randomUUID(), cycle_id: cycle.id });
  await ins(svc, rows, "pipeline_notes", { id: randomUUID(), cycle_id: cycle.id });
  await ins(svc, rows, "pipeline_programs", { id: randomUUID(), cycle_id: cycle.id });
  await ins(svc, rows, "discovery_candidates", {
    user_id: userId,
    company_id: company.id,
    linkedin_url: `https://linkedin.com/in/${uniq("disc")}`,
    name: "Disc Overy",
    raw: {},
  });

  // ── Scrapes ─────────────────────────────────────────────────────────
  const scrapeRun = await ins(svc, rows, "scrape_runs", {
    user_id: userId,
    actor: "harvestapi/linkedin-profile-scraper",
    mode: "profile",
    trigger: "manual",
  });
  await ins(svc, rows, "contact_scrape_snapshots", {
    user_id: userId,
    contact_id: contact.id,
    scrape_run_id: scrapeRun.id,
    snapshot: {},
  });
  await ins(svc, rows, "contact_change_events", {
    user_id: userId,
    contact_id: contact.id,
    type: "promotion",
    dedupe_key: uniq("dedupe"),
    headline: "Promoted",
  });
  await ins(svc, rows, "suppressed_imports", {
    user_id: userId,
    linkedin_url: `https://linkedin.com/in/${uniq("sup")}`,
  });

  // ── Service-only per-user tables ────────────────────────────────────
  await ins(
    svc,
    rows,
    "user_api_keys",
    { user_id: userId, encrypted_key: "enc", key_last4: "1234" },
    { user_id: userId },
  );
  await ins(svc, rows, "user_ai_access", { user_id: userId }, { user_id: userId });
  const period = nowIso.slice(0, 10);
  await ins(
    svc,
    rows,
    "ai_shared_usage",
    { user_id: userId, period_start: period },
    { user_id: userId, period_start: period },
  );
  await ins(
    svc,
    rows,
    "user_milestones",
    { user_id: userId, milestone: uniq("milestone") },
    { user_id: userId },
  );
  await ins(svc, rows, "analytics_events", { user_id: userId, event: "itest" });

  // ── Bundles ─────────────────────────────────────────────────────────
  const bundle = await ins(svc, shared, "data_bundles", {
    slug: uniq("bundle"),
    name: "Itest Bundle",
    status: "published",
    version: 1,
    published_at: nowIso,
  });
  await ins(svc, shared, "bundle_companies", { bundle_id: bundle.id, company_id: company.id });
  await ins(svc, shared, "bundle_prospects", {
    bundle_id: bundle.id,
    linkedin_url: `https://linkedin.com/in/${uniq("prospect")}`,
    payload: {},
    payload_hash: uniq("hash"),
    version_added: 1,
    version_updated: 1,
    version_last_seen: 1,
  });
  const subscription = await ins(svc, rows, "bundle_subscriptions", {
    user_id: userId,
    bundle_id: bundle.id,
  });
  await ins(svc, rows, "bundle_subscription_contacts", {
    subscription_id: subscription.id,
    contact_id: contact.id,
    linkedin_url: `https://linkedin.com/in/${uniq("bsc")}`,
    created_by_bundle: true,
    first_applied_version: 1,
    last_applied_version: 1,
  });
  await ins(
    svc,
    rows,
    "bundle_contact_state",
    { user_id: userId, contact_id: contact.id },
    { user_id: userId, contact_id: contact.id },
  );
  await ins(
    svc,
    rows,
    "bundle_access_overrides",
    { user_id: userId, bundle_id: bundle.id, allowed: true, updated_by: userId },
    { user_id: userId, bundle_id: bundle.id },
  );

  // ── Audit (no user FK by design — must SURVIVE user deletion) ───────
  await ins(svc, audit, "admin_audit_log", {
    admin_id: userId,
    target_user_id: userId,
    action: "itest_seed",
  });

  return {
    rows,
    sharedRows: shared,
    auditRows: audit,
    ids: {
      companyId: company.id,
      schoolId: school.id,
      locationId: location.id,
      contactId: contact.id,
      contact2Id: contact2.id,
      tagId: tag.id,
      attachmentId: attachment.id,
      meetingId: meeting.id,
      interactionId: interaction.id,
      actionItemId: actionItem.id,
      calendarEventId: calendarEvent.id,
      emailMessageId: emailMessage.id,
      scheduledEmailId: scheduledEmail.id,
      followUpId: followUp.id,
      followUpMessageId: followUpMessage.id,
      bundleId: bundle.id,
      subscriptionId: subscription.id,
      targetCompanyId: targetCompany.id,
      cycleId: cycle.id,
      scrapeRunId: scrapeRun.id,
    },
  };
}

/** Every table seedTenantGraph touches, all buckets. */
export function coveredTables(graph: TenantGraph): Set<string> {
  const s = new Set<string>();
  for (const bucket of [graph.rows, graph.sharedRows, graph.auditRows]) {
    for (const r of bucket) s.add(r.table);
  }
  return s;
}

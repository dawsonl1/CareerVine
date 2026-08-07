/**
 * Insert a locally-transcribed call into CareerVine as a meeting with
 * speaker-attributed transcript segments.
 *
 *   node scripts/local-transcribe/ingest.ts \
 *     --turns call.turns.json --contact 350 \
 *     --date 2026-08-06T20:30:00Z --title "Informational call with Lance Johnson" \
 *     [--type video] [--zoom-link URL] [--apply]
 *
 * Dry run unless --apply is passed.
 *
 * Speaker identity is DETERMINISTIC here, not inferred. A 1:1 networking call
 * has two voices: the contact on the meeting, and you. Turns labelled with the
 * contact's name get `contact_id`; yours stay unmapped, which is what the
 * viewer already expects (there is no "me" contact, and TranscriptViewer falls
 * back to `speaker_label`). No LLM call, no cost. For 3+ speakers, leave the
 * extra labels unmapped and use the app's AI matcher.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { toPlainText, type MergedTurn } from "../../src/lib/transcript-merge.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return v;
}

const APPLY = process.argv.includes("--apply");

// Env comes from .env.local, same file the app uses.
const envPath = new URL("../../.env.local", import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const supabase = createClient(url, key);

const turns = JSON.parse(readFileSync(required("turns"), "utf8")) as MergedTurn[];
if (!Array.isArray(turns) || turns.length === 0) {
  console.error("turns file is empty");
  process.exit(1);
}

const contactId = Number(required("contact"));
const meetingDate = required("date");
const title = required("title");
// "coffee" is the one-on-one bucket and covers the video/phone calls this
// script ingests (CAR-242); the DB CHECK rejects the old "video".
const meetingType = arg("type") ?? "coffee";
const zoomLink = arg("zoom-link") ?? null;

const { data: contact, error: contactErr } = await supabase
  .from("contacts")
  .select("id, name, user_id")
  .eq("id", contactId)
  .single();
if (contactErr || !contact) {
  console.error(`contact ${contactId} not found: ${contactErr?.message ?? "no row"}`);
  process.exit(1);
}

const labels = [...new Set(turns.map((t) => t.speakerLabel))];
const contactLabel = labels.find((l) => l.toLowerCase() === contact.name.toLowerCase());
if (!contactLabel) {
  console.error(
    `no speaker label matches "${contact.name}". Labels present: ${labels.join(", ")}\n` +
      `Re-run the transcription with --names so one label is exactly the contact's name.`,
  );
  process.exit(1);
}

const rawText = toPlainText(turns);

// Refuse to ingest the same call twice. Keyed on the day, since a re-run
// produces a new meeting rather than updating one.
const dayStart = new Date(meetingDate);
dayStart.setUTCHours(0, 0, 0, 0);
const dayEnd = new Date(dayStart);
dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

const { data: existing } = await supabase
  .from("meetings")
  .select("id, title, meeting_date, transcript_source")
  .eq("user_id", contact.user_id)
  .gte("meeting_date", dayStart.toISOString())
  .lt("meeting_date", dayEnd.toISOString());

console.log(`contact:  ${contact.name} (id ${contact.id})`);
console.log(`turns:    ${turns.length}`);
console.log(`words:    ${rawText.split(/\s+/).filter(Boolean).length}`);
console.log(`speakers: ${labels.join(", ")}  (mapping "${contactLabel}" → contact ${contactId})`);
if (existing?.length) {
  console.log(`\nexisting meetings that day:`);
  for (const m of existing) console.log(`  #${m.id} ${m.meeting_date} ${m.title ?? ""} [${m.transcript_source ?? "-"}]`);
}

if (!APPLY) {
  console.log("\n[dry run] nothing written. Re-run with --apply");
  process.exit(0);
}

if (existing?.some((m) => m.transcript_source === "audio_local")) {
  console.error("\na locally-transcribed meeting already exists that day — refusing to duplicate");
  process.exit(1);
}

const { data: meeting, error: meetingErr } = await supabase
  .from("meetings")
  .insert({
    user_id: contact.user_id,
    meeting_date: meetingDate,
    meeting_type: meetingType,
    title,
    zoom_link: zoomLink,
    transcript: rawText,
    transcript_source: "audio_local",
    transcript_parsed: true,
  })
  .select("id")
  .single();
if (meetingErr || !meeting) {
  console.error(`meeting insert failed: ${meetingErr?.message}`);
  process.exit(1);
}
console.log(`\n✓ meeting ${meeting.id} created`);

const { error: linkErr } = await supabase
  .from("meeting_contacts")
  .insert({ meeting_id: meeting.id, contact_id: contactId });
if (linkErr) {
  console.error(`contact link failed: ${linkErr.message}`);
  process.exit(1);
}
console.log(`✓ linked contact ${contactId}`);

const { error: segErr } = await supabase.from("transcript_segments").insert(
  turns.map((t) => ({
    meeting_id: meeting.id,
    ordinal: t.ordinal,
    speaker_label: t.speakerLabel,
    contact_id: t.speakerLabel === contactLabel ? contactId : null,
    started_at: t.startedAt,
    ended_at: t.endedAt,
    content: t.content,
  })),
);
if (segErr) {
  console.error(`segment insert failed: ${segErr.message}`);
  process.exit(1);
}
console.log(`✓ ${turns.length} transcript segments inserted`);
console.log(`\nmeeting id: ${meeting.id}`);

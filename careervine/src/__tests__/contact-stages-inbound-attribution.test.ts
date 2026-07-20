import { describe, it, expect, beforeEach } from "vitest";
import { getContactStages, setCompanyQueriesClient } from "@/lib/company-queries";

/**
 * CAR-159 review F9: on a thread shared by several contacts, an inbound reply
 * must count as a REPLY only for the contact who actually sent it (their
 * address is the message's from_address), not for cc'd co-recipients who merely
 * received it. Otherwise a reply-all flips every linked contact to stage
 * "replied" and silences their follow-ups.
 *
 * Drives the real getContactStages aggregation through a tiny fake client that
 * serves the junction (email_message_contacts -> email_messages) and
 * contact_emails legs; all other signal legs resolve empty.
 */

const USER = "user-1";
const RECRUITER = 7; // recruiter@corp.com — the sender who replied
const HM = 8; // hm@corp.com — cc'd co-recipient, never wrote back

interface Rows {
  email_message_contacts: Array<Record<string, unknown>>;
  contact_emails: Array<Record<string, unknown>>;
}

function makeClient(rows: Rows) {
  // Minimal query-builder double: records the target table, ignores filters
  // (the test controls the returned rows directly), and resolves the seeded
  // rows for the two legs getContactStages reads here.
  function from(table: string) {
    const notNullCols: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "gte", "lt", "neq"]) {
      builder[m] = () => builder;
    }
    // Honor .not(col, "is", null): the bounces leg reuses contact_emails with
    // this filter, so it must only match rows that actually carry that column.
    builder.not = (col: string) => { notNullCols.push(col); return builder; };
    builder.range = () => builder;
    builder.then = (resolve: (v: unknown) => void) => {
      let data = (rows as unknown as Record<string, Array<Record<string, unknown>>>)[table] ?? [];
      for (const col of notNullCols) data = data.filter((r) => r[col] != null);
      resolve({ data, error: null });
    };
    return builder;
  }
  return { from } as unknown as Parameters<typeof setCompanyQueriesClient>[0];
}

describe("getContactStages — inbound reply attribution (CAR-159 F9)", () => {
  beforeEach(() => {
    // outbound to BOTH; recruiter replies-all (inbound from recruiter@corp.com,
    // linked to both contacts via the junction).
    setCompanyQueriesClient(
      makeClient({
        email_message_contacts: [
          { contact_id: RECRUITER, email_messages: { user_id: USER, direction: "outbound", date: "2026-07-01", from_address: "me@gmail.com", is_simulated: false } },
          { contact_id: HM, email_messages: { user_id: USER, direction: "outbound", date: "2026-07-01", from_address: "me@gmail.com", is_simulated: false } },
          { contact_id: RECRUITER, email_messages: { user_id: USER, direction: "inbound", date: "2026-07-02", from_address: "recruiter@corp.com", is_simulated: false } },
          { contact_id: HM, email_messages: { user_id: USER, direction: "inbound", date: "2026-07-02", from_address: "recruiter@corp.com", is_simulated: false } },
        ],
        contact_emails: [
          { contact_id: RECRUITER, email: "recruiter@corp.com" },
          { contact_id: HM, email: "hm@corp.com" },
        ],
      })
    );
  });

  it("credits the reply to the sender, not the cc'd co-recipient", async () => {
    const stages = await getContactStages(USER, [
      { id: RECRUITER, stage_override: null },
      { id: HM, stage_override: null },
    ]);

    // The recruiter sent the inbound -> "replied".
    expect(stages.get(RECRUITER)?.stage).toBe("replied");
    // The hiring manager only received it (address in to, not from) -> they
    // were contacted but have NOT replied, so the follow-up nudge survives.
    expect(stages.get(HM)?.stage).toBe("contacted");
  });
});

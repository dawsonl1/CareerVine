import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  searchContactsSchema,
  addContactSchema,
  setNetworkStatusSchema,
} from "../tools/contacts";
import { sendEmailSchema, scheduleEmailSchema, followUpSequenceSchema } from "../tools/email";

describe("tool input schemas", () => {
  it("search_contacts accepts a plain query and rejects bogus tiers", () => {
    const schema = z.object(searchContactsSchema);
    expect(schema.parse({ query: "google" })).toMatchObject({ query: "google" });
    expect(schema.parse({ query: "pm", tiers: ["prospect"], limit: 5 }).limit).toBe(5);
    expect(() => schema.parse({ query: "" })).toThrow();
    expect(() => schema.parse({ query: "x", tiers: ["vip"] })).toThrow();
    expect(() => schema.parse({ query: "x", limit: 500 })).toThrow();
  });

  it("add_contact requires a name and accepts the full nested shape", () => {
    const schema = z.object(addContactSchema);
    expect(() => schema.parse({})).toThrow();
    const full = schema.parse({
      name: "Jane Doe",
      emails: ["jane@acme.com"],
      phones: [{ phone: "555-1234" }],
      company: { name: "Acme", title: "PM" },
      school: { name: "BYU", degree: "BS" },
      location: { city: "Provo", state: "UT", country: "United States" },
      network_status: "prospect",
    });
    expect(full.company?.name).toBe("Acme");
    expect(() => schema.parse({ name: "X", network_status: "vip" })).toThrow();
  });

  it("set_network_status only accepts the three tiers", () => {
    const schema = z.object(setNetworkStatusSchema);
    expect(schema.parse({ contact_id: 1, status: "bench" }).status).toBe("bench");
    expect(() => schema.parse({ contact_id: 1, status: "deleted" })).toThrow();
  });

  it("send_email demands the literal confirm:true", () => {
    const schema = z.object(sendEmailSchema);
    const base = { contact_id: 1, subject: "Hi", body: "Hello" };
    expect(() => schema.parse(base)).toThrow();
    expect(() => schema.parse({ ...base, confirm: false })).toThrow();
    expect(schema.parse({ ...base, confirm: true }).confirm).toBe(true);
  });

  it("schedule_email requires send_at", () => {
    const schema = z.object(scheduleEmailSchema);
    expect(() => schema.parse({ contact_id: 1, subject: "Hi", body: "B" })).toThrow();
    expect(
      schema.parse({ contact_id: 1, subject: "Hi", body: "B", send_at: "2026-08-01T09:00:00Z" }).send_at,
    ).toBe("2026-08-01T09:00:00Z");
  });

  it("follow-up sequences need at least one positive-delay message", () => {
    const schema = z.object(followUpSequenceSchema);
    expect(() => schema.parse({ contact_id: 1, thread_id: "t", messages: [] })).toThrow();
    expect(() =>
      schema.parse({
        contact_id: 1,
        thread_id: "t",
        messages: [{ subject: "s", body: "b", send_after_days: 0 }],
      }),
    ).toThrow();
    const good = schema.parse({
      contact_id: 1,
      thread_id: "t",
      messages: [{ subject: "s", body: "b", send_after_days: 3 }],
    });
    expect(good.messages).toHaveLength(1);
  });
});

describe("CRLF rejection on header-bound MCP args (CAR-143)", () => {
  const INJECTED = "Hi\r\nBcc: attacker@evil.com";

  it("send/draft/schedule subjects and to_email reject line breaks", () => {
    const schema = z.object(scheduleEmailSchema);
    const base = { contact_id: 1, body: "b", send_at: "2026-08-01T09:00:00Z" };
    expect(schema.parse({ ...base, subject: "Hi" }).subject).toBe("Hi");
    expect(() => schema.parse({ ...base, subject: INJECTED })).toThrow();
    expect(() =>
      schema.parse({ ...base, subject: "Hi", to_email: "a@x.com\nBcc: e@e.com" }),
    ).toThrow();
  });

  it("follow-up sequence step subjects reject line breaks", () => {
    const schema = z.object(followUpSequenceSchema);
    expect(() =>
      schema.parse({
        contact_id: 1,
        thread_id: "t",
        messages: [{ subject: INJECTED, body: "b", send_after_days: 3 }],
      }),
    ).toThrow();
  });
});

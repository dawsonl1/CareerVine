/**
 * A deleted company stays deleted (CAR-271).
 *
 * The ask this file exists to prove, in Dawson's words: "If I delete them, they
 * shouldn't come back with a resync of the data bundle or importing a new
 * contact."
 *
 * INTEGRATION TIER, and not by preference. Every mechanism below is a property
 * of real Postgres that a mock cannot express, and in each case the mock would
 * express the OPPOSITE:
 *
 *  - The recreate guards work by hitting a partial unique index
 *    (`target_companies_user_company_companywide`, UNIQUE on (user_id,
 *    company_id) WHERE location_id IS NULL) or by finding the row it protects.
 *    A builder mock has no index, so the duplicate insert this file forbids
 *    would simply SUCCEED against a mock and the test would pass while the
 *    feature was broken.
 *  - `company_network_counts` is SQL. There is no TS copy of it to stub.
 *  - The counts RPC is `security invoker` and filters on the signed-in user, so
 *    it only returns anything through a tenant's own session client.
 *
 * The three tests map one-to-one onto the three ways a company can come back:
 * the bundle/sheet re-import path, the contact-import path, and the page that
 * lists companies derived from contacts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTenant,
  serviceClient,
  deleteTenant,
  uniq,
  type Db,
  type Tenant,
} from "./helpers/stack";
import { ensureCompanyTargets } from "@/lib/company-helpers";

let tenant: Tenant;
let service: Db;
let companyId: number;
/** A never-deleted company, used only as the control for the guard below. */
let controlCompanyId: number;
let contactId: number;

/** The company-wide scope row, which is where the tombstone lives. */
async function companyWideRow() {
  const { data } = await service
    .from("target_companies")
    .select("id, is_deleted, is_targeted")
    .eq("user_id", tenant.userId)
    .eq("company_id", companyId)
    .is("location_id", null)
    .maybeSingle();
  return data as { id: number; is_deleted: boolean; is_targeted: boolean } | null;
}

async function allScopeRows() {
  const { data } = await service
    .from("target_companies")
    .select("id, location_id, is_deleted")
    .eq("user_id", tenant.userId)
    .eq("company_id", companyId);
  return (data ?? []) as Array<{ id: number; location_id: number | null; is_deleted: boolean }>;
}

beforeAll(async () => {
  tenant = await createTenant("del-owner");
  service = serviceClient();

  const { data: company, error: companyErr } = await service
    .from("companies")
    .insert({ name: uniq("Deletable Corp") })
    .select("id")
    .single();
  if (companyErr) throw companyErr;
  companyId = (company as { id: number }).id;

  const { data: control, error: controlErr } = await service
    .from("companies")
    .insert({ name: uniq("Control Corp") })
    .select("id")
    .single();
  if (controlErr) throw controlErr;
  controlCompanyId = (control as { id: number }).id;

  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .insert({ user_id: tenant.userId, name: uniq("Roster Person"), network_status: "active" })
    .select("id")
    .single();
  if (contactErr) throw contactErr;
  contactId = (contact as { id: number }).id;

  const { error: employmentErr } = await service
    .from("contact_companies")
    .insert({ contact_id: contactId, company_id: companyId, is_current: true });
  if (employmentErr) throw employmentErr;
});

afterAll(async () => {
  await service.from("contact_companies").delete().eq("contact_id", contactId);
  await service.from("contacts").delete().eq("id", contactId);
  await service.from("target_companies").delete().eq("company_id", companyId);
  await service.from("target_companies").delete().eq("company_id", controlCompanyId);
  await service.from("companies").delete().eq("id", companyId);
  await service.from("companies").delete().eq("id", controlCompanyId);
  await deleteTenant(tenant.userId);
});

beforeEach(async () => {
  // Each test owns the scope rows; start from "no rows at all", which is the
  // state a company reaching the list purely through contacts is actually in.
  await service.from("target_companies").delete().eq("user_id", tenant.userId).eq("company_id", companyId);
  await service
    .from("target_companies")
    .delete()
    .eq("user_id", tenant.userId)
    .eq("company_id", controlCompanyId);
});

describe("a deleted company survives a contact import", () => {
  it("is not re-targeted when a new contact who works there is imported", async () => {
    // Delete a company that was never a target: the tombstone has to be MINTED,
    // which is the case a suppression-table design would get wrong, because
    // there would be no row for the guard below to find.
    const { error } = await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId, is_targeted: false, is_deleted: true });
    if (error) throw error;

    // CONTROL, and it is not optional. `ensureCompanyTargets` never throws for
    // its caller's sake — it logs and swallows — so it returns 0 both when the
    // tombstone stopped it and when the call failed outright. Without a live
    // company proving the helper actually creates rows through this harness,
    // `toBe(0)` below would pass just as happily against a broken call.
    const controlCreated = await ensureCompanyTargets(service as never, tenant.userId, [controlCompanyId]);
    expect(controlCreated).toBe(1);

    // The real chokepoint, called with the real client. This is what every
    // deliberate single-person add funnels through — extension import, the
    // manual add form, the contact edit modal, discovery, and MCP add_contact.
    const created = await ensureCompanyTargets(service as never, tenant.userId, [companyId]);

    expect(created).toBe(0);
    const row = await companyWideRow();
    expect(row?.is_deleted).toBe(true);
    // Still exactly one row: the guard skipped rather than racing the index.
    expect(await allScopeRows()).toHaveLength(1);
  });

  it("leaves the contact and their employment untouched", async () => {
    // The locked decision: deleting a company profile is not a way to delete
    // people. The roster row is the thing every "works at X" label reads.
    await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId, is_deleted: true });

    const { data: employment } = await service
      .from("contact_companies")
      .select("contact_id, is_current")
      .eq("company_id", companyId);
    expect(employment).toHaveLength(1);

    const { data: contact } = await service
      .from("contacts")
      .select("id, network_status")
      .eq("id", contactId)
      .single();
    expect((contact as { network_status: string }).network_status).toBe("active");
  });
});

describe("a deleted company survives a re-import of the target sheet", () => {
  it("keeps is_deleted when the re-import refreshes research fields", async () => {
    const { error } = await service.from("target_companies").insert({
      user_id: tenant.userId,
      company_id: companyId,
      program_name: "Old program",
      is_deleted: true,
    });
    if (error) throw error;

    // Exactly what /api/target-companies/bulk-import writes on its update
    // branch: research fields, and deliberately nothing else. The point of the
    // assertion is the columns it does NOT name.
    const { error: updateErr } = await service
      .from("target_companies")
      .update({ priority_score: 5, program_name: "APM 2027", app_window_text: "Fall" })
      .eq("user_id", tenant.userId)
      .eq("company_id", companyId)
      .is("location_id", null);
    if (updateErr) throw updateErr;

    const row = await companyWideRow();
    expect(row?.is_deleted).toBe(true);
  });

  it("cannot be recreated as a second company-wide row", async () => {
    // The partial unique index is the last line of defence, and the reason this
    // test is integration-tier: if a future recreate path stops consulting the
    // tombstone and just inserts, Postgres refuses. A mock would accept it.
    await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId, is_deleted: true });

    const { error } = await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId });

    expect(error).not.toBeNull();
    expect((error as { code: string }).code).toBe("23505");
  });
});

describe("company_network_counts hides a deleted company", () => {
  /**
   * Through the TENANT's session client, not the service client: the rpc is
   * `security invoker`, so under service-role `auth.uid()` is NULL and RLS is
   * bypassed. Passing p_user_id explicitly is what the MCP path does and what
   * the web path does since CAR-229.
   */
  async function countsForScope(scope: string): Promise<number[]> {
    const { data, error } = await tenant.client.rpc("company_network_counts", {
      p_user_id: tenant.userId,
      p_scope: scope,
      p_min_contacts: 1,
      p_extra_company_ids: [],
    });
    if (error) throw error;
    return ((data ?? []) as Array<{ company_id: number }>).map((r) => r.company_id);
  }

  it("returns the company while it is live", async () => {
    // Falsification: without this the next test proves nothing, because a
    // fixture that never surfaced the company would pass an absence assertion
    // for the wrong reason.
    expect(await countsForScope("in_play")).toContain(companyId);
    expect(await countsForScope("all")).toContain(companyId);
  });

  it("drops it from the contact-derived leg once deleted", async () => {
    await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId, is_deleted: true });

    // The contact who works there is untouched and still current, so the ONLY
    // reason the company can be absent is the tombstone. This is the assertion
    // that stands for "a bundle resync will not put it back": resync creates
    // contacts, and contacts are what this leg derives companies from.
    expect(await countsForScope("in_play")).not.toContain(companyId);
    expect(await countsForScope("all")).not.toContain(companyId);
  });

  it("drops it from the extras leg too, even when a caller passes its id", async () => {
    await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId, is_deleted: true });

    // selectCompanyIds WIDENS — it seeds the candidate set with every target id
    // unconditionally — so the rpc must not trust its own extras argument to
    // have been pre-filtered.
    const { data, error } = await tenant.client.rpc("company_network_counts", {
      p_user_id: tenant.userId,
      p_scope: "targets",
      p_min_contacts: 1,
      p_extra_company_ids: [companyId],
    });
    if (error) throw error;
    expect(((data ?? []) as Array<{ company_id: number }>).map((r) => r.company_id)).not.toContain(
      companyId,
    );
  });

  it("comes back when the tombstone is cleared, which is the re-add path", async () => {
    await service
      .from("target_companies")
      .insert({ user_id: tenant.userId, company_id: companyId, is_deleted: true });
    expect(await countsForScope("in_play")).not.toContain(companyId);

    // What addTargetCompany does when the user names this company in the Add
    // company modal. Proves the filter is the flag and not something incidental
    // about the fixture.
    await service
      .from("target_companies")
      .update({ is_deleted: false })
      .eq("user_id", tenant.userId)
      .eq("company_id", companyId);

    expect(await countsForScope("in_play")).toContain(companyId);
  });
});

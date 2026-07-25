/**
 * Teardown project (CAR-196): delete the tenant `auth.setup.ts` provisioned.
 *
 * `e2e/helpers/tenant.ts` has described this project since CAR-189 — "where the
 * setup project parks state the teardown project needs" — but nothing ever
 * declared it, and `deleteTenant` had zero call sites under `e2e/`. A local
 * stack had 21 orphaned `itest-e2e-*` tenants by the time CAR-196 counted them.
 * Harmless in CI, where the whole stack is thrown away, but this tier is meant
 * to be run locally too, and CAR-191 triples the rate.
 *
 * Wired via the setup project's `teardown` property, so Playwright runs it after
 * every project that depends on `setup` has finished — including on failure.
 *
 * Deliberately forgiving: a missing tenant file means setup never got far enough
 * to create anything, which is a failure the setup project has already reported.
 * Turning it into a second, less informative failure here would only bury it.
 */
import fs from "node:fs";
import { test as teardown } from "@playwright/test";
import { TENANT_FILE, deleteTenant, type E2ETenantRecord } from "./helpers/tenant";

teardown("delete the provisioned tenant", async () => {
  let record: E2ETenantRecord;
  try {
    record = JSON.parse(fs.readFileSync(TENANT_FILE, "utf8")) as E2ETenantRecord;
  } catch {
    console.warn(`[e2e-teardown] no ${TENANT_FILE}; nothing to clean up`);
    return;
  }

  // Cascades to public.users and every user-owned row through the schema's
  // foreign keys, which is why deleting the auth user is the whole cleanup.
  await deleteTenant(record.userId);
  fs.rmSync(TENANT_FILE, { force: true });
});

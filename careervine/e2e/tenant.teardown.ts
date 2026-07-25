/**
 * Teardown project (CAR-196): delete the tenant `auth.setup.ts` provisioned, and
 * sweep any left behind by runs that could not clean up after themselves.
 *
 * `e2e/helpers/tenant.ts` has described this project since CAR-189 — "where the
 * setup project parks state the teardown project needs" — but nothing ever
 * declared it, and `deleteTenant` had zero call sites under `e2e/`. A local
 * stack had 21 orphaned `itest-e2e-*` tenants (plus 2 `e2e-signup-*` users) by
 * the time CAR-196 counted them. Harmless in CI, where the whole stack is thrown
 * away, but this tier is meant to be run locally too.
 *
 * Wired via the setup project's `teardown` property, so Playwright runs it after
 * every project that depends on `setup` has finished, including on failure.
 *
 * WHY IT SWEEPS RATHER THAN DELETING ONE ROW. Deleting only the recorded tenant
 * cannot converge, because the cases that orphan a tenant are exactly the cases
 * where the record is missing or stale:
 *   - Ctrl-C skips this project entirely (Playwright abandons the phase loop on
 *     SIGINT), leaving a live tenant AND its record on disk; the next run's
 *     setup overwrites that record before this ever reads it, so the older
 *     tenant becomes unreachable to any future teardown.
 *   - A crash between `createTenant` and the record write (narrowed but not
 *     eliminated by the early write in auth.setup.ts).
 * A prefix sweep converges from any of those states. It is scoped to the
 * `itest-e2e-*` local address space this tier mints, so it cannot touch a real
 * account, and the integration tier's tenants use different labels
 * (`itest-cascade-doomed-*` and so on) and are not matched.
 *
 * This file imports `test` from `@playwright/test`, NOT the guarded `./fixtures/
 * test`, which is a deliberate exception to that file's own rule. The guard's
 * fixture depends on `page`, and requesting it here would launch a browser for a
 * pure-Node cleanup. The network assertion this forgoes is not lost: it moved to
 * `e2e/global-teardown.ts`, which covers this project's interval too.
 */
import fs from "node:fs";
import { test as teardown } from "@playwright/test";
import { TENANT_FILE, deleteTenant, serviceClient, type E2ETenantRecord } from "./helpers/tenant";

/**
 * Local-only address spaces this tier mints, never real accounts.
 *
 * `itest-e2e-` is the setup project's tenant; `e2e-signup-` is the account the
 * signup spec creates for itself. Both have their own cleanup — this sweep is
 * for the runs where that cleanup could not happen (SIGINT, a crash between
 * creation and the record write, a record displaced by a later run).
 */
const E2E_EMAIL_PREFIXES = ["itest-e2e-", "e2e-signup-"];

teardown("delete the provisioned tenant", async () => {
  let recorded: string | undefined;
  try {
    const record = JSON.parse(fs.readFileSync(TENANT_FILE, "utf8")) as E2ETenantRecord;
    recorded = record.userId;
  } catch {
    // No record: setup died before its first write, or this is a stack carrying
    // only older residue. The sweep below still converges.
  }

  // Cascades to public.users and every user-owned row through the schema's
  // foreign keys, which is why deleting the auth user is the whole cleanup.
  if (recorded) await deleteTenant(recorded);
  fs.rmSync(TENANT_FILE, { force: true });

  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    // Do not fail the run over a best-effort sweep; the recorded tenant, which
    // is the part this project is responsible for, is already gone.
    console.warn(`[e2e-teardown] could not list users to sweep: ${error.message}`);
    return;
  }

  const stragglers = data.users.filter(
    (u) => u.id !== recorded && E2E_EMAIL_PREFIXES.some((p) => u.email?.startsWith(p)),
  );
  for (const user of stragglers) await deleteTenant(user.id);
  if (stragglers.length > 0) {
    console.warn(`[e2e-teardown] swept ${stragglers.length} orphaned E2E account(s)`);
  }
});

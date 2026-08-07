/**
 * Compile-time half of the `enrich` contract (CAR-229).
 *
 * NOT a runtime test — no `.test.ts` suffix, so vitest ignores the file — but
 * `tsc --noEmit` (the `web` CI job) and `next build` both typecheck it. Each
 * `@ts-expect-error` asserts that a specific way of misusing the option is a
 * compile error; if the constraint ever weakens, the directive stops
 * suppressing anything, becomes an unused directive (TS2578), and CI goes red.
 *
 * This is the guard that matters most for the option. The runtime sibling can
 * prove that `alum_count` is absent from an unenriched row, but only the type
 * system can stop a consumer from reading it in the first place — and the
 * failure mode being prevented (a company reported as having 0 alumni because
 * nobody asked) produces no error at all at runtime.
 */
import { getCompanies, type CompanyBaseSummary, type CompanySummary, type LeadDetail } from "@/lib/company-queries";
import { nextActionForCompany } from "@/lib/company-next-action";
import { buildOutreachQueue } from "@/lib/outreach-queue";

const USER = "user";

// ── What must keep compiling: every pre-existing call shape ───────────────

export async function enrichedByDefault(): Promise<void> {
  const noOpts: CompanySummary[] = await getCompanies(USER);
  const emptyOpts: CompanySummary[] = await getCompanies(USER, {});
  // The /companies call, and the two MCP ones.
  const list: CompanySummary[] = await getCompanies(USER, { scope: "in_play", sort: "next", minContacts: 1 });
  const targets: CompanySummary[] = await getCompanies(USER, { scope: "targets" });
  // NOT scope:"all" — see the refusal below. It used to appear here.
  const explicit: CompanySummary[] = await getCompanies(USER, { scope: "targets", enrich: true });

  // The seven fields are real numbers/values on the enriched row, not optionals.
  const alum: number = list[0].alum_count;
  const lead: string | null = list[0].lead_contact_name;
  const detail: { count: number; at: string | null } | null = list[0].traction_detail;
  const leadDetail: LeadDetail | null = list[0].lead_detail;
  void [detail, leadDetail];
  // Null for a company the ladder has nothing to say about (CAR-246).
  const rank: number = nextActionForCompany(list[0])?.rank ?? 0;

  void [noOpts, emptyOpts, targets, explicit, alum, lead, rank];
}

// ── The unenriched call ───────────────────────────────────────────────────

export async function unenriched(): Promise<void> {
  const rows: CompanyBaseSummary[] = await getCompanies(USER, {
    scope: "targets",
    sort: "priority",
    enrich: false,
  });

  // Base fields are untouched and fully typed.
  const name: string = rows[0].name;
  const current: number = rows[0].current_count;
  const status: string | undefined = rows[0].target?.status;

  // The queue builder carries the row type through, so /outreach's queue stays
  // unenriched end to end rather than being silently widened back.
  const queue: CompanyBaseSummary[] = buildOutreachQueue(rows, new Date().toISOString()).queue;

  void [name, current, status, queue];
}

// ── The four ways this can go wrong, each a compile error ─────────────────

export async function refusals(): Promise<void> {
  const rows = await getCompanies(USER, { scope: "targets", sort: "priority", enrich: false });

  // 1. Reading a field that was never computed. THE failure this option exists
  //    to make impossible — at runtime it would have been a plausible `0`.
  // @ts-expect-error alum_count is not on an unenriched summary
  void rows[0].alum_count;
  // @ts-expect-error traction is not on an unenriched summary
  void rows[0].traction;
  // @ts-expect-error lead_contact_name is not on an unenriched summary
  void rows[0].lead_contact_name;
  // @ts-expect-error traction_detail is not on an unenriched summary
  void rows[0].traction_detail;
  // @ts-expect-error lead_detail is not on an unenriched summary
  void rows[0].lead_detail;

  // 1b. Asking for the enrichment on a scope that never computes it (CAR-262).
  //     `all` is unbounded — 7,433 companies in production — so the pass has
  //     always been skipped for it, while the return type went on claiming the
  //     five fields were real. They arrived as 0/null, and MCP list_companies
  //     reported "no traction anywhere" for companies with live threads.
  //     Now the only way to search all companies is the unenriched shape, where
  //     those fields are structurally absent instead of confidently wrong.
  // @ts-expect-error scope "all" cannot be enriched
  void (await getCompanies(USER, { scope: "all", search: "acme" }));
  // @ts-expect-error not even when enrich is spelled out
  void (await getCompanies(USER, { scope: "all", enrich: true, sort: "name" }));
  // ...and the unenriched form of the same call still compiles.
  const allUnenriched: CompanyBaseSummary[] = await getCompanies(USER, {
    scope: "all",
    search: "acme",
    enrich: false,
    sort: "name",
  });
  void allUnenriched;

  // 2. Laundering an unenriched row into somewhere that reads those fields.
  // @ts-expect-error a CompanyBaseSummary is not a CompanySummary
  const laundered: CompanySummary = rows[0];
  // @ts-expect-error nextActionForCompany reads the enrichment fields
  void nextActionForCompany(rows[0]);
  void laundered;

  // 3. An unenriched call that leaves `sort` to the default — which would be
  //    "next" for the pursuing/in_play scopes.
  // @ts-expect-error sort is required when enrich is false
  void (await getCompanies(USER, { scope: "pursuing", enrich: false }));

  // 4. An unenriched call naming a sort that reads the enrichment.
  // @ts-expect-error sort "next" needs the enrichment pass
  void (await getCompanies(USER, { scope: "targets", sort: "next", enrich: false }));
  // @ts-expect-error sort "traction" needs the enrichment pass
  void (await getCompanies(USER, { scope: "targets", sort: "traction", enrich: false }));
}

/**
 * POST /api/admin/bundles/publish — admin-only bundle publish flow (plan 29).
 *
 * Machine route in the cron-route style (no user session): authenticated by
 * the BUNDLE_ADMIN_TOKEN bearer secret and run on the service-role client —
 * bundle content tables deliberately have no user write policies.
 *
 * Modes: begin (claim publish lock) → prospects/companies chunks (≤50) →
 * finalize (commit version, or skip the bump on a zero-change run) | abort.
 * Driven by careervine/scripts/publish-bundle.mjs.
 */

import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { bundlePublishSchema } from "@/lib/api-schemas";
import { bundleCompanyEntrySchema, mappedPersonToBundlePayload } from "@/lib/bundle-payload";
import { mapPeopleRecord, ScrapeMappingError, type PeopleRecord } from "@/lib/scrape-mapper";
import {
  beginPublish,
  publishProspectsChunk,
  publishCompaniesChunk,
  finalizePublish,
  abortPublish,
  BundlePublishError,
} from "@/lib/bundle-publish";
import { resolveBundleChunk, markBundleResolved } from "@/lib/bundle-resolve";
import { enqueueBundleSyncJobs, findStaleSubscriptionIds } from "@/lib/bundle-queue";

export const maxDuration = 60;

/** Constant-time bearer check; digests equalize length so timingSafeEqual
 * never throws on mismatched input sizes. */
export function isAuthorizedAdminToken(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!isAuthorizedAdminToken(req.headers.get("authorization"), process.env.BUNDLE_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bundlePublishSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: `${issue?.path?.join(".") ?? ""} ${issue?.message ?? "invalid body"}`.trim() },
      { status: 400 },
    );
  }

  const service = createSupabaseServiceClient();
  const input = parsed.data;

  try {
    switch (input.mode) {
      case "begin": {
        const result = await beginPublish(service, {
          slug: input.slug,
          name: input.name,
          description: input.description,
        });
        return NextResponse.json(result);
      }
      case "prospects": {
        let payloads = input.people;
        if (input.peopleFormat === "people_record") {
          // Convert raw pipeline records server-side so the driver script
          // stays dumb; scraper-format knowledge lives in scrape-mapper only.
          payloads = input.people.map((record, i) => {
            try {
              return mappedPersonToBundlePayload(mapPeopleRecord(record as PeopleRecord));
            } catch (err) {
              throw new BundlePublishError(
                `Record ${i} failed conversion: ${err instanceof ScrapeMappingError || err instanceof Error ? err.message : "unknown"}`,
              );
            }
          });
        }
        const result = await publishProspectsChunk(service, input.slug, input.stagingVersion, payloads);
        return NextResponse.json(result);
      }
      case "companies": {
        const companies = input.companies.map((c, i) => {
          const parsedCompany = bundleCompanyEntrySchema.safeParse(c);
          if (!parsedCompany.success) {
            throw new BundlePublishError(
              `Company ${i} invalid: ${parsedCompany.error.issues[0]?.message ?? "unknown"}`,
            );
          }
          return parsedCompany.data;
        });
        const result = await publishCompaniesChunk(service, input.slug, input.stagingVersion, companies);
        return NextResponse.json(result);
      }
      case "finalize": {
        // Fan-out deliberately does NOT happen here anymore (CAR-62): the
        // driver runs the resolve loop next, and enqueueing subscribers
        // before the snapshot exists would race it — they'd apply through
        // the merge path with live entity resolution. The final resolve call
        // fans out; the daily cron self-heals a finalize that never resolved.
        const result = await finalizePublish(service, input.slug, input.stagingVersion);
        return NextResponse.json(result);
      }
      case "resolve": {
        const { data: bundleRow } = await service
          .from("data_bundles")
          .select("id, slug, version")
          .eq("slug", input.slug)
          .maybeSingle();
        if (!bundleRow) throw new BundlePublishError(`Bundle "${input.slug}" not found`, 404);
        const bundle = bundleRow as { id: number; slug: string; version: number };

        // Pin the version on the loop's first call and thread it back on every
        // subsequent call. markBundleResolved then guards on the version the
        // loop STARTED against — if a concurrent publish bumps the committed
        // version mid-loop, the .eq() misses, resolved_version stays behind,
        // and the cron re-resolves (rather than stamping over stale rows and
        // letting the fast path silently drop them). Reuses the same pinning
        // discipline the subscriber apply loop uses (bundleApplySchema).
        const pinnedVersion = input.pinnedVersion ?? bundle.version;
        const pinnedBundle = { id: bundle.id, slug: bundle.slug, version: pinnedVersion };

        const step = await resolveBundleChunk(service, pinnedBundle, { afterId: input.afterId ?? 0 });
        let fanout = 0;
        if (step.done) {
          await markBundleResolved(service, pinnedBundle);
          // Snapshot complete → NOW wake the stale subscribers; they'll all
          // ride the resolved ids (and blank ones the fast path).
          const stale = await findStaleSubscriptionIds(service, { bundleId: bundle.id });
          const workerUrl = new URL("/api/queue/bundle-sync", req.url).toString();
          fanout = await enqueueBundleSyncJobs(stale, workerUrl);
        }
        return NextResponse.json({ ...step, pinnedVersion, fanout });
      }
      case "abort": {
        await abortPublish(service, input.slug, input.stagingVersion);
        return NextResponse.json({ aborted: true });
      }
    }
  } catch (err) {
    if (err instanceof BundlePublishError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[bundles/publish] Unexpected failure:", err);
    return NextResponse.json({ error: "Publish failed" }, { status: 500 });
  }
}

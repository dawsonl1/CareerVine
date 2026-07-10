/**
 * Wrap a raw harvestapi profile item into a schema-v1 people-record so the
 * existing import machinery (mapper + merge) can consume it (plan 29).
 *
 * The wrapper carries NO pipeline provenance — a rescrape must not invent
 * found_by_searches / selection status / adjacency scores. computeContactPatch
 * in "rescrape" mode skips every pipeline-owned field anyway (B1), so the empty
 * pipeline block here is intentional and safe.
 *
 * Email provenance (M5): harvestapi's email search is SMTP-verified, so when a
 * run was executed in email mode and returned an address we set it as
 * 'verified' — one rung above the mapper's raw-emails fallback ('scraped').
 */

import type { PeopleRecord } from "@/lib/scrape-mapper";
import type { ApifyProfileItem } from "./client";

function firstEmail(emails: ApifyProfileItem["emails"]): string | null {
  if (!Array.isArray(emails)) return null;
  for (const e of emails) {
    const addr = typeof e === "string" ? e : e?.email;
    if (addr && addr.trim()) return addr.trim().toLowerCase();
  }
  return null;
}

export function actorItemToPeopleRecord(
  item: ApifyProfileItem,
  opts: { emailSearched: boolean },
): PeopleRecord {
  const name = `${item.firstName ?? ""} ${item.lastName ?? ""}`.trim();
  const url =
    item.linkedinUrl?.trim() ||
    (item.publicIdentifier ? `https://www.linkedin.com/in/${item.publicIdentifier.trim()}` : "");

  const email = opts.emailSearched ? firstEmail(item.emails) : null;

  return {
    schema_version: "1",
    identity: {
      name,
      linkedin_url: url,
      location: item.location?.linkedinText ?? null,
    },
    pipeline: {},
    crm: {
      email,
      email_source: email ? "verified" : null,
    },
    // The mapper reads employment/education/photo/location from raw_profiles[].data.
    raw_profiles: [{ source: "rescrape", data: item as Record<string, unknown> }],
    history: [],
  };
}

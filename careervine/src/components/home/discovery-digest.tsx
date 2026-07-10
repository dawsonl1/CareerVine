"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

/**
 * Home page discovery digest (plan 41 §5.2): one row per company —
 * "3 new PMs just joined Qualtrics" — linking to that company's page,
 * where the per-person Add/Dismiss card lives. Absent entirely when the
 * weekly search has nothing new.
 */

interface DigestRow {
  companyId: number;
  companyName: string;
  count: number;
}

export function DiscoveryDigest() {
  const [rows, setRows] = useState<DigestRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/discovery/candidates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.candidates) return;
        const byCompany = new Map<number, DigestRow>();
        for (const c of data.candidates as Array<{
          company_id: number;
          companies: { name: string } | null;
        }>) {
          const existing = byCompany.get(c.company_id);
          if (existing) existing.count += 1;
          else
            byCompany.set(c.company_id, {
              companyId: c.company_id,
              companyName: c.companies?.name ?? "a target company",
              count: 1,
            });
        }
        setRows([...byCompany.values()].sort((a, b) => b.count - a.count));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows.length === 0) return null;

  return (
    <div className="mt-10">
      <h3 className="text-lg font-medium text-foreground">Discovery</h3>
      <p className="text-sm text-muted-foreground mt-0.5 mb-4">
        New PMs at your target companies
      </p>
      <div className="rounded-xl border border-outline-variant/40 divide-y divide-outline-variant/30 overflow-hidden">
        {rows.map((r) => (
          <Link
            key={r.companyId}
            href={`/companies/${r.companyId}`}
            className="flex items-center justify-between gap-2 px-4 py-3 text-sm text-foreground hover:bg-surface-container-low transition-colors"
          >
            <span className="min-w-0 truncate">
              <span className="font-medium">
                {r.count} new PM{r.count === 1 ? "" : "s"}
              </span>{" "}
              just joined {r.companyName}
            </span>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { ExternalLink, UserPlus, X } from "lucide-react";
import { apiFetch, isApiRequestError } from "@/lib/api-client";
import { invalidateCompanyScopes } from "@/lib/company-detail-cache";

/**
 * Company page "New PM hires" card (plan 41 §5.1): candidates the weekly
 * discovery search found at this company, each one Add/Dismiss. Owns its
 * own fetch (keyed by companyId) so the page's prop threading stays
 * untouched; renders nothing when the company has no new candidates.
 */

interface DiscoveryCandidate {
  id: number;
  company_id: number;
  linkedin_url: string;
  name: string;
  headline: string | null;
  location: string | null;
  photo_url: string | null;
  position: string | null;
}

export function DiscoveryCard({ companyId }: { companyId: number }) {
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ candidates?: DiscoveryCandidate[] }>(
      `/api/discovery/candidates?company_id=${companyId}`,
    )
      .then((data) => {
        if (!cancelled && data?.candidates) setCandidates(data.candidates);
      })
      // error-tolerated: the whole card returns null when there are no
      // candidates, so it is additive suggestion surface on the company page
      // rather than data the user navigated here to read.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (candidates.length === 0) return null;

  const setBusy = (id: number, busy: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const removeRow = (id: number) => setCandidates((prev) => prev.filter((c) => c.id !== id));

  const act = async (candidate: DiscoveryCandidate, action: "add" | "dismiss") => {
    setBusy(candidate.id, true);
    const failureCopy = `Couldn't ${action === "add" ? "add" : "dismiss"} ${candidate.name}`;
    try {
      const data = await apiFetch<{ enrich?: string }>(
        `/api/discovery/candidates/${candidate.id}/${action}`,
        { method: "POST" },
      );
      removeRow(candidate.id);
      if (action === "add") {
        // The add creates a contact AT THIS COMPANY, so every cached
        // roster that could show them is now wrong (CAR-268).
        invalidateCompanyScopes();
        toastSuccess(
          data?.enrich === "started"
            ? `${candidate.name} added, enriching profile…`
            : `${candidate.name} added`,
        );
      } else {
        toastInfo(`${candidate.name} won't be suggested again`);
      }
    } catch (err) {
      // The status-specific branches move into catch, since apiFetch throws on
      // any non-2xx. ApiRequestError carries the status and the curated
      // message, which is what both branches were reading off the body.
      if (isApiRequestError(err) && (err.status === 409 || err.status === 404)) {
        // Already handled (or a previously deleted contact) — the row is stale
        // either way, so drop it and relay the server's explanation.
        removeRow(candidate.id);
        // `err.message` falls back to the generic "Something went wrong" when
        // the body is missing or unparseable (an edge 404 rather than the
        // route's own ApiError), which read as data loss next to a row that had
        // just vanished. Prefer the parsed body, then the old copy (CAR-204).
        toastInfo(err.body?.error ?? "Already handled");
      } else {
        toastError(isApiRequestError(err) ? err.message : failureCopy);
      }
    } finally {
      setBusy(candidate.id, false);
    }
  };

  return (
    <section className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-on-surface">New PM hires</h2>
        <span className="text-xs text-on-surface-variant tabular-nums">{candidates.length}</span>
      </div>
      <p className="text-xs text-on-surface-variant mt-0.5 mb-3">
        Recently joined, found by your weekly discovery search.
      </p>
      <div className="space-y-2">
        {candidates.map((c) => {
          const busy = busyIds.has(c.id);
          return (
            <div
              key={c.id}
              className="flex items-center gap-3 py-2.5 px-3 rounded-lg border border-outline-variant/30 bg-surface-container-lowest"
            >
              <ContactAvatar name={c.name} photoUrl={c.photo_url} className="w-10 h-10 text-sm shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-on-surface truncate">{c.name}</span>
                  <a
                    href={c.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-on-surface-variant hover:text-primary shrink-0"
                    title="Open LinkedIn profile"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
                <p className="text-xs text-on-surface-variant truncate mt-0.5">
                  {c.position ?? c.headline ?? ""}
                  {c.location && <> · {c.location}</>}
                </p>
              </div>
              <Tooltip label="Add as prospect">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(c, "add")}
                  className="p-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </Tooltip>
              <Tooltip label="Dismiss: won't be suggested again">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(c, "dismiss")}
                  className="p-1 rounded-lg text-on-surface-variant hover:text-error hover:bg-surface-container-high cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  <X className="w-4 h-4" />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </section>
  );
}

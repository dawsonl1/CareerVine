"use client";

/**
 * LinkedIn resolve picker (plan 29 §6.3): find the right profile for a
 * contact with no linkedin_url (manual adds) or a broken one (renamed
 * public identifier). Searches by name + current company on open, lets the
 * user confirm a candidate or paste a URL, then links + auto-enriches.
 */

import { useState, useEffect, useCallback } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { useToast } from "@/components/ui/toast";
import { ExternalLink, Search } from "lucide-react";

interface Candidate {
  linkedinUrl: string;
  name: string;
  headline: string | null;
  photo: string | null;
  location: string | null;
}

interface ResolveLinkedinModalProps {
  contactId: number;
  contactName: string;
  onClose: () => void;
  /** Called after a successful link so the parent refreshes the contact. */
  onLinked: () => void;
}

type Phase = "searching" | "results" | "cap_reached" | "disabled" | "error";

export function ResolveLinkedinModal({ contactId, contactName, onClose, onLinked }: ResolveLinkedinModalProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [phase, setPhase] = useState<Phase>("searching");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/contacts/${contactId}/resolve-linkedin`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setPhase("error");
        else if (data.status === "candidates") {
          setCandidates(data.candidates || []);
          if ((data.candidates || []).length === 1) setSelected(data.candidates[0].linkedinUrl);
          setPhase("results");
        } else setPhase(data.status === "cap_reached" ? "cap_reached" : "disabled");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const link = useCallback(
    async (url: string) => {
      if (linking) return;
      setLinking(true);
      try {
        const res = await fetch(`/api/contacts/${contactId}/link-linkedin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ linkedinUrl: url }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toastError(data.error || "Couldn't link that profile");
          return;
        }
        toastSuccess("LinkedIn profile linked — enriching from LinkedIn…");
        onLinked();
        onClose();
      } catch {
        toastError("Couldn't link that profile");
      } finally {
        setLinking(false);
      }
    },
    [contactId, linking, onClose, onLinked, toastError, toastSuccess],
  );

  return (
    <Modal isOpen onClose={onClose} title={`Link LinkedIn profile — ${contactName}`} size="md">
      <div className="space-y-4">
        {phase === "searching" && (
          <div className="flex items-center gap-3 py-8 justify-center text-muted-foreground">
            <Search className="h-5 w-5 animate-pulse" />
            <span>Searching LinkedIn for “{contactName}”…</span>
          </div>
        )}

        {phase === "cap_reached" && (
          <p className="text-sm text-muted-foreground py-4">
            Monthly scrape budget reached — searching is paused until next month. You can still paste a profile URL below.
          </p>
        )}
        {phase === "disabled" && (
          <p className="text-sm text-muted-foreground py-4">
            LinkedIn scraping isn’t configured. You can still paste a profile URL below.
          </p>
        )}
        {phase === "error" && (
          <p className="text-sm text-muted-foreground py-4">
            The search didn’t go through. You can retry later or paste a profile URL below.
          </p>
        )}

        {phase === "results" && candidates.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No matching profiles found. If you know their profile, paste the URL below.
          </p>
        )}

        {phase === "results" && candidates.length > 0 && (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {candidates.map((c) => (
              <button
                key={c.linkedinUrl}
                onClick={() => setSelected(c.linkedinUrl)}
                className={`w-full flex items-center gap-3 p-3 rounded-[12px] text-left transition-colors cursor-pointer ${
                  selected === c.linkedinUrl
                    ? "bg-primary-container/40 ring-1 ring-primary"
                    : "hover:bg-surface-container"
                }`}
              >
                <ContactAvatar name={c.name} photoUrl={c.photo} className="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground truncate">{c.name}</div>
                  {c.headline && <div className="text-sm text-muted-foreground truncate">{c.headline}</div>}
                  {c.location && <div className="text-xs text-muted-foreground truncate">{c.location}</div>}
                </div>
                <a
                  href={c.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="p-1.5 text-muted-foreground hover:text-primary"
                  title="Open profile in a new tab to verify"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </button>
            ))}
          </div>
        )}

        {/* Manual paste fallback — always available */}
        <div className="flex gap-2 pt-2 border-t border-outline-variant">
          <input
            type="url"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="…or paste a LinkedIn profile URL"
            className="flex-1 rounded-[8px] border border-outline-variant px-3 py-2 text-sm bg-transparent"
          />
          <Button
            variant="outline"
            disabled={!manualUrl.trim() || linking}
            onClick={() => link(manualUrl.trim())}
          >
            Link
          </Button>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button disabled={!selected || linking} onClick={() => selected && link(selected)}>
            {linking ? "Linking…" : "Confirm & enrich"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

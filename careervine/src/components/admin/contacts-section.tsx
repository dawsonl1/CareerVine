"use client";

/**
 * Admin user-detail: contacts card — inject (manual or from a bundle) and
 * remove contacts on the target account's behalf.
 *
 * Destructive-action policy: removing a contact uses the plan-08 deferred
 * delete + undo-countdown toast (reversible window); bundle injection uses a
 * confirm modal stating the prospect count (bulk, not trivially reversible).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, Plus, Database, Trash2, Users as UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import type { BundleAccessItem } from "@/lib/admin-bundles";
import { apiFetch, apiSend, jsonBody } from "@/lib/api-client";

interface AdminContact {
  id: number;
  name: string;
  linkedinUrl: string | null;
  networkStatus: string;
  createdAt: string;
  email: string | null;
  title: string | null;
  company: string | null;
}

const UNDO_MS = 5000;

type OpenModal = null | "add" | "bundle";
type StatusFilter = "all" | "active" | "prospect" | "bench";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "prospect", label: "Prospects" },
  { value: "bench", label: "Bench" },
];

export default function ContactsSection({ userId }: { userId: string }) {
  const { toast, dismiss, success, error: toastError } = useToast();

  const [contacts, setContacts] = useState<AdminContact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [open, setOpen] = useState<OpenModal>(null);
  const [busy, setBusy] = useState(false);

  // Add-contact form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");

  // Bundle picker
  const [bundles, setBundles] = useState<BundleAccessItem[] | null>(null);
  const [pickedBundle, setPickedBundle] = useState<BundleAccessItem | null>(null);

  // Deferred deletes: contactId → { timeout, fire, toastId } so unmount can
  // flush the delete AND retract the Undo it can no longer honour.
  const pendingDeletes = useRef(
    new Map<
      number,
      { timeout: ReturnType<typeof setTimeout>; fire: () => void; toastId: string }
    >(),
  );

  // Re-entry guard for the two modal submits below, both of which POST to
  // non-idempotent routes.
  //
  // It is the house convention (CONVENTIONS.md section f, enforced by check (i)
  // of scripts/check-conventions.mjs), NOT a fix for an observed incident here.
  // An earlier draft of this comment claimed a double click created two contact
  // rows; that does not reproduce. `Button` renders
  // `disabled={disabled || loading}` and both call sites pass `loading={busy}`,
  // React flushes a discrete click update before the browser dispatches the
  // next click, and a disabled control has its queued clicks discarded — so
  // click two never reaches the handler. Two POSTs need two dispatches in ONE
  // task, which the browser input pipeline does not produce (`fireEvent.click`
  // twice does, which is why that is not a model of a double click).
  //
  // The ref is still worth its two lines: it is what makes the guarantee local
  // instead of depending on a prop three files away, and it survives a refactor
  // that drops `loading={busy}` or adds a keyboard path.
  const submittingRef = useRef(false);

  /** Mirrors `open` so a late-resolving submit can see the CURRENT modal. */
  const openRef = useRef<OpenModal>(null);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  /** `dismiss` behind a ref, so the []-dep unmount effect below cannot go stale. */
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);

  const load = useCallback(
    async (offset = 0) => {
      if (offset > 0) setLoadingMore(true);
      try {
        const search = new URLSearchParams();
        if (q.trim()) search.set("q", q.trim());
        if (status !== "all") search.set("status", status);
        if (offset > 0) search.set("offset", String(offset));
        const qs = search.toString();
        const body = await apiFetch<{ contacts: AdminContact[]; total: number }>(
          `/api/admin/users/${userId}/contacts${qs ? `?${qs}` : ""}`,
        );
        setContacts((prev) =>
          offset > 0 ? [...(prev ?? []), ...body.contacts] : body.contacts,
        );
        setTotal(body.total);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [userId, q, status],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  // Flush (not cancel) any still-pending deletes if the admin navigates away —
  // the toast promised a removal; unmount must not silently undo it.
  //
  // The toast is retracted in the same breath. It promised an UNDO too, and
  // ToastProvider lives in the root layout, so it outlives this component and
  // kept rendering an Undo button after the flush had already issued the
  // DELETE. Clicking it found no pending entry, skipped the cancel branch, and
  // dismissed itself — visually identical to a successful undo, with the row
  // permanently gone.
  useEffect(() => {
    const pending = pendingDeletes.current;
    return () => {
      for (const { timeout, fire, toastId } of pending.values()) {
        clearTimeout(timeout);
        dismissRef.current(toastId);
        fire();
      }
      pending.clear();
    };
  }, []);

  /**
   * Dismiss the modal `mode` opened, and only that one.
   *
   * A submit stays in flight after its own modal is dismissed (scrim click,
   * Escape, the header X - none of which cancel the request), and `close()` runs
   * on the success path, so an unconditional teardown reached across into
   * whatever modal happened to be open by then. The inject route makes that a
   * wide window rather than a race: it runs under a 35s budget and returns
   * `completed: false` when it cannot finish. Escape out of a 250-prospect
   * inject, open Add contact, type a name, email and LinkedIn URL, and 30
   * seconds later the bundle response wiped all three fields and closed the
   * dialog under the admin.
   */
  const close = (mode?: OpenModal) => {
    // Read through the ref, not the closed-over `open`: this runs after an
    // await, so the captured value is whatever was open when the request
    // STARTED, which is precisely the thing that must not be trusted here.
    if (mode !== undefined && openRef.current !== mode) return;
    setOpen(null);
    setName("");
    setEmail("");
    setLinkedinUrl("");
    setPickedBundle(null);
  };

  const addContact = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    try {
      await apiSend(`/api/admin/users/${userId}/contacts`, jsonBody({
        mode: "manual",
        name: name.trim(),
        email: email.trim() || undefined,
        linkedin_url: linkedinUrl.trim() || undefined,
      }));
      success(`Added ${name.trim()} to this account`);
      close("add");
      void load();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  const openBundlePicker = async () => {
    setOpen("bundle");
    if (bundles) return;
    try {
      const json = await apiFetch<{ bundles?: BundleAccessItem[] }>(
        `/api/admin/users/${userId}/bundle-access`,
      );
      setBundles(json.bundles ?? []);
    } catch (err) {
      toastError((err as Error).message);
      // Same stale-commit hazard as `close()`: this failure can land after the
      // admin has escaped the picker and opened Add contact, and an
      // unconditional `setOpen(null)` would shut that dialog under an unrelated
      // error toast.
      setOpen((current) => (current === "bundle" ? null : current));
    }
  };

  const injectBundle = async () => {
    if (!pickedBundle) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    try {
      const json = await apiFetch<{ applied?: number; completed?: boolean }>(
        `/api/admin/users/${userId}/contacts`,
        jsonBody({ mode: "bundle", bundleId: pickedBundle.bundleId }),
      );
      success(
        json.completed
          ? `Injected “${pickedBundle.name}”: ${json.applied ?? 0} contacts applied`
          : `Injecting “${pickedBundle.name}”: ${json.applied ?? 0} applied so far, the rest will finish in the background`,
      );
      close("bundle");
      void load();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  /** Plan-08 pattern: hide now, delete after the undo window closes. */
  const removeContact = (contact: AdminContact) => {
    setContacts((prev) => (prev ?? []).filter((c) => c.id !== contact.id));
    setTotal((t) => Math.max(0, t - 1));

    const fire = async () => {
      pendingDeletes.current.delete(contact.id);
      try {
        await apiSend(
          `/api/admin/users/${userId}/contacts/${contact.id}`,
          { method: "DELETE" },
        );
      } catch (err) {
        toastError(`Couldn't remove ${contact.name}: ${(err as Error).message}`);
        void load();
      }
    };

    const timeout = setTimeout(() => void fire(), UNDO_MS);

    const toastId = toast(`Removed ${contact.name}`, {
      variant: "info",
      duration: UNDO_MS,
      showProgress: true,
      actions: [
        {
          label: "Undo",
          onClick: () => {
            const pending = pendingDeletes.current.get(contact.id);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingDeletes.current.delete(contact.id);
            }
            dismiss(toastId);
            void load();
          },
        },
      ],
    });

    pendingDeletes.current.set(contact.id, {
      timeout,
      fire: () => void fire(),
      toastId,
    });
  };

  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-medium text-on-surface">Contacts</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Add or remove contacts in this account. Injecting a bundle adds its
            contacts now (and grants the bundle).
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="tonal" size="sm" onClick={() => setOpen("add")}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add contact
          </Button>
          <Button variant="outline" size="sm" onClick={() => void openBundlePicker()}>
            <Database className="mr-1.5 h-4 w-4" />
            Inject bundle
          </Button>
        </div>
      </div>

      <div className="relative mt-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or company…"
          className="w-full rounded-full border border-outline-variant bg-surface py-2 pl-10 pr-4 text-sm text-on-surface placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
      </div>

      <div className="mt-3 mb-3 flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
              status === f.value
                ? "border-primary bg-primary-container text-on-primary-container"
                : "border-outline-variant text-muted-foreground hover:bg-surface-container"
            }`}
          >
            {f.label}
          </button>
        ))}
        {!loading && !error && contacts && (
          <span className="ml-auto text-xs text-muted-foreground">
            Showing {contacts.length} of {total}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading contacts…</span>
        </div>
      )}

      {!loading && error && (
        <p className="py-6 text-center text-sm text-on-error-container">{error}</p>
      )}

      {!loading && !error && contacts && contacts.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
          <UsersIcon className="h-7 w-7 opacity-50" />
          <p className="text-sm">
            {q.trim() || status !== "all"
              ? "No contacts match the current search/filter."
              : "This account has no contacts yet."}
          </p>
        </div>
      )}

      {!loading && !error && contacts && contacts.length > 0 && (
        <ul className="flex flex-col divide-y divide-outline-variant">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-on-surface">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    c.title && c.company
                      ? `${c.title} @ ${c.company}`
                      : c.company ?? c.title,
                    c.email ?? c.linkedinUrl,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                  {c.networkStatus !== "active" && ` · ${c.networkStatus}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => removeContact(c)}
                className="state-layer flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-error cursor-pointer"
                title={`Remove ${c.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && !error && contacts && contacts.length < total && (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            loading={loadingMore}
            onClick={() => void load(contacts.length)}
          >
            Load more ({total - contacts.length} remaining)
          </Button>
        </div>
      )}

      {/* Add-contact modal */}
      <Modal isOpen={open === "add"} onClose={() => close()} title="Add contact" size="md">
        <div className="space-y-4">
          <div>
            <label className={labelClasses}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClasses}
              placeholder="Full name"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClasses}>Email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClasses}
              />
            </div>
            <div>
              <label className={labelClasses}>LinkedIn URL (optional)</label>
              <input
                type="url"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                className={inputClasses}
                placeholder="https://linkedin.com/in/…"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="text" onClick={() => close()}>
              Cancel
            </Button>
            <Button onClick={addContact} loading={busy} disabled={!name.trim()}>
              Add contact
            </Button>
          </div>
        </div>
      </Modal>

      {/* Bundle-inject modal */}
      <Modal isOpen={open === "bundle"} onClose={() => close()} title="Inject a bundle" size="md">
        {!bundles ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading bundles…</span>
          </div>
        ) : bundles.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No published bundles to inject.
          </p>
        ) : !pickedBundle ? (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {bundles.map((b) => (
              <li key={b.bundleId}>
                <button
                  type="button"
                  onClick={() => setPickedBundle(b)}
                  disabled={b.subscribed}
                  className={`w-full rounded-xl border border-outline-variant p-3 text-left transition-colors ${
                    b.subscribed
                      ? "opacity-50 cursor-not-allowed"
                      : "hover:bg-surface-container cursor-pointer"
                  }`}
                >
                  <span className="block text-sm font-medium text-on-surface">
                    {b.name}
                    {b.subscribed && " (already subscribed)"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {b.prospectCount} prospects
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Inject{" "}
              <span className="font-medium text-on-surface">{pickedBundle.name}</span>{" "}
              into this account? Up to{" "}
              <span className="font-medium text-on-surface">
                {pickedBundle.prospectCount} contacts
              </span>{" "}
              will be added as prospects, and the bundle will be granted to this
              account.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="text" onClick={() => setPickedBundle(null)}>
                Back
              </Button>
              <Button onClick={injectBundle} loading={busy}>
                Inject {pickedBundle.prospectCount} contacts
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

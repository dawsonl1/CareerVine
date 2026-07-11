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

interface AdminContact {
  id: number;
  name: string;
  linkedinUrl: string | null;
  networkStatus: string;
  createdAt: string;
  email: string | null;
}

const UNDO_MS = 5000;

type OpenModal = null | "add" | "bundle";

export default function ContactsSection({ userId }: { userId: string }) {
  const { toast, dismiss, success, error: toastError } = useToast();

  const [contacts, setContacts] = useState<AdminContact[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<OpenModal>(null);
  const [busy, setBusy] = useState(false);

  // Add-contact form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");

  // Bundle picker
  const [bundles, setBundles] = useState<BundleAccessItem[] | null>(null);
  const [pickedBundle, setPickedBundle] = useState<BundleAccessItem | null>(null);

  // Deferred deletes: contactId → { timeout, fire } so unmount can flush them
  const pendingDeletes = useRef(
    new Map<number, { timeout: ReturnType<typeof setTimeout>; fire: () => void }>(),
  );

  const load = useCallback(async () => {
    try {
      const url = q.trim()
        ? `/api/admin/users/${userId}/contacts?q=${encodeURIComponent(q.trim())}`
        : `/api/admin/users/${userId}/contacts`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const body = (await res.json()) as { contacts: AdminContact[] };
      setContacts(body.contacts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId, q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  // Flush (not cancel) any still-pending deletes if the admin navigates away —
  // the toast promised a removal; unmount must not silently undo it.
  useEffect(() => {
    const pending = pendingDeletes.current;
    return () => {
      for (const { timeout, fire } of pending.values()) {
        clearTimeout(timeout);
        fire();
      }
      pending.clear();
    };
  }, []);

  const close = () => {
    setOpen(null);
    setName("");
    setEmail("");
    setLinkedinUrl("");
    setPickedBundle(null);
  };

  const addContact = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/contacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "manual",
          name: name.trim(),
          email: email.trim() || undefined,
          linkedin_url: linkedinUrl.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(`Added ${name.trim()} to this account`);
      close();
      void load();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openBundlePicker = async () => {
    setOpen("bundle");
    if (bundles) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}/bundle-access`);
      const json = (await res.json().catch(() => ({}))) as {
        bundles?: BundleAccessItem[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setBundles(json.bundles ?? []);
    } catch (err) {
      toastError((err as Error).message);
      setOpen(null);
    }
  };

  const injectBundle = async () => {
    if (!pickedBundle) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/contacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "bundle", bundleId: pickedBundle.bundleId }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        applied?: number;
        completed?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      success(
        json.completed
          ? `Injected “${pickedBundle.name}”: ${json.applied ?? 0} contacts applied`
          : `Injecting “${pickedBundle.name}”: ${json.applied ?? 0} applied so far, the rest will finish in the background`,
      );
      close();
      void load();
    } catch (err) {
      toastError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Plan-08 pattern: hide now, delete after the undo window closes. */
  const removeContact = (contact: AdminContact) => {
    setContacts((prev) => (prev ?? []).filter((c) => c.id !== contact.id));

    const fire = async () => {
      pendingDeletes.current.delete(contact.id);
      try {
        const res = await fetch(
          `/api/admin/users/${userId}/contacts/${contact.id}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
      } catch (err) {
        toastError(`Couldn't remove ${contact.name}: ${(err as Error).message}`);
        void load();
      }
    };

    const timeout = setTimeout(() => void fire(), UNDO_MS);
    pendingDeletes.current.set(contact.id, { timeout, fire: () => void fire() });

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

      <div className="relative mt-4 mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search their contacts…"
          className="w-full rounded-full border border-outline-variant bg-surface py-2 pl-10 pr-4 text-sm text-on-surface placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
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
            {q.trim() ? `No contacts match “${q.trim()}”.` : "This account has no contacts yet."}
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
                  {c.email ?? c.linkedinUrl ?? "—"}
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

      {/* Add-contact modal */}
      <Modal isOpen={open === "add"} onClose={close} title="Add contact" size="md">
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
            <Button variant="text" onClick={close}>
              Cancel
            </Button>
            <Button onClick={addContact} loading={busy} disabled={!name.trim()}>
              Add contact
            </Button>
          </div>
        </div>
      </Modal>

      {/* Bundle-inject modal */}
      <Modal isOpen={open === "bundle"} onClose={close} title="Inject a bundle" size="md">
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

"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { getContacts } from "@/lib/queries";

export type SimpleContactWithEmail = {
  id: number;
  name: string;
  email?: string;
  emails?: string[];
  photo_url?: string | null;
  industry?: string;
};

/**
 * Hook for loading contacts with their email addresses.
 * Returns a simplified contact list and a map of contactId → email addresses.
 * Pass `enabled: false` to defer fetching until needed (e.g., when a modal opens).
 */
export function useContactsWithEmails({ enabled = true }: { enabled?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id;
  const [contacts, setContacts] = useState<SimpleContactWithEmail[]>([]);
  const [emailsMap, setEmailsMap] = useState<Record<number, string[]>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const data = await getContacts(userId);
      const map: Record<number, string[]> = {};
      const list = (data as any[]).map((c: any) => {
        const emails = (c.contact_emails || [])
          .map((e: any) => e.email)
          .filter(Boolean) as string[];
        if (emails.length > 0) map[c.id] = emails;
        return {
          id: c.id,
          name: c.name,
          email: emails[0] || undefined,
          emails,
          photo_url: c.photo_url,
          industry: c.industry || undefined,
        };
      });
      setContacts(list);
      setEmailsMap(map);
    } catch (e) {
      console.error("Error loading contacts:", e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (enabled) load();
  }, [load, enabled]);

  return { contacts, emailsMap, loading, refresh: load };
}

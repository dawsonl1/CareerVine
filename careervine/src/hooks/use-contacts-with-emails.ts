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
 * Shared hook for loading contacts with their email addresses.
 * Returns a simplified contact list and a map of contactId → email addresses.
 * All consumers share the same fetch — deduped by the user ID.
 */
export function useContactsWithEmails() {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<SimpleContactWithEmail[]>([]);
  const [emailsMap, setEmailsMap] = useState<Record<number, string[]>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await getContacts(user.id);
      const map: Record<number, string[]> = {};
      const list = (data as any[]).map((c) => {
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
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return { contacts, emailsMap, loading, refresh: load };
}

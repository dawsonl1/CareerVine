/**
 * Contact network-status vocabulary (CAR-155).
 *
 * Mirrors the DB CHECK constraint on contacts.network_status
 * (supabase/migrations/20260707000000_company_pages_and_scrape_import.sql):
 * 'active' | 'prospect' | 'bench', NOT NULL, default 'active'.
 *
 * The relationship rules in this directory enforce active-only semantics
 * internally via isActiveContact, so a fetch call site that forgets the
 * SQL-level network_status filter cannot widen a rule's population.
 */

export const NETWORK_STATUSES = ["active", "prospect", "bench"] as const;

export type NetworkStatus = (typeof NETWORK_STATUSES)[number];

export const ACTIVE_NETWORK_STATUS: NetworkStatus = "active";

/** True when the contact is part of the real (active) network. */
export function isActiveContact(contact: { network_status: string }): boolean {
  return contact.network_status === ACTIVE_NETWORK_STATUS;
}

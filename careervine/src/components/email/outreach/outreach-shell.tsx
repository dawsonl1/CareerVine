"use client";

/**
 * Free-tier "Outreach" shell — PLACEHOLDER (CAR-103).
 *
 * CAR-102 replaces this with the real Outreach portal (sent + scheduled +
 * follow-up status, an "awaiting reply" view, reminders) built on the DB-only
 * /api/gmail/inbox data. In Phase 0 this never renders in production, because
 * every existing connection has inbox:premium; it exists so the capability
 * branch and dynamic loading are wired and testable end-to-end now.
 */
export function OutreachShell() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-lg font-semibold text-gray-900">Outreach</h1>
      <p className="max-w-sm text-sm text-gray-500">Your outreach hub is coming soon.</p>
    </div>
  );
}

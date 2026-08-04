import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  verifyUnsubscribeToken,
  NOTIFICATION_PREFERENCE_COLUMN,
  type NotificationPurpose,
} from "@/lib/notify/tokens";

/**
 * GET / POST /api/notifications/unsubscribe?token=... — one-click opt-out of a
 * notification kind (CAR-105; second purpose added by CAR-217). UNAUTHENTICATED
 * by design (RFC 8058 List-Unsubscribe): the HMAC token identifies the user, so
 * no session is needed.
 *
 * The token carries WHICH kind, so one unsubscribe never silences the other:
 * turning off follow-up reminders must not also turn off the alert that says an
 * address stopped accepting mail, which is operational rather than a reminder.
 *
 * Only POST mutates (sets that purpose's column false) — serving BOTH the
 * mail-client one-click (List-Unsubscribe-Post) AND the confirmation-page form.
 * GET NEVER mutates: it only renders a confirmation page whose button POSTs. This
 * matters because email security scanners (Microsoft Safe Links, Proofpoint, etc.)
 * GET-prefetch in-body links on delivery, which would silently unsubscribe users
 * if GET performed the write (CAR-105 review).
 */

/** Per-purpose copy. Keyed by the token's purpose so the page a user lands on
 *  names the thing they actually clicked unsubscribe on. */
const COPY: Record<NotificationPurpose, { question: string; confirm: string; done: string; heading: string }> = {
  followup_nudges: {
    heading: "Unsubscribe from reminders?",
    question:
      "Confirm to stop receiving emails about follow-ups awaiting your review. You can turn them back on any time in your CareerVine settings.",
    confirm: "You're unsubscribed",
    done: "You will no longer receive reminder emails about follow-ups awaiting your review. You can turn these back on any time in your CareerVine settings.",
  },
  bounce_alerts: {
    heading: "Turn off bounce alerts?",
    question:
      "Confirm to stop receiving emails when a contact address stops accepting mail. CareerVine will still cancel anything queued to a bounced address and flag it on the contact, you just will not be emailed about it.",
    confirm: "Bounce alerts are off",
    done: "You will no longer be emailed when a contact address bounces. CareerVine still cancels anything queued to it and flags the address on the contact. You can turn these emails back on any time in your CareerVine settings.",
  },
};

async function applyUnsubscribe(token: string | null): Promise<boolean> {
  if (!token) return false;
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return false;
  const service = createSupabaseServiceClient();
  const { error } = await service
    .from("users")
    .update({ [NOTIFICATION_PREFERENCE_COLUMN[parsed.purpose]]: false })
    .eq("id", parsed.userId);
  return !error;
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const ok = await applyUnsubscribe(token);
  // Re-read the purpose for the copy. A token that failed to APPLY may still be
  // well-formed (a DB error), but the page it gets is the failure page either
  // way, so an unparseable token simply falls back to the generic wording.
  const purpose = ok && token ? (verifyUnsubscribeToken(token)?.purpose ?? null) : null;
  // HTML result serves the confirmation-page form submit; the mail-client
  // one-click POST ignores the body and just needs the 2xx.
  return new NextResponse(resultPage(ok, url.origin, purpose), {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = url.origin;
  const token = url.searchParams.get("token");
  // Verify only — no write. A valid token gets a confirm-to-unsubscribe page; an
  // invalid/absent one gets the expired-link page. Nothing changes until POST.
  const parsed = token ? verifyUnsubscribeToken(token) : null;
  return new NextResponse(
    parsed ? confirmPage(token as string, origin, parsed.purpose) : resultPage(false, origin, null),
    {
      status: parsed ? 200 : 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

const STYLES = `
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background:#f6f7f9; color:#1a1a1a; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#0f1115; color:#e8e8e8; } .card { background:#171a21 !important; } }
  .card { background:#fff; max-width:440px; width:100%; border-radius:16px; padding:32px;
    box-shadow:0 1px 3px rgba(0,0,0,.08); text-align:center; }
  h1 { font-size:20px; margin:0 0 12px; }
  p { font-size:15px; line-height:1.6; margin:0 0 20px; opacity:.85; }
  .btn { display:inline-block; background:#2f6f4f; color:#fff; text-decoration:none; border:0;
    padding:10px 20px; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; }
  .muted { display:inline-block; margin-top:14px; font-size:13px; color:#8a8f98; text-decoration:underline; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title} · CareerVine</title>
<style>${STYLES}</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

function confirmPage(token: string, origin: string, purpose: NotificationPurpose): string {
  const action = `${origin}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
  const copy = COPY[purpose];
  return shell(
    copy.heading,
    `<h1>${copy.heading}</h1>
    <p>${copy.question}</p>
    <form method="POST" action="${action}">
      <button class="btn" type="submit">Confirm</button>
    </form>
    <a class="muted" href="${origin}/settings">Cancel</a>`,
  );
}

function resultPage(ok: boolean, origin: string, purpose: NotificationPurpose | null): string {
  // A successful unsubscribe always knows its purpose (the token parsed); the
  // failure page never does, so it stays deliberately generic.
  const copy = purpose ? COPY[purpose] : null;
  const title = ok ? (copy?.confirm ?? "You're unsubscribed") : "Link expired";
  const body = ok
    ? (copy?.done ??
      "You will no longer receive these emails. You can turn them back on any time in your CareerVine settings.")
    : "This unsubscribe link is invalid or has expired. You can manage email notifications directly in your CareerVine settings.";
  return shell(
    title,
    `<h1>${title}</h1>
    <p>${body}</p>
    <a class="btn" href="${origin}/settings">Open settings</a>`,
  );
}

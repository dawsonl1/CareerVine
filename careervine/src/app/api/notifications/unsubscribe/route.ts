import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { verifyUnsubscribeToken } from "@/lib/notify/tokens";

/**
 * GET / POST /api/notifications/unsubscribe?token=... — one-click opt-out of the
 * follow-up reminder emails (CAR-105). UNAUTHENTICATED by design (RFC 8058
 * List-Unsubscribe): the HMAC token identifies the user, so no session is needed.
 * POST is the mail-client one-click (List-Unsubscribe-Post); GET is a human
 * clicking the footer link, which shows a small confirmation page.
 */

async function applyUnsubscribe(token: string | null): Promise<boolean> {
  if (!token) return false;
  const parsed = verifyUnsubscribeToken(token);
  if (!parsed) return false;
  const service = createSupabaseServiceClient();
  const { error } = await service
    .from("users")
    .update({ followup_nudges_enabled: false })
    .eq("id", parsed.userId);
  return !error;
}

export async function POST(req: NextRequest) {
  const ok = await applyUnsubscribe(new URL(req.url).searchParams.get("token"));
  return NextResponse.json({ ok }, { status: ok ? 200 : 400 });
}

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const ok = await applyUnsubscribe(new URL(req.url).searchParams.get("token"));
  return new NextResponse(page(ok, origin), {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function page(ok: boolean, origin: string): string {
  const title = ok ? "You're unsubscribed" : "Link expired";
  const body = ok
    ? "You will no longer receive reminder emails about follow-ups awaiting your review. You can turn these back on any time in your CareerVine settings."
    : "This unsubscribe link is invalid or has expired. You can manage email reminders directly in your CareerVine settings.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · CareerVine</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background:#f6f7f9; color:#1a1a1a; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#0f1115; color:#e8e8e8; } .card { background:#171a21 !important; } }
  .card { background:#fff; max-width:440px; width:100%; border-radius:16px; padding:32px;
    box-shadow:0 1px 3px rgba(0,0,0,.08); text-align:center; }
  h1 { font-size:20px; margin:0 0 12px; }
  p { font-size:15px; line-height:1.6; margin:0 0 20px; opacity:.85; }
  a.btn { display:inline-block; background:#2f6f4f; color:#fff; text-decoration:none;
    padding:10px 20px; border-radius:10px; font-size:14px; font-weight:600; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
    <a class="btn" href="${origin}/settings">Open settings</a>
  </div>
</body>
</html>`;
}

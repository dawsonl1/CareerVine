/**
 * Mailpit reader for the E2E tier (CAR-189).
 *
 * The signup flow follows the REAL confirmation link rather than a
 * hand-generated token, because the link's construction is app-owned: the
 * template patched in by `scripts/configure-auth-emails.mjs` points at
 * `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup`, and
 * `signUp()` passes its own `emailRedirectTo`. Generating the token ourselves
 * would skip exactly the part most likely to break.
 *
 * Waiting is `expect.poll`, never a sleep — mail delivery is fast but not
 * instant, and a fixed wait is both slower and flakier than a retried read.
 */
import { expect } from "@playwright/test";
import { stackEnv } from "./stack-env";

interface MailpitSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/**
 * Mailpit and its predecessor Inbucket expose different APIs, and which one the
 * pinned Supabase CLI ships has changed before. Probe rather than assume, and
 * say so clearly when neither answers.
 */
async function listMessages(): Promise<MailpitSummary[]> {
  const base = stackEnv().mailpitUrl;
  const res = await fetch(`${base}/api/v1/messages?limit=200`);
  if (!res.ok) {
    throw new Error(
      `Mailpit responded ${res.status} at ${base}. Is it running? The local stack must be ` +
        `started WITHOUT excluding mailpit — see CONVENTIONS.md section i.`,
    );
  }
  const body = (await res.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

async function messageBody(id: string): Promise<string> {
  const base = stackEnv().mailpitUrl;
  const res = await fetch(`${base}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit message ${id} responded ${res.status}`);
  const body = (await res.json()) as { HTML?: string; Text?: string };
  return `${body.HTML ?? ""}\n${body.Text ?? ""}`;
}

/**
 * The confirmation URL from the newest message addressed to `recipient`.
 *
 * Returns a path, not an absolute URL: the template renders `{{ .SiteURL }}`,
 * which is `http://127.0.0.1:3000` per supabase/config.toml, while the E2E app
 * runs on its own port. Navigating the path against Playwright's `baseURL` is
 * both correct and immune to that mismatch.
 */
export async function waitForConfirmationPath(recipient: string): Promise<string> {
  let found: string | undefined;

  await expect
    .poll(
      async () => {
        const messages = await listMessages();
        const mine = messages.filter((m) =>
          m.To?.some((t) => t.Address.toLowerCase() === recipient.toLowerCase()),
        );
        if (mine.length === 0) return null;

        const raw = await messageBody(mine[0].ID);
        // The template links to /auth/confirm?token_hash=...&type=signup. Match
        // the query rather than the host, which differs from the app's port.
        const match = raw.match(/\/auth\/confirm\?[^"'\s<>]+/);
        if (!match) return null;
        found = match[0].replace(/&amp;/g, "&");
        return found;
      },
      {
        message: `No confirmation email with an /auth/confirm link arrived for ${recipient}`,
        timeout: 20_000,
        intervals: [250, 500, 1000],
      },
    )
    .not.toBeNull();

  if (!found) throw new Error(`unreachable: poll resolved without a link for ${recipient}`);
  return found;
}

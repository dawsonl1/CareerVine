#!/usr/bin/env node
/**
 * Mark a production deploy as a PostHog annotation (CAR-38) so every chart
 * shows what shipped when — the backbone of before/after change evaluation.
 *
 * Runs in the Vercel build (postbuild). Silent no-op unless BOTH
 * POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are set and this is a
 * production deployment. Never fails the build.
 */

const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
const projectId = process.env.POSTHOG_PROJECT_ID;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const isProd = process.env.VERCEL_ENV === "production";

if (!apiKey || !projectId || !isProd) process.exit(0);

const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown").slice(0, 7);
const message = process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0] ?? "";

// The API lives on the us.posthog.com app host, not the i-ingestion host.
const apiHost = host.replace("us.i.posthog.com", "us.posthog.com");

try {
  const res = await fetch(`${apiHost}/api/projects/${projectId}/annotations/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      content: `deploy ${sha}${message ? ` — ${message}` : ""}`,
      date_marker: new Date().toISOString(),
      scope: "project",
    }),
  });
  console.log(
    res.ok
      ? `[posthog-annotate] marked deploy ${sha}`
      : `[posthog-annotate] skipped (HTTP ${res.status})`,
  );
} catch (err) {
  console.log(`[posthog-annotate] skipped (${err?.message ?? err})`);
}
process.exit(0);

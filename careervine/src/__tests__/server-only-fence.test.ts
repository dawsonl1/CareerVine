/**
 * CAR-158 (F39): the server-only fence stays intact.
 *
 * Secret-bearing lib modules carry `import "server-only"` so that a client
 * component importing one fails `next build` rather than shipping a credential
 * read into the browser bundle. That guarantee is only worth as much as its
 * weakest link: delete one import and the build stays green until the day
 * someone imports the module from a client component.
 *
 * `next build` proves the fence works (verified during CAR-158: a deliberate
 * 'use client' import of gmail.ts failed the build with the full chain
 * page.tsx -> gmail.ts -> analytics/server.ts), but CI cannot run that probe
 * on every PR. This test is the cheap standing guard instead.
 *
 * Two directions, both required:
 *  1. Every module on FENCED carries the import (nobody quietly removes one).
 *  2. Every module NOT on FENCED that reads a secret from process.env is
 *     either fenced or explicitly excused — so a NEW secret-bearing module
 *     cannot be added without a deliberate decision about its boundary.
 *
 * Pure string scan over source text: fast, and it never evaluates a module
 * (evaluating them is exactly what server-only forbids outside the RSC layer).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fg from "fast-glob";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const libDir = path.join(srcDir, "lib");

/** Modules that must carry `import "server-only"`. */
const FENCED = [
  "lib/r2.ts",
  "lib/gmail.ts",
  "lib/gmail-send-core.ts",
  "lib/openai.ts",
  "lib/deepgram.ts",
  "lib/email-send.ts",
  "lib/crypto.ts",
  "lib/apify/client.ts",
  "lib/supabase/service-client.ts",
  "lib/supabase/server-client.ts",
  "lib/analytics/server.ts",
  "lib/oauth-helpers.ts",
  "lib/notify/email.ts",
  "lib/notify/tokens.ts",
  "lib/qstash-verify.ts",
  "lib/bundle-queue.ts",
  "lib/rate-limit.ts",
  "lib/serper.ts",
];

/**
 * Secret-reading modules that deliberately stay unfenced, each with the reason
 * it cannot take server-only. These are load-bearing exclusions, not debt.
 */
const EXCUSED = new Map<string, string>([
  [
    "lib/supabase/config.ts",
    // Reads SUPABASE_SERVICE_ROLE_KEY but is reached by 47 client chains via
    // browser-client.ts and by src/proxy.ts (edge middleware). The service-role
    // read is fenced by getSupabaseEnv({ server: true }) plus the CAR-151
    // eslint import restriction on @/lib/supabase/service-client instead.
    "isomorphic: imported by browser-client.ts and edge middleware",
  ],
  [
    "lib/admin-notify.ts",
    // Only secret is SENDGRID_API_KEY, and that account is dead (0 credits,
    // all sends refused since 2026-07-10). Fencing a path that cannot work
    // would imply it is live; the module wants deleting, not hardening.
    "dead code: SendGrid account is defunct, module pending removal",
  ],
]);

/** Env names that are secrets. NEXT_PUBLIC_* is public by definition. */
const SECRET_PATTERN =
  /process\.env\.(?:[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\b/;

const FENCE_IMPORT = /^\s*import\s+["']server-only["'];?\s*$/m;

describe("server-only fence (CAR-158 / F39)", () => {
  it.each(FENCED)("%s carries the server-only import", (rel) => {
    const src = readFileSync(path.join(srcDir, rel), "utf8");
    expect(
      FENCE_IMPORT.test(src),
      `${rel} lost its \`import "server-only"\`. That silently reopens the ` +
        `boundary: a client component could import it and ship a credential ` +
        `read to the browser. Restore the import (below the file's docblock).`,
    ).toBe(true);
  });

  it("no unfenced lib module reads a secret without an explicit excuse", () => {
    const files = fg.sync("**/*.{ts,tsx}", { cwd: libDir, absolute: true });
    expect(files.length).toBeGreaterThan(0);

    const fenced = new Set(FENCED);
    const offenders: string[] = [];

    for (const abs of files) {
      const rel = path.relative(srcDir, abs).split(path.sep).join("/");
      if (fenced.has(rel) || EXCUSED.has(rel)) continue;

      const src = readFileSync(abs, "utf8");
      // A NEXT_PUBLIC_ name can contain KEY (NEXT_PUBLIC_POSTHOG_KEY); strip
      // those reads before testing so they do not count as secrets.
      const withoutPublic = src.replace(/process\.env\.NEXT_PUBLIC_[A-Z0-9_]+/g, "");
      if (SECRET_PATTERN.test(withoutPublic)) offenders.push(rel);
    }

    expect(
      offenders,
      "These lib modules read a secret from process.env but carry no " +
        '`import "server-only"`. Either add the fence, or add the module to ' +
        "EXCUSED with the reason it cannot take one (e.g. it is isomorphic).",
    ).toEqual([]);
  });

  it("every excused module still exists and still reads a secret", () => {
    // Keeps EXCUSED honest: if a module is deleted or stops reading secrets,
    // the excuse should go with it rather than lingering as false context.
    const stale: string[] = [];
    for (const [rel] of EXCUSED) {
      const abs = path.join(srcDir, rel);
      let src: string;
      try {
        src = readFileSync(abs, "utf8");
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      const withoutPublic = src.replace(/process\.env\.NEXT_PUBLIC_[A-Z0-9_]+/g, "");
      if (!SECRET_PATTERN.test(withoutPublic)) {
        stale.push(`${rel} (no longer reads a secret)`);
      }
    }
    expect(stale, "Remove these entries from EXCUSED — their reason no longer applies.").toEqual([]);
  });
});

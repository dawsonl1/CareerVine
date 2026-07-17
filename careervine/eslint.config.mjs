import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Grandfathered createSupabaseServiceClient importers (CAR-151 guardrail).
 *
 * The service-role client bypasses RLS, so acquiring it is restricted: a NEW
 * file importing it fails lint until it is deliberately added here (with the
 * same review a new cross-tenant surface deserves). Every entry below
 * predates the guardrail and hand-scopes its queries; the categories:
 *  - admin/**            requireAdmin- or machine-token-gated, intentionally cross-user
 *  - cron|queue routes   QStash-verified system context, claim/status-scoped
 *  - user-facing routes  withApiHandler auth + inline user_id scoping (audited)
 *  - lib helpers         userId-parameterized helpers for those routes
 *  - src/mcp/lib/db.ts   the MCP data layer; scoping enforced by db-scoping.test.ts
 * Tests are exempt via the files/ignores globs (they mock this module).
 */
const SERVICE_CLIENT_GRANDFATHERED = [
  // admin (cross-user by design)
  "src/app/api/admin/ai-access/route.ts",
  "src/app/api/admin/bundles/publish/route.ts",
  "src/app/api/admin/scrape-controls/bulk/route.ts",
  "src/app/api/admin/users/\\[id\\]/ai-policy/route.ts",
  "src/app/api/admin/users/\\[id\\]/automatic-features/route.ts",
  "src/app/api/admin/users/\\[id\\]/bundle-access/route.ts",
  "src/app/api/admin/users/\\[id\\]/contacts/\\[contactId\\]/route.ts",
  "src/app/api/admin/users/\\[id\\]/contacts/route.ts",
  "src/app/api/admin/users/\\[id\\]/password/route.ts",
  "src/app/api/admin/users/\\[id\\]/premium/route.ts",
  "src/app/api/admin/users/\\[id\\]/role/route.ts",
  "src/app/api/admin/users/\\[id\\]/route.ts",
  "src/app/api/admin/users/\\[id\\]/scrape-controls/route.ts",
  "src/app/api/admin/users/\\[id\\]/status/route.ts",
  "src/app/api/admin/users/route.ts",
  // cron / queue / webhook (system context)
  "src/app/api/cron/data-retention/route.ts",
  "src/app/api/cron/discovery/route.ts",
  "src/app/api/cron/follow-up-nudges/route.ts",
  "src/app/api/cron/scrape-refresh/route.ts",
  "src/app/api/cron/send-follow-ups/route.ts",
  "src/app/api/cron/storage-sweep/route.ts",
  "src/app/api/cron/sync-bundles/route.ts",
  "src/app/api/queue/bundle-sync/route.ts",
  "src/app/api/notifications/unsubscribe/route.ts",
  // user-facing routes (withApiHandler auth + inline scoping)
  "src/app/api/ai/request-access/route.ts",
  "src/app/api/calendar/availability-profile/route.ts",
  "src/app/api/calendar/availability/route.ts",
  "src/app/api/calendar/busy-calendars/route.ts",
  "src/app/api/calendar/create-event/route.ts",
  "src/app/api/calendar/disconnect/route.ts",
  "src/app/api/calendar/events/\\[googleEventId\\]/route.ts",
  "src/app/api/calendar/events/route.ts",
  "src/app/api/calendar/sync/route.ts",
  "src/app/api/discovery/candidates/\\[id\\]/add/route.ts",
  "src/app/api/discovery/candidates/\\[id\\]/dismiss/route.ts",
  "src/app/api/email-follow-ups/\\[id\\]/route.ts",
  "src/app/api/email-follow-ups/route.ts",
  "src/app/api/gmail/ai-followups/\\[id\\]/route.ts",
  "src/app/api/gmail/ai-followups/generate/route.ts",
  "src/app/api/gmail/ai-followups/pending/route.ts",
  "src/app/api/gmail/ai-write/meetings/route.ts",
  "src/app/api/gmail/ai-write/resolve-contact/route.ts",
  "src/app/api/gmail/auth/route.ts",
  "src/app/api/gmail/callback/route.ts",
  "src/app/api/gmail/connection/route.ts",
  "src/app/api/gmail/drafts/\\[id\\]/route.ts",
  "src/app/api/gmail/drafts/route.ts",
  "src/app/api/gmail/emails/\\[messageId\\]/hide/route.ts",
  "src/app/api/gmail/emails/route.ts",
  "src/app/api/gmail/follow-ups/\\[id\\]/route.ts",
  "src/app/api/gmail/follow-ups/awaiting-review/route.ts",
  "src/app/api/gmail/follow-ups/confirm/route.ts",
  "src/app/api/gmail/follow-ups/mark-replied/route.ts",
  "src/app/api/gmail/follow-ups/route.ts",
  "src/app/api/gmail/inbox/route.ts",
  "src/app/api/gmail/schedule/\\[id\\]/retry/route.ts",
  "src/app/api/gmail/schedule/\\[id\\]/route.ts",
  "src/app/api/gmail/schedule/route.ts",
  "src/app/api/gmail/templates/\\[id\\]/route.ts",
  "src/app/api/gmail/templates/route.ts",
  "src/app/api/gmail/unread/route.ts",
  "src/app/api/scrape/status/route.ts",
  "src/app/api/settings/deepgram-key/route.ts",
  "src/app/api/settings/openai-key/route.ts",
  "src/app/api/transcripts/transcribe/route.ts",
  // lib helpers (userId-parameterized, consumed by the routes above)
  "src/lib/ai-followup/gather-context.ts",
  "src/lib/ai-followup/generate-suggestions.ts",
  "src/lib/ai-helpers.ts",
  "src/lib/ai/spend.ts",
  "src/lib/analytics/internal.ts",
  "src/lib/analytics/server.ts",
  "src/lib/apify/account-controls.ts",
  "src/lib/apify/cadence.ts",
  "src/lib/apify/discovery.ts",
  "src/lib/apify/resolver.ts",
  "src/lib/apify/scrape-service.ts",
  "src/lib/apify/spend.ts",
  "src/lib/calendar.ts",
  "src/lib/capabilities/resolve.ts",
  "src/lib/change-events/change-events.ts",
  "src/lib/deepgram.ts",
  "src/lib/email-send.ts",
  "src/lib/follow-up-reply.ts",
  "src/lib/gmail-send-core.ts",
  "src/lib/gmail.ts",
  "src/lib/openai.ts",
  "src/lib/scheduled-email-cron.ts",
  // MCP data layer (scoping enforced by src/mcp/__tests__/db-scoping.test.ts)
  "src/mcp/lib/db.ts",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Honor the `_` prefix as "intentionally unused" (the codebase already uses
  // _args/_opts/_id this way). Standard convention; keeps genuinely-unused
  // bindings a lint error while letting signature-required params opt out.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // The React Compiler static-analysis rules target shipped components. Test
  // harnesses legitimately reassign module-scoped mocks and poke refs from test
  // helpers, which trips these rules without indicating a real component bug.
  // Scope them off for test files only; rules-of-hooks and the rest stay on.
  {
    files: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/__tests__/**"],
    rules: {
      "react-hooks/globals": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  // CAR-151 guardrail: the service-role client bypasses RLS. New importers
  // fail lint until added to SERVICE_CLIENT_GRANDFATHERED (with review).
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/__tests__/**",
      ...SERVICE_CLIENT_GRANDFATHERED,
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/supabase/service-client",
              message:
                "The service-role client bypasses RLS. Prefer the request-scoped client from withApiHandler, or a userId-parameterized helper that already holds one. If this file genuinely needs it, add it to SERVICE_CLIENT_GRANDFATHERED in eslint.config.mjs with a justification (CAR-151).",
            },
          ],
        },
      ],
    },
  },
  // CAR-151 guardrail: inside src/mcp, all data access goes through
  // src/mcp/lib/db.ts (uid()-scoped wrappers). Tools must not acquire the raw
  // client or run ad-hoc queries — that's how unscoped service-role queries
  // sneak past the db-scoping gate.
  {
    files: ["src/mcp/**/*.ts"],
    ignores: ["src/mcp/lib/db.ts", "src/mcp/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/data/client",
              message:
                "Only src/mcp/lib/db.ts may touch the shared data-client seam (CAR-151).",
            },
          ],
          patterns: [
            {
              group: ["**/mcp/lib/db", "./db", "../lib/db"],
              importNames: ["db"],
              message:
                "Don't take the raw client in MCP tools — add a uid()-scoped helper to src/mcp/lib/db.ts instead (CAR-151).",
            },
            {
              group: ["**/lib/data/client"],
              message:
                "Only src/mcp/lib/db.ts may touch the shared data-client seam (CAR-151).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='from'][callee.object.callee.name='db']",
          message:
            "No raw db().from() outside src/mcp/lib/db.ts — add a uid()-scoped helper there so the db-scoping gate covers it (CAR-151).",
        },
      ],
    },
  },
]);

export default eslintConfig;

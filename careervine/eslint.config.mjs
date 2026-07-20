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

/**
 * Implicit-db() importers allowed under src/app (CAR-151 guardrail).
 *
 * The src/lib/data modules resolve their client through db() in
 * src/lib/data/client.ts, a process-global slot that MCP fills with the
 * service-role client via setDataClient(). Those modules are safe there only
 * because they are also scoped by uid() in src/mcp/lib/db.ts; several of them
 * (getInteractions(contactId), getActionItemsForMeeting(meetingId)) filter by
 * row id alone. So any server-executed file under src/app that resolves the
 * implicit db() would read whatever client that slot happens to hold, and
 * bypass RLS. The rule below fences that direction; the categories:
 *  - "use client" pages   browser bundle, own module instance, db() is always
 *                         the anon browser client — not the seam at risk
 *  - explicit-client API  passes its own request-scoped client to every call
 * Adding a NEW entry to the first category is routine; adding one to the
 * second means proving the file never resolves db() implicitly.
 */
const IMPLICIT_DB_ALLOWED_IN_APP = [
  // "use client" pages (browser-executed)
  "src/app/action-items/page.tsx",
  "src/app/calendar/page.tsx",
  "src/app/companies/\\[id\\]/page.tsx",
  "src/app/contacts/\\[id\\]/page.tsx",
  "src/app/contacts/page.tsx",
  "src/app/interactions/page.tsx",
  "src/app/meetings/page.tsx",
  "src/app/page.tsx",
  // API route passing its own request-scoped client explicitly
  "src/app/api/suggestions/save/route.ts",
  // CAR-155 contact-write chokepoint consumers: both pass their own client
  // ({ client }) to createContact/updateContact and never resolve db()
  // implicitly — the extension-auth request client and the admin service
  // client respectively.
  "src/app/api/contacts/import/route.ts",
  "src/app/api/admin/users/\\[id\\]/contacts/route.ts",
];

/**
 * The src/lib/data modules that resolve the implicit db() seam, restricted
 * under src/app by the rule above. Deliberately excluded:
 *  - @/lib/data/emails     takes an explicit client on every function
 *  - @/lib/data/postgrest  pure helpers, no client at all
 * The 7 email routes and api/contacts/search depend on those two.
 */
const IMPLICIT_DB_MODULES = [
  "action-items",
  "attachments",
  "contacts",
  "follow-ups",
  "home",
  "interactions",
  "meetings",
  "users",
].map((m) => `@/lib/data/${m}`);

/**
 * no-restricted-imports is one rule id, and flat config resolves a rule to the
 * LAST matching config object rather than merging — so every block below that
 * re-declares it for a subset of src/** must restate this path, or it silently
 * un-restricts the service-role client for those files.
 */
const SERVICE_CLIENT_PATH = {
  name: "@/lib/supabase/service-client",
  message:
    "The service-role client bypasses RLS. Prefer the request-scoped client from withApiHandler, or a userId-parameterized helper that already holds one. If this file genuinely needs it, add it to SERVICE_CLIENT_GRANDFATHERED in eslint.config.mjs with a justification (CAR-151).",
};

/** The src/app entries of SERVICE_CLIENT_GRANDFATHERED (see the two app blocks). */
const SERVICE_CLIENT_GRANDFATHERED_IN_APP = SERVICE_CLIENT_GRANDFATHERED.filter(
  (p) => p.startsWith("src/app/"),
);

const IMPLICIT_DB_MESSAGE =
  "This module resolves the shared db() seam (src/lib/data/client.ts), a process-global slot MCP fills with the service-role client — a server-executed file here would read through it and bypass RLS. Use the request-scoped client from withApiHandler, or a src/lib/data function that takes a client explicitly (@/lib/data/emails). If this file provably never resolves db() implicitly, add it to IMPLICIT_DB_ALLOWED_IN_APP in eslint.config.mjs (CAR-151).";

const IMPLICIT_DB_PATHS = [...IMPLICIT_DB_MODULES, "@/lib/queries"].map(
  (name) => ({ name, message: IMPLICIT_DB_MESSAGE }),
);

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
  // CAR-154 / F21: a bare `catch {}` silently swallows an interactive-handler
  // failure. The rule ignores catch blocks that contain a comment, so a
  // genuinely best-effort/enrichment catch stays legal by documenting *why*
  // it's empty; only undocumented empty blocks fail the gate.
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
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
          paths: [SERVICE_CLIENT_PATH],
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
            SERVICE_CLIENT_PATH,
          ],
          patterns: [
            {
              // ESLint 9 matches these with the `ignore` package, not
              // minimatch: "./db"/"../lib/db" cover only two of the relative
              // forms a file under src/mcp can write, so "**/lib/db" carries
              // the rest ("./lib/db", "../../lib/db", …).
              group: ["**/mcp/lib/db", "**/lib/db", "./db", "../lib/db"],
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
          // Banning the call itself, rather than db().from(), covers every
          // client surface (.rpc/.storage/.auth) and the two-step binding
          // `const c = db(); c.from(...)` that a shape-specific selector
          // misses. Nothing outside src/mcp/lib/db.ts calls db().
          selector: "CallExpression[callee.name='db']",
          message:
            "No raw db() client outside src/mcp/lib/db.ts — add a uid()-scoped helper there so the db-scoping gate covers it (CAR-151).",
        },
      ],
    },
  },
  // CAR-151 guardrail, web direction: MCP parks the service-role client in the
  // process-global db() slot, which is only safe while no server-executed web
  // path resolves that slot implicitly. This fences that invariant.
  // Scoped to src/app because the src/lib/data modules and the @/lib/queries
  // barrel import each other by relative specifier, so a src/lib rule would
  // fire ~18 times inside the data layer itself without adding any coverage.
  {
    files: ["src/app/**/*.ts", "src/app/**/*.tsx"],
    ignores: [
      "src/app/**/__tests__/**",
      "src/app/**/*.test.ts",
      "src/app/**/*.test.tsx",
      ...IMPLICIT_DB_ALLOWED_IN_APP,
      // Handled by the next block, which keeps the implicit-db restriction
      // while dropping the service-client one these files are exempt from.
      ...SERVICE_CLIENT_GRANDFATHERED_IN_APP,
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [...IMPLICIT_DB_PATHS, SERVICE_CLIENT_PATH] },
      ],
    },
  },
  // Same fence for the src/app files already grandfathered on the service-role
  // client: being allowed to hold that client is not a licence to read through
  // the process-global db() slot as well.
  {
    files: SERVICE_CLIENT_GRANDFATHERED_IN_APP,
    ignores: IMPLICIT_DB_ALLOWED_IN_APP,
    rules: {
      "no-restricted-imports": ["error", { paths: IMPLICIT_DB_PATHS }],
    },
  },
  // CAR-158: typed promise rules. These are the only rules here that need type
  // information, so `projectService` is scoped to src/ rather than enabled
  // globally — it roughly doubles lint time (measured 10.8s -> 22.5s), which is
  // marginal next to tsc + vitest + next build in the same CI job, but there is
  // no reason to pay it over config files and scripts too.
  //
  // `checksVoidReturn.attributes` is off deliberately, and it is NOT an
  // effort-based carve-out. The rule's attribute check fires on
  // `onClick={async () => …}` (164 sites here), and the prescribed rewrite,
  // `onClick={() => { void handler(); }}`, produces exactly ZERO robustness
  // gain: `void promise` discards a rejection identically to an unhandled
  // async handler. It converts an implicit floating promise into an explicit
  // one and silences the linter. Every finding with real defect value —
  // floating promises, void-return arguments, and genuinely awaited
  // non-thenables — stays on.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      // Already effectively enforced (CI runs `eslint . --max-warnings 0`, so a
      // warning fails the build today). Raised to error so the severity states
      // the intent rather than relying on a CI flag to mean it.
      "react-hooks/exhaustive-deps": "error",
    },
  },
]);

export default eslintConfig;

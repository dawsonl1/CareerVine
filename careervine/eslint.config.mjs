import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
]);

export default eslintConfig;

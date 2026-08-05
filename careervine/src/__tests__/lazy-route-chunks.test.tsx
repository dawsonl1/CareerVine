// @vitest-environment jsdom
/**
 * CAR-229: what keeps first-paint JS off routes that cannot use it.
 *
 * Two properties, and only one of them is visible in a rendered tree.
 *
 *  1. The four global overlays still MOUNT through their dynamic wrappers.
 *     The failure this catches is a wrong named-export accessor in
 *     app-overlays.tsx: `.then((m) => m.ComposeModal)` on a module that exports
 *     `ComposeEmailModal` resolves to `undefined`, and next/dynamic renders
 *     nothing rather than throwing — an overlay silently disappears from every
 *     route while the build stays green.
 *
 *  2. The imports stay lazy. Re-adding a static import of an overlay or a
 *     settings section puts its whole graph back into the initial script set,
 *     and nothing about the running app looks different, so that half has to be
 *     a source scan (the idiom architecture-boundaries.test.ts uses). The
 *     providers are asserted in the opposite direction: they hold the open/close
 *     state every trigger writes to, so deferring one would break the triggers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { typedMock } from "./helpers/typed-mock";

vi.mock("@/components/compose-email-modal", () =>
  typedMock<typeof import("@/components/compose-email-modal")>({
    ComposeEmailModal: () => <div>compose overlay</div>,
  }),
);

vi.mock("@/components/quick-capture-modal", () =>
  typedMock<typeof import("@/components/quick-capture-modal")>({
    QuickCaptureModal: () => <div>quick capture overlay</div>,
  }),
);

vi.mock("@/components/onboarding/onboarding-flow", () =>
  typedMock<typeof import("@/components/onboarding/onboarding-flow")>({
    OnboardingFlow: () => <div>onboarding overlay</div>,
    ConfirmDialog: vi.fn(),
  }),
);

vi.mock("@/components/onboarding/extension-onboarding-modal", () =>
  typedMock<typeof import("@/components/onboarding/extension-onboarding-modal")>({
    ExtensionOnboardingModal: () => <div>extension onboarding overlay</div>,
  }),
);

import { AppOverlays } from "@/components/app-overlays";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Source with comments stripped, so the header explaining a rule can neither
 * satisfy nor violate it (check-conventions.mjs strips for the same reason).
 * The `[^:]` guard before `//` keeps `https://` URLs from eating their line.
 */
const read = (rel: string) =>
  readFileSync(path.join(srcDir, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** `from "spec"` — a static import, the thing that lands in the initial bundle. */
const staticImportOf = (spec: string) =>
  new RegExp(`from\\s+["']${spec.replace(/[/\\]/g, "\\$&")}["']`);

/** `import("spec")` — the deferred form. */
const dynamicImportOf = (spec: string) =>
  new RegExp(`import\\(\\s*["']${spec.replace(/[/\\]/g, "\\$&")}["']\\s*\\)`);

const OVERLAY_MODULES = [
  "@/components/compose-email-modal",
  "@/components/quick-capture-modal",
  "@/components/onboarding/onboarding-flow",
  "@/components/onboarding/extension-onboarding-modal",
];

const OVERLAY_PROVIDERS = [
  "@/components/compose-email-context",
  "@/components/quick-capture-context",
  "@/components/onboarding/onboarding-context",
  "@/components/onboarding/extension-onboarding-context",
];

const SETTINGS_SECTIONS = [
  "@/components/settings/account-section",
  "@/components/settings/integrations-section",
  "@/components/settings/availability-section",
  "@/components/settings/ai-key-section",
  "@/components/settings/templates-section",
  "@/components/settings/data-subscriptions-section",
  "@/components/settings/data-scraping-section",
];

afterEach(cleanup);

describe("AppOverlays", () => {
  it("mounts all four overlays through their dynamic wrappers", async () => {
    render(<AppOverlays />);
    expect(await screen.findByText("compose overlay")).toBeTruthy();
    expect(await screen.findByText("quick capture overlay")).toBeTruthy();
    expect(await screen.findByText("onboarding overlay")).toBeTruthy();
    expect(await screen.findByText("extension onboarding overlay")).toBeTruthy();
  });

  it("loads every overlay lazily and none of them statically", () => {
    const source = read("components/app-overlays.tsx");
    for (const spec of OVERLAY_MODULES) {
      expect(dynamicImportOf(spec).test(source), `${spec} must be import()ed`).toBe(true);
      expect(staticImportOf(spec).test(source), `${spec} must not be static`).toBe(false);
    }
    // ssr:false is what keeps the chunk out of the initial script set; plain
    // code-splitting still preloads it during SSR and blocks hydration on it.
    expect(source.match(/ssr:\s*false/g)?.length).toBe(OVERLAY_MODULES.length);
  });
});

describe("root layout", () => {
  const source = read("app/layout.tsx");

  it("mounts the overlays through AppOverlays instead of importing them", () => {
    expect(staticImportOf("@/components/app-overlays").test(source)).toBe(true);
    expect(source.includes("<AppOverlays />")).toBe(true);
    for (const spec of OVERLAY_MODULES) {
      expect(staticImportOf(spec).test(source), `${spec} must not be in the layout`).toBe(false);
    }
  });

  it("keeps every overlay provider statically imported", () => {
    for (const spec of OVERLAY_PROVIDERS) {
      expect(staticImportOf(spec).test(source), `${spec} must stay static`).toBe(true);
    }
  });

  it("stays a Server Component, which is why ssr:false cannot live here", () => {
    // next/dynamic with ssr:false is a build error in a Server Component, and
    // this file must stay one to export `metadata`.
    expect(source.includes('"use client"')).toBe(false);
    expect(source.includes("export const metadata")).toBe(true);
    expect(/ssr:\s*false/.test(source)).toBe(false);
  });
});

describe("settings page", () => {
  const source = read("app/settings/page.tsx");

  it("loads each section lazily, since only one renders at a time", () => {
    for (const spec of SETTINGS_SECTIONS) {
      expect(dynamicImportOf(spec).test(source), `${spec} must be import()ed`).toBe(true);
      expect(staticImportOf(spec).test(source), `${spec} must not be static`).toBe(false);
    }
  });

  it("gives every lazily loaded section a loading state so the tab cannot collapse", () => {
    expect(/ssr:\s*false/.test(source)).toBe(true);
    expect(/loading:\s*SectionSkeleton/.test(source)).toBe(true);
    expect(source.includes("animate-pulse")).toBe(true);
  });
});

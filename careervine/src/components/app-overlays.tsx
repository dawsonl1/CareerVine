"use client";

/**
 * Lazily mounted global overlays (CAR-229).
 *
 * The root layout mounts four user-triggered overlays on every route. Imported
 * statically they dragged their whole dependency graph into the first-paint
 * script set of pages that can never show them: ComposeEmailModal alone pulls
 * @tiptap/react, the starter kit and extensions, and dompurify — a ~127KB chunk
 * that /settings, a page needing one database row, was downloading before it
 * could become interactive.
 *
 * Each overlay is `next/dynamic` with `ssr: false`. None is visible on first
 * paint, so there is nothing to server-render, and `ssr: false` is what keeps
 * the chunk out of the initial script set rather than merely code-splitting it
 * (with `ssr: true`, next/dynamic preloads the chunk during SSR and hydration
 * still blocks on it — see PreloadChunks in next/dist/shared/lib/lazy-dynamic).
 * The chunks are fetched right after hydration, so they are warm by the time a
 * user triggers one and opening stays instant.
 *
 * WHY THIS IS A SEPARATE CLIENT COMPONENT: `ssr: false` is a hard build error
 * inside a Server Component ("`ssr: false` is not allowed with `next/dynamic` in
 * Server Components", raised by the SWC transform), and app/layout.tsx must stay
 * a Server Component because it exports `metadata`. Moving these declarations
 * back into the layout does not degrade gracefully; it fails `next build`.
 *
 * WHAT MUST NOT FOLLOW THEM: the matching context providers
 * (ComposeEmailProvider, QuickCaptureProvider, OnboardingProvider,
 * ExtensionOnboardingProvider) stay statically imported in the layout. They own
 * the open/close state these overlays read and every trigger elsewhere in the app
 * writes, so deferring a provider would silently break the trigger paths.
 */

import dynamic from "next/dynamic";

const ComposeEmailModal = dynamic(
  () => import("@/components/compose-email-modal").then((m) => m.ComposeEmailModal),
  { ssr: false },
);

const QuickCaptureModal = dynamic(
  () => import("@/components/quick-capture-modal").then((m) => m.QuickCaptureModal),
  { ssr: false },
);

const OnboardingFlow = dynamic(
  () => import("@/components/onboarding/onboarding-flow").then((m) => m.OnboardingFlow),
  { ssr: false },
);

const ExtensionOnboardingModal = dynamic(
  () =>
    import("@/components/onboarding/extension-onboarding-modal").then(
      (m) => m.ExtensionOnboardingModal,
    ),
  { ssr: false },
);

/**
 * Mounts every globally available overlay. Rendered by the root layout inside
 * the provider stack, so each overlay still reads its own context.
 */
export function AppOverlays() {
  return (
    <>
      <ComposeEmailModal />
      <QuickCaptureModal />
      <OnboardingFlow />
      <ExtensionOnboardingModal />
    </>
  );
}

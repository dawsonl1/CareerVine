"use client";

/**
 * Last-resort boundary for throws in the root layout itself (CAR-184).
 *
 * `app/error.tsx` renders INSIDE `app/layout.tsx`, so it cannot catch a throw from
 * the layout or from any of the eight client providers the layout mounts. This file
 * can, because Next renders it in place of the root layout.
 *
 * Two constraints follow from "in place of the root layout", and both shape the code
 * below:
 *
 *  1. It must render its own `<html>` and `<body>`.
 *  2. Per the Next 16 docs, global-error "render[s] its own document and do[es] NOT
 *     include your global styles". So Tailwind utilities and the Geist font
 *     variables are not guaranteed to reach it, and neither is any provider. That is
 *     why this file uses INLINE STYLES and imports nothing from `@/components`.
 *     Reaching for the design system here is the classic way this page renders
 *     unstyled or blank in production, exactly when it matters most.
 *
 * `reportBoundaryError` is the one exception to "imports nothing": it is a
 * dependency-free function with no React and no styling, safe in a context where
 * the app is presumed broken.
 *
 * `metadata` cannot be exported from a Client Component, so the tab title uses
 * React's `<title>`. The viewport meta is declared here for the same reason the
 * styles are: Next renders the document head INSIDE the boundary this file
 * replaces, so the default `width=device-width` meta unmounts along with it, and
 * without re-declaring it mobile browsers fall back to a ~980px layout viewport and
 * scale this page down to roughly 40% on the one screen whose whole job is being
 * readable. React hoists both tags, so no `<head>` element is needed.
 *
 * The button does a real `location.reload()`, not `unstable_retry()`. Retry is a
 * soft router refresh: it refetches the RSC payload and resets the boundary, but the
 * JS bundle, module-level singletons and any corrupted `localStorage` all survive,
 * so for the class of failure that reaches THIS boundary it usually re-renders the
 * identical panel. That would make a button labeled "Reload the page" look broken.
 * A document reload re-requests the HTML and re-evaluates every module, which is
 * what the copy promises and what Next's own built-in global-error does.
 *
 * There is also a plain `<a href="/">`. It needs no router, no providers and no
 * stylesheet, so it works in exactly the context this file assumes, and it means the
 * user is never left with a single button that re-runs the same failure.
 *
 * Colors are hard-coded rather than themed. With no stylesheet there are no CSS
 * variables to read, and this app ships no dark mode at all (no
 * `prefers-color-scheme` in globals.css, no `dark:` utilities), so a fixed light
 * palette matches the rest of the product rather than diverging from it.
 */

import { useEffect } from "react";
import { reportBoundaryError } from "@/lib/report-error";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    reportBoundaryError("global", error, { digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#ffffff",
          color: "#1b1b1f",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: "24px",
        }}
      >
        <title>Something went wrong | CareerVine</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <div style={{ maxWidth: "26rem", textAlign: "center" }}>
          <p
            role="alert"
            style={{ margin: 0, fontSize: "1rem", fontWeight: 500 }}
          >
            Something went wrong.
          </p>
          <p
            style={{
              margin: "0.5rem 0 1.25rem",
              fontSize: "0.875rem",
              color: "#46464f",
              lineHeight: 1.5,
            }}
          >
            CareerVine could not finish loading. Reloading the page will often fix it.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                cursor: "pointer",
                borderRadius: "20px",
                border: "1px solid #767680",
                backgroundColor: "transparent",
                color: "inherit",
                padding: "0.5rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                fontFamily: "inherit",
              }}
            >
              Reload the page
            </button>
            {/* A plain anchor, deliberately. `next/link` needs the App Router
                context, and this file renders in place of the root layout when
                something in that tree has already failed, so a soft client
                navigation is both unreliable here and the opposite of what is
                wanted: the point is a full document load that re-evaluates every
                module. The lint rule guards against accidentally losing SPA
                navigation; here losing it is the recovery mechanism. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                color: "#1b1b1f",
                fontSize: "0.875rem",
                fontWeight: 500,
                padding: "0.5rem 0.5rem",
              }}
            >
              Go to Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}

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
 * React's `<title>`.
 *
 * Colors are hard-coded rather than themed. With no stylesheet there are no CSS
 * variables to read, and a theme-aware page that guesses wrong is less legible than
 * a neutral one that does not.
 */

import { useEffect } from "react";
import { reportBoundaryError } from "@/lib/report-error";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
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
          <button
            type="button"
            onClick={() => unstable_retry()}
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
        </div>
      </body>
    </html>
  );
}

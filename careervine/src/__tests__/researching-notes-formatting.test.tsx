// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ResearchingNotesEditor } from "@/components/companies/pipeline/researching-notes";

/**
 * CAR-238. Company notes are multi-paragraph plain text. HTML collapses runs of
 * whitespace, so rendering one into a plain <li> turns a structured note into a
 * single run-on block, which is exactly what Dawson saw once the backfill made
 * a long intel note visible. The textarea path keeps newlines for free; the
 * read-only paths need whitespace-pre-wrap.
 *
 * Also pins the dedupe: the backfill copies intel notes into the pipeline list,
 * so the legacy block must not render a second copy of one it already migrated.
 */

const MULTILINE = "HIRING: no openings.\n\nTEAM: one other PM.\n\nPRODUCT: patient reactivation.";

afterEach(cleanup);

describe("ResearchingNotesEditor formatting", () => {
  it("preserves newlines in a legacy intel note", () => {
    const { container } = render(
      <ResearchingNotesEditor
        notes={[]}
        onChange={() => {}}
        intelNotes={[{ id: 1, note: MULTILINE }]}
      />,
    );

    const li = [...container.querySelectorAll("li")].find((el) =>
      el.textContent?.includes("HIRING:"),
    );
    expect(li, "intel note should render").toBeTruthy();
    // The class is the mechanism; without it the browser collapses the blank
    // lines and the note reads as one paragraph.
    expect(li!.className).toContain("whitespace-pre-wrap");
    // And the text itself must still carry the newlines, not arrive pre-flattened.
    expect(li!.textContent).toContain("\n\n");
  });

  it("hides a legacy intel note the backfill already copied into the list", () => {
    const { container } = render(
      <ResearchingNotesEditor
        notes={[{ id: "n1", body: MULTILINE }]}
        onChange={() => {}}
        intelNotes={[{ id: 1, note: MULTILINE }]}
      />,
    );

    // "From your target record" is the legacy block's heading. The note now
    // exists as an ordinary pipeline note, so showing it twice is noise.
    expect(container.textContent).not.toContain("From your target record");
  });

  it("still shows a legacy intel note that was NOT migrated", () => {
    const { container } = render(
      <ResearchingNotesEditor
        notes={[{ id: "n1", body: "something else entirely" }]}
        onChange={() => {}}
        intelNotes={[{ id: 1, note: MULTILINE }]}
      />,
    );

    // The old gate hid intel notes as soon as ANY pipeline note existed, which
    // is the bug. Only an exact duplicate may be suppressed.
    expect(container.textContent).toContain("From your target record");
    expect(container.textContent).toContain("HIRING:");
  });

  it("matches on trimmed text so trailing whitespace does not defeat the dedupe", () => {
    const { container } = render(
      <ResearchingNotesEditor
        notes={[{ id: "n1", body: `${MULTILINE}\n` }]}
        onChange={() => {}}
        intelNotes={[{ id: 1, note: MULTILINE }]}
      />,
    );
    expect(container.textContent).not.toContain("From your target record");
  });
});

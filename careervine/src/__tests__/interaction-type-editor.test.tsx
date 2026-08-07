// @vitest-environment jsdom
/**
 * CAR-242 — the interaction type editor, now inside the contact timeline's
 * detail modal (moved there by CAR-249; it used to live in the timeline tab).
 *
 * Three behaviors that the DB CHECKs make load-bearing rather than cosmetic:
 *  1. The picker offers the shared five, not the retired eight it hardcoded.
 *  2. `email` appears ONLY while editing a row the send path wrote — every
 *     interaction in production carries it, so omitting it entirely would blank
 *     the picker on the one kind of row that actually exists.
 *  3. Switching away from Other drops the free text. Persisting it would violate
 *     interactions_interaction_type_detail_check and 23514 the save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { mockToastModule } from "./helpers/mock-toast";
import { typedMock } from "./helpers/typed-mock";

const q = vi.hoisted(() => ({
  updateInteraction: vi.fn(),
  deleteInteraction: vi.fn(),
}));

vi.mock("@/lib/data/interactions", () =>
  typedMock<typeof import("@/lib/data/interactions")>({
    getInteractions: vi.fn(),
    getAllInteractions: vi.fn(),
    getInteractionForUser: vi.fn(),
    createInteraction: vi.fn(),
    updateInteraction: q.updateInteraction,
    deleteInteraction: q.deleteInteraction,
  }),
);
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ openCompose: vi.fn(), gmailConnected: false }),
}));
vi.mock("@/components/quick-capture-context", () => ({
  useQuickCapture: () => ({ open: vi.fn(), openEdit: vi.fn() }),
}));

import { TimelineDetailModal } from "@/components/contacts/timeline-detail-modal";
import type { InteractionRow, TimelineEntry } from "@/lib/types";

const interaction = (over: Partial<InteractionRow> = {}): InteractionRow =>
  ({
    id: 1,
    contact_id: 7,
    interaction_date: "2026-07-08T12:00:00",
    interaction_type: "coffee",
    interaction_type_detail: null,
    summary: "Caught up",
    created_at: "2026-07-08T12:00:00Z",
    ...over,
  }) as InteractionRow;

function renderDetail(row: InteractionRow) {
  const entry: TimelineEntry = {
    kind: "interaction",
    date: row.interaction_date,
    data: row,
  };
  return render(
    <TimelineDetailModal
      entry={entry}
      contactName="Spencer Hintze"
      canReadMailbox={false}
      gmailConnected={false}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onConfirmDelete={vi.fn().mockResolvedValue(true)}
    />,
  );
}

/** Switch the open detail modal into its edit form. */
function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
}

beforeEach(() => {
  q.updateInteraction.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("interaction type editor", () => {
  it("renders the stored type through its human label, not the raw slug", () => {
    renderDetail(interaction({ interaction_type: "career-fair" }));
    expect(screen.getByText("Career Fair")).toBeTruthy();
  });

  it("shows the user's own words for an Other interaction", () => {
    renderDetail(interaction({ interaction_type: "other", interaction_type_detail: "Alumni panel" }));
    expect(screen.getByText("Alumni panel")).toBeTruthy();
  });

  it("offers the shared five and none of the retired types", () => {
    renderDetail(interaction());
    openEditor();
    fireEvent.click(screen.getByLabelText("Interaction type"));

    for (const label of ["Career Fair", "Networking Event", "Coffee Chat", "Text Message Chat", "Other"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    for (const retired of ["Phone Call", "Video Call", "Lunch/Dinner", "Conference", "Social Media"]) {
      expect(screen.queryByText(retired)).toBeNull();
    }
  });

  it("keeps Email selectable while editing a send-path row, and hides it otherwise", () => {
    renderDetail(interaction({ interaction_type: "email" }));
    openEditor();
    fireEvent.click(screen.getByLabelText("Interaction type"));
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);

    cleanup();
    renderDetail(interaction({ interaction_type: "coffee" }));
    openEditor();
    fireEvent.click(screen.getByLabelText("Interaction type"));
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("reveals the free-text field only under Other", () => {
    renderDetail(interaction());
    openEditor();
    expect(screen.queryByPlaceholderText("e.g. Alumni panel")).toBeNull();

    fireEvent.click(screen.getByLabelText("Interaction type"));
    fireEvent.click(screen.getByText("Other"));
    expect(screen.getByPlaceholderText("e.g. Alumni panel")).toBeTruthy();
  });

  it("drops the free text when the user switches away from Other", async () => {
    renderDetail(interaction({ interaction_type: "other", interaction_type_detail: "Alumni panel" }));
    openEditor();
    expect((screen.getByPlaceholderText("e.g. Alumni panel") as HTMLInputElement).value).toBe("Alumni panel");

    fireEvent.click(screen.getByLabelText("Interaction type"));
    fireEvent.click(screen.getByText("Coffee Chat"));
    expect(screen.queryByPlaceholderText("e.g. Alumni panel")).toBeNull();

    // Switching BACK must not resurrect the abandoned string. This is the
    // assertion that actually covers the picker's clear-on-switch: without it
    // the test passes on the save-site normalize alone (verified by probe), and
    // the stale text would reappear the moment the user reopened Other.
    fireEvent.click(screen.getByLabelText("Interaction type"));
    fireEvent.click(screen.getByText("Other"));
    expect((screen.getByPlaceholderText("e.g. Alumni panel") as HTMLInputElement).value).toBe("");

    // Back to Coffee Chat, and the save must not carry the orphaned string.
    fireEvent.click(screen.getByLabelText("Interaction type"));
    fireEvent.click(screen.getByText("Coffee Chat"));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(q.updateInteraction).toHaveBeenCalled());
    expect(q.updateInteraction.mock.calls[0][1]).toMatchObject({
      interaction_type: "coffee",
      interaction_type_detail: null,
    });
  });

  it("persists the free text when the type stays Other", async () => {
    // Start on Coffee Chat: with the row already on Other, the closed trigger
    // and the open option both read "Other" and the query is ambiguous.
    renderDetail(interaction({ interaction_type: "coffee" }));
    openEditor();
    fireEvent.click(screen.getByLabelText("Interaction type"));
    fireEvent.click(screen.getByText("Other"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Alumni panel"), { target: { value: "  Alumni panel  " } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(q.updateInteraction).toHaveBeenCalled());
    expect(q.updateInteraction.mock.calls[0][1]).toMatchObject({
      interaction_type: "other",
      interaction_type_detail: "Alumni panel",
    });
  });
});

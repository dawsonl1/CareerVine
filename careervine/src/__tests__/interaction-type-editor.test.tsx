// @vitest-environment jsdom
/**
 * CAR-242 — the interaction type editor on the contact timeline.
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

const q = vi.hoisted(() => ({
  updateInteraction: vi.fn(),
  deleteInteraction: vi.fn(),
  getInteractions: vi.fn(),
}));

vi.mock("@/lib/queries", () => q);
vi.mock("@/components/ui/toast", () => mockToastModule());

import { ContactTimelineTab } from "@/components/contacts/contact-timeline-tab";
import type { InteractionRow } from "@/lib/types";

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

function renderTab(rows: InteractionRow[]) {
  return render(
    <ContactTimelineTab
      contactId={7}
      meetings={[]}
      interactions={rows}
      emails={[]}
      completedActions={[]}
      loading={false}
      onInteractionsChange={vi.fn()}
      onConfirmDeleteInteraction={vi.fn().mockResolvedValue(true)}
    />,
  );
}

/** Open the edit modal for the first interaction in the timeline. */
function openEditor() {
  const edit = screen.getAllByRole("button").find((b) => b.getAttribute("title")?.match(/edit/i))
    ?? screen.getAllByRole("button")[0];
  fireEvent.click(edit);
}

beforeEach(() => {
  q.updateInteraction.mockResolvedValue(undefined);
  q.getInteractions.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("interaction type editor", () => {
  it("renders the stored type through its human label, not the raw slug", () => {
    renderTab([interaction({ interaction_type: "career-fair" })]);
    expect(screen.getByText("Career Fair")).toBeTruthy();
  });

  it("shows the user's own words for an Other interaction", () => {
    renderTab([interaction({ interaction_type: "other", interaction_type_detail: "Alumni panel" })]);
    expect(screen.getByText("Alumni panel")).toBeTruthy();
  });

  it("offers the shared five and none of the retired types", () => {
    renderTab([interaction()]);
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
    renderTab([interaction({ interaction_type: "email" })]);
    openEditor();
    fireEvent.click(screen.getByLabelText("Interaction type"));
    expect(screen.getAllByText("Email").length).toBeGreaterThan(0);

    cleanup();
    renderTab([interaction({ interaction_type: "coffee" })]);
    openEditor();
    fireEvent.click(screen.getByLabelText("Interaction type"));
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("reveals the free-text field only under Other", () => {
    renderTab([interaction()]);
    openEditor();
    expect(screen.queryByPlaceholderText("e.g. Alumni panel")).toBeNull();

    fireEvent.click(screen.getByLabelText("Interaction type"));
    fireEvent.click(screen.getByText("Other"));
    expect(screen.getByPlaceholderText("e.g. Alumni panel")).toBeTruthy();
  });

  it("drops the free text when the user switches away from Other", async () => {
    renderTab([interaction({ interaction_type: "other", interaction_type_detail: "Alumni panel" })]);
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
    renderTab([interaction({ interaction_type: "coffee" })]);
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

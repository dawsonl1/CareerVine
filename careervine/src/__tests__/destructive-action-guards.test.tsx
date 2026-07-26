// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { typedMock } from "./helpers/typed-mock";
import { mockToastModule, toastMock } from "./helpers/mock-toast";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockBrowserClientModule } from "./helpers/mock-supabase";

/**
 * CAR-207: two handlers that destroyed or duplicated data with no guard.
 *
 *   - Attachment delete removed a storage object AND its row with no
 *     confirmation, and reported a refusal only to the console — so a
 *     mis-click was unrecoverable and a failed delete left the row on screen
 *     looking untouched. Its upload loop refreshed the list only on success,
 *     so a throw partway through a batch left the files that HAD landed
 *     invisible until the next page load.
 *   - Subscribe's only gate was `disabled={prog != null}`, and `prog` is set
 *     after the first await, so the button stayed live for the whole round
 *     trip. Two POSTs raced UNIQUE (user_id, bundle_id) and the loser's 500
 *     was toasted as a failure over a subscription that existed.
 *
 * The double-click cases dispatch both events inside ONE act(). Two
 * `fireEvent.click` calls do not reproduce a double click: fireEvent
 * act-wraps each dispatch, so React re-renders in between and the second lands
 * on an already-disabled control. That makes a state flag look sufficient
 * while it is not, which is the exact failure mode these guards exist for.
 */

vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
// One published bundle, no subscription: exactly the state that renders a live
// Subscribe button. Read through a thunk, so the locals below are initialized
// by the time it runs (vi.mock factories are hoisted above the file body).
vi.mock("@/lib/supabase/browser-client", () =>
  mockBrowserClientModule(() => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: () => b,
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: table === "data_bundles" ? [BUNDLE] : [], error: null }),
      };
      return b;
    },
  })),
);

const BUNDLE = {
  id: 3,
  slug: "apm-2026",
  name: "APM Data Bundle",
  description: "Curated APM prospects",
  version: 2,
  prospect_count: 120,
  company_count: 40,
  published_at: "2026-07-01T00:00:00.000Z",
};

// vi.hoisted, not plain consts: a vi.mock factory runs when the mocked module
// is first imported, and imports are hoisted above the file body, so a local
// read inside the factory is still in TDZ (CONVENTIONS §h).
const q = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  addAttachmentToContact: vi.fn(),
  addAttachmentToMeeting: vi.fn(),
  getAttachmentsForContact: vi.fn(),
  getAttachmentsForMeeting: vi.fn(),
  getAttachmentUrl: vi.fn(),
  deleteAttachment: vi.fn(),
}));

// Mocked at the domain module rather than the `@/lib/queries` barrel: the
// barrel re-exports from here, so this covers the component's import while
// staying small enough to type against the real module (CONVENTIONS §h).
vi.mock("@/lib/data/attachments", () => typedMock<typeof import("@/lib/data/attachments")>(q));

import { ContactAttachmentsTab } from "@/components/contacts/contact-attachments-tab";
import DataSubscriptionsSection from "@/components/settings/data-subscriptions-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const { uploadAttachment, addAttachmentToContact, deleteAttachment, getAttachmentsForContact } = q;

beforeEach(() => {
  vi.resetAllMocks();
  uploadAttachment.mockImplementation(async (_userId: unknown, file: unknown) => ({
    id: (file as File).name.length,
  }));
  addAttachmentToContact.mockResolvedValue(undefined);
  deleteAttachment.mockResolvedValue(undefined);
  getAttachmentsForContact.mockResolvedValue([]);
  q.getAttachmentUrl.mockResolvedValue("https://signed.example/file");
});

/** Two clicks in one tick, which is what a fast double click actually is. */
function doubleClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// ── ContactAttachmentsTab ────────────────────────────────────────────────

const attachment = {
  id: 11,
  file_name: "resume.pdf",
  content_type: "application/pdf",
  file_size_bytes: 2048,
  object_path: "u-1/abc_resume.pdf",
  created_at: "2026-07-01T00:00:00.000Z",
};

function renderAttachments(onChange = vi.fn()) {
  render(
    <ContactAttachmentsTab
      contactId={7}
      userId="u-1"
      attachments={[attachment]}
      onAttachmentsChange={onChange}
    />,
  );
  return onChange;
}

describe("ContactAttachmentsTab — delete is irreversible (CAR-207)", () => {
  it("asks before destroying the file, and does nothing at all if declined", async () => {
    const onChange = renderAttachments();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });
    // The storage object and the row go together and neither can be recovered,
    // so the confirm has to happen BEFORE the call, not as an undo after it.
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(screen.getByText("This permanently deletes the file. It cannot be undone.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    });
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("deletes once confirmed, and drops the row from the list", async () => {
    const onChange = renderAttachments();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    expect(deleteAttachment).toHaveBeenCalledWith(11, "u-1/abc_resume.pdf");
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("keeps the row and says so when the delete is refused", async () => {
    // Previously a bare console.error: the row stayed on screen with no
    // message, so the file read as deleted when it was still there.
    deleteAttachment.mockRejectedValueOnce(new Error("storage unavailable"));
    const onChange = renderAttachments();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't delete that attachment. Please try again.",
    );
    // The list is NOT edited: the state must match the server, which still has it.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("resume.pdf")).toBeTruthy();
  });

  it("a double click deletes once", async () => {
    renderAttachments();
    doubleClick(screen.getByTitle("Delete attachment"));

    // Both clicks land before any render, so only the synchronous ref can stop
    // the second. One confirm dialog, and after confirming, one delete.
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });
    expect(deleteAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("ContactAttachmentsTab — partial upload (CAR-207)", () => {
  function uploadFiles(count: number) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = Array.from({ length: count }, (_, i) => new File(["x"], `f${i}.pdf`));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    return input;
  }

  it("refreshes the list even when the batch throws partway, and reports the failure", async () => {
    // Three files; the second link fails. Before the fix the refresh sat after
    // the loop, so file 1 was attached in the database and absent from the UI
    // until a reload, with nothing said.
    addAttachmentToContact.mockResolvedValueOnce(undefined);
    addAttachmentToContact.mockRejectedValueOnce(new Error("link failed"));
    getAttachmentsForContact.mockResolvedValue([{ ...attachment, id: 99, file_name: "f0.pdf" }]);
    const onChange = renderAttachments();
    const input = uploadFiles(3);

    await act(async () => {
      fireEvent.change(input);
    });

    // The one file that landed is now on screen...
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 99, file_name: "f0.pdf" }),
    ]);
    // ...and the failure is not silent.
    expect(toastMock.error).toHaveBeenCalledWith(
      "Some files couldn't be uploaded. Please try again.",
    );
    // The loop stopped at the failure rather than pressing on.
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
  });

  it("refreshes once and says nothing when the whole batch succeeds", async () => {
    getAttachmentsForContact.mockResolvedValue([attachment]);
    const onChange = renderAttachments();
    const input = uploadFiles(2);

    await act(async () => {
      fireEvent.change(input);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getAttachmentsForContact).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});

// ── DataSubscriptionsSection ─────────────────────────────────────────────

describe("DataSubscriptionsSection — subscribe double submit (CAR-207)", () => {
  it("a double click POSTs to /api/bundles/subscribe exactly once", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        posts.push(url);
        // Never resolves: the guard has to hold while the request is still in
        // flight, which is precisely the window `disabled={prog != null}` left
        // open, since `prog` is only set after this await returns.
        return new Promise<Response>(() => {});
      }),
    );

    await act(async () => {
      render(<DataSubscriptionsSection />);
    });

    // Assert the control exists rather than querying it optionally: a test that
    // tolerates an absent button would pass on a component that never rendered.
    const button = await waitFor(() => screen.getByRole("button", { name: "Subscribe" }));
    doubleClick(button);

    expect(posts.filter((u) => u === "/api/bundles/subscribe")).toHaveLength(1);
  });
});

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

/** Mirrors the component's own Attachment shape, nullable fields included, so
 *  the setter mock below is contravariantly assignable to its prop type. */
type Att = {
  id: number;
  file_name: string;
  content_type: string | null;
  file_size_bytes: number | null;
  object_path: string;
  created_at: string | null;
};

const attachment: Att = {
  id: 11,
  file_name: "resume.pdf",
  content_type: "application/pdf",
  file_size_bytes: 2048,
  object_path: "u-1/abc_resume.pdf",
  created_at: "2026-07-01T00:00:00.000Z",
};

const changeMock = () => vi.fn((_value: Att[] | ((prev: Att[]) => Att[])) => {});
type ChangeMock = ReturnType<typeof changeMock>;

/**
 * The confirm question is asked by the PAGE, not this tab (the CAR-204 pattern:
 * the tab renders inside a `SectionBoundary` keyed on `dataGeneration`, so a
 * `useConfirm` living in it is unmounted by any background refresh and the open
 * dialog vanishes mid-question). So the tests drive the callback directly.
 */
function renderAttachments(
  opts: { onChange?: ChangeMock; confirmed?: boolean | Promise<boolean>; loading?: boolean } = {},
) {
  const onChange = opts.onChange ?? changeMock();
  const onConfirmDelete = vi.fn(() =>
    opts.confirmed instanceof Promise
      ? opts.confirmed
      : Promise.resolve(opts.confirmed ?? true),
  );
  render(
    <ContactAttachmentsTab
      contactId={7}
      userId="u-1"
      attachments={[attachment]}
      loading={opts.loading ?? false}
      onAttachmentsChange={onChange}
      onConfirmDelete={onConfirmDelete}
    />,
  );
  return { onChange, onConfirmDelete };
}

/**
 * The merge of CAR-205 and CAR-207 on this component.
 *
 * Both landed a deep-review pass on the same file in parallel: CAR-205 added the
 * `loading` prop so the tab shows a spinner instead of an empty list while the
 * related-data read is in flight, and CAR-207 replaced the delete path with a
 * page-owned confirm and a functional-updater write. The conflict was in the
 * props block, where taking either side whole would have silently dropped the
 * other. These pin that both survived and compose.
 */
describe("ContactAttachmentsTab — the CAR-205 + CAR-207 merge", () => {
  it("shows the loading state instead of the list while the read is in flight", async () => {
    renderAttachments({ loading: true });

    expect(screen.getByText("Loading...")).toBeTruthy();
    // The list is withheld, so an in-flight read cannot read as "no files".
    expect(screen.queryByText("resume.pdf")).toBeNull();
  });

  it("still guards delete once loaded", async () => {
    const { onConfirmDelete } = renderAttachments({ loading: false });

    expect(screen.getByText("resume.pdf")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });

    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
    expect(deleteAttachment).toHaveBeenCalledTimes(1);
  });
});

/** Apply the functional updater the component passed to setState. */
function applyUpdate(onChange: ChangeMock, prev: Att[]): Att[] {
  const arg = onChange.mock.calls.at(-1)![0];
  return typeof arg === "function" ? arg(prev) : arg;
}

describe("ContactAttachmentsTab — delete is irreversible (CAR-207)", () => {
  it("asks before destroying the file, and does nothing at all if declined", async () => {
    const { onChange, onConfirmDelete } = renderAttachments({ confirmed: false });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });

    // The storage object and the row go together and neither can be recovered,
    // so the question has to be asked BEFORE the call, not offered as an undo.
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("deletes once confirmed, and drops the row from the list", async () => {
    const { onChange } = renderAttachments();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });

    expect(deleteAttachment).toHaveBeenCalledWith(11, "u-1/abc_resume.pdf");
    expect(applyUpdate(onChange, [attachment])).toEqual([]);
  });

  it("removes only the deleted row from the list as it stands when the write lands", async () => {
    // The regression this pins: the handler used to filter the `attachments`
    // PROP captured at the click, and the confirm dialog stretches that gap
    // across human decision time. An upload landing in the gap was reverted,
    // so a file the user had just added vanished while sitting in the database.
    const { onChange } = renderAttachments();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });

    const uploadedMeanwhile = { ...attachment, id: 99, file_name: "just-uploaded.pdf" };
    expect(applyUpdate(onChange, [attachment, uploadedMeanwhile])).toEqual([uploadedMeanwhile]);
  });

  it("keeps the row and says so when the delete is refused", async () => {
    // Previously a bare console.error: the row stayed on screen with no
    // message, so the file read as deleted when it was still there.
    deleteAttachment.mockRejectedValueOnce(new Error("storage unavailable"));
    const { onChange } = renderAttachments();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Delete attachment"));
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't delete that attachment. Please try again.",
    );
    // The list is NOT edited: the state must match the server, which still has it.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("resume.pdf")).toBeTruthy();
  });

  it("a double click asks once, so it can only ever delete once", async () => {
    // Isolates the ref, which the previous version of this test did not: it
    // asserted one `deleteAttachment`, and that held with the ref removed too,
    // because useConfirm resolves a superseded question false and the first
    // handler then bails on its own. Holding the question open makes the ref
    // the only thing that can stop the second invocation.
    let release!: (v: boolean) => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const { onConfirmDelete } = renderAttachments({ confirmed: held });

    doubleClick(screen.getByTitle("Delete attachment"));

    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
    await act(async () => { release(true); await held; });
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
    const { onChange } = renderAttachments();
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

  it("reports a failed REFRESH as a refresh failure, not as a failed upload", async () => {
    // The refresh used to live in a `finally` inside the upload action, and a
    // `finally` that throws replaces the original exception. So a fully
    // successful upload whose refresh failed was reported as "couldn't upload",
    // over a list that still looked unchanged. The natural retry then produced
    // a duplicate storage object, row and junction row.
    getAttachmentsForContact.mockRejectedValueOnce(new Error("read failed"));
    const { onChange } = renderAttachments();
    const input = uploadFiles(1);

    await act(async () => {
      fireEvent.change(input);
    });

    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(addAttachmentToContact).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith(
      "Your files uploaded, but the list couldn't be refreshed. Reload to see them.",
    );
    expect(toastMock.error).not.toHaveBeenCalledWith(
      "Couldn't upload that file. Please try again.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the upload's own error when the refresh fails too", async () => {
    // try/finally discarded the upload error entirely when both failed, so the
    // thing that actually went wrong never reached the console or the user.
    addAttachmentToContact.mockRejectedValueOnce(new Error("link failed"));
    getAttachmentsForContact.mockRejectedValueOnce(new Error("read failed"));
    renderAttachments();
    const input = uploadFiles(1);

    await act(async () => {
      fireEvent.change(input);
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't upload that file. Please try again.",
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't refresh the attachment list. Reload to see what landed.",
    );
  });

  it("refreshes once and says nothing when the whole batch succeeds", async () => {
    getAttachmentsForContact.mockResolvedValue([attachment]);
    const { onChange } = renderAttachments();
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

// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-237: the in-app audio upload path had never worked. `handleAudioFile`
 * POSTed to `/api/attachments/upload` (a route that does not exist) and then
 * sent `{ objectPath }` where `/api/transcripts/transcribe` requires
 * `attachmentObjectPath`. Nothing called that route and nothing tested it, so
 * both breaks survived a full client-mutation sweep (CAR-188) untouched.
 *
 * These tests bind the client to the server's own contract rather than to a
 * restated string literal: the outgoing body is validated with the route's
 * actual Zod schema, so renaming the field on either side fails here. A test
 * asserting `body.attachmentObjectPath === "..."` would NOT have caught the
 * original bug class, because it would have been written against whatever the
 * client happened to send.
 */

import { transcriptTranscribeSchema } from "@/lib/api-schemas";

const uploadAttachment = vi.fn();
vi.mock("@/lib/queries", () => ({
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
}));
vi.mock("@/components/meetings/transcript-action-suggestions", () => ({
  TranscriptActionSuggestions: () => <div />,
}));

import { PastMeetingFields } from "@/components/conversation-modal/past-meeting-fields";

const USER_ID = "63198da1-446a-43e0-b845-7ce708819cbe";
const OBJECT_PATH = `${USER_ID}/8f0c-uuid_call.m4a`;

let fetchMock: ReturnType<typeof vi.fn>;

function renderFields(overrides: Record<string, unknown> = {}) {
  const form = {
    notes: "",
    transcript: "seed so the transcript section starts expanded",
    date: "2026-08-06",
    meetingType: "coffee",
    selectedContactIds: [] as number[],
    ...(overrides.form as object ?? {}),
  };
  return render(
    <PastMeetingFields
      form={form as never}
      setForm={(overrides.setForm as never) ?? vi.fn()}
      transcriptState={{
        pendingSegments: [],
        pendingTranscriptSource: "",
        isTranscribing: false,
        pendingAudioAttachment: null,
      } as never}
      setTranscriptState={vi.fn()}
      meetingId={null}
      userId={USER_ID}
      allContacts={[]}
      onAiActionAccepted={vi.fn()}
      onActionCreated={vi.fn()}
    />,
  );
}

/**
 * The audio picker lives on TranscriptUploader's "Upload recording" tab, which
 * is not the default, so the tab has to be opened before the input exists.
 */
function selectAudio(container: HTMLElement) {
  const tab = Array.from(container.querySelectorAll("button")).find((b) =>
    /upload recording/i.test(b.textContent ?? ""),
  );
  if (!tab) throw new Error('"Upload recording" tab not found');
  fireEvent.click(tab);

  const input = container.querySelector<HTMLInputElement>(
    'input[type="file"][accept*=".m4a"]',
  );
  if (!input) throw new Error("audio file input not found");

  const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

/** Body of the POST to the transcribe route, or undefined if it was never called. */
function transcribeBody() {
  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("/api/transcripts/transcribe"),
  );
  if (!call) return undefined;
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadAttachment.mockResolvedValue({ id: 42, object_path: OBJECT_PATH });
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ rawText: "Alice: hi", segments: [] }),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("audio transcription request contract", () => {
  it("sends a body the transcribe route's own schema accepts", async () => {
    const { container } = renderFields();
    selectAudio(container);

    await waitFor(() => expect(transcribeBody()).toBeDefined());

    // The assertion that matters: the server's parser accepts what we sent.
    const parsed = transcriptTranscribeSchema.safeParse(transcribeBody());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.attachmentObjectPath).toBe(OBJECT_PATH);
  });

  it("uploads through the shared helper, not a nonexistent upload route", async () => {
    const { container } = renderFields();
    selectAudio(container);

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(uploadAttachment).toHaveBeenCalledWith(USER_ID, expect.any(File));

    // /api/attachments/upload does not exist; nothing may reach for it.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("/api/attachments"))).toBe(false);
  });

  it("does not let a superseded transcription overwrite a newer one", async () => {
    // Two files picked in a row. The first upload resolves LAST, so without a
    // latest-request guard its transcript would clobber the second one's.
    const setForm = vi.fn();
    let releaseFirst: (v: { id: number; object_path: string }) => void = () => {};
    uploadAttachment
      .mockImplementationOnce(
        () => new Promise((res) => { releaseFirst = res; }),
      )
      .mockResolvedValueOnce({ id: 43, object_path: `${USER_ID}/second.m4a` });

    const { container } = renderFields({ setForm });
    selectAudio(container); // first — hangs
    selectAudio(container); // second — resolves immediately, supersedes

    await waitFor(() => expect(transcribeBody()?.attachmentObjectPath).toBe(`${USER_ID}/second.m4a`));
    const callsAfterSecond = fetchMock.mock.calls.length;

    releaseFirst({ id: 42, object_path: OBJECT_PATH });
    await new Promise((r) => setTimeout(r, 20));

    // The stale first request must not transcribe, and must not write state.
    expect(fetchMock.mock.calls.length).toBe(callsAfterSecond);
    const paths = fetchMock.mock.calls
      .filter(([u]) => String(u).includes("/api/transcripts/transcribe"))
      .map(([, i]) => JSON.parse((i as RequestInit).body as string).attachmentObjectPath);
    expect(paths).not.toContain(OBJECT_PATH);
  });

  it("surfaces a failure instead of proceeding when the upload throws", async () => {
    uploadAttachment.mockRejectedValue(new Error("storage rejected the file"));
    const { container, findByText } = renderFields();
    selectAudio(container);

    expect(await findByText(/transcription failed/i)).toBeTruthy();
    expect(transcribeBody()).toBeUndefined();
  });
});

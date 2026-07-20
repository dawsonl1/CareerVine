// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-158: the AI speaker-matching prompt reads `industry` off each candidate
 * contact. It used to be read through `(c as any).industry` on a projection
 * that had no such field, so every request shipped `industry: undefined`.
 * These lock the payload: industry must survive to the request body, and the
 * request must still be well-formed for contacts that genuinely have none.
 */

vi.mock("@/components/ai/ai-unavailable-notice", () => ({
  AiUnavailableNotice: () => <div />,
}));

import SpeakerResolver from "@/components/speaker-resolver";

const segments = [
  { speaker_label: "Speaker 1", text: "Thanks for making time today." },
  { speaker_label: "Speaker 2", text: "Happy to chat about the role." },
];

/** Read the JSON body the component POSTed to the match-speakers endpoint. */
function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse((init as RequestInit).body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ matches: [] }) }));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SpeakerResolver — AI contact context", () => {
  it("sends each candidate's industry to the matcher", async () => {
    render(
      <SpeakerResolver
        segments={segments}
        meetingContacts={[]}
        allContacts={[
          { id: 1, name: "Ada Lovelace", industry: "Software" },
          { id: 2, name: "Grace Hopper", industry: "Defense", emails: ["grace@navy.mil"] },
        ]}
        onResolve={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /auto-match with ai/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(postedBody(fetchMock).contactContext).toEqual([
      { id: 1, name: "Ada Lovelace", industry: "Software", emails: [] },
      { id: 2, name: "Grace Hopper", industry: "Defense", emails: ["grace@navy.mil"] },
    ]);
  });

  it("falls back to the meeting attendees, industry included, when allContacts is absent", async () => {
    render(
      <SpeakerResolver
        segments={segments}
        meetingContacts={[{ id: 7, name: "Katherine Johnson", industry: "Aerospace" }]}
        onResolve={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /auto-match with ai/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(postedBody(fetchMock).contactContext).toEqual([
      { id: 7, name: "Katherine Johnson", industry: "Aerospace", emails: [] },
    ]);
  });

  it("omits industry rather than sending null when the contact has none", async () => {
    render(
      <SpeakerResolver
        segments={segments}
        meetingContacts={[]}
        allContacts={[{ id: 3, name: "Alan Turing", industry: null }]}
        onResolve={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /auto-match with ai/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [candidate] = postedBody(fetchMock).contactContext;
    expect(candidate.industry).toBeUndefined();
    expect(candidate.name).toBe("Alan Turing");
  });
});

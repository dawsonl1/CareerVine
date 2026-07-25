// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";

/**
 * CAR-183: deleting a template used to `await fetch(DELETE)` without checking
 * the response, then drop the row from local state. A failed delete looked like
 * a success until the next load brought the template back.
 *
 * The `window.confirm` this handler still uses is a separate finding owned by
 * CAR-188; it is stubbed here rather than changed.
 */

const h = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({
    toast: () => "",
    dismiss: () => {},
    success: () => {},
    error: h.toastError,
    info: () => {},
    warning: () => {},
  }),
}));

import TemplatesSection from "@/components/settings/templates-section";

const TEMPLATE_ID = 3;
const LIST_ROUTE = "GET /api/gmail/templates";
const DELETE_ROUTE = `DELETE /api/gmail/templates/${TEMPLATE_ID}`;
const TOAST_COPY = "Couldn't delete that template. Please try again.";

function template() {
  return {
    id: TEMPLATE_ID,
    user_id: "u-1",
    name: "Job referral request",
    prompt: "Write a professional email requesting a referral.",
    is_default: false,
    sort_order: 0,
    created_at: "2026-07-01T12:00:00.000Z",
    updated_at: "2026-07-01T12:00:00.000Z",
  };
}

async function renderAndDelete(deleteRoute: Parameters<typeof installFakeFetch>[0][string]) {
  const http = installFakeFetch({
    [LIST_ROUTE]: { body: { templates: [template()] } },
    [DELETE_ROUTE]: deleteRoute,
  });

  await act(async () => {
    render(<TemplatesSection />);
  });

  expect(screen.getByText("Job referral request")).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByTitle("Delete"));
  });

  return http;
}

describe("TemplatesSection — delete (CAR-183)", () => {
  beforeEach(() => {
    h.toastError.mockClear();
    // The handler bails before fetching unless the confirm is accepted.
    vi.stubGlobal("confirm", () => true);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the template in the list and toasts when the delete fails", async () => {
    const http = await renderAndDelete({
      status: 500,
      body: { error: "Something went wrong" },
    });

    expect(screen.getByText("Job referral request")).toBeTruthy();
    expect(h.toastError).toHaveBeenCalledWith(TOAST_COPY);
    expect(http.countOf(DELETE_ROUTE)).toBe(1);
  });

  it("removes the template on a 2xx, with no toast", async () => {
    const http = await renderAndDelete({ body: { success: true } });

    expect(screen.queryByText("Job referral request")).toBeNull();
    expect(screen.getByText("No custom templates yet.")).toBeTruthy();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(http.countOf(DELETE_ROUTE)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });
});

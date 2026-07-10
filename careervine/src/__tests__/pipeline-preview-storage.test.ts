import { describe, expect, it } from "vitest";
import {
  defaultCycleFormState,
  defaultPipelinePreviewState,
  getActiveCycleState,
  mergePipelinePreviewState,
  patchCycleFormState,
  pipelinePreviewStorageKey,
} from "@/lib/pipeline-preview-storage";
import type { LocationTabsData } from "@/lib/company-location-preview";

const emptyTabs: LocationTabsData = {
  all: {
    key: "all",
    label: "All",
    tabLabel: "All",
    location_id: null,
    contactCount: 0,
    isTargeted: false,
    status: null,
    next_app_date: null,
    app_window_text: null,
    notes: [],
    current: [],
    former: [],
    bench: [],
  },
  companyWide: null,
  offices: [{ key: "nyc", label: "New York", tabLabel: "NYC", location_id: 1, contactCount: 3, isTargeted: false, status: null, next_app_date: null, app_window_text: null, notes: [], current: [], former: [], bench: [] }],
  unassigned: [],
};

describe("pipeline-preview-storage", () => {
  it("builds a stable localStorage key per company", () => {
    expect(pipelinePreviewStorageKey(12)).toBe("cv:pipeline-preview:v1:12");
  });

  it("merges saved state with newly discovered offices", () => {
    const saved = defaultPipelinePreviewState(emptyTabs, null);
    saved.officeTargeted = {};
    const merged = mergePipelinePreviewState(saved, emptyTabs);
    expect(merged.officeTargeted.nyc).toBe(false);
    expect(merged.scopes.nyc).toBeDefined();
  });

  it("patches cycle form fields immutably", () => {
    let state = defaultPipelinePreviewState(emptyTabs, null);
    state = patchCycleFormState(state, "all", 1, (prev) => ({
      ...prev,
      researching: {
        ...prev.researching,
        notes: [{ id: "n1", body: "Portal referrals only" }],
      },
    }));
    expect(getActiveCycleState(state, "all").researching.notes[0]?.body).toBe(
      "Portal referrals only",
    );
    expect(defaultCycleFormState().researching.notes).toEqual([]);
  });
});

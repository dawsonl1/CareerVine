import { describe, expect, it } from "vitest";
import {
  defaultCycleFormState,
  normalizeCycleFormState,
  patchCycleFormState,
  defaultPipelinePreviewState,
  getActiveCycleState,
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
  offices: [],
  unassigned: [],
};

describe("pipeline closed stage", () => {
  it("defaults declinedNextCycle to false", () => {
    expect(defaultCycleFormState().closed).toEqual({ declinedNextCycle: false });
  });

  it("normalizes missing closed state on read", () => {
    const normalized = normalizeCycleFormState({
      selectedStage: "closed",
      researching: { programs: [], notes: [] },
      applied: { applications: [] },
      interviewing: { rounds: [] },
    } as never);

    expect(normalized.closed).toEqual({ declinedNextCycle: false });
  });

  it("persists declining another application cycle", () => {
    let state = defaultPipelinePreviewState(emptyTabs, null);
    state = patchCycleFormState(state, "all", 1, (prev) => ({
      ...prev,
      selectedStage: "closed",
      closed: { declinedNextCycle: true },
    }));

    expect(getActiveCycleState(state, "all").closed.declinedNextCycle).toBe(true);
  });
});

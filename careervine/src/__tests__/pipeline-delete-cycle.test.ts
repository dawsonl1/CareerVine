import { describe, expect, it } from "vitest";
import {
  defaultCycleFormState,
  defaultPipelineState,
  deleteScopeCycle,
  getScopeState,
  patchScopeState,
} from "@/lib/pipeline-state";
import type { LocationTabsData } from "@/lib/company-scopes";

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

function cycleWithNote(body: string) {
  return {
    ...defaultCycleFormState(),
    researching: {
      programs: [],
      notes: [{ id: body, body }],
    },
  };
}

describe("deleteScopeCycle", () => {
  it("does not delete the only remaining cycle", () => {
    const state = defaultPipelineState(emptyTabs, null);
    expect(deleteScopeCycle(state, "all", 1)).toBe(state);
  });

  it("removes a cycle and renumbers the rest", () => {
    let state = defaultPipelineState(emptyTabs, null);
    state = patchScopeState(state, "all", {
      cycleCount: 3,
      activeCycle: 2,
      cycles: {
        "1": cycleWithNote("Cycle one"),
        "2": cycleWithNote("Cycle two"),
        "3": cycleWithNote("Cycle three"),
      },
    });

    const next = deleteScopeCycle(state, "all", 2);
    const scope = getScopeState(next, "all");

    expect(scope.cycleCount).toBe(2);
    expect(scope.activeCycle).toBe(1);
    expect(scope.cycles["1"]?.researching.notes[0]?.body).toBe("Cycle one");
    expect(scope.cycles["2"]?.researching.notes[0]?.body).toBe("Cycle three");
    expect(scope.cycles["3"]).toBeUndefined();
  });

  it("keeps a later active cycle selected when deleting an earlier one", () => {
    let state = defaultPipelineState(emptyTabs, null);
    state = patchScopeState(state, "all", {
      cycleCount: 2,
      activeCycle: 2,
      cycles: {
        "1": defaultCycleFormState(),
        "2": defaultCycleFormState({ selectedStage: "applied" }),
      },
    });

    const next = deleteScopeCycle(state, "all", 1);
    const scope = getScopeState(next, "all");

    expect(scope.cycleCount).toBe(1);
    expect(scope.activeCycle).toBe(1);
    expect(scope.cycles["1"]?.selectedStage).toBe("applied");
  });
});

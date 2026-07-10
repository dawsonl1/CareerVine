import { describe, expect, it } from "vitest";
import {
  cyclePayloadFromForm,
  locationIdForScopeKey,
  scopeKeyForLocationId,
} from "@/lib/pipeline-queries";
import { defaultCycleFormState } from "@/lib/pipeline-state";

describe("scope key mapping", () => {
  it("maps company-wide (NULL location) to the 'all' key and back", () => {
    expect(scopeKeyForLocationId(null)).toBe("all");
    expect(locationIdForScopeKey("all")).toBeNull();
  });

  it("maps office location ids to string keys and back", () => {
    expect(scopeKeyForLocationId(42)).toBe("42");
    expect(locationIdForScopeKey("42")).toBe(42);
  });
});

describe("cyclePayloadFromForm", () => {
  it("serializes an empty default cycle", () => {
    const payload = cyclePayloadFromForm(defaultCycleFormState());
    expect(payload).toEqual({
      selected_stage: "researching",
      declined_next_cycle: false,
      programs: [],
      notes: [],
      applications: [],
      interview_rounds: [],
    });
  });

  it("serializes every section with snake_case columns and file refs", () => {
    const payload = cyclePayloadFromForm({
      selectedStage: "interviewing",
      researching: {
        programs: [{ id: "p1", name: "APM", appsOpen: "date:2026-09-01", jobPotential: "8" }],
        notes: [{ id: "n1", body: "Referrals via portal" }],
      },
      applied: {
        applications: [
          {
            id: "a1",
            jobTitle: "IB Analyst",
            location: "New York",
            dateApplied: "2026-01-15",
            resume: { path: "u1/r.pdf", name: "resume.pdf", sizeBytes: 2048 },
            coverLetter: null,
          },
        ],
      },
      interviewing: {
        rounds: [{ id: "r1", date: "2026-03-01", interviewer: "Alex", questions: "STAR prep" }],
      },
      closed: { declinedNextCycle: true },
    });

    expect(payload.selected_stage).toBe("interviewing");
    expect(payload.declined_next_cycle).toBe(true);
    expect(payload.programs).toEqual([
      { id: "p1", name: "APM", apps_open: "date:2026-09-01", job_potential: "8" },
    ]);
    expect(payload.notes).toEqual([{ id: "n1", body: "Referrals via portal" }]);
    expect(payload.applications).toEqual([
      {
        id: "a1",
        job_title: "IB Analyst",
        location: "New York",
        date_applied: "2026-01-15",
        resume_path: "u1/r.pdf",
        resume_name: "resume.pdf",
        resume_size_bytes: 2048,
        cover_letter_path: null,
        cover_letter_name: null,
        cover_letter_size_bytes: null,
      },
    ]);
    expect(payload.interview_rounds).toEqual([
      { id: "r1", interview_date: "2026-03-01", interviewer: "Alex", questions: "STAR prep" },
    ]);
  });

  it("passes empty date strings through for the RPC to NULLIF", () => {
    const form = defaultCycleFormState();
    form.applied.applications = [
      {
        id: "a1",
        jobTitle: "X",
        location: "",
        dateApplied: "",
        resume: null,
        coverLetter: null,
      },
    ];
    const payload = cyclePayloadFromForm(form);
    expect(payload.applications[0].date_applied).toBe("");
  });
});

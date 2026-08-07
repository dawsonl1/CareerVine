"use client";

/**
 * Pipeline state + debounced Supabase persistence for the company page
 * (CAR-6). Owns the PipelineState reducer that the preview kept in
 * localStorage; every cycle edit is written through save_pipeline_cycle
 * ~800 ms after the user stops typing, targeting toggles and cycle
 * switches write immediately, and the active cycle's stage is mirrored
 * onto target_companies.status so list views stay accurate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompanyDetail } from "@/lib/company-queries";
import type { LocationTabsData } from "@/lib/company-scopes";
import {
  type CycleFormState,
  type PipelineStage,
  type PipelineState,
  type CycleEntityIds,
  collectCycleEntityIds,
  cycleHintsFromTarget,
  defaultCycleFormState,
  defaultPipelineState,
  defaultScopePipelineState,
  deleteScopeCycle,
  getActiveCycleState,
  getScopeState,
  mergePipelineState,
  patchCycleFormState,
  patchScopeState,
} from "@/lib/pipeline-state";
import {
  type LoadedPipeline,
  deletePipelineCycle,
  ensureScopeContainer,
  ensureScopeTarget,
  locationIdForScopeKey,
  diffDeletedIds,
  savePipelineCycle,
  setScopeActiveCycle,
  setScopeUntargeted,
  syncScopeStatus,
} from "@/lib/pipeline-queries";
import { invalidateCompaniesList } from "@/lib/companies-list-cache";
import { invalidateCompanyScopes } from "@/lib/company-detail-cache";

const SAVE_DEBOUNCE_MS = 800;

export type PipelineSaveStatus = "idle" | "saving" | "saved" | "error";

export interface PipelineActions {
  setScopeTargeted: (scopeKey: string, targeted: boolean) => void;
  patchActiveCycle: (scopeKey: string, patch: (prev: CycleFormState) => CycleFormState) => void;
  selectStage: (scopeKey: string, stage: PipelineStage) => void;
  setActiveCycle: (scopeKey: string, cycle: number) => void;
  startNextCycle: (scopeKey: string) => void;
  deleteCycle: (scopeKey: string, cycle: number) => void;
}

export function usePipelineAutosave({
  userId,
  companyId,
  tabs,
  target,
  loaded,
}: {
  userId: string | null;
  companyId: number;
  tabs: LocationTabsData | null;
  target: CompanyDetail["target"];
  loaded: LoadedPipeline | null;
}): {
  state: PipelineState | null;
  saveStatus: PipelineSaveStatus;
  actions: PipelineActions;
} {
  const [state, setState] = useState<PipelineState | null>(null);
  const [saveStatus, setSaveStatus] = useState<PipelineSaveStatus>("idle");

  const stateRef = useRef<PipelineState | null>(null);
  stateRef.current = state;

  /** scopeKey → target_companies.id, filled from load and ensureScopeTarget. */
  const targetIdsRef = useRef<Record<string, number>>({});
  /** Dirty (scopeKey, cycleNumber) pairs awaiting a debounced save. */
  const dirtyRef = useRef<Map<string, { scopeKey: string; cycle: number }>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Serializes ensureScopeTarget + saves per scope so rows aren't raced. */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * `${scopeKey}:${cycle}` → the child ids this client last persisted (CAR-238).
   *
   * Diffing this against the form at save time yields exactly the ids THIS
   * client removed, which is what `save_pipeline_cycle` now deletes. Previously
   * the RPC inferred deletion from absence, so it also destroyed rows written by
   * another tab or by the MCP server since this client loaded.
   */
  const knownIdsRef = useRef<Map<string, CycleEntityIds>>(new Map());

  // ── Initial state from DB load ──────────────────────────────────────
  useEffect(() => {
    if (!tabs || !loaded) return;

    const base = defaultPipelineState(tabs, target);
    const officeTargeted = { ...base.officeTargeted };
    const scopes = { ...base.scopes };
    let companyTargeted = base.companyTargeted;

    for (const [scopeKey, loadedScope] of loaded) {
      targetIdsRef.current[scopeKey] = loadedScope.targetId;
      if (scopeKey === "all") companyTargeted = loadedScope.isTargeted;
      else officeTargeted[scopeKey] = loadedScope.isTargeted;

      // Seed the deletion baseline from what the server actually holds (CAR-238).
      // Without this the first save of a session has no prior snapshot, so a
      // note the user deleted would be reported as no deletion at all and would
      // reappear on reload.
      for (const [cycleNumber, form] of Object.entries(loadedScope.scope.cycles)) {
        knownIdsRef.current.set(`${scopeKey}:${cycleNumber}`, collectCycleEntityIds(form));
      }

      if (loadedScope.scope.cycleCount > 0) {
        scopes[scopeKey] = loadedScope.scope;
      } else if (scopeKey === "all") {
        // Targeted before any pipeline edits — seed cycle 1 from the target row.
        scopes.all = defaultScopePipelineState(cycleHintsFromTarget(target, loadedScope.status));
      }
    }

    setState(mergePipelineState({ companyTargeted, officeTargeted, scopes }, tabs));
    // Loaded data is fetched once per page view; rebuilds only on reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, loaded]);

  // ── Persistence plumbing ────────────────────────────────────────────

  const resolveTargetId = useCallback(
    async (
      scopeKey: string,
      seedStage?: PipelineStage,
      mode: "container" | "target" = "container",
    ): Promise<number> => {
      const known = targetIdsRef.current[scopeKey];
      if (known) {
        // Explicit targeting must still flip a known container row.
        if (mode === "target") {
          await ensureScopeTarget(userId!, companyId, locationIdForScopeKey(scopeKey), {
            status: seedStage,
          });
        }
        return known;
      }
      // Background saves create a non-targeted container so research on a
      // non-target company never silently adds it to the targets list.
      const ensure = mode === "target" ? ensureScopeTarget : ensureScopeContainer;
      const id = await ensure(userId!, companyId, locationIdForScopeKey(scopeKey), {
        status: seedStage,
      });
      targetIdsRef.current[scopeKey] = id;
      return id;
    },
    [userId, companyId],
  );

  const enqueue = useCallback((work: () => Promise<void>) => {
    saveChainRef.current = saveChainRef.current.then(work, work);
    return saveChainRef.current;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const dirty = [...dirtyRef.current.values()];
    dirtyRef.current.clear();
    if (dirty.length === 0) return saveChainRef.current;

    setSaveStatus("saving");
    return enqueue(async () => {
      try {
        for (const { scopeKey, cycle } of dirty) {
          const current = stateRef.current;
          if (!current) continue;
          const scope = getScopeState(current, scopeKey);
          const form = scope.cycles[String(cycle)];
          if (!form) continue;

          const targetId = await resolveTargetId(scopeKey, form.selectedStage);

          // Only ids this client had and no longer has count as deletions. Rows
          // it never saw (another tab, the MCP server) are left alone.
          const key = `${scopeKey}:${cycle}`;
          const nowIds = collectCycleEntityIds(form);
          const deleted = diffDeletedIds(knownIdsRef.current.get(key), nowIds);

          await savePipelineCycle(targetId, cycle, form, deleted);
          knownIdsRef.current.set(key, nowIds);

          if (cycle === scope.activeCycle) {
            await syncScopeStatus(targetId, form.selectedStage);
          }
        }
        setSaveStatus("saved");
        // syncScopeStatus above writes target_companies.status, which is what
        // the companies list badges and filters on. The list is unmounted while
        // the user is here, so it cannot listen for this — the cache has to be
        // dropped at the write (CAR-256).
        if (userId) {
          invalidateCompaniesList(userId);
          // syncScopeStatus above writes target_companies.status, which the
          // company page's cached scopes carry too (CAR-268).
          invalidateCompanyScopes();
        }
      } catch (error) {
        console.error("Pipeline save failed", error);
        setSaveStatus("error");
      }
    });
  }, [enqueue, resolveTargetId, userId]);

  const scheduleSave = useCallback(
    (scopeKey: string, cycle: number) => {
      dirtyRef.current.set(`${scopeKey}:${cycle}`, { scopeKey, cycle });
      setSaveStatus("saving");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Flush pending edits when the tab hides or the component unmounts.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      void flush();
    };
  }, [flush]);

  // ── Actions ─────────────────────────────────────────────────────────

  const runPersist = useCallback(
    (work: () => Promise<void>) => {
      setSaveStatus("saving");
      void enqueue(async () => {
        try {
          await work();
          setSaveStatus("saved");
          // Targeting, cycle switches and cycle deletion all move
          // target_companies rows the companies list reads. Same reasoning as
          // in flush(): invalidate at the write, not from a mounted listener.
          if (userId) {
            invalidateCompaniesList(userId);
            invalidateCompanyScopes();
          }
        } catch (error) {
          console.error("Pipeline save failed", error);
          setSaveStatus("error");
        }
      });
    },
    [enqueue, userId],
  );

  const actions = useMemo<PipelineActions>(
    () => ({
      setScopeTargeted: (scopeKey, targeted) => {
        setState((prev) => {
          if (!prev) return prev;
          return scopeKey === "all"
            ? { ...prev, companyTargeted: targeted }
            : { ...prev, officeTargeted: { ...prev.officeTargeted, [scopeKey]: targeted } };
        });
        if (targeted) {
          runPersist(async () => {
            const current = stateRef.current;
            const form = current ? getActiveCycleState(current, scopeKey) : defaultCycleFormState();
            const targetId = await resolveTargetId(scopeKey, form.selectedStage, "target");
            // Persist the visible cycle so the scope row and its pipeline
            // exist together from the first targeting action. Pre-target
            // research (container row) is already in cycle 1 and carries over.
            const scope = current ? getScopeState(current, scopeKey) : defaultScopePipelineState();
            await savePipelineCycle(targetId, scope.activeCycle, form);
            await syncScopeStatus(targetId, form.selectedStage);
          });
        } else {
          runPersist(async () => {
            const targetId = targetIdsRef.current[scopeKey];
            if (targetId) await setScopeUntargeted(targetId);
          });
        }
      },

      patchActiveCycle: (scopeKey, patch) => {
        // activeCycle isn't changed by a cycle patch, so the pre-update
        // ref is a safe source for which cycle to mark dirty.
        const cycleNumber = stateRef.current
          ? getScopeState(stateRef.current, scopeKey).activeCycle
          : 1;
        setState((prev) => {
          if (!prev) return prev;
          const scope = getScopeState(prev, scopeKey);
          return patchCycleFormState(prev, scopeKey, scope.activeCycle, patch);
        });
        scheduleSave(scopeKey, cycleNumber);
      },

      selectStage: (scopeKey, stage) => {
        const cycleNumber = stateRef.current
          ? getScopeState(stateRef.current, scopeKey).activeCycle
          : 1;
        setState((prev) => {
          if (!prev) return prev;
          const scope = getScopeState(prev, scopeKey);
          return patchCycleFormState(prev, scopeKey, scope.activeCycle, (form) => ({
            ...form,
            selectedStage: stage,
          }));
        });
        scheduleSave(scopeKey, cycleNumber);
      },

      setActiveCycle: (scopeKey, cycle) => {
        setState((prev) => (prev ? patchScopeState(prev, scopeKey, { activeCycle: cycle }) : prev));
        runPersist(async () => {
          const targetId = targetIdsRef.current[scopeKey];
          if (targetId) {
            await setScopeActiveCycle(targetId, cycle);
            const current = stateRef.current;
            if (current) {
              const form = getScopeState(current, scopeKey).cycles[String(cycle)];
              if (form) await syncScopeStatus(targetId, form.selectedStage);
            }
          }
        });
      },

      startNextCycle: (scopeKey) => {
        const nextCycle = stateRef.current
          ? getScopeState(stateRef.current, scopeKey).cycleCount + 1
          : 2;
        setState((prev) => {
          if (!prev) return prev;
          const scope = getScopeState(prev, scopeKey);
          return patchScopeState(prev, scopeKey, {
            cycleCount: nextCycle,
            activeCycle: nextCycle,
            cycles: {
              ...scope.cycles,
              [String(nextCycle)]: defaultCycleFormState({ selectedStage: "researching" }),
            },
          });
        });
        runPersist(async () => {
          const targetId = await resolveTargetId(scopeKey);
          const form =
            stateRef.current?.scopes[scopeKey]?.cycles[String(nextCycle)] ?? defaultCycleFormState();
          await savePipelineCycle(targetId, nextCycle, form);
          await setScopeActiveCycle(targetId, nextCycle);
          await syncScopeStatus(targetId, form.selectedStage);
        });
      },

      deleteCycle: (scopeKey, cycle) => {
        // Flush pending edits first so DB cycle numbering matches the UI
        // before the renumbering RPC runs.
        void flush();
        setState((prev) => (prev ? deleteScopeCycle(prev, scopeKey, cycle) : prev));
        runPersist(async () => {
          const targetId = targetIdsRef.current[scopeKey];
          if (targetId) await deletePipelineCycle(targetId, cycle);
        });
      },
    }),
    [flush, resolveTargetId, runPersist, scheduleSave],
  );

  return { state, saveStatus, actions };
}

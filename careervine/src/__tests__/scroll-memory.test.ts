// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberScroll,
  recallScroll,
  forgetScroll,
  consumePopNavigation,
  setLastPopAtForTest,
} from "@/lib/scroll-memory";

/**
 * CAR-256. Two things have to be true for a restore to be correct rather than
 * merely possible: the position must belong to the view being restored (not
 * just the pathname), and the mount must actually be a return rather than a
 * fresh visit from the nav bar.
 */

beforeEach(() => {
  sessionStorage.clear();
  setLastPopAtForTest(0);
});

describe("scroll memory", () => {
  it("remembers and recalls a position for one view", () => {
    rememberScroll("/companies", "?status=applied", 1200);
    expect(recallScroll("/companies", "?status=applied")).toBe(1200);
  });

  it("keys by search, so a different filter set gets its own position", () => {
    // Restoring 1200px into a view filtered down to three rows lands past the
    // end of the document.
    rememberScroll("/companies", "?status=applied", 1200);
    expect(recallScroll("/companies", "?status=closed")).toBeNull();
  });

  it("overwrites rather than appending for the same view", () => {
    rememberScroll("/companies", "", 100);
    rememberScroll("/companies", "", 900);
    expect(recallScroll("/companies", "")).toBe(900);
  });

  it("caps stored entries, evicting oldest first", () => {
    // Every keystroke in the search box writes a new `search` string, so an
    // uncapped map collects one entry per prefix of everything ever typed.
    for (let i = 0; i < 25; i++) rememberScroll("/companies", `?q=${i}`, i + 1);
    expect(recallScroll("/companies", "?q=0")).toBeNull();
    expect(recallScroll("/companies", "?q=4")).toBeNull();
    expect(recallScroll("/companies", "?q=5")).toBe(6);
    expect(recallScroll("/companies", "?q=24")).toBe(25);
  });

  it("re-remembering an existing view refreshes its place in the eviction order", () => {
    rememberScroll("/companies", "?q=old", 10);
    for (let i = 0; i < 19; i++) rememberScroll("/companies", `?q=${i}`, i);
    // 20 entries, ?q=old is the oldest. Touch it, then push one more over.
    rememberScroll("/companies", "?q=old", 42);
    rememberScroll("/companies", "?q=new", 99);
    expect(recallScroll("/companies", "?q=old")).toBe(42);
  });

  it("keeps pathnames separate", () => {
    rememberScroll("/companies", "", 500);
    rememberScroll("/contacts", "", 700);
    expect(recallScroll("/companies", "")).toBe(500);
    forgetScroll("/companies");
    expect(recallScroll("/companies", "")).toBeNull();
    expect(recallScroll("/contacts", "")).toBe(700);
  });

  it("survives a corrupted stored value instead of throwing into a render", () => {
    sessionStorage.setItem("cv:scroll:/companies", "{not json");
    expect(recallScroll("/companies", "")).toBeNull();
    sessionStorage.setItem("cv:scroll:/companies", '{"shape":"wrong"}');
    expect(recallScroll("/companies", "")).toBeNull();
  });
});

describe("pop navigation signal", () => {
  it("is false with no pop, so a nav-bar visit never restores", () => {
    expect(consumePopNavigation(10_000)).toBe(false);
  });

  it("is true immediately after a pop", () => {
    setLastPopAtForTest(10_000);
    expect(consumePopNavigation(10_050)).toBe(true);
  });

  it("is consumed once, so one pop cannot restore two pages", () => {
    setLastPopAtForTest(10_000);
    expect(consumePopNavigation(10_050)).toBe(true);
    expect(consumePopNavigation(10_060)).toBe(false);
  });

  it("expires, so a pop nobody consumed cannot leak into a later forward nav", () => {
    setLastPopAtForTest(10_000);
    expect(consumePopNavigation(13_000)).toBe(false);
  });
});

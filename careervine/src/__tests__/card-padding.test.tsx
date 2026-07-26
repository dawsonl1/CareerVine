// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CardContent } from "@/components/ui/card";

/**
 * CAR-205: `CardContent`'s "did the caller supply their own padding" test.
 *
 * The rule it implements is that a caller-supplied padding REPLACES the default
 * instead of racing it, because Tailwind resolves by stylesheet order and not by
 * class-string order — so `px-6 pb-6 py-4` does not give the caller `py-4`.
 *
 * The first implementation was a substring test, `/\bp-\d/`, and it was wrong in
 * both directions. These cases are the two directions plus the ones that must
 * keep working:
 *
 *   - a VARIANT utility (`sm:p-8`) matched `\b` between `:` and `p` and
 *     suppressed the base padding at every width where the variant does not
 *     apply, leaving those widths with no padding at all;
 *   - `px-`/`py-` did not match at all, so ten live call sites emitted the
 *     default alongside their own and lost to it.
 *
 * Asserted on the class list rather than on computed style: jsdom ships no
 * Tailwind stylesheet, so a `getComputedStyle` assertion here would measure
 * nothing. What is under test is which utilities the component emits, which is
 * exactly what the class list holds.
 */

afterEach(cleanup);

function classesFor(className?: string): string[] {
  render(<CardContent className={className}>body</CardContent>);
  return screen.getByText("body").className.split(/\s+/).filter(Boolean);
}

describe("CardContent padding defaults", () => {
  it("applies both defaults when the caller supplies no padding", () => {
    expect(classesFor()).toEqual(expect.arrayContaining(["px-6", "pb-6"]));
  });

  it("keeps the defaults beside a caller's non-padding classes", () => {
    const classes = classesFor("flex items-center gap-3");
    expect(classes).toEqual(expect.arrayContaining(["px-6", "pb-6", "flex"]));
  });

  it("drops both defaults for a bare p-*", () => {
    const classes = classesFor("p-7");
    expect(classes).toContain("p-7");
    expect(classes).not.toContain("px-6");
    expect(classes).not.toContain("pb-6");
  });

  it("drops both defaults for an arbitrary-value p-*", () => {
    const classes = classesFor("p-[10px]");
    expect(classes).not.toContain("px-6");
    expect(classes).not.toContain("pb-6");
  });

  it("drops only px-6 for px-*, so the caller's horizontal padding wins", () => {
    // The live shape at company-card.tsx and outreach/page.tsx. Before the fix
    // this emitted `px-6` alongside `px-5`, and `.px-6` sits later in the sheet.
    const classes = classesFor("py-4 px-5");
    expect(classes).not.toContain("px-6");
    expect(classes).not.toContain("pb-6");
    expect(classes).toEqual(expect.arrayContaining(["py-4", "px-5"]));
  });

  it("drops only pb-6 for py-*, keeping the horizontal default", () => {
    // The empty-state cards. `.pb-6` sits after `.py-16`, so these rendered
    // 64px of top padding against 24px of bottom until this was fixed.
    const classes = classesFor("py-16 text-center");
    expect(classes).toContain("px-6");
    expect(classes).not.toContain("pb-6");
    expect(classes).toContain("py-16");
  });

  it("drops pb-6 for an explicit pb-*, which the default would otherwise outrank", () => {
    // Same family, so ordering is by value: `.pb-6` is emitted after `.pb-4`.
    const classes = classesFor("pb-4");
    expect(classes).not.toContain("pb-6");
    expect(classes).toContain("px-6");
  });

  it("keeps both defaults for pt-*, which conflicts with neither", () => {
    const classes = classesFor("pt-10");
    expect(classes).toEqual(expect.arrayContaining(["px-6", "pb-6", "pt-10"]));
  });

  it("keeps both defaults for pl-*/pr-*, which already win their own side", () => {
    // `.pl-*` and `.pr-*` are emitted after `.px-*`, so the caller's side wins
    // on its own. Suppressing `px-6` here would silently zero the OTHER side.
    const classes = classesFor("pl-2");
    expect(classes).toEqual(expect.arrayContaining(["px-6", "pb-6", "pl-2"]));
  });

  it("keeps both defaults for a variant-prefixed padding", () => {
    // The regression direction. `sm:p-8` applies only at >=sm; treating it as a
    // replacement left every narrower width with no padding at all.
    const classes = classesFor("sm:p-8");
    expect(classes).toEqual(expect.arrayContaining(["px-6", "pb-6", "sm:p-8"]));
  });

  it("treats an important-prefixed padding as the padding it is", () => {
    const classes = classesFor("!p-4");
    expect(classes).not.toContain("px-6");
    expect(classes).not.toContain("pb-6");
  });

  it("is not fooled by a non-padding class that starts with p", () => {
    const classes = classesFor("pointer-events-none place-items-center");
    expect(classes).toEqual(expect.arrayContaining(["px-6", "pb-6"]));
  });
});

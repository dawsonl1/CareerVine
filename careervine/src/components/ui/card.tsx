/**
 * M3 Card component
 *
 * Material Design 3 defines three card types:
 *   filled   → surface-container-highest (default)
 *   elevated → surface-container-low + shadow
 *   outlined → surface + outline border
 */

import { HTMLAttributes, forwardRef } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "filled" | "elevated" | "outlined";
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className = "", variant = "outlined", children, ...props }, ref) => {
    const variants: Record<string, string> = {
      filled:   "bg-surface-container-highest rounded-[12px]",
      elevated: "bg-surface-container-low rounded-[12px] shadow-md",
      outlined: "bg-background rounded-[12px] border border-outline-variant",
    };

    return (
      <div
        ref={ref}
        className={`${variants[variant]} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";

type CardHeaderProps = HTMLAttributes<HTMLDivElement>;

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`px-6 pt-6 pb-4 ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

CardHeader.displayName = "CardHeader";

type CardContentProps = HTMLAttributes<HTMLDivElement>;

/**
 * Which of `CardContent`'s two default utilities a caller's className overrides.
 *
 * A caller-supplied padding must REPLACE the default rather than race it
 * (CAR-191 review): `px-6 pb-6 p-7` is not resolved by class-string order,
 * Tailwind resolves by stylesheet order, so a caller asking for `p-7` got
 * whichever the sheet happened to emit last.
 *
 * The first attempt tested `/\bp-\d/` against the whole string and was wrong in
 * both directions (CAR-205):
 *
 *   - It matched VARIANT utilities. `\b` sits between `:` and `p`, so `sm:p-8`
 *     suppressed the base padding at every width below `sm`, where the variant
 *     does not apply and nothing replaces it. Latent — no call site does this
 *     today — but a padding rule that breaks on the next responsive card is not
 *     a rule.
 *   - It missed `px-`/`py-`, whose `p` is not followed by `-`. Ten live call
 *     sites therefore emitted `px-6 pb-6` alongside their own padding, and
 *     Tailwind v4 orders `p-*` → `px-*` → `py-*` → `pt-*` → `pb-*`, so the
 *     default's `pb-6` won over every one of their `py-*` and its `px-6` won
 *     over a `px-5`. Every `py-` caller rendered visibly asymmetric.
 *
 * Hence: tokens, not a substring; base utilities only; and per AXIS, because an
 * all-or-nothing answer would let `px-0` silently take `pb-6` away as well —
 * the same class of bug being fixed.
 *
 * Only the utilities the defaults actually LOSE to are suppressed. Measured
 * order in this app's built stylesheet is `px` → `py` → `pt` → `pr` → `pb` →
 * `pl`, so:
 *
 *   - `pt-*` does not touch padding-bottom, and `pl-*`/`pr-*`/`ps-*`/`pe-*` are
 *     emitted after `px-*` and already win their own side on their own. Leaving
 *     the default in place there is what lets `pl-2` alone keep the card's
 *     padding-right, instead of silently zeroing it.
 *   - `pb-*` IS suppressed even though it is the same family, because the order
 *     inside a family is by value: `.pb-6` sits after `.pb-4`, so a caller
 *     asking for `pb-4` would otherwise be overruled by the default.
 */
function overriddenSides(className: string): { x: boolean; y: boolean } {
  let x = false;
  let y = false;
  for (const raw of className.split(/\s+/)) {
    // A variant prefix (`sm:`, `hover:`, `group-hover:`) makes the utility
    // CONDITIONAL, so it cannot stand in for an unconditional default.
    if (!raw || raw.includes(":")) continue;
    // `!p-4` is the same utility at higher priority. Matched by shape rather
    // than by `\d`, so arbitrary values (`p-[10px]`) count too.
    const token = raw.startsWith("!") ? raw.slice(1) : raw;
    // No match at all (`pl-2`, `ps-4`, `pointer-events-none`) is distinct from a
    // match whose optional side group is empty (`p-7`), so test the match object
    // rather than the group — reading `?.[1]` alone conflates the two and drops
    // the bare `p-*` case this whole helper started out handling.
    const match = /^p([xytb])?-./.exec(token);
    if (!match) continue;
    const side = match[1];
    if (side === undefined) { x = true; y = true; }   // bare `p-*` → both axes
    else if (side === "x") x = true;
    else if (side === "y" || side === "b") y = true;
    // `pt-*` falls through on purpose: it cannot conflict with `pb-6`.
  }
  return { x, y };
}

export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(
  ({ className = "", children, ...props }, ref) => {
    const overridden = overriddenSides(className);
    const defaults = [overridden.x ? "" : "px-6", overridden.y ? "" : "pb-6"]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        ref={ref}
        className={`${defaults} ${className}`.trim()}
        {...props}
      >
        {children}
      </div>
    );
  }
);

CardContent.displayName = "CardContent";

type CardFooterProps = HTMLAttributes<HTMLDivElement>;

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`px-6 pb-6 pt-2 flex items-center gap-2 ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

CardFooter.displayName = "CardFooter";

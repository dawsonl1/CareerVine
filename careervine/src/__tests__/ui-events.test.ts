// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { UI_EVENTS, emitUiEvent, onUiEvent, unreadDeltaFor } from "@/lib/ui-events";

/**
 * CAR-145 / F18: the typed event bus is the single source of truth for the
 * cross-view CustomEvents and the unread-delta formula that used to be
 * duplicated across the inbox and contact views.
 */

describe("unreadDeltaFor", () => {
  it("decrements only for unread inbound mail", () => {
    expect(unreadDeltaFor({ is_read: false, direction: "inbound" })).toBe(-1);
  });
  it("is a no-op for already-read inbound mail", () => {
    expect(unreadDeltaFor({ is_read: true, direction: "inbound" })).toBe(0);
  });
  it("is a no-op for outbound mail", () => {
    expect(unreadDeltaFor({ is_read: false, direction: "outbound" })).toBe(0);
  });
  it("is a no-op when direction is null", () => {
    expect(unreadDeltaFor({ is_read: false, direction: null })).toBe(0);
  });
});

describe("emitUiEvent / onUiEvent", () => {
  it("delivers the typed detail to a subscriber", () => {
    const handler = vi.fn();
    const off = onUiEvent(UI_EVENTS.unreadChanged, handler);
    emitUiEvent(UI_EVENTS.unreadChanged, { delta: -1 });
    expect(handler).toHaveBeenCalledWith({ delta: -1 });
    off();
  });

  it("delivers a payload-less event once, with no detail", () => {
    const handler = vi.fn();
    const off = onUiEvent(UI_EVENTS.conversationLogged, handler);
    emitUiEvent(UI_EVENTS.conversationLogged);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBeNull();
    off();
  });

  it("stops delivering after the returned unsubscribe runs", () => {
    const handler = vi.fn();
    const off = onUiEvent(UI_EVENTS.emailSent, handler);
    off();
    emitUiEvent(UI_EVENTS.emailSent, { onboardingIntro: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("only fires the handler for its own event name", () => {
    const handler = vi.fn();
    const off = onUiEvent(UI_EVENTS.draftsChanged, handler);
    emitUiEvent(UI_EVENTS.emailSent, { onboardingIntro: false });
    expect(handler).not.toHaveBeenCalled();
    off();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { isChromeLike } from "@/lib/browser-detect";

const UAS = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
};

function setUA(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  // jsdom has no userAgentData; the UA fallback is what's under test.
  Object.defineProperty(window.navigator, "userAgentData", { value: undefined, configurable: true });
}

const realUA = navigator.userAgent;
afterEach(() => setUA(realUA));

describe("isChromeLike (CAR-68)", () => {
  it("accepts desktop Chromium browsers (they can install from the Chrome Web Store)", () => {
    setUA(UAS.chromeMac);
    expect(isChromeLike()).toBe(true);
    setUA(UAS.edgeWin);
    expect(isChromeLike()).toBe(true);
  });

  it("rejects Firefox and Safari", () => {
    setUA(UAS.firefox);
    expect(isChromeLike()).toBe(false);
    setUA(UAS.safari);
    expect(isChromeLike()).toBe(false);
  });

  it("rejects mobile browsers even when Chromium-based", () => {
    setUA(UAS.chromeAndroid);
    expect(isChromeLike()).toBe(false);
    setUA(UAS.chromeIos);
    expect(isChromeLike()).toBe(false);
  });
});

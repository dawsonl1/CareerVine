/**
 * Chromium-family detection (CAR-68). The extension onboarding needs Chrome —
 * or any Chromium browser that can install from the Chrome Web Store (Edge,
 * Brave, Opera, Arc all can). Firefox/Safari/mobile get "requires Chrome"
 * copy instead of a broken store link.
 */
export function isChromeLike(): boolean {
  if (typeof navigator === "undefined") return false;

  // Mobile browsers can't install extensions even when Chromium-based.
  const ua = navigator.userAgent;
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) return false;

  // Modern Chromium ships userAgentData with a Chromium brand entry.
  const uaData = (navigator as Navigator & {
    userAgentData?: { brands?: { brand: string }[] };
  }).userAgentData;
  if (uaData?.brands?.some((b) => /Chromium|Google Chrome/i.test(b.brand))) return true;

  // Fallback: UA sniff — Chrome token without the non-Chromium impostors.
  return /Chrome\//.test(ua) && !/Firefox|FxiOS|Seamonkey/i.test(ua);
}

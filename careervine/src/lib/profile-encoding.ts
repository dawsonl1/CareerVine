/**
 * Unicode-safe base64 encoding/decoding for profile data in URL hashes.
 * Used by the Chrome extension (encode) and the preview page (decode).
 * Extracted for testability.
 */

/** Encode a profile data object to a URL-safe base64 string. */
export function encodeProfileData(data: Record<string, any>): string {
  const jsonStr = JSON.stringify(data);
  const bytes = new TextEncoder().encode(jsonStr);
  const binStr = Array.from(bytes, (b: number) => String.fromCharCode(b)).join('');
  return encodeURIComponent(btoa(binStr));
}

/** Decode a URL-safe base64 string back to a profile data object. */
export function decodeProfileData(encoded: string): Record<string, any> {
  const binStr = atob(decodeURIComponent(encoded));
  const bytes = Uint8Array.from(binStr, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

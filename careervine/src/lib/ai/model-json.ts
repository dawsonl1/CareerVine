/**
 * Defensive JSON parsing for model output (CAR-143, R5.4).
 *
 * Even with response_format json_schema, a response can be truncated
 * (max_tokens), empty, or — on providers/models that downgrade the format —
 * shaped differently than requested. Feature code must degrade, never throw.
 */

/**
 * Parse model output as JSON, returning null instead of throwing on missing,
 * empty, or malformed content. Callers still validate the shape of the result.
 */
export function parseModelJson(content: string | null | undefined): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

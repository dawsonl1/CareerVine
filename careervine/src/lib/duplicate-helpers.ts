/**
 * Shared helpers for duplicate contact detection.
 * Extracted for testability.
 */

/** Calculate confidence score for a name match (0-90 scale). */
export function calculateNameMatchConfidence(searchName: string, existingName: string): number {
  const searchNames = searchName.toLowerCase().split(' ').filter(n => n.length > 1);
  const existingNames = existingName.toLowerCase().split(' ').filter(n => n.length > 1);

  let matches = 0;

  searchNames.forEach(sn => {
    if (existingNames.some(en =>
      en.includes(sn) || sn.includes(en)
    )) {
      matches++;
    }
  });

  // Calculate confidence based on name part matches
  const confidence = (matches / Math.max(searchNames.length, existingNames.length)) * 80;

  // Bonus for exact matches
  if (searchName.toLowerCase() === existingName.toLowerCase()) {
    return Math.min(confidence + 20, 90); // Cap at 90 for name-only matches
  }

  return confidence;
}

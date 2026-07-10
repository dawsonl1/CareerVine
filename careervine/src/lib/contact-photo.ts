export const MAX_CONTACT_PHOTO_BYTES = 5 * 1024 * 1024;

export const ALLOWED_CONTACT_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export function validateContactPhotoFile(file: File): string | null {
  if (!ALLOWED_CONTACT_PHOTO_TYPES.includes(file.type as (typeof ALLOWED_CONTACT_PHOTO_TYPES)[number])) {
    return "Please upload a JPG, PNG, WebP, or GIF image.";
  }

  if (file.size > MAX_CONTACT_PHOTO_BYTES) {
    return "Photo must be 5MB or smaller.";
  }

  return null;
}

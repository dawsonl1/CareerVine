/**
 * Contact-photo thumbnailing (CAR-35). Every photo the app stores — manual
 * uploads, import mirrors, bundle mirrors — is downscaled to a small WebP
 * before it reaches R2. Largest avatar render is 64px (w-16) at 2x retina,
 * so 256px leaves headroom for the profile-card view while turning a
 * ~160 KB LinkedIn original into a ~5–15 KB thumbnail. Supabase-style
 * on-the-fly transforms are a paid feature; resizing at write time is the
 * free-plan architecture and what keeps egress flat.
 */

import sharp from "sharp";

export const PHOTO_THUMB_PX = 256;
export const PHOTO_THUMB_QUALITY = 75;

/**
 * Decode any supported image (JPEG/PNG/WebP/GIF — first frame), auto-rotate
 * per EXIF, center-crop to a square, and re-encode as WebP. Throws on
 * undecodable input — callers treat that as an invalid image.
 */
export async function makePhotoThumb(input: ArrayBuffer | Uint8Array): Promise<Buffer> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return sharp(bytes)
    .rotate()
    .resize(PHOTO_THUMB_PX, PHOTO_THUMB_PX, { fit: "cover", withoutEnlargement: false })
    .webp({ quality: PHOTO_THUMB_QUALITY })
    .toBuffer();
}

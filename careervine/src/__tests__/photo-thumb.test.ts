import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { makePhotoThumb, PHOTO_THUMB_PX } from "@/lib/photo-thumb";

async function makeSourceImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe("makePhotoThumb", () => {
  it("center-crops to a square WebP at the thumb size", async () => {
    const source = await makeSourceImage(800, 600);
    const thumb = await makePhotoThumb(source);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(PHOTO_THUMB_PX);
    expect(meta.height).toBe(PHOTO_THUMB_PX);
  });

  it("shrinks a full-res LinkedIn-sized photo by an order of magnitude", async () => {
    // Noise compresses worst-case; a real 800×800 profile photo does better.
    const noise = Buffer.alloc(800 * 800 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
    const source = await sharp(noise, { raw: { width: 800, height: 800, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const thumb = await makePhotoThumb(source);
    expect(thumb.length).toBeLessThan(source.length / 4);
  });

  it("accepts ArrayBuffer input (fetch responses)", async () => {
    const source = await makeSourceImage(64, 64);
    const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    const thumb = await makePhotoThumb(arrayBuffer as ArrayBuffer);
    expect((await sharp(thumb).metadata()).format).toBe("webp");
  });

  it("throws on bytes that aren't a decodable image", async () => {
    await expect(makePhotoThumb(Buffer.from("<html>not an image</html>"))).rejects.toThrow();
  });
});

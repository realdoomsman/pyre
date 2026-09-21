import { describe, expect, it } from "vitest";
import { ALLOWED_IMAGE_MIME, sniffImageMime } from "../src/routes/uploads.js";

/**
 * `sniffImageMime` is the upload gate's real defense: the coin-image endpoint trusts the sniffed type,
 * not the client's Content-Type header, so a mislabeled or corrupt body is rejected before it costs an
 * IPFS pin and becomes the coin's public logo on PONS. A regression here either turns away a
 * legitimate logo or lets a non-image (e.g. an SVG carrying script) through under an image content-type.
 */

// Real leading magic bytes for each accepted format.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBP", "latin1")]);

describe("sniffImageMime", () => {
  it("identifies each accepted format by its magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("returns null for bodies that are not an accepted image", () => {
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageMime(Buffer.from("hello, world"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    // A GIF header truncated below the bytes the sniff inspects must not match.
    expect(sniffImageMime(Buffer.from([0x47, 0x49]))).toBeNull();
  });

  it("does not mistake a non-WEBP RIFF container (e.g. WAV) for an image", () => {
    const wav = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WAVE", "latin1")]);
    expect(sniffImageMime(wav)).toBeNull();
  });
});

describe("ALLOWED_IMAGE_MIME", () => {
  it("permits only renderable raster types and never SVG", () => {
    expect(Object.keys(ALLOWED_IMAGE_MIME).sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
    expect(ALLOWED_IMAGE_MIME["image/svg+xml"]).toBeUndefined();
  });
});

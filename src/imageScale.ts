import { logger } from './logger.js';

/** Hard byte cap for an uploaded image document. Without a decoder we can't shrink an oversized document, so the caller rejects it outright instead of spending vision tokens on it. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_MIME_TYPES.has(mime.toLowerCase());
}

/**
 * Picks the best Telegram PhotoSize for OCR: Telegram already renders each
 * upload at several resolutions, so this is the REAL downscale path (not
 * downscaleImage below, which cannot resize). Prefers the smallest variant
 * that still clears maxDimension >= 900px (enough to read digits off a
 * bank-app screenshot) while staying at/under maxDimension; falls back to
 * the smallest variant when every one exceeds maxDimension, or the largest
 * when every one is below the legibility floor.
 */
export function pickPhotoSize<T extends { width: number; height: number; file_size?: number }>(
  sizes: readonly T[],
  maxDimension = 1280,
): T | null {
  if (sizes.length === 0) return null;

  const byMaxSide = [...sizes].sort(
    (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
  );

  const legibleAndBounded = byMaxSide.filter((s) => {
    const side = Math.max(s.width, s.height);
    return side >= 900 && side <= maxDimension;
  });
  if (legibleAndBounded.length > 0) return legibleAndBounded[0];

  const allBounded = byMaxSide.every((s) => Math.max(s.width, s.height) <= maxDimension);
  if (allBounded) return byMaxSide[byMaxSide.length - 1]; // all below the legibility floor: take the largest

  return byMaxSide[0]; // everything exceeds maxDimension: take the smallest to bound cost
}

/** Parses PNG IHDR / JPEG SOFn markers directly from header bytes — no decoder dependency, just enough to read the pixel dimensions. Returns null for anything else or malformed input. */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (isPng(bytes)) return readPngDimensions(bytes);
  if (isJpeg(bytes)) return readJpegDimensions(bytes);
  return null;
}

function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < sig.length + 24) return false;
  return sig.every((byte, i) => bytes[i] === byte);
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, 4-byte 'IHDR', then width/height as big-endian u32.
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Walks JPEG markers looking for a Start-Of-Frame segment (SOF0-SOF15, excluding the DHT/JPG-extension marker numbers), which carries the pixel dimensions. */
function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Standalone markers (no length/payload) to skip over.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = view.getUint16(offset + 2);
    const isSofMarker =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSofMarker) {
      if (offset + 9 > bytes.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * Best-effort downscale for a full-resolution image *document* upload (as
 * opposed to a Telegram *photo*, which already arrives pre-scaled — see
 * pickPhotoSize). We deliberately do NOT ship an image decoder/resizer
 * (e.g. sharp) here: it breaks the alpine Docker build. So when an image
 * exceeds maxDimension we cannot shrink it — we log and return it
 * unchanged. The caller MUST enforce MAX_IMAGE_BYTES and reject oversized
 * documents outright rather than silently paying full-resolution vision
 * tokens for them.
 */
export async function downscaleImage(
  bytes: Uint8Array,
  mimeType: string,
  maxDimension = 1280,
): Promise<{ data: Uint8Array; mediaType: string }> {
  const dimensions = readImageDimensions(bytes);
  if (dimensions && Math.max(dimensions.width, dimensions.height) <= maxDimension) {
    return { data: bytes, mediaType: mimeType };
  }

  logger.warn('image_downscale_unavailable', {
    mimeType,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    byteLength: bytes.length,
  });
  return { data: bytes, mediaType: mimeType };
}

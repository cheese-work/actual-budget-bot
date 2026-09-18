import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPhotoSize,
  readImageDimensions,
  downscaleImage,
  isSupportedImageMime,
  MAX_IMAGE_BYTES,
} from './imageScale.js';

// --- pickPhotoSize ---

test('empty array -> null', () => {
  assert.equal(pickPhotoSize([]), null);
});

test('picks the smallest variant that clears the 900px legibility floor and stays under maxDimension', () => {
  const sizes = [
    { width: 90, height: 60 },
    { width: 320, height: 213 },
    { width: 960, height: 640 },
    { width: 1600, height: 1067 },
  ];
  const picked = pickPhotoSize(sizes);
  assert.deepEqual(picked, { width: 960, height: 640 });
});

test('all variants below the 900px legibility floor -> picks the largest', () => {
  const sizes = [
    { width: 90, height: 60 },
    { width: 320, height: 213 },
    { width: 640, height: 427 },
  ];
  const picked = pickPhotoSize(sizes);
  assert.deepEqual(picked, { width: 640, height: 427 });
});

test('every variant exceeds maxDimension -> picks the smallest to bound cost', () => {
  const sizes = [
    { width: 2000, height: 1333 },
    { width: 4000, height: 2667 },
  ];
  const picked = pickPhotoSize(sizes, 1280);
  assert.deepEqual(picked, { width: 2000, height: 1333 });
});

test('a single in-range variant is returned regardless of order', () => {
  const sizes = [
    { width: 1600, height: 1067 },
    { width: 1024, height: 683 },
    { width: 90, height: 60 },
  ];
  const picked = pickPhotoSize(sizes, 1280);
  assert.deepEqual(picked, { width: 1024, height: 683 });
});

// --- readImageDimensions ---

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  bytes.set(sig, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // chunk length (unused by our parser)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegHeaderWithSof0(width: number, height: number): Uint8Array {
  // SOI, then an APP0 segment we skip over, then SOF0 carrying dimensions.
  const bytes = new Uint8Array(30);
  let offset = 0;
  bytes[offset++] = 0xff;
  bytes[offset++] = 0xd8; // SOI

  bytes[offset++] = 0xff;
  bytes[offset++] = 0xe0; // APP0
  const app0Start = offset;
  const view = new DataView(bytes.buffer);
  view.setUint16(offset, 8); // segment length (includes the length field itself)
  offset += 8;
  void app0Start;

  bytes[offset++] = 0xff;
  bytes[offset++] = 0xc0; // SOF0
  const sofStart = offset;
  view.setUint16(offset, 8); // segment length
  offset += 2;
  bytes[offset++] = 8; // precision
  view.setUint16(offset, height);
  offset += 2;
  view.setUint16(offset, width);
  offset += 2;
  void sofStart;

  return bytes;
}

test('reads PNG width/height from the IHDR chunk', () => {
  const bytes = pngHeader(800, 600);
  assert.deepEqual(readImageDimensions(bytes), { width: 800, height: 600 });
});

test('reads JPEG width/height from the SOF0 marker, skipping preceding segments', () => {
  const bytes = jpegHeaderWithSof0(1024, 768);
  assert.deepEqual(readImageDimensions(bytes), { width: 1024, height: 768 });
});

test('unrecognized bytes -> null', () => {
  assert.equal(readImageDimensions(new Uint8Array([1, 2, 3, 4])), null);
});

test('empty input -> null', () => {
  assert.equal(readImageDimensions(new Uint8Array([])), null);
});

// --- downscaleImage ---

test('image already within maxDimension is returned unchanged', async () => {
  const bytes = pngHeader(800, 600);
  const result = await downscaleImage(bytes, 'image/png', 1280);
  assert.equal(result.data, bytes);
  assert.equal(result.mediaType, 'image/png');
});

test('oversized image cannot be resized without a decoder -- returned unchanged (caller enforces the byte cap)', async () => {
  const bytes = pngHeader(4000, 3000);
  const result = await downscaleImage(bytes, 'image/png', 1280);
  assert.equal(result.data, bytes);
  assert.equal(result.mediaType, 'image/png');
});

test('undecodable bytes are returned unchanged rather than throwing', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const result = await downscaleImage(bytes, 'image/jpeg', 1280);
  assert.equal(result.data, bytes);
});

// --- isSupportedImageMime / MAX_IMAGE_BYTES ---

test('supports jpeg, png, webp; rejects everything else', () => {
  assert.equal(isSupportedImageMime('image/jpeg'), true);
  assert.equal(isSupportedImageMime('image/png'), true);
  assert.equal(isSupportedImageMime('image/webp'), true);
  assert.equal(isSupportedImageMime('image/gif'), false);
  assert.equal(isSupportedImageMime('application/pdf'), false);
});

test('MAX_IMAGE_BYTES is 4MB', () => {
  assert.equal(MAX_IMAGE_BYTES, 4 * 1024 * 1024);
});

/**
 * D-08/R3 — server-side OCR image validation.
 *
 * Decodes the ACTUAL image bytes (not the MIME prefix) to establish format and
 * dimensions, and enforces hard bounds to prevent decompression/resource
 * exhaustion. The validated data URL is the exact representation sent to the
 * provider, so the token bound is computed against the same bytes.
 */

export interface DecodedOcrImage {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** The canonical data URL forwarded to the provider (unchanged bytes). */
  dataUrl: string;
}

export const OCR_MAX_DIMENSION = 8000;
export const OCR_MAX_PIXELS = 40_000_000;
export const OCR_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function decodePng(buf: Buffer): { width: number; height: number } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) fail('OCR_IMAGE_MALFORMED', 'Malformed PNG image');
  // IHDR must be the first chunk: length(4)=13, type(4)='IHDR'.
  if (buf.toString('ascii', 12, 16) !== 'IHDR') fail('OCR_IMAGE_MALFORMED', 'Malformed PNG image');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function decodeJpeg(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) fail('OCR_IMAGE_MALFORMED', 'Malformed JPEG image');
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // Standalone markers without length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return { width, height };
    }
    off += 2 + len;
  }
  fail('OCR_IMAGE_MALFORMED', 'Malformed JPEG image');
}

export function decodeOcrImage(dataUrl: string): DecodedOcrImage {
  if (!dataUrl || !/^data:image\//.test(dataUrl)) fail('OCR_IMAGE_REQUIRED', 'A valid image is required');
  if (dataUrl.length > OCR_MAX_PAYLOAD_BYTES) fail('OCR_IMAGE_TOO_LARGE', 'Image is too large');
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) fail('OCR_IMAGE_MALFORMED', 'Malformed image data');
  const mime = m[1].toLowerCase();
  let buf: Buffer;
  try { buf = Buffer.from(m[2], 'base64'); }
  catch { fail('OCR_IMAGE_MALFORMED', 'Malformed image data'); }
  if (buf.length === 0) fail('OCR_IMAGE_MALFORMED', 'Malformed image data');

  let format: 'png' | 'jpeg';
  let dims: { width: number; height: number };
  if (mime === 'image/png') { format = 'png'; dims = decodePng(buf); }
  else if (mime === 'image/jpeg' || mime === 'image/jpg') { format = 'jpeg'; dims = decodeJpeg(buf); }
  else fail('OCR_IMAGE_UNSUPPORTED', 'Unsupported image format');

  const { width, height } = dims;
  if (width <= 0 || height <= 0) fail('OCR_IMAGE_MALFORMED', 'Malformed image dimensions');
  if (width > OCR_MAX_DIMENSION || height > OCR_MAX_DIMENSION) fail('OCR_IMAGE_TOO_LARGE', 'Image dimensions exceed the limit');
  if (width * height > OCR_MAX_PIXELS) fail('OCR_IMAGE_TOO_LARGE', 'Image pixel count exceeds the limit');

  return { format, width, height, dataUrl };
}
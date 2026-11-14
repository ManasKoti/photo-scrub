/**
 * Lossless WebP metadata removal.
 *
 * A WebP file is a RIFF container: "RIFF" [size] "WEBP", then chunks of
 *   [type: 4 letters][size: 4 bytes, little-endian][data][pad byte if odd]
 * Image data lives in VP8 / VP8L (+ ALPH for transparency, ANIM/ANMF for
 * animation). Metadata lives in "EXIF" and "XMP " chunks. Files that carry
 * metadata also have a "VP8X" header chunk with flags saying which optional
 * chunks exist, so we update those flags too.
 */

import { asciiAt, concat, startsWithAscii } from './bytes';
import { cleanExif, EXIF_HEADER, isOrientationOnly } from './exif';
import { RemovalTally, type StripOptions, type StripResult } from './types';

const KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

export const WEBP_LABELS: Record<string, string> = {
  exif: 'EXIF data (GPS location, phone model, date & time, camera settings)',
  xmp: 'XMP data (editing history, location, device info)',
  icc: 'Colour profile',
  other: 'Other embedded data',
  trailer: 'Hidden data after the image',
};

export class WebpError extends Error {}

export interface WebpChunk {
  type: string;
  offset: number;
  /** Total size including header and padding. */
  length: number;
  dataOffset: number;
  dataLength: number;
}

export function parseWebp(b: Uint8Array): { chunks: WebpChunk[]; end: number } {
  if (!startsWithAscii(b, 0, 'RIFF') || !startsWithAscii(b, 8, 'WEBP')) throw new WebpError('Not a WebP file.');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = Math.min(8 + view.getUint32(4, true), b.length);
  const chunks: WebpChunk[] = [];
  let pos = 12;
  while (pos + 8 <= end) {
    const type = asciiAt(b, pos, 4);
    const dataLength = view.getUint32(pos + 4, true);
    const length = 8 + dataLength + (dataLength & 1);
    if (pos + 8 + dataLength > end) throw new WebpError('Corrupt WebP: a chunk runs past the end of the file.');
    chunks.push({ type, offset: pos, length: Math.min(length, end - pos), dataOffset: pos + 8, dataLength });
    pos += length;
  }
  return { chunks, end };
}

function kindOf(type: string): string {
  if (type === 'EXIF') return 'exif';
  if (type === 'XMP ') return 'xmp';
  if (type === 'ICCP') return 'icc';
  return 'other';
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/** WebP EXIF chunks hold bare TIFF data, but some writers add "Exif\0\0". */
function exifTiff(b: Uint8Array, c: WebpChunk): Uint8Array {
  const data = b.subarray(c.dataOffset, c.dataOffset + c.dataLength);
  return startsWithAscii(data, 0, 'Exif\0\0') ? data.subarray(EXIF_HEADER.length) : data;
}

export function stripWebp(b: Uint8Array, opts: StripOptions = {}): StripResult {
  const keepOrientation = opts.keepOrientation ?? true;
  const keepColorProfile = opts.keepColorProfile ?? true;
  const { chunks, end } = parseWebp(b);
  const tally = new RemovalTally(WEBP_LABELS);
  const kept: Uint8Array[] = [];
  const keep = opts.keep ?? new Set();
  let vp8x: Uint8Array | undefined;
  let orientation: number | undefined;
  let newExif: Uint8Array | null = null;
  let hasIcc = false;

  for (const c of chunks) {
    const bytes = b.slice(c.offset, c.offset + c.length);
    if (c.type === 'VP8X') {
      vp8x = bytes;
      kept.push(bytes);
    } else if (KEEP.has(c.type)) {
      kept.push(bytes);
    } else if (c.type === 'ICCP' && keepColorProfile) {
      kept.push(bytes);
      hasIcc = true;
    } else {
      tally.add(kindOf(c.type), c.length);
      if (c.type === 'EXIF' && newExif === null) {
        const clean = cleanExif(exifTiff(b, c), keep, keepOrientation);
        newExif = clean.tiff;
        orientation = clean.orientation;
      }
    }
  }

  // EXIF is only allowed in the extended (VP8X) format.
  if (!vp8x) {
    newExif = null;
    orientation = undefined;
  }
  if (newExif) {
    const chunk = makeChunk('EXIF', newExif);
    kept.push(chunk); // EXIF belongs after the image data
    tally.add('exif', -chunk.length);
  }

  if (vp8x && vp8x.length > 8) {
    let flags = (vp8x[8] ?? 0) & ~(FLAG_EXIF | FLAG_XMP | FLAG_ICC);
    if (hasIcc) flags |= FLAG_ICC;
    if (newExif) flags |= FLAG_EXIF;
    vp8x[8] = flags;
  }

  if (end < b.length) tally.add('trailer', b.length - end);

  const body = concat(kept);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return { output: concat([header, body]), removed: tally.items(), orientation, warnings: [] };
}

export function findWebpMetadata(b: Uint8Array): string[] {
  const { chunks, end } = parseWebp(b);
  const found: string[] = [];
  for (const c of chunks) {
    if (KEEP.has(c.type) || c.type === 'ICCP') continue;
    if (c.type === 'EXIF') {
      found.push(isOrientationOnly(exifTiff(b, c)) ? 'orientation-only' : 'exif');
      continue;
    }
    found.push(kindOf(c.type));
  }
  if (end < b.length) found.push('trailer');
  return found;
}

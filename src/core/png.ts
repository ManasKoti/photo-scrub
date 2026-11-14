/**
 * Lossless PNG metadata removal.
 *
 * A PNG is an 8-byte signature followed by "chunks":
 *   [length: 4 bytes][type: 4 letters][data][CRC: 4 bytes]
 * The picture lives in IHDR/PLTE/IDAT (and a few colour/transparency
 * chunks). Metadata lives in text chunks (tEXt, zTXt, iTXt, which also
 * carries XMP), eXIf (EXIF, same as in JPEGs) and tIME (last-modified time).
 *
 * We keep a whitelist of chunks needed to draw the picture correctly and
 * drop everything else, so the image data is untouched.
 */

import { asciiAt, concat, startsWithAscii } from './bytes';
import { crc32 } from './crc32';
import { categorizeName } from './categories';
import { cleanExif, EXIF_HEADER, isOrientationOnly } from './exif';
import type { KeepSet } from './categories';
import { RemovalTally, type StripOptions, type StripResult } from './types';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks needed to display the image exactly as before. */
const KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', // core image
  'tRNS', // transparency
  'gAMA', 'cHRM', 'sRGB', 'sBIT', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi', // colour / HDR
  'pHYs', 'bKGD', 'hIST', 'sPLT', // display hints
  'acTL', 'fcTL', 'fdAT', // animation (APNG)
]);

export const PNG_LABELS: Record<string, string> = {
  exif: 'EXIF data (GPS location, phone model, date & time, camera settings)',
  xmp: 'XMP data (editing history, location, device info)',
  text: 'Text notes (software, author, creation time, comments)',
  time: 'Last-modified timestamp',
  c2pa: 'Content credentials (C2PA)',
  icc: 'Colour profile',
  other: 'Other embedded data',
  trailer: 'Hidden data after the image',
};

export class PngError extends Error {}

export interface PngChunk {
  type: string;
  /** Offset of the chunk's length field. */
  offset: number;
  /** Total chunk size: 12 + data length. */
  length: number;
  dataOffset: number;
  dataLength: number;
}

export function parsePng(b: Uint8Array): { chunks: PngChunk[]; end: number } {
  if (b.length < 8 || !SIGNATURE.every((v, i) => b[i] === v)) throw new PngError('Not a PNG file.');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos + 12 <= b.length) {
    const dataLength = view.getUint32(pos);
    const type = asciiAt(b, pos + 4, 4);
    const length = 12 + dataLength;
    if (pos + length > b.length) throw new PngError('Corrupt PNG: a chunk runs past the end of the file.');
    chunks.push({ type, offset: pos, length, dataOffset: pos + 8, dataLength });
    pos += length;
    if (type === 'IEND') return { chunks, end: pos };
  }
  return { chunks, end: -1 };
}

/** What a chunk we remove contains, for the "removed" report. */
function kindOf(b: Uint8Array, c: PngChunk): string {
  switch (c.type) {
    case 'eXIf': return 'exif';
    case 'iTXt': return startsWithAscii(b, c.dataOffset, 'XML:com.adobe.xmp\0') ? 'xmp' : 'text';
    case 'tEXt':
    case 'zTXt': return 'text';
    case 'tIME': return 'time';
    case 'caBX': return 'c2pa';
    case 'iCCP': return 'icc';
    default: return 'other';
  }
}

/** A chunk type whose first letter is upper case is "critical": decoders need it. */
const isCritical = (type: string) => type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;

export function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The eXIf chunk holds bare TIFF data, though some writers add "Exif\0\0". */
function exifTiff(b: Uint8Array, c: PngChunk): Uint8Array {
  const data = b.subarray(c.dataOffset, c.dataOffset + c.dataLength);
  return startsWithAscii(data, 0, 'Exif\0\0') ? data.subarray(EXIF_HEADER.length) : data;
}

/** PNG text notes and timestamps the user chose to keep (e.g. "Creation Time"). */
function keptText(b: Uint8Array, c: PngChunk, keep: KeepSet): boolean {
  if (keep.size === 0) return false;
  if (c.type === 'tIME') return keep.has('time');
  if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') return false;
  if (kindOf(b, c) === 'xmp') return false;
  const data = b.subarray(c.dataOffset, c.dataOffset + c.dataLength);
  const nul = data.indexOf(0);
  if (nul < 1) return false;
  const cat = categorizeName('PNG text', asciiAt(data, 0, nul));
  return cat !== 'other' && keep.has(cat);
}

export function stripPng(b: Uint8Array, opts: StripOptions = {}): StripResult {
  const keepOrientation = opts.keepOrientation ?? true;
  const keepColorProfile = opts.keepColorProfile ?? true;
  const { chunks, end } = parsePng(b);
  const tally = new RemovalTally(PNG_LABELS);
  const warnings: string[] = [];
  const parts: Uint8Array[] = [b.slice(0, 8)];
  const keep = opts.keep ?? new Set();
  let orientation: number | undefined;
  let exifWritten = false;

  for (const c of chunks) {
    if (KEEP.has(c.type) || (c.type === 'iCCP' && keepColorProfile) || keptText(b, c, keep)) {
      parts.push(b.slice(c.offset, c.offset + c.length));
      continue;
    }
    if (isCritical(c.type)) {
      // Unknown critical chunk: removing it could break the image, so keep it.
      parts.push(b.slice(c.offset, c.offset + c.length));
      warnings.push(`Kept an unrecognised "${c.type}" block because the image may need it.`);
      continue;
    }
    tally.add(kindOf(b, c), c.length);
    if (c.type === 'eXIf' && !exifWritten) {
      const clean = cleanExif(exifTiff(b, c), keep, keepOrientation);
      if (clean.tiff) {
        const chunk = makeChunk('eXIf', clean.tiff);
        parts.push(chunk);
        tally.add('exif', -chunk.length);
        orientation = clean.orientation;
      }
      exifWritten = true;
    }
  }

  if (end === -1) {
    warnings.push('The file looked cut off (no end marker). The clean copy was repaired, but check it opens correctly.');
    parts.push(makeChunk('IEND', new Uint8Array(0)));
  } else if (end < b.length) {
    tally.add('trailer', b.length - end);
  }

  return { output: concat(parts), removed: tally.items(), orientation, warnings };
}

/** List metadata still present in a PNG ('orientation-only' for our own minimal eXIf). */
export function findPngMetadata(b: Uint8Array): string[] {
  const { chunks, end } = parsePng(b);
  const found: string[] = [];
  for (const c of chunks) {
    if (KEEP.has(c.type) || c.type === 'iCCP' || isCritical(c.type)) continue;
    if (c.type === 'eXIf') {
      found.push(isOrientationOnly(exifTiff(b, c)) ? 'orientation-only' : 'exif');
      continue;
    }
    found.push(kindOf(b, c));
  }
  if (end !== -1 && end < b.length) found.push('trailer');
  return found;
}

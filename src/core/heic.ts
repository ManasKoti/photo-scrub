/**
 * HEIC / HEIF support (the default photo format on iPhones).
 *
 * Most browsers can't display HEIC, and many websites reject it, so instead
 * of editing the file we decode the picture and save it as a high-quality
 * JPEG. That drops every bit of metadata by itself; anything the user chose
 * to keep is then copied across from the original's EXIF.
 *
 * HEIC files are made of "boxes" (ISO-BMFF, like MP4). Metadata such as EXIF
 * and XMP are stored as "items": `iinf` says which item is which, and `iloc`
 * says where each item's bytes are in the file.
 */

import { asciiAt, concat, startsWithAscii } from './bytes';
import type { KeepSet } from './categories';
import { cleanExif, EXIF_HEADER } from './exif';
import { parseJpeg } from './jpeg';
import type { StripResult } from './types';

interface Box {
  type: string;
  /** Start of the box's content (after the size/type header). */
  start: number;
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = asciiAt(b, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function find(b: Uint8Array, start: number, end: number, type: string): Box | undefined {
  for (const box of boxes(b, start, end)) if (box.type === type) return box;
  return undefined;
}

export interface HeicMetadata {
  /** EXIF as bare TIFF bytes. */
  exif?: Uint8Array;
  xmp?: Uint8Array;
}

/** Find the EXIF and XMP items inside a HEIC file. Never throws. */
export function readHeicMetadata(b: Uint8Array): HeicMetadata {
  try {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const meta = find(b, 0, b.length, 'meta');
    if (!meta) return {};
    const inner = meta.start + 4; // meta is a "full box": skip version + flags

    // Which item IDs are EXIF / XMP?
    const wanted = new Map<number, 'exif' | 'xmp'>();
    const iinf = find(b, inner, meta.end, 'iinf');
    if (iinf) {
      const version = b[iinf.start] ?? 0;
      const first = iinf.start + 4 + (version === 0 ? 2 : 4);
      for (const infe of boxes(b, first, iinf.end)) {
        if (infe.type !== 'infe') continue;
        const v = b[infe.start] ?? 0;
        if (v < 2) continue;
        let p = infe.start + 4;
        const id = v === 2 ? view.getUint16(p) : view.getUint32(p);
        p += v === 2 ? 2 : 4;
        p += 2; // protection index
        const itemType = asciiAt(b, p, 4);
        p += 4;
        if (itemType === 'Exif') wanted.set(id, 'exif');
        if (itemType === 'mime') {
          p += b.subarray(p, infe.end).indexOf(0) + 1; // skip item_name
          if (startsWithAscii(b, p, 'application/rdf+xml')) wanted.set(id, 'xmp');
        }
      }
    }
    if (wanted.size === 0) return {};

    // Where are they?
    const iloc = find(b, inner, meta.end, 'iloc');
    if (!iloc) return {};
    const v = b[iloc.start] ?? 0;
    let p = iloc.start + 4;
    const sizes = b[p] ?? 0;
    const sizes2 = b[p + 1] ?? 0;
    p += 2;
    const offsetSize = sizes >> 4;
    const lengthSize = sizes & 15;
    const baseOffsetSize = sizes2 >> 4;
    const indexSize = v === 1 || v === 2 ? sizes2 & 15 : 0;
    const readN = (n: number): number => {
      let x = 0;
      for (let i = 0; i < n; i++) x = x * 256 + (b[p + i] ?? 0);
      p += n;
      return x;
    };
    const count = v < 2 ? readN(2) : readN(4);
    const out: HeicMetadata = {};
    for (let i = 0; i < count && p < iloc.end; i++) {
      const id = v < 2 ? readN(2) : readN(4);
      const method = v === 1 || v === 2 ? readN(2) & 15 : 0;
      readN(2); // data reference index
      const base = readN(baseOffsetSize);
      const extents = readN(2);
      const parts: Uint8Array[] = [];
      for (let e = 0; e < extents; e++) {
        if (indexSize) readN(indexSize);
        const off = readN(offsetSize);
        const len = readN(lengthSize);
        if (method === 0 && base + off + len <= b.length) parts.push(b.subarray(base + off, base + off + len));
      }
      const kind = wanted.get(id);
      if (!kind || parts.length === 0) continue;
      const data = concat(parts);
      if (kind === 'xmp') out.xmp = data;
      else if (data.length > 4) {
        // EXIF item: 4-byte offset to the TIFF header, then (usually) "Exif\0\0" + TIFF.
        const skip = new DataView(data.buffer, data.byteOffset).getUint32(0);
        let tiff = data.subarray(4 + skip);
        if (startsWithAscii(tiff, 0, 'Exif\0\0')) tiff = tiff.subarray(EXIF_HEADER.length);
        out.exif = tiff;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Decode a HEIC photo into a JPEG (browser only). The decoder is about 3 MB,
 * so it's only downloaded from our own site the first time it's needed.
 * The decoder applies the photo's rotation, so the JPEG is already upright.
 */
export async function decodeHeicToJpeg(b: Uint8Array, quality = 0.92): Promise<Uint8Array> {
  const { heicTo } = await import('heic-to/csp');
  const blob = await heicTo({ blob: new Blob([new Uint8Array(b)]), type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Build the final JPEG: the decoded picture plus only the EXIF categories the
 * user chose to keep. `decoded` comes from decodeHeicToJpeg and has no metadata.
 */
export function buildHeicOutput(original: Uint8Array, decoded: Uint8Array, keep: KeepSet): StripResult {
  const { exif } = readHeicMetadata(original);
  const removed = [{ kind: 'converted', label: 'Converted from HEIC to JPEG, leaving all hidden data behind', bytes: original.length }];
  let output = decoded;
  if (exif && keep.size > 0) {
    // Rotation is already applied to the pixels, so never copy Orientation.
    const clean = cleanExif(exif, keep, false);
    if (clean.tiff && clean.tiff.length + EXIF_HEADER.length <= 65533) {
      const payload = concat([EXIF_HEADER, clean.tiff]);
      const len = payload.length + 2;
      const app1 = concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), payload]);
      // Insert after SOI and any JFIF header.
      const segs = parseJpeg(decoded).segments;
      const after = segs[1]?.marker === 0xe0 ? segs[1].offset + segs[1].length : 2;
      output = concat([decoded.subarray(0, after), app1, decoded.subarray(after)]);
    }
  }
  return { output, removed, warnings: [] };
}

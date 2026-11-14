/**
 * Minimal EXIF (TIFF) reader and writer.
 *
 * EXIF data is a little TIFF file: a byte-order header, then "IFDs"
 * (Image File Directories), each a list of 12-byte entries
 * (tag, type, count, value-or-offset).
 *
 * The reader finds every tag; `cleanExif` writes a new, smaller EXIF block
 * holding only the categories the user chose to keep (plus Orientation, so
 * photos stay the right way up).
 */

import { categorizeTag, type IfdName, type KeepSet } from './categories';

export const TAG_ORIENTATION = 0x0112;
export const TAG_EXIF_IFD = 0x8769;
export const TAG_GPS_IFD = 0x8825;

/** The 6-byte prefix of an EXIF block inside a JPEG APP1 segment. */
export const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"

const TYPE_SIZES: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
};

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** The entry's value bytes, in the file's byte order. */
  value: Uint8Array;
}

export interface TiffData {
  littleEndian: boolean;
  ifd0: IfdEntry[];
  exif: IfdEntry[];
  gps: IfdEntry[];
  /** IFD1 holds the embedded thumbnail. */
  ifd1: IfdEntry[];
}

class Reader {
  constructor(private b: Uint8Array, private le: boolean) {}
  u16(at: number): number {
    const a = this.b[at] ?? 0;
    const c = this.b[at + 1] ?? 0;
    return this.le ? a | (c << 8) : (a << 8) | c;
  }
  u32(at: number): number {
    const v = this.le
      ? (this.b[at] ?? 0) | ((this.b[at + 1] ?? 0) << 8) | ((this.b[at + 2] ?? 0) << 16) | ((this.b[at + 3] ?? 0) << 24)
      : ((this.b[at] ?? 0) << 24) | ((this.b[at + 1] ?? 0) << 16) | ((this.b[at + 2] ?? 0) << 8) | (this.b[at + 3] ?? 0);
    return v >>> 0;
  }
}

/**
 * Parse a TIFF structure (the bytes after "Exif\0\0").
 * Returns null if the data is not valid TIFF. Never throws on bad offsets:
 * malformed or hostile files are skipped rather than crashing the page.
 */
export function parseTiff(tiff: Uint8Array): TiffData | null {
  if (tiff.length < 8) return null;
  let le: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) le = true; // "II"
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) le = false; // "MM"
  else return null;

  const r = new Reader(tiff, le);
  if (r.u16(2) !== 42) return null;

  const visited = new Set<number>();

  const readIfd = (offset: number): { entries: IfdEntry[]; next: number } => {
    if (offset < 8 || offset + 2 > tiff.length || visited.has(offset)) return { entries: [], next: 0 };
    visited.add(offset);
    const n = r.u16(offset);
    const entries: IfdEntry[] = [];
    for (let i = 0; i < n; i++) {
      const at = offset + 2 + i * 12;
      if (at + 12 > tiff.length) break;
      const tag = r.u16(at);
      const type = r.u16(at + 2);
      const count = r.u32(at + 4);
      const size = (TYPE_SIZES[type] ?? 1) * count;
      const valueAt = size <= 4 ? at + 8 : r.u32(at + 8);
      if (valueAt + size > tiff.length) continue;
      entries.push({ tag, type, count, value: tiff.slice(valueAt, valueAt + size) });
    }
    const nextAt = offset + 2 + n * 12;
    const next = nextAt + 4 <= tiff.length ? r.u32(nextAt) : 0;
    return { entries, next };
  };

  const pointer = (entries: IfdEntry[], tag: number): number => {
    const e = entries.find((x) => x.tag === tag);
    if (!e || e.value.length < 4) return 0;
    return new Reader(e.value, le).u32(0);
  };

  const first = readIfd(r.u32(4));
  const ifd1 = first.next ? readIfd(first.next).entries : [];
  return {
    littleEndian: le,
    ifd0: first.entries,
    exif: readIfd(pointer(first.entries, TAG_EXIF_IFD)).entries,
    gps: readIfd(pointer(first.entries, TAG_GPS_IFD)).entries,
    ifd1,
  };
}

/** Read the Orientation tag (1–8). Returns undefined if absent or invalid. */
export function getOrientation(tiff: TiffData): number | undefined {
  const e = tiff.ifd0.find((x) => x.tag === TAG_ORIENTATION);
  if (!e || e.type !== 3 || e.value.length < 2) return undefined;
  const v = new Reader(e.value, tiff.littleEndian).u16(0);
  return v >= 1 && v <= 8 ? v : undefined;
}

/**
 * Build a complete EXIF block ("Exif\0\0" + TIFF) that contains only the
 * Orientation tag. Orientation tells viewers how to rotate the photo; it
 * reveals nothing personal, and dropping it makes portrait photos show up
 * sideways.
 */
export function buildOrientationOnlyExif(orientation: number): Uint8Array {
  const tiff = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, // "II", 42  (little-endian TIFF)
    0x08, 0x00, 0x00, 0x00, // IFD0 at offset 8
    0x01, 0x00, // 1 entry
    0x12, 0x01, // tag 0x0112 Orientation
    0x03, 0x00, // type SHORT
    0x01, 0x00, 0x00, 0x00, // count 1
    orientation & 0xff, 0x00, 0x00, 0x00, // value (padded to 4 bytes)
    0x00, 0x00, 0x00, 0x00, // no next IFD (so no thumbnail)
  ]);
  const out = new Uint8Array(EXIF_HEADER.length + tiff.length);
  out.set(EXIF_HEADER, 0);
  out.set(tiff, EXIF_HEADER.length);
  return out;
}

// ---- writing: keep only the categories the user chose ----------------------


function encodeU32(v: number, le: boolean): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, le);
  return out;
}

/**
 * Write a TIFF structure with the given directories. Values are copied as
 * raw bytes, so they keep the original byte order (`le`).
 */
export function buildTiff(le: boolean, ifd0: IfdEntry[], exif: IfdEntry[], gps: IfdEntry[]): Uint8Array {
  const pointer = (tag: number): IfdEntry => ({ tag, type: 4, count: 1, value: encodeU32(0, le) });
  const dirs: IfdEntry[][] = [
    [...ifd0, ...(exif.length ? [pointer(TAG_EXIF_IFD)] : []), ...(gps.length ? [pointer(TAG_GPS_IFD)] : [])],
    exif,
    gps,
  ].map((d) => [...d].sort((a, b) => a.tag - b.tag));

  const sizeOf = (entries: IfdEntry[]) =>
    2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.value.length > 4 ? e.value.length + (e.value.length & 1) : 0), 0);
  const offsets: number[] = [];
  let at = 8;
  for (const d of dirs) {
    offsets.push(d.length ? at : 0);
    at += d.length ? sizeOf(d) : 0;
  }

  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  out.set(le ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]);
  view.setUint32(4, 8, le);

  dirs.forEach((entries, i) => {
    if (!entries.length) return;
    const start = offsets[i]!;
    view.setUint16(start, entries.length, le);
    let data = start + 2 + entries.length * 12 + 4;
    entries.forEach((e, j) => {
      const p = start + 2 + j * 12;
      view.setUint16(p, e.tag, le);
      view.setUint16(p + 2, e.type, le);
      view.setUint32(p + 4, e.count, le);
      let value = e.value;
      if (e.tag === TAG_EXIF_IFD && i === 0) value = encodeU32(offsets[1]!, le);
      if (e.tag === TAG_GPS_IFD && i === 0) value = encodeU32(offsets[2]!, le);
      if (value.length <= 4) {
        out.set(value, p + 8);
      } else {
        view.setUint32(p + 8, data, le);
        out.set(value, data);
        data += value.length + (value.length & 1);
      }
    });
    view.setUint32(start + 2 + entries.length * 12, 0, le); // no next directory (drops the thumbnail)
  });
  return out;
}

export interface CleanExif {
  /** New TIFF bytes, or null when nothing is left to keep. */
  tiff: Uint8Array | null;
  orientation?: number;
}

/**
 * Rebuild EXIF keeping only the chosen categories (plus Orientation if asked).
 * The thumbnail, maker notes, comments and anything uncategorized are dropped.
 */
export function cleanExif(tiffBytes: Uint8Array, keep: KeepSet, keepOrientation: boolean): CleanExif {
  const tiff = parseTiff(tiffBytes);
  if (!tiff) return { tiff: null };
  const filter = (ifd: IfdName) => (e: IfdEntry) => {
    if (ifd === 'ifd0' && e.tag === TAG_ORIENTATION) return keepOrientation;
    const cat = categorizeTag(ifd, e.tag);
    return cat !== 'never' && cat !== 'other' && keep.has(cat);
  };
  const ifd0 = tiff.ifd0.filter(filter('ifd0'));
  const exif = tiff.exif.filter(filter('exif'));
  const gps = tiff.gps.filter(filter('gps'));
  let orientation = keepOrientation ? getOrientation(tiff) : undefined;
  if (orientation === 1) {
    // "Normal" orientation is the default; no need to store it.
    orientation = undefined;
    const i = ifd0.findIndex((e) => e.tag === TAG_ORIENTATION);
    if (i >= 0) ifd0.splice(i, 1);
  }
  if (!ifd0.length && !exif.length && !gps.length) return { tiff: null };
  return { tiff: buildTiff(tiff.littleEndian, ifd0, exif, gps), orientation };
}

/** True if a TIFF block holds nothing but the Orientation tag. */
export function isOrientationOnly(tiffBytes: Uint8Array): boolean {
  const t = parseTiff(tiffBytes);
  return t !== null && t.ifd0.length === 1 && t.ifd0[0]?.tag === TAG_ORIENTATION &&
    t.exif.length === 0 && t.gps.length === 0 && t.ifd1.length === 0;
}

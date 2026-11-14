/**
 * Lossless JPEG metadata removal.
 *
 * A JPEG is a sequence of "segments", each starting with a 0xFF marker byte.
 * Metadata lives in APPn segments (0xFFE0–0xFFEF) and COM segments (0xFFFE).
 * The picture itself lives in the other segments plus the compressed
 * "entropy-coded" data after each SOS (start of scan) marker.
 *
 * We copy the picture segments byte-for-byte and leave out the metadata
 * ones, so the image quality is exactly the same as the original.
 */

import { asciiAt, concat, readU16BE, startsWithAscii } from './bytes';
import { buildOrientationOnlyExif, EXIF_HEADER, getOrientation, parseTiff } from './exif';
import { RemovalTally, type StripOptions, type StripResult } from './types';

export type JpegSegmentKind =
  | 'jfif' // APP0 JFIF: basic pixel-density info (kept, minus any thumbnail)
  | 'jfxx' // APP0 JFXX: thumbnail extension
  | 'exif' // APP1 EXIF: GPS, camera model, timestamps, thumbnail, ...
  | 'xmp' // APP1 XMP: editing history, GPS, ratings, device info
  | 'xmp-extended'
  | 'icc' // APP2 ICC colour profile (kept: needed for correct colours)
  | 'mpf' // APP2 Multi-Picture Format: index of extra images after the photo
  | 'iptc' // APP13 Photoshop / IPTC: captions, author, location names
  | 'adobe' // APP14 Adobe: colour-transform flag (kept: needed to decode)
  | 'app-other' // any other APPn (e.g. APP11 JUMBF / C2PA content credentials)
  | 'comment' // COM text comment
  | 'image'; // everything needed to draw the picture

export interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF marker byte. */
  offset: number;
  /** Total length including the 2 marker bytes. */
  length: number;
  kind: JpegSegmentKind;
}

export type JpegStripOptions = StripOptions;
export type JpegStripResult = StripResult;
type RemovedKind = JpegSegmentKind | 'thumbnail' | 'trailer';

export const LABELS: Record<RemovedKind, string> = {
  exif: 'EXIF data (GPS location, phone model, date & time, camera settings)',
  xmp: 'XMP data (editing history, location, device info)',
  'xmp-extended': 'Extended XMP data',
  iptc: 'IPTC / Photoshop data (captions, author, place names)',
  mpf: 'Multi-picture index (points to hidden extra images)',
  jfxx: 'Embedded thumbnail (JFXX)',
  'app-other': 'Other embedded data (e.g. content credentials, vendor data)',
  comment: 'Text comment',
  thumbnail: 'Embedded JFIF thumbnail',
  trailer: 'Hidden data after the image (e.g. motion-photo video, depth or HDR map)',
  jfif: 'JFIF header',
  icc: 'Colour profile',
  adobe: 'Adobe colour header',
  image: 'Image data',
};

export class JpegError extends Error {}

function classify(b: Uint8Array, marker: number, segStart: number): JpegSegmentKind {
  const p = segStart + 4; // payload starts after marker (2) + length (2)
  switch (marker) {
    case 0xe0:
      if (startsWithAscii(b, p, 'JFIF\0')) return 'jfif';
      if (startsWithAscii(b, p, 'JFXX\0')) return 'jfxx';
      return 'app-other';
    case 0xe1:
      if (startsWithAscii(b, p, 'Exif\0')) return 'exif';
      if (startsWithAscii(b, p, 'http://ns.adobe.com/xap/1.0/\0')) return 'xmp';
      if (startsWithAscii(b, p, 'http://ns.adobe.com/xmp/extension/\0')) return 'xmp-extended';
      return 'app-other';
    case 0xe2:
      if (startsWithAscii(b, p, 'ICC_PROFILE\0')) return 'icc';
      if (startsWithAscii(b, p, 'MPF\0')) return 'mpf';
      return 'app-other';
    case 0xed:
      return asciiAt(b, p, 14) === 'Photoshop 3.0\0' ? 'iptc' : 'app-other';
    case 0xee:
      return startsWithAscii(b, p, 'Adobe') ? 'adobe' : 'app-other';
    case 0xfe:
      return 'comment';
    default:
      return marker >= 0xe0 && marker <= 0xef ? 'app-other' : 'image';
  }
}

/** Markers that are just 2 bytes, with no length field. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

interface Walk {
  segments: JpegSegment[];
  /** Offset just past the EOI marker, or -1 if the file has no EOI. */
  end: number;
}

/**
 * Walk the file and list every segment. Entropy-coded data after SOS is
 * attached to the SOS segment (its `length` covers header + data).
 */
export function parseJpeg(b: Uint8Array): Walk {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new JpegError('Not a JPEG file.');
  const segments: JpegSegment[] = [{ marker: 0xd8, offset: 0, length: 2, kind: 'image' }];
  let pos = 2;

  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new JpegError(`Corrupt JPEG: expected a marker at byte ${pos}.`);
    // Any number of 0xFF fill bytes may come before a marker.
    let m = pos;
    while (m + 1 < b.length && b[m + 1] === 0xff) m++;
    if (m + 1 >= b.length) break;
    const marker = b[m + 1] ?? 0;
    const start = m;

    if (marker === 0xd9) {
      segments.push({ marker, offset: start, length: 2, kind: 'image' });
      return { segments, end: start + 2 };
    }
    if (isStandalone(marker)) {
      segments.push({ marker, offset: start, length: 2, kind: 'image' });
      pos = start + 2;
      continue;
    }

    if (start + 4 > b.length) throw new JpegError('Corrupt JPEG: truncated segment header.');
    const segLen = readU16BE(b, start + 2);
    const segEnd = start + 2 + segLen;
    if (segLen < 2 || segEnd > b.length) throw new JpegError('Corrupt JPEG: segment runs past end of file.');

    if (marker === 0xda) {
      // Start of scan: compressed picture data follows until the next real marker.
      // Inside it, 0xFF00 is an escaped 0xFF and 0xFFD0–D7 are restart markers.
      let i = segEnd;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const next = b[i + 1];
        if (next === undefined) { i++; break; }
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i += 2; continue; }
        if (next === 0xff) { i++; continue; } // fill byte before a marker
        break; // a real marker: end of this scan
      }
      segments.push({ marker, offset: start, length: i - start, kind: 'image' });
      pos = i;
      continue;
    }

    segments.push({ marker, offset: start, length: segEnd - start, kind: classify(b, marker, start) });
    pos = segEnd;
  }
  return { segments, end: -1 };
}

/** JFIF APP0 may hold an uncompressed thumbnail. Rewrite it without one. */
function jfifWithoutThumbnail(b: Uint8Array, seg: JpegSegment): { bytes: Uint8Array; thumb: number } {
  const p = seg.offset + 4;
  const xThumb = b[p + 12] ?? 0;
  const yThumb = b[p + 13] ?? 0;
  if (xThumb === 0 || yThumb === 0 || seg.length <= 18) {
    return { bytes: b.slice(seg.offset, seg.offset + seg.length), thumb: 0 };
  }
  const out = b.slice(seg.offset, seg.offset + 18); // marker + len + 14 bytes of JFIF fields
  out[2] = 0x00;
  out[3] = 16; // new length: 2 (len) + 14 (fields)
  out[16] = 0;
  out[17] = 0;
  return { bytes: out, thumb: seg.length - 18 };
}

function app1(payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  const out = new Uint8Array(len + 2);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(payload, 4);
  return out;
}

export function stripJpeg(b: Uint8Array, opts: JpegStripOptions = {}): JpegStripResult {
  const keepOrientation = opts.keepOrientation ?? true;
  const keepColorProfile = opts.keepColorProfile ?? true;
  const { segments, end } = parseJpeg(b);

  const parts: Uint8Array[] = [];
  const tally = new RemovalTally(LABELS);
  const addRemoved = (kind: RemovedKind, n: number) => tally.add(kind, n);
  const warnings: string[] = [];
  let orientation: number | undefined;
  let orientationWritten = false;

  for (const seg of segments) {
    const bytes = () => b.slice(seg.offset, seg.offset + seg.length);
    switch (seg.kind) {
      case 'image':
      case 'adobe':
        parts.push(bytes());
        break;
      case 'icc':
        if (keepColorProfile) parts.push(bytes());
        else addRemoved('icc', seg.length);
        break;
      case 'jfif': {
        const { bytes: clean, thumb } = jfifWithoutThumbnail(b, seg);
        parts.push(clean);
        addRemoved('thumbnail', thumb);
        break;
      }
      case 'exif': {
        addRemoved('exif', seg.length);
        if (keepOrientation && !orientationWritten) {
          const tiff = parseTiff(b.subarray(seg.offset + 4 + EXIF_HEADER.length, seg.offset + seg.length));
          const o = tiff ? getOrientation(tiff) : undefined;
          if (o !== undefined && o !== 1) {
            const replacement = app1(buildOrientationOnlyExif(o));
            parts.push(replacement);
            addRemoved('exif', -replacement.length);
            orientation = o;
          }
          orientationWritten = true;
        }
        break;
      }
      default:
        addRemoved(seg.kind, seg.length);
    }
  }

  if (end === -1) {
    warnings.push('The file looked cut off (no end-of-image marker). The clean copy was repaired, but check it opens correctly.');
    parts.push(new Uint8Array([0xff, 0xd9]));
  } else if (end < b.length) {
    addRemoved('trailer', b.length - end);
  }

  return { output: concat(parts), removed: tally.items(), orientation, warnings };
}

/**
 * Check a JPEG for metadata segments. Used to double-check our own output.
 * Returns the kinds found (an orientation-only EXIF block is reported as
 * 'orientation-only' rather than 'exif').
 */
export function findJpegMetadata(b: Uint8Array): string[] {
  const { segments, end } = parseJpeg(b);
  const found: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'image' || seg.kind === 'adobe' || seg.kind === 'icc') continue;
    if (seg.kind === 'jfif') {
      if ((b[seg.offset + 16] ?? 0) * (b[seg.offset + 17] ?? 0) > 0) found.push('thumbnail');
      continue;
    }
    if (seg.kind === 'exif') {
      const tiff = parseTiff(b.subarray(seg.offset + 4 + EXIF_HEADER.length, seg.offset + seg.length));
      const onlyOrientation =
        tiff !== null &&
        tiff.ifd0.length === 1 &&
        tiff.ifd0[0]?.tag === 0x0112 &&
        tiff.exif.length === 0 &&
        tiff.gps.length === 0 &&
        tiff.ifd1.length === 0;
      found.push(onlyOrientation ? 'orientation-only' : 'exif');
      continue;
    }
    found.push(seg.kind);
  }
  if (end !== -1 && end < b.length) found.push('trailer');
  return found;
}

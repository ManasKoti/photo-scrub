/**
 * Single entry point the UI calls: give it a file's bytes, get a clean copy
 * plus a report of what the original revealed. Each format has its own
 * module; this file routes to the right one.
 */

import type { KeepSet } from './categories';
import { detectFormat, type ImageFormat } from './detect';
import { buildHeicOutput, decodeHeicToJpeg } from './heic';
import { inspect, type Inspection } from './inspect';
import { findJpegMetadata, parseJpeg, stripJpeg } from './jpeg';
import { findPngMetadata, parsePng, stripPng } from './png';
import type { RemovedItem, StripOptions, StripResult } from './types';
import { findWebpMetadata, parseWebp, stripWebp } from './webp';

export interface ScrubResult {
  format: ImageFormat;
  output: Uint8Array;
  /** MIME type and extension of the clean file. */
  mime: string;
  extension: string;
  removed: RemovedItem[];
  orientation?: number;
  /** True if the colour profile was kept. */
  keptColorProfile: boolean;
  warnings: string[];
  /** Metadata still present in the output (checked by re-reading it). */
  remaining: string[];
}

export class UnsupportedFormatError extends Error {
  constructor(public format: ImageFormat) {
    super(
      format === 'unknown'
        ? "This doesn't look like a JPEG, PNG, WebP or HEIC photo."
        : `${format.toUpperCase()} isn't supported.`,
    );
  }
}

interface Handler {
  mime: string;
  extension: string;
  strip: (b: Uint8Array, o?: StripOptions) => StripResult;
  find: (b: Uint8Array) => string[];
  hasColorProfile: (b: Uint8Array) => boolean;
}

const HANDLERS: Partial<Record<ImageFormat, Handler>> = {
  jpeg: {
    mime: 'image/jpeg', extension: 'jpg', strip: stripJpeg, find: findJpegMetadata,
    hasColorProfile: (b) => parseJpeg(b).segments.some((s) => s.kind === 'icc'),
  },
  png: {
    mime: 'image/png', extension: 'png', strip: stripPng, find: findPngMetadata,
    hasColorProfile: (b) => parsePng(b).chunks.some((c) => c.type === 'iCCP'),
  },
  webp: {
    mime: 'image/webp', extension: 'webp', strip: stripWebp, find: findWebpMetadata,
    hasColorProfile: (b) => parseWebp(b).chunks.some((c) => c.type === 'ICCP'),
  },
};

export interface ScrubOptions extends StripOptions {
  /** For HEIC: the photo already decoded to JPEG (see decodeHeicToJpeg). */
  heicDecoded?: Uint8Array;
}

export function scrub(bytes: Uint8Array, options: ScrubOptions = {}): ScrubResult {
  const format = detectFormat(bytes);
  if (format === 'heic') {
    if (!options.heicDecoded) throw new Error('HEIC photos must be decoded before cleaning.');
    const r = buildHeicOutput(bytes, options.heicDecoded, options.keep ?? new Set());
    const keepsSomething = (options.keep?.size ?? 0) > 0;
    return {
      format, output: r.output, mime: 'image/jpeg', extension: 'jpg', removed: r.removed,
      keptColorProfile: false, warnings: r.warnings,
      remaining: findJpegMetadata(r.output).filter((k) => !(keepsSomething && k === 'exif')),
    };
  }
  const h = HANDLERS[format];
  if (!h) throw new UnsupportedFormatError(format);
  const r = h.strip(bytes, options);
  const keepsSomething = (options.keep?.size ?? 0) > 0;
  return {
    format,
    output: r.output,
    mime: h.mime,
    extension: h.extension,
    removed: r.removed,
    orientation: r.orientation,
    keptColorProfile: h.hasColorProfile(r.output),
    warnings: r.warnings,
    // Kept categories legitimately leave EXIF / PNG text behind; those are
    // checked category by category in verify() instead.
    remaining: h.find(r.output).filter((k) => k !== 'orientation-only' && !(keepsSomething && KEEPABLE.has(k))),
  };
}

const KEEPABLE = new Set(['exif', 'text', 'time']);

/**
 * Double-check a clean copy: anything the user didn't choose to keep must be
 * gone. Returns a list of problems (empty = all good).
 */
export function verify(after: Inspection, result: ScrubResult, keep: KeepSet = new Set()): string[] {
  const leaks = after.findings.filter((f) => !keep.has(f.id)).map((f) => f.title);
  if (after.hasThumbnail) leaks.push('Hidden thumbnail');
  leaks.push(...result.remaining);
  return leaks;
}

export interface Analysis {
  /** For HEIC: the decoded JPEG, reused when the user changes Remove/Keep. */
  heicDecoded?: Uint8Array;
  /** What the original photo reveals. */
  before: Inspection;
  result: ScrubResult;
  /** What the clean copy still reveals: should have no findings. */
  after: Inspection;
}

/**
 * Inspect, clean, then inspect the clean copy to double-check.
 * HEIC photos are decoded first (browser only).
 */
export async function analyze(bytes: Uint8Array, options: ScrubOptions = {}): Promise<Analysis> {
  if (detectFormat(bytes) === 'heic' && !options.heicDecoded) {
    options = { ...options, heicDecoded: await decodeHeicToJpeg(bytes) };
  }
  const result = scrub(bytes, options); // throws early for unsupported formats
  const [before, after] = await Promise.all([inspect(bytes), inspect(result.output)]);
  return { before, result, after, heicDecoded: options.heicDecoded };
}

/**
 * Single entry point the UI calls: give it a file's bytes, get a clean copy
 * plus a report of what the original revealed. Each format has its own
 * module; this file routes to the right one.
 */

import { detectFormat, type ImageFormat } from './detect';
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
        : `${format.toUpperCase()} support is coming soon. JPEG, PNG and WebP work today.`,
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

export function scrub(bytes: Uint8Array, options: StripOptions = {}): ScrubResult {
  const format = detectFormat(bytes);
  const h = HANDLERS[format];
  if (!h) throw new UnsupportedFormatError(format);
  const r = h.strip(bytes, options);
  return {
    format,
    output: r.output,
    mime: h.mime,
    extension: h.extension,
    removed: r.removed,
    orientation: r.orientation,
    keptColorProfile: h.hasColorProfile(r.output),
    warnings: r.warnings,
    remaining: h.find(r.output).filter((k) => k !== 'orientation-only'),
  };
}

export interface Analysis {
  /** What the original photo reveals. */
  before: Inspection;
  result: ScrubResult;
  /** What the clean copy still reveals: should have no findings. */
  after: Inspection;
}

/** Inspect, clean, then inspect the clean copy to double-check. */
export async function analyze(bytes: Uint8Array, options: StripOptions = {}): Promise<Analysis> {
  const result = scrub(bytes, options); // throws early for unsupported formats
  const [before, after] = await Promise.all([inspect(bytes), inspect(result.output)]);
  return { before, result, after };
}

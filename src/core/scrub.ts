/**
 * Single entry point the UI calls: give it a file's bytes, get a clean copy.
 * Each format gets its own module; this file just routes to the right one.
 */

import { detectFormat, type ImageFormat } from './detect';
import { stripJpeg, findJpegMetadata, type RemovedItem } from './jpeg';

export interface ScrubResult {
  format: ImageFormat;
  output: Uint8Array;
  /** MIME type and extension of the clean file. */
  mime: string;
  extension: string;
  removed: RemovedItem[];
  orientation?: number;
  warnings: string[];
  /** Metadata still present in the output (checked by re-reading it). */
  remaining: string[];
}

export class UnsupportedFormatError extends Error {
  constructor(public format: ImageFormat) {
    super(
      format === 'unknown'
        ? "This doesn't look like a JPEG, PNG, WebP or HEIC photo."
        : `${format.toUpperCase()} support is coming in a later phase. JPEG works today.`,
    );
  }
}

export function scrub(bytes: Uint8Array): ScrubResult {
  const format = detectFormat(bytes);
  switch (format) {
    case 'jpeg': {
      const r = stripJpeg(bytes);
      return {
        format,
        output: r.output,
        mime: 'image/jpeg',
        extension: 'jpg',
        removed: r.removed,
        orientation: r.orientation,
        warnings: r.warnings,
        remaining: findJpegMetadata(r.output).filter((k) => k !== 'orientation-only'),
      };
    }
    default:
      throw new UnsupportedFormatError(format);
  }
}

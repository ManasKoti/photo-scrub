import { asciiAt, startsWithAscii } from './bytes';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'heic' | 'unknown';

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/**
 * Identify the format from the file's first bytes ("magic numbers").
 * We never trust the file extension or MIME type: phones and share sheets
 * often get those wrong.
 */
export function detectFormat(b: Uint8Array): ImageFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';

  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && pngSig.every((v, i) => b[i] === v)) return 'png';

  if (startsWithAscii(b, 0, 'RIFF') && startsWithAscii(b, 8, 'WEBP')) return 'webp';

  // ISO-BMFF: [size][ftyp][major brand]...
  if (startsWithAscii(b, 4, 'ftyp')) {
    const major = asciiAt(b, 8, 4);
    if (HEIC_BRANDS.has(major)) return 'heic';
    // Some files only list a HEIC brand among the compatible brands.
    const boxSize = ((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0);
    for (let at = 16; at + 4 <= Math.min(boxSize, b.length); at += 4) {
      if (HEIC_BRANDS.has(asciiAt(b, at, 4))) return 'heic';
    }
  }

  return 'unknown';
}

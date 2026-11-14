import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import exifr from 'exifr';
import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/core/detect';
import { findJpegMetadata, parseJpeg, stripJpeg } from '../src/core/jpeg';
import { scrub } from '../src/core/scrub';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

/** Concatenate every image-data segment: this must be identical before and after. */
function imageBytes(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const s of parseJpeg(b).segments) {
    if (s.kind === 'image') out.push(...b.subarray(s.offset, s.offset + s.length));
  }
  return out;
}

/** Read metadata with an independent library (exifr), not our own parser. */
async function readAll(b: Uint8Array) {
  return exifr.parse(b, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, ifd1: true, mergeOutput: false });
}

describe('fixtures contain what we expect (sanity check)', () => {
  it('phone-gps.jpg has GPS, device and XMP before cleaning', async () => {
    const meta = await readAll(fixture('phone-gps.jpg'));
    expect(meta.gps.latitude).toBeCloseTo(48.858, 2);
    expect(meta.ifd0.Model).toBe('FakePhone 15 Pro');
    // exifr files XMP's exif: namespace (here, a second copy of the GPS) under `exif`.
    expect(meta.exif.GPSLatitude).toBeDefined();
    expect(findJpegMetadata(fixture('phone-gps.jpg'))).toEqual(expect.arrayContaining(['exif', 'xmp', 'comment']));
  });
});

describe('stripJpeg', () => {
  for (const name of ['phone-gps.jpg', 'progressive-motion.jpg', 'restart-markers.jpg', 'clean.jpg']) {
    it(`${name}: removes all metadata and leaves image data byte-identical`, async () => {
      const input = fixture(name);
      const { output } = stripJpeg(input);

      expect(imageBytes(output)).toEqual(imageBytes(input));
      expect(findJpegMetadata(output).filter((k) => k !== 'orientation-only')).toEqual([]);

      const meta = (await readAll(output)) ?? {};
      expect(meta.gps).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      expect(meta.ifd1).toBeUndefined();
      expect(meta.ifd0?.Make).toBeUndefined();
      expect(meta.ifd0?.Model).toBeUndefined();
      expect(meta.ifd0?.Artist).toBeUndefined();
      expect(meta.ifd0?.DateTime).toBeUndefined();
    });
  }

  it('keeps Orientation so rotated photos still display correctly', async () => {
    const r = stripJpeg(fixture('phone-gps.jpg'));
    expect(r.orientation).toBe(6);
    const meta = await exifr.parse(r.output, { tiff: true, mergeOutput: false });
    expect(meta.ifd0).toEqual({ Orientation: 'Rotate 90 CW' });
  });

  it('writes no EXIF at all when orientation is normal', () => {
    const r = stripJpeg(fixture('progressive-motion.jpg'));
    expect(r.orientation).toBeUndefined();
    expect(findJpegMetadata(r.output)).toEqual([]);
  });

  it('can drop orientation too when asked', () => {
    const r = stripJpeg(fixture('phone-gps.jpg'), { keepOrientation: false });
    expect(findJpegMetadata(r.output)).toEqual([]);
  });

  it('removes hidden data after the end of the image (motion-photo video)', () => {
    const input = fixture('progressive-motion.jpg');
    const r = stripJpeg(input);
    const trailer = r.removed.find((x) => x.kind === 'trailer');
    expect(trailer?.bytes).toBeGreaterThan(3000);
    expect(r.output[r.output.length - 2]).toBe(0xff);
    expect(r.output[r.output.length - 1]).toBe(0xd9);
  });

  it('reports what it removed', () => {
    const kinds = stripJpeg(fixture('phone-gps.jpg')).removed.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['exif', 'xmp', 'comment']));
  });

  it('is idempotent: cleaning a clean file changes nothing', () => {
    const once = stripJpeg(fixture('phone-gps.jpg')).output;
    const twice = stripJpeg(once).output;
    expect(twice).toEqual(once);
  });
});

describe('hand-built edge cases', () => {
  const SOI = [0xff, 0xd8];
  const EOI = [0xff, 0xd9];
  const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  // A tiny fake scan containing an escaped 0xFF00 and a restart marker.
  const SOS = seg(0xda, [1, 1, 0, 0, 63, 0]);
  const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];

  it('removes a JFIF thumbnail but keeps the JFIF header', () => {
    const thumbPixels = new Array(2 * 2 * 3).fill(0xaa);
    const jfif = seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 72, 0, 72, 2, 2, ...thumbPixels]);
    const file = new Uint8Array([...SOI, ...jfif, ...SOS, ...SCAN, ...EOI]);
    const r = stripJpeg(file);
    expect(r.removed.find((x) => x.kind === 'thumbnail')?.bytes).toBe(12);
    expect(findJpegMetadata(r.output)).toEqual([]);
    expect(Array.from(r.output)).toEqual([
      ...SOI, ...seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 72, 0, 72, 0, 0]), ...SOS, ...SCAN, ...EOI,
    ]);
  });

  it('handles fill bytes before markers and keeps scan data intact', () => {
    const com = seg(0xfe, ascii('secret'));
    const file = new Uint8Array([...SOI, 0xff, ...com, ...SOS, ...SCAN, 0xff, ...EOI]);
    const r = stripJpeg(file);
    expect(Array.from(r.output)).toEqual([...SOI, ...SOS, ...SCAN, 0xff, ...EOI]);
  });

  it('removes C2PA / JUMBF (APP11) and unknown APP segments', () => {
    const app11 = seg(0xeb, ascii('JP\0\0jumbf-c2pa-manifest'));
    const file = new Uint8Array([...SOI, ...app11, ...SOS, ...SCAN, ...EOI]);
    expect(stripJpeg(file).removed.map((x) => x.kind)).toEqual(['app-other']);
  });

  it('repairs a truncated file and warns', () => {
    const file = new Uint8Array([...SOI, ...SOS, ...SCAN]);
    const r = stripJpeg(file);
    expect(r.warnings.length).toBe(1);
    expect(Array.from(r.output.slice(-2))).toEqual(EOI);
  });

  it('rejects files that are not JPEG', () => {
    expect(() => stripJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow();
  });
});

describe('detectFormat / scrub', () => {
  it('detects formats by content, not extension', () => {
    expect(detectFormat(fixture('clean.jpg'))).toBe('jpeg');
    expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    const webp = new Uint8Array([...'RIFF\0\0\0\0WEBP'].map((c) => c.charCodeAt(0)));
    expect(detectFormat(webp)).toBe('webp');
    const heic = new Uint8Array([0, 0, 0, 24, ...[...'ftypheic'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    expect(detectFormat(heic)).toBe('heic');
  });

  it('scrub() reports nothing remaining for a phone photo', () => {
    const r = scrub(fixture('phone-gps.jpg'));
    expect(r.remaining).toEqual([]);
    expect(r.mime).toBe('image/jpeg');
  });

  it('scrub() says PNG is not supported yet', () => {
    expect(() => scrub(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toThrow(/later phase/);
  });
});

import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32';
import { findPngMetadata, parsePng, stripPng } from '../src/core/png';
import { findWebpMetadata, parseWebp, stripWebp } from '../src/core/webp';
import { inspect } from '../src/core/inspect';
import { fixture } from './helpers';

const pngImageChunks = (b: Uint8Array) =>
  parsePng(b).chunks.filter((c) => ['IHDR', 'PLTE', 'IDAT', 'tRNS'].includes(c.type)).map((c) => Array.from(b.subarray(c.offset, c.offset + c.length)));

const webpImageChunks = (b: Uint8Array) =>
  parseWebp(b).chunks.filter((c) => ['VP8 ', 'VP8L', 'ALPH', 'ANMF'].includes(c.type)).map((c) => Array.from(b.subarray(c.offset, c.offset + c.length)));

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('stripPng', () => {
  it('removes EXIF, XMP, text, timestamps and trailing data from a screenshot', async () => {
    const input = fixture('screenshot.png');
    expect(findPngMetadata(input)).toEqual(expect.arrayContaining(['exif', 'xmp', 'text', 'time', 'trailer']));
    const r = stripPng(input);
    expect(pngImageChunks(r.output)).toEqual(pngImageChunks(input));
    expect(findPngMetadata(r.output)).toEqual(['orientation-only']);
    expect(r.orientation).toBe(6);
    expect((await inspect(r.output)).findings).toEqual([]);
    expect(r.removed.map((x) => x.kind)).toEqual(expect.arrayContaining(['exif', 'xmp', 'text', 'time', 'trailer']));
  });

  it('writes valid CRCs for every chunk', () => {
    const out = stripPng(fixture('screenshot.png')).output;
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (const c of parsePng(out).chunks) {
      const expected = view.getUint32(c.offset + 8 + c.dataLength);
      expect(crc32(out.subarray(c.offset + 4, c.offset + 8 + c.dataLength))).toBe(expected);
    }
  });

  it('leaves an already-clean PNG byte-for-byte unchanged', () => {
    // Strip once to get a guaranteed-clean file (fixtures copied by some tools
    // pick up extra metadata such as content credentials), then strip again.
    const clean = stripPng(fixture('clean.png')).output;
    expect(stripPng(clean).output).toEqual(clean);
    expect(findPngMetadata(clean)).toEqual([]);
  });

  it('removes content credentials (C2PA caBX chunks)', () => {
    const base = stripPng(fixture('clean.png')).output;
    const iend = parsePng(base).chunks.at(-1)!;
    const cabx = new Uint8Array(12 + 4);
    new DataView(cabx.buffer).setUint32(0, 4);
    cabx.set([...'caBXjumb'].map((c) => c.charCodeAt(0)), 4);
    const withC2pa = new Uint8Array([...base.subarray(0, iend.offset), ...cabx, ...base.subarray(iend.offset)]);
    expect(findPngMetadata(withC2pa)).toEqual(['c2pa']);
    expect(stripPng(withC2pa).output).toEqual(base);
  });

  it('keeps unknown critical chunks but drops unknown ancillary ones', () => {
    const base = fixture('clean.png');
    const { chunks } = parsePng(base);
    const iend = chunks[chunks.length - 1]!;
    const raw = (type: string) => {
      const c = new Uint8Array(12);
      for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
      return c;
    };
    const withExtra = new Uint8Array([...base.subarray(0, iend.offset), ...raw('prVt'), ...raw('ABCD'), ...base.subarray(iend.offset)]);
    const r = stripPng(withExtra);
    expect(parsePng(r.output).chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'ABCD', 'IEND']);
    expect(r.warnings.length).toBe(1);
  });

  it('rejects non-PNG data', () => {
    expect(() => stripPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });
});

describe('stripWebp', () => {
  it('removes EXIF and XMP, keeps the colour profile, and fixes the header flags', async () => {
    const input = fixture('phone.webp');
    const r = stripWebp(input);
    expect(webpImageChunks(r.output)).toEqual(webpImageChunks(input));
    expect(findWebpMetadata(r.output)).toEqual(['orientation-only']);
    expect(parseWebp(r.output).chunks.map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
    const vp8x = parseWebp(r.output).chunks[0]!;
    const flags = r.output[vp8x.dataOffset]!;
    expect(flags & 0x20).toBe(0x20); // ICC
    expect(flags & 0x08).toBe(0x08); // EXIF (orientation only)
    expect(flags & 0x04).toBe(0); // no XMP
    const riffSize = new DataView(r.output.buffer, r.output.byteOffset).getUint32(4, true);
    expect(riffSize).toBe(r.output.length - 8);
    expect((await inspect(r.output)).findings).toEqual([]);
  });

  it('removes XMP from a lossless WebP with transparency', () => {
    const input = fixture('alpha-xmp.webp');
    const r = stripWebp(input);
    expect(findWebpMetadata(r.output)).toEqual([]);
    expect(webpImageChunks(r.output)).toEqual(webpImageChunks(input));
    const vp8x = parseWebp(r.output).chunks[0]!;
    expect(r.output[vp8x.dataOffset]! & 0x10).toBe(0x10); // alpha flag untouched
  });

  it('can drop the colour profile when asked', () => {
    const r = stripWebp(fixture('phone.webp'), { keepColorProfile: false, keepOrientation: false });
    expect(parseWebp(r.output).chunks.map((c) => c.type)).toEqual(['VP8X', 'VP8 ']);
  });

  it('leaves an already-clean WebP unchanged', () => {
    const clean = stripWebp(fixture('clean.webp')).output;
    expect(stripWebp(clean).output).toEqual(clean);
    expect(findWebpMetadata(clean)).toEqual([]);
    expect(parseWebp(clean).chunks.map((c) => c.type)).toEqual(['VP8 ']);
  });
});

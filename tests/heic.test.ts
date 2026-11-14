import exifr from 'exifr';
import { describe, expect, it } from 'vitest';
import { buildHeicOutput, readHeicMetadata } from '../src/core/heic';
import { parseTiff } from '../src/core/exif';
import { inspect } from '../src/core/inspect';
import { findJpegMetadata } from '../src/core/jpeg';
import { scrub, verify } from '../src/core/scrub';
import { fixture } from './helpers';

// The real HEIC decoder needs a browser; here a plain JPEG stands in for the
// decoded picture. Real decoding is checked by opening a HEIC photo in the app.
const decoded = () => scrub(fixture('clean.jpg')).output;

describe('HEIC', () => {
  it('finds the EXIF item inside the file', () => {
    const { exif } = readHeicMetadata(fixture('iphone.heic'));
    const tiff = parseTiff(exif!);
    expect(tiff?.gps.length).toBeGreaterThan(0);
  });

  it('explains what an iPhone photo reveals', async () => {
    const r = await inspect(fixture('iphone.heic'));
    expect(r.findings.map((f) => f.id)).toEqual(['location', 'device', 'time', 'author', 'camera']);
    expect(r.findings[0]!.headline).toBe('Taken at 48.8582° N, 2.2945° E');
  });

  it('removes everything by default', async () => {
    const r = scrub(fixture('iphone.heic'), { heicDecoded: decoded() });
    expect(r.mime).toBe('image/jpeg');
    expect(findJpegMetadata(r.output)).toEqual([]);
    expect(verify(await inspect(r.output), r)).toEqual([]);
  });

  it('copies only kept categories into the JPEG, without Orientation', async () => {
    const keep = new Set(['time'] as const);
    const r = scrub(fixture('iphone.heic'), { heicDecoded: decoded(), keep });
    const after = await inspect(r.output);
    expect(after.findings.map((f) => f.id)).toEqual(['time']);
    expect(verify(after, r, keep)).toEqual([]);
    const meta = await exifr.parse(r.output, { tiff: true, mergeOutput: false, reviveValues: false });
    expect(meta.ifd0.Orientation).toBeUndefined();
  });

  it('never fails on damaged files', () => {
    expect(readHeicMetadata(new Uint8Array(40))).toEqual({});
    expect(buildHeicOutput(new Uint8Array(40), decoded(), new Set(['time'])).output).toEqual(decoded());
  });
});

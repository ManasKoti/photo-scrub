import { describe, expect, it } from 'vitest';
import { formatExifDate, inspect } from '../src/core/inspect';
import exifr from 'exifr';
import { analyze, scrub, verify } from '../src/core/scrub';
import { fixture } from './helpers';

describe('inspect', () => {
  it('turns a phone photo into plain-language findings, highest risk first', async () => {
    const r = await inspect(fixture('phone-gps.jpg'));
    expect(r.findings.map((f) => f.id)).toEqual(['location', 'device', 'time', 'author', 'camera']);
    const [loc, dev, time, author, cam] = r.findings;
    expect(loc!.risk).toBe('high');
    expect(loc!.headline).toBe('Taken at 48.8582° N, 2.2945° E');
    expect(loc!.mapUrl).toContain('openstreetmap.org/?mlat=48.85822&mlon=2.29450');
    expect(dev!.headline).toBe('Shot on a FakePhone 15 Pro running FakeOS 18.1');
    expect(dev!.detail).toContain('SN-0123456789');
    expect(time!.headline).toContain('2026');
    expect(author!.headline).toBe('Signed “Jane Doe”');
    expect(cam!.headline).toBe('ISO 100');
    expect(r.raw.length).toBeGreaterThan(8);
  });

  it('reads PNG text chunks and EXIF', async () => {
    const r = await inspect(fixture('screenshot.png'));
    expect(r.findings.map((f) => f.id)).toEqual(['location', 'device', 'time', 'author', 'camera']);
    expect(r.raw.some((t) => t.group === 'PNG text' && t.tag === 'Comment')).toBe(true);
  });

  it('reads WebP EXIF and XMP', async () => {
    const r = await inspect(fixture('phone.webp'));
    expect(r.findings[0]!.headline).toBe('Taken at 48.8582° N, 2.2945° E');
  });

  it('finds location in XMP-only files', async () => {
    const r = await inspect(fixture('alpha-xmp.webp'));
    expect(r.findings.map((f) => f.id)).toEqual(['location']);
    expect(r.findings[0]!.headline).toBe('Taken at 48.8582° N, 2.2945° E');
  });

  it('reports nothing for clean files', async () => {
    for (const f of ['clean.jpg', 'clean.png', 'clean.webp']) {
      expect((await inspect(fixture(f))).findings).toEqual([]);
    }
  });

  it('formats EXIF dates in plain language', () => {
    expect(formatExifDate('2026:11:14 23:01:00')).toMatch(/2026/);
    expect(formatExifDate('not a date')).toBe('not a date');
  });
});

describe('analyze', () => {
  for (const f of ['phone-gps.jpg', 'progressive-motion.jpg', 'screenshot.png', 'phone.webp', 'alpha-xmp.webp']) {
    it(`${f}: clean copy reveals nothing`, async () => {
      const a = await analyze(fixture(f));
      expect(a.before.findings.length).toBeGreaterThan(0);
      expect(a.after.findings).toEqual([]);
      expect(a.result.remaining).toEqual([]);
    });
  }
});

describe('selective removal (keep some categories)', () => {
  const cases: [string, string][] = [
    ['phone-gps.jpg', 'jpeg'], ['screenshot.png', 'png'], ['phone.webp', 'webp'],
  ];
  for (const [f] of cases) {
    it(`${f}: keeping date & time and camera settings removes everything else`, async () => {
      const keep = new Set(['time', 'camera'] as const);
      const r = scrub(fixture(f), { keep });
      const after = await inspect(r.output);
      expect(after.findings.map((x) => x.id).sort()).toEqual(['camera', 'time']);
      expect(verify(after, r, keep)).toEqual([]);
      expect(after.raw.some((t) => /GPS|Make|Model|Serial|Artist/i.test(t.tag))).toBe(false);
      expect(r.orientation).toBe(6);
    });

    it(`${f}: keeping location keeps the exact coordinates`, async () => {
      const r = scrub(fixture(f), { keep: new Set(['location'] as const) });
      const after = await inspect(r.output);
      expect(after.findings.map((x) => x.id)).toEqual(['location']);
      expect(after.findings[0]!.headline).toBe('Taken at 48.8582° N, 2.2945° E');
    });
  }

  it('keeping everything still drops the thumbnail, XMP and trailing data', async () => {
    const keep = new Set(['location', 'device', 'time', 'author', 'camera'] as const);
    const r = scrub(fixture('progressive-motion.jpg'), { keep });
    expect(r.removed.map((x) => x.kind)).toEqual(expect.arrayContaining(['trailer']));
    const after = await inspect(r.output);
    expect(verify(after, r, keep)).toEqual([]);
    expect(after.findings.length).toBe(5);
  });

  it('verify() flags anything the user did not keep', async () => {
    const r = scrub(fixture('phone-gps.jpg'), { keep: new Set(['location'] as const) });
    const after = await inspect(r.output);
    // Pretend the user only wanted time kept: location is now a leak.
    expect(verify(after, r, new Set(['time'] as const))).toEqual(['Location']);
  });

  it('kept EXIF stays readable by an independent reader (exifr)', async () => {
    const r = scrub(fixture('phone-gps.jpg'), { keep: new Set(['time', 'device'] as const) });
    const meta = await exifr.parse(r.output, { tiff: true, exif: true, gps: true, mergeOutput: false, reviveValues: false });
    expect(meta.ifd0).toMatchObject({ Make: 'FakePhone', Model: 'FakePhone 15 Pro', Software: 'FakeOS 18.1', ModifyDate: '2026:11:14 23:01:00' });
    expect(meta.exif).toMatchObject({ DateTimeOriginal: '2026:11:14 23:01:00', SerialNumber: 'SN-0123456789' });
    expect(meta.exif.ISO).toBeUndefined();
    expect(meta.gps).toBeUndefined();
    expect(meta.ifd0.Artist).toBeUndefined();
  });
});

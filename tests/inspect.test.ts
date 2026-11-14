import { describe, expect, it } from 'vitest';
import { formatExifDate, inspect } from '../src/core/inspect';
import { analyze } from '../src/core/scrub';
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

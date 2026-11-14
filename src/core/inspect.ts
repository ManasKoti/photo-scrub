/**
 * "What does this photo reveal?" Reads a photo's metadata and turns it into
 * plain-language findings grouped by risk: Location, Phone, Date & time,
 * Name and Camera settings, plus a raw tag list for the curious.
 *
 * Reading is done by the exifr library (it understands EXIF, GPS, XMP and
 * IPTC). This file decides what each tag means for your privacy.
 */

import exifr from 'exifr';
import { asciiAt, concat, startsWithAscii } from './bytes';
import { detectFormat } from './detect';
import { EXIF_HEADER, parseTiff } from './exif';
import { parsePng } from './png';
import { parseWebp } from './webp';

export type CategoryId = 'location' | 'device' | 'time' | 'author' | 'camera';
export type Risk = 'high' | 'medium' | 'low';

export interface RawTag {
  group: string;
  tag: string;
  value: string;
  category: CategoryId | 'other';
}

export interface Finding {
  id: CategoryId;
  title: string;
  risk: Risk;
  /** One plain sentence: what the photo says. */
  headline: string;
  /** Why it matters. */
  detail: string;
  /** For location: a map link the user can open themselves. */
  mapUrl?: string;
  tags: RawTag[];
}

export interface Inspection {
  findings: Finding[];
  raw: RawTag[];
  hasThumbnail: boolean;
}

const CATEGORY_ORDER: CategoryId[] = ['location', 'device', 'time', 'author', 'camera'];
const TITLES: Record<CategoryId, string> = {
  location: 'Location',
  device: 'Your phone',
  time: 'Date & time',
  author: 'Your name',
  camera: 'Camera settings',
};
const RISK: Record<CategoryId, Risk> = { location: 'high', device: 'medium', time: 'medium', author: 'medium', camera: 'low' };

const LOCATION = /^GPS|latitude|longitude|altitude|^(City|Country|CountryCode|Country-PrimaryLocationName|Province-State|State|Sub-location|Sublocation|Location|LocationCreated|LocationShown)$/i;
const DEVICE = /^(Make|Model|Software|HostComputer|BodySerialNumber|SerialNumber|CameraSerialNumber|InternalSerialNumber|LensMake|LensModel|LensSerialNumber|LensInfo|Lens|UniqueCameraModel|ImageUniqueID|DocumentID|InstanceID|OriginalDocumentID|CreatorTool|DeviceManufacturer|DeviceModel)$/i;
const AUTHOR = /^(Artist|Copyright|Creator|creator|By-line|Byline|Rights|rights|Credit|OwnerName|CameraOwnerName|XPAuthor|Author|Contact|CopyrightNotice|Writer-Editor)$/;
const TIME = /^(DateTime|DateTimeOriginal|DateTimeDigitized|CreateDate|ModifyDate|MetadataDate|DateCreated|TimeCreated|DigitalCreationDate|DigitalCreationTime|SubSecTime|SubSecTimeOriginal|SubSecTimeDigitized|OffsetTime|OffsetTimeOriginal|OffsetTimeDigitized|Creation Time|LastModified)$/i;
const CAMERA_GROUPS = new Set(['EXIF']);

/** Tags that carry nothing personal and are not listed. */
const SKIP = new Set(['latitude', 'longitude', 'Orientation']);

function categorize(group: string, tag: string): CategoryId | 'other' {
  if (LOCATION.test(tag)) return 'location';
  if (AUTHOR.test(tag)) return 'author';
  if (TIME.test(tag)) return 'time';
  if (DEVICE.test(tag)) return 'device';
  if (CAMERA_GROUPS.has(group)) return 'camera';
  return 'other';
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '…' : v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `${v.byteLength} bytes of binary data`;
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (v instanceof Date) return v.toISOString();
  try {
    const s = JSON.stringify(v);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  } catch {
    return String(v);
  }
}

const GROUP_NAMES: Record<string, string> = {
  ifd0: 'Basic', exif: 'EXIF', gps: 'GPS', ifd1: 'Thumbnail', iptc: 'IPTC', xmp: 'XMP', interop: 'EXIF',
};

const EXIFR_OPTIONS: Parameters<typeof exifr.parse>[1] = {
  tiff: true, exif: true, gps: true, ifd1: true, interop: false,
  xmp: true, iptc: true, icc: false, ihdr: false, jfif: false,
  makerNote: false, userComment: true, multiSegment: true,
  mergeOutput: false, reviveValues: false, translateValues: true, translateKeys: true,
};

/** Wrap raw EXIF (TIFF) and XMP bytes in a tiny JPEG so exifr can read them. */
function wrapAsJpeg(tiff: Uint8Array | undefined, xmp: Uint8Array | undefined): Uint8Array {
  const seg = (payload: Uint8Array) => {
    const p = payload.subarray(0, 65533);
    const len = p.length + 2;
    return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), p]);
  };
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (tiff) parts.push(seg(concat([EXIF_HEADER, tiff])));
  if (xmp) parts.push(seg(concat([new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0'), xmp])));
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(parts);
}

const stripExifPrefix = (d: Uint8Array) => (startsWithAscii(d, 0, 'Exif\0\0') ? d.subarray(6) : d);

/** PNG text chunks (tEXt / iTXt / zTXt), which exifr only partly reads. */
function pngTextTags(b: Uint8Array): RawTag[] {
  const tags: RawTag[] = [];
  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  for (const c of parsePng(b).chunks) {
    const data = b.subarray(c.dataOffset, c.dataOffset + c.dataLength);
    const nul = data.indexOf(0);
    if (nul < 1) continue;
    const key = latin1.decode(data.slice(0, nul));
    let value: string;
    if (c.type === 'tEXt') value = latin1.decode(data.slice(nul + 1));
    else if (c.type === 'zTXt') value = '(compressed text)';
    else if (c.type === 'iTXt') {
      if (key === 'XML:com.adobe.xmp') continue; // handled as XMP
      const compressed = data[nul + 1] === 1;
      const langEnd = data.indexOf(0, nul + 3);
      const transEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
      value = compressed || transEnd < 0 ? '(compressed text)' : utf8.decode(data.slice(transEnd + 1));
    } else if (c.type === 'tIME' && c.dataLength === 7) {
      const v = new DataView(data.buffer, data.byteOffset, 7);
      const p = (n: number) => String(n).padStart(2, '0');
      tags.push({ group: 'PNG', tag: 'LastModified', value: `${v.getUint16(0)}:${p(data[2] ?? 0)}:${p(data[3] ?? 0)} ${p(data[4] ?? 0)}:${p(data[5] ?? 0)}:${p(data[6] ?? 0)}`, category: 'time' });
      continue;
    } else continue;
    tags.push({ group: 'PNG text', tag: key, value: formatValue(value), category: categorize('PNG text', key) });
  }
  return tags;
}

async function readRaw(b: Uint8Array): Promise<{ data: Record<string, Record<string, unknown>>; extra: RawTag[]; hasThumbnail: boolean }> {
  const format = detectFormat(b);
  let source = b;
  let extra: RawTag[] = [];
  let tiff: Uint8Array | undefined;

  if (format === 'webp') {
    let xmp: Uint8Array | undefined;
    for (const c of parseWebp(b).chunks) {
      const d = b.subarray(c.dataOffset, c.dataOffset + c.dataLength);
      if (c.type === 'EXIF') tiff = stripExifPrefix(d);
      if (c.type === 'XMP ') xmp = d;
    }
    if (!tiff && !xmp) return { data: {}, extra, hasThumbnail: false };
    source = wrapAsJpeg(tiff, xmp);
  } else if (format === 'png') {
    extra = pngTextTags(b);
    for (const c of parsePng(b).chunks) {
      if (c.type === 'eXIf') tiff = stripExifPrefix(b.subarray(c.dataOffset, c.dataOffset + c.dataLength));
    }
  } else if (format === 'jpeg') {
    // Find the EXIF block ourselves to check for an embedded thumbnail.
    for (let i = 2; i + 10 < b.length && b[i] === 0xff; ) {
      const marker = b[i + 1] ?? 0;
      const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
      if (marker === 0xe1 && asciiAt(b, i + 4, 6) === 'Exif\0\0') {
        tiff = b.subarray(i + 10, i + 2 + len);
        break;
      }
      if (marker === 0xda || marker === 0xd9) break;
      i += 2 + len;
    }
  }

  const parsedTiff = tiff ? parseTiff(tiff) : null;
  const hasThumbnail = (parsedTiff?.ifd1.length ?? 0) > 0;
  let data: Record<string, Record<string, unknown>> = {};
  try {
    data = ((await exifr.parse(source, EXIFR_OPTIONS)) ?? {}) as typeof data;
  } catch {
    // Unknown or damaged metadata: report what our own parsers found.
  }
  return { data, extra, hasThumbnail };
}

// ---- turning tags into plain language ---------------------------------------

function findTag(tags: RawTag[], ...names: string[]): string | undefined {
  for (const n of names) {
    const t = tags.find((x) => x.tag.toLowerCase() === n.toLowerCase() && x.value.trim() !== '');
    if (t) return t.value.trim();
  }
  return undefined;
}

/** "2026:11:14 23:01:00" → "Saturday, 14 November 2026 at 11:01 PM". */
export function formatExifDate(s: string): string {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  if (Number.isNaN(d.getTime())) return s;
  const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

/** XMP writes coordinates as "48,51.493N" or "48,51,29.6N". */
function parseXmpCoord(s: string | undefined): number | undefined {
  const m = s ? /^(\d+),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/i.exec(s.trim()) : null;
  if (!m) return undefined;
  const v = +m[1]! + +m[2]! / 60 + (m[3] ? +m[3] / 3600 : 0);
  return /[SW]/i.test(m[4]!) ? -v : v;
}

const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;

function describe(id: CategoryId, tags: RawTag[], lat?: number, lon?: number, hasLocation = false): Omit<Finding, 'id' | 'title' | 'risk' | 'tags'> {
  switch (id) {
    case 'location': {
      if (lat !== undefined && lon !== undefined) {
        const alt = findTag(tags, 'GPSAltitude');
        return {
          headline: `Taken at ${coord(lat, 'N', 'S')}, ${coord(lon, 'E', 'W')}`,
          detail: 'Accurate to a few metres. Anyone who saves the original can see exactly where you were standing.' +
            (alt ? ` It also records the altitude (${alt} m).` : ''),
          mapUrl: `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`,
        };
      }
      const places = ['Sub-location', 'Sublocation', 'City', 'Province-State', 'State', 'Country', 'Country-PrimaryLocationName']
        .map((n) => findTag(tags, n)).filter((x): x is string => !!x);
      return {
        headline: places.length ? `Place names: ${[...new Set(places)].join(', ')}` : 'Location details are stored in this photo',
        detail: 'This can reveal where the photo was taken.',
      };
    }
    case 'device': {
      const make = findTag(tags, 'Make', 'DeviceManufacturer');
      const model = findTag(tags, 'Model', 'DeviceModel');
      const software = findTag(tags, 'Software', 'CreatorTool');
      const serial = findTag(tags, 'BodySerialNumber', 'SerialNumber', 'CameraSerialNumber', 'InternalSerialNumber', 'LensSerialNumber');
      const lens = findTag(tags, 'LensModel', 'Lens');
      const name = model && make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : (model ?? make);
      const headline = name
        ? `Shot on a ${name}${software ? ` running ${software}` : ''}`
        : software ? `Made or edited with ${software}` : 'Details about your device are stored in this photo';
      const detail = serial
        ? `Also includes serial number ${serial}, which can link all your photos back to the same device.`
        : lens ? `Also records the lens: ${lens}. This helps link photos back to the same phone.`
        : 'This helps link photos back to the same phone.';
      return { headline, detail };
    }
    case 'time': {
      const when = findTag(tags, 'DateTimeOriginal', 'CreateDate', 'DateCreated', 'DateTimeDigitized', 'Creation Time', 'DateTime', 'ModifyDate', 'LastModified');
      return {
        headline: when ? formatExifDate(when) : 'Timestamps are stored in this photo',
        detail: hasLocation
          ? 'Together with the location, this shows where you were, and when. Repeated over a few photos, that’s your routine.'
          : 'It shows exactly when the photo was taken or edited.',
      };
    }
    case 'author': {
      const who = findTag(tags, 'Artist', 'Author', 'XPAuthor', 'Creator', 'creator', 'By-line', 'OwnerName', 'CameraOwnerName');
      const copyright = findTag(tags, 'Copyright', 'Rights', 'rights', 'CopyrightNotice');
      return {
        headline: who ? `Signed “${who}”` : copyright ? `Copyright “${copyright}”` : 'A name is stored in this photo',
        detail: 'Your phone or editing app may have added this automatically.',
      };
    }
    case 'camera': {
      const parts: string[] = [];
      const iso = findTag(tags, 'ISO', 'ISOSpeedRatings', 'PhotographicSensitivity');
      if (iso) parts.push(`ISO ${iso}`);
      const exp = Number(findTag(tags, 'ExposureTime'));
      if (exp > 0) parts.push(exp < 1 ? `1/${Math.round(1 / exp)} s` : `${exp} s`);
      const f = findTag(tags, 'FNumber');
      if (f) parts.push(`f/${f}`);
      const focal = findTag(tags, 'FocalLengthIn35mmFormat', 'FocalLengthIn35mmFilm', 'FocalLength');
      if (focal) parts.push(`${focal} mm lens`);
      return {
        headline: parts.length ? parts.join(' · ') : `${tags.length} technical camera setting${tags.length === 1 ? '' : 's'}`,
        detail: 'Harmless on its own, but it helps tell your phone apart from others.',
      };
    }
  }
}

export async function inspect(bytes: Uint8Array): Promise<Inspection> {
  const { data, extra, hasThumbnail } = await readRaw(bytes);
  const raw: RawTag[] = [];
  let lat: number | undefined;
  let lon: number | undefined;

  for (const [segment, tags] of Object.entries(data)) {
    if (!tags || typeof tags !== 'object') continue;
    const group = GROUP_NAMES[segment] ?? segment.toUpperCase();
    for (const [tag, value] of Object.entries(tags)) {
      if (segment === 'gps' && tag === 'latitude' && typeof value === 'number') lat = value;
      if (segment === 'gps' && tag === 'longitude' && typeof value === 'number') lon = value;
      if (SKIP.has(tag)) continue;
      const v = formatValue(value);
      if (v === '') continue;
      // Thumbnail-directory tags describe the hidden thumbnail, not the photo.
      const category = segment === 'ifd1' ? 'other' : categorize(group, tag);
      raw.push({ group, tag, value: v, category });
    }
  }
  raw.push(...extra);

  if (lat === undefined || lon === undefined) {
    lat = parseXmpCoord(findTag(raw, 'GPSLatitude'));
    lon = parseXmpCoord(findTag(raw, 'GPSLongitude'));
    if (lat === undefined || lon === undefined) lat = lon = undefined;
  }

  const hasLocation = raw.some((t) => t.category === 'location');
  const findings: Finding[] = [];
  for (const id of CATEGORY_ORDER) {
    const tags = raw.filter((t) => t.category === id);
    if (tags.length === 0) continue;
    findings.push({ id, title: TITLES[id], risk: RISK[id], tags, ...describe(id, tags, lat, lon, hasLocation) });
  }
  return { findings, raw, hasThumbnail };
}

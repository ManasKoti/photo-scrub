/**
 * Which privacy category each metadata tag belongs to. Used both to explain
 * a photo (inspect.ts, which sees tag NAMES) and to keep only the categories
 * the user chooses (the EXIF writer, which sees numeric tag IDs).
 */

export type CategoryId = 'location' | 'device' | 'time' | 'author' | 'camera';
export const CATEGORY_IDS: CategoryId[] = ['location', 'device', 'time', 'author', 'camera'];

/** A set of categories the user chose to keep. Empty = remove everything. */
export type KeepSet = ReadonlySet<CategoryId>;

// ---- by tag name (EXIF, XMP, IPTC and PNG text keys) -------------------------

const LOCATION = /^GPS|latitude|longitude|altitude|^(City|Country|CountryCode|Country-PrimaryLocationName|Province-State|State|Sub-location|Sublocation|Location|LocationCreated|LocationShown)$/i;
const DEVICE = /^(Make|Model|Software|HostComputer|BodySerialNumber|SerialNumber|CameraSerialNumber|InternalSerialNumber|LensMake|LensModel|LensSerialNumber|LensInfo|LensSpecification|Lens|UniqueCameraModel|ImageUniqueID|DocumentID|InstanceID|OriginalDocumentID|CreatorTool|DeviceManufacturer|DeviceModel)$/i;
const AUTHOR = /^(Artist|Copyright|Creator|creator|By-line|Byline|Rights|rights|Credit|OwnerName|CameraOwnerName|XPAuthor|Author|Contact|CopyrightNotice|Writer-Editor)$/;
const TIME = /^(DateTime|DateTimeOriginal|DateTimeDigitized|CreateDate|ModifyDate|MetadataDate|DateCreated|TimeCreated|DigitalCreationDate|DigitalCreationTime|SubSecTime|SubSecTimeOriginal|SubSecTimeDigitized|OffsetTime|OffsetTimeOriginal|OffsetTimeDigitized|Creation Time|LastModified)$/i;

/** Categorize a tag by name. `group` 'EXIF' means the camera-settings directory. */
export function categorizeName(group: string, tag: string): CategoryId | 'other' {
  if (LOCATION.test(tag)) return 'location';
  if (AUTHOR.test(tag)) return 'author';
  if (TIME.test(tag)) return 'time';
  if (DEVICE.test(tag)) return 'device';
  if (group === 'EXIF') return 'camera';
  return 'other';
}

// ---- by numeric EXIF tag ID ---------------------------------------------------

export type IfdName = 'ifd0' | 'exif' | 'gps';

const DEVICE_TAGS = new Set([
  0x010f, // Make
  0x0110, // Model
  0x0131, // Software
  0x013c, // HostComputer
  0xa420, // ImageUniqueID
  0xa431, // BodySerialNumber
  0xa432, // LensSpecification
  0xa433, // LensMake
  0xa434, // LensModel
  0xa435, // LensSerialNumber
  0xc614, // UniqueCameraModel
]);
const TIME_TAGS = new Set([
  0x0132, // DateTime
  0x9003, // DateTimeOriginal
  0x9004, // DateTimeDigitized
  0x9010, 0x9011, 0x9012, // OffsetTime, OffsetTimeOriginal, OffsetTimeDigitized
  0x9290, 0x9291, 0x9292, // SubSecTime, SubSecTimeOriginal, SubSecTimeDigitized
]);
const AUTHOR_TAGS = new Set([
  0x013b, // Artist
  0x8298, // Copyright
  0xa430, // CameraOwnerName
  0x9c9d, // XPAuthor
]);
/** Never copied, whatever the user keeps. */
const NEVER = new Set([
  0x8769, 0x8825, 0xa005, // pointers to other directories (we rebuild these)
  0x927c, // MakerNote: undocumented vendor data, can include serials and more
  0x9286, // UserComment
  0x010e, // ImageDescription (free text, often personal)
  0x9c9b, 0x9c9c, 0x9c9e, 0x9c9f, // XPTitle, XPComment, XPKeywords, XPSubject
  0x0201, 0x0202, // thumbnail offset/length
  0x02bc, // XMP inside TIFF
  0x83bb, // IPTC inside TIFF
  0x8773, // ICC inside TIFF
]);

/** Categorize an EXIF tag by its numeric ID and directory. */
export function categorizeTag(ifd: IfdName, tag: number): CategoryId | 'other' | 'never' {
  if (NEVER.has(tag)) return 'never';
  if (ifd === 'gps') return 'location';
  if (DEVICE_TAGS.has(tag)) return 'device';
  if (TIME_TAGS.has(tag)) return 'time';
  if (AUTHOR_TAGS.has(tag)) return 'author';
  if (ifd === 'exif') return 'camera';
  return 'other';
}

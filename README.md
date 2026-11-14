# PhotoScrub

Remove hidden metadata from your photos before you share them online. That includes GPS location, phone model and serial number, the time a photo was taken, embedded thumbnails and motion-photo video.

**Everything runs in your browser. Photos are never uploaded anywhere.**

## Why

Phone cameras save a lot of information inside every photo (EXIF, XMP and more). Post an original photo, and anyone who downloads it can see where you were standing, often down to a few metres. PhotoScrub shows you what's inside a photo and removes it, without touching the image itself.

## How it works

PhotoScrub does **not** re-encode your photo. It reads the file's structure and copies the image data byte for byte, leaving out only the metadata blocks. Quality stays identical. See [`src/core/jpeg.ts`](src/core/jpeg.ts) for the commented JPEG implementation.

## Status

| Format | Status |
|---|---|
| JPEG | ✅ Lossless removal (Phase 1) |
| PNG, WebP | 🔜 Phase 3 |
| HEIC (iPhone) | 🔜 Phase 5 |

See [PLAN.md](PLAN.md) for the full roadmap.

## Run it locally

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm run dev      # open the printed http://localhost:5173 link
npm test         # run the test suite
npm run build    # production build into dist/
```

## Testing with your own photos

Put real photos in a `test-photos/` folder. Git ignores it, so your personal photos (and their metadata) never get committed.

`tests/fixtures/` holds generated photos with **fake** metadata. To regenerate them, run `python scripts/make-fixtures.py` (needs Pillow).

## License

MIT

# PhotoScrub

Remove hidden metadata from your photos before you share them online. That includes GPS location, phone model and serial number, the time a photo was taken, embedded thumbnails and motion-photo video.

**Everything runs in your browser. Photos are never uploaded anywhere.**

## Why

Phone cameras save a lot of information inside every photo (EXIF, XMP and more). Post an original photo, and anyone who downloads it can see where you were standing, often down to a few metres. PhotoScrub shows you what's inside a photo and removes it, without touching the image itself.

## How it works

PhotoScrub does **not** re-encode your photo. It reads the file's structure and copies the image data byte for byte, leaving out only the metadata blocks. Quality stays identical. See the commented code in [`src/core/`](src/core/): `jpeg.ts`, `png.ts` and `webp.ts` do the cleaning, and `inspect.ts` explains what a photo reveals.

The site makes **no requests to other servers**: fonts are bundled, and there are no analytics.

## Status

| Format | Status |
|---|---|
| JPEG | ✅ Lossless removal |
| PNG, WebP | ✅ Lossless removal |
| HEIC (iPhone) | 🔜 Phase 5 |

Before cleaning, PhotoScrub shows **what the photo reveals** in plain language (location, phone, time, name, camera settings), plus the raw tags for the curious. After cleaning, it re-reads the clean copy to double-check that nothing was left behind.

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
